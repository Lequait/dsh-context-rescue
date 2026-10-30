#!/usr/bin/env node
/**
 * Offline simulation of a session that died on a context-window overflow.
 *
 * Runs the real plugin code against a synthetic session that reproduces the
 * reported failure: the adapter declares a 1M window, the routed upstream
 * enforces 196,608, the projection is far larger, and the gateway words the
 * rejection so the host's own classifier does not recognise it.
 *
 * Each scenario prints what the bare harness does versus what the plugin does.
 * Exit code is non-zero when any scenario fails its expectation, so CI or a
 * human can trust it.
 * @module dsh-context-rescue/scripts/simulate
 */

import { FakeSession, fakeContext, fakeLlm, seedConversation } from '../tests/fake-session.js';
import { resolveConfig } from '../lib/config.js';
import { measure } from '../lib/measure.js';
import { apply } from '../index.js';

const DECLARED_WINDOW = 1_000_000;
const EFFECTIVE_WINDOW = 196_608;
const GATEWAY_MESSAGE = (tokens) => `payload core text alone is ~${tokens * 8} bytes; `
  + `that is ≥ ~${tokens} tokens vs the model window ${EFFECTIVE_WINDOW} — no upstream can accept it`;

/** One "model request" against a session, exactly as an adapter would size it. */
function attemptRequest(ctx, session) {
  const measurement = measure(ctx, session);
  if (measurement.totalTokens > EFFECTIVE_WINDOW) {
    return { ok: false, tokens: measurement.totalTokens, failure: { code: 'INVALID_REQUEST', message: GATEWAY_MESSAGE(measurement.totalTokens) } };
  }
  return { ok: true, tokens: measurement.totalTokens };
}

/**
 * Drive the harness loop: attempt, hand failures to the plugin listener,
 * retry when the listener asks for it.
 */
async function runLoop({ session, ctx, withPlugin, maxAttempts = 5 }) {
  const handler = withPlugin ? ctx.listeners.get('agent/request-error') : undefined;
  const log = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const outcome = attemptRequest(ctx, session);
    log.push({ attempt, ok: outcome.ok, tokens: outcome.tokens });
    if (outcome.ok) return { ok: true, attempts: attempt, log };
    if (!handler) continue; // bare harness: same oversized body, same 400, every time
    const action = await handler(
      { agent: { session }, failure: outcome.failure, provider: 'demo', turn: 1, step: attempt, signal: undefined },
      async () => undefined,
    );
    if (action?.kind !== 'retry') {
      log.push({ attempt, delegated: true });
      return { ok: false, attempts: attempt, log, reason: 'listener delegated to the host' };
    }
  }
  return { ok: false, attempts: maxAttempts, log, reason: 'attempt budget exhausted' };
}

function line(status, text) {
  process.stdout.write(`${status} ${text}\n`);
}

function num(value) {
  return Math.round(value).toLocaleString('en-US');
}

/** Scenario 1: the reported case — declared 1M, enforced 196k, long history. */
async function scenarioReported() {
  const session = new FakeSession();
  seedConversation(session, { turns: 130, chars: 9000 });
  const ctx = fakeContext({ llm: fakeLlm(DECLARED_WINDOW) });
  const baseline = await runLoop({ session: session.constructor === FakeSession ? clone(session) : session, ctx: fakeContext({ llm: fakeLlm(DECLARED_WINDOW) }), withPlugin: false });

  const pluginCtx = fakeContext({ llm: fakeLlm(DECLARED_WINDOW), tools: { register: () => () => {} } });
  apply(pluginCtx, {});
  const rescued = await runLoop({ session, ctx: pluginCtx, withPlugin: true });

  line('场景 1', `声明窗口 ${num(DECLARED_WINDOW)} / 实际窗口 ${num(EFFECTIVE_WINDOW)} / 历史 ${num(measure(pluginCtx, session).totalTokens)} tokens（折叠后）`);
  line('  裸宿主', `${baseline.ok ? '✓' : '✗'} ${baseline.attempts} 次尝试，${baseline.ok ? '成功' : `全部 400（${baseline.reason ?? '重发同一超大请求'}）`}`);
  line('  本插件', `${rescued.ok ? '✓' : '✗'} ${rescued.ok ? `第 ${rescued.attempts} 次尝试成功，投影 ${num(rescued.log.at(-1).tokens)} tokens` : `仍失败：${rescued.reason}`}`);
  return rescued.ok && !baseline.ok;
}

/** Scenario 2: billion-context owns the lane and refuses host compaction. */
async function scenarioLaneRefusal() {
  const session = new FakeSession();
  seedConversation(session, { turns: 130, chars: 9000 });
  const refusal = Object.assign(new Error('dsh native compaction call refused by billion-context: bili owns compression on this lane'), { code: 'dsh_compaction_refused' });
  let engineCalls = 0;
  const ctx = fakeContext({
    llm: fakeLlm(DECLARED_WINDOW),
    tools: { register: () => () => {} },
    compaction: { async compactIfNeeded() { engineCalls += 1; throw refusal; } },
  });
  apply(ctx, {});
  const rescued = await runLoop({ session, ctx, withPlugin: true });
  line('场景 2', '压缩车道被 billion-context 占用（422 dsh_compaction_refused）');
  line('  本插件', `${rescued.ok ? '✓' : '✗'} ${rescued.ok ? `零模型折叠成功，投影 ${num(rescued.log.at(-1).tokens)} tokens，宿主压缩引擎仅被尝试 ${engineCalls} 次` : `失败：${rescued.reason}`}`);
  return rescued.ok && engineCalls === 1;
}

/**
 * Scenario 3: the whole history is one oversized user message. There is no span
 * to fold around it, so the message itself is replaced by its own head and tail.
 */
async function scenarioOversizedMessage() {
  const session = new FakeSession();
  session.append('system/message', { message: { content: [{ type: 'text', text: 'sys' }] } });
  session.append('user/message', { message: { content: [{ type: 'text', text: '巨型内容'.repeat(120000) }] } });
  const ctx = fakeContext({ llm: fakeLlm(EFFECTIVE_WINDOW), tools: { register: () => () => {} } });
  apply(ctx, {});
  const result = await runLoop({ session, ctx, withPlugin: true });
  const checkpoint = session.events.find((event) => event.type === 'user/message'
    && String(event.data?.message?.content?.[0]?.text ?? event.data?.content?.[0]?.text ?? '').includes('首尾摘录'));
  line('场景 3', '整段历史只有一条超大 user 消息（没有可折的区间）');
  line('  本插件', `${result.ok && checkpoint ? '✓' : '✗'} ${result.ok ? '把那条消息换成首尾摘录，请求得以发出' : `失败：${result.reason}`}`);
  return Boolean(result.ok && checkpoint);
}

/**
 * Scenario 4: the surface itself is corrupt (a tool result with no matching
 * call). Nothing may be written: a fold here would have to invent pairing, and
 * this plugin does not pretend a broken session was rescued.
 */
async function scenarioCorruptSurface() {
  const session = new FakeSession();
  session.append('system/message', { message: { content: [{ type: 'text', text: 'sys' }] } });
  session.append('user/message', { message: { content: [{ type: 'text', text: 'go' }] } });
  session.append('tool/result', { message: { content: [{ type: 'text', text: '孤儿结果'.repeat(120000) }] } });
  const ctx = fakeContext({ llm: fakeLlm(EFFECTIVE_WINDOW), tools: { register: () => () => {} } });
  apply(ctx, {});
  const eventsBefore = session.events.length;
  const result = await runLoop({ session, ctx, withPlugin: true });
  const delegated = result.log.some((entry) => entry.delegated);
  const wrote = session.events.length !== eventsBefore;
  line('场景 4', 'surface 本身损坏（孤立的 tool/result）');
  line('  本插件', `${delegated && !wrote ? '✓' : '✗'} 不伪造成功，交回宿主（${delegated ? '已委托 next()' : '未委托'}${wrote ? '，但写入了事件' : ''}）`);
  return delegated && !result.ok && !wrote;
}

/** Deep copy through the session's own serialisation surface. */
function clone(session) {
  const copy = new FakeSession();
  for (const event of session.events) {
    copy.events.push(structuredClone(event));
    copy.seq = Math.max(copy.seq, event.seq);
  }
  copy.surface = { nodes: [...session.surface.nodes] };
  return copy;
}

async function main() {
  const results = [];
  process.stdout.write('dsh-context-rescue · 离线回放模拟\n');
  process.stdout.write('='.repeat(64) + '\n');
  results.push(['场景 1 · 官方分类器漏判 + 窗口错配', await scenarioReported()]);
  results.push(['场景 2 · 压缩车道被占用', await scenarioLaneRefusal()]);
  results.push(['场景 3 · 唯一的超大消息被截断', await scenarioOversizedMessage()]);
  results.push(['场景 4 · surface 损坏时保持诚实', await scenarioCorruptSurface()]);
  process.stdout.write('='.repeat(64) + '\n');
  let failures = 0;
  for (const [name, ok] of results) {
    if (!ok) failures += 1;
    line(ok ? '✓' : '✗', `${name}：${ok ? '通过' : '失败'}`);
  }
  process.stdout.write(failures === 0 ? '\n全部模拟场景通过。\n' : `\n${failures} 个模拟场景失败。\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
