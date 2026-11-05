/**
 * Tool results have to be lossless JSON.
 *
 * The host drops a tool result whose value cannot survive a JSON round trip, so
 * the model sees `tool "…" returned invalid output: value is not lossless JSON`
 * instead of the answer. Issue #2 came from two `undefined` values: an optional
 * window field (`observed`) and the fold's `skipped` reason on success. These
 * tests pin the boundary, not just those two fields.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeSession, fakeContext, fakeLlm, seedConversation } from './fake-session.js';
import { registerTools } from '../lib/tools.js';
import { resolveConfig } from '../lib/config.js';
import { toLossless } from '../lib/util.js';

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

function setup({ windowTokens = 60000, overrides = {} } = {}) {
  const tools = fakeTools();
  const context = fakeContext({ llm: fakeLlm(windowTokens), tools });
  registerTools(context, resolveConfig(overrides));
  return { tools, context };
}

test('toLossless coerces the values a JSON round trip would destroy', () => {
  const circular = { name: 'loop' };
  circular.self = circular;

  const sanitized = toLossless({
    gone: undefined,
    nan: Number.NaN,
    infinite: Number.POSITIVE_INFINITY,
    big: 10n,
    fn: () => 1,
    list: [undefined, 2, Number.NaN],
    nested: { keep: 'yes', drop: undefined },
    circular,
  });

  assert.deepEqual(sanitized, {
    nan: null,
    infinite: null,
    big: '10',
    list: [null, 2, null],
    nested: { keep: 'yes' },
    circular: { name: 'loop', self: '[circular]' },
  });
  assertLossless(sanitized, 'sanitized');
  // The input is not mutated: callers may still hold the original payload.
  assert.equal(Object.hasOwn({ gone: undefined }, 'gone'), true);
});

test('status and estimate stay lossless when the window has no declared or observed size', async () => {
  // No model info and no evidence text: `declared`, `observed`, `model` and
  // `provider` were all undefined here, which is what issue #2 reported.
  const { tools } = setup({ windowTokens: Number.NaN });
  const session = new FakeSession();
  seedConversation(session, { turns: 6, chars: 400 });

  const status = await tools.registered.get('context_rescue').execute({ action: 'status' }, { agent: { session } });
  assertLossless(status, 'status');
  assert.equal(status.ok, true);
  assert.equal(status.window.declared, null);
  assert.equal(status.window.observed, null);

  const estimate = await tools.registered.get('context_rescue_estimate').execute({}, { agent: { session } });
  assertLossless(estimate, 'estimate');
  assert.equal(estimate.session.window.observed, null);
});

test('a successful fold reports no undefined skipped reason', async () => {
  const { tools } = setup();
  const session = new FakeSession();
  seedConversation(session, { turns: 24, chars: 9000 });

  const folded = await tools.registered.get('context_rescue_fold').execute({}, { agent: { session } });
  assertLossless(folded, 'fold');
  assert.equal(folded.ok, true);
  assert.equal(Object.hasOwn(folded, 'skipped'), false, 'a fold that worked has no reason to give');
});

test('context_rescue rescue output is lossless on both paths', async () => {
  const { tools } = setup({ windowTokens: 400000 });
  const session = new FakeSession();
  seedConversation(session, { turns: 24, chars: 9000 });

  const folded = await tools.registered.get('context_rescue').execute({ action: 'rescue' }, { agent: { session } });
  assertLossless(folded, 'rescue after fold');
  assert.equal(folded.attempted, true);

  // Nothing left to fold: the negative path must be lossless too.
  const again = await tools.registered.get('context_rescue').execute({ action: 'rescue' }, { agent: { session } });
  assertLossless(again, 'rescue with nothing to do');
});
