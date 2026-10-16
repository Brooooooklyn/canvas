// The primary font's vertical metrics and the textBaseline offsets, like
// Blink's SimpleFontData::PlatformInit, FontMetrics::AscentDescentWithHacks,
// OpenTypeBaselineMetrics and TextMetrics::GetFontBaseline.

#include <math.h>
#include <stdint.h>
#include <algorithm>
#include <optional>

#include "text.hpp"
#include "text_raster.hpp"

#if defined(SK_DEBUG) || !defined(SK_RELEASE)
#error "skia-c must be built with SK_RELEASE like libskia (see build.rs)"
#endif

namespace {

constexpr float kHangingAsPercentOfAscent = 80;

hb_blob_t* ReferenceTable(hb_face_t*, hb_tag_t tag, void* user_data) {
  if (!tag) {
    return nullptr;
  }
  auto* typeface = static_cast<SkTypeface*>(user_data);
  sk_sp<SkData> data = typeface->copyTableData(tag);
  if (!data) {
    return nullptr;
  }
  SkData* table = data.release();
  return hb_blob_create(static_cast<const char*>(table->data()),
                        static_cast<unsigned int>(table->size()),
                        HB_MEMORY_MODE_READONLY, table,
                        [](void* ptr) { static_cast<SkData*>(ptr)->unref(); });
}

// LayoutUnit::FromFloatRound: 1/64 px, rounded half away from zero.
float LayoutUnitRound(float value) {
  return roundf(value * 64) / 64;
}

// Blink's SimpleFontData::TrySetNormalizedTypoAscentAndDescent: the
// ascent:descent ratio scaled to the font size.
bool NormalizeTypo(float size,
                   float ascent,
                   float descent,
                   PrimaryFontMetrics* metrics) {
  const float height = ascent + descent;
  if (height <= 0 || ascent < 0 || ascent > height) {
    return false;
  }
  metrics->typo_ascent = LayoutUnitRound(ascent * size / height);
  metrics->typo_descent = LayoutUnitRound(size) - metrics->typo_ascent;
  return true;
}

// The OS/2 sTypoAscender and sTypoDescender (offset 68).
bool TypoAscenderAndDescender(SkTypeface* typeface,
                              float* ascender,
                              float* descender) {
  uint8_t os2[4];
  if (typeface->getTableData(SkSetFourByteTag('O', 'S', '/', '2'), 68,
                             sizeof(os2), os2) != sizeof(os2)) {
    return false;
  }
  *ascender = static_cast<int16_t>((os2[0] << 8) | os2[1]);
  *descender = -static_cast<int16_t>((os2[2] << 8) | os2[3]);
  return true;
}

// OpenTypeBaselineMetrics: the BASE table's romn, hang and ideo baselines
// for the default script and language, in px (HarfBuzz 16.16 units of a font
// scaled to `size`).
void ReadBaseTable(SkTypeface* typeface,
                   float size,
                   PrimaryFontMetrics* metrics) {
  if (!typeface->getTableSize(SkSetFourByteTag('B', 'A', 'S', 'E'))) {
    return;
  }
  hb_face_t* face = CreateHbFace(typeface);
  hb_font_t* font = hb_font_create(face);
  // SkiaScalarToHarfBuzzPosition.
  const double scaled = static_cast<double>(size) * (1 << 16);
  const int scale =
      static_cast<int>(std::clamp(scaled, static_cast<double>(INT32_MIN + 1),
                                  static_cast<double>(INT32_MAX)));
  hb_font_set_scale(font, scale, scale);
  auto baseline = [&](hb_ot_layout_baseline_tag_t tag) -> std::optional<float> {
    hb_position_t position;
    if (hb_ot_layout_get_baseline(font, tag, HB_DIRECTION_LTR,
                                  HB_OT_TAG_DEFAULT_SCRIPT,
                                  HB_OT_TAG_DEFAULT_LANGUAGE, &position)) {
      return position / static_cast<float>(1 << 16);
    }
    return std::nullopt;
  };
  metrics->alphabetic = baseline(HB_OT_LAYOUT_BASELINE_TAG_ROMAN);
  metrics->hanging = baseline(HB_OT_LAYOUT_BASELINE_TAG_HANGING);
  metrics->ideographic =
      baseline(HB_OT_LAYOUT_BASELINE_TAG_IDEO_EMBOX_BOTTOM_OR_LEFT);
  hb_font_destroy(font);
  hb_face_destroy(face);
}

}  // namespace

bool IsSystemTypeface(skiac_font_collection* c_collection,
                      SkTypeface* typeface) {
  if (c_collection->system_typeface_ids.count(typeface->uniqueID())) {
    return true;
  }
#if defined(__APPLE__)
  if (c_collection->system_ui_ids.count(typeface->uniqueID())) {
    return true;
  }
#endif
  // The installed fonts the collection scanned itself (asset manager).
  if (!c_collection->font_mgr) {
    return false;
  }
  SkString family;
  typeface->getFamilyName(&family);
  sk_sp<SkTypeface> installed = c_collection->font_mgr->matchFamilyStyle(
      family.c_str(), typeface->fontStyle());
  return installed && installed->uniqueID() == typeface->uniqueID();
}

hb_face_t* CreateHbFace(SkTypeface* typeface) {
  typeface->ref();
  return hb_face_create_for_tables(ReferenceTable, typeface, [](void* ptr) {
    static_cast<SkTypeface*>(ptr)->unref();
  });
}

void AscentDescentWithHacks(skiac_font_collection* c_collection,
                            const SkFont& font,
                            SkTypeface* typeface,
                            float* ascent,
                            float* descent) {
  SkFontMetrics font_metrics;
  font.getMetrics(&font_metrics);
  // No VDMX (only for full or normal hinting with FreeType) and no descent
  // borrow (only with subpixel positioning, off for Linux Chrome). FontCache
  // asks for subpixel_ascent_descent for the canvas only for system fonts,
  // never a web font.
  const float raw_ascent = -font_metrics.fAscent;
  const float raw_descent = font_metrics.fDescent;
  if ((raw_ascent < 3 || raw_ascent + raw_descent < 2) &&
      IsSystemTypeface(c_collection, typeface)) {
    *ascent = raw_ascent;
    *descent = raw_descent;
  } else {
    *ascent = SkScalarRoundToScalar(raw_ascent);
    *descent = SkScalarRoundToScalar(raw_descent);
  }
#if defined(__APPLE__)
  // Blink's macOS ascent hack for Times, Helvetica and Courier (+15%).
  SkString family;
  font.getTypeface()->getFamilyName(&family);
  if (family.equals("Times") || family.equals("Helvetica") ||
      family.equals("Courier")) {
    *ascent += floorf((*ascent + *descent) * 0.15f + 0.5f);
  }
#endif
}

PrimaryFontMetrics MeasurePrimaryFont(skiac_font_collection* c_collection,
                                      SkTypeface* typeface,
                                      SkTypeface* base_typeface,
                                      float size) {
  PrimaryFontMetrics metrics;
  // SimpleFontData::PlatformInit: no metrics at size 0.
  if (!typeface || !(size > 0)) {
    return metrics;
  }
  const SkFont font = MetricsFont(sk_ref_sp(typeface), size);
  AscentDescentWithHacks(c_collection, font,
                         base_typeface ? base_typeface : typeface,
                         &metrics.ascent, &metrics.descent);
  SkFontMetrics font_metrics;
  font.getMetrics(&font_metrics);
  metrics.x_height = font_metrics.fXHeight;
  metrics.cap_height = font_metrics.fCapHeight;

  // SimpleFontData::ComputeNormalizedTypoAscentAndDescent.
  float typo_ascender;
  float typo_descender;
  if (!(TypoAscenderAndDescender(typeface, &typo_ascender, &typo_descender) &&
        typo_ascender > 0 &&
        NormalizeTypo(size, typo_ascender, typo_descender, &metrics)) &&
      !NormalizeTypo(size, metrics.ascent, metrics.descent, &metrics)) {
    metrics.typo_ascent = 0;
    metrics.typo_descent = 0;
  }

  ReadBaseTable(typeface, size, &metrics);
  return metrics;
}

// TextMetrics::GetFontBaseline: where the textBaseline sits, as a distance
// above the alphabetic baseline (y up).
float FontBaseline(int baseline, const PrimaryFontMetrics& metrics) {
  switch (static_cast<CssBaseline>(baseline)) {
    case CssBaseline::Top:
      return metrics.typo_ascent;
    case CssBaseline::Hanging:
      if (metrics.hanging) {
        return *metrics.hanging;
      }
      return static_cast<float>(metrics.ascent * kHangingAsPercentOfAscent /
                                100.0);
    case CssBaseline::Ideographic:
      if (metrics.ideographic) {
        return *metrics.ideographic;
      }
      return -metrics.descent;
    case CssBaseline::Bottom:
      return -metrics.typo_descent;
    case CssBaseline::Middle:
      return (metrics.typo_ascent - metrics.typo_descent) / 2.0f;
    case CssBaseline::Alphabetic:
      if (metrics.alphabetic) {
        return *metrics.alphabetic;
      }
      return 0;
  }
  return 0;
}

void FillFontMetrics(const PrimaryFontMetrics& metrics,
                     float baseline_y,
                     skiac_line_metrics* out) {
  out->font_ascent = metrics.ascent - baseline_y;
  out->font_descent = metrics.descent + baseline_y;
  out->em_height_ascent = metrics.typo_ascent - baseline_y;
  out->em_height_descent = metrics.typo_descent + baseline_y;
  // Blink writes -baseline_y without a BASE value: -0 at 'alphabetic'.
  out->alphabetic_baseline =
      metrics.alphabetic ? *metrics.alphabetic - baseline_y : -baseline_y;
  out->hanging_baseline =
      (metrics.hanging ? *metrics.hanging
                       : metrics.ascent * kHangingAsPercentOfAscent / 100.0f) -
      baseline_y;
  out->ideographic_baseline =
      (metrics.ideographic ? *metrics.ideographic : -metrics.descent) -
      baseline_y;
  out->x_height = metrics.x_height;
  out->cap_height = metrics.cap_height;
}
