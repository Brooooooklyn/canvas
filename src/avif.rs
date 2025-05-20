use std::result;

use libavif::{AvifData, RgbPixels, YuvFormat};
use libavif_sys as sys;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::error::SkError;

#[napi(object)]
#[derive(Default, Clone)]
pub struct AvifConfig {
  /// 0-100 scale, 100 is lossless
  pub quality: Option<u32>,
  /// 0-100 scale
  pub alpha_quality: Option<u32>,
  /// rav1e preset 1 (slow) 10 (fast but crappy), default is 4
  pub speed: Option<u32>,
  /// How many threads should be used (0 = match core count)
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
      quality: config.quality.unwrap_or(80) as u8,
      // Calculate alphaQuality, this is consistent with cavif.
      // https://github.com/kornelski/cavif-rs/blob/37847b95bb81d4cf90e36b7fab2c7fbbcf95abe2/src/main.rs#L97
      alpha_quality: config.alpha_quality.unwrap_or(90) as u8,
      // Encoding speed between 1 (best, but slowest) and 10 (fastest, but a blurry mess), the default value is 4.
      // Speeds 1 and 2 are unbelievably slow, but make files ~3-5% smaller.
      // Speeds 7 and above degrade compression significantly, and are not recommended.
      speed: config.speed.unwrap_or(5) as u8,
      threads: config
        .threads
        .map(|n| n as usize)
        .unwrap_or_else(num_cpus::get),
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

pub(crate) fn encode(
  avif_image: &[u8],
  width: u32,
  height: u32,
  config: &Config,
) -> result::Result<AvifData<'static>, SkError> {
  let rgb = RgbPixels::new(width, height, avif_image).map_err(SkError::PixelsToRgb)?;
  let image = rgb.to_image(config.chroma_subsampling.into());
  let mut encoder = libavif::Encoder::new();
  encoder.set_quality((63.0 * (1.0 - config.quality as f32 / 100.0)) as u8);
  encoder.set_alpha_quality((63.0 * (1.0 - config.alpha_quality as f32 / 100.0)) as u8);
  encoder.set_speed(config.speed);
  encoder.set_max_threads(config.threads);
  encoder.encode(&image).map_err(SkError::EncodeAvifError)
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
      AvifError::Known(code) => write!(f, "AvifError: {:?}", code),
      AvifError::Unknown(code) => write!(f, "AvifError: {}", code),
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
}

impl AvifImage {
  pub fn decode_from(avif_bytes: &[u8]) -> result::Result<Self, AvifError> {
    let decoder = unsafe { sys::avifDecoderCreate() };
    let image = unsafe { sys::avifImageCreateEmpty() };
    AvifError::from_code(unsafe {
      sys::avifDecoderReadMemory(decoder, image, avif_bytes.as_ptr(), avif_bytes.len())
    })?;

    unsafe {
      sys::avifDecoderDestroy(decoder);
    }
    let mut rgb_image = sys::avifRGBImage::default();
    unsafe {
      sys::avifRGBImageSetDefaults(&mut rgb_image, image);
      rgb_image.format = sys::AVIF_RGB_FORMAT_RGBA;
      rgb_image.depth = 8;
      AvifError::from_code(sys::avifRGBImageAllocatePixels(&mut rgb_image))?;
      AvifError::from_code(sys::avifImageYUVToRGB(image, &mut rgb_image))?;
    };
    Ok(Self {
      image,
      width: unsafe { (*image).width },
      height: unsafe { (*image).height },
      data: rgb_image.pixels,
      row_bytes: rgb_image.rowBytes,
      rgb_image,
    })
  }
}

impl Drop for AvifImage {
  fn drop(&mut self) {
    unsafe {
      sys::avifRGBImageFreePixels(&mut self.rgb_image);
      sys::avifImageDestroy(self.image);
    }
  }
}
