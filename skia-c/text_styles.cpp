// Variable font axes and synthetic bold and italic, like Blink. A registered
// font is a web font with `auto` descriptors (FontCustomPlatformData::
// GetFontPlatformData), an installed font follows FontCache::
// CreateFontPlatformData and a fallback font PlatformFallbackFontForCharacter
// (Linux).

#include <math.h>
#include <algorithm>
#include <optional>
#include <vector>

#include "text.hpp"
#include "text_raster.hpp"

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
    const skiac_text_request& request,
    float opsz_size) {
  bool variable = false;
  std::optional<SkFontParameters::Variation::Axis> opsz_axis;
  for (const auto& face : faces) {
    const auto axes = Axes(face.get());
    variable = variable || !axes.empty();
    if (!opsz_axis) {
      opsz_axis = FindAxis(axes, kOpsz);
    }
  }
  const bool has_opsz = opsz_axis.has_value();
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
  // font-optical-sizing: auto, at the adjusted size before the 1/100 floor
  // (FontCustomPlatformData::GetFontPlatformData's adjusted_specified_size).
  // Only for faces with the axis, so other faces are not cloned for every
  // size.
  if (has_opsz && !explicit_opsz) {
    if (request.optical_sizing == 0) {
      coords.push_back({kOpsz, opsz_size});
    }
#if defined(__APPLE__)
    // none: Blink sets the face's default, as CoreText otherwise sizes the
    // face for its own 12pt (DESIGN D8). FreeType and Fontations take the
    // default without a coordinate, which keeps each face's own default.
    else if (SystemFontRenderer()) {
      coords.push_back({kOpsz, opsz_axis->def});
    }
#endif
  }
  return coords;
}

namespace {

// font_size_adjust.h FontSizeAdjust::Metric (font_props.rs
// SizeAdjustMetric).
constexpr int kCapHeight = 1;
constexpr int kChWidth = 2;
constexpr int kIcWidth = 3;
constexpr int kIcHeight = 4;
// font.rs MAX_FONT_SIZE (DESIGN D16).
constexpr float kMaxFontSize = 10000;
// FontCacheKey::PrecisionMultiplier.
constexpr float kFontSizePrecision = 100;
constexpr SkUnichar kCjkWater = 0x6C34;

uint16_t ReadU16(const uint8_t* data) {
  return static_cast<uint16_t>((data[0] << 8) | data[1]);
}

// SimpleFontData::IdeographicAdvanceHeight: OpenTypeVerticalData::
// AdvanceHeight of `glyph`, the vmtx advance (the last long metric for a
// glyph past them), or without vhea / vmtx the font's rounded height
// (HarfBuzzFontData::UpdateFallbackMetricsAndScale).
float AdvanceHeight(skiac_font_collection* c_collection,
                    const SkFont& font,
                    SkTypeface* base,
                    SkGlyphID glyph) {
  SkTypeface* typeface = font.getTypeface();
  uint8_t vhea[36];
  const int upem = typeface->getUnitsPerEm();
  if (upem > 0 &&
      typeface->getTableData(SkSetFourByteTag('v', 'h', 'e', 'a'), 0,
                             sizeof(vhea), vhea) == sizeof(vhea)) {
    const uint16_t count = ReadU16(vhea + 34);
    const size_t vmtx_size =
        typeface->getTableSize(SkSetFourByteTag('v', 'm', 't', 'x'));
    if (count && vmtx_size >= static_cast<size_t>(count) * 4) {
      const uint16_t index = glyph < count ? glyph : count - 1;
      uint8_t advance[2];
      if (typeface->getTableData(SkSetFourByteTag('v', 'm', 't', 'x'),
                                 static_cast<size_t>(index) * 4,
                                 sizeof(advance), advance) == sizeof(advance)) {
        return ReadU16(advance) * (font.getSize() / upem);
      }
    }
  }
  float ascent;
  float descent;
  AscentDescentWithHacks(c_collection, font, base, &ascent, &descent);
  return static_cast<float>(lroundf(ascent) + lroundf(descent));
}

// FontSizeFunctions AspectValue: the metric of `face` (an instance of
// `base` at the request's axes) at `size` px over the size, 1 when the face
// has no such metric.
float AspectValue(skiac_font_collection* c_collection,
                  const sk_sp<SkTypeface>& face,
                  SkTypeface* base,
                  float size,
                  int metric,
                  const skiac_text_request& request) {
  SkFont font = MetricsFont(face, size);
  // FontPlatformData::SetupSkFont: the font Blink measures has the face's
  // synthetic bold and italic, which move the top of the 'x' outline.
  const SyntheticStyle synthetic =
      SynthesizeStyle(c_collection, face.get(), base, request);
  font.setEmbolden(synthetic.bold);
  font.setSkewX(synthetic.italic ? -SK_Scalar1 / 4 : 0);
  SkFontMetrics metrics;
  font.getMetrics(&metrics);
  float value = 0;
  switch (metric) {
    case kCapHeight:
      value = metrics.fCapHeight;
      break;
    case kChWidth:
      if (const SkGlyphID zero = font.unicharToGlyph('0')) {
        value = font.getWidth(zero);
      }
      break;
    case kIcWidth:
      if (const SkGlyphID water = font.unicharToGlyph(kCjkWater)) {
        value = font.getWidth(water);
      }
      break;
    case kIcHeight:
      if (const SkGlyphID water = font.unicharToGlyph(kCjkWater)) {
        value = AdvanceHeight(c_collection, font, base, water);
      }
      break;
    default:
      value = metrics.fXHeight;
#if defined(__APPLE__)
      // SimpleFontData::PlatformInit: CTFontGetXHeight counts the part of
      // 'x' below the baseline, so Blink measures the glyph's outline
      // (as skiac_font_collection_default_font_units, DESIGN D22).
      if (SystemFontRenderer() && value) {
        if (const SkGlyphID x_glyph = font.unicharToGlyph('x')) {
          const std::optional<SkPath> path = font.getPath(x_glyph);
          value = -(path ? path->getBounds() : font.getBounds(x_glyph, nullptr))
                       .fTop;
        }
      }
#endif
      break;
  }
  return value > 0 ? value / size : 1.0f;
}

}  // namespace

UsedSizes ComputeUsedSizes(skiac_font_collection* c_collection,
                           const std::vector<sk_sp<SkTypeface>>& base_faces,
                           const skiac_text_request& request) {
  UsedSizes sizes{request.size, request.size, {}, {}, {}};
  const float computed = request.size;
  if (request.size_adjust_metric < 0 || !(computed > 0) || base_faces.empty()) {
    return sizes;
  }
  const int metric = request.size_adjust_metric;
  // The face Blink measures: the instance at the request's axes, opsz at the
  // computed size (UpdateAdjustedSize sets the adjusted size to it first).
  auto aspect_of = [&](const sk_sp<SkTypeface>& base) {
    sk_sp<SkTypeface> face = base;
    const auto coords = FontVariations({base}, request, computed);
    if (!coords.empty()) {
      SkFontArguments args;
      args.setVariationDesignPosition(
          {coords.data(), static_cast<int>(coords.size())});
      if (sk_sp<SkTypeface> clone = base->makeClone(args)) {
        face = std::move(clone);
      }
    }
    return AspectValue(c_collection, face, base.get(), computed, metric,
                       request);
  };
  const float primary_aspect = aspect_of(base_faces.front());
  // from-font: the primary font's own aspect (UpdateAdjustedSize).
  const float value = request.size_adjust_from_font ? primary_aspect
                                                    : request.size_adjust_value;
  // MetricsMultiplierAdjustedFontSize, then EffectiveFontSize.
  auto adjusted_for = [&](float aspect) {
    return std::min((value / aspect) * computed, kMaxFontSize);
  };
  auto effective_for = [](float adjusted) {
    return floorf(adjusted * kFontSizePrecision) / kFontSizePrecision;
  };
  const float adjusted = adjusted_for(primary_aspect);
  sizes.opsz = adjusted;
  sizes.effective = effective_for(adjusted);
  // CSSFontFace::GetFontData (a registered face) and CSSFontSelector::
  // GetFontData (a generic family) size each face from its own aspect; a
  // named installed family (FontCache::GetFontData) and the system fallback
  // take the primary's size.
  std::vector<bool> generic;
  const std::vector<SkString> families =
      ResolveFontFamilies(c_collection, request, &generic);
  const SkFontStyle style(static_cast<int>(roundf(request.weight)),
                          request.stretch,
                          static_cast<SkFontStyle::Slant>(request.style));
  // font-optical-sizing auto without an opsz of the request's own: a face
  // made at its own adjusted size has its opsz at that size too
  // (FontCustomPlatformData::GetFontPlatformData), when it has the axis.
  bool opsz_follows_size = request.optical_sizing == 0;
  for (int i = 0; request.variations && i < request.variations_count; ++i) {
    opsz_follows_size = opsz_follows_size && request.variations[i].tag != kOpsz;
  }
  bool differs = false;
  for (size_t i = 0; i < families.size(); ++i) {
    const std::vector<sk_sp<SkTypeface>> found =
        c_collection->collection->findTypefaces({families[i]}, style);
    if (found.empty() || !found.front()) {
      continue;
    }
    const sk_sp<SkTypeface>& face = found.front();
    float size = sizes.effective;
    float opsz = sizes.opsz;
    if (!sizes.faces.empty() &&
        (generic[i] || !IsSystemTypeface(c_collection, face.get()))) {
      const float face_adjusted = adjusted_for(aspect_of(face));
      size = effective_for(face_adjusted);
      if (opsz_follows_size && FindAxis(Axes(face.get()), kOpsz)) {
        opsz = face_adjusted;
      }
    }
    differs = differs || size != sizes.effective || opsz != sizes.opsz;
    sizes.faces.push_back(face);
    sizes.face_sizes.push_back(size);
    sizes.face_opsz.push_back(opsz);
  }
  if (!differs) {
    sizes.faces.clear();
    sizes.face_sizes.clear();
    sizes.face_opsz.clear();
  }
  return sizes;
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
