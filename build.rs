extern crate napi_build;

use std::env;
use std::path;
use std::process;

fn main() {
  println!("cargo:rerun-if-env-changed=SKIA_DIR");
  println!("cargo:rerun-if-env-changed=SKIA_LIB_DIR");

  println!("cargo:rerun-if-changed=skia-c/skia_c.cpp");
  println!("cargo:rerun-if-changed=skia-c/skia_c.hpp");

  let compile_target = env::var("TARGET").unwrap();

  #[cfg(target_os = "windows")]
  {
    env::set_var("CC", "clang-cl");
    env::set_var("CXX", "clang-cl");
  }

  #[cfg(not(target_os = "windows"))]
  {
    env::set_var("CC", "clang");
    env::set_var("CXX", "clang++");
  }

  let skia_dir = env::var("SKIA_DIR").unwrap_or_else(|_| "./skia".to_owned());
  let skia_path = path::Path::new(&skia_dir);
  let skia_lib_dir = env::var("SKIA_LIB_DIR").unwrap_or_else(|_| "./skia/out/Static".to_owned());

  let mut build = cc::Build::new();

  build.cpp(true).file("skia-c/skia_c.cpp");

  match compile_target.as_str() {
    "aarch64-unknown-linux-gnu" | "aarch64-unknown-linux-musl" => {
      build
        .flag("--sysroot=/usr/aarch64-linux-gnu")
        .flag("--gcc-toolchain=aarch64-linux-gnu-gcc")
        .include("/usr/aarch64-linux-gnu/include/c++/7")
        .include("/usr/aarch64-linux-gnu/include/c++/7/aarch64-linux-gnu");
    }
    "armv7-unknown-linux-gnueabihf" => {
      build
        .flag("--sysroot=/usr/arm-linux-gnueabihf")
        .flag("--gcc-toolchain=arm-linux-gnueabihf-gcc")
        .include("/usr/arm-linux-gnueabihf/include/c++/7")
        .include("/usr/arm-linux-gnueabihf/include/c++/7/arm-linux-gnueabihf");
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
        .include(format!("/usr/include/c++/{}", gcc_version_trim))
        .include(format!(
          "/usr/include/c++/{}/x86_64-alpine-linux-musl",
          gcc_version_trim
        ));
    }
    "aarch64-apple-darwin" => {
      build.target("arm64-apple-darwin");
    }
    "aarch64-linux-android" => {
      let nkd_home = env::var("ANDROID_NDK_HOME").unwrap();
      env::set_var(
        "CC",
        format!(
          "{}/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang",
          nkd_home
        )
        .as_str(),
      );
      env::set_var(
        "CXX",
        format!(
          "{}/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang++",
          nkd_home
        )
        .as_str(),
      );
      build
        .include(
          format!(
            "{}/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include",
            nkd_home
          )
          .as_str(),
        )
        .include(
          format!(
            "{}/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include/c++/v1",
            nkd_home
          )
          .as_str(),
        )
        .include(
          format!(
            "{}/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include/aarch64-linux-android",
            nkd_home
          )
          .as_str(),
        )
        .archiver(
          format!(
            "{}/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android-ar",
            nkd_home
          )
          .as_str(),
        );
    }
    _ => {}
  }

  #[cfg(target_os = "windows")]
  {
    build
      .flag("/std:c++17")
      .flag("-Wno-unused-function")
      .flag("-Wno-unused-parameter")
      .static_crt(true);
  }

  #[cfg(target_os = "linux")]
  {
    build.cpp_set_stdlib("stdc++");
  }

  #[cfg(target_os = "macos")]
  {
    build.cpp_set_stdlib("c++");
  }

  #[cfg(not(target_os = "windows"))]
  {
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

  #[cfg(target_os = "macos")]
  {
    println!("cargo:rustc-link-lib=c++");
    println!("cargo:rustc-link-lib=framework=ApplicationServices");
  }

  let out_dir = env::var("OUT_DIR").unwrap();

  build
    .include("./skia-c")
    .include(skia_path)
    .cargo_metadata(true)
    .out_dir(&out_dir)
    .compile("skiac");

  println!("cargo:rustc-link-search={}", skia_lib_dir);
  println!("cargo:rustc-link-search={}", &out_dir);

  #[cfg(target_os = "linux")]
  {
    println!("cargo:rustc-link-lib=static=svg");
    println!("cargo:rustc-link-lib=static=skia");
    println!("cargo:rustc-link-lib=static=skiac");
    println!("cargo:rustc-link-lib=skparagraph");
    println!("cargo:rustc-link-lib=skshaper");
  }

  #[cfg(not(target_os = "linux"))]
  {
    println!("cargo:rustc-link-lib=svg");
    println!("cargo:rustc-link-lib=skia");
    println!("cargo:rustc-link-lib=skiac");
    println!("cargo:rustc-link-lib=skparagraph");
    println!("cargo:rustc-link-lib=skshaper");
  }
  napi_build::setup();
}
