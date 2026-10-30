# Changelog

## 0.1.0 — unreleased

First release. The plugin listens on `agent/request-error`, the same waterfall the host's own
compaction uses, and turns a context-window rejection into a rewritten projection that the next
attempt can send. It never needs the model to summarise anything, so it keeps working on a lane
where a proxy owns compression.

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
  with `dsh-smart-compact` and with the built-in engine.

### Entry points

- Model tools: `context_rescue` (`status` / `rescue`), `context_rescue_estimate`,
  `context_rescue_fold`.
- Human commands: `/rescue`, `/rescue status`, `/rescue-status`, registered opportunistically so a
  profile without the command service still gets the automatic rescue.

### Verification

- 43 unit tests, including a replay of a real captured session log and of the exact wording from
  the upstream report.
- A sweep of every session log on the development machine: 157 logs, 34 oversized, 34 rescued,
  0 failures, largest 8,226,127 → 97,309 tokens.
- A mount check inside the installed host's own cordis container (23 assertions, including the
  host's real `CommandRuntime`), a package install smoke (16 assertions) and a publish rehearsal
  against a bare remote (18 assertions).
