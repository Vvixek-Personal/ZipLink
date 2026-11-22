import crypto from 'node:crypto';
import path from 'node:path';
import type { AppLimitsInfo } from '../shared/types.ts';
import { deriveAesKey } from './gitHash.ts';

export interface ZipLinkConfig extends AppLimitsInfo {
  port: number;
  appUrl: string;
  dataDir: string;
  cleanupIntervalMs: number;
  uploadRateLimitMax: number;
  uploadRateLimitWindowMs: number;
  gcsBucket: string;
  gcpProjectId: string;
  firestoreCollection: string;
  githubAppId: string;
  githubAppSlug: string;
  githubAppPrivateKey: string;
  githubClientId: string;
  githubClientSecret: string;
  githubApiBaseUrl: string;
  githubAuthBaseUrl: string;
  sessionKey: Buffer;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const fallbackRuntimeSecret = crypto.randomBytes(32).toString('hex');

export function loadConfig(overrides: Partial<ZipLinkConfig> = {}): ZipLinkConfig {
  const gcsBucket = overrides.gcsBucket ?? (process.env.GCS_BUCKET || '').trim();
  const requestedDriver = process.env.STORAGE_DRIVER?.trim().toLowerCase();
  const storageDriver: 'local' | 'gcs' =
    overrides.storageDriver ?? (requestedDriver === 'gcs' && gcsBucket ? 'gcs' : 'local');

  const rawPrivateKey =
    overrides.githubAppPrivateKey ?? (process.env.GITHUB_APP_PRIVATE_KEY || '').trim();
  const githubAppPrivateKey = rawPrivateKey.replace(/\\n/g, '\n');

  const rawSessionSecret = (process.env.ZIPLINK_SESSION_SECRET || '').trim();
  const sessionKey = overrides.sessionKey ?? deriveAesKey(rawSessionSecret || fallbackRuntimeSecret);

  const rawAppUrl = overrides.appUrl ?? (process.env.APP_URL || '').trim();
  const appUrl =
    rawAppUrl && rawAppUrl !== 'MY_APP_URL' ? rawAppUrl.replace(/\/+$/, '') : '';

  return {
    port: overrides.port ?? parsePositiveInt(process.env.PORT, 3000),
    appUrl,
    dataDir: overrides.dataDir ?? path.resolve(process.cwd(), process.env.ZIPLINK_DATA_DIR || 'data'),
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
    maxEntryCount:
      overrides.maxEntryCount ?? parsePositiveInt(process.env.ZIPLINK_MAX_ENTRY_COUNT, 500),
    maxContextMdBytes:
      overrides.maxContextMdBytes ??
      parsePositiveInt(process.env.ZIPLINK_MAX_CONTEXT_MD_BYTES, 512 * 1024),
    maxTextPreviewBytes:
      overrides.maxTextPreviewBytes ??
      parsePositiveInt(process.env.ZIPLINK_MAX_TEXT_PREVIEW_BYTES, 512 * 1024),
    cleanupIntervalMs:
      overrides.cleanupIntervalMs ??
      parsePositiveInt(process.env.ZIPLINK_CLEANUP_INTERVAL_MS, 60 * 1000),
    uploadRateLimitMax:
      overrides.uploadRateLimitMax ??
      parsePositiveInt(process.env.ZIPLINK_UPLOAD_RATE_LIMIT, 20),
    uploadRateLimitWindowMs:
      overrides.uploadRateLimitWindowMs ?? 15 * 60 * 1000,
    githubAppId: overrides.githubAppId ?? (process.env.GITHUB_APP_ID || '').trim(),
    githubAppSlug: overrides.githubAppSlug ?? (process.env.GITHUB_APP_SLUG || '').trim(),
    githubAppPrivateKey,
    githubClientId: overrides.githubClientId ?? (process.env.GITHUB_CLIENT_ID || '').trim(),
    githubClientSecret:
      overrides.githubClientSecret ?? (process.env.GITHUB_CLIENT_SECRET || '').trim(),
    githubApiBaseUrl:
      overrides.githubApiBaseUrl ??
      (process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/+$/, ''),
    githubAuthBaseUrl:
      overrides.githubAuthBaseUrl ??
      (process.env.GITHUB_AUTH_BASE_URL || 'https://github.com').replace(/\/+$/, ''),
    sessionKey,
  };
}
