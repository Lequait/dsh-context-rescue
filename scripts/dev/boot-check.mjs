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
 * Two more stages boot the same bundle next to other plugins that touch
 * compression: the proxy that owns the lane (billion-context) and the one that
 * overrides the engine (dsh-smart-compact). Those stages rule out composition
 * conflicts, which no unit test can observe.
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
const PAIRED_PROFILE = `rescue-boot-pair-${Date.now().toString(36)}`;
const SLOT_PROFILE = `rescue-boot-slot-${Date.now().toString(36)}`;
const WEB_PROFILE = `rescue-boot-web-${Date.now().toString(36)}`;
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

function makeProfile(app, name, template = 'headless') {
  const created = cli(app, ['--profile', name, '--from-default-profile', template, '--dump-config']);
  ok(created.status === 0, `the host created a throwaway profile ${name} from the ${template} template`);
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
  const pairedDir = join(profilesDir, PAIRED_PROFILE);
  const slotDir = join(profilesDir, SLOT_PROFILE);
  const webDir = join(profilesDir, WEB_PROFILE);
  const compactStage = mkdtempSync(join(tmpdir(), 'dsh-smart-compact-'));

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

    // 3. The same bundle next to the proxy that owns the compression lane on
    //    some machines. What can go wrong here is composition, so the
    //    assertions are about the composed tree and about a boot that reports
    //    no error of its own.
    makeProfile(app, PAIRED_PROFILE);
    const laneOwner = cli(app, ['plugin', '--profile', PAIRED_PROFILE, 'add', 'billion-context@0.1.209']);
    if (laneOwner.status !== 0) {
      console.log('  skip the billion-context pairing (it could not be installed from this network)');
    } else {
      addPlugin(app, PAIRED_PROFILE, join(realStage, realTarball));
      const dump = cli(app, ['--profile', PAIRED_PROFILE, '--dump-config']);
      const tree = String(dump.stdout ?? '');
      const gateIndex = tree.indexOf('name: billion-context/dsh-compaction-gate');
      const oursIndex = tree.indexOf('- id: context-rescue');
      ok(gateIndex !== -1, 'the compression lane owner composes into the profile');
      ok(oursIndex !== -1, 'the rescue plugin composes into the same profile');
      ok(oursIndex > gateIndex, 'the rescue plugin composes after the lane owner');
      const pairedOutput = boot(app, PAIRED_PROFILE);
      ok(
        !pairedOutput.includes('context-rescue (dsh-context-rescue)'),
        'the bundle mounts next to billion-context without an error of its own',
      );
      ok(
        /MISSING_CREDENTIAL|no API key|answer/u.test(pairedOutput),
        'the paired boot proceeded past mounting to the model stage',
      );
    }

    // 4. The same bundle next to the plugin that overrides the compaction
    //    engine. Both of them influence the same service, and only one may
    //    provide it; the failure this stage rules out is a composition conflict,
    //    not a behaviour of either plugin.
    makeProfile(app, SLOT_PROFILE);
    const fetched = spawnSync(
      'npm',
      ['pack', 'dsh-smart-compact@0.5.3', '--registry', 'https://registry.npmjs.org/', '--silent'],
      { cwd: compactStage, encoding: 'utf8', shell: true },
    );
    const fetchedName = String(fetched.stdout ?? '').trim().split(String.fromCharCode(10)).filter(Boolean).at(-1);
    if (fetched.status !== 0 || fetchedName === undefined) {
      console.log('  skip the smart-compact pairing (it could not be fetched from the registry)');
    } else {
      const installed = cli(app, ['plugin', '--profile', SLOT_PROFILE, 'add', join(compactStage, fetchedName)]);
      if (installed.status !== 0) {
        console.log('  skip the smart-compact pairing (the app CLI refused the tarball)');
      } else {
        addPlugin(app, SLOT_PROFILE, join(realStage, realTarball));
        const slotDump = String(cli(app, ['--profile', SLOT_PROFILE, '--dump-config']).stdout ?? '');
        ok(slotDump.includes('dsh-smart-compact'), 'the engine-overriding plugin composes into the profile');
        ok(slotDump.includes('- id: context-rescue'), 'the rescue plugin composes into the same profile');
        const slotOutput = boot(app, SLOT_PROFILE);
        ok(
          !slotOutput.includes('context-rescue (dsh-context-rescue)'),
          'the bundle mounts next to an engine-overriding plugin without an error of its own',
        );
        ok(
          /MISSING_CREDENTIAL|no API key|answer/u.test(slotOutput),
          'the slot-sharing boot proceeded past mounting to the model stage',
        );
      }
    }

    // 5. The shape users actually run. `--from-default-profile web` seeds the same tree the
    //    desktop app composes -- including the client bundles that render the command surface --
    //    and it is a different tree from `headless`, so the entry has to land here as well.
    //    Asserting the GUI command bundle is present keeps this from passing on an empty shell.
    makeProfile(app, WEB_PROFILE, 'web');
    addPlugin(app, WEB_PROFILE, join(realStage, realTarball));
    const webDump = cli(app, ['--profile', WEB_PROFILE, '--dump-config']);
    const webTree = `${webDump.stdout ?? ''}
${webDump.stderr ?? ''}`;
    ok(webDump.status === 0, 'the web-shaped profile still validates after the plugin is added');
    ok(webTree.includes('- id: context-rescue'), 'the plugin is composed into the web shape, not just headless');
    ok(
      webTree.includes('@deepseek-ai/dsh-client-ui-commands'),
      'this really is the web shape: the bundle that renders commands is in the same tree',
    );

    console.log(`boot check: ${assertions} assertions`);
  } finally {
    removeDir(probeDir);
    removeDir(realDir);
    removeDir(pairedDir);
    removeDir(slotDir);
    removeDir(webDir);
    removeDir(compactStage);
    for (const dir of [probeDir, realDir, pairedDir, slotDir, webDir]) {
      if (existsSync(dir)) console.log(`boot check warning: ${dir} could not be removed`);
    }
  }
}

await main();
