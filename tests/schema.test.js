/**
 * Tests for the declared config schema.
 *
 * The schema earns its keep only if the host can consume it: it must be a native
 * Schemastery graph (the host refuses to project anything else) and it must
 * accept/refuse exactly what we document. These tests check the contract, and
 * one of them keeps the declaration from drifting away from `DEFAULTS`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { Config } from '../index.js';
import { DEFAULTS } from '../lib/config.js';
import { Config as SchemaConfig } from '../lib/schema.js';

test('index.js exports the schema the host projects', () => {
  assert.equal(Config, SchemaConfig);
  // The host identifies a native schema by this brand plus `type` and `meta`.
  assert.equal(Config[Symbol.for('schemastery')], true);
  assert.equal(typeof Config.type, 'string');
  assert.equal(typeof Config.meta, 'object');
  assert.equal(typeof Config['~standard'].validate, 'function');
});

test('every documented option is declared', () => {
  const declared = Config.toJSON();
  const text = JSON.stringify(declared);
  const missing = Object.keys(DEFAULTS).filter((key) => !text.includes(`"${key}"`));
  assert.deepEqual(missing, [], `undeclared options: ${missing.join(', ')}`);
});

test('validation fills in the defaults', () => {
  const result = Config['~standard'].validate({});
  assert.ok(!('issues' in result), JSON.stringify(result));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.deepEqual(result.value[key], value, `default for ${key}`);
  }
});

test('an unknown mode is refused instead of silently falling back', () => {
  const result = Config['~standard'].validate({ mode: 'aggressive' });
  assert.ok('issues' in result);
  assert.ok(result.issues.some((issue) => issue.path?.[0] === 'mode' || String(issue.message).includes('mode')));
});

test('a ratio outside its bound is refused', () => {
  const result = Config['~standard'].validate({ retainRatio: 9 });
  assert.ok('issues' in result);
  assert.match(JSON.stringify(result.issues), /retainRatio/u);
});

test('a wrongly typed switch is refused', () => {
  const result = Config['~standard'].validate({ preflight: 'yes' });
  assert.ok('issues' in result);
  assert.match(JSON.stringify(result.issues), /preflight/u);
});

test('an unknown key survives, so validateConfig can still name the typo', () => {
  const result = Config['~standard'].validate({ retainRation: 0.4 });
  assert.ok(!('issues' in result));
  assert.equal(result.value.retainRation, 0.4);
});

test('lane refusal patterns are a list of strings', () => {
  const result = Config['~standard'].validate({ laneRefusalPatterns: ['refused'] });
  assert.ok(!('issues' in result));
  assert.deepEqual(result.value.laneRefusalPatterns, ['refused']);
});
