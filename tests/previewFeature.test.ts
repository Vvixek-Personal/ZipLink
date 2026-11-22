import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { createZipLinkApp } from '../src/server/app.ts';
import {
  classifyPreviewAsset,
  detectHtmlEntryPoints,
  prepareHtmlForSandboxedPreview,
  validateArchiveEntryPath,
} from '../src/shared/zipSecurity.ts';

interface StartedPreviewServer {
  baseUrl: string;
  dataDir: string;
  previewDir: string;
  setNow: (ms: number) => void;
  purgeExpiredPreviews: () => Promise<number>;
  close: () => Promise<void>;
}

async function startPreviewServer(
  configOverrides: Record<string, unknown> = {},
): Promise<StartedPreviewServer> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ziplink-prev-data-'));
  const previewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ziplink-prev-store-'));
  let currentNow = Date.UTC(2026, 10, 22, 10, 0, 0);

  const { app, previewStore } = await createZipLinkApp({
    config: { dataDir, previewDir, ...configOverrides },
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
    previewDir,
    setNow: (ms: number) => {
      currentNow = ms;
    },
    purgeExpiredPreviews: () => previewStore.purgeExpiredPreviews(currentNow),
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(previewDir, { recursive: true, force: true });
    },
  };
}

async function uploadPreviewZip(
  baseUrl: string,
  zipBytes: Uint8Array,
  filename = 'site.zip',
): Promise<globalThis.Response> {
  const form = new FormData();
  form.append('archive', new Blob([Buffer.from(zipBytes)], { type: 'application/zip' }), filename);
  return fetch(`${baseUrl}/api/previews`, { method: 'POST', body: form });
}

function replaceAsciiInBuffer(buf: Uint8Array, search: string, replace: string): Uint8Array {
  assert.equal(search.length, replace.length);
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

test('detectHtmlEntryPoints prioritizes root, wrapper, and build output directories accurately', () => {
  const rootFirst = detectHtmlEntryPoints([
    'docs/guide.html',
    'dist/index.html',
    'index.html',
    'styles.css',
  ]);
  assert.equal(rootFirst[0].relativePath, 'index.html');
  assert.equal(rootFirst[0].siteRoot, '');

  const wrappedDist = detectHtmlEntryPoints([
    'my-site/README.md',
    'my-site/dist/index.html',
    'my-site/dist/about.html',
  ]);
  assert.equal(wrappedDist[0].relativePath, 'my-site/dist/index.html');
  assert.equal(wrappedDist[0].siteRoot, 'my-site/dist');

  const multiOutput = detectHtmlEntryPoints([
    'build/index.html',
    'public/other.html',
    'src/template.html',
  ]);
  assert.equal(multiOutput[0].relativePath, 'build/index.html');
  assert.equal(multiOutput.length, 3);

  assert.deepEqual(detectHtmlEntryPoints(['src/index.ts', 'package.json']), []);
});

test('classifyPreviewAsset allows static web assets and blocks unsafe executables or server scripts', () => {
  const html = classifyPreviewAsset('dist/index.html');
  assert.equal(html.isHtml, true);
  assert.equal(html.blockedInPreview, false);
  assert.match(html.mimeType, /text\/html/);

  const css = classifyPreviewAsset('assets/styles.css');
  assert.equal(css.blockedInPreview, false);
  assert.match(css.mimeType, /text\/css/);

  const js = classifyPreviewAsset('assets/app.js');
  assert.equal(js.blockedInPreview, false);
  assert.match(js.mimeType, /javascript/);

  for (const unsafe of ['run.sh', 'payload.exe', 'index.php', 'server.py', 'setup.bat']) {
    const res = classifyPreviewAsset(unsafe);
    assert.equal(res.blockedInPreview, true, `Expected ${unsafe} to be blocked`);
    assert.ok(res.blockReason);
  }
});

test('validateArchiveEntryPath enforces maximum directory depth', () => {
  const okPath = Array.from({ length: 14 }, (_, i) => `d${i}`).concat('index.html').join('/');
  assert.equal(validateArchiveEntryPath(okPath, 15).valid, true);

  const deepPath = Array.from({ length: 15 }, (_, i) => `d${i}`).concat('index.html').join('/');
  const rejected = validateArchiveEntryPath(deepPath, 15);
  assert.equal(rejected.valid, false);
  assert.match(rejected.reason || '', /depth/i);
});

test('prepareHtmlForSandboxedPreview rewrites matching root-relative URLs and injects nav reporter', () => {
  const html =
    '<!doctype html><html><head><link rel="stylesheet" href="/assets/site.css"><script src="https://cdn.example.com/lib.js"></script></head><body><a href="/about.html">About</a><a href="/api/limits">API</a></body></html>';
  const prepared = prepareHtmlForSandboxedPreview({
    html,
    siteRoot: 'dist',
    siteBasePath: '/p/prev1/tok1/site',
    knownPaths: new Set(['dist/index.html', 'dist/about.html', 'dist/assets/site.css']),
  });

  assert.match(prepared, /href="\/p\/prev1\/tok1\/site\/dist\/assets\/site\.css"/);
  assert.match(prepared, /href="\/p\/prev1\/tok1\/site\/dist\/about\.html"/);
  assert.match(prepared, /src="https:\/\/cdn\.example\.com\/lib\.js"/);
  assert.match(prepared, /href="\/api\/limits"/);
  assert.match(prepared, /ziplink-preview-nav/);
});

test('Valid static website ZIP uploads, detects dist/index.html, serves sandboxed assets, and blocks unsafe files', async () => {
  const srv = await startPreviewServer();
  try {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const zipBytes = zipSync({
      'dist/index.html': strToU8(
        '<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head><body><h1>Home</h1><a href="/about.html">About</a><script src="./app.js"></script></body></html>',
      ),
      'dist/about.html': strToU8('<!doctype html><html><body><h1>About Page</h1></body></html>'),
      'dist/styles.css': strToU8('body { font-family: sans-serif; color: #111; }'),
      'dist/app.js': strToU8('window.__loaded = true;'),
      'dist/data.json': strToU8('{"ok":true}'),
      'dist/logo.png': pngBytes,
      'scripts/deploy.sh': strToU8('#!/bin/sh\necho hi'),
    });

    const res = await uploadPreviewZip(srv.baseUrl, zipBytes, 'my-static-site.zip');
    assert.equal(res.status, 201);
    const created = (await res.json()) as {
      ownerToken: string;
      preview: {
        previewId: string;
        defaultEntryPoint: string;
        entryPoints: Array<{ relativePath: string }>;
        files: Array<{ relativePath: string; blockedInPreview: boolean }>;
        siteBaseUrl: string;
      };
    };

    assert.equal(created.preview.defaultEntryPoint, 'dist/index.html');
    assert.equal(created.preview.entryPoints.length, 2);
    assert.ok(created.ownerToken.length >= 20);
    const shFile = created.preview.files.find((f) => f.relativePath === 'scripts/deploy.sh');
    assert.equal(shFile?.blockedInPreview, true);

    // Fetch default entry HTML
    const indexRes = await fetch(created.preview.siteBaseUrl);
    assert.equal(indexRes.status, 200);
    assert.match(indexRes.headers.get('content-type') || '', /text\/html/);
    assert.match(indexRes.headers.get('content-security-policy') || '', /sandbox/);
    assert.equal(indexRes.headers.get('x-content-type-options'), 'nosniff');
    assert.match(indexRes.headers.get('x-robots-tag') || '', /noindex/);
    const htmlBody = await indexRes.text();
    assert.match(htmlBody, /<h1>Home<\/h1>/);
    assert.match(htmlBody, /dist\/about\.html/);

    // Fetch CSS, JS, JSON, PNG
    const cssRes = await fetch(`${created.preview.siteBaseUrl}/dist/styles.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type') || '', /text\/css/);
    assert.equal(cssRes.headers.get('access-control-allow-origin'), '*');

    const jsRes = await fetch(`${created.preview.siteBaseUrl}/dist/app.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type') || '', /javascript/);

    const jsonRes = await fetch(`${created.preview.siteBaseUrl}/dist/data.json`);
    assert.equal(jsonRes.status, 200);
    assert.match(jsonRes.headers.get('content-type') || '', /application\/json/);

    const pngRes = await fetch(`${created.preview.siteBaseUrl}/dist/logo.png`);
    assert.equal(pngRes.status, 200);
    assert.equal(pngRes.headers.get('content-type'), 'image/png');

    // Blocked executable script returns 403
    const shRes = await fetch(`${created.preview.siteBaseUrl}/scripts/deploy.sh`);
    assert.equal(shRes.status, 403);

    // Missing asset returns 404 plain text
    const missingRes = await fetch(`${created.preview.siteBaseUrl}/dist/nope.js`);
    assert.equal(missingRes.status, 404);
  } finally {
    await srv.close();
  }
});

test('ZIP without any HTML entry point is rejected with 422 and stores no session', async () => {
  const srv = await startPreviewServer();
  try {
    const noHtmlZip = zipSync({
      'src/main.ts': strToU8('console.log("no html");'),
      'README.md': strToU8('# Docs only'),
    });

    const res = await uploadPreviewZip(srv.baseUrl, noHtmlZip, 'no-html.zip');
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /No HTML entry point/i);

    const stored = await fs.readdir(srv.previewDir);
    assert.equal(stored.length, 0);
  } finally {
    await srv.close();
  }
});

test('Preview endpoint rejects path traversal, excessive directory depth, single-file oversize, ZIP bombs, symlinks, and encrypted ZIPs', async () => {
  const srv = await startPreviewServer({
    maxSingleFileBytes: 2048,
    maxExtractedBytes: 4096,
    maxDirectoryDepth: 4,
  });
  try {
    // 1. Path traversal
    const clean = zipSync({ 'aa/bb/index.html': strToU8('<h1>bad</h1>') });
    const traversal = replaceAsciiInBuffer(clean, 'aa/bb/index.html', '../../index.html');
    const travRes = await uploadPreviewZip(srv.baseUrl, traversal, 'trav.zip');
    assert.equal(travRes.status, 400);

    // 2. Excessive depth (5 segments > maxDirectoryDepth 4)
    const deep = zipSync({ 'a/b/c/d/index.html': strToU8('<h1>deep</h1>') });
    const deepRes = await uploadPreviewZip(srv.baseUrl, deep, 'deep.zip');
    assert.equal(deepRes.status, 400);
    assert.match(((await deepRes.json()) as { error: string }).error, /depth/i);

    // 3. Single file limit (> 2048 bytes)
    const bigFile = zipSync({ 'index.html': strToU8(`<p>${'x'.repeat(3000)}</p>`) });
    const bigRes = await uploadPreviewZip(srv.baseUrl, bigFile, 'big.zip');
    assert.equal(bigRes.status, 413);

    // 4. Symlink
    const symlinkZip = zipSync({ 'index.html': strToU8('/etc/passwd') });
    const view1 = new DataView(symlinkZip.buffer, symlinkZip.byteOffset, symlinkZip.byteLength);
    for (let i = 0; i <= symlinkZip.length - 46; i++) {
      if (view1.getUint32(i, true) === 0x02014b50) {
        view1.setUint16(i + 4, (3 << 8) | 20, true);
        view1.setUint32(i + 38, (0o120777 << 16) >>> 0, true);
      }
    }
    const symRes = await uploadPreviewZip(srv.baseUrl, symlinkZip, 'sym.zip');
    assert.equal(symRes.status, 400);

    // 5. Encrypted
    const encZip = zipSync({ 'index.html': strToU8('<h1>secret</h1>') });
    const view2 = new DataView(encZip.buffer, encZip.byteOffset, encZip.byteLength);
    for (let i = 0; i <= encZip.length - 46; i++) {
      if (view2.getUint32(i, true) === 0x04034b50) {
        view2.setUint16(i + 6, view2.getUint16(i + 6, true) | 0x01, true);
      }
      if (view2.getUint32(i, true) === 0x02014b50) {
        view2.setUint16(i + 8, view2.getUint16(i + 8, true) | 0x01, true);
      }
    }
    const encRes = await uploadPreviewZip(srv.baseUrl, encZip, 'enc.zip');
    assert.equal(encRes.status, 400);

    // 6. Malformed
    const malRes = await uploadPreviewZip(srv.baseUrl, strToU8('not-a-zip'), 'bad.zip');
    assert.equal(malRes.status, 400);
  } finally {
    await srv.close();
  }
});

test('Owner isolation, opaque-origin rejection, manual removal, and expiry cleanup work end-to-end', async () => {
  const srv = await startPreviewServer({ previewTtlMs: 60_000 });
  try {
    const startMs = Date.UTC(2026, 10, 22, 10, 0, 0);
    srv.setNow(startMs);

    const zipBytes = zipSync({ 'index.html': strToU8('<h1>Live Preview</h1>') });
    const res = await uploadPreviewZip(srv.baseUrl, zipBytes, 'site.zip');
    assert.equal(res.status, 201);
    const created = (await res.json()) as {
      ownerToken: string;
      preview: { previewId: string; siteBaseUrl: string };
    };

    // Missing owner token -> 401
    const unauthGet = await fetch(`${srv.baseUrl}/api/previews/${created.preview.previewId}`);
    assert.equal(unauthGet.status, 401);

    // Wrong owner token -> 403
    const wrongGet = await fetch(`${srv.baseUrl}/api/previews/${created.preview.previewId}`, {
      headers: { Authorization: 'Bearer wrong-owner-token-123456' },
    });
    assert.equal(wrongGet.status, 403);

    const wrongDel = await fetch(`${srv.baseUrl}/api/previews/${created.preview.previewId}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer wrong-owner-token-123456' },
    });
    assert.equal(wrongDel.status, 403);

    // Wrong site access token -> 403
    const badSiteRes = await fetch(
      `${srv.baseUrl}/p/${created.preview.previewId}/wrong-site-token/site`,
    );
    assert.equal(badSiteRes.status, 403);

    // Opaque Origin: null blocked from internal APIs
    const nullOriginLimits = await fetch(`${srv.baseUrl}/api/limits`, {
      headers: { Origin: 'null' },
    });
    assert.equal(nullOriginLimits.status, 403);

    // Valid owner can inspect & remove preview
    const okGet = await fetch(`${srv.baseUrl}/api/previews/${created.preview.previewId}`, {
      headers: { Authorization: `Bearer ${created.ownerToken}` },
    });
    assert.equal(okGet.status, 200);

    const okDel = await fetch(`${srv.baseUrl}/api/previews/${created.preview.previewId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${created.ownerToken}` },
    });
    assert.equal(okDel.status, 200);

    // Immediately unavailable on /p and deleted from disk
    const afterDelSite = await fetch(created.preview.siteBaseUrl);
    assert.equal(afterDelSite.status, 404);
    assert.equal((await fs.readdir(srv.previewDir)).length, 0);

    // Second preview expires automatically after TTL
    const res2 = await uploadPreviewZip(srv.baseUrl, zipBytes, 'expiring-site.zip');
    assert.equal(res2.status, 201);
    const created2 = (await res2.json()) as {
      ownerToken: string;
      preview: { previewId: string; siteBaseUrl: string };
    };

    srv.setNow(startMs + 61_000);
    const expiredSite = await fetch(created2.preview.siteBaseUrl);
    assert.equal(expiredSite.status, 410);

    // Third preview gets cleaned up by background purge job
    srv.setNow(startMs + 100_000);
    const res3 = await uploadPreviewZip(srv.baseUrl, zipBytes, 'purge-site.zip');
    assert.equal(res3.status, 201);
    srv.setNow(startMs + 200_000);
    const purged = await srv.purgeExpiredPreviews();
    assert.equal(purged, 1);
    assert.equal((await fs.readdir(srv.previewDir)).length, 0);
  } finally {
    await srv.close();
  }
});
