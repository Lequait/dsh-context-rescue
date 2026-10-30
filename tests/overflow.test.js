import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyFailure, extractEvidence, isLaneRefusal } from '../lib/overflow.js';
import { DEFAULTS } from '../lib/config.js';

const screenshot = 'Command Code API error 400: the request exceeds the model\u0027s context window — this session is being compacted and the request retried';

const gateway10138 = 'payload core text alone is ~3089866 bytes (ratio 0.9978 of the 3096600-byte request body); that is ≥ ~411983 tokens vs the model window 196608 — no upstream can accept it even if every optional section were dropped';

test('detects the exact wording from the reported failure', () => {
  const result = classifyFailure({ message: screenshot, code: 'INVALID_REQUEST' });
  assert.equal(result.overflow, true);
  assert.ok(result.score >= 3, `score ${result.score}`);
  assert.ok(result.matched.includes('model-context-window'));
});

test('detects gateway wording the host classifier misses (discussion #10138)', () => {
  const result = classifyFailure({ message: gateway10138, code: 'INVALID_REQUEST' });
  assert.equal(result.overflow, true);
  assert.ok(result.matched.includes('no-upstream-can-accept'));
  assert.equal(result.evidence.requestTokens, 411983);
  assert.equal(result.evidence.windowTokens, 196608);
  assert.equal(result.evidence.payloadBytes, 3089866);
});

test('accepts structured provider codes without wording', () => {
  for (const code of ['CONTEXT_WINDOW_EXCEEDED', 'context_length_exceeded', 'TOO_LARGE_FOR_CONTEXT']) {
    const result = classifyFailure({ message: 'failed', code });
    assert.equal(result.overflow, true, code);
  }
});

test('does not fire on unrelated failures', () => {
  const cases = [
    { message: 'rate limit exceeded, retry after 20s', code: 'RATE_LIMITED' },
    { message: 'Invalid API key provided', code: 'INVALID_REQUEST' },
    { message: 'fetch failed: ECONNRESET' },
    { message: 'the model produced no output' },
  ];
  for (const failure of cases) {
    assert.equal(classifyFailure(failure).overflow, false, JSON.stringify(failure));
  }
});

test('numbers alone do not trigger rescue', () => {
  const result = classifyFailure({ message: 'used 411983 tokens in 12 seconds' });
  assert.equal(result.overflow, false);
  assert.equal(result.evidence.requestTokens, 411983);
});

test('custom patterns extend detection without breaking on bad regex', () => {
  const text = '窗口爆了：请缩小输入';
  assert.equal(classifyFailure({ message: text }).overflow, false);
  const extended = classifyFailure({ message: text }, { extraPatterns: ['窗口爆了'] });
  assert.equal(extended.overflow, true);
  const broken = classifyFailure({ message: text }, { extraPatterns: ['([unclosed'] });
  assert.equal(broken.overflow, false);
});

test('extractEvidence tolerates absence of numbers', () => {
  const evidence = extractEvidence('message too long');
  assert.equal(evidence.requestTokens, undefined);
  assert.equal(evidence.windowTokens, undefined);
  assert.deepEqual(evidence.allRequestTokens, []);
});

test('lane refusal is recognised from the billion-context 422', () => {
  const refusal = {
    code: 'dsh_compaction_refused',
    message: 'dsh native compaction call refused by billion-context: bili owns compression on this lane (#2028)',
  };
  assert.equal(isLaneRefusal(refusal, DEFAULTS.laneRefusalPatterns), true);
  assert.equal(isLaneRefusal({ message: 'plain failure' }, DEFAULTS.laneRefusalPatterns), false);
});
