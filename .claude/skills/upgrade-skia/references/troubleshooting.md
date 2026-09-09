# Skia upgrade troubleshooting

Read this when a build, a link, or a test fails during an upgrade. It records the
real failures from past milestones and the in-tree patch log.

## Contents

1. How to research a failure
2. Failure class: a GN argument was renamed or removed
3. Failure class: a new upstream dependency assumes glibc or Chromium
4. Failure class: the `BUILD.gn` strip stops matching
5. Failure class: C++ API churn in `skia-c`
6. Failure class: archive list drift
7. Failure class: image snapshot diffs
8. The in-tree patch log
9. What past upgrades actually changed

## 1. How to research a failure

Do not guess and do not patch symptoms. The upstream history is on disk, so use it.

```bash
# what changed between the old and the new milestone in one area
git -C skia log --oneline <old-sha>..<new-sha> -- gn/skia.gni
git -C skia log --oneline <old-sha>..<new-sha> -- include/core
git -C skia show <upstream-sha>
```

For a CI failure, get the real cause and the GN args that platform used:

```bash
gh run view <run-id> --log-failed | grep -nE 'FAILED:|error:|fatal error:' | head -40
gh run view <run-id> --log-failed | grep -m1 'gn gen out/Static'
```

Dispatch subagents to trace the full control flow before any edit. Give each subagent
the failing log, the file it must read, and the upstream range. Seeing is believing.

## 2. A GN argument was renamed or removed

Signature: `gn gen` fails fast, before any compilation. The message names the unknown
argument.

Cause: `scripts/build-skia.js` passes an argument that the new milestone dropped.

Fix: find the upstream rename, then edit `GN_ARGS` in `scripts/build-skia.js`.

```bash
git -C skia log --oneline <old-sha>..<new-sha> -- gn/skia.gni
```

This is a Kind B fix. It changes the Skia build, so the published binaries are stale.

## 3. A new upstream dependency assumes glibc or Chromium

This is the most common milestone breakage. The healthy targets pass and the musl and
old glibc targets fail, so a partial red matrix is the tell.

Real case, m151, run 30272961187, 4 of 11 jobs red:

```
stable - aarch64-linux-gnu   FAILED: obj/.../partition_alloc_base/liballocator_base.cpu.o
                             cpu.cc:194:36: error: use of undeclared identifier 'AT_HWCAP2'
stable - linux-x64-musl      allocator_shim_internals.h:13:10: fatal error: 'sys/cdefs.h' file not found
stable - linux-aarch64-musl  fatal error: 'sys/ifunc.h' file not found
```

Cause: Skia m151 added a dependency from `skia_component("skia")` to
`//src/partition_alloc:raw_ptr`, and `gn/skia.gni` defaults `skia_use_partition_alloc`
to `is_clang`. The PartitionAlloc Linux code needs glibc headers. It also broke the
manylinux2014 sysroot, which is glibc 2.17.

Fix, commit 3fef7fcb, one GN argument:

```js
// Skia defaults this to `is_clang`, which pulls PartitionAlloc into libskia. Its Linux code
// needs glibc (sys/cdefs.h, sys/ifunc.h, AT_HWCAP2), breaking musl and the glibc 2.17 aarch64
// sysroot. The PartitionAlloc archives are never uploaded or linked either, so libskia would
// ship unresolved raw_ptr/BackupRefPtr symbols.
`skia_use_partition_alloc=false`,
```

Note the second half of that comment. A new upstream sub-library that is not in the
`LIB` list of `scripts/release-skia-binary.mjs` produces a green build and unresolved
symbols. Turn the dependency off, or add the archive to all three lists. See
`pipeline.md` section 6.

Warning: check the whole matrix before you conclude. A green x64 host build proves
nothing about musl.

## 4. The `BUILD.gn` strip stops matching

Signature: `gn gen` or `ninja` tries to build `skia_c_api_example` and fails on a
missing source file.

Cause: `scripts/build-skia.js` removes the `skia_executable("skia_c_api_example")`
block from `skia/BUILD.gn` with a literal string match. Upstream reformatting makes
the match fail, and the removal silently does nothing.

Fix: update the literal block in `scripts/build-skia.js` to the new upstream text.

## 5. C++ API churn in `skia-c`

Signature: `yarn build` fails while compiling `skia-c/skia_c.cpp`. Errors name Skia
types, headers, or method signatures.

Cause: Skia changed a public C++ API between milestones.

Fix: read the upstream change, then adapt `skia-c/skia_c.cpp` and
`skia-c/skia_c.hpp`. If the C signature changes, update the extern declarations in
`src/sk.rs` too.

```bash
git -C skia log --oneline <old-sha>..<new-sha> -- include/core include/effects modules
```

This is a Kind A fix. It does not change the Skia build, so push it with
`[skip skia]`.

## 6. Archive list drift

Signature: `yarn build` links, then fails with undefined symbols. Or a CI download
step 404s on one asset name.

Cause: Skia added, renamed, or removed a GN target. Three lists disagree.

Fix, all three together:

- `LIB` in `scripts/release-skia-binary.mjs`
- the `#[link(...)]` attributes in `src/sk.rs`
- the GN targets in `scripts/build-skia.js`

This is a Kind B fix.

## 7. Image snapshot diffs

Signature: `yarn test` fails with `Image bytes is not equal, different ratio is N%`.

The helper is `__test__/image-snapshot.ts`. It decodes both PNGs and compares bytes
against a per architecture tolerance:

```js
differentRatio = ARCH_NAME === 'x64' ? 0.015 : t.title.includes('filter') ? 2.5 : 0.3
```

On failure it writes the produced image to `__test__/failure/<test title>.png`.

Procedure:

1. Open `__test__/failure/<title>.png` and `__test__/snapshots/<title>.png`.
2. Decide whether the new output is correct. A raster improvement is expected. A
   missing glyph, a wrong colour, or a blank canvas is a real defect.
3. Regenerate only after you confirm it:

```bash
UPDATE_SNAPSHOT=1 yarn test
```

4. Commit the regenerated PNGs and say in the PR body which ones changed and why.

Warning: do not regenerate a snapshot to silence a failure you did not explain. Past
upgrades regenerated snapshots deliberately, for example `echarts-start.png` in m142
and `strokeText-line-break-as-space.png` in m140.

## 8. The in-tree patch log

There is no `patches/` directory. All Skia side changes are GN arguments, plus the two
temporary in-place edits described in `pipeline.md` section 5. The comments in
`scripts/build-skia.js` are the de facto patch log. Re-validate each one against the
new milestone.

| GN argument | Reason |
|---|---|
| `skia_use_partition_alloc=false` | PartitionAlloc needs glibc. Breaks musl and glibc 2.17. Added in m151. |
| `skia_pdf_subset_harfbuzz=${PDF_HARFBUZZ_SUBSET_ENABLED}` | The subsetter crashes on some targets. Added in m148. |
| `skia_use_libavif=false` | Conflicts with the Rust libavif. |
| `skia_use_libjxl_decode=${!TARGET_TRIPLE.startsWith('riscv64')}` | No JXL on riscv64. |
| `skia_enable_ganesh=false` | CPU only build. |
| `-DSK_DISABLE_PATHDATA` on armv7 | Kill switch added in Chrome m144, skia commit 7f325708d2. |

Also re-check the `-std=c++20` flag. It was raised from C++17 in m148.

## 9. What past upgrades actually changed

| PR | Milestone | Files changed |
|---|---|---|
| 1302 | m151 | `README.md`, `README-zh.md`, `scripts/build-skia.js`, `skia` |
| 1281 | m149 | `README.md`, `README-zh.md`, `skia` (the minimal case) |
| 1248 | m148 | plus `scripts/build-skia.js`, harfbuzz workaround, C++20 |
| 1207 | m146 | plus `skia-c/*`, new tests, three new PNG snapshots, `CI.yaml` |
| 1182 | m144 | plus `skia-c/skia_c.cpp`, armv7 flag, all `npm/*/package.json` |
| 1153 | m143 | plus `skia-c/*`, `src/sk.rs`, `depot_tools`, `rust-toolchain.toml` |
| 1110 | m140 | plus `build.rs`, `musl.Dockerfile`, regenerated snapshots |

Rare edits: `llvm-version` was last touched at m133. `cmake/` has never been part of
an upgrade.

PR conventions: the title is `feat: chrome/mNNN`. The head branch is literally
`release` and the base is `main`. The branch is deleted after the merge.

Stale documentation to distrust: `CONTRIBUTING.md` still says the submodule points at
`chrome/m138`, describes `.tar.xz` artefacts that do not exist, calls the release a
draft, and mentions an LLVM 18 workaround that was removed.
