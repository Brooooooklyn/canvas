use napi::bindgen_prelude::*;

use crate::ctx::{check_radius, is_path2d, not_path2d};
use crate::num;
use crate::sk::{
  FillType as SkFillType, Matrix as SkMatrix, Path as SkPath, PathOp as SkPathOp, SkiaString,
  StrokeCap as SkStrokeCap, StrokeJoin as SkStrokeJoin,
};
use crate::webidl::{self, Double};

#[napi(object)]
pub struct Matrix {
  pub a: f64,
  pub b: f64,
  pub c: f64,
  pub d: f64,
  pub e: f64,
  pub f: f64,
}

#[napi]
pub enum PathOp {
  Difference,        // subtract the op path from the first path
  Intersect,         // intersect the two paths
  Union,             // union (inclusive-or) the two paths
  Xor,               // exclusive-or the two paths
  ReverseDifference, // subtract the first path from the op path
}

impl From<PathOp> for SkPathOp {
  fn from(value: PathOp) -> Self {
    match value {
      PathOp::Difference => SkPathOp::Difference,
      PathOp::Intersect => SkPathOp::Intersect,
      PathOp::Union => SkPathOp::Union,
      PathOp::Xor => SkPathOp::Xor,
      PathOp::ReverseDifference => SkPathOp::ReverseDifference,
    }
  }
}

#[napi]
#[derive(PartialEq, Eq, Hash, Debug)]
pub enum FillType {
  Winding = 0,
  EvenOdd = 1,
  InverseWinding = 2,
  InverseEvenOdd = 3,
}

impl From<FillType> for SkFillType {
  fn from(value: FillType) -> Self {
    match value {
      FillType::Winding => SkFillType::Winding,
      FillType::EvenOdd => SkFillType::EvenOdd,
      FillType::InverseWinding => SkFillType::InverseWinding,
      FillType::InverseEvenOdd => SkFillType::InverseEvenOdd,
    }
  }
}

impl From<i32> for FillType {
  fn from(value: i32) -> Self {
    match value {
      0 => FillType::Winding,
      1 => FillType::EvenOdd,
      2 => FillType::InverseWinding,
      3 => FillType::InverseEvenOdd,
      _ => unreachable!(),
    }
  }
}

#[napi]
#[derive(Default)]
pub enum StrokeCap {
  #[default]
  Butt = 0,
  Round = 1,
  Square = 2,
}

impl From<StrokeCap> for SkStrokeCap {
  fn from(value: StrokeCap) -> Self {
    match value {
      StrokeCap::Butt => SkStrokeCap::Butt,
      StrokeCap::Round => SkStrokeCap::Round,
      StrokeCap::Square => SkStrokeCap::Square,
    }
  }
}

#[napi]
#[derive(Default)]
pub enum StrokeJoin {
  #[default]
  Miter = 0,
  Round = 1,
  Bevel = 2,
}

impl From<StrokeJoin> for SkStrokeJoin {
  fn from(value: StrokeJoin) -> Self {
    match value {
      StrokeJoin::Miter => SkStrokeJoin::Miter,
      StrokeJoin::Round => SkStrokeJoin::Round,
      StrokeJoin::Bevel => SkStrokeJoin::Bevel,
    }
  }
}

#[napi(object)]
pub struct StrokeOptions {
  pub width: Option<f64>,
  pub miter_limit: Option<f64>,
  pub cap: Option<StrokeCap>,
  pub join: Option<StrokeJoin>,
}

#[napi]
pub struct Path {
  pub(crate) inner: SkPath,
}

#[napi]
impl Path {
  #[napi(constructor)]
  pub fn new(path: Option<PathInit>) -> Self {
    Path {
      inner: path.map_or_else(SkPath::new, |path| path.0),
    }
  }

  /// addPath(path, transform = {}) (Blink path_2d.h:80-91). The index.js
  /// wrapper checks the argument count.
  #[napi]
  pub fn add_path(&mut self, path: AddPathSource, transform: AddPathTransform) {
    let [a, b, c, d, e, f] = transform.0;
    // A non-finite matrix adds nothing.
    if ![a, b, c, d, e, f].iter().all(|v| v.is_finite()) {
      return;
    }
    let matrix = SkMatrix::new(a as f32, c as f32, e as f32, b as f32, d as f32, f as f32);
    // The path is read now, after the matrix getters ran, as in Chrome. It
    // may be this path.
    if std::ptr::eq(path.0, self) {
      let source = self.inner.clone();
      self.inner.add_path(&source, &matrix);
    } else {
      // SAFETY: a live Path2D other than the receiver (AddPathSource).
      let source = unsafe { &*path.0 };
      self.inner.add_path(&source.inner, &matrix);
    }
  }

  #[napi]
  pub fn close_path(&mut self) {
    self.inner.close();
  }

  // Path methods drop a call with a value outside the float range, as the
  // context does (Blink canvas_path.cc: saturated_cast<float>, then isfinite).

  #[napi]
  pub fn move_to(&mut self, x: Double<webidl::PathMoveTo>, y: Double<webidl::PathMoveTo>) {
    if let Some([x, y]) = num::saturated_f32s([x.0, y.0]) {
      self.inner.move_to(x, y);
    }
  }

  #[napi]
  pub fn line_to(&mut self, x: Double<webidl::PathLineTo>, y: Double<webidl::PathLineTo>) {
    if let Some([x, y]) = num::saturated_f32s([x.0, y.0]) {
      self.inner.line_to(x, y);
    }
  }

  #[napi]
  pub fn bezier_curve_to(
    &mut self,
    cp1x: Double<webidl::PathBezierCurveTo>,
    cp1y: Double<webidl::PathBezierCurveTo>,
    cp2x: Double<webidl::PathBezierCurveTo>,
    cp2y: Double<webidl::PathBezierCurveTo>,
    x: Double<webidl::PathBezierCurveTo>,
    y: Double<webidl::PathBezierCurveTo>,
  ) {
    if let Some([cp1x, cp1y, cp2x, cp2y, x, y]) =
      num::saturated_f32s([cp1x.0, cp1y.0, cp2x.0, cp2y.0, x.0, y.0])
    {
      self.inner.cubic_to(cp1x, cp1y, cp2x, cp2y, x, y);
    }
  }

  #[napi]
  pub fn quadratic_curve_to(
    &mut self,
    cpx: Double<webidl::PathQuadraticCurveTo>,
    cpy: Double<webidl::PathQuadraticCurveTo>,
    x: Double<webidl::PathQuadraticCurveTo>,
    y: Double<webidl::PathQuadraticCurveTo>,
  ) {
    if let Some([cpx, cpy, x, y]) = num::saturated_f32s([cpx.0, cpy.0, x.0, y.0]) {
      self.inner.quad_to(cpx, cpy, x, y);
    }
  }

  #[napi]
  pub fn arc(
    &mut self,
    env: &Env,
    x: Double<webidl::PathArc>,
    y: Double<webidl::PathArc>,
    radius: Double<webidl::PathArc>,
    start_angle: Double<webidl::PathArc>,
    end_angle: Double<webidl::PathArc>,
    anticlockwise: webidl::Boolean,
  ) -> Result<()> {
    let Some([x, y, radius, start_angle, end_angle]) =
      num::saturated_f32s([x.0, y.0, radius.0, start_angle.0, end_angle.0])
    else {
      return Ok(());
    };
    check_radius(
      env.raw(),
      <webidl::PathArc as webidl::Site>::PREFIX,
      "radius",
      radius,
    )?;
    self
      .inner
      .arc(x, y, radius, start_angle, end_angle, anticlockwise.0);
    Ok(())
  }

  #[napi]
  pub fn arc_to(
    &mut self,
    env: &Env,
    x1: Double<webidl::PathArcTo>,
    y1: Double<webidl::PathArcTo>,
    x2: Double<webidl::PathArcTo>,
    y2: Double<webidl::PathArcTo>,
    radius: Double<webidl::PathArcTo>,
  ) -> Result<()> {
    let Some([x1, y1, x2, y2, radius]) = num::saturated_f32s([x1.0, y1.0, x2.0, y2.0, radius.0])
    else {
      return Ok(());
    };
    check_radius(
      env.raw(),
      <webidl::PathArcTo as webidl::Site>::PREFIX,
      "radius",
      radius,
    )?;
    self.inner.arc_to_tangent(x1, y1, x2, y2, radius);
    Ok(())
  }

  #[napi]
  pub fn ellipse(
    &mut self,
    env: &Env,
    x: Double<webidl::PathEllipse>,
    y: Double<webidl::PathEllipse>,
    radius_x: Double<webidl::PathEllipse>,
    radius_y: Double<webidl::PathEllipse>,
    rotation: Double<webidl::PathEllipse>,
    start_angle: Double<webidl::PathEllipse>,
    end_angle: Double<webidl::PathEllipse>,
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
    let prefix = <webidl::PathEllipse as webidl::Site>::PREFIX;
    check_radius(env.raw(), prefix, "major-axis radius", radius_x)?;
    check_radius(env.raw(), prefix, "minor-axis radius", radius_y)?;
    self.inner.ellipse(
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
  pub fn rect(
    &mut self,
    x: Double<webidl::PathRect>,
    y: Double<webidl::PathRect>,
    width: Double<webidl::PathRect>,
    height: Double<webidl::PathRect>,
  ) {
    if let Some([x, y, width, height]) = num::saturated_f32s([x.0, y.0, width.0, height.0]) {
      self.inner.add_rect(x, y, width, height);
    }
  }

  #[napi]
  pub fn round_rect(
    &mut self,
    env: &Env,
    x: Double<webidl::PathRoundRect>,
    y: Double<webidl::PathRoundRect>,
    width: Double<webidl::PathRoundRect>,
    height: Double<webidl::PathRoundRect>,
    radii: webidl::RoundRectRadii<webidl::PathRoundRect>,
  ) -> Result<()> {
    // A Path2D has no matrix: always invertible.
    if let Some(([x, y, width, height], radii)) = check_round_rect(
      env.raw(),
      <webidl::PathRoundRect as webidl::Site>::PREFIX,
      true,
      [x.0, y.0, width.0, height.0],
      &radii.0,
    )? {
      self.inner.round_rect(x, y, width, height, &radii);
    }
    Ok(())
  }

  #[napi]
  pub fn op(&mut self, other: &Path, op: PathOp) -> &Self {
    self.inner.op(&other.inner, op.into());
    self
  }

  #[napi(js_name = "toSVGString", ts_return_type = "string")]
  pub fn to_svg_string(&self) -> SkiaString {
    self.inner.to_svg_string()
  }

  #[napi]
  pub fn simplify(&mut self) -> &Self {
    self.inner.simplify();
    self
  }

  #[napi]
  pub fn set_fill_type(&mut self, fill_type: FillType) {
    self.inner.set_fill_type(fill_type.into());
  }

  #[napi]
  pub fn get_fill_type(&mut self) -> FillType {
    self.inner.get_fill_type().into()
  }

  #[napi]
  pub fn get_fill_type_string(&mut self) -> String {
    match self.get_fill_type() {
      FillType::EvenOdd => "evenodd".to_owned(),
      _ => "nonzero".to_owned(),
    }
  }

  #[napi]
  pub fn as_winding(&mut self) -> &Self {
    self.inner.as_winding();
    self
  }

  #[napi]
  pub fn stroke(&mut self, options: StrokeOptions) -> &Self {
    self.inner.stroke(
      options.cap.unwrap_or_default().into(),
      options.join.unwrap_or_default().into(),
      options.width.unwrap_or(1.0) as f32,
      options.miter_limit.unwrap_or(4.0) as f32,
    );
    self
  }

  #[napi]
  pub fn compute_tight_bounds(&self) -> Vec<f64> {
    let ltrb = self.inner.compute_tight_bounds();
    vec![ltrb.0 as f64, ltrb.1 as f64, ltrb.2 as f64, ltrb.3 as f64]
  }

  #[napi]
  pub fn get_bounds(&self) -> Vec<f64> {
    let ltrb = self.inner.get_bounds();
    vec![ltrb.0 as f64, ltrb.1 as f64, ltrb.2 as f64, ltrb.3 as f64]
  }

  #[napi]
  pub fn transform(&mut self, matrix: Matrix) -> &Self {
    let trans = SkMatrix::new(
      matrix.a as f32,
      matrix.c as f32,
      matrix.e as f32,
      matrix.b as f32,
      matrix.d as f32,
      matrix.f as f32,
    );
    self.inner.transform_self(&trans);
    self
  }

  #[napi]
  pub fn trim(&mut self, start: f64, end: f64, is_complement: Option<bool>) -> &Self {
    self
      .inner
      .trim(start as f32, end as f32, is_complement.unwrap_or(false));
    self
  }

  #[napi]
  pub fn dash(&mut self, on: f64, off: f64, phase: f64) -> &Self {
    self.inner.dash(on as f32, off as f32, phase as f32);
    self
  }

  #[napi]
  pub fn equals(&self, other: &Path) -> bool {
    self.inner == other.inner
  }

  #[napi]
  pub fn round(&mut self, radius: f64) -> &Self {
    self.inner.round(radius as f32);
    self
  }

  #[napi]
  pub fn is_point_in_path(&self, x: f64, y: f64, fill_type: Option<FillType>) -> bool {
    self.inner.hit_test(
      x as f32,
      y as f32,
      fill_type.unwrap_or(FillType::Winding).into(),
    )
  }
}

/// The argument of new Path2D(): `optional (Path2D or DOMString) path`
/// (path_2d.h:58-68). A Path2D is copied. Anything else goes through
/// ToString and is parsed as SVG path data, keeping the segments before the
/// first error (path_2d.h:109-112): a bad string does not throw.
pub struct PathInit(SkPath);

impl FromNapiValue for PathInit {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    if is_path2d(env, value) {
      let mut data = std::ptr::null_mut();
      check_status!(unsafe { sys::napi_unwrap(env, value, &mut data) })?;
      // SAFETY: is_path2d; only read, before any receiver exists.
      let source = unsafe { &*data.cast::<Path>() };
      return Ok(Self(source.inner.clone()));
    }
    let data = webidl::to_dom_string(env, value, webidl::PATH2D_CONSTRUCTOR)?;
    Ok(Self(crate::svg_path::build_path_from_string(&data)))
  }
}

/// The `path` argument of addPath(): a Path2D, else "parameter 1 is not of
/// type 'Path2D'.", before the matrix is converted. Kept as a pointer: the
/// method reads the path only after the matrix getters ran, and it may be the
/// receiver, which the method borrows mutably.
pub struct AddPathSource(*const Path);

impl FromNapiValue for AddPathSource {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    let prefix = <webidl::PathAddPath as webidl::Site>::PREFIX;
    if !is_path2d(env, value) {
      return Err(not_path2d(env, prefix));
    }
    let mut data = std::ptr::null_mut();
    check_status!(unsafe { sys::napi_unwrap(env, value, &mut data) })?;
    Ok(Self(data.cast()))
  }
}

/// The `transform` argument of addPath(): `optional DOMMatrix2DInit
/// transform = {}`, as [m11, m12, m21, m22, m41, m42].
pub struct AddPathTransform([f64; 6]);

impl FromNapiValue for AddPathTransform {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    let prefix = <webidl::PathAddPath as webidl::Site>::PREFIX;
    webidl::dom_matrix_2d_init(env, Some(value), prefix).map(Self)
  }
}

/// The rect [x, y, width, height] and the (rx, ry) radii roundRect() adds.
pub(crate) type RoundRectArgs = ([f32; 4], Vec<(f32, f32)>);

/// The checks of Blink's CanvasPath::roundRect (canvas_path.cc:565-628), in
/// its order: the radius count (a RangeError), then the matrix (`invertible`),
/// then the rect, then each radius in turn. Ok(None) when nothing is added:
/// a singular matrix, or a value outside the float range, which also ends the
/// checks. Else the rect and the radii as (rx, ry) pairs.
pub(crate) fn check_round_rect(
  env: sys::napi_env,
  prefix: &str,
  invertible: bool,
  rect: [f64; 4],
  radii: &[webidl::Radius],
) -> Result<Option<RoundRectArgs>> {
  if radii.is_empty() || radii.len() > 4 {
    return Err(webidl::context_range_error(
      env,
      prefix,
      &format!(
        "{} radii provided. Between one and four radii are necessary.",
        radii.len()
      ),
    ));
  }
  if !invertible {
    return Ok(None);
  }
  let Some(rect) = num::saturated_f32s(rect) else {
    return Ok(None);
  };
  let negative = |what: &str, value: f32| {
    Err(webidl::context_range_error(
      env,
      prefix,
      &format!(
        "{what} value {} is negative.",
        webidl::number_to_string(f64::from(value))
      ),
    ))
  };
  let mut out = Vec::with_capacity(radii.len());
  for radius in radii {
    match *radius {
      webidl::Radius::Point(x, y) => {
        let Some([x, y]) = num::saturated_f32s([x, y]) else {
          return Ok(None);
        };
        if x < 0.0 {
          return negative("X-radius", x);
        }
        if y < 0.0 {
          return negative("Y-radius", y);
        }
        out.push((x, y));
      }
      webidl::Radius::Number(r) => {
        let Some(r) = num::saturated_f32(r) else {
          return Ok(None);
        };
        if r < 0.0 {
          return negative("Radius", r);
        }
        out.push((r, r));
      }
    }
  }
  Ok(Some((rect, out)))
}

impl ToNapiValue for SkiaString {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut result = std::ptr::null_mut();
    napi::check_status!(
      unsafe { sys::napi_create_string_utf8(env, val.ptr, val.length as isize, &mut result) },
      "Failed to create string from SkiaString"
    )?;
    Ok(result)
  }
}
