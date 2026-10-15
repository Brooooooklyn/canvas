//! AVIF YUV to RGB, exactly as Chrome 155 does it.
//!
//! Chrome decodes AVIF with CrabbyAvif (third_party/crabbyavif, revision
//! 3da6b895 in Chrome 155's DEPS) into 8-bit RGBA with premultiplied alpha
//! (avif_image_decoder.cc RenderImage: `alphaPremultiplied = true`, automatic
//! chroma upsampling). CrabbyAvif's `rgb::Image::convert_from_yuv`
//! (src/reformat/rgb.rs) tries libyuv first (src/reformat/libyuv.rs, libyuv
//! 2dd42573) and falls back to its own float code (src/reformat/rgb_impl.rs).
//! This file follows both: libyuv's C reference rows (row_common.cc YuvPixel*,
//! scale_common.cc ScaleRowUp2_*, scale_any.cc for the row edges,
//! convert_argb.cc for the row order) and rgb_impl's f32 math. Rust computes
//! f32 one operation at a time (no FMA), as CrabbyAvif does, so the result is
//! the same on arm64 and x86_64, as in Chrome.
//!
//! libavif (which we keep for the container and the AV1 decode) gives the
//! same YUV planes as CrabbyAvif: AV1 decoding is exact, and both turn a
//! limited-range alpha plane into a full-range one.

use std::cmp::min;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum YuvError {
  /// CrabbyAvif's `AvifError::NotImplemented`: Chrome fails the decode.
  NotImplemented,
  /// CrabbyAvif's `AvifError::ReformatFailed`.
  ReformatFailed,
  OutOfMemory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PixelFormat {
  Yuv444,
  Yuv422,
  Yuv420,
  Yuv400,
}

impl PixelFormat {
  fn shift_x(self) -> usize {
    match self {
      PixelFormat::Yuv422 | PixelFormat::Yuv420 => 1,
      PixelFormat::Yuv444 | PixelFormat::Yuv400 => 0,
    }
  }

  fn shift_y(self) -> usize {
    match self {
      PixelFormat::Yuv420 => 1,
      _ => 0,
    }
  }
}

/// One plane: 8-bit samples, or native-endian u16 samples when the depth is
/// above 8 (libavif's layout).
#[derive(Clone, Copy)]
pub(crate) struct Plane<'a> {
  pub data: &'a [u8],
  pub row_bytes: usize,
}

pub(crate) struct YuvImage<'a> {
  pub width: usize,
  pub height: usize,
  pub depth: u32,
  pub format: PixelFormat,
  pub full_range: bool,
  /// AV1 chroma_sample_position; 0 is unknown, which CrabbyAvif takes as
  /// "center".
  pub chroma_sample_position: u32,
  pub color_primaries: u16,
  pub matrix_coefficients: u16,
  pub alpha_premultiplied: bool,
  pub y: Plane<'a>,
  pub u: Option<Plane<'a>>,
  pub v: Option<Plane<'a>>,
  pub a: Option<Plane<'a>>,
}

impl YuvImage<'_> {
  fn max_channel(&self) -> u16 {
    ((1u32 << self.depth) - 1) as u16
  }

  #[inline]
  fn sample(&self, plane: &Plane, x: usize, y: usize) -> u16 {
    if self.depth > 8 {
      let at = y * plane.row_bytes + x * 2;
      u16::from_ne_bytes([plane.data[at], plane.data[at + 1]])
    } else {
      plane.data[y * plane.row_bytes + x] as u16
    }
  }

  fn chroma_width(&self) -> usize {
    (self.width + self.format.shift_x()) >> self.format.shift_x()
  }

  fn has_color(&self) -> bool {
    self.u.is_some() && self.v.is_some() && self.format != PixelFormat::Yuv400
  }
}

// CrabbyAvif's MatrixCoefficients::from(u16) and ColorPrimaries::from(u16):
// values it does not know are "unspecified" (2).
fn matrix_coefficients(value: u16) -> u16 {
  match value {
    0..=14 | 16 | 17 => value,
    _ => 2,
  }
}

fn color_primaries(value: u16) -> u16 {
  match value {
    0..=2 | 4..=12 | 22 => value,
    _ => 2,
  }
}

/// RGBA, 8 bits per channel, premultiplied by alpha, `width * 4` bytes a row.
pub(crate) fn yuv_to_premultiplied_rgba(image: &YuvImage) -> Result<Vec<u8>, YuvError> {
  // rgb.rs convert_from_yuv
  if !matches!(image.depth, 8 | 10 | 12 | 16) {
    return Err(YuvError::ReformatFailed);
  }
  let matrix = matrix_coefficients(image.matrix_coefficients);
  match matrix {
    // Reserved, BT.2020 CL, SMPTE 2085, chroma-derived CL, ICtCp.
    3 | 10 | 11 | 13 | 14 => return Err(YuvError::NotImplemented),
    8 if !image.full_range => return Err(YuvError::NotImplemented),
    16 | 17 => {
      let bit_offset = if matrix == 16 { 2 } else { 1 };
      if !image.full_range || image.depth - bit_offset != 8 {
        return Err(YuvError::NotImplemented);
      }
    }
    0 if !matches!(image.format, PixelFormat::Yuv444 | PixelFormat::Yuv400) => {
      return Err(YuvError::NotImplemented);
    }
    _ => {}
  }
  let size = image
    .width
    .checked_mul(image.height)
    .and_then(|n| n.checked_mul(4))
    .ok_or(YuvError::OutOfMemory)?;
  let mut rgba = Vec::new();
  rgba
    .try_reserve_exact(size)
    .map_err(|_| YuvError::OutOfMemory)?;
  rgba.resize(size, 0);

  let has_alpha = image.a.is_some();
  // The RGB image wants premultiplied alpha.
  let mut multiply = has_alpha && !image.alpha_premultiplied;
  let converted = libyuv_to_rgba(image, matrix, &mut rgba);
  if !converted.unwrap_or(false) {
    if has_alpha {
      import_alpha(image, &mut rgba);
    } else {
      // set_opaque
      for pixel in rgba.as_chunks_mut::<4>().0 {
        pixel[3] = 255;
      }
    }
  }
  if converted.is_none() {
    let fast = matches!(image.format, PixelFormat::Yuv444 | PixelFormat::Yuv400)
      && rgb_fast(image, matrix, &mut rgba);
    if !fast {
      rgb_any(image, matrix, multiply, &mut rgba)?;
      multiply = false;
    }
  }
  if multiply {
    // libyuv ARGBAttenuate
    for pixel in rgba.as_chunks_mut::<4>().0 {
      let a = pixel[3] as u32;
      for c in &mut pixel[..3] {
        *c = ((*c as u32 * a + 255) >> 8) as u8;
      }
    }
  }
  Ok(rgba)
}

// rgb::Image::import_alpha_from, into 8 bits.
fn import_alpha(image: &YuvImage, rgba: &mut [u8]) {
  let Some(a) = image.a else { return };
  let max_f = image.max_channel() as f32;
  for y in 0..image.height {
    for x in 0..image.width {
      let value = image.sample(&a, x, y);
      rgba[(y * image.width + x) * 4 + 3] = if image.depth == 8 {
        value as u8
      } else {
        // rescale_alpha_value
        let alpha_f = (value as f32) / max_f;
        min((0.5 + (alpha_f * 255.0)) as u16, 255) as u8
      };
    }
  }
}

// ---------------------------------------------------------------------------
// libyuv (reformat/libyuv.rs yuv_to_rgb, 8-bit RGBA output)

/// libyuv's YuvConstants in the C reference (x86) form.
struct Constants {
  yg: i32,
  yb: i32,
  ub: i32,
  ug: i32,
  vg: i32,
  vr: i32,
}

// row_common.cc MAKEYUVCONSTANTS (LIBYUV_UNLIMITED_DATA is not defined).
const I601: Constants = Constants {
  yg: 18997,
  yb: -1160,
  ub: 128,
  ug: 25,
  vg: 52,
  vr: 102,
};
const JPEG: Constants = Constants {
  yg: 16320,
  yb: 32,
  ub: 113,
  ug: 22,
  vg: 46,
  vr: 90,
};
const H709: Constants = Constants {
  yg: 18997,
  yb: -1160,
  ub: 128,
  ug: 14,
  vg: 34,
  vr: 115,
};
const F709: Constants = Constants {
  yg: 16320,
  yb: 32,
  ub: 119,
  ug: 12,
  vg: 30,
  vr: 101,
};
const U2020: Constants = Constants {
  yg: 19003,
  yb: -1160,
  ub: 128,
  ug: 12,
  vg: 42,
  vr: 107,
};
const V2020: Constants = Constants {
  yg: 16320,
  yb: 32,
  ub: 120,
  ug: 11,
  vg: 37,
  vr: 94,
};

// libyuv.rs find_constants
fn find_constants(image: &YuvImage, matrix: u16) -> Option<&'static Constants> {
  let matrix = if image.format == PixelFormat::Yuv400 && matrix == 0 {
    6
  } else {
    matrix
  };
  let primaries = color_primaries(image.color_primaries);
  if image.full_range {
    match matrix {
      1 => Some(&F709),
      2 | 5 | 6 => Some(&JPEG),
      9 => Some(&V2020),
      12 => match primaries {
        1 | 2 => Some(&F709),
        5 | 6 => Some(&JPEG),
        9 => Some(&V2020),
        _ => None,
      },
      _ => None,
    }
  } else {
    match matrix {
      1 => Some(&H709),
      2 | 5 | 6 => Some(&I601),
      9 => Some(&U2020),
      12 => match primaries {
        1 | 2 => Some(&H709),
        5 | 6 => Some(&I601),
        9 => Some(&U2020),
        _ => None,
      },
      _ => None,
    }
  }
}

#[inline]
fn clamp255(v: u32) -> u32 {
  min(v, 255)
}

#[inline]
fn clamp_u8(v: i32) -> u8 {
  v.clamp(0, 255) as u8
}

/// row_common.cc YuvPixel / YuvPixel10 / YuvPixel12 (CALC_RGB16): `y32` is
/// the luma scaled to 16 bits, `u` and `v` are 8-bit.
#[inline]
fn yuv_pixel(y32: u32, u: u32, v: u32, k: &Constants) -> [u8; 3] {
  let y1 = (y32.wrapping_mul(k.yg as u32) >> 16) as i32 + k.yb;
  let ui = u as i32 - 128;
  let vi = v as i32 - 128;
  let b16 = y1 + ui * k.ub;
  let g16 = y1 - (ui * k.ug + vi * k.vg);
  let r16 = y1 + vi * k.vr;
  [clamp_u8(r16 >> 6), clamp_u8(g16 >> 6), clamp_u8(b16 >> 6)]
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Row {
  /// 8-bit samples (downshifted when the depth is above 8): YuvPixel.
  Low,
  /// 10-bit samples: YuvPixel10, alpha `clamp255(a >> 2)`.
  High10,
  /// 12-bit samples: YuvPixel12.
  High12,
}

impl Row {
  #[inline]
  fn pixel(self, y: u16, u: u16, v: u16, k: &Constants) -> [u8; 3] {
    let (y, u, v) = (y as u32, u as u32, v as u32);
    match self {
      Row::Low => yuv_pixel(y * 0x0101, u, v, k),
      Row::High10 => yuv_pixel((y << 6) | (y >> 4), clamp255(u >> 2), clamp255(v >> 2), k),
      Row::High12 => yuv_pixel((y << 4) | (y >> 8), clamp255(u >> 4), clamp255(v >> 4), k),
    }
  }

  #[inline]
  fn alpha(self, a: u16) -> u8 {
    match self {
      Row::High10 => clamp255(a as u32 >> 2) as u8,
      _ => a as u8,
    }
  }
}

/// SUH2LANY(ScaleRowUp2_Linear_Any_C): 2x horizontal upsampling with the
/// edge pixels copied.
fn linear_up(src: &[u16], dst: &mut [u16]) {
  let width = dst.len();
  dst[0] = src[0];
  let work = (width - 1) & !1;
  for x in 0..work / 2 {
    let (s0, s1) = (src[x] as u32, src[x + 1] as u32);
    dst[1 + 2 * x] = ((s0 * 3 + s1 + 2) >> 2) as u16;
    dst[2 + 2 * x] = ((s0 + s1 * 3 + 2) >> 2) as u16;
  }
  dst[width - 1] = src[(width - 1) / 2];
}

/// SU2BLANY(ScaleRowUp2_Bilinear_Any_C): two output rows from two chroma
/// rows.
fn bilinear_up(sa: &[u16], sb: &[u16], da: &mut [u16], db: &mut [u16]) {
  let width = da.len();
  let edge = |a: u16, b: u16| ((3 * a as u32 + b as u32 + 2) >> 2) as u16;
  da[0] = edge(sa[0], sb[0]);
  db[0] = edge(sb[0], sa[0]);
  let work = (width - 1) & !1;
  for x in 0..work / 2 {
    let (s0, s1, t0, t1) = (
      sa[x] as u32,
      sa[x + 1] as u32,
      sb[x] as u32,
      sb[x + 1] as u32,
    );
    da[1 + 2 * x] = ((s0 * 9 + s1 * 3 + t0 * 3 + t1 + 8) >> 4) as u16;
    da[2 + 2 * x] = ((s0 * 3 + s1 * 9 + t0 + t1 * 3 + 8) >> 4) as u16;
    db[1 + 2 * x] = ((s0 * 3 + s1 + t0 * 9 + t1 * 3 + 8) >> 4) as u16;
    db[2 + 2 * x] = ((s0 + s1 * 3 + t0 * 3 + t1 * 9 + 8) >> 4) as u16;
  }
  let m = (width - 1) / 2;
  da[width - 1] = edge(sa[m], sb[m]);
  db[width - 1] = edge(sb[m], sa[m]);
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Function {
  /// I444/I410 (alpha) ToARGBMatrix, I422/I210 ...Linear,
  /// I420/I010 ...Bilinear.
  Yuv(Row),
  /// I012ToARGBMatrix: 12-bit 4:2:0 with nearest chroma.
  I012,
  /// I400ToARGBMatrix.
  I400,
}

/// libyuv.rs yuv_to_rgb: Some(alpha written) when libyuv converts the image,
/// None when CrabbyAvif falls back to rgb_impl.
fn libyuv_to_rgba(image: &YuvImage, matrix: u16, rgba: &mut [u8]) -> Option<bool> {
  let k = find_constants(image, matrix)?;
  let has_alpha = image.a.is_some();
  // find_conversion_function with RGBA output and automatic upsampling
  // (bilinear allowed, so the filter versions win).
  let (function, yuva) = match (image.depth, image.format) {
    (10, PixelFormat::Yuv444 | PixelFormat::Yuv422 | PixelFormat::Yuv420) => {
      (Function::Yuv(Row::High10), has_alpha)
    }
    (12, PixelFormat::Yuv420) => (Function::I012, false),
    (_, PixelFormat::Yuv400) => (Function::I400, false),
    _ => (Function::Yuv(Row::Low), has_alpha),
  };
  // downshift_to_8bit: Convert16To8Plane with scale 1 << (24 - depth).
  let downshift = matches!(function, Function::Yuv(Row::Low) | Function::I400) && image.depth > 8;
  let scale = 1u32 << (24 - image.depth.min(16));
  let read = |plane: &Plane, x: usize, y: usize| -> u16 {
    let value = image.sample(plane, x, y);
    if downshift {
      clamp255((value as u32 * scale) >> 16) as u16
    } else {
      value
    }
  };
  let (width, height) = (image.width, image.height);
  let alpha = if yuva { image.a } else { None };
  let write_row = |rgba: &mut [u8], y: usize, row: Row, u: &[u16], v: &[u16]| {
    let luma = &image.y;
    for x in 0..width {
      let at = (y * width + x) * 4;
      let rgb = row.pixel(read(luma, x, y), u[x], v[x], k);
      rgba[at..at + 3].copy_from_slice(&rgb);
      rgba[at + 3] = match &alpha {
        Some(a) => row.alpha(read(a, x, y)),
        None => 255,
      };
    }
  };
  match function {
    Function::I400 => {
      // YPixel is YuvPixel with no chroma.
      let gray = vec![128u16; width];
      for y in 0..height {
        write_row(rgba, y, Row::Low, &gray, &gray);
      }
    }
    Function::I012 => {
      let (u_plane, v_plane) = (image.u?, image.v?);
      let mut u = vec![0u16; width];
      let mut v = vec![0u16; width];
      for y in 0..height {
        for x in 0..width {
          u[x] = read(&u_plane, x >> 1, y >> 1);
          v[x] = read(&v_plane, x >> 1, y >> 1);
        }
        write_row(rgba, y, Row::High12, &u, &v);
      }
    }
    Function::Yuv(row) => {
      let (u_plane, v_plane) = (image.u?, image.v?);
      let chroma_width = image.chroma_width();
      let chroma_row = |plane: &Plane, y: usize| -> Vec<u16> {
        (0..chroma_width).map(|x| read(plane, x, y)).collect()
      };
      let mut u = vec![0u16; width];
      let mut v = vec![0u16; width];
      match image.format {
        PixelFormat::Yuv444 => {
          for y in 0..height {
            for x in 0..width {
              u[x] = read(&u_plane, x, y);
              v[x] = read(&v_plane, x, y);
            }
            write_row(rgba, y, row, &u, &v);
          }
        }
        PixelFormat::Yuv422 => {
          // I422ToARGBMatrixLinear
          for y in 0..height {
            linear_up(&chroma_row(&u_plane, y), &mut u);
            linear_up(&chroma_row(&v_plane, y), &mut v);
            write_row(rgba, y, row, &u, &v);
          }
        }
        PixelFormat::Yuv420 => {
          // I420ToARGBMatrixBilinear: the first row (and the last one when
          // the height is even) from one chroma row, the others in pairs
          // between two chroma rows.
          linear_up(&chroma_row(&u_plane, 0), &mut u);
          linear_up(&chroma_row(&v_plane, 0), &mut v);
          write_row(rgba, 0, row, &u, &v);
          let mut u2 = vec![0u16; width];
          let mut v2 = vec![0u16; width];
          let mut chroma_y = 0;
          let mut y = 1;
          while y + 1 < height {
            bilinear_up(
              &chroma_row(&u_plane, chroma_y),
              &chroma_row(&u_plane, chroma_y + 1),
              &mut u,
              &mut u2,
            );
            bilinear_up(
              &chroma_row(&v_plane, chroma_y),
              &chroma_row(&v_plane, chroma_y + 1),
              &mut v,
              &mut v2,
            );
            write_row(rgba, y, row, &u, &v);
            write_row(rgba, y + 1, row, &u2, &v2);
            chroma_y += 1;
            y += 2;
          }
          if height & 1 == 0 && height > 1 {
            linear_up(&chroma_row(&u_plane, chroma_y), &mut u);
            linear_up(&chroma_row(&v_plane, chroma_y), &mut v);
            write_row(rgba, height - 1, row, &u, &v);
          }
        }
        PixelFormat::Yuv400 => unreachable!("4:0:0 uses I400ToARGBMatrix"),
      }
    }
  }
  Some(!has_alpha || yuva)
}

// ---------------------------------------------------------------------------
// rgb_impl.rs (CrabbyAvif's own conversion, 8-bit RGBA output)

#[derive(Clone, Copy, PartialEq)]
enum Mode {
  YuvCoefficients(f32, f32, f32),
  Identity,
  Ycgco,
  YcgcoRe,
  YcgcoRo,
}

// coeffs.rs
fn expand_coeffs(y: f32, v: f32) -> [f32; 3] {
  [y, 1.0 - y - v, v]
}

fn primaries_y_coeffs(primaries: u16) -> [f32; 3] {
  match primaries {
    4 => expand_coeffs(0.299, 0.1146),
    5 => expand_coeffs(0.222, 0.0713),
    6 | 7 => expand_coeffs(0.212, 0.087),
    8 => expand_coeffs(0.2536, 0.06808),
    9 => expand_coeffs(0.2627, 0.0593),
    10 => expand_coeffs(0.0, 0.0),
    11 => expand_coeffs(0.2095, 0.0689),
    12 => expand_coeffs(0.229, 0.0793),
    22 => expand_coeffs(0.2318, 0.096),
    // Unknown, sRGB, unspecified.
    _ => expand_coeffs(0.2126, 0.0722),
  }
}

fn yuv_coefficients_from_cicp(primaries: u16, matrix: u16) -> Option<[f32; 3]> {
  match matrix {
    12 => Some(primaries_y_coeffs(primaries)),
    1 => Some(expand_coeffs(0.2126, 0.0722)),
    4 => Some(expand_coeffs(0.30, 0.11)),
    5 | 6 => Some(expand_coeffs(0.299, 0.114)),
    7 => Some(expand_coeffs(0.212, 0.087)),
    9 => Some(expand_coeffs(0.2627, 0.0593)),
    _ => None,
  }
}

fn mode(image: &YuvImage, matrix: u16) -> Mode {
  match matrix {
    0 => Mode::Identity,
    8 => Mode::Ycgco,
    16 => Mode::YcgcoRe,
    17 => Mode::YcgcoRo,
    _ => {
      let primaries = color_primaries(image.color_primaries);
      // Known coefficients, else BT.601.
      let [kr, kg, kb] = yuv_coefficients_from_cicp(primaries, matrix)
        .unwrap_or_else(|| expand_coeffs(0.299, 0.114));
      Mode::YuvCoefficients(kr, kg, kb)
    }
  }
}

// unorm_lookup_tables (bias_and_range_y / bias_and_range_uv)
fn lookup_tables(image: &YuvImage, mode: Mode) -> (Vec<f32>, Vec<f32>) {
  let count = 1usize << image.depth;
  let shift = image.depth - 8;
  let max_f = image.max_channel() as f32;
  let (bias_y, range_y) = if image.full_range {
    (0.0, max_f)
  } else {
    ((16u32 << shift) as f32, (219u32 << shift) as f32)
  };
  let table_y: Vec<f32> = (0..count)
    .map(|cp| ((cp as f32) - bias_y) / range_y)
    .collect();
  if mode == Mode::Identity {
    return (table_y.clone(), table_y);
  }
  let bias_uv = (1u32 << (image.depth - 1)) as f32;
  let range_uv = if image.full_range {
    max_f
  } else {
    (224u32 << shift) as f32
  };
  let table_uv = (0..count)
    .map(|cp| ((cp as f32) - bias_uv) / range_uv)
    .collect();
  (table_y, table_uv)
}

/// clamp_f32(v, 0.0, 1.0) in internal_utils.
#[inline]
fn clamp_f32(v: f32) -> f32 {
  v.clamp(0.0, 1.0)
}

#[inline]
fn store(c: f32) -> u8 {
  (0.5 + (c * 255.0)) as u8
}

#[inline]
fn coefficients_rgb(y: f32, cb: f32, cr: f32, kr: f32, kg: f32, kb: f32) -> [f32; 3] {
  let r = y + (2.0 * (1.0 - kr)) * cr;
  let b = y + (2.0 * (1.0 - kb)) * cb;
  let g = y - ((2.0 * ((kr * (1.0 - kr) * cr) + (kb * (1.0 - kb) * cb))) / kg);
  [clamp_f32(r), clamp_f32(g), clamp_f32(b)]
}

/// yuv_to_rgb_fast for 4:4:4 and 4:0:0; false when it has no fast path.
fn rgb_fast(image: &YuvImage, matrix: u16, rgba: &mut [u8]) -> bool {
  let (width, height) = (image.width, image.height);
  match mode(image, matrix) {
    Mode::Identity => {
      // identity_yuv8_to_rgb8_full_range
      if image.depth != 8 || !image.full_range || image.format != PixelFormat::Yuv444 {
        return false;
      }
      let (Some(u), Some(v)) = (image.u, image.v) else {
        return false;
      };
      for y in 0..height {
        for x in 0..width {
          let at = (y * width + x) * 4;
          rgba[at] = image.sample(&v, x, y) as u8;
          rgba[at + 1] = image.sample(&image.y, x, y) as u8;
          rgba[at + 2] = image.sample(&u, x, y) as u8;
        }
      }
      true
    }
    mode @ Mode::YuvCoefficients(kr, kg, kb) => {
      let (table_y, table_uv) = lookup_tables(image, mode);
      let max = image.max_channel();
      // The 8-bit functions index the tables directly; the 16-bit ones clamp
      // the sample to the max channel first.
      let index = |value: u16| -> usize {
        if image.depth == 8 {
          value as usize
        } else {
          min(value, max) as usize
        }
      };
      let has_color = image.format != PixelFormat::Yuv400;
      for y in 0..height {
        for x in 0..width {
          let at = (y * width + x) * 4;
          let luma = table_y[index(image.sample(&image.y, x, y))];
          if has_color {
            // yuv8_to_rgb8_color / yuv16_to_rgb8_color (4:4:4 here).
            let (Some(u), Some(v)) = (image.u, image.v) else {
              return false;
            };
            let cb = table_uv[index(image.sample(&u, x, y))];
            let cr = table_uv[index(image.sample(&v, x, y))];
            let [r, g, b] = coefficients_rgb(luma, cb, cr, kr, kg, kb);
            rgba[at] = store(r);
            rgba[at + 1] = store(g);
            rgba[at + 2] = store(b);
          } else {
            // yuv8_to_rgb8_monochrome / yuv16_to_rgb8_monochrome: not
            // clamped, `as u8` saturates.
            let gray = store(luma);
            rgba[at] = gray;
            rgba[at + 1] = gray;
            rgba[at + 2] = gray;
          }
        }
      }
      true
    }
    Mode::Ycgco | Mode::YcgcoRe | Mode::YcgcoRo => false,
  }
}

/// yuv_to_rgb_any (yuv8_to_rgb_any / yuv16_to_rgb_any).
fn rgb_any(image: &YuvImage, matrix: u16, multiply: bool, rgba: &mut [u8]) -> Result<(), YuvError> {
  let no_chroma_subsampling = image.format == PixelFormat::Yuv444;
  if !no_chroma_subsampling && image.chroma_sample_position != 0 {
    return Err(YuvError::NotImplemented);
  }
  let mode = mode(image, matrix);
  let (table_y, table_uv) = lookup_tables(image, mode);
  let (width, height) = (image.width, image.height);
  let max = image.max_channel();
  let max_f = max as f32;
  let high = image.depth > 8;
  let unorm = |table: &[f32], value: u16| -> f32 {
    table[if high { min(value, max) } else { value } as usize]
  };
  let has_color = image.has_color();
  let (shift_x, shift_y) = (image.format.shift_x(), image.format.shift_y());
  for j in 0..height {
    let uv_j = j >> shift_y;
    let uv_adj_j =
      if j == 0 || (j == height - 1 && j % 2 != 0) || image.format == PixelFormat::Yuv422 {
        uv_j
      } else if j % 2 != 0 {
        uv_j + 1
      } else {
        uv_j - 1
      };
    for i in 0..width {
      let clamped_y = if high {
        min(image.sample(&image.y, i, j), max)
      } else {
        image.sample(&image.y, i, j)
      };
      let y = table_y[clamped_y as usize];
      let mut cb = 0.5f32;
      let mut cr = 0.5f32;
      if has_color {
        let (Some(u), Some(v)) = (image.u, image.v) else {
          return Err(YuvError::ReformatFailed);
        };
        let uv_i = i >> shift_x;
        if no_chroma_subsampling {
          cb = unorm(&table_uv, image.sample(&u, uv_i, uv_j));
          cr = unorm(&table_uv, image.sample(&v, uv_i, uv_j));
        } else {
          // Bilinear filtering with weights (libavif reformat.c).
          let uv_adj_i = if i == 0 || (i == width - 1 && i % 2 != 0) {
            uv_i
          } else if i % 2 != 0 {
            uv_i + 1
          } else {
            uv_i - 1
          };
          let filter = |plane: &Plane| -> f32 {
            let s = [
              unorm(&table_uv, image.sample(plane, uv_i, uv_j)),
              unorm(&table_uv, image.sample(plane, uv_adj_i, uv_j)),
              unorm(&table_uv, image.sample(plane, uv_i, uv_adj_j)),
              unorm(&table_uv, image.sample(plane, uv_adj_i, uv_adj_j)),
            ];
            (s[0] * (9.0 / 16.0))
              + (s[1] * (3.0 / 16.0))
              + (s[2] * (3.0 / 16.0))
              + (s[3] * (1.0 / 16.0))
          };
          cb = filter(&u);
          cr = filter(&v);
        }
      }
      // compute_rgb
      let [mut rc, mut gc, mut bc] = if has_color {
        match mode {
          Mode::Identity => [clamp_f32(cr), clamp_f32(y), clamp_f32(cb)],
          Mode::Ycgco => {
            let t = y - cb;
            [clamp_f32(t + cr), clamp_f32(y + cb), clamp_f32(t - cr)]
          }
          Mode::YcgcoRe | Mode::YcgcoRo => {
            // Equations (62) through (65) in H.273.
            let cg = (0.5 + cb * max_f).floor() as i32;
            let co = (0.5 + cr * max_f).floor() as i32;
            let t = clamped_y as i32 - (cg >> 1);
            let g = (t + cg).clamp(0, 255) as f32 / 255.0;
            let tmp_b = (t - (co >> 1)).clamp(0, 255) as f32;
            let b = tmp_b / 255.0;
            let r = (tmp_b as i32 + co).clamp(0, 255) as f32 / 255.0;
            [clamp_f32(r), clamp_f32(g), clamp_f32(b)]
          }
          Mode::YuvCoefficients(kr, kg, kb) => coefficients_rgb(y, cb, cr, kr, kg, kb),
        }
      } else {
        let gray = clamp_f32(y);
        [gray, gray, gray]
      };
      if multiply {
        let Some(a) = image.a else {
          return Err(YuvError::ReformatFailed);
        };
        let unorm_a = if high {
          min(image.sample(&a, i, j), max)
        } else {
          image.sample(&a, i, j)
        };
        let ac = clamp_f32((unorm_a as f32) / max_f);
        if ac == 0.0 {
          rc = 0.0;
          gc = 0.0;
          bc = 0.0;
        } else if ac < 1.0 {
          rc *= ac;
          gc *= ac;
          bc *= ac;
        }
      }
      let at = (j * width + i) * 4;
      rgba[at] = store(rc);
      rgba[at + 1] = store(gc);
      rgba[at + 2] = store(bc);
    }
  }
  Ok(())
}
