import assert from 'node:assert/strict';
import test from 'node:test';

import { planLogRepair } from '../lib/repair-log.js';

/** One event as the host writes it into a v4 log. */
function event(type, seq, data, options) {
  return { type, seq, data, ...(options === undefined ? {} : { options }) };
}

/** The bracket 0.2.0–0.2.4 wrote: a prune instead of a summary, and no turn. */
function brokenBracket() {
  return [
    event('turn/start', 1, { turn: 1 }),
    event('user/message', 2, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'the oldest message' }] }),
    event('compaction/start', 3, { compactionId: 'rescue-1' }),
    event('compaction/prune', 4, {
      shadowedRange: { start: 2, end: 2 },
      shadowedSeqs: [2],
      shadowedTokenCount: 1234,
    }),
    event('user/message', 5, {
      id: 'rescue-checkpoint-rescue-1',
      role: 'user',
      content: [{ type: 'text', text: '## 摘要\n- 折叠了 1 条消息' }],
      source: { kind: 'compact-checkpoint', compactionId: 'rescue-1' },
    }, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [3, 4, 2] }),
    event('compaction/end', 6, { compactionId: 'rescue-1' }),
    event('turn/end', 7, { turn: 1 }),
  ];
}

test('a broken bracket gets a summary and its turn, and the input is not mutated', () => {
  const events = brokenBracket();
  const before = JSON.stringify(events);
  const plan = planLogRepair(events);

  assert.equal(JSON.stringify(events), before, 'the planner mutated its input');
  assert.deepEqual(plan.problems, []);

  const start = plan.events[2];
  assert.equal(start.type, 'compaction/start');
  assert.equal(start.data.turn, 1, 'the start did not take the open turn');

  const promoted = plan.events[3];
  assert.equal(promoted.type, 'compaction/summary', 'the prune was not promoted');
  assert.deepEqual(promoted.data.summary, [{ type: 'text', text: '## 摘要\n- 折叠了 1 条消息' }]);
  assert.equal(promoted.data.compactionId, 'rescue-1');
  assert.equal(promoted.data.provider, 'context-rescue');
  assert.equal(promoted.data.model, 'context-rescue');
  assert.deepEqual(promoted.data.shadowedSeqs, [2]);
  assert.equal(promoted.data.shadowedTokenCount, 1234);

  const end = plan.events[5];
  assert.equal(end.data.turn, 1, 'the end did not take the turn the bracket opened in');
  assert.ok(plan.changes.some((change) => change.seq === 3 && /turn was missing/u.test(change.what)));
  assert.ok(plan.changes.some((change) => change.seq === 4 && /promoted/u.test(change.what)));
});

test('a summary that already exists keeps its own content', () => {
  const events = brokenBracket();
  events[3] = event('compaction/summary', 4, {
    compactionId: 'rescue-1',
    summary: [{ type: 'text', text: 'the model wrote this one' }],
    shadowedRange: { start: 2, end: 2 },
    shadowedSeqs: [2],
    shadowedTokenCount: 1234,
    provider: 'deepseek',
    model: 'deepseek-v4',
  });
  events[2].data.turn = 1;
  events[5].data.turn = 1;

  const plan = planLogRepair(events);
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.problems, []);
});

test('a bracket between turns gets a null turn, which is what the host expects there', () => {
  const events = brokenBracket();
  delete events[0]; // no open turn
  const compact = events.filter(Boolean);
  const plan = planLogRepair(compact);
  const start = plan.events.find((one) => one.type === 'compaction/start');
  const end = plan.events.find((one) => one.type === 'compaction/end');
  assert.equal(start.data.turn, null);
  assert.equal(end.data.turn, null);
  assert.deepEqual(plan.problems, []);
});

test('an end that already carries an error needs no summary', () => {
  const events = [
    event('turn/start', 1, { turn: 1 }),
    event('compaction/start', 2, { compactionId: 'rescue-2', turn: 1 }),
    event('compaction/end', 3, { compactionId: 'rescue-2', turn: 1, error: 'the append failed' }),
    event('turn/end', 4, { turn: 1 }),
  ];
  const plan = planLogRepair(events);
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.problems, []);
});

test('a bracket spanning a turn boundary is reported, not guessed at', () => {
  const events = [
    event('turn/start', 1, { turn: 1 }),
    event('compaction/start', 2, { compactionId: 'rescue-3', turn: 1 }),
    event('compaction/summary', 3, {
      compactionId: 'rescue-3',
      summary: [{ type: 'text', text: 'x' }],
      shadowedRange: { start: 7, end: 7 },
      shadowedSeqs: [7],
      shadowedTokenCount: 1,
      provider: 'p',
      model: 'm',
    }),
    event('turn/end', 4, { turn: 1 }),
    event('turn/start', 5, { turn: 2 }),
    event('compaction/end', 6, { compactionId: 'rescue-3', turn: 2 }),
  ];
  const plan = planLogRepair(events);
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0].why, /spans a turn boundary/u);
});

test('overlapping brackets, stray records and empty brackets are reported', () => {
  const overlapping = planLogRepair([
    event('compaction/start', 1, { compactionId: 'a', turn: 1 }),
    event('compaction/start', 2, { compactionId: 'b', turn: 1 }),
  ]);
  assert.ok(overlapping.problems.some((problem) => /second compaction\/start/u.test(problem.why)));

  const straySummary = planLogRepair([event('compaction/summary', 1, { compactionId: 'a' })]);
  assert.ok(straySummary.problems.some((problem) => /outside every bracket/u.test(problem.why)));

  const strayEnd = planLogRepair([event('compaction/end', 1, { compactionId: 'a', turn: 1 })]);
  assert.ok(strayEnd.problems.some((problem) => /no matching compaction\/start/u.test(problem.why)));

  const empty = planLogRepair([
    event('compaction/start', 1, { compactionId: 'a', turn: 1 }),
    event('compaction/end', 2, { compactionId: 'a', turn: 1 }),
  ]);
  assert.ok(empty.problems.some((problem) => /no summary and no compaction\/prune/u.test(problem.why)));
});

test('a checkpoint that omits a shadowed node gets the bracket\'s own record list', () => {
  const events = brokenBracket();
  events[3] = event('compaction/summary', 4, {
    compactionId: 'rescue-1',
    summary: [{ type: 'text', text: 'digest' }],
    shadowedRange: { start: 2, end: 2 },
    shadowedSeqs: [2],
    shadowedTokenCount: 1234,
    provider: 'p',
    model: 'm',
  });
  events[2].data.turn = 1;
  events[5].data.turn = 1;
  events[4].options = { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [3, 4] };

  const plan = planLogRepair(events);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.events[4].options.sourceEventSeqs, [3, 4, 2]);
  assert.ok(plan.changes.some((change) => change.seq === 5 && /sourceEventSeqs/u.test(change.what)));
});

test('a log that ends inside an open bracket is noted, because the host tolerates it', () => {
  const plan = planLogRepair([
    event('turn/start', 1, { turn: 1 }),
    event('compaction/start', 2, { compactionId: 'a', turn: 1 }),
    event('compaction/summary', 3, {
      compactionId: 'a',
      summary: [{ type: 'text', text: 'x' }],
      shadowedRange: { start: 4, end: 4 },
      shadowedSeqs: [4],
      shadowedTokenCount: 1,
      provider: 'p',
      model: 'm',
    }),
  ]);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.notes.length, 1);
  assert.match(plan.notes[0].note, /ends inside an open bracket/u);
});
