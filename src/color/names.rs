//! Color names and keywords: Blink's named color table
//! (platform/color_data.gperf), the CSS color keywords
//! (StyleColor::IsColorKeyword, style_color.cc:432-472) and the system colors
//! with no color provider (LayoutTheme::DefaultSystemColor,
//! layout_theme.cc:626-772), which is what an OffscreenCanvas sees.

use super::model::Color;

/// color_data.gperf: the 148 CSS names, `transparent`, and the Blink-only
/// `lightslateblue` and `violetred`. Sorted for binary search.
static NAMED_COLORS: [(&str, u32); 151] = [
  ("aliceblue", 0xFFF0F8FF),
  ("antiquewhite", 0xFFFAEBD7),
  ("aqua", 0xFF00FFFF),
  ("aquamarine", 0xFF7FFFD4),
  ("azure", 0xFFF0FFFF),
  ("beige", 0xFFF5F5DC),
  ("bisque", 0xFFFFE4C4),
  ("black", 0xFF000000),
  ("blanchedalmond", 0xFFFFEBCD),
  ("blue", 0xFF0000FF),
  ("blueviolet", 0xFF8A2BE2),
  ("brown", 0xFFA52A2A),
  ("burlywood", 0xFFDEB887),
  ("cadetblue", 0xFF5F9EA0),
  ("chartreuse", 0xFF7FFF00),
  ("chocolate", 0xFFD2691E),
  ("coral", 0xFFFF7F50),
  ("cornflowerblue", 0xFF6495ED),
  ("cornsilk", 0xFFFFF8DC),
  ("crimson", 0xFFDC143C),
  ("cyan", 0xFF00FFFF),
  ("darkblue", 0xFF00008B),
  ("darkcyan", 0xFF008B8B),
  ("darkgoldenrod", 0xFFB8860B),
  ("darkgray", 0xFFA9A9A9),
  ("darkgreen", 0xFF006400),
  ("darkgrey", 0xFFA9A9A9),
  ("darkkhaki", 0xFFBDB76B),
  ("darkmagenta", 0xFF8B008B),
  ("darkolivegreen", 0xFF556B2F),
  ("darkorange", 0xFFFF8C00),
  ("darkorchid", 0xFF9932CC),
  ("darkred", 0xFF8B0000),
  ("darksalmon", 0xFFE9967A),
  ("darkseagreen", 0xFF8FBC8F),
  ("darkslateblue", 0xFF483D8B),
  ("darkslategray", 0xFF2F4F4F),
  ("darkslategrey", 0xFF2F4F4F),
  ("darkturquoise", 0xFF00CED1),
  ("darkviolet", 0xFF9400D3),
  ("deeppink", 0xFFFF1493),
  ("deepskyblue", 0xFF00BFFF),
  ("dimgray", 0xFF696969),
  ("dimgrey", 0xFF696969),
  ("dodgerblue", 0xFF1E90FF),
  ("firebrick", 0xFFB22222),
  ("floralwhite", 0xFFFFFAF0),
  ("forestgreen", 0xFF228B22),
  ("fuchsia", 0xFFFF00FF),
  ("gainsboro", 0xFFDCDCDC),
  ("ghostwhite", 0xFFF8F8FF),
  ("gold", 0xFFFFD700),
  ("goldenrod", 0xFFDAA520),
  ("gray", 0xFF808080),
  ("green", 0xFF008000),
  ("greenyellow", 0xFFADFF2F),
  ("grey", 0xFF808080),
  ("honeydew", 0xFFF0FFF0),
  ("hotpink", 0xFFFF69B4),
  ("indianred", 0xFFCD5C5C),
  ("indigo", 0xFF4B0082),
  ("ivory", 0xFFFFFFF0),
  ("khaki", 0xFFF0E68C),
  ("lavender", 0xFFE6E6FA),
  ("lavenderblush", 0xFFFFF0F5),
  ("lawngreen", 0xFF7CFC00),
  ("lemonchiffon", 0xFFFFFACD),
  ("lightblue", 0xFFADD8E6),
  ("lightcoral", 0xFFF08080),
  ("lightcyan", 0xFFE0FFFF),
  ("lightgoldenrodyellow", 0xFFFAFAD2),
  ("lightgray", 0xFFD3D3D3),
  ("lightgreen", 0xFF90EE90),
  ("lightgrey", 0xFFD3D3D3),
  ("lightpink", 0xFFFFB6C1),
  ("lightsalmon", 0xFFFFA07A),
  ("lightseagreen", 0xFF20B2AA),
  ("lightskyblue", 0xFF87CEFA),
  ("lightslateblue", 0xFF8470FF),
  ("lightslategray", 0xFF778899),
  ("lightslategrey", 0xFF778899),
  ("lightsteelblue", 0xFFB0C4DE),
  ("lightyellow", 0xFFFFFFE0),
  ("lime", 0xFF00FF00),
  ("limegreen", 0xFF32CD32),
  ("linen", 0xFFFAF0E6),
  ("magenta", 0xFFFF00FF),
  ("maroon", 0xFF800000),
  ("mediumaquamarine", 0xFF66CDAA),
  ("mediumblue", 0xFF0000CD),
  ("mediumorchid", 0xFFBA55D3),
  ("mediumpurple", 0xFF9370DB),
  ("mediumseagreen", 0xFF3CB371),
  ("mediumslateblue", 0xFF7B68EE),
  ("mediumspringgreen", 0xFF00FA9A),
  ("mediumturquoise", 0xFF48D1CC),
  ("mediumvioletred", 0xFFC71585),
  ("midnightblue", 0xFF191970),
  ("mintcream", 0xFFF5FFFA),
  ("mistyrose", 0xFFFFE4E1),
  ("moccasin", 0xFFFFE4B5),
  ("navajowhite", 0xFFFFDEAD),
  ("navy", 0xFF000080),
  ("oldlace", 0xFFFDF5E6),
  ("olive", 0xFF808000),
  ("olivedrab", 0xFF6B8E23),
  ("orange", 0xFFFFA500),
  ("orangered", 0xFFFF4500),
  ("orchid", 0xFFDA70D6),
  ("palegoldenrod", 0xFFEEE8AA),
  ("palegreen", 0xFF98FB98),
  ("paleturquoise", 0xFFAFEEEE),
  ("palevioletred", 0xFFDB7093),
  ("papayawhip", 0xFFFFEFD5),
  ("peachpuff", 0xFFFFDAB9),
  ("peru", 0xFFCD853F),
  ("pink", 0xFFFFC0CB),
  ("plum", 0xFFDDA0DD),
  ("powderblue", 0xFFB0E0E6),
  ("purple", 0xFF800080),
  ("rebeccapurple", 0xFF663399),
  ("red", 0xFFFF0000),
  ("rosybrown", 0xFFBC8F8F),
  ("royalblue", 0xFF4169E1),
  ("saddlebrown", 0xFF8B4513),
  ("salmon", 0xFFFA8072),
  ("sandybrown", 0xFFF4A460),
  ("seagreen", 0xFF2E8B57),
  ("seashell", 0xFFFFF5EE),
  ("sienna", 0xFFA0522D),
  ("silver", 0xFFC0C0C0),
  ("skyblue", 0xFF87CEEB),
  ("slateblue", 0xFF6A5ACD),
  ("slategray", 0xFF708090),
  ("slategrey", 0xFF708090),
  ("snow", 0xFFFFFAFA),
  ("springgreen", 0xFF00FF7F),
  ("steelblue", 0xFF4682B4),
  ("tan", 0xFFD2B48C),
  ("teal", 0xFF008080),
  ("thistle", 0xFFD8BFD8),
  ("tomato", 0xFFFF6347),
  ("transparent", 0x00000000),
  ("turquoise", 0xFF40E0D0),
  ("violet", 0xFFEE82EE),
  ("violetred", 0xFFD02090),
  ("wheat", 0xFFF5DEB3),
  ("white", 0xFFFFFFFF),
  ("whitesmoke", 0xFFF5F5F5),
  ("yellow", 0xFFFFFF00),
  ("yellowgreen", 0xFF9ACD32),
];

fn lookup(lower: &str) -> Option<u32> {
  NAMED_COLORS
    .binary_search_by(|(name, _)| name.as_bytes().cmp(lower.as_bytes()))
    .ok()
    .map(|i| NAMED_COLORS[i].1)
}

/// Color::SetNamedColor / FindNamedColor (color.cc:126-140): the whole string,
/// ASCII case-insensitive, at most 63 characters, no NUL and no non-ASCII.
pub(crate) fn find_named_color(name: &str) -> Option<Color> {
  if name.len() > 63 || name.bytes().any(|b| b == 0 || b > 0x7F) {
    return None;
  }
  lookup(&name.to_ascii_lowercase()).map(Color::from_rgba32)
}

/// What a CSS color keyword resolves to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ColorKeyword {
  /// A named color (StyleColor::ColorFromKeyword finds it in the table).
  Named(u32),
  CurrentColor,
  System(SystemColor),
  /// ResolveQuirkOrLinkOrFocusRingColor (style_builder_converter.cc): the
  /// text link colors of the resolve context.
  WebkitLink,
  WebkitActiveLink,
}

/// The system color keywords Blink accepts in author style sheets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SystemColor {
  AccentColor,
  AccentColorText,
  ActiveBorder,
  ActiveCaption,
  ActiveText,
  AppWorkspace,
  Background,
  ButtonBorder,
  ButtonFace,
  ButtonHighlight,
  ButtonShadow,
  ButtonText,
  Canvas,
  CanvasText,
  CaptionText,
  Field,
  FieldText,
  GrayText,
  Highlight,
  HighlightText,
  InactiveBorder,
  InactiveCaption,
  InactiveCaptionText,
  InfoBackground,
  InfoText,
  LinkText,
  Mark,
  MarkText,
  Menu,
  MenuText,
  SelectedItem,
  SelectedItemText,
  Scrollbar,
  ThreeDDarkShadow,
  ThreeDFace,
  ThreeDHighlight,
  ThreeDLightShadow,
  ThreeDShadow,
  VisitedText,
  Window,
  WindowFrame,
  WindowText,
}

fn system_keyword(lower: &str) -> Option<SystemColor> {
  use SystemColor::*;
  Some(match lower {
    "accentcolor" => AccentColor,
    "accentcolortext" => AccentColorText,
    "activeborder" => ActiveBorder,
    "activecaption" => ActiveCaption,
    "activetext" => ActiveText,
    "appworkspace" => AppWorkspace,
    "background" => Background,
    "buttonborder" => ButtonBorder,
    "buttonface" => ButtonFace,
    "buttonhighlight" => ButtonHighlight,
    "buttonshadow" => ButtonShadow,
    "buttontext" => ButtonText,
    "canvas" => Canvas,
    "canvastext" => CanvasText,
    "captiontext" => CaptionText,
    "field" => Field,
    "fieldtext" => FieldText,
    "graytext" => GrayText,
    "highlight" => Highlight,
    "highlighttext" => HighlightText,
    "inactiveborder" => InactiveBorder,
    "inactivecaption" => InactiveCaption,
    "inactivecaptiontext" => InactiveCaptionText,
    "infobackground" => InfoBackground,
    "infotext" => InfoText,
    "linktext" => LinkText,
    "mark" => Mark,
    "marktext" => MarkText,
    "menu" => Menu,
    "menutext" => MenuText,
    "selecteditem" => SelectedItem,
    "selecteditemtext" => SelectedItemText,
    "scrollbar" => Scrollbar,
    "threeddarkshadow" => ThreeDDarkShadow,
    "threedface" => ThreeDFace,
    "threedhighlight" => ThreeDHighlight,
    "threedlightshadow" => ThreeDLightShadow,
    "threedshadow" => ThreeDShadow,
    "visitedtext" => VisitedText,
    "window" => Window,
    "windowframe" => WindowFrame,
    "windowtext" => WindowText,
    _ => return None,
  })
}

/// StyleColor::IsColorKeyword (style_color.cc:432-472) limited by
/// IsValueAllowedInMode for a strict author context: `-internal-*` keywords
/// are UA-only and `-webkit-focus-ring-color` is quirks/UA-only. `lightslateblue`
/// and `violetred` are not CSS keywords. `ident` is already unescaped.
pub(crate) fn css_color_keyword(ident: &str) -> Option<ColorKeyword> {
  if ident.bytes().any(|b| b > 0x7F) {
    return None;
  }
  let lower = ident.to_ascii_lowercase();
  match lower.as_str() {
    "currentcolor" => return Some(ColorKeyword::CurrentColor),
    "-webkit-link" => return Some(ColorKeyword::WebkitLink),
    "-webkit-activelink" => return Some(ColorKeyword::WebkitActiveLink),
    "lightslateblue" | "violetred" => return None,
    _ => {}
  }
  if let Some(argb) = lookup(&lower) {
    return Some(ColorKeyword::Named(argb));
  }
  system_keyword(&lower).map(ColorKeyword::System)
}

/// CSSParser::ParseSystemColor (css_parser.cc:436-449): the whole string is
/// one keyword of StyleColor::IsSystemColorIncludingDeprecated
/// (`ActiveBorder`..`WindowText` and `Menu`, not `AccentColor`).
pub(crate) fn top_level_system_color(s: &str) -> Option<Color> {
  if s.bytes().any(|b| b > 0x7F) {
    return None;
  }
  match system_keyword(&s.to_ascii_lowercase())? {
    SystemColor::AccentColor | SystemColor::AccentColorText => None,
    id => Some(system_color(id)),
  }
}

/// LayoutTheme::DefaultSystemColor for the light scheme with no color provider
/// and `can_expose_accent_color` false.
pub(crate) fn system_color(id: SystemColor) -> Color {
  use SystemColor::*;
  let argb = match id {
    // GetAccentColorOrDefault / GetAccentColorText without exposing the
    // system accent color (layout_theme.cc).
    AccentColor => 0xFF0075FF,
    AccentColorText => 0xFFFFFFFF,
    ActiveText => 0xFFFF0000,
    ButtonBorder | ActiveBorder | InactiveBorder | ThreeDDarkShadow | ThreeDHighlight
    | ThreeDLightShadow | ThreeDShadow | WindowFrame => 0xFF767676,
    ButtonFace | ButtonHighlight | ButtonShadow | ThreeDFace => 0xFFEFEFEF,
    ButtonText => 0xFF000000,
    // CSSActiveCaptionMapsToCanvas is stable.
    Canvas | ActiveCaption => 0xFFFFFFFF,
    AppWorkspace | Background | InactiveCaption | InfoBackground | Menu | Scrollbar | Window => {
      0xFFFFFFFF
    }
    CanvasText | CaptionText | InfoText | MenuText | WindowText => 0xFF000000,
    Field => 0xFFFFFFFF,
    FieldText => 0xFF000000,
    GrayText | InactiveCaptionText => 0xFF808080,
    // ActiveSelectionBackgroundColor (layout_theme.cc:361-371).
    Highlight => return Color::from_rgba32(selection_background()).blend_with_white(),
    HighlightText | SelectedItemText => selection_foreground(),
    LinkText => 0xFF0000EE,
    Mark => 0xFFFFFF00,
    MarkText => 0xFF000000,
    VisitedText => 0xFF551A8B,
    // PlatformActiveListBoxSelectionBackgroundColor (layout_theme.cc:441-446).
    SelectedItem => selection_background(),
  };
  Color::from_rgba32(argb)
}

/// The active selection colors. macOS: measured in Chrome 155
/// (`Highlight` = rgba(128, 188, 254, 0.6), `SelectedItem` #b3d7ff, text
/// black). Elsewhere: Blink's defaults when the browser sets none,
/// kDefaultActiveSelectionBgColor / FgColor (renderer_preferences.h:26-27).
#[cfg(target_os = "macos")]
fn selection_background() -> u32 {
  0xFFB3D7FF
}

#[cfg(target_os = "macos")]
fn selection_foreground() -> u32 {
  0xFF000000
}

#[cfg(not(target_os = "macos"))]
fn selection_background() -> u32 {
  0xFF1967D2
}

#[cfg(not(target_os = "macos"))]
fn selection_foreground() -> u32 {
  0xFFFFFFFF
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn named_colors_are_sorted_and_complete() {
    assert!(NAMED_COLORS.windows(2).all(|w| w[0].0 < w[1].0));
    assert_eq!(
      find_named_color("LightSlateBlue"),
      Some(Color::from_rgba32(0xFF8470FF))
    );
    assert_eq!(find_named_color("transparent"), Some(Color::TRANSPARENT));
    assert_eq!(find_named_color("red "), None);
    assert_eq!(css_color_keyword("violetred"), None);
    assert_eq!(
      css_color_keyword("Grey"),
      Some(ColorKeyword::Named(0xFF808080))
    );
    assert_eq!(css_color_keyword("-webkit-focus-ring-color"), None);
    assert_eq!(css_color_keyword("Text"), None);
  }
}
