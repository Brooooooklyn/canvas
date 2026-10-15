//! WebIDL argument conversion for the dictionaries and enums of the 2D
//! canvas API, with the errors and messages Chrome throws.
//!
//! Each helper throws the JS exception itself and returns an `Err` with
//! `Status::PendingException`; napi-rs then keeps the pending exception.

use std::{
  cell::{RefCell, UnsafeCell},
  marker::PhantomData,
  ptr,
};

use napi::{bindgen_prelude::*, sys};

use crate::sk::{ColorSpace, FillType};

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

/// The legacy `code` of a DOMException name (the WebIDL error names
/// table); 0 for the names without one, such as EncodingError.
fn dom_exception_code(name: &str) -> u32 {
  match name {
    "IndexSizeError" => 1,
    "HierarchyRequestError" => 3,
    "WrongDocumentError" => 4,
    "InvalidCharacterError" => 5,
    "NoModificationAllowedError" => 7,
    "NotFoundError" => 8,
    "NotSupportedError" => 9,
    "InvalidStateError" => 11,
    "SyntaxError" => 12,
    "InvalidModificationError" => 13,
    "NamespaceError" => 14,
    "InvalidAccessError" => 15,
    "TypeMismatchError" => 17,
    "SecurityError" => 18,
    "NetworkError" => 19,
    "AbortError" => 20,
    "URLMismatchError" => 21,
    "QuotaExceededError" => 22,
    "TimeoutError" => 23,
    "InvalidNodeTypeError" => 24,
    "DataCloneError" => 25,
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

pub(crate) fn type_of(env: sys::napi_env, value: sys::napi_value) -> Result<ValueType> {
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
pub(crate) fn to_js_string(env: sys::napi_env, value: sys::napi_value) -> Result<String> {
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

/// Where a conversion runs: the prefix Chrome puts on the message of a
/// conversion error that the engine itself throws.
pub trait Site {
  const PREFIX: &'static str;
}

/// Zero-sized [`Site`] types: `Name: set "attr" on "Interface";` gives
/// "Failed to set the 'attr' property on 'Interface': ", and
/// `Name: execute "op" on "Interface";` gives
/// "Failed to execute 'op' on 'Interface': ".
macro_rules! sites {
  ($($name:ident: $kind:ident $member:literal on $interface:literal;)*) => {
    $(
      pub struct $name;
      impl Site for $name {
        const PREFIX: &'static str = sites!(@prefix $kind $member $interface);
      }
    )*
  };
  (@prefix set $member:literal $interface:literal) => {
    concat!("Failed to set the '", $member, "' property on '", $interface, "': ")
  };
  (@prefix execute $member:literal $interface:literal) => {
    concat!("Failed to execute '", $member, "' on '", $interface, "': ")
  };
}

sites! {
  SetGlobalAlpha: set "globalAlpha" on "CanvasRenderingContext2D";
  SetLineWidth: set "lineWidth" on "CanvasRenderingContext2D";
  SetMiterLimit: set "miterLimit" on "CanvasRenderingContext2D";
  SetShadowBlur: set "shadowBlur" on "CanvasRenderingContext2D";
  SetShadowOffsetX: set "shadowOffsetX" on "CanvasRenderingContext2D";
  SetShadowOffsetY: set "shadowOffsetY" on "CanvasRenderingContext2D";
  SetLineDashOffset: set "lineDashOffset" on "CanvasRenderingContext2D";
  CtxSetLineDash: execute "setLineDash" on "CanvasRenderingContext2D";
  SetGlobalCompositeOperation: set "globalCompositeOperation" on "CanvasRenderingContext2D";
  SetImageSmoothingQuality: set "imageSmoothingQuality" on "CanvasRenderingContext2D";
  SetLineCap: set "lineCap" on "CanvasRenderingContext2D";
  SetLineJoin: set "lineJoin" on "CanvasRenderingContext2D";
  SetFillStyle: set "fillStyle" on "CanvasRenderingContext2D";
  SetStrokeStyle: set "strokeStyle" on "CanvasRenderingContext2D";
  SetFilter: set "filter" on "CanvasRenderingContext2D";
  SetFont: set "font" on "CanvasRenderingContext2D";
  SetDirection: set "direction" on "CanvasRenderingContext2D";
  SetLetterSpacing: set "letterSpacing" on "CanvasRenderingContext2D";
  SetWordSpacing: set "wordSpacing" on "CanvasRenderingContext2D";
  SetShadowColor: set "shadowColor" on "CanvasRenderingContext2D";
  SetTextAlign: set "textAlign" on "CanvasRenderingContext2D";
  SetTextBaseline: set "textBaseline" on "CanvasRenderingContext2D";
  SetFontStretch: set "fontStretch" on "CanvasRenderingContext2D";
  SetFontKerning: set "fontKerning" on "CanvasRenderingContext2D";
  SetFontVariantCaps: set "fontVariantCaps" on "CanvasRenderingContext2D";
  SetTextRendering: set "textRendering" on "CanvasRenderingContext2D";
  SetLang: set "lang" on "CanvasRenderingContext2D";
  CtxArc: execute "arc" on "CanvasRenderingContext2D";
  CtxArcTo: execute "arcTo" on "CanvasRenderingContext2D";
  CtxBezierCurveTo: execute "bezierCurveTo" on "CanvasRenderingContext2D";
  CtxQuadraticCurveTo: execute "quadraticCurveTo" on "CanvasRenderingContext2D";
  CtxClearRect: execute "clearRect" on "CanvasRenderingContext2D";
  CtxRect: execute "rect" on "CanvasRenderingContext2D";
  CtxRoundRect: execute "roundRect" on "CanvasRenderingContext2D";
  CtxRotate: execute "rotate" on "CanvasRenderingContext2D";
  CtxScale: execute "scale" on "CanvasRenderingContext2D";
  CtxEllipse: execute "ellipse" on "CanvasRenderingContext2D";
  CtxLineTo: execute "lineTo" on "CanvasRenderingContext2D";
  CtxMeasureText: execute "measureText" on "CanvasRenderingContext2D";
  CtxMoveTo: execute "moveTo" on "CanvasRenderingContext2D";
  CtxFillRect: execute "fillRect" on "CanvasRenderingContext2D";
  CtxFillText: execute "fillText" on "CanvasRenderingContext2D";
  CtxStrokeRect: execute "strokeRect" on "CanvasRenderingContext2D";
  CtxStrokeText: execute "strokeText" on "CanvasRenderingContext2D";
  CtxTranslate: execute "translate" on "CanvasRenderingContext2D";
  CtxTransform: execute "transform" on "CanvasRenderingContext2D";
  CtxSetTransform: execute "setTransform" on "CanvasRenderingContext2D";
  CtxFill: execute "fill" on "CanvasRenderingContext2D";
  CtxClip: execute "clip" on "CanvasRenderingContext2D";
  CtxStroke: execute "stroke" on "CanvasRenderingContext2D";
  CtxIsPointInPath: execute "isPointInPath" on "CanvasRenderingContext2D";
  CtxIsPointInStroke: execute "isPointInStroke" on "CanvasRenderingContext2D";
  CtxDrawImage: execute "drawImage" on "CanvasRenderingContext2D";
  CtxGetImageData: execute "getImageData" on "CanvasRenderingContext2D";
  PathMoveTo: execute "moveTo" on "Path2D";
  PathLineTo: execute "lineTo" on "Path2D";
  PathBezierCurveTo: execute "bezierCurveTo" on "Path2D";
  PathQuadraticCurveTo: execute "quadraticCurveTo" on "Path2D";
  PathArc: execute "arc" on "Path2D";
  PathArcTo: execute "arcTo" on "Path2D";
  PathEllipse: execute "ellipse" on "Path2D";
  PathRect: execute "rect" on "Path2D";
  PathRoundRect: execute "roundRect" on "Path2D";
  PathAddPath: execute "addPath" on "Path2D";
  CanvasGetContext: execute "getContext" on "HTMLCanvasElement";
  SvgCanvasGetContext: execute "getContext" on "SVGCanvas";
  CanvasSetWidth: set "width" on "HTMLCanvasElement";
  CanvasSetHeight: set "height" on "HTMLCanvasElement";
  SvgCanvasSetWidth: set "width" on "SVGCanvas";
  SvgCanvasSetHeight: set "height" on "SVGCanvas";
  ImageSetWidth: set "width" on "HTMLImageElement";
  ImageSetHeight: set "height" on "HTMLImageElement";
  ImageSetAlt: set "alt" on "HTMLImageElement";
}

/// `napi_bigint`; napi6 (and so `ValueType::BigInt`) is off in this build.
const NAPI_BIGINT: i32 = 9;

fn raw_type_of(env: sys::napi_env, value: sys::napi_value) -> Result<i32> {
  let mut t = 0;
  check_status!(unsafe { sys::napi_typeof(env, value, &mut t) })?;
  Ok(t)
}

/// Sets `message` as Blink's ApplyContextToException does: CreateDataProperty,
/// so it becomes a writable, enumerable and configurable own data property.
/// V8 formats `stack` on its first read; it is read first, so that it keeps
/// the message the error was created with, as in Chrome.
fn set_message(env: sys::napi_env, error: sys::napi_value, message: &str) {
  let mut value = ptr::null_mut();
  unsafe {
    sys::napi_get_named_property(env, error, c"stack".as_ptr(), &mut value);
    if sys::napi_create_string_utf8(
      env,
      message.as_ptr().cast(),
      message.len() as isize,
      &mut value,
    ) != sys::Status::napi_ok
    {
      return;
    }
    let property = sys::napi_property_descriptor {
      utf8name: c"message".as_ptr(),
      name: ptr::null_mut(),
      method: None,
      getter: None,
      setter: None,
      value,
      attributes: sys::PropertyAttributes::writable
        | sys::PropertyAttributes::enumerable
        | sys::PropertyAttributes::configurable,
      data: ptr::null_mut(),
    };
    sys::napi_define_properties(env, error, 1, &property);
  }
}

/// A TypeError as Chrome throws it from a binding (a conversion failure, an
/// argument count, an invalid enum value...): created with `msg`, then its
/// message set to `prefix` + `msg` (v8_binding_for_core.cc
/// ApplyContextToException), so `stack` keeps the bare `msg`. An error thrown
/// by user code (valueOf, toString, an iterator) is passed on as it is.
pub(crate) fn context_type_error(env: sys::napi_env, prefix: &str, msg: &str) -> Error {
  context_error(env, ErrorKind::TypeError, prefix, msg)
}

/// A RangeError as Chrome throws it from a binding, such as "Out of memory
/// at ImageData creation": `stack` keeps the bare `msg`, as in
/// [`context_type_error`].
pub(crate) fn context_range_error(env: sys::napi_env, prefix: &str, msg: &str) -> Error {
  context_error(env, ErrorKind::RangeError, prefix, msg)
}

fn context_error(env: sys::napi_env, kind: ErrorKind, prefix: &str, msg: &str) -> Error {
  let error = new_error(env, kind, msg);
  if let Some(error) = error {
    set_message(env, error, &format!("{prefix}{msg}"));
  }
  throw(env, error, msg)
}

/// The engine's own exception, now pending, with `prefix` added to its
/// message.
fn prefix_pending_exception(env: sys::napi_env, prefix: &str) -> Error {
  let mut exception = ptr::null_mut();
  if unsafe { sys::napi_get_and_clear_last_exception(env, &mut exception) } != sys::Status::napi_ok
  {
    return Error::new(Status::PendingException, prefix.to_owned());
  }
  if let Ok(ValueType::Object) = type_of(env, exception) {
    let message = (|| -> Result<String> {
      let mut message = ptr::null_mut();
      check_status!(unsafe {
        sys::napi_get_named_property(env, exception, c"message".as_ptr(), &mut message)
      })?;
      to_js_string(env, message)
    })();
    if let Ok(message) = message {
      set_message(env, exception, &format!("{prefix}{message}"));
    }
  }
  unsafe { sys::napi_throw(env, exception) };
  Error::new(Status::PendingException, prefix.to_owned())
}

#[derive(Clone, Copy)]
enum Hint {
  Number,
  String,
}

fn undefined(env: sys::napi_env) -> Result<sys::napi_value> {
  let mut value = ptr::null_mut();
  check_status!(unsafe { sys::napi_get_undefined(env, &mut value) })?;
  Ok(value)
}

fn get_property(
  env: sys::napi_env,
  object: sys::napi_value,
  key: sys::napi_value,
) -> Result<sys::napi_value> {
  let mut value = ptr::null_mut();
  check_status!(unsafe { sys::napi_get_property(env, object, key, &mut value) })?;
  Ok(value)
}

fn call(
  env: sys::napi_env,
  this: sys::napi_value,
  function: sys::napi_value,
  args: &[sys::napi_value],
) -> Result<sys::napi_value> {
  let mut result = ptr::null_mut();
  check_status!(unsafe {
    sys::napi_call_function(env, this, function, args.len(), args.as_ptr(), &mut result)
  })?;
  Ok(result)
}

fn is_callable(env: sys::napi_env, value: sys::napi_value) -> Result<bool> {
  Ok(raw_type_of(env, value)? == sys::ValueType::napi_function)
}

/// The intrinsics of a realm that the conversions use: Symbol.toPrimitive,
/// Symbol.iterator and Proxy, and the getters `resizable` and `detached` of
/// ArrayBuffer.prototype, read once, when the addon is registered in the
/// environment of the realm. Chrome uses those of its realm, or reads the
/// state itself, so a script that replaces globalThis.Symbol,
/// globalThis.Proxy or an ArrayBuffer getter later changes no conversion. A
/// worker thread has an environment and a realm of its own, and an
/// environment stays on its thread.
struct RealmIntrinsics {
  env: sys::napi_env,
  /// An object with the own data properties toPrimitive, iterator, Proxy,
  /// arrayBufferResizable and arrayBufferDetached, each undefined when it
  /// could not be read. An object, because napi_create_reference takes a
  /// symbol only from Node-API 10 on.
  holder: sys::napi_ref,
}

thread_local! {
  /// The intrinsics of the environments of this thread.
  static REALM_INTRINSICS: RefCell<Vec<RealmIntrinsics>> = const { RefCell::new(Vec::new()) };
}

/// Reads the intrinsics of the realm of `env` (see [`RealmIntrinsics`]).
/// napi-rs runs this once for each environment that registers the addon,
/// before any script can use it. Best effort: an intrinsic that cannot be
/// read then (a global replaced before the addon was loaded) stays
/// undefined, and does not fail the load.
// napi-rs registers the hook only outside `cargo test`.
#[cfg_attr(test, allow(dead_code))]
#[napi(module_exports)]
pub fn capture_realm_intrinsics(_exports: Object, env: Env) -> Result<()> {
  let env = env.raw();
  let read = |object: sys::napi_value, name: &std::ffi::CStr, kind: i32| {
    let mut value = ptr::null_mut();
    let status = unsafe { sys::napi_get_named_property(env, object, name.as_ptr(), &mut value) };
    if status != sys::Status::napi_ok {
      let mut exception = ptr::null_mut();
      unsafe { sys::napi_get_and_clear_last_exception(env, &mut exception) };
      return None;
    }
    (raw_type_of(env, value).ok()? == kind).then_some(value)
  };
  let mut global = ptr::null_mut();
  let mut undefined = ptr::null_mut();
  let mut holder = ptr::null_mut();
  check_status!(unsafe { sys::napi_get_global(env, &mut global) })?;
  check_status!(unsafe { sys::napi_get_undefined(env, &mut undefined) })?;
  check_status!(unsafe { sys::napi_create_object(env, &mut holder) })?;
  let symbol = read(global, c"Symbol", sys::ValueType::napi_function);
  let well_known = |name| symbol.and_then(|symbol| read(symbol, name, sys::ValueType::napi_symbol));
  let member =
    |utf8name: &std::ffi::CStr, value: Option<sys::napi_value>| sys::napi_property_descriptor {
      utf8name: utf8name.as_ptr(),
      name: ptr::null_mut(),
      method: None,
      getter: None,
      setter: None,
      value: value.unwrap_or(undefined),
      attributes: sys::PropertyAttributes::default,
      data: ptr::null_mut(),
    };
  // The getters of %ArrayBuffer.prototype%, the prototype of an ArrayBuffer
  // the engine makes (globalThis.ArrayBuffer may be another one).
  let mut buffer = ptr::null_mut();
  let mut prototype = ptr::null_mut();
  let prototype = (unsafe { sys::napi_create_arraybuffer(env, 0, ptr::null_mut(), &mut buffer) }
    == sys::Status::napi_ok
    && unsafe { sys::napi_get_prototype(env, buffer, &mut prototype) } == sys::Status::napi_ok)
    .then_some(prototype);
  let object = read(global, c"Object", sys::ValueType::napi_function);
  let describe = object.and_then(|object| {
    read(
      object,
      c"getOwnPropertyDescriptor",
      sys::ValueType::napi_function,
    )
  });
  let array_buffer_getter = |name: &std::ffi::CStr| {
    let (prototype, object, describe) = (prototype?, object?, describe?);
    let mut key = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    let described = unsafe {
      sys::napi_create_string_utf8(env, name.as_ptr(), name.to_bytes().len() as isize, &mut key)
        == sys::Status::napi_ok
        && sys::napi_call_function(
          env,
          object,
          describe,
          2,
          [prototype, key].as_ptr(),
          &mut descriptor,
        ) == sys::Status::napi_ok
    };
    if !described {
      let mut exception = ptr::null_mut();
      unsafe { sys::napi_get_and_clear_last_exception(env, &mut exception) };
      return None;
    }
    (raw_type_of(env, descriptor).ok()? == sys::ValueType::napi_object)
      .then(|| read(descriptor, c"get", sys::ValueType::napi_function))
      .flatten()
  };
  let members = [
    member(c"toPrimitive", well_known(c"toPrimitive")),
    member(c"iterator", well_known(c"iterator")),
    member(
      c"Proxy",
      read(global, c"Proxy", sys::ValueType::napi_function),
    ),
    member(c"arrayBufferResizable", array_buffer_getter(c"resizable")),
    member(c"arrayBufferDetached", array_buffer_getter(c"detached")),
  ];
  check_status!(unsafe {
    sys::napi_define_properties(env, holder, members.len(), members.as_ptr())
  })?;
  let mut reference = ptr::null_mut();
  check_status!(unsafe { sys::napi_create_reference(env, holder, 1, &mut reference) })?;
  let replaced = REALM_INTRINSICS.with_borrow_mut(|list| {
    let replaced = list
      .iter()
      .position(|intrinsics| intrinsics.env == env)
      .map(|index| list.swap_remove(index));
    list.push(RealmIntrinsics {
      env,
      holder: reference,
    });
    replaced
  });
  match replaced {
    // Node gives each registration an environment of its own, so this does
    // not happen; the cleanup hook of the first one is still there.
    Some(old) => {
      unsafe { sys::napi_delete_reference(env, old.holder) };
    }
    None => {
      // Removes the entry when the environment ends, so that a later
      // environment at the same address does not find it. Node deletes the
      // reference itself then.
      unsafe { sys::napi_add_env_cleanup_hook(env, Some(forget_realm_intrinsics), env.cast()) };
    }
  }
  Ok(())
}

#[cfg_attr(test, allow(dead_code))]
unsafe extern "C" fn forget_realm_intrinsics(env: *mut std::ffi::c_void) {
  let _ = REALM_INTRINSICS.try_with(|list| {
    list
      .borrow_mut()
      .retain(|intrinsics| intrinsics.env.cast() != env)
  });
}

/// The intrinsic `name` (a member of [`RealmIntrinsics::holder`]) of the
/// realm of `env`; None when it could not be read at registration.
fn intrinsic(env: sys::napi_env, name: &std::ffi::CStr) -> Result<Option<sys::napi_value>> {
  let Some(reference) = REALM_INTRINSICS.with_borrow(|list| {
    list
      .iter()
      .find(|intrinsics| intrinsics.env == env)
      .map(|intrinsics| intrinsics.holder)
  }) else {
    return Ok(None);
  };
  let mut holder = ptr::null_mut();
  check_status!(unsafe { sys::napi_get_reference_value(env, reference, &mut holder) })?;
  if holder.is_null() {
    return Ok(None);
  }
  // An own data property of the holder: no user code runs.
  let mut value = ptr::null_mut();
  check_status!(unsafe { sys::napi_get_named_property(env, holder, name.as_ptr(), &mut value) })?;
  Ok((raw_type_of(env, value)? != sys::ValueType::napi_undefined).then_some(value))
}

/// Blink's IsResizableByUserJavaScript() of `buffer`, an ArrayBuffer that
/// is not shared: resizable and not detached. Calls the built-in getters
/// `resizable` and `detached` of the realm (see [`RealmIntrinsics`]) with
/// the buffer as receiver: they read its internal state, so no own
/// property, prototype, Proxy or later patched getter changes the answer,
/// and no script runs. Not resizable without the `resizable` getter (a Node
/// with no resizable buffers); not detached without the `detached` one.
pub(crate) fn is_resizable_by_script(env: sys::napi_env, buffer: sys::napi_value) -> Result<bool> {
  let flag = |name: &std::ffi::CStr| -> Result<bool> {
    let Some(getter) = intrinsic(env, name)? else {
      return Ok(false);
    };
    let value = call(env, buffer, getter, &[])?;
    let mut result = false;
    Ok(
      unsafe { sys::napi_get_value_bool(env, value, &mut result) } == sys::Status::napi_ok
        && result,
    )
  };
  Ok(flag(c"arrayBufferResizable")? && !flag(c"arrayBufferDetached")?)
}

/// The get trap of a [`relay`]: the `value` of its handler, `this`.
unsafe extern "C" fn relay_get(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> sys::napi_value {
  let mut handler = ptr::null_mut();
  let mut value = ptr::null_mut();
  unsafe {
    if sys::napi_get_cb_info(
      env,
      info,
      ptr::null_mut(),
      ptr::null_mut(),
      &mut handler,
      ptr::null_mut(),
    ) == sys::Status::napi_ok
    {
      sys::napi_get_named_property(env, handler, c"value".as_ptr(), &mut value);
    }
  }
  value
}

/// `new Proxy(target, { get: () => value })`, built without user code (the
/// handler members are defined, not set). When `value` is the non-callable
/// Symbol.toPrimitive of `target`, the engine's ToPrimitive of it throws the
/// TypeError it throws for `target`, without a second read.
///
/// Two differences remain. V8 names a Proxy in the message by its target:
/// the V8 of Node 24 names it as it names the target; a newer V8 (Chrome
/// 155's) falls back to the class name of the Proxy, Object, when the target
/// has no constructor name to show, so an Array or a Date reads
/// '[object Object]' there, not '[object Array]' or '[object Date]'. And the
/// get trap's invariant check gets the own property descriptor of `target`,
/// which runs its getOwnPropertyDescriptor trap when `target` is a Proxy.
fn relay(
  env: sys::napi_env,
  target: sys::napi_value,
  value: sys::napi_value,
) -> Result<sys::napi_value> {
  let Some(proxy) = intrinsic(env, c"Proxy")? else {
    return Err(Error::from_reason("no Proxy"));
  };
  let mut get = ptr::null_mut();
  let mut handler = ptr::null_mut();
  let mut relay = ptr::null_mut();
  check_status!(unsafe {
    sys::napi_create_function(
      env,
      c"get".as_ptr(),
      3,
      Some(relay_get),
      ptr::null_mut(),
      &mut get,
    )
  })?;
  check_status!(unsafe { sys::napi_create_object(env, &mut handler) })?;
  let member = |utf8name: &std::ffi::CStr, value| sys::napi_property_descriptor {
    utf8name: utf8name.as_ptr(),
    name: ptr::null_mut(),
    method: None,
    getter: None,
    setter: None,
    value,
    attributes: sys::PropertyAttributes::default,
    data: ptr::null_mut(),
  };
  let members = [member(c"get", get), member(c"value", value)];
  check_status!(unsafe {
    sys::napi_define_properties(env, handler, members.len(), members.as_ptr())
  })?;
  let args = [target, handler];
  check_status!(unsafe {
    sys::napi_new_instance(env, proxy, args.len(), args.as_ptr(), &mut relay)
  })?;
  Ok(relay)
}

/// ToPrimitive (ECMA-262 7.1.1) of an object or function, step by step, so
/// that an exception from user code passes as it is and only the engine's own
/// failures get `prefix`.
fn to_primitive(
  env: sys::napi_env,
  value: sys::napi_value,
  hint: Hint,
  prefix: &str,
) -> Result<sys::napi_value> {
  let exotic = match intrinsic(env, c"toPrimitive")? {
    Some(key) => get_property(env, value, key)?,
    // Not readable when the addon was registered: as if undefined.
    None => undefined(env)?,
  };
  match raw_type_of(env, exotic)? {
    sys::ValueType::napi_undefined | sys::ValueType::napi_null => {}
    sys::ValueType::napi_function => {
      let hint = match hint {
        Hint::Number => "number",
        Hint::String => "string",
      };
      let hint = unsafe { <&str as ToNapiValue>::to_napi_value(env, hint)? };
      let result = call(env, value, exotic, &[hint])?;
      if is_object(env, result)? {
        return Err(context_type_error(
          env,
          prefix,
          "Cannot convert object to primitive value",
        ));
      }
      return Ok(result);
    }
    _ => {
      // Not callable: let the engine throw its own TypeError, then add the
      // prefix to it. The engine's ToPrimitive would read
      // Symbol.toPrimitive of `value` again (Chrome reads it once), so it
      // runs on a relay that returns the value read above.
      let target = relay(env, value, exotic).unwrap_or(value);
      let mut result = ptr::null_mut();
      let status = unsafe {
        match hint {
          Hint::Number => sys::napi_coerce_to_number(env, target, &mut result),
          Hint::String => sys::napi_coerce_to_string(env, target, &mut result),
        }
      };
      if status != sys::Status::napi_ok && is_exception_pending(env) {
        return Err(prefix_pending_exception(env, prefix));
      }
      check_status!(status)?;
      return Ok(result);
    }
  }
  // OrdinaryToPrimitive.
  let names: [&std::ffi::CStr; 2] = match hint {
    Hint::Number => [c"valueOf", c"toString"],
    Hint::String => [c"toString", c"valueOf"],
  };
  for name in names {
    let mut method = ptr::null_mut();
    check_status!(unsafe { sys::napi_get_named_property(env, value, name.as_ptr(), &mut method) })?;
    if is_callable(env, method)? {
      let result = call(env, value, method, &[])?;
      if !is_object(env, result)? {
        return Ok(result);
      }
    }
  }
  Err(context_type_error(
    env,
    prefix,
    "Cannot convert object to primitive value",
  ))
}

/// WTF::String::Number(double), which Blink uses for the numbers in its
/// messages: ToPrecision(6) of double-conversion's ECMAScript converter
/// (rounded half up), exponential form when the exponent is below -6 or at
/// least 6, and trailing zeros cut only without an exponent
/// (wtf_string.cc, dtoa.cc NumberToFixedPrecisionString).
pub(crate) fn number_to_string(value: f64) -> String {
  if value.is_nan() {
    return "NaN".to_owned();
  }
  if value.is_infinite() {
    return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
  }
  if value == 0.0 {
    return "0".to_owned();
  }
  let sign = if value < 0.0 { "-" } else { "" };
  // Enough digits to round to six, half up.
  let exact = format!("{:.40e}", value.abs());
  let (mantissa, exponent) = exact.split_once('e').unwrap_or((&exact, "0"));
  let mut exponent: i32 = exponent.parse().unwrap_or(0);
  let all: Vec<u8> = mantissa
    .bytes()
    .filter(u8::is_ascii_digit)
    .map(|digit| digit - b'0')
    .collect();
  let mut digits = all[..6].to_vec();
  if all[6] >= 5 {
    let mut index = 5;
    loop {
      if digits[index] < 9 {
        digits[index] += 1;
        break;
      }
      digits[index] = 0;
      if index == 0 {
        // 999999.5 -> 1.00000e+6
        digits.insert(0, 1);
        digits.pop();
        exponent += 1;
        break;
      }
      index -= 1;
    }
  }
  let digits: String = digits
    .iter()
    .map(|digit| char::from(b'0' + digit))
    .collect();
  if !(-6..6).contains(&exponent) {
    let exponent_sign = if exponent < 0 { '-' } else { '+' };
    return format!(
      "{sign}{}.{}e{exponent_sign}{}",
      &digits[..1],
      &digits[1..],
      exponent.abs()
    );
  }
  let fixed = if exponent < 0 {
    format!("0.{}{digits}", "0".repeat((-exponent - 1) as usize))
  } else {
    let (int, fraction) = digits.split_at(exponent as usize + 1);
    format!("{int}.{fraction}")
  };
  let fixed = fixed.trim_end_matches('0').trim_end_matches('.');
  format!("{sign}{fixed}")
}

/// WebIDL `unrestricted double`: ToNumber. Errors from user code pass as
/// they are; the engine's own ones get `prefix`.
pub(crate) fn to_number(env: sys::napi_env, value: sys::napi_value, prefix: &str) -> Result<f64> {
  let mut number = 0.0;
  if unsafe { sys::napi_get_value_double(env, value, &mut number) } == sys::Status::napi_ok {
    return Ok(number);
  }
  match raw_type_of(env, value)? {
    sys::ValueType::napi_symbol => Err(context_type_error(
      env,
      prefix,
      "Cannot convert a Symbol value to a number",
    )),
    NAPI_BIGINT => Err(context_type_error(
      env,
      prefix,
      "Cannot convert a BigInt value to a number",
    )),
    sys::ValueType::napi_object | sys::ValueType::napi_function => {
      let primitive = to_primitive(env, value, Hint::Number, prefix)?;
      to_number(env, primitive, prefix)
    }
    // undefined, null, boolean, string: cannot throw.
    _ => {
      let mut result = ptr::null_mut();
      check_status!(unsafe { sys::napi_coerce_to_number(env, value, &mut result) })?;
      check_status!(unsafe { sys::napi_get_value_double(env, result, &mut number) })?;
      Ok(number)
    }
  }
}

/// A WebIDL `unrestricted double` argument or attribute value, converted in
/// the callback glue, before napi-rs borrows the receiver: valueOf may use
/// the receiver, as in Chrome.
pub struct Double<S>(pub f64, PhantomData<S>);

impl<S: Site> FromNapiValue for Double<S> {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    to_number(env, value, S::PREFIX).map(|v| Self(v, PhantomData))
  }
}

/// An `optional unrestricted double` argument with no default: None when it
/// is undefined (or missing), else ToNumber.
pub struct OptionalDouble<S>(pub Option<f64>, PhantomData<S>);

impl<S: Site> FromNapiValue for OptionalDouble<S> {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    if raw_type_of(env, value)? == sys::ValueType::napi_undefined {
      return Ok(Self(None, PhantomData));
    }
    to_number(env, value, S::PREFIX).map(|v| Self(Some(v), PhantomData))
  }
}

/// A WebIDL `boolean` argument: ToBoolean, which never throws. A missing
/// argument is undefined, so false, the default of every optional boolean
/// here.
pub struct Boolean(pub bool);

impl FromNapiValue for Boolean {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    let mut result = ptr::null_mut();
    check_status!(unsafe { sys::napi_coerce_to_bool(env, value, &mut result) })?;
    Ok(Self(unsafe { bool::from_napi_value(env, result)? }))
  }
}

/// WebIDL `DOMString`: ToString. Errors from user code pass as they are; the
/// engine's own ones get `prefix`.
pub(crate) fn to_dom_string(
  env: sys::napi_env,
  value: sys::napi_value,
  prefix: &str,
) -> Result<String> {
  match raw_type_of(env, value)? {
    sys::ValueType::napi_string => unsafe { String::from_napi_value(env, value) },
    sys::ValueType::napi_symbol => Err(context_type_error(
      env,
      prefix,
      "Cannot convert a Symbol value to a string",
    )),
    sys::ValueType::napi_object | sys::ValueType::napi_function => {
      let primitive = to_primitive(env, value, Hint::String, prefix)?;
      to_dom_string(env, primitive, prefix)
    }
    // undefined, null, boolean, number, bigint: cannot throw.
    _ => to_js_string(env, value),
  }
}

/// An `optional CanvasFillRule fillRule = "nonzero"` argument: undefined is
/// the default; anything else is converted with ToString and must be one of
/// the enum values, case-sensitive.
pub(crate) fn fill_rule(
  env: sys::napi_env,
  value: sys::napi_value,
  prefix: &str,
) -> Result<FillType> {
  if raw_type_of(env, value)? == sys::ValueType::napi_undefined {
    return Ok(FillType::Winding);
  }
  match to_dom_string(env, value, prefix)?.as_str() {
    "nonzero" => Ok(FillType::Winding),
    "evenodd" => Ok(FillType::EvenOdd),
    other => Err(context_type_error(
      env,
      prefix,
      &format!("The provided value '{other}' is not a valid enum value of type CanvasFillRule."),
    )),
  }
}

/// A WebIDL `DOMString` argument or attribute value, converted in the
/// callback glue, before napi-rs borrows the receiver: toString may use the
/// receiver, as in Chrome.
pub struct DomString<S>(pub String, PhantomData<S>);

impl<S: Site> FromNapiValue for DomString<S> {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    to_dom_string(env, value, S::PREFIX).map(|v| Self(v, PhantomData))
  }
}

/// WebIDL `sequence<T>` (Blink's NativeValueTraits<IDLSequence<T>>,
/// native_value_traits_impl.h:994-1031), each value converted with
/// `convert` as it is read:
///
/// - an Array is read by index, never with its @@iterator, own or
///   inherited (CreateIDLSequenceFromV8ArraySlow, :866-972): Get(i) for each
///   index, the length read again each time, since a conversion may change
///   it. An array longer than `max_length`, the most values Blink's vector of
///   T holds, is a RangeError.
/// - any other object with its iterator (ScriptIterator::FromIterable and
///   Next, script_iterator.cc): each step calls next(), then gets `value`,
///   then `done`. The iterator is never closed: return() is not called when
///   a step or a conversion throws.
///
/// Each value read makes handles, freed only when their handle scope
/// closes, so the values are read in blocks (see [`Blocks`]). `T` must not
/// hold a handle.
pub(crate) fn sequence<T>(
  env: sys::napi_env,
  value: sys::napi_value,
  prefix: &str,
  max_length: u32,
  mut convert: impl FnMut(sys::napi_value) -> Result<T>,
) -> Result<Vec<T>> {
  let error = |msg: &str| Err(context_type_error(env, prefix, msg));
  let mut is_array = false;
  check_status!(unsafe { sys::napi_is_array(env, value, &mut is_array) })?;
  if is_array {
    let length = array_length(env, value)?;
    if length > max_length {
      return Err(context_range_error(
        env,
        prefix,
        "Array length exceeds supported limit.",
      ));
    }
    // Blink reserves `length`; a sparse array can be long.
    let mut values = Vec::with_capacity(length.min(SEQUENCE_BLOCK) as usize);
    let mut blocks = Blocks::new(env);
    let mut index = 0;
    while index < array_length(env, value)? {
      blocks.next_value()?;
      let mut item = ptr::null_mut();
      check_status!(unsafe { sys::napi_get_element(env, value, index, &mut item) })?;
      values.push(convert(item)?);
      index += 1;
    }
    return Ok(values);
  }
  if !is_object(env, value)? {
    return error("The provided value cannot be converted to a sequence.");
  }
  let method = match intrinsic(env, c"iterator")? {
    Some(key) => get_property(env, value, key)?,
    // Not readable when the addon was registered: as if undefined.
    None => undefined(env)?,
  };
  match raw_type_of(env, method)? {
    sys::ValueType::napi_function => {}
    sys::ValueType::napi_undefined | sys::ValueType::napi_null => {
      return error("The object must have a callable @@iterator property.");
    }
    _ => return error("@@iterator must be a callable."),
  }
  let iterator = call(env, value, method, &[])?;
  if !is_object(env, iterator)? {
    return error("Iterator object must be an object.");
  }
  let mut next = ptr::null_mut();
  check_status!(unsafe {
    sys::napi_get_named_property(env, iterator, c"next".as_ptr(), &mut next)
  })?;
  if !is_callable(env, next)? {
    return error("Expected next() function on iterator.");
  }
  let mut values = Vec::new();
  let mut blocks = Blocks::new(env);
  loop {
    blocks.next_value()?;
    let result = call(env, iterator, next, &[])?;
    if !is_object(env, result)? {
      return error("Expected iterator.next() to return an Object.");
    }
    let mut item = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_get_named_property(env, result, c"value".as_ptr(), &mut item)
    })?;
    let mut done = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_get_named_property(env, result, c"done".as_ptr(), &mut done)
    })?;
    let mut done_bool = ptr::null_mut();
    check_status!(unsafe { sys::napi_coerce_to_bool(env, done, &mut done_bool) })?;
    if unsafe { bool::from_napi_value(env, done_bool)? } {
      return Ok(values);
    }
    values.push(convert(item)?);
  }
}

/// How many values of a sequence one handle scope reads.
const SEQUENCE_BLOCK: u32 = 1024;

/// A napi handle scope, closed when dropped.
struct HandleScope {
  env: sys::napi_env,
  scope: sys::napi_handle_scope,
}

impl HandleScope {
  fn open(env: sys::napi_env) -> Result<Self> {
    let mut scope = ptr::null_mut();
    check_status!(unsafe { sys::napi_open_handle_scope(env, &mut scope) })?;
    Ok(Self { env, scope })
  }
}

impl Drop for HandleScope {
  fn drop(&mut self) {
    // A pending exception stays pending: napi keeps it in a persistent
    // handle, not in this scope.
    unsafe { sys::napi_close_handle_scope(self.env, self.scope) };
  }
}

/// The handle scopes of a [`sequence`] conversion: setLineDash of a sparse
/// array of `MAX_DOUBLE_SEQUENCE_LENGTH` holes would otherwise hold two
/// handles for each hole, some 4 GB, until the call returns. The first
/// `SEQUENCE_BLOCK` values are read in the caller's scope, so a short
/// sequence opens none; each later block of `SEQUENCE_BLOCK` values is read
/// in a scope of its own, closed when the next one opens or when this is
/// dropped.
struct Blocks {
  env: sys::napi_env,
  /// The values read so far.
  read: u64,
  scope: Option<HandleScope>,
}

impl Blocks {
  fn new(env: sys::napi_env) -> Self {
    Self {
      env,
      read: 0,
      scope: None,
    }
  }

  /// Called before each value is read.
  fn next_value(&mut self) -> Result<()> {
    if self.read != 0 && self.read.is_multiple_of(u64::from(SEQUENCE_BLOCK)) {
      // Scopes close in the reverse order they opened: the old one first.
      self.scope = None;
      self.scope = Some(HandleScope::open(self.env)?);
    }
    self.read += 1;
    Ok(())
  }
}

/// The length of an Array (no user code runs).
fn array_length(env: sys::napi_env, array: sys::napi_value) -> Result<u32> {
  let mut length = 0;
  check_status!(unsafe { sys::napi_get_array_length(env, array, &mut length) })?;
  Ok(length)
}

/// A WebIDL `sequence<unrestricted double>` argument (see [`sequence`]),
/// each value converted with ToNumber in turn.
pub struct DoubleSequence<S>(pub Vec<f64>, PhantomData<S>);

/// The most values Blink's `Vector<double>` holds:
/// PartitionAlloc's MaxAllocationSize() (partition_alloc_constants.h:466,
/// the same 2^31 - 2^21 bytes as ImageData data) / 8
/// (partition_allocator.h:29, vector.h:1756).
const MAX_DOUBLE_SEQUENCE_LENGTH: u32 =
  (crate::image::MAX_DATA_BYTES / std::mem::size_of::<f64>()) as u32;

impl<S: Site> FromNapiValue for DoubleSequence<S> {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    sequence(env, value, S::PREFIX, MAX_DOUBLE_SEQUENCE_LENGTH, |item| {
      to_number(env, item, S::PREFIX)
    })
    .map(|values| Self(values, PhantomData))
  }
}

/// WebIDL `unsigned long` (ToNumber, then ToUint32: NaN and infinities are
/// 0, the rest is truncated modulo 2^32). Errors from user code pass as they
/// are; the engine's own ones get `prefix`.
pub(crate) fn to_unsigned_long(
  env: sys::napi_env,
  value: sys::napi_value,
  prefix: &str,
) -> Result<u32> {
  to_number(env, value, prefix).map(to_uint32)
}

/// WebIDL `[EnforceRange] long` (v8_binding_for_core.cc EnforceRange):
/// ToNumber, then a TypeError for NaN, an infinity, or a value outside the
/// long range once truncated. Errors from user code pass as they are; the
/// engine's own ones get `prefix`.
pub(crate) fn enforce_range_long(
  env: sys::napi_env,
  value: sys::napi_value,
  prefix: &str,
) -> Result<i32> {
  let x = to_number(env, value, prefix)?;
  if x.is_nan() {
    return Err(context_type_error(
      env,
      prefix,
      "Value is not of type 'long'.",
    ));
  }
  if x.is_infinite() {
    return Err(context_type_error(
      env,
      prefix,
      "Value is infinite and not of type 'long'.",
    ));
  }
  let x = x.trunc();
  if x < f64::from(i32::MIN) || x > f64::from(i32::MAX) {
    return Err(context_type_error(
      env,
      prefix,
      "Value is outside the 'long' value range.",
    ));
  }
  Ok(x as i32)
}

/// An `[EnforceRange] long` argument: see [`enforce_range_long`].
pub struct EnforceRangeLong<S>(pub i32, PhantomData<S>);

impl<S: Site> FromNapiValue for EnforceRangeLong<S> {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    enforce_range_long(env, value, S::PREFIX).map(|x| Self(x, PhantomData))
  }
}

/// ToUint32 of a number: NaN and infinities are 0, the rest is truncated
/// modulo 2^32.
fn to_uint32(x: f64) -> u32 {
  if !x.is_finite() {
    return 0;
  }
  x.trunc().rem_euclid(4_294_967_296.0) as u32
}

/// A WebIDL `unsigned long` argument or attribute value: ToNumber, then
/// ToUint32. Errors from user code pass as they are; the engine's own ones
/// (Symbol, BigInt) get the prefix of `S`.
pub struct UnsignedLong<S>(pub u32, PhantomData<S>);

impl<S: Site> FromNapiValue for UnsignedLong<S> {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    to_number(env, value, S::PREFIX).map(|x| Self(to_uint32(x), PhantomData))
  }
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

  /// `unrestricted double` member: ToNumber. The engine's own errors name
  /// the member, as in Chrome: "Failed to read the 'x' property from
  /// 'DOMPointInit': Cannot convert a Symbol value to a number".
  fn number(&self, key: &str) -> Result<Option<f64>> {
    let Some(v) = member(self.env, self.value, key)? else {
      return Ok(None);
    };
    // A number needs no conversion, so no error prefix either.
    let mut number = 0.0;
    if unsafe { sys::napi_get_value_double(self.env, v, &mut number) } == sys::Status::napi_ok {
      return Ok(Some(number));
    }
    let prefix = format!(
      "{}Failed to read the '{key}' property from '{}': ",
      self.prefix, self.name
    );
    to_number(self.env, v, &prefix).map(Some)
  }
}

/// Iterates `iterable` with its @@iterator `method` like Blink's
/// ScriptIterator (bindings/core/v8/script_iterator.cc): `next` is read once,
/// each step reads `value` and then `done`, and `convert` runs on each value
/// before the next step. Nothing calls return() when a conversion throws.
fn iterate<T>(
  env: sys::napi_env,
  iterable: sys::napi_value,
  method: sys::napi_value,
  prefix: &str,
  mut convert: impl FnMut(sys::napi_value) -> Result<T>,
) -> Result<Vec<T>> {
  let iterator = call(env, iterable, method, &[])?;
  if !is_object(env, iterator)? {
    return Err(context_type_error(
      env,
      prefix,
      "Iterator object must be an object.",
    ));
  }
  let mut next = ptr::null_mut();
  check_status!(unsafe {
    sys::napi_get_named_property(env, iterator, c"next".as_ptr(), &mut next)
  })?;
  if !is_callable(env, next)? {
    return Err(context_type_error(
      env,
      prefix,
      "Expected next() function on iterator.",
    ));
  }
  let mut values = Vec::new();
  loop {
    let result = call(env, iterator, next, &[])?;
    if !is_object(env, result)? {
      return Err(context_type_error(
        env,
        prefix,
        "Expected iterator.next() to return an Object.",
      ));
    }
    let mut value = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_get_named_property(env, result, c"value".as_ptr(), &mut value)
    })?;
    let mut done = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_get_named_property(env, result, c"done".as_ptr(), &mut done)
    })?;
    let mut done_bool = ptr::null_mut();
    check_status!(unsafe { sys::napi_coerce_to_bool(env, done, &mut done_bool) })?;
    if unsafe { bool::from_napi_value(env, done_bool)? } {
      return Ok(values);
    }
    values.push(convert(value)?);
  }
}

/// One radius of roundRect(): WebIDL `(unrestricted double or DOMPointInit)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Radius {
  Number(f64),
  /// The x and y of a DOMPointInit.
  Point(f64, f64),
}

/// `(unrestricted double or DOMPointInit)`: undefined, null and any object
/// are a DOMPointInit (every member read, in order: w, x, y, z); anything
/// else goes through ToNumber.
fn radius(env: sys::napi_env, value: sys::napi_value, prefix: &str) -> Result<Radius> {
  match raw_type_of(env, value)? {
    sys::ValueType::napi_undefined | sys::ValueType::napi_null => Ok(Radius::Point(0.0, 0.0)),
    sys::ValueType::napi_object | sys::ValueType::napi_function => {
      let dictionary = Dictionary {
        env,
        value,
        prefix,
        name: "DOMPointInit",
      };
      dictionary.number("w")?;
      let x = dictionary.number("x")?;
      let y = dictionary.number("y")?;
      dictionary.number("z")?;
      Ok(Radius::Point(x.unwrap_or(0.0), y.unwrap_or(0.0)))
    }
    _ => to_number(env, value, prefix).map(Radius::Number),
  }
}

/// The `radii` argument of roundRect(): `optional (unrestricted double or
/// DOMPointInit or sequence<(unrestricted double or DOMPointInit)>) radii = 0`.
/// An object with @@iterator is a sequence (read through the iterator, no
/// array fast path), any other object a DOMPointInit. Converted in the
/// callback glue, so a getter may use the receiver, as in Chrome.
pub struct RoundRectRadii<S>(pub(crate) Vec<Radius>, PhantomData<S>);

impl<S: Site> FromNapiValue for RoundRectRadii<S> {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    let radii = match raw_type_of(env, value)? {
      sys::ValueType::napi_undefined => vec![Radius::Number(0.0)],
      sys::ValueType::napi_object | sys::ValueType::napi_function => {
        let method = match intrinsic(env, c"iterator")? {
          Some(key) => get_property(env, value, key)?,
          // Not readable when the addon was registered: as if undefined.
          None => undefined(env)?,
        };
        match raw_type_of(env, method)? {
          sys::ValueType::napi_undefined | sys::ValueType::napi_null => {
            vec![radius(env, value, S::PREFIX)?]
          }
          sys::ValueType::napi_function => iterate(env, value, method, S::PREFIX, |item| {
            radius(env, item, S::PREFIX)
          })?,
          _ => {
            return Err(context_type_error(
              env,
              S::PREFIX,
              "@@iterator must be a function",
            ));
          }
        }
      }
      _ => vec![radius(env, value, S::PREFIX)?],
    };
    Ok(Self(radii, PhantomData))
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
pub(crate) const PATH2D_CONSTRUCTOR: &str = "Failed to construct 'Path2D': ";
pub(crate) const CREATE_IMAGE_DATA: &str =
  "Failed to execute 'createImageData' on 'CanvasRenderingContext2D': ";
pub(crate) const GET_IMAGE_DATA: &str =
  "Failed to execute 'getImageData' on 'CanvasRenderingContext2D': ";
pub(crate) const PUT_IMAGE_DATA: &str =
  "Failed to execute 'putImageData' on 'CanvasRenderingContext2D': ";
pub(crate) const CANVAS_GET_CONTEXT: &str =
  "Failed to execute 'getContext' on 'HTMLCanvasElement': ";
pub(crate) const SVG_CANVAS_GET_CONTEXT: &str = "Failed to execute 'getContext' on 'SVGCanvas': ";
pub(crate) const CREATE_PATTERN: &str =
  "Failed to execute 'createPattern' on 'CanvasRenderingContext2D': ";
pub(crate) const PATTERN_SET_TRANSFORM: &str =
  "Failed to execute 'setTransform' on 'CanvasPattern': ";

/// `ImageDataSettings` (core/html/canvas/image_data_settings.idl).
#[derive(Clone, Copy, Debug, Default)]
pub struct ImageDataSettings {
  /// The colorSpace member, a value of the enum. Whether it is supported is
  /// checked later, by [`Self::color_space`].
  color_space: Option<&'static str>,
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
    Ok(Self { color_space })
  }

  /// The color space; None: the caller's default (the context color space, or
  /// srgb for the ImageData constructor). An enum value that is not enabled
  /// throws here, not in [`Self::from_js`]: ImageData::ValidateAndCreate
  /// checks it after the size (image_data.cc:113).
  pub(crate) fn color_space(&self, env: sys::napi_env, prefix: &str) -> Result<Option<ColorSpace>> {
    self
      .color_space
      .map(|cs| supported_color_space(env, prefix, cs))
      .transpose()
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

/// A matrix dictionary argument: None when it is undefined or null (`{}`), a
/// TypeError naming `type_name` when it is not an object.
fn matrix_dictionary(
  env: sys::napi_env,
  value: Option<sys::napi_value>,
  prefix: &str,
  type_name: &str,
) -> Result<Option<sys::napi_value>> {
  let Some(value) = present(env, value)? else {
    return Ok(None);
  };
  if !is_object(env, value)? {
    return Err(type_error(
      env,
      &format!("{prefix}The provided value is not of type '{type_name}'."),
    ));
  }
  Ok(Some(value))
}

/// The DOMMatrix2DInit members, in the order WebIDL reads them: a..f, then
/// m11, m12, m21, m22, m41, m42.
fn matrix_2d_members(
  env: sys::napi_env,
  value: sys::napi_value,
  prefix: &str,
) -> Result<[Option<f64>; 12]> {
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
  Ok(members)
}

/// ValidateAndFixup2D (dom_matrix_read_only.cc:48-76): a and m11 (and so on)
/// must agree when both are given, two NaNs agree; then [m11, m12, m21, m22,
/// m41, m42], each from the m-member, else its alias, else the identity.
fn fixup_2d(env: sys::napi_env, prefix: &str, members: [Option<f64>; 12]) -> Result<[f64; 6]> {
  let (short, long) = members.split_at(6);
  let mut matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
  for i in 0..6 {
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

/// `DOMMatrix2DInit` converted and fixed up like DOMMatrixReadOnly::fromMatrix2D
/// (core/geometry/dom_matrix_read_only.cc:179): [m11, m12, m21, m22, m41, m42].
/// Undefined or null is `{}` (the identity).
pub(crate) fn dom_matrix_2d_init(
  env: sys::napi_env,
  value: Option<sys::napi_value>,
  prefix: &str,
) -> Result<[f64; 6]> {
  match matrix_dictionary(env, value, prefix, "DOMMatrix2DInit")? {
    Some(value) => fixup_2d(env, prefix, matrix_2d_members(env, value, prefix)?),
    None => Ok([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
  }
}

/// `DOMMatrixInit` converted and checked like DOMMatrixReadOnly::fromMatrix
/// (dom_matrix_read_only.cc:78-103, 192-213), for its 2D part only: [m11,
/// m12, m21, m22, m41, m42]. Every member is read, the 3D ones after is2D;
/// they only matter to the is2D check. Undefined or null is `{}`.
pub(crate) fn dom_matrix_init_2d_part(
  env: sys::napi_env,
  value: Option<sys::napi_value>,
  prefix: &str,
) -> Result<[f64; 6]> {
  let Some(value) = matrix_dictionary(env, value, prefix, "DOMMatrixInit")? else {
    return Ok([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
  };
  let members = matrix_2d_members(env, value, prefix)?;
  let dictionary = Dictionary {
    env,
    value,
    prefix,
    name: "DOMMatrixInit",
  };
  let is_2d = dictionary.boolean("is2D")?;
  // m13, m14, m23, m24, m31, m32, m33, m34, m43, m44 and their identity
  // values. C++ truthiness: NaN is not 0, so it makes the matrix 3D.
  let mut is_3d = false;
  for (key, identity) in [
    ("m13", 0.0),
    ("m14", 0.0),
    ("m23", 0.0),
    ("m24", 0.0),
    ("m31", 0.0),
    ("m32", 0.0),
    ("m33", 1.0),
    ("m34", 0.0),
    ("m43", 0.0),
    ("m44", 1.0),
  ] {
    if let Some(v) = dictionary.number(key)? {
      is_3d |= v != identity;
    }
  }
  let matrix = fixup_2d(env, prefix, members)?;
  if is_2d == Some(true) && is_3d {
    return Err(type_error(
      env,
      &format!("{prefix}The is2D member is set to true but the input matrix is a 3d matrix."),
    ));
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

/// The first matrix argument of a method that index.js calls with the six
/// numbers of a matrix (setTransform, addPath), after it read the matrix
/// dictionary itself. A raw js-binding call may pass the dictionary there
/// instead: undefined, null or an object is read as one, and the numbers
/// after it are ignored.
pub(crate) enum MatrixArg {
  Number(f64),
  Matrix([f64; 6]),
}

impl MatrixArg {
  fn from_js(
    env: sys::napi_env,
    value: sys::napi_value,
    prefix: &str,
    dictionary: fn(sys::napi_env, Option<sys::napi_value>, &str) -> Result<[f64; 6]>,
  ) -> Result<Self> {
    let mut number = 0.0;
    if unsafe { sys::napi_get_value_double(env, value, &mut number) } == sys::Status::napi_ok {
      return Ok(Self::Number(number));
    }
    match raw_type_of(env, value)? {
      sys::ValueType::napi_undefined
      | sys::ValueType::napi_null
      | sys::ValueType::napi_object
      | sys::ValueType::napi_function => dictionary(env, Some(value), prefix).map(Self::Matrix),
      _ => to_number(env, value, prefix).map(Self::Number),
    }
  }

  /// [a, b, c, d, e, f], given the five numbers after this one.
  pub(crate) fn with(self, [b, c, d, e, f]: [f64; 5]) -> [f64; 6] {
    match self {
      Self::Number(a) => [a, b, c, d, e, f],
      Self::Matrix(matrix) => matrix,
    }
  }
}

/// The first argument of CanvasRenderingContext2D.setTransform(a, b, c, d,
/// e, f); see [`MatrixArg`]. A raw call's dictionary is a DOMMatrixInit.
pub struct SetTransformA(pub(crate) MatrixArg);

impl FromNapiValue for SetTransformA {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    MatrixArg::from_js(env, value, CtxSetTransform::PREFIX, dom_matrix_init_2d_part).map(Self)
  }
}

/// The first matrix argument of Path2D.addPath(path, a, b, c, d, e, f); see
/// [`MatrixArg`]. A raw call's dictionary is a DOMMatrix2DInit, and a
/// missing one the identity.
pub struct AddPathA(pub(crate) MatrixArg);

impl FromNapiValue for AddPathA {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    MatrixArg::from_js(env, value, PathAddPath::PREFIX, dom_matrix_2d_init).map(Self)
  }
}

/// The matrix of CanvasPattern.setTransform().
pub struct PatternTransform(pub(crate) [f64; 6]);

impl FromNapiValue for PatternTransform {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    dom_matrix_2d_init(env, Some(value), PATTERN_SET_TRANSFORM).map(Self)
  }
}

/// The most `Positional` parameters of a method: drawImage has 9.
const MAX_POSITIONAL: usize = 9;

/// The values recorded by the `Positional` parameters of a call.
struct Recorded {
  values: [sys::napi_value; MAX_POSITIONAL],
  /// How many were recorded. Past `MAX_POSITIONAL` only the count goes on,
  /// and [`Arguments::take`] fails.
  len: usize,
}

thread_local! {
  /// The values recorded by the `Positional` parameters of the call being
  /// converted. A fixed array: drawImage and isPointInPath record theirs on
  /// every call, and a Vec would allocate each time.
  static POSITIONAL: RefCell<Recorded> = const {
    RefCell::new(Recorded {
      values: [ptr::null_mut(); MAX_POSITIONAL],
      len: 0,
    })
  };
}

/// A positional parameter of a method whose last parameter converts all of
/// its arguments together (createImageData, createPattern): the overload, and
/// which arguments are converted, depend on the real argument count and on
/// the earlier arguments.
///
/// napi-rs converts the parameters one by one, in order, and then borrows the
/// receiver. This one only records its value. The last parameter takes the
/// recorded values with [`Arguments::take`] and converts them, so the user
/// code that runs (ToString, dictionary getters) runs before that borrow and
/// may use the receiver.
pub struct Positional;

impl FromNapiValue for Positional {
  unsafe fn from_napi_value(_env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    POSITIONAL.with_borrow_mut(|recorded| {
      if let Some(slot) = recorded.values.get_mut(recorded.len) {
        *slot = value;
      }
      recorded.len += 1;
    });
    Ok(Self)
  }
}

/// How many argument-count markers there are: for 0 to `MAX_POSITIONAL`
/// arguments.
const ARGUMENT_COUNT_MARKERS: usize = MAX_POSITIONAL + 1;

/// The memory the argument-count markers point to. The marker for `n`
/// arguments is an ArrayBuffer of one byte at `MARKER_BYTES[n]`, made with
/// napi_create_external_arraybuffer, and its count is where its data
/// starts. napi_get_arraybuffer_info gives that address without reading
/// what is there. Only these ArrayBuffers start in this memory: script
/// cannot make an ArrayBuffer over memory that it did not allocate, and a
/// copy of a marker (slice, structuredClone, transfer to another length)
/// has memory of its own. transfer() to the same length moves a marker: the
/// new ArrayBuffer has its memory and its count, the old one, detached,
/// none. So no other value is read as a count, and no value is read as
/// another count.
///
/// The markers are not napi externals: napi_get_value_external (Node 24,
/// js_native_api_v8.cc) reads any v8::External as one that napi made, so
/// an External that another kind of addon passes there would make us read
/// memory we do not own. Nor objects wrapped with napi_wrap: napi_unwrap
/// costs some 30 ns more for each marker read.
struct MarkerBytes(UnsafeCell<[u8; ARGUMENT_COUNT_MARKERS]>);

// SAFETY: only the addresses of the bytes are used. Script may write the
// bytes, on any thread, through a view of a marker; nothing reads them.
unsafe impl Sync for MarkerBytes {}

static MARKER_BYTES: MarkerBytes = MarkerBytes(UnsafeCell::new([0; ARGUMENT_COUNT_MARKERS]));

/// The argument-count markers for 0 to 9 arguments, for index.js only: its
/// wrappers pass `markers[Math.min(arguments.length, n)]` after the `n`
/// positional arguments. The wrappers of the hot methods (fill, clip,
/// stroke, isPointInPath, isPointInStroke, drawImage) pass it only when the
/// last of those arguments is an explicit undefined, and undefined otherwise:
/// [`Arguments::take`] then finds the same count by itself.
///
/// None where the runtime does not allow external ArrayBuffers (Node built
/// with the V8 sandbox, as in Electron). index.js then passes undefined, and
/// an explicit undefined at the end counts as a missing argument, as in a
/// raw call.
// napi-rs registers the function only outside `cargo test`.
#[cfg_attr(test, allow(dead_code))]
#[napi(js_name = "_argumentCounts")]
pub fn argument_counts(env: &Env) -> Result<Vec<Unknown<'_>>> {
  let bytes = MARKER_BYTES.0.get().cast::<u8>();
  let mut markers = Vec::with_capacity(ARGUMENT_COUNT_MARKERS);
  for count in 0..ARGUMENT_COUNT_MARKERS {
    let mut marker = ptr::null_mut();
    let status = unsafe {
      sys::napi_create_external_arraybuffer(
        env.raw(),
        bytes.wrapping_add(count).cast(),
        1,
        // Static memory: nothing to free.
        None,
        ptr::null_mut(),
        &mut marker,
      )
    };
    if status == sys::Status::napi_no_external_buffers_allowed {
      return Ok(Vec::new());
    }
    check_status!(status)?;
    markers.push(unsafe { Unknown::from_napi_value(env.raw(), marker)? });
  }
  Ok(markers)
}

/// The count of an `argument_counts` marker; None for any other value.
fn argument_count(env: sys::napi_env, value: sys::napi_value) -> Option<u32> {
  let mut data = ptr::null_mut();
  // Fails, without throwing, on a value that is not an ArrayBuffer or a
  // SharedArrayBuffer, such as the undefined that most calls from index.js
  // pass, or an External of any addon, whose pointer it does not read. The
  // address it gives is only compared, never read.
  if unsafe { sys::napi_get_arraybuffer_info(env, value, &mut data, ptr::null_mut()) }
    != sys::Status::napi_ok
  {
    return None;
  }
  let count = data.addr().wrapping_sub(MARKER_BYTES.0.get().addr());
  (count < ARGUMENT_COUNT_MARKERS).then_some(count as u32)
}

/// The arguments of a call with `Positional` parameters, or of the ImageData
/// constructor.
pub(crate) struct Arguments {
  env: sys::napi_env,
  values: [sys::napi_value; MAX_POSITIONAL],
  /// How many of `values` the call recorded.
  count: usize,
  len: u32,
}

impl Arguments {
  /// The `count` values the `Positional` parameters of this call recorded.
  /// See [`Self::new`] for `argc`.
  pub(crate) fn take(env: sys::napi_env, count: usize, argc: sys::napi_value) -> Result<Self> {
    // Taken before any user code runs, which may make a call of its own.
    let (values, recorded) =
      POSITIONAL.with_borrow_mut(|recorded| (recorded.values, std::mem::take(&mut recorded.len)));
    if recorded != count || count > MAX_POSITIONAL {
      return Err(Error::new(
        Status::GenericFailure,
        format!("Expected {count} positional arguments, got {recorded}"),
      ));
    }
    Self::counted(env, values, count, argc)
  }

  /// `values` and the argument count.
  ///
  /// `argc` is the argument after them: index.js passes an
  /// `argument_counts` marker there, or undefined when the count is the last
  /// argument that is not undefined. A raw call (the js-binding entrypoint)
  /// has none, and any other value there is an extra argument, ignored.
  /// napi pads missing arguments with undefined, so without the marker `f(x)`
  /// and `f(x, undefined)` look the same here, and the count then runs up to
  /// the last argument that is not undefined.
  pub(crate) fn new(
    env: sys::napi_env,
    values: &[sys::napi_value],
    argc: sys::napi_value,
  ) -> Result<Self> {
    Self::counted(env, Self::copy(values)?, values.len(), argc)
  }

  /// `values` of a call with `len` arguments, the count a native function
  /// reads from its callback info.
  pub(crate) fn with_len(env: sys::napi_env, values: &[sys::napi_value], len: u32) -> Result<Self> {
    Ok(Self {
      env,
      values: Self::copy(values)?,
      count: values.len(),
      len,
    })
  }

  fn copy(values: &[sys::napi_value]) -> Result<[sys::napi_value; MAX_POSITIONAL]> {
    let mut array = [ptr::null_mut(); MAX_POSITIONAL];
    let Some(slots) = array.get_mut(..values.len()) else {
      return Err(Error::new(
        Status::GenericFailure,
        format!(
          "Expected at most {MAX_POSITIONAL} arguments, got {}",
          values.len()
        ),
      ));
    };
    slots.copy_from_slice(values);
    Ok(array)
  }

  /// The first `count` of `values`, with the argument count of `argc` (see
  /// [`Self::new`]).
  fn counted(
    env: sys::napi_env,
    values: [sys::napi_value; MAX_POSITIONAL],
    count: usize,
    argc: sys::napi_value,
  ) -> Result<Self> {
    // The count is the marker's (0 without one), raised to the last argument
    // that is not undefined. Only an argument at or past the marker's count
    // can raise it (from index.js none does), so only those are looked at,
    // from the last one.
    let mut len = argument_count(env, argc).unwrap_or(0);
    for index in (len.min(count as u32)..count as u32).rev() {
      if type_of(env, values[index as usize])? != ValueType::Undefined {
        len = index + 1;
        break;
      }
    }
    Ok(Self {
      env,
      values,
      count,
      len,
    })
  }

  pub(crate) fn len(&self) -> u32 {
    self.len
  }

  /// Blink's NonUndefinedArgumentLength (generated_code_helper.h): the count
  /// without the trailing undefined arguments.
  pub(crate) fn non_undefined_len(&self) -> Result<u32> {
    for index in (0..self.count).rev() {
      if type_of(self.env, self.values[index])? != ValueType::Undefined {
        return Ok(index as u32 + 1);
      }
    }
    Ok(0)
  }

  /// Argument `index`; undefined past the recorded ones.
  pub(crate) fn get(&self, index: u32) -> Result<sys::napi_value> {
    match self.values[..self.count].get(index as usize) {
      Some(value) => Ok(*value),
      None => {
        let mut value = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_undefined(self.env, &mut value) })?;
        Ok(value)
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::number_to_string;

  #[test]
  fn number_to_string_matches_blink() {
    // Chrome 155: the radius in "The radius provided (...) is negative." for
    // arc(1, 1, r, 0, 1); Blink formats the float radius.
    for (radius, text) in [
      (-1.0, "-1"),
      (-2.5, "-2.5"),
      (-0.1, "-0.1"),
      (-1.1, "-1.1"),
      (-0.30000001, "-0.3"),
      (-0.5, "-0.5"),
      (-1e10, "-1.00000e+10"),
      (-123456789.0, "-1.23457e+8"),
      (-1e-7, "-1.00000e-7"),
      (-0.000123456789, "-0.000123457"),
      (-3.4e38, "-3.40000e+38"),
      (-1234567.0, "-1.23457e+6"),
      (-1234565.0, "-1.23457e+6"),
      (-100000.0, "-100000"),
      (-1000000.0, "-1.00000e+6"),
      (-999999.5, "-1.00000e+6"),
      (-1.5e-5, "-0.000015"),
      (-16777217.0, "-1.67772e+7"),
      (-1e-40, "-9.99995e-41"),
      (-3.4028234663852886e38, "-3.40282e+38"),
    ] {
      assert_eq!(number_to_string(f64::from(radius as f32)), text, "{radius}");
    }
    assert_eq!(number_to_string(f64::NAN), "NaN");
    assert_eq!(number_to_string(f64::NEG_INFINITY), "-Infinity");
    assert_eq!(number_to_string(-0.0), "0");
    assert_eq!(number_to_string(123.0), "123");
  }
}
