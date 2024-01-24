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
        .include("/aarch64-linux-musl-cross/aarch64-linux-musl/include")
        .include(format!(
          "/aarch64-linux-musl-cross/aarch64-linux-musl/include/c++/{gcc_version_trim}"
        ))
        .include(format!(
          "/aarch64-linux-musl-cross/aarch64-linux-musl/include/c++/{gcc_version_trim}/aarch64-linux-musl"
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
      let host = if cfg!(target_os = "windows") {
        "windows"
      } else if cfg!(target_os = "macos") {
        "darwin"
      } else if cfg!(target_os = "linux") {
        "linux"
      } else {
        panic!("Unsupported host OS");
      };
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
      if compile_target_arch != "arm" {
        println!("cargo:rustc-cdylib-link-arg=-Wl,--allow-multiple-definition");
      }
      if compile_target_env != "gnu" {
        build.cpp_set_stdlib("stdc++");
      } else {
        build.cpp_set_stdlib("c++").flag("-static");
        println!("cargo:rustc-link-lib=static=c++");
        match compile_target_arch.as_str() {
          "aarch64" => {
            build
              .include(
                "/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/usr/include",
              )
              .flag("--sysroot=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot");
            println!("cargo:rustc-link-search=/usr/aarch64-unknown-linux-gnu/lib/llvm-16/lib");
            println!("cargo:rustc-link-search=/usr/aarch64-unknown-linux-gnu/lib");
            println!("cargo:rustc-link-search=/usr/aarch64-unknown-linux-gnu/aarch64-unknown-linux-gnu/sysroot/lib");
            println!("cargo:rustc-link-search=/usr/aarch64-unknown-linux-gnu/lib/gcc/aarch64-unknown-linux-gnu/4.8.5");
          }
          "x86_64" => {
            build.include("/usr/lib/llvm-16/include/c++/v1");
            println!("cargo:rustc-link-search=/usr/lib/llvm-16/lib");
          }
          "arm" => {
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
              .include("/usr/arm-linux-gnueabihf/include")
              .include(format!(
                "/usr/arm-linux-gnueabihf/include/c++/${gcc_version_trim}/arm-linux-gnueabihf"
              ));
            println!("cargo:rustc-link-search=/usr/arm-linux-gnueabihf/lib");
            println!("cargo:rustc-link-search=/usr/arm-linux-gnueabihf/lib/llvm-14/lib");
          }
          _ => {}
        }
      }
    }
    "macos" => {
      build.cpp_set_stdlib("c++");
      println!("cargo:rustc-link-lib=c++");
      println!("cargo:rustc-link-lib=framework=ApplicationServices");
    }
    "android" => {
      println!("cargo:rustc-cdylib-link-arg=-Wl,--allow-multiple-definition");
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
  println!("cargo:rustc-link-lib=static=skshaper");
  napi_build::setup();
}
