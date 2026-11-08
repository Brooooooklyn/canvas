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

  // Sets the font flags a run is shaped with (the edging, hinting and
  // subpixel OneLineShaper took from skparagraph's TextStyle). They are the
  // same for every textRendering: DrawFont sets every flag again for each
  // run.
  void ApplyShapingFlags(SkFont* font) const;

  // Blink's font for a run shaped with `shaped` (which carries the size,
  // typeface and synthetic styles). `device` is the device matrix of a
  // draw, null when measuring.
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
  // SystemFontRenderer() when the request began, so one request never mixes
  // modes.
  bool system_;
#if defined(__APPLE__)
  // skiac_text_request::lcd_text. Only CoreText runs get LCD masks, so the
  // other OSes do not keep it.
  bool lcd_text_;
#endif
};

// One run of a laid out line, in visual order: the font it was shaped with,
// and its glyphs at Blink's positions (relative to `origin`).
struct BlinkRun {
  SkFont font;
  SkPoint origin;
  std::vector<SkGlyphID> glyphs;
  std::vector<SkPoint> positions;
  // Each glyph's first byte in the request's text.
  std::vector<uint32_t> clusters;
  // The run's PlainTextItem, in visual order (one item is one word, or one
  // bidi run).
  uint32_t item = 0;
  // For TextMetrics: each glyph's x in its item, as
  // ShapeResult::ComputeInkBounds walks it (from the ceiling of the widths
  // of the item's runs before it), and its HarfBuzz offset.
  std::vector<float> ink_x;
  std::vector<SkPoint> offsets;
};

struct BlinkLine {
  std::vector<BlinkRun> runs;
  // Each item's ShapeResult width, in visual order (the item of
  // BlinkRun::item); after spacing it can be negative. Empty only for a line
  // with no text.
  std::vector<float> item_widths;
};

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
// coordinates) and y from the alphabetic baseline. Blink unites the glyph
// boxes of each run with GlyphBoundsAccumulator, then each item's
// ShapeResult::ComputeInkBounds (from BlinkRun::ink_x and offsets, outset to
// the left when the item's width is negative: PlainTextNode::Shape) at the
// float sum of the widths of the items before it with gfx::RectF::Union,
// each in its own coordinates, and the float rounding of those steps shows
// in the result; with no ink anywhere, the visually last item's box.
BlinkRectF MeasureBlinkInk(const BlinkLine& line,
                           const TextRasterPolicy& policy,
                           float left_edge);

#endif  // SKIA_C_TEXT_RASTER_H
