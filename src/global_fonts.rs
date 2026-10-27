use std::fs::read_dir;
use std::path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LockResult, Mutex, MutexGuard, OnceLock, PoisonError};

use crate::font::{FontParseContext, FontRelativeUnits, PARENT_FONT_SIZE, ROOT_FONT_SIZE};
use crate::sk::*;

#[cfg(target_os = "windows")]
const FONT_PATH: &str = "C:/Windows/Fonts";
#[cfg(target_os = "linux")]
const FONT_PATH: &str = "/usr/share/fonts/";
#[cfg(target_os = "android")]
const FONT_PATH: &str = "/system/fonts";
#[cfg(target_os = "macos")]
const FONT_PATH: &str = "/System/Library/Fonts/";

#[cfg(not(target_os = "macos"))]
static FONT_DIR: OnceLock<napi::Result<u32>> = OnceLock::new();

static GLOBAL_FONT_COLLECTION: OnceLock<Mutex<FontCollection>> = OnceLock::new();

/// Whether useSystemFontRenderer() is on, for Rust readers. The C++ side keeps
/// its own copy (font_scalers.cpp SystemFontRenderer); both are written
/// together, under the font lock once the collection exists.
static SYSTEM_FONT_RENDERER: AtomicBool = AtomicBool::new(true);

pub(crate) fn system_font_renderer() -> bool {
  SYSTEM_FONT_RENDERER.load(Ordering::Relaxed)
}

/// Monotonic generation of the global font collection: every registration,
/// unregister or alias change can move which typeface a font descriptor
/// resolves to, so it is folded into the draw-side typeface dedup key
/// (RasterKey::Typeface) -- a same-named draw before and after a register()
/// pins different typefaces and must not share one charge.
static FONT_COLLECTION_GENERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) fn font_collection_generation() -> u64 {
  FONT_COLLECTION_GENERATION.load(Ordering::Relaxed)
}

fn note_font_collection_mutation() {
  FONT_COLLECTION_GENERATION.fetch_add(1, Ordering::Relaxed);
}

/// The font-relative units (`ex`, `ch`, `cap`, `ic`, `lh` and their root
/// forms) the canvas `font` setter resolves against: the default style's font
/// at 10px and at 16px (skia-c/font_families.cpp). Cached per font collection
/// generation.
pub(crate) fn font_parse_context() -> FontParseContext {
  static CACHE: Mutex<Option<(u64, FontParseContext)>> = Mutex::new(None);
  let generation = font_collection_generation();
  if let Ok(cache) = CACHE.lock()
    && let Some((cached, context)) = *cache
    && cached == generation
  {
    return context;
  }
  let units = |fonts: &FontCollection, size: f64| {
    fonts
      .default_font_units(size as f32)
      .map(|u| FontRelativeUnits {
        ex: u.ex as f64,
        ch: u.ch as f64,
        cap: u.cap as f64,
        ic: u.ic as f64,
        lh: u.lh as f64,
      })
      .unwrap_or_else(|| FontRelativeUnits::fallback(size))
  };
  let context = match get_font() {
    Ok(fonts) => FontParseContext {
      parent: units(&fonts, PARENT_FONT_SIZE),
      root: units(&fonts, ROOT_FONT_SIZE),
    },
    Err(_) => FontParseContext::default(),
  };
  if let Ok(mut cache) = CACHE.lock() {
    *cache = Some((generation, context));
  }
  context
}

#[inline]
pub(crate) fn get_font<'a>() -> LockResult<MutexGuard<'a, FontCollection>> {
  GLOBAL_FONT_COLLECTION
    .get_or_init(|| Mutex::new(FontCollection::new()))
    .lock()
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

/// Draws text with each OS's own font renderer, as Chrome does, for the whole
/// process; `false` switches back. Every registered font is made again and
/// every text cache is dropped.
#[napi]
pub fn use_system_font_renderer(enabled: Option<bool>) -> napi::Result<()> {
  let enabled = enabled.unwrap_or(true);
  let mut fresh = false;
  // Called before any font use: the collection is made in that mode.
  let collection = GLOBAL_FONT_COLLECTION.get_or_init(|| {
    fresh = true;
    SYSTEM_FONT_RENDERER.store(enabled, Ordering::Relaxed);
    set_system_font_renderer_flag(enabled);
    Mutex::new(FontCollection::new())
  });
  if fresh {
    note_font_collection_mutation();
    return Ok(());
  }
  let font = collection.lock().map_err(into_napi_error)?;
  if SYSTEM_FONT_RENDERER.load(Ordering::Relaxed) == enabled {
    return Ok(());
  }
  SYSTEM_FONT_RENDERER.store(enabled, Ordering::Relaxed);
  if font.set_system_font_renderer(enabled) {
    // Bump while the lock is held, as the registrations do.
    note_font_collection_mutation();
  }
  Ok(())
}

#[napi(js_name = "GlobalFonts")]
#[allow(non_snake_case)]
pub mod global_fonts {
  use napi::bindgen_prelude::*;

  #[cfg(not(target_os = "macos"))]
  use super::FONT_DIR;
  use super::{FontKey, get_font, into_napi_error};

  #[napi]
  pub fn register(font_data: &[u8], name_alias: Option<String>) -> Result<Option<FontKey>> {
    let maybe_name_alias = name_alias.filter(|s| !s.is_empty());
    let font = get_font().map_err(into_napi_error)?;
    let result = font
      .register(font_data, maybe_name_alias)
      .map(|typeface_id| FontKey { typeface_id });
    if result.is_some() {
      super::note_font_collection_mutation();
    }
    Ok(result)
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
    let maybe_name_alias = name_alias.filter(|s| !s.is_empty());
    let font = get_font().map_err(into_napi_error)?;
    let result = font
      .register_from_path(font_path.as_str(), maybe_name_alias)
      .map(|typeface_id| FontKey { typeface_id });
    if result.is_some() {
      super::note_font_collection_mutation();
    }
    Ok(result)
  }

  #[napi]
  pub fn get_families() -> Result<Buffer> {
    let font = get_font().map_err(into_napi_error)?;
    Ok(serde_json::to_vec(&font.get_families())?.into())
  }

  /// Registers the installed fonts and returns how many. On macOS they are
  /// the faces CoreText lists (Chrome's font set there), user fonts included,
  /// with the system font renderer; else face 0 of each file in
  /// /System/Library/Fonts.
  #[napi]
  pub fn load_system_fonts() -> Result<u32> {
    // The installed fonts follow the renderer mode, so macOS asks each time
    // (they are listed once per mode).
    #[cfg(target_os = "macos")]
    {
      super::load_system_fonts()
    }
    #[cfg(not(target_os = "macos"))]
    {
      FONT_DIR
        .get_or_init(super::load_system_fonts)
        .as_ref()
        .map(|s| *s)
        .map_err(|e| Error::new(e.status, e.reason.clone()))
    }
  }

  /// What index.js runs at startup, with the user font folders. macOS lists
  /// the installed fonts at the first font lookup instead, as listing them
  /// takes about 150 ms; elsewhere this is `loadSystemFonts`, then
  /// `loadFontsFromDir` for each folder.
  #[napi]
  pub fn enable_system_fonts(user_font_dirs: Option<Vec<String>>) -> Result<()> {
    let user_font_dirs = user_font_dirs.unwrap_or_default();
    #[cfg(target_os = "macos")]
    {
      let mut files = super::font_files(super::FONT_PATH);
      for dir in &user_font_dirs {
        files.extend(super::font_files(dir));
      }
      let font = get_font().map_err(into_napi_error)?;
      font.enable_installed_fonts(&files);
      super::note_font_collection_mutation();
      Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
      load_system_fonts()?;
      for dir in &user_font_dirs {
        super::load_fonts_from_dir(dir)?;
      }
      Ok(())
    }
  }

  #[napi]
  pub fn load_fonts_from_dir(dir: String) -> Result<u32> {
    super::load_fonts_from_dir(dir.as_str())
  }

  #[napi]
  pub fn set_alias(font_name: String, alias: String) -> Result<bool> {
    let font = get_font().map_err(into_napi_error)?;
    let result = font.set_alias(font_name.as_str(), alias.as_str());
    if result {
      super::note_font_collection_mutation();
    }
    Ok(result)
  }

  /// Remove a previously registered font from the global font collection.
  /// Returns true if the font was successfully removed, false if it was not found.
  #[napi]
  pub fn remove(key: &FontKey) -> Result<bool> {
    let font = get_font().map_err(into_napi_error)?;
    let result = font.unregister(key.typeface_id);
    if result {
      super::note_font_collection_mutation();
    }
    Ok(result)
  }

  #[napi]
  /// Remove multiple fonts by their keys in a single operation.
  /// More efficient than calling remove() multiple times as it triggers only one rebuild.
  /// Returns the number of fonts successfully removed.
  pub fn remove_batch(font_keys: Vec<&FontKey>) -> Result<u32> {
    let typeface_ids: Vec<u32> = font_keys.iter().map(|k| k.typeface_id).collect();
    let font = get_font().map_err(into_napi_error)?;
    let removed = font.unregister_batch(&typeface_ids);
    if removed > 0 {
      super::note_font_collection_mutation();
    }
    Ok(removed as u32)
  }

  #[napi]
  /// Remove ALL registered fonts in a single operation.
  /// Returns the number of fonts removed.
  pub fn remove_all() -> Result<u32> {
    let font = get_font().map_err(into_napi_error)?;
    let removed = font.unregister_all();
    if removed > 0 {
      super::note_font_collection_mutation();
    }
    Ok(removed as u32)
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

#[cfg(not(target_os = "macos"))]
fn load_system_fonts() -> napi::Result<u32> {
  load_fonts_from_dir(FONT_PATH)
}

#[cfg(target_os = "macos")]
fn load_system_fonts() -> napi::Result<u32> {
  let files = font_files(FONT_PATH);
  let font_collection = get_font().map_err(into_napi_error)?;
  let count = font_collection.load_installed_fonts(&files);
  note_font_collection_mutation();
  Ok(count)
}

/// Whether `p` names a font file; the extensions are case-insensitive.
fn is_font_file(p: &path::Path) -> bool {
  let ext = p
    .extension()
    .and_then(|s| s.to_str())
    .map(|s| s.to_ascii_lowercase());
  matches!(
    ext.as_deref(),
    Some("ttf") | Some("ttc") | Some("otf") | Some("pfb") | Some("woff2") | Some("woff")
  )
}

/// The font files under `dir`, in the order load_fonts_from_dir visits them.
#[cfg(target_os = "macos")]
fn font_files<P: AsRef<path::Path>>(dir: P) -> Vec<String> {
  let mut files = Vec::new();
  if let Ok(dir) = read_dir(dir) {
    for f in dir.flatten() {
      if let Ok(meta) = f.metadata() {
        let p = f.path();
        if meta.is_dir() {
          files.extend(font_files(p));
        } else if is_font_file(&p)
          && let Some(p) = p.to_str()
        {
          files.push(p.to_owned());
        }
      }
    }
  }
  files
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
          if is_font_file(&p)
            && let Some(p) = p.into_os_string().to_str()
          {
            let font_collection = get_font().map_err(into_napi_error)?;
            if font_collection.register_system_font(p).is_some() {
              // Bump while the collection lock is still held and after
              // EACH registration: the guard drops between files, so a
              // reader on another thread can resolve a family mid-load.
              // Deferring the bump to the end of the directory leaves a
              // window where a draw picks up the new typeface under the
              // previous generation and dedups it into a stale
              // RasterKey::Typeface charge.
              note_font_collection_mutation();
              count += 1;
            }
          }
        }
      }
    }
  }
  Ok(count)
}
