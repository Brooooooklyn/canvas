// The Blink shaper's HarfBuzz fonts (shaper.hpp): a face and parent font
// per typeface (HarfBuzzFace, harfbuzz_face.cc), and for each FontEntry a
// sub font with Blink's font funcs over the entry's draw font
// (HarfBuzzSkiaGetFontFuncs: HarfBuzzGetGlyph, SkFontGetGlyphWidthForHarfBuzz
// and SkFontGetGlyphExtentsForHarfBuzz of skia_text_metrics.cc).

#include <math.h>
#include <string.h>

#include <algorithm>

#include <limits>
#include <list>
#include <map>
#include <memory>
#include <unordered_map>

#include "shaper.hpp"

struct HbFontData {
  SkFont font;
  VariationSelectorMode mode = VariationSelectorMode::kUseSpecified;
};

// The parent fonts by typeface, least recently used first (LRU 100, like
// skshaper's face cache), and the buffer.
struct SystemFallbackKeyHash {
  size_t operator()(const SystemFallbackKey& key) const {
    size_t hash = std::hash<uint32_t>()(key.code_point);
    for (const uint64_t part :
         {uint64_t{key.emoji_presentation}, uint64_t{key.primary},
          key.primary_axes, uint64_t{key.weight_bits}, uint64_t{key.slope_bits},
          static_cast<uint64_t>(key.pixel_size)}) {
      hash = hash * 31 + std::hash<uint64_t>()(part);
    }
    return hash;
  }
};

// HanKerning::FontData's key: SimpleFontData's (typeface, size, synthetic
// styles: the draw font; the HarfBuzz font's options) and the locale.
struct HanKerningKey {
  SkTypefaceID typeface;
  uint32_t size_bits;
  uint32_t scale_x_bits;
  uint32_t skew_x_bits;
  uint32_t ptem_bits;
  uint8_t edging;
  uint8_t hinting;
  uint8_t flags;
  hb_language_t language;
  int han_script;
  bool operator==(const HanKerningKey&) const = default;
};

struct HanKerningKeyHash {
  size_t operator()(const HanKerningKey& key) const {
    size_t hash = std::hash<uint32_t>()(key.typeface);
    for (const uint64_t part :
         {uint64_t{key.size_bits}, uint64_t{key.scale_x_bits},
          uint64_t{key.skew_x_bits}, uint64_t{key.ptem_bits},
          uint64_t{key.edging}, uint64_t{key.hinting}, uint64_t{key.flags},
          static_cast<uint64_t>(reinterpret_cast<uintptr_t>(key.language)),
          static_cast<uint64_t>(key.han_script)}) {
      hash = hash * 31 + std::hash<uint64_t>()(part);
    }
    return hash;
  }
};

struct ShaperCaches {
  struct Parent {
    HbFontRef font;
    // The same font without the face's `trak` table, for a web font (made
    // when one is asked for).
    HbFontRef web_font;
    // The typeface has a `trak` table, an `sbix` table.
    bool trak = false;
    bool sbix = false;
    std::list<SkTypefaceID>::iterator lru;
  };
  std::unordered_map<SkTypefaceID, Parent> parents;
  std::list<SkTypefaceID> lru;
  hb_buffer_t* buffer = nullptr;
  // The opsz instances of the system fallback faces.
  std::map<std::pair<SkTypefaceID, uint32_t>, sk_sp<SkTypeface>> instances;
  // HanKerning::FontData by font and locale.
  std::unordered_map<HanKerningKey, HanKerningFontData, HanKerningKeyHash>
      han_kerning;

  ~ShaperCaches() {
    if (buffer) {
      hb_buffer_destroy(buffer);
    }
  }
};

void DestroyShaperCaches(ShaperCaches* caches) {
  delete caches;
}

// The system fallback results (FontCache's character fallback), least
// recently used first, and on Apple the fonts CoreText is asked with.
struct SystemFallbackCache {
  using Result = std::pair<SystemFallbackKey, SystemFallbackFont>;
  std::list<Result> results;
  std::unordered_map<SystemFallbackKey,
                     std::list<Result>::iterator,
                     SystemFallbackKeyHash>
      fonts;
#if defined(__APPLE__)
  struct InputsDeleter {
    void operator()(MacFallbackInputs* inputs) const {
      DestroyMacFallbackInputs(inputs);
    }
  };
  std::unique_ptr<MacFallbackInputs, InputsDeleter> inputs;
#endif
};

void SystemFallbackCacheDeleter::operator()(SystemFallbackCache* cache) const {
  delete cache;
}

namespace {

constexpr size_t kMaxParents = 100;
constexpr size_t kMaxSystemFallbacks = 4096;
constexpr size_t kMaxSystemInstances = 256;
constexpr size_t kMaxHanKerningFonts = 256;

uint32_t FloatBits(float value) {
  uint32_t bits;
  memcpy(&bits, &value, sizeof(bits));
  return bits;
}

// skia_text_metrics.cc SkiaScalarToHarfBuzzPosition: ClampTo<int>.
hb_position_t SkiaScalarToHarfBuzzPosition(SkScalar value) {
  const float scaled = value * (1 << 16);
  if (!(scaled > static_cast<float>(std::numeric_limits<int32_t>::min()))) {
    return std::numeric_limits<int32_t>::min();
  }
  if (!(scaled < static_cast<float>(std::numeric_limits<int32_t>::max()))) {
    return std::numeric_limits<int32_t>::max();
  }
  return static_cast<hb_position_t>(scaled);
}

ShaperCaches& GetShaperCaches(skiac_font_collection* c_collection) {
  TextCaches& caches = GetTextCaches(c_collection);
  if (!caches.shaper) {
    caches.shaper.reset(new ShaperCaches());
  }
  return *caches.shaper;
}

// A face's table as a blob, or none for a `trak` table: Blink's OTS step
// keeps only the color, variation and layout tables of a web font
// (web_font_decoder.cc BlinkOTSContext::GetTableAction), so HarfBuzz never
// sees a web font's `trak`.
hb_blob_t* ReferenceWebFontTable(hb_face_t*, hb_tag_t tag, void* user_data) {
  if (!tag || tag == SkSetFourByteTag('t', 'r', 'a', 'k')) {
    return nullptr;
  }
  sk_sp<SkData> data = static_cast<SkTypeface*>(user_data)->copyTableData(tag);
  if (!data) {
    return nullptr;
  }
  SkData* table = data.release();
  return hb_blob_create(static_cast<const char*>(table->data()),
                        static_cast<unsigned int>(table->size()),
                        HB_MEMORY_MODE_READONLY, table,
                        [](void* ptr) { static_cast<SkData*>(ptr)->unref(); });
}

// HarfBuzzFace's parent font: `face` with HarfBuzz's OpenType funcs at the
// typeface's variation position (harfbuzz_face.cc, SkShaper_harfbuzz.cpp
// create_typeface_hb_font). Takes over `face`.
hb_font_t* MakeParentFont(hb_face_t* face, SkTypeface* typeface) {
  hb_font_t* font = hb_font_create(face);
  hb_face_destroy(face);
  hb_ot_font_set_funcs(font);
  const int axis_count = typeface->getVariationDesignPosition({});
  if (axis_count > 0) {
    std::vector<SkFontArguments::VariationPosition::Coordinate> coords(
        axis_count);
    if (typeface->getVariationDesignPosition(coords) == axis_count) {
      static_assert(sizeof(hb_variation_t) == sizeof(coords[0]));
      hb_font_set_variations(
          font, reinterpret_cast<const hb_variation_t*>(coords.data()),
          axis_count);
    }
  }
  return font;
}

// A face without a `cmap` table (one HarfBuzz cannot read as SFNT: a Type 1
// font FreeType loads) maps characters with Skia, as the old path does
// (SkShaper_harfbuzz.cpp skhb_nominal_glyph): a sub font of the parent with
// SkTypeface::unicharToGlyph as its nominal glyph and HarfBuzz's own funcs
// for the rest, where no variation glyph (no cmap 14) is found, as on the
// old path. Every user of the parent font (the shaper, HbNominalGlyph) then
// has the same mapping. An SFNT face keeps HarfBuzz's cmap. Takes over
// `font`.
hb_font_t* MapWithSkiaWithoutCmap(hb_font_t* font, SkTypeface* typeface) {
  if (typeface->getTableSize(SkSetFourByteTag('c', 'm', 'a', 'p'))) {
    return font;
  }
  static hb_font_funcs_t* const funcs = [] {
    hb_font_funcs_t* f = hb_font_funcs_create();
    hb_font_funcs_set_nominal_glyph_func(
        f,
        [](hb_font_t*, void* font_data, hb_codepoint_t unicode,
           hb_codepoint_t* glyph, void*) -> hb_bool_t {
          *glyph = static_cast<SkTypeface*>(font_data)->unicharToGlyph(
              static_cast<SkUnichar>(unicode));
          return *glyph != 0;
        },
        nullptr, nullptr);
    hb_font_funcs_make_immutable(f);
    return f;
  }();
  hb_font_t* sub_font = hb_font_create_sub_font(font);
  hb_font_destroy(font);
  typeface->ref();
  hb_font_set_funcs(sub_font, funcs, typeface,
                    [](void* ptr) { static_cast<SkTypeface*>(ptr)->unref(); });
  return sub_font;
}

// The cached parent font of a typeface, made on first use.
ShaperCaches::Parent& FindParent(skiac_font_collection* c_collection,
                                 SkTypeface* typeface) {
  ShaperCaches& caches = GetShaperCaches(c_collection);
  const SkTypefaceID id = typeface->uniqueID();
  auto found = caches.parents.find(id);
  if (found != caches.parents.end()) {
    caches.lru.splice(caches.lru.end(), caches.lru, found->second.lru);
    return found->second;
  }
  // A FontEntry keeps its own reference to the sub font, which keeps the
  // parent: dropping the cache's reference never frees a font in use.
  while (caches.parents.size() >= kMaxParents) {
    caches.parents.erase(caches.lru.front());
    caches.lru.pop_front();
  }
  auto& parent = caches.parents[id];
  parent.font = HbFontRef(MapWithSkiaWithoutCmap(
      MakeParentFont(CreateHbFace(typeface), typeface), typeface));
  parent.trak = typeface->getTableSize(SkSetFourByteTag('t', 'r', 'a', 'k'));
  parent.sbix = typeface->getTableSize(SkSetFourByteTag('s', 'b', 'i', 'x'));
  parent.lru = caches.lru.insert(caches.lru.end(), id);
  return parent;
}

hb_font_t* ParentFont(skiac_font_collection* c_collection,
                      SkTypeface* typeface) {
  return FindParent(c_collection, typeface).font.get();
}

bool IsUnicodeVariationSelector(hb_codepoint_t c) {
  return (c >= 0x180B && c <= 0x180D) || (c >= 0xFE00 && c <= 0xFE0F) ||
         (c >= 0xE0100 && c <= 0xE01EF);
}

// ColorTableLookup::TypefaceHasAnySupportedColorTable.
bool HasColorTable(SkTypeface* typeface) {
  const int count = typeface->countTables();
  if (count <= 0) {
    return false;
  }
  std::vector<SkFontTableTag> tags(count);
  const int returned = typeface->readTableTags(tags);
  bool cpal = false, colr = false, cbdt = false, cblc = false;
  for (int i = 0; i < returned; ++i) {
    switch (tags[i]) {
      case SkSetFourByteTag('s', 'b', 'i', 'x'):
        return true;
      case SkSetFourByteTag('C', 'P', 'A', 'L'):
        cpal = true;
        break;
      case SkSetFourByteTag('C', 'O', 'L', 'R'):
        colr = true;
        break;
      case SkSetFourByteTag('C', 'B', 'D', 'T'):
        cbdt = true;
        break;
      case SkSetFourByteTag('C', 'B', 'L', 'C'):
        cblc = true;
        break;
      default:
        break;
    }
    if ((cpal && colr) || (cbdt && cblc)) {
      return true;
    }
  }
  return false;
}

// harfbuzz_face.cc HarfBuzzGetGlyph with the canvas's VariationSelectorMode
// (font-variant-emoji normal: kUseSpecifiedVariationSelector, or
// kIgnoreVariationSelector on the shaper's second pass) and
// SystemFallbackEmojiVSSupport (stable). A selector is considered only after
// a character it makes a variation sequence with
// (Character::IsVariationSequence); a sequence the font has only the base
// of gives kUnmatchedVSGlyphId, so the shaper tries the next font.
hb_bool_t GetGlyph(hb_font_t* hb_font,
                   void* font_data,
                   hb_codepoint_t unicode,
                   hb_codepoint_t variation_selector,
                   hb_codepoint_t* glyph,
                   void*) {
  auto* data = static_cast<HbFontData*>(font_data);
  if (unicode == 0x2028 || unicode == 0x2029) {
    unicode = 0x20;
  }
  hb_font_t* parent = hb_font_get_parent(hb_font);
  const bool consider_variation_selector =
      data->mode != VariationSelectorMode::kIgnore &&
      IsUnicodeVariationSelector(variation_selector) &&
      IsVariationSequence(unicode, variation_selector);
  bool text_presentation_requested = false;
  bool emoji_presentation_requested = false;
  if (consider_variation_selector) {
    text_presentation_requested = variation_selector == 0xFE0E;
    emoji_presentation_requested = variation_selector == 0xFE0F;
    if (hb_font_get_variation_glyph(parent, unicode, variation_selector,
                                    glyph)) {
      return true;
    }
    variation_selector = 0;
  }
  const hb_bool_t has_base_glyph =
      hb_font_get_glyph(parent, unicode, variation_selector, glyph);
  if (consider_variation_selector && has_base_glyph) {
    if (text_presentation_requested || emoji_presentation_requested) {
      const bool has_color_table = HasColorTable(data->font.getTypeface());
      if ((has_color_table && text_presentation_requested) ||
          (!has_color_table && emoji_presentation_requested)) {
        *glyph = kUnmatchedVSGlyphId;
      }
    } else {
      *glyph = kUnmatchedVSGlyphId;
    }
  }
#if defined(__APPLE__)
  if (!has_base_glyph && (unicode == 0x2010 || unicode == 0x2011)) {
    const SkGlyphID sk_glyph = data->font.getTypeface()->unicharToGlyph(
        static_cast<SkUnichar>(unicode));
    *glyph = sk_glyph;
    return sk_glyph != 0;
  }
#endif
  return has_base_glyph;
}

hb_bool_t GetNominalGlyph(hb_font_t* hb_font,
                          void* font_data,
                          hb_codepoint_t unicode,
                          hb_codepoint_t* glyph,
                          void* user_data) {
  return GetGlyph(hb_font, font_data, unicode, 0, glyph, user_data);
}

// SkFontGetGlyphWidthForHarfBuzz.
hb_position_t GetAdvance(hb_font_t*,
                         void* font_data,
                         hb_codepoint_t glyph,
                         void*) {
  if (glyph == kUnmatchedVSGlyphId) {
    return 0;
  }
  const SkFont& font = static_cast<HbFontData*>(font_data)->font;
  SkScalar width = font.getWidth(static_cast<SkGlyphID>(glyph));
  if (!font.isSubpixel()) {
    width = SkScalarRoundToInt(width);
  }
  return SkiaScalarToHarfBuzzPosition(width);
}

void GetAdvances(hb_font_t*,
                 void* font_data,
                 unsigned int count,
                 const hb_codepoint_t* first_glyph,
                 unsigned int glyph_stride,
                 hb_position_t* first_advance,
                 unsigned int advance_stride,
                 void*) {
  const SkFont& font = static_cast<HbFontData*>(font_data)->font;
  std::vector<SkGlyphID> glyphs(count);
  std::vector<bool> unmatched(count);
  for (unsigned int i = 0; i < count; ++i) {
    const hb_codepoint_t glyph = *reinterpret_cast<const hb_codepoint_t*>(
        reinterpret_cast<const char*>(first_glyph) + i * glyph_stride);
    // kUnmatchedVSGlyphId has no width: its cluster is shaped again with the
    // next font, or with the selector ignored (SkFontGetGlyphWidthForHarfBuzz
    // leaves it 0).
    unmatched[i] = glyph == kUnmatchedVSGlyphId;
    glyphs[i] = unmatched[i] ? 0 : static_cast<SkGlyphID>(glyph);
  }
  std::vector<SkScalar> widths(count);
  font.getWidths(glyphs, widths);
  for (unsigned int i = 0; i < count; ++i) {
    SkScalar width = unmatched[i] ? 0 : widths[i];
    if (!font.isSubpixel()) {
      width = SkScalarRoundToScalar(width);
    }
    *reinterpret_cast<hb_position_t*>(reinterpret_cast<char*>(first_advance) +
                                      i * advance_stride) =
        SkiaScalarToHarfBuzzPosition(width);
  }
}

// SkFontGetGlyphExtentsForHarfBuzz.
hb_bool_t GetExtents(hb_font_t*,
                     void* font_data,
                     hb_codepoint_t codepoint,
                     hb_glyph_extents_t* extents,
                     void*) {
  if (codepoint == kUnmatchedVSGlyphId) {
    return false;
  }
  const SkFont& font = static_cast<HbFontData*>(font_data)->font;
  const SkRect bounds =
      BlinkGlyphBounds(font, static_cast<SkGlyphID>(codepoint));
  extents->x_bearing = SkiaScalarToHarfBuzzPosition(bounds.fLeft);
  extents->y_bearing = SkiaScalarToHarfBuzzPosition(-bounds.fTop);
  extents->width = SkiaScalarToHarfBuzzPosition(bounds.width());
  extents->height = SkiaScalarToHarfBuzzPosition(-bounds.height());
  return true;
}

// HarfBuzzSkiaFontFuncs: with Skia's advances, or (on Apple, for a face with
// `trak` and no `sbix`) with HarfBuzz's own (hmtx and HVAR).
hb_font_funcs_t* FontFuncs(bool harfbuzz_advances) {
  static hb_font_funcs_t* const funcs[2] = {
      [] {
        hb_font_funcs_t* f = hb_font_funcs_create();
        hb_font_funcs_set_variation_glyph_func(f, GetGlyph, nullptr, nullptr);
        hb_font_funcs_set_nominal_glyph_func(f, GetNominalGlyph, nullptr,
                                             nullptr);
        hb_font_funcs_set_glyph_h_advance_func(f, GetAdvance, nullptr, nullptr);
        hb_font_funcs_set_glyph_h_advances_func(f, GetAdvances, nullptr,
                                                nullptr);
        hb_font_funcs_set_glyph_extents_func(f, GetExtents, nullptr, nullptr);
        hb_font_funcs_make_immutable(f);
        return f;
      }(),
      [] {
        hb_font_funcs_t* f = hb_font_funcs_create();
        hb_font_funcs_set_variation_glyph_func(f, GetGlyph, nullptr, nullptr);
        hb_font_funcs_set_nominal_glyph_func(f, GetNominalGlyph, nullptr,
                                             nullptr);
        hb_font_funcs_set_glyph_extents_func(f, GetExtents, nullptr, nullptr);
        hb_font_funcs_make_immutable(f);
        return f;
      }(),
  };
  return funcs[harfbuzz_advances ? 1 : 0];
}

}  // namespace

SkRect BlinkGlyphBounds(const SkFont& font, SkGlyphID glyph) {
  SkRect bounds;
#if defined(__APPLE__)
  if (const auto path = font.getPath(glyph)) {
    bounds = path->getBounds();
  } else {
    bounds = font.getBounds(glyph, nullptr);
  }
#else
  bounds = font.getBounds(glyph, nullptr);
#endif
  if (!font.isSubpixel()) {
    bounds.set(bounds.roundOut());
  }
  return bounds;
}

HanKerningFontData CachedHanKerningFontData(skiac_font_collection* c_collection,
                                            const FontEntry& font,
                                            hb_language_t language,
                                            int han_script) {
  const SkFont& draw = font.draw_font;
  const HanKerningKey key = {
      font.face->uniqueID(),
      FloatBits(draw.getSize()),
      FloatBits(draw.getScaleX()),
      FloatBits(draw.getSkewX()),
      FloatBits(font.ptem),
      static_cast<uint8_t>(draw.getEdging()),
      static_cast<uint8_t>(draw.getHinting()),
      static_cast<uint8_t>(
          (draw.isEmbolden() ? 1 : 0) | (draw.isSubpixel() ? 2 : 0) |
          (draw.isLinearMetrics() ? 4 : 0) | (draw.isBaselineSnap() ? 8 : 0) |
          (font.harfbuzz_advances ? 16 : 0) | (font.web_font ? 32 : 0)),
      language,
      han_script,
  };
  ShaperCaches& caches = GetShaperCaches(c_collection);
  if (const auto found = caches.han_kerning.find(key);
      found != caches.han_kerning.end()) {
    return found->second;
  }
  if (caches.han_kerning.size() >= kMaxHanKerningFonts) {
    caches.han_kerning.clear();
  }
  const HanKerningFontData data =
      ComputeHanKerningFontData(font, language, han_script);
  caches.han_kerning.emplace(key, data);
  return data;
}

SkGlyphID HbNominalGlyph(skiac_font_collection* c_collection,
                         SkTypeface* typeface,
                         uint32_t code_point) {
  hb_codepoint_t glyph = 0;
  if (!hb_font_get_nominal_glyph(ParentFont(c_collection, typeface), code_point,
                                 &glyph)) {
    return 0;
  }
  return glyph > 0xFFFF ? 0 : static_cast<SkGlyphID>(glyph);
}

bool TypefaceHasTrak(skiac_font_collection* c_collection,
                     SkTypeface* typeface) {
  return FindParent(c_collection, typeface).trak;
}

bool MakeEntryFont(skiac_font_collection* c_collection,
                   FontEntry* entry,
                   const EntryFontOptions& options) {
  ShaperCaches::Parent& cached = FindParent(c_collection, entry->face.get());
  if (!cached.font.get()) {
    return false;
  }
  const bool trak = cached.trak && !options.web_font;
  hb_font_t* parent = cached.font.get();
  if (cached.trak && options.web_font) {
    if (!cached.web_font.get()) {
      SkTypeface* typeface = entry->face.get();
      typeface->ref();
      hb_face_t* face = hb_face_create_for_tables(
          ReferenceWebFontTable, typeface,
          [](void* ptr) { static_cast<SkTypeface*>(ptr)->unref(); });
      cached.web_font = HbFontRef(MakeParentFont(face, typeface));
    }
    parent = cached.web_font.get();
  }
  // harfbuzz_face.cc HarfBuzzSkiaFontFuncs::GetFunctions: on Apple a face
  // with `trak` and no `sbix` takes HarfBuzz's advances, which HarfBuzz
  // then tracks at ptem; CoreText's own already are.
  bool harfbuzz_advances = false;
#if defined(__APPLE__)
  harfbuzz_advances = options.system_renderer && trak && !cached.sbix;
#endif
  hb_font_t* font = hb_font_create_sub_font(parent);
  auto* data = new HbFontData{entry->draw_font};
  hb_font_set_funcs(font, FontFuncs(harfbuzz_advances), data,
                    [](void* ptr) { delete static_cast<HbFontData*>(ptr); });
  // harfbuzz_face.cc GetScaledFont: SkiaScalarToHarfBuzzPosition of the
  // size, and ptem at the specified size, where HarfBuzz reads `trak`.
  const hb_position_t scale = SkiaScalarToHarfBuzzPosition(entry->size);
  hb_font_set_scale(font, scale, scale);
  hb_font_set_ptem(font, options.ptem);
  entry->hb = HbFontRef(font);
  entry->hb_data = data;
  entry->ptem = options.ptem;
  entry->harfbuzz_advances = harfbuzz_advances;
  entry->web_font = cached.trak && options.web_font;
  return true;
}

void SetVariationSelectorMode(FontEntry* entry, VariationSelectorMode mode) {
  entry->hb_data->mode = mode;
}

hb_buffer_t* ShaperBuffer(skiac_font_collection* c_collection) {
  ShaperCaches& caches = GetShaperCaches(c_collection);
  if (!caches.buffer) {
    caches.buffer = hb_buffer_create();
  }
  return caches.buffer;
}

const SystemFallbackFont* FindSystemFallback(
    skiac_font_collection* c_collection,
    const SystemFallbackKey& key) {
  if (!c_collection->system_fallbacks) {
    return nullptr;
  }
  SystemFallbackCache& cache = *c_collection->system_fallbacks;
  const auto found = cache.fonts.find(key);
  if (found == cache.fonts.end()) {
    return nullptr;
  }
  cache.results.splice(cache.results.end(), cache.results, found->second);
  return &found->second->second;
}

void StoreSystemFallback(skiac_font_collection* c_collection,
                         const SystemFallbackKey& key,
                         SystemFallbackFont font) {
  if (!c_collection->system_fallbacks) {
    c_collection->system_fallbacks.reset(new SystemFallbackCache());
  }
  SystemFallbackCache& cache = *c_collection->system_fallbacks;
  if (const auto found = cache.fonts.find(key); found != cache.fonts.end()) {
    found->second->second = std::move(font);
    cache.results.splice(cache.results.end(), cache.results, found->second);
    return;
  }
  while (cache.fonts.size() >= kMaxSystemFallbacks) {
    cache.fonts.erase(cache.results.front().first);
    cache.results.pop_front();
  }
  cache.results.emplace_back(key, std::move(font));
  cache.fonts[key] = std::prev(cache.results.end());
}

#if defined(__APPLE__)
MacFallbackInputs* SystemFallbackInputs(skiac_font_collection* c_collection) {
  if (!c_collection->system_fallbacks) {
    c_collection->system_fallbacks.reset(new SystemFallbackCache());
  }
  SystemFallbackCache& cache = *c_collection->system_fallbacks;
  if (!cache.inputs) {
    cache.inputs.reset(CreateMacFallbackInputs());
  }
  return cache.inputs.get();
}
#endif

namespace {

// font_platform_data_mac.mm VariableAxisChangeEffective.
bool VariableAxisChangeEffective(SkTypeface* typeface,
                                 SkFourByteTag axis,
                                 float value) {
  const int axis_count = typeface->getVariationDesignParameters({});
  if (axis_count <= 0) {
    return false;
  }
  std::vector<SkFontParameters::Variation::Axis> axes(axis_count);
  typeface->getVariationDesignParameters(axes);
  float clamped = value;
  for (const auto& parameters : axes) {
    if (parameters.tag == axis) {
      clamped = std::max(std::min(value, parameters.max), parameters.min);
    }
  }
  const int coordinate_count = typeface->getVariationDesignPosition({});
  if (coordinate_count <= 0) {
    return true;
  }
  std::vector<SkFontArguments::VariationPosition::Coordinate> coordinates(
      coordinate_count);
  typeface->getVariationDesignPosition(coordinates);
  for (const auto& coordinate : coordinates) {
    if (coordinate.axis == axis) {
      return coordinate.value != clamped;
    }
  }
  return true;
}

}  // namespace

sk_sp<SkTypeface> SystemFallbackInstance(skiac_font_collection* c_collection,
                                         sk_sp<SkTypeface> face,
                                         float opsz) {
  // FontPlatformDataFromCTFont with font-optical-sizing auto and no
  // variation settings: only opsz, at the specified size, when it changes
  // the face.
  constexpr SkFourByteTag kOpsz = SkSetFourByteTag('o', 'p', 's', 'z');
  const int count = face->getVariationDesignPosition({});
  if (count <= 0) {
    return face;
  }
  std::vector<SkFontArguments::VariationPosition::Coordinate> coordinates(
      count);
  if (face->getVariationDesignPosition(coordinates) != count) {
    return face;
  }
  bool changed = false;
  for (auto& coordinate : coordinates) {
    if (coordinate.axis == kOpsz &&
        VariableAxisChangeEffective(face.get(), kOpsz, opsz)) {
      coordinate.value = opsz;
      changed = true;
    }
  }
  if (!changed) {
    return face;
  }
  ShaperCaches& caches = GetShaperCaches(c_collection);
  uint32_t bits;
  memcpy(&bits, &opsz, sizeof(bits));
  const auto key = std::make_pair(face->uniqueID(), bits);
  if (const auto found = caches.instances.find(key);
      found != caches.instances.end()) {
    return found->second;
  }
  SkFontArguments args;
  args.setVariationDesignPosition(
      {coordinates.data(), static_cast<int>(coordinates.size())});
  sk_sp<SkTypeface> instance = face->makeClone(args);
  if (!instance) {
    return face;
  }
  if (caches.instances.size() >= kMaxSystemInstances) {
    caches.instances.clear();
  }
  caches.instances[key] = instance;
  return instance;
}
