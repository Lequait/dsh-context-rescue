/**
 * What a machine with no git identity sees when it publishes.
 *
 * A fresh CI runner, a container, or a new laptop has no `user.name` / `user.email`. The index
 * commit needs one, and git's own failure ("empty ident name ... not allowed") arrives several
 * steps too late to explain itself. The publish script therefore refuses up front, and this
 * test pins that refusal — including that it names the two commands that fix it.
 * @module dsh-context-rescue/tests/publish-preflight
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT_AVAILABLE = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('publishing from a checkout with no git identity says so, and how to fix it', { skip: !GIT_AVAILABLE && 'git is not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rescue-identity-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-context-rescue', version: '0.1.0' }, null, 2)}\n`);
    // The commit itself is made with an inline identity, so the repository is otherwise healthy:
    // only the *ambient* configuration is empty, which is exactly the CI-runner situation.
    execFileSync('git', ['init', '--quiet', '--initial-branch=master'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'init'], { cwd: dir, stdio: 'ignore' });

    const emptyConfigDir = path.join(dir, '.empty-home');
    fs.mkdirSync(emptyConfigDir);
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts/publish-remote.mjs'), '--root', dir, '--repo', 'example/dsh-context-rescue', '--dry-run'],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: emptyConfigDir,
          USERPROFILE: emptyConfigDir,
          GIT_CONFIG_GLOBAL: path.join(emptyConfigDir, 'gitconfig'),
          GIT_CONFIG_SYSTEM: path.join(emptyConfigDir, 'gitconfig-system'),
          GIT_CONFIG_NOSYSTEM: '1',
          DSH_PUBLISH_PLAIN: '1',
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, 'publishing without an identity must not proceed');
    assert.match(output, /no git identity/u);
    assert.match(output, /git config user\.name/u);
    assert.match(output, /git config user\.email/u);
  } finally {
    // git keeps object handles open for a moment on Windows; a leftover temp directory is not
    // worth failing a passing test over.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    } catch {
      // left for the OS temp cleaner
    }
  }
});
