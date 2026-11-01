/**
 * Print one version's section of `CHANGELOG.md`, for a GitHub release page.
 *
 * `release.yml` runs this on a tag push, so the release body is the same text a
 * reader finds in the changelog — one place to write it, and the Chinese notes
 * we actually author stay Chinese instead of being regenerated into English by
 * `gh release create --generate-notes`.
 *
 *     node scripts/dev/release-notes.mjs 0.2.4
 * @module dsh-context-rescue/scripts/dev/release-notes
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The body for `version`, or a pointer to the changelog when the section is
 * missing (a release page with a wrong body is worse than one with a link).
 *
 * @param {string} text - the whole changelog
 * @param {string} version - e.g. `0.2.4`; a leading `v` is tolerated
 * @returns {string}
 */
export function notesFor(text, version) {
  const wanted = String(version).replace(/^v/u, '');
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const heading = new RegExp(`^##\\s+(?:\\[)?v?${escaped}(?:\\])?(?:\\s|$)`, 'u');
  const lines = String(text).split(/\r?\n/u);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    return `本版内容见 [CHANGELOG.md](CHANGELOG.md) 的 ${wanted} 一节。`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body === '' ? `本版内容见 [CHANGELOG.md](CHANGELOG.md) 的 ${wanted} 一节。` : `${body}\n`;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, '/')}`).href;

if (invokedDirectly) {
  const version = process.argv[2];
  if (version === undefined) {
    process.stderr.write('usage: node scripts/dev/release-notes.mjs <version>\n');
    process.exit(2);
  }
  const changelog = readFileSync(join(import.meta.dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
  process.stdout.write(notesFor(changelog, version));
}
