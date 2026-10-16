use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::{borrow::Cow, ptr, str, str::FromStr};

use napi::{JsString, JsStringUtf8, ScopedTask, bindgen_prelude::*};

use crate::avif::AvifImage;
use crate::data_url;
use crate::sk::{AccountedBitmap, AlphaType, Bitmap, ColorSpace, ColorType, try_zeroed_bytes};
use crate::svg_image::SvgImage;
use crate::webidl;

#[napi(custom_finalize)]
pub struct ImageData {
  pub(crate) width: usize,
  pub(crate) height: usize,
  pub(crate) color_space: ColorSpace,
  // Weak `napi_ref` (created with refcount 0) used to re-resolve the `data`
  // typed array's backing pointer per use. The array is kept alive by the
  // non-configurable `data` own property on the JS object — a strong
  // reference here would root it independently and make `id.data.owner = id`
  // cycles uncollectable.
  pub(crate) data_ref: Option<sys::napi_ref>,
}

/// Create a weak `napi_ref` for `value` (`initial_refcount = 0`).
/// `ObjectRef` cannot express this: its `unref` is `napi_delete_reference`,
/// and `create_ref` hardcodes a strong refcount of 1, so we call napi-sys
/// directly.
pub(crate) fn create_weak_ref(env: &Env, value: sys::napi_value) -> Result<sys::napi_ref> {
  let mut ref_ = ptr::null_mut();
  check_status!(
    unsafe { sys::napi_create_reference(env.raw(), value, 0, &mut ref_) },
    "Failed to create weak reference"
  )?;
  Ok(ref_)
}

impl ObjectFinalize for ImageData {
  fn finalize(self, env: Env) -> Result<()> {
    if let Some(data_ref) = self.data_ref {
      check_status!(
        unsafe { sys::napi_delete_reference(env.raw(), data_ref) },
        "delete Ref failed"
      )?;
    }
    Ok(())
  }
}

impl ImageData {
  /// Resolve the pinned `data` typed array's backing pointer. Returns an error
  /// instead of a stale pointer when the buffer has been detached
  /// (`ArrayBuffer.prototype.transfer`/`postMessage` transfer). The crate only
  /// enables napi5, so detach is detected via `napi_get_typedarray_info` rather
  /// than the napi7 `napi_is_detached_arraybuffer`: a detached buffer reports
  /// length 0 and a null/offset-only data pointer.
  pub(crate) fn resolve_pixels(&self, env: &Env) -> Result<*mut u8> {
    let data_ref = self.data_ref.ok_or_else(|| {
      Error::new(
        Status::GenericFailure,
        "ImageData pixel buffer reference is missing".to_owned(),
      )
    })?;
    let mut array = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env.raw(), data_ref, &mut array) },
      "Failed to get ImageData reference value"
    )?;
    // A null value means the weak referent was collected; surface it the same
    // way as a detached buffer.
    if array.is_null() {
      return Err(Error::new(
        Status::InvalidArg,
        "ImageData pixel buffer is detached".to_owned(),
      ));
    }
    let mut length = 0usize;
    let mut data = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_get_typedarray_info(
          env.raw(),
          array,
          ptr::null_mut(),
          &mut length,
          &mut data,
          ptr::null_mut(),
          ptr::null_mut(),
        )
      },
      "Failed to get ImageData typed array info"
    )?;
    if length < self.width * self.height * 4 || (length != 0 && data.is_null()) {
      return Err(Error::new(
        Status::InvalidArg,
        "ImageData pixel buffer is detached".to_owned(),
      ));
    }
    Ok(data.cast())
  }
}

// ImageData::ValidateAndCreate (core/html/canvas/image_data.cc:41-232), the
// checks every ImageData API runs, in this order:
//
//   validate_size         width, height, 4 * width * height
//   color space           webidl::ImageDataSettings::color_space
//   validate_data_length  the data forms of the constructor
//   alloc_data            the other forms
//
// getImageData runs its own checks first (base_rendering_context_2d.cc:353).

/// How a size whose `4 * width * height` does not fit in 32 bits is reported
/// (`context_2d_error_mode`, image_data.cc:87-108).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SizeErrors {
  /// The ImageData constructor: IndexSizeError.
  Constructor,
  /// createImageData and getImageData: RangeError.
  Context2D,
}

/// The most bytes Chrome gives ImageData data: it allocates them with
/// PartitionAlloc, which refuses more than `MaxDirectMapped()` = 2^31 - 2 MiB
/// (partition_alloc_constants.h:403), and AllocateAndValidateDataArray then
/// throws (image_data.cc:262).
pub(crate) const MAX_DATA_BYTES: usize = (1 << 31) - (1 << 21);

const SIZE_EXCEEDS: &str = "The requested image size exceeds the supported range.";

fn index_size_error(env: sys::napi_env, prefix: &str, msg: &str) -> Error {
  webidl::dom_exception(env, "IndexSizeError", &format!("{prefix}{msg}"))
}

/// RangeError "Out of memory at ImageData creation" (no period), the error of
/// a failed allocation and of getImageData's int overflow checks.
pub(crate) fn out_of_memory(env: sys::napi_env, prefix: &str) -> Error {
  webidl::context_range_error(env, prefix, "Out of memory at ImageData creation")
}

/// The size steps of ImageData::ValidateAndCreate (image_data.cc:55-110).
/// Returns `4 * width * height`, or 0 without a height.
pub(crate) fn validate_size(
  env: sys::napi_env,
  prefix: &str,
  width: u32,
  height: Option<u32>,
  errors: SizeErrors,
) -> Result<usize> {
  if width == 0 {
    return Err(index_size_error(
      env,
      prefix,
      "The source width is zero or not a number.",
    ));
  }
  if width > i32::MAX as u32 {
    return Err(index_size_error(env, prefix, SIZE_EXCEEDS));
  }
  if let Some(height) = height {
    if height == 0 {
      return Err(index_size_error(
        env,
        prefix,
        "The source height is zero or not a number.",
      ));
    }
    if height > i32::MAX as u32 {
      return Err(index_size_error(env, prefix, SIZE_EXCEEDS));
    }
  }
  // CheckedNumeric<unsigned>: 4, times width, times height.
  match 4u32
    .checked_mul(width)
    .and_then(|v| v.checked_mul(height.unwrap_or(0)))
  {
    Some(len) => Ok(len as usize),
    None => Err(match errors {
      SizeErrors::Constructor => index_size_error(env, prefix, SIZE_EXCEEDS),
      SizeErrors::Context2D => {
        webidl::context_range_error(env, prefix, "Out of memory at ImageData creation.")
      }
    }),
  }
}

/// The data length steps of ImageData::ValidateAndCreate
/// (image_data.cc:172-219) for `bytes` bytes of `element_size`-byte elements,
/// 4 per pixel. `width` passed [`validate_size`]. Returns the height.
pub(crate) fn validate_data_length(
  env: sys::napi_env,
  prefix: &str,
  width: u32,
  height: Option<u32>,
  bytes: usize,
  element_size: usize,
) -> Result<u32> {
  let Ok(bytes) = u32::try_from(bytes) else {
    return Err(webidl::dom_exception(
      env,
      "NotSupportedError",
      &format!("{prefix}The input data is too large. The maximum size is 4294967295."),
    ));
  };
  if bytes == 0 {
    return Err(webidl::dom_exception(
      env,
      "InvalidStateError",
      &format!("{prefix}The input data has zero elements."),
    ));
  }
  let elements = bytes / element_size as u32;
  if !elements.is_multiple_of(4) {
    return Err(webidl::dom_exception(
      env,
      "InvalidStateError",
      &format!("{prefix}The input data length is not a multiple of 4."),
    ));
  }
  let pixels = elements / 4;
  if !pixels.is_multiple_of(width) {
    return Err(index_size_error(
      env,
      prefix,
      "The input data length is not a multiple of (4 * width).",
    ));
  }
  let expected_height = pixels / width;
  match height {
    Some(height) if height != expected_height => Err(index_size_error(
      env,
      prefix,
      "The input data length is not equal to (4 * width * height).",
    )),
    _ => Ok(expected_height),
  }
}

/// AllocateAndValidateDataArray (image_data.cc:236-270): `len` zeroed bytes.
/// RangeError above Chrome's limit, or when the allocation fails, instead of
/// aborting the process.
pub(crate) fn alloc_data(env: sys::napi_env, prefix: &str, len: usize) -> Result<Vec<u8>> {
  if len > MAX_DATA_BYTES {
    return Err(out_of_memory(env, prefix));
  }
  try_zeroed_bytes(len).ok_or_else(|| out_of_memory(env, prefix))
}

impl ImageData {
  /// A zero-filled ImageData, as createImageData returns.
  pub(crate) fn new_zeroed<'a>(
    env: &'a Env,
    width: usize,
    height: usize,
    color_space: ColorSpace,
  ) -> Result<ClassInstance<'a, ImageData>> {
    let Some(length) = width.checked_mul(height).and_then(|v| v.checked_mul(4)) else {
      return Err(webidl::context_range_error(
        env.raw(),
        webidl::CREATE_IMAGE_DATA,
        "Out of memory at ImageData creation.",
      ));
    };
    let data = alloc_data(env.raw(), webidl::CREATE_IMAGE_DATA, length)?;
    let data_object = Uint8ClampedSlice::from_data(env, data)?;
    let mut instance = ImageData {
      width,
      height,
      color_space,
      data_ref: Some(create_weak_ref(env, data_object.raw())?),
    }
    .into_instance(env)?;
    instance.define_properties(&[Property::new()
      .with_utf8_name("data")?
      .with_value(&data_object)
      .with_property_attributes(PropertyAttributes::Enumerable)])?;
    Ok(instance)
  }
}

/// The types of ImageData data (image_data.idl `ImageDataArray`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum DataArrayType {
  Uint8Clamped,
  Float16,
  Float32,
}

impl DataArrayType {
  fn name(self) -> &'static str {
    match self {
      Self::Uint8Clamped => "Uint8ClampedArray",
      Self::Float16 => "Float16Array",
      Self::Float32 => "Float32Array",
    }
  }

  fn pixel_format(self) -> &'static str {
    match self {
      Self::Uint8Clamped => "rgba-unorm8",
      Self::Float16 => "rgba-float16",
      Self::Float32 => "rgba-float32",
    }
  }
}

/// `napi_float16_array` (js_native_api_types.h, Node 24.18 and later).
const NAPI_FLOAT16_ARRAY: sys::napi_typedarray_type = 11;

/// The data type of `value`, if it is ImageData data: V8's
/// IsUint8ClampedArray(), IsFloat16Array() or IsFloat32Array(), brand checks
/// that hold for subclasses and arrays from other realms, and that no
/// toStringTag can fake.
fn data_array_type(env: sys::napi_env, value: sys::napi_value) -> Result<Option<DataArrayType>> {
  let mut is_typedarray = false;
  check_status!(unsafe { sys::napi_is_typedarray(env, value, &mut is_typedarray) })?;
  if !is_typedarray {
    return Ok(None);
  }
  let mut array_type = -1;
  check_status!(unsafe {
    sys::napi_get_typedarray_info(
      env,
      value,
      &mut array_type,
      ptr::null_mut(),
      ptr::null_mut(),
      ptr::null_mut(),
      ptr::null_mut(),
    )
  })?;
  Ok(match array_type {
    sys::TypedarrayType::uint8_clamped_array => Some(DataArrayType::Uint8Clamped),
    sys::TypedarrayType::float32_array => Some(DataArrayType::Float32),
    NAPI_FLOAT16_ARRAY => Some(DataArrayType::Float16),
    // Node before 24.18 leaves the type unset for a Float16Array, the only
    // TypedArray kind it has no napi type for.
    -1 => Some(DataArrayType::Float16),
    _ => None,
  })
}

/// A boolean property of `object`; false when it is not a boolean.
fn boolean_property(
  env: sys::napi_env,
  object: sys::napi_value,
  key: &std::ffi::CStr,
) -> Result<bool> {
  let mut value = ptr::null_mut();
  check_status!(unsafe { sys::napi_get_named_property(env, object, key.as_ptr(), &mut value) })?;
  let mut result = false;
  Ok(unsafe { sys::napi_get_value_bool(env, value, &mut result) } == sys::Status::napi_ok && result)
}

/// The NotShared<T> conversion of ImageData data
/// (native_value_traits_buffer_sources.cc, image_data.idl has no
/// [AllowShared]): a TypeError for a SharedArrayBuffer or a resizable
/// ArrayBuffer, checked before sw is converted.
fn check_not_shared(
  env: sys::napi_env,
  data: sys::napi_value,
  array_type: DataArrayType,
) -> Result<()> {
  let mut buffer = ptr::null_mut();
  check_status!(unsafe {
    sys::napi_get_typedarray_info(
      env,
      data,
      ptr::null_mut(),
      ptr::null_mut(),
      ptr::null_mut(),
      &mut buffer,
      ptr::null_mut(),
    )
  })?;
  let error = |what: &str| {
    webidl::context_type_error(
      env,
      webidl::IMAGE_DATA_CONSTRUCTOR,
      &format!(
        "The provided {} value must not be {what}.",
        array_type.name()
      ),
    )
  };
  // V8's IsArrayBuffer(): false for a SharedArrayBuffer, growable or not.
  let mut is_arraybuffer = false;
  check_status!(unsafe { sys::napi_is_arraybuffer(env, buffer, &mut is_arraybuffer) })?;
  if !is_arraybuffer {
    return Err(error("shared"));
  }
  // Blink reads IsResizableByUserJavaScript(), false once the buffer is
  // detached; JS `resizable` stays true then.
  if boolean_property(env, buffer, c"resizable")? && !boolean_property(env, buffer, c"detached")? {
    return Err(error("resizable"));
  }
  Ok(())
}

/// The `ImageData` constructor index.js exports: a native function, so that it
/// sees `new.target` and the real argument count, which the class
/// constructor napi-rs makes cannot (v8_image_data.cc ConstructorCallback).
/// `construct(args, argc, newTarget)` builds the class with the 4 arguments
/// and a count marker.
// Only JS calls it: the lib test build registers no napi exports.
#[cfg_attr(test, allow(dead_code))]
#[napi(js_name = "_imageDataConstructor")]
pub fn image_data_constructor<'env>(
  env: &'env Env,
  construct: Unknown<'env>,
) -> Result<Unknown<'env>> {
  let raw = env.raw();
  let mut reference = ptr::null_mut();
  check_status!(unsafe { sys::napi_create_reference(raw, construct.raw(), 1, &mut reference) })?;
  let mut function = ptr::null_mut();
  check_status!(unsafe {
    sys::napi_create_function(
      raw,
      c"ImageData".as_ptr(),
      9,
      Some(construct_image_data),
      reference.cast(),
      &mut function,
    )
  })?;
  check_status!(unsafe {
    sys::napi_add_finalizer(
      raw,
      function,
      reference.cast(),
      Some(delete_reference),
      ptr::null_mut(),
      ptr::null_mut(),
    )
  })?;
  Ok(unsafe { Unknown::from_raw_unchecked(raw, function) })
}

unsafe extern "C" fn delete_reference(
  env: sys::napi_env,
  reference: *mut std::ffi::c_void,
  _hint: *mut std::ffi::c_void,
) {
  unsafe { sys::napi_delete_reference(env, reference.cast()) };
}

unsafe extern "C" fn construct_image_data(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> sys::napi_value {
  match construct_image_data_checked(env, info) {
    Ok(value) => value,
    Err(error) => {
      unsafe { JsError::from(error).throw_into(env) };
      ptr::null_mut()
    }
  }
}

fn construct_image_data_checked(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> Result<sys::napi_value> {
  let prefix = webidl::IMAGE_DATA_CONSTRUCTOR;
  let mut argc = 4;
  let mut argv = [ptr::null_mut(); 4];
  let mut reference = ptr::null_mut();
  check_status!(unsafe {
    sys::napi_get_cb_info(
      env,
      info,
      &mut argc,
      argv.as_mut_ptr(),
      ptr::null_mut(),
      &mut reference,
    )
  })?;
  let mut new_target = ptr::null_mut();
  check_status!(unsafe { sys::napi_get_new_target(env, info, &mut new_target) })?;
  if new_target.is_null() {
    return Err(webidl::context_type_error(
      env,
      prefix,
      "Please use the 'new' operator, this DOM object constructor cannot be called as a function.",
    ));
  }
  if argc < 2 {
    return Err(webidl::context_type_error(
      env,
      prefix,
      &format!("2 arguments required, but only {argc} present."),
    ));
  }
  let is_undefined =
    |value| webidl::type_of(env, value).map(|value_type| value_type == ValueType::Undefined);
  // Chrome's NonUndefinedArgumentLength looks at every argument; the class
  // gets only 4. When one after them is not undefined, sh is present: pass
  // 0, which converts as undefined does.
  if argc > 4 && is_undefined(argv[2])? && is_undefined(argv[3])? {
    let mut all = vec![ptr::null_mut(); argc];
    let mut all_argc = argc;
    check_status!(unsafe {
      sys::napi_get_cb_info(
        env,
        info,
        &mut all_argc,
        all.as_mut_ptr(),
        ptr::null_mut(),
        ptr::null_mut(),
      )
    })?;
    let mut present = false;
    for value in &all[4..] {
      present |= !is_undefined(*value)?;
    }
    if present {
      check_status!(unsafe { sys::napi_create_uint32(env, 0, &mut argv[2]) })?;
    }
  }
  let mut construct = ptr::null_mut();
  check_status!(unsafe { sys::napi_get_reference_value(env, reference.cast(), &mut construct) })?;
  let mut args = ptr::null_mut();
  check_status!(unsafe { sys::napi_create_array_with_length(env, 4, &mut args) })?;
  for (index, value) in argv.iter().enumerate() {
    check_status!(unsafe { sys::napi_set_element(env, args, index as u32, *value) })?;
  }
  let mut count = ptr::null_mut();
  check_status!(unsafe { sys::napi_create_uint32(env, argc as u32, &mut count) })?;
  let mut undefined = ptr::null_mut();
  check_status!(unsafe { sys::napi_get_undefined(env, &mut undefined) })?;
  let mut result = ptr::null_mut();
  check_status!(unsafe {
    sys::napi_call_function(
      env,
      undefined,
      construct,
      3,
      [args, count, new_target].as_ptr(),
      &mut result,
    )
  })?;
  Ok(result)
}

#[napi]
impl ImageData {
  /// `new ImageData(sw, sh, settings?)` or `new ImageData(data, sw, sh?,
  /// settings?)`, picked as Chrome's binding picks them
  /// (v8_image_data.cc ConstructorCallback): with data first (a brand check)
  /// the data form, else the size form, which takes at most 3 arguments.
  /// `argc` is an argument-count marker; see `webidl::Arguments::new`.
  #[napi(constructor)]
  pub fn new(
    env: Env,
    mut this: This,
    arg0: Unknown,
    arg1: Unknown,
    arg2: Unknown,
    arg3: Unknown,
    argc: Unknown,
  ) -> Result<Self> {
    let raw = env.raw();
    let prefix = webidl::IMAGE_DATA_CONSTRUCTOR;
    let args = webidl::Arguments::new(
      raw,
      vec![arg0.raw(), arg1.raw(), arg2.raw(), arg3.raw()],
      argc.raw(),
    )?;
    if args.len() < 2 {
      return Err(webidl::context_type_error(
        raw,
        prefix,
        &format!("2 arguments required, but only {} present.", args.len()),
      ));
    }
    if let Some(array_type) = data_array_type(raw, args.get(0)?)? {
      return Self::from_data(&env, &mut this, array_type, &args);
    }
    if args.len() > 3 {
      return Err(webidl::context_type_error(
        raw,
        prefix,
        "Overload resolution failed.",
      ));
    }
    let width = webidl::to_unsigned_long(raw, args.get(0)?, prefix)?;
    let height = webidl::to_unsigned_long(raw, args.get(1)?, prefix)?;
    let settings = if args.len() == 3 {
      webidl::ImageDataSettings::from_js(raw, Some(args.get(2)?), prefix)?
    } else {
      webidl::ImageDataSettings::default()
    };
    let length = validate_size(raw, prefix, width, Some(height), SizeErrors::Constructor)?;
    let color_space = settings.color_space(raw, prefix)?.unwrap_or_default();
    let data_object = Uint8ClampedSlice::from_data(&env, alloc_data(raw, prefix, length)?)?;
    this.define_properties(&[Property::new()
      .with_utf8_name("data")?
      .with_value(&data_object)
      // Enumerable only: non-writable/non-configurable so the array is
      // pinned by ordinary GC tracing for exactly the ImageData's lifetime.
      .with_property_attributes(PropertyAttributes::Enumerable)])?;
    Ok(ImageData {
      width: width as usize,
      height: height as usize,
      color_space,
      data_ref: Some(create_weak_ref(&env, data_object.raw())?),
    })
  }

  /// `new ImageData(data, sw, sh?, settings?)`: the data, sw, then sh and the
  /// settings only when an argument after sw is not undefined
  /// (v8_image_data.cc, NonUndefinedArgumentLength). Then the checks of
  /// ImageData::ValidateAndCreate: size, color space, data type against the
  /// pixel format, data length.
  fn from_data(
    env: &Env,
    this: &mut This,
    array_type: DataArrayType,
    args: &webidl::Arguments,
  ) -> Result<Self> {
    let raw = env.raw();
    let prefix = webidl::IMAGE_DATA_CONSTRUCTOR;
    let data = args.get(0)?;
    check_not_shared(raw, data, array_type)?;
    let width = webidl::to_unsigned_long(raw, args.get(1)?, prefix)?;
    let (height, settings) = if args.non_undefined_len() <= 2 {
      (None, webidl::ImageDataSettings::default())
    } else {
      // An undefined sh is 0 here.
      let height = webidl::to_unsigned_long(raw, args.get(2)?, prefix)?;
      let settings = webidl::ImageDataSettings::from_js(raw, Some(args.get(3)?), prefix)?;
      (Some(height), settings)
    };
    validate_size(raw, prefix, width, height, SizeErrors::Constructor)?;
    let color_space = settings.color_space(raw, prefix)?.unwrap_or_default();
    // Storage is 8-bit only, so the pixel format is always rgba-unorm8
    // (image_data.cc:139-171).
    if array_type != DataArrayType::Uint8Clamped {
      return Err(webidl::dom_exception(
        raw,
        "InvalidStateError",
        &format!(
          "{prefix}{} must use {} pixelFormat.",
          array_type.name(),
          array_type.pixel_format()
        ),
      ));
    }
    let mut length = 0usize;
    check_status!(unsafe {
      sys::napi_get_typedarray_info(
        raw,
        data,
        ptr::null_mut(),
        &mut length,
        ptr::null_mut(),
        ptr::null_mut(),
        ptr::null_mut(),
      )
    })?;
    let height = validate_data_length(raw, prefix, width, height, length, 1)?;
    // The given array is the data, not a copy (image_data.cc:230). As for the
    // other forms: a weak ref, and a non-configurable `data` property that
    // keeps the array alive; resolve_pixels checks it on every use, as the
    // caller may detach its buffer.
    this.define_properties(&[Property::new()
      .with_utf8_name("data")?
      .with_value(&unsafe { Unknown::from_raw_unchecked(raw, data) })
      .with_property_attributes(PropertyAttributes::Enumerable)])?;
    Ok(ImageData {
      width: width as usize,
      height: height as usize,
      color_space,
      data_ref: Some(create_weak_ref(env, data)?),
    })
  }

  #[napi(getter)]
  pub fn get_width(&self) -> u32 {
    self.width as u32
  }

  #[napi(getter)]
  pub fn get_height(&self) -> u32 {
    self.height as u32
  }

  #[napi(getter, ts_return_type = "PredefinedColorSpace")]
  pub fn get_color_space(&self) -> &'static str {
    self.color_space.as_str()
  }

  /// Storage is always 8-bit RGBA here.
  #[napi(getter, ts_return_type = "ImageDataPixelFormat")]
  pub fn get_pixel_format(&self) -> &'static str {
    "rgba-unorm8"
  }
}

#[napi(custom_finalize)]
pub struct Image {
  /// Shared ownership: `CanvasPattern`s created from this image hold an
  /// `Arc` clone so the pixels stay alive if the `Image` is GC'd first.
  /// V8 external-memory accounting is released when the last owner drops,
  /// not when this `Image` is finalized.
  pub(crate) bitmap: Option<Arc<AccountedBitmap>>,
  pub(crate) complete: bool,
  /// The last load failed (onerror fired): the HTML "broken" state.
  pub(crate) broken: bool,
  pub(crate) alt: String,
  pub(crate) current_src: Option<String>,
  width: f64,
  height: f64,
  // Natural dimensions - extracted from image header, available before full decode
  natural_width: f64,
  natural_height: f64,
  /// An SVG image: its document and sizing. Chrome draws it at the size of
  /// each use instead of from one bitmap.
  pub(crate) svg: Option<SvgImage>,
  pub(crate) color_space: ColorSpace,
  pub(crate) src: Option<Either<Uint8Array, String>>,
  // Generation counter to handle overlapping loads
  load_generation: u64,
  /// Bumped when src changes to another value: a pending decode() then
  /// rejects (HTML "update the image data" rejects the pending decodes).
  /// Shared with the decode() callbacks.
  decode_epoch: Rc<Cell<u64>>,

  decoder_task: Option<ObjectRef>,
}

impl ObjectFinalize for Image {
  fn finalize(self, env: Env) -> Result<()> {
    // V8 memory accounting lives inside AccountedBitmap and is released when
    // the last owner drops — patterns may hold clones past finalization.
    if let Some(decoder_task) = self.decoder_task {
      decoder_task.unref(&env)?;
    }
    Ok(())
  }
}

/// `Symbol.for(IMAGE_ERROR_KEY)` is where an onerror Event carries the Error
/// behind it, so loadImage() can reject with that Error.
const IMAGE_ERROR_KEY: &str = "@napi-rs/canvas/image-error";

/// Calls `this.onerror`, if it is a function, with an Event of type 'error',
/// as browsers do. The Event carries `error` under
/// `Symbol.for(IMAGE_ERROR_KEY)` (not enumerable). Without a global Event
/// (Node < 15) it gets `error` itself.
fn fire_error(env: &Env, this: Object, error: Object) -> Result<()> {
  let onerror = this.get_named_property_unchecked::<Unknown>("onerror")?;
  if onerror.get_type()? != ValueType::Function {
    return Ok(());
  }
  let onerror: Function<Unknown, Unknown> = Function::from_unknown(onerror)?;
  let global = env.get_global()?;
  let event_ctor = global.get_named_property_unchecked::<Unknown>("Event")?;
  if event_ctor.get_type()? != ValueType::Function {
    onerror.apply(this, error.to_unknown())?;
    return Ok(());
  }
  let event_ctor: Function<&str, Object> = Function::from_unknown(event_ctor)?;
  let event = event_ctor.new_instance("error")?;
  // Symbol is a function; read it as an object for its `for` method.
  let symbol = global.get_named_property_unchecked::<Object>("Symbol")?;
  let symbol_for: Function<&str, Unknown> = symbol.get_named_property("for")?;
  let key = symbol_for.apply(symbol, IMAGE_ERROR_KEY)?;
  let property = sys::napi_property_descriptor {
    utf8name: ptr::null(),
    name: key.raw(),
    method: None,
    getter: None,
    setter: None,
    value: error.raw(),
    attributes: sys::PropertyAttributes::default,
    data: ptr::null_mut(),
  };
  check_status!(unsafe { sys::napi_define_properties(env.raw(), event.raw(), 1, &property) })?;
  onerror.apply(this, event.to_unknown())?;
  Ok(())
}

/// The rejection of decode() (image_loader.cc DecodeRequest::Reject).
fn encoding_error(env: &Env) -> Error {
  webidl::dom_exception(
    env.raw(),
    "EncodingError",
    "The source image cannot be decoded.",
  )
}

/// The value an Image `width` or `height` attribute takes (already
/// ToUint32): HTML's reflection of an `unsigned long` gives the default 0
/// for a value above 2147483647.
fn image_dimension(value: u32) -> u32 {
  if value > i32::MAX as u32 { 0 } else { value }
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
      broken: false,
      bitmap: None,
      alt: "".to_string(),
      current_src: None,
      width,
      height,
      natural_width: 0.0,
      natural_height: 0.0,
      svg: None,
      color_space,
      src: None,

      load_generation: 0,
      decode_epoch: Rc::new(Cell::new(0)),
      decoder_task: None,
    })
  }

  #[napi(getter)]
  pub fn get_width(&self) -> f64 {
    if self.width >= 0.0 { self.width } else { 0.0 }
  }

  #[napi(setter)]
  pub fn set_width(&mut self, width: webidl::UnsignedLong<webidl::ImageSetWidth>) {
    let width = f64::from(image_dimension(width.0));
    self.width = width;
  }

  #[napi(getter)]
  pub fn get_natural_width(&self) -> f64 {
    // Return stored natural_width (set from imagesize header parsing)
    // Falls back to bitmap dimensions if natural_width not set
    if self.natural_width > 0.0 {
      self.natural_width
    } else {
      self.bitmap.as_ref().map(|b| b.inner.0.width).unwrap_or(0) as f64
    }
  }

  #[napi(getter)]
  pub fn get_height(&self) -> f64 {
    if self.height >= 0.0 { self.height } else { 0.0 }
  }

  #[napi(setter)]
  pub fn set_height(&mut self, height: webidl::UnsignedLong<webidl::ImageSetHeight>) {
    let height = f64::from(image_dimension(height.0));
    self.height = height;
  }

  #[napi(getter)]
  pub fn get_natural_height(&self) -> f64 {
    // Return stored natural_height (set from imagesize header parsing)
    // Falls back to bitmap dimensions if natural_height not set
    if self.natural_height > 0.0 {
      self.natural_height
    } else {
      self.bitmap.as_ref().map(|b| b.inner.0.height).unwrap_or(0) as f64
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
  pub fn set_alt(&mut self, alt: webidl::DomString<webidl::ImageSetAlt>) {
    self.alt = alt.0;
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
    let previous_src = match &self.src {
      Some(Either::B(string)) => Some(string.clone()),
      _ => None,
    };
    let had_src = self.src.is_some();
    let data = match raw_data.get_type()? {
      ValueType::Object if (raw_data.is_buffer()? || raw_data.is_typedarray()?) => {
        let data: Uint8Array = unsafe { raw_data.cast() }?;
        self.src.insert(Either::A(data))
      }
      ValueType::String => {
        let string = unsafe { raw_data.cast()? };
        self.src.insert(Either::B(string))
      }
      _ => return Ok(()),
    };
    // Another src (any Buffer, another string, or '' after a src) rejects the
    // pending decode() calls; the same string again does not.
    let same_src = match &data {
      Either::A(_) => false,
      Either::B(string) if string.is_empty() => !had_src,
      Either::B(string) => previous_src.as_deref() == Some(string.as_str()),
    };
    if !same_src {
      self
        .decode_epoch
        .set(self.decode_epoch.get().wrapping_add(1));
    }
    // Increment generation FIRST to invalidate all in-flight loads
    // This must happen for BOTH empty and valid src to prevent race conditions
    self.load_generation = self.load_generation.wrapping_add(1);
    self.broken = false;

    // Check if src is empty per HTML spec.
    // The previous `< 5` byte heuristic incorrectly silenced tiny invalid buffers
    // (e.g. Buffer.from([1])), causing loadImage() to hang. Such buffers must
    // fall through to the async decoder, which reports them via onerror.
    // See https://github.com/Brooooooklyn/canvas/issues/1255
    let is_empty = match &data {
      Either::A(buffer) => buffer.is_empty(),
      Either::B(string) => string.is_empty(),
    };

    if is_empty {
      // HTML spec: empty src = clear state, complete=true, NO events
      self.src = None;
      self.current_src = None;
      self.width = -1.0;
      self.height = -1.0;
      self.natural_width = 0.0;
      self.natural_height = 0.0;
      self.bitmap = None;
      self.complete = true;
      self.svg = None;
      // The dropped Arc releases its V8 memory accounting on its own.

      // Clear decoder_task so decode() returns fresh resolved promise
      if let Some(previous_task) = self.decoder_task.take() {
        previous_task.unref(&env)?;
      }
      return Ok(());
    }

    // For Buffer: load synchronously (dimensions + events), decode bitmap synchronously
    // This matches node-canvas behavior where onerror/onload fire synchronously
    if let Either::A(buffer) = data {
      let buffer_data = buffer.as_ref();
      let length = buffer_data.len();

      // Known raster signatures take precedence over the permissive SVG scan.
      // Raster payloads may legitimately contain the bytes `<svg` in metadata or
      // compressed data, and the async decoder uses the same raster-first order.
      let is_raster = libavif::is_avif(buffer_data)
        || infer::get(buffer_data)
          .is_some_and(|kind| kind.matcher_type() == infer::MatcherType::Image);
      // A data: URL in a Buffer is parsed (and decoded) by the async path.
      let is_svg =
        !is_raster && !data_url::is_data_url(buffer_data) && is_svg_image(buffer_data, length);
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

        // An SVG is parsed now; its natural size comes from its root.
        if is_svg {
          match SvgImage::parse(buffer_data, self.color_space)? {
            Some(svg) => self.set_svg(&env, svg)?,
            None => {
              // Invalid SVG - fire onerror synchronously
              // Clear prior image state to prevent stale data from being drawn
              // Reset width/height to auto (-1.0) so getters return 0 for broken image
              self.complete = true;
              self.broken = true;
              self.width = -1.0;
              self.height = -1.0;
              self.natural_width = 0.0;
              self.natural_height = 0.0;
              self.bitmap = None;
              self.svg = None;

              let error = env.create_error(Error::new(Status::InvalidArg, "Invalid SVG image"))?;
              fire_error(&env, *this, error)?;
              if let Some(previous_task) = self.decoder_task.replace(
                PromiseRaw::resolve(&env, error)?
                  .coerce_to_object()?
                  .create_ref()?,
              ) {
                previous_task.unref(&env)?;
              }
              return Ok(());
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
          self.svg = None;

          let task = BitmapDecoder {
            width: self.width,
            height: self.height,
            this_ref: this.create_ref()?,
            generation: self.load_generation,
            color_space: self.color_space,
            data: Some(Either::A(unsafe { raw_data.cast()? })),
            file_content: None,
            fire_events: true, // Fire onload after decode completes
            original_url: None,
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
        self.svg = None;

        let task = BitmapDecoder {
          width: self.width,
          height: self.height,
          this_ref: this.create_ref()?,
          generation: self.load_generation,
          color_space: self.color_space,
          data: Some(Either::A(unsafe { raw_data.cast()? })),
          file_content: None,
          fire_events: true,
          original_url: None,
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
      let url_for_src = url_string.clone();
      // Create separate ObjectRefs for each callback, wrapped in Rc<Cell<Option<...>>>
      // so that whichever closure runs (then or catch) can clean up BOTH refs.
      // This prevents a memory leak: without this, on success the catch ref leaks
      // (catch never fires), and on error the then ref leaks (second then never fires).
      let this_ref_then_rc: Rc<Cell<Option<ObjectRef<false>>>> =
        Rc::new(Cell::new(Some(this.create_ref()?)));
      let this_ref_catch_rc: Rc<Cell<Option<ObjectRef<false>>>> =
        Rc::new(Cell::new(Some(this.create_ref()?)));

      let ref_then_for_then = this_ref_then_rc.clone();
      let ref_catch_for_then = this_ref_catch_rc.clone();
      let ref_then_for_catch = this_ref_then_rc.clone();
      let ref_catch_for_catch = this_ref_catch_rc.clone();
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
          let this_ref = ref_then_for_then
            .take()
            .expect("then ObjectRef already taken");
          let this: Object = this_ref.get_value(&ctx.env)?;
          this_ref.unref(&ctx.env)?;
          // Also unref the catch ref since catch won't run on success
          if let Some(catch_ref) = ref_catch_for_then.take() {
            catch_ref.unref(&ctx.env)?;
          }

          let mut image_ptr = ptr::null_mut();
          check_status!(
            unsafe { sys::napi_unwrap(ctx.env.raw(), this.raw(), &mut image_ptr) },
            "Failed to unwrap Image from this"
          )?;
          let image = unsafe { &mut *image_ptr.cast::<Image>() };

          if generation != image.load_generation {
            // Stale load - return a resolved promise so the chain completes
            return PromiseRaw::resolve(&ctx.env, ())?.coerce_to_object();
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
            original_url: Some(url_for_src),
          };
          let decode_task = ctx.env.spawn(decoder)?;
          // Return the decoder's promise so the chain waits for bitmap decoding to finish.
          // JS promise chaining automatically flattens returned promises (thenables).
          decode_task.promise_object().coerce_to_object()
        })?
        .catch(move |ctx: CallbackContext<Unknown>| {
          // Take the catch ref - may be None if the second .then() already unrefed it
          // (e.g. .then() succeeded in unrefing but then failed at spawn)
          let catch_ref = ref_catch_for_catch.take();
          // Also unref the then ref since second then didn't run on error
          if let Some(then_ref) = ref_then_for_catch.take() {
            then_ref.unref(&ctx.env)?;
          }

          // If catch_ref was already taken by the success path, the second .then()
          // already ran (and unrefed both refs) but errored afterwards.
          // We still need to handle the error but can skip state updates since
          // the .then() may have already spawned the decoder.
          let Some(catch_ref) = catch_ref else {
            return Ok(None);
          };
          let this: Object = catch_ref.get_value(&ctx.env)?;
          catch_ref.unref(&ctx.env)?;

          // Get Image instance and update state
          let mut image_ptr = ptr::null_mut();
          check_status!(
            unsafe { sys::napi_unwrap(ctx.env.raw(), this.raw(), &mut image_ptr) },
            "Failed to unwrap Image from this"
          )?;
          let image = unsafe { &mut *image_ptr.cast::<Image>() };

          // Ignore stale errors from superseded loads
          if generation != image.load_generation {
            return Ok(None);
          }

          image.complete = true;
          image.broken = true;
          image.width = -1.0;
          image.height = -1.0;
          image.natural_width = 0.0;
          image.natural_height = 0.0;
          image.bitmap = None;
          image.svg = None;

          let error_msg: String = ctx
            .value
            .coerce_to_string()
            .and_then(|s: JsString| s.into_utf8())
            .and_then(|s: JsStringUtf8| s.into_owned())
            .unwrap_or_else(|_| "Network error".to_string());
          let error_obj = ctx
            .env
            .create_error(Error::new(Status::GenericFailure, error_msg.clone()))?;
          fire_error(&ctx.env, this, error_obj)?;
          // The stored task ends with an Error, so decode() rejects.
          Ok(Some(Error::new(Status::GenericFailure, error_msg)))
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
      original_url: None,
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

  /// Resolves once the current load is decoded. Rejects with an
  /// EncodingError DOMException when there is no src, the load fails, or
  /// src changes to another value before it settles (image_loader.cc
  /// DecodeRequest). Each call returns a new promise.
  #[napi(ts_return_type = "Promise<void>")]
  pub fn decode<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
    let has_src = self.src.is_some();
    let epoch = Rc::clone(&self.decode_epoch);
    let started = epoch.get();
    let task = match self.decoder_task.as_ref() {
      Some(promise_ref) => promise_ref.get_value(env)?.to_unknown(),
      None => ().into_unknown(env)?,
    };
    PromiseRaw::resolve(env, task)?
      .then(move |ctx: CallbackContext<Unknown>| {
        if !has_src || ctx.value.is_error()? || epoch.get() != started {
          return Err(encoding_error(&ctx.env));
        }
        Ok(())
      })?
      .catch(|ctx: CallbackContext<Unknown>| -> Result<()> { Err(encoding_error(&ctx.env)) })?
      .coerce_to_object()
  }

  /// The Image now shows `svg`: its natural size comes from the SVG, and
  /// `width`/`height` without an attribute take it. V8 is told about the
  /// encoded copies of its `<image>` elements.
  fn set_svg(&mut self, env: &Env, mut svg: SvgImage) -> Result<()> {
    svg.report_retained_bytes(env)?;
    let (natural_width, natural_height) = svg.sizing.natural();
    self.natural_width = natural_width as f64;
    self.natural_height = natural_height as f64;
    if (self.width - -1.0).abs() < f64::EPSILON {
      self.width = self.natural_width;
    }
    if (self.height - -1.0).abs() < f64::EPSILON {
      self.height = self.natural_height;
    }
    self.bitmap = None;
    self.svg = Some(svg);
    Ok(())
  }

  pub(crate) fn is_svg(&self) -> bool {
    self.svg.is_some()
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
}

enum DecodeStatus {
  Ok(BitmapInfo),
  Svg(SvgImage),
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
  // Preserve original HTTP URL for currentSrc when data is downloaded bytes
  original_url: Option<String>,
}

impl<'env> ScopedTask<'env> for BitmapDecoder {
  type Output = DecodedBitmap;
  type JsValue = Unknown<'env>;

  fn compute(&mut self) -> Result<Self::Output> {
    let data_ref = match self.data.as_ref() {
      Some(Either::A(data)) => Cow::Borrowed(data.as_ref()),
      Some(Either::B(path_or_svg)) => {
        if data_url::is_data_url(path_or_svg.as_bytes()) {
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
    // A data: URL (a string, or bytes) holds the image in its body. Chrome
    // decodes it as SVG only when its MIME type is image/svg+xml; any other
    // type is sniffed as a raster image, so an SVG body fails there.
    let (data_ref, svg_only, raster_only) = match data_url::parse(&data_ref) {
      None => (data_ref, false, false),
      Some(Err(())) => {
        return Ok(DecodedBitmap {
          bitmap: DecodeStatus::InvalidImage,
          width: self.width,
          height: self.height,
        });
      }
      Some(Ok(url)) => {
        let svg = url.essence == "image/svg+xml";
        (Cow::Owned(url.body), svg, !svg)
      }
    };
    let length = data_ref.len();
    let mut width = self.width;
    let mut height = self.height;
    let bitmap = if !svg_only && libavif::is_avif(data_ref.as_ref()) {
      // Check AVIF first - infer::get() may not recognize AVIF format
      let mut avif_image = AvifImage::decode_from(data_ref.as_ref())
        .map_err(|e| Error::new(Status::InvalidArg, format!("Decode avif image failed {e}")))?;

      let bitmap = Bitmap::from_image_data(
        avif_image.data.as_mut_ptr(),
        avif_image.width as usize,
        avif_image.height as usize,
        avif_image.row_bytes as usize,
        avif_image.data.len(),
        ColorType::RGBA8888,
        // Premultiplied by the YUV conversion, as Chrome's decoder does;
        // 255 everywhere and opaque when the file has no alpha plane.
        if avif_image.has_alpha() {
          AlphaType::Premultiplied
        } else {
          AlphaType::Opaque
        },
      )
      .and_then(|mut bitmap| {
        // Like the PNG/JPEG/WebP codecs, keep the file's color space, so a
        // draw converts it to the canvas color space as Chrome does, and
        // apply the irot/imir orientation as Chrome does. Chrome fails the
        // decode for a color space it cannot use.
        (bitmap.set_avif_color_space(
          avif_image.icc(),
          avif_image.color_primaries,
          avif_image.transfer_characteristics,
          avif_image.matrix_coefficients,
          avif_image.is_mono,
        ) && bitmap.orient(avif_image.origin))
        .then_some(bitmap)
      });
      // `from_image_data` copies the pixels into an owned SkBitmap, so the
      // decoded AVIF buffer is dropped at the end of this arm.
      match bitmap {
        Some(bitmap) => DecodeStatus::Ok(BitmapInfo { data: bitmap }),
        // A color space Chrome cannot use, or a failed pixel copy: an
        // invalid image rather than an empty bitmap.
        None => DecodeStatus::InvalidImage,
      }
    } else if !svg_only
      && infer::get(&data_ref).is_some_and(|kind| kind.matcher_type() == infer::MatcherType::Image)
    {
      // Other image formats detected by infer (PNG, JPEG, GIF, WebP, etc.)
      if let Some(bitmap) = Bitmap::from_buffer(data_ref.as_ptr().cast_mut(), length) {
        DecodeStatus::Ok(BitmapInfo { data: bitmap })
      } else {
        DecodeStatus::InvalidImage
      }
    } else if !raster_only && (svg_only || is_svg_image(&data_ref, length)) {
      match SvgImage::parse(&data_ref, self.color_space)? {
        Some(svg) => DecodeStatus::Svg(svg),
        None => DecodeStatus::InvalidSvg,
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

    // The source that loaded becomes src and currentSrc; an HTTP URL load
    // keeps its URL rather than the downloaded bytes.
    let mut commit_src = |image: &mut Image| {
      image.src = self.data.take();
      if let Some(url) = self.original_url.take() {
        image.src = Some(Either::B(url));
      }
      image.current_src = match &image.src {
        Some(Either::A(_)) => Some("[Buffer]".to_string()),
        Some(Either::B(s)) => Some(s.clone()),
        None => None,
      };
    };
    match output.bitmap {
      DecodeStatus::Ok(bitmap) => {
        // SUCCESS PATH: set dimensions, bitmap, currentSrc
        self_mut.width = output.width;
        self_mut.height = output.height;
        self_mut.natural_width = output.width;
        self_mut.natural_height = output.height;
        commit_src(self_mut);
        self_mut.svg = None;
        let new_bytes = (output.width as i64) * (output.height as i64) * 4;
        env.adjust_external_memory(new_bytes)?;
        self_mut.bitmap = Some(Arc::new(AccountedBitmap::new(
          bitmap.data,
          env.raw(),
          new_bytes,
        )));
      }
      DecodeStatus::Svg(svg) => {
        commit_src(self_mut);
        self_mut.set_svg(env, svg)?;
      }
      DecodeStatus::Empty => {
        // ERROR PATH: empty / undecodable input. Surface via onerror so callers
        // (especially loadImage) settle instead of hanging.
        // See https://github.com/Brooooooklyn/canvas/issues/1255
        self_mut.width = -1.0;
        self_mut.height = -1.0;
        self_mut.natural_width = 0.0;
        self_mut.natural_height = 0.0;
        self_mut.svg = None;
        err = Some("Empty image data");
      }
      DecodeStatus::InvalidSvg => {
        // ERROR PATH: clear state like reject() does
        // Reset width/height to auto (-1.0) so getters return 0 (from natural_width/height)
        self_mut.width = -1.0;
        self_mut.height = -1.0;
        self_mut.natural_width = 0.0;
        self_mut.natural_height = 0.0;
        self_mut.svg = None;
        err = Some("Invalid SVG image");
      }
      DecodeStatus::InvalidImage => {
        // ERROR PATH: clear state like reject() does
        // Reset width/height to auto (-1.0) so getters return 0 (from natural_width/height)
        self_mut.width = -1.0;
        self_mut.height = -1.0;
        self_mut.natural_width = 0.0;
        self_mut.natural_height = 0.0;
        self_mut.svg = None;
        err = Some("Unsupported image type");
      }
    }

    self_mut.broken = err.is_some();
    if let Some(err_str) = err.take() {
      let error = env.create_error(Error::new(Status::InvalidArg, err_str))?;
      if self.fire_events {
        fire_error(env, this, error)?;
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
    image.broken = true;
    // Clear decoded state so all dimension getters return 0 for broken image
    // Reset width/height to auto (-1.0) so getters return 0 (from natural_width/height)
    image.width = -1.0;
    image.height = -1.0;
    image.natural_width = 0.0;
    image.natural_height = 0.0;
    image.bitmap = None;
    image.svg = None;

    if self.fire_events {
      fire_error(
        env,
        this,
        env.create_error(Error::new(err.status, err.reason.clone()))?,
      )?;
    }

    Error::new(err.status, err.reason.clone()).into_unknown(env)
  }

  fn finally(self, env: Env) -> Result<()> {
    // Unref this_ref (used in resolve/reject paths)
    self.this_ref.unref(&env)?;
    Ok(())
  }
}
