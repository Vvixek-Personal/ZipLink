import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import {
  classifyTextContent,
  detectSensitiveFilenames,
  isActiveWebContent,
  sanitizeContentDispositionFilename,
  validateArchiveEntryPath,
} from '../src/shared/zipSecurity.ts';
import { buildContextMarkdown, buildManifestJson } from '../src/shared/contextBuilder.ts';
import { inspectZipCentralDirectoryNames } from '../src/shared/zipInspect.ts';

test('validateArchiveEntryPath accepts safe relative paths and rejects traversal/absolute/unsafe paths', () => {
  assert.deepEqual(validateArchiveEntryPath('src/index.ts'), {
    valid: true,
    normalizedPath: 'src/index.ts',
    isDirectory: false,
  });

  assert.deepEqual(validateArchiveEntryPath('src/utils/'), {
    valid: true,
    normalizedPath: 'src/utils',
    isDirectory: true,
  });

  // Path traversal
  assert.equal(validateArchiveEntryPath('../secret.txt').valid, false);
  assert.equal(validateArchiveEntryPath('src/../../etc/passwd').valid, false);
  assert.equal(validateArchiveEntryPath('..\\..\\secret.txt').valid, false);

  // Absolute & drive-letter paths
  assert.equal(validateArchiveEntryPath('/etc/passwd').valid, false);
  assert.equal(validateArchiveEntryPath('C:\\Windows\\win.ini').valid, false);

  // Null byte, control char, reserved name, excessive length
  assert.equal(validateArchiveEntryPath('file\0.txt').valid, false);
  assert.equal(validateArchiveEntryPath('CON.txt').valid, false);
  assert.equal(validateArchiveEntryPath('a'.repeat(250)).valid, false);
});

test('detectSensitiveFilenames flags likely secrets while allowing .env.example', () => {
  const warnings = detectSensitiveFilenames([
    'README.md',
    '.env.example',
    '.env',
    '.env.production',
    'keys/id_rsa',
    'certs/server.pem',
    'config/credentials.json',
    'src/app.ts',
  ]);

  const flaggedPaths = warnings.map((w) => w.relativePath);
  assert.deepEqual(flaggedPaths, [
    '.env',
    '.env.production',
    'keys/id_rsa',
    'certs/server.pem',
    'config/credentials.json',
  ]);
});

test('classifyTextContent distinguishes UTF-8 text from binary and nested archives', () => {
  assert.deepEqual(classifyTextContent('src/main.ts', strToU8('console.log("hi");\n')), {
    isText: true,
    reason: null,
  });
  assert.equal(classifyTextContent('image.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])).isText, false);
  assert.equal(classifyTextContent('data.dat', new Uint8Array([0x41, 0x00, 0x42])).isText, false);
  assert.equal(classifyTextContent('inner.zip', strToU8('PK')).isText, false);
  assert.equal(isActiveWebContent('public/widget.html'), true);
  assert.equal(isActiveWebContent('icon.svg'), true);
  assert.equal(isActiveWebContent('README.md'), false);
});

test('sanitizeContentDispositionFilename prevents header injection', () => {
  const safe = sanitizeContentDispositionFilename('dir/evil"\r\nX-Injected: 1.html');
  assert.equal(safe.asciiFallback.includes('\r'), false);
  assert.equal(safe.asciiFallback.includes('\n'), false);
  assert.equal(safe.asciiFallback.includes('"'), false);
});

test('inspectZipCentralDirectoryNames lists entry names without decompressing', () => {
  const archive = zipSync({
    'project/README.md': strToU8('# Hello'),
    'project/.env': strToU8('API_KEY=123'),
  });
  const parsed = inspectZipCentralDirectoryNames(archive);
  assert.equal(parsed.validZipStructure, true);
  assert.deepEqual(parsed.entryNames.sort(), ['project/.env', 'project/README.md']);
});

test('buildContextMarkdown escapes code fences, enforces size limits, and lists omitted files', () => {
  const result = buildContextMarkdown({
    shareId: 'share12345',
    archiveName: 'demo.zip',
    createdAt: '2026-11-21T00:00:00.000Z',
    expiresAt: '2026-11-28T00:00:00.000Z',
    maxContextBytes: 24 * 1024,
    entries: [
      {
        file: {
          id: 'f1',
          relativePath: 'README.md',
          sizeBytes: 30,
          sha256: 'abc',
          isText: true,
          isActiveContent: false,
          includedInContextMd: false,
          omissionReason: null,
        },
        textContent: 'Hello\n```ts\nconsole.log(1)\n```',
      },
      {
        file: {
          id: 'f2',
          relativePath: 'logo.png',
          sizeBytes: 1200,
          sha256: 'def',
          isText: false,
          isActiveContent: false,
          includedInContextMd: false,
          omissionReason: 'binary file',
        },
        textContent: null,
      },
      {
        file: {
          id: 'f3',
          relativePath: 'huge.txt',
          sizeBytes: 50000,
          sha256: 'ghi',
          isText: true,
          isActiveContent: false,
          includedInContextMd: false,
          omissionReason: null,
        },
        textContent: 'A'.repeat(30000),
      },
    ],
  });

  assert.equal(result.includedCount, 1);
  assert.equal(result.omittedCount, 2);
  assert.match(result.contextMd, /````markdown/);
  assert.match(result.contextMd, /### README\.md/);
  assert.match(result.contextMd, /## Omitted Files \(2\)/);
  assert.match(result.contextMd, /`logo\.png`.*binary file/);
  assert.match(result.contextMd, /`huge\.txt`.*exceeded context\.md size limit/);

  const manifest = JSON.parse(
    buildManifestJson({
      shareId: 'share12345',
      archiveName: 'demo.zip',
      createdAt: '2026-11-21T00:00:00.000Z',
      expiresAt: '2026-11-28T00:00:00.000Z',
      totalExtractedBytes: 51230,
      sensitiveWarnings: [],
      files: result.updatedFiles,
    }),
  );
  assert.equal(manifest.totalFiles, 3);
  assert.equal(manifest.contextIncludedCount, 1);
  assert.equal(manifest.contextOmittedCount, 2);
});
