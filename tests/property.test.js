/**
 * Properties, not examples.
 *
 * Two boundaries in this plugin are pure functions whose output has to satisfy
 * an invariant for *every* input, and both have already cost a release:
 *
 * * `toLossless` — its output must survive a JSON round trip and must be a fixed
 *   point (running it twice may not change anything), or the host drops the tool
 *   answer (issue #2).
 * * `planLogRepair` — it may repair a bracket or report it, but it must never
 *   hand back a log that still violates a rule it did not mention, or `--write`
 *   would replace a corrupt session with a differently corrupt one (issue #1).
 *
 * The generators are seeded, so a failure is reproducible from the seed printed
 * in the assertion message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toLossless } from '../lib/util.js';
import { planLogRepair } from '../lib/repair-log.js';

/** Deterministic 32-bit PRNG; the seed is part of every failure message. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, items) {
  return items[Math.floor(random() * items.length)];
}

/** A JSON value with the exact hazards a model payload contains. */
function randomValue(random, depth = 0) {
  const leaf = [
    () => 'text',
    () => '',
    () => 0,
    () => -1.5,
    () => Number.NaN,
    () => Number.POSITIVE_INFINITY,
    () => Number.NEGATIVE_INFINITY,
    () => true,
    () => null,
    () => undefined,
    () => 12n,
    () => () => 'fn',
    () => Symbol('s'),
    () => new Date(0),
    () => new Map([['k', 'v']]),
  ];
  if (depth >= 3) return pick(random, leaf)();
  const shape = random();
  if (shape < 0.45) return pick(random, leaf)();
  if (shape < 0.7) {
    const length = Math.floor(random() * 4);
    return Array.from({ length }, () => randomValue(random, depth + 1));
  }
  const value = {};
  const keys = ['a', 'b', 'nested', 'undefinedKey', 'nanKey'];
  const count = 1 + Math.floor(random() * 3);
  for (let index = 0; index < count; index += 1) value[pick(random, keys)] = randomValue(random, depth + 1);
  return value;
}

test('toLossless is a fixed point that survives a JSON round trip', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const random = mulberry32(seed);
    const input = randomValue(random);
    const once = toLossless(input);
    const twice = toLossless(once);
    const label = `seed ${seed}`;
    assert.deepEqual(twice, once, `${label}: toLossless is not idempotent`);
    assert.deepEqual(JSON.parse(JSON.stringify(once)), once, `${label}: output is not lossless JSON`);
  }
});

test('toLossless keeps shared references shared and only breaks real cycles', () => {
  const shared = { name: 'shared' };
  const value = { first: shared, second: shared };
  const once = toLossless(value);
  assert.deepEqual(once, { first: { name: 'shared' }, second: { name: 'shared' } });

  const cycle = { name: 'cycle' };
  cycle.self = cycle;
  const broken = toLossless(cycle);
  assert.equal(broken.self, '[circular]');
  assert.deepEqual(JSON.parse(JSON.stringify(broken)), broken);
});

/** Re-simulate the host's bracket rules on an event list. */
function bracketFailures(events) {
  const failures = [];
  let openTurn = null;
  /** @type {null | {id: any, turn: any, summaries: number, startSeq: any}} */
  let open = null;
  for (const event of events) {
    const type = String(event?.type ?? '');
    if (type === 'turn/start') {
      if (open) failures.push(`turn/start while the bracket at seq ${open.startSeq} is open`);
      const turn = event.data?.turn;
      openTurn = Number.isInteger(turn) && turn >= 0 ? turn : null;
      continue;
    }
    if (type === 'turn/end') {
      if (open) failures.push(`turn/end while the bracket at seq ${open.startSeq} is open`);
      openTurn = null;
      continue;
    }
    if (type === 'compaction/start') {
      if (open) failures.push(`a second compaction/start while the one at seq ${open.startSeq} is open`);
      if (event.data?.turn !== openTurn) failures.push(`start turn ${JSON.stringify(event.data?.turn)} is not the open turn ${JSON.stringify(openTurn)}`);
      open = { id: event.data?.compactionId, turn: event.data?.turn, summaries: 0, startSeq: event.seq };
      continue;
    }
    if (open === null) continue;
    if (type === 'compaction/summary') {
      if (event.data?.compactionId !== open.id) failures.push(`summary id ${JSON.stringify(event.data?.compactionId)} does not match ${JSON.stringify(open.id)}`);
      open.summaries += 1;
      continue;
    }
    if (type !== 'compaction/end') continue;
    if (event.data?.compactionId !== open.id) failures.push(`end id ${JSON.stringify(event.data?.compactionId)} does not match ${JSON.stringify(open.id)}`);
    if (event.data?.turn !== open.turn) failures.push(`end turn ${JSON.stringify(event.data?.turn)} is not the start turn ${JSON.stringify(open.turn)}`);
    if (event.data?.error === undefined && open.summaries !== 1) failures.push(`a bracket that ended without error holds ${open.summaries} summaries`);
    open = null;
  }
  return failures;
}

/** One bracket with a random but deliberate defect injected. */
function bracketEvents(random, { seq, turn, defects }) {
  const id = `rescue-${seq}`;
  const events = [
    { seq, type: 'compaction/start', data: { compactionId: id } },
    { seq: seq + 1, type: 'compaction/prune', data: { shadowedRange: { start: 2, end: 4 }, shadowedSeqs: [2, 3, 4], shadowedTokenCount: 90 } },
    {
      seq: seq + 2,
      type: 'user/message',
      data: { source: { kind: 'compact-checkpoint', compactionId: id }, content: [{ type: 'text', text: '## digest' }] },
      options: { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 }, sourceEventSeqs: defects.includes('sources') ? [seq, 2] : [seq, seq + 1, 2, 3, 4] },
    },
    { seq: seq + 3, type: 'compaction/end', data: { compactionId: id, ...(defects.includes('endError') ? { error: 'gave up' } : {}) } },
  ];
  if (!defects.includes('missingTurn')) {
    events[0].data.turn = defects.includes('wrongTurn') ? 99 : turn;
    events[3].data.turn = defects.includes('wrongTurn') ? 99 : turn;
  }
  if (!defects.includes('noSummary')) {
    events.splice(1, 0, {
      seq: seq + 1,
      type: 'compaction/summary',
      data: { compactionId: id, summary: [{ type: 'text', text: '## digest' }], shadowedRange: { start: 2, end: 4 }, shadowedSeqs: [2, 3, 4], shadowedTokenCount: 90, provider: 'p', model: 'm' },
    });
  }
  return events;
}

function renumber(events) {
  return events.map((event, index) => ({ ...event, seq: index }));
}

test('a repairable log is repaired and then satisfies every bracket rule', () => {
  const defectSets = [[], ['missingTurn'], ['wrongTurn'], ['noSummary'], ['sources'], ['noSummary', 'missingTurn'], ['noSummary', 'wrongTurn', 'sources']];
  for (const defects of defectSets) {
    for (const turn of [1, 4, null]) {
      const label = `defects ${defects.join('+') || 'none'}, turn ${turn}`;
      const events = bracketEvents(mulberry32(1), { seq: 0, turn, defects });
      const planned = planLogRepair(renumber(events));
      assert.deepEqual(planned.problems, [], `${label}: nothing here is unrepairable`);
      assert.deepEqual(bracketFailures(planned.events), [], `${label}: the repaired log still breaks a rule`);
    }
  }
});

test('random logs are either repaired into a valid shape or reported, never silently corrupt', () => {
  const defectPool = ['missingTurn', 'wrongTurn', 'noSummary', 'sources', 'endError'];
  for (let seed = 1; seed <= 300; seed += 1) {
    const random = mulberry32(seed);
    const events = [];
    let turn = 1 + Math.floor(random() * 3);
    events.push({ seq: 0, type: 'turn/start', data: { turn } });
    let seq = 1;
    events.push({ seq, type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } });
    seq += 1;

    const brackets = 1 + Math.floor(random() * 3);
    for (let index = 0; index < brackets; index += 1) {
      const defects = defectPool.filter(() => random() < 0.25);
      const built = bracketEvents(random, { seq, turn, defects });
      for (const event of built) events.push({ ...event, seq: seq + event.seq });
      seq += built.length;
      if (random() < 0.4) {
        events.push({ seq, type: 'turn/end', data: {} });
        turn += 1;
        events.push({ seq: seq + 1, type: 'turn/start', data: { turn } });
        seq += 2;
      }
    }

    const planned = planLogRepair(renumber(events));
    const label = `seed ${seed}`;
    assert.deepEqual(planLogRepair(renumber(events)), planned, `${label}: the planner is not deterministic`);
    // The repaired log must be JSON-safe: it is compressed back into a session file.
    assert.deepEqual(JSON.parse(JSON.stringify(planned.events)), planned.events, `${label}: output is not lossless JSON`);
    for (const change of planned.changes) {
      assert.equal(typeof change.index, 'number');
      assert.equal(typeof change.type, 'string');
      assert.ok(change.what.length > 0);
    }
    const failures = bracketFailures(planned.events);
    if (planned.problems.length === 0) {
      assert.deepEqual(failures, [], `${label}: reported nothing wrong, yet the log breaks: ${failures.join('; ')}`);
    } else {
      // Reporting is a legitimate outcome; what is not legitimate is reporting
      // nothing while leaving a defect behind (covered above) or reporting a
      // problem for an index that does not exist.
      for (const problem of planned.problems) {
        assert.ok(problem.index >= 0 && problem.index < planned.events.length, `${label}: problem index out of range`);
        assert.ok(problem.why.length > 0, `${label}: a problem without a reason`);
      }
    }
  }
});

test('a random log with no brackets at all is left exactly as it is', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const random = mulberry32(seed);
    const events = [{ seq: 0, type: 'turn/start', data: { turn: 1 } }];
    const messages = 1 + Math.floor(random() * 5);
    for (let index = 0; index < messages; index += 1) {
      events.push({ seq: index + 1, type: 'user/message', data: { content: [{ type: 'text', text: String(index) }] } });
    }
    const planned = planLogRepair(events);
    assert.deepEqual(planned.problems, []);
    assert.deepEqual(planned.notes, []);
    assert.deepEqual(planned.changes, []);
    assert.deepEqual(planned.events, events);
  }
});
