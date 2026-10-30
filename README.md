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
plugin's imports, and it declares no host peer dependency to go missing.

Restart the session (or the app) after installing; a host reload is required for a new bundle.

## Marketplace listing

`market/` holds the icon and the generator for a **format-1 plugin market index entry**. The
entry is validated by the host's own `parseMarketIndex`, i.e. by the same code the Discover page
uses to read indexes:

```bash
# validate an entry whose Git source is this repository at a pinned commit
node scripts/make-market-index.mjs \
  --repo https://github.com/OWNER/dsh-context-rescue \
  --commit "$(git rev-parse HEAD)" \
  --out market/index.json

# or do the whole publish in one step: push, then pin the entry to the pushed commit
npm run publish:remote -- --repo OWNER/dsh-context-rescue --dry-run
```

It prints the resolved install spec (`git+https://…git#<commit>`, or `name@version` with
`--npm`) and exits non-zero on any violated rule, with the JSON path of the offending value.
`DSH_APP_ASAR` overrides where the validator is loaded from.

DSH only reads indexes a user configured: the market bundle is optional and ships with
`indexes: []`, so a self-hosted listing is one discovery away — serve `market/index.json` over
HTTP and add that URL as an index source (Discover → index sources, or the `plugin_market`
tool's index list). Publishing to a public index additionally needs the repository to exist:
tag `dsh-plugin`, open a PR against an awesome list, and/or publish to npm.

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
     A borrowed engine only counts as a rescue when the projection actually shrank; an engine
     that resolves without doing anything falls through to T3. If a proxy refuses the lane
     (`dsh_compaction_refused`), remember that and never ask again in this process.
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
- **Never spends context for nothing.** If the measured projection already fits the window the
  failure reported, it retries unchanged instead of folding — the gateway can count more than
  the projection does, and a rewrite there would only cost history.
- **Never loops.** At most `maxAttemptsPerTurn` rescues per turn, then it steps aside.
- **Never lies.** If nothing foldable exists (a single mega-message, or a pinned head larger
  than the window) it reports that and delegates, so you see the real error.
- **Never competes.** It does not register the `compaction` service, so a preventive compactor
  keeps its slot and gets first refusal at T2; with `zeroModelOnly` it never calls the lane at
  all. `npm run mount-check` proves the slot still routes to the host engine after the plugin
  mounts.

## Verification

```bash
node --test                          # unit + replay
node scripts/simulate.js             # three failure scenarios against the real code
DSH_SESSION_LOG=<session.v4.jsonl.zstd> node --test tests/replay-real-log.test.js

# the same suite under the app's own Node, where the host validator is reachable
npm run test:host

# mount into the installed app's own cordis container and drive one rescue
npm run mount-check

# pack it, install it into a throwaway project, and let the host loader resolve the bundle
npm run install-smoke

# build + validate a market index entry for this checkout
npm run market -- --repo-slug OWNER/dsh-context-rescue
```

The suite covers detection, pairing-safe planning, fold transactions, ladder behaviour, lane
refusal memory, per-turn budgets, a no-op borrowed engine, an already-fitting projection and
measurement accuracy. `tests/replay-real-log.test.js`
additionally folds a log captured from a real session and re-checks the host invariants on the
result; it is skipped unless `DSH_SESSION_LOG` is set. Driving the whole ladder against real
logs from this machine rescues every oversized session with zero model calls: 1,087,491 →
51,257 tokens, 991,512 → 94,082, 933,308 → 50,890, 497,020 → 51,538, 200,442 → 48,959,
against a 196,608-token window (14 sessions; `docs/PLAN.md` §5).

`mount-check` is the integration gate: it loads the plugin into the **installed app's** cordis
4 container, so it exercises the real `inject`/`Service` wiring and the real
`ctx.waterfall('agent/request-error', payload, next)` dispatch instead of a hand-rolled context.
It asserts the tools land on the real `tools` service, the waterfall answers `{kind:'retry'}`,
the surface is rewritten with a checkpoint, the per-turn budget stops the third attempt, the
tools answer through the service, and — with a host compaction engine mounted first — the slot
still routes to that engine while the rescue still completes on the zero-model tier.

`install-smoke` is the packaging gate: `npm pack` decides what ships (the `files` list),
the tarball installs as a dependency in a throwaway project, the **host's own**
`bundlePatchPaths`/`loadOverlayPatches` resolve the patch from the installed path, and
`evaluatePluginCompatibility` accepts the installed manifest — with a deliberately
unsatisfiable `engines.dsh` checked alongside it, so the gate cannot pass vacuously. A file
dropped from `files`, or a patch resolved against the wrong directory, fails there and nowhere
else — the other gates read the source tree.

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
