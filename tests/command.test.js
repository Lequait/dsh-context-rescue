/**
 * Slash-command surface.
 *
 * The fake registry below re-implements the host's `normalizeDefinition` and
 * `normalizeResult` rules, so a definition or a handler result that the real
 * `@deepseek-ai/dsh-commands` registry would reject fails here first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeSession, fakeContext, fakeLlm, seedConversation } from './fake-session.js';
import { registerCommands } from '../lib/command.js';
import { resolveConfig } from '../lib/config.js';
import { measure } from '../lib/measure.js';

const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;

/** A registry that enforces the host contract and keeps what it accepted. */
function fakeCommands() {
  const registered = new Map();
  return {
    registered,
    register(definition) {
      if (!definition || typeof definition !== 'object') throw new TypeError('definition must be an object');
      if (typeof definition.name !== 'string' || !COMMAND_NAME.test(definition.name)) {
        throw new TypeError(`command name "${definition.name}" must match ${String(COMMAND_NAME)}`);
      }
      if (typeof definition.description !== 'string' || definition.description.trim().length === 0) {
        throw new TypeError(`command "${definition.name}" description must not be empty`);
      }
      if (typeof definition.handler !== 'function') {
        throw new TypeError(`command "${definition.name}" handler must be a function`);
      }
      if (registered.has(definition.name)) throw new Error(`command "${definition.name}" is already registered`);
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  };
}

/** Assert a handler result is one the host would accept. */
function assertCommandResult(result) {
  assert.equal(typeof result, 'object');
  assert.ok(result !== null);
  if (result.kind === 'success') {
    if (result.text !== undefined) assert.equal(typeof result.text, 'string');
    if (result.sourceEventSeq !== undefined) {
      assert.ok(Number.isSafeInteger(result.sourceEventSeq), 'sourceEventSeq must be a safe integer');
      assert.ok(result.sourceEventSeq >= 0, 'sourceEventSeq must not be negative');
    }
    return result;
  }
  assert.equal(result.kind, 'error', `unexpected result kind "${String(result.kind)}"`);
  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.trim().length > 0, 'error text must not be empty');
  return result;
}

function sessionWithLongHistory(turns = 24, chars = 9000) {
  const session = new FakeSession();
  seedConversation(session, { turns, chars });
  return session;
}

function setup(options = {}) {
  const session = options.session ?? sessionWithLongHistory();
  const context = fakeContext({ llm: fakeLlm(options.window ?? 60000) });
  const commands = fakeCommands();
  context.services.set('commands', commands);
  const disposers = registerCommands(context, resolveConfig(options.config ?? {}));
  return { session, context, commands, disposers };
}

test('registers /rescue and /rescue-status with host-valid definitions', () => {
  const { commands, disposers } = setup();
  assert.deepEqual([...commands.registered.keys()], ['rescue', 'rescue-status']);
  assert.ok(disposers.length >= 2, `got ${disposers.length} disposers`);

  const rescue = commands.registered.get('rescue');
  assert.equal(rescue.definitionId, '@deepseek-ai/dsh-context-rescue:rescue');
  assert.match(rescue.description, /fold/i);

  const status = commands.registered.get('rescue-status');
  assert.match(status.description, /occupancy|context/i);

  for (const dispose of disposers) dispose();
  assert.equal(commands.registered.size, 0, 'disposers must unregister');
});

test('/rescue folds the session and reports a usable success result', async () => {
  const { session, context, commands } = setup();
  const before = measure(context, session).totalTokens;
  assert.ok(before > 60000, `seed must exceed the window: ${before}`);

  const definition = commands.registered.get('rescue');
  const result = assertCommandResult(await definition.handler({ agent: { session }, rawInput: '', signal: new AbortController().signal }));

  assert.equal(result.kind, 'success');
  assert.match(result.text, /Rescued: [\d,]+ -> [\d,]+ tokens against a [\d,]+ window/);
  assert.match(result.text, /Send your message again/);
  assert.ok(Number.isSafeInteger(result.sourceEventSeq), 'a fold must point the UI at its replacement event');
  assert.ok(measure(context, session).totalTokens < before);
});

test('/rescue on a projection that already fits changes nothing', async () => {
  const session = new FakeSession();
  seedConversation(session, { turns: 4, chars: 400 });
  const context = fakeContext({ llm: fakeLlm(60000) });
  const commands = fakeCommands();
  context.services.set('commands', commands);
  registerCommands(context, resolveConfig({}));
  const nodesBefore = session.surface.nodes.length;

  const result = assertCommandResult(await commands.registered.get('rescue').handler({ agent: { session }, rawInput: '', signal: new AbortController().signal }));

  assert.equal(result.kind, 'success');
  assert.match(result.text, /Nothing to do/);
  assert.equal(result.sourceEventSeq, undefined);
  assert.equal(session.surface.nodes.length, nodesBefore, 'a fitting projection must not be rewritten');
});

test('/rescue status is a read-only report', async () => {
  const { session, context, commands } = setup();
  const nodesBefore = session.surface.nodes.length;

  const result = assertCommandResult(await commands.registered.get('rescue').handler({ agent: { session }, rawInput: ' status ', signal: new AbortController().signal }));

  assert.equal(result.kind, 'success');
  assert.match(result.text, /tokens in context/);
  assert.match(result.text, /window/);
  assert.equal(session.surface.nodes.length, nodesBefore, 'status must not rewrite the session');
});

test('/rescue-status reports without rewriting even when the session is oversized', async () => {
  const { session, context, commands } = setup();
  const nodesBefore = session.surface.nodes.length;
  const result = assertCommandResult(await commands.registered.get('rescue-status').handler({ agent: { session }, rawInput: '', signal: new AbortController().signal }));

  assert.equal(result.kind, 'success');
  assert.match(result.text, /over the fit ratio/);
  assert.match(result.text, /host compaction/);
  assert.equal(session.surface.nodes.length, nodesBefore);
  assert.ok(measure(context, session).totalTokens > 60000);
});

test('commands report a missing session instead of throwing', async () => {
  const { commands } = setup();
  for (const name of ['rescue', 'rescue-status']) {
    const result = assertCommandResult(await commands.registered.get(name).handler({ rawInput: '', signal: new AbortController().signal }));
    assert.equal(result.kind, 'error');
    assert.match(result.text, /No active session/);
  }
});

test('a host without a command registry is not an error', () => {
  const context = fakeContext({ llm: fakeLlm(60000) });
  const disposers = registerCommands(context, resolveConfig({}));
  // Only the late-mount listener is installed; nothing is registered and nothing
  // is logged as a warning.
  assert.ok(disposers.length <= 1, `got ${disposers.length} disposers`);
  assert.equal(context.logs.filter((entry) => entry.level === 'warn').length, 0);
});

test('a registry that mounts after the plugin still receives the commands', () => {
  const context = fakeContext({ llm: fakeLlm(60000) });
  registerCommands(context, resolveConfig({}));

  const late = fakeCommands();
  const notify = context.listeners.get('internal/service');
  assert.equal(typeof notify, 'function', 'the plugin must watch for late services');
  notify('commands', late);

  assert.deepEqual([...late.registered.keys()], ['rescue', 'rescue-status']);
});

test('registerCommands:false stands the commands down', () => {
  const context = fakeContext({ llm: fakeLlm(60000) });
  const commands = fakeCommands();
  context.services.set('commands', commands);
  assert.deepEqual(registerCommands(context, resolveConfig({ registerCommands: false })), []);
  assert.equal(commands.registered.size, 0);
  assert.equal(context.listeners.size, 0, 'nothing may be listening when commands are off');
});
