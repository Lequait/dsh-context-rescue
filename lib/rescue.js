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
import { eventText, eventsOf, fits, measure, resolveWindow, serviceOf } from './measure.js';
import { classifyFailure, isLaneRefusal } from './overflow.js';
import { pairingCuts, planFold } from './plan.js';
import { openTransactions, repairStaleTransactions } from './repair.js';
import { asText, errorText, isObject } from './util.js';

/** Per-agent rescue bookkeeping. */
const RESCUE_STATE = new WeakMap();

/** Read (or create) the rescue state for one agent. */
export function rescueStateOf(agent) {
  let state = RESCUE_STATE.get(agent);
  if (!state) {
    state = { turn: undefined, attempts: 0, laneBlocked: false, lastReport: null, history: [] };
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
  });

  const after = measure(ctx, session);
  const shrank = after.totalTokens < before.totalTokens;
  return {
    ok: shrank,
    tier: 'mechanical-fold',
    before,
    after,
    plan,
    written,
    digestChars: text.length,
    skipped: shrank ? undefined : 'replacement was not smaller than the folded span',
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
  repairIfNeeded(ctx, session, config, turn);
  const before = measure(ctx, session);

  if (!detected.overflow && options.force !== true) {
    return { detected, window: null, before, after: before, tiers, fold: null, action: 'pass', reason: 'not a context-overflow failure', attempted: false };
  }

  const window = await resolveWindow(ctx, {
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
  const insist = typeof options.attempt === 'number' && options.attempt > 1;
  if (!insist && fits(before.totalTokens, window.windowTokens, config.fitRatio)) {
    report.action = 'retry';
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
  const canBorrow = config.allowModelCompaction && !config.zeroModelOnly && !state.laneBlocked
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
        : config.zeroModelOnly
          ? 'zeroModelOnly=true'
          : !engine
            ? 'no host compaction engine mounted'
            : 'allowModelCompaction=false',
    });
  }

  // ------------------------------------------------- T3 mechanical digest fold
  if (config.mode !== 'prune') {
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
      report.attempted = true;
      report.reason = 'one oversized message was replaced by its own head and tail';
      return report;
    }
  }

  report.after = measure(ctx, session);
  report.reason = 'no tier could shrink the projection enough';
  return report;
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
 * Only a node whose removal keeps tool pairing balanced is eligible (a text
 * message between two turns): dropping a tool result or an assistant message
 * that carries calls would orphan its counterpart.
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

  const before = measure(ctx, session);
  const cuts = pairingCuts(eventsOf(session)).cuts;
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
  const floor = Math.max(1, Math.floor(config.minFoldTokens), Math.floor(windowTokens * 0.35));

  let best = null;
  for (let index = 0; index < before.nodes.length; index += 1) {
    const node = before.nodes[index];
    if (!(node.tokens >= floor)) continue;
    if (cuts[index] !== true || cuts[index + 1] !== true) continue;
    if (best === null || node.tokens > best.tokens) best = node;
  }
  if (best === null) {
    return {
      ok: false,
      tier: 'oversized-message',
      skipped: `no single node above ${floor} tokens can be replaced without breaking tool pairing`,
    };
  }

  const chars = Math.max(200, Math.floor(config.excerptChars ?? 3000));
  const raw = eventText(typeof session.eventAt === 'function' ? session.eventAt(best.seq) : undefined);
  const head = raw.slice(0, chars);
  const tail = raw.length > chars * 2 ? raw.slice(-chars) : '';
  const text = [
    '### 一条消息单独就超过了模型窗口，已替换为首尾摘录',
    `- 原始长度：${raw.length} 字符（约 ${best.tokens} tokens）；模型窗口 ${windowTokens} tokens`,
    `- 保留开头 ${head.length} 字符与结尾 ${tail.length} 字符，中间部分已丢弃`,
    `- 触发原因：${reason}`,
    '- 需要精确内容时请让用户重新发送该段，或分段提供',
    '',
    '**开头**：',
    head,
    ...(tail === '' ? [] : ['', '**结尾**：', tail]),
  ].join(String.fromCharCode(10));

  let written;
  try {
    written = applyFold(session, {
      start: best.seq,
      end: best.seq,
      shadowedSeqs: [best.seq],
      shadowedTokenCount: best.tokens,
      text,
      turn,
      kind: 'prune',
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
    shadowedTokens: best.tokens,
    shadowedSeq: best.seq,
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
export async function preflight(ctx, options) {
  const { agent, session, config, signal, turn } = options;
  const state = rescueStateOf(agent);
  repairIfNeeded(ctx, session, config, turn);
  const before = measure(ctx, session);

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
      report.fold = trimmed;
      report.after = trimmed.after;
      report.reason = 'replaced one oversized message with its own head and tail';
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
  return {
    sessionId: session?.id ?? session?.sessionId,
    surfaceNodes: Array.isArray(session?.surface?.nodes) ? session.surface.nodes.length : 0,
    loggedEvents: eventsOf(session).length,
    measuredTokens: measurement.totalTokens,
    measurementSource: measurement.source,
    window,
    occupancy: window.windowTokens > 0 ? measurement.totalTokens / window.windowTokens : 0,
    fits: fits(measurement.totalTokens, window.windowTokens, config.fitRatio),
    foldSupported: supportsFold(session),
    hostCompaction: isObject(engine) ? 'mounted' : 'absent',
    toolResultPruner: pruner ? 'mounted' : 'absent',
    // A dangling bracket blocks every fold; the repair pass closes it, but the
    // status answer has to say it happened.
    openTransactions: [...openTransactions(session).keys()],
    config,
    detected,
  };
}
