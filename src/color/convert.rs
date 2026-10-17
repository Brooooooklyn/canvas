//! Color space math, ported from Chromium in f32 like Chrome computes it:
//! ui/gfx/color_conversions.cc and skia/ext/skcms_ext.cc. The matrices,
//! transfer functions and the two skcms routines Blink calls directly come
//! from our Skia through FFI, so every constant is bit-identical with
//! Chrome's Skia.
//!
//! Chromium builds with -ffp-contract=off and Rust never fuses a multiply
//! and an add, so plain f32 arithmetic in the same order gives the same bits.

use std::sync::OnceLock;

use crate::sk;

pub(crate) type Vec3 = [f32; 3];
/// skcms_Matrix3x3, row major.
pub(crate) type Mat3 = [f32; 9];
/// skcms_TransferFunction: g, a, b, c, d, e, f.
pub(crate) type TransferFn = [f32; 7];

/// The predefined color spaces of `skiac_color_space_params` (skia_c.cpp).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Predefined {
  Srgb = 0,
  SrgbLinear = 1,
  DisplayP3 = 2,
  DisplayP3Linear = 3,
  A98Rgb = 4,
  ProPhotoRgb = 5,
  Rec2020 = 6,
  XyzD50 = 7,
  XyzD65 = 8,
}

/// Blink's GetSkColorSpaceParams (color.cc:166-224).
pub(crate) fn color_space_params(space: Predefined) -> &'static (Mat3, TransferFn) {
  static PARAMS: OnceLock<[(Mat3, TransferFn); 9]> = OnceLock::new();
  &PARAMS.get_or_init(|| {
    std::array::from_fn(|i| {
      sk::color_space_params(i as i32).expect("Skia knows every predefined color space")
    })
  })[space as usize]
}

/// std::min(a, b): `(b < a) ? b : a`, which keeps `a` when either is NaN.
fn cpp_min(a: f32, b: f32) -> f32 {
  if b < a { b } else { a }
}

/// std::max(a, b): `(a < b) ? b : a`.
fn cpp_max(a: f32, b: f32) -> f32 {
  if a < b { b } else { a }
}

/// std::min({a, b, c}): the first smallest.
fn cpp_min3(a: f32, b: f32, c: f32) -> f32 {
  cpp_min(cpp_min(a, b), c)
}

/// std::max({a, b, c}): the first largest.
fn cpp_max3(a: f32, b: f32, c: f32) -> f32 {
  cpp_max(cpp_max(a, b), c)
}

/// skcms::Matrix3x3_apply (skcms_ext.cc).
pub(crate) fn matrix_apply(m: &Mat3, v: Vec3) -> Vec3 {
  [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

fn identity() -> &'static Mat3 {
  &color_space_params(Predefined::XyzD50).0
}

fn linear() -> &'static TransferFn {
  &color_space_params(Predefined::SrgbLinear).1
}

/// skcms::Matrix3x3_apply_inverse: the identity (SkNamedGamut::kXYZ) is
/// returned as is, anything else goes through skcms_Matrix3x3_invert.
pub(crate) fn matrix_apply_inverse(m: &Mat3, v: Vec3) -> Vec3 {
  if m == identity() {
    return v;
  }
  let inverse = sk::skcms_matrix3x3_invert(m).expect("Blink CHECKs that the matrix inverts");
  matrix_apply(&inverse, v)
}

/// skcms::TransferFunction_eval (skcms_ext.cc), with std::pow.
fn transfer_eval(t: &TransferFn, x: f32) -> f32 {
  let [g, a, b, c, d, e, f] = *t;
  let sign = if x < 0.0 { -1.0f32 } else { 1.0 };
  let abs_x = x.abs();
  if abs_x <= d {
    return sign * (c * abs_x + f);
  }
  let base = cpp_max(a * abs_x + b, 0.0);
  if g == 1.0 {
    return sign * (base + e);
  }
  sign * (base.powf(g) + e)
}

/// skcms::TransferFunction_invert (skcms_ext.cc), with std::pow.
fn transfer_invert(src: &TransferFn) -> Option<TransferFn> {
  let [sg, sa, sb, sc, sd, se, sf] = *src;
  // inv = {g, a, b, c, d, e, f}
  let mut inv = [0.0f32; 7];
  let d_l = sc * sd + sf;
  let d_r = (sa * sd + sb).powf(sg) + se;
  if (d_l - d_r).abs() > 1.0 / 512.0 {
    return None;
  }
  inv[4] = d_l;
  if inv[4] > 0.0 {
    inv[3] = 1.0 / sc;
    inv[6] = -sf / sc;
  }
  let k = sa.powf(-sg);
  inv[0] = 1.0 / sg;
  inv[1] = k;
  inv[2] = -k * se;
  inv[5] = -sb / sa;
  if inv[1] < 0.0 {
    return None;
  }
  if inv[1] * inv[4] + inv[2] < 0.0 {
    inv[2] = -inv[1] * inv[4];
  }
  let mut s = transfer_eval(src, 1.0);
  if !s.is_finite() {
    return None;
  }
  let sign = if s < 0.0 { -1.0f32 } else { 1.0 };
  s *= sign;
  if s < inv[4] {
    inv[6] = 1.0 - sign * inv[3] * s;
  } else {
    inv[5] = 1.0 - sign * (inv[1] * s + inv[2]).powf(inv[0]);
  }
  Some(inv)
}

/// skcms::TransferFunction_apply.
pub(crate) fn transfer_apply(t: &TransferFn, v: Vec3) -> Vec3 {
  v.map(|x| transfer_eval(t, x))
}

/// skcms::TransferFunction_apply_inverse: the linear function is returned as
/// is, anything else is inverted with the skcms_ext formulas.
pub(crate) fn transfer_apply_inverse(t: &TransferFn, v: Vec3) -> Vec3 {
  if t == linear() {
    return v;
  }
  let inverse = transfer_invert(t).expect("Blink CHECKs that the transfer function inverts");
  transfer_apply(&inverse, v)
}

/// Color::ToSRGB for kSRGBLinear (color.cc:581-590): the real skcms
/// approximations, not the skcms_ext ones.
pub(crate) fn srgb_linear_to_srgb(v: Vec3) -> Vec3 {
  static INVERSE: OnceLock<TransferFn> = OnceLock::new();
  let inverse = INVERSE.get_or_init(|| {
    sk::skcms_transfer_fn_invert(&color_space_params(Predefined::Srgb).1)
      .expect("the sRGB transfer function inverts")
  });
  v.map(|x| sk::skcms_transfer_fn_eval(inverse, x))
}

const D50: Vec3 = [0.9642, 1.0, 0.8251];

// The literals of color_conversions.cc, so they round to the same f32.
#[allow(clippy::excessive_precision)]
const XYZD65_TO_LMS: Mat3 = [
  0.8190224432164319,
  0.3619062562801221,
  -0.12887378261216414,
  0.0329836671980271,
  0.9292868468965546,
  0.03614466816999844,
  0.048177199566046255,
  0.26423952494422764,
  0.6335478258136937,
];

#[allow(clippy::excessive_precision)]
const OKLAB_TO_LMS: Mat3 = [
  0.99999999845051981432,
  0.39633779217376785678,
  0.21580375806075880339,
  1.0000000088817607767,
  -0.1055613423236563494,
  -0.063854174771705903402,
  1.0000000546724109177,
  -0.089484182094965759684,
  -1.2914855378640917399,
];

fn d65_to_d50() -> &'static Mat3 {
  &color_space_params(Predefined::XyzD65).0
}

pub(crate) fn lab_to_xyz_d50(l: f32, a: f32, b: f32) -> Vec3 {
  let mut y = (l + 16.0) / 116.0;
  let mut x = y + a / 500.0;
  let mut z = y - b / 200.0;
  let inverse = |t: f32| {
    const DELTA: f32 = 24.0 / 116.0;
    if t <= DELTA {
      return (108.0 / 841.0) * (t - (16.0 / 116.0));
    }
    t * t * t
  };
  x = inverse(x) * D50[0];
  y = inverse(y) * D50[1];
  z = inverse(z) * D50[2];
  [x, y, z]
}

pub(crate) fn xyz_d50_to_lab(x: f32, y: f32, z: f32) -> Vec3 {
  let transfer = |t: f32| {
    const DELTA_LIMIT: f32 = (24.0 / 116.0) * (24.0 / 116.0) * (24.0 / 116.0);
    if t <= DELTA_LIMIT {
      (841.0 / 108.0) * t + (16.0 / 116.0)
    } else {
      t.powf(1.0 / 3.0)
    }
  };
  let x = transfer(x / D50[0]);
  let y = transfer(y / D50[1]);
  let z = transfer(z / D50[2]);
  [116.0 * y - 16.0, 500.0 * (x - y), 200.0 * (y - z)]
}

/// OklabToXYZD50 without gamut mapping (kBakedGamutMapping is off,
/// features.cc).
pub(crate) fn oklab_to_xyz_d50(l: f32, a: f32, b: f32) -> Vec3 {
  let lms = matrix_apply(&OKLAB_TO_LMS, [l, a, b]);
  let cubed = lms.map(|v| v * v * v);
  let xyz_d65 = matrix_apply_inverse(&XYZD65_TO_LMS, cubed);
  matrix_apply(d65_to_d50(), xyz_d65)
}

fn pow_ext(x: f32, p: f32) -> f32 {
  if x < 0.0 { -(-x).powf(p) } else { x.powf(p) }
}

pub(crate) fn xyz_d50_to_oklab(x: f32, y: f32, z: f32) -> Vec3 {
  let xyz_d65 = matrix_apply_inverse(d65_to_d50(), [x, y, z]);
  let lms_cubed = matrix_apply(&XYZD65_TO_LMS, xyz_d65);
  let lms = lms_cubed.map(|v| pow_ext(v, 1.0 / 3.0));
  matrix_apply_inverse(&OKLAB_TO_LMS, lms)
}

/// base::DegToRad for float: `deg * pi / 180`.
fn deg_to_rad(deg: f32) -> f32 {
  deg * std::f32::consts::PI / 180.0
}

/// base::RadToDeg for float: `rad * 180 / pi`.
fn rad_to_deg(rad: f32) -> f32 {
  rad * 180.0 / std::f32::consts::PI
}

pub(crate) fn lch_to_lab(l: f32, c: f32, h: f32) -> Vec3 {
  [l, c * deg_to_rad(h).cos(), c * deg_to_rad(h).sin()]
}

pub(crate) fn lab_to_lch(l: f32, a: f32, b: f32) -> Vec3 {
  [l, (a * a + b * b).sqrt(), rad_to_deg(b.atan2(a))]
}

/// `r * 255.0` in double.
pub(crate) fn srgb_to_srgb_legacy(r: f32, g: f32, b: f32) -> Vec3 {
  [r, g, b].map(|v| (v as f64 * 255.0) as f32)
}

/// `r / 255.0` in double (color_conversions.cc:278-280).
pub(crate) fn srgb_legacy_to_srgb(r: f32, g: f32, b: f32) -> Vec3 {
  [r, g, b].map(|v| (v as f64 / 255.0) as f32)
}

pub(crate) fn xyz_d50_to_srgb(x: f32, y: f32, z: f32) -> Vec3 {
  let (m, t) = color_space_params(Predefined::Srgb);
  let c = matrix_apply_inverse(m, [x, y, z]);
  transfer_apply_inverse(t, c)
}

pub(crate) fn srgb_to_xyz_d50(r: f32, g: f32, b: f32) -> Vec3 {
  let (m, t) = color_space_params(Predefined::Srgb);
  let c = transfer_apply(t, [r, g, b]);
  matrix_apply(m, c)
}

pub(crate) fn hsl_to_srgb(h: f32, s: f32, l: f32) -> Vec3 {
  if s == 0.0 {
    return [l, l, l];
  }
  let f = |n: f32| {
    // fmod(float, 12.0) runs in double.
    let k = ((n + h / 30.0) as f64 % 12.0) as f32;
    let a = s * cpp_min(l, 1.0 - l);
    l - a * cpp_max(-1.0, cpp_min3(k - 3.0, 9.0 - k, 1.0))
  };
  [f(0.0), f(8.0), f(4.0)]
}

/// std::minmax({r, g, b}): the first smallest and the last largest.
fn minmax3(r: f32, g: f32, b: f32) -> (f32, f32) {
  let mut min = r;
  let mut max = r;
  for v in [g, b] {
    if v < min {
      min = v;
    }
    // `!(v < max)`: a NaN also replaces the maximum.
    if v.partial_cmp(&max) != Some(std::cmp::Ordering::Less) {
      max = v;
    }
  }
  (min, max)
}

/// std::midpoint for floats in the range colors use: `(a + b) / 2`.
fn midpoint(a: f32, b: f32) -> f32 {
  const LO: f32 = f32::MIN_POSITIVE * 2.0;
  const HI: f32 = f32::MAX / 2.0;
  if a.abs() <= HI && b.abs() <= HI {
    (a + b) / 2.0
  } else if a.abs() < LO {
    a + b / 2.0
  } else if b.abs() < LO {
    a / 2.0 + b
  } else {
    a / 2.0 + b / 2.0
  }
}

pub(crate) fn srgb_to_hsl(r: f32, g: f32, b: f32) -> Vec3 {
  let (min, max) = minmax3(r, g, b);
  let mut hue = 0.0f32;
  let mut saturation = 0.0f32;
  let lightness = midpoint(min, max);
  let d = max - min;
  if d != 0.0 {
    saturation = if lightness == 0.0 || lightness == 1.0 {
      0.0
    } else {
      (max - lightness) / cpp_min(lightness, 1.0 - lightness)
    };
    if max == r {
      hue = (g - b) / d + if g < b { 6.0 } else { 0.0 };
    } else if max == g {
      hue = (b - r) / d + 2.0;
    } else {
      hue = (r - g) / d + 4.0;
    }
    hue *= 60.0;
  }
  if saturation < 0.0 {
    hue += 180.0;
    saturation = saturation.abs();
  }
  if hue >= 360.0 {
    hue -= 360.0;
  }
  [hue, saturation, lightness]
}

pub(crate) fn hwb_to_srgb(h: f32, w: f32, b: f32) -> Vec3 {
  if w + b >= 1.0 {
    let gray = w / (w + b);
    return [gray, gray, gray];
  }
  let [mut red, mut green, mut blue] = hsl_to_srgb(h, 1.0, 0.5);
  red += w - (w + b) * red;
  green += w - (w + b) * green;
  blue += w - (w + b) * blue;
  [red, green, blue]
}

fn srgb_to_hue(r: f32, g: f32, b: f32) -> f32 {
  let (min, max) = minmax3(r, g, b);
  let mut hue = 0.0f32;
  let d = max - min;
  if d != 0.0 {
    if max == r {
      hue = (g - b) / d + if g < b { 6.0 } else { 0.0 };
    } else if max == g {
      hue = (b - r) / d + 2.0;
    } else {
      hue = (r - g) / d + 4.0;
    }
    hue *= 60.0;
  }
  if hue >= 360.0 {
    hue -= 360.0;
  }
  hue
}

pub(crate) fn srgb_to_hwb(r: f32, g: f32, b: f32) -> Vec3 {
  let hue = srgb_to_hue(r, g, b);
  let white = cpp_min3(r, g, b);
  let black = 1.0 - cpp_max3(r, g, b);
  [hue, white, black]
}

#[cfg(test)]
mod tests {
  use super::*;

  fn close(a: Vec3, b: Vec3, eps: f32) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() <= eps)
  }

  /// ui/gfx/color_conversions_unittest.cc expectations.
  #[test]
  fn gfx_conversions_match_chromium_tests() {
    // HSLToSRGB / SRGBToHSL round trips.
    assert!(close(hsl_to_srgb(120.0, 1.0, 0.5), [0.0, 1.0, 0.0], 1e-6));
    assert!(close(hsl_to_srgb(0.0, 0.0, 0.25), [0.25, 0.25, 0.25], 0.0));
    assert!(close(srgb_to_hsl(1.0, 0.0, 0.0), [0.0, 1.0, 0.5], 1e-6));
    assert!(close(hwb_to_srgb(0.0, 0.6, 0.6), [0.5, 0.5, 0.5], 1e-6));
    // Lab white point.
    let xyz = lab_to_xyz_d50(100.0, 0.0, 0.0);
    assert!(close(xyz, D50, 1e-4));
    let lab = xyz_d50_to_lab(D50[0], D50[1], D50[2]);
    assert!(close(lab, [100.0, 0.0, 0.0], 1e-3));
    // Oklab white.
    let srgb = {
      let [x, y, z] = oklab_to_xyz_d50(1.0, 0.0, 0.0);
      xyz_d50_to_srgb(x, y, z)
    };
    // Blink's f32 matrices miss white by about 1e-4.
    assert!(close(srgb, [1.0, 1.0, 1.0], 2e-4), "{srgb:?}");
  }

  #[test]
  fn srgb_round_trips_through_xyz() {
    for v in [[0.2f32, 0.5, 0.8], [1.0, 0.0, 0.0], [0.0, 0.0, 0.0]] {
      let [x, y, z] = srgb_to_xyz_d50(v[0], v[1], v[2]);
      assert!(close(xyz_d50_to_srgb(x, y, z), v, 1e-5));
    }
  }
}
