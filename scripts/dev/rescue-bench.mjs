#!/usr/bin/env node
/**
 * How long a rescue actually takes.
 *
 * The listener runs inside an error path: the turn is already waiting for the
 * retry, so an unbounded rescue would trade a context-window failure for a
 * visible stall. Nothing so far measured the cost of measuring, planning and
 * folding a real session, so this script times the whole ladder on the largest
 * logs this machine has and prints the distribution.
 *
 *     node scripts/dev/rescue-bench.mjs                 # 20 largest logs
 *     node scripts/dev/rescue-bench.mjs --count 50
 *     node scripts/dev/rescue-bench.mjs --window 196608
 * @module dsh-context-rescue/scripts/dev/rescue-bench
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

import { loadSessionLog, reconstructSurface } from './session-log.mjs';
import { ReplaySession, allLogsUnder, expandHome } from './replay-session.mjs';
import { fakeMeter } from '../../tests/fake-session.js';
import { measure } from '../../lib/measure.js';
import { resolveConfig } from '../../lib/config.js';
import { preflight, rescue } from '../../lib/rescue.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const root = expandHome(join(process.env.USERPROFILE ?? process.env.HOME ?? '~', '.dsh', 'sessions'));
const window = Number(flag('window', '196608'));
const wanted = Number(flag('count', '20'));
const config = resolveConfig({});

const logs = allLogsUnder(root)
  .map((path) => ({ path, size: statSync(path).size }))
  .sort((left, right) => right.size - left.size)
  .slice(0, wanted);

/** @type {Array<{label: string, nodes: number, tokens: number, ms: number, cold: number, warm: number, action: string}>} */
const rows = [];

for (const log of logs) {
  let loaded;
  let surface;
  try {
    loaded = loadSessionLog(log.path);
    surface = reconstructSurface(loaded.events).surface;
  } catch {
    continue;
  }
  if (surface.length <= 20) continue;

  const session = new ReplaySession(loaded.events, surface);
  const meter = fakeMeter();
  const ctx = { tokenMeter: meter, get: () => meter };
  const before = measure(ctx, session);
  if (before.totalTokens <= window) continue;

  const failure = {
    code: 'INVALID_REQUEST',
    message: `payload core text alone is ~${before.totalTokens} tokens vs the model window ${window} - no upstream can accept it`,
  };
  const started = process.hrtime.bigint();
  const report = await rescue(ctx, { agent: { id: log.path, session }, session, failure, turn: 1, config, force: true });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // The pre-flight hook runs on every step, so the interesting number is the
  // second call: after one measurement the rest of the turn rides on the delta.
  const fresh = new ReplaySession(loaded.events, surface);
  const freshAgent = { id: log.path, session: fresh };
  const coldStart = process.hrtime.bigint();
  await preflight(ctx, { agent: freshAgent, session: fresh, config });
  const cold = Number(process.hrtime.bigint() - coldStart) / 1e6;
  const warmStart = process.hrtime.bigint();
  await preflight(ctx, { agent: freshAgent, session: fresh, config });
  const warm = Number(process.hrtime.bigint() - warmStart) / 1e6;

  rows.push({
    label: log.path.split(/[\\/]/u).slice(-2, -1)[0] ?? log.path,
    nodes: surface.length,
    tokens: before.totalTokens,
    ms: Math.round(ms),
    cold: Math.round(cold),
    warm: Math.round(warm),
    action: report.action,
  });
}

if (rows.length === 0) {
  process.stdout.write(`no oversized sessions under ${root}\n`);
  process.exit(0);
}

rows.sort((left, right) => right.ms - left.ms);
process.stdout.write(`${'session'.padEnd(24)} ${'nodes'.padStart(6)} ${'tokens'.padStart(12)} ${'ms'.padStart(7)} ${'cold'.padStart(6)} ${'warm'.padStart(6)}  action\n`);
for (const row of rows) {
  process.stdout.write(
    `${row.label.slice(0, 24).padEnd(24)} ${String(row.nodes).padStart(6)} ${row.tokens.toLocaleString('en-US').padStart(12)} ${String(row.ms).padStart(7)} ${String(row.cold).padStart(6)} ${String(row.warm).padStart(6)}  ${row.action}\n`,
  );
}

const times = rows.map((row) => row.ms).sort((left, right) => left - right);
const median = times[Math.floor(times.length / 2)];
const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
const pick = (key) => {
  const values = rows.map((row) => row[key]).sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)];
};
process.stdout.write(
  `\n${rows.length} oversized sessions · rescue median ${median} ms · p95 ${p95} ms · max ${times[times.length - 1]} ms\n`,
);
process.stdout.write(
  `pre-flight median: cold ${pick('cold')} ms · warm ${pick('warm')} ms (warm is one measurement-free delta count)\n`,
);
