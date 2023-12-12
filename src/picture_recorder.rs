use crate::sk::{Canvas, SkPicture, SkPictureRecorder};

pub struct PictureRecorder {
  pub(crate) inner: SkPictureRecorder,
}

impl PictureRecorder {
  pub fn new() -> Self {
    PictureRecorder {
      inner: SkPictureRecorder::new(),
    }
  }

  pub fn begin_recording(&mut self, x: f32, y: f32, w: f32, h: f32) {
    self.inner.begin_recording(x, y, w, h);
  }

  pub fn get_recording_canvas(&mut self) -> Option<Canvas> {
    self.inner.get_recording_canvas()
  }

  pub fn finish_recording_as_picture(&mut self) -> Option<SkPicture> {
    self.inner.finish_recording_as_picture()
  }
}
