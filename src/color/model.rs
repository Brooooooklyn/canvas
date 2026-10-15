//! blink::Color (third_party/blink/renderer/platform/graphics/color.{h,cc}):
//! a color space, three float parameters, a float alpha and the `none` flags.

use super::convert::{self, Predefined, Vec3};
use crate::sk::Color4f;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ColorSpace {
  Srgb,
  SrgbLinear,
  DisplayP3,
  DisplayP3Linear,
  A98Rgb,
  ProPhotoRgb,
  Rec2020,
  XyzD50,
  XyzD65,
  Lab,
  Oklab,
  Lch,
  Oklch,
  /// rgb(), hex and named colors: parameters in [0, 255].
  SrgbLegacy,
  Hsl,
  Hwb,
}

impl ColorSpace {
  fn predefined(self) -> Option<Predefined> {
    Some(match self {
      Self::Srgb => Predefined::Srgb,
      Self::SrgbLinear => Predefined::SrgbLinear,
      Self::DisplayP3 => Predefined::DisplayP3,
      Self::DisplayP3Linear => Predefined::DisplayP3Linear,
      Self::A98Rgb => Predefined::A98Rgb,
      Self::ProPhotoRgb => Predefined::ProPhotoRgb,
      Self::Rec2020 => Predefined::Rec2020,
      Self::XyzD50 => Predefined::XyzD50,
      Self::XyzD65 => Predefined::XyzD65,
      _ => return None,
    })
  }

  pub(crate) fn is_lightness_first(self) -> bool {
    matches!(self, Self::Lab | Self::Oklab | Self::Lch | Self::Oklch)
  }

  pub(crate) fn is_chroma_second(self) -> bool {
    matches!(self, Self::Lch | Self::Oklch)
  }

  pub(crate) fn is_legacy(self) -> bool {
    matches!(self, Self::SrgbLegacy | Self::Hsl | Self::Hwb)
  }

  /// Color::ColorSpaceToString (color.cc:951-990).
  pub(crate) fn name(self) -> &'static str {
    match self {
      Self::Srgb => "srgb",
      Self::SrgbLinear => "srgb-linear",
      Self::DisplayP3 => "display-p3",
      Self::DisplayP3Linear => "display-p3-linear",
      Self::A98Rgb => "a98-rgb",
      Self::ProPhotoRgb => "prophoto-rgb",
      Self::Rec2020 => "rec2020",
      Self::XyzD50 => "xyz-d50",
      Self::XyzD65 => "xyz-d65",
      Self::Lab => "lab",
      Self::Oklab => "oklab",
      Self::Lch => "lch",
      Self::Oklch => "oklch",
      Self::SrgbLegacy => "rgb",
      Self::Hsl => "hsl",
      Self::Hwb => "hwb",
    }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HueMethod {
  Shorter,
  Longer,
  Increasing,
  Decreasing,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Color {
  pub(super) space: ColorSpace,
  pub(super) p: [f32; 3],
  pub(super) alpha: f32,
  pub(super) none: [bool; 3],
  pub(super) alpha_none: bool,
}

/// kAchromaticChromaThreshold (color.cc:66).
const ACHROMATIC_CHROMA_THRESHOLD: f32 = 0.02;

/// AngleToUnitCircleDegrees (color.cc:154-156): float fmod.
fn angle_to_unit_circle_degrees(angle: f32) -> f32 {
  ((angle % 360.0) + 360.0) % 360.0
}

/// blink::Blend(float, float, double) (geometry/blend.h).
pub(crate) fn blend(from: f32, to: f32, progress: f64) -> f32 {
  (from as f64 + (to - from) as f64 * progress) as f32
}

fn clamp_int_255(x: i32) -> i32 {
  x.clamp(0, 255)
}

impl Color {
  pub(crate) const TRANSPARENT: Self = Self::from_rgba32(0);
  pub(crate) const BLACK: Self = Self::from_rgba32(0xFF000000);
  pub(crate) const WHITE: Self = Self::from_rgba32(0xFFFFFFFF);

  /// Color(RGBA32) (color.h:412-420): byte parameters, alpha `a / 255.f`.
  pub(crate) const fn from_rgba32(argb: u32) -> Self {
    Self {
      space: ColorSpace::SrgbLegacy,
      p: [
        ((argb >> 16) & 0xFF) as f32,
        ((argb >> 8) & 0xFF) as f32,
        (argb & 0xFF) as f32,
      ],
      alpha: ((argb >> 24) & 0xFF) as f32 / 255.0,
      none: [false; 3],
      alpha_none: false,
    }
  }

  /// Color::FromRGB: clamped to [0, 255], opaque.
  pub(crate) fn from_rgb(r: i32, g: i32, b: i32) -> Self {
    Self::from_rgba(r, g, b, 255)
  }

  /// Color::FromRGBA.
  pub(crate) fn from_rgba(r: i32, g: i32, b: i32, a: i32) -> Self {
    Self::from_rgba32(
      (clamp_int_255(a) as u32) << 24
        | (clamp_int_255(r) as u32) << 16
        | (clamp_int_255(g) as u32) << 8
        | clamp_int_255(b) as u32,
    )
  }

  /// Color::FromColorSpace (color.cc:241-277).
  pub(crate) fn from_color_space(
    space: ColorSpace,
    p0: Option<f32>,
    p1: Option<f32>,
    p2: Option<f32>,
    alpha: Option<f32>,
  ) -> Self {
    let mut c = Self {
      space,
      p: [p0.unwrap_or(0.0), p1.unwrap_or(0.0), p2.unwrap_or(0.0)],
      alpha: match alpha {
        // ClampTo(alpha, 0, 1): NaN stays NaN.
        Some(a) => clamp_f32(a, 0.0, 1.0),
        None => 0.0,
      },
      none: [p0.is_none(), p1.is_none(), p2.is_none()],
      alpha_none: alpha.is_none(),
    };
    if space.is_lightness_first() && !c.p[0].is_nan() {
      let max = if matches!(space, ColorSpace::Lab | ColorSpace::Lch) {
        100.0
      } else {
        1.0
      };
      c.p[0] = cpp_min(max, cpp_max(c.p[0], 0.0));
    }
    if space.is_chroma_second() {
      c.p[1] = cpp_max(c.p[1], 0.0);
    }
    c
  }

  pub(crate) fn space(&self) -> ColorSpace {
    self.space
  }

  pub(crate) fn params(&self) -> [f32; 3] {
    self.p
  }

  pub(crate) fn alpha(&self) -> f32 {
    self.alpha
  }

  pub(crate) fn set_alpha(&mut self, alpha: f32) {
    self.alpha = alpha;
  }

  pub(crate) fn param_is_none(&self, i: usize) -> bool {
    self.none[i]
  }

  pub(crate) fn alpha_is_none(&self) -> bool {
    self.alpha_none
  }

  pub(crate) fn has_none(&self) -> bool {
    self.none.iter().any(|&n| n) || self.alpha_none
  }

  /// Color::IsOpaque: alpha >= 1.
  pub(crate) fn is_opaque(&self) -> bool {
    self.alpha >= 1.0
  }

  /// Color::IsFullyTransparent: alpha <= 0.
  pub(crate) fn is_fully_transparent(&self) -> bool {
    self.alpha <= 0.0
  }

  /// Color::ToSRGB (color.cc:575-616), never gamut mapped
  /// (kBakedGamutMapping is off, features.cc).
  pub(crate) fn to_srgb(self) -> Vec3 {
    let [a, b, c] = self.p;
    match self.space {
      ColorSpace::Srgb => self.p,
      ColorSpace::SrgbLegacy => convert::srgb_legacy_to_srgb(a, b, c),
      ColorSpace::SrgbLinear => convert::srgb_linear_to_srgb(self.p),
      ColorSpace::Hsl => convert::hsl_to_srgb(a, b, c),
      ColorSpace::Hwb => convert::hwb_to_srgb(a, b, c),
      _ => {
        let [x, y, z] = self.to_xyz_d50();
        convert::xyz_d50_to_srgb(x, y, z)
      }
    }
  }

  /// Color::ToXYZD50 (color.cc:618-665).
  pub(crate) fn to_xyz_d50(self) -> Vec3 {
    let [a, b, c] = self.p;
    match self.space {
      ColorSpace::SrgbLegacy => {
        let [r, g, b] = convert::srgb_legacy_to_srgb(a, b, c);
        convert::srgb_to_xyz_d50(r, g, b)
      }
      ColorSpace::Lab => convert::lab_to_xyz_d50(a, b, c),
      ColorSpace::Oklab => convert::oklab_to_xyz_d50(a, b, c),
      ColorSpace::Lch => {
        let [l, a, b] = convert::lch_to_lab(a, b, c);
        convert::lab_to_xyz_d50(l, a, b)
      }
      ColorSpace::Oklch => {
        let [l, a, b] = convert::lch_to_lab(a, b, c);
        convert::oklab_to_xyz_d50(l, a, b)
      }
      ColorSpace::Hsl => {
        let [r, g, b] = convert::hsl_to_srgb(a, b, c);
        convert::srgb_to_xyz_d50(r, g, b)
      }
      ColorSpace::Hwb => {
        let [r, g, b] = convert::hwb_to_srgb(a, b, c);
        convert::srgb_to_xyz_d50(r, g, b)
      }
      space => {
        let (m, t) = convert::color_space_params(space.predefined().unwrap());
        let c = convert::transfer_apply(t, self.p);
        convert::matrix_apply(m, c)
      }
    }
  }

  /// Color::ResolveMissingComponents: `none` parameters become 0.
  fn resolve_missing_components(&mut self) {
    for i in 0..3 {
      if self.none[i] {
        self.p[i] = 0.0;
        self.none[i] = false;
      }
    }
  }

  /// Color::ConvertToColorSpace (color.cc:693-816).
  pub(crate) fn convert_to_color_space(&mut self, dst: ColorSpace, resolve_missing: bool) {
    if self.space == dst {
      return;
    }
    if resolve_missing {
      self.resolve_missing_components();
    }
    match dst {
      ColorSpace::XyzD65
      | ColorSpace::XyzD50
      | ColorSpace::SrgbLinear
      | ColorSpace::DisplayP3
      | ColorSpace::DisplayP3Linear
      | ColorSpace::A98Rgb
      | ColorSpace::ProPhotoRgb
      | ColorSpace::Rec2020 => {
        let (m, t) = convert::color_space_params(dst.predefined().unwrap());
        let xyz = self.to_xyz_d50();
        let c = convert::matrix_apply_inverse(m, xyz);
        self.p = convert::transfer_apply_inverse(t, c);
      }
      ColorSpace::Lab => {
        if self.space == ColorSpace::Lch {
          self.p = convert::lch_to_lab(self.p[0], self.p[1], self.p[2]);
        } else {
          let [x, y, z] = self.to_xyz_d50();
          self.p = convert::xyz_d50_to_lab(x, y, z);
        }
      }
      ColorSpace::Oklab => {
        if self.space == ColorSpace::Oklch {
          self.p = convert::lch_to_lab(self.p[0], self.p[1], self.p[2]);
        } else {
          let [x, y, z] = self.to_xyz_d50();
          self.p = convert::xyz_d50_to_oklab(x, y, z);
        }
      }
      ColorSpace::Lch => {
        if self.space == ColorSpace::Lab {
          self.p = convert::lab_to_lch(self.p[0], self.p[1], self.p[2]);
        } else {
          let [x, y, z] = self.to_xyz_d50();
          let [l, a, b] = convert::xyz_d50_to_lab(x, y, z);
          self.p = convert::lab_to_lch(l, a, b);
        }
        self.p[2] = angle_to_unit_circle_degrees(self.p[2]);
        if self.p[1] <= ACHROMATIC_CHROMA_THRESHOLD {
          self.none[2] = true;
        }
      }
      ColorSpace::Oklch => {
        if self.space == ColorSpace::Oklab {
          self.p = convert::lab_to_lch(self.p[0], self.p[1], self.p[2]);
        } else {
          let [x, y, z] = self.to_xyz_d50();
          let [l, a, b] = convert::xyz_d50_to_oklab(x, y, z);
          self.p = convert::lab_to_lch(l, a, b);
          self.p[2] = angle_to_unit_circle_degrees(self.p[2]);
        }
        if self.p[1] <= ACHROMATIC_CHROMA_THRESHOLD {
          self.none[2] = true;
        }
      }
      ColorSpace::Srgb => {
        self.p = self.to_srgb();
      }
      ColorSpace::SrgbLegacy => {
        let [r, g, b] = self.to_srgb();
        self.p = convert::srgb_to_srgb_legacy(r, g, b);
      }
      ColorSpace::Hsl => {
        let [r, g, b] = self.to_srgb();
        self.p = convert::srgb_to_hsl(r, g, b);
        if self.p[1] == 0.0 {
          self.none[0] = true;
        }
      }
      ColorSpace::Hwb => {
        let [r, g, b] = self.to_srgb();
        self.p = convert::srgb_to_hwb(r, g, b);
        if self.p[1] + self.p[2] >= 1.0 {
          self.none[0] = true;
        }
      }
    }
    self.space = dst;
  }

  /// Color::GetAnalogousMissingComponents (color.cc:353-460).
  fn analogous_missing_components(&self, dst: ColorSpace) -> [bool; 3] {
    use ColorSpace::*;
    let is_rgb_or_xyz = |s: ColorSpace| {
      matches!(
        s,
        Srgb
          | SrgbLinear
          | DisplayP3
          | DisplayP3Linear
          | A98Rgb
          | ProPhotoRgb
          | Rec2020
          | XyzD50
          | XyzD65
          | SrgbLegacy
      )
    };
    let is_lab = |s: ColorSpace| matches!(s, Lab | Oklab);
    let is_lch = |s: ColorSpace| matches!(s, Lch | Oklch);
    let [n0, n1, n2] = self.none;
    match self.space {
      s if is_rgb_or_xyz(s) => {
        if is_rgb_or_xyz(dst) {
          return [n0, n1, n2];
        }
      }
      Lab | Oklab => {
        if is_lab(dst) {
          return [n0, n1, n2];
        }
        if is_lch(dst) {
          return [n0, false, false];
        }
        if dst == Hsl {
          return [false, false, n0];
        }
      }
      Lch | Oklch => {
        if is_lch(dst) {
          return [n0, n1, n2];
        }
        if dst == Hsl {
          return [n2, n1, n0];
        }
        if is_lab(dst) {
          return [n0, false, false];
        }
      }
      Hsl => {
        if is_lch(dst) {
          return [n2, n1, n0];
        }
        if is_lab(dst) {
          return [n2, false, false];
        }
        if dst == Hwb {
          return [n0, false, false];
        }
      }
      Hwb => {
        if dst == Hsl {
          return [n0, false, false];
        }
        if is_lch(dst) {
          return [false, false, n0];
        }
      }
      _ => {}
    }
    [false; 3]
  }

  /// Color::ConvertToColorSpaceForInterpolation (color.cc:818-837).
  pub(crate) fn convert_to_color_space_for_interpolation(&mut self, dst: ColorSpace) {
    if self.space == dst {
      return;
    }
    let analogous = self.analogous_missing_components(dst);
    self.convert_to_color_space(dst, true);
    for (i, carried) in analogous.into_iter().enumerate() {
      if carried {
        self.p[i] = 0.0;
        self.none[i] = true;
      }
    }
  }

  /// Color::SubstituteMissingParameters (color.cc:479-517).
  fn substitute_missing_parameters(c1: &mut Self, c2: &mut Self) {
    for i in 0..3 {
      if c1.none[i] && !c2.none[i] {
        c1.p[i] = c2.p[i];
        c1.none[i] = false;
      } else if c2.none[i] && !c1.none[i] {
        c2.p[i] = c1.p[i];
        c2.none[i] = false;
      }
    }
    if c1.alpha_none && !c2.alpha_none {
      c1.alpha = c2.alpha;
      c1.alpha_none = false;
    } else if c2.alpha_none && !c1.alpha_none {
      c2.alpha = c1.alpha;
      c2.alpha_none = false;
    }
  }

  /// Color::PremultiplyColor (color.cc:859-874): returns the alpha.
  fn premultiply(&mut self) -> f32 {
    if self.alpha_none {
      return self.alpha;
    }
    let alpha = self.alpha;
    if !matches!(self.space, ColorSpace::Hsl | ColorSpace::Hwb) {
      self.p[0] *= self.alpha;
    }
    self.p[1] *= self.alpha;
    if !self.space.is_chroma_second() {
      self.p[2] *= self.alpha;
    }
    self.alpha = 1.0;
    alpha
  }

  /// Color::UnpremultiplyColor (color.cc:876-889).
  fn unpremultiply(&mut self) {
    if self.alpha_none || self.alpha == 0.0 {
      return;
    }
    if !matches!(self.space, ColorSpace::Hsl | ColorSpace::Hwb) {
      self.p[0] /= self.alpha;
    }
    self.p[1] /= self.alpha;
    if !self.space.is_chroma_second() {
      self.p[2] /= self.alpha;
    }
  }

  /// Color::HueInterpolation (color.cc:311-351).
  fn hue_interpolation(mut v1: f32, mut v2: f32, percentage: f32, method: HueMethod) -> f32 {
    match method {
      HueMethod::Shorter => {
        let diff = v2 - v1;
        if diff > 180.0 {
          v1 += 360.0;
        } else if diff < -180.0 {
          v2 += 360.0;
        }
      }
      HueMethod::Longer => {
        let diff = v2 - v1;
        if diff > 0.0 && diff < 180.0 {
          v1 += 360.0;
        } else if diff > -180.0 && diff <= 0.0 {
          v2 += 360.0;
        }
      }
      HueMethod::Increasing => {
        if v2 < v1 {
          v2 += 360.0;
        }
      }
      HueMethod::Decreasing => {
        if v1 < v2 {
          v1 += 360.0;
        }
      }
    }
    angle_to_unit_circle_degrees(blend(v1, v2, percentage as f64))
  }

  /// Color::InterpolateColors (color.cc:520-574).
  pub(crate) fn interpolate(
    space: ColorSpace,
    hue_method: Option<HueMethod>,
    mut c1: Self,
    mut c2: Self,
    percentage: f32,
  ) -> Self {
    c1.convert_to_color_space_for_interpolation(space);
    c2.convert_to_color_space_for_interpolation(space);
    Self::substitute_missing_parameters(&mut c1, &mut c2);
    let alpha1 = c1.premultiply();
    let alpha2 = c2.premultiply();
    let hue_method = hue_method.unwrap_or(HueMethod::Shorter);
    let p = percentage as f64;
    let param0 = if c1.none[0] && c2.none[0] {
      None
    } else if matches!(space, ColorSpace::Hsl | ColorSpace::Hwb) {
      Some(Self::hue_interpolation(
        c1.p[0], c2.p[0], percentage, hue_method,
      ))
    } else {
      Some(blend(c1.p[0], c2.p[0], p))
    };
    let param1 = if c1.none[1] && c2.none[1] {
      None
    } else {
      Some(blend(c1.p[1], c2.p[1], p))
    };
    let param2 = if c1.none[2] && c2.none[2] {
      None
    } else if space.is_chroma_second() {
      Some(Self::hue_interpolation(
        c1.p[2], c2.p[2], percentage, hue_method,
      ))
    } else {
      Some(blend(c1.p[2], c2.p[2], p))
    };
    let alpha = if c1.alpha_none && c2.alpha_none {
      None
    } else {
      Some(blend(alpha1, alpha2, p))
    };
    let mut result = Self::from_color_space(space, param0, param1, param2, alpha);
    result.unpremultiply();
    result
  }

  /// Color::FromColorMix (color.cc:296-308).
  pub(crate) fn from_color_mix(
    space: ColorSpace,
    hue_method: Option<HueMethod>,
    c1: Self,
    c2: Self,
    percentage: f32,
    alpha_multiplier: f32,
  ) -> Self {
    let mut result = Self::interpolate(space, hue_method, c1, c2, percentage);
    result.alpha *= alpha_multiplier;
    result
  }

  /// Color::toSkColor4f (color.cc:839-842): unclamped extended sRGB.
  pub(crate) fn to_sk_color4f(self) -> Color4f {
    let [r, g, b] = self.to_srgb();
    Color4f {
      r,
      g,
      b,
      a: self.alpha,
    }
  }

  /// Color::Rgb (color.cc:914-916): `toSkColor4f().toSkColor()`.
  pub(crate) fn rgb(&self) -> u32 {
    self.to_sk_color4f().to_sk_color()
  }

  /// Color::GetColorInterpolationSpace (color.cc:1253-1262).
  pub(crate) fn interpolation_space(&self) -> ColorSpace {
    if self.space.is_legacy() && !self.has_none() {
      ColorSpace::SrgbLegacy
    } else {
      ColorSpace::Oklab
    }
  }

  /// Color::ResolveNonFiniteValues (color.cc:1362-1394).
  pub(crate) fn resolve_non_finite_values(&mut self) {
    fn channel(value: f32, negative: f32, positive: f32) -> f32 {
      if value.is_finite() {
        value
      } else if value.is_nan() {
        0.0
      } else if value < 0.0 {
        negative
      } else {
        positive
      }
    }
    if self.space.is_lightness_first() {
      self.p[0] = channel(self.p[0], 0.0, 100.0);
    }
    if self.space.is_chroma_second() && self.p[1].is_infinite() && self.p[1] < 0.0 {
      self.p[1] = 0.0;
    }
    if self.space == ColorSpace::SrgbLegacy {
      for v in &mut self.p {
        *v = channel(*v, 0.0, 1.0);
      }
    }
    for v in &mut self.p {
      if v.is_nan() {
        *v = 0.0;
      }
    }
    self.alpha = channel(self.alpha, 0.0, 1.0);
  }

  /// Color::BlendWithWhite (color.cc:1214-1236).
  pub(crate) fn blend_with_white(&self) -> Self {
    if !self.is_opaque() {
      return *self;
    }
    // kCStartAlpha, kCEndAlpha, kCAlphaIncrement (color.cc:68-70).
    let blend_component = |c: i32, a: i32| -> i32 {
      let alpha = a as f32 / 255.0;
      let white_blend = 255 - a;
      ((c - white_blend) as f32 / alpha) as i32
    };
    let rgb = self.rgb();
    let (red, green, blue) = (
      ((rgb >> 16) & 0xFF) as i32,
      ((rgb >> 8) & 0xFF) as i32,
      (rgb & 0xFF) as i32,
    );
    let mut new_color = Self::default();
    let mut alpha = 153;
    while alpha <= 204 {
      let r = blend_component(red, alpha);
      let g = blend_component(green, alpha);
      let b = blend_component(blue, alpha);
      new_color = Self::from_rgba(r, g, b, alpha);
      if r >= 0 && g >= 0 && b >= 0 {
        break;
      }
      alpha += 17;
    }
    new_color
  }
}

impl Default for Color {
  /// `Color()`: transparent black in legacy sRGB.
  fn default() -> Self {
    Self::TRANSPARENT
  }
}

/// ClampTo<float>(v, lo, hi): NaN stays NaN.
fn clamp_f32(v: f32, lo: f32, hi: f32) -> f32 {
  if v < lo {
    lo
  } else if v > hi {
    hi
  } else {
    v
  }
}

fn cpp_min(a: f32, b: f32) -> f32 {
  if b < a { b } else { a }
}

fn cpp_max(a: f32, b: f32) -> f32 {
  if a < b { b } else { a }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// color_test.cc BlinkColor.ConvertToColorSpace and toSkColor4f samples.
  #[test]
  fn conversions_match_blink_color_test() {
    let mut c = Color::from_rgba32(0xFFFF0000);
    c.convert_to_color_space(ColorSpace::Srgb, true);
    assert_eq!(c.params(), [1.0, 0.0, 0.0]);
    let mut lab =
      Color::from_color_space(ColorSpace::Lab, Some(50.0), Some(0.0), Some(0.0), Some(1.0));
    lab.convert_to_color_space(ColorSpace::Lch, true);
    // achromatic: hue becomes powerless
    assert!(lab.param_is_none(2));
    // FromColorSpace clamps lightness and chroma.
    let c = Color::from_color_space(
      ColorSpace::Oklch,
      Some(1.5),
      Some(-1.0),
      Some(30.0),
      Some(2.0),
    );
    assert_eq!(c.params(), [1.0, 0.0, 30.0]);
    assert_eq!(c.alpha(), 1.0);
  }

  #[test]
  fn hue_interpolation_methods() {
    assert_eq!(
      Color::hue_interpolation(10.0, 350.0, 0.5, HueMethod::Shorter),
      0.0
    );
    assert_eq!(
      Color::hue_interpolation(10.0, 350.0, 0.5, HueMethod::Longer),
      180.0
    );
    assert_eq!(
      Color::hue_interpolation(350.0, 10.0, 0.5, HueMethod::Increasing),
      0.0
    );
    assert_eq!(
      Color::hue_interpolation(10.0, 350.0, 0.5, HueMethod::Decreasing),
      0.0
    );
  }

  #[test]
  fn blend_with_white_uses_the_first_alpha_with_positive_channels() {
    let mac = Color::from_rgba32(0xFFB3D7FF).blend_with_white();
    assert_eq!(
      (mac.params(), mac.alpha()),
      ([128.0, 188.0, 254.0], 153.0 / 255.0)
    );
    // Blink's default kDefaultActiveSelectionBgColor 0xFF1967D2: green is
    // (int)(52 / (204 / 255.0f)) = 65 in float, red -32 clamps to 0.
    let default = Color::from_rgba32(0xFF1967D2).blend_with_white();
    assert_eq!(
      (default.params(), default.alpha()),
      ([0.0, 65.0, 198.0], 204.0 / 255.0)
    );
  }
}
