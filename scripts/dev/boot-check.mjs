#!/usr/bin/env node
/**
 * boot-check — does the *installed* bundle actually mount in the real app?
 *
 * Every other gate loads the plugin from a source tree, a tarball, or through
 * `mountRootInclude`. None of them boots the application. This one does two
 * boots of a throwaway profile built from the shipped `headless` template:
 *
 * 1. a deliberately broken copy whose `apply()` throws — the host must report
 *    that error under the plugin's own entry name. If it does not, the bundle
 *    was silently skipped and a green run would mean nothing.
 * 2. the real tarball — the host must boot past mounting with no error naming
 *    the plugin. The run then stops at the first model call, which is expected
 *    here: this gate proves mounting, not inference.
 *
 * Both profiles live under the real `$DSH_HOME/profiles` (the app resolves home
 * from the OS account, so it cannot be redirected), and both are removed in a
 * `finally` block.
 *
 * Run it through the app's own Node: `npm run boot-check`.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshAppExeCandidates, dshAsarCandidates } from '../host-paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE_PROFILE = `rescue-boot-probe-${Date.now().toString(36)}`;
const REAL_PROFILE = `rescue-boot-${Date.now().toString(36)}`;
const BOOT_TASK = 'reply with the single word ok';

let assertions = 0;
function ok(condition, message) {
  assertions += 1;
  if (!condition) {
    console.error(`boot check FAILED: ${message}`);
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

/** Run the app CLI with the app's own Node. */
function cli(app, args, options = {}) {
  return spawnSync(app.exe, [app.bin, ...args], {
    encoding: 'utf8',
    timeout: options.timeout ?? 180_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

function makeProfile(app, name) {
  const created = cli(app, ['--profile', name, '--from-default-profile', 'headless', '--dump-config']);
  ok(created.status === 0, `the host created a throwaway profile ${name}`);
}

function addPlugin(app, name, spec) {
  const added = cli(app, ['plugin', '--profile', name, 'add', spec]);
  ok(
    added.status === 0,
    `the app CLI installed ${spec.split(/[\\/]/u).slice(-1)[0]} into ${name}`,
  );
}

function boot(app, name) {
  const run = cli(app, ['--profile', name, BOOT_TASK], { timeout: 180_000 });
  return `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
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

/** Copy exactly the files the package publishes, so `npm pack` stays honest. */
function stagePackage(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'dsh-boot-probe-'));
  for (const entry of manifest.files ?? []) {
    const source = join(ROOT, entry);
    if (!existsSync(source)) continue;
    const target = join(dir, entry);
    cpSync(source, target, { recursive: true });
  }
  cpSync(manifestPath, join(dir, 'package.json'));
  return dir;
}

async function main() {
  const app = locate();
  const profilesDir = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'), 'profiles');
  const probeDir = join(profilesDir, PROBE_PROFILE);
  const realDir = join(profilesDir, REAL_PROFILE);

  try {
    // 1. Positive control: a bundle that throws from apply() must be reported
    //    under its own entry name. Without this, "no error" proves nothing.
    const staged = stagePackage(join(ROOT, 'package.json'));
    const entryPath = join(staged, 'index.js');
    const entry = readFileSync(entryPath, 'utf8');
    const marker = 'PROBE the installed bundle really executes apply() in the real host';
    const patched = entry.replace(
      /export function apply\(ctx, rawConfig\) \{\n/u,
      `export function apply(ctx, rawConfig) {\n  throw new Error(${JSON.stringify(marker)});\n`,
    );
    ok(patched !== entry, 'the probe copy carries a throwing apply()');
    writeFileSync(entryPath, patched);

    const packed = spawnSync('npm', ['pack', '--silent'], { cwd: staged, encoding: 'utf8', shell: true });
    const tarball = packed.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1) ?? '';
    ok(tarball.endsWith('.tgz'), 'the probe copy packed into a tarball');

    makeProfile(app, PROBE_PROFILE);
    addPlugin(app, PROBE_PROFILE, join(staged, tarball));
    const probeOutput = boot(app, PROBE_PROFILE);
    ok(
      probeOutput.includes('context-rescue (dsh-context-rescue)'),
      'the host reported the failing bundle under the plugin entry it inserted',
    );
    ok(probeOutput.includes(marker), 'the host executed the installed apply(), not some cached copy');

    // 2. The real package: the same boot path, no error naming the plugin.
    const realStage = mkdtempSync(join(tmpdir(), 'dsh-boot-real-'));
    const realPack = spawnSync('npm', ['pack', '--silent', '--pack-destination', realStage], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: true,
    });
    const realTarball = (realPack.stdout ?? '').split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
    ok(realTarball.endsWith('.tgz'), 'the real package packed into a tarball');
    makeProfile(app, REAL_PROFILE);
    addPlugin(app, REAL_PROFILE, join(realStage, realTarball));
    const realOutput = boot(app, REAL_PROFILE);
    ok(!realOutput.includes('context-rescue'), 'the real bundle mounted without an error of its own');
    ok(
      /MISSING_CREDENTIAL|no API key|answer/u.test(realOutput),
      'the boot proceeded past mounting to the model stage (this gate is about mounting)',
    );

    console.log(`boot check: ${assertions} assertions`);
  } finally {
    removeDir(probeDir);
    removeDir(realDir);
    for (const dir of [probeDir, realDir]) {
      if (existsSync(dir)) console.log(`boot check warning: ${dir} could not be removed`);
    }
  }
}

await main();
