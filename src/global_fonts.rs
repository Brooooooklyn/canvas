use std::fs::read_dir;
use std::path;

use once_cell::sync::{Lazy, OnceCell};

use crate::sk::*;

#[cfg(target_os = "windows")]
const FONT_PATH: &str = "C:/Windows/Fonts";
#[cfg(target_os = "macos")]
const FONT_PATH: &str = "/System/Library/Fonts/";
#[cfg(target_os = "linux")]
const FONT_PATH: &str = "/usr/share/fonts/";
#[cfg(target_os = "android")]
const FONT_PATH: &str = "/system/fonts";

static FONT_DIR: OnceCell<u32> = OnceCell::new();

pub(crate) static GLOBAL_FONT_COLLECTION: Lazy<FontCollection> = Lazy::new(FontCollection::new);

#[napi]
#[allow(non_snake_case)]
pub mod GlobalFonts {
  use napi::bindgen_prelude::*;

  use super::{FONT_DIR, FONT_PATH, GLOBAL_FONT_COLLECTION};

  #[napi]
  pub fn register(font_data: Buffer, name_alias: Option<String>) -> bool {
    let maybe_name_alias = name_alias.and_then(|s| if s.is_empty() { None } else { Some(s) });
    GLOBAL_FONT_COLLECTION.register(font_data.as_ref(), maybe_name_alias)
  }

  #[napi]
  pub fn register_from_path(font_path: String, name_alias: Option<String>) -> bool {
    let maybe_name_alias = name_alias.and_then(|s| if s.is_empty() { None } else { Some(s) });
    GLOBAL_FONT_COLLECTION.register_from_path(font_path.as_str(), maybe_name_alias)
  }

  #[napi]
  pub fn get_families() -> Result<String> {
    Ok(serde_json::to_string(
      &GLOBAL_FONT_COLLECTION.get_families(),
    )?)
  }

  #[napi]
  pub fn load_system_fonts() -> u32 {
    *FONT_DIR.get_or_init(move || super::load_fonts_from_dir(FONT_PATH))
  }

  #[napi]
  pub fn load_fonts_from_dir(dir: String) -> u32 {
    super::load_fonts_from_dir(dir.as_str())
  }

  #[napi]
  pub fn set_alias(font_name: String, alias: String) {
    GLOBAL_FONT_COLLECTION.set_alias(font_name.as_str(), alias.as_str());
  }
}

fn load_fonts_from_dir<P: AsRef<path::Path>>(dir: P) -> u32 {
  let mut count = 0u32;
  let font_collection = &*GLOBAL_FONT_COLLECTION;
  if let Ok(dir) = read_dir(dir) {
    for f in dir.flatten() {
      if let Ok(meta) = f.metadata() {
        if meta.is_dir() {
          load_fonts_from_dir(f.path());
        } else {
          let p = f.path();
          let ext = p.extension().and_then(|s| s.to_str());

          match ext {
            Some("ttf") | Some("ttc") | Some("otf") | Some("pfb") | Some("woff2")
            | Some("woff") => {
              if let Some(p) = p.into_os_string().to_str() {
                if font_collection.register_from_path::<String>(p, None) {
                  count += 1;
                }
              }
            }
            _ => {}
          }
        }
      }
    }
  }
  count
}
