import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeSession, fakeContext, fakeLlm, seedConversation } from './fake-session.js';
import { resolveConfig } from '../lib/config.js';
import { preflight } from '../lib/rescue.js';
import { measure } from '../lib/measure.js';
import { hasOpenCompactionTransaction } from '../lib/plan.js';
import { apply } from '../index.js';

function sessionWithLongHistory(turns = 24, chars = 3000) {
  const session = new FakeSession();
  seedConversation(session, { turns, chars });
  return session;
}

test('pre-flight folds a projection that is already over the window', async () => {
  const session = sessionWithLongHistory();
  const ctx = fakeContext({ llm: fakeLlm(60000) });
  const config = resolveConfig({});
  const before = measure(ctx, session).totalTokens;
  assert.ok(before > 60000, `seed must be over the window: ${before}`);
  const eventsBefore = session.events.length;

  const report = await preflight(ctx, { agent: { session }, session, config, provider: 'p' });

  assert.equal(report.action, 'fold');
  assert.equal(report.attempted, true);
  assert.ok(report.after.totalTokens < before);
  assert.ok(report.after.totalTokens <= report.window.windowTokens * config.fitRatio);
  assert.ok(session.events.length > eventsBefore, 'the fold wrote a transaction');
  assert.equal(hasOpenCompactionTransaction(session.events), false, 'the transaction is closed');
  assert.equal(session.events.at(-1).type, 'compaction/end');
  assert.ok(report.tiers.some((tier) => tier.tier === 'mechanical-fold' && tier.ok === true));
});

test('pre-flight leaves a projection that already fits completely alone', async () => {
  const session = sessionWithLongHistory(4, 400);
  const ctx = fakeContext({ llm: fakeLlm(196608) });
  const config = resolveConfig({});
  const before = measure(ctx, session).totalTokens;
  const eventsBefore = session.events.length;

  const report = await preflight(ctx, { agent: { session }, session, config, provider: 'p' });

  assert.equal(report.action, 'pass');
  assert.equal(report.attempted, false);
  assert.match(report.reason, /fits the model window/u);
  assert.equal(session.events.length, eventsBefore, 'no event was appended');
  assert.equal(measure(ctx, session).totalTokens, before);
});

test('pre-flight stays out of the pressure band the host owns', async () => {
  const session = sessionWithLongHistory();
  const probe = fakeContext({ llm: fakeLlm(196608) });
  const measured = measure(probe, session).totalTokens;

  // A window that puts the projection above fitRatio but still below the window:
  // that is ordinary compaction policy, and the host decides it.
  const window = Math.ceil(measured / 0.95);
  const ctx = fakeContext({ llm: fakeLlm(window) });
  const config = resolveConfig({});
  const eventsBefore = session.events.length;

  const report = await preflight(ctx, { agent: { session }, session, config, provider: 'p' });

  assert.equal(report.action, 'pass');
  assert.equal(report.attempted, false);
  assert.equal(session.events.length, eventsBefore, 'the pressure band is the host\'s business');
  assert.ok(measured > window * config.fitRatio, 'the seed must be inside the pressure band');
});

test('pre-flight refuses to rewrite anything in diagnose mode', async () => {
  const session = sessionWithLongHistory();
  const ctx = fakeContext({ llm: fakeLlm(60000) });
  const config = resolveConfig({ mode: 'diagnose' });
  const eventsBefore = session.events.length;

  const report = await preflight(ctx, { agent: { session }, session, config, provider: 'p' });

  assert.equal(report.action, 'pass');
  assert.match(report.reason, /diagnose/u);
  assert.equal(session.events.length, eventsBefore);
});

test('pre-flight reports an unusable session shape instead of throwing', async () => {
  const session = sessionWithLongHistory();
  const ctx = fakeContext({ llm: fakeLlm(60000) });
  const config = resolveConfig({});
  // Same events and surface, but nothing the fold could append through.
  const readOnly = {
    get events() { return session.events; },
    surface: session.surface,
    eventAt: (seq) => session.eventAt(seq),
  };

  const report = await preflight(ctx, { agent: { session: readOnly }, session: readOnly, config, provider: 'p' });

  assert.equal(report.action, 'pass');
  assert.equal(report.attempted, false);
  assert.match(report.reason, /unsupported session/u);
  assert.match(report.reason, /append/u);
});

test('the pre-step listener always delegates to the host, even when the rescue breaks', async () => {
  const session = sessionWithLongHistory();
  const ctx = fakeContext({ llm: fakeLlm(60000), tools: { register: () => () => {} } });
  apply(ctx, {});
  const handler = ctx.listeners.get('agent/pre-step');
  assert.equal(typeof handler, 'function', 'the pre-step hook is registered');

  let delegated = 0;
  const next = async () => {
    delegated += 1;
    return undefined;
  };

  const before = measure(ctx, session).totalTokens;
  assert.equal(await handler({ agent: { session }, turn: 1, signal: { aborted: false } }, next), undefined);
  assert.equal(delegated, 1);
  assert.ok(measure(ctx, session).totalTokens < before, 'the step was rescued before it was built');

  // Any unexpected defect must leave the host in charge rather than break the turn.
  const broken = {
    get events() {
      throw new Error('events exploded');
    },
    append() {},
  };
  assert.equal(await handler({ agent: { session: broken }, turn: 2, signal: { aborted: false } }, next), undefined);
  assert.equal(delegated, 2);
  const logged = ctx.logs.map((entry) => `${entry.level} ${entry.message}`).join('\n');
  assert.match(logged, /pre-flight failed, letting the step continue/u);
  assert.match(logged, /events exploded/u);
});
