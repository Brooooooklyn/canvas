use std::str;
use std::str::FromStr;

use base64::{engine::general_purpose::STANDARD, Engine};
use napi::{bindgen_prelude::*, NapiValue};

use crate::sk::Bitmap;
use crate::sk::ColorSpace;

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
    width_or_data: Either<u32, Uint8ClampedArray>,
    width_or_height: u32,
    height_or_settings: Option<Either<u32, Settings>>,
    maybe_settings: Option<Settings>,
  ) -> Result<Self> {
    match width_or_data {
      Either::A(width) => {
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
        let data_object = unsafe {
          Object::from_raw_unchecked(
            env.raw(),
            Uint8ClampedArray::to_napi_value(env.raw(), Uint8ClampedArray::new(data_buffer))?,
          )
        };
        this.define_properties(&[Property::new("data")?
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
      Either::B(data_object) => {
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
        let mut cloned_data = Uint8ClampedArray::new(data_object.to_vec());
        let data = cloned_data.as_mut_ptr();
        this.define_properties(&[Property::new("data")?
          .with_value(&unsafe {
            Object::from_raw_unchecked(
              env.raw(),
              Uint8ClampedArray::to_napi_value(env.raw(), cloned_data)?,
            )
          })
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

#[napi]
pub struct Image {
  pub(crate) bitmap: Option<Bitmap>,
  pub(crate) complete: bool,
  pub(crate) alt: String,
  width: f64,
  height: f64,
  pub(crate) need_regenerate_bitmap: bool,
  pub(crate) is_svg: bool,
  pub(crate) color_space: ColorSpace,
  pub(crate) src: Option<Buffer>,
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
      complete: false,
      bitmap: None,
      alt: "".to_string(),
      width,
      height,
      need_regenerate_bitmap: false,
      is_svg: false,
      color_space,
      src: None,
    })
  }

  #[napi(getter)]
  pub fn get_width(&self) -> f64 {
    if self.width >= 0.0 {
      self.width
    } else {
      0.0
    }
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
    self.bitmap.as_ref().map(|b| b.0.width).unwrap_or(0) as f64
  }

  #[napi(getter)]
  pub fn get_height(&self) -> f64 {
    if self.height >= 0.0 {
      self.height
    } else {
      0.0
    }
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
    self.bitmap.as_ref().map(|b| b.0.height).unwrap_or(0) as f64
  }

  #[napi(getter)]
  pub fn get_complete(&self) -> bool {
    self.complete
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
  pub fn get_src(&mut self) -> Option<&mut Buffer> {
    self.src.as_mut()
  }

  #[napi(setter)]
  pub fn set_src(&mut self, env: Env, this: This, data: Buffer) -> Result<()> {
    let length = data.len();
    if length <= 2 {
      self.src = Some(data);
      self.on_load(&this)?;
      return Ok(());
    }
    let data_ref: &[u8] = &data;
    self.complete = true;
    self.is_svg = false;
    let bitmap = if str::from_utf8(&data_ref[0..10]) == Ok("data:image") {
      let data_str = str::from_utf8(data_ref)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Decode data url failed {e}")))?;
      if let Some(base64_str) = data_str.split(',').last() {
        let image_binary = STANDARD
          .decode(base64_str)
          .map_err(|e| Error::new(Status::InvalidArg, format!("Decode data url failed {e}")))?;
        if let Some(kind) = infer::get(&image_binary) {
          if kind.matcher_type() == infer::MatcherType::Image {
            Some(Bitmap::from_buffer(
              image_binary.as_ptr() as *mut u8,
              image_binary.len(),
            ))
          } else {
            self.on_error(env, &this)?;
            None
          }
        } else {
          self.on_error(env, &this)?;
          None
        }
      } else {
        None
      }
    } else if let Some(kind) = infer::get(&data) && kind.matcher_type() == infer::MatcherType::Image {
      Some(Bitmap::from_buffer(data.as_ptr() as *mut u8, length))
    } else if self.is_svg_image(data_ref, length) {
      self.is_svg = true;
      if (self.width - -1.0).abs() > f64::EPSILON && (self.height - -1.0).abs() > f64::EPSILON {
        Bitmap::from_svg_data_with_custom_size(
          data.as_ptr(),
          length,
          self.width as f32,
          self.height as f32,
          self.color_space,
        )
      } else {
        Bitmap::from_svg_data(data.as_ptr(), length, self.color_space)
      }
    } else {
      self.on_error(env, &this)?;
      None
    };
    if let Some(ref b) = bitmap {
      if (self.width - -1.0).abs() < f64::EPSILON {
        self.width = b.0.width as f64;
      }
      if (self.height - -1.0).abs() < f64::EPSILON {
        self.height = b.0.height as f64;
      }
    }
    self.bitmap = bitmap;
    self.src = Some(data);
    self.on_load(&this)?;
    Ok(())
  }

  pub(crate) fn regenerate_bitmap_if_need(&mut self) {
    if !self.need_regenerate_bitmap || !self.is_svg || self.src.is_none() {
      return;
    }
    if let Some(data) = self.src.as_mut() {
      self.bitmap = Bitmap::from_svg_data_with_custom_size(
        data.as_ref().as_ptr(),
        data.as_ref().len(),
        self.width as f32,
        self.height as f32,
        self.color_space,
      );
    }
  }

  fn on_load(&self, this: &This) -> Result<()> {
    let onload = this.get_named_property_unchecked::<Unknown>("onload")?;
    if onload.get_type()? == ValueType::Function {
      let onload_func = unsafe { onload.cast::<JsFunction>() };
      onload_func.call_without_args(Some(this))?;
    }
    Ok(())
  }

  fn on_error(&self, env: Env, this: &This) -> Result<()> {
    let onerror = this.get_named_property_unchecked::<Unknown>("onerror")?;
    let err = Error::new(Status::InvalidArg, "Unsupported image type");
    if onerror.get_type()? == ValueType::Function {
      let onerror_func = unsafe { onerror.cast::<JsFunction>() };
      onerror_func.call(Some(this), &[JsError::from(err).into_unknown(env)])?;
      Ok(())
    } else {
      Err(err)
    }
  }

  fn is_svg_image(&self, data: &[u8], length: usize) -> bool {
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
}
