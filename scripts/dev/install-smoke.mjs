/**
 * Installs this package the way a user would get it — packed, then installed as a dependency
 * in a throwaway project — and asks the host's own bundle loader to resolve it there.
 *
 * This is the gap the other gates leave. `mount-check` loads `index.js` from the source tree;
 * a real install goes through `npm pack` (so `package.json` `files` decides what exists), a
 * dependency install, and bundle-patch resolution on the *installed* path. A file missing from
 * `files`, or a patch path resolved relative to the wrong directory, breaks the install and
 * nothing else in this repository would notice.
 *
 * Run with any Node:  node scripts/dev/install-smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');

function npm(args, cwd) {
  return execFileSync('npm', args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_yes: 'true' },
  }).trim();
}

/** The host loader needs Electron's fs to read inside `app.asar`. */
async function hostLoader() {
  const asar =
    process.env.DSH_APP_ASAR ??
    [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/DSH NEXT/resources/app.asar'),
      process.env.DSH_APP_EXE && path.join(path.dirname(process.env.DSH_APP_EXE), 'resources/app.asar'),
    ].filter(Boolean).find((candidate) => fs.existsSync(candidate));
  if (asar === undefined) return undefined;
  const entry = path.join(asar, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
  if (!fs.existsSync(entry)) return undefined;
  return import(`file://${entry.replaceAll('\\', '/')}`);
}

async function main() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rescue-install-'));
  const failures = [];
  const check = (label, condition, detail) => {
    if (condition) process.stdout.write(`  ok   ${label}\n`);
    else {
      failures.push(label);
      process.stdout.write(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
    }
  };

  let tarball;
  try {
    const packed = npm(['pack', '--silent'], ROOT);
    const name = packed.split('\n').filter((line) => line.endsWith('.tgz')).pop();
    tarball = path.join(ROOT, name ?? '');
    check('npm pack produces a tarball', tarball !== '' && fs.existsSync(tarball), name);

    const listing = npm(['pack', '--dry-run', '--json'], ROOT);
    const files = JSON.parse(listing)[0].files.map((file) => file.path);
    check('the tarball carries index.js', files.includes('index.js'));
    check('the tarball carries the bundle patch', files.includes('cordis.patch.yml'));
    check('the tarball carries lib/ and the icon', files.some((f) => f.startsWith('lib/')) && files.includes('market/icon.svg'));
    check(
      'the generated index entry stays out of the package',
      !files.includes('market/index.json'),
      'it must pin the commit it is pushed with, so it is produced per release instead',
    );
    check('the tarball excludes tests/ and scripts/', !files.some((f) => f.startsWith('tests/') || f.startsWith('scripts/')));

    fs.writeFileSync(
      path.join(workdir, 'package.json'),
      `${JSON.stringify({ name: 'rescue-install-smoke', private: true, version: '1.0.0' }, undefined, 2)}\n`,
    );
    npm(['install', '--no-audit', '--no-fund', tarball], workdir);

    const installed = path.join(workdir, 'node_modules/dsh-context-rescue');
    check('the package installs as a dependency', fs.existsSync(installed));

    const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    check('the installed manifest declares a bundle patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml');

    const appBoot = await hostLoader();
    if (appBoot === undefined) {
      process.stdout.write('  skip host loader (set DSH_APP_ASAR to an installed app.asar)\n');
    } else {
      const patches = appBoot.bundlePatchPaths(installed, manifest.dsh.bundle);
      check('the host loader resolves the patch from the installed package', patches.length === 1, JSON.stringify(patches));
      const overlays = await appBoot.loadOverlayPatches('dsh', patches[0]);
      const entries = overlays.flatMap((overlay) => overlay.insert ?? []);
      check(
        'the patch inserts the context-rescue entry',
        entries.some((entry) => entry.id === 'context-rescue' && entry.name === 'dsh-context-rescue'),
        JSON.stringify(entries),
      );
    }

    const entry = await import(`file://${path.join(installed, 'index.js').replaceAll('\\', '/')}`);
    check(
      'the installed entry exports name/inject/apply',
      entry.name === 'context-rescue' && Array.isArray(entry.inject) && typeof entry.apply === 'function',
    );

    const libRescue = await import(`file://${path.join(installed, 'lib/rescue.js').replaceAll('\\', '/')}`);
    check('the installed lib/ is importable on its own', typeof libRescue.rescue === 'function');
  } finally {
    if (tarball !== undefined && fs.existsSync(tarball)) fs.rmSync(tarball, { force: true });
    fs.rmSync(workdir, { recursive: true, force: true });
  }

  process.stdout.write(
    failures.length === 0 ? '\ninstall smoke passed\n' : `\ninstall smoke FAILED: ${failures.join('; ')}\n`,
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}

await main();
