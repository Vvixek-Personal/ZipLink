import { validateArchiveEntryPath, detectSensitiveFilenames } from './zipSecurity.ts';
import type { SensitiveFileWarning } from './types.ts';

export interface ClientZipInspection {
  entryNames: string[];
  fileCount: number;
  sensitiveWarnings: SensitiveFileWarning[];
  invalidEntries: string[];
}

/**
 * Reads only the End of Central Directory (EOCD) and Central Directory headers
 * from a ZIP buffer (or tail slice) without decompressing any file contents.
 * This allows pre-publish filename inspection in the browser in milliseconds.
 */
export function inspectZipCentralDirectoryNames(buffer: Uint8Array): {
  validZipStructure: boolean;
  entryNames: string[];
} {
  if (buffer.length < 22) {
    return { validZipStructure: false, entryNames: [] };
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Locate EOCD signature 0x06054b50 searching backwards from end (max comment 65535)
  const minOffset = Math.max(0, buffer.length - 22 - 65535);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      const commentLen = view.getUint16(i + 20, true);
      if (i + 22 + commentLen === buffer.length) {
        eocdOffset = i;
        break;
      }
    }
  }

  if (eocdOffset === -1) {
    return { validZipStructure: false, entryNames: [] };
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  if (cdOffset + cdSize > eocdOffset) {
    return { validZipStructure: false, entryNames: [] };
  }

  const entryNames: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let cursor = cdOffset;
  let count = 0;

  while (cursor + 46 <= cdOffset + cdSize && count < totalEntries) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      return { validZipStructure: false, entryNames: [] };
    }

    const fileNameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const headerEnd = cursor + 46 + fileNameLen + extraLen + commentLen;

    if (headerEnd > cdOffset + cdSize) {
      return { validZipStructure: false, entryNames: [] };
    }

    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + fileNameLen);
    const name = decoder.decode(nameBytes);
    entryNames.push(name);

    cursor = headerEnd;
    count++;
  }

  return { validZipStructure: true, entryNames };
}

export async function inspectZipFileInBrowser(file: File): Promise<ClientZipInspection> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = inspectZipCentralDirectoryNames(bytes);
  if (!parsed.validZipStructure) {
    return {
      entryNames: [],
      fileCount: 0,
      sensitiveWarnings: [],
      invalidEntries: [],
    };
  }

  const fileNames: string[] = [];
  const invalidEntries: string[] = [];

  for (const raw of parsed.entryNames) {
    const check = validateArchiveEntryPath(raw);
    if (!check.valid) {
      invalidEntries.push(raw);
      continue;
    }
    if (!check.isDirectory && check.normalizedPath) {
      fileNames.push(check.normalizedPath);
    }
  }

  const sensitiveWarnings = detectSensitiveFilenames(fileNames);

  return {
    entryNames: fileNames,
    fileCount: fileNames.length,
    sensitiveWarnings,
    invalidEntries,
  };
}
