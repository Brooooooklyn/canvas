use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::picture_recorder::PictureRecorder;
use crate::sk::{Canvas, FilterQuality, Matrix, Path as SkPath, SkImage, SkPicture};

/// Monotonic identity for chargeable resources (canvas contexts, image
/// patterns). Raw backing pointers are NOT usable as identities: a dropped
/// source frees its SkSurface/SkBitmap, the allocator hands the address to the
/// next allocation, and a stale retained_rasters key would let the new raster
/// escape its charge entirely.
static NEXT_RESOURCE_ID: AtomicU64 = AtomicU64::new(1);

/// Hand out a fresh resource identity. Starts at 1 so id 0 stays free for
/// the nonce-keyed sources in ctx.rs.
pub(crate) fn next_resource_id() -> u64 {
  NEXT_RESOURCE_ID.fetch_add(1, Ordering::Relaxed)
}

/// Identity key for one retained raster inside `retained_rasters`. The two
/// arms MUST NOT share a raw id space: `Resource::id` comes from our own
/// `next_resource_id()` counter while `Picture::uid` comes from Skia's
/// SkPicture::uniqueID() counter, and the two counters collide freely --
/// under one flat key a small drawImage source and a large drawCanvas
/// source can swap ids and dedup each other, silently uncharging rasters.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum RasterKey {
  /// `next_resource_id()` identity plus the source's content generation.
  /// The generation distinguishes a canvas surface's COW snapshot
  /// generations, which share the source's resource id.
  Resource { id: u64, generation: u64 },
  /// SkPicture::uniqueID() of the source's composite picture (drawCanvas).
  Picture { uid: u64 },
  /// SkPathData identity (SkPath::getGenerationID) of a recorded path
  /// payload. Its counter is a third id space (SkPathData::uniqueID), so it
  /// needs its own arm: drawPath/clip ops pin a COW-shared SkPathData, and
  /// distinct-data paths of identical size must not alias each other.
  Path { data_id: u32 },
  /// Content hash of the resolved-font descriptor (family/style/variations)
  /// folded with the font-collection generation. Each recorded text op's
  /// blob refs the resolved typeface, and identical descriptors resolve to
  /// the SAME face, so a per-draw charge would bill one pinned typeface N
  /// times. Hashes can alias across descriptors (a bounded under-charge,
  /// ~2^-64), which the Resource counter's id space cannot give back.
  Typeface { key: u64 },
}

/// Recorded-byte cap on the pending recording, after which Context flushes it
/// to the surface. Mirrors Blink's recorded-op-bytes cap
/// (memory_managed_paint_recorder.cc). SkPicture exposes no byte metric, so
/// callers charge estimates: a base 256 B/op (~265 B/op measured in
/// https://github.com/Brooooooklyn/canvas/issues/1342) plus per-payload
/// estimates for paths, bitmaps, text and putImageData.
const MAX_RECORDED_BYTES: usize = 32 * 1024 * 1024;

/// Base per-recorded-op byte estimate; ~265 B/op was measured in issue #1342.
const BYTES_PER_RECORDED_OP: usize = 256;

/// Per-SkPicture overhead estimate (SkRecord + SkPicture/SkImage objects)
/// for each finalized layer; ~1.2 KB/layer measured with a 1x1 putImageData
/// loop, whose pixel charge alone cannot see it.
const BYTES_PER_PICTURE_LAYER: usize = 1024;

/// Layer-based deferred rendering recorder (based on skia-canvas)
/// with integrated bitmap caching for incremental rendering.
pub struct PageRecorder {
  current: PictureRecorder, // Active recording
  layers: Vec<SkPicture>,   // Accumulated finalized layers
  width: f32,
  height: f32,
  changed: bool,                     // Dirty flag for lazy layer promotion
  depth: usize, // Tracks how many layers have been rendered to external surface
  cached_picture: Option<SkPicture>, // Cached composite picture for get_picture()
  layers_at_cache: usize, // Layer count when cached_picture was created
  pending_bytes: usize, // Recorded bytes charged since last flush
  // The subset of pending_bytes that pays for retained payloads
  // approximateBytesUsed cannot see: pinned raster copies (putImageData /
  // drawImage / image-pattern payloads), recorded typefaces, and the
  // consolidated snapshot's raster. drawCanvas charges destinations with it.
  raster_bytes: usize,
  // Identity keys of rasters already charged in this window. Recorded ops
  // pin a shared reference, so re-drawing one UNCHANGED source must not
  // charge its raster again; a canvas source's drawImage op retains a fresh
  // makeImageSnapshot, so a mutation bumps the source's content_version and
  // re-charges under the new generation. Resource identity is a monotonic
  // id (next_resource_id) or a SkPicture::uniqueID -- never a raw pointer:
  // a pointer is recycled once its owner is freed and a stale key would
  // silently uncharge the new raster. Cleared when the layers pinning them
  // are released by consolidate_with_snapshot/reset -- the next recorded op
  // re-charges, matching the new picture's fresh reference.
  retained_rasters: HashSet<RasterKey>,
  // Monotonic content generation, bumped on every recorded mutation. Never
  // reset: it is only an identity distinguisher for retained_rasters keys,
  // not a byte tally.
  content_version: u64,
  // Set when a direct surface write bypassed the recording (lottie frame,
  // alpha:false base fill). While set, `layers` hold only post-write content
  // and cannot reproduce the write, so get_picture() has to be rebased on a
  // surface snapshot before returning a composite.
  surface_dirty: bool,
  current_transform: Option<Matrix>, // Transform to restore after layer promotion
  current_clip: Option<SkPath>,      // Clip path to restore after layer promotion
  save_count: usize,                 // Track save stack depth to restore after layer promotion
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
      pending_bytes: 0,
      raster_bytes: 0,
      retained_rasters: HashSet::new(),
      content_version: 0,
      surface_dirty: false,
      current_transform: None,
      current_clip: None,
      save_count: 0,
    }
  }

  /// Begin a new recording and restore the current canvas state (save stack, clip, transform).
  fn resume_recording(&mut self) {
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
    // The set_clip_path above re-pins the clip's SkPathData inside the new
    // recording: it is the DEVICE-space clip (ctx.sync_clip_to_recorder
    // stores the transformed path), a different data object than the raw
    // path clip() already charged, so it needs its own key. Dedup makes it
    // once per window per data version; after consolidate clears the set
    // the resumed layer gets a fresh charge, matching its fresh reference.
    if let Some(ref clip_path) = self.current_clip {
      let bytes = clip_path.estimated_bytes();
      let data_id = clip_path.generation_id();
      self.account_raster_resource(RasterKey::Path { data_id }, bytes);
    }
    self.changed = false;
  }

  /// Push a finalized picture onto the layer stack, charging its per-layer
  /// object overhead and invalidating the composite-picture cache.
  fn push_layer(&mut self, picture: SkPicture) {
    self.layers.push(picture);
    self.cached_picture = None;
    self.pending_bytes += BYTES_PER_PICTURE_LAYER;
  }

  /// Promote current recording to a layer if changed (lazy finalization)
  fn promote_layer(&mut self) {
    if self.changed {
      // Finalize the current recording as a picture
      match self.current.finish_recording_as_picture() {
        Some(picture) => {
          self.push_layer(picture);
        }
        None => {
          // This can happen if the recording was empty or if there was an error
          #[cfg(debug_assertions)]
          eprintln!(
            "Warning: Failed to finalize recording as picture - recording may have been empty"
          );
        }
      }
      self.resume_recording();
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
    // A composite of `layers` alone cannot be complete while a direct
    // surface write is unrebased: the write bypassed the recording. Caller
    // (Context::get_picture) materializes the rebase snapshot; a defensive
    // None here keeps any other path from vending a partial picture.
    if self.surface_dirty {
      return None;
    }
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
    // pending_bytes is NOT reset here: replay does not release the layers'
    // memory. Only consolidate_with_snapshot (which replaces them with one
    // snapshot picture) and reset() may clear the charge; resetting here
    // would erase the accounting while the memory persists.
    //
    // An over-cap pending_bytes with <= 1 layer cannot livelock: the next
    // recorded op sets changed=true, so the retried flush promotes it to a
    // second layer and consolidation proceeds; layers > 1 always means
    // consolidation was possible (its failure retries instead of forgetting).
  }

  /// Returns whether layers should be consolidated to prevent memory buildup.
  /// A single oversized layer (e.g. one large putImageData) consolidates too:
  /// flush() plays every pending layer to the surface before this runs, so
  /// the snapshot is equivalent to the layer it replaces.
  pub fn should_consolidate(&self) -> bool {
    self.layers.len() > 1 || (self.layers.len() == 1 && self.recording_limit_exceeded())
  }

  /// Replace all accumulated layers with a single picture that draws the given
  /// surface snapshot. This bounds memory to O(canvas_size) instead of
  /// O(total_draw_commands), preventing unbounded growth when a canvas is
  /// repeatedly drawn via drawImage().
  pub fn consolidate_with_snapshot(&mut self, image: SkImage) {
    let mut compositor = PictureRecorder::new();
    compositor.begin_recording(0.0, 0.0, self.width, self.height);
    let Some(canvas) = compositor.get_recording_canvas() else {
      return;
    };
    image.draw(canvas, 0.0, 0.0, FilterQuality::Low);
    if let Some(picture) = compositor.finish_recording_as_picture() {
      self.layers.clear();
      self.layers.push(picture);
      self.depth = 1;
      self.cached_picture = None;
      self.layers_at_cache = 0;
      self.pending_bytes = 0;
      // The snapshot picture retains the passed raster (~width*height*4);
      // approx_bytes_used on a composited picture cannot see it, so it joins
      // the raster-byte tally a drawCanvas destination is charged with.
      self.raster_bytes = self.width as usize * self.height as usize * 4;
      // The layers that pinned the deduped rasters are gone; future ops
      // re-charge shared sources under the new window.
      self.retained_rasters.clear();
      // The snapshot rebase makes `layers` a complete picture again.
      self.surface_dirty = false;
    }
  }

  /// Reset recorder (on canvas resize or explicit clear)
  pub fn reset(&mut self, width: f32, height: f32) {
    self.layers.clear();
    self.width = width;
    self.height = height;
    // Discard the pending recording without finishing it:
    // finishRecordingAsPicture would optimize and bound every queued op for
    // a picture that is dropped anyway, and beginning a new recording
    // without ending the previous one would reuse its SkRecord, leaking its
    // ops (e.g. a state-restore transform) into the fresh record.
    self.current = PictureRecorder::new();
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
    self.pending_bytes = 0;
    self.raster_bytes = 0;
    self.retained_rasters.clear();
    self.surface_dirty = false;
    // Discard also bumps the generation: callers pair reset() with a
    // surface.canvas.clear() (full-canvas clearRect fast path, Context::reset),
    // which copy-on-writes the backing pixels. A dest recording holding a
    // pre-clear snapshot must not dedup the next draw against the cleared
    // raster under the old (id, version) key.
    self.content_version += 1;
    // Reset transform and clip state
    self.current_transform = None;
    self.current_clip = None;
    // Reset save count
    self.save_count = 0;
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
  ///
  /// `pixel_bytes` is the exact size of the pinned pixel copy: the recorded
  /// draw holds a snapshot (`snapshot=true` at the call sites) that keeps the
  /// whole ImageData buffer alive until the layer is consolidated.
  pub fn put_pixels<F>(&mut self, pixel_bytes: usize, f: F)
  where
    F: FnOnce(&mut Canvas),
  {
    // Step 1: Always end the current recording before starting the
    // pixel-data record. SkPictureRecorder reuses the same SkRecord until
    // finishRecordingAsPicture moves it out, so beginning without ending the
    // previous recording would append the pixel draw after the state-restore
    // ops (transform/clip) that resume_recording emitted into it — the draw
    // would inherit the current transform/clip, which putImageData must
    // ignore per the HTML spec.
    if self.changed {
      if let Some(picture) = self.current.finish_recording_as_picture() {
        self.push_layer(picture);
      }
    } else {
      // Nothing was drawn: the record holds only resume_recording's
      // state-restore ops. Discard the recorder instead of finishing it —
      // finishing would optimize and bound every queued op for a picture
      // that is dropped anyway.
      self.current = PictureRecorder::new();
    }
    self.changed = false;

    // Step 2: Fresh recording for pixel data (clean canvas: no clip, identity transform)
    self
      .current
      .begin_recording(0.0, 0.0, self.width, self.height);
    if let Some(canvas) = self.current.get_recording_canvas() {
      f(canvas);
    }

    // Step 3: Promote the pixel data recording as a layer
    if let Some(picture) = self.current.finish_recording_as_picture() {
      self.push_layer(picture);
    }

    // Step 4: Start new recording and restore state
    self.resume_recording();
    self.content_version += 1;
    self.account_raster_bytes(pixel_bytes);
  }

  /// Get recording canvas for direct access (needed for SVG/PDF direct mode)
  ///
  /// Deliberately does NOT bump content_version: this funnel serves both
  /// pixel commits (via render_passes) and pure state ops (save/restore,
  /// set_transform, clip through with_canvas_state), and the generation must
  /// only advance when an op can alter pixels -- otherwise a canvas source
  /// that merely calls save()/restore() between drawImage reads draws under
  /// a fresh dedup key each time and re-pays the raster charge.
  pub fn get_recording_canvas(&mut self) -> Option<&mut Canvas> {
    self.changed = true;
    self.pending_bytes += BYTES_PER_RECORDED_OP;
    self.current.get_recording_canvas()
  }

  /// Bump the content generation for a recorded op that can alter pixels --
  /// the draw funnels (render_passes) call this once the op is committed.
  /// State-only records (save/restore/transform/clip) must not reach here.
  /// Direct surface writes use note_direct_mutation instead.
  pub(crate) fn note_paint_op(&mut self) {
    self.content_version += 1;
  }

  /// Charge recorded bytes that the per-op base estimate cannot see, e.g. a
  /// drawn path's point data or a nested picture's record.
  pub fn account_recorded_bytes(&mut self, bytes: usize) {
    self.pending_bytes += bytes;
  }

  /// Charge bytes that also retain payload a picture's approximateBytesUsed
  /// cannot see (pixels, typefaces). Those payloads cross to a drawCanvas
  /// destination intact, so they are tallied separately: a source's
  /// raster_bytes is charged to the destination on every drawCanvas.
  pub fn account_raster_bytes(&mut self, bytes: usize) {
    self.pending_bytes += bytes;
    self.raster_bytes += bytes;
  }

  /// Same charge, but once per resource identity per window: a recorded op
  /// holds a shared reference, so N draws of one source pin `bytes` once, not
  /// N times. Keys are valid only while the recorded layers pin them, which
  /// is why the set clears on consolidate/reset. Zero-byte resources are
  /// skipped: nothing is pinned, so there is nothing to dedup and no key to
  /// waste a slot on.
  pub fn account_raster_resource(&mut self, key: RasterKey, bytes: usize) {
    if bytes == 0 {
      return;
    }
    if self.retained_rasters.insert(key) {
      self.account_raster_bytes(bytes);
    }
  }

  /// Current content generation; bumps on every recorded mutation. Part of
  /// the drawImage dedup key for canvas sources -- see retained_rasters.
  pub fn content_version(&self) -> u64 {
    self.content_version
  }

  /// Bump the content generation for a mutation that bypassed the recording
  /// (a direct write to the surface, e.g. a Lottie frame or the
  /// `alpha: false` base fill). The written pixels COW the surface raster
  /// exactly like a recorded op does, so an unchanged generation would let a
  /// dest dedup key alias the new raster under the old charge.
  pub(crate) fn note_direct_mutation(&mut self) {
    self.content_version += 1;
  }

  /// Record that a direct surface write (lottie frame, alpha:false base
  /// fill) bypassed the recording. Only valid right after flush(), which
  /// already replayed every layer onto the surface: their content lives on
  /// in the pixels, so the stale layers are dropped WITHOUT a snapshot.
  /// With nothing retaining the surface raster, the next direct write
  /// proceeds in place instead of copy-on-writing the whole canvas per
  /// frame. Until a rebase snapshot materializes (Context::get_picture),
  /// `layers` hold only post-write content and get_picture() reports None.
  pub(crate) fn note_surface_write(&mut self) {
    self.layers.clear();
    self.depth = 0;
    self.cached_picture = None;
    self.layers_at_cache = 0;
    self.pending_bytes = 0;
    self.raster_bytes = 0;
    self.retained_rasters.clear();
    self.surface_dirty = true;
  }

  /// Whether an unrebased direct surface write leaves `layers` incomplete.
  /// See surface_dirty.
  pub(crate) fn surface_dirty(&self) -> bool {
    self.surface_dirty
  }

  /// Whether the pending recording has grown past MAX_RECORDED_BYTES and
  /// should be flushed. See Context::flush_if_recording_limit_exceeded.
  pub fn recording_limit_exceeded(&self) -> bool {
    self.pending_bytes >= MAX_RECORDED_BYTES
  }

  /// Bytes of approx_bytes_used-invisible payload this recorder's pictures
  /// still retain: pinned pixel copies, recorded typeface refs, and the
  /// consolidated snapshot raster. drawCanvas charges the destination for it
  /// because SkPicture::approximateBytesUsed excludes referenced images
  /// (skia/include/core/SkPicture.h). Vector-record bytes are excluded on
  /// purpose -- the destination's drawPicture charge covers those.
  pub fn retained_raster_bytes(&self) -> usize {
    self.raster_bytes
  }
}
