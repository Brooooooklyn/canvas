//! The properties an SVG image cascades: whether each inherits, its
//! initial value, which elements take it as a presentation attribute, and
//! its parser.

use std::rc::Rc;

use cssparser::Parser;

use super::values::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Mode {
  Css,
  /// A presentation attribute: unitless lengths are px (Blink's
  /// kSVGAttributeMode).
  Attr,
}

macro_rules! props {
  ($($id:ident = $name:literal, $inherited:literal, $on:expr;)*) => {
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    #[repr(u8)]
    pub(crate) enum Prop { $($id),* }

    pub(crate) const ALL: &[Prop] = &[$(Prop::$id),*];

    impl Prop {
      pub(crate) fn name(self) -> &'static str {
        match self { $(Prop::$id => $name),* }
      }

      pub(crate) fn inherited(self) -> bool {
        match self { $(Prop::$id => $inherited),* }
      }

      /// The elements whose attribute of this name is a presentation
      /// attribute; empty for every SVG element.
      fn attr_on(self) -> &'static [&'static str] {
        match self { $(Prop::$id => $on),* }
      }

      pub(crate) fn from_name(name: &str) -> Option<Prop> {
        match name { $($name => Some(Prop::$id),)* _ => None }
      }
    }
  };
}

const ALL_ELEMENTS: &[&str] = &[];
const XYWH: &[&str] = &["rect", "image", "svg", "foreignObject", "symbol"];

props! {
  Color = "color", true, ALL_ELEMENTS;
  Fill = "fill", true, ALL_ELEMENTS;
  FillOpacity = "fill-opacity", true, ALL_ELEMENTS;
  FillRule = "fill-rule", true, ALL_ELEMENTS;
  ClipRule = "clip-rule", true, ALL_ELEMENTS;
  Stroke = "stroke", true, ALL_ELEMENTS;
  StrokeOpacity = "stroke-opacity", true, ALL_ELEMENTS;
  StrokeWidth = "stroke-width", true, ALL_ELEMENTS;
  StrokeDasharray = "stroke-dasharray", true, ALL_ELEMENTS;
  StrokeDashoffset = "stroke-dashoffset", true, ALL_ELEMENTS;
  StrokeLinecap = "stroke-linecap", true, ALL_ELEMENTS;
  StrokeLinejoin = "stroke-linejoin", true, ALL_ELEMENTS;
  StrokeMiterlimit = "stroke-miterlimit", true, ALL_ELEMENTS;
  FontFamily = "font-family", true, ALL_ELEMENTS;
  FontSize = "font-size", true, ALL_ELEMENTS;
  FontWeight = "font-weight", true, ALL_ELEMENTS;
  FontStyle = "font-style", true, ALL_ELEMENTS;
  TextAnchor = "text-anchor", true, ALL_ELEMENTS;
  Visibility = "visibility", true, ALL_ELEMENTS;
  PaintOrder = "paint-order", true, ALL_ELEMENTS;
  ImageRendering = "image-rendering", true, ALL_ELEMENTS;
  ColorInterpolation = "color-interpolation", true, ALL_ELEMENTS;
  ColorInterpolationFilters = "color-interpolation-filters", true, ALL_ELEMENTS;
  Display = "display", false, ALL_ELEMENTS;
  Opacity = "opacity", false, ALL_ELEMENTS;
  ClipPath = "clip-path", false, ALL_ELEMENTS;
  Mask = "mask", false, ALL_ELEMENTS;
  Filter = "filter", false, ALL_ELEMENTS;
  StopColor = "stop-color", false, ALL_ELEMENTS;
  StopOpacity = "stop-opacity", false, ALL_ELEMENTS;
  FloodColor = "flood-color", false, ALL_ELEMENTS;
  FloodOpacity = "flood-opacity", false, ALL_ELEMENTS;
  LightingColor = "lighting-color", false, ALL_ELEMENTS;
  Transform = "transform", false, ALL_ELEMENTS;
  TransformOrigin = "transform-origin", false, ALL_ELEMENTS;
  TransformBox = "transform-box", false, ALL_ELEMENTS;
  MaskType = "mask-type", false, ALL_ELEMENTS;
  Overflow = "overflow", false, ALL_ELEMENTS;
  X = "x", false, XYWH;
  Y = "y", false, XYWH;
  Width = "width", false, XYWH;
  Height = "height", false, XYWH;
  Cx = "cx", false, &["circle", "ellipse"];
  Cy = "cy", false, &["circle", "ellipse"];
  R = "r", false, &["circle"];
  Rx = "rx", false, &["rect", "ellipse"];
  Ry = "ry", false, &["rect", "ellipse"];
  D = "d", false, &["path"];
}

pub(crate) const COUNT: usize = ALL.len();

impl Prop {
  /// Whether `attr` on an `element` is this property's presentation
  /// attribute (`transform` is handled by the caller: its attribute syntax
  /// is SVG's).
  pub(crate) fn is_presentation_attr_of(self, element: &str) -> bool {
    let on = self.attr_on();
    on.is_empty() || on.contains(&element)
  }

  pub(crate) fn initial(self) -> Value {
    use Prop::*;
    match self {
      Color | StopColor | FloodColor => Value::Color(ColorValue::Rgba(Rgba::BLACK)),
      LightingColor => Value::Color(ColorValue::Rgba(Rgba {
        rgb: [255, 255, 255],
        a: 1.0,
      })),
      Fill => Value::Paint(Paint::Color(ColorValue::Rgba(Rgba::BLACK))),
      Stroke => Value::Paint(Paint::None),
      FillOpacity | StrokeOpacity | Opacity | StopOpacity | FloodOpacity => Value::Number(1.0),
      FillRule | ClipRule => Value::Keyword("nonzero"),
      StrokeWidth => Value::Len(Len::px(1.0)),
      StrokeDasharray => Value::Dashes(None),
      StrokeDashoffset => Value::Len(Len::default()),
      StrokeLinecap => Value::Keyword("butt"),
      StrokeLinejoin => Value::Keyword("miter"),
      StrokeMiterlimit => Value::Number(4.0),
      // The UA default family: the standard font.
      FontFamily => Value::Families(Rc::from(Vec::new())),
      FontSize => Value::Len(Len::px(ROOT_FONT_SIZE)),
      FontWeight => Value::Number(400.0),
      FontStyle => Value::Keyword("normal"),
      TextAnchor => Value::Keyword("start"),
      Visibility => Value::Keyword("visible"),
      PaintOrder => Value::Keyword("normal"),
      MaskType => Value::Keyword("luminance"),
      ImageRendering => Value::Keyword("auto"),
      ColorInterpolation => Value::Keyword("srgb"),
      ColorInterpolationFilters => Value::Keyword("linearrgb"),
      Display => Value::Keyword("inline"),
      ClipPath | Mask | Filter => Value::Url(None),
      Transform => Value::Transform(None),
      TransformOrigin => Value::Origin(Len::default(), Len::default()),
      TransformBox => Value::Keyword("view-box"),
      Overflow => Value::Keyword("visible"),
      X | Y | Cx | Cy | R => Value::Len(Len::default()),
      Width | Height | Rx | Ry => Value::Auto,
      D => Value::Path(None),
    }
  }
}

/// The keyword of `allowed` the next identifier names (ASCII
/// case-insensitive).
fn keyword(p: &mut Parser, allowed: &[&'static str]) -> Option<Value> {
  let ident = p.expect_ident().ok()?;
  allowed
    .iter()
    .find(|k| ident.eq_ignore_ascii_case(k))
    .map(|k| Value::Keyword(k))
}

fn url_or_none(p: &mut Parser) -> Option<Value> {
  if p.try_parse(|i| i.expect_ident_matching("none")).is_ok() {
    return Some(Value::Url(None));
  }
  parse_url(p).map(|u| Value::Url(Some(u.into())))
}

fn opacity(p: &mut Parser) -> Option<Value> {
  parse_number_or_percentage(p).map(|v| Value::Number(v.clamp(0.0, 1.0)))
}

fn non_negative(l: Len) -> Option<Len> {
  (l.px >= 0.0 && l.pct >= 0.0).then_some(l)
}

/// One `transform-origin` component: (x, y), either may be unset.
fn origin_part(p: &mut Parser, ctx: &LenCtx) -> Option<(Option<Len>, Option<Len>)> {
  let pct = |v| Len { px: 0.0, pct: v };
  if let Ok(ident) = p.try_parse(|i| i.expect_ident_cloned()) {
    return match ident.to_ascii_lowercase().as_str() {
      "left" => Some((Some(pct(0.0)), None)),
      "right" => Some((Some(pct(100.0)), None)),
      "top" => Some((None, Some(pct(0.0)))),
      "bottom" => Some((None, Some(pct(100.0)))),
      "center" => Some((None, None)),
      _ => None,
    };
  }
  parse_len(p, ctx, false).map(|l| (Some(l), None))
}

/// A declared value of `prop`. `ctx` resolves relative lengths: `em` is the
/// element's own font size, except for `font-size`, where it is the
/// parent's.
pub(crate) fn parse_value(prop: Prop, text: &str, mode: Mode, ctx: &LenCtx) -> Option<Value> {
  let attr = mode == Mode::Attr;
  if attr {
    match prop {
      // Path data and the transform attribute are not CSS.
      Prop::D => return Some(Value::Path(Some(text.into()))),
      Prop::Transform => {
        return parse_svg_transform(text)
          .map(|list| Value::Transform((!list.is_empty()).then(|| list.into())));
      }
      _ => {}
    }
  }
  use Prop::*;
  parse_with(text, |p| match prop {
    Color | StopColor | FloodColor | LightingColor => parse_color(p).map(Value::Color),
    Fill | Stroke => parse_paint(p).map(Value::Paint),
    FillOpacity | StrokeOpacity | Opacity | StopOpacity | FloodOpacity => opacity(p),
    FillRule | ClipRule => keyword(p, &["nonzero", "evenodd"]),
    StrokeWidth => parse_len(p, ctx, attr)
      .and_then(non_negative)
      .map(Value::Len),
    StrokeDashoffset => parse_len(p, ctx, attr).map(Value::Len),
    StrokeDasharray => {
      if p.try_parse(|i| i.expect_ident_matching("none")).is_ok() {
        return Some(Value::Dashes(None));
      }
      let mut dashes = Vec::new();
      loop {
        dashes.push(parse_len(p, ctx, true).and_then(non_negative)?);
        let _ = p.try_parse(|i| i.expect_comma());
        if p.is_exhausted() {
          break;
        }
      }
      Some(Value::Dashes(Some(dashes.into())))
    }
    StrokeLinecap => keyword(p, &["butt", "round", "square"]),
    StrokeLinejoin => keyword(p, &["miter", "round", "bevel"]),
    StrokeMiterlimit => p
      .expect_number()
      .ok()
      .filter(|v| *v >= 1.0)
      .map(Value::Number),
    FontFamily => parse_families(p).map(Value::Families),
    FontSize => {
      // `ctx.font_size` is the parent's here.
      if let Ok(ident) = p.try_parse(|i| i.expect_ident_cloned()) {
        let parent = ctx.font_size;
        let px = match ident.to_ascii_lowercase().as_str() {
          "xx-small" => 9.0,
          "x-small" => 10.0,
          "small" => 13.0,
          "medium" => 16.0,
          "large" => 18.0,
          "x-large" => 24.0,
          "xx-large" => 32.0,
          "xxx-large" => 48.0,
          "smaller" => parent / 1.2,
          "larger" => parent * 1.2,
          _ => return None,
        };
        return Some(Value::Len(Len::px(px)));
      }
      let l = non_negative(parse_len(p, ctx, attr)?)?;
      Some(Value::Len(Len::px(l.resolve(ctx.font_size))))
    }
    FontWeight => {
      if let Ok(ident) = p.try_parse(|i| i.expect_ident_cloned()) {
        return match ident.to_ascii_lowercase().as_str() {
          "normal" => Some(Value::Number(400.0)),
          "bold" => Some(Value::Number(700.0)),
          "bolder" => Some(Value::Keyword("bolder")),
          "lighter" => Some(Value::Keyword("lighter")),
          _ => None,
        };
      }
      p.expect_number()
        .ok()
        .filter(|v| (1.0..=1000.0).contains(v))
        .map(Value::Number)
    }
    FontStyle => keyword(p, &["normal", "italic", "oblique"]),
    TextAnchor => keyword(p, &["start", "middle", "end"]),
    Visibility => keyword(p, &["visible", "hidden", "collapse"]),
    PaintOrder => {
      if p.try_parse(|i| i.expect_ident_matching("normal")).is_ok() {
        return Some(Value::Keyword("normal"));
      }
      // Markers are not painted, so only fill before or after stroke
      // matters: the first of them named, or fill when only markers is.
      let mut seen: Vec<String> = Vec::new();
      while let Ok(ident) = p.try_parse(|i| i.expect_ident_cloned()) {
        let ident = ident.to_ascii_lowercase();
        if !["fill", "stroke", "markers"].contains(&ident.as_str()) || seen.contains(&ident) {
          return None;
        }
        seen.push(ident);
      }
      let first = seen
        .iter()
        .find(|k| *k != "markers")
        .map(String::as_str)
        .unwrap_or("fill");
      (!seen.is_empty()).then_some(Value::Keyword(if first == "stroke" {
        "stroke"
      } else {
        "normal"
      }))
    }
    ImageRendering => keyword(
      p,
      &[
        "auto",
        "optimizespeed",
        "optimizequality",
        "pixelated",
        "crisp-edges",
        "-webkit-optimize-contrast",
        "smooth",
        "high-quality",
      ],
    ),
    ColorInterpolation | ColorInterpolationFilters => keyword(p, &["auto", "srgb", "linearrgb"]),
    Display => keyword(
      p,
      &[
        "inline",
        "block",
        "none",
        "inline-block",
        "flex",
        "grid",
        "contents",
        "table",
        "list-item",
        "flow-root",
        "inline-flex",
        "inline-grid",
        "inline-table",
        "table-row",
        "table-cell",
      ],
    ),
    ClipPath | Mask => url_or_none(p),
    // A filter function list (blur(), ...) is not drawn here; only a
    // reference to a <filter> is.
    Filter => url_or_none(p),
    Transform => parse_css_transform(p, ctx).map(Value::Transform),
    TransformOrigin => {
      let a = origin_part(p, ctx)?;
      let b = if p.is_exhausted() {
        (None, None)
      } else {
        origin_part(p, ctx)?
      };
      // A z offset does not change a 2D transform.
      let _ = p.try_parse(|i| parse_len(i, ctx, false).ok_or(()));
      let center = Len { px: 0.0, pct: 50.0 };
      let x = a.0.or(b.0).unwrap_or(center);
      // `<x> <y>` as two lengths.
      let y = match (a.0, b.0, b.1) {
        (Some(_), Some(second), None) => second,
        _ => a.1.or(b.1).unwrap_or(center),
      };
      Some(Value::Origin(x, y))
    }
    TransformBox => keyword(
      p,
      &[
        "content-box",
        "border-box",
        "fill-box",
        "stroke-box",
        "view-box",
      ],
    ),
    MaskType => keyword(p, &["luminance", "alpha"]),
    Overflow => keyword(p, &["visible", "hidden", "scroll", "auto", "clip"]),
    X | Y | Cx | Cy => parse_len(p, ctx, attr).map(Value::Len),
    R => parse_len(p, ctx, attr)
      .and_then(non_negative)
      .map(Value::Len),
    Width | Height | Rx | Ry => {
      if p.try_parse(|i| i.expect_ident_matching("auto")).is_ok() {
        return Some(Value::Auto);
      }
      parse_len(p, ctx, attr)
        .and_then(non_negative)
        .map(Value::Len)
    }
    D => {
      if p.try_parse(|i| i.expect_ident_matching("none")).is_ok() {
        return Some(Value::Path(None));
      }
      p.expect_function_matching("path").ok()?;
      p.parse_nested_block(|i| Ok::<_, cssparser::ParseError<()>>(i.expect_string()?.to_string()))
        .ok()
        .map(|d| Value::Path(Some(d.into())))
    }
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  const CTX: LenCtx = LenCtx {
    font_size: 10.0,
    viewport: (100.0, 50.0),
  };

  #[test]
  fn presentation_attributes_take_unitless_lengths() {
    assert_eq!(
      parse_value(Prop::StrokeWidth, "3", Mode::Attr, &CTX),
      Some(Value::Len(Len::px(3.0)))
    );
    assert_eq!(parse_value(Prop::StrokeWidth, "3", Mode::Css, &CTX), None);
    assert_eq!(
      parse_value(Prop::StrokeWidth, "2em", Mode::Css, &CTX),
      Some(Value::Len(Len::px(20.0)))
    );
  }

  #[test]
  fn names_round_trip() {
    for prop in ALL {
      assert_eq!(Prop::from_name(prop.name()), Some(*prop));
    }
    assert_eq!(COUNT, ALL.len());
  }

  #[test]
  fn paint_order_keeps_fill_or_stroke_first() {
    let parse = |s| parse_value(Prop::PaintOrder, s, Mode::Css, &CTX);
    assert_eq!(parse("stroke"), Some(Value::Keyword("stroke")));
    assert_eq!(parse("markers stroke"), Some(Value::Keyword("stroke")));
    assert_eq!(parse("fill markers"), Some(Value::Keyword("normal")));
    assert_eq!(parse("fill fill"), None);
  }
}
