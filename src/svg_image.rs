//! An SVG `Image`. Chrome keeps an SVG image as a document and draws it as
//! vectors at each use, sized by the canvas it is drawn on
//! (image_element_base.cc GetSourceImageForCanvas, svg_image.cc
//! DrawForContainer). Here each drawImage or createPattern draws a raster of
//! the document made at the size it is drawn at, and keeps the last few.

use std::sync::Arc;

use napi::Env;

use crate::global_fonts::{font_collection_generation, get_font};
use crate::sk::{AccountedBitmap, ColorSpace, SvgDocument, SvgRootAttribute, Transform};
use crate::svg_doc::{self, PrepareError};
use crate::svg_size::{FontUnits, SvgSizing, layout_floor};

/// Rasters an SVG Image keeps for later draws.
const CACHED_RASTERS: usize = 4;

/// The largest raster made for one draw, in pixels; a bigger draw rasters
/// only the part near the canvas.
const RASTER_BUDGET: f32 = 4096.0 * 4096.0;

/// Device pixels kept around the canvas when a draw is cut down to it, for
/// shadows and filters that reach in from outside.
const RASTER_MARGIN: f32 = 256.0;

/// How a raster is made: the document laid out at `layout`, clipped to
/// `view`, mapped by `[sx 0 tx; 0 sy ty]` and clipped to `clip` in a
/// `width` x `height` raster.
#[derive(Debug, Clone, Copy, PartialEq)]
struct RasterSpec {
  layout: (f32, f32),
  view: (f32, f32),
  matrix: [f32; 4],
  clip: [f32; 4],
  width: i32,
  height: i32,
}

pub(crate) struct SvgImage {
  document: SvgDocument,
  pub(crate) sizing: SvgSizing,
  color_space: ColorSpace,
  /// With the font collection generation each was drawn in: a font
  /// registered later can change its text.
  rasters: Vec<(RasterSpec, u64, Arc<AccountedBitmap>)>,
  /// `document.retained_bytes()` as last reported to V8.
  reported: ReportedBytes,
}

/// Bytes reported to V8 through `Env::adjust_external_memory`, given back
/// when dropped (as `AccountedBitmap` does for its pixels).
struct ReportedBytes {
  env: napi::sys::napi_env,
  bytes: i64,
}

impl Drop for ReportedBytes {
  fn drop(&mut self) {
    if self.bytes != 0 && !self.env.is_null() {
      let mut adjusted: i64 = 0;
      unsafe {
        napi::sys::napi_adjust_external_memory(self.env, -self.bytes, &mut adjusted);
      }
    }
  }
}

// An SvgImage is parsed on a decode thread with nothing reported; it reports
// only on the JS thread of the Image that holds it, and is dropped there.
unsafe impl Send for ReportedBytes {}

/// What drawImage draws for an SVG Image: all of `raster` into `dst`
/// (x, y, width, height in the current user space).
pub(crate) struct SvgDraw {
  pub raster: Arc<AccountedBitmap>,
  pub dst: (f32, f32, f32, f32),
}

/// gfx::RectF with the same f32 steps as Blink.
#[derive(Debug, Clone, Copy)]
struct RectF {
  x: f32,
  y: f32,
  w: f32,
  h: f32,
}

impl RectF {
  fn right(&self) -> f32 {
    self.x + self.w
  }

  fn bottom(&self) -> f32 {
    self.y + self.h
  }

  fn is_empty(&self) -> bool {
    self.w <= 0.0 || self.h <= 0.0
  }

  fn contains(&self, other: &RectF) -> bool {
    other.x >= self.x
      && other.right() <= self.right()
      && other.y >= self.y
      && other.bottom() <= self.bottom()
  }

  fn intersect(&self, other: &RectF) -> RectF {
    let x = self.x.max(other.x);
    let y = self.y.max(other.y);
    let right = self.right().min(other.right());
    let bottom = self.bottom().min(other.bottom());
    if x >= right || y >= bottom {
      return RectF {
        x: 0.0,
        y: 0.0,
        w: 0.0,
        h: 0.0,
      };
    }
    RectF {
      x,
      y,
      w: right - x,
      h: bottom - y,
    }
  }
}

/// Blink's ClipRectsToImageRect (canvas_2d_recorder_context.cc).
fn clip_rects_to_image_rect(image: RectF, src: &mut RectF, dst: &mut RectF) {
  if image.contains(src) {
    return;
  }
  let scale_x = dst.w / src.w;
  let scale_y = dst.h / src.h;
  let offset_x = dst.x - src.x * scale_x;
  let offset_y = dst.y - src.y * scale_y;
  *src = src.intersect(&image);
  *dst = RectF {
    x: src.x * scale_x + offset_x,
    y: src.y * scale_y + offset_y,
    w: src.w * scale_x,
    h: src.h * scale_y,
  };
}

impl SvgImage {
  /// None when `data` is not an SVG document (the image fails to load).
  pub(crate) fn parse(data: &[u8], color_space: ColorSpace) -> napi::Result<Option<Self>> {
    let units = {
      let font = get_font().map_err(crate::error::SkError::from)?;
      FontUnits::from_metrics(font.default_font_metrics())
    };
    // Read the way Blink reads it, once per src (crate::svg_doc).
    let prepared = match svg_doc::prepare(data, &units) {
      Ok(prepared) => Some(prepared),
      // Deeper than Chrome's XML parser takes: onerror.
      Err(PrepareError::TooDeep) => return Ok(None),
      // Left to SkSVGDOM as it is.
      Err(PrepareError::Unsupported) => None,
    };
    let font = get_font().map_err(crate::error::SkError::from)?;
    let (document, sizing) = match prepared {
      Some((prepared, root)) => {
        let Some(document) = SvgDocument::parse_prepared(&prepared, &font) else {
          return Ok(None);
        };
        (document, root.sizing(&units))
      }
      None => {
        let Some(document) = SvgDocument::parse(data, &font) else {
          return Ok(None);
        };
        let attribute = |name| document.attribute(name);
        let sizing = SvgSizing::from_attributes(
          attribute(SvgRootAttribute::Width).as_deref(),
          attribute(SvgRootAttribute::Height).as_deref(),
          attribute(SvgRootAttribute::ViewBox).as_deref(),
          attribute(SvgRootAttribute::PreserveAspectRatio).as_deref(),
          &units,
        );
        (document, sizing)
      }
    };
    drop(font);
    Ok(Some(SvgImage {
      document,
      sizing,
      color_space,
      rasters: Vec::new(),
      reported: ReportedBytes {
        env: std::ptr::null_mut(),
        bytes: 0,
      },
    }))
  }

  /// Tells V8 about the change in what the document keeps for its
  /// `<image>` elements (`SvgDocument::retained_bytes`) since the last call.
  pub(crate) fn report_retained_bytes(&mut self, env: &Env) -> napi::Result<()> {
    let bytes = self.document.retained_bytes() as i64;
    let delta = bytes - self.reported.bytes;
    if delta != 0 {
      env.adjust_external_memory(delta)?;
      self.reported.env = env.raw();
      self.reported.bytes = bytes;
    }
    Ok(())
  }

  /// The concrete size against `default_object_size`, or None when it
  /// rounds to an empty size (Chrome then has no image to draw).
  fn concrete(&self, default_object_size: (f32, f32)) -> Option<(f32, f32)> {
    let (width, height) = self.sizing.concrete(default_object_size);
    (width.round() >= 1.0 && height.round() >= 1.0).then_some((width, height))
  }

  /// The raster for `spec`, from the cache or made now.
  fn raster(&mut self, env: &Env, spec: RasterSpec) -> napi::Result<Option<Arc<AccountedBitmap>>> {
    let fonts = font_collection_generation();
    if let Some(index) = self
      .rasters
      .iter()
      .position(|(cached, generation, _)| *cached == spec && *generation == fonts)
    {
      let entry = self.rasters.remove(index);
      let raster = entry.2.clone();
      self.rasters.push(entry);
      return Ok(Some(raster));
    }
    // The document's font lists resolve in the font collection as they draw.
    let font = get_font().map_err(crate::error::SkError::from)?;
    let bitmap = self.document.render(
      spec.layout,
      spec.view,
      spec.matrix,
      spec.clip,
      spec.width,
      spec.height,
      self.color_space,
    );
    drop(font);
    // The render decodes the rasters it draws for the first time.
    self.report_retained_bytes(env)?;
    let Some(bitmap) = bitmap else {
      return Ok(None);
    };
    let bytes = spec.width as i64 * spec.height as i64 * 4;
    env.adjust_external_memory(bytes)?;
    let raster = Arc::new(AccountedBitmap::new(bitmap, env.raw(), bytes));
    if self.rasters.len() == CACHED_RASTERS {
      self.rasters.remove(0);
    }
    self.rasters.push((spec, fonts, raster.clone()));
    Ok(Some(raster))
  }

  /// The tile of createPattern: the image at its concrete size against
  /// `default_object_size` (the canvas size), as Chrome records it
  /// (SVGImage::PopulatePaintRecordForCurrentFrameForContainer). Ok(None)
  /// when that size rounds to empty (createPattern gives null), Ok(Some(None))
  /// when the raster cannot be made.
  pub(crate) fn pattern_raster(
    &mut self,
    env: &Env,
    default_object_size: (f32, f32),
  ) -> napi::Result<Option<Option<Arc<AccountedBitmap>>>> {
    let Some((width, height)) = self.concrete(default_object_size) else {
      return Ok(None);
    };
    let (view_width, view_height) = (width.round(), height.round());
    let spec = RasterSpec {
      layout: (layout_floor(width), layout_floor(height)),
      view: (view_width, view_height),
      matrix: [1.0, 1.0, 0.0, 0.0],
      clip: [0.0, 0.0, view_width, view_height],
      width: view_width.min(i32::MAX as f32) as i32,
      height: view_height.min(i32::MAX as f32) as i32,
    };
    self.raster(env, spec).map(Some)
  }

  /// drawImage(image, ...numbers) on a `canvas_size` canvas under `ctm`.
  /// None draws nothing.
  pub(crate) fn plan_draw(
    &mut self,
    env: &Env,
    numbers: &[f64],
    canvas_size: (u32, u32),
    ctm: &Transform,
  ) -> napi::Result<Option<SvgDraw>> {
    // The canvas is the default object size (canvas_2d_recorder_context.cc
    // drawImage).
    let canvas = (canvas_size.0 as f32, canvas_size.1 as f32);
    let Some((width, height)) = self.concrete(canvas) else {
      return Ok(None);
    };
    let (concrete_width, concrete_height) = (width as f64, height as f64);
    let (sx, sy, sw, sh, dx, dy, dw, dh) = match *numbers {
      [dx, dy] => (
        0.0,
        0.0,
        concrete_width,
        concrete_height,
        dx,
        dy,
        concrete_width,
        concrete_height,
      ),
      [dx, dy, dw, dh] => (0.0, 0.0, concrete_width, concrete_height, dx, dy, dw, dh),
      [sx, sy, sw, sh, dx, dy, dw, dh] => (sx, sy, sw, sh, dx, dy, dw, dh),
      _ => return Ok(None),
    };
    let (sx, sy, sw, sh) = crate::ctx::Context::adjust_rect_for_canvas(sx, sy, sw, sh);
    let (dx, dy, dw, dh) = crate::ctx::Context::adjust_rect_for_canvas(dx, dy, dw, dh);
    if !(sw > 0.0 && sh > 0.0 && dw > 0.0 && dh > 0.0)
      || !(sx.is_finite() && sy.is_finite() && dx.is_finite() && dy.is_finite())
      || !(sw.is_finite() && sh.is_finite() && dw.is_finite() && dh.is_finite())
    {
      return Ok(None);
    }
    let mut src = RectF {
      x: sx,
      y: sy,
      w: sw,
      h: sh,
    };
    let mut dst = RectF {
      x: dx,
      y: dy,
      w: dw,
      h: dh,
    };
    let image = RectF {
      x: 0.0,
      y: 0.0,
      w: width,
      h: height,
    };
    clip_rects_to_image_rect(image, &mut src, &mut dst);
    if src.is_empty() || dst.is_empty() {
      return Ok(None);
    }
    // The picture is the rounded view with the root laid out at the
    // concrete size; the source size is scaled to it, not its origin
    // (SVGImage::DrawForContainer).
    let (view_width, view_height) = (width.round(), height.round());
    let picture_width = src.w * (view_width / width);
    let picture_height = src.h * (view_height / height);
    // Picture to destination (SkM44::RectToRect).
    let scale_x = dst.w / picture_width;
    let scale_y = dst.h / picture_height;
    let translate_x = dst.x - src.x * scale_x;
    let translate_y = dst.y - src.y * scale_y;
    // The root is laid out at the concrete size (floored to a LayoutUnit)
    // and fills the rounded view: measured in Chrome 155, a 10.6 wide root
    // drawn 1100 wide is red up to 1100, and drawn 10.6 wide ends with the
    // alpha of two anti-aliased edges, the root's and the view clip's.
    let view = (view_width, view_height);
    let layout = (layout_floor(width), layout_floor(height));

    let Transform { a, b, c, d, e, f } = *ctm;
    // A scale and a translation: draw in device pixels, clipped (aliased) to
    // the destination rect rounded out, like Chrome's vector draw.
    let device_draw = || {
      if !(b == 0.0 && c == 0.0 && a > 0.0 && d > 0.0) {
        return None;
      }
      let left = dst.x.floor();
      let top = dst.y.floor();
      let right = dst.right().ceil();
      let bottom = dst.bottom().ceil();
      let clip = [a * left + e, d * top + f, a * right + e, d * bottom + f];
      let mut window = [
        clip[0].floor(),
        clip[1].floor(),
        clip[2].ceil(),
        clip[3].ceil(),
      ];
      if (window[2] - window[0]) * (window[3] - window[1]) > RASTER_BUDGET {
        window = [
          window[0].max(-RASTER_MARGIN),
          window[1].max(-RASTER_MARGIN),
          window[2].min(canvas.0 + RASTER_MARGIN),
          window[3].min(canvas.1 + RASTER_MARGIN),
        ];
      }
      let raster_width = window[2] - window[0];
      let raster_height = window[3] - window[1];
      if !(raster_width >= 1.0 && raster_height >= 1.0)
        || raster_width * raster_height > RASTER_BUDGET * 4.0
      {
        return None;
      }
      let spec = RasterSpec {
        layout,
        view,
        matrix: [
          a * scale_x,
          d * scale_y,
          a * translate_x + e - window[0],
          d * translate_y + f - window[1],
        ],
        clip: [
          clip[0] - window[0],
          clip[1] - window[1],
          clip[2] - window[0],
          clip[3] - window[1],
        ],
        width: raster_width as i32,
        height: raster_height as i32,
      };
      let draw_rect = (
        (window[0] - e) / a,
        (window[1] - f) / d,
        raster_width / a,
        raster_height / d,
      );
      Some((spec, draw_rect))
    };
    // Rotated, skewed, flipped or too big: a raster at the device scale of
    // the destination (at most RASTER_BUDGET pixels), drawn through the
    // transform.
    let scaled_draw = || {
      let device_x = (a * a + b * b).sqrt();
      let device_y = (c * c + d * d).sqrt();
      let mut raster_width = (dst.w * device_x - 1e-3).ceil().max(1.0);
      let mut raster_height = (dst.h * device_y - 1e-3).ceil().max(1.0);
      let area = raster_width * raster_height;
      if !area.is_finite() {
        return None;
      }
      if area > RASTER_BUDGET {
        let shrink = (RASTER_BUDGET / area).sqrt();
        raster_width = (raster_width * shrink).ceil().max(1.0);
        raster_height = (raster_height * shrink).ceil().max(1.0);
      }
      let to_raster_x = raster_width / picture_width;
      let to_raster_y = raster_height / picture_height;
      let spec = RasterSpec {
        layout,
        view,
        matrix: [
          to_raster_x,
          to_raster_y,
          -src.x * to_raster_x,
          -src.y * to_raster_y,
        ],
        clip: [0.0, 0.0, raster_width, raster_height],
        width: raster_width as i32,
        height: raster_height as i32,
      };
      Some((spec, (dst.x, dst.y, dst.w, dst.h)))
    };
    let Some((spec, draw_rect)) = device_draw().or_else(scaled_draw) else {
      return Ok(None);
    };
    Ok(self.raster(env, spec)?.map(|raster| SvgDraw {
      raster,
      dst: draw_rect,
    }))
  }
}
