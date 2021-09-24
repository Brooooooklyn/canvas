use std::{num::ParseFloatError, ptr};

use cssparser::{Color, Parser, ParserInput, RGBA};
use nom::{
  branch::alt,
  bytes::complete::{tag, take_till, take_until},
  character::{complete::char, is_alphabetic},
  combinator::map_res,
  error::Error,
  number::complete::float,
  Err, IResult,
};
use thiserror::Error;

use crate::sk::{degrees_to_radians, ImageFilter, TileMode};

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

impl<'a> From<ParseFloatError> for ParseFilterError<'a> {
  fn from(value: ParseFloatError) -> Self {
    Self::ParseFloatError(value)
  }
}

#[derive(Debug, PartialEq)]
pub enum CssFilter {
  Blur(f32),
  Brightness(f32),
  Contrast(f32),
  DropShadow(f32, f32, f32, RGBA),
  Grayscale(f32),
  HueRotate(f32),
  Invert(f32),
  Opacity(f32),
  Saturate(f32),
  Sepia(f32),
}

fn pixel(input: &str) -> Result<f32, ParseFilterError> {
  let (input, size) = take_till(|c| is_alphabetic(c as u8))(input)?;
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
  map_res(take_until(")"), pixel)(input)
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

#[inline(always)]
fn blur_parser(input: &str) -> IResult<&str, CssFilter> {
  let (blurred_input, _) = tag("blur(")(input)?;

  let (blurred_input, pixel) = pixel_in_tuple(blurred_input)?;
  let (finished_input, _) = char(')')(blurred_input)?;
  Ok((finished_input.trim(), CssFilter::Blur(pixel)))
}

#[inline(always)]
#[allow(clippy::unnecessary_lazy_evaluations)]
fn drop_shadow_parser(input: &str) -> IResult<&str, CssFilter> {
  let (drop_shadow_input, _) = tag("drop-shadow(")(input)?;
  let drop_shadow_input = drop_shadow_input.trim();
  let (offset_x_output, offset_x) = map_res(take_until(" "), pixel)(drop_shadow_input)?;
  let offset_x_output = offset_x_output.trim();
  let (offset_y_output, offset_y) =
    map_res(take_till(|ch| ch == ' ' || ch == ')'), pixel)(offset_x_output)?;
  let offset_y_output = offset_y_output.trim();
  let (blur_radius_output, blur_radius) =
    map_res(take_till(|ch| ch == ' ' || ch == ')'), pixel)(offset_y_output)
      .unwrap_or_else(|_: Err<Error<&str>>| (offset_y_output, 0.0f32));
  let blur_radius_output = blur_radius_output.trim();
  let is_rgb_fn = blur_radius_output.starts_with("rgb(") || blur_radius_output.starts_with("rgba(");
  let (shadow_color_output, shadow_color_str) =
    take_until(if is_rgb_fn { "))" } else { ")" })(blur_radius_output)?;
  let shadow_color_str = shadow_color_str.trim();
  static BLACK: RGBA = RGBA {
    red: 0,
    green: 0,
    blue: 0,
    alpha: 255,
  };
  let shadow_color = if !shadow_color_str.is_empty() {
    let mut parser_input = ParserInput::new(shadow_color_str);
    let mut parser = Parser::new(&mut parser_input);
    let color = Color::parse(&mut parser).unwrap_or_else(|_| Color::RGBA(BLACK));
    if let Color::RGBA(rgba) = color {
      rgba
    } else {
      BLACK
    }
  } else {
    BLACK
  };
  let (mut drop_shadow_output, _) = char(')')(shadow_color_output.trim())?;
  if is_rgb_fn {
    let (trimmed_drop_shadow_output, _) = char(')')(drop_shadow_output)?;
    drop_shadow_output = trimmed_drop_shadow_output;
  }
  Ok((
    drop_shadow_output.trim(),
    CssFilter::DropShadow(offset_x, offset_y, blur_radius, shadow_color),
  ))
}

#[inline(always)]
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
  ))(input)
  {
    input = output;
    filters.push(filter);
  }

  Ok((input, filters))
}

pub(crate) fn css_filters_to_image_filter(filters: Vec<CssFilter>) -> Option<ImageFilter> {
  filters.into_iter().fold(
    Some(ImageFilter(ptr::null_mut())),
    |image_filter, f| match f {
      CssFilter::Blur(blur) => {
        ImageFilter::make_blur(blur, blur, TileMode::Clamp, image_filter.as_ref())
      }
      CssFilter::Brightness(brightness) => {
        let brightness = brightness.max(0.0);
        ImageFilter::make_image_filter(
          brightness,
          0.0,
          0.0,
          0.0,
          brightness,
          0.0,
          0.0,
          0.0,
          brightness,
          1.0,
          image_filter.as_ref(),
        )
      }
      CssFilter::Contrast(contrast) => {
        let amt = contrast.max(0.0);
        let mut ramp = [0u8; 256];
        ramp.iter_mut().take(256).enumerate().for_each(|(i, v)| {
          let orig = i as f32;
          *v = (127.0 + amt * (orig - 127.0)) as u8;
        });
        let ramp = Some(&ramp);
        ImageFilter::from_argb(None, ramp, ramp, ramp, image_filter.as_ref())
      }
      CssFilter::DropShadow(offset_x, offset_y, blur_radius, shadow_color) => {
        let sigma = blur_radius / 2.0;
        if shadow_color.alpha == 0 {
          return None;
        }
        if blur_radius == 0f32 && offset_x == 0f32 && offset_y == 0f32 {
          return None;
        }
        ImageFilter::make_drop_shadow(
          offset_x,
          offset_y,
          sigma,
          sigma,
          (shadow_color.alpha as u32) << 24
            | (shadow_color.red as u32) << 16
            | (shadow_color.green as u32) << 8
            | shadow_color.blue as u32,
          image_filter.as_ref(),
        )
      }
      CssFilter::Grayscale(amt) => {
        let amt = 1.0 - amt.max(0.0).min(1.0);
        ImageFilter::make_image_filter(
          0.2126 + 0.7874 * amt,
          0.7152 - 0.7152 * amt,
          0.0722 - 0.0722 * amt,
          0.2126 - 0.2126 * amt,
          0.7152 + 0.2848 * amt,
          0.0722 - 0.0722 * amt,
          0.2126 - 0.2126 * amt,
          0.7152 - 0.7152 * amt,
          0.0722 + 0.9278 * amt,
          1.0,
          image_filter.as_ref(),
        )
      }
      CssFilter::HueRotate(angle) => {
        let cos = degrees_to_radians(angle).cos();
        let sin = degrees_to_radians(angle).sin();
        ImageFilter::make_image_filter(
          0.213 + cos * 0.787 - sin * 0.213,
          0.715 - cos * 0.715 - sin * 0.715,
          0.072 - cos * 0.072 + sin * 0.928,
          0.213 - cos * 0.213 + sin * 0.143,
          0.715 + cos * 0.285 + sin * 0.140,
          0.072 - cos * 0.072 - sin * 0.283,
          0.213 - cos * 0.213 - sin * 0.787,
          0.715 - cos * 0.715 + sin * 0.715,
          0.072 + cos * 0.928 + sin * 0.072,
          1.0,
          image_filter.as_ref(),
        )
      }
      CssFilter::Invert(amt) => {
        let amt = amt.max(0.0).min(1.0);
        let mut ramp = [0u8; 256];
        ramp
          .iter_mut()
          .take(256)
          .enumerate()
          .map(|(i, v)| (i as f32, v))
          .for_each(|(i, val)| {
            let (orig, inv) = (i, 255.0 - i);
            *val = (orig * (1.0 - amt) + inv * amt) as u8;
          });
        let ramp = Some(&ramp);
        ImageFilter::from_argb(None, ramp, ramp, ramp, image_filter.as_ref())
      }
      CssFilter::Opacity(opacity) => {
        let opacity = opacity.max(0.0).min(1.0);
        ImageFilter::make_image_filter(
          1.0,
          0.0,
          0.0,
          0.0,
          1.0,
          0.0,
          0.0,
          0.0,
          1.0,
          opacity,
          image_filter.as_ref(),
        )
      }
      CssFilter::Saturate(amt) => {
        let amt = amt.max(0.0);
        ImageFilter::make_image_filter(
          0.2126 + 0.7874 * amt,
          0.7152 - 0.7152 * amt,
          0.0722 - 0.0722 * amt,
          0.2126 - 0.2126 * amt,
          0.7152 + 0.2848 * amt,
          0.0722 - 0.0722 * amt,
          0.2126 - 0.2126 * amt,
          0.7152 - 0.7152 * amt,
          0.0722 + 0.9278 * amt,
          1.0,
          image_filter.as_ref(),
        )
      }
      CssFilter::Sepia(amt) => {
        let amt = 1.0 - amt.max(0.0).min(1.0);
        ImageFilter::make_image_filter(
          0.393 + 0.607 * amt,
          0.769 - 0.769 * amt,
          0.189 - 0.189 * amt,
          0.349 - 0.349 * amt,
          0.686 + 0.314 * amt,
          0.168 - 0.168 * amt,
          0.272 - 0.272 * amt,
          0.534 - 0.534 * amt,
          0.131 + 0.869 * amt,
          1.0,
          image_filter.as_ref(),
        )
      }
    },
  )
}

#[test]
fn parse_empty() {
  assert_eq!(css_filter(""), Ok(("", vec![])));
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

#[test]
fn drop_shadow_parse() {
  assert_eq!(
    drop_shadow_parser("drop-shadow(2px 2px)"),
    Ok((
      "",
      CssFilter::DropShadow(2.0f32, 2.0f32, 0.0f32, RGBA::new(0, 0, 0, 255))
    ))
  );
  assert_eq!(
    drop_shadow_parser("drop-shadow(2px 2px 5px)"),
    Ok((
      "",
      CssFilter::DropShadow(2.0f32, 2.0f32, 5.0f32, RGBA::new(0, 0, 0, 255))
    ))
  );

  assert_eq!(
    drop_shadow_parser("drop-shadow(2px 2px 5px #2F14DF)"),
    Ok((
      "",
      CssFilter::DropShadow(2.0f32, 2.0f32, 5.0f32, RGBA::new(47, 20, 223, 255))
    ))
  );

  assert_eq!(
    drop_shadow_parser("drop-shadow(2px 2px 5px rgba(47, 20, 223, 255))"),
    Ok((
      "",
      CssFilter::DropShadow(2.0f32, 2.0f32, 5.0f32, RGBA::new(47, 20, 223, 255))
    ))
  );
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

  assert_eq!(
    css_filter("drop-shadow(2px 2px 5px rgba(47, 20, 223, 255)) brightness(2) blur(1.5rem)"),
    Ok((
      "",
      vec![
        CssFilter::DropShadow(2.0f32, 2.0f32, 5.0f32, RGBA::new(47, 20, 223, 255)),
        CssFilter::Brightness(2.0f32),
        CssFilter::Blur(24.0)
      ]
    ))
  );

  assert_eq!(
    css_filter("brightness(2) drop-shadow(2px 2px 5px rgba(47, 20, 223, 255)) blur(1.5rem)"),
    Ok((
      "",
      vec![
        CssFilter::Brightness(2.0f32),
        CssFilter::DropShadow(2.0f32, 2.0f32, 5.0f32, RGBA::new(47, 20, 223, 255)),
        CssFilter::Blur(24.0)
      ]
    ))
  );

  assert_eq!(
    css_filter("brightness(2) blur(1.5rem) drop-shadow(2px 2px 5px rgba(47, 20, 223, 255))"),
    Ok((
      "",
      vec![
        CssFilter::Brightness(2.0f32),
        CssFilter::Blur(24.0),
        CssFilter::DropShadow(2.0f32, 2.0f32, 5.0f32, RGBA::new(47, 20, 223, 255)),
      ]
    ))
  );
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
