use std::mem;

use napi::bindgen_prelude::*;

use crate::{
  error::SkError,
  global_fonts::get_font,
  sk::{sk_svg_root_size, sk_svg_text_to_path, sk_svg_text_to_path_prepared},
  svg_doc,
  svg_size::FontUnits,
};

/// The SVG with its text as paths. The document is read as an SVG image
/// reads it (`svg_doc::prepare_for_paths`), so its text takes the whole font-family
/// list, as an SVG image's text does. A document `svg_doc` cannot read is
/// left to SkSVG as it is: its font-family is the list's first name.
#[napi(js_name = "convertSVGTextToPath")]
pub fn convert_svg_text_to_path<'env>(
  env: &'env Env,
  input: Either3<BufferSlice, String, Unknown>,
) -> Result<BufferSlice<'env>> {
  let bytes = input.as_bytes()?;
  let units = {
    let font = get_font().map_err(SkError::from)?;
    FontUnits::from_metrics(font.default_font_metrics())
  };
  let prepared = svg_doc::prepare_for_paths(bytes, &units, sk_svg_root_size).ok();
  let font = get_font().map_err(SkError::from)?;
  match &prepared {
    Some((prepared, root)) => sk_svg_text_to_path_prepared(prepared, root, &font),
    None => sk_svg_text_to_path(bytes, &font),
  }
  .ok_or_else(|| {
    Error::new(
      Status::InvalidArg,
      "Convert svg text to path failed".to_owned(),
    )
  })
  .and_then(|v| unsafe {
    BufferSlice::from_external(env, v.0.ptr, v.0.size, v, |_, d| mem::drop(d))
  })
}

trait AsBytes {
  fn as_bytes(&self) -> Result<&[u8]>;
}

impl AsBytes for Either3<BufferSlice<'_>, String, Unknown<'_>> {
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
