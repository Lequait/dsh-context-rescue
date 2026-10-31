/**
 * Follow the marketplace path end to end: fetch the published index, hand it to the host's own
 * `parseMarketIndex`, ask the host how it would install that entry, and then let the app's CLI
 * install exactly what the market would install.
 *
 * Everything else in this repository stops one step earlier — `install-smoke` packs a tarball,
 * `e2e-install --git` installs a spec this repository chose. This gate is the one that proves the
 * entry a user's Discover page reads is enough to get a working plugin, including the row where a
 * mistake would only show up after publishing.
 *
 *     npm run market-install                       # the published index
 *     npm run market-install -- --index <url>      # any index, e.g. a local rehearsal copy
 *     npm run market-install -- --keep             # keep the throwaway profile for inspection
 *
 * Needs network access and the app; `node --test` skips the parts that need the host.
 * @module dsh-context-rescue/scripts/dev/market-install
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { dshAppExeCandidates, dshAsarCandidates } from '../host-paths.mjs';

const DEFAULT_INDEX = 'https://github.com/Lequait/dsh-context-rescue/raw/master/market/index.json';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
};
const keep = argv.includes('--keep');
const indexUrl = argOf('index', DEFAULT_INDEX);

const APP = dshAppExeCandidates().find((candidate) => existsSync(candidate));
if (APP === undefined) throw new Error('Cannot find the DSH app; set DSH_APP_EXE.');
const ASAR = dshAsarCandidates().find((candidate) => existsSync(candidate));
if (ASAR === undefined) throw new Error('Cannot find the DSH app bundle; set DSH_APP_ASAR.');

const CLI = join(ASAR, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const marketIndexEntry = join(ASAR, 'node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js');

const failures = [];
const check = (label, condition, detail) => {
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    process.stdout.write(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
    failures.push(label);
  }
};

const profileName = `rescue-market-${Date.now().toString(36)}`;
const profileDir = join(homedir(), '.dsh', 'profiles', profileName);
if (existsSync(profileDir)) throw new Error(`refusing to reuse an existing profile: ${profileDir}`);

const localPackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/**
 * Fetch the index, but treat a CDN hiccup as a hiccup.
 *
 * This gate reaches raw.githubusercontent.com, and that connection does time out
 * (10 s undici default) often enough to red-light a run that has nothing wrong
 * with it. Three attempts with a widening pause, an explicit timeout, and a
 * single-line error instead of an undici stack trace.
 */
async function fetchIndex(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        process.stdout.write(`   attempt ${attempt} failed (${error?.cause?.message ?? error?.message ?? error}); retrying\n`);
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
  }
  const reason = lastError?.cause?.message ?? lastError?.message ?? String(lastError);
  const error = new Error(`could not fetch the index at ${url}: ${reason}`);
  error.clean = true;
  error.network = true;
  throw error;
}

let skipped;
try {
  process.stdout.write(`1. fetch the index a Discover page would read\n   ${indexUrl}\n`);
  const response = await fetchIndex(indexUrl);
  check('the index is served', response.ok, `HTTP ${response.status}`);
  const raw = await response.text();
  const value = JSON.parse(raw);

  process.stdout.write('2. hand it to the host validator\n');
  const market = await import(pathToFileURL(marketIndexEntry).href);
  let parsed;
  try {
    parsed = market.parseMarketIndex(value, indexUrl);
  } catch (error) {
    check('the index parses', false, error?.message ?? String(error));
  }
  check('the index parses', parsed !== undefined);
  if (parsed === undefined) throw new Error('cannot continue without a parsed index');

  const entry = parsed.plugins.find((candidate) => candidate.name === localPackage.name);
  check(`the index lists ${localPackage.name}`, entry !== undefined, JSON.stringify(parsed.plugins.map((candidate) => candidate.name)));
  const version = entry?.versions?.[0];
  check('the newest version matches this checkout', version?.version === localPackage.version, `${version?.version} vs ${localPackage.version}`);
  check('the entry declares a dsh engine range', typeof version?.engines?.dsh === 'string', JSON.stringify(version?.engines ?? {}));

  process.stdout.write('3. ask the host how it would install that entry\n');
  const target = market.marketInstallTarget(entry.name, version);
  const spec = target?.spec;
  check('the host produced an install spec', typeof spec === 'string' && spec.length > 0, JSON.stringify(target));
  check('the spec pins a commit', /#[0-9a-f]{40}\b/u.test(String(spec)), String(spec));
  check('the spec is not a moving branch', !/#(?:master|main|HEAD)$/u.test(String(spec)), String(spec));

  process.stdout.write(`4. install exactly that spec into profile "${profileName}"\n`);
  const installed = spawnSync(APP, [CLI, 'plugin', '--profile', profileName, 'add', String(spec)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 900_000,
  });
  const output = `${installed.stdout ?? ''}${installed.stderr ?? ''}`;
  check('the CLI exited cleanly', installed.status === 0, output.slice(-500));

  const manifestPath = join(profileDir, 'package.json');
  check('it created the profile', existsSync(manifestPath), profileDir);
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { dependencies: {}, dsh: {} };
  check('the profile depends on the plugin', typeof manifest.dependencies?.[localPackage.name] === 'string', JSON.stringify(manifest.dependencies ?? {}));
  check('the plugin is switched on in the profile bundle list', (manifest.dsh?.profile?.bundles ?? []).includes(localPackage.name), JSON.stringify(manifest.dsh?.profile?.bundles ?? []));

  const packageDir = join(profileDir, 'node_modules', localPackage.name);
  check('the plugin landed in the profile', existsSync(join(packageDir, 'index.js')), packageDir);

  process.stdout.write('5. check the installed copy loads the way the host loads it\n');
  const boot = await import(pathToFileURL(join(ASAR, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href);
  const installedManifest = existsSync(join(packageDir, 'package.json'))
    ? JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    : {};
  const patches = boot.bundlePatchPaths(packageDir, installedManifest.dsh.bundle);
  check('the host loader finds the patch inside the installed copy', patches.length === 1 && existsSync(patches[0]), JSON.stringify(patches));
  const overlays = boot.loadOverlayPatches('dsh', patches[0]);
  const inserted = overlays.flatMap((overlay) => overlay.insert ?? []).find((candidate) => candidate.id === 'context-rescue');
  check('the patch inserts the plugin entry', inserted?.name === localPackage.name, JSON.stringify(inserted));
  const mod = await import(pathToFileURL(join(packageDir, 'index.js')).href);
  check('the installed entry exports the plugin', mod.name === 'context-rescue' && Array.isArray(mod.inject) && typeof mod.apply === 'function');
} catch (error) {
  if (error?.network === true) {
    // This gate checks the published artifact, not the network. When the index
    // cannot be reached at all, say so out loud and let the run continue: a
    // blocked CDN is not a defect in this plugin, and a red gate would only
    // teach everyone to ignore it.
    skipped = error.message;
    process.stdout.write(`   SKIP ${error.message}\n`);
    process.stdout.write('   (a proxy would let it run: NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://HOST:PORT npm run market-install)\n');
  } else {
    // One line is enough for a network error; a stack for our own bug.
    check('the gate ran to the end', false, error?.clean === true ? error.message : (error?.stack ?? String(error)));
  }
} finally {
  if (keep) {
    process.stdout.write(`\nkept the profile at ${profileDir}\n`);
  } else {
    rmSync(profileDir, { recursive: true, force: true });
    const gone = !existsSync(profileDir);
    process.stdout.write(`${gone ? '6' : '6'}. removed the throwaway profile (${gone ? 'gone' : 'still there!'})\n`);
    if (!gone) failures.push('cleanup');
  }
}

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} failure(s)\n`);
  process.exitCode = 1;
} else if (skipped !== undefined) {
  process.stdout.write('\nmarket install skipped — the index could not be reached, so nothing about it was checked\n');
  process.exitCode = 0;
} else {
  process.stdout.write('\nmarket install passed\n');
  process.exitCode = 0;
}
