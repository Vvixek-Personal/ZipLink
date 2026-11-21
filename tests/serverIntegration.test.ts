import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { createZipLinkApp } from '../src/server/app.ts';

interface StartedServer {
  baseUrl: string;
  dataDir: string;
  close: () => Promise<void>;
  setNow: (ms: number) => void;
  purgeExpired: () => Promise<number>;
}

async function startTestServer(
  configOverrides: Record<string, unknown> = {},
): Promise<StartedServer> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ziplink-test-data-'));
  let currentNow = Date.UTC(2026, 10, 21, 12, 0, 0);

  const { app, storage } = await createZipLinkApp({
    config: { dataDir, ...configOverrides },
    disableRateLimit: true,
    now: () => currentNow,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    dataDir,
    setNow: (ms: number) => {
      currentNow = ms;
    },
    purgeExpired: () => storage.purgeExpiredShares(currentNow),
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function uploadZip(
  baseUrl: string,
  zipBytes: Uint8Array,
  filename = 'test.zip',
  expiry = '7d',
): Promise<globalThis.Response> {
  const form = new FormData();
  form.append('archive', new Blob([Buffer.from(zipBytes)], { type: 'application/zip' }), filename);
  form.append('expiry', expiry);
  return fetch(`${baseUrl}/api/shares`, { method: 'POST', body: form });
}

/**
 * Helper to patch a filename in a valid fflate ZIP buffer (same byte length)
 * so we can test server rejection of traversal paths like "../evil" in both LFH and CD.
 */
function replaceAsciiInBuffer(buf: Uint8Array, search: string, replace: string): Uint8Array {
  assert.equal(search.length, replace.length, 'Search and replace must have equal byte length');
  const out = new Uint8Array(buf);
  const sBytes = strToU8(search);
  const rBytes = strToU8(replace);
  for (let i = 0; i <= out.length - sBytes.length; i++) {
    let match = true;
    for (let j = 0; j < sBytes.length; j++) {
      if (out[i + j] !== sBytes[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      out.set(rBytes, i);
    }
  }
  return out;
}

test('Valid ZIP upload extracts files, generates context.md & manifest.json, enforces safe headers, and handles nested zips safely', async () => {
  const srv = await startTestServer();
  try {
    const innerZip = zipSync({ 'inner-secret.txt': strToU8('should not be extracted') });
    const xssHtml = '<!doctype html><html><body><script>alert("xss")</script></body></html>';
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

    const outerZip = zipSync({
      'src/app.ts': strToU8('export const greeting = "hello ziplink";\n'),
      'public/xss.html': strToU8(xssHtml),
      'assets/logo.png': pngBytes,
      'nested.zip': innerZip,
    });

    const res = await uploadZip(srv.baseUrl, outerZip, 'sample-repo.zip', '7d');
    assert.equal(res.status, 201);
    const created = (await res.json()) as {
      shareId: string;
      deleteToken: string;
      totalFiles: number;
      contextIncludedCount: number;
      contextOmittedCount: number;
    };

    assert.equal(created.totalFiles, 4);
    assert.equal(created.contextIncludedCount, 2);
    assert.equal(created.contextOmittedCount, 2);
    assert.ok(created.deleteToken.length >= 20);

    // Fetch public share metadata
    const metaRes = await fetch(`${srv.baseUrl}/api/shares/${created.shareId}`);
    assert.equal(metaRes.status, 200);
    assert.match(metaRes.headers.get('x-robots-tag') || '', /noindex/);
    const meta = (await metaRes.json()) as {
      deleteTokenHash?: string;
      files: Array<{ id: string; relativePath: string; isText: boolean; isActiveContent: boolean }>;
    };
    assert.equal(meta.deleteTokenHash, undefined, 'deleteTokenHash must never be exposed');
    assert.equal(meta.files.some((f) => f.relativePath.includes('inner-secret.txt')), false);

    // Verify context.md and manifest.json
    const ctxRes = await fetch(`${srv.baseUrl}/s/${created.shareId}/context.md`);
    assert.equal(ctxRes.status, 200);
    assert.match(ctxRes.headers.get('x-content-type-options') || '', /nosniff/);
    const ctxText = await ctxRes.text();
    assert.match(ctxText, /### src\/app\.ts/);
    assert.match(ctxText, /### public\/xss\.html/);
    assert.match(ctxText, /`assets\/logo\.png`/);
    assert.match(ctxText, /`nested\.zip` \([^)]+\) — nested archive \(not extracted\)/);

    const manifestRes = await fetch(`${srv.baseUrl}/s/${created.shareId}/manifest.json`);
    assert.equal(manifestRes.status, 200);
    const manifest = (await manifestRes.json()) as { totalFiles: number };
    assert.equal(manifest.totalFiles, 4);

    // Verify active HTML file is served safely as attachment download + sandbox CSP, and previewed via JSON text
    const xssEntry = meta.files.find((f) => f.relativePath === 'public/xss.html');
    assert(xssEntry);
    assert.equal(xssEntry.isActiveContent, true);

    const downloadRes = await fetch(`${srv.baseUrl}/s/${created.shareId}/files/${xssEntry.id}`);
    assert.equal(downloadRes.status, 200);
    assert.equal(downloadRes.headers.get('content-type'), 'application/octet-stream');
    assert.match(downloadRes.headers.get('content-disposition') || '', /^attachment;/);
    assert.match(downloadRes.headers.get('content-security-policy') || '', /sandbox/);
    assert.equal(downloadRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await downloadRes.text(), xssHtml);

    const previewRes = await fetch(
      `${srv.baseUrl}/api/shares/${created.shareId}/files/${xssEntry.id}/preview`,
    );
    assert.equal(previewRes.status, 200);
    assert.match(previewRes.headers.get('content-type') || '', /application\/json/);
    const previewJson = (await previewRes.json()) as { content: string };
    assert.equal(previewJson.content, xssHtml);
  } finally {
    await srv.close();
  }
});

test('Malformed ZIP is rejected with 400', async () => {
  const srv = await startTestServer();
  try {
    const corrupt = strToU8('not-a-zip-file-at-all-1234567890');
    const res = await uploadZip(srv.baseUrl, corrupt, 'corrupt.zip');
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /valid|ZIP/i);
  } finally {
    await srv.close();
  }
});

test('Path traversal ZIP entry is rejected with 400 and nothing is stored', async () => {
  const srv = await startTestServer();
  try {
    const cleanZip = zipSync({ 'aa/bb/evil.txt': strToU8('pwned') });
    const traversalZip = replaceAsciiInBuffer(cleanZip, 'aa/bb/evil.txt', '../../evil.txt');

    const res = await uploadZip(srv.baseUrl, traversalZip, 'traversal.zip');
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /traversal/i);

    const shareFiles = await fs.readdir(path.join(srv.dataDir, 'shares'));
    assert.equal(shareFiles.length, 0);
  } finally {
    await srv.close();
  }
});

test('Symlink and encrypted ZIP entries are rejected with 400', async () => {
  const srv = await startTestServer();
  try {
    // 1. Unix symlink entry: set Central Directory externalFileAttributes upper 16 bits to S_IFLNK (0o120777)
    const symlinkZip = zipSync({ 'link.txt': strToU8('/etc/passwd') });
    const view1 = new DataView(symlinkZip.buffer, symlinkZip.byteOffset, symlinkZip.byteLength);
    // Find Central Directory signature 0x02014b50
    for (let i = 0; i <= symlinkZip.length - 46; i++) {
      if (view1.getUint32(i, true) === 0x02014b50) {
        // Set versionMadeBy high byte to Unix (3) and externalFileAttributes to S_IFLNK
        view1.setUint16(i + 4, (3 << 8) | 20, true);
        view1.setUint32(i + 38, (0o120777 << 16) >>> 0, true);
      }
    }
    const symRes = await uploadZip(srv.baseUrl, symlinkZip, 'symlink.zip');
    assert.equal(symRes.status, 400);
    const symBody = (await symRes.json()) as { error: string };
    assert.match(symBody.error, /symbolic link/i);

    // 2. Encrypted entry: set bit 0 of generalPurposeBitFlag (offset +6 in LFH, +8 in CD)
    const encZip = zipSync({ 'secret.txt': strToU8('cipher') });
    const view2 = new DataView(encZip.buffer, encZip.byteOffset, encZip.byteLength);
    for (let i = 0; i <= encZip.length - 46; i++) {
      if (view2.getUint32(i, true) === 0x04034b50) {
        view2.setUint16(i + 6, view2.getUint16(i + 6, true) | 0x01, true);
      }
      if (view2.getUint32(i, true) === 0x02014b50) {
        view2.setUint16(i + 8, view2.getUint16(i + 8, true) | 0x01, true);
      }
    }
    const encRes = await uploadZip(srv.baseUrl, encZip, 'encrypted.zip');
    assert.equal(encRes.status, 400);
    const encBody = (await encRes.json()) as { error: string };
    assert.match(encBody.error, /encrypted/i);
  } finally {
    await srv.close();
  }
});

test('Compressed size, extracted size, and entry count limits are enforced', async () => {
  const srv = await startTestServer({
    maxCompressedBytes: 2048,
    maxExtractedBytes: 4096,
    maxEntryCount: 3,
  });
  try {
    // 1. Entry count > 3
    const tooManyEntries = zipSync({
      'a.txt': strToU8('1'),
      'b.txt': strToU8('2'),
      'c.txt': strToU8('3'),
      'd.txt': strToU8('4'),
    });
    const countRes = await uploadZip(srv.baseUrl, tooManyEntries, 'many.zip');
    assert.equal(countRes.status, 413);

    // 2. Highly compressible content exceeding maxExtractedBytes (4096) while compressed < 2048
    const zipBombLike = zipSync({
      'big.txt': strToU8('A'.repeat(16384)),
    });
    assert.ok(zipBombLike.length < 2048);
    const extractRes = await uploadZip(srv.baseUrl, zipBombLike, 'bomb.zip');
    assert.equal(extractRes.status, 413);

    // 3. Compressed upload > maxCompressedBytes (2048)
    const incompressible = new Uint8Array(3000);
    for (let i = 0; i < incompressible.length; i++) {
      incompressible[i] = (i * 73 + 19) & 0xff;
    }
    const oversizedCompressed = zipSync({ 'random.bin': incompressible }, { level: 0 });
    assert.ok(oversizedCompressed.length > 2048);
    const uploadRes = await uploadZip(srv.baseUrl, oversizedCompressed, 'large.zip');
    assert.equal(uploadRes.status, 413);
  } finally {
    await srv.close();
  }
});

test('Expiry enforcement and scheduled cleanup remove expired shares from storage', async () => {
  const srv = await startTestServer();
  try {
    const startMs = Date.UTC(2026, 10, 21, 12, 0, 0);
    srv.setNow(startMs);

    const archive = zipSync({ 'hello.txt': strToU8('temporary content') });
    const res = await uploadZip(srv.baseUrl, archive, 'expiring.zip', '24h');
    assert.equal(res.status, 201);
    const created = (await res.json()) as { shareId: string };

    // Still accessible at +23h
    srv.setNow(startMs + 23 * 60 * 60 * 1000);
    const okRes = await fetch(`${srv.baseUrl}/api/shares/${created.shareId}`);
    assert.equal(okRes.status, 200);

    // Advance past 24h -> purgeExpired deletes it and access returns 404/410
    srv.setNow(startMs + 25 * 60 * 60 * 1000);
    const purgedCount = await srv.purgeExpired();
    assert.equal(purgedCount, 1);

    const goneRes = await fetch(`${srv.baseUrl}/api/shares/${created.shareId}`);
    assert.equal(goneRes.status, 404);

    const blobDirs = await fs.readdir(path.join(srv.dataDir, 'blobs'));
    assert.equal(blobDirs.length, 0);
  } finally {
    await srv.close();
  }
});

test('Deletion requires valid token and immediately stops share links from working', async () => {
  const srv = await startTestServer();
  try {
    const archive = zipSync({ 'notes.txt': strToU8('delete me soon') });
    const res = await uploadZip(srv.baseUrl, archive, 'delete-test.zip', '7d');
    assert.equal(res.status, 201);
    const created = (await res.json()) as { shareId: string; deleteToken: string };

    // Missing token -> 401
    const noTokRes = await fetch(`${srv.baseUrl}/api/shares/${created.shareId}`, {
      method: 'DELETE',
    });
    assert.equal(noTokRes.status, 401);

    // Wrong token -> 403
    const badTokRes = await fetch(`${srv.baseUrl}/api/shares/${created.shareId}`, {
      method: 'DELETE',
      headers: { 'X-Delete-Token': 'wrong-token-value-1234567890' },
    });
    assert.equal(badTokRes.status, 403);

    // Valid token -> 200 and share disappears
    const delRes = await fetch(`${srv.baseUrl}/api/shares/${created.shareId}`, {
      method: 'DELETE',
      headers: { 'X-Delete-Token': created.deleteToken },
    });
    assert.equal(delRes.status, 200);

    const afterShare = await fetch(`${srv.baseUrl}/api/shares/${created.shareId}`);
    assert.equal(afterShare.status, 404);

    const afterContext = await fetch(`${srv.baseUrl}/s/${created.shareId}/context.md`);
    assert.equal(afterContext.status, 404);
  } finally {
    await srv.close();
  }
});
