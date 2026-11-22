import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { loadConfig, type ZipLinkConfig } from './config.ts';
import { createStorageProvider, isSafeStorageId, type StorageProvider } from './storage.ts';
import { safelyExtractZipToTempDir, ZipExtractionError } from './zipExtractor.ts';
import { buildContextMarkdown, buildManifestJson } from '../shared/contextBuilder.ts';
import {
  detectSensitiveFilenames,
  isValidExpiryOption,
  resolveExpiryTimestamp,
  sanitizeArchiveFilename,
  sanitizeContentDispositionFilename,
  formatBytes,
} from '../shared/zipSecurity.ts';
import type {
  ExpiryOption,
  PublicShareMetadata,
  ShareRecord,
  UploadSuccessPayload,
} from '../shared/types.ts';

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return crypto.timingSafeEqual(bufA, bufB);
}

function stripPrivateShareFields(record: ShareRecord): PublicShareMetadata {
  const { deleteTokenHash: _omitted, ...publicMeta } = record;
  return publicMeta;
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

  app.use(express.json({ limit: '64kb' }));

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
        res.status(400).json({ error: 'Please select a .zip archive file to upload.' });
        return;
      }

      const rawExpiry = req.body?.expiry;
      const expiryOption: ExpiryOption = isValidExpiryOption(rawExpiry) ? rawExpiry : '7d';

      const extractTempDir = path.join(os.tmpdir(), `ziplink-extract-${crypto.randomUUID()}`);

      try {
        const extracted = await safelyExtractZipToTempDir({
          zipFilePath: uploadedFile.path,
          extractTempDir,
          limits: {
            maxExtractedBytes: config.maxExtractedBytes,
            maxEntryCount: config.maxEntryCount,
            maxTextPreviewBytes: config.maxTextPreviewBytes,
          },
        });

        const shareId = crypto.randomBytes(24).toString('base64url');
        const deleteToken = crypto.randomBytes(32).toString('base64url');
        const deleteTokenHash = sha256Hex(deleteToken);

        const createdMs = nowFn();
        const createdAt = new Date(createdMs).toISOString();
        const { expiresAtMs, expiresAt } = resolveExpiryTimestamp(expiryOption, createdMs);
        const archiveName = sanitizeArchiveFilename(uploadedFile.originalname || 'archive.zip');

        const sensitiveWarnings = detectSensitiveFilenames(
          extracted.files.map((item) => item.file.relativePath),
        );

        const contextResult = buildContextMarkdown({
          shareId,
          archiveName,
          createdAt,
          expiresAt,
          entries: extracted.files,
          maxContextBytes: config.maxContextMdBytes,
        });

        const manifestJson = buildManifestJson({
          shareId,
          archiveName,
          createdAt,
          expiresAt,
          totalExtractedBytes: extracted.totalExtractedBytes,
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
          totalExtractedBytes: extracted.totalExtractedBytes,
          contextIncludedCount: contextResult.includedCount,
          contextOmittedCount: contextResult.omittedCount,
          sensitiveWarnings,
          files: contextResult.updatedFiles,
          deleteTokenHash,
        };

        await storage.saveShare({
          share: shareRecord,
          blobTempPaths: extracted.extractedBlobPaths,
          contextMd: contextResult.contextMd,
          manifestJson,
        });

        const baseUrl = resolveBaseUrl(req);
        const payload: UploadSuccessPayload = {
          shareId,
          shareUrl: `${baseUrl}/s/${shareId}`,
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
      isActiveContent: fileEntry.isActiveContent,
      content,
    });
  });

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
