/**
 * The listing pull request, decided offline: which line goes where, and the ways it must refuse.
 *
 * The two failures that matter are subtle — an entry landing in the wrong category because the
 * anchor was a fragment that matched several lines, and the same entry added twice — so both are
 * refused rather than guessed at.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEdit, parseEntry, validatePlan } from '../scripts/dev/list-plan.mjs';

const ENTRY = '- [Lequait/dsh-context-rescue](https://github.com/Lequait/dsh-context-rescue) - Rescues a refused session.';

/** A minimal plan that passes validation; tests override one field at a time. */
function plan(overrides = {}) {
  return {
    upstream: 'someone/awesome-dsh-plugins',
    title: 'Add dsh-context-rescue',
    body: 'Adds one entry.',
    edits: [{ path: 'README.md', after: '- [lamost423/dsh-maze](https://github.com/lamost423/dsh-maze) - Maze.', insert: ENTRY }],
    ...overrides,
  };
}

const README = [
  '# Awesome',
  '',
  '### Sessions',
  '- [lamost423/dsh-maze](https://github.com/lamost423/dsh-maze) - Maze.',
  '- [Moeblack/dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) - Editing.',
  '',
].join('\n');

test('a plan needs an upstream, a title, a body and at least one edit', () => {
  assert.deepEqual(validatePlan(plan()), []);
  assert.ok(validatePlan(plan({ upstream: 'not-a-repo' })).some((problem) => problem.includes('upstream')));
  assert.ok(validatePlan(plan({ title: '  ' })).some((problem) => problem.includes('title')));
  assert.ok(validatePlan(plan({ body: '' })).some((problem) => problem.includes('body')));
  assert.ok(validatePlan(plan({ edits: [] })).some((problem) => problem.includes('edits')));
});

test('a plan may not edit the same file twice', () => {
  const problems = validatePlan(plan({ edits: [plan().edits[0], plan().edits[0]] }));
  assert.ok(problems.some((problem) => problem.includes('repeats README.md')), problems.join('; '));
});

test('an insertion has to look like a list entry', () => {
  const problems = validatePlan(plan({ edits: [{ path: 'README.md', after: '- [x/y]', insert: 'just a sentence' }] }));
  assert.ok(problems.some((problem) => problem.includes('is not a list entry')), problems.join('; '));
});

test('the entry goes directly under its anchor', () => {
  const result = applyEdit(README, { path: 'README.md', after: '- [lamost423/dsh-maze](https://github.com/lamost423/dsh-maze) - Maze.', insert: ENTRY });
  assert.equal(result.ok, true, result.problem);
  const lines = result.text.split('\n');
  assert.equal(lines[3], '- [lamost423/dsh-maze](https://github.com/lamost423/dsh-maze) - Maze.');
  assert.equal(lines[4], ENTRY);
  assert.equal(lines[5], '- [Moeblack/dsh-message-edit](https://github.com/Moeblack/dsh-message-edit) - Editing.');
});

test('a fragment anchor is used when it lands on exactly one line', () => {
  const result = applyEdit(README, { path: 'README.md', after: '- [lamost423/dsh-maze]', insert: ENTRY });
  assert.equal(result.ok, true, result.problem);
  assert.ok(result.text.includes(`- [lamost423/dsh-maze](https://github.com/lamost423/dsh-maze) - Maze.\n${ENTRY}`));
});

test('an ambiguous anchor is refused instead of guessed', () => {
  const ambiguous = `${README}- [lamost423/other](https://github.com/lamost423/other) - Another.\n`;
  const result = applyEdit(ambiguous, { path: 'README.md', after: '- [lamost423/', insert: ENTRY });
  assert.equal(result.ok, false);
  assert.match(result.problem, /matches 2 lines/u);
  assert.equal(result.text, ambiguous, 'a refused edit leaves the file alone');
});

test('a missing anchor is refused', () => {
  const result = applyEdit(README, { path: 'README.md', after: '- [nobody/here]', insert: ENTRY });
  assert.equal(result.ok, false);
  assert.match(result.problem, /is not in README.md/u);
});

test('the same entry is not added twice', () => {
  const withEntry = README.replace('- [Moeblack', `${ENTRY}\n- [Moeblack`);
  const result = applyEdit(withEntry, { path: 'README.md', after: '- [lamost423/dsh-maze]', insert: ENTRY });
  assert.equal(result.ok, false);
  assert.match(result.problem, /already in README.md/u);
});

test('an entry is parsed back into the name it claims to describe', () => {
  assert.deepEqual(parseEntry(ENTRY), {
    name: 'Lequait/dsh-context-rescue',
    url: 'https://github.com/Lequait/dsh-context-rescue',
    description: 'Rescues a refused session.',
  });
  assert.equal(parseEntry('- not an entry'), null);
});
