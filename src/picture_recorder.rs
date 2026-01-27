use crate::sk::{Canvas, SkDrawable, SkPicture, SkPictureRecorder};

pub struct PictureRecorder {
  pub(crate) inner: SkPictureRecorder,
  recording_canvas: Option<Canvas>, // Cache the canvas
}

impl PictureRecorder {
  pub fn new() -> Self {
    PictureRecorder {
      inner: SkPictureRecorder::new(),
      recording_canvas: None,
    }
  }

  pub fn begin_recording(&mut self, x: f32, y: f32, w: f32, h: f32) {
    self.recording_canvas = None; // Clear cached canvas
    self.inner.begin_recording(x, y, w, h);
  }

  pub fn get_recording_canvas(&mut self) -> Option<&mut Canvas> {
    if self.recording_canvas.is_none() {
      self.recording_canvas = self.inner.get_recording_canvas();
    }
    self.recording_canvas.as_mut()
  }

  pub fn finish_recording_as_picture(&mut self) -> Option<SkPicture> {
    self.recording_canvas = None; // Invalidate cached canvas
    self.inner.finish_recording_as_picture()
  }

  /// Finish recording as a drawable for content deduplication.
  /// Drawables enable Skia's internal content deduplication for repeated operations.
  pub fn finish_recording_as_drawable(&mut self) -> Option<SkDrawable> {
    self.recording_canvas = None; // Invalidate cached canvas
    self.inner.finish_recording_as_drawable()
  }
}
