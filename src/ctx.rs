use std::f32::consts::PI;
use std::mem;
use std::result;
use std::slice;
use std::str::FromStr;

use cssparser::{Color as CSSColor, Parser, ParserInput, RGBA};
use libavif::AvifData;
use napi::{bindgen_prelude::*, JsBuffer, JsString, NapiRaw, NapiValue};

use crate::global_fonts::get_font;
use crate::{
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
    AlphaType, Bitmap, BlendMode, ColorSpace, FillType, ImageFilter, LineMetrics, MaskFilter,
    Matrix, Paint, PaintStyle, Path as SkPath, PathEffect, SkEncodedImageFormat, SkWMemoryStream,
    SkiaDataRef, Surface, SurfaceRef, Transform,
  },
  state::Context2dRenderingState,
  CanvasElement, SVGCanvas,
};

impl From<SkError> for Error {
  fn from(err: SkError) -> Error {
    Error::new(Status::InvalidArg, format!("{}", err))
  }
}

pub(crate) const MAX_TEXT_WIDTH: f32 = 100_000.0;
pub(crate) const FILL_STYLE_HIDDEN_NAME: &str = "_fillStyle";
pub(crate) const STROKE_STYLE_HIDDEN_NAME: &str = "_strokeStyle";

pub struct Context {
  pub(crate) surface: Surface,
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
    let mut new_sub_path = SkPath::new();
    self.path.swap(&mut new_sub_path);
  }

  pub fn bezier_curve_to(&mut self, cp1x: f32, cp1y: f32, cp2x: f32, cp2y: f32, x: f32, y: f32) {
    self.path.cubic_to(cp1x, cp1y, cp2x, cp2y, x, y);
  }

  pub fn quadratic_curve_to(&mut self, cpx: f32, cpy: f32, x: f32, y: f32) {
    self.path.quad_to(cpx, cpy, x, y);
  }

  pub fn clip(&mut self, path: Option<&mut SkPath>, fill_rule: FillType) {
    let clip = match path {
      Some(path) => path,
      None => &mut self.path,
    };
    clip.set_fill_type(fill_rule);
    self.surface.canvas.set_clip_path(clip);
  }

  pub fn clear_rect(&mut self, x: f32, y: f32, width: f32, height: f32) {
    let mut paint = Paint::new();
    paint.set_style(PaintStyle::Fill);
    paint.set_color(0, 0, 0, 0);
    paint.set_stroke_miter(10.0);
    paint.set_blend_mode(BlendMode::Clear);
    self.surface.draw_rect(x, y, width, height, &paint);
  }

  pub fn close_path(&mut self) {
    self.path.close();
  }

  pub fn rect(&mut self, x: f32, y: f32, width: f32, height: f32) {
    self.path.add_rect(x, y, width, height);
  }

  pub fn save(&mut self) {
    self.surface.canvas.save();
    self.states.push(self.state.clone());
  }

  pub fn restore(&mut self) {
    if let Some(s) = self.states.pop() {
      self.path.transform_self(&self.state.transform);
      self.surface.canvas.restore();
      self.path.transform_self(&s.transform.invert().unwrap());
      self.state = s;
    }
  }

  pub fn stroke_rect(&mut self, x: f32, y: f32, w: f32, h: f32) -> result::Result<(), SkError> {
    let stroke_paint = self.stroke_paint()?;
    if let Some(shadow_paint) = self.shadow_blur_paint(&stroke_paint) {
      let surface = &mut self.surface;
      let last_state = &self.state;
      surface.save();
      Self::apply_shadow_offset_matrix(
        surface,
        last_state.shadow_offset_x,
        last_state.shadow_offset_y,
      )?;
      surface.draw_rect(x, y, w, h, &shadow_paint);
      surface.restore();
    };

    self.surface.draw_rect(x, y, w, h, &stroke_paint);

    Ok(())
  }

  pub fn translate(&mut self, x: f32, y: f32) {
    let s = &mut self.state;
    let inverse = Matrix::translated(-x, -y);
    self.path.transform_self(&inverse);
    s.transform.pre_translate(x, y);
    self.surface.canvas.set_transform(&s.transform);
  }

  pub fn transform(&mut self, ts: Matrix) -> result::Result<(), SkError> {
    let s = &mut self.state;
    self.path.transform_self(
      &ts
        .invert()
        .ok_or_else(|| SkError::InvalidTransform(ts.clone()))?,
    );
    s.transform = ts.multiply(&s.transform);
    self.surface.set_transform(&s.transform);
    Ok(())
  }

  pub fn rotate(&mut self, angle: f32) {
    let s = &mut self.state;
    let degrees = angle as f32 / PI * 180f32;
    let inverse = Matrix::rotated(-angle, 0.0, 0.0);
    self.path.transform_self(&inverse);
    s.transform.pre_rotate(degrees);
    self.surface.canvas.set_transform(&s.transform);
  }

  pub fn scale(&mut self, x: f32, y: f32) {
    let s = &mut self.state;
    let mut inverse = Matrix::identity();
    inverse.pre_scale(1f32 / x, 1f32 / y);
    self.path.transform_self(&inverse);
    s.transform.pre_scale(x, y);
    self.surface.canvas.set_transform(&s.transform);
  }

  pub fn set_transform(&mut self, ts: Matrix) {
    self.surface.canvas.set_transform(&ts);
    self.state.transform = ts;
  }

  pub fn reset_transform(&mut self) {
    self.surface.canvas.reset_transform();
    self.state.transform = Matrix::identity();
  }

  pub fn stroke_text(
    &mut self,
    text: &str,
    x: f32,
    y: f32,
    max_width: f32,
  ) -> result::Result<(), SkError> {
    let stroke_paint = self.stroke_paint()?;
    self.draw_text(
      text.replace('\n', " ").as_str(),
      x,
      y,
      max_width,
      &stroke_paint,
    )?;
    Ok(())
  }

  pub fn fill_rect(&mut self, x: f32, y: f32, w: f32, h: f32) -> result::Result<(), SkError> {
    let fill_paint = self.fill_paint()?;
    if let Some(shadow_paint) = self.shadow_blur_paint(&fill_paint) {
      let surface = &mut self.surface;
      let last_state = &self.state;
      surface.save();
      Self::apply_shadow_offset_matrix(
        surface,
        last_state.shadow_offset_x,
        last_state.shadow_offset_y,
      )?;
      surface.draw_rect(x, y, w, h, &shadow_paint);
      surface.restore();
    };

    self.surface.draw_rect(x, y, w, h, &fill_paint);

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
    self.draw_text(
      text.replace('\n', " ").as_str(),
      x,
      y,
      max_width,
      &fill_paint,
    )?;
    Ok(())
  }

  pub fn stroke(&mut self, path: Option<&mut SkPath>) -> Result<()> {
    let last_state = &self.state;
    let p = match path {
      Some(path) => path,
      None => &self.path,
    };
    let stroke_paint = self.stroke_paint()?;
    if let Some(shadow_paint) = self.shadow_blur_paint(&stroke_paint) {
      let surface = &mut self.surface;
      surface.save();
      Self::apply_shadow_offset_matrix(
        surface,
        last_state.shadow_offset_x,
        last_state.shadow_offset_y,
      )?;
      self.surface.canvas.draw_path(p, &shadow_paint);
      self.surface.restore();
      mem::drop(shadow_paint);
    }
    self.surface.canvas.draw_path(p, &stroke_paint);
    Ok(())
  }

  pub fn fill(
    &mut self,
    path: Option<&mut SkPath>,
    fill_rule: FillType,
  ) -> result::Result<(), SkError> {
    let last_state = &self.state;
    let p = if let Some(p) = path {
      p.set_fill_type(fill_rule);
      p
    } else {
      self.path.set_fill_type(fill_rule);
      &self.path
    };
    let fill_paint = self.fill_paint()?;
    if let Some(shadow_paint) = self.shadow_blur_paint(&fill_paint) {
      let surface = &mut self.surface;
      surface.save();
      Self::apply_shadow_offset_matrix(
        surface,
        last_state.shadow_offset_x,
        last_state.shadow_offset_y,
      )?;
      surface.canvas.draw_path(p, &shadow_paint);
      surface.restore();
      mem::drop(shadow_paint);
    }
    self.surface.draw_path(p, &fill_paint);
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
        paint.set_color(color.red, color.green, color.blue, color.alpha);
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
        css_filter(filter_str).map_err(|e| SkError::StringToFillRuleError(format!("{}", e)))?;
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
    self.state.font = font;
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
      .map_err(|e| SkError::Generic(format!("Parse color [{}] error: {:?}", &shadow_color, e)))?;

    match color {
      CSSColor::CurrentColor => {
        return Err(SkError::Generic(
          "Color should not be `currentcolor` keyword".to_owned(),
        ))
      }
      CSSColor::RGBA(rgba) => {
        drop(parser_input);
        self.state.shadow_color_string = shadow_color;
        self.state.shadow_color = rgba;
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

  pub fn get_image_data(
    &mut self,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    color_type: ColorSpace,
  ) -> Option<Vec<u8>> {
    self
      .surface
      .read_pixels(x as u32, y as u32, w as u32, h as u32, color_type)
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
        paint.set_color(color.red, color.green, color.blue, color.alpha);
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

  fn drop_shadow_paint(&self, paint: &Paint) -> Option<Paint> {
    let alpha = paint.get_alpha();
    let last_state = &self.state;
    let shadow_color = &last_state.shadow_color;
    let mut shadow_alpha = shadow_color.alpha;
    shadow_alpha = ((shadow_alpha as f32) * (alpha as f32 / 255.0)) as u8;
    if shadow_alpha == 0 {
      return None;
    }
    if last_state.shadow_blur == 0f32
      && last_state.shadow_offset_x == 0f32
      && last_state.shadow_offset_y == 0f32
    {
      return None;
    }
    let mut drop_shadow_paint = paint.clone();
    let a = shadow_color.alpha;
    let r = shadow_color.red;
    let g = shadow_color.green;
    let b = shadow_color.blue;
    let transform = last_state.transform.get_transform();
    let sigma_x = last_state.shadow_blur / (2f32 * transform.scale_x());
    let sigma_y = last_state.shadow_blur / (2f32 * transform.scale_y());
    let shadow_effect = ImageFilter::make_drop_shadow_only(
      last_state.shadow_offset_x,
      last_state.shadow_offset_y,
      sigma_x,
      sigma_y,
      (a as u32) << 24 | (r as u32) << 16 | (g as u32) << 8 | b as u32,
      None,
    )?;
    drop_shadow_paint.set_alpha(shadow_alpha);
    drop_shadow_paint.set_image_filter(&shadow_effect);
    Some(drop_shadow_paint)
  }

  fn shadow_blur_paint(&self, paint: &Paint) -> Option<Paint> {
    let alpha = paint.get_alpha();
    let last_state = &self.state;
    let shadow_color = Self::multiply_by_alpha(&last_state.shadow_color, alpha);
    let shadow_alpha = shadow_color.alpha;
    if shadow_alpha == 0 {
      return None;
    }
    if last_state.shadow_blur == 0f32
      && last_state.shadow_offset_x == 0f32
      && last_state.shadow_offset_y == 0f32
    {
      return None;
    }
    let mut drop_shadow_paint = paint.clone();
    let a = shadow_color.alpha;
    let r = shadow_color.red;
    let g = shadow_color.green;
    let b = shadow_color.blue;
    let transform = last_state.transform.get_transform();
    let sigma_x = last_state.shadow_blur / (2f32 * transform.scale_x());
    let sigma_y = last_state.shadow_blur / (2f32 * transform.scale_y());
    let shadow_effect = ImageFilter::make_drop_shadow_only(
      0.0,
      0.0,
      sigma_x,
      sigma_y,
      (a as u32) << 24 | (r as u32) << 16 | (g as u32) << 8 | b as u32,
      None,
    )?;
    drop_shadow_paint.set_alpha(shadow_alpha);
    drop_shadow_paint.set_image_filter(&shadow_effect);
    let blur_effect = MaskFilter::make_blur(last_state.shadow_blur / 2f32)?;
    drop_shadow_paint.set_mask_filter(&blur_effect);
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
    let bitmap = bitmap.0.bitmap;
    let mut paint = self.fill_paint()?;
    paint.set_alpha((self.state.global_alpha * 255.0).round() as u8);
    if let Some(drop_shadow_paint) = self.drop_shadow_paint(&paint) {
      let surface = &mut self.surface;
      surface.canvas.draw_image(
        bitmap,
        sx,
        sy,
        s_width,
        s_height,
        dx,
        dy,
        d_width,
        d_height,
        self.state.image_smoothing_enabled,
        self.state.image_smoothing_quality,
        &drop_shadow_paint,
      );
    }
    self.surface.canvas.draw_image(
      bitmap,
      sx,
      sy,
      s_width,
      s_height,
      dx,
      dy,
      d_width,
      d_height,
      self.state.image_smoothing_enabled,
      self.state.image_smoothing_quality,
      &paint,
    );

    Ok(())
  }

  fn draw_text(
    &mut self,
    text: &str,
    x: f32,
    y: f32,
    max_width: f32,
    paint: &Paint,
  ) -> result::Result<(), SkError> {
    let state = &self.state;
    let weight = state.font_style.weight;
    let stretch = state.font_style.stretch;
    let slant = state.font_style.style;
    if let Some(shadow_paint) = self.shadow_blur_paint(paint) {
      let surface = &mut self.surface;
      surface.save();
      Self::apply_shadow_offset_matrix(surface, state.shadow_offset_x, state.shadow_offset_y)?;
      let font = get_font()?;
      surface.canvas.draw_text(
        text,
        x,
        y,
        max_width,
        self.width as f32,
        weight,
        stretch as i32,
        slant,
        &*font,
        state.font_style.size,
        &state.font_style.family,
        state.text_baseline,
        state.text_align,
        state.text_direction,
        &shadow_paint,
      )?;
      mem::drop(font);
      surface.restore();
    }
    let font = get_font()?;
    self.surface.canvas.draw_text(
      text,
      x,
      y,
      max_width,
      self.width as f32,
      weight,
      stretch as i32,
      slant,
      &*font,
      state.font_style.size,
      &state.font_style.family,
      state.text_baseline,
      state.text_align,
      state.text_direction,
      paint,
    )?;
    Ok(())
  }

  fn get_line_metrics(&mut self, text: &str) -> result::Result<LineMetrics, SkError> {
    let state = &self.state;
    let fill_paint = self.fill_paint()?;
    let weight = state.font_style.weight;
    let stretch = state.font_style.stretch;
    let slant = state.font_style.style;
    let font = get_font()?;
    let line_metrics = LineMetrics(self.surface.canvas.get_line_metrics(
      text,
      &*font,
      state.font_style.size,
      weight,
      stretch as i32,
      slant,
      &state.font_style.family,
      state.text_baseline,
      state.text_align,
      state.text_direction,
      &fill_paint,
    )?);
    Ok(line_metrics)
  }

  fn apply_shadow_offset_matrix(
    surface: &mut Surface,
    shadow_offset_x: f32,
    shadow_offset_y: f32,
  ) -> result::Result<(), SkError> {
    let current_transform = surface.canvas.get_transform_matrix();
    let invert = current_transform
      .invert()
      .ok_or_else(|| SkError::Generic("Invert matrix failed".to_owned()))?;
    surface.canvas.concat(&invert);
    let mut shadow_offset = current_transform.clone();
    shadow_offset.pre_translate(shadow_offset_x, shadow_offset_y);
    surface.canvas.concat(&shadow_offset);
    surface.canvas.concat(&current_transform);
    Ok(())
  }

  // ./skia/modules/canvaskit/color.js
  fn multiply_by_alpha(color: &RGBA, global_alpha: u8) -> RGBA {
    let mut result = *color;
    result.alpha = ((0.0_f32.max((result.alpha_f32() * (global_alpha as f32 / 255.0)).min(1.0)))
      * 255.0)
      .round() as u8;
    result
  }
}

#[napi(object)]
pub struct ContextAttributes {
  pub alpha: bool,
  pub desynchronized: bool,
}

#[napi]
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
  fn finalize(self, mut env: Env) -> Result<()> {
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
      eprintln!(
        "Alpha value out of range, expected 0.0 - 1.0, but got : {}",
        alpha
      );
      return;
    }
    self.context.state.global_alpha = alpha;
    self.context.state.paint.set_alpha((alpha * 255.0) as u8);
  }

  #[napi(getter)]
  pub fn get_global_composite_operation(&self) -> String {
    self
      .context
      .state
      .paint
      .get_blend_mode()
      .as_str()
      .to_owned()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_global_composite_operation(&mut self, mode: String) {
    if let Ok(blend_mode) = mode.parse() {
      self.context.state.paint.set_blend_mode(blend_mode);
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
  pub fn get_fill_style(&self, this: This) -> Result<Unknown> {
    this.get_named_property_unchecked(FILL_STYLE_HIDDEN_NAME)
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_fill_style(
    &mut self,
    env: Env,
    mut this: This,
    fill_style: Either3<JsString, ClassInstance<CanvasGradient>, ClassInstance<CanvasPattern>>,
  ) -> Result<()> {
    if let Some(pattern) = match &fill_style {
      Either3::A(color) => Pattern::from_color(color.into_utf8()?.as_str()?).ok(),
      Either3::B(gradient) => Some(Pattern::Gradient(gradient.0.clone())),
      Either3::C(pattern) => Some(pattern.inner.clone()),
    } {
      let raw_fill_style = fill_style.as_unknown(env);
      self.context.state.fill_style = pattern;
      this.set(FILL_STYLE_HIDDEN_NAME, &raw_fill_style)?;
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

  #[napi(setter, return_if_invalid)]
  pub fn set_font(&mut self, font: String) -> Result<()> {
    self.context.set_font(font)?;
    Ok(())
  }

  #[napi(getter)]
  pub fn get_text_direction(&self) -> String {
    self.context.state.text_direction.as_str().to_owned()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_text_direction(&mut self, direction: String) {
    if let Ok(d) = direction.parse() {
      self.context.state.text_direction = d;
    };
  }

  #[napi(getter)]
  pub fn get_stroke_style(&self, this: This) -> Option<Unknown> {
    this.get(STROKE_STYLE_HIDDEN_NAME).ok().flatten()
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_stroke_style(
    &mut self,
    env: Env,
    mut this: This,
    fill_style: Either3<JsString, ClassInstance<CanvasGradient>, ClassInstance<CanvasPattern>>,
  ) -> Result<()> {
    if let Some(pattern) = match &fill_style {
      Either3::A(color) => Pattern::from_color(color.into_utf8()?.as_str()?).ok(),
      Either3::B(gradient) => Some(Pattern::Gradient(gradient.0.clone())),
      Either3::C(pattern) => Some(pattern.inner.clone()),
    } {
      let raw_fill_style = fill_style.as_unknown(env);
      this.set(STROKE_STYLE_HIDDEN_NAME, &raw_fill_style)?;
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
    self.context.state.shadow_blur = blur as f32;
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
    self.context.state.shadow_offset_x = offset_x as f32;
  }

  #[napi(getter)]
  pub fn get_shadow_offset_y(&self) -> f64 {
    self.context.state.shadow_offset_y as f64
  }

  #[napi(setter, return_if_invalid)]
  pub fn set_shadow_offset_y(&mut self, offset_y: f64) {
    self.context.state.shadow_offset_y = offset_y as f32;
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
  pub fn clear_rect(&mut self, x: f64, y: f64, width: f64, height: f64) {
    self
      .context
      .clear_rect(x as f32, y as f32, width as f32, height as f32);
  }

  #[napi]
  pub fn close_path(&mut self) {
    self.context.close_path();
  }

  #[napi]
  pub fn create_image_data(
    &mut self,
    env: Env,
    width_or_data: Either<u32, Uint8ClampedArray>,
    width_or_height: u32,
    height_or_settings: Option<Either<u32, Settings>>,
    maybe_settings: Option<Settings>,
  ) -> Result<ClassInstance<ImageData>> {
    match width_or_data {
      Either::A(width) => {
        let height = width_or_height;
        let color_space = match height_or_settings {
          Some(Either::B(settings)) => {
            ColorSpace::from_str(&settings.color_space).unwrap_or_default()
          }
          _ => ColorSpace::default(),
        };
        let arraybuffer_length = (width * height * 4) as usize;
        let mut data_buffer = vec![0; arraybuffer_length];
        let data_ptr = data_buffer.as_mut_ptr();
        let data_object = unsafe {
          Object::from_raw_unchecked(
            env.raw(),
            Uint8ClampedArray::to_napi_value(env.raw(), Uint8ClampedArray::new(data_buffer))?,
          )
        };
        let instance = ImageData {
          width: width as usize,
          height: height as usize,
          color_space,
          data: data_ptr,
        }
        .into_instance(env)?;
        let mut image_instance = unsafe { Object::from_raw_unchecked(env.raw(), instance.raw()) };
        image_instance.set("data", &data_object)?;
        Ok(instance)
      }
      Either::B(mut data_object) => {
        let input_data_length = data_object.len();
        let width = width_or_height;
        let height = match &height_or_settings {
          Some(Either::A(height)) => *height,
          _ => (input_data_length as u32) / 4 / width,
        };
        let data = data_object.as_mut_ptr();
        let color_space = maybe_settings
          .and_then(|settings| ColorSpace::from_str(&settings.color_space).ok())
          .unwrap_or_default();
        let instance = ImageData {
          width: width as usize,
          height: height as usize,
          color_space,
          data,
        }
        .into_instance(env)?;
        let mut image_instance = unsafe { Object::from_raw_unchecked(env.raw(), instance.raw()) };
        image_instance.set("data", data_object)?;
        Ok(instance)
      }
    }
  }

  #[napi]
  pub fn create_linear_gradient(
    &mut self,
    env: Env,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
  ) -> Result<ClassInstance<CanvasGradient>> {
    let linear_gradient =
      Gradient::create_linear_gradient(x0 as f32, y0 as f32, x1 as f32, y1 as f32);
    CanvasGradient(linear_gradient).into_instance(env)
  }

  #[napi]
  pub fn create_radial_gradient(
    &mut self,
    env: Env,
    x0: f64,
    y0: f64,
    r0: f64,
    x1: f64,
    y1: f64,
    r1: f64,
  ) -> Result<ClassInstance<CanvasGradient>> {
    let radial_gradient = Gradient::create_radial_gradient(
      x0 as f32, y0 as f32, r0 as f32, x1 as f32, y1 as f32, r1 as f32,
    );
    CanvasGradient(radial_gradient).into_instance(env)
  }

  #[napi]
  pub fn create_conic_gradient(
    &mut self,
    env: Env,
    r: f64,
    x: f64,
    y: f64,
  ) -> Result<ClassInstance<CanvasGradient>> {
    let conic_gradient = Gradient::create_conic_gradient(x as f32, y as f32, r as f32);
    CanvasGradient(conic_gradient).into_instance(env)
  }

  #[napi]
  pub fn create_pattern(
    &self,
    env: Env,
    input: Either4<&mut Image, &mut ImageData, &mut CanvasElement, &mut SVGCanvas>,
    repetition: Option<String>,
  ) -> Result<ClassInstance<CanvasPattern>> {
    CanvasPattern::new(input, repetition)?.into_instance(env)
  }

  #[napi]
  pub fn rect(&mut self, x: f64, y: f64, width: f64, height: f64) {
    self
      .context
      .rect(x as f32, y as f32, width as f32, height as f32);
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
    image: Either3<&mut CanvasElement, &mut SVGCanvas, &mut Image>,
    sx: Option<f64>,
    sy: Option<f64>,
    s_width: Option<f64>,
    s_height: Option<f64>,
    dx: Option<f64>,
    dy: Option<f64>,
    d_width: Option<f64>,
    d_height: Option<f64>,
  ) -> Result<()> {
    let bitmap = match image {
      Either3::A(canvas) => BitmapRef::Owned(canvas.ctx.as_ref().context.surface.get_bitmap()),
      Either3::B(svg) => BitmapRef::Owned(svg.ctx.as_ref().context.surface.get_bitmap()),
      Either3::C(image) => {
        if !image.complete {
          return Ok(());
        }
        image.regenerate_bitmap_if_need();
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
    match x_or_path {
      Either::A(x) => {
        let y = x_or_y;
        let fill_rule = y_or_fill_rule
          .and_then(|v| match v {
            Either::B(rule) => rule.parse().ok(),
            _ => None,
          })
          .unwrap_or(FillType::Winding);
        Ok(self.context.path.hit_test(x as f32, y as f32, fill_rule))
      }
      Either::B(path) => {
        let x = x_or_y;
        let y = match y_or_fill_rule {
          Some(Either::A(y)) => y,
          _ => {
            return Err(Error::new(
              Status::InvalidArg,
              "The y-axis coordinate of the point to check is missing".to_owned(),
            ))
          }
        };
        let fill_rule = maybe_fill_rule
          .and_then(|s| s.parse().ok())
          .unwrap_or(FillType::Winding);
        Ok(path.inner.hit_test(x as f32, y as f32, fill_rule))
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
    match x_or_path {
      Either::A(x) => {
        let y = x_or_y;
        Ok(
          self
            .context
            .path
            .stroke_hit_test(x as f32, y as f32, stroke_w),
        )
      }
      Either::B(path) => {
        let x = x_or_y;
        if let Some(y) = maybe_y {
          Ok(path.inner.stroke_hit_test(x as f32, y as f32, stroke_w))
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
  pub fn measure_text(&mut self, text: String) -> Result<TextMetrics> {
    if text.is_empty() {
      return Ok(TextMetrics {
        actual_bounding_box_ascent: 0.0,
        actual_bounding_box_descent: 0.0,
        actual_bounding_box_left: 0.0,
        actual_bounding_box_right: 0.0,
        font_bounding_box_ascent: 0.0,
        font_bounding_box_descent: 0.0,
        width: 0.0,
      });
    }
    let metrics = self.context.get_line_metrics(&text)?;
    Ok(TextMetrics {
      actual_bounding_box_ascent: metrics.0.ascent as f64,
      actual_bounding_box_descent: metrics.0.descent as f64,
      actual_bounding_box_left: metrics.0.left as f64,
      actual_bounding_box_right: metrics.0.right as f64,
      font_bounding_box_ascent: metrics.0.font_ascent as f64,
      font_bounding_box_descent: metrics.0.font_descent as f64,
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
  pub fn fill_text(&mut self, text: String, x: f64, y: f64, max_width: Option<f64>) -> Result<()> {
    if text.is_empty() {
      return Ok(());
    }
    if !x.is_nan() && !x.is_infinite() && !y.is_nan() && !y.is_infinite() {
      self.context.fill_text(
        &text,
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
    text: String,
    x: f64,
    y: f64,
    max_width: Option<f64>,
  ) -> Result<()> {
    if text.is_empty() {
      return Ok(());
    }
    if !x.is_nan() && !x.is_infinite() && !y.is_nan() && !y.is_infinite() {
      self.context.stroke_text(
        &text,
        x as f32,
        y as f32,
        max_width.map(|v| v as f32).unwrap_or(MAX_TEXT_WIDTH),
      )?;
    }
    Ok(())
  }

  #[napi]
  pub fn get_image_data(
    &mut self,
    env: Env,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    color_space: Option<String>,
  ) -> Result<ClassInstance<ImageData>> {
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
      let mut image_data = self
        .context
        .get_image_data(x as f32, y as f32, width as f32, height as f32, color_space)
        .ok_or_else(|| {
          Error::new(
            Status::GenericFailure,
            "Read pixels from canvas failed".to_string(),
          )
        })?;
      let data = image_data.as_mut_ptr();
      let data_object = unsafe {
        Object::from_raw_unchecked(
          env.raw(),
          Uint8ClampedArray::to_napi_value(env.raw(), Uint8ClampedArray::new(image_data))?,
        )
      };
      let instance = ImageData {
        width: width as usize,
        height: height as usize,
        color_space,
        data,
      }
      .into_instance(env)?;
      let mut image_instance = unsafe { Object::from_raw_unchecked(env.raw(), instance.raw()) };
      image_instance.set("data", data_object)?;
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
    image_data: &mut ImageData,
    dx: u32,
    dy: u32,
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
      let inverted = self.context.surface.canvas.get_transform_matrix().invert();
      self.context.surface.canvas.save();
      if let Some(inverted) = inverted {
        self.context.surface.canvas.concat(&inverted);
      };
      self.context.surface.canvas.write_pixels_dirty(
        image_data,
        dx as f32,
        dy as f32,
        dirty_x,
        dirty_y,
        dirty_width,
        dirty_height,
        image_data.color_space,
      );
      self.context.surface.canvas.restore();
    } else {
      self.context.surface.canvas.write_pixels(image_data, dx, dy);
    }
  }

  #[napi]
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
      Either::B(transform) => transform.into(),
    };
    self
      .context
      .set_transform(Matrix::new(ts.a, ts.b, ts.c, ts.d, ts.e, ts.f));
    None
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
}

pub enum ContextOutputData {
  Skia(SkiaDataRef),
  Avif(AvifData<'static>),
}

unsafe impl Send for ContextOutputData {}
unsafe impl Sync for ContextOutputData {}

impl Task for ContextData {
  type Output = ContextOutputData;
  type JsValue = JsBuffer;

  fn compute(&mut self) -> Result<Self::Output> {
    match self {
      ContextData::Png(surface) => {
        surface
          .png_data()
          .map(ContextOutputData::Skia)
          .ok_or_else(|| {
            Error::new(
              Status::GenericFailure,
              "Get png data from surface failed".to_string(),
            )
          })
      }
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
          .map_err(|e| Error::new(Status::GenericFailure, format!("{}", e)))
        }),
    }
  }

  fn resolve(&mut self, env: Env, output_data: Self::Output) -> Result<Self::JsValue> {
    match output_data {
      ContextOutputData::Skia(output) => unsafe {
        env
          .create_buffer_with_borrowed_data(output.0.ptr, output.0.size, output, |data_ref, _| {
            mem::drop(data_ref)
          })
          .map(|value| value.into_raw())
      },
      ContextOutputData::Avif(output) => unsafe {
        env
          .create_buffer_with_borrowed_data(output.as_ptr(), output.len(), output, |data_ref, _| {
            mem::drop(data_ref)
          })
          .map(|b| b.into_raw())
      },
    }
  }
}
