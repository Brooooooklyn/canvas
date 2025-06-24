# E2E Webpack Test for Issue #994

This test package verifies that the fix for [issue #994](https://github.com/Brooooooklyn/canvas/issues/994) works correctly with webpack bundling.

## Issue Description

Issue #994 occurs when webpack transforms object construction or prototype chains, causing the strict type checking in `drawImage` to fail when trying to draw canvas elements. The current implementation expects exact type matches for `CanvasElement`, `SVGCanvas`, or `Image`.
