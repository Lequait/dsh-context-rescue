/**
 * Prove the repair tool on a log that is broken in exactly the way issue #1
 * describes: build the bracket 0.2.0–0.2.4 wrote, show the host rejects it,
 * run the CLI, and show the host accepts what the CLI wrote.
 *
 * The fixture is built from a real log's header, because the host validates the
 * header too and a synthetic one is missing `cwd`/`delegationDepth`.
 *
 * Run through the app's Node (`npm run repair-check`).
 * @module dsh-context-rescue/scripts/dev/repair-check
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadSessionLog } from '../session-log.mjs';
import { dshAsarCandidates } from '../host-paths.mjs';
import { allLogsUnder, expandHome } from './replay-session.mjs';

const zlib = createRequire(import.meta.url)('node:zlib');

/** @param {string} message */
function ok(message) {
  process.stdout.write(`  ok ${message}\n`);
}

async function loadHost() {
  const asar = dshAsarCandidates().find((candidate) => candidate !== '');
  if (asar === undefined) throw new Error('no DSH app.asar found; set DSH_ASAR');
  const format = await import(pathToFileURL(`${asar}/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js`).href);
  const session = await import(pathToFileURL(`${asar}/node_modules/@deepseek-ai/dsh-session/lib/index.js`).href);
  return { format, known: session.KNOWN_SESSION_EVENT_TYPES };
}

/** @param {{format: any, known: any}} host @param {any} header @param {any[]} events */
function hostAccepts(host, header, events) {
  const artifact = { header, inheritedEventCount: 0, events };
  host.format.restoreReleasedV4Artifact(artifact, host.known);
  host.format.assertReleasedV4Relationships(artifact, host.known);
}

/** A header the host accepts, taken from a log that was never seeded. */
function realHeader() {
  const directory = expandHome(process.env.DSH_SESSIONS_DIR ?? '~/.dsh/sessions');
  for (const logPath of allLogsUnder(directory)) {
    try {
      const { header } = loadSessionLog(logPath);
      if (header === undefined || header.isSeeded === true) continue;
      const { type: _recordType, ...rest } = header;
      return rest;
    } catch {
      // A log this process cannot read is not a header source.
    }
  }
  throw new Error(`no unseeded session log under ${directory} to take a header from`);
}

/** The bracket 0.2.0-0.2.4 wrote: a prune instead of a summary, and no turn. */
function brokenEvents() {
  return [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'the oldest message' }], source: { kind: 'user' } },
      surfaceOp: 'append',
    },
    { type: 'compaction/start', seq: 2, data: { compactionId: 'rescue-fixture' } },
    {
      type: 'compaction/prune',
      seq: 3,
      data: { shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 4321 },
    },
    {
      type: 'user/message',
      seq: 4,
      data: {
        id: 'rescue-checkpoint-rescue-fixture',
        role: 'user',
        content: [{ type: 'text', text: '## 摘要\n- 折叠了 1 条消息' }],
        source: { kind: 'compact-checkpoint', compactionId: 'rescue-fixture' },
      },
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
      sourceEventSeqs: [2, 3, 1],
    },
    { type: 'compaction/end', seq: 5, data: { compactionId: 'rescue-fixture' } },
    { type: 'turn/end', seq: 6, data: { turn: 1 } },
  ];
}

/** @param {string} file @param {any} header @param {any[]} events */
function writeLog(file, header, events) {
  const text = `${[{ type: 'session', ...header }, ...events].map((record) => JSON.stringify(record)).join('\n')}\n`;
  writeFileSync(file, zlib.zstdCompressSync(Buffer.from(text, 'utf8')));
}

/** @param {string[]} args */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'repair-log.mjs'), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

async function main() {
  const host = await loadHost();
  const header = realHeader();
  const directory = mkdtempSync(path.join(tmpdir(), 'rescue-repair-'));
  const broken = path.join(directory, 'session.v4.jsonl.zstd');
  const repaired = path.join(directory, 'session.repaired.v4.jsonl.zstd');

  try {
    writeLog(broken, header, brokenEvents());
    ok('built a log with the 0.2.4 bracket');

    let rejected = '';
    try {
      hostAccepts(host, header, brokenEvents());
    } catch (error) {
      rejected = String(error?.message ?? error);
    }
    assert.match(
      rejected,
      /requires one summary|non-negative safe integer/u,
      `the fixture did not reproduce issue #1: ${rejected || 'the host accepted it'}`,
    );
    ok(`the host rejects it: ${rejected}`);

    const dry = runCli([broken]);
    assert.equal(dry.status, 0, `the dry run failed: ${dry.stdout}${dry.stderr ?? ''}`);
    assert.match(dry.stdout, /the host rejects this log/u);
    assert.match(dry.stdout, /the host accepts the repaired log/u);
    assert.match(dry.stdout, /dry run: nothing was written/u);
    assert.equal(readFileSync(broken).length > 0, true);
    ok('the dry run reports the fix and writes nothing');

    const inPlaceWithoutYes = runCli([broken, '--in-place']);
    assert.equal(inPlaceWithoutYes.status, 1, '--in-place without --yes should refuse');
    assert.match(inPlaceWithoutYes.stdout, /--in-place needs --yes/u);
    ok('--in-place without --yes refuses');

    const write = runCli([broken, '--write', '--out', repaired]);
    assert.equal(write.status, 0, `the write failed: ${write.stdout}${write.stderr ?? ''}`);
    assert.match(write.stdout, /verified/u);
    ok('the CLI wrote a repaired copy');

    const after = loadSessionLog(repaired);
    const { type: _recordType, ...afterHeader } = after.header;
    hostAccepts(host, afterHeader, after.events);
    ok('the host accepts the repaired log');

    const summary = after.events.find((event) => event.type === 'compaction/summary');
    assert.ok(summary !== undefined, 'the repaired log has no summary');
    assert.deepEqual(summary.data.summary, [{ type: 'text', text: '## 摘要\n- 折叠了 1 条消息' }]);
    const start = after.events.find((event) => event.type === 'compaction/start');
    const end = after.events.find((event) => event.type === 'compaction/end');
    assert.equal(start.data.turn, 1);
    assert.equal(end.data.turn, 1);
    ok('the bracket now carries a summary and its turn');

    const checkpoint = after.events.find((event) => event?.data?.source?.kind === 'compact-checkpoint');
    assert.deepEqual(checkpoint.sourceEventSeqs, [2, 3, 1]);
    ok('the checkpoint still names every record it covers');

    const inPlace = runCli([broken, '--in-place', '--yes']);
    assert.equal(inPlace.status, 0, `the in-place repair failed: ${inPlace.stdout}${inPlace.stderr ?? ''}`);
    assert.match(inPlace.stdout, /backup {2}/u);
    const backup = inPlace.stdout.split('\n').find((line) => line.startsWith('backup  '))?.slice('backup  '.length).trim();
    assert.ok(backup !== undefined && backup !== '', 'no backup path was printed');
    const restored = loadSessionLog(broken);
    const { type: _brokenType, ...restoredHeader } = restored.header;
    hostAccepts(host, restoredHeader, restored.events);
    ok('--in-place --yes repaired the original and left a backup');
    assert.equal(readFileSync(backup).length > 0, true);

    process.stdout.write('repair check passed\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`repair check failed: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
