//! An SVG `Image`. Chrome keeps an SVG image as a document and draws it as
//! vectors at each use, sized by the canvas it is drawn on
//! (image_element_base.cc GetSourceImageForCanvas, svg_image.cc
//! DrawForContainer). Here each drawImage or createPattern draws a raster of
//! the document made at the size it is drawn at, and keeps the last few.

use std::sync::Arc;

use napi::Env;

use crate::global_fonts::get_font;
use crate::sk::{AccountedBitmap, ColorSpace, SvgDocument, SvgRootAttribute, Transform};
use crate::svg_size::{FontUnits, SvgSizing, layout_floor};

/// Rasters an SVG Image keeps for later draws.
const CACHED_RASTERS: usize = 4;

/// The largest raster made for one draw, in pixels; a bigger draw rasters
/// only the part its output on the canvas reads.
const RASTER_BUDGET: f32 = 4096.0 * 4096.0;

/// Device pixels kept around the canvas when a draw is cut down to it, and
/// the step that part grows by for a shadow or filter that reaches further.
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
  rasters: Vec<(RasterSpec, Arc<AccountedBitmap>)>,
}

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
  /// None when `data` is not an SVG document.
  pub(crate) fn parse(data: &[u8], color_space: ColorSpace) -> napi::Result<Option<Self>> {
    let font = get_font().map_err(crate::error::SkError::from)?;
    let Some(document) = SvgDocument::parse(data, &font) else {
      return Ok(None);
    };
    let units = FontUnits::from_metrics(font.default_font_metrics());
    drop(font);
    let attribute = |name| document.attribute(name);
    let sizing = SvgSizing::from_attributes(
      attribute(SvgRootAttribute::Width).as_deref(),
      attribute(SvgRootAttribute::Height).as_deref(),
      attribute(SvgRootAttribute::ViewBox).as_deref(),
      attribute(SvgRootAttribute::PreserveAspectRatio).as_deref(),
      &units,
    );
    Ok(Some(SvgImage {
      document,
      sizing,
      color_space,
      rasters: Vec::new(),
    }))
  }

  /// The concrete size against `default_object_size`, or None when it
  /// rounds to an empty size (Chrome then has no image to draw).
  fn concrete(&self, default_object_size: (f32, f32)) -> Option<(f32, f32)> {
    let (width, height) = self.sizing.concrete(default_object_size);
    (width.round() >= 1.0 && height.round() >= 1.0).then_some((width, height))
  }

  /// The raster for `spec`, from the cache or made now.
  fn raster(&mut self, env: &Env, spec: RasterSpec) -> napi::Result<Option<Arc<AccountedBitmap>>> {
    if let Some(index) = self.rasters.iter().position(|(cached, _)| *cached == spec) {
      let entry = self.rasters.remove(index);
      let raster = entry.1.clone();
      self.rasters.push(entry);
      return Ok(Some(raster));
    }
    let Some(bitmap) = self.document.render(
      spec.layout,
      spec.view,
      spec.matrix,
      spec.clip,
      spec.width,
      spec.height,
      self.color_space,
    ) else {
      return Ok(None);
    };
    let bytes = spec.width as i64 * spec.height as i64 * 4;
    env.adjust_external_memory(bytes)?;
    let raster = Arc::new(AccountedBitmap::new(bitmap, env.raw(), bytes));
    if self.rasters.len() == CACHED_RASTERS {
      self.rasters.remove(0);
    }
    self.rasters.push((spec, raster.clone()));
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
  /// `source_bounds` is the device rect the draw reads from, its shadow and
  /// filter included (`Context::image_source_bounds`); None when that cannot
  /// be bounded. None draws nothing.
  pub(crate) fn plan_draw(
    &mut self,
    env: &Env,
    numbers: &[f64],
    canvas_size: (u32, u32),
    ctm: &Transform,
    source_bounds: Option<[f32; 4]>,
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
    // The device rect a draw too big to raster whole reads: the canvas and
    // RASTER_MARGIN around it, grown in RASTER_MARGIN steps on each side where
    // its shadow and filter reach further. A nearer reach keeps the part, and
    // so the cached raster, of the draw without one, and a changing reach
    // makes a new raster only when it crosses a step. None when the reach
    // cannot be bounded.
    let read = source_bounds.map(|[left, top, right, bottom]| {
      let margin = |reach: f32| (reach / RASTER_MARGIN).ceil().max(1.0) * RASTER_MARGIN;
      [
        -margin(-left),
        -margin(-top),
        canvas.0 + margin(right - canvas.0),
        canvas.1 + margin(bottom - canvas.1),
      ]
    });
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
        // Only the part the draw reads. A reach that cannot be bounded takes
        // scaled_draw.
        let read = read?;
        window = [
          window[0].max(read[0]),
          window[1].max(read[1]),
          window[2].min(read[2]),
          window[3].min(read[3]),
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
    // the destination, drawn through the transform.
    let scaled_draw = || {
      // Device pixels per user unit on each axis of the image: the length of
      // the axis on the device. Under a skew that keeps the columns (rows) of
      // the image on device columns (rows), their device spacing instead, the
      // horizontal (vertical) part of the axis, so that they stay on the
      // device pixel grid. For a scale both are the same number.
      let device_x = (a * a + if c == 0.0 { 0.0 } else { b * b }).sqrt();
      let device_y = (if b == 0.0 { 0.0 } else { c * c } + d * d).sqrt();
      let mut raster_width = (dst.w * device_x - 1e-3).ceil().max(1.0);
      let mut raster_height = (dst.h * device_y - 1e-3).ceil().max(1.0);
      let area = raster_width * raster_height;
      if !area.is_finite() {
        return None;
      }
      // Over RASTER_BUDGET pixels, only the part of the raster that covers
      // what the draw reads, at most RASTER_BUDGET * 4 pixels like
      // device_draw's: the device corners of `read` taken back to user
      // space, in raster pixels, grown out to RASTER_MARGIN steps so that a
      // draw moved or turned a little keeps the cached raster.
      let part = || {
        let read = read?;
        let (a64, b64, c64, d64) = (a as f64, b as f64, c as f64, d as f64);
        let det = a64 * d64 - b64 * c64;
        if det == 0.0 {
          return None;
        }
        let per_unit_x = raster_width as f64 / dst.w as f64;
        let per_unit_y = raster_height as f64 / dst.h as f64;
        let mut bounds = [
          f64::INFINITY,
          f64::INFINITY,
          f64::NEG_INFINITY,
          f64::NEG_INFINITY,
        ];
        for (x, y) in [
          (read[0], read[1]),
          (read[2], read[1]),
          (read[0], read[3]),
          (read[2], read[3]),
        ] {
          let (x, y) = (x as f64 - e as f64, y as f64 - f as f64);
          let raster_x = ((d64 * x - c64 * y) / det - dst.x as f64) * per_unit_x;
          let raster_y = ((a64 * y - b64 * x) / det - dst.y as f64) * per_unit_y;
          bounds = [
            bounds[0].min(raster_x),
            bounds[1].min(raster_y),
            bounds[2].max(raster_x),
            bounds[3].max(raster_y),
          ];
        }
        let step = RASTER_MARGIN as f64;
        let part = [
          ((bounds[0] / step).floor() * step).max(0.0),
          ((bounds[1] / step).floor() * step).max(0.0),
          ((bounds[2] / step).ceil() * step).min(raster_width as f64),
          ((bounds[3] / step).ceil() * step).min(raster_height as f64),
        ];
        let (width, height) = (part[2] - part[0], part[3] - part[1]);
        (width >= 1.0 && height >= 1.0 && width * height <= (RASTER_BUDGET * 4.0) as f64)
          .then_some(part)
      };
      if area > RASTER_BUDGET
        && let Some([left, top, right, bottom]) = part()
      {
        let to_raster_x = raster_width / picture_width;
        let to_raster_y = raster_height / picture_height;
        let spec = RasterSpec {
          layout,
          view,
          matrix: [
            to_raster_x,
            to_raster_y,
            -src.x * to_raster_x - left as f32,
            -src.y * to_raster_y - top as f32,
          ],
          clip: [0.0, 0.0, (right - left) as f32, (bottom - top) as f32],
          width: (right - left) as i32,
          height: (bottom - top) as i32,
        };
        let unit_x = dst.w as f64 / raster_width as f64;
        let unit_y = dst.h as f64 / raster_height as f64;
        let draw_rect = (
          (dst.x as f64 + left * unit_x) as f32,
          (dst.y as f64 + top * unit_y) as f32,
          ((right - left) * unit_x) as f32,
          ((bottom - top) * unit_y) as f32,
        );
        return Some((spec, draw_rect));
      }
      // Otherwise (a reach that cannot be bounded, a part that is empty or
      // still too big) all of it, at the scale that fits RASTER_BUDGET.
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
