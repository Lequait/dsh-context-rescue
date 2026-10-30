# Publishing this plugin

Everything that can be built without credentials is already done and green:

| Gate | Command | Result |
|---|---|---|
| Unit + fold + rescue + commands + market rules | `npm test` | 41 tests, 38 pass, 3 skipped (host-only) |
| Same suite under the app's own Node | `npm run test:host` | 41 tests, 39 pass, 2 skipped |
| Three failure scenarios | `npm run simulate` | all pass |
| Mount in the installed host's cordis 4 | `npm run mount-check` | 23 assertions pass |
| Pack → install → host bundle resolution | `npm run install-smoke` | 14 assertions pass (tarball contents, installed manifest, host loader, compatibility, imported entry) |
| Publish flow against a throwaway remote | `npm run publish:rehearse` | 15 assertions pass (pushed branch, host-accepted index entry, pinned commit, install spec) |
| Sweep of every captured session log | `npm run scan` | 157 logs, 34 oversized, 34 rescued, 0 failed |
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

Awesome lists accept a one-line entry. The text below states what is different about this plugin
(after-the-fact rescue, zero model calls) rather than repeating "compaction":

```markdown
- [dsh-context-rescue](https://github.com/OWNER/dsh-context-rescue) — Emergency rescue for
  sessions already past the context window: detects the overflow the classifier misses, folds
  history into a durable checkpoint with no model call, and retries the failed step.
```

## 4. npm

```bash
npm login                 # the CLI currently answers ENEEDAUTH
npm publish --access public
```

The package ships `index.js`, `lib/`, `cordis.patch.yml`, `market/`, `docs/`, both READMEs and
the license; `publishConfig.access` is already `public`. After publishing, `--npm` in the market
generator switches the listed source from a pinned commit to `dsh-context-rescue@<version>`.
