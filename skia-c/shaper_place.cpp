// The Blink shaper's placement (shaper.hpp PlaceItems): the glyph positions
// of PlainTextPainter::DrawWithBidiReorder (plain_text_painter.cc) through
// ShapeResultBloberizer's FillGlyphs / FillGlyphsNG and
// ShapeResult::ForEachGlyph (shape_result.cc), with the line width of
// PlainTextNode::AccumulateInlineSize (plain_text_node.cc).

#include <math.h>

#include <limits>

#include "shaper.hpp"

namespace {

// InlineLayoutUnit (FixedPoint<16, int64_t>) FromFloatRound.
int64_t FromFloatRound(float value) {
  const float raw = roundf(value * (1 << 16));
  if (!(raw > static_cast<float>(std::numeric_limits<int64_t>::min()))) {
    return std::numeric_limits<int64_t>::min();
  }
  if (!(raw < static_cast<float>(std::numeric_limits<int64_t>::max()))) {
    return std::numeric_limits<int64_t>::max();
  }
  return static_cast<int64_t>(raw);
}

// FixedPoint::ToFloat.
float ToFloat(int64_t value) {
  return static_cast<float>(value) / (1 << 16);
}

// ShapeResult::ForEachGlyph with the bloberizer's callback: each glyph at
// the running advance plus its offset, the advance rounded to 16.16 at each
// run start. Appends a BlinkRun per run; returns the advance after the item.
float FillItem(const ShapedItem& shaped,
               uint32_t item_index,
               float initial_advance,
               const PreparedText& prepared,
               BlinkLine* line) {
  float advance = initial_advance;
  for (const ShapedRun& run : shaped.result.runs) {
    int64_t total = FromFloatRound(advance);
    BlinkRun out;
    out.font = run.font->shaping_font;
    out.origin = {0, 0};
    out.item = item_index;
    out.glyphs.reserve(run.glyphs.size());
    out.positions.reserve(run.glyphs.size());
    out.clusters.reserve(run.glyphs.size());
    for (const ShapedGlyph& glyph : run.glyphs) {
      const float x = ToFloat(total);
      // AddGlyphToBloberizer: the advance plus the offset, as gfx::Vector2dF
      // adds them (0 + y); the fast path has no y offsets.
      out.glyphs.push_back(glyph.glyph);
      out.positions.push_back({x + glyph.x_offset, 0.0f + glyph.y_offset});
      out.clusters.push_back(
          prepared.utf8[shaped.item.start + run.start + glyph.character_index]);
      total += glyph.advance;
    }
    advance = ToFloat(total);
    line->runs.push_back(std::move(out));
  }
  return advance;
}

}  // namespace

PlacedLine PlaceItems(const std::vector<ShapedItem>& items,
                      const PreparedText& prepared,
                      bool contains_rtl,
                      bool rtl_base) {
  PlacedLine placed;
  // AccumulateInlineSize: RTL subtracts each width and negates the sum,
  // which gives the same float as adding them.
  float inline_size = 0;
  for (const ShapedItem& item : items) {
    inline_size += item.result.width;
  }
  placed.line_width = inline_size;
  // The item whose left edge an inkless line's box sits at (text.cpp
  // MeasureOrDraw): the logically last for an LTR base, the logically first
  // for an RTL one, as the skparagraph path takes its words.
  const ShapedItem* edge = nullptr;
  for (const ShapedItem& item : items) {
    if (!edge || (rtl_base ? item.item.start < edge->item.start
                           : item.item.start > edge->item.start)) {
      edge = &item;
    }
  }
  if (edge) {
    placed.last_item_width = edge->result.width;
  }
  bool vertical_offsets = false;
  for (const ShapedItem& item : items) {
    for (const ShapedRun& run : item.result.runs) {
      vertical_offsets = vertical_offsets || run.has_vertical_offsets;
    }
  }
  if (!contains_rtl) {
    // FillGlyphs: one walk over every item from the line's left edge. With
    // a y offset it takes FillGlyphsSlow, which walks an RTL base's items
    // backwards (the words of LTR text in an RTL base come out reversed,
    // as in Chrome).
    float advance = 0;
    if (vertical_offsets && rtl_base) {
      for (size_t i = items.size(); i-- > 0;) {
        advance = FillItem(items[i], static_cast<uint32_t>(i), advance,
                           prepared, &placed.blink);
      }
      // TextMetrics::MeasureRuns puts the items left to right, as drawn
      // without the reversal.
      advance = 0;
      for (size_t i = 0; i < items.size(); ++i) {
        advance = FillItem(items[i], static_cast<uint32_t>(i), advance,
                           prepared, &placed.ink);
      }
    } else {
      for (size_t i = 0; i < items.size(); ++i) {
        advance = FillItem(items[i], static_cast<uint32_t>(i), advance,
                           prepared, &placed.blink);
      }
    }
    return placed;
  }
  // FillGlyphsNG for each item in visual order, at the advances of the
  // items before it.
  float origin = 0;
  for (size_t i = 0; i < items.size(); ++i) {
    const size_t first = placed.blink.runs.size();
    const float advance = FillItem(items[i], static_cast<uint32_t>(i), 0,
                                   prepared, &placed.blink);
    for (size_t r = first; r < placed.blink.runs.size(); ++r) {
      placed.blink.runs[r].origin = {origin, 0};
    }
    origin += advance;
  }
  return placed;
}
