use std::convert::TryInto;

use cssparser::{Color as CSSColor, Parser, ParserInput};
use napi::{
  CallContext, Env, Error, JsNumber, JsObject, JsString, JsUndefined, Property, Result, Status,
};

use super::sk::*;

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
  pub(crate) fn shader(self) -> Result<Shader> {
    match self {
      Self::Linear(linear_gradient) => Ok(Shader::new_linear_gradient(&linear_gradient).ok_or(
        Error::from_reason("Create linear gradient failed".to_owned()),
      )?),
      Self::Radial(radial_gradient) => Ok(
        Shader::new_two_point_conical_gradient(&radial_gradient).ok_or(Error::from_reason(
          "Create radial gradient failed".to_owned(),
        ))?,
      ),
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
