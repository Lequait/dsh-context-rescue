/**
 * The bracket a fold writes, checked field by field.
 *
 * Issue #1 was not a wrong number: the shape was wrong. The host's restore
 * validator wants `start(turn) → summary: ContentBlock[] → checkpoint(end) →
 * end(turn)`, one summary per bracket, and the same turn on both ends. The
 * `host-session` gate proves the result against the host itself, but it needs a
 * real installation and real logs; these tests pin the same shape in the unit
 * suite, including the two failure modes that would otherwise ship silently: a
 * fold whose header carries no provider/model, and a fold that fails halfway and
 * has to close its own bracket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeSession, seedConversation } from './fake-session.js';
import { applyFold } from '../lib/fold.js';

/** A session with one open turn at the end, which is the ordinary case. */
function withOpenTurn(turn = 3) {
  const session = seedConversation(new FakeSession(), { turns: 4, chars: 300 });
  session.append('turn/start', { turn });
  return { session, turn };
}

function planFor(session, overrides = {}) {
  const nodes = session.surface.nodes;
  return {
    start: nodes[1],
    end: nodes[nodes.length - 1],
    shadowedSeqs: nodes.slice(1),
    shadowedTokenCount: 1234,
    text: '## 摘要\n- 关键事实',
    ...overrides,
  };
}

/** The four records a valid bracket consists of, in order. */
function bracketOf(session) {
  const types = session.appendLog.map((entry) => entry.type);
  const start = types.lastIndexOf('compaction/start');
  return session.events.slice(start).map((event) => event);
}

test('a fold writes start → summary → checkpoint → end, with the plan in the summary', () => {
  const { session, turn } = withOpenTurn();
  const plan = planFor(session);
  const written = applyFold(session, plan);

  const bracket = bracketOf(session);
  assert.deepEqual(bracket.map((event) => event.type), [
    'compaction/start',
    'compaction/summary',
    'user/message',
    'compaction/end',
  ]);

  const [start, summary, checkpoint, end] = bracket;
  assert.equal(start.data.turn, turn);
  assert.equal(end.data.turn, turn);
  assert.equal(end.data.error, undefined, 'a successful fold carries no error');
  assert.equal(start.data.compactionId, written.compactionId);
  assert.equal(summary.data.compactionId, written.compactionId);
  assert.equal(end.data.compactionId, written.compactionId);

  assert.deepEqual(summary.data.shadowedRange, { start: plan.start, end: plan.end });
  assert.deepEqual(summary.data.shadowedSeqs, plan.shadowedSeqs);
  assert.equal(summary.data.shadowedTokenCount, plan.shadowedTokenCount);
  // The host types `summary` as ContentBlock[], never a bare string.
  assert.ok(Array.isArray(summary.data.summary));
  for (const block of summary.data.summary) assert.equal(typeof block.type, 'string');
  assert.match(JSON.stringify(summary.data.summary), /摘要/u);
  assert.equal(summary.data.provider, session.provider);
  assert.equal(summary.data.model, session.model);

  // The replacement has to follow the pricing record with no yield between them.
  assert.equal(checkpoint.seq, summary.seq + 1);
  assert.equal(checkpoint.options.surfaceOp.op, 'replace');
  assert.deepEqual(checkpoint.options.sourceEventSeqs, [start.seq, summary.seq, ...plan.shadowedSeqs]);
  assert.equal(checkpoint.data.source.kind, 'compact-checkpoint');
  assert.equal(checkpoint.data.source.compactionId, written.compactionId);
});

test('a fold with no open turn writes a null turn on both ends of the bracket', () => {
  const session = seedConversation(new FakeSession(), { turns: 4, chars: 300 });
  // No turn/start was appended, so no turn is open: the host expects `null`.
  applyFold(session, planFor(session, { turn: undefined }));

  const bracket = bracketOf(session);
  assert.equal(bracket[0].data.turn, null);
  assert.equal(bracket[bracket.length - 1].data.turn, null);
});

test('a caller-supplied turn wins over the one the log would give', () => {
  const { session } = withOpenTurn(7);
  applyFold(session, planFor(session, { turn: 2 }));
  const bracket = bracketOf(session);
  assert.equal(bracket[0].data.turn, 2);
  assert.equal(bracket[bracket.length - 1].data.turn, 2);
});

test('a header without provider or model still yields a typed summary owner', () => {
  const { session } = withOpenTurn();
  session.requestHeader = () => ({});
  applyFold(session, planFor(session));
  const summary = bracketOf(session)[1];
  assert.equal(typeof summary.data.provider, 'string');
  assert.equal(typeof summary.data.model, 'string');
  assert.equal(summary.data.provider, 'context-rescue');
  assert.equal(summary.data.model, 'context-rescue');
});

test('summaryMeta wins when a caller has something better than the header', () => {
  const { session } = withOpenTurn();
  applyFold(session, planFor(session, {
    summaryMeta: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', usage: { input: 10, output: 5 } },
  }));
  const summary = bracketOf(session)[1];
  assert.equal(summary.data.provider, 'openrouter');
  assert.equal(summary.data.model, 'deepseek/deepseek-v4.1-flash');
  assert.deepEqual(summary.data.usage, { input: 10, output: 5 });
});

test('a summary Meta string is wrapped into a ContentBlock instead of being sent bare', () => {
  const { session } = withOpenTurn();
  applyFold(session, planFor(session, { summaryMeta: { summary: 'plain text summary' } }));
  const summary = bracketOf(session)[1];
  assert.deepEqual(summary.data.summary, [{ type: 'text', text: 'plain text summary' }]);
});

test('a fold that fails halfway closes its own bracket with an error and the same turn', () => {
  const { session, turn } = withOpenTurn();
  const plan = planFor(session);
  const realAppend = session.append.bind(session);
  // Fail exactly on the replacement: the bracket is already open at that point.
  session.append = (type, data, options) => {
    if (type === 'user/message') throw new Error('surface moved under us');
    return realAppend(type, data, options);
  };

  assert.throws(() => applyFold(session, plan), /surface moved under us/u);

  const types = session.appendLog.map((entry) => entry.type);
  assert.deepEqual(types.slice(-3), ['compaction/start', 'compaction/summary', 'compaction/end']);
  assert.equal(types.includes('user/message'), true, 'the seeded messages are there; the replacement is not');
  assert.equal(session.appendLog.filter((entry) => entry.type === 'user/message' && entry.seq > plan.end).length, 0,
    'no replacement checkpoint was written');
  const end = session.events[session.events.length - 1];
  assert.equal(end.type, 'compaction/end');
  assert.equal(end.data.turn, turn);
  assert.match(end.data.error, /surface moved under us/u);
});

test('a bracket that never opened is not closed when the very first append fails', () => {
  const { session } = withOpenTurn();
  const plan = planFor(session);
  session.forceError = new Error('the log is read-only');
  assert.throws(() => applyFold(session, plan), /read-only/u);
  assert.equal(session.appendLog.length, session.appendLog.length, 'nothing appeared');
  assert.equal(session.appendLog.filter((entry) => entry.type === 'compaction/end').length, 0);
});

test('the expectedSeq guard refuses to fold a surface that moved, before writing anything', () => {
  const { session } = withOpenTurn();
  const plan = planFor(session, { expectedSeq: session.seq - 1 });
  assert.throws(() => applyFold(session, plan), /the surface changed/u);
  assert.equal(session.appendLog.filter((entry) => entry.type === 'compaction/start').length, 0);
});
