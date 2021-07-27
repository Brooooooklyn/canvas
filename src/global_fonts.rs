use std::fs::read_dir;
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

#[js_function(1)]
fn register(ctx: CallContext) -> Result<JsBoolean> {
  let this = ctx.this_unchecked::<JsObject>();
  let font_collection = ctx.env.unwrap::<Rc<FontCollection>>(&this)?;
  let font_data = ctx.get::<JsBuffer>(0)?.into_value()?;
  let register_result = font_collection.register(font_data.as_ref());
  ctx.env.get_boolean(register_result)
}

#[js_function(1)]
fn register_from_path(ctx: CallContext) -> Result<JsBoolean> {
  let this = ctx.this_unchecked::<JsObject>();
  let font_collection = ctx.env.unwrap::<Rc<FontCollection>>(&this)?;
  let font_path = ctx.get::<JsString>(0)?.into_utf8()?;
  let register_result = font_collection.register_from_path(font_path.as_str()?);
  ctx.env.get_boolean(register_result)
}

#[js_function]
fn get_families(ctx: CallContext) -> Result<JsObject> {
  let this = ctx.this_unchecked::<JsObject>();
  let font_collection = ctx.env.unwrap::<Rc<FontCollection>>(&this)?;

  let mut families = ctx.env.create_object()?;
  let family_names = font_collection.get_families();
  for name in &family_names {
    families.set_named_property(name.as_str(), ctx.env.get_boolean(true)?)?;
  }

  Ok(families)
}

#[js_function]
fn load_system_fonts(ctx: CallContext) -> Result<JsNumber> {
  let this = ctx.this_unchecked::<JsObject>();
  let font_collection = ctx.env.unwrap::<Rc<FontCollection>>(&this)?;
  let count = FONT_DIR.get_or_init(move || {
    let mut count = 0u32;
    if let Ok(dir) = read_dir(FONT_PATH) {
      for f in dir.flatten() {
        let p = f.path();
        let ext = p.extension().and_then(|s| s.to_str());

        match ext {
          Some("ttf") | Some("ttc") | Some("otf") | Some("pfb") => {
            if let Some(p) = p.into_os_string().to_str() {
              if font_collection.register_from_path(p) {
                count += 1;
              }
            }
          }
          _ => {}
        }
      }
    }
    count
  });
  ctx.env.create_uint32(*count)
}

impl FontCollection {
  pub fn create_js_class(env: &Env) -> Result<JsFunction> {
    env.define_class(
      "GlobalFonts",
      global_fonts_constructor,
      &[
        Property::new(env, "_register")?.with_method(register),
        Property::new(env, "_registerFromPath")?.with_method(register_from_path),
        Property::new(env, "_families")?
          .with_getter(get_families)
          .with_property_attributes(PropertyAttributes::Enumerable),
        Property::new(env, "loadSystemFonts")?.with_method(load_system_fonts),
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
