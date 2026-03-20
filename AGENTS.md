# AGENTS.md

## Cursor Cloud specific instructions

This is a native Node.js addon (`@napi-rs/canvas`) backed by Skia via Rust/N-API bindings. It is a **library**, not a multi-service application.

### System prerequisites (already installed in snapshot)

- **Node.js >= 20** (with corepack enabled for Yarn 4.13.0)
- **Rust 1.92.0** (per `rust-toolchain.toml`)
- **clang/LLVM 18**, **LLD**, **libc++-dev**, **libc++abi-dev**, **libstdc++-14-dev**
- LLVM-19 symlink: `build.rs` hardcodes `/usr/lib/llvm-19/` paths; a symlink `/usr/lib/llvm-19 -> /usr/lib/llvm-18` is required.
- `LIBRARY_PATH` must include `/usr/lib/gcc/x86_64-linux-gnu/14` for the `libaom-sys` crate (AVIF support) to find `libstdc++` during cmake builds.

### Key commands

| Task | Command | Notes |
|------|---------|-------|
| Install JS deps | `yarn install --mode=skip-build` | Skips heavy benchmark native deps |
| Init submodules | `git submodule update --init skia` | Needed for Skia C++ headers |
| Download Skia libs | `node scripts/release-skia-binary.mjs --download` | Pre-built static libs from GitHub Releases |
| Build native addon | `yarn build` | Requires `LIBRARY_PATH` set (see above) |
| Lint | `yarn lint` | Runs `oxlint` |
| Test | `yarn test` | Runs `ava` test suite |
| Format | `yarn format` | Runs prettier + cargo fmt + taplo |

### Build caveats

- The `yarn build` command compiles Rust + C++ code linking against pre-built Skia static libraries. It takes ~60s on first build (release profile).
- You **must** set `LIBRARY_PATH="/usr/lib/gcc/x86_64-linux-gnu/14:$LIBRARY_PATH"` before running `yarn build`, otherwise the `libaom-sys` cmake build fails to find `libstdc++`.
- The `draw-text-emoji` test will fail in CI-like environments without Apple Color Emoji fonts installed. This is expected.
- 41 tests are skipped by default (cross-compatibility tests with `node-canvas` and `skia-canvas` that require those optional packages to be built).
