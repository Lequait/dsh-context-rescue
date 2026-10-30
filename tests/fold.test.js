import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeSession, fakeMeter, seedConversation } from './fake-session.js';
import { measure } from '../lib/measure.js';
import { applyFold, supportsFold } from '../lib/fold.js';
import {
  hasOpenCompactionTransaction, pairingCuts, planFold, selectRescueRange,
} from '../lib/plan.js';
import { resolveConfig } from '../lib/config.js';

function ctxWithMeter() {
  const meter = fakeMeter();
  return { tokenMeter: meter, get: (name) => (name === 'tokenMeter' ? meter : undefined) };
}

test('fold is supported on a host-shaped session', () => {
  const session = new FakeSession();
  assert.equal(supportsFold(session).ok, true);
  assert.equal(supportsFold({ append() {} }).ok, false);
});

test('plan keeps the pinned head and the recent tail, and never splits a tool pair', () => {
  const session = new FakeSession();
  seedConversation(session, { turns: 24, chars: 1200 });
  const ctx = ctxWithMeter();
  const measurement = measure(ctx, session);
  const config = resolveConfig({});
  const plan = planFold(session, measurement, {
    retainOptions: [8000],
    targetTokens: Math.floor(measurement.totalTokens * 0.3),
    minFoldTokens: 1000,
    pinFirstUserMessage: true,
  });
  assert.ok(plan, 'a plan should exist');
  const types = measurement.nodes.map((node) => session.eventAt(node.seq).type);
  const events = measurement.nodes.map((node) => session.eventAt(node.seq));
  const { cuts, corrupt } = pairingCuts(events);
  assert.equal(corrupt, false, 'the seeded surface is well formed');
  assert.notEqual(types[plan.startIdx], 'system/message', 'system head stays outside the fold');
  assert.equal(cuts[plan.startIdx], true, 'the fold never starts inside an open tool call');
  assert.equal(cuts[plan.endIdx + 1], true, 'the fold never ends inside an open tool call');
  assert.ok(plan.shadowedSeqs.length >= 10);
  assert.ok(plan.retainedTokens < measurement.totalTokens);
});

test('pairing cuts follow the host balance over a real-shaped surface', () => {
  // A real v4 surface carries the call twice (content block + tool/call mirror)
  // and the result once. Counting the mirror would unbalance every session.
  const events = [
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'go' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reading' }, { type: 'tool-call', name: 'read_file' }] } } },
    { type: 'tool/call', data: { call: { name: 'read_file' } } },
    { type: 'tool/ptc-dispatch', data: {} },
    { type: 'tool/result', data: { result: { content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
  ];
  const { cuts, open, corrupt } = pairingCuts(events);
  assert.equal(corrupt, false);
  assert.equal(open, 0, 'the surface ends balanced');
  assert.deepEqual(cuts, [true, true, false, false, false, true, true],
    'cuts are safe only before the call and after its result');

  const parallel = [
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'a' }, { type: 'tool-call', name: 'b' }] } } },
    { type: 'tool/result', data: {} },
    { type: 'tool/result', data: {} },
  ];
  assert.deepEqual(pairingCuts(parallel).cuts, [true, false, false, true],
    'a parallel call block pair only closes after both results');
});

test('an unclosed compaction transaction blocks planning', () => {
  const session = new FakeSession();
  seedConversation(session, { turns: 12, chars: 400 });
  session.events.push({ seq: 9999, type: 'compaction/start', data: { compactionId: 'other' } });
  assert.equal(hasOpenCompactionTransaction(session.events), true);
  const ctx = ctxWithMeter();
  const plan = selectRescueRange(session, measure(ctx, session), { retainTokens: 1000, minFoldTokens: 100 });
  assert.equal(plan, null);
});

test('applyFold rewrites the surface and brackets the transaction', () => {
  const session = new FakeSession();
  seedConversation(session, { turns: 16, chars: 800 });
  const ctx = ctxWithMeter();
  const before = measure(ctx, session);
  const plan = selectRescueRange(session, before, { retainTokens: 2000, minFoldTokens: 500 });
  assert.ok(plan);

  const written = applyFold(session, {
    start: plan.start,
    end: plan.end,
    shadowedSeqs: plan.shadowedSeqs,
    shadowedTokenCount: plan.shadowedTokenCount,
    text: '## 摘要\n- 关键事实',
    turn: 3,
    kind: 'prune',
  });

  const types = session.events.map((event) => event.type);
  assert.deepEqual(types.slice(-4), ['compaction/start', 'compaction/prune', 'user/message', 'compaction/end']);
  assert.equal(hasOpenCompactionTransaction(session.events), false);

  const replacement = session.eventAt(written.replacementSeq);
  assert.equal(replacement.options.surfaceOp.op, 'replace');
  assert.equal(replacement.options.surfaceOp.startSeq, plan.start);
  assert.equal(replacement.options.surfaceOp.endSeq, plan.end);
  assert.equal(replacement.data.source.kind, 'compact-checkpoint');
  assert.equal(replacement.data.source.compactionId, written.compactionId);
  assert.ok(replacement.options.sourceEventSeqs.includes(plan.shadowedSeqs[0]));

  const after = measure(ctx, session);
  assert.ok(after.totalTokens < before.totalTokens, `${after.totalTokens} < ${before.totalTokens}`);
  assert.equal(after.nodes.length, before.nodes.length - plan.shadowedSeqs.length + 1);
});

test('applyFold closes the bracket when the replacement fails', () => {
  const session = new FakeSession();
  seedConversation(session, { turns: 8, chars: 400 });
  const ctx = ctxWithMeter();
  const before = measure(ctx, session);
  const plan = selectRescueRange(session, before, { retainTokens: 1000, minFoldTokens: 200 });
  assert.ok(plan);

  const original = session.append.bind(session);
  let calls = 0;
  session.append = (type, data, options) => {
    calls += 1;
    if (calls === 3) throw new Error('disk full');
    return original(type, data, options);
  };

  assert.throws(() => applyFold(session, {
    start: plan.start,
    end: plan.end,
    shadowedSeqs: plan.shadowedSeqs,
    shadowedTokenCount: plan.shadowedTokenCount,
    text: 'x',
  }), /disk full/);

  assert.equal(hasOpenCompactionTransaction(session.events), false, 'the bracket must be closed on failure');
  const end = session.events.at(-1);
  assert.equal(end.type, 'compaction/end');
  assert.match(String(end.data.error), /disk full/);
});
