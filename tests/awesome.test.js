/**
 * The listing rules, driven directly: the clock gate, the required topic, and the shape of the
 * data file the list reads. These run offline because the alternative is discovering the rules are
 * wrong when a machine closes the pull request.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CATEGORIES, eligibility, entryPathFor, entryProblems } from '../scripts/dev/awesome-plan.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPO = 'Lequait/dsh-context-rescue';
const DAY = 24 * 60 * 60 * 1000;

/** A repository created `hours` ago with a healthy topic list. */
function repoCreatedHoursAgo(hours, topics = ['dsh-plugin']) {
  return { createdAt: new Date(Date.now() - hours * 3_600_000).toISOString(), topics };
}

test('the entry path keeps the case of both names', () => {
  assert.equal(entryPathFor(REPO), 'data/plugins/Lequait__dsh-context-rescue.yml');
});

test('a repository younger than a day is refused, with the moment it opens', () => {
  const gate = eligibility(repoCreatedHoursAgo(12));
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.problems.map((problem) => problem.code), ['too-young']);
  assert.match(gate.problems[0].message, /accepts it from \d{4}-\d{2}-\d{2}T/u);
  assert.ok(gate.ageHours > 11 && gate.ageHours < 13, `ageHours was ${gate.ageHours}`);
});

test('a repository exactly a day old is accepted', () => {
  const created = new Date(Date.now() - DAY).toISOString();
  const gate = eligibility({ createdAt: created, topics: ['dsh-plugin'] }, Date.now());
  assert.equal(gate.ok, true, gate.problems.map((problem) => problem.message).join('; '));
});

test('a repository without the topic is refused before the clock matters', () => {
  const gate = eligibility(repoCreatedHoursAgo(30, ['deepseek-harness']));
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.problems.map((problem) => problem.code), ['missing-topic']);
});

test('an unreadable creation time is refused rather than guessed', () => {
  const gate = eligibility({ createdAt: 'yesterday-ish', topics: ['dsh-plugin'] });
  assert.equal(gate.ok, false);
  assert.ok(gate.problems.some((problem) => problem.code === 'unreadable-created-at'));
  assert.ok(Number.isNaN(gate.ageHours));
});

test('the entry this repository would submit passes the list rules', () => {
  const text = readFileSync(path.join(ROOT, 'docs', 'awesome-entry.yml'), 'utf8');
  assert.deepEqual(entryProblems(text, REPO), []);
});

test('a category outside the list is caught before the pull request', () => {
  const text = readFileSync(path.join(ROOT, 'docs', 'awesome-entry.yml'), 'utf8').replace('category: session', 'category: context');
  const problems = entryProblems(text, REPO);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /category "context" is not one of/u);
  assert.ok(CATEGORIES.includes('session'), 'session is an accepted category');
});

test('an entry with no English description is caught, because the list requires one', () => {
  const text = [
    'url: https://github.com/Lequait/dsh-context-rescue',
    'name: Lequait/dsh-context-rescue',
    'category: session',
    'description:',
    '  zh: 只写了中文',
    '',
  ].join('\n');
  const problems = entryProblems(text, REPO);
  assert.ok(problems.some((problem) => /needs at least an en:/u.test(problem)), problems.join('; '));
});

test('an entry describing another repository is caught', () => {
  const text = readFileSync(path.join(ROOT, 'docs', 'awesome-entry.yml'), 'utf8').replace('name: Lequait/dsh-context-rescue', 'name: someone/else');
  const problems = entryProblems(text, REPO);
  assert.ok(problems.some((problem) => /but this repository is/u.test(problem)), problems.join('; '));
});
