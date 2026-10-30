/**
 * Load the plugin into the host's real cordis container and drive one rescue.
 *
 * `node --test` runs against a hand-rolled context; this script runs against
 * `@deepseek-ai/cordis` 4 from the installed app, so it proves the parts a fake
 * context cannot: the `inject`/`Service` wiring, `ctx.plugin()` mounting, the
 * `ctx.waterfall('agent/request-error', …, next)` dispatch shape, the tools
 * service contract, and that the plugin leaves the host's compaction slot alone.
 *
 * Run it with the app's own Node:
 *
 *     ELECTRON_RUN_AS_NODE=1 "…/DSH NEXT.exe" scripts/dev/mount-check.mjs
 * @module dsh-context-rescue/scripts/dev/mount-check
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { FakeSession, fakeMeter, seedConversation } from '../../tests/fake-session.js';
import { measure } from '../../lib/measure.js';
import { rescue, rescueStateOf } from '../../lib/rescue.js';
import { resolveConfig } from '../../lib/config.js';

import { dshAsarCandidates } from '../host-paths.mjs';

const ASAR = dshAsarCandidates().find((candidate) => existsSync(candidate));
if (ASAR === undefined) throw new Error('Cannot find an installed DSH; set DSH_APP_ASAR.');
const cordisEntry = join(ASAR, 'node_modules/@deepseek-ai/cordis/lib/index.js');

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
const plugin = await import(new URL('../../index.js', import.meta.url).href);

process.stdout.write('1. mount into the host container\n');

const registered = [];
class ToolsService extends Service {
  constructor(ctx) {
    super(ctx, 'tools');
  }

  register(definition) {
    registered.push(definition);
    return () => {
      const index = registered.indexOf(definition);
      if (index >= 0) registered.splice(index, 1);
    };
  }
}

const root = new Context();
root.plugin(ToolsService);

// Stand in for whatever owns the host compaction slot in a real profile
// (compaction-basic, or dsh-smart-compact when it is installed). It no-ops on
// purpose: the point is that the plugin yields to it and still rescues.
let hostCompactionCalls = 0;
let hostCompaction;
class HostCompaction extends Service {
  constructor(ctx) {
    super(ctx, 'compaction');
    hostCompaction = this;
  }

  async compactIfNeeded() {
    hostCompactionCalls += 1;
  }
}
root.plugin(HostCompaction);

// cordis exposes services through a proxy, so identity has to be captured before
// the plugin mounts and compared afterwards.
await new Promise((resolve) => setTimeout(resolve, 50));
const hostCompactionSlot = root.get('compaction');

root.plugin(plugin, { verbose: false, registerTools: true });
await new Promise((resolve) => setTimeout(resolve, 50));

check('plugin mounted without throwing', true);
check('tools registered through the real service', registered.length === 3, `got ${registered.length}`);
check('tool names', registered.map((tool) => tool.name).join(',') === 'context_rescue,context_rescue_estimate,context_rescue_fold', registered.map((tool) => tool.name).join(','));

process.stdout.write('2. drive an overflow through the real waterfall\n');

/** A session shaped like a real one, with the meter the plugin looks for. */
const session = new FakeSession();
seedConversation(session, { turns: 24, chars: 9000 });
const meter = fakeMeter();
const agent = { session, id: 'load-test' };
const measured = measure({ tokenMeter: meter, get: () => meter }, session);

const payload = {
  agent,
  turn: 7,
  step: 2,
  provider: 'openrouter',
  failure: {
    code: 'INVALID_REQUEST',
    message: `payload core text alone is ~${Math.round(measured.totalTokens * 3.1)} bytes; that is ≥ ~${measured.totalTokens} tokens vs the model window 196608 — no upstream can accept it`,
  },
};

const before = session.surface.nodes.length;
const action = await root.waterfall('agent/request-error', payload, () => Promise.resolve(undefined));
const after = session.surface.nodes.length;

check('waterfall returned a retry action', action?.kind === 'retry', JSON.stringify(action));
check('the surface was rewritten', after < before, `${before} → ${after}`);
check('the checkpoint is on the surface', session.surface.nodes.some((seq) => session.eventAt(seq)?.data?.source?.kind === 'compact-checkpoint'));

process.stdout.write('3. the per-turn budget stops the ladder\n');
// maxAttemptsPerTurn defaults to 2: attempt 2 still rescues, attempt 3 delegates.
const second = await root.waterfall('agent/request-error', payload, () => Promise.resolve('delegated'));
check('attempt 2 is still rescued', second?.kind === 'retry', JSON.stringify(second));
const third = await root.waterfall('agent/request-error', payload, () => Promise.resolve('delegated'));
check('attempt 3 delegates to the host', third === 'delegated', JSON.stringify(third));

process.stdout.write('4. the tools answer through the real service\n');
const status = await registered[0].execute({ action: 'status' }, { agent });
check('status reports the session', status?.ok !== false && typeof status === 'object', JSON.stringify(status).slice(0, 160));


process.stdout.write('5. coexistence with a host compaction engine\n');
// cordis hands out a fresh proxy per lookup, so identity is useless here; asking
// the slot who answers proves whether the plugin took it over.
const callsBeforeProbe = hostCompactionCalls;
await root.get('compaction')?.compactIfNeeded?.({}, 'context-overflow');
check(
  'the compaction slot still routes to the host engine',
  hostCompactionCalls === callsBeforeProbe + 1 && hostCompactionSlot !== undefined,
  'the slot belongs to the host, or to a preventive compactor such as dsh-smart-compact',
);
check(
  'the plugin does not inject the compaction service',
  !(plugin.inject ?? []).includes('compaction'),
  JSON.stringify(plugin.inject),
);

hostCompactionCalls = 0;
const coexistSession = new FakeSession();
seedConversation(coexistSession, { turns: 24, chars: 9000 });
const coexistAgent = { session: coexistSession, id: 'coexist' };
const coexistReport = await rescue(
  { tokenMeter: meter, get: (name) => (name === 'tokenMeter' ? meter : root.get(name)) },
  {
    agent: coexistAgent,
    session: coexistSession,
    failure: payload.failure,
    provider: 'openrouter',
    turn: 1,
    config: resolveConfig({}),
  },
);
const tierNames = coexistReport.tiers.map((tier) => tier.tier).join(',');
check('the host engine was asked once, before the cheap fold', hostCompactionCalls === 1, String(hostCompactionCalls));
check(
  'the ladder still ends on the zero-model tier',
  coexistReport.action === 'retry' && tierNames.endsWith('mechanical-fold'),
  `${coexistReport.action} / ${tierNames}`,
);
check('the host engine no-op was recorded as a failed tier', coexistReport.tiers.find((tier) => tier.tier === 'host-compaction')?.ok === false);
check('a borrowed-tier no-op does not block the compression lane', rescueStateOf(coexistAgent).laneBlocked === false);

process.stdout.write('6. the slash commands through the real command registry\n');
// The strongest form of this check: mount the host's own CommandRuntime, then
// execute the lines exactly as a UI adapter would.
const commandsEntry = join(ASAR, 'node_modules/@deepseek-ai/dsh-commands/lib/types/index.js');
const CommandsRuntime = (await import(pathToFileURL(commandsEntry).href)).default;
root.plugin(CommandsRuntime);
await new Promise((resolve) => setTimeout(resolve, 50));

const commands = root.get('commands');
const commandSession = new FakeSession();
seedConversation(commandSession, { turns: 24, chars: 9000 });
const commandAgent = { session: commandSession, id: 'commands' };
const descriptorsOf = (name) => commands
  .list(commandAgent)
  .filter((descriptor) => (name === undefined ? descriptor.name.startsWith('rescue') : descriptor.name === name));

check(
  'both rescue commands are listed by the host registry',
  descriptorsOf().map((descriptor) => descriptor.name).join(',') === 'rescue,rescue-status',
  descriptorsOf().map((descriptor) => descriptor.name).join(','),
);
check(
  'the registry kept their descriptions',
  descriptorsOf().every((descriptor) => descriptor.description.trim().length > 0),
);

const nodesBeforeStatus = commandSession.surface.nodes.length;
const statusRun = await commands.execute(commandAgent, '/rescue-status', [], new AbortController().signal);
check('  /rescue-status succeeded', statusRun?.result?.kind === 'success', JSON.stringify(statusRun?.result ?? null).slice(0, 200));
check(
  '/rescue-status left the session alone',
  commandSession.surface.nodes.length === nodesBeforeStatus,
  `${nodesBeforeStatus} → ${commandSession.surface.nodes.length}`,
);

const nodesBeforeFold = commandSession.surface.nodes.length;
const rescueRun = await commands.execute(commandAgent, '/rescue', [], new AbortController().signal);
check('/rescue succeeded', rescueRun?.result?.kind === 'success', JSON.stringify(rescueRun?.result ?? null).slice(0, 200));
check(
  '/rescue folded the surface',
  commandSession.surface.nodes.length < nodesBeforeFold,
  `${nodesBeforeFold} → ${commandSession.surface.nodes.length}`,
);
check(
  '/rescue points the UI at the replacement event',
  Number.isSafeInteger(rescueRun?.result?.sourceEventSeq),
  String(rescueRun?.result?.sourceEventSeq),
);
check(
  'the host logged command/run and command/done',
  commandSession.events.some((event) => event.type === 'command/run')
    && commandSession.events.some((event) => event.type === 'command/done'),
  commandSession.events.map((event) => event.type).filter((type) => type.startsWith('command/')).join(','),
);

process.stdout.write('7. the pre-step waterfall folds before the request is built\n');

// The host dispatches `agent/pre-step` as a waterfall whose payload also carries
// `messages`, and whose terminal value is a decision the loop reads. A rescue
// here must fold the projection *and* hand that decision back untouched.
const preSession = new FakeSession();
seedConversation(preSession, { turns: 24, chars: 9000 });
const preAgent = { session: preSession, id: 'pre-flight' };
const preNodes = preSession.surface.nodes.length;
const preDecision = await root.waterfall(
  'agent/pre-step',
  { agent: preAgent, messages: [], turn: 9, step: 1, signal: new AbortController().signal },
  () => Promise.resolve({ kind: 'accept' }),
);
check('the pre-step decision is passed through', preDecision?.kind === 'accept', JSON.stringify(preDecision));
check(
  'the projection was folded before dispatch',
  preSession.surface.nodes.length < preNodes,
  `${preNodes} → ${preSession.surface.nodes.length}`,
);

process.stdout.write(failures.length === 0 ? '\nload test passed\n' : `\nload test failed: ${failures.join(', ')}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
