extern crate napi_build;

use std::env;
use std::path;
use std::process;

fn main() {
  println!("cargo:rerun-if-env-changed=SKIA_DIR");
  println!("cargo:rerun-if-env-changed=SKIA_LIB_DIR");

  println!("cargo:rerun-if-changed=skia-c/skia_c.cpp");
  println!("cargo:rerun-if-changed=skia-c/skia_c.hpp");

  let compile_target = env::var("TARGET").expect("TARGET");
  let compile_target_os = env::var("CARGO_CFG_TARGET_OS").expect("CARGO_CFG_TARGET_OS");
  let compile_target_env = env::var("CARGO_CFG_TARGET_ENV").expect("CARGO_CFG_TARGET_ENV");
  let compile_target_arch = env::var("CARGO_CFG_TARGET_ARCH").expect("CARGO_CFG_TARGET_ARCH");

  match compile_target_os.as_str() {
    "windows" => {
      env::set_var("CC", "clang-cl");
      env::set_var("CXX", "clang-cl");
    }
    _ => {
      env::set_var("CC", "clang");
      env::set_var("CXX", "clang++");
    }
  }

  let skia_dir = env::var("SKIA_DIR").unwrap_or_else(|_| "./skia".to_owned());
  let skia_path = path::Path::new(&skia_dir);
  let skia_lib_dir = env::var("SKIA_LIB_DIR").unwrap_or_else(|_| "./skia/out/Static".to_owned());

  let mut build = cc::Build::new();

  build.cpp(true).file("skia-c/skia_c.cpp");

  match compile_target.as_str() {
    "aarch64-unknown-linux-musl" => {
      let gcc_version = String::from_utf8(
        process::Command::new("ls")
          .arg("/aarch64-linux-musl-cross/aarch64-linux-musl/include/c++")
          .output()
          .unwrap()
          .stdout,
      )
      .unwrap();
      let gcc_version_trim = gcc_version.trim();
      build
        .flag("--sysroot=/aarch64-linux-musl-cross/aarch64-linux-musl")
        .flag("--gcc-toolchain=aarch64-linux-musl-gcc")
        .include("/aarch64-linux-musl-cross/aarch64-linux-musl/include")
        .include(format!(
          "/aarch64-linux-musl-cross/aarch64-linux-musl/include/c++/{gcc_version_trim}"
        ))
        .include(format!(
          "/aarch64-linux-musl-cross/aarch64-linux-musl/include/c++/{gcc_version_trim}/aarch64-linux-musl"
        ));
    }
    "armv7-unknown-linux-gnueabihf" => {
      let gcc_version = String::from_utf8(
        process::Command::new("ls")
          .arg("/usr/arm-linux-gnueabihf/include/c++")
          .output()
          .unwrap()
          .stdout,
      )
      .unwrap();
      let gcc_version_trim = gcc_version.trim();
      build
        .flag("--sysroot=/usr/arm-linux-gnueabihf")
        .flag("--gcc-toolchain=arm-linux-gnueabihf-gcc")
        .include(format!(
          "/usr/arm-linux-gnueabihf/include/c++/{gcc_version_trim}"
        ))
        .include(format!(
          "/usr/arm-linux-gnueabihf/include/c++/{gcc_version_trim}/arm-linux-gnueabihf"
        ));
    }
    "x86_64-unknown-linux-musl" => {
      let gcc_version = String::from_utf8(
        process::Command::new("ls")
          .arg("/usr/include/c++")
          .output()
          .unwrap()
          .stdout,
      )
      .unwrap();
      let gcc_version_trim = gcc_version.trim();
      build
        .static_flag(true)
        .include("/usr/include")
        .include(format!("/usr/include/c++/{gcc_version_trim}"))
        .include(format!(
          "/usr/include/c++/{gcc_version_trim}/x86_64-alpine-linux-musl"
        ));
    }
    "aarch64-apple-darwin" => {
      build.target("arm64-apple-macos");
    }
    "aarch64-linux-android" => {
      let nkd_home = env::var("ANDROID_NDK_LATEST_HOME").unwrap();
      env::set_var(
        "CC",
        format!(
          "{nkd_home}/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang"
        )
        .as_str(),
      );
      env::set_var(
        "CXX",
        format!(
          "{nkd_home}/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang++"
        )
        .as_str(),
      );
      build
        .include(
          format!(
            "{nkd_home}/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include"
          )
          .as_str(),
        )
        .include(
          format!(
            "{nkd_home}/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include/c++/v1"
          )
          .as_str(),
        )
        .include(
          format!(
            "{nkd_home}/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include/aarch64-linux-android"
          )
          .as_str(),
        )
        .archiver(
          format!(
            "{nkd_home}/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ar"
          )
          .as_str(),
        );
    }
    _ => {}
  }

  if compile_target_os != "windows" {
    build
      .flag("-std=c++17")
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
        .flag("/std:c++17")
        .flag("-Wno-unused-function")
        .flag("-Wno-unused-parameter")
        .static_crt(true);
    }
    "linux" => {
      if compile_target_env != "gnu"
        || (compile_target_arch != "x86_64" && compile_target_arch != "aarch64")
      {
        build.cpp_set_stdlib("stdc++");
      } else {
        build
          .cpp_set_stdlib("c++")
          .flag("-static")
          .include("/usr/lib/llvm-15/include/c++/v1");
        println!("cargo:rustc-link-lib=static=c++");
        if compile_target_arch == "aarch64" {
          build
            .include("/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/usr/include")
            .flag("--sysroot=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot");
          println!("cargo:rustc-link-search=/usr/aarch64-unknown-linux-gnu/lib/llvm-15/lib");
          println!("cargo:rustc-link-search=/usr/aarch64-unknown-linux-gnu/lib");
          println!("cargo:rustc-link-search=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/lib");
          println!("cargo:rustc-link-search=/usr/aarch64-unknown-linux-gnu/lib/gcc/aarch64-unknown-linux-gnu/4.8.5");
        } else {
          println!("cargo:rustc-link-search=/usr/lib/llvm-15/lib");
        }
      }
    }
    "macos" => {
      build.cpp_set_stdlib("c++");
      println!("cargo:rustc-link-lib=c++");
      println!("cargo:rustc-link-lib=framework=ApplicationServices");
    }
    _ => {}
  }

  let out_dir = env::var("OUT_DIR").unwrap();

  build
    .include("./skia-c")
    .include(skia_path)
    // https://github.com/rust-lang/rust/pull/93901#issuecomment-1119360260
    .cargo_metadata(false)
    .out_dir(&out_dir)
    .compile("skiac");

  println!("cargo:rustc-link-search={skia_lib_dir}");
  println!("cargo:rustc-link-search={}", &out_dir);
  println!("cargo:rustc-link-lib=skshaper");
  napi_build::setup();
}
