//! The half-float decodes of high-bit-depth images, kept like Chrome keeps
//! them.
//!
//! Chrome keeps these decodes in one `SoftwareImageDecodeCache`
//! (`Image::SharedCCDecodeCache`, image.cc:83-98), backed by discardable
//! memory: at most 1000 entries (`kNormalMaxItemsInCacheForSoftware`,
//! software_image_decode_cache.cc:37), and the least recently used are
//! purged past 512 MiB on desktop (`GetDefaultMaxBytes`,
//! discardable_shared_memory_manager.cc:168-182). A purged decode is made
//! again from the encoded image at its next draw.
//!
//! Here an Image keeps its decodes weakly (`AccountedBitmap::float16_decode`)
//! and this cache keeps them alive. Each env (the main thread and each worker)
//! has its own cache with those limits: a decode is reported to its env's V8
//! heap (`napi_adjust_external_memory`, which only that env's thread may
//! call), so it is dropped on that thread, and before the env is torn down.

use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use napi::sys;

use crate::sk::{AccountedBitmap, ColorSpace};

/// Chrome's discardable memory limit on desktop.
const MAX_BYTES: usize = 512 * 1024 * 1024;
/// Chrome's `kNormalMaxItemsInCacheForSoftware`.
const MAX_ITEMS: usize = 1000;

/// Values kept within a byte and an item limit, least recently used first.
#[derive(Debug)]
pub(crate) struct DecodeLru<K, T> {
  max_bytes: usize,
  max_items: usize,
  bytes: usize,
  entries: VecDeque<(K, usize, Arc<T>)>,
}

impl<K: PartialEq, T> DecodeLru<K, T> {
  pub(crate) fn new(max_bytes: usize, max_items: usize) -> Self {
    Self {
      max_bytes,
      max_items,
      bytes: 0,
      entries: VecDeque::new(),
    }
  }

  /// Marks `key` as the most recently used, and keeps `value`, of `bytes`,
  /// for it when it has nothing kept yet. Returns what no longer fits, least
  /// recently used first: `value` too when it alone is over the byte limit.
  /// The caller drops them once it holds no lock.
  pub(crate) fn put(&mut self, key: K, bytes: usize, value: &Arc<T>) -> Vec<Arc<T>> {
    if let Some(index) = self.entries.iter().position(|(kept, ..)| *kept == key) {
      let entry = self.entries.remove(index).expect("index from position");
      self.entries.push_back(entry);
      return Vec::new();
    }
    self.bytes += bytes;
    self.entries.push_back((key, bytes, value.clone()));
    let mut dropped = Vec::new();
    while self.bytes > self.max_bytes || self.entries.len() > self.max_items {
      let Some((_, bytes, value)) = self.entries.pop_front() else {
        break;
      };
      self.bytes -= bytes;
      dropped.push(value);
    }
    dropped
  }

  /// Takes out the values whose keys match. The caller drops them once it
  /// holds no lock.
  pub(crate) fn take(&mut self, matches: impl Fn(&K) -> bool) -> Vec<Arc<T>> {
    let mut taken = Vec::new();
    let mut index = 0;
    while index < self.entries.len() {
      if matches(&self.entries[index].0) {
        let (_, bytes, value) = self.entries.remove(index).expect("index in bounds");
        self.bytes -= bytes;
        taken.push(value);
      } else {
        index += 1;
      }
    }
    taken
  }
}

/// A half-float decode is kept for an Image (its `resource_id`) and a canvas
/// colour space.
type DecodeKey = (u64, ColorSpace);

/// One cache per env, keyed by the env's address. A static, so nothing in it
/// is dropped at process exit, after V8 is gone.
type Caches = Vec<(usize, DecodeLru<DecodeKey, AccountedBitmap>)>;
static CACHES: Mutex<Caches> = Mutex::new(Vec::new());

fn caches() -> MutexGuard<'static, Caches> {
  CACHES.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Keeps `decode`, of `bytes`, as the most recently used half-float decode
/// of `env`, and drops the least recently used ones past the limits.
pub(crate) fn keep(
  env: sys::napi_env,
  key: DecodeKey,
  bytes: usize,
  decode: &Arc<AccountedBitmap>,
) {
  let dropped = {
    let mut caches = caches();
    let index = match caches.iter().position(|(owner, _)| *owner == env as usize) {
      Some(index) => index,
      None => {
        // The env's decodes are dropped before it is torn down. Without that
        // hook nothing is kept: each draw decodes again.
        if !env.is_null()
          && unsafe { sys::napi_add_env_cleanup_hook(env, Some(drop_env_decodes), env.cast()) }
            != sys::Status::napi_ok
        {
          return;
        }
        caches.push((env as usize, DecodeLru::new(MAX_BYTES, MAX_ITEMS)));
        caches.len() - 1
      }
    };
    caches[index].1.put(key, bytes, decode)
  };
  drop(dropped);
}

/// Drops the decodes kept for the Image `owner`, which can no longer draw.
pub(crate) fn forget(env: sys::napi_env, owner: u64) {
  let taken = {
    let mut caches = caches();
    caches
      .iter_mut()
      .find(|(kept_for, _)| *kept_for == env as usize)
      .map(|(_, cache)| cache.take(|(image, _)| *image == owner))
  };
  drop(taken);
}

/// Whether the decode for `key` is kept.
#[cfg(test)]
pub(crate) fn is_kept(env: sys::napi_env, key: DecodeKey) -> bool {
  caches()
    .iter()
    .find(|(owner, _)| *owner == env as usize)
    .is_some_and(|(_, cache)| cache.entries.iter().any(|(kept, ..)| *kept == key))
}

/// The env cleanup hook: drops the env's decodes while it is still alive.
unsafe extern "C" fn drop_env_decodes(env: *mut c_void) {
  let cache = {
    let mut caches = caches();
    caches
      .iter()
      .position(|(owner, _)| *owner == env as usize)
      .map(|index| caches.swap_remove(index))
  };
  drop(cache);
}

#[cfg(test)]
mod tests {
  use std::ptr;
  use std::sync::atomic::{AtomicUsize, Ordering};

  use super::*;
  use crate::sk::Bitmap;

  /// Counts its drops.
  struct Decode<'a>(&'a AtomicUsize);

  impl Drop for Decode<'_> {
    fn drop(&mut self) {
      self.0.fetch_add(1, Ordering::Relaxed);
    }
  }

  fn keys<K: Copy, T>(lru: &DecodeLru<K, T>) -> Vec<K> {
    lru.entries.iter().map(|(key, ..)| *key).collect()
  }

  #[test]
  fn the_least_recently_used_decodes_go_past_the_byte_limit() {
    let drops = AtomicUsize::new(0);
    let mut lru = DecodeLru::new(100, 1000);
    let [a, b, c] = [(); 3].map(|_| Arc::new(Decode(&drops)));
    assert!(lru.put(1, 40, &a).is_empty());
    assert!(lru.put(2, 40, &b).is_empty());
    // A hit makes 1 the most recently used, so 2 goes first.
    assert!(lru.put(1, 40, &a).is_empty());
    let dropped = lru.put(3, 40, &c);
    assert_eq!(dropped.len(), 1);
    assert!(Arc::ptr_eq(&dropped[0], &b));
    assert_eq!(keys(&lru), [1, 3]);
    assert_eq!(lru.bytes, 80);
    // The cache gave up its reference; the value is freed with the last one.
    drop(dropped);
    assert_eq!(Arc::strong_count(&b), 1);
    drop(b);
    assert_eq!(drops.load(Ordering::Relaxed), 1);
    // A hit adds no bytes and pushes nothing out.
    assert!(lru.put(3, 40, &c).is_empty());
    assert_eq!(lru.bytes, 80);
    assert_eq!(keys(&lru), [1, 3]);
    drop(lru);
    drop((a, c));
    assert_eq!(drops.load(Ordering::Relaxed), 3);
  }

  #[test]
  fn the_least_recently_used_decodes_go_past_the_item_limit() {
    let drops = AtomicUsize::new(0);
    let mut lru = DecodeLru::new(usize::MAX, 2);
    let values: Vec<_> = (0..4).map(|_| Arc::new(Decode(&drops))).collect();
    let mut dropped = Vec::new();
    for (key, value) in values.iter().enumerate() {
      dropped.extend(lru.put(key, 1, value));
    }
    assert_eq!(keys(&lru), [2, 3]);
    assert_eq!(lru.bytes, 2);
    assert_eq!(dropped.len(), 2);
    assert!(Arc::ptr_eq(&dropped[0], &values[0]) && Arc::ptr_eq(&dropped[1], &values[1]));
  }

  #[test]
  fn a_decode_over_the_byte_limit_is_not_kept() {
    let drops = AtomicUsize::new(0);
    let mut lru = DecodeLru::new(100, 1000);
    let small = Arc::new(Decode(&drops));
    let big = Arc::new(Decode(&drops));
    assert!(lru.put(1, 60, &small).is_empty());
    let dropped = lru.put(2, 101, &big);
    assert_eq!(dropped.len(), 2);
    assert!(Arc::ptr_eq(&dropped[0], &small) && Arc::ptr_eq(&dropped[1], &big));
    assert!(lru.entries.is_empty());
    assert_eq!(lru.bytes, 0);
    // The draw that made it still holds it.
    drop(dropped);
    assert_eq!(drops.load(Ordering::Relaxed), 0);
    drop((small, big));
    assert_eq!(drops.load(Ordering::Relaxed), 2);
  }

  #[test]
  fn take_removes_the_decodes_of_one_image() {
    let drops = AtomicUsize::new(0);
    let mut lru = DecodeLru::new(100, 1000);
    for key in [(1, 0), (2, 0), (1, 1)] {
      drop(lru.put(key, 10, &Arc::new(Decode(&drops))));
    }
    let taken = lru.take(|(image, _)| *image == 1);
    assert_eq!(taken.len(), 2);
    assert_eq!(keys(&lru), [(2, 0)]);
    assert_eq!(lru.bytes, 10);
    drop(taken);
    assert_eq!(drops.load(Ordering::Relaxed), 2);
  }

  /// A 16-bit PNG Image whose decode the cache gives up decodes again, unless
  /// something still holds that decode.
  #[test]
  fn an_image_decodes_again_after_the_cache_drops_its_half_float_decode() {
    let encoded = include_bytes!("../__test__/fixtures/float16/hbd-8x8.png").to_vec();
    let mut data = encoded.clone();
    let bitmap = Bitmap::from_buffer(data.as_mut_ptr(), data.len()).expect("8-bit decode");
    let image = AccountedBitmap::new(bitmap, ptr::null_mut(), 0).with_high_bit_depth(encoded);
    let key = (image.resource_id, ColorSpace::Srgb);
    let first = image
      .float16_decode(ColorSpace::Srgb)
      .expect("half-float decode");
    assert!(is_kept(ptr::null_mut(), key));
    assert!(Arc::ptr_eq(
      &first,
      &image.float16_decode(ColorSpace::Srgb).unwrap()
    ));
    // Dropped from the cache while a draw or a pattern holds it: the same
    // decode, kept again.
    forget(ptr::null_mut(), image.resource_id);
    assert!(!is_kept(ptr::null_mut(), key));
    assert!(Arc::ptr_eq(
      &first,
      &image.float16_decode(ColorSpace::Srgb).unwrap()
    ));
    assert!(is_kept(ptr::null_mut(), key));
    // Dropped from the cache with nothing else holding it: freed, and
    // decoded again at the next draw.
    forget(ptr::null_mut(), image.resource_id);
    let freed = Arc::downgrade(&first);
    drop(first);
    assert!(freed.upgrade().is_none());
    let again = image.float16_decode(ColorSpace::Srgb).unwrap();
    assert_eq!(
      (again.inner.0.width, again.inner.0.height),
      (image.inner.0.width, image.inner.0.height)
    );
    assert!(is_kept(ptr::null_mut(), key));
    // An Image that is gone drops its decodes.
    drop(image);
    assert!(!is_kept(ptr::null_mut(), key));
    assert_eq!(Arc::strong_count(&again), 1);
  }
}
