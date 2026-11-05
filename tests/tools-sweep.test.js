/**
 * The tools are the plugin's only way to answer a model, and every answer makes
 * the same trip: a JSON round trip at the host boundary. Issue #2 was one
 * `undefined` field away from losing the whole answer, so this file sweeps the
 * matrix rather than the two cases that were reported: every tool, every action,
 * a session that is empty / small / oversized, a window that resolves / does not
 * / arrives as garbage, and services that throw. Each answer must be lossless
 * and must not throw out of `execute`.
 *
 * It also pins the destructive-action rule: a tool may only rewrite the session
 * when the model asked for `rescue` (or its alias `fold`). Any other action
 * string reads. A model that guesses `fold-now` must not spend the history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeSession, fakeContext, fakeLlm, fakeMeter, seedConversation } from './fake-session.js';
import { registerTools } from '../lib/tools.js';
import { resolveConfig } from '../lib/config.js';

/** Fail on anything a JSON round trip would not preserve. */
function assertLossless(value, label) {
  const seen = new WeakSet();
  const walk = (node, where) => {
    assert.notEqual(typeof node, 'undefined', `${label}: undefined at ${where}`);
    assert.notEqual(typeof node, 'bigint', `${label}: bigint at ${where}`);
    if (typeof node === 'number') assert.ok(Number.isFinite(node), `${label}: non-finite number at ${where}`);
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${where}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(node)) walk(child, `${where}.${key}`);
  };
  walk(value, label);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label}: not a JSON round trip`);
}

function fakeTools() {
  const registered = new Map();
  return {
    registered,
    register(definition) {
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  };
}

function setup({ llm = fakeLlm(60000), meter, overrides = {} } = {}) {
  const tools = fakeTools();
  const context = fakeContext({ llm, tools, ...(meter ? { tokenMeter: meter } : {}) });
  registerTools(context, resolveConfig(overrides));
  return { tools, context };
}

/** A meter that fails: the host can hand us one while its surface is unhappy. */
function throwingMeter() {
  const meter = fakeMeter();
  return {
    ...meter,
    measure() {
      throw new Error('the surface is corrupt');
    },
  };
}

/** A session the estimator cannot read either: every lookup throws. */
function unreadableSession() {
  const session = seedConversation(new FakeSession({ id: 'unreadable' }), { turns: 6, chars: 900 });
  session.eventAt = () => {
    throw new Error('the surface is corrupt');
  };
  return session;
}

const sessions = {
  empty: () => new FakeSession({ id: 'empty' }),
  small: () => seedConversation(new FakeSession({ id: 'small' }), { turns: 3, chars: 200 }),
  oversized: () => seedConversation(new FakeSession({ id: 'oversized' }), { turns: 24, chars: 9000 }),
  // One message bigger than the whole window: nothing can be folded away, so the
  // answer comes from the excerpt tier or from a clean refusal.
  oneGiantMessage: () => seedConversation(new FakeSession({ id: 'giant' }), { turns: 1, chars: 400000 }),
};

const windows = {
  resolves: () => fakeLlm(60000),
  doesNotResolve: () => fakeLlm(Number.NaN),
  garbage: () => ({ async resolveModelInfo() { return { context: { contextWindow: 'lots' } }; } }),
  throws: () => ({ async resolveModelInfo() { throw new Error('gateway down'); } }),
};

test('every tool answer survives a JSON round trip across the whole matrix', async () => {
  for (const [windowName, makeLlm] of Object.entries(windows)) {
    for (const [sessionName, makeSession] of Object.entries(sessions)) {
      const { tools } = setup({ llm: makeLlm() });
      const session = makeSession();
      const exec = { agent: { session } };
      const label = `${windowName}/${sessionName}`;

      const status = await tools.registered.get('context_rescue').execute({ action: 'status' }, exec);
      assertLossless(status, `status ${label}`);
      assert.equal(typeof status.ok, 'boolean', `status ok is a boolean ${label}`);
      assert.equal(typeof status.window.windowTokens, 'number', `window resolves to a number ${label}`);

      const rescue = await tools.registered.get('context_rescue').execute({ action: 'rescue' }, exec);
      assertLossless(rescue, `rescue ${label}`);
      assert.equal(typeof rescue.ok, 'boolean', `rescue ok is a boolean ${label}`);

      const estimate = await tools.registered.get('context_rescue_estimate').execute({}, exec);
      assertLossless(estimate, `estimate ${label}`);
      assert.equal(estimate.ok, true);

      const pasted = await tools.registered.get('context_rescue_estimate').execute(
        { text: '400: request exceeds the model context window' },
        exec,
      );
      assertLossless(pasted, `estimate with text ${label}`);
      assert.equal(pasted.detected?.overflow, true, `the pasted text is classified ${label}`);

      const fold = await tools.registered.get('context_rescue_fold').execute({}, exec);
      assertLossless(fold, `fold ${label}`);
      assert.equal(typeof fold.ok, 'boolean', `fold ok is a boolean ${label}`);
    }
  }
});

test('a broken meter falls back to the estimator instead of failing the answer', async () => {
  const { tools } = setup({ meter: throwingMeter() });
  const session = sessions.oversized();
  const exec = { agent: { session } };

  const status = await tools.registered.get('context_rescue').execute({ action: 'status' }, exec);
  assertLossless(status, 'status with a broken meter');
  assert.equal(status.ok, true, 'a meter that throws is not an unrecoverable state');
  assert.equal(status.measurementSource, 'estimate', 'the estimator answered instead');
  assert.ok(status.measuredTokens > 0);
});

test('a session nothing can measure answers with the reason instead of throwing', async () => {
  const { tools } = setup({ meter: throwingMeter() });
  const session = unreadableSession();
  const exec = { agent: { session } };

  const status = await tools.registered.get('context_rescue').execute({ action: 'status' }, exec);
  assertLossless(status, 'status of an unreadable session');
  assert.equal(status.ok, false);
  assert.match(status.error, /surface is corrupt/u);

  // The classification is still worth returning when the measurement failed.
  const estimate = await tools.registered.get('context_rescue_estimate').execute(
    { text: 'exceeds the model context window' },
    exec,
  );
  assertLossless(estimate, 'estimate of an unreadable session');
  assert.equal(estimate.ok, false);
  assert.equal(estimate.detected?.overflow, true);
  assert.equal(estimate.session, null);

  const fold = await tools.registered.get('context_rescue_fold').execute({}, exec);
  assertLossless(fold, 'fold of an unreadable session');
  assert.equal(fold.ok, false);
  assert.match(fold.error, /surface is corrupt/u);

  const rescue = await tools.registered.get('context_rescue').execute({ action: 'rescue' }, exec);
  assertLossless(rescue, 'rescue of an unreadable session');
  assert.equal(rescue.ok, false);
});

test('an action this build does not know reads the session, it does not fold it', async () => {
  const { tools } = setup({ llm: fakeLlm(400000) });
  const session = sessions.oversized();
  const before = session.events.length;
  const nodes = session.surface.nodes.length;

  for (const action of ['banana', 'FOLD', 'fold now', 'rescue!', undefined, 42]) {
    const answer = await tools.registered.get('context_rescue').execute({ action }, { agent: { session } });
    assertLossless(answer, `action ${String(action)}`);
    assert.equal(answer.ok, true, `unknown action ${String(action)} still answers`);
    assert.equal(answer.attempted ?? false, false, `unknown action ${String(action)} does not fold`);
  }

  assert.equal(session.events.length, before, 'no event was appended for an unknown action');
  assert.equal(session.surface.nodes.length, nodes, 'the surface is untouched for an unknown action');
});

test('action=fold is the documented alias of action=rescue, and it folds', async () => {
  const { tools } = setup({ llm: fakeLlm(400000) });
  const session = sessions.oversized();
  const before = session.events.length;

  const answer = await tools.registered.get('context_rescue').execute({ action: 'fold' }, { agent: { session } });
  assert.equal(answer.ok, true);
  assert.equal(answer.attempted, true);
  assert.ok(answer.after < answer.before, 'the alias really folds');
  assert.ok(session.events.length > before, 'events were appended');
  assert.ok(session.appendLog.some((entry) => entry.type === 'compaction/summary'));
});

test('all three tools answer without a session instead of throwing', async () => {
  const { tools } = setup();
  for (const [name, args] of [
    ['context_rescue', { action: 'status' }],
    ['context_rescue', { action: 'rescue' }],
    ['context_rescue_estimate', {}],
    ['context_rescue_fold', {}],
  ]) {
    const answer = await tools.registered.get(name).execute(args, {});
    assertLossless(answer, `${name} without a session`);
    if (name === 'context_rescue_estimate') {
      assert.equal(answer.ok, true, 'estimate works without a session');
      assert.equal(answer.session, null);
      continue;
    }
    assert.equal(answer.ok, false, `${name} says why it cannot answer`);
    assert.match(answer.error, /no active session/u);
  }
});
