use crate::color::Color;
use crate::css_math::Unit;
use crate::sk::{BlendMode, ImageFilter, Matrix};

use super::{
  font::{ComputedFont, FontStretch},
  pattern::Pattern,
  sk::{
    FilterQuality, FontKerning, FontVariantCaps, Paint, TextAlign, TextBaseline, TextDirection,
    TextRendering,
  },
};

use crate::font_props::{
  FontFeatureSettings, FontOpticalSizing, FontSizeAdjust, FontVariantLigatures, FontVariantNumeric,
  FontVariantPosition,
};
use crate::sk::FontVariation;

pub const BLINK_IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// A letterSpacing / wordSpacing value as Blink keeps it: the float number
/// and its unit (letter_spacing_ and letter_spacing_unit_,
/// canvas_rendering_context_2d_state.h:425-433). The px value is resolved
/// from it when it is set and again on every font change.
#[derive(Debug, Clone, PartialEq)]
pub struct SpacingLength {
  pub value: f32,
  pub unit: Unit,
  /// The unit as typed, lowercased. Blink compares unit types, and `Unit`
  /// merges some (vw and vi, em and __qem), so the early return compares
  /// this name.
  pub name: String,
}

impl Default for SpacingLength {
  fn default() -> Self {
    SpacingLength {
      value: 0.0,
      unit: Unit::Px,
      name: "px".to_owned(),
    }
  }
}

#[derive(Debug, Clone)]
pub struct Context2dRenderingState {
  pub line_dash_list: Vec<f32>,
  pub stroke_style: Pattern,
  pub fill_style: Pattern,
  /// For a gradient or pattern style: the save() depth that set it, where the
  /// context's style object array keeps the JS object the getter returns.
  pub fill_style_slot: Option<u32>,
  pub stroke_style_slot: Option<u32>,
  pub shadow_offset_x: f32,
  pub shadow_offset_y: f32,
  pub shadow_blur: f32,
  /// Blink keeps the parsed Color; the getter serializes it.
  pub shadow_color: Color,
  pub global_alpha: f64,
  pub line_dash_offset: f32,
  pub image_smoothing_enabled: bool,
  pub image_smoothing_quality: FilterQuality,
  pub paint: Paint,
  pub font_style: ComputedFont,
  pub font_variation_settings: String,
  pub font_variations: Vec<FontVariation>,
  /// The six non-standard CSS font properties, parsed; the getters serialize
  /// them (`font_props.rs`). `ctx.font` keeps them.
  pub font_feature_settings: FontFeatureSettings,
  pub font_variant_ligatures: FontVariantLigatures,
  pub font_variant_numeric: FontVariantNumeric,
  pub font_variant_position: FontVariantPosition,
  pub font_size_adjust: FontSizeAdjust,
  pub font_optical_sizing: FontOpticalSizing,
  pub text_align: TextAlign,
  pub text_baseline: TextBaseline,
  pub text_direction: TextDirection,
  /// The spacing in px that text uses.
  pub letter_spacing: f32,
  /// The getter string, Blink's parsed_letter_spacing_: the number and the
  /// unit name, "0px" at first, "" after save() (see `copy_for_save`).
  pub letter_spacing_raw: String,
  pub letter_spacing_len: SpacingLength,
  pub word_spacing: f32,
  pub word_spacing_raw: String,
  pub word_spacing_len: SpacingLength,
  pub font_stretch: FontStretch,
  pub font_stretch_raw: String,
  pub font_kerning: FontKerning,
  pub font_variant_caps: FontVariantCaps,
  pub text_rendering: TextRendering,
  pub lang: String,
  /// The canvas's float matrix, as Chrome's SkCanvas keeps it: each
  /// transform call changes it in float (`ctx.rs` `paint_concat`). Everything
  /// is drawn with it.
  pub transform: Matrix,
  /// Blink's CTM, a double AffineTransform [a, b, c, d, e, f]: what
  /// getTransform() returns, what the path and the isPointInPath and
  /// isPointInStroke points are mapped by, and what decides when Blink maps
  /// the path (GetModifiablePath). It can differ from `transform`: after
  /// rotate(1e-5) `transform` is the identity (setRotate snaps), this is not.
  pub blink_transform: [f64; 6],
  pub filter: Option<ImageFilter>,
  pub filters_string: String,
  /// Accounting identity for `filter`: the parsed chain is ONE refcounted
  /// ImageFilter shared by every paint the state clones into, so its retained
  /// charge must key on a stable id rather than bill per draw. Minted by
  /// set_filter each time a parsed chain is stored; 0 means none.
  pub filter_id: u64,
  /// Blink's StateHasFilter: the assigned filter list built a `filter`.
  pub has_filter: bool,
  pub global_composite_operation: BlendMode,
  /// Blink's has_clip_: some clip() applies at this level or below.
  pub has_clip: bool,
}

impl Default for Context2dRenderingState {
  fn default() -> Context2dRenderingState {
    Context2dRenderingState {
      line_dash_list: vec![],
      stroke_style: Pattern::default(),
      fill_style: Pattern::default(),
      fill_style_slot: None,
      stroke_style_slot: None,
      shadow_offset_x: 0f32,
      shadow_offset_y: 0f32,
      shadow_blur: 0f32,
      // Transparent black, as the spec says and Chrome does
      // (canvas_rendering_context_2d_state.cc: shadow_color_(Color::kTransparent)).
      shadow_color: Color::TRANSPARENT,
      // 0.0 ~ 1.0
      global_alpha: 1.0,
      // A float specifying the amount of the line dash offset. The default value is 0.0.
      line_dash_offset: 0.0,
      image_smoothing_enabled: true,
      image_smoothing_quality: FilterQuality::default(),
      paint: Paint::default(),
      font_style: ComputedFont::default(),
      font_variation_settings: "normal".to_owned(),
      font_variations: vec![],
      font_feature_settings: FontFeatureSettings::default(),
      font_variant_ligatures: FontVariantLigatures::default(),
      font_variant_numeric: FontVariantNumeric::default(),
      font_variant_position: FontVariantPosition::Normal,
      font_size_adjust: FontSizeAdjust::None,
      font_optical_sizing: FontOpticalSizing::Auto,
      text_align: TextAlign::default(),
      text_baseline: TextBaseline::default(),
      text_direction: TextDirection::default(),
      letter_spacing: 0.0,
      letter_spacing_raw: "0px".to_owned(),
      letter_spacing_len: SpacingLength::default(),
      word_spacing: 0.0,
      word_spacing_raw: "0px".to_owned(),
      word_spacing_len: SpacingLength::default(),
      font_stretch: FontStretch::Normal,
      font_stretch_raw: "normal".to_owned(),
      font_kerning: FontKerning::Auto,
      font_variant_caps: FontVariantCaps::Normal,
      text_rendering: TextRendering::Auto,
      lang: "inherit".to_owned(),
      transform: Matrix::identity(),
      blink_transform: BLINK_IDENTITY,
      filter: None,
      filters_string: "none".to_owned(),
      filter_id: 0,
      has_filter: false,
      global_composite_operation: BlendMode::default(),
      has_clip: false,
    }
  }
}

impl Context2dRenderingState {
  /// The state save() puts on top. Blink's copy constructor
  /// (canvas_rendering_context_2d_state.cc:183-236) copies the spacing
  /// numbers and units but not parsed_letter_spacing_ / parsed_word_spacing_,
  /// so after save() both getters are "" until a new value is set. Chrome 157
  /// does this; restore() gives the saved strings back. Clone keeps them, as
  /// the saved state must.
  pub fn copy_for_save(&self) -> Self {
    let mut top = self.clone();
    top.letter_spacing_raw = String::new();
    top.word_spacing_raw = String::new();
    top
  }
}
