#![deny(clippy::all)]
#![allow(clippy::many_single_char_names)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::new_without_default)]

#[macro_use]
extern crate napi_derive;
#[macro_use]
extern crate serde_derive;

use std::{
  ffi::{CString, c_void},
  mem, slice,
};

use napi::{
  Property, ScopedTask,
  bindgen_prelude::*,
  tokio::sync::mpsc::{channel, error::TrySendError},
  tokio_stream::wrappers::ReceiverStream,
};

use ctx::{
  CANVAS_HIDDEN_NAME, CanvasRenderingContext2D, Context, SvgExportFlag, is_valid_image_size,
  truncate_style_objects,
};
use encoding::{
  BlobQuality, ContextData, ContextOutputData, EncodeQuality, EncodeType, Encoding,
  ImageEncodeOptions, ImageType, ToBlobSite, ToDataUrlAsyncSite, ToDataUrlSite, encode_image,
  encode_surface, node_encode_error,
};
use sk::{ColorSpace, SkImage, SkiaDataRef};

use avif::AvifConfig;

#[global_allocator]
static ALLOC: mimalloc_safe::MiMalloc = mimalloc_safe::MiMalloc;

mod avif;
mod avif_yuv;
mod color;
mod css_math;
mod ctx;
mod data_url;
mod encoding;
mod error;
mod filter;
mod font;
mod gif;
pub mod global_fonts;
mod gradient;
mod image;
pub mod lottie;
mod num;
mod page_recorder;
pub mod path;
mod pattern;
pub mod picture_recorder;
#[allow(dead_code)]
mod sk;
mod state;
pub mod svg;
mod svg_image;
mod svg_path;
mod svg_size;
mod unpremul;
mod webidl;

#[napi]
pub struct CanvasElement<'scope> {
  pub(crate) width: u32,
  pub(crate) height: u32,
  pub(crate) ctx: ClassInstance<'scope, CanvasRenderingContext2D>,
  context_initialized: bool,
}

/// The width a canvas takes for a `width` attribute value (already ToUint32):
/// HTML's reflection of a non-negative `unsigned long` gives the default 300
/// for a value above 2147483647. 0 stays 0: a canvas without pixels.
fn canvas_width(width: u32) -> u32 {
  if width > i32::MAX as u32 { 300 } else { width }
}

/// As `canvas_width`, for `height`: the default is 150.
fn canvas_height(height: u32) -> u32 {
  if height > i32::MAX as u32 {
    150
  } else {
    height
  }
}

/// A width or height given to a canvas constructor (no Chrome counterpart):
/// missing (undefined) is the default, as for a `<canvas>` without the
/// attribute; any other value is converted as the setter converts it, with
/// the setter's error prefix.
fn constructor_size<S: webidl::Site>(
  env: &Env,
  value: Unknown,
  size: fn(u32) -> u32,
) -> Result<u32> {
  if value.get_type()? == ValueType::Undefined {
    // `size` gives the default for any value above 2147483647.
    return Ok(size(u32::MAX));
  }
  webidl::to_unsigned_long(env.raw(), value.raw(), S::PREFIX).map(size)
}

/// What the Node-only encoders throw, or reject with, as an IndexSizeError, on
/// a canvas without pixels (no Chrome counterpart).
const NO_PIXELS: &str = "The canvas has no pixels.";

/// convertToBlob() on a canvas without pixels: Chrome's OffscreenCanvas
/// IndexSizeError (offscreen_canvas.cc:551-555, with the binding's prefix).
const CONVERT_TO_BLOB_NO_PIXELS: &str = "Failed to execute 'convertToBlob' on 'OffscreenCanvas': The size of the OffscreenCanvas is zero.";

fn no_pixels_error(env: &Env) -> Error {
  webidl::dom_exception(env.raw(), "IndexSizeError", NO_PIXELS)
}

/// A promise rejected with an IndexSizeError: what the async encoders give
/// on a canvas without pixels. `dom_exception` throws the error; it is taken
/// back from the pending exception.
fn rejected_with_index_size_error<'env>(env: &'env Env, message: &str) -> Result<Unknown<'env>> {
  let _ = webidl::dom_exception(env.raw(), "IndexSizeError", message);
  let raw = env.raw();
  let mut exception = std::ptr::null_mut();
  check_status!(unsafe { sys::napi_get_and_clear_last_exception(raw, &mut exception) })?;
  let mut deferred = std::ptr::null_mut();
  let mut promise = std::ptr::null_mut();
  check_status!(unsafe { sys::napi_create_promise(raw, &mut deferred, &mut promise) })?;
  check_status!(unsafe { sys::napi_reject_deferred(raw, deferred, exception) })?;
  Ok(unsafe { Unknown::from_raw_unchecked(raw, promise) })
}

/// Puts `new` in place of a canvas's Context, and reports the change in
/// pixel bytes to V8: every add and subtract uses `surface_bytes`, so they
/// match also for a canvas without pixels.
fn replace_context(env: &Env, context: &mut Context, new: Context) -> Result<()> {
  let delta = new.surface_bytes() - context.surface_bytes();
  *context = new;
  env.adjust_external_memory(delta)?;
  Ok(())
}

// Setting width or height resets the context to its default state (spec "set
// bitmap dimensions"; Chrome: HTMLCanvasElement::Reset), so the saved style
// objects go. The context object is read from the canvas's `ctx` property:
// the napi_value inside `self.ctx` belongs to the constructor's handle scope
// and must not be used in a later call.
fn reset_ctx_style_getters(canvas: &This) -> Result<()> {
  truncate_style_objects(&canvas.get_named_property::<Object>("ctx")?, 0)
}

#[napi]
impl<'c> CanvasElement<'c> {
  // Setting width or height resets the bitmap but keeps the context's
  // settings (alpha, color space).
  fn resized_context(old: &Context, width: u32, height: u32) -> Result<Context> {
    let mut context = Context::new_with_alpha(width, height, old.color_space, old.alpha)?;
    // A lost context stays lost while the size is not valid (Chrome:
    // InitializeResourceProvider fails again). A valid size restores it here
    // at once; Chrome restores it two tasks later, with contextrestored.
    context.context_lost = old.context_lost && !is_valid_image_size(width, height);
    Ok(context)
  }

  fn create_context(
    env: &Env,
    width: u32,
    height: u32,
  ) -> Result<ClassInstance<'_, CanvasRenderingContext2D>> {
    let context = Context::new(width, height, ColorSpace::default())?;
    let bytes = context.surface_bytes();
    let ctx = CanvasRenderingContext2D {
      context,
      reported_settings: Default::default(),
    }
    .into_instance(env)?;
    env.adjust_external_memory(bytes)?;
    Ok(ctx)
  }

  #[napi(constructor)]
  pub fn new<'env>(
    env: &'env Env,
    mut this: This<'c>,
    width: Unknown,
    height: Unknown,
  ) -> Result<Self> {
    let width = constructor_size::<webidl::CanvasSetWidth>(env, width, canvas_width)?;
    let height = constructor_size::<webidl::CanvasSetHeight>(env, height, canvas_height)?;
    let ctx = Self::create_context(env, width, height)?;
    let ctx = ctx.assign_to_this_with_attributes("ctx", PropertyAttributes::Default, &mut this)?;
    let mut ctx_obj = ctx.as_object(env);
    // For the read-only `canvas` getter: not writable, enumerable or
    // configurable.
    ctx_obj.define_properties(&[Property::new()
      .with_utf8_name(CANVAS_HIDDEN_NAME)?
      .with_value(&this)
      .with_property_attributes(PropertyAttributes::Default)])?;
    Ok(Self {
      width,
      height,
      ctx,
      context_initialized: false,
    })
  }

  #[napi(setter)]
  pub fn set_width(
    &mut self,
    env: Env,
    this: This,
    width: webidl::UnsignedLong<webidl::CanvasSetWidth>,
  ) -> Result<()> {
    let width = canvas_width(width.0);
    let new_ctx = Self::resized_context(&self.ctx.context, width, self.height)?;
    replace_context(&env, &mut self.ctx.context, new_ctx)?;
    self.width = width;
    reset_ctx_style_getters(&this)
  }

  #[napi(getter)]
  pub fn get_width(&self) -> u32 {
    self.width
  }

  #[napi(setter)]
  pub fn set_height(
    &mut self,
    env: Env,
    this: This,
    height: webidl::UnsignedLong<webidl::CanvasSetHeight>,
  ) -> Result<()> {
    let height = canvas_height(height.0);
    let new_ctx = Self::resized_context(&self.ctx.context, self.width, height)?;
    replace_context(&env, &mut self.ctx.context, new_ctx)?;
    self.height = height;
    reset_ctx_style_getters(&this)
  }

  #[napi(getter)]
  pub fn get_height(&self) -> u32 {
    self.height
  }

  /// getContext(contextId, options): the 2d context, or null for any other
  /// id, as Chrome does for an id it does not know
  /// (html_canvas_element.cc). The index.js wrapper checks the argument
  /// count.
  #[napi]
  pub fn get_context<'env>(
    &mut self,
    env: &Env,
    this: This,
    context_type: webidl::DomString<webidl::CanvasGetContext>,
    // Converted (and may throw) on every call, also once the context exists
    // and for an unsupported id (HTMLCanvasElementModule::getContext).
    attrs: webidl::CanvasContextOptions,
  ) -> Result<Option<Unknown<'env>>> {
    let attrs = attrs.0;
    if context_type.0 != "2d" {
      return Ok(None);
    }
    if self.context_initialized {
      return this.get_named_property("ctx").map(Some);
    }
    self.ctx.reported_settings = attrs.reported;
    let context_2d = &mut self.ctx.context;
    // The first acquisition fixes the backing surface's color space and
    // alpha. alpha:false always gets a fresh kOpaque surface, so nothing set
    // through the internal `canvas.ctx` before this call reaches the base.
    if attrs.color_space != context_2d.color_space || !attrs.alpha {
      let new_ctx =
        Context::new_with_alpha(self.width, self.height, attrs.color_space, attrs.alpha)?;
      replace_context(env, context_2d, new_ctx)?;
      reset_ctx_style_getters(&this)?;
    }
    self.context_initialized = true;
    this.get_named_property("ctx").map(Some)
  }

  #[napi]
  pub fn encode<'env>(
    &mut self,
    env: &'env Env,
    format: String,
    quality_or_config: Either3<u32, AvifConfig, Unknown>,
  ) -> Result<Either<AsyncTask<ContextData>, Unknown<'env>>> {
    if !self.ctx.context.has_pixels() {
      return rejected_with_index_size_error(env, NO_PIXELS).map(Either::B);
    }
    // Flush deferred rendering before encoding
    self.ctx.context.flush();
    Ok(Either::A(AsyncTask::new(
      self.encode_inner(format, quality_or_config)?,
    )))
  }

  #[napi]
  pub fn encode_sync<'env>(
    &'env mut self,
    env: Env,
    format: String,
    quality_or_config: Either3<u32, AvifConfig, Unknown>,
  ) -> Result<BufferSlice<'env>> {
    if !self.ctx.context.has_pixels() {
      return Err(no_pixels_error(&env));
    }
    // Flush deferred rendering before encoding
    self.ctx.context.flush();
    let data = self.encode_inner(format, quality_or_config)?;
    let output = encode_surface(&data)?;
    output.into_buffer_slice(env)
  }

  #[napi]
  pub fn to_buffer<'env>(
    &'env mut self,
    env: Env,
    mime: String,
    quality_or_config: Either3<u32, AvifConfig, Unknown>,
  ) -> Result<BufferSlice<'env>> {
    if !self.ctx.context.has_pixels() {
      return Err(no_pixels_error(&env));
    }
    // Flush deferred rendering before encoding
    self.ctx.context.flush();
    let ty = ImageType::from_mime(&mime)
      .ok_or_else(|| Error::new(Status::InvalidArg, format!("{mime} is not valid mime")))?;
    let image = self.snapshot()?.ok_or_else(|| no_pixels_error(&env))?;
    let encoding = node_encoding(ty, quality_or_config, true);
    encode_image(
      &image,
      &encoding,
      self.ctx.context.width,
      self.ctx.context.height,
      false,
    )
    .map_err(|detail| node_encode_error(ty, detail, true))?
    .into_buffer_slice(env)
  }

  #[napi]
  pub fn data(&mut self, env: &Env) -> Result<Buffer> {
    // A 0 side has no pixels to give: an empty buffer. Any other canvas
    // without pixels has some it cannot give.
    if self.width == 0 || self.height == 0 {
      return Ok(Vec::new().into());
    }
    if !self.ctx.context.has_pixels() {
      return Err(no_pixels_error(env));
    }
    // Flush deferred rendering before reading data
    self.ctx.context.flush();
    let ctx2d = &self.ctx.context;

    let surface_ref = ctx2d.surface.reference();

    let (ptr, size) = surface_ref.data().ok_or_else(|| {
      Error::new(
        Status::GenericFailure,
        "Get png data from surface failed".to_string(),
      )
    })?;
    // Copy the pixels: exposing the live surface buffer would let JS writes
    // bypass Skia's copy-on-write and corrupt in-flight encode snapshots.
    Ok(unsafe { slice::from_raw_parts(ptr, size) }.to_vec().into())
  }

  #[napi(js_name = "toDataURLAsync")]
  pub fn to_data_url_async(
    &mut self,
    mime: EncodeType<ToDataUrlAsyncSite>,
    quality: EncodeQuality,
  ) -> Result<AsyncTask<AsyncDataUrl>> {
    // Flush deferred rendering before encoding
    self.ctx.context.flush();
    Ok(AsyncTask::new(self.to_data_url_inner(mime.0, quality)?))
  }

  /// toDataURL(type, quality): the type is converted to a string and picked
  /// as Chrome picks it (an unknown type is PNG); the quality counts only
  /// when it is a number in [0, 1]. A failed encode is "data:,".
  #[napi(js_name = "toDataURL")]
  pub fn to_data_url(
    &mut self,
    mime: EncodeType<ToDataUrlSite>,
    quality: EncodeQuality,
  ) -> Result<String> {
    // Flush deferred rendering before encoding
    self.ctx.context.flush();
    Task::compute(&mut self.to_data_url_inner(mime.0, quality)?)
  }

  /// toBlob(type, quality) without the callback: index.js checks the
  /// callback, calls this, and makes the Blob. Resolves { data, type }, or
  /// null when the canvas has no pixels or the encoder fails (Chrome calls
  /// back null then).
  #[napi(ts_return_type = "Promise<{ data: Uint8Array; type: string } | null>")]
  pub fn to_blob(
    &mut self,
    mime: EncodeType<ToBlobSite>,
    quality: BlobQuality,
  ) -> Result<AsyncTask<AsyncBlob>> {
    // Flush deferred rendering before encoding
    self.ctx.context.flush();
    Ok(AsyncTask::new(AsyncBlob {
      image: self.snapshot()?,
      encoding: Encoding::web(mime.0, quality.0, None),
      width: self.ctx.context.width,
      height: self.ctx.context.height,
      reject_on_failure: false,
    }))
  }

  /// OffscreenCanvas.convertToBlob(options): ImageEncodeOptions `type`
  /// (default "image/png") and `quality` (default 1.0). Resolves { data,
  /// type }; index.js makes the Blob.
  #[napi(ts_return_type = "Promise<{ data: Uint8Array; type: string }>")]
  pub fn convert_to_blob<'env>(
    &mut self,
    env: &'env Env,
    options: ImageEncodeOptions,
  ) -> Result<Either<AsyncTask<AsyncBlob>, Unknown<'env>>> {
    if !self.ctx.context.has_pixels() {
      return rejected_with_index_size_error(env, CONVERT_TO_BLOB_NO_PIXELS).map(Either::B);
    }
    // Flush deferred rendering before encoding
    self.ctx.context.flush();
    Ok(Either::A(AsyncTask::new(AsyncBlob {
      image: self.snapshot()?,
      encoding: Encoding::web(options.ty, Some(options.quality), None),
      width: self.ctx.context.width,
      height: self.ctx.context.height,
      reject_on_failure: true,
    })))
  }

  #[napi]
  pub fn encode_stream<'env>(
    &'env mut self,
    env: &Env,
    mime: Option<String>,
    quality: Option<u32>,
  ) -> Result<ReadableStream<'env, BufferSlice<'env>>> {
    if !self.ctx.context.has_pixels() {
      return Err(no_pixels_error(env));
    }
    // Flush deferred rendering before encoding
    self.ctx.context.flush();
    let ty = match mime.as_deref() {
      Some("webp") => ImageType::Webp,
      Some("jpeg") => ImageType::Jpeg,
      Some("png") | None => ImageType::Png,
      _ => return Err(Error::new(Status::InvalidArg, "Invalid mime")),
    };
    let Some((format, quality, lossless)) = Encoding::node(ty, quality).skia() else {
      unreachable!("png, jpeg and webp are Skia encoders");
    };
    let (tx, rx) = channel(1024);
    let callback = |buffer: &[u8]| match tx.try_send(Ok(buffer.to_vec())) {
      Ok(_) | Err(TrySendError::Closed(_)) => {}
      Err(TrySendError::Full(_)) => {
        eprintln!("encode_image_stream_callback: channel is full");
      }
    };
    if !self.encode_image_inner(format, quality, lossless, callback) {
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
    format: sk::SkEncodedImageFormat,
    quality: f32,
    lossless: bool,
    callback: F,
  ) -> bool {
    let ptr = Box::into_raw(Box::new(callback));
    let result = self.ctx.context.surface.encode_stream(
      format,
      quality,
      lossless,
      Some(encode_image_stream_callback::<F>),
      ptr.cast(),
    );
    // SAFETY: encode_stream is synchronous, so the callback is no longer referenced.
    // Recover the Box to free the allocation.
    unsafe { drop(Box::from_raw(ptr)) };
    result
  }

  #[napi]
  pub fn save_png(&mut self, env: &Env, path: String) -> Result<()> {
    if !self.ctx.context.has_pixels() {
      return Err(no_pixels_error(env));
    }
    // Flush deferred rendering before saving
    self.ctx.context.flush();
    let ctx2d = &self.ctx.context;
    ctx2d.surface.save_png(&path);
    Ok(())
  }

  /// The pixels for an encoder, or None when the canvas has none.
  fn snapshot(&self) -> Result<Option<SkImage>> {
    if !self.ctx.context.has_pixels() {
      return Ok(None);
    }
    self
      .ctx
      .context
      .surface
      .make_image_snapshot()
      .map(Some)
      .ok_or_else(|| {
        Error::new(
          Status::GenericFailure,
          "Create image snapshot failed".to_owned(),
        )
      })
  }

  fn encode_inner(
    &self,
    format: String,
    quality_or_config: Either3<u32, AvifConfig, Unknown>,
  ) -> Result<ContextData> {
    let ty = ImageType::from_format(&format)
      .ok_or_else(|| Error::new(Status::InvalidArg, format!("{format} is not valid format")))?;
    let image = self.snapshot()?.ok_or_else(|| {
      Error::new(
        Status::GenericFailure,
        "Create image snapshot failed".to_owned(),
      )
    })?;
    Ok(ContextData {
      image,
      encoding: node_encoding(ty, quality_or_config, false),
      width: self.ctx.context.width,
      height: self.ctx.context.height,
    })
  }

  fn to_data_url_inner(&self, ty: ImageType, quality: EncodeQuality) -> Result<AsyncDataUrl> {
    Ok(AsyncDataUrl {
      image: self.snapshot()?,
      encoding: Encoding::web(ty, quality.quality, quality.avif),
      width: self.ctx.context.width,
      height: self.ctx.context.height,
    })
  }
}

/// The encoding of a Node method (toBuffer, or encode/encodeSync): a number
/// is the 0-100 quality (a larger one is 100), an AvifConfig the AVIF
/// settings. Without either, the defaults each method has always used.
fn node_encoding(
  ty: ImageType,
  quality_or_config: Either3<u32, AvifConfig, Unknown>,
  to_buffer: bool,
) -> Encoding {
  match quality_or_config {
    Either3::A(quality) => Encoding::node(ty, Some(quality)),
    Either3::B(config) => match ty {
      ImageType::Avif => Encoding::Avif(config),
      // toBuffer has used Blink's default WebP quality for an AvifConfig.
      ImageType::Webp if to_buffer => Encoding::node(ty, Some(80)),
      ImageType::Jpeg | ImageType::Webp if !to_buffer => Encoding::node(ty, config.quality),
      _ => Encoding::node(ty, None),
    },
    // toBuffer('image/gif') has passed 92 as the GIF quality.
    Either3::C(_) if to_buffer && ty == ImageType::Gif => Encoding::node(ty, Some(92)),
    Either3::C(_) => Encoding::node(ty, None),
  }
}

#[napi(object)]
pub struct ContextAttr {
  pub alpha: Option<bool>,
}

pub struct AsyncDataUrl {
  /// None: the canvas has no pixels.
  image: Option<SkImage>,
  encoding: Encoding,
  width: u32,
  height: u32,
}

#[napi]
impl Task for AsyncDataUrl {
  type Output = String;
  type JsValue = String;

  /// No pixels or a failed encode give "data:,"
  /// (HTMLCanvasElement::ToDataURLInternal, html_canvas_element.cc:1329-1384).
  fn compute(&mut self) -> Result<Self::Output> {
    let Some(image) = &self.image else {
      return Ok("data:,".to_owned());
    };
    let Ok(data) = encode_image(image, &self.encoding, self.width, self.height, false) else {
      return Ok("data:,".to_owned());
    };
    let mut output = format!("data:{};base64,", self.encoding.image_type().mime());
    base64_simd::STANDARD.encode_append(data.as_slice(), &mut output);
    Ok(output)
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

pub struct AsyncBlob {
  /// None: the canvas has no pixels.
  image: Option<SkImage>,
  encoding: Encoding,
  width: u32,
  height: u32,
  /// convertToBlob rejects a failed encode; toBlob resolves null.
  reject_on_failure: bool,
}

#[napi(object, object_from_js = false)]
pub struct BlobData<'env> {
  pub data: Uint8ArraySlice<'env>,
  /// The type of the encoded image (blob.type).
  #[napi(js_name = "type")]
  pub mime: String,
}

#[napi]
impl<'env> ScopedTask<'env> for AsyncBlob {
  type Output = Option<ContextOutputData>;
  type JsValue = Either<BlobData<'env>, Null>;

  fn compute(&mut self) -> Result<Self::Output> {
    let Some(image) = &self.image else {
      return Ok(None);
    };
    Ok(encode_image(image, &self.encoding, self.width, self.height, true).ok())
  }

  fn resolve(&mut self, env: &'env Env, output: Self::Output) -> Result<Self::JsValue> {
    let Some(output) = output else {
      // CanvasAsyncBlobCreator::CreateNullAndReturnResult
      // (canvas_async_blob_creator.cc:458-480).
      if self.reject_on_failure {
        return Err(webidl::dom_exception(
          env.raw(),
          "EncodingError",
          "Encoding of the source image has failed.",
        ));
      }
      return Ok(Either::B(Null));
    };
    Ok(Either::A(BlobData {
      data: output.into_uint8_array_slice(env)?,
      mime: self.encoding.image_type().mime().to_owned(),
    }))
  }
}

#[napi(js_name = "SVGCanvas")]
pub struct SVGCanvas<'scope> {
  pub width: u32,
  pub height: u32,
  pub(crate) ctx: ClassInstance<'scope, CanvasRenderingContext2D>,
  pub(crate) flag: SvgExportFlag,
  context_initialized: bool,
}

#[napi]
impl<'scope> SVGCanvas<'scope> {
  #[napi(constructor)]
  pub fn new(
    env: &Env,
    mut this: This<'scope>,
    width: Unknown,
    height: Unknown,
    flag: SvgExportFlag,
  ) -> Result<SVGCanvas<'scope>> {
    let width = constructor_size::<webidl::SvgCanvasSetWidth>(env, width, canvas_width)?;
    let height = constructor_size::<webidl::SvgCanvasSetHeight>(env, height, canvas_height)?;
    let context = Context::new_svg(width, height, flag.into(), ColorSpace::default())?;
    let bytes = context.surface_bytes();
    let ctx = CanvasRenderingContext2D::into_instance(
      CanvasRenderingContext2D {
        context,
        reported_settings: Default::default(),
      },
      env,
    )?;
    let mut ctx_obj = ctx.as_object(env);
    ctx_obj.define_properties(&[
      // For the read-only `canvas` getter, as on a Canvas.
      Property::new()
        .with_utf8_name(CANVAS_HIDDEN_NAME)?
        .with_value(&this)
        .with_property_attributes(PropertyAttributes::Default),
    ])?;
    env.adjust_external_memory(bytes)?;

    Ok(Self {
      width,
      height,
      flag,
      ctx: ctx.assign_to_this_with_attributes("ctx", PropertyAttributes::Default, &mut this)?,
      context_initialized: false,
    })
  }

  /// getContext(contextId, options): the 2d context, or null for any other
  /// id, as for Canvas.
  #[napi]
  pub fn get_context<'env>(
    &'env mut self,
    env: &Env,
    this: This<'env>,
    context_type: webidl::DomString<webidl::SvgCanvasGetContext>,
    // Converted on every call, as for Canvas.
    attrs: webidl::SvgCanvasContextOptions,
  ) -> Result<Option<Unknown<'env>>> {
    let attrs = attrs.0;
    if context_type.0 != "2d" {
      return Ok(None);
    }
    if self.context_initialized {
      return this.get_named_property("ctx").map(Some);
    }
    self.ctx.reported_settings = attrs.reported;
    let context_2d = &mut self.ctx.context;
    // The first acquisition fixes the color space of the raster surface that
    // reads see, as on a CanvasElement. The SVG output does not use it.
    // alpha:false always gets a fresh context: state set through the internal
    // `canvas.ctx` (matrix, clip, paint) must not reach the base.
    if attrs.color_space != context_2d.color_space || !attrs.alpha {
      let new_ctx = Context::new_svg(self.width, self.height, self.flag.into(), attrs.color_space)?;
      replace_context(env, context_2d, new_ctx)?;
      reset_ctx_style_getters(&this)?;
    }
    if !attrs.alpha {
      context_2d.set_opaque();
    }
    self.context_initialized = true;
    this.get_named_property("ctx").map(Some)
  }

  #[napi]
  pub fn get_content<'env>(&'env mut self, env: Env) -> Result<BufferSlice<'env>> {
    let svg_data_stream = self
      .ctx
      .context
      .stream
      .take()
      .ok_or_else(|| Error::new(Status::GenericFailure, "SVGCanvas has no stream"))?;
    unsafe {
      sk::ffi::skiac_canvas_destroy(self.ctx.context.surface.0);
    };
    // Null out the canvas pointer so that Surface::drop() won't double-free it.
    // The canvas was already destroyed above to flush/finalize SVG content to the stream.
    self.ctx.context.surface.canvas.0 = std::ptr::null_mut();
    let svg_data = svg_data_stream.data(self.ctx.context.width, self.ctx.context.height);
    let (surface, stream) = sk::Surface::new_svg(
      self.ctx.context.width,
      self.ctx.context.height,
      self.ctx.context.surface.alpha_type(),
      self.flag.into(),
      self.ctx.context.color_space,
    )
    .ok_or_else(|| Error::new(Status::GenericFailure, "Failed to create surface"))?;
    self.ctx.context.surface = surface;
    self.ctx.context.stream = Some(stream);
    // The next document starts from the alpha:false base again, as a fresh
    // bitmap would (spec: opaque black).
    if !self.ctx.context.alpha {
      self.ctx.context.surface.canvas.fill(0, 0, 0, 255);
    }
    // The backing surface was replaced: bump the content version so drawImage
    // dedup keys for this source cannot alias the new raster under the
    // pre-replacement charge.
    self.ctx.context.note_direct_mutation();
    unsafe {
      BufferSlice::from_external(&env, svg_data.0.ptr, svg_data.0.size, svg_data, |_, d| {
        mem::drop(d)
      })
    }
  }

  // Setting width or height resets the drawing but keeps the context's
  // settings (alpha, color space).
  fn resized_context(&self, width: u32, height: u32) -> Result<Context> {
    let old = &self.ctx.context;
    let mut context_2d = Context::new_svg(width, height, self.flag.into(), old.color_space)?;
    if !old.alpha {
      context_2d.set_opaque();
    }
    Ok(context_2d)
  }

  #[napi(setter)]
  pub fn set_width(
    &mut self,
    env: Env,
    this: This,
    width: webidl::UnsignedLong<webidl::SvgCanvasSetWidth>,
  ) -> Result<()> {
    let width = canvas_width(width.0);
    let new_ctx = self.resized_context(width, self.height)?;
    replace_context(&env, &mut self.ctx.context, new_ctx)?;
    self.width = width;
    reset_ctx_style_getters(&this)
  }

  #[napi(getter)]
  pub fn get_width(&self) -> u32 {
    self.width
  }

  #[napi(setter)]
  pub fn set_height(
    &mut self,
    env: Env,
    this: This,
    height: webidl::UnsignedLong<webidl::SvgCanvasSetHeight>,
  ) -> Result<()> {
    let height = canvas_height(height.0);
    let new_ctx = self.resized_context(self.width, height)?;
    replace_context(&env, &mut self.ctx.context, new_ctx)?;
    self.height = height;
    reset_ctx_style_getters(&this)
  }

  #[napi(getter)]
  pub fn get_height(&self) -> u32 {
    self.height
  }
}

#[napi(object)]
pub struct Rect {
  pub left: f64,
  pub top: f64,
  pub right: f64,
  pub bottom: f64,
}

#[napi(object)]
pub struct PDFMetadata {
  /// The document's title
  pub title: Option<String>,
  /// The name of the person who created the document
  pub author: Option<String>,
  /// The subject of the document
  pub subject: Option<String>,
  /// Keywords associated with the document
  pub keywords: Option<String>,
  /// The product that created the original document
  pub creator: Option<String>,
  /// The product that is converting this document to PDF (defaults to "Skia/PDF")
  pub producer: Option<String>,
  /// The DPI for rasterization (default: 72.0)
  pub raster_dpi: Option<f64>,
  /// Encoding quality: 0-100 for lossy JPEG, 101 for lossless (default: 101)
  pub encoding_quality: Option<i32>,
  /// Whether to conform to PDF/A-2b standard (default: false)
  pub pdfa: Option<bool>,
  /// Compression level: -1 (default), 0 (none), 1 (low/fast), 6 (average), 9 (high/slow)
  pub compression_level: Option<i32>,
}

#[napi]
pub struct PDFDocument {
  document: sk::ffi::skiac_pdf_document,
  // Keep CStrings alive for the lifetime of the document
  _metadata_strings: Option<PDFMetadataStrings>,
}

struct PDFMetadataStrings {
  _title: Option<CString>,
  _author: Option<CString>,
  _subject: Option<CString>,
  _keywords: Option<CString>,
  _creator: Option<CString>,
  _producer: Option<CString>,
}

#[napi]
impl PDFDocument {
  #[napi(constructor)]
  pub fn new(metadata: Option<PDFMetadata>) -> Self {
    let mut document = sk::ffi::skiac_pdf_document {
      document: std::ptr::null_mut(),
      stream: std::ptr::null_mut(),
    };

    let (c_metadata, metadata_strings) = if let Some(meta) = metadata {
      let title = meta.title.and_then(|s| CString::new(s).ok());
      let author = meta.author.and_then(|s| CString::new(s).ok());
      let subject = meta.subject.and_then(|s| CString::new(s).ok());
      let keywords = meta.keywords.and_then(|s| CString::new(s).ok());
      let creator = meta.creator.and_then(|s| CString::new(s).ok());
      let producer = meta.producer.and_then(|s| CString::new(s).ok());

      let c_meta = sk::ffi::skiac_pdf_metadata {
        title: title.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
        author: author.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
        subject: subject.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
        keywords: keywords.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
        creator: creator.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
        producer: producer.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
        raster_dpi: meta.raster_dpi.unwrap_or(72.0) as f32,
        encoding_quality: meta.encoding_quality.unwrap_or(101),
        pdfa: meta.pdfa.unwrap_or(false),
        compression_level: meta.compression_level.unwrap_or(-1),
      };

      let strings = PDFMetadataStrings {
        _title: title,
        _author: author,
        _subject: subject,
        _keywords: keywords,
        _creator: creator,
        _producer: producer,
      };

      (Some(c_meta), Some(strings))
    } else {
      (None, None)
    };

    unsafe {
      sk::ffi::skiac_document_create(
        &mut document,
        c_metadata
          .as_ref()
          .map_or(std::ptr::null(), |m| m as *const _),
      );
    }

    Self {
      document,
      _metadata_strings: metadata_strings,
    }
  }

  #[napi]
  pub fn begin_page(
    &mut self,
    env: Env,
    width: f64,
    height: f64,
    rect: Option<Rect>,
  ) -> Result<CanvasRenderingContext2D> {
    let canvas_ptr = unsafe {
      let rect = rect.map(|r| sk::ffi::skiac_rect {
        left: r.left as f32,
        top: r.top as f32,
        right: r.right as f32,
        bottom: r.bottom as f32,
      });
      sk::ffi::skiac_document_begin_page(
        &mut self.document,
        width as f32,
        height as f32,
        if let Some(mut rect) = rect {
          &mut rect
        } else {
          std::ptr::null_mut()
        },
      )
    };

    if canvas_ptr.is_null() {
      return Err(Error::new(Status::GenericFailure, "Failed to begin page"));
    }

    // Create a borrowed surface from the canvas
    // The canvas is owned by the document, not by the Surface
    let canvas = sk::Canvas(canvas_ptr);
    let surface = sk::Surface::from_borrowed_canvas(canvas);
    let context = Context::new_from_surface(surface, width as u32, height as u32);

    env.adjust_external_memory(context.surface_bytes())?;

    Ok(CanvasRenderingContext2D {
      context,
      reported_settings: Default::default(),
    })
  }

  #[napi]
  pub fn end_page(&mut self) {
    unsafe {
      sk::ffi::skiac_document_end_page(&mut self.document);
    }
  }

  #[napi]
  pub fn close<'env>(&mut self, env: &'env Env) -> Result<BufferSlice<'env>> {
    let mut data = sk::ffi::skiac_sk_data {
      ptr: std::ptr::null_mut(),
      size: 0,
      data: std::ptr::null_mut(),
    };
    unsafe {
      sk::ffi::skiac_document_close(&mut self.document, &mut data);
    }
    let pdf_data = SkiaDataRef(data);
    if pdf_data.0.ptr.is_null() {
      return BufferSlice::from_data(env, []);
    }
    unsafe {
      BufferSlice::from_external(env, pdf_data.0.ptr, pdf_data.0.size, pdf_data, |_, d| {
        mem::drop(d)
      })
    }
  }
}

impl Drop for PDFDocument {
  fn drop(&mut self) {
    unsafe {
      sk::ffi::skiac_document_destroy(&mut self.document);
    }
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
  // SAFETY: context points to a live Box<F> owned by encode_image_inner.
  // Borrow it rather than taking ownership, since this callback may be invoked
  // multiple times during encoding. The Box is freed by encode_image_inner after
  // encode_stream returns.
  let rust_callback: &F = unsafe { &*context.cast() };
  rust_callback(unsafe { slice::from_raw_parts(data.cast(), size) });
}
