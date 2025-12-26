use rgb::RGBA;

use crate::sk::{BlendMode, ImageFilter, Matrix};

use super::{
  font::{Font, FontStretch},
  pattern::Pattern,
  sk::{
    FilterQuality, FontKerning, FontVariantCaps, Paint, TextAlign, TextBaseline, TextDirection,
  },
};

use crate::sk::FontVariation;

#[derive(Debug, Clone)]
pub struct Context2dRenderingState {
  pub line_dash_list: Vec<f32>,
  pub stroke_style: Pattern,
  pub fill_style: Pattern,
  pub shadow_offset_x: f32,
  pub shadow_offset_y: f32,
  pub shadow_blur: f32,
  pub shadow_color: RGBA<u8>,
  pub shadow_color_string: String,
  pub global_alpha: f32,
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
  pub lang: String,
  pub transform: Matrix,
  pub filter: Option<ImageFilter>,
  pub filters_string: String,
  pub global_composite_operation: BlendMode,
}

impl Default for Context2dRenderingState {
  fn default() -> Context2dRenderingState {
    Context2dRenderingState {
      line_dash_list: vec![],
      stroke_style: Pattern::default(),
      fill_style: Pattern::default(),
      shadow_offset_x: 0f32,
      shadow_offset_y: 0f32,
      shadow_blur: 0f32,
      shadow_color: RGBA::new(0, 0, 0, 255),
      shadow_color_string: "#000000".to_owned(),
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
      lang: "inherit".to_owned(),
      transform: Matrix::identity(),
      filter: None,
      filters_string: "none".to_owned(),
      global_composite_operation: BlendMode::default(),
    }
  }
}
