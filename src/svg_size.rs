//! The size of an SVG image as Chrome gives it to an `<img>` and to the
//! canvas: the root's `width`, `height` and `viewBox` make its natural sizing
//! info (layout_svg_root.cc UnscaledNaturalSizingInfo, svg_image.cc
//! GetNaturalDimensions), and CSS default sizing against a default object
//! size turns that into a concrete size (natural_sizing_info.cc
//! ConcreteObjectSize): 300x150 for `naturalWidth`/`naturalHeight`, the
//! canvas size for drawImage and createPattern.

use cssparser::{ParseError, Parser, Token};

/// The font-relative units of the root: Chrome's default font at 16px.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FontUnits {
  pub x_height: f32,
  pub zero_advance: f32,
  pub cap_height: f32,
  pub line_spacing: f32,
}

impl FontUnits {
  const FONT_SIZE: f32 = 16.0;

  /// The CSS fallbacks for a font without these metrics: 0.5em for ex and
  /// ch; Chrome's default font is always installed, so the cap height and
  /// line spacing only need sane values.
  pub(crate) fn fallback() -> Self {
    FontUnits {
      x_height: 8.0,
      zero_advance: 8.0,
      cap_height: 11.0,
      line_spacing: 18.0,
    }
  }

  /// `metrics` as `FontCollection::default_font_metrics` returns them.
  pub(crate) fn from_metrics(metrics: Option<[f32; 4]>) -> Self {
    match metrics {
      Some([x_height, zero_advance, cap_height, line_spacing]) => FontUnits {
        x_height,
        zero_advance,
        cap_height,
        line_spacing,
      },
      None => Self::fallback(),
    }
  }
}

/// Blink's NaturalSizingInfo of an SVG image: the root width and height
/// that are not percentages, and the aspect ratio (of those, or of the
/// viewBox).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SvgSizing {
  width: Option<f32>,
  height: Option<f32>,
  ratio: Option<(f32, f32)>,
}

/// The largest CSS length, as a float (kMaxValueForCssLength, 33554429).
const MAX_CSS_LENGTH: f64 = 33_554_429.0;

impl SvgSizing {
  /// The sizing info from the raw root attributes.
  pub(crate) fn from_attributes(
    width: Option<&str>,
    height: Option<&str>,
    view_box: Option<&str>,
    preserve_aspect_ratio: Option<&str>,
    font: &FontUnits,
  ) -> Self {
    let width = width.and_then(|value| root_length(value, font));
    let height = height.and_then(|value| root_length(value, font));
    let size = (width.unwrap_or(0.0), height.unwrap_or(0.0));
    let ratio = if size.0 > 0.0 && size.1 > 0.0 {
      Some(size)
    } else {
      view_box
        .and_then(parse_view_box)
        .filter(|&(w, h)| w > 0.0 && h > 0.0)
    };
    // Without SvgSizingWithPreserveAspectRatioNone (experimental in Chrome
    // 155), preserveAspectRatio="none" drops everything unless both sides
    // are known.
    if (width.is_none() || height.is_none())
      && preserve_aspect_ratio.is_some_and(aspect_ratio_is_none)
    {
      return SvgSizing {
        width: None,
        height: None,
        ratio: None,
      };
    }
    SvgSizing {
      width,
      height,
      ratio,
    }
  }

  /// CSS default sizing (natural_sizing_info.cc ConcreteObjectSizeImpl), in
  /// floats like Blink.
  pub(crate) fn concrete(&self, (default_width, default_height): (f32, f32)) -> (f32, f32) {
    let height_for = |width: f32, (rw, rh): (f32, f32)| width * rh / rw;
    let width_for = |height: f32, (rw, rh): (f32, f32)| height * rw / rh;
    match (self.width, self.height, self.ratio) {
      (Some(width), Some(height), _) => (width, height),
      (Some(width), None, Some(ratio)) => (width, height_for(width, ratio)),
      (Some(width), None, None) => (width, default_height),
      (None, Some(height), Some(ratio)) => (width_for(height, ratio), height),
      (None, Some(height), None) => (default_width, height),
      (None, None, Some(ratio)) => {
        let width = width_for(default_height, ratio);
        if width <= default_width {
          (width, default_height)
        } else {
          (default_width, height_for(default_width, ratio))
        }
      }
      (None, None, None) => (default_width, default_height),
    }
  }

  /// The natural width, height and aspect ratio (width, height).
  pub(crate) fn parts(&self) -> (Option<f32>, Option<f32>, Option<(f32, f32)>) {
    (self.width, self.height, self.ratio)
  }

  /// naturalWidth and naturalHeight (image_loader.cc
  /// DensityCorrectedNaturalSize): the concrete size against 300x150,
  /// floored to a LayoutUnit, then rounded.
  pub(crate) fn natural(&self) -> (u32, u32) {
    let (width, height) = self.concrete((300.0, 150.0));
    (
      layout_floor(width).round() as u32,
      layout_floor(height).round() as u32,
    )
  }
}

/// LayoutUnit::FromFloatFloor and back: floored to 1/64 and saturated.
pub(crate) fn layout_floor(value: f32) -> f32 {
  let raw = (value * 64.0).floor();
  // saturated_cast<int>; NaN is 0.
  let raw = if raw.is_nan() {
    0.0
  } else {
    raw.clamp(i32::MIN as f32, i32::MAX as f32)
  };
  // The int raw value, as a float, over 64.
  (raw as i32) as f32 / 64.0
}

fn is_svg_space(c: u8) -> bool {
  matches!(c, b' ' | b'\t' | b'\n' | b'\x0c' | b'\r')
}

/// svg_parser_utilities.cc GenericParseNumber in float, from `*pos`.
fn parse_svg_number(input: &[u8], pos: &mut usize, trailing: bool) -> Option<f32> {
  let mut i = *pos;
  while i < input.len() && is_svg_space(input[i]) {
    i += 1;
  }
  let mut sign = 1.0f32;
  if i < input.len() && (input[i] == b'+' || input[i] == b'-') {
    if input[i] == b'-' {
      sign = -1.0;
    }
    i += 1;
  }
  if i >= input.len() || !(input[i].is_ascii_digit() || input[i] == b'.') {
    return None;
  }
  let digits_start = i;
  while i < input.len() && input[i].is_ascii_digit() {
    i += 1;
  }
  let mut integer = 0f32;
  let mut multiplier = 1f32;
  for &digit in input[digits_start..i].iter().rev() {
    integer += multiplier * (digit - b'0') as f32;
    multiplier *= 10.0;
  }
  if !integer.is_finite() {
    return None;
  }
  let mut decimal = 0f32;
  if i < input.len() && input[i] == b'.' {
    i += 1;
    if i >= input.len() || !input[i].is_ascii_digit() {
      return None;
    }
    let mut frac = 1f32;
    while i < input.len() && input[i].is_ascii_digit() {
      frac *= 0.1;
      decimal += (input[i] - b'0') as f32 * frac;
      i += 1;
    }
  }
  let mut number = (integer + decimal) * sign;
  if input.len() - i > 1
    && (input[i] == b'e' || input[i] == b'E')
    && input[i + 1] != b'x'
    && input[i + 1] != b'm'
  {
    i += 1;
    let mut negative = false;
    if input[i] == b'+' || input[i] == b'-' {
      negative = input[i] == b'-';
      i += 1;
    }
    if i >= input.len() || !input[i].is_ascii_digit() {
      return None;
    }
    let mut exponent = 0f32;
    while i < input.len() && input[i].is_ascii_digit() {
      exponent = exponent * 10.0 + (input[i] - b'0') as f32;
      i += 1;
    }
    if negative {
      exponent = -exponent;
    }
    // FLT_MAX_10_EXP
    if exponent > 38.0 {
      return None;
    }
    if exponent != 0.0 {
      number *= 10f64.powf(exponent as f64) as f32;
    }
  }
  if !number.is_finite() {
    return None;
  }
  if trailing {
    // SkipOptionalSVGSpacesOrDelimiter: spaces, one comma, spaces.
    if i < input.len() && (is_svg_space(input[i]) || input[i] == b',') {
      while i < input.len() && is_svg_space(input[i]) {
        i += 1;
      }
      if i < input.len() && input[i] == b',' {
        i += 1;
        while i < input.len() && is_svg_space(input[i]) {
          i += 1;
        }
      }
    }
  }
  *pos = i;
  Some(number)
}

/// The size of a viewBox (svg_rect.cc SVGRect::Parse), None when it does
/// not parse.
fn parse_view_box(value: &str) -> Option<(f32, f32)> {
  let input = value.as_bytes();
  let mut pos = 0;
  parse_svg_number(input, &mut pos, true)?;
  parse_svg_number(input, &mut pos, true)?;
  let width = parse_svg_number(input, &mut pos, true)?;
  let height = parse_svg_number(input, &mut pos, false)?;
  if input[pos..].iter().any(|&c| !is_svg_space(c)) {
    return None;
  }
  Some((width, height))
}

/// Whether a preserveAspectRatio value parses with the align `none`
/// (svg_preserve_aspect_ratio.cc ParseInternal).
fn aspect_ratio_is_none(value: &str) -> bool {
  let skip_spaces = |s: &[u8]| -> usize { s.iter().take_while(|&&c| is_svg_space(c)).count() };
  let mut input = value.as_bytes();
  input = &input[skip_spaces(input)..];
  let Some(rest) = input.strip_prefix(b"none") else {
    return false;
  };
  let mut rest = &rest[skip_spaces(rest)..];
  if let Some(after) = rest
    .strip_prefix(b"meet")
    .or_else(|| rest.strip_prefix(b"slice"))
  {
    rest = &after[skip_spaces(after)..];
  } else if matches!(rest.first(), Some(b'm' | b's')) {
    return false;
  }
  rest.is_empty()
}

/// A calc() value: a number, or a length in px plus a percentage.
#[derive(Debug, Clone, Copy)]
enum Calc {
  Number(f64),
  Length { px: f64, percent: f64, has_px: bool },
}

#[derive(Debug, Clone)]
enum CalcNode {
  Leaf(Calc),
  Sum(Box<CalcNode>, Box<CalcNode>, bool),
  Product(Box<CalcNode>, Box<CalcNode>, bool),
  Min(Vec<CalcNode>),
  Max(Vec<CalcNode>),
  Clamp(Box<[CalcNode; 3]>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum CalcType {
  Number,
  Length,
}

impl CalcNode {
  fn calc_type(&self) -> Option<CalcType> {
    match self {
      CalcNode::Leaf(Calc::Number(_)) => Some(CalcType::Number),
      CalcNode::Leaf(Calc::Length { .. }) => Some(CalcType::Length),
      CalcNode::Sum(a, b, _) => {
        let t = a.calc_type()?;
        (b.calc_type()? == t).then_some(t)
      }
      CalcNode::Product(a, b, divide) => match (a.calc_type()?, b.calc_type()?) {
        (CalcType::Number, CalcType::Number) => Some(CalcType::Number),
        (CalcType::Length, CalcType::Number) => Some(CalcType::Length),
        (CalcType::Number, CalcType::Length) if !divide => Some(CalcType::Length),
        _ => None,
      },
      CalcNode::Min(args) | CalcNode::Max(args) => {
        let t = args.first()?.calc_type()?;
        args
          .iter()
          .all(|arg| arg.calc_type() == Some(t))
          .then_some(t)
      }
      CalcNode::Clamp(args) => {
        let t = args[0].calc_type()?;
        args
          .iter()
          .all(|arg| arg.calc_type() == Some(t))
          .then_some(t)
      }
    }
  }

  /// Whether every length leaf is a bare percentage (the value then counts
  /// as a percentage: SVGLength::IsPercentage).
  fn only_percentages(&self) -> bool {
    match self {
      CalcNode::Leaf(Calc::Number(_)) => true,
      CalcNode::Leaf(Calc::Length { has_px, .. }) => !has_px,
      CalcNode::Sum(a, b, _) | CalcNode::Product(a, b, _) => {
        a.only_percentages() && b.only_percentages()
      }
      CalcNode::Min(args) | CalcNode::Max(args) => args.iter().all(CalcNode::only_percentages),
      CalcNode::Clamp(args) => args.iter().all(CalcNode::only_percentages),
    }
  }

  /// The value in px, a percentage being of `base`.
  fn evaluate(&self, base: f64) -> f64 {
    match self {
      CalcNode::Leaf(Calc::Number(n)) => *n,
      CalcNode::Leaf(Calc::Length { px, percent, .. }) => {
        if *percent == 0.0 {
          *px
        } else {
          px + percent / 100.0 * base
        }
      }
      CalcNode::Sum(a, b, subtract) => {
        let (a, b) = (a.evaluate(base), b.evaluate(base));
        if *subtract { a - b } else { a + b }
      }
      CalcNode::Product(a, b, divide) => {
        let (a, b) = (a.evaluate(base), b.evaluate(base));
        if *divide { a / b } else { a * b }
      }
      CalcNode::Min(args) => args
        .iter()
        .map(|arg| arg.evaluate(base))
        .fold(f64::INFINITY, f64::min),
      CalcNode::Max(args) => args
        .iter()
        .map(|arg| arg.evaluate(base))
        .fold(f64::NEG_INFINITY, f64::max),
      CalcNode::Clamp(args) => {
        let [low, value, high] = [0, 1, 2].map(|i| args[i].evaluate(base));
        value.min(high).max(low)
      }
    }
  }
}

/// px per unit for a CSS length unit (ASCII case-insensitive), Chrome's
/// values for an SVG image root: 96 dpi, a 16px default font, and no
/// viewport or container (those units are 0).
fn unit_px(unit: &str, font: &FontUnits) -> Option<f64> {
  let unit = unit.to_ascii_lowercase();
  let em = FontUnits::FONT_SIZE as f64;
  Some(match unit.as_str() {
    "px" => 1.0,
    "cm" => 96.0 / 2.54,
    "mm" => 96.0 / 25.4,
    "q" => 96.0 / 101.6,
    "in" => 96.0,
    "pt" => 96.0 / 72.0,
    "pc" => 16.0,
    "em" | "rem" | "ic" | "ric" => em,
    "ex" | "rex" => font.x_height as f64,
    "ch" | "rch" => font.zero_advance as f64,
    "cap" | "rcap" => font.cap_height as f64,
    "lh" | "rlh" => font.line_spacing as f64,
    "vw" | "vh" | "vi" | "vb" | "vmin" | "vmax" | "svw" | "svh" | "svi" | "svb" | "svmin"
    | "svmax" | "lvw" | "lvh" | "lvi" | "lvb" | "lvmin" | "lvmax" | "dvw" | "dvh" | "dvi"
    | "dvb" | "dvmin" | "dvmax" | "cqw" | "cqh" | "cqi" | "cqb" | "cqmin" | "cqmax" => 0.0,
    _ => return None,
  })
}

type CssResult<T> = Result<T, ParseError<()>>;

fn invalid<T>() -> CssResult<T> {
  Err(ParseError::custom(()))
}

fn parse_calc_value(parser: &mut Parser<'_>, font: &FontUnits) -> CssResult<CalcNode> {
  let token = parser.next()?.clone();
  match token {
    Token::Number { value, .. } => Ok(CalcNode::Leaf(Calc::Number(value as f64))),
    Token::Dimension {
      value, ref unit, ..
    } => match unit_px(unit, font) {
      Some(factor) => Ok(CalcNode::Leaf(Calc::Length {
        px: value as f64 * factor,
        percent: 0.0,
        has_px: true,
      })),
      None => invalid(),
    },
    Token::Percentage { unit_value, .. } => Ok(CalcNode::Leaf(Calc::Length {
      px: 0.0,
      percent: unit_value as f64 * 100.0,
      has_px: false,
    })),
    // The calc() constants.
    Token::Ident(ref name) => match name.to_ascii_lowercase().as_str() {
      "e" => Ok(CalcNode::Leaf(Calc::Number(std::f64::consts::E))),
      "pi" => Ok(CalcNode::Leaf(Calc::Number(std::f64::consts::PI))),
      "infinity" => Ok(CalcNode::Leaf(Calc::Number(f64::INFINITY))),
      "-infinity" => Ok(CalcNode::Leaf(Calc::Number(f64::NEG_INFINITY))),
      "nan" => Ok(CalcNode::Leaf(Calc::Number(f64::NAN))),
      _ => invalid(),
    },
    Token::ParenthesisBlock => parser.parse_nested_block(|parser| parse_calc_sum(parser, font)),
    Token::Function(ref name) => {
      let name = name.to_ascii_lowercase();
      parser.parse_nested_block(|parser| parse_math_function(parser, &name, font))
    }
    _ => invalid(),
  }
}

fn parse_calc_product(parser: &mut Parser<'_>, font: &FontUnits) -> CssResult<CalcNode> {
  let mut node = parse_calc_value(parser, font)?;
  loop {
    let state = parser.state();
    match parser.next() {
      Ok(&Token::Delim(op @ ('*' | '/'))) => {
        let rhs = parse_calc_value(parser, font)?;
        node = CalcNode::Product(Box::new(node), Box::new(rhs), op == '/');
      }
      _ => {
        parser.reset(&state);
        return Ok(node);
      }
    }
  }
}

/// A calc sum; `+` and `-` need whitespace on both sides.
fn parse_calc_sum(parser: &mut Parser<'_>, font: &FontUnits) -> CssResult<CalcNode> {
  let mut node = parse_calc_product(parser, font)?;
  loop {
    let state = parser.state();
    let Ok(Token::WhiteSpace(_)) = parser.next_including_whitespace() else {
      parser.reset(&state);
      return Ok(node);
    };
    let subtract = match parser.next_including_whitespace() {
      Ok(&Token::Delim('+')) => false,
      Ok(&Token::Delim('-')) => true,
      _ => {
        parser.reset(&state);
        return Ok(node);
      }
    };
    let Ok(Token::WhiteSpace(_)) = parser.next_including_whitespace() else {
      return invalid();
    };
    let rhs = parse_calc_product(parser, font)?;
    node = CalcNode::Sum(Box::new(node), Box::new(rhs), subtract);
  }
}

fn parse_math_function(
  parser: &mut Parser<'_>,
  name: &str,
  font: &FontUnits,
) -> CssResult<CalcNode> {
  match name {
    "calc" => parse_calc_sum(parser, font),
    "min" | "max" => {
      let args = parser.parse_comma_separated(|parser| parse_calc_sum(parser, font))?;
      Ok(if name == "min" {
        CalcNode::Min(args)
      } else {
        CalcNode::Max(args)
      })
    }
    "clamp" => {
      let args = parser.parse_comma_separated(|parser| parse_calc_sum(parser, font))?;
      match <[CalcNode; 3]>::try_from(args) {
        Ok(args) => Ok(CalcNode::Clamp(Box::new(args))),
        Err(_) => invalid(),
      }
    }
    _ => invalid(),
  }
}

/// The value of a root `width` or `height` attribute in px
/// (SVGSVGElement::IntrinsicWidth), or None when it is a percentage, `auto`,
/// or does not parse (the initial value, 100%).
pub(crate) fn root_length(value: &str, font: &FontUnits) -> Option<f32> {
  let mut parser = Parser::new(value);
  let parsed: CssResult<Option<f32>> = parser.parse_entirely(|parser| {
    let token = parser.next()?.clone();
    match token {
      Token::Number { value, .. } => Ok(Some(css_length(value as f64))),
      Token::Dimension {
        value, ref unit, ..
      } => match unit_px(unit, font) {
        Some(factor) => Ok(Some(css_length(value as f64 * factor))),
        None => invalid(),
      },
      Token::Percentage { .. } => Ok(None),
      Token::Function(ref name) => {
        let name = name.to_ascii_lowercase();
        let node: CalcNode =
          parser.parse_nested_block(|parser| parse_math_function(parser, &name, font))?;
        match node.calc_type() {
          None => invalid(),
          Some(_)
            if node.only_percentages() && matches!(node.calc_type(), Some(CalcType::Length)) =>
          {
            Ok(None)
          }
          Some(_) => {
            // A percentage is of the root's own viewport, which is the
            // value without its percentages.
            let base = node.evaluate(0.0);
            let value = node.evaluate(base);
            Ok(Some(if value.is_nan() {
              0.0
            } else {
              value.clamp(-f32::MAX as f64, f32::MAX as f64) as f32
            }))
          }
        }
      }
      _ => invalid(),
    }
  });
  parsed.ok().flatten().map(|v| v.max(0.0))
}

/// ClampToCSSLengthRange.
fn css_length(px: f64) -> f32 {
  px.clamp(-MAX_CSS_LENGTH, MAX_CSS_LENGTH) as f32
}

#[cfg(test)]
mod tests {
  use super::*;

  fn width(value: &str) -> Option<f32> {
    root_length(value, &FontUnits::fallback())
  }

  fn natural(attrs: [Option<&str>; 4]) -> (u32, u32) {
    SvgSizing::from_attributes(
      attrs[0],
      attrs[1],
      attrs[2],
      attrs[3],
      &FontUnits::fallback(),
    )
    .natural()
  }

  #[test]
  fn root_lengths() {
    assert_eq!(width(" 40 "), Some(40.0));
    assert_eq!(width("1e1"), Some(10.0));
    assert_eq!(width("+40"), Some(40.0));
    assert_eq!(width("40PX"), Some(40.0));
    assert_eq!(width("1Q"), Some(96.0 / 101.6));
    assert_eq!(width("2.5pc"), Some(40.0));
    assert_eq!(width("2rem"), Some(32.0));
    assert_eq!(width("1vw"), Some(0.0));
    assert_eq!(width("-5px"), Some(0.0));
    assert_eq!(width("99999999"), Some(33_554_428.0));
    for invalid in [
      "auto",
      "40 px",
      "40%",
      "",
      "abc",
      "40e",
      "40px;",
      "inherit",
      "1x",
      "0x10",
      "1.",
      "1e1.5",
      "10px 10px",
      "calc(1px +2px)",
      "calc(50%)",
    ] {
      assert_eq!(width(invalid), None, "{invalid}");
    }
  }

  #[test]
  fn calc() {
    assert_eq!(width("calc(10px + 5px)"), Some(15.0));
    assert_eq!(width("CALC(10px)"), Some(10.0));
    assert_eq!(width("calc(10)"), Some(10.0));
    assert_eq!(width("calc(10px / 4)"), Some(2.5));
    assert_eq!(width("calc((10px + 2px) * 2)"), Some(24.0));
    assert_eq!(width("calc(10px * 2 + 1em)"), Some(36.0));
    assert_eq!(width("min(10px, 20px)"), Some(10.0));
    assert_eq!(width("clamp(5px, 50px, 30px)"), Some(30.0));
    assert_eq!(width("calc(50% + 20px)"), Some(30.0));
    assert_eq!(width("calc(100% + 1px)"), Some(2.0));
    assert_eq!(width("min(50%, 10px)"), Some(0.0));
    assert_eq!(width("calc(10 + 10px)"), None);
    assert_eq!(width("calc(10px * 2px)"), None);
  }

  #[test]
  fn view_boxes() {
    assert_eq!(parse_view_box("0 0 10 20"), Some((10.0, 20.0)));
    assert_eq!(parse_view_box("0,0,10,20"), Some((10.0, 20.0)));
    assert_eq!(parse_view_box("  0 0 10 20  "), Some((10.0, 20.0)));
    assert_eq!(parse_view_box("0 0 1e1 +20"), Some((10.0, 20.0)));
    for invalid in [
      "0 0 10 20 5",
      "0 0 10",
      "0 0 10 20,",
      "0 0 10px 20",
      "0,,0,10,20",
      ",0 0 10 20",
      "0 0 10. 20",
      "0 0 10 20e",
      "0 0 1e40 1",
      "none",
    ] {
      assert_eq!(parse_view_box(invalid), None, "{invalid}");
    }
  }

  #[test]
  fn preserve_aspect_ratio() {
    assert!(aspect_ratio_is_none("none"));
    assert!(aspect_ratio_is_none(" none "));
    assert!(aspect_ratio_is_none("none slice"));
    assert!(!aspect_ratio_is_none("defer none"));
    assert!(!aspect_ratio_is_none("NONE"));
    assert!(!aspect_ratio_is_none("xMidYMid"));
    assert!(!aspect_ratio_is_none("none foo"));
  }

  #[test]
  fn natural_sizes() {
    assert_eq!(natural([None, None, None, None]), (300, 150));
    assert_eq!(natural([None, None, Some("0 0 10 10"), None]), (150, 150));
    assert_eq!(natural([None, None, Some("0 0 10 20"), None]), (75, 150));
    assert_eq!(
      natural([Some("40"), None, Some("0 0 10 20"), None]),
      (40, 80)
    );
    assert_eq!(
      natural([None, Some("30"), Some("0 0 20 10"), None]),
      (60, 30)
    );
    assert_eq!(natural([Some("10.6"), Some("20.4"), None, None]), (11, 20));
    assert_eq!(
      natural([Some("-10"), Some("20"), Some("0 0 10 10"), None]),
      (0, 20)
    );
    assert_eq!(natural([None, None, Some("0 0 100000 1"), None]), (300, 0));
    assert_eq!(natural([None, None, Some("0 0 0 0"), None]), (300, 150));
    assert_eq!(natural([Some("0.5"), Some("2.5"), None, None]), (1, 3));
    assert_eq!(natural([Some("0.49"), Some("20"), None, None]), (0, 20));
    assert_eq!(
      natural([Some("40"), None, Some("0 0 10 20"), Some("none")]),
      (300, 150)
    );
    assert_eq!(
      natural([Some("40"), Some("30"), None, Some("none")]),
      (40, 30)
    );
    assert_eq!(
      natural([Some("calc(infinity * 1px)"), Some("20"), None, None]),
      (33_554_432, 20)
    );
  }
}
