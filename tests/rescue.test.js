import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeSession, fakeContext, fakeLlm, fakeMeter, seedConversation } from './fake-session.js';
import { resolveConfig } from '../lib/config.js';
import { describeSession, mechanicalFold, preflight, rescue, rescueStateOf } from '../lib/rescue.js';
import { derivedTokensOf, measure } from '../lib/measure.js';
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

test('the status preview is built only when a fold would actually happen', async () => {
  const fitting = new FakeSession();
  seedConversation(fitting, { turns: 2, chars: 200 });
  const ctx = fakeContext({ llm: fakeLlm(60000) });
  const config = resolveConfig({});
  const fits = await describeSession(ctx, { session: fitting, config, provider: 'p' });
  assert.equal(fits.preview, null, 'a session that already fits has nothing to preview');

  const oversized = sessionWithLongHistory();
  const nodesBefore = oversized.surface.nodes.length;
  const over = await describeSession(ctx, { session: oversized, config, provider: 'p' });
  assert.equal(over.fits, false);
  assert.ok(over.preview, 'an oversized session should preview its fold');
  assert.ok(over.preview.shadowedNodes > 0);
  assert.ok(over.preview.shadowedTokens > 0);
  assert.ok(over.preview.digestChars > 0);
  assert.ok(over.preview.start < over.preview.end);
  assert.equal(oversized.surface.nodes.length, nodesBefore, 'a preview must not write');
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

test('a host engine that throws for its own reasons does not stop the zero-model fold', async () => {
  // dsh-smart-compact's engine resolves null when it refuses and throws when the
  // engine itself fails (budget measurement, base engine error). Neither is the
  // billion-context lane refusal, so the ladder must keep going instead of
  // latching laneBlocked and giving up on the session.
  const session = sessionWithLongHistory();
  let calls = 0;
  const compaction = {
    async compactIfNeeded() {
      calls += 1;
      throw new TypeError("Cannot read properties of undefined (reading 'retainTokens')");
    },
  };
  const ctx = fakeContext({ llm: fakeLlm(60000), compaction });
  const agent = { session };

  const report = await rescue(ctx, { agent, session, failure: OVERFLOW, provider: 'p', config: resolveConfig({}) });
  const hostTier = report.tiers.find((tier) => tier.tier === 'host-compaction');
  assert.equal(calls, 1);
  assert.equal(hostTier.ok, false);
  assert.equal(hostTier.laneRefusal, false, 'an engine bug is not a lane refusal');
  assert.match(String(hostTier.error), /retainTokens/);
  assert.equal(rescueStateOf(agent).laneBlocked, false);
  assert.equal(report.action, 'retry');
  assert.equal(report.fold?.ok, true);
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

test('a session whose first message alone overflows is rescued, and the digest says so', async () => {
  const session = new FakeSession();
  session.append('user/message', { content: [{ type: 'text', text: 'x'.repeat(900_000) }] });
  seedConversation(session, { turns: 6, chars: 400 });
  const ctx = fakeContext({ llm: fakeLlm(196_608) });
  const config = resolveConfig({});
  const before = measure(ctx, session).totalTokens;
  assert.ok(before > 196_608, `seed must exceed the window: ${before}`);

  const report = await rescue(ctx, { agent: { session }, session, failure: OVERFLOW, provider: 'p', config });

  assert.equal(report.action, 'retry');
  assert.ok(report.after.totalTokens < before);
  assert.match(reportText(session), /这次折叠包含了会话最开始的那条消息/);
  assert.equal(hasOpenCompactionTransaction(session.events), false);
});

function countingMeter() {
  const inner = fakeMeter();
  const meter = {
    calls: 0,
    measure(session) {
      meter.calls += 1;
      return inner.measure(session);
    },
    estimateMessage: inner.estimateMessage,
  };
  return meter;
}

/** A session nothing can rescue: the system prompt alone is over the window. */
function hopelessSession() {
  const session = new FakeSession();
  session.append('system/message', { message: { content: [{ type: 'text', text: '系'.repeat(400000) }] } });
  session.append('user/message', { message: { content: [{ type: 'text', text: '继续' }] } });
  session.append('assistant/message', { message: { content: [{ type: 'text', text: '好的。' }] } });
  return session;
}

test('a session that already defeated every tier is not measured again', async () => {
  const session = hopelessSession();
  const meter = countingMeter();
  const ctx = fakeContext({ llm: fakeLlm(60000), tokenMeter: meter });
  const config = resolveConfig({});
  const agent = { session };

  const first = await rescue(ctx, { agent, session, failure: OVERFLOW, provider: 'p', config, turn: 1 });
  assert.equal(first.action, 'pass');
  assert.match(first.reason, /no tier could shrink/u);
  assert.equal(rescueStateOf(agent).hopeless, true, 'a defeated session is remembered');
  const callsAfterFirst = meter.calls;
  assert.ok(callsAfterFirst >= 1);

  const second = await rescue(ctx, { agent, session, failure: OVERFLOW, provider: 'p', config, turn: 2 });
  assert.equal(second.action, 'pass');
  assert.match(second.reason, /not measured again/u);
  assert.equal(meter.calls, callsAfterFirst, 'the second request must not measure the projection again');

  const forced = await rescue(ctx, { agent, session, failure: OVERFLOW, provider: 'p', config, turn: 3, force: true });
  assert.equal(forced.action, 'pass');
  assert.ok(meter.calls > callsAfterFirst, 'an explicit /rescue measures once more');
});

test('a window that grew since the verdict makes the ladder look again', async () => {
  const session = hopelessSession();
  const meter = countingMeter();
  const config = resolveConfig({});
  const agent = { session };

  const narrow = fakeContext({ llm: fakeLlm(60000), tokenMeter: meter });
  const giving = await rescue(narrow, { agent, session, failure: OVERFLOW, provider: 'p', config, turn: 1 });
  assert.equal(giving.action, 'pass');
  assert.equal(rescueStateOf(agent).hopeless, true);
  const callsAfterGiving = meter.calls;

  // The same session under a model with more room: the old verdict described a
  // 60k window, and this request is not that request.
  const wide = fakeContext({ llm: fakeLlm(1_000_000), tokenMeter: meter });
  const second = await rescue(wide, { agent, session, failure: OVERFLOW, provider: 'p', config, turn: 2 });
  assert.equal(rescueStateOf(agent).hopeless, false, 'the verdict is dropped, not inherited');
  assert.ok(meter.calls > callsAfterGiving, 'the projection is measured under the new window');
  assert.equal(second.action, 'retry');
  assert.match(second.reason, /already fits/u);
});

test('a successful fold clears the flag', async () => {
  const session = sessionWithLongHistory();
  const ctx = fakeContext({ llm: fakeLlm(60000) });
  const config = resolveConfig({});
  const agent = { session };
  rescueStateOf(agent).hopeless = true;

  const report = await rescue(ctx, { agent, session, failure: OVERFLOW, provider: 'p', config, turn: 4, force: true });

  assert.equal(report.action, 'retry');
  assert.equal(rescueStateOf(agent).hopeless, false, 'a rescue that worked reopens the fast path');
});

test('pre-flight leaves a defeated session alone', async () => {
  const session = hopelessSession();
  const meter = countingMeter();
  const ctx = fakeContext({ llm: fakeLlm(60000), tokenMeter: meter });
  const config = resolveConfig({});
  const agent = { session };
  rescueStateOf(agent).hopeless = true;

  const report = await preflight(ctx, { agent, session, config, turn: 5 });

  assert.equal(report.action, 'pass');
  assert.match(report.reason, /defeated every tier/u);
  assert.equal(meter.calls, 0, 'a defeated session is not measured on every step');
});

test('the derived request is measured when the host can build one', () => {
  const ctx = fakeContext({});
  const without = { surface: { nodes: [] } };
  assert.equal(derivedTokensOf(ctx, without), null, 'a session that cannot derive messages has no request size');

  const session = new FakeSession();
  session.append('user/message', { message: { content: [{ type: 'text', text: '甲'.repeat(120) }] } });
  session.append('assistant/message', { message: { content: [{ type: 'text', text: '好的'.repeat(20) }] } });
  session.append('tool/call', { call: { name: 'read_file' } });
  const derived = derivedTokensOf(ctx, {
    deriveMessages: () => [
      { content: [{ type: 'text', text: '甲'.repeat(120) }] },
      { content: [{ type: 'text', text: '好的'.repeat(20) }] },
    ],
  });
  assert.ok(derived !== null);
  assert.equal(derived.messages, 2);
  assert.ok(derived.totalTokens >= 120, `the request must be priced at least by its text: ${derived.totalTokens}`);
  assert.ok(derived.totalTokens < measure(ctx, session).totalTokens + 1000, 'the two prices stay in the same order of magnitude');
});

test('pre-flight stops ignoring a session once the window grows', async () => {
  const session = hopelessSession();
  const meter = countingMeter();
  const config = resolveConfig({});
  const agent = { session };

  const narrow = fakeContext({ llm: fakeLlm(60000), tokenMeter: meter });
  await rescue(narrow, { agent, session, failure: OVERFLOW, provider: 'p', config, turn: 1 });
  assert.equal(rescueStateOf(agent).hopeless, true);

  const callsAfterGiving = meter.calls;
  const ignored = await preflight(narrow, { agent, session, config, turn: 1, provider: 'p' });
  assert.equal(ignored.action, 'pass');
  assert.match(ignored.reason, /defeated every tier/u);
  assert.equal(meter.calls, callsAfterGiving, 'nothing is measured while the window is unchanged');

  const wide = fakeContext({ llm: fakeLlm(1_000_000), tokenMeter: meter });
  await preflight(wide, { agent, session, config, turn: 2, provider: 'p' });
  assert.equal(rescueStateOf(agent).hopeless, false, 'the verdict does not survive a window change');
  assert.ok(meter.calls > callsAfterGiving, 'a bigger window earns a real measurement');
});

test('a surface that grew since the verdict makes the ladder look again', async () => {
  const session = hopelessSession();
  const meter = countingMeter();
  const ctx = fakeContext({ llm: fakeLlm(60000), tokenMeter: meter });
  const config = resolveConfig({});
  const agent = { session };

  const first = await rescue(ctx, { agent, session, failure: OVERFLOW, provider: 'p', config, turn: 1 });
  assert.equal(first.action, 'pass');
  assert.equal(rescueStateOf(agent).hopeless, true);
  const callsAfterFirst = meter.calls;

  // The verdict was reached on one shape of the history. The user keeps typing,
  // and what made every tier decline can stop being true.
  session.append('user/message', { content: [{ type: 'text', text: '甲'.repeat(200000) }] });

  const second = await rescue(ctx, { agent, session, failure: OVERFLOW, provider: 'p', config, turn: 2 });
  assert.ok(meter.calls > callsAfterFirst, 'a surface that changed is measured again');
  assert.doesNotMatch(second.reason, /not measured again/u, 'the old verdict is not inherited');
});

test('a budget of one attempt still folds instead of retrying untouched', async () => {
  const session = sessionWithLongHistory();
  const ctx = fakeContext({ llm: fakeLlm(1_000_000) });
  const config = resolveConfig({ maxAttemptsPerTurn: 1 });
  const agent = { session };

  const before = measure(ctx, session).totalTokens;
  const report = await rescue(ctx, { agent, session, failure: OVERFLOW, provider: 'p', config, turn: 1, attempt: 1 });

  assert.equal(report.action, 'retry');
  assert.equal(report.attempted, true, 'the only attempt this turn has is used on a fold, not on a re-send');
  assert.ok(measure(ctx, session).totalTokens < before, 'the projection actually shrank');
});

test('mode fold never borrows an engine that would summarise', async () => {
  const session = sessionWithLongHistory();
  const mb = fakeMeter();
  let calls = 0;
  const engine = {
    async compactIfNeeded() {
      calls += 1;
      return null;
    },
  };
  const ctx = fakeContext({ llm: fakeLlm(60000), tokenMeter: mb, services: { compaction: engine } });
  const config = resolveConfig({ mode: 'fold' });
  const agent = { session };

  const report = await rescue(ctx, { agent, session, failure: OVERFLOW, provider: 'p', config, turn: 1 });

  assert.equal(calls, 0, 'mode=fold promised no model call, and the host engine may summarise');
  assert.equal(report.action, 'retry');
  assert.ok(report.tiers.some((tier) => tier.tier === 'mechanical-fold' && tier.ok === true));
  const host = report.tiers.find((tier) => tier.tier === 'host-compaction');
  assert.match(String(host?.skipped), /mode=fold/u);
});
