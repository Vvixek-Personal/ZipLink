export type ExpiryOption = '24h' | '7d' | '30d';

export interface ShareFileEntry {
  id: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  isText: boolean;
  isActiveContent: boolean;
  includedInContextMd: boolean;
  omissionReason: string | null;
}

export interface SensitiveFileWarning {
  relativePath: string;
  reason: string;
}

export interface ShareRecord {
  shareId: string;
  archiveName: string;
  createdAt: string;
  expiresAt: string;
  expiresAtMs: number;
  expiryOption: ExpiryOption;
  totalFiles: number;
  totalExtractedBytes: number;
  contextIncludedCount: number;
  contextOmittedCount: number;
  sensitiveWarnings: SensitiveFileWarning[];
  files: ShareFileEntry[];
  deleteTokenHash: string;
}

export type PublicShareMetadata = Omit<ShareRecord, 'deleteTokenHash'>;

export interface UploadSuccessPayload {
  shareId: string;
  shareUrl: string;
  contextUrl: string;
  manifestUrl: string;
  deleteUrl: string;
  deleteToken: string;
  expiresAt: string;
  expiryOption: ExpiryOption;
  archiveName: string;
  totalFiles: number;
  totalExtractedBytes: number;
  contextIncludedCount: number;
  contextOmittedCount: number;
  sensitiveWarnings: SensitiveFileWarning[];
  contextMd: string;
}

export interface AppLimitsInfo {
  maxCompressedBytes: number;
  maxExtractedBytes: number;
  maxEntryCount: number;
  maxContextMdBytes: number;
  maxTextPreviewBytes: number;
  storageDriver: 'local' | 'gcs';
}
