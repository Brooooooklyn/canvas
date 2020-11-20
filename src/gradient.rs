use std::convert::TryInto;
use std::result;

use cssparser::{Color as CSSColor, Parser, ParserInput};
use napi::{
  CallContext, Env, Error, JsNumber, JsObject, JsString, JsUndefined, Property, Result, Status,
};

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
      &vec![Property::new(env, "addColorStop")?.with_method(add_color_stop)],
    )?;
    let arguments: Vec<JsUndefined> = vec![];
    let mut instance = gradient_class.new(&arguments)?;
    env.wrap(&mut instance, self)?;
    Ok(instance)
  }

  #[inline(always)]
  pub fn create_linear_gradient(x0: f32, y0: f32, x1: f32, y1: f32) -> Self {
    let linear_gradient = LinearGradient {
      start_point: (x0, y0),
      end_point: (x1, y1),
      base: Gradient {
        colors: vec![],
        positions: vec![],
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
        colors: vec![],
        positions: vec![],
        tile_mode: TileMode::Clamp,
        transform: Transform::default(),
      },
    };
    Self::Radial(radial_gradient)
  }

  #[inline(always)]
  pub fn add_color_stop(&mut self, index: f32, color: Color) {
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
    stops.push(index);
    colors.push(color);
  }

  #[inline(always)]
  pub(crate) fn get_shader(
    &self,
    current_transform: &Transform,
  ) -> result::Result<Shader, SkError> {
    match self {
      Self::Linear(ref linear_gradient) => {
        let (x1, y1) = linear_gradient.start_point;
        let (x2, y2) = linear_gradient.end_point;
        let pt_arr: [f32; 4] = [x1, y1, x2, y2];
        let pts = current_transform.map_points(&pt_arr);
        let sx1 = pts[0];
        let sy1 = pts[1];
        let sx2 = pts[2];
        let sy2 = pts[3];
        Ok(
          Shader::new_linear_gradient(&LinearGradient {
            start_point: (sx1, sy1),
            end_point: (sx2, sy2),
            base: linear_gradient.base.clone(),
          })
          .ok_or(SkError::Generic("Create linear gradient failed".to_owned()))?,
        )
      }
      Self::Radial(ref radial_gradient) => {
        let (x1, y1) = radial_gradient.start;
        let (x2, y2) = radial_gradient.end;
        let (r1, r2) = radial_gradient.start;
        let pt_arr: [f32; 4] = [x1, y1, x2, y2];
        let pts = current_transform.map_points(&pt_arr);
        let sx1 = pts[0];
        let sy1 = pts[1];
        let sx2 = pts[2];
        let sy2 = pts[3];

        let sx = current_transform.a;
        let sy = current_transform.e;
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
            .ok_or(SkError::Generic("Create radial gradient failed".to_owned()))?,
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
  let canvas_gradient = ctx.env.unwrap::<CanvasGradient>(&this)?;
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
  canvas_gradient.add_color_stop(index as f32, skia_color);
  ctx.env.get_undefined()
}
