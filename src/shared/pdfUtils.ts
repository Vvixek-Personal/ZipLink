export const PDF_IMAGE_EXPORT_LIMITS = {
  STANDARD_SCALE: 1.5,
  HIGH_SCALE: 2.5,
  MAX_CANVAS_DIMENSION_PX: 8192,
  MAX_CANVAS_PIXEL_AREA: 24_000_000,
  MAX_BATCH_EXPORT_PAGES: 100,
  MAX_ESTIMATED_ZIP_BYTES: 120 * 1024 * 1024,
} as const;

export type PdfImageFormat = 'png' | 'jpeg';
export type PdfImageResolutionPreset = 'standard' | 'high';
export type PdfPageTextKind = 'text' | 'scanned';
export type PdfDocumentTextKind = 'text' | 'scanned' | 'hybrid' | 'unknown';

export interface PdfSearchMatch {
  pageNumber: number;
  matchIndexOnPage: number;
  startOffset: number;
  length: number;
  snippet: string;
}

export function isPdfFilename(relativePath: string): boolean {
  return relativePath.trim().toLowerCase().endsWith('.pdf');
}

export function hasPdfMagicHeader(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 5) return false;
  // Allow optional UTF-8 BOM or leading ASCII whitespace up to 1024 bytes (per PDF spec)
  const searchLimit = Math.min(bytes.length - 5, 1024);
  for (let i = 0; i <= searchLimit; i++) {
    if (
      bytes[i] === 0x25 && // %
      bytes[i + 1] === 0x50 && // P
      bytes[i + 2] === 0x44 && // D
      bytes[i + 3] === 0x46 && // F
      bytes[i + 4] === 0x2d // -
    ) {
      return true;
    }
  }
  return false;
}

export function sanitizePdfExportBaseName(filename: string): string {
  const leaf = filename.split(/[/\\]/).pop() ?? 'document';
  const withoutExt = leaf.replace(/\.pdf$/i, '');
  const normalized = withoutExt
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || 'document';
}

export function formatPageExportFilename(
  filename: string,
  pageNumber: number,
  format: PdfImageFormat,
): string {
  const base = sanitizePdfExportBaseName(filename);
  const padded = String(Math.max(1, Math.floor(pageNumber))).padStart(4, '0');
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  return `${base}-page-${padded}.${ext}`;
}

export function parsePageRange(
  input: string,
  totalPages: number,
): { pages: number[]; error: string | null } {
  if (!Number.isInteger(totalPages) || totalPages <= 0) {
    return { pages: [], error: 'Document has no pages.' };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { pages: [], error: 'Enter at least one page number or range (for example, 1-3, 5).' };
  }

  const parts = trimmed.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return { pages: [], error: 'Enter a valid page range such as 1-3, 5.' };
  }

  const selected = new Set<number>();
  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
        return { pages: [], error: `Invalid page range "${part}". Page numbers start at 1.` };
      }
      if (start > end) {
        return { pages: [], error: `Range "${part}" has a start page greater than its end page.` };
      }
      if (end > totalPages) {
        return {
          pages: [],
          error: `Range "${part}" exceeds the document length (${totalPages} pages).`,
        };
      }
      for (let p = start; p <= end; p++) {
        selected.add(p);
      }
      continue;
    }

    if (/^\d+$/.test(part)) {
      const page = Number(part);
      if (page < 1 || page > totalPages) {
        return {
          pages: [],
          error: `Page ${page} is out of range (valid pages: 1–${totalPages}).`,
        };
      }
      selected.add(page);
      continue;
    }

    return {
      pages: [],
      error: `Could not parse "${part}". Use single pages or ranges like 1-3, 5.`,
    };
  }

  const pages = Array.from(selected).sort((a, b) => a - b);
  return { pages, error: null };
}

export function extractPageTextFromItems(
  items: Array<{ str?: string; hasEOL?: boolean }>,
): string {
  const chunks: string[] = [];
  for (const item of items) {
    const text = typeof item.str === 'string' ? item.str : '';
    if (text) {
      if (chunks.length > 0) {
        const prev = chunks[chunks.length - 1];
        if (prev !== '\n' && !prev.endsWith(' ') && !text.startsWith(' ')) {
          chunks.push(' ');
        }
      }
      chunks.push(text);
    }
    if (item.hasEOL) {
      chunks.push('\n');
    }
  }
  return chunks
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function classifyPdfPageText(text: string): {
  kind: PdfPageTextKind;
  charCount: number;
  nonWhitespaceCount: number;
} {
  const trimmed = text.trim();
  const nonWhitespaceCount = trimmed.replace(/\s+/g, '').length;
  // Require at least 8 non-whitespace characters (or 2+ alphanumeric tokens) to distinguish real text from lone artifact/page glyphs
  const kind: PdfPageTextKind = nonWhitespaceCount < 8 ? 'scanned' : 'text';
  return {
    kind,
    charCount: trimmed.length,
    nonWhitespaceCount,
  };
}

export function classifyDocumentTextCoverage(
  pageKinds: Array<PdfPageTextKind | undefined>,
  totalPages: number,
): {
  kind: PdfDocumentTextKind;
  checkedCount: number;
  textPageCount: number;
  scannedPageCount: number;
} {
  let checkedCount = 0;
  let textPageCount = 0;
  let scannedPageCount = 0;

  for (let i = 0; i < totalPages; i++) {
    const k = pageKinds[i];
    if (!k) continue;
    checkedCount++;
    if (k === 'text') {
      textPageCount++;
    } else {
      scannedPageCount++;
    }
  }

  if (checkedCount === 0) {
    return { kind: 'unknown', checkedCount: 0, textPageCount: 0, scannedPageCount: 0 };
  }
  if (textPageCount > 0 && scannedPageCount > 0) {
    return { kind: 'hybrid', checkedCount, textPageCount, scannedPageCount };
  }
  if (scannedPageCount === checkedCount) {
    return { kind: 'scanned', checkedCount, textPageCount, scannedPageCount };
  }
  return { kind: 'text', checkedCount, textPageCount, scannedPageCount };
}

export function formatExtractedPages(params: {
  pages: Array<{ pageNumber: number; text: string; source?: 'pdf-text' | 'ocr' }>;
  format: 'txt' | 'md';
  filename: string;
  emptyPagePlaceholder?: string;
}): string {
  const { pages, format, filename, emptyPagePlaceholder = '[No extractable text on this page]' } =
    params;

  const sections = pages.map((page) => {
    const clean = page.text.trim();
    const heading =
      page.source === 'ocr' ? `## Page ${page.pageNumber} (OCR)` : `## Page ${page.pageNumber}`;
    return `${heading}\n${clean || emptyPagePlaceholder}`;
  });

  if (format === 'md') {
    const header = `# Extracted text: ${filename}\n`;
    return `${header}\n${sections.join('\n\n')}\n`;
  }

  return `${sections.join('\n\n')}\n`;
}

export function searchPdfPagesText(
  pagesText: Record<number, string>,
  query: string,
  totalPages: number,
): PdfSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matches: PdfSearchMatch[] = [];
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    const raw = pagesText[pageNumber];
    if (!raw) continue;
    const lower = raw.toLowerCase();
    let fromIndex = 0;
    let matchIndexOnPage = 0;
    while (fromIndex < lower.length) {
      const idx = lower.indexOf(needle, fromIndex);
      if (idx === -1) break;
      const snippetStart = Math.max(0, idx - 32);
      const snippetEnd = Math.min(raw.length, idx + needle.length + 48);
      const prefix = snippetStart > 0 ? '...' : '';
      const suffix = snippetEnd < raw.length ? '...' : '';
      const snippet = `${prefix}${raw.slice(snippetStart, snippetEnd).replace(/\s+/g, ' ')}${suffix}`;

      matches.push({
        pageNumber,
        matchIndexOnPage,
        startOffset: idx,
        length: needle.length,
        snippet,
      });

      matchIndexOnPage++;
      fromIndex = idx + Math.max(1, needle.length);
      if (matches.length >= 1000) {
        return matches;
      }
    }
  }
  return matches;
}

export function resolveExportScale(preset: PdfImageResolutionPreset): number {
  return preset === 'high'
    ? PDF_IMAGE_EXPORT_LIMITS.HIGH_SCALE
    : PDF_IMAGE_EXPORT_LIMITS.STANDARD_SCALE;
}

export function validateAndComputeRenderDimensions(
  pageWidthPt: number,
  pageHeightPt: number,
  targetScale: number,
):
  | { ok: true; widthPx: number; heightPx: number; pixelArea: number }
  | { ok: false; reason: string } {
  if (
    !Number.isFinite(pageWidthPt) ||
    !Number.isFinite(pageHeightPt) ||
    !Number.isFinite(targetScale) ||
    pageWidthPt <= 0 ||
    pageHeightPt <= 0 ||
    targetScale <= 0
  ) {
    return { ok: false, reason: 'PDF page has invalid or zero dimensions.' };
  }

  const widthPx = Math.round(pageWidthPt * targetScale);
  const heightPx = Math.round(pageHeightPt * targetScale);
  const pixelArea = widthPx * heightPx;

  if (
    widthPx > PDF_IMAGE_EXPORT_LIMITS.MAX_CANVAS_DIMENSION_PX ||
    heightPx > PDF_IMAGE_EXPORT_LIMITS.MAX_CANVAS_DIMENSION_PX
  ) {
    return {
      ok: false,
      reason: `Page renders to ${widthPx}×${heightPx} px, exceeding the ${PDF_IMAGE_EXPORT_LIMITS.MAX_CANVAS_DIMENSION_PX} px maximum dimension limit. Try Standard resolution.`,
    };
  }

  if (pixelArea > PDF_IMAGE_EXPORT_LIMITS.MAX_CANVAS_PIXEL_AREA) {
    return {
      ok: false,
      reason: `Page renders to ${(pixelArea / 1_000_000).toFixed(1)} MP, exceeding the ${Math.round(PDF_IMAGE_EXPORT_LIMITS.MAX_CANVAS_PIXEL_AREA / 1_000_000)} MP safe memory limit. Try Standard resolution.`,
    };
  }

  return { ok: true, widthPx, heightPx, pixelArea };
}

export function estimateExportImageBytes(params: {
  widthPx: number;
  heightPx: number;
  format: PdfImageFormat;
  pageCount: number;
}): {
  perPageBytes: number;
  totalEstimatedBytes: number;
} {
  const { widthPx, heightPx, format, pageCount } = params;
  const pixels = Math.max(1, widthPx * heightPx);
  // Realistic empirical byte-per-pixel estimates for document pages
  const bytesPerPixel = format === 'jpeg' ? 0.14 : 0.28;
  const perPageBytes = Math.max(16 * 1024, Math.round(pixels * bytesPerPixel));
  const totalEstimatedBytes = perPageBytes * Math.max(1, pageCount);
  return {
    perPageBytes,
    totalEstimatedBytes,
  };
}
