// Shared by the canvas text files (text.cpp, font_families.cpp,
// text_metrics.cpp, text_words.cpp).

#ifndef SKIA_C_TEXT_H
#define SKIA_C_TEXT_H

#include <optional>
#include <string_view>
#include <utility>
#include <vector>

#include "hb_api.h"
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
};

// An installed font (loadSystemFonts, loadFontsFromDir, or one the
// collection scanned itself) rather than a web font (GlobalFonts.register /
// registerFromPath).
bool IsSystemTypeface(skiac_font_collection* c_collection,
                      SkTypeface* typeface);

// `typeface` at `size` px; `base_typeface` is the same face before font
// arguments, which tells a system font from a web font.
PrimaryFontMetrics MeasurePrimaryFont(skiac_font_collection* c_collection,
                                      SkTypeface* typeface,
                                      SkTypeface* base_typeface,
                                      float size);

// TextMetrics::GetFontBaseline for a CssBaseline.
float FontBaseline(int baseline, const PrimaryFontMetrics& metrics);

// The TextMetrics fields that come from the font: fontBoundingBox*,
// emHeight* and the three baselines, relative to `baseline_y`.
void FillFontMetrics(const PrimaryFontMetrics& metrics,
                     float baseline_y,
                     skiac_line_metrics* out);

// A HarfBuzz face reading `typeface`'s tables (it keeps a ref). The caller
// destroys it.
hb_face_t* CreateHbFace(SkTypeface* typeface);

// Blink's PlainTextNode::SegmentWord: the [start, end) byte ranges of the
// words HarfBuzz shapes one by one (text_words.cpp).
std::vector<std::pair<size_t, size_t>> SplitWords(std::string_view text);

// FontFallbackList::CanShapeWordByWord: false when the request turns on
// kerning or ligatures and the first family with a space glyph has the
// space in a GPOS (kerning) or GSUB (ligatures) lookup. `faces` are the
// request's families' faces, in order.
bool CanShapeWordByWord(skiac_font_collection* c_collection,
                        const std::vector<sk_sp<SkTypeface>>& faces,
                        const skiac_text_request& request);

// The variation coordinates for `request` when `faces` (the request's
// families' faces before font arguments) vary or the request has its own
// variations, else none: wght, wdth and slnt from the weight, stretch and
// slope, the request's variations, then opsz at the font size
// (text_styles.cpp).
std::vector<SkFontArguments::VariationPosition::Coordinate> FontVariations(
    const std::vector<sk_sp<SkTypeface>>& faces,
    const skiac_text_request& request);

// FontPlatformData's synthetic bold (SkFont embolden) and italic (skew).
struct SyntheticStyle {
  bool bold;
  bool italic;
};

// The synthetic styles of `face` drawing `request`: `base` is the family's
// face before font arguments, null for a fallback font.
SyntheticStyle SynthesizeStyle(skiac_font_collection* c_collection,
                               SkTypeface* face,
                               SkTypeface* base,
                               const skiac_text_request& request);

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
