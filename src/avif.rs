use std::{ptr, result, slice};

use libavif::YuvFormat;
use libavif_sys as sys;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::avif_yuv;
use crate::error::SkError;
use crate::sk::ColorSpace;

#[napi(object)]
#[derive(Default, Clone)]
pub struct AvifConfig {
  /// 0-100 scale, 100 is the best quality. 100 with 4:4:4 (the default) is
  /// lossless: R, G and B are coded as they are (CICP matrix 0, identity).
  /// Below 100, or with chroma subsampling, the pixels are lossy BT.601 YUV.
  /// Default 80.
  pub quality: Option<u32>,
  /// 0-100 scale. Default 100 when `quality` is 100 (lossless alpha), else 90.
  pub alpha_quality: Option<u32>,
  /// aom encoder speed from 0 (slowest, smallest file) to 10 (fastest);
  /// larger values are 10. Default 5.
  pub speed: Option<u32>,
  /// How many threads to use: 0 or unset is one per CPU core; at most 64.
  pub threads: Option<u32>,
  /// set to '4:2:0' to use chroma subsampling, default '4:4:4'
  pub chroma_subsampling: Option<ChromaSubsampling>,
}

#[napi]
/// https://en.wikipedia.org/wiki/Chroma_subsampling#Types_of_sampling_and_subsampling
/// https://developer.mozilla.org/en-US/docs/Web/Media/Formats/Video_concepts
#[derive(Clone, Copy)]
pub enum ChromaSubsampling {
  /// Each of the three Y'CbCr components has the same sample rate, thus there is no chroma subsampling. This scheme is sometimes used in high-end film scanners and cinematic post-production.
  /// Note that "4:4:4" may instead be wrongly referring to R'G'B' color space, which implicitly also does not have any chroma subsampling (except in JPEG R'G'B' can be subsampled).
  /// Formats such as HDCAM SR can record 4:4:4 R'G'B' over dual-link HD-SDI.
  Yuv444,
  /// The two chroma components are sampled at half the horizontal sample rate of luma: the horizontal chroma resolution is halved. This reduces the bandwidth of an uncompressed video signal by one-third.
  /// Many high-end digital video formats and interfaces use this scheme:
  /// - [AVC-Intra 100](https://en.wikipedia.org/wiki/AVC-Intra)
  /// - [Digital Betacam](https://en.wikipedia.org/wiki/Betacam#Digital_Betacam)
  /// - [Betacam SX](https://en.wikipedia.org/wiki/Betacam#Betacam_SX)
  /// - [DVCPRO50](https://en.wikipedia.org/wiki/DV#DVCPRO) and [DVCPRO HD](https://en.wikipedia.org/wiki/DV#DVCPRO_HD)
  /// - [Digital-S](https://en.wikipedia.org/wiki/Digital-S)
  /// - [CCIR 601](https://en.wikipedia.org/wiki/Rec._601) / [Serial Digital Interface](https://en.wikipedia.org/wiki/Serial_digital_interface) / [D1](https://en.wikipedia.org/wiki/D-1_(Sony))
  /// - [ProRes (HQ, 422, LT, and Proxy)](https://en.wikipedia.org/wiki/Apple_ProRes)
  /// - [XDCAM HD422](https://en.wikipedia.org/wiki/XDCAM)
  /// - [Canon MXF HD422](https://en.wikipedia.org/wiki/Canon_XF-300)
  Yuv422,
  /// n 4:2:0, the horizontal sampling is doubled compared to 4:1:1,
  /// but as the **Cb** and **Cr** channels are only sampled on each alternate line in this scheme, the vertical resolution is halved.
  /// The data rate is thus the same.
  /// This fits reasonably well with the PAL color encoding system, since this has only half the vertical chrominance resolution of [NTSC](https://en.wikipedia.org/wiki/NTSC).
  /// It would also fit extremely well with the [SECAM](https://en.wikipedia.org/wiki/SECAM) color encoding system,
  /// since like that format, 4:2:0 only stores and transmits one color channel per line (the other channel being recovered from the previous line).
  /// However, little equipment has actually been produced that outputs a SECAM analogue video signal.
  /// In general, SECAM territories either have to use a PAL-capable display or a [transcoder](https://en.wikipedia.org/wiki/Transcoding) to convert the PAL signal to SECAM for display.
  Yuv420,
  /// What if the chroma subsampling model is 4:0:0?
  /// That says to use every pixel of luma data, but that each row has 0 chroma samples applied to it. The resulting image, then, is comprised solely of the luminance data—a greyscale image.
  Yuv400,
}

impl From<ChromaSubsampling> for YuvFormat {
  #[inline]
  fn from(value: ChromaSubsampling) -> YuvFormat {
    match value {
      ChromaSubsampling::Yuv444 => YuvFormat::Yuv444,
      ChromaSubsampling::Yuv422 => YuvFormat::Yuv422,
      ChromaSubsampling::Yuv420 => YuvFormat::Yuv420,
      ChromaSubsampling::Yuv400 => YuvFormat::Yuv400,
    }
  }
}

pub struct Config {
  quality: u8,
  alpha_quality: u8,
  speed: u8,
  threads: usize,
  chroma_subsampling: ChromaSubsampling,
}

impl From<AvifConfig> for Config {
  fn from(config: AvifConfig) -> Self {
    Config {
      // See also: https://github.com/kornelski/cavif-rs#usage
      // Clamp before narrowing to u8, so 256 is the best quality, not 0.
      quality: config.quality.unwrap_or(80).min(100) as u8,
      // Calculate alphaQuality, this is consistent with cavif.
      // https://github.com/kornelski/cavif-rs/blob/37847b95bb81d4cf90e36b7fab2c7fbbcf95abe2/src/main.rs#L97
      // Quality 100 is lossless (see `encode`), so the alpha is lossless too
      // unless alphaQuality says otherwise.
      alpha_quality: config
        .alpha_quality
        .unwrap_or(if config.quality.is_some_and(|q| q >= 100) {
          100
        } else {
          90
        })
        .min(100) as u8,
      // aom speed 0 (slowest) to 10 (fastest). Clamp before narrowing to u8,
      // so 256 is the fastest speed, not 0.
      speed: config.speed.unwrap_or(5).min(10) as u8,
      // 0 or unset: one thread per core. aom takes 1 to 64 threads
      // (MAX_NUM_THREADS); more fails the encode.
      threads: match config.threads {
        None | Some(0) => num_cpus::get(),
        Some(n) => n as usize,
      }
      .clamp(1, 64),
      chroma_subsampling: config
        .chroma_subsampling
        .unwrap_or(ChromaSubsampling::Yuv444),
    }
  }
}

impl From<&Either3<u32, AvifConfig, Unknown<'_>>> for AvifConfig {
  fn from(value: &Either3<u32, AvifConfig, Unknown>) -> Self {
    if let Either3::B(a) = value {
      a.clone()
    } else {
      Default::default()
    }
  }
}

impl From<&Either<u32, AvifConfig>> for AvifConfig {
  fn from(value: &Either<u32, AvifConfig>) -> Self {
    if let Either::B(a) = value {
      a.clone()
    } else {
      Default::default()
    }
  }
}

/// Frees the libavif objects of [`encode`] on every return path.
struct EncodeGuard {
  image: *mut sys::avifImage,
  encoder: *mut sys::avifEncoder,
  output: sys::avifRWData,
}

impl Drop for EncodeGuard {
  fn drop(&mut self) {
    unsafe {
      sys::avifRWDataFree(&mut self.output);
      if !self.encoder.is_null() {
        sys::avifEncoderDestroy(self.encoder);
      }
      if !self.image.is_null() {
        sys::avifImageDestroy(self.image);
      }
    }
  }
}

fn avif_result(code: sys::avifResult) -> result::Result<(), SkError> {
  if code == sys::AVIF_RESULT_OK {
    Ok(())
  } else {
    Err(SkError::EncodeAvifError(libavif::Error::Code(code)))
  }
}

/// Encodes unpremultiplied RGBA pixels that are in `color_space`.
pub(crate) fn encode(
  avif_image: &[u8],
  width: u32,
  height: u32,
  config: &Config,
  color_space: ColorSpace,
) -> result::Result<Vec<u8>, SkError> {
  if avif_image.len() != width as usize * height as usize * 4 {
    return Err(SkError::PixelsToRgb(libavif::Error::UnsupportedImageType));
  }
  let yuv_format: YuvFormat = config.chroma_subsampling.into();
  let mut guard = EncodeGuard {
    image: unsafe { sys::avifImageCreate(width, height, 8, yuv_format as u32) },
    encoder: ptr::null_mut(),
    output: sys::avifRWData::default(),
  };
  if guard.image.is_null() {
    return Err(SkError::Generic("avifImageCreate failed".to_owned()));
  }
  unsafe {
    let image = &mut *guard.image;
    // The spec: an image type that supports a color profile must carry the
    // bitmap's color space. AVIF does it with CICP (the 'nclx' colr box).
    // Display P3 is SMPTE EG 432-1 primaries with the sRGB transfer. BT.601
    // is the matrix libavif used for the unspecified value we wrote before,
    // so the YUV planes do not change.
    image.colorPrimaries = match color_space {
      ColorSpace::Srgb => sys::AVIF_COLOR_PRIMARIES_BT709,
      ColorSpace::DisplayP3 => sys::AVIF_COLOR_PRIMARIES_SMPTE432,
    } as u16;
    image.transferCharacteristics = sys::AVIF_TRANSFER_CHARACTERISTICS_SRGB as u16;
    // Quality 100 with 4:4:4 is lossless, like WebP quality 1 in Chrome
    // (image_encoder.cc:119-123): the identity matrix puts G, B and R into
    // Y, U and V unchanged, and libavif codes quality 100 with aom's lossless
    // mode. BT.601 YUV would round each channel first.
    let lossless =
      config.quality >= 100 && matches!(config.chroma_subsampling, ChromaSubsampling::Yuv444);
    image.matrixCoefficients = if lossless {
      sys::AVIF_MATRIX_COEFFICIENTS_IDENTITY
    } else {
      sys::AVIF_MATRIX_COEFFICIENTS_BT601
    } as u16;
    image.yuvRange = sys::AVIF_RANGE_FULL;
    let mut rgb = sys::avifRGBImage::default();
    sys::avifRGBImageSetDefaults(&mut rgb, image);
    rgb.format = sys::AVIF_RGB_FORMAT_RGBA;
    rgb.chromaDownsampling = sys::AVIF_CHROMA_DOWNSAMPLING_BEST_QUALITY;
    // libavif only reads the RGB pixels here.
    rgb.pixels = avif_image.as_ptr().cast_mut();
    rgb.rowBytes = width * 4;
    avif_result(sys::avifImageAllocatePlanes(image, sys::AVIF_PLANES_YUV))?;
    avif_result(sys::avifImageRGBToYUV(image, &rgb))?;

    guard.encoder = sys::avifEncoderCreate();
    if guard.encoder.is_null() {
      return Err(SkError::Generic("avifEncoderCreate failed".to_owned()));
    }
    let encoder = &mut *guard.encoder;
    // libavif 1.x `quality` is already our 0-100 scale (AVIF_QUALITY_BEST is
    // 100, avif.h); it is not the old 0-63 quantizer, where 0 was the best.
    encoder.quality = config.quality.min(100).into();
    encoder.qualityAlpha = config.alpha_quality.min(100).into();
    encoder.speed = config.speed.min(10).into();
    encoder.maxThreads = config.threads as i32;
    avif_result(sys::avifEncoderWrite(
      guard.encoder,
      guard.image,
      &mut guard.output,
    ))?;
    if guard.output.data.is_null() {
      return Ok(Vec::new());
    }
    Ok(slice::from_raw_parts(guard.output.data, guard.output.size).to_vec())
  }
}

/// Enum representing AVIF error codes
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AvifErrorCode {
  Ok = 0,
  UnknownError = 1,
  InvalidFtyp = 2,
  NoContent = 3,
  NoYuvFormatSelected = 4,
  ReformatFailed = 5,
  UnsupportedDepth = 6,
  EncodeColorFailed = 7,
  EncodeAlphaFailed = 8,
  BmffParseFailed = 9,
  MissingImageItem = 10,
  DecodeColorFailed = 11,
  DecodeAlphaFailed = 12,
  ColorAlphaSizeMismatch = 13,
  IspeSizeMismatch = 14,
  NoCodecAvailable = 15,
  NoImagesRemaining = 16,
  InvalidExifPayload = 17,
  InvalidImageGrid = 18,
  InvalidCodecSpecificOption = 19,
  TruncatedData = 20,
  IoNotSet = 21,
  IoError = 22,
  WaitingOnIo = 23,
  InvalidArgument = 24,
  NotImplemented = 25,
  OutOfMemory = 26,
  CannotChangeSetting = 27,
  IncompatibleImage = 28,
  InternalError = 29,
  EncodeGainMapFailed = 30,
  DecodeGainMapFailed = 31,
  InvalidToneMappedImage = 32,
}

#[derive(Debug)]
pub enum AvifError {
  Known(AvifErrorCode),
  Unknown(u32),
}

impl std::fmt::Display for AvifError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      AvifError::Known(code) => write!(f, "AvifError: {code:?}"),
      AvifError::Unknown(code) => write!(f, "AvifError: {code}"),
    }
  }
}

impl std::error::Error for AvifError {}

impl From<u32> for AvifError {
  fn from(code: u32) -> Self {
    match code {
      0 => AvifError::Known(AvifErrorCode::Ok),
      1 => AvifError::Known(AvifErrorCode::UnknownError),
      2 => AvifError::Known(AvifErrorCode::InvalidFtyp),
      3 => AvifError::Known(AvifErrorCode::NoContent),
      4 => AvifError::Known(AvifErrorCode::NoYuvFormatSelected),
      5 => AvifError::Known(AvifErrorCode::ReformatFailed),
      6 => AvifError::Known(AvifErrorCode::UnsupportedDepth),
      7 => AvifError::Known(AvifErrorCode::EncodeColorFailed),
      8 => AvifError::Known(AvifErrorCode::EncodeAlphaFailed),
      9 => AvifError::Known(AvifErrorCode::BmffParseFailed),
      10 => AvifError::Known(AvifErrorCode::MissingImageItem),
      11 => AvifError::Known(AvifErrorCode::DecodeColorFailed),
      12 => AvifError::Known(AvifErrorCode::DecodeAlphaFailed),
      13 => AvifError::Known(AvifErrorCode::ColorAlphaSizeMismatch),
      14 => AvifError::Known(AvifErrorCode::IspeSizeMismatch),
      15 => AvifError::Known(AvifErrorCode::NoCodecAvailable),
      16 => AvifError::Known(AvifErrorCode::NoImagesRemaining),
      17 => AvifError::Known(AvifErrorCode::InvalidExifPayload),
      18 => AvifError::Known(AvifErrorCode::InvalidImageGrid),
      19 => AvifError::Known(AvifErrorCode::InvalidCodecSpecificOption),
      20 => AvifError::Known(AvifErrorCode::TruncatedData),
      21 => AvifError::Known(AvifErrorCode::IoNotSet),
      22 => AvifError::Known(AvifErrorCode::IoError),
      23 => AvifError::Known(AvifErrorCode::WaitingOnIo),
      24 => AvifError::Known(AvifErrorCode::InvalidArgument),
      25 => AvifError::Known(AvifErrorCode::NotImplemented),
      26 => AvifError::Known(AvifErrorCode::OutOfMemory),
      27 => AvifError::Known(AvifErrorCode::CannotChangeSetting),
      28 => AvifError::Known(AvifErrorCode::IncompatibleImage),
      29 => AvifError::Known(AvifErrorCode::InternalError),
      30 => AvifError::Known(AvifErrorCode::EncodeGainMapFailed),
      31 => AvifError::Known(AvifErrorCode::DecodeGainMapFailed),
      32 => AvifError::Known(AvifErrorCode::InvalidToneMappedImage),
      _ => AvifError::Unknown(code),
    }
  }
}

impl AvifError {
  pub fn from_code(code: u32) -> result::Result<(), AvifError> {
    match code {
      0 => Ok(()),
      _ => Err(AvifError::Unknown(code)),
    }
  }
}

pub struct AvifImage {
  image: *mut sys::avifImage,
  pub width: u32,
  pub height: u32,
  pub row_bytes: u32,
  /// RGBA, premultiplied, converted from YUV as Chrome does
  /// ([`crate::avif_yuv`]).
  pub data: Vec<u8>,
  /// CICP colour primaries, transfer characteristics and matrix
  /// coefficients; 2 is unspecified.
  pub color_primaries: u16,
  pub transfer_characteristics: u16,
  pub matrix_coefficients: u16,
  /// 4:0:0 (grayscale).
  pub is_mono: bool,
  /// The SkEncodedOrigin of the 'irot' and 'imir' properties (1 is none).
  pub origin: i32,
}

/// Chrome's kAxisAngleToOrientation (avif_image_decoder.cc:897-938): the
/// EXIF-style origin for an anti-clockwise rotation of `angle` * 90 degrees
/// then a mirror on `axis` (-1 none, 0 top-bottom, 1 left-right).
fn origin(angle: u8, axis: i8) -> i32 {
  // SkEncodedOrigin: 1 TopLeft, 2 TopRight, 3 BottomRight, 4 BottomLeft,
  // 5 LeftTop, 6 RightTop, 7 RightBottom, 8 LeftBottom.
  const AXIS_ANGLE_TO_ORIGIN: [[i32; 4]; 3] = [[1, 8, 3, 6], [4, 5, 2, 7], [2, 7, 4, 5]];
  AXIS_ANGLE_TO_ORIGIN[(axis + 1) as usize][angle as usize]
}

impl AvifImage {
  /// The ICC profile from the file's 'colr' box, empty when there is none.
  pub fn icc(&self) -> &[u8] {
    // SAFETY: `image` lives until drop, and libavif owns `icc.data`.
    let icc = unsafe { &(*self.image).icc };
    if icc.data.is_null() || icc.size == 0 {
      &[]
    } else {
      unsafe { slice::from_raw_parts(icc.data, icc.size) }
    }
  }

  /// Whether the file has an alpha plane. Without one Chrome's frame is
  /// opaque, and drawImage shadows it through the draw looper.
  pub fn has_alpha(&self) -> bool {
    // SAFETY: `image` lives until drop.
    !unsafe { (*self.image).alphaPlane }.is_null()
  }

  pub fn decode_from(avif_bytes: &[u8]) -> result::Result<Self, AvifError> {
    /// Destroys the decoder on every return path.
    struct DecoderGuard(*mut sys::avifDecoder);
    impl Drop for DecoderGuard {
      fn drop(&mut self) {
        if !self.0.is_null() {
          unsafe { sys::avifDecoderDestroy(self.0) };
        }
      }
    }
    let decoder = DecoderGuard(unsafe { sys::avifDecoderCreate() });
    if decoder.0.is_null() {
      return Err(AvifError::Known(AvifErrorCode::OutOfMemory));
    }
    // From here on `this` owns the image: Drop frees it, also when a step
    // below fails.
    let mut this = Self {
      image: unsafe { sys::avifImageCreateEmpty() },
      width: 0,
      height: 0,
      row_bytes: 0,
      data: Vec::new(),
      color_primaries: 2,
      transfer_characteristics: 2,
      matrix_coefficients: 2,
      is_mono: false,
      origin: 1,
    };
    if this.image.is_null() {
      return Err(AvifError::Known(AvifErrorCode::OutOfMemory));
    }
    unsafe {
      AvifError::from_code(sys::avifDecoderReadMemory(
        decoder.0,
        this.image,
        avif_bytes.as_ptr(),
        avif_bytes.len(),
      ))?;
    }
    // SAFETY: libavif filled the image; its planes live until drop.
    let image = unsafe { &*this.image };
    this.data =
      avif_yuv::yuv_to_premultiplied_rgba(&unsafe { yuv_view(image) }?).map_err(|error| {
        AvifError::Known(match error {
          avif_yuv::YuvError::NotImplemented => AvifErrorCode::NotImplemented,
          avif_yuv::YuvError::ReformatFailed => AvifErrorCode::ReformatFailed,
          avif_yuv::YuvError::OutOfMemory => AvifErrorCode::OutOfMemory,
        })
      })?;
    this.width = image.width;
    this.height = image.height;
    this.row_bytes = image.width * 4;
    this.color_primaries = image.colorPrimaries;
    this.transfer_characteristics = image.transferCharacteristics;
    this.matrix_coefficients = image.matrixCoefficients;
    this.is_mono = image.yuvFormat == sys::AVIF_PIXEL_FORMAT_YUV400;
    // libavif keeps irot.angle within 0-3 and imir.axis within 0-1
    // (read.c avifParseImageRotationProperty / avifParseImageMirrorProperty).
    let angle = if image.transformFlags & sys::AVIF_TRANSFORM_IROT != 0 {
      image.irot.angle & 3
    } else {
      0
    };
    let axis = if image.transformFlags & sys::AVIF_TRANSFORM_IMIR != 0 {
      (image.imir.axis & 1) as i8
    } else {
      -1
    };
    this.origin = origin(angle, axis);
    Ok(this)
  }
}

/// Borrows the planes of a decoded libavif image.
///
/// # Safety
/// The plane pointers and row bytes must be libavif's for this image.
unsafe fn yuv_view(image: &sys::avifImage) -> result::Result<avif_yuv::YuvImage<'_>, AvifError> {
  let format = match image.yuvFormat {
    sys::AVIF_PIXEL_FORMAT_YUV444 => avif_yuv::PixelFormat::Yuv444,
    sys::AVIF_PIXEL_FORMAT_YUV422 => avif_yuv::PixelFormat::Yuv422,
    sys::AVIF_PIXEL_FORMAT_YUV420 => avif_yuv::PixelFormat::Yuv420,
    sys::AVIF_PIXEL_FORMAT_YUV400 => avif_yuv::PixelFormat::Yuv400,
    _ => return Err(AvifError::Known(AvifErrorCode::ReformatFailed)),
  };
  let (width, height) = (image.width as usize, image.height as usize);
  if width == 0 || height == 0 || image.yuvPlanes[0].is_null() {
    return Err(AvifError::Known(AvifErrorCode::ReformatFailed));
  }
  let sample_bytes = if image.depth > 8 { 2 } else { 1 };
  let plane = |data: *mut u8, row_bytes: u32, plane_width: usize, plane_height: usize| {
    let row_bytes = row_bytes as usize;
    if data.is_null() || row_bytes < plane_width * sample_bytes {
      return None;
    }
    // SAFETY: libavif allocates `row_bytes` for each row of the plane.
    Some(avif_yuv::Plane {
      data: unsafe { slice::from_raw_parts(data, row_bytes * plane_height) },
      row_bytes,
    })
  };
  let (shift_x, shift_y) = match format {
    avif_yuv::PixelFormat::Yuv420 => (1, 1),
    avif_yuv::PixelFormat::Yuv422 => (1, 0),
    _ => (0, 0),
  };
  let (chroma_width, chroma_height) = ((width + shift_x) >> shift_x, (height + shift_y) >> shift_y);
  let y = plane(image.yuvPlanes[0], image.yuvRowBytes[0], width, height)
    .ok_or(AvifError::Known(AvifErrorCode::ReformatFailed))?;
  let (u, v) = if format == avif_yuv::PixelFormat::Yuv400 {
    (None, None)
  } else {
    (
      plane(
        image.yuvPlanes[1],
        image.yuvRowBytes[1],
        chroma_width,
        chroma_height,
      ),
      plane(
        image.yuvPlanes[2],
        image.yuvRowBytes[2],
        chroma_width,
        chroma_height,
      ),
    )
  };
  if format != avif_yuv::PixelFormat::Yuv400 && (u.is_none() || v.is_none()) {
    return Err(AvifError::Known(AvifErrorCode::ReformatFailed));
  }
  Ok(avif_yuv::YuvImage {
    width,
    height,
    depth: image.depth,
    format,
    full_range: image.yuvRange == sys::AVIF_RANGE_FULL,
    chroma_sample_position: image.yuvChromaSamplePosition,
    color_primaries: image.colorPrimaries,
    matrix_coefficients: image.matrixCoefficients,
    alpha_premultiplied: image.alphaPremultiplied != 0,
    y,
    u,
    v,
    a: plane(image.alphaPlane, image.alphaRowBytes, width, height),
  })
}

impl Drop for AvifImage {
  fn drop(&mut self) {
    // A failed decode_from can leave a null image.
    if !self.image.is_null() {
      unsafe { sys::avifImageDestroy(self.image) };
    }
  }
}
