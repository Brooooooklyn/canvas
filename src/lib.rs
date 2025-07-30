#![deny(clippy::all)]
#![allow(clippy::many_single_char_names)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::new_without_default)]

#[macro_use]
extern crate napi_derive;
#[macro_use]
extern crate serde_derive;

use std::{ffi::c_void, mem, slice, str::FromStr};

use napi::{
  Property,
  bindgen_prelude::*,
  noop_finalize,
  tokio::sync::mpsc::{channel, error::TrySendError},
  tokio_stream::wrappers::ReceiverStream,
};

use ctx::{
  CanvasRenderingContext2D, Context, ContextData, ContextOutputData, FILL_STYLE_HIDDEN_NAME,
  STROKE_STYLE_HIDDEN_NAME, SvgExportFlag, encode_surface,
};
use font::{FONT_REGEXP, init_font_regexp};
use sk::{ColorSpace, SkiaDataRef, SurfaceRef};

use avif::AvifConfig;

#[global_allocator]
static ALLOC: mimalloc_safe::MiMalloc = mimalloc_safe::MiMalloc;

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

#[napi_derive::module_init]
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
pub struct CanvasElement<'scope> {
  pub(crate) width: u32,
  pub(crate) height: u32,
  pub(crate) ctx: ClassInstance<'scope, CanvasRenderingContext2D>,
}

#[napi]
impl<'c> CanvasElement<'c> {
  fn create_context(
    env: &Env,
    width: u32,
    height: u32,
  ) -> Result<ClassInstance<'_, CanvasRenderingContext2D>> {
    let ctx = CanvasRenderingContext2D {
      context: Context::new(width, height, ColorSpace::default())?,
    }
    .into_instance(env)?;
    ctx.as_object(env).define_properties(&[
      Property::new()
        .with_utf8_name(FILL_STYLE_HIDDEN_NAME)?
        .with_napi_value(env, "#000")?
        .with_property_attributes(PropertyAttributes::Writable | PropertyAttributes::Configurable),
      Property::new()
        .with_utf8_name(STROKE_STYLE_HIDDEN_NAME)?
        .with_napi_value(env, "#000")?
        .with_property_attributes(PropertyAttributes::Writable | PropertyAttributes::Configurable),
    ])?;
    env.adjust_external_memory((width * height * 4) as i64)?;
    Ok(ctx)
  }

  #[napi(constructor)]
  pub fn new<'env>(env: &'env Env, mut this: This<'c>, width: i32, height: i32) -> Result<Self> {
    // Default fallback of canvas on browser and skia-canvas is 350x150
    let width = (if width <= 0 { 350 } else { width }) as u32;
    let height = (if height <= 0 { 150 } else { height }) as u32;
    let ctx = Self::create_context(env, width, height)?;
    let ctx = ctx.assign_to_this_with_attributes("ctx", PropertyAttributes::Default, &mut this)?;
    let mut ctx_obj = ctx.as_object(env);
    ctx_obj.define_properties(&[Property::new()
      .with_utf8_name("canvas")?
      .with_value(&this)
      .with_property_attributes(
        PropertyAttributes::Default | PropertyAttributes::Writable | PropertyAttributes::Enumerable,
      )])?;
    Ok(Self { width, height, ctx })
  }

  #[napi(setter)]
  pub fn set_width(&mut self, env: Env, width: i32) -> Result<()> {
    let width = (if width <= 0 { 350 } else { width }) as u32;
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
  pub fn set_height(&mut self, env: Env, height: i32) -> Result<()> {
    let height = (if height <= 0 { 150 } else { height }) as u32;
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
    let context_data = get_data_ref(
      &self.ctx.context.surface.reference(),
      mime,
      &match quality_or_config {
        Either3::A(q) => Either::A(q),
        Either3::B(s) => Either::B(s),
        Either3::C(_) => Either::A(DEFAULT_JPEG_QUALITY as u32),
      },
      self.ctx.context.width,
      self.ctx.context.height,
    )?;
    match context_data {
      ContextOutputData::Skia(data_ref) => unsafe {
        BufferSlice::from_external(
          &env,
          data_ref.0.ptr,
          data_ref.0.size,
          data_ref,
          |_, data: SkiaDataRef| mem::drop(data),
        )
      },
      ContextOutputData::Avif(output) => unsafe {
        BufferSlice::from_external(
          &env,
          output.as_ptr().cast_mut(),
          output.len(),
          output,
          |_, data| mem::drop(data),
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
    self
      .to_data_url_inner(mime.as_deref(), quality_or_config)?
      .compute()
  }

  #[napi(js_name = "toBlob")]
  pub fn to_blob(
    &self,
    callback: Function,
    mime: Option<String>,
    quality_or_config: Either3<f64, AvifConfig, Unknown>,
  ) -> Result<Promise<()>> {
    let surface_data = self.ctx.context.surface.reference();
    let mime = mime.unwrap_or_else(|| MIME_PNG.to_owned());
    let quality_or_config = match quality_or_config {
      Either3::A(q) => Either::A((q * 100.0) as u32),
      Either3::B(s) => Either::B(s),
      Either3::C(_) => Either::A(DEFAULT_JPEG_QUALITY as u32),
    };
    let width = self.ctx.context.width;
    let height = self.ctx.context.height;

    // Encode the image data immediately
    let surface_data_result = get_data_ref(&surface_data, &mime, &quality_or_config, width, height);
    
    match surface_data_result {
      Ok(context_data) => {
        let buffer_data = match context_data {
          ContextOutputData::Skia(data_ref) => data_ref.slice().to_vec(),
          ContextOutputData::Avif(data_ref) => data_ref.to_vec(),
        };
        let buffer = Buffer::from(buffer_data);
        
        // Call the callback with the buffer
        callback.call(buffer.into_unknown(&callback.env)?)?;
      }
      Err(_) => {
        // Call callback with undefined on error (browser behavior)
        callback.call(callback.env.get_undefined()?)?;
      }
    }

    Promise::resolve(())
  }

  #[napi]
  pub fn encode_stream(
    &self,
    env: &Env,
    mime: Option<String>,
    quality: Option<u8>,
  ) -> Result<ReadableStream<BufferSlice>> {
    let mime = match mime.as_deref() {
      Some("webp") => sk::SkEncodedImageFormat::Webp,
      Some("jpeg") => sk::SkEncodedImageFormat::Jpeg,
      Some("png") | None => sk::SkEncodedImageFormat::Png,
      _ => return Err(Error::new(Status::InvalidArg, "Invalid mime")),
    };
    let (tx, rx) = channel(1024);
    let callback = |buffer: &[u8]| match tx.try_send(Ok(buffer.to_vec())) {
      Ok(_) | Err(TrySendError::Closed(_)) => {}
      Err(TrySendError::Full(_)) => {
        eprintln!("encode_image_stream_callback: channel is full");
      }
    };
    if !self.encode_image_inner(mime, quality.unwrap_or(DEFAULT_JPEG_QUALITY), callback) {
      return Err(Error::new(
        Status::GenericFailure,
        "Encode image stream failed",
      ));
    }
    ReadableStream::create_with_stream_bytes(env, ReceiverStream::new(rx))
  }

  // let the compiler infer the type of the callback
  fn encode_image_inner<F: Fn(&[u8])>(
    &self,
    mime: sk::SkEncodedImageFormat,
    quality: u8,
    callback: F,
  ) -> bool {
    self.ctx.context.surface.encode_stream(
      mime,
      quality,
      Some(encode_image_stream_callback::<F>),
      Box::into_raw(Box::new(callback)).cast(),
    )
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
    let quality = match &quality_or_config {
      Either3::A(q) => (*q) as u8,
      Either3::B(s) => s.quality.map(|q| q as u8).unwrap_or(DEFAULT_JPEG_QUALITY),
      Either3::C(_) => DEFAULT_JPEG_QUALITY,
    };
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
        ));
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
    Ok(AsyncDataUrl {
      surface_data: self.ctx.context.surface.reference(),
      mime: mime.to_owned(),
      quality_or_config: match quality_or_config {
        Either3::A(q) => Either::A((q * 100.0) as u32),
        Either3::B(s) => Either::B(s),
        Either3::C(_) => Either::A(DEFAULT_JPEG_QUALITY as u32),
      },
      width: self.ctx.context.width,
      height: self.ctx.context.height,
    })
  }
}

#[napi(object)]
pub struct ContextAttr {
  pub alpha: Option<bool>,
}

fn get_data_ref(
  surface_ref: &SurfaceRef,
  mime: &str,
  quality_or_config: &Either<u32, AvifConfig>,
  width: u32,
  height: u32,
) -> Result<ContextOutputData> {
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
        width,
        height,
        &config,
      )
      .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
      return Ok(ContextOutputData::Avif(output));
    }
    _ => {
      return Err(Error::new(
        Status::InvalidArg,
        format!("{mime} is not valid mime"),
      ));
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
  surface_data: SurfaceRef,
  quality_or_config: Either<u32, AvifConfig>,
  mime: String,
  width: u32,
  height: u32,
}

pub struct AsyncBlobData {
  surface_data: SurfaceRef,
  quality_or_config: Either<u32, AvifConfig>,
  mime: String,
  width: u32,
  height: u32,
}

pub struct AsyncBlobTask {
  data: AsyncBlobData,
}

#[napi]
impl Task for AsyncDataUrl {
  type Output = String;
  type JsValue = String;

  fn compute(&mut self) -> Result<Self::Output> {
    let mut output = format!("data:{};base64,", &self.mime);
    let surface_data = get_data_ref(
      &self.surface_data,
      &self.mime,
      &self.quality_or_config,
      self.width,
      self.height,
    )?;
    match surface_data {
      ContextOutputData::Skia(data_ref) => {
        base64_simd::STANDARD.encode_append(data_ref.slice(), &mut output);
      }
      ContextOutputData::Avif(data_ref) => {
        base64_simd::STANDARD.encode_append(data_ref.as_ref(), &mut output);
      }
    }
    Ok(output)
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

#[napi]
impl Task for AsyncBlobTask {
  type Output = Vec<u8>;
  type JsValue = Buffer;

  fn compute(&mut self) -> Result<Self::Output> {
    let surface_data = get_data_ref(
      &self.data.surface_data,
      &self.data.mime,
      &self.data.quality_or_config,
      self.data.width,
      self.data.height,
    )?;
    match surface_data {
      ContextOutputData::Skia(data_ref) => {
        Ok(data_ref.slice().to_vec())
      }
      ContextOutputData::Avif(data_ref) => {
        Ok(data_ref.to_vec())
      }
    }
  }

  fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
    unsafe { Buffer::from(output).into_unknown(&env)?.cast() }
  }
}

trait ToQuality {
  fn to_quality(&self, mime: &str) -> u8;
}

impl ToQuality for &Either<u32, AvifConfig> {
  fn to_quality(&self, mime_or_format: &str) -> u8 {
    if let Either::A(q) = &self {
      *q as u8
    } else {
      match mime_or_format {
        MIME_WEBP | "webp" => DEFAULT_WEBP_QUALITY,
        _ => DEFAULT_JPEG_QUALITY, // https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL
      }
    }
  }
}

impl ToQuality for Either<u32, AvifConfig> {
  fn to_quality(&self, mime: &str) -> u8 {
    ToQuality::to_quality(&self, mime)
  }
}

#[napi(js_name = "SVGCanvas")]
pub struct SVGCanvas<'scope> {
  pub width: u32,
  pub height: u32,
  pub(crate) ctx: ClassInstance<'scope, CanvasRenderingContext2D>,
  pub(crate) flag: SvgExportFlag,
}

#[napi]
impl<'scope> SVGCanvas<'scope> {
  #[napi(constructor)]
  pub fn new(
    env: &Env,
    mut this: This<'scope>,
    width: i32,
    height: i32,
    flag: SvgExportFlag,
  ) -> Result<SVGCanvas<'scope>> {
    // Default fallback of canvas on browser and skia-canvas is 350x150
    let width = (if width <= 0 { 350 } else { width }) as u32;
    let height = (if height <= 0 { 150 } else { height }) as u32;
    let ctx = CanvasRenderingContext2D::into_instance(
      CanvasRenderingContext2D {
        context: Context::new_svg(width, height, flag.into(), ColorSpace::default())?,
      },
      env,
    )?;
    let mut ctx_obj = ctx.as_object(env);
    ctx_obj.define_properties(&[
      Property::new()
        .with_utf8_name(FILL_STYLE_HIDDEN_NAME)?
        .with_value(&env.create_string("#000")?)
        .with_property_attributes(PropertyAttributes::Writable | PropertyAttributes::Configurable),
      Property::new()
        .with_utf8_name(STROKE_STYLE_HIDDEN_NAME)?
        .with_value(&env.create_string("#000")?)
        .with_property_attributes(PropertyAttributes::Writable | PropertyAttributes::Configurable),
      Property::new()
        .with_utf8_name("canvas")?
        .with_value(&this)
        .with_property_attributes(
          PropertyAttributes::Default
            | PropertyAttributes::Writable
            | PropertyAttributes::Enumerable,
        ),
    ])?;
    env.adjust_external_memory((width * height * 4) as i64)?;

    Ok(Self {
      width,
      height,
      flag,
      ctx: ctx.assign_to_this_with_attributes("ctx", PropertyAttributes::Default, &mut this)?,
    })
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
  pub fn get_content(&mut self, env: Env) -> Result<BufferSlice> {
    let svg_data_stream = self
      .ctx
      .context
      .stream
      .take()
      .ok_or_else(|| Error::new(Status::GenericFailure, "SVGCanvas has no stream"))?;
    unsafe {
      sk::ffi::skiac_canvas_destroy(self.ctx.context.surface.0);
    };
    let svg_data = svg_data_stream.data(self.ctx.context.width, self.ctx.context.height);
    let (surface, stream) = sk::Surface::new_svg(
      self.ctx.context.width,
      self.ctx.context.height,
      self.ctx.context.surface.alpha_type(),
      self.flag.into(),
      ColorSpace::default(),
    )
    .ok_or_else(|| Error::new(Status::GenericFailure, "Failed to create surface"))?;
    self.ctx.context.surface = surface;
    self.ctx.context.stream = Some(stream);
    unsafe {
      BufferSlice::from_external(&env, svg_data.0.ptr, svg_data.0.size, svg_data, |_, d| {
        mem::drop(d)
      })
    }
  }

  #[napi(setter)]
  pub fn set_width(&mut self, env: Env, width: i32) -> Result<()> {
    let width = (if width <= 0 { 350 } else { width }) as u32;
    self.width = width;
    let height = self.height;
    let old_ctx = mem::replace(
      &mut self.ctx.context,
      Context::new_svg(width, height, self.flag.into(), ColorSpace::default())?,
    );
    env.adjust_external_memory((width as i64 - old_ctx.width as i64) * (height as i64) * 4)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_width(&self) -> u32 {
    self.width
  }

  #[napi(setter)]
  pub fn set_height(&mut self, env: Env, height: i32) -> Result<()> {
    let height = (if height <= 0 { 150 } else { height }) as u32;
    self.height = height;
    let width = self.width;
    let old_ctx = mem::replace(
      &mut self.ctx.context,
      Context::new_svg(width, height, self.flag.into(), ColorSpace::default())?,
    );
    env.adjust_external_memory((width as i64) * (height as i64 - old_ctx.height as i64) * 4)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_height(&self) -> u32 {
    self.height
  }
}

#[napi]
pub fn clear_all_cache() {
  unsafe { sk::ffi::skiac_clear_all_cache() };
}

unsafe extern "C" fn encode_image_stream_callback<F: Fn(&[u8])>(
  data: *mut c_void,
  size: usize,
  context: *mut c_void,
) {
  let rust_callback: &mut F = unsafe { Box::leak(Box::from_raw(context.cast())) };
  rust_callback(unsafe { slice::from_raw_parts(data.cast(), size) });
}
