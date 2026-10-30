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

## Commands

Two slash commands are registered whenever the host exposes a command registry (the same slot
`/compact` uses). They are optional — a profile without the registry still gets the automatic
path and the tools.

| Command | Purpose |
|---|---|
| `/rescue` | fold the oldest span now and report the token delta (`/rescue status` reports only) |
| `/rescue-status` | occupancy, resolved window, whether a fold is possible, and the last attempt |

The registry may mount after this plugin; registration is retried when the service appears.
Results are one line of text, and a rescue folds through exactly the same code path as the
automatic one. Commands never throw.

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
| `registerCommands` | `true` | register `/rescue` and `/rescue-status` when the host has a command registry |
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
npm run typecheck                    # JSDoc type contract over index.js and lib/
node scripts/simulate.js             # three failure scenarios against the real code
npm run scan                         # fold every oversized session log found on this machine
npm run host-session                 # the same folds through the host's own Session class
DSH_SESSION_LOG=<session.v4.jsonl.zstd> node --test tests/replay-real-log.test.js

# the same suite under the app's own Node, where the host validator is reachable
npm run test:host

# mount into the installed app's own cordis container and drive one rescue
npm run mount-check

# pack it, install it into a throwaway project, and let the host loader resolve the bundle
npm run install-smoke

# rehearse the whole publish flow against a throwaway clone and a local bare remote
# (also pins the branch rule: an empty remote gets main, an existing master keeps master)
npm run publish:rehearse

# build + validate a market index entry for this checkout
npm run market -- --repo-slug OWNER/dsh-context-rescue
```

The suite covers detection, pairing-safe planning, fold transactions, ladder behaviour, lane
refusal memory, per-turn budgets, a no-op borrowed engine, an already-fitting projection, a second
rejection that forces the ladder, an internal throw that is handed back to the host, and
measurement accuracy. `tests/replay-real-log.test.js`
additionally folds a log captured from a real session and re-checks the host invariants on the
result; it is skipped unless `DSH_SESSION_LOG` is set. `node scripts/dev/scan-sessions.mjs`
sweeps every log on this machine and folds each oversized one with zero model calls: 31 of 157
captured sessions exceed a 196,608-token window and all 31 are rescued, with no failure
(`docs/PLAN.md` §5).

`host-session` is the highest-fidelity gate and the reason the two bugs above were found. It loads
the `Session` class out of the installed app bundle and replays captured logs through it, so the
appends are validated by the host's `validateSessionEventData`, the projection is built by its
`SurfaceManager`, and the assertions are made on `deriveMessages()` — the exact message array the
next request would carry. 157 logs seed, 65 fold (twice each, to prove a folded session can be
folded again), and the rest are skipped because the host itself cannot re-seed them in isolation
(a foreign plugin's message projection, or a pre-v4 log).

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

`publish:rehearse` closes the last gap that a source-tree test cannot reach: `publish-remote`
is the one step that needs an account, so the rehearsal clones this checkout into a temp
directory, creates a bare repository as the remote, runs the real script against it, and then
asserts what a host would see — the pushed branch, a `market/index.json` that the host's own
`parseMarketIndex` accepts, an entry pinned to the commit that carried the code (not to the
index commit itself), the commit-pinned `git+…#<commit>` install spec, and repository metadata
written into the pushed `package.json`.

## When it does not rescue

Read the plugin's own state instead of guessing. `context_rescue` with
`action: "status"`, or `/rescue-status` in the input box, reports
`measuredTokens`, `window.windowTokens`, `fits`, `foldSupported`, `hostCompaction`,
`toolResultPruner` and `laneBlocked` for the current session.

| Symptom | What it means | What to do |
|---|---|---|
| No `armed: context-overflow rescue active` line at startup | the host skipped the bundle | check `engines.dsh` against the app version, and that the patch file resolved inside the installed package |
| `fits: true` yet the provider rejects the request | the window estimate is larger than what the gateway enforces | the failure text usually carries the real number; when it does not, set `windowFallback` to the enforced window |
| `laneBlocked: true` | billion-context refused the host's own compaction on this lane | the plugin stays on the zero-model path; set `zeroModelOnly: true` to make that explicit and stop asking |
| `foldSupported.ok: false` | this session shape does not expose `append`/`surface.nodes`/`eventAt` | a host version mismatch — the plugin refuses to rewrite a projection it cannot re-read |
| `hostCompaction: absent` | no compaction engine is mounted | harmless: tier 2 is skipped and the zero-model ladder still runs |
| the rescue ran but the request still fails | the payload is still larger than the window | lower `retainRatio`/`retainMaxTokens`, or start a new turn and let the checkpoint carry the gist |

## Limits

- It rescues once the request has failed. If you would rather never see the failure, combine it
  with a preventive compactor; the two do not collide.
- The digest preserves structure and pointers, not every token.
- Marking a proxy lane blocked is per process; restarting the host re-tries it once, on purpose.

## License

MIT.
