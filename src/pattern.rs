use std::result::Result as StdResult;

use cssparser::{Color as CSSColor, Parser, ParserInput, RGBA};
use napi::bindgen_prelude::*;

use crate::ctx::TransformObject;
use crate::error::SkError;
use crate::gradient::Gradient;
use crate::image::{Image, ImageData};
use crate::sk::{AlphaType, Bitmap, ColorType, ImagePattern, TileMode, Transform};
use crate::{CanvasElement, SVGCanvas};

#[derive(Debug, Clone)]
pub enum Pattern {
  #[allow(dead_code)]
  Color(RGBA, String),
  Gradient(Gradient),
  Image(ImagePattern),
}

impl Default for Pattern {
  fn default() -> Self {
    Self::Color(RGBA::new(0, 0, 0, 255), "#000".to_owned())
  }
}

impl Pattern {
  pub fn from_color(color_str: &str) -> StdResult<Self, SkError> {
    let mut parser_input = ParserInput::new(color_str);
    let mut parser = Parser::new(&mut parser_input);
    let color = CSSColor::parse(&mut parser)
      .map_err(|e| SkError::Generic(format!("Parse color [{color_str}] error: {e:?}")))?;
    match color {
      CSSColor::CurrentColor => Err(SkError::Generic(
        "Color should not be `currentcolor` keyword".to_owned(),
      )),
      CSSColor::RGBA(rgba) => Ok(Pattern::Color(rgba, color_str.to_owned())),
    }
  }
}

#[napi]
pub struct CanvasPattern {
  pub(crate) inner: Pattern,
  #[allow(unused)]
  // hold it for Drop
  bitmap: Option<Bitmap>,
}

#[napi]
impl CanvasPattern {
  #[napi(constructor)]
  pub fn new(
    input: Either4<&mut Image, &mut ImageData, &mut CanvasElement, &mut SVGCanvas>,
    repetition: Option<String>,
  ) -> Result<Self> {
    let mut inner_bitmap = None;
    let mut is_canvas = false;
    let bitmap = match input {
      Either4::A(image) => image
        .bitmap
        .as_mut()
        .map(|b| b.0.bitmap)
        .ok_or_else(|| Error::new(Status::InvalidArg, "Image is not completed.".to_owned()))?,
      Either4::B(image_data) => {
        let image_data_size = image_data.width * image_data.height * 4;
        let bitmap = Bitmap::from_image_data(
          image_data.data,
          image_data.width,
          image_data.height,
          image_data.width * 4,
          image_data_size,
          ColorType::RGBA8888,
          AlphaType::Unpremultiplied,
        );
        let ptr = bitmap.0.bitmap;
        inner_bitmap = Some(bitmap);
        ptr
      }
      Either4::C(canvas) => {
        let canvas_bitmap = canvas.ctx.context.surface.get_bitmap();
        let ptr = canvas_bitmap.0.bitmap;
        inner_bitmap = Some(canvas_bitmap);
        is_canvas = true;
        ptr
      }
      Either4::D(svg_canvas) => {
        let canvas_bitmap = svg_canvas.ctx.context.surface.get_bitmap();
        let ptr = canvas_bitmap.0.bitmap;
        inner_bitmap = Some(canvas_bitmap);
        is_canvas = true;
        ptr
      }
    };
    let (repeat_x, repeat_y) = match repetition {
      None => (TileMode::Repeat, TileMode::Repeat),
      Some(repetition) => match repetition.as_str() {
        "" | "repeat" => (TileMode::Repeat, TileMode::Repeat),
        "repeat-x" => (TileMode::Repeat, TileMode::Decal),
        "repeat-y" => (TileMode::Decal, TileMode::Repeat),
        "no-repeat" => (TileMode::Decal, TileMode::Decal),
        _ => {
          return Err(Error::new(
            Status::InvalidArg,
            format!("{repetition} is not valid repetition rule"),
          ))
        }
      },
    };
    Ok(Self {
      inner: Pattern::Image(ImagePattern {
        transform: Transform::default(),
        bitmap,
        repeat_x,
        repeat_y,
        is_canvas,
      }),
      bitmap: inner_bitmap,
    })
  }

  #[napi]
  pub fn set_transform(&mut self, transform: TransformObject) {
    if let Pattern::Image(image) = &mut self.inner {
      image.transform = transform.into();
    }
  }
}
