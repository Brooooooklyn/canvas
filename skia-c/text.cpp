// Canvas text: measureText, fillText and strokeText, laid out with
// skparagraph.

#include <math.h>
#include <string.h>
#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <tuple>
#include <unordered_map>
#include <vector>

#include "text.hpp"
#include "text_raster.hpp"

#if defined(SK_DEBUG) || !defined(SK_RELEASE)
#error "skia-c must be built with SK_RELEASE like libskia (see build.rs)"
#endif

// What one laid out text gives measureText, fillText and strokeText, and
// the work text.cpp repeats for the same request; kept by the font
// collection until it drops its match caches
// (skiac_font_collection::text_caches).
struct TextCaches {
  // A laid out line, by the text and every request field the layout reads:
  // not the paint, the anchor, the max width, textAlign, textBaseline or
  // lcd_text, which only place or draw it.
  struct Line {
    PrimaryFontMetrics primary;
    // No text: only the font metrics.
    bool empty = false;
    // The width of Blink's advances.
    float line_width = 0;
    // skparagraph's width, from which it places RTL text.
    float paragraph_width = 0;
    float layout_width = 0;
    float line_baseline = 0;
    float letter_spacing_offset = 0;
    // The advance of the visually last word, for text without ink.
    float last_word_advance = 0;
    // The glyphs where Blink puts them (text_raster.cpp CollectBlinkLine).
    BlinkLine blink;
    // The words, byte ranges of the shaped text (MeasureBlinkInk).
    std::vector<std::pair<size_t, size_t>> words;
  };

  // ResolveFontFamilies by the request's family list.
  std::unordered_map<std::string, std::vector<SkString>> families;
  // MeasurePrimaryFont by typeface, base typeface and the size's bits.
  std::map<std::tuple<SkTypefaceID, SkTypefaceID, uint32_t>, PrimaryFontMetrics>
      metrics;
  // The SkUnicode every paragraph shares; skparagraph keeps no state in it.
  sk_sp<SkUnicode> unicode;
  // Kept within a budget of lines and about `line_bytes` bytes, in place of
  // skparagraph's ParagraphCache (turned off in skiac_font_collection).
  std::unordered_map<std::string, Line> lines;
  size_t line_bytes = 0;
};

void TextCachesDeleter::operator()(TextCaches* caches) const {
  delete caches;
}

namespace {

using Line = TextCaches::Line;

constexpr float kMaxLayoutWidth = 100000;
// TextCaches::lines holds up to kMaxLines lines and about kMaxLineBytes bytes
// (TextCaches::line_bytes), but it is not cleared for its bytes while it
// holds fewer than kMinLines lines. skparagraph's ParagraphCache (now off)
// kept the last 128 paragraphs of any size, each about 25 times the bytes of
// a kept line, so a loop over 128 lines of any length stays in both.
constexpr size_t kMaxLines = 512;
constexpr size_t kMinLines = 128;
constexpr size_t kMaxLineBytes = 16 << 20;

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

TextCaches& GetTextCaches(skiac_font_collection* c_collection) {
  if (!c_collection->text_caches) {
    c_collection->text_caches.reset(new TextCaches());
  }
  return *c_collection->text_caches;
}

const std::vector<SkString>& CachedFontFamilies(
    skiac_font_collection* c_collection,
    const skiac_text_request& request) {
  auto& cache = GetTextCaches(c_collection).families;
  if (cache.size() > 256) {
    cache.clear();
  }
  std::string key;
  for (size_t i = 0; i < request.family_count; ++i) {
    const auto& family = request.families[i];
    const int64_t prefix[2] = {family.generic,
                               static_cast<int64_t>(family.name_len)};
    key.append(reinterpret_cast<const char*>(prefix), sizeof(prefix));
    key.append(family.name, family.name_len);
  }
  auto found = cache.find(key);
  if (found == cache.end()) {
    found =
        cache
            .emplace(std::move(key), ResolveFontFamilies(c_collection, request))
            .first;
  }
  return found->second;
}

PrimaryFontMetrics CachedPrimaryFont(skiac_font_collection* c_collection,
                                     SkTypeface* typeface,
                                     SkTypeface* base_typeface,
                                     float size) {
  auto& cache = GetTextCaches(c_collection).metrics;
  if (cache.size() > 1024) {
    cache.clear();
  }
  uint32_t size_bits;
  memcpy(&size_bits, &size, sizeof(size_bits));
  const auto key =
      std::make_tuple(typeface ? typeface->uniqueID() : 0,
                      base_typeface ? base_typeface->uniqueID() : 0, size_bits);
  auto found = cache.find(key);
  if (found == cache.end()) {
    found = cache
                .emplace(key, MeasurePrimaryFont(c_collection, typeface,
                                                 base_typeface, size))
                .first;
  }
  return found->second;
}

// Every request field LayOutLine reads, then the text.
void AppendLineKey(std::string* key, const skiac_text_request& request) {
  auto put = [key](const void* data, size_t size) {
    key->append(static_cast<const char*>(data), size);
  };
  auto put_int = [&put](int64_t value) { put(&value, sizeof(value)); };
  auto put_float = [&put](float value) { put(&value, sizeof(value)); };
  put_int(static_cast<int64_t>(request.family_count));
  for (size_t i = 0; i < request.family_count; ++i) {
    put_int(request.families[i].generic);
    put_int(static_cast<int64_t>(request.families[i].name_len));
    put(request.families[i].name, request.families[i].name_len);
  }
  put_float(request.size);
  put_float(request.weight);
  put_float(request.slope);
  put_int(request.style);
  put_int(request.stretch);
  put_float(request.stretch_pct);
  put_int(request.direction);
  put_float(request.letter_spacing);
  put_float(request.word_spacing);
  put_int(request.variations_count);
  for (int i = 0; i < request.variations_count; ++i) {
    put_int(request.variations[i].tag);
    put_float(request.variations[i].value);
  }
  put_int(request.kerning);
  put_int(request.variant_caps);
  const size_t lang_len = request.lang ? request.lang_len : 0;
  put_int(static_cast<int64_t>(lang_len));
  put(request.lang, lang_len);
  put_int(request.text_rendering);
  put(request.text, request.text_len);
}

// The bytes a laid out line keeps for `runs` runs of `glyphs` glyphs and
// `words` words, as malloc counts them: about 128 for a run's font and
// vectors, 14 for a glyph's id, position and cluster, 16 for a word.
size_t LineBytes(size_t runs, size_t glyphs, size_t words) {
  return 128 * runs + 14 * glyphs + 16 * words;
}

// Lays out `request` with skparagraph into `line`.
void LayOutLine(skiac_font_collection* c_collection,
                const skiac_text_request& request,
                Line* line) {
  auto font_collection = c_collection->collection;
  auto font_style =
      SkFontStyle(static_cast<int>(roundf(request.weight)), request.stretch,
                  static_cast<SkFontStyle::Slant>(request.style));
  auto text_direction = static_cast<TextDirection>(request.direction);
  const float letter_spacing = request.letter_spacing;
  TextStyle text_style;
  text_style.setFontFamilies(CachedFontFamilies(c_collection, request));
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

  text_style.setTextBaseline(TextBaseline::kAlphabetic);
  // The OS's Chrome font flags (text_raster.cpp).
  const TextRasterPolicy policy(request);
  policy.ApplyToTextStyle(&text_style);
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
  line->primary =
      CachedPrimaryFont(c_collection, primary, primary_base, request.size);
  if (request.text_len == 0) {
    // Nothing to lay out or draw; measureText keeps the font metrics.
    line->empty = true;
    return;
  }

  // PlainTextNode shapes word by word: kerning and ligatures never cross a
  // space. skparagraph shapes each run of style blocks that share the font
  // attributes as one (OneLineShaper::iterateThroughFontStyles), so every
  // word gets a block whose half leading differs from its neighbours'. Half
  // leading only acts with a height override, which canvas text never sets.
  std::string prepared;
  const std::string_view text = PrepareCanvasText(
      std::string_view(request.text, request.text_len), &prepared);
  std::vector<std::pair<size_t, size_t>> words;
  if (CanShapeWordByWord(c_collection, faces, request)) {
    words = SplitWords(text);
  }
  if (words.empty()) {
    words.emplace_back(0, text.size());
  }
  // The pieces shaped on their own: the words, and for font-variant-caps
  // their case runs (HarfBuzzShaper::ShapeSegment). `shaped` is the text
  // skparagraph lays out, case mapped for synthesized small caps; `words`
  // move to it.
  struct Piece {
    size_t start;
    size_t end;
    int caps;
    bool small;
    // A zero width space word: no letter spacing.
    bool zero_width;
  };
  std::vector<Piece> pieces;
  std::string_view shaped = text;
  std::string caps_text;
  // Without letter spacing there is nothing to leave out (and one word
  // stays one text block).
  auto zero_width = [&](const std::pair<size_t, size_t>& word) {
    return letter_spacing != 0 && IsZeroWidthSpaceWord(text.substr(
                                      word.first, word.second - word.first));
  };
  if (request.variant_caps == 0) {
    for (const auto& word : words) {
      pieces.push_back({word.first, word.second, 0, false, zero_width(word)});
    }
  } else {
    for (auto& word : words) {
      const bool word_zero_width = zero_width(word);
      const size_t word_start = caps_text.size();
      for (const CapsPiece& piece : SplitCaps(
               c_collection, primary,
               text.substr(word.first, word.second - word.first), request)) {
        const size_t start = caps_text.size();
        caps_text += piece.text;
        pieces.push_back({start, caps_text.size(), piece.caps, piece.small,
                          word_zero_width});
      }
      word = {word_start, caps_text.size()};
    }
    shaped = caps_text;
  }
  sk_sp<SkUnicode>& unicode = GetTextCaches(c_collection).unicode;
  if (!unicode) {
    unicode = SkUnicodes::ICU::Make();
  }
  ParagraphBuilderImpl builder(paragraph_style, font_collection, unicode);
  if (pieces.size() == 1 && pieces[0].caps == 0 && !pieces[0].small &&
      !pieces[0].zero_width) {
    builder.addText(shaped.data(), shaped.size());
  } else {
    for (size_t i = 0; i < pieces.size(); ++i) {
      TextStyle piece_style = text_style;
      piece_style.setHalfLeading(i % 2 == 1);
      AddCapsFeatures(&piece_style, pieces[i].caps);
      if (pieces[i].small) {
        piece_style.setFontSize(SmallCapsSize(request.size));
      }
      if (pieces[i].zero_width) {
        piece_style.setLetterSpacing(0);
      }
      builder.pushStyle(piece_style);
      builder.addText(shaped.data() + pieces[i].start,
                      pieces[i].end - pieces[i].start);
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
  const float paragraph_width = paragraph->getMaxIntrinsicWidth();
  // RTL text sits at the right edge of the layout width. Lay it out again
  // just wider than the text (no reshaping: one line keeps its runs), so its
  // glyph positions are not floats near kMaxLayoutWidth that lose 1/128 px.
  float layout_width = kMaxLayoutWidth;
  if (text_direction == TextDirection::kRtl &&
      SkScalarCeilToScalar(paragraph_width) + 1 < kMaxLayoutWidth) {
    layout_width = SkScalarCeilToScalar(paragraph_width) + 1;
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
  // The glyphs where Blink puts them, and the width of Blink's advances.
  BlinkLine blink = CollectBlinkLine(paragraph.get(), policy,
                                     text_direction == TextDirection::kRtl);
  const float line_width = paragraph_width - blink.shift;
  // skparagraph draws the first line's glyphs at floor(baseline + 0.5) below
  // the paint origin (TextLine.cpp, correctedBaseline).
  const SkScalar line_baseline =
      paragraph->lines().empty()
          ? 0
          : SkScalarFloorToScalar(paragraph->lines()[0].baseline() + 0.5f);

  // LTR: TextLine moves the line right by the half letter spacing of its
  // first cluster that is not in a cursive script (a Flutter rule); Blink
  // does not, compensate here. That cluster has none when it is a zero
  // width space, and cursive scripts get no letter spacing.
  // Separated from paint_x to avoid being affected by maxWidth scaling.
  //
  // CSS Spec: https://www.w3.org/TR/css-text-3/#cursive-tracking
  // Blink CL: https://chromium-review.googlesource.com/c/chromium/src/+/6399436
  // Skia CL: https://skia-review.googlesource.com/c/skia/+/1099477
  line->letter_spacing_offset = 0.0f;
  if (text_direction == TextDirection::kLtr && !paragraph->lines().empty()) {
    const ClusterRange clusters = paragraph->lines()[0].clustersWithSpaces();
    for (ClusterIndex i = clusters.start; i < clusters.end; ++i) {
      const Cluster& cluster = paragraph->cluster(i);
      if (!cluster.run().isPlaceholder() && !cluster.run().isCursiveScript()) {
        line->letter_spacing_offset = -cluster.getHalfLetterSpacing();
        break;
      }
    }
  }

  line->line_width = line_width;
  line->paragraph_width = paragraph_width;
  line->layout_width = layout_width;
  line->line_baseline = line_baseline;
  // No glyph has ink: gfx::RectF::Union keeps the last empty word box, a
  // point on the baseline at the left edge of the visually last word (the
  // last word for LTR text, the first for RTL), so for "   " the box sits
  // before the last space. One word is the whole text.
  line->last_word_advance = line_width;
  if (words.size() > 1) {
    const auto& word =
        text_direction == TextDirection::kRtl ? words.front() : words.back();
    line->last_word_advance = 0;
    const auto& runs = paragraph->runs();
    for (size_t i = 0; i < runs.size(); ++i) {
      const Run& run = runs[i];
      if (run.textRange().start >= word.first &&
          run.textRange().end <= word.second) {
        line->last_word_advance += run.advance().fX - blink.run_shifts[i];
      }
    }
  }
  line->blink = std::move(blink);
  line->words = std::move(words);
}

// The cached layout of `request`, laid out now if there is none.
Line* FindOrLayOutLine(skiac_font_collection* c_collection,
                       const skiac_text_request& request) {
  std::string key;
  AppendLineKey(&key, request);
  {
    auto& lines = GetTextCaches(c_collection).lines;
    auto found = lines.find(key);
    if (found != lines.end()) {
      return &found->second;
    }
  }
  Line fresh;
  LayOutLine(c_collection, request, &fresh);
  // The layout can drop the caches (noteFontArguments), so look them up
  // again.
  TextCaches& caches = GetTextCaches(c_collection);
  size_t glyphs = 0;
  for (const BlinkRun& run : fresh.blink.runs) {
    glyphs += run.glyphs.size();
  }
  // The key, its map node and the Line take about 512 bytes on top.
  const size_t bytes =
      key.size() + 512 +
      LineBytes(fresh.blink.runs.size(), glyphs, fresh.words.size());
  if (caches.lines.size() >= kMaxLines ||
      (caches.lines.size() >= kMinLines &&
       caches.line_bytes + bytes > kMaxLineBytes)) {
    caches.lines.clear();
    caches.line_bytes = 0;
  }
  caches.line_bytes += bytes;
  return &caches.lines.emplace(std::move(key), std::move(fresh)).first->second;
}

// Lays out `request` (or takes the layout of an earlier call) and either
// paints it on `canvas` at (x, y), squeezed to `max_width`, or fills
// `line_metrics` for an anchor at (0, 0).
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
  Line* line = FindOrLayOutLine(c_collection, request);
  // The OS's Chrome draw font and glyph bounds (text_raster.cpp).
  const TextRasterPolicy policy(request);
  auto text_direction = static_cast<TextDirection>(request.direction);
  // TextMetrics::GetFontBaseline: the alphabetic baseline sits this far
  // below the textBaseline (base_rendering_context_2d.cc draws at
  // y + baseline_y).
  const float baseline_y = FontBaseline(request.baseline, line->primary);
  if (line->empty) {
    if (!canvas) {
      *c_line_metrics = {};
      FillFontMetrics(line->primary, baseline_y, c_line_metrics);
      c_line_metrics->ascent = -baseline_y;
      c_line_metrics->descent = baseline_y;
    }
    return;
  }
  const float line_width = line->line_width;
  const float paragraph_width = line->paragraph_width;
  const float layout_width = line->layout_width;
  const SkScalar line_baseline = line->line_baseline;
  const float letter_spacing_offset = line->letter_spacing_offset;

  auto line_center = line_width / 2.0f;
  float paint_x;
  float offset_x = 0.0f;

  // RTL: Skia lays out text from the layout width's right edge, compensate
  // here. Separated from paint_x to avoid being affected by maxWidth scaling.
  float rtl_offset = (text_direction == TextDirection::kRtl)
                         ? (layout_width - paragraph_width)
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
    // Each run with Blink's draw font, unclipped: skparagraph's paint() clips
    // a run to its line box when a cluster or trailing spaces cut it
    // (TextLine.cpp TextBlobRecord::paint); Chrome never clips canvas glyphs.
    const float paint_y = y + baseline_y - line_baseline;
    const SkMatrix device = canvas->getTotalMatrix();
    for (const BlinkRun& run : line->blink.runs) {
      const SkFont font = policy.DrawFont(run.font, &device);
      SkTextBlobBuilder builder;
      const auto& buffer = builder.allocRunPos(font, run.glyphs.size());
      memcpy(buffer.glyphs, run.glyphs.data(),
             run.glyphs.size() * sizeof(SkGlyphID));
      memcpy(buffer.points(), run.positions.data(),
             run.positions.size() * sizeof(SkPoint));
      canvas->drawTextBlob(builder.make(), final_x + run.origin.fX,
                           paint_y + run.origin.fY,
                           policy.DrawPaint(font, *paint));
    }
    if (need_scale) {
      canvas->restore();
    }
    return;
  }
  // TextMetrics::MeasureRuns: the union of the ink of every glyph, where the
  // draw above paints it, from Blink's draw font (SkFontGetBoundsForGlyphs:
  // outlines on macOS, whole-pixel glyph boxes elsewhere). x is from the
  // text's left edge: the draw's origin is draw_x from the anchor, and the
  // text's left edge offset_x left of it (Blink's text_align_dx).
  const float draw_x = paint_x - rtl_offset + letter_spacing_offset - x;
  BlinkRectF ink = MeasureBlinkInk(line->blink, policy, line->words,
                                   -(draw_x + offset_x), line_baseline);
  if (ink.IsEmpty()) {
    // No glyph has ink: gfx::RectF::Union keeps the last empty word box, a
    // point on the baseline at the left edge of the visually last word
    // (the last word for LTR text, the first for RTL), so for "   " the box
    // sits before the last space. One word is the whole text.
    ink = {line_width - line->last_word_advance, 0, 0, 0};
  }
  // TextMetrics::Update.
  c_line_metrics->left = -ink.x + offset_x;
  c_line_metrics->right = ink.right() - offset_x;
  c_line_metrics->ascent = -ink.y - baseline_y;
  c_line_metrics->descent = ink.bottom() + baseline_y;
  c_line_metrics->width = line_width;
  // Relative to the anchor, for the alpha:false reset.
  c_line_metrics->ink_left = ink.x - offset_x;
  c_line_metrics->ink_right = ink.right() - offset_x;
  FillFontMetrics(line->primary, baseline_y, c_line_metrics);
}

}  // namespace

std::vector<float> LineRunShifts(ParagraphImpl* paragraph) {
  std::vector<float> shifts;
  // One run has no run before it.
  if (paragraph->lines().size() != 1 || paragraph->runs().size() < 2) {
    return shifts;
  }
  // Without a cluster that advances less than nothing, no piece is narrower
  // than 0 and TextLine's x is Blink's. A cluster's width holds its letter
  // and word spacing. The glyph positions can go backwards without one:
  // OneLineShaper can leave a glyph of the next text in a run, outside the
  // run's clusters, and the spacing before it does not move it.
  bool negative = false;
  for (const Cluster& cluster : paragraph->clusters()) {
    if (cluster.width() < 0) {
      negative = true;
      break;
    }
  }
  if (!negative) {
    return shifts;
  }
  const TextLine& line = paragraph->lines()[0];
  bool moved = false;
  // Where the next run starts, from the line's start: Blink's x and
  // TextLine's (run_offset).
  float blink_offset = 0;
  // TextLine::ensureTextBlobCachePopulated's walk: one text blob per call
  // of the style visitor, an empty one for an empty glyph range.
  line.iterateThroughVisualRuns(false, [&](const Run* run, SkScalar run_offset,
                                           TextRange text_range,
                                           SkScalar* run_width) {
    if (run->placeholderStyle() != nullptr) {
      *run_width = run->advance().fX;
      blink_offset += run->advance().fX;
      return true;
    }
    float blink_in_run = 0;
    float line_in_run = 0;
    *run_width = line.iterateThroughSingleRunByStyles(
        TextLine::TextAdjustment::GlyphCluster, run, run_offset, text_range,
        StyleType::kForeground,
        [&](TextRange, const TextStyle&, const TextLine::ClipContext& context) {
          if (context.size > 0) {
            const float shift =
                (blink_offset + blink_in_run) - (run_offset + line_in_run);
            moved = moved || shift != 0;
            shifts.push_back(shift);
          }
          // The clip starts where TextLine puts the glyphs and is as
          // wide as their advances, cut at the line's advance and at 0
          // (TextLine::measureTextInsideOneRun).
          const float advance = context.run->calculateWidth(
              context.pos, context.pos + context.size, false);
          blink_in_run += (advance + context.clip.fLeft) - context.clip.fLeft;
          line_in_run += context.clip.width();
        });
    // A piece without height gets no blob and no visitor call; it
    // advances like TextLine counts it.
    blink_offset += blink_in_run + (*run_width - line_in_run);
    return true;
  });
  if (!moved) {
    shifts.clear();
  }
  return shifts;
}

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
