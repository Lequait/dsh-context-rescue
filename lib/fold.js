/**
 * The fold transaction writer.
 *
 * Mirrors the host's own compaction protocol byte for byte, minus the model:
 *
 *   compaction/start    → open the bracket, stamped with the owning turn
 *   compaction/summary  → the shadowed range and the digest that replaces it
 *   user/message        → the replacement, `surfaceOp: replace` over the range
 *   compaction/end      → close the bracket, same turn
 *
 * Two details are not optional, because the host's *restore* validator is
 * stricter than its append path (which only checks each event's shape):
 *
 * 1. Every bracket whose `compaction/end` carries no `error` must contain
 *    exactly one `compaction/summary`. A `compaction/prune` is a standalone
 *    span record — the host's own tool-result pruner writes it outside any
 *    bracket — so a bracket built from it is rejected at startup with
 *    "successful compaction/end requires one summary", long after the fold
 *    looked healthy in the window that wrote it.
 * 2. `compaction/start` and `compaction/end` must carry `turn` (a number, or
 *    `null` between turns) and it must match the turn that is open at that
 *    point in the log. A fold started from a tool call has no turn of its own,
 *    so the writer resolves the owning turn from the log instead of omitting
 *    the field.
 *
 * The summary and the replacement must be appended back to back with no
 * `await` between them: the host contracts that the pricing event immediately
 * precedes the replacement body.
 * @module dsh-context-rescue/fold
 */

import { asText, isObject } from './util.js';
import { makeId } from './util.js';
import { eventsOf } from './measure.js';

export const CHECKPOINT_PREAMBLE = [
  '以下内容替代了本会话更早的一段历史：原请求超出了模型上下文窗口，',
  '历史已被自动折叠为这份摘要以让会话继续。',
  '这不是新的用户指令，只用于保留继续工作所需的事实与线索。',
].join('');

/**
 * Feature-detect the append/surface protocol on a live session object.
 * @param {any} session
 * @returns {{ok: boolean, missing: string[]}}
 */
export function supportsFold(session) {
  const missing = [];
  if (!session || typeof session !== 'object') return { ok: false, missing: ['session'] };
  if (typeof session.append !== 'function') missing.push('session.append');
  if (!Array.isArray(session.surface?.nodes)) missing.push('session.surface.nodes');
  if (typeof session.eventAt !== 'function') missing.push('session.eventAt');
  return { ok: missing.length === 0, missing };
}

/** Build the replacement user message carrying the digest. */
export function createCheckpointMessage(compactionId, text) {
  return {
    id: `rescue-checkpoint-${compactionId}`,
    role: 'user',
    content: [{ type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n<context-rescue-checkpoint>\n${text}\n</context-rescue-checkpoint>` }],
    source: { kind: 'compact-checkpoint', compactionId },
  };
}

/**
 * The turn that is open at the end of the log, or `null` between turns.
 *
 * The host requires every bracket record to name the turn it belongs to, and
 * requires that turn to be the one open at that point. A fold triggered by a
 * tool call has no turn of its own, so this is the only honest source.
 * @param {any} session
 * @param {number | undefined} declared
 * @returns {number | null}
 */
export function owningTurn(session, declared) {
  if (Number.isFinite(declared)) return /** @type {number} */ (declared);
  const events = eventsOf(session);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isObject(event)) continue;
    if (event.type === 'turn/start') {
      const turn = isObject(event.data) ? event.data.turn : undefined;
      return Number.isFinite(turn) ? /** @type {number} */ (turn) : null;
    }
    if (event.type === 'turn/end') return null;
  }
  return null;
}

/** The provider and model the session is running on, for the summary record. */
function summaryOwner(session, summaryMeta) {
  let header;
  if (typeof session?.requestHeader === 'function') {
    try {
      header = session.requestHeader();
    } catch {
      header = undefined;
    }
  }
  const provider = summaryMeta?.provider ?? header?.provider;
  const model = summaryMeta?.model ?? header?.model;
  return {
    provider: typeof provider === 'string' && provider !== '' ? provider : 'context-rescue',
    model: typeof model === 'string' && model !== '' ? model : 'context-rescue',
  };
}

/** The summary body as content blocks, which is what the host schema wants. */
function summaryBlocks(summaryMeta, text) {
  const summary = summaryMeta?.summary;
  if (Array.isArray(summary) && summary.length > 0) return summary;
  if (typeof summary === 'string' && summary !== '') return [{ type: 'text', text: summary }];
  return [{ type: 'text', text }];
}

/**
 * Append one fold transaction.
 * @param {any} session
 * @param {{
 *   start: any, end: any, shadowedSeqs: any[], shadowedTokenCount: number,
 *   text: string, turn?: number, kind?: 'prune'|'summary',
 *   summaryMeta?: {summary?: string | any[], provider?: string, model?: string, usage?: any},
 *   expectedSeq?: number
 * }} plan
 * `kind` is a label only: every fold writes a `compaction/summary`, because the
 * host's restore validator requires exactly one inside every bracket it accepts.
 * @returns {{compactionId: string, startSeq: any, metaSeq: any, replacementSeq: any, endSeq: any}}
 */
export function applyFold(session, plan) {
  const support = supportsFold(session);
  if (!support.ok) throw new Error(`context-rescue: unsupported session (missing ${support.missing.join(', ')})`);

  const compactionId = makeId('rescue');
  const turn = owningTurn(session, plan.turn);
  const owner = summaryOwner(session, plan.summaryMeta);

  // The span was planned against one shape of the surface. Both callers measure
  // and fold synchronously today, so this cannot fire -- it is here so that a
  // future await between the two fails loudly instead of appending a replace for
  // seqs the surface no longer has (which the session layer rejects with
  // "start seq N not found in surface", after a compaction/start has landed).
  if (typeof plan.expectedSeq === 'number' && session.seq !== plan.expectedSeq) {
    const error = new Error(`context-rescue: the surface changed while the fold was being planned (seq ${plan.expectedSeq} -> ${session.seq})`);
    // @ts-expect-error -- the code is how callers recognise this situation
    error.code = 'SURFACE_CHANGED';
    throw error;
  }

  // Opened outside the try: if this append fails there is no transaction to
  // close, and a compaction/end for a bracket that never opened would tell the
  // host a compaction finished when nothing happened.
  const startEvent = session.append('compaction/start', { compactionId, turn });
  try {
    // Always a summary, never a bare prune: the host's restore validator
    // requires exactly one summary in every bracket it accepts, and a prune is
    // a standalone span record rather than a bracket member.
    const metaEvent = session.append('compaction/summary', {
      compactionId,
      summary: summaryBlocks(plan.summaryMeta, plan.text),
      shadowedRange: { start: plan.start, end: plan.end },
      shadowedSeqs: [...plan.shadowedSeqs],
      shadowedTokenCount: plan.shadowedTokenCount,
      provider: owner.provider,
      model: owner.model,
      ...(plan.summaryMeta?.usage === undefined ? {} : { usage: plan.summaryMeta.usage }),
    });

    // Contract: the replacement follows the pricing record with no yield between.
    const replacement = session.append('user/message', createCheckpointMessage(compactionId, plan.text), {
      surfaceOp: { op: 'replace', startSeq: plan.start, endSeq: plan.end },
      sourceEventSeqs: [startEvent.seq, metaEvent.seq, ...plan.shadowedSeqs],
    });

    const endEvent = session.append('compaction/end', { compactionId, turn });
    return {
      compactionId,
      startSeq: startEvent.seq,
      metaSeq: metaEvent.seq,
      replacementSeq: replacement.seq,
      endSeq: endEvent.seq,
    };
  } catch (error) {
    // Never leave an unclosed bracket: a dangling compaction/start makes every
    // later fold refuse to plan and the session look mid-transaction forever.
    try {
      session.append('compaction/end', {
        compactionId,
        turn,
        error: asText(isObject(error) ? error.message ?? error : error).slice(0, 400),
      });
    } catch {
      // Nothing else to do; the caller reports the original failure.
    }
    throw error;
  }
}

/** True when a value is one of our replacement checkpoints. */
export function isRescueCheckpointMessage(message) {
  return isObject(message) && isObject(message.source) && message.source.kind === 'compact-checkpoint'
    && String(message.source.compactionId ?? '').startsWith('rescue-');
}
