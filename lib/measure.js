/**
 * Measurement and window resolution.
 *
 * Everything is feature-detected: a host that lacks a token meter still gets a
 * usable estimate, and a host that cannot resolve model info still gets a
 * window from the failure text or from configuration.
 * @module dsh-context-rescue/measure
 */

import { asText, contentBlocksToRawText, estimateTokensFromText, isObject } from './util.js';

/** Reach a service by property or by `ctx.get`, whatever the host offers. */
export function serviceOf(ctx, name) {
  if (!ctx) return undefined;
  try {
    const direct = ctx[name];
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    // A throwing getter is not a usable service.
  }
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** The host token meter, when present. */
export function tokenMeterOf(ctx) {
  const meter = serviceOf(ctx, 'tokenMeter');
  return meter && typeof meter.measure === 'function' ? meter : undefined;
}

/** Read the model-facing text of one logged event, without host projections. */
export function eventText(event) {
  if (!isObject(event)) return '';
  const data = isObject(event.data) ? event.data : {};
  if (data.message !== undefined) {
    const message = data.message;
    if (isObject(message)) return contentBlocksToRawText(message.content);
    return asText(message);
  }
  if (data.content !== undefined) return contentBlocksToRawText(data.content);
  if (data.text !== undefined) return asText(data.text);
  if (data.command !== undefined) return asText(data.command);
  return '';
}

/** Every event of a session, whatever the host exposes them as. */
export function eventsOf(session) {
  const direct = session?.events;
  if (Array.isArray(direct)) return direct;
  if (typeof session?.snapshotEvents === 'function') {
    const snapshot = session.snapshotEvents();
    if (Array.isArray(snapshot)) return snapshot;
  }
  if (typeof session?.ownEvents === 'function') {
    const own = session.ownEvents();
    if (Array.isArray(own)) return own;
  }
  return [];
}

/** The current surface positions, or every message-producing event as a fallback. */
export function surfaceSeqsOf(session) {
  const nodes = session?.surface?.nodes;
  if (Array.isArray(nodes) && nodes.length > 0) return nodes.slice();
  const events = eventsOf(session);
  const messageTypes = new Set(['system/message', 'user/message', 'assistant/message', 'developer/message', 'tool/result']);
  return events.filter((event) => messageTypes.has(event?.type)).map((event) => event.seq);
}

/**
 * Measure the session. Prefers the host meter; otherwise derives per-node
 * estimates from the logged events so planning still works.
 * @param {any} ctx
 * @param {any} session
 * @returns {{totalTokens: number, nodes: Array<{seq: any, tokens: number, heuristicTokens: number}>, source: 'meter'|'estimate'}}
 */
export function measure(ctx, session) {
  const meter = tokenMeterOf(ctx);
  if (meter) {
    try {
      const measurement = meter.measure(session);
      if (isObject(measurement) && Array.isArray(measurement.nodes) && Number.isFinite(measurement.totalTokens)) {
        return {
          totalTokens: Math.max(0, Math.floor(measurement.totalTokens)),
          nodes: measurement.nodes.map((node) => ({
            seq: node.seq,
            tokens: Math.max(0, Math.floor(node.tokens ?? node.heuristicTokens ?? 0)),
            heuristicTokens: Math.max(0, Math.floor(node.heuristicTokens ?? node.tokens ?? 0)),
          })),
          source: 'meter',
        };
      }
    } catch {
      // Fall through to the estimator.
    }
  }
  const seqs = surfaceSeqsOf(session);
  const nodes = seqs.map((seq) => {
    const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : undefined;
    const tokens = estimateTokensFromText(eventText(event));
    return { seq, tokens, heuristicTokens: tokens };
  });
  const totalTokens = nodes.reduce((total, node) => total + node.tokens, 0);
  return { totalTokens, nodes, source: 'estimate' };
}

/** Estimate one message's cost, for pre-flight sizing of a replacement body. */
export function estimateMessageTokens(ctx, message) {
  const meter = tokenMeterOf(ctx);
  if (meter && typeof meter.estimateMessage === 'function') {
    try {
      const value = meter.estimateMessage(message);
      if (Number.isFinite(value)) return Math.max(0, Math.floor(value));
    } catch {
      // Fall through.
    }
  }
  return estimateTokensFromText(contentBlocksToRawText(message?.content));
}

/**
 * Resolve the effective window for this request.
 *
 * The declared window is only half the story: an adapter may advertise 1M while
 * the routed upstream enforces 196608 (discussion #10138). When the failure
 * text names a smaller window, that smaller number is the one to plan against.
 * @param {any} ctx
 * @param {{
 *   provider?: string, model?: string, signal?: AbortSignal,
 *   evidence?: {windowTokens?: number}, session?: any, config: {windowFallback: number}
 * }} options
 */
export async function resolveWindow(ctx, options) {
  const { provider, model, signal, evidence, session, config } = options;
  let declared;
  let source = 'config';
  const llm = serviceOf(ctx, 'llm');
  let resolvedModel = model;
  let resolvedProvider = provider;
  if ((!resolvedProvider || !resolvedModel) && typeof session?.requestHeader === 'function') {
    try {
      const header = session.requestHeader();
      resolvedModel = resolvedModel ?? header?.model;
      resolvedProvider = resolvedProvider ?? header?.provider;
    } catch {
      // Ignore: model resolution is best-effort.
    }
  }
  if (llm && typeof llm.resolveModelInfo === 'function' && resolvedProvider) {
    try {
      const info = await llm.resolveModelInfo(resolvedProvider, resolvedModel, signal);
      const window = info?.context?.contextWindow ?? info?.contextWindow;
      if (Number.isFinite(window) && window > 0) {
        declared = Math.floor(window);
        source = 'model-info';
      }
    } catch {
      // Ignore: fall back to the failure text and configuration.
    }
  }
  if (declared === undefined && typeof session?.contextWindow === 'number' && session.contextWindow > 0) {
    declared = Math.floor(session.contextWindow);
    source = 'session';
  }
  const observed = Number.isFinite(evidence?.windowTokens) && evidence.windowTokens > 0
    ? Math.floor(evidence.windowTokens)
    : undefined;
  let windowTokens = declared ?? observed ?? config.windowFallback;
  if (observed !== undefined && observed < windowTokens) windowTokens = observed;
  return {
    windowTokens,
    declared,
    observed,
    source: observed !== undefined && observed < (declared ?? Infinity) ? 'observed-override' : source,
    model: resolvedModel,
    provider: resolvedProvider,
  };
}

/**
 * Tokens of the messages the host would actually build from this session right
 * now. `measure()` prices the surface nodes; this prices `deriveMessages()`,
 * which is what the provider has to accept, so it is the number a rescue really
 * has to change. Returns `null` when the session cannot derive messages.
 * @returns {{totalTokens: number, messages: number} | null}
 */
export function derivedTokensOf(ctx, session) {
  let messages;
  try {
    messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : undefined;
  } catch {
    return null;
  }
  if (!Array.isArray(messages)) return null;
  let totalTokens = 0;
  for (const message of messages) totalTokens += estimateMessageTokens(ctx, message);
  return { totalTokens, messages: messages.length };
}

/** True when the projection is small enough to retry with confidence. */
export function fits(totalTokens, windowTokens, ratio) {
  return totalTokens <= Math.floor(windowTokens * ratio);
}
