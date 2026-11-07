// Variable font axes and synthetic bold and italic, like Blink. A registered
// font is a web font with `auto` descriptors (FontCustomPlatformData::
// GetFontPlatformData), an installed font follows FontCache::
// CreateFontPlatformData and a fallback font PlatformFallbackFontForCharacter
// (Linux).

#include <optional>
#include <vector>

#include "text.hpp"

#if defined(SK_DEBUG) || !defined(SK_RELEASE)
#error "skia-c must be built with SK_RELEASE like libskia (see build.rs)"
#endif

namespace {

constexpr SkFourByteTag kWght = SkSetFourByteTag('w', 'g', 'h', 't');
constexpr SkFourByteTag kWdth = SkSetFourByteTag('w', 'd', 't', 'h');
constexpr SkFourByteTag kSlnt = SkSetFourByteTag('s', 'l', 'n', 't');
constexpr SkFourByteTag kOpsz = SkSetFourByteTag('o', 'p', 's', 'z');

// font_selection_types.h.
constexpr float kBoldThreshold = 600;
constexpr float kNormalWeight = 400;
constexpr float kItalicSlope = 14;

std::vector<SkFontParameters::Variation::Axis> Axes(SkTypeface* typeface) {
  const int count = typeface->getVariationDesignParameters({});
  if (count <= 0) {
    return {};
  }
  std::vector<SkFontParameters::Variation::Axis> axes(count);
  if (typeface->getVariationDesignParameters(axes) != count) {
    return {};
  }
  return axes;
}

std::optional<SkFontParameters::Variation::Axis> FindAxis(
    const std::vector<SkFontParameters::Variation::Axis>& axes,
    SkFourByteTag tag) {
  for (const auto& axis : axes) {
    if (axis.tag == tag) {
      return axis;
    }
  }
  return std::nullopt;
}

}  // namespace

std::vector<SkFontArguments::VariationPosition::Coordinate> FontVariations(
    const std::vector<sk_sp<SkTypeface>>& faces,
    const skiac_text_request& request) {
  bool variable = false;
  bool has_opsz = false;
  for (const auto& face : faces) {
    const auto axes = Axes(face.get());
    variable = variable || !axes.empty();
    has_opsz = has_opsz || FindAxis(axes, kOpsz).has_value();
  }
  std::vector<SkFontArguments::VariationPosition::Coordinate> coords;
  if (!variable && request.variations_count <= 0) {
    return coords;
  }
  // Skia clamps each coordinate to the face's axis, as Blink does for a
  // range set from `auto`. CSS slants clockwise, OpenType counter-clockwise.
  if (variable) {
    coords.push_back({kWght, request.weight});
    coords.push_back({kWdth, request.stretch_pct});
    coords.push_back({kSlnt, -request.slope});
  }
  bool explicit_opsz = false;
  for (int i = 0; request.variations && i < request.variations_count; ++i) {
    explicit_opsz = explicit_opsz || request.variations[i].tag == kOpsz;
    coords.push_back({request.variations[i].tag, request.variations[i].value});
  }
  // font-optical-sizing: auto. Only for faces with the axis, so other faces
  // are not cloned for every size.
  if (has_opsz && !explicit_opsz) {
    coords.push_back({kOpsz, request.size});
  }
  return coords;
}

namespace {

void AddFeature(TextStyle* style, SkFourByteTag tag, uint32_t value) {
  const char name[4] = {
      static_cast<char>(tag >> 24), static_cast<char>((tag >> 16) & 0xFF),
      static_cast<char>((tag >> 8) & 0xFF), static_cast<char>(tag & 0xFF)};
  // skparagraph turns the value back into a uint32_t (SkToU32).
  style->addFontFeature(SkString(name, 4), static_cast<int>(value));
}

void AddFeature(TextStyle* style, const char* tag, uint32_t value) {
  style->addFontFeature(SkString(tag), static_cast<int>(value));
}

// FontDescription::LigaturesState values (font_props.rs LigatureState).
constexpr uint8_t kLigaturesNormal = 0;
constexpr uint8_t kLigaturesEnabled = 1;
constexpr uint8_t kLigaturesDisabled = 2;

}  // namespace

void AddBlinkFeatures(TextStyle* style, const skiac_text_request& request) {
  // FontFeatureRange::FromFontDescription (font_features.cc). kerning: 0
  // auto, 1 none, 2 normal; HarfBuzz has kern on, so only none pushes.
  if (request.kerning == 1) {
    AddFeature(style, "kern", 0);
  }
  // Ligatures. Any non-zero letter spacing turns the optional ones off;
  // optimizeSpeed (text_rendering 1) turns the default-on ones off unless
  // font-variant-ligatures enables them.
  const bool letter_spacing = request.letter_spacing != 0;
  const bool default_is_off = request.text_rendering == 1;
  const uint8_t common = request.lig_common;
  if (letter_spacing || common == kLigaturesDisabled ||
      (common == kLigaturesNormal && default_is_off)) {
    AddFeature(style, "liga", 0);
    AddFeature(style, "clig", 0);
  }
  if (!letter_spacing && request.lig_discretionary == kLigaturesEnabled) {
    AddFeature(style, "dlig", 1);
  }
  if (!letter_spacing && request.lig_historical == kLigaturesEnabled) {
    AddFeature(style, "hlig", 1);
  }
  const uint8_t contextual = request.lig_contextual;
  if (letter_spacing || contextual == kLigaturesDisabled ||
      (contextual == kLigaturesNormal && default_is_off)) {
    AddFeature(style, "calt", 0);
  }
  // No canvas source for font-variant-east-asian or the width variants.
  // font-variant-numeric.
  const uint32_t numeric = request.variant_numeric;
  const uint32_t figure = numeric & 3;
  const uint32_t spacing = (numeric >> 2) & 3;
  const uint32_t fraction = (numeric >> 4) & 3;
  if (figure == 1) {
    AddFeature(style, "lnum", 1);
  } else if (figure == 2) {
    AddFeature(style, "onum", 1);
  }
  if (spacing == 1) {
    AddFeature(style, "pnum", 1);
  } else if (spacing == 2) {
    AddFeature(style, "tnum", 1);
  }
  if (fraction == 2) {
    AddFeature(style, "afrc", 1);
  } else if (fraction == 1) {
    AddFeature(style, "frac", 1);
  }
  if (numeric & (1 << 6)) {
    AddFeature(style, "ordn", 1);
  }
  if (numeric & (1 << 7)) {
    AddFeature(style, "zero", 1);
  }
  // font-feature-settings, in computed order. Blink's default chws 1 is not
  // pushed (no text-spacing-trim source here).
  for (int i = 0; request.features && i < request.features_count; ++i) {
    AddFeature(style, request.features[i].tag, request.features[i].value);
  }
  // font-variant-position, last: it wins over font-feature-settings.
  if (request.variant_position == 1) {
    AddFeature(style, "subs", 1);
  } else if (request.variant_position == 2) {
    AddFeature(style, "sups", 1);
  }
}

SyntheticStyle SynthesizeStyle(skiac_font_collection* c_collection,
                               SkTypeface* face,
                               SkTypeface* base,
                               const skiac_text_request& request) {
  const float weight = request.weight;
  const float slope = request.slope;
  if (!base) {
    // A fallback font for a character no family has.
    return {weight >= kBoldThreshold && !face->isBold(),
            slope == kItalicSlope && !face->isItalic()};
  }
  if (IsSystemTypeface(c_collection, base)) {
    // `face` is the instance at the request's axes, its style from them.
    SkFontStyle style = face->fontStyle();
#if defined(__APPLE__)
    // The UI font's faces: Skia's style for the italic ones is upright 400;
    // their traits have the slant and the weight (CoreTextFontStyle).
    if (c_collection->system_ui_ids.count(base->uniqueID())) {
      style = CoreTextFontStyle(face);
    }
#endif
    return {
        weight > 200 + style.weight(),
        slope == kItalicSlope && style.slant() == SkFontStyle::kUpright_Slant};
  }
  // CSSSegmentedFontFace: `auto` descriptors are weight 400 and slope 0.
  bool bold = weight >= kBoldThreshold;
  bool italic = slope >= kItalicSlope;
  const auto axes = Axes(base);
  if (const auto wght = FindAxis(axes, kWght); wght && wght->min <= wght->max) {
    bold = bold && !(wght->max > kNormalWeight);
  }
  if (const auto slnt = FindAxis(axes, kSlnt); slnt && slnt->min <= slnt->max) {
    italic = italic && !(slnt->min < 0);
  }
  return {bold && !base->isBold(), italic && !base->isItalic()};
}
