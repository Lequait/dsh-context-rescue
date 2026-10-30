import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDigest } from '../lib/digest.js';
import { FakeSession } from './fake-session.js';

/** A session-shaped object over a fixed event list. */
function sessionOf(events) {
  return {
    events,
    snapshotEvents: () => events,
    eventAt: (seq) => events.find((event) => event.seq === seq),
  };
}

const user = (seq, text) => ({ seq, type: 'user/message', data: { content: [{ type: 'text', text }] } });
const assistant = (seq, text) => ({ seq, type: 'assistant/message', data: { content: [{ type: 'text', text }] } });
const call = (seq, name, args) => ({ seq, type: 'tool/call', data: { name, arguments: args } });

const digestOf = (events) =>
  buildDigest(sessionOf(events), {
    startSeq: events[0].seq,
    endSeq: events[events.length - 1].seq,
    shadowedTokenCount: 1000,
    measuredTokens: 4000,
    windowTokens: 1000,
  });

test('harness housekeeping is not reported as user intent', () => {
  const text = digestOf([
    user(1, '<system-reminder> A skill is a reusable set of task-specific instructions.'),
    user(2, '[MNEMON] Use mnemon_view_route only when relevant evidence is missing.'),
    user(3, 'Time sampled while preparing turn 7, step 3: 2026-10-30T22:00:00+08:00'),
    user(4, '请把 solver.lua 的确定性断言补上'),
  ]);
  assert.match(text, /请把 solver\.lua 的确定性断言补上/u);
  assert.doesNotMatch(text, /task-specific instructions/u);
  assert.doesNotMatch(text, /mnemon_view_route/u);
  assert.doesNotMatch(text, /Time sampled/u);
});

test('a goal restated every round appears once', () => {
  const goal = '<goal_round> Objective: "续作：推进三档造型规范" Round: 3/40';
  const text = digestOf([user(1, goal), user(2, goal), user(3, goal), user(4, '开始吧')]);
  const occurrences = text.split('推进三档造型规范').length - 1;
  assert.equal(occurrences, 1);
  assert.doesNotMatch(text, /<goal_round>/u);
});

test('tool calls read as what they were for, and repeats collapse', () => {
  const text = digestOf([
    call(1, 'run_code', { description: 'Read the handoff document' }),
    call(2, 'run_code', { description: 'Read the handoff document' }),
    call(3, 'run_code', { description: 'Run the compile gate' }),
    assistant(4, 'done'),
  ]);
  assert.match(text, /run_code：Read the handoff document/u);
  assert.equal(text.split('Read the handoff document').length - 1, 1);
  assert.match(text, /另有 1 次重复或同类调用未展开/u);
});

test('a conclusion glued to an echoed call keeps only the statement', () => {
  const text = digestOf([
    user(1, 'go'),
    assistant(2, '现在把几何量接入 main.lua： [调用 run_code] {"code": "const a = 1"}'),
  ]);
  assert.match(text, /现在把几何量接入 main\.lua/u);
  assert.doesNotMatch(text, /const a = 1/u);
});

test('the header is separated from the first section', () => {
  const text = digestOf([user(1, '做一个能跑的插件'), assistant(2, '好')]);
  assert.match(text, /模型可见的压缩投影。\n### /u);
});

test('file paths survive when the host stores arguments as a JSON string', () => {
  // The host writes tool arguments as one JSON text blob, so a tree walk finds
  // no path leaves at all. Paths are the most useful thing to keep across a
  // fold, so they are read out of the text too -- and an escape sequence that
  // merely looks like a drive letter is not a path.
  const text = digestOf([
    call(1, 'run_code', JSON.stringify({
      description: 'Run the Lua compile gate',
      code: "await tools.read({ file_path: 'H:\\\\Projects\\\\Game\\\\tools\\\\luacompile.py' })",
    })),
    call(2, 'run_code', JSON.stringify({ command: 'echo T:\\\\n' })),
    assistant(3, 'ok'),
  ]);

  assert.match(text, /触及的文件与路径/u);
  assert.match(text, /luacompile\.py/u);
  assert.match(text, /H:\\Projects\\Game/u);
  assert.equal(/T:\\n/u.test(text), false, 'an escape sequence is not a path');
});
