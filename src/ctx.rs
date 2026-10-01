use std::cell::{Cell, RefCell};
use std::f32::consts::PI;
use std::mem;
use std::result;
use std::str::FromStr;
use std::sync::LazyLock;

use cssparser::Parser;
use cssparser_color::{Color as CSSColor, hsl_to_rgb};
use libavif::AvifData;
use napi::{JsString, bindgen_prelude::*};
use regex::Regex;
use rgb::RGBA;

use crate::font::FONT_MEDIUM_PX;
use crate::font::parse_size_px;
use crate::gif::GifConfig;
use crate::global_fonts::get_font;
use crate::page_recorder::{PageRecorder, RasterKey, next_resource_id};
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
    MaskFilter, Matrix, Paint, PaintStyle, Path as SkPath, PathEffect, PathOp,
    SkEncodedImageFormat, SkImage, SkWMemoryStream, SkiaDataRef, Surface, Transform,
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

/// Where the draw casting the shadow gets its colour from. `shadow_paint` is
/// handed a finished `Paint`, which exposes no "has a shader" query across the
/// FFI, so the caller states which style it built the paint from.
#[derive(Clone, Copy)]
pub(crate) enum ShadowSource {
  /// Built by `fill_paint` -- `state.fill_style` decides.
  Fill,
  /// Built by `stroke_paint` -- `state.stroke_style` decides.
  Stroke,
  /// `drawImage` / `drawCanvas`. Never a solid colour: the source alpha varies
  /// per pixel, so the kSrcIn colourisation is not a constant.
  Image,
}

impl ShadowSource {
  /// True when the shadow's source is one flat colour with no shader, i.e. when
  /// `SkColorFilters::Blend(shadowColor, kSrcIn)` reduces to a paint colour.
  fn is_solid_color(self, state: &Context2dRenderingState) -> bool {
    match self {
      ShadowSource::Fill => matches!(state.fill_style, Pattern::Color(..)),
      ShadowSource::Stroke => matches!(state.stroke_style, Pattern::Color(..)),
      ShadowSource::Image => false,
    }
  }

  /// True when this source forces the drop-shadow image filter even at zero
  /// blur, matching Blink's `kNonOpaqueImage` fork
  /// (canvas_rendering_context_2d_state.cc:849-864): only that route resamples a
  /// fractional offset.
  fn forces_shadow_image_filter(self) -> bool {
    matches!(self, ShadowSource::Image)
  }
}

/// What a draw lays down on the device. Stated by every draw site, since
/// `ShadowSource` cannot answer it (`fillText` and `fillRect` are both `Fill`).
/// `filter_takes_layer` is the only reader; `draw_text` is the only `Glyphs`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DrawContent {
  Geometry,
  Glyphs,
}

/// Which Skia device the `Context`'s surface is backed by. Stated by the
/// constructor, because the two vector backends differ in `filter_takes_layer`
/// and no other field distinguishes them.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Backend {
  /// `Context::new`. The only backend with `page_recorder: Some`.
  Raster,
  /// `Context::new_svg`: `SkSVGDevice`.
  Svg,
  /// `Context::new_from_surface`: `SkPDFDevice`, one per page.
  Pdf,
}

/// The shadow half of a draw, as `shadow_paint` builds it. `paint` draws the
/// shadow's source and must carry no image filter; `filter`, when present, is
/// the drop-shadow graph and belongs on a layer of its own, because the two need
/// different matrices. See `Context::composited_filter_layer`.
pub(crate) struct ShadowDraw {
  paint: Paint,
  filter: Option<ImageFilter>,
}

// The same, borrowed, plus what `render_canvas` needs to size the shadow layer.
struct ShadowPass<'a> {
  paint: &'a Paint,
  filter: Option<&'a ImageFilter>,
  offset_x: f32,
  offset_y: f32,
  blur: f32,
}

pub struct Context {
  pub(crate) surface: Surface,
  /// Unique identity for retained-raster dedup keys; survives the backing
  /// SkSurface's lifetime so a recycled pointer can never alias it.
  pub(crate) resource_id: u64,
  pub(crate) page_recorder: Option<RefCell<PageRecorder>>, // Deferred rendering recorder (RefCell for interior mutability)
  /// Which device `surface` is over. Set once by the constructor.
  pub(crate) backend: Backend,
  path: SkPath,
  pub alpha: bool,
  pub(crate) states: Vec<Context2dRenderingState>,
  state: Context2dRenderingState,
  pub width: u32,
  pub height: u32,
  pub color_space: ColorSpace,
  pub stream: Option<SkWMemoryStream>,
  /// Content generation for backends without a recorder (SVG, PDF) and for
  /// raster writes that bypass it. The raster backend's canonical generation
  /// lives in PageRecorder::content_version; this only feeds
  /// Context::content_version when no recorder exists. Cell so `&self`
  /// surface writers (annotate_*) can still bump it.
  direct_content_version: Cell<u64>,
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
      resource_id: next_resource_id(),
      page_recorder: None, // SVG uses direct rendering
      backend: Backend::Svg,
      alpha: true,
      path: SkPath::new(),
      states: vec![],
      state: Context2dRenderingState::default(),
      width,
      height,
      color_space,
      stream: Some(stream),
      direct_content_version: Cell::new(0),
    })
  }

  pub fn new(width: u32, height: u32, color_space: ColorSpace) -> Result<Self> {
    let surface = Surface::new_rgba_premultiplied(width, height, color_space)
      .ok_or_else(|| Error::from_reason("Create skia surface failed".to_owned()))?;
    Ok(Context {
      surface,
      resource_id: next_resource_id(),
      page_recorder: Some(RefCell::new(PageRecorder::new(width as f32, height as f32))), // Enable deferred rendering
      backend: Backend::Raster,
      alpha: true,
      path: SkPath::new(),
      states: vec![],
      state: Context2dRenderingState::default(),
      width,
      height,
      color_space,
      stream: None,
      direct_content_version: Cell::new(0),
    })
  }

  // Create a Context from an existing Surface (e.g., from PDFDocument)
  pub(crate) fn new_from_surface(surface: Surface, width: u32, height: u32) -> Self {
    Context {
      surface,
      resource_id: next_resource_id(),
      page_recorder: None, // PDF uses direct rendering
      backend: Backend::Pdf,
      alpha: true,
      path: SkPath::new(),
      states: vec![],
      state: Context2dRenderingState::default(),
      width,
      height,
      color_space: ColorSpace::default(),
      stream: None,
      direct_content_version: Cell::new(0),
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

  /// Content generation for retained-raster dedup keys (drawImage canvas
  /// sources): bumps on every recorded mutation, so each COW snapshot
  /// generation of a surface draws under a fresh key. Backends without a
  /// recorder report their direct-write generation instead.
  pub(crate) fn content_version(&self) -> u64 {
    self
      .page_recorder
      .as_ref()
      .map(|recorder| recorder.borrow().content_version())
      .unwrap_or_else(|| self.direct_content_version.get())
  }

  /// Bump the content generation for a surface write that bypassed the
  /// recording (Lottie frame render, `alpha: false` base fill, direct-mode
  /// SVG/PDF ops). The write COWs the surface raster exactly like a recorded
  /// op does, so an unchanged generation would let a dest dedup key alias
  /// the new raster under the old charge.
  pub(crate) fn note_direct_mutation(&self) {
    if let Some(ref recorder) = self.page_recorder {
      recorder.borrow_mut().note_direct_mutation();
    } else {
      self
        .direct_content_version
        .set(self.direct_content_version.get() + 1);
    }
  }

  /// Run `f` directly on the surface canvas. Flushes the deferred recording
  /// first so pending ops land UNDER the direct write, then marks the
  /// recorder dirty-by-surface-write (the write bypassed the recording, so
  /// its flushed layers are stale). The rebase is LAZY: no surface snapshot
  /// is taken here -- the snapshot's raster retention would copy-on-write
  /// the whole surface on the very next direct write (a lottie frame loop
  /// paid a full-canvas COW per frame). The snapshot materializes only when
  /// a read-out actually needs the picture (Context::get_picture). For
  /// content writers only -- reads (get_bitmap, read_pixels) need the flush
  /// but not the sync.
  pub(crate) fn with_surface_canvas<F>(&mut self, f: F)
  where
    F: FnOnce(&mut Canvas),
  {
    self.flush();
    f(&mut self.surface.canvas);
    if let Some(ref recorder) = self.page_recorder {
      recorder.borrow_mut().note_surface_write();
    }
    self.note_direct_mutation();
  }

  /// Flush the deferred recording once it exceeds MAX_RECORDED_BYTES, bounding
  /// its memory in pure draw loops that never read back
  /// (https://github.com/Brooooooklyn/canvas/issues/1342). Mirrors Blink's
  /// MemoryManagedPaintRecorder::FlushIfRecordingLimitExceeded
  /// (memory_managed_paint_recorder.cc), which caps recorded op bytes.
  ///
  /// Only call at a public-entry-point boundary -- at the top, to bound
  /// accumulation between ops, and at the bottom, so an op whose own charge
  /// trips the cap (a single putImageData can pin ~256 MiB of copied pixels)
  /// consolidates immediately instead of staying pinned while the context
  /// sits idle. Never inside a shared helper mid-sequence, where
  /// resume_recording would re-emit state synced for a previous op.
  fn flush_if_recording_limit_exceeded(&mut self) {
    let exceeded = self
      .page_recorder
      .as_ref()
      .map(|recorder| recorder.borrow().recording_limit_exceeded())
      .unwrap_or(false);
    if exceeded {
      self.flush();
    }
  }

  /// Charge recorded bytes the per-op base estimate cannot see (path point
  /// data, nested pictures, text length) to the recorder's byte budget.
  fn account_recorded_bytes(&self, bytes: usize) {
    if let Some(ref recorder) = self.page_recorder {
      recorder.borrow_mut().account_recorded_bytes(bytes);
    }
  }

  /// Charge bytes that also count toward the recorder's retained-raster tally
  /// -- payloads a recorded picture pins that approximateBytesUsed cannot see
  /// (pixel copies, typeface refs). drawCanvas re-charges a source's retained
  /// raster bytes to the destination, so they must be tracked separately from
  /// plain record structure.
  fn account_raster_bytes(&self, bytes: usize) {
    if let Some(ref recorder) = self.page_recorder {
      recorder.borrow_mut().account_raster_bytes(bytes);
    }
  }

  /// Like account_raster_bytes but deduplicated by resource identity within
  /// the current recording window: redrawing one source pins one shared
  /// reference, not a new allocation per op. See RasterKey for the namespaced
  /// key type.
  fn account_raster_resource(&self, key: RasterKey, bytes: usize) {
    if let Some(ref recorder) = self.page_recorder {
      let mut rec = recorder.borrow_mut();
      rec.account_raster_resource(key, bytes);
    }
  }

  /// Charge the resources one recorded draw retains through its paint and
  /// pass structure. Called once per recording draw entry point -- it must
  /// NOT run in `fill_paint`/`stroke_paint` themselves, which non-recording
  /// callers (measureText's `get_line_metrics`, the `alpha: false` fill in
  /// `get_context`) also use and must stay side-effect free.
  ///
  ///   * An Image pattern's shader pins the whole backing bitmap, a Gradient
  ///     shader copies its stop arrays.
  ///   * A non-empty line dash copies the interval array into a fresh
  ///     PathEffect on every draw.
  ///   * `ctx.filter` rides the op's saveLayer paint as a chained
  ///     SkImageFilter, one node per CSS token (filter.rs `make_*` calls all
  ///     take `chained_filter`). The chain itself is refcounted, so the op
  ///     retains only a reference; charge `filters_string.len() * 8` as a
  ///     conservative proxy for the node's serialized size.
  ///   * An enabled shadow builds a fresh MaskFilter or DropShadowOnly image
  ///     filter per draw (`shadow_paint`); charge a flat 1 KB under the same
  ///     predicate `shadow_paint` uses to decide whether a shadow exists.
  fn account_paint_resources(&self, style: &Pattern) {
    // Everything below is retained THROUGH the recorded paint while
    // SkPicture::approximateBytesUsed cannot see the referenced objects, so
    // it all belongs to the propagated raster tally: an image pattern's
    // shader pins the whole backing raster, a gradient shader copies its
    // stop arrays into the fresh SkShader get_shader() builds per draw, and
    // a dash list is compiled into a fresh SkPathEffect per paint call
    // (fill_paint/stroke_paint). The fresh-object-per-draw property also
    // means these three are charged per draw with no dedup key.
    match style {
      Pattern::Image(image) => {
        // Keyed by the backing raster's identity: patterns over the same
        // Image share its Arc<AccountedBitmap> id and charge once; per-copy
        // backings get a fresh id at pattern construction. Generation 0 --
        // the pattern shader pins one captured raster for its lifetime.
        self.account_raster_resource(
          RasterKey::Resource {
            id: image.accounting_id,
            generation: 0,
          },
          image.estimated_bytes(),
        )
      }
      Pattern::Gradient(gradient) => self.account_raster_bytes(gradient.estimated_bytes()),
      Pattern::Color(..) => {}
    };
    // The ctx.filter chain is ONE refcounted ImageFilter stored on the state;
    // every recorded paint carries a shared ref to the same DAG, so charge it
    // once per window under its minted id. Generation 0: the chain object is
    // immutable until set_filter replaces it (which also replaces the id).
    if self.state.filter.is_some() {
      self.account_raster_resource(
        RasterKey::Resource {
          id: self.state.filter_id,
          generation: 0,
        },
        self.state.filters_string.len() * 8,
      );
    }
    let shadow_bytes = if self.state.shadow_color.a != 0
      && (self.state.shadow_blur != 0f32
        || self.state.shadow_offset_x != 0f32
        || self.state.shadow_offset_y != 0f32)
    {
      1024
    } else {
      0
    };
    // Fresh per draw (shadow_paint builds a fresh DropShadowOnly graph, the
    // dash list compiles into a fresh SkPathEffect): per-draw charge in the
    // propagated tally, no dedup.
    self.account_raster_bytes(shadow_bytes + self.state.line_dash_list.len() * 4);
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
    // Direct mode - use surface canvas. Every caller is a state-only op
    // (save/restore/transform/clip/reset state); none writes pixels, so the
    // content generation must not move -- a canvas-source dedup key would
    // churn on pure state churn. Context::reset() is the one pixel writer
    // through this funnel and bumps explicitly.
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
  ///
  /// NOT a filtered draw: `ctx.filter` is deliberately withheld. The only caller
  /// is `clearRect`, and handing the filter down would be destructive rather
  /// than redundant -- a kClear layer restores by clearing its whole bounds,
  /// wiping the canvas instead of the requested rect.
  fn with_render_canvas<F>(&mut self, paint: &Paint, f: F) -> result::Result<(), SkError>
  where
    F: Fn(&mut Canvas, &Paint) -> result::Result<(), SkError>,
  {
    // `DrawContent` only qualifies a filter, and there is none here, so it is
    // inert.
    self.render_passes(
      paint,
      DrawContent::Geometry,
      None,
      None,
      |_, _, _| Ok(()),
      f,
    )
  }

  /// The draws that also have a shadow pass, and that `ctx.filter` applies to.
  /// Both passes must be handed to `render_canvas` together so that it -- and
  /// only it -- decides whether an isolation layer is needed. `ctx.filter` is
  /// hoisted onto each pass's layer rather than left on the content paint, as
  /// Blink does (canvas_2d_recorder_context.h:956-957), except for the one
  /// vector-backend exception `render_passes` takes.
  fn with_shadowed_render_canvas<S, F>(
    &mut self,
    paint: &Paint,
    content: DrawContent,
    shadow: Option<&ShadowDraw>,
    shadow_f: S,
    f: F,
  ) -> result::Result<(), SkError>
  where
    S: Fn(&mut Canvas, &Paint, &Matrix) -> result::Result<(), SkError>,
    F: Fn(&mut Canvas, &Paint) -> result::Result<(), SkError>,
  {
    let content_filter = self.state.filter.clone();
    self.render_passes(paint, content, content_filter, shadow, shadow_f, f)
  }

  /// Shared body of the two above. The shadow closure is handed the user->device
  /// matrix as its third argument because it cannot read one off the canvas it
  /// is given -- that canvas may be a recorder at identity, or sit inside a
  /// filter layer. Pass it straight to `apply_shadow_offset_matrix_to_canvas`.
  fn render_passes<S, F>(
    &mut self,
    paint: &Paint,
    content: DrawContent,
    content_filter: Option<ImageFilter>,
    shadow: Option<&ShadowDraw>,
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

    // The vector-backend rescue. `composited_filter_layer`'s layer exists to
    // hand the filter device space, but on SVG / PDF it destroys the draw --
    // SkSVGDevice cannot make a layer device and the content vanishes,
    // SkPDFDevice rasterises it and the page stops being vector. A colour-only
    // filter never needed the layer, so it goes back on the content paint, which
    // Skia folds into the colour-filter slot with no layer at all.
    //
    // Deliberately NOT done on raster, where the layer is free and folding is
    // not a no-op for text, nor for a glyph run on PDF -- the only reason
    // `content` is threaded down here. `filter_takes_layer` decides, and is
    // shared with the shadow pass: both must agree on where the filter lives.
    let filtered_paint = content_filter.as_ref().and_then(|filter| {
      (!self.filter_takes_layer(content)).then(|| {
        let mut filtered_paint = paint.clone();
        filtered_paint.set_image_filter(filter);
        filtered_paint
      })
    });
    let content_filter = if filtered_paint.is_some() {
      None
    } else {
      content_filter
    };
    let paint = filtered_paint.as_ref().unwrap_or(paint);

    let shadow = shadow.map(|shadow| ShadowPass {
      paint: &shadow.paint,
      filter: shadow.filter.as_ref(),
      offset_x: self.state.shadow_offset_x,
      offset_y: self.state.shadow_offset_y,
      blur: self.state.shadow_blur,
    });

    // No recording-limit check here: callers charge the op's payload (path
    // points, image pixels, paint resources) before reaching render_passes,
    // so a flush inside this helper would consolidate and zero pending_bytes
    // BEFORE the op is recorded, erasing its charge. The check lives at the
    // top of every public recording entry point instead.
    //
    // composited_pass records an inner SkPicture per isolation layer (one for
    // the content pass, another for the shadow pass) which the outer record
    // pins via drawPicture; their approx_bytes_used is accumulated through
    // nested_picture_bytes and charged to the recorder once the op lands --
    // after, not before, since the pictures only exist if the draw succeeds.
    let mut nested_picture_bytes = 0usize;
    if let Some(ref recorder) = self.page_recorder {
      let mut rec = recorder.borrow_mut();
      if let Some(canvas) = rec.get_recording_canvas() {
        // Use the recording canvas for deferred mode
        let result = Self::render_canvas(
          canvas,
          paint,
          content_filter.as_ref(),
          blend_mode,
          width,
          height,
          shadow,
          &mut nested_picture_bytes,
          shadow_f,
          f,
        );
        // This funnel only serves pixel commits; a recorded draw is a new
        // content generation for canvas-source dedup keys.
        rec.note_paint_op();
        // Drop the RefMut before the charge borrows the recorder. The nested
        // isolation-layer pictures' bytes DO reach the outer picture's
        // approximateBytesUsed (SkRecordCanvas::onDrawPicture folds
        // pic->approximateBytesUsed into fApproxBytesUsedBySubPictures, which
        // finishRecordingAsPicture bakes in), and drawCanvas separately
        // charges approx_bytes_used + source_raster_bytes -- so this stays a
        // plain recorded-byte charge to pending_bytes only. Routing it to
        // raster_bytes double-counted it on every drawCanvas.
        drop(rec);
        self.account_recorded_bytes(nested_picture_bytes);
        return result;
      }
    }
    // Direct mode - use surface canvas
    let result = Self::render_canvas(
      &mut self.surface.canvas,
      paint,
      content_filter.as_ref(),
      blend_mode,
      width,
      height,
      shadow,
      &mut nested_picture_bytes,
      shadow_f,
      f,
    );
    self.note_direct_mutation();
    result
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
    self.flush_if_recording_limit_exceeded();
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
    // The recorded op pins a COW-shared SkPathData; charge it once per data
    // version and propagate it through the retained tally (RasterKey::Path).
    self.account_raster_resource(
      RasterKey::Path {
        data_id: clip_path.generation_id(),
      },
      clip_path.estimated_bytes(),
    );
    self.with_canvas_state(|canvas| {
      canvas.set_clip_path(&clip_path);
    });

    self.state.clip_path = Some(device_clip);
    self.sync_clip_to_recorder();
    self.flush_if_recording_limit_exceeded();
  }

  pub fn clear_rect(
    &mut self,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
  ) -> result::Result<(), SkError> {
    // A deterministically empty sorted span paints nothing: clearRect's own
    // draw goes through the plain arm of render_canvas (blend_mode stays
    // SourceOver -- only the paint is kClear), drawRect sorts its rect, and a
    // collapsed finite span covers no pixels either recorded or replayed.
    // Skipping keeps the op out of the recording so it cannot bump the
    // canvas-source dedup generation; the clip-level non-finite cases must
    // still record, since only a finite collapse is provably empty.
    if Self::sorted_span_empty(x, width) || Self::sorted_span_empty(y, height) {
      return Ok(());
    }
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
    self.flush_if_recording_limit_exceeded();
    let mut paint = Paint::new();
    paint.set_style(PaintStyle::Fill);
    paint.set_color(0, 0, 0, 0);
    paint.set_stroke_miter(10.0);
    paint.set_blend_mode(BlendMode::Clear);
    self.with_render_canvas(&paint, |canvas, paint| {
      canvas.draw_rect(x, y, width, height, paint);
      Ok(())
    })?;
    self.flush_if_recording_limit_exceeded();
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
    self.flush_if_recording_limit_exceeded();
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
    self.flush_if_recording_limit_exceeded();
  }

  pub fn restore(&mut self) {
    if let Some(s) = self.states.pop() {
      self.flush_if_recording_limit_exceeded();
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
      self.flush_if_recording_limit_exceeded();
    }
  }

  pub fn reset(&mut self) {
    // Clear the backing buffer to transparent black and reset canvas state
    self.with_canvas_state(|canvas| {
      canvas.clear();
      canvas.reset();
    });
    // The clear above wrote pixels directly on direct backends (the funnel
    // itself no longer bumps); in deferred mode recorder.reset() advances
    // the generation instead.
    if self.page_recorder.is_none() {
      self.note_direct_mutation();
    }

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
    self.flush_if_recording_limit_exceeded();
    // Paint construction is fallible (dash PathEffect, gradient shader); the
    // resource charge must land only once the op can actually record.
    let stroke_paint = self.stroke_paint()?;
    self.account_paint_resources(&self.state.stroke_style);

    // Extract state for shadow rendering to avoid borrow conflicts
    let shadow_paint =
      self.shadow_paint(&stroke_paint, ShadowSource::Stroke, DrawContent::Geometry);
    // Zero on the image-filter route, where the filter's dx/dy already carry it.
    let (shadow_offset_x, shadow_offset_y) =
      self.canvas_shadow_offset(ShadowSource::Stroke, DrawContent::Geometry);

    self.with_shadowed_render_canvas(
      &stroke_paint,
      DrawContent::Geometry,
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
    self.flush_if_recording_limit_exceeded();
    Ok(())
  }

  pub fn translate(&mut self, x: f32, y: f32) {
    self.flush_if_recording_limit_exceeded();
    let inverse = Matrix::translated(-x, -y);
    self.path.transform_self(&inverse);
    self.state.transform.pre_translate(x, y);
    let transform = self.state.transform.clone();
    self.with_canvas_state(|canvas| {
      canvas.set_transform(&transform);
    });
    self.sync_transform_to_recorder();
    self.flush_if_recording_limit_exceeded();
  }

  pub fn transform(&mut self, ts: Matrix) -> result::Result<(), SkError> {
    self.flush_if_recording_limit_exceeded();
    if let Some(inverse) = ts.invert() {
      self.path.transform_self(&inverse);
    }
    self.state.transform = ts.multiply(&self.state.transform);
    let transform = self.state.transform.clone();
    self.with_canvas_state(|canvas| {
      canvas.set_transform(&transform);
    });
    self.sync_transform_to_recorder();
    self.flush_if_recording_limit_exceeded();
    Ok(())
  }

  pub fn rotate(&mut self, angle: f32) {
    self.flush_if_recording_limit_exceeded();
    let degrees = angle / PI * 180f32;
    let inverse = Matrix::rotated(-angle, 0.0, 0.0);
    self.path.transform_self(&inverse);
    self.state.transform.pre_rotate(degrees);
    let transform = self.state.transform.clone();
    self.with_canvas_state(|canvas| {
      canvas.set_transform(&transform);
    });
    self.sync_transform_to_recorder();
    self.flush_if_recording_limit_exceeded();
  }

  pub fn scale(&mut self, x: f32, y: f32) {
    self.flush_if_recording_limit_exceeded();
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
    self.flush_if_recording_limit_exceeded();
  }

  pub fn set_transform(&mut self, ts: Matrix) {
    self.flush_if_recording_limit_exceeded();
    self.state.transform = ts.clone();
    self.with_canvas_state(|canvas| {
      canvas.set_transform(&ts);
    });
    self.sync_transform_to_recorder();
    self.flush_if_recording_limit_exceeded();
  }

  pub fn reset_transform(&mut self) {
    self.flush_if_recording_limit_exceeded();
    self.state.transform = Matrix::identity();
    self.with_canvas_state(|canvas| {
      canvas.reset_transform();
    });
    self.sync_transform_to_recorder();
    self.flush_if_recording_limit_exceeded();
  }

  pub fn stroke_text(
    &mut self,
    text: &str,
    x: f32,
    y: f32,
    max_width: f32,
  ) -> result::Result<(), SkError> {
    self.flush_if_recording_limit_exceeded();
    let stroke_paint = self.stroke_paint()?;
    let variations = self.state.font_variations.clone();
    self.draw_text(
      text.replace('\n', " ").as_str(),
      x,
      y,
      max_width,
      &stroke_paint,
      ShadowSource::Stroke,
      &variations,
    )?;
    Ok(())
  }

  pub fn fill_rect(&mut self, x: f32, y: f32, w: f32, h: f32) -> result::Result<(), SkError> {
    self.flush_if_recording_limit_exceeded();
    let fill_paint = self.fill_paint()?;

    // Extract state for shadow rendering to avoid borrow conflicts
    let shadow_paint = self.shadow_paint(&fill_paint, ShadowSource::Fill, DrawContent::Geometry);

    // A rect with no fillable area cannot paint a pixel (Skia checks
    // fillable() on the sorted rect in onDrawRect's internalQuickReject;
    // SkRecordCanvas records it anyway, but only coverage-bearing ops can
    // ever produce output). Skip before account_paint_resources so a
    // zero-area fillRect cannot pin/charge an image-pattern raster
    // (issue #1342): sorted endpoints because drawRect calls makeSorted(),
    // so negative w/h still draws and must NOT be skipped.
    if !(Self::sorted_span_fillable(x, w) && Self::sorted_span_fillable(y, h))
      && self.empty_geometry_is_skippable(shadow_paint.is_some())
    {
      return Ok(());
    }

    self.account_paint_resources(&self.state.fill_style);
    // Zero on the image-filter route, where the filter's dx/dy already carry it.
    let (shadow_offset_x, shadow_offset_y) =
      self.canvas_shadow_offset(ShadowSource::Fill, DrawContent::Geometry);

    self.with_shadowed_render_canvas(
      &fill_paint,
      DrawContent::Geometry,
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
    self.flush_if_recording_limit_exceeded();
    Ok(())
  }

  pub fn fill_text(
    &mut self,
    text: &str,
    x: f32,
    y: f32,
    max_width: f32,
  ) -> result::Result<(), SkError> {
    self.flush_if_recording_limit_exceeded();
    let fill_paint = self.fill_paint()?;
    let variations = self.state.font_variations.clone();
    self.draw_text(
      text.replace('\n', " ").as_str(),
      x,
      y,
      max_width,
      &fill_paint,
      ShadowSource::Fill,
      &variations,
    )?;
    Ok(())
  }

  pub fn stroke(&mut self, path: Option<&mut SkPath>) -> Result<()> {
    self.flush_if_recording_limit_exceeded();
    let stroke_paint = self.stroke_paint()?;

    // Clone the path to avoid borrow conflicts with with_render_canvas
    let path_to_draw = match path {
      Some(p) => p.clone(),
      None => self.path.clone(),
    };

    // Extract state for shadow rendering to avoid borrow conflicts
    let shadow_paint =
      self.shadow_paint(&stroke_paint, ShadowSource::Stroke, DrawContent::Geometry);

    // A path with no verbs has no geometry at all: stroke caps need a
    // moveTo'd point to mark, so a verb-less stroke paints nothing in
    // Skia regardless of width, cap or dash. Skip before the paint charge
    // (issue #1342). Bounds alone cannot drive this: SkPath::getBounds()
    // returns the finite {0,0,0,0} for empty AND non-finite paths, so a
    // degenerate-bounds check would also swallow moveTo-only paths whose
    // caps CAN paint -- is_empty() is the only deterministic predicate.
    if path_to_draw.is_empty() && self.empty_geometry_is_skippable(shadow_paint.is_some()) {
      return Ok(());
    }

    self.account_paint_resources(&self.state.stroke_style);
    // Zero on the image-filter route, where the filter's dx/dy already carry it.
    let (shadow_offset_x, shadow_offset_y) =
      self.canvas_shadow_offset(ShadowSource::Stroke, DrawContent::Geometry);

    // The recorded op pins the path's SkPathData (COW-shared with
    // path_to_draw); charge its byte payload once per data version and let
    // it propagate through the retained tally (RasterKey::Path) -- the same
    // data drawn N times pins ~1x, not Nx, and a drawCanvas destination
    // inherits the charge.
    self.account_raster_resource(
      RasterKey::Path {
        data_id: path_to_draw.generation_id(),
      },
      path_to_draw.estimated_bytes(),
    );
    self.with_shadowed_render_canvas(
      &stroke_paint,
      DrawContent::Geometry,
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
    self.flush_if_recording_limit_exceeded();
    Ok(())
  }

  // One `CompositedDraw` pass: record the draw into a picture, then replay it
  // through a layer that carries only the composite mode. The split of paints is
  // load-bearing -- handing one paint to both sides applies globalAlpha twice,
  // since `drawPicture` with a paint is a `saveLayer` whose restore paint keeps
  // alpha, colour filter and blend (canvas_2d_recorder_context.h:948-962).
  fn composited_pass<F>(
    surface_canvas: &mut Canvas,
    paint: &Paint,
    blend_mode: BlendMode,
    left: f32,
    top: f32,
    width: f32,
    height: f32,
    nested_picture_bytes: &mut usize,
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
      // The replayed drawPicture retains this inner picture inside the
      // recorded op; the byte budget needs its measured size, which only a
      // finished picture can answer. Accumulated here because the charge
      // must land on Context's recorder -- `Self` helpers see none.
      *nested_picture_bytes += pict.approx_bytes_used();
      surface_canvas.save();
      surface_canvas.draw_picture(&pict, &Matrix::identity(), &composite_paint);
      surface_canvas.restore();
    }
    Ok(())
  }

  /// Runs one pass inside its own image-filter layer, opened at the device
  /// identity with the CTM restored inside it -- Blink's `CompositedDraw`
  /// (canvas_2d_recorder_context.h:919-963) spelled with `concat`. The layer is
  /// what makes filter lengths device-space, as HTML 4.12.5.1.20 requires; a
  /// filter left on the draw's own paint gets scaled by the draw's CTM instead.
  /// It has to be `concat`, not `set_transform`, because the canvas handed here
  /// is not always the device -- on the isolation arm it is a recorder's,
  /// sitting at identity while the real CTM is applied at replay.
  ///
  /// The layer paint carries only the blend mode and the filter; the content
  /// keeps colour, alpha and shader, so nothing is applied twice.
  fn composited_filter_layer<F>(
    canvas: &mut Canvas,
    device_ctm: &Matrix,
    filter: Option<&ImageFilter>,
    paint: &Paint,
    f: F,
  ) -> result::Result<(), SkError>
  where
    F: Fn(&mut Canvas, &Paint) -> result::Result<(), SkError>,
  {
    let Some(filter) = filter else {
      return f(canvas, paint);
    };
    let mut layer_paint = Paint::new();
    layer_paint.set_blend_mode(paint.get_blend_mode());
    layer_paint.set_image_filter(filter);
    let mut inner_paint = paint.clone();
    inner_paint.set_blend_mode(BlendMode::SourceOver);

    canvas.save();
    // A singular CTM has no device space to reset to. The draw is degenerate
    // either way; take the layer unreset rather than dropping the filter.
    let inverted = device_ctm.invert();
    if let Some(ref inverted) = inverted {
      canvas.concat(inverted);
    }
    canvas.save_layer(&layer_paint);
    if inverted.is_some() {
      canvas.concat(device_ctm);
    }
    let result = f(canvas, &inner_paint);
    canvas.restore();
    canvas.restore();
    result
  }

  // Draws the shadow pass and then the content pass, giving each its OWN
  // isolation layer for the composite modes that need the whole canvas as their
  // destination -- Blink's `CompositedDraw`
  // (canvas_2d_recorder_context.h:896-965). The two layers are SIBLINGS, which
  // is composite(composite(background, shadow), foreground) taken literally, and
  // is why the shadow band of a source-in or copy draw legitimately disappears.
  // Do not merge them into one layer, and do not nest the shadow pass inside the
  // content one -- it would composite against the empty layer, not the backdrop.
  //
  // KNOWN DEFECT: the mode list below omits the shadow-conditional cases
  // Chromium routes through CompositedDraw (h:692-697, :719-727).
  fn render_canvas<S, F>(
    surface_canvas: &mut Canvas,
    paint: &Paint,
    content_filter: Option<&ImageFilter>,
    blend_mode: BlendMode,
    width: f32,
    height: f32,
    shadow: Option<ShadowPass<'_>>,
    nested_picture_bytes: &mut usize,
    shadow_f: S,
    f: F,
  ) -> result::Result<(), SkError>
  where
    S: Fn(&mut Canvas, &Paint, &Matrix) -> result::Result<(), SkError>,
    F: Fn(&mut Canvas, &Paint) -> result::Result<(), SkError>,
  {
    match blend_mode {
      // The first four are Chromium's `IsFullCanvasCompositeMode`
      // (canvas_2d_recorder_context.h:998-1005), which exempts copy/`kSrc`.
      // `Source` is kept anyway and is not a divergence in effect: a
      // whole-canvas layer restored with kSrc replaces every pixel, like
      // Chromium's `clear(transparent)` + foreground draw. Drop it and a
      // `fillRect` overwrites only its own geometry.
      BlendMode::SourceIn
      | BlendMode::SourceOut
      | BlendMode::DestinationIn
      | BlendMode::DestinationATop
      | BlendMode::Source => {
        if let Some(shadow) = shadow {
          // The shadow layer is the one place the halo can escape the canvas
          // rect, so its cull rect is expanded. FIXME: this under-covers. Skia
          // bounds a Gaussian at 3 * sigma and sigma is `blur / 2`, so the halo
          // needs `1.5 * blur + |dx| + |dy|`.
          let expansion = (shadow.blur.abs() + shadow.offset_x.abs() + shadow.offset_y.abs())
            .max(shadow.blur * 2.0);
          // The recording canvas `composited_pass` hands the closure sits at
          // identity -- the CTM is applied at replay -- so neither the closure
          // nor `composited_filter_layer` can read the device matrix off it.
          let device_ctm = surface_canvas.get_transform_matrix();
          Self::composited_pass(
            surface_canvas,
            shadow.paint,
            blend_mode,
            -expansion,
            -expansion,
            width + expansion * 2.0,
            height + expansion * 2.0,
            nested_picture_bytes,
            |canvas, paint| {
              Self::composited_filter_layer(
                canvas,
                &device_ctm,
                shadow.filter,
                paint,
                |canvas, paint| shadow_f(canvas, paint, &device_ctm),
              )
            },
          )?;
        }
        let device_ctm = surface_canvas.get_transform_matrix();
        Self::composited_pass(
          surface_canvas,
          paint,
          blend_mode,
          0.0,
          0.0,
          width,
          height,
          nested_picture_bytes,
          |canvas, paint| {
            Self::composited_filter_layer(canvas, &device_ctm, content_filter, paint, &f)
          },
        )
      }
      _ => {
        if let Some(shadow) = shadow {
          // The save/restore/save + set_transform sequence below is inert: it
          // re-installs the identical CTM and leaves the clip alone. Keeping the
          // clip is correct -- Chromium's CompositedDraw resets only the matrix
          // (canvas_2d_recorder_context.h:919-964), so a shadow is clipped like
          // any other draw. Do NOT turn this into a real clip removal.
          surface_canvas.save();
          let current_transform = surface_canvas.get_transform_matrix().clone();

          surface_canvas.restore();
          surface_canvas.save();
          surface_canvas.set_transform(&current_transform);

          // Here the canvas IS the device, so its own CTM is the device matrix.
          Self::composited_filter_layer(
            surface_canvas,
            &current_transform,
            shadow.filter,
            shadow.paint,
            |canvas, paint| shadow_f(canvas, paint, &current_transform),
          )?;
          surface_canvas.restore();
        }
        let current_transform = surface_canvas.get_transform_matrix();
        Self::composited_filter_layer(
          surface_canvas,
          &current_transform,
          content_filter,
          paint,
          &f,
        )
      }
    }
  }

  pub fn fill(
    &mut self,
    path: Option<&mut SkPath>,
    fill_rule: FillType,
  ) -> result::Result<(), SkError> {
    self.flush_if_recording_limit_exceeded();
    let fill_paint = self.fill_paint()?;

    // Clone the path and set fill type to avoid borrow conflicts with with_render_canvas.
    // set_fill_type must happen BEFORE any early return: for a caller-supplied
    // Path object it mutates the caller's object, an observable side effect.
    let path_to_draw = if let Some(p) = path {
      p.set_fill_type(fill_rule);
      p.clone()
    } else {
      self.path.set_fill_type(fill_rule);
      self.path.clone()
    };

    // Extract state for shadow rendering to avoid borrow conflicts
    let shadow_paint = self.shadow_paint(&fill_paint, ShadowSource::Fill, DrawContent::Geometry);

    // A fill whose path bounds are empty or non-finite cannot paint a pixel:
    // an empty path (no verbs) bounds to the non-finite empty rect, and an
    // all-moveTo path bounds to a degenerate rect -- both drop in
    // onDrawPath's finite/internalQuickReject checks on the device, and
    // cover zero area wherever they are recorded. Inverse fill types never
    // reach here (set_fill_type normalises to the parsed rule), so the
    // paint-the-clip branch SkCanvas takes for them cannot apply. Skip
    // before account_paint_resources so filling an empty path cannot
    // pin/charge a pattern raster (issue #1342).
    let (pl, pt, pr, pb) = path_to_draw.get_bounds();
    if !(pl.is_finite() && pt.is_finite() && pr.is_finite() && pb.is_finite() && pr > pl && pb > pt)
      && self.empty_geometry_is_skippable(shadow_paint.is_some())
    {
      return Ok(());
    }

    self.account_paint_resources(&self.state.fill_style);
    // Zero on the image-filter route, where the filter's dx/dy already carry it.
    let (shadow_offset_x, shadow_offset_y) =
      self.canvas_shadow_offset(ShadowSource::Fill, DrawContent::Geometry);

    // The recorded op pins the path's SkPathData (COW-shared with
    // path_to_draw); charge its byte payload once per data version and let
    // it propagate through the retained tally (RasterKey::Path) -- the same
    // data drawn N times pins ~1x, not Nx, and a drawCanvas destination
    // inherits the charge.
    self.account_raster_resource(
      RasterKey::Path {
        data_id: path_to_draw.generation_id(),
      },
      path_to_draw.estimated_bytes(),
    );
    self.with_shadowed_render_canvas(
      &fill_paint,
      DrawContent::Geometry,
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
    self.flush_if_recording_limit_exceeded();
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
    // Deliberately NO `set_image_filter(state.filter)`: `ctx.filter` is a
    // device-space effect and rides on `composited_filter_layer`'s layer.
    Ok(paint)
  }

  /// `ctx.filter`. An unparseable value is a silent no-op in Blink
  /// (canvas_2d_recorder_context.cc:1332-1350): it neither throws nor resets the
  /// filter to `none`, and the getter replays the raw string unnormalised. Three
  /// inputs count as unparseable and all three must be rejected here: the empty
  /// string, one that yields no filter, and one with tokens left over -- that
  /// last makes a `<filter-value-list>` all-or-nothing, keeping no valid prefix.
  pub fn set_filter(&mut self, filter_str: &str) -> result::Result<(), SkError> {
    if filter_str.trim().eq_ignore_ascii_case("none") {
      // An ident, so Blink matches it case-insensitively, but the getter still
      // replays whatever case was assigned.
      self.state.filters_string = filter_str.to_owned();
      self.state.filter = None;
      self.state.filter_id = 0;
      return Ok(());
    }
    // `css_filter` is greedy and never fails: it stops at the first token it
    // cannot read and hands the rest back, so leftover input is the reject gate.
    let Ok((rest, filters)) = css_filter(filter_str) else {
      return Ok(());
    };
    if filters.is_empty() || !rest.trim().is_empty() {
      return Ok(());
    }
    // Parsed clean, so the assignment lands even if it builds no filter at all:
    // `drop-shadow(0 0 transparent)` is legal and simply draws nothing. The id
    // advances with the stored chain so a reused ImageFilter dedups under one
    // accounting identity and a fresh chain re-charges under a new one.
    self.state.filter = css_filters_to_image_filter(filters);
    self.state.filters_string = filter_str.to_owned();
    self.state.filter_id = next_resource_id();
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
    let mut parser = Parser::new(&shadow_color);
    let color = CSSColor::parse(&mut parser)
      .map_err(|e| SkError::Generic(format!("Parse color [{}] error: {:?}", shadow_color, e)))?;

    match color {
      CSSColor::CurrentColor => {
        return Err(SkError::Generic(
          "Color should not be `currentcolor` keyword".to_owned(),
        ));
      }
      CSSColor::Rgba(rgba) => {
        drop(parser);
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

        drop(parser);
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
    if self.page_recorder.is_some() {
      // Flush the deferred recording before reading pixels, as Blink's
      // getImageData runs FinalizeFrame -> FlushCanvas ->
      // ReleaseMainRecording (base_rendering_context_2d.cc). Without it the
      // recording grows unbounded across getImageData calls
      // (https://github.com/Brooooooklyn/canvas/issues/1342). flush() also
      // consolidates the layers into a single snapshot picture, so a read
      // leaves the recorder holding only an O(canvas_size) snapshot.
      self.flush();
    }

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
    // Deliberately NO `set_image_filter(state.filter)`: `ctx.filter` is a
    // device-space effect and rides on `composited_filter_layer`'s layer.
    Ok(paint)
  }

  /// The image-filter Gaussian a canvas2d shadow is allowed to carry. Sigma is
  /// exactly `shadowBlur * 0.5`, in device space, applied exactly once
  /// (canvas_rendering_context_2d_state.cc:650-652). Ordinary geometry and text
  /// use the equivalent mask filter; this route is for image sources or a
  /// shadow whose `ctx.filter` must be composed before colourisation.
  ///
  /// ACCEPTED DIVERGENCE, every shape: on an 8888 surface Skia's raster engine
  /// routes to the three-box pass above sigma 2 (SkBlurEngine.cpp:1281, :275)
  /// and derives its window as an integer (:388), so the effective sigma snaps
  /// to a staircase -- +9% to -13% off `shadowBlur / 2`, sign depending on where
  /// the request lands in a step. Measured against Chrome 150 over 55 radii:
  /// Chrome is smooth to within 3% on BOTH its accelerated and its software
  /// canvas, so this is ours alone, not a CPU-vs-GPU artefact. The sigma passed
  /// here is already correct; the lever is Skia's algorithm choice, not this.
  ///
  /// dx/dy and sigma go in raw, in device pixels, as Blink builds them -- safe
  /// ONLY because `composited_filter_layer` opens this filter's layer at the
  /// device identity. `shadow_takes_image_filter` decides between this and the
  /// canvas translate, so the offset is applied exactly once.
  fn shadow_only_image_filter(state: &Context2dRenderingState) -> Option<ImageFilter> {
    let shadow_color = &state.shadow_color;
    let a = shadow_color.a;
    let r = shadow_color.r;
    let g = shadow_color.g;
    let b = shadow_color.b;
    // No CTM correction: `composited_filter_layer` has already made this
    // filter's parameter space the device's. sigma == 0 must not be guarded --
    // `SkImageFilters::Blur` allows it and degenerates to the identity, leaving
    // colorize + translate.
    let sigma = state.shadow_blur / 2f32;
    ImageFilter::make_drop_shadow_only(
      // Device-space, straight from the setters. Safe ONLY under
      // `composited_filter_layer`'s identity layer.
      state.shadow_offset_x,
      state.shadow_offset_y,
      sigma,
      sigma,
      ((a as u32) << 24) | ((r as u32) << 16) | ((g as u32) << 8) | b as u32,
      // `ctx.filter` is the INPUT of the shadow graph, never applied to its
      // output: Blink composes `shadow_filter(canvas_filter(source))`
      // (canvas_2d_recorder_context.h:931-934). Since the graph colourises with
      // kSrcIn, `ctx.filter` can only change the shadow's coverage, never its
      // colour -- but dropping it is still wrong, because `blur()` and
      // `opacity()` move the coverage the shadow is cast from.
      state.filter.as_ref(),
    )
  }

  /// Does `ctx.filter` still ride `composited_filter_layer`? The exact negation
  /// of `render_passes`'s content-pass rescue, and the one place that question
  /// is answered, so the content and shadow passes cannot disagree.
  ///
  ///   * `Backend::Raster`, where the layer costs nothing, is what Blink emits,
  ///     and is not byte-identical to folding -- see `render_passes`.
  ///   * `needs_device_space_layer()` is `!SkImageFilter::asAColorFilter`: a
  ///     spatial parameter is a length, and that length is device space.
  ///   * `Backend::Pdf` + `DrawContent::Glyphs` is a KNOWN DEFECT, kept because
  ///     the alternative crashes: on `windows-11-arm` a PDF glyph run drawn
  ///     through a colour-filtered paint faults with `0xC0000005`. A glyph run
  ///     is the one draw whose colour filter reaches the strike machinery, not
  ///     just the blitter. Which step faults is not established, hence the
  ///     narrow scope: SVG text and every other PDF draw keep the rescue.
  fn filter_takes_layer(&self, content: DrawContent) -> bool {
    self.state.filter.as_ref().is_some_and(|filter| {
      self.backend == Backend::Raster
        || filter.needs_device_space_layer()
        || (self.backend == Backend::Pdf && content == DrawContent::Glyphs)
    })
  }

  /// Does this shadow render through an image filter, or through a paint the
  /// draw carries directly? The single source of truth for a fork Blink also
  /// makes (canvas_rendering_context_2d_state.cc:849-868). Two callers read it
  /// and must agree, or the offset is applied twice or not at all.
  ///
  /// The middle disjunct is `filter_takes_layer`, NOT `state.filter.is_some()`:
  /// Blink puts a filtered shadow on the image filter because the layer is where
  /// its `ctx.filter` lives, so on a backend that has taken the filter off the
  /// layer the route buys nothing but a layer the device cannot make.
  fn shadow_takes_image_filter(&self, source: ShadowSource, content: DrawContent) -> bool {
    source.forces_shadow_image_filter() || self.filter_takes_layer(content)
  }

  /// The device-space translate the CANVAS still owes the shadow.
  ///
  /// Zero on the image-filter route, where `shadow_only_image_filter` has
  /// already put `shadowOffsetX/Y` into the filter's dx/dy, as Blink does. Skia
  /// implements those as `MatrixTransform(Translate(dx, dy), kLinear)`, and the
  /// resample is the point: a canvas translate has none, so a fractional offset
  /// on a non-opaque image loses the partial coverage entirely.
  fn canvas_shadow_offset(&self, source: ShadowSource, content: DrawContent) -> (f32, f32) {
    if self.shadow_takes_image_filter(source, content) {
      (0f32, 0f32)
    } else {
      (self.state.shadow_offset_x, self.state.shadow_offset_y)
    }
  }

  /// The shadow half of every draw -- geometry, text and images alike.
  fn shadow_paint(
    &self,
    paint: &Paint,
    source: ShadowSource,
    content: DrawContent,
  ) -> Option<ShadowDraw> {
    let state = &self.state;
    let shadow_color = &state.shadow_color;
    let shadow_alpha = shadow_color.a;
    if shadow_alpha == 0 {
      return None;
    }
    if state.shadow_blur == 0f32 && state.shadow_offset_x == 0f32 && state.shadow_offset_y == 0f32 {
      return None;
    }
    let mut drop_shadow_paint = paint.clone();
    // Whatever the blur, the colourisation is the same operation: an
    // `SkColorFilters::Blend(shadowColor, kSrcIn)`, which Blink installs in both
    // of its shadow paths and never spells as `SkPaint::setColor`.
    //
    // Both branches below build NO image filter, so they take no layer and
    // `canvas_shadow_offset` still owes the caller the full offset. A non-zero
    // blur rides on a transform-independent mask filter, matching Chromium's
    // shadow draw-looper path. Besides avoiding a full-canvas image-filter
    // layer per draw, `respectCTM = false` keeps the blur in device space.
    // `shadow_takes_image_filter` is the shared predicate; do not inline this
    // condition anywhere else. It is what keeps this route away from a
    // `ctx.filter` still on the layer, where the shadow HAS to be an image
    // filter: the only faithful order is `colourise(ctx.filter(source))`, and a
    // paint colour or colour filter runs BEFORE the paint's image filter.
    if !self.shadow_takes_image_filter(source, content) {
      // Chromium's draw looper adds a mask filter only when sigma is positive.
      // Our wrapper creates it with `respectCTM = false`, which is the looper's
      // `kShadowIgnoresTransforms` behavior. At zero blur it would be nullptr,
      // so leave the paint unfiltered.
      if state.shadow_blur > 0f32 {
        let blur_effect = MaskFilter::make_blur(state.shadow_blur / 2f32)?;
        drop_shadow_paint.set_mask_filter(&blur_effect);
      }
      //
      // Once colour-only, all `ctx.filter` can do to a shadow is change one
      // number: kSrcIn discards the source RGB, so only the alpha it leaves on
      // the source survives. Hence a single alpha, not a filter chain.
      let colour_only_filter = state.filter.as_ref();
      if source.is_solid_color(state) {
        // ...but SkSVGDevice cannot express even THIS colour filter faithfully:
        // it writes a kSrcIn Blend as an feFlood plus an feComposite with no
        // `in2` (src/svg/SkSVGDevice.cpp:495-503), which per SVG 1.1 11.1.1
        // defaults to the flood itself, so the composite floods the whole
        // bounding box -- a `strokeRect` shadow came out a filled box. So fold
        // the blend into the paint colour, as `SkPaintPriv::RemoveColorFilter`
        // does for PDF; against a solid-colour source that is algebraically the
        // same, and SkSVGDevice emits a plain `fill=` with no filter. Rounding
        // back to 8 bits loses nothing, since the blitter would quantise to
        // `SkPMColor` before the first pixel anyway.
        //
        // Two conditions, both load-bearing:
        //   * `* paint_alpha`: `paint` already carries style alpha *
        //     `globalAlpha`, so the raw `shadowColor.a` would draw every
        //     zero-blur shadow fully opaque.
        //   * solid colours ONLY. `setColor` cannot displace a shader, so
        //     folding under a gradient would leave the shader in place and the
        //     "shadow" would be a displaced copy of it. Those keep the colour
        //     filter below, at the cost of the broken SVG path.
        //
        // A colour-only `ctx.filter` goes in HERE, before the shadow colour
        // displaces the source -- the only spelling on a paint that gets Blink's
        // `colourise(ctx.filter(source))` order right. Only the alpha is read,
        // since kSrcIn throws the filtered RGB away. Deliberately NOT
        // special-cased on the filter list: `SkImageFilters::ColorFilter`
        // collapses chained colour filters, so `filterColor4f` answers for all.
        let source_color = match colour_only_filter {
          Some(filter) => filter.filter_color(drop_shadow_paint.get_color()),
          None => drop_shadow_paint.get_color(),
        };
        let paint_alpha = (source_color >> 24) as f32 / 255.0;
        drop_shadow_paint.set_color(
          shadow_color.r,
          shadow_color.g,
          shadow_color.b,
          (shadow_alpha as f32 * paint_alpha).round() as u8,
        );
        return Some(ShadowDraw {
          paint: drop_shadow_paint,
          filter: None,
        });
      }
      // A shader source. `ctx.filter` is deliberately DROPPED rather than
      // composed in: `SkSVGDevice` recognises exactly one colour filter, a
      // single kSrcIn `Blend` (src/svg/SkSVGDevice.cpp:431-436), and silently
      // emits none for anything else, so composing would turn a gradient's
      // shadow into an undimmed displaced copy of the gradient. The cost is the
      // alpha half of an alpha-changing filter, on SVG and PDF only.
      drop_shadow_paint.set_src_in_color_filter(
        shadow_color.r,
        shadow_color.g,
        shadow_color.b,
        shadow_alpha,
      );
      return Some(ShadowDraw {
        paint: drop_shadow_paint,
        filter: None,
      });
    }
    let shadow_effect = Self::shadow_only_image_filter(state)?;
    // Do NOT re-apply `shadow_alpha` here: the filter already carries the shadow
    // colour's alpha and the cloned `paint` carries the source alpha, so a
    // `set_alpha` would render `shadowColor` alpha `a` as `a * a`.
    //
    // The graph is returned SEPARATELY and never installed on
    // `drop_shadow_paint`: `composited_filter_layer` puts it on a layer opened
    // at the device identity, whereas on the paint it would ride Skia's implicit
    // layer at the draw's own CTM, scaling dx, dy and both sigmas.
    //
    // Deliberately NO MaskFilter. `DropShadowOnly` already contains the
    // Gaussian, and stacking one makes Skia nest two layers and convolve twice.
    // It would also be fatal: `SkMaskFilter::MakeBlur` is nullptr for sigma <= 0
    // and the `?` would discard the whole shadow paint.
    Some(ShadowDraw {
      paint: drop_shadow_paint,
      filter: Some(shadow_effect),
    })
  }

  /// Skia's `fillable` (SkCanvas.cpp) for one axis of SkRect::MakeXYWH(x,_,
  /// w,_): the rect can draw something only if its f32-computed width is
  /// finite and positive. Computing `x + w` first (not `w` alone) preserves
  /// the rounding edge collapse -- x so large that x + w == x makes the
  /// rect empty in native code too.
  fn rect_fillable(x: f32, w: f32) -> bool {
    let width = (x + w) - x;
    width.is_finite() && width > 0.0
  }

  /// `rect_fillable` for callers whose rect Skia sorts before use: drawRect
  /// runs `r.makeSorted()` (SkCanvas.cpp), so a negative width or height
  /// still paints. Sorting the two f32 endpoints first mirrors that: a
  /// negative `w` flips to a positive span, while edge collapse (x + w == x)
  /// and non-finite endpoints still fail.
  fn sorted_span_fillable(x: f32, w: f32) -> bool {
    let edge = x + w;
    let lo = x.min(edge);
    let hi = x.max(edge);
    lo.is_finite() && hi.is_finite() && hi > lo
  }

  /// Whether the sorted span [x, x + w] is DETERMINISTICALLY empty -- the
  /// only case where a clipRect built from it removes all output.
  /// SkCanvas::clipRect ignores a non-finite rect entirely (SkCanvas.cpp:
  /// `if (!rect.isFinite()) return`), so an endpoint overflowing f32 or a
  /// NaN leaves the clip untouched instead of emptying it; the draw must
  /// proceed and let the CTM decide. Only a finite, collapsed span is empty.
  fn sorted_span_empty(x: f32, w: f32) -> bool {
    let edge = x + w;
    let lo = x.min(edge);
    let hi = x.max(edge);
    lo.is_finite() && hi.is_finite() && hi == lo
  }

  /// Whether a draw whose own geometry provably paints nothing may be
  /// skipped whole. drawRect/drawPath DO reach the record canvas
  /// (SkRecordCanvas::onDraw* appends unconditionally -- the fillable()
  /// checks live in SkCanvas::onDraw*), so skipping is only about not
  /// charging paint resources for zero-coverage geometry. What stays
  /// un-skippable are the wrapper ops our draw path can still emit around
  /// the empty draw, because their restore writes the device even with no
  /// content inside:
  ///   * composited_pass modes replay an inner picture through a
  ///     saveLayer/drawPicture(paint) -- a kSrc restore replaces the whole
  ///     canvas even for an empty picture;
  ///   * a `ctx.filter` wraps the draw in a filtered saveLayer -- its
  ///     restore also composites (kClear can clear the canvas);
  ///   * a shadow pass records an extra draw whose blend mode is the
  ///     paint's (kClear shadow restore would clear); `has_shadow` is the
  ///     caller's `shadow_paint(...)` result.
  ///
  /// Under none of those, every emitted op is coverage-limited and a
  /// zero-area geometry paints nothing on the record or at playback.
  /// Dashes get the same gate: a path effect makes
  /// `SkPaint::canComputeFastBounds` fail, which disables even the
  /// device-side reject, so stay conservative.
  fn empty_geometry_is_skippable(&self, has_shadow: bool) -> bool {
    !matches!(
      self.state.global_composite_operation,
      BlendMode::Source
        | BlendMode::SourceIn
        | BlendMode::SourceOut
        | BlendMode::DestinationIn
        | BlendMode::DestinationATop
        | BlendMode::Clear
    ) && self.state.filter.is_none()
      && self.state.line_dash_list.is_empty()
      && !has_shadow
  }

  /// `raster_key` dedups the retained-raster charge for this op: the caller
  /// pairs the source's resource id with a content generation (a canvas
  /// source's `content_version()`, or a fresh nonce for sources with no
  /// recorder). A canvas-backed bitmap's pointer is the stable `SkSurface*`
  /// (skiac_surface_get_bitmap), but each recorded drawImage pins a fresh
  /// makeImageSnapshot -- mutating the source afterwards copy-on-writes a
  /// new raster that the id alone cannot distinguish, hence the generation.
  pub(crate) fn draw_image(
    &mut self,
    bitmap: &Bitmap,
    raster_key: RasterKey,
    sx: f32,
    sy: f32,
    s_width: f32,
    s_height: f32,
    dx: f32,
    dy: f32,
    d_width: f32,
    d_height: f32,
  ) -> Result<()> {
    self.flush_if_recording_limit_exceeded();
    // Preflight the conditions under which skiac_canvas_draw_image records
    // NOTHING that retains the source raster (SkCanvas.cpp
    // internalQuickReject/fillable), before paint construction and
    // accounting. The bitmap arm drops the draw unless `fillable` holds for
    // BOTH raw rects -- finite, strictly-positive spans (its MakeXYWH can
    // collapse to an empty width under f32 rounding). The canvas arm only
    // skips a deterministically-empty sorted dst clip; every condition that
    // depends on the ambient CTM is left to the native path.
    if bitmap.0.is_canvas {
      // The clip the C++ builds is MakeWH(d_width, d_height) applied AFTER
      // translate(dx, dy) (skia_c.cpp: skiac_canvas_draw_image), and
      // clipRect runs makeSorted() while IGNORING non-finite rects: only a
      // finite collapsed span (dw == 0 or dh == 0) empties it. A negative
      // dw/dh paints mirrored; a non-finite endpoint leaves the clip open.
      // The C++ applies translate THEN scale to the ambient CTM -- there is
      // no standalone `dx - sx*scale_x` term, so overflow in that derived
      // expression says nothing about the composed result and must not
      // gate. Non-finite scale/translate DO still void the draw, but only
      // once composed with the ambient matrix, which is CTM-dependent and
      // deliberately left to the native path (a missed skip costs a
      // bounded charge; a wrong skip drops pixels).
      if Self::sorted_span_empty(0.0, d_width) || Self::sorted_span_empty(0.0, d_height) {
        return Ok(());
      }
    } else if !(Self::rect_fillable(sx, s_width)
      && Self::rect_fillable(sy, s_height)
      && Self::rect_fillable(dx, d_width)
      && Self::rect_fillable(dy, d_height))
    {
      return Ok(());
    }

    let mut paint: Paint = self.fill_paint()?;
    self.account_paint_resources(&self.state.fill_style);
    paint.set_alpha((self.state.global_alpha * 255.0).round() as u8);

    // Extract state for shadow rendering to avoid borrow conflicts
    let shadow_paint = self.shadow_paint(&paint, ShadowSource::Image, DrawContent::Geometry);
    // Zero on the image-filter route, where the filter's dx/dy already carry it.
    let (shadow_offset_x, shadow_offset_y) =
      self.canvas_shadow_offset(ShadowSource::Image, DrawContent::Geometry);
    let image_smoothing_enabled = self.state.image_smoothing_enabled;
    let image_smoothing_quality = self.state.image_smoothing_quality;

    // The recorded op pins a reference to the source pixels; charge its full
    // raster size so large drawImage sources trip the recording limit. The
    // raster tally keeps it visible to drawCanvas accounting: a recorded
    // drawImage inside a source picture carries this payload along. Keyed on
    // raster_key -- re-drawing one UNCHANGED source retains one shared
    // backing, not N.
    self.account_raster_resource(
      raster_key,
      (bitmap.0.width as usize) * (bitmap.0.height as usize) * 4,
    );
    self.with_shadowed_render_canvas(
      &paint,
      DrawContent::Geometry,
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
    self.flush_if_recording_limit_exceeded();
    Ok(())
  }

  /// Whether the recorder has an unrebased direct surface write. See
  /// PageRecorder::surface_dirty.
  fn recorder_surface_dirty(&self) -> bool {
    self
      .page_recorder
      .as_ref()
      .is_some_and(|recorder| recorder.borrow().surface_dirty())
  }

  /// Get a composite picture of all recorded operations (for drawCanvas).
  /// While a direct surface write is unrebased (surface_dirty) the layers
  /// alone are incomplete, so the recorder is first rebased on a surface
  /// snapshot: flush() plays pending post-write ops onto the surface, then
  /// one draw(snapshot) picture makes the composite complete again. That
  /// snapshot is taken only here -- per read-out, not per write -- so a
  /// write-only loop never pays it.
  pub fn get_picture(&mut self) -> Option<crate::sk::SkPicture> {
    if self.recorder_surface_dirty() {
      self.flush();
      if self.recorder_surface_dirty()
        && let Some(snapshot) = self.surface.make_image_snapshot()
        && let Some(ref recorder) = self.page_recorder
      {
        recorder.borrow_mut().consolidate_with_snapshot(snapshot);
      }
    }
    self.page_recorder.as_ref()?.borrow_mut().get_picture()
  }

  /// Draw another canvas, preserving vector graphics when possible.
  /// When the source has a SkPicture, this avoids rasterization.
  /// Shadow rendering requires additional FFI calls when enabled.
  /// `source_raster_bytes` is the source recorder's retained_raster_bytes:
  /// approx_bytes_used below cannot see the pixels/typefaces a source picture
  /// references, so the caller reads the source's tally and hands it in.
  pub(crate) fn draw_canvas(
    &mut self,
    picture: &crate::sk::SkPicture,
    source_raster_bytes: usize,
    sx: f32,
    sy: f32,
    s_width: f32,
    s_height: f32,
    dx: f32,
    dy: f32,
    d_width: f32,
    d_height: f32,
  ) -> Result<()> {
    self.flush_if_recording_limit_exceeded();
    // Preflight only the conditions under which skiac_canvas_draw_picture_rect
    // provably records NOTHING under every CTM, before paint construction and
    // accounting. Rust cannot replicate the helper's floating-point
    // evaluation -- release builds contract `dx - sx * scale_x` into fma,
    // rounding differently than separate Rust mul+sub -- so NOTHING computed
    // from composed terms may gate:
    //   * `sw == 0 || sh == 0` -- the helper's own early return (skia_c.cpp),
    //     an exact bit-level test.
    //   * a deterministically empty dst clip -- clipRect(MakeXYWH(dx,dy,
    //     dw,dh)) runs makeSorted() while IGNORING non-finite rects
    //     (SkCanvas.cpp: `if (!rect.isFinite()) return`), so a NEGATIVE dw
    //     or dh sorts to a normal span and still paints mirrored, and an
    //     endpoint that overflows f32 leaves the clip untouched for the CTM
    //     to rescale through. Only a finite collapsed span (dw == 0,
    //     dh == 0, or x + w rounding back to x in f32 -- computed on the
    //     same f32 operands the helper receives) is empty.
    if s_width == 0.0
      || s_height == 0.0
      || Self::sorted_span_empty(dx, d_width)
      || Self::sorted_span_empty(dy, d_height)
    {
      return Ok(());
    }

    let mut paint: Paint = self.fill_paint()?;
    self.account_paint_resources(&self.state.fill_style);
    paint.set_alpha((self.state.global_alpha * 255.0).round() as u8);

    // Extract state for shadow rendering to avoid borrow conflicts
    let shadow_paint = self.shadow_paint(&paint, ShadowSource::Image, DrawContent::Geometry);
    // Zero on the image-filter route, where the filter's dx/dy already carry it.
    let (shadow_offset_x, shadow_offset_y) =
      self.canvas_shadow_offset(ShadowSource::Image, DrawContent::Geometry);

    // The recorded drawPicture op pins a reference to the source canvas's
    // whole composite record; charge its real size, not the 256 B base op,
    // plus the retained raster payload approx_bytes_used cannot see. The
    // raster charge is keyed on the picture's process-unique id --
    // get_picture() returns the same cached SkPicture while the source's
    // layers are unchanged, so repeated draws of an unchanged source charge
    // its payload once; a regenerated picture gets a new key and pays again,
    // matching the new reference the op retains.
    self.account_recorded_bytes(picture.approx_bytes_used());
    // Keyed on uniqueID(), not the SkPicture pointer: SkCanvas unrolls
    // pictures of <= 1 op (kMaxPictureOpsToUnrollInsteadOfRef) and skips
    // clip-rejected draws, so a recorded op does not always retain the
    // picture object while its raster payload lives on -- a freed pointer
    // can be recycled by the next picture, aliasing the stale key.
    self.account_raster_resource(
      RasterKey::Picture {
        uid: picture.unique_id() as u64,
      },
      source_raster_bytes,
    );
    self.with_shadowed_render_canvas(
      &paint,
      DrawContent::Geometry,
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
    self.flush_if_recording_limit_exceeded();
    Ok(())
  }

  fn draw_text(
    &mut self,
    text: &str,
    x: f32,
    y: f32,
    max_width: f32,
    paint: &Paint,
    // `fillText` and `strokeText` share this body but read different styles;
    // `shadow_paint` needs to know which one to consult.
    source: ShadowSource,
    variations: &[crate::sk::FontVariation],
  ) -> result::Result<(), SkError> {
    let font = get_font()?;

    // Extract all state values to avoid borrow conflicts with with_render_canvas
    // The one `DrawContent::Glyphs` in the file, which keeps a colour-only
    // `ctx.filter` on the layer for PDF text; see `filter_takes_layer`. All
    // three readers below get the same value, so the passes cannot disagree.
    let shadow_paint = self.shadow_paint(paint, source, DrawContent::Glyphs);
    let width = self.width as f32;
    // Zero on the image-filter route, where the filter's dx/dy already carry it.
    let (shadow_offset_x, shadow_offset_y) = self.canvas_shadow_offset(source, DrawContent::Glyphs);
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

    // Canvas::draw_text converts text, family, and lang with CString::new,
    // which fails on interior NUL. Check here so the charges below never
    // commit for a draw that cannot record (same SkError::NulError the
    // conversion would produce).
    if text.contains('\0') || font_family.contains('\0') || lang.contains('\0') {
      return Err(SkError::NulError);
    }

    // Everything fallible (get_font, the NUL preflight) is behind us, so the
    // paint-resource charge can land here -- the same position fill/stroke
    // use, after their fallible paint builds. `source` already says which
    // style `paint` was built from.
    match source {
      ShadowSource::Fill => self.account_paint_resources(&self.state.fill_style),
      ShadowSource::Stroke => self.account_paint_resources(&self.state.stroke_style),
      ShadowSource::Image => unreachable!("draw_text is only reached via fill/stroke"),
    }

    // The recorded op retains an SkTextBlob: ~2 B/glyph id plus ~8 B/glyph
    // position and per-run overhead. UTF-8 length is a lower bound on the
    // glyph count, so len() * 16 is the conservative per-glyph bound.
    self.account_recorded_bytes(text.len().saturating_mul(16));
    // The blob also keeps the run's SkFont/SkTypeface alive, whose backing
    // font file can be megabytes -- and approx_bytes_used cannot see it.
    // There is no size query on a typeface, so charge a flat 1 MiB, but ONCE
    // per resolved-face descriptor per window: every blob built from the same
    // descriptor refs the same typeface, so billing per draw would charge one
    // pinned face N times and flush a text loop every ~32 ops. The key hashes
    // the inputs that pick the face plus the font-collection generation --
    // registering or removing a face re-resolves the same descriptor to a
    // different typeface that must re-charge. It goes to the raster tally
    // because the payload crosses to a drawCanvas destination with the
    // source picture.
    let typeface_key = {
      let mut hasher = std::collections::hash_map::DefaultHasher::new();
      use std::hash::{Hash, Hasher};
      font_family.hash(&mut hasher);
      font_weight.hash(&mut hasher);
      std::mem::discriminant(&font_stretch).hash(&mut hasher);
      font_stretch_percentage.to_bits().hash(&mut hasher);
      for v in variations {
        v.tag.hash(&mut hasher);
        v.value.to_bits().hash(&mut hasher);
      }
      crate::global_fonts::font_collection_generation().hash(&mut hasher);
      hasher.finish()
    };
    self.account_raster_resource(RasterKey::Typeface { key: typeface_key }, 1024 * 1024);
    self.with_shadowed_render_canvas(
      paint,
      DrawContent::Glyphs,
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
    // End-of-op boundary: the callers return this directly, so the
    // post-check covers both fillText and strokeText.
    self.flush_if_recording_limit_exceeded();
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
  /// shadow_offset_y)`, the looper half of Chromium's two shadow-offset paths
  /// (cc/paint/draw_looper.cc:37-40). Reached with a non-zero offset only when
  /// `canvas_shadow_offset` says the shadow builds no image filter.
  ///
  /// `device_ctm` is the user->device matrix of the canvas the draw ultimately
  /// lands on, which is NOT always `canvas`'s own CTM -- on the isolation arm
  /// `canvas` is a recorder's, sitting at identity. The sandwich below leaves
  /// the device at `T * M` whatever matrix sits in between.
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
    // A no-op on raster (SkAnnotate* only emits on the PDF device), but the
    // bump keeps the version correct if a direct backend ever draws as a
    // drawImage source.
    self.note_direct_mutation();
  }

  pub fn annotate_named_destination(&self, x: f64, y: f64, name: String) {
    self
      .surface
      .annotate_named_destination(x as f32, y as f32, &name);
    self.note_direct_mutation();
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
    self.note_direct_mutation();
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

/// Source argument for `drawImage`. Wraps the `Either3` conversion so it runs
/// in the generated callback glue inside the native borrow scope: napi-rs
/// 3.12+ rejects `FromNapiValue` conversions performed inside a method body,
/// and the wrapper keeps the custom error message.
pub struct DrawImageSource<'a>(
  pub Either3<&'a mut CanvasElement<'a>, &'a mut SVGCanvas<'a>, &'a mut Image>,
);

impl TypeName for DrawImageSource<'_> {
  fn type_name() -> &'static str {
    "CanvasElement | SVGCanvas | Image"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl ValidateNapiValue for DrawImageSource<'_> {
  unsafe fn validate(_env: sys::napi_env, _napi_val: sys::napi_value) -> Result<sys::napi_value> {
    Ok(std::ptr::null_mut())
  }
}

impl FromNapiValue for DrawImageSource<'static> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    match unsafe {
      <Either3<&mut CanvasElement, &mut SVGCanvas, &mut Image> as FromNapiValue>::from_napi_value(
        env, napi_val,
      )
    } {
      Ok(value) => Ok(DrawImageSource(value)),
      Err(_) => {
        // Throw the TypeError eagerly: napi >= 3.12 no longer maps the
        // InvalidArg status to a JS TypeError when synthesizing the error.
        let _ = Env::from_raw(env).throw_type_error(
          "Value is not one of these types: `CanvasElement`, `SVGCanvas`, `Image`",
          Some("InvalidArg"),
        );
        Err(Error::new(
          Status::InvalidArg,
          "Value is not one of these types: `CanvasElement`, `SVGCanvas`, `Image`".to_string(),
        ))
      }
    }
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
    // value (canvas_2d_recorder_context.cc:1202-1207). Storing it is not inert:
    // it becomes the sigma, `SkImageFilters::Blur` rejects it, and the Blur node
    // is silently dropped -- turning every later shadow hard-edged.
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
        let data_object = Uint8ClampedSlice::from_data(env, data_buffer)?;
        let mut instance = ImageData {
          width: width as usize,
          height: height as usize,
          color_space,
          data_ref: Some(create_weak_ref(env, data_object.raw())?),
        }
        .into_instance(env)?;
        instance.define_properties(&[Property::new()
          .with_utf8_name("data")?
          .with_value(&data_object)
          .with_property_attributes(PropertyAttributes::Enumerable)])?;
        Ok(instance)
      }
      Either::B(data_object) => {
        let input_data_length = data_object.len();
        let width = width_or_height.unsigned_abs();
        let height = match &height_or_settings {
          Some(Either::A(height)) => height.unsigned_abs(),
          _ => (input_data_length as u32) / 4 / width,
        };
        // The typed array aliases the caller's buffer, which may be detached
        // later via transfer; the pixel length is checked on every use.
        if input_data_length < (width as usize) * (height as usize) * 4 {
          return Err(Error::new(
            Status::InvalidArg,
            "Index or size is negative or greater than the allowed amount".to_owned(),
          ));
        }
        let color_space = maybe_settings
          .and_then(|settings| ColorSpace::from_str(&settings.color_space).ok())
          .unwrap_or_default();
        let mut instance = ImageData {
          width: width as usize,
          height: height as usize,
          color_space,
          // Weak ref: the non-configurable `data` property keeps the caller's
          // array alive for exactly the ImageData's lifetime.
          data_ref: Some(create_weak_ref(env, data_object.raw())?),
        }
        .into_instance(env)?;
        instance.define_properties(&[Property::new()
          .with_utf8_name("data")?
          .with_value(&data_object)
          .with_property_attributes(PropertyAttributes::Enumerable)])?;
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
    CanvasPattern::new(*env, input, repetition)?.into_instance(env)
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
    image: DrawImageSource<'_>,
    sx: Option<f64>,
    sy: Option<f64>,
    s_width: Option<f64>,
    s_height: Option<f64>,
    dx: Option<f64>,
    dy: Option<f64>,
    d_width: Option<f64>,
    d_height: Option<f64>,
  ) -> Result<()> {
    // raster_key dedups the retained-raster charge inside draw_image:
    // (resource identity, content generation). A canvas source is keyed by
    // its Context's resource_id -- a monotonic id, not the SkSurface*, which
    // is freed with the canvas and recycled -- plus its content_version: a
    // mutation (recorded op, direct surface write, surface replacement in
    // get_content) COWs a new raster and must re-charge. An Image source is
    // keyed by its current AccountedBitmap's own resource_id: every decode,
    // src reset, and regenerate_bitmap_if_need constructs a fresh
    // AccountedBitmap, so a swapped bitmap can never alias the stale charge.
    let (bitmap, raster_key) = match image.0 {
      Either3::A(canvas) => {
        // Flush the source canvas to render deferred operations before getting bitmap
        canvas.ctx.context.flush();
        let bitmap = BitmapRef::Owned(canvas.ctx.context.surface.get_bitmap());
        (
          bitmap,
          RasterKey::Resource {
            id: canvas.ctx.context.resource_id,
            generation: canvas.ctx.context.content_version(),
          },
        )
      }
      Either3::B(svg) => {
        let bitmap = BitmapRef::Owned(svg.ctx.context.surface.get_bitmap());
        (
          bitmap,
          RasterKey::Resource {
            id: svg.ctx.context.resource_id,
            generation: svg.ctx.context.content_version(),
          },
        )
      }
      Either3::C(image) => {
        if !image.complete {
          return Ok(());
        }
        image.regenerate_bitmap_if_need(env)?;
        if let Some(bitmap) = &image.bitmap {
          (
            BitmapRef::Borrowed(&bitmap.inner),
            RasterKey::Resource {
              id: bitmap.resource_id,
              generation: 0,
            },
          )
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
      bitmap_ref, raster_key, sx, sy, s_width, s_height, dx, dy, d_width, d_height,
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
    // The budget check must run BEFORE get_picture()/the charge below: the
    // picture captures the source's retained recording, and a flush after
    // charging would erase that charge (issue #1342, review round 3).
    self.context.flush_if_recording_limit_exceeded();
    let source_width = canvas.width as f32;
    let source_height = canvas.height as f32;

    // Flush-check the SOURCE too: get_picture() only promotes its pending
    // recording to a layer, so without this a source used exclusively through
    // drawCanvas never consolidates and keeps its recording pinned forever.
    canvas.ctx.context.flush_if_recording_limit_exceeded();
    // Get picture from source canvas (preserves vector graphics)
    // Note: We need mutable access to the source context to get the picture
    // This is safe because we have exclusive access to the CanvasElement
    let picture = canvas.ctx.context.get_picture();

    let picture = if let Some(pic) = picture {
      pic
    } else {
      // Fallback to bitmap if picture not available (e.g., SVG canvas or no deferred rendering).
      // Flush first so the bitmap reads the surface's complete content.
      canvas.ctx.context.flush();
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
        &bitmap,
        RasterKey::Resource {
          id: canvas.ctx.context.resource_id,
          generation: canvas.ctx.context.content_version(),
        },
        sx,
        sy,
        s_width,
        s_height,
        dx,
        dy,
        d_width,
        d_height,
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

    // approx_bytes_used (charged inside Context::draw_canvas) excludes the
    // payloads a picture references -- putImageData/drawImage bitmaps, image
    // patterns, typefaces, and a consolidated snapshot layer inside the
    // source record. The source recorder tallies exactly those in
    // raster_bytes; it is handed to draw_canvas rather than charged here so
    // it lands AFTER draw_canvas's fallible paint construction.
    let source_raster_bytes = canvas
      .ctx
      .context
      .page_recorder
      .as_ref()
      .map(|recorder| recorder.borrow().retained_raster_bytes())
      .unwrap_or(0);
    self.context.draw_canvas(
      &picture,
      source_raster_bytes,
      sx,
      sy,
      s_width,
      s_height,
      dx,
      dy,
      d_width,
      d_height,
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
      let data_object = Uint8ClampedSlice::from_data(env, image_data)?;
      let mut instance = ImageData {
        width: sw as usize,
        height: sh as usize,
        color_space,
        data_ref: Some(create_weak_ref(env, data_object.raw())?),
      }
      .into_instance(env)?;
      instance.define_properties(&[Property::new()
        .with_utf8_name("data")?
        .with_value(&data_object)
        .with_property_attributes(PropertyAttributes::Enumerable)])?;
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
    env: Env,
    image_data: &ImageData,
    dx: i32,
    dy: i32,
    dirty_x: Option<f64>,
    dirty_y: Option<f64>,
    dirty_width: Option<f64>,
    dirty_height: Option<f64>,
  ) -> Result<()> {
    // Throws if the backing buffer was detached (transferred); `data` is
    // non-configurable so it cannot be deleted.
    let data = image_data.resolve_pixels(&env)?;
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
        return Ok(());
      }
      // drawImageRect records nothing unless `fillable` holds for BOTH the
      // src and dst rects the C++ builds (skia_c.cpp:
      // skiac_canvas_put_image_data, SkCanvas.cpp fillable). The clamp above
      // only catches <= 0; NaN, infinity, and f32 edge collapse (e.g.
      // dirtyX=16777216, dirtyWidth=1: 16777216+1 rounds back to 16777216)
      // also produce empty rects -- charge nothing and skip the pixel copy
      // for a draw Skia deterministically rejects.
      if !(Context::rect_fillable(dirty_x, dirty_width)
        && Context::rect_fillable(dirty_y, dirty_height)
        && Context::rect_fillable(dx as f32 + dirty_x, dirty_width)
        && Context::rect_fillable(dy as f32 + dirty_y, dirty_height))
      {
        return Ok(());
      }
      // Deferred mode: record via PageRecorder on a fresh layer (no clip/transform)
      // put_image_data uses drawImageRect with kSrc blend (pixel replacement),
      // which IS recordable by PictureRecorder unlike SkCanvas::writePixels.
      // snapshot=true: copy pixel data so the SkPicture is independent of the
      // JS buffer (required when the same ImageData is reused across calls).
      // The budget check runs BEFORE the pixel charge lands in put_pixels,
      // so a flush cannot erase this op's charge.
      self.context.flush_if_recording_limit_exceeded();
      if let Some(ref recorder) = self.context.page_recorder {
        let dx_f = dx as f32;
        let width = image_data.width;
        let height = image_data.height;
        let color_space = image_data.color_space;
        // The recorded op pins a copy of the whole ImageData buffer.
        let pixel_bytes = width * height * 4;
        recorder.borrow_mut().put_pixels(pixel_bytes, |canvas| {
          canvas.put_image_data(
            data,
            width,
            height,
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
        // The charge may have tripped the cap on its own (a single
        // putImageData can pin a multi-hundred-MB pixel copy); consolidate
        // now so it is not retained while the context sits idle.
        self.context.flush_if_recording_limit_exceeded();
        return Ok(());
      }
      // Direct mode (SVG/PDF): write to surface canvas with inverted transform
      // snapshot=false: pixels are consumed immediately, no copy needed.
      let inverted = self.context.surface.canvas.get_transform_matrix().invert();
      self.context.surface.canvas.save();
      if let Some(inverted) = inverted {
        self.context.surface.canvas.concat(&inverted);
      };
      self.context.surface.canvas.put_image_data(
        data,
        image_data.width,
        image_data.height,
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
      self.context.note_direct_mutation();
    } else {
      // Deferred mode: use put_image_data with full image dimensions
      // because write_pixels (SkCanvas::writePixels) is NOT recordable by PictureRecorder
      self.context.flush_if_recording_limit_exceeded();
      if let Some(ref recorder) = self.context.page_recorder {
        let dx_f = dx as f32;
        let dy_f = dy as f32;
        let w = image_data.width as f32;
        let h = image_data.height as f32;
        let width = image_data.width;
        let height = image_data.height;
        let color_space = image_data.color_space;
        // The recorded op pins a copy of the whole ImageData buffer.
        let pixel_bytes = width * height * 4;
        recorder.borrow_mut().put_pixels(pixel_bytes, |canvas| {
          canvas.put_image_data(
            data,
            width,
            height,
            dx_f,
            dy_f,
            0.0,
            0.0,
            w,
            h,
            color_space,
            true,
          );
        });
        self.context.flush_if_recording_limit_exceeded();
        return Ok(());
      }
      // Direct mode (SVG/PDF): write pixels directly
      self
        .context
        .surface
        .canvas
        .write_pixels(data, image_data.width, image_data.height, dx, dy);
      self.context.note_direct_mutation();
    }
    Ok(())
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
  Borrowed(&'a Bitmap),
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
  Png(SkImage),
  Jpeg(SkImage, u8),
  Webp(SkImage, u8),
  Avif(SkImage, Config, u32, u32),
  Gif(SkImage, GifConfig, u32, u32),
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
    ContextData::Png(image) => image
      .encode_data(SkEncodedImageFormat::Png, 100)
      .map(ContextOutputData::Skia)
      .ok_or_else(|| {
        Error::new(
          Status::GenericFailure,
          "Get png data from surface failed".to_string(),
        )
      }),
    ContextData::Jpeg(image, quality) => image
      .encode_data(SkEncodedImageFormat::Jpeg, *quality)
      .map(ContextOutputData::Skia)
      .ok_or_else(|| {
        Error::new(
          Status::GenericFailure,
          "Get jpeg data from surface failed".to_string(),
        )
      }),
    ContextData::Webp(image, quality) => image
      .encode_data(SkEncodedImageFormat::Webp, *quality)
      .map(ContextOutputData::Skia)
      .ok_or_else(|| {
        Error::new(
          Status::GenericFailure,
          "Get webp data from surface failed".to_string(),
        )
      }),
    ContextData::Avif(image, config, width, height) => image
      .read_pixels(AlphaType::Unpremultiplied)
      .ok_or_else(|| {
        Error::new(
          Status::GenericFailure,
          "Get avif data from surface failed".to_string(),
        )
      })
      .and_then(|pixels| {
        crate::avif::encode(&pixels, *width, *height, config)
          .map(ContextOutputData::Avif)
          .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))
      }),
    ContextData::Gif(image, config, width, height) => image
      .read_pixels(AlphaType::Unpremultiplied)
      .ok_or_else(|| {
        Error::new(
          Status::GenericFailure,
          "Get gif data from surface failed".to_string(),
        )
      })
      .and_then(|pixels| {
        crate::gif::encode(&pixels, *width, *height, config)
          .map(ContextOutputData::Gif)
          .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))
      }),
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

/// Blink's `ClampTo<float>`: a finite double outside the float range saturates
/// at +/-FLT_MAX. A plain `as f32` would overflow to infinity instead, which
/// every downstream Skia filter rejects.
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

  fn raster_ctx(width: u32, height: u32) -> Context {
    Context::new(width, height, ColorSpace::default()).expect("raster context")
  }

  fn pending(ctx: &Context) -> usize {
    ctx.page_recorder.as_ref().unwrap().borrow().pending_bytes()
  }

  fn raster_bytes(ctx: &Context) -> usize {
    ctx
      .page_recorder
      .as_ref()
      .unwrap()
      .borrow()
      .retained_raster_bytes()
  }

  fn retained(ctx: &Context) -> usize {
    ctx
      .page_recorder
      .as_ref()
      .unwrap()
      .borrow()
      .retained_raster_count()
  }

  fn layers(ctx: &Context) -> usize {
    ctx.page_recorder.as_ref().unwrap().borrow().layer_count()
  }

  fn consolidations(ctx: &Context) -> u64 {
    ctx
      .page_recorder
      .as_ref()
      .unwrap()
      .borrow()
      .consolidations()
  }

  fn set_recording_limit(ctx: &Context, bytes: usize) {
    ctx
      .page_recorder
      .as_ref()
      .unwrap()
      .borrow_mut()
      .set_recording_limit(bytes);
  }

  /// The dedup key draw_image wrappers build for a canvas source:
  /// (resource_id, content_version).
  fn canvas_source_key(src: &Context) -> RasterKey {
    RasterKey::Resource {
      id: src.resource_id,
      generation: src.content_version(),
    }
  }

  /// Unpremultiplied RGBA pixels (one color) for put_image_data / bitmaps.
  fn rgba_pixels(width: usize, height: usize, rgba: [u8; 4]) -> Vec<u8> {
    let mut pixels = vec![0u8; width * height * 4];
    for px in pixels.as_chunks_mut::<4>().0 {
      *px = rgba;
    }
    pixels
  }

  /// A non-canvas bitmap over a copy of `pixels` (is_canvas = false arm).
  fn test_bitmap(width: usize, height: usize, rgba: [u8; 4]) -> Bitmap {
    let mut pixels = rgba_pixels(width, height, rgba);
    Bitmap::from_image_data(
      pixels.as_mut_ptr(),
      width,
      height,
      width * 4,
      width * height * 4,
      crate::sk::ColorType::RGBA8888,
      AlphaType::Unpremultiplied,
    )
    .expect("bitmap")
  }

  /// Read a single surface pixel through the deferred flush path.
  fn pixel_at(ctx: &mut Context, x: f32, y: f32) -> [u8; 4] {
    let data = ctx
      .get_image_data(x, y, 1.0, 1.0, ColorSpace::default())
      .expect("pixels");
    [data[0], data[1], data[2], data[3]]
  }

  // The deferred recording must consolidate once charged bytes pass the cap:
  // a pure draw loop over a shrunken limit consolidates repeatedly while
  // pending stays bounded and the generation counts only pixel ops.
  #[test]
  fn recording_limit_trips_consolidation_in_a_draw_loop() {
    let mut ctx = raster_ctx(32, 32);
    set_recording_limit(&ctx, 8 * 1024);
    for _ in 0..200 {
      ctx.fill_rect(0.0, 0.0, 8.0, 8.0).unwrap();
    }
    assert!(consolidations(&ctx) >= 1);
    // A flush can carry one fresh op plus one promoted-layer charge past the
    // cap, so bound pending at twice the window.
    assert!(pending(&ctx) < 2 * 8 * 1024);
    assert_eq!(ctx.content_version(), 200);
  }

  // A read must flush pending layers onto the surface and consolidate them
  // into the O(canvas) snapshot layer.
  #[test]
  fn get_image_data_flushes_and_consolidates_layers() {
    let mut ctx = raster_ctx(32, 32);
    ctx.fill_rect(0.0, 0.0, 16.0, 16.0).unwrap();
    let pixels = rgba_pixels(8, 8, [0, 0, 255, 255]);
    ctx
      .page_recorder
      .as_ref()
      .unwrap()
      .borrow_mut()
      .put_pixels(8 * 8 * 4, |canvas| {
        canvas.put_image_data(
          pixels.as_ptr(),
          8,
          8,
          20.0,
          20.0,
          0.0,
          0.0,
          8.0,
          8.0,
          ColorSpace::default(),
          true,
        );
      });
    assert!(layers(&ctx) >= 1);
    assert!(pending(&ctx) > 0);

    // The put layer plus the recorded fill: >1 layer, so the read's flush
    // consolidates unconditionally.
    assert_eq!(pixel_at(&mut ctx, 21.0, 21.0), [0, 0, 255, 255]);
    assert!(consolidations(&ctx) >= 1);
    assert_eq!(pending(&ctx), 0);
    assert_eq!(layers(&ctx), 1);
    assert_eq!(raster_bytes(&ctx), 32 * 32 * 4);
  }

  // drawImage's retained-raster charge is keyed on (source id, generation):
  // an unchanged source charges once, state-only ops between draws keep the
  // dedup, a pixel mutation re-charges under the new generation, a zero-area
  // clear does not mutate, and a real one does.
  #[test]
  fn draw_image_dedups_by_source_content_generation() {
    let mut src = raster_ctx(16, 16);
    src.state.fill_style = Pattern::from_color("#ff0000").unwrap();
    src.fill_rect(0.0, 0.0, 16.0, 16.0).unwrap();
    let mut dest = raster_ctx(16, 16);
    let bitmap = src.surface.get_bitmap();

    dest
      .draw_image(
        &bitmap,
        canvas_source_key(&src),
        0.0,
        0.0,
        16.0,
        16.0,
        0.0,
        0.0,
        16.0,
        16.0,
      )
      .unwrap();
    assert_eq!(retained(&dest), 1);
    assert_eq!(raster_bytes(&dest), 16 * 16 * 4);

    // Same key, second draw: still one charge.
    dest
      .draw_image(
        &bitmap,
        canvas_source_key(&src),
        0.0,
        0.0,
        16.0,
        16.0,
        0.0,
        0.0,
        16.0,
        16.0,
      )
      .unwrap();
    assert_eq!(retained(&dest), 1);
    assert_eq!(raster_bytes(&dest), 16 * 16 * 4);

    // State-only churn on the source does not bump its generation.
    src.save();
    src.translate(4.0, 4.0);
    src.restore();
    dest
      .draw_image(
        &bitmap,
        canvas_source_key(&src),
        0.0,
        0.0,
        16.0,
        16.0,
        0.0,
        0.0,
        16.0,
        16.0,
      )
      .unwrap();
    assert_eq!(retained(&dest), 1);
    assert_eq!(raster_bytes(&dest), 16 * 16 * 4);

    // A deterministically empty clearRect paints nothing and must not bump.
    let version = src.content_version();
    src.clear_rect(0.0, 0.0, 0.0, 0.0).unwrap();
    assert_eq!(src.content_version(), version);
    dest
      .draw_image(
        &bitmap,
        canvas_source_key(&src),
        0.0,
        0.0,
        16.0,
        16.0,
        0.0,
        0.0,
        16.0,
        16.0,
      )
      .unwrap();
    assert_eq!(retained(&dest), 1);

    // A real mutation COWs a fresh raster and re-charges under the new
    // generation.
    src.fill_rect(0.0, 0.0, 4.0, 4.0).unwrap();
    dest
      .draw_image(
        &bitmap,
        canvas_source_key(&src),
        0.0,
        0.0,
        16.0,
        16.0,
        0.0,
        0.0,
        16.0,
        16.0,
      )
      .unwrap();
    assert_eq!(retained(&dest), 2);
    assert_eq!(raster_bytes(&dest), 16 * 16 * 4 * 2);
  }

  // Ops that provably paint nothing record nothing: no bytes, no generation
  // bump, no retained payloads.
  #[test]
  fn deterministically_empty_ops_leave_the_recording_untouched() {
    let mut ctx = raster_ctx(32, 32);
    ctx.fill_rect(0.0, 0.0, 32.0, 32.0).unwrap();
    let pending0 = pending(&ctx);
    let raster0 = raster_bytes(&ctx);
    let retained0 = retained(&ctx);
    let version0 = ctx.content_version();

    ctx.fill_rect(0.0, 0.0, 0.0, 8.0).unwrap();
    ctx.fill_rect(0.0, 0.0, 8.0, 0.0).unwrap();
    // f32 edge collapse: 16777216 + 1 rounds back to 16777216.
    ctx.fill_rect(16777216.0, 0.0, 1.0, 8.0).unwrap();
    ctx.fill_rect(f32::NAN, 0.0, 8.0, 8.0).unwrap();
    ctx.fill_rect(0.0, 0.0, 8.0, f32::INFINITY).unwrap();
    ctx.clear_rect(0.0, 0.0, 0.0, 0.0).unwrap();

    // Empty path: no verbs at all, then degenerate moveTo-only bounds.
    ctx.begin_path();
    ctx.fill(None, FillType::Winding).unwrap();
    ctx.begin_path();
    ctx.path.move_to(4.0, 4.0);
    ctx.fill(None, FillType::Winding).unwrap();
    ctx.begin_path();
    ctx.stroke(None).unwrap();

    // Zero source/dest rect draws (canvas-backed and raw-bitmap arms).
    let mut src = raster_ctx(8, 8);
    let src_bitmap = src.surface.get_bitmap();
    let key = canvas_source_key(&src);
    ctx
      .draw_image(&src_bitmap, key, 0.0, 0.0, 8.0, 8.0, 0.0, 0.0, 0.0, 8.0)
      .unwrap();
    let bitmap = test_bitmap(8, 8, [255, 0, 0, 255]);
    ctx
      .draw_image(&bitmap, key, 0.0, 0.0, 8.0, 8.0, 0.0, 0.0, 8.0, 0.0)
      .unwrap();
    let picture = src.get_picture();
    if let Some(picture) = picture {
      ctx
        .draw_canvas(&picture, 0, 0.0, 0.0, 0.0, 8.0, 0.0, 0.0, 8.0, 8.0)
        .unwrap();
      ctx
        .draw_canvas(&picture, 0, 0.0, 0.0, 8.0, 8.0, 0.0, 0.0, 8.0, 0.0)
        .unwrap();
    }

    // The dirty-rect predicates the putImageData wrapper gates on.
    assert!(!Context::rect_fillable(f32::NAN, 8.0));
    assert!(!Context::rect_fillable(16777216.0, 1.0));
    assert!(!Context::rect_fillable(0.0, f32::INFINITY));
    assert!(Context::rect_fillable(0.0, 8.0));

    assert_eq!(pending(&ctx), pending0);
    assert_eq!(raster_bytes(&ctx), raster0);
    assert_eq!(retained(&ctx), retained0);
    assert_eq!(ctx.content_version(), version0);
  }

  // A drawCanvas destination is charged the source recorder's retained
  // raster bytes -- the payload approx_bytes_used cannot see -- keyed on the
  // picture's uniqueID so an unchanged source charges once and a mutated one
  // (fresh picture) re-charges.
  #[test]
  fn draw_canvas_charges_dest_with_source_raster_bytes() {
    let mut src = raster_ctx(16, 16);
    let pixels = rgba_pixels(4, 4, [255, 0, 0, 255]);
    src
      .page_recorder
      .as_ref()
      .unwrap()
      .borrow_mut()
      .put_pixels(4 * 4 * 4, |canvas| {
        canvas.put_image_data(
          pixels.as_ptr(),
          4,
          4,
          0.0,
          0.0,
          0.0,
          0.0,
          4.0,
          4.0,
          ColorSpace::default(),
          true,
        );
      });
    let source_raster_bytes = src
      .page_recorder
      .as_ref()
      .unwrap()
      .borrow()
      .retained_raster_bytes();
    assert_eq!(source_raster_bytes, 4 * 4 * 4);

    let mut dest = raster_ctx(16, 16);
    let pending0 = pending(&dest);
    let picture = src.get_picture().expect("source picture");
    dest
      .draw_canvas(
        &picture,
        source_raster_bytes,
        0.0,
        0.0,
        16.0,
        16.0,
        0.0,
        0.0,
        16.0,
        16.0,
      )
      .unwrap();
    assert!(pending(&dest) >= pending0 + source_raster_bytes);
    assert_eq!(raster_bytes(&dest), source_raster_bytes);
    assert_eq!(retained(&dest), 1);

    // Unchanged source -> same cached picture uid -> no second charge.
    let picture = src.get_picture().expect("source picture");
    dest
      .draw_canvas(
        &picture,
        source_raster_bytes,
        0.0,
        0.0,
        16.0,
        16.0,
        0.0,
        0.0,
        16.0,
        16.0,
      )
      .unwrap();
    assert_eq!(retained(&dest), 1);
    assert_eq!(raster_bytes(&dest), source_raster_bytes);

    // Mutated source -> regenerated picture uid -> re-charged.
    src.fill_rect(0.0, 0.0, 4.0, 4.0).unwrap();
    let source_raster_bytes = src
      .page_recorder
      .as_ref()
      .unwrap()
      .borrow()
      .retained_raster_bytes();
    let picture = src.get_picture().expect("source picture");
    dest
      .draw_canvas(
        &picture,
        source_raster_bytes,
        0.0,
        0.0,
        16.0,
        16.0,
        0.0,
        0.0,
        16.0,
        16.0,
      )
      .unwrap();
    assert_eq!(retained(&dest), 2);
    assert_eq!(raster_bytes(&dest), source_raster_bytes * 2);
  }

  // Round-18 regression: dx = f32::MAX with dw = 1e38 makes the C++ helper's
  // `dx - sx * scale_x` term land on an fma/fused-rounding boundary. The Rust
  // preflight must not skip what native code decides, so the op is recorded
  // (charged) regardless of which way the fused arithmetic rounds.
  #[test]
  fn draw_canvas_records_through_fused_arithmetic_boundary() {
    let mut src = raster_ctx(8, 8);
    src.state.fill_style = Pattern::from_color("#ff0000").unwrap();
    src.fill_rect(0.0, 0.0, 8.0, 8.0).unwrap();
    let picture = src.get_picture().expect("source picture");

    let mut ctx = raster_ctx(32, 32);
    ctx.set_transform(Matrix::new(-1e-30, 0.0, 0.0, 1.0, 0.0, 0.0));
    let pending0 = pending(&ctx);
    let version0 = ctx.content_version();
    ctx
      .draw_canvas(
        &picture,
        0,
        0.0,
        0.0,
        1e10,
        10.0,
        3.4028235e38,
        0.0,
        1e38,
        10.0,
      )
      .unwrap();
    assert!(pending(&ctx) >= pending0 + 256);
    assert_eq!(ctx.content_version(), version0 + 1);
  }

  // A put_pixels layer stays a layer under later recorded ops and replays
  // beneath them on flush.
  #[test]
  fn put_pixels_layer_orders_under_later_recorded_ops() {
    let mut ctx = raster_ctx(8, 8);
    let pixels = rgba_pixels(4, 4, [0, 0, 255, 255]);
    ctx
      .page_recorder
      .as_ref()
      .unwrap()
      .borrow_mut()
      .put_pixels(4 * 4 * 4, |canvas| {
        canvas.put_image_data(
          pixels.as_ptr(),
          4,
          4,
          1.0,
          1.0,
          0.0,
          0.0,
          4.0,
          4.0,
          ColorSpace::default(),
          true,
        );
      });
    assert_eq!(layers(&ctx), 1);
    assert_eq!(raster_bytes(&ctx), 4 * 4 * 4);
    assert_eq!(ctx.content_version(), 1);

    ctx.state.fill_style = Pattern::from_color("#00ff00").unwrap();
    ctx.fill_rect(2.0, 2.0, 2.0, 2.0).unwrap();
    assert_eq!(ctx.content_version(), 2);
    assert_eq!(pixel_at(&mut ctx, 1.0, 1.0), [0, 0, 255, 255]);
    assert_eq!(pixel_at(&mut ctx, 2.0, 2.0), [0, 255, 0, 255]);
  }

  // with_surface_canvas flushes pending ops under the direct write, marks
  // the layers stale (no rebase snapshot yet) and bumps the generation;
  // get_picture then materializes the rebase.
  #[test]
  fn direct_surface_write_marks_layers_stale_until_get_picture() {
    let mut ctx = raster_ctx(16, 16);
    ctx.state.fill_style = Pattern::from_color("#ff0000").unwrap();
    ctx.fill_rect(0.0, 0.0, 16.0, 16.0).unwrap();
    let version0 = ctx.content_version();

    ctx.with_surface_canvas(|canvas| canvas.clear());
    assert!(ctx.recorder_surface_dirty());
    assert_eq!(layers(&ctx), 0);
    assert_eq!(pending(&ctx), 0);
    assert_eq!(ctx.content_version(), version0 + 1);

    assert!(ctx.get_picture().is_some());
    assert!(!ctx.recorder_surface_dirty());
    assert_eq!(layers(&ctx), 1);
    assert_eq!(raster_bytes(&ctx), 16 * 16 * 4);
    assert_eq!(consolidations(&ctx), 1);
  }

  // The ctx.filter DAG is one refcounted ImageFilter per state: repeated
  // draws under it charge its proxy bytes once per window.
  #[test]
  fn filter_chain_charges_once_per_window() {
    let mut ctx = raster_ctx(32, 32);
    ctx.set_filter("blur(2px) brightness(0.5)").unwrap();
    for _ in 0..3 {
      ctx.fill_rect(0.0, 0.0, 8.0, 8.0).unwrap();
    }
    assert_eq!(retained(&ctx), 1);
    assert_eq!(raster_bytes(&ctx), "blur(2px) brightness(0.5)".len() * 8);
  }

  // Every recorded text blob refs the same resolved face, so the flat 1 MiB
  // typeface charge dedups per descriptor per window. Registered test font
  // keeps the result host-independent.
  #[test]
  fn fill_text_dedups_the_typeface_charge() {
    {
      let fonts = get_font().unwrap();
      fonts.register_from_path::<String>("__test__/fonts/Lato-Regular.ttf", None);
    }
    let mut ctx = raster_ctx(64, 64);
    ctx.set_font("16px Lato".to_owned()).unwrap();
    for _ in 0..3 {
      ctx.fill_text("hello", 0.0, 16.0, MAX_TEXT_WIDTH).unwrap();
    }
    assert_eq!(retained(&ctx), 1);
    assert_eq!(raster_bytes(&ctx), 1024 * 1024);

    // A text draw that cannot record (interior NUL) commits no charge.
    let pending0 = pending(&ctx);
    let version0 = ctx.content_version();
    assert!(ctx.fill_text("a\0b", 0.0, 16.0, MAX_TEXT_WIDTH).is_err());
    assert_eq!(pending(&ctx), pending0);
    assert_eq!(ctx.content_version(), version0);
  }

  // measureText's line-metrics path builds paints but must leave the
  // recorder untouched -- it is a read, not a draw.
  #[test]
  fn measure_text_path_does_not_charge_the_recording() {
    let mut ctx = raster_ctx(64, 64);
    ctx.fill_rect(0.0, 0.0, 8.0, 8.0).unwrap();
    let pending0 = pending(&ctx);
    let raster0 = raster_bytes(&ctx);
    let version0 = ctx.content_version();
    ctx.get_line_metrics("measure me").unwrap();
    assert_eq!(pending(&ctx), pending0);
    assert_eq!(raster_bytes(&ctx), raster0);
    assert_eq!(ctx.content_version(), version0);
  }

  // Consolidated layers re-emit the tracked save stack, clip and transform:
  // ops recorded after a mid-state consolidation land exactly where they
  // would without the flush.
  #[test]
  fn flush_mid_state_restores_save_clip_and_transform() {
    let mut ctx = raster_ctx(32, 32);
    set_recording_limit(&ctx, 64);
    ctx.save();
    ctx.translate(8.0, 8.0);
    ctx.begin_path();
    ctx.rect(4.0, 4.0, 8.0, 8.0);
    ctx.clip(None, FillType::Winding);
    // The first fill lands the recording past the shrunken cap; the second
    // op's pre-check flushes and consolidates mid-state.
    ctx.state.fill_style = Pattern::from_color("#ff0000").unwrap();
    ctx.fill_rect(0.0, 0.0, 32.0, 32.0).unwrap();
    assert!(consolidations(&ctx) >= 1);
    ctx.fill_rect(0.0, 0.0, 32.0, 32.0).unwrap();
    ctx.restore();

    // Translated [12,20) clip over a full-canvas fill: inside is the fill,
    // outside is transparent.
    assert_eq!(pixel_at(&mut ctx, 13.0, 13.0), [255, 0, 0, 255]);
    assert_eq!(pixel_at(&mut ctx, 24.0, 24.0), [0, 0, 0, 0]);
  }

  // Context::reset zeroes every accounting counter and bumps the generation
  // exactly once (a mutation that bypasses the dedup window).
  #[test]
  fn context_reset_zeroes_accounting_and_bumps_version() {
    let mut ctx = raster_ctx(16, 16);
    ctx.fill_rect(0.0, 0.0, 16.0, 16.0).unwrap();
    assert!(pending(&ctx) > 0);
    let version0 = ctx.content_version();

    ctx.reset();
    assert_eq!(pending(&ctx), 0);
    assert_eq!(layers(&ctx), 0);
    assert_eq!(raster_bytes(&ctx), 0);
    assert_eq!(retained(&ctx), 0);
    assert_eq!(ctx.content_version(), version0 + 1);
  }

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
