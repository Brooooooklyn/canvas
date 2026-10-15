use std::rc::Rc;
use std::result::Result as StdResult;
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;

use crate::color::{self, Color};
use crate::ctx::zero_size_source_check;
use crate::error::SkError;
use crate::gradient::SharedGradient;
use crate::image::{Image, ImageData};
use crate::page_recorder::next_resource_id;
use crate::sk::{
  AccountedBitmap, Bitmap, ColorSpace, ImagePattern, ImagePatternBacking, ImagePatternShared,
  Surface, TileMode, Transform,
};
use crate::webidl;
use crate::{CanvasElement, SVGCanvas};

/// A float color channel as Chrome's CPU canvas draws it: Skia's Sk4f_toL32,
/// `v * 255 + 0.5` pinned to [0, 255] and truncated (src/core/SkSwizzlePriv.h).
pub(crate) fn srgb_channel_to_u8(v: f32) -> u8 {
  (v * 255.0 + 0.5).clamp(0.0, 255.0) as u8
}

#[derive(Debug)]
pub enum Pattern {
  /// Blink's CanvasStyle color (canvas_style.h): the parsed Color, painted as
  /// a float color and serialized by the getter.
  Color(Color),
  Gradient(SharedGradient),
  Image(ImagePattern),
}

impl Clone for Pattern {
  fn clone(&self) -> Self {
    match self {
      Pattern::Color(c) => Pattern::Color(*c),
      // The same live gradient (save() and restore() keep it).
      Pattern::Gradient(g) => Pattern::Gradient(Rc::clone(g)),
      Pattern::Image(img) => Pattern::Image(img.clone()),
    }
  }
}

impl Default for Pattern {
  fn default() -> Self {
    Self::Color(Color::BLACK)
  }
}

impl Pattern {
  /// A fillStyle or strokeStyle color, as Blink's ParseCanvasColorString reads
  /// it (canvas_style.cc:61-123). An error means the assignment is ignored.
  pub fn from_color(color_str: &str) -> StdResult<Self, SkError> {
    color::parse_canvas_color(color_str, color::Site::Style)
      .map(Pattern::Color)
      .ok_or_else(|| SkError::Generic(format!("Invalid canvas color [{color_str}]")))
  }
}

#[napi]
pub struct CanvasPattern {
  pub(crate) inner: Pattern,
}

impl CanvasPattern {
  /// createPattern() after the argument conversion. Like Chrome
  /// (Canvas2DRecorderContext::createPattern), the repetition is checked
  /// before the image state. `Ok(None)` is a `null` result: an Image with no
  /// src, or one that has not finished loading.
  pub(crate) fn create(
    env: Env,
    input: Either4<&mut Image, &mut ImageData, &mut CanvasElement<'_>, &mut SVGCanvas<'_>>,
    repetition: &str,
    default_object_size: (f32, f32),
  ) -> Result<Option<Self>> {
    // ToCanvasImageSource comes first: a canvas source with a 0 side throws.
    let source_size = match &input {
      Either4::C(canvas) => Some((canvas.width, canvas.height)),
      Either4::D(svg) => Some((svg.width, svg.height)),
      _ => None,
    };
    zero_size_source_check(&env, source_size, webidl::CREATE_PATTERN)?;
    // CanvasPattern::ParseRepetitionType: case-sensitive, '' is 'repeat'.
    let (repeat_x, repeat_y) = match repetition {
      "" | "repeat" => (TileMode::Repeat, TileMode::Repeat),
      "repeat-x" => (TileMode::Repeat, TileMode::Decal),
      "repeat-y" => (TileMode::Decal, TileMode::Repeat),
      "no-repeat" => (TileMode::Decal, TileMode::Decal),
      _ => {
        return Err(webidl::dom_exception(
          env.raw(),
          "SyntaxError",
          &format!(
            "{}The provided type ('{repetition}') is not one of 'repeat', 'no-repeat', 'repeat-x', or 'repeat-y'.",
            webidl::CREATE_PATTERN
          ),
        ));
      }
    };
    // The returned `ImagePattern` keeps shared ownership of the backing pixels
    // (`backing`), so clones pushed onto the `save()`/`restore()` state stack
    // stay valid after the JS `CanvasPattern` is garbage-collected.
    // https://github.com/Brooooooklyn/canvas/issues/1341
    //
    // `is_canvas` picks the canvas sampling rule (PatternSamplingOptions in
    // skia_c.cpp). Chrome has no ImageData pattern; its analog, a pattern over
    // createImageBitmap(imageData), samples like a canvas source.
    //
    // A raster Image goes through Chrome's decode cache; an SVG Image is drawn
    // as vectors there, so its raster is sampled as it is.
    let is_image = matches!(&input, Either4::A(image) if !image.is_svg());
    let (backing_bytes, backing, accounting_id, is_canvas) = match input {
      Either4::A(image) => {
        // Chrome checks ImageComplete() first (image_element_base.cc:59): a
        // new src that is still loading gives null, even while the old
        // picture is still held.
        if !image.complete {
          return Ok(None);
        }
        if let Some(svg) = image.svg.as_mut() {
          // The tile is the image at its concrete size against the canvas
          // size; null when that rounds to empty (kZeroSizeImageSourceStatus).
          let Some(raster) = svg.pattern_raster(&env, default_object_size)? else {
            return Ok(None);
          };
          match raster {
            Some(raster) => (
              raster.inner.0.width as usize * raster.inner.0.height as usize * 4,
              ImagePatternBacking::Bitmap(raster.clone()),
              raster.resource_id,
              false,
            ),
            // Too large to raster: it paints nothing.
            None => transparent_backing(image.color_space)?,
          }
        } else {
          let Some(bitmap) = image.bitmap.as_ref() else {
            if image.broken {
              return Err(webidl::dom_exception(
                env.raw(),
                "InvalidStateError",
                &format!(
                  "{}Source image is in the 'broken' state.",
                  webidl::CREATE_PATTERN
                ),
              ));
            }
            return Ok(None);
          };
          (
            bitmap.inner.0.width as usize * bitmap.inner.0.height as usize * 4,
            ImagePatternBacking::Bitmap(bitmap.clone()),
            // The Arc is cloned from the Image: the backing identity is the
            // bitmap's own resource_id, so N patterns over one Image charge
            // once per recording window instead of per wrapper.
            bitmap.resource_id,
            false,
          )
        }
      }
      Either4::B(image_data) => {
        let data = image_data.resolve_pixels(&env)?;
        let image_data_size =
          image_data.width * image_data.height * image_data.pixel_format.bytes_per_pixel();
        // Premultiplied like a canvas or an ImageBitmap, so filtering never
        // pulls transparent black into the color. Drawn from its own color
        // space, as putImageData draws it, and kept in its own colour type.
        let bitmap = Bitmap::premul_from_image_data(
          data,
          image_data.width,
          image_data.height,
          image_data.color_space,
          image_data.pixel_format,
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
        // Only this pattern holds the copy and nothing writes to it again, so
        // the image made at the first paint shares it instead of copying it a
        // second time.
        bitmap.set_immutable();
        (
          image_data_size,
          ImagePatternBacking::Bitmap(Arc::new(AccountedBitmap::new(
            bitmap,
            env.raw(),
            image_data_size as i64,
          ))),
          // Per-pattern pixel copy: fresh identity.
          next_resource_id(),
          true,
        )
      }
      // A canvas source without pixels gives an empty image, which paints
      // transparent black (Canvas2DRecorderContext::createPattern,
      // kInvalidSourceImageStatus): a transparent 1x1 surface here.
      Either4::C(canvas) if !canvas.ctx.context.has_pixels() => {
        transparent_backing(canvas.ctx.context.color_space)?
      }
      Either4::D(svg_canvas) if !svg_canvas.ctx.context.has_pixels() => {
        transparent_backing(svg_canvas.ctx.context.color_space)?
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
        // The clone keeps the source's colour type: 8 bytes a pixel for
        // float16.
        let backing_bytes = cloned_surface.width() as usize
          * cloned_surface.height() as usize
          * canvas.ctx.context.pixel_format.bytes_per_pixel();
        (
          backing_bytes,
          ImagePatternBacking::Surface(cloned_surface.reference()),
          // Per-pattern surface clone: fresh identity.
          next_resource_id(),
          true,
        )
      }
      Either4::D(svg_canvas) => {
        // Draw what the SVG canvas recorded into its raster surface.
        svg_canvas.ctx.context.flush();
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
        let backing_bytes = cloned_surface.width() as usize
          * cloned_surface.height() as usize
          * svg_canvas.ctx.context.pixel_format.bytes_per_pixel();
        (
          backing_bytes,
          ImagePatternBacking::Surface(cloned_surface.reference()),
          // Per-pattern surface clone: fresh identity.
          next_resource_id(),
          true,
        )
      }
    };
    Ok(Some(Self {
      inner: Pattern::Image(ImagePattern {
        accounting_id,
        repeat_x,
        repeat_y,
        is_canvas,
        is_image,
        backing_bytes,
        backing: Some(backing),
        shared: Arc::new(Mutex::new(ImagePatternShared {
          transform: Transform::default(),
          image: None,
          shader: None,
        })),
      }),
    }))
  }
}

/// The backing of a pattern over a canvas without pixels: one transparent
/// pixel, as `create` returns it for a canvas source.
fn transparent_backing(color_space: ColorSpace) -> Result<(usize, ImagePatternBacking, u64, bool)> {
  let mut surface = Surface::new_rgba_premultiplied(1, 1, color_space, Default::default())
    .ok_or_else(|| {
      Error::new(
        Status::GenericFailure,
        "Failed to create pattern surface".to_owned(),
      )
    })?;
  surface.canvas.clear();
  Ok((
    4,
    ImagePatternBacking::Surface(surface.reference()),
    next_resource_id(),
    true,
  ))
}

#[napi]
impl CanvasPattern {
  #[napi(constructor)]
  pub fn new(
    env: Env,
    input: Either4<&mut Image, &mut ImageData, &mut CanvasElement, &mut SVGCanvas>,
    repetition: Option<String>,
  ) -> Result<Self> {
    // No canvas: an SVG Image takes the default canvas size, 300x150.
    Self::create(
      env,
      input,
      repetition.as_deref().unwrap_or("repeat"),
      (300.0, 150.0),
    )?
    .ok_or_else(|| Error::new(Status::InvalidArg, "Image is not completed.".to_owned()))
  }

  /// setTransform(optional DOMMatrix2DInit transform = {}).
  #[napi]
  pub fn set_transform(&mut self, transform: webidl::PatternTransform) -> Result<()> {
    let [a, b, c, d, e, f] = transform.0;
    if let Pattern::Image(image) = &mut self.inner {
      // Clones already assigned to fill/stroke styles (and the save/restore
      // stack) share this state, so the new matrix takes effect at paint time
      // per https://html.spec.whatwg.org/#dom-canvaspattern-settransform
      let mut shared = image.shared.lock().unwrap();
      shared.transform = Transform::new(a as f32, b as f32, c as f32, d as f32, e as f32, f as f32);
      shared.shader = None;
    }
    Ok(())
  }
}
