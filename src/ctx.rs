use std::cell::RefCell;
use std::f32::consts::PI;
use std::mem;
use std::result;
use std::slice;
use std::str::FromStr;
use std::sync::LazyLock;

use cssparser::{Parser, ParserInput};
use cssparser_color::{Color as CSSColor, hsl_to_rgb};
use libavif::AvifData;
use napi::{JsString, bindgen_prelude::*};
use regex::Regex;
use rgb::RGBA;

use crate::font::FONT_MEDIUM_PX;
use crate::font::parse_size_px;
use crate::gif::GifConfig;
use crate::global_fonts::get_font;
use crate::page_recorder::PageRecorder;
use crate::picture_recorder::PictureRecorder;
use crate::sk::Canvas;
use crate::{
  CanvasElement, SVGCanvas,
  avif::Config,
  error::SkError,
  filter::css_filter,
  filter::css_filters_to_image_filter,
  font::Font,
  gradient::{CanvasGradient, Gradient},
  image::*,
  path::Path,
  pattern::{CanvasPattern, Pattern},
  sk::{
    AlphaType, Bitmap, BlendMode, ColorSpace, FillType, FontVariantCaps, ImageFilter, LineMetrics,
    Matrix, Paint, PaintStyle, Path as SkPath, PathEffect, PathOp, SkEncodedImageFormat,
    SkWMemoryStream, SkiaDataRef, Surface, SurfaceRef, Transform,
  },
  state::Context2dRenderingState,
};

static CSS_SIZE_REGEXP: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r#"(-?[\d\.]+)(%|px|pt|pc|in|cm|mm|%|em|ex|ch|rem|q)?\s*"#).unwrap());

impl From<SkError> for Error {
  fn from(err: SkError) -> Error {
    Error::new(Status::InvalidArg, format!("{err}"))
  }
}

pub(crate) const MAX_TEXT_WIDTH: f32 = 100_000.0;
pub(crate) const FILL_STYLE_HIDDEN_NAME: &str = "_fillStyle";
pub(crate) const STROKE_STYLE_HIDDEN_NAME: &str = "_strokeStyle";

// The shadow half of a draw: the paint built by `shadow_paint`, plus the state
// `render_canvas` needs to size the shadow layer's cull rect.
struct ShadowPass<'a> {
  paint: &'a Paint,
  offset_x: f32,
  offset_y: f32,
  blur: f32,
}

pub struct Context {
  pub(crate) surface: Surface,
  pub(crate) page_recorder: Option<RefCell<PageRecorder>>, // Deferred rendering recorder (RefCell for interior mutability)
  path: SkPath,
  pub alpha: bool,
  pub(crate) states: Vec<Context2dRenderingState>,
  state: Context2dRenderingState,
  pub width: u32,
  pub height: u32,
  pub color_space: ColorSpace,
  pub stream: Option<SkWMemoryStream>,
}

impl Context {
  pub fn new_svg(
    width: u32,
    height: u32,
    svg_export_flag: crate::sk::SvgExportFlag,
    color_space: ColorSpace,
  ) -> Result<Self> {
    let (surface, stream) = Surface::new_svg(
      width,
      height,
      AlphaType::Premultiplied,
      svg_export_flag,
      color_space,
    )
    .ok_or_else(|| Error::from_reason("Create skia svg surface failed".to_owned()))?;
    Ok(Context {
      surface,
      page_recorder: None, // SVG uses direct rendering
      alpha: true,
      path: SkPath::new(),
      states: vec![],
      state: Context2dRenderingState::default(),
      width,
      height,
      color_space,
      stream: Some(stream),
    })
  }

  pub fn new(width: u32, height: u32, color_space: ColorSpace) -> Result<Self> {
    let surface = Surface::new_rgba_premultiplied(width, height, color_space)
      .ok_or_else(|| Error::from_reason("Create skia surface failed".to_owned()))?;
    Ok(Context {
      surface,
      page_recorder: Some(RefCell::new(PageRecorder::new(width as f32, height as f32))), // Enable deferred rendering
      alpha: true,
      path: SkPath::new(),
      states: vec![],
      state: Context2dRenderingState::default(),
      width,
      height,
      color_space,
      stream: None,
    })
  }

  // Create a Context from an existing Surface (e.g., from PDFDocument)
  pub(crate) fn new_from_surface(surface: Surface, width: u32, height: u32) -> Self {
    Context {
      surface,
      page_recorder: None, // PDF uses direct rendering
      alpha: true,
      path: SkPath::new(),
      states: vec![],
      state: Context2dRenderingState::default(),
      width,
      height,
      color_space: ColorSpace::default(),
      stream: None,
    }
  }

  /// Flush deferred rendering to surface (if deferred mode is enabled)
  pub fn flush(&mut self) {
    if let Some(ref recorder) = self.page_recorder {
      let mut rec = recorder.borrow_mut();
      rec.playback_to(&mut self.surface.canvas);
      // Consolidate accumulated layers into a single snapshot-based picture
      // to prevent unbounded memory growth when canvas is repeatedly drawn
      // via drawImage() (see: https://github.com/Brooooooklyn/canvas/issues/1221)
      if rec.should_consolidate()
        && let Some(snapshot) = self.surface.make_image_snapshot()
      {
        rec.consolidate_with_snapshot(snapshot);
      }
    }
  }

  /// Execute a canvas state operation on the appropriate canvas (recording or direct)
  /// For deferred mode, operations are recorded to the PageRecorder
  /// For direct mode (SVG, PDF), operations go directly to the surface
  fn with_canvas_state<F>(&mut self, f: F)
  where
    F: FnOnce(&mut Canvas),
  {
    if let Some(ref recorder) = self.page_recorder {
      let mut rec = recorder.borrow_mut();
      if let Some(canvas) = rec.get_recording_canvas() {
        f(canvas);
        return;
      }
    }
    // Direct mode - use surface canvas
    f(&mut self.surface.canvas);
  }

  /// Sync transform state to PageRecorder for restoration after layer promotion
  fn sync_transform_to_recorder(&self) {
    if let Some(ref recorder) = self.page_recorder {
      recorder.borrow_mut().set_transform(&self.state.transform);
    }
  }

  /// Sync clip state to PageRecorder for restoration after layer promotion
  fn sync_clip_to_recorder(&self) {
    if let Some(ref recorder) = self.page_recorder {
      recorder.borrow_mut().set_clip(self.state.clip_path.clone());
    }
  }

  /// Execute a rendering operation on the appropriate canvas (recording or direct)
  /// For deferred mode, operations are recorded to the PageRecorder
  /// For direct mode (SVG, PDF), operations go directly to the surface
  fn with_render_canvas<F>(&mut self, paint: &Paint, f: F) -> result::Result<(), SkError>
  where
    F: Fn(&mut Canvas, &Paint) -> result::Result<(), SkError>,
  {
    self.with_shadowed_render_canvas(paint, None, |_, _, _| Ok(()), f)
  }

  /// Same, for the draws that also have a shadow pass. The two passes must be
  /// handed to `render_canvas` together so that it -- and only it -- decides
  /// whether an isolation layer is needed; see the comment there.
  ///
  /// The shadow closure is handed the user->DEVICE matrix as its third argument
  /// because it cannot read one off the canvas it is given: on the isolation arm
  /// that canvas is a picture recorder sitting at identity. Pass it straight to
  /// `apply_shadow_offset_matrix_to_canvas`.
  fn with_shadowed_render_canvas<S, F>(
    &mut self,
    paint: &Paint,
    shadow_paint: Option<&Paint>,
    shadow_f: S,
    f: F,
  ) -> result::Result<(), SkError>
  where
    S: Fn(&mut Canvas, &Paint, &Matrix) -> result::Result<(), SkError>,
    F: Fn(&mut Canvas, &Paint) -> result::Result<(), SkError>,
  {
    let blend_mode = self.state.global_composite_operation;
    let width = self.width as f32;
    let height = self.height as f32;
    let shadow = shadow_paint.map(|paint| ShadowPass {
      paint,
      offset_x: self.state.shadow_offset_x,
      offset_y: self.state.shadow_offset_y,
      blur: self.state.shadow_blur,
    });

    if let Some(ref recorder) = self.page_recorder {
      let mut rec = recorder.borrow_mut();
      if let Some(canvas) = rec.get_recording_canvas() {
        // Use the recording canvas for deferred mode
        return Self::render_canvas(
          canvas, paint, blend_mode, width, height, shadow, shadow_f, f,
        );
      }
    }
    // Direct mode - use surface canvas
    Self::render_canvas(
      &mut self.surface.canvas,
      paint,
      blend_mode,
      width,
      height,
      shadow,
      shadow_f,
      f,
    )
  }

  pub fn arc(
    &mut self,
    center_x: f32,
    center_y: f32,
    radius: f32,
    start_angle: f32,
    end_angle: f32,
    from_end: bool,
  ) {
    self
      .path
      .arc(center_x, center_y, radius, start_angle, end_angle, from_end);
  }

  pub fn arc_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, radius: f32) {
    self.path.arc_to_tangent(x1, y1, x2, y2, radius);
  }

  pub fn ellipse(
    &mut self,
    x: f32,
    y: f32,
    radius_x: f32,
    radius_y: f32,
    rotation: f32,
    start_angle: f32,
    end_angle: f32,
    ccw: bool,
  ) {
    self.path.ellipse(
      x,
      y,
      radius_x,
      radius_y,
      rotation,
      start_angle,
      end_angle,
      ccw,
    );
  }

  pub fn begin_path(&mut self) {
    let new_sub_path = SkPath::new();
    self.path.swap(&new_sub_path);
  }

  pub fn bezier_curve_to(&mut self, cp1x: f32, cp1y: f32, cp2x: f32, cp2y: f32, x: f32, y: f32) {
    self.path.cubic_to(cp1x, cp1y, cp2x, cp2y, x, y);
  }

  pub fn quadratic_curve_to(&mut self, cpx: f32, cpy: f32, x: f32, y: f32) {
    self.path.quad_to(cpx, cpy, x, y);
  }

  pub fn clip(&mut self, path: Option<&mut SkPath>, fill_rule: FillType) {
    let clip_path = match path {
      Some(p) => {
        p.set_fill_type(fill_rule);
        p.clone()
      }
      None => {
        self.path.set_fill_type(fill_rule);
        self.path.clone()
      }
    };

    // For state tracking (used by save/restore and layer promotion), compute the
    // cumulative clip in device space. Transform the new path by the current CTM
    // and intersect with the existing device-space clip.
    let mut device_clip = clip_path.clone();
    device_clip.transform_self(&self.state.transform);

    if let Some(ref existing_clip) = self.state.clip_path
      && !device_clip.op(existing_clip, PathOp::Intersect)
    {
      #[cfg(debug_assertions)]
      eprintln!("Warning: Path intersection operation failed in clip()");
      // op() failed (degenerate paths). Skip both Skia and state update
      // to avoid divergence between tracked state and actual canvas clip.
      return;
    }

    // Pass the raw path to Skia. Skia's clipPath() is cumulative and applies the
    // current canvas CTM, so it correctly handles nested clips at different transforms.
    self.with_canvas_state(|canvas| {
      canvas.set_clip_path(&clip_path);
    });

    self.state.clip_path = Some(device_clip);
    self.sync_clip_to_recorder();
  }

  pub fn clear_rect(
    &mut self,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
  ) -> result::Result<(), SkError> {
    // Optimization: If clearing the entire canvas with identity transform, reset the page recorder
    // This prevents memory growth in game loops that clear each frame
    // Only apply optimization if:
    // - Transform is identity - otherwise the clear might not cover everything
    // - No clip path - otherwise the clear is masked
    // - No pending save/restore states - otherwise resetting would break the save stack
    if x <= 0.0
      && y <= 0.0
      && (x + width) >= self.width as f32
      && (y + height) >= self.height as f32
      && self.page_recorder.is_some()
      && self.state.transform.get_transform().is_identity()
      && self.state.clip_path.is_none()
      && self.states.is_empty()
    {
      // Full canvas clear - reset layers instead of accumulating
      if let Some(ref recorder) = self.page_recorder {
        recorder
          .borrow_mut()
          .reset(self.width as f32, self.height as f32);
      }
      // Also clear the main surface
      self.surface.canvas.clear();
      return Ok(());
    }

    // Partial clear - record as a clear operation
    let mut paint = Paint::new();
    paint.set_style(PaintStyle::Fill);
    paint.set_color(0, 0, 0, 0);
    paint.set_stroke_miter(10.0);
    paint.set_blend_mode(BlendMode::Clear);
    self.with_render_canvas(&paint, |canvas, paint| {
      canvas.draw_rect(x, y, width, height, paint);
      Ok(())
    })?;
    Ok(())
  }

  pub fn close_path(&mut self) {
    self.path.close();
  }

  pub fn rect(&mut self, x: f32, y: f32, width: f32, height: f32) {
    self.path.add_rect(x, y, width, height);
  }

  pub fn round_rect(&mut self, x: f32, y: f32, width: f32, height: f32, radii: [f32; 4]) {
    self.path.round_rect(x, y, width, height, radii);
  }

  pub fn save(&mut self) {
    self.with_canvas_state(|canvas| {
      canvas.save();
    });
    self.states.push(self.state.clone());
    // Sync state to recorder at save time for layer promotion restoration
    self.sync_transform_to_recorder();
    self.sync_clip_to_recorder();
    // Track save count for layer promotion restoration
    if let Some(ref recorder) = self.page_recorder {
      recorder.borrow_mut().increment_save();
    }
  }

  pub fn restore(&mut self) {
    if let Some(s) = self.states.pop() {
      self.path.transform_self(&self.state.transform);
      self.with_canvas_state(|canvas| {
        canvas.restore();
      });
      if let Some(inverse) = s.transform.invert() {
        self.path.transform_self(&inverse);
      }
      self.state = s;

      // In deferred mode, explicitly restore canvas transform and clip.
      // This is needed because layer promotion recreates the save stack with
      // identity transform/no clip at save time, so canvas.restore() may not
      // restore the correct state.
      if self.page_recorder.is_some() {
        let transform = self.state.transform.clone();
        let clip = self.state.clip_path.clone();
        // Re-apply clip if the restored state has one.
        // The clip is stored in device space, so apply at identity transform first.
        if let Some(ref clip_path) = clip {
          self.with_canvas_state(|canvas| {
            canvas.reset_transform();
            canvas.set_clip_path(clip_path);
          });
        }
        // Then restore the actual transform
        self.with_canvas_state(|canvas| {
          canvas.set_transform(&transform);
        });
      }

      self.sync_transform_to_recorder();
      self.sync_clip_to_recorder();
      // Track save count for layer promotion restoration
      if let Some(ref recorder) = self.page_recorder {
        recorder.borrow_mut().decrement_save();
      }
    }
  }

  pub fn reset(&mut self) {
    // Clear the backing buffer to transparent black and reset canvas state
    self.with_canvas_state(|canvas| {
      canvas.clear();
      canvas.reset();
    });

    // Reset the page recorder if in deferred mode
    if let Some(ref recorder) = self.page_recorder {
      recorder
        .borrow_mut()
        .reset(self.width as f32, self.height as f32);
      // Also clear main surface which accumulates content from flush() calls
      self.surface.canvas.clear();
    }

    // Clear the current path
    self.path = SkPath::new();

    // Clear the drawing state stack
    self.states.clear();

    // Reset all styles to default
    self.state = Context2dRenderingState::default();
  }

  pub fn stroke_rect(&mut self, x: f32, y: f32, w: f32, h: f32) -> result::Result<(), SkError> {
    let stroke_paint = self.stroke_paint()?;

    // Extract state for shadow rendering to avoid borrow conflicts
    let shadow_paint = Self::shadow_paint(&self.state, &stroke_paint);
    let shadow_offset_x = self.state.shadow_offset_x;
    let shadow_offset_y = self.state.shadow_offset_y;

    self.with_shadowed_render_canvas(
      &stroke_paint,
      shadow_paint.as_ref(),
      |shadow_canvas, shadow_paint, device_ctm| {
        shadow_canvas.save();
        Self::apply_shadow_offset_matrix_to_canvas(
          shadow_canvas,
          device_ctm,
          shadow_offset_x,
          shadow_offset_y,
        )?;
        shadow_canvas.draw_rect(x, y, w, h, shadow_paint);
        shadow_canvas.restore();
        Ok(())
      },
      |canvas, paint| {
        canvas.draw_rect(x, y, w, h, paint);
        Ok(())
      },
    )?;
    Ok(())
  }

  pub fn translate(&mut self, x: f32, y: f32) {
    let inverse = Matrix::translated(-x, -y);
    self.path.transform_self(&inverse);
    self.state.transform.pre_translate(x, y);
    let transform = self.state.transform.clone();
    self.with_canvas_state(|canvas| {
      canvas.set_transform(&transform);
    });
    self.sync_transform_to_recorder();
  }

  pub fn transform(&mut self, ts: Matrix) -> result::Result<(), SkError> {
    if let Some(inverse) = ts.invert() {
      self.path.transform_self(&inverse);
    }
    self.state.transform = ts.multiply(&self.state.transform);
    let transform = self.state.transform.clone();
    self.with_canvas_state(|canvas| {
      canvas.set_transform(&transform);
    });
    self.sync_transform_to_recorder();
    Ok(())
  }

  pub fn rotate(&mut self, angle: f32) {
    let degrees = angle / PI * 180f32;
    let inverse = Matrix::rotated(-angle, 0.0, 0.0);
    self.path.transform_self(&inverse);
    self.state.transform.pre_rotate(degrees);
    let transform = self.state.transform.clone();
    self.with_canvas_state(|canvas| {
      canvas.set_transform(&transform);
    });
    self.sync_transform_to_recorder();
  }

  pub fn scale(&mut self, x: f32, y: f32) {
    if x != 0.0 && y != 0.0 {
      let mut inverse = Matrix::identity();
      inverse.pre_scale(1f32 / x, 1f32 / y);
      self.path.transform_self(&inverse);
    }
    self.state.transform.pre_scale(x, y);
    let transform = self.state.transform.clone();
    self.with_canvas_state(|canvas| {
      canvas.set_transform(&transform);
    });
    self.sync_transform_to_recorder();
  }

  pub fn set_transform(&mut self, ts: Matrix) {
    self.state.transform = ts.clone();
    self.with_canvas_state(|canvas| {
      canvas.set_transform(&ts);
    });
    self.sync_transform_to_recorder();
  }

  pub fn reset_transform(&mut self) {
    self.state.transform = Matrix::identity();
    self.with_canvas_state(|canvas| {
      canvas.reset_transform();
    });
    self.sync_transform_to_recorder();
  }

  pub fn stroke_text(
    &mut self,
    text: &str,
    x: f32,
    y: f32,
    max_width: f32,
  ) -> result::Result<(), SkError> {
    let stroke_paint = self.stroke_paint()?;
    let variations = self.state.font_variations.clone();
    self.draw_text(
      text.replace('\n', " ").as_str(),
      x,
      y,
      max_width,
      &stroke_paint,
      &variations,
    )?;
    Ok(())
  }

  pub fn fill_rect(&mut self, x: f32, y: f32, w: f32, h: f32) -> result::Result<(), SkError> {
    let fill_paint = self.fill_paint()?;

    // Extract state for shadow rendering to avoid borrow conflicts
    let shadow_paint = Self::shadow_paint(&self.state, &fill_paint);
    let shadow_offset_x = self.state.shadow_offset_x;
    let shadow_offset_y = self.state.shadow_offset_y;

    self.with_shadowed_render_canvas(
      &fill_paint,
      shadow_paint.as_ref(),
      |shadow_canvas, shadow_paint, device_ctm| {
        shadow_canvas.save();
        Self::apply_shadow_offset_matrix_to_canvas(
          shadow_canvas,
          device_ctm,
          shadow_offset_x,
          shadow_offset_y,
        )?;
        shadow_canvas.draw_rect(x, y, w, h, shadow_paint);
        shadow_canvas.restore();
        Ok(())
      },
      |canvas, paint| {
        canvas.draw_rect(x, y, w, h, paint);
        Ok(())
      },
    )?;
    Ok(())
  }

  pub fn fill_text(
    &mut self,
    text: &str,
    x: f32,
    y: f32,
    max_width: f32,
  ) -> result::Result<(), SkError> {
    let fill_paint = self.fill_paint()?;
    let variations = self.state.font_variations.clone();
    self.draw_text(
      text.replace('\n', " ").as_str(),
      x,
      y,
      max_width,
      &fill_paint,
      &variations,
    )?;
    Ok(())
  }

  pub fn stroke(&mut self, path: Option<&mut SkPath>) -> Result<()> {
    let stroke_paint = self.stroke_paint()?;

    // Clone the path to avoid borrow conflicts with with_render_canvas
    let path_to_draw = match path {
      Some(p) => p.clone(),
      None => self.path.clone(),
    };

    // Extract state for shadow rendering to avoid borrow conflicts
    let shadow_paint = Self::shadow_paint(&self.state, &stroke_paint);
    let shadow_offset_x = self.state.shadow_offset_x;
    let shadow_offset_y = self.state.shadow_offset_y;

    self.with_shadowed_render_canvas(
      &stroke_paint,
      shadow_paint.as_ref(),
      |shadow_canvas, shadow_paint, device_ctm| {
        shadow_canvas.save();
        Self::apply_shadow_offset_matrix_to_canvas(
          shadow_canvas,
          device_ctm,
          shadow_offset_x,
          shadow_offset_y,
        )?;
        shadow_canvas.draw_path(&path_to_draw, shadow_paint);
        shadow_canvas.restore();
        Ok(())
      },
      |canvas, paint| {
        canvas.draw_path(&path_to_draw, paint);
        Ok(())
      },
    )?;
    Ok(())
  }

  // One `CompositedDraw` pass: record the draw into a picture, then replay it
  // through a layer that carries only the composite mode.
  //
  // Blink's `composite_flags` is a fresh PaintFlags with nothing on it but
  // `setBlendMode(state.GlobalComposite())` -- alpha 1, no shader, no filter --
  // while the content paint rides on the inner draw with its blend forced to
  // source-over (canvas_2d_recorder_context.h:921-922, :948-951, :957-962).
  // Handing one paint to both sides applied globalAlpha twice:
  // `SkCanvas::drawPicture` with a paint is `saveLayer(cullRect, paint) +
  // playback + restore` (skia/src/core/SkCanvasPriv.cpp:32-45) and the restore
  // paint keeps alpha, colour filter and blend mode
  // (skia/src/core/SkCanvas.cpp:895-906). Dropping the colour and shader from the
  // layer paint costs nothing -- the layer image replaces the paint's shader
  // (skia/src/core/SkDraw.cpp:72-82).
  //
  // Blink's filter-shaped branch (h:929-944) is the same statement read
  // backwards, since an image-filter layer moves only the filter and the blender
  // onto the restore paint and leaves alpha and shader on the content
  // (skia/src/core/SkCanvasPriv.cpp:238-251); the looper shape is chosen because
  // it needs no `saveLayer` binding, which skia-c lacks.
  fn composited_pass<F>(
    surface_canvas: &mut Canvas,
    paint: &Paint,
    blend_mode: BlendMode,
    left: f32,
    top: f32,
    width: f32,
    height: f32,
    f: F,
  ) -> result::Result<(), SkError>
  where
    F: Fn(&mut Canvas, &Paint) -> result::Result<(), SkError>,
  {
    let mut inner_paint = paint.clone();
    inner_paint.set_blend_mode(BlendMode::SourceOver);
    let mut composite_paint = Paint::new();
    composite_paint.set_blend_mode(blend_mode);
    let mut layer = PictureRecorder::new();
    layer.begin_recording(left, top, width, height);
    if let Some(canvas) = layer.get_recording_canvas() {
      f(canvas, &inner_paint)?;
    }
    if let Some(pict) = layer.finish_recording_as_picture() {
      surface_canvas.save();
      surface_canvas.draw_picture(&pict, &Matrix::identity(), &composite_paint);
      surface_canvas.restore();
    }
    Ok(())
  }

  // Draws the shadow pass and then the content pass, giving each its OWN
  // isolation layer for the composite modes that need the whole canvas as their
  // destination.
  //
  // This mirrors Blink's `CompositedDraw`
  // (canvas_2d_recorder_context.h:896-965): for a shadowed draw it "unroll[s]
  // into two independently composited passes" (h:924) -- `saveLayer` + shadow +
  // `restore`, then `saveLayer` + foreground + `restore` -- both layers carrying
  // `state.GlobalComposite()` and both inner draws forced to source-over. The two
  // layers are SIBLINGS on the same canvas. That is the WHATWG drawing model
  // taken literally, composite(composite(background, shadow), foreground), and it
  // is why a source-in / destination-in shadow legitimately renders almost
  // nothing and a copy shadow renders nothing at all: the foreground composite
  // consumes the shadow composite's output (canvas_2d_recorder_context.cc:
  // 591-596). Do not "fix" that back into one shared layer.
  //
  // The shadow pass used to be issued from inside the caller's closure, i.e.
  // from inside this function's own recording canvas, where it re-entered the
  // isolation arm and built its layer NESTED in this one. The shadow was
  // therefore composited against the still-empty outer layer instead of against
  // the real backdrop, and the union was composited a second time. Measured on a
  // blue backdrop with a red rect and an offset green shadow, before -> after,
  // against Chrome 150 as the oracle:
  //   source-out       overlap [0,0,0,0]     -> [255,0,0,255]   (Chrome [255,0,0,255])
  //   destination-atop shadow  [0,0,255,255] -> [0,0,0,0]       (Chrome [0,0,0,0])
  //   copy             shadow  [0,255,0,255] -> [0,0,0,0]       (Chrome [0,0,0,0])
  // source-in and destination-in render nothing either way, and Chrome agrees --
  // that is the drawing model, not a defect.
  //
  // EVERY other blend mode -- including the default source-over -- draws both
  // passes straight onto `surface_canvas` with the current clip and transform
  // intact; no layer and no bounds expansion happen on that path at all.
  //
  // KNOWN DEFECT, do not treat this helper as correct: the mode list below omits
  // the shadow-conditional cases Chromium routes through CompositedDraw. With
  // shadows on, every mode outside source-over / source-atop / destination-out /
  // copy needs it (canvas_2d_recorder_context.h:692-697, :719-727).
  fn render_canvas<S, F>(
    surface_canvas: &mut Canvas,
    paint: &Paint,
    blend_mode: BlendMode,
    width: f32,
    height: f32,
    shadow: Option<ShadowPass<'_>>,
    shadow_f: S,
    f: F,
  ) -> result::Result<(), SkError>
  where
    S: Fn(&mut Canvas, &Paint, &Matrix) -> result::Result<(), SkError>,
    F: Fn(&mut Canvas, &Paint) -> result::Result<(), SkError>,
  {
    match blend_mode {
      // The first four are exactly Chromium's `IsFullCanvasCompositeMode`
      // (canvas_2d_recorder_context.h:998-1005). It deliberately omits
      // source-atop and destination-out "as the platforms already implement the
      // specification's behavior", and `BlendModeRequiresCompositedDraw`
      // (h:711-718) additionally exempts copy/`kSrc`.
      //
      // `Source` is kept here anyway, and it is NOT a divergence in effect:
      // Chromium implements copy as `clear(transparent)` + foreground-only draw
      // (h:830-837), and a whole-canvas layer restored with kSrc is the same
      // thing -- both replace every pixel, and the foreground layer wipes the
      // shadow layer exactly as Chromium says it would (cc:591-596). Removing it
      // was measured to break that: with copy falling through to the direct arm,
      // a `fillRect` only overwrites its own geometry and the rest of the canvas
      // survives.
      BlendMode::SourceIn
      | BlendMode::SourceOut
      | BlendMode::DestinationIn
      | BlendMode::DestinationATop
      | BlendMode::Source => {
        if let Some(shadow) = shadow {
          // The shadow layer is the one place the halo can escape the canvas
          // rect, so its cull rect is expanded. FIXME: this under-covers. Skia
          // bounds a Gaussian at 3 * sigma
          // (skia/src/effects/imagefilters/SkBlurImageFilter.cpp:64-69) and sigma
          // is `shadow_blur / 2` (see shadow_paint), so the halo needs
          // `1.5 * shadow_blur + |dx| + |dy|`, not `shadow_blur + |dx| + |dy|`.
          // The `.max(shadow_blur * 2.0)` term only rescues the zero-offset case:
          // blur=4, dx=100, dy=0 yields 104 where 106 is required.
          let expansion = (shadow.blur.abs() + shadow.offset_x.abs() + shadow.offset_y.abs())
            .max(shadow.blur * 2.0);
          // The recording canvas `composited_pass` hands the closure sits at
          // IDENTITY -- the CTM below is applied later, at `draw_picture`
          // replay. So the closure cannot read the device matrix off the canvas
          // it is drawing into; it has to be given this one, or the device-space
          // shadow offset gets scaled and rotated by the replay.
          let device_ctm = surface_canvas.get_transform_matrix();
          Self::composited_pass(
            surface_canvas,
            shadow.paint,
            blend_mode,
            -expansion,
            -expansion,
            width + expansion * 2.0,
            height + expansion * 2.0,
            |canvas, paint| shadow_f(canvas, paint, &device_ctm),
          )?;
        }
        Self::composited_pass(
          surface_canvas,
          paint,
          blend_mode,
          0.0,
          0.0,
          width,
          height,
          f,
        )
      }
      _ => {
        if let Some(shadow) = shadow {
          // The save/restore/save + set_transform sequence below is inert: the
          // first `restore()` pops the `save()` above it, and `set_transform`
          // re-installs the identical CTM (skiac_canvas_set_transform is an
          // absolute SkCanvas::setMatrix, skia-c/skia_c.cpp:342-345). Neither the
          // clip nor the transform changes. Contrary to the comments this
          // replaces, the clip is NOT removed -- measured: with a clip on x<100
          // and an offset-only shadow crossing it, pixel (110,100) stays
          // [255,255,255,255].
          //
          // Preserving the clip is correct and must stay: Chromium's
          // CompositedDraw resets only the matrix and never touches the clip
          // (canvas_2d_recorder_context.h:919-964), so a shadow is clipped like
          // any other draw. Do NOT "fix" this into a real clip removal.
          surface_canvas.save();
          let current_transform = surface_canvas.get_transform_matrix().clone();

          surface_canvas.restore();
          surface_canvas.save();
          surface_canvas.set_transform(&current_transform);

          // Here the canvas IS the device, so its own CTM is the device matrix.
          shadow_f(surface_canvas, shadow.paint, &current_transform)?;
          surface_canvas.restore();
        }
        f(surface_canvas, paint)?;
        Ok(())
      }
    }
  }

  pub fn fill(
    &mut self,
    path: Option<&mut SkPath>,
    fill_rule: FillType,
  ) -> result::Result<(), SkError> {
    let fill_paint = self.fill_paint()?;

    // Clone the path and set fill type to avoid borrow conflicts with with_render_canvas
    let path_to_draw = if let Some(p) = path {
      p.set_fill_type(fill_rule);
      p.clone()
    } else {
      self.path.set_fill_type(fill_rule);
      self.path.clone()
    };

    // Extract state for shadow rendering to avoid borrow conflicts
    let shadow_paint = Self::shadow_paint(&self.state, &fill_paint);
    let shadow_offset_x = self.state.shadow_offset_x;
    let shadow_offset_y = self.state.shadow_offset_y;

    self.with_shadowed_render_canvas(
      &fill_paint,
      shadow_paint.as_ref(),
      |shadow_canvas, shadow_paint, device_ctm| {
        shadow_canvas.save();
        Self::apply_shadow_offset_matrix_to_canvas(
          shadow_canvas,
          device_ctm,
          shadow_offset_x,
          shadow_offset_y,
        )?;
        shadow_canvas.draw_path(&path_to_draw, shadow_paint);
        shadow_canvas.restore();
        Ok(())
      },
      |canvas, paint| {
        canvas.draw_path(&path_to_draw, paint);
        Ok(())
      },
    )?;
    Ok(())
  }

  pub fn fill_paint(&self) -> result::Result<Paint, SkError> {
    let last_state = &self.state;
    let current_paint = &last_state.paint;
    let mut paint = current_paint.clone();
    paint.set_style(PaintStyle::Fill);
    let alpha = current_paint.get_alpha();
    match &last_state.fill_style {
      Pattern::Color(c, _) => {
        let color = Self::multiply_by_alpha(c, alpha);
        paint.set_color(color.r, color.g, color.b, color.a);
      }
      Pattern::Gradient(g) => {
        let current_transform = &last_state.transform;
        let shader = g.get_shader(current_transform.get_transform())?;
        paint.set_color(0, 0, 0, alpha);
        paint.set_shader(&shader);
      }
      Pattern::Image(p) => {
        if let Some(shader) = p.get_shader() {
          paint.set_color(0, 0, 0, alpha);
          paint.set_shader(&shader);
        }
      }
    };
    if !last_state.line_dash_list.is_empty() {
      let path_effect = PathEffect::new_dash_path(
        last_state.line_dash_list.as_slice(),
        last_state.line_dash_offset,
      )
      .ok_or_else(|| SkError::Generic("Make line dash path effect failed".to_string()))?;
      paint.set_path_effect(&path_effect);
    }
    if let Some(f) = &self.state.filter {
      paint.set_image_filter(f);
    }
    Ok(paint)
  }

  pub fn set_filter(&mut self, filter_str: &str) -> result::Result<(), SkError> {
    if filter_str.trim() == "none" {
      self.state.filters_string = "none".to_owned();
      self.state.filter = None;
    } else {
      let (_, filters) =
        css_filter(filter_str).map_err(|e| SkError::StringToFillRuleError(format!("{e}")))?;
      self.state.filter = css_filters_to_image_filter(filters);
      self.state.filters_string = filter_str.to_owned();
    }
    Ok(())
  }

  pub fn get_font(&self) -> &str {
    &self.state.font
  }

  pub fn set_font(&mut self, font: String) -> result::Result<(), SkError> {
    self.state.font_style = Font::new(&font)?;
    // Apply CSS font-variant-css2 to fontVariantCaps state.
    // In font shorthand, it only supports `<font-variant-css2>= normal | small-caps`
    // Spec: https://drafts.csswg.org/css-fonts/#font-prop
    self.state.font_variant_caps = match self.state.font_style.variant {
      crate::font::FontVariant::SmallCaps => FontVariantCaps::SmallCaps,
      crate::font::FontVariant::Normal => FontVariantCaps::Normal,
    };
    self.state.font = font;
    Ok(())
  }

  pub fn get_font_variation_settings(&self) -> &str {
    &self.state.font_variation_settings
  }

  pub fn set_font_variation_settings(&mut self, settings: String) -> result::Result<(), SkError> {
    let (settings, variations) = parse_font_variation_settings(&settings);
    self.state.font_variation_settings = settings;
    self.state.font_variations = variations;
    Ok(())
  }

  pub fn get_stroke_width(&self) -> f32 {
    self.state.paint.get_stroke_width()
  }

  pub fn get_miter_limit(&self) -> f32 {
    self.state.paint.get_stroke_miter()
  }

  pub fn set_miter_limit(&mut self, miter_limit: f32) {
    self.state.paint.set_stroke_miter(miter_limit);
  }

  pub fn get_global_alpha(&self) -> f64 {
    self.state.paint.get_alpha() as f64 / 255.0
  }

  pub fn set_shadow_color(&mut self, shadow_color: String) -> result::Result<(), SkError> {
    let mut parser_input = ParserInput::new(&shadow_color);
    let mut parser = Parser::new(&mut parser_input);
    let color = CSSColor::parse(&mut parser)
      .map_err(|e| SkError::Generic(format!("Parse color [{}] error: {:?}", shadow_color, e)))?;

    match color {
      CSSColor::CurrentColor => {
        return Err(SkError::Generic(
          "Color should not be `currentcolor` keyword".to_owned(),
        ));
      }
      CSSColor::Rgba(rgba) => {
        drop(parser_input);
        self.state.shadow_color_string = shadow_color;
        // Convert RgbaLegacy to RGBA<u8>
        self.state.shadow_color = RGBA {
          r: rgba.red,
          g: rgba.green,
          b: rgba.blue,
          a: (rgba.alpha * 255.0) as u8,
        };
      }
      CSSColor::Hsl(hsl) => {
        let h = hsl.hue.unwrap_or(0.0) / 360.0;
        let s = hsl.saturation.unwrap_or(0.0);
        let l = hsl.lightness.unwrap_or(0.0);
        let a = hsl.alpha.unwrap_or(1.0);

        let (r, g, b) = hsl_to_rgb(h, s, l);

        drop(parser_input);
        self.state.shadow_color_string = shadow_color;
        self.state.shadow_color = RGBA {
          r: (r * 255.0) as u8,
          g: (g * 255.0) as u8,
          b: (b * 255.0) as u8,
          a: (a * 255.0) as u8,
        };
      }
      _ => {
        return Err(SkError::Generic("Unsupported color format".to_owned()));
      }
    }
    Ok(())
  }

  pub fn set_text_align(&mut self, text_align: String) -> result::Result<(), SkError> {
    self.state.text_align = text_align.parse()?;
    Ok(())
  }

  pub fn set_text_baseline(&mut self, text_baseline: String) -> result::Result<(), SkError> {
    self.state.text_baseline = text_baseline.parse()?;
    Ok(())
  }

  pub fn set_font_stretch(&mut self, stretch: String) -> result::Result<(), SkError> {
    if let Some(s) = crate::font::parse_font_stretch(&stretch) {
      self.state.font_stretch = s;
      self.state.font_stretch_raw = stretch;
    }
    Ok(())
  }

  pub fn set_font_kerning(&mut self, kerning: String) -> result::Result<(), SkError> {
    if let Ok(k) = kerning.parse() {
      self.state.font_kerning = k;
    }
    Ok(())
  }

  pub fn set_font_variant_caps(&mut self, variant_caps: String) -> result::Result<(), SkError> {
    if let Ok(v) = variant_caps.parse() {
      self.state.font_variant_caps = v;
    }
    Ok(())
  }

  pub fn set_text_rendering(&mut self, rendering: String) -> result::Result<(), SkError> {
    if let Ok(r) = rendering.parse() {
      self.state.text_rendering = r;
    }
    Ok(())
  }

  pub fn set_lang(&mut self, lang: String) {
    self.state.lang = lang;
  }

  pub fn get_image_data(
    &mut self,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    color_type: ColorSpace,
  ) -> Option<Vec<u8>> {
    // Use RecordingSurface for deferred mode - enables incremental rendering
    if let Some(ref recorder) = self.page_recorder {
      return recorder
        .borrow_mut()
        .get_pixels(x as i32, y as i32, w as u32, h as u32, color_type);
    }

    // Direct mode - read from main surface
    self
      .surface
      .read_pixels(x as i32, y as i32, w as u32, h as u32, color_type)
  }

  pub fn set_line_dash(&mut self, line_dash_list: Vec<f32>) {
    self.state.line_dash_list = line_dash_list;
  }

  fn stroke_paint(&self) -> result::Result<Paint, SkError> {
    let last_state = &self.state;
    let current_paint = &last_state.paint;
    let mut paint = current_paint.clone();
    paint.set_style(PaintStyle::Stroke);
    let global_alpha = current_paint.get_alpha();
    match &last_state.stroke_style {
      Pattern::Color(c, _) => {
        let color = Self::multiply_by_alpha(c, global_alpha);
        paint.set_color(color.r, color.g, color.b, color.a);
      }
      Pattern::Gradient(g) => {
        let current_transform = &last_state.transform;
        let shader = g.get_shader(current_transform.get_transform())?;
        paint.set_color(0, 0, 0, global_alpha);
        paint.set_shader(&shader);
      }
      Pattern::Image(p) => {
        if let Some(shader) = p.get_shader() {
          paint.set_color(0, 0, 0, current_paint.get_alpha());
          paint.set_shader(&shader);
        }
      }
    };
    if !last_state.line_dash_list.is_empty() {
      let path_effect = PathEffect::new_dash_path(
        last_state.line_dash_list.as_slice(),
        last_state.line_dash_offset,
      )
      .ok_or_else(|| SkError::Generic("Make line dash path effect failed".to_string()))?;
      paint.set_path_effect(&path_effect);
    }
    if let Some(f) = &self.state.filter {
      paint.set_image_filter(f);
    }
    Ok(paint)
  }

  /// The one and only Gaussian a canvas2d shadow is allowed to carry.
  ///
  /// Chromium: sigma is EXACTLY `shadowBlur * 0.5`, in DEVICE space, applied
  /// EXACTLY ONCE. `ShadowData::BlurRadiusToStdDev`
  /// (third_party/blink/renderer/core/style/shadow_data.h:76-82) is `radius *
  /// 0.5f`, reached from `CanvasRenderingContext2DState::ShadowBlurAsSigma`
  /// (canvas_rendering_context_2d_state.cc:650-652) and pinned by a unit test
  /// -- `setShadowBlur(2)` asserts `blur_sigma=1`
  /// (canvas_2d_recorder_context_test.cc:348-361).
  ///
  /// `CanvasRenderingContext2DState::GetFlags`
  /// (canvas_rendering_context_2d_state.cc:849-868) picks EITHER a
  /// `cc::DrawLooper` (mask-filter blur) OR a `DropShadowPaintFilter`
  /// (image-filter blur) and explicitly nulls the other in every branch -- the
  /// two are never stacked.
  ///
  /// This builder is reached only for a BLURRED shadow; `shadow_paint` sends
  /// `shadowBlur == 0` down the colour-filter route instead, exactly as the
  /// looper does (`blur_sigma > 0` gates the mask filter,
  /// cc/paint/draw_looper.cc:28-34).
  ///
  /// For blurred shadows we take the image-filter branch for geometry, text and
  /// images alike. That is a deliberate divergence in MECHANISM, not in output:
  /// Chromium uses the looper for solid/gradient fill, stroke and text. For a
  /// solid fill the two are the same operation at the same sigma. For a
  /// gradient with varying alpha the looper blurs only the coverage mask and
  /// multiplies by the UNBLURRED gradient alpha, while the image filter blurs
  /// the composited source alpha -- which is what Chromium itself does for
  /// patterns and non-opaque images. `DropShadowOnly` carries the same
  /// `SkColorFilters::Blend(color, kSrcIn)` internally
  /// (SkDropShadowImageFilter.cpp:47-49) that `Paint::set_src_in_color_filter`
  /// installs directly, so the two routes colourise identically; only the
  /// Gaussian differs.
  ///
  /// The filter carries NO offset. `make_drop_shadow_graph` implements dx/dy as
  /// an `SkImageFilters::MatrixTransform(SkMatrix::Translate(dx, dy))`
  /// (SkDropShadowImageFilter.cpp:52-54) whose matrix is a
  /// `skif::ParameterSpace<SkMatrix>` run through `mapping().paramToLayer()`
  /// (SkMatrixTransformImageFilter.cpp:71, :151), i.e. a LOCAL-space offset that
  /// the CTM rotates and scales. Chromium's offsets are device-space in every
  /// path -- `kPostTransformFlag` makes the looper
  /// `setMatrix(getLocalToDevice().postTranslate(dx, dy))`
  /// (cc/paint/draw_looper.cc:37-40), and the image-filter path runs its shadow
  /// `saveLayer` inside a `ScopedResetCtm`
  /// (canvas_2d_recorder_context.cc:545-565). Every caller therefore translates
  /// the canvas with `apply_shadow_offset_matrix_to_canvas` instead, handing it
  /// the user->DEVICE matrix explicitly.
  ///
  /// "Explicitly" is the load-bearing word and this comment used to omit it,
  /// which made it false for exactly one arm. `apply_shadow_offset_matrix_to_canvas`
  /// used to read the CTM off the canvas it was given, and on the isolation
  /// composite modes that canvas is a `PictureRecorder`'s, sitting at identity
  /// (`composited_pass`) -- so the device-space sandwich collapsed to a plain
  /// translate in PICTURE space and the real CTM, applied at `draw_picture`
  /// replay, scaled and rotated it right back into local space. Measured against
  /// Chrome 150 with `source-in`, an opaque backdrop, `fillRect(10, 40, 60, 30)`
  /// and `shadowOffsetX = 40` (surviving red at y=100 marks the shadow's left
  /// edge): `scale(2, 2)` gave x=100..139 against Chrome's 60..139, and
  /// `rotate(180)` gave 120..139 against Chrome's 160..179. Both are exact now.
  /// The direct arm was always right, because there the canvas IS the device.
  fn shadow_only_image_filter(state: &Context2dRenderingState) -> Option<ImageFilter> {
    let shadow_color = &state.shadow_color;
    let a = shadow_color.a;
    let r = shadow_color.r;
    let g = shadow_color.g;
    let b = shadow_color.b;
    // The sigma handed to `SkImageFilters::Blur` is in PARAMETER space, so it
    // has to be pre-divided by the scale Skia will apply on its way to the
    // layer. `SkBlurImageFilter` does not override `onGetCTMCapability`, so it
    // reports `kScaleTranslate` (SkImageFilter_Base.h:225-226); a rotating or
    // skewing CTM therefore takes `Mapping::decomposeCTM`'s third branch
    // (SkImageFilterTypes.cpp:272-283), which factors the CTM through
    // `SkMatrix::decomposeScale` (SkMatrix.cpp:1479-1499):
    //   sx = SkVector::Length(getScaleX(), getSkewY()) = sqrt(a^2 + b^2)
    //   sy = SkVector::Length(getSkewX(), getScaleY()) = sqrt(c^2 + d^2)
    // Those column norms are the exact inverse for any non-perspective affine
    // CTM. The raw `transform.a` / `transform.d` are not: rotate(90deg) snaps
    // `a` to exactly 0 (SkMatrix.cpp:458 `SkScalarCosSnapToZero`) so the sigma
    // becomes +inf, and rotate(180deg) / scale(-1, 1) make it negative. Either
    // way `SkImageFilters::Blur` returns nullptr (SkBlurImageFilter.cpp:83-88)
    // and `make_drop_shadow_graph` SILENTLY drops the Blur node while keeping
    // the colour filter and the translate (SkDropShadowImageFilter.cpp:45-54,
    // a null input means "the source") -- a shadow with no blur at all.
    let t = state.transform.get_transform();
    let scale_x = (t.a * t.a + t.b * t.b).sqrt();
    let scale_y = (t.c * t.c + t.d * t.d).sqrt();
    let sigma = state.shadow_blur / 2f32;
    // sigma == 0 is fine and must not be guarded: `SkImageFilters::Blur`
    // explicitly allows it ("We allow 0 sigma for X and/or Y",
    // SkBlurImageFilter.cpp:83-88) and it degenerates to the identity at filter
    // time, leaving colorize + translate.
    let sigma_x = if scale_x.is_finite() && scale_x > 0f32 {
      sigma / scale_x
    } else {
      sigma
    };
    let sigma_y = if scale_y.is_finite() && scale_y > 0f32 {
      sigma / scale_y
    } else {
      sigma
    };
    ImageFilter::make_drop_shadow_only(
      // dx, dy: see the doc comment -- the offset is a canvas translate, not a
      // filter parameter.
      0f32,
      0f32,
      sigma_x,
      sigma_y,
      ((a as u32) << 24) | ((r as u32) << 16) | ((g as u32) << 8) | b as u32,
      None,
    )
  }

  /// The shadow half of every draw -- geometry, text and images alike. There
  /// used to be a second, image-only builder here; the two differed only in
  /// baking the offset into the filter, and once that moved to the canvas they
  /// were the same function.
  fn shadow_paint(state: &Context2dRenderingState, paint: &Paint) -> Option<Paint> {
    let shadow_color = &state.shadow_color;
    let shadow_alpha = shadow_color.a;
    if shadow_alpha == 0 {
      return None;
    }
    if state.shadow_blur == 0f32 && state.shadow_offset_x == 0f32 && state.shadow_offset_y == 0f32 {
      return None;
    }
    let mut drop_shadow_paint = paint.clone();
    // Whatever the blur, the colourisation is the SAME operation: an
    // `SkColorFilters::Blend(shadowColor, kSrcIn)`. Blink installs it in BOTH of
    // its shadow paths (cc/paint/draw_looper.cc:33-34,
    // SkDropShadowImageFilter.cpp:47-49); it is never an `SkPaint::setColor`.
    //
    // This used to `set_color(r, g, b, a)` on the clone when `shadow_blur == 0`.
    // `setColor` cannot displace a shader, so a gradient or pattern fill cast a
    // displaced copy of ITSELF instead of a shadow, and it overwrote the
    // `fillStyle` alpha * `globalAlpha` that `fill_paint`/`stroke_paint` had
    // already folded into the paint, so the shadow rendered at full
    // `shadowColor.a`. SrcIn instead replaces the source RGB wholesale --
    // shader included, because Skia's blitter runs the colour filter AFTER the
    // shader and after the paint alpha (SkRasterPipelineBlitter.cpp: shader
    // stages, then `scale_1_float` with the paint alpha, then the colour
    // filter) -- and multiplies the source coverage by `shadowColor.a` exactly
    // once.
    //
    // The offset is applied on the canvas by
    // `apply_shadow_offset_matrix_to_canvas`, in device space (matching Blink's
    // `kShadowIgnoresTransforms` / `kPostTransformFlag`,
    // cc/paint/draw_looper.cc:28-40), so neither route carries one. The image
    // path used to bake it into the filter's dx/dy instead, where it is a
    // local-space vector: `translate(300, 200); rotate(PI); shadowOffsetX = 100;
    // drawImage(...)` put the shadow 100 device px to the LEFT (measured
    // centroid 197.5 where the geometry path gives 401.5), and `scale(2, 0.5)`
    // doubled a 40px offset to 80.
    if state.shadow_blur == 0f32 {
      // No blur, so there is no Gaussian to place and nothing an image filter
      // could add -- Chromium gates its mask filter on `blur_sigma > 0` and
      // otherwise leaves the looper layer with just the colour filter and the
      // post-transform offset (cc/paint/draw_looper.cc:28-42). Matching that
      // shape is not cosmetic; the image filter forced a `saveLayer` and that
      // cost three things:
      //   * SkSVGDevice cannot express an image filter and DROPPED the shadow
      //     draw whole, so an offset-only shadow disappeared from every SVG
      //     export. A kSrcIn colour filter it can express, as an
      //     feFlood + feComposite (src/svg/SkSVGDevice.cpp:431-436, :472-505),
      //     and kSrcIn is the only blend mode it accepts.
      //   * SkPDFDevice rasterised the layer into an image XObject, so text
      //     under a shadow stopped being real text. A colour filter is folded
      //     back into the paint colour and stays vector
      //     (`SkPaintPriv::RemoveColorFilter`, src/pdf/SkPDFDevice.cpp:274-277).
      //   * The layer applied the antialiased clip TWICE -- once to the draw
      //     inside the layer and once to the layer's own restore -- so a
      //     rotated clip edge darkened by up to 24/255 against a shadow that
      //     had matched Chrome exactly.
      // Do NOT add a MaskFilter here either: `SkMaskFilter::MakeBlur` returns
      // nullptr for sigma <= 0 (SkBlurMaskFilterImpl.cpp:598-603).
      //
      // R4: this route deliberately leaves the clone's image filter ALONE, so a
      // `ctx.filter` installed by `fill_paint`/`stroke_paint`
      // (src/ctx.rs:936-938, :1146-1148) still applies to the shadow. Skia runs
      // the colour filter inside the filter's implicit layer and `ctx.filter`
      // over the result, i.e. `filter(colourise(source))`, which is the order
      // Blink asks for (`Compose(Compose(fg, shadow), canvas_filter)`,
      // canvas_2d_recorder_context.h:931-934). Measured: `grayscale(1)` with an
      // opaque blue shadow gives [18,18,18] = 0.0722 * 255, not raw blue.
      drop_shadow_paint.set_src_in_color_filter(
        shadow_color.r,
        shadow_color.g,
        shadow_color.b,
        shadow_alpha,
      );
      return Some(drop_shadow_paint);
    }
    let shadow_effect = Self::shadow_only_image_filter(state)?;
    // Do NOT re-apply `shadow_alpha` here: the drop-shadow filter above is
    // already built with the shadow colour's alpha, and the cloned `paint`
    // already carries the source alpha (fillStyle alpha * globalAlpha). A
    // `set_alpha(shadow_alpha)` would multiply the shadow opacity a second time,
    // rendering `shadowColor` alpha `a` as `a * a` -- e.g. a 0.3 shadow shows up
    // at ~0.09 opacity. See the linear-scaling regression test.
    //
    // KNOWN DIVERGENCE, BLURRED SHADOWS ONLY: this REPLACES any `ctx.filter`
    // that `fill_paint`/`stroke_paint` installed on the clone
    // (src/ctx.rs:936-938, :1146-1148) instead of chaining it. Blink composes
    // the two -- `Compose(Compose(fg_filter, shadow_filter), canvas_filter)`,
    // canvas_2d_recorder_context.h:931-934 -- so `ctx.filter` should still apply
    // under a shadow. Passing `state.filter.as_ref()` as this filter's input is
    // the fix; it is a behaviour change on every blurred shadowed draw, so it is
    // tracked separately. The zero-blur route above does NOT have this problem:
    // it never touches the image filter, so `ctx.filter` survives there.
    drop_shadow_paint.set_image_filter(&shadow_effect);
    // Deliberately NO MaskFilter. `DropShadowOnly` already contains the Gaussian
    // (SkDropShadowImageFilter.cpp:46). Adding `SkMaskFilter::MakeBlur` on top
    // made Skia build two nested layers -- "When the original paint has both an
    // image filter and a mask filter, this will create two internal layers"
    // (SkCanvasPriv.cpp:175-207) -- and convolve twice, so geometry and text
    // shadows came out at `blur/2 * sqrt(2)` while drawImage shadows used
    // `blur/2`. Chromium never stacks the two
    // (canvas_rendering_context_2d_state.cc:849-868). It would also be fatal
    // here: `SkMaskFilter::MakeBlur` returns nullptr for sigma <= 0
    // (SkBlurMaskFilterImpl.cpp:598-603), and the `?` would then discard the
    // whole shadow paint, turning a wrong shadow into no shadow at all.
    Some(drop_shadow_paint)
  }

  pub(crate) fn draw_image(
    &mut self,
    bitmap: &Bitmap,
    sx: f32,
    sy: f32,
    s_width: f32,
    s_height: f32,
    dx: f32,
    dy: f32,
    d_width: f32,
    d_height: f32,
  ) -> Result<()> {
    let mut paint: Paint = self.fill_paint()?;
    paint.set_alpha((self.state.global_alpha * 255.0).round() as u8);

    // Extract state for shadow rendering to avoid borrow conflicts
    let shadow_paint = Self::shadow_paint(&self.state, &paint);
    let shadow_offset_x = self.state.shadow_offset_x;
    let shadow_offset_y = self.state.shadow_offset_y;
    let image_smoothing_enabled = self.state.image_smoothing_enabled;
    let image_smoothing_quality = self.state.image_smoothing_quality;

    self.with_shadowed_render_canvas(
      &paint,
      shadow_paint.as_ref(),
      |shadow_canvas: &mut Canvas, shadow_paint, device_ctm| {
        shadow_canvas.save();
        Self::apply_shadow_offset_matrix_to_canvas(
          shadow_canvas,
          device_ctm,
          shadow_offset_x,
          shadow_offset_y,
        )?;
        shadow_canvas.draw_image(
          bitmap,
          sx,
          sy,
          s_width,
          s_height,
          dx,
          dy,
          d_width,
          d_height,
          image_smoothing_enabled,
          image_smoothing_quality,
          shadow_paint,
        );
        shadow_canvas.restore();
        Ok(())
      },
      |canvas: &mut Canvas, paint| {
        canvas.draw_image(
          bitmap,
          sx,
          sy,
          s_width,
          s_height,
          dx,
          dy,
          d_width,
          d_height,
          image_smoothing_enabled,
          image_smoothing_quality,
          paint,
        );
        Ok(())
      },
    )?;
    Ok(())
  }

  /// Get a composite picture of all recorded operations (for drawCanvas)
  pub fn get_picture(&mut self) -> Option<crate::sk::SkPicture> {
    if let Some(ref recorder) = self.page_recorder {
      recorder.borrow_mut().get_picture()
    } else {
      // For non-deferred mode, we can't get a picture
      // The caller should use get_bitmap instead
      None
    }
  }

  /// Draw another canvas, preserving vector graphics when possible.
  /// When the source has a SkPicture, this avoids rasterization.
  /// Shadow rendering requires additional FFI calls when enabled.
  pub(crate) fn draw_canvas(
    &mut self,
    picture: &crate::sk::SkPicture,
    sx: f32,
    sy: f32,
    s_width: f32,
    s_height: f32,
    dx: f32,
    dy: f32,
    d_width: f32,
    d_height: f32,
  ) -> Result<()> {
    let mut paint: Paint = self.fill_paint()?;
    paint.set_alpha((self.state.global_alpha * 255.0).round() as u8);

    // Extract state for shadow rendering to avoid borrow conflicts
    let shadow_paint = Self::shadow_paint(&self.state, &paint);
    let shadow_offset_x = self.state.shadow_offset_x;
    let shadow_offset_y = self.state.shadow_offset_y;

    self.with_shadowed_render_canvas(
      &paint,
      shadow_paint.as_ref(),
      |shadow_canvas: &mut Canvas, shadow_paint, device_ctm| {
        shadow_canvas.save();
        Self::apply_shadow_offset_matrix_to_canvas(
          shadow_canvas,
          device_ctm,
          shadow_offset_x,
          shadow_offset_y,
        )?;
        shadow_canvas.draw_picture_rect(
          picture,
          sx,
          sy,
          s_width,
          s_height,
          dx,
          dy,
          d_width,
          d_height,
          shadow_paint,
        );
        shadow_canvas.restore();
        Ok(())
      },
      |canvas: &mut Canvas, paint| {
        canvas.draw_picture_rect(
          picture, sx, sy, s_width, s_height, dx, dy, d_width, d_height, paint,
        );
        Ok(())
      },
    )?;
    Ok(())
  }

  fn draw_text(
    &mut self,
    text: &str,
    x: f32,
    y: f32,
    max_width: f32,
    paint: &Paint,
    variations: &[crate::sk::FontVariation],
  ) -> result::Result<(), SkError> {
    let font = get_font()?;

    // Extract all state values to avoid borrow conflicts with with_render_canvas
    let shadow_paint = Self::shadow_paint(&self.state, paint);
    let width = self.width as f32;
    let shadow_offset_x = self.state.shadow_offset_x;
    let shadow_offset_y = self.state.shadow_offset_y;
    let font_weight = self.state.font_style.weight;
    let font_stretch = self.state.font_stretch;
    let font_stretch_percentage = font_stretch.to_width_percentage();
    let font_style_style = self.state.font_style.style;
    let font_size = self.state.font_style.size;
    let font_family = self.state.font_style.family.clone();
    let text_baseline = self.state.text_baseline;
    let text_align = self.state.text_align;
    let text_direction = self.state.text_direction;
    let letter_spacing = self.state.letter_spacing;
    let word_spacing = self.state.word_spacing;
    let font_kerning = self.state.font_kerning;
    let font_variant_caps = self.state.font_variant_caps;
    let lang = self.state.lang.clone();
    let text_rendering = self.state.text_rendering;

    self.with_shadowed_render_canvas(
      paint,
      shadow_paint.as_ref(),
      |shadow_canvas, shadow_paint, device_ctm| {
        shadow_canvas.save();
        Self::apply_shadow_offset_matrix_to_canvas(
          shadow_canvas,
          device_ctm,
          shadow_offset_x,
          shadow_offset_y,
        )?;
        shadow_canvas.draw_text(
          text,
          x,
          y,
          max_width,
          width,
          font_weight,
          font_stretch as i32,
          font_stretch_percentage,
          font_style_style,
          &font,
          font_size,
          &font_family,
          text_baseline,
          text_align,
          text_direction,
          letter_spacing,
          word_spacing,
          shadow_paint,
          variations,
          font_kerning,
          font_variant_caps,
          &lang,
          text_rendering,
        )?;
        shadow_canvas.restore();
        Ok(())
      },
      |canvas, paint| {
        canvas.draw_text(
          text,
          x,
          y,
          max_width,
          width,
          font_weight,
          font_stretch as i32,
          font_stretch_percentage,
          font_style_style,
          &font,
          font_size,
          &font_family,
          text_baseline,
          text_align,
          text_direction,
          letter_spacing,
          word_spacing,
          paint,
          variations,
          font_kerning,
          font_variant_caps,
          &lang,
          text_rendering,
        )?;
        Ok(())
      },
    )?;
    Ok(())
  }

  fn get_line_metrics(&mut self, text: &str) -> result::Result<LineMetrics, SkError> {
    let state = &self.state;
    let fill_paint = self.fill_paint()?;
    let weight = state.font_style.weight;
    let stretch = state.font_stretch;
    let slant = state.font_style.style;
    let font = get_font()?;
    let line_metrics = LineMetrics(self.surface.canvas.get_line_metrics(
      text,
      &font,
      state.font_style.size,
      weight,
      stretch as i32,
      stretch.to_width_percentage(),
      slant,
      &state.font_style.family,
      state.text_baseline,
      state.text_align,
      state.text_direction,
      state.letter_spacing,
      state.word_spacing,
      &fill_paint,
      &self.state.font_variations,
      self.state.font_kerning,
      self.state.font_variant_caps,
      &self.state.lang,
      self.state.text_rendering,
    )?);
    Ok(line_metrics)
  }

  /// Post-translate `canvas` by a DEVICE-space `(shadow_offset_x,
  /// shadow_offset_y)`.
  ///
  /// shadowOffsetX/Y are device-space in Chromium, on every path: the looper
  /// carries `kPostTransformFlag` and does
  /// `setMatrix(getLocalToDevice().postTranslate(dx, dy))`
  /// (cc/paint/draw_looper.cc:37-40), and the image-filter path draws its
  /// shadow inside a `ScopedResetCtm` (canvas_2d_recorder_context.cc:545-565).
  ///
  /// `device_ctm` is `M`, the user->DEVICE matrix of the canvas the draw
  /// ultimately lands on -- which is NOT always `canvas`'s own CTM. On the
  /// isolation composite arm `canvas` is a `PictureRecorder`'s recording canvas
  /// sitting at identity while `M` is installed on the surface canvas and only
  /// applied at `draw_picture` replay. Reading the CTM off `canvas` there (which
  /// this used to do) collapsed the sandwich below to a bare `concat(T)` in
  /// picture space, so replay scaled and rotated what has to be a device-space
  /// vector: `source-in` + `scale(2, 2)` + `shadowOffsetX = 40` put the shadow
  /// 80 device px right of the content instead of 40, and `rotate(180)` mirrored
  /// it.
  ///
  /// With `X` = `canvas`'s own CTM and `R` = whatever is concatenated between
  /// `canvas` and the device (`M = R * X`), `concat(M^-1) . concat(T) . concat(M)`
  /// leaves `canvas` at `X * M^-1 * T * M`, and the device sees
  /// `R * X * M^-1 * T * M = T * M`. That is the post-translate, for any `R`:
  /// the linear part of the device CTM is untouched (so the sigma correction in
  /// `shadow_only_image_filter` still holds) and only the translation moves.
  /// For the direct arm `R` is the identity and the sandwich is exactly the
  /// `T * M` it always was.
  fn apply_shadow_offset_matrix_to_canvas(
    canvas: &mut Canvas,
    device_ctm: &Matrix,
    shadow_offset_x: f32,
    shadow_offset_y: f32,
  ) -> result::Result<(), SkError> {
    // Invert the device transform to get back to device coordinates
    if let Some(inverted) = device_ctm.invert() {
      canvas.concat(&inverted);
      // Apply shadow offset in device coordinates
      canvas.concat(&Matrix::translated(shadow_offset_x, shadow_offset_y));
      // Re-apply the device transform
      canvas.concat(device_ctm);
    } else {
      // If the transform is not invertible, fall back to simple translation
      canvas.concat(&Matrix::translated(shadow_offset_x, shadow_offset_y));
    }
    Ok(())
  }

  // ./skia/modules/canvaskit/color.js
  fn multiply_by_alpha(color: &RGBA<u8>, global_alpha: u8) -> RGBA<u8> {
    let mut result = *color;
    result.a = ((0.0_f32.max((result.a as f32 / 255.0 * (global_alpha as f32 / 255.0)).min(1.0)))
      * 255.0)
      .round() as u8;
    result
  }

  pub fn annotate_link_url(&self, left: f64, top: f64, right: f64, bottom: f64, url: String) {
    self
      .surface
      .annotate_link_url(left as f32, top as f32, right as f32, bottom as f32, &url);
  }

  pub fn annotate_named_destination(&self, x: f64, y: f64, name: String) {
    self
      .surface
      .annotate_named_destination(x as f32, y as f32, &name);
  }

  pub fn annotate_link_to_destination(
    &self,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    name: String,
  ) {
    self.surface.annotate_link_to_destination(
      left as f32,
      top as f32,
      right as f32,
      bottom as f32,
      &name,
    );
  }
}

#[napi(object)]
pub struct ContextAttributes {
  pub alpha: bool,
  pub desynchronized: bool,
}

#[napi]
#[derive(Debug, Clone, Copy)]
pub enum SvgExportFlag {
  ConvertTextToPaths = 0x01,
  NoPrettyXML = 0x02,
  RelativePathEncoding = 0x04,
}

impl From<SvgExportFlag> for crate::sk::SvgExportFlag {
  fn from(value: SvgExportFlag) -> Self {
    match value {
      SvgExportFlag::ConvertTextToPaths => crate::sk::SvgExportFlag::ConvertTextToPaths,
      SvgExportFlag::NoPrettyXML => crate::sk::SvgExportFlag::NoPrettyXML,
      SvgExportFlag::RelativePathEncoding => crate::sk::SvgExportFlag::RelativePathEncoding,
    }
  }
}

#[napi(custom_finalize)]
pub struct CanvasRenderingContext2D {
  pub(crate) context: Context,
}

impl ObjectFinalize for CanvasRenderingContext2D {
  fn finalize(self, env: Env) -> Result<()> {
    env.adjust_external_memory(-((self.context.width * self.context.height * 4) as i64))?;
    Ok(())
  }
}

#[napi]
impl CanvasRenderingContext2D {
  #[napi(constructor)]
  pub fn new(
    width: u32,
    height: u32,
    color_space: String,
    flag: Option<SvgExportFlag>,
  ) -> Result<Self> {
    let color_space = ColorSpace::from_str(&color_space)?;
    let context = if let Some(flag) = flag {
      Context::new_svg(width, height, flag.into(), color_space)?
    } else {
      Context::new(width, height, color_space)?
    };
    Ok(Self { context })
  }

  #[napi(getter)]
  pub fn get_miter_limit(&self) -> f32 {
    self.context.get_miter_limit()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_miter_limit(&mut self, miter_limit: f64) {
    if !miter_limit.is_nan() && !miter_limit.is_infinite() {
      self.context.set_miter_limit(miter_limit as f32);
    }
  }

  #[napi(getter)]
  pub fn get_global_alpha(&self) -> f64 {
    self.context.get_global_alpha()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_global_alpha(&mut self, alpha: f64) {
    let alpha = alpha as f32;
    if !(0.0..=1.0).contains(&alpha) {
      #[cfg(debug_assertions)]
      eprintln!("Alpha value out of range, expected 0.0 - 1.0, but got : {alpha}");
      return;
    }
    self.context.state.global_alpha = alpha;
    self.context.state.paint.set_alpha((alpha * 255.0) as u8);
  }

  #[napi(getter)]
  pub fn get_global_composite_operation(&self) -> &str {
    self.context.state.paint.get_blend_mode().as_str()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_global_composite_operation(&mut self, mode: String) {
    if let Ok(blend_mode) = mode.parse() {
      self.context.state.paint.set_blend_mode(blend_mode);
      self.context.state.global_composite_operation = blend_mode;
    };
  }

  #[napi(getter)]
  pub fn get_image_smoothing_enabled(&self) -> bool {
    self.context.state.image_smoothing_enabled
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_image_smoothing_enabled(&mut self, enabled: bool) {
    self.context.state.image_smoothing_enabled = enabled;
  }

  #[napi(getter)]
  pub fn get_image_smoothing_quality(&self) -> String {
    self
      .context
      .state
      .image_smoothing_quality
      .as_str()
      .to_owned()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_image_smoothing_quality(&mut self, quality: String) {
    if let Ok(quality) = quality.parse() {
      self.context.state.image_smoothing_quality = quality;
    };
  }

  #[napi(getter)]
  pub fn get_line_cap(&self) -> String {
    self
      .context
      .state
      .paint
      .get_stroke_cap()
      .as_str()
      .to_owned()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_line_cap(&mut self, cap: String) {
    if let Ok(cap) = cap.parse() {
      self.context.state.paint.set_stroke_cap(cap);
    };
  }

  #[napi(getter)]
  pub fn get_line_dash_offset(&self) -> f64 {
    self.context.state.line_dash_offset as f64
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_line_dash_offset(&mut self, offset: f64) {
    self.context.state.line_dash_offset = offset as f32;
  }

  #[napi(getter)]
  pub fn get_line_join(&self) -> String {
    self
      .context
      .state
      .paint
      .get_stroke_join()
      .as_str()
      .to_owned()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_line_join(&mut self, join: String) {
    if let Ok(join) = join.parse() {
      self.context.state.paint.set_stroke_join(join);
    };
  }

  #[napi(getter)]
  pub fn get_line_width(&self) -> f64 {
    self.context.state.paint.get_stroke_width() as f64
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_line_width(&mut self, width: f64) {
    self.context.state.paint.set_stroke_width(width as f32);
  }

  #[napi(getter)]
  pub fn get_fill_style<'env>(&'env self, this: This<'env>) -> Result<Unknown<'env>> {
    this.get_named_property_unchecked(FILL_STYLE_HIDDEN_NAME)
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_fill_style(
    &mut self,
    mut this: This,
    fill_style: Either3<JsString, ClassInstance<CanvasGradient>, ClassInstance<CanvasPattern>>,
  ) -> Result<()> {
    if let Some(pattern) = match &fill_style {
      Either3::A(color) => Pattern::from_color(color.into_utf8()?.as_str()?).ok(),
      Either3::B(gradient) => Some(Pattern::Gradient(gradient.0.clone())),
      Either3::C(pattern) => Some(pattern.inner.clone()),
    } {
      let raw_fill_style = fill_style.as_unknown();
      self.context.state.fill_style = pattern;
      this.set(FILL_STYLE_HIDDEN_NAME, raw_fill_style)?;
    }
    Ok(())
  }

  #[napi(getter)]
  pub fn get_filter(&self) -> String {
    self.context.state.filters_string.clone()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_filter(&mut self, filter: String) -> Result<()> {
    self.context.set_filter(&filter)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_font(&self) -> String {
    self.context.get_font().to_owned()
  }

  #[napi(getter)]
  pub fn get_font_variation_settings(&self) -> String {
    self.context.get_font_variation_settings().to_owned()
  }

  #[napi(setter)]
  pub fn set_font_variation_settings(&mut self, settings: String) -> Result<()> {
    self.context.set_font_variation_settings(settings)?;
    Ok(())
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_font(&mut self, font: String) -> Result<()> {
    self.context.set_font(font)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_direction(&self) -> String {
    self.context.state.text_direction.as_str().to_owned()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_direction(&mut self, direction: String) {
    if let Ok(d) = direction.parse() {
      self.context.state.text_direction = d;
    };
  }

  #[napi(getter)]
  pub fn get_letter_spacing(&self) -> String {
    self.context.state.letter_spacing_raw.clone()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_letter_spacing(&mut self, spacing: String) -> Result<()> {
    if let Some(size) = parse_css_size(&spacing) {
      self.context.state.letter_spacing = size;
      self.context.state.letter_spacing_raw = spacing;
    }
    Ok(())
  }

  #[napi(getter)]
  pub fn get_word_spacing(&self) -> String {
    self.context.state.word_spacing_raw.clone()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_word_spacing(&mut self, spacing: String) -> Result<()> {
    if let Some(size) = parse_css_size(&spacing) {
      self.context.state.word_spacing = size;
      self.context.state.word_spacing_raw = spacing;
    }
    Ok(())
  }

  #[napi(getter)]
  pub fn get_stroke_style<'env>(&'env self, this: This<'env>) -> Option<Unknown<'env>> {
    this.get(STROKE_STYLE_HIDDEN_NAME).ok().flatten()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_stroke_style(
    &mut self,
    mut this: This,
    fill_style: Either3<JsString, ClassInstance<CanvasGradient>, ClassInstance<CanvasPattern>>,
  ) -> Result<()> {
    if let Some(pattern) = match &fill_style {
      Either3::A(color) => Pattern::from_color(color.into_utf8()?.as_str()?).ok(),
      Either3::B(gradient) => Some(Pattern::Gradient(gradient.0.clone())),
      Either3::C(pattern) => Some(pattern.inner.clone()),
    } {
      let raw_fill_style = fill_style.as_unknown();
      this.set(STROKE_STYLE_HIDDEN_NAME, raw_fill_style)?;
      self.context.state.stroke_style = pattern;
    }
    Ok(())
  }

  #[napi(getter)]
  pub fn get_shadow_blur(&self) -> f64 {
    self.context.state.shadow_blur as f64
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_shadow_blur(&mut self, blur: f64) {
    // Blink discards a non-finite or negative assignment and keeps the previous
    // value (canvas_2d_recorder_context.cc:1202-1207). Storing it instead is not
    // inert: the value becomes the sigma, `SkImageFilters::Blur` rejects
    // non-finite and negative sigma (SkBlurImageFilter.cpp:83-88) and
    // `make_drop_shadow_graph` then silently drops the Blur node
    // (SkDropShadowImageFilter.cpp:45-54), so `shadowBlur = -5` or `= NaN`
    // quietly turned every later shadow into a hard-edged one.
    if !blur.is_finite() || blur < 0.0 {
      return;
    }
    self.context.state.shadow_blur = clamp_to_f32(blur);
  }

  #[napi(getter)]
  pub fn get_shadow_color(&self) -> String {
    self.context.state.shadow_color_string.clone()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_shadow_color(&mut self, shadow_color: String) -> Result<()> {
    self.context.set_shadow_color(shadow_color)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_shadow_offset_x(&self) -> f64 {
    self.context.state.shadow_offset_x as f64
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_shadow_offset_x(&mut self, offset_x: f64) {
    // Same rule as `set_shadow_blur`, minus the sign test: Blink drops only
    // non-finite offsets (canvas_2d_recorder_context.cc:1170-1179) -- a negative
    // offset is meaningful, it casts the shadow left/up.
    if !offset_x.is_finite() {
      return;
    }
    self.context.state.shadow_offset_x = clamp_to_f32(offset_x);
  }

  #[napi(getter)]
  pub fn get_shadow_offset_y(&self) -> f64 {
    self.context.state.shadow_offset_y as f64
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_shadow_offset_y(&mut self, offset_y: f64) {
    // canvas_2d_recorder_context.cc:1186-1195, see `set_shadow_offset_x`.
    if !offset_y.is_finite() {
      return;
    }
    self.context.state.shadow_offset_y = clamp_to_f32(offset_y);
  }

  #[napi(getter)]
  pub fn get_text_align(&self) -> String {
    self.context.state.text_align.as_str().to_owned()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_text_align(&mut self, align: String) -> Result<()> {
    self.context.set_text_align(align)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_text_baseline(&self) -> String {
    self.context.state.text_baseline.as_str().to_owned()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_text_baseline(&mut self, baseline: String) -> Result<()> {
    self.context.set_text_baseline(baseline)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_font_stretch(&self) -> String {
    self.context.state.font_stretch_raw.clone()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_font_stretch(&mut self, stretch: String) -> Result<()> {
    self.context.set_font_stretch(stretch)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_font_kerning(&self) -> String {
    self.context.state.font_kerning.as_str().to_owned()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_font_kerning(&mut self, kerning: String) -> Result<()> {
    self.context.set_font_kerning(kerning)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_font_variant_caps(&self) -> String {
    self.context.state.font_variant_caps.as_str().to_owned()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_font_variant_caps(&mut self, variant_caps: String) -> Result<()> {
    self.context.set_font_variant_caps(variant_caps)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_text_rendering(&self) -> String {
    self.context.state.text_rendering.as_str().to_owned()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_text_rendering(&mut self, rendering: String) -> Result<()> {
    self.context.set_text_rendering(rendering)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_lang(&self) -> String {
    self.context.state.lang.clone()
  }

  #[napi(setter)]
  pub fn set_lang(&mut self, lang: String) {
    self.context.set_lang(lang);
  }

  #[napi]
  pub fn arc(
    &mut self,
    x: f64,
    y: f64,
    radius: f64,
    start_angle: f64,
    end_angle: f64,
    anticlockwise: Option<bool>,
  ) {
    self.context.arc(
      x as f32,
      y as f32,
      radius as f32,
      start_angle as f32,
      end_angle as f32,
      anticlockwise.unwrap_or(false),
    );
  }

  #[napi]
  pub fn arc_to(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, radius: f64) {
    self
      .context
      .arc_to(x1 as f32, y1 as f32, x2 as f32, y2 as f32, radius as f32);
  }

  #[napi]
  pub fn begin_path(&mut self) {
    self.context.begin_path();
  }

  #[napi]
  pub fn bezier_curve_to(&mut self, cp1x: f64, cp1y: f64, cp2x: f64, cp2y: f64, x: f64, y: f64) {
    self.context.bezier_curve_to(
      cp1x as f32,
      cp1y as f32,
      cp2x as f32,
      cp2y as f32,
      x as f32,
      y as f32,
    );
  }

  #[napi]
  pub fn quadratic_curve_to(&mut self, cpx: f64, cpy: f64, x: f64, y: f64) {
    self
      .context
      .quadratic_curve_to(cpx as f32, cpy as f32, x as f32, y as f32);
  }

  #[napi]
  pub fn clip(
    &mut self,
    rule_or_path: Option<Either<String, &mut Path>>,
    maybe_rule: Option<String>,
  ) {
    let rule = rule_or_path
      .as_ref()
      .and_then(|e| match e {
        Either::A(s) => FillType::from_str(s).ok(),
        Either::B(_) => None,
      })
      .or_else(|| maybe_rule.and_then(|s| FillType::from_str(&s).ok()))
      .unwrap_or(FillType::Winding);
    let path = rule_or_path.and_then(|e| match e {
      Either::A(_) => None,
      Either::B(p) => Some(p),
    });
    self.context.clip(path.map(|p| &mut p.inner), rule);
  }

  #[napi]
  pub fn clear_rect(&mut self, x: f64, y: f64, width: f64, height: f64) -> Result<()> {
    self
      .context
      .clear_rect(x as f32, y as f32, width as f32, height as f32)?;
    Ok(())
  }

  #[napi]
  pub fn close_path(&mut self) {
    self.context.close_path();
  }

  #[napi]
  pub fn create_image_data<'scope>(
    &'scope mut self,
    env: &'scope Env,
    width_or_data: Either<i32, Uint8ClampedSlice<'scope>>,
    width_or_height: i32,
    height_or_settings: Option<Either<i32, Settings>>,
    maybe_settings: Option<Settings>,
  ) -> Result<ClassInstance<'scope, ImageData>> {
    match width_or_data {
      Either::A(width) => {
        let width = width.unsigned_abs();
        let height = width_or_height.unsigned_abs();
        let color_space = match height_or_settings {
          Some(Either::B(settings)) => {
            ColorSpace::from_str(&settings.color_space).unwrap_or_default()
          }
          _ => ColorSpace::default(),
        };
        let arraybuffer_length = (width * height * 4) as usize;
        let data_buffer = vec![0; arraybuffer_length];
        let mut data_object = Uint8ClampedSlice::from_data(env, data_buffer)?;
        let mut instance = ImageData {
          width: width as usize,
          height: height as usize,
          color_space,
          data: unsafe { data_object.as_mut() }.as_mut_ptr(),
        }
        .into_instance(env)?;
        instance.set_named_property("data", data_object)?;
        Ok(instance)
      }
      Either::B(mut data_object) => {
        let input_data_length = data_object.len();
        let width = width_or_height.unsigned_abs();
        let height = match &height_or_settings {
          Some(Either::A(height)) => height.unsigned_abs(),
          _ => (input_data_length as u32) / 4 / width,
        };
        let data = unsafe { data_object.as_mut() }.as_mut_ptr();
        let color_space = maybe_settings
          .and_then(|settings| ColorSpace::from_str(&settings.color_space).ok())
          .unwrap_or_default();
        let mut instance = ImageData {
          width: width as usize,
          height: height as usize,
          color_space,
          data,
        }
        .into_instance(env)?;
        instance.set_named_property("data", data_object)?;
        Ok(instance)
      }
    }
  }

  #[napi]
  pub fn create_linear_gradient<'scope>(
    &'scope mut self,
    env: &'scope Env,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
  ) -> Result<ClassInstance<'scope, CanvasGradient>> {
    let linear_gradient =
      Gradient::create_linear_gradient(x0 as f32, y0 as f32, x1 as f32, y1 as f32);
    CanvasGradient(linear_gradient).into_instance(env)
  }

  #[napi]
  pub fn create_radial_gradient<'scope>(
    &'scope mut self,
    env: &'scope Env,
    x0: f64,
    y0: f64,
    r0: f64,
    x1: f64,
    y1: f64,
    r1: f64,
  ) -> Result<ClassInstance<'scope, CanvasGradient>> {
    let radial_gradient = Gradient::create_radial_gradient(
      x0 as f32, y0 as f32, r0 as f32, x1 as f32, y1 as f32, r1 as f32,
    );
    CanvasGradient(radial_gradient).into_instance(env)
  }

  #[napi]
  pub fn create_conic_gradient<'scope>(
    &'scope mut self,
    env: &'scope Env,
    r: f64,
    x: f64,
    y: f64,
  ) -> Result<ClassInstance<'scope, CanvasGradient>> {
    let conic_gradient = Gradient::create_conic_gradient(x as f32, y as f32, r as f32);
    CanvasGradient(conic_gradient).into_instance(env)
  }

  #[napi]
  pub fn create_pattern<'scope>(
    &'scope self,
    env: &'scope Env,
    input: Either4<&mut Image, &mut ImageData, &mut CanvasElement, &mut SVGCanvas>,
    repetition: Option<String>,
  ) -> Result<ClassInstance<'scope, CanvasPattern>> {
    CanvasPattern::new(input, repetition)?.into_instance(env)
  }

  #[napi]
  pub fn rect(&mut self, x: f64, y: f64, width: f64, height: f64) {
    self
      .context
      .rect(x as f32, y as f32, width as f32, height as f32);
  }

  #[napi]
  pub fn round_rect(
    &mut self,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    radii: Either3<f64, Vec<f64>, Undefined>,
  ) {
    // https://github.com/chromium/chromium/blob/111.0.5520.1/third_party/blink/renderer/modules/canvas/canvas2d/canvas_path.cc#L579
    let radii_array: [f32; 4] = match radii {
      Either3::A(radii) => [radii as f32; 4],
      Either3::B(radii_vec) => match radii_vec.len() {
        0 => [0f32; 4],
        1 => [radii_vec[0] as f32; 4],
        2 => [
          radii_vec[0] as f32,
          radii_vec[1] as f32,
          radii_vec[0] as f32,
          radii_vec[1] as f32,
        ],
        3 => [
          radii_vec[0] as f32,
          radii_vec[1] as f32,
          radii_vec[1] as f32,
          radii_vec[2] as f32,
        ],
        _ => [
          radii_vec[0] as f32,
          radii_vec[1] as f32,
          radii_vec[2] as f32,
          radii_vec[3] as f32,
        ],
      },
      Either3::C(_) => [0f32; 4],
    };
    self
      .context
      .round_rect(x as f32, y as f32, width as f32, height as f32, radii_array);
  }

  #[napi]
  pub fn fill(
    &mut self,
    rule_or_path: Option<Either<String, &mut Path>>,
    maybe_rule: Option<String>,
  ) -> Result<()> {
    let rule = rule_or_path
      .as_ref()
      .and_then(|e| match e {
        Either::A(s) => FillType::from_str(s).ok(),
        Either::B(_) => None,
      })
      .or_else(|| maybe_rule.and_then(|s| FillType::from_str(&s).ok()))
      .unwrap_or(FillType::Winding);
    let path = rule_or_path.and_then(|e| match e {
      Either::A(_) => None,
      Either::B(p) => Some(p),
    });
    self.context.fill(path.map(|p| &mut p.inner), rule)?;
    Ok(())
  }

  #[napi]
  pub fn save(&mut self) {
    self.context.save();
  }

  #[napi(return_if_invalid)]
  pub fn restore(&mut self) {
    self.context.restore();
  }

  #[napi]
  pub fn reset(&mut self, env: Env, mut this: This) -> Result<()> {
    self.context.reset();
    // Reset the hidden fill/stroke style properties to default "#000000"
    let default_color = env.create_string("#000000")?;
    this.set(FILL_STYLE_HIDDEN_NAME, default_color)?;
    this.set(STROKE_STYLE_HIDDEN_NAME, default_color)?;
    Ok(())
  }

  #[napi(return_if_invalid)]
  pub fn rotate(&mut self, angle: f64) {
    self.context.rotate(angle as f32);
  }

  #[napi(return_if_invalid)]
  pub fn scale(&mut self, x: f64, y: f64) {
    self.context.scale(x as f32, y as f32);
  }

  #[napi]
  pub fn draw_image(
    &mut self,
    env: &Env,
    image: Unknown,
    sx: Option<f64>,
    sy: Option<f64>,
    s_width: Option<f64>,
    s_height: Option<f64>,
    dx: Option<f64>,
    dy: Option<f64>,
    d_width: Option<f64>,
    d_height: Option<f64>,
  ) -> Result<()> {
    let Ok(image) = (unsafe {
      <Either3<&mut CanvasElement, &mut SVGCanvas, &mut Image> as FromNapiValue>::from_napi_value(
        env.raw(),
        image.raw(),
      )
    }) else {
      return env.throw_type_error(
        "Value is not one of these types: `CanvasElement`, `SVGCanvas`, `Image`",
        Some("InvalidArg"),
      );
    };
    let bitmap = match image {
      Either3::A(canvas) => {
        // Flush the source canvas to render deferred operations before getting bitmap
        canvas.ctx.context.flush();
        BitmapRef::Owned(canvas.ctx.context.surface.get_bitmap())
      }
      Either3::B(svg) => BitmapRef::Owned(svg.ctx.context.surface.get_bitmap()),
      Either3::C(image) => {
        if !image.complete {
          return Ok(());
        }
        image.regenerate_bitmap_if_need(env)?;
        if let Some(bitmap) = &mut image.bitmap {
          BitmapRef::Borrowed(bitmap)
        } else {
          return Ok(());
        }
      }
    };
    let bitmap_ref = bitmap.as_ref();
    let (sx, sy, s_width, s_height, dx, dy, d_width, d_height) =
      match (sx, sy, s_width, s_height, dx, dy, d_width, d_height) {
        (Some(dx), Some(dy), None, None, None, None, None, None) => (
          0.0,
          0.0,
          bitmap_ref.0.width as f32,
          bitmap_ref.0.height as f32,
          dx as f32,
          dy as f32,
          bitmap_ref.0.width as f32,
          bitmap_ref.0.height as f32,
        ),
        (Some(dx), Some(dy), Some(d_width), Some(d_height), None, None, None, None) => (
          0.0,
          0.0,
          bitmap_ref.0.width as f32,
          bitmap_ref.0.height as f32,
          dx as f32,
          dy as f32,
          d_width as f32,
          d_height as f32,
        ),
        (
          Some(sx),
          Some(sy),
          Some(s_width),
          Some(s_height),
          Some(dx),
          Some(dy),
          Some(d_width),
          Some(d_height),
        ) => (
          sx as f32,
          sy as f32,
          s_width as f32,
          s_height as f32,
          dx as f32,
          dy as f32,
          d_width as f32,
          d_height as f32,
        ),
        _ => return Ok(()),
      };
    self.context.draw_image(
      bitmap_ref, sx, sy, s_width, s_height, dx, dy, d_width, d_height,
    )?;
    Ok(())
  }

  /// Draw another canvas, preserving vector graphics when possible.
  /// When the source canvas has recorded operations, this preserves the SkPicture
  /// representation without rasterization. Falls back to bitmap if no picture available.
  #[napi]
  pub fn draw_canvas(
    &mut self,
    canvas: &mut CanvasElement,
    sx: Option<f64>,
    sy: Option<f64>,
    s_width: Option<f64>,
    s_height: Option<f64>,
    dx: Option<f64>,
    dy: Option<f64>,
    d_width: Option<f64>,
    d_height: Option<f64>,
  ) -> Result<()> {
    let source_width = canvas.width as f32;
    let source_height = canvas.height as f32;

    // Get picture from source canvas (preserves vector graphics)
    // Note: We need mutable access to the source context to get the picture
    // This is safe because we have exclusive access to the CanvasElement
    let picture = canvas.ctx.context.get_picture();

    let picture = if let Some(pic) = picture {
      pic
    } else {
      // Fallback to bitmap if picture not available (e.g., SVG canvas or no deferred rendering)
      let bitmap = canvas.ctx.as_ref().context.surface.get_bitmap();
      let (sx, sy, s_width, s_height, dx, dy, d_width, d_height) =
        match (sx, sy, s_width, s_height, dx, dy, d_width, d_height) {
          (Some(dx), Some(dy), None, None, None, None, None, None) => (
            0.0,
            0.0,
            source_width,
            source_height,
            dx as f32,
            dy as f32,
            source_width,
            source_height,
          ),
          (Some(dx), Some(dy), Some(d_width), Some(d_height), None, None, None, None) => (
            0.0,
            0.0,
            source_width,
            source_height,
            dx as f32,
            dy as f32,
            d_width as f32,
            d_height as f32,
          ),
          (
            Some(sx),
            Some(sy),
            Some(s_width),
            Some(s_height),
            Some(dx),
            Some(dy),
            Some(d_width),
            Some(d_height),
          ) => (
            sx as f32,
            sy as f32,
            s_width as f32,
            s_height as f32,
            dx as f32,
            dy as f32,
            d_width as f32,
            d_height as f32,
          ),
          _ => return Ok(()),
        };
      return self.context.draw_image(
        &bitmap, sx, sy, s_width, s_height, dx, dy, d_width, d_height,
      );
    };

    // Parse parameters similar to drawImage
    let (sx, sy, s_width, s_height, dx, dy, d_width, d_height) =
      match (sx, sy, s_width, s_height, dx, dy, d_width, d_height) {
        (Some(dx), Some(dy), None, None, None, None, None, None) => (
          0.0,
          0.0,
          source_width,
          source_height,
          dx as f32,
          dy as f32,
          source_width,
          source_height,
        ),
        (Some(dx), Some(dy), Some(d_width), Some(d_height), None, None, None, None) => (
          0.0,
          0.0,
          source_width,
          source_height,
          dx as f32,
          dy as f32,
          d_width as f32,
          d_height as f32,
        ),
        (
          Some(sx),
          Some(sy),
          Some(s_width),
          Some(s_height),
          Some(dx),
          Some(dy),
          Some(d_width),
          Some(d_height),
        ) => (
          sx as f32,
          sy as f32,
          s_width as f32,
          s_height as f32,
          dx as f32,
          dy as f32,
          d_width as f32,
          d_height as f32,
        ),
        _ => return Ok(()),
      };

    self.context.draw_canvas(
      &picture, sx, sy, s_width, s_height, dx, dy, d_width, d_height,
    )?;
    Ok(())
  }

  #[napi]
  pub fn get_context_attributes(&self) -> ContextAttributes {
    ContextAttributes {
      alpha: self.context.alpha,
      desynchronized: false,
    }
  }

  #[napi]
  pub fn is_point_in_path(
    &self,
    x_or_path: Either<f64, &Path>,
    x_or_y: f64,
    y_or_fill_rule: Option<Either<f64, String>>,
    maybe_fill_rule: Option<String>,
  ) -> Result<bool> {
    let inverted = self.context.state.transform.invert();
    match x_or_path {
      Either::A(x) => {
        let mut x = x as f32;
        let mut y = x_or_y as f32;
        let fill_rule = y_or_fill_rule
          .and_then(|v| match v {
            Either::B(rule) => rule.parse().ok(),
            _ => None,
          })
          .unwrap_or(FillType::Winding);
        if let Some(inverted) = inverted {
          let (mapped_x, mapped_y) = inverted.map_points(x, y);
          x = mapped_x;
          y = mapped_y;
        }
        Ok(self.context.path.hit_test(x, y, fill_rule))
      }
      Either::B(path) => {
        let mut x = x_or_y as f32;
        let mut y = match y_or_fill_rule {
          Some(Either::A(y)) => y as f32,
          _ => {
            return Err(Error::new(
              Status::InvalidArg,
              "The y-axis coordinate of the point to check is missing".to_owned(),
            ));
          }
        };
        let fill_rule = maybe_fill_rule
          .and_then(|s| s.parse().ok())
          .unwrap_or(FillType::Winding);
        if let Some(inverted) = inverted {
          let (mapped_x, mapped_y) = inverted.map_points(x, y);
          x = mapped_x;
          y = mapped_y;
        }
        Ok(path.inner.hit_test(x, y, fill_rule))
      }
    }
  }

  #[napi]
  pub fn is_point_in_stroke(
    &self,
    x_or_path: Either<f64, &Path>,
    x_or_y: f64,
    maybe_y: Option<f64>,
  ) -> Result<bool> {
    let stroke_w = self.context.get_stroke_width();
    let inverted = self.context.state.transform.invert();
    match x_or_path {
      Either::A(x) => {
        let mut x = x as f32;
        let mut y = x_or_y as f32;
        if let Some(inverted) = inverted {
          let (mapped_x, mapped_y) = inverted.map_points(x, y);
          x = mapped_x;
          y = mapped_y;
        }
        Ok(self.context.path.stroke_hit_test(x, y, stroke_w))
      }
      Either::B(path) => {
        let mut x = x_or_y as f32;
        if let Some(y) = maybe_y {
          let mut y = y as f32;
          if let Some(inverted) = inverted {
            let (mapped_x, mapped_y) = inverted.map_points(x, y);
            x = mapped_x;
            y = mapped_y;
          }
          Ok(path.inner.stroke_hit_test(x, y, stroke_w))
        } else {
          Err(Error::new(
            Status::InvalidArg,
            "The y-axis coordinate of the point to check is missing".to_owned(),
          ))
        }
      }
    }
  }

  #[napi(return_if_invalid)]
  pub fn ellipse(
    &mut self,
    x: f64,
    y: f64,
    radius_x: f64,
    radius_y: f64,
    rotation: f64,
    start_angle: f64,
    end_angle: f64,
    anticlockwise: Option<bool>,
  ) {
    self.context.ellipse(
      x as f32,
      y as f32,
      radius_x as f32,
      radius_y as f32,
      rotation as f32,
      start_angle as f32,
      end_angle as f32,
      anticlockwise.unwrap_or(false),
    );
  }

  #[napi(return_if_invalid)]
  pub fn line_to(&mut self, x: f64, y: f64) {
    if !x.is_nan() && !x.is_infinite() && !y.is_nan() && !y.is_infinite() {
      self.context.path.line_to(x as f32, y as f32);
    }
  }

  #[napi]
  pub fn measure_text(&mut self, text: Unknown) -> Result<TextMetrics> {
    let text = text.coerce_to_string()?.into_utf8()?;
    let text = text.as_str()?;
    if text.is_empty() {
      return Ok(TextMetrics {
        actual_bounding_box_ascent: 0.0,
        actual_bounding_box_descent: 0.0,
        actual_bounding_box_left: 0.0,
        actual_bounding_box_right: 0.0,
        font_bounding_box_ascent: 0.0,
        font_bounding_box_descent: 0.0,
        alphabetic_baseline: 0.0,
        em_height_ascent: 0.0,
        em_height_descent: 0.0,
        width: 0.0,
      });
    }
    let metrics = self.context.get_line_metrics(text)?;
    Ok(TextMetrics {
      actual_bounding_box_ascent: metrics.0.ascent as f64,
      actual_bounding_box_descent: metrics.0.descent as f64,
      actual_bounding_box_left: metrics.0.left as f64,
      actual_bounding_box_right: metrics.0.right as f64,
      font_bounding_box_ascent: metrics.0.font_ascent as f64,
      font_bounding_box_descent: metrics.0.font_descent as f64,
      alphabetic_baseline: metrics.0.alphabetic_baseline as f64,
      em_height_ascent: metrics.0.font_ascent as f64,
      em_height_descent: metrics.0.font_descent as f64,
      width: metrics.0.width as f64,
    })
  }

  #[napi(return_if_invalid)]
  pub fn move_to(&mut self, x: f64, y: f64) {
    if !x.is_nan() && !x.is_infinite() && !y.is_nan() && !y.is_infinite() {
      self.context.path.move_to(x as f32, y as f32);
    }
  }

  #[napi(return_if_invalid)]
  pub fn fill_rect(&mut self, x: f64, y: f64, width: f64, height: f64) -> Result<()> {
    if !x.is_nan()
      && !x.is_infinite()
      && !y.is_nan()
      && !y.is_infinite()
      && !width.is_nan()
      && !width.is_infinite()
      && !height.is_nan()
      && !height.is_infinite()
    {
      self
        .context
        .fill_rect(x as f32, y as f32, width as f32, height as f32)?;
    }
    Ok(())
  }

  #[napi(return_if_invalid)]
  pub fn fill_text(&mut self, text: Unknown, x: f64, y: f64, max_width: Option<f64>) -> Result<()> {
    let text = text.coerce_to_string()?.into_utf8()?;
    let text = text.as_str()?;
    if text.is_empty() {
      return Ok(());
    }
    if !x.is_nan() && !x.is_infinite() && !y.is_nan() && !y.is_infinite() {
      self.context.fill_text(
        text,
        x as f32,
        y as f32,
        max_width.map(|f| f as f32).unwrap_or(MAX_TEXT_WIDTH),
      )?;
    }
    Ok(())
  }

  #[napi]
  pub fn stroke(&mut self, path: Option<&mut Path>) -> Result<()> {
    self.context.stroke(path.map(|p| &mut p.inner))?;
    Ok(())
  }

  #[napi(return_if_invalid)]
  pub fn stroke_rect(&mut self, x: f64, y: f64, width: f64, height: f64) -> Result<()> {
    if !x.is_nan()
      && !x.is_infinite()
      && !y.is_nan()
      && !y.is_infinite()
      && !width.is_nan()
      && !width.is_infinite()
      && !height.is_nan()
      && !height.is_infinite()
    {
      self
        .context
        .stroke_rect(x as f32, y as f32, width as f32, height as f32)?;
    }
    Ok(())
  }

  #[napi(return_if_invalid)]
  pub fn stroke_text(
    &mut self,
    text: Unknown,
    x: f64,
    y: f64,
    max_width: Option<f64>,
  ) -> Result<()> {
    let text = text.coerce_to_string()?.into_utf8()?;
    let text = text.as_str()?;
    if text.is_empty() {
      return Ok(());
    }
    if !x.is_nan() && !x.is_infinite() && !y.is_nan() && !y.is_infinite() {
      self.context.stroke_text(
        text,
        x as f32,
        y as f32,
        max_width.map(|v| v as f32).unwrap_or(MAX_TEXT_WIDTH),
      )?;
    }
    Ok(())
  }

  #[napi]
  pub fn get_image_data<'scope>(
    &'scope mut self,
    env: &'scope Env,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    color_space: Option<String>,
  ) -> Result<ClassInstance<'scope, ImageData>> {
    if !x.is_nan()
      && !x.is_infinite()
      && !y.is_nan()
      && !y.is_infinite()
      && !width.is_nan()
      && !width.is_infinite()
      && !height.is_nan()
      && !height.is_infinite()
    {
      let color_space = color_space
        .and_then(|cs| cs.parse().ok())
        .unwrap_or(ColorSpace::Srgb);
      // Per spec: if sw/sh is negative, flip the origin and use abs value
      let (sx, sw) = if width < 0.0 {
        (x + width, -width)
      } else {
        (x, width)
      };
      let (sy, sh) = if height < 0.0 {
        (y + height, -height)
      } else {
        (y, height)
      };
      let image_data = self
        .context
        .get_image_data(sx as f32, sy as f32, sw as f32, sh as f32, color_space)
        .ok_or_else(|| {
          Error::new(
            Status::GenericFailure,
            "Read pixels from canvas failed".to_string(),
          )
        })?;
      let mut data_object = Uint8ClampedSlice::from_data(env, image_data)?;
      let mut instance = ImageData {
        width: sw as usize,
        height: sh as usize,
        color_space,
        data: unsafe { data_object.as_mut() }.as_mut_ptr(),
      }
      .into_instance(env)?;
      instance.set_named_property("data", data_object)?;
      Ok(instance)
    } else {
      Err(Error::new(
        Status::InvalidArg,
        "The x, y, width, and height arguments must be finite numbers".to_owned(),
      ))
    }
  }

  #[napi]
  pub fn get_line_dash(&self) -> Vec<f64> {
    self
      .context
      .state
      .line_dash_list
      .iter()
      .map(|l| *l as f64)
      .collect()
  }

  #[napi]
  pub fn put_image_data(
    &mut self,
    image_data: &ImageData,
    dx: i32,
    dy: i32,
    dirty_x: Option<f64>,
    dirty_y: Option<f64>,
    dirty_width: Option<f64>,
    dirty_height: Option<f64>,
  ) {
    if let Some(dirty_x) = dirty_x {
      let mut dirty_x = dirty_x as f32;
      let mut dirty_y = dirty_y.map(|d| d as f32).unwrap_or(0.0);
      let mut dirty_width = dirty_width
        .map(|d| d as f32)
        .unwrap_or(image_data.width as f32);
      let mut dirty_height = dirty_height
        .map(|d| d as f32)
        .unwrap_or(image_data.height as f32);
      // as per https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-putimagedata
      if dirty_width < 0f32 {
        dirty_x += dirty_width;
        dirty_width = dirty_width.abs();
      }
      if dirty_height < 0f32 {
        dirty_y += dirty_height;
        dirty_height = dirty_height.abs();
      }
      if dirty_x < 0f32 {
        dirty_width += dirty_x;
        dirty_x = 0f32;
      }
      if dirty_y < 0f32 {
        dirty_height += dirty_y;
        dirty_y = 0f32;
      }
      if dirty_width <= 0f32 || dirty_height <= 0f32 {
        return;
      }
      // Deferred mode: record via PageRecorder on a fresh layer (no clip/transform)
      // put_image_data uses drawImageRect with kSrc blend (pixel replacement),
      // which IS recordable by PictureRecorder unlike SkCanvas::writePixels.
      // snapshot=true: copy pixel data so the SkPicture is independent of the
      // JS buffer (required when the same ImageData is reused across calls).
      if let Some(ref recorder) = self.context.page_recorder {
        let dx_f = dx as f32;
        let color_space = image_data.color_space;
        recorder.borrow_mut().put_pixels(|canvas| {
          canvas.put_image_data(
            image_data,
            dx_f,
            dy as f32,
            dirty_x,
            dirty_y,
            dirty_width,
            dirty_height,
            color_space,
            true,
          );
        });
        return;
      }
      // Direct mode (SVG/PDF): write to surface canvas with inverted transform
      // snapshot=false: pixels are consumed immediately, no copy needed.
      let inverted = self.context.surface.canvas.get_transform_matrix().invert();
      self.context.surface.canvas.save();
      if let Some(inverted) = inverted {
        self.context.surface.canvas.concat(&inverted);
      };
      self.context.surface.canvas.put_image_data(
        image_data,
        dx as f32,
        dy as f32,
        dirty_x,
        dirty_y,
        dirty_width,
        dirty_height,
        image_data.color_space,
        false,
      );
      self.context.surface.canvas.restore();
    } else {
      // Deferred mode: use put_image_data with full image dimensions
      // because write_pixels (SkCanvas::writePixels) is NOT recordable by PictureRecorder
      if let Some(ref recorder) = self.context.page_recorder {
        let dx_f = dx as f32;
        let dy_f = dy as f32;
        let w = image_data.width as f32;
        let h = image_data.height as f32;
        let color_space = image_data.color_space;
        recorder.borrow_mut().put_pixels(|canvas| {
          canvas.put_image_data(image_data, dx_f, dy_f, 0.0, 0.0, w, h, color_space, true);
        });
        return;
      }
      // Direct mode (SVG/PDF): write pixels directly
      self.context.surface.canvas.write_pixels(image_data, dx, dy);
    }
  }

  #[napi(return_if_invalid)]
  pub fn set_line_dash(&mut self, dash_list: Vec<f64>) {
    let len = dash_list.len();
    let is_odd = len & 1 != 0;
    let mut line_dash_list = if is_odd {
      vec![0f32; len * 2]
    } else {
      vec![0f32; len]
    };
    for (idx, dash) in dash_list.iter().enumerate() {
      line_dash_list[idx] = *dash as f32;
      if is_odd {
        line_dash_list[idx + len] = *dash as f32;
      }
    }
    self.context.set_line_dash(line_dash_list);
  }

  #[napi]
  pub fn reset_transform(&mut self) {
    self.context.reset_transform();
  }

  #[napi(return_if_invalid)]
  pub fn translate(&mut self, x: f64, y: f64) {
    self.context.translate(x as f32, y as f32);
  }

  #[napi(return_if_invalid)]
  pub fn transform(&mut self, a: f64, b: f64, c: f64, d: f64, e: f64, f: f64) -> Result<()> {
    let ts = Matrix::new(a as f32, c as f32, e as f32, b as f32, d as f32, f as f32);
    self.context.transform(ts)?;
    Ok(())
  }

  #[napi]
  pub fn get_transform(&self) -> TransformObject {
    self.context.state.transform.get_transform().into()
  }

  #[napi]
  pub fn set_transform(
    &mut self,
    a_or_transform: Either<f64, TransformObject>,
    b: Option<f64>,
    c: Option<f64>,
    d: Option<f64>,
    e: Option<f64>,
    f: Option<f64>,
  ) -> Option<()> {
    let ts = match a_or_transform {
      Either::A(a) => Transform::new(
        a as f32, c? as f32, e? as f32, b? as f32, d? as f32, f? as f32,
      ),
      Either::B(transform) => transform.into_context_transform(),
    };
    self
      .context
      .set_transform(Matrix::new(ts.a, ts.b, ts.c, ts.d, ts.e, ts.f));
    None
  }

  /// Annotate a rectangular region with a clickable URL link (for PDF documents)
  #[napi]
  pub fn annotate_link_url(&self, left: f64, top: f64, right: f64, bottom: f64, url: String) {
    self
      .context
      .annotate_link_url(left, top, right, bottom, url);
  }

  /// Create a named destination at a specific point (for PDF documents)
  #[napi]
  pub fn annotate_named_destination(&self, x: f64, y: f64, name: String) {
    self.context.annotate_named_destination(x, y, name);
  }

  /// Annotate a rectangular region with a link to a named destination (for PDF documents)
  #[napi]
  pub fn annotate_link_to_destination(
    &self,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    name: String,
  ) {
    self
      .context
      .annotate_link_to_destination(left, top, right, bottom, name);
  }
}

enum BitmapRef<'a> {
  Borrowed(&'a mut Bitmap),
  Owned(Bitmap),
}

impl AsRef<Bitmap> for BitmapRef<'_> {
  fn as_ref(&self) -> &Bitmap {
    match self {
      BitmapRef::Borrowed(bitmap) => bitmap,
      BitmapRef::Owned(bitmap) => bitmap,
    }
  }
}

#[napi(object)]
pub struct TextMetrics {
  pub actual_bounding_box_ascent: f64,
  pub actual_bounding_box_descent: f64,
  pub actual_bounding_box_left: f64,
  pub actual_bounding_box_right: f64,
  pub font_bounding_box_ascent: f64,
  pub font_bounding_box_descent: f64,
  pub alphabetic_baseline: f64,
  pub em_height_ascent: f64,
  pub em_height_descent: f64,
  pub width: f64,
}

#[napi(object)]
pub struct TransformObject {
  pub a: f64,
  pub b: f64,
  pub c: f64,
  pub d: f64,
  pub e: f64,
  pub f: f64,
}

impl TransformObject {
  pub(crate) fn into_context_transform(self) -> Transform {
    Transform::new(
      self.a as f32,
      self.c as f32,
      self.e as f32,
      self.b as f32,
      self.d as f32,
      self.f as f32,
    )
  }
}

impl From<TransformObject> for Transform {
  fn from(value: TransformObject) -> Self {
    Self::new(
      value.a as f32,
      value.b as f32,
      value.c as f32,
      value.d as f32,
      value.e as f32,
      value.f as f32,
    )
  }
}

impl From<Transform> for TransformObject {
  fn from(value: Transform) -> Self {
    Self {
      a: value.a as f64,
      b: value.b as f64,
      c: value.c as f64,
      d: value.d as f64,
      e: value.e as f64,
      f: value.f as f64,
    }
  }
}

pub enum ContextData {
  Png(SurfaceRef),
  Jpeg(SurfaceRef, u8),
  Webp(SurfaceRef, u8),
  Avif(SurfaceRef, Config, u32, u32),
  Gif(SurfaceRef, GifConfig, u32, u32),
}

pub enum ContextOutputData {
  Skia(SkiaDataRef),
  Avif(AvifData<'static>),
  Gif(Vec<u8>),
}

impl ContextOutputData {
  pub(crate) fn into_buffer_slice<'a>(self, env: Env) -> Result<BufferSlice<'a>> {
    match self {
      ContextOutputData::Skia(output) => unsafe {
        BufferSlice::from_external(&env, output.0.ptr, output.0.size, output, |_, data_ref| {
          mem::drop(data_ref)
        })
      },
      ContextOutputData::Avif(output) => unsafe {
        BufferSlice::from_external(
          &env,
          output.as_ptr().cast_mut(),
          output.len(),
          output,
          |_, data_ref| mem::drop(data_ref),
        )
      },
      ContextOutputData::Gif(output) => unsafe {
        BufferSlice::from_external(
          &env,
          output.as_ptr().cast_mut(),
          output.len(),
          output,
          |_, data_ref| mem::drop(data_ref),
        )
      },
    }
  }
}

#[inline]
pub(crate) fn encode_surface(data: &ContextData) -> Result<ContextOutputData> {
  match data {
    ContextData::Png(surface) => surface
      .png_data()
      .map(ContextOutputData::Skia)
      .ok_or_else(|| {
        Error::new(
          Status::GenericFailure,
          "Get png data from surface failed".to_string(),
        )
      }),
    ContextData::Jpeg(surface, quality) => surface
      .encode_data(SkEncodedImageFormat::Jpeg, *quality)
      .map(ContextOutputData::Skia)
      .ok_or_else(|| {
        Error::new(
          Status::GenericFailure,
          "Get jpeg data from surface failed".to_string(),
        )
      }),
    ContextData::Webp(surface, quality) => surface
      .encode_data(SkEncodedImageFormat::Webp, *quality)
      .map(ContextOutputData::Skia)
      .ok_or_else(|| {
        Error::new(
          Status::GenericFailure,
          "Get webp data from surface failed".to_string(),
        )
      }),
    ContextData::Avif(surface, config, width, height) => surface
      .data()
      .ok_or_else(|| {
        Error::new(
          Status::GenericFailure,
          "Get avif data from surface failed".to_string(),
        )
      })
      .and_then(|(data, size)| {
        crate::avif::encode(
          unsafe { slice::from_raw_parts(data, size) },
          *width,
          *height,
          config,
        )
        .map(ContextOutputData::Avif)
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))
      }),
    ContextData::Gif(surface, config, width, height) => {
      crate::gif::encode_surface(surface, *width, *height, config)
        .map(ContextOutputData::Gif)
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))
    }
  }
}

unsafe impl Send for ContextOutputData {}
unsafe impl Sync for ContextOutputData {}

impl Task for ContextData {
  type Output = ContextOutputData;
  type JsValue = Buffer;

  fn compute(&mut self) -> Result<Self::Output> {
    encode_surface(self)
  }

  fn resolve(&mut self, env: Env, output_data: Self::Output) -> Result<Self::JsValue> {
    output_data
      .into_buffer_slice(env)
      .and_then(|slice| slice.into_buffer(&env))
  }
}

/// Blink's `ClampTo<float>` (platform/wtf/math_extras.h:314-322 -> :192-206):
/// a finite double outside the float range saturates at +/-FLT_MAX. A plain
/// `as f32` would overflow it to an infinity instead, which every downstream
/// Skia filter then rejects.
fn clamp_to_f32(value: f64) -> f32 {
  value.clamp(f32::MIN as f64, f32::MAX as f64) as f32
}

fn parse_css_size(css_size: &str) -> Option<f32> {
  if css_size.ends_with('%') {
    return css_size
      .parse::<f32>()
      .map(|v| v / 100.0 * FONT_MEDIUM_PX)
      .ok();
  } else if let Some(captures) = CSS_SIZE_REGEXP.captures(css_size) {
    return captures.get(1).and_then(|size| {
      captures.get(2).and_then(|unit| {
        Some(parse_size_px(
          size.as_str().parse::<f32>().ok()?,
          unit.as_str(),
        ))
      })
    });
  }
  None
}

fn parse_font_variation_settings(settings: &str) -> (String, Vec<crate::sk::FontVariation>) {
  let trimmed = settings.trim();
  if trimmed.eq_ignore_ascii_case("normal") || trimmed.is_empty() {
    return ("normal".to_owned(), vec![]);
  }

  let mut variations: Vec<crate::sk::FontVariation> = Vec::new();
  let mut valid = true;

  for part in trimmed.split(',') {
    let part = part.trim();
    if part.is_empty() {
      continue;
    }

    let mut chars = part.chars();
    let first = chars.next();
    let quote = match first {
      Some('\'') => '\'',
      Some('"') => '"',
      _ => {
        valid = false;
        break;
      }
    };

    let mut tag_str = String::new();
    let mut closed = false;
    for c in chars.by_ref() {
      if c == quote {
        closed = true;
        break;
      }
      tag_str.push(c);
    }

    if !closed || tag_str.len() != 4 || !tag_str.is_ascii() {
      valid = false;
      break;
    }

    let rest: String = chars.collect();
    let val_str = rest.trim();
    let val = match val_str.parse::<f32>() {
      Ok(v) => v,
      Err(_) => {
        valid = false;
        break;
      }
    };

    let bytes = tag_str.as_bytes();
    let tag = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);

    if let Some(existing) = variations.iter_mut().find(|v| v.tag == tag) {
      existing.value = val;
    } else {
      variations.push(crate::sk::FontVariation { tag, value: val });
    }
  }

  if !valid {
    return (settings.to_owned(), vec![]);
  }

  (settings.to_owned(), variations)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_parse_font_variation_settings_normal() {
    let (settings, variations) = parse_font_variation_settings("normal");
    assert_eq!(settings, "normal");
    assert!(variations.is_empty());

    let (settings, variations) = parse_font_variation_settings("NORMAL");
    assert_eq!(settings, "normal");
    assert!(variations.is_empty());
  }

  #[test]
  fn test_parse_font_variation_settings_single() {
    let (settings, variations) = parse_font_variation_settings("'wght' 700");
    assert_eq!(settings, "'wght' 700");
    assert_eq!(variations.len(), 1);
    assert_eq!(variations[0].tag, 0x77676874); // 'wght'
    assert_eq!(variations[0].value, 700.0);
  }

  #[test]
  fn test_parse_font_variation_settings_multiple() {
    let (settings, variations) = parse_font_variation_settings("'wght' 700, 'wdth' 50");
    assert_eq!(settings, "'wght' 700, 'wdth' 50");
    assert_eq!(variations.len(), 2);
    assert_eq!(variations[0].tag, 0x77676874); // 'wght'
    assert_eq!(variations[0].value, 700.0);
    assert_eq!(variations[1].tag, 0x77647468); // 'wdth'
    assert_eq!(variations[1].value, 50.0);
  }

  #[test]
  fn test_parse_font_variation_settings_double_quotes() {
    let (settings, variations) = parse_font_variation_settings("\"wght\" 700");
    assert_eq!(settings, "\"wght\" 700");
    assert_eq!(variations.len(), 1);
    assert_eq!(variations[0].tag, 0x77676874); // 'wght'
    assert_eq!(variations[0].value, 700.0);
  }

  #[test]
  fn test_parse_font_variation_settings_whitespace() {
    let (settings, variations) = parse_font_variation_settings("  'wght'  700  ,  'wdth'  50  ");
    assert_eq!(settings, "  'wght'  700  ,  'wdth'  50  ");
    assert_eq!(variations.len(), 2);
    assert_eq!(variations[0].tag, 0x77676874);
    assert_eq!(variations[0].value, 700.0);
    assert_eq!(variations[1].tag, 0x77647468);
    assert_eq!(variations[1].value, 50.0);
  }

  #[test]
  fn test_parse_font_variation_settings_invalid() {
    let (settings, variations) = parse_font_variation_settings("invalid");
    assert_eq!(settings, "invalid");
    assert!(variations.is_empty());

    let (settings, variations) = parse_font_variation_settings("'inv' 100"); // Tag too short
    assert_eq!(settings, "'inv' 100");
    assert!(variations.is_empty());

    let (settings, variations) = parse_font_variation_settings("'wght' 100, invalid"); // One invalid part
    assert_eq!(settings, "'wght' 100, invalid");
    assert!(variations.is_empty()); // Should fail completely
  }

  #[test]
  fn test_parse_font_variation_settings_repeated() {
    let (settings, variations) = parse_font_variation_settings("'wght' 100, 'wght' 200");
    assert_eq!(settings, "'wght' 100, 'wght' 200");
    assert_eq!(variations.len(), 1); // Deduplicated
    assert_eq!(variations[0].tag, 0x77676874);
    assert_eq!(variations[0].value, 200.0); // Last wins
  }

  #[test]
  fn test_parse_font_variation_settings_unknown_tag() {
    let (settings, variations) = parse_font_variation_settings("'abcd' 123");
    assert_eq!(settings, "'abcd' 123");
    assert_eq!(variations.len(), 1);
    assert_eq!(variations[0].tag, 0x61626364); // 'abcd'
    assert_eq!(variations[0].value, 123.0);
  }

  #[test]
  fn test_parse_font_variation_settings_numeric() {
    let (settings, variations) = parse_font_variation_settings("'wght' 123.45, 'slnt' -10");
    assert_eq!(settings, "'wght' 123.45, 'slnt' -10");
    assert_eq!(variations.len(), 2);
    assert_eq!(variations[0].value, 123.45);
    assert_eq!(variations[1].value, -10.0);
  }

  #[test]
  fn test_parse_font_variation_settings_complex_quoting() {
    let (settings, variations) = parse_font_variation_settings(r#"'wght' 400, "wdth" 50"#);
    assert_eq!(settings, r#"'wght' 400, "wdth" 50"#);
    assert_eq!(variations.len(), 2);
    assert_eq!(variations[0].tag, 0x77676874);
    assert_eq!(variations[1].tag, 0x77647468);
  }
}
