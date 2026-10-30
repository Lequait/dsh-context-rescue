import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, mergeConfig, resolveConfig, validateConfig } from '../lib/config.js';
import { fakeContext } from './fake-session.js';
import { apply } from '../index.js';

/** Collect the messages of the warnings for one key. */
function messagesFor(warnings, key) {
  return warnings.filter((warning) => warning.key === key).map((warning) => warning.message);
}

test('the defaults are valid and the empty object is silent', () => {
  assert.deepEqual(validateConfig(undefined), []);
  assert.deepEqual(validateConfig({}), []);
  assert.deepEqual(validateConfig(resolveConfig({})), []);
  assert.ok(DEFAULTS.targetRatio < DEFAULTS.fitRatio, 'the defaults keep the fold target below the retry threshold');
});

test('a misspelled option is reported instead of silently ignored', () => {
  const warnings = validateConfig({ retainRation: 0.3 });
  const messages = messagesFor(warnings, 'retainRation');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /unknown option "retainRation" is ignored/u);
});

test('a mode the plugin does not know falls back to auto and says so', () => {
  const warnings = messagesFor(validateConfig({ mode: 'aggressive' }), 'mode');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /is not auto\|diagnose\|fold; using "auto"/u);
  assert.equal(resolveConfig({ mode: 'aggressive' }).mode, 'auto');
});

test('an option of the wrong type is reported once', () => {
  const warnings = validateConfig({ enabled: 'yes', retainRatio: 'half' });
  assert.match(messagesFor(warnings, 'enabled')[0], /enabled must be a boolean/u);
  // 'half' is not a number at all, so the clamp report stays quiet about it.
  assert.deepEqual(messagesFor(warnings, 'retainRatio'), []);
});

test('a ratio outside its usable range is clamped and the clamp is reported', () => {
  const warnings = validateConfig({ retainRatio: 0.95, fitRatio: 0.1 });
  assert.match(messagesFor(warnings, 'retainRatio')[0], /0\.95 is outside 0\.05\.\.0\.6; using 0\.6 instead/u);
  assert.match(messagesFor(warnings, 'fitRatio')[0], /0\.1 is outside 0\.3\.\.1; using 0\.3 instead/u);
  assert.equal(resolveConfig({ retainRatio: 0.95 }).retainRatio, 0.6);
});

test('a fold target that sits at or above the retry threshold is reported', () => {
  const warnings = messagesFor(validateConfig({ targetRatio: 0.92 }), 'targetRatio');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /a fold that lands on the target can still be refused/u);
});

test('a retained tail that cannot fit the fold is reported', () => {
  const warnings = validateConfig({ retainMinTokens: 50000 });
  assert.match(messagesFor(warnings, 'retainMaxTokens')[0], /the ceiling wins/u);
  const floor = validateConfig({ minFoldTokens: 40000 });
  assert.match(messagesFor(floor, 'minFoldTokens')[0], /short histories will never be folded/u);
});

test('options that are not an object are reported, and the plugin still mounts on the defaults', () => {
  assert.equal(validateConfig(['nope'])[0].key, '(options)');
  const ctx = fakeContext();
  apply(ctx, 'nonsense');
  const warned = ctx.logs.map((entry) => `${entry.level} ${entry.message}`).join('\n');
  assert.match(warned, /config: plugin options must be an object/u);
});

test('mounting with a typo warns once and keeps working', () => {
  const ctx = fakeContext();
  apply(ctx, { retainRation: 0.3, registerTools: false });
  const lines = ctx.logs.filter((entry) => entry.level === 'warn').map((entry) => entry.message);
  assert.equal(lines.filter((line) => line.includes('retainRation')).length, 1);
  assert.equal(mergeConfig(DEFAULTS, { retainRation: 0.3 }).retainRation, 0.3, 'the raw value is kept, not applied');
});
