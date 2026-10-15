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
                   skiac_line_metrics* c_line_metrics) {
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

  // The families' faces, and the instances at the request's axes that draw
  // the text (FontCustomPlatformData::GetFontPlatformData).
  const std::vector<sk_sp<SkTypeface>> base_faces =
      font_collection->findTypefaces(text_style.getFontFamilies(), font_style);
  const std::vector<SkFontArguments::VariationPosition::Coordinate> coords =
      FontVariations(base_faces, request);
  if (!coords.empty()) {
    SkFontArguments font_args;
    font_args.setVariationDesignPosition(
        {coords.data(), static_cast<int>(coords.size())});
    text_style.setFontArguments(std::make_optional(font_args));
    c_collection->noteFontArguments(
        std::hash<FontArguments>()(*text_style.getFontArguments()));
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

  // Blink turns the optional ligatures off for any non-zero letter spacing
  // (FontFeatureRange::FromFontDescription); skparagraph only drops `liga`,
  // and only for positive spacing.
  if (letter_spacing != 0) {
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
  // Blink sums the HarfBuzz advances; skparagraph would round the width to
  // 1/100 px (a Flutter rule).
  paragraph_style.setApplyRoundingHack(false);
  // Blink synthesizes bold and italic per face (SynthesizeStyle below).
  paragraph_style.setFakeMissingFontStyles(false);
  // FontFallbackList::PrimaryFont: the first family's face gives the font
  // metrics and the textBaseline offset, whichever font draws the text.
  const std::vector<sk_sp<SkTypeface>> faces =
      coords.empty() ? base_faces
                     : font_collection->findTypefaces(
                           text_style.getFontFamilies(), font_style,
                           text_style.getFontArguments());
  SkTypeface* primary = faces.empty() ? nullptr : faces.front().get();
  SkTypeface* primary_base =
      base_faces.empty() ? nullptr : base_faces.front().get();
  const PrimaryFontMetrics primary_metrics =
      MeasurePrimaryFont(c_collection, primary, primary_base, request.size);
  // TextMetrics::GetFontBaseline: the alphabetic baseline sits this far
  // below the textBaseline (base_rendering_context_2d.cc draws at
  // y + baseline_y).
  const float baseline_y = FontBaseline(request.baseline, primary_metrics);

  if (request.text_len == 0) {
    // Nothing to lay out or draw; measureText keeps the font metrics.
    if (!canvas) {
      *c_line_metrics = {};
      FillFontMetrics(primary_metrics, baseline_y, c_line_metrics);
      c_line_metrics->ascent = -baseline_y;
      c_line_metrics->descent = baseline_y;
    }
    return;
  }

  // PlainTextNode shapes word by word: kerning and ligatures never cross a
  // space. skparagraph shapes each run of style blocks that share the font
  // attributes as one (OneLineShaper::iterateThroughFontStyles), so every
  // word gets a block whose half leading differs from its neighbours'. Half
  // leading only acts with a height override, which canvas text never sets.
  const std::string_view text(request.text, request.text_len);
  std::vector<std::pair<size_t, size_t>> words;
  if (CanShapeWordByWord(c_collection, faces, request)) {
    words = SplitWords(text);
  }
  ParagraphBuilderImpl builder(paragraph_style, font_collection,
                               SkUnicodes::ICU::Make());
  if (words.size() <= 1) {
    builder.addText(request.text, request.text_len);
  } else {
    TextStyle word_style = text_style;
    for (size_t i = 0; i < words.size(); ++i) {
      word_style.setHalfLeading(i % 2 == 1);
      builder.pushStyle(word_style);
      builder.addText(request.text + words[i].first,
                      words[i].second - words[i].first);
      builder.pop();
    }
  }
  std::unique_ptr<ParagraphImpl> paragraph(
      static_cast<ParagraphImpl*>(builder.Build().release()));
  paragraph->layout(kMaxLayoutWidth);
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
  // RTL text sits at the right edge of the layout width. Lay it out again
  // just wider than the text (no reshaping: one line keeps its runs), so its
  // glyph positions are not floats near kMaxLayoutWidth that lose 1/128 px.
  float layout_width = kMaxLayoutWidth;
  if (text_direction == TextDirection::kRtl &&
      SkScalarCeilToScalar(line_width) + 1 < kMaxLayoutWidth) {
    layout_width = SkScalarCeilToScalar(line_width) + 1;
    paragraph->layout(layout_width);
    if (paragraph->lines().size() != 1) {
      layout_width = kMaxLayoutWidth;
      paragraph->layout(layout_width);
    }
  }
  // FontPlatformData::SetupSkFont: the synthetic styles of the face that
  // draws each run. They change the glyphs, not the advances. `faces` holds
  // a clone of each of `base_faces`, in order.
  for (Run& run : paragraph->runs()) {
    auto& font = const_cast<SkFont&>(run.font());
    SkTypeface* base = nullptr;
    for (size_t i = 0; i < faces.size(); ++i) {
      if (faces[i]->uniqueID() == font.getTypeface()->uniqueID()) {
        base = faces.size() == base_faces.size() ? base_faces[i].get()
                                                 : faces[i].get();
        break;
      }
    }
    const SyntheticStyle synthetic =
        SynthesizeStyle(c_collection, font.getTypeface(), base, request);
    font.setEmbolden(synthetic.bold);
    font.setSkewX(synthetic.italic ? -SK_Scalar1 / 4 : 0);
  }
  // skparagraph draws the first line's glyphs at floor(baseline + 0.5) below
  // the paint origin (TextLine.cpp, correctedBaseline).
  const SkScalar line_baseline =
      paragraph->lines().empty()
          ? 0
          : SkScalarFloorToScalar(paragraph->lines()[0].baseline() + 0.5f);

  auto line_center = line_width / 2.0f;
  float paint_x;
  float offset_x = 0.0f;

  // RTL: Skia lays out text from the layout width's right edge, compensate
  // here. Separated from paint_x to avoid being affected by maxWidth scaling.
  float rtl_offset = (text_direction == TextDirection::kRtl)
                         ? (layout_width - line_width)
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
      (text_direction == TextDirection::kLtr && !paragraph->runs().empty() &&
       !paragraph->run(0).isCursiveScript())
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
    paragraph->paint(canvas, final_x, y + baseline_y - line_baseline);
    if (need_scale) {
      canvas->restore();
    }
    return;
  }
  // TextMetrics::MeasureRuns: the union of the ink of every glyph, where the
  // draw above paints it (visit() walks the text blobs paint() draws). Blink
  // reads whole-pixel glyph boxes on Linux (SkFontGetBoundsForGlyphs rounds
  // them out when subpixel positioning is off) and skips empty ones.
  bool has_ink = false;
  SkRect ink = SkRect::MakeEmpty();
  paragraph->visit([&](int, const Paragraph::VisitorInfo* info) {
    if (!info) {
      return;
    }
    std::vector<SkRect> glyph_bounds(info->count);
    info->font.getBounds({info->glyphs, static_cast<size_t>(info->count)},
                         glyph_bounds, nullptr);
    for (int i = 0; i < info->count; ++i) {
      if (glyph_bounds[i].isEmpty()) {
        continue;
      }
      SkRect glyph = SkRect::Make(glyph_bounds[i].roundOut());
      // y relative to the alphabetic baseline.
      glyph.offset(info->origin.fX + info->positions[i].fX,
                   info->origin.fY + info->positions[i].fY - line_baseline);
      if (has_ink) {
        ink.join(glyph);
      } else {
        ink = glyph;
        has_ink = true;
      }
    }
  });
  // x relative to the text's left edge: the draw's origin is draw_x from the
  // anchor, and the text's left edge offset_x left of it (Blink's
  // text_align_dx).
  const float draw_x = paint_x - rtl_offset + letter_spacing_offset - x;
  if (has_ink) {
    ink.offset(draw_x + offset_x, 0);
  } else {
    // No glyph has ink: gfx::RectF::Union keeps the last empty word box, a
    // point on the baseline at the left edge of the visually last word
    // (the last word for LTR text, the first for RTL), so for "   " the box
    // sits before the last space. Without words the text is one item.
    float last_word_advance = line_width;
    if (words.size() > 1) {
      const auto& word =
          text_direction == TextDirection::kRtl ? words.front() : words.back();
      last_word_advance = 0;
      for (const auto& run : paragraph->runs()) {
        if (run.textRange().start >= word.first &&
            run.textRange().end <= word.second) {
          last_word_advance += run.advance().fX;
        }
      }
    }
    const float left = line_width - last_word_advance;
    ink = SkRect::MakeLTRB(left, 0, left, 0);
  }
  // TextMetrics::Update.
  c_line_metrics->left = -ink.fLeft + offset_x;
  c_line_metrics->right = ink.fRight - offset_x;
  c_line_metrics->ascent = -ink.fTop - baseline_y;
  c_line_metrics->descent = ink.fBottom + baseline_y;
  c_line_metrics->width = line_width;
  // Relative to the anchor, for the alpha:false reset.
  c_line_metrics->ink_left = ink.fLeft - offset_x;
  c_line_metrics->ink_right = ink.fRight - offset_x;
  FillFontMetrics(primary_metrics, baseline_y, c_line_metrics);
}

}  // namespace

extern "C" {

void skiac_text_measure(skiac_font_collection* c_collection,
                        const skiac_text_request* request,
                        skiac_paint* c_paint,
                        skiac_line_metrics* c_line_metrics) {
  MeasureOrDraw(c_collection, *request, reinterpret_cast<SkPaint*>(c_paint),
                nullptr, 0, 0, 0, c_line_metrics);
}

void skiac_text_draw(skiac_canvas* c_canvas,
                     skiac_font_collection* c_collection,
                     const skiac_text_request* request,
                     skiac_paint* c_paint,
                     float x,
                     float y,
                     float max_width) {
  MeasureOrDraw(c_collection, *request, reinterpret_cast<SkPaint*>(c_paint),
                reinterpret_cast<SkCanvas*>(c_canvas), x, y, max_width,
                nullptr);
}

}  // extern "C"
