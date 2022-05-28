#![deny(clippy::all)]
#![allow(clippy::many_single_char_names)]
#![allow(clippy::too_many_arguments)]

#[macro_use]
extern crate napi_derive;
#[macro_use]
extern crate serde_derive;

use std::{mem, slice};

use napi::*;

use ctx::{AVIFConfig, Context, ContextData, ContextOutputData, ImageOrCanvas};
use font::{init_font_regexp, FONT_REGEXP};
use rgb::FromSlice;
use sk::SkiaDataRef;

#[cfg(all(
  not(all(target_os = "linux", target_env = "musl", target_arch = "aarch64")),
  not(debug_assertions)
))]
#[global_allocator]
static ALLOC: mimalloc_rust::GlobalMiMalloc = mimalloc_rust::GlobalMiMalloc;

mod ctx;
mod error;
mod filter;
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
mod svg;

const MIME_WEBP: &str = "image/webp";
const MIME_PNG: &str = "image/png";
const MIME_JPEG: &str = "image/jpeg";
const MIME_AVIF: &str = "image/avif";

// Consistent with the default value of JPEG quality in Blink
// https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/platform/image-encoders/image_encoder.cc;l=85;drc=81c6f843fdfd8ef660d733289a7a32abe68e247a
const DEFAULT_JPEG_QUALITY: u8 = 92;

// Consistent with the default value of WebP quality in Blink
// https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/platform/image-encoders/image_encoder.cc;l=100;drc=81c6f843fdfd8ef660d733289a7a32abe68e247a
const DEFAULT_WEBP_QUALITY: u8 = 80;

#[module_exports]
fn init(mut exports: JsObject, env: Env) -> Result<()> {
  let canvas_element = env.define_class(
    "CanvasElement",
    canvas_element_constructor,
    &[
      Property::new("encode")?
        .with_method(encode)
        .with_property_attributes(PropertyAttributes::Writable),
      Property::new("encodeSync")?
        .with_method(encode_sync)
        .with_property_attributes(PropertyAttributes::Writable),
      Property::new("toBuffer")?
        .with_method(to_buffer)
        .with_property_attributes(PropertyAttributes::Writable),
      Property::new("savePNG")?
        .with_method(save_png)
        .with_property_attributes(PropertyAttributes::Writable),
      Property::new("data")?
        .with_method(data)
        .with_property_attributes(PropertyAttributes::Writable),
      Property::new("toDataURL")?
        .with_method(to_data_url)
        .with_property_attributes(PropertyAttributes::Writable),
      Property::new("toDataURLAsync")?
        .with_method(to_data_url_async)
        .with_property_attributes(PropertyAttributes::Writable),
    ],
  )?;

  let svg_canvas_element = env.define_class(
    "SVGCanvas",
    canvas_element_constructor,
    &[Property::new("getContent")?.with_method(get_content)],
  )?;

  let canvas_rendering_context2d = ctx::Context::create_js_class(&env)?;

  let path_class = sk::Path::create_js_class(&env)?;

  let image_data_class = image::ImageData::create_js_class(&env)?;

  let image_class = image::Image::create_js_class(&env)?;

  let canvas_pattern = env.define_class(
    "CanvasPattern",
    image_pattern::canvas_pattern_constructor,
    &[Property::new("setTransform")?.with_method(image_pattern::set_transform)],
  )?;

  let global_fonts = sk::FontCollection::create_js_class(&env)?;

  exports.set_named_property("CanvasRenderingContext2D", canvas_rendering_context2d)?;

  exports.set_named_property("CanvasElement", canvas_element)?;

  exports.set_named_property("SVGCanvas", svg_canvas_element)?;

  exports.set_named_property("Path2D", path_class)?;

  exports.set_named_property("ImageData", image_data_class)?;

  exports.set_named_property("Image", image_class)?;

  exports.set_named_property("CanvasPattern", canvas_pattern)?;

  exports.set_named_property("GlobalFonts", global_fonts)?;

  exports.create_named_method("convertSVGTextToPath", svg::convert_svg_text_to_path)?;

  exports.create_named_method("createContext", create_context)?;

  // pre init font regexp
  FONT_REGEXP.get_or_init(init_font_regexp);
  Ok(())
}

#[js_function(2)]
fn canvas_element_constructor(ctx: CallContext) -> Result<JsUndefined> {
  let width = ctx.get::<JsNumber>(0)?;
  let height = ctx.get::<JsNumber>(1)?;
  let mut this = ctx.this_unchecked::<JsObject>();
  ctx.env.wrap(&mut this, ImageOrCanvas::Canvas)?;
  this.set_named_property("width", width)?;
  this.set_named_property("height", height)?;
  ctx.env.get_undefined()
}

#[js_function(4)]
fn create_context(ctx: CallContext) -> Result<JsUndefined> {
  let context_2d_object = ctx.get::<JsObject>(0)?;
  let context_2d = ctx.env.unwrap::<Context>(&context_2d_object)?;

  let w = ctx.get::<JsNumber>(1)?.get_double()?;
  let h = ctx.get::<JsNumber>(2)?.get_double()?;
  let attrs = ctx.get::<JsObject>(3)?;
  let alpha = attrs
    .get_named_property_unchecked::<JsBoolean>("alpha")?
    .get_value()?;
  if !alpha {
    let mut fill_paint = context_2d.fill_paint()?;
    fill_paint.set_color(255, 255, 255, 255);
    context_2d.alpha = false;
    context_2d
      .surface
      .draw_rect(0f32, 0f32, w as f32, h as f32, &fill_paint);
  }

  ctx.env.get_undefined()
}

#[js_function(2)]
fn encode(ctx: CallContext) -> Result<JsObject> {
  let format = ctx.get::<JsString>(0)?.into_utf8()?;
  let format_str = format.as_str()?;
  let quality = match ctx.get::<JsNumber>(1)?.get_uint32() {
    Ok(number) => number as u8,
    Err(_e) => match format_str {
      "webp" => DEFAULT_WEBP_QUALITY,
      _ => DEFAULT_JPEG_QUALITY,
    },
  };
  let this = ctx.this_unchecked::<JsObject>();
  let ctx_js = this.get_named_property::<JsObject>("ctx")?;
  let ctx2d = ctx.env.unwrap::<Context>(&ctx_js)?;
  let surface_ref = ctx2d.surface.reference();

  let task = match format_str {
    "webp" => ContextData::Webp(surface_ref, quality),
    "jpeg" => ContextData::Jpeg(surface_ref, quality),
    "png" => ContextData::Png(surface_ref),
    "avif" => {
      let cfg: AVIFConfig = serde_json::from_str(ctx.get::<JsString>(1)?.into_utf8()?.as_str()?)?;
      ContextData::Avif(surface_ref, cfg, ctx2d.width, ctx2d.height)
    }
    _ => {
      return Err(Error::new(
        Status::InvalidArg,
        format!("{} is not valid format", format_str),
      ))
    }
  };

  ctx.env.spawn(task).map(|p| p.promise_object())
}

#[js_function(2)]
fn encode_sync(ctx: CallContext) -> Result<JsBuffer> {
  let format = ctx.get::<JsString>(0)?.into_utf8()?;
  let format_str = format.as_str()?;
  let quality = match ctx.get::<JsNumber>(1)?.get_uint32() {
    Ok(number) => number as u8,
    Err(_e) => match format_str {
      "webp" => DEFAULT_WEBP_QUALITY,
      _ => DEFAULT_JPEG_QUALITY,
    },
  };
  let this = ctx.this_unchecked::<JsObject>();
  let ctx_js = this.get_named_property::<JsObject>("ctx")?;
  let ctx2d = ctx.env.unwrap::<Context>(&ctx_js)?;
  let surface_ref = ctx2d.surface.reference();

  if let Some(data_ref) = match format_str {
    "webp" => surface_ref.encode_data(sk::SkEncodedImageFormat::Webp, quality),
    "jpeg" => surface_ref.encode_data(sk::SkEncodedImageFormat::Jpeg, quality),
    "png" => surface_ref.png_data(),
    "avif" => {
      let (data, size) = surface_ref.data().ok_or_else(|| {
        Error::new(
          Status::GenericFailure,
          "Encode to avif error, failed to get surface pixels".to_owned(),
        )
      })?;
      let config: AVIFConfig =
        serde_json::from_str(ctx.get::<JsString>(1)?.into_utf8()?.as_str()?)?;
      let output = ravif::encode_rgba(
        ravif::Img::new(
          unsafe { slice::from_raw_parts(data, size) }.as_rgba(),
          ctx2d.width as usize,
          ctx2d.height as usize,
        ),
        &ravif::Config {
          quality: config.quality,
          alpha_quality: ((config.quality + 100.) / 2.)
            .min(config.quality + config.quality / 4. + 2.),
          speed: config.speed,
          premultiplied_alpha: false,
          threads: 0,
          color_space: ravif::ColorSpace::RGB,
        },
      )
      .map(|(o, _width, _height)| o)
      .map_err(|e| Error::new(Status::GenericFailure, format!("{}", e)))?;
      return ctx
        .env
        .create_buffer_with_data(output)
        .map(|b| b.into_raw());
    }
    _ => {
      return Err(Error::new(
        Status::InvalidArg,
        format!("{} is not valid format", format_str),
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
          |data: SkiaDataRef, _| mem::drop(data),
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
  let mime_js = ctx.get::<JsString>(0)?.into_utf8()?;
  let mime = mime_js.as_str()?;
  let quality = match ctx.get::<JsNumber>(1)?.get_uint32() {
    Ok(number) => number as u8,
    Err(_e) => match mime {
      MIME_WEBP => DEFAULT_WEBP_QUALITY,
      _ => DEFAULT_JPEG_QUALITY, // https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL
    },
  };

  let context_data = get_data_ref(&ctx, mime, quality)?;
  match context_data {
    ContextOutputData::Skia(data_ref) => unsafe {
      ctx
        .env
        .create_buffer_with_borrowed_data(
          data_ref.0.ptr,
          data_ref.0.size,
          data_ref,
          |data: SkiaDataRef, _| mem::drop(data),
        )
        .map(|b| b.into_raw())
    },
    ContextOutputData::Avif(output) => ctx
      .env
      .create_buffer_with_data(output)
      .map(|b| b.into_raw()),
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
  let mime_js = ctx.get::<JsString>(0)?.into_utf8()?;
  let mime = mime_js.as_str()?;
  let quality = match ctx.get::<JsNumber>(1)?.get_uint32() {
    Ok(number) => number as u8,
    Err(_e) => match mime {
      MIME_WEBP => DEFAULT_WEBP_QUALITY,
      _ => DEFAULT_JPEG_QUALITY, // https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL
    },
  };
  let data_ref = get_data_ref(&ctx, mime, quality)?;
  let mut output = format!("data:{};base64,", &mime);
  match data_ref {
    ContextOutputData::Avif(data) => {
      base64::encode_config_buf(data.as_slice(), base64::STANDARD, &mut output);
    }
    ContextOutputData::Skia(data_ref) => {
      base64::encode_config_buf(data_ref.slice(), base64::STANDARD, &mut output);
    }
  }
  ctx.env.create_string_from_std(output)
}

#[js_function(2)]
fn to_data_url_async(ctx: CallContext) -> Result<JsObject> {
  let mime_js = ctx.get::<JsString>(0)?.into_utf8()?;
  let mime = mime_js.as_str()?;
  let quality = match ctx.get::<JsNumber>(1)?.get_uint32() {
    Ok(number) => number as u8,
    Err(_e) => match mime {
      MIME_WEBP => DEFAULT_WEBP_QUALITY,
      _ => DEFAULT_JPEG_QUALITY, // https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL
    },
  };
  let data_ref = get_data_ref(&ctx, mime, quality)?;
  let async_task = AsyncDataUrl {
    surface_data: data_ref,
    mime: mime.to_owned(),
  };
  ctx.env.spawn(async_task).map(|p| p.promise_object())
}

#[js_function]
fn get_content(ctx: CallContext) -> Result<JsBuffer> {
  let this = ctx.this_unchecked::<JsObject>();
  let ctx_js = this.get_named_property::<JsObject>("ctx")?;
  let ctx2d = ctx.env.unwrap::<Context>(&ctx_js)?;

  let svg_data_stream = ctx2d.stream.as_ref().unwrap();
  let svg_data = svg_data_stream.data(ctx2d.width, ctx2d.height);
  unsafe {
    ctx
      .env
      .create_buffer_with_borrowed_data(svg_data.0.ptr, svg_data.0.size, svg_data, |d, _| {
        mem::drop(d)
      })
      .map(|b| b.into_raw())
  }
}

fn get_data_ref(ctx: &CallContext, mime: &str, quality: u8) -> Result<ContextOutputData> {
  let this = ctx.this_unchecked::<JsObject>();
  let ctx_js = this.get_named_property::<JsObject>("ctx")?;
  let ctx2d = ctx.env.unwrap::<Context>(&ctx_js)?;
  let surface_ref = ctx2d.surface.reference();

  if let Some(data_ref) = match mime {
    MIME_WEBP => surface_ref.encode_data(sk::SkEncodedImageFormat::Webp, quality),
    MIME_JPEG => surface_ref.encode_data(sk::SkEncodedImageFormat::Jpeg, quality),
    MIME_PNG => surface_ref.png_data(),
    MIME_AVIF => {
      let (data, size) = surface_ref.data().ok_or_else(|| {
        Error::new(
          Status::GenericFailure,
          "Encode to avif error, failed to get surface pixels".to_owned(),
        )
      })?;
      let config: AVIFConfig =
        serde_json::from_str(ctx.get::<JsString>(1)?.into_utf8()?.as_str()?)?;
      let output = ravif::encode_rgba(
        ravif::Img::new(
          unsafe { slice::from_raw_parts(data, size) }.as_rgba(),
          ctx2d.width as usize,
          ctx2d.height as usize,
        ),
        &ravif::Config {
          quality: config.quality,
          alpha_quality: ((config.quality + 100.) / 2.)
            .min(config.quality + config.quality / 4. + 2.),
          speed: config.speed,
          premultiplied_alpha: false,
          threads: 0,
          color_space: ravif::ColorSpace::RGB,
        },
      )
      .map(|(o, _width, _height)| o)
      .map_err(|e| Error::new(Status::GenericFailure, format!("{}", e)))?;
      return Ok(ContextOutputData::Avif(output));
    }
    _ => {
      return Err(Error::new(
        Status::InvalidArg,
        format!("{} is not valid mime", mime),
      ))
    }
  } {
    Ok(ContextOutputData::Skia(data_ref))
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
  surface_data: ContextOutputData,
  mime: String,
}

impl Task for AsyncDataUrl {
  type Output = String;
  type JsValue = JsString;

  fn compute(&mut self) -> Result<Self::Output> {
    let mut output = format!("data:{};base64,", &self.mime);
    match &self.surface_data {
      ContextOutputData::Skia(data_ref) => {
        base64::encode_config_buf(data_ref.slice(), base64::URL_SAFE, &mut output);
      }
      ContextOutputData::Avif(o) => {
        base64::encode_config_buf(o.as_slice(), base64::URL_SAFE, &mut output);
      }
    }
    Ok(output)
  }

  fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
    env.create_string_from_std(output)
  }
}
