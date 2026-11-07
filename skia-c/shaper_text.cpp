// The Blink shaper's text preparation (shaper.hpp PrepareText): the fillText
// string as UTF-16, normalized like PlainTextNode::NormalizeSpacesAndMaybeBidi
// for a canvas (plain_text_node.cc NormalizeSpacesAndMaybeBidiInternal).

#include <algorithm>

#include <src/core/SkUTF.h>

#include "shaper.hpp"

namespace {

// Character::IsNormalizedCanvasSpaceCharacter.
bool IsNormalizedCanvasSpace(int32_t c) {
  return c >= 0x09 && c <= 0x0D;
}

// Character::TreatAsSpace.
bool TreatAsSpace(int32_t c) {
  return c == 0x20 || c == 0x09 || c == 0x0A || c == 0xA0;
}

// Character::TreatAsZeroWidthSpaceInComplexScriptLegacy.
bool TreatAsZeroWidthSpaceInComplexScriptLegacy(int32_t c) {
  return c == 0x0C || c == 0x0D || c == 0xAD || c == 0x200B ||
         (c >= 0x200E && c <= 0x200F) || (c >= 0x202A && c <= 0x202E) ||
         c == 0xFEFF || c == 0xFFFC;
}

// Character::MaybeBidiRtl.
bool MaybeBidiRtl(int32_t c) {
  auto in = [c](int32_t from, int32_t to) { return c >= from && c <= to; };
  return c >= 0x0590 && c != 0x200B && !in(0x2010, 0x2029) &&
         !in(0x206A, 0xD7FF) && !in(0xFF00, 0xFFFF) && !in(0x1AFF0, 0x1B16F) &&
         !in(0x20000, 0x323AF);
}

}  // namespace

PreparedText PrepareText(const char* text, size_t length) {
  PreparedText prepared;
  prepared.original.reserve(length);
  prepared.utf8.reserve(length + 1);
  // The Rust side passes a str; an invalid byte (not reached) becomes
  // U+FFFD like a lossy decode.
  bool is_8bit = true;
  const char* ptr = text;
  const char* const end = text + length;
  while (ptr < end) {
    const uint32_t offset = static_cast<uint32_t>(ptr - text);
    SkUnichar c = SkUTF::NextUTF8(&ptr, end);
    if (c < 0) {
      c = 0xFFFD;
      ptr = std::min(end, text + offset + 1);
    }
    // to_blink_string.cc: a one-byte string when every code point fits.
    if (c > 0xFF) {
      is_8bit = false;
    }
    // NormalizeSpacesAndMaybeBidiInternal copies the text into a 16-bit
    // buffer once a character changes; in Latin-1 that is U+0009 to U+000D
    // (spaces) and U+00AD (a zero width space).
    if (IsNormalizedCanvasSpace(c) || c == 0xAD) {
      is_8bit = false;
    }
    if (prepared.maybe_bidi == false && MaybeBidiRtl(c)) {
      prepared.maybe_bidi = true;
    }
    uint16_t units[2];
    const size_t count = SkUTF::ToUTF16(c, units);
    for (size_t i = 0; i < count; ++i) {
      prepared.original.push_back(static_cast<char16_t>(units[i]));
      prepared.utf8.push_back(offset);
    }
  }
  prepared.utf8.push_back(static_cast<uint32_t>(length));
  prepared.is_8bit = is_8bit;
  // Every replacement is a BMP character for a BMP character, so the text
  // keeps its length.
  prepared.text = prepared.original;
  for (char16_t& unit : prepared.text) {
    const int32_t c = unit;
    if (IsNormalizedCanvasSpace(c)) {
      unit = u' ';
    } else if (TreatAsSpace(c) && c != 0xA0) {
      unit = u' ';
    } else if (TreatAsZeroWidthSpaceInComplexScriptLegacy(c)) {
      unit = 0x200B;
    }
  }
  return prepared;
}
