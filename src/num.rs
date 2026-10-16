//! The two ways Blink turns a JS double into a float for the 2D context.
//!
//! ```text
//! path methods (moveTo ... roundRect)   transforms and rects (scale ... clearRect)
//!   saturated_cast<float>, isfinite       isfinite(double), then ClampTo<float>
//!   1e300  -> +inf -> the call is a no-op  1e300 -> FLT_MAX
//! ```

/// Blink `base::saturated_cast<float>(v)` followed by `std::isfinite`
/// (canvas_path.cc): None when `v` is NaN or outside the float range. A double
/// just above FLT_MAX that rounds to FLT_MAX (3.4028235e38) is outside the
/// range too, so `as f32` alone is not enough.
pub(crate) fn saturated_f32(v: f64) -> Option<f32> {
  (v.abs() <= f32::MAX as f64).then_some(v as f32)
}

/// [`saturated_f32`] for every value; None if any of them is None.
pub(crate) fn saturated_f32s<const N: usize>(values: [f64; N]) -> Option<[f32; N]> {
  let mut out = [0.0; N];
  for (o, v) in out.iter_mut().zip(values) {
    *o = saturated_f32(v)?;
  }
  Some(out)
}

/// Blink's transform and rect rule (canvas_2d_recorder_context.cc): None when
/// any value is NaN or infinite, else each value `ClampTo<float>`, so a finite
/// overflow saturates at +/-FLT_MAX.
pub(crate) fn clamped_f32s<const N: usize>(values: [f64; N]) -> Option<[f32; N]> {
  let mut out = [0.0; N];
  for (o, v) in out.iter_mut().zip(values) {
    if !v.is_finite() {
      return None;
    }
    *o = v.clamp(-f32::MAX as f64, f32::MAX as f64) as f32;
  }
  Some(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn saturated_f32_drops_values_outside_the_float_range() {
    for v in [
      f64::NAN,
      f64::INFINITY,
      f64::NEG_INFINITY,
      1e300,
      -1e300,
      3.4028235e38,
      -3.4028235e38,
      1e39,
    ] {
      assert_eq!(saturated_f32(v), None, "{v}");
    }
    assert_eq!(saturated_f32(f32::MAX as f64), Some(f32::MAX));
    assert_eq!(saturated_f32(-(f32::MAX as f64)), Some(f32::MIN));
    assert_eq!(saturated_f32(0.1), Some(0.1f32));
    assert_eq!(
      saturated_f32(-0.0).map(f32::to_bits),
      Some((-0.0f32).to_bits())
    );
    assert_eq!(saturated_f32s([1.0, 2.0]), Some([1.0, 2.0]));
    assert_eq!(saturated_f32s([1.0, f64::NAN]), None);
  }

  #[test]
  fn clamped_f32s_saturates_finite_overflow() {
    assert_eq!(
      clamped_f32s([1e300, -1e300, 0.5]),
      Some([f32::MAX, f32::MIN, 0.5])
    );
    assert_eq!(clamped_f32s([3.4028235e38]), Some([f32::MAX]));
    assert_eq!(clamped_f32s([1.0, f64::INFINITY]), None);
    assert_eq!(clamped_f32s([f64::NAN]), None);
  }
}
