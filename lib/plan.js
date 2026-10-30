/**
 * Range selection.
 *
 * A fold replaces one contiguous span of the surface with a single checkpoint
 * message. Two invariants make that safe:
 *
 * 1. **Tool pairing.** The host derives safe cuts from a running balance over
 *    the *current* surface: an `assistant/message` opens one pairing per
 *    `tool-call` content block, a `tool/result` closes one, and everything else
 *    — including the mirroring `tool/call` and `tool/ptc-dispatch` events that
 *    also sit on real surfaces — is neutral. A call whose result lands outside
 *    the span leaves the replayed request malformed, so both cuts of the span
 *    must fall where that balance is zero. This module reimplements the rule
 *    over logged events so the plugin keeps zero host imports; `plan.test.js`
 *    pins it, and `tests/replay-real-log.test.js` checks it against a log
 *    captured from a real session.
 * 2. **Transaction brackets.** A `compaction/start` inside the span without its
 *    matching `compaction/end` means another fold is mid-flight; this module
 *    refuses to plan anything in that case.
 * @module dsh-context-rescue/plan
 */

import { isObject } from './util.js';
import { eventsOf } from './measure.js';

const TOOL_CALL_TYPES = new Set(['tool/call']);
const TOOL_RESULT_TYPES = new Set(['tool/result', 'tool/ptc-dispatch']);

/** True when an event is the recorded start of a tool call. */
export function isToolCallType(type) {
  return TOOL_CALL_TYPES.has(type);
}

/** True when an event closes a tool pairing. */
export function isToolResultType(type) {
  return TOOL_RESULT_TYPES.has(type);
}

/** The content blocks of a message-shaped event, when it has any. */
export function contentOf(event) {
  const data = isObject(event?.data) ? event.data : {};
  const content = data.message?.content ?? data.content;
  return Array.isArray(content) ? content : [];
}

/**
 * How one surface event changes the open tool-call count.
 *
 * Mirrors the host: only `assistant/message` tool-call blocks open, only
 * `tool/result` closes. `tool/call` mirrors a block that is already counted, so
 * counting it again would make every real surface look unbalanced.
 * @param {any} event
 */
export function pairingDelta(event) {
  switch (event?.type) {
    case 'assistant/message':
      return contentOf(event).filter((block) => block?.type === 'tool-call').length;
    case 'tool/result':
      return -1;
    default:
      return 0;
  }
}

/**
 * Running balance over a surface: `cuts[k]` is true when the cut immediately
 * before node `k` is tool-pairing balanced, so `cuts.length === nodes.length + 1`.
 * @param {any[]} events - surface events, in surface order.
 */
export function pairingCuts(events) {
  let open = 0;
  let corrupt = false;
  const cuts = [true];
  for (const event of events ?? []) {
    open += pairingDelta(event);
    if (open < 0) corrupt = true;
    cuts.push(open === 0);
  }
  return { cuts, open, corrupt };
}

/** Read one event's type without trusting the session shape. */
export function eventTypeAt(session, seq) {
  const event = eventAt(session, seq);
  return isObject(event) ? event.type : undefined;
}

/** Read one event object without trusting the session shape. */
export function eventAt(session, seq) {
  if (typeof session?.eventAt === 'function') {
    try {
      const event = session.eventAt(seq);
      if (isObject(event)) return event;
    } catch {
      return undefined;
    }
  }
  const events = eventsOf(session);
  return events.find((event) => event?.seq === seq);
}

/**
 * Detect an unclosed compaction transaction anywhere in the log.
 * @param {Array<{type?: string, data?: any}>} events
 */
export function hasOpenCompactionTransaction(events) {
  if (!Array.isArray(events)) return false;
  const open = new Set();
  for (const event of events) {
    if (!isObject(event)) continue;
    if (event.type === 'compaction/start') {
      const id = event.data?.compactionId;
      if (id !== undefined) open.add(id);
    } else if (event.type === 'compaction/end') {
      const id = event.data?.compactionId;
      if (id !== undefined) open.delete(id);
    }
  }
  return open.size > 0;
}

/** True when a surface node is a compaction checkpoint replacement. */
export function isCheckpointSurfaceNode(types) {
  return types === 'user/message';
}

/**
 * Choose the span to fold.
 *
 * The span starts at the first foldable surface node and ends just before the
 * retained verbatim tail, then retreats to the nearest pairing-balanced cuts.
 * @param {any} session
 * @param {{nodes: Array<{seq: any, tokens: number, heuristicTokens: number}>, totalTokens: number}} measurement
 * @param {{
 *   retainTokens: number, pinFirstUserMessage?: boolean, minFoldTokens: number,
 *   types?: Array<string|undefined>
 * }} options
 * @returns {null | {
 *   start: any, end: any, startIdx: number, endIdx: number,
 *   shadowedSeqs: any[], shadowedTokenCount: number, shadowedPricedTokens: number,
 *   retainedTokens: number, totalTokens: number
 * }}
 */
export function selectRescueRange(session, measurement, options) {
  const nodes = measurement?.nodes ?? [];
  const totalTokens = measurement?.totalTokens ?? 0;
  if (nodes.length < 3) return null;
  if (hasOpenCompactionTransaction(eventsOf(session))) return null;

  const types = options.types ?? nodes.map((node) => eventTypeAt(session, node.seq));
  const events = nodes.map((node) => eventAt(session, node.seq));
  const { cuts, corrupt } = pairingCuts(events);
  if (corrupt) return null;

  let floorIdx = 0;
  if (types[0] === 'system/message') floorIdx = 1;
  if (options.pinFirstUserMessage !== false && types[floorIdx] === 'user/message') floorIdx += 1;

  const retainTokens = Math.max(0, Math.floor(options.retainTokens));
  let accumulated = 0;
  let keepFromIdx = nodes.length;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += nodes[index].tokens;
    keepFromIdx = index;
    if (accumulated >= retainTokens) break;
  }

  // Retreat from the retained tail to the closest balanced cut: a span may not
  // end between an assistant tool call and its result.
  let endIdx = Math.min(keepFromIdx - 1, nodes.length - 1);
  while (endIdx >= floorIdx && cuts[endIdx + 1] !== true) endIdx -= 1;
  if (endIdx < floorIdx) return null;

  // Advance the start to the first balanced cut at or after the pinned floor, so
  // the span never begins with an orphaned result.
  let startIdx = floorIdx;
  while (startIdx <= endIdx && cuts[startIdx] !== true) startIdx += 1;
  if (startIdx > endIdx) return null;

  const span = nodes.slice(startIdx, endIdx + 1);
  const shadowedTokenCount = span.reduce((total, node) => total + (node.heuristicTokens ?? node.tokens), 0);
  const pricedTokens = span.reduce((total, node) => total + node.tokens, 0);
  if (shadowedTokenCount < options.minFoldTokens) return null;
  if (pricedTokens <= 0) return null;

  return {
    start: nodes[startIdx].seq,
    end: nodes[endIdx].seq,
    startIdx,
    endIdx,
    shadowedSeqs: span.map((node) => node.seq),
    shadowedTokenCount,
    shadowedPricedTokens: pricedTokens,
    retainedTokens: totalTokens - pricedTokens,
    totalTokens,
  };
}

/**
 * Plan with progressively smaller retained tails until the projected total fits
 * the target. Returns the first plan whose remainder meets `targetTokens`, or
 * the largest span available when nothing does.
 * @param {any} session
 * @param {any} measurement
 * @param {{retainOptions: number[], targetTokens: number, minFoldTokens: number, pinFirstUserMessage?: boolean, types?: string[]}} options
 */
export function planFold(session, measurement, options) {
  const types = options.types ?? measurement.nodes.map((node) => eventTypeAt(session, node.seq));
  let best = null;
  for (const retainTokens of options.retainOptions) {
    const plan = selectRescueRange(session, measurement, {
      retainTokens,
      types,
      minFoldTokens: options.minFoldTokens,
      pinFirstUserMessage: options.pinFirstUserMessage,
    });
    if (!plan) continue;
    if (!best || plan.shadowedPricedTokens > best.shadowedPricedTokens) best = plan;
    if (plan.retainedTokens <= options.targetTokens) return plan;
  }
  return best;
}
