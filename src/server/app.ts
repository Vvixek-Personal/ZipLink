import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { zipSync } from 'fflate';
import { loadConfig, type ZipLinkConfig } from './config.ts';
import { createStorageProvider, isSafeStorageId, type StorageProvider } from './storage.ts';
import { safelyExtractZipToTempDir, ZipExtractionError } from './zipExtractor.ts';
import {
  buildContextMarkdown,
  buildManifestJson,
  type TextFileContentInput,
} from '../shared/contextBuilder.ts';
import {
  classifyTextContent,
  detectSensitiveFilenames,
  isValidExpiryOption,
  resolveExpiryTimestamp,
  sanitizeArchiveFilename,
  sanitizeContentDispositionFilename,
  formatBytes,
  validateArchiveEntryPath,
} from '../shared/zipSecurity.ts';
import { hasPdfMagicHeader, isPdfFilename } from '../shared/pdfUtils.ts';
import type {
  ExpiryOption,
  FileConflictPayload,
  PublicShareMetadata,
  ShareFileEntry,
  ShareRecord,
  UploadSuccessPayload,
} from '../shared/types.ts';

function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return crypto.timingSafeEqual(bufA, bufB);
}

function stripPrivateShareFields(record: ShareRecord): PublicShareMetadata {
  const {
    deleteTokenHash: _omittedDelete,
    editTokenHash: _omittedEdit,
    ...publicMeta
  } = record;
  return publicMeta;
}

function extractEditToken(req: Request): string {
  const authHeader = req.get('authorization');
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }
  const headerToken = req.get('x-edit-token');
  if (headerToken) {
    return headerToken.trim();
  }
  return '';
}

function resolveBaseUrl(req: Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured && configured !== 'MY_APP_URL') {
    return configured.replace(/\/+$/, '');
  }
  const protoHeader = req.get('x-forwarded-proto');
  const proto = protoHeader ? protoHeader.split(',')[0].trim() : req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host') || 'localhost:3000';
  return `${proto}://${host}`;
}

export interface CreateAppOptions {
  config?: Partial<ZipLinkConfig>;
  storage?: StorageProvider;
  disableRateLimit?: boolean;
  now?: () => number;
}

export async function createZipLinkApp(options: CreateAppOptions = {}): Promise<{
  app: Express;
  config: ZipLinkConfig;
  storage: StorageProvider;
}> {
  const config = loadConfig(options.config);
  const storage = options.storage ?? createStorageProvider(config);
  await storage.init();

  const nowFn = options.now ?? (() => Date.now());
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Per-share lock queue to serialize writes and prevent optimistic-concurrency races
  const shareLocks = new Map<string, Promise<void>>();
  async function withShareLock<T>(shareId: string, task: () => Promise<T>): Promise<T> {
    const previous = shareLocks.get(shareId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current, () => current);
    shareLocks.set(shareId, tail);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (shareLocks.get(shareId) === tail) {
        shareLocks.delete(shareId);
      }
    }
  }

  // Global security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Noindex & no-store headers on unlisted share and API routes
  app.use(['/api/shares', '/s', '/delete'], (_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Serve bundled browser OCR runtime & English language data strictly from local node_modules
  // so optional OCR never contacts external CDNs or third-party services.
  const tesseractWorkerPath = path.resolve(
    process.cwd(),
    'node_modules/tesseract.js/dist/worker.min.js',
  );
  const tesseractCoreDir = path.resolve(process.cwd(), 'node_modules/tesseract.js-core');
  const tesseractEngDataPath = path.resolve(
    process.cwd(),
    'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
  );

  app.get('/ocr-assets/worker.min.js', (_req, res) => {
    if (!fs.existsSync(tesseractWorkerPath)) {
      res.status(404).type('text/plain').send('OCR worker not available.');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('application/javascript; charset=utf-8').sendFile(tesseractWorkerPath);
  });

  app.use(
    '/ocr-assets/core',
    express.static(tesseractCoreDir, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        }
      },
    }),
  );

  app.get('/ocr-assets/tessdata/eng.traineddata.gz', (_req, res) => {
    if (!fs.existsSync(tesseractEngDataPath)) {
      res.status(404).type('text/plain').send('English OCR traineddata not available.');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Type', 'application/gzip');
    res.sendFile(tesseractEngDataPath);
  });

  // Size JSON body limit to comfortably accept text edits up to maxTextPreviewBytes
  const jsonBodyLimitBytes = Math.max(1024 * 1024, Math.ceil(config.maxTextPreviewBytes * 1.5));
  app.use(express.json({ limit: jsonBodyLimitBytes }));

  const uploadTempRoot = path.join(os.tmpdir(), 'ziplink-uploads');
  await fsp.mkdir(uploadTempRoot, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        cb(null, uploadTempRoot);
      },
      filename: (_req, _file, cb) => {
        cb(null, `${crypto.randomUUID()}.zip`);
      },
    }),
    limits: {
      fileSize: config.maxCompressedBytes,
      files: 1,
      fields: 5,
    },
  });

  const uploadLimiter = options.disableRateLimit
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : rateLimit({
        windowMs: config.uploadRateLimitWindowMs,
        max: config.uploadRateLimitMax,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: 'Upload rate limit reached. Please wait a few minutes before uploading again.',
        },
      });

  const readDeleteLimiter = options.disableRateLimit
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : rateLimit({
        windowMs: 60 * 1000,
        max: 240,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: 'Too many requests. Please slow down and try again shortly.',
        },
      });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      storageDriver: storage.driverName,
    });
  });

  app.get('/api/limits', (_req, res) => {
    res.json({
      maxCompressedBytes: config.maxCompressedBytes,
      maxExtractedBytes: config.maxExtractedBytes,
      maxEntryCount: config.maxEntryCount,
      maxContextMdBytes: config.maxContextMdBytes,
      maxTextPreviewBytes: config.maxTextPreviewBytes,
      storageDriver: storage.driverName,
    });
  });

  async function resolveActiveShareOrRespond(
    shareId: string,
    res: Response,
  ): Promise<ShareRecord | null> {
    if (!isSafeStorageId(shareId)) {
      res.status(404).json({ error: 'Share link not found.' });
      return null;
    }

    const record = await storage.getShare(shareId);
    if (!record) {
      res.status(404).json({ error: 'This share link does not exist or has been deleted.' });
      return null;
    }

    if (record.expiresAtMs <= nowFn()) {
      await storage.deleteShare(shareId).catch(() => undefined);
      res.status(410).json({ error: 'This share link has expired and its files were deleted.' });
      return null;
    }

    return record;
  }

  function verifyEditAuthorizationOrRespond(
    req: Request,
    res: Response,
    record: ShareRecord,
  ): boolean {
    const rawToken = extractEditToken(req);
    if (!rawToken || rawToken.length < 16) {
      res.status(401).json({
        error: 'An owner edit token is required to modify files in this share.',
      });
      return false;
    }
    if (!record.editTokenHash) {
      res.status(403).json({
        error: 'This share does not support owner editing.',
      });
      return false;
    }
    const candidateHash = sha256Hex(rawToken);
    if (!timingSafeHexEqual(candidateHash, record.editTokenHash)) {
      res.status(403).json({
        error: 'Invalid owner edit token. Public share links are read-only.',
      });
      return false;
    }
    return true;
  }

  async function rebuildGeneratedOutputsForShare(
    share: ShareRecord,
    updatedFiles: ShareFileEntry[],
    overrideContent?: { fileId: string; content: string },
  ): Promise<{
    updatedShare: ShareRecord;
    contextMd: string;
    manifestJson: string;
  }> {
    const entries: TextFileContentInput[] = await Promise.all(
      updatedFiles.map(async (file) => {
        if (!file.isText || file.sizeBytes > config.maxTextPreviewBytes) {
          return { file, textContent: null };
        }
        if (overrideContent && overrideContent.fileId === file.id) {
          return { file, textContent: overrideContent.content };
        }
        const content = await storage.getTextFileContent(
          share.shareId,
          file.id,
          config.maxTextPreviewBytes,
        );
        return { file, textContent: content };
      }),
    );

    const totalExtractedBytes = updatedFiles.reduce((sum, f) => sum + f.sizeBytes, 0);

    const contextResult = buildContextMarkdown({
      shareId: share.shareId,
      archiveName: share.archiveName,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      entries,
      maxContextBytes: config.maxContextMdBytes,
    });

    const manifestJson = buildManifestJson({
      shareId: share.shareId,
      archiveName: share.archiveName,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      totalExtractedBytes,
      sensitiveWarnings: share.sensitiveWarnings,
      files: contextResult.updatedFiles,
    });

    const updatedShare: ShareRecord = {
      ...share,
      totalFiles: contextResult.updatedFiles.length,
      totalExtractedBytes,
      contextIncludedCount: contextResult.includedCount,
      contextOmittedCount: contextResult.omittedCount,
      files: contextResult.updatedFiles,
    };

    return {
      updatedShare,
      contextMd: contextResult.contextMd,
      manifestJson,
    };
  }

  // Upload & extract ZIP endpoint
  app.post(
    '/api/shares',
    uploadLimiter,
    (req, res, next) => {
      upload.single('archive')(req, res, (err: unknown) => {
        if (!err) {
          next();
          return;
        }
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({
              error: `Uploaded ZIP exceeds the ${formatBytes(config.maxCompressedBytes)} compressed size limit.`,
            });
            return;
          }
          res.status(400).json({ error: `Upload error: ${err.message}` });
          return;
        }
        next(err);
      });
    },
    async (req, res, next) => {
      const uploadedFile = req.file;
      if (!uploadedFile) {
        res.status(400).json({ error: 'Please select a .zip archive or .pdf document to upload.' });
        return;
      }

      const rawExpiry = req.body?.expiry;
      const expiryOption: ExpiryOption = isValidExpiryOption(rawExpiry) ? rawExpiry : '7d';

      const extractTempDir = path.join(os.tmpdir(), `ziplink-extract-${crypto.randomUUID()}`);

      try {
        const archiveName = sanitizeArchiveFilename(uploadedFile.originalname || 'archive.zip');
        let extractedFiles: TextFileContentInput[];
        let extractedBlobPaths: Map<string, string>;
        let totalExtractedBytes: number;

        const looksLikePdfByName = isPdfFilename(uploadedFile.originalname || '');
        const headHandle = await fsp.open(uploadedFile.path, 'r');
        const headBuf = Buffer.alloc(1024);
        const { bytesRead } = await headHandle.read(headBuf, 0, 1024, 0);
        await headHandle.close();
        const headerSlice = headBuf.subarray(0, bytesRead);
        const hasPdfHeader = hasPdfMagicHeader(headerSlice);

        if (looksLikePdfByName || hasPdfHeader) {
          if (!hasPdfHeader) {
            res.status(400).json({
              error: 'The uploaded .pdf file is missing a valid %PDF- header and was rejected.',
            });
            return;
          }
          if (uploadedFile.size === 0) {
            res.status(400).json({ error: 'The uploaded PDF file is empty.' });
            return;
          }
          if (uploadedFile.size > config.maxExtractedBytes) {
            res.status(413).json({
              error: `PDF exceeds the ${formatBytes(config.maxExtractedBytes)} storage limit.`,
            });
            return;
          }

          const pdfNameCandidate = isPdfFilename(archiveName) ? archiveName : `${archiveName}.pdf`;
          const pathCheck = validateArchiveEntryPath(pdfNameCandidate);
          const safeEntryName =
            pathCheck.valid && pathCheck.normalizedPath ? pathCheck.normalizedPath : 'document.pdf';

          const sha256 = await new Promise<string>((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const rs = fs.createReadStream(uploadedFile.path);
            rs.on('data', (chunk) => hash.update(chunk));
            rs.on('error', reject);
            rs.on('end', () => resolve(hash.digest('hex')));
          });

          const fileId = crypto.randomUUID();
          const pdfEntry: ShareFileEntry = {
            id: fileId,
            relativePath: safeEntryName,
            sizeBytes: uploadedFile.size,
            sha256,
            originalSizeBytes: uploadedFile.size,
            originalSha256: sha256,
            version: 1,
            isEdited: false,
            lastModifiedAt: null,
            isText: false,
            isActiveContent: false,
            includedInContextMd: false,
            omissionReason: 'PDF document (open in ZipLink PDF Reader)',
          };

          extractedFiles = [{ file: pdfEntry, textContent: null }];
          extractedBlobPaths = new Map([[fileId, uploadedFile.path]]);
          totalExtractedBytes = uploadedFile.size;
        } else {
          const extracted = await safelyExtractZipToTempDir({
            zipFilePath: uploadedFile.path,
            extractTempDir,
            limits: {
              maxExtractedBytes: config.maxExtractedBytes,
              maxEntryCount: config.maxEntryCount,
              maxTextPreviewBytes: config.maxTextPreviewBytes,
            },
          });
          extractedFiles = extracted.files;
          extractedBlobPaths = extracted.extractedBlobPaths;
          totalExtractedBytes = extracted.totalExtractedBytes;
        }

        const shareId = crypto.randomBytes(24).toString('base64url');
        const deleteToken = crypto.randomBytes(32).toString('base64url');
        const deleteTokenHash = sha256Hex(deleteToken);
        const editToken = crypto.randomBytes(32).toString('base64url');
        const editTokenHash = sha256Hex(editToken);

        const createdMs = nowFn();
        const createdAt = new Date(createdMs).toISOString();
        const { expiresAtMs, expiresAt } = resolveExpiryTimestamp(expiryOption, createdMs);

        const sensitiveWarnings = detectSensitiveFilenames(
          extractedFiles.map((item) => item.file.relativePath),
        );

        const contextResult = buildContextMarkdown({
          shareId,
          archiveName,
          createdAt,
          expiresAt,
          entries: extractedFiles,
          maxContextBytes: config.maxContextMdBytes,
        });

        const manifestJson = buildManifestJson({
          shareId,
          archiveName,
          createdAt,
          expiresAt,
          totalExtractedBytes,
          sensitiveWarnings,
          files: contextResult.updatedFiles,
        });

        const shareRecord: ShareRecord = {
          shareId,
          archiveName,
          createdAt,
          expiresAt,
          expiresAtMs,
          expiryOption,
          totalFiles: contextResult.updatedFiles.length,
          totalExtractedBytes,
          contextIncludedCount: contextResult.includedCount,
          contextOmittedCount: contextResult.omittedCount,
          sensitiveWarnings,
          files: contextResult.updatedFiles,
          deleteTokenHash,
          editTokenHash,
        };

        await storage.saveShare({
          share: shareRecord,
          blobTempPaths: extractedBlobPaths,
          contextMd: contextResult.contextMd,
          manifestJson,
        });

        const baseUrl = resolveBaseUrl(req);
        const payload: UploadSuccessPayload = {
          shareId,
          shareUrl: `${baseUrl}/s/${shareId}`,
          editUrl: `${baseUrl}/s/${shareId}#edit=${encodeURIComponent(editToken)}`,
          editToken,
          contextUrl: `${baseUrl}/s/${shareId}/context.md`,
          manifestUrl: `${baseUrl}/s/${shareId}/manifest.json`,
          deleteUrl: `${baseUrl}/delete/${shareId}?token=${encodeURIComponent(deleteToken)}`,
          deleteToken,
          expiresAt,
          expiryOption,
          archiveName,
          totalFiles: shareRecord.totalFiles,
          totalExtractedBytes: shareRecord.totalExtractedBytes,
          contextIncludedCount: shareRecord.contextIncludedCount,
          contextOmittedCount: shareRecord.contextOmittedCount,
          sensitiveWarnings,
          contextMd: contextResult.contextMd,
        };

        res.status(201).json(payload);
      } catch (err) {
        if (err instanceof ZipExtractionError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        next(err);
      } finally {
        await fsp.unlink(uploadedFile.path).catch(() => undefined);
        await fsp.rm(extractTempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  );

  // Share metadata endpoint
  app.get('/api/shares/:shareId', readDeleteLimiter, async (req, res) => {
    const share = await resolveActiveShareOrRespond(req.params.shareId, res);
    if (!share) return;
    res.json(stripPrivateShareFields(share));
  });

  // Verify owner edit token endpoint
  app.post('/api/shares/:shareId/edit-auth', readDeleteLimiter, async (req, res) => {
    const share = await resolveActiveShareOrRespond(req.params.shareId, res);
    if (!share) return;
    if (!verifyEditAuthorizationOrRespond(req, res, share)) return;
    res.json({ canEdit: true, shareId: share.shareId });
  });

  // Safe escaped-text preview endpoint (returns JSON string, never raw HTML)
  app.get('/api/shares/:shareId/files/:fileId/preview', readDeleteLimiter, async (req, res) => {
    const share = await resolveActiveShareOrRespond(req.params.shareId, res);
    if (!share) return;

    const fileEntry = share.files.find((f) => f.id === req.params.fileId);
    if (!fileEntry) {
      res.status(404).json({ error: 'File not found in this share.' });
      return;
    }

    if (!fileEntry.isText) {
      res.status(415).json({ error: 'Binary files cannot be previewed as text. Download the file instead.' });
      return;
    }

    if (fileEntry.sizeBytes > config.maxTextPreviewBytes) {
      res.status(413).json({
        error: `File exceeds the ${formatBytes(config.maxTextPreviewBytes)} inline preview limit. Download the file instead.`,
      });
      return;
    }

    const content = await storage.getTextFileContent(
      share.shareId,
      fileEntry.id,
      config.maxTextPreviewBytes,
    );
    if (content === null) {
      res.status(404).json({ error: 'Stored file contents were not found.' });
      return;
    }

    res.json({
      id: fileEntry.id,
      relativePath: fileEntry.relativePath,
      sizeBytes: fileEntry.sizeBytes,
      sha256: fileEntry.sha256,
      originalSha256: fileEntry.originalSha256,
      version: fileEntry.version,
      isEdited: fileEntry.isEdited,
      lastModifiedAt: fileEntry.lastModifiedAt,
      isActiveContent: fileEntry.isActiveContent,
      content,
    });
  });

  // Original uploaded text content endpoint (for Diff vs Original and Restore confirmation)
  app.get('/api/shares/:shareId/files/:fileId/original', readDeleteLimiter, async (req, res) => {
    const share = await resolveActiveShareOrRespond(req.params.shareId, res);
    if (!share) return;

    const fileEntry = share.files.find((f) => f.id === req.params.fileId);
    if (!fileEntry) {
      res.status(404).json({ error: 'File not found in this share.' });
      return;
    }

    if (!fileEntry.isText) {
      res.status(415).json({ error: 'Original text diff is only available for text files.' });
      return;
    }

    if (fileEntry.originalSizeBytes > config.maxTextPreviewBytes) {
      res.status(413).json({
        error: `Original file exceeds the ${formatBytes(config.maxTextPreviewBytes)} inline preview limit.`,
      });
      return;
    }

    const content = await storage.getOriginalTextFileContent(
      share.shareId,
      fileEntry.id,
      config.maxTextPreviewBytes,
    );
    if (content === null) {
      res.status(404).json({ error: 'Original file contents were not found.' });
      return;
    }

    res.json({
      id: fileEntry.id,
      relativePath: fileEntry.relativePath,
      sizeBytes: fileEntry.originalSizeBytes,
      sha256: fileEntry.originalSha256,
      content,
    });
  });

  // Save edited text file (requires owner edit token + optimistic concurrency check)
  app.put('/api/shares/:shareId/files/:fileId', readDeleteLimiter, async (req, res) => {
    const { shareId, fileId } = req.params;
    if (!isSafeStorageId(shareId) || !isSafeStorageId(fileId)) {
      res.status(404).json({ error: 'Share or file not found.' });
      return;
    }

    const body = req.body as {
      content?: unknown;
      expectedSha256?: unknown;
      expectedVersion?: unknown;
    } | null;

    if (!body || typeof body.content !== 'string') {
      res.status(400).json({ error: 'Request body must include string field "content".' });
      return;
    }

    const nextContent = body.content;

    await withShareLock(shareId, async () => {
      const share = await resolveActiveShareOrRespond(shareId, res);
      if (!share) return;

      if (!verifyEditAuthorizationOrRespond(req, res, share)) return;

      const fileIndex = share.files.findIndex((f) => f.id === fileId);
      if (fileIndex === -1) {
        res.status(404).json({ error: 'File not found in this share.' });
        return;
      }

      const currentFile = share.files[fileIndex];
      if (!currentFile.isText) {
        res.status(415).json({ error: 'Binary or non-text files are read-only and cannot be edited.' });
        return;
      }

      if (currentFile.sizeBytes > config.maxTextPreviewBytes) {
        res.status(413).json({
          error: `Files larger than ${formatBytes(config.maxTextPreviewBytes)} are read-only.`,
        });
        return;
      }

      const nextBuffer = Buffer.from(nextContent, 'utf8');
      if (nextBuffer.length > config.maxTextPreviewBytes) {
        res.status(413).json({
          error: `Edited content (${formatBytes(nextBuffer.length)}) exceeds the ${formatBytes(config.maxTextPreviewBytes)} per-file text limit.`,
        });
        return;
      }

      const nextTotalBytes = share.totalExtractedBytes - currentFile.sizeBytes + nextBuffer.length;
      if (nextTotalBytes > config.maxExtractedBytes) {
        res.status(413).json({
          error: `Saving would exceed the ${formatBytes(config.maxExtractedBytes)} archive size limit.`,
        });
        return;
      }

      const textCheck = classifyTextContent(currentFile.relativePath, nextBuffer);
      if (!textCheck.isText) {
        res.status(400).json({
          error: `Edited content is not valid UTF-8 text (${textCheck.reason || 'invalid characters'}).`,
        });
        return;
      }

      // Optimistic concurrency check against current saved sha256 and/or version
      const expectedSha256 = typeof body.expectedSha256 === 'string' ? body.expectedSha256 : null;
      const expectedVersion =
        typeof body.expectedVersion === 'number' && Number.isFinite(body.expectedVersion)
          ? body.expectedVersion
          : null;

      if (
        (expectedSha256 !== null && expectedSha256 !== currentFile.sha256) ||
        (expectedVersion !== null && expectedVersion !== currentFile.version)
      ) {
        const latestContent = await storage.getTextFileContent(
          share.shareId,
          currentFile.id,
          config.maxTextPreviewBytes,
        );
        const conflictPayload: FileConflictPayload = {
          error:
            'This file was modified elsewhere since you opened it. Review the latest saved version before overwriting.',
          conflict: true,
          currentSha256: currentFile.sha256,
          currentVersion: currentFile.version,
          currentContent: latestContent,
          currentFile,
        };
        res.status(409).json(conflictPayload);
        return;
      }

      const nextSha256 = sha256Hex(nextBuffer);
      const modifiedIso = new Date(nowFn()).toISOString();
      const updatedEntry: ShareFileEntry = {
        ...currentFile,
        sizeBytes: nextBuffer.length,
        sha256: nextSha256,
        version: currentFile.version + 1,
        isEdited: nextSha256 !== currentFile.originalSha256,
        lastModifiedAt: modifiedIso,
      };

      const nextFiles = share.files.map((f, idx) => (idx === fileIndex ? updatedEntry : f));
      const { updatedShare, contextMd, manifestJson } = await rebuildGeneratedOutputsForShare(
        share,
        nextFiles,
        { fileId: currentFile.id, content: nextContent },
      );

      await storage.updateTextFile({
        shareId: share.shareId,
        fileId: currentFile.id,
        content: nextContent,
        preserveOriginal: true,
        updatedShare,
        updatedContextMd: contextMd,
        updatedManifestJson: manifestJson,
      });

      const savedEntry = updatedShare.files.find((f) => f.id === currentFile.id) ?? updatedEntry;
      res.json({
        file: savedEntry,
        share: stripPrivateShareFields(updatedShare),
        content: nextContent,
      });
    });
  });

  // Restore original uploaded file (requires owner edit token + optimistic concurrency check)
  app.post('/api/shares/:shareId/files/:fileId/restore', readDeleteLimiter, async (req, res) => {
    const { shareId, fileId } = req.params;
    if (!isSafeStorageId(shareId) || !isSafeStorageId(fileId)) {
      res.status(404).json({ error: 'Share or file not found.' });
      return;
    }

    const body = (req.body ?? {}) as {
      expectedSha256?: unknown;
      expectedVersion?: unknown;
    };

    await withShareLock(shareId, async () => {
      const share = await resolveActiveShareOrRespond(shareId, res);
      if (!share) return;

      if (!verifyEditAuthorizationOrRespond(req, res, share)) return;

      const fileIndex = share.files.findIndex((f) => f.id === fileId);
      if (fileIndex === -1) {
        res.status(404).json({ error: 'File not found in this share.' });
        return;
      }

      const currentFile = share.files[fileIndex];
      if (!currentFile.isText) {
        res.status(415).json({ error: 'Binary or non-text files cannot be restored via text editor.' });
        return;
      }

      const expectedSha256 = typeof body.expectedSha256 === 'string' ? body.expectedSha256 : null;
      const expectedVersion =
        typeof body.expectedVersion === 'number' && Number.isFinite(body.expectedVersion)
          ? body.expectedVersion
          : null;

      if (
        (expectedSha256 !== null && expectedSha256 !== currentFile.sha256) ||
        (expectedVersion !== null && expectedVersion !== currentFile.version)
      ) {
        const latestContent = await storage.getTextFileContent(
          share.shareId,
          currentFile.id,
          config.maxTextPreviewBytes,
        );
        const conflictPayload: FileConflictPayload = {
          error:
            'This file changed on the server since you opened it. Reload the latest version before restoring.',
          conflict: true,
          currentSha256: currentFile.sha256,
          currentVersion: currentFile.version,
          currentContent: latestContent,
          currentFile,
        };
        res.status(409).json(conflictPayload);
        return;
      }

      const originalContent = await storage.getOriginalTextFileContent(
        share.shareId,
        currentFile.id,
        config.maxTextPreviewBytes,
      );
      if (originalContent === null) {
        res.status(404).json({ error: 'Original uploaded file version was not found.' });
        return;
      }

      const origBuffer = Buffer.from(originalContent, 'utf8');
      const restoredEntry: ShareFileEntry = {
        ...currentFile,
        sizeBytes: origBuffer.length,
        sha256: currentFile.originalSha256,
        version: currentFile.version + 1,
        isEdited: false,
        lastModifiedAt: new Date(nowFn()).toISOString(),
      };

      const nextFiles = share.files.map((f, idx) => (idx === fileIndex ? restoredEntry : f));
      const { updatedShare, contextMd, manifestJson } = await rebuildGeneratedOutputsForShare(
        share,
        nextFiles,
        { fileId: currentFile.id, content: originalContent },
      );

      const restored = await storage.restoreOriginalFile({
        shareId: share.shareId,
        fileId: currentFile.id,
        updatedShare,
        updatedContextMd: contextMd,
        updatedManifestJson: manifestJson,
      });

      if (restored === null) {
        res.status(404).json({ error: 'Original uploaded file version could not be restored.' });
        return;
      }

      const savedEntry = updatedShare.files.find((f) => f.id === currentFile.id) ?? restoredEntry;
      res.json({
        file: savedEntry,
        share: stripPrivateShareFields(updatedShare),
        content: restored,
      });
    });
  });

  // Download full archive (including all saved edits) as a ZIP
  const serveEditedZipDownload = async (req: Request, res: Response) => {
    const share = await resolveActiveShareOrRespond(req.params.shareId, res);
    if (!share) return;

    const zipEntries: Record<string, Uint8Array> = {};
    for (const file of share.files) {
      const bytes = await storage.getFileBytes(share.shareId, file.id);
      if (bytes !== null) {
        zipEntries[file.relativePath] = bytes;
      }
    }

    const zipped = zipSync(zipEntries, { level: 6 });
    const hasEdits = share.files.some((f) => f.isEdited);
    const baseZipName = share.archiveName.toLowerCase().endsWith('.zip')
      ? share.archiveName
      : `${share.archiveName.replace(/\.pdf$/i, '')}.zip`;
    const rawZipName = hasEdits
      ? baseZipName.replace(/\.zip$/i, '') + '-edited.zip'
      : baseZipName;
    const { asciiFallback, utf8Encoded } = sanitizeContentDispositionFilename(rawZipName);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`,
    );
    res.setHeader('Content-Length', String(zipped.length));
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(zipped.buffer, zipped.byteOffset, zipped.byteLength));
  };

  app.get('/s/:shareId/download.zip', readDeleteLimiter, serveEditedZipDownload);
  app.get('/api/shares/:shareId/download.zip', readDeleteLimiter, serveEditedZipDownload);

  // Serve raw individual file download with strict safe headers
  const serveFileDownload = async (req: Request, res: Response) => {
    const share = await resolveActiveShareOrRespond(req.params.shareId, res);
    if (!share) return;

    const fileEntry = share.files.find((f) => f.id === req.params.fileId);
    if (!fileEntry) {
      res.status(404).type('text/plain').send('File not found.');
      return;
    }

    const fileStreamData = await storage.getFileStream(share.shareId, fileEntry.id);
    if (!fileStreamData) {
      res.status(404).type('text/plain').send('File blob missing.');
      return;
    }

    const { asciiFallback, utf8Encoded } = sanitizeContentDispositionFilename(
      fileEntry.relativePath,
    );

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`,
    );
    res.setHeader('Content-Length', String(fileStreamData.sizeBytes));
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');

    fileStreamData.stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });
    fileStreamData.stream.pipe(res);
  };

  app.get('/s/:shareId/files/:fileId', readDeleteLimiter, serveFileDownload);
  app.get('/api/shares/:shareId/files/:fileId', readDeleteLimiter, serveFileDownload);

  // Serve direct context.md
  const serveContextMd = async (req: Request, res: Response) => {
    const share = await resolveActiveShareOrRespond(req.params.shareId, res);
    if (!share) return;

    const contextMd = await storage.getContextMd(share.shareId);
    if (contextMd === null) {
      res.status(404).type('text/plain').send('context.md not found.');
      return;
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', 'attachment; filename="context.md"');
    }
    res.send(contextMd);
  };

  app.get('/s/:shareId/context.md', readDeleteLimiter, serveContextMd);
  app.get('/api/shares/:shareId/context.md', readDeleteLimiter, serveContextMd);

  // Serve direct manifest.json
  const serveManifestJson = async (req: Request, res: Response) => {
    const share = await resolveActiveShareOrRespond(req.params.shareId, res);
    if (!share) return;

    const manifest = await storage.getManifestJson(share.shareId);
    if (manifest === null) {
      res.status(404).json({ error: 'manifest.json not found.' });
      return;
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', 'attachment; filename="manifest.json"');
    }
    res.send(manifest);
  };

  app.get('/s/:shareId/manifest.json', readDeleteLimiter, serveManifestJson);
  app.get('/api/shares/:shareId/manifest.json', readDeleteLimiter, serveManifestJson);

  // Immediate delete with one-time token verification
  const handleDeleteShare = async (req: Request, res: Response) => {
    const { shareId } = req.params;
    if (!isSafeStorageId(shareId)) {
      res.status(404).json({ error: 'Share link not found.' });
      return;
    }

    const rawToken =
      req.get('x-delete-token') ||
      (typeof req.body?.token === 'string' ? req.body.token : '') ||
      (typeof req.query.token === 'string' ? req.query.token : '');

    if (!rawToken || rawToken.length < 16) {
      res.status(401).json({ error: 'A valid delete token is required to delete this share.' });
      return;
    }

    const record = await storage.getShare(shareId);
    if (!record) {
      res.status(404).json({ error: 'Share link not found or already deleted.' });
      return;
    }

    const candidateHash = sha256Hex(rawToken);
    if (!timingSafeHexEqual(candidateHash, record.deleteTokenHash)) {
      res.status(403).json({ error: 'Invalid delete token.' });
      return;
    }

    await storage.deleteShare(shareId);
    res.json({ deleted: true, shareId });
  };

  app.delete('/api/shares/:shareId', readDeleteLimiter, handleDeleteShare);
  app.post('/api/shares/:shareId/delete', readDeleteLimiter, handleDeleteShare);

  // Generic safe API error handler (never log file contents or leak internals)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[ZipLink] Request error:', message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'An unexpected server error occurred.' });
    }
  });

  return { app, config, storage };
}
