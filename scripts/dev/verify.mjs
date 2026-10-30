/**
 * Run the gates in the order a person would, and say which one failed.
 *
 * The repository has a lot of gates and the docs quote their numbers, but there was no single
 * command that ran them: you had to read `docs/PUBLISH.md` and type eleven scripts correctly.
 * This runs a group of them, streams their output, and ends with a table so a failure is
 * attributable to one line instead of "something in the middle was red".
 *
 *     npm run verify                # core: tests, types, simulation — no host, no network
 *     npm run verify:host           # everything that needs the installed app
 *     npm run verify:network        # everything that needs the registry or the repository
 *     npm run verify:all            # all three groups
 *
 *     node scripts/dev/verify.mjs --group host --only install-smoke,schema-check
 *
 * @module dsh-context-rescue/scripts/dev/verify
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

/** Each step names the npm script it runs, so the table uses the words from the docs. */
const STEPS = [
  { group: 'core', script: 'test', note: 'unit tests' },
  { group: 'core', script: 'typecheck', note: 'JSDoc contracts' },
  { group: 'core', script: 'simulate', note: 'the four failure shapes' },
  { group: 'host', script: 'test:host', note: 'the same tests under the app\'s Node' },
  { group: 'host', script: 'mount-check', note: 'inside the host cordis container' },
  { group: 'host', script: 'coexist', note: 'next to a compactor that answers first' },
  { group: 'host', script: 'install-smoke', note: 'packed, installed, patch resolved' },
  { group: 'host', script: 'schema-check', note: 'the host reads our config schema' },
  { group: 'host', script: 'e2e-install', note: 'the app CLI installs the tarball' },
  { group: 'host', script: 'boot-check', note: 'five profiles, one real web host' },
  { group: 'host', script: 'host-session', note: 'folds the captured logs twice each' },
  { group: 'host', script: 'scan', note: 'the full sweep over the same logs' },
  { group: 'network', script: 'e2e-install --git', note: 'installs the repository spec' },
  { group: 'network', script: 'e2e-install --npm', note: 'installs the registry spec' },
  { group: 'network', script: 'market-install', note: 'installs what a Discover page would' },
  { group: 'network', script: 'publish:rehearse', note: 'the publish flow against a bare repo' },
];

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : String(argv[index + 1] ?? fallback);
};

const group = argOf('group', 'core');
const only = argOf('only', '');
const onlyNames = only === '' ? undefined : new Set(only.split(',').map((name) => name.trim()));

const groups = group === 'all' ? ['core', 'host', 'network'] : [group];
const wanted = STEPS.filter((step) => groups.includes(step.group));
const chosen = onlyNames === undefined ? wanted : wanted.filter((step) => onlyNames.has(step.script));
if (chosen.length === 0) {
  process.stdout.write(`nothing to run for group "${group}"${only === '' ? '' : ` and --only ${only}`}\n`);
  process.exitCode = 2;
} else {
  process.stdout.write(`running ${chosen.length} gate(s) for ${groups.join(' + ')}\n`);
  if (groups.includes('host') || groups.includes('network')) {
    const app = process.env.DSH_APP_EXE ?? '';
    process.stdout.write(`  host gates need the installed app${app === '' ? ' (DSH_APP_EXE unset: the scripts look for it themselves)' : `: ${app}`}\n`);
  }

  const rows = [];
  const started = Date.now();
  for (const step of chosen) {
    const [script, ...rest] = step.script.split(' ');
    process.stdout.write(`\n=== npm run ${step.script} — ${step.note}\n`);
    const at = Date.now();
    const run = spawnSync('npm', ['run', '--silent', script, ...(rest.length === 0 ? [] : ['--', ...rest])], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: true,
      timeout: 1_800_000,
    });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    if (output.trim() !== '') process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    const ok = run.status === 0;
    rows.push({ script: step.script, note: step.note, ok, seconds: ((Date.now() - at) / 1000).toFixed(1) });
    if (!ok) process.stdout.write(`\n--- ${step.script} FAILED (exit ${String(run.status)})\n`);
  }

  const failed = rows.filter((row) => !row.ok);
  process.stdout.write('\n=== summary\n');
  for (const row of rows) {
    process.stdout.write(`  ${row.ok ? 'ok  ' : 'FAIL'} ${row.script.padEnd(22)} ${String(row.seconds).padStart(6)}s  ${row.note}\n`);
  }
  process.stdout.write(`\n${rows.length - failed.length}/${rows.length} gates passed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  if (failed.length > 0) {
    process.stdout.write(`failed: ${failed.map((row) => row.script).join(', ')}\n`);
    process.exitCode = 1;
  }
}
