// Canvas text: measureText, fillText and strokeText, laid out with
// skparagraph.

#include <math.h>
#include <string.h>
#include <algorithm>
#include <memory>
#include <optional>
#include <string_view>
#include <vector>

#include "text.hpp"

#if defined(SK_DEBUG) || !defined(SK_RELEASE)
#error "skia-c must be built with SK_RELEASE like libskia (see build.rs)"
#endif

namespace {

constexpr float kMaxLayoutWidth = 100000;
constexpr float kHangingAsPercentOfAscent = 80;

// Blink's em box (SimpleFontData::TrySetNormalizedTypoAscentAndDescent): the
// ascent:descent ratio scaled to the font size, in LayoutUnits (1/64 px,
// rounded half away from zero).
bool NormalizedEmHeight(float font_size,
                        float ascent,
                        float descent,
                        float* em_ascent,
                        float* em_descent) {
  const float height = ascent + descent;
  if (height <= 0 || ascent < 0 || ascent > height) {
    return false;
  }
  auto layout_unit = [](float value) { return roundf(value * 64) / 64; };
  *em_ascent = layout_unit(font_size * ascent / height);
  *em_descent = layout_unit(font_size) - *em_ascent;
  return true;
}

// Blink's SimpleFontData::NormalizedTypoAscentAndDescent: the OS/2
// sTypoAscender and sTypoDescender (offset 68) when the ascender is
// positive, else the font's ascent and descent.
void EmHeight(const SkFont& font,
              const SkFontMetrics& font_metrics,
              float* em_ascent,
              float* em_descent) {
  uint8_t os2[4];
  SkTypeface* typeface = font.getTypeface();
  if (typeface && typeface->getTableData(SkSetFourByteTag('O', 'S', '/', '2'),
                                         68, sizeof(os2), os2) == sizeof(os2)) {
    float typo_ascender = static_cast<int16_t>((os2[0] << 8) | os2[1]);
    float typo_descender = -static_cast<int16_t>((os2[2] << 8) | os2[3]);
    if (typo_ascender > 0 &&
        NormalizedEmHeight(font.getSize(), typo_ascender, typo_descender,
                           em_ascent, em_descent)) {
      return;
    }
  }
  if (NormalizedEmHeight(font.getSize(), -font_metrics.fAscent,
                         font_metrics.fDescent, em_ascent, em_descent)) {
    return;
  }
  *em_ascent = 0;
  *em_descent = 0;
}

bool StartsWithLanguage(std::string_view lang, std::string_view language) {
  if (lang.size() < language.size()) {
    return false;
  }
  for (size_t i = 0; i < language.size(); ++i) {
    char c = lang[i];
    if (c >= 'A' && c <= 'Z') {
      c = static_cast<char>(c - 'A' + 'a');
    }
    if (c != language[i]) {
      return false;
    }
  }
  return lang.size() == language.size() || lang[language.size()] == '-' ||
         lang[language.size()] == '_';
}

// Lays out `request` and either paints it on `canvas` at (x, y), squeezed to
// `max_width`, or fills `line_metrics` for an anchor at (0, 0).
void MeasureOrDraw(skiac_font_collection* c_collection,
                   const skiac_text_request& request,
                   SkPaint* paint,
                   SkCanvas* canvas,
                   float x,
                   float y,
                   float max_width,
                   skiac_line_metrics* c_line_metrics,
                   bool collect_ink) {
  // A face or alias registered since the last lookup can change an existing
  // match, and FontCollection caches matches until told otherwise.
  c_collection->flushCachesIfDirty();
  auto font_collection = c_collection->collection;
  auto font_style =
      SkFontStyle(static_cast<int>(roundf(request.weight)), request.stretch,
                  static_cast<SkFontStyle::Slant>(request.style));
  auto text_direction = static_cast<TextDirection>(request.direction);
  const float letter_spacing = request.letter_spacing;
  TextStyle text_style;
  text_style.setFontFamilies(ResolveFontFamilies(c_collection, request));
  text_style.setFontSize(request.size);
  text_style.setWordSpacing(request.word_spacing);
  text_style.setLetterSpacing(letter_spacing);
  text_style.setHeight(1);
  text_style.setFontStyle(font_style);

  std::vector<SkFontArguments::VariationPosition::Coordinate> coords;

  // Apply variable font variations if provided
  if (request.variations && request.variations_count > 0) {
    coords.reserve(request.variations_count + 1);
    for (int i = 0; i < request.variations_count; i++) {
      coords.push_back(
          {request.variations[i].tag, request.variations[i].value});
    }
  }

  // Apply font stretch as 'wdth' variation for variable fonts
  if (request.stretch_pct != 100.0f) {
    coords.push_back(
        {SkSetFourByteTag('w', 'd', 't', 'h'), request.stretch_pct});
  }

  if (!coords.empty()) {
    SkFontArguments font_args;
    font_args.setVariationDesignPosition(
        {coords.data(), static_cast<int>(coords.size())});
    text_style.setFontArguments(std::make_optional(font_args));
  }

  // Apply font kerning feature
  // kerning: 0=auto (don't set feature), 1=none (disable), 2=normal (enable)
  if (request.kerning == 1) {
    text_style.addFontFeature(SkString("kern"), 0);
  } else if (request.kerning == 2) {
    text_style.addFontFeature(SkString("kern"), 1);
  }

  // Apply font variant caps features
  // variant_caps: 0=normal, 1=small-caps, 2=all-small-caps, 3=petite-caps,
  // 4=all-petite-caps, 5=unicase, 6=titling-caps
  switch (request.variant_caps) {
    case 1:
      text_style.addFontFeature(SkString("smcp"), 1);
      break;
    case 2:
      text_style.addFontFeature(SkString("smcp"), 1);
      text_style.addFontFeature(SkString("c2sc"), 1);
      break;
    case 3:
      text_style.addFontFeature(SkString("pcap"), 1);
      break;
    case 4:
      text_style.addFontFeature(SkString("pcap"), 1);
      text_style.addFontFeature(SkString("c2pc"), 1);
      break;
    case 5:
      text_style.addFontFeature(SkString("unic"), 1);
      break;
    case 6:
      text_style.addFontFeature(SkString("titl"), 1);
      break;
    default:
      break;
  }

  // Apply language/locale for language-specific glyph variants
  // lang: BCP-47 language tag (e.g., "en", "tr", "zh-Hans"), empty or
  // "inherit" for none.
  std::string_view lang(request.lang ? request.lang : "",
                        request.lang ? request.lang_len : 0);
  if (!lang.empty() && lang != "inherit") {
    text_style.setLocale(SkString(lang.data(), lang.size()));

    // Turkish/Azerbaijani locale: disable standard and contextual ligatures
    // These languages have a dotless i (ı) as a separate letter from dotted i.
    // The "fi" ligature would incorrectly merge "f" with "i", obscuring the dot
    // which is semantically significant. Use case-insensitive comparison per
    // BCP-47 (RFC 5646).
    if (StartsWithLanguage(lang, "tr") || StartsWithLanguage(lang, "az")) {
      text_style.addFontFeature(SkString("liga"), 0);
      text_style.addFontFeature(SkString("clig"), 0);
    }
  }

  // Apply textRendering: only optimizeSpeed changes behavior.
  // text_rendering: 0=auto, 1=optimizeSpeed, 2=optimizeLegibility,
  // 3=geometricPrecision
  if (request.text_rendering == 1) {
    // optimizeSpeed: disable ligatures and contextual alternates for speed
    // Note: kern is NOT touched here - it's fontKerning's responsibility
    text_style.addFontFeature(SkString("liga"), 0);
    text_style.addFontFeature(SkString("clig"), 0);
    text_style.addFontFeature(SkString("calt"), 0);
  }

  text_style.setForegroundColor(*paint);
  text_style.setTextBaseline(TextBaseline::kAlphabetic);
  StrutStyle struct_style;
  struct_style.setLeading(0);

  ParagraphStyle paragraph_style;
  paragraph_style.setTextStyle(text_style);
  paragraph_style.setTextDirection(text_direction);
  paragraph_style.setStrutStyle(struct_style);
  ParagraphBuilderImpl builder(paragraph_style, font_collection,
                               SkUnicodes::ICU::Make());
  builder.addText(request.text, request.text_len);
  std::unique_ptr<ParagraphImpl> paragraph(
      static_cast<ParagraphImpl*>(builder.Build().release()));
  paragraph->layout(kMaxLayoutWidth);
  std::vector<LineMetrics> metrics_vec;
  paragraph->getLineMetrics(metrics_vec);
  auto line_metrics = metrics_vec[0];
  auto run = paragraph->run(0);
  auto font = run.font();
  SkFontMetrics font_metrics;
  font.getMetrics(&font_metrics);
  std::vector<SkRect> bounds(request.text_len);
  auto glyphs = run.glyphs();
  auto glyphs_size = glyphs.size();
  font.getBounds(glyphs, bounds, paint);

  // line_metrics.fWidth doesn't contain the suffix spaces
  // run.calculateWidth will return 0 if font is rendering as fallback
  //
  // So we use `getMaxIntrinsicWidth()` to get the `line_width`.
  // - For single-run text without internal spaces: uses run.advance().fX from
  // HarfBuzz shaping
  // - For text with internal spaces or multiple runs: uses TextWrapper's
  // cluster-based calculation Both are direction-independent and include
  // trailing spaces.
  //
  // Note: Using `getRectsForRange()` may cause `measureText.width` to return
  // different values for LTR and RTL layouts.
  auto line_width = paragraph->getMaxIntrinsicWidth();
  auto first_char_bounds = bounds[0];
  auto descent = first_char_bounds.fBottom;
  auto ascent = first_char_bounds.fTop;
  auto last_char_bounds = bounds[glyphs_size - 1];
  auto last_char_pos_x = run.positionX(glyphs_size - 1);

  for (size_t i = 1; i <= glyphs_size - 1; ++i) {
    auto char_bounds = bounds[i];
    auto char_bottom = char_bounds.fBottom;
    if (char_bottom > descent) {
      descent = char_bottom;
    }
    auto char_top = char_bounds.fTop;
    if (char_top < ascent) {
      ascent = char_top;
    }
  }
  auto alphabetic_baseline = paragraph->getAlphabeticBaseline();
  auto css_baseline = static_cast<CssBaseline>(request.baseline);
  SkScalar baseline_offset = 0;
  // https://github.com/chromium/chromium/blob/104.0.5092.1/third_party/blink/renderer/core/html/canvas/text_metrics.cc#L21-L25
  // According to
  // http://wiki.apache.org/xmlgraphics-fop/LineLayout/AlignmentHandling
  // "FOP (Formatting Objects Processor) puts the hanging baseline at 80% of
  // the ascender height". Shared by the Hanging case and hangingBaseline, so
  // hangingBaseline is exactly 0 at 'hanging'.
  SkScalar hanging_offset =
      -alphabetic_baseline -
      font_metrics.fAscent * kHangingAsPercentOfAscent / 100.0;
  switch (css_baseline) {
    case CssBaseline::Top:
      baseline_offset = -alphabetic_baseline - font_metrics.fAscent -
                        font_metrics.fUnderlinePosition -
                        font_metrics.fUnderlineThickness;
      break;
    case CssBaseline::Hanging:
      baseline_offset = hanging_offset;
      break;
    case CssBaseline::Middle:
      baseline_offset = -paragraph->getHeight() / 2;
      break;
    case CssBaseline::Alphabetic:
      baseline_offset = -alphabetic_baseline;
      break;
    case CssBaseline::Ideographic:
      baseline_offset = -paragraph->getIdeographicBaseline();
      break;
    case CssBaseline::Bottom:
      baseline_offset = -alphabetic_baseline + font_metrics.fStrikeoutPosition +
                        font_metrics.fStrikeoutThickness;
      break;
  };

  auto line_center = line_width / 2.0f;
  float paint_x;
  float offset_x = 0.0f;

  // RTL: Skia lays out text from kMaxLayoutWidth right edge, compensate here.
  // Separated from paint_x to avoid being affected by maxWidth scaling.
  float rtl_offset = (text_direction == TextDirection::kRtl)
                         ? (kMaxLayoutWidth - line_width)
                         : 0.0f;

  // LTR: Skia adds letter_spacing/2 before first char, compensate here.
  // Separated from paint_x to avoid being affected by maxWidth scaling.
  //
  // However, Cursive Scripts do not allow gaps between their letters for either
  // justification or letter-spacing.
  // Cursive scripts are included:
  // Arabic, Hanifi Rohingya, Mandaic, Mongolian, N’Ko, Phags Pa, Syriac
  //
  // CSS Spec: https://www.w3.org/TR/css-text-3/#cursive-tracking
  // Blink CL: https://chromium-review.googlesource.com/c/chromium/src/+/6399436
  // Skia CL: https://skia-review.googlesource.com/c/skia/+/1099477
  float letter_spacing_offset =
      (text_direction == TextDirection::kLtr && !run.isCursiveScript())
          ? -letter_spacing / 2
          : 0.0f;

  // Determine alignment type
  auto text_align = static_cast<TextAlign>(request.align);
  bool is_right_aligned =
      text_align == TextAlign::kRight ||
      (text_align == TextAlign::kStart &&
       text_direction == TextDirection::kRtl) ||
      (text_align == TextAlign::kEnd && text_direction == TextDirection::kLtr);

  // Calculate paint_x and offset_x based on alignment
  if (text_align == TextAlign::kCenter) {
    paint_x = x - line_center;
    offset_x = line_center;
  } else if (is_right_aligned) {
    paint_x = x - line_width;
    offset_x = line_width;
  } else {
    paint_x = x;
  }

  if (canvas) {
    auto need_scale = line_width > max_width;
    float ratio = need_scale ? max_width / line_width : 1.0f;
    if (need_scale) {
      canvas->save();
      canvas->scale(ratio, 1.0f);
    }
    // final_x: scale user coords (paint_x, offset_x), then apply Skia offsets
    float final_x = need_scale ? (paint_x + (1 - ratio) * offset_x) / ratio -
                                     rtl_offset + letter_spacing_offset
                               : paint_x - rtl_offset + letter_spacing_offset;
    paragraph->paint(canvas, final_x, y + baseline_offset);
    if (need_scale) {
      canvas->restore();
    }
    return;
  }
  auto offset = -baseline_offset - alphabetic_baseline;
  float metrics_paint_x = paint_x + letter_spacing_offset;
  c_line_metrics->ascent = -ascent + offset;
  c_line_metrics->descent = descent - offset;
  c_line_metrics->left =
      -metrics_paint_x + line_metrics.fLeft - first_char_bounds.fLeft;
  c_line_metrics->right =
      metrics_paint_x + last_char_pos_x + last_char_bounds.fRight;
  c_line_metrics->width = line_width;
  c_line_metrics->font_ascent = -font_metrics.fAscent + offset;
  c_line_metrics->font_descent = font_metrics.fDescent - offset;
  // Blink (text_metrics.cc), with offset = -baseline_y:
  // alphabetic = -baseline_y, hanging = 0.8 * ascent - baseline_y,
  // ideographic = -descent - baseline_y.
  c_line_metrics->alphabetic_baseline = offset;
  c_line_metrics->hanging_baseline = hanging_offset - baseline_offset;
  c_line_metrics->ideographic_baseline = -c_line_metrics->font_descent;
  float em_ascent;
  float em_descent;
  EmHeight(font, font_metrics, &em_ascent, &em_descent);
  c_line_metrics->em_height_ascent = em_ascent + offset;
  c_line_metrics->em_height_descent = em_descent - offset;
  // The ink of every glyph the draw above paints, where it paints it:
  // visit() walks the text blobs paint() draws, and the origin is the
  // draw's own, rtl_offset and letter_spacing_offset included. Relative to
  // x, unscaled. Only the alpha:false reset asks for it; the walk is a
  // large share of a measure, so measureText skips it.
  SkScalar ink_left = SK_ScalarInfinity;
  SkScalar ink_right = SK_ScalarNegativeInfinity;
  if (collect_ink) {
    paragraph->visit([&](int, const Paragraph::VisitorInfo* info) {
      if (!info) {
        return;
      }
      std::vector<SkRect> glyph_bounds(info->count);
      info->font.getBounds({info->glyphs, static_cast<size_t>(info->count)},
                           glyph_bounds, paint);
      for (int i = 0; i < info->count; ++i) {
        if (glyph_bounds[i].isEmpty()) {
          continue;
        }
        auto glyph_x = info->origin.fX + info->positions[i].fX;
        ink_left = std::min(ink_left, glyph_x + glyph_bounds[i].fLeft);
        ink_right = std::max(ink_right, glyph_x + glyph_bounds[i].fRight);
      }
    });
  }
  auto draw_x = paint_x - rtl_offset + letter_spacing_offset - x;
  // No ink (only spaces) or not asked for: an empty box at the anchor.
  c_line_metrics->ink_left = ink_left <= ink_right ? draw_x + ink_left : 0;
  c_line_metrics->ink_right = ink_left <= ink_right ? draw_x + ink_right : 0;
}

}  // namespace

extern "C" {

void skiac_text_measure(skiac_font_collection* c_collection,
                        const skiac_text_request* request,
                        skiac_paint* c_paint,
                        bool collect_ink,
                        skiac_line_metrics* c_line_metrics) {
  MeasureOrDraw(c_collection, *request, reinterpret_cast<SkPaint*>(c_paint),
                nullptr, 0, 0, 0, c_line_metrics, collect_ink);
}

void skiac_text_draw(skiac_canvas* c_canvas,
                     skiac_font_collection* c_collection,
                     const skiac_text_request* request,
                     skiac_paint* c_paint,
                     float x,
                     float y,
                     float max_width) {
  MeasureOrDraw(c_collection, *request, reinterpret_cast<SkPaint*>(c_paint),
                reinterpret_cast<SkCanvas*>(c_canvas), x, y, max_width, nullptr,
                false);
}

}  // extern "C"
