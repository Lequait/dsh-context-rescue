#!/usr/bin/env node
/**
 * Publishes this checkout to the repository you name, and pins the market index entry to the
 * commit that actually landed — the one thing `make-market-index.mjs` cannot do on its own,
 * because the commit that carries the entry does not exist until after the push.
 *
 * Usage:
 *   node scripts/publish-remote.mjs --repo OWNER/dsh-context-rescue --dry-run
 *   node scripts/publish-remote.mjs --repo https://github.com/OWNER/dsh-context-rescue
 *   node scripts/publish-remote.mjs --repo git@github.com:OWNER/dsh-context-rescue.git --ssh
 *
 * Steps: check the tree is clean → attach `origin` (or the `--remote` you name) → push the
 * branch → regenerate `market/index.json` against the pushed commit → commit it → push again →
 * print the index URL, the install spec and what is still manual.
 *
 * It never stores credentials. If the push fails, you get git's own error plus the two ways to
 * authenticate (credential helper or an SSH key); nothing is pushed and no commit is rewritten.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildMarketIndexDoc, checkMarketIndexDoc } from '../lib/market-index.js';
import { dshAsarCandidates } from './host-paths.mjs';

const SCRIPT_ROOT = path.resolve(import.meta.dirname, '..');

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

/**
 * The checkout to publish. `--root` exists so a rehearsal can run the whole flow against a
 * throwaway clone instead of the real work tree.
 */
const ROOT = path.resolve(String(argOf('root', SCRIPT_ROOT)));

/** Mask a token embedded in a URL before printing a command. */
const redact = (value) => String(value).replace(/\/\/[^/@]+@/u, '//***@');

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (allowFailure) return undefined;
    const stderr = String(error.stderr ?? error.message).trim();
    throw new Error(`git ${args.map(redact).join(' ')} failed:\n${stderr}`);
  }
}

/**
 * Accept a slug, an https URL, or an ssh remote.
 *
 * `https` is the address that goes into the index entry and the install spec, so it is always
 * derived. `pushUrl` is what git actually pushes to: an ssh remote stays ssh (rewriting it to
 * https would silently drop the key the user configured), and `--push-url` exists so a rehearsal
 * can push into a local bare repository.
 */
function normalizeRepo(input, options = {}) {
  const given = String(input).replace(/\/+$/u, '');
  const isSsh = /^[^/@\s]+@[^:\s]+:/u.test(given) || /^ssh:\/\//u.test(given);
  const masked = given.replace(/\/\/[^/@]+@/u, '//***@');
  const asHttps = isSsh
    ? masked.replace(/^ssh:\/\//u, 'https://').replace(/^[^/@]+@([^:/]+):/u, 'https://$1/')
    : /^https?:\/\//u.test(masked)
      ? masked
      : /^[\w.-]+\/[\w.-]+$/u.test(masked)
        ? `https://github.com/${masked}`
        : masked;
  const https = asHttps.replace(/\.git$/u, '').replace(/\/+$/u, '');
  const slug = https.replace(/^https:\/\/[^/]+\//u, '');
  const host = https.replace(/^https:\/\/([^/]+)\/.*$/u, '$1');
  const pushUrl = options.pushUrl !== undefined
    ? String(options.pushUrl)
    : isSsh || options.ssh === true
      ? given
      : /^https?:\/\//u.test(given)
        ? given.replace(/\.git$/u, '')
        : `https://github.com/${given.replace(/\.git$/u, '')}`;
  return {
    https,
    pushUrl,
    slug,
    host,
  };
}

function hostValidator() {
  const asar = dshAsarCandidates().find((candidate) => fs.existsSync(candidate));
  if (asar === undefined) return undefined;
  const file = path.join(asar, 'node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js');
  if (!fs.existsSync(file)) return undefined;
  return import(`file://${file.replaceAll('\\', '/')}`);
}

async function main() {
  const repoArg = argOf('repo', undefined);
  const dryRun = argOf('dry-run', false) === true;
  let branch = argOf('branch', git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true }) ?? 'main');
  const remote = argOf('remote', 'origin');
  const pushUrlArg = argOf('push-url', undefined);
  const useSsh = argOf('ssh', false) === true;

  if (typeof repoArg !== 'string') {
    throw new Error('--repo <OWNER/NAME | https URL | git@host:OWNER/NAME.git> is required');
  }
  const repo = normalizeRepo(repoArg, {
    ...(typeof pushUrlArg === 'string' ? { pushUrl: pushUrlArg } : {}),
    ssh: useSsh,
  });

  if (git(['rev-parse', '--is-inside-work-tree'], { allowFailure: true }) !== 'true') {
    throw new Error(`${ROOT} is not a git work tree`);
  }
  const status = git(['status', '--porcelain']);
  if (status !== '') {
    throw new Error(`the work tree is not clean; commit or stash first:\n${status}`);
  }
  if (branch === 'HEAD') {
    throw new Error('the checkout is on a detached HEAD; check out a branch first');
  }

  // A brand-new local repository here defaults to 'master'; the published index URL and every
  // install instruction use 'main', so rename before the first push instead of documenting a
  // branch nobody expects. Only when nothing has been pushed yet.
  if (branch === 'master' && git(['remote'], { allowFailure: true }) === '') {
    if (dryRun) {
      process.stdout.write('would run   git branch -M main (nothing has been pushed yet)\n');
    } else {
      git(['branch', '-M', 'main']);
    }
    branch = 'main';
  }

  const existing = git(['remote', 'get-url', remote], { allowFailure: true });
  // The index URL must address the branch that actually gets pushed, which is not always 'main'
  // (an existing clone keeps whatever branch it is on).
  const indexUrl = `${repo.https}/raw/${branch}/market/index.json`;
  const plan = [
    ...(existing === undefined
      ? [['remote', 'add', remote, repo.pushUrl]]
      : existing === repo.pushUrl
        ? []
        : [['remote', 'set-url', remote, repo.pushUrl]]),
    ['push', '--set-upstream', remote, branch],
  ];

  process.stdout.write(`repository  ${repo.https}\nremote      ${remote} (${existing ?? 'new'})\nbranch      ${branch}\n`);
  if (dryRun) {
    for (const args of plan) process.stdout.write(`would run   git ${args.map(redact).join(' ')}\n`);
    process.stdout.write(`then        regenerate market/index.json against the pushed commit and push it\n`);
    return;
  }

  for (const args of plan) git(args);

  const commit = git(['rev-parse', 'HEAD']);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const doc = buildMarketIndexDoc({
    name: pkg.name,
    version: pkg.version,
    author: pkg.author,
    dshRange: pkg.engines?.dsh,
    repo: repo.https,
    commit,
    iconSvg: fs.readFileSync(path.join(ROOT, 'market/icon.svg'), 'utf8'),
    publishTimestamp: Math.floor(Date.now() / 1000),
  });
  const problems = checkMarketIndexDoc(doc);
  if (problems.length > 0) throw new Error(`generated index entry is invalid:\n${problems.join('\n')}`);

  const validator = await hostValidator();
  if (validator === undefined) {
    process.stdout.write('host validator unavailable (set DSH_APP_ASAR); the local rules still passed\n');
  } else {
    validator.parseMarketIndex(doc, indexUrl);
    process.stdout.write('index entry accepted by the host parseMarketIndex\n');
  }

  // npm metadata belongs to a published package: point it at the repository that now exists, so
  // the registry page links back and `npm bugs` resolves.
  const pkgFile = path.join(ROOT, 'package.json');
  const metadata = {
    repository: { type: 'git', url: `${repo.https}.git` },
    homepage: `${repo.https}#readme`,
    bugs: { url: `${repo.https}/issues` },
  };
  if (JSON.stringify({ ...pkg, ...metadata }) !== JSON.stringify(pkg)) {
    fs.writeFileSync(pkgFile, `${JSON.stringify({ ...pkg, ...metadata }, undefined, 2)}\n`);
    process.stdout.write('package.json now points at the repository\n');
  }

  fs.writeFileSync(path.join(ROOT, 'market/index.json'), `${JSON.stringify(doc, undefined, 2)}\n`);
  git(['add', '-f', 'market/index.json']);
  git(['add', 'package.json']);
  git(['commit', '-m', `chore(market): pin the index entry to ${commit.slice(0, 7)}`]);
  git(['push', remote, branch]);

  const spec = `git+${repo.https}.git#${commit}`;
  process.stdout.write(
    [
      '',
      `pushed      ${repo.https} (${commit.slice(0, 7)})`,
      `index URL   ${indexUrl}`,
      `install     dsh plugin add ${spec}`,
      '',
      'still manual (needs an account, not a credential this script may hold):',
      '  - add the repository topic  dsh-plugin  (README: Publishing)',
      '  - open the awesome-list PR with the entry text in docs/PUBLISH.md',
      '  - npm publish, if you want an npm-sourced version too',
      '',
    ].join('\n'),
  );
}

await main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
