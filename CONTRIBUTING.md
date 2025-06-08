# Contributing to `@napi-rs/canvas`

Thank you for taking the time to contribute!  
Depending on the area you want to work on there are **two different workflows** you can follow:

1. **Bindings / Documentation / Tooling only** &nbsp;—&nbsp;_reuse the pre-built Skia binaries_
2. **Skia build system** &nbsp;—&nbsp;_change Skia compilation flags, apply Skia patches or add a new target_

---

## 1&nbsp;· Working without rebuilding Skia

Follow this route if you only need to touch JavaScript / TypeScript, Rust, tests or project documentation.  
The CI jobs named **"Build"** in `.github/workflows/CI.yaml` use exactly the same steps.

### Prerequisites

- Node.js ≥ 20 (CI currently uses 22) with `corepack`/Yarn
- Rust toolchain (`rustup` and the target you are compiling for)
- `clang`, `llvm` and `lld`, you can look at the .github/workflows/skia.yaml for the what version is used

### Quick start

```bash
# 1. Clone with submodules (Skia lives in ./skia)
git clone --recurse-submodules https://github.com/Brooooooklyn/canvas.git
cd canvas

# 2. Download a matching *pre-built* Skia binary
node scripts/release-skia-binary.mjs --download

# 3. Install JS deps (skip heavy bench deps)
yarn install --immutable --mode=skip-build

# 4. Build the native Node-API bindings for **your** host machine
yarn build              # => builds <host-triple>.node in the project root

# 5. Run the full test-suite & code quality checks
yarn test
```

The matrix inside `.github/workflows/CI.yaml` is a good reference for all officially supported targets.

### What to commit

- Code changes **must** pass `yarn lint`, `cargo fmt -- --check` and `cargo clippy`.
- C++ code must be formatted with `clang-format --style=Chromium` (see the **Lint C++ Code** job).
- Please commit generated files (e.g. the compiled `*.node` binary) **NOT** — those are created by the release workflow.
- If your change adds new behavior, add or update tests under `__test__`.

---

## 2&nbsp;· Change the Skia build pipeline

Choose this path if you need to:

- update Skia to a newer Chromium commit;
- tweak GN/Ninja arguments (turn on GPU, experimental features, …);
- add a new architecture / OS to the pre-built binary set;
- apply patches directly to Skia's source tree.

### Where to look in the repository

- `.github/workflows/skia.yaml` — authoritative reference of how every official binary is built and uploaded;
- `scripts/build-skia.js` — wraps Skia's `gn gen` / `ninja` commands per target;
- `scripts/release-skia-binary.mjs` — downloads **or** uploads the `skia/<triple>.tar.xz` artefacts to GitHub Releases;
- `skia/` — the Skia submodule itself (pointing to `chrome/m138` by default).

### Local build (single target)

```bash
# Example: Rebuild for macOS/Apple Silicon
export MACOSX_DEPLOYMENT_TARGET=11.0
clang --version
node scripts/build-skia.js --target=aarch64-apple-darwin

# If you only need static libraries locally you can stop here.

# Re-build the bindings against your fresh Skia
node scripts/release-skia-binary.mjs --download --target=aarch64-apple-darwin
# (above command will pick the libs you just built)
yarn build --target aarch64-apple-darwin
```

Linux users can reproduce the exact Docker environment from CI:

```bash
docker pull ghcr.io/brooooooklyn/canvas/ubuntu-builder:jammy
docker run --rm -v $(pwd):/canvas -w /canvas ghcr.io/brooooooklyn/canvas/ubuntu-builder:jammy \
  node scripts/build-skia.js --target=x86_64-unknown-linux-gnu
```

The same pattern applies to the MUSL, Android, ARMv7 and RISC-V images listed in the **Build skia** workflow.

### Adding a new target

1. Extend the matrix in `.github/workflows/skia.yaml` (pick the closest existing job as template).
2. Update `scripts/build-skia.js` if the new compiler/flags need special handling.
3. Send a PR; the workflow will automatically upload the artefact to the draft release of your fork. Verify and iterate.

### Skipping expensive builds in a PR

Commit message containing the phrase `skip skia` will short-circuit the **Build skia** workflow while still running the regular CI suite. Use this for documentation-only or quick prototype PRs.

### Common pitfalls

- **MSVC vs LLVM's `link.exe`** — The workflow removes the GNU `link` shim on Windows to avoid clashes (`rm /usr/bin/link`). Replicate this step locally if needed.
- **LLVM 18 intrinsics issue** — See the Perl one-liner workaround applied in the workflow for `_xbegin/_xend` definitions.
- **glibc ≥ 2.18** — required when running the GCC-linked binaries produced by Skia.

---

## Code of Conduct

Please be welcoming and respectful. Harassment or inappropriate behaviour is not tolerated. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) &mdash; by participating you agree to abide by its terms.

---
