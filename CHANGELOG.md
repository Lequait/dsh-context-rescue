# Changelog

## 0.1.0 — unreleased

First release. The plugin listens on `agent/request-error`, the same waterfall the host's own
compaction uses, and turns a context-window rejection into a rewritten projection that the next
attempt can send. It never needs the model to summarise anything, so it keeps working on a lane
where a proxy owns compression.

### Fixed while validating against the host's own session class

- The planner read `session.events`, which the host's own `Session` does not expose. On a real
  session that produced zero events and "nothing foldable"; it now reads `snapshotEvents()` (then
  `ownEvents()`, then `events`) through one helper.
- The replay shells counted `tool/call` and `tool/ptc-dispatch` as surface nodes. The host's
  `isSurfaceEligibleType` reports both as not eligible, so replayed projections were wider than
  real ones and three logs looked oversized when they already fit.

### Rescue

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
  summarise, leaving both the engine and the container intact.

### Entry points

- Model tools: `context_rescue` (`status` / `rescue`), `context_rescue_estimate`,
  `context_rescue_fold`.
- Human commands: `/rescue`, `/rescue status`, `/rescue-status`, registered opportunistically so a
  profile without the command service still gets the automatic rescue.

### Verification

- 44 unit tests, including a replay of a real captured session log and of the exact wording from
  the upstream report.
- A sweep of every session log on the development machine: 157 logs, 31 oversized, 31 rescued,
  0 failures.
- The host's own `Session` class, loaded out of the app bundle, seeds 157 captured logs and folds
  65 of them in-process: every append is validated by the host's `validateSessionEventData`, the
  projection by its `SurfaceManager`, and the derived history never keeps an orphan tool result.
- The app's own CLI (`dsh plugin --profile <name> add <tarball>`) installs the packed tarball into
  a real profile, which then depends on the plugin and lists its bundle; the host loader resolves
  the patch from inside that profile (10 assertions, throwaway profile removed).
- The marketplace path runs end to end: the published index is fetched over HTTPS, validated by the
  host's `parseMarketIndex`, turned into an install spec by `marketInstallTarget`, and that pinned
  commit is installed into a profile and loaded through the host's bundle loader (17 assertions).
- A mount check inside the installed host's own cordis container (23 assertions, including the
  host's real `CommandRuntime`), a package install smoke (16 assertions) and a publish rehearsal
  against a bare remote (18 assertions).
