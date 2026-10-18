use crate::color::Color;
use crate::sk::{BlendMode, ImageFilter, Matrix};

use super::{
  font::{Font, FontStretch},
  pattern::Pattern,
  sk::{
    FilterQuality, FontKerning, FontVariantCaps, Paint, TextAlign, TextBaseline, TextDirection,
    TextRendering,
  },
};

use crate::sk::FontVariation;

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
  pub font: String,
  pub font_style: Font,
  pub font_variation_settings: String,
  pub font_variations: Vec<FontVariation>,
  pub text_align: TextAlign,
  pub text_baseline: TextBaseline,
  pub text_direction: TextDirection,
  pub letter_spacing: f32,
  pub letter_spacing_raw: String,
  pub word_spacing: f32,
  pub word_spacing_raw: String,
  pub font_stretch: FontStretch,
  pub font_stretch_raw: String,
  pub font_kerning: FontKerning,
  pub font_variant_caps: FontVariantCaps,
  pub text_rendering: TextRendering,
  pub lang: String,
  pub transform: Matrix,
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
      font: "10px sans-serif".to_owned(),
      font_style: Font::default(),
      font_variation_settings: "normal".to_owned(),
      font_variations: vec![],
      text_align: TextAlign::default(),
      text_baseline: TextBaseline::default(),
      text_direction: TextDirection::default(),
      letter_spacing: 0.0,
      letter_spacing_raw: "0px".to_owned(),
      word_spacing: 0.0,
      word_spacing_raw: "0px".to_owned(),
      font_stretch: FontStretch::Normal,
      font_stretch_raw: "normal".to_owned(),
      font_kerning: FontKerning::Auto,
      font_variant_caps: FontVariantCaps::Normal,
      text_rendering: TextRendering::Auto,
      lang: "inherit".to_owned(),
      transform: Matrix::identity(),
      filter: None,
      filters_string: "none".to_owned(),
      filter_id: 0,
      has_filter: false,
      global_composite_operation: BlendMode::default(),
      has_clip: false,
    }
  }
}
