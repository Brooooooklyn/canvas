extern crate napi_build;

use std::env;
use std::path;

fn main() {
  println!("cargo:rerun-if-env-changed=SKIA_DIR");
  println!("cargo:rerun-if-env-changed=SKIA_LIB_DIR");

  println!("cargo:rerun-if-changed=skia-c/skia_c.cpp");
  println!("cargo:rerun-if-changed=skia-c/skia_c.hpp");

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

  let skia_dir = env::var("SKIA_DIR").unwrap_or("./skia".to_owned());
  let skia_path = path::Path::new(&skia_dir);
  let skia_lib_dir = env::var("SKIA_LIB_DIR").unwrap_or("./skia/out/Static".to_owned());

  let mut build = cc::Build::new();

  build
    .cpp(true)
    .file("skia-c/skia_c.cpp")
    .include("skia-c")
    .include(skia_path);

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

  build
    .cargo_metadata(true)
    .out_dir(env::var("OUT_DIR").unwrap())
    .compile("skiac");

  println!("cargo:rustc-link-search={}", skia_lib_dir);
  #[cfg(target_os = "linux")]
  {
    println!("cargo:rustc-link-lib=static=skia");
    println!("cargo:rustc-link-lib=static=skiac");
  }

  #[cfg(not(target_os = "linux"))]
  {
    println!("cargo:rustc-link-lib=skia");
    println!("cargo:rustc-link-lib=skiac");
  }
  napi_build::setup();
}
