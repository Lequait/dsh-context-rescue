/**
 * Small, host-free helpers shared by every module of dsh-context-rescue.
 * Nothing here imports `@deepseek-ai/*`; the plugin must load on any host build.
 * @module dsh-context-rescue/util
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce anything to a trimmed string without throwing. @param {unknown} value */
export function asText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Clamp `text` to `max` characters with an ellipsis marker. */
export function clamp(text, max) {
  const value = asText(text);
  if (max <= 0 || value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 12))}…[截断]`;
}

/** Collapse whitespace and clamp: one-line previews for digests. */
export function oneLine(text, max = 200) {
  return clamp(asText(text).replace(/\s+/g, ' ').trim(), max);
}

/** Deduplicate while preserving first-seen order. */
export function uniq(list, limit = Infinity) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = asText(item);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Flatten one content block list into plain text. Tool calls and tool results
 * carry structured payloads, so they are rendered as compact JSON fragments —
 * the digest only needs enough to recognise what happened.
 * @param {unknown} content
 * @param {number} [maxPerBlock]
 */
export function contentBlocksToText(content, maxPerBlock = 2000) {
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!isObject(block)) {
        parts.push(asText(block));
        continue;
      }
      switch (block.type) {
        case 'text':
          parts.push(clamp(block.text, maxPerBlock));
          break;
        case 'tool-call':
        case 'tool_use':
          parts.push(`[调用 ${asText(block.name)}] ${clamp(block.arguments ?? block.input, maxPerBlock)}`);
          break;
        case 'tool-result':
        case 'tool_result':
          parts.push(`[结果] ${clamp(block.content ?? block.output, maxPerBlock)}`);
          break;
        case 'image':
          parts.push('[图片]');
          break;
        default:
          parts.push(clamp(block, maxPerBlock));
      }
    }
    return parts.filter(Boolean).join('\n');
  }
  return asText(content);
}

/**
 * Flatten one content block list without clamping.
 *
 * Measurement must see the whole payload: a 480k-character tool result priced
 * through the clamped digest renderer would measure as a few thousand tokens,
 * and the plugin would then decide a hopelessly oversized session still fits.
 * @param {unknown} content
 */
export function contentBlocksToRawText(content) {
  return contentBlocksToText(content, 0);
}

/** Rough, host-free token estimate used only when no token meter is reachable. */
export function estimateTokensFromText(text) {
  const value = asText(text);
  if (!value) return 0;
  // CJK glyphs cost ~1 token each; latin prose ~4 chars per token.
  let cjk = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1;
    else if (code >= 0xac00 && code <= 0xd7af) cjk += 1;
    else if (code >= 0xf900 && code <= 0xfaff) cjk += 1;
    else if (code >= 0x3000 && code <= 0x303f) cjk += 1;
  }
  const rest = Math.max(0, value.length - cjk);
  return Math.ceil(cjk + rest / 4);
}

/** True when `value` looks like an absolute or clearly relative filesystem path. */
export function looksLikePath(value) {
  if (typeof value !== 'string') return false;
  if (value.length < 3 || value.length > 400) return false;
  if (/\s{2,}/.test(value)) return false;
  return /^(?:[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/]|\/)[^\n"']*/.test(value) || /^[\w.-]+[\\/][\w./\\-]+\.\w{1,8}$/.test(value);
}

/** Recursively collect path-like string leaves from a tool-call argument tree. */
export function collectPaths(value, out, depth = 0) {
  if (depth > 6 || out.length >= 200) return out;
  if (typeof value === 'string') {
    if (looksLikePath(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out, depth + 1);
    return out;
  }
  if (isObject(value)) {
    for (const item of Object.values(value)) collectPaths(item, out, depth + 1);
  }
  return out;
}

/** A stable, monotonic-ish id without depending on host services. */
export function makeId(prefix = 'rescue') {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}`;
}

/** Safe caller: run `fn`, returning a result record instead of throwing. */
export async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Format an error for diagnostics, keeping its code when present. */
export function errorText(error) {
  if (!isObject(error) && typeof error !== 'string') return asText(error);
  const code = isObject(error) && error.code !== undefined ? String(error.code) : '';
  const message = isObject(error) ? asText(error.message) : asText(error);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}
