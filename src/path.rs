use napi::{bindgen_prelude::*, JsString};

use crate::sk::{
  FillType as SkFillType, Matrix as SkMatrix, Path as SkPath, PathOp as SkPathOp,
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
pub enum StrokeCap {
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

impl Default for StrokeCap {
  fn default() -> Self {
    StrokeCap::Butt
  }
}

#[napi]
pub enum StrokeJoin {
  Miter = 0,
  Round = 1,
  Bevel = 2,
}

impl Default for StrokeJoin {
  fn default() -> Self {
    StrokeJoin::Miter
  }
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
    let transform = matrix
      .map(|m| {
        SkMatrix::new(
          m.a as f32, m.c as f32, m.e as f32, m.b as f32, m.d as f32, m.f as f32,
        )
      })
      .unwrap_or_else(SkMatrix::identity);
    self.inner.add_path(&sub_path.inner, &transform);
  }

  #[napi]
  pub fn close_path(&mut self) {
    self.inner.close();
  }

  #[napi]
  pub fn move_to(&mut self, x: f64, y: f64) {
    self.inner.move_to(x as f32, y as f32);
  }

  #[napi]
  pub fn line_to(&mut self, x: f64, y: f64) {
    self.inner.line_to(x as f32, y as f32);
  }

  #[napi]
  pub fn bezier_curve_to(&mut self, cp1x: f64, cp1y: f64, cp2x: f64, cp2y: f64, x: f64, y: f64) {
    self.inner.cubic_to(
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
      .inner
      .quad_to(cpx as f32, cpy as f32, x as f32, y as f32);
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
    self.inner.arc(
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
      .inner
      .arc_to_tangent(x1 as f32, y1 as f32, x2 as f32, y2 as f32, radius as f32);
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
    self.inner.ellipse(
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

  #[napi]
  pub fn rect(&mut self, x: f64, y: f64, width: f64, height: f64) {
    self
      .inner
      .add_rect(x as f32, y as f32, width as f32, height as f32);
  }

  #[napi]
  pub fn op(&mut self, other: &Path, op: PathOp) -> &Self {
    self.inner.op(&other.inner, op.into());
    self
  }

  #[napi(js_name = "toSVGString")]
  pub fn to_svg_string(&self, env: Env) -> Result<JsString> {
    let sk_string = self.inner.to_svg_string();
    unsafe { env.create_string_from_c_char(sk_string.ptr, sk_string.length) }
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
}
