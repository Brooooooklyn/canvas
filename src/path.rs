use napi::*;

use crate::sk::*;

impl Path {
  pub fn create_js_class(env: &Env) -> Result<JsFunction> {
    env.define_class(
      "Path2D",
      path_constructor,
      &vec![
        // Standard Path2d methods
        Property::new("addPath")?.with_method(add_path),
        Property::new("closePath")?.with_method(close_path),
        Property::new("moveTo")?.with_method(move_to),
        Property::new("lineTo")?.with_method(line_to),
        Property::new("bezierCurveTo")?.with_method(bezier_curve_to),
        Property::new("quadraticCurveTo")?.with_method(quadratic_curve_to),
        Property::new("arc")?.with_method(arc),
        Property::new("arcTo")?.with_method(arc_to),
        Property::new("ellipse")?.with_method(ellipse),
        Property::new("rect")?.with_method(rect),
        // extra methods in PathKit
        Property::new("op")?.with_method(op),
        Property::new("simplify")?.with_method(simplify),
        Property::new("setFillType")?.with_method(set_fill_type),
        Property::new("getFillType")?.with_method(get_fill_type),
        Property::new("asWinding")?.with_method(as_winding),
        Property::new("toSVGString")?.with_method(to_svg_string),
        Property::new("getBounds")?.with_method(get_bounds),
        Property::new("computeTightBounds")?.with_method(compute_tight_bounds),
        Property::new("transform")?.with_method(transform),
        Property::new("trim")?.with_method(trim),
        Property::new("dash")?.with_method(dash),
        Property::new("equals")?.with_method(equals),
        Property::new("_stroke")?.with_method(stroke),
      ],
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
          "Invalid Path2D constructor argument".to_string(),
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
  } else {
    Matrix::identity()
  };
  path_2d.add_path(sub_path, &transform);
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
  let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;

  path_2d.move_to(x, y);

  ctx.env.get_undefined()
}

#[js_function(2)]
fn line_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;

  path_2d.line_to(x, y);

  ctx.env.get_undefined()
}

#[js_function(6)]
fn bezier_curve_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let cp1x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let cp1y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let cp2x = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let cp2y = ctx.get::<JsNumber>(3)?.get_double()? as f32;
  let x = ctx.get::<JsNumber>(4)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(5)?.get_double()? as f32;

  path_2d.cubic_to(cp1x, cp1y, cp2x, cp2y, x, y);

  ctx.env.get_undefined()
}

#[js_function(4)]
fn quadratic_curve_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let cpx = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let cpy = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let x = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(3)?.get_double()? as f32;

  path_2d.quad_to(cpx, cpy, x, y);

  ctx.env.get_undefined()
}

#[js_function(6)]
fn arc(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let center_x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let center_y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let radius = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let start_angle = ctx.get::<JsNumber>(3)?.get_double()? as f32;
  let end_angle = ctx.get::<JsNumber>(4)?.get_double()? as f32;
  let from_end = if ctx.length == 6 {
    ctx.get::<JsBoolean>(5)?.get_value()?
  } else {
    false
  };
  path_2d.arc(center_x, center_y, radius, start_angle, end_angle, from_end);
  ctx.env.get_undefined()
}

#[js_function(5)]
fn arc_to(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;

  let ctrl_x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let ctrl_y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let to_x = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let to_y = ctx.get::<JsNumber>(3)?.get_double()? as f32;
  let radius = ctx.get::<JsNumber>(4)?.get_double()? as f32;

  path_2d.arc_to_tangent(ctrl_x, ctrl_y, to_x, to_y, radius);
  ctx.env.get_undefined()
}

#[js_function(8)]
fn ellipse(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
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
  path_2d.ellipse(
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

#[js_function(4)]
fn rect(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let x = ctx.get::<JsNumber>(0)?.get_double()? as f32;
  let y = ctx.get::<JsNumber>(1)?.get_double()? as f32;
  let width = ctx.get::<JsNumber>(2)?.get_double()? as f32;
  let height = ctx.get::<JsNumber>(3)?.get_double()? as f32;

  path_2d.add_rect(x as f32, y as f32, width as f32, height as f32);

  ctx.env.get_undefined()
}

#[js_function(2)]
fn op(ctx: CallContext) -> Result<JsObject> {
  let this: JsObject = ctx.this_unchecked();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let other = ctx.get::<JsObject>(0)?;
  let other_path = ctx.env.unwrap::<Path>(&other)?;
  let operation = ctx.get::<JsNumber>(1)?.get_int32()?;
  path_2d.op(other_path, operation.into());
  Ok(this)
}

#[js_function]
fn to_svg_string(ctx: CallContext) -> Result<JsString> {
  let this: JsObject = ctx.this_unchecked();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let sk_string = path_2d.to_svg_string();
  unsafe {
    ctx
      .env
      .create_string_from_c_char(sk_string.ptr, sk_string.length)
  }
}

#[js_function]
fn simplify(ctx: CallContext) -> Result<JsObject> {
  let this: JsObject = ctx.this_unchecked();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;

  path_2d.simplify();
  Ok(this)
}

#[js_function(1)]
fn set_fill_type(ctx: CallContext) -> Result<JsUndefined> {
  let this: JsObject = ctx.this_unchecked();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let fill_type = ctx.get::<JsNumber>(0)?.get_uint32()?;

  path_2d.set_fill_type(fill_type.into());

  ctx.env.get_undefined()
}

#[js_function]
fn get_fill_type(ctx: CallContext) -> Result<JsNumber> {
  let this: JsObject = ctx.this_unchecked();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;

  ctx.env.create_int32(path_2d.get_fill_type())
}

#[js_function]
fn as_winding(ctx: CallContext) -> Result<JsObject> {
  let this: JsObject = ctx.this_unchecked();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  path_2d.as_winding();
  Ok(this)
}

#[js_function(4)]
fn stroke(ctx: CallContext) -> Result<JsObject> {
  let this: JsObject = ctx.this_unchecked();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let stroke_width = ctx.get::<JsNumber>(0)?;
  let miter_limit = ctx.get::<JsNumber>(1)?;
  let join = ctx.get::<JsNumber>(2)?;
  let cap = ctx.get::<JsNumber>(3)?;

  path_2d.stroke(
    StrokeCap::from_raw(cap.get_int32()?)?,
    StrokeJoin::from_raw(join.get_uint32()? as u8)?,
    stroke_width.get_double()? as f32,
    miter_limit.get_double()? as f32,
  );
  Ok(this)
}

#[js_function]
fn compute_tight_bounds(ctx: CallContext) -> Result<JsObject> {
  let this: JsObject = ctx.this_unchecked();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;

  let ltrb = path_2d.compute_tight_bounds();
  let mut arr = ctx.env.create_array_with_length(4)?;
  arr.set_element(0, ctx.env.create_double(ltrb.0 as f64)?)?;
  arr.set_element(1, ctx.env.create_double(ltrb.1 as f64)?)?;
  arr.set_element(2, ctx.env.create_double(ltrb.2 as f64)?)?;
  arr.set_element(3, ctx.env.create_double(ltrb.3 as f64)?)?;
  Ok(arr)
}

#[js_function]
fn get_bounds(ctx: CallContext) -> Result<JsObject> {
  let this: JsObject = ctx.this_unchecked();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;

  let ltrb = path_2d.get_bounds();
  let mut arr = ctx.env.create_array_with_length(4)?;
  arr.set_element(0, ctx.env.create_double(ltrb.0 as f64)?)?;
  arr.set_element(1, ctx.env.create_double(ltrb.1 as f64)?)?;
  arr.set_element(2, ctx.env.create_double(ltrb.2 as f64)?)?;
  arr.set_element(3, ctx.env.create_double(ltrb.3 as f64)?)?;
  Ok(arr)
}

#[js_function(1)]
fn transform(ctx: CallContext) -> Result<JsObject> {
  let this: JsObject = ctx.this_unchecked();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
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
  let trans = Matrix::new(a, c, e, b, d, f);

  path_2d.transform_self(&trans);
  Ok(this)
}

#[js_function(3)]
fn trim(ctx: CallContext) -> Result<JsObject> {
  let this: JsObject = ctx.this_unchecked();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let start = ctx.get::<JsNumber>(0)?.get_double()?;
  let end = ctx.get::<JsNumber>(1)?.get_double()?;
  let is_complement = ctx
    .get::<JsBoolean>(2)
    .and_then(|v| v.get_value())
    .unwrap_or(false);
  path_2d.trim(start as f32, end as f32, is_complement);
  Ok(this)
}

#[js_function(3)]
fn dash(ctx: CallContext) -> Result<JsObject> {
  let this: JsObject = ctx.this_unchecked();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let on = ctx.get::<JsNumber>(0)?.get_double()?;
  let off = ctx.get::<JsNumber>(1)?.get_double()?;
  let phase = ctx.get::<JsNumber>(1)?.get_double()?;

  path_2d.dash(on as f32, off as f32, phase as f32);
  Ok(this)
}

#[js_function(1)]
fn equals(ctx: CallContext) -> Result<JsBoolean> {
  let this: JsObject = ctx.this_unchecked();
  let path_2d = ctx.env.unwrap::<Path>(&this)?;
  let other = ctx.get::<JsObject>(0)?;
  let is_eq = path_2d == ctx.env.unwrap::<Path>(&other)?;
  ctx.env.get_boolean(is_eq)
}
