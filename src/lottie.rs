use napi::bindgen_prelude::*;

use crate::ctx::CanvasRenderingContext2D;
use crate::sk::{self, ffi::skiac_rect};

/// Options for loading Lottie animations
#[napi(object)]
pub struct LottieAnimationOptions {
  /// Base path for resolving external resources (images, fonts)
  pub resource_path: Option<String>,
}

/// Destination rectangle for rendering
#[napi(object)]
pub struct LottieRenderRect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

/// Lottie animation loaded from JSON
#[napi]
pub struct LottieAnimation {
  inner: sk::SkottieAnimation,
}

#[napi]
impl LottieAnimation {
  /// Load animation from JSON string or Buffer
  #[napi(factory, js_name = "loadFromData")]
  pub fn load_from_data(
    data: Either<String, Buffer>,
    options: Option<LottieAnimationOptions>,
  ) -> Result<Self> {
    let data_bytes = match &data {
      Either::A(s) => s.as_bytes(),
      Either::B(b) => b.as_ref(),
    };

    let resource_path = options.as_ref().and_then(|o| o.resource_path.as_deref());

    let inner = sk::SkottieAnimation::from_data(data_bytes, resource_path).ok_or_else(|| {
      Error::new(
        Status::InvalidArg,
        "Failed to load Lottie animation from data",
      )
    })?;

    Ok(Self { inner })
  }

  /// Load animation from file path
  #[napi(factory, js_name = "loadFromFile")]
  pub fn load_from_file(path: String, _options: Option<LottieAnimationOptions>) -> Result<Self> {
    let inner = sk::SkottieAnimation::from_file(&path).ok_or_else(|| {
      Error::new(
        Status::InvalidArg,
        format!("Failed to load Lottie animation from file: {}", path),
      )
    })?;

    Ok(Self { inner })
  }

  /// Animation duration in seconds
  #[napi(getter)]
  pub fn duration(&self) -> f64 {
    self.inner.duration()
  }

  /// Frame rate (frames per second)
  #[napi(getter)]
  pub fn fps(&self) -> f64 {
    self.inner.fps()
  }

  /// Total frame count
  #[napi(getter)]
  pub fn frames(&self) -> f64 {
    self.inner.frames()
  }

  /// Animation width
  #[napi(getter)]
  pub fn width(&self) -> f64 {
    self.inner.width() as f64
  }

  /// Animation height
  #[napi(getter)]
  pub fn height(&self) -> f64 {
    self.inner.height() as f64
  }

  /// Lottie format version
  #[napi(getter)]
  pub fn version(&self) -> String {
    self.inner.version().to_string()
  }

  /// Animation in-point (start frame)
  #[napi(getter, js_name = "inPoint")]
  pub fn in_point(&self) -> f64 {
    self.inner.in_point()
  }

  /// Animation out-point (end frame)
  #[napi(getter, js_name = "outPoint")]
  pub fn out_point(&self) -> f64 {
    self.inner.out_point()
  }

  /// Seek to normalized position [0..1]
  #[napi]
  pub fn seek(&self, t: f64) {
    self.inner.seek(t as f32);
  }

  /// Seek to specific frame index (0 = first frame)
  #[napi(js_name = "seekFrame")]
  pub fn seek_frame(&self, frame: f64) {
    self.inner.seek_frame(frame);
  }

  /// Seek to specific time in seconds
  #[napi(js_name = "seekTime")]
  pub fn seek_time(&self, seconds: f64) {
    self.inner.seek_frame_time(seconds);
  }

  /// Render current frame to canvas context
  #[napi]
  pub fn render(&self, ctx: &CanvasRenderingContext2D, dst: Option<LottieRenderRect>) {
    let canvas = &ctx.context.surface.canvas;
    let rect = dst.map(|d| skiac_rect {
      left: d.x as f32,
      top: d.y as f32,
      right: (d.x + d.width) as f32,
      bottom: (d.y + d.height) as f32,
    });
    self.inner.render(canvas, rect.as_ref());
  }
}
