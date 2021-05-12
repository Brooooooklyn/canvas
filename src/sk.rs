use std::f32::consts::PI;
use std::ffi::CStr;
use std::ffi::CString;
use std::ops::{Deref, DerefMut};
use std::os::raw::c_char;
use std::ptr;
use std::slice;
use std::str::FromStr;

use crate::error::SkError;
use crate::font::FontStyle;
use crate::image::ImageData;

mod ffi {
  use std::os::raw::c_char;

  use super::SkiaString;

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_surface {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_canvas {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_paint {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_path {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_matrix {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_shader {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_path_effect {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_mask_filter {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_image_filter {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_data {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_image {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_bitmap {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_sk_string {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_rect {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_transform {
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
    pub e: f32,
    pub f: f32,
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_point {
    pub x: f32,
    pub y: f32,
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_surface_data {
    pub ptr: *mut u8,
    pub size: usize,
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_sk_data {
    pub ptr: *mut u8,
    pub size: usize,
    pub data: *mut skiac_data,
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_typeface {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_typeface_font_provider {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Default, Debug)]
  pub struct skiac_font_metrics {
    pub flags: u32,
    pub top: f32,
    pub ascent: f32,
    pub descent: f32,
    pub bottom: f32,
    pub leading: f32,
    pub avg_char_width: f32,
    pub max_char_width: f32,
    pub x_min: f32,
    pub x_max: f32,
    pub x_height: f32,
    pub cap_height: f32,
    underline_thickness: f32,
    underline_position: f32,
    strikeout_thickness: f32,
    strikeout_position: f32,
  }

  #[repr(C)]
  #[derive(Copy, Clone, Default, Debug)]
  pub struct skiac_line_metrics {
    pub ascent: f32,
    pub descent: f32,
    pub left: f32,
    pub width: f32,
    pub baseline: f32,
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_font_mgr {
    _unused: [u8; 0],
  }

  #[repr(C)]
  #[derive(Copy, Clone, Debug)]
  pub struct skiac_font_collection {
    _unused: [u8; 0],
  }

  extern "C" {

    pub fn skiac_surface_create_rgba_premultiplied(width: i32, height: i32) -> *mut skiac_surface;

    pub fn skiac_surface_create_rgba(width: i32, height: i32) -> *mut skiac_surface;

    pub fn skiac_surface_destroy(surface: *mut skiac_surface);

    pub fn skiac_surface_copy_rgba(
      surface: *mut skiac_surface,
      x: u32,
      y: u32,
      width: u32,
      height: u32,
    ) -> *mut skiac_surface;

    pub fn skiac_surface_save(
      c_surface: *mut skiac_surface,
      path: *const ::std::os::raw::c_char,
    ) -> bool;

    pub fn skiac_surface_get_canvas(surface: *mut skiac_surface) -> *mut skiac_canvas;

    pub fn skiac_surface_get_width(surface: *mut skiac_surface) -> i32;

    pub fn skiac_surface_get_height(surface: *mut skiac_surface) -> i32;

    pub fn skiac_surface_read_pixels(surface: *mut skiac_surface, data: *mut skiac_surface_data);

    pub fn skiac_surface_read_pixels_rect(
      surface: *mut skiac_surface,
      data: *mut u8,
      x: i32,
      y: i32,
      w: i32,
      h: i32,
    ) -> bool;

    pub fn skiac_surface_png_data(surface: *mut skiac_surface, data: *mut skiac_sk_data);

    pub fn skiac_surface_encode_data(
      surface: *mut skiac_surface,
      data: *mut skiac_sk_data,
      format: i32,
      quality: i32,
    );

    pub fn skiac_surface_get_alpha_type(surface: *mut skiac_surface) -> i32;

    pub fn skiac_canvas_clear(canvas: *mut skiac_canvas, color: u32);

    pub fn skiac_canvas_set_transform(canvas: *mut skiac_canvas, ts: skiac_transform);

    pub fn skiac_canvas_concat(canvas: *mut skiac_canvas, ts: skiac_transform);

    pub fn skiac_canvas_scale(canvas: *mut skiac_canvas, sx: f32, sy: f32);

    pub fn skiac_canvas_translate(canvas: *mut skiac_canvas, dx: f32, dy: f32);

    pub fn skiac_canvas_rotate(canvas: *mut skiac_canvas, degrees: f32);

    pub fn skiac_canvas_get_total_transform(canvas: *mut skiac_canvas) -> skiac_transform;

    pub fn skiac_canvas_get_total_transform_matrix(canvas: *mut skiac_canvas) -> *mut skiac_matrix;

    pub fn skiac_canvas_draw_color(canvas: *mut skiac_canvas, r: f32, g: f32, b: f32, a: f32);

    pub fn skiac_canvas_draw_image(
      canvas: *mut skiac_canvas,
      bitmap: *mut skiac_bitmap,
      sx: f32,
      sy: f32,
      s_width: f32,
      s_height: f32,
      dx: f32,
      dy: f32,
      d_width: f32,
      d_height: f32,
      paint: *mut skiac_paint,
    );

    pub fn skiac_canvas_draw_path(
      canvas: *mut skiac_canvas,
      path: *mut skiac_path,
      paint: *mut skiac_paint,
    );

    pub fn skiac_canvas_draw_rect(
      canvas: *mut skiac_canvas,
      x: f32,
      y: f32,
      w: f32,
      h: f32,
      paint: *mut skiac_paint,
    );

    pub fn skiac_canvas_draw_surface(
      canvas: *mut skiac_canvas,
      surface: *mut skiac_surface,
      left: f32,
      top: f32,
      alpha: u8,
      blend_mode: i32,
      filter_quality: i32,
    );

    pub fn skiac_canvas_draw_surface_rect(
      canvas: *mut skiac_canvas,
      surface: *mut skiac_surface,
      x: f32,
      y: f32,
      w: f32,
      h: f32,
      filter_quality: i32,
    );

    pub fn skiac_canvas_draw_text(
      canvas: *mut skiac_canvas,
      text: *const ::std::os::raw::c_char,
      text_len: usize,
      x: f32,
      y: f32,
      max_width: f32,
      weight: i32,
      width: i32,
      slant: i32,
      c_font_collection: *mut skiac_font_collection,
      font_size: f32,
      font_family: *const ::std::os::raw::c_char,
      baseline_offset: f32,
      align: u8,
      align_factor: f32,
      paint: *mut skiac_paint,
    );

    pub fn skiac_canvas_get_line_metrics(
      text: *const ::std::os::raw::c_char,
      font_collection: *mut skiac_font_collection,
      font_size: f32,
      font_family: *const ::std::os::raw::c_char,
      align: u8,
      align_factor: f32,
      paint: *mut skiac_paint,
    ) -> skiac_line_metrics;

    pub fn skiac_canvas_reset_transform(canvas: *mut skiac_canvas);

    pub fn skiac_canvas_clip_rect(canvas: *mut skiac_canvas, x: f32, y: f32, w: f32, h: f32);

    pub fn skiac_canvas_clip_path(canvas: *mut skiac_canvas, path: *mut skiac_path);

    pub fn skiac_canvas_save(canvas: *mut skiac_canvas);

    pub fn skiac_canvas_restore(canvas: *mut skiac_canvas);

    pub fn skiac_canvas_write_pixels(
      canvas: *mut skiac_canvas,
      width: i32,
      height: i32,
      pixels: *const u8,
      row_bytes: usize,
      x: i32,
      y: i32,
    );

    pub fn skiac_canvas_write_pixels_dirty(
      canvas: *mut skiac_canvas,
      width: i32,
      height: i32,
      pixels: *const u8,
      row_bytes: usize,
      length: usize,
      x: f32,
      y: f32,
      dirty_x: f32,
      dirty_y: f32,
      dirty_width: f32,
      dirty_height: f32,
    );

    pub fn skiac_paint_create() -> *mut skiac_paint;

    pub fn skiac_paint_clone(source: *mut skiac_paint) -> *mut skiac_paint;

    pub fn skiac_paint_destroy(paint: *mut skiac_paint);

    pub fn skiac_paint_set_style(paint: *mut skiac_paint, style: i32);

    pub fn skiac_paint_set_color(paint: *mut skiac_paint, r: u8, g: u8, b: u8, a: u8);

    pub fn skiac_paint_set_alpha(paint: *mut skiac_paint, a: u8);

    pub fn skiac_paint_get_alpha(paint: *mut skiac_paint) -> u8;

    pub fn skiac_paint_set_anti_alias(paint: *mut skiac_paint, aa: bool);

    pub fn skiac_paint_set_blend_mode(paint: *mut skiac_paint, blend_mode: i32);

    pub fn skiac_paint_get_blend_mode(paint: *mut skiac_paint) -> i32;

    pub fn skiac_paint_set_shader(paint: *mut skiac_paint, shader: *mut skiac_shader);

    pub fn skiac_paint_set_stroke_width(paint: *mut skiac_paint, width: f32);

    pub fn skiac_paint_get_stroke_width(paint: *mut skiac_paint) -> f32;

    pub fn skiac_paint_set_stroke_cap(paint: *mut skiac_paint, cap: i32);

    pub fn skiac_paint_get_stroke_cap(paint: *mut skiac_paint) -> i32;

    pub fn skiac_paint_set_stroke_join(paint: *mut skiac_paint, join: u8);

    pub fn skiac_paint_get_stroke_join(paint: *mut skiac_paint) -> u8;

    pub fn skiac_paint_set_stroke_miter(paint: *mut skiac_paint, miter: f32);

    pub fn skiac_paint_get_stroke_miter(paint: *mut skiac_paint) -> f32;

    pub fn skiac_paint_set_path_effect(
      paint: *mut skiac_paint,
      path_effect: *mut skiac_path_effect,
    );

    pub fn skiac_paint_set_mask_filter(
      paint: *mut skiac_paint,
      mask_filter: *mut skiac_mask_filter,
    );

    pub fn skiac_paint_set_image_filter(
      paint: *mut skiac_paint,
      image_filter: *mut skiac_image_filter,
    );

    pub fn skiac_path_create() -> *mut skiac_path;

    pub fn skiac_path_from_svg(svg_path: *mut std::os::raw::c_char) -> *mut skiac_path;

    pub fn skiac_path_clone(path: *mut skiac_path) -> *mut skiac_path;

    pub fn skiac_add_path(
      c_path: *mut skiac_path,
      other_path: *mut skiac_path,
      c_matrix: skiac_transform,
    );

    pub fn skiac_path_op(c_path_one: *mut skiac_path, c_path_two: *mut skiac_path, op: i32)
      -> bool;

    pub fn skiac_path_to_svg_string(c_path: *mut skiac_path, skia_string: *mut SkiaString);

    pub fn skiac_path_simplify(c_path: *mut skiac_path) -> bool;

    pub fn skiac_path_stroke(
      c_path: *mut skiac_path,
      cap: i32,
      join: u8,
      width: f32,
      miter_limit: f32,
    ) -> bool;

    pub fn skiac_path_get_bounds(path: *mut skiac_path, c_rect: *mut skiac_rect);

    pub fn skiac_path_compute_tight_bounds(path: *mut skiac_path, c_rect: *mut skiac_rect);

    pub fn skiac_path_trim(
      path: *mut skiac_path,
      start_t: f32,
      stop_t: f32,
      is_complement: bool,
    ) -> bool;

    pub fn skiac_path_dash(path: *mut skiac_path, on: f32, off: f32, phase: f32) -> bool;

    pub fn skiac_path_equals(path: *mut skiac_path, other: *mut skiac_path) -> bool;

    pub fn skiac_path_destroy(path: *mut skiac_path);

    pub fn skiac_path_set_fill_type(path: *mut skiac_path, kind: i32);

    pub fn skiac_path_get_fill_type(path: *mut skiac_path) -> i32;

    pub fn skiac_path_as_winding(path: *mut skiac_path) -> bool;

    pub fn skiac_path_arc_to(
      path: *mut skiac_path,
      left: f32,
      top: f32,
      right: f32,
      bottom: f32,
      start_angle: f32,
      sweep_angle: f32,
      force_move_to: bool,
    );

    pub fn skiac_path_arc_to_tangent(
      path: *mut skiac_path,
      x1: f32,
      y1: f32,
      x2: f32,
      y2: f32,
      radius: f32,
    );

    pub fn skiac_path_move_to(path: *mut skiac_path, x: f32, y: f32);

    pub fn skiac_path_line_to(path: *mut skiac_path, x: f32, y: f32);

    pub fn skiac_path_cubic_to(
      path: *mut skiac_path,
      x1: f32,
      y1: f32,
      x2: f32,
      y2: f32,
      x3: f32,
      y3: f32,
    );

    pub fn skiac_path_quad_to(path: *mut skiac_path, cpx: f32, cpy: f32, x: f32, y: f32);

    pub fn skiac_path_close(path: *mut skiac_path);

    pub fn skiac_path_add_rect(path: *mut skiac_path, l: f32, t: f32, r: f32, b: f32);

    pub fn skiac_path_add_circle(path: *mut skiac_path, x: f32, y: f32, r: f32);

    pub fn skiac_path_transform(path: *mut skiac_path, matrix: skiac_transform);

    pub fn skiac_path_transform_matrix(path: *mut skiac_path, matrix: *mut skiac_matrix);

    pub fn skiac_path_is_empty(path: *mut skiac_path) -> bool;

    pub fn skiac_path_hit_test(path: *mut skiac_path, x: f32, y: f32, kind: i32) -> bool;

    pub fn skiac_path_stroke_hit_test(path: *mut skiac_path, x: f32, y: f32, stroke_w: f32)
      -> bool;

    pub fn skiac_path_effect_make_dash_path(
      intervals: *const f32,
      count: i32,
      phase: f32,
    ) -> *mut skiac_path_effect;

    pub fn skiac_path_effect_destroy(path_effect: *mut skiac_path_effect);

    pub fn skiac_shader_make_linear_gradient(
      points: *const skiac_point,
      colors: *const super::Color,
      positions: *const f32,
      count: i32,
      tile_mode: i32,
      flags: u32,
      ts: skiac_transform,
    ) -> *mut skiac_shader;

    pub fn skiac_shader_make_radial_gradient(
      start_point: skiac_point,
      start_radius: f32,
      end_point: skiac_point,
      end_radius: f32,
      colors: *const super::Color,
      positions: *const f32,
      count: i32,
      tile_mode: i32,
      flags: u32,
      ts: skiac_transform,
    ) -> *mut skiac_shader;

    pub fn skiac_shader_make_conic_gradient(
      cx: f32,
      cy: f32,
      radius: f32,
      colors: *const super::Color,
      positions: *const f32,
      count: i32,
      tile_mode: i32,
      flags: u32,
      ts: skiac_transform,
    ) -> *mut skiac_shader;

    pub fn skiac_shader_make_from_surface_image(
      surface: *mut skiac_surface,
      ts: skiac_transform,
      filter_quality: i32,
    ) -> *mut skiac_shader;

    pub fn skiac_shader_destroy(shader: *mut skiac_shader);

    pub fn skiac_matrix_create() -> *mut skiac_matrix;

    pub fn skiac_matrix_clone(matrix: *mut skiac_matrix) -> *mut skiac_matrix;

    pub fn skiac_matrix_pre_translate(matrix: *mut skiac_matrix, dx: f32, dy: f32);

    pub fn skiac_matrix_pre_rotate(matrix: *mut skiac_matrix, degrees: f32);

    pub fn skiac_matrix_invert(matrix: *mut skiac_matrix, inverse: *mut skiac_matrix) -> bool;

    pub fn skiac_matrix_to_transform(matrix: *mut skiac_matrix) -> skiac_transform;

    pub fn skiac_matrix_destroy(matrix: *mut skiac_matrix);

    pub fn skiac_mask_filter_make_blur(radius: f32) -> *mut skiac_mask_filter;

    pub fn skiac_mask_filter_destroy(mask_filter: *mut skiac_mask_filter);

    pub fn skiac_image_filter_make_drop_shadow(
      dx: f32,
      dy: f32,
      sigma_x: f32,
      sigma_y: f32,
      color: u32,
    ) -> *mut skiac_image_filter;

    pub fn skiac_image_filter_destroy(image_filter: *mut skiac_image_filter);

    pub fn skiac_sk_data_destroy(c_data: *mut skiac_data);

    pub fn skiac_bitmap_make_from_buffer(ptr: *mut u8, size: usize) -> *mut skiac_bitmap;

    pub fn skiac_bitmap_make_from_svg(data: *const u8, size: usize) -> *mut skiac_bitmap;

    pub fn skiac_bitmap_make_from_image_data(
      ptr: *mut u8,
      width: usize,
      height: usize,
      row_bytes: usize,
      size: usize,
      color_type: i32,
      alpha_type: i32,
    ) -> *mut skiac_bitmap;

    pub fn skiac_bitmap_get_width(c_bitmap: *mut skiac_bitmap) -> u32;

    pub fn skiac_bitmap_get_height(c_bitmap: *mut skiac_bitmap) -> u32;

    pub fn skiac_bitmap_get_shader(
      c_bitmap: *mut skiac_bitmap,
      repeat_x: i32,
      repeat_y: i32,
      b: f32,
      c: f32,
      ts: skiac_transform,
    ) -> *mut skiac_shader;

    pub fn skiac_bitmap_destroy(c_bitmap: *mut skiac_bitmap);

    // SkString
    pub fn skiac_delete_sk_string(c_sk_string: *mut skiac_sk_string);

    pub fn skiac_font_metrics_create(
      font_family: *const ::std::os::raw::c_char,
      font_size: f32,
    ) -> *mut skiac_font_metrics;

    pub fn skiac_font_metrics_destroy(c_font_metrics: *mut skiac_font_metrics);

    pub fn skiac_font_collection_create() -> *mut skiac_font_collection;

    pub fn skiac_font_collection_clone(
      c_font_collection: *mut skiac_font_collection,
    ) -> *mut skiac_font_collection;

    pub fn skiac_font_collection_get_default_fonts_count(
      c_font_collection: *mut skiac_font_collection,
    ) -> u32;

    pub fn skiac_font_collection_get_family(
      c_font_collection: *mut skiac_font_collection,
      i: u32,
      skia_string: *mut SkiaString,
    );

    pub fn skiac_font_collection_register(
      c_font_collection: *mut skiac_font_collection,
      font: *const u8,
      length: usize,
    ) -> usize;

    pub fn skiac_font_collection_register_from_path(
      c_font_collection: *mut skiac_font_collection,
      font_path: *const c_char,
    ) -> usize;

    pub fn skiac_font_collection_destroy(c_font_collection: *mut skiac_font_collection);
  }
}

#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
#[repr(i32)]
pub enum ColorType {
  Unknown,
  /// uninitialized
  Alpha8,
  /// pixel with alpha in 8-bit byte
  RGB565,
  /// pixel with 5 bits red, 6 bits green, 5 bits blue, in 16-bit word
  ARGB4444,
  /// pixel with 4 bits for alpha, red, green, blue; in 16-bit word
  RGBA8888,
  /// pixel with 8 bits for red, green, blue, alpha; in 32-bit word
  RGB888x,
  /// pixel with 8 bits each for red, green, blue; in 32-bit word
  BGRA8888,
  /// pixel with 8 bits for blue, green, red, alpha; in 32-bit word
  RGBA1010102,
  /// 10 bits for red, green, blue; 2 bits for alpha; in 32-bit word
  BGRA1010102,
  /// 10 bits for blue, green, red; 2 bits for alpha; in 32-bit word
  RGB101010x,
  /// pixel with 10 bits each for red, green, blue; in 32-bit word
  BGR101010x,
  /// pixel with 10 bits each for blue, green, red; in 32-bit word
  Gray8,
  /// pixel with grayscale level in 8-bit byte
  RGBAF16Norm,
  /// pixel with half floats in [0,1] for red, green, blue, alpha;
  //   in 64-bit word
  RGBAF16,
  /// pixel with half floats for red, green, blue, alpha;
  //   in 64-bit word
  RGBAF32,
  /// pixel using C float for red, green, blue, alpha; in 128-bit word
  /// The following 6 colortypes are just for reading from - not for rendering to

  /// pixel with a uint8_t for red and green
  R8G8Unorm,
  // pixel with a half float for alpha
  A16Float,
  /// pixel with a half float for red and green
  R16G16Float,

  // pixel with a little endian uint16_t for alpha
  A16Unorm,
  // pixel with a little endian uint16_t for red and green
  R16G16Unorm,
  /// pixel with a little endian uint16_t for red, green, blue and alpha
  R16G16B16A16Unorm,
}

#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub enum PaintStyle {
  Fill = 0,
  Stroke = 1,
}

#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub enum FillType {
  Winding = 0,
  EvenOdd = 1,
  InverseWinding = 2,
  InverseEvenOdd = 3,
}

impl From<u32> for FillType {
  fn from(value: u32) -> Self {
    match value {
      0 => Self::Winding,
      1 => Self::EvenOdd,
      2 => Self::InverseWinding,
      3 => Self::InverseEvenOdd,
      _ => unreachable!(),
    }
  }
}

impl FromStr for FillType {
  type Err = SkError;

  fn from_str(value: &str) -> Result<Self, SkError> {
    match value {
      "nonzero" => Ok(FillType::Winding),
      "evenodd" => Ok(FillType::EvenOdd),
      _ => Err(SkError::StringToFillRuleError(value.to_owned())),
    }
  }
}

#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub enum StrokeCap {
  Butt = 0,
  Round = 1,
  Square = 2,
}

impl StrokeCap {
  pub fn from_raw(cap: i32) -> Result<Self, SkError> {
    match cap {
      0 => Ok(Self::Butt),
      1 => Ok(Self::Round),
      2 => Ok(Self::Square),
      _ => Err(SkError::Generic(format!(
        "{} is not valid StrokeCap value",
        cap
      ))),
    }
  }

  pub fn as_str(&self) -> &str {
    match self {
      Self::Butt => "butt",
      Self::Round => "round",
      Self::Square => "square",
    }
  }
}

impl FromStr for StrokeCap {
  type Err = SkError;

  fn from_str(value: &str) -> Result<StrokeCap, Self::Err> {
    match value {
      "butt" => Ok(Self::Butt),
      "round" => Ok(Self::Round),
      "square" => Ok(Self::Square),
      _ => Err(SkError::StringToStrokeCapError(value.to_owned())),
    }
  }
}

#[repr(u8)]
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub enum StrokeJoin {
  Miter,
  Round,
  Bevel,
}

impl StrokeJoin {
  pub fn from_raw(join: u8) -> Result<Self, SkError> {
    match join {
      0 => Ok(Self::Miter),
      1 => Ok(Self::Round),
      2 => Ok(Self::Bevel),
      _ => Err(SkError::Generic(format!(
        "{} is not a valid StrokeJoin value",
        join
      ))),
    }
  }

  pub fn as_str(&self) -> &str {
    match self {
      Self::Miter => "miter",
      Self::Round => "round",
      Self::Bevel => "bevel",
    }
  }
}

impl FromStr for StrokeJoin {
  type Err = SkError;

  fn from_str(value: &str) -> Result<StrokeJoin, Self::Err> {
    match value {
      "bevel" => Ok(Self::Bevel),
      "round" => Ok(Self::Round),
      "miter" => Ok(Self::Miter),
      _ => Err(SkError::StringToStrokeJoinError(value.to_owned())),
    }
  }
}

#[repr(i32)]
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub enum TileMode {
  Clamp = 0,
  Repeat = 1,
  Mirror = 2,
  Decal = 3,
}

#[repr(u8)]
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub enum BlendMode {
  /// Replaces destination with zero: fully transparent.
  Clear = 0,
  /// Replaces destination.
  Source,
  /// Preserves destination.
  Destination,
  /// Source over destination.
  SourceOver,
  /// Destination over source.
  DestinationOver,
  /// Source trimmed inside destination.
  SourceIn,
  /// Destination trimmed by source.
  DestinationIn,
  /// Source trimmed outside destination.
  SourceOut,
  /// Destination trimmed outside source.
  DestinationOut,
  /// Source inside destination blended with destination.
  SourceATop,
  /// Destination inside source blended with source.
  DestinationATop,
  /// Each of source and destination trimmed outside the other.
  Xor,
  /// Sum of colors.
  Plus,
  /// Product of premultiplied colors; darkens destination.
  Modulate,
  /// Multiply inverse of pixels, inverting result; brightens destination.
  Screen,
  /// Multiply or screen, depending on destination.
  Overlay,
  /// Darker of source and destination.
  Darken,
  /// Lighter of source and destination.
  Lighten,
  /// Brighten destination to reflect source.
  ColorDodge,
  /// Darken destination to reflect source.
  ColorBurn,
  /// Multiply or screen, depending on source.
  HardLight,
  /// Lighten or darken, depending on source.
  SoftLight,
  /// Subtract darker from lighter with higher contrast.
  Difference,
  /// Subtract darker from lighter with lower contrast.
  Exclusion,
  /// Multiply source with destination, darkening image.
  Multiply,
  /// Hue of source with saturation and luminosity of destination.
  Hue,
  /// Saturation of source with hue and luminosity of destination.
  Saturation,
  /// Hue and saturation of source with luminosity of destination.
  Color,
  /// Luminosity of source with hue and saturation of destination.
  Luminosity,
}

impl BlendMode {
  pub fn as_str(&self) -> &str {
    match self {
      BlendMode::Clear => "clear",
      BlendMode::Color => "color",
      BlendMode::ColorBurn => "color-burn",
      BlendMode::ColorDodge => "color-dodge",
      BlendMode::Darken => "darken",
      BlendMode::Destination => "destination",
      BlendMode::DestinationATop => "destination-atop",
      BlendMode::DestinationIn => "destination-in",
      BlendMode::DestinationOut => "destination-out",
      BlendMode::DestinationOver => "destination-over",
      BlendMode::Difference => "difference",
      BlendMode::Exclusion => "exclusion",
      BlendMode::HardLight => "hard-light",
      BlendMode::Hue => "hue",
      BlendMode::Lighten => "lighten",
      BlendMode::Luminosity => "luminosity",
      BlendMode::Modulate => "modulate",
      BlendMode::Multiply => "multiply",
      BlendMode::Overlay => "overlay",
      BlendMode::Plus => "plus",
      BlendMode::Saturation => "saturation",
      BlendMode::Screen => "screen",
      BlendMode::SoftLight => "soft-light",
      BlendMode::Source => "source",
      BlendMode::SourceATop => "source-atop",
      BlendMode::SourceIn => "source-in",
      BlendMode::SourceOut => "source-out",
      BlendMode::SourceOver => "source-over",
      BlendMode::Xor => "xor",
    }
  }
}

impl FromStr for BlendMode {
  type Err = SkError;

  fn from_str(value: &str) -> Result<BlendMode, Self::Err> {
    match value {
      "clear" => Ok(BlendMode::Clear),
      "color" => Ok(BlendMode::Color),
      "color-burn" => Ok(BlendMode::ColorBurn),
      "color-dodge" => Ok(BlendMode::ColorDodge),
      "darken" => Ok(BlendMode::Darken),
      "destination" => Ok(BlendMode::Destination),
      "destination-atop" => Ok(BlendMode::DestinationATop),
      "destination-in" => Ok(BlendMode::DestinationIn),
      "destination-out" => Ok(BlendMode::DestinationOut),
      "destination-over" => Ok(BlendMode::DestinationOver),
      "difference" => Ok(BlendMode::Difference),
      "exclusion" => Ok(BlendMode::Exclusion),
      "hard-light" => Ok(BlendMode::HardLight),
      "hue" => Ok(BlendMode::Hue),
      "lighten" => Ok(BlendMode::Lighten),
      "luminosity" => Ok(BlendMode::Luminosity),
      "modulate" => Ok(BlendMode::Modulate),
      "multiply" => Ok(BlendMode::Multiply),
      "overlay" => Ok(BlendMode::Overlay),
      "plus" => Ok(BlendMode::Plus),
      "saturation" => Ok(BlendMode::Saturation),
      "screen" => Ok(BlendMode::Screen),
      "soft-light" => Ok(BlendMode::SoftLight),
      "source" => Ok(BlendMode::Source),
      "source-atop" => Ok(BlendMode::SourceATop),
      "source-in" => Ok(BlendMode::SourceIn),
      "source-out" => Ok(BlendMode::SourceOut),
      "source-over" => Ok(BlendMode::SourceOver),
      "xor" => Ok(BlendMode::Xor),
      _ => Err(SkError::StringToBlendError(value.to_owned())),
    }
  }
}

impl From<i32> for BlendMode {
  fn from(value: i32) -> BlendMode {
    match value {
      0 => Self::Clear,
      1 => Self::Source,
      2 => Self::Destination,
      3 => Self::SourceOver,
      4 => Self::DestinationOver,
      5 => Self::SourceIn,
      6 => Self::DestinationIn,
      7 => Self::SourceOut,
      8 => Self::DestinationOut,
      9 => Self::SourceATop,
      10 => Self::DestinationATop,
      11 => Self::Xor,
      12 => Self::Plus,
      13 => Self::Modulate,
      14 => Self::Screen,
      15 => Self::Overlay,
      16 => Self::Darken,
      17 => Self::Lighten,
      18 => Self::ColorDodge,
      19 => Self::ColorBurn,
      20 => Self::HardLight,
      21 => Self::SoftLight,
      22 => Self::Difference,
      23 => Self::Exclusion,
      24 => Self::Multiply,
      25 => Self::Hue,
      26 => Self::Saturation,
      27 => Self::Color,
      28 => Self::Luminosity,
      _ => unreachable!(),
    }
  }
}

#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub enum FilterQuality {
  None = 0,
  Low = 1,
  Medium = 2,
  High = 3,
}

impl FilterQuality {
  pub fn as_str(&self) -> &'static str {
    match self {
      Self::High => "high",
      Self::Low => "low",
      Self::Medium => "medium",
      Self::None => "",
    }
  }
}

impl FromStr for FilterQuality {
  type Err = SkError;

  fn from_str(s: &str) -> Result<FilterQuality, SkError> {
    match s {
      "low" => Ok(Self::Low),
      "medium" => Ok(Self::Medium),
      "high" => Ok(Self::High),
      _ => Err(SkError::StringToFilterQualityError(s.to_owned())),
    }
  }
}

/// Describes how to interpret the alpha component of a pixel.
///
/// A pixel may be opaque, or alpha, describing multiple levels of transparency.
///
/// In simple blending, alpha weights the draw color and the destination
/// color to create a new color. If alpha describes a weight from zero to one:
///
/// new color = draw color * alpha + destination color * (1 - alpha)
///
/// In practice alpha is encoded in two or more bits, where 1.0 equals all bits set.
///
/// RGB may have alpha included in each component value; the stored
/// value is the original RGB multiplied by alpha. Premultiplied color
/// components improve performance.
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub enum AlphaType {
  Unknown,
  Opaque,
  Premultiplied,
  Unpremultiplied,
}

#[repr(i32)]
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub enum PathOp {
  Difference,        // subtract the op path from the first path
  Intersect,         // intersect the two paths
  Union,             // union (inclusive-or) the two paths
  Xor,               // exclusive-or the two paths
  ReverseDifference, // subtract the first path from the op path
}

impl From<i32> for PathOp {
  fn from(value: i32) -> Self {
    match value {
      0 => Self::Difference,
      1 => Self::Intersect,
      2 => Self::Union,
      3 => Self::Xor,
      4 => Self::ReverseDifference,
      _ => panic!("[{}] is not valid path op", value),
    }
  }
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub enum TextAlign {
  Left,
  Right,
  Center,
  Justify,
  Start,
  End,
}

impl TextAlign {
  pub fn as_str(&self) -> &str {
    match self {
      Self::Start => "start",
      Self::Center => "center",
      Self::End => "end",
      Self::Left => "left",
      Self::Right => "right",
      Self::Justify => "justify",
    }
  }
}

impl FromStr for TextAlign {
  type Err = SkError;

  fn from_str(s: &str) -> Result<TextAlign, SkError> {
    match s {
      "center" => Ok(TextAlign::Center),
      "end" => Ok(TextAlign::End),
      "left" => Ok(TextAlign::Left),
      "right" => Ok(TextAlign::Right),
      "start" => Ok(TextAlign::Start),
      "justify" => Ok(TextAlign::Justify),
      _ => Err(SkError::StringToTextAlignError(s.to_owned())),
    }
  }
}

#[derive(Debug, Clone, Copy)]
pub enum TextBaseline {
  Top,
  Hanging,
  Middle,
  Alphabetic,
  Ideographic,
  Bottom,
}

impl FromStr for TextBaseline {
  type Err = SkError;

  fn from_str(s: &str) -> Result<TextBaseline, SkError> {
    match s {
      "top" => Ok(Self::Top),
      "hanging" => Ok(Self::Hanging),
      "middle" => Ok(Self::Middle),
      "alphabetic" => Ok(Self::Alphabetic),
      "bottom" => Ok(Self::Bottom),
      "ideographic" => Ok(Self::Ideographic),
      _ => Err(SkError::StringToTextBaselineError(s.to_owned())),
    }
  }
}

impl TextBaseline {
  pub fn as_str(&self) -> &'static str {
    match self {
      Self::Bottom => "bottom",
      Self::Alphabetic => "alphabetic",
      Self::Hanging => "hanging",
      Self::Ideographic => "ideographic",
      Self::Middle => "middle",
      Self::Top => "top",
    }
  }
}

impl ToString for TextBaseline {
  fn to_string(&self) -> String {
    self.as_str().to_owned()
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum SkEncodedImageFormat {
  Bmp,
  Gif,
  Ico,
  Jpeg,
  Png,
  Wbmp,
  Webp,
  Pm,
  Tx,
  Astc,
  Dng,
  Heif,
  Avif,
}

pub struct Surface {
  ptr: *mut ffi::skiac_surface,
  pub(crate) canvas: Canvas,
}

impl Surface {
  #[inline]
  pub fn new_rgba(width: u32, height: u32) -> Option<Surface> {
    unsafe { Self::from_ptr(ffi::skiac_surface_create_rgba(width as i32, height as i32)) }
  }

  #[inline]
  pub fn new_rgba_premultiplied(width: u32, height: u32) -> Option<Surface> {
    unsafe {
      Self::from_ptr(ffi::skiac_surface_create_rgba_premultiplied(
        width as i32,
        height as i32,
      ))
    }
  }

  #[inline]
  unsafe fn from_ptr(ptr: *mut ffi::skiac_surface) -> Option<Surface> {
    if ptr.is_null() {
      None
    } else {
      Some(Surface {
        ptr,
        canvas: Canvas(ffi::skiac_surface_get_canvas(ptr)),
      })
    }
  }

  #[inline]
  pub fn copy_rgba(&self, x: u32, y: u32, width: u32, height: u32) -> Option<Surface> {
    unsafe { Self::from_ptr(ffi::skiac_surface_copy_rgba(self.ptr, x, y, width, height)) }
  }

  #[inline]
  pub fn try_clone(&self) -> Option<Surface> {
    unsafe {
      Self::from_ptr(ffi::skiac_surface_copy_rgba(
        self.ptr,
        0,
        0,
        self.width(),
        self.height(),
      ))
    }
  }

  #[inline]
  pub fn save_png(&self, path: &str) -> bool {
    let c_path = std::ffi::CString::new(path).unwrap();
    unsafe { ffi::skiac_surface_save(self.ptr, c_path.as_ptr()) }
  }

  #[inline]
  pub fn width(&self) -> u32 {
    unsafe { ffi::skiac_surface_get_width(self.ptr) as u32 }
  }

  #[inline]
  pub fn height(&self) -> u32 {
    unsafe { ffi::skiac_surface_get_height(self.ptr) as u32 }
  }

  #[inline]
  pub fn alpha_type(&self) -> AlphaType {
    let kind = unsafe { ffi::skiac_surface_get_alpha_type(self.ptr) };
    match kind {
      0 => AlphaType::Unknown,
      1 => AlphaType::Opaque,
      2 => AlphaType::Premultiplied,
      3 => AlphaType::Unpremultiplied,
      _ => unreachable!(),
    }
  }

  #[inline]
  pub fn read_pixels(&self, x: u32, y: u32, width: u32, height: u32) -> Option<Vec<u8>> {
    let mut result = vec![0; (width * height * 4) as usize];
    let status = unsafe {
      ffi::skiac_surface_read_pixels_rect(
        self.ptr,
        result.as_mut_ptr(),
        x as i32,
        y as i32,
        width as i32,
        height as i32,
      )
    };
    if status {
      Some(result)
    } else {
      None
    }
  }

  #[inline]
  pub fn data(&self) -> Option<SurfaceData> {
    unsafe {
      let mut data = ffi::skiac_surface_data {
        ptr: ptr::null_mut(),
        size: 0,
      };
      ffi::skiac_surface_read_pixels(self.ptr, &mut data);

      if data.ptr.is_null() {
        None
      } else {
        Some(SurfaceData {
          slice: slice::from_raw_parts(data.ptr, data.size as usize),
        })
      }
    }
  }

  #[inline]
  pub fn data_mut(&mut self) -> Option<SurfaceDataMut> {
    unsafe {
      let mut data = ffi::skiac_surface_data {
        ptr: ptr::null_mut(),
        size: 0,
      };
      ffi::skiac_surface_read_pixels(self.ptr, &mut data);
      if data.ptr.is_null() {
        None
      } else {
        Some(SurfaceDataMut {
          slice: slice::from_raw_parts_mut(data.ptr, data.size as usize),
        })
      }
    }
  }

  #[inline]
  pub(crate) fn reference(&self) -> SurfaceRef {
    SurfaceRef(self.ptr)
  }
}

impl std::ops::Deref for Surface {
  type Target = Canvas;

  #[inline]
  fn deref(&self) -> &Self::Target {
    &self.canvas
  }
}

impl std::ops::DerefMut for Surface {
  #[inline]
  fn deref_mut(&mut self) -> &mut Self::Target {
    &mut self.canvas
  }
}

impl Drop for Surface {
  #[inline]
  fn drop(&mut self) {
    unsafe {
      ffi::skiac_surface_destroy(self.ptr);
    }
  }
}

#[repr(transparent)]
pub struct SurfaceRef(*mut ffi::skiac_surface);

impl SurfaceRef {
  #[inline]
  pub fn png_data(&self) -> Option<SurfaceDataRef> {
    unsafe {
      let mut data = ffi::skiac_sk_data {
        ptr: ptr::null_mut(),
        size: 0,
        data: ptr::null_mut(),
      };
      ffi::skiac_surface_png_data(self.0, &mut data);

      if data.ptr.is_null() {
        None
      } else {
        Some(SurfaceDataRef(data))
      }
    }
  }

  #[inline]
  pub fn data(&self) -> Option<(*const u8, usize)> {
    let mut data = ffi::skiac_surface_data {
      ptr: ptr::null_mut(),
      size: 0,
    };
    unsafe { ffi::skiac_surface_read_pixels(self.0, &mut data) };
    if data.ptr.is_null() {
      None
    } else {
      Some((data.ptr, data.size))
    }
  }

  #[inline]
  pub fn encode_data(&self, format: SkEncodedImageFormat, quality: u8) -> Option<SurfaceDataRef> {
    unsafe {
      let mut data = ffi::skiac_sk_data {
        ptr: ptr::null_mut(),
        size: 0,
        data: ptr::null_mut(),
      };
      ffi::skiac_surface_encode_data(self.0, &mut data, format as i32, quality as i32);

      if data.ptr.is_null() {
        None
      } else {
        Some(SurfaceDataRef(data))
      }
    }
  }
}

unsafe impl Send for SurfaceRef {}
unsafe impl Sync for SurfaceRef {}

pub struct SurfaceData<'a> {
  slice: &'a [u8],
}

impl<'a> Deref for SurfaceData<'a> {
  type Target = [u8];

  #[inline]
  fn deref(&self) -> &[u8] {
    self.slice
  }
}

pub struct SurfaceDataMut<'a> {
  slice: &'a mut [u8],
}

impl<'a> Deref for SurfaceDataMut<'a> {
  type Target = [u8];

  #[inline]
  fn deref(&self) -> &[u8] {
    self.slice
  }
}

#[repr(transparent)]
pub struct SurfaceDataRef(pub(crate) ffi::skiac_sk_data);

impl SurfaceDataRef {
  pub fn slice(&self) -> &'static [u8] {
    unsafe { slice::from_raw_parts(self.0.ptr, self.0.size) }
  }
}

impl Drop for SurfaceDataRef {
  fn drop(&mut self) {
    unsafe { ffi::skiac_sk_data_destroy(self.0.data) }
  }
}

unsafe impl Send for SurfaceDataRef {}
unsafe impl Sync for SurfaceDataRef {}

impl<'a> DerefMut for SurfaceDataMut<'a> {
  #[inline]
  fn deref_mut(&mut self) -> &mut [u8] {
    self.slice
  }
}

#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct Color(pub u32);

impl Color {
  #[inline]
  pub fn from_rgba(r: u8, g: u8, b: u8, a: u8) -> Color {
    Color((a as u32) << 24 | (r as u32) << 16 | (g as u32) << 8 | (b as u32))
  }
}

#[repr(transparent)]
pub struct Canvas(*mut ffi::skiac_canvas);

impl Canvas {
  #[inline]
  pub fn clear(&mut self) {
    unsafe {
      ffi::skiac_canvas_clear(self.0, 0);
    }
  }

  #[inline]
  pub fn fill(&mut self, r: u8, g: u8, b: u8, a: u8) {
    unsafe {
      ffi::skiac_canvas_clear(
        self.0,
        (a as u32) << 24 | (r as u32) << 16 | (g as u32) << 8 | b as u32,
      );
    }
  }

  #[inline]
  pub fn set_transform(&mut self, ts: Transform) {
    unsafe {
      ffi::skiac_canvas_set_transform(self.0, ts.into());
    }
  }

  #[inline]
  pub fn concat(&mut self, ts: Transform) {
    unsafe {
      ffi::skiac_canvas_concat(self.0, ts.into());
    }
  }

  #[inline]
  pub fn scale(&mut self, sx: f32, sy: f32) {
    unsafe {
      ffi::skiac_canvas_scale(self.0, sx, sy);
    }
  }

  #[inline]
  pub fn translate(&mut self, dx: f32, dy: f32) {
    unsafe {
      ffi::skiac_canvas_translate(self.0, dx, dy);
    }
  }

  #[inline]
  pub fn rotate(&mut self, degrees: f32) {
    unsafe {
      ffi::skiac_canvas_rotate(self.0, degrees);
    }
  }

  #[inline]
  pub fn get_transform(&self) -> Transform {
    unsafe { ffi::skiac_canvas_get_total_transform(self.0).into() }
  }

  #[inline]
  pub fn get_transform_matrix(&self) -> Matrix {
    Matrix(unsafe { ffi::skiac_canvas_get_total_transform_matrix(self.0) })
  }

  #[inline]
  pub fn reset_transform(&mut self) {
    unsafe {
      ffi::skiac_canvas_reset_transform(self.0);
    }
  }

  #[inline]
  pub fn draw_color(&mut self, r: f32, g: f32, b: f32, a: f32) {
    unsafe {
      ffi::skiac_canvas_draw_color(self.0, r, g, b, a);
    }
  }

  #[inline]
  pub fn draw_image(
    &mut self,
    image: *mut ffi::skiac_bitmap,
    sx: f32,
    sy: f32,
    s_width: f32,
    s_height: f32,
    dx: f32,
    dy: f32,
    d_width: f32,
    d_height: f32,
    paint: &Paint,
  ) {
    unsafe {
      ffi::skiac_canvas_draw_image(
        self.0, image, sx, sy, s_width, s_height, dx, dy, d_width, d_height, paint.0,
      );
    }
  }

  #[inline]
  pub fn draw_path(&mut self, path: &Path, paint: &Paint) {
    unsafe {
      ffi::skiac_canvas_draw_path(self.0, path.0, paint.0);
    }
  }

  #[inline]
  pub fn draw_rect(&mut self, x: f32, y: f32, w: f32, h: f32, paint: &Paint) {
    unsafe {
      ffi::skiac_canvas_draw_rect(self.0, x, y, w, h, paint.0);
    }
  }

  #[inline]
  pub fn draw_text(
    &mut self,
    text: &str,
    x: f32,
    y: f32,
    max_width: f32,
    weight: u32,
    width: u32,
    slant: FontStyle,
    font_collection: &FontCollection,
    font_size: f32,
    font_family: &str,
    baseline: TextBaseline,
    align: TextAlign,
    paint: &Paint,
  ) {
    let c_text = std::ffi::CString::new(text).unwrap();
    let c_font_family = std::ffi::CString::new(font_family).unwrap();
    let metrics = FontMetrics::new(font_size, font_family);

    let align_factor = match align {
      TextAlign::Left | TextAlign::Start => 0f32,
      TextAlign::Right | TextAlign::End => -1f32,
      TextAlign::Center => -0.5f32,
      TextAlign::Justify => 0f32, // unsupported
    };
    let baseline_offset = metrics.get_baseline_offset(baseline) + metrics.get_descent();

    unsafe {
      ffi::skiac_canvas_draw_text(
        self.0,
        c_text.as_ptr(),
        text.len(),
        x,
        y,
        max_width,
        weight as i32,
        width as i32,
        slant as i32,
        font_collection.0,
        font_size,
        c_font_family.as_ptr(),
        baseline_offset,
        align as u8,
        align_factor,
        paint.0,
      );
    }
  }

  #[inline]
  pub fn get_line_metrics(
    &self,
    text: &str,
    font_collection: &FontCollection,
    font_size: f32,
    font_family: &str,
    align: TextAlign,
    paint: &Paint,
  ) -> ffi::skiac_line_metrics {
    let c_text = std::ffi::CString::new(text).unwrap();
    let c_font_family = std::ffi::CString::new(font_family).unwrap();

    let align_factor = match align {
      TextAlign::Left | TextAlign::Start => 0f32,
      TextAlign::Right | TextAlign::End => -1f32,
      TextAlign::Center => -0.5f32,
      TextAlign::Justify => 0f32, // unsupported
    };

    unsafe {
      ffi::skiac_canvas_get_line_metrics(
        c_text.as_ptr(),
        font_collection.0,
        font_size,
        c_font_family.as_ptr(),
        align as u8,
        align_factor,
        paint.0,
      )
    }
  }

  #[inline]
  pub fn draw_surface(
    &mut self,
    surface: &Surface,
    left: f32,
    top: f32,
    alpha: u8,
    blend_mode: BlendMode,
    filter_quality: FilterQuality,
  ) {
    unsafe {
      ffi::skiac_canvas_draw_surface(
        self.0,
        surface.ptr,
        left,
        top,
        alpha,
        blend_mode as i32,
        filter_quality as i32,
      );
    }
  }

  #[inline]
  pub fn draw_surface_rect(
    &mut self,
    surface: &Surface,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    filter_quality: FilterQuality,
  ) {
    unsafe {
      ffi::skiac_canvas_draw_surface_rect(self.0, surface.ptr, x, y, w, h, filter_quality as i32);
    }
  }

  #[inline]
  pub fn set_clip_rect(&mut self, x: f32, y: f32, w: f32, h: f32) {
    unsafe {
      ffi::skiac_canvas_clip_rect(self.0, x, y, w, h);
    }
  }

  #[inline]
  pub fn set_clip_path(&mut self, path: &Path) {
    unsafe {
      ffi::skiac_canvas_clip_path(self.0, path.0);
    }
  }

  #[inline]
  pub fn save(&mut self) {
    unsafe {
      ffi::skiac_canvas_save(self.0);
    }
  }

  #[inline]
  pub fn restore(&mut self) {
    unsafe {
      ffi::skiac_canvas_restore(self.0);
    }
  }

  #[inline]
  pub fn write_pixels(&mut self, image: &ImageData, x: u32, y: u32) {
    unsafe {
      ffi::skiac_canvas_write_pixels(
        self.0,
        image.width as i32,
        image.height as i32,
        image.data,
        (image.width * 4) as usize,
        x as i32,
        y as i32,
      );
    }
  }

  #[inline]
  pub fn write_pixels_dirty(
    &mut self,
    image: &ImageData,
    x: u32,
    y: u32,
    dirty_x: f64,
    dirty_y: f64,
    dirty_width: f64,
    dirty_height: f64,
  ) {
    unsafe {
      ffi::skiac_canvas_write_pixels_dirty(
        self.0,
        image.width as i32,
        image.height as i32,
        image.data,
        (image.width * 4) as usize,
        (image.width * image.height * 4) as usize,
        x as f32,
        y as f32,
        dirty_x as f32,
        dirty_y as f32,
        dirty_width as f32,
        dirty_height as f32,
      )
    }
  }
}

#[derive(Debug)]
pub struct Paint(*mut ffi::skiac_paint);

impl Clone for Paint {
  fn clone(&self) -> Self {
    Paint(unsafe { ffi::skiac_paint_clone(self.0) })
  }
}

impl Paint {
  #[inline]
  pub fn new() -> Paint {
    unsafe { Paint(ffi::skiac_paint_create()) }
  }

  #[inline]
  pub fn set_style(&mut self, style: PaintStyle) {
    unsafe {
      ffi::skiac_paint_set_style(self.0, style as i32);
    }
  }

  #[inline]
  pub fn set_color(&mut self, r: u8, g: u8, b: u8, a: u8) {
    unsafe {
      ffi::skiac_paint_set_color(self.0, r, g, b, a);
    }
  }

  #[inline]
  pub fn set_alpha(&mut self, a: u8) {
    unsafe {
      ffi::skiac_paint_set_alpha(self.0, a);
    }
  }

  #[inline]
  pub fn get_alpha(&self) -> u8 {
    unsafe { ffi::skiac_paint_get_alpha(self.0) }
  }

  #[inline]
  pub fn set_anti_alias(&mut self, aa: bool) {
    unsafe {
      ffi::skiac_paint_set_anti_alias(self.0, aa);
    }
  }

  #[inline]
  pub fn set_blend_mode(&mut self, blend_mode: BlendMode) {
    unsafe {
      ffi::skiac_paint_set_blend_mode(self.0, blend_mode as i32);
    }
  }

  #[inline]
  pub fn get_blend_mode(&self) -> BlendMode {
    unsafe { ffi::skiac_paint_get_blend_mode(self.0).into() }
  }

  #[inline]
  pub fn set_shader(&mut self, shader: &Shader) {
    unsafe {
      ffi::skiac_paint_set_shader(self.0, shader.0);
    }
  }

  #[inline]
  pub fn set_stroke_width(&mut self, width: f32) {
    unsafe {
      ffi::skiac_paint_set_stroke_width(self.0, width);
    }
  }

  #[inline]
  pub fn get_stroke_width(&self) -> f32 {
    unsafe { ffi::skiac_paint_get_stroke_width(self.0) }
  }

  #[inline]
  pub fn set_stroke_cap(&mut self, cap: StrokeCap) {
    unsafe {
      ffi::skiac_paint_set_stroke_cap(self.0, cap as i32);
    }
  }

  #[inline]
  pub fn get_stroke_cap(&self) -> StrokeCap {
    StrokeCap::from_raw(unsafe { ffi::skiac_paint_get_stroke_cap(self.0) }).unwrap()
  }

  #[inline]
  pub fn set_stroke_join(&mut self, join: StrokeJoin) {
    unsafe {
      ffi::skiac_paint_set_stroke_join(self.0, join as u8);
    }
  }

  #[inline]
  pub fn get_stroke_join(&self) -> StrokeJoin {
    StrokeJoin::from_raw(unsafe { ffi::skiac_paint_get_stroke_join(self.0) }).unwrap()
  }

  #[inline]
  pub fn set_stroke_miter(&mut self, miter: f32) {
    unsafe {
      ffi::skiac_paint_set_stroke_miter(self.0, miter as f32);
    }
  }

  #[inline]
  pub fn get_stroke_miter(&self) -> f32 {
    unsafe { ffi::skiac_paint_get_stroke_miter(self.0) }
  }

  #[inline]
  pub fn set_path_effect(&mut self, path_effect: &PathEffect) {
    unsafe {
      ffi::skiac_paint_set_path_effect(self.0, path_effect.0);
    }
  }

  #[inline]
  pub fn set_mask_filter(&mut self, mask_filter: &MaskFilter) {
    unsafe {
      ffi::skiac_paint_set_mask_filter(self.0, mask_filter.0);
    }
  }

  #[inline]
  pub fn set_image_filter(&mut self, image_filter: &ImageFilter) {
    unsafe {
      ffi::skiac_paint_set_image_filter(self.0, image_filter.0);
    }
  }
}

impl Default for Paint {
  fn default() -> Self {
    let mut paint = Self::new();
    paint.set_color(255, 255, 255, 255);
    paint.set_stroke_miter(10.0);
    paint.set_anti_alias(true);
    paint.set_stroke_cap(StrokeCap::Butt);
    paint.set_stroke_join(StrokeJoin::Miter);
    paint.set_stroke_width(1.0);
    paint.set_blend_mode(BlendMode::SourceOver);
    paint.set_alpha(255);
    paint
  }
}

impl Drop for Paint {
  #[inline]
  fn drop(&mut self) {
    unsafe { ffi::skiac_paint_destroy(self.0) }
  }
}

#[repr(transparent)]
#[derive(Debug)]
pub struct Path(pub(crate) *mut ffi::skiac_path);

impl Clone for Path {
  fn clone(&self) -> Path {
    Path(unsafe { ffi::skiac_path_clone(self.0) })
  }
}

impl Path {
  #[inline]
  pub fn new() -> Path {
    unsafe { Path(ffi::skiac_path_create()) }
  }

  #[inline]
  pub fn from_svg_path(path: &str) -> Option<Path> {
    let path_str = CString::new(path).ok()?;
    let p = unsafe { ffi::skiac_path_from_svg(path_str.into_raw()) };
    if p.is_null() {
      None
    } else {
      Some(Path(p))
    }
  }

  #[inline]
  pub fn add_path(&mut self, sub_path: &Path, transform: Transform) {
    unsafe { ffi::skiac_add_path(self.0, sub_path.0, transform.into()) };
  }

  #[inline]
  pub fn op(&self, other: &Path, op: PathOp) -> bool {
    unsafe { ffi::skiac_path_op(self.0, other.0, op as i32) }
  }

  #[inline]
  pub fn set_fill_type(&mut self, kind: FillType) {
    unsafe {
      ffi::skiac_path_set_fill_type(self.0, kind as i32);
    }
  }

  #[inline]
  pub fn get_fill_type(&mut self) -> i32 {
    unsafe { ffi::skiac_path_get_fill_type(self.0) }
  }

  #[inline(always)]
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
    // based off of CanonicalizeAngle in Chrome
    let tau = 2.0 * PI;
    let mut new_start_angle = start_angle % tau;
    if new_start_angle < 0.0 {
      new_start_angle += tau;
    }
    let delta = new_start_angle - start_angle;
    let start_angle = new_start_angle;
    let mut end_angle = end_angle + delta;

    // Based off of AdjustEndAngle in Chrome.
    if !ccw && (end_angle - start_angle) >= tau {
      end_angle = start_angle + tau; // Draw complete ellipse
    } else if ccw && (start_angle - end_angle) >= tau {
      end_angle = start_angle - tau; // Draw complete ellipse
    } else if !ccw && start_angle > end_angle {
      end_angle = start_angle + (tau - (start_angle - end_angle) % tau);
    } else if ccw && start_angle < end_angle {
      end_angle = start_angle - (tau - (end_angle - start_angle) % tau);
    }

    // Based off of Chrome's implementation in
    // https://cs.chromium.org/chromium/src/third_party/blink/renderer/platform/graphics/path.cc
    // of note, can't use addArc or addOval because they close the arc, which
    // the spec says not to do (unless the user explicitly calls closePath).
    // This throws off points being in/out of the arc.
    let left = x - radius_x;
    let top = y - radius_y;
    let right = x + radius_x;
    let bottom = y + radius_y;
    let mut rotated = Matrix::identity();
    rotated.pre_translate(x, y);
    rotated.pre_rotate(radians_to_degrees(rotation));
    rotated.pre_translate(-x, -y);
    let unrotated = rotated.invert().unwrap();

    self.transform_matrix(&unrotated);

    // draw in 2 180 degree segments because trying to draw all 360 degrees at once
    // draws nothing.
    let sweep_deg = radians_to_degrees(end_angle - start_angle);
    let start_deg = radians_to_degrees(start_angle);
    if almost_equal(sweep_deg.abs(), 360.0) {
      let half_sweep = sweep_deg / 2.0;
      self.arc_to(left, top, right, bottom, start_deg, half_sweep, false);
      self.arc_to(
        x - radius_x,
        y - radius_y,
        x + radius_x,
        y + radius_y,
        start_deg + half_sweep,
        half_sweep,
        false,
      );
    } else {
      self.arc_to(left, top, right, bottom, start_deg, sweep_deg, false);
    }

    self.transform_matrix(&rotated);
  }

  #[inline(always)]
  pub fn arc(
    &mut self,
    center_x: f32,
    center_y: f32,
    radius: f32,
    start_angle: f32,
    end_angle: f32,
    from_end: bool,
  ) {
    self.ellipse(
      center_x,
      center_y,
      radius,
      radius,
      0.0,
      start_angle,
      end_angle,
      from_end,
    )
  }

  #[inline]
  pub fn arc_to(
    &mut self,
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
    start_angle: f32,
    sweep_angle: f32,
    force_move_to: bool,
  ) {
    unsafe {
      ffi::skiac_path_arc_to(
        self.0,
        left,
        top,
        right,
        bottom,
        start_angle,
        sweep_angle,
        force_move_to,
      )
    }
  }

  #[inline]
  pub fn arc_to_tangent(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, radius: f32) {
    unsafe { ffi::skiac_path_arc_to_tangent(self.0, x1, y1, x2, y2, radius) }
  }

  #[inline]
  pub fn move_to(&mut self, x: f32, y: f32) {
    unsafe {
      ffi::skiac_path_move_to(self.0, x, y);
    }
  }

  #[inline]
  pub fn line_to(&mut self, x: f32, y: f32) {
    unsafe {
      ffi::skiac_path_line_to(self.0, x, y);
    }
  }

  #[inline]
  pub fn cubic_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x3: f32, y3: f32) {
    unsafe {
      ffi::skiac_path_cubic_to(self.0, x1, y1, x2, y2, x3, y3);
    }
  }

  #[inline]
  pub fn quad_to(&mut self, cpx: f32, cpy: f32, x: f32, y: f32) {
    unsafe {
      ffi::skiac_path_quad_to(self.0, cpx, cpy, x, y);
    }
  }

  #[inline]
  pub fn close(&mut self) {
    unsafe {
      ffi::skiac_path_close(self.0);
    }
  }

  #[inline]
  pub fn add_rect(&mut self, l: f32, t: f32, r: f32, b: f32) {
    unsafe {
      ffi::skiac_path_add_rect(self.0, l, t, r, b);
    }
  }

  #[inline]
  pub fn push_circle(&mut self, x: f32, y: f32, r: f32) {
    unsafe {
      ffi::skiac_path_add_circle(self.0, x, y, r);
    }
  }

  #[inline]
  pub fn transform(&mut self, transform: &Transform) {
    unsafe { ffi::skiac_path_transform(self.0, transform.into()) };
  }

  #[inline]
  pub fn transform_matrix(&mut self, matrix: &Matrix) {
    unsafe { ffi::skiac_path_transform_matrix(self.0, matrix.0) };
  }

  #[inline]
  pub fn is_empty(&self) -> bool {
    unsafe { ffi::skiac_path_is_empty(self.0) }
  }

  #[inline]
  pub fn hit_test(&self, x: f32, y: f32, kind: FillType) -> bool {
    unsafe { ffi::skiac_path_hit_test(self.0, x, y, kind as i32) }
  }

  #[inline]
  pub fn stroke_hit_test(&self, x: f32, y: f32, stroke_w: f32) -> bool {
    unsafe { ffi::skiac_path_stroke_hit_test(self.0, x, y, stroke_w) }
  }

  #[inline]
  pub fn to_svg_string(&self) -> SkiaString {
    let mut string = SkiaString {
      ptr: ptr::null_mut(),
      length: 0,
      sk_string: ptr::null_mut(),
    };
    unsafe { ffi::skiac_path_to_svg_string(self.0, &mut string) };
    string
  }

  #[inline]
  pub fn simplify(&mut self) -> bool {
    unsafe { ffi::skiac_path_simplify(self.0) }
  }

  #[inline]
  pub fn as_winding(&mut self) -> bool {
    unsafe { ffi::skiac_path_as_winding(self.0) }
  }

  #[inline]
  pub fn stroke(&mut self, cap: StrokeCap, join: StrokeJoin, width: f32, miter_limit: f32) -> bool {
    unsafe { ffi::skiac_path_stroke(self.0, cap as i32, join as u8, width, miter_limit) }
  }

  #[inline]
  pub fn compute_tight_bounds(&self) -> (f32, f32, f32, f32) {
    let mut rect = ffi::skiac_rect {
      left: 0.0f32,
      top: 0.0f32,
      right: 0.0f32,
      bottom: 0.0f32,
    };
    unsafe { ffi::skiac_path_compute_tight_bounds(self.0, &mut rect) };
    (rect.left, rect.top, rect.right, rect.bottom)
  }

  #[inline]
  pub fn get_bounds(&self) -> (f32, f32, f32, f32) {
    let mut rect = ffi::skiac_rect {
      left: 0.0f32,
      top: 0.0f32,
      right: 0.0f32,
      bottom: 0.0f32,
    };
    unsafe { ffi::skiac_path_get_bounds(self.0, &mut rect) };
    (rect.left, rect.top, rect.right, rect.bottom)
  }

  #[inline]
  pub fn trim(&mut self, start: f32, end: f32, is_complement: bool) -> bool {
    unsafe { ffi::skiac_path_trim(self.0, start, end, is_complement) }
  }

  #[inline]
  pub fn dash(&mut self, on: f32, off: f32, phase: f32) -> bool {
    unsafe { ffi::skiac_path_dash(self.0, on, off, phase) }
  }
}

impl PartialEq for Path {
  fn eq(&self, other: &Path) -> bool {
    unsafe { ffi::skiac_path_equals(self.0, other.0) }
  }
}

impl Drop for Path {
  #[inline]
  fn drop(&mut self) {
    unsafe {
      ffi::skiac_path_destroy(self.0);
    }
  }
}

#[derive(Debug, Clone)]
pub struct Gradient {
  pub colors: Vec<Color>,
  pub positions: Vec<f32>,
  pub tile_mode: TileMode,
  pub transform: Transform,
}

#[derive(Debug, Clone)]
pub struct LinearGradient {
  pub start_point: (f32, f32),
  pub end_point: (f32, f32),
  pub base: Gradient,
}

#[derive(Debug, Clone)]
pub struct RadialGradient {
  pub start: (f32, f32),
  pub start_radius: f32,
  pub end: (f32, f32),
  pub end_radius: f32,
  pub base: Gradient,
}

#[derive(Debug, Clone)]
pub struct ConicGradient {
  pub center: (f32, f32),
  pub radius: f32,
  pub base: Gradient,
}

#[derive(Debug, Clone)]
pub struct Shader(*mut ffi::skiac_shader);

impl Shader {
  #[inline]
  pub fn new_linear_gradient(grad: &LinearGradient) -> Option<Shader> {
    let points = [
      ffi::skiac_point {
        x: grad.start_point.0,
        y: grad.start_point.1,
      },
      ffi::skiac_point {
        x: grad.end_point.0,
        y: grad.end_point.1,
      },
    ];

    unsafe {
      Self::from_ptr(ffi::skiac_shader_make_linear_gradient(
        points.as_ptr(),
        grad.base.colors.as_ptr(),
        grad.base.positions.as_ptr(),
        grad.base.colors.len() as i32,
        grad.base.tile_mode as i32,
        0_u32,
        grad.base.transform.into(),
      ))
    }
  }

  #[inline]
  pub fn new_radial_gradient(grad: &RadialGradient) -> Option<Shader> {
    let start_point = ffi::skiac_point {
      x: grad.start.0,
      y: grad.start.1,
    };
    let end_point = ffi::skiac_point {
      x: grad.end.0,
      y: grad.end.1,
    };

    unsafe {
      Self::from_ptr(ffi::skiac_shader_make_radial_gradient(
        start_point,
        grad.start_radius,
        end_point,
        grad.end_radius,
        grad.base.colors.as_ptr(),
        grad.base.positions.as_ptr(),
        grad.base.colors.len() as i32,
        grad.base.tile_mode as i32,
        0_u32,
        grad.base.transform.into(),
      ))
    }
  }

  #[inline]
  pub fn new_conic_gradient(grad: &ConicGradient) -> Option<Shader> {
    unsafe {
      Self::from_ptr(ffi::skiac_shader_make_conic_gradient(
        grad.center.0,
        grad.center.1,
        grad.radius,
        grad.base.colors.as_ptr(),
        grad.base.positions.as_ptr(),
        grad.base.colors.len() as i32,
        grad.base.tile_mode as i32,
        0_u32,
        grad.base.transform.into(),
      ))
    }
  }

  #[inline]
  pub fn new_from_surface_image(
    surface: &Surface,
    ts: Transform,
    q: FilterQuality,
  ) -> Option<Shader> {
    unsafe {
      Self::from_ptr(ffi::skiac_shader_make_from_surface_image(
        surface.ptr,
        ts.into(),
        q as i32,
      ))
    }
  }

  #[inline]
  pub fn from_bitmap(
    bitmap: *mut ffi::skiac_bitmap,
    repeat_x: TileMode,
    repeat_y: TileMode,
    b: f32,
    c: f32,
    ts: Transform,
  ) -> Option<Shader> {
    unsafe {
      let shader_ptr =
        ffi::skiac_bitmap_get_shader(bitmap, repeat_x as i32, repeat_y as i32, b, c, ts.into());
      Shader::from_ptr(shader_ptr)
    }
  }

  #[inline]
  unsafe fn from_ptr(ptr: *mut ffi::skiac_shader) -> Option<Shader> {
    if ptr.is_null() {
      None
    } else {
      Some(Shader(ptr))
    }
  }
}

impl Drop for Shader {
  #[inline]
  fn drop(&mut self) {
    unsafe {
      ffi::skiac_shader_destroy(self.0);
    }
  }
}

pub struct PathEffect(*mut ffi::skiac_path_effect);

impl PathEffect {
  #[inline]
  pub fn new_dash_path(intervals: &[f32], phase: f32) -> Option<PathEffect> {
    unsafe {
      let ptr =
        ffi::skiac_path_effect_make_dash_path(intervals.as_ptr(), intervals.len() as i32, phase);

      if ptr.is_null() {
        None
      } else {
        Some(PathEffect(ptr))
      }
    }
  }
}

impl Drop for PathEffect {
  #[inline]
  fn drop(&mut self) {
    unsafe {
      ffi::skiac_path_effect_destroy(self.0);
    }
  }
}

#[repr(transparent)]
pub struct Matrix(*mut ffi::skiac_matrix);

impl Matrix {
  #[inline(always)]
  pub fn identity() -> Self {
    Matrix(unsafe { ffi::skiac_matrix_create() })
  }

  #[inline(always)]
  pub fn pre_translate(&mut self, dx: f32, dy: f32) {
    unsafe { ffi::skiac_matrix_pre_translate(self.0, dx, dy) };
  }

  #[inline(always)]
  pub fn pre_rotate(&mut self, degrees: f32) {
    unsafe { ffi::skiac_matrix_pre_rotate(self.0, degrees) };
  }

  #[inline(always)]
  pub fn into_transform(self) -> Transform {
    unsafe { ffi::skiac_matrix_to_transform(self.0) }.into()
  }

  #[inline(always)]
  pub fn invert(&self) -> Option<Matrix> {
    let m = Matrix::identity();
    if unsafe { ffi::skiac_matrix_invert(self.0, m.0) } {
      Some(m)
    } else {
      None
    }
  }
}

impl Clone for Matrix {
  fn clone(&self) -> Self {
    Matrix(unsafe { ffi::skiac_matrix_clone(self.0) })
  }
}

impl Drop for Matrix {
  fn drop(&mut self) {
    unsafe { ffi::skiac_matrix_destroy(self.0) };
  }
}

#[derive(Copy, Clone, PartialEq, Debug)]
pub struct Transform {
  pub a: f32,
  pub b: f32,
  pub c: f32,
  pub d: f32,
  pub e: f32,
  pub f: f32,
}

impl Transform {
  #[inline]
  pub fn new(a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) -> Self {
    Transform { a, b, c, d, e, f }
  }

  #[inline]
  pub fn rotate(radians: f32) -> Self {
    let sin_v = radians.sin();
    let cos_v = radians.cos();

    Self {
      a: cos_v,
      b: -sin_v,
      c: 0f32,
      d: sin_v,
      e: cos_v,
      f: 0f32,
    }
  }

  #[inline]
  /// | A B C |    | A/X B/X C/X |
  /// | D E F | -> | D/X E/X F/X |   for X != 0
  /// | 0 0 X |    |  0   0   1  |
  /// [interface.js](skia/modules/canvaskit/interface.js)
  pub fn map_points(&self, pt_arr: &mut [f32]) {
    let mut i = 0usize;
    while i < pt_arr.len() {
      let x = pt_arr[i];
      let y = pt_arr[i + 1];
      // Gx+Hy+I
      let denom = 1f32;
      // Ax+By+C
      let x_trans = self.a * x + self.c * y + self.e;
      // Dx+Ey+F
      let y_trans = self.b * x + self.d * y + self.f;
      pt_arr[i] = x_trans / denom;
      pt_arr[i + 1] = y_trans / denom;
      i += 2;
    }
  }

  #[inline]
  /// | A C E |
  /// | B D F |
  /// | 0 0 1 |
  /// [interface.js](skia/modules/canvaskit/interface.js)
  pub fn invert(&self) -> Option<Self> {
    let m = [
      self.a, self.c, self.e, self.b, self.d, self.f, 0f32, 0f32, 1f32,
    ];
    // Find the determinant by the sarrus rule. https://en.wikipedia.org/wiki/Rule_of_Sarrus
    let det = m[0] * m[4] * m[8] + m[1] * m[5] * m[6] + m[2] * m[3] * m[7]
      - m[2] * m[4] * m[6]
      - m[1] * m[3] * m[8]
      - m[0] * m[5] * m[7];
    if det == 0f32 {
      return None;
    }
    // Return the inverse by the formula adj(m)/det.
    // adj (adjugate) of a 3x3 is the transpose of it's cofactor matrix.
    // a cofactor matrix is a matrix where each term is +-det(N) where matrix N is the 2x2 formed
    // by removing the row and column we're currently setting from the source.
    // the sign alternates in a checkerboard pattern with a `+` at the top left.
    // that's all been combined here into one expression.
    Some(Transform {
      a: (m[4] * m[8] - m[5] * m[7]) / det,
      b: (m[2] * m[7] - m[1] * m[8]) / det,
      c: (m[1] * m[5] - m[2] * m[4]) / det,
      d: (m[5] * m[6] - m[3] * m[8]) / det,
      e: (m[0] * m[8] - m[2] * m[6]) / det,
      f: (m[2] * m[3] - m[0] * m[5]) / det,
    })
  }
}

impl Default for Transform {
  fn default() -> Self {
    Transform::new(1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
  }
}

impl From<ffi::skiac_transform> for Transform {
  #[inline]
  fn from(ts: ffi::skiac_transform) -> Self {
    Transform::new(ts.a, ts.b, ts.c, ts.d, ts.e, ts.f)
  }
}

impl From<Transform> for ffi::skiac_transform {
  #[inline]
  fn from(ts: Transform) -> Self {
    ffi::skiac_transform {
      a: ts.a,
      b: ts.b,
      c: ts.c,
      d: ts.d,
      e: ts.e,
      f: ts.f,
    }
  }
}

impl<'a> From<&'a Transform> for ffi::skiac_transform {
  #[inline]
  fn from(ts: &'a Transform) -> Self {
    ffi::skiac_transform {
      a: ts.a,
      b: ts.b,
      c: ts.c,
      d: ts.d,
      e: ts.e,
      f: ts.f,
    }
  }
}

#[repr(transparent)]
#[derive(Debug)]
pub struct MaskFilter(*mut ffi::skiac_mask_filter);

impl MaskFilter {
  pub fn make_blur(radius: f32) -> Option<Self> {
    let raw_ptr = unsafe { ffi::skiac_mask_filter_make_blur(radius) };
    if raw_ptr.is_null() {
      None
    } else {
      Some(MaskFilter(raw_ptr))
    }
  }
}

impl Drop for MaskFilter {
  fn drop(&mut self) {
    unsafe { ffi::skiac_mask_filter_destroy(self.0) };
  }
}

#[repr(transparent)]
#[derive(Debug)]
pub struct ImageFilter(*mut ffi::skiac_image_filter);

impl ImageFilter {
  pub fn make_drop_shadow(
    dx: f32,
    dy: f32,
    sigma_x: f32,
    sigma_y: f32,
    color: u32,
  ) -> Option<Self> {
    let raw_ptr =
      unsafe { ffi::skiac_image_filter_make_drop_shadow(dx, dy, sigma_x, sigma_y, color) };
    if raw_ptr.is_null() {
      None
    } else {
      Some(ImageFilter(raw_ptr))
    }
  }
}

impl Drop for ImageFilter {
  fn drop(&mut self) {
    unsafe { ffi::skiac_image_filter_destroy(self.0) };
  }
}

#[derive(Debug)]
pub struct Bitmap {
  pub width: usize,
  pub height: usize,
  pub bitmap: *mut ffi::skiac_bitmap,
}

impl Bitmap {
  #[inline]
  pub fn from_buffer(ptr: *mut u8, size: usize) -> Self {
    unsafe {
      let bitmap = ffi::skiac_bitmap_make_from_buffer(ptr, size);

      Bitmap {
        width: ffi::skiac_bitmap_get_width(bitmap) as usize,
        height: ffi::skiac_bitmap_get_height(bitmap) as usize,
        bitmap,
      }
    }
  }

  #[inline]
  pub fn from_svg_data(data: *const u8, size: usize) -> Option<Self> {
    unsafe {
      let bitmap = ffi::skiac_bitmap_make_from_svg(data, size);

      if bitmap.is_null() {
        return None;
      }
      Some(Bitmap {
        width: ffi::skiac_bitmap_get_width(bitmap) as usize,
        height: ffi::skiac_bitmap_get_height(bitmap) as usize,
        bitmap,
      })
    }
  }

  #[inline]
  pub fn from_image_data(
    ptr: *mut u8,
    width: usize,
    height: usize,
    row_bytes: usize,
    size: usize,
    color_type: ColorType,
    alpha_type: AlphaType,
  ) -> Self {
    let bitmap = unsafe {
      ffi::skiac_bitmap_make_from_image_data(
        ptr,
        width,
        height,
        row_bytes,
        size,
        color_type as i32,
        alpha_type as i32,
      )
    };
    Bitmap {
      bitmap,
      width: row_bytes,
      height: size / row_bytes / 4usize,
    }
  }
}

impl Drop for Bitmap {
  fn drop(&mut self) {
    unsafe {
      ffi::skiac_bitmap_destroy(self.bitmap);
    }
  }
}

#[derive(Debug, Clone)]
pub struct ImagePattern {
  pub(crate) bitmap: *mut ffi::skiac_bitmap,
  pub(crate) repeat_x: TileMode,
  pub(crate) repeat_y: TileMode,
  pub(crate) transform: Transform,
}

impl ImagePattern {
  #[inline(always)]
  pub(crate) fn get_shader(&self) -> Option<Shader> {
    Shader::from_bitmap(
      self.bitmap,
      self.repeat_x,
      self.repeat_y,
      1.0 / 3.0,
      1.0 / 3.0,
      self.transform,
    )
  }
}

#[repr(C)]
#[derive(Clone, Debug)]
pub struct SkiaString {
  pub ptr: *const c_char,
  pub length: usize,
  sk_string: *mut ffi::skiac_sk_string,
}

impl Drop for SkiaString {
  fn drop(&mut self) {
    unsafe { ffi::skiac_delete_sk_string(self.sk_string) }
  }
}

#[derive(Debug, Clone)]
pub struct FontMetrics(pub *mut ffi::skiac_font_metrics);

impl FontMetrics {
  #[inline]
  pub fn new(font_size: f32, font_family: &str) -> FontMetrics {
    unsafe {
      let c_font_family = std::ffi::CString::new(font_family).unwrap();
      let c_font_metrics = ffi::skiac_font_metrics_create(c_font_family.as_ptr(), font_size);
      FontMetrics(c_font_metrics)
    }
  }

  #[inline]
  pub fn get_baseline_offset(&self, baseline: TextBaseline) -> f32 {
    unsafe {
      let metrics_ref = &*self.0;
      match baseline {
        TextBaseline::Top => -metrics_ref.ascent,
        TextBaseline::Hanging => metrics_ref.cap_height,
        TextBaseline::Middle => metrics_ref.cap_height / 2.0,
        TextBaseline::Alphabetic => 0.0,
        TextBaseline::Ideographic => -metrics_ref.descent,
        TextBaseline::Bottom => -metrics_ref.descent,
      }
    }
  }

  #[inline]
  pub fn get_descent(&self) -> f32 {
    unsafe {
      let metrics_ref = &*self.0;
      metrics_ref.descent
    }
  }
}

impl Drop for FontMetrics {
  #[inline]
  fn drop(&mut self) {
    unsafe { ffi::skiac_font_metrics_destroy(self.0) }
  }
}

#[derive(Debug, Clone)]
pub struct LineMetrics(pub ffi::skiac_line_metrics);

#[derive(Debug)]
pub struct FontCollection(pub *mut ffi::skiac_font_collection);

impl FontCollection {
  #[inline]
  pub fn new() -> FontCollection {
    unsafe {
      let c_font_collection = ffi::skiac_font_collection_create();
      FontCollection(c_font_collection)
    }
  }

  #[inline]
  pub fn get_families(&self) -> Vec<String> {
    let mut names = Vec::new();
    unsafe {
      let size = ffi::skiac_font_collection_get_default_fonts_count(self.0);
      for i in 0..size {
        let mut name = SkiaString {
          ptr: ptr::null_mut(),
          length: 0,
          sk_string: ptr::null_mut(),
        };
        ffi::skiac_font_collection_get_family(self.0, i, &mut name);
        let c_str: &CStr = CStr::from_ptr(name.ptr);
        names.push(c_str.to_string_lossy().into_owned());
      }
    }
    names
  }

  #[inline]
  pub fn register(&self, font: &[u8]) -> bool {
    unsafe { ffi::skiac_font_collection_register(self.0, font.as_ptr(), font.len()) > 0 }
  }

  #[inline]
  pub fn register_from_path(&self, font_path: &str) -> bool {
    if let Ok(fp) = CString::new(font_path) {
      unsafe { ffi::skiac_font_collection_register_from_path(self.0, fp.as_ptr()) > 0 }
    } else {
      false
    }
  }
}

impl Clone for FontCollection {
  fn clone(&self) -> FontCollection {
    unsafe {
      let c_font_collection = ffi::skiac_font_collection_clone(self.0);
      FontCollection(c_font_collection)
    }
  }
}

impl Drop for FontCollection {
  #[inline]
  fn drop(&mut self) {
    unsafe { ffi::skiac_font_collection_destroy(self.0) }
  }
}

#[inline(always)]
fn radians_to_degrees(rad: f32) -> f32 {
  (rad / PI) * 180.0
}

#[inline(always)]
fn almost_equal(floata: f32, floatb: f32) -> bool {
  (floata - floatb).abs() < 0.00001
}
