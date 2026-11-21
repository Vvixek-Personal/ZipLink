import type { ExpiryOption, SensitiveFileWarning } from './types.ts';

export const MAX_RELATIVE_PATH_LENGTH = 240;
export const MAX_SEGMENT_LENGTH = 120;

const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

const ACTIVE_WEB_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.xhtml',
  '.svg',
  '.svgz',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.xml',
  '.xsl',
  '.xslt',
  '.swf',
  '.pdf',
  '.php',
  '.asp',
  '.aspx',
  '.jsp',
]);

const NESTED_ARCHIVE_EXTENSIONS = new Set([
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
]);

const KNOWN_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tiff',
  '.tif',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
  '.mkv',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.wasm',
  '.pyc',
  '.pyo',
  '.class',
  '.jar',
  '.war',
  '.o',
  '.a',
  '.lib',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.ds_store',
]);

export interface PathValidationResult {
  valid: boolean;
  normalizedPath?: string;
  isDirectory?: boolean;
  reason?: string;
}

export function validateArchiveEntryPath(rawPath: string): PathValidationResult {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { valid: false, reason: 'Entry path is empty.' };
  }

  if (rawPath.includes('\0')) {
    return { valid: false, reason: 'Entry path contains a null byte.' };
  }

  for (let i = 0; i < rawPath.length; i++) {
    const code = rawPath.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return { valid: false, reason: 'Entry path contains unsafe control characters.' };
    }
  }

  // Normalize Windows separators before validation
  const slashNormalized = rawPath.replace(/\\/g, '/');

  if (slashNormalized.startsWith('/') || slashNormalized.startsWith('//')) {
    return { valid: false, reason: `Absolute path is not allowed: "${rawPath}".` };
  }

  if (/^[a-zA-Z]:/.test(slashNormalized)) {
    return { valid: false, reason: `Drive-letter path is not allowed: "${rawPath}".` };
  }

  const isDirectory = slashNormalized.endsWith('/');
  const trimmed = isDirectory ? slashNormalized.slice(0, -1) : slashNormalized;

  if (trimmed.length === 0) {
    return { valid: false, reason: 'Entry path resolves to empty root.' };
  }

  if (trimmed.length > MAX_RELATIVE_PATH_LENGTH) {
    return {
      valid: false,
      reason: `Entry path exceeds maximum length of ${MAX_RELATIVE_PATH_LENGTH} characters.`,
    };
  }

  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      return { valid: false, reason: `Entry path contains empty path segments: "${rawPath}".` };
    }
    if (segment === '.' || segment === '..') {
      return { valid: false, reason: `Path traversal segment "${segment}" is not allowed.` };
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      return {
        valid: false,
        reason: `Filename segment exceeds ${MAX_SEGMENT_LENGTH} characters.`,
      };
    }
    if (segment.endsWith(' ') || (segment.endsWith('.') && segment.length > 1 && !segment.startsWith('.'))) {
      return { valid: false, reason: `Unsafe trailing dot or space in path segment "${segment}".` };
    }
    const baseUpper = segment.split('.')[0].toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(baseUpper)) {
      return { valid: false, reason: `Reserved filename "${segment}" is not allowed.` };
    }
  }

  return {
    valid: true,
    normalizedPath: trimmed,
    isDirectory,
  };
}

export function getLowerExtension(relativePath: string): string {
  const base = relativePath.split('/').pop() ?? '';
  const dotIndex = base.lastIndexOf('.');
  if (dotIndex <= 0) {
    return '';
  }
  return base.slice(dotIndex).toLowerCase();
}

export function isActiveWebContent(relativePath: string): boolean {
  const ext = getLowerExtension(relativePath);
  return ACTIVE_WEB_EXTENSIONS.has(ext);
}

export function isNestedArchive(relativePath: string): boolean {
  const ext = getLowerExtension(relativePath);
  return NESTED_ARCHIVE_EXTENSIONS.has(ext);
}

export interface TextClassificationResult {
  isText: boolean;
  reason: string | null;
}

export function classifyTextContent(
  relativePath: string,
  buffer: Uint8Array,
): TextClassificationResult {
  if (isNestedArchive(relativePath)) {
    return {
      isText: false,
      reason: 'nested archive (not extracted)',
    };
  }

  const ext = getLowerExtension(relativePath);
  const baseName = (relativePath.split('/').pop() ?? '').toLowerCase();
  if (KNOWN_BINARY_EXTENSIONS.has(ext) || baseName === '.ds_store') {
    return {
      isText: false,
      reason: 'binary file',
    };
  }

  if (buffer.length === 0) {
    return {
      isText: true,
      reason: null,
    };
  }

  // Scan bytes for NUL bytes and control characters
  const sampleLen = Math.min(buffer.length, 65536);
  let controlBytes = 0;
  for (let i = 0; i < sampleLen; i++) {
    const b = buffer[i];
    if (b === 0) {
      return {
        isText: false,
        reason: 'binary file',
      };
    }
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      controlBytes++;
    }
  }

  if (controlBytes / sampleLen > 0.03) {
    return {
      isText: false,
      reason: 'binary or control-heavy file',
    };
  }

  // Validate UTF-8 decoding
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(buffer);
    return {
      isText: true,
      reason: null,
    };
  } catch {
    return {
      isText: false,
      reason: 'non-UTF-8 binary content',
    };
  }
}

export function detectSensitiveFilenames(paths: string[]): SensitiveFileWarning[] {
  const warnings: SensitiveFileWarning[] = [];
  const seen = new Set<string>();

  for (const rawPath of paths) {
    const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || normalized.endsWith('/') || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    const lowerPath = normalized.toLowerCase();
    const baseName = lowerPath.split('/').pop() ?? '';

    // Allow safe template/example env files
    const isEnvExample =
      baseName === '.env.example' ||
      baseName === '.env.sample' ||
      baseName === '.env.template' ||
      baseName === '.env.schema';

    if (!isEnvExample && (baseName === '.env' || baseName.startsWith('.env.'))) {
      warnings.push({
        relativePath: normalized,
        reason: 'Environment file (.env) often contains API keys or secrets.',
      });
      continue;
    }

    if (
      /\.(pem|key|p12|pfx|ppk|jks|keystore)$/i.test(baseName) ||
      /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/i.test(baseName) && !baseName.endsWith('.pub')
    ) {
      warnings.push({
        relativePath: normalized,
        reason: 'Private key or certificate keystore file.',
      });
      continue;
    }

    if (
      baseName === '.npmrc' ||
      baseName === '.pypirc' ||
      baseName === '.netrc' ||
      baseName === '.htpasswd' ||
      baseName === 'master.key' ||
      baseName === 'terraform.tfvars' ||
      baseName.endsWith('.tfvars') ||
      lowerPath.endsWith('.aws/credentials') ||
      lowerPath.endsWith('.kube/config') ||
      lowerPath.endsWith('.docker/config.json')
    ) {
      warnings.push({
        relativePath: normalized,
        reason: 'Tooling or cloud credential configuration file.',
      });
      continue;
    }

    if (
      baseName === 'credentials.json' ||
      /service[-_]?account.*\.json$/i.test(baseName) ||
      /^secrets?\.(json|ya?ml|toml|txt|env)$/i.test(baseName) ||
      /(^|[-_.])(secret|secrets|credential|credentials|private[-_]?key|api[-_]?key)([-_.]|$)/i.test(
        baseName,
      )
    ) {
      warnings.push({
        relativePath: normalized,
        reason: 'Filename suggests credentials or secret material.',
      });
    }
  }

  return warnings;
}

export function sanitizeArchiveFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? 'archive.zip';
  const cleaned = base.replace(/[\x00-\x1f\x7f"\\]/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 140) : 'archive.zip';
}

export function sanitizeContentDispositionFilename(filename: string): {
  asciiFallback: string;
  utf8Encoded: string;
} {
  const base = filename.split(/[/\\]/).pop() ?? 'download';
  const noControls = base.replace(/[\x00-\x1f\x7f]/g, '_');
  const asciiFallback = noControls.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'download';
  const utf8Encoded = encodeURIComponent(noControls);
  return { asciiFallback, utf8Encoded };
}

export function resolveExpiryTimestamp(
  option: ExpiryOption,
  nowMs: number = Date.now(),
): { expiresAtMs: number; expiresAt: string } {
  const hoursMap: Record<ExpiryOption, number> = {
    '24h': 24,
    '7d': 24 * 7,
    '30d': 24 * 30,
  };
  const hours = hoursMap[option] ?? 24 * 7;
  const expiresAtMs = nowMs + hours * 60 * 60 * 1000;
  return {
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function isValidExpiryOption(value: unknown): value is ExpiryOption {
  return value === '24h' || value === '7d' || value === '30d';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = bytes / 1024;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(val >= 100 ? 0 : 1)} ${units[idx]}`;
}
