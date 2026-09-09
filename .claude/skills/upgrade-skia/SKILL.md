---
name: upgrade-skia
description: Upgrade the vendored Skia submodule to a new Chrome milestone (chrome/mNNN) end to end - bump the submodule, build and test locally, bump the README version badges, push the `release` branch, wait for the "Build skia" matrix to publish the prebuilt binaries, then open the PR to main and watch its CI. Use this skill whenever the user mentions upgrading or bumping Skia, a new chrome/m milestone, the `release` branch, the "Build skia" workflow, or the `skia-<sha>` release tags - even if they only say "update skia" or give a bare milestone number.
---

# Upgrade Skia

## Why the order matters

The prebuilt Skia libraries live in a GitHub release. The tag is derived from the
submodule commit, in `scripts/utils.mjs`:

```js
export const TAG = `skia-${SHORT_HASH}`   // first 8 hex chars of the skia submodule SHA
```

Every CI job downloads its static libraries from that tag. A new submodule commit
means a new tag with zero assets. So PR CI cannot pass until the binaries exist.
Only a push to the `release` branch builds them.

```
  bump submodule  ->  new SHA  ->  new tag skia-<sha8>  ->  no assets yet
                                              |
        push branch `release`  ------>  workflow "Build skia" (11 jobs)
                                              |
                                    111 assets uploaded to skia-<sha8>
                                              |
                            now, and only now, open the PR release -> main
                                              |
                                    workflow "CI" downloads the assets
```

Open the PR early and every download step returns a 404. That is the single
mistake this procedure exists to prevent.

## Phase 0 - preflight

1. Confirm the working tree is clean. Run `git status --porcelain`.
2. Fetch the repository. Run `git fetch origin --prune`.
3. Find the newest milestone branch:

```bash
git ls-remote --heads https://github.com/google/skia.git 'refs/heads/chrome/m*' \
  | sed 's|.*refs/heads/||' \
  | grep -E '^chrome/m[0-9]+$' | sort -V | tail -3
```

4. Read the current milestone from `README.md` line 4. Confirm the target with the
   user if they did not give a number.

## Phase 1 - the release branch

The `release` branch is a throwaway branch. GitHub deletes it after each upgrade PR
merges, so it usually does not exist. Create it, or reset it, from `origin/main`:

```bash
git switch -C release origin/main
```

`-C` covers both cases. It creates the branch, or moves an existing local `release`
to `origin/main`, and checks it out.

## Phase 2 - bump the submodule

```bash
MILESTONE=chrome/m156          # use the real target
git -C skia fetch --prune
git -C skia reset --hard origin/$MILESTONE
git add skia
git -C skia log -1 --oneline
git submodule status skia
```

Stage the submodule at once. `git submodule status` prints a `+` or `-` prefix when
the checkout and the index disagree, and `scripts/utils.mjs` splits that line to build
the tag. A stray prefix produces a broken tag such as `skia-+7219df0`.

Compute the tag you will wait for later:

```bash
echo "skia-$(git -C skia rev-parse HEAD | cut -c1-8)"
```

## Phase 3 - build and test locally

Build Skia first. The build takes tens of minutes, so run it in the background and
write a log:

```bash
export PATH="$PWD/depot_tools:$PATH"
export MACOSX_DEPLOYMENT_TARGET=11.0
node scripts/build-skia.js --target=aarch64-apple-darwin 2>&1 | tee /tmp/skia-build.log
```

Output goes to `skia/out/Static`. `build.rs` reads that path by default, so no copy
step is needed.

Then build the addon and run the tests:

```bash
cargo clean && yarn build
yarn test
```

Warning: do not skip `cargo clean`. The Rust build links static archives that
changed underneath it, and a stale `target/` hides link errors.

### When a step fails

Do not guess. Dispatch subagents to read the actual code and the upstream history
before any edit. The upstream diff is local, so use it:

```bash
git -C skia log --oneline <old-sha>..<new-sha> -- <file-or-dir>
```

Map the failure to its layer, then read
`references/troubleshooting.md` for the known cases and the past fixes:

| Failing step | Layer | Usual file to fix |
|---|---|---|
| `gn gen` rejects an argument | Skia build config | `scripts/build-skia.js` GN_ARGS |
| `ninja` reports `FAILED:` | Skia source or toolchain | `scripts/build-skia.js` flags |
| `yarn build` C++ errors | Skia C++ API churn | `skia-c/skia_c.cpp`, `skia-c/skia_c.hpp` |
| `yarn build` link errors | archive list drift | `src/sk.rs` `#[link]`, `LIB` in `scripts/release-skia-binary.mjs` |
| `yarn test` image diffs | raster output changed | `__test__/snapshots/*` |

Image snapshot tests write the produced image to `__test__/failure/` on failure.
Compare it against `__test__/snapshots/` before you accept any change. Regenerate
only after you confirm the new output is correct:

```bash
UPDATE_SNAPSHOT=1 yarn test
```

## Phase 4 - update the version badges

Both files carry the milestone on line 4:

```
![Skia Version](https://img.shields.io/badge/Skia-chrome%2Fm151-hotpink)
```

```bash
perl -pi -e 's|Skia-chrome%2Fm\d+-hotpink|Skia-chrome%2Fm156-hotpink|' README.md README-zh.md
grep -n 'Skia Version' README.md README-zh.md
```

`%2F` is the encoded slash. Keep it.

## Phase 5 - push the release branch

```bash
git add skia README.md README-zh.md
git commit -m "feat: chrome/m156"
git push -u origin release || git push --force origin release
```

A force push is expected and safe. The branch is disposable and nothing else builds
from it.

## Phase 6 - watch the Skia build

```bash
gh run list --branch release --workflow "Build skia" --limit 5
gh run watch <run-id>
```

The matrix has 11 jobs and takes 12 to 19 minutes. The long pole is
`stable - ubuntu-latest - build skia` or `stable - linux-aarch64-musl - build skia`.

Warning: the release tag appears even when the build fails. Each job uploads its own
assets, so a red run still leaves a partly filled release. Use two gates:

```bash
gh run view <run-id> --json jobs --jq '[.jobs[] | {name, conclusion}]'
gh release view skia-<sha8> --json assets --jq '.assets | length'   # expect 111
```

Proceed only when all 11 jobs are green and the asset count is 111.

### If the build fails

1. Read the real cause. The log tail is git cleanup noise, so filter it:

```bash
gh run view <run-id> --log-failed | grep -nE 'FAILED:|error:|fatal error:' | head -40
```

2. Deep research the cause with subagents before editing. See
   `references/troubleshooting.md`.
3. Commit the fix on `release` and push again. The submodule SHA does not change, so
   the tag stays the same and the new assets overwrite the old ones.
4. Budget about 20 minutes for each rebuild. History shows 1 to 3 cycles per upgrade.

## Phase 7 - open the PR and watch CI

```bash
gh pr create --base main --head release --title "feat: chrome/m156" --body "<summary>"
gh pr checks <pr-number> --watch
```

The PR shows both workflows against the same head commit: the 11 already green
`build skia` checks, plus about 44 `CI` checks that take 10 to 12 minutes.

### If PR CI fails

Sort the fix into one of two kinds. The kind decides the procedure.

**Kind A - the fix does not change the Skia build.** Rust, C++ binding, test or
snapshot changes. The published binaries are still correct. Push the fix to
`release` with `[skip skia]` in the commit subject:

```bash
git commit -m "fix: adapt to m156 paragraph API [skip skia]"
git push origin release
```

`[skip skia]` short circuits the whole "Build skia" workflow and saves 20 minutes.
`CI` still runs on the PR.

**Kind B - the fix changes the Skia build config.** Any edit to `GN_ARGS` in
`scripts/build-skia.js`, to the `LIB` list in `scripts/release-skia-binary.mjs`, or
to `.github/workflows/skia.yaml`. The published binaries are now stale. Follow the
long path:

1. Close the PR. `gh pr close <pr-number>`.
2. Commit the fix without `[skip skia]` and push `release`.
3. Wait for all 11 jobs and 111 assets, as in Phase 6.
4. Reopen or recreate the PR. Watch CI again.

```
CI fails
   |
   +-- Kind A: code, tests, snapshots -----> push to release with [skip skia]
   |
   +-- Kind B: build-skia.js, LIB, skia.yaml
           |
           close PR -> push release -> wait 11/11 + 111 assets -> new PR
```

## Scope discipline

An upgrade touches a known surface. Recent upgrade PRs changed 3 to 4 files. Stay
inside this list unless the build or a test forces you out:

- `skia` (the submodule pointer)
- `README.md:4`, `README-zh.md:4`
- `scripts/build-skia.js` (GN args, per target flags)
- `skia-c/skia_c.cpp`, `skia-c/skia_c.hpp` (C++ API churn)
- `src/sk.rs` (extern and `#[link]` declarations)
- `__test__/snapshots/*` (raster changes you verified)

A fix that reaches beyond this list is scope drift until you prove otherwise.
Hand product decisions back to the user instead of settling them here.

## References

- `references/pipeline.md` - the CI map: workflows, the 11 jobs, the tag rule, the
  111 assets, and every script and command involved.
- `references/troubleshooting.md` - known failure classes, the real historical
  breakages and their fixes, and the in-tree patch log.
