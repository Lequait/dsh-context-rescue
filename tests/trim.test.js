import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeSession, fakeContext, fakeLlm } from './fake-session.js';
import { resolveConfig } from '../lib/config.js';
import { measure } from '../lib/measure.js';
import { rescue } from '../lib/rescue.js';

const OVERFLOW = {
  code: 'INVALID_REQUEST',
  message: 'the request exceeds the model\u0027s context window',
};
const WINDOW = 60000;

function replacementText(session) {
  const found = session.events.find((event) => event.type === 'user/message'
    && String(event.data?.message?.content?.[0]?.text ?? event.data?.content?.[0]?.text ?? '')
      .includes('首尾摘录'));
  if (!found) return '';
  return String(found.data?.message?.content?.[0]?.text ?? found.data?.content?.[0]?.text ?? '');
}

function oneBigMessage(body) {
  const session = new FakeSession();
  session.append('system/message', { message: { content: [{ type: 'text', text: 'sys' }] } });
  session.append('user/message', { message: { content: [{ type: 'text', text: body }] } });
  return session;
}

test('a message that alone overflows is replaced by its own head and tail', async () => {
  const body = `HEAD-MARKER${'内容'.repeat(45000)}TAIL-MARKER`;
  const session = oneBigMessage(body);
  const ctx = fakeContext({ llm: fakeLlm(WINDOW) });
  const config = resolveConfig({});
  const before = measure(ctx, session).totalTokens;
  assert.ok(before > WINDOW, `seed must exceed the window: ${before}`);

  const report = await rescue(ctx, {
    agent: { session }, session, failure: OVERFLOW, provider: 'p', config, turn: 4,
  });

  assert.equal(report.action, 'retry');
  assert.ok(report.after.totalTokens < WINDOW);
  const text = replacementText(session);
  assert.ok(text.includes('HEAD-MARKER'), 'the beginning survives');
  assert.ok(text.includes('TAIL-MARKER'), 'the end survives');
  assert.ok(text.includes('首尾摘录'), 'the checkpoint says what happened');
  assert.ok(report.tiers.some((tier) => tier.tier === 'oversized-message' && tier.ok === true));
});

test('the excerpt length follows excerptChars instead of the whole message', async () => {
  const body = `${'前'.repeat(6000)}${'中'.repeat(80000)}${'后'.repeat(6000)}`;
  const session = oneBigMessage(body);
  const ctx = fakeContext({ llm: fakeLlm(WINDOW) });
  const config = resolveConfig({ excerptChars: 500 });

  const report = await rescue(ctx, {
    agent: { session }, session, failure: OVERFLOW, provider: 'p', config, turn: 4,
  });

  assert.equal(report.action, 'retry');
  const text = replacementText(session);
  assert.ok(text.length < 5000, `the replacement stays small: ${text.length} chars`);
  assert.ok(text.includes('前'.repeat(500)));
  assert.ok(text.includes('后'.repeat(500)));
  assert.ok(!text.includes('中'.repeat(600)), 'the middle is dropped');
});

test('an oversized node that cannot be removed without breaking pairing is left alone', async () => {
  const session = new FakeSession();
  session.append('system/message', { message: { content: [{ type: 'text', text: 'sys' }] } });
  session.append('user/message', { message: { content: [{ type: 'text', text: 'go' }] } });
  // A tool result with no matching call: dropping it would break pairing, and
  // the surface is already corrupt, so nothing may be written at all.
  session.append('tool/result', { message: { content: [{ type: 'text', text: '孤儿'.repeat(60000) }] } });
  const ctx = fakeContext({ llm: fakeLlm(WINDOW) });
  const config = resolveConfig({});
  const eventsBefore = session.events.length;

  const report = await rescue(ctx, {
    agent: { session }, session, failure: OVERFLOW, provider: 'p', config, turn: 4,
  });

  assert.notEqual(report.action, 'retry');
  assert.equal(session.events.length, eventsBefore, 'no event may be written');
});

test('trimming can be switched off', async () => {
  const session = oneBigMessage('内容'.repeat(45000));
  const ctx = fakeContext({ llm: fakeLlm(WINDOW) });
  const config = resolveConfig({ trimOversizedMessages: false });
  const eventsBefore = session.events.length;

  const report = await rescue(ctx, {
    agent: { session }, session, failure: OVERFLOW, provider: 'p', config, turn: 4,
  });

  assert.notEqual(report.action, 'retry');
  assert.equal(session.events.length, eventsBefore);
  assert.equal(replacementText(session), '');
});
