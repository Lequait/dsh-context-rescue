/**
 * Load the plugin into the host's real cordis container and drive one rescue.
 *
 * `node --test` runs against a hand-rolled context; this script runs against
 * `@deepseek-ai/cordis` 4 from the installed app, so it proves the parts a fake
 * context cannot: the `inject`/`Service` wiring, `ctx.plugin()` mounting, the
 * `ctx.waterfall('agent/request-error', …, next)` dispatch shape, and the tools
 * service contract.
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
root.plugin(plugin, { verbose: false, registerTools: true });
await new Promise((resolve) => setTimeout(resolve, 50));

check('plugin mounted without throwing', true);
check('tools registered through the real service', registered.length === 3, `got ${registered.length}`);
check('tool names', registered.map((tool) => tool.name).join(',') === 'context_rescue,context_rescue_estimate,context_rescue_fold', registered.map((tool) => tool.name).join(','));

process.stdout.write('2. drive an overflow through the real waterfall\n');

/** A session shaped like a real one, with the meter the plugin looks for. */
const session = new FakeSession();
seedConversation(session, { turns: 24, chars: 3000 });
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

process.stdout.write(failures.length === 0 ? '\nload test passed\n' : `\nload test failed: ${failures.join(', ')}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
