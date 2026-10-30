/**
 * Planning a listing pull request without touching the network.
 *
 * Every community list wants the same thing in a slightly different shape: one line in one README,
 * or two lines in two READMEs, or a row in a category file. What they have in common is that the
 * edit is an insertion *after a line that already exists* — and that half of the ways such a pull
 * request fails are decided before the network: the anchor line is missing, it appears twice, the
 * entry does not end with a period, the repository name does not match the one being described.
 *
 * This module decides those things; `submit-list.mjs` only performs what it decided.
 *
 * @module dsh-context-rescue/scripts/dev/list-plan
 */

const NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ENTRY = /^- \[([^\]]+)\]\((https:\/\/github\.com\/[^)\s]+)\)\s+[—–-]\s+(.+)$/u;

/**
 * @typedef {object} Edit
 * @property {string} path file in the upstream repository
 * @property {string} after an existing line the new line goes under
 * @property {string} insert the line to add
 */

/**
 * @typedef {object} Plan
 * @property {string} upstream `owner/name` of the list
 * @property {string} [base] branch to target, `main` by default
 * @property {string} [branch] branch on the fork, `add-dsh-context-rescue` by default
 * @property {string} title pull request title
 * @property {string} body pull request body
 * @property {Edit[]} edits one or more file insertions
 */

/**
 * The rules a plan must satisfy before any request is made.
 * @param {unknown} plan
 * @returns {string[]} one sentence per problem; empty when the plan is usable
 */
export function validatePlan(plan) {
  const problems = [];
  if (plan === null || typeof plan !== 'object') return ['a plan must be an object'];
  const candidate = /** @type {Record<string, unknown>} */ (plan);
  if (typeof candidate.upstream !== 'string' || !NAME.test(candidate.upstream)) problems.push('upstream must be owner/name');
  if (typeof candidate.title !== 'string' || candidate.title.trim() === '') problems.push('title must be a non-empty string');
  if (typeof candidate.body !== 'string' || candidate.body.trim() === '') problems.push('body must be a non-empty string');
  if (candidate.base !== undefined && (typeof candidate.base !== 'string' || candidate.base === '')) problems.push('base must be a branch name when given');
  if (candidate.branch !== undefined && (typeof candidate.branch !== 'string' || candidate.branch === '')) problems.push('branch must be a branch name when given');
  const edits = candidate.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    problems.push('edits must be a non-empty array');
    return problems;
  }
  const seen = new Set();
  for (const [index, edit] of edits.entries()) {
    const at = `edits[${index}]`;
    if (edit === null || typeof edit !== 'object') {
      problems.push(`${at} must be an object`);
      continue;
    }
    const item = /** @type {Record<string, unknown>} */ (edit);
    for (const key of ['path', 'after', 'insert']) {
      if (typeof item[key] !== 'string' || String(item[key]).trim() === '') problems.push(`${at}.${key} must be a non-empty string`);
    }
    if (typeof item.path === 'string') {
      if (seen.has(item.path)) problems.push(`${at}.path repeats ${item.path}; one edit per file, because each one rewrites the whole file`);
      seen.add(item.path);
    }
    if (typeof item.insert === 'string' && !ENTRY.test(item.insert.trim())) {
      problems.push(`${at}.insert is not a list entry: expected "- [owner/repo](https://github.com/owner/repo) - Description ending with a period."`);
    }
  }
  return problems;
}

/**
 * Insert a line under an anchor, refusing to guess when the anchor is not unique.
 * @param {string} text the file as it currently is
 * @param {Edit} edit
 * @returns {{ok: boolean, text: string, problem: string}}
 */
/**
 * Insert a line under an anchor, refusing to guess when the anchor is not unique.
 *
 * An anchor may be a whole line or a distinctive fragment of one (a list entry is a paragraph).
 * A fragment is only usable when it lands on exactly one line.
 * @param {string} text the file as it currently is
 * @param {Edit} edit
 * @returns {{ok: boolean, text: string, problem: string}}
 */
export function applyEdit(text, edit) {
  const lines = text.split('\n');
  let hits = [];
  for (const [index, line] of lines.entries()) {
    if (line === edit.after) hits.push(index);
  }
  if (hits.length === 0) {
    for (const [index, line] of lines.entries()) {
      if (line.includes(edit.after)) hits.push(index);
    }
    if (hits.length === 1) return insertUnder(lines, hits[0], edit);
  }
  if (hits.length === 0) return { ok: false, text, problem: 'the anchor line is not in ' + edit.path + ': ' + edit.after.slice(0, 80) };
  if (hits.length > 1) return { ok: false, text, problem: 'the anchor matches ' + hits.length + ' lines in ' + edit.path + '; refusing to guess which one' };
  return insertUnder(lines, hits[0], edit);
}

/**
 * Put the new line directly under the anchor, refusing to add it twice.
 * @param {string[]} lines
 * @param {number} index
 * @param {Edit} edit
 * @returns {{ok: boolean, text: string, problem: string}}
 */
function insertUnder(lines, index, edit) {
  const insert = edit.insert.trimEnd();
  if (lines.includes(insert)) return { ok: false, text: lines.join('\n'), problem: 'the entry is already in ' + edit.path };
  lines.splice(index + 1, 0, insert);
  return { ok: true, text: lines.join('\n'), problem: '' };
}

/**
 * The owner and repository a list entry names, so a submission can be checked against the
 * repository it is supposed to describe.
 * @param {string} entry
 * @returns {{name: string, url: string, description: string} | null}
 */
export function parseEntry(entry) {
  const match = ENTRY.exec(entry.trim());
  if (match === null) return null;
  return { name: match[1], url: match[2], description: match[3] };
}
