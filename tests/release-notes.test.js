/**
 * The release body comes from the changelog, so these pin the extraction rather than trusting a
 * regular expression that "looked right": the right section, its boundary, the `v` prefix a tag
 * carries, and the honest fallback when the section is not there.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { notesFor } from '../scripts/dev/release-notes.mjs';

const CHANGELOG = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  '- 还没发的东西',
  '',
  '## 0.2.4 — 2026-10-31',
  '',
  '### 修复',
  '',
  '- 第一行',
  '- 第二行',
  '',
  '## 0.2.3 — 2026-10-31',
  '',
  '- 更早的一版',
  '',
].join('\n');

test('the body is the section, without its heading and without the next version', () => {
  const body = notesFor(CHANGELOG, '0.2.4');
  assert.match(body, /### 修复/u);
  assert.match(body, /第一行/u);
  assert.match(body, /第二行/u);
  assert.doesNotMatch(body, /0\.2\.4/u, 'the heading is not part of the body');
  assert.doesNotMatch(body, /更早的一版/u, 'the next version is not part of the body');
});

test('a leading v from a tag name is tolerated', () => {
  assert.equal(notesFor(CHANGELOG, 'v0.2.3'), '- 更早的一版\n');
});

test('dots are literal, so 0.2.4 does not match 0x2x4', () => {
  assert.match(notesFor(CHANGELOG, '0x2x4'), /CHANGELOG\.md/u);
});

test('a version with no section points at the changelog instead of inventing a body', () => {
  assert.equal(notesFor(CHANGELOG, '9.9.9'), '本版内容见 [CHANGELOG.md](CHANGELOG.md) 的 9.9.9 一节。');
});

test('a heading with no content under it also points at the changelog', () => {
  const text = '# Changelog\n\n## 1.0.0 — 2026-01-01\n\n## 1.0.1\n\n- next\n';
  assert.equal(notesFor(text, '1.0.0'), '本版内容见 [CHANGELOG.md](CHANGELOG.md) 的 1.0.0 一节。');
});

test('the real changelog yields the 0.2.4 section', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const body = notesFor(text, '0.2.4');
  assert.match(body, /### Fixed/u);
  assert.match(body, /debug/u);
  assert.doesNotMatch(body, /## 0\.2\.3/u);
});
