// Canvas text: measureText, fillText and strokeText, laid out with the
// Blink-style shaper (shaper.cpp).

#include <math.h>
#include <stdio.h>
#include <string.h>
#include <algorithm>
#include <cmath>
#include <list>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <tuple>
#include <unordered_map>
#include <vector>

#include "icu_api.h"
#include "shaper.hpp"
#include "text.hpp"
#include "text_caches.hpp"
#include "text_raster.hpp"

#if defined(SK_DEBUG) || !defined(SK_RELEASE)
#error "skia-c must be built with SK_RELEASE like libskia (see build.rs)"
#endif

void TextCachesDeleter::operator()(TextCaches* caches) const {
  delete caches;
}

TextCaches& GetTextCaches(skiac_font_collection* c_collection) {
  if (!c_collection->text_caches) {
    c_collection->text_caches.reset(new TextCaches());
  }
  return *c_collection->text_caches;
}

const std::vector<SkString>& CachedFontFamilies(
    skiac_font_collection* c_collection,
    const skiac_text_request& request,
    const LocaleFamilies* locale) {
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
  if (locale) {
    // A family entry's prefix never has a negative generic value: -1 is the
    // standard font, -2 - g the setting of generic family g.
    auto append = [&key](int64_t tag, const std::string& name) {
      if (name.empty()) {
        return;
      }
      const int64_t prefix[2] = {tag, static_cast<int64_t>(name.size())};
      key.append(reinterpret_cast<const char*>(prefix), sizeof(prefix));
      key.append(name);
    };
    append(-1, locale->standard);
    for (int64_t g = 0; g < 9; ++g) {
      append(-2 - g, locale->generic[g]);
    }
  }
  auto found = cache.find(key);
  if (found == cache.end()) {
    found = cache
                .emplace(
                    std::move(key),
                    ResolveFontFamilies(c_collection, request, nullptr, locale))
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

namespace {

using LineRun = TextCaches::Run;
using Line = TextCaches::Line;

// TextCaches::lines holds up to kMaxLines lines and about kMaxLineBytes bytes
// (TextCaches::line_bytes; not a hard cap: a draw adds a line's joined blob
// after the check), dropping the least recently used line first, but it
// drops none for its bytes while it holds fewer than kMinLines lines. So the
// last kMinLines lines used stay whatever their bytes, as in skparagraph's
// ParagraphCache (now off), which kept the last 128 paragraphs of any size,
// each several times the bytes of a kept line (up to about 25x with fallback
// runs): a loop over 128 lines of any length stays in both.
constexpr size_t kMaxLines = 512;
constexpr size_t kMinLines = 128;
constexpr size_t kMaxLineBytes = 16 << 20;
// Line::inks holds up to this many left edges.
constexpr size_t kMaxInks = 4;

// Every request field LayOutLineBlink reads, then the text.
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
  const int features_count = request.features ? request.features_count : 0;
  put_int(features_count);
  for (int i = 0; i < features_count; ++i) {
    put_int(request.features[i].tag);
    put_int(request.features[i].value);
  }
  put_int(request.lig_common);
  put_int(request.lig_discretionary);
  put_int(request.lig_historical);
  put_int(request.lig_contextual);
  put_int(request.variant_numeric);
  put_int(request.variant_position);
  put_int(request.optical_sizing);
  put_int(request.size_adjust_metric);
  put_float(request.size_adjust_value);
  put_int(request.size_adjust_from_font);
  put(request.text, request.text_len);
}

// How many binary digits `value` has after the point.
int FracBits(double value) {
  if (value == 0) {
    return 0;
  }
  if (!std::isfinite(value)) {
    return 1000;
  }
  int exponent = 0;
  // value = mantissa * 2^exponent, mantissa in [0.5, 1): 53 bits.
  const double mantissa = std::frexp(std::fabs(value), &exponent);
  uint64_t bits = static_cast<uint64_t>(std::ldexp(mantissa, 53));
  int trailing = 0;
  while (bits && !(bits & 1)) {
    bits >>= 1;
    ++trailing;
  }
  return std::max(0, 53 - exponent - trailing);
}

// The bytes that text blobs with `runs` blob runs (or blobs) of `glyphs`
// glyphs in all keep, as malloc counts them: about 128 for a blob run's
// record, its share of a blob and its slot in Line::runs, and 10 for a
// glyph's id and position.
size_t BlobBytes(size_t runs, size_t glyphs) {
  return 128 * runs + 10 * glyphs;
}

// Makes `line->runs`, a text blob for each of `line->blink`'s runs with its
// draw font, which is the one every draw takes unless
// policy.DrawFontUsesDevice(). Returns the bytes they keep.
size_t MakeRunBlobs(Line* line, const TextRasterPolicy& policy) {
  size_t glyphs = 0;
  line->runs.reserve(line->blink.runs.size());
  for (const BlinkRun& run : line->blink.runs) {
    const SkFont font = policy.DrawFont(run.font, nullptr);
    SkTextBlobBuilder builder;
    const auto& buffer = builder.allocRunPos(font, run.glyphs.size());
    memcpy(buffer.glyphs, run.glyphs.data(),
           run.glyphs.size() * sizeof(SkGlyphID));
    memcpy(buffer.points(), run.positions.data(),
           run.positions.size() * sizeof(SkPoint));
    line->runs.push_back({builder.make(), run.origin, font});
    glyphs += run.glyphs.size();
  }
  return BlobBytes(line->runs.size(), glyphs);
}

// Joins `line->runs` into `line->single` (one blob run for each run of a
// font) when they share one baseline and one draw paint, and every glyph's
// ink is inside its own blob's bounds: a canvas skips a blob whose bounds
// miss the clip, and some fonts' glyphs overflow the font's bounding box,
// which the bounds come from. Returns the bytes `line->single` keeps.
size_t MakeSingleBlob(Line* line, const TextRasterPolicy& policy) {
  // A run whose blob has empty bounds has no ink, and a canvas skips its
  // blob for a fill (an empty rect meets no clip): the joined blob leaves it
  // out, so an SVG canvas writes no empty text element for it.
  std::vector<const LineRun*> runs;
  for (const LineRun& line_run : line->runs) {
    if (!line_run.blob->bounds().isEmpty()) {
      runs.push_back(&line_run);
    }
  }
  if (runs.size() < 2) {
    return 0;
  }
  // The binary fraction digits and magnitudes DrawsLikeRuns checks: with
  // Blink's 16.16 advances (CoreText, Fontations) a line is joined only when
  // it is short, so the other lines skip the joined blob's bytes.
  int bits = 0;
  double max_offset = 0;
  double max_x = 0;
  for (const LineRun* line_run : runs) {
    const SkScalar offset = line_run->origin.fX;
    bits = std::max(bits, FracBits(offset));
    max_offset = std::max(max_offset, std::fabs(static_cast<double>(offset)));
    SkTextBlob::Iter it(*line_run->blob);
    SkTextBlob::Iter::ExperimentalRun run;
    while (it.experimentalNext(&run)) {
      for (int g = 0; g < run.count; ++g) {
        bits = std::max(bits, FracBits(run.positions[g].fX));
        max_x = std::max(max_x,
                         std::fabs(static_cast<double>(run.positions[g].fX)));
      }
    }
  }
  const int q = std::max(bits, 3);
  if (q > 23 || 2 * max_offset + max_x + 1 >= std::ldexp(1.0, 24 - q)) {
    return 0;
  }
  // DrawPaint adds a mask filter for some draw fonts; one paint draws the
  // joined blob.
  const bool masked =
      policy.DrawPaint(runs[0]->font, SkPaint()).getMaskFilter() != nullptr;
  // The blob runs: consecutive runs of one font.
  std::vector<std::pair<SkFont, int>> fonts;
  std::vector<SkRect> glyph_bounds;
  for (const LineRun* line_run : runs) {
    if (line_run->origin.fY != runs[0]->origin.fY ||
        (policy.DrawPaint(line_run->font, SkPaint()).getMaskFilter() !=
         nullptr) != masked) {
      return 0;
    }
    SkTextBlob::Iter it(*line_run->blob);
    SkTextBlob::Iter::ExperimentalRun run;
    while (it.experimentalNext(&run)) {
      if (fonts.empty() || !(fonts.back().first == run.font)) {
        fonts.emplace_back(run.font, 0);
      }
      fonts.back().second += run.count;
      glyph_bounds.resize(run.count);
      run.font.getBounds({run.glyphs, static_cast<size_t>(run.count)},
                         glyph_bounds, nullptr);
      for (int g = 0; g < run.count; ++g) {
        if (glyph_bounds[g].isEmpty()) {
          continue;
        }
        const SkRect ink =
            glyph_bounds[g]
                .makeOffset(run.positions[g].fX, run.positions[g].fY)
                .makeOutset(1, 1);
        if (!line_run->blob->bounds().contains(ink)) {
          return 0;
        }
      }
    }
  }
  SkTextBlobBuilder builder;
  const SkScalar first = runs[0]->origin.fX;
  size_t font_index = 0;
  int left_in_font = 0;
  SkGlyphID* glyphs = nullptr;
  SkPoint* points = nullptr;
  for (const LineRun* line_run : runs) {
    const SkScalar offset = line_run->origin.fX;
    SkTextBlob::Iter it(*line_run->blob);
    SkTextBlob::Iter::ExperimentalRun run;
    while (it.experimentalNext(&run)) {
      for (int g = 0; g < run.count; ++g) {
        if (left_in_font == 0) {
          const auto& buffer = builder.allocRunPos(fonts[font_index].first,
                                                   fonts[font_index].second);
          glyphs = buffer.glyphs;
          points = buffer.points();
          left_in_font = fonts[font_index].second;
          ++font_index;
        }
        *glyphs++ = run.glyphs[g];
        *points++ = {(offset - first) + run.positions[g].fX,
                     run.positions[g].fY};
        --left_in_font;
      }
    }
  }
  line->single = builder.make();
  line->single_origin = runs[0]->origin;
  line->single_font = runs[0]->font;
  line->frac_bits = bits;
  line->span = 2 * max_offset + max_x;
  size_t glyph_count = 0;
  for (const auto& font : fonts) {
    glyph_count += font.second;
  }
  return BlobBytes(fonts.size(), glyph_count);
}

// Whether drawing `line.single` at x on `canvas` with `paint` puts every
// glyph where drawing `line.runs` puts it. Skia sums a glyph's device x
// from the canvas translation, the draw origin, its subpixel rounding bias
// (1/8 or 1/2 px) and the glyph's x (SkGlyphRunPainter.cpp, and a tile's
// whole-pixel offset on a large bitmap); when every term is a multiple of
// 2^-q and their magnitudes add up below 2^(24-q), every partial sum is a
// float, so the two groupings give the same value. y is grouped the same
// both ways. Glyphs are drawn one at a time either way; image filters, mask
// filters and path effects are left out to be safe.
bool DrawsLikeRuns(const Line& line,
                   const SkCanvas* canvas,
                   const SkPaint& paint,
                   SkScalar x) {
  if (!line.single || paint.getImageFilter() || paint.getMaskFilter() ||
      paint.getPathEffect() || !paint.isSrcOver()) {
    return false;
  }
  const SkMatrix matrix = canvas->getTotalMatrix();
  if (!matrix.isTranslate()) {
    return false;
  }
  const double tx = matrix.getTranslateX();
  const int q = std::max({line.frac_bits, FracBits(x), FracBits(tx), 3});
  if (q > 23) {
    return false;
  }
  const double total = std::fabs(tx) + std::fabs(static_cast<double>(x)) + 1 +
                       line.span + canvas->getBaseLayerSize().width();
  return total < std::ldexp(1.0, 24 - q);
}

// The bytes a laid out line keeps for `runs` runs of `glyphs` glyphs, as
// malloc counts them: about 128 for a run's font and vectors, 14 for a
// glyph's id, position and cluster.
size_t LineBytes(size_t runs, size_t glyphs) {
  return 128 * runs + 14 * glyphs;
}

// The cached layout of `request`, laid out now if there is none.
Line* FindOrLayOutLine(skiac_font_collection* c_collection,
                       const skiac_text_request& request) {
  std::string key;
  AppendLineKey(&key, request);
  {
    TextCaches& caches = GetTextCaches(c_collection);
    auto found = caches.lines.find(key);
    if (found != caches.lines.end()) {
      Line* line = &found->second;
      caches.lru.splice(caches.lru.end(), caches.lru, line->lru);
      return line;
    }
  }
  Line fresh;
  c_collection->layout_font_arguments.clear();
  LayOutLineBlink(c_collection, request,
                  ResolveFontRequest(c_collection, request), &fresh);
  // The layout can ask for a drop of the caches (noteFontArguments): it runs
  // now, so look them up again. The line goes into the new ones.
  c_collection->dropCachesIfOverBudget();
  TextCaches& caches = GetTextCaches(c_collection);
  size_t glyphs = 0;
  for (const BlinkRun& run : fresh.blink.runs) {
    glyphs += run.glyphs.size();
  }
  // The glyphs also keep the x and offset TextMetrics measures them at: 12
  // bytes each. The key, its map node and the Line take about 512 bytes on
  // top; the first draw adds the text blobs' (MeasureOrDraw).
  const size_t bytes = key.size() + 512 +
                       LineBytes(fresh.blink.runs.size(), glyphs) +
                       12 * glyphs + 4 * fresh.blink.item_widths.size();
  while (!caches.lru.empty() && (caches.lines.size() >= kMaxLines ||
                                 (caches.lines.size() >= kMinLines &&
                                  caches.line_bytes + bytes > kMaxLineBytes))) {
    auto oldest = caches.lines.find(*caches.lru.front());
    caches.line_bytes -= oldest->second.bytes;
    caches.lines.erase(oldest);
    caches.lru.pop_front();
  }
  fresh.bytes = bytes;
  caches.line_bytes += bytes;
  auto& [line_key, line] =
      *caches.lines.emplace(std::move(key), std::move(fresh)).first;
  line.lru = caches.lru.insert(caches.lru.end(), &line_key);
  return &line;
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

  auto line_center = line_width / 2.0f;
  float paint_x;
  float offset_x = 0.0f;

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
    // final_x: the user coords (paint_x, offset_x) scaled. The glyphs sit
    // where Blink puts them from the text's left edge.
    float final_x =
        need_scale ? (paint_x + (1 - ratio) * offset_x) / ratio : paint_x;
    // Each run with Blink's draw font, unclipped: Chrome never clips canvas
    // glyphs.
    const float paint_y = y + baseline_y;
    if (policy.DrawFontUsesDevice()) {
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
    } else {
      if (!line->drawn) {
        // MakeSingleBlob joins the blobs MakeRunBlobs makes.
        size_t blob_bytes = MakeRunBlobs(line, policy);
        blob_bytes += MakeSingleBlob(line, policy);
        line->bytes += blob_bytes;
        GetTextCaches(c_collection).line_bytes += blob_bytes;
        line->drawn = true;
      }
      const SkPaint single_paint =
          line->single ? policy.DrawPaint(line->single_font, *paint)
                       : SkPaint();
      if (DrawsLikeRuns(*line, canvas, single_paint, final_x)) {
        canvas->drawTextBlob(line->single, final_x + line->single_origin.fX,
                             paint_y + line->single_origin.fY, single_paint);
      } else {
        for (const LineRun& run : line->runs) {
          canvas->drawTextBlob(run.blob, final_x + run.origin.fX,
                               paint_y + run.origin.fY,
                               policy.DrawPaint(run.font, *paint));
        }
      }
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
  const float draw_x = paint_x - x;
  const float left_edge = -(draw_x + offset_x);
  uint32_t left_bits;
  memcpy(&left_bits, &left_edge, sizeof(left_bits));
  BlinkRectF ink;
  auto found = std::find_if(
      line->inks.begin(), line->inks.end(),
      [left_bits](const auto& entry) { return entry.first == left_bits; });
  if (found != line->inks.end()) {
    ink = found->second;
  } else {
    ink = MeasureBlinkInk(line->blink, policy, left_edge);
    if (line->inks.size() < kMaxInks) {
      line->inks.emplace_back(left_bits, ink);
    }
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

void skiac_debug_text_line(skiac_font_collection* c_collection,
                           const skiac_text_request* request,
                           void (*sink)(const char*, size_t, void*),
                           void* context) {
  c_collection->flushCachesIfDirty();
  const Line* line = FindOrLayOutLine(c_collection, *request);
  std::string out;
  char number[64];
  auto put_float = [&](float value) {
    snprintf(number, sizeof(number), "%.9g", value);
    out += number;
  };
  out += "{\"empty\":";
  out += line->empty ? "true" : "false";
  out += ",\"width\":";
  put_float(line->line_width);
  out += ",\"lastWordAdvance\":";
  put_float(line->last_word_advance);
  out += ",\"runs\":[";
  for (size_t r = 0; r < line->blink.runs.size(); ++r) {
    const BlinkRun& run = line->blink.runs[r];
    SkString family;
    if (run.font.getTypeface()) {
      run.font.getTypeface()->getFamilyName(&family);
    }
    out += r ? ",{" : "{";
    out += "\"family\":\"";
    for (const char c : std::string_view(family.c_str(), family.size())) {
      if (c == '"' || c == '\\') {
        out += '\\';
      }
      if (static_cast<unsigned char>(c) >= 0x20) {
        out += c;
      }
    }
    out += "\",\"size\":";
    put_float(run.font.getSize());
    out += ",\"embolden\":";
    out += run.font.isEmbolden() ? "true" : "false";
    out += ",\"skew\":";
    put_float(run.font.getSkewX());
    // Where the glyphs go from the paint origin.
    out += ",\"x\":[";
    for (size_t i = 0; i < run.positions.size(); ++i) {
      if (i) {
        out += ',';
      }
      put_float(run.origin.fX + run.positions[i].fX);
    }
    out += "],\"y\":[";
    for (size_t i = 0; i < run.positions.size(); ++i) {
      if (i) {
        out += ',';
      }
      put_float(run.origin.fY + run.positions[i].fY);
    }
    out += "],\"glyphs\":[";
    for (size_t i = 0; i < run.glyphs.size(); ++i) {
      out += (i ? "," : "") + std::to_string(run.glyphs[i]);
    }
    out += "],\"clusters\":[";
    for (size_t i = 0; i < run.clusters.size(); ++i) {
      out += (i ? "," : "") + std::to_string(run.clusters[i]);
    }
    out += "]}";
  }
  out += "]}";
  sink(out.data(), out.size(), context);
}

bool skiac_text_line_kept(skiac_font_collection* c_collection,
                          const skiac_text_request* request) {
  if (!c_collection->text_caches) {
    return false;
  }
  std::string key;
  AppendLineKey(&key, *request);
  return c_collection->text_caches->lines.count(key) > 0;
}

// The advance of U+6C34 in the primary face of a font, for the ic unit:
// Blink's FontSizes::Ic (css_to_length_conversion_data.cc:139-152) reads
// Font::PrimaryFontWithCjkWater(), the first font of the family list that
// exists, whether or not it has the glyph (font_fallback_list.cc:88-195; only
// a unicode-range face is skipped), and SimpleFontData::IdeographicInlineSize,
// the unshaped advance of that glyph (simple_font_data.cc:437-474). Our
// primary face is the first that text layout tries: findTypefaces() with the
// same resolved families (ResolveFontFamilies with ResolveFontRequest's font
// settings, which the shaper uses), style and variations. Chrome 157
// OffscreenCanvas: lang ja "40px serif" is Hiragino Mincho ProN, 1ic 40px
// (stages/S8/review-r2/chrome-ic-*.json). When no family of the list exists,
// that is the standard font, as in Blink (font_fallback_list.cc:181-194); the
// common one has no U+6C34.
// False when nothing resolves or the face has no such glyph; ic is then 1em.
// The request's text is not read.
bool skiac_font_collection_ideographic_advance(
    skiac_font_collection* c_collection,
    const skiac_text_request* request,
    float* advance) {
  c_collection->flushCachesIfDirty();
  // The families and size the text of this font takes (ResolveFontRequest:
  // with the shaper on, the locale's font settings).
  const FontResolution resolution = ResolveFontRequest(c_collection, *request);
  const auto families_vec =
      ResolveFontFamilies(c_collection, *request, nullptr, resolution.locale());
  if (families_vec.empty()) {
    return false;
  }
  std::vector<SkFontArguments::VariationPosition::Coordinate> coords;
  for (int i = 0; i < request->variations_count; i++) {
    coords.push_back(
        {request->variations[i].tag, request->variations[i].value});
  }
  if (request->stretch_pct != 100.0f) {
    coords.push_back(
        {SkSetFourByteTag('w', 'd', 't', 'h'), request->stretch_pct});
  }
  std::optional<FontArguments> font_args;
  if (!coords.empty()) {
    SkFontArguments args;
    args.setVariationDesignPosition(
        {coords.data(), static_cast<int>(coords.size())});
    font_args.emplace(args);
  }
  auto typefaces = c_collection->collection->findTypefaces(
      families_vec,
      SkFontStyle(static_cast<int>(roundf(request->weight)), request->stretch,
                  static_cast<SkFontStyle::Slant>(request->style)),
      font_args);
  if (typefaces.empty()) {
    return false;
  }
  // At the primary font's size under font-size-adjust.
  const float size =
      ComputeUsedSizes(
          c_collection,
          c_collection->collection->findTypefaces(
              families_vec,
              SkFontStyle(static_cast<int>(roundf(request->weight)),
                          request->stretch,
                          static_cast<SkFontStyle::Slant>(request->style))),
          *request, resolution.locale())
          .effective;
  SkFont font(typefaces[0], size);
  // Blink's font has subpixel positioning, so the advance is unhinted.
  font.setSubpixel(true);
  font.setLinearMetrics(true);
  auto glyph = font.unicharToGlyph(0x6C34);
  if (glyph == 0) {
    return false;
  }
  *advance = font.getWidth(glyph);
  return true;
}

}  // extern "C"
