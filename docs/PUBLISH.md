# Publishing this plugin

Everything that can be built without credentials is already done and green:

| Gate | Command | Result |
|---|---|---|
| Unit + fold + rescue + commands + market rules | `npm test` | 44 tests, 41 pass, 3 skipped (host-only) |
| Same suite under the app's own Node | `npm run test:host` | 44 tests, 42 pass, 2 skipped |
| JSDoc type contract over `index.js` + `lib/` | `npm run typecheck` | 0 errors in 12 files |
| Three failure scenarios | `npm run simulate` | all pass |
| Mount in the installed host's cordis 4 | `npm run mount-check` | 23 assertions pass |
| Pack → install → host bundle resolution | `npm run install-smoke` | 16 assertions pass (tarball contents, installed manifest, host loader, compatibility, imported entry, bare-specifier resolution) |
| Publish flow against a throwaway remote | `npm run publish:rehearse` | 18 assertions pass (first push renames `master` to `main`, a repository that already publishes `master` keeps it, host-accepted index entry, pinned commit, install spec) |
| Sweep of every captured session log | `npm run scan` | 157 logs, 31 oversized, 31 rescued, 0 failed |
| The host's own `Session` class (from the app bundle) | `npm run host-session` | 157 logs seeded, 65 folded, 92 unseedable/skipped, 0 failed |
| The host's real compaction engine in the slot | `npm run coexist` | 14 assertions: `compaction-basic` keeps the slot, the borrow fails without a model, the zero-model fold finishes, the transaction closes |
| Installed the way a user installs it | `npm run e2e-install` | 10 assertions: `dsh plugin --profile … add <tarball>` creates the profile, switches the bundle on, and the host loader resolves the patch from it; the profile is removed afterwards |
| Market index entry | `npm run market -- --repo-slug OWNER/dsh-context-rescue` | validated by the host |

What remains needs an authenticated remote: nothing in the list above can create or write to a
hosted repository on its own.

## 1. Create the repository

Either create an empty repository on GitHub (no README, no license — this checkout already has
both) and then run the one command that does the remaining mechanical work — push, rename the
branch to `main` if it is still `master`, and pin the market entry to the commit that actually
landed:

```bash
npm run publish:remote -- --repo OWNER/dsh-context-rescue --dry-run   # print the plan only
npm run publish:remote -- --repo OWNER/dsh-context-rescue
```

It stops if the work tree is dirty, never stores a credential, and prints the index URL and the
install spec when it finishes. The equivalent by hand is:

```bash
cd dsh-context-rescue
git remote add origin https://github.com/OWNER/dsh-context-rescue.git
git push -u origin main
```

…or, if the repository was created from elsewhere, push this bundle instead of a working copy:

```bash
git clone dsh-context-rescue-0.1.0.bundle dsh-context-rescue
cd dsh-context-rescue && git remote add origin <URL> && git push -u origin main
```

Without a token, HTTPS push asks for a username and a **personal access token** as the password;
SSH needs a key (`ssh-keygen -t ed25519` then add `~/.ssh/id_ed25519.pub` to GitHub). This
machine currently has neither, and no `gh` CLI.

## 2. Mark it discoverable

- Repository topic: `dsh-plugin` (this is the topic the ecosystem's listings scan for).
- `publish:remote` already regenerated and pushed `market/index.json`; regenerate it by hand only
  when you want a listing to point at a newer build (`market/index.json` is git-ignored in a fresh
  checkout because it must pin a commit that exists):

  ```bash
  npm run market -- --repo-slug OWNER/dsh-context-rescue --out market/index.json
  git add market/index.json && git commit -m "chore: market index entry" && git push
  ```

  The entry pins a commit, so regenerate it whenever you want a listing to point at a newer
  build. Serve `market/index.json` from the repository's raw URL, or publish it anywhere HTTP
  reachable, then add that URL as an index source in Discover (the market bundle starts with
  `indexes: []`, so nothing is listed until a source is added).

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
| real, working code | 44 tests, eight host-side gates |
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

## 4. npm

Either publish locally:

```bash
npm login                 # the CLI currently answers ENEEDAUTH
npm publish --access public
```

or let the release workflow do it from a tag — it runs the type check, the tests, the simulation,
the install smoke and the publish rehearsal first, refuses a tag that disagrees with
`package.json`, and publishes with provenance:

```bash
git tag v0.1.0 && git push origin v0.1.0   # needs the NPM_TOKEN repository secret
```

The package ships `index.js`, `lib/`, `cordis.patch.yml`, `market/`, `docs/`, both READMEs and
the license; `publishConfig.access` is already `public`. After publishing, `--npm` in the market
generator switches the listed source from a pinned commit to `dsh-context-rescue@<version>`.
