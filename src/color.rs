//! The colors of fillStyle, strokeStyle and shadowColor: Blink's
//! ParseCanvasColorString (canvas_style.cc) for the syntaxes cssparser-color
//! reads, and Color::SerializeAsCanvasColor (color.cc) for the getters.

use cssparser::{ParseError, Parser, Token};
use cssparser_color::Color as CSSColor;
use rgb::RGBA;

use crate::error::SkError;
use crate::gradient::blink_fast_path::{
  HTML_SPACES, TerminatorStatus, parse_alpha_value, parse_float_with_max_value, skip_to_terminator,
};
use crate::gradient::blink_rounds_hsl_alpha;
use crate::pattern::{hsl_to_srgb, srgb_channel_to_u8};

/// The color space Blink keeps a parsed color in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ColorModel {
  /// rgb(), hex and named colors: channels in [0, 255].
  SrgbLegacy,
  /// hsl(): hue in degrees, saturation and lightness in [0, 1].
  Hsl,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CanvasColor {
  model: ColorModel,
  params: [f32; 3],
  alpha: f32,
}

impl CanvasColor {
  /// Blink's ParseCanvasColorString: the string without leading and trailing
  /// HTML spaces must be one color. A keyword must be the whole string
  /// (Color::SetNamedColor, or currentcolor, which is opaque black without an
  /// element); anything else may have comments and whitespace after it
  /// (CSSParser::ParseSingleValue).
  pub(crate) fn parse(source: &str) -> Result<Self, SkError> {
    let invalid = || SkError::Generic(format!("Invalid canvas color [{source}]"));
    let s = source.trim_matches(HTML_SPACES);
    let first = Parser::new(s).next().cloned();
    let mut parser = Parser::new(s);
    let color = CSSColor::parse(&mut parser).map_err(|_| invalid())?;
    parser.expect_exhausted().map_err(|_| invalid())?;
    if matches!(first, Ok(Token::Ident(_))) && !s.bytes().all(|b| b.is_ascii_alphabetic()) {
      return Err(invalid());
    }
    let quantize = |alpha: f32| (alpha * 255.0).round() / 255.0;
    match color {
      CSSColor::CurrentColor => Ok(Self {
        model: ColorModel::SrgbLegacy,
        params: [0.0; 3],
        alpha: 1.0,
      }),
      CSSColor::Rgba(c) => {
        // Hex and named colors have an 8-bit alpha. Of rgb(), the CSS fast
        // path and the legacy (comma) syntax store an 8-bit alpha; the full
        // parser keeps the float for the modern syntax
        // (css_parser_fast_paths.cc, CSSColorQuantizedAlphaOnlyLegacy).
        let eight_bit = match first {
          Ok(Token::Function(_)) => has_top_level_comma(s) || blink_rgb_fast_path(s),
          _ => true,
        };
        Ok(Self {
          model: ColorModel::SrgbLegacy,
          params: [c.red as f32, c.green as f32, c.blue as f32],
          alpha: if eight_bit {
            quantize(c.alpha)
          } else {
            c.alpha
          },
        })
      }
      CSSColor::Hsl(h) => {
        // cssparser-color gives None for the `none` keyword only.
        let alpha = h.alpha.unwrap_or(0.0);
        Ok(Self {
          model: ColorModel::Hsl,
          params: [
            h.hue.unwrap_or(0.0),
            h.saturation.unwrap_or(0.0),
            h.lightness.unwrap_or(0.0),
          ],
          alpha: if blink_rounds_hsl_alpha(s) {
            quantize(alpha)
          } else {
            alpha
          },
        })
      }
      _ => Err(SkError::Generic("Unsupported color format".to_owned())),
    }
  }

  fn to_srgb(self) -> [f32; 3] {
    match self.model {
      ColorModel::SrgbLegacy => self.params.map(|v| v / 255.0),
      ColorModel::Hsl => hsl_to_srgb(self.params[0], self.params[1], self.params[2]),
    }
  }

  /// The 8-bit color the CPU canvas paints with.
  pub(crate) fn to_rgba8(self) -> RGBA<u8> {
    let [r, g, b] = match self.model {
      ColorModel::SrgbLegacy => self.params.map(|v| v as u8),
      ColorModel::Hsl => self.to_srgb().map(srgb_channel_to_u8),
    };
    RGBA {
      r,
      g,
      b,
      a: (self.alpha * 255.0).round() as u8,
    }
  }

  /// Color::SerializeAsCanvasColor: "#rrggbb" when opaque, else
  /// SerializeLegacyColorAsCSSColor (color.cc:1019-1075).
  pub(crate) fn serialize(self) -> String {
    if self.alpha >= 1.0 {
      let [r, g, b] = self.to_srgb().map(srgb_channel_to_u8);
      return format!("#{r:02x}{g:02x}{b:02x}");
    }
    const EPSILON: f32 = 1e-7;
    let rgb: [f64; 3] = match self.model {
      ColorModel::SrgbLegacy => self.params.map(f64::from),
      // gfx::SRGBToSRGBLegacy(v + kEpsilon): a float times 255.
      ColorModel::Hsl => self
        .to_srgb()
        .map(|v| f64::from((f64::from(v + EPSILON) * 255.0) as f32)),
    };
    let [r, g, b] = rgb.map(|v| v.clamp(0.0, 255.0).round() as i32);
    let int_alpha = (f64::from(self.alpha + EPSILON) * 255.0)
      .round()
      .clamp(0.0, 255.0) as i32;
    let two = ((f64::from(int_alpha) * 100.0 / 255.0).round() / 100.0) as f32;
    let alpha = if (two * 255.0).round() == int_alpha as f32 {
      format!("{:.2}", f64::from(two))
    } else {
      let three = ((f64::from(int_alpha) * 1000.0 / 255.0).round() / 1000.0) as f32;
      format!("{:.3}", f64::from(three))
    };
    let alpha = alpha.trim_end_matches('0').trim_end_matches('.');
    format!("rgba({r}, {g}, {b}, {alpha})")
  }
}

/// Whether the arguments of the color function `s` starts with have a comma
/// at their top level: the legacy rgb() syntax. Comments are not tokens.
fn has_top_level_comma(s: &str) -> bool {
  let mut parser = Parser::new(s);
  if !matches!(parser.next(), Ok(Token::Function(_))) {
    return false;
  }
  // parse_nested_block fails unless the closure reads the whole block.
  parser
    .parse_nested_block(|arguments| {
      let mut comma = false;
      while let Ok(token) = arguments.next() {
        comma |= matches!(token, Token::Comma);
      }
      Ok::<_, ParseError<()>>(comma)
    })
    .unwrap_or(false)
}

/// Whether Blink's CSS fast path takes this rgb()/rgba() spelling: the rgb()
/// half of FastParseColorInternal (css_parser_fast_paths.cc:913-978), on the
/// string stripped of HTML spaces. The fast path stores an 8-bit alpha. Like
/// `blink_rounds_hsl_alpha`, it treats every string as one-byte.
fn blink_rgb_fast_path(color: &str) -> bool {
  let chars = color.trim_matches(HTML_SPACES).as_bytes();
  // MightBeRGBOrRGBA (:890-899): a case-sensitive name.
  let Some(mut current) = chars
    .strip_prefix(b"rgba(")
    .or_else(|| chars.strip_prefix(b"rgb("))
  else {
    return false;
  };
  let mut terminator_status = TerminatorStatus::CouldWhitespace;
  let mut expect = Expect::Unknown;
  for _ in 0..2 {
    if !parse_color_number_or_percentage(&mut current, b',', &mut terminator_status, &mut expect) {
      return false;
    }
  }
  let mut no_whitespace_check = TerminatorStatus::MustCharacter;
  let should_have_alpha = if parse_color_number_or_percentage(
    &mut current,
    b',',
    &mut no_whitespace_check,
    &mut expect,
  ) {
    if terminator_status != TerminatorStatus::MustCharacter {
      return false;
    }
    true
  } else if parse_color_number_or_percentage(
    &mut current,
    b'/',
    &mut no_whitespace_check,
    &mut expect,
  ) {
    if terminator_status != TerminatorStatus::MustWhitespace {
      return false;
    }
    true
  } else if parse_color_number_or_percentage(
    &mut current,
    b')',
    &mut no_whitespace_check,
    &mut expect,
  ) {
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

/// The unit a fast-path rgb() list has committed to (CSSPrimitiveValue::UnitType).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Expect {
  Unknown,
  Number,
  Percentage,
}

/// ParseColorNumberOrPercentage (css_parser_fast_paths.cc:680-722): a number
/// or a percentage, the same unit as the channels before it, then the
/// terminator.
fn parse_color_number_or_percentage(
  chars: &mut &[u8],
  terminator: u8,
  terminator_status: &mut TerminatorStatus,
  expect: &mut Expect,
) -> bool {
  let Some(mut current) = parse_float_with_max_value(chars) else {
    return false;
  };
  let Some(&first) = current.first() else {
    return false;
  };
  if (*expect == Expect::Percentage && first != b'%')
    || (*expect == Expect::Number && first == b'%')
  {
    return false;
  }
  let new_expect = if first == b'%' {
    current = &current[1..];
    Expect::Percentage
  } else {
    Expect::Number
  };
  if !skip_to_terminator(&mut current, terminator, terminator_status) {
    return false;
  }
  *expect = new_expect;
  *chars = current;
  true
}

#[cfg(test)]
mod tests {
  use super::*;

  fn serialized(s: &str) -> Option<String> {
    CanvasColor::parse(s).ok().map(CanvasColor::serialize)
  }

  /// Chrome 155: `rgba(10, 20, 30, k / 255)` with the alpha written as JS
  /// prints k / 255.
  #[test]
  fn serialize_alpha_edges_match_chrome() {
    for (alpha, expected) in [
      ("0", "rgba(10, 20, 30, 0)"),
      ("0.00392156862745098", "rgba(10, 20, 30, 0.004)"),
      ("0.00784313725490196", "rgba(10, 20, 30, 0.008)"),
      ("0.25098039215686274", "rgba(10, 20, 30, 0.25)"),
      ("0.4980392156862745", "rgba(10, 20, 30, 0.498)"),
      ("0.5019607843137255", "rgba(10, 20, 30, 0.5)"),
      ("0.5333333333333333", "rgba(10, 20, 30, 0.533)"),
      ("0.996078431372549", "rgba(10, 20, 30, 0.996)"),
      ("1", "#0a141e"),
    ] {
      assert_eq!(
        serialized(&format!("rgba(10, 20, 30, {alpha})")).as_deref(),
        Some(expected),
        "{alpha}"
      );
    }
  }

  /// Chrome 155: the full parser keeps a modern rgb() alpha as a float; a
  /// comma in a comment does not make the syntax legacy.
  #[test]
  fn legacy_syntax_is_read_from_tokens() {
    for (s, expected) in [
      ("rgb(1 2 3 / 0.999)", "#010203"),
      ("rgb( 1 2 3 / 0.999 )", "rgba(1, 2, 3, 1)"),
      ("rgba(1,2,3,0.999 )", "#010203"),
      ("rgb(1 2 3 / 0.999)/*,*/", "rgba(1, 2, 3, 1)"),
      ("rgb(1 2 3 / /*,*/ 0.999)", "rgba(1, 2, 3, 1)"),
      ("rgb(1/*,*/2 3 / 0.999)", "rgba(1, 2, 3, 1)"),
    ] {
      assert_eq!(serialized(s).as_deref(), Some(expected), "{s:?}");
    }
  }

  #[test]
  fn keywords_must_be_the_whole_string() {
    assert_eq!(serialized("currentColor").as_deref(), Some("#000000"));
    assert_eq!(serialized(" hotpink\n").as_deref(), Some("#ff69b4"));
    for s in [
      "red/**/",
      "/**/red",
      "re\\64",
      "currentcolor x",
      "red blue",
      "\u{b}red",
    ] {
      assert_eq!(serialized(s), None, "{s:?}");
    }
  }

  #[test]
  fn none_alpha_paints_transparent() {
    let c = CanvasColor::parse("hsl(0 50% 50% / none)").unwrap();
    assert_eq!(c.to_rgba8().a, 0);
    assert_eq!(c.serialize(), "rgba(191, 64, 64, 0)");
  }
}
