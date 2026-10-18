//! The CSS `<color>` grammar and its resolution, as Blink 155 runs them for a
//! canvas: css_parsing_utils::ConsumeColor (css_parsing_utils.cc:2393-2457)
//! with ColorFunctionParser (css_color_function_parser.cc), color-mix(),
//! alpha(), contrast-color() and light-dark(), then ResolveColorValue
//! (style_builder_converter.cc:2896-3048) and StyleColor::Resolve
//! (style_color.cc).
//!
//! Each nested color is resolved as soon as it is parsed (a canvas has no
//! element, so `currentcolor` is always black), so no value tree is kept and
//! nothing deep is walked or dropped later.

use cssparser::{Parser, Token};

use super::model::{Color, ColorSpace, HueMethod};
use super::names::{self, ColorKeyword};
use crate::css_math::{
  self, Category, Channel, ChannelValues, Lengths, Literal, MathOptions, Node, Unit, custom_error,
};

/// How many colors may nest inside each other (color-mix() operands,
/// relative-color origins, alpha(), light-dark(), contrast-color()). Chrome
/// has no limit (its renderer crashes past ~20000); we stop here so a parse
/// can never overflow a small thread stack (decisions.md 07 Q4). Deeper
/// input is an invalid color.
pub(crate) const COLOR_NESTING_LIMIT: u32 = 100;

/// ResolveColorValueContext: what a color resolves against.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ResolveContext {
  pub(crate) lengths: Lengths,
  /// TextLinkColors::LinkColor / ActiveLinkColor for `-webkit-link` and
  /// `-webkit-activelink`.
  pub(crate) link: Color,
  pub(crate) active_link: Color,
}

impl ResolveContext {
  /// fillStyle, strokeStyle, shadowColor and addColorStop:
  /// CSSToLengthConversionData(/*element=*/nullptr) resolves every relative
  /// length to 0 (canvas_style.cc:88-95), and the default TextLinkColors
  /// (text_link_colors.cc: #0000ee, #ff0000).
  pub(crate) const CANVAS: Self = Self {
    lengths: Lengths {
      em: 0.0,
      rem: 0.0,
      ex: 0.0,
      rex: 0.0,
      ch: 0.0,
      rch: 0.0,
      ic: 0.0,
      ric: 0.0,
      cap: 0.0,
      rcap: 0.0,
      lh: 0.0,
      rlh: 0.0,
      viewport_width: 0.0,
      viewport_height: 0.0,
    },
    link: Color::from_rgba32(0xFF0000EE),
    active_link: Color::from_rgba32(0xFFFF0000),
  };

  /// A drop-shadow() color in an OffscreenCanvas filter
  /// (StyleBuilderConverter::ConvertShadow, style_builder_converter.cc:
  /// 2708-2724): black link colors, and `lengths`, the conversion data the
  /// filter's own lengths use (filter_operation_resolver.cc:285-297): em and
  /// rem are 16px, viewport, container and line-height units 0, and the
  /// font-metric units come from the canvas font.
  pub(crate) fn filter(lengths: Lengths) -> Self {
    Self {
      lengths,
      link: Color::BLACK,
      active_link: Color::BLACK,
    }
  }
}

/// The kind of CSSValue a `<color>` parses to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
  /// cssvalue::CSSColor: hex, or a color function resolved at parse time.
  Color,
  /// A keyword (named, system, currentcolor, -webkit-link).
  Ident,
  Mix,
  Relative,
  Alpha,
  Contrast,
  /// CSSUnresolvedColorValue: a color function with a calc() that does not
  /// fold at parse time.
  Unresolved,
  LightDark,
}

/// The unresolved color functions of StyleColor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FunctionKind {
  Mix,
  Relative,
  Contrast,
  Alpha,
}

/// StyleColor, with any unresolved function already resolved against a black
/// currentcolor.
#[derive(Clone, Copy, Debug)]
enum StyleColor {
  Absolute(Color),
  CurrentColor,
  Function(FunctionKind, Color),
}

impl StyleColor {
  fn is_absolute(&self) -> bool {
    matches!(self, Self::Absolute(_))
  }

  /// ResolveColorOperand with currentcolor = black (style_color.cc:44-56).
  fn operand(&self) -> Color {
    match *self {
      Self::Absolute(c) | Self::Function(_, c) => c,
      Self::CurrentColor => Color::BLACK,
    }
  }

  /// A new function result: absolute when every operand is.
  fn function(kind: FunctionKind, color: Color, absolute: bool) -> Self {
    if absolute {
      Self::Absolute(color)
    } else {
      Self::Function(kind, color)
    }
  }
}

/// A parsed and resolved `<color>`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ParsedColor {
  pub(crate) kind: Kind,
  /// The kind after following light-dark() to its light value: what
  /// ResolveColorValue's top-level rules look at.
  top_kind: Kind,
  /// For Kind::Color: the parsed value itself (CSSParser::ParseColor reads
  /// it as is, without ResolveNonFiniteValues).
  value: Color,
  style: StyleColor,
}

impl ParsedColor {
  /// ResolveColorValue (style_builder_converter.cc:3022-3048), then
  /// StyleColor::Resolve with a black currentcolor (style_color.cc:483-505).
  pub(crate) fn resolve(&self) -> Color {
    match self.style {
      StyleColor::CurrentColor => Color::BLACK,
      StyleColor::Absolute(mut color) => {
        if matches!(self.top_kind, Kind::Mix | Kind::Relative) && color.space().is_legacy() {
          // rgb() keeps its missing components as color(srgb); hsl() and
          // hwb() cannot.
          let resolve_missing = color.space() != ColorSpace::SrgbLegacy;
          color.convert_to_color_space(ColorSpace::Srgb, resolve_missing);
        }
        color
      }
      StyleColor::Function(kind, mut color) => {
        if color.space().is_legacy() && kind != FunctionKind::Contrast {
          color.convert_to_color_space(ColorSpace::Srgb, true);
        }
        color
      }
    }
  }

  /// The resolved color when it does not depend on currentcolor
  /// (StyleColor::IsAbsoluteColor), else None.
  pub(crate) fn absolute(&self) -> Option<Color> {
    self.style.is_absolute().then(|| self.resolve())
  }

  /// The value CSSParser::ParseColor takes from a parse-time CSSColor.
  fn parse_time_color(&self) -> Option<Color> {
    (self.kind == Kind::Color).then_some(self.value)
  }

  fn new(kind: Kind, style: StyleColor) -> Self {
    Self {
      kind,
      top_kind: kind,
      value: style.operand(),
      style,
    }
  }
}

fn clamp_to(v: f64, lo: f64, hi: f64) -> f64 {
  if v >= hi {
    hi
  } else if v <= lo {
    lo
  } else {
    v
  }
}

/// CSSValueClampingUtils::ClampDouble: NaN is 0, infinities saturate.
fn clamp_double(v: f64) -> f64 {
  if v.is_nan() {
    0.0
  } else {
    clamp_to(v, f64::MIN, f64::MAX)
  }
}

fn censor_nan(v: f64) -> f64 {
  if v.is_nan() { 0.0 } else { v }
}

/// Runs `f` and rewinds the parser when it fails (Blink's savepoints and
/// RestoringBlockGuard).
fn attempt<'i, T>(p: &mut Parser<'i>, f: impl FnOnce(&mut Parser<'i>) -> Option<T>) -> Option<T> {
  let state = p.state();
  let result = f(p);
  if result.is_none() {
    p.reset(&state);
  }
  result
}

/// Parses the block the last token opened; `f` must read all of it.
fn nested<'i, T>(p: &mut Parser<'i>, f: impl FnOnce(&mut Parser<'i>) -> Option<T>) -> Option<T> {
  p.parse_nested_block(|q| match f(q) {
    Some(v) => Ok(v),
    None => Err(custom_error()),
  })
  .ok()
}

fn ident_is(p: &mut Parser<'_>, name: &str) -> bool {
  attempt(p, |p| match p.next() {
    Ok(Token::Ident(ident)) if ident.eq_ignore_ascii_case(name) => Some(()),
    _ => None,
  })
  .is_some()
}

fn consume_comma(p: &mut Parser<'_>) -> bool {
  attempt(p, |p| matches!(p.next(), Ok(Token::Comma)).then_some(())).is_some()
}

fn consume_slash(p: &mut Parser<'_>) -> bool {
  attempt(p, |p| {
    matches!(p.next(), Ok(Token::Delim('/'))).then_some(())
  })
  .is_some()
}

// ---------------------------------------------------------------------------
// Numbers, percentages, angles (css_parsing_utils.cc:1261-1290, 1393-1417,
// 1544-1599)
// ---------------------------------------------------------------------------

/// A channel argument of a color function.
#[derive(Clone, Debug)]
enum ChannelValue {
  None,
  /// A number, percentage or angle token, in its own unit.
  Literal(Literal),
  Math(Node),
  /// A relative color channel keyword (`r`, `h`, `alpha`, …).
  Keyword(Channel),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChannelType {
  None,
  Number,
  Percentage,
  Relative,
}

/// MathFunctionParser: a math function whose result has `category`.
fn consume_math(
  p: &mut Parser<'_>,
  allow_percent: bool,
  channels: &[Channel],
  categories: &[Category],
) -> Option<Node> {
  attempt(p, |p| {
    let (token, _) = css_math::next_token(p)?;
    let Token::Function(name) = token else {
      return None;
    };
    if !css_math::is_math_function(&name) {
      return None;
    }
    let options = MathOptions {
      allow_percent,
      channels,
    };
    let node = nested(p, |q| css_math::parse_math_function(q, &name, options))?;
    categories.contains(&node.category()).then_some(node)
  })
}

/// ConsumeNumber with ValueRange::kAll.
fn consume_number(p: &mut Parser<'_>) -> Option<ChannelValue> {
  let literal = attempt(p, |p| {
    let (token, source) = css_math::next_token(p)?;
    matches!(token, Token::Number { .. }).then(|| Literal {
      value: css_math::token_number(source),
      unit: Unit::Number,
    })
  });
  if let Some(literal) = literal {
    return Some(ChannelValue::Literal(literal));
  }
  consume_math(p, true, &[], &[Category::Number]).map(ChannelValue::Math)
}

/// ConsumePercent with ValueRange::kAll.
fn consume_percent(p: &mut Parser<'_>) -> Option<ChannelValue> {
  let literal = attempt(p, |p| {
    let (token, source) = css_math::next_token(p)?;
    matches!(token, Token::Percentage { .. }).then(|| Literal {
      value: css_math::token_number(source),
      unit: Unit::Percent,
    })
  });
  if let Some(literal) = literal {
    return Some(ChannelValue::Literal(literal));
  }
  consume_math(p, true, &[], &[Category::Percent]).map(ChannelValue::Math)
}

/// ConsumeAngle with no unitless zero.
fn consume_angle(p: &mut Parser<'_>) -> Option<ChannelValue> {
  let literal = attempt(p, |p| {
    let (token, source) = css_math::next_token(p)?;
    let (value, unit) = css_math::numeric_token(&token, source)?;
    let unit = unit?;
    (matches!(token, Token::Dimension { .. })
      && matches!(unit, Unit::Deg | Unit::Rad | Unit::Grad | Unit::Turn))
    .then_some(Literal { value, unit })
  });
  if let Some(literal) = literal {
    return Some(ChannelValue::Literal(literal));
  }
  consume_math(p, false, &[], &[Category::Angle]).map(ChannelValue::Math)
}

/// The numeric literal of a channel ChannelIsResolvable accepted
/// (GetNumericLiteralValue, css_color_function_parser.cc:423-433).
fn numeric_literal(value: &ChannelValue) -> Option<Literal> {
  match value {
    ChannelValue::Literal(l) => Some(*l),
    ChannelValue::Math(node) => node.as_literal().copied(),
    _ => None,
  }
}

fn is_angle(value: &ChannelValue) -> bool {
  match value {
    ChannelValue::Literal(l) => matches!(l.unit, Unit::Deg | Unit::Rad | Unit::Grad | Unit::Turn),
    ChannelValue::Math(node) => node.category() == Category::Angle,
    _ => false,
  }
}

// ---------------------------------------------------------------------------
// Color functions (css_color_function_parser.cc)
// ---------------------------------------------------------------------------

/// ColorFunction::Metadata (color_function.h): channel names and what 100%
/// is (NaN: percentages do not apply).
fn metadata(space: ColorSpace) -> ([Channel; 3], [f64; 3]) {
  use Channel::*;
  const NA: f64 = f64::NAN;
  match space {
    ColorSpace::SrgbLegacy => ([R, G, B], [255.0, 255.0, 255.0]),
    ColorSpace::XyzD50 | ColorSpace::XyzD65 => ([X, Y, Z], [1.0, 1.0, 1.0]),
    ColorSpace::Lab => ([L, A, B], [100.0, 125.0, 125.0]),
    ColorSpace::Oklab => ([L, A, B], [1.0, 0.4, 0.4]),
    ColorSpace::Lch => ([L, C, H], [100.0, 150.0, NA]),
    ColorSpace::Oklch => ([L, C, H], [1.0, 0.4, NA]),
    ColorSpace::Hsl => ([H, S, L], [NA, 100.0, 100.0]),
    ColorSpace::Hwb => ([H, W, B], [NA, 100.0, 100.0]),
    _ => ([R, G, B], [1.0, 1.0, 1.0]),
  }
}

/// ColorChannelIsHue (css_color_function_parser.cc:112-128).
fn channel_is_hue(space: ColorSpace, i: usize) -> bool {
  match space {
    ColorSpace::Hsl | ColorSpace::Hwb => i == 0,
    ColorSpace::Lch | ColorSpace::Oklch => i == 2,
    _ => false,
  }
}

fn is_lab_family(space: ColorSpace) -> bool {
  matches!(
    space,
    ColorSpace::Lab | ColorSpace::Oklab | ColorSpace::Lch | ColorSpace::Oklch
  )
}

/// ColorFunctionParser::MakePerColorSpaceAdjustments
/// (css_color_function_parser.cc:355-420).
fn make_per_color_space_adjustments(
  is_relative: bool,
  is_legacy: bool,
  space: ColorSpace,
  channels: &mut [Option<f64>; 3],
  alpha: &mut Option<f64>,
) {
  for (i, channel) in channels.iter_mut().enumerate() {
    if let Some(v) = channel.as_mut()
      && channel_is_hue(space, i)
    {
      if !v.is_finite() {
        *v = 0.0;
      }
      *v = ((*v % 360.0) + 360.0) % 360.0;
    }
  }
  if space == ColorSpace::SrgbLegacy {
    for v in channels.iter_mut().flatten() {
      if !v.is_finite() {
        *v = if *v > 0.0 { 255.0 } else { 0.0 };
      } else if !is_relative {
        *v = clamp_to(*v, 0.0, 255.0);
      }
    }
    if is_legacy && let Some(a) = alpha.as_mut() {
      *a = (*a * 255.0).round() / 255.0;
    }
  }
  if matches!(space, ColorSpace::Hsl | ColorSpace::Hwb) {
    for channel in &mut channels[1..] {
      if let Some(v) = channel.as_mut() {
        let mut val = *v / 100.0;
        if is_legacy {
          val = clamp_to(val, 0.0, 1.0);
        } else if !is_relative {
          // std::max(0.0, val).
          val = if 0.0 < val { val } else { 0.0 };
        }
        *v = val;
      }
    }
  }
}

fn from_color_space(space: ColorSpace, channels: [Option<f64>; 3], alpha: Option<f64>) -> Color {
  Color::from_color_space(
    space,
    channels[0].map(|v| v as f32),
    channels[1].map(|v| v as f32),
    channels[2].map(|v| v as f32),
    alpha.map(|v| v as f32),
  )
}

/// The function names IsValidColorFunction accepts and the color space each
/// one fixes (None: color(), which names its space).
fn color_function(name: &str) -> Option<Option<ColorSpace>> {
  Some(Some(match name.to_ascii_lowercase().as_str() {
    "rgb" | "rgba" => ColorSpace::SrgbLegacy,
    "hsl" | "hsla" => ColorSpace::Hsl,
    "hwb" => ColorSpace::Hwb,
    "lab" => ColorSpace::Lab,
    "lch" => ColorSpace::Lch,
    "oklab" => ColorSpace::Oklab,
    "oklch" => ColorSpace::Oklch,
    "color" => return Some(None),
    _ => return None,
  }))
}

/// ColorSpaceFromColorSpaceArgument (css_color_function_parser.cc:70-110).
/// rec2100-linear is behind a disabled flag in Chrome 155.
fn predefined_space(name: &str) -> Option<ColorSpace> {
  Some(match name.to_ascii_lowercase().as_str() {
    "srgb" => ColorSpace::Srgb,
    "rec2020" => ColorSpace::Rec2020,
    "srgb-linear" => ColorSpace::SrgbLinear,
    "display-p3" => ColorSpace::DisplayP3,
    "display-p3-linear" => ColorSpace::DisplayP3Linear,
    "a98-rgb" => ColorSpace::A98Rgb,
    "prophoto-rgb" => ColorSpace::ProPhotoRgb,
    "xyz-d50" => ColorSpace::XyzD50,
    "xyz" | "xyz-d65" => ColorSpace::XyzD65,
    _ => return None,
  })
}

/// The channel keywords a relative color may use in `space`.
fn channel_map(space: ColorSpace) -> [Channel; 4] {
  let ([a, b, c], _) = metadata(space);
  [a, b, c, Channel::Alpha]
}

struct ColorParser<'c> {
  ctx: &'c ResolveContext,
}

/// A relative channel as a value to evaluate (style_color.cc:58-96).
fn relative_channel_value(
  value: &ChannelValue,
  lengths: &Lengths,
  max_value: f32,
  channels: ChannelValues<'_>,
) -> Option<f64> {
  let v = match value {
    ChannelValue::None => return None,
    ChannelValue::Literal(l) => css_math::evaluate_literal_channel(l, max_value),
    ChannelValue::Keyword(c) => {
      css_math::calculation_value_result(css_math::channel_value(channels, *c))
    }
    ChannelValue::Math(node) => node.evaluate_channel(lengths, max_value, channels),
  };
  Some(v as f64)
}

impl ColorParser<'_> {
  /// css_parsing_utils::ConsumeColor (css_parsing_utils.cc:2393-2457).
  fn consume_color(&self, p: &mut Parser<'_>, depth: u32) -> Option<ParsedColor> {
    if depth > COLOR_NESTING_LIMIT {
      return None;
    }
    attempt(p, |p| self.consume_color_inner(p, depth))
  }

  fn consume_color_inner(&self, p: &mut Parser<'_>, depth: u32) -> Option<ParsedColor> {
    let (token, _) = css_math::next_token(p)?;
    match token {
      Token::Function(name) => {
        let lower = name.to_ascii_lowercase();
        match lower.as_str() {
          "color-mix" => nested(p, |q| self.consume_color_mix(q, depth)),
          "alpha" => nested(p, |q| self.consume_alpha_function(q, depth)),
          "contrast-color" => nested(p, |q| {
            let color = self.consume_color(q, depth + 1)?;
            q.is_exhausted().then_some(())?;
            let [r, g, b] = rgb_bytes(color.style.operand());
            let param = (r << 16) | (g << 8) | b;
            let contrast = if contrast_ratio(0x000000, param) > contrast_ratio(0xFFFFFF, param) {
              Color::BLACK
            } else {
              Color::WHITE
            };
            Some(ParsedColor::new(
              Kind::Contrast,
              StyleColor::function(FunctionKind::Contrast, contrast, color.style.is_absolute()),
            ))
          }),
          "light-dark" => nested(p, |q| {
            let light = self.consume_color(q, depth + 1)?;
            consume_comma(q).then_some(())?;
            self.consume_color(q, depth + 1)?;
            q.is_exhausted().then_some(())?;
            // ResolveLightDarkPair: the light scheme.
            Some(ParsedColor {
              kind: Kind::LightDark,
              ..light
            })
          }),
          _ => {
            let space = color_function(&lower)?;
            nested(p, |q| self.consume_functional_syntax_color(q, space, depth))
          }
        }
      }
      Token::Ident(ident) => {
        let style = match names::css_color_keyword(&ident)? {
          ColorKeyword::CurrentColor => StyleColor::CurrentColor,
          // ResolveQuirkOrLinkOrFocusRingColor (style_builder_converter.cc).
          ColorKeyword::WebkitLink => StyleColor::Absolute(self.ctx.link),
          ColorKeyword::WebkitActiveLink => StyleColor::Absolute(self.ctx.active_link),
          ColorKeyword::Named(argb) => StyleColor::Absolute(Color::from_rgba32(argb)),
          ColorKeyword::System(id) => StyleColor::Absolute(names::system_color(id)),
        };
        Some(ParsedColor::new(Kind::Ident, style))
      }
      Token::Hash(value) | Token::IDHash(value) => {
        let color = super::fast_path::parse_hex_color(value.as_bytes())?;
        Some(ParsedColor::new(Kind::Color, StyleColor::Absolute(color)))
      }
      _ => None,
    }
  }

  /// ColorFunctionParser::ConsumeFunctionalSyntaxColor
  /// (css_color_function_parser.cc:506-701), inside the function's block.
  fn consume_functional_syntax_color(
    &self,
    q: &mut Parser<'_>,
    function_space: Option<ColorSpace>,
    depth: u32,
  ) -> Option<ParsedColor> {
    // ConsumeColorSpaceAndOriginColor (:185-231).
    let origin = if ident_is(q, "from") {
      Some(self.consume_color(q, depth + 1)?)
    } else {
      None
    };
    let space = match function_space {
      Some(space) => space,
      None => match q.next() {
        Ok(Token::Ident(name)) => predefined_space(name)?,
        _ => return None,
      },
    };
    let relative_channels = channel_map(space);
    let channels_map: &[Channel] = if origin.is_some() {
      &relative_channels
    } else {
      &[]
    };

    let mut values = [ChannelValue::None, ChannelValue::None, ChannelValue::None];
    let mut types = [ChannelType::None; 3];
    let mut has_none = false;
    let mut comma = [false; 2];
    for i in 0..3 {
      // ConsumeChannel (:247-313).
      let (value, ty) = if ident_is(q, "none") {
        has_none = true;
        (ChannelValue::None, ChannelType::None)
      } else if channel_is_hue(space, i) {
        if let Some(v) = consume_angle(q).or_else(|| consume_number(q)) {
          (v, ChannelType::Number)
        } else if origin.is_some() {
          let v =
            self.consume_relative_channel(q, channels_map, &[Category::Number, Category::Angle])?;
          (v, ChannelType::Relative)
        } else {
          return None;
        }
      } else if let Some(v) = consume_number(q) {
        (v, ChannelType::Number)
      } else if let Some(v) = consume_percent(q) {
        (v, ChannelType::Percentage)
      } else if origin.is_some() {
        let v =
          self.consume_relative_channel(q, channels_map, &[Category::Number, Category::Percent])?;
        (v, ChannelType::Relative)
      } else {
        return None;
      };
      values[i] = value;
      types[i] = ty;
      if i < 2 {
        comma[i] = consume_comma(q);
      }
    }
    if comma[0] != comma[1] {
      return None;
    }
    let is_legacy = comma[0];
    let has_alpha = if is_legacy {
      if origin.is_some() || !matches!(space, ColorSpace::SrgbLegacy | ColorSpace::Hsl) {
        return None;
      }
      consume_comma(q)
    } else {
      consume_slash(q)
    };
    let mut alpha_value = ChannelValue::None;
    let mut alpha_type = ChannelType::None;
    if has_alpha {
      // ConsumeAlpha (:315-353).
      (alpha_value, alpha_type) = if let Some(v) = consume_number(q) {
        (v, ChannelType::Number)
      } else if let Some(v) = consume_percent(q) {
        (v, ChannelType::Percentage)
      } else if ident_is(q, "none") {
        has_none = true;
        (ChannelValue::None, ChannelType::None)
      } else if origin.is_some() {
        let v =
          self.consume_relative_channel(q, channels_map, &[Category::Number, Category::Percent])?;
        (v, ChannelType::Relative)
      } else {
        return None;
      };
    }
    if !q.is_exhausted() {
      return None;
    }
    if is_legacy {
      if has_none {
        return None;
      }
      if space == ColorSpace::SrgbLegacy {
        // Percentages and numbers do not mix.
        let percent = types
          .iter()
          .filter(|&&t| t == ChannelType::Percentage)
          .count();
        if percent != 0 && percent != 3 {
          return None;
        }
      } else if types[1] == ChannelType::Number || types[2] == ChannelType::Number {
        return None;
      }
    }

    let (_, percentage) = metadata(space);
    if let Some(origin) = origin {
      let color = self.resolve_relative(
        origin.style.operand(),
        space,
        &values,
        has_alpha.then_some(&alpha_value),
      );
      return Some(ParsedColor::new(
        Kind::Relative,
        StyleColor::function(FunctionKind::Relative, color, origin.style.is_absolute()),
      ));
    }

    // ChannelIsResolvable (:458-503).
    let resolvable = |value: &ChannelValue| match value {
      ChannelValue::None | ChannelValue::Literal(_) | ChannelValue::Keyword(_) => true,
      ChannelValue::Math(node) => !is_lab_family(space) && node.as_literal().is_some(),
    };
    if values.iter().all(resolvable) && (!has_alpha || resolvable(&alpha_value)) {
      // ResolveColorChannelForNumericLiteral (:435-456).
      let mut channels = [None; 3];
      for i in 0..3 {
        if types[i] == ChannelType::None {
          continue;
        }
        let literal = numeric_literal(&values[i])?;
        channels[i] = Some(match types[i] {
          ChannelType::Percentage => clamp_double(literal.value) / 100.0 * percentage[i],
          _ if is_angle(&values[i]) => literal.degrees(),
          _ => literal.value,
        });
      }
      let mut alpha = Some(1.0);
      if has_alpha {
        alpha = match alpha_type {
          ChannelType::None => None,
          ChannelType::Percentage => Some(clamp_to(
            clamp_double(numeric_literal(&alpha_value)?.value) / 100.0,
            0.0,
            1.0,
          )),
          _ => Some(clamp_to(
            clamp_double(numeric_literal(&alpha_value)?.value),
            0.0,
            1.0,
          )),
        };
      }
      make_per_color_space_adjustments(false, is_legacy, space, &mut channels, &mut alpha);
      let color = from_color_space(space, channels, alpha);
      let mut resolved = color;
      // ResolveColorValueImpl (style_builder_converter.cc:2898-2902).
      resolved.resolve_non_finite_values();
      return Some(ParsedColor {
        kind: Kind::Color,
        top_kind: Kind::Color,
        value: color,
        style: StyleColor::Absolute(resolved),
      });
    }

    // CSSUnresolvedColorValue::Resolve (css_unresolved_color_value.cc:257-286).
    let lengths = &self.ctx.lengths;
    let resolve = |value: &ChannelValue, ty: ChannelType, base: f64| -> Option<f64> {
      // ResolveColorChannel (:237-255).
      Some(match (value, ty) {
        (ChannelValue::Literal(l), ChannelType::Number) if is_angle(value) => l.degrees(),
        // CSSNumericLiteralValue::ComputeNumber: ClampTo<double>.
        (ChannelValue::Literal(l), ChannelType::Number) => clamp_to(l.value, f64::MIN, f64::MAX),
        (ChannelValue::Literal(l), ChannelType::Percentage) => {
          clamp_to(l.value / 100.0, f64::MIN, f64::MAX) * base
        }
        // CSSMathFunctionValue::ComputeDegrees / ComputeNumber
        // (css_math_function_value.cc:62-114).
        (ChannelValue::Math(node), ChannelType::Number) if is_angle(value) => {
          censor_nan(node.compute_double(lengths))
        }
        (ChannelValue::Math(node), _) => {
          let mut v = censor_nan(node.compute_double(lengths));
          if node.category() == Category::Percent {
            v /= 100.0;
          }
          let v = clamp_double(v);
          if ty == ChannelType::Percentage {
            v * base
          } else {
            v
          }
        }
        _ => return None,
      })
    };
    let mut channels = [None; 3];
    for i in 0..3 {
      if types[i] != ChannelType::None {
        channels[i] = Some(resolve(&values[i], types[i], percentage[i])?);
      }
    }
    let mut alpha = if !has_alpha {
      Some(1.0)
    } else if alpha_type == ChannelType::None {
      None
    } else {
      Some(clamp_to(resolve(&alpha_value, alpha_type, 1.0)?, 0.0, 1.0))
    };
    make_per_color_space_adjustments(false, false, space, &mut channels, &mut alpha);
    let color = from_color_space(space, channels, alpha);
    Some(ParsedColor::new(
      Kind::Unresolved,
      StyleColor::Absolute(color),
    ))
  }

  /// ConsumeRelativeColorChannel (css_color_function_parser.cc:130-172).
  fn consume_relative_channel(
    &self,
    q: &mut Parser<'_>,
    channels: &[Channel],
    categories: &[Category],
  ) -> Option<ChannelValue> {
    let state = q.state();
    if let Ok(Token::Function(_)) = q.next() {
      q.reset(&state);
      let all = [
        Category::Number,
        Category::Percent,
        Category::Angle,
        Category::Length,
        Category::LengthFunction,
        Category::Time,
        Category::Frequency,
        Category::Resolution,
        Category::PercentAngle,
        Category::Intermediate,
        Category::Ident,
      ];
      if let Some(node) = consume_math(q, true, channels, &all) {
        if !categories.contains(&node.category()) {
          q.reset(&state);
          return None;
        }
        return Some(ChannelValue::Math(node));
      }
    }
    q.reset(&state);
    attempt(q, |q| match q.next() {
      Ok(Token::Ident(ident)) => {
        let channel = Channel::from_ident(ident)?;
        channels
          .contains(&channel)
          .then_some(ChannelValue::Keyword(channel))
      }
      _ => None,
    })
  }

  /// UnresolvedRelativeColor::Resolve (style_color.cc:367-447).
  fn resolve_relative(
    &self,
    mut origin: Color,
    space: ColorSpace,
    values: &[ChannelValue; 3],
    alpha: Option<&ChannelValue>,
  ) -> Color {
    origin.convert_to_color_space(space, true);
    let (names, percentage) = metadata(space);
    let params = origin.params();
    let mut keywords = [
      (names[0], params[0]),
      (names[1], params[1]),
      (names[2], params[2]),
      (Channel::Alpha, origin.alpha()),
    ];
    if matches!(space, ColorSpace::Hsl | ColorSpace::Hwb) {
      keywords[1].1 = (keywords[1].1 as f64 * 100.0) as f32;
      keywords[2].1 = (keywords[2].1 as f64 * 100.0) as f32;
    }
    let lengths = &self.ctx.lengths;
    let max_value = |p: f64| if p.is_nan() { f32::MAX } else { p as f32 };
    let mut channels = [None; 3];
    for i in 0..3 {
      channels[i] =
        relative_channel_value(&values[i], lengths, max_value(percentage[i]), &keywords);
    }
    // An omitted alpha is the origin's alpha.
    let alpha_value = alpha
      .cloned()
      .unwrap_or(ChannelValue::Keyword(Channel::Alpha));
    let mut alpha = relative_channel_value(&alpha_value, lengths, 1.0, &keywords);
    make_per_color_space_adjustments(true, false, space, &mut channels, &mut alpha);
    from_color_space(space, channels, alpha)
  }

  /// ColorFunctionParser::ConsumeRelativeAlphaFunction
  /// (css_color_function_parser.cc:705-748) and UnresolvedAlphaColor::Resolve
  /// (style_color.cc:207-245).
  fn consume_alpha_function(&self, q: &mut Parser<'_>, depth: u32) -> Option<ParsedColor> {
    if !ident_is(q, "from") {
      return None;
    }
    let origin = self.consume_color(q, depth + 1)?;
    // CSSAlphaColorFunctionRequiresAlpha is stable: the slash is required.
    if !consume_slash(q) {
      return None;
    }
    let map = [Channel::Alpha];
    let alpha = if let Some(v) = consume_number(q).or_else(|| consume_percent(q)) {
      v
    } else if ident_is(q, "none") {
      ChannelValue::None
    } else {
      self.consume_relative_channel(q, &map, &[Category::Number, Category::Percent])?
    };
    if !q.is_exhausted() {
      return None;
    }
    let resolved = origin.style.operand();
    let keywords = [(Channel::Alpha, resolved.alpha())];
    let new_alpha = relative_channel_value(&alpha, &self.ctx.lengths, 1.0, &keywords)
      .map(|a| clamp_to(a, 0.0, 1.0));
    let p = resolved.params();
    let mut color = Color::from_color_space(
      resolved.space(),
      Some(p[0]),
      Some(p[1]),
      Some(p[2]),
      new_alpha.map(|a| a as f32),
    );
    if new_alpha.is_none() && color.space().is_legacy() {
      color.convert_to_color_space(ColorSpace::Srgb, true);
    }
    Some(ParsedColor::new(
      Kind::Alpha,
      StyleColor::function(FunctionKind::Alpha, color, origin.style.is_absolute()),
    ))
  }

  /// ConsumeColorMixFunction (css_parsing_utils.cc:2195-2286) and its
  /// resolution (style_builder_converter.cc:2920-2944).
  fn consume_color_mix(&self, q: &mut Parser<'_>, depth: u32) -> Option<ParsedColor> {
    // ConsumeColorInterpolationSpace (:2058-2163).
    let mut space = ColorSpace::Oklab;
    let mut hue = HueMethod::Shorter;
    if ident_is(q, "in") {
      let name = match q.next() {
        Ok(Token::Ident(name)) => name.to_ascii_lowercase(),
        _ => return None,
      };
      space = match name.as_str() {
        "xyz" | "xyz-d65" => ColorSpace::XyzD65,
        "xyz-d50" => ColorSpace::XyzD50,
        "srgb-linear" => ColorSpace::SrgbLinear,
        "display-p3" => ColorSpace::DisplayP3,
        "display-p3-linear" => ColorSpace::DisplayP3Linear,
        "a98-rgb" => ColorSpace::A98Rgb,
        "prophoto-rgb" => ColorSpace::ProPhotoRgb,
        "rec2020" => ColorSpace::Rec2020,
        "lab" => ColorSpace::Lab,
        "oklab" => ColorSpace::Oklab,
        "lch" => ColorSpace::Lch,
        "oklch" => ColorSpace::Oklch,
        "srgb" => ColorSpace::Srgb,
        "hsl" => ColorSpace::Hsl,
        "hwb" => ColorSpace::Hwb,
        _ => return None,
      };
      if matches!(
        space,
        ColorSpace::Hsl | ColorSpace::Hwb | ColorSpace::Lch | ColorSpace::Oklch
      ) {
        let method = attempt(q, |q| match q.next() {
          Ok(Token::Ident(m)) => match m.to_ascii_lowercase().as_str() {
            "shorter" => Some(HueMethod::Shorter),
            "longer" => Some(HueMethod::Longer),
            "increasing" => Some(HueMethod::Increasing),
            "decreasing" => Some(HueMethod::Decreasing),
            _ => None,
          },
          _ => None,
        });
        if let Some(method) = method {
          if !ident_is(q, "hue") {
            return None;
          }
          hue = method;
        }
      }
      // A comma follows an explicit `in <space>`.
      if !consume_comma(q) {
        return None;
      }
    }
    let operand = |q: &mut Parser<'_>| -> Option<(ParsedColor, Option<ChannelValue>)> {
      let mut color = self.consume_color(q, depth + 1);
      let percent = consume_percent(q);
      // The color can come after the percentage (css_parsing_utils.cc:
      // 2226-2240). Blink retries even with no percentage, at the same token,
      // where the retry fails again: skip it, or a color that fails deep down
      // costs 2^depth.
      if color.is_none() {
        percent.as_ref()?;
        color = Some(self.consume_color(q, depth + 1)?);
      }
      // A literal percentage outside [0, 100] is invalid; calc() clamps.
      if let Some(ChannelValue::Literal(l)) = &percent {
        let v = clamp_double(l.value);
        if !(0.0..=100.0).contains(&v) {
          return None;
        }
      }
      Some((color?, percent))
    };
    let (color1, p1) = operand(q)?;
    if !consume_comma(q) {
      return None;
    }
    let (color2, p2) = operand(q)?;
    if !q.is_exhausted() {
      return None;
    }
    // CSSColorMixValue::NormalizePercentages (css_color_mix_value.cc:14-56).
    let lengths = &self.ctx.lengths;
    let percentage = |v: &ChannelValue| -> f64 {
      // ComputePercentage: ClampDouble of the value.
      let value = match v {
        ChannelValue::Literal(l) => clamp_double(l.value),
        ChannelValue::Math(node) => clamp_double(censor_nan(node.compute_double(lengths))),
        _ => 0.0,
      };
      clamp_to(value, 0.0, 100.0) / 100.0
    };
    let mut pct1 = p1.as_ref().map_or(0.5, percentage);
    let mut pct2 = p2.as_ref().map_or(0.5, percentage);
    if p1.is_some() && p2.is_none() {
      pct2 = 1.0 - pct1;
    } else if p2.is_some() && p1.is_none() {
      pct1 = 1.0 - pct2;
    }
    let sum = pct1 + pct2;
    let (mix_amount, alpha_multiplier) = if sum == 0.0 {
      (0.5, 0.0)
    } else {
      (pct2 / sum, if sum <= 1.0 { sum } else { 1.0 })
    };
    let color = Color::from_color_mix(
      space,
      Some(hue),
      color1.style.operand(),
      color2.style.operand(),
      mix_amount as f32,
      alpha_multiplier as f32,
    );
    let absolute = color1.style.is_absolute() && color2.style.is_absolute();
    Some(ParsedColor::new(
      Kind::Mix,
      StyleColor::function(FunctionKind::Mix, color, absolute),
    ))
  }
}

/// Color::toSkColor4f().toSkColor() as bytes.
fn rgb_bytes(color: Color) -> [u32; 3] {
  let rgb = color.rgb();
  [(rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF]
}

/// color_utils::GetContrastRatio(SkColor, SkColor) (ui/gfx/color_utils.cc:
/// 402-428): WCAG relative luminance of SkColor4f::FromColor.
fn contrast_ratio(a: u32, b: u32) -> f32 {
  fn linearize(c: f32) -> f32 {
    if c <= 0.04045 {
      c / 12.92
    } else {
      ((c + 0.055) / 1.055).powf(2.4)
    }
  }
  fn luminance(rgb: u32) -> f32 {
    let channel = |shift: u32| ((rgb >> shift) & 0xFF) as f32 * (1.0 / 255.0);
    0.2126 * linearize(channel(16))
      + 0.7152 * linearize(channel(8))
      + 0.0722 * linearize(channel(0))
  }
  let la = luminance(a) + 0.05;
  let lb = luminance(b) + 0.05;
  if la > lb { la / lb } else { lb / la }
}

/// A parser for a whole string, with no block limit of its own: the color
/// and calc() nesting limits bound the recursion.
fn with_parser<T>(s: &str, f: impl FnOnce(&mut Parser<'_>) -> Option<T>) -> Option<T> {
  let mut p = Parser::new(s);
  p.set_nested_block_limit(0);
  f(&mut p)
}

/// CSSParser::ParseSingleValue(CSSPropertyID::kColor, s): one `<color>` with
/// only whitespace and comments around it.
fn parse_single_value(s: &str, ctx: &ResolveContext) -> Option<ParsedColor> {
  with_parser(s, |p| {
    let color = ColorParser { ctx }.consume_color(p, 0)?;
    p.is_exhausted().then_some(color)
  })
}

/// A `<color>` at the start of `s`, with anything after it
/// (ConsumeColorWithoutElementAndPropertyContext on a fresh token stream: a
/// leading whitespace token is not a color).
fn parse_stream(s: &str, ctx: &ResolveContext) -> Option<ParsedColor> {
  with_parser(s, |p| {
    let state = p.state();
    if matches!(p.next_including_whitespace(), Ok(Token::WhiteSpace(_))) {
      return None;
    }
    p.reset(&state);
    ColorParser { ctx }.consume_color(p, 0)
  })
}

/// Which canvas API reads the color.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Site {
  /// fillStyle, strokeStyle, shadowColor
  /// (Canvas2DRecorderContext::ParseColorOrCurrentColor,
  /// canvas_2d_recorder_context.cc:984-1019).
  Style,
  /// CanvasGradient.addColorStop (ParseCanvasColorString,
  /// canvas_style.cc:108-123).
  GradientStop,
}

/// ParseCanvasColorString (canvas_style.cc:61-106) for a canvas with no
/// document (OffscreenCanvas): None when Chrome rejects the string.
pub(crate) fn parse_canvas_color(input: &str, site: Site) -> Option<Color> {
  let s = input.trim_matches(super::fast_path::HTML_SPACES);
  if s.eq_ignore_ascii_case("currentcolor") {
    return Some(Color::BLACK);
  }
  let ctx = &ResolveContext::CANVAS;
  // CSSParser::ParseColor (css_parser.cc:396-430).
  if !s.is_empty() {
    if let Some(color) = names::find_named_color(s) {
      return Some(color);
    }
    if let Some(color) = super::fast_path::parse_color(s) {
      return Some(color);
    }
    if let Some(color) = parse_single_value(s, ctx).and_then(|v| v.parse_time_color()) {
      return Some(color);
    }
  }
  // CSSParser::ParseSystemColor (css_parser.cc:436-449).
  if let Some(color) = names::top_level_system_color(s) {
    return Some(color);
  }
  let parsed = parse_stream(s, ctx)?;
  if !matches!(
    parsed.kind,
    Kind::Alpha | Kind::Mix | Kind::Relative | Kind::Unresolved
  ) {
    return None;
  }
  match site {
    Site::GradientStop => Some(parsed.resolve()),
    // kColorFunction: the original string must be one whole value.
    Site::Style => parse_single_value(input, ctx).map(|v| v.resolve()),
  }
}

/// One `<color>` read from `p` (whitespace and comments around it allowed)
/// with a black currentcolor resolved by the caller: the color slot of
/// drop-shadow().
pub(crate) fn consume_color(p: &mut Parser<'_>, ctx: &ResolveContext) -> Option<ParsedColor> {
  ColorParser { ctx }.consume_color(p, 0)
}

/// The color slot of a drop-shadow() in an OffscreenCanvas filter, read from
/// `p` (the parser is left where it was when no color is there) and resolved
/// against the filter's `lengths`: a color that depends on currentcolor is
/// black (style_builder_converter.cc:2708-2724).
pub(crate) fn consume_filter_color(p: &mut Parser<'_>, lengths: &Lengths) -> Option<Color> {
  let color = consume_color(p, &ResolveContext::filter(*lengths))?;
  Some(color.absolute().unwrap_or(Color::BLACK))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn style(s: &str) -> Option<String> {
    parse_canvas_color(s, Site::Style).map(|c| c.serialize_as_canvas_color())
  }

  fn stop(s: &str) -> Option<String> {
    parse_canvas_color(s, Site::GradientStop).map(|c| c.serialize_as_canvas_color())
  }

  #[test]
  fn functions_serialize_like_chrome() {
    for (input, expected) in [
      ("lab(50 40 30)", "lab(50 40 30)"),
      (
        "color-mix(in oklab, red, blue)",
        "oklab(0.539974 0.0962086 -0.0928316)",
      ),
      (
        "color-mix(in srgb-linear, red, blue)",
        "color(srgb-linear 0.5 -6.85395e-9 0.5)",
      ),
      (
        "color-mix(in srgb, red 0%, blue 0%)",
        "color(srgb 0.5 0 0.5 / 0)",
      ),
      ("rgb(from red r g 255)", "color(srgb 1 0 1)"),
      ("alpha(from red / 0.5)", "rgba(255, 0, 0, 0.5)"),
      ("alpha(from currentcolor / 50%)", "color(srgb 0 0 0 / 0.5)"),
      ("rgb(from currentcolor none g b)", "color(srgb 0 0 0)"),
      ("rgb(from red none g b)", "color(srgb none 0 0)"),
      ("rgb(from red calc(r * 50%) g b)", "color(srgb 127.5 0 0)"),
      ("hsl(120 100% 50% / none)", "rgba(0, 255, 0, 0)"),
      ("rgb(calc(sin(1) * 100) 0 0)", "#540000"),
      ("lab(calc(sin(1) * 100) 0 0)", "lab(84.1471 0 0)"),
      ("rgb(calc(1in / 1px) 0 0)", "#600000"),
      (
        "color-mix(in srgb, color(srgb calc(infinity) 0 0), red)",
        "color(srgb calc(NaN) 0 0)",
      ),
      (
        "oklch(0.5 calc(infinity) 30)",
        "oklch(0.5 calc(infinity) 30)",
      ),
      ("lab(calc(infinity) 0 0)", "lab(100 0 0)"),
      (
        "color-mix(in srgb, AccentColor, white)",
        "color(srgb 0.5 0.729412 1)",
      ),
      ("rgb(from -webkit-link r g b)", "color(srgb 0 0 0.933333)"),
      (
        "color-mix(in srgb, contrast-color(red), white)",
        "color(srgb 0.5 0.5 0.5)",
      ),
      (
        "hsl(from rgb(10 200 30) h calc(s * 2) l)",
        "color(srgb -0.333333 1.15686 -0.17647)",
      ),
      (
        "alpha(from oklch(0.5 0.1 30) / calc(alpha / 2))",
        "oklch(0.5 0.1 30 / 0.5)",
      ),
    ] {
      assert_eq!(style(input).as_deref(), Some(expected), "{input}");
    }
  }

  #[test]
  fn sites_accept_like_chrome() {
    for rejected in [
      "min(50%, 10)",
      "rgb(calc(100-2) 0 0)",
      "light-dark(red, blue)",
      "AccentColor",
      "-webkit-link",
      "rgb(50%, 25, 10)",
      "/**/red",
      "re\\64",
      "\u{b}red",
      "color-mix(in srgb, violetred, white)",
      "alpha(from red)",
      "color-mix(in srgb, red -10%, blue)",
    ] {
      assert_eq!(style(rejected), None, "{rejected:?}");
    }
    assert_eq!(style("color-mix(in srgb, red, blue) x"), None);
    assert_eq!(
      stop("color-mix(in srgb, red, blue) x").as_deref(),
      Some("color(srgb 0.5 0 0.5)")
    );
    assert_eq!(
      stop("lab(calc(50) 40 30) x").as_deref(),
      Some("lab(50 40 30)")
    );
    assert_eq!(stop("rgb(calc(1 + 2) 0 0) x"), None);
    assert!(style("Highlight ").is_some());
    assert_eq!(style("currentColor").as_deref(), Some("#000000"));
  }

  #[test]
  fn filter_colors_resolve_currentcolor_to_black() {
    let lengths = Lengths {
      em: 16.0,
      rem: 16.0,
      ..Lengths::default()
    };
    let px = |s: &str| {
      with_parser(s, |p| {
        let color = consume_filter_color(p, &lengths)?;
        p.is_exhausted().then_some(color)
      })
      .map(|c| c.serialize_as_canvas_color())
    };
    assert_eq!(
      px("color-mix(in srgb, currentcolor, red)").as_deref(),
      Some("#000000")
    );
    assert_eq!(px("-webkit-link").as_deref(), Some("#000000"));
    assert_eq!(
      px("rgb(calc(1em / 1px * 10) 0 0)").as_deref(),
      Some("#a00000")
    );
    assert_eq!(px("/**/red").as_deref(), Some("#ff0000"));
    assert_eq!(px("violetred"), None);
    assert_eq!(px("red x"), None);
  }

  #[test]
  fn nesting_stops_at_the_limit() {
    let mix = |n: usize| {
      format!(
        "{}red{}",
        "color-mix(in srgb, ".repeat(n),
        ", blue)".repeat(n)
      )
    };
    assert!(style(&mix(COLOR_NESTING_LIMIT as usize)).is_some());
    assert_eq!(style(&mix(COLOR_NESTING_LIMIT as usize + 1)), None);
    assert_eq!(style(&mix(100_000)), None);
  }
}
