#!/usr/bin/env node
/**
 * Fold every oversized session log on this machine, offline, and print the table
 * that `docs/PLAN.md` §5 quotes.
 *
 * This is the evidence gate behind the "it rescues real sessions, not just
 * fixtures" claim: it replays captured logs through the same `rescue()` the
 * listener calls, with no model in the loop, and fails loudly if an oversized
 * session survives without being brought under the window.
 *
 *     node scripts/dev/scan-sessions.mjs                       # all logs under ~/.dsh/sessions
 *     node scripts/dev/scan-sessions.mjs --dir <sessions dir>  # a workspace key such as --H-AI--
 *     node scripts/dev/scan-sessions.mjs --window 200000
 * @module dsh-context-rescue/scripts/dev/scan-sessions
 */

import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { loadSessionLog, reconstructSurface } from './session-log.mjs';
import { ReplaySession, allLogsUnder, expandHome } from './replay-session.mjs';
import { fakeMeter } from '../../tests/fake-session.js';
import { fits, measure } from '../../lib/measure.js';
import { resolveConfig } from '../../lib/config.js';
import { rescue } from '../../lib/rescue.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const root = expandHome(flag('dir', join(process.env.USERPROFILE ?? process.env.HOME ?? '~', '.dsh', 'sessions')));
const window = Number(flag('window', '196608'));
if (!existsSync(root)) {
  process.stdout.write(`no session logs at ${root}\n`);
  process.exit(0);
}

const logs = statSync(root).isDirectory() ? allLogsUnder(root) : [root];
const config = resolveConfig({});

let rescued = 0;
let skipped = 0;
let failed = 0;
const rows = [];

for (const log of logs) {
  const label = basename(dirname(log));
  let loaded;
  try {
    loaded = loadSessionLog(log);
  } catch (error) {
    rows.push({ label, state: `unreadable: ${String(error).slice(0, 60)}` });
    continue;
  }
  const surface = reconstructSurface(loaded.events).surface;
  if (surface.length <= 20) {
    skipped += 1;
    rows.push({ label, state: `skip (${surface.length} nodes)`, before: '—', after: '—' });
    continue;
  }

  const session = new ReplaySession(loaded.events, surface);
  const meter = fakeMeter();
  const ctx = { tokenMeter: meter, get: (name) => (name === 'tokenMeter' || name === undefined ? meter : undefined) };
  const before = measure(ctx, session);
  if (fits(before.totalTokens, window, config.fitRatio)) {
    skipped += 1;
    rows.push({ label, state: 'skip (already fits)', before: before.totalTokens.toLocaleString('en-US'), after: '—' });
    continue;
  }

  const failure = {
    code: 'INVALID_REQUEST',
    message: `payload core text alone is ~${before.totalTokens} bytes; that is >= ~${before.totalTokens} tokens vs the model window ${window} - no upstream can accept it`,
  };
  const report = await rescue(ctx, {
    agent: { id: label, session },
    session,
    failure,
    turn: 1,
    config,
  });
  const after = measure(ctx, session);
  const ok = report.action === 'retry' && fits(after.totalTokens, window, config.fitRatio);
  if (ok) rescued += 1;
  else failed += 1;
  rows.push({
    label,
    state: ok ? 'rescued' : `FAILED: ${report.reason}`,
    before: before.totalTokens.toLocaleString('en-US'),
    after: after.totalTokens.toLocaleString('en-US'),
    tier: report.tiers.filter((tier) => tier.ok).map((tier) => tier.tier).join('+') || '—',
  });
}

const width = Math.max(...rows.map((row) => (row.label ?? '').length), 8);
process.stdout.write(`${'session'.padEnd(width)}  ${'state'.padEnd(28)}  ${'before'.padStart(10)}  ${'after'.padStart(9)}  tier\n`);
for (const row of rows) {
  process.stdout.write(
    `${String(row.label).padEnd(width)}  ${String(row.state).padEnd(28)}  ${String(row.before ?? '').padStart(10)}  ${String(row.after ?? '').padStart(9)}  ${row.tier ?? ''}\n`,
  );
}
process.stdout.write(
  `\n${logs.length} logs · ${rescued} rescued · ${skipped} skipped · ${failed} failed (window ${window.toLocaleString('en-US')})\n`,
);

process.exitCode = failed === 0 ? 0 : 1;
