// The Blink-style text shaper: canvas text shaped with HarfBuzz the way
// Blink's PlainTextNode / HarfBuzzShaper do it, in place of skparagraph's
// shaping and fallback. It lays out into the same TextCaches::Line as the
// skparagraph path (text.cpp LayOutLine), so drawing and measuring stay as
// they are.
//
// NAPI_RS_CANVAS_SHAPER picks the path, once per process: unset or
// "skparagraph" lays every line out with skparagraph, "blink" with
// LayOutLineBlink, which lays out every request (stage S9: none is turned
// down to skparagraph any more); skiac_debug_shaper_stats counts them.

#ifndef SKIA_C_SHAPER_H
#define SKIA_C_SHAPER_H

#include <stddef.h>
#include <stdint.h>

#include <optional>
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

// The host's UI language that ctx.lang "inherit" takes (LayoutLocale::
// GetDefault, D19), read once per process (FontResolution).
const std::string& HostLanguage();

// The inputs a canvas font request picks its fonts with, made in one place
// (ResolveFontRequest) for every path that must pick the fonts the shaper
// picks: the shaper and the ic unit
// (skiac_font_collection_ideographic_advance: Blink's FontSizes::Ic reads the
// primary font of the canvas font, the one its text uses). With the shaper
// on: FontDescription::LocaleOrDefault (D19) and that locale's font settings
// (LocaleFontFamilies, D20). With it off: the request's lang as given and no
// settings (the common ones), so those paths stay as they were.
struct FontResolution {
  // LocaleOrDefault as a language tag: the host language for "inherit", "und"
  // for "", else the tag. With the shaper off, the request's lang.
  std::string lang;
  // LocaleFontFamilies of `lang`; none with the shaper off.
  std::optional<LocaleFamilies> families;
  // For ResolveFontFamilies, CachedFontFamilies and ComputeUsedSizes.
  const LocaleFamilies* locale() const {
    return families ? &*families : nullptr;
  }
};
FontResolution ResolveFontRequest(skiac_font_collection* c_collection,
                                  const skiac_text_request& request);

// Lays out `request` with the Blink shaper into `line`. `resolution` is
// ResolveFontRequest's for `request` (the shaper is on). Every font argument
// list is noted (noteFontArguments) before the shaper takes a reference into
// the caches, and the caches are dropped only after the layout
// (FindOrLayOutLine), so references stay valid for the whole call.
void LayOutLineBlink(skiac_font_collection* c_collection,
                     const skiac_text_request& request,
                     const FontResolution& resolution,
                     TextCaches::Line* line);

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

// The data of the shaper's HarfBuzz font funcs (shaper_font.cpp).
struct HbFontData;

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
  // The data `hb`'s font funcs read, owned by `hb`.
  HbFontData* hb_data = nullptr;
  // SimpleFontData::SpaceGlyph: HarfBuzz's glyph for U+0020.
  SkGlyphID space_glyph = 0;
  // How MakeEntryFont made `hb`: ptem, HarfBuzz's own advances (Apple trak),
  // the parent font without `trak` (a web font). Part of the HanKerning
  // FontData key.
  float ptem = 0;
  bool harfbuzz_advances = false;
  bool web_font = false;
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
  // A glyph has an offset (GlyphDataRange::HasNonZeroOffsets), a y one
  // (ShapeResult::HasVerticalOffsets).
  bool has_offsets = false;
  bool has_vertical_offsets = false;
};

// Blink's ShapeResult of one item: the runs in visual order.
struct ShapeResult {
  std::vector<ShapedRun> runs;
  // The float sum of the run widths, in commit order; after spacing, in
  // visual order.
  float width = 0;
};

// ---- the steps (shaper_*.cpp) ----

// PlainTextNode::NormalizeSpacesAndMaybeBidi for a canvas, on the UTF-16 of
// `text` (UTF-8). shaper_text.cpp.
PreparedText PrepareText(const char* text, size_t length);

// PlainTextNode::SegmentText: the items in visual order. `word_by_word` is
// Font::CanShapeWordByWord. shaper_items.cpp.
struct ItemList {
  std::vector<Item> items;
  bool contains_rtl = false;
  bool rtl_base = false;
};
ItemList SegmentText(const PreparedText& prepared, bool rtl, bool word_by_word);

// HarfBuzzShaper::Shape's segments of an item, in item units: one Latin
// segment for 8-bit text, else RunSegmenter's ranges (ScriptRunIterator and
// SymbolsIterator). shaper_segment.cpp.
std::vector<Segment> SegmentItem(const char16_t* text,
                                 uint32_t length,
                                 bool is_8bit);

// ICUScriptToHBScript.
hb_script_t IcuScriptToHbScript(int script);

// The HarfBuzz caches of a TextCaches (shaper_font.cpp): faces by typeface
// and the buffer.
struct ShaperCaches;
void DestroyShaperCaches(ShaperCaches* caches);

// HarfBuzz's nominal glyph of `code_point` in `typeface` (its cmap, as
// Blink's SimpleFontData::GlyphForCharacter), 0 when none.
SkGlyphID HbNominalGlyph(skiac_font_collection* c_collection,
                         SkTypeface* typeface,
                         uint32_t code_point);

// Whether `typeface` has an AAT `trak` table (from the cached parent font).
bool TypefaceHasTrak(skiac_font_collection* c_collection, SkTypeface* typeface);

struct EntryFontOptions {
  // hb_font_set_ptem: the specified size (not floored), or the entry's size
  // when that is 0 (HarfBuzzFace::GetScaledFont).
  float ptem;
  // A font of the page (registered, not installed): Chrome's OTS step drops
  // its `trak` table, so HarfBuzz shapes it without one.
  bool web_font;
  // SystemFontRenderer() for the request: on Apple, CoreText's typefaces.
  bool system_renderer;
};

// Gives `entry` its HarfBuzz font: a sub font of the typeface's cached
// parent, with Blink's font funcs over entry->draw_font. False when the
// typeface has no data.
bool MakeEntryFont(skiac_font_collection* c_collection,
                   FontEntry* entry,
                   const EntryFontOptions& options);

// Blink's VariationSelectorMode values the font funcs read.
enum class VariationSelectorMode {
  kUseSpecified,
  kIgnore,
};
void SetVariationSelectorMode(FontEntry* entry, VariationSelectorMode mode);

// The buffer every layout of the collection shapes with.
hb_buffer_t* ShaperBuffer(skiac_font_collection* c_collection);

// harfbuzz_face.h kUnmatchedVSGlyphId: the glyph the font funcs give a
// variation sequence the font has only the base of.
constexpr hb_codepoint_t kUnmatchedVSGlyphId = static_cast<hb_codepoint_t>(-1);

// One item shaped: its ShapeResult.
struct ShapedItem {
  Item item;
  ShapeResult result;
};

// HanKerningCharType (han_kerning_char_type.h).
enum class HanKerningCharType : uint8_t {
  kOther,
  kOpen,
  kClose,
  kMiddle,
  kOpenNarrow,
  kCloseNarrow,
  kDot,
  kColon,
  kSemicolon,
  kOpenQuote,
  kCloseQuote,
  kInvalid,
};

// HanKerning::FontData (han_kerning.h): whether a font has `halt` and
// `chws`, and the classes its glyphs give the font-dependent characters.
struct HanKerningFontData {
  bool has_alternate_spacing = false;
  bool has_contextual_spacing = false;
  bool is_quote_fullwidth = false;
  HanKerningCharType type_for_dot = HanKerningCharType::kOther;
  HanKerningCharType type_for_colon = HanKerningCharType::kOther;
  HanKerningCharType type_for_semicolon = HanKerningCharType::kOther;
};

// HanKerning::FontData of `font` for a locale (its HarfBuzz language and
// LayoutLocale::GetScriptForHan): shaper_features.cpp.
HanKerningFontData ComputeHanKerningFontData(const FontEntry& font,
                                             hb_language_t language,
                                             int han_script);

// The same, cached (SimpleFontData::HanKerningData) by the font (typeface,
// draw font, HarfBuzz font options) and the locale; 256 entries, cleared
// when full and with the text caches: shaper_font.cpp.
HanKerningFontData CachedHanKerningFontData(skiac_font_collection* c_collection,
                                            const FontEntry& font,
                                            hb_language_t language,
                                            int han_script);

// SkFontGetBoundsForGlyph (skia_text_metrics.cc): on Apple the path bounds
// when there is a path; rounded out when the font is not subpixel.
SkRect BlinkGlyphBounds(const SkFont& font, SkGlyphID glyph);

// Character::GetHanKerningCharType: the text spacing class of a UTF-16 unit
// (character_property_data_generator.cc SetHanKerning).
HanKerningCharType GetHanKerningCharType(char16_t ch);

// HanKerning (han_kerning.cc) for one segment of an item, with the canvas's
// options (text-spacing-trim normal; not a line start, no trimming at the
// start or end) and TextSpacingTrimFallback (stable), without
// TextSpacingTrimFallback2 (test only). `text` is the item's text.
class HanKerning {
 public:
  HanKerning(const char16_t* text,
             uint32_t length,
             uint32_t segment_start,
             uint32_t segment_end);

  bool MayApply() const { return may_apply_; }
  // AppendFontFeatures' first check: a range other than the segment needs
  // a character that may be open or close punctuation.
  bool RangeMayApply(uint32_t start, uint32_t end) const;
  // The rest of AppendFontFeatures: false when the font has no `halt` or a
  // feature in `features` is one `chws` excludes; else appends
  // {halt, 1, i, i + 1} for each character to kern and returns true.
  bool AppendFontFeatures(uint32_t start,
                          uint32_t end,
                          const HanKerningFontData& font_data,
                          std::vector<hb_feature_t>* features);
  // After a range whose features were computed, when more ranges follow
  // (fallback fonts): keeps the classes this font gave its characters.
  void PrepareFallback();

 private:
  enum class Priority { kText, kCache };
  HanKerningCharType CharType(uint32_t index,
                              const HanKerningFontData& font_data,
                              Priority priority = Priority::kText);

  const char16_t* text_;
  uint32_t length_;
  bool may_apply_;
  bool is_start_prev_used_ = false;
  bool is_end_next_used_ = false;
  uint32_t segment_start_;
  uint32_t segment_end_;
  uint32_t last_start_ = 0;
  uint32_t last_end_ = 0;
  HanKerningFontData last_font_data_;
  std::vector<HanKerningCharType> char_types_;
};

// ShapeResultSpacing over the prepared text, as PlainTextNode::Shape applies
// it to each item (ShapeResult::ApplySpacing): the letter and word spacing
// as TextRunLayoutUnit, added to the last glyph of each cluster, not
// clamped; then each run's width is its new 16.16 sum (not clamped at 0) and
// each item's the float sum of its runs in visual order. Nothing changes when
// both are 0 as TextRunLayoutUnit. shaper_spacing.cpp.
void ApplySpacing(const PreparedText& prepared,
                  float letter_spacing,
                  float word_spacing,
                  std::vector<ShapedItem>* items);

// The glyphs of the items where PlainTextPainter puts them (with what
// TextMetrics measures their ink from: BlinkRun::ink_x and offsets, and
// BlinkLine::item_widths), the line width and the advance of the visually
// last item (shaper_place.cpp).
struct PlacedLine {
  BlinkLine blink;
  float line_width = 0;
  float last_item_width = 0;
};
PlacedLine PlaceItems(const std::vector<ShapedItem>& items,
                      const PreparedText& prepared,
                      bool contains_rtl,
                      bool rtl_base);

// ---- fallback (shaper_chars.cpp, shaper_fallback_mac.cpp, shaper_font.cpp)

// Character::IsVariationSequence: an emoji, standardized or ideographic
// variation sequence.
bool IsVariationSequence(uint32_t character, uint32_t selector);
// Character::IsPrivateUse || Character::IsNonCharacter: FontCache gives such
// a character no fallback font.
bool IsPrivateUseOrNonCharacter(uint32_t c);
// Character::IsCommonOrInheritedScript.
bool IsCommonOrInheritedScript(uint32_t c);
// Character::HasLikelyScript (with ScriptBasedOnUnicodeBlock).
bool HasLikelyScript(uint32_t c);

// A system fallback font and the synthetic styles it is drawn with; no face
// when the system has none for the character.
struct SystemFallbackFont {
  sk_sp<SkTypeface> face;
  SyntheticStyle synthetic = {false, false};
};

#if defined(__APPLE__)
// font_cache_mac.mm GetAlternateFontPlatformData: CoreText's font for
// `character` from `base`'s CTFont (Times when it has none) at
// `computed_pixel_size`, with no language; the Apple Symbols swap for an
// emoji without emoji presentation; the trait and weight refinement; the
// synthetic styles from the traits.
// For a `base` made from data, CoreText is asked with the same font from
// `inputs` (MacFallbackInputs) by the key's primary font; `base` still gives
// the traits.
struct SystemFallbackKey;
struct MacFallbackInputs;
SystemFallbackFont MacAlternateFont(SkTypeface* base,
                                    MacFallbackInputs* inputs,
                                    const SystemFallbackKey& key,
                                    SyntheticStyle base_synthetic,
                                    uint32_t character,
                                    int css_weight,
                                    bool italic,
                                    float computed_pixel_size);
// The CoreText fonts the system fallback asks with for primary fonts made
// from data (as the registered fonts are), by the key's primary font (family
// face and axes): the CGFont of the first instance given, for the 1024 most
// recently asked until the assets are rebuilt, and a CTFont made from it for
// the 64 most recently asked. CoreText keeps about 4 KB for every CGFont of a
// font made from data that it found a fallback from, after that CGFont is
// freed, and an instance remade after the font arguments' caches drop has a
// new CGFont. A CTFont made again from a kept CGFont adds nothing and gives
// the same fallback fonts; it only takes CoreText about 1 ms to set up. A
// kept CGFont costs about 26 KB while it lives, so past 1024 primary fonts
// in use a dropped one asked again adds CoreText's 4 KB once more. An
// installed font (one with a URL) is asked with its own CTFont: its remade
// instances add nothing.
MacFallbackInputs* CreateMacFallbackInputs();
void DestroyMacFallbackInputs(MacFallbackInputs* inputs);
// CreateFontPlatformData's synthetic styles for a font matched by family.
SyntheticStyle MacMatchedFontSynthetic(SkTypeface* face,
                                       float css_weight,
                                       bool italic);
#endif

// The system fallback results of a collection
// (skiac_font_collection::system_fallbacks, kept across the drops of
// TextCaches), by code point, emoji presentation, primary font (family face
// and axes), weight, slope and ComputedPixelSize. At most 4096, the least
// recently used dropped first.
struct SystemFallbackKey {
  uint32_t code_point;
  bool emoji_presentation;
  SkTypefaceID primary;
  uint64_t primary_axes;
  uint32_t weight_bits;
  uint32_t slope_bits;
  int pixel_size;
  bool operator==(const SystemFallbackKey&) const = default;
};
const SystemFallbackFont* FindSystemFallback(
    skiac_font_collection* c_collection,
    const SystemFallbackKey& key);
void StoreSystemFallback(skiac_font_collection* c_collection,
                         const SystemFallbackKey& key,
                         SystemFallbackFont font);
#if defined(__APPLE__)
// The collection's MacFallbackInputs, kept with the results.
MacFallbackInputs* SystemFallbackInputs(skiac_font_collection* c_collection);
#endif
// A system fallback face at an opsz (FontPlatformDataFromCTFont), cached by
// typeface and opsz.
sk_sp<SkTypeface> SystemFallbackInstance(skiac_font_collection* c_collection,
                                         sk_sp<SkTypeface> face,
                                         float opsz);

// ---- debug entry points (cargo tests and the harness) ----

extern "C" {

constexpr size_t kShaperRejectSlots = 16;

// LayOutLineBlink's outcomes in this process: the requests it laid out.
// Since stage S9 it lays out every request, so `rejected` (the counts of
// requests it turned down, by reason, before S9) stays 0; the struct keeps
// its layout until the old path and this entry point go (stage S10).
struct skiac_shaper_stats {
  uint64_t accepted;
  uint64_t rejected[kShaperRejectSlots];
  // Layouts during which the collection's TextCaches were dropped or one of
  // their maps cleared (LayOutLineBlink holds references into them): must
  // stay 0.
  uint64_t cache_changes;
};

// Fills `stats`; then sets the counts to 0 when `reset`.
void skiac_debug_shaper_stats(skiac_shaper_stats* stats, bool reset);

// BlinkShaperOn, for the Rust side: whether the font-metric units of
// ctx.filter (ex, ch, cap, ic) read the canvas font with its ctx.lang, as
// the text does with the shaper on (ResolveFontRequest).
bool skiac_blink_shaper_on();

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
