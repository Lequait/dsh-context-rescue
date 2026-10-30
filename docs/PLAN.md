# Work plan — dsh-context-rescue

Status: **implementation complete, verification in progress.** This file is the plan the
code is measured against; every phase carries its evidence inline so a reviewer can check
the claim instead of trusting the summary.

## 1. Problem

A DeepSeek Harness session can become unrecoverable when a single request exceeds the
provider's *actual* context window while the host believes it has room. The failure chain,
reproduced from the upstream report (DSH discussion #10138) and from this plugin's own
simulation:

1. The gateway rejects the request with prose the host classifier does not recognise
   (`payload core text alone is ~N bytes … no upstream can accept it`), so the error is not
   tagged `CONTEXT_WINDOW_EXCEEDED`.
2. Because the code is wrong, the host's own context-overflow branch never runs.
3. Because the host's overflow branch never runs, nothing ever shrinks the surface, so every
   retry resends a request that is *still* too large.

The user-visible result is a session that answers every message with `400`, and a manual
`/compact` that does nothing because the compaction attempt travels the same oversized
surface (and is additionally refused outright when a proxy layer owns compression, e.g.
billion-context's `422 dsh_compaction_refused`).

## 2. Design contract

The plugin is a **post-hoc rescue**, not a preventive compactor. It never replaces the host's
compaction engine (the `compaction` service is a single slot; stealing it would break
`zeroModelOnly` setups and `dsh-smart-compact`-style rollover). Instead it listens on the
`agent/request-error` waterfall, which fires for *every* failed request regardless of the
error code the host assigned.

Properties the implementation must hold:

| # | Property | Why it matters |
|---|---|---|
| P1 | Never corrupts the surface | A bad rewrite kills the session permanently instead of temporarily |
| P2 | Degrades to zero model calls | The failure mode being rescued is often "the model call cannot be made" |
| P3 | Retries at most once per turn per attempt budget | A rescue that loops is a rescue that burns the user's quota |
| P4 | Delegates when it cannot help | Faking success hides the real error |
| P5 | Coexists with a proxy compactor | The proxy may own compression; we must yield, not fight |

## 3. Phases

### Phase A — Feasibility (done)

Verified against the host packages (`0.2.1-rc.3` locally, `0.2.1-rc.5` from the registry):
the waterfall contract, the `surfaceOp: replace` write protocol, the zero-model
`compaction/prune` protocol, the token meter, the model-info resolver, and the single-slot
compaction service. Evidence and citations: [FEASIBILITY.md](./FEASIBILITY.md).

Gate: all six mechanisms confirmed in shipped type declarations and source → **passed**.

### Phase B — Detection (done)

`lib/overflow.js` scores a failure instead of matching one regex:

- strong probes (gateway prose, `model's context window`, `no upstream can accept`,
  budget-vs-window arithmetic) — any single hit is enough;
- structured codes (`CONTEXT_WINDOW_EXCEEDED` and eight related codes);
- numeric extraction (request tokens, window tokens, payload bytes) so the rescue can size
  the target against the window the failure *observed*, not the one the adapter declared;
- user-supplied `extraPatterns`, which extend detection without ever disabling the built-ins.

Gate: 8 tests, including the exact wording from #10138 and a "numbers alone do not trigger"
negative → **passed**.

### Phase C — Rescuing fold (done)

`lib/plan.js` + `lib/digest.js` + `lib/fold.js`:

- the fold window is chosen from the *balance-safe* cuts of the real surface, computed with
  the host's own pairing rule (`assistant/message` tool-call blocks `+n`, `tool/result` `−1`,
  everything else `0`) — mirroring `@deepseek-ai/dsh-compaction`'s `tool-pairing.js`;
- the pinned head (system prompt, first user message) and the recent tail are preserved;
- the digest is a structured checkpoint (failures, files and paths, task list, key actions,
  user intent, recent conclusions), not a lossy paraphrase;
- the write is one transaction: `compaction/start` → `compaction/prune|summary` →
  `user/message` with `surfaceOp: replace` → `compaction/end`, with no `await` between the
  replacement and its pricing event, and a bracket-closing `compaction/end{error}` if the
  replacement throws.

Gate: 6 tests plus a replay against four real session logs → **passed**.

### Phase D — Ladder and budget (done)

`lib/rescue.js` escalates and stops:

- **T1** prune tool output through whatever pruner the host exposes;
- **T2** ask the host's own compaction engine (`compactIfNeeded(agent, 'context-overflow')`);
- **T3** mechanical fold, no model required.

A lane refusal (`dsh_compaction_refused`, `bili owns compression`) marks T2 permanently
blocked for the process, so the next failure jumps straight to T3 instead of re-asking a
proxy that already said no. Attempts are counted per turn and capped (`maxAttemptsPerTurn`).

Gate: 8 tests, including "the host engine is called exactly once, then never again" and
"per-turn budget" → **passed**.

### Phase E — Operator surface (done)

Three tools, so a stuck user (or an agent reading `session`, e.g. a teammate or a script) can
act without waiting for a failure: `context_rescue` (`status` / `rescue`),
`context_rescue_estimate`, `context_rescue_fold`. Tools return data, never throw. The tools cover
the model; the person in the composer needs a lever too, so the plugin also registers `/rescue`
and `/rescue-status` on the host command registry (the `/compact` slot). That service is
feature-detected, never injected: a profile without it must still arm the request-error hook, and
registration is retried on `internal/service` when the registry mounts later.

Gate: exercised through the fake context in `tests/rescue.test.js` and `tests/command.test.js`,
and end-to-end through the host's own `CommandRuntime` (`/rescue-status` then `/rescue`, including
`command/run` + `command/done` lifecycle) in `scripts/dev/mount-check.mjs` → **passed**.

### Phase F — Simulation and replay (done)

- `scripts/simulate.js` replays three scenarios against the real plugin code: (1) the #10138
  chain, (2) a proxy lane refusal, (3) an un-foldable single mega-message that must be
  delegated. A bug found here — the measurement path used the digest's 2000-char clamp, so a
  480k-char message priced at 1,992 tokens — was fixed by splitting raw from rendered text.
- `tests/replay-real-log.test.js` drives the whole ladder against a log captured from a real
  session: the unclassified failure wording in, a smaller projection plus a retry request out,
  with the host invariants re-checked on the rewritten surface.

Gate: three simulation scenarios green; every oversized real log on this machine rescued with
zero model calls (14 sessions, §5), 44-log sweep with 0 failures → **passed**.

### Phase G — Release (in progress)

- README (en + zh-CN), config reference, install instructions;
- `git init` + first commit on the user's repository;
- marketplace: a format-1 index entry is generated by `scripts/make-market-index.mjs` and
  validated by the host's own `parseMarketIndex` (`npm run market`); the remaining step is a
  public repository to point it at, then the `dsh-plugin` topic, an awesome-list PR, and/or an
  npm publish.

Two manifest decisions came out of inspecting the installed host (`0.2.1-rc.3`):

- `@deepseek-ai/dsh-plugin` — the peer this plugin originally declared — **does not exist** in
  the host's `node_modules`, so declaring it was a phantom requirement. It is gone; the plugin
  needs no host package at runtime.
- The host guard is now `engines.dsh: ">=0.2.0-rc.1"`. Per the host's own rule (`evaluatePlugin
  Compatibility`: an own `engines.dsh` range decides alone, peers are then ignored) this is the
  single place that states the contract. Checked both ways: `0.2.1-rc.3` → compatible,
  `0.1.5-rc.2` → unmet requirement `{"engines.dsh":">=0.2.0-rc.1"}`.

Gate: repository pushed, listing submitted → **blocked on a repository URL and credentials**.
The machine has no `gh`, no SSH key (`~/.ssh` holds only `known_hosts`), no
`~/.git-credentials`, no `GITHUB_TOKEN`, and the npm CLI reports `ENEEDAUTH`. Everything that
can be produced without them exists: the commits, a validated index entry, the installable
bundle shape — and, since the publish mechanics were the untested part, a rehearsal that runs
the real `publish-remote` script against a local bare repository and checks the pushed branch,
the host-accepted entry and the pinned install spec (`npm run publish:rehearse`, 18 assertions), plus the
first-push branch rule in both directions (an empty remote gets `main`, an existing `master` is kept).
The npm side is prepared the same way: `npm pack` produces the exact artifact, `npm publish
--dry-run` authenticates against `registry.npmjs.org` with public access and stops only at the
login, and `.github/workflows/release.yml` publishes from a tag (type check, tests, simulation,
install smoke and publish rehearsal first, then a tag/version equality guard, then `--provenance`).
What no local gate can supply is the account: no hosted repository, no npm login, no token.

## 4. Verification matrix

| Concern | Check | Result |
|---|---|---|
| Host waterfall contract | `agent/request-error` returns `{kind:'retry'}` and the loop `continue`s | verified in host source + simulated |
| Surface write protocol | replacement is a `user/message` with `surfaceOp: replace` between `compaction/start` and `compaction/end` | verified in host source + replay |
| Tool pairing | fold boundaries sit on balance-safe cuts, per the host's own rule | verified on 4 real logs (956→169, 2232→507, 482→183, 382→165 nodes) |
| Zero-model path | works with `llm.stream` unavailable/refused | verified in simulation and tests |
| No host imports | plugin imports no `@deepseek-ai/*` at runtime | verified by `grep` in CI-style script + package `files` |
| Idempotence | a second failure in the same turn does not re-fold blindly | verified by per-turn budget test |
| Bundle patch | `cordis.patch.yml` parses and resolves through the host's own loader | verified: `bundlePatchPaths` + `loadOverlayPatches` returned the expected insert entry |
| Manifest compatibility | host `evaluatePluginCompatibility` accepts the manifest, and rejects 0.1.x | verified: compatible on `0.2.1-rc.3`, `{"engines.dsh":">=0.2.0-rc.1"}` unmet on `0.1.5-rc.2` |
| Market index entry | the generated entry passes the host's own `parseMarketIndex` and yields a commit-pinned install spec | verified: `parseMarketIndex` + `marketInstallTarget` on `0.2.1-rc.3` |
| Host container mount | plugin mounts in the installed app's cordis 4, the tools land on the real `tools` service, and the rescue survives a mounted host compaction engine without taking its slot | verified by `scripts/dev/mount-check.mjs` (22 assertions) |
| Human commands | the host's own `CommandRuntime` lists `/rescue` and `/rescue-status`, executes them, and logs `command/run` + `command/done` | verified by `scripts/dev/mount-check.mjs` §6 (7 assertions) |
| Installed package | `npm pack` output installs as a dependency and the host bundle loader resolves `cordis.patch.yml` from the installed path | verified by `scripts/dev/install-smoke.mjs` |
| Type contract | every exported signature and internal shape in `index.js` + `lib/` type-checks under `--checkJs` | `npm run typecheck` → 0 errors over 12 files (`tsconfig.json`) |
| Publish flow | cloning this checkout, pushing into a bare remote, and pinning the index entry produce a host-accepted entry that points at the code commit | verified by `scripts/dev/publish-rehearse.mjs` (18 assertions, no account needed) |
| Host Session class | the fold is accepted by the host's own `Session`: appends pass `validateSessionEventData`, the projection is rebuilt by `SurfaceManager`, `deriveMessages()` keeps no orphan tool result, and the bracket closes | verified by `scripts/dev/host-session-check.mjs`: 157 logs seeded, 65 folded twice, 0 failed |
| Real event shapes | surface membership matches `isSurfaceEligibleType` (`tool/call` and `tool/ptc-dispatch` are not surface nodes), and events are read through `snapshotEvents()` because the host `Session` has no `.events` | both properties pinned by the host-session gate above |

## 5. Real-log evidence

The replay gate now drives the **whole ladder**, not just the planner:
`DSH_SESSION_LOG=<path> node --test tests/replay-real-log.test.js`. It loads a log captured from
this machine, feeds the wording the host classifier misses, and asks the plugin to rescue it with
no model call. Every oversized log on this machine, in one pass:

| Session | Tokens before | After rescue | Window |
|---|---|---|---|
| `abc05855` | 575,630 | 51,321 | 196,608 |
| `9a608fe8` | 933,308 | 50,889 | 196,608 |
| `753cc91b` | 829,396 | 55,544 | 196,608 |
| `eba32f8b` | 1,067,623 | 51,683 | 196,608 |
| `335a745b` | 1,067,701 | 51,761 | 196,608 |
| `63836d1c` | 1,087,491 | 51,257 | 196,608 |
| `711575e5` | 444,738 | 95,612 | 196,608 |
| `aeb2b2fd` | 460,921 | 51,510 | 196,608 |
| `ba2e8cf2` | 177,001 | 53,417 | 196,608 |
| `d314a822` | 991,512 | 94,081 | 196,608 |
| `08d7604d` | 400,907 | 51,752 | 196,608 |
| `8c892e4e` | 893,098 | 49,098 | 196,608 |
| `c689be83` | 1,278,034 | 94,731 | 196,608 |
| `a5f65c42` | 818,516 | 52,303 | 196,608 |
| `d1024be4` | 824,194 | 96,974 | 196,608 |
| `e5701595` | 419,425 | 49,346 | 196,608 |
| `7b364d6b` | 402,212 | 48,420 | 196,608 |
| `50491777` | 368,392 | 51,518 | 196,608 |
| `e66c6120` | 1,991,124 | 92,976 | 196,608 |
| `a8e946e7` | 4,555,770 | 51,377 | 196,608 |
| `0a7a80b4` | 2,023,494 | 96,105 | 196,608 |
| `c1131526` | 241,565 | 47,975 | 196,608 |
| `dbc6854d` | 200,442 | 48,959 | 196,608 |
| `d1b1eba1` | 8,226,127 | 97,309 | 196,608 |
| `7fab0a11` | 1,515,222 | 91,895 | 196,608 |
| `d8b055c7` | 759,826 | 91,149 | 196,608 |
| `61228a91` | 969,280 | 93,508 | 196,608 |
| `86514f66` | 3,818,724 | 85,645 | 196,608 |
| `0421090c` | 642,451 | 79,057 | 196,608 |
| `de748264` | 667,760 | 79,062 | 196,608 |
| `a29d7aba` | 1,268,709 | 77,752 | 196,608 |
| `96553c67` | 305,736 | 78,316 | 196,608 |
| `1d26101d` | 352,583 | 87,807 | 196,608 |
| `eb01eb3c` | 196,240 | 82,196 | 196,608 |

Each run asserts: the overflow wording is recognised, the **observed** window overrides the
declared one, the ladder reaches the zero-model tier, the projection ends up under
`fitRatio × window`, the surface stays well formed (`corrupt === false`), both fold boundaries
are balance-safe, the transaction bracket closes, and the replacement carries
`source.kind === 'compact-checkpoint'`. 34 of 157 captured logs on this machine are oversized; all 34 are rescued and none fail. Logs that are empty or already
fit are skipped rather than failed — the sweep (`node scripts/dev/scan-sessions.mjs`) reports
`157 logs · 31 rescued · 0 failed`. The count fell from 34 to 31 when the surface
became exact: `tool/call` and `tool/ptc-dispatch` are event types that the host never puts on a
surface, so three logs that only looked oversized were already inside the window.

## 6. Known limits

- The rescue **cannot** help if the pinned head alone exceeds the window (nothing is foldable
  without destroying the user's first instruction); the plugin reports that case explicitly
  and delegates.
- The digest is heuristic. It preserves structure and pointers, not every token; a session
  rescued this way is expected to continue with a note rather than perfect recall.
- Marking a lane blocked is per-process. Restarting the host re-tries the proxy once, which is
  intentional: the proxy's policy may have changed.
- Tool-name discovery for T1 is by convention (`toolResultPruner` / `prune` / `toolPruner`);
  if a host exposes a differently named pruner the tier is skipped, not guessed.
