/**
 * Mount the plugin next to the host's *real* compaction engine.
 *
 * `mount-check` stands a no-op `HostCompaction` in the compaction slot, which
 * proves the plugin yields to whoever owns it. This gate goes one step further
 * and mounts `@deepseek-ai/dsh-compaction-basic` — the engine that owns the slot
 * in a stock profile — so the borrowed call goes through production code rather
 * than a stub, and so a broken borrow cannot hide behind it.
 *
 * Run with the app's own Node (it reads `app.asar`):
 *
 *     npm run coexist
 * @module dsh-context-rescue/scripts/dev/coexist-check
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { FakeSession, seedConversation } from '../../tests/fake-session.js';
import { measure } from '../../lib/measure.js';
import { rescue, rescueStateOf } from '../../lib/rescue.js';
import { resolveConfig } from '../../lib/config.js';
import { hasOpenCompactionTransaction, pairingCuts, planFold } from '../../lib/plan.js';

import { dshAsarCandidates } from '../host-paths.mjs';

const ASAR = dshAsarCandidates().find((candidate) => existsSync(candidate));
if (ASAR === undefined) throw new Error('Cannot find an installed DSH; set DSH_APP_ASAR.');
const cordisEntry = join(ASAR, 'node_modules/@deepseek-ai/cordis/lib/index.js');
const engineEntry = join(ASAR, 'node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js');

const failures = [];
const check = (label, condition, detail) => {
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    process.stdout.write(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
    failures.push(label);
  }
};

const { Context, Service } = await import(pathToFileURL(cordisEntry).href);
const { BasicCompactionEngine } = await import(pathToFileURL(engineEntry).href);
const plugin = await import(new URL('../../index.js', import.meta.url).href);

process.stdout.write('1. mount the host compaction engine, then the plugin\n');

class LlmService extends Service {
  constructor(ctx) {
    super(ctx, 'llm');
  }

  resolveModelInfo() {
    throw new Error('no model is available in this gate');
  }

  // The engine must not be able to summarize here: this gate is about the
  // plugin surviving a borrow that fails, not about the engine's own quality.
  async *stream() {
    throw new Error('no model is available in this gate');
  }
}

class TokenMeterService extends Service {
  constructor(ctx) {
    super(ctx, 'tokenMeter');
  }

  // Return the whole measurement, nodes included: the planner needs the node
  // list to know which surface events it is pricing.
  measure(session) {
    return measure(root, session);
  }
}

class SessionsService extends Service {
  constructor(ctx) {
    super(ctx, 'sessions');
  }

  get() {
    return undefined;
  }
}

const root = new Context();
root.plugin(LlmService);
root.plugin(TokenMeterService);
root.plugin(SessionsService);
root.plugin(BasicCompactionEngine, {});
await new Promise((resolve) => setTimeout(resolve, 100));

check('the host engine owns the compaction slot', root.get('compaction')?.constructor?.name === 'BasicCompactionEngine', String(root.get('compaction')?.constructor?.name));

root.plugin(plugin, { verbose: false, registerTools: false });
await new Promise((resolve) => setTimeout(resolve, 100));

check('the plugin mounted beside it', root.get('compaction')?.constructor?.name === 'BasicCompactionEngine');
check('the plugin does not inject the compaction service', !plugin.inject.includes('compaction'), JSON.stringify(plugin.inject));

process.stdout.write('2. rescue with the real engine in the slot\n');

const session = new FakeSession();
seedConversation(session, { turns: 24, chars: 9000 });
const config = resolveConfig({});
const before = measure(root, session).totalTokens;
const report = await rescue(root, {
  agent: { session },
  session,
  failure: {
    code: 'INVALID_REQUEST',
    message: "Command Code API error 400: the request exceeds the model's context window",
  },
  provider: 'p',
  config,
});

check('the failure was classified as an overflow', report.detected.overflow === true);
check('the projection was measured beyond the window', before > report.window.windowTokens, `${before} vs ${report.window.windowTokens}`);
check('the rescue asks the host for a retry', report.action === 'retry');
const hostTier = report.tiers.find((tier) => tier.tier === 'host-compaction');
check('the borrowed engine was asked before the zero-model path', hostTier !== undefined && report.tiers.indexOf(hostTier) < report.tiers.length - 1, JSON.stringify(report.tiers.map((tier) => tier.tier)));
check('a borrow that cannot summarize is not treated as a rescue', hostTier?.ok === false);
check('the zero-model fold finished the job', report.tiers.at(-1)?.tier === 'mechanical-fold' && report.fold?.ok === true);
check('the folded projection fits', report.after.totalTokens <= report.window.windowTokens * config.fitRatio, `${report.after.totalTokens}`);
check('the compaction transaction is closed', hasOpenCompactionTransaction(session.events) === false);
check('the lane is not marked blocked (that is only for a proxy refusal)', rescueStateOf({ session }).laneBlocked === false);

process.stdout.write('3. the engine still works afterwards\n');

const engine = root.get('compaction');
check('the engine is still the slot holder', engine?.constructor?.name === 'BasicCompactionEngine');
let threw = 'no error';
try {
  await engine.compactIfNeeded({ session }, 'context-overflow');
} catch (error) {
  threw = String(error?.message);
}
check('calling it again does not corrupt the container', root.get('compaction')?.constructor?.name === 'BasicCompactionEngine', threw);

process.stdout.write(failures.length === 0 ? '\ncoexistence passed\n' : `\n${failures.length} failure(s)\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
