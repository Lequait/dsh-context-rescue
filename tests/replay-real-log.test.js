/**
 * End-to-end replay against a log captured from a real session.
 *
 * Point DSH_SESSION_LOG at a `session.v4.jsonl.zstd` to run it:
 *
 *     DSH_SESSION_LOG=~/.dsh/sessions/--H-AI--/<id>/session.v4.jsonl.zstd node --test
 *
 * The test is skipped when the variable is unset, so the suite stays portable.
 * What it proves is the part unit fixtures cannot: that the planner's pairing
 * model agrees with the host on a surface built from thousands of real events,
 * and that a fold written into that surface survives the host's own invariants.
 * @module dsh-context-rescue/tests/replay-real-log
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';

import { ReplaySession, expandHome, newestUnder } from '../scripts/dev/replay-session.mjs';

import { loadSessionLog, reconstructSurface, supportsZstd } from '../scripts/dev/session-log.mjs';
import { measure } from '../lib/measure.js';
import { applyFold } from '../lib/fold.js';
import { hasOpenCompactionTransaction, pairingCuts, planFold } from '../lib/plan.js';
import { resolveConfig } from '../lib/config.js';
import { rescue } from '../lib/rescue.js';
import { fits } from '../lib/measure.js';
import { fakeMeter } from './fake-session.js';

const raw = process.env.DSH_SESSION_LOG;
const resolved = raw ? (existsSync(expandHome(raw)) && statSync(expandHome(raw)).isDirectory() ? newestUnder(expandHome(raw)) : expandHome(raw)) : undefined;
const skip = resolved === undefined
  ? 'DSH_SESSION_LOG is not set'
  : !existsSync(resolved)
    ? `log not found: ${resolved}`
    : !supportsZstd()
      ? 'this Node build cannot decode zstd; run the suite under Node 22.15+ or the app\'s Node'
      : false;

test('a real session log folds at a balanced cut without corrupting the surface', { skip }, (t) => {
  const { header, events } = loadSessionLog(resolved);
  const { surface } = reconstructSurface(events);
  // An aborted or brand-new session records no messages at all; there is nothing to replay.
  if (surface.length <= 20) {
    t.skip(`log has only ${surface.length} surface nodes; nothing to fold`);
    return;
  }
  process.stdout.write(`[replay] ${header?.id ?? '?'}: ${events.length} events, ${surface.length} surface nodes\n`);

  const session = new ReplaySession(events, surface);
  const ctx = { tokenMeter: fakeMeter(), get: (name) => (name === 'tokenMeter' ? fakeMeter() : undefined) };
  const meter = fakeMeter();
  ctx.get = () => meter;
  ctx.tokenMeter = meter;

  const measurement = measure(ctx, session);
  process.stdout.write(`[replay] surface tokens (estimate): ${measurement.totalTokens.toLocaleString('en-US')}\n`);

  const whole = pairingCuts(measurement.nodes.map((node) => session.eventAt(node.seq)));
  assert.equal(whole.corrupt, false, 'the real surface is well formed: balance never goes negative');
  // A log captured mid-turn can end with a call that has no result yet. That is a
  // legal surface, so the planner is expected to keep the open call in the tail
  // instead of refusing to work.
  const openCallsAtEnd = whole.open;
  if (openCallsAtEnd === 0) {
    assert.equal(whole.cuts.at(-1), true, 'a closed surface is balanced all the way to its end');
  } else {
    process.stdout.write(`[replay] surface ends with ${openCallsAtEnd} unanswered call(s); the planner must keep them`);
    process.stdout.write('\n');
    assert.equal(whole.cuts.at(-1), false, 'an open call keeps the last cut unsafe');
  }

  const config = resolveConfig({});
  const plan = planFold(session, measurement, {
    retainOptions: [Math.max(config.retainMinTokens, Math.floor(measurement.totalTokens * config.retainRatio))],
    targetTokens: Math.floor(measurement.totalTokens * config.targetRatio),
    minFoldTokens: 1000,
    pinFirstUserMessage: true,
  });
  assert.ok(plan, 'a real oversized session must produce a fold plan');
  assert.equal(whole.cuts[plan.startIdx], true, 'start cut is balanced');
  assert.equal(whole.cuts[plan.endIdx + 1], true, 'end cut is balanced');
  process.stdout.write(`[replay] plan: ${plan.shadowedSeqs.length} nodes, ${plan.shadowedTokenCount.toLocaleString('en-US')} tokens folded\n`);

  const surfaceBefore = session.surface.nodes.length;
  const written = applyFold(session, {
    start: plan.start,
    end: plan.end,
    shadowedSeqs: plan.shadowedSeqs,
    shadowedTokenCount: plan.shadowedTokenCount,
    text: '## 会话急救摘要\n- 折叠测试',
    kind: 'fallback',
  });
  assert.equal(hasOpenCompactionTransaction(session.events), false, 'the transaction bracket is closed');
  assert.equal(session.surface.nodes.length, surfaceBefore - plan.shadowedSeqs.length + 1);

  const replacement = session.eventAt(written.replacementSeq);
  assert.equal(replacement.data.source.kind, 'compact-checkpoint');
  assert.equal(replacement.options.surfaceOp.op, 'replace');

  const after = pairingCuts(session.surface.nodes.map((node) => session.eventAt(node.seq)));
  assert.equal(after.corrupt, false, 'the rewritten surface is still well formed');
  // A fold may legitimately absorb a trailing unanswered call (its assistant
  // message is summarised away), which makes the request more valid, not less.
  // What it must never do is leave more calls open than it started with, or go
  // negative, both of which would corrupt the surface.
  assert.ok(after.open <= openCallsAtEnd, `the rewrite never invents an open call (${after.open} > ${openCallsAtEnd})`);

  const afterMeasurement = measure(ctx, session);
  assert.ok(afterMeasurement.totalTokens < measurement.totalTokens, 'the fold must shrink the projection');
  process.stdout.write(`[replay] after fold: ${afterMeasurement.totalTokens.toLocaleString('en-US')} tokens, ${session.surface.nodes.length} nodes\n`);
});

test('the whole ladder rescues a real oversized log with no model call', { skip }, async (t) => {
  const { header, events } = loadSessionLog(resolved);
  const { surface } = reconstructSurface(events);
  const session = new ReplaySession(events, surface);
  const meter = fakeMeter();
  const llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: 196_608 } }),
  };
  const ctx = {
    tokenMeter: meter,
    get: (name) => ({ tokenMeter: meter, llm })[name],
  };

  const before = measure(ctx, session);
  if (before.totalTokens <= 196_608) {
    t.skip(`log already fits the window (${before.totalTokens} tokens); nothing to rescue`);
    return;
  }
  // The wording that #10138 records: no regex in the host classifier matches it.
  const failure = {
    code: 'INVALID_REQUEST',
    message:
      'payload core text alone is ~3,068,943 bytes; that is ≥ ~411,983 tokens vs the model window 196608 — no upstream can accept it',
  };

  const agent = { id: 'replay-agent' };
  const report = await rescue(ctx, {
    agent,
    session,
    failure,
    provider: 'replay',
    config: resolveConfig({}),
    turn: 7,
  });

  assert.equal(report.detected.overflow, true, 'the unclassified wording is still recognised as an overflow');
  assert.equal(report.window.windowTokens, 196_608, 'the observed window overrides the declared one');
  assert.equal(report.action, 'retry', 'a rescue that shrinks the projection asks the host to retry');
  assert.equal(report.fold?.ok, true, 'the fold that produced the retry is recorded on the report');
  assert.ok(
    fits(report.after.totalTokens, report.window.windowTokens, resolveConfig({}).fitRatio),
    `the projection now fits: ${report.after.totalTokens} of ${report.window.windowTokens}`,
  );
  assert.ok(report.after.totalTokens < before.totalTokens, 'and it is smaller than what failed');

  const tiers = report.tiers.map((tier) => tier.tier);
  assert.ok(tiers.includes('mechanical-fold'), 'the zero-model tier is the one that did the work');

  const replacement = session.eventAt(report.fold.written.replacementSeq);
  assert.equal(replacement.data.source.kind, 'compact-checkpoint');
  assert.equal(hasOpenCompactionTransaction(session.events), false, 'the bracket is closed on the real log too');
  const after = pairingCuts(session.surface.nodes.map((node) => session.eventAt(node.seq)));
  assert.equal(after.corrupt, false, 'the real surface survives the rewrite');

  process.stdout.write(
    `[replay] rescued ${header?.id ?? '?'}: ${before.totalTokens.toLocaleString('en-US')} → ${report.after.totalTokens.toLocaleString('en-US')} tokens (window ${report.window.windowTokens})\n`,
  );
});
