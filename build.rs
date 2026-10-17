extern crate napi_build;

use std::env;
use std::path;

fn main() {
  println!("cargo:rerun-if-env-changed=SKIA_DIR");
  println!("cargo:rerun-if-env-changed=SKIA_LIB_DIR");

  println!("cargo:rerun-if-changed=skia-c/skia_c.cpp");
  println!("cargo:rerun-if-changed=skia-c/skia_c.hpp");
  println!("cargo:rerun-if-changed=skia-c/text.cpp");
  println!("cargo:rerun-if-changed=skia-c/text.hpp");
  println!("cargo:rerun-if-changed=skia-c/font_families.cpp");
  println!("cargo:rerun-if-changed=skia-c/text_metrics.cpp");
  println!("cargo:rerun-if-changed=skia-c/hb_api.h");
  println!("cargo:rerun-if-changed=skia-c/text_words.cpp");
  println!("cargo:rerun-if-changed=skia-c/text_styles.cpp");
  println!("cargo:rerun-if-changed=skia-c/text_caps.cpp");
  println!("cargo:rerun-if-changed=skia-c/icu_api.h");
  println!("cargo:rerun-if-changed=skia-c/text_raster.cpp");
  println!("cargo:rerun-if-changed=skia-c/text_raster.hpp");
  println!("cargo:rerun-if-changed=skia-c/font_scalers.cpp");
  println!("cargo:rerun-if-changed=skia-c/svg_image.cpp");
  println!("cargo:rerun-if-changed=skia-c/svg_image.hpp");
  println!("cargo:rerun-if-changed=scripts/libskia.flags");

  // src/svg_doc/dom.rs sizes its deep-parse stack by this: roxmltree's
  // stack use per element level follows the opt-level, not debug assertions.
  println!("cargo:rustc-check-cfg=cfg(svg_unoptimized)");
  if env::var("OPT_LEVEL").as_deref() == Ok("0") {
    println!("cargo:rustc-cfg=svg_unoptimized");
  }

  let compile_target = env::var("TARGET").expect("TARGET");
  let compile_target_os = env::var("CARGO_CFG_TARGET_OS").expect("CARGO_CFG_TARGET_OS");
  let compile_target_env = env::var("CARGO_CFG_TARGET_ENV").expect("CARGO_CFG_TARGET_ENV");
  let compile_target_arch = env::var("CARGO_CFG_TARGET_ARCH").expect("CARGO_CFG_TARGET_ARCH");

  match compile_target_os.as_str() {
    "windows" => unsafe {
      env::set_var("CC", "clang-cl");
      env::set_var("CXX", "clang-cl");
    },
    _ => {
      if env::var("CC").is_err() {
        unsafe {
          env::set_var("CC", "clang");
        }
      }
      if env::var("CXX").is_err() {
        unsafe {
          env::set_var("CXX", "clang++");
        }
      }
    }
  }

  let skia_dir = env::var("SKIA_DIR").unwrap_or_else(|_| "./skia".to_owned());
  let skia_path = path::Path::new(&skia_dir);
  let skia_lib_dir = env::var("SKIA_LIB_DIR").unwrap_or_else(|_| "./skia/out/Static".to_owned());

  let mut build = cc::Build::new();

  build.cpp(true);
  // Skia is built with SK_R32_SHIFT=0 (scripts/skia-gn-args.cjs): kN32 is
  // RGBA, like our surfaces, so the legacy blitters can draw on them. The value
  // shapes inline code in Skia's headers, so skia-c must use the same one;
  // SkTypes.h would pick 16 (BGRA) on Windows.
  build.define("SK_R32_SHIFT", "0");
  // libskia is a release build (is_debug=false, -DSK_RELEASE in
  // scripts/skia-gn-args.cjs). Without these, SkLoadUserConfig.h picks
  // SK_DEBUG for skia-c, and the SkDEBUGCODE members change the layout of
  // classes shared with libskia (SkMutex, SkPixelRef, SkTextBlob, ...).
  build.define("NDEBUG", None);
  build.define("SK_RELEASE", None);

  if compile_target.as_str() == "aarch64-linux-android" {
    let nkd_home = env::var("ANDROID_NDK_LATEST_HOME").unwrap();
    let host = if cfg!(target_os = "windows") {
      "windows"
    } else if cfg!(target_os = "macos") {
      "darwin"
    } else if cfg!(target_os = "linux") {
      "linux"
    } else {
      panic!("Unsupported host OS");
    };
    unsafe {
      env::set_var(
        "CC",
        format!(
          "{nkd_home}/toolchains/llvm/prebuilt/{host}-x86_64/bin/aarch64-linux-android24-clang"
        )
        .as_str(),
      );
      env::set_var(
        "CXX",
        format!(
          "{nkd_home}/toolchains/llvm/prebuilt/{host}-x86_64/bin/aarch64-linux-android24-clang++"
        )
        .as_str(),
      );
    }
    build
      .include(
        format!(
          "{nkd_home}/toolchains/llvm/prebuilt/{host}-x86_64/sysroot/usr/include"
        )
        .as_str(),
      )
      .include(
        format!(
          "{nkd_home}/toolchains/llvm/prebuilt/{host}-x86_64/sysroot/usr/include/c++/v1"
        )
        .as_str(),
      )
      .include(
        format!(
          "{nkd_home}/toolchains/llvm/prebuilt/{host}-x86_64/sysroot/usr/include/aarch64-linux-android"
        )
        .as_str(),
      )
      .archiver(
        format!(
          "{nkd_home}/toolchains/llvm/prebuilt/{host}-x86_64/bin/llvm-ar"
        )
        .as_str(),
      );
  }

  if compile_target_os != "windows" {
    build
      .flag("-std=c++20")
      .flag("-fPIC")
      .flag("-fno-exceptions")
      .flag("-fno-rtti")
      .flag("-fstrict-aliasing")
      .flag("-fvisibility=hidden")
      .flag("-fvisibility-inlines-hidden")
      .flag("-fdata-sections")
      .flag("-ffunction-sections")
      .flag("-Wno-unused-function")
      .flag("-Wno-unused-parameter");
  }

  match compile_target_os.as_str() {
    "windows" => {
      build
        .flag("/std:c++20")
        .flag("-Wno-unused-function")
        .flag("-Wno-unused-parameter")
        .static_crt(true);
    }
    "linux" => {
      // `cargo test` links a real binary, not the node-loaded cdylib, so
      // let the node-provided napi_* symbols stay unresolved (tests never
      // execute those paths). gnu only: musl cross-builds link through
      // zigcc, which does not implement --unresolved-symbols, and nobody
      // runs `cargo test` on musl. Shared-object links already tolerate
      // undefined symbols, so it is a no-op on the cdylib.
      if compile_target_env == "gnu" {
        println!("cargo:rustc-link-arg=-Wl,--unresolved-symbols=ignore-in-object-files");
      }
      if compile_target_env != "musl" {
        println!("cargo:rustc-cdylib-link-arg=-Wl,--allow-multiple-definition");
      }
      match compile_target_env.as_str() {
        "gnu" => match compile_target_arch.as_str() {
          "aarch64" => {
            link_libcxx(&mut build);
            build
              .include(
                "/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/usr/include",
              )
              .flag("--sysroot=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot");
            println!("cargo:rustc-link-search=/usr/aarch64-unknown-linux-gnu/lib/llvm-19/lib");
            println!("cargo:rustc-link-search=/usr/aarch64-unknown-linux-gnu/lib");
            println!(
              "cargo:rustc-link-search=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/lib"
            );
            println!(
              "cargo:rustc-link-search=/usr/aarch64-unknown-linux-gnu/lib/gcc/aarch64-unknown-linux-gnu/4.8.5"
            );
          }
          "x86_64" => {
            link_libcxx(&mut build);
            build.include("/usr/lib/llvm-19/include/c++/v1");
            println!("cargo:rustc-link-search=/usr/lib/llvm-19/lib");
          }
          "riscv64" => {
            println!("cargo:rustc-link-search=/usr/lib/gcc-cross/riscv64-linux-gnu/11");
            println!("cargo:rustc-link-lib=static=atomic");
          }
          "arm" => {
            unsafe {
              env::set_var("CC", "clang");
              env::set_var("CXX", "clang++");
              env::set_var("TARGET_CC", "clang");
              env::set_var("TARGET_CXX", "clang++");
            }
            build
              .cpp_set_stdlib("stdc++")
              .flag("-static")
              .include("/usr/arm-linux-gnueabihf/include")
              .include("/usr/arm-linux-gnueabihf/include/c++/9");
            println!("cargo:rustc-link-lib=static=stdc++");
            println!("cargo:rustc-link-search=/usr/lib/gcc-cross/arm-linux-gnueabihf/9");
          }
          _ => {}
        },
        "musl" => {
          build.flag_if_supported("-static");
          println!("cargo:rustc-link-lib=static=c++");
          println!("cargo:rustc-link-lib=static=c++abi");
        }
        _ => {}
      }
    }
    "macos" => {
      build.cpp_set_stdlib("c++");
      if compile_target_arch == "aarch64" {
        build.flag_if_supported("-mmacosx-version-min=11.0");
      } else {
        build.flag_if_supported("-mmacosx-version-min=10.13");
      }
      println!("cargo:rustc-link-lib=c++");
      println!("cargo:rustc-link-lib=framework=ApplicationServices");
      // Test binaries aren't a node-loaded cdylib: give them the same
      // dynamic_lookup the napi-build cdylib setup emits so napi_* symbols
      // (only reached via paths tests never call) resolve at link time.
      // The flag also reaches the cdylib link, where it matches what napi
      // modules already use, so the release artifact is unaffected.
      println!("cargo::rustc-link-arg=-Wl,-undefined,dynamic_lookup");
    }
    "android" => {
      build.cpp_set_stdlib("c++").flag("-static");
      println!("cargo:rustc-link-lib=static=c++");
      println!("cargo:rustc-cdylib-link-arg=-Wl,--allow-multiple-definition");
    }
    _ => {}
  }

  let out_dir = env::var("OUT_DIR").unwrap();

  // Skia's Fontations font scaler, which Chrome draws Linux fonts and some
  // macOS web fonts with (skia-c/font_scalers.cpp). Its Rust half is the
  // skia-fontations crate; its C++ half is compiled here with the toolchain
  // setup above and libskia's own defines.
  let fontations = compile_target_os == "macos" || compile_target_os == "linux";
  let mut fontations_build = build.clone();

  if fontations {
    build.define("SKIAC_FONTATIONS", None);
  }
  build
    .file("skia-c/skia_c.cpp")
    .file("skia-c/text.cpp")
    .file("skia-c/font_families.cpp")
    .file("skia-c/text_metrics.cpp")
    .file("skia-c/text_words.cpp")
    .file("skia-c/text_styles.cpp")
    .file("skia-c/text_caps.cpp")
    .file("skia-c/text_raster.cpp")
    .file("skia-c/font_scalers.cpp")
    .file("skia-c/svg_image.cpp")
    .include("./skia-c")
    .include(skia_path)
    // https://github.com/rust-lang/rust/pull/93901#issuecomment-1119360260
    .cargo_metadata(false)
    .out_dir(&out_dir)
    .compile("skiac");

  if fontations {
    // Writes the bridge's C++ (ffi.rs.h / ffi.rs.cc) under
    // OUT_DIR/cxxbridge; Skia includes the header as
    // "src/ports/fontations/src/ffi.rs.h".
    cxx_build::CFG.include_prefix = "";
    let bridge = cxx_build::bridge("skia/src/ports/fontations/src/ffi.rs");
    let cxxbridge = path::Path::new(&out_dir).join("cxxbridge");
    fontations_build
      .files(bridge.get_files())
      .file(skia_path.join("src/ports/SkTypeface_fontations.cpp"))
      .file(skia_path.join("src/ports/SkFontScanner_fontations.cpp"))
      .file(skia_path.join("src/ports/SkFontMgr_fontations_empty.cpp"))
      .include(cxxbridge.join("include"))
      .include(cxxbridge.join("include").join("skia"))
      .include(skia_path);
    for flag in libskia_flags(&compile_target) {
      fontations_build.flag(flag);
    }
    fontations_build
      // gn/skia/BUILD.gn builds Skia with clang this way.
      .flag_if_supported("-ffp-contract=off")
      .flag_if_supported("-Wno-unused-but-set-variable")
      .cargo_metadata(false)
      .out_dir(&out_dir)
      .compile("skiac_fontations");
  }

  println!("cargo:rustc-link-search={skia_lib_dir}");
  println!("cargo:rustc-link-search={}", &out_dir);
  println!("cargo:rustc-link-lib=static=skshaper");
  napi_build::setup();
}

/// The -D / -U flags libskia's C++ is built with for `target`
/// (scripts/libskia.flags): Skia's private headers change class layouts
/// with them.
fn libskia_flags(target: &str) -> Vec<String> {
  include_str!("scripts/libskia.flags")
    .lines()
    .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
    .filter_map(|line| line.split_once(' '))
    .filter(|(scope, _)| *scope == "*" || *scope == "gn" || *scope == target)
    .map(|(_, flag)| flag.trim().to_owned())
    .collect()
}

fn link_libcxx(build: &mut cc::Build) {
  build.cpp_set_stdlib("c++").flag("-static");
  println!("cargo:rustc-link-lib=static=c++");
}
