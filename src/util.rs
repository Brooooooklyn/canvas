use std::any::type_name;

use napi::{bindgen_prelude::ValidateNapiValue, Env, JsObject, Result};

pub trait UnwrapObject {
  fn unwrap<Target>(&self, env: &Env) -> Result<&mut Target>
  where
    &'static Target: ValidateNapiValue + 'static;
}

impl UnwrapObject for JsObject {
  fn unwrap<Target>(&self, env: &Env) -> Result<&mut Target>
  where
    &'static Target: ValidateNapiValue + 'static,
  {
    use napi::NapiRaw;

    unsafe { <&'static Target>::validate(env.raw(), self.raw()) }.and_then(|_| {
      let mut path_ptr = std::ptr::null_mut();
      napi::check_status!(
        unsafe { napi::sys::napi_unwrap(env.raw(), self.raw(), &mut path_ptr) },
        "Unwrap Path from {} failed",
        type_name::<Target>()
      )?;
      Ok(Box::leak(unsafe { Box::from_raw(path_ptr as *mut Target) }))
    })
  }
}
