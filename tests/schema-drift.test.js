/**
 * The declaration, the defaults and the code must agree.
 *
 * A config option that is declared and documented but never read is worse than a
 * missing one: the schema accepts it, the docs promise it, the host shows it in
 * the settings UI, and nothing happens. That is exactly how `debug` shipped
 * inert once. These tests compare the three sources of truth in both directions
 * and fail with the name of the option that drifted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config } from '../index.js';
import { DEFAULTS } from '../lib/config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The option names the schema declares, straight out of its JSON projection. */
function declaredKeys() {
  const json = Config.toJSON();
  const root = json.refs[String(json.uid)];
  assert.equal(root.type, 'object', 'the config schema is an object schema');
  return Object.keys(root.dict).sort();
}

/** Comments talk about options; only code counts as wiring. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
}

/** Everything that could read an option, minus the two files that only declare it. */
function readerSources() {
  const files = ['index.js'];
  for (const name of readdirSync(join(ROOT, 'lib'))) {
    if (!name.endsWith('.js')) continue;
    if (name === 'config.js' || name === 'schema.js') continue;
    files.push(join('lib', name));
  }
  return files.map((file) => ({ file, text: stripComments(readFileSync(join(ROOT, file), 'utf8')) }));
}

test('the schema declares exactly the options that have defaults', () => {
  assert.deepEqual(declaredKeys(), Object.keys(DEFAULTS).sort());
});

test('every option the schema accepts is actually read by the plugin', () => {
  const sources = readerSources();
  const unread = declaredKeys().filter((key) => {
    const pattern = new RegExp(`\\b${key}\\b`, 'u');
    return !sources.some((source) => pattern.test(source.text));
  });
  assert.deepEqual(unread, [], `declared but never read (a settings toggle that does nothing): ${unread.join(', ')}`);
});

test('the defaults only mention options the schema declares', () => {
  const declared = new Set(declaredKeys());
  const stray = Object.keys(DEFAULTS).filter((key) => !declared.has(key));
  assert.deepEqual(stray, [], `defaults for undeclared options: ${stray.join(', ')}`);
});

test('resolving the defaults never changes them, and stays inside the schema', () => {
  const validation = Config['~standard'].validate({});
  assert.ok(!('issues' in validation), JSON.stringify(validation.issues));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.deepEqual(validation.value[key], value, `the schema default for ${key} differs from DEFAULTS`);
  }
});
