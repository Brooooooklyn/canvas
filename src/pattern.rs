use std::result::Result as StdResult;
use std::sync::{Arc, Mutex};

use cssparser::Parser;
use cssparser_color::{Color as CSSColor, hsl_to_rgb};
use napi::bindgen_prelude::*;
use rgb::RGBA;

use crate::ctx::TransformObject;
use crate::error::SkError;
use crate::gradient::Gradient;
use crate::image::{Image, ImageData};
use crate::sk::{
  AccountedBitmap, AlphaType, Bitmap, ColorType, ImagePattern, ImagePatternBacking,
  ImagePatternShared, TileMode, Transform,
};
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
    Self::Color(RGBA::new(0, 0, 0, 255), "#000000".to_owned())
  }
}

impl Pattern {
  pub fn from_color(color_str: &str) -> StdResult<Self, SkError> {
    let mut parser = Parser::new(color_str);
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
}

#[napi]
impl CanvasPattern {
  #[napi(constructor)]
  pub fn new(
    env: Env,
    input: Either4<&mut Image, &mut ImageData, &mut CanvasElement, &mut SVGCanvas>,
    repetition: Option<String>,
  ) -> Result<Self> {
    // The returned `ImagePattern` keeps shared ownership of the backing pixels
    // (`backing`), so clones pushed onto the `save()`/`restore()` state stack
    // stay valid after the JS `CanvasPattern` is garbage-collected.
    // https://github.com/Brooooooklyn/canvas/issues/1341
    let (bitmap, backing) = match input {
      Either4::A(image) => {
        let bitmap = image
          .bitmap
          .as_ref()
          .ok_or_else(|| Error::new(Status::InvalidArg, "Image is not completed.".to_owned()))?;
        (
          bitmap.inner.0.bitmap,
          ImagePatternBacking::Bitmap(bitmap.clone()),
        )
      }
      Either4::B(image_data) => {
        let data = image_data.resolve_pixels(&env)?;
        let image_data_size = image_data.width * image_data.height * 4;
        let bitmap = Bitmap::from_image_data(
          data,
          image_data.width,
          image_data.height,
          image_data.width * 4,
          image_data_size,
          ColorType::RGBA8888,
          AlphaType::Unpremultiplied,
        )
        .ok_or_else(|| {
          Error::new(
            Status::GenericFailure,
            "Failed to copy image data".to_owned(),
          )
        })?;
        // The bitmap now owns a copy of the pixels: report it to V8 for as
        // long as the last owner holds it.
        env.adjust_external_memory(image_data_size as i64)?;
        let ptr = bitmap.0.bitmap;
        (
          ptr,
          ImagePatternBacking::Bitmap(Arc::new(AccountedBitmap::new(
            bitmap,
            env.raw(),
            image_data_size as i64,
          ))),
        )
      }
      Either4::C(canvas) => {
        // Flush deferred rendering before accessing the surface
        canvas.ctx.context.flush();
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
        // Get the surface pointer, and hold a ref-counted reference so the
        // pixels stay alive after this `Surface` wrapper is dropped
        let ptr = cloned_surface.get_bitmap_ptr();
        (
          ptr,
          ImagePatternBacking::Surface(cloned_surface.reference()),
        )
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
        // Get the surface pointer, and hold a ref-counted reference so the
        // pixels stay alive after this `Surface` wrapper is dropped
        let ptr = cloned_surface.get_bitmap_ptr();
        (
          ptr,
          ImagePatternBacking::Surface(cloned_surface.reference()),
        )
      }
    };
    let is_canvas = matches!(backing, ImagePatternBacking::Surface(_));
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
        bitmap,
        repeat_x,
        repeat_y,
        is_canvas,
        backing: Some(backing),
        shared: Arc::new(Mutex::new(ImagePatternShared {
          transform: Transform::default(),
          shader: None,
        })),
      }),
    })
  }

  #[napi]
  pub fn set_transform(&mut self, transform: TransformObject) {
    if let Pattern::Image(image) = &mut self.inner {
      // Clones already assigned to fill/stroke styles (and the save/restore
      // stack) share this state, so the new matrix takes effect at paint time
      // per https://html.spec.whatwg.org/#dom-canvaspattern-settransform
      let mut shared = image.shared.lock().unwrap();
      shared.transform = transform.into();
      shared.shader = None;
    }
  }
}
