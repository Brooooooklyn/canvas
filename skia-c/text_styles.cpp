// Variable font axes and synthetic bold and italic, like Blink. A registered
// font is a web font with the descriptors it was registered with under the
// family that matched it, else `auto` ones (FontCustomPlatformData::
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
constexpr SkFourByteTag kItal = SkSetFourByteTag('i', 't', 'a', 'l');

// font_selection_types.h.
constexpr float kBoldThreshold = 600;
constexpr float kNormalWeight = 400;
constexpr float kItalicSlope = 14;

// ClampAxisValue (font_custom_platform_data.cc): an explicit descriptor
// range clamps the request; one from `auto` leaves it to the face's axis.
float ClampAxisValue(float requested, const skiac_face_range& range) {
  if (range.from_auto) {
    return requested;
  }
  return range.min <= range.max ? std::clamp(requested, range.min, range.max)
                                : requested;
}

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

// ResolveVariations' use_ital_axis: the `italic` keyword (StyleSyntax::
// kItalicKeyword) on a web face whose ital axis covers 1.
bool UsesItalAxis(const std::optional<SkFontParameters::Variation::Axis>& ital,
                  const skiac_text_request& request) {
  return request.style == SkFontStyle::kItalic_Slant && ital &&
         ital->min <= 1 && ital->max >= 1;
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

// `family` case-folded, without ResolveFontFamilies' tags: "\x01o\x01" slope
// "\x01" and "\x01q\x01" quarters "\x01" (AtRequest) and "\x01s\x01" k
// "\x01" before a tagged name, "\x01" kind "\x01" before a family.
std::string FoldedUntaggedFamily(std::string_view family) {
  if (family.substr(0, 3) == "\x01o\x01") {
    const size_t end = family.find('\x01', 3);
    family = end == std::string_view::npos ? std::string_view()
                                           : family.substr(end + 1);
  }
  if (family.substr(0, 3) == "\x01q\x01") {
    const size_t end = family.find('\x01', 3);
    family = end == std::string_view::npos ? std::string_view()
                                           : family.substr(end + 1);
  }
  if (family.substr(0, 3) == "\x01s\x01") {
    const size_t end = family.find('\x01', 3);
    family = end == std::string_view::npos ? std::string_view()
                                           : family.substr(end + 1);
  }
  if (family.size() >= 3 && family[0] == '\x01' && family[2] == '\x01') {
    family = family.substr(3);
  }
  return FoldFamilyName(family);
}

// Whether `folded` is one of `seen`.
bool Seen(const std::vector<const std::string*>& seen,
          const std::string& folded) {
  return std::any_of(seen.begin(), seen.end(),
                     [&](const std::string* name) { return *name == folded; });
}

}  // namespace

namespace {

// DescriptorsUnder, telling apart a name that lists the face with no
// descriptors (auto: an empty FaceDescriptors) from one that does not
// resolve (nullopt: each alias it has goes round a loop of aliases back to
// a name looked up already, and it lists the face itself under no call).
// Direct declarations (explicit or auto) and aliases compare by
// registration order: the newest alias whose target resolves gives that
// target's, auto too, unless a direct declaration is newer.
std::optional<FaceDescriptors> ResolveDescriptors(
    skiac_font_collection* c_collection,
    SkTypefaceID id,
    const std::string& folded,
    std::vector<const std::string*>& seen) {
  const auto& assets = c_collection->assets;
  // The direct declaration's descriptors (setDescriptors erases them when
  // the name is declared again with none, so they are its latest call's).
  std::optional<FaceDescriptors> direct;
  std::optional<uint64_t> declared;
  if (assets->describes(folded)) {
    ++c_collection->descriptor_lookups;
    if (const uint32_t key = assets->registrationOf(id)) {
      const auto& descriptors =
          assets->getRegisteredFonts().at(key).descriptors;
      if (const auto found = descriptors.find(folded);
          found != descriptors.end()) {
        direct = FaceDescriptors(found->second);
        declared = assets->latestDeclarationOrder(id, folded);
      }
    }
  }
  const auto& aliases = c_collection->set_aliases;
  bool looped = false;
  for (auto it = aliases.rbegin(); it != aliases.rend(); ++it) {
    if (!it->active || it->face_id != id || it->folded_alias != folded ||
        it->folded_family == folded) {
      continue;
    }
    if (Seen(seen, it->folded_family)) {
      looped = true;
      continue;
    }
    if (!declared) {
      declared = assets->latestDeclarationOrder(id, folded);
    }
    if (*declared > it->order) {
      continue;
    }
    if (!Seen(seen, folded)) {
      seen.push_back(&folded);
    }
    if (std::optional<FaceDescriptors> found =
            ResolveDescriptors(c_collection, id, it->folded_family, seen)) {
      return found;
    }
  }
  if (direct) {
    return direct;
  }
  // The name lists the face itself (a call declared it, or it is a name
  // the face is listed under with no alias of it going round a loop): auto.
  if (!looped || assets->latestDeclarationOrder(id, folded) > 0) {
    return FaceDescriptors();
  }
  return std::nullopt;
}

}  // namespace

// The alias is the target name drawn (a FontFace of the same face and
// descriptors), so it follows a target declared again; newest call first,
// an alias of an auto name too. A direct `auto` declaration of the name
// newer than the alias is the newest FontFace of their segment
// (css_segmented_font_face.cc ForEachReverse): auto.
FaceDescriptors DescriptorsUnder(skiac_font_collection* c_collection,
                                 SkTypefaceID id,
                                 const std::string& folded,
                                 std::vector<const std::string*>& seen) {
  return ResolveDescriptors(c_collection, id, folded, seen)
      .value_or(std::nullopt);
}

bool DescribesName(skiac_font_collection* c_collection,
                   const std::string& folded,
                   std::vector<const std::string*>& seen) {
  if (c_collection->assets->describes(folded)) {
    return true;
  }
  for (const auto& entry : c_collection->set_aliases) {
    if (!entry.active || entry.folded_alias != folded ||
        entry.folded_family == folded || Seen(seen, entry.folded_family)) {
      continue;
    }
    if (!Seen(seen, folded)) {
      seen.push_back(&folded);
    }
    if (DescribesName(c_collection, entry.folded_family, seen)) {
      return true;
    }
  }
  return false;
}

FaceDescriptors DeclaredDescriptors(skiac_font_collection* c_collection,
                                    SkTypeface* base,
                                    std::string_view family) {
  if (!base || !c_collection->assets->describesAny()) {
    return std::nullopt;
  }
  std::vector<const std::string*> seen;
  return DescriptorsUnder(c_collection, base->uniqueID(),
                          FoldedUntaggedFamily(family), seen);
}

std::vector<FaceDescriptors> FamilyDescriptors(
    skiac_font_collection* c_collection,
    const std::vector<SkString>& families,
    const std::vector<bool>& generic,
    const SkFontStyle& style,
    const std::vector<sk_sp<SkTypeface>>& base_faces,
    std::optional<std::vector<std::optional<size_t>>>* family_of_out) {
  std::vector<FaceDescriptors> out;
  // No named family has descriptors: no lookup at all.
  const auto& assets = c_collection->assets;
  bool described = false;
  for (size_t i = 0; assets->describesAny() && i < families.size(); ++i) {
    if (i < generic.size() && generic[i]) {
      continue;
    }
    std::vector<const std::string*> seen;
    if (DescribesName(
            c_collection,
            FoldedUntaggedFamily({families[i].c_str(), families[i].size()}),
            seen)) {
      described = true;
      break;
    }
  }
  if (!described) {
    return out;
  }
  out.resize(base_faces.size());
  std::vector<std::optional<size_t>> family_of =
      FaceFamilies(c_collection, families, style, base_faces);
  for (size_t k = 0; k < base_faces.size(); ++k) {
    const std::optional<size_t> i = family_of[k];
    if (i && (*i >= generic.size() || !generic[*i])) {
      out[k] = DeclaredDescriptors(c_collection, base_faces[k].get(),
                                   {families[*i].c_str(), families[*i].size()});
    }
  }
  if (family_of_out) {
    *family_of_out = std::move(family_of);
  }
  return out;
}

std::vector<std::optional<size_t>> FaceFamilies(
    skiac_font_collection* c_collection,
    const std::vector<SkString>& families,
    const SkFontStyle& style,
    const std::vector<sk_sp<SkTypeface>>& base_faces) {
  std::vector<std::optional<size_t>> out(base_faces.size());
  // findTypefaces keeps the faces of the families that match, in order: the
  // family of face k is the next one whose own match it is. The family is
  // looked up twice in one list: two faces when it matches, one (the
  // collection's default face) when it does not.
  size_t k = 0;
  for (size_t i = 0; i < families.size() && k < base_faces.size(); ++i) {
    const std::vector<sk_sp<SkTypeface>> found =
        c_collection->collection->findTypefaces({families[i], families[i]},
                                                style);
    if (found.size() != 2 || !found.front() || !base_faces[k] ||
        found.front()->uniqueID() != base_faces[k]->uniqueID()) {
      continue;
    }
    out[k] = i;
    ++k;
  }
  return out;
}

sk_sp<SkTypeface> FaceInstance(skiac_font_collection* c_collection,
                               const SkString& family,
                               const SkFontStyle& style,
                               const sk_sp<SkTypeface>& base,
                               const std::optional<FontArguments>& args) {
  // Two faces: the family matched and the clone worked (both the cached
  // clone); else findTypefaces gave the collection's default face.
  const std::vector<sk_sp<SkTypeface>> found =
      c_collection->collection->findTypefaces({family, family}, style, args);
  return found.size() == 2 && found.front() ? found.front() : base;
}

std::vector<SkFontArguments::VariationPosition::Coordinate> FontVariations(
    const std::vector<sk_sp<SkTypeface>>& faces,
    const skiac_text_request& request,
    float opsz_size,
    const FaceDescriptors& declared,
    bool web_face) {
  bool variable = false;
  std::optional<SkFontParameters::Variation::Axis> opsz_axis;
  std::optional<SkFontParameters::Variation::Axis> ital_axis;
  std::optional<SkFontParameters::Variation::Axis> slnt_axis;
  for (const auto& face : faces) {
    const auto axes = Axes(face.get());
    variable = variable || !axes.empty();
    if (!opsz_axis) {
      opsz_axis = FindAxis(axes, kOpsz);
    }
    if (web_face && !ital_axis) {
      ital_axis = FindAxis(axes, kItal);
      slnt_axis = FindAxis(axes, kSlnt);
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
    // ResolveVariations: an explicit range clamps the request
    // (ClampAxisValue); `auto` leaves it to the axis, which Skia clamps.
    const float weight = declared
                             ? ClampAxisValue(request.weight, declared->weight)
                             : request.weight;
    const float slope = declared
                            ? ClampAxisValue(request.slope, declared->slope)
                            : request.slope;
    const float width =
        declared ? ClampAxisValue(request.stretch_pct, declared->width)
                 : request.stretch_pct;
    coords.push_back({kWght, weight});
    coords.push_back({kWdth, width});
    // FontVariableItalicAxis: a web face's ital axis is 1 for the `italic`
    // keyword, else 0 (not the axis default); then slnt is the axis default.
    const bool use_ital = UsesItalAxis(ital_axis, request);
    if (ital_axis) {
      coords.push_back({kItal, use_ital ? 1.0f : 0.0f});
    }
    if (use_ital && slnt_axis) {
      coords.push_back({kSlnt, slnt_axis->def});
    } else {
      coords.push_back({kSlnt, slope == 0 ? 0 : -slope});
    }
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

bool HasWebItalAxis(skiac_font_collection* c_collection, SkTypeface* base) {
  return !IsSystemTypeface(c_collection, base) &&
         FindAxis(Axes(base), kItal).has_value();
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
// has no such metric. `declared`: `base`'s descriptors; `web_face`: `face`
// is FontVariations' instance of `base` alone with web_face.
float AspectValue(skiac_font_collection* c_collection,
                  const sk_sp<SkTypeface>& face,
                  SkTypeface* base,
                  float size,
                  int metric,
                  const skiac_text_request& request,
                  const FaceDescriptors& declared,
                  bool web_face) {
  SkFont font = MetricsFont(face, size);
  // FontPlatformData::SetupSkFont: the font Blink measures has the face's
  // synthetic bold and italic, which move the top of the 'x' outline.
  const SyntheticStyle synthetic = SynthesizeStyle(
      c_collection, face.get(), base, request, declared, web_face);
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
                           const std::vector<FaceDescriptors>& declared,
                           const skiac_text_request& request,
                           const LocaleFamilies* locale) {
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
  // made at its effective size (the computed size floored); a registered
  // face's with its ital axis (FontCustomPlatformData).
  auto aspect_of = [&](const sk_sp<SkTypeface>& base,
                       const FaceDescriptors& descriptors) {
    sk_sp<SkTypeface> face = base;
    const bool web_face = !IsSystemTypeface(c_collection, base.get());
    const auto coords =
        FontVariations({base}, request, computed, descriptors, web_face);
    if (!coords.empty()) {
      SkFontArguments args;
      args.setVariationDesignPosition(
          {coords.data(), static_cast<int>(coords.size())});
      if (sk_sp<SkTypeface> clone = base->makeClone(args)) {
        face = std::move(clone);
      }
    }
    return AspectValue(c_collection, face, base.get(), measured, metric,
                       request, descriptors, web_face);
  };
  const float primary_aspect =
      adjust ? aspect_of(base_faces.front(),
                         declared.empty() ? std::nullopt : declared.front())
             : 1;
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
      AtRequest(c_collection,
                ResolveFontFamilies(c_collection, request, &generic, locale),
                request.weight, request.slope, request.style);
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
    // An older face of a web family's style ("\x01s\x01"; font_families.cpp
    // SegmentStyleSet; or at a quarter weight or an oblique angle,
    // "\x01q\x01" and "\x01o\x01") that this style
    // has none of is no family, as the font list's findTypefaces skips it;
    // alone it would give the default.
    if ((families[i].startsWith("\x01s\x01") ||
         families[i].startsWith("\x01q\x01") ||
         families[i].startsWith("\x01o\x01")) &&
        !c_collection->assets->matchFamilyStyle(families[i].c_str(), style)) {
      continue;
    }
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
      const float face_adjusted = adjusted_for(aspect_of(
          face, generic[i] ? std::nullopt
                           : DeclaredDescriptors(
                                 c_collection, face.get(),
                                 {families[i].c_str(), families[i].size()})));
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

// FontDescription::LigaturesState values (font_props.rs LigatureState).
constexpr uint8_t kLigaturesNormal = 0;
constexpr uint8_t kLigaturesEnabled = 1;
constexpr uint8_t kLigaturesDisabled = 2;

}  // namespace

std::vector<hb_feature_t> BlinkFeatures(const skiac_text_request& request) {
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
  // non-zero value.
  bool default_chws = true;
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

SyntheticStyle SynthesizeStyle(skiac_font_collection* c_collection,
                               SkTypeface* face,
                               SkTypeface* base,
                               const skiac_text_request& request,
                               const FaceDescriptors& declared,
                               bool web_face) {
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
  // CSSSegmentedFontFace::GetFontData: synthetic when the range's maximum
  // is under the threshold (`auto` is weight 400 and slope 0), whatever
  // the axes span; then ResolveVariations, for a field from `auto` only,
  // drops it when the face's axis reaches the style.
  const skiac_face_range* declared_weight =
      declared ? &declared->weight : nullptr;
  const skiac_face_range* declared_slope =
      declared ? &declared->slope : nullptr;
  bool bold =
      weight >= kBoldThreshold &&
      (declared_weight ? declared_weight->max : kNormalWeight) < kBoldThreshold;
  bool italic = slope >= kItalicSlope &&
                (declared_slope ? declared_slope->max : 0) < kItalicSlope;
  const auto axes = Axes(base);
  // ResolveVariations: the ital axis draws the italic, never skewed, before
  // the declared and auto slope rules.
  if (web_face && UsesItalAxis(FindAxis(axes, kItal), request)) {
    italic = false;
  }
  if (const auto wght = FindAxis(axes, kWght);
      (!declared_weight || declared_weight->from_auto) && wght &&
      wght->min <= wght->max) {
    bold = bold && !(wght->max > kNormalWeight);
  }
  if (const auto slnt = FindAxis(axes, kSlnt);
      (!declared_slope || declared_slope->from_auto) && slnt &&
      slnt->min <= slnt->max) {
    italic = italic && !(slnt->min < 0);
  }
  return {bold && !base->isBold(), italic && !base->isItalic()};
}
