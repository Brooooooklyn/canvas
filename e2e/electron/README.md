# E2E Electron Test for Issue #1405

This test package loads `@napi-rs/canvas` inside Electron, the case that broke in [issue #1405](https://github.com/Brooooooklyn/canvas/issues/1405).

## Issue Description

On Linux, `require('@napi-rs/canvas')` crashed Electron with `SIGTRAP`. Electron exports the same cxx runtime symbols (`cxxbridge1$*`) that the addon carries, and the dynamic loader bound the addon's own calls to Electron's copies, so the addon freed its memory with Chromium's allocator. The crash came from loading the system fonts and from drawing text. The fix links the Linux addon with `-Wl,-Bsymbolic`.

## What It Runs

`run.js` starts `index.js` with the Electron binary and `ELECTRON_RUN_AS_NODE=1`, twice:

1. with the system fonts loaded by `require('@napi-rs/canvas')`
2. with `DISABLE_SYSTEM_FONTS_LOAD=1`, then `GlobalFonts.enableSystemFonts()`

Each run checks that system fonts are found, registers `__test__/fonts/SourceSerifPro-Regular.ttf`, and with a system family and the registered one calls `measureText`, `fillText`, `strokeText` and `encode('png')`. A run that Electron ends with a signal fails the test.

## Running

Build the addon in the repository root first, then:

```sh
yarn e2e:electron
```

`yarn install --mode=skip-build` skips the Electron download; fetch it with `node node_modules/electron/install.js`. On Linux, Electron needs its shared libraries (`libnss3`, `libgtk-3-0`, `libgbm1`, `libasound2`, ...) even with `ELECTRON_RUN_AS_NODE=1`, and the test needs at least one installed font (for example `fonts-dejavu-core`).
