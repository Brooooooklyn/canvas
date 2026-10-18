use std::result;

use cssparser::Parser;
use cssparser_color::Color as CSSColor;
use napi::bindgen_prelude::*;

use crate::{
  error::SkError,
  pattern::hsl_color_to_srgb,
  sk::{
    Color4f, ConicGradient, Gradient as SkGradient, LinearGradient, RadialGradient, Shader,
    TileMode, Transform, unit_from_u8,
  },
};

#[derive(Debug, Clone)]
pub enum Gradient {
  Linear(LinearGradient),
  Radial(RadialGradient),
  Conic(ConicGradient),
}

impl Gradient {
  pub fn create_linear_gradient(x0: f32, y0: f32, x1: f32, y1: f32) -> Self {
    let linear_gradient = LinearGradient {
      start_point: (x0, y0),
      end_point: (x1, y1),
      base: SkGradient {
        colors: Vec::new(),
        positions: Vec::new(),
        tile_mode: TileMode::Clamp,
        transform: Transform::default(),
      },
    };
    Self::Linear(linear_gradient)
  }

  pub fn create_radial_gradient(x0: f32, y0: f32, r0: f32, x1: f32, y1: f32, r1: f32) -> Self {
    let radial_gradient = RadialGradient {
      start: (x0, y0),
      start_radius: r0,
      end: (x1, y1),
      end_radius: r1,
      base: SkGradient {
        colors: Vec::new(),
        positions: Vec::new(),
        tile_mode: TileMode::Clamp,
        transform: Transform::default(),
      },
    };
    Self::Radial(radial_gradient)
  }

  /// `start_angle` is in radians. Blink stores `Rad2deg(startAngle) + 90`
  /// (canvas_2d_recorder_context.cc:2424-2426), so angle 0 points along +x.
  pub fn create_conic_gradient(x: f32, y: f32, start_angle: f32) -> Self {
    Self::Conic(ConicGradient {
      center: (x, y),
      rotation: start_angle * (180.0 / std::f32::consts::PI) + 90.0,
      base: SkGradient {
        colors: Vec::new(),
        positions: Vec::new(),
        tile_mode: TileMode::Clamp,
        transform: Transform::default(),
      },
    })
  }

  pub fn add_color_stop(&mut self, offset: f32, color: Color4f) {
    let (stops, colors) = match self {
      Self::Linear(linear_gradient) => (
        &mut linear_gradient.base.positions,
        &mut linear_gradient.base.colors,
      ),
      Self::Radial(radial_gradient) => (
        &mut radial_gradient.base.positions,
        &mut radial_gradient.base.colors,
      ),
      Self::Conic(conic_gradient) => (
        &mut conic_gradient.base.positions,
        &mut conic_gradient.base.colors,
      ),
    };
    // Stops sharing an offset must keep insertion order (HTML spec,
    // dom-canvasgradient-addcolorstop), so a new stop belongs at the UPPER bound
    // of `offset` -- what Blink gets from a `stable_sort` over a strict `<`.
    if stops.last().map(|l| l <= &offset).unwrap_or(true) {
      stops.push(offset);
      colors.push(color);
    } else {
      let mut index = 0usize;
      // insert it in sorted order, after any stop already sitting at the same offset
      for (idx, val) in stops.iter().enumerate() {
        if val > &offset {
          break;
        } else {
          index = idx + 1;
        }
      }
      stops.insert(index, offset);
      colors.insert(index, color);
    }
  }

  /// Transform is [3 x 3] matrix, but stored in 2d array:
  /// | A B C |
  /// | D E F |
  /// | 0 0 1 |
  /// [0 -> A, 1 -> B, 2 -> C, 3 -> D, 4 -> E, 5 -> F, 6 -> 0, 7 -> 0, 8 -> 1 ]
  /// [lineargradient.js](skia/modules/canvaskit/htmlcanvas/lineargradient.js)
  /// [radialgradient.js](skia/modules/canvaskit/htmlcanvas/radialgradient.js)
  /// Rough size of the shader a recorded draw retains: ~32 B per stop
  /// (position f32, float RGBA color, plus share of the shader object).
  pub(crate) fn estimated_bytes(&self) -> usize {
    self.base().colors.len() * 32 + 256
  }

  fn base(&self) -> &SkGradient {
    match self {
      Self::Linear(g) => &g.base,
      Self::Radial(g) => &g.base,
      Self::Conic(g) => &g.base,
    }
  }

  /// Blink's Gradient::FillSkiaStops (gradient.cc:131-213): a gradient with no
  /// stops is transparent black, and the first and last stops are copied to 0.0
  /// and 1.0. So Skia never gets 0 colors (it would fail) or 1 color (it would
  /// make a solid color shader, which is never dithered).
  fn skia_stops(base: &SkGradient) -> SkGradient {
    let mut colors = Vec::with_capacity(base.colors.len() + 2);
    let mut positions = Vec::with_capacity(base.colors.len() + 2);
    match (base.positions.first(), base.colors.first()) {
      (Some(&first_position), Some(&first_color)) => {
        if first_position > 0.0 {
          positions.push(0.0);
          colors.push(first_color);
        }
        positions.extend_from_slice(&base.positions);
        colors.extend_from_slice(&base.colors);
      }
      _ => {
        positions.push(0.0);
        colors.push(Color4f::TRANSPARENT);
      }
    }
    let (last_position, last_color) = (positions[positions.len() - 1], colors[colors.len() - 1]);
    if last_position < 1.0 {
      positions.push(1.0);
      colors.push(last_color);
    }
    SkGradient {
      colors,
      positions,
      tile_mode: base.tile_mode,
      transform: base.transform,
    }
  }

  /// The one color the gradient paints everywhere, if there is one: transparent
  /// black with no stops, or the color that all its stops share.
  pub(crate) fn constant_color(&self) -> Option<Color4f> {
    match self.base().colors.split_first() {
      None => Some(Color4f::TRANSPARENT),
      Some((first, rest)) => rest.iter().all(|c| c == first).then_some(*first),
    }
  }

  pub(crate) fn get_shader(&self) -> result::Result<Shader, SkError> {
    match self {
      Self::Linear(linear_gradient) => Ok(
        Shader::new_linear_gradient(&LinearGradient {
          start_point: linear_gradient.start_point,
          end_point: linear_gradient.end_point,
          base: Self::skia_stops(&linear_gradient.base),
        })
        .ok_or_else(|| SkError::Generic("Get shader of linear gradient failed".to_owned()))?,
      ),
      // Note, Skia has a different notion of a "radial" gradient.
      // Skia has a twoPointConical gradient that is the same as the
      // canvas's RadialGradient.
      Self::Radial(radial_gradient) => {
        // From the spec: "The points in the linear gradient must be transformed
        // as described by the current transformation matrix when rendering."
        let base = Self::skia_stops(&radial_gradient.base);
        let new_radial_gradient = RadialGradient {
          start: radial_gradient.start,
          end: radial_gradient.end,
          start_radius: radial_gradient.start_radius,
          end_radius: radial_gradient.end_radius,
          base,
        };

        Ok(
          Shader::new_radial_gradient(&new_radial_gradient)
            .ok_or_else(|| SkError::Generic("Get shader of radial gradient failed".to_owned()))?,
        )
      }
      Self::Conic(conic_gradient) => {
        // The canvas CTM already applies to the shader, so the angle does not
        // depend on it.
        let new_conic_gradient = ConicGradient {
          center: conic_gradient.center,
          rotation: conic_gradient.rotation,
          base: Self::skia_stops(&conic_gradient.base),
        };

        Ok(
          Shader::new_conic_gradient(&new_conic_gradient)
            .ok_or_else(|| SkError::Generic("Get shader of conic gradient failed".to_owned()))?,
        )
      }
    }
  }
}

/// Whether Blink rounds this hsl() color's alpha to k/255. Only its CSS fast
/// path does (css_parser_fast_paths.cc:1069-1083, `alpha * (1.0f / 255.0f)`);
/// every spelling the fast path rejects goes through the full parser, which
/// keeps the float alpha. This is a port of the hsl() half of
/// FastParseColorInternal (:990-1086), run on the string that
/// ParseCanvasColorString hands it: stripped of HTML spaces. The fast path
/// only accepts ASCII, so working on UTF-8 bytes is safe. One thing is not
/// ported: Blink also skips the fast path when V8 holds the string as two-byte
/// (CSSParserFastPaths::ParseColor's Is8Bit check), e.g. a slice of a string
/// that had a non-Latin-1 character. Node-API does not expose that, so every
/// string is treated as one-byte here.
pub(crate) fn blink_rounds_hsl_alpha(color: &str) -> bool {
  use blink_fast_path::*;
  let chars = color.trim_matches(HTML_SPACES).as_bytes();
  // MightBeHSLOrHSLA (:902-911): the name is case-sensitive.
  let Some(current) = chars
    .strip_prefix(b"hsl(")
    .or_else(|| chars.strip_prefix(b"hsla("))
  else {
    return false;
  };
  let mut current = skip_html_spaces(current);
  let hue_length = parse_simple_angle(current);
  if hue_length == 0 {
    return false;
  }
  current = &current[hue_length..];
  let mut terminator_status = TerminatorStatus::CouldWhitespace;
  if !skip_to_terminator(&mut current, b',', &mut terminator_status) {
    return false;
  }
  // Saturation and lightness must be percentages.
  if !parse_percentage(&mut current, b',', &mut terminator_status) {
    return false;
  }
  let mut no_whitespace_check = TerminatorStatus::MustCharacter;
  let should_have_alpha = if parse_percentage(&mut current, b',', &mut no_whitespace_check) {
    if terminator_status != TerminatorStatus::MustCharacter {
      return false;
    }
    true
  } else if parse_percentage(&mut current, b'/', &mut no_whitespace_check) {
    if terminator_status != TerminatorStatus::MustWhitespace {
      return false;
    }
    true
  } else if parse_percentage(&mut current, b')', &mut no_whitespace_check) {
    false
  } else {
    return false;
  };
  if should_have_alpha {
    parse_alpha_value(current, b')')
  } else {
    current.is_empty()
  }
}

/// The pieces of Blink's css_parser_fast_paths.cc that its hsl() fast path
/// uses, reduced to what they accept: each returns how much it consumes (or
/// whether it matched), not the parsed value.
pub(crate) mod blink_fast_path {
  pub(crate) const HTML_SPACES: [char; 5] = [' ', '\t', '\n', '\x0c', '\r'];

  fn is_html_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\x0c' | b'\r')
  }

  pub(super) fn skip_html_spaces(chars: &[u8]) -> &[u8] {
    let n = chars.iter().take_while(|&&c| is_html_space(c)).count();
    &chars[n..]
  }

  /// FindLengthOfValidDouble (:293-378): digits with at most one '.', which
  /// must not be the last character. Its SIMD branch can stop before such a
  /// '.' instead of returning 0, but every caller then fails on that '.', so
  /// the scalar rule gives the same answers.
  fn find_length_of_valid_double(chars: &[u8]) -> usize {
    let mut decimal_mark_seen = false;
    let mut valid_length = 0;
    for &c in chars {
      if c.is_ascii_digit() {
      } else if !decimal_mark_seen && c == b'.' {
        decimal_mark_seen = true;
      } else {
        break;
      }
      valid_length += 1;
    }
    if valid_length > 0 && chars[valid_length - 1] == b'.' {
      return 0;
    }
    valid_length
  }

  /// ParseSimpleAngle (:183-229): an optional '-', a number with no sign or
  /// exponent, and an optional ASCII-case-insensitive deg, grad, rad or turn.
  /// Returns the length, or 0 if there is no number.
  pub(super) fn parse_simple_angle(chars: &[u8]) -> usize {
    let sign_length = usize::from(chars.first() == Some(&b'-'));
    let number_length = find_length_of_valid_double(&chars[sign_length..]);
    if number_length == 0 {
      return 0;
    }
    let number_length = sign_length + number_length;
    let unit = &chars[number_length..];
    let unit_length = ["deg", "grad", "rad", "turn"]
      .into_iter()
      .find(|u| unit.len() >= u.len() && unit[..u.len()].eq_ignore_ascii_case(u.as_bytes()))
      .map_or(0, str::len);
    number_length + unit_length
  }

  /// ParseFloatWithMaxValue (:576-621): HTML spaces, an optional '-', at
  /// least one digit, then an optional '.' and digits. Returns the rest.
  pub(crate) fn parse_float_with_max_value(chars: &[u8]) -> Option<&[u8]> {
    let current = skip_html_spaces(chars);
    let current = current.strip_prefix(b"-").unwrap_or(current);
    let digits = current.iter().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
      return None;
    }
    let current = &current[digits..];
    if current.first() == Some(&b'.') {
      let fraction = find_length_of_valid_double(current);
      if fraction == 0 {
        return None;
      }
      return Some(&current[fraction..]);
    }
    Some(current)
  }

  /// kMustWhitespaceTerminate, kMustCharacterTerminate and
  /// kCouldWhitespaceTerminate (:625-639).
  #[derive(Clone, Copy, PartialEq, Eq)]
  pub(crate) enum TerminatorStatus {
    MustWhitespace,
    MustCharacter,
    CouldWhitespace,
  }

  /// SkipToTerminator (:643-678).
  pub(crate) fn skip_to_terminator(
    chars: &mut &[u8],
    terminator: u8,
    terminator_status: &mut TerminatorStatus,
  ) -> bool {
    let mut current = skip_html_spaces(chars);
    let skipped_space = current.len() != chars.len();
    match *terminator_status {
      TerminatorStatus::CouldWhitespace if current.first() == Some(&terminator) => {
        *terminator_status = TerminatorStatus::MustCharacter;
        current = &current[1..];
      }
      TerminatorStatus::CouldWhitespace | TerminatorStatus::MustWhitespace => {
        *terminator_status = TerminatorStatus::MustWhitespace;
        if !skipped_space {
          return false;
        }
      }
      TerminatorStatus::MustCharacter => match current.split_first() {
        Some((&c, rest)) if c == terminator => current = rest,
        _ => return false,
      },
    }
    *chars = current;
    true
  }

  /// ParsePercentage (:727-753): a number, '%', then the terminator.
  pub(super) fn parse_percentage(
    chars: &mut &[u8],
    terminator: u8,
    terminator_status: &mut TerminatorStatus,
  ) -> bool {
    let Some(mut current) =
      parse_float_with_max_value(chars).and_then(|rest| rest.strip_prefix(b"%"))
    else {
      return false;
    };
    if !skip_to_terminator(&mut current, terminator, terminator_status) {
      return false;
    }
    *chars = current;
    true
  }

  /// IsTenthAlpha (:755-768): "0.X" or ".X".
  fn is_tenth_alpha(chars: &[u8]) -> bool {
    matches!(chars, [b'0', b'.', d] | [b'.', d] if d.is_ascii_digit())
  }

  /// ParseAlphaValue (:770-832): HTML spaces, an optional '-', a number with
  /// no sign or exponent, then the terminator, which must also be the last
  /// character, right after a digit.
  pub(crate) fn parse_alpha_value(chars: &[u8], terminator: u8) -> bool {
    let chars = skip_html_spaces(chars);
    let chars = chars.strip_prefix(b"-").unwrap_or(chars);
    let length = chars.len();
    if length < 2 || chars[length - 1] != terminator || !chars[length - 2].is_ascii_digit() {
      return false;
    }
    let followed_by_terminator = |n: usize| n > 0 && chars.get(n) == Some(&terminator);
    if !matches!(chars[0], b'0' | b'1' | b'.') {
      return followed_by_terminator(find_length_of_valid_double(chars));
    }
    if length == 2 && chars[0] != b'.' {
      return true;
    }
    if is_tenth_alpha(&chars[..length - 1]) {
      return true;
    }
    followed_by_terminator(find_length_of_valid_double(chars))
  }
}

#[napi]
pub struct CanvasGradient(pub(crate) Gradient);

#[napi]
impl CanvasGradient {
  #[napi]
  pub fn add_color_stop(&mut self, index: f64, color: String) -> Result<()> {
    if color.is_empty() {
      return Ok(());
    }
    let color_str = color.as_str();
    let mut parser = Parser::new(color_str);
    let color = CSSColor::parse(&mut parser).map_err(|e| {
      Error::new(
        Status::InvalidArg,
        format!("Parse color [{color_str}] error: {e:?}"),
      )
    })?;
    let skia_color = match color {
      // Without an element, currentcolor is opaque black (Chrome's
      // OffscreenCanvas answer).
      CSSColor::CurrentColor => Color4f::from_rgba8(0, 0, 0, 255),
      CSSColor::Rgba(rgba) => Color4f::from_rgba8(
        rgba.red,                           // Already u8
        rgba.green,                         // Already u8
        rgba.blue,                          // Already u8
        (rgba.alpha * 255.0).round() as u8, // Scale f32 0.0-1.0 to u8 0-255
      ),
      // Blink keeps an hsl() stop as float sRGB (Color::ToGradientStopSkColor4f).
      CSSColor::Hsl(hsl) => {
        let [r, g, b] = hsl_color_to_srgb(&hsl);
        let alpha = hsl.alpha.unwrap_or(1.0);
        Color4f {
          r,
          g,
          b,
          a: if blink_rounds_hsl_alpha(color_str) {
            unit_from_u8((alpha * 255.0).round() as u8)
          } else {
            alpha
          },
        }
      }
      _ => {
        return Err(Error::new(
          Status::InvalidArg,
          "Unsupported color format".to_owned(),
        ));
      }
    };
    self.0.add_color_stop(index as f32, skia_color);
    Ok(())
  }
}

#[test]
fn test_add_color_stop() {
  let mut linear_gradient = Gradient::create_linear_gradient(0.0, 0.0, 0.0, 77.0);
  linear_gradient.add_color_stop(1.0, Color4f::from_rgba8(0, 128, 128, 255));
  linear_gradient.add_color_stop(0.6, Color4f::from_rgba8(0, 255, 255, 255));
  linear_gradient.add_color_stop(0.3, Color4f::from_rgba8(176, 199, 45, 255));
  linear_gradient.add_color_stop(0.0, Color4f::from_rgba8(204, 82, 50, 255));
  if let Gradient::Linear(linear_gradient) = linear_gradient {
    assert_eq!(linear_gradient.base.positions, vec![0.0, 0.3, 0.6, 1.0]);
    assert_eq!(
      linear_gradient.base.colors,
      vec![
        Color4f::from_rgba8(204, 82, 50, 255),
        Color4f::from_rgba8(176, 199, 45, 255),
        Color4f::from_rgba8(0, 255, 255, 255),
        Color4f::from_rgba8(0, 128, 128, 255),
      ]
    );
  } else {
    unreachable!();
  }
}

/// Pins the HTML spec's rule that stops sharing an offset keep insertion order
/// (dom-canvasgradient-addcolorstop).
#[test]
fn test_add_color_stop_duplicated_offsets_keep_insertion_order() {
  let red = Color4f::from_rgba8(255, 0, 0, 255);
  let green = Color4f::from_rgba8(0, 255, 0, 255);
  let blue = Color4f::from_rgba8(0, 0, 255, 255);
  let white = Color4f::from_rgba8(255, 255, 255, 255);
  let black = Color4f::from_rgba8(0, 0, 0, 255);

  let positions_colors = |gradient: Gradient| match gradient {
    Gradient::Linear(g) => (g.base.positions, g.base.colors),
    Gradient::Radial(g) => (g.base.positions, g.base.colors),
    Gradient::Conic(g) => (g.base.positions, g.base.colors),
  };

  // Two stops at the same offset, appended at the tail.
  let mut g = Gradient::create_linear_gradient(0.0, 0.0, 20.0, 0.0);
  g.add_color_stop(0.5, red);
  g.add_color_stop(0.5, blue);
  let (positions, colors) = positions_colors(g);
  assert_eq!(positions, vec![0.5, 0.5]);
  assert_eq!(colors, vec![red, blue]);

  // A duplicate offset in the middle of an existing run must not jump ahead of it.
  let mut g = Gradient::create_linear_gradient(0.0, 0.0, 20.0, 0.0);
  g.add_color_stop(0.0, white);
  g.add_color_stop(0.5, red);
  g.add_color_stop(0.5, green);
  g.add_color_stop(0.5, blue);
  g.add_color_stop(1.0, black);
  let (positions, colors) = positions_colors(g);
  assert_eq!(positions, vec![0.0, 0.5, 0.5, 0.5, 1.0]);
  assert_eq!(colors, vec![white, red, green, blue, black]);

  // Duplicates at the 0.0 and 1.0 boundaries.
  let mut g = Gradient::create_radial_gradient(16.0, 16.0, 0.0, 16.0, 16.0, 16.0);
  g.add_color_stop(0.0, red);
  g.add_color_stop(0.0, green);
  g.add_color_stop(1.0, blue);
  g.add_color_stop(1.0, black);
  let (positions, colors) = positions_colors(g);
  assert_eq!(positions, vec![0.0, 0.0, 1.0, 1.0]);
  assert_eq!(colors, vec![red, green, blue, black]);

  // Out-of-order insertion mixed with duplicates: equal offsets keep insertion
  // order even through the O(n) insertion path.
  let mut g = Gradient::create_conic_gradient(16.0, 16.0, 16.0);
  g.add_color_stop(1.0, black);
  g.add_color_stop(0.5, red);
  g.add_color_stop(0.25, green);
  g.add_color_stop(0.5, blue);
  g.add_color_stop(0.0, white);
  g.add_color_stop(0.25, red);
  let (positions, colors) = positions_colors(g);
  assert_eq!(positions, vec![0.0, 0.25, 0.25, 0.5, 0.5, 1.0]);
  assert_eq!(colors, vec![white, green, red, red, blue, black]);
}

/// Blink FillSkiaStops: no stops -> transparent black; the first and last stops
/// are copied to 0.0 and 1.0.
#[test]
fn test_skia_stops_pad_like_blink() {
  let red = Color4f::from_rgba8(255, 0, 0, 255);
  let blue = Color4f::from_rgba8(0, 0, 255, 255);
  let stops = |g: &Gradient| {
    let s = Gradient::skia_stops(g.base());
    (s.positions, s.colors)
  };

  let g = Gradient::create_linear_gradient(0.0, 0.0, 20.0, 0.0);
  assert_eq!(
    stops(&g),
    (
      vec![0.0, 1.0],
      vec![Color4f::TRANSPARENT, Color4f::TRANSPARENT]
    )
  );
  assert_eq!(g.constant_color(), Some(Color4f::TRANSPARENT));

  let mut g = Gradient::create_radial_gradient(0.0, 0.0, 0.0, 0.0, 0.0, 20.0);
  g.add_color_stop(0.3, red);
  assert_eq!(stops(&g), (vec![0.0, 0.3, 1.0], vec![red, red, red]));
  assert_eq!(g.constant_color(), Some(red));

  let mut g = Gradient::create_conic_gradient(0.0, 0.0, 0.0);
  g.add_color_stop(0.0, red);
  g.add_color_stop(1.0, blue);
  assert_eq!(stops(&g), (vec![0.0, 1.0], vec![red, blue]));
  assert_eq!(g.constant_color(), None);
}

/// Chrome 155: these hsl() stops get a k/255 alpha (CSS fast path) or keep the
/// float alpha (full parser, or no color at all for the invalid ones).
#[test]
fn test_blink_rounds_hsl_alpha() {
  for rounded in [
    "hsla(120, 50%, 50%, 0.33)",
    "hsl(120 50% 50% / 0.33)",
    "hsl(120 50% 50%/.33)",
    "  hsla(120, 50%, 50%,0.33)  ",
    "hsla(120deg, 50%, 50%, 0.33)",
    "hsla(120, 50%, 50%, -0.5)",
    "hsla(120, 50%, 50%, 5)",
    // Hue: a unit in any case, a leading '.' or '-', a fraction, a big number.
    "hsl(120deg 0% 50% / 0.3)",
    "hsl(120DEG 0% 50% / 0.3)",
    "hsl(120Deg 0% 50% / 0.3)",
    "hsl(2rad 0% 50% / 0.3)",
    "hsl(2RAD 0% 50% / 0.3)",
    "hsl(200grad 0% 50% / 0.3)",
    "hsl(200GRAD 0% 50% / 0.3)",
    "hsl(0.5turn 0% 50% / 0.3)",
    "hsl(0.5TuRn 0% 50% / 0.3)",
    "hsl(.5turn 0% 50% / 0.3)",
    "hsl(-.5turn 0% 50% / 0.3)",
    "hsla(120deg, 0%, 50%, 0.3)",
    "hsla(0.5turn, 0%, 50%, 0.3)",
    "hsla(2rad,0%,50%,0.3)",
    "hsl(-120 0% 50% / 0.3)",
    "hsl(120.5 0% 50% / 0.3)",
    "hsl(1000000 0% 50% / 0.3)",
    // Separators: legacy commas or modern spaces and '/', with any HTML spaces.
    "hsla(0, 0%, 50%, 0.3)",
    "hsl(0, 0%, 50%, 0.3)",
    "hsl(0,0%,50%,0.3)",
    "hsl( 0 , 0% , 50% , 0.3)",
    "hsla(0 0% 50% / 0.3)",
    "hsl(0 0% 50%/0.3)",
    "hsl(0  0%  50%  /  0.3)",
    "hsl( 0 0% 50% / 0.3)",
    "hsl(0\t0%\n50%\r/\x0c0.3)",
    "  hsl(0 0% 50% / 0.3)  ",
    "\t\nhsl(0 0% 50% / 0.3)\r\x0c",
    // Saturation and lightness: a fraction, a '-', leading zeros.
    "hsl(0 0.0% 50.0% / 0.3)",
    "hsl(0 -10% 50% / 0.3)",
    "hsl(0 0% 050% / 0.3)",
    "hsl(0 0% 50.00000001% / 0.3)",
    // Alpha.
    "hsl(0 0% 50% / .3)",
    "hsl(0 0% 50% / 0.30)",
    "hsl(0 0% 50% / 00.3)",
    // ParseAlphaValue only needs a ')' right after the number and at the end.
    "hsl(0 0% 50% / 0.3)1)",
    "hsl(0 0% 50% / 0.3) 1)",
  ] {
    assert!(blink_rounds_hsl_alpha(rounded), "{rounded:?}");
  }
  for float in [
    "hsl(120 50% 50% / 33%)",
    "hsla(120, 50%, 50%, 33%)",
    "HSLA(120, 50%, 50%, 0.33)",
    "Hsl(120 50% 50% / 0.33)",
    "hsla(120, 50%, 50%, 0.33 )",
    "hsla(120, 50%, 50%, 3.3e-1)",
    "hsla(120, 50%, 50%, 1.)",
    // none in each position.
    "hsl(none 0% 50% / 0.3)",
    "hsla(none 0% 50% / 0.3)",
    "hsl(0 none 50% / 0.3)",
    "hsl(0 0% none / 0.3)",
    "hsl(120 none 50% / 0.3)",
    "hsl(120 50% none / 0.3)",
    "hsl(0 0% 50% / none)",
    "hsl(none 50% 50% / 0.33)",
    // Hue: a '+', an exponent, calc().
    "hsl(+120 0% 50% / 0.3)",
    "hsl(1.2e2 0% 50% / 0.3)",
    "hsl(1.2e2deg 0% 50% / 0.3)",
    "hsl(calc(0) 0% 50% / 0.3)",
    "hsl(calc(120deg) 0% 50% / 0.3)",
    "hsla(calc(0), 0%, 50%, 0.3)",
    // Saturation, lightness and alpha: no leading digit, a '+', an exponent,
    // calc(), no '%'.
    "hsl(0 .0% 50% / 0.3)",
    "hsl(0 0% .5e2% / 0.3)",
    "hsl(0 0% 5e1% / 0.3)",
    "hsl(0 +0% 50% / 0.3)",
    "hsl(0 0% +50% / 0.3)",
    "hsl(0 calc(0%) 50% / 0.3)",
    "hsl(0 0% calc(50%) / 0.3)",
    "hsl(0 0% 50% / calc(0.3))",
    "hsl(0 0 50 / 0.3)",
    "hsl(0 0% 50% / 0.3 )",
    "hsl(0 0% 50% / 3e-1)",
    "hsl(0 0% 50% / +0.3)",
    "hsl(0 0% 50% / 30%)",
    // Function name not all lowercase, or escaped.
    "HSL(0 0% 50% / 0.3)",
    "Hsl(0 0% 50% / 0.3)",
    "hSl(0 0% 50% / 0.3)",
    "HSLA(0, 0%, 50%, 0.3)",
    "hslA(0, 0%, 50%, 0.3)",
    "hsl\\61(0, 0%, 50%, 0.3)",
    // Comments.
    "hsl(0 /**/ 0% 50% / 0.3)",
    "hsl(0 0% 50% / 0.3/**/)",
    "hsl(/**/0 0% 50% / 0.3)",
    // Mixed separators (invalid in Chrome too).
    "hsl(none, 0%, 50%, 0.3)",
    "hsl(0 0%,50%,0.3)",
    "hsl(0, 0% 50%, 0.3)",
    "hsl(0, 0%, 50% / 0.3)",
    "hsl(0 0% 50%, 0.3)",
  ] {
    assert!(!blink_rounds_hsl_alpha(float), "{float:?}");
  }
}
