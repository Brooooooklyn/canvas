use std::result::Result as StdResult;
use std::sync::{Arc, OnceLock};

use cssparser::{Parser, ParserInput};
use cssparser_color::{Color as CSSColor, hsl_to_rgb};
use napi::bindgen_prelude::*;
use rgb::RGBA;

use crate::ctx::TransformObject;
use crate::error::SkError;
use crate::gradient::Gradient;
use crate::image::{Image, ImageData};
use crate::sk::{AlphaType, Bitmap, ColorType, ImagePattern, Surface, TileMode, Transform};
use crate::{CanvasElement, SVGCanvas};

#[derive(Debug)]
pub enum Pattern {
  #[allow(dead_code)]
  Color(RGBA<u8>, String),
  Gradient(Gradient),
  Image(ImagePattern),
}

impl Clone for Pattern {
  fn clone(&self) -> Self {
    match self {
      Pattern::Color(rgba, s) => Pattern::Color(*rgba, s.clone()),
      Pattern::Gradient(g) => Pattern::Gradient(g.clone()),
      Pattern::Image(img) => Pattern::Image(img.clone()),
    }
  }
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
      CSSColor::Rgba(rgba) => Ok(Pattern::Color(
        RGBA {
          r: rgba.red,
          g: rgba.green,
          b: rgba.blue,
          a: (rgba.alpha * 255.0) as u8,
        },
        color_str.to_owned(),
      )),
      CSSColor::Hsl(hsl) => {
        let h = hsl.hue.unwrap_or(0.0) / 360.0;
        let s = hsl.saturation.unwrap_or(0.0);
        let l = hsl.lightness.unwrap_or(0.0);
        let a = hsl.alpha.unwrap_or(1.0);

        let (r, g, b) = hsl_to_rgb(h, s, l);

        Ok(Pattern::Color(
          RGBA {
            r: (r * 255.0) as u8,
            g: (g * 255.0) as u8,
            b: (b * 255.0) as u8,
            a: (a * 255.0) as u8,
          },
          color_str.to_owned(),
        ))
      }
      _ => Err(SkError::Generic("Unsupported color format".to_owned())),
    }
  }
}

#[napi]
pub struct CanvasPattern {
  pub(crate) inner: Pattern,
  #[allow(unused)]
  // hold it for Drop
  bitmap: Option<Arc<Bitmap>>,
  #[allow(unused)]
  // hold cloned surface for Drop
  surface: Option<Surface>,
}

#[napi]
impl CanvasPattern {
  #[napi(constructor)]
  pub fn new(
    input: Either4<&mut Image, &mut ImageData, &mut CanvasElement, &mut SVGCanvas>,
    repetition: Option<String>,
  ) -> Result<Self> {
    let mut inner_bitmap = None;
    let mut inner_surface = None;
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
        inner_bitmap = Some(Arc::new(bitmap));
        ptr
      }
      Either4::C(canvas) => {
        // Clone the surface to capture its current state and prevent segfaults
        // when the original canvas is resized or destroyed
        let cloned_surface = canvas
          .ctx
          .context
          .surface
          .try_clone(canvas.ctx.context.color_space)
          .ok_or_else(|| {
            Error::new(
              Status::GenericFailure,
              "Failed to clone canvas surface".to_owned(),
            )
          })?;
        // Get the bitmap pointer from the cloned surface
        let ptr = cloned_surface.get_bitmap_ptr();
        // Store the cloned surface to keep it alive
        inner_surface = Some(cloned_surface);
        is_canvas = true; // Keep as true since it's a surface pointer
        ptr
      }
      Either4::D(svg_canvas) => {
        // Clone the surface to capture its current state and prevent segfaults
        // when the original canvas is resized or destroyed
        let cloned_surface = svg_canvas
          .ctx
          .context
          .surface
          .try_clone(svg_canvas.ctx.context.color_space)
          .ok_or_else(|| {
            Error::new(
              Status::GenericFailure,
              "Failed to clone SVG canvas surface".to_owned(),
            )
          })?;
        // Get the bitmap pointer from the cloned surface
        let ptr = cloned_surface.get_bitmap_ptr();
        // Store the cloned surface to keep it alive
        inner_surface = Some(cloned_surface);
        is_canvas = true; // Keep as true since it's a surface pointer
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
          ));
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
        shader_cache: OnceLock::new(),
      }),
      bitmap: inner_bitmap,
      surface: inner_surface,
    })
  }

  #[napi]
  pub fn set_transform(&mut self, transform: TransformObject) {
    if let Pattern::Image(image) = &mut self.inner {
      image.transform = transform.into();
    }
  }
}
