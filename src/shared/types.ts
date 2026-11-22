export type ExpiryOption = '24h' | '7d' | '30d';

export type ThemePreference = 'light' | 'dark' | 'system';

export interface ShareFileEntry {
  id: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  originalSizeBytes: number;
  originalSha256: string;
  version: number;
  isEdited: boolean;
  lastModifiedAt: string | null;
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
  editTokenHash: string;
}

export type PublicShareMetadata = Omit<ShareRecord, 'deleteTokenHash' | 'editTokenHash'>;

export interface UploadSuccessPayload {
  shareId: string;
  shareUrl: string;
  editUrl: string;
  editToken: string;
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

export interface FilePreviewPayload {
  id: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  originalSha256: string;
  version: number;
  isEdited: boolean;
  lastModifiedAt: string | null;
  isActiveContent: boolean;
  content: string;
}

export interface FileOriginalPayload {
  id: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  content: string;
}

export interface SaveFileResponse {
  file: ShareFileEntry;
  share: PublicShareMetadata;
  content: string;
}

export interface FileConflictPayload {
  error: string;
  conflict: true;
  currentSha256: string;
  currentVersion: number;
  currentContent: string | null;
  currentFile: ShareFileEntry;
}
