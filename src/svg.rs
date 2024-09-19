use std::mem;

use napi::bindgen_prelude::*;

use crate::{error::SkError, global_fonts::get_font, sk::sk_svg_text_to_path};

#[napi(js_name = "convertSVGTextToPath")]
pub fn convert_svg_text_to_path(
  env: &Env,
  input: Either3<Buffer, String, Unknown>,
) -> Result<BufferSlice> {
  let font = get_font().map_err(SkError::from)?;
  sk_svg_text_to_path(input.as_bytes()?, &font)
    .ok_or_else(|| {
      Error::new(
        Status::InvalidArg,
        "Convert svg text to path failed".to_owned(),
      )
    })
    .and_then(|v| unsafe {
      BufferSlice::from_external(env, v.0.ptr, v.0.size, v, |d, _| mem::drop(d))
    })
}

trait AsBytes {
  fn as_bytes(&self) -> Result<&[u8]>;
}

impl AsBytes for Either3<Buffer, String, Unknown> {
  fn as_bytes(&self) -> Result<&[u8]> {
    match self {
      Either3::A(b) => Ok(b.as_ref()),
      Either3::B(s) => Ok(s.as_bytes()),
      Either3::C(c) => Err(Error::new(
        Status::InvalidArg,
        format!("Unsupported type: {:?}", c.get_type()?),
      )),
    }
  }
}
