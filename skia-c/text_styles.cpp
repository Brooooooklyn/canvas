// Variable font axes and synthetic bold and italic, like Blink. A registered
// font is a web font with `auto` descriptors (FontCustomPlatformData::
// GetFontPlatformData), an installed font follows FontCache::
// CreateFontPlatformData and a fallback font PlatformFallbackFontForCharacter
// (Linux).

#include <math.h>
#include <algorithm>
#include <limits>
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

// font-optical-sizing none without an opsz of the request's own, with the
// system renderer on Apple: FontVariations sets the opsz axis default
// (DESIGN D8), and each face needs its own.
bool SetsOpszDefault(const skiac_text_request& request) {
#if defined(__APPLE__)
  if (request.optical_sizing == 0 || !SystemFontRenderer()) {
    return false;
  }
  for (int i = 0; request.variations && i < request.variations_count; ++i) {
    if (request.variations[i].tag == kOpsz) {
      return false;
    }
  }
  return true;
#else
  return false;
#endif
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
    // none: Blink sets the face's default, as CoreText otherwise sizes the
    // face for its own 12pt (DESIGN D8): the default of the first of `faces`
    // with the axis; a later face with another default gets its own
    // instance (UsedSizes::face_opsz). FreeType and Fontations take the
    // default without a coordinate, which keeps each face's own default.
    else if (SetsOpszDefault(request)) {
      coords.push_back({kOpsz, opsz_axis->def});
    }
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
// FontCacheKey::PrecisionMultiplier.
constexpr float kFontSizePrecision = 100;
// The largest adjusted size whose effective size (the 1/100 floor) is
// finite: the next float up times 100 is infinity (DESIGN D16). Blink caps
// only the computed size (kMaximumAllowedFontSize, as ctx.font here), not
// the adjusted one; past this size its effective size is infinity and
// measureText gives infinite metrics. A larger, infinite or NaN adjusted
// size gets this size instead. Skia takes any finite size: it draws and
// measures a font above 256 px as paths of the 64 px font scaled up
// (SkStrikeSpec::ShouldDrawAsPath), and its float to int conversions
// saturate.
constexpr float kMaxAdjustedSize = 0x1.47ae12p+121f;  // 3.40282328e36
static_assert(kMaxAdjustedSize * kFontSizePrecision <=
              std::numeric_limits<float>::max());
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

// FontDescription::EffectiveFontSize: the computed or adjusted size floored
// to 1/100 px (FontCacheKey::PrecisionMultiplier), the size every font of
// the request is made at, also without font-size-adjust.
float EffectiveSize(float size) {
  const float capped = size <= kMaxAdjustedSize ? size : kMaxAdjustedSize;
  return floorf(capped * kFontSizePrecision) / kFontSizePrecision;
}

}  // namespace

UsedSizes ComputeUsedSizes(skiac_font_collection* c_collection,
                           const std::vector<sk_sp<SkTypeface>>& base_faces,
                           const skiac_text_request& request) {
  const float computed = request.size;
  // opsz (font-optical-sizing: auto) follows the specified size, not floored
  // (FontPlatformData's opsz is the specified size).
  UsedSizes sizes{EffectiveSize(computed), computed, {}, {}, {}};
  // font-optical-sizing none (SetsOpszDefault): FontVariations sets the
  // default of the first face with the axis, and each face has its own.
  const bool opsz_default = SetsOpszDefault(request);
  std::optional<float> first_default;
  if (opsz_default) {
    for (const auto& face : base_faces) {
      if (const auto axis = FindAxis(Axes(face.get()), kOpsz)) {
        first_default = axis->def;
        break;
      }
    }
  }
  // A font made at size 0 has no aspect (AspectValue), so the adjusted size
  // stays the computed one (UpdateAdjustedSize).
  const float measured = EffectiveSize(computed);
  const bool adjust =
      request.size_adjust_metric >= 0 && measured > 0 && !base_faces.empty();
  if (!adjust && !first_default) {
    return sizes;
  }
  const int metric = request.size_adjust_metric;
  // The face Blink measures: the instance at the request's axes, opsz at the
  // computed size (UpdateAdjustedSize sets the adjusted size to it first),
  // made at its effective size (the computed size floored).
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
    return AspectValue(c_collection, face, base.get(), measured, metric,
                       request);
  };
  const float primary_aspect = adjust ? aspect_of(base_faces.front()) : 1;
  // from-font: the primary font's own aspect (UpdateAdjustedSize).
  const float value = request.size_adjust_from_font ? primary_aspect
                                                    : request.size_adjust_value;
  // MetricsMultiplierAdjustedFontSize, then EffectiveFontSize.
  auto adjusted_for = [&](float aspect) {
    const float adjusted = (value / aspect) * computed;
    return adjusted <= kMaxAdjustedSize ? adjusted : kMaxAdjustedSize;
  };
  if (adjust) {
    const float adjusted = adjusted_for(primary_aspect);
    sizes.opsz = adjusted;
    sizes.effective = EffectiveSize(adjusted);
  }
  if (first_default) {
    sizes.opsz = *first_default;
  }
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
    if (adjust && !sizes.faces.empty() &&
        (generic[i] || !IsSystemTypeface(c_collection, face.get()))) {
      const float face_adjusted = adjusted_for(aspect_of(face));
      size = EffectiveSize(face_adjusted);
      if (opsz_follows_size && FindAxis(Axes(face.get()), kOpsz)) {
        opsz = face_adjusted;
      }
    }
    if (opsz_default) {
      if (const auto axis = FindAxis(Axes(face.get()), kOpsz)) {
        opsz = axis->def;
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

// FontDescription::LigaturesState values (font_props.rs LigatureState).
constexpr uint8_t kLigaturesNormal = 0;
constexpr uint8_t kLigaturesEnabled = 1;
constexpr uint8_t kLigaturesDisabled = 2;

}  // namespace

std::vector<hb_feature_t> BlinkFeatures(const skiac_text_request& request,
                                        bool default_chws) {
  std::vector<hb_feature_t> features;
  auto add = [&features](hb_tag_t tag, uint32_t value) {
    features.push_back(
        {tag, value, HB_FEATURE_GLOBAL_START, HB_FEATURE_GLOBAL_END});
  };
  auto tag = [](const char* name) {
    return SKIAC_HB_TAG(name[0], name[1], name[2], name[3]);
  };
  // FontFeatureRange::FromFontDescription (font_features.cc). kerning: 0
  // auto, 1 none, 2 normal; HarfBuzz has kern on, so only none pushes.
  if (request.kerning == 1) {
    add(tag("kern"), 0);
  }
  // Ligatures. Any non-zero letter spacing turns the optional ones off;
  // optimizeSpeed (text_rendering 1) turns the default-on ones off unless
  // font-variant-ligatures enables them.
  const bool letter_spacing = request.letter_spacing != 0;
  const bool default_is_off = request.text_rendering == 1;
  const uint8_t common = request.lig_common;
  if (letter_spacing || common == kLigaturesDisabled ||
      (common == kLigaturesNormal && default_is_off)) {
    add(tag("liga"), 0);
    add(tag("clig"), 0);
  }
  if (!letter_spacing && request.lig_discretionary == kLigaturesEnabled) {
    add(tag("dlig"), 1);
  }
  if (!letter_spacing && request.lig_historical == kLigaturesEnabled) {
    add(tag("hlig"), 1);
  }
  const uint8_t contextual = request.lig_contextual;
  if (letter_spacing || contextual == kLigaturesDisabled ||
      (contextual == kLigaturesNormal && default_is_off)) {
    add(tag("calt"), 0);
  }
  // No canvas source for font-variant-east-asian or the width variants.
  // font-variant-numeric.
  const uint32_t numeric = request.variant_numeric;
  const uint32_t figure = numeric & 3;
  const uint32_t spacing = (numeric >> 2) & 3;
  const uint32_t fraction = (numeric >> 4) & 3;
  if (figure == 1) {
    add(tag("lnum"), 1);
  } else if (figure == 2) {
    add(tag("onum"), 1);
  }
  if (spacing == 1) {
    add(tag("pnum"), 1);
  } else if (spacing == 2) {
    add(tag("tnum"), 1);
  }
  if (fraction == 2) {
    add(tag("afrc"), 1);
  } else if (fraction == 1) {
    add(tag("frac"), 1);
  }
  if (numeric & (1 << 6)) {
    add(tag("ordn"), 1);
  }
  if (numeric & (1 << 7)) {
    add(tag("zero"), 1);
  }
  // font-feature-settings, in computed order. Blink's default chws 1
  // (text-spacing-trim normal: ShouldTrimAdjacent) follows them unless they
  // set chws (any value) or a glyph-width GPOS feature, halt or palt, to a
  // non-zero value. The old path never pushes it.
  for (int i = 0; request.features && i < request.features_count; ++i) {
    const hb_tag_t setting = request.features[i].tag;
    const uint32_t value = request.features[i].value;
    add(setting, value);
    if (setting == tag("chws") ||
        (value && (setting == tag("halt") || setting == tag("palt")))) {
      default_chws = false;
    }
  }
  if (default_chws) {
    add(tag("chws"), 1);
  }
  // font-variant-position, last: it wins over font-feature-settings.
  if (request.variant_position == 1) {
    add(tag("subs"), 1);
  } else if (request.variant_position == 2) {
    add(tag("sups"), 1);
  }
  return features;
}

void AddBlinkFeatures(TextStyle* style, const skiac_text_request& request) {
  for (const hb_feature_t& feature : BlinkFeatures(request)) {
    AddFeature(style, feature.tag, feature.value);
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
