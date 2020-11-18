#[macro_use]
extern crate napi_derive;

use napi::*;

mod ctx;
mod gradient;
mod image;
mod sk;

#[cfg(all(unix, not(target_env = "musl")))]
#[global_allocator]
static ALLOC: jemallocator::Jemalloc = jemallocator::Jemalloc;

register_module!(skia, init);

fn init(module: &mut Module) -> Result<()> {
  let canvas_element = module.env.define_class(
    "CanvasElement",
    canvas_element_constructor,
    &[Property::new(&module.env, "getContext")?.with_method(get_context)],
  )?;

  let canvas_rendering_context2d = ctx::Context::create_js_class(&module.env)?;
  module
    .exports
    .set_named_property("CanvasRenderingContext2D", canvas_rendering_context2d)?;

  module
    .exports
    .set_named_property("CanvasElement", canvas_element)?;
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
