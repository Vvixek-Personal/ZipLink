import type { SensitiveFileWarning, ShareFileEntry } from './types.ts';
import { formatBytes, getLowerExtension } from './zipSecurity.ts';

export interface TextFileContentInput {
  file: ShareFileEntry;
  textContent: string | null;
}

export interface ContextBuildResult {
  contextMd: string;
  updatedFiles: ShareFileEntry[];
  includedCount: number;
  omittedCount: number;
}

function getFenceForContent(content: string): string {
  const matches = content.match(/`{3,}/g);
  if (!matches) return '```';
  let maxLen = 3;
  for (const m of matches) {
    if (m.length >= maxLen) {
      maxLen = m.length + 1;
    }
  }
  return '`'.repeat(maxLen);
}

function getLanguageHint(relativePath: string): string {
  const ext = getLowerExtension(relativePath);
  const map: Record<string, string> = {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.js': 'js',
    '.jsx': 'jsx',
    '.mjs': 'js',
    '.cjs': 'js',
    '.json': 'json',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.py': 'python',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.swift': 'swift',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.php': 'php',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'zsh',
    '.sql': 'sql',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.xml': 'xml',
    '.html': 'html',
    '.htm': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.svg': 'xml',
    '.csv': 'csv',
  };
  return map[ext] ?? '';
}

export function buildContextMarkdown(params: {
  shareId: string;
  archiveName: string;
  createdAt: string;
  expiresAt: string;
  entries: TextFileContentInput[];
  maxContextBytes: number;
}): ContextBuildResult {
  const { shareId, archiveName, createdAt, expiresAt, entries, maxContextBytes } = params;

  const sorted = [...entries].sort((a, b) =>
    a.file.relativePath.localeCompare(b.file.relativePath, 'en'),
  );

  const encoder = new TextEncoder();
  const byteLength = (s: string) => encoder.encode(s).length;

  const updatedFiles: ShareFileEntry[] = [];
  const includedSections: string[] = [];
  const omittedEntries: Array<{ path: string; sizeBytes: number; reason: string }> = [];

  // Reserve room for header, tree, and omitted list
  const treeLines = sorted.map(
    ({ file }) => `- \`${file.relativePath}\` (${formatBytes(file.sizeBytes)})`,
  );

  const headerBase = [
    `# ZipLink Archive Context`,
    ``,
    `- **Archive:** ${archiveName}`,
    `- **Share ID:** \`${shareId}\``,
    `- **Created:** ${createdAt}`,
    `- **Expires:** ${expiresAt}`,
    `- **Total Files:** ${sorted.length}`,
    `- **Context Size Budget:** ${formatBytes(maxContextBytes)}`,
    ``,
    `> Notice: Unlisted share — anyone with this URL can read these files. Generated deterministically without AI.`,
    ``,
    `## File Tree`,
    ``,
    ...treeLines,
    ``,
    `## Readable Text Files`,
    ``,
  ].join('\n');

  // Reserve budget for omitted section footer
  const reservedFooterBytes = 16 * 1024;
  const effectiveBudget = Math.max(byteLength(headerBase) + 2048, maxContextBytes - reservedFooterBytes);
  let usedBytes = byteLength(headerBase);

  for (const item of sorted) {
    const fileCopy: ShareFileEntry = { ...item.file };
    if (!fileCopy.isText || item.textContent === null) {
      fileCopy.includedInContextMd = false;
      fileCopy.omissionReason = fileCopy.omissionReason ?? 'binary or non-UTF-8 file';
      omittedEntries.push({
        path: fileCopy.relativePath,
        sizeBytes: fileCopy.sizeBytes,
        reason: fileCopy.omissionReason,
      });
      updatedFiles.push(fileCopy);
      continue;
    }

    const fence = getFenceForContent(item.textContent);
    const lang = getLanguageHint(fileCopy.relativePath);
    const body = item.textContent.length === 0 ? '(empty file)' : item.textContent;
    const section = [
      `### ${fileCopy.relativePath}`,
      ``,
      `Size: ${formatBytes(fileCopy.sizeBytes)}`,
      ``,
      `${fence}${lang}`,
      body,
      `${fence}`,
      ``,
    ].join('\n');

    const sectionBytes = byteLength(section);
    if (usedBytes + sectionBytes > effectiveBudget) {
      fileCopy.includedInContextMd = false;
      fileCopy.omissionReason = `exceeded context.md size limit (${formatBytes(maxContextBytes)})`;
      omittedEntries.push({
        path: fileCopy.relativePath,
        sizeBytes: fileCopy.sizeBytes,
        reason: fileCopy.omissionReason,
      });
      updatedFiles.push(fileCopy);
      continue;
    }

    usedBytes += sectionBytes;
    fileCopy.includedInContextMd = true;
    fileCopy.omissionReason = null;
    includedSections.push(section);
    updatedFiles.push(fileCopy);
  }

  const omittedBlock =
    omittedEntries.length === 0
      ? `## Omitted Files\n\nNone — all readable text files were included.\n`
      : [
          `## Omitted Files (${omittedEntries.length})`,
          ``,
          ...omittedEntries.map(
            (o) => `- \`${o.path}\` (${formatBytes(o.sizeBytes)}) — ${o.reason}`,
          ),
          ``,
        ].join('\n');

  const includedBlock =
    includedSections.length === 0
      ? `_No readable UTF-8 text files fit within the context.md limits._\n\n`
      : includedSections.join('\n');

  const contextMd = `${headerBase}${includedBlock}${omittedBlock}`;

  return {
    contextMd,
    updatedFiles,
    includedCount: includedSections.length,
    omittedCount: omittedEntries.length,
  };
}

export function buildManifestJson(params: {
  shareId: string;
  archiveName: string;
  createdAt: string;
  expiresAt: string;
  totalExtractedBytes: number;
  sensitiveWarnings: SensitiveFileWarning[];
  files: ShareFileEntry[];
}): string {
  const manifest = {
    schemaVersion: 2,
    generatedOutputNote:
      'Generated automatically by ZipLink from the current saved files in this share.',
    shareId: params.shareId,
    archiveName: params.archiveName,
    createdAt: params.createdAt,
    expiresAt: params.expiresAt,
    totalFiles: params.files.length,
    totalExtractedBytes: params.totalExtractedBytes,
    contextIncludedCount: params.files.filter((f) => f.includedInContextMd).length,
    contextOmittedCount: params.files.filter((f) => !f.includedInContextMd).length,
    sensitiveFilenameWarnings: params.sensitiveWarnings,
    files: params.files.map((f) => ({
      id: f.id,
      relativePath: f.relativePath,
      sizeBytes: f.sizeBytes,
      sha256: f.sha256,
      originalSizeBytes: f.originalSizeBytes,
      originalSha256: f.originalSha256,
      version: f.version,
      isEdited: f.isEdited,
      lastModifiedAt: f.lastModifiedAt,
      isText: f.isText,
      isActiveContent: f.isActiveContent,
      includedInContextMd: f.includedInContextMd,
      omissionReason: f.omissionReason,
    })),
  };
  return JSON.stringify(manifest, null, 2);
}
