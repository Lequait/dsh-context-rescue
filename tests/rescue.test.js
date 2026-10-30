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

test('a host session that only exposes snapshotEvents() is still folded', async () => {
  const inner = sessionWithLongHistory();
  // The host's own Session class has no `events` property: it exposes
  // `snapshotEvents()` (and `ownEvents()`). Reading `.events` saw an empty list
  // on a real session and reported "nothing foldable".
  const session = {
    get surface() {
      return inner.surface;
    },
    append: (...args) => inner.append(...args),
    eventAt: (seq) => inner.eventAt(seq),
    snapshotEvents: () => inner.events,
  };
  const ctx = fakeContext({ llm: fakeLlm(60000) });
  const config = resolveConfig({});

  const report = await rescue(ctx, { agent: { session }, session, failure: OVERFLOW, provider: 'p', config });

  assert.equal(report.action, 'retry');
  assert.ok(report.after.totalTokens < report.before.totalTokens);
  assert.ok(report.fold.digestChars > 0, 'the digest must be built from the snapshot events');
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

  // A second failure must not touch the refusing engine again. The projection
  // now fits, so the ladder stops before reaching any tier at all.
  const second = await rescue(ctx, { agent, session, failure: OVERFLOW, provider: 'p', config });
  assert.equal(calls, 1, 'the host engine is not retried once the lane refused it');
  assert.equal(rescueStateOf(agent).laneBlocked, true);
  assert.match(String(second.reason), /already fits/);
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

test('a borrowed engine that changes nothing is not counted as a rescue', async () => {
  const session = sessionWithLongHistory();
  let calls = 0;
  const compaction = {
    async compactIfNeeded() {
      calls += 1;
    },
  };
  const ctx = fakeContext({ llm: fakeLlm(60000), compaction });
  const agent = { session };

  const report = await rescue(ctx, { agent, session, failure: OVERFLOW, provider: 'p', config: resolveConfig({}) });
  const hostTier = report.tiers.find((tier) => tier.tier === 'host-compaction');
  assert.equal(calls, 1);
  assert.equal(hostTier.ok, false, 'a no-op engine did not rescue anything');
  assert.equal(hostTier.after, hostTier.before);
  assert.equal(report.action, 'retry');
  assert.match(String(report.reason), /mechanical digest fold/);
});

test('a projection that already fits is retried without being rewritten', async () => {
  const session = sessionWithLongHistory({ turns: 4, chars: 400 });
  const nodesBefore = session.surface.nodes.length;
  const agent = { session };

  const report = await rescue(fakeContext({ llm: fakeLlm(60000) }), {
    agent,
    session,
    failure: OVERFLOW,
    provider: 'p',
    config: resolveConfig({}),
  });
  assert.equal(report.action, 'retry');
  assert.match(String(report.reason), /already fits/);
  assert.equal(session.surface.nodes.length, nodesBefore, 'nothing was folded');
  assert.equal(report.tiers.length, 0);
});

test('an internal failure is logged and handed back to the host, never thrown', async () => {
  const session = sessionWithLongHistory();
  const ctx = fakeContext({ llm: fakeLlm(60000), tools: { register: () => () => {} } });
  apply(ctx, { maxAttemptsPerTurn: 2 });
  const handler = ctx.listeners.get('agent/request-error');

  // A session that blows up while being measured stands in for any unexpected defect: the
  // waterfall must see `next()` rather than an exception, or the host loop would lose the
  // original provider error.
  const broken = {
    get events() {
      throw new Error('events exploded');
    },
    append() {},
  };
  const payload = { agent: { session: broken }, failure: OVERFLOW, provider: 'p', turn: 1, step: 1 };
  let delegated = 0;
  const next = async () => {
    delegated += 1;
    return undefined;
  };

  const result = await handler(payload, next);
  assert.equal(result, undefined, 'the listener delegates instead of throwing');
  assert.equal(delegated, 1);
  const logged = ctx.logs.map((entry) => `${entry.level} ${entry.message}`).join('\n');
  assert.match(logged, /rescue failed, passing the original error through/u);
  assert.match(logged, /events exploded/u);

  // The broken turn must not have poisoned the budget counter of a healthy one.
  const healthy = { agent: { session }, failure: OVERFLOW, provider: 'p', turn: 2, step: 1 };
  assert.deepEqual(await handler(healthy, next), { kind: 'retry' });
});

test('a second rejection in the same turn forces the ladder even when the projection fits', async () => {
  const session = sessionWithLongHistory();
  const ctx = fakeContext({ llm: fakeLlm(1_000_000), tools: { register: () => () => {} } });
  apply(ctx, { maxAttemptsPerTurn: 2 });
  const handler = ctx.listeners.get('agent/request-error');
  const payload = { agent: { session }, failure: OVERFLOW, provider: 'p', turn: 3, step: 1 };
  const next = async () => undefined;
  const before = measure(ctx, session);

  // The first rejection is measured against a roomy declared window, so the honest answer is
  // "this already fits": retry the request untouched instead of spending context.
  assert.deepEqual(await handler(payload, next), { kind: 'retry' });
  assert.equal(measure(ctx, session).totalTokens, before.totalTokens);

  // The gateway disagrees twice, so the measurement is not the whole story: fold anyway.
  assert.deepEqual(await handler(payload, next), { kind: 'retry' });
  assert.ok(measure(ctx, session).totalTokens < before.totalTokens,
    `${measure(ctx, session).totalTokens} < ${before.totalTokens}`);
});
