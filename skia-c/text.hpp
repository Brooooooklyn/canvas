// Shared by the canvas text files (text.cpp, font_families.cpp).

#ifndef SKIA_C_TEXT_H
#define SKIA_C_TEXT_H

#include <vector>

#include "skia_c.hpp"

// The families skparagraph should use for `request`, like Blink's
// FontFallbackList: each family of the font resolved to the spelling the
// collection knows (case-insensitive, generic families through the platform
// defaults) and, last, the standard font. Families that resolve to nothing
// are left out.
std::vector<SkString> ResolveFontFamilies(skiac_font_collection* c_collection,
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
}

#endif  // SKIA_C_TEXT_H
