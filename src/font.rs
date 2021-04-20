use std::str::FromStr;

use once_cell::sync::OnceCell;
use regex::Regex;
use thiserror::Error;

pub(crate) static FONT_REGEXP: OnceCell<Regex> = OnceCell::new();

const DEFAULT_FONT: &'static str = "sans-serif";

#[derive(Error, Clone, Debug)]
pub enum ParseError {
  #[error("[`{0}`] is not valid font style")]
  InvalidFontStyle(String),
  #[error("[`{0}`] is not valid font variant")]
  InvalidFontVariant(String),
}

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

#[derive(Debug, Clone, PartialEq)]
pub struct Font {
  pub size: f32,
  pub style: FontStyle,
  pub family: String,
  pub variant: FontVariant,
  pub stretch: f32,
  pub weight: u32,
}

impl Default for Font {
  fn default() -> Self {
    Font {
      size: 10.0,
      style: FontStyle::Normal,
      family: DEFAULT_FONT.to_owned(),
      variant: FontVariant::Normal,
      stretch: 1.0,
      weight: 400,
    }
  }
}

impl Font {
  #[inline]
  pub fn new(font_rules: &str) -> Result<Font, ParseError> {
    let font_regexp = FONT_REGEXP.get_or_init(init_font_regexp);
    let default_font = Font::default();
    if let Some(cap) = font_regexp.captures(font_rules) {
      let size_str = cap.get(7).or_else(|| cap.get(5)).unwrap().as_str();
      let size = if size_str.ends_with("%") {
        size_str
          .parse::<f32>()
          .map(|v| v / 100.0 * FONT_MEDIUM_PX)
          .ok()
      } else {
        size_str.parse::<f32>().ok()
      };
      let family = cap.get(9).map(|c| c.as_str()).unwrap_or(DEFAULT_FONT);
      // return if no valid size
      if size.is_some() {
        let size = size.unwrap();
        let style = cap
          .get(2)
          .and_then(|m| FontStyle::from_str(m.as_str()).ok())
          .unwrap_or(default_font.style);
        let variant = cap
          .get(3)
          .and_then(|m| FontVariant::from_str(m.as_str()).ok())
          .unwrap_or(default_font.variant);
        let weight = cap
          .get(4)
          .and_then(|m| parse_font_weight(m.as_str()))
          .unwrap_or(default_font.weight);
        // treat stretch as size
        // the `20%` of '20% Arial' is treated as `stretch` but it's size actually
        let stretch = if cap.get(6).is_none() {
          default_font.stretch
        } else {
          cap
            .get(5)
            .and_then(|m| parse_font_stretch(m.as_str()))
            .unwrap_or(default_font.stretch)
        };
        let size_px = parse_size_px(size, cap.get(8).map(|m| m.as_str()).unwrap_or("px"));
        Ok(Font {
          style,
          variant,
          weight,
          size: size_px,
          stretch,
          family: family
            .split(",")
            .map(|string| string.trim())
            .collect::<Vec<&str>>()
            .join(","),
        })
      } else {
        Err(ParseError::InvalidFontStyle(font_rules.to_owned()))
      }
    } else {
      Err(ParseError::InvalidFontStyle(font_rules.to_owned()))
    }
  }
}

#[inline]
// [ [ <'font-style'> || <font-variant-css21> || <'font-weight'> || <'font-stretch'> ]? <'font-size'> [ / <'line-height'> ]? <'font-family'> ] | caption | icon | menu | message-box | small-caption | status-barwhere <font-variant-css21> = [ normal | small-caps ]
pub(crate) fn init_font_regexp() -> Regex {
  Regex::new(
    r#"(?x)
    (
      (italic|oblique|normal){0,1}\s+              |  # style
      (small-caps|normal){0,1}\s+                  |  # variant
      (bold|bolder|lighter|[1-9]00|normal){0,1}\s+ |  # weight
      (ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded|extra-expanded|ultra-expanded|[\d\.]+%){0,1}\s+ # stretch
    ){0,4}               
    (
      ([\d\.]+)                                       # size
      (%|px|pt|pc|in|cm|mm|%|em|ex|ch|rem|q)?\s*      # unit
    )
    # line-height is ignored here, as per the spec
    # Borrowed from https://github.com/Automattic/node-canvas/blob/master/lib/parse-font.js#L21
    ((?:'([^']+)'|"([^"]+)"|[\w\s-]+)(\s*,\s*(?:'([^']+)'|"([^"]+)"|[\w\s-]+))*)?                                            # family
  "#,
  )
  .unwrap()
}

#[derive(Debug, Clone, PartialEq)]
pub enum FontStyle {
  Normal,
  Italic,
  Oblique,
}

impl FromStr for FontStyle {
  type Err = ParseError;

  fn from_str(s: &str) -> Result<FontStyle, ParseError> {
    match s {
      "normal" => Ok(Self::Normal),
      "italic" => Ok(Self::Italic),
      "oblique" => Ok(Self::Oblique),
      _ => Err(ParseError::InvalidFontStyle(s.to_owned())),
    }
  }
}

#[derive(Debug, Clone, PartialEq)]
pub enum FontVariant {
  Normal,
  SmallCaps,
}

impl FromStr for FontVariant {
  type Err = ParseError;

  fn from_str(s: &str) -> Result<FontVariant, ParseError> {
    match s {
      "normal" => Ok(Self::Normal),
      "small-caps" => Ok(Self::SmallCaps),
      _ => Err(ParseError::InvalidFontVariant(s.to_owned())),
    }
  }
}

#[inline]
// https://drafts.csswg.org/css-fonts-4/#propdef-font-weight
fn parse_font_weight(weight: &str) -> Option<u32> {
  match weight {
    "lighter" | "100" => Some(100),
    "200" => Some(200),
    "300" => Some(300),
    "normal" | "400" => Some(400),
    "500" => Some(500),
    "600" => Some(600),
    "bold" | "bolder" | "700" => Some(700),
    _ => weight.parse::<f32>().ok().and_then(|w| {
      if w >= MIN_FONT_WEIGHT && w <= MAX_FONT_WEIGHT {
        Some(w as u32)
      } else {
        None
      }
    }),
  }
}

#[inline]
fn parse_font_stretch(stretch: &str) -> Option<f32> {
  match stretch {
    "ultra-condensed" | "50%" => Some(0.5),
    "extra-condensed" | "62.5%" => Some(0.625),
    "condensed" | "75%" => Some(0.75),
    "semi-condensed" | "87.5%" => Some(0.875),
    "normal" | "100%" => Some(1.0),
    "semi-expanded" | "112.5%" => Some(1.125),
    "expanded" | "125%" => Some(1.25),
    "extra-expanded" | "150%" => Some(1.5),
    "ultra-expanded" | "200%" => Some(2.0),
    _ => {
      if stretch.ends_with("%") {
        stretch.strip_suffix("%").and_then(|s| {
          s.parse::<f32>()
            .map(|value| {
              if value >= 0.0 {
                Some(value / 100.0)
              } else {
                None
              }
            })
            .ok()
            .and_then(|v| v)
        })
      } else {
        None
      }
    }
  }
}

#[inline]
fn parse_size_px(size: f32, unit: &str) -> f32 {
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
  assert_eq!(parse_font_stretch("ultra-condensed"), Some(0.5));
  assert_eq!(parse_font_stretch("50%"), Some(0.5));
  assert_eq!(parse_font_stretch("extra-condensed"), Some(0.625));
  assert_eq!(parse_font_stretch("62.5%"), Some(0.625));
  assert_eq!(parse_font_stretch("condensed"), Some(0.75));
  assert_eq!(parse_font_stretch("75%"), Some(0.75));
  assert_eq!(parse_font_stretch("semi-condensed"), Some(0.875));
  assert_eq!(parse_font_stretch("87.5%"), Some(0.875));
  assert_eq!(parse_font_stretch("normal"), Some(1.0));
  assert_eq!(parse_font_stretch("100%"), Some(1.0));
  assert_eq!(parse_font_stretch("semi-expanded"), Some(1.125));
  assert_eq!(parse_font_stretch("112.5%"), Some(1.125));
  assert_eq!(parse_font_stretch("expanded"), Some(1.25));
  assert_eq!(parse_font_stretch("125%"), Some(1.25));
  assert_eq!(parse_font_stretch("extra-expanded"), Some(1.5));
  assert_eq!(parse_font_stretch("150%"), Some(1.5));
  assert_eq!(parse_font_stretch("ultra-expanded"), Some(2.0));
  assert_eq!(parse_font_stretch("200%"), Some(2.0));
  assert_eq!(parse_font_stretch("52%"), Some(0.52));
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

#[test]
fn test_parse_size_px() {
  assert_eq!(parse_size_px(12.0, "px"), 12.0);
  assert_eq!(parse_size_px(2.0, "em"), 32.0);
}

#[test]
fn test_font_regexp() {
  let reg = init_font_regexp();
  let caps = reg.captures("1.2em \"Fira Sans\"");
  assert!(caps.is_some());
  let caps = caps.unwrap();
  for i in 1usize..=5usize {
    assert_eq!(caps.get(i), None);
  }
  // size
  assert_eq!(caps.get(7).map(|m| m.as_str()), Some("1.2"));
  // unit
  assert_eq!(caps.get(8).map(|m| m.as_str()), Some("em"));
  // family
  assert_eq!(caps.get(9).map(|m| m.as_str()), Some("\"Fira Sans\""));
}

#[test]
fn test_font_regexp_order1() {
  let reg = init_font_regexp();
  let caps = reg.captures("bold italic 50px Arial, sans-serif");
  assert!(caps.is_some());
  let caps = caps.unwrap();
  assert_eq!(caps.get(2).map(|m| m.as_str()), Some("italic")); // style
  assert_eq!(caps.get(3), None); // variant
  assert_eq!(caps.get(4).map(|m| m.as_str()), Some("bold")); // weight
  assert_eq!(caps.get(5), None); // stretch
  assert_eq!(caps.get(7).map(|m| m.as_str()), Some("50")); // size
  assert_eq!(caps.get(8).map(|m| m.as_str()), Some("px")); // unit
  assert_eq!(caps.get(9).map(|m| m.as_str()), Some("Arial, sans-serif")); // family
}

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
        size: 26.666666666666668,
        family: "Arial".to_owned(),
        ..Default::default()
      },
    ),
    (
      "20.5pt Arial",
      Font {
        size: 27.333333333333332,
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
    (
      "20% 50% Arial",
      Font {
        size: 8.0,
        family: "Arial".to_owned(),
        stretch: 0.2,
        ..Default::default()
      },
    ),
    (
      "20mm Arial",
      Font {
        size: 75.59055118110237,
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
        family: "\"Helvetica Neue\",sans-serif".to_owned(),
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
    (
      "50px",
      Font {
        size: 50.0,
        family: "sans-serif".to_owned(),
        ..Default::default()
      },
    ),
  ];

  for (rule, expect) in fixtures.into_iter() {
    assert_eq!(Font::new(rule).unwrap(), expect);
  }
}
