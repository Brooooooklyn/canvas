use thiserror::Error;

use crate::sk::Matrix;

#[derive(Error, Debug)]
pub enum SkError {
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
  #[error("[`{0}`]")]
  Generic(String),
}
