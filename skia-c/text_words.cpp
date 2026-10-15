// Word-by-word shaping like Blink's PlainTextNode: canvas text is split into
// words (NextWordEndIndex) that HarfBuzz shapes one by one, unless kerning or
// ligatures are on and the font kerns or ligates the space
// (FontFallbackList::CanShapeWordByWord).

#include <array>
#include <iterator>
#include <string>

#include <src/core/SkUTF.h>
#include "icu_api.h"
#include "text.hpp"

#if defined(SK_DEBUG) || !defined(SK_RELEASE)
#error "skia-c must be built with SK_RELEASE like libskia (see build.rs)"
#endif

namespace {

constexpr UChar32 kTab = 0x9;
constexpr UChar32 kSpace = 0x20;
constexpr UChar32 kZeroWidthSpace = 0x200B;
constexpr UChar32 kZeroWidthJoiner = 0x200D;

// character_property_data.h kIsCjkIdeographOrSymbolArray.
constexpr auto kCjkSymbols = std::to_array<UChar32>({
    0x2C7,   0x2CA,   0x2CB,   0x2D9,   0x2020,  0x2021,  0x2030,  0x203B,
    0x203C,  0x2042,  0x2047,  0x2048,  0x2049,  0x2051,  0x20DD,  0x20DE,
    0x2100,  0x2103,  0x2105,  0x2109,  0x210A,  0x2113,  0x2116,  0x2121,
    0x212B,  0x213B,  0x2150,  0x2151,  0x2152,  0x217F,  0x2189,  0x2307,
    0x2312,  0x23CE,  0x2423,  0x25A0,  0x25A1,  0x25A2,  0x25AA,  0x25AB,
    0x25B1,  0x25B2,  0x25B3,  0x25B6,  0x25B7,  0x25BC,  0x25BD,  0x25C0,
    0x25C1,  0x25C6,  0x25C7,  0x25C9,  0x25CB,  0x25CC,  0x25EF,  0x2605,
    0x2606,  0x260E,  0x2616,  0x2617,  0x26A0,  0x2713,  0x271A,  0x273F,
    0x2740,  0x2756,  0x2763,  0x2B1A,  0xFE10,  0xFE11,  0xFE12,  0xFE19,
    0xFF1D,  0x1F100, 0x1F200, 0x1F237, 0x1F32C, 0x1F336, 0x1F37D, 0x1F43F,
    0x1F54F, 0x1F93B, 0x1F946,
});

// character_property_data.h kIsCjkIdeographOrSymbolRanges, inclusive pairs.
constexpr auto kCjkRanges = std::to_array<UChar32>({
    0x2E80,  0x2FDF,  0x31C0,  0x31EF,  0x3400,  0x4DBF,  0x4E00,  0x9FFF,
    0xF900,  0xFAFF,  0x20000, 0x2FFFF, 0x2156,  0x215A,  0x2160,  0x216B,
    0x2170,  0x217B,  0x23BE,  0x23CC,  0x2460,  0x2492,  0x249C,  0x24FF,
    0x25CE,  0x25D3,  0x25E2,  0x25E6,  0x2600,  0x2603,  0x2660,  0x266F,
    0x2672,  0x267D,  0x2776,  0x277F,  0x2FF0,  0x302D,  0x3031,  0x312F,
    0x3190,  0x31BF,  0x3200,  0x33FF,  0x4DC0,  0x4DFF,  0xF860,  0xF862,
    0xFE30,  0xFE6F,  0xFF00,  0xFF0C,  0xFF0E,  0xFF1A,  0xFF1F,  0xFFEF,
    0x16FE0, 0x16FFF, 0x17000, 0x187FF, 0x18800, 0x18AFF, 0x1B000, 0x1B0FF,
    0x1B100, 0x1B12F, 0x1B170, 0x1B2FF, 0x1F110, 0x1F129, 0x1F130, 0x1F149,
    0x1F150, 0x1F169, 0x1F170, 0x1F189, 0x1F202, 0x1F219, 0x1F21B, 0x1F22E,
    0x1F230, 0x1F231, 0x1F23B, 0x1F24F, 0x1F252, 0x1F2FF, 0x1F321, 0x1F32A,
    0x1F394, 0x1F39F, 0x1F3CD, 0x1F3CE, 0x1F3D4, 0x1F3DF, 0x1F3F1, 0x1F3F2,
    0x1F3F5, 0x1F3F7, 0x1F4FD, 0x1F4FE, 0x1F53E, 0x1F54A, 0x1F568, 0x1F573,
    0x1F576, 0x1F579, 0x1F57B, 0x1F58F, 0x1F591, 0x1F594, 0x1F597, 0x1F5A3,
    0x1F5A5, 0x1F5E7, 0x1F5E9, 0x1F5FA, 0x1F650, 0x1F67F, 0x1F6C6, 0x1F6CB,
    0x1F6CD, 0x1F6CF, 0x1F6D3, 0x1F6D4, 0x1F6D9, 0x1F6DB, 0x1F6E0, 0x1F6EA,
    0x1F6ED, 0x1F6F3, 0x1F6FD, 0x1F6FF, 0x1F900, 0x1F90B, 0x1FAC9, 0x1FACC,
});

// Character::IsCjkIdeographOrSymbol. Blink also marks the text-default
// Extended_Pictographic members of RGI emoji ZWJ and modifier sequences;
// those are left out here.
bool IsCjkIdeographOrSymbol(UChar32 c) {
  if (c < 0x2C7) {
    return false;
  }
  for (UChar32 symbol : kCjkSymbols) {
    if (c == symbol) {
      return true;
    }
  }
  for (size_t i = 0; i + 1 < kCjkRanges.size(); i += 2) {
    if (c >= kCjkRanges[i] && c <= kCjkRanges[i + 1]) {
      return true;
    }
  }
  return u_hasBinaryProperty(c, UCHAR_EMOJI_PRESENTATION);
}

bool IsMarkOrModifier(UChar32 c) {
  switch (u_charType(c)) {
    case U_NON_SPACING_MARK:
    case U_ENCLOSING_MARK:
    case U_COMBINING_SPACING_MARK:
    case U_MODIFIER_LETTER:
    case U_MODIFIER_SYMBOL:
      return true;
    default:
      return false;
  }
}

bool IsCjkIdeographOrSymbolBase(UChar32 c) {
  return IsCjkIdeographOrSymbol(c) && !IsMarkOrModifier(c);
}

bool IsCommonOrInheritedScript(UChar32 c) {
  UErrorCode status = 0;
  const int script = uscript_getScript(c, &status);
  return status <= 0 &&
         (script == USCRIPT_COMMON || script == USCRIPT_INHERITED);
}

// Character::TreatAsZeroWidthSpaceInComplexScriptLegacy without form feed
// and carriage return (spaces on a canvas): PlainTextNode makes these
// zero width spaces, which end words. They stay in the text here, where
// HarfBuzz draws them with no width and the bidi controls keep their
// effect (Blink runs BiDi on the original text).
bool IsZeroWidthSpaceLike(UChar32 c) {
  return c == 0xAD || c == kZeroWidthSpace || c == 0x200E || c == 0x200F ||
         (c >= 0x202A && c <= 0x202E) || c == 0xFEFF || c == 0xFFFC;
}

bool IsWordDelimiter(UChar32 c) {
  return c == kSpace || c == kTab || IsZeroWidthSpaceLike(c);
}

struct CodePoint {
  UChar32 value;
  size_t end;  // byte offset just past it
};

// plain_text_node.cc NextWordEndIndex over code points: the index of the
// first code point after the word that starts at `start`.
size_t NextWordEnd(const std::vector<CodePoint>& text, size_t start) {
  const size_t length = text.size();
  if (start + 1 == length || IsWordDelimiter(text[start].value)) {
    return start + 1;
  }
  size_t end = start + 1;
  UChar32 ch = text[start].value;
  if (!IsCjkIdeographOrSymbol(ch)) {
    for (; end < length; ++end) {
      ch = text[end].value;
      if (IsWordDelimiter(ch) || IsCjkIdeographOrSymbolBase(ch)) {
        return end;
      }
    }
    return length;
  }
  // CJK and emoji: one word per character, keeping marks, modifiers, ZWJ
  // sequences and common-script symbols with the character before them.
  bool has_any_script = !IsCommonOrInheritedScript(ch);
  for (; end < length; ++end) {
    ch = text[end].value;
    if (IsMarkOrModifier(ch) || ch == kZeroWidthJoiner ||
        u_hasBinaryProperty(ch, UCHAR_EMOJI_COMPONENT) ||
        u_hasBinaryProperty(ch, UCHAR_EXTENDED_PICTOGRAPHIC)) {
      continue;
    }
    if (IsCjkIdeographOrSymbol(ch)) {
      if (IsCommonOrInheritedScript(ch)) {
        continue;
      }
      if (!has_any_script) {
        has_any_script = true;
        continue;
      }
    }
    return end;
  }
  return length;
}

// HarfBuzzFace::HasSpaceInLigaturesOrKerning's TableHasSpace: any lookup of
// the table that reads or writes `space`.
bool TableHasSpace(hb_face_t* face, hb_tag_t table, hb_codepoint_t space) {
  hb_set_t* glyphs = hb_set_create();
  bool found = false;
  const unsigned int count = hb_ot_layout_table_get_lookup_count(face, table);
  for (unsigned int i = 0; i < count && !found; ++i) {
    hb_ot_layout_lookup_collect_glyphs(face, table, i, glyphs, glyphs, glyphs,
                                       nullptr);
    found = hb_set_has(glyphs, space);
  }
  hb_set_destroy(glyphs);
  return found;
}

}  // namespace

std::string_view PrepareCanvasText(std::string_view text,
                                   std::string* storage) {
  // U+2028 and U+2029 (E2 80 A8/A9) and U+FFFC (EF BF BC).
  auto special = [&](size_t i) {
    const auto c = static_cast<unsigned char>(text[i]);
    if (c >= 0x09 && c <= 0x0D) {
      return true;
    }
    if (i + 2 >= text.size()) {
      return false;
    }
    const auto c1 = static_cast<unsigned char>(text[i + 1]);
    const auto c2 = static_cast<unsigned char>(text[i + 2]);
    return (c == 0xE2 && c1 == 0x80 && (c2 == 0xA8 || c2 == 0xA9)) ||
           (c == 0xEF && c1 == 0xBF && c2 == 0xBC);
  };
  size_t i = 0;
  while (i < text.size() && !special(i)) {
    ++i;
  }
  if (i == text.size()) {
    return text;
  }
  storage->assign(text.substr(0, i));
  while (i < text.size()) {
    if (!special(i)) {
      storage->push_back(text[i++]);
    } else if (static_cast<unsigned char>(text[i]) <= 0x0D) {
      storage->push_back(' ');
      ++i;
    } else if (static_cast<unsigned char>(text[i]) == 0xE2) {
      // HarfBuzzFace draws the line and paragraph separators with the space
      // glyph; skparagraph would break the line at them.
      storage->push_back(' ');
      i += 3;
    } else {
      storage->append("\xE2\x80\x8B");  // U+200B
      i += 3;
    }
  }
  return *storage;
}

std::vector<std::pair<size_t, size_t>> SplitWords(std::string_view text) {
  std::vector<CodePoint> code_points;
  code_points.reserve(text.size());
  const char* ptr = text.data();
  const char* const end = text.data() + text.size();
  while (ptr < end) {
    SkUnichar c = SkUTF::NextUTF8(&ptr, end);
    if (c < 0) {
      // Not UTF-8 (the Rust side only passes str): one word.
      return {{0, text.size()}};
    }
    code_points.push_back({c, static_cast<size_t>(ptr - text.data())});
  }
  std::vector<std::pair<size_t, size_t>> words;
  for (size_t index = 0; index < code_points.size();) {
    const size_t next = NextWordEnd(code_points, index);
    words.emplace_back(index ? code_points[index - 1].end : 0,
                       code_points[next - 1].end);
    index = next;
  }
  return words;
}

bool CanShapeWordByWord(skiac_font_collection* c_collection,
                        const std::vector<sk_sp<SkTypeface>>& faces,
                        const skiac_text_request& request) {
  // FontDescription::UpdateTypesettingFeatures (text_rendering 2 and 3 are
  // optimizeLegibility and geometricPrecision; kerning 1 none, 2 normal).
  const bool legible =
      request.text_rendering == 2 || request.text_rendering == 3;
  const bool kerning =
      request.kerning != 1 && (legible || request.kerning == 2);
  const bool ligatures = legible;
  if (!kerning && !ligatures) {
    return true;
  }
  // PrimarySimpleFontDataWithSpace.
  SkTypeface* primary = nullptr;
  SkGlyphID space = 0;
  for (const auto& face : faces) {
    space = face->unicharToGlyph(kSpace);
    if (space) {
      primary = face.get();
      break;
    }
  }
  if (!primary) {
    return false;
  }
  // Bits: 1 GPOS checked, 2 space in GPOS, 4 GSUB checked, 8 space in GSUB.
  auto& cache = c_collection->space_in_lookups;
  if (cache.size() > 1024) {
    cache.clear();
  }
  uint8_t& state = cache[primary->uniqueID()];
  if ((kerning && !(state & 1)) || (ligatures && !(state & 4))) {
    hb_face_t* face = CreateHbFace(primary);
    if (kerning && !(state & 1)) {
      state |= 1;
      if (hb_ot_layout_has_positioning(face) &&
          TableHasSpace(face, HB_OT_TAG_GPOS, space)) {
        state |= 2;
      }
    }
    if (ligatures && !(state & 4)) {
      state |= 4;
      if (hb_ot_layout_has_substitution(face) &&
          TableHasSpace(face, HB_OT_TAG_GSUB, space)) {
        state |= 8;
      }
    }
    hb_face_destroy(face);
  }
  return !((kerning && (state & 2)) || (ligatures && (state & 8)));
}
