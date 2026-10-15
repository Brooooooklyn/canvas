use std::cell::{Cell, RefCell};
use std::f32::consts::PI;
use std::marker::PhantomData;
use std::mem;
use std::result;
use std::str::FromStr;
use std::sync::LazyLock;

use cssparser::Parser;
use cssparser_color::Color as CSSColor;
use napi::bindgen_prelude::*;
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
  num,
  path::{Path, check_round_rect},
  pattern::{CanvasPattern, Pattern, hsl_to_rgba8, srgb_channel_to_u8},
  sk::{
    AccountedBitmap, AlphaType, Bitmap, BlendMode, ColorSpace, DecodedCopy, FillType,
    FilterQuality, FontVariantCaps, ImageFilter, ImagePattern, LineMetrics, MaskFilter, Matrix,
    Paint, PaintStyle, Path as SkPath, PathEffect, ReadPixelsError, Shader, SkEncodedImageFormat,
    SkImage, SkWMemoryStream, SkiaDataRef, StrokeCap, StrokeJoin, Surface, Transform,
  },
  state::Context2dRenderingState,
  webidl::{self, Double, Positional, ReportedSettings},
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
/// Where the canvas classes keep a context's canvas, for the `canvas` getter.
pub(crate) const CANVAS_HIDDEN_NAME: &str = "_canvas";

/// The fillStyle/strokeStyle getters read these hidden JS properties, so every
/// reset to the default state (ctx.reset(), and a width/height change, which
/// Chrome runs through the same Reset: html_canvas_element.cc:870-872) must
/// reset them too.
pub(crate) fn reset_style_getters(ctx: &mut Object) -> Result<()> {
  ctx.set_named_property(FILL_STYLE_HIDDEN_NAME, "#000000")?;
  ctx.set_named_property(STROKE_STYLE_HIDDEN_NAME, "#000000")?;
  Ok(())
}

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
  /// Blink's `ShouldUseDropShadowPaintFilter` (canvas_2d_recorder_context.h:
  /// 571-577): a path or rect filled or stroked with a pattern. With a shadow,
  /// it sends even `copy` through `CompositedDraw`, which draws the content
  /// src-over inside the layer. See `render_canvas`.
  pattern_geometry: bool,
}

// The same, borrowed, plus what `render_canvas` needs to size the shadow layer.
struct ShadowPass<'a> {
  paint: &'a Paint,
  filter: Option<&'a ImageFilter>,
  pattern_geometry: bool,
  offset_x: f32,
  offset_y: f32,
  blur: f32,
}

/// The user-space rect a draw hands Blink's Draw as `bounds`. Only the
/// alpha:false alpha reset reads it, and only for a draw Blink does not take
/// through CompositedDraw: Blink limits ResetAlphaIfNeeded to it there
/// (canvas_2d_recorder_context.h:729-752, 837, 853), and resets the whole clip
/// after a composited one (h:826-829). `blink_composites` makes that call.
#[derive(Clone, Copy)]
pub(crate) struct DrawBounds {
  left: f32,
  top: f32,
  right: f32,
  bottom: f32,
}

impl DrawBounds {
  /// Blink AdjustRectForCanvas: a negative width or height flips the rect.
  fn rect(x: f32, y: f32, width: f32, height: f32) -> Self {
    DrawBounds {
      left: x.min(x + width),
      top: y.min(y + height),
      right: x.max(x + width),
      bottom: y.max(y + height),
    }
  }

  /// A path's bounds (Blink: CanvasPath::BoundingRect, for us SkPath's).
  /// None when they are not finite: then no bounds are passed.
  fn path(path: &SkPath) -> Option<Self> {
    let (left, top, right, bottom) = path.get_bounds();
    (left.is_finite() && top.is_finite() && right.is_finite() && bottom.is_finite()).then_some(
      DrawBounds {
        left,
        top,
        right,
        bottom,
      },
    )
  }

  fn outset(self, delta: f32) -> Self {
    DrawBounds {
      left: self.left - delta,
      top: self.top - delta,
      right: self.right + delta,
      bottom: self.bottom + delta,
    }
  }
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
    Self::new_with_alpha(width, height, color_space, true)
  }

  /// A raster context. alpha:false gets a kOpaque surface cleared to opaque
  /// black, as Blink's resource provider does at creation
  /// (canvas_resource_provider.cc ClearAtCreation, kBlack for kOpaque).
  /// Chrome allocates it lazily and reads an untouched canvas as zeros; the
  /// spec, and Chrome's own display, say black from the start.
  pub fn new_with_alpha(
    width: u32,
    height: u32,
    color_space: ColorSpace,
    alpha: bool,
  ) -> Result<Self> {
    let surface = if alpha {
      Surface::new_rgba_premultiplied(width, height, color_space)
    } else {
      Surface::new_rgba_opaque(width, height, color_space)
    }
    .ok_or_else(|| Error::from_reason("Create skia surface failed".to_owned()))?;
    let mut context = Context {
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
    };
    if !alpha {
      context.set_opaque();
    }
    Ok(context)
  }

  /// Make a fresh context alpha:false and paint its opaque black base. The
  /// base is a direct surface write: with_surface_canvas bumps the content
  /// version and, on raster, marks the recorded layers stale so drawCanvas
  /// rebases on the surface. The canvas is clean, so no paint state (or
  /// anything set through the internal `canvas.ctx`) reaches the base.
  pub(crate) fn set_opaque(&mut self) {
    self.alpha = false;
    if let Some(ref recorder) = self.page_recorder {
      recorder.borrow_mut().set_opaque();
    }
    self.with_surface_canvas(|canvas| canvas.fill(0, 0, 0, 255));
  }

  /// Clear the surface to the context's base: transparent, or opaque black
  /// for alpha:false (Blink GetClearFlags).
  fn clear_surface_to_base(&mut self) {
    if self.alpha {
      self.surface.canvas.clear();
    } else {
      self.surface.canvas.fill(0, 0, 0, 255);
    }
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

  /// Draw the pending recording into the surface: the PageRecorder of a
  /// raster canvas, or what an SVGCanvas recorded beside its SVG output. Every
  /// read of the surface pixels comes after this.
  pub fn flush(&mut self) {
    if self.backend == Backend::Svg {
      self.surface.flush_svg();
      return;
    }
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
    self.account_style_resources(style);
    self.account_draw_resources();
  }

  /// The fill or stroke style's share of `account_paint_resources`.
  fn account_style_resources(&self, style: &Pattern) {
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
        );
        // A decode copy the shader samples in place of the original is held
        // by the recorded paint, charged once per window like a drawImage
        // level. The paint was built for this draw, so this is its shader.
        if let Some((_, Some((uid, bytes)))) = self.image_pattern_shader(image) {
          self.account_raster_resource(RasterKey::Image { uid }, bytes);
        }
      }
      Pattern::Gradient(gradient) => self.account_raster_bytes(gradient.estimated_bytes()),
      Pattern::Color(..) => {}
    };
  }

  /// The share of `account_paint_resources` every fill and stroke pays
  /// whatever its style: the dash list, plus what an image draw also pays
  /// (`account_image_paint_resources`).
  fn account_draw_resources(&self) {
    // Fresh per draw (the dash list compiles into a fresh SkPathEffect):
    // per-draw charge in the propagated tally, no dedup.
    self.account_raster_bytes(self.state.line_dash_list.len() * 4);
    self.account_image_paint_resources();
  }

  /// The part of `account_paint_resources` an image draw retains. Its paint
  /// (`image_paint`) carries no fillStyle and no dash, only the `ctx.filter`
  /// chain and the shadow.
  fn account_image_paint_resources(&self) {
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
    // Fresh per draw (shadow_paint builds a fresh DropShadowOnly graph):
    // per-draw charge in the propagated tally, no dedup.
    self.account_raster_bytes(shadow_bytes);
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
    // inert. Source-over whatever globalCompositeOperation is: Blink's
    // clearRect draws its rect straight with GetClearFlags and never reads the
    // composite op (canvas_2d_recorder_context.cc:1928-1985).
    self.render_passes(
      BlendMode::SourceOver,
      paint,
      DrawContent::Geometry,
      None,
      false,
      None,
      None,
      false,
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
  ///
  /// `pattern_style` is Blink's kNonOpaqueImage: a fill or stroke whose style
  /// is a CanvasPattern. Text and images never pass it
  /// (base_rendering_context_2d.cc:1113, canvas_2d_recorder_context.cc:2342).
  fn with_shadowed_render_canvas<S, F>(
    &mut self,
    paint: &Paint,
    content: DrawContent,
    shadow: Option<&ShadowDraw>,
    bounds: Option<DrawBounds>,
    pattern_style: bool,
    shadow_f: S,
    f: F,
  ) -> result::Result<(), SkError>
  where
    S: Fn(&mut Canvas, &Paint, &Matrix) -> result::Result<(), SkError>,
    F: Fn(&mut Canvas, &Paint) -> result::Result<(), SkError>,
  {
    let content_filter = self.state.filter.clone();
    self.render_passes(
      self.state.global_composite_operation,
      paint,
      content,
      content_filter,
      self.state.has_filter,
      shadow,
      bounds,
      pattern_style,
      shadow_f,
      f,
    )
  }

  /// Shared body of the two above. The shadow closure is handed the user->device
  /// matrix as its third argument because it cannot read one off the canvas it
  /// is given -- that canvas may be a recorder at identity, or sit inside a
  /// filter layer. Pass it straight to `apply_shadow_offset_matrix_to_canvas`.
  ///
  /// `has_filter` is Blink's StateHasFilter for the draw: true also when the
  /// assigned filter built no `content_filter`.
  fn render_passes<S, F>(
    &mut self,
    blend_mode: BlendMode,
    paint: &Paint,
    content: DrawContent,
    content_filter: Option<ImageFilter>,
    has_filter: bool,
    shadow: Option<&ShadowDraw>,
    bounds: Option<DrawBounds>,
    pattern_style: bool,
    shadow_f: S,
    f: F,
  ) -> result::Result<(), SkError>
  where
    S: Fn(&mut Canvas, &Paint, &Matrix) -> result::Result<(), SkError>,
    F: Fn(&mut Canvas, &Paint) -> result::Result<(), SkError>,
  {
    // Blink's Draw returns before drawing anything when the CTM is singular
    // (canvas_2d_recorder_context.h:866-868), and so does clearRect (.cc:1940):
    // copy must not clear the clip for a draw that has no device space.
    if !self.transform_is_invertible() {
      return Ok(());
    }
    // The alpha:false reset covers the whole clip after a draw Blink
    // composites, whatever route we take for it.
    let bounds = if Self::blink_composites(blend_mode, has_filter, shadow.is_some(), pattern_style)
    {
      None
    } else {
      bounds
    };
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
      pattern_geometry: shadow.pattern_geometry,
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
          self.backend,
          self.alpha,
          bounds,
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
      self.backend,
      self.alpha,
      bounds,
      width,
      height,
      shadow,
      &mut nested_picture_bytes,
      shadow_f,
      f,
    );
    // No alpha reset on SVG (see render_canvas); PDF is never alpha:false.
    self.note_direct_mutation();
    result
  }

  /// Blink ResetAlphaIfNeeded (canvas_2d_recorder_context.h:699-709,
  /// 729-752): on an alpha:false canvas a composite mode that can lower the
  /// destination alpha is followed by an opaque black kDstOver fill, which
  /// puts alpha back to 255 (the result is composited over black). It is a
  /// plain rect with no anti-aliasing over the clip, limited to the draw
  /// `bounds` where the caller passes them; an anti-aliased edge outside
  /// them keeps its lowered alpha, as in Chrome.
  fn reset_alpha_if_needed(
    canvas: &mut Canvas,
    blend_mode: BlendMode,
    bounds: Option<DrawBounds>,
    width: f32,
    height: f32,
  ) {
    if !matches!(
      blend_mode,
      BlendMode::Source
        | BlendMode::SourceIn
        | BlendMode::DestinationIn
        | BlendMode::SourceOut
        | BlendMode::DestinationOut
        | BlendMode::SourceATop
        | BlendMode::DestinationATop
        | BlendMode::Xor
        | BlendMode::Modulate
    ) {
      return;
    }
    let mut paint = Paint::new();
    paint.set_style(PaintStyle::Fill);
    paint.set_color(0, 0, 0, 255);
    paint.set_blend_mode(BlendMode::DestinationOver);
    match bounds {
      // Drawn under the CTM, as Blink draws the local rect.
      Some(b) => canvas.draw_rect(b.left, b.top, b.right - b.left, b.bottom - b.top, &paint),
      // The whole clip (Blink: its local clip bounds).
      None => {
        canvas.save();
        canvas.reset_transform();
        canvas.draw_rect(0.0, 0.0, width, height, &paint);
        canvas.restore();
      }
    }
  }

  /// Whether a draw in the current composite mode is followed by the
  /// alpha:false alpha reset. Only the raster backend does it: SkSVGDevice
  /// ignores kDstOver and would paint the black rect over the drawing.
  fn resets_alpha(&self) -> bool {
    !self.alpha
      && self.backend == Backend::Raster
      && matches!(
        self.state.global_composite_operation,
        BlendMode::Source
          | BlendMode::SourceIn
          | BlendMode::DestinationIn
          | BlendMode::SourceOut
          | BlendMode::DestinationOut
          | BlendMode::SourceATop
          | BlendMode::DestinationATop
          | BlendMode::Xor
          | BlendMode::Modulate
      )
  }

  /// Blink's ShouldUseCompositedDraw (canvas_2d_recorder_context.h:582-597,
  /// 711-727): any `ctx.filter` (StateHasFilter, h:589: one that builds no
  /// Skia filter counts too), a full-canvas mode, a shadow in a mode
  /// DropShadowPaintFilter cannot do (copy is handled apart and never is), or
  /// a shadow on a pattern fill or stroke. Only the alpha:false reset reads
  /// it: after such a draw Blink resets the whole clip (h:826-829). Our
  /// routing still differs for the shadow cases (see render_canvas).
  fn blink_composites(
    blend_mode: BlendMode,
    has_filter: bool,
    has_shadow: bool,
    pattern_style: bool,
  ) -> bool {
    has_filter
      || matches!(
        blend_mode,
        BlendMode::SourceIn
          | BlendMode::SourceOut
          | BlendMode::DestinationIn
          | BlendMode::DestinationATop
      )
      || (has_shadow
        && (pattern_style
          || !matches!(
            blend_mode,
            BlendMode::Source
              | BlendMode::SourceOver
              | BlendMode::SourceATop
              | BlendMode::DestinationOut
          )))
  }

  /// Blink InflateStrokeRect (canvas_2d_recorder_context.cc:2656-2670): a
  /// quick over-estimate of a stroke's extent around its geometry.
  fn inflate_stroke_bounds(&self, bounds: DrawBounds) -> DrawBounds {
    let paint = &self.state.paint;
    let mut delta = paint.get_stroke_width() as f64 / 2.0;
    if matches!(paint.get_stroke_join(), StrokeJoin::Miter) {
      delta *= paint.get_stroke_miter() as f64;
    } else if matches!(paint.get_stroke_cap(), StrokeCap::Square) {
      delta *= std::f64::consts::SQRT_2;
    }
    bounds.outset(delta as f32)
  }

  /// A point of a path method. Under a singular CTM Blink maps it through
  /// the CTM (canvas_path.cc:107-251): the path stays in the space of the
  /// last invertible CTM, so the point lands where the singular CTM puts it.
  fn path_point(&self, x: f32, y: f32) -> (f32, f32) {
    if self.transform_is_invertible() {
      (x, y)
    } else {
      self.state.transform.map_points(x, y)
    }
  }

  pub fn move_to(&mut self, x: f32, y: f32) {
    let (x, y) = self.path_point(x, y);
    self.path.move_to(x, y);
  }

  pub fn line_to(&mut self, x: f32, y: f32) {
    let (x, y) = self.path_point(x, y);
    self.path.line_to(x, y);
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
    // Blink arc() adds nothing under a singular CTM (canvas_path.cc:451).
    if !self.transform_is_invertible() {
      return;
    }
    self
      .path
      .arc(center_x, center_y, radius, start_angle, end_angle, from_end);
  }

  pub fn arc_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, radius: f32) {
    let (x1, y1) = self.path_point(x1, y1);
    let (x2, y2) = self.path_point(x2, y2);
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
    // Blink ellipse() adds nothing under a singular CTM (canvas_path.cc:517).
    if !self.transform_is_invertible() {
      return;
    }
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
    // An empty path starts at the first control point as given, not mapped
    // (canvas_path.cc:194-196).
    self.path.scoot(cp1x, cp1y);
    let (cp1x, cp1y) = self.path_point(cp1x, cp1y);
    let (cp2x, cp2y) = self.path_point(cp2x, cp2y);
    let (x, y) = self.path_point(x, y);
    self.path.cubic_to(cp1x, cp1y, cp2x, cp2y, x, y);
  }

  pub fn quadratic_curve_to(&mut self, cpx: f32, cpy: f32, x: f32, y: f32) {
    // An empty path starts at the control point as given, not mapped
    // (canvas_path.cc:166-168).
    self.path.scoot(cpx, cpy);
    let (cpx, cpy) = self.path_point(cpx, cpy);
    let (x, y) = self.path_point(x, y);
    self.path.quad_to(cpx, cpy, x, y);
  }

  pub fn clip(&mut self, path: Option<&mut SkPath>, fill_rule: FillType) {
    self.flush_if_recording_limit_exceeded();
    // Blink ClipInternal returns under a singular CTM
    // (canvas_2d_recorder_context.cc:1817).
    if !self.transform_is_invertible() {
      return;
    }
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

    self.state.has_clip = true;
    // A recording restart replays the clip (Blink's ClipList).
    if let Some(ref recorder) = self.page_recorder {
      recorder
        .borrow_mut()
        .add_clip(&self.state.transform, clip_path);
    }
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
      && !self.state.has_clip
      && self.states.is_empty()
    {
      // Full canvas clear - reset layers instead of accumulating
      if let Some(ref recorder) = self.page_recorder {
        recorder
          .borrow_mut()
          .reset(self.width as f32, self.height as f32);
      }
      // Also clear the main surface
      self.clear_surface_to_base();
      return Ok(());
    }

    // Partial clear - record as a clear operation
    self.flush_if_recording_limit_exceeded();
    let mut paint = Paint::new();
    paint.set_style(PaintStyle::Fill);
    paint.set_stroke_miter(10.0);
    if self.alpha {
      paint.set_color(0, 0, 0, 0);
      paint.set_blend_mode(BlendMode::Clear);
    } else {
      // Blink GetClearFlags (canvas_2d_recorder_context.cc:1917-1926):
      // alpha:false clears by filling opaque black, source-over.
      paint.set_color(0, 0, 0, 255);
    }
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
    // Blink rect() and roundRect() add nothing under a singular CTM
    // (canvas_path.cc:547, 576).
    if !self.transform_is_invertible() {
      return;
    }
    self.path.add_rect(x, y, width, height);
  }

  pub fn round_rect(&mut self, x: f32, y: f32, width: f32, height: f32, radii: &[(f32, f32)]) {
    if !self.transform_is_invertible() {
      return;
    }
    self.path.round_rect(x, y, width, height, radii);
  }

  pub fn save(&mut self) {
    self.flush_if_recording_limit_exceeded();
    self.with_canvas_state(|canvas| {
      canvas.save();
    });
    self.states.push(self.state.clone());
    if let Some(ref recorder) = self.page_recorder {
      recorder.borrow_mut().push_save();
    }
    self.flush_if_recording_limit_exceeded();
  }

  pub fn restore(&mut self) {
    if let Some(s) = self.states.pop() {
      self.flush_if_recording_limit_exceeded();
      // Blink PopStateStack (canvas_2d_recorder_context.cc:729-742): the path
      // goes to device space through an invertible CTM only, then into the
      // restored space if that CTM is invertible.
      if self.transform_is_invertible() {
        self.path.transform_self(&self.state.transform);
      }
      self.with_canvas_state(|canvas| {
        canvas.restore();
      });
      if matrix_is_invertible(&s.transform) {
        self.path.transform_self(&blink_inverse(&s.transform));
      }
      self.state = s;
      // canvas.restore() lands on the saved clip and matrix, as Blink's
      // restore() (canvas_2d_recorder_context.cc:419): the recording's save
      // stack mirrors the context's, also after a recording restart
      // (PageRecorder::resume_recording replays every level).
      if let Some(ref recorder) = self.page_recorder {
        recorder.borrow_mut().pop_restore();
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
      self.clear_surface_to_base();
    } else if !self.alpha {
      // Direct backends (SVG): draw the alpha:false base again. canvas.reset()
      // is restoreToCount(1), which keeps a matrix or clip set at the root
      // save level (an SkCanvas cannot drop a clip it has no save to restore),
      // and SkSVGDevice writes the base as a canvas-sized rect under both. So
      // after a root translate or clip the base misses part of the canvas, and
      // earlier content there stays in the SVG.
      self.surface.canvas.fill(0, 0, 0, 255);
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
    if self.draws_nothing() {
      return Ok(());
    }
    self.account_paint_resources(&self.state.stroke_style);

    // Extract state for shadow rendering to avoid borrow conflicts
    let shadow_paint =
      self.shadow_paint(&stroke_paint, ShadowSource::Stroke, DrawContent::Geometry);
    // Zero on the image-filter route, where the filter's dx/dy already carry it.
    let (shadow_offset_x, shadow_offset_y) =
      self.canvas_shadow_offset(ShadowSource::Stroke, DrawContent::Geometry);

    let bounds = self.inflate_stroke_bounds(DrawBounds::rect(x, y, w, h));
    self.with_shadowed_render_canvas(
      &stroke_paint,
      DrawContent::Geometry,
      shadow_paint.as_ref(),
      Some(bounds),
      matches!(self.state.stroke_style, Pattern::Image(_)),
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
    // Blink translate() is a no-op under a singular CTM
    // (canvas_2d_recorder_context.cc:1418).
    if !self.transform_is_invertible() {
      return;
    }
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
    self.state.transform = ts.multiply(&self.state.transform);
    // The path follows only into an invertible CTM; under a singular one it
    // stays in the last invertible space (canvas_2d_recorder_context.cc:1478).
    if self.transform_is_invertible() {
      self.path.transform_self(&blink_inverse(&ts));
    }
    let transform = self.state.transform.clone();
    self.with_canvas_state(|canvas| {
      canvas.set_transform(&transform);
    });
    self.sync_transform_to_recorder();
    self.flush_if_recording_limit_exceeded();
    Ok(())
  }

  /// `angle` in radians, finite.
  pub fn rotate(&mut self, angle: f64) {
    self.flush_if_recording_limit_exceeded();
    // Blink paints with ClampTo<float>(angle * (180.0 / kPiFloat)) degrees
    // (canvas_2d_recorder_context.cc:1384-1408); in f32 it overflows.
    let degrees = Self::clamp_to_f32(angle * (180.0 / PI as f64));
    self.state.transform.pre_rotate(degrees);
    // As in transform(): the path follows only into an invertible CTM.
    if self.transform_is_invertible() {
      let inverse = Matrix::rotated(-Self::clamp_to_f32(angle), 0.0, 0.0);
      self.path.transform_self(&inverse);
    }
    let transform = self.state.transform.clone();
    self.with_canvas_state(|canvas| {
      canvas.set_transform(&transform);
    });
    self.sync_transform_to_recorder();
    self.flush_if_recording_limit_exceeded();
  }

  pub fn scale(&mut self, x: f32, y: f32) {
    self.flush_if_recording_limit_exceeded();
    self.state.transform.pre_scale(x, y);
    // As in transform(): the path follows only into an invertible CTM. Blink
    // computes 1 / x in double (canvas_2d_recorder_context.cc:1380).
    if self.transform_is_invertible() {
      let mut inverse = Matrix::identity();
      inverse.pre_scale((1.0 / x as f64) as f32, (1.0 / y as f64) as f32);
      self.path.transform_self(&inverse);
    }
    let transform = self.state.transform.clone();
    self.with_canvas_state(|canvas| {
      canvas.set_transform(&transform);
    });
    self.sync_transform_to_recorder();
    self.flush_if_recording_limit_exceeded();
  }

  pub fn set_transform(&mut self, ts: Matrix) {
    self.flush_if_recording_limit_exceeded();
    // Blink setTransform = resetTransform() + transform()
    // (canvas_2d_recorder_context.cc:1491-1541): the path keeps its device
    // position. It leaves an invertible CTM to device space, then enters the
    // new CTM's space if that one is invertible. An empty path has nothing to
    // map, and an identity map changes nothing.
    if !self.path.is_empty() {
      if self.transform_is_invertible() && !self.state.transform.get_transform().is_identity() {
        self.path.transform_self(&self.state.transform);
      }
      if matrix_is_invertible(&ts) && !ts.get_transform().is_identity() {
        self.path.transform_self(&blink_inverse(&ts));
      }
    }
    self.state.transform = ts.clone();
    self.with_canvas_state(|canvas| {
      canvas.set_transform(&ts);
    });
    self.sync_transform_to_recorder();
    self.flush_if_recording_limit_exceeded();
  }

  pub fn reset_transform(&mut self) {
    self.flush_if_recording_limit_exceeded();
    // The path keeps its device position (canvas_2d_recorder_context.cc:1515).
    // An empty path has nothing to map, and an identity map changes nothing.
    if !self.path.is_empty()
      && self.transform_is_invertible()
      && !self.state.transform.get_transform().is_identity()
    {
      self.path.transform_self(&self.state.transform);
    }
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
    if self.draws_nothing() {
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
      Some(DrawBounds::rect(x, y, w, h)),
      matches!(self.state.fill_style, Pattern::Image(_)),
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
    if self.draws_nothing() {
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
    let bounds = DrawBounds::path(&path_to_draw).map(|b| self.inflate_stroke_bounds(b));
    self.with_shadowed_render_canvas(
      &stroke_paint,
      DrawContent::Geometry,
      shadow_paint.as_ref(),
      bounds,
      matches!(self.state.stroke_style, Pattern::Image(_)),
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
  // `content_blend` is the blend the draw itself gets inside the layer.
  fn composited_pass<F>(
    surface_canvas: &mut Canvas,
    paint: &Paint,
    blend_mode: BlendMode,
    content_blend: BlendMode,
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
    inner_paint.set_blend_mode(content_blend);
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

  /// The blend a `composited_pass` draws its content with. Blink's
  /// `CompositedDraw` draws it src-over inside the layer
  /// (canvas_2d_recorder_context.h:942-959). `copy` skips `CompositedDraw` and
  /// draws with kSrc straight onto the cleared canvas (h:830-837), unless a
  /// `ctx.filter` (`composited_filter_layer` already draws src-over in its
  /// layer) or a shadow under a pattern fill or stroke (`pattern_shadow`,
  /// `ShouldUseDropShadowPaintFilter`, h:582-597) sends it through
  /// `CompositedDraw` after all. Over this transparent layer src-over and kSrc
  /// give the same pixels in exact maths, but Skia blits src-over with its
  /// legacy 8-bit blitters and kSrc with the raster pipeline, which round
  /// differently.
  fn layer_content_blend(blend_mode: BlendMode, pattern_shadow: bool) -> BlendMode {
    if matches!(blend_mode, BlendMode::Source) && !pattern_shadow {
      BlendMode::Source
    } else {
      BlendMode::SourceOver
    }
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
  // is why the shadow band of a source-in draw legitimately disappears.
  // Do not merge them into one layer, and do not nest the shadow pass inside the
  // content one -- it would composite against the empty layer, not the backdrop.
  //
  // KNOWN DEFECT: the mode list below omits the shadow-conditional cases
  // Chromium routes through CompositedDraw (h:692-697, :719-727). The
  // alpha:false reset already follows Blink for them: `bounds` arrives as
  // None for every draw `blink_composites` names.
  fn render_canvas<S, F>(
    surface_canvas: &mut Canvas,
    paint: &Paint,
    content_filter: Option<&ImageFilter>,
    blend_mode: BlendMode,
    backend: Backend,
    alpha: bool,
    bounds: Option<DrawBounds>,
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
    // alpha:false raster only; see `resets_alpha`.
    let reset_alpha = !alpha && backend == Backend::Raster;
    // A shadow under a pattern fill or stroke (ShouldUseDropShadowPaintFilter)
    // sends every mode, copy included, through CompositedDraw (h:582-597).
    let pattern_shadow = shadow
      .as_ref()
      .is_some_and(|shadow| shadow.pattern_geometry);
    // copy without a layer filter or a pattern shadow is Blink's DrawInternal
    // kSrc arm (canvas_2d_recorder_context.h:830-837): clear the clip, then
    // draw the foreground only (no shadow) straight onto the canvas with the
    // kSrc paint. No layer, so a dithered gradient keeps its device phase, and
    // an anti-aliased clip edge is applied by both the clear and the draw, as
    // in Chrome. PDF and SVG keep the layer below: SkPDFDevice masks a kSrc
    // draw by the source's alpha, and SkSVGDevice writes clear() as a
    // transparent rect, so on neither does a clear() remove what was drawn
    // before.
    if blend_mode == BlendMode::Source
      && content_filter.is_none()
      && !pattern_shadow
      && backend == Backend::Raster
    {
      // alpha:false clears to opaque black (h:832).
      if alpha {
        surface_canvas.clear();
      } else {
        surface_canvas.fill(0, 0, 0, 255);
      }
      f(surface_canvas, paint)?;
      if reset_alpha {
        Self::reset_alpha_if_needed(surface_canvas, blend_mode, bounds, width, height);
      }
      return Ok(());
    }
    match blend_mode {
      // The first four are Chromium's `IsFullCanvasCompositeMode`
      // (canvas_2d_recorder_context.h:998-1005). copy only gets here with a
      // `ctx.filter` on the layer or a pattern shadow (Blink's CompositedDraw),
      // or on PDF and SVG; its kSrc restore replaces the whole clip like the
      // clear above (SkSVGDevice cannot make the layer and drops the draw).
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
            // The content pass below replaces every pixel for copy, so this
            // one's blend never shows there.
            Self::layer_content_blend(blend_mode, false),
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
          Self::layer_content_blend(blend_mode, pattern_shadow),
          0.0,
          0.0,
          width,
          height,
          nested_picture_bytes,
          |canvas, paint| {
            Self::composited_filter_layer(canvas, &device_ctm, content_filter, paint, &f)
          },
        )?;
        // CompositedDraw resets the whole clip (h:829).
        if reset_alpha {
          Self::reset_alpha_if_needed(surface_canvas, blend_mode, None, width, height);
        }
        Ok(())
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
        )?;
        if reset_alpha {
          Self::reset_alpha_if_needed(surface_canvas, blend_mode, bounds, width, height);
        }
        Ok(())
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
    if self.draws_nothing() {
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
      DrawBounds::path(&path_to_draw),
      matches!(self.state.fill_style, Pattern::Image(_)),
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

  /// `globalAlpha` rounded to k/255, for drawImage only. Blink rounds the
  /// drawImage alpha on purpose (canvas_rendering_context_2d_state.cc:334-336,
  /// "TODO: Don't quantize the alpha to 8-bit"). Patterns keep the float
  /// alpha, as Blink does: where Skia's legacy blitter draws them, it rounds
  /// the paint alpha to a byte itself (SkBlitter.cpp `getAlpha()`).
  /// f32 maths and `k / 255.0` as Blink does: `set_alpha(k)` multiplies by
  /// 1/255, which is 1 ulp off for some k.
  /// A PDF page has no raster sampling to match, so it keeps the spec's float,
  /// as its solid and gradient fills do (`/ca .5`, not `.502`).
  fn image_global_alpha(&self) -> f32 {
    let alpha = self.state.global_alpha as f32;
    if self.backend == Backend::Pdf {
      return alpha;
    }
    (alpha * 255.0).round() / 255.0
  }

  /// The paint drawImage and drawCanvas draw with: Blink's `image_flags_`
  /// (canvas_rendering_context_2d_state.cc:170-171 fill style and AA, :335
  /// alpha, :832 picked for image draws). It never reads fillStyle or the line
  /// dash, so an unusable fillStyle (a gradient Skia cannot build) cannot stop
  /// an image draw. Opaque black like a default cc::PaintFlags; the blend mode
  /// comes from the state paint, and smoothing, `ctx.filter` and the shadow
  /// are added by the callers.
  fn image_paint(&self, alpha: f32) -> Paint {
    let mut paint = self.state.paint.clone();
    paint.set_style(PaintStyle::Fill);
    paint.set_color(0, 0, 0, 255);
    paint.set_alpha_f32(alpha);
    paint
  }

  /// The shader half of a gradient fillStyle/strokeStyle paint. Blink always
  /// dithers gradients (gradient.cc ApplyToFlags).
  fn set_gradient_paint(
    &self,
    paint: &mut Paint,
    gradient: &Gradient,
    alpha: f32,
  ) -> result::Result<(), SkError> {
    // SVG only: SkSVGDevice has no conic gradient and drops the alpha of a
    // color shader, so a gradient that paints one color everywhere goes out as
    // a plain paint color.
    if self.backend == Backend::Svg
      && let Some(c) = gradient.constant_color()
    {
      paint.set_color(
        srgb_channel_to_u8(c.r),
        srgb_channel_to_u8(c.g),
        srgb_channel_to_u8(c.b),
        255,
      );
      paint.set_alpha_f32(c.a * alpha);
      return Ok(());
    }
    let shader = gradient.get_shader()?;
    paint.set_color(0, 0, 0, 255);
    paint.set_alpha_f32(alpha);
    paint.set_shader(&shader);
    paint.set_dither(true);
    Ok(())
  }

  /// An image pattern's shader for the current smoothing state, and the
  /// decode copy it samples. On a raster canvas an Image source is drawn from
  /// Chrome's decode cache, whose level depends on the CTM
  /// (PaintShader::CreateDecodedImage), in the canvas's colour space; PDF and
  /// SVG keep the original image.
  fn image_pattern_shader(&self, pattern: &ImagePattern) -> Option<(Shader, DecodedCopy)> {
    let quality = if self.state.image_smoothing_enabled {
      self.state.image_smoothing_quality
    } else {
      FilterQuality::None
    };
    let decode = (self.backend == Backend::Raster)
      .then(|| (self.state.transform.get_transform(), self.color_space));
    pattern.get_shader(quality, decode)
  }

  pub fn fill_paint(&self) -> result::Result<Paint, SkError> {
    let last_state = &self.state;
    let current_paint = &last_state.paint;
    let mut paint = current_paint.clone();
    paint.set_style(PaintStyle::Fill);
    let alpha = current_paint.get_alpha_f32();
    match &last_state.fill_style {
      Pattern::Color(c, _) => {
        paint.set_color(c.r, c.g, c.b, c.a);
        paint.set_alpha_f32(c.a as f32 / 255.0 * alpha);
      }
      Pattern::Gradient(g) => self.set_gradient_paint(&mut paint, g, alpha)?,
      Pattern::Image(p) => {
        if let Some((shader, _)) = self.image_pattern_shader(p) {
          paint.set_color(0, 0, 0, 255);
          paint.set_alpha_f32(alpha);
          paint.set_shader(&shader);
        }
      }
    };
    if let Some(path_effect) = self.line_dash_path_effect() {
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
      self.state.has_filter = false;
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
    self.state.has_filter = true;
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
    self.state.global_alpha
  }

  pub fn set_shadow_color(&mut self, shadow_color: String) -> result::Result<(), SkError> {
    let mut parser = Parser::new(&shadow_color);
    let color = CSSColor::parse(&mut parser)
      .map_err(|e| SkError::Generic(format!("Parse color [{}] error: {:?}", shadow_color, e)))?;

    match color {
      // Without an element, currentcolor is opaque black (Chrome's
      // OffscreenCanvas answer).
      CSSColor::CurrentColor => {
        drop(parser);
        self.state.shadow_color_string = shadow_color;
        self.state.shadow_color = RGBA {
          r: 0,
          g: 0,
          b: 0,
          a: 255,
        };
      }
      CSSColor::Rgba(rgba) => {
        drop(parser);
        self.state.shadow_color_string = shadow_color;
        // Convert RgbaLegacy to RGBA<u8>
        self.state.shadow_color = RGBA {
          r: rgba.red,
          g: rgba.green,
          b: rgba.blue,
          a: (rgba.alpha * 255.0).round() as u8,
        };
      }
      CSSColor::Hsl(hsl) => {
        drop(parser);
        self.state.shadow_color_string = shadow_color;
        self.state.shadow_color = hsl_to_rgba8(&hsl);
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
    // CanvasFontStretch is an enum of the nine keywords: a percentage, which
    // the font shorthand takes, is not one of its values.
    if stretch.ends_with('%') {
      return Ok(());
    }
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
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    color_type: ColorSpace,
  ) -> result::Result<Vec<u8>, ReadPixelsError> {
    // Flush the deferred recording before reading pixels, as Blink's
    // getImageData runs FinalizeFrame -> FlushCanvas ->
    // ReleaseMainRecording (base_rendering_context_2d.cc). Without it the
    // recording grows unbounded across getImageData calls
    // (https://github.com/Brooooooklyn/canvas/issues/1342). flush() also
    // consolidates the layers into a single snapshot picture, so a read
    // leaves the recorder holding only an O(canvas_size) snapshot. An
    // SVGCanvas draws its recording into its raster surface here.
    self.flush();

    // A rect that misses the canvas reads as transparent black, in any color
    // space (getImageDataInternal: the pixels outside are zero).
    let (left, top) = (i64::from(x), i64::from(y));
    if left >= i64::from(self.surface.width())
      || top >= i64::from(self.surface.height())
      || left + i64::from(w) <= 0
      || top + i64::from(h) <= 0
    {
      return (w as usize)
        .checked_mul(h as usize)
        .and_then(|n| n.checked_mul(4))
        .and_then(crate::sk::try_zeroed_bytes)
        .ok_or(ReadPixelsError::OutOfMemory);
    }
    self.surface.read_pixels(x, y, w, h, color_type)
  }

  pub fn set_line_dash(&mut self, line_dash_list: Vec<f32>) {
    self.state.line_dash_list = line_dash_list;
  }

  /// The dash of the current line dash list. A list with no non-zero entry
  /// strokes solid (canvas_rendering_context_2d_state.cc UpdateLineDash), and
  /// so does one Skia cannot dash (the intervals sum to 0 or overflow), as a
  /// null dash effect does in Chrome.
  fn line_dash_path_effect(&self) -> Option<PathEffect> {
    let state = &self.state;
    if !state.line_dash_list.iter().any(|dash| *dash != 0.0) {
      return None;
    }
    PathEffect::new_dash_path(state.line_dash_list.as_slice(), state.line_dash_offset)
  }

  fn stroke_paint(&self) -> result::Result<Paint, SkError> {
    let last_state = &self.state;
    let current_paint = &last_state.paint;
    let mut paint = current_paint.clone();
    paint.set_style(PaintStyle::Stroke);
    let global_alpha = current_paint.get_alpha_f32();
    match &last_state.stroke_style {
      Pattern::Color(c, _) => {
        paint.set_color(c.r, c.g, c.b, c.a);
        paint.set_alpha_f32(c.a as f32 / 255.0 * global_alpha);
      }
      Pattern::Gradient(g) => self.set_gradient_paint(&mut paint, g, global_alpha)?,
      Pattern::Image(p) => {
        if let Some((shader, _)) = self.image_pattern_shader(p) {
          paint.set_color(0, 0, 0, 255);
          paint.set_alpha_f32(global_alpha);
          paint.set_shader(&shader);
        }
      }
    };
    if let Some(path_effect) = self.line_dash_path_effect() {
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
  /// On an 8888 surface Skia's raster engine routes the blur to the three-box
  /// pass (SkBlurEngine.cpp:1281, :275) -- at every sigma, as Skia is built
  /// with Chrome's SK_AVOID_SLOW_RASTER_PIPELINE_BLURS -- and derives its window
  /// as an integer (:388), so the effective sigma snaps to a staircase -- +9%
  /// to -13% off `shadowBlur / 2`, sign depending on where the request lands in
  /// a step. Chrome's CPU canvas is built with the same define and draws the
  /// same staircase: an image shadow at shadowBlur 0.5 to 24 equals Chrome
  /// 155's byte for byte. The sigma passed here is already correct.
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
    // Text passes kNoImage whatever its style (base_rendering_context_2d.cc),
    // and drawImage is not a fill or stroke paint.
    let pattern_geometry = content == DrawContent::Geometry
      && match source {
        ShadowSource::Fill => matches!(state.fill_style, Pattern::Image(..)),
        ShadowSource::Stroke => matches!(state.stroke_style, Pattern::Image(..)),
        ShadowSource::Image => false,
      };
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
        // same, and SkSVGDevice emits a plain `fill=` with no filter. Like
        // Blink's looper shadow (`SkColorFilters::Blend(shadowColor4f, kSrcIn)`
        // folded by RemoveColorFilter, draw_looper_builder.cc), the alpha is one
        // float product, `shadowColor.a * fillStyle.a * globalAlpha`, rounded
        // once by the blitter. Only a colour-only `ctx.filter` reads the
        // filtered colour as a byte. The image-filter route below rounds
        // through its 8-bit layer.
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
        let paint_alpha = match colour_only_filter {
          Some(filter) => (filter.filter_color(drop_shadow_paint.get_color()) >> 24) as f32 / 255.0,
          None => drop_shadow_paint.get_alpha_f32(),
        };
        drop_shadow_paint.set_color(shadow_color.r, shadow_color.g, shadow_color.b, 255);
        drop_shadow_paint.set_alpha_f32(shadow_alpha as f32 / 255.0 * paint_alpha);
        return Some(ShadowDraw {
          paint: drop_shadow_paint,
          filter: None,
          pattern_geometry,
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
        pattern_geometry,
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
      pattern_geometry,
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

  /// Whether `skiac_canvas_draw_image` returns before drawing because the
  /// source rect misses the image: Blink's ClipRectsToImageRect, then
  /// DrawHelper's second Intersect, in gfx::RectF maths
  /// (canvas_2d_recorder_context.cc:1989-2010, static_bitmap_image.cc:89-93).
  /// The same f32 steps as the C++ `GfxRectF`, one operation per statement
  /// there and no fused maths here, so both sides get the same bits.
  fn image_rects_clip_empty(
    image_width: f32,
    image_height: f32,
    sx: f32,
    sy: f32,
    s_width: f32,
    s_height: f32,
    dx: f32,
    dy: f32,
    d_width: f32,
    d_height: f32,
  ) -> bool {
    #[derive(Clone, Copy)]
    struct RectF {
      x: f32,
      y: f32,
      w: f32,
      h: f32,
    }
    // std::max and std::min, signed zeros included.
    let max = |a: f32, b: f32| if a < b { b } else { a };
    let min = |a: f32, b: f32| if b < a { b } else { a };
    let clamp_size = |s: f32| if s > 8.0 * f32::EPSILON { s } else { 0.0 };
    let rect = |x: f32, y: f32, w: f32, h: f32| RectF {
      x,
      y,
      w: clamp_size(w),
      h: clamp_size(h),
    };
    let is_empty = |r: RectF| r.w == 0.0 || r.h == 0.0;
    let intersect = |a: RectF, b: RectF| {
      if is_empty(a) || is_empty(b) {
        return rect(0.0, 0.0, 0.0, 0.0);
      }
      let rx = max(a.x, b.x);
      let ry = max(a.y, b.y);
      let rr = min(a.x + a.w, b.x + b.w);
      let rb = min(a.y + a.h, b.y + b.h);
      if rx >= rr || ry >= rb {
        return rect(0.0, 0.0, 0.0, 0.0);
      }
      rect(rx, ry, rr - rx, rb - ry)
    };
    let image = rect(0.0, 0.0, image_width, image_height);
    let mut src = rect(sx, sy, s_width, s_height);
    let mut dst = rect(dx, dy, d_width, d_height);
    if !(src.x >= image.x
      && src.x + src.w <= image.x + image.w
      && src.y >= image.y
      && src.y + src.h <= image.y + image.h)
    {
      let scale_x = dst.w / src.w;
      let scale_y = dst.h / src.h;
      let scaled_src_x = src.x * scale_x;
      let scaled_src_y = src.y * scale_y;
      let offset_x = dst.x - scaled_src_x;
      let offset_y = dst.y - scaled_src_y;
      src = intersect(src, image);
      let scaled_x = src.x * scale_x;
      let scaled_y = src.y * scale_y;
      dst = rect(
        scaled_x + offset_x,
        scaled_y + offset_y,
        src.w * scale_x,
        src.h * scale_y,
      );
    }
    src = intersect(src, image);
    is_empty(src) || is_empty(dst)
  }

  /// Blink AdjustRectForCanvas (canvas_2d_recorder_context.h): a negative
  /// width or height moves the origin; the image is not mirrored.
  pub(crate) fn normalize_rect_for_canvas(
    mut x: f64,
    mut y: f64,
    mut width: f64,
    mut height: f64,
  ) -> (f64, f64, f64, f64) {
    if width < 0.0 {
      width = -width;
      x -= width;
    }
    if height < 0.0 {
      height = -height;
      y -= height;
    }
    (x, y, width, height)
  }

  /// Blink's drawImage rect handling: AdjustRectForCanvas in double, then
  /// ClampTo<float> (canvas_2d_recorder_context.cc:2244-2253).
  pub(crate) fn adjust_rect_for_canvas(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
  ) -> (f32, f32, f32, f32) {
    let (x, y, width, height) = Self::normalize_rect_for_canvas(x, y, width, height);
    let clamp = Self::clamp_to_f32;
    (clamp(x), clamp(y), clamp(width), clamp(height))
  }

  /// Blink ClampTo<float>. Non-finite values stay non-finite (Blink returns
  /// before this), so `rect_fillable` still rejects them.
  pub(crate) fn clamp_to_f32(v: f64) -> f32 {
    if v.is_finite() {
      v.clamp(-f32::MAX as f64, f32::MAX as f64) as f32
    } else {
      v as f32
    }
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

  /// Blink's `IsTransformInvertible`: AffineTransform::IsInvertible checks
  /// for a finite, non-zero determinant. Skia's own invert() also rejects a
  /// nearly-zero one, which Chrome still draws with.
  fn transform_is_invertible(&self) -> bool {
    matrix_is_invertible(&self.state.transform)
  }

  /// Blink's Draw returns before anything is drawn when the CTM is singular
  /// (canvas_2d_recorder_context.h:866-868), and so does render_passes. The
  /// draw entry points ask here before their first charge, so a draw that
  /// records nothing charges nothing; anything fallible before it still runs.
  fn draws_nothing(&self) -> bool {
    !self.transform_is_invertible()
  }

  /// Whether a draw whose own geometry provably paints nothing may be
  /// skipped whole. drawRect/drawPath DO reach the record canvas
  /// (SkRecordCanvas::onDraw* appends unconditionally -- the fillable()
  /// checks live in SkCanvas::onDraw*), so skipping is only about not
  /// charging paint resources for zero-coverage geometry. What stays
  /// un-skippable are the wrapper ops our draw path can still emit around
  /// the empty draw, because their restore writes the device even with no
  /// content inside:
  ///   * copy clears the clip before it draws, and composited_pass modes
  ///     replay an inner picture through a saveLayer/drawPicture(paint) whose
  ///     restore rewrites the whole clip even for an empty picture;
  ///   * a `ctx.filter` wraps the draw in a filtered saveLayer -- its
  ///     restore also composites (kClear can clear the canvas); and on
  ///     alpha:false any assigned filter, even one that built no Skia filter,
  ///     is followed by the whole-clip reset (`blink_composites`);
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
    ) && !self.state.has_filter
      && self.state.line_dash_list.is_empty()
      && !has_shadow
  }

  /// Blink clips the sorted source rect to the image and returns when nothing
  /// is left (canvas_2d_recorder_context.cc:2310-2316), whatever the composite
  /// op; copy and the full-canvas modes would otherwise clear the clip. Shared
  /// by drawImage and drawCanvas, which must agree.
  pub(crate) fn source_rect_overlaps(
    sx: f32,
    sy: f32,
    s_width: f32,
    s_height: f32,
    width: f32,
    height: f32,
  ) -> bool {
    let overlaps = |start: f32, len: f32, size: f32| {
      let (lo, hi) = (start.min(start + len), start.max(start + len));
      lo.max(0.0) < hi.min(size)
    };
    overlaps(sx, s_width, width) && overlaps(sy, s_height, height)
  }

  /// `raster_key` dedups the retained-raster charge for this op: the caller
  /// pairs the source's resource id with a content generation (a canvas
  /// source's `content_version()`, or a fresh nonce for sources with no
  /// recorder). A canvas-backed bitmap's pointer is the stable `SkSurface*`
  /// (skiac_surface_get_bitmap), but each recorded drawImage pins a fresh
  /// makeImageSnapshot -- mutating the source afterwards copy-on-writes a
  /// new raster that the id alone cannot distinguish, hence the generation.
  /// `image` is the Image `bitmap` belongs to, `None` for a canvas source or
  /// an SVG Image. On a raster canvas Chrome draws an Image from its decode
  /// cache.
  pub(crate) fn draw_image(
    &mut self,
    bitmap: &Bitmap,
    image: Option<&AccountedBitmap>,
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
    // NOTHING that retains the source raster, before paint construction and
    // accounting. Both source kinds reach SkCanvas::drawImageRect, which drops
    // the draw unless `fillable` holds for BOTH rects (SkCanvas.cpp) --
    // finite, strictly-positive spans (MakeXYWH can collapse to an empty
    // width under f32 rounding). Callers pass the rects through
    // `adjust_rect_for_canvas` first, so a negative width or height has
    // already moved the origin instead. The native draw also returns before
    // drawImageRect when the source rect misses the image.
    if !(Self::rect_fillable(sx, s_width)
      && Self::rect_fillable(sy, s_height)
      && Self::rect_fillable(dx, d_width)
      && Self::rect_fillable(dy, d_height))
      || Self::image_rects_clip_empty(
        bitmap.0.width as f32,
        bitmap.0.height as f32,
        sx,
        sy,
        s_width,
        s_height,
        dx,
        dy,
        d_width,
        d_height,
      )
    {
      return Ok(());
    }
    if !Self::source_rect_overlaps(
      sx,
      sy,
      s_width,
      s_height,
      bitmap.0.width as f32,
      bitmap.0.height as f32,
    ) {
      return Ok(());
    }

    let paint = self.image_paint(self.image_global_alpha());
    if self.draws_nothing() {
      return Ok(());
    }
    self.account_image_paint_resources();

    // Extract state for shadow rendering to avoid borrow conflicts
    let shadow_paint = self.shadow_paint(&paint, ShadowSource::Image, DrawContent::Geometry);
    // Zero on the image-filter route, where the filter's dx/dy already carry it.
    let (shadow_offset_x, shadow_offset_y) =
      self.canvas_shadow_offset(ShadowSource::Image, DrawContent::Geometry);
    let image_smoothing_enabled = self.state.image_smoothing_enabled;
    let image_smoothing_quality = self.state.image_smoothing_quality;
    let raster = self.backend == Backend::Raster;
    // Known trade-off: the recording keeps the decode level it drew, so
    // drawCanvas of this canvas replays the level, into PDF and SVG too and at
    // any scale. Kept: Chrome has no drawCanvas, and its drawImage(canvas)
    // samples this canvas's pixels, which hold that level's result.
    let decode_cache = image.filter(|_| raster);
    // Chrome draws an Image from its decode cache, and on a canvas that is not
    // sRGB a canvas source too (SoftwareImageDecodeCache::UseCacheForDrawImage),
    // whose decode is made for the one draw.
    let decode = decode_cache.is_some()
      || (raster && bitmap.0.is_canvas && self.color_space != ColorSpace::Srgb);
    let color_space = self.color_space;
    let ctm = self.state.transform.get_transform();
    let vector_device = !raster;

    // The recorded op pins a reference to the source pixels; charge its full
    // raster size so large drawImage sources trip the recording limit. The
    // raster tally keeps it visible to drawCanvas accounting: a recorded
    // drawImage inside a source picture carries this payload along. Keyed on
    // raster_key -- re-drawing one UNCHANGED source retains one shared
    // backing, not N. A decode drawn in place of the source is a copy the op
    // pins instead, charged below under its own identity.
    self.account_raster_resource(
      raster_key,
      (bitmap.0.width as usize) * (bitmap.0.height as usize) * 4,
    );
    // Blink's bounds are the destination rect after ClipRectsToImageRect
    // (canvas_2d_recorder_context.cc:1983-2008) cut the source to the image.
    let bounds = {
      let src = DrawBounds::rect(sx, sy, s_width, s_height);
      let dst = DrawBounds::rect(dx, dy, d_width, d_height);
      let scale_x = (dst.right - dst.left) / (src.right - src.left);
      let scale_y = (dst.bottom - dst.top) / (src.bottom - src.top);
      DrawBounds {
        left: dst.left + (src.left.max(0.0) - src.left) * scale_x,
        top: dst.top + (src.top.max(0.0) - src.top) * scale_y,
        right: dst.left + (src.right.min(bitmap.0.width as f32) - src.left) * scale_x,
        bottom: dst.top + (src.bottom.min(bitmap.0.height as f32) - src.top) * scale_y,
      }
    };
    let decoded = RefCell::new(Vec::new());
    let result = self.with_shadowed_render_canvas(
      &paint,
      DrawContent::Geometry,
      shadow_paint.as_ref(),
      Some(bounds),
      false,
      |shadow_canvas: &mut Canvas, shadow_paint, device_ctm| {
        shadow_canvas.save();
        Self::apply_shadow_offset_matrix_to_canvas(
          shadow_canvas,
          device_ctm,
          shadow_offset_x,
          shadow_offset_y,
        )?;
        let drawn = shadow_canvas.draw_image(
          bitmap,
          decode,
          decode_cache,
          color_space,
          ctm,
          vector_device,
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
        decoded.borrow_mut().extend(drawn);
        shadow_canvas.restore();
        Ok(())
      },
      |canvas: &mut Canvas, paint| {
        let drawn = canvas.draw_image(
          bitmap,
          decode,
          decode_cache,
          color_space,
          ctm,
          vector_device,
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
        decoded.borrow_mut().extend(drawn);
        Ok(())
      },
    );
    // Once per window for a level the cache keeps, which the shadow pass and
    // later draws share; per draw for a decode made for one draw.
    for (uid, bytes) in decoded.into_inner() {
      self.account_raster_resource(RasterKey::Image { uid }, bytes);
    }
    // The draw may have cached a decode level of the Image.
    if let Some(image) = decode_cache {
      image.sync_level_bytes();
    }
    result?;
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
    //     or dh sorts to a normal span and still paints (drawCanvas has
    //     already normalised them, as drawImage does), and an
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

    let paint = self.image_paint(self.state.global_alpha as f32);
    if self.draws_nothing() {
      return Ok(());
    }
    self.account_image_paint_resources();

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
      // No Chrome counterpart; the destination rect, as for drawImage.
      Some(DrawBounds::rect(dx, dy, d_width, d_height)),
      false,
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
    // Measured before get_font(): measuring takes the same font lock.
    let bounds = if self.resets_alpha() {
      self.text_bounds(text, x, y, max_width, source)
    } else {
      None
    };
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

    if self.draws_nothing() {
      return Ok(());
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
      bounds,
      false,
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

  /// Blink's text bounds: the glyph bounds at the drawn position, inflated
  /// for a stroke (base_rendering_context_2d.cc:1016-1080). Only the
  /// alpha:false reset reads them. Left and right are the ink of the glyphs
  /// the draw paints, where it paints them (`ink_left` / `ink_right` from
  /// skia_c.cpp skiac_canvas_get_line_metrics_or_draw_text), so the
  /// letterSpacing shift applies only where the draw applies it: to LTR text
  /// that is not cursive. Top and bottom are measureText's.
  ///
  /// maxWidth squeezes the text with scale(maxWidth / width, 1) about the
  /// anchor x, so the box scales toward x. Blink resets its unscaled box under
  /// the scaled canvas (base_rendering_context_2d.cc:1066-1082), which misses
  /// part of the squeezed glyphs; that is not copied.
  ///
  /// When measuring fails (for example a fill gradient with no shader) the
  /// reset takes the whole clip: the draw itself reports its own errors.
  fn text_bounds(
    &mut self,
    text: &str,
    x: f32,
    y: f32,
    max_width: f32,
    source: ShadowSource,
  ) -> Option<DrawBounds> {
    let metrics = self.get_line_metrics(text, true).ok()?.0;
    // The same test and ratio as the draw.
    let scale = if metrics.width > max_width {
      max_width / metrics.width
    } else {
      1.0
    };
    let left = x + scale * metrics.ink_left;
    let right = x + scale * metrics.ink_right;
    let bounds = DrawBounds {
      left: left.min(right),
      top: y - metrics.ascent,
      right: left.max(right),
      bottom: y + metrics.descent,
    };
    Some(match source {
      ShadowSource::Stroke => self.inflate_stroke_bounds(bounds),
      _ => bounds,
    })
  }

  /// `collect_ink` fills `ink_left` / `ink_right`, which costs a walk over
  /// every drawn glyph; measureText does not read them and passes false.
  fn get_line_metrics(
    &mut self,
    text: &str,
    collect_ink: bool,
  ) -> result::Result<LineMetrics, SkError> {
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
      collect_ink,
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
pub struct CanvasToneMapping {
  pub mode: String,
}

/// getContextAttributes(): `CanvasRenderingContext2DSettings`, with the
/// fields in Chrome's key order.
#[napi(object)]
pub struct ContextAttributes {
  pub alpha: bool,
  pub color_space: String,
  pub color_type: String,
  pub desynchronized: bool,
  pub tone_mapping: CanvasToneMapping,
  pub will_read_frequently: bool,
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
  /// getContext() options that only getContextAttributes() reports.
  pub(crate) reported_settings: ReportedSettings,
}

impl ObjectFinalize for CanvasRenderingContext2D {
  fn finalize(self, env: Env) -> Result<()> {
    env.adjust_external_memory(-((self.context.width * self.context.height * 4) as i64))?;
    Ok(())
  }
}

/// A fillStyle or strokeStyle value, converted like Chrome's
/// ExtractV8CanvasStyle (v8_canvas_style.cc): a string, then a CanvasPattern,
/// then a CanvasGradient, else ToString. The class is chosen by its
/// instanceof check and only that class is unwrapped; an object that passes
/// the check but wraps nothing is converted with ToString, as Chrome does
/// with an object that is not a real CanvasGradient.
pub struct CanvasStyleArg<'a, S> {
  /// None: the string is not a color, and the assignment is ignored.
  pattern: Option<Pattern>,
  /// What the getter then returns: the gradient or pattern, or the string.
  value: Unknown<'a>,
  site: PhantomData<S>,
}

impl<S: webidl::Site> FromNapiValue for CanvasStyleArg<'static, S> {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    let style = |pattern, value| {
      Ok(Self {
        pattern,
        value: unsafe { Unknown::from_napi_value(env, value)? },
        site: PhantomData,
      })
    };
    if webidl::type_of(env, value)? != ValueType::String {
      if unsafe { <&CanvasPattern as ValidateNapiValue>::validate(env, value) }.is_ok()
        && let Ok(pattern) = unsafe { CanvasPattern::from_napi_ref(env, value) }
      {
        return style(Some(pattern.inner.clone()), value);
      }
      if unsafe { <&CanvasGradient as ValidateNapiValue>::validate(env, value) }.is_ok()
        && let Ok(gradient) = unsafe { CanvasGradient::from_napi_ref(env, value) }
      {
        return style(Some(Pattern::Gradient(gradient.0.clone())), value);
      }
    }
    let color = webidl::to_dom_string(env, value, S::PREFIX)?;
    let pattern = Pattern::from_color(&color).ok();
    style(pattern, unsafe { String::to_napi_value(env, color)? })
  }
}

/// Whether `value` is a Path2D for overload resolution: its instanceof check
/// and a native Path behind it (an object made with
/// `Object.create(Path2D.prototype)` has none). The borrow itself comes after
/// the other arguments ran their user code.
///
/// A value that is not an object, a function included, is never a Path2D,
/// and is not checked further: Chrome's wrapper type check runs no user code
/// (Path2D[Symbol.hasInstance]), and a failed instanceof check costs the
/// formatted message of a napi-rs error.
pub(crate) fn is_path2d(env: sys::napi_env, value: sys::napi_value) -> bool {
  matches!(webidl::type_of(env, value), Ok(ValueType::Object))
    && unsafe { <&Path as ValidateNapiValue>::validate(env, value) }.is_ok()
    && has_native_object(env, value)
}

/// Whether a native object is wrapped in `value`, of any class.
fn has_native_object(env: sys::napi_env, value: sys::napi_value) -> bool {
  let mut data = std::ptr::null_mut();
  unsafe { sys::napi_unwrap(env, value, &mut data) == sys::Status::napi_ok && !data.is_null() }
}

pub(crate) fn not_path2d(env: sys::napi_env, prefix: &str) -> Error {
  webidl::context_type_error(env, prefix, "parameter 1 is not of type 'Path2D'.")
}

/// Borrows a value that passed `is_path2d`.
fn borrow_path(
  env: sys::napi_env,
  value: Option<sys::napi_value>,
  prefix: &str,
) -> Result<Option<&'static mut Path>> {
  value
    .map(|value| {
      unsafe { Path::from_napi_mut_ref(env, value) }.map_err(|_| not_path2d(env, prefix))
    })
    .transpose()
}

/// The arguments of fill() or clip(), their last parameter: (optional
/// CanvasFillRule) or (Path2D, optional CanvasFillRule). WebIDL picks the
/// overload from the argument count and, for one argument, from whether it
/// is a Path2D (canvas_2d_recorder_context.idl).
pub struct FillArgs<S> {
  path: Option<&'static mut Path>,
  rule: FillType,
  site: PhantomData<S>,
}

impl<S: webidl::Site> FromNapiValue for FillArgs<S> {
  unsafe fn from_napi_value(env: sys::napi_env, argc: sys::napi_value) -> Result<Self> {
    let args = webidl::Arguments::take(env, 2, argc)?;
    let first = args.get(0)?;
    let (path, rule) = match args.len() {
      0 => (None, FillType::Winding),
      1 if is_path2d(env, first) => (Some(first), FillType::Winding),
      1 => (None, webidl::fill_rule(env, first, S::PREFIX)?),
      _ => {
        if !is_path2d(env, first) {
          return Err(not_path2d(env, S::PREFIX));
        }
        (
          Some(first),
          webidl::fill_rule(env, args.get(1)?, S::PREFIX)?,
        )
      }
    };
    Ok(Self {
      path: borrow_path(env, path, S::PREFIX)?,
      rule,
      site: PhantomData,
    })
  }
}

/// The argument of stroke(): none, or a Path2D.
pub struct StrokeArgs {
  path: Option<&'static mut Path>,
}

impl FromNapiValue for StrokeArgs {
  unsafe fn from_napi_value(env: sys::napi_env, argc: sys::napi_value) -> Result<Self> {
    let args = webidl::Arguments::take(env, 1, argc)?;
    let prefix = <webidl::CtxStroke as webidl::Site>::PREFIX;
    let path = if args.len() == 0 {
      None
    } else {
      let path = args.get(0)?;
      if !is_path2d(env, path) {
        return Err(not_path2d(env, prefix));
      }
      Some(path)
    };
    Ok(Self {
      path: borrow_path(env, path, prefix)?,
    })
  }
}

/// The arguments of isPointInPath(): (x, y, optional CanvasFillRule) or
/// (Path2D, x, y, optional CanvasFillRule). Three arguments pick the Path2D
/// form only when the first one is a Path2D.
pub struct IsPointInPathArgs {
  path: Option<&'static mut Path>,
  x: f64,
  y: f64,
  rule: FillType,
}

impl FromNapiValue for IsPointInPathArgs {
  unsafe fn from_napi_value(env: sys::napi_env, argc: sys::napi_value) -> Result<Self> {
    let args = webidl::Arguments::take(env, 4, argc)?;
    let prefix = <webidl::CtxIsPointInPath as webidl::Site>::PREFIX;
    let first = args.get(0)?;
    let with_path = match args.len() {
      0..=2 => false,
      3 => is_path2d(env, first),
      _ => {
        if !is_path2d(env, first) {
          return Err(not_path2d(env, prefix));
        }
        true
      }
    };
    let offset = u32::from(with_path);
    let x = webidl::to_number(env, args.get(offset)?, prefix)?;
    let y = webidl::to_number(env, args.get(offset + 1)?, prefix)?;
    let rule = if args.len() > 2 + offset {
      webidl::fill_rule(env, args.get(2 + offset)?, prefix)?
    } else {
      FillType::Winding
    };
    Ok(Self {
      path: borrow_path(env, with_path.then_some(first), prefix)?,
      x,
      y,
      rule,
    })
  }
}

/// The arguments of isPointInStroke(): (x, y) or (Path2D, x, y).
pub struct IsPointInStrokeArgs {
  path: Option<&'static mut Path>,
  x: f64,
  y: f64,
}

impl FromNapiValue for IsPointInStrokeArgs {
  unsafe fn from_napi_value(env: sys::napi_env, argc: sys::napi_value) -> Result<Self> {
    let args = webidl::Arguments::take(env, 3, argc)?;
    let prefix = <webidl::CtxIsPointInStroke as webidl::Site>::PREFIX;
    let first = args.get(0)?;
    let with_path = args.len() > 2;
    if with_path && !is_path2d(env, first) {
      return Err(not_path2d(env, prefix));
    }
    let offset = u32::from(with_path);
    let x = webidl::to_number(env, args.get(offset)?, prefix)?;
    let y = webidl::to_number(env, args.get(offset + 1)?, prefix)?;
    Ok(Self {
      path: borrow_path(env, with_path.then_some(first), prefix)?,
      x,
      y,
    })
  }
}

/// The class of a drawImage image, found by the type check of its WebIDL
/// union: the instanceof check of the class, and a native object behind it
/// (an object made with `Object.create(Image.prototype)` has none and is not
/// an image).
#[derive(Clone, Copy)]
enum DrawImageKind {
  CanvasElement,
  SVGCanvas,
  Image,
}

impl DrawImageKind {
  unsafe fn of(env: sys::napi_env, value: sys::napi_value) -> Option<Self> {
    let kind = unsafe {
      if <&mut CanvasElement as ValidateNapiValue>::validate(env, value).is_ok() {
        Self::CanvasElement
      } else if <&mut SVGCanvas as ValidateNapiValue>::validate(env, value).is_ok() {
        Self::SVGCanvas
      } else if <&mut Image as ValidateNapiValue>::validate(env, value).is_ok() {
        Self::Image
      } else {
        return None;
      }
    };
    has_native_object(env, value).then_some(kind)
  }

  /// Borrows `value` as this class. User code ran since `of`, and may have
  /// changed the prototype or Symbol.hasInstance, so the instanceof check is
  /// not repeated.
  unsafe fn borrow(self, env: sys::napi_env, value: sys::napi_value) -> Result<DrawImageSource> {
    unsafe {
      Ok(match self {
        Self::CanvasElement => Either3::A(CanvasElement::from_napi_mut_ref(env, value)?),
        Self::SVGCanvas => Either3::B(SVGCanvas::from_napi_mut_ref(env, value)?),
        Self::Image => Either3::C(Image::from_napi_mut_ref(env, value)?),
      })
    }
  }
}

type DrawImageSource =
  Either3<&'static mut CanvasElement<'static>, &'static mut SVGCanvas<'static>, &'static mut Image>;

/// The arguments of `drawImage`, its last parameter: (image, dx, dy),
/// (image, dx, dy, dw, dh) or (image, sx, sy, sw, sh, dx, dy, dw, dh).
/// WebIDL picks the overload from the argument count, and fails for any
/// other count before it converts anything
/// (canvas_2d_recorder_context.idl). The image is type checked before the
/// numbers run their user code, and borrowed after it.
pub struct DrawImageArgs {
  image: DrawImageSource,
  /// The 2, 4 or 8 numbers after the image, in `numbers[..len]`.
  numbers: [f64; 8],
  len: usize,
}

impl FromNapiValue for DrawImageArgs {
  unsafe fn from_napi_value(env: sys::napi_env, argc: sys::napi_value) -> Result<Self> {
    let args = webidl::Arguments::take(env, 9, argc)?;
    let prefix = <webidl::CtxDrawImage as webidl::Site>::PREFIX;
    let count = match args.len() {
      count @ 0..=2 => {
        return Err(webidl::context_type_error(
          env,
          prefix,
          &format!("3 arguments required, but only {count} present."),
        ));
      }
      count @ (3 | 5 | 9) => count,
      _ => {
        return Err(webidl::context_type_error(
          env,
          prefix,
          "Overload resolution failed.",
        ));
      }
    };
    let not_an_image = || {
      webidl::context_type_error(
        env,
        prefix,
        "The provided value is not of type '(CanvasElement or Image or SVGCanvas)'.",
      )
    };
    let image = args.get(0)?;
    let Some(kind) = (unsafe { DrawImageKind::of(env, image) }) else {
      return Err(not_an_image());
    };
    let mut numbers = [0.0; 8];
    for (number, index) in numbers.iter_mut().zip(1..count) {
      *number = webidl::to_number(env, args.get(index)?, prefix)?;
    }
    let image = unsafe { kind.borrow(env, image) }.map_err(|_| not_an_image())?;
    Ok(Self {
      image,
      numbers,
      len: count as usize - 1,
    })
  }
}

type PatternImage<'a> =
  Either4<&'a mut Image, &'a mut ImageData, &'a mut CanvasElement<'a>, &'a mut SVGCanvas<'a>>;

/// The class of a `createPattern` image, found by the one type check that
/// WebIDL runs on it.
#[derive(Clone, Copy)]
enum PatternImageKind {
  Image,
  ImageData,
  CanvasElement,
  SVGCanvas,
}

impl PatternImageKind {
  /// The instanceof checks that `PatternImage` runs, in its order, without
  /// the borrow.
  unsafe fn of(env: sys::napi_env, value: sys::napi_value) -> Option<Self> {
    unsafe {
      if <&mut Image as ValidateNapiValue>::validate(env, value).is_ok() {
        Some(Self::Image)
      } else if <&mut ImageData as ValidateNapiValue>::validate(env, value).is_ok() {
        Some(Self::ImageData)
      } else if <&mut CanvasElement as ValidateNapiValue>::validate(env, value).is_ok() {
        Some(Self::CanvasElement)
      } else if <&mut SVGCanvas as ValidateNapiValue>::validate(env, value).is_ok() {
        Some(Self::SVGCanvas)
      } else {
        None
      }
    }
  }

  /// Borrows `value` as this class: unwrap and type tag only. User code ran
  /// since `of`, and may have changed the prototype or Symbol.hasInstance,
  /// so the instanceof check is not repeated.
  unsafe fn borrow(
    self,
    env: sys::napi_env,
    value: sys::napi_value,
  ) -> Result<PatternImage<'static>> {
    unsafe {
      Ok(match self {
        Self::Image => Either4::A(Image::from_napi_mut_ref(env, value)?),
        Self::ImageData => Either4::B(ImageData::from_napi_mut_ref(env, value)?),
        Self::CanvasElement => Either4::C(CanvasElement::from_napi_mut_ref(env, value)?),
        Self::SVGCanvas => Either4::D(SVGCanvas::from_napi_mut_ref(env, value)?),
      })
    }
  }
}

/// The arguments of `createPattern`, its last parameter: it gets the
/// argument count and converts the `Positional` arguments before it. Chrome
/// converts the image (a type check) before the repetition, a
/// [LegacyNullToEmptyString] DOMString (canvas_2d_recorder_context.idl:47)
/// whose ToString may run user code.
/// The image is borrowed only after that, so the user code may use it, and
/// all of it happens before napi-rs borrows the context.
pub struct CreatePatternArgs<'a> {
  pub image: PatternImage<'a>,
  pub repetition: String,
}

impl FromNapiValue for CreatePatternArgs<'static> {
  unsafe fn from_napi_value(env: sys::napi_env, argc: sys::napi_value) -> Result<Self> {
    let args = webidl::Arguments::take(env, 2, argc)?;
    if args.len() < 2 {
      return Err(webidl::type_error(
        env,
        &format!(
          "{}2 arguments required, but only {} present.",
          webidl::CREATE_PATTERN,
          args.len()
        ),
      ));
    }
    let wrong_type = || {
      webidl::type_error(
        env,
        &format!(
          "{}The provided value is not of type '(CanvasElement or Image or ImageData or SVGCanvas)'.",
          webidl::CREATE_PATTERN
        ),
      )
    };
    let image = args.get(0)?;
    let Some(kind) = (unsafe { PatternImageKind::of(env, image) }) else {
      return Err(wrong_type());
    };
    let repetition = args.get(1)?;
    let repetition = if webidl::type_of(env, repetition)? == ValueType::Null {
      String::new()
    } else {
      webidl::to_js_string(env, repetition)?
    };
    let image = unsafe { kind.borrow(env, image) }.map_err(|_| wrong_type())?;
    Ok(Self { image, repetition })
  }
}

/// The arguments of `createImageData`, its last parameter: it gets the
/// argument count and converts the `Positional` arguments before it. WebIDL
/// picks the overload from the argument count, and an explicit undefined
/// counts (base_rendering_context_2d.idl:25). There is no typed array form:
/// with two or more arguments, a typed array is ToNumber'd as sw.
/// They are converted in the callback glue, before napi-rs borrows the
/// context, so a valueOf or a settings getter may use it.
pub enum CreateImageDataArgs {
  /// createImageData(ImageData imagedata).
  ImageData {
    width: usize,
    height: usize,
    color_space: ColorSpace,
  },
  /// createImageData([EnforceRange] long sw, [EnforceRange] long sh,
  /// optional ImageDataSettings settings).
  Size {
    width: u32,
    height: u32,
    settings: webidl::ImageDataSettings,
  },
}

impl FromNapiValue for CreateImageDataArgs {
  unsafe fn from_napi_value(env: sys::napi_env, argc: sys::napi_value) -> Result<Self> {
    let args = webidl::Arguments::take(env, 4, argc)?;
    let prefix = webidl::CREATE_IMAGE_DATA;
    if args.len() == 0 {
      return Err(webidl::context_type_error(
        env,
        prefix,
        "1 argument required, but only 0 present.",
      ));
    }
    let first = args.get(0)?;
    if args.len() == 1 {
      // The same size and color space, new zeroed data
      // (base_rendering_context_2d.cc:296).
      if unsafe { <&ImageData as ValidateNapiValue>::validate(env, first) }.is_ok()
        && let Ok(image_data) = unsafe { ImageData::from_napi_ref(env, first) }
      {
        return Ok(Self::ImageData {
          width: image_data.width,
          height: image_data.height,
          color_space: image_data.color_space,
        });
      }
      return Err(webidl::context_type_error(
        env,
        prefix,
        "parameter 1 is not of type 'ImageData'.",
      ));
    }
    // std::abs of each (base_rendering_context_2d.cc:312).
    let long = |value| webidl::enforce_range_long(env, value, prefix).map(i32::unsigned_abs);
    let width = long(first)?;
    let height = long(args.get(1)?)?;
    let settings = webidl::ImageDataSettings::from_js(env, Some(args.get(2)?), prefix)?;
    Ok(Self::Size {
      width,
      height,
      settings,
    })
  }
}

/// The arguments of `putImageData`, its last parameter: (imagedata, dx, dy)
/// or (imagedata, dx, dy, dirtyX, dirtyY, dirtyWidth, dirtyHeight), with
/// [EnforceRange] long numbers (base_rendering_context_2d.idl). WebIDL picks
/// the overload from the argument count and checks the image data before it
/// converts the numbers. The image data is borrowed after their user code.
pub struct PutImageDataArgs {
  image_data: &'static ImageData,
  dx: i32,
  dy: i32,
  /// dirtyX, dirtyY, dirtyWidth and dirtyHeight.
  dirty: Option<[i32; 4]>,
}

impl FromNapiValue for PutImageDataArgs {
  unsafe fn from_napi_value(env: sys::napi_env, argc: sys::napi_value) -> Result<Self> {
    let args = webidl::Arguments::take(env, 7, argc)?;
    let prefix = webidl::PUT_IMAGE_DATA;
    let count = match args.len() {
      count @ 0..=2 => {
        return Err(webidl::context_type_error(
          env,
          prefix,
          &format!("3 arguments required, but only {count} present."),
        ));
      }
      count @ (3 | 7) => count,
      _ => {
        return Err(webidl::context_type_error(
          env,
          prefix,
          "Overload resolution failed.",
        ));
      }
    };
    let not_image_data =
      || webidl::context_type_error(env, prefix, "parameter 1 is not of type 'ImageData'.");
    let image_data = args.get(0)?;
    if unsafe { <&ImageData as ValidateNapiValue>::validate(env, image_data) }.is_err() {
      return Err(not_image_data());
    }
    // dx, dy, then the dirty rectangle.
    let mut numbers = [0; 6];
    for (index, number) in (1..count).zip(&mut numbers) {
      *number = webidl::enforce_range_long(env, args.get(index)?, prefix)?;
    }
    let image_data =
      unsafe { ImageData::from_napi_ref(env, image_data) }.map_err(|_| not_image_data())?;
    Ok(Self {
      image_data,
      dx: numbers[0],
      dy: numbers[1],
      dirty: (count == 7).then(|| [numbers[2], numbers[3], numbers[4], numbers[5]]),
    })
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
    Ok(Self {
      context,
      reported_settings: ReportedSettings::default(),
    })
  }

  #[napi(getter)]
  pub fn get_miter_limit(&self) -> f32 {
    self.context.get_miter_limit()
  }

  #[napi(setter)]
  pub fn set_miter_limit(&mut self, miter_limit: webidl::Double<webidl::SetMiterLimit>) {
    // Blink keeps the old value unless the new one is finite and > 0
    // (canvas_2d_recorder_context.cc:1150).
    let miter_limit = miter_limit.0;
    if miter_limit.is_finite() && miter_limit > 0.0 {
      self.context.set_miter_limit(clamp_to_f32(miter_limit));
    }
  }

  #[napi(getter)]
  pub fn get_global_alpha(&self) -> f64 {
    self.context.get_global_alpha()
  }

  #[napi(setter)]
  pub fn set_global_alpha(&mut self, alpha: webidl::Double<webidl::SetGlobalAlpha>) {
    let alpha = alpha.0;
    if !(0.0..=1.0).contains(&alpha) {
      #[cfg(debug_assertions)]
      eprintln!("Alpha value out of range, expected 0.0 - 1.0, but got : {alpha}");
      return;
    }
    self.context.state.global_alpha = alpha;
    self.context.state.paint.set_alpha_f32(alpha as f32);
  }

  #[napi(getter)]
  pub fn get_global_composite_operation(&self) -> &str {
    self.context.state.paint.get_blend_mode().as_str()
  }

  #[napi(setter)]
  pub fn set_global_composite_operation(
    &mut self,
    mode: webidl::DomString<webidl::SetGlobalCompositeOperation>,
  ) {
    if let Ok(blend_mode) = mode.0.parse() {
      self.context.state.paint.set_blend_mode(blend_mode);
      self.context.state.global_composite_operation = blend_mode;
    };
  }

  #[napi(getter)]
  pub fn get_image_smoothing_enabled(&self) -> bool {
    self.context.state.image_smoothing_enabled
  }

  #[napi(setter)]
  pub fn set_image_smoothing_enabled(&mut self, enabled: Unknown) -> Result<()> {
    // WebIDL boolean: ToBoolean, so 0, '', null, undefined and NaN are false.
    self.context.state.image_smoothing_enabled = enabled.coerce_to_bool()?;
    Ok(())
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

  #[napi(setter)]
  pub fn set_image_smoothing_quality(
    &mut self,
    quality: webidl::DomString<webidl::SetImageSmoothingQuality>,
  ) {
    if let Ok(quality) = quality.0.parse() {
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

  #[napi(setter)]
  pub fn set_line_cap(&mut self, cap: webidl::DomString<webidl::SetLineCap>) {
    if let Ok(cap) = cap.0.parse() {
      self.context.state.paint.set_stroke_cap(cap);
    };
  }

  #[napi(getter)]
  pub fn get_line_dash_offset(&self) -> f64 {
    self.context.state.line_dash_offset as f64
  }

  #[napi(setter)]
  pub fn set_line_dash_offset(&mut self, offset: webidl::Double<webidl::SetLineDashOffset>) {
    // A non-finite offset is ignored (canvas_2d_recorder_context.cc:1253).
    if offset.0.is_finite() {
      self.context.state.line_dash_offset = clamp_to_f32(offset.0);
    }
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

  #[napi(setter)]
  pub fn set_line_join(&mut self, join: webidl::DomString<webidl::SetLineJoin>) {
    if let Ok(join) = join.0.parse() {
      self.context.state.paint.set_stroke_join(join);
    };
  }

  #[napi(getter)]
  pub fn get_line_width(&self) -> f64 {
    self.context.state.paint.get_stroke_width() as f64
  }

  #[napi(setter)]
  pub fn set_line_width(&mut self, width: webidl::Double<webidl::SetLineWidth>) {
    // Blink keeps the old width unless the new one is finite and > 0
    // (canvas_2d_recorder_context.cc:1103).
    let width = width.0;
    if width.is_finite() && width > 0.0 {
      self
        .context
        .state
        .paint
        .set_stroke_width(clamp_to_f32(width));
    }
  }

  /// The canvas: a read-only prototype getter, as in browsers.
  #[napi(getter)]
  pub fn get_canvas<'env>(&'env self, this: This<'env>) -> Result<Unknown<'env>> {
    this.get_named_property_unchecked(CANVAS_HIDDEN_NAME)
  }

  #[napi(getter)]
  pub fn get_fill_style<'env>(&'env self, this: This<'env>) -> Result<Unknown<'env>> {
    this.get_named_property_unchecked(FILL_STYLE_HIDDEN_NAME)
  }

  #[napi(setter)]
  pub fn set_fill_style(
    &mut self,
    mut this: This,
    fill_style: CanvasStyleArg<'_, webidl::SetFillStyle>,
  ) -> Result<()> {
    if let Some(pattern) = fill_style.pattern {
      self.context.state.fill_style = pattern;
      this.set(FILL_STYLE_HIDDEN_NAME, fill_style.value)?;
    }
    Ok(())
  }

  #[napi(getter)]
  pub fn get_filter(&self) -> String {
    self.context.state.filters_string.clone()
  }

  #[napi(setter)]
  pub fn set_filter(&mut self, filter: webidl::DomString<webidl::SetFilter>) -> Result<()> {
    self.context.set_filter(&filter.0)?;
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

  #[napi(setter)]
  pub fn set_font(&mut self, font: webidl::DomString<webidl::SetFont>) {
    // A number is not a font (it has no family), and Chrome keeps the font;
    // the font parser here would take it as a size. str::parse::<f64> takes
    // every form ToString gives a Number ("5", "1e+21", "NaN", "Infinity").
    if font.0.parse::<f64>().is_ok() {
      return;
    }
    // An invalid font is ignored (base_rendering_context_2d.cc setFont).
    let _ = self.context.set_font(font.0);
  }

  #[napi(getter)]
  pub fn get_direction(&self) -> String {
    self.context.state.text_direction.as_str().to_owned()
  }

  #[napi(setter)]
  pub fn set_direction(&mut self, direction: webidl::DomString<webidl::SetDirection>) {
    if let Ok(d) = direction.0.parse() {
      self.context.state.text_direction = d;
    };
  }

  #[napi(getter)]
  pub fn get_letter_spacing(&self) -> String {
    self.context.state.letter_spacing_raw.clone()
  }

  #[napi(setter)]
  pub fn set_letter_spacing(
    &mut self,
    spacing: webidl::DomString<webidl::SetLetterSpacing>,
  ) -> Result<()> {
    let spacing = spacing.0;
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

  #[napi(setter)]
  pub fn set_word_spacing(
    &mut self,
    spacing: webidl::DomString<webidl::SetWordSpacing>,
  ) -> Result<()> {
    let spacing = spacing.0;
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

  #[napi(setter)]
  pub fn set_stroke_style(
    &mut self,
    mut this: This,
    stroke_style: CanvasStyleArg<'_, webidl::SetStrokeStyle>,
  ) -> Result<()> {
    if let Some(pattern) = stroke_style.pattern {
      this.set(STROKE_STYLE_HIDDEN_NAME, stroke_style.value)?;
      self.context.state.stroke_style = pattern;
    }
    Ok(())
  }

  #[napi(getter)]
  pub fn get_shadow_blur(&self) -> f64 {
    self.context.state.shadow_blur as f64
  }

  #[napi(setter)]
  pub fn set_shadow_blur(&mut self, blur: webidl::Double<webidl::SetShadowBlur>) {
    let blur = blur.0;
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

  #[napi(setter)]
  pub fn set_shadow_color(&mut self, shadow_color: webidl::DomString<webidl::SetShadowColor>) {
    // An invalid color is ignored (canvas_2d_recorder_context.cc:1220).
    let _ = self.context.set_shadow_color(shadow_color.0);
  }

  #[napi(getter)]
  pub fn get_shadow_offset_x(&self) -> f64 {
    self.context.state.shadow_offset_x as f64
  }

  #[napi(setter)]
  pub fn set_shadow_offset_x(&mut self, offset_x: webidl::Double<webidl::SetShadowOffsetX>) {
    let offset_x = offset_x.0;
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

  #[napi(setter)]
  pub fn set_shadow_offset_y(&mut self, offset_y: webidl::Double<webidl::SetShadowOffsetY>) {
    let offset_y = offset_y.0;
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

  #[napi(setter)]
  pub fn set_text_align(&mut self, align: webidl::DomString<webidl::SetTextAlign>) {
    // A value outside the enum is ignored, as WebIDL does for an enum
    // attribute.
    let _ = self.context.set_text_align(align.0);
  }

  #[napi(getter)]
  pub fn get_text_baseline(&self) -> String {
    self.context.state.text_baseline.as_str().to_owned()
  }

  #[napi(setter)]
  pub fn set_text_baseline(&mut self, baseline: webidl::DomString<webidl::SetTextBaseline>) {
    let _ = self.context.set_text_baseline(baseline.0);
  }

  #[napi(getter)]
  pub fn get_font_stretch(&self) -> String {
    self.context.state.font_stretch_raw.clone()
  }

  #[napi(setter)]
  pub fn set_font_stretch(
    &mut self,
    stretch: webidl::DomString<webidl::SetFontStretch>,
  ) -> Result<()> {
    self.context.set_font_stretch(stretch.0)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_font_kerning(&self) -> String {
    self.context.state.font_kerning.as_str().to_owned()
  }

  #[napi(setter)]
  pub fn set_font_kerning(
    &mut self,
    kerning: webidl::DomString<webidl::SetFontKerning>,
  ) -> Result<()> {
    self.context.set_font_kerning(kerning.0)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_font_variant_caps(&self) -> String {
    self.context.state.font_variant_caps.as_str().to_owned()
  }

  #[napi(setter)]
  pub fn set_font_variant_caps(
    &mut self,
    variant_caps: webidl::DomString<webidl::SetFontVariantCaps>,
  ) -> Result<()> {
    self.context.set_font_variant_caps(variant_caps.0)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_text_rendering(&self) -> String {
    self.context.state.text_rendering.as_str().to_owned()
  }

  #[napi(setter)]
  pub fn set_text_rendering(
    &mut self,
    rendering: webidl::DomString<webidl::SetTextRendering>,
  ) -> Result<()> {
    self.context.set_text_rendering(rendering.0)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_lang(&self) -> String {
    self.context.state.lang.clone()
  }

  #[napi(setter)]
  pub fn set_lang(&mut self, lang: webidl::DomString<webidl::SetLang>) {
    self.context.set_lang(lang.0);
  }

  #[napi]
  pub fn arc(
    &mut self,
    env: &Env,
    x: Double<webidl::CtxArc>,
    y: Double<webidl::CtxArc>,
    radius: Double<webidl::CtxArc>,
    start_angle: Double<webidl::CtxArc>,
    end_angle: Double<webidl::CtxArc>,
    anticlockwise: webidl::Boolean,
  ) -> Result<()> {
    // Path methods drop a call with a value outside the float range
    // (Blink canvas_path.cc: saturated_cast<float>, then isfinite).
    let Some([x, y, radius, start_angle, end_angle]) =
      num::saturated_f32s([x.0, y.0, radius.0, start_angle.0, end_angle.0])
    else {
      return Ok(());
    };
    check_radius(
      env.raw(),
      <webidl::CtxArc as webidl::Site>::PREFIX,
      "radius",
      radius,
    )?;
    self
      .context
      .arc(x, y, radius, start_angle, end_angle, anticlockwise.0);
    Ok(())
  }

  #[napi]
  pub fn arc_to(
    &mut self,
    env: &Env,
    x1: Double<webidl::CtxArcTo>,
    y1: Double<webidl::CtxArcTo>,
    x2: Double<webidl::CtxArcTo>,
    y2: Double<webidl::CtxArcTo>,
    radius: Double<webidl::CtxArcTo>,
  ) -> Result<()> {
    let Some([x1, y1, x2, y2, radius]) = num::saturated_f32s([x1.0, y1.0, x2.0, y2.0, radius.0])
    else {
      return Ok(());
    };
    check_radius(
      env.raw(),
      <webidl::CtxArcTo as webidl::Site>::PREFIX,
      "radius",
      radius,
    )?;
    self.context.arc_to(x1, y1, x2, y2, radius);
    Ok(())
  }

  #[napi]
  pub fn begin_path(&mut self) {
    self.context.begin_path();
  }

  #[napi]
  pub fn bezier_curve_to(
    &mut self,
    cp1x: Double<webidl::CtxBezierCurveTo>,
    cp1y: Double<webidl::CtxBezierCurveTo>,
    cp2x: Double<webidl::CtxBezierCurveTo>,
    cp2y: Double<webidl::CtxBezierCurveTo>,
    x: Double<webidl::CtxBezierCurveTo>,
    y: Double<webidl::CtxBezierCurveTo>,
  ) {
    let Some([cp1x, cp1y, cp2x, cp2y, x, y]) =
      num::saturated_f32s([cp1x.0, cp1y.0, cp2x.0, cp2y.0, x.0, y.0])
    else {
      return;
    };
    self.context.bezier_curve_to(cp1x, cp1y, cp2x, cp2y, x, y);
  }

  #[napi]
  pub fn quadratic_curve_to(
    &mut self,
    cpx: Double<webidl::CtxQuadraticCurveTo>,
    cpy: Double<webidl::CtxQuadraticCurveTo>,
    x: Double<webidl::CtxQuadraticCurveTo>,
    y: Double<webidl::CtxQuadraticCurveTo>,
  ) {
    let Some([cpx, cpy, x, y]) = num::saturated_f32s([cpx.0, cpy.0, x.0, y.0]) else {
      return;
    };
    self.context.quadratic_curve_to(cpx, cpy, x, y);
  }

  /// clip(fillRule?) or clip(path, fillRule?). The index.js wrapper passes
  /// the argument count after them; see `webidl::Arguments::take`.
  #[napi]
  pub fn clip(
    &mut self,
    _path_or_rule: Positional,
    _rule: Positional,
    args: FillArgs<webidl::CtxClip>,
  ) {
    self
      .context
      .clip(args.path.map(|p| &mut p.inner), args.rule);
  }

  #[napi]
  pub fn clear_rect(
    &mut self,
    x: Double<webidl::CtxClearRect>,
    y: Double<webidl::CtxClearRect>,
    width: Double<webidl::CtxClearRect>,
    height: Double<webidl::CtxClearRect>,
  ) -> Result<()> {
    // ValidateRectForCanvas: a non-finite or empty (0 x 0) rect clears
    // nothing; then ClampTo<float> (canvas_2d_recorder_context.cc:1928).
    let Some([x, y, width, height]) = num::clamped_f32s([x.0, y.0, width.0, height.0]) else {
      return Ok(());
    };
    if width == 0.0 && height == 0.0 {
      return Ok(());
    }
    self.context.clear_rect(x, y, width, height)?;
    Ok(())
  }

  #[napi]
  pub fn close_path(&mut self) {
    self.context.close_path();
  }

  /// createImageData(imagedata) or (sw, sh, settings?). The index.js wrapper
  /// passes the argument count after the 4 positional arguments; see
  /// `webidl::Arguments::take`.
  #[napi]
  pub fn create_image_data<'scope>(
    &'scope mut self,
    env: &'scope Env,
    _arg0: Positional,
    _arg1: Positional,
    _arg2: Positional,
    _arg3: Positional,
    args: CreateImageDataArgs,
  ) -> Result<ClassInstance<'scope, ImageData>> {
    match args {
      CreateImageDataArgs::ImageData {
        width,
        height,
        color_space,
      } => ImageData::new_zeroed(env, width, height, color_space),
      CreateImageDataArgs::Size {
        width,
        height,
        settings,
      } => {
        let prefix = webidl::CREATE_IMAGE_DATA;
        validate_size(
          env.raw(),
          prefix,
          width,
          Some(height),
          SizeErrors::Context2D,
        )?;
        // Spec: defaultColorSpace is this context's color space.
        let color_space = settings
          .color_space(env.raw(), prefix)?
          .unwrap_or(self.context.color_space);
        ImageData::new_zeroed(env, width as usize, height as usize, color_space)
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
    start_angle: f64,
    x: f64,
    y: f64,
  ) -> Result<ClassInstance<'scope, CanvasGradient>> {
    let conic_gradient = Gradient::create_conic_gradient(x as f32, y as f32, start_angle as f32);
    CanvasGradient(conic_gradient).into_instance(env)
  }

  /// createPattern(image, repetition). The index.js wrapper passes the
  /// argument count after them; see `webidl::Arguments::take`.
  #[napi(ts_return_type = "CanvasPattern | null")]
  pub fn create_pattern<'scope>(
    &'scope self,
    env: &'scope Env,
    _image: Positional,
    _repetition: Positional,
    args: CreatePatternArgs<'_>,
  ) -> Result<Option<ClassInstance<'scope, CanvasPattern>>> {
    CanvasPattern::create(*env, args.image, &args.repetition)?
      .map(|pattern| pattern.into_instance(env))
      .transpose()
  }

  #[napi]
  pub fn rect(
    &mut self,
    x: Double<webidl::CtxRect>,
    y: Double<webidl::CtxRect>,
    width: Double<webidl::CtxRect>,
    height: Double<webidl::CtxRect>,
  ) {
    let Some([x, y, width, height]) = num::saturated_f32s([x.0, y.0, width.0, height.0]) else {
      return;
    };
    self.context.rect(x, y, width, height);
  }

  #[napi]
  pub fn round_rect(
    &mut self,
    env: &Env,
    x: Double<webidl::CtxRoundRect>,
    y: Double<webidl::CtxRoundRect>,
    width: Double<webidl::CtxRoundRect>,
    height: Double<webidl::CtxRoundRect>,
    radii: webidl::RoundRectRadii<webidl::CtxRoundRect>,
  ) -> Result<()> {
    if let Some(([x, y, width, height], radii)) = check_round_rect(
      env.raw(),
      <webidl::CtxRoundRect as webidl::Site>::PREFIX,
      self.context.transform_is_invertible(),
      [x.0, y.0, width.0, height.0],
      &radii.0,
    )? {
      self.context.round_rect(x, y, width, height, &radii);
    }
    Ok(())
  }

  /// fill(fillRule?) or fill(path, fillRule?). The index.js wrapper passes
  /// the argument count after them; see `webidl::Arguments::take`.
  #[napi]
  pub fn fill(
    &mut self,
    _path_or_rule: Positional,
    _rule: Positional,
    args: FillArgs<webidl::CtxFill>,
  ) -> Result<()> {
    self
      .context
      .fill(args.path.map(|p| &mut p.inner), args.rule)?;
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
  pub fn reset(&mut self, mut this: This) -> Result<()> {
    self.context.reset();
    reset_style_getters(&mut this)
  }

  #[napi]
  pub fn rotate(&mut self, angle: Double<webidl::CtxRotate>) {
    // A non-finite transform argument makes the call a no-op
    // (canvas_2d_recorder_context.cc:1354-1482).
    if angle.0.is_finite() {
      self.context.rotate(angle.0);
    }
  }

  #[napi]
  pub fn scale(&mut self, x: Double<webidl::CtxScale>, y: Double<webidl::CtxScale>) {
    if let Some([x, y]) = num::clamped_f32s([x.0, y.0]) {
      self.context.scale(x, y);
    }
  }

  /// drawImage(image, dx, dy), (image, dx, dy, dw, dh) or (image, sx, sy,
  /// sw, sh, dx, dy, dw, dh). The index.js wrapper passes the argument count
  /// after them; see `webidl::Arguments::take`.
  #[napi]
  pub fn draw_image(
    &mut self,
    env: &Env,
    _image: Positional,
    _arg1: Positional,
    _arg2: Positional,
    _arg3: Positional,
    _arg4: Positional,
    _arg5: Positional,
    _arg6: Positional,
    _arg7: Positional,
    _arg8: Positional,
    args: DrawImageArgs,
  ) -> Result<()> {
    // Chrome returns on a non-finite number before it looks at the image,
    // then throws for a broken image (canvas_2d_recorder_context.cc
    // DrawImage). The source size of the 3 and 5 argument forms is finite.
    if !args.numbers[..args.len].iter().all(|n| n.is_finite()) {
      return Ok(());
    }
    if let Either3::C(image) = &args.image
      && image.broken
    {
      return Err(webidl::dom_exception(
        env.raw(),
        "InvalidStateError",
        &format!(
          "{}The HTMLImageElement provided is in the 'broken' state.",
          <webidl::CtxDrawImage as webidl::Site>::PREFIX
        ),
      ));
    }
    // raster_key dedups the retained-raster charge inside draw_image:
    // (resource identity, content generation). A canvas source is keyed by
    // its Context's resource_id -- a monotonic id, not the SkSurface*, which
    // is freed with the canvas and recycled -- plus its content_version: a
    // mutation (recorded op, direct surface write, surface replacement in
    // get_content) COWs a new raster and must re-charge. An Image source is
    // keyed by its current AccountedBitmap's own resource_id: every decode,
    // src reset, and regenerate_bitmap_if_need constructs a fresh
    // AccountedBitmap, so a swapped bitmap can never alias the stale charge.
    let (bitmap, decode_cache, raster_key) = match args.image {
      Either3::A(canvas) => {
        // Flush the source canvas to render deferred operations before getting bitmap
        canvas.ctx.context.flush();
        let bitmap = BitmapRef::Owned(canvas.ctx.context.surface.get_bitmap());
        (
          bitmap,
          None,
          RasterKey::Resource {
            id: canvas.ctx.context.resource_id,
            generation: canvas.ctx.context.content_version(),
          },
        )
      }
      Either3::B(svg) => {
        // The raster surface holds what was drawn (as a canvas would draw it)
        // only after a flush.
        svg.ctx.context.flush();
        let bitmap = BitmapRef::Owned(svg.ctx.context.surface.get_bitmap());
        (
          bitmap,
          None,
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
            // Chrome draws an SVG Image as vectors, not from the decode
            // cache; its raster is sampled as it is.
            (!image.is_svg).then_some(bitmap.as_ref()),
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
    let source_width = bitmap_ref.0.width as f64;
    let source_height = bitmap_ref.0.height as f64;
    let (sx, sy, s_width, s_height, dx, dy, d_width, d_height) = match args.numbers[..args.len] {
      [dx, dy] => (
        0.0,
        0.0,
        source_width,
        source_height,
        dx,
        dy,
        source_width,
        source_height,
      ),
      [dx, dy, d_width, d_height] => (
        0.0,
        0.0,
        source_width,
        source_height,
        dx,
        dy,
        d_width,
        d_height,
      ),
      [sx, sy, s_width, s_height, dx, dy, d_width, d_height] => {
        (sx, sy, s_width, s_height, dx, dy, d_width, d_height)
      }
      _ => return Ok(()),
    };
    let (sx, sy, s_width, s_height) = Context::adjust_rect_for_canvas(sx, sy, s_width, s_height);
    let (dx, dy, d_width, d_height) = Context::adjust_rect_for_canvas(dx, dy, d_width, d_height);
    self.context.draw_image(
      bitmap_ref,
      decode_cache,
      raster_key,
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
    // A raster destination in another color space would replay the source's
    // ops in its own space (gradients interpolate there), so it takes the
    // source bitmap, as drawImage does. PDF and SVG keep the vector replay.
    let picture = if self.context.backend == Backend::Raster
      && canvas.ctx.context.color_space != self.context.color_space
    {
      None
    } else {
      canvas.ctx.context.get_picture()
    };

    let picture = if let Some(pic) = picture {
      pic
    } else {
      // Fallback to bitmap if picture not available (e.g., SVG canvas or no deferred rendering).
      // Flush first so the bitmap reads the surface's complete content.
      canvas.ctx.context.flush();
      let bitmap = canvas.ctx.as_ref().context.surface.get_bitmap();
      let (source_width, source_height) = (source_width as f64, source_height as f64);
      let (sx, sy, s_width, s_height, dx, dy, d_width, d_height) =
        match (sx, sy, s_width, s_height, dx, dy, d_width, d_height) {
          (Some(dx), Some(dy), None, None, None, None, None, None) => (
            0.0,
            0.0,
            source_width,
            source_height,
            dx,
            dy,
            source_width,
            source_height,
          ),
          (Some(dx), Some(dy), Some(d_width), Some(d_height), None, None, None, None) => (
            0.0,
            0.0,
            source_width,
            source_height,
            dx,
            dy,
            d_width,
            d_height,
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
          ) => (sx, sy, s_width, s_height, dx, dy, d_width, d_height),
          _ => return Ok(()),
        };
      let (sx, sy, s_width, s_height) = Context::adjust_rect_for_canvas(sx, sy, s_width, s_height);
      let (dx, dy, d_width, d_height) = Context::adjust_rect_for_canvas(dx, dy, d_width, d_height);
      return self.context.draw_image(
        &bitmap,
        None,
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

    // Parse parameters as drawImage does, and as the bitmap arm above: a
    // negative size moves the origin instead of mirroring.
    let (source_width, source_height) = (source_width as f64, source_height as f64);
    let (sx, sy, s_width, s_height, dx, dy, d_width, d_height) =
      match (sx, sy, s_width, s_height, dx, dy, d_width, d_height) {
        (Some(dx), Some(dy), None, None, None, None, None, None) => (
          0.0,
          0.0,
          source_width,
          source_height,
          dx,
          dy,
          source_width,
          source_height,
        ),
        (Some(dx), Some(dy), Some(d_width), Some(d_height), None, None, None, None) => (
          0.0,
          0.0,
          source_width,
          source_height,
          dx,
          dy,
          d_width,
          d_height,
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
        ) => (sx, sy, s_width, s_height, dx, dy, d_width, d_height),
        _ => return Ok(()),
      };
    // Normalised, and the origins clamped to the f32 range as drawImage does,
    // so a transform that scales the clamped rect back into view draws it.
    // The sizes are not clamped: a size past the range stays infinite and the
    // replay draws nothing, as drawImage does with f32::MAX unless a tiny
    // transform scales it back into view. A finite f32::MAX would make the
    // replay scale the picture's first column across the canvas instead.
    let (sx, sy, s_width, s_height) = Context::normalize_rect_for_canvas(sx, sy, s_width, s_height);
    let (dx, dy, d_width, d_height) = Context::normalize_rect_for_canvas(dx, dy, d_width, d_height);
    let clamp = Context::clamp_to_f32;
    let (sx, sy, s_width, s_height) = (clamp(sx), clamp(sy), s_width as f32, s_height as f32);
    let (dx, dy, d_width, d_height) = (clamp(dx), clamp(dy), d_width as f32, d_height as f32);
    // Before any charge, as in draw_image (which the fallback above reaches).
    if !Context::source_rect_overlaps(
      sx,
      sy,
      s_width,
      s_height,
      source_width as f32,
      source_height as f32,
    ) {
      return Ok(());
    }

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

  /// A new object on each call (base_rendering_context_2d.cc:156).
  #[napi]
  pub fn get_context_attributes(&self) -> ContextAttributes {
    let reported = self.reported_settings;
    ContextAttributes {
      alpha: self.context.alpha,
      color_space: self.context.color_space.as_str().to_owned(),
      color_type: reported.color_type.as_str().to_owned(),
      desynchronized: reported.desynchronized,
      // Chrome 155 does not read toneMapping and reports the default.
      tone_mapping: CanvasToneMapping {
        mode: "standard".to_owned(),
      },
      will_read_frequently: reported.will_read_frequently,
    }
  }

  /// isPointInPath(x, y, fillRule?) or (path, x, y, fillRule?). The
  /// index.js wrapper passes the argument count after them; see
  /// `webidl::Arguments::take`.
  #[napi]
  pub fn is_point_in_path(
    &self,
    _arg0: Positional,
    _arg1: Positional,
    _arg2: Positional,
    _arg3: Positional,
    args: IsPointInPathArgs,
  ) -> bool {
    // Blink IsPointInPathInternal: false under a singular CTM, else the point
    // through the double inverse (canvas_2d_recorder_context.cc:1852-1870).
    if !self.context.transform_is_invertible() {
      return false;
    }
    let (x, y) = blink_inverse_map(&self.context.state.transform, args.x as f32, args.y as f32);
    match args.path {
      Some(path) => path.inner.hit_test(x, y, args.rule),
      None => self.context.path.hit_test(x, y, args.rule),
    }
  }

  /// isPointInStroke(x, y) or (path, x, y). The index.js wrapper passes the
  /// argument count after them; see `webidl::Arguments::take`.
  #[napi]
  pub fn is_point_in_stroke(
    &self,
    _arg0: Positional,
    _arg1: Positional,
    _arg2: Positional,
    args: IsPointInStrokeArgs,
  ) -> bool {
    // As isPointInPath (canvas_2d_recorder_context.cc:1887-1913).
    if !self.context.transform_is_invertible() {
      return false;
    }
    let stroke_w = self.context.get_stroke_width();
    let (x, y) = blink_inverse_map(&self.context.state.transform, args.x as f32, args.y as f32);
    match args.path {
      Some(path) => path.inner.stroke_hit_test(x, y, stroke_w),
      None => self.context.path.stroke_hit_test(x, y, stroke_w),
    }
  }

  #[napi]
  pub fn ellipse(
    &mut self,
    env: &Env,
    x: Double<webidl::CtxEllipse>,
    y: Double<webidl::CtxEllipse>,
    radius_x: Double<webidl::CtxEllipse>,
    radius_y: Double<webidl::CtxEllipse>,
    rotation: Double<webidl::CtxEllipse>,
    start_angle: Double<webidl::CtxEllipse>,
    end_angle: Double<webidl::CtxEllipse>,
    anticlockwise: webidl::Boolean,
  ) -> Result<()> {
    let Some([x, y, radius_x, radius_y, rotation, start_angle, end_angle]) = num::saturated_f32s([
      x.0,
      y.0,
      radius_x.0,
      radius_y.0,
      rotation.0,
      start_angle.0,
      end_angle.0,
    ]) else {
      return Ok(());
    };
    let prefix = <webidl::CtxEllipse as webidl::Site>::PREFIX;
    check_radius(env.raw(), prefix, "major-axis radius", radius_x)?;
    check_radius(env.raw(), prefix, "minor-axis radius", radius_y)?;
    self.context.ellipse(
      x,
      y,
      radius_x,
      radius_y,
      rotation,
      start_angle,
      end_angle,
      anticlockwise.0,
    );
    Ok(())
  }

  #[napi]
  pub fn line_to(&mut self, x: Double<webidl::CtxLineTo>, y: Double<webidl::CtxLineTo>) {
    if let Some([x, y]) = num::saturated_f32s([x.0, y.0]) {
      self.context.line_to(x, y);
    }
  }

  #[napi]
  pub fn measure_text(
    &mut self,
    text: webidl::DomString<webidl::CtxMeasureText>,
  ) -> Result<TextMetrics> {
    let text = text.0.as_str();
    // The empty string keeps every field 0 (Chrome still reports the font's
    // metrics there).
    let metrics = if text.is_empty() {
      Default::default()
    } else {
      self.context.get_line_metrics(text, false)?.0
    };
    Ok(TextMetrics {
      width: metrics.width as f64,
      actual_bounding_box_left: metrics.left as f64,
      actual_bounding_box_right: metrics.right as f64,
      font_bounding_box_ascent: metrics.font_ascent as f64,
      font_bounding_box_descent: metrics.font_descent as f64,
      actual_bounding_box_ascent: metrics.ascent as f64,
      actual_bounding_box_descent: metrics.descent as f64,
      hanging_baseline: metrics.hanging_baseline as f64,
      alphabetic_baseline: metrics.alphabetic_baseline as f64,
      ideographic_baseline: metrics.ideographic_baseline as f64,
      em_height_ascent: metrics.em_height_ascent as f64,
      em_height_descent: metrics.em_height_descent as f64,
    })
  }

  /// Always false: a raster, SVG or PDF context is never lost.
  #[napi]
  pub fn is_context_lost(&self) -> bool {
    false
  }

  #[napi]
  pub fn move_to(&mut self, x: Double<webidl::CtxMoveTo>, y: Double<webidl::CtxMoveTo>) {
    if let Some([x, y]) = num::saturated_f32s([x.0, y.0]) {
      self.context.move_to(x, y);
    }
  }

  #[napi]
  pub fn fill_rect(
    &mut self,
    x: Double<webidl::CtxFillRect>,
    y: Double<webidl::CtxFillRect>,
    width: Double<webidl::CtxFillRect>,
    height: Double<webidl::CtxFillRect>,
  ) -> Result<()> {
    let (x, y, width, height) = (x.0, y.0, width.0, height.0);
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

  #[napi]
  pub fn fill_text(
    &mut self,
    text: webidl::DomString<webidl::CtxFillText>,
    x: Double<webidl::CtxFillText>,
    y: Double<webidl::CtxFillText>,
    max_width: webidl::OptionalDouble<webidl::CtxFillText>,
  ) -> Result<()> {
    let (x, y, max_width) = (x.0, y.0, max_width.0);
    let text = text.0.as_str();
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

  /// stroke() or stroke(path). The index.js wrapper passes the argument
  /// count after it; see `webidl::Arguments::take`.
  #[napi]
  pub fn stroke(&mut self, _path: Positional, args: StrokeArgs) -> Result<()> {
    self.context.stroke(args.path.map(|p| &mut p.inner))?;
    Ok(())
  }

  #[napi]
  pub fn stroke_rect(
    &mut self,
    x: Double<webidl::CtxStrokeRect>,
    y: Double<webidl::CtxStrokeRect>,
    width: Double<webidl::CtxStrokeRect>,
    height: Double<webidl::CtxStrokeRect>,
  ) -> Result<()> {
    let (x, y, width, height) = (x.0, y.0, width.0, height.0);
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

  #[napi]
  pub fn stroke_text(
    &mut self,
    text: webidl::DomString<webidl::CtxStrokeText>,
    x: Double<webidl::CtxStrokeText>,
    y: Double<webidl::CtxStrokeText>,
    max_width: webidl::OptionalDouble<webidl::CtxStrokeText>,
  ) -> Result<()> {
    let (x, y, max_width) = (x.0, y.0, max_width.0);
    let text = text.0.as_str();
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
    sx: webidl::EnforceRangeLong<webidl::CtxGetImageData>,
    sy: webidl::EnforceRangeLong<webidl::CtxGetImageData>,
    sw: webidl::EnforceRangeLong<webidl::CtxGetImageData>,
    sh: webidl::EnforceRangeLong<webidl::CtxGetImageData>,
    settings: webidl::GetImageDataSettings,
  ) -> Result<ClassInstance<'scope, ImageData>> {
    let raw = env.raw();
    let prefix = webidl::GET_IMAGE_DATA;
    // A PDF page has no pixels to read (its surface is null).
    if self.context.backend == Backend::Pdf {
      return Err(webidl::dom_exception(
        raw,
        "NotSupportedError",
        "getImageData() is not supported on a PDF page",
      ));
    }
    let settings = settings.0;
    let (sx, sy, sw, sh) = (sx.0, sy.0, sw.0, sh.0);
    // getImageDataInternal (base_rendering_context_2d.cc) on the `long`
    // values: the product must fit in an int, and neither side may be 0.
    if sw.checked_mul(sh).is_none() {
      return Err(out_of_memory(raw, prefix));
    }
    if sw == 0 || sh == 0 {
      return Err(webidl::dom_exception(
        raw,
        "IndexSizeError",
        &format!(
          "{prefix}The source {} is 0.",
          if sw == 0 { "width" } else { "height" }
        ),
      ));
    }
    // A negative size flips the origin: sx += sw, then
    // sw = saturated_cast<int>(SafeUnsignedAbs(sw)), each with CheckAdd.
    let flip = |origin: i32, size: i32| -> Option<(i32, i32)> {
      if size >= 0 {
        return Some((origin, size));
      }
      let origin = origin.checked_add(size)?;
      Some((origin, size.unsigned_abs().min(i32::MAX as u32) as i32))
    };
    let Some(((x, w), (y, h))) = flip(sx, sw).zip(flip(sy, sh)) else {
      return Err(out_of_memory(raw, prefix));
    };
    if x.checked_add(w).is_none() || y.checked_add(h).is_none() {
      return Err(out_of_memory(raw, prefix));
    }
    let (sw, sh) = (w as u32, h as u32);
    // ImageData::ValidateAndCreate.
    let len = validate_size(raw, prefix, sw, Some(sh), SizeErrors::Context2D)?;
    // Spec: defaultColorSpace is this context's color space.
    let color_space = settings
      .color_space(raw, prefix)?
      .unwrap_or(self.context.color_space);
    if len > MAX_DATA_BYTES {
      return Err(out_of_memory(raw, prefix));
    }
    let image_data = self
      .context
      .get_image_data(x, y, sw, sh, color_space)
      .map_err(|e| match e {
        ReadPixelsError::OutOfMemory => out_of_memory(raw, prefix),
        ReadPixelsError::Failed => Error::new(
          Status::GenericFailure,
          "Read pixels from canvas failed".to_string(),
        ),
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

  /// putImageData(imagedata, dx, dy) or (imagedata, dx, dy, dirtyX, dirtyY,
  /// dirtyWidth, dirtyHeight). The index.js wrapper passes the argument
  /// count after them; see `webidl::Arguments::take`.
  #[napi]
  pub fn put_image_data(
    &mut self,
    env: Env,
    _image_data: Positional,
    _dx: Positional,
    _dy: Positional,
    _dirty_x: Positional,
    _dirty_y: Positional,
    _dirty_width: Positional,
    _dirty_height: Positional,
    args: PutImageDataArgs,
  ) -> Result<()> {
    let PutImageDataArgs {
      image_data,
      dx,
      dy,
      dirty,
    } = args;
    // base_rendering_context_2d.cc putImageData: a dirty area that overflows
    // an int returns before the detach check.
    if let Some([_, _, w, h]) = dirty
      && w.checked_mul(h).is_none()
    {
      return Ok(());
    }
    // A detached (transferred) data buffer is an InvalidStateError; `data`
    // is non-configurable so it cannot be deleted.
    let data = image_data
      .resolve_pixels(&env)
      .map_err(|e| match e.status {
        Status::InvalidArg => webidl::dom_exception(
          env.raw(),
          "InvalidStateError",
          &format!(
            "{}The source data has been detached.",
            webidl::PUT_IMAGE_DATA
          ),
        ),
        _ => e,
      })?;
    if let Some([dirty_x, dirty_y, dirty_width, dirty_height]) = dirty {
      let mut dirty_x = dirty_x as f32;
      let mut dirty_y = dirty_y as f32;
      let mut dirty_width = dirty_width as f32;
      let mut dirty_height = dirty_height as f32;
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
        let opaque = !self.context.alpha;
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
            opaque,
          );
        });
        // The charge may have tripped the cap on its own (a single
        // putImageData can pin a multi-hundred-MB pixel copy); consolidate
        // now so it is not retained while the context sits idle.
        self.context.flush_if_recording_limit_exceeded();
        return Ok(());
      }
      // Direct mode (SVG/PDF): write to surface canvas with inverted transform
      // snapshot=false: pixels are consumed immediately, no copy needed. The
      // SVG canvas also records the draw for its raster surface, so it needs
      // its own copy of the pixels.
      let snapshot = self.context.backend == Backend::Svg;
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
        snapshot,
        !self.context.alpha,
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
        let opaque = !self.context.alpha;
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
            opaque,
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

  #[napi]
  pub fn set_line_dash(&mut self, dash_list: webidl::DoubleSequence<webidl::CtxSetLineDash>) {
    let dash_list = dash_list.0;
    // A list with a negative or non-finite entry is ignored
    // (canvas_2d_recorder_context.cc:1237 LineDashSequenceIsValid).
    if !dash_list
      .iter()
      .all(|dash| dash.is_finite() && *dash >= 0.0)
    {
      return;
    }
    let len = dash_list.len();
    let is_odd = len & 1 != 0;
    let mut line_dash_list = if is_odd {
      vec![0f32; len * 2]
    } else {
      vec![0f32; len]
    };
    for (idx, dash) in dash_list.iter().enumerate() {
      line_dash_list[idx] = clamp_to_f32(*dash);
      if is_odd {
        line_dash_list[idx + len] = clamp_to_f32(*dash);
      }
    }
    self.context.set_line_dash(line_dash_list);
  }

  #[napi]
  pub fn reset_transform(&mut self) {
    self.context.reset_transform();
  }

  #[napi]
  pub fn translate(&mut self, x: Double<webidl::CtxTranslate>, y: Double<webidl::CtxTranslate>) {
    if let Some([x, y]) = num::clamped_f32s([x.0, y.0]) {
      self.context.translate(x, y);
    }
  }

  #[napi]
  pub fn transform(
    &mut self,
    a: Double<webidl::CtxTransform>,
    b: Double<webidl::CtxTransform>,
    c: Double<webidl::CtxTransform>,
    d: Double<webidl::CtxTransform>,
    e: Double<webidl::CtxTransform>,
    f: Double<webidl::CtxTransform>,
  ) -> Result<()> {
    let Some([a, b, c, d, e, f]) = num::clamped_f32s([a.0, b.0, c.0, d.0, e.0, f.0]) else {
      return Ok(());
    };
    self.context.transform(Matrix::new(a, c, e, b, d, f))?;
    Ok(())
  }

  #[napi]
  pub fn get_transform(&self) -> TransformObject {
    self.context.state.transform.get_transform().into()
  }

  /// setTransform(a, b, c, d, e, f). index.js picks the overload and reads
  /// setTransform(transform?)'s DOMMatrixInit itself, so it always passes six
  /// numbers; see `webidl::MatrixArg` for a raw call. A non-finite value
  /// makes it a no-op (canvas_2d_recorder_context.cc:1528-1552).
  #[napi]
  pub fn set_transform(
    &mut self,
    a: webidl::SetTransformA,
    b: Double<webidl::CtxSetTransform>,
    c: Double<webidl::CtxSetTransform>,
    d: Double<webidl::CtxSetTransform>,
    e: Double<webidl::CtxSetTransform>,
    f: Double<webidl::CtxSetTransform>,
  ) {
    if let Some([a, b, c, d, e, f]) = num::clamped_f32s(a.0.with([b.0, c.0, d.0, e.0, f.0])) {
      self.context.set_transform(Matrix::new(a, c, e, b, d, f));
    }
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

/// A measureText() result. As in browsers it is a class whose fields are
/// read-only getters on the prototype (text_metrics.idl), so the object has
/// no own properties, and scripts cannot construct one.
#[napi]
pub struct TextMetrics {
  width: f64,
  actual_bounding_box_left: f64,
  actual_bounding_box_right: f64,
  font_bounding_box_ascent: f64,
  font_bounding_box_descent: f64,
  actual_bounding_box_ascent: f64,
  actual_bounding_box_descent: f64,
  hanging_baseline: f64,
  alphabetic_baseline: f64,
  ideographic_baseline: f64,
  em_height_ascent: f64,
  em_height_descent: f64,
}

/// The getters, in Blink's order (text_metrics.idl); emHeightAscent and
/// emHeightDescent (behind ExtendedTextMetrics in Chrome) come last.
#[napi]
impl TextMetrics {
  /// Only measureText() makes one; napi-rs skips this for the objects it
  /// returns.
  #[napi(constructor)]
  pub fn new(env: &Env) -> Result<Self> {
    Err(webidl::context_type_error(
      env.raw(),
      "Failed to construct 'TextMetrics': ",
      "Illegal constructor",
    ))
  }

  #[napi(getter)]
  pub fn get_width(&self) -> f64 {
    self.width
  }

  #[napi(getter)]
  pub fn get_actual_bounding_box_left(&self) -> f64 {
    self.actual_bounding_box_left
  }

  #[napi(getter)]
  pub fn get_actual_bounding_box_right(&self) -> f64 {
    self.actual_bounding_box_right
  }

  #[napi(getter)]
  pub fn get_font_bounding_box_ascent(&self) -> f64 {
    self.font_bounding_box_ascent
  }

  #[napi(getter)]
  pub fn get_font_bounding_box_descent(&self) -> f64 {
    self.font_bounding_box_descent
  }

  #[napi(getter)]
  pub fn get_actual_bounding_box_ascent(&self) -> f64 {
    self.actual_bounding_box_ascent
  }

  #[napi(getter)]
  pub fn get_actual_bounding_box_descent(&self) -> f64 {
    self.actual_bounding_box_descent
  }

  #[napi(getter)]
  pub fn get_hanging_baseline(&self) -> f64 {
    self.hanging_baseline
  }

  #[napi(getter)]
  pub fn get_alphabetic_baseline(&self) -> f64 {
    self.alphabetic_baseline
  }

  #[napi(getter)]
  pub fn get_ideographic_baseline(&self) -> f64 {
    self.ideographic_baseline
  }

  #[napi(getter)]
  pub fn get_em_height_ascent(&self) -> f64 {
    self.em_height_ascent
  }

  #[napi(getter)]
  pub fn get_em_height_descent(&self) -> f64 {
    self.em_height_descent
  }
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
  Avif(Vec<u8>),
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
      .read_pixels(AlphaType::Unpremultiplied, image.color_space())
      .ok_or_else(|| {
        Error::new(
          Status::GenericFailure,
          "Get avif data from surface failed".to_string(),
        )
      })
      .and_then(|pixels| {
        crate::avif::encode(&pixels, *width, *height, config, image.color_space())
          .map(ContextOutputData::Avif)
          .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))
      }),
    ContextData::Gif(image, config, width, height) => image
      .read_pixels(AlphaType::Unpremultiplied, ColorSpace::Srgb)
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

/// Blink AffineTransform::IsInvertible (affine_transform.cc:63-69): a normal
/// determinant, computed in double. From f32 entries a non-zero determinant
/// is never subnormal in double, so finite and non-zero is the same test.
fn matrix_is_invertible(m: &Matrix) -> bool {
  let t = m.get_transform();
  let det = t.a as f64 * t.d as f64 - t.b as f64 * t.c as f64;
  det.is_finite() && det != 0.0
}

/// Blink AffineTransform::Inverse (affine_transform.cc:71-95) in double, as
/// [a, b, c, d, e, f]: a translation is negated exactly. Only for an
/// invertible matrix.
fn blink_inverse_values(m: &Matrix) -> [f64; 6] {
  let t = m.get_transform();
  let [a, b, c, d, e, f] = [t.a, t.b, t.c, t.d, t.e, t.f].map(f64::from);
  if a == 1.0 && b == 0.0 && c == 0.0 && d == 1.0 {
    return [1.0, 0.0, 0.0, 1.0, -e, -f];
  }
  let det = a * d - b * c;
  [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ]
}

/// [`blink_inverse_values`] as a float matrix.
fn blink_inverse(m: &Matrix) -> Matrix {
  let [a, b, c, d, e, f] = blink_inverse_values(m).map(|v| v as f32);
  // Matrix::new takes SkMatrix order: scaleX, skewX, transX, skewY, scaleY, transY.
  Matrix::new(a, c, e, b, d, f)
}

/// The point (x, y) through the double inverse of `m`, as Blink's
/// AffineTransform::MapPoint (affine_transform.cc), then ClampTo<float>.
fn blink_inverse_map(m: &Matrix, x: f32, y: f32) -> (f32, f32) {
  let [a, b, c, d, e, f] = blink_inverse_values(m);
  let (x, y) = (f64::from(x), f64::from(y));
  (
    clamp_to_f32(a * x + c * y + e),
    clamp_to_f32(b * x + d * y + f),
  )
}

/// Blink's radius check for arc, arcTo and ellipse (canvas_path.cc), after
/// the finite check: a negative radius throws an IndexSizeError that shows
/// the float value. `name` is "radius", "major-axis radius" or
/// "minor-axis radius".
pub(crate) fn check_radius(
  env: sys::napi_env,
  prefix: &str,
  name: &str,
  radius: f32,
) -> Result<()> {
  if radius < 0.0 {
    return Err(webidl::dom_exception(
      env,
      "IndexSizeError",
      &format!(
        "{prefix}The {name} provided ({}) is negative.",
        webidl::number_to_string(f64::from(radius))
      ),
    ));
  }
  Ok(())
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
      .get_image_data(x as i32, y as i32, 1, 1, ColorSpace::default())
      .expect("pixels");
    [data[0], data[1], data[2], data[3]]
  }

  // ImageData buffers: a failed allocation is None (a RangeError in JS), not
  // a process abort.
  #[test]
  fn zeroed_pixel_buffers_report_allocation_failure() {
    assert_eq!(crate::sk::try_zeroed_bytes(8), Some(vec![0; 8]));
    assert_eq!(crate::sk::try_zeroed_bytes(0), Some(Vec::new()));
    assert_eq!(crate::sk::try_zeroed_bytes(isize::MAX as usize), None);
    assert_eq!(crate::sk::try_zeroed_bytes(usize::MAX), None);
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
          false,
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
        None,
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
        None,
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
        None,
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
        None,
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
        None,
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

  // An Image's decode levels (Chrome's decode cache) are made once per level,
  // shared with the Image's patterns, kept within the image's own size, and
  // not made on PDF or SVG, which draw the original image.
  #[test]
  fn image_decode_levels_are_cached_once_per_level() {
    use crate::sk::{ImagePatternBacking, ImagePatternShared, SvgExportFlag, TileMode};
    use std::ptr;
    use std::sync::{Arc, Mutex};

    let image = Arc::new(AccountedBitmap::new(
      test_bitmap(256, 256, [10, 20, 30, 255]),
      ptr::null_mut(),
      0,
    ));
    let key = RasterKey::Resource {
      id: image.resource_id,
      generation: 0,
    };
    let draw = |ctx: &mut Context, src: (f32, f32, f32, f32), size: f32| {
      ctx
        .draw_image(
          &image.inner,
          Some(&image),
          key,
          src.0,
          src.1,
          src.2,
          src.3,
          0.0,
          0.0,
          size,
          size,
        )
        .unwrap();
    };
    let mut ctx = raster_ctx(64, 64);
    // 256 -> 64 picks level 2 (64x64); drawing it again reuses it.
    draw(&mut ctx, (0.0, 0.0, 256.0, 256.0), 64.0);
    assert_eq!(image.level_bytes(), 64 * 64 * 4);
    draw(&mut ctx, (0.0, 0.0, 256.0, 256.0), 64.0);
    assert_eq!(image.level_bytes(), 64 * 64 * 4);

    // A pattern over the Image at the same scale samples the same level.
    let pattern = ImagePattern {
      accounting_id: image.resource_id,
      repeat_x: TileMode::Repeat,
      repeat_y: TileMode::Repeat,
      is_canvas: false,
      is_image: true,
      backing_bytes: 256 * 256 * 4,
      backing: Some(ImagePatternBacking::Bitmap(image.clone())),
      shared: Arc::new(Mutex::new(ImagePatternShared {
        transform: Transform::new(0.25, 0.0, 0.0, 0.25, 0.0, 0.0),
        image: None,
        shader: None,
      })),
    };
    assert!(
      pattern
        .get_shader(
          FilterQuality::Low,
          Some((Transform::default(), ColorSpace::Srgb))
        )
        .is_some()
    );
    assert_eq!(image.level_bytes(), 64 * 64 * 4);

    // 256 -> 128 picks level 1 (128x128).
    draw(&mut ctx, (0.0, 0.0, 256.0, 256.0), 128.0);
    assert_eq!(image.level_bytes(), (64 * 64 + 128 * 128) * 4);

    // PDF and SVG keep the original image.
    let fresh = AccountedBitmap::new(test_bitmap(256, 256, [10, 20, 30, 255]), ptr::null_mut(), 0);
    let mut svg = Context::new_svg(
      64,
      64,
      SvgExportFlag::ConvertTextToPaths,
      ColorSpace::default(),
    )
    .expect("svg context");
    svg
      .draw_image(
        &fresh.inner,
        Some(&fresh),
        key,
        0.0,
        0.0,
        256.0,
        256.0,
        0.0,
        0.0,
        64.0,
        64.0,
      )
      .unwrap();
    assert_eq!(fresh.level_bytes(), 0);
  }

  // The cache keeps an Image's levels within the image's own size, but a level
  // it drops still counts while a recorded draw holds it: its bytes are
  // reported until its pixels are freed.
  #[test]
  fn image_decode_levels_count_until_their_last_draw_drops() {
    use std::ptr;

    let image = AccountedBitmap::new(test_bitmap(64, 64, [10, 20, 30, 255]), ptr::null_mut(), 0);
    let key = RasterKey::Resource {
      id: image.resource_id,
      generation: 0,
    };
    let draw = |ctx: &mut Context, x: f32, y: f32| {
      ctx
        .draw_image(
          &image.inner,
          Some(&image),
          key,
          x,
          y,
          60.0,
          60.0,
          0.0,
          0.0,
          30.0,
          30.0,
        )
        .unwrap();
    };
    const LEVEL: i64 = 30 * 30 * 4;
    // Each 60x60 subset drawn at 30x30 makes its own 30x30 level. Four fit in
    // the image's 16384 bytes; the fifth drops the first from the cache, but
    // the recording still holds all five.
    let mut ctx = raster_ctx(32, 32);
    for x in 0..5 {
      draw(&mut ctx, x as f32, 0.0);
    }
    assert_eq!(image.level_bytes(), 5 * LEVEL);
    // More subsets: every level is still held by the recording.
    for y in 1..5 {
      draw(&mut ctx, 0.0, y as f32);
    }
    assert_eq!(image.level_bytes(), 9 * LEVEL);

    // With the recording gone only the cached levels are left, at most the
    // image's own size. A draw of a cached level reports it.
    drop(ctx);
    let mut other = raster_ctx(32, 32);
    draw(&mut other, 0.0, 4.0);
    assert_eq!(image.level_bytes(), 4 * LEVEL);
  }

  // A recorded draw keeps the decode level it drew after its Image is
  // dropped. V8 is told the level is freed only when its pixels are.
  #[test]
  fn a_recorded_level_stays_reported_after_its_image_drops() {
    use crate::sk::reported_level_bytes;
    use std::ptr;

    const LEVEL: i64 = 32 * 32 * 4;
    let before = reported_level_bytes();
    let image = AccountedBitmap::new(test_bitmap(64, 64, [10, 20, 30, 255]), ptr::null_mut(), 0);
    let mut ctx = raster_ctx(32, 32);
    // 64 -> 32 draws the 32x32 level.
    ctx
      .draw_image(
        &image.inner,
        Some(&image),
        RasterKey::Resource {
          id: image.resource_id,
          generation: 0,
        },
        0.0,
        0.0,
        64.0,
        64.0,
        0.0,
        0.0,
        32.0,
        32.0,
      )
      .unwrap();
    assert_eq!(reported_level_bytes() - before, LEVEL);
    // The recording still holds the level.
    drop(image);
    assert_eq!(reported_level_bytes() - before, LEVEL);
    // It is freed with the recording.
    drop(ctx);
    assert_eq!(reported_level_bytes() - before, 0);
  }

  // drawImage does not use fillStyle, so an Image pattern set as fillStyle
  // makes no decode level of its Image.
  #[test]
  fn draw_image_makes_no_level_for_an_image_pattern_fill() {
    use crate::sk::{ImagePatternBacking, ImagePatternShared, TileMode};
    use std::ptr;
    use std::sync::{Arc, Mutex};

    let image = Arc::new(AccountedBitmap::new(
      test_bitmap(64, 64, [10, 20, 30, 255]),
      ptr::null_mut(),
      0,
    ));
    let mut ctx = raster_ctx(16, 16);
    // At this scale a fill would draw the pattern from its 16x16 level.
    ctx.state.fill_style = Pattern::Image(ImagePattern {
      accounting_id: image.resource_id,
      repeat_x: TileMode::Repeat,
      repeat_y: TileMode::Repeat,
      is_canvas: false,
      is_image: true,
      backing_bytes: 64 * 64 * 4,
      backing: Some(ImagePatternBacking::Bitmap(image.clone())),
      shared: Arc::new(Mutex::new(ImagePatternShared {
        transform: Transform::new(0.25, 0.0, 0.0, 0.25, 0.0, 0.0),
        image: None,
        shader: None,
      })),
    });
    let src = raster_ctx(8, 8);
    let bitmap = src.surface.get_bitmap();
    ctx
      .draw_image(
        &bitmap,
        None,
        canvas_source_key(&src),
        0.0,
        0.0,
        8.0,
        8.0,
        0.0,
        0.0,
        8.0,
        8.0,
      )
      .unwrap();
    assert_eq!(image.level_bytes(), 0);
    // A fill does draw the level.
    ctx.fill_rect(0.0, 0.0, 16.0, 16.0).unwrap();
    assert_eq!(image.level_bytes(), 16 * 16 * 4);
  }

  // A recorded draw holds the decode level it drew, so each level counts
  // toward the recording limit: many distinct source rects trip it, and the
  // levels alive stay within the limit plus the cache's own share.
  #[test]
  fn recorded_decode_levels_count_toward_the_recording_limit() {
    use std::ptr;

    const IMAGE: usize = 128 * 128 * 4;
    const LEVEL: usize = 50 * 50 * 4;
    const LIMIT: usize = 2 * IMAGE;
    let image = AccountedBitmap::new(test_bitmap(128, 128, [10, 20, 30, 255]), ptr::null_mut(), 0);
    let key = RasterKey::Resource {
      id: image.resource_id,
      generation: 0,
    };
    let mut ctx = raster_ctx(64, 64);
    set_recording_limit(&ctx, LIMIT);
    // Each 100x100 subset drawn at 50x50 makes its own 50x50 level.
    for i in 0..64 {
      ctx
        .draw_image(
          &image.inner,
          Some(&image),
          key,
          (i % 8) as f32,
          (i / 8) as f32,
          100.0,
          100.0,
          0.0,
          0.0,
          50.0,
          50.0,
        )
        .unwrap();
      assert!(
        image.level_bytes() as usize <= LIMIT + IMAGE + LEVEL,
        "draw {i}: {} bytes of levels alive",
        image.level_bytes()
      );
    }
    assert!(consolidations(&ctx) >= 1);
  }

  // A canvas source on a display-p3 canvas is drawn from a level made for
  // that one draw, which the recording holds: every draw charges its own.
  #[test]
  fn canvas_source_decode_levels_are_charged_per_draw() {
    let src = raster_ctx(64, 64);
    let bitmap = src.surface.get_bitmap();
    let mut ctx = Context::new(32, 32, ColorSpace::DisplayP3).expect("raster context");
    for _ in 0..3 {
      ctx
        .draw_image(
          &bitmap,
          None,
          canvas_source_key(&src),
          0.0,
          0.0,
          64.0,
          64.0,
          0.0,
          0.0,
          32.0,
          32.0,
        )
        .unwrap();
    }
    // The source once, and three 32x32 levels.
    assert_eq!(raster_bytes(&ctx), 64 * 64 * 4 + 3 * 32 * 32 * 4);
  }

  // A cached level drawn again, by the shadow pass too, is one allocation:
  // it is charged once per recording window.
  #[test]
  fn a_cached_decode_level_is_charged_once_per_window() {
    use std::ptr;

    let image = AccountedBitmap::new(test_bitmap(64, 64, [10, 20, 30, 255]), ptr::null_mut(), 0);
    let key = RasterKey::Resource {
      id: image.resource_id,
      generation: 0,
    };
    let mut ctx = raster_ctx(32, 32);
    ctx.set_shadow_color("red".to_owned()).unwrap();
    ctx.state.shadow_offset_x = 2.0;
    for _ in 0..2 {
      ctx
        .draw_image(
          &image.inner,
          Some(&image),
          key,
          0.0,
          0.0,
          64.0,
          64.0,
          0.0,
          0.0,
          32.0,
          32.0,
        )
        .unwrap();
    }
    // The image and its 32x32 level once, and a shadow filter per draw.
    assert_eq!(raster_bytes(&ctx), 64 * 64 * 4 + 32 * 32 * 4 + 2 * 1024);
  }

  // drawImage skips only the unused Image-pattern fillStyle: the filter and
  // the shadow it draws with are charged as under any other fillStyle.
  #[test]
  fn draw_image_with_an_image_pattern_fill_charges_its_filter_and_shadow() {
    use crate::sk::{ImagePatternBacking, ImagePatternShared, TileMode};
    use std::ptr;
    use std::sync::{Arc, Mutex};

    let image = Arc::new(AccountedBitmap::new(
      test_bitmap(64, 64, [10, 20, 30, 255]),
      ptr::null_mut(),
      0,
    ));
    let charged = |pattern_fill: bool| {
      let mut ctx = raster_ctx(16, 16);
      if pattern_fill {
        ctx.state.fill_style = Pattern::Image(ImagePattern {
          accounting_id: image.resource_id,
          repeat_x: TileMode::Repeat,
          repeat_y: TileMode::Repeat,
          is_canvas: false,
          is_image: true,
          backing_bytes: 64 * 64 * 4,
          backing: Some(ImagePatternBacking::Bitmap(image.clone())),
          shared: Arc::new(Mutex::new(ImagePatternShared {
            transform: Transform::default(),
            image: None,
            shader: None,
          })),
        });
      }
      ctx.set_filter("blur(1px)").unwrap();
      ctx.set_shadow_color("red".to_owned()).unwrap();
      ctx.state.shadow_blur = 2.0;
      let src = raster_ctx(8, 8);
      let bitmap = src.surface.get_bitmap();
      ctx
        .draw_image(
          &bitmap,
          None,
          canvas_source_key(&src),
          0.0,
          0.0,
          8.0,
          8.0,
          0.0,
          0.0,
          8.0,
          8.0,
        )
        .unwrap();
      raster_bytes(&ctx)
    };
    // The source, the filter chain and the shadow filter.
    let expected = 8 * 8 * 4 + "blur(1px)".len() * 8 + 1024;
    assert_eq!(charged(false), expected);
    assert_eq!(charged(true), expected);
  }

  // A pattern's new shader can push its old level out of the cache, and the
  // old shader is then the level's last holder: once it is replaced, the
  // level is reported freed.
  #[test]
  fn image_pattern_reports_the_level_its_old_shader_held() {
    use crate::sk::{ImagePatternBacking, ImagePatternShared, TileMode};
    use std::ptr;
    use std::sync::{Arc, Mutex};

    let image = Arc::new(AccountedBitmap::new(
      test_bitmap(64, 64, [10, 20, 30, 255]),
      ptr::null_mut(),
      0,
    ));
    let pattern = ImagePattern {
      accounting_id: image.resource_id,
      repeat_x: TileMode::Repeat,
      repeat_y: TileMode::Repeat,
      is_canvas: false,
      is_image: true,
      backing_bytes: 64 * 64 * 4,
      backing: Some(ImagePatternBacking::Bitmap(image.clone())),
      shared: Arc::new(Mutex::new(ImagePatternShared {
        transform: Transform::default(),
        image: None,
        shader: None,
      })),
    };
    // On a display-p3 canvas the sRGB image is converted: unscaled, the
    // pattern samples a converted copy of the whole image.
    assert!(
      pattern
        .get_shader(
          FilterQuality::Low,
          Some((Transform::default(), ColorSpace::DisplayP3))
        )
        .is_some()
    );
    assert_eq!(image.level_bytes(), 64 * 64 * 4);
    // Halved by the CTM, it samples the 32x32 level. The copy does not fit
    // beside it, so the cache drops the copy, which the old shader held.
    assert!(
      pattern
        .get_shader(
          FilterQuality::Low,
          Some((
            Transform::new(0.5, 0.0, 0.0, 0.5, 0.0, 0.0),
            ColorSpace::DisplayP3
          ))
        )
        .is_some()
    );
    assert_eq!(image.level_bytes(), 32 * 32 * 4);
  }

  /// An Image-pattern fillStyle over `image`, a 64x64 Image.
  fn image_pattern_fill(image: &std::sync::Arc<AccountedBitmap>) -> Pattern {
    use crate::sk::{ImagePatternBacking, ImagePatternShared, TileMode};
    use std::sync::{Arc, Mutex};

    Pattern::Image(ImagePattern {
      accounting_id: image.resource_id,
      repeat_x: TileMode::Repeat,
      repeat_y: TileMode::Repeat,
      is_canvas: false,
      is_image: true,
      backing_bytes: 64 * 64 * 4,
      backing: Some(ImagePatternBacking::Bitmap(image.clone())),
      shared: Arc::new(Mutex::new(ImagePatternShared {
        transform: Transform::default(),
        image: None,
        shader: None,
      })),
    })
  }

  // A recorded fill holds the decode level its Image pattern samples, so each
  // level counts toward the recording limit. On a display-p3 canvas the cache
  // cannot keep both the converted copy and the half-size level, so cycling
  // the CTM between them makes a new one on every fill.
  #[test]
  fn image_pattern_decode_levels_count_toward_the_recording_limit() {
    use std::ptr;
    use std::sync::Arc;

    const IMAGE: usize = 64 * 64 * 4;
    const LIMIT: usize = 4 * IMAGE;
    let image = Arc::new(AccountedBitmap::new(
      test_bitmap(64, 64, [10, 20, 30, 255]),
      ptr::null_mut(),
      0,
    ));
    let mut ctx = Context::new(16, 16, ColorSpace::DisplayP3).expect("raster context");
    set_recording_limit(&ctx, LIMIT);
    ctx.state.fill_style = image_pattern_fill(&image);
    for i in 0..64 {
      let scale = if i % 2 == 0 { 1.0 } else { 0.5 };
      ctx.set_transform(Matrix::new(scale, 0.0, 0.0, 0.0, scale, 0.0));
      ctx.fill_rect(0.0, 0.0, 16.0, 16.0).unwrap();
      assert!(
        image.level_bytes() as usize <= LIMIT + 2 * IMAGE,
        "fill {i}: {} bytes of levels alive",
        image.level_bytes()
      );
    }
    assert!(consolidations(&ctx) >= 1);
  }

  // A level an Image pattern samples again is the same allocation: it is
  // charged once per recording window, like a drawImage level.
  #[test]
  fn an_image_pattern_level_is_charged_once_per_window() {
    use std::ptr;
    use std::sync::Arc;

    let image = Arc::new(AccountedBitmap::new(
      test_bitmap(64, 64, [10, 20, 30, 255]),
      ptr::null_mut(),
      0,
    ));
    let mut ctx = raster_ctx(16, 16);
    ctx.state.fill_style = image_pattern_fill(&image);
    for scale in [0.5, 0.25, 0.5] {
      ctx.set_transform(Matrix::new(scale, 0.0, 0.0, 0.0, scale, 0.0));
      ctx.fill_rect(0.0, 0.0, 16.0, 16.0).unwrap();
    }
    // The image, and its 32x32 and 16x16 levels once each.
    assert_eq!(raster_bytes(&ctx), 64 * 64 * 4 + (32 * 32 + 16 * 16) * 4);
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
      .draw_image(
        &src_bitmap,
        None,
        key,
        0.0,
        0.0,
        8.0,
        8.0,
        0.0,
        0.0,
        0.0,
        8.0,
      )
      .unwrap();
    let bitmap = test_bitmap(8, 8, [255, 0, 0, 255]);
    ctx
      .draw_image(&bitmap, None, key, 0.0, 0.0, 8.0, 8.0, 0.0, 0.0, 8.0, 0.0)
      .unwrap();
    // Source rects that miss the 8x8 image, or only touch its edge: Blink's
    // ClipRectsToImageRect leaves nothing, so the native draw returns early.
    ctx
      .draw_image(&bitmap, None, key, 20.0, 0.0, 4.0, 4.0, 0.0, 0.0, 8.0, 8.0)
      .unwrap();
    ctx
      .draw_image(&bitmap, None, key, 8.0, 0.0, 4.0, 8.0, 0.0, 0.0, 8.0, 8.0)
      .unwrap();
    ctx
      .draw_image(
        &src_bitmap,
        None,
        key,
        0.0,
        -10.0,
        8.0,
        4.0,
        0.0,
        0.0,
        8.0,
        8.0,
      )
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

  // Image draws never read fillStyle or the line dash, so they charge neither:
  // only the source's pixels (drawImage) or picture payload (drawCanvas), plus
  // the filter and shadow their paint does carry.
  #[test]
  fn image_draws_do_not_charge_fill_style_or_dash() {
    const GRADIENT_BYTES: usize = 1000 * 32 + 256;
    const DASH_BYTES: usize = 2 * 4;
    const SHADOW_BYTES: usize = 1024;
    const FILTER_BYTES: usize = "blur(1px)".len() * 8;
    let with_unused_state = || {
      let mut ctx = raster_ctx(16, 16);
      let mut gradient = Gradient::create_linear_gradient(0.0, 0.0, 16.0, 0.0);
      for i in 0..1000 {
        gradient.add_color_stop(
          i as f32 / 999.0,
          crate::sk::Color4f::from_rgba8(255, 0, 0, 255),
        );
      }
      assert_eq!(gradient.estimated_bytes(), GRADIENT_BYTES);
      ctx.state.fill_style = Pattern::Gradient(gradient);
      ctx.state.line_dash_list = vec![2.0, 3.0];
      ctx
    };
    let with_shadow_and_filter = || {
      let mut ctx = with_unused_state();
      ctx.state.shadow_color = RGBA::new(0, 0, 255, 255);
      ctx.state.shadow_offset_x = 2.0;
      ctx.set_filter("blur(1px)").unwrap();
      ctx
    };
    let mut src = raster_ctx(16, 16);
    src.state.fill_style = Pattern::from_color("#ff0000").unwrap();
    src.fill_rect(0.0, 0.0, 16.0, 16.0).unwrap();

    // Sibling: a fill still charges the gradient, the dash, the shadow and the filter.
    let mut fill = with_shadow_and_filter();
    fill.fill_rect(0.0, 0.0, 16.0, 16.0).unwrap();
    assert_eq!(
      raster_bytes(&fill),
      GRADIENT_BYTES + DASH_BYTES + SHADOW_BYTES + FILTER_BYTES
    );

    let mut dest = with_shadow_and_filter();
    let bitmap = src.surface.get_bitmap();
    dest
      .draw_image(
        &bitmap,
        None,
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
    assert_eq!(
      raster_bytes(&dest),
      16 * 16 * 4 + SHADOW_BYTES + FILTER_BYTES
    );

    let mut dest = with_unused_state();
    let bitmap = src.surface.get_bitmap();
    dest
      .draw_image(
        &bitmap,
        None,
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
    assert_eq!(raster_bytes(&dest), 16 * 16 * 4);

    let mut dest = with_unused_state();
    let picture = src.get_picture().expect("source picture");
    dest
      .draw_canvas(&picture, 0, 0.0, 0.0, 16.0, 16.0, 0.0, 0.0, 16.0, 16.0)
      .unwrap();
    assert_eq!(raster_bytes(&dest), 0);
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
          false,
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
    // Skia order (scaleX, skewX, transX, skewY, scaleY, transY): x scaled by
    // -1e-30. The CTM must stay invertible, or nothing is drawn at all, as in
    // Blink's Draw.
    ctx.set_transform(Matrix::new(-1e-30, 0.0, 0.0, 0.0, 1.0, 0.0));
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
          false,
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
    ctx.get_line_metrics("measure me", false).unwrap();
    assert_eq!(pending(&ctx), pending0);
    assert_eq!(raster_bytes(&ctx), raster0);
    assert_eq!(ctx.content_version(), version0);
  }

  // measureText never reads the glyph ink, so it must not pay for the walk
  // that finds it: the ink comes back empty.
  #[test]
  fn measure_text_skips_the_ink_walk() {
    {
      let fonts = get_font().unwrap();
      fonts.register_from_path::<String>("__test__/fonts/Lato-Regular.ttf", None);
    }
    let mut ctx = raster_ctx(64, 64);
    ctx.set_font("16px Lato".to_owned()).unwrap();
    let measured = ctx.get_line_metrics("Hgjy", false).unwrap().0;
    assert_eq!((measured.ink_left, measured.ink_right), (0.0, 0.0));
    // The alpha:false reset asks for it and gets the glyphs; the rest of the
    // metrics are the same either way.
    let with_ink = ctx.get_line_metrics("Hgjy", true).unwrap().0;
    assert!(with_ink.ink_right > with_ink.ink_left && with_ink.ink_right > 0.0);
    let rest = |m: &crate::sk::ffi::skiac_line_metrics| {
      (
        m.ascent,
        m.descent,
        m.left,
        m.right,
        m.width,
        m.font_ascent,
        m.font_descent,
        m.alphabetic_baseline,
      )
    };
    assert_eq!(rest(&with_ink), rest(&measured));
  }

  // Blink's Draw returns before anything is recorded when the CTM is singular
  // (canvas_2d_recorder_context.h:866-868), and so do we; such a draw must not
  // charge the recording for an op it never records. The shadow makes every
  // draw charge its 1 KiB shadow filter on top of its own payload.
  #[test]
  fn singular_transform_draws_charge_nothing() {
    {
      let fonts = get_font().unwrap();
      fonts.register_from_path::<String>("__test__/fonts/Lato-Regular.ttf", None);
    }
    let mut src = raster_ctx(8, 8);
    src.fill_rect(0.0, 0.0, 8.0, 8.0).unwrap();
    let picture = src.get_picture().expect("source picture");
    let bitmap = test_bitmap(4, 4, [255, 0, 0, 255]);

    let mut ctx = raster_ctx(16, 16);
    ctx.set_font("16px Lato".to_owned()).unwrap();
    ctx.state.shadow_offset_x = 2.0;
    // Skia order (scaleX, skewX, transX, skewY, scaleY, transY): x scaled by 0.
    ctx.set_transform(Matrix::new(0.0, 0.0, 0.0, 0.0, 1.0, 0.0));
    ctx.path.add_rect(1.0, 1.0, 9.0, 9.0);
    let pending0 = pending(&ctx);
    let raster0 = raster_bytes(&ctx);
    let version0 = ctx.content_version();
    ctx.fill_rect(1.0, 1.0, 8.0, 8.0).unwrap();
    ctx.stroke_rect(1.0, 1.0, 8.0, 8.0).unwrap();
    ctx.fill(None, FillType::Winding).unwrap();
    ctx.stroke(None).unwrap();
    ctx
      .draw_image(
        &bitmap,
        None,
        RasterKey::Resource {
          id: u64::MAX,
          generation: 0,
        },
        0.0,
        0.0,
        4.0,
        4.0,
        0.0,
        0.0,
        4.0,
        4.0,
      )
      .unwrap();
    ctx
      .draw_canvas(&picture, 4096, 0.0, 0.0, 8.0, 8.0, 0.0, 0.0, 8.0, 8.0)
      .unwrap();
    ctx.fill_text("hello", 0.0, 12.0, MAX_TEXT_WIDTH).unwrap();
    ctx.stroke_text("hello", 0.0, 12.0, MAX_TEXT_WIDTH).unwrap();
    ctx.clear_rect(0.0, 0.0, 4.0, 4.0).unwrap();
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
