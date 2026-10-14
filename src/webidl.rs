//! WebIDL argument conversion for the dictionaries and enums of the 2D
//! canvas API, with the errors and messages Chrome throws.
//!
//! Each helper throws the JS exception itself and returns an `Err` with
//! `Status::PendingException`; napi-rs then keeps the pending exception.

use std::ptr;

use napi::{bindgen_prelude::*, sys};

use crate::sk::ColorSpace;

#[derive(Clone, Copy)]
enum ErrorKind {
  RangeError,
  TypeError,
}

/// A new error object with `msg`; None if it cannot be created.
fn new_error(env: sys::napi_env, kind: ErrorKind, msg: &str) -> Option<sys::napi_value> {
  let mut message = ptr::null_mut();
  let mut error = ptr::null_mut();
  // Explicit length: the message may hold a user string with NUL in it.
  let ok = unsafe {
    sys::napi_create_string_utf8(env, msg.as_ptr().cast(), msg.len() as isize, &mut message)
      == sys::Status::napi_ok
      && match kind {
        ErrorKind::RangeError => {
          sys::napi_create_range_error(env, ptr::null_mut(), message, &mut error)
        }
        ErrorKind::TypeError => {
          sys::napi_create_type_error(env, ptr::null_mut(), message, &mut error)
        }
      } == sys::Status::napi_ok
  };
  ok.then_some(error)
}

fn throw(env: sys::napi_env, error: Option<sys::napi_value>, msg: &str) -> Error {
  if let Some(error) = error {
    unsafe { sys::napi_throw(env, error) };
  }
  Error::new(Status::PendingException, msg.to_owned())
}

/// Throw a TypeError.
pub(crate) fn type_error(env: sys::napi_env, msg: &str) -> Error {
  throw(env, new_error(env, ErrorKind::TypeError, msg), msg)
}

/// Throw a RangeError.
pub(crate) fn range_error(env: sys::napi_env, msg: &str) -> Error {
  throw(env, new_error(env, ErrorKind::RangeError, msg), msg)
}

fn type_of(env: sys::napi_env, value: sys::napi_value) -> Result<ValueType> {
  let mut t = 0;
  check_status!(unsafe { sys::napi_typeof(env, value, &mut t) })?;
  Ok(ValueType::from(t))
}

/// `value`, unless it is missing, undefined or null.
fn present(env: sys::napi_env, value: Option<sys::napi_value>) -> Result<Option<sys::napi_value>> {
  match value {
    Some(v) if !matches!(type_of(env, v)?, ValueType::Undefined | ValueType::Null) => Ok(Some(v)),
    _ => Ok(None),
  }
}

/// An object or a function: what a WebIDL dictionary accepts.
fn is_object(env: sys::napi_env, value: sys::napi_value) -> Result<bool> {
  Ok(matches!(
    type_of(env, value)?,
    ValueType::Object | ValueType::Function
  ))
}

/// ToString(value); runs toString()/valueOf() and may throw.
fn to_js_string(env: sys::napi_env, value: sys::napi_value) -> Result<String> {
  let mut s = ptr::null_mut();
  check_status!(unsafe { sys::napi_coerce_to_string(env, value, &mut s) })?;
  unsafe { String::from_napi_value(env, s) }
}

/// Dictionary member `key`; None when it is undefined. Runs getters.
fn member(
  env: sys::napi_env,
  dictionary: sys::napi_value,
  key: &str,
) -> Result<Option<sys::napi_value>> {
  let key = std::ffi::CString::new(key)?;
  let mut value = ptr::null_mut();
  check_status!(unsafe {
    sys::napi_get_named_property(env, dictionary, key.as_ptr(), &mut value)
  })?;
  Ok(match type_of(env, value)? {
    ValueType::Undefined => None,
    _ => Some(value),
  })
}

/// WebIDL `unsigned long` (ToNumber, then ToUint32: NaN and infinities are
/// 0, the rest is truncated modulo 2^32). ToNumber may throw.
pub(crate) fn to_unsigned_long(env: sys::napi_env, value: sys::napi_value) -> Result<u32> {
  let mut number = ptr::null_mut();
  check_status!(unsafe { sys::napi_coerce_to_number(env, value, &mut number) })?;
  let x = unsafe { f64::from_napi_value(env, number)? };
  if !x.is_finite() {
    return Ok(0);
  }
  Ok(x.trunc().rem_euclid(4_294_967_296.0) as u32)
}

/// One dictionary being converted, for the error messages.
struct Dictionary<'a> {
  env: sys::napi_env,
  value: sys::napi_value,
  /// "Failed to execute 'x' on 'Y': "
  prefix: &'a str,
  name: &'a str,
}

impl Dictionary<'_> {
  /// `boolean` member: ToBoolean.
  fn boolean(&self, key: &str) -> Result<Option<bool>> {
    let Some(v) = member(self.env, self.value, key)? else {
      return Ok(None);
    };
    let mut b = ptr::null_mut();
    check_status!(unsafe { sys::napi_coerce_to_bool(self.env, v, &mut b) })?;
    Ok(Some(unsafe { bool::from_napi_value(self.env, b)? }))
  }

  /// Enum member: ToString, then an exact, case-sensitive match.
  fn enumeration<'v>(
    &self,
    key: &str,
    enum_name: &str,
    values: &[&'v str],
  ) -> Result<Option<&'v str>> {
    let Some(v) = member(self.env, self.value, key)? else {
      return Ok(None);
    };
    let s = to_js_string(self.env, v)?;
    match values.iter().find(|value| **value == s) {
      Some(value) => Ok(Some(value)),
      None => Err(type_error(
        self.env,
        &format!(
          "{}Failed to read the '{key}' property from '{}': The provided value '{s}' is not a valid enum value of type {enum_name}.",
          self.prefix, self.name
        ),
      )),
    }
  }
}

/// Every value of Chrome's `PredefinedColorSpace` enum
/// (core/html/canvas/image_data_settings.idl). Only srgb and display-p3 are
/// enabled; the others pass the enum conversion and then fail in
/// ValidateAndConvertColorSpace (core/html/canvas/predefined_color_space.cc).
const PREDEFINED_COLOR_SPACE: &[&str] = &[
  "srgb",
  "rec2020",
  "display-p3",
  "rec2100-hlg",
  "rec2100-pq",
  "srgb-linear",
  "display-p3-linear",
  "rec2100-linear",
];

/// ValidateAndConvertColorSpace.
fn supported_color_space(env: sys::napi_env, prefix: &str, value: &str) -> Result<ColorSpace> {
  match value {
    "srgb" => Ok(ColorSpace::Srgb),
    "display-p3" => Ok(ColorSpace::DisplayP3),
    _ => Err(type_error(
      env,
      &format!(
        "{prefix}The provided value '{value}' is not a valid enum value of the type PredefinedColorSpace."
      ),
    )),
  }
}

pub(crate) const IMAGE_DATA_CONSTRUCTOR: &str = "Failed to construct 'ImageData': ";
pub(crate) const CREATE_IMAGE_DATA: &str =
  "Failed to execute 'createImageData' on 'CanvasRenderingContext2D': ";
pub(crate) const GET_IMAGE_DATA: &str =
  "Failed to execute 'getImageData' on 'CanvasRenderingContext2D': ";
pub(crate) const CANVAS_GET_CONTEXT: &str =
  "Failed to execute 'getContext' on 'HTMLCanvasElement': ";
pub(crate) const SVG_CANVAS_GET_CONTEXT: &str = "Failed to execute 'getContext' on 'SVGCanvas': ";

/// `ImageDataSettings` (core/html/canvas/image_data_settings.idl).
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ImageDataSettings {
  /// None: the caller's default (the context color space, or srgb for the
  /// ImageData constructor).
  pub color_space: Option<ColorSpace>,
}

impl ImageDataSettings {
  /// Undefined or null is `{}`; any other non-object is a TypeError.
  pub(crate) fn from_js(
    env: sys::napi_env,
    value: Option<sys::napi_value>,
    prefix: &str,
  ) -> Result<Self> {
    let Some(value) = present(env, value)? else {
      return Ok(Self::default());
    };
    if !is_object(env, value)? {
      return Err(type_error(
        env,
        &format!("{prefix}The provided value is not of type 'ImageDataSettings'."),
      ));
    }
    let dictionary = Dictionary {
      env,
      value,
      prefix,
      name: "ImageDataSettings",
    };
    // Members in lexicographic order, as the bindings read them.
    let color_space =
      dictionary.enumeration("colorSpace", "PredefinedColorSpace", PREDEFINED_COLOR_SPACE)?;
    // Only rgba-unorm8 storage exists here: the float formats are accepted
    // and stored as 8-bit, as before.
    dictionary.enumeration(
      "pixelFormat",
      "ImageDataPixelFormat",
      &["rgba-unorm8", "rgba-float16", "rgba-float32"],
    )?;
    let color_space = color_space
      .map(|cs| supported_color_space(env, prefix, cs))
      .transpose()?;
    Ok(Self { color_space })
  }
}

/// `CanvasPixelFormat`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum CanvasPixelFormat {
  #[default]
  Unorm8,
  Float16,
}

impl CanvasPixelFormat {
  pub(crate) fn as_str(&self) -> &'static str {
    match self {
      Self::Unorm8 => "unorm8",
      Self::Float16 => "float16",
    }
  }
}

/// getContext() options that change nothing here and are only reported by
/// getContextAttributes().
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ReportedSettings {
  /// Storage stays 8-bit; float16 is only echoed.
  pub color_type: CanvasPixelFormat,
  /// Echoed as given, as Chrome does
  /// (canvas_context_creation_attributes_helpers.cc:33).
  pub desynchronized: bool,
  /// Drawing is always on the CPU here.
  pub will_read_frequently: bool,
}

/// The getContext() options that Chrome 155 reads
/// (`CanvasContextCreationAttributesModule`,
/// modules/canvas/htmlcanvas/canvas_context_creation_attributes_module.idl).
#[derive(Clone, Copy, Debug)]
pub(crate) struct ContextSettings {
  pub alpha: bool,
  pub color_space: ColorSpace,
  pub reported: ReportedSettings,
}

impl Default for ContextSettings {
  fn default() -> Self {
    Self {
      alpha: true,
      color_space: ColorSpace::Srgb,
      reported: ReportedSettings::default(),
    }
  }
}

impl ContextSettings {
  /// [PermissiveDictionaryConversion]: a non-object reads as `{}`.
  pub(crate) fn from_js(
    env: sys::napi_env,
    value: Option<sys::napi_value>,
    prefix: &str,
  ) -> Result<Self> {
    let mut settings = Self::default();
    let Some(value) = value else {
      return Ok(settings);
    };
    if !is_object(env, value)? {
      return Ok(settings);
    }
    let dictionary = Dictionary {
      env,
      value,
      prefix,
      name: "CanvasContextCreationAttributesModule",
    };
    // All members in lexicographic order, the WebGL ones too: their getters
    // run and an invalid powerPreference throws, also for '2d'.
    if let Some(alpha) = dictionary.boolean("alpha")? {
      settings.alpha = alpha;
    }
    dictionary.boolean("antialias")?;
    let color_space =
      dictionary.enumeration("colorSpace", "PredefinedColorSpace", PREDEFINED_COLOR_SPACE)?;
    if dictionary.enumeration("colorType", "CanvasPixelFormat", &["unorm8", "float16"])?
      == Some("float16")
    {
      settings.reported.color_type = CanvasPixelFormat::Float16;
    }
    dictionary.boolean("depth")?;
    if let Some(desynchronized) = dictionary.boolean("desynchronized")? {
      settings.reported.desynchronized = desynchronized;
    }
    dictionary.boolean("failIfMajorPerformanceCaveat")?;
    dictionary.enumeration(
      "powerPreference",
      "CanvasPowerPreference",
      &["default", "low-power", "high-performance"],
    )?;
    dictionary.boolean("premultipliedAlpha")?;
    dictionary.boolean("preserveDrawingBuffer")?;
    dictionary.boolean("stencil")?;
    // Chrome 155 types this as enum CanvasWillReadFrequently
    // {"true", "false", "undefined"}, not boolean: 1, 0 and null throw.
    settings.reported.will_read_frequently = dictionary.enumeration(
      "willReadFrequently",
      "CanvasWillReadFrequently",
      &["true", "false", "undefined"],
    )? == Some("true");
    dictionary.boolean("xrCompatible")?;
    // ToCanvasContextCreationAttributes checks the color space after the
    // whole dictionary is read
    // (canvas_context_creation_attributes_helpers.cc:24).
    if let Some(color_space) = color_space {
      settings.color_space = supported_color_space(env, prefix, color_space)?;
    }
    Ok(settings)
  }
}
