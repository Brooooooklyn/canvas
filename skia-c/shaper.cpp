// The Blink-style text shaper (shaper.hpp): the switch, the entry point and
// its counters.

#include "shaper.hpp"

#include <stdlib.h>
#include <string.h>

#include <atomic>

namespace {

std::atomic<uint64_t> g_accepted{0};
std::atomic<uint64_t> g_rejected[kShaperRejectSlots];

bool Reject(ShaperReject reason) {
  g_rejected[static_cast<size_t>(reason)].fetch_add(1,
                                                    std::memory_order_relaxed);
  return false;
}

}  // namespace

bool BlinkShaperOn() {
  static const bool on = [] {
    const char* value = getenv("NAPI_RS_CANVAS_SHAPER");
    return value && strcmp(value, "blink") == 0;
  }();
  return on;
}

bool LayOutLineBlink(skiac_font_collection* c_collection,
                     const skiac_text_request& request,
                     TextCaches::Line* line) {
  // Nothing is shaped here yet: skparagraph lays out every request.
  return Reject(ShaperReject::kNotImplemented);
}

extern "C" {

void skiac_debug_shaper_stats(skiac_shaper_stats* stats, bool reset) {
  stats->accepted = reset ? g_accepted.exchange(0, std::memory_order_relaxed)
                          : g_accepted.load(std::memory_order_relaxed);
  for (size_t i = 0; i < kShaperRejectSlots; ++i) {
    stats->rejected[i] =
        reset ? g_rejected[i].exchange(0, std::memory_order_relaxed)
              : g_rejected[i].load(std::memory_order_relaxed);
  }
}

}  // extern "C"
