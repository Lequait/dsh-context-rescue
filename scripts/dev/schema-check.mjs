#!/usr/bin/env node
/**
 * schema-check — is the declared config schema real, and does the host use it?
 *
 * `lib/schema.js` only earns its keep if the running host does two things with
 * it: validate a patch *before* the plugin starts, and document the options in
 * `--dump-config-schema`. Both are observable, so both are asserted here:
 *
 * 1. the dump names our entry and points at one of its own `config` defs rather
 *    than the `unknownConfig` placeholder;
 * 2. that def actually lists our knobs;
 * 3. a patch carrying an out-of-range value stops the boot with the schema's own
 *    message, instead of the plugin starting with a silently clamped number;
 * 4. a patch carrying a valid value boots past configuration.
 *
 * The profile lives under the real `$DSH_HOME/profiles` (the app resolves home
 * from the OS account, so it cannot be redirected) and is removed in `finally`.
 *
 * Run it through the app's own Node: `npm run schema-check`.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshAppExeCandidates, dshAsarCandidates } from '../host-paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROFILE = `rescue-schema-${Date.now().toString(36)}`;
const BOOT_TASK = 'reply with the single word ok';
const PLUGIN_NAME = 'dsh-context-rescue';
const ENTRY_ID = 'context-rescue';

let assertions = 0;
function ok(condition, message) {
  assertions += 1;
  if (!condition) {
    console.error(`schema check FAILED: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ok   ${message}`);
}

function locate() {
  const exe = dshAppExeCandidates().find((candidate) => existsSync(candidate));
  const asar = dshAsarCandidates().find((candidate) => existsSync(candidate));
  if (exe === undefined || asar === undefined) {
    throw new Error('the app bundle was not found; set DSH_APP_EXE and DSH_APP_ASAR');
  }
  const bin = join(asar, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!existsSync(bin)) throw new Error(`the app CLI is missing at ${bin}`);
  return { exe, asar, bin };
}

function cli(app, args, timeout = 180_000) {
  return spawnSync(app.exe, [app.bin, ...args], {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

/** The dump prints JSON after any warnings; take the first line that starts a document. */
function jsonFrom(text) {
  const lines = String(text ?? '').split(String.fromCharCode(10));
  const start = lines.findIndex((line) => line.trim().startsWith('{'));
  if (start === -1) throw new Error('the dump printed no JSON');
  return JSON.parse(lines.slice(start).join(String.fromCharCode(10)));
}

function defOf(document, ref) {
  const prefix = '#/$defs/';
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) return undefined;
  return document.$defs?.[ref.slice(prefix.length)];
}

/**
 * A fresh profile patch is a comment header followed by an empty `[]`. Entries
 * cannot be appended after that literal, so the literal is replaced.
 */
function withPatch(source, block) {
  const newline = String.fromCharCode(10);
  const lines = source.split(newline);
  const emptyAt = lines.findIndex((line) => line.trim() === '[]');
  if (emptyAt === -1) return `${source}${newline}${block}${newline}`;
  const before = lines.slice(0, emptyAt);
  const after = lines.slice(emptyAt + 1);
  return [...before, ...block.split(newline), ...after].join(newline);
}

/** The patch row that overrides this plugin's config. */
function configPatch(retainRatio) {
  const newline = String.fromCharCode(10);
  return [`- id: ${ENTRY_ID}`, '  config:', `    retainRatio: ${retainRatio}`].join(newline);
}

function removeDir(dir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      // A Windows handle may still be closing; the caller retries.
    }
  }
  return false;
}

function packTarball() {
  const destination = mkdtempSync(join(tmpdir(), 'dsh-schema-pack-'));
  const packed = spawnSync('npm', ['pack', '--silent', '--pack-destination', destination], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    shell: true,
  });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr ?? ''}`);
  const name = String(packed.stdout ?? '').trim().split(String.fromCharCode(10)).filter(Boolean).at(-1);
  return join(destination, name);
}

function main() {
  const app = locate();
  const profilesDir = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'), 'profiles');
  const profileDir = join(profilesDir, PROFILE);
  const patchFile = join(profileDir, 'cordis.patch.yml');

  try {
    const created = cli(app, ['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config']);
    ok(created.status === 0, `the host created a throwaway profile ${PROFILE}`);

    const tarball = packTarball();
    const added = cli(app, ['plugin', '--profile', PROFILE, 'add', tarball]);
    ok(added.status === 0, 'the app CLI installed the packed tarball');

    const dumped = cli(app, ['--profile', PROFILE, '--dump-config-schema']);
    ok(dumped.status === 0, 'the host produced a config schema for the profile');
    const document = jsonFrom(dumped.stdout);

    // `items` points at the entry definition; the per-plugin branches live there.
    const entryDef = defOf(document, document.items?.$ref);
    const branches = entryDef?.allOf ?? [];
    const branch = branches.find((candidate) => candidate?.if?.properties?.name?.const === PLUGIN_NAME);
    ok(branch !== undefined, `the schema names the ${PLUGIN_NAME} entry`);

    const configRefs = JSON.stringify(branch?.then?.properties?.config ?? {});
    ok(!configRefs.includes('unknownConfig'), 'the entry is not treated as unknown configuration');
    const ref = (branch?.then?.properties?.config?.anyOf ?? [])[0]?.$ref;
    const def = defOf(document, ref);
    ok(def !== undefined, `the entry points at a projected config definition (${String(ref)})`);

    // A projected config def wraps the object in `anyOf` (the null/expression
    // branches), so the knobs live one level down.
    const shapes = def?.anyOf ?? [];
    const properties = Object.assign({}, ...shapes.map((shape) => shape?.properties ?? {}));
    const wanted = ['retainRatio', 'preflight', 'excerptChars', 'laneRefusalPatterns', 'trimOversizedMessages'];
    const missing = wanted.filter((key) => !(key in properties));
    ok(missing.length === 0, `the definition lists the knobs this plugin accepts${missing.length === 0 ? '' : ` (missing ${missing.join(', ')})`}`);
    ok(
      JSON.stringify(properties?.retainRatio ?? {}).includes('maximum'),
      'the projected schema keeps the numeric bound on retainRatio',
    );

    // A value the schema refuses must stop the boot, not be clamped in silence.
    const original = readFileSync(patchFile, 'utf8');
    writeFileSync(patchFile, withPatch(original, configPatch(5)), 'utf8');
    const rejected = cli(app, ['--profile', PROFILE, BOOT_TASK]);
    const rejectedText = `${rejected.stdout ?? ''}\n${rejected.stderr ?? ''}`;
    ok(rejected.status !== 0, 'a patch with an out-of-range value does not boot');
    ok(
      rejectedText.includes('retainRatio') && rejectedText.includes('0.6'),
      'the boot names the option and its bound (the schema, not a clamp, rejected it)',
    );

    writeFileSync(patchFile, withPatch(original, configPatch(0.3)), 'utf8');
    const accepted = cli(app, ['--profile', PROFILE, BOOT_TASK]);
    const acceptedText = `${accepted.stdout ?? ''}\n${accepted.stderr ?? ''}`;
    ok(
      acceptedText.includes('MISSING_CREDENTIAL') || acceptedText.includes('no API key') || acceptedText.includes('answer'),
      'a patch with a valid value boots past configuration into the model stage',
    );

    console.log(`schema check passed (${assertions} assertions)`);
  } finally {
    removeDir(profileDir);
  }
}

main();
