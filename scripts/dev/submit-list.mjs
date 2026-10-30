#!/usr/bin/env node
/**
 * Open a listing pull request from a plan file, without cloning anything.
 *
 * A plan says which list, which branch, and one insertion per file: the new line goes directly
 * under an anchor line that already exists. The plan is validated offline first
 * (`scripts/dev/list-plan.mjs`), and the anchor must appear exactly once, so the two ways this
 * normally goes wrong — a line landing in the wrong category, or the same entry twice — are caught
 * before a fork is created.
 *
 * Usage:
 *   node scripts/dev/submit-list.mjs --plan market/listings/beancookie.json --dry-run
 *   node scripts/dev/submit-list.mjs --plan market/listings/beancookie.json
 *
 * The token comes from the git credential helper, never from an argument, and is never printed.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { applyEdit, parseEntry, validatePlan } from './list-plan.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const API = 'https://api.github.com';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : String(argv[index + 1] ?? fallback);
};
const dryRun = argv.includes('--dry-run');
const planPath = argOf('plan', '');
if (planPath === '') {
  console.error('submit-list needs --plan <file.json>');
  process.exit(2);
}

/** @param {string} file */
function readPlan(file) {
  return JSON.parse(readFileSync(path.resolve(ROOT, file), 'utf8'));
}

function token() {
  const filled = execFileSync('git', ['credential', 'fill'], {
    cwd: ROOT,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
  });
  const match = /^password=(.*)$/mu.exec(filled);
  if (match === null) throw new Error('the credential helper has no token for github.com');
  return match[1].trim();
}

/**
 * @param {string} method
 * @param {string} route
 * @param {unknown} [body]
 */
async function api(method, route, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: {
      authorization: `token ${token()}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-context-rescue-submit-list',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

/** Retry a GET until it stops returning 404, or give up. */
async function waitFor(route, attempts = 20, delayMs = 1500) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await api('GET', route);
    if (response.ok) return response.body;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`gave up waiting for ${route}`);
}

async function main() {
  const plan = readPlan(planPath);
  const problems = validatePlan(plan);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`refuse: ${problem}`);
    process.exitCode = 2;
    return;
  }
  const upstream = plan.upstream;
  const base = plan.base ?? 'main';
  const branch = plan.branch ?? 'add-dsh-context-rescue';

  for (const edit of plan.edits) {
    const entry = parseEntry(edit.insert);
    if (entry === null) continue;
    console.log(`entry        ${entry.name} -> ${entry.url}`);
  }
  console.log(`list         ${upstream} (base ${base}, branch ${branch})`);
  console.log(`edits        ${plan.edits.map((edit) => edit.path).join(', ')}`);

  const forkOwner = 'Lequait';
  const forkName = upstream.split('/')[1];
  const forkRepo = `${forkOwner}/${forkName}`;

  const existing = await api('GET', `/repos/${upstream}/pulls?state=open&head=${forkOwner}:${branch}`);
  const already = (existing.body ?? []).find((pull) => pull.head?.ref === branch);
  if (already !== undefined) {
    console.log(`an open pull request already exists: ${already.html_url}`);
    return;
  }

  /** @type {Array<{edit: any, before: string, after: string}>} */
  const changes = [];
  for (const edit of plan.edits) {
    const current = await api('GET', `/repos/${upstream}/contents/${edit.path}?ref=${base}`);
    if (!current.ok) throw new Error(`cannot read ${upstream}/${edit.path}: HTTP ${current.status}`);
    const before = Buffer.from(current.body.content, 'base64').toString('utf8');
    const applied = applyEdit(before, edit);
    if (!applied.ok) {
      console.error(`refuse: ${applied.problem}`);
      process.exitCode = 2;
      return;
    }
    changes.push({ edit, before, after: applied.text });
  }

  if (dryRun) {
    console.log('dry run: would fork, write each edit on the branch and open a pull request');
    for (const change of changes) console.log(`  ${change.edit.path}: +1 line, ${change.after.split('\n').length} lines after the insert`);
    return;
  }

  const fork = await api('POST', `/repos/${upstream}/forks`);
  if (!fork.ok && fork.status !== 202) console.log(`fork answered HTTP ${fork.status}; continuing (it may already exist)`);
  const forkInfo = await waitFor(`/repos/${forkRepo}`);
  // One account can only hold one fork of a given repository *name*. If a fork with this name
  // already points at a different upstream, every later write fails with an unhelpful 422.
  const forkParent = forkInfo?.parent?.full_name;
  if (typeof forkParent === 'string' && forkParent.toLowerCase() !== upstream.toLowerCase()) {
    throw new Error(
      `a fork named ${forkRepo} already exists for ${forkParent}; GitHub allows one fork per repository name, ` +
        `so this list has to be submitted from a different account or by putting the edit on a branch of the existing fork`,
    );
  }
  // A fresh fork answers 422 "Object does not exist" until its default branch exists, so wait for
  // the ref itself rather than for the repository object.
  await waitFor(`/repos/${forkRepo}/git/ref/heads/${base}`);

  const baseSha = (await api('GET', `/repos/${upstream}/git/ref/heads/${base}`)).body.object.sha;
  const branchRef = await api('GET', `/repos/${forkRepo}/git/ref/heads/${branch}`);
  if (branchRef.ok) {
    console.log(`branch ${branch} already exists on the fork; reusing it`);
  } else {
    let created = await api('POST', `/repos/${forkRepo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
    for (let attempt = 0; attempt < 5 && !created.ok && created.status === 422; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      created = await api('POST', `/repos/${forkRepo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
    }
    if (!created.ok) throw new Error(`cannot create the branch: HTTP ${created.status} ${JSON.stringify(created.body)}`);
  }

  for (const change of changes) {
    const current = await api('GET', `/repos/${forkRepo}/contents/${change.edit.path}?ref=${branch}`);
    const put = await api('PUT', `/repos/${forkRepo}/contents/${change.edit.path}`, {
      message: change.edit.message ?? `Add ${plan.title}`,
      content: Buffer.from(change.after, 'utf8').toString('base64'),
      branch,
      ...(current.ok ? { sha: current.body.sha } : {}),
    });
    if (!put.ok) throw new Error(`cannot write ${change.edit.path}: HTTP ${put.status} ${JSON.stringify(put.body)}`);
    console.log(`wrote        ${change.edit.path}`);
  }

  const pull = await api('POST', `/repos/${upstream}/pulls`, {
    title: plan.title,
    head: `${forkOwner}:${branch}`,
    base,
    body: plan.body,
  });
  if (!pull.ok) throw new Error(`cannot open the pull request: HTTP ${pull.status} ${JSON.stringify(pull.body)}`);
  console.log(`opened ${pull.body.html_url}`);
}

main().catch((error) => {
  console.error(`submit-list FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
