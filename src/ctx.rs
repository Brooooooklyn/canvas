use std::convert::TryInto;
use std::f32::consts::PI;
use std::str::FromStr;

use napi::{
  CallContext, Env, Error, JsBoolean, JsFunction, JsNumber, JsObject, JsString, JsUndefined,
  Property, Result, Status,
};

use super::gradient::CanvasGradient;
use super::sk::*;

impl From<SkError> for Error {
  fn from(err: SkError) -> Error {
    Error::new(Status::InvalidArg, format!("{}", err))
  }
}

pub struct Context {
  surface: Surface,
  path: Path,
  paint: Paint,
}

impl Context {
  #[inline(always)]
  pub fn create_js_class(env: &Env) -> Result<JsFunction> {
    env.define_class(
      "CanvasRenderingContext2D",
      context_2d_constructor,
      &vec![
        Property::new(&env, "canvas")?.with_value(env.get_null()?),
        // properties
        Property::new(&env, "miterLimit")?
          .with_getter(get_miter_limit)
          .with_setter(set_miter_limit),
        Property::new(&env, "globalAlpha")?
          .with_getter(get_global_alpha)
          .with_setter(set_global_alpha),
        Property::new(&env, "globalCompositeOperation")?
          .with_getter(get_global_composite_operation)
          .with_setter(set_global_composite_operation),
        // methods
        Property::new(&env, "arc")?.with_method(arc),
        Property::new(&env, "arcTo")?.with_method(arc_to),
        Property::new(&env, "beginPath")?.with_method(begin_path),
        Property::new(&env, "bezierCurveTo")?.with_method(bezier_curve_to),
        Property::new(&env, "rect")?.with_method(rect),
        Property::new(&env, "save")?.with_method(save),
        Property::new(&env, "restore")?.with_method(restore),
        Property::new(&env, "clearRect")?.with_method(clear_rect),
        Property::new(&env, "createLinearGradient")?.with_method(create_linear_gradient),
        Property::new(&env, "createRadialGradient")?.with_method(create_radial_gradient),
      ],
    )
  }

  #[inline(always)]
  pub fn new(width: u32, height: u32) -> Result<Self> {
    let surface = Surface::new_rgba(width, height)
      .ok_or(Error::from_reason("Create skia surface failed".to_owned()))?;
    Ok(Context {
      surface,
      path: Path::new(),
      paint: Paint::default(),
    })
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
      (center_x, center_y),
      (radius, radius),
      0.0,
      start_angle,
      end_angle,
      from_end,
    )
  }

  #[inline(always)]
  pub fn arc_to(&mut self, ctrl_x: f32, ctrl_y: f32, to_x: f32, to_y: f32, radius: f32) {
    self.scoot(ctrl_x, ctrl_y);
    self.path.arc_to_tangent(ctrl_x, ctrl_y, to_x, to_y, radius);
  }

  #[inline(always)]
  pub fn begin_path(&mut self) {
    let new_sub_path = Path::new();
    self.path = new_sub_path;
  }

  #[inline(always)]
  pub fn bezier_curve_to(&mut self, cp1x: f32, cp1y: f32, cp2x: f32, cp2y: f32, x: f32, y: f32) {
    self.scoot(cp1x, cp1y);
    self.path.cubic_to(cp1x, cp1y, cp2x, cp2y, x, y);
  }

  #[inline(always)]
  pub fn clip(&mut self, path: Option<&mut Path>, fill_rule: FillType) {
    let mut clip = match path {
      Some(path) => path,
      None => {
        &mut self.path
      }
    };
    clip.set_fill_type(fill_rule);
    self.surface.canvas.set_clip_path(clip);
  }

  #[inline(always)]
  pub fn rect(&mut self, x: f32, y: f32, width: f32, height: f32) {
    self.path.add_rect(x, y, width, height);
  }

  #[inline(always)]
  pub fn save(&mut self) {
    self.surface.save();
  }

  #[inline(always)]
  pub fn restore(&mut self) {
    self.surface.restore();
  }

  #[inline(always)]
  pub fn clear_rect(&mut self, x: f32, y: f32, width: f32, height: f32) {
    let mut paint = Paint::new();
    paint.set_style(PaintStyle::Fill);
    paint.set_color(0, 0, 0, 0);
    paint.set_stroke_miter(10.0);
    paint.set_blend_mode(BlendMode::SourceOver);
    self.surface.draw_rect(x, y, width, height, &paint);
  }

  #[inline(always)]
  pub fn create_linear_gradient(&self, x0: f32, y0: f32, x1: f32, y1: f32) -> CanvasGradient {
    CanvasGradient::create_linear_gradient(x0, y0, x1, y1)
  }

  #[inline(always)]
  pub fn create_radial_gradient(
    &self,
    x0: f32,
    y0: f32,
    r0: f32,
    x1: f32,
    y1: f32,
    r1: f32,
  ) -> CanvasGradient {
    CanvasGradient::create_radial_gradient(x0, y0, r0, x1, y1, r1)
  }

  #[inline(always)]
  pub fn set_miter_limit(&mut self, miter: f32) {
    self.paint.set_stroke_miter(miter);
  }

  #[inline(always)]
  pub fn get_miter_limit(&self) -> f32 {
    self.paint.get_stroke_miter()
  }

  #[inline(always)]
  pub fn get_global_alpha(&self) -> f32 {
    (self.paint.get_alpha() as f32) / 100.0
  }

  #[inline(always)]
  pub fn set_global_alpha(&mut self, alpha: u8) {
    self.paint.set_alpha(alpha);
  }

  #[inline(always)]
  pub fn get_global_composite_operation(&self) -> BlendMode {
    self.paint.get_blend_mode()
  }

  #[inline(always)]
  pub fn set_global_composite_operation(&mut self, blend: BlendMode) {
    self.paint.set_blend_mode(blend);
  }

  #[inline(always)]
  pub fn ellipse(
    &mut self,
    origin: (f32, f32),
    radii: (f32, f32),
    rotation: f32,
    start_angle: f32,
    end_angle: f32,
    ccw: bool,
  ) {
    let (x, y) = origin;
    let (x_radius, y_radius) = radii;

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
    let left = x - x_radius;
    let top = y - y_radius;
    let right = x + x_radius;
    let bottom = y + y_radius;
    let mut rotated = Matrix::identity();
    rotated.pre_translate(x, y);
    rotated.pre_rotate(radians_to_degrees(rotation));
    rotated.pre_translate(-x, -y);
    let unrotated = rotated.invert().unwrap();

    self.path.transform_matrix(&unrotated);

    // draw in 2 180 degree segments because trying to draw all 360 degrees at once
    // draws nothing.
    let sweep_deg = radians_to_degrees(end_angle - start_angle);
    let start_deg = radians_to_degrees(start_angle);
    if almost_equal(sweep_deg.abs(), 360.0) {
      let half_sweep = sweep_deg / 2.0;
      self
        .path
        .arc_to(left, top, right, bottom, start_deg, half_sweep, false);
      self.path.arc_to(
        x - x_radius,
        y - y_radius,
        x + x_radius,
        y + y_radius,
        start_deg + half_sweep,
        half_sweep,
        false,
      );
    } else {
      self
        .path
        .arc_to(left, top, right, bottom, start_deg, sweep_deg, false);
    }

    self.path.transform_matrix(&rotated);
  }

  #[inline(always)]
  fn scoot(&mut self, x: f32, y: f32) {
    if self.path.is_empty() {
      self.path.move_to(x, y);
    }
  }
}

#[inline(always)]
fn radians_to_degrees(rad: f32) -> f32 {
  (rad / PI) * 180.0
}

#[inline]
fn almost_equal(floata: f32, floatb: f32) -> bool {
  (floata - floatb).abs() < 0.00001
}

#[js_function(2)]
fn context_2d_constructor(ctx: CallContext) -> Result<JsUndefined> {
  let width: u32 = ctx.get::<JsNumber>(0)?.try_into()?;
  let height: u32 = ctx.get::<JsNumber>(1)?.try_into()?;
  let mut this = ctx.this_unchecked::<JsObject>();
  let context_2d = Context::new(width, height)?;
  ctx.env.wrap(&mut this, context_2d)?;
  ctx.env.get_undefined()
}

#[js_function(6)]
fn arc(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let center_x: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let center_y: f64 = ctx.get::<JsNumber>(1)?.try_into()?;
  let radius: f64 = ctx.get::<JsNumber>(2)?.try_into()?;
  let start_angle: f64 = ctx.get::<JsNumber>(3)?.try_into()?;
  let end_angle: f64 = ctx.get::<JsNumber>(4)?.try_into()?;
  let from_end = ctx.get::<JsBoolean>(5)?;
  context_2d.arc(
    center_x as f32,
    center_y as f32,
    radius as f32,
    start_angle as f32,
    end_angle as f32,
    from_end.get_value()?,
  );
  ctx.env.get_undefined()
}

#[js_function(5)]
fn arc_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let ctrl_x: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let ctrl_y: f64 = ctx.get::<JsNumber>(1)?.try_into()?;
  let to_x: f64 = ctx.get::<JsNumber>(2)?.try_into()?;
  let to_y: f64 = ctx.get::<JsNumber>(3)?.try_into()?;
  let radius: f64 = ctx.get::<JsNumber>(4)?.try_into()?;

  context_2d.arc_to(
    ctrl_x as f32,
    ctrl_y as f32,
    to_x as f32,
    to_y as f32,
    radius as f32,
  );
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

  let cp1x: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let cp1y: f64 = ctx.get::<JsNumber>(1)?.try_into()?;
  let cp2x: f64 = ctx.get::<JsNumber>(2)?.try_into()?;
  let cp2y: f64 = ctx.get::<JsNumber>(3)?.try_into()?;
  let x: f64 = ctx.get::<JsNumber>(4)?.try_into()?;
  let y: f64 = ctx.get::<JsNumber>(5)?.try_into()?;

  context_2d.bezier_curve_to(
    cp1x as f32,
    cp1y as f32,
    cp2x as f32,
    cp2y as f32,
    x as f32,
    y as f32,
  );

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
    context_2d.clip(Some(ctx.env.unwrap::<Path>(&path)?), FillType::from_str(rule.into_utf8()?.as_str()?)?);
  };

  ctx.env.get_undefined()
}

#[js_function(4)]
fn rect(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  let x: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let y: f64 = ctx.get::<JsNumber>(1)?.try_into()?;
  let width: f64 = ctx.get::<JsNumber>(2)?.try_into()?;
  let height: f64 = ctx.get::<JsNumber>(3)?.try_into()?;

  context_2d.rect(x as f32, y as f32, width as f32, height as f32);
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

#[js_function(4)]
fn clear_rect(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let x: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let y: f64 = ctx.get::<JsNumber>(1)?.try_into()?;
  let width: f64 = ctx.get::<JsNumber>(2)?.try_into()?;
  let height: f64 = ctx.get::<JsNumber>(3)?.try_into()?;
  context_2d.clear_rect(x as f32, y as f32, width as f32, height as f32);
  ctx.env.get_undefined()
}

#[js_function(4)]
fn create_linear_gradient(ctx: CallContext) -> Result<JsObject> {
  let this = ctx.this::<JsObject>()?;
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let x0: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let y0: f64 = ctx.get::<JsNumber>(1)?.try_into()?;
  let x1: f64 = ctx.get::<JsNumber>(2)?.try_into()?;
  let y1: f64 = ctx.get::<JsNumber>(3)?.try_into()?;
  let linear_gradient =
    context_2d.create_linear_gradient(x0 as f32, y0 as f32, x1 as f32, y1 as f32);
  linear_gradient.into_js_instance(ctx.env)
}

#[js_function(6)]
fn create_radial_gradient(ctx: CallContext) -> Result<JsObject> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let x0: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let y0: f64 = ctx.get::<JsNumber>(1)?.try_into()?;
  let r0: f64 = ctx.get::<JsNumber>(2)?.try_into()?;
  let x1: f64 = ctx.get::<JsNumber>(3)?.try_into()?;
  let y1: f64 = ctx.get::<JsNumber>(4)?.try_into()?;
  let r1: f64 = ctx.get::<JsNumber>(5)?.try_into()?;
  let radial_gradient = context_2d.create_radial_gradient(
    x0 as f32, y0 as f32, r0 as f32, x1 as f32, y1 as f32, r1 as f32,
  );
  radial_gradient.into_js_instance(ctx.env)
}

#[js_function(1)]
fn set_miter_limit(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let miter: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  context_2d.set_miter_limit(miter as f32);
  ctx.env.get_undefined()
}

#[js_function]
fn get_miter_limit(ctx: CallContext) -> Result<JsNumber> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx.env.create_double(context_2d.get_miter_limit() as f64)
}

#[js_function(1)]
fn set_global_alpha(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let alpha: f64 = ctx.get::<JsNumber>(0)?.try_into()?;

  if alpha < 0.0 || alpha > 1.0 {
    return Err(Error::new(
      Status::InvalidArg,
      format!(
        "Alpha value out of range, expected 0.0 - 1.0, but got : {}",
        alpha
      ),
    ));
  }

  context_2d.set_global_alpha((alpha * 100.0) as u8);
  ctx.env.get_undefined()
}

#[js_function]
fn get_global_alpha(ctx: CallContext) -> Result<JsNumber> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx.env.create_double(context_2d.get_global_alpha() as _)
}

#[js_function(1)]
fn set_global_composite_operation(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;
  let blend_string = ctx.get::<JsString>(0)?.into_utf8()?;

  context_2d.set_global_composite_operation(
    BlendMode::from_str(blend_string.as_str()?).map_err(Error::from)?,
  );

  ctx.env.get_undefined()
}

#[js_function]
fn get_global_composite_operation(ctx: CallContext) -> Result<JsString> {
  let this = ctx.this_unchecked::<JsObject>();
  let context_2d = ctx.env.unwrap::<Context>(&this)?;

  ctx
    .env
    .create_string(context_2d.get_global_composite_operation().as_str())
}
