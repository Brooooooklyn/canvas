//! CSSParserFastPaths::ParseColor (css_parser_fast_paths.cc:1094-1135): the
//! byte-level parser Blink tries before its CSS tokenizer, for `#hex`,
//! `rgb[a](…)` and `hsl[a](…)`. It rounds legacy channels and alpha to 8
//! bits, so a string it takes paints differently from the same color read by
//! the full parser.
//!
//! Blink also skips this path when V8 holds the string as two-byte (an ASCII
//! slice of a string that had a character above U+00FF). Node-API does not
//! expose that, so every string is treated as one-byte here.

use super::model::Color;

/// HTML spaces (IsHTMLSpace): what ParseCanvasColorString strips and the fast
/// path skips.
pub(crate) const HTML_SPACES: [char; 5] = [' ', '\t', '\n', '\x0c', '\r'];

fn is_html_space(c: u8) -> bool {
  matches!(c, b' ' | b'\t' | b'\n' | b'\x0c' | b'\r')
}

fn skip_html_spaces(chars: &[u8]) -> &[u8] {
  let n = chars.iter().take_while(|&&c| is_html_space(c)).count();
  &chars[n..]
}

/// FindLengthOfValidDouble (:296-381): digits with at most one '.', which
/// must not be the last character. The SIMD branch Chrome runs on 16+ bytes
/// can stop before such a '.' instead of returning 0; every caller then fails
/// on that '.', so the scalar rule gives the same results.
fn find_length_of_valid_double(chars: &[u8]) -> usize {
  let mut decimal_mark_seen = false;
  let mut valid_length = 0;
  for &c in chars {
    if !c.is_ascii_digit() {
      if !decimal_mark_seen && c == b'.' {
        decimal_mark_seen = true;
      } else {
        break;
      }
    }
    valid_length += 1;
  }
  if valid_length > 0 && chars[valid_length - 1] == b'.' {
    return 0;
  }
  valid_length
}

/// ParsePositiveDouble (:437-560): the length and the value. Only seven
/// decimals count. Chrome's x64 (SSE2) and arm64 (NEON) builds read the
/// decimals as one integer times `kDiv1e7` when at least seven bytes follow
/// the '.', else they divide by a power of ten.
fn parse_positive_double(chars: &[u8]) -> (usize, f64) {
  let length = find_length_of_valid_double(chars);
  if length == 0 {
    return (0, 0.0);
  }
  let mut position = 0;
  let mut local_value = 0.0f64;
  while position < length {
    if chars[position] == b'.' {
      break;
    }
    local_value = local_value * 10.0 + (chars[position] - b'0') as f64;
    position += 1;
  }
  position += 1;
  if position >= length {
    return (length, local_value);
  }
  const MAX_DECIMALS: usize = 7;
  let num_decimals = (length - position).min(MAX_DECIMALS);
  if chars.len() - position >= MAX_DECIMALS {
    // kDiv1e7, spelled as in Blink: the double just above 1e-7.
    #[allow(clippy::excessive_precision)]
    const DIV_1E7: f64 = 0.000000100000000000000009;
    let mut fraction: u32 = 0;
    for i in 0..MAX_DECIMALS {
      let digit = if i < num_decimals {
        (chars[position + i] - b'0') as u32
      } else {
        0
      };
      fraction = fraction * 10 + digit;
    }
    return (length, local_value + fraction as f64 * DIV_1E7);
  }
  let mut fraction = 0.0f64;
  let mut scale = 1.0f64;
  for i in 0..num_decimals {
    fraction = fraction * 10.0 + (chars[position + i] - b'0') as f64;
    scale *= 10.0;
  }
  (length, local_value + fraction / scale)
}

/// ParseSimpleAngle (:183-229): the length (0 if no number), the value
/// (clamped to FLT_MAX) and the unit, read ASCII case-insensitively.
fn parse_simple_angle(chars: &[u8]) -> (usize, f64, AngleUnit) {
  let (number_length, number) = if chars.first() == Some(&b'-') {
    let (n, v) = parse_positive_double(&chars[1..]);
    if n == 0 {
      return (0, 0.0, AngleUnit::Number);
    }
    (n + 1, -v.min(f32::MAX as f64))
  } else {
    let (n, v) = parse_positive_double(chars);
    if n == 0 {
      return (0, 0.0, AngleUnit::Number);
    }
    (n, v.min(f32::MAX as f64))
  };
  let rest = &chars[number_length..];
  let starts =
    |unit: &[u8]| rest.len() >= unit.len() && rest.iter().zip(unit).all(|(&c, &u)| c | 0x20 == u);
  if starts(b"deg") {
    (number_length + 3, number, AngleUnit::Degrees)
  } else if starts(b"grad") {
    (number_length + 4, number, AngleUnit::Gradians)
  } else if starts(b"rad") {
    (number_length + 3, number, AngleUnit::Radians)
  } else if starts(b"turn") {
    (number_length + 4, number, AngleUnit::Turns)
  } else {
    (number_length, number, AngleUnit::Number)
  }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AngleUnit {
  Number,
  Degrees,
  Radians,
  Gradians,
  Turns,
}

/// ParseFloatWithMaxValue (:576-621): HTML spaces, an optional '-', digits
/// (the integer part saturates at `max_value`), an optional fraction.
/// Returns the value and whether it was negative.
fn parse_float_with_max_value(chars: &mut &[u8], max_value: i32) -> Option<(f64, bool)> {
  let mut current = skip_html_spaces(chars);
  let negative = current.first() == Some(&b'-');
  if negative {
    current = &current[1..];
  }
  if !current.first().is_some_and(u8::is_ascii_digit) {
    return None;
  }
  let mut value = 0.0f64;
  while let Some(&c) = current.first().filter(|c| c.is_ascii_digit()) {
    let new_value = value * 10.0 + (c - b'0') as f64;
    current = &current[1..];
    if new_value >= max_value as f64 {
      value = max_value as f64;
      let digits = current.iter().take_while(|c| c.is_ascii_digit()).count();
      current = &current[digits..];
      break;
    }
    value = new_value;
  }
  if current.first() == Some(&b'.') {
    let (length, fractional) = parse_positive_double(current);
    if length == 0 {
      return None;
    }
    current = &current[length..];
    value += fractional;
  }
  *chars = current;
  Some((value, negative))
}

/// kMustWhitespaceTerminate, kMustCharacterTerminate and
/// kCouldWhitespaceTerminate (:625-639).
#[derive(Clone, Copy, PartialEq, Eq)]
enum TerminatorStatus {
  MustWhitespace,
  MustCharacter,
  CouldWhitespace,
}

/// SkipToTerminator (:643-678).
fn skip_to_terminator(chars: &mut &[u8], terminator: u8, status: &mut TerminatorStatus) -> bool {
  let mut current = skip_html_spaces(chars);
  let skipped_space = current.len() != chars.len();
  match *status {
    TerminatorStatus::CouldWhitespace if current.first() == Some(&terminator) => {
      *status = TerminatorStatus::MustCharacter;
      current = &current[1..];
    }
    TerminatorStatus::CouldWhitespace | TerminatorStatus::MustWhitespace => {
      *status = TerminatorStatus::MustWhitespace;
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Expect {
  Unknown,
  Number,
  Percentage,
}

/// ParseColorNumberOrPercentage (:680-725): a channel as an int in [0, 255].
fn parse_color_number_or_percentage(
  chars: &mut &[u8],
  terminator: u8,
  status: &mut TerminatorStatus,
  expect: &mut Expect,
) -> Option<i32> {
  let mut current = *chars;
  let (mut value, negative) = parse_float_with_max_value(&mut current, 255)?;
  let &first = current.first()?;
  if (*expect == Expect::Percentage && first != b'%')
    || (*expect == Expect::Number && first == b'%')
  {
    return None;
  }
  if first == b'%' {
    *expect = Expect::Percentage;
    value = value / 100.0 * 255.0;
    if value > 255.0 {
      value = 255.0;
    }
    current = &current[1..];
  } else {
    *expect = Expect::Number;
  }
  if !skip_to_terminator(&mut current, terminator, status) {
    return None;
  }
  *chars = current;
  // lround: half away from zero.
  Some(if negative { 0 } else { value.round() as i32 })
}

/// ParsePercentage (:727-753): a percentage as [0, 1].
fn parse_percentage(
  chars: &mut &[u8],
  terminator: u8,
  status: &mut TerminatorStatus,
) -> Option<f64> {
  let mut current = *chars;
  let (value, negative) = parse_float_with_max_value(&mut current, 100)?;
  current = current.strip_prefix(b"%")?;
  let value = if negative {
    0.0
  } else {
    (value * 0.01).min(1.0)
  };
  if !skip_to_terminator(&mut current, terminator, status) {
    return None;
  }
  *chars = current;
  Some(value)
}

/// IsTenthAlpha (:755-768): "0.X" or ".X".
fn is_tenth_alpha(chars: &[u8]) -> bool {
  matches!(chars, [b'0', b'.', d] | [b'.', d] if d.is_ascii_digit())
}

/// ParseAlphaValue (:770-832): the alpha as an int in [0, 255]. The number
/// must end right before the terminator, which must be the last character.
fn parse_alpha_value(chars: &[u8], terminator: u8) -> Option<i32> {
  let mut chars = skip_html_spaces(chars);
  let negative = chars.first() == Some(&b'-');
  if negative {
    chars = &chars[1..];
  }
  let length = chars.len();
  if length < 2 || chars[length - 1] != terminator || !chars[length - 2].is_ascii_digit() {
    return None;
  }
  if !matches!(chars[0], b'0' | b'1' | b'.') {
    let double_length = find_length_of_valid_double(chars);
    if double_length > 0 && chars.get(double_length) == Some(&terminator) {
      return Some(if negative { 0 } else { 255 });
    }
    return None;
  }
  if length == 2 && chars[0] != b'.' {
    return Some(if !negative && chars[0] == b'1' {
      255
    } else {
      0
    });
  }
  if is_tenth_alpha(&chars[..length - 1]) {
    const TENTH_ALPHA_VALUES: [i32; 10] = [0, 26, 51, 77, 102, 128, 153, 179, 204, 230];
    return Some(if negative {
      0
    } else {
      TENTH_ALPHA_VALUES[(chars[length - 2] - b'0') as usize]
    });
  }
  let (double_length, alpha) = parse_positive_double(chars);
  if double_length == 0 || chars.get(double_length) != Some(&terminator) {
    return None;
  }
  Some(if negative {
    0
  } else {
    (alpha.min(1.0) * 255.0).round() as i32
  })
}

/// Color::ParseHexColor (color.cc:83-125): 3, 4, 6 or 8 hex digits.
pub(crate) fn parse_hex_color(name: &[u8]) -> Option<Color> {
  if !matches!(name.len(), 3 | 4 | 6 | 8) {
    return None;
  }
  let mut value: u32 = 0;
  for &c in name {
    value = (value << 4) | (c as char).to_digit(16)?;
  }
  Some(Color::from_rgba32(match name.len() {
    6 => 0xFF000000 | value,
    8 => value.rotate_right(8),
    4 => {
      (value & 0xF) << 28
        | (value & 0xF) << 24
        | (value & 0xF000) << 8
        | (value & 0xF000) << 4
        | (value & 0xF00) << 4
        | (value & 0xF00)
        | (value & 0xF0)
        | (value & 0xF0) >> 4
    }
    _ => {
      0xFF000000
        | (value & 0xF00) << 12
        | (value & 0xF00) << 8
        | (value & 0xF0) << 8
        | (value & 0xF0) << 4
        | (value & 0xF) << 4
        | (value & 0xF)
    }
  }))
}

/// FastParseColorInternal (:913-1086) in strict mode (no quirky hex: Chrome
/// 155 rejects `fillStyle = '123456'`, measured).
pub(crate) fn parse_color(s: &str) -> Option<Color> {
  let chars = s.as_bytes();
  if chars.len() >= 4 && chars[0] == b'#' {
    return parse_hex_color(&chars[1..]);
  }
  // MightBeRGBOrRGBA / MightBeHSLOrHSLA (:890-911): case-sensitive names.
  let function = |name: &[u8]| -> Option<&[u8]> {
    if chars.len() < 5 || !chars.starts_with(name) {
      return None;
    }
    match chars[3] {
      b'(' => Some(&chars[4..]),
      b'a' if chars[4] == b'(' => Some(&chars[5..]),
      _ => None,
    }
  };
  if let Some(mut current) = function(b"rgb") {
    let mut status = TerminatorStatus::CouldWhitespace;
    let mut expect = Expect::Unknown;
    let red = parse_color_number_or_percentage(&mut current, b',', &mut status, &mut expect)?;
    let green = parse_color_number_or_percentage(&mut current, b',', &mut status, &mut expect)?;
    let mut no_whitespace_check = TerminatorStatus::MustCharacter;
    let mut should_have_alpha = false;
    let blue = match parse_color_number_or_percentage(
      &mut current,
      b',',
      &mut no_whitespace_check,
      &mut expect,
    ) {
      Some(blue) => {
        if status != TerminatorStatus::MustCharacter {
          return None;
        }
        should_have_alpha = true;
        blue
      }
      None => {
        if let Some(blue) = parse_color_number_or_percentage(
          &mut current,
          b'/',
          &mut no_whitespace_check,
          &mut expect,
        ) {
          if status != TerminatorStatus::MustWhitespace {
            return None;
          }
          should_have_alpha = true;
          blue
        } else {
          parse_color_number_or_percentage(
            &mut current,
            b')',
            &mut no_whitespace_check,
            &mut expect,
          )?
        }
      }
    };
    if should_have_alpha {
      let alpha = parse_alpha_value(current, b')')?;
      return Some(Color::from_rgba(red, green, blue, alpha));
    }
    return current
      .is_empty()
      .then(|| Color::from_rgb(red, green, blue));
  }
  if let Some(current) = function(b"hsl") {
    let mut current = skip_html_spaces(current);
    let (hue_length, mut hue, unit) = parse_simple_angle(current);
    if hue_length == 0 {
      return None;
    }
    // blink::Rad2deg / Grad2deg (math_extras.h:68-76).
    match unit {
      AngleUnit::Number | AngleUnit::Degrees => {}
      AngleUnit::Radians => hue *= 180.0 / std::f64::consts::PI,
      AngleUnit::Gradians => hue *= 360.0 / 400.0,
      AngleUnit::Turns => hue *= 360.0,
    }
    if hue < 0.0 {
      hue = hue % 360.0 + 360.0;
    } else if hue > 360.0 {
      hue %= 360.0;
    }
    current = &current[hue_length..];
    let mut status = TerminatorStatus::CouldWhitespace;
    if !skip_to_terminator(&mut current, b',', &mut status) {
      return None;
    }
    let saturation = parse_percentage(&mut current, b',', &mut status)?;
    let mut no_whitespace_check = TerminatorStatus::MustCharacter;
    let mut should_have_alpha = false;
    let lightness = match parse_percentage(&mut current, b',', &mut no_whitespace_check) {
      Some(lightness) => {
        if status != TerminatorStatus::MustCharacter {
          return None;
        }
        should_have_alpha = true;
        lightness
      }
      None => {
        if let Some(lightness) = parse_percentage(&mut current, b'/', &mut no_whitespace_check) {
          if status != TerminatorStatus::MustWhitespace {
            return None;
          }
          should_have_alpha = true;
          lightness
        } else {
          parse_percentage(&mut current, b')', &mut no_whitespace_check)?
        }
      }
    };
    let alpha = if should_have_alpha {
      // ParseAlphaValue consumes everything it accepts.
      parse_alpha_value(current, b')')? as f32 * (1.0f32 / 255.0f32)
    } else {
      if !current.is_empty() {
        return None;
      }
      1.0
    };
    return Some(Color::from_color_space(
      super::model::ColorSpace::Hsl,
      Some(hue as f32),
      Some(saturation as f32),
      Some(lightness as f32),
      Some(alpha),
    ));
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fast_path_quantizes_like_blink() {
    let rgba = |s: &str| parse_color(s).map(|c| (c.params(), (c.alpha() * 255.0).round() as i32));
    assert_eq!(
      rgba("rgb(10.6, 20.4, 30.5)"),
      Some(([11.0, 20.0, 31.0], 255))
    );
    assert_eq!(rgba("rgb(12.75% 0% 0%)"), Some(([33.0, 0.0, 0.0], 255)));
    // The fast path takes all numbers or all percentages.
    assert_eq!(rgba("rgb(12.75% 0 0)"), None);
    assert_eq!(rgba("rgb(0 0 0 / 0.3)"), Some(([0.0; 3], 77)));
    assert_eq!(rgba("rgba(0,0,0,.31)"), Some(([0.0; 3], 79)));
    assert_eq!(rgba("rgb(1 2 3 / 0.999)"), Some(([1.0, 2.0, 3.0], 255)));
    assert_eq!(rgba("rgb( 1 2 3 / 0.999 )"), None);
    assert_eq!(rgba("RGB(1, 2, 3)"), None);
    assert_eq!(rgba("rgb(1. 2 3)"), None);
    assert_eq!(rgba("rgb(1,2,3,)"), None);
    assert_eq!(rgba("#abcd"), Some(([170.0, 187.0, 204.0], 221)));
    let hsl = parse_color("hsl(120, 100%, 50%, 0.3)").unwrap();
    assert_eq!(hsl.alpha(), 77.0 * (1.0f32 / 255.0));
    assert_eq!(parse_color("HSL(120, 100%, 50%, 0.3)"), None);
  }

  #[test]
  #[allow(clippy::excessive_precision)]
  fn decimals_use_the_seven_digit_integer_when_seven_bytes_follow() {
    // ".5" with seven or more bytes after the '.': 5000000 * kDiv1e7.
    assert_eq!(
      parse_positive_double(b"0.5)     "),
      (3, 5000000.0 * 0.000000100000000000000009)
    );
    assert_eq!(parse_positive_double(b"0.5)"), (3, 0.5));
  }
}
