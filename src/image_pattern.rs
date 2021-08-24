use std::rc::Rc;

use napi::*;

use crate::ctx::{Context, ImageOrCanvas};
use crate::image::ImageData;
use crate::pattern::Pattern;
use crate::sk::*;

#[repr(u8)]
enum ImageKind {
  ImageData,
  Image,
  Canvas,
}

impl From<u32> for ImageKind {
  fn from(value: u32) -> Self {
    match value {
      0 => Self::ImageData,
      1 => Self::Image,
      2 => Self::Canvas,
      _ => Self::Image,
    }
  }
}

#[js_function(3)]
pub fn canvas_pattern_constructor(ctx: CallContext) -> Result<JsUndefined> {
  let image_or_data = ctx.get::<JsObject>(0)?;
  let repetition = ctx.get::<JsUnknown>(1)?;
  let image_kind: ImageKind = ctx.get::<JsNumber>(2)?.get_uint32()?.into();
  let mut this: JsObject = ctx.this_unchecked();
  let mut bitmap_to_finalize: Option<Rc<Bitmap>> = None;
  let bitmap = match image_kind {
    ImageKind::Image => {
      let native_object = ctx
        .env
        .unwrap::<ImageOrCanvas>(&image_or_data)?
        .get_image()
        .unwrap();
      if let Some(bitmap) = native_object.bitmap.as_ref() {
        bitmap.0.bitmap
      } else {
        return Err(Error::new(
          Status::GenericFailure,
          "Image has not completed".to_string(),
        ));
      }
    }
    ImageKind::Canvas => {
      let ctx_obj = image_or_data.get_named_property_unchecked::<JsObject>("ctx")?;
      let other_ctx = ctx.env.unwrap::<Context>(&ctx_obj)?;
      bitmap_to_finalize
        .insert(Rc::new(other_ctx.surface.get_bitmap()))
        .0
        .bitmap
    }
    ImageKind::ImageData => {
      let native_object = ctx.env.unwrap::<ImageData>(&image_or_data)?;
      let image_size = native_object.width * native_object.height * 4usize;
      let bitmap = Bitmap::from_image_data(
        native_object.data as *mut u8,
        native_object.width,
        native_object.height,
        native_object.width * 4usize,
        image_size,
        ColorType::RGBA8888,
        AlphaType::Unpremultiplied,
      );
      let bitmap_object = ctx.env.create_external(bitmap, Some(image_size as i64))?;
      let bitmap = ctx
        .env
        .get_value_external::<Bitmap>(&bitmap_object)?
        .0
        .bitmap;
      // wrap Bitmap to `this`, prevent it to be dropped
      this.set_named_property("_bitmap", bitmap_object)?;
      bitmap
    }
  };
  let (repeat_x, repeat_y) = match repetition.get_type()? {
    ValueType::Null => (TileMode::Repeat, TileMode::Repeat),
    ValueType::String => {
      let repetition_str = unsafe { repetition.cast::<JsString>() }.into_utf8()?;
      match repetition_str.as_str()? {
        "" | "repeat" => (TileMode::Repeat, TileMode::Repeat),
        "repeat-x" => (TileMode::Repeat, TileMode::Decal),
        "repeat-y" => (TileMode::Decal, TileMode::Repeat),
        "no-repeat" => (TileMode::Decal, TileMode::Decal),
        _ => {
          return Err(Error::new(
            Status::InvalidArg,
            format!("{} is not valid repetition rule", repetition_str.as_str()?),
          ))
        }
      }
    }
    _ => {
      return Err(Error::new(
        Status::InvalidArg,
        "Invalid type of image repetition".to_string(),
      ))
    }
  };
  ctx.env.wrap(
    &mut this,
    Pattern::Image(ImagePattern {
      transform: Transform::default(),
      bitmap,
      repeat_x,
      repeat_y,
      bitmap_to_finalize,
    }),
  )?;
  ctx.env.get_undefined()
}

#[js_function(1)]
pub fn set_transform(ctx: CallContext) -> Result<JsUndefined> {
  let this: JsObject = ctx.this_unchecked();
  let transform_object = ctx.get::<JsObject>(0)?;
  let a: f64 = transform_object
    .get_named_property::<JsNumber>("a")?
    .get_double()?;
  let b: f64 = transform_object
    .get_named_property::<JsNumber>("b")?
    .get_double()?;
  let c: f64 = transform_object
    .get_named_property::<JsNumber>("c")?
    .get_double()?;
  let d: f64 = transform_object
    .get_named_property::<JsNumber>("d")?
    .get_double()?;
  let e: f64 = transform_object
    .get_named_property::<JsNumber>("e")?
    .get_double()?;
  let f: f64 = transform_object
    .get_named_property::<JsNumber>("f")?
    .get_double()?;
  let transform = Transform::new(a as f32, b as f32, c as f32, d as f32, e as f32, f as f32);
  let pattern = ctx.env.unwrap::<Pattern>(&this)?;
  if let Pattern::Image(pattern) = pattern {
    pattern.transform = transform;
  }
  ctx.env.get_undefined()
}
