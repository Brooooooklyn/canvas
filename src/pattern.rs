use cssparser::{Color as CSSColor, Parser, ParserInput, RGBA};

use crate::error::SkError;
use crate::gradient::CanvasGradient;
use crate::sk::ImagePattern;

#[derive(Debug, Clone)]
pub enum Pattern {
  Color(RGBA, String),
  Gradient(CanvasGradient),
  Image(ImagePattern),
}

impl Default for Pattern {
  fn default() -> Self {
    Self::Color(RGBA::new(0, 0, 0, 255), "#000".to_owned())
  }
}

impl Pattern {
  pub fn from_color(color_str: &str) -> Result<Self, SkError> {
    let mut parser_input = ParserInput::new(color_str);
    let mut parser = Parser::new(&mut parser_input);
    let color = CSSColor::parse(&mut parser)
      .map_err(|e| SkError::Generic(format!("Parse color [{}] error: {:?}", color_str, e)))?;
    match color {
      CSSColor::CurrentColor => Err(SkError::Generic(
        "Color should not be `currentcolor` keyword".to_owned(),
      )),
      CSSColor::RGBA(rgba) => Ok(Pattern::Color(rgba, color_str.to_owned())),
    }
  }
}
