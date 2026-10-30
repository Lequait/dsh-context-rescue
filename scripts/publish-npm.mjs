#!/usr/bin/env node
/**
 * Publish this plugin to the npm registry.
 *
 * The repository listing already installs from git, so npm is optional: this
 * script exists so that the optional path is one verified command instead of a
 * paragraph of instructions. It refuses to publish from a dirty tree (the
 * tarball would not match any commit) and refuses to run before `npm login`.
 *
 * Usage:
 *   npm run publish:npm -- --dry-run   # check everything, publish nothing
 *   npm run publish:npm                # publish
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const REGISTRY = 'https://registry.npmjs.org/';
const argv = process.argv.slice(2);

/** Read a single `--flag value` pair. */
function argOf(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

const dryRun = argv.includes('--dry-run') || argv.includes('-n');
const registry = String(argOf('registry', REGISTRY));

/** Run a command, returning its exit status and captured output. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

/** Print a hard failure and stop. */
function fail(message, hint) {
  console.error(`publish:npm FAILED: ${message}`);
  if (hint) console.error(hint);
  process.exitCode = 1;
  process.exit();
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { name, version } = manifest;
if (!name || !version) fail('package.json is missing name or version');

console.log(`package     ${name}@${version}`);
console.log(`registry    ${registry}`);
console.log(`mode        ${dryRun ? 'dry run (nothing is published)' : 'publish'}`);
console.log('');

// A tarball published from a dirty tree does not correspond to any commit, so
// it cannot be reviewed or reproduced.
const status = run('git', ['status', '--porcelain']);
if (status.status !== 0) fail('git status failed; is this a checkout of the repository?');
if (status.stdout !== '') {
  fail(
    'the working tree has uncommitted changes',
    'commit or stash them first: what gets published has to be something you can point at.',
  );
}

// The registry that publishes is not the registry that mirrors: a laptop is
// often configured to a mirror, which cannot accept uploads.
const whoami = run('npm', ['whoami', '--registry', registry]);
if (whoami.status !== 0) {
  const hint = [
    `  npm login --registry ${registry}`,
    '  (the token stays in your npm config; this script never handles it)',
    'Nothing else about the release is missing: the repository index already installs from git.',
  ].join('\n');
  // A dry run is exactly what you do before logging in, so it continues; a real
  // publish cannot.
  if (!dryRun) fail(`not logged in to ${registry}`, hint);
  console.log('account     (not logged in: a real run stops here)');
  console.log(hint);
} else {
  console.log(`account     ${whoami.stdout}`);
}

// What the registry would receive: the tarball list has to contain the bundle
// entry point and must not contain the generated market index (that file pins a
// commit and belongs to the repository, not the package).
const pack = run('npm', ['pack', '--dry-run', '--json']);
if (pack.status !== 0) fail(`npm pack failed: ${pack.stderr || pack.stdout}`);
/** @type {any[]} */
let packed = [];
try {
  packed = JSON.parse(pack.stdout);
} catch {
  fail('npm pack --json did not return JSON');
}
const files = (packed[0]?.files ?? []).map((file) => file.path);
const bytes = packed[0]?.size ?? 0;
if (!files.includes('index.js')) fail('the tarball does not contain index.js');
if (!files.includes('cordis.patch.yml')) fail('the tarball does not contain cordis.patch.yml');
if (!files.includes('market/icon.svg')) fail('the tarball does not contain market/icon.svg');
if (files.includes('market/index.json')) fail('the tarball must not contain the generated market/index.json');
console.log(`tarball     ${files.length} files, ${(bytes / 1024).toFixed(1)} kB`);

const view = run('npm', ['view', `${name}@${version}`, 'version', '--registry', registry]);
if (view.status === 0 && view.stdout !== '') {
  fail(
    `${name}@${version} is already on the registry`,
    'bump the version in package.json, commit it, and run this again.',
  );
}

if (dryRun) {
  console.log('');
  console.log('dry run passed: a real run would publish the tarball above.');
  console.log('After it succeeds: `npm view ' + name + ' version` should report ' + version + '.');
  process.exitCode = 0;
  process.exit();
}

const published = run('npm', ['publish', '--access', 'public', '--registry', registry], { stdio: 'inherit' });
if (published.status !== 0) fail('npm publish failed; read the npm output above');

console.log('');
console.log(`published   ${name}@${version}`);
console.log(`install     dsh plugin add ${name}@${version}`);
console.log('still worth doing:');
console.log('  - `npm run publish:remote` re-pins the git index entry to this commit');
console.log('  - the market entry keeps working whether or not npm has this version');
