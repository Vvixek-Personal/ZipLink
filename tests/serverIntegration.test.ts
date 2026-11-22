import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
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
      editToken: string;
      editUrl: string;
      totalFiles: number;
      contextIncludedCount: number;
      contextOmittedCount: number;
    };

    assert.equal(created.totalFiles, 4);
    assert.equal(created.contextIncludedCount, 2);
    assert.equal(created.contextOmittedCount, 2);
    assert.ok(created.deleteToken.length >= 20);
    assert.ok(created.editToken.length >= 20);
    assert.notEqual(created.editToken, created.deleteToken);
    assert.ok(created.editUrl.includes(`#edit=${encodeURIComponent(created.editToken)}`));

    // Fetch public share metadata
    const metaRes = await fetch(`${srv.baseUrl}/api/shares/${created.shareId}`);
    assert.equal(metaRes.status, 200);
    assert.match(metaRes.headers.get('x-robots-tag') || '', /noindex/);
    const meta = (await metaRes.json()) as {
      deleteTokenHash?: string;
      editTokenHash?: string;
      files: Array<{ id: string; relativePath: string; isText: boolean; isActiveContent: boolean }>;
    };
    assert.equal(meta.deleteTokenHash, undefined, 'deleteTokenHash must never be exposed');
    assert.equal(meta.editTokenHash, undefined, 'editTokenHash must never be exposed');
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

test('Owner editing enforces edit token auth, persists saves across reloads, updates context.md/manifest.json, detects conflicts, downloads edited file/ZIP, and restores original', async () => {
  const srv = await startTestServer();
  try {
    const originalTs = 'export const version = 1;\n';
    const originalHtml = '<div><script>alert("initial")</script></div>\n';
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const archive = zipSync({
      'src/index.ts': strToU8(originalTs),
      'public/page.html': strToU8(originalHtml),
      'assets/icon.png': pngBytes,
    });

    const uploadRes = await uploadZip(srv.baseUrl, archive, 'editable.zip', '7d');
    assert.equal(uploadRes.status, 201);
    const created = (await uploadRes.json()) as {
      shareId: string;
      editToken: string;
      deleteToken: string;
    };

    const metaRes = await fetch(`${srv.baseUrl}/api/shares/${created.shareId}`);
    const meta = (await metaRes.json()) as {
      files: Array<{
        id: string;
        relativePath: string;
        sha256: string;
        originalSha256: string;
        version: number;
        isEdited: boolean;
      }>;
    };

    const tsFile = meta.files.find((f) => f.relativePath === 'src/index.ts')!;
    const htmlFile = meta.files.find((f) => f.relativePath === 'public/page.html')!;
    const pngFile = meta.files.find((f) => f.relativePath === 'assets/icon.png')!;

    // 1. Unauthorized edit attempts (missing token -> 401; shareId or deleteToken -> 403)
    const noAuthPut = await fetch(`${srv.baseUrl}/api/shares/${created.shareId}/files/${tsFile.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hacked' }),
    });
    assert.equal(noAuthPut.status, 401);

    const shareIdAsTokenPut = await fetch(
      `${srv.baseUrl}/api/shares/${created.shareId}/files/${tsFile.id}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${created.shareId}`,
        },
        body: JSON.stringify({ content: 'hacked' }),
      },
    );
    assert.equal(shareIdAsTokenPut.status, 403);

    const deleteTokenAsEditPut = await fetch(
      `${srv.baseUrl}/api/shares/${created.shareId}/files/${tsFile.id}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${created.deleteToken}`,
        },
        body: JSON.stringify({ content: 'hacked' }),
      },
    );
    assert.equal(deleteTokenAsEditPut.status, 403);

    // Binary file edit is rejected even with valid edit token
    const binaryEditRes = await fetch(
      `${srv.baseUrl}/api/shares/${created.shareId}/files/${pngFile.id}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${created.editToken}`,
        },
        body: JSON.stringify({ content: 'not binary' }),
      },
    );
    assert.equal(binaryEditRes.status, 415);

    // 2. Authorized edit succeeds and increments version
    const editedTsV2 = 'export const version = 2;\nexport const edited = true;\n';
    const saveRes = await fetch(`${srv.baseUrl}/api/shares/${created.shareId}/files/${tsFile.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${created.editToken}`,
      },
      body: JSON.stringify({
        content: editedTsV2,
        expectedSha256: tsFile.sha256,
        expectedVersion: tsFile.version,
      }),
    });
    assert.equal(saveRes.status, 200);
    const savedPayload = (await saveRes.json()) as {
      file: { sha256: string; originalSha256: string; version: number; isEdited: boolean };
      content: string;
    };
    assert.equal(savedPayload.content, editedTsV2);
    assert.equal(savedPayload.file.version, 2);
    assert.equal(savedPayload.file.isEdited, true);
    assert.equal(savedPayload.file.originalSha256, tsFile.originalSha256);

    // 3. Re-fetching preview (simulating refresh/reopen) returns persisted edited content
    const previewAfterSave = await fetch(
      `${srv.baseUrl}/api/shares/${created.shareId}/files/${tsFile.id}/preview`,
    );
    assert.equal(previewAfterSave.status, 200);
    const previewJson = (await previewAfterSave.json()) as { content: string; version: number };
    assert.equal(previewJson.content, editedTsV2);
    assert.equal(previewJson.version, 2);

    // context.md and manifest.json reflect the saved edit
    const updatedContext = await (
      await fetch(`${srv.baseUrl}/s/${created.shareId}/context.md`)
    ).text();
    assert.ok(updatedContext.includes('export const version = 2;'));
    const updatedManifest = (await (
      await fetch(`${srv.baseUrl}/s/${created.shareId}/manifest.json`)
    ).json()) as { files: Array<{ relativePath: string; isEdited: boolean; version: number }> };
    const tsManifest = updatedManifest.files.find((f) => f.relativePath === 'src/index.ts')!;
    assert.equal(tsManifest.isEdited, true);
    assert.equal(tsManifest.version, 2);

    // 4. Conflicting save using stale sha256/version returns 409 Conflict without overwriting
    const conflictRes = await fetch(
      `${srv.baseUrl}/api/shares/${created.shareId}/files/${tsFile.id}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${created.editToken}`,
        },
        body: JSON.stringify({
          content: 'stale overwrite attempt',
          expectedSha256: tsFile.sha256,
          expectedVersion: tsFile.version,
        }),
      },
    );
    assert.equal(conflictRes.status, 409);
    const conflictBody = (await conflictRes.json()) as {
      conflict: boolean;
      currentVersion: number;
      currentSha256: string;
      currentContent: string;
    };
    assert.equal(conflictBody.conflict, true);
    assert.equal(conflictBody.currentVersion, 2);
    assert.equal(conflictBody.currentSha256, savedPayload.file.sha256);
    assert.equal(conflictBody.currentContent, editedTsV2);

    // 5. Edited HTML remains safely escaped/sandboxed on preview & download
    const editedHtml = '<section><script>alert("edited-xss")</script></section>\n';
    const saveHtmlRes = await fetch(
      `${srv.baseUrl}/api/shares/${created.shareId}/files/${htmlFile.id}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${created.editToken}`,
        },
        body: JSON.stringify({
          content: editedHtml,
          expectedSha256: htmlFile.sha256,
          expectedVersion: htmlFile.version,
        }),
      },
    );
    assert.equal(saveHtmlRes.status, 200);

    const dlEditedHtml = await fetch(`${srv.baseUrl}/s/${created.shareId}/files/${htmlFile.id}`);
    assert.equal(dlEditedHtml.headers.get('content-type'), 'application/octet-stream');
    assert.match(dlEditedHtml.headers.get('content-security-policy') || '', /sandbox/);
    assert.equal(await dlEditedHtml.text(), editedHtml);

    // 6. Download edited single file & download edited ZIP
    const dlEditedTs = await fetch(`${srv.baseUrl}/s/${created.shareId}/files/${tsFile.id}`);
    assert.equal(dlEditedTs.status, 200);
    assert.equal(await dlEditedTs.text(), editedTsV2);

    const zipDownloadRes = await fetch(`${srv.baseUrl}/s/${created.shareId}/download.zip`);
    assert.equal(zipDownloadRes.status, 200);
    assert.equal(zipDownloadRes.headers.get('content-type'), 'application/zip');
    assert.match(zipDownloadRes.headers.get('content-disposition') || '', /editable-edited\.zip/);
    const downloadedZipBytes = new Uint8Array(await zipDownloadRes.arrayBuffer());
    const unpacked = unzipSync(downloadedZipBytes);
    assert.equal(strFromU8(unpacked['src/index.ts']), editedTsV2);
    assert.equal(strFromU8(unpacked['public/page.html']), editedHtml);
    assert.deepEqual(unpacked['assets/icon.png'], pngBytes);

    // 7. Original content endpoint still returns initial uploaded file, and Restore Original works
    const origFetch = await fetch(
      `${srv.baseUrl}/api/shares/${created.shareId}/files/${tsFile.id}/original`,
    );
    assert.equal(origFetch.status, 200);
    const origPayload = (await origFetch.json()) as { content: string; sha256: string };
    assert.equal(origPayload.content, originalTs);
    assert.equal(origPayload.sha256, tsFile.originalSha256);

    // Unauthorized restore -> 401
    const unauthRestore = await fetch(
      `${srv.baseUrl}/api/shares/${created.shareId}/files/${tsFile.id}/restore`,
      { method: 'POST' },
    );
    assert.equal(unauthRestore.status, 401);

    // Authorized restore -> 200, restores original content & resets isEdited = false
    const restoreRes = await fetch(
      `${srv.baseUrl}/api/shares/${created.shareId}/files/${tsFile.id}/restore`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${created.editToken}`,
        },
        body: JSON.stringify({
          expectedSha256: savedPayload.file.sha256,
          expectedVersion: savedPayload.file.version,
        }),
      },
    );
    assert.equal(restoreRes.status, 200);
    const restoredPayload = (await restoreRes.json()) as {
      file: { isEdited: boolean; sha256: string; version: number };
      content: string;
    };
    assert.equal(restoredPayload.content, originalTs);
    assert.equal(restoredPayload.file.isEdited, false);
    assert.equal(restoredPayload.file.sha256, tsFile.originalSha256);
    assert.equal(restoredPayload.file.version, 3);
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
    const symlinkZip = zipSync({ 'link.txt': strToU8('/etc/passwd') });
    const view1 = new DataView(symlinkZip.buffer, symlinkZip.byteOffset, symlinkZip.byteLength);
    for (let i = 0; i <= symlinkZip.length - 46; i++) {
      if (view1.getUint32(i, true) === 0x02014b50) {
        view1.setUint16(i + 4, (3 << 8) | 20, true);
        view1.setUint32(i + 38, (0o120777 << 16) >>> 0, true);
      }
    }
    const symRes = await uploadZip(srv.baseUrl, symlinkZip, 'symlink.zip');
    assert.equal(symRes.status, 400);
    const symBody = (await symRes.json()) as { error: string };
    assert.match(symBody.error, /symbolic link/i);

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
    const tooManyEntries = zipSync({
      'a.txt': strToU8('1'),
      'b.txt': strToU8('2'),
      'c.txt': strToU8('3'),
      'd.txt': strToU8('4'),
    });
    const countRes = await uploadZip(srv.baseUrl, tooManyEntries, 'many.zip');
    assert.equal(countRes.status, 413);

    const zipBombLike = zipSync({
      'big.txt': strToU8('A'.repeat(16384)),
    });
    assert.ok(zipBombLike.length < 2048);
    const extractRes = await uploadZip(srv.baseUrl, zipBombLike, 'bomb.zip');
    assert.equal(extractRes.status, 413);

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

test('Expiry enforcement and scheduled cleanup remove expired shares, edits, and originals from storage', async () => {
  const srv = await startTestServer();
  try {
    const startMs = Date.UTC(2026, 10, 21, 12, 0, 0);
    srv.setNow(startMs);

    const archive = zipSync({ 'hello.txt': strToU8('temporary content') });
    const res = await uploadZip(srv.baseUrl, archive, 'expiring.zip', '24h');
    assert.equal(res.status, 201);
    const created = (await res.json()) as { shareId: string; editToken: string };

    // Perform an edit so originals/ directory is created too
    const meta = (await (
      await fetch(`${srv.baseUrl}/api/shares/${created.shareId}`)
    ).json()) as { files: Array<{ id: string }> };
    const editRes = await fetch(
      `${srv.baseUrl}/api/shares/${created.shareId}/files/${meta.files[0].id}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${created.editToken}`,
        },
        body: JSON.stringify({ content: 'edited temporary content' }),
      },
    );
    assert.equal(editRes.status, 200);

    // Still accessible at +23h
    srv.setNow(startMs + 23 * 60 * 60 * 1000);
    const okRes = await fetch(`${srv.baseUrl}/api/shares/${created.shareId}`);
    assert.equal(okRes.status, 200);

    // Advance past 24h -> purgeExpired deletes share, edits, and originals
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

    const noTokRes = await fetch(`${srv.baseUrl}/api/shares/${created.shareId}`, {
      method: 'DELETE',
    });
    assert.equal(noTokRes.status, 401);

    const badTokRes = await fetch(`${srv.baseUrl}/api/shares/${created.shareId}`, {
      method: 'DELETE',
      headers: { 'X-Delete-Token': 'wrong-token-value-1234567890' },
    });
    assert.equal(badTokRes.status, 403);

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
