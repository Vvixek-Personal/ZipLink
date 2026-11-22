import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLineDiff } from '../src/shared/diff.ts';
import { detectLanguageFromPath } from '../src/shared/language.ts';

test('detectLanguageFromPath identifies common code/config extensions and falls back to plaintext', () => {
  assert.equal(detectLanguageFromPath('src/index.ts').id, 'typescript');
  assert.equal(detectLanguageFromPath('src/App.tsx').id, 'tsx');
  assert.equal(detectLanguageFromPath('lib/utils.js').id, 'javascript');
  assert.equal(detectLanguageFromPath('lib/Button.jsx').id, 'jsx');
  assert.equal(detectLanguageFromPath('package.json').id, 'json');
  assert.equal(detectLanguageFromPath('public/index.html').id, 'html');
  assert.equal(detectLanguageFromPath('styles/main.css').id, 'css');
  assert.equal(detectLanguageFromPath('scripts/analyze.py').id, 'python');
  assert.equal(detectLanguageFromPath('README.md').id, 'markdown');
  assert.equal(detectLanguageFromPath('.github/workflows/ci.yml').id, 'yaml');
  assert.equal(detectLanguageFromPath('config/settings.yaml').id, 'yaml');
  assert.equal(detectLanguageFromPath('scripts/deploy.sh').id, 'shell');
  assert.equal(detectLanguageFromPath('assets/icon.svg').id, 'svg');
  assert.equal(detectLanguageFromPath('notes/data.unknownext').id, 'plaintext');
  assert.equal(detectLanguageFromPath('LICENSE').id, 'plaintext');
});

test('computeLineDiff computes accurate unified line numbers and side-by-side rows', () => {
  const original = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'export { a, b, c };'].join(
    '\n',
  );
  const modified = [
    'const a = 1;',
    'const b = 20;',
    'const d = 4;',
    'const c = 3;',
    'export { a, b, c };',
  ].join('\n');

  const diff = computeLineDiff(original, modified);
  assert.equal(diff.hasChanges, true);
  assert.equal(diff.removedCount, 1);
  assert.equal(diff.addedCount, 2);
  assert.equal(diff.unchangedCount, 3);

  assert.deepEqual(
    diff.lines.map((l) => ({
      type: l.type,
      oldLine: l.oldLine,
      newLine: l.newLine,
      text: l.text,
    })),
    [
      { type: 'context', oldLine: 1, newLine: 1, text: 'const a = 1;' },
      { type: 'remove', oldLine: 2, newLine: null, text: 'const b = 2;' },
      { type: 'add', oldLine: null, newLine: 2, text: 'const b = 20;' },
      { type: 'add', oldLine: null, newLine: 3, text: 'const d = 4;' },
      { type: 'context', oldLine: 3, newLine: 4, text: 'const c = 3;' },
      { type: 'context', oldLine: 4, newLine: 5, text: 'export { a, b, c };' },
    ],
  );

  // Side-by-side pairs the removed line 2 with added line 2, and leaves an empty left cell for added line 3
  assert.equal(diff.sideBySide.length, 5);
  assert.equal(diff.sideBySide[1].left.type, 'remove');
  assert.equal(diff.sideBySide[1].left.lineNumber, 2);
  assert.equal(diff.sideBySide[1].right.type, 'add');
  assert.equal(diff.sideBySide[1].right.lineNumber, 2);
  assert.equal(diff.sideBySide[2].left.type, 'empty');
  assert.equal(diff.sideBySide[2].right.type, 'add');
  assert.equal(diff.sideBySide[2].right.lineNumber, 3);
});

test('computeLineDiff handles identical content and empty-to-populated diffs', () => {
  const same = computeLineDiff('hello\nworld', 'hello\nworld');
  assert.equal(same.hasChanges, false);
  assert.equal(same.addedCount, 0);
  assert.equal(same.removedCount, 0);

  const fromEmpty = computeLineDiff('', 'line 1\nline 2');
  assert.equal(fromEmpty.hasChanges, true);
  assert.equal(fromEmpty.addedCount, 2);
  assert.equal(fromEmpty.removedCount, 0);
});
