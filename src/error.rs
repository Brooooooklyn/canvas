use std::ffi::NulError;

use libavif::Error;
use thiserror::Error;

use crate::sk::Matrix;

#[derive(Error, Debug)]
pub enum SkError {
  #[error("[`{0}`] is not valid ColorSpace value")]
  StringToColorSpaceError(String),
  #[error("[`{0}`] is not valid Blend value")]
  StringToBlendError(String),
  #[error("[`{0}`] is not valid FillRule value")]
  StringToFillRuleError(String),
  #[error("[`{0}`] is not valid TextAlign value")]
  StringToTextAlignError(String),
  #[error("[`{0}`] is not valid TextBaseline value")]
  StringToTextBaselineError(String),
  #[error("[`{0}`] is not valid TextDirection value")]
  StringToTextDirectionError(String),
  #[error("[`{0}`] is not valid FilterQuality value")]
  StringToFilterQualityError(String),
  #[error("[`{0}`] is not valid LineCap value")]
  StringToStrokeCapError(String),
  #[error("[`{0}`] is not valid LineJoin value")]
  StringToStrokeJoinError(String),
  #[error("[`{0}`] is not valid SvgExportFlag value")]
  U32ToStrokeJoinError(u32),
  #[error("[`{0}`] is not valid transform")]
  InvalidTransform(Matrix),
  #[error("Convert String to CString failed")]
  NulError,
  #[error("[`{0}`] is not valid font style")]
  InvalidFontStyle(String),
  #[error("[`{0}`] is not valid font variant")]
  InvalidFontVariant(String),
  #[error("[`{0}`]")]
  PixelsToRgb(Error),
  #[error("[`{0}`]")]
  EncodeAvifError(Error),
  #[error("[`{0}`]")]
  Generic(String),
}

impl From<NulError> for SkError {
  fn from(_: NulError) -> Self {
    Self::NulError
  }
}

impl<T> From<std::sync::PoisonError<T>> for SkError {
  fn from(err: std::sync::PoisonError<T>) -> Self {
    Self::Generic(format!("PoisonError {}", err))
  }
}
