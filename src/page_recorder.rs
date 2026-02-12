use crate::picture_recorder::PictureRecorder;
use crate::sk::{Canvas, ColorSpace, Matrix, Path as SkPath, SkPicture, Surface};

/// Persistent surface for caching intermediate rendering results.
/// Based on skia-canvas's RecordingSurface pattern.
/// This enables incremental rendering by maintaining a surface that accumulates
/// rendered content between getImageData calls.
pub struct RecordingSurface {
  surface: Option<Surface>,
  depth: usize, // How many layers have been rendered to surface
  width: u32,
  height: u32,
  color_space: ColorSpace,
}

impl RecordingSurface {
  pub fn new() -> Self {
    RecordingSurface {
      surface: None,
      depth: 0,
      width: 0,
      height: 0,
      color_space: ColorSpace::Srgb,
    }
  }

  /// Check if the surface needs to be recreated
  fn is_stale(&self, width: u32, height: u32, color_space: ColorSpace) -> bool {
    self.surface.is_none()
      || self.width != width
      || self.height != height
      || self.color_space != color_space
  }

  /// Update the surface with new layers from the page recorder.
  /// Only renders layers that haven't been rendered yet.
  /// Returns a reference to the surface canvas for pixel reading.
  pub fn update(
    &mut self,
    layers: &[SkPicture],
    width: u32,
    height: u32,
    color_space: ColorSpace,
  ) -> Option<&Surface> {
    // Check if we need to recreate the surface
    if self.is_stale(width, height, color_space) {
      self.surface = Surface::new_rgba_premultiplied(width, height, color_space);
      self.width = width;
      self.height = height;
      self.color_space = color_space;
      self.depth = 0;

      // Clear the new surface
      if let Some(ref mut surface) = self.surface {
        surface.canvas.clear();
      }
    }

    let layer_count = layers.len();

    // Render only new layers
    if let Some(ref mut surface) = self.surface
      && self.depth < layer_count
    {
      for layer in layers.iter().skip(self.depth) {
        layer.playback(&surface.canvas);
      }
      self.depth = layer_count;
    }

    self.surface.as_ref()
  }

  /// Reset the recording surface (on canvas resize or clear)
  pub fn reset(&mut self) {
    self.surface = None;
    self.depth = 0;
    self.width = 0;
    self.height = 0;
  }
}

/// Layer-based deferred rendering recorder (based on skia-canvas)
/// with integrated bitmap caching for incremental rendering.
pub struct PageRecorder {
  current: PictureRecorder, // Active recording
  layers: Vec<SkPicture>,   // Accumulated finalized layers
  width: f32,
  height: f32,
  changed: bool,                       // Dirty flag for lazy layer promotion
  depth: usize, // Tracks how many layers have been rendered to external surface
  cached_picture: Option<SkPicture>, // Cached composite picture for get_picture()
  layers_at_cache: usize, // Layer count when cached_picture was created
  recording_surface: RecordingSurface, // Persistent surface for incremental rendering
  current_transform: Option<Matrix>, // Transform to restore after layer promotion
  current_clip: Option<SkPath>, // Clip path to restore after layer promotion
  save_count: usize, // Track save stack depth to restore after layer promotion
}

impl PageRecorder {
  pub fn new(width: f32, height: f32) -> Self {
    let mut recorder = PictureRecorder::new();
    recorder.begin_recording(0.0, 0.0, width, height);

    PageRecorder {
      current: recorder,
      layers: Vec::new(),
      width,
      height,
      changed: false,
      depth: 0,
      cached_picture: None,
      layers_at_cache: 0,
      recording_surface: RecordingSurface::new(),
      current_transform: None,
      current_clip: None,
      save_count: 0,
    }
  }

  /// Promote current recording to a layer if changed (lazy finalization)
  fn promote_layer(&mut self) {
    if self.changed {
      // Finalize the current recording as a picture
      match self.current.finish_recording_as_picture() {
        Some(picture) => {
          self.layers.push(picture);
          // Invalidate cached picture since layers changed
          self.cached_picture = None;
        }
        None => {
          // This can happen if the recording was empty or if there was an error
          #[cfg(debug_assertions)]
          eprintln!(
            "Warning: Failed to finalize recording as picture - recording may have been empty"
          );
        }
      }
      // Resume recording
      self
        .current
        .begin_recording(0.0, 0.0, self.width, self.height);
      // Restore canvas state on the new recording canvas
      if let Some(canvas) = self.current.get_recording_canvas() {
        // First restore save stack depth so transform/clip are applied at correct level
        for _ in 0..self.save_count {
          canvas.save();
        }
        // Restore clip state first (clip is stored in device space, apply at identity)
        if let Some(ref clip_path) = self.current_clip {
          canvas.reset_transform();
          canvas.set_clip_path(clip_path);
        }
        // Then restore transform state
        if let Some(ref transform) = self.current_transform {
          canvas.set_transform(transform);
        }
      }
      self.changed = false;
    }
  }

  /// Set the current transform to restore after layer promotion
  pub fn set_transform(&mut self, transform: &Matrix) {
    self.current_transform = Some(transform.clone());
  }

  /// Set the current clip path to restore after layer promotion
  pub fn set_clip(&mut self, clip_path: Option<SkPath>) {
    self.current_clip = clip_path;
  }

  /// Increment save count (called when ctx.save() is invoked)
  pub fn increment_save(&mut self) {
    self.save_count += 1;
  }

  /// Decrement save count (called when ctx.restore() is invoked)
  pub fn decrement_save(&mut self) {
    self.save_count = self.save_count.saturating_sub(1);
  }

  /// Get composite picture of all layers (for drawCanvas)
  pub fn get_picture(&mut self) -> Option<SkPicture> {
    self.promote_layer();

    if self.layers.is_empty() {
      return None;
    }

    // Return cached picture if layers haven't changed
    if self.cached_picture.is_some() && self.layers_at_cache == self.layers.len() {
      return self.cached_picture.clone();
    }

    // Regenerate composite picture
    let mut compositor = PictureRecorder::new();
    compositor.begin_recording(0.0, 0.0, self.width, self.height);

    if let Some(canvas) = compositor.get_recording_canvas() {
      for layer in &self.layers {
        // Use direct playback() for better performance
        layer.playback(canvas);
      }
    }

    let picture = compositor.finish_recording_as_picture();
    self.cached_picture = picture.clone();
    self.layers_at_cache = self.layers.len();
    picture
  }

  /// Replay only NEW layers to a target canvas (incremental rendering for flush)
  pub fn playback_to(&mut self, target: &mut Canvas) {
    self.promote_layer();

    // Only render NEW layers since last playback
    if self.depth < self.layers.len() {
      for layer in self.layers.iter().skip(self.depth) {
        // Use direct playback() instead of draw_picture() for better performance
        // playback() doesn't wrap in save/restore or create temporary layers
        layer.playback(target);
      }
      self.depth = self.layers.len(); // Update depth to mark all layers as rendered
    }
  }

  /// Reset recorder (on canvas resize or explicit clear)
  pub fn reset(&mut self, width: f32, height: f32) {
    self.layers.clear();
    self.width = width;
    self.height = height;
    self.current.begin_recording(0.0, 0.0, width, height);
    // Record a clear() command to ensure picture playback clears the target canvas
    // This is necessary because begin_recording may not fully reset canvas state
    if let Some(canvas) = self.current.get_recording_canvas() {
      canvas.clear();
    }
    self.changed = false;
    // Reset all caches
    self.depth = 0;
    self.cached_picture = None;
    self.layers_at_cache = 0;
    // Reset the recording surface
    self.recording_surface.reset();
    // Reset transform and clip state
    self.current_transform = None;
    self.current_clip = None;
    // Reset save count
    self.save_count = 0;
  }

  /// Get pixels using the persistent RecordingSurface.
  /// This enables incremental rendering - only new layers are rendered.
  /// Returns pixel data for the requested region.
  pub fn get_pixels(
    &mut self,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    color_space: ColorSpace,
  ) -> Option<Vec<u8>> {
    self.promote_layer();

    // Use the recording surface for incremental rendering
    let canvas_width = self.width as u32;
    let canvas_height = self.height as u32;

    let surface =
      self
        .recording_surface
        .update(&self.layers, canvas_width, canvas_height, color_space)?;

    // Read pixels from the surface
    surface.read_pixels(x, y, width, height, color_space)
  }

  /// Write pixel data as a separate layer, bypassing clip and transform.
  /// This is used for putImageData which per HTML spec must ignore
  /// the current transform, clip, globalAlpha, and compositing state.
  ///
  /// The approach:
  /// 1. Promote current recording to a layer (preserving pending draw operations)
  /// 2. Create a fresh recording (no clip, identity transform) and execute the draw
  /// 3. Promote that recording as another layer
  /// 4. Start a new recording with the original state restored
  pub fn put_pixels<F>(&mut self, f: F)
  where
    F: FnOnce(&mut Canvas),
  {
    // Step 1: Promote current recording if it has changes
    if self.changed {
      if let Some(picture) = self.current.finish_recording_as_picture() {
        self.layers.push(picture);
        self.cached_picture = None;
      }
      self.changed = false;
    }

    // Step 2: Fresh recording for pixel data (clean canvas: no clip, identity transform)
    self
      .current
      .begin_recording(0.0, 0.0, self.width, self.height);
    if let Some(canvas) = self.current.get_recording_canvas() {
      f(canvas);
    }

    // Step 3: Promote the pixel data recording as a layer
    if let Some(picture) = self.current.finish_recording_as_picture() {
      self.layers.push(picture);
      self.cached_picture = None;
    }

    // Step 4: Start new recording and restore state
    self
      .current
      .begin_recording(0.0, 0.0, self.width, self.height);
    if let Some(canvas) = self.current.get_recording_canvas() {
      for _ in 0..self.save_count {
        canvas.save();
      }
      if let Some(ref clip_path) = self.current_clip {
        canvas.reset_transform();
        canvas.set_clip_path(clip_path);
      }
      if let Some(ref transform) = self.current_transform {
        canvas.set_transform(transform);
      }
    }
    self.changed = false;
  }

  /// Get recording canvas for direct access (needed for SVG/PDF direct mode)
  pub fn get_recording_canvas(&mut self) -> Option<&mut Canvas> {
    self.changed = true;
    self.current.get_recording_canvas()
  }
}
