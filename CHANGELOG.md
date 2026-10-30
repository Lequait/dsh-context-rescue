# Changelog

## 0.2.0 — 2026-10-31

Everything below shipped after 0.1.0 went public (repository and market index).

### What 0.2.0 adds on top of 0.1.0
- A pre-flight check on `agent/pre-step` that folds *before* the request is built, so the
  expensive path (a 400, then a retry) is no longer the first line of defence.
- A fourth tier that replaces a single message -- or one tool call and its result -- that is
  too large to survive inside the window, keeping its head and tail.
- Self-healing for a compaction transaction a crash left open, and a checkpoint that keeps the
  file paths out of tool arguments that used to live inside JSON strings.
- `/rescue-status` previews what a rescue would do, counts the request the host would actually
  send, and names the exhausted-verdict case instead of claiming nothing could be folded.

### The listener, unchanged since 0.1.0

The plugin listens on `agent/request-error`, the same waterfall the host's own
compaction uses, and turns a context-window rejection into a rewritten projection that the next
attempt can send. It never needs the model to summarise anything, so it keeps working on a lane
where a proxy owns compression.

### Tools
- **The three tools are now covered the way the hooks are.** Measured coverage of
  `lib/tools.js` was 55% of lines and 14% of functions: registration was asserted,
  execution was not. `tests/tools.test.js` now drives `context_rescue` (status and
  rescue), `context_rescue_estimate` (a pasted gateway message) and
  `context_rescue_fold` through a registry that enforces the host's contract, and
  pins the two shapes that matter in practice: a tool call with no session returns
  `{ ok: false, error }` instead of throwing, and a manual fold with no turn number
  still closes its compaction transaction (the host accepts an absent `turn` — a
  probe against the host's own `Session` showed the event is written and accepted).

### Rescue
- **A fold is previewed before it happens.** `/rescue-status` and `context_rescue`
  with `action: "status"` now say which nodes a rescue would replace (and their
  sequence range), how many tokens that is, how long the summary would be and how
  much recent history would survive. The preview writes nothing; it computes the
  same plan `/rescue` would execute and throws it away.

- **The request size is measured, not just the surface.** `deriveMessages()` is what
  the provider receives; `/rescue-status` now reports its size next to the surface
  price, and the host gate asserts that after every fold the derived request is
  smaller than before and inside the window (65 of 65 folding logs pass).

- **A defeated session is not measured twice.** If every tier fails for a session
  (a system prompt alone can be over the window), the plugin remembers that and
  stops re-measuring it on each request, so the failure costs one attempt instead
  of one full measurement per request. `/rescue` still forces another try, and a
  rescue that works reopens the normal path.

### Fixed while validating against the host's own session class

- The planner read `session.events`, which the host's own `Session` does not expose. On a real
  session that produced zero events and "nothing foldable"; it now reads `snapshotEvents()` (then
  `ownEvents()`, then `events`) through one helper.
- The replay shells counted `tool/call` and `tool/ptc-dispatch` as surface nodes. The host's
  `isSurfaceEligibleType` reports both as not eligible, so replayed projections were wider than
  real ones and three logs looked oversized when they already fit.

### Fixed
- **A "nothing can save this" verdict outlived its window.** The flag that stops the plugin
  re-measuring a defeated session was permanent, so switching to a model with a larger window --
  the obvious move when a session is stuck -- left the plugin still looking away, and the user
  saw the same failure. The verdict is now tied to the window it was reached under and dropped
  when that window changes, in both the failure path and the step check.
- **The status preview stopped at folding.** When nothing could be folded it reported "a rescue
  would find nothing to fold", even though T4 would have excerpted an oversized message — the one
  case where a person most needs to know what is about to happen. The preview now asks the same
  picker the ladder uses, with the same size floor, and names the message it would cut.
- **Excerpts spare the message you just typed.** T4 used to pick the largest message
  anywhere in the projection, which could be the file pasted into the current turn. It now
  prefers older history and only cuts the current turn's message when nothing older is large
  enough to bring the request under the window.

- File paths in tool arguments were invisible to the checkpoint. The host stores arguments as a
  JSON text blob, so the tree walk found no path leaves and the "files touched" section stayed
  empty on exactly the sessions that needed it. Paths are now also read out of the text, with
  doubled separators collapsed and escape sequences that resemble drive letters rejected.

- A single tool result larger than the window could not be rescued: it is not a text message, so
  T4 skipped it, and dropping it alone would orphan the call that produced it. The call and its
  result are now replaced together, which is the only removal that keeps pairing balanced.

- A mechanical fold that left the projection over the window was reported as a rescue, so the
  host retried a request that was certain to fail again. Tiers now claim success only when the
  result actually fits, and the ladder continues to the tier that can still cut.
- T4 would have excerpted the system prompt if it were the largest node. The instructions are not
  history: they are never replaced, and the ladder says the session cannot be shrunk instead.

- An oversized single message was invisible to T4 whenever anything else sat on the surface: the
  pairing cuts were computed over the raw log (which also carries `tool/call` mirrors and
  compaction brackets) instead of over the surface nodes, so every index was shifted and no
  candidate ever looked balanced. Cuts now come from the same node list the measurement uses.

- A session whose *first* message alone is over the window was not rescued at all: the planner
  kept the head pinned, found nothing else big enough to fold, and reported "nothing foldable".
  The pin is now a budget decision -- when the pinned message alone is over the target it is
  folded like anything else, and the digest says so, because keeping it would keep every request
  failing.

### Rescue

- pre-flight measures once per turn and then only counts the events appended since, so the check
  that runs before every step is not a full re-pricing of the projection; a large paste or a
  surface changed elsewhere forces a real measurement again.

- **A message that cannot be folded around.** Every other tier replaces a *span* of history. When
  the overshoot is a single message -- a large file pasted into the newest turn -- there is no
  span: folding around it leaves the message that does not fit. That message is now replaced by
  its own head and tail (`excerptChars`, default 3000 each) with the original length and the
  dropped middle stated in the checkpoint. Only text messages whose removal keeps tool pairing
  balanced qualify, so the pass can never orphan a tool result. Runs in both the failure ladder
  and the pre-flight path, and can be switched off with `trimOversizedMessages: false`.

### Self-healing

- A fold is a bracket (`compaction/start` … `compaction/end`) written inside one turn, and a
  process that dies in between leaves it open. A dangling start makes the planner refuse every
  later fold -- correctly, because it cannot tell a half-written fold from a live one -- so that
  session could never be rescued again. A leftover bracket from an *earlier* turn is now closed
  with an explanatory `error` before planning; one opened in the current turn is never touched.
  `/rescue-status` lists any that are still open.

### Configuration

- Options are validated at mount: unknown keys, an unknown `mode`, out-of-range ratios and a
  `targetRatio` that is not below `fitRatio` are logged as `config:` warnings. A plugin that
  silently ignores a typo behaves like a plugin that is not installed.

### Rescue

- **Pre-flight.** The same rescue also runs on `agent/pre-step`: when the projection is already
  larger than the model window, nothing can be sent, so it is folded before the request is built.
  Only a hard overflow is acted on -- the pressure band stays with the host's own compaction
  policy -- and T2 is skipped so one overshoot is never compacted twice. The window is resolved
  from the provider named in the session header and cached per target.
- Detection that does not depend on the host's own classifier: strong wording probes, code
  matches, and a scoring rule where numbers alone never trigger a rewrite.
- The window is the smaller of the declared context window and the number quoted in the failure
  text, so a gateway that enforces less than the model advertises is handled instead of ignored.
- A three-tier ladder, each tier tried only if the previous one did not produce a projection that
  fits: tool-result pruning → the host's own compaction engine (borrowed, never taken) → a
  mechanical digest fold written with the host's `compaction/prune` protocol.
- Fold boundaries are always tool-call/tool-result pairs, computed with the host's own balance
  rule (only `assistant/message` tool-call blocks push the counter, only `tool/result` pops it).
- A projection that already fits is retried untouched; a second rejection in the same turn forces
  the ladder instead of repeating the identical request.
- Two attempts per turn, so a rescue that keeps failing cannot become a retry storm; anything
  unexpected is logged and handed back to the host rather than thrown out of the waterfall.

### Interoperability

- If a proxy refuses the host's compaction on this lane (billion-context answers
  `dsh_compaction_refused`), the refusal is remembered and the zero-model path is used from then
  on.
- The `compaction` service slot is never registered; the plugin only borrows it, so it composes
  with `dsh-smart-compact` and with the built-in engine. A coexistence gate mounts
  `dsh-compaction-basic` next to the plugin and rescues anyway when that engine cannot
  summarise, leaving both the engine and the container intact. The borrow matches the signature
  `dsh-smart-compact@0.5.3` publishes (`compactIfNeeded(agent, trigger, signal)`, refusal →
  `null`), and an engine that throws for its own reasons neither counts as a lane refusal nor
  stops the zero-model fold.

### Entry points

- Model tools: `context_rescue` (`status` / `rescue`), `context_rescue_estimate`,
  `context_rescue_fold`.
- Human commands: `/rescue`, `/rescue status`, `/rescue-status`, registered opportunistically so a
  profile without the command service still gets the automatic rescue.

### Folding never deletes

- A fold only appends. Every original event stays in the session log and `eventAt` still resolves
  it; only the projection stops containing it. That is the whole rollback story: a wrong fold
  costs one projection, not the conversation. A test asserts the log keeps every event and the
  surface keeps none of the folded ones.

### Verification

- 82 unit tests, including a replay of a real captured session log and of the exact wording from
  the upstream report.
- A sweep of every session log on the development machine: 174 logs, 32 oversized, 32 rescued,
  0 failures.
- The digest is read by a person as well as by a model: tool calls render as what they were for,
  a repeated call collapses to one line plus a count, harness plumbing (runtime snapshots, skill
  catalogues, memory projections, time samples) is never listed as user intent, and a goal restated
  every round appears once.
- The host's own `Session` class, loaded out of the app bundle, seeds 174 captured logs and folds
  65 of them in-process (30 of those through the pre-flight path, with no failed request first): every append is validated by the host's `validateSessionEventData`, the
  projection by its `SurfaceManager`, and the derived history never keeps an orphan tool result.
- The real application boots with the bundle installed: a copy whose `apply()` throws is reported by
  the host under the plugin's own entry (so a silent skip cannot pass as success), the real package
  boots past mounting with no error of its own, and it still mounts after `billion-context` — the
  proxy that owns the compression lane on some machines — is installed into the same profile
  (33 assertions, five throwaway profiles removed; the extra ones pair the bundle with
  `dsh-smart-compact`, the plugin that replaces the compaction engine, and start the `web` shape the
  desktop app runs, which must print its URL and serve the UI with the plugin mounted).
- The app's own CLI (`dsh plugin --profile <name> add <tarball>`) installs the packed tarball into
  a real profile, which then depends on the plugin and lists its bundle; the host loader resolves
  the patch from inside that profile (10 assertions, throwaway profile removed).
- The marketplace path runs end to end: the published index is fetched over HTTPS, validated by the
  host's `parseMarketIndex`, turned into an install spec by `marketInstallTarget`, and that pinned
  commit is installed into a profile and loaded through the host's bundle loader (17 assertions).
- A mount check inside the installed host's own cordis container (25 assertions, including the
  host's real `CommandRuntime`), a package install smoke (16 assertions) and a publish rehearsal
  against a bare remote (18 assertions).

## 0.1.0 — 2026-10-30

First published version: the `agent/request-error` listener, the three tiers that never need the
model (`toolResultPruner` prune, a borrowed host compaction engine, and a zero-model mechanical
fold), the `/rescue` and `/rescue-status` commands, and the three model-facing tools. Pinned by the
market index entry, so `dsh plugin add git+https://github.com/Lequait/dsh-context-rescue.git` at
that commit still installs exactly this.
