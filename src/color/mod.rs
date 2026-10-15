//! Canvas colors as Chrome 155 reads, keeps and paints them: Blink's color
//! model (platform/graphics/color.cc), its CSS `<color>` parser and resolver,
//! the canvas color string rules (canvas_style.cc) and the getter
//! serialization (Color::SerializeAsCanvasColor).

mod convert;
mod fast_path;
mod model;
mod names;
mod parse;
mod serialize;

pub(crate) use model::{Color, ColorSpace};
pub(crate) use parse::{Site, parse_canvas_color, parse_filter_color};

/// The interface the canvas styles used before they kept a `Color`; it goes
/// away when they paint float colors.
pub(crate) struct CanvasColor(Color);

impl CanvasColor {
  pub(crate) fn parse(source: &str) -> Result<Self, crate::error::SkError> {
    parse_canvas_color(source, Site::Style)
      .map(Self)
      .ok_or_else(|| crate::error::SkError::Generic(format!("Invalid canvas color [{source}]")))
  }

  pub(crate) fn to_rgba8(&self) -> rgb::RGBA<u8> {
    let argb = self.0.rgb();
    rgb::RGBA::new(
      (argb >> 16) as u8,
      (argb >> 8) as u8,
      argb as u8,
      (argb >> 24) as u8,
    )
  }

  pub(crate) fn serialize(&self) -> String {
    self.0.serialize_as_canvas_color()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn serialized(s: &str) -> Option<String> {
    parse_canvas_color(s, Site::Style).map(|c| c.serialize_as_canvas_color())
  }

  /// Chrome 155: `rgba(10, 20, 30, k / 255)` with the alpha written as JS
  /// prints k / 255.
  #[test]
  fn serialize_alpha_edges_match_chrome() {
    for (alpha, expected) in [
      ("0", "rgba(10, 20, 30, 0)"),
      ("0.00392156862745098", "rgba(10, 20, 30, 0.004)"),
      ("0.00784313725490196", "rgba(10, 20, 30, 0.008)"),
      ("0.25098039215686274", "rgba(10, 20, 30, 0.25)"),
      ("0.4980392156862745", "rgba(10, 20, 30, 0.498)"),
      ("0.5019607843137255", "rgba(10, 20, 30, 0.5)"),
      ("0.5333333333333333", "rgba(10, 20, 30, 0.533)"),
      ("0.996078431372549", "rgba(10, 20, 30, 0.996)"),
      ("1", "#0a141e"),
    ] {
      assert_eq!(
        serialized(&format!("rgba(10, 20, 30, {alpha})")).as_deref(),
        Some(expected),
        "{alpha}"
      );
    }
  }

  /// Chrome 155: the full parser keeps a modern rgb() alpha as a float; a
  /// comma in a comment does not make the syntax legacy.
  #[test]
  fn legacy_syntax_is_read_from_tokens() {
    for (s, expected) in [
      ("rgb(1 2 3 / 0.999)", "#010203"),
      ("rgb( 1 2 3 / 0.999 )", "rgba(1, 2, 3, 1)"),
      ("rgba(1,2,3,0.999 )", "#010203"),
      ("rgb(1 2 3 / 0.999)/*,*/", "rgba(1, 2, 3, 1)"),
      ("rgb(1 2 3 / /*,*/ 0.999)", "rgba(1, 2, 3, 1)"),
      ("rgb(1/*,*/2 3 / 0.999)", "rgba(1, 2, 3, 1)"),
    ] {
      assert_eq!(serialized(s).as_deref(), Some(expected), "{s:?}");
    }
  }

  #[test]
  fn keywords_must_be_the_whole_string() {
    assert_eq!(serialized("currentColor").as_deref(), Some("#000000"));
    assert_eq!(serialized(" hotpink\n").as_deref(), Some("#ff69b4"));
    for s in [
      "red/**/",
      "/**/red",
      "re\\64",
      "currentcolor x",
      "red blue",
      "\u{b}red",
    ] {
      assert_eq!(serialized(s), None, "{s:?}");
    }
  }

  #[test]
  fn none_alpha_paints_transparent() {
    let c = parse_canvas_color("hsl(0 50% 50% / none)", Site::Style).unwrap();
    assert_eq!(c.to_sk_color4f().to_sk_color() >> 24, 0);
    assert_eq!(c.serialize_as_canvas_color(), "rgba(191, 64, 64, 0)");
  }
}
