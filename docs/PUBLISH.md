# Publishing this plugin

Everything that can be built without credentials is already done and green:

| Gate | Command | Result |
|---|---|---|
| Unit + fold + rescue + repair + trim + tools + commands + schema + market + listing rules | `npm test` | 140 tests, 137 pass, 3 skipped (host-only) |
| Same suite under the app's own Node | `npm run test:host` | 140 tests, 138 pass, 2 skipped |
| JSDoc type contract over `index.js` + `lib/` | `npm run typecheck` | 0 errors in 14 files |
| Four failure scenarios | `npm run simulate` | all pass |
| Mount in the installed host's cordis 4 | `npm run mount-check` | 26 assertions pass |
| Pack → install → host bundle resolution | `npm run install-smoke` | 16 assertions pass (tarball contents, installed manifest, host loader, compatibility, imported entry, bare-specifier resolution) |
| Publish flow against a throwaway remote | `npm run publish:rehearse` | 18 assertions pass (first push renames `master` to `main`, a repository that already publishes `master` keeps it, host-accepted index entry, pinned commit, install spec) |
| Sweep of every captured session log | `npm run scan` | 216 logs, 34 oversized, 34 rescued, 182 skipped, 0 failed |
| The real application boots and mounts the bundle | `npm run boot-check` | 33 assertions: a planted throw is reported under the plugin entry, the real package mounts without one, it still mounts next to `billion-context` (lane owner) and next to `dsh-smart-compact` (engine overrider), it composes into the `web` shape the desktop app runs (same tree as the bundle that renders commands), and that host is then started for real: it prints its URL, hands out the auth cookie, and serves the UI document |
| The host's own `Session` class (from the app bundle) | `npm run host-session` | 216 logs seeded, 70 folded (32 via pre-flight), 146 unseedable/skipped, 0 failed |
| Cost of a rescue and of the pre-step check | `node scripts/dev/rescue-bench.mjs` | rescue median 1.1 s, p95 7.9 s over the 19 largest captured logs (most of it is loading the log); pre-flight median cold 16 ms, warm 0 ms — the second check in a turn does not re-measure |
| The host's real compaction engine in the slot | `npm run coexist` | 14 assertions: `compaction-basic` keeps the slot, the borrow fails without a model, the zero-model fold finishes, the transaction closes |
| Installed the way a user installs it | `npm run e2e-install` | 10 assertions: `dsh plugin --profile … add <tarball>` creates the profile, switches the bundle on, and the host loader resolves the patch from it; the profile is removed afterwards |
| Installed from the published spec | `npm run e2e-install -- --git` | 11 assertions through the same CLI, but with `git+https://github.com/Lequait/dsh-context-rescue.git#<ref>` — the line the README tells users to run — so the git source, not just the tarball, is proven to install and register |
| Installed from npm | `npm run e2e-install -- --npm` | 11 assertions through the same CLI, with `dsh-context-rescue@<version>` — the registry listing people actually install — and it checks the recorded dependency carries the published version |
| Installed the way a Discover page would | `npm run market-install` | 17 assertions: fetches the published index, hands it to the host's `parseMarketIndex`, asks `marketInstallTarget` for the spec, installs exactly that pinned commit, and confirms the host loader finds the patch in the installed copy — the one row that would otherwise only fail after publishing |
| The declared config schema, used by the host | `npm run schema-check` | 11 assertions: the dump projects our entry onto one of its own `config` defs (not `unknownConfig`), that def lists the knobs we accept and keeps the bound on `retainRatio`, an out-of-range patch stops the boot naming the option and its bound, and a valid patch boots past configuration |
| Market index entry | `npm run market -- --repo-slug OWNER/dsh-context-rescue` | validated by the host |

What remains needs an authenticated remote: nothing in the list above can create or write to a
hosted repository on its own.

The log-derived counts (`216 logs`, `34 rescued`, `70 folds`, `146 skipped`) and the bench
timings below are a snapshot of this development machine: they move as sessions are captured, and
`scan`, `host-session` and `rescue-bench` recompute them.

## 1. Create the repository

<https://github.com/Lequait/dsh-context-rescue> exists and carries `master`. The run was:

```bash
npm run publish:remote -- --repo Lequait/dsh-context-rescue --dry-run   # print the plan only
npm run publish:remote -- --repo Lequait/dsh-context-rescue
```

The branch stayed `master` because that repository was created with `master` as its default, and
the script only renames when the remote has no such branch at all. A fresh repository without a
default branch gets `main`.

For a new repository, either create an empty one on GitHub (no README, no license — this checkout
already has both) and run the same command, or by hand:

```bash
cd dsh-context-rescue
git remote add origin https://github.com/OWNER/dsh-context-rescue.git
git push -u origin main
```

…or, if the repository was created from elsewhere, push this bundle instead of a working copy:

```bash
git clone dsh-context-rescue-0.2.2.bundle dsh-context-rescue
cd dsh-context-rescue && git remote add origin <URL> && git push -u origin main
```

Without a token, HTTPS push goes through the git credential helper, whose GitHub OAuth window is
enough — no token ever has to be typed. SSH needs a key (`ssh-keygen -t ed25519` then add
`~/.ssh/id_ed25519.pub` to GitHub). This machine has no `gh` CLI, but the DSH bundle's
`git-credential-manager.exe` was already signed in.

## 2. Mark it discoverable

- Repository topic: `dsh-plugin` (this is the topic the ecosystem's listings scan for).
- `publish:remote` already regenerated and pushed `market/index.json`; regenerate it by hand once a
  release is pushed, so a listing does not keep offering the previous build. The file is committed,
  so a fresh checkout already contains it; `.gitignore` lists it only because `publish:remote`
  rewrites it on every push, and the committed copy must always pin a commit that exists:

  ```bash
  npm run market -- --repo-slug OWNER/dsh-context-rescue --out market/index.json
  git add market/index.json && git commit -m "chore: market index entry" && git push
  ```

  The entry pins a commit, so regenerate it whenever you want a listing to point at a newer
  build. Serve `market/index.json` from the repository's raw URL, or publish it anywhere HTTP
  reachable, then add that URL as an index source in Discover (the market bundle starts with
  `indexes: []`, so nothing is listed until a source is added).

- Live values for this repository (checked 2026-10-30): index URL
  `https://github.com/Lequait/dsh-context-rescue/raw/master/market/index.json` (HTTP 200,
  accepted by the host's `parseMarketIndex`), jsDelivr mirror
  `https://cdn.jsdelivr.net/gh/Lequait/dsh-context-rescue@master/market/index.json` (HTTP 200),
  topics already set to `compaction, context-window, deepseek-harness, dsh-plugin, slash-commands`.
- Two routes for a user, both exercised here: install straight from git
  (`dsh plugin --profile <p> add git+https://github.com/Lequait/dsh-context-rescue.git#<commit>`,
  proven by `npm run e2e-install -- --git` and `npm run market-install`), or add the index URL as
  an index source and install the pinned commit from the Discover page. The official market
  bundle (`@deepseek-ai/dsh-plugin-market`) is optional — a profile without it still installs
  from the git spec.

## 3. Listing pull request

The list is generated from data files, so a submission is **one YAML file**, not a README line:
`data/plugins/Lequait__dsh-context-rescue.yml` (this repository keeps the exact content in
[`awesome-entry.yml`](awesome-entry.yml)). Verified against
[`contributing.md`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md):

```yaml
url: https://github.com/Lequait/dsh-context-rescue
name: Lequait/dsh-context-rescue
category: session
description:
  en: Recovers a session the host already refused for exceeding the context window — it re-checks
    the gateway message the built-in classifier misses, takes the real window out of that message,
    and folds the oldest span into one checkpoint without a model call (tool-result pruning, the
    host compaction engine, or a mechanical digest fold), then retries the failed step.
  zh: 抢救已经被上下文窗口拒掉的会话：补上宿主分类器漏判的网关文案，从失败信息里拿到真实窗口，
    不调用模型把最旧的一段历史折成一个检查点（工具结果裁剪、借宿主压缩引擎、或纯机械摘要折叠），
    然后重试失败的那一步。
```

Requirements that apply to this repo, checked against the guide on 2026-10-30:

| Rule | State |
| --- | --- |
| `dsh.bundle` manifest in `package.json` | present (`bundle.patch`) |
| [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic | set on `Lequait/dsh-context-rescue` |
| real, working code | 140 tests, ninth host-side gate |
| repo at least **1 day old** | created 2026-10-30T10:28Z, so submit no earlier than 2026-10-31T10:28Z |
| description states function only | no superlatives; every claim above maps to `lib/` |

Open the pull request from a fork (the maintainers regenerate both READMEs on merge):

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cp <this repo>/docs/awesome-entry.yml data/plugins/Lequait__dsh-context-rescue.yml
git checkout -b add-dsh-context-rescue
git add data/plugins/Lequait__dsh-context-rescue.yml
git commit -m "Add Lequait/dsh-context-rescue"
git push -u origin add-dsh-context-rescue
```

What that list's own CI will check, reproduced locally before submitting (2026-10-31): the entry
file placed exactly at `data/plugins/<owner>__<repo>.yml`, `node scripts/generate-readme.mjs`
regenerating both READMEs to 7925 entries with `--check` clean afterwards, the four rule suites
(`added-dates`, `capabilities`, `adopt-discussions`, `entries-path`) passing 3 / 9 / 9 / 3, and
`SKIP_PUBLISH_CHECKS=1 node scripts/build-site.mjs` building the site with the entry included —
the added-date is derived from git history, so the build only accepts a committed entry, which is
what a pull request produces. `npx awesome-lint` could not be reproduced here: on Windows it reads
the README's own path as the repository URL (`Invalid GitHub repo URL: G:\Temp\awesome-check\README.md`)
and the same failure occurs on an untouched clone, so lint remains a CI-side check rather than a
local one.

### 3a. Listings submitted on 2026-10-30

`awesome-dsh-plugin` has a one-day age rule, so that one is scheduled for the next day. Two other
lists took the submission immediately, both through the GitHub API (fork → one-line commit → pull
request), with no clone in between:

| List | What was submitted | Status |
| --- | --- | --- |
| [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) | one line under **Context & Search** in `README.md` and `README.zh-CN.md` — the guide requires both languages in the same PR | [PR #768](https://github.com/0xsline/awesome-deepseek-harness/pull/768), open, mergeable, 2 files / +2 lines |
| [AdamPlatin123/dsh-plugin-radar](https://github.com/AdamPlatin123/dsh-plugin-radar) | one row in the 🔌 单插件 table of `PLUGINS.md` (this list also auto-discovers repos carrying the `dsh-plugin` topic every day at 02:00) | [PR #986](https://github.com/AdamPlatin123/dsh-plugin-radar/pull/986), open, mergeable, 1 file / +1 line |
| [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | `data/plugins/Lequait__dsh-context-rescue.yml` | waiting on the one-day age rule; scheduled for 2026-10-31 |


### 3b. Second wave, through a plan file

Every list wants the same edit in a slightly different wrapper — one line in one README, two lines
in two READMEs, a row in a category file — so the second wave is driven by a plan file instead of a
one-off script. `market/listings/<list>.json` says which file, which anchor line, and what to insert;
`scripts/dev/list-plan.mjs` validates it offline; `scripts/dev/submit-list.mjs` performs it
(fork → branch → `PUT contents` → pull request) and refuses to guess when an anchor matches more
than one line or the entry is already there.

```sh
npm run list-pr -- --plan market/listings/kejixiaoliang.json --dry-run
npm run list-pr -- --plan market/listings/kejixiaoliang.json
```

| List | What was submitted | Status |
| --- | --- | --- |
| [kejixiaoliang/awesome-dsh-plugins](https://github.com/kejixiaoliang/awesome-dsh-plugins) | one line in `plugins/context-memory.md`, under **上下文审计 / 压缩 / 蒸馏** | [PR #173](https://github.com/kejixiaoliang/awesome-dsh-plugins/pull/173), open |
| [beancookie/awesome-dsh-plugin](https://github.com/beancookie/awesome-dsh-plugin) | planned in `market/listings/beancookie.json`: one line in `README.md` and `README.en.md`, under **Sessions & Messages** | not submittable from this account, see below |
| [GordenSun/awesome-dsh-plugins](https://github.com/GordenSun/awesome-dsh-plugins) | planned in `market/listings/gordensun.json`: one line each in `README.en.md` and `README.md`, under **Orchestration, memory, and workflow** | same constraint |
| [bruc3van/awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin) | not attempted | same constraint |
| [Alex-Yanggg/awesome-DSH-plugin](https://github.com/Alex-Yanggg/awesome-DSH-plugin) | not attempted | same constraint (`awesome-DSH-plugin` and `awesome-dsh-plugin` are one name to GitHub) |

The blocker is worth recording because it is not obvious from any list's rules: **GitHub allows one
fork per repository name per account.** `Lequait/awesome-dsh-plugin` is already a fork of
`awesome-dsh-plugin/awesome-dsh-plugin` (first wave), and `Lequait/awesome-dsh-plugins` is the fork
made for the `kejixiaoliang` PR. Every other list whose name is one of those two — up to case, since
GitHub treats `awesome-DSH-plugin` and `awesome-dsh-plugin` as the same name — shares that repository:
the local fork's `main` sits at a different commit than the upstream's, so creating a branch from the
upstream sha fails with `HTTP 422 Object does not exist`. `submit-list.mjs` now compares
`parent.full_name` before writing anything and reports this instead of the 422.

What is actually left: a list whose repository name is free (`diegosouzapw/awesome-omni-dsh-plugins`
is one, but it generates its READMEs from a catalog across 43 locales and validates them in CI, so it
wants a data-file PR rather than a line), or a second GitHub account, or waiting for the two open
forks to be merged and deleting them. The plan files stay in `market/listings/` so that any of those
paths is one command away.

## 4. npm

**Done: `dsh-context-rescue@0.2.2` went to npm by hand on 2026-10-31, and `0.2.3` went by tag** — `git push origin v0.2.3` ran `release.yml`, which published it through the `NPM_TOKEN` secret and left `latest` at `0.2.3`; `npm run e2e-install -- --npm` then installed that exact version into a throwaway profile. Publishing no longer needs a human with a terminal. The `NPM_TOKEN` repository
secret is set, so any future `git tag v*` publishes automatically through the release workflow.
`npm i dsh-context-rescue` resolves; a throwaway profile installs it and registers the bundle.

One artifact to know about: npm's staged publishing reserves a new name with a public
`0.0.0-stage` stub version. It cannot be removed through a granular token, so it was deprecated
instead (`npm deprecate dsh-context-rescue@0.0.0-stage "placeholder created by staged publishing;
install 0.2.2 or later"`), which is what a person sees if they ask for it by name. `latest` points
at 0.2.2, so a plain `npm i dsh-context-rescue` never resolves to the stub.

Either publish locally, through the guard script:

```bash
npm run publish:npm -- --dry-run   # refuses a dirty tree, checks the tarball list, proves the
                                   # version is not already taken; says so when you are not logged in
npm login                          # the only step that needs an account
npm run publish:npm                # publishes, then prints the install line
```

or let the release workflow do it from a tag — it runs the type check, the tests, the simulation,
the install smoke and the publish rehearsal first, refuses a tag that disagrees with
`package.json`, and publishes with provenance:

```bash
git tag v0.2.3 && git push origin v0.2.3   # NPM_TOKEN is already set; the workflow publishes
```

The package ships `index.js`, `lib/`, `cordis.patch.yml`, `market/icon.svg`, `docs/`, both
READMEs, `CHANGELOG.md` and the license — the tarball carries only the icon from `market/`, since
`market/index.json` is served from the repository; `publishConfig.access` is already `public`. After publishing, `--npm` in the market
generator switches the listed source from a pinned commit to `dsh-context-rescue@<version>`.
