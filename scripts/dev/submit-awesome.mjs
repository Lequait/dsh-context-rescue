#!/usr/bin/env node
/**
 * Submit the listing entry to awesome-dsh-plugin, which asks for a data file
 * rather than a README line: `data/plugins/<owner>__<repo>.yml`.
 *
 * The list enforces that the repository is at least a day old, so this script
 * checks the clock first and refuses to waste a PR on a repository the CI would
 * reject. Everything it does is idempotent: an existing fork, an existing
 * branch and an existing open pull request are reused instead of duplicated.
 *
 * Usage:
 *   node scripts/dev/submit-awesome.mjs --dry-run
 *   node scripts/dev/submit-awesome.mjs
 *
 * The token comes from the git credential helper, never from an argument, and
 * is never printed.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin';
const REPO = 'Lequait/dsh-context-rescue';
const BASE = 'main';
const BRANCH = 'add-dsh-context-rescue';
const ENTRY_PATH = `data/plugins/${REPO.replace('/', '__')}.yml`;
const API = 'https://api.github.com';

const dryRun = process.argv.includes('--dry-run');

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

const TOKEN = token();

/**
 * @param {string} method
 * @param {string} route
 * @param {unknown} [body]
 */
async function api(method, route, body) {
	const response = await fetch(`${API}${route}`, {
		method,
		headers: {
			authorization: `token ${TOKEN}`,
			accept: 'application/vnd.github+json',
			'user-agent': 'dsh-context-rescue-submit',
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
	const entry = readFileSync(path.join(ROOT, 'docs', 'awesome-entry.yml'), 'utf8');

	const repo = await api('GET', `/repos/${REPO}`);
	if (!repo.ok) throw new Error(`cannot read ${REPO}: HTTP ${repo.status}`);
	const created = Date.parse(repo.body.created_at);
	const eligibleAt = created + 24 * 60 * 60 * 1000;
	const now = Date.now();
	const ageHours = (now - created) / 3600000;

	console.log(`repository   ${REPO}`);
	console.log(`created      ${repo.body.created_at} (${ageHours.toFixed(1)} h ago)`);
	console.log(`topics       ${(repo.body.topics ?? []).join(', ') || '(none)'}`);
	console.log(`entry        ${ENTRY_PATH} (${entry.split('\n').length} lines from docs/awesome-entry.yml)`);

	const problems = [];
	if (!(repo.body.topics ?? []).includes('dsh-plugin')) problems.push('the repository has no dsh-plugin topic');
	if (ageHours < 24) problems.push(`the repository is younger than a day; the listing accepts it from ${new Date(eligibleAt).toISOString()}`);
	if (problems.length > 0) {
		for (const problem of problems) console.error(`refuse: ${problem}`);
		process.exitCode = 2;
		return;
	}

	const existing = await api('GET', `/repos/${UPSTREAM}/pulls?state=open&head=Lequait:${BRANCH}`);
	const already = (existing.body ?? []).find((pull) => pull.head?.ref === BRANCH);
	if (already !== undefined) {
		console.log(`an open pull request already exists: ${already.html_url}`);
		return;
	}

	if (dryRun) {
		console.log('dry run: would fork, write the entry and open a pull request');
		console.log(`  POST /repos/${UPSTREAM}/forks`);
		console.log(`  PUT  /repos/Lequait/awesome-dsh-plugin/contents/${ENTRY_PATH} (branch ${BRANCH})`);
		console.log(`  POST /repos/${UPSTREAM}/pulls  head=Lequait:${BRANCH} base=${BASE}`);
		return;
	}

	const fork = await api('POST', `/repos/${UPSTREAM}/forks`);
	if (!fork.ok && fork.status !== 202) console.log(`fork answered HTTP ${fork.status}; continuing (it may already exist)`);
	const forkRepo = `Lequait/${UPSTREAM.split('/')[1]}`;
	await waitFor(`/repos/${forkRepo}`);

	const baseSha = (await api('GET', `/repos/${UPSTREAM}/git/ref/heads/${BASE}`)).body.object.sha;
	const branchRef = await api('GET', `/repos/${forkRepo}/git/ref/heads/${BRANCH}`);
	if (branchRef.ok) {
		console.log(`branch ${BRANCH} already exists on the fork; reusing it`);
	} else {
		const created2 = await api('POST', `/repos/${forkRepo}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: baseSha });
		if (!created2.ok) throw new Error(`cannot create the branch: HTTP ${created2.status} ${JSON.stringify(created2.body)}`);
	}

	const current = await api('GET', `/repos/${forkRepo}/contents/${ENTRY_PATH}?ref=${BRANCH}`);
	const put = await api('PUT', `/repos/${forkRepo}/contents/${ENTRY_PATH}`, {
		message: 'Add dsh-context-rescue to the listings',
		content: Buffer.from(entry, 'utf8').toString('base64'),
		branch: BRANCH,
		...(current.ok ? { sha: current.body.sha } : {}),
	});
	if (!put.ok) throw new Error(`cannot write the entry: HTTP ${put.status} ${JSON.stringify(put.body)}`);

	const pull = await api('POST', `/repos/${UPSTREAM}/pulls`, {
		title: 'Add dsh-context-rescue',
		head: `Lequait:${BRANCH}`,
		base: BASE,
		body: [
			'Adds a listing entry for [dsh-context-rescue](https://github.com/Lequait/dsh-context-rescue).',
			'',
			'It rescues a session that is already over the model window: it detects the refusal, folds',
			'the oldest span into a checkpoint with no model call, retries once, and reports what it did',
			'through `/rescue` and `/rescue-status`.',
			'',
			`Entry file: \`${ENTRY_PATH}\`.`,
		].join('\n'),
	});
	if (!pull.ok) throw new Error(`cannot open the pull request: HTTP ${pull.status} ${JSON.stringify(pull.body)}`);
	console.log(`opened ${pull.body.html_url}`);
}

main().catch((error) => {
	console.error(`submit-awesome FAILED: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
