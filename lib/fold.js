/**
 * The fold transaction writer.
 *
 * Mirrors the host's own compaction protocol byte for byte, minus the model:
 *
 *   compaction/start  → price + bracket
 *   compaction/prune  → the shadowed range (zero-model variant)
 *   user/message      → the replacement, `surfaceOp: replace` over the range
 *   compaction/end    → close bracket
 *
 * The trigger record and the replacement must be appended back to back with no
 * `await` between them: the host contracts that the pricing event immediately
 * precedes the replacement body. When the host also understands
 * `compaction/summary` (model-backed), `kind: 'summary'` emits it instead of
 * `compaction/prune` so checkpoint-aware tooling sees a normal fold.
 * @module dsh-context-rescue/fold
 */

import { asText, isObject } from './util.js';
import { makeId } from './util.js';

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
 * Append one fold transaction.
 * @param {any} session
 * @param {{
 *   start: any, end: any, shadowedSeqs: any[], shadowedTokenCount: number,
 *   text: string, turn?: number, kind?: 'prune'|'summary',
 *   summaryMeta?: {summary?: string, provider?: string, model?: string, usage?: any}
 * }} plan
 * @returns {{compactionId: string, startSeq: any, metaSeq: any, replacementSeq: any, endSeq: any}}
 */
export function applyFold(session, plan) {
  const support = supportsFold(session);
  if (!support.ok) throw new Error(`context-rescue: unsupported session (missing ${support.missing.join(', ')})`);

  const compactionId = makeId('rescue');
  const turn = Number.isFinite(plan.turn) ? plan.turn : undefined;
  /** @type {any} */ let startEvent;
  try {
    startEvent = session.append('compaction/start', { compactionId, ...(turn === undefined ? {} : { turn }) });

    let metaEvent;
    if (plan.kind === 'summary') {
      metaEvent = session.append('compaction/summary', {
        compactionId,
        summary: plan.summaryMeta?.summary ?? plan.text,
        shadowedRange: { start: plan.start, end: plan.end },
        shadowedSeqs: [...plan.shadowedSeqs],
        shadowedTokenCount: plan.shadowedTokenCount,
        provider: plan.summaryMeta?.provider,
        model: plan.summaryMeta?.model,
        ...(plan.summaryMeta?.usage === undefined ? {} : { usage: plan.summaryMeta.usage }),
      });
    } else {
      metaEvent = session.append('compaction/prune', {
        shadowedRange: { start: plan.start, end: plan.end },
        shadowedSeqs: [...plan.shadowedSeqs],
        shadowedTokenCount: plan.shadowedTokenCount,
      });
    }

    // Contract: the replacement follows the pricing record with no yield between.
    const replacement = session.append('user/message', createCheckpointMessage(compactionId, plan.text), {
      surfaceOp: { op: 'replace', startSeq: plan.start, endSeq: plan.end },
      sourceEventSeqs: [startEvent.seq, metaEvent.seq, ...plan.shadowedSeqs],
    });

    const endEvent = session.append('compaction/end', { compactionId, ...(turn === undefined ? {} : { turn }) });
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
        ...(turn === undefined ? {} : { turn }),
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
