// The Blink-style text shaper: canvas text shaped with HarfBuzz the way
// Blink's PlainTextNode / HarfBuzzShaper do it, in place of skparagraph's
// shaping and fallback. It lays out into the same TextCaches::Line as the
// skparagraph path (text.cpp LayOutLine), so drawing and measuring stay as
// they are.
//
// NAPI_RS_CANVAS_SHAPER picks the path, once per process: unset or
// "skparagraph" lays every line out with skparagraph, "blink" asks
// LayOutLineBlink first. While the shaper is being built, LayOutLineBlink
// turns down each request it cannot lay out yet, and skparagraph lays that
// one out; skiac_debug_shaper_stats counts both outcomes.

#ifndef SKIA_C_SHAPER_H
#define SKIA_C_SHAPER_H

#include <stddef.h>
#include <stdint.h>

#include <string>
#include <utility>
#include <vector>

#include "hb_api.h"
#include "text.hpp"
#include "text_caches.hpp"

// ---- the switch and the entry point ----

// NAPI_RS_CANVAS_SHAPER == "blink", read once per process (so it is not part
// of the line key).
bool BlinkShaperOn();

// Lays out `request` with the Blink shaper into `line` and returns true, or
// returns false and leaves `line` as it was: skparagraph then lays it out.
// Every font argument list is noted (noteFontArguments) before the shaper
// takes a reference into the caches, and the caches are dropped only after
// the layout (FindOrLayOutLine), so references stay valid for the whole call.
bool LayOutLineBlink(skiac_font_collection* c_collection,
                     const skiac_text_request& request,
                     TextCaches::Line* line);

// Why LayOutLineBlink turned a request down: one value for each kind of
// request the shaper cannot lay out yet. Each step of the work removes
// values; when none is left, every request is laid out by the shaper.
enum class ShaperReject : uint32_t {
  // No shaping code yet: every request.
  kNotImplemented = 0,
  kCount,
};

// ---- the shaper's types ----

// The text in Blink's index space: UTF-16 units of the fillText string.
struct PreparedText {
  // For ubidi, with the bidi controls.
  std::u16string original;
  // NormalizeSpacesAndMaybeBidi for a canvas: the same length as `original`.
  std::u16string text;
  // utf8[i] is the byte offset in request.text of unit i; utf8[n] is
  // request.text_len.
  std::vector<uint32_t> utf8;
  // Every code point is at most U+00FF and none is U+0009..U+000D or U+00AD.
  bool is_8bit = false;
  // Character::MaybeBidiRtl of `original`.
  bool maybe_bidi = false;
};

// PlainTextItem: a word (CanShapeWordByWord) or a bidi run, in visual order.
struct Item {
  uint32_t start;
  uint32_t length;
  bool rtl;
};

// FontFallbackPriority.
enum class Priority {
  kText,
  kEmojiText,
  kEmojiEmoji,
  kEmojiTextWithVS,
  kEmojiEmojiWithVS,
};

// A RunSegmenter range of an item.
struct Segment {
  uint32_t start;
  uint32_t end;
  // UScriptCode.
  int script;
  Priority priority;
};

// An owning reference to a HarfBuzz font (hb_font_reference /
// hb_font_destroy). The shaper's fonts are sub fonts, which hold a reference
// to their parent, so one reference keeps both.
class HbFontRef {
 public:
  HbFontRef() = default;
  // Takes over the caller's reference.
  explicit HbFontRef(hb_font_t* font) : font_(font) {}
  HbFontRef(const HbFontRef& other)
      : font_(other.font_ ? hb_font_reference(other.font_) : nullptr) {}
  HbFontRef(HbFontRef&& other) noexcept
      : font_(std::exchange(other.font_, nullptr)) {}
  HbFontRef& operator=(HbFontRef other) noexcept {
    std::swap(font_, other.font_);
    return *this;
  }
  ~HbFontRef() {
    if (font_) {
      hb_font_destroy(font_);
    }
  }
  hb_font_t* get() const { return font_; }

 private:
  hb_font_t* font_ = nullptr;
};

// One font the shaper may use: Blink's SimpleFontData.
struct FontEntry {
  // The instance at the request's axes and this entry's opsz.
  sk_sp<SkTypeface> face;
  // The family's face before font arguments; null for a system fallback
  // font.
  SkTypeface* base = nullptr;
  // The HarfBuzz scale and draw size, floored to 1/100 px.
  float size = 0;
  // Not floored: the specified size, or the adjusted size under
  // font-size-adjust.
  float opsz = 0;
  SyntheticStyle synthetic = {false, false};
  // A synthesized small caps copy, at SmallCapsSize(request.size).
  bool small_caps = false;
  // The SkFont skparagraph's OneLineShaper builds for this face.
  SkFont shaping_font;
  // TextRasterPolicy::DrawFont of `shaping_font` with the synthetic styles.
  SkFont draw_font;
  HbFontRef hb;
};

// A glyph as HarfBuzz placed it: `advance` in 16.16 (TextRunLayoutUnit),
// `character_index` in item units.
struct ShapedGlyph {
  SkGlyphID glyph;
  uint32_t character_index;
  int32_t advance;
  float x_offset;
  float y_offset;
};

// Blink's ShapeResultRun.
struct ShapedRun {
  const FontEntry* font = nullptr;
  int script = 0;
  bool rtl = false;
  // In item units.
  uint32_t start = 0;
  uint32_t num_characters = 0;
  // In HarfBuzz order (visual for RTL), at most kMaxGlyphs.
  std::vector<ShapedGlyph> glyphs;
  // The 16.16 sum of the advances as a float, at least 0; after spacing,
  // not clamped.
  float width = 0;
};

// Blink's ShapeResult of one item: the runs in visual order.
struct ShapeResult {
  std::vector<ShapedRun> runs;
  // The float sum of the run widths, in commit order; after spacing, in
  // visual order.
  float width = 0;
};

// ---- debug entry points (cargo tests and the harness) ----

extern "C" {

constexpr size_t kShaperRejectSlots = 16;
static_assert(static_cast<size_t>(ShaperReject::kCount) <= kShaperRejectSlots,
              "skiac_shaper_stats::rejected has a slot for each reason");

// LayOutLineBlink's outcomes in this process: the requests it laid out, and
// the ones it turned down by ShaperReject value.
struct skiac_shaper_stats {
  uint64_t accepted;
  uint64_t rejected[kShaperRejectSlots];
};

// Fills `stats`; then sets the counts to 0 when `reset`.
void skiac_debug_shaper_stats(skiac_shaper_stats* stats, bool reset);

// HarfBuzz's own Unicode data against ICU's, as Chromium's hb-icu.cc reads
// ICU (shaper_ucd.cpp): the code points (or pairs) where they differ.
struct skiac_ucd_icu_diffs {
  uint32_t assigned;
  uint32_t general_category;
  uint32_t combining_class;
  uint32_t mirroring;
  uint32_t script;
  uint32_t decompose;
  uint32_t compose;
  uint32_t compose_pairs;
  // The first code point that differs in any property, or 0xFFFFFFFF.
  uint32_t first;
};

void skiac_debug_ucd_icu_diffs(skiac_ucd_icu_diffs* diffs);

}  // extern "C"

#endif  // SKIA_C_SHAPER_H
