use cssparser::RGBA;

use super::pattern::Pattern;
use super::sk::{BlendMode, FilterQuality, Paint, TextAlign, TextBaseline};

#[derive(Debug, Clone)]
pub struct Context2dRenderingState {
  pub line_dash_list: Vec<f32>,
  pub stroke_style: Pattern,
  pub fill_style: Pattern,
  pub shadow_offset_x: f32,
  pub shadow_offset_y: f32,
  pub shadow_blur: f32,
  pub shadow_color: RGBA,
  pub global_alpha: f32,
  pub line_dash_offset: f32,
  pub global_composite_operation: BlendMode,
  pub image_smoothing_enabled: bool,
  pub image_smoothing_quality: FilterQuality,
  pub paint: Paint,
  pub font: String,
  pub text_align: TextAlign,
  pub text_baseline: TextBaseline,
}

impl Default for Context2dRenderingState {
  fn default() -> Context2dRenderingState {
    Context2dRenderingState {
      line_dash_list: Vec::new(),
      stroke_style: Pattern::Color(RGBA::new(0, 0, 0, 255), "#000".to_owned()),
      fill_style: Pattern::Color(RGBA::new(0, 0, 0, 255), "#000".to_owned()),
      shadow_offset_x: 0f32,
      shadow_offset_y: 0f32,
      shadow_blur: 0f32,
      shadow_color: RGBA::new(0, 0, 0, 0),
      /// 0.0 ~ 1.0
      global_alpha: 1.0,
      /// A float specifying the amount of the line dash offset. The default value is 0.0.
      line_dash_offset: 0.0,
      global_composite_operation: BlendMode::SourceOver,
      image_smoothing_enabled: true,
      image_smoothing_quality: FilterQuality::Low,
      paint: Paint::default(),
      font: "10px monospace".to_owned(),
      text_align: TextAlign::Start,
      text_baseline: TextBaseline::Alphabetic,
    }
  }
}
