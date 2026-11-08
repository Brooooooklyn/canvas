// TextCaches: what text.cpp keeps per font collection (the resolved
// families, primary font metrics and laid out lines), shared with the Blink
// shaper (shaper.cpp), which lays out into the same Line.

#ifndef SKIA_C_TEXT_CACHES_H
#define SKIA_C_TEXT_CACHES_H

#include <list>
#include <map>
#include <memory>
#include <string>
#include <tuple>
#include <unordered_map>
#include <utility>
#include <vector>

#include "text.hpp"
#include "text_raster.hpp"

// The Blink shaper's HarfBuzz caches (shaper_font.cpp).
struct ShaperCaches;
void DestroyShaperCaches(ShaperCaches* caches);
struct ShaperCachesDeleter {
  void operator()(ShaperCaches* caches) const { DestroyShaperCaches(caches); }
};

// What one laid out text gives measureText, fillText and strokeText, and
// the work text.cpp repeats for the same request; kept by the font
// collection until it drops its match caches
// (skiac_font_collection::text_caches).
struct TextCaches {
  // A text blob of a laid out line with its draw font, drawn at `origin`
  // from the paint origin.
  struct Run {
    sk_sp<SkTextBlob> blob;
    SkPoint origin;
    SkFont font;
  };

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
    // MeasureBlinkInk's result by the left edge's float bits; the edge
    // depends on textAlign only through float rounding, so a line has one
    // or two.
    std::vector<std::pair<uint32_t, BlinkRectF>> inks;
    // `blink`'s runs as text blobs with the draw font (DrawFont without a
    // device), and as one text blob for the draws that put every glyph
    // where drawing `runs` puts it (DrawsLikeRuns). The first draw makes
    // both, so a draw takes the same blobs however often the line was drawn
    // before (an SVG or PDF canvas writes a text element for each blob run).
    // `single` leaves out the runs without ink (MakeSingleBlob); its origin
    // and draw font are the first run's it has, and a glyph's x is its run's
    // offset from that run plus its x in its run. `frac_bits` is the most
    // binary fraction digits of an offset or x, `span` twice the largest
    // offset plus the largest x.
    bool drawn = false;
    std::vector<Run> runs;
    sk_sp<SkTextBlob> single;
    SkPoint single_origin = {0, 0};
    SkFont single_font;
    int frac_bits = 0;
    double span = 0;
    // The bytes the line counts in TextCaches::line_bytes, and its place in
    // TextCaches::lru.
    size_t bytes = 0;
    std::list<const std::string*>::iterator lru;
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
  // The keys of `lines` (their map nodes do not move), least recently used
  // first.
  std::list<const std::string*> lru;
  // The Blink shaper's faces, fonts and buffer.
  std::unique_ptr<ShaperCaches, ShaperCachesDeleter> shaper;
};

// The collection's TextCaches, made on first use (text.cpp).
TextCaches& GetTextCaches(skiac_font_collection* c_collection);

// ResolveFontFamilies of the request's family list (with `standard_family`
// as the standard font when it is not empty), cached: a reference into
// TextCaches::families, valid until the next call (text.cpp).
const std::vector<SkString>& CachedFontFamilies(
    skiac_font_collection* c_collection,
    const skiac_text_request& request,
    std::string_view standard_family = {});

// MeasurePrimaryFont, cached in TextCaches::metrics (text.cpp).
PrimaryFontMetrics CachedPrimaryFont(skiac_font_collection* c_collection,
                                     SkTypeface* typeface,
                                     SkTypeface* base_typeface,
                                     float size);

// Counts each drop of a TextCaches and each clear of one of its maps, which
// end the references a layout holds into them (shaper.cpp checks that none
// happens during a Blink layout).
void NoteTextCachesChange();

#endif  // SKIA_C_TEXT_CACHES_H
