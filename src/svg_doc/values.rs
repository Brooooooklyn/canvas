//! Computed property values: their parsers (CSS and SVG attribute syntax)
//! and the forms written back for SkSVG's attribute parser.

use std::rc::Rc;

use cssparser::{ParseError, Parser, Token};

/// An sRGB color: 8-bit channels as Skia rounds them, float alpha.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Rgba {
  pub rgb: [u8; 3],
  pub a: f32,
}

impl Rgba {
  pub(crate) const BLACK: Rgba = Rgba {
    rgb: [0, 0, 0],
    a: 1.0,
  };

  pub(crate) fn hex(&self) -> String {
    let [r, g, b] = self.rgb;
    format!("#{r:02x}{g:02x}{b:02x}")
  }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ColorValue {
  Rgba(Rgba),
  CurrentColor,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Paint {
  None,
  Color(ColorValue),
  /// url() with its fallback (none or a color).
  Url(Rc<(String, Option<Paint>)>),
  ContextFill,
  ContextStroke,
}

/// A computed `<length-percentage>`: px + pct% of the reference length.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub(crate) struct Len {
  pub px: f32,
  pub pct: f32,
}

impl Len {
  pub(crate) fn px(px: f32) -> Len {
    Len { px, pct: 0.0 }
  }

  pub(crate) fn resolve(&self, reference: f32) -> f32 {
    self.px + self.pct * reference / 100.0
  }

  pub(crate) fn is_absolute(&self) -> bool {
    self.pct == 0.0
  }

  /// SkSVG's length syntax: a number (px) or a percentage. A length with
  /// both needs the reference.
  pub(crate) fn to_svg(self, reference: f32) -> String {
    if self.pct == 0.0 {
      num(self.px)
    } else if self.px == 0.0 {
      format!("{}%", num(self.pct))
    } else {
      num(self.resolve(reference))
    }
  }
}

/// A number SkSVG's parser (strtod, then a float cast) reads back as the
/// same float.
pub(crate) fn num(v: f32) -> String {
  if v == v.trunc() && v.abs() < 1e9 {
    format!("{}", v as i64)
  } else {
    format!("{}", v as f64)
  }
}

/// What relative lengths resolve against.
#[derive(Clone, Copy, Debug)]
pub(crate) struct LenCtx {
  pub font_size: f32,
  pub viewport: (f32, f32),
}

/// The root font size of an SVG image document (the default `medium`).
pub(crate) const ROOT_FONT_SIZE: f32 = 16.0;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Family {
  /// serif, sans-serif, ... as `GenericFamily` discriminants.
  Generic(i32),
  Named(String),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Value {
  Paint(Paint),
  Color(ColorValue),
  Number(f32),
  Len(Len),
  /// stroke-dasharray; None is `none`.
  Dashes(Option<Rc<[Len]>>),
  Keyword(&'static str),
  /// clip-path, mask and filter: a url(), or None for `none` (and for a
  /// filter list SkSVG cannot draw).
  Url(Option<Rc<str>>),
  Families(Rc<[Family]>),
  /// transform; None is `none`.
  Transform(Option<Rc<[TransformFn]>>),
  /// transform-origin x and y.
  Origin(Len, Len),
  /// The `d` property; None is `none`.
  Path(Option<Rc<str>>),
  Auto,
}

impl Value {
  /// About the heap memory the value keeps, its shared parts counted whole.
  pub(crate) fn heap_bytes(&self) -> usize {
    use std::mem::size_of_val;
    match self {
      Value::Paint(Paint::Url(u)) => size_of_val(&**u) + u.0.len(),
      Value::Dashes(Some(d)) => size_of_val(&**d),
      Value::Url(Some(t)) | Value::Path(Some(t)) => t.len(),
      Value::Families(f) => {
        size_of_val(&**f)
          + f
            .iter()
            .map(|f| match f {
              Family::Named(n) => n.len(),
              Family::Generic(_) => 0,
            })
            .sum::<usize>()
      }
      Value::Transform(Some(t)) => size_of_val(&**t),
      _ => 0,
    }
  }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum TransformFn {
  Matrix([f32; 6]),
  /// May hold percentages of the reference box.
  Translate(Len, Len),
  Scale(f32, f32),
  Rotate(f32),
  Skew(f32, f32),
}

/// Runs `f` on all of `text`; None unless it reads everything.
pub(crate) fn parse_with<T>(text: &str, f: impl FnOnce(&mut Parser) -> Option<T>) -> Option<T> {
  let mut p = Parser::new(text);
  let v = f(&mut p)?;
  p.skip_whitespace();
  p.is_exhausted().then_some(v)
}

/// A `<color>`: Blink's parser (layer 07). `currentcolor` stays a keyword
/// the element's `color` resolves; a color function that reads
/// currentcolor uses black, as an OffscreenCanvas filter color does.
pub(crate) fn parse_color(p: &mut Parser) -> Option<ColorValue> {
  if p
    .try_parse(|i| i.expect_ident_matching("currentcolor"))
    .is_ok()
  {
    return Some(ColorValue::CurrentColor);
  }
  // A calc() length in the color: em and rem are 16px, every other
  // relative unit is 0.
  let lengths = crate::css_math::Lengths {
    em: 16.0,
    rem: 16.0,
    ..Default::default()
  };
  let color = crate::color::consume_filter_color(p, &lengths)?;
  // SkSVG paints 8-bit colors: Blink's toSkColor4f().toSkColor() channels,
  // with the float alpha folded into the *-opacity the color is used with.
  let argb = color.rgb();
  Some(ColorValue::Rgba(Rgba {
    rgb: [(argb >> 16) as u8, (argb >> 8) as u8, argb as u8],
    a: color.to_sk_color4f().a.clamp(0.0, 1.0),
  }))
}

/// `#id` gives `id`; any other URL (another document, empty) gives None:
/// only same-document references resolve in an SVG image.
pub(crate) fn local_ref(url: &str) -> Option<&str> {
  url.trim().strip_prefix('#').filter(|s| !s.is_empty())
}

/// url(...) as an unquoted URL token or a function holding a string
/// (`url("#a")`, `url('#a')`).
pub(crate) fn parse_url(p: &mut Parser) -> Option<String> {
  if let Ok(u) = p.try_parse(|i| i.expect_url().map(|s| s.to_string())) {
    return Some(u);
  }
  p.try_parse(|i| {
    i.expect_function_matching("url")?;
    i.parse_nested_block(|i| Ok::<_, ParseError<()>>(i.expect_string()?.to_string()))
  })
  .ok()
}

pub(crate) fn parse_paint(p: &mut Parser) -> Option<Paint> {
  if p.try_parse(|i| i.expect_ident_matching("none")).is_ok() {
    return Some(Paint::None);
  }
  if p
    .try_parse(|i| i.expect_ident_matching("context-fill"))
    .is_ok()
  {
    return Some(Paint::ContextFill);
  }
  if p
    .try_parse(|i| i.expect_ident_matching("context-stroke"))
    .is_ok()
  {
    return Some(Paint::ContextStroke);
  }
  if let Some(url) = parse_url(p) {
    let fallback = p
      .try_parse(|i| {
        if i.try_parse(|i| i.expect_ident_matching("none")).is_ok() {
          return Ok(Paint::None);
        }
        parse_color(i).map(Paint::Color).ok_or(())
      })
      .ok();
    return Some(Paint::Url(Rc::new((url, fallback))));
  }
  parse_color(p).map(Paint::Color)
}

/// `<length-percentage>`, or a `<number>` too where `allow_number`
/// (presentation attributes, Blink's SVG attribute mode). calc() takes + and
/// - of lengths and * and / by numbers.
pub(crate) fn parse_len(p: &mut Parser, ctx: &LenCtx, allow_number: bool) -> Option<Len> {
  let token = p.next().ok()?.clone();
  len_from_token(&token, p, ctx, allow_number)
}

fn len_from_token(token: &Token, p: &mut Parser, ctx: &LenCtx, allow_number: bool) -> Option<Len> {
  match token {
    Token::Number { value, .. } if allow_number || *value == 0.0 => Some(Len::px(*value)),
    Token::Percentage { unit_value, .. } => Some(Len {
      px: 0.0,
      pct: unit_value * 100.0,
    }),
    Token::Dimension { value, unit, .. } => {
      let v = *value;
      let px = match unit.to_ascii_lowercase().as_str() {
        "px" => v,
        "em" => v * ctx.font_size,
        // Blink uses the font's x-height; 0.5em is CSS's fallback.
        "ex" => v * ctx.font_size * 0.5,
        "rem" => v * ROOT_FONT_SIZE,
        "in" => v * 96.0,
        "cm" => v * 96.0 / 2.54,
        "mm" => v * 96.0 / 25.4,
        "q" => v * 96.0 / 101.6,
        "pt" => v * 96.0 / 72.0,
        "pc" => v * 16.0,
        "vw" => v * ctx.viewport.0 / 100.0,
        "vh" => v * ctx.viewport.1 / 100.0,
        "vmin" => v * ctx.viewport.0.min(ctx.viewport.1) / 100.0,
        "vmax" => v * ctx.viewport.0.max(ctx.viewport.1) / 100.0,
        _ => return None,
      };
      Some(Len::px(px))
    }
    Token::Function(name) if name.eq_ignore_ascii_case("calc") => p
      .parse_nested_block(|i| calc_sum(i, ctx).ok_or_else(|| ParseError::<()>::custom(())))
      .ok()
      .and_then(|c| match c {
        Calc::Len(l) => Some(l),
        Calc::Number(n) if allow_number => Some(Len::px(n)),
        Calc::Number(_) => None,
      }),
    _ => None,
  }
}

#[derive(Clone, Copy)]
enum Calc {
  Number(f32),
  Len(Len),
}

fn calc_sum(p: &mut Parser, ctx: &LenCtx) -> Option<Calc> {
  let mut sum = calc_product(p, ctx)?;
  while let Ok(sign) = p.try_parse(|i| match i.next() {
    Ok(Token::Delim('+')) => Ok(1.0),
    Ok(Token::Delim('-')) => Ok(-1.0),
    _ => Err(()),
  }) {
    sum = match (sum, calc_product(p, ctx)?) {
      (Calc::Number(a), Calc::Number(b)) => Calc::Number(a + sign * b),
      (Calc::Len(a), Calc::Len(b)) => Calc::Len(Len {
        px: a.px + sign * b.px,
        pct: a.pct + sign * b.pct,
      }),
      _ => return None,
    };
  }
  Some(sum)
}

fn calc_product(p: &mut Parser, ctx: &LenCtx) -> Option<Calc> {
  let mut product = calc_value(p, ctx)?;
  while let Ok(op) = p.try_parse(|i| match i.next() {
    Ok(Token::Delim('*')) => Ok('*'),
    Ok(Token::Delim('/')) => Ok('/'),
    _ => Err(()),
  }) {
    product = match (product, calc_value(p, ctx)?, op) {
      (Calc::Number(a), Calc::Number(b), '*') => Calc::Number(a * b),
      (Calc::Number(a), Calc::Number(b), '/') => Calc::Number(a / b),
      (Calc::Len(a), Calc::Number(b), '*') | (Calc::Number(b), Calc::Len(a), '*') => {
        Calc::Len(Len {
          px: a.px * b,
          pct: a.pct * b,
        })
      }
      (Calc::Len(a), Calc::Number(b), '/') => Calc::Len(Len {
        px: a.px / b,
        pct: a.pct / b,
      }),
      _ => return None,
    };
  }
  Some(product)
}

fn calc_value(p: &mut Parser, ctx: &LenCtx) -> Option<Calc> {
  let token = p.next().ok()?.clone();
  match token {
    Token::Number { value, .. } => Some(Calc::Number(value)),
    Token::ParenthesisBlock => p
      .parse_nested_block(|i| calc_sum(i, ctx).ok_or_else(|| ParseError::<()>::custom(())))
      .ok(),
    t => len_from_token(&t, p, ctx, false).map(Calc::Len),
  }
}

pub(crate) fn parse_number_or_percentage(p: &mut Parser) -> Option<f32> {
  match p.next().ok()? {
    Token::Number { value, .. } => Some(*value),
    Token::Percentage { unit_value, .. } => Some(*unit_value),
    _ => None,
  }
}

pub(crate) fn parse_angle(p: &mut Parser) -> Option<f32> {
  match p.next().ok()?.clone() {
    Token::Number { value: 0.0, .. } => Some(0.0),
    Token::Dimension { value, unit, .. } => match unit.to_ascii_lowercase().as_str() {
      "deg" => Some(value),
      "rad" => Some(value.to_degrees()),
      "grad" => Some(value * 0.9),
      "turn" => Some(value * 360.0),
      _ => None,
    },
    _ => None,
  }
}

/// A CSS `<transform-list>` (2D, and 3D functions that stay in the plane).
pub(crate) fn parse_css_transform(
  p: &mut Parser,
  ctx: &LenCtx,
) -> Option<Option<Rc<[TransformFn]>>> {
  if p.try_parse(|i| i.expect_ident_matching("none")).is_ok() {
    return Some(None);
  }
  let mut out = Vec::new();
  while !p.is_exhausted() {
    let name = p.expect_function().ok()?.to_ascii_lowercase();
    let f = p
      .parse_nested_block(|i| -> Result<TransformFn, ParseError<()>> {
        let comma = |i: &mut Parser| {
          let _ = i.try_parse(|i| i.expect_comma());
        };
        let len = |i: &mut Parser| parse_len(i, ctx, false);
        let f = match name.as_str() {
          "matrix" => {
            let mut m = [0.0; 6];
            for (k, v) in m.iter_mut().enumerate() {
              if k > 0 {
                i.expect_comma()?;
              }
              *v = i.expect_number()?;
            }
            Some(TransformFn::Matrix(m))
          }
          "translate" => {
            let x = len(i);
            let y = if i.try_parse(|i| i.expect_comma()).is_ok() {
              len(i)
            } else {
              Some(Len::default())
            };
            x.zip(y).map(|(x, y)| TransformFn::Translate(x, y))
          }
          "translatex" => len(i).map(|x| TransformFn::Translate(x, Len::default())),
          "translatey" => len(i).map(|y| TransformFn::Translate(Len::default(), y)),
          "translate3d" => {
            let x = len(i);
            comma(i);
            let y = len(i);
            comma(i);
            match (x, y, len(i)) {
              (Some(x), Some(y), Some(z)) if z == Len::default() => {
                Some(TransformFn::Translate(x, y))
              }
              _ => None,
            }
          }
          "scale" => {
            let x = parse_number_or_percentage(i);
            let y = if i.try_parse(|i| i.expect_comma()).is_ok() {
              parse_number_or_percentage(i)
            } else {
              x
            };
            x.zip(y).map(|(x, y)| TransformFn::Scale(x, y))
          }
          "scalex" => i.expect_number().ok().map(|x| TransformFn::Scale(x, 1.0)),
          "scaley" => i.expect_number().ok().map(|y| TransformFn::Scale(1.0, y)),
          "rotate" | "rotatez" => parse_angle(i).map(TransformFn::Rotate),
          "skew" => {
            let x = parse_angle(i);
            let y = if i.try_parse(|i| i.expect_comma()).is_ok() {
              parse_angle(i)
            } else {
              Some(0.0)
            };
            x.zip(y).map(|(x, y)| TransformFn::Skew(x, y))
          }
          "skewx" => parse_angle(i).map(|x| TransformFn::Skew(x, 0.0)),
          "skewy" => parse_angle(i).map(|y| TransformFn::Skew(0.0, y)),
          _ => None,
        };
        f.ok_or_else(|| ParseError::custom(()))
      })
      .ok()?;
    out.push(f);
  }
  (!out.is_empty()).then(|| Some(out.into()))
}

/// The SVG `transform` attribute (SVG 1.1 transform list, unitless).
pub(crate) fn parse_svg_transform(text: &str) -> Option<Vec<TransformFn>> {
  let mut out = Vec::new();
  let mut rest = text.trim();
  while !rest.is_empty() {
    rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == ',');
    if rest.is_empty() {
      break;
    }
    let open = rest.find('(')?;
    let name = rest[..open].trim();
    let close = rest[open..].find(')')? + open;
    let args: Vec<f32> = rest[open + 1..close]
      .split(|c: char| c == ',' || c.is_whitespace())
      .filter(|t| !t.is_empty())
      .map(|t| t.parse::<f32>().ok())
      .collect::<Option<Vec<_>>>()?;
    out.push(match (name, args.as_slice()) {
      ("matrix", &[a, b, c, d, e, f]) => TransformFn::Matrix([a, b, c, d, e, f]),
      ("translate", &[x]) => TransformFn::Translate(Len::px(x), Len::default()),
      ("translate", &[x, y]) => TransformFn::Translate(Len::px(x), Len::px(y)),
      ("scale", &[s]) => TransformFn::Scale(s, s),
      ("scale", &[x, y]) => TransformFn::Scale(x, y),
      ("rotate", &[a]) => TransformFn::Rotate(a),
      ("rotate", &[a, cx, cy]) => TransformFn::Matrix(rotate_about(a, cx, cy)),
      ("skewX", &[a]) => TransformFn::Skew(a, 0.0),
      ("skewY", &[a]) => TransformFn::Skew(0.0, a),
      _ => return None,
    });
    rest = rest[close + 1..].trim_start();
  }
  Some(out)
}

fn rotate_about(degrees: f32, cx: f32, cy: f32) -> [f32; 6] {
  let m = multiply(&[1.0, 0.0, 0.0, 1.0, cx, cy], &rotation(degrees));
  multiply(&m, &[1.0, 0.0, 0.0, 1.0, -cx, -cy])
}

fn rotation(degrees: f32) -> [f32; 6] {
  let r = (degrees as f64).to_radians();
  let (s, c) = (r.sin() as f32, r.cos() as f32);
  [c, s, -s, c, 0.0, 0.0]
}

/// a × b (b applies first).
pub(crate) fn multiply(a: &[f32; 6], b: &[f32; 6]) -> [f32; 6] {
  [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

/// One matrix for a transform list; percentages are of `reference_box`
/// (x, y, width, height).
pub(crate) fn transform_matrix(
  list: &[TransformFn],
  reference_box: (f32, f32, f32, f32),
) -> [f32; 6] {
  let mut m = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
  for f in list {
    let n = match f {
      TransformFn::Matrix(v) => *v,
      TransformFn::Translate(x, y) => [
        1.0,
        0.0,
        0.0,
        1.0,
        x.resolve(reference_box.2),
        y.resolve(reference_box.3),
      ],
      TransformFn::Scale(x, y) => [*x, 0.0, 0.0, *y, 0.0, 0.0],
      TransformFn::Rotate(a) => rotation(*a),
      TransformFn::Skew(x, y) => [
        1.0,
        (*y as f64).to_radians().tan() as f32,
        (*x as f64).to_radians().tan() as f32,
        1.0,
        0.0,
        0.0,
      ],
    };
    m = multiply(&m, &n);
  }
  m
}

pub(crate) fn matrix_attr(m: &[f32; 6]) -> String {
  format!(
    "matrix({} {} {} {} {} {})",
    num(m[0]),
    num(m[1]),
    num(m[2]),
    num(m[3]),
    num(m[4]),
    num(m[5])
  )
}

/// `font-family`: generic keywords, strings, and identifiers joined by one
/// space (CSSParsingUtils ConsumeFontFamily).
pub(crate) fn parse_families(p: &mut Parser) -> Option<Rc<[Family]>> {
  let mut out = Vec::new();
  loop {
    if let Ok(s) = p.try_parse(|i| i.expect_string_cloned()) {
      out.push(Family::Named(s.to_string()));
    } else {
      let mut words: Vec<String> = Vec::new();
      while let Ok(ident) = p.try_parse(|i| i.expect_ident_cloned()) {
        words.push(ident.to_string());
      }
      match words.as_slice() {
        [] => return None,
        [one] => match generic_family(one) {
          Some(generic) => out.push(Family::Generic(generic)),
          None if is_reserved_family_word(one) => return None,
          None => out.push(Family::Named(one.clone())),
        },
        _ => out.push(Family::Named(words.join(" "))),
      }
    }
    if p.try_parse(|i| i.expect_comma()).is_err() {
      break;
    }
  }
  Some(out.into())
}

/// skia_c.hpp skiac_text_family::generic.
fn generic_family(ident: &str) -> Option<i32> {
  Some(match ident.to_ascii_lowercase().as_str() {
    "serif" => 1,
    "sans-serif" => 2,
    "cursive" => 3,
    "fantasy" => 4,
    "monospace" => 5,
    "system-ui" => 6,
    "-webkit-body" => 7,
    "math" => 8,
    _ => return None,
  })
}

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

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn quoted_url_paints() {
    let paint = parse_with(r##"url("#g") none"##, parse_paint).unwrap();
    assert_eq!(paint, Paint::Url(Rc::new(("#g".into(), Some(Paint::None)))));
    let paint = parse_with("url('#a\\&1')", parse_paint).unwrap();
    assert_eq!(paint, Paint::Url(Rc::new(("#a&1".into(), None))));
  }

  #[test]
  fn families_keep_quoted_generics_named() {
    let families = parse_with("\"serif\", serif, Times  New Roman", parse_families).unwrap();
    assert_eq!(
      &families[..],
      &[
        Family::Named("serif".into()),
        Family::Generic(1),
        Family::Named("Times New Roman".into())
      ]
    );
    assert!(parse_with("inherit, serif", parse_families).is_none());
  }

  #[test]
  fn calc_mixes_lengths_and_percentages() {
    let ctx = LenCtx {
      font_size: 10.0,
      viewport: (200.0, 100.0),
    };
    let l = parse_with("calc(50% - 2em)", |p| parse_len(p, &ctx, false)).unwrap();
    assert_eq!(
      l,
      Len {
        px: -20.0,
        pct: 50.0
      }
    );
    assert_eq!(l.to_svg(200.0), "80");
  }
}
