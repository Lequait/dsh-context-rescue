/**
 * The decisions `submit-awesome.mjs` makes, separated from the network calls that act on them.
 *
 * The listing (`awesome-dsh-plugin/awesome-dsh-plugin`) stopped accepting README lines; it takes a
 * data file per plugin and its CI checks the clock, the topic and the file shape. Getting that wrong
 * costs a pull request that is rejected by a machine minutes after it is opened, so the rules live
 * here where a test can drive them instead of only inside a script that needs a live repository.
 *
 * @module dsh-context-rescue/scripts/dev/awesome-plan
 */

/** The categories the list accepts, from its `contributing.md`. */
export const CATEGORIES = [
  'agi',
  'ui',
  'usage',
  'theme',
  'model',
  'identity',
  'session',
  'memory',
  'tools',
  'wsl',
  'browser',
  'vision',
  'voice',
  'docs',
  'skill',
  'workflow',
  'git',
  'notify',
  'dev',
  'security',
  'remote',
  'market',
  'fun',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The path the list expects for this repository's entry, preserving the case of both names.
 * @param {string} repo `owner/name`
 * @returns {string}
 */
export function entryPathFor(repo) {
  return `data/plugins/${repo.replace('/', '__')}.yml`;
}

/**
 * Whether the repository may be listed yet, and why not when it may not.
 * @param {{createdAt: string, topics?: string[]}} repo
 * @param {number} [now] milliseconds since the epoch
 * @returns {{ok: boolean, ageHours: number, eligibleAt: string, problems: Array<{code: string, message: string}>}}
 */
export function eligibility(repo, now = Date.now()) {
  const created = Date.parse(repo.createdAt);
  const problems = [];
  if (Number.isNaN(created)) problems.push({ code: 'unreadable-created-at', message: `cannot read the creation time "${repo.createdAt}"` });
  const ageMs = Number.isNaN(created) ? Number.NaN : now - created;
  const topics = repo.topics ?? [];
  if (!topics.includes('dsh-plugin')) {
    problems.push({ code: 'missing-topic', message: 'the repository has no dsh-plugin topic; the list requires it' });
  }
  if (!Number.isNaN(created) && ageMs < DAY_MS) {
    const eligibleAt = new Date(created + DAY_MS).toISOString();
    problems.push({ code: 'too-young', message: `the repository is younger than a day; the list accepts it from ${eligibleAt}` });
  }
  return {
    ok: problems.length === 0,
    ageHours: Number.isNaN(ageMs) ? Number.NaN : ageMs / 3_600_000,
    eligibleAt: Number.isNaN(created) ? '' : new Date(created + DAY_MS).toISOString(),
    problems,
  };
}

/**
 * The rules the entry file itself has to satisfy. Flat YAML on purpose: the list reads a handful of
 * keys, and a nested structure that only looks right is how a submission fails a schema check.
 * @param {string} text the contents of the entry file
 * @param {string} [repo] the repository it is supposed to describe, as `owner/name`
 * @returns {string[]} one sentence per problem; empty when the file is acceptable
 */
export function entryProblems(text, repo = '') {
  const problems = [];
  const read = (key) => {
    const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'mu').exec(text);
    return match === null ? undefined : match[1].trim();
  };
  const url = read('url');
  if (url === undefined || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/u.test(url)) {
    problems.push('url must be a plain https://github.com/owner/name address');
  }
  const name = read('name');
  if (name === undefined || !/^[^/\s]+\/[^/\s]+$/u.test(name)) {
    problems.push('name must be owner/name');
  } else if (repo !== '' && name !== repo) {
    problems.push(`name is "${name}" but this repository is "${repo}"`);
  }
  const category = read('category');
  if (category === undefined || !CATEGORIES.includes(category)) {
    problems.push(`category "${category ?? ''}" is not one of ${CATEGORIES.join(', ')}`);
  }
  if (!/^description:[ \t]*$/mu.test(text) || !/^[ \t]+en:/mu.test(text)) {
    problems.push('description needs at least an en: block (the list requires English even when zh is present)');
  }
  return problems;
}
