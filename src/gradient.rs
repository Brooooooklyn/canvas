use std::convert::TryInto;
use std::result;

use cssparser::{Color as CSSColor, Parser, ParserInput};
use napi::{
  CallContext, Env, Error, JsNumber, JsObject, JsString, JsUndefined, Property, Result, Status,
};

use crate::pattern::Pattern;
use crate::{error::SkError, sk::*};

#[derive(Debug, Clone)]
pub enum CanvasGradient {
  Linear(LinearGradient),
  Radial(TwoPointConicalGradient),
}

impl CanvasGradient {
  #[inline(always)]
  pub fn into_js_instance(self, env: &Env) -> Result<JsObject> {
    let gradient_class = env.define_class(
      "Gradient",
      gradient_constructor,
      &[Property::new(env, "addColorStop")?.with_method(add_color_stop)],
    )?;
    let arguments: Vec<JsUndefined> = vec![];
    let mut instance = gradient_class.new(&arguments)?;
    env.wrap(&mut instance, Pattern::Gradient(self))?;
    Ok(instance)
  }

  #[inline(always)]
  pub fn create_linear_gradient(x0: f32, y0: f32, x1: f32, y1: f32) -> Self {
    let linear_gradient = LinearGradient {
      start_point: (x0, y0),
      end_point: (x1, y1),
      base: Gradient {
        colors: Vec::with_capacity(0),
        positions: Vec::with_capacity(0),
        tile_mode: TileMode::Clamp,
        transform: Transform::default(),
      },
    };
    Self::Linear(linear_gradient)
  }

  #[inline(always)]
  pub fn create_radial_gradient(x0: f32, y0: f32, r0: f32, x1: f32, y1: f32, r1: f32) -> Self {
    let radial_gradient = TwoPointConicalGradient {
      start: (x0, y0),
      start_radius: r0,
      end: (x1, y1),
      end_radius: r1,
      base: Gradient {
        colors: Vec::with_capacity(0),
        positions: Vec::with_capacity(0),
        tile_mode: TileMode::Clamp,
        transform: Transform::default(),
      },
    };
    Self::Radial(radial_gradient)
  }

  #[inline(always)]
  pub fn add_color_stop(&mut self, offset: f32, color: Color) {
    let (stops, colors) = match self {
      Self::Linear(linear_gradient) => (
        &mut linear_gradient.base.positions,
        &mut linear_gradient.base.colors,
      ),
      Self::Radial(radial_gradient) => (
        &mut radial_gradient.base.positions,
        &mut radial_gradient.base.colors,
      ),
    };
    if let Ok(pos) = stops.binary_search_by(|o| o.partial_cmp(&offset).unwrap()) {
      colors[pos] = color;
    } else if stops.is_empty() {
      stops.push(offset);
      colors.push(color);
    } else {
      let mut index = 0usize;
      // insert it in sorted order
      for (idx, val) in stops.iter().enumerate() {
        index = idx;
        if val > &offset {
          break;
        }
      }
      stops.insert(index + 1, offset);
      colors.insert(index + 1, color);
    }
  }

  #[inline(always)]
  /// Transform is [3 x 3] matrix, but stored in 2d array:
  /// | A B C |
  /// | D E F |
  /// | 0 0 1 |
  /// [0 -> A, 1 -> B, 2 -> C, 3 -> D, 4 -> E, 5 -> F, 6 -> 0, 7 -> 0, 8 -> 1 ]
  /// [lineargradient.js](skia/modules/canvaskit/htmlcanvas/lineargradient.js)
  /// [radialgradient.js](skia/modules/canvaskit/htmlcanvas/radialgradient.js)
  pub(crate) fn get_shader(
    &self,
    current_transform: &Transform,
  ) -> result::Result<Shader, SkError> {
    match self {
      Self::Linear(ref linear_gradient) => {
        let (x1, y1) = linear_gradient.start_point;
        let (x2, y2) = linear_gradient.end_point;
        let mut pt_arr: [f32; 4] = [x1, y1, x2, y2];
        current_transform.map_points(&mut pt_arr);
        let sx1 = pt_arr[0];
        let sy1 = pt_arr[1];
        let sx2 = pt_arr[2];
        let sy2 = pt_arr[3];
        Ok(
          Shader::new_linear_gradient(&LinearGradient {
            start_point: (sx1, sy1),
            end_point: (sx2, sy2),
            base: linear_gradient.base.clone(),
          })
          .ok_or_else(|| SkError::Generic("Get shader of linear gradient failed".to_owned()))?,
        )
      }
      Self::Radial(ref radial_gradient) => {
        let (x1, y1) = radial_gradient.start;
        let (x2, y2) = radial_gradient.end;
        let r1 = radial_gradient.start_radius;
        let r2 = radial_gradient.end_radius;
        let mut pt_arr: [f32; 4] = [x1, y1, x2, y2];
        current_transform.map_points(&mut pt_arr);
        let sx1 = pt_arr[0];
        let sy1 = pt_arr[1];
        let sx2 = pt_arr[2];
        let sy2 = pt_arr[3];

        let sx = current_transform.a;
        let sy = current_transform.d;
        let scale_factor = (f32::abs(sx) + f32::abs(sy)) / 2f32;

        let sr1 = r1 * scale_factor;
        let sr2 = r2 * scale_factor;

        let new_radial_gradient = TwoPointConicalGradient {
          start: (sx1, sy1),
          end: (sx2, sy2),
          start_radius: sr1,
          end_radius: sr2,
          base: radial_gradient.base.clone(),
        };

        Ok(
          Shader::new_two_point_conical_gradient(&new_radial_gradient)
            .ok_or_else(|| SkError::Generic("Get shader of radial gradient failed".to_owned()))?,
        )
      }
    }
  }
}

#[js_function(1)]
fn gradient_constructor(ctx: CallContext) -> Result<JsUndefined> {
  ctx.env.get_undefined()
}

#[js_function(2)]
fn add_color_stop(ctx: CallContext) -> Result<JsUndefined> {
  let this = ctx.this_unchecked::<JsObject>();
  let canvas_gradient = ctx.env.unwrap::<Pattern>(&this)?;
  let index: f64 = ctx.get::<JsNumber>(0)?.try_into()?;
  let color_str = ctx.get::<JsString>(1)?.into_utf8()?;
  let mut parser_input = ParserInput::new(color_str.as_str()?);
  let mut parser = Parser::new(&mut parser_input);
  let color = CSSColor::parse(&mut parser)
    .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid color {:?}", e)))?;
  let skia_color = match color {
    CSSColor::CurrentColor => {
      return Err(Error::new(
        Status::InvalidArg,
        "Gradient stop color should not be `currentcolor` keyword".to_owned(),
      ))
    }
    CSSColor::RGBA(rgba) => Color::from_rgba(rgba.red, rgba.green, rgba.blue, rgba.alpha),
  };
  if let Pattern::Gradient(canvas_gradient) = canvas_gradient {
    canvas_gradient.add_color_stop(index as f32, skia_color);
  }
  ctx.env.get_undefined()
}
