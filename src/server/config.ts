import os from 'node:os';
import path from 'node:path';
import type { AppLimitsInfo } from '../shared/types.ts';

export interface ZipLinkConfig extends AppLimitsInfo {
  port: number;
  dataDir: string;
  previewDir: string;
  previewOrigin: string;
  cleanupIntervalMs: number;
  uploadRateLimitMax: number;
  uploadRateLimitWindowMs: number;
  gcsBucket: string;
  gcpProjectId: string;
  firestoreCollection: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(overrides: Partial<ZipLinkConfig> = {}): ZipLinkConfig {
  const gcsBucket = overrides.gcsBucket ?? (process.env.GCS_BUCKET || '').trim();
  const requestedDriver = process.env.STORAGE_DRIVER?.trim().toLowerCase();
  const storageDriver: 'local' | 'gcs' =
    overrides.storageDriver ?? (requestedDriver === 'gcs' && gcsBucket ? 'gcs' : 'local');

  const dataDir =
    overrides.dataDir ?? path.resolve(process.cwd(), process.env.ZIPLINK_DATA_DIR || 'data');

  return {
    port: overrides.port ?? parsePositiveInt(process.env.PORT, 3000),
    dataDir,
    previewDir:
      overrides.previewDir ??
      (process.env.ZIPLINK_PREVIEW_DIR
        ? path.resolve(process.cwd(), process.env.ZIPLINK_PREVIEW_DIR)
        : path.join(os.tmpdir(), 'ziplink-previews')),
    previewOrigin: overrides.previewOrigin ?? (process.env.ZIPLINK_PREVIEW_ORIGIN || '').trim(),
    storageDriver,
    gcsBucket,
    gcpProjectId: overrides.gcpProjectId ?? (process.env.GOOGLE_CLOUD_PROJECT || '').trim(),
    firestoreCollection:
      overrides.firestoreCollection ??
      (process.env.FIRESTORE_COLLECTION || 'ziplink_shares').trim(),
    maxCompressedBytes:
      overrides.maxCompressedBytes ??
      parsePositiveInt(process.env.ZIPLINK_MAX_COMPRESSED_BYTES, 50 * 1024 * 1024),
    maxExtractedBytes:
      overrides.maxExtractedBytes ??
      parsePositiveInt(process.env.ZIPLINK_MAX_EXTRACTED_BYTES, 200 * 1024 * 1024),
    maxSingleFileBytes:
      overrides.maxSingleFileBytes ??
      parsePositiveInt(process.env.ZIPLINK_MAX_SINGLE_FILE_BYTES, 25 * 1024 * 1024),
    maxEntryCount:
      overrides.maxEntryCount ?? parsePositiveInt(process.env.ZIPLINK_MAX_ENTRY_COUNT, 500),
    maxDirectoryDepth:
      overrides.maxDirectoryDepth ??
      parsePositiveInt(process.env.ZIPLINK_MAX_DIRECTORY_DEPTH, 15),
    maxContextMdBytes:
      overrides.maxContextMdBytes ??
      parsePositiveInt(process.env.ZIPLINK_MAX_CONTEXT_MD_BYTES, 512 * 1024),
    maxTextPreviewBytes:
      overrides.maxTextPreviewBytes ??
      parsePositiveInt(process.env.ZIPLINK_MAX_TEXT_PREVIEW_BYTES, 512 * 1024),
    previewTtlMs:
      overrides.previewTtlMs ??
      parsePositiveInt(process.env.ZIPLINK_PREVIEW_TTL_MS, 2 * 60 * 60 * 1000),
    cleanupIntervalMs:
      overrides.cleanupIntervalMs ??
      parsePositiveInt(process.env.ZIPLINK_CLEANUP_INTERVAL_MS, 60 * 1000),
    uploadRateLimitMax:
      overrides.uploadRateLimitMax ??
      parsePositiveInt(process.env.ZIPLINK_UPLOAD_RATE_LIMIT, 20),
    uploadRateLimitWindowMs:
      overrides.uploadRateLimitWindowMs ?? 15 * 60 * 1000,
  };
}
