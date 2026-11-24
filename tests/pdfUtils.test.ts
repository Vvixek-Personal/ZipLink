import test from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  classifyDocumentTextCoverage,
  classifyPdfPageText,
  estimateExportImageBytes,
  extractPageTextFromItems,
  formatExtractedPages,
  formatPageExportFilename,
  hasPdfMagicHeader,
  isPdfFilename,
  parsePageRange,
  PDF_IMAGE_EXPORT_LIMITS,
  sanitizePdfExportBaseName,
  searchPdfPagesText,
  validateAndComputeRenderDimensions,
} from '../src/shared/pdfUtils.ts';
import {
  createEncryptedTestPdfBytes,
  createMalformedPdfBytes,
  createTestPdfBytes,
} from './pdfFixtures.ts';

async function openWithPdfJs(bytes: Uint8Array, password?: string) {
  const loadingTask = pdfjsLib.getDocument({
    data: bytes.slice(),
    password,
    enableXfa: false,
    useSystemFonts: false,
    verbosity: pdfjsLib.VerbosityLevel.ERRORS,
  });
  const doc = await loadingTask.promise;
  return {
    doc,
    close: async () => {
      await doc.cleanup().catch(() => undefined);
      await loadingTask.destroy().catch(() => undefined);
    },
  };
}

test('PDF filename and magic header helpers identify valid PDFs and sanitize export filenames', () => {
  assert.equal(isPdfFilename('docs/Report.PDF'), true);
  assert.equal(isPdfFilename('src/index.ts'), false);

  assert.equal(hasPdfMagicHeader(new TextEncoder().encode('%PDF-1.7\n...')), true);
  assert.equal(hasPdfMagicHeader(new TextEncoder().encode('   \n%PDF-1.4\n')), true);
  assert.equal(hasPdfMagicHeader(new TextEncoder().encode('<html>not pdf</html>')), false);

  assert.equal(sanitizePdfExportBaseName('folder/My Document (v2).pdf'), 'My-Document-v2');
  assert.equal(
    formatPageExportFilename('document.pdf', 1, 'png'),
    'document-page-0001.png',
  );
  assert.equal(
    formatPageExportFilename('quarterly report.pdf', 12, 'jpeg'),
    'quarterly-report-page-0012.jpg',
  );
});

test('parsePageRange validates ranges, deduplicates, and rejects out-of-bounds inputs', () => {
  assert.deepEqual(parsePageRange('1-3, 5, 2', 6), {
    pages: [1, 2, 3, 5],
    error: null,
  });
  assert.equal(parsePageRange('', 5).pages.length, 0);
  assert.match(parsePageRange('5-2', 5).error ?? '', /start page greater/i);
  assert.match(parsePageRange('1-10', 5).error ?? '', /exceeds/i);
  assert.match(parsePageRange('abc', 5).error ?? '', /could not parse/i);
});

test('formatExtractedPages preserves page number headings in .txt and .md exports', () => {
  const txt = formatExtractedPages({
    filename: 'brief.pdf',
    format: 'txt',
    pages: [
      { pageNumber: 1, text: 'Alpha section' },
      { pageNumber: 3, text: 'Gamma section' },
    ],
  });
  assert.match(txt, /^## Page 1\nAlpha section\n\n## Page 3\nGamma section\n$/);

  const md = formatExtractedPages({
    filename: 'brief.pdf',
    format: 'md',
    pages: [{ pageNumber: 2, text: 'OCR recognized line', source: 'ocr' }],
  });
  assert.match(md, /# Extracted text: brief\.pdf/);
  assert.match(md, /## Page 2 \(OCR\)\nOCR recognized line/);
});

test('Image export dimension limits and size estimates protect memory on oversized pages', () => {
  const normal = validateAndComputeRenderDimensions(
    612,
    792,
    PDF_IMAGE_EXPORT_LIMITS.STANDARD_SCALE,
  );
  assert.equal(normal.ok, true);
  if (normal.ok) {
    assert.equal(normal.widthPx, 918);
    assert.equal(normal.heightPx, 1188);
    const est = estimateExportImageBytes({
      widthPx: normal.widthPx,
      heightPx: normal.heightPx,
      format: 'png',
      pageCount: 3,
    });
    assert.ok(est.perPageBytes > 16 * 1024);
    assert.equal(est.totalEstimatedBytes, est.perPageBytes * 3);
  }

  const tooBig = validateAndComputeRenderDimensions(
    12000,
    12000,
    PDF_IMAGE_EXPORT_LIMITS.HIGH_SCALE,
  );
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) {
    assert.match(tooBig.reason, /exceeding/i);
  }
});

test('PDF.js reads normal multi-page text PDF, extracts page text, searches, and preserves page numbers', async () => {
  const pdfBytes = createTestPdfBytes({
    pages: [
      { lines: ['ZipLink Architecture Guide', 'First page overview token-alpha'] },
      { lines: ['Second page details', 'Contains searchable token-beta here'] },
      { lines: ['Third page appendix', 'Final summary token-alpha'] },
    ],
  });

  const { doc, close } = await openWithPdfJs(pdfBytes);
  try {
    assert.equal(doc.numPages, 3);
    const pagesText: Record<number, string> = {};
    const kinds: Array<'text' | 'scanned'> = [];

    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const txt = extractPageTextFromItems(tc.items as Array<{ str?: string; hasEOL?: boolean }>);
      pagesText[p] = txt;
      kinds.push(classifyPdfPageText(txt).kind);
      page.cleanup();
    }

    assert.deepEqual(kinds, ['text', 'text', 'text']);
    assert.equal(classifyDocumentTextCoverage(kinds, 3).kind, 'text');

    const matches = searchPdfPagesText(pagesText, 'token-alpha', 3);
    assert.equal(matches.length, 2);
    assert.equal(matches[0].pageNumber, 1);
    assert.equal(matches[1].pageNumber, 3);
  } finally {
    await close();
  }
});

test('PDF.js detects scan-only (image-only) PDF without selectable text', async () => {
  const scanPdf = createTestPdfBytes({
    pages: [
      { drawScanBox: true, includeRasterImage: true },
      { drawScanBox: true, includeRasterImage: true },
    ],
  });

  const { doc, close } = await openWithPdfJs(scanPdf);
  try {
    assert.equal(doc.numPages, 2);
    const kinds: Array<'text' | 'scanned'> = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const txt = extractPageTextFromItems(tc.items as Array<{ str?: string; hasEOL?: boolean }>);
      kinds.push(classifyPdfPageText(txt).kind);
      page.cleanup();
    }
    assert.deepEqual(kinds, ['scanned', 'scanned']);
    const coverage = classifyDocumentTextCoverage(kinds, 2);
    assert.equal(coverage.kind, 'scanned');
    assert.equal(coverage.scannedPageCount, 2);
  } finally {
    await close();
  }
});

test('PDF.js classifies hybrid PDF with both selectable-text and scanned pages page by page', async () => {
  const hybridPdf = createTestPdfBytes({
    pages: [
      { lines: ['Page 1 selectable header', 'Executive summary text layer present.'] },
      { drawScanBox: true, includeRasterImage: true },
      { lines: ['Page 3 selectable conclusion', 'Appendix table notes here.'] },
    ],
  });

  const { doc, close } = await openWithPdfJs(hybridPdf);
  try {
    assert.equal(doc.numPages, 3);
    const kinds: Array<'text' | 'scanned'> = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const txt = extractPageTextFromItems(tc.items as Array<{ str?: string; hasEOL?: boolean }>);
      kinds.push(classifyPdfPageText(txt).kind);
      page.cleanup();
    }
    assert.deepEqual(kinds, ['text', 'scanned', 'text']);
    const coverage = classifyDocumentTextCoverage(kinds, 3);
    assert.equal(coverage.kind, 'hybrid');
    assert.equal(coverage.textPageCount, 2);
    assert.equal(coverage.scannedPageCount, 1);
  } finally {
    await close();
  }
});

test('PDF.js requires password for encrypted PDF, rejects wrong password, and unlocks with valid password', async () => {
  const encryptedPdf = createEncryptedTestPdfBytes({
    userPassword: 'ziplink123',
    pages: [{ lines: ['Confidential unlocked page text'] }],
  });

  await assert.rejects(
    () => openWithPdfJs(encryptedPdf),
    (err: unknown) => err instanceof pdfjsLib.PasswordException,
  );

  await assert.rejects(
    () => openWithPdfJs(encryptedPdf, 'wrong-password'),
    (err: unknown) => err instanceof pdfjsLib.PasswordException,
  );

  const { doc: unlockedDoc, close } = await openWithPdfJs(encryptedPdf, 'ziplink123');
  try {
    const page = await unlockedDoc.getPage(1);
    const tc = await page.getTextContent();
    const txt = extractPageTextFromItems(tc.items as Array<{ str?: string; hasEOL?: boolean }>);
    assert.match(txt, /Confidential unlocked page text/);
    page.cleanup();
  } finally {
    await close();
  }
});

test('PDF.js rejects malformed PDF cleanly and ignores OpenAction JavaScript payloads', async () => {
  const malformed = createMalformedPdfBytes();
  await assert.rejects(() => openWithPdfJs(malformed));

  let executed = false;
  (globalThis as Record<string, unknown>).__pdfScriptExecuted = () => {
    executed = true;
  };
  const jsPdf = createTestPdfBytes({
    pages: [{ lines: ['Safe visible page text'] }],
    openActionJs: 'globalThis.__pdfScriptExecuted && globalThis.__pdfScriptExecuted(); app.alert("pwn");',
  });
  const { doc, close } = await openWithPdfJs(jsPdf);
  try {
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();
    const txt = extractPageTextFromItems(tc.items as Array<{ str?: string; hasEOL?: boolean }>);
    assert.match(txt, /Safe visible page text/);
    assert.equal(executed, false);
    page.cleanup();
  } finally {
    delete (globalThis as Record<string, unknown>).__pdfScriptExecuted;
    await close();
  }
});

test('Large 60-page PDF loads and navigates single pages cleanly', async () => {
  const largePdf = createTestPdfBytes({
    pages: Array.from({ length: 60 }, (_, idx) => ({
      lines: [`Large Document Page ${idx + 1}`, `Line content for page ${idx + 1}`],
    })),
  });

  const { doc, close } = await openWithPdfJs(largePdf);
  try {
    assert.equal(doc.numPages, 60);
    const p60 = await doc.getPage(60);
    const tc = await p60.getTextContent();
    const txt = extractPageTextFromItems(tc.items as Array<{ str?: string; hasEOL?: boolean }>);
    assert.match(txt, /Large Document Page 60/);
    p60.cleanup();
  } finally {
    await close();
  }
});
