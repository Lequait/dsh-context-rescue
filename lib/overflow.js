/**
 * Context-window overflow detection.
 *
 * The host ships a classifier (`isContextWindowExceededError`) with a fixed set
 * of probes. Gateways and aggregators word the same condition differently — the
 * failure reported in deepseek-harness discussion #10138 is the canonical
 * example: "payload core text alone is ~3089866 bytes ... ≥ ~411983 tokens vs
 * the model window 196608 ... no upstream can accept it". That string matches
 * none of the host probes, so the failure surfaces as a generic
 * INVALID_REQUEST and the loop never runs its overflow recovery.
 *
 * This module is a superset detector: it scores the wording, recognises the
 * provider error codes used across the ecosystem, and extracts the numbers the
 * wording happens to carry so a caller can cross-check the declared window
 * against the window the upstream actually enforced.
 * @module dsh-context-rescue/overflow
 */

import { asText, isObject, uniq } from './util.js';

/** Provider/aggregator codes that always mean "too large for the window". */
const OVERFLOW_CODES = new Set([
  'CONTEXT_WINDOW_EXCEEDED',
  'CONTEXT_LENGTH_EXCEEDED',
  'CONTEXT_WINDOW_EXCEEDED_ERROR',
  'MODEL_CONTEXT_WINDOW_EXCEEDED',
  'CONTEXT_LENGTH_ERROR',
  'MAX_CONTEXT_LENGTH',
  'INPUT_TOO_LONG',
  'TOO_LARGE_FOR_CONTEXT',
  'PROMPT_TOO_LONG',
  'REQUEST_TOO_LARGE',
]);

/**
 * Strong probes: alone or with a second signal, these identify the condition.
 * Each entry is `[id, weight, regex]`.
 * @type {Array<[string, number, RegExp]>}
 */
const STRONG_PROBES = [
  ['context-window-exceeded', 3, /context[_ -]?(?:window|length)[\s\S]{0,48}(?:exceed|overflow|too (?:large|long|big)|over the limit|limit reached)/i],
  ['exceeds-model-context', 3, /exceed\w*[\s\S]{0,32}(?:context|window)/i],
  ['maximum-context-length', 3, /maximum context length/i],
  ['model-context-window', 3, /model'?s? context window/i],
  ['prompt-too-long', 3, /(?:prompt|input|messages?)\s+(?:is|are|was|were)?\s*(?:way\s+)?too\s+long/i],
  ['reduce-length', 3, /reduce the length of the (?:messages|prompt|input|conversation)/i],
  ['no-upstream-can-accept', 3, /no upstream can accept/i],
  ['window-vs-budget', 2, /(?:\d[\d,]*\s*tokens?[^.]{0,48}(?:vs\.?|versus|over|beyond|against)[^.]{0,24}window|window[^.]{0,24}\d[\d,]*\s*tokens?)/i],
  ['token-budget-exceeded', 2, /token budget[^.]{0,32}(?:exceed|overflow)/i],
  ['max-tokens-exceeded', 2, /max(?:imum)?[_ ]tokens?[^.]{0,24}(?:exceed|too small for)/i],
  ['insufficient-quota-window', 2, /(?:request|payload)[^.]{0,40}(?:exceeds?|too large)[^.]{0,40}(?:window|context)/i],
];

/**
 * Weak probes: corroborate, never decide alone.
 * Each entry is `[id, weight, regex]`.
 * @type {Array<[string, number, RegExp]>}
 */
const WEAK_PROBES = [
  ['http-413', 1, /\b413\b/],
  ['payload-bytes', 1, /\d[\d,]{4,}\s*bytes?/i],
  ['token-count', 1, /\d[\d,]{3,}\s*tokens?\b/i],
  ['invalid-request', 1, /invalid[_ ]request/i],
  ['truncated-input', 1, /(?:truncat|clip)\w+ (?:input|messages?|prompt)/i],
];

/** Strip thousands separators and parse a non-negative integer. */
function toNumber(raw) {
  const num = Number(String(raw).replace(/[,\s_]/g, ''));
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : undefined;
}

/** Collect every numeric match of `pattern` inside `text`. */
function numbersFor(text, pattern) {
  const out = [];
  for (const match of text.matchAll(pattern)) {
    const value = toNumber(match[1]);
    if (value !== undefined) out.push(value);
  }
  return out;
}

/**
 * Extract the sizes a failure message happens to mention. Gateways differ, so
 * every field is best-effort and may be undefined.
 * @param {string} text
 */
export function extractEvidence(text) {
  const requestTokens = numbersFor(text, /(?:~|about|approximately|around|≥|>=|<|<=)?\s*([\d][\d,]{3,})\s*tokens?\b/gi);
  const windowTokens = [
    ...numbersFor(text, /(?:context|window|limit|max(?:imum)?)[^\d\n]{0,32}([\d][\d,]{3,})/gi),
    ...numbersFor(text, /([\d][\d,]{3,})\s*(?:tokens?)[^\n]{0,16}(?:window|context)/gi),
  ];
  const payloadBytes = numbersFor(text, /([\d][\d,]{4,})\s*bytes?/gi);
  const pickMax = (list) => (list.length === 0 ? undefined : Math.max(...list));
  const windowFromEvidence = windowTokens.length === 0 ? undefined : windowTokens[0];
  return {
    requestTokens: pickMax(requestTokens),
    windowTokens: windowFromEvidence,
    payloadBytes: pickMax(payloadBytes),
    allRequestTokens: uniq(requestTokens, 8),
    allWindowTokens: uniq(windowTokens, 8),
  };
}

/** Flatten the failure into one searchable string. */
function failureText(failure) {
  if (!isObject(failure)) return asText(failure);
  const parts = [asText(failure.message), asText(failure.code), asText(failure.status)];
  for (const key of ['detail', 'details', 'raw', 'body', 'response', 'cause']) {
    const value = failure[key];
    if (value === undefined) continue;
    parts.push(typeof value === 'string' ? value : asText(value));
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * Classify one failed request.
 * @param {unknown} failure - the `payload.failure` of `agent/request-error`.
 * @param {{extraPatterns?: string[]}} [options]
 * @returns {{
 *   overflow: boolean, score: number, confidence: 'high'|'medium'|'low'|'none',
 *   matched: string[], code: string, message: string,
 *   evidence: ReturnType<typeof extractEvidence>
 * }}
 */
export function classifyFailure(failure, options = {}) {
  const text = failureText(failure);
  const code = isObject(failure) && failure.code !== undefined ? asText(failure.code) : '';
  const message = isObject(failure) ? asText(failure.message) : asText(failure);
  const matched = [];
  let score = 0;

  if (OVERFLOW_CODES.has(code.toUpperCase())) {
    matched.push(`code:${code}`);
    score += 5;
  }
  for (const [id, weight, pattern] of STRONG_PROBES) {
    if (pattern.test(text)) {
      matched.push(id);
      score += weight;
    }
  }
  let strongScore = score;
  for (const [id, weight, pattern] of WEAK_PROBES) {
    if (pattern.test(text)) {
      matched.push(id);
      score += weight;
    }
  }
  let customScore = 0;
  for (const [index, source] of (options.extraPatterns ?? []).entries()) {
    try {
      if (new RegExp(source, 'i').test(text)) {
        matched.push(`custom:${index}`);
        score += 3;
        customScore += 3;
      }
    } catch {
      // A malformed user pattern must never break rescue.
    }
  }

  const evidence = extractEvidence(text);
  // Numbers alone are not proof, but a matched wording plus a token figure is.
  // The figure has to come with a strong wording: two weak probes plus numbers
  // that the request merely echoed (its own model limits, say) is not an
  // overflow, and folding a session for it costs context for nothing.
  // Weak probes never decide: three of them ("413", "invalid request", a byte
  // figure) describe a rejected request, not a request that was rejected for its
  // size. Only a strong wording, or a strong-ish wording next to real numbers,
  // is enough to fold a session and retry.
  const overflow = strongScore >= 3
    || customScore >= 3
    || (strongScore > 0 && evidence.requestTokens !== undefined && evidence.windowTokens !== undefined);
  const confidence = score >= 5 ? 'high' : score >= 3 ? 'medium' : score >= 2 ? 'low' : 'none';
  return { overflow, score, confidence, matched: uniq(matched, 12), code, message, evidence };
}

/**
 * True when a failure looks like the compression lane refusing the host's own
 * compaction call — the billion-context guard from discussion #10138.
 * @param {unknown} failure
 * @param {string[]} patterns
 */
export function isLaneRefusal(failure, patterns) {
  const text = failureText(failure).toLowerCase();
  if (!text) return false;
  return patterns.some((pattern) => pattern && text.includes(String(pattern).toLowerCase()));
}
