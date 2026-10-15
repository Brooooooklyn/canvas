//! The canvas `font` attribute: Blink's `font` shorthand parser
//! (shorthands_custom.cc ConsumeFont), the computed values a canvas keeps
//! (style_builder_converter.cc, font_builder.cc) and the getter's
//! serialization (base_rendering_context_2d.cc font()).

use cssparser::{Parser, Token};

use crate::color::math::{self, Allowed, Category, LengthCtx, LengthUnit};
use crate::color::token;

/// The default font size.
pub const FONT_MEDIUM_PX: f32 = 16.0;

/// The canvas default font is `10px sans-serif` (canvas_font_cache.cc).
const PARENT_FONT_SIZE: f64 = 10.0;
/// The root element's font size, for `rem`.
const ROOT_FONT_SIZE: f64 = 16.0;
/// font_size_functions.h kMaximumAllowedFontSize.
const MAX_FONT_SIZE: f32 = 10000.0;
/// FontSelectionValue keeps a quarter step (font_selection_types.h).
const FONT_SELECTION_STEP: f64 = 4.0;
/// kItalicSlopeValue.
pub const ITALIC_SLOPE: f32 = 14.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenericFamily {
  Serif,
  SansSerif,
  Cursive,
  Fantasy,
  Monospace,
  SystemUi,
  WebkitBody,
  Math,
}

impl GenericFamily {
  /// The generic family keywords (css_value_keywords.json5 serif..math).
  fn from_ident(ident: &str) -> Option<Self> {
    Some(match ident.to_ascii_lowercase().as_str() {
      "serif" => Self::Serif,
      "sans-serif" => Self::SansSerif,
      "cursive" => Self::Cursive,
      "fantasy" => Self::Fantasy,
      "monospace" => Self::Monospace,
      "system-ui" => Self::SystemUi,
      "-webkit-body" => Self::WebkitBody,
      "math" => Self::Math,
      _ => return None,
    })
  }

  pub fn as_str(&self) -> &'static str {
    match self {
      Self::Serif => "serif",
      Self::SansSerif => "sans-serif",
      Self::Cursive => "cursive",
      Self::Fantasy => "fantasy",
      Self::Monospace => "monospace",
      Self::SystemUi => "system-ui",
      Self::WebkitBody => "-webkit-body",
      Self::Math => "math",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FamilyName {
  Generic(GenericFamily),
  /// A family name as written (strings and joined identifiers).
  Named(String),
}

/// The `font-style` keyword that set the slope (face matching only).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StyleKeyword {
  Normal,
  Italic,
  Oblique,
}

/// Blink's FontDescription fields that the canvas font shorthand sets.
#[derive(Debug, Clone, PartialEq)]
pub struct ComputedFont {
  /// Degrees, in FontSelectionValue quarter steps; 14 for italic/oblique.
  pub slope: f32,
  pub style: StyleKeyword,
  /// 1..=1000, in FontSelectionValue quarter steps.
  pub weight: f32,
  pub stretch: FontStretch,
  /// The shorthand's `small-caps`.
  pub small_caps: bool,
  /// The computed size in px.
  pub size: f32,
  pub families: Vec<FamilyName>,
}

impl Default for ComputedFont {
  /// `10px sans-serif`.
  fn default() -> Self {
    ComputedFont {
      slope: 0.0,
      style: StyleKeyword::Normal,
      weight: 400.0,
      stretch: FontStretch::Normal,
      small_caps: false,
      size: 10.0,
      families: vec![FamilyName::Generic(GenericFamily::SansSerif)],
    }
  }
}

impl ComputedFont {
  /// The text FFI's integer weight.
  pub(crate) fn legacy_weight(&self) -> u32 {
    self.weight.round() as u32
  }

  /// The text FFI's slant.
  pub(crate) fn legacy_slant(&self) -> FontStyle {
    match self.style {
      StyleKeyword::Italic => FontStyle::Italic,
      StyleKeyword::Oblique => FontStyle::Oblique,
      StyleKeyword::Normal => FontStyle::Normal,
    }
  }

  /// The text FFI's comma-separated family list.
  pub(crate) fn legacy_family_list(&self) -> String {
    self
      .families
      .iter()
      .map(|f| match f {
        FamilyName::Generic(g) => g.as_str(),
        FamilyName::Named(name) => name.as_str(),
      })
      .collect::<Vec<_>>()
      .join(",")
  }
}

/// The px value of one `ex`, `ch`, `cap`, `ic` and `lh` of a font.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FontRelativeUnits {
  pub ex: f64,
  pub ch: f64,
  pub cap: f64,
  pub ic: f64,
  pub lh: f64,
}

impl FontRelativeUnits {
  /// Blink's fallbacks for a font of `size` px without the metrics
  /// (simple_font_data.cc: x-height 0.56 ascent, ch 0.5em, ic 1em).
  pub fn fallback(size: f64) -> Self {
    FontRelativeUnits {
      ex: size * 0.5,
      ch: size * 0.5,
      cap: size * 0.7,
      ic: size,
      lh: (size * 1.2).round(),
    }
  }
}

/// The parent of a canvas font: the 10px default font, and the root element's
/// 16px font for root-relative units. Both use the standard font's metrics.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FontParseContext {
  pub parent: FontRelativeUnits,
  pub root: FontRelativeUnits,
}

impl Default for FontParseContext {
  fn default() -> Self {
    FontParseContext {
      parent: FontRelativeUnits::fallback(PARENT_FONT_SIZE),
      root: FontRelativeUnits::fallback(ROOT_FONT_SIZE),
    }
  }
}

impl FontParseContext {
  fn length_ctx(&self) -> LengthCtx {
    LengthCtx {
      em: PARENT_FONT_SIZE,
      rem: ROOT_FONT_SIZE,
      ex: self.parent.ex,
      rex: self.root.ex,
      ch: self.parent.ch,
      rch: self.root.ch,
      cap: self.parent.cap,
      rcap: self.root.cap,
      ic: self.parent.ic,
      ric: self.root.ic,
      lh: self.parent.lh,
      rlh: self.root.lh,
      // Node has no viewport: an OffscreenCanvas resolves these to 0.
      vw: 0.0,
      vh: 0.0,
      percent_base: PARENT_FONT_SIZE,
    }
  }
}

/// A size before the family is known (the monospace rule needs it).
enum SpecifiedSize {
  /// xx-small (1) .. xxx-large (8).
  Keyword(usize),
  /// px; `relative` sizes follow the parent's is-absolute flag (false).
  Value { px: f64, relative: bool },
}

/// FontSelectionValue(double): truncated to a quarter, saturating to int16.
fn font_selection_value(v: f64) -> f32 {
  let raw = (v * FONT_SELECTION_STEP).clamp(i16::MIN as f64, i16::MAX as f64);
  (raw.trunc() / FONT_SELECTION_STEP) as f32
}

fn next_ident<'i>(p: &mut Parser<'i>) -> Option<String> {
  match p.next() {
    Ok(Token::Ident(ident)) => Some(ident.to_ascii_lowercase()),
    _ => None,
  }
}

/// ConsumeFontStyle after `italic` or `oblique`: the slope in degrees and the
/// keyword, or None when the angle is invalid (which fails the shorthand).
fn consume_font_style<'i>(p: &mut Parser<'i>, ctx: &LengthCtx) -> Option<(f32, StyleKeyword)> {
  match next_ident(p)?.as_str() {
    "italic" => Some((ITALIC_SLOPE, StyleKeyword::Italic)),
    "oblique" => {
      // An optional <angle>: a literal one is limited to [-90, 90] on its
      // written number (IsAngleWithinLimits), and 0 is `normal`.
      let angle = p.try_parse(|p| -> Result<Result<f64, ()>, ()> {
        if let Ok(expr) = p.try_parse(|p| math::parse(p, Allowed::Angle).ok_or(())) {
          return Ok(Ok(expr.eval(ctx).unwrap_or(0.0)));
        }
        let t = token::next(p).map_err(|_| ())?;
        match t.token {
          Token::Dimension { ref unit, .. } => {
            let degrees = math::angle_degrees(t.value, unit).ok_or(())?;
            if !(-90.0..=90.0).contains(&t.value) {
              return Ok(Err(()));
            }
            Ok(Ok(degrees))
          }
          _ => Err(()),
        }
      });
      match angle {
        Err(()) => Some((ITALIC_SLOPE, StyleKeyword::Oblique)),
        Ok(Err(())) => None,
        Ok(Ok(0.0)) => Some((0.0, StyleKeyword::Normal)),
        Ok(Ok(degrees)) => Some((font_selection_value(degrees), StyleKeyword::Oblique)),
      }
    }
    _ => None,
  }
}

/// ConsumeFontWeight: a keyword, or a number in [1, 1000] (a literal outside
/// it is not a weight, so it can still be the size), or a math function.
fn consume_font_weight<'i>(p: &mut Parser<'i>, ctx: &LengthCtx) -> Result<f64, ()> {
  if let Ok(expr) = p.try_parse(|p| math::parse(p, Allowed::Number).ok_or(())) {
    return Ok(expr.eval(ctx).unwrap_or(0.0));
  }
  let t = token::next(p).map_err(|_| ())?;
  match t.token {
    Token::Ident(ref ident) => match ident.to_ascii_lowercase().as_str() {
      "normal" => Ok(400.0),
      "bold" => Ok(700.0),
      // BolderWeight / LighterWeight of the default font's 400.
      "bolder" => Ok(700.0),
      "lighter" => Ok(100.0),
      _ => Err(()),
    },
    Token::Number { .. } if (1.0..=1000.0).contains(&t.value) => Ok(t.value),
    _ => Err(()),
  }
}

fn consume_stretch_keyword<'i>(p: &mut Parser<'i>) -> Result<FontStretch, ()> {
  let ident = next_ident(p).ok_or(())?;
  if ident == "normal" {
    return Ok(FontStretch::Normal);
  }
  parse_font_stretch(&ident).ok_or(())
}

/// ConsumeFontSize: a keyword or a non-negative <length-percentage>.
fn consume_font_size<'i>(p: &mut Parser<'i>, ctx: &LengthCtx) -> Result<SpecifiedSize, ()> {
  if let Ok(expr) = p.try_parse(|p| math::parse(p, Allowed::LengthPercentage).ok_or(())) {
    // Calc clamps to the property's range; a percentage-only expression
    // keeps the parent's is-absolute flag like a percentage.
    let px = expr.eval(ctx).unwrap_or(0.0).max(0.0);
    return Ok(SpecifiedSize::Value {
      px,
      relative: expr.category() == Category::Percent,
    });
  }
  let t = token::next(p).map_err(|_| ())?;
  match t.token {
    Token::Ident(ref ident) => {
      let keyword = match ident.to_ascii_lowercase().as_str() {
        "xx-small" => 1,
        "x-small" => 2,
        "small" => 3,
        "medium" => 4,
        "large" => 5,
        "x-large" => 6,
        "xx-large" => 7,
        "xxx-large" | "-webkit-xxx-large" => 8,
        // FontDescription::LargerSize / SmallerSize of the parent, in float.
        "larger" => {
          return Ok(SpecifiedSize::Value {
            px: (PARENT_FONT_SIZE as f32 as f64 * 1.2) as f32 as f64,
            relative: true,
          });
        }
        "smaller" => {
          return Ok(SpecifiedSize::Value {
            px: (PARENT_FONT_SIZE as f32 as f64 / 1.2) as f32 as f64,
            relative: true,
          });
        }
        // MathScriptScaleFactor is 1 at math-depth 0.
        "math" => {
          return Ok(SpecifiedSize::Value {
            px: PARENT_FONT_SIZE,
            relative: true,
          });
        }
        _ => return Err(()),
      };
      Ok(SpecifiedSize::Keyword(keyword))
    }
    Token::Percentage { .. } if t.value >= 0.0 => Ok(SpecifiedSize::Value {
      px: t.value * PARENT_FONT_SIZE / 100.0,
      relative: true,
    }),
    Token::Number { .. } if t.value == 0.0 => Ok(SpecifiedSize::Value {
      px: 0.0,
      relative: false,
    }),
    Token::Dimension { ref unit, .. } if t.value >= 0.0 => {
      let (unit, factor) = LengthUnit::parse(unit).ok_or(())?;
      Ok(SpecifiedSize::Value {
        px: ctx.px(t.value * factor, unit),
        // Font-relative units other than rem follow the parent.
        relative: unit.is_font_relative() && unit != LengthUnit::Rem,
      })
    }
    _ => Err(()),
  }
}

/// ConsumeLineHeight: `normal`, a non-negative number or <length-percentage>.
/// The canvas drops it.
fn consume_line_height<'i>(p: &mut Parser<'i>) -> Result<(), ()> {
  if p
    .try_parse(|p| math::parse(p, Allowed::Number).ok_or(()))
    .is_ok()
    || p
      .try_parse(|p| math::parse(p, Allowed::LengthPercentage).ok_or(()))
      .is_ok()
  {
    return Ok(());
  }
  let t = token::next(p).map_err(|_| ())?;
  match t.token {
    Token::Ident(ref ident) if ident.eq_ignore_ascii_case("normal") => Ok(()),
    Token::Number { .. } | Token::Percentage { .. } if t.value >= 0.0 => Ok(()),
    Token::Dimension { ref unit, .. } if t.value >= 0.0 && LengthUnit::parse(unit).is_some() => {
      Ok(())
    }
    _ => Err(()),
  }
}

/// CSS-wide keywords and `default` cannot be a one-word family name.
fn is_reserved_family_word(word: &str) -> bool {
  [
    "initial",
    "inherit",
    "unset",
    "revert",
    "revert-layer",
    "default",
  ]
  .iter()
  .any(|k| word.eq_ignore_ascii_case(k))
}

/// ConsumeGenericFamily, then ConsumeFamilyName (a string, or identifiers
/// joined by one space).
fn consume_family<'i>(p: &mut Parser<'i>) -> Result<FamilyName, ()> {
  let state = p.state();
  match p.next().map_err(|_| ())?.clone() {
    Token::QuotedString(s) => Ok(FamilyName::Named(s.to_string())),
    Token::Ident(first) => {
      if let Some(generic) = GenericFamily::from_ident(&first) {
        return Ok(FamilyName::Generic(generic));
      }
      let mut name = first.to_string();
      let mut words = 1;
      loop {
        let state = p.state();
        match p.next() {
          Ok(Token::Ident(ident)) => {
            name.push(' ');
            name.push_str(ident);
            words += 1;
          }
          _ => {
            p.reset(&state);
            break;
          }
        }
      }
      if words == 1 && is_reserved_family_word(&first) {
        return Err(());
      }
      Ok(FamilyName::Named(name))
    }
    _ => {
      p.reset(&state);
      Err(())
    }
  }
}

/// The system font keywords and their values: Blink's LayoutTheme system
/// fonts measured in Chrome 155 (the same on macOS and Linux).
fn system_font(ident: &str) -> Option<ComputedFont> {
  let size = match ident.to_ascii_lowercase().as_str() {
    "caption" | "icon" | "menu" | "message-box" | "small-caption" | "status-bar" => 16.0,
    "-webkit-mini-control" | "-webkit-small-control" | "-webkit-control" => 40.0 / 3.0,
    _ => return None,
  };
  Some(ComputedFont {
    size,
    families: vec![FamilyName::Named("Arial".to_owned())],
    ..ComputedFont::default()
  })
}

/// font_size_functions.cc kStrictFontSizeTable rows for the default
/// proportional (16px) and fixed (13px) font sizes: a canvas without a
/// document uses standards mode.
const KEYWORD_SIZES: [f32; 8] = [9.0, 10.0, 13.0, 16.0, 18.0, 24.0, 32.0, 48.0];
const KEYWORD_SIZES_MONOSPACE: [f32; 8] = [9.0, 10.0, 12.0, 13.0, 16.0, 20.0, 26.0, 39.0];

/// Parse a canvas `font` value. None means the value is invalid and the
/// canvas keeps its font (CanvasFontCache::ParseFont).
pub(crate) fn parse_canvas_font(input: &str, ctx: &FontParseContext) -> Option<ComputedFont> {
  let mut p = Parser::new(input);
  // The math parser caps its own nesting (kMaxExpressionDepth).
  p.set_nested_block_limit(u8::MAX);
  let p = &mut p;
  let lctx = ctx.length_ctx();

  if let Ok(font) = p.try_parse(|p| next_ident(p).and_then(|i| system_font(&i)).ok_or(())) {
    return p.is_exhausted().then_some(font);
  }

  // Up to four of style, small-caps, weight and stretch, any may be `normal`.
  let mut style: Option<(f32, StyleKeyword)> = None;
  let mut small_caps = false;
  let mut weight: Option<f64> = None;
  let mut stretch: Option<FontStretch> = None;
  for _ in 0..4 {
    if p.is_exhausted() {
      break;
    }
    let state = p.state();
    let ident = next_ident(p);
    p.reset(&state);
    match ident.as_deref() {
      Some("normal") => {
        p.next().ok()?;
        continue;
      }
      Some("italic" | "oblique") if style.is_none() => {
        style = Some(consume_font_style(p, &lctx)?);
        continue;
      }
      Some("small-caps") if !small_caps => {
        p.next().ok()?;
        small_caps = true;
        continue;
      }
      _ => {}
    }
    if weight.is_none()
      && let Ok(w) = p.try_parse(|p| consume_font_weight(p, &lctx))
    {
      weight = Some(w);
      continue;
    }
    if stretch.is_some() {
      break;
    }
    match p.try_parse(consume_stretch_keyword) {
      Ok(s) => stretch = Some(s),
      Err(()) => break,
    }
  }
  if p.is_exhausted() {
    return None;
  }

  let size = p.try_parse(|p| consume_font_size(p, &lctx)).ok()?;
  if p.is_exhausted() {
    return None;
  }
  if p.try_parse(|p| p.expect_delim('/')).is_ok() {
    p.try_parse(consume_line_height).ok()?;
  }

  let mut families = vec![p.try_parse(consume_family).ok()?];
  while p.try_parse(|p| p.expect_comma()).is_ok() {
    families.push(p.try_parse(consume_family).ok()?);
  }
  if !p.is_exhausted() {
    return None;
  }
  if cfg!(target_os = "macos") {
    // StyleBuilderConverterBase::ConvertFontFamily on macOS.
    for family in &mut families {
      if matches!(family, FamilyName::Named(name) if name == "BlinkMacSystemFont") {
        *family = FamilyName::Named("system-ui".to_owned());
      }
    }
  }

  let is_monospace = families == [FamilyName::Generic(GenericFamily::Monospace)];
  let size = match size {
    SpecifiedSize::Keyword(k) => {
      if is_monospace {
        KEYWORD_SIZES_MONOSPACE[k - 1]
      } else {
        KEYWORD_SIZES[k - 1]
      }
    }
    SpecifiedSize::Value { px, relative } => {
      // FontBuilder::SetSize caps the size, then CheckForGenericFamilyChange
      // scales a relative size by the default fixed / proportional sizes.
      let px = if px.is_nan() { 0.0 } else { px };
      let size = (px as f32).min(MAX_FONT_SIZE);
      if relative && is_monospace {
        size * (13.0f32 / 16.0f32)
      } else {
        size
      }
    }
  };

  let (slope, style) = style.unwrap_or((0.0, StyleKeyword::Normal));
  Some(ComputedFont {
    slope,
    style,
    weight: font_selection_value(weight.unwrap_or(400.0).clamp(1.0, 1000.0)),
    stretch: stretch.unwrap_or(FontStretch::Normal),
    small_caps,
    size,
    families,
  })
}

/// IsCSSTokenizerIdentifier (css_markup.cc).
fn is_css_identifier(s: &str) -> bool {
  let mut chars = s.chars().peekable();
  if chars.peek() == Some(&'-') {
    chars.next();
  }
  let name_start = |c: char| c.is_ascii_alphabetic() || c == '_' || !c.is_ascii();
  match chars.next() {
    Some(c) if name_start(c) => {}
    _ => return false,
  }
  chars.all(|c| name_start(c) || c.is_ascii_digit() || c == '-')
}

/// SerializeFontFamily: quoted when the name is a CSS-wide keyword,
/// `default`, a generic family name, or not one identifier.
fn serialize_family_name(name: &str, out: &mut String) {
  let lower = name.to_ascii_lowercase();
  let generic = matches!(
    lower.as_str(),
    "cursive" | "fantasy" | "monospace" | "sans-serif" | "serif" | "system-ui" | "math"
  );
  if !(is_reserved_family_word(name) || generic || !is_css_identifier(name)) {
    out.push_str(name);
    return;
  }
  // SerializeString.
  out.push('"');
  for c in name.chars() {
    match c {
      '\u{0}'..='\u{1f}' | '\u{7f}' => {
        out.push_str(&format!("\\{:x} ", c as u32));
      }
      '"' | '\\' => {
        out.push('\\');
        out.push(c);
      }
      _ => out.push(c),
    }
  }
  out.push('"');
}

/// BaseRenderingContext2D::font(): `italic` for the italic slope, the weight
/// unless normal, `small-caps` for the small-caps state, the size and the
/// family list.
pub(crate) fn serialize_canvas_font(font: &ComputedFont, small_caps: bool) -> String {
  let mut out = String::new();
  if font.slope == ITALIC_SLOPE {
    out.push_str("italic ");
  }
  if font.weight == 700.0 {
    out.push_str("bold ");
  } else if font.weight != 400.0 {
    out.push_str(&(font.weight as i32).to_string());
    out.push(' ');
  }
  if small_caps {
    out.push_str("small-caps ");
  }
  out.push_str(&crate::webidl::number_to_string(font.size as f64));
  out.push_str("px ");
  for (i, family) in font.families.iter().enumerate() {
    if i > 0 {
      out.push_str(", ");
    }
    match family {
      FamilyName::Generic(g) => out.push_str(g.as_str()),
      FamilyName::Named(name) => serialize_family_name(name, &mut out),
    }
  }
  out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontStyle {
  Normal,
  Italic,
  Oblique,
}

impl FontStyle {
  pub fn as_str(&self) -> &str {
    match *self {
      Self::Italic => "italic",
      Self::Normal => "normal",
      Self::Oblique => "oblique",
    }
  }
}

#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontStretch {
  UltraCondensed = 1,
  ExtraCondensed = 2,
  Condensed = 3,
  SemiCondensed = 4,
  Normal = 5,
  SemiExpanded = 6,
  Expanded = 7,
  ExtraExpanded = 8,
  UltraExpanded = 9,
}

impl From<i32> for FontStretch {
  fn from(value: i32) -> Self {
    match value {
      1 => FontStretch::UltraCondensed,
      2 => FontStretch::ExtraCondensed,
      3 => FontStretch::Condensed,
      4 => FontStretch::SemiCondensed,
      5 => FontStretch::Normal,
      6 => FontStretch::SemiExpanded,
      7 => FontStretch::Expanded,
      8 => FontStretch::ExtraExpanded,
      9 => FontStretch::UltraExpanded,
      _ => unreachable!(),
    }
  }
}

impl FontStretch {
  pub fn as_str(&self) -> &str {
    match *self {
      FontStretch::UltraCondensed => "ultra-condensed",
      FontStretch::ExtraCondensed => "extra-condensed",
      FontStretch::Condensed => "condensed",
      FontStretch::SemiCondensed => "semi-condensed",
      FontStretch::Normal => "normal",
      FontStretch::SemiExpanded => "semi-expanded",
      FontStretch::Expanded => "expanded",
      FontStretch::ExtraExpanded => "extra-expanded",
      FontStretch::UltraExpanded => "ultra-expanded",
    }
  }

  /// Returns the width percentage for variable font 'wdth' axis
  /// Based on CSS font-stretch percentages
  pub fn to_width_percentage(self) -> f32 {
    match self {
      FontStretch::UltraCondensed => 50.0,
      FontStretch::ExtraCondensed => 62.5,
      FontStretch::Condensed => 75.0,
      FontStretch::SemiCondensed => 87.5,
      FontStretch::Normal => 100.0,
      FontStretch::SemiExpanded => 112.5,
      FontStretch::Expanded => 125.0,
      FontStretch::ExtraExpanded => 150.0,
      FontStretch::UltraExpanded => 200.0,
    }
  }
}

/// The `fontStretch` keywords (the CanvasFontStretch enum compares exactly;
/// the shorthand lowercases its identifier first).
pub fn parse_font_stretch(stretch: &str) -> Option<FontStretch> {
  match stretch {
    "ultra-condensed" => Some(FontStretch::UltraCondensed),
    "extra-condensed" => Some(FontStretch::ExtraCondensed),
    "condensed" => Some(FontStretch::Condensed),
    "semi-condensed" => Some(FontStretch::SemiCondensed),
    "normal" => Some(FontStretch::Normal),
    "semi-expanded" => Some(FontStretch::SemiExpanded),
    "expanded" => Some(FontStretch::Expanded),
    "extra-expanded" => Some(FontStretch::ExtraExpanded),
    "ultra-expanded" => Some(FontStretch::UltraExpanded),
    _ => None,
  }
}

/// A CSS length for letterSpacing / wordSpacing: em and % against the
/// default 16px.
pub fn parse_size_px(size: f32, unit: &str) -> f32 {
  let mut size_px = size;
  match unit {
    "em" | "rem" | "pc" => {
      size_px = size * FONT_MEDIUM_PX;
    }
    "pt" => {
      size_px = size * 4.0 / 3.0;
    }
    "px" => {
      size_px = size;
    }
    "in" => {
      size_px = size * 96.0;
    }
    "cm" => {
      size_px = size * 96.0 / 2.54;
    }
    "mm" => {
      size_px = size * 96.0 / 25.4;
    }
    "q" => {
      size_px = size * 96.0 / 25.4 / 4.0;
    }
    "%" => {
      size_px = size * FONT_MEDIUM_PX / 100.0;
    }
    _ => {}
  };
  size_px
}

#[cfg(test)]
mod tests {
  use super::*;

  fn parse(input: &str) -> Option<ComputedFont> {
    parse_canvas_font(input, &FontParseContext::default())
  }

  fn getter(input: &str) -> Option<String> {
    parse(input).map(|f| serialize_canvas_font(&f, f.small_caps))
  }

  #[test]
  fn font_stretch() {
    assert_eq!(
      parse_font_stretch("ultra-condensed"),
      Some(FontStretch::UltraCondensed)
    );
    assert_eq!(parse_font_stretch("CONDENSED"), None);
    assert_eq!(parse_font_stretch("50%"), None);
    assert_eq!(parse_font_stretch("ultra"), None);
  }

  #[allow(clippy::float_cmp)]
  #[test]
  fn test_parse_size_px() {
    assert_eq!(parse_size_px(12.0, "px"), 12.0f32);
    assert_eq!(parse_size_px(2.0, "em"), 32.0f32);
  }

  #[test]
  fn parses_the_shorthand_like_blink() {
    // A size without a family is invalid (was sans-serif).
    assert_eq!(parse("50px"), None);
    // A percentage stretch is not a shorthand stretch.
    assert_eq!(parse("62.5% 50% Arial"), None);
    let f = parse("bold italic 50px Arial, sans-serif").unwrap();
    assert_eq!(f.weight, 700.0);
    assert_eq!(f.slope, 14.0);
    assert_eq!(f.size, 50.0);
    assert_eq!(
      f.families,
      vec![
        FamilyName::Named("Arial".to_owned()),
        FamilyName::Generic(GenericFamily::SansSerif)
      ]
    );
    let f = parse("condensed 550 12px/2 \"Fira  Sans\"").unwrap();
    assert_eq!(f.stretch, FontStretch::Condensed);
    assert_eq!(f.weight, 550.0);
    assert_eq!(f.families, vec![FamilyName::Named("Fira  Sans".to_owned())]);
  }

  #[test]
  fn getter_matches_chrome() {
    // Chrome 155 (stack-impl/10-text-fonts/out/p1*-mac.json).
    for (input, expected) in [
      ("700 12px serif", Some("bold 12px serif")),
      ("550 12px serif", Some("550 12px serif")),
      ("100.7 12px serif", Some("100 12px serif")),
      ("calc(0) 12px serif", Some("1 12px serif")),
      ("0 12px serif", None),
      ("oblique 10deg 12px serif", Some("12px serif")),
      ("oblique 91deg 12px serif", None),
      ("oblique 1turn 12px serif", Some("12px serif")),
      ("oblique 14 12px serif", Some("italic 14 12px serif")),
      (
        "italic small-caps 900 12px serif",
        Some("italic 900 small-caps 12px serif"),
      ),
      ("12pt serif", Some("16px serif")),
      ("1cm serif", Some("37.7953px serif")),
      ("smaller serif", Some("8.33333px serif")),
      ("x-small monospace", Some("10px monospace")),
      ("1em monospace", Some("8.125px monospace")),
      ("calc(50%) monospace", Some("4.0625px monospace")),
      ("calc(1em) monospace", Some("10px monospace")),
      ("1000em monospace", Some("8125px monospace")),
      ("0.00000001px serif", Some("1.00000e-8px serif")),
      ("12px Lato   T", Some("12px \"Lato T\"")),
      ("12px \"serif\"", Some("12px \"serif\"")),
      ("12px a\\ b", Some("12px \"a b\"")),
      ("12px --a", Some("12px \"--a\"")),
      ("12px \"a\u{1}b\"", Some("12px \"a\\1 b\"")),
      ("12px a\u{0}b", Some("12px a\u{fffd}b")),
      ("12px inherit", None),
      ("12px serif foo", None),
      ("caption", Some("16px Arial")),
      ("-webkit-control", Some("13.3333px Arial")),
      ("caption serif", None),
      (
        "bold 12px/30px Georgia, serif",
        Some("bold 12px Georgia, serif"),
      ),
      ("12px/-1 serif", None),
      ("1vw serif", Some("0px serif")),
    ] {
      assert_eq!(getter(input).as_deref(), expected, "{input}");
    }
  }
}
