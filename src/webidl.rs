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
  Error,
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
        ErrorKind::Error => sys::napi_create_error(env, ptr::null_mut(), message, &mut error),
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

/// The legacy `code` of the DOMException names used here (WebIDL table).
fn dom_exception_code(name: &str) -> u32 {
  match name {
    "InvalidStateError" => 11,
    "SyntaxError" => 12,
    _ => 0,
  }
}

/// Throw `new DOMException(msg, name)`. Node < 17 has no global
/// DOMException: throw an Error with the same `name` and `code` instead.
pub(crate) fn dom_exception(env: sys::napi_env, name: &str, msg: &str) -> Error {
  let exception = (|| -> Result<sys::napi_value> {
    let global = Env::from_raw(env).get_global()?;
    let ctor: Unknown = global.get_named_property("DOMException")?;
    if ctor.get_type()? != ValueType::Function {
      return Err(Error::from_reason("no DOMException"));
    }
    let args = [
      unsafe { <&str as ToNapiValue>::to_napi_value(env, msg)? },
      unsafe { <&str as ToNapiValue>::to_napi_value(env, name)? },
    ];
    let mut exception = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_new_instance(env, ctor.raw(), args.len(), args.as_ptr(), &mut exception)
    })?;
    Ok(exception)
  })();
  match exception {
    Ok(exception) => throw(env, Some(exception), msg),
    // The DOMException constructor threw: keep that exception.
    Err(_) if is_exception_pending(env) => Error::new(Status::PendingException, msg.to_owned()),
    Err(_) => {
      let error = new_error(env, ErrorKind::Error, msg);
      if let Some(error) = error {
        unsafe {
          let mut value = ptr::null_mut();
          if sys::napi_create_string_utf8(
            env,
            name.as_ptr().cast(),
            name.len() as isize,
            &mut value,
          ) == sys::Status::napi_ok
          {
            sys::napi_set_named_property(env, error, c"name".as_ptr(), value);
          }
          if sys::napi_create_uint32(env, dom_exception_code(name), &mut value)
            == sys::Status::napi_ok
          {
            sys::napi_set_named_property(env, error, c"code".as_ptr(), value);
          }
        }
      }
      throw(env, error, msg)
    }
  }
}

fn is_exception_pending(env: sys::napi_env) -> bool {
  let mut pending = false;
  unsafe { sys::napi_is_exception_pending(env, &mut pending) };
  pending
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

  /// `unrestricted double` member: ToNumber.
  fn number(&self, key: &str) -> Result<Option<f64>> {
    let Some(v) = member(self.env, self.value, key)? else {
      return Ok(None);
    };
    let mut n = ptr::null_mut();
    check_status!(unsafe { sys::napi_coerce_to_number(self.env, v, &mut n) })?;
    Ok(Some(unsafe { f64::from_napi_value(self.env, n)? }))
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
pub(crate) const CREATE_PATTERN: &str =
  "Failed to execute 'createPattern' on 'CanvasRenderingContext2D': ";
pub(crate) const PATTERN_SET_TRANSFORM: &str =
  "Failed to execute 'setTransform' on 'CanvasPattern': ";

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
    // Chrome 155 also takes 'rgba-float16' and 'rgba-float32' (Float16Array
    // and Float32Array data). Storage here is 8-bit only, so they are
    // rejected like any value outside the enum, not stored as 8-bit.
    dictionary.enumeration("pixelFormat", "ImageDataPixelFormat", &["rgba-unorm8"])?;
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

/// `DOMMatrix2DInit` converted and fixed up like DOMMatrixReadOnly::fromMatrix2D
/// (core/geometry/dom_matrix_read_only.cc:179): [m11, m12, m21, m22, m41, m42].
/// Undefined or null is `{}` (the identity).
pub(crate) fn dom_matrix_2d_init(
  env: sys::napi_env,
  value: Option<sys::napi_value>,
  prefix: &str,
) -> Result<[f64; 6]> {
  const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
  let Some(value) = present(env, value)? else {
    return Ok(IDENTITY);
  };
  if !is_object(env, value)? {
    return Err(type_error(
      env,
      &format!("{prefix}The provided value is not of type 'DOMMatrix2DInit'."),
    ));
  }
  let dictionary = Dictionary {
    env,
    value,
    prefix,
    name: "DOMMatrix2DInit",
  };
  let mut members = [None; 12];
  for (slot, key) in members.iter_mut().zip([
    "a", "b", "c", "d", "e", "f", "m11", "m12", "m21", "m22", "m41", "m42",
  ]) {
    *slot = dictionary.number(key)?;
  }
  let (short, long) = members.split_at(6);
  let mut matrix = IDENTITY;
  for i in 0..6 {
    // ValidateAndFixup2D: a and m11 (and so on) must agree when both are
    // given; two NaNs agree.
    if let (Some(s), Some(l)) = (short[i], long[i])
      && s != l
      && !(s.is_nan() && l.is_nan())
    {
      return Err(type_error(
        env,
        &format!("{prefix}Property mismatch on matrix initialization."),
      ));
    }
    if let Some(v) = long[i].or(short[i]) {
      matrix[i] = v;
    }
  }
  Ok(matrix)
}

// Method arguments converted in the napi-rs callback glue. The glue converts
// every argument before it borrows the receiver, so a dictionary getter may
// use the same canvas, context or pattern, as in Chrome. Converted in the
// method body, such a getter would hit napi-rs's borrow check and throw.

/// The getContext() options of a Canvas.
pub struct CanvasContextOptions(pub(crate) ContextSettings);

impl FromNapiValue for CanvasContextOptions {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    ContextSettings::from_js(env, Some(value), CANVAS_GET_CONTEXT).map(Self)
  }
}

/// The getContext() options of an SVGCanvas.
pub struct SvgCanvasContextOptions(pub(crate) ContextSettings);

impl FromNapiValue for SvgCanvasContextOptions {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    ContextSettings::from_js(env, Some(value), SVG_CANVAS_GET_CONTEXT).map(Self)
  }
}

/// The settings of getImageData().
pub struct GetImageDataSettings(pub(crate) ImageDataSettings);

impl FromNapiValue for GetImageDataSettings {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    ImageDataSettings::from_js(env, Some(value), GET_IMAGE_DATA).map(Self)
  }
}

/// The matrix of CanvasPattern.setTransform().
pub struct PatternTransform(pub(crate) [f64; 6]);

impl FromNapiValue for PatternTransform {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    dom_matrix_2d_init(env, Some(value), PATTERN_SET_TRANSFORM).map(Self)
  }
}
