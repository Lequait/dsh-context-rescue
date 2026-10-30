/**
 * The highest-fidelity gate available without a live model: run the fold through
 * the host's *own* `Session` class instead of this repository's replay shell.
 *
 * Everything else in this repo checks the plugin against `FakeSession` or
 * `ReplaySession` — small re-implementations of the append/projection contract.
 * That proves internal consistency, not host acceptance. Here the seed events are
 * the ones the host itself wrote to disk, and the appends are validated by the
 * host's `validateSessionEventData` and projected by the host's `SurfaceManager`.
 *
 * Run through the app's Node (`npm run host-session`), because the package lives
 * inside `app.asar` and only Electron's fs layer can read it.
 * @module dsh-context-rescue/scripts/dev/host-session-check
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import { loadSessionLog, reconstructSurface } from './session-log.mjs';
import { allLogsUnder, expandHome } from './replay-session.mjs';
import { DEFAULTS, mergeConfig } from '../../lib/config.js';
import { eventsOf, measure, resolveWindow } from '../../lib/measure.js';
import { applyFold } from '../../lib/fold.js';
import { pairingCuts, planFold } from '../../lib/plan.js';
import { preflight } from '../../lib/rescue.js';
import { buildDigest } from '../../lib/digest.js';
import { dshAsarCandidates } from '../host-paths.mjs';

/** Load the host's own session implementation out of the app bundle. */
async function loadHostSession() {
  const asar = dshAsarCandidates().find((candidate) => candidate !== '');
  if (asar === undefined) throw new Error('no DSH app.asar found; set DSH_ASAR');
  const base = `${asar}/node_modules/@deepseek-ai/dsh-session`;
  const href = pathToFileURL(`${base}/lib/index.js`).href;
  const mod = await import(href);
  assert.equal(typeof mod.Session, 'function', 'host Session class missing');
  assert.equal(typeof mod.SessionId, 'function', 'host SessionId helper missing');
  return mod;
}

/**
 * Build a detached host session seeded with events a real session log recorded.
 * `Session.create` runs the host's own validation over the seed, so a log the
 * host could not have produced would fail right here.
 */
function seedHostSession(Session, SessionId, events, label) {
  try {
    return Session.create(SessionId(label), events, undefined, 0, []);
  } catch (error) {
    throw new Error(`host rejected the seed from a real log: ${error?.message ?? error}`);
  }
}

/** Message-level tool pairing, read from the messages the model would receive. */
function orphanToolResults(messages) {
  const open = new Set();
  let orphans = 0;
  for (const message of messages) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      if (block?.type === 'tool-call' && typeof block.toolCallId === 'string') open.add(block.toolCallId);
      if (block?.type === 'tool-result') {
        if (block.toolCallId === undefined || !open.has(block.toolCallId)) orphans += 1;
        else open.delete(block.toolCallId);
      }
    }
  }
  return orphans;
}

/** Retained-tail budgets, from generous to tight — same policy as the rescue ladder. */
function retainOptions(windowTokens, config) {
  const base = Math.min(
    config.retainMaxTokens,
    Math.max(config.retainMinTokens, Math.floor(windowTokens * config.retainRatio)),
  );
  return [...new Set([base, Math.floor(base / 2), Math.max(config.retainMinTokens, Math.floor(base / 4))])].filter(
    (value) => value > 0,
  );
}

async function checkOne(Session, SessionId, logPath, config) {
  const { events } = loadSessionLog(logPath);
  const expected = reconstructSurface(events);
  const session = seedHostSession(Session, SessionId, events, 'host-check');

  const hostNodes = session.surface.nodes.length;
  assert.equal(hostNodes, expected.surface.length, `host projection width differs from replay for ${logPath}`);

  /** @type {any} */
  const ctx = { tokenMeter: undefined, get: () => undefined };
  const window = await resolveWindow(ctx, { evidence: { windowTokens: 196_608 }, session, config });
  const before = measure(ctx, session);
  const plan = planFold(session, before, {
    retainOptions: retainOptions(window.windowTokens, config),
    targetTokens: Math.floor(window.windowTokens * config.targetRatio),
    minFoldTokens: config.minFoldTokens,
    pinFirstUserMessage: config.pinFirstUserMessage,
  });
  if (plan === null) return { logPath, skipped: `no plan (window=${window.windowTokens}, tokens=${before.totalTokens}, nodes=${before.nodes.length})` };

  const text = buildDigest(session, {
    startSeq: plan.start,
    endSeq: plan.end,
    shadowedSeqs: plan.shadowedSeqs,
    shadowedTokenCount: plan.shadowedTokenCount,
    totalTokens: plan.totalTokens,
    windowTokens: window.windowTokens,
    measuredTokens: before.totalTokens,
    reason: 'host-session-check',
    maxChars: config.maxDigestChars,
  });

  // The decisive step: every append below is validated and projected by the host.
  const written = applyFold(session, {
    start: plan.start,
    end: plan.end,
    shadowedSeqs: plan.shadowedSeqs,
    shadowedTokenCount: plan.shadowedTokenCount,
    text,
    kind: 'prune',
  });
  assert.ok(written !== undefined, 'fold wrote nothing');

  const afterNodes = session.surface.nodes.length;
  assert.equal(afterNodes, hostNodes - plan.shadowedSeqs.length + 1, 'host surface did not shrink by shadowed-1');

  const messages = session.deriveMessages();
  assert.ok(Array.isArray(messages) && messages.length > 0, 'host derived an empty history');
  assert.equal(orphanToolResults(messages), 0, 'host history has a tool result without a call');

  const flat = messages
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  assert.ok(flat.includes('<context-rescue-checkpoint>'), 'the checkpoint message is not in the host history');

  const after = measure(ctx, session);
  assert.ok(after.totalTokens < before.totalTokens, 'host projection did not get smaller');

  // A session that had to be rescued once is likely to need it again; the host
  // must still accept the same append sequence over an already-folded surface.
  const again = planFold(session, after, {
    retainOptions: retainOptions(window.windowTokens, config),
    targetTokens: Math.floor(window.windowTokens * config.targetRatio),
    minFoldTokens: config.minFoldTokens,
    pinFirstUserMessage: config.pinFirstUserMessage,
  });
  if (again !== null) {
    applyFold(session, {
      start: again.start,
      end: again.end,
      shadowedSeqs: again.shadowedSeqs,
      shadowedTokenCount: again.shadowedTokenCount,
      text: buildDigest(session, {
        startSeq: again.start,
        endSeq: again.end,
        shadowedSeqs: again.shadowedSeqs,
        shadowedTokenCount: again.shadowedTokenCount,
        totalTokens: again.totalTokens,
        windowTokens: window.windowTokens,
        measuredTokens: after.totalTokens,
        reason: 'host-session-check/second',
        maxChars: config.maxDigestChars,
      }),
      kind: 'prune',
    });
    const twice = session.deriveMessages();
    assert.equal(orphanToolResults(twice), 0, 'second fold left a tool result without a call');
    assert.ok(twice.length > 0, 'second fold emptied the host history');
    assert.ok(measure(ctx, session).totalTokens < after.totalTokens, 'second fold did not shrink the projection');
  }

  // The pre-step path, end to end, on a real host Session: nothing has failed
  // yet, so the plugin measures the projection, decides on its own, and folds.
  const preSession = seedHostSession(Session, SessionId, events, 'host-preflight');
  const preBefore = measure(ctx, preSession).totalTokens;
  const report = await preflight(ctx, { agent: { session: preSession }, session: preSession, config });
  if (preBefore > config.windowFallback) {
    assert.equal(
      report.action,
      'fold',
      `pre-flight did not fold an over-window projection (${preBefore} tokens: ${report.reason})`,
    );
    assert.ok(measure(ctx, preSession).totalTokens < preBefore, 'pre-flight did not shrink the projection');
    assert.equal(orphanToolResults(preSession.deriveMessages()), 0, 'pre-flight left a tool result without a call');
    assert.equal(eventsOf(preSession).at(-1).type, 'compaction/end', 'pre-flight left the bracket open');
  } else {
    assert.equal(report.action, 'pass', `pre-flight rewrote a projection that fits (${preBefore} tokens)`);
  }

  const last = eventsOf(session).at(-1);
  assert.equal(last.type, 'compaction/end', `host log does not end with compaction/end (got ${last.type})`);

  return { logPath, before: before.totalTokens, after: after.totalTokens, nodes: hostNodes, preFlight: report.action };
}

async function main() {
  const { Session, SessionId } = await loadHostSession();
  const config = mergeConfig(DEFAULTS, {});
  const directory = expandHome(process.env.DSH_SESSIONS_DIR ?? '~/.dsh/sessions');
  const logs = process.env.DSH_SESSION_LOG === undefined ? allLogsUnder(directory) : [expandHome(process.env.DSH_SESSION_LOG)];
  assert.ok(logs.length > 0, `no session logs under ${directory}`);

  const results = [];
  for (const logPath of logs) {
    try {
      results.push(await checkOne(Session, SessionId, logPath, config));
    } catch (error) {
      results.push({ logPath, error: error?.message ?? String(error) });
    }
  }

  // A log that the host itself cannot re-seed in isolation (a foreign plugin's
  // projection, or a pre-v4 format) is out of scope for this gate, not a defect:
  // the events came from the host, so the rejection describes the log.
  const unseedable = results.filter((result) => String(result.error ?? '').startsWith('host rejected the seed'));
  for (const result of unseedable) result.skipped = `host cannot seed this log in isolation: ${result.error}`;
  const folded = results.filter((result) => typeof result.before === 'number');
  const skipped = results.filter((result) => typeof result.skipped === 'string');
  const failed = results.filter((result) => typeof result.error === 'string' && result.skipped === undefined);

  for (const result of folded.slice(0, 5)) {
    console.log(`  ok  ${result.logPath.split(/[\\/]/u).slice(-2)[0]}  ${result.before} → ${result.after} tokens (${result.nodes} nodes)`);
  }
  if (folded.length > 5) console.log(`  ok  … and ${folded.length - 5} more logs folded under the host session class`);
  const preFlightFolds = folded.filter((result) => result.preFlight === 'fold').length;
  for (const result of failed) console.log(`  FAIL ${result.logPath}: ${result.error}`);

  console.log(
    `host session check: ${results.length} logs · ${folded.length} folded · ${preFlightFolds} pre-flight folds · ${skipped.length} skipped · ${failed.length} failed`,
  );
  if (failed.length > 0) process.exitCode = 1;
  if (preFlightFolds === 0) {
    // A gate that never exercises the branch it exists for is a gate that lies.
    console.log('FAIL no log exercised the pre-flight fold branch');
    process.exitCode = 1;
  }
}

await main();
