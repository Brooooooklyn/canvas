// The Blink shaper's items (shaper.hpp SegmentText): PlainTextNode::
// SegmentText and SegmentWord (plain_text_node.cc), with the bidi runs of
// BidiParagraph (bidi_paragraph.cc: logical runs, then ubidi_reorderVisual).

#include <memory>

#include "icu_api.h"
#include "shaper.hpp"

namespace {

struct BidiCloser {
  void operator()(UBiDi* bidi) const { ubidi_close(bidi); }
};

// SegmentWord: the words of [start, start + length) when shaping word by
// word, else the run as one item; an RTL run's words go in front of the
// run's place, in reverse order.
void SegmentWord(const PreparedText& prepared,
                 uint32_t start,
                 uint32_t length,
                 bool rtl,
                 bool word_by_word,
                 std::vector<Item>* items) {
  if (!word_by_word) {
    items->push_back({start, length, rtl});
    return;
  }
  const size_t insertion_index = items->size();
  const char16_t* text = prepared.text.data() + start;
  for (uint32_t index = 0; index < length;) {
    const uint32_t next = static_cast<uint32_t>(
        NextWordEndIndex(text, length, index, prepared.is_8bit));
    const Item item{start + index, next - index, rtl};
    if (!rtl) {
      items->push_back(item);
    } else {
      items->insert(items->begin() + insertion_index, item);
    }
    index = next;
  }
}

}  // namespace

ItemList SegmentText(const PreparedText& prepared,
                     bool rtl,
                     bool word_by_word) {
  ItemList list;
  list.rtl_base = rtl;
  const uint32_t length = static_cast<uint32_t>(prepared.text.size());
  if (prepared.maybe_bidi || rtl) {
    // BidiParagraph::SetParagraph on the original text: the normalization
    // turns the bidi controls into zero width spaces.
    std::unique_ptr<UBiDi, BidiCloser> bidi(ubidi_open());
    UErrorCode error = U_ZERO_ERROR;
    ubidi_setPara(bidi.get(), prepared.original.data(),
                  static_cast<int32_t>(length), rtl ? UBIDI_RTL : UBIDI_LTR,
                  nullptr, &error);
    if (error <= U_ZERO_ERROR) {
      const bool unidirectional = ubidi_getDirection(bidi.get()) != UBIDI_MIXED;
      if (!(unidirectional && !rtl)) {
        // GetLogicalRuns, then IndicesInVisualOrder.
        std::vector<std::pair<uint32_t, uint32_t>> runs;
        std::vector<UBiDiLevel> levels;
        for (uint32_t start = 0; start < length;) {
          int32_t end = 0;
          UBiDiLevel level = 0;
          ubidi_getLogicalRun(bidi.get(), static_cast<int32_t>(start), &end,
                              &level);
          runs.emplace_back(start, static_cast<uint32_t>(end));
          levels.push_back(level);
          start = static_cast<uint32_t>(end);
        }
        std::vector<int32_t> visual(runs.size());
        ubidi_reorderVisual(levels.data(), static_cast<int32_t>(levels.size()),
                            visual.data());
        for (int32_t index : visual) {
          const bool run_rtl = levels[index] & 1;
          list.contains_rtl = list.contains_rtl || run_rtl;
          SegmentWord(prepared, runs[index].first,
                      runs[index].second - runs[index].first, run_rtl,
                      word_by_word, &list.items);
        }
      }
    }
  }
  if (list.items.empty()) {
    SegmentWord(prepared, 0, length, rtl, word_by_word, &list.items);
  }
  return list;
}
