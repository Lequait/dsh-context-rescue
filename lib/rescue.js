/**
 * Rescue orchestration: detect → measure → try the cheapest tier that can work
 * → verify the projection actually shrank → retry the same step.
 *
 * Tier order is chosen so that the cheapest, most faithful action wins:
 *
 *   T1  prune tool results        (host pruner, zero model, no surface rewrite)
 *   T2  borrow the host's own      (real summary, keeps more meaning; may be
 *       compaction engine           refused by a lane owner such as billion-context)
 *   T3  mechanical digest fold     (zero model, always available)
 *
 * Every tier must move the measured projection below `fitRatio × window` before
 * a retry is issued; otherwise the next tier runs and, if none succeed, the
 * failure is passed through unchanged so the host keeps its normal behaviour.
 * @module dsh-context-rescue/rescue
 */

import { buildDigest } from './digest.js';
import { applyFold, supportsFold } from './fold.js';
import { derivedTokensOf, eventText, eventsOf, fits, measure, resolveWindow, serviceOf } from './measure.js';
import { classifyFailure, isLaneRefusal } from './overflow.js';
import { eventAt, pairingCuts, planFold } from './plan.js';
import { openTransactions, repairStaleTransactions } from './repair.js';
import { asText, errorText, estimateTokensFromText, isObject } from './util.js';

/** Per-agent rescue bookkeeping. */
const RESCUE_STATE = new WeakMap();

/** Read (or create) the rescue state for one agent. */
export function rescueStateOf(agent) {
  let state = RESCUE_STATE.get(agent);
  if (!state) {
    state = { turn: undefined, attempts: 0, laneBlocked: false, hopeless: false, lastReport: null, history: [] };
    RESCUE_STATE.set(agent, state);
  }
  return state;
}

/** Log through whatever the host exposes, without ever throwing. */
export function log(ctx, level, message, data) {
  const logger = serviceOf(ctx, 'logger');
  try {
    const fn = logger?.[level] ?? logger?.log;
    if (typeof fn === 'function') {
      fn.call(logger, `[context-rescue] ${message}`, data ?? '');
      return;
    }
    const plain = serviceOf(ctx, 'log');
    if (typeof plain === 'function') {
      plain(level, `[context-rescue] ${message}`, data ?? '');
    }
  } catch {
    // Logging must never break rescue.
  }
}

/**
 * One structured line describing a decision, when the operator asked for it.
 *
 * `debug` is declared in the options and documented as "write structured
 * diagnostics to the host logger", so it has to actually write them: without
 * it, someone staring at a session that is not being rescued has `report`,
 * `tiers` and `fold` — the three things that say why — only inside a debugger.
 * @param {any} ctx
 * @param {any} config
 * @param {string} kind 'rescue' or 'pre-flight'
 * @param {any} report the object rescue()/preflight() returned
 */
export function traceReport(ctx, config, kind, report) {
  if (config?.debug !== true || report === undefined || report === null) return;
  const fields = {
    kind,
    action: report.action,
    reason: report.reason,
    detected: report.detected
      ? { overflow: report.detected.overflow === true, code: report.detected.code }
      : undefined,
    window: report.window?.windowTokens,
    before: report.before?.totalTokens,
    after: report.after?.totalTokens,
    attempted: report.attempted,
    tiers: (Array.isArray(report.tiers) ? report.tiers : []).map((tier) => ({
      tier: tier?.tier,
      ok: tier?.ok === true,
      skipped: tier?.skipped,
      error: tier?.error,
      before: tier?.before,
      after: tier?.after,
    })),
    fold: report.fold
      ? {
          tier: report.fold.tier,
          start: report.fold.plan?.start,
          end: report.fold.plan?.end,
          shadowed: Array.isArray(report.fold.plan?.shadowedSeqs) ? report.fold.plan.shadowedSeqs.length : undefined,
          shadowedTokens: report.fold.plan?.shadowedTokenCount,
          digestChars: report.fold.digestChars,
          pinDropped: report.fold.plan?.pinDropped === true,
        }
      : undefined,
  };
  log(ctx, 'info', `debug ${kind}: ${asText(report.action)} — ${asText(report.reason)}`, JSON.stringify(fields));
}

/** Find a host tool-result pruner, if the host plugin that owns one is loaded. */
function prunerOf(ctx) {
  for (const name of ['toolResultPruner', 'prune', 'toolPruner']) {
    const candidate = serviceOf(ctx, name);
    if (candidate && typeof candidate.pruneSession === 'function') return candidate;
  }
  return undefined;
}

/**
 * Close brackets left open by an earlier turn.
 *
 * A dangling `compaction/start` refuses every future fold, so a session that
 * died mid-fold can never be rescued again. Only older transactions are closed:
 * one opened in this turn may still be mid-write.
 * @param {any} ctx
 * @param {any} session
 * @param {any} config
 * @param {number|undefined} turn
 * @returns {any[]} the ids that were closed
 */
function repairIfNeeded(ctx, session, config, turn) {
  if (config?.repairTransactions === false) return [];
  try {
    return repairStaleTransactions(session, {
      turn,
      onRepair: (id, startedInTurn) => log(
        ctx,
        'warn',
        `closed compaction transaction ${asText(id)} left open${startedInTurn === undefined ? '' : ` in turn ${startedInTurn}`}; a dangling start blocks every later fold`,
      ),
    });
  } catch (error) {
    log(ctx, 'warn', `could not close a leftover compaction transaction: ${errorText(error)}`);
    return [];
  }
}

/** Retained-tail budgets, from generous to tight, for the fold planner. */
function retainOptions(windowTokens, config) {
  const base = Math.min(
    config.retainMaxTokens,
    Math.max(config.retainMinTokens, Math.floor(windowTokens * config.retainRatio)),
  );
  const options = [base, Math.floor(base / 2), Math.max(config.retainMinTokens, Math.floor(base / 4))];
  return [...new Set(options)].filter((value) => value > 0);
}

/**
 * Fold the session with a mechanical digest (T3). Zero model calls.
 * @param {any} ctx
 * @param {{agent: any, session: any, config: any, windowTokens: number, reason: string, turn?: number}} options
 */
export function mechanicalFold(ctx, options) {
  const { agent, session, config, windowTokens, reason, turn } = options;
  const support = supportsFold(session);
  if (!support.ok) return { ok: false, skipped: `unsupported session (missing ${support.missing.join(', ')})` };

  const before = measure(ctx, session);
  const targetTokens = Math.floor(windowTokens * config.targetRatio);
  const plan = planFold(session, before, {
    retainOptions: retainOptions(windowTokens, config),
    targetTokens,
    minFoldTokens: config.minFoldTokens,
    pinFirstUserMessage: config.pinFirstUserMessage,
  });
  if (!plan) return { ok: false, skipped: 'nothing foldable (session too short, mid-transaction, or pairing-locked)', before };

  const text = buildDigest(session, {
    startSeq: plan.start,
    endSeq: plan.end,
    shadowedSeqs: plan.shadowedSeqs,
    shadowedTokenCount: plan.shadowedTokenCount,
    totalTokens: plan.totalTokens,
    windowTokens,
    measuredTokens: before.totalTokens,
    reason,
    maxChars: config.maxDigestChars,
    pinDropped: plan.pinDropped === true,
  });

  const written = applyFold(session, {
    start: plan.start,
    end: plan.end,
    shadowedSeqs: plan.shadowedSeqs,
    shadowedTokenCount: plan.shadowedTokenCount,
    text,
    turn,
    kind: 'prune',
    expectedSeq: session.seq,
  });

  const after = measure(ctx, session);
  const shrank = after.totalTokens < before.totalTokens;
  // A fold that leaves the projection over the window is a fold the next request
  // will still be refused for. Say so, so the ladder can go on to the tiers that
  // cut what the span could not (an oversized message inside the retained tail).
  const fitsNow = fits(after.totalTokens, windowTokens, config.fitRatio);
  return {
    ok: shrank && fitsNow,
    tier: 'mechanical-fold',
    before,
    after,
    plan,
    written,
    digestChars: text.length,
    skipped: shrank
      ? (fitsNow ? undefined : 'folded, but the projection is still over the window')
      : 'replacement was not smaller than the folded span',
  };
}

/**
 * Run the full tier ladder for one detected overflow.
 * @param {any} ctx
 * @param {{
 *   agent: any, session: any, failure: unknown, provider?: string, model?: string,
 *   turn?: number, step?: number, signal?: AbortSignal, config: any, force?: boolean,
 *   attempt?: number
 * }} options
 * @returns {Promise<{
 *   detected: ReturnType<typeof classifyFailure>, window: any,
 *   before: any, after: any, tiers: Array<any>, fold: any,
 *   action: 'retry'|'pass', reason: string, attempted: boolean
 * }>}
 */
export async function rescue(ctx, options) {
  const { agent, session, failure, provider, config, signal, turn } = options;
  const detected = classifyFailure(failure, { extraPatterns: config.extraPatterns });
  const tiers = [];
  const state = rescueStateOf(agent);

  // A session that defeated every tier in an earlier turn (for example a system
  // prompt that alone exceeds the window) is still defeated now: it would pay
  // the full measurement cost on every request and fail the same way. Ask once
  // per session; an explicit /rescue or a tool call passes force and tries again.
  /** @type {any} */ let earlyWindow = null;
  if (detected.overflow && state.hopeless === true && options.force !== true) {
    const current = await resolveWindow(ctx, {
      provider,
      model: options.model,
      signal,
      evidence: detected.evidence,
      session,
      config,
    });
    const remembered = typeof state.hopelessWindow === 'number' ? state.hopelessWindow : null;
    const moved = verdictStale(state, session);
    if (moved || (remembered !== null && current.windowTokens !== remembered)) {
      // Same session, different window or a surface that grew since: the old
      // verdict does not describe this request, so measure again instead of
      // inheriting it.
      state.hopeless = false;
      state.hopelessWindow = undefined;
      state.hopelessShape = undefined;
      earlyWindow = current;
    }
  }
  if (detected.overflow && state.hopeless === true && options.force !== true) {
    const known = typeof state.lastPreflight?.tokens === 'number' ? state.lastPreflight.tokens : 0;
    const cheap = { totalTokens: known, nodes: [], source: 'growth' };
    return {
      detected,
      window: state.windowCache?.window ?? null,
      before: cheap,
      after: cheap,
      tiers: [],
      fold: null,
      action: 'pass',
      reason: 'every tier already failed on this session in an earlier turn; this request was not measured again (run /rescue to try once more)',
      attempted: false,
    };
  }
  repairIfNeeded(ctx, session, config, turn);
  const before = measure(ctx, session);

  if (!detected.overflow && options.force !== true) {
    return { detected, window: null, before, after: before, tiers, fold: null, action: 'pass', reason: 'not a context-overflow failure', attempted: false };
  }

  const window = earlyWindow ?? await resolveWindow(ctx, {
    provider,
    model: options.model,
    signal,
    evidence: detected.evidence,
    session,
    config,
  });

  /**
   * The shape is annotated because every branch mutates this object in place;
   * without it the literal widens `action` to `string` and the contract drifts.
   * @type {{
   *   detected: any, window: any, before: any, after: any, tiers: Array<any>, fold: any,
   *   action: 'retry'|'pass', reason: string, attempted: boolean
   * }}
   */
  const report = {
    detected,
    window,
    before,
    after: before,
    tiers,
    fold: null,
    action: 'pass',
    reason: '',
    attempted: false,
  };

  if (config.mode === 'diagnose') {
    report.reason = 'mode=diagnose: detected overflow, no rewrite performed';
    return report;
  }

  // The failure said overflow, but our own measurement may disagree (a gateway
  // can count more than the projection does). Never rewrite a projection that
  // already fits: the rewrite would cost context for nothing -- but a second
  // rejection in the same turn means the measurement is not the whole story, so
  // the ladder runs anyway rather than retrying the same request forever.
  // A budget of one attempt means there is no second rejection to learn from, so
  // the fits shortcut would consume the only chance this turn has.
  const insist = (typeof options.attempt === 'number' && options.attempt > 1)
    || Number(config.maxAttemptsPerTurn) <= 1;
  if (!insist && fits(before.totalTokens, window.windowTokens, config.fitRatio)) {
    report.action = 'retry';
    state.hopeless = false;
    report.reason = 'measured projection already fits the window; retrying unchanged';
    return report;
  }

  // ---------------------------------------------------------------- T1 prune
  const pruner = prunerOf(ctx);
  if (pruner) {
    try {
      const pruned = await pruner.pruneSession(session);
      const afterPrune = measure(ctx, session);
      tiers.push({ tier: 'prune', ok: afterPrune.totalTokens < before.totalTokens, before: before.totalTokens, after: afterPrune.totalTokens, result: pruned });
      if (fits(afterPrune.totalTokens, window.windowTokens, config.fitRatio)) {
        report.after = afterPrune;
        report.action = 'retry';
    state.hopeless = false;
        report.attempted = true;
        report.reason = 'tool-result prune brought the projection under the window';
        return report;
      }
    } catch (error) {
      tiers.push({ tier: 'prune', ok: false, error: errorText(error) });
    }
  } else {
    tiers.push({ tier: 'prune', ok: false, skipped: 'no host tool-result pruner installed' });
  }

  // ------------------------------------------------------- T2 host compaction
  const engine = serviceOf(ctx, 'compaction');
  // `mode: 'fold'` is the promise that this plugin never asks a model to summarise:
  // the host engine may summarise, so it is off the table there too, exactly like
  // zeroModelOnly. Without this the mode was accepted by the schema and then made
  // no difference to any path.
  const zeroModel = config.zeroModelOnly === true || config.mode === 'fold';
  const canBorrow = config.allowModelCompaction && !zeroModel && !state.laneBlocked
    && engine && typeof engine.compactIfNeeded === 'function';
  if (canBorrow) {
    try {
      const result = await engine.compactIfNeeded(agent, 'context-overflow', signal);
      const afterCompact = measure(ctx, session);
      const shrank = afterCompact.totalTokens < before.totalTokens;
      tiers.push({ tier: 'host-compaction', ok: shrank, before: before.totalTokens, after: afterCompact.totalTokens, result });
      // A borrowed engine that resolves without changing the projection has not
      // rescued anything; only a real reduction lets the ladder stop here.
      if (shrank && fits(afterCompact.totalTokens, window.windowTokens, config.fitRatio)) {
        report.after = afterCompact;
        report.action = 'retry';
    state.hopeless = false;
        report.attempted = true;
        report.reason = 'host compaction engine reduced the projection';
        return report;
      }
    } catch (error) {
      const refusal = isLaneRefusal(error, config.laneRefusalPatterns);
      if (refusal) state.laneBlocked = true;
      tiers.push({
        tier: 'host-compaction',
        ok: false,
        laneRefusal: refusal,
        error: errorText(error),
      });
    }
  } else {
    tiers.push({
      tier: 'host-compaction',
      ok: false,
      skipped: state.laneBlocked
        ? 'compression lane refuses host compaction (billion-context); using the zero-model path'
        : zeroModel
          ? (config.mode === 'fold' ? 'mode=fold (no model summarisation)' : 'zeroModelOnly=true')
          : !engine
            ? 'no host compaction engine mounted'
            : 'allowModelCompaction=false',
    });
  }

  // ------------------------------------------------- T3 mechanical digest fold
  if (config.mode !== 'diagnose') {
    const fold = mechanicalFold(ctx, {
      agent,
      session,
      config,
      windowTokens: window.windowTokens,
      reason: `${detected.code || 'CONTEXT_WINDOW_EXCEEDED'}: ${detected.message}`.slice(0, 400),
      turn,
    });
    tiers.push({
      tier: 'mechanical-fold',
      ok: fold.ok === true,
      before: fold.before?.totalTokens,
      after: fold.after?.totalTokens,
      digestChars: fold.digestChars,
      skipped: fold.skipped,
    });
    if (fold.ok) {
      report.fold = fold;
      report.after = fold.after;
      report.action = 'retry';
    state.hopeless = false;
      report.attempted = true;
      report.reason = 'mechanical digest fold replaced the oldest history span';
      return report;
    }
  }

  // ------------------------------------- T4 one node that alone overflows
  if (config.trimOversizedMessages !== false) {
    const trimmed = trimOversizedNode(ctx, {
      agent,
      session,
      config,
      windowTokens: window.windowTokens,
      turn,
      reason: `${detected.code || 'CONTEXT_WINDOW_EXCEEDED'}: ${detected.message}`.slice(0, 400),
    });
    tiers.push({
      tier: 'oversized-message',
      ok: trimmed.ok === true,
      shadowedTokens: trimmed.shadowedTokens,
      after: trimmed.after?.totalTokens,
      skipped: trimmed.skipped,
      error: trimmed.error,
    });
    if (trimmed.ok) {
      report.fold = trimmed;
      report.after = trimmed.after;
      report.action = 'retry';
    state.hopeless = false;
      report.attempted = true;
      report.reason = trimmed.trimmed.length > 1
        ? 'one oversized tool output was replaced by its own head and tail'
        : 'one oversized message was replaced by its own head and tail';
      return report;
    }
  }

  report.after = measure(ctx, session);
  report.reason = 'no tier could shrink the projection enough';
  state.hopeless = true;
  // The verdict was about this window and this shape of the history; a switch to
  // a model with more room, or a surface that grew since, has to be able to
  // overturn it. What made every tier decline (a bracket left open, an oversized
  // node at an unbalanced cut, a span under minFoldTokens) can stop being true a
  // minute later, and the request-error path has no other way back.
  state.hopelessWindow = window.windowTokens;
  state.hopelessShape = shapeOf(session);
  return report;
}

/**
 * A cheap fingerprint of the surface: the last seq and the number of nodes.
 * A verdict that no tier can help is only true for the history it was reached
 * on, so the guard compares this and measures again when the surface moved.
 * @param {any} session
 */
function shapeOf(session) {
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes.length : -1;
  return { seq: typeof session?.seq === 'number' ? session.seq : -1, nodes };
}

/**
 * True when the surface is no longer the one the verdict was reached on.
 * @param {any} state
 * @param {any} session
 */
function verdictStale(state, session) {
  const shape = state?.hopelessShape;
  // No shape recorded means the verdict did not come from the ladder; the window
  // check is the only way to overturn those, which is what it did before.
  if (!isObject(shape)) return false;
  const now = shapeOf(session);
  return now.seq !== shape.seq || now.nodes !== shape.nodes;
}

/**
 * The largest surface node that can be excerpted without breaking tool pairing.
 *
 * Cuts are indexed like the measurement -- surface nodes only -- because the raw
 * log also carries `tool/call` mirrors and compaction brackets, and those shift
 * every index, which makes every candidate look unbalanced.
 * @param {any} session
 * @param {any} measurement
 * @param {number} floor
 */
/**
 * Find the largest run of surface nodes that can be replaced as one unit.
 *
 * A text message is a unit by itself: pairing is balanced on both sides, so
 * removing it leaves no orphan. An assistant message that carries tool calls
 * and the tool result answering it are one unit together -- removing either
 * alone orphans the other, and a request with an orphaned result or call is
 * rejected before it is even sent.
 *
 * Returns the span (inclusive indices into `measurement.nodes`) plus the seqs
 * and tokens it covers, or null when nothing above the floor qualifies.
 * @param {any} session
 * @param {any} measurement
 * @param {number} floor
 * @returns {any}
 */
/**
 * The size a single message must reach before excerpting it is worth the loss.
 *
 * Shared with the status preview so the number a person is shown is the number
 * the ladder will use — a preview that measures with a different floor would be
 * a second opinion nobody asked for.
 */
export function oversizeFloor(windowTokens, config) {
  return Math.max(1, Math.floor(config.minFoldTokens), Math.floor(windowTokens * 0.35));
}

/** The seq where the newest turn began, or `undefined` when the log has none. */
function currentTurnStartSeq(session) {
  const events = eventsOf(session);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') return events[index].seq;
  }
  return undefined;
}

/**
 * Pick the message worth excerpting, preferring history over what was just said.
 *
 * A prompt pasted into the current turn is the thing the turn is about; cutting it
 * to a head-and-tail excerpt while older fat sits in the same projection would be
 * legal and useless. Only when nothing older is large enough does the current
 * turn's own message get cut.
 *
 * @param {any} session
 * @param {any} measurement
 * @param {number} floor
 * @param {{turnStartSeq?: number, turn?: number}} [options]
 */
export function pickOversizedNode(session, measurement, floor, options = {}) {
  const nodes = measurement.nodes;
  const events = nodes.map((node) => eventAt(session, node.seq));
  const cuts = pairingCuts(events).cuts;
  let best = null;
  let bestOlder = null;
  const turnStartSeq = Number.isSafeInteger(options.turnStartSeq) ? options.turnStartSeq : undefined;
  for (let index = 0; index < nodes.length; index += 1) {
    if (cuts[index] !== true) continue;
    // The instructions are not history: an excerpt of the system prompt would
    // keep the request legal while quietly removing what the turn was told to do.
    const type = events[index]?.type;
    if (type === 'system/message' || type === 'developer/message') continue;
    let span = null;
    if (cuts[index + 1] === true) {
      span = { start: index, end: index, parts: [nodes[index]], tokens: nodes[index].tokens };
    } else if (
      cuts[index + 2] === true
      && carriesToolCall(events[index])
      && events[index + 1]?.type === 'tool/result'
    ) {
      span = {
        start: index,
        end: index + 1,
        parts: [nodes[index], nodes[index + 1]],
        tokens: nodes[index].tokens + nodes[index + 1].tokens,
      };
    }
    if (span === null) continue;
    const biggest = Math.max(...span.parts.map((part) => part.tokens));
    if (!(biggest >= floor)) continue;
    if (best === null || span.tokens > best.tokens) best = span;
    if (turnStartSeq !== undefined && nodes[index].seq < turnStartSeq) {
      if (bestOlder === null || span.tokens > bestOlder.tokens) bestOlder = span;
    }
  }
  return bestOlder ?? best;
}

/**
 * Does this event carry tool calls that a tool result answers?
 * @param {any} event
 * @returns {boolean}
 */
function carriesToolCall(event) {
  const content = event?.data?.message?.content ?? event?.data?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block !== null && typeof block === 'object' && block.type === 'tool-call');
}

/**
 * Replace one node that alone overflows the window with its own head and tail.
 *
 * Every other tier works on a *span* of history. This one is for the case where
 * the span is a single message: someone pasted a large file into the newest
 * turn, or one tool result is the whole problem. Folding around it cannot help,
 * because the message that must survive is the message that does not fit.
 *
 * The replacement is an excerpt -- head and tail, with the original size stated
 * -- so the request can be sent at all. Fidelity is reduced and the checkpoint
 * says so; the alternative is a turn that cannot be sent.
 *
 * Only a run whose removal keeps tool pairing balanced is eligible: a text
 * message between two turns, or a tool call together with the result that
 * answers it. Dropping either half of that pair alone would orphan the other,
 * and the host rejects a request that carries an orphaned call or result.
 * @param {any} ctx
 * @param {{agent: any, session: any, config: any, windowTokens: number, turn?: number, reason: string}} options
 * @returns {any}
 */
function trimOversizedNode(ctx, options) {
  const { session, config, windowTokens, turn, reason } = options;
  const support = supportsFold(session);
  if (!support.ok) {
    return { ok: false, tier: 'oversized-message', skipped: `unsupported session (missing ${support.missing.join(', ')})` };
  }

  const floor = oversizeFloor(windowTokens, config);

  const chars = Math.max(200, Math.floor(config.excerptChars ?? 3000));
  const before = measure(ctx, session);
  const best = pickOversizedNode(session, before, floor, { turnStartSeq: currentTurnStartSeq(session), turn });
  if (best === null) {
    return {
      ok: false,
      tier: 'oversized-message',
      skipped: `no message above ${floor} tokens can be replaced without breaking tool pairing (the system prompt is never excerpted)`,
    };
  }

  // The excerpt is taken from the part that does not fit; for a call/result
  // pair that is the result, and the call is named on the header line.
  const biggest = best.parts.reduce((largest, node) => (node.tokens > largest.tokens ? node : largest), best.parts[0]);
  const raw = eventText(typeof session.eventAt === 'function' ? session.eventAt(biggest.seq) : undefined);
  const head = raw.slice(0, chars);
  const tail = raw.length > chars * 2 ? raw.slice(-chars) : '';
  const paired = best.parts.length > 1;
  const toolName = paired ? eventAt(session, best.parts[best.parts.length - 1].seq)?.data?.name : undefined;
  const text = [
    paired
      ? '### 一次工具调用的输出单独就超过了模型窗口，已替换为首尾摘录'
      : '### 一条消息单独就超过了模型窗口，已替换为首尾摘录',
    ...(typeof toolName === 'string' && toolName !== '' ? [`- 工具：${toolName}`] : []),
    `- 原始长度：${raw.length} 字符（约 ${best.tokens} tokens）；模型窗口 ${windowTokens} tokens`,
    `- 保留开头 ${head.length} 字符与结尾 ${tail.length} 字符，中间部分已丢弃`,
    `- 触发原因：${reason}`,
    '- 需要精确内容时请让用户重新发送该段，或分段提供',
    '',
    '**开头**：',
    head,
    ...(tail === '' ? [] : ['', '**结尾**：', tail]),
  ].join(String.fromCharCode(10));

  const shadowedSeqs = best.parts.map((node) => node.seq);
  let written;
  try {
    written = applyFold(session, {
      start: shadowedSeqs[0],
      end: shadowedSeqs[shadowedSeqs.length - 1],
      shadowedSeqs,
      shadowedTokenCount: best.tokens,
      text,
      turn,
      kind: 'prune',
      expectedSeq: session.seq,
    });
  } catch (error) {
    return { ok: false, tier: 'oversized-message', error: errorText(error) };
  }

  const after = measure(ctx, session);
  const ok = after.totalTokens < before.totalTokens && fits(after.totalTokens, windowTokens, config.fitRatio);
  return {
    ok,
    tier: 'oversized-message',
    before,
    after,
    trimmed: best.parts.map((node) => ({ seq: node.seq, tokens: node.tokens, chars: text.length })),
    shadowedTokens: best.tokens,
    shadowedSeq: shadowedSeqs[0],
    digestChars: text.length,
    written,
    ...(ok ? {} : { skipped: 'the excerpt still does not fit the window' }),
  };
}

/**
 * Fold before the request is built.
 *
 * The request-error hook only runs after a wasted round trip. When the
 * projection is already larger than the model window there is nothing the host
 * could send: the request is certain to fail. Compaction-basic's pressure hook
 * may still not help -- it can bail out on a missing window target, or its
 * engine can be missing in this profile -- so the pre-flight half of the rescue
 * folds now and the step proceeds with a request that fits.
 *
 * Only a hard overflow (projection > window) is acted on, never the pressure
 * band: ordinary compaction policy stays the host's business.
 *
 * @param {any} ctx
 * @param {{
 *   agent: any, session: any, config: any, signal?: AbortSignal,
 *   provider?: string, model?: string, turn?: number
 * }} options
 * @returns {Promise<{
 *   trigger: string, detected: any, window: any, before: any, after: any,
 *   tiers: Array<any>, fold: any, action: 'fold'|'prune'|'pass', reason: string,
 *   attempted: boolean
 * }>}
 */
/** Event types the host keeps on the surface, i.e. the ones a request pays for. */
const SURFACE_TYPES = new Set([
  'system/message', 'user/message', 'assistant/message', 'developer/message', 'tool/result',
]);

/**
 * How much the projection grew since the last full measurement.
 *
 * Pre-flight fires once per step, and measuring a multi-million token session
 * costs about a second, so re-measuring every step to learn that nothing
 * happened is the wrong trade. This walks only the events appended since the
 * last check — a handful per step — and flags anything big enough that the
 * cheap answer cannot be trusted.
 */
function growthSince(session, lastSeq) {
  let tokens = 0;
  let nodes = 0;
  let big = false;
  for (const event of eventsOf(session)) {
    if (!isObject(event)) continue;
    if (typeof event.seq !== 'number' || event.seq <= lastSeq) continue;
    if (!SURFACE_TYPES.has(event.type)) continue;
    const text = eventText(event);
    nodes += 1;
    tokens += estimateTokensFromText(text);
    if (text.length > 4000) big = true;
  }
  return { tokens, nodes, big };
}

export async function preflight(ctx, options) {
  const { agent, session, config, signal, turn } = options;
  const state = rescueStateOf(agent);

  // Same guard as the ladder: a session that defeated every tier is not
  // measured again on every step. The step continues, the request is still
  // attempted, and the failure path has one more chance to explain itself.
  // A window that changed since the verdict is a different question, so the
  // verdict is dropped and the step gets looked at properly.
  if (state.hopeless === true) {
    const current = await resolveWindow(ctx, {
      provider: options.provider,
      model: options.model,
      signal,
      session,
      config,
    });
    const remembered = typeof state.hopelessWindow === 'number' ? state.hopelessWindow : null;
    if (verdictStale(state, session) || (remembered !== null && current.windowTokens !== remembered)) {
      state.hopeless = false;
      state.hopelessWindow = undefined;
      state.hopelessShape = undefined;
    }
  }
  if (state.hopeless === true) {
    const known = typeof state.lastPreflight?.tokens === 'number' ? state.lastPreflight.tokens : 0;
    return {
      trigger: 'pre-step',
      detected: null,
      window: state.windowCache?.window ?? null,
      before: { totalTokens: known, nodes: [], source: 'growth' },
      after: { totalTokens: known, nodes: [], source: 'growth' },
      tiers: [],
      fold: null,
      action: 'pass',
      reason: 'this session defeated every tier in an earlier turn; the step continues unchanged (run /rescue to try once more)',
      attempted: false,
    };
  }
  repairIfNeeded(ctx, session, config, turn);

  /**
   * Resolving the window can reach into the model registry, so it is cached per
   * target for this agent: a turn fires pre-step once per step and the answer
   * does not change between them.
   */
  const cacheKey = `${options.provider ?? ''}|${options.model ?? ''}|${config.windowFallback}`;
  let window = state.windowCache?.key === cacheKey ? state.windowCache.window : undefined;
  if (!window) {
    window = await resolveWindow(ctx, {
      provider: options.provider,
      model: options.model,
      signal,
      session,
      config,
    });
    state.windowCache = { key: cacheKey, window };
  }

  const nodesNow = Array.isArray(session?.surface?.nodes) ? session.surface.nodes.length : undefined;
  const cached = state.lastPreflight;
  let before;
  if (cached && typeof session?.seq === 'number' && session.seq >= cached.seq) {
    const delta = growthSince(session, cached.seq);
    const shapeIntact = nodesNow === undefined || nodesNow === cached.nodes + delta.nodes;
    const estimate = cached.tokens + delta.tokens;
    if (shapeIntact && !delta.big && estimate <= window.windowTokens * config.fitRatio) {
      return {
        trigger: 'pre-step',
        detected: null,
        window,
        before: { totalTokens: estimate, nodes: [], source: 'growth' },
        after: { totalTokens: estimate, nodes: [], source: 'growth' },
        tiers: [],
        fold: null,
        action: 'pass',
        reason: 'projection still fits: measured once, then only the events appended since were counted',
        attempted: false,
      };
    }
  }
  before = measure(ctx, session);
  state.lastPreflight = {
    seq: typeof session?.seq === 'number' ? session.seq : 0,
    nodes: nodesNow ?? before.nodes.length,
    tokens: before.totalTokens,
  };

  /**
   * Annotated for the same reason as the ladder's report: every branch mutates
   * it in place, and an unannotated literal widens `action` to `string`.
   * @type {{
   *   trigger: string, detected: any, window: any, before: any, after: any,
   *   tiers: Array<any>, fold: any, action: 'prune'|'fold'|'pass', reason: string,
   *   attempted: boolean
   * }}
   */
  const report = {
    trigger: 'pre-step',
    detected: null,
    window,
    before,
    after: before,
    tiers: [],
    fold: null,
    action: 'pass',
    reason: '',
    attempted: false,
  };

  if (!(typeof window?.windowTokens === 'number' && window.windowTokens > 0)) {
    report.reason = 'no model window for this target';
    return report;
  }
  if (before.totalTokens <= window.windowTokens) {
    report.reason = 'projection fits the model window';
    return report;
  }
  if (config.mode === 'diagnose') {
    report.reason = 'mode=diagnose: projection is over the window, no rewrite performed';
    return report;
  }

  const support = supportsFold(session);
  if (!support.ok) {
    report.reason = `unsupported session (missing ${support.missing.join(', ')})`;
    return report;
  }

  // ------------------------------------------------------------------ T1 prune
  const pruner = prunerOf(ctx);
  if (pruner) {
    try {
      await pruner.pruneSession(session);
      const afterPrune = measure(ctx, session);
      const shrank = afterPrune.totalTokens < before.totalTokens;
      report.tiers.push({ tier: 'prune', ok: shrank, before: before.totalTokens, after: afterPrune.totalTokens });
      if (fits(afterPrune.totalTokens, window.windowTokens, config.fitRatio)) {
        report.after = afterPrune;
        report.action = 'prune';
    state.hopeless = false;
        report.attempted = true;
        report.reason = 'tool-result prune brought the request under the window';
        rememberReport(agent, report);
        return report;
      }
    } catch (error) {
      report.tiers.push({ tier: 'prune', ok: false, error: errorText(error) });
    }
  } else {
    report.tiers.push({ tier: 'prune', ok: false, skipped: 'no host tool-result pruner installed' });
  }

  // ------------------------------------------- T3 mechanical fold (zero model)
  // T2 stays out of this path on purpose: the host engine has its own pre-step
  // pressure hook, and borrowing it here would compact twice for one overshoot.
  const fold = mechanicalFold(ctx, {
    agent,
    session,
    config,
    windowTokens: window.windowTokens,
    reason: 'the request would have exceeded the model window before it was sent',
    turn,
  });
  report.fold = fold;
  report.tiers.push({
    tier: 'mechanical-fold',
    ok: fold.ok === true,
    before: fold.before?.totalTokens,
    after: fold.after?.totalTokens,
    digestChars: fold.digestChars,
    skipped: fold.skipped,
  });
  report.attempted = true;
  if (fold.ok) {
    report.action = 'fold';
    state.hopeless = false;
    report.after = fold.after;
    report.reason = 'folded the oldest span before the request was built';
    rememberReport(agent, report);
    return report;
  }

  // T4: the overshoot is one message, so there is no span to fold around it.
  if (config.trimOversizedMessages !== false) {
    const trimmed = trimOversizedNode(ctx, {
      agent,
      session,
      config,
      windowTokens: window.windowTokens,
      turn,
      reason: 'the request would have exceeded the model window before it was sent',
    });
    report.tiers.push({
      tier: 'oversized-message',
      ok: trimmed.ok === true,
      shadowedTokens: trimmed.shadowedTokens,
      after: trimmed.after?.totalTokens,
      skipped: trimmed.skipped,
      error: trimmed.error,
    });
    if (trimmed.ok) {
      report.action = 'fold';
    state.hopeless = false;
      report.fold = trimmed;
      report.after = trimmed.after;
      report.reason = trimmed.trimmed.length > 1
        ? 'replaced one oversized tool output with its own head and tail'
        : 'replaced one oversized message with its own head and tail';
      rememberReport(agent, report);
      return report;
    }
  }

  report.reason = fold.skipped ?? 'the fold did not shrink the projection';
  rememberReport(agent, report);
  return report;
}

/**
 * Record a report on the agent's state so the [context_rescue] tool can show it.
 * @param {any} agent
 * @param {any} agentReport
 */
export function rememberReport(agent, agentReport) {
  const state = rescueStateOf(agent);
  state.lastReport = agentReport;
  if (agentReport.action === 'retry') state.hopeless = false;
  state.history = [...state.history.slice(-9), { at: Date.now(), action: agentReport.action, reason: agentReport.reason, tiers: agentReport.tiers?.map((tier) => tier.tier) }];
  return state;
}

/** Explain the plugin's view of one session, for the diagnostics tool. */
export async function describeSession(ctx, options) {
  const { session, config, provider, model, signal } = options;
  const measurement = measure(ctx, session);
  const detected = options.failure ? classifyFailure(options.failure, { extraPatterns: config.extraPatterns }) : null;
  const window = await resolveWindow(ctx, {
    provider,
    model,
    signal,
    evidence: detected?.evidence,
    session,
    config,
  });
  const engine = serviceOf(ctx, 'compaction');
  const pruner = prunerOf(ctx);
  const support = supportsFold(session);
  const alreadyFits = fits(measurement.totalTokens, window.windowTokens, config.fitRatio);
  // What a rescue would do right now, without doing it: a person can decide
  // whether to let the fold happen, and how much history it would cost.
  /** @type {null | {start: number, end: number, shadowedNodes: number, shadowedTokens: number, retainedTokens: number, digestChars: number, pinDropped: boolean}} */
  let preview = null;
  if (!alreadyFits && support.ok) {
    const plan = planFold(session, measurement, {
      retainOptions: retainOptions(window.windowTokens, config),
      targetTokens: Math.floor(window.windowTokens * config.targetRatio),
      minFoldTokens: config.minFoldTokens,
      pinFirstUserMessage: config.pinFirstUserMessage,
    });
    if (plan) {
      const text = buildDigest(session, {
        startSeq: plan.start,
        endSeq: plan.end,
        shadowedSeqs: plan.shadowedSeqs,
        shadowedTokenCount: plan.shadowedTokenCount,
        totalTokens: plan.totalTokens,
        windowTokens: window.windowTokens,
        measuredTokens: measurement.totalTokens,
        reason: 'preview',
        maxChars: config.maxDigestChars,
        pinDropped: plan.pinDropped === true,
      });
      preview = {
        start: plan.start,
        end: plan.end,
        shadowedNodes: plan.shadowedSeqs.length,
        shadowedTokens: plan.shadowedTokenCount,
        retainedTokens: plan.retainedTokens,
        digestChars: text.length,
        pinDropped: plan.pinDropped === true,
      };
    }
  }
  // Nothing to fold does not mean nothing to do: when the oversize is one
  // message, T4 would excerpt it, and the status would otherwise claim the
  // rescue finds nothing at all.
  /** @type {null | {startSeq: number, endSeq: number, tokens: number, parts: number}} */
  let previewOversized = null;
  if (!alreadyFits && preview === null) {
    const span = pickOversizedNode(session, measurement, oversizeFloor(window.windowTokens, config), {
      turnStartSeq: currentTurnStartSeq(session),
    });
    if (span !== null) {
      previewOversized = {
        startSeq: span.parts[0].seq,
        endSeq: span.parts.at(-1).seq,
        tokens: span.tokens,
        parts: span.parts.length,
      };
    }
  }
  // What the provider would actually receive, as opposed to what the surface
  // prices at: the two can differ, and that difference is why a session can look
  // fine here and still be refused upstream.
  const derived = derivedTokensOf(ctx, session);
  return {
    sessionId: session?.id ?? session?.sessionId,
    surfaceNodes: Array.isArray(session?.surface?.nodes) ? session.surface.nodes.length : 0,
    loggedEvents: eventsOf(session).length,
    measuredTokens: measurement.totalTokens,
    measurementSource: measurement.source,
    derivedTokens: derived ? derived.totalTokens : null,
    derivedMessages: derived ? derived.messages : null,
    window,
    occupancy: window.windowTokens > 0 ? measurement.totalTokens / window.windowTokens : 0,
    fits: alreadyFits,
    preview,
    previewOversized,
    foldSupported: support,
    hostCompaction: isObject(engine) ? 'mounted' : 'absent',
    toolResultPruner: pruner ? 'mounted' : 'absent',
    // A dangling bracket blocks every fold; the repair pass closes it, but the
    // status answer has to say it happened.
    openTransactions: [...openTransactions(session).keys()],
    config,
    detected,
  };
}
