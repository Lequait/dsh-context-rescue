/**
 * Install the packed plugin with the app's own CLI, into a throwaway profile.
 *
 * `install-smoke` proves the tarball installs as a dependency and that the host
 * loader resolves `cordis.patch.yml` from the installed path. This runs the real
 * user path — `dsh plugin --profile <name> add <tarball>`, which initializes a
 * profile and forwards to pnpm inside it — and reads the result back through the
 * host's loader. The profile is removed afterwards, so the only trace left is a
 * refreshed npm cache.
 *
 * A temporary `USERPROFILE`/`HOME` does **not** redirect this: the Electron
 * binary resolves the home directory from the OS profile, so the profile is
 * created under the real `~/.dsh/profiles`. That is why the name is unique and
 * the cleanup is unconditional.
 *
 *     npm run e2e-install
 * @module dsh-context-rescue/scripts/dev/e2e-install
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import { dshAppExeCandidates, dshAsarCandidates } from '../host-paths.mjs';

const APP = dshAppExeCandidates().find((candidate) => existsSync(candidate));
if (APP === undefined) throw new Error('Cannot find the DSH app; set DSH_APP_EXE.');
const ASAR = dshAsarCandidates().find((candidate) => existsSync(candidate));
if (ASAR === undefined) throw new Error('Cannot find the DSH app bundle; set DSH_APP_ASAR.');

const CLI = join(ASAR, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const ROOT = join(import.meta.dirname, '..', '..');

/**
 * `--git [ref]` installs the published git spec instead of a freshly packed tarball, which is
 * the command a user actually runs; it needs network access to the repository. Without it the
 * gate stays hermetic and only uses what `npm pack` produced.
 */
const gitArgIndex = process.argv.indexOf('--git');
const gitRef = gitArgIndex === -1 ? undefined : (process.argv[gitArgIndex + 1] ?? 'HEAD');
const profileName = `rescue-e2e-${Date.now().toString(36)}`;
const profileDir = join(homedir(), '.dsh', 'profiles', profileName);
if (existsSync(profileDir)) throw new Error(`refusing to reuse an existing profile: ${profileDir}`);

const failures = [];
const check = (label, condition, detail) => {
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    process.stdout.write(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
    failures.push(label);
  }
};

let tarball;
try {
  let spec = tarball;
  if (gitRef === undefined) {
    process.stdout.write('1. pack the plugin\n');
    const pack = spawnSync('npm', ['pack', '--silent'], { cwd: ROOT, encoding: 'utf8', shell: true });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    tarball = join(ROOT, pack.stdout.trim().split(/\r?\n/u).at(-1));
    check('a tarball was produced', existsSync(tarball), tarball);
    spec = tarball;
  } else {
    const published = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).repository?.url ?? '';
    const https = String(published).replace(/^git\+/u, '').replace(/\.git$/u, '');
    if (https === '') throw new Error('package.json has no repository.url; nothing to install from');
    spec = `git+${https}.git#${gitRef}`;
    process.stdout.write(`1. install the published git spec ${spec}\n`);
  }

  process.stdout.write(`2. let the app CLI install it into profile "${profileName}"\n`);
  const installed = spawnSync(APP, [CLI, 'plugin', '--profile', profileName, 'add', String(spec)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 900_000,
  });
  const output = `${installed.stdout ?? ''}${installed.stderr ?? ''}`;
  check('the CLI exited cleanly', installed.status === 0, output.slice(-500));
  if (spec !== tarball) check('the profile recorded the git spec', output.includes('dsh-context-rescue'), output.slice(-400));

  const manifestPath = join(profileDir, 'package.json');
  check('it created the profile', existsSync(manifestPath), profileDir);
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { dependencies: {}, dsh: {} };
  check('the profile depends on the plugin', typeof manifest.dependencies?.['dsh-context-rescue'] === 'string', JSON.stringify(manifest.dependencies ?? {}));
  check('the plugin is switched on in the profile bundle list', (manifest.dsh?.profile?.bundles ?? []).includes('dsh-context-rescue'), JSON.stringify(manifest.dsh?.profile?.bundles ?? []));

  const packageDir = join(profileDir, 'node_modules', 'dsh-context-rescue');
  const installedManifest = existsSync(join(packageDir, 'package.json'))
    ? JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    : {};
  check('the plugin landed in the profile', existsSync(join(packageDir, 'index.js')), packageDir);
  check('its bundle patch survived packing', installedManifest.dsh?.bundle?.patch === './cordis.patch.yml', String(installedManifest.dsh?.bundle?.patch));

  process.stdout.write('3. read it back through the host loader\n');
  const boot = await import(pathToFileURL(join(ASAR, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href);
  const patches = boot.bundlePatchPaths(packageDir, installedManifest.dsh.bundle);
  check('the loader resolved the installed patch path', patches.length === 1 && existsSync(patches[0]), JSON.stringify(patches));
  const overlays = boot.loadOverlayPatches('dsh', patches[0]);
  const inserted = overlays.flatMap((overlay) => overlay.insert ?? []).find((entry) => entry.id === 'context-rescue');
  check('the patch inserts the plugin', inserted?.name === 'dsh-context-rescue', JSON.stringify(inserted));

  const mod = await import(pathToFileURL(join(packageDir, 'index.js')).href);
  check('the installed entry exports the plugin', mod.name === 'context-rescue' && Array.isArray(mod.inject) && typeof mod.apply === 'function');
} finally {
  rmSync(profileDir, { recursive: true, force: true });
  process.stdout.write(`4. removed the throwaway profile (${existsSync(profileDir) ? 'still there!' : 'gone'})\n`);
  if (existsSync(profileDir)) failures.push('cleanup');
  if (tarball !== undefined) rmSync(tarball, { force: true });
}

process.stdout.write(failures.length === 0 ? '\ne2e install passed\n' : `\n${failures.length} failure(s)\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
