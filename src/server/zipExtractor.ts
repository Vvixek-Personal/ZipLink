import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import type { ShareFileEntry } from '../shared/types.ts';
import {
  classifyTextContent,
  isActiveWebContent,
  validateArchiveEntryPath,
  formatBytes,
} from '../shared/zipSecurity.ts';
import type { TextFileContentInput } from '../shared/contextBuilder.ts';

export class ZipExtractionError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = 'ZipExtractionError';
    this.statusCode = statusCode;
  }
}

export interface ExtractionLimits {
  maxExtractedBytes: number;
  maxEntryCount: number;
  maxTextPreviewBytes: number;
}

export interface ExtractedArchiveResult {
  files: TextFileContentInput[];
  extractedBlobPaths: Map<string, string>;
  totalExtractedBytes: number;
}

function isSymlinkEntry(entry: yauzl.Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (unixMode === 0o120000) {
    return true;
  }
  const hostSystem = (entry.versionMadeBy >>> 8) & 0xff;
  // Windows / DOS / NTFS attributes: FILE_ATTRIBUTE_REPARSE_POINT (0x0400)
  if ((hostSystem === 0 || hostSystem === 10 || hostSystem === 11 || hostSystem === 14) &&
      (entry.externalFileAttributes & 0x0400) !== 0) {
    return true;
  }
  return false;
}

function isEncryptedEntry(entry: yauzl.Entry): boolean {
  return (entry.generalPurposeBitFlag & 0x01) !== 0;
}

export async function safelyExtractZipToTempDir(params: {
  zipFilePath: string;
  extractTempDir: string;
  limits: ExtractionLimits;
}): Promise<ExtractedArchiveResult> {
  const { zipFilePath, extractTempDir, limits } = params;

  const resolvedExtractDir = path.resolve(extractTempDir);
  await fsp.mkdir(resolvedExtractDir, { recursive: true });

  return new Promise<ExtractedArchiveResult>((resolve, reject) => {
    yauzl.open(
      zipFilePath,
      {
        lazyEntries: true,
        autoClose: true,
        validateEntrySizes: true,
      },
      (openErr, zipFile) => {
        if (openErr || !zipFile) {
          reject(
            new ZipExtractionError(
              'The uploaded file is not a valid or readable ZIP archive.',
              400,
            ),
          );
          return;
        }

        let settled = false;
        let entryCount = 0;
        let totalExtractedBytes = 0;
        const seenFilePaths = new Set<string>();
        const files: TextFileContentInput[] = [];
        const extractedBlobPaths = new Map<string, string>();

        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          try {
            zipFile.close();
          } catch {
            // ignore close error
          }
          reject(err);
        };

        zipFile.on('error', (err: Error) => {
          const msg = err?.message || '';
          if (/invalid relative path|absolute path|backslash/i.test(msg)) {
            fail(
              new ZipExtractionError(
                `Unsafe archive entry path rejected (path traversal or absolute path): ${msg}`,
                400,
              ),
            );
            return;
          }
          fail(
            new ZipExtractionError(
              'Malformed or corrupted ZIP archive encountered during extraction.',
              400,
            ),
          );
        });

        zipFile.on('end', () => {
          if (settled) return;
          if (files.length === 0) {
            fail(new ZipExtractionError('The ZIP archive contains no files.', 400));
            return;
          }
          settled = true;
          resolve({
            files,
            extractedBlobPaths,
            totalExtractedBytes,
          });
        });

        zipFile.on('entry', (entry: yauzl.Entry) => {
          if (settled) return;

          entryCount++;
          if (entryCount > limits.maxEntryCount) {
            fail(
              new ZipExtractionError(
                `Archive exceeds the maximum allowed entry count of ${limits.maxEntryCount}.`,
                413,
              ),
            );
            return;
          }

          if (isEncryptedEntry(entry)) {
            fail(
              new ZipExtractionError(
                'Encrypted or password-protected ZIP archives are not supported.',
                400,
              ),
            );
            return;
          }

          if (isSymlinkEntry(entry)) {
            fail(
              new ZipExtractionError(
                `Archive contains a symbolic link ("${entry.fileName}"), which is rejected for security.`,
                400,
              ),
            );
            return;
          }

          const pathCheck = validateArchiveEntryPath(entry.fileName);
          if (!pathCheck.valid || !pathCheck.normalizedPath) {
            fail(
              new ZipExtractionError(
                pathCheck.reason || `Unsafe archive entry path "${entry.fileName}".`,
                400,
              ),
            );
            return;
          }

          if (pathCheck.isDirectory) {
            zipFile.readEntry();
            return;
          }

          const normalizedPath = pathCheck.normalizedPath;
          if (seenFilePaths.has(normalizedPath)) {
            fail(
              new ZipExtractionError(
                `Archive contains duplicate file entry "${normalizedPath}".`,
                400,
              ),
            );
            return;
          }
          seenFilePaths.add(normalizedPath);

          if (totalExtractedBytes + entry.uncompressedSize > limits.maxExtractedBytes) {
            fail(
              new ZipExtractionError(
                `Extracted size would exceed the ${formatBytes(limits.maxExtractedBytes)} limit.`,
                413,
              ),
            );
            return;
          }

          const fileId = crypto.randomUUID();
          const blobPath = path.resolve(resolvedExtractDir, fileId);
          if (!blobPath.startsWith(resolvedExtractDir + path.sep)) {
            fail(new ZipExtractionError('Failed internal path confinement check.', 500));
            return;
          }

          zipFile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr || !readStream) {
              fail(
                new ZipExtractionError(
                  `Failed to decompress archive entry "${normalizedPath}".`,
                  400,
                ),
              );
              return;
            }

            const writeStream = fs.createWriteStream(blobPath, { flags: 'wx' });
            const hash = crypto.createHash('sha256');
            const previewChunks: Buffer[] = [];
            let previewByteCount = 0;
            let previewExceeded = false;
            let entryBytes = 0;
            let aborted = false;

            const abortStreams = (err: Error) => {
              if (aborted) return;
              aborted = true;
              readStream.destroy();
              writeStream.destroy();
              fail(err);
            };

            readStream.on('data', (chunk: Buffer) => {
              if (aborted || settled) return;

              entryBytes += chunk.length;
              totalExtractedBytes += chunk.length;

              if (totalExtractedBytes > limits.maxExtractedBytes) {
                abortStreams(
                  new ZipExtractionError(
                    `Extracted size exceeded the ${formatBytes(limits.maxExtractedBytes)} limit during decompression.`,
                    413,
                  ),
                );
                return;
              }

              // Prevent ZIP bombs whose actual decompressed size exceeds declared central-directory size
              if (entryBytes > entry.uncompressedSize + 4096) {
                abortStreams(
                  new ZipExtractionError(
                    `Entry "${normalizedPath}" exceeded its declared uncompressed size (possible ZIP bomb).`,
                    400,
                  ),
                );
                return;
              }

              hash.update(chunk);

              if (!previewExceeded) {
                if (previewByteCount + chunk.length <= limits.maxTextPreviewBytes) {
                  previewChunks.push(chunk);
                  previewByteCount += chunk.length;
                } else {
                  previewExceeded = true;
                  previewChunks.length = 0;
                }
              }

              if (!writeStream.write(chunk)) {
                readStream.pause();
              }
            });

            writeStream.on('drain', () => {
              if (!aborted && !settled) {
                readStream.resume();
              }
            });

            readStream.on('error', () => {
              abortStreams(
                new ZipExtractionError(
                  `Corrupted compressed stream for "${normalizedPath}".`,
                  400,
                ),
              );
            });

            writeStream.on('error', () => {
              abortStreams(
                new ZipExtractionError('Failed writing extracted file to temporary storage.', 500),
              );
            });

            readStream.on('end', () => {
              if (aborted || settled) return;
              writeStream.end();
            });

            writeStream.on('finish', () => {
              if (aborted || settled) return;

              const sha256 = hash.digest('hex');
              let isText = false;
              let omissionReason: string | null = null;
              let textContent: string | null = null;

              if (previewExceeded) {
                // Still check if it's text by extension/header or mark omitted due to per-file limit
                const cls = classifyTextContent(normalizedPath, new Uint8Array(0));
                isText = cls.isText;
                omissionReason = isText
                  ? `exceeded per-file text limit (${formatBytes(limits.maxTextPreviewBytes)})`
                  : cls.reason;
              } else {
                const combined = Buffer.concat(previewChunks);
                const cls = classifyTextContent(normalizedPath, combined);
                isText = cls.isText;
                omissionReason = cls.reason;
                if (isText) {
                  textContent = combined.toString('utf8');
                }
              }

              const fileEntry: ShareFileEntry = {
                id: fileId,
                relativePath: normalizedPath,
                sizeBytes: entryBytes,
                sha256,
                originalSizeBytes: entryBytes,
                originalSha256: sha256,
                version: 1,
                isEdited: false,
                lastModifiedAt: null,
                isText,
                isActiveContent: isActiveWebContent(normalizedPath),
                includedInContextMd: false,
                omissionReason,
              };

              files.push({ file: fileEntry, textContent });
              extractedBlobPaths.set(fileId, blobPath);

              zipFile.readEntry();
            });
          });
        });

        zipFile.readEntry();
      },
    );
  });
}
