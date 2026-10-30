# dsh-context-rescue

**Emergency rescue for DeepSeek Harness sessions that hit the model context window.**

Your session answers every message with `400` because one request is larger than the
provider will accept. `/compact` does not help: it resends the same oversized surface, and
when a proxy owns compression it is refused outright. This plugin is the ambulance — it
detects the overflow, folds the oldest history into a durable digest, and retries the exact
same step, so the session continues instead of dying.

```
400 the request exceeds the model's context window
  └─ context-rescue: overflow detected (gw-prose, score 0.95)
     ├─ T1 prune tool output      → not available
     ├─ T2 host compaction        → refused by proxy, lane blocked for this process
     └─ T3 mechanical fold        → 956 nodes → 169 nodes, 991,512 → 298,595 tokens
  └─ retry step → 200 OK
```

## Why this exists

The failure chain is well documented upstream (DSH discussion #10138) and it is a chain, not
a bug in one place:

1. the gateway rejects with prose the host classifier does not recognise, so the failure is
   never tagged `CONTEXT_WINDOW_EXCEEDED`;
2. the host's context-overflow branch therefore never runs;
3. nothing shrinks the surface, so the retry is byte-identical and fails again — forever.

Every existing plugin in this space is **preventive** (roll the context window over, prune tool
output, compress through a proxy). None of them runs *after* the session is already wedged.
This one does nothing at all until a request fails, which is why it can be installed alongside
any of them.

## Install

```bash
# from a checkout
dsh plugin --profile <profile> add /path/to/dsh-context-rescue

# once published
dsh plugin --profile <profile> add dsh-context-rescue
```

The plugin declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` and inserts itself
as `context-rescue`. It imports **no** `@deepseek-ai/*` package at runtime — every host
structure it touches (`surfaceOp`, `compaction/*`, the pairing rule, the model-info resolver)
is constructed locally against the documented wire shape. A host upgrade cannot break the
plugin's imports, and a missing peer dependency cannot stop it from loading.

Restart the session (or the app) after installing; a host reload is required for a new bundle.

## What it does when a request fails

The listener runs on the `agent/request-error` waterfall, which fires for every failed request
regardless of the code the host assigned.

1. **Classify.** Score the failure against strong probes (gateway prose, `model's context
   window`, `no upstream can accept`, budget-vs-window arithmetic) and structured codes. Pull
   `requestTokens` / `windowTokens` out of the message when present — the window the failure
   *observed* beats the window the adapter *declared*.
2. **Measure.** Price the surface with the host token meter; fall back to a local estimate.
3. **Plan.** Compute balance-safe cuts with the host's own pairing rule (a tool call is an
   `assistant/message` content block, a result is a `tool/result`; mirror events do not move
   the balance). Keep the pinned head and the recent tail. Refuse to plan across an unclosed
   compaction transaction.
4. **Rescue, in tiers.**
   - **T1** — prune tool output through whatever pruner the host exposes (cheapest, no model).
   - **T2** — ask the host's compaction engine to do what it would have done: `compactIfNeeded(agent, 'context-overflow', signal)`.
     If a proxy refuses the lane (`dsh_compaction_refused`), remember that and never ask again
     in this process.
   - **T3** — write a checkpoint: `compaction/start` → `compaction/prune` → `user/message` with
     `surfaceOp: replace` → `compaction/end`, with a structured digest of the folded span.
5. **Retry once.** Return `{ kind: 'retry' }` so the loop resends the same step against the
   now-smaller surface. If every tier fails, or the per-turn budget is spent, delegate with
   `next()` and let the host report the real error.

The digest is structured, not a paraphrase: failures and errors, files and paths touched, task
list, key actions, user intent, recent conclusions. Long sessions lose detail, but they keep
their shape and their pointers.

## Tools

| Tool | Purpose |
|---|---|
| `context_rescue` | `action: "status"` reports occupancy, capabilities and the last rescue; `action: "rescue"` runs the ladder now and folds without waiting for a failure |
| `context_rescue_estimate` | price the current surface against a declared or observed window |
| `context_rescue_fold` | fold a specific span (`start` / `end` seq) with the same safety checks |

Tools never throw; they return a report object with `ok`, `reason` and counters.

## Configuration

All keys are optional; pass them through the plugin's config block.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"auto"` | `auto` rescues, `diagnose` only reports, `fold` folds without a tier ladder |
| `zeroModelOnly` | `false` | never call the model/compactor; go straight to the mechanical fold |
| `allowModelCompaction` | `true` | allow T2 (the host engine) |
| `retainRatio` | `0.25` | share of the current surface kept as the recent tail |
| `retainMinTokens` / `retainMaxTokens` | `4000` / `40000` | clamps for the retained tail |
| `targetRatio` | `0.75` | fold until the surface is at most this share of the window |
| `fitRatio` | `0.9` | treat the surface as fitting below this share of the window |
| `minFoldTokens` | `4000` | below this, folding is not worth a transaction |
| `maxAttemptsPerTurn` | `2` | rescue budget per assistant turn |
| `maxDigestChars` | `12000` | hard cap on the checkpoint body |
| `pinFirstUserMessage` | `true` | keep the first user message outside every fold |
| `windowFallback` | `196608` | window used when neither the failure nor the model info provides one |
| `extraPatterns` | `[]` | regex sources added to overflow detection |
| `laneRefusalPatterns` | `["dsh_compaction_refused", "bili owns compression"]` | proxy refusals that permanently block T2 |
| `registerTools` | `true` | register the three tools |
| `verbose` | `true` | log rescue decisions to the session |

## Safety

- **Never corrupts the surface.** Fold boundaries are balance-safe by the host's own rule; a
  cut that would split a tool call from its result is not used. A fold that throws closes its
  transaction bracket with `compaction/end{error}` instead of leaving the session mid-write.
- **Never loops.** At most `maxAttemptsPerTurn` rescues per turn, then it steps aside.
- **Never lies.** If nothing foldable exists (a single mega-message, or a pinned head larger
  than the window) it reports that and delegates, so you see the real error.
- **Never competes.** It does not register the `compaction` service; a preventive compactor
  keeps working and gets first refusal at T2.

## Verification

```bash
node --test                          # unit + replay
node scripts/simulate.js             # three failure scenarios against the real code
DSH_SESSION_LOG=<session.v4.jsonl.zstd> node --test tests/replay-real-log.test.js
```

The suite covers detection, pairing-safe planning, fold transactions, ladder behaviour, lane
refusal memory, per-turn budgets and measurement accuracy. `tests/replay-real-log.test.js`
additionally folds a log captured from a real session and re-checks the host invariants on the
result; it is skipped unless `DSH_SESSION_LOG` is set. Measured folds on real logs from this
machine: `956 → 169` nodes (991,512 → 298,595 tokens), `2232 → 507` (933,308 → 241,381),
`482 → 183`, `382 → 165`.

The simulation is not decoration: it caught a real bug, where the measurement path inherited
the digest renderer's 2000-character clamp and priced a 480,000-character message at 1,992
tokens — making the plugin believe an oversized session fit.

## Limits

- It rescues once the request has failed. If you would rather never see the failure, combine it
  with a preventive compactor; the two do not collide.
- The digest preserves structure and pointers, not every token.
- Marking a proxy lane blocked is per process; restarting the host re-tries it once, on purpose.

## License

MIT.
