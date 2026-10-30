/**
 * A minimal, dependency-free stand-in for the host session and context objects.
 *
 * It implements exactly the surface dsh-context-rescue touches — `append`,
 * `surface.nodes`, `eventAt`, `events` — plus the token-meter/LLM services the
 * plugin feature-detects. The append path enforces the same invariants the host
 * enforces, so a broken fold protocol fails the tests instead of a live session.
 * @module dsh-context-rescue/tests/fake-session
 */

import { estimateTokensFromText, contentBlocksToRawText } from '../lib/util.js';

const MESSAGE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'developer/message', 'tool/result']);

export class FakeSession {
  constructor(options = {}) {
    this.id = options.id ?? 'fake-session';
    this.events = [];
    this.surface = { nodes: [] };
    this.seq = 0;
    this.appendLog = [];
    this.forceError = null;
    this.provider = options.provider ?? 'fake-provider';
    this.model = options.model ?? 'fake-model';
  }

  append(type, data, options) {
    if (this.forceError) throw this.forceError;
    const seq = ++this.seq;
    const event = { seq, time: this.seq, type, data: data ?? {}, ...(options ? { options } : {}) };
    this.events.push(event);
    this.appendLog.push({ type, seq, options });

    if (options?.surfaceOp) {
      if (options.surfaceOp.op !== 'replace') throw new Error(`fake-session: unsupported surfaceOp ${options.surfaceOp.op}`);
      const nodes = this.surface.nodes;
      const startIdx = nodes.indexOf(options.surfaceOp.startSeq);
      const endIdx = nodes.indexOf(options.surfaceOp.endSeq);
      if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
        throw new Error('fake-session: corrupt surface (replacement range is not on the surface)');
      }
      nodes.splice(startIdx, endIdx - startIdx + 1, seq);
    } else if (MESSAGE_TYPES.has(type)) {
      this.surface.nodes.push(seq);
    }
    return event;
  }

  eventAt(seq) {
    return this.events.find((event) => event.seq === seq);
  }

  requestHeader() {
    return { provider: this.provider, model: this.model };
  }
}

/** Per-message token estimate that matches the host meter's ballpark. */
export function priceOf(session, seq) {
  const event = session.eventAt(seq);
  if (!event) return 0;
  const data = event.data ?? {};
  const message = data.message ?? data;
  return Math.max(1, estimateTokensFromText(contentBlocksToRawText(message.content ?? message.text ?? message)));
}

/** A token meter with the host's shape. */
export function fakeMeter() {
  return {
    measure(session) {
      const nodes = session.surface.nodes.map((seq) => {
        const tokens = priceOf(session, seq);
        return { seq, tokens, heuristicTokens: tokens };
      });
      return { totalTokens: nodes.reduce((total, node) => total + node.tokens, 0), nodes };
    },
    estimateMessage(message) {
      return Math.max(1, estimateTokensFromText(contentBlocksToRawText(message?.content)));
    },
  };
}

/**
 * Build a conversation shaped like a real long session:
 * alternating user/assistant turns with interleaved tool calls whose results are
 * adjacent, so tool pairing is exercised.
 * @param {{turns?: number, chars?: number, withTools?: boolean}} options
 */
export function seedConversation(session, options = {}) {
  const turns = options.turns ?? 30;
  const chars = options.chars ?? 1200;
  const withTools = options.withTools !== false;
  session.append('system/message', { message: { content: [{ type: 'text', text: '你是助手。' }] } });
  for (let index = 0; index < turns; index += 1) {
    session.append('user/message', {
      message: { content: [{ type: 'text', text: `第 ${index} 轮用户需求：${'需要处理的长文本。'.repeat(Math.ceil(chars / 9))}` }] },
    });
    if (withTools) {
      // Real v4 surfaces record the call as an assistant content block, mirror it
      // as a tool/call event, and close the pairing with a tool/result event.
      // Only the block and the result move the pairing balance, so the seed has
      // to carry the same shape to be representative.
      const callArguments = { path: 'H:\\AI\\project\\src\\module-' + index + '.js' };
      session.append('assistant/message', {
        message: {
          content: [
            { type: 'text', text: `第 ${index} 轮：读取模块。` },
            { type: 'tool-call', name: 'read_file', arguments: callArguments },
          ],
        },
      });
      session.append('tool/call', { call: { name: 'read_file', arguments: callArguments } });
      session.append('tool/result', { result: { content: [{ type: 'text', text: `file content ${index} `.repeat(Math.ceil(chars / 20)) }] } });
    }
    session.append('assistant/message', {
      message: { content: [{ type: 'text', text: `第 ${index} 轮结论：已处理 ${index} 个模块，下一步继续。` }] },
    });
  }
  return session;
}

/** A fake context exposing the services the plugin looks for. */
export function fakeContext(options = {}) {
  const listeners = new Map();
  const services = new Map();
  const logs = [];
  services.set('tokenMeter', options.tokenMeter ?? fakeMeter());
  if (options.llm) services.set('llm', options.llm);
  if (options.compaction) services.set('compaction', options.compaction);
  if (options.pruner) services.set('toolResultPruner', options.pruner);
  if (options.tools) services.set('tools', options.tools);
  services.set('logger', {
    info: (message, data) => logs.push({ level: 'info', message, data }),
    warn: (message, data) => logs.push({ level: 'warn', message, data }),
    error: (message, data) => logs.push({ level: 'error', message, data }),
  });
  return {
    services,
    listeners,
    logs,
    get(name) {
      return services.get(name);
    },
    on(name, handler) {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    },
  };
}

/** A fake LLM service that declares an arbitrary window. */
export function fakeLlm(contextWindow) {
  return {
    async resolveModelInfo(provider, model) {
      if (!Number.isFinite(contextWindow)) throw new Error('no window');
      return { provider, model, context: { contextWindow } };
    },
  };
}
