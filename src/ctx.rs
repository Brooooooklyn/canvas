use std::convert::TryFrom;
use std::f32::consts::PI;
use std::mem;
use std::rc::Rc;
use std::result;
use std::slice;
use std::str::FromStr;

use cssparser::{Color as CSSColor, Parser, ParserInput};
use napi::*;
use rgb::FromSlice;

use crate::filter::css_filters_to_image_filter;
use crate::{
  error::SkError, filter::css_filter, font::Font, gradient::CanvasGradient, image::*,
  pattern::Pattern, sk::*, state::Context2dRenderingState,
};

impl From<SkError> for Error {
  fn from(err: SkError) -> Error {
    Error::new(Status::InvalidArg, format!("{}", err))
  }
}

const MAX_TEXT_WIDTH: f32 = 100_000.0;

pub(crate) enum ImageOrCanvas {
  Image(Image),
  Canvas,
}

impl ImageOrCanvas {
  pub(crate) fn get_image(&mut self) -> Option<&mut Image> {
    match self {
      Self::Image(i) => Some(i),
      _ => None,
    }
  }
}

pub struct Context {
  pub(crate) surface: Surface,
  path: Path,
  pub alpha: bool,
  pub(crate) states: Vec<Context2dRenderingState>,
  state: Context2dRenderingState,
  pub font_collection: Rc<FontCollection>,
  pub width: u32,
  pub height: u32,
  pub color_space: ColorSpace,
  pub stream: Option<SkWMemoryStream>,
  pub filter: Option<ImageFilter>,
  filters_string: String,
}

impl Context {
  pub fn create_js_class(env: &Env) -> Result<JsFunction> {
    env.define_class(
      "CanvasRenderingContext2D",
      context_2d_constructor,
      &vec![
        // properties
        Property::new(env, "miterLimit")?
          .with_getter(get_miter_limit)
          .with_setter(set_miter_limit),
        Property::new(env, "globalAlpha")?
          .with_getter(get_global_alpha)
          .with_setter(set_global_alpha),
        Property::new(env, "globalCompositeOperation")?
          .with_getter(get_global_composite_operation)
          .with_setter(set_global_composite_operation),
        Property::new(env, "imageSmoothingEnabled")?
          .with_getter(get_image_smoothing_enabled)
          .with_setter(set_image_smoothing_enabled),
        Property::new(env, "imageSmoothingQuality")?
          .with_getter(get_image_smoothing_quality)
          .with_setter(set_image_smoothing_quality),
        Property::new(env, "lineCap")?
          .with_setter(set_line_cap)
          .with_getter(get_line_cap),
        Property::new(env, "lineDashOffset")?
          .with_setter(set_line_dash_offset)
          .with_getter(get_line_dash_offset),
        Property::new(env, "lineJoin")?
          .with_setter(set_line_join)
          .with_getter(get_line_join),
        Property::new(env, "lineWidth")?
          .with_setter(set_line_width)
          .with_getter(get_line_width),
        Property::new(env, "fillStyle")?
          .with_setter(set_fill_style)
          .with_getter(get_fill_style),
        Property::new(env, "filter")?
          .with_setter(set_filter)
          .with_getter(get_filter),
        Property::new(env, "font")?
          .with_setter(set_font)
          .with_getter(get_font),
        Property::new(env, "direction")?
          .with_setter(set_text_direction)
          .with_getter(get_text_direction),
        Property::new(env, "strokeStyle")?
          .with_setter(set_stroke_style)
          .with_getter(get_stroke_style),
        Property::new(env, "shadowBlur")?
          .with_setter(set_shadow_blur)
          .with_getter(get_shadow_blur),
        Property::new(env, "shadowColor")?
          .with_setter(set_shadow_color)
          .with_getter(get_shadow_color),
        Property::new(env, "shadowOffsetX")?
          .with_setter(set_shadow_offset_x)
          .with_getter(get_shadow_offset_x),
        Property::new(env, "shadowOffsetY")?
          .with_setter(set_shadow_offset_y)
          .with_getter(get_shadow_offset_y),
        Property::new(env, "textAlign")?
          .with_setter(set_text_align)
          .with_getter(get_text_align),
        Property::new(env, "textBaseline")?
          .with_setter(set_text_baseline)
          .with_getter(get_text_baseline),
        // methods
        Property::new(env, "arc")?.with_method(arc),
        Property::new(env, "arcTo")?.with_method(arc_to),
        Property::new(env, "beginPath")?.with_method(begin_path),
        Property::new(env, "bezierCurveTo")?.with_method(bezier_curve_to),
        Property::new(env, "clearRect")?.with_method(clear_rect),
        Property::new(env, "clip")?.with_method(clip),
        Property::new(env, "closePath")?.with_method(close_path),
        Property::new(env, "createLinearGradient")?.with_method(create_linear_gradient),
        Property::new(env, "createRadialGradient")?.with_method(create_radial_gradient),
        Property::new(env, "createConicGradient")?.with_method(create_conic_gradient),
        Property::new(env, "drawImage")?
          .with_method(draw_image)
          .with_property_attributes(PropertyAttributes::Writable),
        Property::new(env, "getContextAttributes")?.with_method(get_context_attributes),
        Property::new(env, "isPointInPath")?.with_method(is_point_in_path),
        Property::new(env, "isPointInStroke")?.with_method(is_point_in_stroke),
        Property::new(env, "ellipse")?.with_method(ellipse),
        Property::new(env, "lineTo")?.with_method(line_to),
        Property::new(env, "measureText")?.with_method(measure_text),
        Property::new(env, "moveTo")?.with_method(move_to),
        Property::new(env, "fill")?.with_method(fill),
        Property::new(env, "fillRect")?.with_method(fill_rect),
        Property::new(env, "fillText")?.with_method(fill_text),
        Property::new(env, "_getImageData")?.with_method(get_image_data),
        Property::new(env, "getLineDash")?.with_method(get_line_dash),
        Property::new(env, "putImageData")?.with_method(put_image_data),
        Property::new(env, "quadraticCurveTo")?.with_method(quadratic_curve_to),
        Property::new(env, "rect")?.with_method(rect),
        Property::new(env, "resetTransform")?.with_method(reset_transform),
        Property::new(env, "restore")?.with_method(restore),
        Property::new(env, "rotate")?.with_method(rotate),
        Property::new(env, "save")?.with_method(save),
        Property::new(env, "scale")?.with_method(scale),
        Property::new(env, "setLineDash")?.with_method(set_line_dash),
        Property::new(env, "stroke")?.with_method(stroke),
        Property::new(env, "strokeRect")?.with_method(stroke_rect),
        Property::new(env, "strokeText")?.with_method(stroke_text),
        Property::new(env, "translate")?.with_method(translate),
        Property::new(env, "transform")?.with_method(transform),
        // getter setter method
        Property::new(env, "getTransform")?.with_method(get_current_transform),
        Property::new(env, "setTransform")?.with_method(set_current_transform),
      ],
    )
  }

  pub fn new_svg(
    width: u32,
    height: u32,
    svg_export_flag: SvgExportFlag,
    color_space: ColorSpace,
    font_collection: &mut Rc<FontCollection>,
  ) -> Result<Self> {
    let (surface, stream) = Surface::new_svg(
      width,
      height,
      AlphaType::Unpremultiplied,
      svg_export_flag,
      color_space,
    )
    .ok_or_else(|| Error::from_reason("Create skia svg surface failed".to_owned()))?;
    Ok(Context {
      surface,
      alpha: true,
      path: Path::new(),
      states: vec![],
      state: Context2dRenderingState::default(),
      font_collection: font_collection.clone(),
      width,
      height,
      color_space,
      stream: Some(stream),
      filter: None,
      filters_string: "none".to_owned(),
    })
  }

  pub fn new(
    width: u32,
    height: u32,
    color_space: ColorSpace,
    font_collection: &mut Rc<FontCollection>,
  ) -> Result<Self> {
    let surface = Surface::new_rgba(width, height, color_space)
      .ok_or_else(|| Error::from_reason("Create skia surface failed".to_owned()))?;
    Ok(Context {
      surface,
      alpha: true,
      path: Path::new(),
      states: vec![],
      state: Context2dRenderingState::default(),
      font_collection: font_collection.clone(),
      width,
      height,
      color_space,
      stream: None,
      filter: None,
      filters_string: "none".to_owned(),
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
    let mut new_sub_path = Path::new();
    self.path.swap(&mut new_sub_path);
  }

  pub fn clip(&mut self, path: Option<&mut Path>, fill_rule: FillType) {
    let clip = match path {
      Some(path) => path,
      None => &mut self.path,
    };
    clip.set_fill_type(fill_rule);
    self.surface.canvas.set_clip_path(clip);
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
    self.draw_text(text, x, y, max_width, &stroke_paint)?;
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
    self.draw_text(text, x, y, max_width, &fill_paint)?;
    Ok(())
  }

  pub fn stroke(&mut self, path: Option<&mut Path>) -> Result<()> {
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
    path: Option<&mut Path>,
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
        let mut color = *c;
        color.alpha = ((color.alpha as f32) * (alpha as f32 / 255.0)).round() as u8;
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
    if let Some(f) = &self.filter {
      paint.set_image_filter(f);
    }
    Ok(paint)
  }

  pub fn set_filter(&mut self, filter_str: &str) -> result::Result<(), SkError> {
    if filter_str.trim() == "none" {
      self.filters_string = "none".to_owned();
      self.filter = None;
    } else {
      let (_, filters) =
        css_filter(filter_str).map_err(|e| SkError::StringToFillRuleError(format!("{}", e)))?;
      self.filter = css_filters_to_image_filter(filters);
      self.filters_string = filter_str.to_owned();
    }
    Ok(())
  }

  fn stroke_paint(&self) -> result::Result<Paint, SkError> {
    let last_state = &self.state;
    let current_paint = &last_state.paint;
    let mut paint = current_paint.clone();
    paint.set_style(PaintStyle::Stroke);
    let global_alpha = current_paint.get_alpha();
    match &last_state.stroke_style {
      Pattern::Color(c, _) => {
        let mut color = *c;
        color.alpha = ((color.alpha as f32) * (global_alpha as f32 / 255.0)).round() as u8;
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
    if let Some(f) = &self.filter {
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
    let sigma = last_state.shadow_blur / 2f32;
    let a = shadow_color.alpha;
    let r = shadow_color.red;
    let g = shadow_color.green;
    let b = shadow_color.blue;
    let shadow_effect = ImageFilter::make_drop_shadow_only(
      last_state.shadow_offset_x,
      last_state.shadow_offset_y,
      sigma,
      sigma,
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
    drop_shadow_paint.set_color(
      shadow_color.red,
      shadow_color.green,
      shadow_color.blue,
      shadow_color.alpha,
    );
    drop_shadow_paint.set_alpha(shadow_alpha);
    let blur_effect = MaskFilter::make_blur(last_state.shadow_blur / 2f32)?;
    drop_shadow_paint.set_mask_filter(&blur_effect);
    Some(drop_shadow_paint)
  }

  pub(crate) fn draw_image(
    &mut self,
    image: &Image,
    sx: f32,
    sy: f32,
    s_width: f32,
    s_height: f32,
    dx: f32,
    dy: f32,
    d_width: f32,
    d_height: f32,
  ) -> Result<()> {
    let bitmap = image.bitmap.as_ref().unwrap().0.bitmap;
    let paint = self.fill_paint()?;
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
        &drop_shadow_paint,
      );
    }
    self.surface.canvas.draw_image(
      bitmap, sx, sy, s_width, s_height, dx, dy, d_width, d_height, &paint,
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
      surface.canvas.draw_text(
        text,
        x,
        y,
        max_width,
        self.width as f32,
        weight,
        stretch as i32,
        slant,
        &self.font_collection,
        state.font_style.size,
        &state.font_style.family,
        state.text_baseline,
        state.text_align,
        state.text_direction,
        &shadow_paint,
      )?;
      surface.restore();
    }

    self.surface.canvas.draw_text(
      text,
      x,
      y,
      max_width,
      self.width as f32,
      weight,
      stretch as i32,
      slant,
      &self.font_collection,
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
    let line_metrics = LineMetrics(self.surface.canvas.get_line_metrics(
      text,
      &self.font_collection,
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
}

#[js_function(5)]
fn context_2d_constructor(ctx: CallContext) -> Result<JsUndefined> {
  let width = ctx.get::<JsNumber>(0)?.get_uint32()?;
  let height = ctx.get::<JsNumber>(1)?.get_uint32()?;
  let font_collection_js = ctx.get::<JsObject>(2)?;
  let font_collection = ctx.env.unwrap::<Rc<FontCollection>>(&font_collection_js)?;
  let color_space = ctx.get::<JsString>(3)?.into_utf8()?;
  let color_space = ColorSpace::from_str(color_space.as_str()?)?;

  let mut this = ctx.this_unchecked::<JsObject>();
  let context_2d = if ctx.length == 4 {
    Context::new(width, height, color_space, font_collection)?
  } else {
    // SVG Canvas
    let flag = ctx.get::<JsNumber>(4)?.get_uint32()?;
    Context::new_svg(
      width,
      height,
      SvgExportFlag::try_from(flag)?,
      color_space,
      font_collection,
    )?
  };
  ctx.env.wrap(&mut this, context_2d)?;
  ctx.env.get_undefined()
}

#[js_function(6)]
fn arc(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let center_x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let center_y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let radius = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let start_angle = ctx.get::<JsNumber>(3)?.get_double()? as f32;
  let end_angle = ctx.get::<JsNumber>(4)?.get_double()? as f32;
  let from_end = ctx
    .get::<JsBoolean>(5)
    .and_then(|js_bool| js_bool.get_value())
    .unwrap_or(false);
  context_2d.arc(center_x, center_y, radius, start_angle, end_angle, from_end);
  ctx.env.get_undefined()
}

#[js_function(5)]
fn arc_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let ctrl_x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let ctrl_y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let to_x = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let to_y = ctx.get::<JsNumber>(3)?.get_double()? as f32;
  let radius = ctx.get::<JsNumber>(4)?.get_double()? as f32;

  context_2d
    .path
    .arc_to_tangent(ctrl_x, ctrl_y, to_x, to_y, radius);
  ctx.env.get_undefined()
}

#[js_function]
fn begin_path(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  context_2d.begin_path();
  ctx.env.get_undefined()
}

#[js_function(6)]
fn bezier_curve_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let cp1x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let cp1y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let cp2x = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let cp2y = ctx.get::<JsNumber>(3)?.get_double()? as f32;
  let x = ctx.get::<JsNumber>(4)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(5)?.get_double()? as f32;

  context_2d.path.cubic_to(cp1x, cp1y, cp2x, cp2y, x, y);

  ctx.env.get_undefined()
}

#[js_function(4)]
fn quadratic_curve_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let cpx = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let cpy = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let x = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(3)?.get_double()? as f32;

  context_2d.path.quad_to(cpx, cpy, x, y);

  ctx.env.get_undefined()
}

#[js_function(2)]
fn clip(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  if ctx.length == 0 {
    context_2d.clip(None, FillType::Winding);
  } else if ctx.length == 1 {
    let rule = ctx.get::<JsString>(0)?;
    context_2d.clip(None, FillType::from_str(rule.into_utf8()?.as_str()?)?);
  } else {
    let path = ctx.get::<JsObject>(0)?;
    let rule = ctx.get::<JsString>(1)?;
    context_2d.clip(
      Some(ctx.env.unwrap::<Path>(&path)?),
      FillType::from_str(rule.into_utf8()?.as_str()?)?,
    );
  };

  ctx.env.get_undefined()
}

#[js_function(4)]
fn rect(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let width = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let height = ctx.get::<JsNumber>(3)?.get_double()? as f32;

  context_2d
    .path
    .add_rect(x as f32, y as f32, width as f32, height as f32);
  ctx.env.get_undefined()
}

#[js_function(2)]
fn fill(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  if ctx.length == 0 {
    context_2d.fill(None, FillType::Winding)?;
  } else if ctx.length == 1 {
    let input = ctx.get::<JsUnknown>(0)?;
    match input.get_type()? {
      ValueType::String => {
        let fill_rule_js = unsafe { input.cast::<JsString>() }.into_utf8()?;
        context_2d.fill(None, FillType::from_str(fill_rule_js.as_str()?)?)?;
      }
      ValueType::Object => {
        let path_js = ctx.get::<JsObject>(0)?;
        let path = ctx.env.unwrap::<Path>(&path_js)?;
        context_2d.fill(Some(path), FillType::Winding)?;
      }
      _ => {
        return Err(Error::new(
          Status::InvalidArg,
          "Invalid fill argument".to_string(),
        ))
      }
    }
  } else {
    let path_js = ctx.get::<JsObject>(0)?;
    let fill_rule_js = ctx.get::<JsString>(1)?.into_utf8()?;
    let path = ctx.env.unwrap::<Path>(&path_js)?;
    context_2d.fill(Some(path), FillType::from_str(fill_rule_js.as_str()?)?)?;
  };

  ctx.env.get_undefined()
}

#[js_function]
fn save(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  context_2d.save();
  ctx.env.get_undefined()
}

#[js_function]
fn restore(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  context_2d.restore();
  ctx.env.get_undefined()
}

#[js_function(1)]
fn rotate(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let angle = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  context_2d.rotate(angle);
  ctx.env.get_undefined()
}

#[js_function(4)]
fn clear_rect(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let width = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let height = ctx.get::<JsNumber>(3)?.get_double()? as f32;

  let mut paint = Paint::new();
  paint.set_style(PaintStyle::Fill);
  paint.set_color(0, 0, 0, 0);
  paint.set_stroke_miter(10.0);
  paint.set_blend_mode(BlendMode::Clear);
  context_2d.surface.draw_rect(x, y, width, height, &paint);
  ctx.env.get_undefined()
}

#[js_function(4)]
fn create_linear_gradient(ctx: CallContext) -> Result<JsObject> {
  let x0 = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let y0 = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let x1 = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let y1 = ctx.get::<JsNumber>(3)?.get_double()? as f32;
  let linear_gradient = CanvasGradient::create_linear_gradient(x0, y0, x1, y1);
  linear_gradient.into_js_instance(ctx.env)
}

#[js_function(6)]
fn create_radial_gradient(ctx: CallContext) -> Result<JsObject> {
  let x0 = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let y0 = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let r0 = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let x1 = ctx.get::<JsNumber>(3)?.get_double()? as f32;
  let y1 = ctx.get::<JsNumber>(4)?.get_double()? as f32;
  let r1 = ctx.get::<JsNumber>(5)?.get_double()? as f32;
  let radial_gradient = CanvasGradient::create_radial_gradient(x0, y0, r0, x1, y1, r1);
  radial_gradient.into_js_instance(ctx.env)
}

#[js_function(3)]
fn create_conic_gradient(ctx: CallContext) -> Result<JsObject> {
  let r = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let x = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let conic_gradient = CanvasGradient::create_conic_gradient(x, y, r);
  conic_gradient.into_js_instance(ctx.env)
}

#[js_function]
fn close_path(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  context_2d.path.close();
  ctx.env.get_undefined()
}

#[js_function(9)]
fn draw_image(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let image_js = ctx.get::<JsObject>(0)?;
  let image_or_canvas = ctx.env.unwrap::<ImageOrCanvas>(&image_js)?;

  match image_or_canvas {
    ImageOrCanvas::Image(image) => {
      if !image.complete {
        return ctx.env.get_undefined();
      }
      let data = image_js
        .get_named_property_unchecked::<JsBuffer>("_src")?
        .into_value()?;

      image.regenerate_bitmap_if_need(data);

      // SVG with 0 width or 0 height
      if image.bitmap.is_none() {
        return ctx.env.get_undefined();
      }

      let image_w = image.bitmap.as_ref().unwrap().0.width as f32;
      let image_h = image.bitmap.as_ref().unwrap().0.height as f32;

      if ctx.length == 3 {
        let dx: f64 = ctx.get::<JsNumber>(1)?.get_double()?;
        let dy: f64 = ctx.get::<JsNumber>(2)?.get_double()?;
        context_2d.draw_image(
          image, 0f32, 0f32, image_w, image_h, dx as f32, dy as f32, image_w, image_h,
        )?;
      } else if ctx.length == 5 {
        let dx: f64 = ctx.get::<JsNumber>(1)?.get_double()?;
        let dy: f64 = ctx.get::<JsNumber>(2)?.get_double()?;
        let d_width: f64 = ctx.get::<JsNumber>(3)?.get_double()?;
        let d_height: f64 = ctx.get::<JsNumber>(4)?.get_double()?;
        context_2d.draw_image(
          image,
          0f32,
          0f32,
          image_w,
          image_h,
          dx as f32,
          dy as f32,
          d_width as f32,
          d_height as f32,
        )?;
      } else if ctx.length == 9 {
        let sx: f64 = ctx.get::<JsNumber>(1)?.get_double()?;
        let sy: f64 = ctx.get::<JsNumber>(2)?.get_double()?;
        let s_width: f64 = ctx.get::<JsNumber>(3)?.get_double()?;
        let s_height: f64 = ctx.get::<JsNumber>(4)?.get_double()?;
        let dx: f64 = ctx.get::<JsNumber>(5)?.get_double()?;
        let dy: f64 = ctx.get::<JsNumber>(6)?.get_double()?;
        let d_width: f64 = ctx.get::<JsNumber>(7)?.get_double()?;
        let d_height: f64 = ctx.get::<JsNumber>(8)?.get_double()?;
        context_2d.draw_image(
          image,
          sx as f32,
          sy as f32,
          s_width as f32,
          s_height as f32,
          dx as f32,
          dy as f32,
          d_width as f32,
          d_height as f32,
        )?;
      }

      image.need_regenerate_bitmap = false;
    }
    ImageOrCanvas::Canvas => {
      let ctx_js = image_js.get_named_property_unchecked::<JsObject>("ctx")?;
      let another_ctx = ctx.env.unwrap::<Context>(&ctx_js)?;
      let width = another_ctx.width as f32;
      let height = another_ctx.height as f32;
      let (sx, sy, sw, sh, dx, dy, dw, dh) = if ctx.length == 3 {
        let dx = ctx.get::<JsNumber>(1)?.get_double()? as f32;
        let dy = ctx.get::<JsNumber>(2)?.get_double()? as f32;
        (0.0f32, 0.0f32, width, height, dx, dy, width, height)
      } else if ctx.length == 5 {
        let sx = ctx.get::<JsNumber>(1)?.get_double()? as f32;
        let sy = ctx.get::<JsNumber>(2)?.get_double()? as f32;
        let sw = ctx.get::<JsNumber>(3)?.get_double()? as f32;
        let sh = ctx.get::<JsNumber>(4)?.get_double()? as f32;
        (sx, sy, sw, sh, 0.0f32, 0.0f32, sw, sh)
      } else if ctx.length == 9 {
        (
          ctx.get::<JsNumber>(1)?.get_double()? as f32,
          ctx.get::<JsNumber>(2)?.get_double()? as f32,
          ctx.get::<JsNumber>(3)?.get_double()? as f32,
          ctx.get::<JsNumber>(4)?.get_double()? as f32,
          ctx.get::<JsNumber>(5)?.get_double()? as f32,
          ctx.get::<JsNumber>(6)?.get_double()? as f32,
          ctx.get::<JsNumber>(7)?.get_double()? as f32,
          ctx.get::<JsNumber>(8)?.get_double()? as f32,
        )
      } else {
        return Err(Error::new(
          Status::InvalidArg,
          format!("Invalid arguments length {}", ctx.length),
        ));
      };

      context_2d.surface.canvas.draw_surface_rect(
        &another_ctx.surface,
        sx,
        sy,
        sw,
        sh,
        dx,
        dy,
        dw,
        dh,
        FilterQuality::High,
      );
    }
  };

  ctx.env.get_undefined()
}

#[js_function]
fn get_context_attributes(ctx: CallContext) -> Result<JsObject> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let mut obj = ctx.env.create_object()?;
  obj.set_named_property("alpha", ctx.env.get_boolean(context_2d.alpha)?)?;
  obj.set_named_property("desynchronized", ctx.env.get_boolean(false)?)?;
  Ok(obj)
}

#[js_function(4)]
fn is_point_in_path(ctx: CallContext) -> Result<JsBoolean> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let result;

  if ctx.length == 2 {
    let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
    let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
    result = context_2d.path.hit_test(y, x, FillType::Winding);
    ctx.env.get_boolean(result)
  } else if ctx.length == 3 {
    let input = ctx.get::<JsUnknown>(0)?;
    match input.get_type()? {
      ValueType::Number => {
        let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
        let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
        let fill_rule_js = ctx.get::<JsString>(2)?.into_utf8()?;
        result = context_2d
          .path
          .hit_test(y, x, FillType::from_str(fill_rule_js.as_str()?)?);
      }
      ValueType::Object => {
        let x = ctx.get::<JsNumber>(1)?.get_double()? as f32;
        let y = ctx.get::<JsNumber>(2)?.get_double()? as f32;
        let path_js = ctx.get::<JsObject>(0)?;
        let path = ctx.env.unwrap::<Path>(&path_js)?;
        result = path.hit_test(x, y, FillType::Winding);
      }
      _ => {
        return Err(Error::new(
          Status::InvalidArg,
          "Invalid isPointInPath argument".to_string(),
        ))
      }
    }
    ctx.env.get_boolean(result)
  } else if ctx.length == 4 {
    let path_js = ctx.get::<JsObject>(0)?;
    let path = ctx.env.unwrap::<Path>(&path_js)?;
    let x = ctx.get::<JsNumber>(1)?.get_double()? as f32;
    let y = ctx.get::<JsNumber>(2)?.get_double()? as f32;
    let fill_rule_js = ctx.get::<JsString>(3)?.into_utf8()?;
    result = path.hit_test(y, x, FillType::from_str(fill_rule_js.as_str()?)?);
    ctx.env.get_boolean(result)
  } else {
    Err(Error::new(
      Status::InvalidArg,
      "Invalid isPointInPath arguments length".to_string(),
    ))
  }
}

#[js_function(3)]
fn is_point_in_stroke(ctx: CallContext) -> Result<JsBoolean> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let mut result = false;

  if ctx.length == 2 {
    let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
    let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
    let stroke_w = context_2d.state.paint.get_stroke_width();
    result = context_2d.path.stroke_hit_test(x, y, stroke_w);
  } else if ctx.length == 3 {
    let path_js = ctx.get::<JsObject>(0)?;
    let path = ctx.env.unwrap::<Path>(&path_js)?;

    let x = ctx.get::<JsNumber>(1)?.get_double()? as f32;
    let y = ctx.get::<JsNumber>(2)?.get_double()? as f32;
    let stroke_w = context_2d.state.paint.get_stroke_width();
    result = path.stroke_hit_test(x, y, stroke_w);
  }
  ctx.env.get_boolean(result)
}

#[js_function(8)]
fn ellipse(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let radius_x = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let radius_y = ctx.get::<JsNumber>(3)?.get_double()? as f32;
  let rotation = ctx.get::<JsNumber>(4)?.get_double()? as f32;
  let start_angle = ctx.get::<JsNumber>(5)?.get_double()? as f32;
  let end_angle = ctx.get::<JsNumber>(6)?.get_double()? as f32;

  let from_end = if ctx.length == 8 {
    ctx.get::<JsBoolean>(7)?.get_value()?
  } else {
    false
  };
  context_2d.ellipse(
    x,
    y,
    radius_x,
    radius_y,
    rotation,
    start_angle,
    end_angle,
    from_end,
  );
  ctx.env.get_undefined()
}

#[js_function(2)]
fn line_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;

  context_2d.path.line_to(x, y);

  ctx.env.get_undefined()
}

#[js_function(1)]
fn measure_text(ctx: CallContext) -> Result<JsObject> {
  let text = ctx.get::<JsString>(0)?.into_utf8()?;
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let m = context_2d.get_line_metrics(text.as_str()?)?.0;

  let mut metrics = ctx.env.create_object()?;
  metrics.set_named_property(
    "actualBoundingBoxAscent",
    ctx.env.create_double(m.ascent as f64)?,
  )?;
  metrics.set_named_property(
    "actualBoundingBoxDescent",
    ctx.env.create_double(m.descent as f64)?,
  )?;
  metrics.set_named_property(
    "actualBoundingBoxLeft",
    ctx.env.create_double(m.left as f64)?,
  )?;
  metrics.set_named_property(
    "actualBoundingBoxRight",
    ctx.env.create_double(m.right as f64)?,
  )?;
  metrics.set_named_property(
    "fontBoundingBoxAscent",
    ctx.env.create_double(m.font_ascent as f64)?,
  )?;
  metrics.set_named_property(
    "fontBoundingBoxDescent",
    ctx.env.create_double(m.font_descent as f64)?,
  )?;
  metrics.set_named_property("width", ctx.env.create_double(m.width as f64)?)?;
  Ok(metrics)
}

#[js_function(2)]
fn move_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;

  context_2d.path.move_to(x, y);

  ctx.env.get_undefined()
}

#[js_function(1)]
fn set_miter_limit(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let miter = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  context_2d.state.paint.set_stroke_miter(miter);
  ctx.env.get_undefined()
}

#[js_function]
fn get_miter_limit(ctx: CallContext) -> Result<JsNumber> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx
    .env
    .create_double(context_2d.state.paint.get_stroke_miter() as f64)
}

#[js_function(4)]
fn stroke_rect(ctx: CallContext) -> Result<JsUndefined> {
  let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let w = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let h = ctx.get::<JsNumber>(3)?.get_double()? as f32;

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  context_2d.stroke_rect(x, y, w, h)?;

  ctx.env.get_undefined()
}

#[js_function(4)]
fn stroke_text(ctx: CallContext) -> Result<JsUndefined> {
  let text = ctx.get::<JsString>(0)?.into_utf8()?;
  let x = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let max_width = if ctx.length == 3 {
    MAX_TEXT_WIDTH
  } else {
    ctx.get::<JsNumber>(3)?.get_double()? as f32
  };

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  context_2d.stroke_text(text.as_str()?, x, y, max_width)?;

  ctx.env.get_undefined()
}

#[js_function(4)]
fn fill_rect(ctx: CallContext) -> Result<JsUndefined> {
  let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let w = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let h = ctx.get::<JsNumber>(3)?.get_double()? as f32;

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  context_2d.fill_rect(x, y, w, h)?;

  ctx.env.get_undefined()
}

#[js_function(4)]
fn fill_text(ctx: CallContext) -> Result<JsUndefined> {
  let text = ctx.get::<JsString>(0)?.into_utf8()?;
  let x = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let max_width = if ctx.length == 3 {
    MAX_TEXT_WIDTH
  } else {
    ctx.get::<JsNumber>(3)?.get_double()? as f32
  };

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  context_2d.fill_text(text.as_str()?, x, y, max_width)?;

  ctx.env.get_undefined()
}

#[js_function(5)]
fn get_image_data(ctx: CallContext) -> Result<JsTypedArray> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let x = ctx.get::<JsNumber>(0)?.get_uint32()?;
  let y = ctx.get::<JsNumber>(1)?.get_uint32()?;
  let width = ctx.get::<JsNumber>(2)?.get_uint32()?;
  let height = ctx.get::<JsNumber>(3)?.get_uint32()?;
  let color_space = if ctx.length == 5 {
    let image_settings = ctx.get::<JsObject>(4)?;
    let cs = image_settings.get_named_property_unchecked::<JsUnknown>("colorSpace")?;
    if cs.get_type()? == ValueType::String {
      let color_space_js = unsafe { cs.cast::<JsString>() }.into_utf8()?;
      ColorSpace::from_str(color_space_js.as_str()?)?
    } else {
      ColorSpace::default()
    }
  } else {
    ColorSpace::default()
  };
  let pixels = context_2d
    .surface
    .read_pixels(x, y, width, height, color_space)
    .ok_or_else(|| {
      Error::new(
        Status::GenericFailure,
        "Read pixels from canvas failed".to_string(),
      )
    })?;
  let length = pixels.len();
  ctx.env.create_arraybuffer_with_data(pixels).and_then(|ab| {
    ab.into_raw()
      .into_typedarray(TypedArrayType::Uint8Clamped, length, 0)
  })
}

#[js_function]
fn get_line_dash(ctx: CallContext) -> Result<JsObject> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let line_dash_list = &context_2d.state.line_dash_list;

  let mut arr = ctx.env.create_array_with_length(line_dash_list.len())?;

  for (index, a) in line_dash_list.iter().enumerate() {
    arr.set_element(index as u32, ctx.env.create_double(*a as f64)?)?;
  }
  Ok(arr)
}

#[js_function(7)]
fn put_image_data(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let image_data_js = ctx.get::<JsObject>(0)?;
  let image_data = ctx.env.unwrap::<ImageData>(&image_data_js)?;
  let dx = ctx.get::<JsNumber>(1)?.get_uint32()?;
  let dy = ctx.get::<JsNumber>(2)?.get_uint32()?;
  if ctx.length == 3 {
    context_2d.surface.canvas.write_pixels(image_data, dx, dy);
  } else {
    let mut dirty_x = ctx.get::<JsNumber>(3)?.get_double()? as f32;
    let mut dirty_y = if ctx.length >= 5 {
      ctx.get::<JsNumber>(4)?.get_double()? as f32
    } else {
      0.0f32
    };
    let mut dirty_width = if ctx.length >= 6 {
      ctx.get::<JsNumber>(5)?.get_double()? as f32
    } else {
      image_data.width as f32
    };
    let mut dirty_height = if ctx.length == 7 {
      ctx.get::<JsNumber>(6)?.get_double()? as f32
    } else {
      image_data.height as f32
    };
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
      return ctx.env.get_undefined();
    }
    let inverted = context_2d.surface.canvas.get_transform_matrix().invert();
    context_2d.surface.canvas.save();
    if let Some(inverted) = inverted {
      context_2d.surface.canvas.concat(&inverted);
    };
    context_2d.surface.canvas.write_pixels_dirty(
      image_data,
      dx as f32,
      dy as f32,
      dirty_x,
      dirty_y,
      dirty_width,
      dirty_height,
      image_data.color_space,
    );
    context_2d.surface.canvas.restore();
  };

  ctx.env.get_undefined()
}

#[js_function(1)]
fn set_global_alpha(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let alpha = ctx.get::<JsNumber>(0)?.get_double()? as f32;

  if !(0.0..=1.0).contains(&alpha) {
    return Err(Error::new(
      Status::InvalidArg,
      format!(
        "Alpha value out of range, expected 0.0 - 1.0, but got : {}",
        alpha
      ),
    ));
  }

  context_2d.state.paint.set_alpha((alpha * 255.0) as u8);
  ctx.env.get_undefined()
}

#[js_function]
fn get_global_alpha(ctx: CallContext) -> Result<JsNumber> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx
    .env
    .create_double((context_2d.state.paint.get_alpha() as f64) / 255.0)
}

#[js_function(1)]
fn set_global_composite_operation(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let blend_string = ctx.get::<JsString>(0)?.into_utf8()?;

  context_2d
    .state
    .paint
    .set_blend_mode(BlendMode::from_str(blend_string.as_str()?).map_err(Error::from)?);

  ctx.env.get_undefined()
}

#[js_function]
fn get_global_composite_operation(ctx: CallContext) -> Result<JsString> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx
    .env
    .create_string(context_2d.state.paint.get_blend_mode().as_str())
}

#[js_function(1)]
fn set_image_smoothing_enabled(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let enabled = ctx.get::<JsBoolean>(0)?;

  context_2d.state.image_smoothing_enabled = enabled.get_value()?;

  ctx.env.get_undefined()
}

#[js_function]
fn get_image_smoothing_enabled(ctx: CallContext) -> Result<JsBoolean> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx
    .env
    .get_boolean(context_2d.state.image_smoothing_enabled)
}

#[js_function(1)]
fn set_image_smoothing_quality(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let quality = ctx.get::<JsString>(0)?.into_utf8()?;

  context_2d.state.image_smoothing_quality =
    FilterQuality::from_str(quality.as_str()?).map_err(Error::from)?;

  ctx.env.get_undefined()
}

#[js_function]
fn get_image_smoothing_quality(ctx: CallContext) -> Result<JsString> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx
    .env
    .create_string(context_2d.state.image_smoothing_quality.as_str())
}

#[js_function]
fn get_current_transform(ctx: CallContext) -> Result<JsObject> {
  let mut transform_object = ctx.env.create_object()?;
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let current_transform = context_2d.state.transform.get_transform();

  transform_object.set_named_property("a", ctx.env.create_double(current_transform.a as f64)?)?;
  transform_object.set_named_property("b", ctx.env.create_double(current_transform.b as f64)?)?;
  transform_object.set_named_property("c", ctx.env.create_double(current_transform.c as f64)?)?;
  transform_object.set_named_property("d", ctx.env.create_double(current_transform.d as f64)?)?;
  transform_object.set_named_property("e", ctx.env.create_double(current_transform.e as f64)?)?;
  transform_object.set_named_property("f", ctx.env.create_double(current_transform.f as f64)?)?;
  Ok(transform_object)
}

#[js_function(6)]
fn set_current_transform(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let transform = if ctx.length == 1 {
    let transform_object = ctx.get::<JsObject>(0)?;
    let a = transform_object
      .get_named_property::<JsNumber>("a")?
      .get_double()? as f32;
    let b = transform_object
      .get_named_property::<JsNumber>("b")?
      .get_double()? as f32;
    let c = transform_object
      .get_named_property::<JsNumber>("c")?
      .get_double()? as f32;
    let d = transform_object
      .get_named_property::<JsNumber>("d")?
      .get_double()? as f32;
    let e = transform_object
      .get_named_property::<JsNumber>("e")?
      .get_double()? as f32;
    let f = transform_object
      .get_named_property::<JsNumber>("f")?
      .get_double()? as f32;
    Matrix::new(a, c, e, b, d, f)
  } else if ctx.length == 6 {
    let a = ctx.get::<JsNumber>(0)?.get_double()? as f32;
    let b = ctx.get::<JsNumber>(1)?.get_double()? as f32;
    let c = ctx.get::<JsNumber>(2)?.get_double()? as f32;
    let d = ctx.get::<JsNumber>(3)?.get_double()? as f32;
    let e = ctx.get::<JsNumber>(4)?.get_double()? as f32;
    let f = ctx.get::<JsNumber>(5)?.get_double()? as f32;
    Matrix::new(a, c, e, b, d, f)
  } else {
    return Err(Error::new(
      Status::InvalidArg,
      "Invalid argument length in setTransform".to_string(),
    ));
  };

  context_2d.set_transform(transform);

  ctx.env.get_undefined()
}

#[js_function(2)]
fn scale(ctx: CallContext) -> Result<JsUndefined> {
  let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  context_2d.scale(x, y);

  ctx.env.get_undefined()
}

#[js_function(1)]
fn set_line_dash(ctx: CallContext) -> Result<JsUndefined> {
  let dash = ctx.get::<JsObject>(0)?;
  let len = dash.get_array_length()? as usize;
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let is_odd = len & 1 != 0;
  let mut dash_list = if is_odd {
    vec![0f32; len * 2]
  } else {
    vec![0f32; len]
  };
  for idx in 0..len {
    let dash_value: f32 = dash.get_element::<JsNumber>(idx as u32)?.get_double()? as f32;
    dash_list[idx] = dash_value as f32;
    if is_odd {
      dash_list[idx + len] = dash_value as f32;
    }
  }
  context_2d.state.line_dash_list = dash_list;
  ctx.env.get_undefined()
}

#[js_function(1)]
fn stroke(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let path = if ctx.length == 0 {
    None
  } else {
    let js_path = ctx.get::<JsObject>(0)?;
    let path = ctx.env.unwrap::<Path>(&js_path)?;
    Some(path)
  };

  context_2d.stroke(path)?;

  ctx.env.get_undefined()
}

#[js_function(2)]
fn translate(ctx: CallContext) -> Result<JsUndefined> {
  let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  context_2d.translate(x, y);
  ctx.env.get_undefined()
}

#[js_function(6)]
fn transform(ctx: CallContext) -> Result<JsUndefined> {
  let a = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let b = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let c = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let d = ctx.get::<JsNumber>(3)?.get_double()? as f32;
  let e = ctx.get::<JsNumber>(4)?.get_double()? as f32;
  let f = ctx.get::<JsNumber>(5)?.get_double()? as f32;

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let ts = Matrix::new(a, c, e, b, d, f);
  context_2d.transform(ts)?;
  ctx.env.get_undefined()
}

#[js_function]
fn reset_transform(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  context_2d.reset_transform();
  ctx.env.get_undefined()
}

#[js_function]
fn get_line_cap(ctx: CallContext) -> Result<JsString> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx
    .env
    .create_string(context_2d.state.paint.get_stroke_cap().as_str())
}

#[js_function(1)]
fn set_line_cap(ctx: CallContext) -> Result<JsUndefined> {
  let line_cap_string = ctx.get::<JsString>(0)?;
  let line_cap = line_cap_string.into_utf8()?;

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  context_2d
    .state
    .paint
    .set_stroke_cap(StrokeCap::from_str(line_cap.as_str()?)?);

  ctx.env.get_undefined()
}

#[js_function]
fn get_line_dash_offset(ctx: CallContext) -> Result<JsNumber> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx
    .env
    .create_double(context_2d.state.line_dash_offset as f64)
}

#[js_function(1)]
fn set_line_dash_offset(ctx: CallContext) -> Result<JsUndefined> {
  let line_offset = ctx.get::<JsNumber>(0)?.get_double()? as f32;

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  context_2d.state.line_dash_offset = line_offset as f32;

  ctx.env.get_undefined()
}

#[js_function]
fn get_line_join(ctx: CallContext) -> Result<JsString> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx
    .env
    .create_string(context_2d.state.paint.get_stroke_join().as_str())
}

#[js_function(1)]
fn set_line_join(ctx: CallContext) -> Result<JsUndefined> {
  let line_join_string = ctx.get::<JsString>(0)?;
  let line_join = line_join_string.into_utf8()?;

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  context_2d
    .state
    .paint
    .set_stroke_join(StrokeJoin::from_str(line_join.as_str()?)?);

  ctx.env.get_undefined()
}

#[js_function]
fn get_line_width(ctx: CallContext) -> Result<JsNumber> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx
    .env
    .create_double(context_2d.state.paint.get_stroke_width() as f64)
}

#[js_function(1)]
fn set_line_width(ctx: CallContext) -> Result<JsUndefined> {
  let width = ctx.get::<JsNumber>(0)?.get_double()? as f32;

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  context_2d.state.paint.set_stroke_width(width as f32);

  ctx.env.get_undefined()
}

#[js_function(1)]
fn set_fill_style(ctx: CallContext) -> Result<JsUndefined> {
  let mut this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let js_fill_style = ctx.get::<JsUnknown>(0)?;

  let p = match js_fill_style.get_type()? {
    ValueType::String => {
      let js_color = unsafe { js_fill_style.cast::<JsString>() }.into_utf8()?;
      Pattern::from_color(js_color.as_str()?)?
    }
    ValueType::Object => {
      let fill_object = unsafe { js_fill_style.cast::<JsObject>() };
      let pattern = ctx.env.unwrap::<Pattern>(&fill_object)?;
      pattern.clone()
    }
    _ => {
      return Err(Error::new(
        Status::InvalidArg,
        "Invalid fillStyle".to_string(),
      ))
    }
  };

  context_2d.state.fill_style = p;

  this.set_named_property("_fillStyle", js_fill_style)?;

  ctx.env.get_undefined()
}

#[js_function]
fn get_fill_style(ctx: CallContext) -> Result<JsUnknown> {
  let this = ctx.this_unchecked::<JsObject>();
  this.get_named_property("_fillStyle")
}

#[js_function(1)]
fn set_filter(ctx: CallContext) -> Result<JsUndefined> {
  let filter_str = ctx.get::<JsString>(0)?.into_utf8()?;
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let filter_str = filter_str.as_str()?;
  context_2d.set_filter(filter_str)?;
  ctx.env.get_undefined()
}

#[js_function]
fn get_filter(ctx: CallContext) -> Result<JsString> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  ctx.env.create_string(context_2d.filters_string.as_str())
}

#[js_function]
fn get_font(ctx: CallContext) -> Result<JsString> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx.env.create_string(context_2d.state.font.as_str())
}

#[js_function(1)]
fn set_font(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let last_state = &mut context_2d.state;
  let font_style = ctx.get::<JsString>(0)?.into_utf8()?.into_owned()?;
  last_state.font_style =
    Font::new(font_style.as_str()).map_err(|e| Error::new(Status::InvalidArg, format!("{}", e)))?;

  last_state.font = font_style;
  ctx.env.get_undefined()
}

#[js_function]
fn get_text_direction(ctx: CallContext) -> Result<JsString> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let last_state = &context_2d.state;
  ctx.env.create_string(last_state.text_direction.as_str())
}

#[js_function(1)]
fn set_text_direction(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let direction = ctx.get::<JsString>(0)?.into_utf8()?;
  let text_direction = TextDirection::from_str(direction.as_str()?)?;
  let last_state = &mut context_2d.state;
  last_state.text_direction = text_direction;
  ctx.env.get_undefined()
}

#[js_function(1)]
fn set_stroke_style(ctx: CallContext) -> Result<JsUndefined> {
  let mut this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let js_stroke_style = ctx.get::<JsUnknown>(0)?;
  let last_state = &mut context_2d.state;

  match js_stroke_style.get_type()? {
    ValueType::String => {
      let js_color = unsafe { JsString::from_raw_unchecked(ctx.env.raw(), js_stroke_style.raw()) }
        .into_utf8()?;
      last_state.stroke_style = Pattern::from_color(js_color.as_str()?)?;
    }
    ValueType::Object => {
      let stroke_object = unsafe { js_stroke_style.cast::<JsObject>() };
      let pattern = ctx.env.unwrap::<Pattern>(&stroke_object)?;
      last_state.stroke_style = pattern.clone();
    }
    _ => {
      return Err(Error::new(
        Status::InvalidArg,
        "Invalid strokeStyle".to_string(),
      ))
    }
  }

  this.set_named_property("_strokeStyle", js_stroke_style)?;

  ctx.env.get_undefined()
}

#[js_function]
fn get_stroke_style(ctx: CallContext) -> Result<JsUnknown> {
  let this = ctx.this_unchecked::<JsObject>();
  this.get_named_property("_strokeStyle")
}

#[js_function]
fn get_shadow_blur(ctx: CallContext) -> Result<JsNumber> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let last_state = &mut context_2d.state;

  ctx.env.create_double(last_state.shadow_blur as f64)
}

#[js_function(1)]
fn set_shadow_blur(ctx: CallContext) -> Result<JsUndefined> {
  let blur = ctx.get::<JsNumber>(0)?.get_double()? as f32;

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  context_2d.state.shadow_blur = blur;

  ctx.env.get_undefined()
}

#[js_function]
fn get_shadow_color(ctx: CallContext) -> Result<JsString> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx
    .env
    .create_string(context_2d.state.shadow_color_string.as_str())
}

#[js_function(1)]
fn set_shadow_color(ctx: CallContext) -> Result<JsUndefined> {
  let shadow_color_string = ctx.get::<JsString>(0)?;
  let shadow_color = shadow_color_string.into_utf8()?;

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let last_state = &mut context_2d.state;
  let shadow_color_str = shadow_color.as_str()?;
  last_state.shadow_color_string = shadow_color_str.to_owned();

  if shadow_color_str.is_empty() {
    return ctx.env.get_undefined();
  }
  let mut parser_input = ParserInput::new(shadow_color_str);
  let mut parser = Parser::new(&mut parser_input);
  let color = CSSColor::parse(&mut parser)
    .map_err(|e| SkError::Generic(format!("Parse color [{}] error: {:?}", shadow_color_str, e)))?;

  match color {
    CSSColor::CurrentColor => {
      return Err(Error::new(
        Status::InvalidArg,
        "Color should not be `currentcolor` keyword".to_owned(),
      ))
    }
    CSSColor::RGBA(rgba) => {
      last_state.shadow_color = rgba;
    }
  }

  ctx.env.get_undefined()
}

#[js_function]
fn get_shadow_offset_x(ctx: CallContext) -> Result<JsNumber> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let last_state = &mut context_2d.state;

  ctx.env.create_double(last_state.shadow_offset_x as f64)
}

#[js_function(1)]
fn set_shadow_offset_x(ctx: CallContext) -> Result<JsUndefined> {
  let offset: f32 = ctx.get::<JsNumber>(0)?.get_double()? as f32;

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let last_state = &mut context_2d.state;

  last_state.shadow_offset_x = offset;

  ctx.env.get_undefined()
}

#[js_function]
fn get_shadow_offset_y(ctx: CallContext) -> Result<JsNumber> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let last_state = &mut context_2d.state;

  ctx.env.create_double(last_state.shadow_offset_y as f64)
}

#[js_function(1)]
fn set_shadow_offset_y(ctx: CallContext) -> Result<JsUndefined> {
  let offset = ctx.get::<JsNumber>(0)?.get_double()? as f32;

  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let last_state = &mut context_2d.state;

  last_state.shadow_offset_y = offset;

  ctx.env.get_undefined()
}

#[js_function(1)]
fn set_text_align(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  context_2d.state.text_align =
    TextAlign::from_str(ctx.get::<JsString>(0)?.into_utf8()?.as_str()?)?;
  ctx.env.get_undefined()
}

#[js_function]
fn get_text_align(ctx: CallContext) -> Result<JsString> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx.env.create_string(context_2d.state.text_align.as_str())
}

#[js_function(1)]
fn set_text_baseline(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  context_2d.state.text_baseline =
    TextBaseline::from_str(ctx.get::<JsString>(0)?.into_utf8()?.as_str()?)?;
  ctx.env.get_undefined()
}

#[js_function]
fn get_text_baseline(ctx: CallContext) -> Result<JsString> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx
    .env
    .create_string(context_2d.state.text_baseline.as_str())
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct AVIFConfig {
  pub quality: f32,
  pub speed: u8,
  pub threads: u8,
}

pub enum ContextData {
  Png(SurfaceRef),
  Jpeg(SurfaceRef, u8),
  Webp(SurfaceRef, u8),
  Avif(SurfaceRef, AVIFConfig, u32, u32),
}

unsafe impl Send for ContextData {}
unsafe impl Sync for ContextData {}

pub enum ContextOutputData {
  Skia(SkiaDataRef),
  Avif(Vec<u8>),
}

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
          ravif::encode_rgba(
            ravif::Img::new(
              unsafe { slice::from_raw_parts(data, size) }.as_rgba(),
              *width as usize,
              *height as usize,
            ),
            &ravif::Config {
              quality: config.quality,
              alpha_quality: ((config.quality + 100.) / 2.)
                .min(config.quality + config.quality / 4. + 2.),
              speed: config.speed,
              premultiplied_alpha: false,
              threads: 0,
              color_space: ravif::ColorSpace::RGB,
            },
          )
          .map(|(o, _width, _height)| ContextOutputData::Avif(o))
          .map_err(|e| Error::new(Status::GenericFailure, format!("{}", e)))
        }),
    }
  }

  fn resolve(self, env: Env, output_data: Self::Output) -> Result<Self::JsValue> {
    match output_data {
      ContextOutputData::Skia(output) => unsafe {
        env
          .create_buffer_with_borrowed_data(output.0.ptr, output.0.size, output, |data_ref, _| {
            mem::drop(data_ref)
          })
          .map(|value| value.into_raw())
      },
      ContextOutputData::Avif(output) => env.create_buffer_with_data(output).map(|b| b.into_raw()),
    }
  }
}
