# dsh-context-rescue

![test](https://github.com/Lequait/dsh-context-rescue/actions/workflows/test.yml/badge.svg)

[中文](README.md) · **English**

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
     ├─ T3 mechanical fold        → 956 nodes → 169 nodes, 991,512 → 298,595 tokens
     └─ T4 oversized message      → only when history is one huge message: keep its head and tail
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
# from this repository
dsh plugin --profile <profile> add git+https://github.com/Lequait/dsh-context-rescue.git#master

# from a checkout
dsh plugin --profile <profile> add /path/to/dsh-context-rescue

# from npm (0.2.4 is published)
dsh plugin --profile <profile> add dsh-context-rescue
```

The branch form follows `master`; the market entry instead pins a commit
(`git+…#<commit>`), so a listing points at a build that cannot move under it.

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
`indexes: []`, so a listing is one discovery away.

This repository is already published, so a user has two routes:

```bash
# 1. straight from git — works without any marketplace, pin the commit you reviewed
dsh plugin --profile <profile> add git+https://github.com/Lequait/dsh-context-rescue.git#<commit>
```

```text
# 2. through the Discover page
add the index source    https://github.com/Lequait/dsh-context-rescue/raw/master/market/index.json
                        (Discover → index sources / "Add index source"; the official market bundle
                        @deepseek-ai/dsh-plugin-market is optional and not present in every profile)
pick the entry          dsh-context-rescue — it installs the commit the entry pins, not a branch
```

The repository also carries the `dsh-plugin` topic so topic-scanning lists pick it up, and the
entry has been submitted to two curated lists (`docs/PUBLISH.md` records the PRs).

## Two ways to count the same thing

`measure()` prices the surface nodes; the provider is asked to accept the
*request*, which is what `session.deriveMessages()` builds. Those are different
numbers, and a session can look fine by the first and still be refused by the
second. `/rescue-status` reports both, and the host gate asserts the second one:
after every fold, the derived request must be smaller than before **and** under
the window.

## When nothing can work

Some sessions cannot be rescued: the system prompt alone can already be over the
window. The plugin tries every tier once, then remembers the session as
defeated and stops measuring it -- otherwise every single request in that
session would pay a full measurement and fail the same way. The step still
runs, the request is still attempted, and the failure is passed through
unchanged. `/rescue` (or `context_rescue` with `action: "rescue"`) always tries
once more, and any rescue that does work reopens the normal path.

That verdict belongs to the window and the shape of the history it was reached under, not to the
session forever: switching to a model with more room, or a projection that has grown since, drops
it and the session is measured again, in both the failure path and the step check. Otherwise
changing models -- the obvious thing to try when a session is stuck -- would keep the plugin
looking away.

## What the checkpoint keeps

The digest is written without a model, so it keeps *facts*, not prose: errors and failures,
the task list, the operations that were run (one line each, repeats collapsed), the user's
requests, the most recent conclusions -- and the file paths the work touched. Paths are read
out of tool arguments whether the host stored them as a tree or, as it does in practice, as a
single JSON text blob; a fold that drops every path leaves the request small and the model lost.

## Before the request is sent

Waiting for the 400 costs a round trip, and some sessions never recover from one (discussion
#10138). So the same rescue also runs on `agent/pre-step`, one step earlier:

1. measure the projection the loop is about to send;
2. if it is already **larger than the model window**, the request cannot be accepted at all, so
   fold it there — T1 prune, then the zero-model checkpoint;
3. if it merely sits in the pressure band (`fitRatio × window` up to the window), do nothing:
   that is ordinary compaction policy and it belongs to the host.

The window comes from the model registry for the provider in the session header, then from the
session, then from `windowFallback`, and it is cached per target so a turn does not resolve it
once per step. T2 is deliberately skipped here: the host engine has its own pre-step hook, and
borrowing it would compact twice for one overshoot.

Measuring a large projection is the expensive part of a rescue — on this machine the full ladder
runs at a 1.1 s median, and almost all of it is pricing nodes. A pre-step hook runs on every step,
so it measures **once per turn** and afterwards only counts what was appended since: the second
check of a turn costs nothing measurable and still notices a large paste (any new message over
4,000 characters forces a real re-measurement, and so does a surface whose node count no longer
matches the cached one — someone else folded). `node scripts/dev/rescue-bench.mjs` prints the
distribution for the largest logs on this machine.

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
   - **T4** — when the overshoot *is* one message (a file pasted into the newest turn), there is
     no span to fold around it: replace that message with its own head and tail, and state the
     original length and what was dropped. Only text messages whose removal keeps tool pairing
     balanced qualify; an orphan `tool/result` or an assistant message carrying calls is never
     touched on its own. When the oversize *is* a tool result, that result and the call answering
     it are replaced together — dropping either half alone would orphan the other.

   The system prompt is never excerpted: an excerpt of the instructions would keep the request
   legal while quietly removing what the turn was told to do, so if that is the only thing left
   over the window the ladder reports a failure instead of pretending. Several pasted blocks at
   once are handled in one pass — the fold takes the older span, and T4 cuts down what survives
   in the tail. Within what is left over, older history is excerpted first: the message typed
   into the current turn is what the turn is about, so it is only cut when nothing older is
   large enough to bring the request under the window.

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
| `context_rescue_estimate` | classify a pasted error text (optional `text`) and show the sizes it extracts, plus this session's occupancy |
| `context_rescue_fold` | fold the oldest history span right now — no parameters, the same mechanical fold `/rescue` runs — and report the token delta |

Tools never throw; they return a report object with `ok`, `reason` and counters.

## Commands

Two slash commands are registered whenever the host exposes a command registry (the same slot
`/compact` uses). They are optional — a profile without the registry still gets the automatic
path and the tools.

| Command | Purpose |
|---|---|
| `/rescue` | fold the oldest span now and report the token delta (`/rescue status` reports only) |
| `/rescue-status` | occupancy, resolved window, whether a fold is possible, what a fold would cost right now, and the last attempt |

The status line distinguishes the two things a rescue can do: it names the span a fold would
take, and when nothing can be folded it says which oversized message would be excerpted instead
of claiming there is nothing to do.

The registry may mount after this plugin; registration is retried when the service appears.
Results are one line of text, and a rescue folds through exactly the same code path as the
automatic one. Commands never throw.

## Configuration

All keys are optional; pass them through the plugin's config block.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | mount the plugin at all; `false` leaves the harness untouched |
| `mode` | `"auto"` | `auto` runs the full ladder (prune → host engine → mechanical fold → excerpt); `fold` runs the same ladder without the host compaction engine, so it never asks a model to summarise; `diagnose` detects and reports but rewrites nothing |
| `zeroModelOnly` | `false` | never call the model/compactor; go straight to the mechanical fold |
| `trimOversizedMessages` | `true` | when one message alone overflows, replace it with its own head and tail |
| `excerptChars` | `3000` | characters kept from each end when that happens |
| `allowModelCompaction` | `true` | allow T2 (the host engine) |
| `retainRatio` | `0.25` | share of the current surface kept as the recent tail |
| `retainMinTokens` / `retainMaxTokens` | `4000` / `40000` | clamps for the retained tail |
| `targetRatio` | `0.75` | fold until the surface is at most this share of the window |
| `fitRatio` | `0.9` | treat the surface as fitting below this share of the window |
| `minFoldTokens` | `4000` | below this, folding is not worth a transaction |
| `maxAttemptsPerTurn` | `2` | rescue budget per assistant turn |
| `maxDigestChars` | `12000` | hard cap on the checkpoint body |
| `pinFirstUserMessage` | `true` | keep the first user message outside every fold, unless that message alone is over the budget |
| `windowFallback` | `196608` | window used when neither the failure nor the model info provides one |
| `extraPatterns` | `[]` | regex sources added to overflow detection |
| `laneRefusalPatterns` | `["dsh_compaction_refused", "bili owns compression"]` | proxy refusals that permanently block T2 |
| `registerTools` | `true` | register the three tools |
| `registerCommands` | `true` | register `/rescue` and `/rescue-status` when the host has a command registry |
| `preflight` | `true` | fold on `agent/pre-step` when the projection is already over the window |
| `repairTransactions` | `true` | close a compaction bracket a crash left open; a dangling one blocks every later fold |
| `verbose` | `true` | log rescue decisions to the session |
| `debug` | `false` | log one structured line per decision — the detected code and window, both measurements, every tier with the reason it declined, and the folded span — so a session that is *not* being rescued says why |

### Configuration mistakes are reported, not swallowed

Options are validated when the plugin mounts. An unknown key (`retainRation`), a `mode` the
plugin does not know, a ratio outside its usable range, or a `targetRatio` that sits at or above
`fitRatio` is logged as a `config:` warning instead of quietly changing the behaviour you expect.
A rescue plugin that silently ignores a typo is indistinguishable from one that is not installed.

### The options are a real schema, not a wish list

`lib/schema.js` declares every option below as a Cordis/Schemastery schema, which the host uses in
two ways: it validates your patch **before** the plugin starts, and it documents the options in
`dsh --dump-config-schema`. A value the schema refuses (`retainRatio: 5`, `mode: aggressive`,
`preflight: "yes"`) stops the boot with the field name and the bound, instead of starting with a
silently clamped number:

```
$.retainRatio expected number <= 0.6 but got 5
```

Unknown keys are deliberately *left alone* by the schema so the warning above can name your typo —
the two checks cover different failures, and neither hides the other.

## Safety

- **Never corrupts the surface.** Fold boundaries are balance-safe by the host's own rule; a
  cut that would split a tool call from its result is not used. A fold that throws closes its
  transaction bracket with `compaction/end{error}` instead of leaving the session mid-write.
- **Never spends context for nothing.** If the measured projection already fits the window the
  failure reported, it retries unchanged instead of folding — the gateway can count more than
  the projection does, and a rewrite there would only cost history.
- **Never loops.** At most `maxAttemptsPerTurn` rescues per turn, then it steps aside.
- **Never deletes history.** A fold only appends: every original event stays in the session
  log, `eventAt(seq)` still resolves it, and only the projection stops containing it. Nothing a
  rescue hides is gone from the record, so a wrong fold costs you a projection, not the
  conversation — the log can still be read, replayed, or folded differently next time.
  `tests/fold.test.js` asserts it.
- **Never lies.** If nothing foldable exists (a single mega-message, or a pinned head larger
  than the window) it reports that and delegates, so you see the real error.
- **Never competes.** It does not register the `compaction` service, so a preventive compactor
  keeps its slot and gets first refusal at T2; with `zeroModelOnly` it never calls the lane at
  all. `npm run mount-check` proves the slot still routes to the host engine after the plugin
  mounts.

### Removing it, and undoing a fold

Uninstalling is the rollback, and it needs no cleanup:

```bash
dsh plugin --profile <profile> remove dsh-context-rescue   # then restart the app
```

A fold is appended events in the host's own vocabulary — `compaction/start`, one `compaction/prune`
per folded node, one replacement `user/message` carrying `surfaceOp`, and `compaction/end` — so a
host that never loaded this plugin reads the folded session exactly as it was left. `npm run
host-session` asserts that on every log it folds: it re-seeds a fresh host `Session` from the folded
events, with none of this code involved, and checks that the messages, the tool-call pairing and the
measured size all match the live session.

The projection cannot be un-folded in place. `@deepseek-ai/dsh-session` defines `compaction/start`,
`compaction/prune` and `compaction/end`, and no void event — there is nothing to append that puts
back the history the projection dropped. The events themselves were never deleted, so the text is
still in `session.v4.jsonl.zstd` and still resolvable by sequence number, but the model will not see
it again. If you want the numbers before committing to that, ask first: `/rescue-status` previews the
span it would fold, and `mode: "diagnose"` reports without writing.

## Verification

Three commands run the gates in the order a person would type them, stream their output, and end
with a table naming the one that failed:

```bash
npm run verify           # core: the unit suite, the type contract, the four simulated failures
npm run verify:host      # the nine gates that need the installed app on this machine
npm run verify:network   # the four gates that need the registry or the repository
```

Measured here: 3 gates in 8 s, 9 gates in 3 min 34 s, 4 gates in 1 min 30 s — sixteen gates, one
table, exit code = did anything fail.

`node scripts/dev/verify.mjs --group host --only install-smoke,schema-check` runs two of them.

The individual commands, if you want one at a time:

```bash
node --test                          # unit + replay
npm run typecheck                    # JSDoc type contract over index.js and lib/
node scripts/simulate.js             # four failure scenarios against the real code
npm run scan                         # fold every oversized session log found on this machine
npm run host-session                 # the same folds through the host's own Session class
npm run coexist                      # rescue beside the host's real compaction engine
npm run e2e-install                  # install through the app's own CLI into a throwaway profile
npm run e2e-install -- --git         # same, but from the published git spec instead of a tarball
npm run e2e-install -- --npm         # same, but from the registry spec — the listing people use
npm run market-install               # fetch the published market index, let the host parse it, install what it says
npm run boot-check                   # boot the real app: does apply() run, and does it survive a profile that owns the compression lane?
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

# the optional npm release: checks the tree, the tarball list and the taken version,
# then stops at the one step that needs an account
npm run publish:npm -- --dry-run
```

The suite covers detection, pairing-safe planning, fold transactions, ladder behaviour, lane
refusal memory, per-turn budgets, a no-op borrowed engine, an already-fitting projection, a second
rejection that forces the ladder, an internal throw that is handed back to the host, and
measurement accuracy. `tests/replay-real-log.test.js`
additionally folds a log captured from a real session and re-checks the host invariants on the
result; it is skipped unless `DSH_SESSION_LOG` is set. `node scripts/dev/scan-sessions.mjs`
sweeps every log on this machine and folds each oversized one with zero model calls: 34 of 216
captured sessions exceed a 196,608-token window and all 34 are rescued, with no failure
(`docs/PLAN.md` §5). The counts here are a snapshot of this machine: they grow as
sessions are captured, and `scan` and `host-session` recompute them, so the numbers below are
that same snapshot rather than fixed constants.

`host-session` is the highest-fidelity gate and the reason the two bugs above were found. It loads
the `Session` class out of the installed app bundle and replays captured logs through it, so the
appends are validated by the host's `validateSessionEventData`, the projection is built by its
`SurfaceManager`, and the assertions are made on `deriveMessages()` — the exact message array the
next request would carry. 216 logs seed, 70 fold (twice each, to prove a folded session can be
folded again), 32 of those folds come from the pre-flight path before any request failed, and the
rest are skipped because the host itself cannot re-seed them in isolation (a foreign plugin's
message projection, or a pre-v4 log).

`boot-check` goes one level higher: it boots the application. It builds five throwaway profiles, four of
them from the shipped `headless` template — first a copy of this package whose `apply()` throws, and asserts
the host reports that error under the very entry it inserted (`context-rescue (dsh-context-rescue)`),
because a clean "no error" run would otherwise prove nothing; then the real tarball, and asserts the
boot walks past mounting with no error naming the plugin and stops at the model call, exactly where
a machine without an API key stops; finally `billion-context`, the proxy that owns the compression
lane on some machines, is installed next to the plugin and the composed profile is booted again, so
"works beside the lane owner" is measured instead of assumed; and `dsh-smart-compact`, the plugin
that overrides the compaction engine, gets the same treatment, because two plugins reaching for one
slot is a composition problem; the fifth profile is built from the `web` template instead, which is
the shape the desktop app composes, and the assertion there is that the entry lands in the same tree
as `@deepseek-ai/dsh-client-ui-commands` — the bundle that renders the command surface a user sees.
That profile is then started for real: the host must print its URL, hand the printed URL's auth
cookie to a request, and serve the UI document. A bundle that breaks the GUI host never gets that far.
All five profiles are removed afterwards. It proves mounting, not inference.

`coexist` mounts the plugin beside the host's *real* compaction engine
(`@deepseek-ai/dsh-compaction-basic`, the one a stock profile puts in the slot) with a fake `llm`
that cannot summarize, and asserts three things: the plugin does not take the slot, a borrow that
returns without shrinking the projection is not recorded as a rescue, and both the engine and the
container are still intact after that borrow fails.

Borrowing is what makes the plugin safe to install next to a compactor that already owns the slot.
`dsh-smart-compact@0.5.3` subclasses the same engine and overrides
`compactIfNeeded(agent, trigger, signal)`: non-pressure triggers go straight through to the base
engine, a pending `new_context` request bypasses the pressure bands, and a refusal resolves `null`
rather than throwing. That override is why the plugin asks for `context-overflow` with the same
three arguments, treats `null` as "nothing shrank" and falls through to the zero-model fold, and a
unit test pins that an engine throwing for its own reasons (a budget measurement error, a base
engine failure) is neither counted as a lane refusal nor able to stop the fold.

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
written into the pushed `package.json`. It needs a full checkout: git refuses to push a shallow
history, so the script says so and exits non-zero instead of pretending to pass (CI checks out
with `fetch-depth: 0`).

## When it does not rescue

Read the plugin's own state instead of guessing. `context_rescue` with
`action: "status"`, or `/rescue-status` in the input box, reports
`measuredTokens`, `window.windowTokens`, `fits`, `foldSupported`, `hostCompaction`,
`toolResultPruner` and `laneBlocked` for the current session.

While the session is over the window, the report also previews the fold it would perform:
how many nodes it would replace and their sequence range, how much history that is in
tokens, how many characters the summary would take, and how much recent history would be
kept. A status call writes nothing — the preview is the same plan `/rescue` would run,
computed and then thrown away.

| Symptom | What it means | What to do |
|---|---|---|
| No `armed: context-overflow rescue active` line at startup | the host skipped the bundle | check `engines.dsh` against the app version, and that the patch file resolved inside the installed package |
| `fits: true` yet the provider rejects the request | the window estimate is larger than what the gateway enforces | the failure text usually carries the real number; when it does not, set `windowFallback` to the enforced window |
| `laneBlocked: true` | billion-context refused the host's own compaction on this lane | the plugin stays on the zero-model path; set `zeroModelOnly: true` to make that explicit and stop asking |
| `foldSupported.ok: false` | this session shape does not expose `append`/`surface.nodes`/`eventAt` | a host version mismatch — the plugin refuses to rewrite a projection it cannot re-read |
| `hostCompaction: absent` | no compaction engine is mounted | harmless: tier 2 is skipped and the zero-model ladder still runs |
| the preview says a rescue would find nothing to fold | the overshoot is inside the retained tail and no single message explains it | set `pinFirstUserMessage: false`, or raise `retainRatio` so less of the tail is protected |
| the rescue ran but the request still fails | the payload is still larger than the window | lower `retainRatio`/`retainMaxTokens`, or start a new turn and let the checkpoint carry the gist |

## Limits

- It rescues once the request has failed. If you would rather never see the failure, combine it
  with a preventive compactor; the two do not collide.
- The digest preserves structure and pointers, not every token.
- Marking a proxy lane blocked is per process; restarting the host re-tries it once, on purpose.

## License

MIT.
