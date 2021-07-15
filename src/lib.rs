#![deny(clippy::all)]
#![allow(clippy::many_single_char_names)]
#![allow(clippy::too_many_arguments)]

#[macro_use]
extern crate napi_derive;

use std::convert::TryInto;
use std::mem;

use napi::*;

use ctx::{Context, ContextData};
use font::{init_font_regexp, FONT_REGEXP};
use sk::SurfaceDataRef;

#[cfg(all(
  target_arch = "x86_64",
  not(target_env = "musl"),
  not(debug_assertions)
))]
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod ctx;
mod error;
mod font;
mod global_fonts;
mod gradient;
mod image;
mod image_pattern;
mod path;
mod pattern;
#[allow(dead_code)]
mod sk;
mod state;

const MIME_WEBP: &str = "image/webp";
const MIME_PNG: &str = "image/png";
const MIME_JPEG: &str = "image/jpeg";

#[module_exports]
fn init(mut exports: JsObject, env: Env) -> Result<()> {
  let canvas_element = env.define_class(
    "CanvasElement",
    canvas_element_constructor,
    &[
      Property::new(&env, "getContext")?.with_method(get_context),
      Property::new(&env, "encode")?.with_method(encode),
      Property::new(&env, "encodeSync")?.with_method(encode_sync),
      Property::new(&env, "toBuffer")?.with_method(to_buffer),
      Property::new(&env, "savePNG")?.with_method(save_png),
      Property::new(&env, "data")?.with_method(data),
      Property::new(&env, "toDataURL")?.with_method(to_data_url),
      Property::new(&env, "toDataURLAsync")?.with_method(to_data_url_async),
    ],
  )?;

  let canvas_rendering_context2d = ctx::Context::create_js_class(&env)?;

  let path_class = sk::Path::create_js_class(&env)?;

  let image_data_class = image::ImageData::create_js_class(&env)?;

  let image_class = image::Image::create_js_class(&env)?;

  let canvas_pattern = env.define_class(
    "CanvasPattern",
    image_pattern::canvas_pattern_constructor,
    &[Property::new(&env, "setTransform")?.with_method(image_pattern::set_transform)],
  )?;

  let global_fonts = sk::FontCollection::create_js_class(&env)?;

  exports.set_named_property("CanvasRenderingContext2D", canvas_rendering_context2d)?;

  exports.set_named_property("CanvasElement", canvas_element)?;

  exports.set_named_property("Path2D", path_class)?;

  exports.set_named_property("ImageData", image_data_class)?;

  exports.set_named_property("Image", image_class)?;

  exports.set_named_property("CanvasPattern", canvas_pattern)?;

  exports.set_named_property("GlobalFonts", global_fonts)?;

  // pre init font regexp
  FONT_REGEXP.get_or_init(init_font_regexp);
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

#[js_function(2)]
fn get_context(ctx: CallContext) -> Result<JsObject> {
  let context_type = ctx.get::<JsString>(0)?.into_utf8()?;
  if context_type.as_str()? != "2d" {
    return Err(Error::new(
      Status::InvalidArg,
      "Only supports 2d context".to_owned(),
    ));
  }

  let this = ctx.this_unchecked::<JsObject>();
  let ctx_js = this.get_named_property::<JsObject>("ctx")?;
  let context_2d = ctx.env.unwrap::<Context>(&ctx_js)?;

  if ctx.length == 2 {
    let attrs = ctx.get::<JsObject>(1)?;
    let alpha = attrs
      .get_named_property::<JsBoolean>("alpha")?
      .get_value()?;
    if !alpha {
      let mut fill_paint = context_2d.fill_paint()?;
      fill_paint.set_color(255, 255, 255, 255);
      let w: f64 = this.get_named_property::<JsNumber>("width")?.try_into()?;
      let h: f64 = this.get_named_property::<JsNumber>("height")?.try_into()?;
      context_2d.alpha = false;
      context_2d
        .surface
        .draw_rect(0f32, 0f32, w as f32, h as f32, &fill_paint);
    }
  }

  Ok(ctx_js)
}

#[js_function(2)]
fn encode(ctx: CallContext) -> Result<JsObject> {
  let format = ctx.get::<JsString>(0)?.into_utf8()?;
  let quality = if ctx.length == 1 {
    92
  } else {
    ctx.get::<JsNumber>(1)?.get_uint32()? as u8
  };
  let this = ctx.this_unchecked::<JsObject>();
  let ctx_js = this.get_named_property::<JsObject>("ctx")?;
  let ctx2d = ctx.env.unwrap::<Context>(&ctx_js)?;
  let surface_ref = ctx2d.surface.reference();

  let task = match format.as_str()? {
    "webp" => ContextData::Webp(surface_ref, quality),
    "jpeg" => ContextData::Jpeg(surface_ref, quality),
    "png" => ContextData::Png(surface_ref),
    _ => {
      return Err(Error::new(
        Status::InvalidArg,
        format!("{} is not valid format", format.as_str()?),
      ))
    }
  };

  ctx.env.spawn(task).map(|p| p.promise_object())
}

#[js_function(2)]
fn encode_sync(ctx: CallContext) -> Result<JsBuffer> {
  let format = ctx.get::<JsString>(0)?.into_utf8()?;
  let quality = if ctx.length == 1 {
    100
  } else {
    ctx.get::<JsNumber>(1)?.get_uint32()? as u8
  };
  let this = ctx.this_unchecked::<JsObject>();
  let ctx_js = this.get_named_property::<JsObject>("ctx")?;
  let ctx2d = ctx.env.unwrap::<Context>(&ctx_js)?;
  let surface_ref = ctx2d.surface.reference();

  if let Some(data_ref) = match format.as_str()? {
    "webp" => surface_ref.encode_data(sk::SkEncodedImageFormat::Webp, quality),
    "jpeg" => surface_ref.encode_data(sk::SkEncodedImageFormat::Jpeg, quality),
    "png" => surface_ref.png_data(),
    _ => {
      return Err(Error::new(
        Status::InvalidArg,
        format!("{} is not valid format", format.as_str()?),
      ))
    }
  } {
    unsafe {
      ctx
        .env
        .create_buffer_with_borrowed_data(
          data_ref.0.ptr,
          data_ref.0.size,
          data_ref,
          |data: SurfaceDataRef, _| mem::drop(data),
        )
        .map(|b| b.into_raw())
    }
  } else {
    Err(Error::new(
      Status::InvalidArg,
      format!("encode {} output failed", format.as_str()?),
    ))
  }
}

#[js_function(2)]
fn to_buffer(ctx: CallContext) -> Result<JsBuffer> {
  let mime = if ctx.length == 0 {
    MIME_PNG.to_owned()
  } else {
    let mime_js = ctx.get::<JsString>(0)?.into_utf8()?;
    mime_js.as_str()?.to_owned()
  };
  let quality = if ctx.length < 2 {
    92
  } else {
    ctx.get::<JsNumber>(1)?.get_uint32()? as u8
  };

  let data_ref = get_data_ref(&ctx, mime.as_str(), quality)?;
  unsafe {
    ctx
      .env
      .create_buffer_with_borrowed_data(
        data_ref.0.ptr,
        data_ref.0.size,
        data_ref,
        |data: SurfaceDataRef, _| mem::drop(data),
      )
      .map(|b| b.into_raw())
  }
}

#[js_function]
fn data(ctx: CallContext) -> Result<JsBuffer> {
  let this = ctx.this_unchecked::<JsObject>();
  let ctx_js = this.get_named_property::<JsObject>("ctx")?;
  let ctx2d = ctx.env.unwrap::<Context>(&ctx_js)?;

  let surface_ref = ctx2d.surface.reference();

  let (ptr, size) = surface_ref.data().ok_or_else(|| {
    Error::new(
      Status::GenericFailure,
      "Get png data from surface failed".to_string(),
    )
  })?;
  unsafe {
    ctx
      .env
      .create_buffer_with_borrowed_data(ptr, size, 0, noop_finalize)
      .map(|value| value.into_raw())
  }
}

#[js_function(2)]
fn to_data_url(ctx: CallContext) -> Result<JsString> {
  let mime = if ctx.length == 0 {
    MIME_PNG.to_owned()
  } else {
    let mime_js = ctx.get::<JsString>(0)?.into_utf8()?;
    mime_js.as_str()?.to_owned()
  };
  let quality = if ctx.length < 2 {
    // https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL
    92
  } else {
    ctx.get::<JsNumber>(1)?.get_uint32()? as u8
  };
  let data_ref = get_data_ref(&ctx, mime.as_str(), quality)?;
  let mut output = format!("data:{};base64,", &mime);
  base64::encode_config_buf(data_ref.slice(), base64::URL_SAFE, &mut output);
  ctx.env.create_string_from_std(output)
}

#[js_function(2)]
fn to_data_url_async(ctx: CallContext) -> Result<JsObject> {
  let mime = if ctx.length == 0 {
    MIME_PNG.to_owned()
  } else {
    let mime_js = ctx.get::<JsString>(0)?.into_utf8()?;
    mime_js.as_str()?.to_owned()
  };
  let quality = if ctx.length < 2 {
    // https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL
    92
  } else {
    ctx.get::<JsNumber>(1)?.get_uint32()? as u8
  };
  let data_ref = get_data_ref(&ctx, mime.as_str(), quality)?;
  let async_task = AsyncDataUrl {
    surface_data: data_ref,
    mime,
  };
  ctx.env.spawn(async_task).map(|p| p.promise_object())
}

#[inline]
fn get_data_ref(ctx: &CallContext, mime: &str, quality: u8) -> Result<SurfaceDataRef> {
  let this = ctx.this_unchecked::<JsObject>();
  let ctx_js = this.get_named_property::<JsObject>("ctx")?;
  let ctx2d = ctx.env.unwrap::<Context>(&ctx_js)?;
  let surface_ref = ctx2d.surface.reference();

  if let Some(data_ref) = match mime {
    MIME_WEBP => surface_ref.encode_data(sk::SkEncodedImageFormat::Webp, quality),
    MIME_JPEG => surface_ref.encode_data(sk::SkEncodedImageFormat::Jpeg, quality),
    MIME_PNG => surface_ref.png_data(),
    _ => {
      return Err(Error::new(
        Status::InvalidArg,
        format!("{} is not valid mime", mime),
      ))
    }
  } {
    Ok(data_ref)
  } else {
    Err(Error::new(
      Status::InvalidArg,
      format!("encode {} output failed", mime),
    ))
  }
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

struct AsyncDataUrl {
  surface_data: SurfaceDataRef,
  mime: String,
}

impl Task for AsyncDataUrl {
  type Output = String;
  type JsValue = JsString;

  fn compute(&mut self) -> Result<Self::Output> {
    let mut output = format!("data:{};base64,", &self.mime);
    base64::encode_config_buf(self.surface_data.slice(), base64::URL_SAFE, &mut output);
    Ok(output)
  }

  fn resolve(self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
    env.create_string_from_std(output)
  }
}
