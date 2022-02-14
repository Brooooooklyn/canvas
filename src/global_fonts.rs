use std::fs::read_dir;
use std::path;
use std::rc::Rc;

use napi::*;
use once_cell::sync::OnceCell;

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

#[js_function(2)]
fn register(ctx: CallContext) -> Result<JsBoolean> {
  let this = ctx.this_unchecked::<JsObject>();
  let font_collection = ctx.env.unwrap::<Rc<FontCollection>>(&this)?;
  let font_data = ctx.get::<JsBuffer>(0)?.into_value()?;
  let name_alias = ctx.get::<JsString>(1)?.into_utf8()?;
  let name_alias = name_alias.as_str()?;
  let maybe_name_alias = if name_alias.is_empty() {
    None
  } else {
    Some(name_alias)
  };
  let register_result = font_collection.register(font_data.as_ref(), maybe_name_alias);
  ctx.env.get_boolean(register_result)
}

#[js_function(2)]
fn register_from_path(ctx: CallContext) -> Result<JsBoolean> {
  let this = ctx.this_unchecked::<JsObject>();
  let font_collection = ctx.env.unwrap::<Rc<FontCollection>>(&this)?;
  let font_path = ctx.get::<JsString>(0)?.into_utf8()?;
  let name_alias = ctx.get::<JsString>(1)?.into_utf8()?;
  let name_alias = name_alias.as_str()?;
  let maybe_name_alias = if name_alias.is_empty() {
    None
  } else {
    Some(name_alias)
  };
  let register_result = font_collection.register_from_path(font_path.as_str()?, maybe_name_alias);
  ctx.env.get_boolean(register_result)
}

#[js_function]
fn get_families(ctx: CallContext) -> Result<JsString> {
  let this = ctx.this_unchecked::<JsObject>();
  let font_collection = ctx.env.unwrap::<Rc<FontCollection>>(&this)?;

  let all_style_set = font_collection.get_families();

  ctx
    .env
    .create_string_from_std(serde_json::to_string(&all_style_set)?)
}

#[js_function]
fn load_system_fonts(ctx: CallContext) -> Result<JsNumber> {
  let this = ctx.this_unchecked::<JsObject>();
  let font_collection = ctx.env.unwrap::<Rc<FontCollection>>(&this)?;
  let count = FONT_DIR.get_or_init(move || load_fonts_from_dir(font_collection, FONT_PATH));
  ctx.env.create_uint32(*count)
}

#[js_function(1)]
fn load_fonts(ctx: CallContext) -> Result<JsNumber> {
  let this = ctx.this_unchecked::<JsObject>();
  let font_collection = ctx.env.unwrap::<Rc<FontCollection>>(&this)?;
  let dir = ctx.get::<JsString>(0)?.into_utf8()?;
  ctx
    .env
    .create_uint32(load_fonts_from_dir(font_collection, dir.as_str()?))
}

#[js_function(2)]
fn set_alias(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let font_collection = ctx.env.unwrap::<Rc<FontCollection>>(&this)?;
  let font_name = ctx.get::<JsString>(0)?.into_utf8()?;
  let alias = ctx.get::<JsString>(1)?.into_utf8()?;
  font_collection.set_alias(font_name.as_str()?, alias.as_str()?);
  ctx.env.get_undefined()
}

fn load_fonts_from_dir<P: AsRef<path::Path>>(
  font_collection: &mut Rc<FontCollection>,
  dir: P,
) -> u32 {
  let mut count = 0u32;
  if let Ok(dir) = read_dir(dir) {
    for f in dir.flatten() {
      if let Ok(meta) = f.metadata() {
        if meta.is_dir() {
          load_fonts_from_dir(font_collection, f.path());
        } else {
          let p = f.path();
          let ext = p.extension().and_then(|s| s.to_str());

          match ext {
            Some("ttf") | Some("ttc") | Some("otf") | Some("pfb") | Some("woff2")
            | Some("woff") => {
              if let Some(p) = p.into_os_string().to_str() {
                if font_collection.register_from_path(p, None) {
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

impl FontCollection {
  pub fn create_js_class(env: &Env) -> Result<JsFunction> {
    env.define_class(
      "GlobalFonts",
      global_fonts_constructor,
      &[
        Property::new("_register")?.with_method(register),
        Property::new("_registerFromPath")?.with_method(register_from_path),
        Property::new("_families")?
          .with_getter(get_families)
          .with_property_attributes(PropertyAttributes::Enumerable),
        Property::new("_loadFontsFromDir")?.with_method(load_fonts),
        Property::new("loadSystemFonts")?.with_method(load_system_fonts),
        Property::new("setAlias")?.with_method(set_alias),
      ],
    )
  }
}

#[js_function]
fn global_fonts_constructor(ctx: CallContext) -> Result<JsUndefined> {
  let font_collection = Rc::new(FontCollection::new());
  let mut this = ctx.this_unchecked::<JsObject>();
  ctx.env.wrap(&mut this, font_collection)?;
  this.define_properties(&[])?;
  ctx.env.get_undefined()
}
