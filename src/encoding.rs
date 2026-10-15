//! Which encoder a canvas export uses, and with which settings.
//!
//! The web methods (toDataURL, toDataURLAsync, toBlob, convertToBlob) follow
//! Blink: ImageEncoderUtils::ToEncodingMimeType (image_encoder_utils.cc)
//! picks the type, and ImageEncoder::ComputeJpegQuality and
//! ComputeWebpOptions (image_encoder.cc:109-131) turn the quality into
//! encoder settings. AVIF and GIF are this library's extra types there. The
//! Node methods (toBuffer, encode, encodeSync, encodeStream) take a 0-100
//! quality.

use std::cell::Cell;
use std::mem;

use napi::bindgen_prelude::*;

use crate::{
  avif::{self, AvifConfig},
  gif::{self, GifConfig},
  sk::{AlphaType, ColorSpace, SkEncodedImageFormat, SkImage, SkiaDataRef},
  webidl,
};

/// Blink's JPEG quality without a valid one (ComputeJpegQuality).
pub(crate) const DEFAULT_JPEG_QUALITY: u8 = 92;
/// Blink's lossy WebP quality without a valid one (ComputeWebpOptions).
const DEFAULT_WEBP_QUALITY: f32 = 80.0;
/// What the Node methods have always used without a quality, for JPEG and
/// WebP alike.
const NODE_DEFAULT_QUALITY: u32 = 92;

pub(crate) const TO_DATA_URL: &str = "Failed to execute 'toDataURL' on 'HTMLCanvasElement': ";
pub(crate) const TO_DATA_URL_ASYNC: &str =
  "Failed to execute 'toDataURLAsync' on 'HTMLCanvasElement': ";
pub(crate) const TO_BLOB: &str = "Failed to execute 'toBlob' on 'HTMLCanvasElement': ";
pub(crate) const CONVERT_TO_BLOB: &str = "Failed to execute 'convertToBlob' on 'OffscreenCanvas': ";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ImageType {
  Png,
  Jpeg,
  Webp,
  Avif,
  Gif,
}

impl ImageType {
  /// ToEncodingMimeType: the ASCII-lowercase requested type, and PNG for a
  /// type there is no encoder for ("", "image/jpg", "image/jpeg "...), not
  /// an error. AVIF and GIF are this library's extra encoders.
  pub(crate) fn from_requested(mime: &str) -> Self {
    match mime.to_ascii_lowercase().as_str() {
      "image/jpeg" => Self::Jpeg,
      "image/webp" => Self::Webp,
      "image/avif" => Self::Avif,
      "image/gif" => Self::Gif,
      _ => Self::Png,
    }
  }

  /// toBuffer(mime): an exact, known MIME type, else None (an error).
  pub(crate) fn from_mime(mime: &str) -> Option<Self> {
    match mime {
      "image/png" => Some(Self::Png),
      "image/jpeg" => Some(Self::Jpeg),
      "image/webp" => Some(Self::Webp),
      "image/avif" => Some(Self::Avif),
      "image/gif" => Some(Self::Gif),
      _ => None,
    }
  }

  /// encode(format) / encodeSync(format) names.
  pub(crate) fn from_format(format: &str) -> Option<Self> {
    match format {
      "png" => Some(Self::Png),
      "jpeg" => Some(Self::Jpeg),
      "webp" => Some(Self::Webp),
      "avif" => Some(Self::Avif),
      "gif" => Some(Self::Gif),
      _ => None,
    }
  }

  pub(crate) fn mime(self) -> &'static str {
    match self {
      Self::Png => "image/png",
      Self::Jpeg => "image/jpeg",
      Self::Webp => "image/webp",
      Self::Avif => "image/avif",
      Self::Gif => "image/gif",
    }
  }

  fn format_name(self) -> &'static str {
    match self {
      Self::Png => "png",
      Self::Jpeg => "jpeg",
      Self::Webp => "webp",
      Self::Avif => "avif",
      Self::Gif => "gif",
    }
  }
}

#[derive(Clone)]
pub(crate) enum Encoding {
  Png,
  Jpeg(u8),
  Webp { quality: f32, lossless: bool },
  Avif(AvifConfig),
  Gif(GifConfig),
}

/// Blink's rounding of a quality to a percentage:
/// static_cast<int>(quality * 100 + 0.5).
fn percent(quality: f64) -> u32 {
  (quality * 100.0 + 0.5) as u32
}

impl Encoding {
  /// The web methods. `quality` is the argument when it is a JS number, or
  /// ImageEncodeOptions.quality; outside [0, 1] (and NaN) it is the default.
  /// `avif` is this library's AvifConfig, given as the quality.
  pub(crate) fn web(ty: ImageType, quality: Option<f64>, avif: Option<AvifConfig>) -> Self {
    let in_range = quality.filter(|q| (0.0..=1.0).contains(q));
    match ty {
      ImageType::Png => Self::Png,
      ImageType::Jpeg => Self::Jpeg(in_range.map_or(DEFAULT_JPEG_QUALITY, |q| percent(q) as u8)),
      // Exactly 1 is lossless, with effort 75. A lossy quality keeps its
      // fraction: Skia passes the float to libwebp.
      ImageType::Webp if quality == Some(1.0) => Self::Webp {
        quality: 75.0,
        lossless: true,
      },
      ImageType::Webp => Self::Webp {
        quality: in_range.map_or(DEFAULT_WEBP_QUALITY, |q| (q * 100.0) as f32),
        lossless: false,
      },
      ImageType::Avif => Self::Avif(avif.unwrap_or_else(|| AvifConfig {
        quality: in_range.map(percent),
        ..Default::default()
      })),
      // GifConfig.quality is NeuQuant's 1-30 scale (clamped there); 92 is
      // what these methods have always passed without a quality.
      ImageType::Gif => Self::Gif(GifConfig {
        quality: Some(in_range.map_or(NODE_DEFAULT_QUALITY, percent)),
      }),
    }
  }

  /// The Node methods: a 0-100 quality, where a larger one is 100. None is
  /// 92 for JPEG and WebP, the default AvifConfig, and GIF's own default.
  pub(crate) fn node(ty: ImageType, quality: Option<u32>) -> Self {
    let clamped = quality.map(|q| q.min(100));
    match ty {
      ImageType::Png => Self::Png,
      ImageType::Jpeg => Self::Jpeg(clamped.unwrap_or(NODE_DEFAULT_QUALITY) as u8),
      ImageType::Webp => match clamped.unwrap_or(NODE_DEFAULT_QUALITY) {
        100 => Self::Webp {
          quality: 75.0,
          lossless: true,
        },
        q => Self::Webp {
          quality: q as f32,
          lossless: false,
        },
      },
      ImageType::Avif => Self::Avif(AvifConfig {
        quality: clamped,
        ..Default::default()
      }),
      // GifConfig.quality is NeuQuant's 1-30 scale: passed as it is.
      ImageType::Gif => Self::Gif(GifConfig { quality }),
    }
  }

  pub(crate) fn image_type(&self) -> ImageType {
    match self {
      Self::Png => ImageType::Png,
      Self::Jpeg(_) => ImageType::Jpeg,
      Self::Webp { .. } => ImageType::Webp,
      Self::Avif(_) => ImageType::Avif,
      Self::Gif(_) => ImageType::Gif,
    }
  }

  /// (format, quality, lossless) for the Skia encoders; None for AVIF and
  /// GIF.
  pub(crate) fn skia(&self) -> Option<(SkEncodedImageFormat, f32, bool)> {
    match self {
      Self::Png => Some((SkEncodedImageFormat::Png, 100.0, false)),
      Self::Jpeg(q) => Some((SkEncodedImageFormat::Jpeg, f32::from(*q), false)),
      Self::Webp { quality, lossless } => Some((SkEncodedImageFormat::Webp, *quality, *lossless)),
      Self::Avif(_) | Self::Gif(_) => None,
    }
  }
}

pub enum ContextOutputData {
  Skia(SkiaDataRef),
  Avif(Vec<u8>),
  Gif(Vec<u8>),
}

unsafe impl Send for ContextOutputData {}
unsafe impl Sync for ContextOutputData {}

impl ContextOutputData {
  pub(crate) fn as_slice(&self) -> &[u8] {
    match self {
      ContextOutputData::Skia(data) => data.slice(),
      ContextOutputData::Avif(data) | ContextOutputData::Gif(data) => data,
    }
  }

  pub(crate) fn into_buffer_slice<'a>(self, env: Env) -> Result<BufferSlice<'a>> {
    match self {
      ContextOutputData::Skia(output) => unsafe {
        BufferSlice::from_external(&env, output.0.ptr, output.0.size, output, |_, data_ref| {
          mem::drop(data_ref)
        })
      },
      ContextOutputData::Avif(output) | ContextOutputData::Gif(output) => unsafe {
        BufferSlice::from_external(
          &env,
          output.as_ptr().cast_mut(),
          output.len(),
          output,
          |_, data_ref| mem::drop(data_ref),
        )
      },
    }
  }

  pub(crate) fn into_uint8_array_slice(self, env: &Env) -> Result<Uint8ArraySlice<'_>> {
    match self {
      ContextOutputData::Skia(data_ref) => unsafe {
        Uint8ArraySlice::from_external(env, data_ref.0.ptr, data_ref.0.size, data_ref, |_, d| {
          mem::drop(d)
        })
      },
      ContextOutputData::Avif(data) | ContextOutputData::Gif(data) => unsafe {
        Uint8ArraySlice::from_external(env, data.as_ptr().cast_mut(), data.len(), data, |_, d| {
          mem::drop(d)
        })
      },
    }
  }
}

/// Encodes `image`. `crop_to_max_dimension`: toBlob and convertToBlob encode
/// the top-left part that the encoder can hold, as Blink's
/// CanvasAsyncBlobCreator does (canvas_async_blob_creator.cc:199-209).
/// Err holds the failure detail: None for a Skia encoder that gave nothing,
/// Some(message) for AVIF and GIF.
pub(crate) fn encode_image(
  image: &SkImage,
  encoding: &Encoding,
  width: u32,
  height: u32,
  crop_to_max_dimension: bool,
) -> std::result::Result<ContextOutputData, Option<String>> {
  if let Some((format, quality, lossless)) = encoding.skia() {
    return image
      .encode_data(format, quality, lossless, crop_to_max_dimension)
      .map(ContextOutputData::Skia)
      .ok_or(None);
  }
  match encoding {
    Encoding::Avif(config) => {
      let color_space = image.color_space();
      let pixels = image
        .read_pixels(AlphaType::Unpremultiplied, color_space)
        .ok_or_else(|| Some("Encode to avif error, failed to get surface pixels".to_owned()))?;
      avif::encode(&pixels, width, height, &config.clone().into(), color_space)
        .map(ContextOutputData::Avif)
        .map_err(|e| Some(format!("{e}")))
    }
    Encoding::Gif(config) => {
      let pixels = image
        .read_pixels(AlphaType::Unpremultiplied, ColorSpace::Srgb)
        .ok_or_else(|| Some("Encode to gif error, failed to get surface pixels".to_owned()))?;
      gif::encode(&pixels, width, height, config)
        .map(ContextOutputData::Gif)
        .map_err(|e| Some(format!("{e}")))
    }
    Encoding::Png | Encoding::Jpeg(_) | Encoding::Webp { .. } => unreachable!(),
  }
}

/// The error toBuffer (`via_mime`) or encode/encodeSync have always thrown
/// for a failed encode.
pub(crate) fn node_encode_error(ty: ImageType, detail: Option<String>, via_mime: bool) -> Error {
  match (detail, via_mime) {
    (Some(detail), _) => Error::new(Status::GenericFailure, detail),
    (None, true) => Error::new(
      Status::InvalidArg,
      format!("encode {} output failed", ty.mime()),
    ),
    (None, false) => Error::new(
      Status::GenericFailure,
      format!("Get {} data from surface failed", ty.format_name()),
    ),
  }
}

/// An encode() / encodeSync() job.
pub struct ContextData {
  pub(crate) image: SkImage,
  pub(crate) encoding: Encoding,
  pub(crate) width: u32,
  pub(crate) height: u32,
}

#[inline]
pub(crate) fn encode_surface(data: &ContextData) -> Result<ContextOutputData> {
  encode_image(&data.image, &data.encoding, data.width, data.height, false)
    .map_err(|detail| node_encode_error(data.encoding.image_type(), detail, false))
}

impl Task for ContextData {
  type Output = ContextOutputData;
  type JsValue = Buffer;

  fn compute(&mut self) -> Result<Self::Output> {
    encode_surface(self)
  }

  fn resolve(&mut self, env: Env, output_data: Self::Output) -> Result<Self::JsValue> {
    output_data
      .into_buffer_slice(env)
      .and_then(|slice| slice.into_buffer(&env))
  }
}

thread_local! {
  /// The type the `EncodeType` of the call being converted gave, for its
  /// `EncodeQuality`.
  static REQUESTED_TYPE: Cell<ImageType> = const { Cell::new(ImageType::Png) };
}

/// Where an `EncodeType` / `EncodeQuality` argument is converted.
pub(crate) trait EncodeSite {
  const PREFIX: &'static str;
}

pub struct ToDataUrlSite;
impl EncodeSite for ToDataUrlSite {
  const PREFIX: &'static str = TO_DATA_URL;
}

pub struct ToDataUrlAsyncSite;
impl EncodeSite for ToDataUrlAsyncSite {
  const PREFIX: &'static str = TO_DATA_URL_ASYNC;
}

pub struct ToBlobSite;
impl EncodeSite for ToBlobSite {
  const PREFIX: &'static str = TO_BLOB;
}

/// `optional DOMString type = "image/png"` of toDataURL and toBlob,
/// converted before napi-rs borrows the receiver (toString may use it).
pub struct EncodeType<S>(pub(crate) ImageType, std::marker::PhantomData<S>);

impl<S: EncodeSite> FromNapiValue for EncodeType<S> {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    let ty = if webidl::type_of(env, value)? == ValueType::Undefined {
      ImageType::Png
    } else {
      ImageType::from_requested(&webidl::to_dom_string(env, value, S::PREFIX)?)
    };
    REQUESTED_TYPE.with(|requested| requested.set(ty));
    Ok(Self(ty, std::marker::PhantomData))
  }
}

/// `any quality` of toDataURL and toBlob: only a JS number counts, without
/// any conversion (HTMLCanvasElement::toDataURL, html_canvas_element.cc:
/// 1401-1405). For the AVIF type of toDataURL, an object is this library's
/// AvifConfig.
pub struct EncodeQuality {
  pub(crate) quality: Option<f64>,
  pub(crate) avif: Option<AvifConfig>,
}

impl FromNapiValue for EncodeQuality {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    let ty = REQUESTED_TYPE.with(|requested| requested.replace(ImageType::Png));
    Ok(match webidl::type_of(env, value)? {
      ValueType::Number => Self {
        quality: Some(unsafe { f64::from_napi_value(env, value)? }),
        avif: None,
      },
      ValueType::Object if ty == ImageType::Avif => Self {
        quality: None,
        avif: Some(unsafe { AvifConfig::from_napi_value(env, value)? }),
      },
      _ => Self {
        quality: None,
        avif: None,
      },
    })
  }
}

/// The ImageEncodeOptions dictionary of convertToBlob
/// (image_encode_options.idl): `quality` (unrestricted double, default 1.0)
/// and `type` (DOMString, default "image/png"), read in that order. A value
/// that is not an object is a TypeError; null and undefined are the
/// defaults.
pub struct ImageEncodeOptions {
  pub(crate) ty: ImageType,
  pub(crate) quality: f64,
}

impl FromNapiValue for ImageEncodeOptions {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    let mut options = Self {
      ty: ImageType::Png,
      quality: 1.0,
    };
    match webidl::type_of(env, value)? {
      ValueType::Undefined | ValueType::Null => return Ok(options),
      ValueType::Object | ValueType::Function => {}
      _ => {
        return Err(webidl::context_type_error(
          env,
          CONVERT_TO_BLOB,
          "The provided value is not of type 'ImageEncodeOptions'.",
        ));
      }
    }
    let member = |key: &std::ffi::CStr| -> Result<Option<sys::napi_value>> {
      let mut member = std::ptr::null_mut();
      check_status!(unsafe {
        sys::napi_get_named_property(env, value, key.as_ptr(), &mut member)
      })?;
      Ok(match webidl::type_of(env, member)? {
        ValueType::Undefined => None,
        _ => Some(member),
      })
    };
    if let Some(quality) = member(c"quality")? {
      options.quality = webidl::to_number(
        env,
        quality,
        &format!(
          "{CONVERT_TO_BLOB}Failed to read the 'quality' property from 'ImageEncodeOptions': "
        ),
      )?;
    }
    if let Some(ty) = member(c"type")? {
      options.ty = ImageType::from_requested(&webidl::to_dom_string(
        env,
        ty,
        &format!("{CONVERT_TO_BLOB}Failed to read the 'type' property from 'ImageEncodeOptions': "),
      )?);
    }
    Ok(options)
  }
}
