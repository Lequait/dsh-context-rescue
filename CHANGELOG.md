# Changelog

> 从 0.2.5 起，本文件与 GitHub Release 说明用中文写；0.2.4 及更早保留英文原文。
> 发行页由 `release.yml` 从本文件对应版本段生成，所以这里写什么，Release 页就显示什么。

## Unreleased

### 变更

- **落地页改成中文。** `README.md` 现在是中文文档，英文版移到 `README.en.md`，两页顶部都有语言切换。包描述、仓库描述以及接下来的发行说明也一并以中文为主，让访客打开页面读到的就是它本来的写法，而不是另一份的译文。插件本身没有任何变化：代码、schema、命令、每一道闸门都没动。`package.json` 的 `files` 跟随改名，发出去的 tarball 仍然同时带两种语言。
- **工程笔记也改成中文。** `docs/PLAN.md`（工作计划与验证矩阵）与 `docs/PUBLISH.md`（发布与列表投稿手册）整篇翻成中文，命令、路径、闸门名、断言条数与所有数字保持原样，`docs/FEASIBILITY.md` 本来就是中文。顺带把两处已经过时的事实更新成现状：阶段 G 的"npm 还没发布、列表还在等年龄门槛"改成已发布 0.2.2–0.2.4 与 PR #10903，`host-session` 的日志数改成 222。
- **发行页以后由工作流自己建。** 之前 `release.yml` 只发 npm、不建 GitHub Release，于是 `v0.2.4` 有 tag 却没有页面（0.2.0–0.2.3 都是手工建的）。现在 `permissions` 给了 `contents: write`，末尾新增一步 `Create the GitHub release`：已存在就跳过，否则用 `scripts/dev/release-notes.mjs <version>` 从 `CHANGELOG.md` 取该版本段作为正文，`gh release create` 建页。取段落这件事有 6 个单测钉着（含 `v` 前缀、`. `按字面匹配、段落缺失时给指针而不是编造）。

### 修复

- **网络闸门在网络断掉时，以前会报红，而不是说明原因。** `market-install` 与 `e2e-install -- --git` 要连 `raw.githubusercontent.com` 和 `github.com`；连接死掉时（超时、`ECONNRESET`、路由被墙）闸门会抛 undici 的堆栈并记一行红，而这跟插件没有任何关系。现在它们会把请求重试三次（间隔渐宽），仍然连不上就打印 `SKIP` 与失败那一行并退 0；而主机应答了却给出错误制品，照旧判失败——因为分类只看连接层输出。`npm run verify:network` 把这些行显示为 `skip`，汇总里单独计数，不再算成通过。两个闸门脚本也不再在"安装压根没发生"时去读一个不存在的 manifest。

## 0.2.4 — 2026-10-31

### Fixed

- **`debug` was declared in the options and never read.** The key existed in the defaults and in
  the schema with the description "write structured diagnostics to the host logger", and no code
  path looked at it, so turning it on changed nothing. It now writes one line per decision —
  detected code and window, both measurements, every tier with the reason it declined (`skipped`
  or `error`), and the folded span — which is the only way to see *why* a session that is over the
  window was not rescued. `tests/rescue.test.js` covers both the off and on cases, and asserts the
  wiring through `apply()`, not just the helper.

### Changed

- **The rollback story is now written down and asserted, not assumed.** Uninstalling
  (`dsh plugin --profile <profile> remove dsh-context-rescue`) needs no cleanup, because a fold is
  only appended host events; and there is no un-fold, because `@deepseek-ai/dsh-session` has
  `compaction/start`, `compaction/prune` and `compaction/end` but no void event. `npm run
  host-session` now proves the first half on every log it folds: a fresh host `Session` seeded from
  the folded events — none of this plugin's code involved — derives the same messages, the same
  tool-call pairing and the same measured size.
- **A listing pull request is a plan file, not a script.** `market/listings/<list>.json` names the
  file, an anchor line and the line to insert; `scripts/dev/list-plan.mjs` validates it offline
  (entry shape, one edit per file, no duplicate) and `submit-list.mjs` performs it. An anchor that
  matches several lines, or an entry already present, is refused rather than guessed — the two ways
  a listing PR usually goes wrong.
- **`submit-list.mjs` explains a fork-name collision instead of failing with HTTP 422.** GitHub
  allows one fork per repository name, so forking a second list called `awesome-dsh-plugin` lands on
  the existing fork of a different upstream; the script now compares `parent.full_name` and says so.
- Submitted the plugin to [kejixiaoliang/awesome-dsh-plugins](https://github.com/kejixiaoliang/awesome-dsh-plugins)
  ([PR #173](https://github.com/kejixiaoliang/awesome-dsh-plugins/pull/173)).

### Verification

142 unit tests (139 pass, 3 skipped, 0 fail), 142 under the host's Node (140 pass), type check
clean, the core and host gate groups run end to end here (9/9 in 224 s, the sweep at 222 logs:
70 folded, 32 of them from the pre-flight path, 152 unseedable, 0 failures), and the six CI cells
green on the commit this version was cut from.

## 0.2.3 — 2026-10-31

### Fixed

- **`npm run verify` runs the gates as groups.** Sixteen gates had no single entry point; the
  three groups are `core` (3 gates, 8 s here), `host` (9 gates, 3 min 34 s) and `network`
  (4 gates, 1 min 30 s), each streamed and summarised, with a non-zero exit when any failed.
- **The listing rules are tested instead of hoped for.** `scripts/dev/awesome-plan.mjs` holds the
  clock gate, the `dsh-plugin` topic requirement and the entry-file shape, and
  `tests/awesome.test.js` (9 tests) drives them: a repository younger than a day is refused with
  the moment it opens, an entry with a category outside the list or no English description is
  refused before a pull request exists. `npm run awesome` uses the same functions, so what the
  test accepts is what the submission sends.
- **The npm placeholder is deprecated.** `0.0.0-stage` is what staged publishing leaves behind for
  a newly claimed name and a granular token cannot delete it; it now carries a message pointing at
  the real version.

### Verification

140 unit tests (137 pass, 3 skipped, 0 fail), 140 under the host's Node (138 pass), type check
clean, four simulated failure shapes, and the three gate groups above run end to end here.

## 0.2.2 — 2026-10-31

Six defects found by a read-only review of the runtime code, five of them ways the plugin could
look like it worked while doing nothing, or do something irreversible for the wrong reason.

### Fixed
- **A "nothing can help" verdict is now tied to the history it was reached on.** The verdict was
  keyed to the window only, so a session that failed because the foldable span was under
  `minFoldTokens`, or because an oversized node sat at an unbalanced cut, stayed written off after
  the user had typed enough for either condition to stop being true. The guard now compares the
  surface (last seq and node count) and measures again when it moved. Window changes still drop
  the verdict, as before.
- **`maxAttemptsPerTurn: 1` no longer disables the ladder.** The "the projection already fits, retry
  unchanged" shortcut consumed the only attempt the turn had, so the host re-sent the same body,
  the second failure hit the budget, and no tier ever ran. The shortcut is now skipped when the
  budget is one.
- **`mode: 'fold'` means something.** The ladder guard tested `config.mode !== 'prune'`, and `prune`
  is not an accepted mode, so `fold` behaved exactly like `auto`. `fold` now skips the host
  compaction engine — the one tier that may ask a model to summarise — and keeps the zero-model
  tiers, which is what the name promised.
- **A bracket that never opened is no longer closed.** `compaction/start` was appended inside the
  try whose catch appends `compaction/end`; if the start itself failed, the log ended with a
  terminal marker for a compaction that never began. The start moved outside the try.
- **`context_rescue` reports `ok: false` when it folded nothing.** A session that already fit came
  back as `{ok: true, action: 'retry'}` with an unchanged projection, which reads to a model as
  "context was freed". The result now carries `attempted` and `ok` requires it.
- **Weak overflow signals no longer decide alone.** Three weak probes ("413", "invalid request", a
  byte figure) used to reach the threshold on their own, so a gateway error body that merely echoed
  the request's own numbers could trigger an irreversible fold — and, on the retry, a second one.
  A strong wording, a user-supplied `extraPatterns` match, or a strong-ish wording next to real
  numbers is now required.
- A fold now refuses to append if the surface moved between planning and writing (`expectedSeq`),
  so a future refactor that introduces an `await` there fails loudly instead of writing a replace
  for seqs the surface no longer has.

### Verification
- 122 unit tests (119 pass, 3 skipped, 0 fail), 122 under the host's Node (120 pass), type check
  clean in 14 files, four simulated failure scenarios, 26 assertions inside the installed host's
  cordis container, and the two real-log sweeps at 200 logs: 69 folded under the host's own
  `Session` class (31 of them pre-flight) and 33 rescued by the full ladder, 0 failures in both.
- The registry spec is now a gate: `npm run e2e-install -- --npm` installs `dsh-context-rescue@<version>`
  through the app's own CLI and checks the recorded dependency, so the listing people use is
  proven rather than assumed. The published tarball is unchanged — `scripts/` is not in `files`.
- Published to npm: `dsh-context-rescue@0.2.2` (`latest`), with the `NPM_TOKEN` repository secret
  set so later tags publish through the release workflow. npm keeps a public `0.0.0-stage` stub
  version for a newly claimed name; it cannot be deleted with a granular token, so it was
  deprecated with a message pointing at 0.2.2.
- Session-log counts in the older sections are the numbers as measured on the day of that release;
  the machine keeps writing sessions, so they are snapshots, not constants.

## 0.2.1 — 2026-10-31

### Config schema
- Every option is declared as a Cordis/Schemastery schema (`lib/schema.js`, exported as `Config`),
  so the host validates a profile patch before the plugin starts and documents the options in
  `--dump-config-schema`. An out-of-range value now stops the boot with the field and its bound
  (`$.retainRatio expected number <= 0.6 but got 5`) instead of being clamped in silence. Unknown
  keys are still passed through so the mount-time `config:` warning can name a typo.
- New gate `npm run schema-check`: 11 assertions against the installed app (the dump projects this
  entry onto one of its own config defs, the def lists the knobs, a bad patch fails the boot, a good
  patch boots past configuration).

### CI
- Every job installs the dependency tree now. The schema library is a runtime dependency, and the
  workflow used to install only for the type-check job, so four of six jobs failed to resolve it
  while the two that installed looked green.

### Evidence refreshed
- Session-log counts re-measured on the development machine: 200 logs, 33 oversized, 33 rescued,
  0 failed; the host's own `Session` class seeds 200, folds 69 (31 of them pre-flight), 0 failed.

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

- Every option is now declared as a Cordis/Schemastery schema (`lib/schema.js`, exported as
  `Config`). The host validates a profile patch before the plugin starts and documents the options
  in `--dump-config-schema`, instead of treating them as unknown configuration. An out-of-range
  value stops the boot with the field and its bound: `$.retainRatio expected number <= 0.6 but got 5`.
  Unknown keys are still passed through, so the mount-time `config:` warning can name a typo;
  an unknown `mode`, out-of-range ratios and a `targetRatio` that is not below `fitRatio` are
  logged the same way. A plugin that silently ignores a typo behaves like a plugin that is not
  installed.

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
- A four-tier ladder, each tier tried only if the previous one did not produce a projection that
  fits: tool-result pruning → the host's own compaction engine (borrowed, never taken) → a
  mechanical digest fold written with the host's `compaction/prune` protocol → the head-and-tail
  excerpt of a single message that folding around it would otherwise leave behind.
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

- 107 unit tests, including a replay of a real captured session log and of the exact wording from
  the upstream report.
- A sweep of every session log on the development machine: 196 logs, 33 oversized, 33 rescued,
  0 failures.
- The digest is read by a person as well as by a model: tool calls render as what they were for,
  a repeated call collapses to one line plus a count, harness plumbing (runtime snapshots, skill
  catalogues, memory projections, time samples) is never listed as user intent, and a goal restated
  every round appears once.
- The host's own `Session` class, loaded out of the app bundle, seeds 196 captured logs and folds
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
