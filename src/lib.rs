#![feature(link_cfg)]
#![deny(clippy::all)]
#![allow(clippy::many_single_char_names)]
#![allow(clippy::too_many_arguments)]

#[macro_use]
extern crate napi_derive;
#[macro_use]
extern crate serde_derive;

use std::{mem, slice};

use napi::bindgen_prelude::{AsyncTask, Either3, Object, This, Unknown};
use napi::*;

use ctx::{AVIFConfig, Context, ContextData, ContextOutputData};
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
pub mod global_fonts;
mod gradient;
mod image;
mod image_pattern;
mod path;
mod pattern;

#[allow(dead_code)]
mod sk;
mod state;
pub mod svg;

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
  let canvas_rendering_context2d = ctx::Context::create_js_class(&env)?;

  let image_data_class = image::ImageData::create_js_class(&env)?;

  let image_class = image::Image::create_js_class(&env)?;

  let canvas_pattern = env.define_class(
    "CanvasPattern",
    image_pattern::canvas_pattern_constructor,
    &[Property::new("setTransform")?.with_method(image_pattern::set_transform)],
  )?;

  exports.set_named_property("CanvasRenderingContext2D", canvas_rendering_context2d)?;

  exports.set_named_property("ImageData", image_data_class)?;

  exports.set_named_property("Image", image_class)?;

  exports.set_named_property("CanvasPattern", canvas_pattern)?;

  // pre init font regexp
  FONT_REGEXP.get_or_init(init_font_regexp);
  Ok(())
}

#[napi]
pub struct CanvasElement {
  pub width: u32,
  pub height: u32,
}

#[napi]
impl CanvasElement {
  #[napi(constructor)]
  pub fn new(width: u32, height: u32) -> Self {
    Self { width, height }
  }

  #[napi]
  pub fn encode(
    &self,
    env: Env,
    this: This,
    format: String,
    quality_or_config: Either3<u32, String, Unknown>,
  ) -> Result<AsyncTask<ContextData>> {
    Ok(AsyncTask::new(self.encode_inner(
      env,
      this,
      format,
      quality_or_config,
    )?))
  }

  #[napi]
  pub fn encode_sync(
    &self,
    env: Env,
    this: This,
    format: String,
    quality_or_config: Either3<u32, String, Unknown>,
  ) -> Result<JsBuffer> {
    let mut task = self.encode_inner(env, this, format, quality_or_config)?;
    let output = task.compute()?;
    task.resolve(env, output)
  }

  #[napi]
  pub fn to_buffer(
    &self,
    env: Env,
    this: This,
    mime: String,
    quality_or_config: Either3<u32, String, Unknown>,
  ) -> Result<JsBuffer> {
    let mime = mime.as_str();
    let context_data = get_data_ref(&env, &this, mime, &quality_or_config)?;
    match context_data {
      ContextOutputData::Skia(data_ref) => unsafe {
        env
          .create_buffer_with_borrowed_data(
            data_ref.0.ptr,
            data_ref.0.size,
            data_ref,
            |data: SkiaDataRef, _| mem::drop(data),
          )
          .map(|b| b.into_raw())
      },
      ContextOutputData::Avif(output) => env.create_buffer_with_data(output).map(|b| b.into_raw()),
    }
  }

  #[napi]
  pub fn data(&self, env: Env, this: This) -> Result<JsBuffer> {
    let ctx_js = this.get_named_property::<JsObject>("ctx")?;
    let ctx2d = env.unwrap::<Context>(&ctx_js)?;

    let surface_ref = ctx2d.surface.reference();

    let (ptr, size) = surface_ref.data().ok_or_else(|| {
      Error::new(
        Status::GenericFailure,
        "Get png data from surface failed".to_string(),
      )
    })?;
    unsafe {
      env
        .create_buffer_with_borrowed_data(ptr, size, 0, noop_finalize)
        .map(|value| value.into_raw())
    }
  }

  #[napi(js_name = "toDataURLAsync")]
  pub fn to_data_url_async(
    &self,
    env: Env,
    this: This,
    mime: String,
    quality_or_config: Either3<f64, String, Unknown>,
  ) -> Result<AsyncTask<AsyncDataUrl>> {
    Ok(AsyncTask::new(self.to_data_url_inner(
      &env,
      &this,
      mime.as_str(),
      quality_or_config,
    )?))
  }

  #[napi(js_name = "toDataURL")]
  pub fn to_data_url(
    &self,
    env: Env,
    this: This,
    mime: String,
    quality_or_config: Either3<f64, String, Unknown>,
  ) -> Result<String> {
    let mut task = self.to_data_url_inner(&env, &this, mime.as_str(), quality_or_config)?;
    task.compute()
  }

  #[napi]
  pub fn save_png(&self, env: Env, this: This, path: String) -> Result<()> {
    let ctx_js = this.get_named_property::<JsObject>("ctx")?;
    let ctx2d = env.unwrap::<Context>(&ctx_js)?;

    ctx2d.surface.save_png(&path);
    Ok(())
  }

  fn encode_inner(
    &self,
    env: Env,
    this: This,
    format: String,
    quality_or_config: Either3<u32, String, Unknown>,
  ) -> Result<ContextData> {
    let format_str = format.as_str();
    let quality = quality_or_config.to_quality(format_str);
    let ctx_js = this.get_named_property::<JsObject>("ctx")?;
    let ctx2d = env.unwrap::<Context>(&ctx_js)?;
    let surface_ref = ctx2d.surface.reference();

    let task = match format_str {
      "webp" => ContextData::Webp(surface_ref, quality),
      "jpeg" => ContextData::Jpeg(surface_ref, quality),
      "png" => ContextData::Png(surface_ref),
      "avif" => {
        let cfg: AVIFConfig = AVIFConfig::from(quality_or_config);
        ContextData::Avif(surface_ref, cfg, ctx2d.width, ctx2d.height)
      }
      _ => {
        return Err(Error::new(
          Status::InvalidArg,
          format!("{} is not valid format", format_str),
        ))
      }
    };

    Ok(task)
  }

  fn to_data_url_inner(
    &self,
    env: &Env,
    this: &This,
    mime: &str,
    quality_or_config: Either3<f64, String, Unknown>,
  ) -> Result<AsyncDataUrl> {
    let data_ref = get_data_ref(
      env,
      this,
      mime,
      &match quality_or_config {
        Either3::A(q) => Either3::A((q * 100.0) as u32),
        Either3::B(s) => Either3::B(s),
        Either3::C(u) => Either3::C(u),
      },
    )?;
    Ok(AsyncDataUrl {
      surface_data: data_ref,
      mime: mime.to_owned(),
    })
  }
}

#[napi(object)]
pub struct ContextAttr {
  pub alpha: Option<bool>,
}

#[napi]
pub fn create_context(
  env: Env,
  context_object: JsObject,
  width: f64,
  height: f64,
  attrs: ContextAttr,
) -> Result<()> {
  let context_2d: &mut Context = env.unwrap(&context_object)?;
  if !attrs.alpha.unwrap_or(true) {
    let mut fill_paint = context_2d.fill_paint()?;
    fill_paint.set_color(255, 255, 255, 255);
    context_2d.alpha = false;
    context_2d
      .surface
      .draw_rect(0f32, 0f32, width as f32, height as f32, &fill_paint);
  }
  Ok(())
}

fn get_data_ref(
  env: &Env,
  this: &Object,
  mime: &str,
  quality_or_config: &Either3<u32, String, Unknown>,
) -> Result<ContextOutputData> {
  let ctx_js = this.get_named_property::<JsObject>("ctx")?;
  let ctx2d = env.unwrap::<Context>(&ctx_js)?;
  let surface_ref = ctx2d.surface.reference();
  let quality = quality_or_config.to_quality(mime);

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
      let config = AVIFConfig::from(quality_or_config);
      let output = ravif::encode_rgba(
        ravif::Img::new(
          unsafe { slice::from_raw_parts(data, size) }.as_rgba(),
          ctx2d.width as usize,
          ctx2d.height as usize,
        ),
        &ravif::Config::from(config),
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

pub struct AsyncDataUrl {
  surface_data: ContextOutputData,
  mime: String,
}

#[napi]
impl Task for AsyncDataUrl {
  type Output = String;
  type JsValue = String;

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

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

trait ToQuality {
  fn to_quality(&self, mime: &str) -> u8;
}

impl ToQuality for &Either3<u32, String, Unknown> {
  fn to_quality(&self, mime_or_format: &str) -> u8 {
    if let Either3::A(q) = &self {
      *q as u8
    } else {
      match mime_or_format {
        MIME_WEBP | "webp" => DEFAULT_WEBP_QUALITY,
        _ => DEFAULT_JPEG_QUALITY, // https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL
      }
    }
  }
}

impl ToQuality for Either3<u32, String, Unknown> {
  fn to_quality(&self, mime: &str) -> u8 {
    ToQuality::to_quality(&self, mime)
  }
}

#[napi(js_name = "SVGCanvas")]
pub struct SVGCanvas {
  pub width: u32,
  pub height: u32,
}

#[napi]
impl SVGCanvas {
  #[napi(constructor)]
  pub fn new(width: u32, height: u32) -> Self {
    Self { width, height }
  }

  #[napi]
  pub fn get_content(&self, this: This, env: Env) -> Result<JsBuffer> {
    let ctx_js = this.get_named_property::<JsObject>("ctx")?;
    let ctx2d = env.unwrap::<Context>(&ctx_js)?;

    let svg_data_stream = ctx2d.stream.as_ref().unwrap();
    let svg_data = svg_data_stream.data(ctx2d.width, ctx2d.height);
    unsafe {
      env
        .create_buffer_with_borrowed_data(svg_data.0.ptr, svg_data.0.size, svg_data, |d, _| {
          mem::drop(d)
        })
        .map(|b| b.into_raw())
    }
  }
}
