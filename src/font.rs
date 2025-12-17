use std::str::FromStr;

use cssparser::{Parser, ParserInput, Token};

use crate::error::SkError;

const DEFAULT_FONT: &str = "sans-serif";

/// The minimum font-weight value per:
///
/// https://drafts.csswg.org/css-fonts-4/#font-weight-numeric-values
pub const MIN_FONT_WEIGHT: f32 = 1.;

/// The maximum font-weight value per:
///
/// https://drafts.csswg.org/css-fonts-4/#font-weight-numeric-values
pub const MAX_FONT_WEIGHT: f32 = 1000.;

/// The default font size.
pub const FONT_MEDIUM_PX: f32 = 16.0;

/// Generic font families per CSS Fonts spec
#[allow(dead_code)]
const GENERIC_FAMILIES: &[&str] = &[
  // <generic-complete>
  "serif",
  "sans-serif",
  "system-ui",
  "cursive",
  "fantasy",
  "math",
  "monospace",
  // <generic-incomplete>
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
];

#[derive(Debug, Clone, PartialEq)]
pub struct Font {
  pub size: f32,
  pub style: FontStyle,
  pub family: String,
  pub variant: FontVariant,
  pub stretch: FontStretch,
  pub weight: u32,
  /// Oblique angle in degrees (only meaningful when style is Oblique)
  pub oblique_angle: Option<f32>,
}

impl Default for Font {
  fn default() -> Self {
    Font {
      size: 10.0,
      style: FontStyle::Normal,
      family: DEFAULT_FONT.to_owned(),
      variant: FontVariant::Normal,
      stretch: FontStretch::Normal,
      weight: 400,
      oblique_angle: None,
    }
  }
}

impl Font {
  /// Parse CSS font shorthand property using cssparser
  /// Syntax: [ [ <'font-style'> || <font-variant-css2> || <'font-weight'> || <font-width-css3> ]? <'font-size'> [ / <'line-height'> ]? <'font-family'># ] | <system-family-name>
  pub fn new(font_rules: &str) -> Result<Font, SkError> {
    let mut input = ParserInput::new(font_rules);
    let mut parser = Parser::new(&mut input);

    // First, try to parse as <system-family-name>
    if let Ok(font) = parser.try_parse(|p| parse_system_font(p)) {
      return Ok(font);
    }

    let mut font = Font::default();
    let mut found_size = false;

    // Track which properties have been explicitly set
    // This is important for handling "normal" keyword which can apply to multiple properties
    let mut style_set = false;
    let mut variant_set = false;
    let mut weight_set = false;
    let mut stretch_set = false;

    // Parse optional font-style, font-variant, font-weight, font-stretch (in any order)
    // These must come before font-size
    loop {
      let state = parser.state();

      // Try to parse a token
      let token = match parser.next() {
        Ok(t) => t.clone(),
        Err(_) => break,
      };

      match &token {
        Token::Ident(ident) => {
          let ident_lower = ident.to_ascii_lowercase();

          // Handle "normal" specially - it can apply to style, variant, weight, or stretch
          // but only if that property hasn't been set yet
          if ident_lower == "normal" {
            // "normal" sets the first unset property in order: style, variant, weight, stretch
            if !style_set {
              font.style = FontStyle::Normal;
              style_set = true;
            } else if !variant_set {
              font.variant = FontVariant::Normal;
              variant_set = true;
            } else if !weight_set {
              font.weight = 400;
              weight_set = true;
            } else if !stretch_set {
              font.stretch = FontStretch::Normal;
              stretch_set = true;
            }
            continue;
          }

          // Try font-style (including oblique with optional angle)
          if ident_lower == "oblique" {
            font.style = FontStyle::Oblique;
            style_set = true;
            // Try to parse optional angle
            if let Ok(angle) = parser.try_parse(parse_oblique_angle) {
              font.oblique_angle = Some(angle);
            }
            continue;
          }
          if ident_lower == "italic" {
            font.style = FontStyle::Italic;
            style_set = true;
            continue;
          }
          // Try font-variant
          if ident_lower == "small-caps" {
            font.variant = FontVariant::SmallCaps;
            variant_set = true;
            continue;
          }
          // Try font-weight keyword (excluding "normal" which is handled above)
          if let Some(weight) = parse_font_weight_keyword_no_normal(&ident_lower) {
            font.weight = weight;
            weight_set = true;
            continue;
          }
          // Try font-stretch keyword (excluding "normal" which is handled above)
          if let Some(stretch) = parse_font_stretch_keyword_no_normal(&ident_lower) {
            font.stretch = stretch;
            stretch_set = true;
            continue;
          }
          // Not a recognized keyword before size, reset and try to parse as size
          parser.reset(&state);
          break;
        }
        Token::Number { value, .. } => {
          // Could be font-weight (1-1000)
          let v = *value;
          if (MIN_FONT_WEIGHT..=MAX_FONT_WEIGHT).contains(&v) {
            font.weight = v as u32;
            weight_set = true;
            continue;
          }
          // Invalid weight, reset and try size
          parser.reset(&state);
          break;
        }
        Token::Dimension { .. } | Token::Percentage { .. } => {
          // This is the font-size, reset and parse it properly
          parser.reset(&state);
          break;
        }
        _ => {
          // Unknown token, reset and try size
          parser.reset(&state);
          break;
        }
      }
    }

    // Parse font-size (required)
    if let Ok((size, unit)) = parse_font_size(&mut parser) {
      font.size = parse_size_px(size, unit.as_deref().unwrap_or("px"));
      found_size = true;
    }

    if !found_size {
      return Err(SkError::InvalidFontStyle(font_rules.to_owned()));
    }

    // Skip optional line-height (/ <line-height>)
    let _ = parser.try_parse(|p| -> Result<(), cssparser::ParseError<'_, ()>> {
      p.expect_delim('/')?;
      // Parse line-height: normal | <number> | <length-percentage>
      match p.next()? {
        Token::Ident(ident) if ident.eq_ignore_ascii_case("normal") => Ok(()),
        Token::Number { .. } | Token::Dimension { .. } | Token::Percentage { .. } => Ok(()),
        _ => Err(p.new_custom_error(())),
      }
    });

    // Parse font-family (required, but defaults to sans-serif)
    let families = parse_font_family(&mut parser);
    if !families.is_empty() {
      font.family = families.join(",");
    }

    Ok(font)
  }
}

/// Parse <system-family-name>: caption | icon | menu | message-box | small-caption | status-bar
fn parse_system_font<'i>(parser: &mut Parser<'i, '_>) -> Result<Font, cssparser::ParseError<'i, ()>> {
  let ident = parser.expect_ident()?.clone();
  let ident_lower = ident.to_ascii_lowercase();

  // Check that there's nothing after the system font name
  if parser.next().is_ok() {
    return Err(parser.new_custom_error(()));
  }

  let (size, weight) = match ident_lower.as_str() {
    "caption" => (13.0, 400),       // System font for captioned controls
    "icon" => (12.0, 400),          // System font for icon labels
    "menu" => (13.0, 400),          // System font for menus
    "message-box" => (13.0, 400),   // System font for dialog boxes
    "small-caption" => (11.0, 400), // System font for small controls
    "status-bar" => (12.0, 400),    // System font for status bars
    _ => return Err(parser.new_custom_error(())),
  };

  Ok(Font {
    size,
    weight,
    family: "system-ui".to_owned(),
    ..Font::default()
  })
}

/// Parse oblique angle: <angle [-90deg,90deg]>
fn parse_oblique_angle<'i>(parser: &mut Parser<'i, '_>) -> Result<f32, cssparser::ParseError<'i, ()>> {
  match parser.next()? {
    Token::Dimension { value, unit, .. } => {
      let angle = match unit.to_ascii_lowercase().as_str() {
        "deg" => *value,
        "rad" => value * 180.0 / std::f32::consts::PI,
        "grad" => value * 0.9, // 400 gradians = 360 degrees
        "turn" => value * 360.0,
        _ => return Err(parser.new_custom_error(())),
      };
      // Clamp to valid range [-90deg, 90deg]
      if (-90.0..=90.0).contains(&angle) {
        Ok(angle)
      } else {
        Err(parser.new_custom_error(()))
      }
    }
    _ => Err(parser.new_custom_error(())),
  }
}

/// Parse font-size: <absolute-size> | <relative-size> | <length-percentage> | math
fn parse_font_size(parser: &mut Parser) -> Result<(f32, Option<String>), ()> {
  match parser.next() {
    Ok(Token::Dimension { value, unit, .. }) => Ok((*value, Some(unit.to_string()))),
    Ok(Token::Percentage { unit_value, .. }) => {
      // Percentage relative to parent font size (we use FONT_MEDIUM_PX as reference)
      Ok((*unit_value * 100.0, Some("%".to_string())))
    }
    Ok(Token::Number { value, .. }) => {
      // Unitless number (treated as px for compatibility)
      Ok((*value, None))
    }
    Ok(Token::Ident(ident)) => {
      let ident_lower = ident.to_ascii_lowercase();
      // <absolute-size>
      let size = match ident_lower.as_str() {
        "xx-small" => FONT_MEDIUM_PX * 0.5625,    // 9px at 16px base
        "x-small" => FONT_MEDIUM_PX * 0.625,      // 10px at 16px base
        "small" => FONT_MEDIUM_PX * 0.8125,       // 13px at 16px base
        "medium" => FONT_MEDIUM_PX,               // 16px
        "large" => FONT_MEDIUM_PX * 1.125,        // 18px at 16px base
        "x-large" => FONT_MEDIUM_PX * 1.5,        // 24px at 16px base
        "xx-large" => FONT_MEDIUM_PX * 2.0,       // 32px at 16px base
        "xxx-large" => FONT_MEDIUM_PX * 3.0,      // 48px at 16px base
        // <relative-size> (relative to parent, we use FONT_MEDIUM_PX as reference)
        "smaller" => FONT_MEDIUM_PX * 0.8333,     // ~13.3px at 16px base
        "larger" => FONT_MEDIUM_PX * 1.2,         // ~19.2px at 16px base
        // math keyword
        "math" => FONT_MEDIUM_PX,                 // Use medium size for math
        _ => return Err(()),
      };
      Ok((size, Some("px".to_string())))
    }
    _ => Err(()),
  }
}

/// Parse font-family list
fn parse_font_family(parser: &mut Parser) -> Vec<String> {
  let mut families = Vec::new();

  loop {
    // Skip comma if not first
    if !families.is_empty() {
      if parser.try_parse(|p| p.expect_comma()).is_err() {
        break;
      }
    }

    // Try quoted string first
    if let Ok(s) = parser.try_parse(|p| -> Result<String, cssparser::ParseError<'_, ()>> {
      match p.next()? {
        Token::QuotedString(s) => Ok(s.to_string()),
        _ => Err(p.new_custom_error(())),
      }
    }) {
      families.push(s);
      continue;
    }

    // Try unquoted identifier(s) - can be multiple words like "Times New Roman"
    // or a single generic family name
    let mut family_parts = Vec::new();
    loop {
      let state = parser.state();
      match parser.next() {
        Ok(Token::Ident(ident)) => {
          let ident_str = ident.to_string();
          family_parts.push(ident_str);
        }
        Ok(Token::Delim(',')) => {
          // Found comma, reset to before it and exit inner loop
          parser.reset(&state);
          break;
        }
        _ => {
          // Not an ident or comma, reset and exit
          parser.reset(&state);
          break;
        }
      }
    }
    if !family_parts.is_empty() {
      families.push(family_parts.join(" "));
      continue;
    }

    // If we couldn't parse anything in this iteration, we're done
    break;
  }

  families
}

/// Check if a string is a generic font family
#[allow(dead_code)]
fn is_generic_family(s: &str) -> bool {
  GENERIC_FAMILIES.contains(&s)
}

#[allow(dead_code)]
fn parse_font_style_keyword(s: &str) -> Option<FontStyle> {
  match s {
    "normal" => Some(FontStyle::Normal),
    "italic" => Some(FontStyle::Italic),
    // "oblique" is handled separately to support optional angle
    _ => None,
  }
}

#[allow(dead_code)]
fn parse_font_variant_keyword(s: &str) -> Option<FontVariant> {
  match s {
    "small-caps" => Some(FontVariant::SmallCaps),
    // "normal" is handled by font-style first
    _ => None,
  }
}

#[allow(dead_code)]
fn parse_font_weight_keyword(s: &str) -> Option<u32> {
  match s {
    "normal" => Some(400),
    "bold" => Some(700),
    "bolder" => Some(700),
    "lighter" => Some(100),
    _ => None,
  }
}

/// Parse font-weight keyword excluding "normal" (for use in Font::new where normal is handled specially)
fn parse_font_weight_keyword_no_normal(s: &str) -> Option<u32> {
  match s {
    "bold" => Some(700),
    "bolder" => Some(700),
    "lighter" => Some(100),
    _ => None,
  }
}

#[allow(dead_code)]
fn parse_font_stretch_keyword(s: &str) -> Option<FontStretch> {
  match s {
    "normal" => Some(FontStretch::Normal),
    "ultra-condensed" => Some(FontStretch::UltraCondensed),
    "extra-condensed" => Some(FontStretch::ExtraCondensed),
    "condensed" => Some(FontStretch::Condensed),
    "semi-condensed" => Some(FontStretch::SemiCondensed),
    "semi-expanded" => Some(FontStretch::SemiExpanded),
    "expanded" => Some(FontStretch::Expanded),
    "extra-expanded" => Some(FontStretch::ExtraExpanded),
    "ultra-expanded" => Some(FontStretch::UltraExpanded),
    _ => None,
  }
}

/// Parse font-stretch keyword excluding "normal" (for use in Font::new where normal is handled specially)
fn parse_font_stretch_keyword_no_normal(s: &str) -> Option<FontStretch> {
  match s {
    "ultra-condensed" => Some(FontStretch::UltraCondensed),
    "extra-condensed" => Some(FontStretch::ExtraCondensed),
    "condensed" => Some(FontStretch::Condensed),
    "semi-condensed" => Some(FontStretch::SemiCondensed),
    "semi-expanded" => Some(FontStretch::SemiExpanded),
    "expanded" => Some(FontStretch::Expanded),
    "extra-expanded" => Some(FontStretch::ExtraExpanded),
    "ultra-expanded" => Some(FontStretch::UltraExpanded),
    _ => None,
  }
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

impl FromStr for FontStyle {
  type Err = SkError;

  fn from_str(s: &str) -> Result<FontStyle, SkError> {
    match s {
      "normal" => Ok(Self::Normal),
      "italic" => Ok(Self::Italic),
      "oblique" => Ok(Self::Oblique),
      _ => Err(SkError::InvalidFontStyle(s.to_owned())),
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FontVariant {
  Normal,
  SmallCaps,
}

impl FromStr for FontVariant {
  type Err = SkError;

  fn from_str(s: &str) -> Result<FontVariant, SkError> {
    match s {
      "normal" => Ok(Self::Normal),
      "small-caps" => Ok(Self::SmallCaps),
      _ => Err(SkError::InvalidFontVariant(s.to_owned())),
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

// https://drafts.csswg.org/css-fonts-4/#propdef-font-weight
// This function is kept for external usage (e.g., parse_font_stretch uses similar pattern)
#[allow(dead_code)]
fn parse_font_weight(weight: &str) -> Option<u32> {
  match weight {
    "lighter" | "100" => Some(100),
    "200" => Some(200),
    "300" => Some(300),
    "normal" | "400" => Some(400),
    "500" => Some(500),
    "600" => Some(600),
    "bold" | "bolder" | "700" => Some(700),
    "800" => Some(800),
    "900" => Some(900),
    "1000" => Some(1000),
    _ => weight.parse::<f32>().ok().and_then(|w| {
      if (MIN_FONT_WEIGHT..=MAX_FONT_WEIGHT).contains(&w) {
        Some(w as u32)
      } else {
        None
      }
    }),
  }
}

pub fn parse_font_stretch(stretch: &str) -> Option<FontStretch> {
  match stretch {
    "ultra-condensed" | "50%" => Some(FontStretch::UltraCondensed),
    "extra-condensed" | "62.5%" => Some(FontStretch::ExtraCondensed),
    "condensed" | "75%" => Some(FontStretch::Condensed),
    "semi-condensed" | "87.5%" => Some(FontStretch::SemiCondensed),
    "normal" | "100%" => Some(FontStretch::Normal),
    "semi-expanded" | "112.5%" => Some(FontStretch::SemiExpanded),
    "expanded" | "125%" => Some(FontStretch::Expanded),
    "extra-expanded" | "150%" => Some(FontStretch::ExtraExpanded),
    "ultra-expanded" | "200%" => Some(FontStretch::UltraExpanded),
    _ => None,
  }
}

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

#[test]
fn font_stretch() {
  assert_eq!(
    parse_font_stretch("ultra-condensed"),
    Some(FontStretch::UltraCondensed)
  );
  assert_eq!(parse_font_stretch("50%"), Some(FontStretch::UltraCondensed));
  assert_eq!(
    parse_font_stretch("extra-condensed"),
    Some(FontStretch::ExtraCondensed)
  );
  assert_eq!(
    parse_font_stretch("62.5%"),
    Some(FontStretch::ExtraCondensed)
  );
  assert_eq!(
    parse_font_stretch("condensed"),
    Some(FontStretch::Condensed)
  );
  assert_eq!(parse_font_stretch("75%"), Some(FontStretch::Condensed));
  assert_eq!(
    parse_font_stretch("semi-condensed"),
    Some(FontStretch::SemiCondensed)
  );
  assert_eq!(
    parse_font_stretch("87.5%"),
    Some(FontStretch::SemiCondensed)
  );
  assert_eq!(parse_font_stretch("normal"), Some(FontStretch::Normal));
  assert_eq!(parse_font_stretch("100%"), Some(FontStretch::Normal));
  assert_eq!(
    parse_font_stretch("semi-expanded"),
    Some(FontStretch::SemiExpanded)
  );
  assert_eq!(
    parse_font_stretch("112.5%"),
    Some(FontStretch::SemiExpanded)
  );
  assert_eq!(parse_font_stretch("expanded"), Some(FontStretch::Expanded));
  assert_eq!(parse_font_stretch("125%"), Some(FontStretch::Expanded));
  assert_eq!(
    parse_font_stretch("extra-expanded"),
    Some(FontStretch::ExtraExpanded)
  );
  assert_eq!(parse_font_stretch("150%"), Some(FontStretch::ExtraExpanded));
  assert_eq!(
    parse_font_stretch("ultra-expanded"),
    Some(FontStretch::UltraExpanded)
  );
  assert_eq!(parse_font_stretch("200%"), Some(FontStretch::UltraExpanded));
  assert_eq!(parse_font_stretch("52%"), None);
  assert_eq!(parse_font_stretch("-50%"), None);
  assert_eq!(parse_font_stretch("50"), None);
  assert_eq!(parse_font_stretch("ultra"), None);
}

#[test]
fn test_parse_font_weight() {
  assert_eq!(parse_font_weight("lighter"), Some(100));
  assert_eq!(parse_font_weight("normal"), Some(400));
  assert_eq!(parse_font_weight("bold"), Some(700));
  assert_eq!(parse_font_weight("bolder"), Some(700));
  assert_eq!(parse_font_weight("100"), Some(100));
  assert_eq!(parse_font_weight("100.1"), Some(100));
  assert_eq!(parse_font_weight("120"), Some(120));
  assert_eq!(parse_font_weight("0.01"), None);
  assert_eq!(parse_font_weight("-20"), None);
  assert_eq!(parse_font_weight("whatever"), None);
}

#[allow(clippy::float_cmp)]
#[test]
fn test_parse_size_px() {
  assert_eq!(parse_size_px(12.0, "px"), 12.0f32);
  assert_eq!(parse_size_px(2.0, "em"), 32.0f32);
}

// cargo test --lib font -- --nocapture
#[test]
fn test_font_new() {
  let fixtures: Vec<(&'static str, Font)> = vec![
    (
      "20px Arial",
      Font {
        size: 20.0,
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    (
      "20pt Arial",
      Font {
        size: 26.666_666,
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    (
      "20.5pt Arial",
      Font {
        size: 27.333_334,
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    (
      "50% Arial",
      Font {
        size: 8.0,
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    // Note: percentage font-stretch (e.g., "62.5%") is not supported in font shorthand
    // It's only valid in the standalone font-stretch property
    (
      "extra-condensed 50% Arial",
      Font {
        size: 8.0,
        family: "Arial".to_owned(),
        stretch: FontStretch::ExtraCondensed,
        ..Default::default()
      },
    ),
    (
      "20mm Arial",
      Font {
        size: 75.590_55,
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    (
      "20px sans-serif",
      Font {
        size: 20.0,
        family: "sans-serif".to_owned(),
        ..Default::default()
      },
    ),
    (
      "20px monospace",
      Font {
        size: 20.0,
        family: "monospace".to_owned(),
        ..Default::default()
      },
    ),
    (
      "50px Arial, sans-serif",
      Font {
        size: 50.0,
        family: "Arial,sans-serif".to_owned(),
        ..Default::default()
      },
    ),
    (
      "bold italic 50px Arial, sans-serif",
      Font {
        size: 50.0,
        weight: 700,
        style: FontStyle::Italic,
        family: "Arial,sans-serif".to_owned(),
        ..Default::default()
      },
    ),
    (
      "50px Helvetica ,  Arial, sans-serif",
      Font {
        size: 50.0,
        family: "Helvetica,Arial,sans-serif".to_owned(),
        ..Default::default()
      },
    ),
    (
      "50px \"Helvetica Neue\", sans-serif",
      Font {
        size: 50.0,
        family: "Helvetica Neue,sans-serif".to_owned(),
        ..Default::default()
      },
    ),
    (
      "100px 'Microsoft YaHei'",
      Font {
        size: 100.0,
        family: "Microsoft YaHei".to_owned(),
        ..Default::default()
      },
    ),
    (
      "300 20px Arial",
      Font {
        size: 20.0,
        weight: 300,
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    // Test numeric font-weight values (CSS Fonts Level 4)
    (
      "101 20px Source Serif Pro",
      Font {
        size: 20.0,
        weight: 101,
        family: "Source Serif Pro".to_owned(),
        ..Default::default()
      },
    ),
    (
      "550 20px Arial",
      Font {
        size: 20.0,
        weight: 550,
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    (
      "950 20px sans-serif",
      Font {
        size: 20.0,
        weight: 950,
        family: "sans-serif".to_owned(),
        ..Default::default()
      },
    ),
    // Test oblique with angle
    (
      "oblique 20px Arial",
      Font {
        size: 20.0,
        style: FontStyle::Oblique,
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    (
      "oblique 14deg 20px Arial",
      Font {
        size: 20.0,
        style: FontStyle::Oblique,
        oblique_angle: Some(14.0),
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    // Test absolute-size keywords
    (
      "small Arial",
      Font {
        size: 13.0, // FONT_MEDIUM_PX * 0.8125
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    (
      "large Arial",
      Font {
        size: 18.0, // FONT_MEDIUM_PX * 1.125
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    (
      "x-large Arial",
      Font {
        size: 24.0, // FONT_MEDIUM_PX * 1.5
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    // Test line-height with normal keyword
    (
      "16px/normal Arial",
      Font {
        size: 16.0,
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    // Test line-height with number
    (
      "16px/2 Arial",
      Font {
        size: 16.0,
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    (
      "50px",
      Font {
        size: 50.0,
        family: "sans-serif".to_owned(),
        ..Default::default()
      },
    ),
    (
      "400 48px/57.599999999999994px Cascadia",
      Font {
        size: 48.0,
        weight: 400,
        family: "Cascadia".to_owned(),
        ..Default::default()
      },
    ),
    (
      "56px bold Arial",
      Font {
        size: 56.0,
        weight: 400,
        family: "bold Arial".to_owned(),
        ..Default::default()
      },
    ),
    (
      // TODO: test invalid value 56px bold 'Arial'
      "bold 56px 'Arial'",
      Font {
        size: 56.0,
        weight: 700,
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    // Test small-caps with italic and line-height
    // The line-height doesn't appear because it is forced to "normal", the default value.
    // HTML5 Spec: https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-font-dev
    (
      "small-caps italic normal 16px/3 Unknown Font",
      Font {
        size: 16.0,
        style: FontStyle::Italic,
        variant: FontVariant::SmallCaps,
        family: "Unknown Font".to_owned(),
        ..Default::default()
      },
    ),
  ];

  for (rule, expect) in fixtures.into_iter() {
    assert_eq!(Font::new(rule).unwrap(), expect);
  }
}

#[test]
fn test_system_font() {
  // Test <system-family-name>
  let font = Font::new("caption").unwrap();
  assert_eq!(font.size, 13.0);
  assert_eq!(font.family, "system-ui");

  let font = Font::new("icon").unwrap();
  assert_eq!(font.size, 12.0);
  assert_eq!(font.family, "system-ui");

  let font = Font::new("menu").unwrap();
  assert_eq!(font.size, 13.0);
  assert_eq!(font.family, "system-ui");

  let font = Font::new("message-box").unwrap();
  assert_eq!(font.size, 13.0);
  assert_eq!(font.family, "system-ui");

  let font = Font::new("small-caption").unwrap();
  assert_eq!(font.size, 11.0);
  assert_eq!(font.family, "system-ui");

  let font = Font::new("status-bar").unwrap();
  assert_eq!(font.size, 12.0);
  assert_eq!(font.family, "system-ui");
}

#[test]
fn test_generic_families() {
  // Test all generic font families
  for family in [
    "serif",
    "sans-serif",
    "system-ui",
    "cursive",
    "fantasy",
    "math",
    "monospace",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
  ] {
    let font = Font::new(&format!("20px {}", family)).unwrap();
    assert_eq!(font.family, family);
  }
}

#[test]
fn test_font_size_keywords() {
  // Test <absolute-size> keywords
  let font = Font::new("xx-small Arial").unwrap();
  assert!((font.size - 9.0).abs() < 0.01);

  let font = Font::new("x-small Arial").unwrap();
  assert!((font.size - 10.0).abs() < 0.01);

  let font = Font::new("small Arial").unwrap();
  assert!((font.size - 13.0).abs() < 0.01);

  let font = Font::new("medium Arial").unwrap();
  assert!((font.size - 16.0).abs() < 0.01);

  let font = Font::new("large Arial").unwrap();
  assert!((font.size - 18.0).abs() < 0.01);

  let font = Font::new("x-large Arial").unwrap();
  assert!((font.size - 24.0).abs() < 0.01);

  let font = Font::new("xx-large Arial").unwrap();
  assert!((font.size - 32.0).abs() < 0.01);

  let font = Font::new("xxx-large Arial").unwrap();
  assert!((font.size - 48.0).abs() < 0.01);

  // Test <relative-size> keywords
  let font = Font::new("smaller Arial").unwrap();
  assert!((font.size - 13.33).abs() < 0.1);

  let font = Font::new("larger Arial").unwrap();
  assert!((font.size - 19.2).abs() < 0.01);
}
