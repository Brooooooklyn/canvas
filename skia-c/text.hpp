// Shared by the canvas text files (text.cpp, font_families.cpp,
// text_metrics.cpp, text_words.cpp).

#ifndef SKIA_C_TEXT_H
#define SKIA_C_TEXT_H

#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "hb_api.h"
#include "skia_c.hpp"

// The families skparagraph should use for `request`, like Blink's
// FontFallbackList: each family of the font resolved to the spelling the
// collection knows (case-insensitive, generic families through the platform
// defaults) and, last, the standard font. Families that resolve to nothing
// are left out. `generic`, when given, gets for each resolved family whether
// it came through the font selector as a generic family (the standard font
// too) rather than by name.
std::vector<SkString> ResolveFontFamilies(skiac_font_collection* c_collection,
                                          const skiac_text_request& request,
                                          std::vector<bool>* generic = nullptr);

// FontCache::GetLastResortFallbackFont's family for `request`: on macOS with
// the system renderer Times (else Lucida Grande); empty when none resolves
// (font_families.cpp).
std::string LastResortFamily(skiac_font_collection* c_collection,
                             const skiac_text_request& request);

// The standard font of the request's language, where it is not the common
// one: FontFallbackList::GetFontData's -webkit-standard, which
// FontSelector::FamilyNameFromSettings takes from the settings for
// LocaleOrDefault's script (GenericFontFamilySettings::Standard). On macOS
// with the system renderer, for a lang whose script is Japanese, Korean,
// Simplified or Traditional Han, or Devanagari; else empty, also for none or
// "inherit" (font_families.cpp). ResolveFontFamilies does not use it yet: its
// standard font is the common one (stage S8).
std::string LocaleStandardFamily(skiac_font_collection* c_collection,
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

// An installed font (loadSystemFonts, loadFontsFromDir, or one the
// collection scanned itself) rather than a web font (GlobalFonts.register /
// registerFromPath).
bool IsSystemTypeface(skiac_font_collection* c_collection,
                      SkTypeface* typeface);

// FontMetrics::AscentDescentWithHacks for `font` (MetricsFont); `typeface`
// is the face before font arguments, which tells a system font from a web
// font.
void AscentDescentWithHacks(skiac_font_collection* c_collection,
                            const SkFont& font,
                            SkTypeface* typeface,
                            float* ascent,
                            float* descent);

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

// A HarfBuzz face reading `typeface`'s tables (it keeps a ref). The caller
// destroys it.
hb_face_t* CreateHbFace(SkTypeface* typeface);

// The canvas text preparation (PlainTextNode::NormalizeSpacesAndMaybeBidi
// for a canvas): U+0009 to U+000D are spaces, U+2028 and U+2029 draw as
// spaces and U+FFFC as a zero width space. Returns `text` itself, or the
// prepared copy in `storage`.
std::string_view PrepareCanvasText(std::string_view text, std::string* storage);

// Blink's PlainTextNode::SegmentWord: the [start, end) byte ranges of the
// words HarfBuzz shapes one by one (text_words.cpp).
std::vector<std::pair<size_t, size_t>> SplitWords(std::string_view text);

// The [start, end) byte ranges of `text` (UTF-8) whose characters Blink
// gives no letter spacing (ShapeResultSpacing skips
// Character::TreatAsZeroWidthSpace: the default ignorable code points, form
// feed, carriage return and U+FFFC), in order, adjacent ones merged.
// `piece_starts` are the byte starts of the pieces shaped on their own, in
// order: a tag or variation selector above U+FFFF that starts one is spaced.
std::vector<std::pair<size_t, size_t>> NoLetterSpacingRanges(
    std::string_view text,
    const std::vector<size_t>& piece_starts);

// FontFallbackList::CanShapeWordByWord: false when the request turns on
// kerning or ligatures and the first family with a space glyph has the
// space in a GPOS (kerning) or GSUB (ligatures) lookup. `faces` are the
// request's families' faces, in order. `space_glyph` looks the space up
// (the Blink shaper: HarfBuzz's cmap); null for SkTypeface::unicharToGlyph.
bool CanShapeWordByWord(skiac_font_collection* c_collection,
                        const std::vector<sk_sp<SkTypeface>>& faces,
                        const skiac_text_request& request,
                        SkGlyphID (*space_glyph)(skiac_font_collection*,
                                                 SkTypeface*) = nullptr);

// plain_text_node.cc NextWordEndIndex on the normalized UTF-16 text: the end
// of the word that starts at `start`. `is_8bit`: the text is Blink's 8-bit
// string (PreparedText::is_8bit).
size_t NextWordEndIndex(const char16_t* text,
                        size_t length,
                        size_t start,
                        bool is_8bit);

// The variation coordinates for `request` when `faces` (the request's
// families' faces before font arguments) vary or the request has its own
// variations, else none: wght, wdth and slnt from the weight, stretch and
// slope, the request's variations, then, for font-optical-sizing: auto and
// no opsz of the request's own, opsz at `opsz_size` (UsedSizes::opsz), and
// for none with the system renderer on Apple the axis default of the first
// of `faces` with the axis (text_styles.cpp).
std::vector<SkFontArguments::VariationPosition::Coordinate> FontVariations(
    const std::vector<sk_sp<SkTypeface>>& faces,
    const skiac_text_request& request,
    float opsz_size);

// The font sizes font-size-adjust gives (FontBuilder::UpdateAdjustedSize,
// FontDescription::EffectiveFontSize, CSSFontFace::GetFontData and
// CSSFontSelector::GetFontData; text_styles.cpp).
struct UsedSizes {
  // The primary font's size: the adjusted size (the request's size without
  // font-size-adjust) floored to 1/100 px (EffectiveFontSize).
  float effective;
  // The adjusted size (the request's size without font-size-adjust) before
  // the floor, for opsz (font-optical-sizing: auto); for none with the
  // system renderer on Apple, the opsz default of the first face with the
  // axis, which FontVariations sets.
  float opsz;
  // Only when a family's own aspect gives it another size or opsz than the
  // primary, or (font-optical-sizing none with the system renderer on
  // Apple) its own opsz default differs from `opsz`: the resolved families'
  // faces (before font arguments), in order, with their effective sizes and
  // opsz. A character no face has (system fallback) gets `effective` and
  // `opsz`.
  std::vector<sk_sp<SkTypeface>> faces;
  std::vector<float> face_sizes;
  std::vector<float> face_opsz;
};

// `base_faces` are the request's families' faces before font arguments
// (FontCollection::findTypefaces of `families`).
UsedSizes ComputeUsedSizes(skiac_font_collection* c_collection,
                           const std::vector<sk_sp<SkTypeface>>& base_faces,
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

// A piece of a word skparagraph shapes on its own for font-variant-caps:
// its text (case mapped for synthesized small caps), the variant caps whose
// OpenType features it turns on, and whether it is drawn at the small caps
// size (text_caps.cpp).
struct CapsPiece {
  std::string text;
  int caps;
  bool small;
};

// The pieces of `word` (UTF-8) for request.variant_caps, with `face` the
// primary font: the word itself with the requested features when the face
// has them, else its case runs.
std::vector<CapsPiece> SplitCaps(skiac_font_collection* c_collection,
                                 SkTypeface* face,
                                 std::string_view word,
                                 const skiac_text_request& request);

// How far each text blob of `paragraph`'s first line moves right to sit
// where Blink draws it, in the order visit() and paint() give the blobs;
// empty when none moves (text.cpp). TextLine puts each run after the runs
// before it, counting a run whose clusters advance less than nothing
// (negative letter or word spacing past their advances) as 0 wide; Blink
// adds the advances as they are.
std::vector<float> LineRunShifts(ParagraphImpl* paragraph);

// Turns on the OpenType features of a variant caps value.
void AddCapsFeatures(TextStyle* style, int caps);

// Adds the OpenType features of `request` after the caps ones, in Blink's
// order (FontFeatureRange::FromFontDescription): kern 0 for fontKerning
// none, the font-variant-ligatures / textRendering / letterSpacing ligature
// rules, font-variant-numeric, font-feature-settings, then
// font-variant-position (text_styles.cpp).
void AddBlinkFeatures(TextStyle* style, const skiac_text_request& request);

// The same features as HarfBuzz features over the whole buffer, in the same
// order (the Blink shaper's).
std::vector<hb_feature_t> BlinkFeatures(const skiac_text_request& request);

// The synthesized small caps font size for a font of `size` px.
float SmallCapsSize(float size);

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
