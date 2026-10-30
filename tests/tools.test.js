/**
 * Model-facing tools.
 *
 * There are three entry points, and each one is a thin wrapper over the same
 * machinery the hooks use: `context_rescue` (status or fold now),
 * `context_rescue_estimate` (classify a pasted error) and `context_rescue_fold`
 * (fold without waiting for a failure). A tool call can arrive while the agent is
 * idle, so none of them may assume a turn number exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeSession, fakeContext, fakeLlm, seedConversation } from './fake-session.js';
import { registerTools } from '../lib/tools.js';
import { resolveConfig } from '../lib/config.js';
import { measure } from '../lib/measure.js';

/** A tool registry that behaves like the host's: unique names, disposers returned. */
function fakeTools() {
  const registered = new Map();
  return {
    registered,
    register(definition) {
      assert.equal(typeof definition.name, 'string');
      assert.equal(typeof definition.description, 'string');
      assert.ok(definition.description.length > 0);
      assert.equal(typeof definition.execute, 'function');
      assert.ok(definition.parameters && typeof definition.parameters === 'object');
      assert.ok(definition.output && typeof definition.output === 'object');
      if (registered.has(definition.name)) throw new Error(`tool ${definition.name} already registered`);
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  };
}

function oversized() {
  const session = new FakeSession();
  seedConversation(session, { turns: 24, chars: 9000 });
  return session;
}

function setup(overrides = {}) {
  const tools = fakeTools();
  const llm = fakeLlm(60000);
  const context = fakeContext({ llm, tools });
  const config = resolveConfig(overrides);
  const disposers = registerTools(context, config);
  return { tools, context, config, disposers };
}

test('every tool is registered with a parameter schema and an output renderer', () => {
  const { tools, disposers } = setup();
  assert.deepEqual([...tools.registered.keys()], ['context_rescue', 'context_rescue_estimate', 'context_rescue_fold']);
  for (const definition of tools.registered.values()) {
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(definition.output.schema.additionalProperties, true);
    const rendered = definition.output.render({}, { ok: true, note: 'x' });
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].type, 'text');
    assert.match(rendered[0].text, /```json/);
    assert.match(rendered[0].text, /"note": "x"/);
  }
  assert.equal(disposers.length, 3);
  for (const dispose of disposers) dispose();
  assert.equal(tools.registered.size, 0);
});

test('registerTools stays out of the way when it is switched off or unwired', () => {
  const context = fakeContext({ llm: fakeLlm(60000), tools: fakeTools() });
  assert.deepEqual(registerTools(context, resolveConfig({ registerTools: false })), []);

  const bare = fakeContext({ llm: fakeLlm(60000) });
  assert.deepEqual(registerTools(bare, resolveConfig({})), [], 'a host without a tool registry is not an error');
});

test('context_rescue reports status without rewriting the session', async () => {
  const { tools, context } = setup();
  const session = oversized();
  const nodesBefore = session.surface.nodes.length;
  const result = await tools.registered.get('context_rescue').execute({ action: 'status' }, { agent: { session }, signal: new AbortController().signal });

  assert.equal(result.ok, true);
  assert.equal(result.fits, false);
  assert.equal(result.window.windowTokens, 60000);
  assert.equal(result.attemptsThisTurn, 0);
  assert.equal(result.lastAttempt, null);
  assert.ok(result.preview, 'the status payload carries the fold preview');
  assert.equal(session.surface.nodes.length, nodesBefore);
  assert.ok(measure(context, session).totalTokens > 60000);
});

test('context_rescue with action=rescue folds and reports the token delta', async () => {
  const { tools, context } = setup();
  const session = oversized();
  const before = measure(context, session).totalTokens;
  const result = await tools.registered.get('context_rescue').execute({ action: 'rescue' }, { agent: { session } });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'retry');
  assert.ok(result.after < result.before);
  assert.ok(result.after < before);
  assert.ok(Array.isArray(result.tiers) && result.tiers.length > 0);
});

test('a tool call without a session says so instead of throwing', async () => {
  const { tools } = setup();
  for (const name of ['context_rescue', 'context_rescue_fold']) {
    const result = await tools.registered.get(name).execute({ action: 'rescue' }, {});
    assert.equal(result.ok, false);
    assert.match(result.error, /no active session/);
  }
});

test('context_rescue_estimate classifies the text it is given', async () => {
  const { tools } = setup();
  const session = oversized();
  const gateway = 'payload core text alone is ~3068943 bytes; that is ≥ ~411983 tokens vs the model window 196608 — no upstream can accept it';
  const result = await tools.registered.get('context_rescue_estimate').execute({ text: gateway }, { agent: { session } });

  assert.equal(result.ok, true);
  assert.equal(result.detected.overflow, true);
  assert.equal(result.detected.evidence.windowTokens, 196608);
  assert.ok(result.session, 'the session is described alongside the classification');

  const empty = await tools.registered.get('context_rescue_estimate').execute({}, { agent: { session } });
  assert.equal(empty.detected, null);
  assert.ok(empty.session);
});

test('context_rescue_fold folds immediately without a turn number', async () => {
  const { tools, context } = setup();
  const session = oversized();
  const result = await tools.registered.get('context_rescue_fold').execute({}, { agent: { session } });

  assert.equal(result.ok, true);
  assert.ok(result.after < result.before);
  assert.ok(result.digestChars > 0);
  assert.ok(result.written && typeof result.written.replacementSeq === 'number');
  const last = session.events.at(-1);
  assert.equal(last.type, 'compaction/end', 'the transaction is closed even without a turn');
  assert.equal(measure(context, session).totalTokens, result.after);
});

test('the agent is found through any of the shapes a host may use', async () => {
  const { tools } = setup();
  const session = oversized();
  for (const exec of [{ agent: { session } }, { context: { agent: { session } } }, { session: { agent: { session } } }]) {
    const result = await tools.registered.get('context_rescue').execute({ action: 'status' }, exec);
    assert.equal(result.ok, true);
    assert.equal(result.window.windowTokens, 60000);
  }
});
