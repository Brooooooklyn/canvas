use std::fs::read_dir;
use std::path;
use std::sync::{LazyLock, LockResult, Mutex, MutexGuard, OnceLock, PoisonError};

use crate::sk::*;

#[cfg(target_os = "windows")]
const FONT_PATH: &str = "C:/Windows/Fonts";
#[cfg(target_os = "macos")]
const FONT_PATH: &str = "/System/Library/Fonts/";
#[cfg(target_os = "linux")]
const FONT_PATH: &str = "/usr/share/fonts/";
#[cfg(target_os = "android")]
const FONT_PATH: &str = "/system/fonts";

static FONT_DIR: OnceLock<napi::Result<u32>> = OnceLock::new();

pub(crate) static GLOBAL_FONT_COLLECTION: LazyLock<Mutex<FontCollection>> =
  LazyLock::new(|| Mutex::new(FontCollection::new()));

#[inline]
pub(crate) fn get_font<'a>() -> LockResult<MutexGuard<'a, FontCollection>> {
  GLOBAL_FONT_COLLECTION.lock()
}

#[inline]
fn into_napi_error<E>(err: PoisonError<MutexGuard<'_, E>>) -> napi::Error {
  napi::Error::new(napi::Status::GenericFailure, format!("{err}"))
}

#[napi]
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FontKey {
  pub typeface_id: u32,
}

#[napi(js_name = "GlobalFonts")]
#[allow(non_snake_case)]
pub mod global_fonts {
  use napi::bindgen_prelude::*;

  use super::{FONT_DIR, FONT_PATH, FontKey, get_font, into_napi_error};

  #[napi]
  pub fn register(font_data: &[u8], name_alias: Option<String>) -> Result<Option<FontKey>> {
    let maybe_name_alias = name_alias.and_then(|s| if s.is_empty() { None } else { Some(s) });
    let font = get_font().map_err(into_napi_error)?;
    Ok(
      font
        .register(font_data, maybe_name_alias)
        .map(|typeface_id| FontKey { typeface_id }),
    )
  }

  /// Register a font from a file path.
  ///
  /// Fonts registered via path are deduplicated by the path string itself, not by file contents.
  /// This means:
  /// - Registering the same path multiple times returns the existing registration
  /// - If the font file is modified on disk and `registerFromPath` is called again,
  ///   the new contents will NOT be loaded - it returns the existing registration
  ///
  /// This behavior is intentional to prevent memory waste from duplicate registrations.
  ///
  /// ## Hot-reload workaround
  ///
  /// To reload a font after modifying the file on disk:
  /// 1. Call `GlobalFonts.remove(fontKey)` with the key from the original registration
  /// 2. Call `GlobalFonts.registerFromPath()` again to register the updated font
  ///
  /// Note: The `register()` function (buffer-based) deduplicates by content hash,
  /// so it will detect when font data has changed.
  // TODO: Do file extensions in font_path need to be converted to lowercase?
  // Windows and macOS are case-insensitive, Linux is not.
  // See: https://github.com/Brooooooklyn/canvas/actions/runs/5893418006/job/15985737723
  #[napi]
  pub fn register_from_path(
    font_path: String,
    name_alias: Option<String>,
  ) -> Result<Option<FontKey>> {
    let maybe_name_alias = name_alias.and_then(|s| if s.is_empty() { None } else { Some(s) });
    let font = get_font().map_err(into_napi_error)?;
    Ok(
      font
        .register_from_path(font_path.as_str(), maybe_name_alias)
        .map(|typeface_id| FontKey { typeface_id }),
    )
  }

  #[napi]
  pub fn get_families() -> Result<Buffer> {
    let font = get_font().map_err(into_napi_error)?;
    Ok(serde_json::to_vec(&font.get_families())?.into())
  }

  #[napi]
  pub fn load_system_fonts() -> Result<u32> {
    FONT_DIR
      .get_or_init(move || super::load_fonts_from_dir(FONT_PATH))
      .as_ref()
      .map(|s| *s)
      .map_err(|e| Error::new(e.status, e.reason.clone()))
  }

  #[napi]
  pub fn load_fonts_from_dir(dir: String) -> Result<u32> {
    super::load_fonts_from_dir(dir.as_str())
  }

  #[napi]
  pub fn set_alias(font_name: String, alias: String) -> Result<bool> {
    let font = get_font().map_err(into_napi_error)?;
    Ok(font.set_alias(font_name.as_str(), alias.as_str()))
  }

  /// Remove a previously registered font from the global font collection.
  /// Returns true if the font was successfully removed, false if it was not found.
  #[napi]
  pub fn remove(key: &FontKey) -> Result<bool> {
    let font = get_font().map_err(into_napi_error)?;
    Ok(font.unregister(key.typeface_id))
  }

  #[napi]
  /// Remove multiple fonts by their keys in a single operation.
  /// More efficient than calling remove() multiple times as it triggers only one rebuild.
  /// Returns the number of fonts successfully removed.
  pub fn remove_batch(font_keys: Vec<&FontKey>) -> Result<u32> {
    let typeface_ids: Vec<u32> = font_keys.iter().map(|k| k.typeface_id).collect();
    let font = get_font().map_err(into_napi_error)?;
    Ok(font.unregister_batch(&typeface_ids) as u32)
  }

  #[napi]
  /// Remove ALL registered fonts in a single operation.
  /// Returns the number of fonts removed.
  pub fn remove_all() -> Result<u32> {
    let font = get_font().map_err(into_napi_error)?;
    Ok(font.unregister_all() as u32)
  }

  #[napi(object)]
  #[derive(Debug, Clone)]
  pub struct FontVariationAxis {
    pub tag: u32,
    pub value: f64,
    pub min: f64,
    pub max: f64,
    pub def: f64,
    pub hidden: bool,
  }

  #[napi]
  pub fn get_variation_axes(
    family_name: String,
    weight: i32,
    width: i32,
    slant: i32,
  ) -> Result<Vec<FontVariationAxis>> {
    let font = get_font().map_err(into_napi_error)?;
    let axes = font.get_variation_axes(&family_name, weight, width, slant);
    Ok(
      axes
        .into_iter()
        .map(|axis| FontVariationAxis {
          tag: axis.tag,
          value: axis.value as f64,
          min: axis.min as f64,
          max: axis.max as f64,
          def: axis.def as f64,
          hidden: axis.hidden,
        })
        .collect(),
    )
  }

  #[napi]
  pub fn has_variations(family_name: String, weight: i32, width: i32, slant: i32) -> Result<bool> {
    let font = get_font().map_err(into_napi_error)?;
    Ok(font.has_variations(&family_name, weight, width, slant))
  }
}

fn load_fonts_from_dir<P: AsRef<path::Path>>(dir: P) -> napi::Result<u32> {
  let mut count = 0u32;
  if let Ok(dir) = read_dir(dir) {
    for f in dir.flatten() {
      if let Ok(meta) = f.metadata() {
        if meta.is_dir() {
          load_fonts_from_dir(f.path())?;
        } else {
          let p = f.path();
          // The font file extensions are case-insensitive.
          let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase());

          match ext.as_deref() {
            Some("ttf") | Some("ttc") | Some("otf") | Some("pfb") | Some("woff2")
            | Some("woff") => {
              if let Some(p) = p.into_os_string().to_str() {
                let font_collection = get_font().map_err(into_napi_error)?;
                if font_collection
                  .register_from_path::<String>(p, None)
                  .is_some()
                {
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
  Ok(count)
}
