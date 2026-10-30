/**
 * Rehearse the publish flow without a hosting account.
 *
 * `publish-remote.mjs` is the one step I cannot prove against the real target until the user
 * supplies a repository — so prove the *mechanics* here instead: clone this checkout into a
 * throwaway directory, create a local bare repository as the remote, run the publish script
 * against it, and then assert what a real host would see:
 *
 *   - the branch landed, twice (the code push, then the index commit);
 *   - the pushed `market/index.json` parses under the host's own `parseMarketIndex`;
 *   - it pins the commit that actually carried the code, not the index commit;
 *   - the derived install spec is a commit-pinned git spec the market would hand to a user;
 *   - `package.json` in the pushed tree points at the repository.
 *
 * Nothing here touches the real work tree or the network.
 *
 *     npm run publish:rehearse          # add --keep to inspect the throwaway repositories
 * @module dsh-context-rescue/scripts/dev/publish-rehearse
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { dshAsarCandidates } from '../host-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const KEEP = process.argv.includes('--keep');
const REPO_HTTPS = 'https://github.com/rehearsal/dsh-context-rescue';

const failures = [];

const check = (label, condition, detail) => {
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    process.stdout.write(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
    failures.push(label);
  }
};

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function hostValidator() {
  const asar = dshAsarCandidates().find((candidate) => fs.existsSync(candidate));
  if (asar === undefined) return undefined;
  const file = path.join(asar, 'node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js');
  if (!fs.existsSync(file)) return undefined;
  return import(`file://${file.replaceAll('\\', '/')}`);
}

/** A standalone clone plus an empty bare remote, the shape of a first publish. */
function makeRehearsal(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cloneDir = path.join(dir, 'work');
  const bareDir = path.join(dir, 'remote.git');
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', ROOT, cloneDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '--quiet', '--bare', bareDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { dir, clone: cloneDir, bare: bareDir };
}

/** Windows keeps the clone's object files locked for a moment after the child git exits. */
function cleanupDir(dir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
  spawn(process.platform === 'win32' ? 'cmd' : 'sh',
    process.platform === 'win32' ? ['/c', 'rmdir', '/s', '/q', dir] : ['-c', `rm -rf '${dir}'`],
    { detached: true, stdio: 'ignore' }).unref();
  process.stdout.write(`cleanup of ${dir} deferred (a handle is still open)
`);
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rescue-rehearse-'));
const clone = path.join(workspace, 'work');
const bare = path.join(workspace, 'remote.git');

process.stdout.write(`workspace   ${workspace}\n`);

// A shallow checkout cannot be rehearsed: its clone inherits the shallow boundary, and git
// refuses to push a shallow history to a bare remote ("shallow update not allowed"). Say so
// instead of reporting a fake pass — the CI checkout uses fetch-depth 0 for exactly this.
if (fs.existsSync(path.join(ROOT, '.git', 'shallow'))) {
  cleanupDir(workspace);
  process.stderr.write('publish rehearsal needs a full checkout: this one is shallow.\n'
    + 'run `git fetch --unshallow`, or use actions/checkout with `fetch-depth: 0`.\n');
  process.exitCode = 1;
  process.exit();
}

try {
  process.stdout.write('1. clone this checkout and create a bare remote\n');
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', ROOT, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '--quiet', '--bare', bare], { stdio: ['ignore', 'pipe', 'pipe'] });
  const sourceHead = git(['rev-parse', 'HEAD'], ROOT);
  const sourceStatus = git(['status', '--porcelain'], ROOT);
  check('the clone starts at this checkout', git(['rev-parse', 'HEAD'], clone) === sourceHead);

  process.stdout.write('2. run the real publish script against it\n');
  const output = execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'scripts/publish-remote.mjs'),
      '--root', clone,
      '--repo', REPO_HTTPS,
      '--push-url', bare,
      '--remote', 'origin',
    ],
    {
      cwd: clone,
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  for (const line of output.split('\n')) if (line.trim() !== '') process.stdout.write(`     | ${line}\n`);
  check('the script reported a pushed commit', /pushed\s+https:\/\/github\.com\/rehearsal\/dsh-context-rescue/u.test(output));

  process.stdout.write('3. assert what a host would see in the remote\n');
  const branch = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], bare).trim();
  check('exactly one branch was pushed', branch !== '' && !branch.includes('\n'), branch);
  const history = git(['log', '--oneline', '-3', branch], bare).split('\n');
  check('the index commit sits on top of the code commit', history.length >= 2 && history[0] !== history[1],
    history.join(' / '));
  // The clone carries this checkout's whole history, so count what the publish itself added.
  // The clone already carries this checkout's commits, so the publish itself adds exactly one:
  // the commit that pins the index entry on top of the pushed code commit.
  const added = Number(git(['rev-list', '--count', `${sourceHead}..${branch}`], bare));
  check(`the publish added one commit to ${branch}`, added === 1, String(added));
  check('the pushed code commit is this checkout', git(['rev-parse', `${branch}~1`], bare) === sourceHead);
  check('the printed index URL advertises the pushed branch', output.includes(`/raw/${branch}/market/index.json`));

  const codeCommit = git(['rev-parse', `${branch}~1`], bare);
  const indexCommit = git(['rev-parse', `${branch}`], bare);
  const entryText = git(['show', `${branch}:market/index.json`], bare);
  check('the index entry is committed', entryText.length > 0);

  const doc = JSON.parse(entryText);
  const pinned = doc?.plugins?.[0]?.versions?.[0]?.source?.commit;
  check('the entry pins the commit that carried the code', pinned === codeCommit, `${pinned} vs ${codeCommit}`);
  check('the entry does not pin the index commit', pinned !== indexCommit);

  const validator = await hostValidator();
  if (validator === undefined) {
    process.stdout.write('  skip the host validator is unreachable (set DSH_APP_ASAR)\n');
  } else {
    const indexUrl = `${REPO_HTTPS}/raw/${branch}/market/index.json`;
    const parsed = validator.parseMarketIndex(doc, indexUrl);
    check('the host parseMarketIndex accepts the pushed entry', parsed?.plugins?.length === 1);
    const version = doc.plugins[0]?.versions?.[0];
    const target = validator.marketInstallTarget(doc.plugins[0].name, version);
    const spec = String(target?.spec ?? '');
    check('the install spec is commit-pinned', spec === `git+${REPO_HTTPS}.git#${codeCommit}`, spec);
  }

  const pushedPackage = JSON.parse(git(['show', `${branch}:package.json`], bare));
  check(
    'the pushed package.json points at the repository',
    pushedPackage.repository?.url === `${REPO_HTTPS}.git` && pushedPackage.homepage === `${REPO_HTTPS}#readme`,
    JSON.stringify({ repository: pushedPackage.repository, homepage: pushedPackage.homepage }),
  );
  check('the index entry stays out of the npm package', (pushedPackage.files ?? []).includes('market/icon.svg')
    && !(pushedPackage.files ?? []).includes('market/index.json'), JSON.stringify(pushedPackage.files));

  const remoteUrl = git(['remote', 'get-url', 'origin'], clone);
  check('the rehearsal remote was a local bare repository', remoteUrl === bare, remoteUrl);
  check('this checkout was left untouched',
    git(['rev-parse', 'HEAD'], ROOT) === sourceHead && git(['status', '--porcelain'], ROOT) === sourceStatus,
    'the real work tree changed');
  process.stdout.write('4. an existing master branch is kept as master\n');
  const legacy = makeRehearsal('dsh-rescue-rehearse-legacy-');
  try {
    execFileSync('git', ['push', '--quiet', legacy.bare, 'master'], { cwd: legacy.clone, stdio: ['ignore', 'pipe', 'pipe'] });
    const legacyOutput = execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts/publish-remote.mjs'),
        '--root', legacy.clone, '--repo', REPO_HTTPS, '--push-url', legacy.bare, '--remote', 'origin'],
      { cwd: legacy.clone, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    check(
      'a repository that already publishes master keeps master',
      legacyOutput.includes('branch      master') && legacyOutput.includes('/raw/master/market/index.json'),
      legacyOutput.split('\n').filter((line) => line.includes('branch')).join(' / '),
    );
    check('the legacy push landed on master', git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], legacy.bare).trim() === 'master');
  } finally {
    if (KEEP) process.stdout.write(`\nkept        ${legacy.dir}\n`);
    else cleanupDir(legacy.dir);
  }
} catch (error) {
  failures.push('rehearsal threw');
  process.stderr.write(`${String(error.stderr ?? error.message).trim()}\n`);
} finally {
  if (KEEP) process.stdout.write(`\nkept        ${workspace}\n`);
  else cleanupDir(workspace);
}

process.stdout.write(failures.length === 0 ? '\npublish rehearsal passed\n' : `\npublish rehearsal failed: ${failures.join(', ')}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
