// How each OS's Chrome rasterizes canvas text: the draw font Blink makes for
// a run (FontPlatformData::CreateSkFont), the glyph bounds TextMetrics reads,
// and where the glyphs go (Blink's 16.16 advances).

#ifndef SKIA_C_TEXT_RASTER_H
#define SKIA_C_TEXT_RASTER_H

#include <vector>

#include "skia_c.hpp"

// The font Blink's SimpleFontData reads `typeface`'s metrics and glyph boxes
// from (FontPlatformData::CreateSkFont with textRendering auto).
SkFont MetricsFont(sk_sp<SkTypeface> typeface, float size);

// Blink's draw font and paint for one fillText / strokeText / measureText.
class TextRasterPolicy {
 public:
  explicit TextRasterPolicy(const skiac_text_request& request);

  // The font flags skparagraph shapes with. They are the same for every
  // textRendering: ParagraphCache keys ignore them (TextStyle::equalsByFonts),
  // so DrawFont sets every flag again for each run.
  void ApplyToTextStyle(TextStyle* style) const;

  // Blink's font for a run skparagraph shaped with `shaped` (which carries
  // the size, typeface and synthetic styles). `device` is the device matrix
  // of a draw, null when measuring.
  SkFont DrawFont(const SkFont& shaped, const SkMatrix* device) const;

  // Whether DrawFont gives another font for some device than for none: a
  // geometricPrecision run that may get LCD masks (macOS).
  bool DrawFontUsesDevice() const;

  // The paint that draws a run with `draw_font` (DrawFont's result).
  SkPaint DrawPaint(const SkFont& draw_font, const SkPaint& paint) const;

  // The glyph boxes Blink's ink bounds read (SkFontGetBoundsForGlyphs),
  // relative to each glyph's origin.
  void GlyphBounds(const SkFont& draw_font,
                   SkSpan<const SkGlyphID> glyphs,
                   SkSpan<SkRect> bounds) const;

 private:
  bool UsesLcdText(const SkFont& font, const SkMatrix& device) const;

  bool geometric_precision_;
#if defined(__APPLE__)
  // skiac_text_request::lcd_text. Only CoreText runs get LCD masks, so the
  // other OSes do not keep it.
  bool lcd_text_;
#endif
};

// One run of a laid out line, in visual order: the font skparagraph shaped
// it with, and its glyphs at Blink's positions (relative to `origin`).
struct BlinkRun {
  SkFont font;
  SkPoint origin;
  std::vector<SkGlyphID> glyphs;
  std::vector<SkPoint> positions;
  // Each glyph's first byte in the paragraph's text.
  std::vector<uint32_t> clusters;
};

struct BlinkLine {
  std::vector<BlinkRun> runs;
  // What Blink's advances leave out of skparagraph's: the line, and each of
  // `paragraph->runs()` (indexed like it).
  float shift = 0;
  std::vector<float> run_shifts;
};

// The first line of `paragraph` with Blink's glyph x: skshaper hands
// HarfBuzz round(width * 65536) (SkShaper_harfbuzz.cpp skhb_position), Blink
// hands it trunc(width * 65536) (skia_text_metrics.cc
// SkiaScalarToHarfBuzzPosition) of the draw font's width, so each glyph moves
// left by the difference summed over the glyphs before it.
BlinkLine CollectBlinkLine(ParagraphImpl* paragraph,
                           const TextRasterPolicy& policy,
                           bool rtl);

// gfx::RectF with its float arithmetic (ui/gfx/geometry/rect_f.cc): a size
// at or below 8 * FLT_EPSILON is 0 (size_f.h clamp).
struct BlinkRectF {
  float x = 0;
  float y = 0;
  float width = 0;
  float height = 0;

  float right() const { return x + width; }
  float bottom() const { return y + height; }
  bool IsEmpty() const { return !width || !height; }
};

// TextMetrics::MeasureRuns: the ink box of the glyphs of `line`, with x from
// the text's left edge (`left_edge` is where that edge is in the runs'
// coordinates) and y from the alphabetic baseline (at `baseline` in the runs'
// coordinates). Blink unites the glyph boxes of each run with
// GlyphBoundsAccumulator, the runs of each word (`words`, byte ranges of the
// paragraph's text) and then the words with gfx::RectF::Union, each in its
// own coordinates, and the float rounding of those steps shows in the
// result.
BlinkRectF MeasureBlinkInk(const BlinkLine& line,
                           const TextRasterPolicy& policy,
                           SkSpan<const std::pair<size_t, size_t>> words,
                           float left_edge,
                           float baseline);

#endif  // SKIA_C_TEXT_RASTER_H
