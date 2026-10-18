//! `ctx.filter` as Blink 155 runs it for a canvas:
//!
//! ```text
//!  string ──parse_filter──► ParsedFilter ──resolve──► Vec<CssFilter> ──css_filters_to_image_filter──► ImageFilter
//!          (CSS grammar)    (tokens, calc())  (lengths)  (numbers)        (FilterEffectBuilder)
//! ```
//!
//! * parse: CSSParser::ParseSingleValue(kFilter) -- ConsumeFilterFunctionList,
//!   ConsumeFilterFunction and ParseSingleShadow (css_parsing_utils.cc:811-905,
//!   4024-4047, 6021-6080). Math functions are layer 07's `css_math`, the
//!   drop-shadow() color is layer 07's color parser.
//! * resolve: FilterOperationResolver::CreateOffscreenFilterOperations
//!   (filter_operation_resolver.cc:128-170, 275-360) and
//!   StyleBuilderConverter::ConvertShadow. A Node canvas has no element, so
//!   the lengths are the OffscreenCanvas ones: em and rem are 16px, viewport,
//!   container and line-height units are 0, and the font-metric units come
//!   from the canvas font.
//! * build: FilterEffectBuilder (filter_effect_builder.cc).

use cssparser::{Parser, Token};

use crate::color::{self, Color};
use crate::css_math::{self, Category, Lengths, Literal, MathOptions, Node, Unit};
use crate::sk::ImageFilter;

/// A resolved filter function, the operand FilterEffectBuilder builds from.
/// The amounts are doubles and the lengths floats, as in Blink's
/// FilterOperations.
#[derive(Debug, Clone, PartialEq)]
pub enum CssFilter {
  Blur(f32),
  Brightness(f64),
  Contrast(f64),
  DropShadow(f32, f32, f32, Color),
  Grayscale(f64),
  HueRotate(f64),
  Invert(f64),
  Opacity(f64),
  Saturate(f64),
  Sepia(f64),
}

/// A numeric argument as parsed: a token, or a math function, whose value is
/// range-checked only when it is resolved.
#[derive(Clone, Debug)]
enum Arg {
  Literal(Literal),
  Math(Node),
}

impl Arg {
  fn any_unit(&self, f: &impl Fn(Unit) -> bool) -> bool {
    match self {
      Arg::Literal(l) => f(l.unit),
      Arg::Math(node) => node.any_unit(f),
    }
  }

  /// The value in its canonical unit (px, degrees), relative lengths resolved.
  fn compute(&self, lengths: &Lengths) -> f64 {
    match self {
      Arg::Literal(l) => Node::Literal(*l).compute_double(lengths),
      Arg::Math(node) => node.compute_double(lengths),
    }
  }
}

/// The `<number-percentage>` filter functions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Amount {
  Brightness,
  Contrast,
  Grayscale,
  Invert,
  Opacity,
  Saturate,
  Sepia,
}

/// One item of a parsed `<filter-value-list>`: a CSSFunctionValue, or url().
#[derive(Clone, Debug)]
enum FilterFunction {
  /// url(): a reference to an SVG filter, which a canvas filter skips.
  Url,
  Blur(Option<Arg>),
  Amount(Amount, Option<Arg>),
  HueRotate(Option<Arg>),
  DropShadow {
    x: Arg,
    y: Arg,
    std_deviation: Option<Arg>,
    /// Resolved as it was parsed, against the lengths `parse_filter` got.
    color: Color,
    /// The font-metric units the color has, at any depth.
    color_reads: FontReads,
  },
}

/// A `ctx.filter` string Blink accepts. `none` is the empty list.
#[derive(Clone, Debug)]
pub(crate) struct ParsedFilter(Vec<FilterFunction>);

/// What a filter reads from the canvas font, so that set_filter measures
/// only that: the units of Blink's FontSizes with `font_for_filter_`
/// (css_to_length_conversion_data.cc:101-195).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct FontReads {
  /// ex, ch, cap and their root forms: the "x" and "0" glyphs.
  pub(crate) glyphs: bool,
  /// ic and ric: the U+6C34 glyph.
  pub(crate) ideographic: bool,
}

impl FontReads {
  fn of_unit(unit: Unit) -> Self {
    Self {
      glyphs: matches!(
        unit,
        Unit::Ex | Unit::Rex | Unit::Ch | Unit::Rch | Unit::Cap | Unit::Rcap
      ),
      ideographic: matches!(unit, Unit::Ic | Unit::Ric),
    }
  }

  fn of_arg(arg: &Arg) -> Self {
    Self {
      glyphs: arg.any_unit(&|u| Self::of_unit(u).glyphs),
      ideographic: arg.any_unit(&|u| Self::of_unit(u).ideographic),
    }
  }

  fn union(self, other: Self) -> Self {
    Self {
      glyphs: self.glyphs || other.glyphs,
      ideographic: self.ideographic || other.ideographic,
    }
  }

  pub(crate) fn any(self) -> bool {
    self.glyphs || self.ideographic
  }
}

/// kOffScreenCanvasEmFontSize / kOffScreenCanvasRemFontSize.
const OFFSCREEN_EM: f64 = 16.0;

/// What the canvas font says, for the font-metric units.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct FontUnits {
  /// The x-height, or None when the font has none (then ex is 0.5em).
  pub(crate) x_height: Option<f64>,
  /// The advance of "0".
  pub(crate) zero_width: f64,
  pub(crate) cap_height: f64,
  /// The advance of U+6C34 in the primary font, or None when no family of
  /// the font exists or that font has no such glyph (then ic is 1em).
  pub(crate) ideographic_advance: Option<f64>,
}

/// CSSToLengthConversionData of CreateOffscreenFilterOperations: em and rem
/// 16px, no viewport, no container, no line height (lh is 0), and the
/// canvas font for ex, ch, cap and ic. FontSizes::Ic and Ric fall back to
/// em and rem, both 16px here (css_to_length_conversion_data.cc:139-167).
pub(crate) fn filter_lengths(font: FontUnits) -> Lengths {
  let ex = font.x_height.unwrap_or(OFFSCREEN_EM / 2.0);
  let ic = font.ideographic_advance.unwrap_or(OFFSCREEN_EM);
  Lengths {
    em: OFFSCREEN_EM,
    rem: OFFSCREEN_EM,
    ex,
    rex: ex,
    ch: font.zero_width,
    rch: font.zero_width,
    ic,
    ric: ic,
    cap: font.cap_height,
    rcap: font.cap_height,
    lh: 0.0,
    rlh: 0.0,
    viewport_width: 0.0,
    viewport_height: 0.0,
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Runs `f` and rewinds the parser when it fails.
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
  p.parse_nested_block(|q| f(q).ok_or_else(css_math::custom_error))
    .ok()
}

/// MathFunctionParser: a math function whose result has `category`.
fn consume_math(p: &mut Parser<'_>, allow_percent: bool, category: Category) -> Option<Arg> {
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
      channels: &[],
    };
    let node = nested(p, |q| css_math::parse_math_function(q, &name, options))?;
    (node.category() == category).then_some(Arg::Math(node))
  })
}

/// A numeric token (number, percentage or dimension) that `accept` takes.
fn consume_token(
  p: &mut Parser<'_>,
  accept: impl FnOnce(&Token<'_>, f64, Unit) -> Option<Literal>,
) -> Option<Arg> {
  attempt(p, |p| {
    let (token, source) = css_math::next_token(p)?;
    let (value, unit) = css_math::numeric_token(&token, source)?;
    accept(&token, value, unit?).map(Arg::Literal)
  })
}

/// ConsumeLength in kHTMLStandardMode: a length, or a unitless 0.
fn consume_length(p: &mut Parser<'_>, non_negative: bool) -> Option<Arg> {
  let literal = consume_token(p, |token, value, unit| {
    if non_negative && value < 0.0 {
      return None;
    }
    match token {
      Token::Number { .. } if value == 0.0 => Some(Literal {
        value,
        unit: Unit::Px,
      }),
      Token::Dimension { .. }
        if Node::Literal(Literal { value, unit }).category() == Category::Length =>
      {
        Some(Literal { value, unit })
      }
      _ => None,
    }
  });
  literal.or_else(|| consume_math(p, true, Category::Length))
}

/// ConsumePercent, then ConsumeNumber (ConsumeFilterFunction), both
/// kNonNegative.
fn consume_number_or_percent(p: &mut Parser<'_>) -> Option<Arg> {
  consume_token(p, |token, value, unit| {
    (matches!(token, Token::Percentage { .. }) && value >= 0.0).then_some(Literal { value, unit })
  })
  .or_else(|| consume_math(p, true, Category::Percent))
  .or_else(|| {
    consume_token(p, |token, value, unit| {
      (matches!(token, Token::Number { .. }) && value >= 0.0).then_some(Literal { value, unit })
    })
  })
  .or_else(|| consume_math(p, true, Category::Number))
}

/// ConsumeAngle with the filter's unitless zero.
fn consume_angle(p: &mut Parser<'_>) -> Option<Arg> {
  consume_token(p, |token, value, unit| match token {
    Token::Dimension { .. } if matches!(unit, Unit::Deg | Unit::Rad | Unit::Grad | Unit::Turn) => {
      Some(Literal { value, unit })
    }
    Token::Number { .. } if value == 0.0 => Some(Literal {
      value: 0.0,
      unit: Unit::Deg,
    }),
    _ => None,
  })
  .or_else(|| consume_math(p, false, Category::Angle))
}

/// The font-metric units of the dimensions anywhere in `p`, inside functions
/// and blocks too. Reads `p` to its end.
fn font_reads_of_tokens(p: &mut Parser<'_>) -> FontReads {
  let mut reads = FontReads::default();
  while let Some((token, source)) = css_math::next_token(p) {
    match token {
      Token::Dimension { .. } => {
        if let Some((_, Some(unit))) = css_math::numeric_token(&token, source) {
          reads = reads.union(FontReads::of_unit(unit));
        }
      }
      Token::Function(_)
      | Token::ParenthesisBlock
      | Token::SquareBracketBlock
      | Token::CurlyBracketBlock => {
        let nested_reads = nested(p, |q| Some(font_reads_of_tokens(q)));
        reads = reads.union(nested_reads.unwrap_or_default());
      }
      _ => {}
    }
  }
  reads
}

/// A drop-shadow() `<color>` read from `p`, resolved against `lengths`, and
/// the font-metric units it has (then `lengths` must have the font's).
fn consume_shadow_color(p: &mut Parser<'_>, lengths: &Lengths) -> Option<(Color, FontReads)> {
  let start = p.position();
  let color = color::consume_filter_color(p, lengths)?;
  // The color's own tokens, read again. The color parser's limits bound
  // their nesting.
  let mut tokens = Parser::new(p.slice_from(start));
  tokens.set_nested_block_limit(0);
  Some((color, font_reads_of_tokens(&mut tokens)))
}

/// ParseSingleShadow with inset and spread forbidden: a color before or
/// after the lengths, never between them.
fn consume_drop_shadow(p: &mut Parser<'_>, lengths: &Lengths) -> Option<FilterFunction> {
  if p.is_exhausted() {
    return None;
  }
  let mut color = consume_shadow_color(p, lengths);
  let x = consume_length(p, false)?;
  let y = consume_length(p, false)?;
  let std_deviation = consume_length(p, true);
  if color.is_none() && !p.is_exhausted() {
    color = consume_shadow_color(p, lengths);
  }
  // No color is currentcolor, black in a canvas filter (product decision:
  // OffscreenCanvas behaviour, no taint).
  let (color, color_reads) = color.unwrap_or((Color::BLACK, FontReads::default()));
  Some(FilterFunction::DropShadow {
    x,
    y,
    std_deviation,
    color,
    color_reads,
  })
}

/// The filter functions with one optional argument.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Function {
  Blur,
  HueRotate,
  Amount(Amount),
}

impl Function {
  fn from_name(name: &str) -> Option<Self> {
    Some(match name.to_ascii_lowercase().as_str() {
      "blur" => Self::Blur,
      "hue-rotate" => Self::HueRotate,
      "brightness" => Self::Amount(Amount::Brightness),
      "contrast" => Self::Amount(Amount::Contrast),
      "grayscale" => Self::Amount(Amount::Grayscale),
      "invert" => Self::Amount(Amount::Invert),
      "opacity" => Self::Amount(Amount::Opacity),
      "saturate" => Self::Amount(Amount::Saturate),
      "sepia" => Self::Amount(Amount::Sepia),
      _ => return None,
    })
  }
}

/// ConsumeFilterFunction for all but drop-shadow(): `p` is inside the
/// function's block. No argument at all is the default value.
fn consume_filter_function(function: Function, p: &mut Parser<'_>) -> Option<FilterFunction> {
  let arg = if p.is_exhausted() {
    None
  } else {
    let arg = match function {
      Function::Blur => consume_length(p, true),
      Function::HueRotate => consume_angle(p),
      Function::Amount(_) => consume_number_or_percent(p),
    };
    Some(arg?)
  };
  p.is_exhausted().then_some(match function {
    Function::Blur => FilterFunction::Blur(arg),
    Function::HueRotate => FilterFunction::HueRotate(arg),
    Function::Amount(amount) => FilterFunction::Amount(amount, arg),
  })
}

/// One `url()` or filter function.
fn consume_item(p: &mut Parser<'_>, lengths: &Lengths) -> Option<FilterFunction> {
  attempt(p, |p| {
    let (token, _) = css_math::next_token(p)?;
    match token {
      Token::UnquotedUrl(_) => Some(FilterFunction::Url),
      // url("…"): a string and nothing else (Chrome 155 rejects URL request
      // modifiers such as `url("#x" crossorigin(anonymous))`).
      Token::Function(name) if name.eq_ignore_ascii_case("url") => nested(p, |q| {
        q.expect_string().ok()?;
        q.is_exhausted().then_some(FilterFunction::Url)
      }),
      Token::Function(name) if name.eq_ignore_ascii_case("drop-shadow") => nested(p, |q| {
        let shadow = consume_drop_shadow(q, lengths)?;
        q.is_exhausted().then_some(shadow)
      }),
      Token::Function(name) => {
        let function = Function::from_name(&name)?;
        nested(p, |q| consume_filter_function(function, q))
      }
      _ => None,
    }
  })
}

/// Parse a `ctx.filter` string: None when Blink rejects it (the setter then
/// ignores the assignment). A drop-shadow() color is resolved as it is
/// parsed (layer 07's color parser), against `lengths`; what parses does not
/// depend on them.
pub(crate) fn parse_filter(input: &str, lengths: &Lengths) -> Option<ParsedFilter> {
  let mut p = Parser::new(input);
  // Our own limits (css_math, the color parser) bound the nesting.
  p.set_nested_block_limit(0);
  let none = attempt(&mut p, |p| match p.next() {
    Ok(Token::Ident(ident)) if ident.eq_ignore_ascii_case("none") => Some(()),
    _ => None,
  });
  if none.is_some() {
    return p.is_exhausted().then(|| ParsedFilter(Vec::new()));
  }
  // CSS-wide keywords, `,`, `!important` and anything else that is not a
  // url() or a filter function end the list; the input must end there too.
  let mut list = Vec::new();
  while let Some(item) = consume_item(&mut p, lengths) {
    list.push(item);
  }
  (!list.is_empty() && p.is_exhausted()).then_some(ParsedFilter(list))
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

/// CSSValueClampingUtils::ClampDouble: NaN is 0, infinities saturate.
fn clamp_double(v: f64) -> f64 {
  if v.is_nan() {
    0.0
  } else {
    v.clamp(f64::MIN, f64::MAX)
  }
}

/// CensorNaNToZero.
fn censor_nan(v: f64) -> f64 {
  if v.is_nan() { 0.0 } else { v }
}

/// CSSValueClampingUtils::ClampAngle: NaN is 0, and the largest multiple of
/// 360deg a double holds exactly bounds the rest.
fn clamp_angle(v: f64) -> f64 {
  const APPROX_DOUBLE_INFINITY_ANGLE: f64 = 2867080569122160.0;
  censor_nan(v).clamp(-APPROX_DOUBLE_INFINITY_ANGLE, APPROX_DOUBLE_INFINITY_ANGLE)
}

/// ClampTo<float>: saturates where `as f32` would overflow to infinity.
fn clamp_to_f32(v: f64) -> f32 {
  if v >= f32::MAX as f64 {
    f32::MAX
  } else if v <= f32::MIN as f64 {
    f32::MIN
  } else {
    v as f32
  }
}

/// kMinValueForCssLength / kMaxValueForCssLength (css_primitive_value.cc:50).
const MIN_CSS_LENGTH: f64 = (i32::MIN / 64 + 2) as f64;
const MAX_CSS_LENGTH: f64 = (i32::MAX / 64 - 2) as f64;

impl Arg {
  /// ResolveNumericArgumentForFunction's number or percentage, before the
  /// [0, 1] clamp: a math result is clamped to >= 0 (kNonNegative).
  fn resolve_amount(&self, lengths: &Lengths) -> f64 {
    match self {
      Arg::Literal(l) if l.unit == Unit::Percent => clamp_double(l.value) / 100.0,
      Arg::Literal(l) => clamp_double(l.value),
      Arg::Math(node) => {
        let v = clamp_double(censor_nan(node.compute_double(lengths)).max(0.0));
        if node.category() == Category::Percent {
          v / 100.0
        } else {
          v
        }
      }
    }
  }

  /// CSSPrimitiveValue::ComputeLength<float>; a math result is NaN-censored
  /// and, when `non_negative`, clamped to >= 0.
  fn resolve_length(&self, lengths: &Lengths, non_negative: bool) -> f32 {
    let mut v = censor_nan(self.compute(lengths));
    if non_negative && matches!(self, Arg::Math(_)) {
      v = v.max(0.0);
    }
    clamp_to_f32(clamp_double(v))
  }

  /// blur()'s ConvertToLength: ComputeLength<Length>, which clamps to the
  /// CSS length range; a math result is NaN-censored and clamped to >= 0
  /// first.
  fn resolve_blur(&self, lengths: &Lengths) -> f32 {
    let mut v = censor_nan(self.compute(lengths));
    if matches!(self, Arg::Math(_)) {
      v = v.max(0.0);
    }
    clamp_double(v).clamp(MIN_CSS_LENGTH, MAX_CSS_LENGTH) as f32
  }
}

impl ParsedFilter {
  /// What resolving reads from the canvas font (ex, ch, ic, cap and their
  /// root forms), so the caller measures only that. A drop-shadow() color
  /// that reads it was resolved while it parsed, so it needs a parse with the
  /// font's lengths.
  pub(crate) fn font_reads(&self) -> FontReads {
    let of = |arg: &Option<Arg>| arg.as_ref().map(FontReads::of_arg).unwrap_or_default();
    self
      .0
      .iter()
      .map(|f| match f {
        FilterFunction::Url => FontReads::default(),
        FilterFunction::Blur(arg)
        | FilterFunction::Amount(_, arg)
        | FilterFunction::HueRotate(arg) => of(arg),
        FilterFunction::DropShadow {
          x,
          y,
          std_deviation,
          color_reads,
          ..
        } => color_reads
          .union(FontReads::of_arg(x))
          .union(FontReads::of_arg(y))
          .union(of(std_deviation)),
      })
      .fold(FontReads::default(), FontReads::union)
  }

  /// CreateOffscreenFilterOperations: url() items are skipped.
  pub(crate) fn resolve(&self, lengths: &Lengths) -> Vec<CssFilter> {
    self
      .0
      .iter()
      .filter_map(|f| {
        Some(match f {
          FilterFunction::Url => return None,
          FilterFunction::Blur(arg) => {
            CssFilter::Blur(arg.as_ref().map_or(0.0, |a| a.resolve_blur(lengths)))
          }
          FilterFunction::Amount(kind, arg) => {
            let v = arg.as_ref().map_or(1.0, |a| a.resolve_amount(lengths));
            // Only these four clamp to 1 (FilterOperationResolver).
            let clamped = || v.clamp(0.0, 1.0);
            match kind {
              Amount::Brightness => CssFilter::Brightness(v),
              Amount::Contrast => CssFilter::Contrast(v),
              Amount::Saturate => CssFilter::Saturate(v),
              Amount::Grayscale => CssFilter::Grayscale(clamped()),
              Amount::Invert => CssFilter::Invert(clamped()),
              Amount::Opacity => CssFilter::Opacity(clamped()),
              Amount::Sepia => CssFilter::Sepia(clamped()),
            }
          }
          // CSSPrimitiveValue::ComputeDegrees, which ends in ClampAngle.
          FilterFunction::HueRotate(arg) => CssFilter::HueRotate(clamp_angle(match arg {
            None => 0.0,
            Some(Arg::Literal(l)) => l.degrees(),
            Some(Arg::Math(node)) => node.compute_double(lengths),
          })),
          FilterFunction::DropShadow {
            x,
            y,
            std_deviation,
            color,
            ..
          } => CssFilter::DropShadow(
            x.resolve_length(lengths, false),
            y.resolve_length(lengths, false),
            std_deviation
              .as_ref()
              .map_or(0.0, |a| a.resolve_length(lengths, true)),
            *color,
          ),
        })
      })
      .collect()
  }
}

// ---------------------------------------------------------------------------
// Building (FilterEffectBuilder)
// ---------------------------------------------------------------------------

/// Blink's `ClampToU8` (fe_component_transfer.cc): clamp, then truncate.
fn clamp_u8(v: f64) -> u8 {
  v.clamp(0.0, 255.0) as u8
}

/// Blink's FEComponentTransfer `Table()`: linear steps between the values,
/// in double.
fn transfer_table(values: &[f32]) -> [u8; 256] {
  let n = values.len();
  core::array::from_fn(|i| {
    let c = i as f64 / 255.0;
    let k = (c * (n - 1) as f64) as usize;
    let v1 = values[k] as f64;
    let v2 = values[(k + 1).min(n - 1)] as f64;
    clamp_u8(255.0 * (v1 + (c * (n - 1) as f64 - k as f64) * (v2 - v1)))
  })
}

/// Blink's FEComponentTransfer `Linear()`: `slope * i + 255 * intercept` on
/// the function's float fields, so the sum is a float.
fn transfer_linear(slope: f32, intercept: f32) -> [u8; 256] {
  core::array::from_fn(|i| clamp_u8((slope * i as f32 + 255f32 * intercept) as f64))
}

/// The same transfer table on R, G and B; alpha keeps its identity table.
fn rgb_transfer(table: &[u8; 256], chain: Option<&ImageFilter>) -> Option<ImageFilter> {
  ImageFilter::from_argb(None, Some(table), Some(table), Some(table), chain)
}

/// An RGB colour matrix, alpha kept.
fn rgb_matrix(m: [f32; 9], chain: Option<&ImageFilter>) -> Option<ImageFilter> {
  ImageFilter::make_image_filter(
    m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], 1.0, chain,
  )
}

/// Blink's GrayscaleMatrix / SepiaMatrix (filter_effect_builder.cc): the
/// entries are `base + scale * (1 - amount)` in double, stored as float.
fn amount_matrix(amount: f64, base: [f64; 9], scale: [f64; 9]) -> [f32; 9] {
  let one_minus_amount = (1.0 - amount).clamp(0.0, 1.0);
  core::array::from_fn(|i| clamp_to_f32(base[i] + scale[i] * one_minus_amount))
}

/// Fold a resolved `<filter-value-list>` into one chained `SkImageFilter`
/// the way Blink's FilterEffectBuilder builds it, or `None` when the list
/// produces no filter at all.
///
/// `None` is the only representation of "no filter" this may return, and the
/// chain is threaded as an `Option` so that an empty list yields it by
/// construction. A null `ImageFilter` here would reach
/// `skiac_paint_set_image_filter` on the next draw and segfault.
pub(crate) fn css_filters_to_image_filter(filters: Vec<CssFilter>) -> Option<ImageFilter> {
  let mut chain: Option<ImageFilter> = None;
  for f in filters {
    // A filter that fails to build takes the whole list with it.
    let next = match f {
      CssFilter::Blur(blur) => ImageFilter::make_blur(blur, blur, chain.as_ref()),
      CssFilter::Brightness(amount) => {
        rgb_transfer(&transfer_linear(clamp_to_f32(amount), 0.0), chain.as_ref())
      }
      CssFilter::Contrast(amount) => {
        let slope = clamp_to_f32(amount);
        let intercept = (-0.5 * slope as f64 + 0.5) as f32;
        rgb_transfer(&transfer_linear(slope, intercept), chain.as_ref())
      }
      // Blink always builds the FEDropShadow, even a transparent or an
      // all-zero one, and takes the blur as its standard deviation ("stored
      // in sigma form", filter_effect_builder.cc). Blink hands Skia
      // `color.toSkColor4f().toSkColor()` (cc/paint/paint_filter.cc:391-400).
      CssFilter::DropShadow(offset_x, offset_y, std_deviation, shadow_color) => {
        ImageFilter::make_drop_shadow(
          offset_x,
          offset_y,
          std_deviation,
          std_deviation,
          shadow_color.to_sk_color4f().to_sk_color(),
          chain.as_ref(),
        )
      }
      CssFilter::Grayscale(amount) => rgb_matrix(
        amount_matrix(
          amount,
          [
            0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722,
          ],
          [
            0.7874, -0.7152, -0.0722, -0.2126, 0.2848, -0.0722, -0.2126, -0.7152, 0.9278,
          ],
        ),
        chain.as_ref(),
      ),
      // FEColorMatrix HueRotateMatrix (fe_color_matrix.cc), all float.
      CssFilter::HueRotate(angle) => {
        let radians = clamp_to_f32(angle) * (std::f32::consts::PI / 180.0);
        let (sin, cos) = (radians.sin(), radians.cos());
        rgb_matrix(
          [
            0.213 + cos * 0.787 - sin * 0.213,
            0.715 - cos * 0.715 - sin * 0.715,
            0.072 - cos * 0.072 + sin * 0.928,
            0.213 - cos * 0.213 + sin * 0.143,
            0.715 + cos * 0.285 + sin * 0.140,
            0.072 - cos * 0.072 - sin * 0.283,
            0.213 - cos * 0.213 - sin * 0.787,
            0.715 - cos * 0.715 + sin * 0.715,
            0.072 + cos * 0.928 + sin * 0.072,
          ],
          chain.as_ref(),
        )
      }
      CssFilter::Invert(amount) => {
        let table = transfer_table(&[clamp_to_f32(amount), clamp_to_f32(1.0 - amount)]);
        rgb_transfer(&table, chain.as_ref())
      }
      // A table on alpha only.
      CssFilter::Opacity(amount) => {
        let table = transfer_table(&[0.0, clamp_to_f32(amount)]);
        ImageFilter::from_argb(Some(&table), None, None, None, chain.as_ref())
      }
      // FEColorMatrix SaturateMatrix (fe_color_matrix.cc), all float.
      CssFilter::Saturate(amount) => {
        let s = clamp_to_f32(amount);
        rgb_matrix(
          [
            0.213 + 0.787 * s,
            0.715 - 0.715 * s,
            0.072 - 0.072 * s,
            0.213 - 0.213 * s,
            0.715 + 0.285 * s,
            0.072 - 0.072 * s,
            0.213 - 0.213 * s,
            0.715 - 0.715 * s,
            0.072 + 0.928 * s,
          ],
          chain.as_ref(),
        )
      }
      CssFilter::Sepia(amount) => rgb_matrix(
        amount_matrix(
          amount,
          [
            0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131,
          ],
          [
            0.607, -0.769, -0.189, -0.349, 0.314, -0.168, -0.272, -0.534, 0.869,
          ],
        ),
        chain.as_ref(),
      ),
    };
    chain = Some(next?);
  }
  chain
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The lengths of a 10px font whose x-height is 5, "0" 6 wide, cap
  /// height 7 and U+6C34 9 wide.
  fn lengths() -> Lengths {
    filter_lengths(FontUnits {
      x_height: Some(5.0),
      zero_width: 6.0,
      cap_height: 7.0,
      ideographic_advance: Some(9.0),
    })
  }

  fn parse(s: &str) -> Option<ParsedFilter> {
    parse_filter(s, &lengths())
  }

  /// What `s` resolves to with that font; None when it is rejected.
  fn resolve(s: &str) -> Option<Vec<CssFilter>> {
    parse(s).map(|f| f.resolve(&lengths()))
  }

  fn one(s: &str) -> CssFilter {
    let mut list = resolve(s).unwrap_or_else(|| panic!("`{s}` should parse"));
    assert_eq!(list.len(), 1, "{s}");
    list.remove(0)
  }

  /// The resolved filters with each drop-shadow() color as Skia gets it, ARGB.
  fn with_argb(s: &str) -> Option<Vec<(CssFilter, u32)>> {
    Some(
      resolve(s)?
        .into_iter()
        .map(|f| match f {
          CssFilter::DropShadow(x, y, blur, c) => (
            CssFilter::DropShadow(x, y, blur, Color::BLACK),
            c.to_sk_color4f().to_sk_color(),
          ),
          f => (f, 0),
        })
        .collect(),
    )
  }

  fn shadow(x: f32, y: f32, blur: f32, argb: u32) -> (CssFilter, u32) {
    (CssFilter::DropShadow(x, y, blur, Color::BLACK), argb)
  }

  #[test]
  fn empty_filter_list_is_no_filter_not_a_null_one() {
    // Pins the `Option` chain: an empty list must produce `None`, not a
    // `Some(ImageFilter(null))` that the next draw would dereference.
    assert!(css_filters_to_image_filter(vec![]).is_none());
    assert!(css_filters_to_image_filter(resolve("url(#x)").unwrap()).is_none());
  }

  #[test]
  fn the_whole_string_is_one_filter_value() {
    for input in [
      "blur(3px)",
      "blur(3px) grayscale(50%)",
      "contrast(175%) brightness(103%)",
      "drop-shadow(16px 16px 10px black)",
      "hue-rotate(90deg)",
      " blur(3px) ",
      "blur(1px)blur(1px)",
      "blur(1px) /* c */",
      "BLUR(2px)",
      "blur(1px",
      "url(#x)",
      "url(\"#x\") blur(1px)",
      "URL(#x)",
    ] {
      assert!(parse(input).is_some_and(|f| !f.0.is_empty()), "{input:?}");
    }
    for input in ["none", "NONE", " none "] {
      assert!(parse(input).is_some_and(|f| f.0.is_empty()), "{input:?}");
    }
    for input in [
      "",
      "   ",
      "garbage",
      "inherit",
      "initial",
      "unset",
      "revert",
      "revert-layer",
      "blur(3px) notafilter(1)",
      "blur(1px),blur(1px)",
      "blur(2px) ; ",
      "blur(2px) !important",
      "blur(1px) none",
      "none blur(1px)",
      "url(#x x)",
      "url(\"#x\" x)",
    ] {
      assert!(parse(input).is_none(), "{input:?}");
    }
  }

  #[test]
  fn arguments_follow_the_css_grammar() {
    assert_eq!(one("blur(20px)"), CssFilter::Blur(20.0));
    assert_eq!(one("blur(0)"), CssFilter::Blur(0.0));
    assert_eq!(one("blur()"), CssFilter::Blur(0.0));
    assert_eq!(one("blur(1.5rem)"), CssFilter::Blur(24.0));
    assert_eq!(one("blur(1.5em)"), CssFilter::Blur(24.0));
    assert_eq!(one("blur(1e1px)"), CssFilter::Blur(10.0));
    assert_eq!(one("blur(1in)"), CssFilter::Blur(96.0));
    assert_eq!(one("blur(1vw)"), CssFilter::Blur(0.0));
    assert_eq!(one("blur(2ex)"), CssFilter::Blur(10.0));
    assert_eq!(one("blur(2ch)"), CssFilter::Blur(12.0));
    assert_eq!(one("blur(1cap)"), CssFilter::Blur(7.0));
    assert_eq!(one("blur(1ic)"), CssFilter::Blur(9.0));
    assert_eq!(one("blur(2ric)"), CssFilter::Blur(18.0));
    assert_eq!(one("blur(1lh)"), CssFilter::Blur(0.0));
    assert_eq!(one("grayscale()"), CssFilter::Grayscale(1.0));
    assert_eq!(one("grayscale(2)"), CssFilter::Grayscale(1.0));
    assert_eq!(one("opacity(50%)"), CssFilter::Opacity(0.5));
    assert_eq!(one("brightness(2)"), CssFilter::Brightness(2.0));
    assert_eq!(one("saturate(250%)"), CssFilter::Saturate(2.5));
    assert_eq!(one("hue-rotate()"), CssFilter::HueRotate(0.0));
    assert_eq!(one("hue-rotate(0)"), CssFilter::HueRotate(0.0));
    assert_eq!(one("hue-rotate(90deg)"), CssFilter::HueRotate(90.0));
    assert_eq!(one("hue-rotate(-0.25turn)"), CssFilter::HueRotate(-90.0));
    assert_eq!(one("hue-rotate(100grad)"), CssFilter::HueRotate(90.0));
    for input in [
      "blur(-1px)",
      "blur(2)",
      "blur(2%)",
      "blur(20 px)",
      "blur( 20 px )",
      "grayscale(-1)",
      "opacity(50 %)",
      "brightness(-1)",
      "hue-rotate(90)",
      "hue-rotate(90 deg)",
      "blur(var(--x))",
      "foo(1)",
    ] {
      assert!(parse(input).is_none(), "{input:?}");
    }
  }

  #[test]
  fn math_functions_are_typed_and_clamped_when_used() {
    assert_eq!(one("blur(calc(1px + 2px))"), CssFilter::Blur(3.0));
    assert_eq!(one("blur(calc(1px - 3px))"), CssFilter::Blur(0.0));
    assert_eq!(one("blur(calc(NaN * 1px))"), CssFilter::Blur(0.0));
    assert_eq!(one("blur(calc(0.2em + 1px))"), CssFilter::Blur(4.2));
    assert_eq!(one("opacity(calc(2))"), CssFilter::Opacity(1.0));
    assert_eq!(one("opacity(calc(50% + 10%))"), CssFilter::Opacity(0.6));
    assert_eq!(one("contrast(calc(-1))"), CssFilter::Contrast(0.0));
    assert_eq!(one("hue-rotate(calc(-90deg))"), CssFilter::HueRotate(-90.0));
    assert_eq!(
      one("hue-rotate(calc(NaN * 1deg))"),
      CssFilter::HueRotate(0.0)
    );
    assert_eq!(
      with_argb("drop-shadow(calc(1px * 3) min(1px, 2px) max(-1px, 0px))"),
      Some(vec![shadow(3.0, 1.0, 0.0, 0xff000000)])
    );
    assert_eq!(
      with_argb("drop-shadow(calc(infinity * 1px) 0 calc(-1px))"),
      Some(vec![shadow(f32::MAX, 0.0, 0.0, 0xff000000)])
    );
    for input in [
      "blur(calc(0))",
      "blur(calc(1px + 2))",
      "blur(calc(6px / 2px))",
      "blur(calc(100% - 1px))",
      "blur(calc(1px+2px))",
      "opacity(calc(0.25 + 25%))",
      "opacity(calc(0.5px))",
      "opacity(calc(50% * 50%))",
      "hue-rotate(calc(90))",
      "hue-rotate(calc(90deg + 1px))",
      "hue-rotate(calc(90deg / 1deg))",
      "drop-shadow(sign(-3px) 0 0 red)",
      "drop-shadow(round(2.5px) 0 0 red)",
    ] {
      assert!(parse(input).is_none(), "{input:?}");
    }
  }

  #[test]
  fn font_metric_units_are_flagged() {
    const NONE: FontReads = FontReads {
      glyphs: false,
      ideographic: false,
    };
    const GLYPHS: FontReads = FontReads {
      glyphs: true,
      ideographic: false,
    };
    const IC: FontReads = FontReads {
      glyphs: false,
      ideographic: true,
    };
    const BOTH: FontReads = FontReads {
      glyphs: true,
      ideographic: true,
    };
    for (input, reads) in [
      ("blur(1px)", NONE),
      ("blur(1em)", NONE),
      ("blur(1ex)", GLYPHS),
      ("blur(1ic)", IC),
      ("hue-rotate(0) blur(calc(1ric + 1px))", IC),
      ("drop-shadow(calc(1px + 1ch) 0)", GLYPHS),
      ("drop-shadow(0 0 1rcap)", GLYPHS),
      ("drop-shadow(1ic 1ex)", BOTH),
      ("blur(1ic) drop-shadow(0 0 1rch)", BOTH),
      ("opacity(1) url(#x)", NONE),
      // A drop-shadow() color, at any depth, before or after the lengths.
      ("drop-shadow(1px 1px rgb(calc(1ex / 1px) 0 0))", GLYPHS),
      ("drop-shadow(rgb(calc(1ric / 1px) 0 0) 1px 1px)", IC),
      (
        "drop-shadow(1px 1px rgb(calc(1ic / 1px) calc(1ch / 1px) 0))",
        BOTH,
      ),
      (
        "drop-shadow(1px 1px color-mix(in srgb, rgb(0 calc((1px + 1cap) / 1px) 0), red))",
        GLYPHS,
      ),
      (
        "drop-shadow(1px 1px color-mix(in srgb, rgb(0 calc((1px + 1IC) / 1px) 0), red))",
        IC,
      ),
      (
        "drop-shadow(1px 1px rgb(from red calc(1rch / 1px) g b))",
        GLYPHS,
      ),
      ("drop-shadow(1px 1px rgb(calc(1\\63 h / 1px) 0 0))", GLYPHS),
      ("drop-shadow(1px 1px rgb(calc(1\\69 c / 1px) 0 0))", IC),
      ("drop-shadow(1px 1px rgb(calc(1em / 1px) 0 0))", NONE),
      ("drop-shadow(rgb(calc(1lh / 1px) 0 0) 1px 1ch)", GLYPHS),
      ("drop-shadow(rgb(calc(1lh / 1px) 0 0) 1px 1px)", NONE),
      ("drop-shadow(rgb(calc(1ric / 1px) 0 0) 1px 1ch)", BOTH),
    ] {
      let got = parse(input).unwrap().font_reads();
      assert_eq!(got, reads, "{input}");
      assert_eq!(got.any(), reads != NONE, "{input}");
    }
    // A font without an x-height: ex is 0.5em. A primary font without
    // U+6C34: ic and ric are em and rem, 16px.
    let lengths = filter_lengths(FontUnits::default());
    assert_eq!(
      parse("blur(1ex) blur(1ic) blur(1ric)")
        .unwrap()
        .resolve(&lengths),
      vec![
        CssFilter::Blur(8.0),
        CssFilter::Blur(16.0),
        CssFilter::Blur(16.0)
      ]
    );
  }

  // A drop-shadow() color resolves against the lengths it was parsed with,
  // the same the filter's lengths use (ConvertShadow).
  #[test]
  fn shadow_colors_resolve_font_units() {
    for (input, argb) in [
      (
        "drop-shadow(20px 0 0 rgb(calc(10ex / 1px) 0 0))",
        0xff320000,
      ),
      (
        "drop-shadow(20px 0 0 rgb(calc(10ch / 1px) 0 0))",
        0xff3c0000,
      ),
      (
        "drop-shadow(20px 0 0 rgb(calc(10cap / 1px) 0 0))",
        0xff460000,
      ),
      (
        "drop-shadow(20px 0 0 rgb(calc(10ic / 1px) 0 0))",
        0xff5a0000,
      ),
      (
        "drop-shadow(20px 0 0 rgb(calc(10ric / 1px) 0 0))",
        0xff5a0000,
      ),
      (
        "drop-shadow(rgb(calc(10rch / 1px) 0 0) 20px 0 0)",
        0xff3c0000,
      ),
      (
        "drop-shadow(20px 0 0 rgb(calc(calc(5ch / 1px) * 2) 0 calc(1ex / 1px)))",
        0xff3c0005,
      ),
      (
        "drop-shadow(20px 0 0 rgb(calc(10lh / 1px) 0 0))",
        0xff000000,
      ),
    ] {
      assert_eq!(
        with_argb(input),
        Some(vec![shadow(20.0, 0.0, 0.0, argb)]),
        "{input}"
      );
    }
  }

  #[test]
  fn drop_shadow_parse() {
    assert_eq!(
      with_argb("drop-shadow(2px 2px)"),
      Some(vec![shadow(2.0, 2.0, 0.0, 0xff000000)])
    );
    assert_eq!(
      with_argb("drop-shadow(2px 2px 5px)"),
      Some(vec![shadow(2.0, 2.0, 5.0, 0xff000000)])
    );
    assert_eq!(
      with_argb("drop-shadow(2px 2px 5px #2F14DF)"),
      Some(vec![shadow(2.0, 2.0, 5.0, 0xff2f14df)])
    );
    assert_eq!(
      with_argb("drop-shadow(#2F14DF 2px 2px 5px)"),
      Some(vec![shadow(2.0, 2.0, 5.0, 0xff2f14df)])
    );
    assert_eq!(
      with_argb("drop-shadow(2px 2px 5px rgba(47, 20, 223, 255))"),
      Some(vec![shadow(2.0, 2.0, 5.0, 0xff2f14df)])
    );
    assert_eq!(
      with_argb("drop-shadow(-2px 2px 1em red)"),
      Some(vec![shadow(-2.0, 2.0, 16.0, 0xffff0000)])
    );

    // Chrome 155 draws hsl(120, 100%, 25%) as 0,128,0.
    assert_eq!(
      with_argb("drop-shadow(4px 0 0 hsl(120, 100%, 25%)) blur(1px)"),
      Some(vec![
        shadow(4.0, 0.0, 0.0, 0xff008000),
        (CssFilter::Blur(1.0), 0)
      ])
    );
    assert_eq!(
      with_argb("drop-shadow(4px 0 0 hsla(0, 100%, 50%, 0.5))"),
      Some(vec![shadow(4.0, 0.0, 0.0, 0x80ff0000)])
    );

    // CSS function names are ASCII case-insensitive; Chrome 155 keeps all of these.
    for (input, color) in [
      ("HSL(120, 100%, 25%)", 0xff008000),
      ("HsLa(0, 100%, 50%, 0.5)", 0x80ff0000),
      ("RGB(0, 128, 0)", 0xff008000),
      ("rGbA(255, 0, 0, 0.5)", 0x80ff0000),
    ] {
      assert_eq!(
        with_argb(&format!("DROP-SHADOW(4px 0 0 {input}) blur(1px)")),
        Some(vec![
          shadow(4.0, 0.0, 0.0, color),
          (CssFilter::Blur(1.0), 0)
        ]),
        "{input}"
      );
    }

    // The color slot is CSS: nested functions, comments, and the end of input
    // closing the open blocks (Chrome 155 keeps each of these filters).
    for (input, color) in [
      (
        "drop-shadow(20px 0 0 color-mix(in srgb, red, blue))",
        0xff800080,
      ),
      (
        "drop-shadow(20px 0 0 rgb(from red r g calc(b + 255)))",
        0xffff00ff,
      ),
      ("drop-shadow(20px 0 0 /**/red)", 0xffff0000),
      ("drop-shadow(20px 0 0 rgb(1 2 3)", 0xff010203),
      ("drop-shadow(20px 0 0 rgb(1 2 3", 0xff010203),
      ("drop-shadow(20px 0 0 /**/)", 0xff000000),
      ("drop-shadow(20px 0 0 currentcolor)", 0xff000000),
      ("drop-shadow(20px 0 0 transparent)", 0x00000000),
    ] {
      assert_eq!(
        with_argb(input),
        Some(vec![shadow(20.0, 0.0, 0.0, color)]),
        "{input}"
      );
    }
    // A color it cannot read, a fourth length, a color between the lengths
    // or a negative blur rejects the whole filter.
    for input in [
      "drop-shadow(20px 0 0 red x)",
      "drop-shadow(20px 0 0 inherit)",
      "drop-shadow(20px 0 0 violetred)",
      "drop-shadow(red 2px 2px blue)",
      "drop-shadow(2px)",
      "drop-shadow()",
      "drop-shadow(2px 2px 2px 2px red)",
      "drop-shadow(2px 2px red 2px)",
      "drop-shadow(2px 2px -1px red)",
      "drop-shadow(2px, 2px, red)",
      "drop-shadow(inset 2px 2px red)",
      "drop-shadow(2px 2px red inset)",
    ] {
      assert!(parse(input).is_none(), "{input}");
    }
  }

  #[test]
  fn composite_parse() {
    assert_eq!(
      resolve("blur(1.5rem) brightness(2)"),
      Some(vec![CssFilter::Blur(24.0), CssFilter::Brightness(2.0)])
    );
    assert_eq!(
      resolve("brightness(2) blur(1.5rem) url(#x)"),
      Some(vec![CssFilter::Brightness(2.0), CssFilter::Blur(24.0)])
    );
    let shadow = shadow(2.0, 2.0, 5.0, 0xff2f14df);
    for (input, expected) in [
      (
        "drop-shadow(2px 2px 5px rgba(47, 20, 223, 255)) brightness(2) blur(1.5rem)",
        vec![
          shadow.clone(),
          (CssFilter::Brightness(2.0), 0),
          (CssFilter::Blur(24.0), 0),
        ],
      ),
      (
        "brightness(2) drop-shadow(2px 2px 5px rgba(47, 20, 223, 255)) blur(1.5rem)",
        vec![
          (CssFilter::Brightness(2.0), 0),
          shadow.clone(),
          (CssFilter::Blur(24.0), 0),
        ],
      ),
    ] {
      assert_eq!(with_argb(input), Some(expected), "{input}");
    }
  }
}
