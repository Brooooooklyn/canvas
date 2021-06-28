use crate::sk::*;
use napi::*;

#[js_function(1)]
fn register(ctx: CallContext) -> Result<JsBoolean> {
  let this = ctx.this_unchecked::<JsObject>();
  let typeface_font_provider = ctx.env.unwrap::<TypefaceFontProvider>(&this)?;
  let font_data = ctx.get::<JsBuffer>(0)?.into_value()?;
  let register_result = typeface_font_provider.register(font_data.as_ref());
  ctx.env.get_boolean(register_result)
}

#[js_function]
fn get_families(ctx: CallContext) -> Result<JsObject> {
  let this = ctx.this_unchecked::<JsObject>();
  let typeface_font_provider = ctx.env.unwrap::<TypefaceFontProvider>(&this)?;

  let mut families = ctx.env.create_object()?;
  let family_names = typeface_font_provider.get_families();
  for name in &family_names {
    families.set_named_property(name.as_str(), ctx.env.get_boolean(true)?)?;
  }

  Ok(families)
}

impl TypefaceFontProvider {
  pub fn create_js_class(env: &Env) -> Result<JsFunction> {
    env.define_class(
      "GlobalFonts",
      global_fonts_constructor,
      &[
        Property::new(env, "_register")?.with_method(register),
        Property::new(env, "_families")?
          .with_getter(get_families)
          .with_property_attributes(PropertyAttributes::Enumerable),
      ],
    )
  }
}

#[js_function]
fn global_fonts_constructor(ctx: CallContext) -> Result<JsUndefined> {
  let typeface_font_provider = TypefaceFontProvider::new();
  let mut this = ctx.this_unchecked::<JsObject>();
  ctx.env.wrap(&mut this, typeface_font_provider)?;
  this.define_properties(&[])?;
  ctx.env.get_undefined()
}
