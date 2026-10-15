use std::{ptr, result, slice};

use libavif::YuvFormat;
use libavif_sys as sys;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::error::SkError;
use crate::sk::ColorSpace;

#[napi(object)]
#[derive(Default, Clone)]
pub struct AvifConfig {
  /// 0-100 scale, 100 is the best quality. It is near-lossless, not lossless:
  /// the pixels are converted to 8-bit YUV (BT.601) first, which can change a
  /// channel by 1, and more with chroma subsampling.
  pub quality: Option<u32>,
  /// 0-100 scale
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
      alpha_quality: config.alpha_quality.unwrap_or(90).min(100) as u8,
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
    image.matrixCoefficients = sys::AVIF_MATRIX_COEFFICIENTS_BT601 as u16;
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
  rgb_image: sys::avifRGBImage,
  pub width: u32,
  pub height: u32,
  pub row_bytes: u32,
  pub data: *mut u8,
  /// CICP colour primaries and transfer characteristics; 2 is unspecified.
  pub color_primaries: u16,
  pub transfer_characteristics: u16,
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
    // From here on `this` owns the image and the RGB pixels: Drop frees them,
    // also when a step below fails.
    let mut this = Self {
      image: unsafe { sys::avifImageCreateEmpty() },
      rgb_image: sys::avifRGBImage::default(),
      width: 0,
      height: 0,
      row_bytes: 0,
      data: ptr::null_mut(),
      color_primaries: 2,
      transfer_characteristics: 2,
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
      sys::avifRGBImageSetDefaults(&mut this.rgb_image, this.image);
      this.rgb_image.format = sys::AVIF_RGB_FORMAT_RGBA;
      this.rgb_image.depth = 8;
      AvifError::from_code(sys::avifRGBImageAllocatePixels(&mut this.rgb_image))?;
      AvifError::from_code(sys::avifImageYUVToRGB(this.image, &mut this.rgb_image))?;
      let image = &*this.image;
      this.width = image.width;
      this.height = image.height;
      this.data = this.rgb_image.pixels;
      this.row_bytes = this.rgb_image.rowBytes;
      this.color_primaries = image.colorPrimaries;
      this.transfer_characteristics = image.transferCharacteristics;
    }
    Ok(this)
  }
}

impl Drop for AvifImage {
  fn drop(&mut self) {
    unsafe {
      // A failed decode_from leaves null pixels (which this accepts), or a
      // null image.
      sys::avifRGBImageFreePixels(&mut self.rgb_image);
      if !self.image.is_null() {
        sys::avifImageDestroy(self.image);
      }
    }
  }
}
