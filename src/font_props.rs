//! Six CSS font properties on the 2D context, as Chrome 157 parses and
//! computes them for an element (Chrome's canvas has none of them):
//! `font-feature-settings`, `font-variant-ligatures`, `font-variant-numeric`,
//! `font-variant-position`, `font-size-adjust` and `font-optical-sizing`.
//!
//! Each type parses a setter value with the CSS tokenizer and serializes to
//! Chrome's getComputedStyle form, which is what the getter returns. A value
//! that does not parse is ignored by the setter, and so are the CSS-wide
//! keywords, var() and an empty value ([`reject_canvas_keyword`]), as
//! Chrome's canvas string setters (font, letterSpacing, filter) do.

use std::collections::BTreeMap;

use cssparser::{Parser, Token};

use crate::css_math::{self, Category, Lengths, MathOptions};

/// CSS whitespace (css-syntax: space, tab, LF, CR, FF). NBSP and U+3000 are
/// not whitespace: they are ident code points.
fn is_css_whitespace(c: char) -> bool {
  matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0C')
}

/// Whether the canvas setter ignores `value` before parsing it: empty or
/// CSS-whitespace only, a CSS-wide keyword alone (ASCII case-insensitive,
/// comments and escapes resolved), or a value with a var() function anywhere.
pub fn reject_canvas_keyword(value: &str) -> bool {
  if value.chars().all(is_css_whitespace) {
    return true;
  }
  let mut p = Parser::new(value);
  // A single ident token.
  let state = p.state();
  if let Ok(Token::Ident(ident)) = p.next() {
    let ident = ident.clone();
    if p.is_exhausted()
      && ["inherit", "initial", "unset", "revert", "revert-layer"]
        .iter()
        .any(|k| ident.eq_ignore_ascii_case(k))
    {
      return true;
    }
  }
  p.reset(&state);
  has_var(&mut p)
}

/// Whether the rest of `p`, nested blocks included, has a var() function.
fn has_var(p: &mut Parser<'_>) -> bool {
  loop {
    let nested = match p.next_including_whitespace_and_comments() {
      Err(_) => return false,
      Ok(Token::Function(name)) => {
        if name.eq_ignore_ascii_case("var") {
          return true;
        }
        true
      }
      Ok(Token::ParenthesisBlock | Token::SquareBracketBlock | Token::CurlyBracketBlock) => true,
      Ok(_) => false,
    };
    if nested {
      let found = p
        .parse_nested_block(|q| -> Result<bool, cssparser::ParseError<()>> { Ok(has_var(q)) })
        .unwrap_or(false);
      if found {
        return true;
      }
    }
  }
}

/// C `printf("%.6g", v)`, the form Chrome's computed CSS numbers take
/// (`1e+06`, `1.23457e+06`, `1e-05`, `0.333333`). Ties round to even on the
/// exact binary value, as C and Chrome do. Infinity and NaN are the caller's.
pub fn css_g6(v: f64) -> String {
  if !v.is_finite() {
    return if v.is_nan() {
      "nan".to_owned()
    } else if v > 0.0 {
      "inf".to_owned()
    } else {
      "-inf".to_owned()
    };
  }
  if v == 0.0 {
    return if v.is_sign_negative() { "-0" } else { "0" }.to_owned();
  }
  // The exponent of the value rounded to 6 significant digits.
  let sci = format!("{v:.5e}");
  let (mantissa, exp) = sci.split_once('e').expect("exponent");
  let exp: i32 = exp.parse().expect("exponent");
  fn strip(s: &str) -> &str {
    if s.contains('.') {
      s.trim_end_matches('0').trim_end_matches('.')
    } else {
      s
    }
  }
  if !(-4..6).contains(&exp) {
    let sign = if exp < 0 { '-' } else { '+' };
    format!("{}e{sign}{:02}", strip(mantissa), exp.abs())
  } else {
    let fixed = format!("{v:.prec$}", prec = (5 - exp) as usize);
    strip(&fixed).to_owned()
  }
}

/// A math function (calc(), min(), round(), ...) whose result is a plain
/// number, computed; NaN stays NaN. None when the next token is not one.
fn consume_math_number(p: &mut Parser<'_>) -> Option<f64> {
  p.try_parse(|p| -> Result<f64, ()> {
    let (token, _) = css_math::next_token(p).ok_or(())?;
    let Token::Function(name) = token else {
      return Err(());
    };
    if !css_math::is_math_function(&name) {
      return Err(());
    }
    let options = MathOptions {
      allow_percent: false,
      channels: &[],
    };
    let node = p
      .parse_nested_block(|q| {
        css_math::parse_math_function(q, &name, options).ok_or_else(css_math::custom_error)
      })
      .map_err(|_| ())?;
    if node.category() != Category::Number {
      return Err(());
    }
    Ok(node.compute_double(&Lengths::default()))
  })
  .ok()
}

/// The next ident, or None (the parser does not move then).
fn try_ident(p: &mut Parser<'_>) -> Option<String> {
  p.try_parse(|p| match p.next() {
    Ok(Token::Ident(ident)) => Ok(ident.to_string()),
    _ => Err(()),
  })
  .ok()
}

/// A whole value of one keyword out of `keywords` (ASCII case-insensitive).
fn parse_single_keyword(value: &str, keywords: &[&str]) -> Option<usize> {
  let mut p = Parser::new(value);
  let ident = try_ident(&mut p)?;
  if !p.is_exhausted() {
    return None;
  }
  keywords.iter().position(|k| ident.eq_ignore_ascii_case(k))
}

// ---------------------------------------------------------------------------
// font-feature-settings

/// One computed feature: the tag as a big-endian u32 and its value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FontFeature {
  pub tag: u32,
  pub value: i32,
}

/// The computed font-feature-settings: deduped by tag (last wins) and sorted
/// by tag (StyleBuilderConverterBase::ConvertFontFeatureSettings). Empty is
/// `normal`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FontFeatureSettings(pub Vec<FontFeature>);

impl FontFeatureSettings {
  /// ConsumeFontSettings (css_parsing_utils.cc:6669-6741):
  /// `normal | <string> [ <integer> | on | off ]? #`.
  pub fn parse(value: &str) -> Option<Self> {
    if reject_canvas_keyword(value) {
      return None;
    }
    let mut p = Parser::new(value);
    if let Some(ident) = try_ident(&mut p) {
      return (ident.eq_ignore_ascii_case("normal") && p.is_exhausted()).then(Self::default);
    }
    // Keyed by tag: an insert replaces the earlier item of a tag (the last
    // wins), and iteration is in tag order. O(n log n) for n items.
    let mut features: BTreeMap<u32, i32> = BTreeMap::new();
    loop {
      let tag = match p.next() {
        Ok(Token::QuotedString(s)) => tag_from_str(s)?,
        _ => return None,
      };
      let value = feature_value(&mut p)?;
      features.insert(tag, value);
      if p.is_exhausted() {
        break;
      }
      match p.next() {
        Ok(Token::Comma) => {}
        _ => return None,
      }
    }
    Some(Self(
      features
        .into_iter()
        .map(|(tag, value)| FontFeature { tag, value })
        .collect(),
    ))
  }

  pub fn serialize(&self) -> String {
    if self.0.is_empty() {
      return "normal".to_owned();
    }
    self
      .0
      .iter()
      .map(|f| {
        let mut s = String::with_capacity(10);
        s.push('"');
        for b in f.tag.to_be_bytes() {
          if b == b'"' || b == b'\\' {
            s.push('\\');
          }
          s.push(b as char);
        }
        s.push('"');
        if f.value != 1 {
          s.push(' ');
          s.push_str(&css_g6(f64::from(f.value)));
        }
        s
      })
      .collect::<Vec<_>>()
      .join(", ")
  }
}

/// A tag string: exactly 4 characters, each U+0020..U+007E.
fn tag_from_str(s: &str) -> Option<u32> {
  let bytes = s.as_bytes();
  if bytes.len() != 4 || !bytes.iter().all(|b| (0x20..=0x7e).contains(b)) {
    return None;
  }
  Some(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

/// The optional value after a tag: an integer token, `on`, `off`, or a math
/// function resolving to a number (rounded half toward +inf, then clamped to
/// int32; NaN is 0). Missing is 1.
fn feature_value(p: &mut Parser<'_>) -> Option<i32> {
  if p.is_exhausted() {
    return Some(1);
  }
  if let Some(ident) = try_ident(p) {
    return if ident.eq_ignore_ascii_case("on") {
      Some(1)
    } else if ident.eq_ignore_ascii_case("off") {
      Some(0)
    } else {
      None
    };
  }
  if let Some(v) = consume_math_number(p) {
    return Some(round_to_int(v));
  }
  let state = p.state();
  match p.next() {
    // cssparser's int_value saturates to int32, as Blink's ClampTo<int>.
    Ok(Token::Number {
      int_value: Some(i), ..
    }) => Some(*i),
    Ok(Token::Comma) => {
      p.reset(&state);
      Some(1)
    }
    _ => None,
  }
}

/// ClampTo<int>(floor(x + 0.5)), NaN -> 0.
fn round_to_int(v: f64) -> i32 {
  if v.is_nan() {
    return 0;
  }
  let r = (v + 0.5).floor();
  if r >= f64::from(i32::MAX) {
    i32::MAX
  } else if r <= f64::from(i32::MIN) {
    i32::MIN
  } else {
    r as i32
  }
}

// ---------------------------------------------------------------------------
// font-variant-ligatures

#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LigatureState {
  #[default]
  Normal = 0,
  Enabled = 1,
  Disabled = 2,
}

/// The four ligature groups (FontDescription::VariantLigatures).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FontVariantLigatures {
  pub common: LigatureState,
  pub discretionary: LigatureState,
  pub historical: LigatureState,
  pub contextual: LigatureState,
}

/// The keywords of each group, in serialization order: (enabled, disabled).
const LIGATURE_GROUPS: [(&str, &str); 4] = [
  ("common-ligatures", "no-common-ligatures"),
  ("discretionary-ligatures", "no-discretionary-ligatures"),
  ("historical-ligatures", "no-historical-ligatures"),
  ("contextual", "no-contextual"),
];

impl FontVariantLigatures {
  pub const NONE: Self = Self {
    common: LigatureState::Disabled,
    discretionary: LigatureState::Disabled,
    historical: LigatureState::Disabled,
    contextual: LigatureState::Disabled,
  };

  fn groups(&self) -> [LigatureState; 4] {
    [
      self.common,
      self.discretionary,
      self.historical,
      self.contextual,
    ]
  }

  /// FontVariantLigaturesParser: `normal | none | <group> || ...`, each group
  /// at most once.
  pub fn parse(value: &str) -> Option<Self> {
    if reject_canvas_keyword(value) {
      return None;
    }
    let mut p = Parser::new(value);
    let mut groups = [LigatureState::Normal; 4];
    let mut seen = [false; 4];
    let mut first = true;
    while !p.is_exhausted() {
      let ident = try_ident(&mut p)?;
      if first && p.is_exhausted() {
        if ident.eq_ignore_ascii_case("normal") {
          return Some(Self::default());
        }
        if ident.eq_ignore_ascii_case("none") {
          return Some(Self::NONE);
        }
      }
      first = false;
      let (i, state) = LIGATURE_GROUPS
        .iter()
        .enumerate()
        .find_map(|(i, (on, off))| {
          if ident.eq_ignore_ascii_case(on) {
            Some((i, LigatureState::Enabled))
          } else if ident.eq_ignore_ascii_case(off) {
            Some((i, LigatureState::Disabled))
          } else {
            None
          }
        })?;
      if seen[i] {
        return None;
      }
      seen[i] = true;
      groups[i] = state;
    }
    if first {
      return None;
    }
    Some(Self {
      common: groups[0],
      discretionary: groups[1],
      historical: groups[2],
      contextual: groups[3],
    })
  }

  /// ValueForFontVariantLigatures.
  pub fn serialize(&self) -> String {
    let groups = self.groups();
    if groups.iter().all(|g| *g == LigatureState::Normal) {
      return "normal".to_owned();
    }
    if groups.iter().all(|g| *g == LigatureState::Disabled) {
      return "none".to_owned();
    }
    groups
      .iter()
      .zip(LIGATURE_GROUPS)
      .filter_map(|(g, (on, off))| match g {
        LigatureState::Normal => None,
        LigatureState::Enabled => Some(on),
        LigatureState::Disabled => Some(off),
      })
      .collect::<Vec<_>>()
      .join(" ")
  }
}

// ---------------------------------------------------------------------------
// font-variant-numeric

/// font-variant-numeric. `figure`: 0 normal, 1 lining-nums, 2 oldstyle-nums;
/// `spacing`: 0, 1 proportional-nums, 2 tabular-nums; `fraction`: 0,
/// 1 diagonal-fractions, 2 stacked-fractions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FontVariantNumeric {
  pub figure: u8,
  pub spacing: u8,
  pub fraction: u8,
  pub ordinal: bool,
  pub slashed_zero: bool,
}

/// Per group, in serialization order, the keyword of each non-zero value.
const NUMERIC_GROUPS: [&[&str]; 5] = [
  &["lining-nums", "oldstyle-nums"],
  &["proportional-nums", "tabular-nums"],
  &["diagonal-fractions", "stacked-fractions"],
  &["ordinal"],
  &["slashed-zero"],
];

impl FontVariantNumeric {
  fn groups(&self) -> [u8; 5] {
    [
      self.figure,
      self.spacing,
      self.fraction,
      u8::from(self.ordinal),
      u8::from(self.slashed_zero),
    ]
  }

  /// FontVariantNumericParser: `normal | <figure> || <spacing> ||
  /// <fraction> || ordinal || slashed-zero`, each group at most once.
  pub fn parse(value: &str) -> Option<Self> {
    if reject_canvas_keyword(value) {
      return None;
    }
    let mut p = Parser::new(value);
    let mut groups = [0u8; 5];
    let mut first = true;
    while !p.is_exhausted() {
      let ident = try_ident(&mut p)?;
      if first && p.is_exhausted() && ident.eq_ignore_ascii_case("normal") {
        return Some(Self::default());
      }
      first = false;
      let (group, value) = NUMERIC_GROUPS
        .iter()
        .enumerate()
        .find_map(|(g, keywords)| {
          keywords
            .iter()
            .position(|k| ident.eq_ignore_ascii_case(k))
            .map(|i| (g, i as u8 + 1))
        })?;
      if groups[group] != 0 {
        return None;
      }
      groups[group] = value;
    }
    if first {
      return None;
    }
    Some(Self {
      figure: groups[0],
      spacing: groups[1],
      fraction: groups[2],
      ordinal: groups[3] != 0,
      slashed_zero: groups[4] != 0,
    })
  }

  pub fn serialize(&self) -> String {
    let parts: Vec<&str> = self
      .groups()
      .iter()
      .zip(NUMERIC_GROUPS)
      .filter(|(v, _)| **v != 0)
      .map(|(v, keywords)| keywords[usize::from(*v) - 1])
      .collect();
    if parts.is_empty() {
      "normal".to_owned()
    } else {
      parts.join(" ")
    }
  }
}

// ---------------------------------------------------------------------------
// font-variant-position

#[repr(i32)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FontVariantPosition {
  #[default]
  Normal = 0,
  Sub = 1,
  Super = 2,
}

impl FontVariantPosition {
  const KEYWORDS: [&'static str; 3] = ["normal", "sub", "super"];

  /// `normal | sub | super`.
  pub fn parse(value: &str) -> Option<Self> {
    if reject_canvas_keyword(value) {
      return None;
    }
    Some(match parse_single_keyword(value, &Self::KEYWORDS)? {
      0 => Self::Normal,
      1 => Self::Sub,
      _ => Self::Super,
    })
  }

  pub fn serialize(&self) -> String {
    Self::KEYWORDS[*self as usize].to_owned()
  }
}

// ---------------------------------------------------------------------------
// font-optical-sizing

#[repr(i32)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FontOpticalSizing {
  #[default]
  Auto = 0,
  None = 1,
}

impl FontOpticalSizing {
  const KEYWORDS: [&'static str; 2] = ["auto", "none"];

  /// `auto | none`.
  pub fn parse(value: &str) -> Option<Self> {
    if reject_canvas_keyword(value) {
      return None;
    }
    Some(match parse_single_keyword(value, &Self::KEYWORDS)? {
      0 => Self::Auto,
      _ => Self::None,
    })
  }

  pub fn serialize(&self) -> String {
    Self::KEYWORDS[*self as usize].to_owned()
  }
}

// ---------------------------------------------------------------------------
// font-size-adjust

#[repr(i32)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SizeAdjustMetric {
  #[default]
  ExHeight = 0,
  CapHeight = 1,
  ChWidth = 2,
  IcWidth = 3,
  IcHeight = 4,
}

impl SizeAdjustMetric {
  const KEYWORDS: [&'static str; 5] = [
    "ex-height",
    "cap-height",
    "ch-width",
    "ic-width",
    "ic-height",
  ];

  fn from_ident(ident: &str) -> Option<Self> {
    Some(
      match Self::KEYWORDS
        .iter()
        .position(|k| ident.eq_ignore_ascii_case(k))?
      {
        0 => Self::ExHeight,
        1 => Self::CapHeight,
        2 => Self::ChWidth,
        3 => Self::IcWidth,
        _ => Self::IcHeight,
      },
    )
  }

  /// The serialization prefix: ex-height, the default, is dropped.
  fn prefix(self) -> &'static str {
    match self {
      Self::ExHeight => "",
      other => Self::KEYWORDS[other as usize],
    }
  }
}

/// The computed font-size-adjust. `Number` holds the f32 Chrome stores
/// (>= 0, may be +infinity from calc()). `FromFont` stays unresolved: it is
/// resolved against the current font at each layout (DESIGN D6).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum FontSizeAdjust {
  #[default]
  None,
  Number(SizeAdjustMetric, f32),
  FromFont(SizeAdjustMetric),
}

impl FontSizeAdjust {
  /// ConsumeFontSizeAdjust: `none | <metric>? [ <number [0,inf]> | from-font ]`.
  /// A literal negative is invalid; a calc() is clamped to >= 0 at compute.
  pub fn parse(value: &str) -> Option<Self> {
    if reject_canvas_keyword(value) {
      return None;
    }
    let mut p = Parser::new(value);
    let mut metric = None;
    if let Some(ident) = try_ident(&mut p) {
      if ident.eq_ignore_ascii_case("none") {
        return p.is_exhausted().then_some(Self::None);
      }
      if ident.eq_ignore_ascii_case("from-font") {
        return p
          .is_exhausted()
          .then_some(Self::FromFont(SizeAdjustMetric::ExHeight));
      }
      metric = Some(SizeAdjustMetric::from_ident(&ident)?);
    }
    let metric = metric.unwrap_or_default();
    let result = if let Some(ident) = try_ident(&mut p) {
      if !ident.eq_ignore_ascii_case("from-font") {
        return None;
      }
      Self::FromFont(metric)
    } else if let Some(v) = consume_math_number(&mut p) {
      Self::Number(metric, compute_calc_size_adjust(v))
    } else {
      let (token, source) = css_math::next_token(&mut p)?;
      if !matches!(token, Token::Number { .. }) {
        return None;
      }
      let v = css_math::token_number(source);
      if v < 0.0 {
        return None;
      }
      // Blink's ClampTo<float>; a literal never reaches infinity. -0 is 0.
      let v = if v == 0.0 { 0.0 } else { v };
      Self::Number(metric, v.min(f64::from(f32::MAX)) as f32)
    };
    p.is_exhausted().then_some(result)
  }

  pub fn serialize(&self) -> String {
    let (metric, value) = match self {
      Self::None => return "none".to_owned(),
      Self::FromFont(metric) => (*metric, "from-font".to_owned()),
      Self::Number(metric, v) => (
        *metric,
        if v.is_infinite() {
          "infinity".to_owned()
        } else {
          css_g6(f64::from(*v))
        },
      ),
    };
    let prefix = metric.prefix();
    if prefix.is_empty() {
      value
    } else {
      format!("{prefix} {value}")
    }
  }
}

/// A calc() number clamped to [0, inf] (NaN -> 0), stored as f32: finite
/// values clamp to f32::MAX, +infinity stays.
fn compute_calc_size_adjust(v: f64) -> f32 {
  if v.is_nan() || v <= 0.0 {
    return 0.0;
  }
  if v.is_infinite() {
    return f32::INFINITY;
  }
  v.min(f64::from(f32::MAX)) as f32
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ffs(v: &str) -> Option<String> {
    FontFeatureSettings::parse(v).map(|s| s.serialize())
  }
  fn fvl(v: &str) -> Option<String> {
    FontVariantLigatures::parse(v).map(|s| s.serialize())
  }
  fn fvn(v: &str) -> Option<String> {
    FontVariantNumeric::parse(v).map(|s| s.serialize())
  }
  fn fvp(v: &str) -> Option<String> {
    FontVariantPosition::parse(v).map(|s| s.serialize())
  }
  fn fsa(v: &str) -> Option<String> {
    FontSizeAdjust::parse(v).map(|s| s.serialize())
  }
  fn fos(v: &str) -> Option<String> {
    FontOpticalSizing::parse(v).map(|s| s.serialize())
  }

  fn check(f: fn(&str) -> Option<String>, rows: &[(&str, Option<&str>)]) {
    for (input, expected) in rows {
      assert_eq!(f(input).as_deref(), *expected, "input {input:?}");
    }
  }

  #[test]
  fn g6() {
    let rows: &[(f64, &str)] = &[
      (0.0, "0"),
      (1.0, "1"),
      (0.5, "0.5"),
      (999999.0, "999999"),
      (1000000.0, "1e+06"),
      (1234567.0, "1.23457e+06"),
      (1234565.0, "1.23456e+06"),
      (1234575.0, "1.23458e+06"),
      (12345678.0, "1.23457e+07"),
      (100000.0, "100000"),
      (-999999.0, "-999999"),
      (-1000000.0, "-1e+06"),
      (2147483647.0, "2.14748e+09"),
      (-2147483648.0, "-2.14748e+09"),
      (999999.5, "1e+06"),
      (0.00001, "1e-05"),
      (0.0001234, "0.0001234"),
      (0.001, "0.001"),
      (123456.0, "123456"),
      (1e20, "1e+20"),
      (1.0 / 3.0, "0.333333"),
      (f64::from(f32::MAX), "3.40282e+38"),
      (f64::from(0.2000001f32), "0.2"),
      (f64::from(0.1234565f32), "0.123457"),
      (f64::from(0.1f32), "0.1"),
      (f64::from(1e-7f32), "1e-07"),
      (1e100, "1e+100"),
    ];
    for (v, s) in rows {
      assert_eq!(css_g6(*v), *s, "{v}");
    }
  }

  #[test]
  fn canvas_keywords() {
    for v in [
      "",
      " ",
      "\t\n\r\x0C",
      "inherit",
      "INHERIT",
      " initial ",
      "/**/unset",
      "revert",
      "revert-layer",
      "\\69nherit",
      "var(--x)",
      "VAR(--x)",
      "\"liga\" var(--x)",
      "calc(var(--x))",
    ] {
      assert!(reject_canvas_keyword(v), "{v:?}");
    }
    for v in [
      "normal",
      "inherit inherit",
      "\u{a0}",
      "\"inherit\"",
      "variable",
    ] {
      assert!(!reject_canvas_keyword(v), "{v:?}");
    }
  }

  #[test]
  fn font_feature_settings() {
    check(
      ffs,
      &[
        ("normal", Some("normal")),
        ("NORMAL", Some("normal")),
        (" normal ", Some("normal")),
        ("'liga'", Some("\"liga\"")),
        ("\"liga\" 1", Some("\"liga\"")),
        ("\"liga\" on", Some("\"liga\"")),
        ("\"liga\" ON", Some("\"liga\"")),
        ("\"liga\" off", Some("\"liga\" 0")),
        ("\"liga\" Off", Some("\"liga\" 0")),
        ("\"liga\" -0", Some("\"liga\" 0")),
        ("\"liga\" 2", Some("\"liga\" 2")),
        ("\"liga\" -1", Some("\"liga\" -1")),
        ("\"liga\" +3", Some("\"liga\" 3")),
        ("\"liga\" +0", Some("\"liga\" 0")),
        ("\"liga\" 00", Some("\"liga\" 0")),
        ("\"liga\" 0001", Some("\"liga\"")),
        ("\"liga\",\"kern\"", Some("\"kern\", \"liga\"")),
        ("\"liga\" 0, \"liga\" 1", Some("\"liga\"")),
        ("\"liga\" 1, \"liga\" 0", Some("\"liga\" 0")),
        (
          "\"kern\", \"liga\" 0, \"dlig\"",
          Some("\"dlig\", \"kern\", \"liga\" 0"),
        ),
        (
          "\"zero\",\"LIGA\",\"liga\",\"Liga\",\"aaaa\",\"ZZZZ\",\"1abc\",\"~abc\",\" abc\"",
          Some(
            "\" abc\", \"1abc\", \"LIGA\", \"Liga\", \"ZZZZ\", \"aaaa\", \"liga\", \"zero\", \"~abc\"",
          ),
        ),
        ("\"a\\\"bc\"", Some("\"a\\\"bc\"")),
        ("'a\\'bc'", Some("\"a'bc\"")),
        ("\"\\61 bcd\"", Some("\"abcd\"")),
        ("\"ab\\\\c\"", Some("\"ab\\\\c\"")),
        ("\"liga\"  ,  \"dlig\"  2", Some("\"dlig\" 2, \"liga\"")),
        ("\"liga\" /* c */ 0", Some("\"liga\" 0")),
        ("\"liga\"0", Some("\"liga\" 0")),
        ("\"liga\"on", Some("\"liga\"")),
        ("\"liga\"\n1", Some("\"liga\"")),
        ("\"liga", Some("\"liga\"")),
        ("\"li g\"", Some("\"li g\"")),
        ("\"    \"", Some("\"    \"")),
        ("\"~~~~\"", Some("\"~~~~\"")),
        ("\"liga\" 999999", Some("\"liga\" 999999")),
        ("\"liga\" 1000000", Some("\"liga\" 1e+06")),
        ("\"liga\" 1234567", Some("\"liga\" 1.23457e+06")),
        ("\"liga\" 2147483647", Some("\"liga\" 2.14748e+09")),
        ("\"liga\" 2147483648", Some("\"liga\" 2.14748e+09")),
        ("\"liga\" 99999999999", Some("\"liga\" 2.14748e+09")),
        ("\"liga\" calc(infinity)", Some("\"liga\" 2.14748e+09")),
        ("\"liga\" calc(1/0)", Some("\"liga\" 2.14748e+09")),
        ("\"liga\" -2147483649", Some("\"liga\" -2.14748e+09")),
        ("\"liga\" calc(-infinity)", Some("\"liga\" -2.14748e+09")),
        ("\"liga\" -1000000", Some("\"liga\" -1e+06")),
        ("\"liga\" calc(NaN)", Some("\"liga\" 0")),
        ("\"liga\" calc(0.5)", Some("\"liga\"")),
        ("\"liga\" calc(1.4999)", Some("\"liga\"")),
        ("\"liga\" calc(1.5)", Some("\"liga\" 2")),
        ("\"liga\" calc(2.5)", Some("\"liga\" 3")),
        ("\"liga\" calc(-0.5)", Some("\"liga\" 0")),
        ("\"liga\" calc(-1.5)", Some("\"liga\" -1")),
        ("\"liga\" calc(-2.5)", Some("\"liga\" -2")),
        ("\"liga\" calc(1 + 1)", Some("\"liga\" 2")),
        ("\"liga\" min(3, 2)", Some("\"liga\" 2")),
        ("\"liga\" round(2.5)", Some("\"liga\" 3")),
        ("\"liga\" calc(1px / 1px)", Some("\"liga\"")),
        // rejected
        ("", None),
        ("none", None),
        ("inherit", None),
        ("var(--x)", None),
        ("liga", None),
        ("liga 1", None),
        ("\"lig\"", None),
        ("\"ligat\"", None),
        ("\"\"", None),
        ("\"lig\u{e9}\"", None),
        ("\"li\tg\"", None),
        ("\"\u{7f}\u{7f}\u{7f}\u{7f}\"", None),
        ("\"\u{1F600}ab\"", None),
        ("\"liga\" 1.5", None),
        ("\"liga\" 1.0", None),
        ("\"liga\" 1e1", None),
        ("\"liga\" 1e0", None),
        ("\"liga\" 1px", None),
        ("\"liga\" 10%", None),
        ("\"liga\" calc(1px)", None),
        ("\"liga\" calc(50%)", None),
        ("\"liga\" 1 2", None),
        ("\"liga\",", None),
        (",\"liga\"", None),
        ("\"liga\" off on", None),
        ("\"liga\" on 1", None),
        ("\"liga\" on off", None),
        ("normal, \"liga\"", None),
        ("\"liga\", normal", None),
        ("\"liga\" normal", None),
        ("\"liga\";", None),
        ("\"liga\" !important", None),
        ("\"liga\"\u{a0}1", None),
        ("\"liga\",\u{a0}\"dlig\"", None),
        ("\"liga\" 1,,\"dlig\"", None),
        ("\"liga\" var(--x)", None),
      ],
    );
  }

  #[test]
  fn font_feature_settings_computed() {
    let s = FontFeatureSettings::parse("\"liga\" 0, \"kern\" -1, \"liga\" 257").unwrap();
    assert_eq!(
      s.0,
      vec![
        FontFeature {
          tag: u32::from_be_bytes(*b"kern"),
          value: -1
        },
        FontFeature {
          tag: u32::from_be_bytes(*b"liga"),
          value: 257
        },
      ]
    );
  }

  #[test]
  fn font_variant_ligatures() {
    check(
      fvl,
      &[
        ("normal", Some("normal")),
        ("Normal", Some("normal")),
        ("none", Some("none")),
        ("NONE", Some("none")),
        (
          "no-common-ligatures no-discretionary-ligatures no-historical-ligatures no-contextual",
          Some("none"),
        ),
        (
          "no-contextual no-historical-ligatures no-discretionary-ligatures no-common-ligatures",
          Some("none"),
        ),
        (
          "contextual common-ligatures",
          Some("common-ligatures contextual"),
        ),
        (
          "no-contextual historical-ligatures discretionary-ligatures no-common-ligatures",
          Some("no-common-ligatures discretionary-ligatures historical-ligatures no-contextual"),
        ),
        (
          "historical-ligatures common-ligatures",
          Some("common-ligatures historical-ligatures"),
        ),
        (
          "contextual historical-ligatures discretionary-ligatures common-ligatures",
          Some("common-ligatures discretionary-ligatures historical-ligatures contextual"),
        ),
        (
          "  common-ligatures   contextual  ",
          Some("common-ligatures contextual"),
        ),
        (
          "common-ligatures /*x*/ contextual",
          Some("common-ligatures contextual"),
        ),
        ("Common-Ligatures", Some("common-ligatures")),
        ("CONTEXTUAL", Some("contextual")),
        ("no-contextual", Some("no-contextual")),
        ("common-ligatures common-ligatures", None),
        ("common-ligatures no-common-ligatures", None),
        ("contextual contextual", None),
        ("none common-ligatures", None),
        ("common-ligatures none", None),
        ("normal none", None),
        ("common-ligatures normal", None),
        ("no-common-ligatures none", None),
        ("common-ligatures,contextual", None),
        ("contextual-ligatures", None),
        ("common", None),
        ("liga", None),
        ("\"none\"", None),
        ("common-ligatures;", None),
        ("common-ligatures\u{a0}contextual", None),
        ("", None),
        ("inherit", None),
      ],
    );
  }

  #[test]
  fn font_variant_numeric() {
    check(
      fvn,
      &[
        ("normal", Some("normal")),
        ("NORMAL", Some("normal")),
        (
          "slashed-zero tabular-nums",
          Some("tabular-nums slashed-zero"),
        ),
        ("SLASHED-ZERO ORDINAL", Some("ordinal slashed-zero")),
        (
          "slashed-zero ordinal stacked-fractions tabular-nums oldstyle-nums",
          Some("oldstyle-nums tabular-nums stacked-fractions ordinal slashed-zero"),
        ),
        (
          "diagonal-fractions proportional-nums lining-nums",
          Some("lining-nums proportional-nums diagonal-fractions"),
        ),
        ("  tabular-nums   ordinal  ", Some("tabular-nums ordinal")),
        ("tabular-nums/**/ordinal", Some("tabular-nums ordinal")),
        ("tabular-nums\x0Cordinal", Some("tabular-nums ordinal")),
        ("tabular-nums\rordinal", Some("tabular-nums ordinal")),
        ("tabular\\-nums", Some("tabular-nums")),
        ("tabular\\2d nums", Some("tabular-nums")),
        ("\\74 abular-nums", Some("tabular-nums")),
        ("lining-nums oldstyle-nums", None),
        ("tabular-nums tabular-nums", None),
        ("normal ordinal", None),
        ("ordinal normal", None),
        ("tabular-nums,ordinal", None),
        ("tabular-nums;", None),
        ("tabular-nums !important", None),
        ("tabular-nums\u{a0}ordinal", None),
        ("tabular-nums\u{3000}ordinal", None),
        ("tabular-nums\\", None),
        ("ordinal\0", None),
        ("tnum", None),
        ("none", None),
        ("\"tabular-nums\"", None),
        ("", None),
        ("revert-layer", None),
      ],
    );
  }

  #[test]
  fn font_variant_position() {
    check(
      fvp,
      &[
        ("normal", Some("normal")),
        ("SUB", Some("sub")),
        ("Super", Some("super")),
        ("  sub  ", Some("sub")),
        ("/**/sub", Some("sub")),
        ("s\\75 b", Some("sub")),
        ("\\73 uper", Some("super")),
        ("sub\x0C", Some("sub")),
        ("sub super", None),
        ("subscript", None),
        ("none", None),
        ("baseline", None),
        ("\"sub\"", None),
        ("sub,", None),
        ("sub\u{a0}", None),
        ("\u{a0}sub", None),
        ("", None),
        ("initial", None),
      ],
    );
  }

  #[test]
  fn font_size_adjust() {
    check(
      fsa,
      &[
        ("none", Some("none")),
        ("NONE", Some("none")),
        ("0", Some("0")),
        ("-0", Some("0")),
        ("0.5", Some("0.5")),
        (".5", Some("0.5")),
        ("+0.5", Some("0.5")),
        ("2.5e-1", Some("0.25")),
        ("ex-height 0.5", Some("0.5")),
        ("calc(0.25 + 0.25)", Some("0.5")),
        ("1e3", Some("1000")),
        ("calc(-1)", Some("0")),
        ("calc(-infinity)", Some("0")),
        ("calc(NaN)", Some("0")),
        ("calc(1/3)", Some("0.333333")),
        ("calc(infinity)", Some("infinity")),
        ("0.123456789", Some("0.123457")),
        ("0.1234565", Some("0.123457")),
        ("1234567.89", Some("1.23457e+06")),
        ("0.00001", Some("1e-05")),
        ("0.0001234", Some("0.0001234")),
        ("1e39", Some("3.40282e+38")),
        ("1e400", Some("3.40282e+38")),
        ("1e-400", Some("0")),
        ("calc(1e39)", Some("3.40282e+38")),
        ("0.2000001", Some("0.2")),
        ("999999.5", Some("1e+06")),
        ("cap-height 0.5", Some("cap-height 0.5")),
        ("Cap-Height 0.5", Some("cap-height 0.5")),
        ("cap-height 1e-7", Some("cap-height 1e-07")),
        ("ch-width 0.5", Some("ch-width 0.5")),
        ("ic-width 1", Some("ic-width 1")),
        ("ic-height 1", Some("ic-height 1")),
        ("cap-height calc(0.5 * 2)", Some("cap-height 1")),
        ("cap-height calc(-1)", Some("cap-height 0")),
        ("calc(0.5px / 1px)", Some("0.5")),
        ("cap-height/**/0.5", Some("cap-height 0.5")),
        ("from-font", Some("from-font")),
        ("FROM-FONT", Some("from-font")),
        ("ex-height from-font", Some("from-font")),
        ("cap-height from-font", Some("cap-height from-font")),
        ("ic-height from-font", Some("ic-height from-font")),
        // rejected
        ("-0.5", None),
        ("0.5px", None),
        ("50%", None),
        ("calc(50%)", None),
        ("calc(1px)", None),
        ("cap-height", None),
        ("ex-height", None),
        ("0.5 cap-height", None),
        ("from-font cap-height", None),
        ("cap-height none", None),
        ("none 0.5", None),
        ("cap-height 0.5 0.5", None),
        ("cap-height -1", None),
        ("cap-height ex-height 0.5", None),
        ("x-height 0.5", None),
        ("auto", None),
        ("normal", None),
        ("0.5 0.5", None),
        ("from-font from-font", None),
        ("cap-height,0.5", None),
        ("0.5\u{a0}", None),
        ("", None),
        ("unset", None),
      ],
    );
  }

  #[test]
  fn font_optical_sizing() {
    check(
      fos,
      &[
        ("auto", Some("auto")),
        ("none", Some("none")),
        ("AUTO", Some("auto")),
        ("None", Some("none")),
        (" auto ", Some("auto")),
        ("/**/none", Some("none")),
        ("\\61 uto", Some("auto")),
        ("normal", None),
        ("auto none", None),
        ("0", None),
        ("\"auto\"", None),
        ("auto\u{a0}", None),
        ("", None),
        ("inherit", None),
      ],
    );
  }
}
