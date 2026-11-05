/**
 * Host discovery has to work on installations that are not "DSH NEXT".
 *
 * Issue #1's follow-up: another build ships the host packages unpacked under
 * `resources/app/dsh/node_modules/…`, so a root may be a directory rather than an
 * `app.asar`, and a failure that names the candidates it tried is the difference
 * between a two-minute fix and a detour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { dshHostRootCandidates, resolveHostRoot } from '../scripts/host-paths.mjs';

/** Create a directory that looks like an unpacked host install. */
function fakeHost() {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-host-'));
  const probe = path.join(root, 'node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib');
  mkdirSync(probe, { recursive: true });
  writeFileSync(path.join(probe, 'index.js'), 'export const restoreReleasedV4Artifact = () => {};\n');
  return root;
}

/** Run `fn` with a temporary environment, then put it back. */
function withEnv(patch, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a directory root is accepted when it holds the host packages', (t) => {
  const root = fakeHost();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const resolved = resolveHostRoot({ explicit: root });
  assert.equal(resolved.root, root);
  assert.equal(resolved.tried[0], root, 'the explicit root is tried first');
});

test('a root without the host packages is skipped, not trusted', (t) => {
  const empty = mkdtempSync(path.join(tmpdir(), 'dsh-empty-'));
  const root = fakeHost();
  t.after(() => {
    rmSync(empty, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const resolved = withEnv({ DSH_HOST_ROOT: root }, () => resolveHostRoot({ explicit: empty }));
  assert.equal(resolved.root, root, 'the environment root is the next candidate');
  assert.ok(resolved.tried.includes(empty), 'the empty root was tried and rejected');
});

test('failing to find a host names every candidate it tried', () => {
  assert.throws(
    () => withEnv(
      {
        DSH_HOST_ROOT: 'C:/definitely/not/here',
        DSH_ASAR: 'C:/definitely/not/here/app.asar',
        DSH_APP_ASAR: undefined,
        LOCALAPPDATA: 'C:/empty-local-app-data',
        PROGRAMFILES: 'C:/empty-program-files',
      },
      () => resolveHostRoot({ explicit: 'C:/no/app.asar' }),
    ),
    (error) => {
      assert.equal(typeof error, 'object');
      assert.match(error.message, /no DeepSeek Harness installation found/u);
      assert.match(error.message, /C:\/no\/app\.asar/u, 'the explicit root must be listed');
      assert.match(error.message, /C:\/definitely\/not\/here/u, 'the environment root must be listed');
      assert.match(error.message, /--dsh-root/u, 'the fix has to be in the message');
      assert.match(error.message, /DSH_ASAR/u, 'the environment override has to be named');
      return true;
    },
  );
});

test('the candidate list covers both the packed and the unpacked layout', () => {
  const candidates = dshHostRootCandidates().map((candidate) => candidate.split(path.sep).join('/'));
  assert.ok(candidates.length > 0);
  for (const name of ['DSH NEXT', 'DeepSeek Harness']) {
    assert.ok(
      candidates.some((candidate) => candidate.includes(name)),
      `candidates must consider ${name}`,
    );
  }
  assert.ok(candidates.some((candidate) => candidate.endsWith('app.asar')), 'packed layout');
  assert.ok(candidates.some((candidate) => candidate.endsWith('resources/app/dsh')), 'unpacked layout');
});
