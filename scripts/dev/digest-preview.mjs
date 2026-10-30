#!/usr/bin/env node
/**
 * Show the checkpoint text a real session would get, so its quality can be read
 * instead of assumed.
 *
 * The digest is the part of this plugin a human actually has to live with: after
 * a rescue the model sees exactly this text in place of the folded history. The
 * unit tests can only assert that sections exist; whether the user's request and
 * the files that matter survived is a judgment call, and that call needs eyes on
 * real output.
 *
 *     node scripts/dev/digest-preview.mjs                    # the largest log found
 *     node scripts/dev/digest-preview.mjs <log>              # a specific log
 *     node scripts/dev/digest-preview.mjs --chars 6000
 * @module dsh-context-rescue/scripts/dev/digest-preview
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadSessionLog, reconstructSurface } from './session-log.mjs';
import { ReplaySession, allLogsUnder, expandHome } from './replay-session.mjs';
import { fakeMeter } from '../../tests/fake-session.js';
import { measure } from '../../lib/measure.js';
import { resolveConfig } from '../../lib/config.js';
import { mechanicalFold } from '../../lib/rescue.js';
import { eventsOf } from '../../lib/measure.js';
import { contentOf } from '../../lib/plan.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const positional = args.find((value, index) => !value.startsWith('--') && !args[index - 1]?.startsWith('--'));

const root = expandHome(join(process.env.USERPROFILE ?? process.env.HOME ?? '~', '.dsh', 'sessions'));
const logs = positional !== undefined ? [positional] : statSync(root).isDirectory() ? allLogsUnder(root) : [];
if (logs.length === 0) {
  process.stdout.write(`no session logs at ${root}\n`);
  process.exit(0);
}

let chosen = logs[0];
let chosenSize = 0;
for (const log of logs) {
  const size = statSync(log).size;
  if (size > chosenSize) {
    chosen = log;
    chosenSize = size;
  }
}

const loaded = loadSessionLog(chosen);
const surface = reconstructSurface(loaded.events).surface;
const session = new ReplaySession(loaded.events, surface);
const meter = fakeMeter();
const ctx = { tokenMeter: meter, get: () => meter };
const config = resolveConfig({ maxDigestChars: Number(flag('chars', '12000')) });

const before = measure(ctx, session);
process.stdout.write(`log      ${chosen}\n`);
process.stdout.write(`nodes    ${surface.length}\n`);
process.stdout.write(`tokens   ${before.totalTokens.toLocaleString('en-US')}\n\n`);

const folded = await mechanicalFold(ctx, {
  agent: { session },
  session,
  config,
  windowTokens: Number(flag('window', '196608')),
  turn: 1,
  reason: 'digest preview',
});
if (!folded.ok) {
  process.stdout.write(`fold did not happen: ${folded.skipped ?? folded.error}\n`);
  process.exit(1);
}

const events = eventsOf(session);
const checkpoint = events.find((event) => event.type === 'user/message' && JSON.stringify(contentOf(event)).includes('<context-rescue-checkpoint>'));
const text = contentOf(checkpoint);
const body = Array.isArray(text) ? text.map((block) => block.text ?? '').join('\n') : String(text);

process.stdout.write(`after    ${folded.after.totalTokens.toLocaleString('en-US')} tokens, ${folded.after.nodes.length} nodes\n`);
process.stdout.write(`digest   ${body.length} characters\n`);
process.stdout.write(`${'-'.repeat(72)}\n${body}\n${'-'.repeat(72)}\n`);
