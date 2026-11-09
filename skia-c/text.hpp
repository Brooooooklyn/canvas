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

// The families the shaper uses for `request`, like Blink's
// FontFallbackList: each family of the font resolved to the spelling the
// collection knows (case-insensitive, generic families through the platform
// defaults) and, last, the standard font. Families that resolve to nothing
// are left out. `generic`, when given, gets for each resolved family whether
// it came through the font selector as a generic family (the standard font
// too) rather than by name. `locale`, when given, holds the font settings
// of the locale's script to use in place of the common ones
// (LocaleFontFamilies).
struct LocaleFamilies;
std::vector<SkString> ResolveFontFamilies(
    skiac_font_collection* c_collection,
    const skiac_text_request& request,
    std::vector<bool>* generic = nullptr,
    const LocaleFamilies* locale = nullptr);

// FontCache::GetLastResortFallbackFont's family for `request`: on macOS with
// the system renderer Times (else Lucida Grande); empty when none resolves
// (font_families.cpp).
std::string LastResortFamily(skiac_font_collection* c_collection,
                             const skiac_text_request& request);

// The standard font of a locale (`lang`, a language tag; the shaper passes
// LocaleOrDefault's), where it is not the common one:
// FontFallbackList::GetFontData's -webkit-standard, which
// FontSelector::FamilyNameFromSettings takes from the settings for the
// locale's script (GenericFontFamilySettings::Standard). On macOS with the
// system renderer, for a locale whose script is Japanese, Korean, Simplified
// or Traditional Han, or Devanagari, and is not the script of the host's UI
// language `host_language` (Chrome has no per-script default for that one);
// else empty (font_families.cpp).
std::string LocaleStandardFamily(skiac_font_collection* c_collection,
                                 std::string_view lang,
                                 std::string_view host_language);

// The generic font family settings of a locale's script
// (GenericFontFamilySettings: FontSelector::FamilyNameFromSettings takes
// Serif(script), SansSerif(script), ... for a generic family, and
// Standard(script) for the description's -webkit-body): the script's own
// default where Chrome has one, else the common entry of the host's UI
// language `host_language` (its locale_settings_mac_<ui>.xtb, macOS); an
// empty entry is the en common setting. The same scripts and host rule as
// LocaleStandardFamily (font_families.cpp).
struct LocaleFamilies {
  // Standard(script), already resolved: LocaleStandardFamily, else the
  // host's common standard font; empty for the en one.
  std::string standard;
  // By skiac_font_family::generic (1 serif ... 8 math): the settings family
  // name, looked up like the common one (SettingsFamily). For -webkit-body
  // (as a family that is not the description's generic family) the common
  // standard font of the host.
  std::string generic[9];
};
LocaleFamilies LocaleFontFamilies(skiac_font_collection* c_collection,
                                  std::string_view lang,
                                  std::string_view host_language);

// LayoutLocale::GetScriptForHan of `lang` (a UScriptCode: Katakana or
// Hiragana, Hangul, Simplified or Traditional Han), on every OS.
int HanScriptForLocale(std::string_view lang);

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

// FontFallbackList::CanShapeWordByWord: false when the request turns on
// kerning or ligatures and the first family with a space glyph has the
// space in a GPOS (kerning) or GSUB (ligatures) lookup. `faces` are the
// request's families' faces, in order. `space_glyph` looks the space up
// (HarfBuzz's cmap).
bool CanShapeWordByWord(skiac_font_collection* c_collection,
                        const std::vector<sk_sp<SkTypeface>>& faces,
                        const skiac_text_request& request,
                        SkGlyphID (*space_glyph)(skiac_font_collection*,
                                                 SkTypeface*));

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
// (FontCollection::findTypefaces of `families`); `locale`, when given, is the
// locale's font settings those families were resolved with
// (ResolveFontFamilies).
UsedSizes ComputeUsedSizes(skiac_font_collection* c_collection,
                           const std::vector<sk_sp<SkTypeface>>& base_faces,
                           const skiac_text_request& request,
                           const LocaleFamilies* locale = nullptr);

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

// font-variant-caps per font, for the Blink shaper (text_caps.cpp): Blink's
// OpenTypeCapsSupport of one font for request.variant_caps and a script.
struct CapsSupport {
  enum class Font : uint8_t { kFull, kFallback, kNone };
  enum class Synthesis : uint8_t {
    kNone,
    kLowerToSmallCaps,
    kUpperToSmallCaps,
    kBoth,
  };
  Font font = Font::kFull;
  Synthesis synthesis = Synthesis::kNone;
};

// SmallCapsIterator::SmallCapsBehavior: kInvalid for a run of combining
// marks only.
enum class CaseRun { kInvalid, kUppercaseNeeded, kSameCase };

// CaseMapIntend.
enum class CaseMapIntend { kKeepSameCase, kUpperCase, kLowerCase };

// OpenTypeCapsSupport(face, caps, auto synthesis, script): the caps
// features `face` has for `script` (cached in caps_features).
CapsSupport FontCapsSupport(skiac_font_collection* c_collection,
                            SkTypeface* face,
                            int caps,
                            hb_script_t script);
// OpenTypeCapsSupport::NeedsRunCaseSplitting.
bool NeedsRunCaseSplitting(const CapsSupport& support, int caps);
// OpenTypeCapsSupport::FontFeatureToUse.
int CapsFeatureToUse(const CapsSupport& support, int caps, CaseRun run);
// OpenTypeCapsSupport::NeedsCaseChange.
CaseMapIntend NeedsCaseChange(const CapsSupport& support, CaseRun run);
// OpenTypeCapsSupport::NeedsSyntheticFont.
bool NeedsSyntheticFont(const CapsSupport& support, int caps, CaseRun run);
// SmallCapsIterator::Consume once over text[0, length): the end of the
// first run of characters that change when uppercased, or do not (combining
// marks go with the run they are in), and that run's behavior.
uint32_t NextCaseRun(const char16_t* text, uint32_t length, CaseRun* run);
// CapsFeatureSettingsScopedOverlay: the OpenType features of a variant caps
// value, put before `features` in Blink's order.
void PrependCapsFeatures(std::vector<hb_feature_t>* features, int caps);
// CaseMap::Locale of a language tag (the shaper's LocaleOrDefault): "tr",
// "el", "lt", "nl", or root ("").
const char* CaseMapLocale(std::string_view lang);
// `text` upper or lower cased with ICU for `locale`.
std::u16string MapCase(CaseMapIntend intend,
                       const char* locale,
                       const std::u16string& text);

// The OpenType features of `request` as HarfBuzz features over the whole
// buffer, after the caps ones, in Blink's order
// (FontFeatureRange::FromFontDescription): kern 0 for fontKerning none, the
// font-variant-ligatures / textRendering / letterSpacing ligature rules,
// font-variant-numeric, font-feature-settings, Blink's default `chws 1`
// unless they set `chws` or a non-zero `halt` / `palt` (text-spacing-trim
// normal, font_features.cc), then font-variant-position (text_styles.cpp).
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

// The primary font's x-height (0 when the font has none), "0" advance and
// cap height, in px (skiac_font_collection_primary_font_units).
struct skiac_primary_font_units {
  float x_height;
  float zero_width;
  float cap_height;
};

extern "C" {
// The ex, ch and cap metrics of the primary font of `request`, read off the
// font without shaping; false when it has no family font (shaper.cpp).
bool skiac_font_collection_primary_font_units(
    skiac_font_collection* c_collection,
    const skiac_text_request* request,
    skiac_primary_font_units* units);
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
