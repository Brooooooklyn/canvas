use crate::sk::*;
use napi::*;

#[js_function]
fn register(ctx: CallContext) -> Result<JsUndefined> {
  ctx.env.get_undefined()
}

#[js_function]
fn get_families(ctx: CallContext) -> Result<JsObject> {
  let this = ctx.this_unchecked::<JsObject>();
  let font_collection = ctx.env.unwrap::<FontCollection>(&this)?;

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
      &vec![
        Property::new(&env, "register")?.with_method(register),
        Property::new(&env, "_families")?
          .with_getter(get_families)
          .with_property_attributes(PropertyAttributes::Enumerable),
      ],
    )
  }
}

#[js_function]
fn global_fonts_constructor(ctx: CallContext) -> Result<JsUndefined> {
  let font_collection = FontCollection::new();
  let mut this = ctx.this_unchecked::<JsObject>();
  ctx.env.wrap(&mut this, font_collection)?;
  this.define_properties(&[])?;
  ctx.env.get_undefined()
}
