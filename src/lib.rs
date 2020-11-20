#[macro_use]
extern crate napi_derive;

use napi::*;

use ctx::Context;

mod ctx;
mod error;
mod gradient;
mod image;
mod pattern;
mod sk;
mod state;

#[module_exports]
fn init(mut exports: JsObject, env: Env) -> Result<()> {
  let canvas_element = env.define_class(
    "CanvasElement",
    canvas_element_constructor,
    &[
      Property::new(&env, "getContext")?.with_method(get_context),
      Property::new(&env, "toBuffer")?.with_method(to_buffer),
      Property::new(&env, "savePNG")?.with_method(save_png),
    ],
  )?;

  let canvas_rendering_context2d = ctx::Context::create_js_class(&env)?;

  exports.set_named_property("CanvasRenderingContext2D", canvas_rendering_context2d)?;

  exports.set_named_property("CanvasElement", canvas_element)?;
  Ok(())
}

#[js_function(2)]
fn canvas_element_constructor(ctx: CallContext) -> Result<JsUndefined> {
  let width = ctx.get::<JsNumber>(0)?;
  let height = ctx.get::<JsNumber>(1)?;
  let mut this = ctx.this_unchecked::<JsObject>();
  this.set_named_property("width", width)?;
  this.set_named_property("height", height)?;
  ctx.env.get_undefined()
}

#[js_function(1)]
fn get_context(ctx: CallContext) -> Result<JsObject> {
  let context_type = ctx.get::<JsString>(0)?.into_utf8()?;
  if context_type.as_str()? != "2d" {
    return Err(Error::new(
      Status::InvalidArg,
      "Only supports 2d context".to_owned(),
    ));
  }
  let this = ctx.this_unchecked::<JsObject>();
  this.get_named_property("ctx")
}

#[js_function]
fn to_buffer(ctx: CallContext) -> Result<JsBuffer> {
  let this = ctx.this_unchecked::<JsObject>();
  let ctx_js = this.get_named_property::<JsObject>("ctx")?;
  let ctx2d = ctx.env.unwrap::<Context>(&ctx_js)?;

  ctx
    .env
    .create_buffer_with_data(ctx2d.surface.png_data().to_vec())
    .map(|b| b.into_raw())
}

#[js_function(1)]
fn save_png(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path = ctx.get::<JsString>(0)?;
  let ctx_js = this.get_named_property::<JsObject>("ctx")?;
  let ctx2d = ctx.env.unwrap::<Context>(&ctx_js)?;

  ctx2d.surface.save_png(path.into_utf8()?.as_str()?);

  ctx.env.get_undefined()
}
