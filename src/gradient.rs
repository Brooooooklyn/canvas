use std::result;

use cssparser::{Color as CSSColor, Parser, ParserInput};
use napi::bindgen_prelude::*;

use crate::{
  error::SkError,
  sk::{
    Color, ConicGradient, Gradient as SkGradient, LinearGradient, RadialGradient, Shader, TileMode,
    Transform,
  },
};

#[derive(Debug, Clone)]
pub enum Gradient {
  Linear(LinearGradient),
  Radial(RadialGradient),
  Conic(ConicGradient),
}

impl Gradient {
  pub fn create_linear_gradient(x0: f32, y0: f32, x1: f32, y1: f32) -> Self {
    let linear_gradient = LinearGradient {
      start_point: (x0, y0),
      end_point: (x1, y1),
      base: SkGradient {
        colors: Vec::new(),
        positions: Vec::new(),
        tile_mode: TileMode::Clamp,
        transform: Transform::default(),
      },
    };
    Self::Linear(linear_gradient)
  }

  pub fn create_radial_gradient(x0: f32, y0: f32, r0: f32, x1: f32, y1: f32, r1: f32) -> Self {
    let radial_gradient = RadialGradient {
      start: (x0, y0),
      start_radius: r0,
      end: (x1, y1),
      end_radius: r1,
      base: SkGradient {
        colors: Vec::new(),
        positions: Vec::new(),
        tile_mode: TileMode::Clamp,
        transform: Transform::default(),
      },
    };
    Self::Radial(radial_gradient)
  }

  pub fn create_conic_gradient(x: f32, y: f32, r: f32) -> Self {
    Self::Conic(ConicGradient {
      center: (x, y),
      radius: r,
      base: SkGradient {
        colors: Vec::new(),
        positions: Vec::new(),
        tile_mode: TileMode::Clamp,
        transform: Transform::default(),
      },
    })
  }

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
      Self::Conic(conic_gradient) => (
        &mut conic_gradient.base.positions,
        &mut conic_gradient.base.colors,
      ),
    };
    if stops.last().map(|l| l < &offset).unwrap_or(true) {
      stops.push(offset);
      colors.push(color);
    } else {
      let mut index = 0usize;
      // insert it in sorted order
      for (idx, val) in stops.iter().enumerate() {
        if val >= &offset {
          break;
        } else {
          index = idx + 1;
        }
      }
      stops.insert(index, offset);
      colors.insert(index, color);
    }
  }

  /// Transform is [3 x 3] matrix, but stored in 2d array:
  /// | A B C |
  /// | D E F |
  /// | 0 0 1 |
  /// [0 -> A, 1 -> B, 2 -> C, 3 -> D, 4 -> E, 5 -> F, 6 -> 0, 7 -> 0, 8 -> 1 ]
  /// [lineargradient.js](skia/modules/canvaskit/htmlcanvas/lineargradient.js)
  /// [radialgradient.js](skia/modules/canvaskit/htmlcanvas/radialgradient.js)
  pub(crate) fn get_shader(&self, current_transform: Transform) -> result::Result<Shader, SkError> {
    match self {
      Self::Linear(ref linear_gradient) => Ok(
        Shader::new_linear_gradient(&LinearGradient {
          start_point: linear_gradient.start_point,
          end_point: linear_gradient.end_point,
          base: linear_gradient.base.clone(),
        })
        .ok_or_else(|| SkError::Generic("Get shader of linear gradient failed".to_owned()))?,
      ),
      // Note, Skia has a different notion of a "radial" gradient.
      // Skia has a twoPointConical gradient that is the same as the
      // canvas's RadialGradient.
      Self::Radial(ref radial_gradient) => {
        // From the spec: "The points in the linear gradient must be transformed
        // as described by the current transformation matrix when rendering."
        let base = radial_gradient.base.clone();
        let new_radial_gradient = RadialGradient {
          start: radial_gradient.start,
          end: radial_gradient.end,
          start_radius: radial_gradient.start_radius,
          end_radius: radial_gradient.end_radius,
          base,
        };

        Ok(
          Shader::new_radial_gradient(&new_radial_gradient)
            .ok_or_else(|| SkError::Generic("Get shader of radial gradient failed".to_owned()))?,
        )
      }
      Self::Conic(ref conic_gradient) => {
        let (x, y) = conic_gradient.center;
        let r = conic_gradient.radius;
        let sx = current_transform.c;
        let sy = current_transform.b;
        let scale_factor = (f32::abs(sx) + f32::abs(sy)) / 2f32;
        let sr = r * scale_factor;
        let new_conic_gradient = ConicGradient {
          center: (x, y),
          radius: sr,
          base: conic_gradient.base.clone(),
        };

        Ok(
          Shader::new_conic_gradient(&new_conic_gradient)
            .ok_or_else(|| SkError::Generic("Get shader of radial gradient failed".to_owned()))?,
        )
      }
    }
  }
}

#[napi]
pub struct CanvasGradient(pub(crate) Gradient);

#[napi]
impl CanvasGradient {
  #[napi]
  pub fn add_color_stop(&mut self, index: f64, color: String) -> Result<()> {
    if color.is_empty() {
      return Ok(());
    }
    let color_str = color.as_str();
    let mut parser_input = ParserInput::new(color_str);
    let mut parser = Parser::new(&mut parser_input);
    let color = CSSColor::parse(&mut parser).map_err(|e| {
      Error::new(
        Status::InvalidArg,
        format!("Parse color [{color_str}] error: {e:?}"),
      )
    })?;
    let skia_color = match color {
      CSSColor::CurrentColor => {
        return Err(Error::new(
          Status::InvalidArg,
          "Gradient stop color should not be `currentcolor` keyword".to_owned(),
        ))
      }
      CSSColor::RGBA(rgba) => Color::from_rgba(rgba.red, rgba.green, rgba.blue, rgba.alpha),
    };
    self.0.add_color_stop(index as f32, skia_color);
    Ok(())
  }
}

#[test]
fn test_add_color_stop() {
  let mut linear_gradient = Gradient::create_linear_gradient(0.0, 0.0, 0.0, 77.0);
  linear_gradient.add_color_stop(1.0, Color::from_rgba(0, 128, 128, 255));
  linear_gradient.add_color_stop(0.6, Color::from_rgba(0, 255, 255, 255));
  linear_gradient.add_color_stop(0.3, Color::from_rgba(176, 199, 45, 255));
  linear_gradient.add_color_stop(0.0, Color::from_rgba(204, 82, 50, 255));
  if let Gradient::Linear(linear_gradient) = linear_gradient {
    assert_eq!(linear_gradient.base.positions, vec![0.0, 0.3, 0.6, 1.0]);
    assert_eq!(
      linear_gradient.base.colors,
      vec![
        Color::from_rgba(204, 82, 50, 255),
        Color::from_rgba(176, 199, 45, 255),
        Color::from_rgba(0, 255, 255, 255),
        Color::from_rgba(0, 128, 128, 255),
      ]
    );
  } else {
    unreachable!();
  }
}
