#!/usr/bin/env node
/**
 * Repair a session log that an older version of this plugin wrote with a
 * bracket the host refuses to restore.
 *
 * dsh-context-rescue 0.2.0–0.2.4 wrote its zero-model fold as
 * `compaction/start → compaction/prune → checkpoint → compaction/end`, with no
 * `turn` on the bracket records when a tool call triggered the fold. The host
 * accepts that while the session is live and rejects it on the next restart
 * (`SessionFormatError: successful compaction/end requires one summary`, see
 * issue #1). The plugin cannot repair such a session from inside itself,
 * because the host refuses to load it — so this runs outside, on a copy, and
 * refuses to write anything the host's own restore validator will not accept.
 *
 * Usage:
 *   node scripts/repair-log.mjs --scan [dir]                     # which logs the host rejects
 *   node scripts/repair-log.mjs <session.v4.jsonl.zstd>          # dry run
 *   node scripts/repair-log.mjs <log> --write                    # copy beside it
 *   node scripts/repair-log.mjs <log> --write --out <path>
 *   node scripts/repair-log.mjs <log> --write --in-place --yes   # backs up first *
 * Run it through the app's Node when the plain one cannot read `app.asar`
 * (which is where the validator lives):
 *   node scripts/run-host-node.mjs scripts/repair-log.mjs <log> --write
 * @module dsh-context-rescue/scripts/repair-log
 */

import { copyFileSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadSessionLog, supportsZstd } from './session-log.mjs';
import { resolveHostRoot } from './host-paths.mjs';
import { planLogRepair } from '../lib/repair-log.js';

const USAGE = `usage: repair-log <session.v4.jsonl.zstd> [--write] [--out <path>] [--in-place --yes]
       repair-log --scan [dir]

  (no flag)        show what would be rewritten, and whether the host accepts it
  --write          write the repaired log beside the original
  --out <path>     write it to an exact path instead
  --in-place       replace the original; needs --yes and leaves a backup
  --scan [dir]     ask the host about every log under dir (default ~/.dsh/sessions)
  --dsh-root <p>   where DeepSeek Harness is installed: an app.asar file or a
                   directory holding node_modules/@deepseek-ai/*, e.g.
                   resources/app.asar or resources/app/dsh
                   (falls back to DSH_HOST_ROOT, DSH_ASAR, DSH_APP_ASAR, then
                   the usual install locations)
`;

/** @param {string} message */
function fail(message) {
  process.stderr.write(`repair-log: ${message}\n`);
  process.exit(1);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{file?: string, write: boolean, inPlace: boolean, yes: boolean, out?: string, scan: boolean, help: boolean, root?: string}} */
  const args = { write: false, inPlace: false, yes: false, scan: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--write') args.write = true;
    else if (arg === '--in-place') args.inPlace = true;
    else if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg === '--scan') args.scan = true;
    else if (arg === '--dsh-root') {
      const value = argv[index + 1];
      if (value === undefined) fail('--dsh-root needs a path');
      args.root = value;
      index += 1;
    } else if (arg === '--out') {
      const value = argv[index + 1];
      if (value === undefined) fail('--out needs a path');
      args.out = value;
      index += 1;
    } else if (arg.startsWith('--')) fail(`unknown flag ${arg}`);
    else if (args.file === undefined) args.file = arg;
    else fail(`unexpected argument ${arg}`);
  }
  return args;
}

/** `~` is the user's home, the way the host spells it in its own paths. */
function expandHome(value) {
  if (!value.startsWith('~')) return value;
  return path.join(homedir(), value.slice(1));
}

/** Every `session.v4.jsonl.zstd` under a directory, in a stable order. */
function findLogs(directory) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} current */
  const walk = (current) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') found.push(full);
    }
  };
  walk(directory);
  return found.sort();
}

/** Compress one frame the way the host reads it: JSONL inside zstd. */
function compress(text) {
  const zlib = createRequire(import.meta.url)('node:zlib');
  const compressSync = zlib.zstdCompressSync ?? zlib.zstdCompress;
  if (typeof compressSync !== 'function') {
    throw new Error('this Node build cannot write zstd (no zlib.zstdCompressSync); run it through the app\'s Node');
  }
  return compressSync(Buffer.from(text, 'utf8'));
}

/**
 * The inherited-event cut the host expects: the index of the last inherited
 * `session/end-seed` marker, or 0 for a log that was never seeded.
 * @param {any} header @param {any[]} events
 */
function inheritedEventCountOf(header, events) {
  if (header?.isSeeded !== true) return 0;
  let marker = 0;
  for (const [index, event] of events.entries()) {
    if (event?.type === 'session/end-seed' && event?.data?.inherited === true) marker = index;
  }
  return marker;
}

/**
 * Load the host's own restore validator out of an installed app bundle.
 * @param {string} [explicitRoot] a `--dsh-root` given on the command line
 */
async function loadHostFormat(explicitRoot) {
  const resolved = resolveHostRoot({ explicit: explicitRoot });
  const base = `${resolved.root}/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js`;
  const format = await import(pathToFileURL(base).href);
  const session = await import(pathToFileURL(`${resolved.root}/node_modules/@deepseek-ai/dsh-session/lib/index.js`).href);
  if (typeof format.restoreReleasedV4Artifact !== 'function' || typeof format.assertReleasedV4Relationships !== 'function') {
    throw new Error('the installed app has no v4 restore validator; this log cannot be checked here');
  }
  return { format, known: session.KNOWN_SESSION_EVENT_TYPES };
}

/** @param {{format: any, known: any}} host @param {any} header @param {any[]} events */
function checkWithHost(host, header, events) {
  const artifact = { header, inheritedEventCount: inheritedEventCountOf(header, events), events };
  host.format.restoreReleasedV4Artifact(artifact, host.known);
  host.format.assertReleasedV4Relationships(artifact, host.known);
}

/** @param {string} file */
function describe(file) {
  const bytes = statSync(file).size;
  return `${path.basename(file)} (${bytes.toLocaleString('en-US')} bytes)`;
}

/**
 * Ask the host about every log under a directory, and say which of the rejected
 * ones this tool can fix. Read-only: it never writes, renames or deletes.
 * @param {string} directory
 */
async function scan(directory, root) {
  const host = await loadHostFormat(root);
  const logs = findLogs(directory);
  if (logs.length === 0) fail(`no session logs under ${directory}`);

  let loadable = 0;
  /** @type {Array<{logPath: string, why: string, fixes: number, blocked: string[]}>} */
  const rejected = [];

  for (const logPath of logs) {
    /** @type {{header: any, events: any[]}} */
    let loaded;
    try {
      loaded = loadSessionLog(logPath);
    } catch (error) {
      rejected.push({ logPath, why: `unreadable: ${error?.message ?? error}`, fixes: 0, blocked: ['this log cannot even be decoded'] });
      continue;
    }
    if (loaded.header === undefined) {
      rejected.push({ logPath, why: 'no session header', fixes: 0, blocked: ['this file is not a v4 session log'] });
      continue;
    }
    const { type: _recordType, ...header } = loaded.header;
    try {
      checkWithHost(host, header, loaded.events);
      loadable += 1;
      continue;
    } catch (error) {
      const plan = planLogRepair(loaded.events);
      rejected.push({
        logPath,
        why: String(error?.message ?? error),
        fixes: plan.changes.length,
        blocked: plan.problems.map((problem) => `#${problem.seq} ${problem.type}: ${problem.why}`),
      });
    }
  }

  process.stdout.write(`scanning ${logs.length.toLocaleString('en-US')} logs under ${directory}\n\n`);
  for (const one of rejected) {
    process.stdout.write(`${one.logPath}\n`);
    process.stdout.write(`  the host rejects it: ${one.why}\n`);
    if (one.blocked.length > 0) {
      for (const why of one.blocked) process.stdout.write(`  not repairable: ${why}\n`);
    } else if (one.fixes > 0) {
      process.stdout.write(`  repairable: ${one.fixes} fix(es) — node scripts/repair-log.mjs "${one.logPath}" --write\n`);
    } else {
      process.stdout.write('  not repairable: the host rejects it for a reason this tool does not recognise\n');
    }
  }
  if (rejected.length > 0) process.stdout.write('\n');

  const repairable = rejected.filter((one) => one.blocked.length === 0 && one.fixes > 0).length;
  process.stdout.write(
    `${logs.length.toLocaleString('en-US')} logs · ${loadable.toLocaleString('en-US')} load · `
    + `${rejected.length.toLocaleString('en-US')} rejected (${repairable} repairable here)\n`,
  );
  if (rejected.length > 0 && repairable < rejected.length) {
    process.stdout.write('Logs this tool cannot fix need a human decision; attach the lines above to the issue.\n');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!supportsZstd()) fail('this Node cannot decode zstd; run it through scripts/run-host-node.mjs');
  if (args.scan) {
    await scan(expandHome(args.file ?? '~/.dsh/sessions'), args.root);
    return;
  }
  if (args.file === undefined) fail(`no log given\n\n${USAGE}`);

  const file = path.resolve(args.file);
  const { header: rawHeader, events } = loadSessionLog(file);
  if (rawHeader === undefined) fail(`${describe(file)} has no session header; is this a v4 session log?`);
  const { type: _recordType, ...header } = rawHeader;

  process.stdout.write(`repairing ${describe(file)}\n`);
  process.stdout.write(`  ${events.length.toLocaleString('en-US')} events\n`);

  const host = await loadHostFormat(args.root);

  let before;
  try {
    checkWithHost(host, header, events);
    before = 'the host accepts this log as it is';
  } catch (error) {
    before = `the host rejects this log: ${error?.message ?? error}`;
  }
  process.stdout.write(`  before: ${before}\n`);

  const plan = planLogRepair(events);

  for (const note of plan.notes) {
    process.stdout.write(`  note  #${note.seq}  ${note.note}\n`);
  }
  for (const change of plan.changes) {
    process.stdout.write(`  fix   #${change.seq} ${change.type}  ${change.what}\n`);
  }
  for (const problem of plan.problems) {
    process.stdout.write(`  STOP  #${problem.seq} ${problem.type}  ${problem.why}\n`);
  }

  if (plan.problems.length > 0) {
    process.stdout.write(
      `\n${plan.problems.length} problem(s) that no rewrite can fix. Nothing was written.\n`
      + 'Attach this output to the issue: a log in this shape needs a decision, not a guess.\n',
    );
    process.exitCode = 2;
    return;
  }

  if (plan.changes.length === 0) {
    process.stdout.write(`\n${before === 'the host accepts this log as it is' ? 'nothing to repair' : 'nothing this tool knows how to repair'}; nothing was written.\n`);
    if (before !== 'the host accepts this log as it is') process.exitCode = 2;
    return;
  }

  let after;
  try {
    checkWithHost(host, header, plan.events);
    after = 'the host accepts the repaired log';
  } catch (error) {
    after = `the repaired log is still rejected: ${error?.message ?? error}`;
  }
  process.stdout.write(`  after:  ${after}\n`);

  if (!args.write && !args.inPlace) {
    process.stdout.write('\ndry run: nothing was written. Add --write (copy beside the original) or --in-place --yes.\n');
    if (after !== 'the host accepts the repaired log') process.exitCode = 2;
    return;
  }

  if (after !== 'the host accepts the repaired log') {
    process.stdout.write('\nthe repaired log does not pass the host validator, so it was not written.\n');
    process.exitCode = 2;
    return;
  }

  const text = `${[rawHeader, ...plan.events].map((record) => JSON.stringify(record)).join('\n')}\n`;
  const bytes = compress(text);

  if (args.inPlace && !args.yes) {
    process.stdout.write('\n--in-place needs --yes. Nothing was written.\n');
    process.exitCode = 1;
    return;
  }

  /** @type {string} */
  let target;
  if (args.inPlace) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${file}.backup-${stamp}`;
    copyFileSync(file, backup);
    target = file;
    const temporary = `${file}.repairing`;
    writeFileSync(temporary, bytes);
    renameSync(temporary, file);
    process.stdout.write(`\nbackup  ${backup}\n`);
  } else if (args.out !== undefined) {
    target = path.resolve(args.out);
    writeFileSync(target, bytes);
  } else {
    target = file.replace(/\.jsonl\.zstd$/u, '') + '.repaired.v4.jsonl.zstd';
    if (target === file) target = `${file}.repaired`;
    writeFileSync(target, bytes);
  }

  // Re-read what landed on disk and check it again: a write that the host would
  // still reject is worse than no write, because it looks like a fix.
  const written = loadSessionLog(target);
  const { type: _writtenType, ...writtenHeader } = written.header ?? {};
  try {
    checkWithHost(host, writtenHeader, written.events);
  } catch (error) {
    fail(`the file just written does not pass the host validator: ${error?.message ?? error}`);
  }

  process.stdout.write(`wrote   ${describe(target)} (${written.events.length.toLocaleString('en-US')} events, verified)\n`);
  if (args.inPlace) {
    process.stdout.write('\nRestart the app now: the host will load the repaired log instead of rejecting it.\n');
  } else {
    process.stdout.write('\nThis is a copy. To use it, close the app and move it over the original:\n');
    process.stdout.write(`  mv "${target}" "${file}"\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`repair-log: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
