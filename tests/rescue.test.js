import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeSession, fakeContext, fakeLlm, fakeMeter, seedConversation } from './fake-session.js';
import { resolveConfig } from '../lib/config.js';
import { describeSession, mechanicalFold, rescue, rescueStateOf } from '../lib/rescue.js';
import { measure } from '../lib/measure.js';
import { hasOpenCompactionTransaction } from '../lib/plan.js';
import { apply } from '../index.js';

const OVERFLOW = {
  code: 'INVALID_REQUEST',
  message: 'the request exceeds the model\u0027s context window',
};

function sessionWithLongHistory(turns = 24, chars = 3000) {
  const session = new FakeSession();
  seedConversation(session, { turns, chars });
  return session;
}

function reportText(session) {
  const replacement = session.events.find((event) => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint');
  return replacement?.data?.content?.[0]?.text ?? '';
}

test('rescue folds the oldest span and asks for a retry', async () => {
  const session = sessionWithLongHistory();
  const ctx = fakeContext({ llm: fakeLlm(60000) });
  const config = resolveConfig({});
  const before = measure(ctx, session).totalTokens;
  assert.ok(before > 60000, `seed must exceed the window: ${before}`);

  const report = await rescue(ctx, { agent: { session }, session, failure: OVERFLOW, provider: 'p', config });

  assert.equal(report.action, 'retry');
  assert.ok(report.after.totalTokens < before);
  assert.ok(report.after.totalTokens <= report.window.windowTokens * config.fitRatio, 'projection must fit the effective window');
  assert.match(reportText(session), /会话急救摘要/);
  assert.match(reportText(session), /本轮|轮用户需求|结论/);
  assert.equal(hasOpenCompactionTransaction(session.events), false);
  assert.equal(report.tiers.at(-1).tier, 'mechanical-fold');
});

test('a lane refusal from billion-context falls back to the zero-model fold and is remembered', async () => {
  const session = sessionWithLongHistory();
  const refusal = Object.assign(new Error('dsh native compaction call refused by billion-context: bili owns compression on this lane'), {
    code: 'dsh_compaction_refused',
  });
  let calls = 0;
  const compaction = {
    async compactIfNeeded() {
      calls += 1;
      throw refusal;
    },
  };
  const ctx = fakeContext({ llm: fakeLlm(60000), compaction });
  const config = resolveConfig({});
  const agent = { session };

  const first = await rescue(ctx, { agent, session, failure: OVERFLOW, provider: 'p', config });
  assert.equal(first.action, 'retry');
  const hostTier = first.tiers.find((tier) => tier.tier === 'host-compaction');
  assert.equal(hostTier.laneRefusal, true);
  assert.equal(rescueStateOf(agent).laneBlocked, true);

  // A second failure must not touch the refusing engine again.
  const second = await rescue(ctx, { agent, session, failure: OVERFLOW, provider: 'p', config });
  assert.equal(calls, 1, 'the host engine is not retried once the lane refused it');
  assert.match(String(second.tiers.find((tier) => tier.tier === 'host-compaction').skipped), /billion-context/);
});

test('diagnose mode detects without rewriting the session', async () => {
  const session = sessionWithLongHistory(8);
  const ctx = fakeContext({ llm: fakeLlm(60000) });
  const config = resolveConfig({ mode: 'diagnose' });
  const eventsBefore = session.events.length;

  const report = await rescue(ctx, { agent: { session }, session, failure: OVERFLOW, provider: 'p', config });
  assert.equal(report.action, 'pass');
  assert.equal(report.detected.overflow, true);
  assert.equal(session.events.length, eventsBefore);
});

test('non-overflow failures are left alone', async () => {
  const session = sessionWithLongHistory(4);
  const ctx = fakeContext({ llm: fakeLlm(100000) });
  const config = resolveConfig({});
  const eventsBefore = session.events.length;
  const report = await rescue(ctx, {
    agent: { session }, session, config,
    failure: { code: 'RATE_LIMITED', message: 'slow down' },
  });
  assert.equal(report.action, 'pass');
  assert.equal(report.attempted, false);
  assert.equal(session.events.length, eventsBefore);
});

test('a session with nothing foldable reports a clean skip', async () => {
  const session = new FakeSession();
  session.append('system/message', { message: { content: [{ type: 'text', text: 'sys' }] } });
  session.append('user/message', { message: { content: [{ type: 'text', text: 'hi' }] } });
  const ctx = fakeContext({ llm: fakeLlm(60000) });
  const config = resolveConfig({});
  const result = mechanicalFold(ctx, { agent: { session }, session, config, windowTokens: 60000, reason: 'test' });
  assert.equal(result.ok, false);
  assert.match(String(result.skipped), /nothing foldable/);
});

test('the request-error listener retries once, then respects the per-turn budget', async () => {
  const session = sessionWithLongHistory();
  const ctx = fakeContext({ llm: fakeLlm(60000), tools: { register: () => () => {} } });
  apply(ctx, { maxAttemptsPerTurn: 1 });
  const handler = ctx.listeners.get('agent/request-error');
  assert.equal(typeof handler, 'function');

  const agent = { session };
  const payload = { agent, failure: OVERFLOW, provider: 'p', turn: 7, step: 3, signal: undefined };
  let delegated = 0;
  const next = async () => { delegated += 1; return undefined; };

  const first = await handler(payload, next);
  assert.deepEqual(first, { kind: 'retry' });
  assert.equal(delegated, 0);

  const second = await handler(payload, next);
  assert.equal(second, undefined);
  assert.equal(delegated, 1, 'the budget-exhausted call delegates to the host');

  const otherTurn = await handler({ ...payload, turn: 8 }, next);
  assert.deepEqual(otherTurn, { kind: 'retry' }, 'a new turn resets the budget');
});

test('describeSession reports occupancy and capabilities', async () => {
  const session = sessionWithLongHistory(10);
  const ctx = fakeContext({ llm: fakeLlm(120000), compaction: { compactIfNeeded() {} } });
  const config = resolveConfig({});
  const info = await describeSession(ctx, { session, config, provider: 'p' });
  assert.equal(info.window.windowTokens, 120000);
  assert.equal(info.foldSupported.ok, true);
  assert.equal(info.hostCompaction, 'mounted');
  assert.ok(info.occupancy > 0);
  assert.equal(info.measurementSource, 'meter');
});

test('observed window from the failure text overrides an optimistic declaration', async () => {
  const session = sessionWithLongHistory(6);
  const ctx = fakeContext({ llm: fakeLlm(1000000) });
  const config = resolveConfig({});
  const failure = {
    code: 'INVALID_REQUEST',
    message: 'payload ≥ ~411983 tokens vs the model window 196608 — no upstream can accept it',
  };
  const report = await rescue(ctx, { agent: { session }, session, failure, provider: 'p', config });
  assert.equal(report.window.declared, 1000000);
  assert.equal(report.window.observed, 196608);
  assert.equal(report.window.windowTokens, 196608);
});
