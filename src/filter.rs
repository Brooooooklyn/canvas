use std::num::ParseFloatError;

use cssparser::{Parser, Token};
use nom::{
  AsChar, Err, IResult, Parser as NomParser,
  branch::alt,
  bytes::complete::{tag, take_till, take_until},
  character::complete::char,
  combinator::map_res,
  error::Error,
  number::complete::float,
};
use thiserror::Error;

use crate::color::{self, Color};
use crate::sk::ImageFilter;

#[derive(Error, Debug)]
pub enum ParseFilterError<'a> {
  #[error("{0}")]
  Nom(Err<Error<&'a str>>),
  #[error("{0}")]
  ParseFloatError(ParseFloatError),
  #[error("[`{0}`] is not valid unit")]
  UnitParseError(&'a str),
}

impl<'a> From<Err<Error<&'a str>>> for ParseFilterError<'a> {
  fn from(value: Err<Error<&'a str>>) -> Self {
    Self::Nom(value)
  }
}

impl From<ParseFloatError> for ParseFilterError<'_> {
  fn from(value: ParseFloatError) -> Self {
    Self::ParseFloatError(value)
  }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CssFilter {
  Blur(f32),
  Brightness(f32),
  Contrast(f32),
  DropShadow(f32, f32, f32, Color),
  Grayscale(f32),
  HueRotate(f32),
  Invert(f32),
  Opacity(f32),
  Saturate(f32),
  Sepia(f32),
}

fn pixel<'a>(input: &'a str) -> Result<f32, ParseFilterError<'a>> {
  let (input, size) = take_till(|c: char| c.is_alpha())(input)?;
  let (_, unit) = take_till(|c| c == ')')(input)?;
  let size = size.trim().parse::<f32>()?;
  let mut size_px = size;
  match unit.trim() {
    "em" | "rem" | "pc" => {
      size_px = size * 16.0;
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
      size_px = size * 16.0 / 100.0;
    }
    "" => {
      if size_px != 0f32 {
        return Err(ParseFilterError::UnitParseError("[No unit assigned]"));
      }
    }
    _ => {
      return Err(ParseFilterError::UnitParseError(unit));
    }
  };

  Ok(size_px)
}

#[inline(always)]
fn pixel_in_tuple(input: &str) -> IResult<&str, f32> {
  map_res(take_until(")"), pixel).parse(input)
}

fn number_percentage(input: &str) -> IResult<&str, f32> {
  let (input, num) = float(input.trim())?;
  if let Ok((input, _)) = tag::<&str, &str, Error<&str>>("%")(input.trim()) {
    Ok((input, num / 100.0f32))
  } else {
    Ok((input, num))
  }
}

fn hue_rotate_parser(input: &str) -> IResult<&str, CssFilter> {
  let (rotated_output, _) = tag("hue-rotate(")(input)?;
  let (rotated_output, angle) = float(rotated_output.trim())?;
  let output = rotated_output.trim();
  let (output, filter) = if let Ok((output, _)) = tag::<&str, &str, Error<&str>>("deg")(output) {
    (output, CssFilter::HueRotate(angle))
  } else if let Ok((output, _)) = tag::<&str, &str, Error<&str>>("turn")(output) {
    (output, CssFilter::HueRotate(angle.fract() * 360.0))
  } else if let Ok((output, _)) = tag::<&str, &str, Error<&str>>("rad")(output) {
    (output, CssFilter::HueRotate(angle.to_degrees()))
  } else if let Ok((output, _)) = tag::<&str, &str, Error<&str>>("grad")(output) {
    (output, CssFilter::HueRotate(angle * 0.9))
  } else {
    (output, CssFilter::HueRotate(0.0f32))
  };
  let (finished_input, _) = char(')')(output.trim())?;
  Ok((finished_input.trim(), filter))
}

macro_rules! percentage_parser {
  ($filter_name:ident, $filter_rule:expr, $filter_value:ident) => {
    fn $filter_name(input: &str) -> IResult<&str, CssFilter> {
      let (input, _) = tag($filter_rule)(input)?;
      let (input, value) = number_percentage(input)?;
      let (input, _) = char(')')(input.trim())?;
      Ok((input.trim(), CssFilter::$filter_value(value)))
    }

    mod $filter_name {
      #[test]
      fn $filter_name() {
        use super::CssFilter;
        assert_eq!(
          super::$filter_name(concat!($filter_rule, "2)")),
          Ok(("", CssFilter::$filter_value(2.0f32)))
        );
        assert_eq!(
          super::$filter_name(concat!($filter_rule, "2%)")),
          Ok(("", CssFilter::$filter_value(0.02f32)))
        );
        assert_eq!(
          super::$filter_name(concat!($filter_rule, ".2)")),
          Ok(("", CssFilter::$filter_value(0.2f32)))
        );
        assert_eq!(
          super::$filter_name(concat!($filter_rule, " 2%)")),
          Ok(("", CssFilter::$filter_value(0.02f32)))
        );

        assert_eq!(
          super::$filter_name(concat!($filter_rule, " 2% )")),
          Ok(("", CssFilter::$filter_value(0.02f32)))
        );

        assert_eq!(
          super::$filter_name(concat!($filter_rule, " 2 % )")),
          Ok(("", CssFilter::$filter_value(0.02f32)))
        );

        assert_eq!(
          super::$filter_name(concat!($filter_rule, " 2 % )  ")),
          Ok(("", CssFilter::$filter_value(0.02f32)))
        );
      }
    }
  };
}

percentage_parser!(brightness_parser, "brightness(", Brightness);
percentage_parser!(contrast_parser, "contrast(", Contrast);
percentage_parser!(grayscale_parser, "grayscale(", Grayscale);
percentage_parser!(invert_parser, "invert(", Invert);
percentage_parser!(opacity_parser, "opacity(", Opacity);
percentage_parser!(saturate_parser, "saturate(", Saturate);
percentage_parser!(sepia_parser, "sepia(", Sepia);

fn blur_parser(input: &str) -> IResult<&str, CssFilter> {
  let (blurred_input, _) = tag("blur(")(input)?;

  let (blurred_input, pixel) = pixel_in_tuple(blurred_input)?;
  let (finished_input, _) = char(')')(blurred_input)?;
  Ok((finished_input.trim(), CssFilter::Blur(pixel)))
}

#[allow(clippy::unnecessary_lazy_evaluations)]
fn drop_shadow_parser(input: &str) -> IResult<&str, CssFilter> {
  let (drop_shadow_input, _) = tag("drop-shadow(")(input)?;
  let drop_shadow_input = drop_shadow_input.trim();
  let (offset_x_output, offset_x) = map_res(take_until(" "), pixel).parse(drop_shadow_input)?;
  let offset_x_output = offset_x_output.trim();
  let (offset_y_output, offset_y) =
    map_res(take_till(|ch| ch == ' ' || ch == ')'), pixel).parse(offset_x_output)?;
  let offset_y_output = offset_y_output.trim();
  let (blur_radius_output, blur_radius) = map_res(take_till(|ch| ch == ' ' || ch == ')'), pixel)
    .parse(offset_y_output)
    .unwrap_or_else(|_: Err<Error<&str>>| (offset_y_output, 0.0f32));
  let (drop_shadow_output, shadow_color) = drop_shadow_color(blur_radius_output.trim())
    .ok_or_else(|| Err::Error(Error::new(input, nom::error::ErrorKind::Verify)))?;
  Ok((
    drop_shadow_output.trim(),
    CssFilter::DropShadow(offset_x, offset_y, blur_radius, shadow_color),
  ))
}

/// The color slot of drop-shadow() and what follows its `)`: CSS tokens up to
/// the `)` that closes drop-shadow(), skipping nested blocks (color-mix(),
/// calc() ...); the end of input closes every open block. No color is
/// currentcolor, black in a canvas filter (whitespace and comments are not a
/// color). A color Blink cannot read makes
/// the whole filter invalid (`drop-shadow(1px 1px inherit)` gives `none`).
fn drop_shadow_color(input: &str) -> Option<(&str, Color)> {
  let mut parser = Parser::new(input);
  parser.set_nested_block_limit(0);
  let start = parser.position();
  let (color_end, rest_start) = loop {
    let before = parser.position();
    let opens_block = match parser.next_including_whitespace_and_comments() {
      Ok(Token::CloseParenthesis) => break (before, parser.position()),
      Ok(token) => matches!(
        token,
        Token::Function(_)
          | Token::ParenthesisBlock
          | Token::SquareBracketBlock
          | Token::CurlyBracketBlock
      ),
      Err(_) => break (parser.position(), parser.position()),
    };
    if opens_block {
      // Skip the whole block now, so the next `before` is after it.
      let _ = parser.parse_nested_block(|block| {
        while block.next_including_whitespace_and_comments().is_ok() {}
        Ok::<_, cssparser::ParseError<()>>(())
      });
    }
  };
  let color_str = parser.slice(start..color_end);
  let rest = &input[rest_start.byte_index()..];
  let color = if Parser::new(color_str).is_exhausted() {
    Color::BLACK
  } else {
    color::parse_filter_color(color_str)?
  };
  Some((rest, color))
}

pub fn css_filter(input: &str) -> IResult<&str, Vec<CssFilter>> {
  let mut filters = Vec::with_capacity(10);
  let mut input = input.trim();
  while let Ok((output, filter)) = alt((
    blur_parser,
    brightness_parser,
    contrast_parser,
    drop_shadow_parser,
    grayscale_parser,
    hue_rotate_parser,
    invert_parser,
    opacity_parser,
    saturate_parser,
    sepia_parser,
  ))
  .parse(input)
  {
    input = output;
    filters.push(filter);
  }

  Ok((input, filters))
}

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
  core::array::from_fn(|i| (base[i] + scale[i] * one_minus_amount) as f32)
}

/// Fold a parsed `<filter-value-list>` into one chained `SkImageFilter` the
/// way Blink's FilterEffectBuilder builds it, or `None` when the list produces
/// no filter at all.
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
        let slope = amount.max(0.0);
        rgb_transfer(&transfer_linear(slope, 0.0), chain.as_ref())
      }
      CssFilter::Contrast(amount) => {
        let slope = amount.max(0.0);
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
          amount as f64,
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
        let radians = angle * (std::f32::consts::PI / 180.0);
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
        let amount = amount.clamp(0.0, 1.0) as f64;
        let table = transfer_table(&[amount as f32, (1.0 - amount) as f32]);
        rgb_transfer(&table, chain.as_ref())
      }
      // A table on alpha only.
      CssFilter::Opacity(amount) => {
        let table = transfer_table(&[0.0, amount.clamp(0.0, 1.0)]);
        ImageFilter::from_argb(Some(&table), None, None, None, chain.as_ref())
      }
      // FEColorMatrix SaturateMatrix (fe_color_matrix.cc), all float.
      CssFilter::Saturate(amount) => {
        let s = amount.max(0.0);
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
          amount as f64,
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

#[test]
fn parse_empty() {
  assert_eq!(css_filter(""), Ok(("", vec![])));
}

#[test]
fn empty_filter_list_is_no_filter_not_a_null_one() {
  // Pins the `Option` chain: an empty list must produce `None`, not a
  // `Some(ImageFilter(null))` that the next draw would dereference.
  assert!(css_filters_to_image_filter(vec![]).is_none());
}

#[test]
fn leftover_input_is_the_all_or_nothing_gate() {
  // `css_filter` never returns `Err`; anything it cannot read comes back as
  // leftover input, which `Context::set_filter` uses as Blink's
  // `!stream.AtEnd()` gate. So every accepted value must leave nothing behind...
  for input in [
    "blur(3px)",
    "blur(3px) grayscale(50%)",
    "contrast(175%) brightness(103%)",
    "drop-shadow(16px 16px 10px black)",
    "hue-rotate(90deg)",
    "opacity(20%)",
    "saturate(200%)",
    "sepia(100%)",
    "invert(100%)",
    " blur(3px) ",
  ] {
    let (rest, filters) = css_filter(input).unwrap();
    assert_eq!(rest.trim(), "", "`{input}` should be consumed whole");
    assert!(!filters.is_empty(), "`{input}` should parse to a filter");
  }

  // ...and every rejected value must be visibly rejected, by leaving junk
  // behind or by parsing to nothing at all.
  for input in [
    "", "   ", "garbage", "inherit", "initial", "unset", "revert", "none",
  ] {
    let (rest, filters) = css_filter(input).unwrap();
    assert!(
      filters.is_empty(),
      "`{input}` should not parse to any filter"
    );
    assert_eq!(rest, input.trim_start(), "`{input}` should be left unread");
  }

  // Greedy parsing DOES read the valid prefix, so the leftover is the only
  // thing telling the setter to reject the assignment.
  assert_eq!(
    css_filter("blur(3px) notafilter(1)"),
    Ok(("notafilter(1)", vec![CssFilter::Blur(3.0)]))
  );
}

#[test]
fn parse_blur() {
  assert_eq!(
    css_filter("blur(20px)"),
    Ok(("", vec![CssFilter::Blur(20.0)]))
  );
  assert_eq!(css_filter("blur(0)"), Ok(("", vec![CssFilter::Blur(0.0)])));
  assert_eq!(
    css_filter("blur(1.5rem)"),
    Ok(("", vec![CssFilter::Blur(24.0)]))
  );
  assert_eq!(
    css_filter("blur(20 px)"),
    Ok(("", vec![CssFilter::Blur(20.0)]))
  );
  assert_eq!(
    css_filter("blur( 20 px )"),
    Ok(("", vec![CssFilter::Blur(20.0)]))
  );
}

/// The parsed filters with each drop-shadow() color as Skia gets it, ARGB.
#[cfg(test)]
fn with_argb(filters: Vec<CssFilter>) -> Vec<(CssFilter, u32)> {
  filters
    .into_iter()
    .map(|f| match f {
      CssFilter::DropShadow(x, y, blur, c) => (
        CssFilter::DropShadow(x, y, blur, Color::BLACK),
        c.to_sk_color4f().to_sk_color(),
      ),
      f => (f, 0),
    })
    .collect()
}

#[cfg(test)]
fn shadow(x: f32, y: f32, blur: f32, argb: u32) -> (CssFilter, u32) {
  (CssFilter::DropShadow(x, y, blur, Color::BLACK), argb)
}

#[test]
fn drop_shadow_parse() {
  fn parse(s: &str) -> (&str, Vec<(CssFilter, u32)>) {
    let (rest, filters) = css_filter(s).unwrap();
    (rest, with_argb(filters))
  }
  assert_eq!(
    parse("drop-shadow(2px 2px)"),
    ("", vec![shadow(2.0, 2.0, 0.0, 0xff000000)])
  );
  assert_eq!(
    parse("drop-shadow(2px 2px 5px)"),
    ("", vec![shadow(2.0, 2.0, 5.0, 0xff000000)])
  );
  assert_eq!(
    parse("drop-shadow(2px 2px 5px #2F14DF)"),
    ("", vec![shadow(2.0, 2.0, 5.0, 0xff2f14df)])
  );
  assert_eq!(
    parse("drop-shadow(2px 2px 5px rgba(47, 20, 223, 255))"),
    ("", vec![shadow(2.0, 2.0, 5.0, 0xff2f14df)])
  );

  // Chrome 155 draws hsl(120, 100%, 25%) as 0,128,0.
  assert_eq!(
    parse("drop-shadow(4px 0 0 hsl(120, 100%, 25%)) blur(1px)"),
    (
      "",
      vec![shadow(4.0, 0.0, 0.0, 0xff008000), (CssFilter::Blur(1.0), 0)]
    )
  );
  assert_eq!(
    parse("drop-shadow(4px 0 0 hsla(0, 100%, 50%, 0.5))"),
    ("", vec![shadow(4.0, 0.0, 0.0, 0x80ff0000)])
  );

  // CSS function names are ASCII case-insensitive; Chrome 155 keeps all of these.
  for (input, color) in [
    ("HSL(120, 100%, 25%)", 0xff008000),
    ("HsLa(0, 100%, 50%, 0.5)", 0x80ff0000),
    ("RGB(0, 128, 0)", 0xff008000),
    ("rGbA(255, 0, 0, 0.5)", 0x80ff0000),
  ] {
    assert_eq!(
      parse(&format!("drop-shadow(4px 0 0 {input}) blur(1px)")),
      (
        "",
        vec![shadow(4.0, 0.0, 0.0, color), (CssFilter::Blur(1.0), 0)]
      ),
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
  ] {
    assert_eq!(
      parse(input),
      ("", vec![shadow(20.0, 0.0, 0.0, color)]),
      "{input}"
    );
  }
  // A color it cannot read rejects the whole filter: nothing is parsed.
  for input in [
    "drop-shadow(20px 0 0 red x)",
    "drop-shadow(20px 0 0 inherit)",
    "drop-shadow(20px 0 0 violetred)",
  ] {
    assert_eq!(css_filter(input), Ok((input, vec![])), "{input}");
  }
}

#[test]
fn composite_parse() {
  assert_eq!(
    css_filter("blur(1.5rem) brightness(2)"),
    Ok((
      "",
      vec![CssFilter::Blur(24.0), CssFilter::Brightness(2.0f32)]
    ))
  );

  assert_eq!(
    css_filter("brightness(2) blur(1.5rem)"),
    Ok((
      "",
      vec![CssFilter::Brightness(2.0f32), CssFilter::Blur(24.0)]
    ))
  );

  let shadow = shadow(2.0, 2.0, 5.0, 0xff2f14df);
  for (input, expected) in [
    (
      "drop-shadow(2px 2px 5px rgba(47, 20, 223, 255)) brightness(2) blur(1.5rem)",
      vec![
        shadow.clone(),
        (CssFilter::Brightness(2.0f32), 0),
        (CssFilter::Blur(24.0), 0),
      ],
    ),
    (
      "brightness(2) drop-shadow(2px 2px 5px rgba(47, 20, 223, 255)) blur(1.5rem)",
      vec![
        (CssFilter::Brightness(2.0f32), 0),
        shadow.clone(),
        (CssFilter::Blur(24.0), 0),
      ],
    ),
    (
      "brightness(2) blur(1.5rem) drop-shadow(2px 2px 5px rgba(47, 20, 223, 255))",
      vec![
        (CssFilter::Brightness(2.0f32), 0),
        (CssFilter::Blur(24.0), 0),
        shadow.clone(),
      ],
    ),
  ] {
    let (rest, filters) = css_filter(input).unwrap();
    assert_eq!((rest, with_argb(filters)), ("", expected), "{input}");
  }
}

#[test]
fn hue_rotate_parse() {
  assert_eq!(
    hue_rotate_parser("hue-rotate(0)"),
    Ok(("", CssFilter::HueRotate(0.0f32)))
  );
  assert_eq!(
    hue_rotate_parser("hue-rotate(90deg)"),
    Ok(("", CssFilter::HueRotate(90.0f32)))
  );
  assert_eq!(
    hue_rotate_parser("hue-rotate(-0.25turn)"),
    Ok(("", CssFilter::HueRotate(-90.0f32)))
  );
  assert_eq!(
    hue_rotate_parser("hue-rotate(3.141592653rad)"),
    Ok(("", CssFilter::HueRotate(180.0f32)))
  );
}

#[test]
fn parse_number_or_percentage() {
  assert_eq!(number_percentage("2"), Ok(("", 2f32)));
  assert_eq!(number_percentage("1.11"), Ok(("", 1.11f32)));
  assert_eq!(number_percentage("20%"), Ok(("", 0.2f32)));
  assert_eq!(number_percentage("-20%"), Ok(("", -0.2f32)));
  assert_eq!(number_percentage("-0.1"), Ok(("", -0.1f32)));
}
