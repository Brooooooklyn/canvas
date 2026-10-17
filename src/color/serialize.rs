//! Color::SerializeAsCanvasColor (color.cc:1010-1102) and the WTF number
//! formatting it uses (String::Number(double, precision) =
//! NumberToFixedPrecisionString, wtf/dtoa.cc).

use super::convert;
use super::model::{Color, ColorSpace};

/// double-conversion `ToPrecision` with Blink's EcmaScript converter
/// (`e` exponent with an explicit `+`, at most 6 leading zeros, no trailing
/// padding zeros), then FormatStringTruncatingTrailingZerosIfNeeded: trailing
/// zeros and a bare `.` are stripped only when there is no exponent.
///
/// The digits are the exact binary value rounded half-up at `precision`
/// significant digits, like bignum-dtoa does (`16.40625` -> `16.4063`).
pub(crate) fn number_to_fixed_precision(value: f64, precision: usize) -> String {
  if value.is_nan() {
    return "NaN".to_owned();
  }
  if value.is_infinite() {
    return if value < 0.0 { "-Infinity" } else { "Infinity" }.to_owned();
  }
  let mut out = String::new();
  // UNIQUE_ZERO: -0 prints as 0.
  if value < 0.0 {
    out.push('-');
  }
  let (digits, decimal_point) = precision_digits(value.abs(), precision);
  let exponent = decimal_point - 1;
  let precision = precision as i32;
  let as_exponential = -decimal_point + 1 > 6 || decimal_point - precision > 0;
  if as_exponential {
    let mut digits = digits;
    while (digits.len() as i32) < precision {
      digits.push(b'0');
    }
    out.push(digits[0] as char);
    if digits.len() != 1 {
      out.push('.');
      out.push_str(std::str::from_utf8(&digits[1..]).unwrap());
    }
    out.push('e');
    out.push(if exponent < 0 { '-' } else { '+' });
    out.push_str(&exponent.abs().to_string());
    return out;
  }
  let length = digits.len() as i32;
  let digits_after_point = (precision - decimal_point).max(0);
  let text = std::str::from_utf8(&digits).unwrap();
  if decimal_point <= 0 {
    out.push('0');
    if digits_after_point > 0 {
      out.push('.');
      out.extend(std::iter::repeat_n('0', (-decimal_point) as usize));
      out.push_str(text);
      let remaining = digits_after_point - (-decimal_point) - length;
      out.extend(std::iter::repeat_n('0', remaining.max(0) as usize));
    }
  } else if decimal_point >= length {
    out.push_str(text);
    out.extend(std::iter::repeat_n('0', (decimal_point - length) as usize));
    if digits_after_point > 0 {
      out.push('.');
      out.extend(std::iter::repeat_n('0', digits_after_point as usize));
    }
  } else {
    out.push_str(&text[..decimal_point as usize]);
    out.push('.');
    out.push_str(&text[decimal_point as usize..]);
    let remaining = digits_after_point - (length - decimal_point);
    out.extend(std::iter::repeat_n('0', remaining.max(0) as usize));
  }
  if out.contains('.') {
    let trimmed = out.trim_end_matches('0').trim_end_matches('.').len();
    out.truncate(trimmed);
  }
  out
}

/// The first `precision` significant digits of `value` (> 0 or 0), rounded
/// half-up on the exact binary value, and the decimal point position
/// (digits `d1 d2 ..` mean `0.d1d2.. * 10^decimal_point`). Trailing zeros of
/// the digit string are kept only up to the first non-zero (DoubleToAscii may
/// return fewer digits than asked).
fn precision_digits(value: f64, precision: usize) -> (Vec<u8>, i32) {
  if value == 0.0 {
    return (vec![b'0'], 1);
  }
  // `{:e}` with enough digits prints the exact binary value (a double has at
  // most 767 significant decimal digits).
  let exact = format!("{value:.800e}");
  let (mantissa, exponent) = exact.split_once('e').unwrap();
  let exponent: i32 = exponent.parse().unwrap();
  let mut digits: Vec<u8> = mantissa.bytes().filter(|b| b.is_ascii_digit()).collect();
  while digits.len() > 1 && digits.last() == Some(&b'0') {
    digits.pop();
  }
  let mut decimal_point = exponent + 1;
  if digits.len() > precision {
    let round_up = digits[precision] >= b'5';
    digits.truncate(precision);
    if round_up {
      let mut i = precision;
      loop {
        if i == 0 {
          digits.insert(0, b'1');
          digits.truncate(precision);
          decimal_point += 1;
          break;
        }
        i -= 1;
        if digits[i] == b'9' {
          digits[i] = b'0';
        } else {
          digits[i] += 1;
          break;
        }
      }
    }
    while digits.len() > 1 && digits.last() == Some(&b'0') {
      digits.pop();
    }
  }
  (digits, decimal_point)
}

/// String::Number(double): the shortest round-trip form (EcmaScript
/// `ToShortest`), used for integers here.
fn number_shortest(value: f64) -> String {
  if value.is_nan() {
    return "NaN".to_owned();
  }
  if value == 0.0 {
    return "0".to_owned();
  }
  // Only integral values in [0, 255] reach this.
  format!("{value}")
}

/// ColorParamToString (color.cc:991-1008).
fn color_param_to_string(param: f32, precision: usize) -> String {
  if !param.is_finite() {
    let inner = if param.is_infinite() {
      if param < 0.0 { "-infinity" } else { "infinity" }.to_owned()
    } else {
      number_to_fixed_precision(param as f64, precision)
    };
    return format!("calc({inner})");
  }
  number_to_fixed_precision(param as f64, precision)
}

/// ClampTo<double>(v, lo, hi) from a float: NaN stays NaN.
fn clamp_to(v: f64, lo: f64, hi: f64) -> f64 {
  if v >= hi {
    hi
  } else if v <= lo {
    lo
  } else {
    v
  }
}

impl Color {
  /// Color::SerializeAsCanvasColor (color.cc:1010-1016).
  pub(crate) fn serialize_as_canvas_color(&self) -> String {
    if self.is_opaque() && self.space.is_legacy() {
      let rgb = self.rgb();
      return format!(
        "#{:02x}{:02x}{:02x}",
        (rgb >> 16) & 0xFF,
        (rgb >> 8) & 0xFF,
        rgb & 0xFF
      );
    }
    if self.space.is_legacy() {
      self.serialize_legacy()
    } else {
      self.serialize_internal()
    }
  }

  /// Color::SerializeLegacyColorAsCSSColor (color.cc:1018-1074).
  fn serialize_legacy(&self) -> String {
    const EPSILON: f32 = 1e-7;
    let mut result = String::from(if self.is_opaque() && self.alpha.is_finite() {
      "rgb("
    } else {
      "rgba("
    });
    let [mut r, mut g, mut b] = self.p;
    if matches!(self.space, ColorSpace::Hsl | ColorSpace::Hwb) {
      let [sr, sg, sb] = self.to_srgb();
      [r, g, b] = convert::srgb_to_srgb_legacy(sr + EPSILON, sg + EPSILON, sb + EPSILON);
    }
    let channel = |v: f32| number_shortest(clamp_to(v as f64, 0.0, 255.0).round());
    result.push_str(&channel(r));
    result.push_str(", ");
    result.push_str(&channel(g));
    result.push_str(", ");
    result.push_str(&channel(b));
    if !self.is_opaque() {
      result.push_str(", ");
      let int_alpha = clamp_to(((self.alpha + EPSILON) as f64 * 255.0).round(), 0.0, 255.0) as i32;
      let two = ((int_alpha as f64 * 100.0 / 255.0).round() / 100.0) as f32;
      if (two * 255.0).round() == int_alpha as f32 {
        result.push_str(&color_param_to_string(two, 2));
      } else {
        let three = ((int_alpha as f64 * 1000.0 / 255.0).round() / 1000.0) as f32;
        result.push_str(&color_param_to_string(three, 3));
      }
    }
    result.push(')');
    result
  }

  /// Color::SerializeInternal (color.cc:1076-1102).
  fn serialize_internal(&self) -> String {
    let mut result = String::new();
    if self.space.is_lightness_first() {
      result.push_str(self.space.name());
      result.push('(');
    } else {
      result.push_str("color(");
      result.push_str(self.space.name());
      result.push(' ');
    }
    for i in 0..3 {
      if i > 0 {
        result.push(' ');
      }
      if self.none[i] {
        result.push_str("none");
      } else {
        result.push_str(&color_param_to_string(self.p[i], 6));
      }
    }
    if self.alpha != 1.0 || self.alpha_none {
      result.push_str(" / ");
      if self.alpha_none {
        result.push_str("none");
      } else {
        result.push_str(&number_to_fixed_precision(self.alpha as f64, 6));
      }
    }
    result.push(')');
    result
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  #[allow(clippy::excessive_precision)]
  fn param_to_string_matches_wtf() {
    for (v, expected) in [
      (1e-10_f32, "1.00000e-10"),
      (123456789.0, "1.23457e+8"),
      (-6.85395e-9, "-6.85395e-9"),
      (0.123456789, "0.123457"),
      (50.123456789, "50.1235"),
      (359.9999999, "360"),
      (0.5, "0.5"),
      (1.0, "1"),
      (0.0, "0"),
      (-0.0, "0"),
      (16.40625, "16.4063"),
      (0.1234375, "0.123438"),
      (2.0078125, "2.00781"),
      (0.0048828125, "0.00488281"),
      (0.00390625, "0.00390625"),
      (999999.5, "1.00000e+6"),
      (0.000001, "0.000001"),
      (0.0000001, "1.00000e-7"),
      (f32::INFINITY, "calc(infinity)"),
      (f32::NEG_INFINITY, "calc(-infinity)"),
      (f32::NAN, "calc(NaN)"),
    ] {
      assert_eq!(color_param_to_string(v, 6), expected, "{v:e}");
    }
  }

  #[test]
  fn legacy_alpha_two_or_three_decimals() {
    let c = Color::from_rgba32(0xDDAABBCC);
    assert_eq!(c.serialize_as_canvas_color(), "rgba(170, 187, 204, 0.867)");
    let c = Color::from_rgba32(0x80AABBCC);
    assert_eq!(c.serialize_as_canvas_color(), "rgba(170, 187, 204, 0.5)");
    let c = Color::from_rgba32(0xFFAABBCC);
    assert_eq!(c.serialize_as_canvas_color(), "#aabbcc");
  }
}
