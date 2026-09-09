# Skia pipeline map

Read this when you need the exact CI shape, the artifact names, or the scripts that
move binaries. Every fact here comes from the files and from real CI runs.

## Contents

1. Workflows and triggers
2. The tag rule
3. The 11 build jobs
4. The 111 assets
5. Scripts
6. How the addon consumes the binaries
7. Timing

## 1. Workflows and triggers

| File | `name:` | Trigger |
|---|---|---|
| `.github/workflows/skia.yaml` | `Build skia` | `push` to `release` only |
| `.github/workflows/CI.yaml` | `CI` | `push` to `main`, and `pull_request` |
| `.github/workflows/libcxxabi.yml` | `Build libc++abi` | `push` to `release-libcxxabi` |
| `.github/workflows/docker.yml` | `Docker nightly build` | cron + `workflow_dispatch` |

`Build skia` trigger block:

```yaml
on:
  push:
    branches:
      - release
    tags-ignore:
      - '**'
```

There is no `workflow_dispatch`. You cannot start it by hand. A push to `release` is
the only way.

Every job carries this guard:

```yaml
    if: "!contains(github.event.head_commit.message, 'skip skia')"
```

So `[skip skia]` in the commit subject skips all 11 jobs in about 1 second. `CI` is
not affected.

Note: `Docker nightly build` on `main` is chronically red. Ignore it as a signal.

## 2. The tag rule

`scripts/utils.mjs`:

```js
export const OWNER = 'Brooooooklyn'
export const REPO = 'canvas'

const [FULL_HASH] =
  process.env.NODE_ENV === 'ava' ? ['000000'] : execSync(`git submodule status skia`).toString('utf8').trim().split(' ')

const SHORT_HASH = FULL_HASH.substring(0, 8)
export const TAG = `skia-${SHORT_HASH}`
```

Consequences:

- The tag is fully determined by the submodule SHA. You can compute it before you push.
- `git submodule status` prefixes the SHA with `+` when the checkout differs from the
  index, and `-` when the submodule is not initialized. Both poison the tag. Stage the
  submodule with `git add skia` right after the reset.
- `OWNER` and `REPO` are hardcoded. A fork run needs them changed.

Download URL:

```js
const downloadUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${platformName}`
```

## 3. The 11 build jobs

From the last successful run. All jobs run in parallel.

| Job name | Build command |
|---|---|
| `stable - ubuntu-latest - build skia` | docker `ubuntu-builder:jammy`, `node ./scripts/build-skia.js` |
| `stable - macos-latest - build skia` | `--target=x86_64-apple-darwin` |
| `stable - windows-latest - build skia` | `node ./scripts/build-skia.js` |
| `stable - apple-silicon - build skia` | `--target=aarch64-apple-darwin` |
| `stable - windows-arm64 - build skia` | `--target=aarch64-pc-windows-msvc` |
| `stable - linux-x64-musl - build skia` | `--target=x86_64-unknown-linux-musl` |
| `stable - aarch64-linux-gnu - build skia` | docker `ubuntu-builder:jammy-aarch64`, `--target=aarch64-unknown-linux-gnu` |
| `stable - linux-aarch64-musl - build skia` | `--target=aarch64-unknown-linux-musl` |
| `stable - armv7-linux - build skia` | container `debian:11`, `--target=armv7-unknown-linux-gnueabihf` |
| `stable - aarch64-linux-android - build skia` | `--target=aarch64-linux-android` |
| `stable - riscv64-linux-gnu - build skia` | `--target=riscv64gc-unknown-linux-gnu` |

Per job steps: checkout with submodules, setup node 24, setup python, add
`depot_tools` to PATH, `Sync deps on host`, **`Compile skia`** (the long pole),
`yarn install`, **`Upload release`**.

The armv7 job wraps the dep sync in `nick-fields/retry@v4` (5 attempts). A transient
red inside armv7 is not automatically fatal.

`SKIP_SYNC_SK_DEPS` semantics are inverted from the name. In
`scripts/build-skia.js`:

```js
if (process.env.SKIP_SYNC_SK_DEPS !== 'false' && process.env.SKIP_SYNC_SK_DEPS !== '0') {
  exec('python ./tools/git-sync-deps')
}
```

So `SKIP_SYNC_SK_DEPS=0` **skips** the in-script sync. Docker jobs set it because the
host already synced.

## 4. The 111 assets

10 components, 11 platforms, plus `icudtl.dat`.

Components: `skia`, `skparagraph`, `skshaper`, `svg`, `skunicode_core`,
`skunicode_icu`, `skottie`, `skresources`, `sksg`, `jsonreader`.

| Target | Asset name |
|---|---|
| host darwin, no `--target` | `lib<c>-darwin-x64.a` |
| `aarch64-apple-darwin` | `lib<c>-darwin-aarch64.a` |
| host linux, no `--target` | `lib<c>-linux-x64-gnu.a` |
| `x86_64-unknown-linux-musl` | `lib<c>-linux-x64-musl.a` |
| `aarch64-unknown-linux-gnu` | `lib<c>-linux-aarch64-gnu.a` |
| `aarch64-unknown-linux-musl` | `lib<c>-linux-aarch64-musl.a` |
| `armv7-unknown-linux-gnueabihf` | `lib<c>-linux-armv7-gnueabihf.a` |
| `riscv64gc-unknown-linux-gnu` | `lib<c>-linux-riscv64-gnu.a` |
| `aarch64-linux-android` | `lib<c>-android-aarch64.a` |
| host win32, no `--target` | `<c>-win32-x64-msvc.lib` |
| `aarch64-pc-windows-msvc` | `<c>-win32-arm64-msvc.lib` |

`icudtl.dat` is uploaded only by the win32 host job.

The release object is created by whichever job finishes first, even in a failed run.
Assets are uploaded per job and overwrite same named assets. So:

```bash
gh release view skia-<sha8> --json assets --jq '.assets | length'   # must be 111
```

An older release with 61 or 55 assets is from a smaller matrix. Do not use those
counts as the gate.

## 5. Scripts

| Path | Purpose |
|---|---|
| `scripts/build-skia.js` | `gn gen` plus `ninja` for one target. Accepts only `--target=<triple>`. |
| `scripts/release-skia-binary.mjs` | `--download`, `--upload`, `--download-icu`. Holds the `LIB` list. |
| `scripts/utils.mjs` | Derives `TAG` and maps component plus triple to an asset name. |
| `scripts/build-c++abi.mjs` | Builds static libc++ for the musl targets. Reads the root `llvm-version` file. |

`build-skia.js` valid `--target=` values:

```
aarch64-unknown-linux-gnu   aarch64-unknown-linux-musl   x86_64-unknown-linux-musl
armv7-unknown-linux-gnueabihf   aarch64-apple-darwin   aarch64-linux-android
x86_64-apple-darwin   riscv64gc-unknown-linux-gnu   aarch64-pc-windows-msvc
```

Plus the empty value, which means a native host build. `x86_64-pc-windows-msvc` and
`x86_64-unknown-linux-gnu` are native builds and take no flag. Any other triple
throws `[<triple>] is not a valid target`.

`build-skia.js` also makes two temporary edits inside `skia/` and restores them on
`beforeExit`:

1. Windows only. It swaps the two `load_from` calls in
   `skia/third_party/icu/SkLoadICU.cpp` so the library directory wins.
2. All platforms. It strips the `skia_executable("skia_c_api_example")` block out of
   `skia/BUILD.gn` before `gn gen`. **This match is literal.** If upstream reformats
   that block, the strip silently does nothing and `gn gen` then fails on the example
   target.

Adding a new platform means editing three places in lockstep: the `switch` in
`build-skia.js`, `libPath()` in `utils.mjs`, and the matrix in `skia.yaml`.

## 6. How the addon consumes the binaries

`build.rs`:

```rust
let skia_dir = env::var("SKIA_DIR").unwrap_or_else(|_| "./skia".to_owned());
let skia_lib_dir = env::var("SKIA_LIB_DIR").unwrap_or_else(|_| "./skia/out/Static".to_owned());
```

Downloaded assets land in `skia/out/Static`, the same place a local build writes. So
a local build and a CI download are interchangeable.

`build.rs` declares only `skshaper`. The other archives are declared by `#[link(...)]`
attributes in `src/sk.rs`. Three lists must agree:

- `LIB` in `scripts/release-skia-binary.mjs` - what gets uploaded
- `#[link]` in `src/sk.rs` - what gets linked
- the GN targets in `scripts/build-skia.js` - what gets built

A missing entry in `LIB` gives a green Skia build and a link failure later, or worse,
a silently incomplete `libskia.a`.

There is no GitHub cache for the Skia archives. They are downloaded with `curl` on
every run. The only cache is cargo and yarn, in
`.github/actions/setup-rust/action.yaml`.

## 7. Timing

| Stage | Duration |
|---|---|
| `Build skia`, 11 jobs | 12 to 19 minutes |
| One rebuild cycle after a fix | about 20 minutes |
| PR `CI`, about 44 checks | 10 to 12 minutes |
| Rebuild cycles per upgrade, historical | 1 to 3 |

Log retention is about 90 days. `gh run view <id> --log-failed` returns nothing for
older runs.
