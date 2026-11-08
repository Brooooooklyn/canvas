// The Blink shaper's letter and word spacing (shaper.hpp ApplySpacing):
// ShapeResultSpacing::ComputeSpacing (shape_result_spacing.cc) through
// ShapeResult::ApplySpacingOrExpansion (shape_result.cc), as
// PlainTextNode::Shape applies it to each item of a canvas text.

#include <limits>

#include "icu_api.h"
#include "shaper.hpp"

namespace {

// TextRunLayoutUnit (FixedPoint<16, int32_t>) from a float: the product in
// float, then base::saturated_cast (towards zero, NaN to 0).
int32_t TextRunLayoutUnit(float value) {
  const float raw = value * (1 << 16);
  if (raw != raw) {
    return 0;
  }
  if (raw >= static_cast<float>(std::numeric_limits<int32_t>::max())) {
    return std::numeric_limits<int32_t>::max();
  }
  if (raw <= static_cast<float>(std::numeric_limits<int32_t>::min())) {
    return std::numeric_limits<int32_t>::min();
  }
  return static_cast<int32_t>(raw);
}

// base::ClampAdd for TextRunLayoutUnit.
int32_t ClampAdd(int32_t a, int32_t b) {
  const int64_t sum = static_cast<int64_t>(a) + b;
  if (sum > std::numeric_limits<int32_t>::max()) {
    return std::numeric_limits<int32_t>::max();
  }
  if (sum < std::numeric_limits<int32_t>::min()) {
    return std::numeric_limits<int32_t>::min();
  }
  return static_cast<int32_t>(sum);
}

// shape_result.cc IsCursiveScript, on the run's UScriptCode (the segment's
// script, which the HarfBuzz script is made from).
bool IsCursiveScript(int script) {
  switch (script) {
    case USCRIPT_ARABIC:
    case USCRIPT_HANIFI_ROHINGYA:
    case USCRIPT_MANDAIC:
    case USCRIPT_MONGOLIAN:
    case USCRIPT_NKO:
    case USCRIPT_PHAGS_PA:
    case USCRIPT_SYRIAC:
      return true;
    default:
      return false;
  }
}

// Character::TreatAsSpace, and IsNormalizedCanvasSpaceCharacter (a canvas
// spacing normalizes spaces; the prepared text has none of 09-0D left).
bool TreatAsSpace(char16_t c) {
  return c == 0x20 || c == 0x09 || c == 0x0A || c == 0xA0 ||
         (c >= 0x09 && c <= 0x0D);
}

// Character::TreatAsZeroWidthSpace: FF, CR, U+FFFC, a default ignorable
// code point (Character::IsDefaultIgnorable: below U+0100 only SHY), ZWNJ
// and ZWJ. Blink reads one UTF-16 unit.
bool TreatAsZeroWidthSpace(char16_t c) {
  if (c == 0x0C || c == 0x0D || c == 0xFFFC || c == 0x200C || c == 0x200D) {
    return true;
  }
  if (c < 0x0100) {
    return c == 0xAD;
  }
  return u_hasBinaryProperty(static_cast<UChar32>(c),
                             UCHAR_DEFAULT_IGNORABLE_CODE_POINT);
}

}  // namespace

void ApplySpacing(const PreparedText& prepared,
                  float letter_spacing,
                  float word_spacing,
                  std::vector<ShapedItem>* items) {
  // ShapeResultSpacing::SetSpacing: nothing when both are 0 as
  // TextRunLayoutUnit.
  const int32_t letter = TextRunLayoutUnit(letter_spacing);
  const int32_t word = TextRunLayoutUnit(word_spacing);
  if (!letter && !word) {
    return;
  }
  const std::u16string& text = prepared.text;
  for (ShapedItem& shaped : *items) {
    float total_advance = 0;
    for (ShapedRun& run : shaped.result.runs) {
      const uint32_t run_start_index = shaped.item.start + run.start;
      const bool cursive = IsCursiveScript(run.script);
      // InlineLayoutUnit: 16.16 in 64 bits.
      int64_t total_advance_for_run = 0;
      for (size_t i = 0; i < run.glyphs.size(); ++i) {
        ShapedGlyph& glyph = run.glyphs[i];
        // Only the last glyph of a cluster (HarfBuzz order) takes spacing.
        if (i + 1 < run.glyphs.size() &&
            glyph.character_index == run.glyphs[i + 1].character_index) {
          total_advance_for_run += glyph.advance;
          continue;
        }
        // ShapeResultSpacing::ComputeSpacing.
        const uint32_t index = run_start_index + glyph.character_index;
        char16_t character = text[index];
        const bool treat_as_space = TreatAsSpace(character);
        if (treat_as_space && character != 0xA0) {
          character = 0x20;
        }
        int32_t spacing = 0;
        // IgnoreLetterSpacingInCursiveScripts (stable): no letter spacing
        // between the letters of a cursive script, but on its spaces.
        if (letter && !TreatAsZeroWidthSpace(character) &&
            (!cursive || treat_as_space)) {
          spacing = ClampAdd(spacing, letter);
        }
        if (treat_as_space && (index || character == 0xA0)) {
          spacing = ClampAdd(spacing, word);
        }
        glyph.advance = ClampAdd(glyph.advance, spacing);
        total_advance_for_run += glyph.advance;
      }
      // Not clamped at 0 now.
      run.width = static_cast<float>(total_advance_for_run) / (1 << 16);
      total_advance += run.width;
    }
    shaped.result.width = total_advance;
  }
}
