use napi::bindgen_prelude::*;

use crate::num;
use crate::sk::{
  FillType as SkFillType, Matrix as SkMatrix, Path as SkPath, PathOp as SkPathOp, SkiaString,
  StrokeCap as SkStrokeCap, StrokeJoin as SkStrokeJoin,
};

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
  pub fn new(path: Option<Either3<String, &mut Path, Unknown>>) -> Result<Self> {
    let inner = match &path {
      Some(Either3::A(path)) => SkPath::from_svg_path(path).ok_or_else(|| {
        Error::new(
          Status::InvalidArg,
          "Create path from provided path string failed.".to_owned(),
        )
      })?,
      Some(Either3::B(path)) => path.inner.clone(),
      Some(Either3::C(c)) => {
        return Err(Error::new(
          Status::InvalidArg,
          format!(
            "Create path from provided unknown value failed {}.",
            c.get_type()?
          ),
        ));
      }
      None => SkPath::new(),
    };
    Ok(Path { inner })
  }

  #[napi]
  pub fn add_path(&mut self, sub_path: &Path, matrix: Option<Matrix>) {
    let transform = match matrix {
      // A non-finite matrix adds nothing (Blink path_2d.h addPath).
      Some(m) if ![m.a, m.b, m.c, m.d, m.e, m.f].iter().all(|v| v.is_finite()) => return,
      Some(m) => SkMatrix::new(
        m.a as f32, m.c as f32, m.e as f32, m.b as f32, m.d as f32, m.f as f32,
      ),
      None => SkMatrix::identity(),
    };
    self.inner.add_path(&sub_path.inner, &transform);
  }

  #[napi]
  pub fn close_path(&mut self) {
    self.inner.close();
  }

  // Path methods drop a call with a value outside the float range, as the
  // context does (Blink canvas_path.cc: saturated_cast<float>, then isfinite).

  #[napi]
  pub fn move_to(&mut self, x: f64, y: f64) {
    if let Some([x, y]) = num::saturated_f32s([x, y]) {
      self.inner.move_to(x, y);
    }
  }

  #[napi]
  pub fn line_to(&mut self, x: f64, y: f64) {
    if let Some([x, y]) = num::saturated_f32s([x, y]) {
      self.inner.line_to(x, y);
    }
  }

  #[napi]
  pub fn bezier_curve_to(&mut self, cp1x: f64, cp1y: f64, cp2x: f64, cp2y: f64, x: f64, y: f64) {
    if let Some([cp1x, cp1y, cp2x, cp2y, x, y]) =
      num::saturated_f32s([cp1x, cp1y, cp2x, cp2y, x, y])
    {
      self.inner.cubic_to(cp1x, cp1y, cp2x, cp2y, x, y);
    }
  }

  #[napi]
  pub fn quadratic_curve_to(&mut self, cpx: f64, cpy: f64, x: f64, y: f64) {
    if let Some([cpx, cpy, x, y]) = num::saturated_f32s([cpx, cpy, x, y]) {
      self.inner.quad_to(cpx, cpy, x, y);
    }
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
    if let Some([x, y, radius, start_angle, end_angle]) =
      num::saturated_f32s([x, y, radius, start_angle, end_angle])
    {
      self.inner.arc(
        x,
        y,
        radius,
        start_angle,
        end_angle,
        anticlockwise.unwrap_or(false),
      );
    }
  }

  #[napi]
  pub fn arc_to(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, radius: f64) {
    if let Some([x1, y1, x2, y2, radius]) = num::saturated_f32s([x1, y1, x2, y2, radius]) {
      self.inner.arc_to_tangent(x1, y1, x2, y2, radius);
    }
  }

  #[napi]
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
    if let Some([x, y, radius_x, radius_y, rotation, start_angle, end_angle]) =
      num::saturated_f32s([x, y, radius_x, radius_y, rotation, start_angle, end_angle])
    {
      self.inner.ellipse(
        x,
        y,
        radius_x,
        radius_y,
        rotation,
        start_angle,
        end_angle,
        anticlockwise.unwrap_or(false),
      );
    }
  }

  #[napi]
  pub fn rect(&mut self, x: f64, y: f64, width: f64, height: f64) {
    if let Some([x, y, width, height]) = num::saturated_f32s([x, y, width, height]) {
      self.inner.add_rect(x, y, width, height);
    }
  }

  #[napi]
  pub fn round_rect(
    &mut self,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    radii: Either3<f64, Vec<f64>, Undefined>,
  ) {
    if let (Some([x, y, width, height]), Some(radii)) = (
      num::saturated_f32s([x, y, width, height]),
      round_rect_radii(radii),
    ) {
      self.inner.round_rect(x, y, width, height, radii);
    }
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

/// The four corner radii of roundRect(). Each given radius goes through the
/// path rule in the order given (Blink canvas_path.cc:597-628): None when one
/// is outside the float range. Then the 1 to 4 radii expand to the corners.
pub(crate) fn round_rect_radii(radii: Either3<f64, Vec<f64>, Undefined>) -> Option<[f32; 4]> {
  let mut r = [0f32; 4];
  let count = match radii {
    Either3::A(radius) => {
      r[0] = num::saturated_f32(radius)?;
      1
    }
    Either3::B(list) => {
      for (slot, radius) in r.iter_mut().zip(&list) {
        *slot = num::saturated_f32(*radius)?;
      }
      list.len()
    }
    Either3::C(_) => 0,
  };
  Some(match count {
    0 => [0.0; 4],
    1 => [r[0]; 4],
    2 => [r[0], r[1], r[0], r[1]],
    3 => [r[0], r[1], r[1], r[2]],
    _ => r,
  })
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
