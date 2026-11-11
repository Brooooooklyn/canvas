// The Blink shaper's HanKerning (shaper.hpp): HanKerning and
// HanKerning::FontData of han_kerning.cc, and Character's
// GetHanKerningCharType (character_property_data_generator.cc). Blink adds
// `halt` to the open punctuation that follows open, middle or close
// punctuation, and to the close punctuation that close or middle
// punctuation follows, in a font that has `halt` (Fullwidth Punctuation
// Collapsing, css-text-4); a font with `chws` does this itself inside a run,
// so only the run's edges are computed for it. Blink's default `chws 1` is
// in BlinkFeatures (text_styles.cpp).

#include <algorithm>
#include <iterator>
#include <vector>

#include "icu_api.h"
#include "shaper.hpp"

namespace {

using CharType = HanKerningCharType;

constexpr hb_tag_t kHalt = SKIAC_HB_TAG('h', 'a', 'l', 't');
constexpr hb_tag_t kChws = SKIAC_HB_TAG('c', 'h', 'w', 's');
constexpr const char* kOtShaperList[] = {"ot", nullptr};

// The glyph-width GPOS features `chws` and `vchw` exclude.
bool IsExclusiveFeature(hb_tag_t tag) {
  static constexpr hb_tag_t kTags[] = {
      SKIAC_HB_TAG('h', 'a', 'l', 't'), SKIAC_HB_TAG('h', 'w', 'i', 'd'),
      SKIAC_HB_TAG('p', 'a', 'l', 't'), SKIAC_HB_TAG('p', 'w', 'i', 'd'),
      SKIAC_HB_TAG('q', 'w', 'i', 'd'), SKIAC_HB_TAG('t', 'w', 'i', 'd'),
      SKIAC_HB_TAG('v', 'a', 'l', 't'), SKIAC_HB_TAG('v', 'h', 'a', 'l'),
      SKIAC_HB_TAG('v', 'p', 'a', 'l'),
  };
  return std::find(std::begin(kTags), std::end(kTags), tag) != std::end(kTags);
}

bool ShouldKern(CharType type, CharType last_type) {
  return type == CharType::kOpen &&
         (last_type == CharType::kOpen || last_type == CharType::kMiddle ||
          last_type == CharType::kClose || last_type == CharType::kOpenNarrow);
}

bool ShouldKernLast(CharType type, CharType last_type) {
  return last_type == CharType::kClose &&
         (type == CharType::kClose || type == CharType::kMiddle ||
          type == CharType::kCloseNarrow);
}

// Character::MaybeHanKerningOpenOrCloseFast.
bool MaybeOpenOrCloseFast(char16_t ch) {
  return (ch >= 0x2018 && ch <= 0x301F) || (ch >= 0xFF08 && ch <= 0xFF60);
}

// HanKerning::GetCharType(UChar, const FontData&).
CharType GetCharType(char16_t ch, const HanKerningFontData& font_data) {
  const CharType type = GetHanKerningCharType(ch);
  switch (type) {
    case CharType::kDot:
      return font_data.type_for_dot;
    case CharType::kColon:
      return font_data.type_for_colon;
    case CharType::kSemicolon:
      return font_data.type_for_semicolon;
    case CharType::kOpenQuote:
      return font_data.is_quote_fullwidth ? CharType::kOpen
                                          : CharType::kOpenNarrow;
    case CharType::kCloseQuote:
      return font_data.is_quote_fullwidth ? CharType::kClose
                                          : CharType::kCloseNarrow;
    default:
      return type;
  }
}

// HarfBuzzShaper::GlyphData, horizontal.
struct GlyphData {
  uint32_t cluster;
  hb_codepoint_t glyph;
  float advance;
  SkRect bounds;  // relative to the paint origin (the glyph's offset added)
};

// CharTypeFromBounds (han_kerning.cc), horizontal.
CharType CharTypeFromBounds(float half_em, const SkRect& bound) {
  if (bound.right() <= half_em) {
    return CharType::kClose;
  }
  if (bound.left() >= half_em) {
    return CharType::kOpen;
  }
  if (bound.width() <= half_em && bound.left() >= half_em / 2) {
    return CharType::kMiddle;
  }
  return CharType::kOther;
}

CharType CharTypeFromBounds(const GlyphData& glyph) {
  if (!glyph.glyph) {
    return CharType::kOther;
  }
  return CharTypeFromBounds(glyph.advance / 2, glyph.bounds);
}

// The type of the first glyph with an id, when every other such glyph has
// its advance and its type; else kOther.
CharType CharTypeFromBounds(const GlyphData* glyphs, size_t count) {
  size_t i = 0;
  float advance0 = 0;
  float half_advance0 = 0;
  CharType type0 = CharType::kOther;
  for (;; ++i) {
    if (i >= count) {
      return CharType::kOther;
    }
    if (!glyphs[i].glyph) {
      continue;
    }
    advance0 = glyphs[i].advance;
    half_advance0 = advance0 / 2;
    type0 = CharTypeFromBounds(half_advance0, glyphs[i].bounds);
    break;
  }
  for (++i; i < count; ++i) {
    if (!glyphs[i].glyph) {
      continue;
    }
    if (glyphs[i].advance != advance0) {
      return CharType::kOther;
    }
    if (CharTypeFromBounds(half_advance0, glyphs[i].bounds) != type0) {
      return CharType::kOther;
    }
  }
  return type0;
}

}  // namespace

HanKerningCharType GetHanKerningCharType(char16_t ch) {
  // SetHanKerning: the listed characters, then the opening (Ps) and closing
  // (Pe) punctuation, fullwidth when in the CJK Symbols and Punctuation
  // block or East Asian Width F.
  switch (ch) {
    case 0x2018:  // LEFT SINGLE QUOTATION MARK
    case 0x201C:  // LEFT DOUBLE QUOTATION MARK
      return CharType::kOpenQuote;
    case 0x2019:  // RIGHT SINGLE QUOTATION MARK
    case 0x201D:  // RIGHT DOUBLE QUOTATION MARK
      return CharType::kCloseQuote;
    case 0x3000:  // IDEOGRAPHIC SPACE
    case 0x00B7:  // MIDDLE DOT
    case 0x2027:  // HYPHENATION POINT
    case 0x30FB:  // KATAKANA MIDDLE DOT
      return CharType::kMiddle;
    case 0x3001:  // IDEOGRAPHIC COMMA
    case 0x3002:  // IDEOGRAPHIC FULL STOP
    case 0xFF0C:  // FULLWIDTH COMMA
    case 0xFF0E:  // FULLWIDTH FULL STOP
      return CharType::kDot;
    case 0xFF1A:  // FULLWIDTH COLON
      return CharType::kColon;
    case 0xFF1B:  // FULLWIDTH SEMICOLON
      return CharType::kSemicolon;
    default:
      break;
  }
  const int category = u_charType(ch);
  if (category != U_START_PUNCTUATION && category != U_END_PUNCTUATION) {
    return CharType::kOther;
  }
  const bool fullwidth =
      u_getIntPropertyValue(ch, UCHAR_BLOCK) ==
          UBLOCK_CJK_SYMBOLS_AND_PUNCTUATION ||
      u_getIntPropertyValue(ch, UCHAR_EAST_ASIAN_WIDTH) == U_EA_FULLWIDTH;
  if (category == U_START_PUNCTUATION) {
    return fullwidth ? CharType::kOpen : CharType::kOpenNarrow;
  }
  return fullwidth ? CharType::kClose : CharType::kCloseNarrow;
}

HanKerningFontData ComputeHanKerningFontData(const FontEntry& font,
                                             hb_language_t language,
                                             int han_script) {
  HanKerningFontData data;
  hb_font_t* hb_font = font.hb.get();
  if (!hb_font) {
    return data;
  }
  // OpenTypeFeatures: the GPOS feature tags.
  hb_face_t* face = hb_font_get_face(hb_font);
  unsigned int total = hb_ot_layout_table_get_feature_tags(face, HB_OT_TAG_GPOS,
                                                           0, nullptr, nullptr);
  std::vector<hb_tag_t> tags(total);
  hb_ot_layout_table_get_feature_tags(face, HB_OT_TAG_GPOS, 0, &total,
                                      tags.data());
  tags.resize(total);
  auto contains = [&tags](hb_tag_t tag) {
    return std::find(tags.begin(), tags.end(), tag) != tags.end();
  };
  data.has_alternate_spacing = contains(kHalt);
  if (!data.has_alternate_spacing) {
    return data;
  }
#if defined(_WIN32)
  // Blink leaves "Yu Gothic UI" out until its fonts are fixed
  // (crbug.com/331123676).
  SkString postscript_name;
  if (font.face->getPostScriptName(&postscript_name) &&
      postscript_name.startsWith("YuGothicUI")) {
    data.has_alternate_spacing = false;
    return data;
  }
#endif
  data.has_contextual_spacing = contains(kChws);

  // The dot (full stop and comma), colon, semicolon and quote characters,
  // shaped with the font for the locale (HarfBuzzShaper::GetGlyphData: no
  // features), then classed by their glyphs' bounds.
  static constexpr char16_t kChars[] = {
      0x3001, 0x3002, 0xFF0C, 0xFF0E,  // dot
      0xFF1A, 0xFF1B,                  // colon, semicolon
      0x201C, 0x2018, 0x201D, 0x2019,  // quotes
  };
  constexpr size_t kCount = std::size(kChars);
  constexpr size_t kDotSize = 4;
  constexpr size_t kColonIndex = 4;
  constexpr size_t kSemicolonIndex = 5;
  constexpr size_t kQuoteStartIndex = 6;
  hb_buffer_t* buffer = hb_buffer_create();
  hb_buffer_set_language(buffer, language);
  hb_buffer_set_script(buffer, IcuScriptToHbScript(han_script));
  hb_buffer_set_direction(buffer, HB_DIRECTION_LTR);
  hb_buffer_add_utf16(buffer, reinterpret_cast<const uint16_t*>(kChars),
                      static_cast<int>(kCount), 0, static_cast<int>(kCount));
  hb_shape_full(hb_font, buffer, nullptr, 0, kOtShaperList);
  unsigned int count = 0;
  const hb_glyph_info_t* infos = hb_buffer_get_glyph_infos(buffer, &count);
  const hb_glyph_position_t* positions =
      hb_buffer_get_glyph_positions(buffer, nullptr);
  std::vector<GlyphData> glyphs;
  bool applicable = count == kCount;
  for (unsigned int i = 0; applicable && i < count; ++i) {
    // One glyph per character, in order.
    if (infos[i].cluster != i) {
      applicable = false;
      break;
    }
    // HarfBuzzPositionToFloat; the offset's y is flipped.
    const float x_offset = static_cast<float>(positions[i].x_offset) / 65536;
    const float y_offset = -static_cast<float>(positions[i].y_offset) / 65536;
    const hb_codepoint_t glyph = infos[i].codepoint;
    SkRect bounds = BlinkGlyphBounds(font.draw_font,
                                     static_cast<SkGlyphID>(glyph & 0xFFFF));
    bounds.offset(x_offset, y_offset);
    glyphs.push_back({infos[i].cluster, glyph,
                      static_cast<float>(positions[i].x_advance) / 65536,
                      bounds});
  }
  hb_buffer_destroy(buffer);
  if (!applicable) {
    data.has_alternate_spacing = false;
    return data;
  }
  data.type_for_dot = CharTypeFromBounds(glyphs.data(), kDotSize);
  data.type_for_colon = CharTypeFromBounds(glyphs[kColonIndex]);
  data.type_for_semicolon = CharTypeFromBounds(glyphs[kSemicolonIndex]);
  // Quotes are fullwidth when both open quotes are open and both close
  // quotes close.
  const GlyphData* quotes = glyphs.data() + kQuoteStartIndex;
  data.is_quote_fullwidth =
      CharTypeFromBounds(quotes, 2) == CharType::kOpen &&
      CharTypeFromBounds(quotes + 2, 2) == CharType::kClose;
  return data;
}

HanKerning::HanKerning(const char16_t* text,
                       uint32_t length,
                       uint32_t segment_start,
                       uint32_t segment_end)
    : text_(text),
      length_(length),
      may_apply_(std::any_of(text + segment_start,
                             text + segment_end,
                             MaybeOpenOrCloseFast)),
      segment_start_(segment_start),
      segment_end_(segment_end) {}

bool HanKerning::RangeMayApply(uint32_t start, uint32_t end) const {
  if (start == segment_start_ && end == segment_end_) {
    return true;
  }
  return std::any_of(text_ + start, text_ + end, MaybeOpenOrCloseFast);
}

// GetCharType(text, index, font_data, priority) with GetCharTypeWithCache
// once PrepareFallback made the cache (no TextSpacingTrimFallback2 indexes).
HanKerningCharType HanKerning::CharType(uint32_t index,
                                        const HanKerningFontData& font_data,
                                        Priority priority) {
  if (char_types_.empty()) {
    return GetCharType(text_[index], font_data);
  }
  const HanKerningCharType cached = char_types_[index];
  if (priority == Priority::kCache && cached != HanKerningCharType::kInvalid) {
    return cached;
  }
  const HanKerningCharType type = GetCharType(text_[index], font_data);
  if (type != cached) {
    char_types_[index] = type;
  }
  return type;
}

bool HanKerning::AppendFontFeatures(uint32_t start,
                                    uint32_t end,
                                    const HanKerningFontData& font_data,
                                    std::vector<hb_feature_t>* features) {
  if (!font_data.has_alternate_spacing) {
    return false;
  }
  for (const hb_feature_t& feature : *features) {
    if (feature.value && IsExclusiveFeature(feature.tag)) {
      return false;
    }
  }
  last_start_ = start;
  last_end_ = end;
  is_start_prev_used_ = false;
  is_end_next_used_ = false;
  last_font_data_ = font_data;

  // The first character (a canvas line is never a wrapped line start).
  std::vector<uint32_t> indices;
  HanKerningCharType last_type;
  if (start) {
    is_start_prev_used_ = true;
    last_type = CharType(start - 1, font_data, Priority::kCache);
    const HanKerningCharType type = CharType(start, font_data);
    if (ShouldKern(type, last_type)) {
      indices.push_back(start);
    }
    last_type = type;
  } else {
    last_type = CharType(start, font_data);
  }

  if (font_data.has_contextual_spacing) {
    // `chws` handles the characters inside the range
    // (TextSpacingTrimFallbackChws, stable): only the end edge, when other
    // ranges follow.
    if (end < length_) {
      if (end - 1 > start) {
        last_type = GetCharType(text_[end - 1], font_data);
      }
      is_end_next_used_ = true;
      const HanKerningCharType type = GetCharType(text_[end], font_data);
      if (ShouldKernLast(type, last_type)) {
        indices.push_back(end - 1);
      }
    }
  } else {
    // The characters in the middle, then the last one.
    HanKerningCharType type;
    for (uint32_t i = start + 1; i < end; ++i, last_type = type) {
      type = CharType(i, font_data);
      if (ShouldKernLast(type, last_type)) {
        indices.push_back(i - 1);
      } else if (ShouldKern(type, last_type)) {
        indices.push_back(i);
      }
    }
    if (end < length_) {
      is_end_next_used_ = true;
      type = CharType(end, font_data, Priority::kCache);
      if (ShouldKernLast(type, last_type)) {
        indices.push_back(end - 1);
      }
    }
  }

  features->reserve(features->size() + indices.size());
  for (const uint32_t i : indices) {
    features->push_back({kHalt, 1, i, i + 1});
  }
  return true;
}

void HanKerning::PrepareFallback() {
  if (char_types_.empty()) {
    char_types_.assign(length_, HanKerningCharType::kInvalid);
  }
  uint32_t start = last_start_;
  if (is_start_prev_used_ &&
      char_types_[start - 1] == HanKerningCharType::kInvalid) {
    --start;
  }
  uint32_t end = last_end_;
  if (is_end_next_used_ && char_types_[end] == HanKerningCharType::kInvalid) {
    ++end;
  }
  for (uint32_t i = start; i < end; ++i) {
    char_types_[i] = GetCharType(text_[i], last_font_data_);
  }
}
