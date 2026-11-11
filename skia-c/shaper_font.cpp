// The Blink shaper's HarfBuzz fonts (shaper.hpp): a face and parent font
// per typeface (HarfBuzzFace, harfbuzz_face.cc), and for each FontEntry a
// sub font with Blink's font funcs over the entry's draw font
// (HarfBuzzSkiaGetFontFuncs: HarfBuzzGetGlyph, SkFontGetGlyphWidthForHarfBuzz
// and SkFontGetGlyphExtentsForHarfBuzz of skia_text_metrics.cc).

#include <math.h>

#include <limits>
#include <list>
#include <unordered_map>

#include "shaper.hpp"

struct HbFontData {
  SkFont font;
  VariationSelectorMode mode = VariationSelectorMode::kUseSpecified;
};

// The parent fonts by typeface, least recently used first (LRU 100, like
// skshaper's face cache), and the buffer.
struct ShaperCaches {
  struct Parent {
    HbFontRef font;
    std::list<SkTypefaceID>::iterator lru;
  };
  std::unordered_map<SkTypefaceID, Parent> parents;
  std::list<SkTypefaceID> lru;
  hb_buffer_t* buffer = nullptr;

  ~ShaperCaches() {
    if (buffer) {
      hb_buffer_destroy(buffer);
    }
  }
};

void DestroyShaperCaches(ShaperCaches* caches) {
  delete caches;
}

namespace {

constexpr size_t kMaxParents = 100;

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

// HarfBuzzFace's parent font: the face with HarfBuzz's OpenType funcs at the
// typeface's variation position (harfbuzz_face.cc, SkShaper_harfbuzz.cpp
// create_typeface_hb_font).
hb_font_t* ParentFont(skiac_font_collection* c_collection,
                      SkTypeface* typeface) {
  ShaperCaches& caches = GetShaperCaches(c_collection);
  const SkTypefaceID id = typeface->uniqueID();
  auto found = caches.parents.find(id);
  if (found != caches.parents.end()) {
    caches.lru.splice(caches.lru.end(), caches.lru, found->second.lru);
    return found->second.font.get();
  }
  // A FontEntry keeps its own reference to the sub font, which keeps the
  // parent: dropping the cache's reference never frees a font in use.
  while (caches.parents.size() >= kMaxParents) {
    caches.parents.erase(caches.lru.front());
    caches.lru.pop_front();
  }
  hb_face_t* face = CreateHbFace(typeface);
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
  auto& parent = caches.parents[id];
  parent.font = HbFontRef(font);
  parent.lru = caches.lru.insert(caches.lru.end(), id);
  return font;
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
// (font-variant-emoji normal: kUseSpecifiedVariationSelector) and
// SystemFallbackEmojiVSSupport (stable). A selector after a character makes
// a variation sequence here; LayOutLineBlink turns down text with one until
// the VS fallback pass is ported (stage S3).
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
      IsUnicodeVariationSelector(variation_selector);
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
  if (consider_variation_selector && has_base_glyph &&
      (text_presentation_requested || emoji_presentation_requested)) {
    const bool has_color_table = HasColorTable(data->font.getTypeface());
    if ((has_color_table && text_presentation_requested) ||
        (!has_color_table && emoji_presentation_requested)) {
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
  for (unsigned int i = 0; i < count; ++i) {
    glyphs[i] = static_cast<SkGlyphID>(*reinterpret_cast<const hb_codepoint_t*>(
        reinterpret_cast<const char*>(first_glyph) + i * glyph_stride));
  }
  std::vector<SkScalar> widths(count);
  font.getWidths(glyphs, widths);
  for (unsigned int i = 0; i < count; ++i) {
    SkScalar width = widths[i];
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
  const SkGlyphID glyph = static_cast<SkGlyphID>(codepoint);
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
  extents->x_bearing = SkiaScalarToHarfBuzzPosition(bounds.fLeft);
  extents->y_bearing = SkiaScalarToHarfBuzzPosition(-bounds.fTop);
  extents->width = SkiaScalarToHarfBuzzPosition(bounds.width());
  extents->height = SkiaScalarToHarfBuzzPosition(-bounds.height());
  return true;
}

hb_font_funcs_t* FontFuncs() {
  static hb_font_funcs_t* const funcs = [] {
    hb_font_funcs_t* f = hb_font_funcs_create();
    hb_font_funcs_set_variation_glyph_func(f, GetGlyph, nullptr, nullptr);
    hb_font_funcs_set_nominal_glyph_func(f, GetNominalGlyph, nullptr, nullptr);
    hb_font_funcs_set_glyph_h_advance_func(f, GetAdvance, nullptr, nullptr);
    hb_font_funcs_set_glyph_h_advances_func(f, GetAdvances, nullptr, nullptr);
    hb_font_funcs_set_glyph_extents_func(f, GetExtents, nullptr, nullptr);
    hb_font_funcs_make_immutable(f);
    return f;
  }();
  return funcs;
}

}  // namespace

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

bool MakeEntryFont(skiac_font_collection* c_collection, FontEntry* entry) {
  hb_font_t* parent = ParentFont(c_collection, entry->face.get());
  if (!parent) {
    return false;
  }
  hb_font_t* font = hb_font_create_sub_font(parent);
  auto* data = new HbFontData{entry->draw_font};
  hb_font_set_funcs(font, FontFuncs(), data,
                    [](void* ptr) { delete static_cast<HbFontData*>(ptr); });
  // harfbuzz_face.cc GetScaledFont: SkiaScalarToHarfBuzzPosition of the
  // size. No ptem before stage S6: HarfBuzz applies trak at 12 pt, as
  // skshaper does.
  const hb_position_t scale = SkiaScalarToHarfBuzzPosition(entry->size);
  hb_font_set_scale(font, scale, scale);
  entry->hb = HbFontRef(font);
  entry->hb_data = data;
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
