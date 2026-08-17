//! Fused premultiplied -> unpremultiplied RGBA row conversion for
//! `getImageData` readbacks. x86_64 dispatches at runtime to the widest SIMD
//! implementation the CPU supports (AVX2, then baseline SSE2); aarch64 uses
//! NEON, which is mandatory in the base architecture.
//!
//! The float math matches Skia's conversion
//! (skia/src/opts/SkSwizzler_opts.inc): normalized [0,1] space, guarded
//! reciprocal of alpha (0 where alpha == 0), clamp to 255, round to nearest
//! with ties to even (as Skia's SIMD paths do on both arm64 and x64).
//!
//! Targets without a matching implementation return `None` from [`row_fn`]
//! and the caller falls back to Skia's own conversion through the C++ shim,
//! keeping its exact rounding behavior there.

use std::sync::OnceLock;

/// Converts `n` pixels from premultiplied RGBA (`src`) to unpremultiplied
/// RGBA (`dst`). `dst` must not alias `src`.
pub type RowFn = unsafe fn(*mut u32, *const u32, usize);

static ROW_FN: OnceLock<Option<RowFn>> = OnceLock::new();

/// The widest row conversion this build's CPU supports, cached after the
/// first call.
pub fn row_fn() -> Option<RowFn> {
  *ROW_FN.get_or_init(select_row_fn)
}

fn select_row_fn() -> Option<RowFn> {
  #[cfg(target_arch = "x86_64")]
  {
    if std::arch::is_x86_feature_detected!("avx512f") {
      return Some(avx512::row);
    }
    if std::arch::is_x86_feature_detected!("avx2") {
      return Some(avx2::row);
    }
    // SSE2 is part of the x86_64 baseline, so this is always true; the check
    // documents the requirement and costs nothing.
    if std::arch::is_x86_feature_detected!("sse2") {
      return Some(sse2::row);
    }
    None
  }
  #[cfg(target_arch = "aarch64")]
  {
    // NEON is mandatory in the AArch64 base architecture (macOS, Windows
    // ARM64, Linux arm64 alike), so no runtime detection is needed.
    Some(neon::row)
  }
  #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
  {
    None
  }
}

#[inline]
fn unpremul_channel(reciprocal_a: f32, c: u32) -> u32 {
  let v = (c as f32 * (1.0 / 255.0)) * reciprocal_a * 255.0;
  v.min(255.0).round_ties_even() as u32
}

#[inline]
fn unpremul_pixel(p: u32) -> u32 {
  let a = p >> 24;
  if a == 0 || a == 255 {
    return p;
  }
  let reciprocal_a = 1.0 / (a as f32 * (1.0 / 255.0));
  let r = unpremul_channel(reciprocal_a, p & 0xFF);
  let g = unpremul_channel(reciprocal_a, (p >> 8) & 0xFF);
  let b = unpremul_channel(reciprocal_a, (p >> 16) & 0xFF);
  (a << 24) | (b << 16) | (g << 8) | r
}

/// Scalar loop for short rows that cannot fill a SIMD vector.
unsafe fn row_scalar(dst: *mut u32, src: *const u32, n: usize) {
  unsafe {
    for i in 0..n {
      dst.add(i).write(unpremul_pixel(src.add(i).read()));
    }
  }
}

#[cfg(target_arch = "aarch64")]
pub mod neon {
  use core::arch::aarch64::*;

  #[inline]
  fn unpremul_4(dst: *mut u32, src: *const u32) {
    unsafe {
      let p = vld1q_u32(src);
      let a = vshrq_n_u32::<24>(p);
      let a_zero = vceqq_u32(a, vdupq_n_u32(0));
      // Fast path: vectors whose pixels are all fully opaque or fully
      // transparent (the common case in real content) are copied as-is.
      let fast = vorrq_u32(vceqq_u32(a, vdupq_n_u32(255)), a_zero);
      if vminvq_u32(fast) == u32::MAX {
        vst1q_u32(dst, p);
        return;
      }
      let k1_255 = vdupq_n_f32(1.0 / 255.0);
      let k255 = vdupq_n_f32(255.0);
      let mask = vdupq_n_u32(0xFF);
      let ra_raw = vdivq_f32(vdupq_n_f32(1.0), vmulq_f32(vcvtq_f32_u32(a), k1_255));
      let ra = vreinterpretq_f32_u32(vbicq_u32(vreinterpretq_u32_f32(ra_raw), a_zero));
      let channels = [
        vandq_u32(p, mask),
        vandq_u32(vshrq_n_u32::<8>(p), mask),
        vandq_u32(vshrq_n_u32::<16>(p), mask),
      ];
      let mut converted = [vdupq_n_u32(0); 3];
      for (slot, &c) in converted.iter_mut().zip(channels.iter()) {
        let v = vmulq_f32(vcvtq_f32_u32(c), k1_255);
        let v = vminq_f32(vmulq_f32(vmulq_f32(v, ra), k255), k255);
        *slot = vcvtnq_u32_f32(v);
      }
      let out = vorrq_u32(
        vshlq_n_u32::<24>(a),
        vorrq_u32(
          vshlq_n_u32::<16>(converted[2]),
          vorrq_u32(vshlq_n_u32::<8>(converted[1]), converted[0]),
        ),
      );
      vst1q_u32(dst, out);
    }
  }

  /// # Safety
  /// `dst` and `src` must each point to `n` valid pixels, and
  /// `dst` must not alias `src`.
  pub unsafe fn row(dst: *mut u32, src: *const u32, n: usize) {
    let mut i = 0;
    while i + 4 <= n {
      unsafe { unpremul_4(dst.add(i), src.add(i)) };
      i += 4;
    }
    if i < n {
      if n >= 4 {
        // Overlapping final vector; the conversion is idempotent and dst
        // does not alias src, so re-converting a few pixels is safe.
        unsafe { unpremul_4(dst.add(n - 4), src.add(n - 4)) };
      } else {
        unsafe { super::row_scalar(dst, src, n) };
      }
    }
  }
}

#[cfg(target_arch = "x86_64")]
pub mod sse2 {
  use core::arch::x86_64::*;

  #[inline]
  fn unpremul_4(dst: *mut u32, src: *const u32) {
    unsafe {
      let p = _mm_loadu_si128(src.cast());
      let a = _mm_srli_epi32::<24>(p);
      let a_zero = _mm_cmpeq_epi32(a, _mm_setzero_si128());
      // Fast path: vectors whose pixels are all fully opaque or fully
      // transparent (the common case in real content) are copied as-is.
      let fast = _mm_or_si128(_mm_cmpeq_epi32(a, _mm_set1_epi32(255)), a_zero);
      if _mm_movemask_epi8(fast) == 0xFFFF {
        _mm_storeu_si128(dst.cast(), p);
        return;
      }
      let k1_255 = _mm_set1_ps(1.0 / 255.0);
      let k255 = _mm_set1_ps(255.0);
      let mask = _mm_set1_epi32(0xFF);
      let ra_raw = _mm_div_ps(_mm_set1_ps(1.0), _mm_mul_ps(_mm_cvtepi32_ps(a), k1_255));
      let ra = _mm_castsi128_ps(_mm_andnot_si128(a_zero, _mm_castps_si128(ra_raw)));
      let channels = [
        _mm_and_si128(p, mask),
        _mm_and_si128(_mm_srli_epi32::<8>(p), mask),
        _mm_and_si128(_mm_srli_epi32::<16>(p), mask),
      ];
      let mut converted = [_mm_setzero_si128(); 3];
      for (slot, &c) in converted.iter_mut().zip(channels.iter()) {
        let v = _mm_mul_ps(_mm_cvtepi32_ps(c), k1_255);
        let v = _mm_min_ps(_mm_mul_ps(_mm_mul_ps(v, ra), k255), k255);
        *slot = _mm_cvtps_epi32(v);
      }
      let out = _mm_or_si128(
        _mm_slli_epi32::<24>(a),
        _mm_or_si128(
          _mm_slli_epi32::<16>(converted[2]),
          _mm_or_si128(_mm_slli_epi32::<8>(converted[1]), converted[0]),
        ),
      );
      _mm_storeu_si128(dst.cast(), out);
    }
  }

  /// # Safety
  /// `dst` and `src` must each point to `n` valid pixels, and
  /// `dst` must not alias `src`.
  pub unsafe fn row(dst: *mut u32, src: *const u32, n: usize) {
    let mut i = 0;
    while i + 4 <= n {
      unsafe { unpremul_4(dst.add(i), src.add(i)) };
      i += 4;
    }
    if i < n {
      if n >= 4 {
        // Overlapping final vector; the conversion is idempotent and dst
        // does not alias src, so re-converting a few pixels is safe.
        unsafe { unpremul_4(dst.add(n - 4), src.add(n - 4)) };
      } else {
        unsafe { super::row_scalar(dst, src, n) };
      }
    }
  }
}

#[cfg(target_arch = "x86_64")]
pub mod avx2 {
  use core::arch::x86_64::*;

  #[target_feature(enable = "avx2")]
  unsafe fn unpremul_8(dst: *mut u32, src: *const u32) {
    unsafe {
      let p = _mm256_loadu_si256(src.cast());
      let a = _mm256_srli_epi32::<24>(p);
      let a_zero = _mm256_cmpeq_epi32(a, _mm256_setzero_si256());
      // Fast path: vectors whose pixels are all fully opaque or fully
      // transparent (the common case in real content) are copied as-is.
      let fast = _mm256_or_si256(_mm256_cmpeq_epi32(a, _mm256_set1_epi32(255)), a_zero);
      if _mm256_movemask_epi8(fast) == -1 {
        _mm256_storeu_si256(dst.cast(), p);
        return;
      }
      let k1_255 = _mm256_set1_ps(1.0 / 255.0);
      let k255 = _mm256_set1_ps(255.0);
      let mask = _mm256_set1_epi32(0xFF);
      let ra_raw = _mm256_div_ps(
        _mm256_set1_ps(1.0),
        _mm256_mul_ps(_mm256_cvtepi32_ps(a), k1_255),
      );
      let ra = _mm256_castsi256_ps(_mm256_andnot_si256(a_zero, _mm256_castps_si256(ra_raw)));
      let channels = [
        _mm256_and_si256(p, mask),
        _mm256_and_si256(_mm256_srli_epi32::<8>(p), mask),
        _mm256_and_si256(_mm256_srli_epi32::<16>(p), mask),
      ];
      let mut converted = [_mm256_setzero_si256(); 3];
      for (slot, &c) in converted.iter_mut().zip(channels.iter()) {
        let v = _mm256_mul_ps(_mm256_cvtepi32_ps(c), k1_255);
        let v = _mm256_min_ps(_mm256_mul_ps(_mm256_mul_ps(v, ra), k255), k255);
        *slot = _mm256_cvtps_epi32(v);
      }
      let out = _mm256_or_si256(
        _mm256_slli_epi32::<24>(a),
        _mm256_or_si256(
          _mm256_slli_epi32::<16>(converted[2]),
          _mm256_or_si256(_mm256_slli_epi32::<8>(converted[1]), converted[0]),
        ),
      );
      _mm256_storeu_si256(dst.cast(), out);
    }
  }

  #[target_feature(enable = "avx2")]
  unsafe fn row_impl(dst: *mut u32, src: *const u32, n: usize) {
    unsafe {
      let mut i = 0;
      while i + 8 <= n {
        unpremul_8(dst.add(i), src.add(i));
        i += 8;
      }
      if i < n {
        if n >= 8 {
          // Overlapping final vector; the conversion is idempotent and dst
          // does not alias src, so re-converting a few pixels is safe.
          unpremul_8(dst.add(n - 8), src.add(n - 8));
        } else {
          super::sse2::row(dst, src, n);
        }
      }
    }
  }

  /// # Safety
  /// Requires AVX2 (runtime-detected by [`crate::unpremul::row_fn`]); `dst`
  /// and `src` must each point to `n` valid pixels, and `dst` must not alias
  /// `src`.
  pub unsafe fn row(dst: *mut u32, src: *const u32, n: usize) {
    unsafe { row_impl(dst, src, n) }
  }
}

#[cfg(target_arch = "x86_64")]
pub mod avx512 {
  use core::arch::x86_64::*;

  #[target_feature(enable = "avx512f")]
  unsafe fn unpremul_16(dst: *mut u32, src: *const u32) {
    unsafe {
      let p = _mm512_loadu_si512(src.cast());
      let a = _mm512_srli_epi32::<24>(p);
      // Fast path: vectors whose pixels are all fully opaque or fully
      // transparent (the common case in real content) are copied as-is.
      let is_opaque = _mm512_cmpeq_epi32_mask(a, _mm512_set1_epi32(255));
      let nonzero_a = _mm512_test_epi32_mask(a, a);
      if (is_opaque | !nonzero_a) == 0xFFFF {
        _mm512_storeu_si512(dst.cast(), p);
        return;
      }
      let k1_255 = _mm512_set1_ps(1.0 / 255.0);
      let k255 = _mm512_set1_ps(255.0);
      let mask = _mm512_set1_epi32(0xFF);
      let ra_raw = _mm512_div_ps(
        _mm512_set1_ps(1.0),
        _mm512_mul_ps(_mm512_cvtepi32_ps(a), k1_255),
      );
      // Guarded reciprocal of normalized alpha: 0 where alpha == 0 (as Skia).
      let ra = _mm512_maskz_mov_ps(nonzero_a, ra_raw);
      let channels = [
        _mm512_and_si512(p, mask),
        _mm512_and_si512(_mm512_srli_epi32::<8>(p), mask),
        _mm512_and_si512(_mm512_srli_epi32::<16>(p), mask),
      ];
      let mut converted = [_mm512_setzero_si512(); 3];
      for (slot, &c) in converted.iter_mut().zip(channels.iter()) {
        let v = _mm512_mul_ps(_mm512_cvtepi32_ps(c), k1_255);
        let v = _mm512_min_ps(_mm512_mul_ps(_mm512_mul_ps(v, ra), k255), k255);
        *slot = _mm512_cvtps_epi32(v);
      }
      let out = _mm512_or_si512(
        _mm512_slli_epi32::<24>(a),
        _mm512_or_si512(
          _mm512_slli_epi32::<16>(converted[2]),
          _mm512_or_si512(_mm512_slli_epi32::<8>(converted[1]), converted[0]),
        ),
      );
      _mm512_storeu_si512(dst.cast(), out);
    }
  }

  #[target_feature(enable = "avx512f")]
  unsafe fn row_impl(dst: *mut u32, src: *const u32, n: usize) {
    unsafe {
      let mut i = 0;
      while i + 16 <= n {
        unpremul_16(dst.add(i), src.add(i));
        i += 16;
      }
      if i < n {
        if n >= 16 {
          // Overlapping final vector; the conversion is idempotent and dst
          // does not alias src, so re-converting a few pixels is safe.
          unpremul_16(dst.add(n - 16), src.add(n - 16));
        } else {
          super::avx2::row(dst, src, n);
        }
      }
    }
  }

  /// # Safety
  /// Requires AVX-512F (runtime-detected by [`crate::unpremul::row_fn`]);
  /// `dst` and `src` must each point to `n` valid pixels, and `dst` must not
  /// alias `src`.
  pub unsafe fn row(dst: *mut u32, src: *const u32, n: usize) {
    unsafe { row_impl(dst, src, n) }
  }
}

#[cfg(test)]
mod tests {
  // Reference: per-pixel float math identical to the scalar helpers.
  fn reference_row(dst: &mut [u32], src: &[u32]) {
    for (d, &s) in dst.iter_mut().zip(src.iter()) {
      *d = super::unpremul_pixel(s);
    }
  }

  fn check(row: unsafe fn(*mut u32, *const u32, usize)) {
    // All alpha values x several channel values (only valid premultiplied
    // combinations: channel <= alpha, which surface content always
    // satisfies), plus row lengths exercising the vector loop, the
    // overlapping tail, and the short-row scalar path.
    let mut src = Vec::new();
    for a in 0u32..=255 {
      for c in [0u32, 1, 5, 127, 128, 200, 254, 255] {
        let c = c.min(a);
        src.push((a << 24) | (c << 16) | (c << 8) | c);
      }
    }
    for n in [1usize, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 63, 64, src.len()] {
      let mut expected = vec![0u32; n];
      let mut actual = vec![0u32; n];
      reference_row(&mut expected, &src[..n]);
      unsafe { row(actual.as_mut_ptr(), src.as_ptr(), n) };
      assert_eq!(actual, expected, "row conversion mismatch at n={n}");
    }
  }

  #[test]
  fn simd_matches_scalar() {
    #[cfg(target_arch = "x86_64")]
    {
      if std::arch::is_x86_feature_detected!("sse2") {
        check(super::sse2::row);
      }
      if std::arch::is_x86_feature_detected!("avx2") {
        check(super::avx2::row);
      }
      if std::arch::is_x86_feature_detected!("avx512f") {
        check(super::avx512::row);
      }
    }
    #[cfg(target_arch = "aarch64")]
    {
      check(super::neon::row);
    }
  }
}
