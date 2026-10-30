import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeSession, fakeContext, fakeLlm, seedConversation } from './fake-session.js';
import { resolveConfig } from '../lib/config.js';
import { openTransactions, repairStaleTransactions } from '../lib/repair.js';
import { hasOpenCompactionTransaction } from '../lib/plan.js';
import { measure } from '../lib/measure.js';
import { describeSession, rescue } from '../lib/rescue.js';

const OVERFLOW = {
  code: 'INVALID_REQUEST',
  message: 'the request exceeds the model\u0027s context window',
};

function sessionWithDanglingStart(turn) {
  const session = new FakeSession();
  seedConversation(session, { turns: 24, chars: 3000 });
  session.append('compaction/start', { compactionId: 'dead-1', turn });
  return session;
}

test('openTransactions remembers a start and forgets a closed bracket', () => {
  const session = new FakeSession();
  session.append('compaction/start', { compactionId: 'a', turn: 1 });
  session.append('compaction/start', { compactionId: 'b', turn: 1 });
  session.append('compaction/end', { compactionId: 'a', turn: 1 });
  const open = openTransactions(session);
  assert.deepEqual([...open.keys()], ['b']);
});

test('a transaction opened in an earlier turn is closed, a current one is left alone', () => {
  const session = new FakeSession();
  session.append('compaction/start', { compactionId: 'old', turn: 3 });
  session.append('compaction/start', { compactionId: 'live', turn: 9 });
  const repaired = repairStaleTransactions(session, { turn: 9 });
  assert.deepEqual(repaired, ['old']);
  const open = openTransactions(session);
  assert.deepEqual([...open.keys()], ['live']);
  const end = session.events.find((event) => event.type === 'compaction/end' && event.data?.compactionId === 'old');
  assert.ok(end, 'the stale bracket is closed');
  assert.match(String(end.data.error), /left open by an earlier turn/);
});

test('a session that died mid-fold can be rescued again', async () => {
  const session = sessionWithDanglingStart(3);
  const ctx = fakeContext({ llm: fakeLlm(60000) });
  const config = resolveConfig({});
  const before = measure(ctx, session).totalTokens;
  assert.ok(before > 60000, `seed must exceed the window: ${before}`);
  assert.equal(hasOpenCompactionTransaction(session.events), true, 'the seed really is blocked');

  const report = await rescue(ctx, {
    agent: { session }, session, failure: OVERFLOW, provider: 'p', config, turn: 9,
  });

  assert.equal(report.action, 'retry');
  assert.ok(report.after.totalTokens < before);
  assert.equal(hasOpenCompactionTransaction(session.events), false);
  const logged = ctx.logs.map((entry) => `${entry.level} ${entry.message}`).join('\n');
  assert.match(logged, /closed compaction transaction dead-1/);
});

test('repair can be switched off, and then the dangling start still blocks a fold', async () => {
  const session = sessionWithDanglingStart(3);
  const ctx = fakeContext({ llm: fakeLlm(60000) });
  const config = resolveConfig({ repairTransactions: false });

  const report = await rescue(ctx, {
    agent: { session }, session, failure: OVERFLOW, provider: 'p', config, turn: 9,
  });

  assert.notEqual(report.action, 'retry', 'nothing may be written while the bracket is unexplained');
  assert.equal(hasOpenCompactionTransaction(session.events), true);
});

test('the status answer names a dangling transaction', async () => {
  const session = sessionWithDanglingStart(3);
  const ctx = fakeContext({ llm: fakeLlm(60000) });
  const config = resolveConfig({});
  const status = await describeSession(ctx, { session, config });
  assert.deepEqual(status.openTransactions, ['dead-1']);
});
