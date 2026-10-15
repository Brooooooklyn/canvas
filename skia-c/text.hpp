// Shared by the canvas text files (text.cpp, font_families.cpp,
// text_metrics.cpp).

#ifndef SKIA_C_TEXT_H
#define SKIA_C_TEXT_H

#include <optional>
#include <vector>

#include "skia_c.hpp"

// The families skparagraph should use for `request`, like Blink's
// FontFallbackList: each family of the font resolved to the spelling the
// collection knows (case-insensitive, generic families through the platform
// defaults) and, last, the standard font. Families that resolve to nothing
// are left out.
std::vector<SkString> ResolveFontFamilies(skiac_font_collection* c_collection,
                                          const skiac_text_request& request);

// The primary font's metrics TextMetrics reads, in px, y up
// (text_metrics.cpp).
struct PrimaryFontMetrics {
  // FontMetrics FloatAscent / FloatDescent (AscentDescentWithHacks).
  float ascent = 0;
  float descent = 0;
  // SimpleFontData::NormalizedTypoAscentAndDescent, in LayoutUnits.
  float typo_ascent = 0;
  float typo_descent = 0;
  // The BASE table's romn, hang and ideo baselines.
  std::optional<float> alphabetic;
  std::optional<float> hanging;
  std::optional<float> ideographic;
  // SkFontMetrics fXHeight and fCapHeight (0 when the font does not say),
  // for the font-metric units of ctx.filter (FontSizes::Ex and Cap read the
  // primary font).
  float x_height = 0;
  float cap_height = 0;
};

// `typeface` at `size` px; `base_typeface` is the same face before font
// arguments, which tells a system font from a web font.
PrimaryFontMetrics MeasurePrimaryFont(skiac_font_collection* c_collection,
                                      SkTypeface* typeface,
                                      SkTypeface* base_typeface,
                                      float size);

// TextMetrics::GetFontBaseline for a CssBaseline.
float FontBaseline(int baseline, const PrimaryFontMetrics& metrics);

// The TextMetrics fields that come from the font: fontBoundingBox*,
// emHeight* and the three baselines, relative to `baseline_y`; and the x and
// cap heights.
void FillFontMetrics(const PrimaryFontMetrics& metrics,
                     float baseline_y,
                     skiac_line_metrics* out);

// The px size of one `ex`, `ch`, `cap`, `ic` and `lh` of a font.
struct skiac_font_units {
  float ex;
  float ch;
  float cap;
  float ic;
  float lh;
};

extern "C" {
// The font-relative units of the font the canvas resolves `font` against,
// at `size` px; false when the collection has no such font.
bool skiac_font_collection_default_font_units(
    skiac_font_collection* c_collection,
    float size,
    skiac_font_units* units);
// GlobalFonts.loadSystemFonts / loadFontsFromDir: registers the font at
// `path` as a system font; 0 on failure.
uint32_t skiac_font_collection_register_system_font(
    skiac_font_collection* c_collection,
    const char* path);
}

#endif  // SKIA_C_TEXT_H
