#!/usr/bin/env node
/**
 * Developer probe: read a real DSH v4 session log and report the shape the
 * rescue planner has to survive.
 *
 * Usage: node scripts/dev/inspect-session.mjs <session.v4.jsonl.zstd>
 *
 * Prints the event-type histogram, the reconstructed surface, and the
 * tool-call/result balance across it — the invariant `applyFold` depends on.
 * Read-only: nothing here writes files.
 * @module dsh-context-rescue/scripts/dev/inspect-session
 */

import { loadSessionLog, reconstructSurface } from './session-log.mjs';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: node scripts/dev/inspect-session.mjs <session.v4.jsonl.zstd>\n');
  process.exit(2);
}

const { header, events } = loadSessionLog(path);
process.stdout.write(`file: ${path}\n`);
process.stdout.write(`session: ${header?.id ?? '?'} (v${header?.version ?? '?'}) cwd=${header?.cwd ?? '?'} preset=${header?.agentPreset ?? '?'}\n`);
process.stdout.write(`events: ${events.length}\n`);

/** @type {Map<string, number>} */
const histogram = new Map();
for (const event of events) histogram.set(event.type, (histogram.get(event.type) ?? 0) + 1);
process.stdout.write('\n=== event types ===\n');
for (const [type, count] of [...histogram].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  process.stdout.write(`${String(count).padStart(8)}  ${type}\n`);
}

const { surface, bySeq } = reconstructSurface(events);
process.stdout.write(`\n=== surface ===\nnodes: ${surface.length}\n`);
const surfaceHistogram = new Map();
for (const seq of surface) {
  const type = bySeq.get(seq)?.type ?? 'missing';
  surfaceHistogram.set(type, (surfaceHistogram.get(type) ?? 0) + 1);
}
for (const [type, count] of [...surfaceHistogram].sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`${String(count).padStart(8)}  ${type}\n`);
}

/** Tool-call blocks inside an assistant message open pairings the host counts. */
function blocks(seq) {
  const event = bySeq.get(seq);
  const content = event?.data?.message?.content ?? event?.data?.content;
  return Array.isArray(content) ? content : [];
}

const assistantWithCalls = surface.filter((seq) => blocks(seq).some((block) => block?.type === 'tool-call')).length;
const toolCallEvents = surface.filter((seq) => bySeq.get(seq)?.type === 'tool/call').length;
const toolResultEvents = surface.filter((seq) => bySeq.get(seq)?.type === 'tool/result').length;
process.stdout.write('\n=== tool pairing ===\n');
process.stdout.write(`assistant messages carrying tool-call blocks: ${assistantWithCalls}\n`);
process.stdout.write(`tool/call events on surface: ${toolCallEvents} · tool/result events on surface: ${toolResultEvents}\n`);

function delta(event) {
  switch (event?.type) {
    case 'assistant/message':
      return blocks(event.seq).filter((block) => block?.type === 'tool-call').length;
    case 'tool/call':
      return 1;
    case 'tool/result':
    case 'tool/ptc-dispatch':
      return -1;
    default:
      return 0;
  }
}

let balance = 0;
let negativeAt;
let balancedCuts = 0;
for (const seq of surface) {
  balance += delta(bySeq.get(seq));
  if (balance === 0) balancedCuts += 1;
  if (balance < 0 && negativeAt === undefined) negativeAt = seq;
}
process.stdout.write(`final balance: ${balance}${negativeAt === undefined ? ' (never negative)' : ` (negative at seq ${negativeAt})`}\n`);
process.stdout.write(`balanced cut positions: ${balancedCuts}\n`);

let chars = 0;
for (const seq of surface) {
  for (const block of blocks(seq)) {
    if (typeof block?.text === 'string') chars += block.text.length;
    else if (block?.type === 'tool-result') chars += JSON.stringify(block.content ?? '').length;
    else if (block?.type === 'tool-call') chars += JSON.stringify(block.arguments ?? block.input ?? '').length;
    else if (block?.type === 'reasoning') chars += 0;
  }
}
process.stdout.write(`\nmodel-facing characters on the surface: ${chars.toLocaleString('en-US')}\n`);
