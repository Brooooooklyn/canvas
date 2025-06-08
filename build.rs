extern crate napi_build;

use std::env;
use std::path;

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

  build.cpp(true).file("skia-c/skia_c.cpp");

  match compile_target.as_str() {
    "aarch64-unknown-linux-musl" => {
      link_libcxx(&mut build);
      println!("cargo:rustc-link-lib=static=c++abi");
      build
        .include("/aarch64-linux-musl-cross/aarch64-linux-musl/include")
        .include("/aarch64-linux-musl-cross/include/c++/v1");
    }
    "x86_64-unknown-linux-musl" => {
      link_libcxx(&mut build);
      println!("cargo:rustc-link-lib=static=c++abi");
      build.include("/usr/include").include("/usr/include/c++/v1");
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
    _ => {}
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
      if compile_target_arch != "arm" {
        println!("cargo:rustc-cdylib-link-arg=-Wl,--allow-multiple-definition");
      }
      if compile_target_env == "gnu" {
        match compile_target_arch.as_str() {
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
              .include("/usr/arm-linux-gnueabihf/include/c++/8");
            println!("cargo:rustc-link-lib=static=stdc++");
            println!("cargo:rustc-link-search=/usr/lib/gcc-cross/arm-linux-gnueabihf/8");
          }
          _ => {}
        }
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
    }
    "android" => {
      build.cpp_set_stdlib("c++").flag("-static");
      println!("cargo:rustc-link-lib=static=c++");
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

fn link_libcxx(build: &mut cc::Build) {
  build.cpp_set_stdlib("c++").flag("-static");
  println!("cargo:rustc-link-lib=static=c++");
}
