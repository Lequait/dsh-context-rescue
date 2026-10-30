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

/** How many excerpt checkpoints the surface now carries. */
function excerptCount(session) {
  return session.events.filter((event) => event.type === 'user/message'
    && String(event.data?.message?.content?.[0]?.text ?? event.data?.content?.[0]?.text ?? '')
      .includes('首尾摘录')).length;
}

/** Two pasted blocks that are each, on their own, over the window. */
function twoBigMessages() {
  const session = new FakeSession();
  session.append('system/message', { message: { content: [{ type: 'text', text: 'sys' }] } });
  session.append('user/message', { message: { content: [{ type: 'text', text: `甲${'甲'.repeat(55000)}` }] } });
  session.append('assistant/message', { message: { content: [{ type: 'text', text: '收到，继续。' }] } });
  session.append('user/message', { message: { content: [{ type: 'text', text: `乙${'乙'.repeat(55000)}` }] } });
  return session;
}

test('several pasted blocks are cut down in one pass', async () => {
  const session = new FakeSession();
  session.append('system/message', { message: { content: [{ type: 'text', text: 'sys' }] } });
  for (const mark of ['甲', '乙', '丙']) {
    session.append('user/message', { message: { content: [{ type: 'text', text: mark + mark.repeat(120000) }] } });
    session.append('assistant/message', { message: { content: [{ type: 'text', text: '好的' }] } });
  }
  const ctx = fakeContext({ llm: fakeLlm(WINDOW) });
  const config = resolveConfig({});
  assert.ok(measure(ctx, session).totalTokens > WINDOW * 3, 'seed must be far over the window');

  const report = await rescue(ctx, {
    agent: { session }, session, failure: OVERFLOW, provider: 'p', config, turn: 4,
  });

  assert.equal(report.action, 'retry');
  assert.ok(report.after.totalTokens < WINDOW, `still over: ${report.after.totalTokens}`);
  assert.ok(excerptCount(session) >= 1, 'at least the surviving block was excerpted');
});

test('the system prompt is never replaced by an excerpt', async () => {
  const session = new FakeSession();
  const instructions = '系'.repeat(120000);
  session.append('system/message', { message: { content: [{ type: 'text', text: instructions }] } });
  for (let i = 0; i < 8; i += 1) {
    session.append('user/message', { message: { content: [{ type: 'text', text: `步骤 ${i}` }] } });
    session.append('assistant/message', { message: { content: [{ type: 'text', text: `好 ${i}` }] } });
  }
  const ctx = fakeContext({ llm: fakeLlm(WINDOW) });
  const config = resolveConfig({});

  const report = await rescue(ctx, {
    agent: { session }, session, failure: OVERFLOW, provider: 'p', config, turn: 4,
  });

  assert.equal(report.action, 'pass', 'an unshrinkable system prompt is a failure to report, not to paper over');
  assert.equal(excerptCount(session), 0);
  const tier = report.tiers.find((entry) => entry.tier === 'oversized-message');
  assert.equal(tier.ok, false);
  assert.match(tier.skipped, /system prompt is never excerpted/u);
  const first = session.events.find((event) => event.type === 'system/message');
  assert.equal(first.data?.message?.content?.[0]?.text, instructions, 'the instructions are untouched');
});

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

test('a single tool result that alone overflows is replaced with its call', async () => {
  // The newest turn read one huge file. There is no span to fold around it, and
  // the result cannot be dropped on its own without orphaning the call, so the
  // call and its answer have to go together.
  const session = new FakeSession();
  session.append('system/message', { message: { content: [{ type: 'text', text: 'sys' }] } });
  session.append('user/message', { message: { content: [{ type: 'text', text: 'read the log' }] } });
  session.append('assistant/message', {
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reading' },
        { type: 'tool-call', toolCallId: 'call_big', name: 'read_file', args: { path: 'big.log' } },
      ],
    },
  });
  session.append('tool/call', { toolCallId: 'call_big', name: 'read_file', args: { path: 'big.log' } });
  session.append('tool/result', {
    toolCallId: 'call_big',
    name: 'read_file',
    content: [{ type: 'text', text: 'L'.repeat(300000) }],
  });
  const ctx = fakeContext({ llm: fakeLlm(WINDOW) });
  const config = resolveConfig({});

  const report = await rescue(ctx, {
    agent: { session }, session, failure: OVERFLOW, provider: 'p', config, turn: 4,
  });

  assert.equal(report.action, 'retry');
  assert.equal(excerptCount(session), 1, 'one excerpt replaces the call and its result');
  assert.match(report.reason, /tool output/u);
  const text = replacementText(session);
  assert.match(text, /工具：read_file/u);
  // Neither half of the pair may survive alone: that is a corrupt surface.
  const types = measure(ctx, session).nodes.map((node) => session.eventAt(node.seq)?.type);
  assert.equal(types.includes('tool/result'), false);
  assert.equal(measure(ctx, session).totalTokens < WINDOW, true);
});

test('an excerpt prefers older history over the message typed right now', async () => {
  const { FakeSession, fakeContext, fakeLlm } = await import('./fake-session.js');
  const { measure } = await import('../lib/measure.js');
  const { pickOversizedNode } = await import('../lib/rescue.js');

  const build = (olderChars, currentChars) => {
    const session = new FakeSession();
    session.append('turn/start', { turn: 1 });
    session.append('user/message', { content: [{ type: 'text', text: 'x'.repeat(olderChars) }] });
    session.append('assistant/message', { content: [{ type: 'text', text: 'ok' }] });
    session.append('turn/start', { turn: 2 });
    session.append('user/message', { content: [{ type: 'text', text: 'y'.repeat(currentChars) }] });
    const ctx = fakeContext({ llm: fakeLlm(196608) });
    const measurement = measure(ctx, session);
    const turnStartSeq = session.events.filter((event) => event.type === 'turn/start').at(-1).seq;
    return { session, measurement, turnStartSeq, olderSeq: measurement.nodes[0].seq, currentSeq: measurement.nodes.at(-1).seq };
  };

  const wide = build(300_000, 400_000);
  const preferred = pickOversizedNode(wide.session, wide.measurement, 1, { turnStartSeq: wide.turnStartSeq });
  assert.equal(wide.measurement.nodes[preferred.start].seq, wide.olderSeq, 'the older message was chosen');

  const anyNode = pickOversizedNode(wide.session, wide.measurement, 1);
  assert.equal(wide.measurement.nodes[anyNode.start].seq, wide.currentSeq, 'without a turn start the biggest message wins');

  const narrow = build(400, 400_000);
  const onlyCurrent = pickOversizedNode(narrow.session, narrow.measurement, 1000, { turnStartSeq: narrow.turnStartSeq });
  assert.equal(
    narrow.measurement.nodes[onlyCurrent.start].seq,
    narrow.currentSeq,
    'when nothing older is large enough the current message is still cut',
  );
});
