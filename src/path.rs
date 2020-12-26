use std::convert::TryInto;
use std::f32::consts::PI;

use napi::*;

use crate::sk::*;

impl Path {
  #[inline(always)]
  pub fn create_js_class(env: &Env) -> Result<JsFunction> {
    env.define_class(
      "Path2D",
      path_constructor,
      &vec![
        Property::new(&env, "addPath")?.with_method(add_path),
        Property::new(&env, "closePath")?.with_method(close_path),
        Property::new(&env, "moveTo")?.with_method(move_to),
        Property::new(&env, "lineTo")?.with_method(line_to),
        Property::new(&env, "bezierCurveTo")?.with_method(bezier_curve_to),
        Property::new(&env, "quadraticCurveTo")?.with_method(quadratic_curve_to),
        Property::new(&env, "arc")?.with_method(arc),
        Property::new(&env, "arcTo")?.with_method(arc_to),
        Property::new(&env, "ellipse")?.with_method(ellipse),
        Property::new(&env, "rect")?.with_method(rect),
      ],
    )
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
}

#[js_function(1)]
fn path_constructor(ctx: CallContext) -> Result<JsUndefined> {
  let mut this = ctx.this_unchecked::<JsObject>();
  let p = if ctx.length == 0 {
    Path::new()
  } else {
    let input = ctx.get::<JsUnknown>(0)?;
    match input.get_type()? {
      ValueType::String => {
        let path_string = unsafe { input.cast::<JsString>() }.into_utf8()?;
        Path::from_svg_path(path_string.as_str()?).ok_or_else(|| {
          Error::new(
            Status::InvalidArg,
            "Create path from provided path string failed.".to_owned(),
          )
        })?
      }
      ValueType::Object => {
        let path_object = unsafe { input.cast::<JsObject>() };
        let input_path = ctx.env.unwrap::<Path>(&path_object)?;
        input_path.clone()
      }
      _ => {
        return Err(Error::new(
          Status::InvalidArg,
          format!("Invalid Path2D constructor argument"),
        ))
      }
    }
  };
  ctx.env.wrap(&mut this, p)?;
  ctx.env.get_undefined()
}

#[js_function(2)]
fn add_path(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;

  let sub_path_obj = ctx.get::<JsObject>(0)?;
  let sub_path = ctx.env.unwrap::<Path>(&sub_path_obj)?;
  let transform = if ctx.length == 2 {
    let transform_object = ctx.get::<JsObject>(1)?;
    let a: f64 = transform_object
      .get_named_property::<JsNumber>("a")?
      .try_into()?;
    let b: f64 = transform_object
      .get_named_property::<JsNumber>("b")?
      .try_into()?;
    let c: f64 = transform_object
      .get_named_property::<JsNumber>("c")?
      .try_into()?;
    let d: f64 = transform_object
      .get_named_property::<JsNumber>("d")?
      .try_into()?;
    let e: f64 = transform_object
      .get_named_property::<JsNumber>("e")?
      .try_into()?;
    let f: f64 = transform_object
      .get_named_property::<JsNumber>("f")?
      .try_into()?;
    Transform::new(a as f32, b as f32, c as f32, d as f32, e as f32, f as f32)
  } else {
    Default::default()
  };
  path_2d.add_path(sub_path, transform);
  ctx.env.get_undefined()
}

#[js_function]
fn close_path(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;

  path_2d.close();

  ctx.env.get_undefined()
}

#[js_function(2)]
fn move_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let x: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let y: f64 = ctx.get::<JsNumber>(1)?.try_into()?;

  path_2d.move_to(x as f32, y as f32);

  ctx.env.get_undefined()
}

#[js_function(2)]
fn line_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let x: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let y: f64 = ctx.get::<JsNumber>(1)?.try_into()?;

  path_2d.line_to(x as f32, y as f32);

  ctx.env.get_undefined()
}

#[js_function(6)]
fn bezier_curve_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let cp1x: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let cp1y: f64 = ctx.get::<JsNumber>(1)?.try_into()?;
  let cp2x: f64 = ctx.get::<JsNumber>(2)?.try_into()?;
  let cp2y: f64 = ctx.get::<JsNumber>(3)?.try_into()?;
  let x: f64 = ctx.get::<JsNumber>(4)?.try_into()?;
  let y: f64 = ctx.get::<JsNumber>(5)?.try_into()?;

  path_2d.cubic_to(
    cp1x as f32,
    cp1y as f32,
    cp2x as f32,
    cp2y as f32,
    x as f32,
    y as f32,
  );

  ctx.env.get_undefined()
}

#[js_function(4)]
fn quadratic_curve_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let cpx: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let cpy: f64 = ctx.get::<JsNumber>(1)?.try_into()?;
  let x: f64 = ctx.get::<JsNumber>(2)?.try_into()?;
  let y: f64 = ctx.get::<JsNumber>(3)?.try_into()?;

  path_2d.quad_to(cpx as f32, cpy as f32, x as f32, y as f32);

  ctx.env.get_undefined()
}

#[js_function(6)]
fn arc(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let center_x: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let center_y: f64 = ctx.get::<JsNumber>(1)?.try_into()?;
  let radius: f64 = ctx.get::<JsNumber>(2)?.try_into()?;
  let start_angle: f64 = ctx.get::<JsNumber>(3)?.try_into()?;
  let end_angle: f64 = ctx.get::<JsNumber>(4)?.try_into()?;
  let from_end = if ctx.length == 6 {
    ctx.get::<JsBoolean>(5)?.get_value()?
  } else {
    false
  };
  path_2d.arc(
    center_x as f32,
    center_y as f32,
    radius as f32,
    start_angle as f32,
    end_angle as f32,
    from_end,
  );
  ctx.env.get_undefined()
}

#[js_function(5)]
fn arc_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;

  let ctrl_x: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let ctrl_y: f64 = ctx.get::<JsNumber>(1)?.try_into()?;
  let to_x: f64 = ctx.get::<JsNumber>(2)?.try_into()?;
  let to_y: f64 = ctx.get::<JsNumber>(3)?.try_into()?;
  let radius: f64 = ctx.get::<JsNumber>(4)?.try_into()?;

  path_2d.arc_to_tangent(
    ctrl_x as f32,
    ctrl_y as f32,
    to_x as f32,
    to_y as f32,
    radius as f32,
  );
  ctx.env.get_undefined()
}

#[js_function(8)]
fn ellipse(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let x: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let y: f64 = ctx.get::<JsNumber>(1)?.try_into()?;
  let radius_x: f64 = ctx.get::<JsNumber>(2)?.try_into()?;
  let radius_y: f64 = ctx.get::<JsNumber>(3)?.try_into()?;
  let rotation: f64 = ctx.get::<JsNumber>(4)?.try_into()?;
  let start_angle: f64 = ctx.get::<JsNumber>(5)?.try_into()?;
  let end_angle: f64 = ctx.get::<JsNumber>(6)?.try_into()?;

  let from_end = if ctx.length == 8 {
    ctx.get::<JsBoolean>(7)?.get_value()?
  } else {
    false
  };
  path_2d.ellipse(
    x as f32,
    y as f32,
    radius_x as f32,
    radius_y as f32,
    rotation as f32,
    start_angle as f32,
    end_angle as f32,
    from_end,
  );
  ctx.env.get_undefined()
}

#[js_function(4)]
fn rect(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let x: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let y: f64 = ctx.get::<JsNumber>(1)?.try_into()?;
  let width: f64 = ctx.get::<JsNumber>(2)?.try_into()?;
  let height: f64 = ctx.get::<JsNumber>(3)?.try_into()?;

  path_2d.add_rect(x as f32, y as f32, width as f32, height as f32);

  ctx.env.get_undefined()
}

#[inline(always)]
fn radians_to_degrees(rad: f32) -> f32 {
  (rad / PI) * 180.0
}

#[inline(always)]
fn almost_equal(floata: f32, floatb: f32) -> bool {
  (floata - floatb).abs() < 0.00001
}
