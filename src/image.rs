use std::{borrow::Cow, ptr, str, str::FromStr};

use base64_simd::STANDARD;
use napi::{JsString, JsStringUtf8, ScopedTask, bindgen_prelude::*};

use crate::avif::AvifImage;
use crate::error::SkError;
use crate::global_fonts::get_font;
use crate::sk::{AlphaType, Bitmap, ColorSpace, ColorType};

#[napi]
pub struct ImageData {
  pub(crate) width: usize,
  pub(crate) height: usize,
  pub(crate) color_space: ColorSpace,
  pub(crate) data: *mut u8,
}

#[napi(object)]
pub struct Settings {
  pub color_space: String,
}

#[napi]
impl ImageData {
  #[napi(constructor)]
  pub fn new(
    env: Env,
    mut this: This,
    width_or_data: Either4<u32, Uint8ClampedArray, Uint16Array, Float32Array>,
    width_or_height: u32,
    height_or_settings: Option<Either<u32, Settings>>,
    maybe_settings: Option<Settings>,
  ) -> Result<Self> {
    match width_or_data {
      Either4::A(width) => {
        let height = width_or_height;
        let color_space = match height_or_settings {
          Some(Either::B(settings)) => {
            ColorSpace::from_str(&settings.color_space).unwrap_or_default()
          }
          _ => ColorSpace::default(),
        };
        let arraybuffer_length = (width * height * 4) as usize;
        let mut data_buffer = vec![0; arraybuffer_length];
        let data_ptr = data_buffer.as_mut_ptr();
        let data_object = Uint8ClampedSlice::from_data(&env, data_buffer)?;
        this.define_properties(&[Property::new()
          .with_utf8_name("data")?
          .with_value(&data_object)
          .with_property_attributes(
            PropertyAttributes::Enumerable | PropertyAttributes::Configurable,
          )])?;
        Ok(ImageData {
          width: width as usize,
          height: height as usize,
          color_space,
          data: data_ptr,
        })
      }
      Either4::B(data_object) => {
        // Uint8ClampedArray - each pixel takes 4 bytes
        let input_data_length = data_object.len();
        let width = width_or_height;
        let height = match &height_or_settings {
          Some(Either::A(height)) => *height,
          _ => (input_data_length as u32) / 4 / width,
        };
        if height * width * 4 != data_object.len() as u32 {
          return Err(Error::new(
            Status::InvalidArg,
            "Index or size is negative or greater than the allowed amount".to_owned(),
          ));
        }
        // https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/createImageData
        // An existing ImageData object from which to copy the width and height.
        let mut cloned_data = Uint8ClampedSlice::from_data(&env, data_object.to_vec())?;
        let data = unsafe { cloned_data.as_mut() }.as_mut_ptr();
        this.define_properties(&[Property::new()
          .with_utf8_name("data")?
          .with_value(&cloned_data)
          .with_property_attributes(
            PropertyAttributes::Enumerable | PropertyAttributes::Configurable,
          )])?;
        let color_space = maybe_settings
          .and_then(|settings| ColorSpace::from_str(&settings.color_space).ok())
          .unwrap_or_default();
        Ok(ImageData {
          width: width as usize,
          height: height as usize,
          color_space,
          data,
        })
      }
      Either4::C(data_object) => {
        // Uint16Array - each pixel takes 4 elements (RGBA), 2 bytes per element
        let input_data_length = data_object.len();
        let width = width_or_height;
        let height = match &height_or_settings {
          Some(Either::A(height)) => *height,
          _ => (input_data_length as u32) / 4 / width,
        };
        if height * width * 4 != data_object.len() as u32 {
          return Err(Error::new(
            Status::InvalidArg,
            "Index or size is negative or greater than the allowed amount".to_owned(),
          ));
        }
        // Convert Uint16Array to Uint8ClampedArray
        let mut u8_data = vec![0u8; width as usize * height as usize * 4];
        for (i, &val) in data_object.as_ref().iter().enumerate() {
          // Convert from 16-bit (0-65535) to 8-bit (0-255)
          u8_data[i] = ((val as u32 * 255 + 32767) / 65535) as u8;
        }
        let mut cloned_data = Uint8ClampedSlice::from_data(&env, u8_data)?;
        let data = unsafe { cloned_data.as_mut() }.as_mut_ptr();
        this.define_properties(&[Property::new()
          .with_utf8_name("data")?
          .with_value(&cloned_data)
          .with_property_attributes(
            PropertyAttributes::Enumerable | PropertyAttributes::Configurable,
          )])?;
        let color_space = maybe_settings
          .and_then(|settings| ColorSpace::from_str(&settings.color_space).ok())
          .unwrap_or_default();
        Ok(ImageData {
          width: width as usize,
          height: height as usize,
          color_space,
          data,
        })
      }
      Either4::D(data_object) => {
        // Float32Array - each pixel takes 4 elements (RGBA), 4 bytes per element
        let input_data_length = data_object.len();
        let width = width_or_height;
        let height = match &height_or_settings {
          Some(Either::A(height)) => *height,
          _ => (input_data_length as u32) / 4 / width,
        };
        if height * width * 4 != data_object.len() as u32 {
          return Err(Error::new(
            Status::InvalidArg,
            "Index or size is negative or greater than the allowed amount".to_owned(),
          ));
        }
        // Convert Float32Array to Uint8ClampedArray
        let mut u8_data = vec![0u8; width as usize * height as usize * 4];
        for (i, &val) in data_object.as_ref().iter().enumerate() {
          // Clamp float values to [0.0, 1.0] and convert to 8-bit (0-255)
          let clamped = val.clamp(0.0, 1.0);
          u8_data[i] = (clamped * 255.0).round() as u8;
        }
        let mut cloned_data = Uint8ClampedSlice::from_data(&env, u8_data)?;
        let data = unsafe { cloned_data.as_mut() }.as_mut_ptr();
        this.define_properties(&[Property::new()
          .with_utf8_name("data")?
          .with_value(&cloned_data)
          .with_property_attributes(
            PropertyAttributes::Enumerable | PropertyAttributes::Configurable,
          )])?;
        let color_space = maybe_settings
          .and_then(|settings| ColorSpace::from_str(&settings.color_space).ok())
          .unwrap_or_default();
        Ok(ImageData {
          width: width as usize,
          height: height as usize,
          color_space,
          data,
        })
      }
    }
  }

  #[napi(getter)]
  pub fn get_width(&self) -> u32 {
    self.width as u32
  }

  #[napi(getter)]
  pub fn get_height(&self) -> u32 {
    self.height as u32
  }
}

#[napi(custom_finalize)]
pub struct Image {
  pub(crate) bitmap: Option<Bitmap>,
  pub(crate) complete: bool,
  pub(crate) alt: String,
  pub(crate) current_src: Option<String>,
  width: f64,
  height: f64,
  // Natural dimensions - extracted from image header, available before full decode
  natural_width: f64,
  natural_height: f64,
  pub(crate) need_regenerate_bitmap: bool,
  pub(crate) is_svg: bool,
  pub(crate) color_space: ColorSpace,
  pub(crate) src: Option<Either<Uint8Array, String>>,
  // read data from file path
  file_content: Option<Vec<u8>>,
  // take ownership of avif image, let it be dropped when image is dropped
  _avif_image_ref: Option<AvifImage>,
  // Bytes accounted to V8 via adjust_external_memory for this image
  accounted_bytes: i64,
  // Generation counter to handle overlapping loads
  load_generation: u64,

  decoder_task: Option<ObjectRef>,
}

impl ObjectFinalize for Image {
  fn finalize(self, env: Env) -> Result<()> {
    if self.accounted_bytes != 0 {
      env.adjust_external_memory(-self.accounted_bytes)?;
    }
    if let Some(decoder_task) = self.decoder_task {
      decoder_task.unref(&env)?;
    }
    Ok(())
  }
}

#[napi]
impl Image {
  #[napi(constructor)]
  pub fn new(width: Option<f64>, height: Option<f64>, color_space: Option<String>) -> Result<Self> {
    let width = width.unwrap_or(-1.0);
    let height = height.unwrap_or(-1.0);
    let color_space = color_space
      .and_then(|c| ColorSpace::from_str(&c).ok())
      .unwrap_or_default();
    Ok(Image {
      complete: true,
      bitmap: None,
      alt: "".to_string(),
      current_src: None,
      width,
      height,
      natural_width: 0.0,
      natural_height: 0.0,
      need_regenerate_bitmap: false,
      is_svg: false,
      color_space,
      src: None,
      file_content: None,
      _avif_image_ref: None,
      accounted_bytes: 0,
      load_generation: 0,
      decoder_task: None,
    })
  }

  #[napi(getter)]
  pub fn get_width(&self) -> f64 {
    if self.width >= 0.0 { self.width } else { 0.0 }
  }

  #[napi(setter)]
  pub fn set_width(&mut self, width: f64) {
    if (width - self.width).abs() > f64::EPSILON {
      self.width = width;
      self.need_regenerate_bitmap = true;
    }
  }

  #[napi(getter)]
  pub fn get_natural_width(&self) -> f64 {
    // Return stored natural_width (set from imagesize header parsing)
    // Falls back to bitmap dimensions if natural_width not set
    if self.natural_width > 0.0 {
      self.natural_width
    } else {
      self.bitmap.as_ref().map(|b| b.0.width).unwrap_or(0) as f64
    }
  }

  #[napi(getter)]
  pub fn get_height(&self) -> f64 {
    if self.height >= 0.0 { self.height } else { 0.0 }
  }

  #[napi(setter)]
  pub fn set_height(&mut self, height: f64) {
    if (height - self.height).abs() > f64::EPSILON {
      self.height = height;
      self.need_regenerate_bitmap = true;
    }
  }

  #[napi(getter)]
  pub fn get_natural_height(&self) -> f64 {
    // Return stored natural_height (set from imagesize header parsing)
    // Falls back to bitmap dimensions if natural_height not set
    if self.natural_height > 0.0 {
      self.natural_height
    } else {
      self.bitmap.as_ref().map(|b| b.0.height).unwrap_or(0) as f64
    }
  }

  #[napi(getter)]
  pub fn get_complete(&self) -> bool {
    self.complete
  }

  #[napi(getter)]
  pub fn get_current_src(&self) -> Option<&str> {
    self.current_src.as_deref()
  }

  #[napi(getter)]
  pub fn get_alt(&self) -> String {
    self.alt.clone()
  }

  #[napi(setter)]
  pub fn set_alt(&mut self, alt: String) {
    self.alt = alt;
  }

  #[napi(getter)]
  pub fn get_src(&mut self) -> Option<Either<&mut Uint8Array, &str>> {
    match self.src.as_mut() {
      Some(Either::A(d)) => Some(Either::A(d)),
      Some(Either::B(s)) => Some(Either::B(s.as_str())),
      None => None,
    }
  }

  #[napi(setter)]
  pub fn set_src(&mut self, env: Env, this: This, raw_data: Unknown) -> Result<()> {
    let data = match raw_data.get_type()? {
      ValueType::Object => {
        if raw_data.is_buffer()? || raw_data.is_typedarray()? {
          let data: Uint8Array = unsafe { raw_data.cast() }?;
          self.src.insert(Either::A(data))
        } else {
          return Ok(());
        }
      }
      ValueType::String => {
        let string = unsafe { raw_data.cast()? };
        self.src.insert(Either::B(string))
      }
      _ => return Ok(()),
    };
    // Increment generation FIRST to invalidate all in-flight loads
    // This must happen for BOTH empty and valid src to prevent race conditions
    self.load_generation = self.load_generation.wrapping_add(1);

    // Check if src is empty (per HTML spec)
    // Also treat very small buffers as empty to avoid invalid/ambiguous image headers.
    let is_empty_or_too_small = match &data {
      Either::A(buffer) => buffer.is_empty() || buffer.len() < 5,
      Either::B(string) => string.is_empty(),
    };

    if is_empty_or_too_small {
      // HTML spec: empty src = clear state, complete=true, NO events
      self.src = None;
      self.current_src = None;
      self.width = -1.0;
      self.height = -1.0;
      self.natural_width = 0.0;
      self.natural_height = 0.0;
      self.bitmap = None;
      self.file_content = None;
      self._avif_image_ref = None;
      self.complete = true;
      self.is_svg = false;
      self.need_regenerate_bitmap = false;

      // Clear decoder_task so decode() returns fresh resolved promise
      if let Some(previous_task) = self.decoder_task.take() {
        previous_task.unref(&env)?;
      }

      // Clear external memory accounting
      if self.accounted_bytes != 0 {
        env.adjust_external_memory(-self.accounted_bytes)?;
        self.accounted_bytes = 0;
      }
      return Ok(());
    }

    // For Buffer: load synchronously (dimensions + events), decode bitmap synchronously
    // This matches node-canvas behavior where onerror/onload fire synchronously
    if let Either::A(buffer) = data {
      let buffer_data = buffer.as_ref();
      let length = buffer_data.len();

      // Check if it's SVG (imagesize doesn't support SVG)
      let is_svg = is_svg_image(buffer_data, length);
      // Try to extract dimensions from image header using imagesize (fast, no full decode)
      let (img_width, img_height, is_valid_image) = if is_svg {
        // For SVG, we'll get dimensions after decode; for invalid images, we'll error
        (0.0, 0.0, false)
      } else if let Ok(size) = imagesize::blob_size(buffer_data) {
        (size.width as f64, size.height as f64, true)
      } else {
        (0.0, 0.0, false)
      };

      if is_valid_image || is_svg {
        // Set natural dimensions (sync, from header)
        // For SVG (where imagesize fails), leave at 0 - will be set after decode
        self.natural_width = img_width;
        self.natural_height = img_height;

        // Set width/height if not explicitly set (auto sizing)
        // For SVG, keep at -1.0 to signal that we need auto-sizing after decode
        if is_valid_image {
          if (self.width - -1.0).abs() < f64::EPSILON {
            self.width = img_width;
          }
          if (self.height - -1.0).abs() < f64::EPSILON {
            self.height = img_height;
          }
        }

        // For SVG, we need to decode synchronously to get dimensions
        if is_svg {
          let font = get_font().map_err(SkError::from)?;
          if (self.width - -1.0).abs() > f64::EPSILON && (self.height - -1.0).abs() > f64::EPSILON {
            if let Some(bitmap) = Bitmap::from_svg_data_with_custom_size(
              buffer_data.as_ptr(),
              length,
              self.width as f32,
              self.height as f32,
              self.color_space,
              &font,
            ) {
              self.is_svg = true;
              self.natural_width = bitmap.0.width as f64;
              self.natural_height = bitmap.0.height as f64;
              let new_bytes = (bitmap.0.width as i64) * (bitmap.0.height as i64) * 4;
              self.adjust_external_memory_if_need(&env, new_bytes)?;
              self.bitmap = Some(bitmap);
            } else {
              // Invalid SVG - fire onerror synchronously
              // Clear prior image state to prevent stale data from being drawn
              // Reset width/height to auto (-1.0) so getters return 0 for broken image
              self.complete = true;
              self.width = -1.0;
              self.height = -1.0;
              self.natural_width = 0.0;
              self.natural_height = 0.0;
              self.bitmap = None;
              self.file_content = None;
              self._avif_image_ref = None;
              self.is_svg = false;
              self.need_regenerate_bitmap = false;
              if self.accounted_bytes != 0 {
                env.adjust_external_memory(-self.accounted_bytes)?;
                self.accounted_bytes = 0;
              }

              let onerror = this.get_named_property_unchecked::<Unknown>("onerror")?;
              let error = env.create_error(Error::new(Status::InvalidArg, "Invalid SVG image"))?;
              if onerror.get_type()? == ValueType::Function {
                let onerror_func: Function<Object, Unknown> = Function::from_unknown(onerror)?;
                onerror_func.apply(this, error)?;
              }
              if let Some(previous_task) = self.decoder_task.replace(
                PromiseRaw::resolve(&env, error)?
                  .coerce_to_object()?
                  .create_ref()?,
              ) {
                previous_task.unref(&env)?;
              }
              return Ok(());
            }
          } else {
            // SVG without explicit dimensions - use default decode
            match Bitmap::from_svg_data(buffer_data.as_ptr(), length, self.color_space, &font) {
              Some(Ok(bitmap)) => {
                self.is_svg = true;
                self.natural_width = bitmap.0.width as f64;
                self.natural_height = bitmap.0.height as f64;
                self.width = bitmap.0.width as f64;
                self.height = bitmap.0.height as f64;
                let new_bytes = (bitmap.0.width as i64) * (bitmap.0.height as i64) * 4;
                self.adjust_external_memory_if_need(&env, new_bytes)?;
                self.bitmap = Some(bitmap);
              }
              Some(Err(_)) => {
                // Invalid SVG - fire onerror synchronously
                // Clear prior image state to prevent stale data from being drawn
                // Reset width/height to auto (-1.0) so getters return 0 for broken image
                self.complete = true;
                self.width = -1.0;
                self.height = -1.0;
                self.natural_width = 0.0;
                self.natural_height = 0.0;
                self.bitmap = None;
                self.file_content = None;
                self._avif_image_ref = None;
                self.is_svg = false;
                self.need_regenerate_bitmap = false;
                if self.accounted_bytes != 0 {
                  env.adjust_external_memory(-self.accounted_bytes)?;
                  self.accounted_bytes = 0;
                }

                let onerror = this.get_named_property_unchecked::<Unknown>("onerror")?;
                let error =
                  env.create_error(Error::new(Status::InvalidArg, "Invalid SVG image"))?;
                if onerror.get_type()? == ValueType::Function {
                  let onerror_func: Function<Object, Unknown> = Function::from_unknown(onerror)?;
                  onerror_func.apply(this, error)?;
                }
                if let Some(previous_task) = self.decoder_task.replace(
                  PromiseRaw::resolve(&env, error)?
                    .coerce_to_object()?
                    .create_ref()?,
                ) {
                  previous_task.unref(&env)?;
                }
                return Ok(());
              }
              None => {
                // SVG has no dimensions - valid but empty, still fire onload
                self.is_svg = true;
              }
            }
          }
        }

        // Set complete = true immediately for Buffer sources (jsdom compatibility).
        // NOTE: For non-SVG buffers, complete=true means dimensions are available from header
        // parsing, but bitmap decoding is still async. This differs from the HTML spec where
        // complete implies the image is fully decoded. Callers should either:
        // 1. Use the onload handler (fires after bitmap decode) before drawImage/createPattern
        // 2. Call await image.decode() before drawing
        // Calling drawImage while complete=true but before decode finishes will silently no-op.
        self.complete = true;

        // For non-SVG images, spawn async bitmap decoding task.
        // onload fires in resolve() after bitmap is decoded, so drawImage works in onload handler.
        if !is_svg {
          // Clear previous bitmap and related state to prevent stale renders during async decode.
          // Without this, drawImage could render the old image until the new decode completes.
          self.bitmap = None;
          self._avif_image_ref = None;
          self.file_content = None;
          self.is_svg = false;
          self.need_regenerate_bitmap = false;
          if self.accounted_bytes != 0 {
            env.adjust_external_memory(-self.accounted_bytes)?;
            self.accounted_bytes = 0;
          }

          let task = BitmapDecoder {
            width: self.width,
            height: self.height,
            this_ref: this.create_ref()?,
            generation: self.load_generation,
            color_space: self.color_space,
            data: Some(Either::A(unsafe { raw_data.cast()? })),
            file_content: None,
            fire_events: true, // Fire onload after decode completes
          };
          let decode_task = env.spawn(task)?;
          let promise_object = decode_task.promise_object();

          if let Some(previous_task) = self
            .decoder_task
            .replace(promise_object.coerce_to_object()?.create_ref()?)
          {
            previous_task.unref(&env)?;
          }
        } else {
          // For SVG: bitmap already decoded synchronously above, fire onload now
          self.current_src = Some("[Buffer]".to_string());

          // Set decoder_task to resolved promise so decode() works correctly
          if let Some(previous_task) = self.decoder_task.replace(
            PromiseRaw::resolve(&env, ())?
              .coerce_to_object()?
              .create_ref()?,
          ) {
            previous_task.unref(&env)?;
          }

          let onload = this.get_named_property_unchecked::<Unknown>("onload")?;
          if onload.get_type()? == ValueType::Function {
            let onload_func: Function<(), ()> = Function::from_unknown(onload)?;
            onload_func.apply(this, ())?;
          }
        }

        return Ok(());
      } else {
        // imagesize failed (format not supported by imagesize, e.g. BMP, ICO, TIFF)
        // Fall through to async decode - let Skia/infer determine validity.
        // NOTE: complete=true but dimensions are 0 until decode completes.
        // Same caveats apply as above: use onload or decode() before drawing.
        self.complete = true;

        // Clear previous state to avoid exposing stale data from previous loads.
        // Dimensions will be set by resolve() after successful decode.
        self.natural_width = 0.0;
        self.natural_height = 0.0;
        self.bitmap = None;
        self._avif_image_ref = None;
        self.file_content = None;
        self.is_svg = false;
        self.need_regenerate_bitmap = false;
        if self.accounted_bytes != 0 {
          env.adjust_external_memory(-self.accounted_bytes)?;
          self.accounted_bytes = 0;
        }

        let task = BitmapDecoder {
          width: self.width,
          height: self.height,
          this_ref: this.create_ref()?,
          generation: self.load_generation,
          color_space: self.color_space,
          data: Some(Either::A(unsafe { raw_data.cast()? })),
          file_content: None,
          fire_events: true,
        };
        let decode_task = env.spawn(task)?;
        let promise_object = decode_task.promise_object();

        if let Some(previous_task) = self
          .decoder_task
          .replace(promise_object.coerce_to_object()?.create_ref()?)
        {
          previous_task.unref(&env)?;
        }
        return Ok(());
      }
    }

    // Check if this is an HTTP/HTTPS URL - use fetch API instead of file read
    if let Either::B(url_string) = data
      && is_http_url(url_string)
    {
      self.complete = false;

      // Get global fetch function
      let global = env.get_global()?;
      let fetch_fn: Function<&str, Unknown> = global.get_named_property("fetch")?;

      // Store references for promise chain
      let url_clone = url_string.clone();
      // Create separate ObjectRefs for each callback - they will be unrefed properly
      let this_ref_then: ObjectRef<false> = this.create_ref()?;
      let this_ref_catch: ObjectRef<false> = this.create_ref()?;
      let generation = self.load_generation;
      let width = self.width;
      let height = self.height;
      let color_space = self.color_space;

      // Call fetch(url)
      let fetch_promise = fetch_fn.call(url_clone.as_str())?;

      // Chain promises: fetch -> response.arrayBuffer() -> decode
      let promise = PromiseRaw::from_unknown(fetch_promise)?
        .then(move |ctx: CallbackContext<Object>| {
          // Check response.ok
          let response = ctx.value;
          let ok: bool = response.get_named_property("ok")?;
          if !ok {
            let status: u32 = response.get_named_property("status")?;
            return Err(Error::new(
              Status::GenericFailure,
              format!("HTTP request failed with status {}", status),
            ));
          }
          // Call response.arrayBuffer()
          let array_buffer_method: Function<(), Unknown> =
            response.get_named_property("arrayBuffer")?;
          array_buffer_method.apply(response, ())
        })?
        .then(move |ctx: CallbackContext<Unknown>| {
          // Convert ArrayBuffer to Uint8Array using JavaScript constructor
          let global = ctx.env.get_global()?;
          let uint8array_ctor: Function<Unknown, Unknown> =
            global.get_named_property("Uint8Array")?;
          let buffer_unknown = uint8array_ctor.new_instance(ctx.value)?;
          let buffer: Uint8Array = unsafe { buffer_unknown.cast()? };

          // Get Image instance and verify generation
          let this: Object = this_ref_then.get_value(&ctx.env)?;
          // Unref this_ref_then after getting the value
          this_ref_then.unref(&ctx.env)?;

          let mut image_ptr = ptr::null_mut();
          unsafe {
            sys::napi_unwrap(ctx.env.raw(), this.raw(), &mut image_ptr);
          }
          let image = unsafe { &mut *image_ptr.cast::<Image>() };

          if generation != image.load_generation {
            // Stale load - return unit to skip
            return Ok(());
          }

          // Spawn BitmapDecoder with downloaded buffer
          let decoder = BitmapDecoder {
            width,
            height,
            color_space,
            data: Some(Either::A(buffer)),
            file_content: None,
            this_ref: this.create_ref()?,
            generation,
            fire_events: true,
          };
          ctx.env.spawn(decoder)?;
          Ok(())
        })?
        .catch(move |ctx: CallbackContext<Unknown>| {
          // Fire onerror event
          let this: Object = this_ref_catch.get_value(&ctx.env)?;
          // Unref this_ref_catch after getting the value
          this_ref_catch.unref(&ctx.env)?;

          // Get Image instance and update state
          let mut image_ptr = ptr::null_mut();
          unsafe {
            sys::napi_unwrap(ctx.env.raw(), this.raw(), &mut image_ptr);
          }
          let image = unsafe { &mut *image_ptr.cast::<Image>() };

          // Only update if this is still the current load
          if generation == image.load_generation {
            image.complete = true;
            image.width = -1.0;
            image.height = -1.0;
            image.natural_width = 0.0;
            image.natural_height = 0.0;
            image.bitmap = None;
            image.file_content = None;
            image._avif_image_ref = None;
            image.is_svg = false;
            image.need_regenerate_bitmap = false;
          }

          let onerror = this.get_named_property_unchecked::<Unknown>("onerror")?;
          if onerror.get_type()? == ValueType::Function {
            let onerror_func: Function<Object, Unknown> = Function::from_unknown(onerror)?;
            let error_msg: String = ctx
              .value
              .coerce_to_string()
              .and_then(|s: JsString| s.into_utf8())
              .and_then(|s: JsStringUtf8| s.into_owned())
              .unwrap_or_else(|_| "Network error".to_string());
            let error_obj = ctx
              .env
              .create_error(Error::new(Status::GenericFailure, error_msg))?;
            onerror_func.apply(this, error_obj)?;
          }
          Ok(())
        })?;

      // Store promise reference
      if let Some(previous_task) = self
        .decoder_task
        .replace(promise.coerce_to_object()?.create_ref()?)
      {
        previous_task.unref(&env)?;
      }
      return Ok(());
    }

    // For file path/URL: use existing async loading (complete = false until loaded)
    self.complete = false;

    // NOTE: current_src is NOT set here - only set in resolve() after successful load
    // On failure, it remains the last successful value (per HTML spec).

    let decoder = BitmapDecoder {
      width: self.width,
      height: self.height,
      color_space: self.color_space,
      data: Some(unsafe { raw_data.cast()? }),
      file_content: None,
      this_ref: this.create_ref()?,
      generation: self.load_generation,
      fire_events: true,
    };
    let task_output = env.spawn(decoder)?;
    let promise_object = task_output.promise_object();
    if let Some(previous_task) = self
      .decoder_task
      .replace(promise_object.coerce_to_object()?.create_ref()?)
    {
      previous_task.unref(&env)?;
    }
    Ok(())
  }

  #[napi(ts_return_type = "Promise<void>")]
  pub fn decode<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
    if let Some(promise_ref) = self.decoder_task.as_ref() {
      // Return the stored promise reference
      let promise = promise_ref.get_value(env)?;
      return PromiseRaw::resolve(env, promise)?
        .then(|ctx| {
          if ctx.value.is_error()? {
            ctx.env.throw(ctx.value)?;
          }
          Ok(ctx.value)
        })?
        .coerce_to_object();
    }

    PromiseRaw::resolve(env, ())?.coerce_to_object()
  }

  pub(crate) fn regenerate_bitmap_if_need(&mut self, env: &Env) -> Result<()> {
    if !self.need_regenerate_bitmap || !self.is_svg || self.src.is_none() {
      return Ok(());
    }

    if let Some(data) = self.file_content.as_deref() {
      let font = get_font().map_err(SkError::from)?;
      self.bitmap = Bitmap::from_svg_data_with_custom_size(
        data.as_ptr(),
        data.len(),
        self.width as f32,
        self.height as f32,
        self.color_space,
        &font,
      );
      if let Some(bmp) = &self.bitmap {
        let new_bytes = (bmp.0.width as i64) * (bmp.0.height as i64) * 4;
        self.adjust_external_memory_if_need(env, new_bytes)?;
      }
      self.need_regenerate_bitmap = false;
      return Ok(());
    }
    if let Some(data) = self.src.as_ref() {
      let font = get_font().map_err(SkError::from)?;
      self.bitmap = Bitmap::from_svg_data_with_custom_size(
        data.as_ref().as_ptr(),
        data.as_ref().len(),
        self.width as f32,
        self.height as f32,
        self.color_space,
        &font,
      );
      if let Some(bmp) = &self.bitmap {
        let new_bytes = (bmp.0.width as i64) * (bmp.0.height as i64) * 4;
        self.adjust_external_memory_if_need(env, new_bytes)?;
      }
      self.need_regenerate_bitmap = false;
    }
    Ok(())
  }

  fn adjust_external_memory_if_need(&mut self, env: &Env, new_bytes: i64) -> Result<()> {
    let delta = new_bytes - self.accounted_bytes;
    if delta != 0 {
      env.adjust_external_memory(delta)?;
      self.accounted_bytes = new_bytes;
    }
    Ok(())
  }
}

fn is_svg_image(data: &[u8], length: usize) -> bool {
  let mut is_svg = false;
  if length >= 11 {
    for i in 3..length {
      if '<' == data[i - 3] as char {
        match data[i - 2] as char {
          '?' | '!' => continue,
          's' => {
            is_svg = 'v' == data[i - 1] as char && 'g' == data[i] as char;
            break;
          }
          _ => {
            is_svg = false;
          }
        }
      }
    }
  }
  is_svg
}

fn is_http_url(s: &str) -> bool {
  s.starts_with("http://") || s.starts_with("https://")
}

pub(crate) struct DecodedBitmap {
  bitmap: DecodeStatus,
  width: f64,
  height: f64,
}

unsafe impl Send for DecodedBitmap {}

struct BitmapInfo {
  data: Bitmap,
  is_svg: bool,
  #[allow(dead_code)]
  decoded_image: Option<AvifImage>,
}

enum DecodeStatus {
  Ok(BitmapInfo),
  Empty,
  InvalidSvg,
  InvalidImage,
}

struct BitmapDecoder {
  width: f64,
  height: f64,
  color_space: ColorSpace,
  data: Option<Either<Uint8Array, String>>,
  // data from file path
  file_content: Option<Vec<u8>>,
  this_ref: ObjectRef,
  // Generation counter to detect stale loads
  generation: u64,
  // Whether to fire events in the Task resolve/reject
  // The `src = Buffer` fire events in the `set_src`, so it doesn't need to fire events in the Task resolve/reject
  fire_events: bool,
}

impl<'env> ScopedTask<'env> for BitmapDecoder {
  type Output = DecodedBitmap;
  type JsValue = Unknown<'env>;

  fn compute(&mut self) -> Result<Self::Output> {
    let data_ref = match self.data.as_ref() {
      Some(Either::A(data)) => Cow::Borrowed(data.as_ref()),
      Some(Either::B(path_or_svg)) => {
        if path_or_svg.starts_with("data:") {
          Cow::Borrowed(path_or_svg.as_bytes())
        } else {
          match std::fs::read(path_or_svg) {
            Ok(file_content) => {
              self.file_content = Some(file_content);
              Cow::Borrowed(self.file_content.as_ref().unwrap().as_ref())
            }
            Err(io_err) => {
              return Err(Error::new(
                Status::GenericFailure,
                format!("Failed to read {path_or_svg}: {io_err}"),
              ));
            }
          }
        }
      }
      None => {
        return Ok(DecodedBitmap {
          bitmap: DecodeStatus::Empty,
          width: self.width,
          height: self.height,
        });
      }
    };
    let length = data_ref.len();
    let mut width = self.width;
    let mut height = self.height;
    let bitmap = if data_ref.as_ref().starts_with(b"data:") {
      let data_str = str::from_utf8(&data_ref)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Decode data url failed {e}")))?;
      if let Some(base64_str) = data_str.split(',').next_back() {
        let image_binary = STANDARD
          .decode_to_vec(base64_str)
          .map_err(|e| Error::new(Status::InvalidArg, format!("Decode data url failed {e}")))?;
        if let Some(kind) = infer::get(&image_binary) {
          if kind.matcher_type() == infer::MatcherType::Image {
            DecodeStatus::Ok(BitmapInfo {
              data: Bitmap::from_buffer(image_binary.as_ptr().cast_mut(), image_binary.len()),
              is_svg: false,
              decoded_image: None,
            })
          } else {
            DecodeStatus::InvalidImage
          }
        } else {
          DecodeStatus::InvalidImage
        }
      } else {
        DecodeStatus::Empty
      }
    } else if libavif::is_avif(data_ref.as_ref()) {
      // Check AVIF first - infer::get() may not recognize AVIF format
      let avif_image = AvifImage::decode_from(data_ref.as_ref())
        .map_err(|e| Error::new(Status::InvalidArg, format!("Decode avif image failed {e}")))?;

      let bitmap = Bitmap::from_image_data(
        avif_image.data,
        avif_image.width as usize,
        avif_image.height as usize,
        avif_image.row_bytes as usize,
        (avif_image.row_bytes * avif_image.height) as usize,
        ColorType::RGBA8888,
        AlphaType::Premultiplied,
      );
      DecodeStatus::Ok(BitmapInfo {
        data: bitmap,
        is_svg: false,
        decoded_image: Some(avif_image),
      })
    } else if if let Some(kind) = infer::get(&data_ref) {
      kind.matcher_type() == infer::MatcherType::Image
    } else {
      false
    } {
      // Other image formats detected by infer (PNG, JPEG, GIF, WebP, etc.)
      DecodeStatus::Ok(BitmapInfo {
        data: Bitmap::from_buffer(data_ref.as_ptr().cast_mut(), length),
        is_svg: false,
        decoded_image: None,
      })
    } else if is_svg_image(&data_ref, length) {
      let font = get_font().map_err(SkError::from)?;
      if (self.width - -1.0).abs() > f64::EPSILON && (self.height - -1.0).abs() > f64::EPSILON {
        if let Some(bitmap) = Bitmap::from_svg_data_with_custom_size(
          data_ref.as_ptr(),
          length,
          self.width as f32,
          self.height as f32,
          self.color_space,
          &font,
        ) {
          DecodeStatus::Ok(BitmapInfo {
            data: bitmap,
            is_svg: true,
            decoded_image: None,
          })
        } else {
          DecodeStatus::InvalidSvg
        }
      } else if let Some(bitmap) =
        Bitmap::from_svg_data(data_ref.as_ptr(), length, self.color_space, &font)
      {
        if let Ok(bitmap) = bitmap {
          DecodeStatus::Ok(BitmapInfo {
            data: bitmap,
            is_svg: true,
            decoded_image: None,
          })
        } else {
          DecodeStatus::InvalidSvg
        }
      } else {
        DecodeStatus::Empty
      }
    } else {
      DecodeStatus::InvalidImage
    };

    if let DecodeStatus::Ok(ref b) = bitmap {
      if (self.width - -1.0).abs() < f64::EPSILON
        || (self.width - b.data.0.width as f64).abs() > f64::EPSILON
      {
        width = b.data.0.width as f64;
      }
      if (self.height - -1.0).abs() < f64::EPSILON
        || (self.height - b.data.0.height as f64).abs() > f64::EPSILON
      {
        height = b.data.0.height as f64;
      }
    }
    Ok(DecodedBitmap {
      bitmap,
      width,
      height,
    })
  }

  fn resolve(&mut self, env: &'env Env, output: Self::Output) -> Result<Self::JsValue> {
    let this: Object = self.this_ref.get_value(env)?;
    let mut image_ptr = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_unwrap(env.raw(), this.raw(), &mut image_ptr) },
      "Failed to unwrap Image from this"
    )?;
    let self_mut = unsafe { Box::leak(Box::from_raw(image_ptr.cast::<Image>())) };

    // Check if this load has been superseded by a newer load
    if self.generation != self_mut.load_generation {
      // This is a stale load - silently abort without updating state or firing events
      return ().into_unknown(env);
    }

    self_mut.complete = true;
    self_mut.bitmap = None;

    let mut err: Option<&str> = None;

    match output.bitmap {
      DecodeStatus::Ok(bitmap) => {
        // SUCCESS PATH: set dimensions, bitmap, currentSrc, file_content
        self_mut.width = output.width;
        self_mut.height = output.height;
        self_mut.natural_width = output.width;
        self_mut.natural_height = output.height;

        if let Some(data) = self.file_content.take() {
          self_mut.file_content = Some(data);
        }

        self_mut.src = self.data.take();
        // Update current_src based on what was actually loaded
        self_mut.current_src = match &self_mut.src {
          Some(Either::A(_)) => Some("[Buffer]".to_string()),
          Some(Either::B(s)) => Some(s.clone()),
          None => None,
        };
        self_mut.is_svg = bitmap.is_svg;
        self_mut.bitmap = Some(bitmap.data);
        self_mut._avif_image_ref = bitmap.decoded_image;
        let new_bytes = (output.width as i64) * (output.height as i64) * 4;
        let delta = new_bytes - self_mut.accounted_bytes;
        if delta != 0 {
          env.adjust_external_memory(delta)?;
          self_mut.accounted_bytes = new_bytes;
        }
      }
      DecodeStatus::Empty => {}
      DecodeStatus::InvalidSvg => {
        // ERROR PATH: clear state like reject() does
        // Reset width/height to auto (-1.0) so getters return 0 (from natural_width/height)
        self_mut.width = -1.0;
        self_mut.height = -1.0;
        self_mut.natural_width = 0.0;
        self_mut.natural_height = 0.0;
        self_mut.file_content = None;
        self_mut._avif_image_ref = None;
        self_mut.is_svg = false;
        self_mut.need_regenerate_bitmap = false;
        if self_mut.accounted_bytes != 0 {
          env.adjust_external_memory(-self_mut.accounted_bytes)?;
          self_mut.accounted_bytes = 0;
        }
        err = Some("Invalid SVG image");
      }
      DecodeStatus::InvalidImage => {
        // ERROR PATH: clear state like reject() does
        // Reset width/height to auto (-1.0) so getters return 0 (from natural_width/height)
        self_mut.width = -1.0;
        self_mut.height = -1.0;
        self_mut.natural_width = 0.0;
        self_mut.natural_height = 0.0;
        self_mut.file_content = None;
        self_mut._avif_image_ref = None;
        self_mut.is_svg = false;
        self_mut.need_regenerate_bitmap = false;
        if self_mut.accounted_bytes != 0 {
          env.adjust_external_memory(-self_mut.accounted_bytes)?;
          self_mut.accounted_bytes = 0;
        }
        err = Some("Unsupported image type");
      }
    }

    if let Some(err_str) = err.take() {
      let error = env.create_error(Error::new(Status::InvalidArg, err_str))?;
      if self.fire_events {
        let on_error = this.get_named_property_unchecked::<Unknown>("onerror")?;
        if on_error.get_type()? == ValueType::Function {
          let onerror_func: Function<Object, Unknown> = Function::from_unknown(on_error)?;
          onerror_func.apply(this, error)?;
        }
      }
      // Return error so decode() promise rejects (even when fire_events is false)
      return error.into_unknown(env);
    } else if self.fire_events {
      let onload = this.get_named_property_unchecked::<Unknown>("onload")?;
      if onload.get_type()? == ValueType::Function {
        let onload_func: Function<(), ()> = Function::from_unknown(onload)?;
        onload_func.apply(this, ())?;
      }
    }
    ().into_unknown(env)
  }

  fn reject(&mut self, env: &'env Env, err: Error) -> Result<Self::JsValue> {
    let this: Object = self.this_ref.get_value(env)?;
    let mut image_ptr = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_unwrap(env.raw(), this.raw(), &mut image_ptr) },
      "Failed to unwrap Image from this"
    )?;
    let image = unsafe { Box::leak(Box::from_raw(image_ptr.cast::<Image>())) };

    // Ignore stale errors from superseded loads
    if self.generation != image.load_generation {
      return ().into_unknown(env);
    }

    // Per HTML spec: complete must be true after load finishes, even on error (broken state)
    image.complete = true;
    // Clear decoded state so all dimension getters return 0 for broken image
    // Reset width/height to auto (-1.0) so getters return 0 (from natural_width/height)
    image.width = -1.0;
    image.height = -1.0;
    image.natural_width = 0.0;
    image.natural_height = 0.0;
    image.bitmap = None;
    image.file_content = None;
    image._avif_image_ref = None;
    image.is_svg = false;
    image.need_regenerate_bitmap = false;
    if image.accounted_bytes != 0 {
      env.adjust_external_memory(-image.accounted_bytes)?;
      image.accounted_bytes = 0;
    }

    if self.fire_events {
      let on_error = this.get_named_property_unchecked::<Unknown>("onerror")?;
      if on_error.get_type()? == ValueType::Function {
        let onerror_func: Function<Object, Unknown> = Function::from_unknown(on_error)?;
        onerror_func.apply(
          this,
          env.create_error(Error::new(err.status, err.reason.clone()))?,
        )?;
      }
    }

    Error::new(err.status, err.reason.clone()).into_unknown(env)
  }

  fn finally(self, env: Env) -> Result<()> {
    // Unref this_ref (used in resolve/reject paths)
    self.this_ref.unref(&env)?;
    Ok(())
  }
}
