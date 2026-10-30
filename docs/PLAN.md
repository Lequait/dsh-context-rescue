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
`context_rescue_estimate`, `context_rescue_fold`. Tools return data, never throw.

Gate: exercised through the fake context in `tests/rescue.test.js` → **passed**.

### Phase F — Simulation and replay (done)

- `scripts/simulate.js` replays three scenarios against the real plugin code: (1) the #10138
  chain, (2) a proxy lane refusal, (3) an un-foldable single mega-message that must be
  delegated. A bug found here — the measurement path used the digest's 2000-char clamp, so a
  480k-char message priced at 1,992 tokens — was fixed by splitting raw from rendered text.
- `tests/replay-real-log.test.js` folds a log captured from a real session and re-verifies the
  host invariants on the result.

Gate: three simulation scenarios green; four real logs green (see §5) → **passed**.

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
can be produced without them exists: two commits, a validated index entry, the installable
bundle shape.

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
| Host container mount | plugin mounts in the installed app's cordis 4 and the tools land on the real `tools` service | verified by `scripts/dev/mount-check.mjs` (10 assertions) |
| Installed package | `npm pack` output installs as a dependency and the host bundle loader resolves `cordis.patch.yml` from the installed path | verified by `scripts/dev/install-smoke.mjs` |

## 5. Real-log evidence

`DSH_SESSION_LOG=<path> node --test tests/replay-real-log.test.js`, on logs from this machine:

| Session | Events | Surface nodes | Estimated tokens | After fold | Nodes after |
|---|---|---|---|---|---|
| `d314a822` | 7130 | 956 | 991,512 | 298,595 | 169 |
| `9a608fe8` | 4915 | 2232 | 933,308 | 241,381 | 507 |
| `abc05855` | 1006 | 482 | 306,317 | ~84,529 | 183 |
| `8697fd97` | 864 | 382 | 175,204 | 56,897 | 165 |

Each replay asserts: the surface is well formed (`corrupt === false`), both fold boundaries
are balance-safe, the projection shrinks, the transaction bracket closes, and the replacement
carries `source.kind === 'compact-checkpoint'`.

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
