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
