#![feature(link_cfg)]
#![feature(let_chains)]
#![deny(clippy::all)]
#![allow(clippy::many_single_char_names)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::new_without_default)]

#[macro_use]
extern crate napi_derive;
#[macro_use]
extern crate serde_derive;

use std::str::FromStr;
use std::{mem, slice};

use base64::Engine;
use bindgen_prelude::BufferSlice;
use napi::bindgen_prelude::{AsyncTask, ClassInstance, Either3, This, Unknown};
use napi::*;

use ctx::{
  encode_surface, CanvasRenderingContext2D, Context, ContextData, ContextOutputData, SvgExportFlag,
  FILL_STYLE_HIDDEN_NAME, STROKE_STYLE_HIDDEN_NAME,
};
use font::{init_font_regexp, FONT_REGEXP};
use sk::{ColorSpace, SkiaDataRef};

use avif::AvifConfig;

#[cfg(not(target_arch = "arm"))]
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod avif;
mod ctx;
mod error;
mod filter;
mod font;
pub mod global_fonts;
mod gradient;
mod image;
pub mod path;
mod pattern;
pub mod picture_recorder;
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

#[napi::module_init]
fn init() {
  // pre init font regexp
  FONT_REGEXP.get_or_init(init_font_regexp);
}

#[napi(object)]
pub struct CanvasRenderingContext2DAttributes {
  pub alpha: Option<bool>,
  pub color_space: Option<String>,
}

#[napi]
pub struct CanvasElement {
  pub(crate) width: u32,
  pub(crate) height: u32,
  pub(crate) ctx: ClassInstance<CanvasRenderingContext2D>,
}

#[napi]
impl CanvasElement {
  fn create_context(
    mut env: Env,
    width: u32,
    height: u32,
  ) -> Result<ClassInstance<CanvasRenderingContext2D>> {
    let ctx = CanvasRenderingContext2D {
      context: Context::new(width, height, ColorSpace::default())?,
    }
    .into_instance(env)?;
    ctx.as_object(env).define_properties(&[
      Property::new(FILL_STYLE_HIDDEN_NAME)?
        .with_value(&env.create_string("#000")?)
        .with_property_attributes(PropertyAttributes::Writable | PropertyAttributes::Configurable),
      Property::new(STROKE_STYLE_HIDDEN_NAME)?
        .with_value(&env.create_string("#000")?)
        .with_property_attributes(PropertyAttributes::Writable | PropertyAttributes::Configurable),
    ])?;
    env.adjust_external_memory((width * height * 4) as i64)?;
    Ok(ctx)
  }

  #[napi(constructor)]
  pub fn new(env: Env, mut this: This, width: u32, height: u32) -> Result<Self> {
    let ctx = Self::create_context(env, width, height)?;
    this.define_properties(&[Property::new("ctx")?
      .with_value(&ctx)
      .with_property_attributes(PropertyAttributes::Default)])?;
    ctx
      .as_object(env)
      .define_properties(&[Property::new("canvas")?
        .with_value(&this)
        .with_property_attributes(
          PropertyAttributes::Default
            | PropertyAttributes::Writable
            | PropertyAttributes::Enumerable,
        )])?;
    Ok(Self { width, height, ctx })
  }

  #[napi(setter)]
  pub fn set_width(&mut self, mut env: Env, width: u32) -> Result<()> {
    self.width = width;
    let height = self.height;
    let old_ctx = mem::replace(
      &mut self.ctx.context,
      Context::new(width, height, ColorSpace::default())?,
    );
    env.adjust_external_memory((width as i64 - old_ctx.width as i64) * 4)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_width(&self) -> u32 {
    self.width
  }

  #[napi(setter)]
  pub fn set_height(&mut self, mut env: Env, height: u32) -> Result<()> {
    self.height = height;
    let width = self.width;
    let old_ctx = mem::replace(
      &mut self.ctx.context,
      Context::new(width, height, ColorSpace::default())?,
    );
    env.adjust_external_memory((height as i64 - old_ctx.height as i64) * 4)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_height(&self) -> u32 {
    self.height
  }

  #[napi]
  pub fn get_context(
    &mut self,
    this: This,
    context_type: String,
    attrs: Option<CanvasRenderingContext2DAttributes>,
  ) -> Result<Unknown> {
    if context_type != "2d" {
      return Err(Error::new(
        Status::InvalidArg,
        format!("{context_type} is not supported"),
      ));
    }
    let context_2d = &mut self.ctx.context;
    if !attrs.as_ref().and_then(|a| a.alpha).unwrap_or(true) {
      let mut fill_paint = context_2d.fill_paint()?;
      fill_paint.set_color(255, 255, 255, 255);
      context_2d.alpha = false;
      context_2d.surface.draw_rect(
        0f32,
        0f32,
        self.width as f32,
        self.height as f32,
        &fill_paint,
      );
    }
    let color_space = attrs
      .and_then(|a| a.color_space)
      .and_then(|cs| ColorSpace::from_str(&cs).ok())
      .unwrap_or_default();
    context_2d.color_space = color_space;
    this.get_named_property("ctx")
  }

  #[napi]
  pub fn encode(
    &self,
    format: String,
    quality_or_config: Either3<u32, AvifConfig, Unknown>,
  ) -> Result<AsyncTask<ContextData>> {
    Ok(AsyncTask::new(
      self.encode_inner(format, quality_or_config)?,
    ))
  }

  #[napi]
  pub fn encode_sync(
    &self,
    env: Env,
    format: String,
    quality_or_config: Either3<u32, AvifConfig, Unknown>,
  ) -> Result<BufferSlice> {
    let data = self.encode_inner(format, quality_or_config)?;
    let output = encode_surface(&data)?;
    output.into_buffer_slice(env)
  }

  #[napi]
  pub fn to_buffer(
    &self,
    env: Env,
    mime: String,
    quality_or_config: Either3<u32, AvifConfig, Unknown>,
  ) -> Result<BufferSlice> {
    let mime = mime.as_str();
    let context_data = get_data_ref(&self.ctx.context, mime, &quality_or_config)?;
    match context_data {
      ContextOutputData::Skia(data_ref) => unsafe {
        BufferSlice::from_external(
          &env,
          data_ref.0.ptr,
          data_ref.0.size,
          data_ref,
          |data: SkiaDataRef, _| mem::drop(data),
        )
      },
      ContextOutputData::Avif(output) => unsafe {
        BufferSlice::from_external(
          &env,
          output.as_ptr().cast_mut(),
          output.len(),
          output,
          |data, _| mem::drop(data),
        )
      },
    }
  }

  #[napi]
  pub fn data(&self, env: Env) -> Result<BufferSlice> {
    let ctx2d = &self.ctx.context;

    let surface_ref = ctx2d.surface.reference();

    let (ptr, size) = surface_ref.data().ok_or_else(|| {
      Error::new(
        Status::GenericFailure,
        "Get png data from surface failed".to_string(),
      )
    })?;
    unsafe { BufferSlice::from_external(&env, ptr.cast_mut(), size, 0, noop_finalize) }
  }

  #[napi(js_name = "toDataURLAsync")]
  pub fn to_data_url_async(
    &self,
    mime: Option<String>,
    quality_or_config: Either3<f64, AvifConfig, Unknown>,
  ) -> Result<AsyncTask<AsyncDataUrl>> {
    Ok(AsyncTask::new(
      self.to_data_url_inner(mime.as_deref(), quality_or_config)?,
    ))
  }

  #[napi(js_name = "toDataURL")]
  pub fn to_data_url(
    &self,
    mime: Option<String>,
    quality_or_config: Either3<f64, AvifConfig, Unknown>,
  ) -> Result<String> {
    let mut task = self.to_data_url_inner(mime.as_deref(), quality_or_config)?;
    task.compute()
  }

  #[napi]
  pub fn save_png(&self, path: String) {
    let ctx2d = &self.ctx.context;
    ctx2d.surface.save_png(&path);
  }

  fn encode_inner(
    &self,
    format: String,
    quality_or_config: Either3<u32, AvifConfig, Unknown>,
  ) -> Result<ContextData> {
    let format_str = format.as_str();
    let quality = quality_or_config.to_quality(format_str);
    let ctx2d = &self.ctx.context;
    let surface_ref = ctx2d.surface.reference();

    let task = match format_str {
      "webp" => ContextData::Webp(surface_ref, quality),
      "jpeg" => ContextData::Jpeg(surface_ref, quality),
      "png" => ContextData::Png(surface_ref),
      "avif" => {
        let cfg = AvifConfig::from(&quality_or_config);
        ContextData::Avif(surface_ref, cfg.into(), ctx2d.width, ctx2d.height)
      }
      _ => {
        return Err(Error::new(
          Status::InvalidArg,
          format!("{format_str} is not valid format"),
        ))
      }
    };

    Ok(task)
  }

  fn to_data_url_inner(
    &self,
    mime: Option<&str>,
    quality_or_config: Either3<f64, AvifConfig, Unknown>,
  ) -> Result<AsyncDataUrl> {
    let mime = mime.unwrap_or(MIME_PNG);
    let data_ref = get_data_ref(
      &self.ctx.context,
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

fn get_data_ref(
  ctx2d: &Context,
  mime: &str,
  quality_or_config: &Either3<u32, AvifConfig, Unknown>,
) -> Result<ContextOutputData> {
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
      let config = AvifConfig::from(quality_or_config).into();
      let output = avif::encode(
        unsafe { slice::from_raw_parts(data, size) },
        ctx2d.width,
        ctx2d.height,
        &config,
      )
      .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
      return Ok(ContextOutputData::Avif(output));
    }
    _ => {
      return Err(Error::new(
        Status::InvalidArg,
        format!("{mime} is not valid mime"),
      ))
    }
  } {
    Ok(ContextOutputData::Skia(data_ref))
  } else {
    Err(Error::new(
      Status::InvalidArg,
      format!("encode {mime} output failed"),
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
        base64::engine::general_purpose::STANDARD.encode_string(data_ref.slice(), &mut output);
      }
      ContextOutputData::Avif(data_ref) => {
        base64::engine::general_purpose::STANDARD.encode_string(data_ref.as_ref(), &mut output);
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

impl ToQuality for &Either3<u32, AvifConfig, Unknown> {
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

impl ToQuality for Either3<u32, AvifConfig, Unknown> {
  fn to_quality(&self, mime: &str) -> u8 {
    ToQuality::to_quality(&self, mime)
  }
}

#[napi(js_name = "SVGCanvas")]
pub struct SVGCanvas {
  pub width: u32,
  pub height: u32,
  pub(crate) ctx: ClassInstance<CanvasRenderingContext2D>,
}

#[napi]
impl SVGCanvas {
  #[napi(constructor)]
  pub fn new(
    mut env: Env,
    mut this: This,
    width: u32,
    height: u32,
    flag: SvgExportFlag,
  ) -> Result<Self> {
    let ctx = CanvasRenderingContext2D::into_instance(
      CanvasRenderingContext2D {
        context: Context::new_svg(width, height, flag.into(), ColorSpace::default())?,
      },
      env,
    )?;
    ctx.as_object(env).define_properties(&[
      Property::new(FILL_STYLE_HIDDEN_NAME)?
        .with_value(&env.create_string("#000")?)
        .with_property_attributes(PropertyAttributes::Writable | PropertyAttributes::Configurable),
      Property::new(STROKE_STYLE_HIDDEN_NAME)?
        .with_value(&env.create_string("#000")?)
        .with_property_attributes(PropertyAttributes::Writable | PropertyAttributes::Configurable),
      Property::new("canvas")?
        .with_value(&this)
        .with_property_attributes(
          PropertyAttributes::Default
            | PropertyAttributes::Writable
            | PropertyAttributes::Enumerable,
        ),
    ])?;
    env.adjust_external_memory((width * height * 4) as i64)?;
    this.define_properties(&[Property::new("ctx")?
      .with_value(&ctx)
      .with_property_attributes(PropertyAttributes::Default)])?;
    Ok(Self { width, height, ctx })
  }

  #[napi]
  pub fn get_context(
    &mut self,
    this: This,
    context_type: String,
    attrs: Option<CanvasRenderingContext2DAttributes>,
  ) -> Result<Unknown> {
    if context_type != "2d" {
      return Err(Error::new(
        Status::InvalidArg,
        format!("{context_type} is not supported"),
      ));
    }
    let context_2d = &mut self.ctx.context;
    if !attrs.as_ref().and_then(|a| a.alpha).unwrap_or(true) {
      let mut fill_paint = context_2d.fill_paint()?;
      fill_paint.set_color(255, 255, 255, 255);
      context_2d.alpha = false;
      context_2d.surface.draw_rect(
        0f32,
        0f32,
        self.width as f32,
        self.height as f32,
        &fill_paint,
      );
    }
    let color_space = attrs
      .and_then(|a| a.color_space)
      .and_then(|cs| ColorSpace::from_str(&cs).ok())
      .unwrap_or_default();
    context_2d.color_space = color_space;
    this.get_named_property("ctx")
  }

  #[napi]
  pub fn get_content(&self, env: Env) -> Result<BufferSlice> {
    let svg_data_stream = self.ctx.context.stream.as_ref().unwrap();
    let svg_data = svg_data_stream.data(self.ctx.context.width, self.ctx.context.height);
    unsafe {
      BufferSlice::from_external(&env, svg_data.0.ptr, svg_data.0.size, svg_data, |d, _| {
        mem::drop(d)
      })
    }
  }
}

#[napi]
pub fn clear_all_cache() {
  unsafe { sk::ffi::skiac_clear_all_cache() };
}
