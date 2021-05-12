use std::rc::Rc;

use crate::sk::*;
use napi::*;

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
