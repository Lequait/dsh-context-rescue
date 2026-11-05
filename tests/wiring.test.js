/**
 * Every switch in the config has to change the wiring, not just the numbers.
 *
 * The failure this guards against is quiet: an option that the schema accepts,
 * the docs describe, and the plugin resolves — while the hook it was supposed to
 * install is missing. `enabled: false` must mount nothing, `preflight: false`
 * must not listen on `agent/pre-step`, and turning commands or tools off must
 * never cost the `agent/request-error` hook, because that hook is the plugin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';
import { FakeSession, fakeContext, fakeLlm, seedConversation } from './fake-session.js';

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

/** The agent-loop hooks, which are the ones whose presence matters here. */
function agentHooks(ctx) {
  return [...ctx.listeners.keys()].filter((name) => name.startsWith('agent/')).sort();
}

function mount(overrides = {}) {
  const ctx = fakeContext({
    llm: fakeLlm(60000),
    tools: fakeTools(),
    commands: undefined,
  });
  apply(ctx, overrides);
  return ctx;
}

test('the default mount listens for failures and pre-flight, and registers three tools', () => {
  const ctx = mount();
  assert.deepEqual(agentHooks(ctx), ['agent/pre-step', 'agent/request-error']);
  assert.equal(ctx.get('tools').registered.size, 3);
});

test('enabled: false mounts nothing at all', () => {
  const ctx = mount({ enabled: false });
  assert.deepEqual(agentHooks(ctx), []);
  assert.equal(ctx.listeners.size, 0, 'no listener of any kind is left behind');
  assert.equal(ctx.get('tools').registered.size, 0);
  assert.ok(ctx.logs.some((entry) => /disabled by configuration/u.test(entry.message)));
});

test('preflight: false drops the pre-step hook and keeps the failure hook', () => {
  const ctx = mount({ preflight: false });
  assert.deepEqual(agentHooks(ctx), ['agent/request-error']);
});

test('registerTools: false registers no tools but keeps both hooks', () => {
  const ctx = mount({ registerTools: false });
  assert.equal(ctx.get('tools').registered.size, 0);
  assert.deepEqual(agentHooks(ctx), ['agent/pre-step', 'agent/request-error']);
});

test('a host without a tool registry or command service still gets the failure hook', () => {
  const ctx = fakeContext({ llm: fakeLlm(60000) });
  apply(ctx, {});
  assert.ok(ctx.listeners.has('agent/request-error'));
  assert.ok(ctx.logs.every((entry) => entry.level !== 'warn'), 'a missing optional service is not a warning');
});

test('a tool registry that throws while registering does not take the failure hook with it', () => {
  const ctx = fakeContext({
    llm: fakeLlm(60000),
    tools: {
      register() {
        throw new Error('registry is closed');
      },
    },
  });
  apply(ctx, {});
  assert.ok(ctx.listeners.has('agent/request-error'), 'the hook that is the plugin survived');
  assert.ok(ctx.logs.some((entry) => /tool registration failed: registry is closed/u.test(entry.message)));
});

test('diagnose mode mounts the same wiring: the refusal happens per request, not at mount time', async () => {
  const ctx = mount({ mode: 'diagnose' });
  assert.deepEqual(agentHooks(ctx), ['agent/pre-step', 'agent/request-error']);

  // A diagnosed overflow must not rewrite the session, even through the hook.
  const session = seedConversation(new FakeSession(), { turns: 24, chars: 9000 });
  const before = session.events.length;
  const handler = ctx.listeners.get('agent/request-error');
  const result = await handler(
    {
      agent: { session },
      turn: 1,
      failure: { message: '400: the request exceeds the model context window' },
    },
    async () => ({ kind: 'pass' }),
  );
  assert.deepEqual(result, { kind: 'pass' }, 'the host keeps the failure');
  assert.equal(session.events.length, before, 'nothing was appended in diagnose mode');
  assert.ok(session.appendLog.every((entry) => !String(entry.type).startsWith('compaction/')), 'no bracket was opened');
});
