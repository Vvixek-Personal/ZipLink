import crypto from 'node:crypto';

function escapePdfLiteralString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7e]/g, ' ');
}

export interface PdfFixturePageSpec {
  lines?: string[];
  widthPt?: number;
  heightPt?: number;
  drawScanBox?: boolean;
  includeRasterImage?: boolean;
}

function buildTextContentStream(lines: string[], heightPt: number): string {
  const cmds: string[] = ['BT', '/F1 12 Tf'];
  let y = heightPt - 60;
  for (const line of lines) {
    cmds.push(`1 0 0 1 54 ${y} Tm`);
    cmds.push(`(${escapePdfLiteralString(line)}) Tj`);
    y -= 18;
  }
  cmds.push('ET');
  return cmds.join('\n');
}

function buildScanImageStream(widthPt: number, heightPt: number, drawBox: boolean): string {
  if (!drawBox) return '';
  return [
    'q',
    '0.92 0.92 0.92 rg',
    `40 40 ${Math.max(40, widthPt - 80)} ${Math.max(40, heightPt - 80)} re f`,
    '0.2 0.2 0.2 RG',
    '2 w',
    `40 40 ${Math.max(40, widthPt - 80)} ${Math.max(40, heightPt - 80)} re S`,
    'Q',
  ].join('\n');
}

function serializePdfObjects(params: {
  objects: Array<{ id: number; body: string | Buffer }>;
  catalogId: number;
  encryptId?: number;
  fileIdHex?: string;
}): Uint8Array {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets: number[] = [0];
  let byteOffset = chunks[0].length;

  for (const obj of params.objects) {
    offsets[obj.id] = byteOffset;
    const header = Buffer.from(`${obj.id} 0 obj\n`, 'latin1');
    const bodyBuf =
      typeof obj.body === 'string' ? Buffer.from(obj.body, 'latin1') : obj.body;
    const footer = Buffer.from('\nendobj\n', 'latin1');
    chunks.push(header, bodyBuf, footer);
    byteOffset += header.length + bodyBuf.length + footer.length;
  }

  const xrefStart = byteOffset;
  const maxId = params.objects.reduce((m, o) => Math.max(m, o.id), 0);
  const xrefLines = [`xref\n0 ${maxId + 1}\n0000000000 65535 f \n`];
  for (let id = 1; id <= maxId; id++) {
    const off = offsets[id] ?? 0;
    xrefLines.push(`${String(off).padStart(10, '0')} 00000 n \n`);
  }

  const trailerParts = [
    `trailer\n<< /Size ${maxId + 1} /Root ${params.catalogId} 0 R`,
  ];
  if (params.encryptId) {
    trailerParts.push(` /Encrypt ${params.encryptId} 0 R`);
  }
  if (params.fileIdHex) {
    trailerParts.push(` /ID [<${params.fileIdHex}> <${params.fileIdHex}>]`);
  }
  trailerParts.push(` >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  chunks.push(Buffer.from(xrefLines.join('') + trailerParts.join(''), 'latin1'));
  return new Uint8Array(Buffer.concat(chunks));
}

export function createTestPdfBytes(options: {
  pages: PdfFixturePageSpec[];
  openActionJs?: string;
}): Uint8Array {
  const objects: Array<{ id: number; body: string | Buffer }> = [];
  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;
  let nextId = 4;

  const pageRefs: number[] = [];
  for (const page of options.pages) {
    const widthPt = page.widthPt ?? 612;
    const heightPt = page.heightPt ?? 792;
    const pageObjId = nextId++;
    const contentObjId = nextId++;

    let xObjectRef = '';
    if (page.includeRasterImage) {
      const imgObjId = nextId++;
      // Minimal 2x2 grayscale pixels -> 4 bytes
      const rawImg = Buffer.from([0xc0, 0x80, 0x80, 0xc0]);
      const imgDict = Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${rawImg.length} >>\nstream\n`,
        'latin1',
      );
      const imgEnd = Buffer.from('\nendstream', 'latin1');
      objects.push({
        id: imgObjId,
        body: Buffer.concat([imgDict, rawImg, imgEnd]),
      });
      xObjectRef = ` /XObject << /Im1 ${imgObjId} 0 R >>`;
    }

    const parts: string[] = [];
    if (page.drawScanBox) {
      parts.push(buildScanImageStream(widthPt, heightPt, true));
    }
    if (page.includeRasterImage) {
      parts.push(`q 300 0 0 180 120 ${heightPt - 320} cm /Im1 Do Q`);
    }
    if (page.lines && page.lines.length > 0) {
      parts.push(buildTextContentStream(page.lines, heightPt));
    }
    const streamStr = parts.join('\n');
    const streamBuf = Buffer.from(streamStr, 'latin1');
    objects.push({
      id: contentObjId,
      body: Buffer.concat([
        Buffer.from(`<< /Length ${streamBuf.length} >>\nstream\n`, 'latin1'),
        streamBuf,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    });

    objects.push({
      id: pageObjId,
      body: `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Resources << /Font << /F1 ${fontId} 0 R >>${xObjectRef} >> /Contents ${contentObjId} 0 R >>`,
    });
    pageRefs.push(pageObjId);
  }

  let openActionEntry = '';
  if (options.openActionJs) {
    const jsActionId = nextId++;
    objects.push({
      id: jsActionId,
      body: `<< /S /JavaScript /JS (${escapePdfLiteralString(options.openActionJs)}) >>`,
    });
    openActionEntry = ` /OpenAction ${jsActionId} 0 R`;
  }

  objects.unshift(
    {
      id: catalogId,
      body: `<< /Type /Catalog /Pages ${pagesId} 0 R${openActionEntry} >>`,
    },
    {
      id: pagesId,
      body: `<< /Type /Pages /Kids [${pageRefs.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`,
    },
    {
      id: fontId,
      body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    },
  );

  objects.sort((a, b) => a.id - b.id);
  return serializePdfObjects({ objects, catalogId });
}

// Pure JS RC4 (for generating PDF Standard Security Handler /V 1 /R 2 encrypted test PDFs)
function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

const PDF_PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41,
  0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function padPassword32(password: string): Uint8Array {
  const pwBytes = Buffer.from(password, 'latin1');
  const out = new Uint8Array(32);
  const copyLen = Math.min(32, pwBytes.length);
  out.set(pwBytes.subarray(0, copyLen), 0);
  if (copyLen < 32) {
    out.set(PDF_PADDING.subarray(0, 32 - copyLen), copyLen);
  }
  return out;
}

function md5(input: Uint8Array): Uint8Array {
  return new Uint8Array(crypto.createHash('md5').update(input).digest());
}

/**
 * Generates a valid PDF 1.4 encrypted with Standard Security Handler (/V 1 /R 2, 40-bit RC4)
 * requiring userPassword to open in PDF.js.
 */
export function createEncryptedTestPdfBytes(options: {
  pages: PdfFixturePageSpec[];
  userPassword: string;
  ownerPassword?: string;
}): Uint8Array {
  const ownerPwd = options.ownerPassword ?? `${options.userPassword}-owner`;
  const fileId = crypto.randomBytes(16);
  const fileIdHex = fileId.toString('hex');

  // Step 1: Compute /O (32 bytes)
  const ownerPad = padPassword32(ownerPwd);
  const oKey = md5(ownerPad).subarray(0, 5);
  const oValue = rc4(oKey, padPassword32(options.userPassword));

  // Step 2: Compute encryption key (5 bytes for R=2)
  const permissions = -4; // 0xFFFFFFFC in 32-bit little endian
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, permissions, true);

  const userPad = padPassword32(options.userPassword);
  const keyInput = new Uint8Array(32 + 32 + 4 + 16);
  keyInput.set(userPad, 0);
  keyInput.set(oValue, 32);
  keyInput.set(pBytes, 64);
  keyInput.set(fileId, 68);
  const encKey = md5(keyInput).subarray(0, 5);

  // Step 3: Compute /U (32 bytes)
  const uValue = rc4(encKey, PDF_PADDING);

  function deriveObjKey(objId: number): Uint8Array {
    const buf = new Uint8Array(encKey.length + 5);
    buf.set(encKey, 0);
    buf[encKey.length] = objId & 0xff;
    buf[encKey.length + 1] = (objId >> 8) & 0xff;
    buf[encKey.length + 2] = (objId >> 16) & 0xff;
    buf[encKey.length + 3] = 0;
    buf[encKey.length + 4] = 0;
    return md5(buf).subarray(0, Math.min(16, encKey.length + 5));
  }

  const objects: Array<{ id: number; body: string | Buffer }> = [];
  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;
  const encryptId = 4;
  let nextId = 5;

  const pageRefs: number[] = [];
  for (const page of options.pages) {
    const widthPt = page.widthPt ?? 612;
    const heightPt = page.heightPt ?? 792;
    const pageObjId = nextId++;
    const contentObjId = nextId++;

    const rawStream = Buffer.from(
      buildTextContentStream(page.lines ?? ['Encrypted page'], heightPt),
      'latin1',
    );
    const encStream = Buffer.from(rc4(deriveObjKey(contentObjId), rawStream));

    objects.push({
      id: contentObjId,
      body: Buffer.concat([
        Buffer.from(`<< /Length ${encStream.length} >>\nstream\n`, 'latin1'),
        encStream,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    });

    objects.push({
      id: pageObjId,
      body: `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentObjId} 0 R >>`,
    });
    pageRefs.push(pageObjId);
  }

  const oHex = Buffer.from(oValue).toString('hex');
  const uHex = Buffer.from(uValue).toString('hex');

  objects.unshift(
    { id: catalogId, body: `<< /Type /Catalog /Pages ${pagesId} 0 R >>` },
    {
      id: pagesId,
      body: `<< /Type /Pages /Kids [${pageRefs.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`,
    },
    { id: fontId, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    {
      id: encryptId,
      body: `<< /Filter /Standard /V 1 /R 2 /Length 40 /P ${permissions} /O <${oHex}> /U <${uHex}> >>`,
    },
  );

  objects.sort((a, b) => a.id - b.id);
  return serializePdfObjects({ objects, catalogId, encryptId, fileIdHex });
}

export function createMalformedPdfBytes(): Uint8Array {
  return new Uint8Array(
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Broken true >>\n%%corrupted-no-xref', 'latin1'),
  );
}
