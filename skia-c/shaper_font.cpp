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
          uint64_t{key.weight_bits}, uint64_t{key.slope_bits},
          static_cast<uint64_t>(key.pixel_size)}) {
      hash = hash * 31 + std::hash<uint64_t>()(part);
    }
    return hash;
  }
};

struct ShaperCaches {
  struct Parent {
    HbFontRef font;
    std::list<SkTypefaceID>::iterator lru;
  };
  std::unordered_map<SkTypefaceID, Parent> parents;
  std::list<SkTypefaceID> lru;
  hb_buffer_t* buffer = nullptr;
  // The system fallback results (FontCache's character fallback), and the
  // opsz instances of the system fallback faces.
  std::unordered_map<SystemFallbackKey,
                     SystemFallbackFont,
                     SystemFallbackKeyHash>
      fallback;
  std::map<std::pair<SkTypefaceID, uint32_t>, sk_sp<SkTypeface>> instances;

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
constexpr size_t kMaxSystemFallbacks = 1024;
constexpr size_t kMaxSystemInstances = 256;

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

const SystemFallbackFont* FindSystemFallback(
    skiac_font_collection* c_collection,
    const SystemFallbackKey& key) {
  ShaperCaches& caches = GetShaperCaches(c_collection);
  const auto found = caches.fallback.find(key);
  return found == caches.fallback.end() ? nullptr : &found->second;
}

void StoreSystemFallback(skiac_font_collection* c_collection,
                         const SystemFallbackKey& key,
                         SystemFallbackFont font) {
  ShaperCaches& caches = GetShaperCaches(c_collection);
  if (caches.fallback.size() >= kMaxSystemFallbacks) {
    caches.fallback.clear();
  }
  caches.fallback[key] = std::move(font);
}

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
