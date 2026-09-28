# Native dependency metadata

## `@napi-rs/canvas@0.1.100`

The `v0.1.100` tag did **not** include a `Cargo.lock`, and the published npm package for `0.1.100` did not ship one either. This release can still be audited from the tag plus the published Rust crates it references.

### Direct Rust dependencies at the `v0.1.100` tag

| crate         | version requirement | notes                                                  |
| ------------- | ------------------- | ------------------------------------------------------ |
| `libavif`     | `0.14`              | `default-features = false`, `features = ["codec-aom"]` |
| `libavif-sys` | `0.17`              | `default-features = false`, `features = ["codec-aom"]` |

The `v0.1.100` tag does **not** depend on the Rust `image` crate.

### Native libraries used for AVIF support

| native library | version                  | source                                                                                                                                                                                                                                |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libavif`      | `1.0.4`                  | `libavif-sys` crate version `0.17.0+libavif.1.0.4` vendors `libavif 1.0.4`.                                                                                                                                                           |
| `libaom`       | `3.11.0`                 | `libavif-sys` enables `codec-aom`, which depends on `libaom-sys = "0.17"`. `libaom-sys 0.17.2+libaom.3.11.0` was already published before the `v0.1.100` release date and is the compatible resolver result for that dependency line. |
| `libyuv`       | not linked by this crate | `libavif-sys 0.17.0` disables `libyuv` during its CMake build (`-DCMAKE_DISABLE_FIND_PACKAGE_libyuv=1` and `CMAKE_DISABLE_FIND_PACKAGE_libsharpyuv=1`).                                                                               |

### Going forward

New npm releases now ship both `Cargo.toml` and `Cargo.lock` in the root package so downstream consumers can inspect the Rust dependency graph directly from the published artifact.
