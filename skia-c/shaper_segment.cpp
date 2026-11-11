// The Blink shaper's RunSegmenter (shaper.hpp SegmentItem): a port of
// Blink's ScriptRunIterator (script_run_iterator.cc), SymbolsIterator
// (symbols_iterator.cc, with the vendored emoji presentation scanner) and
// RunSegmenter::Consume (run_segmenter.cc), without the orientation
// iterator (canvas text is horizontal).

#include <stdbool.h>

#include <algorithm>
#include <deque>
#include <utility>

#include "icu_api.h"
#include "shaper.hpp"

namespace {

using ScriptList = std::vector<int>;

constexpr int kMaxUnicodeScriptExtensions = 23;
constexpr int kMaxScriptCount = kMaxUnicodeScriptExtensions + 1;
constexpr size_t kMaxBrackets = 32;
constexpr UChar32 kLeftCornerBracket = 0x300C;

UChar32 CodePointAt(const char16_t* text, uint32_t length, uint32_t* i) {
  UChar32 c = text[(*i)++];
  if (c >= 0xD800 && c <= 0xDBFF && *i < length && text[*i] >= 0xDC00 &&
      text[*i] <= 0xDFFF) {
    c = 0x10000 + ((c - 0xD800) << 10) + (text[(*i)++] - 0xDC00);
  }
  return c;
}

// ---- ScriptRunIterator ----

int GetScriptForOpenType(UChar32 ch, UErrorCode* status) {
  const int script = uscript_getScript(ch, status);
  if (*status > U_ZERO_ERROR) {
    return script;
  }
  if (script == USCRIPT_KATAKANA || script == USCRIPT_KATAKANA_OR_HIRAGANA) {
    return USCRIPT_HIRAGANA;
  }
  return script;
}

bool IsHanScript(int script) {
  return script == USCRIPT_HAN || script == USCRIPT_HIRAGANA ||
         script == USCRIPT_BOPOMOFO;
}

int FirstHanScript(const ScriptList& list) {
  const auto result = std::find_if(list.begin(), list.end(), IsHanScript);
  return result != list.end() ? *result : USCRIPT_INVALID_CODE;
}

const ScriptList& HanScriptExtensions() {
  static const ScriptList list = [] {
    ScriptList scripts(kMaxScriptCount - 1);
    UErrorCode status = U_ZERO_ERROR;
    const int count = uscript_getScriptExtensions(
        kLeftCornerBracket, scripts.data(),
        static_cast<int32_t>(scripts.size()), &status);
    scripts.resize(status > U_ZERO_ERROR ? 0 : count);
    return scripts;
  }();
  return list;
}

void FixScriptsByEastAsianWidth(UChar32 ch, ScriptList* set) {
  if (set->size() > 1 || set->front() != USCRIPT_COMMON) {
    return;
  }
  const int eaw = u_getIntPropertyValue(ch, UCHAR_EAST_ASIAN_WIDTH);
  if (eaw == U_EA_WIDE || eaw == U_EA_FULLWIDTH || eaw == U_EA_HALFWIDTH) {
    *set = HanScriptExtensions();
  }
}

// ICUScriptData::GetScripts.
void GetScripts(UChar32 ch, ScriptList& dst) {
  UErrorCode status = U_ZERO_ERROR;
  const int primary_script = GetScriptForOpenType(ch, &status);
  if (primary_script == USCRIPT_HIRAGANA && status <= U_ZERO_ERROR) {
    dst.assign(1, primary_script);
    return;
  }
  dst.resize(kMaxScriptCount - 1);
  int count = uscript_getScriptExtensions(
      ch, dst.data(), static_cast<int32_t>(dst.size()), &status);
  if (status == U_BUFFER_OVERFLOW_ERROR) {
    count = static_cast<int>(dst.size());
    status = U_ZERO_ERROR;
  }
  if (status > U_ZERO_ERROR) {
    dst.clear();
    return;
  }
  dst.resize(count);
  if (primary_script == dst.at(0)) {
    return;
  }
  if (primary_script != USCRIPT_INHERITED && primary_script != USCRIPT_COMMON &&
      primary_script != USCRIPT_INVALID_CODE) {
    auto it = std::find(dst.begin() + 1, dst.end(), primary_script);
    if (it == dst.end()) {
      dst.push_back(primary_script);
      std::swap(dst.front(), dst.back());
    } else {
      std::swap(*dst.begin(), *it);
    }
    return;
  }
  if (primary_script == USCRIPT_COMMON) {
    if (count == 1) {
      dst.insert(dst.begin(), primary_script);
      return;
    }
    for (size_t i = 1; i < dst.size(); ++i) {
      if (dst.at(0) == USCRIPT_LATIN || dst.at(i) < dst.at(0)) {
        std::swap(dst.at(0), dst.at(i));
      }
    }
    return;
  }
  dst.push_back(dst.at(0));
  dst.at(0) = primary_script;
  for (size_t i = 2; i < dst.size(); ++i) {
    if (dst.at(1) == USCRIPT_LATIN || dst.at(i) < dst.at(1)) {
      std::swap(dst.at(1), dst.at(i));
    }
  }
}

// Leaves out GetSafeToExtendExistingRun: a shortcut over the characters
// whose sets would merge without a change, with the same runs.
class ScriptRunIterator {
 public:
  ScriptRunIterator(const char16_t* text, uint32_t length)
      : text_(text), length_(length) {
    if (ahead_pos_ < length_) {
      current_set_.assign(1, USCRIPT_COMMON);
      ahead_character_ = CodePointAt(text_, length_, &ahead_pos_);
      GetScripts(ahead_character_, ahead_set_);
    }
  }

  bool Consume(uint32_t* limit, int* script) {
    if (current_set_.empty()) {
      return false;
    }
    uint32_t pos;
    UChar32 ch;
    while (Fetch(&pos, &ch)) {
      const int paired_type =
          u_getIntPropertyValue(ch, UCHAR_BIDI_PAIRED_BRACKET_TYPE);
      switch (paired_type) {
        case U_BPT_OPEN:
          OpenBracket(ch);
          break;
        case U_BPT_CLOSE:
          CloseBracket(ch);
          break;
        default:
          break;
      }
      if (!MergeSets()) {
        *limit = pos;
        *script = ResolveCurrentScript();
        FixupStack(*script, paired_type == U_BPT_OPEN);
        current_set_ = next_set_;
        return true;
      }
    }
    *limit = length_;
    *script = ResolveCurrentScript();
    current_set_.clear();
    return true;
  }

 private:
  struct BracketRec {
    UChar32 ch;
    int script;
  };

  void OpenBracket(UChar32 ch) {
    if (brackets_.size() == kMaxBrackets) {
      brackets_.pop_front();
      if (brackets_fixup_depth_ == kMaxBrackets) {
        --brackets_fixup_depth_;
      }
    }
    FixScriptsByEastAsianWidth(ch, &next_set_);
    brackets_.push_back({ch, USCRIPT_COMMON});
    ++brackets_fixup_depth_;
  }

  void CloseBracket(UChar32 ch) {
    if (brackets_.empty()) {
      return;
    }
    const UChar32 target = u_getBidiPairedBracket(ch);
    for (auto it = brackets_.rbegin(); it != brackets_.rend(); ++it) {
      if (it->ch == target) {
        int script = it->script;
        if (IsHanScript(script)) {
          const int current_han_script = FirstHanScript(current_set_);
          if (current_han_script != USCRIPT_INVALID_CODE) {
            script = current_han_script;
          }
        }
        if (script != USCRIPT_COMMON) {
          next_set_.assign(1, script);
        }
        const int num_popped =
            static_cast<int>(std::distance(brackets_.rbegin(), it));
        for (int i = 0; i < num_popped; ++i) {
          brackets_.pop_back();
        }
        brackets_fixup_depth_ = static_cast<size_t>(
            std::max(0, static_cast<int>(brackets_fixup_depth_) - num_popped));
        return;
      }
    }
  }

  bool MergeSets() {
    if (next_set_.empty() || current_set_.empty()) {
      return false;
    }
    auto current_set_it = current_set_.begin();
    auto current_end = current_set_.end();
    int priority_script = *current_set_it++;
    if (next_set_.at(0) <= USCRIPT_INHERITED) {
      if (next_set_.size() == 2 && priority_script <= USCRIPT_INHERITED &&
          common_preferred_ == USCRIPT_COMMON) {
        common_preferred_ = next_set_.at(1);
      }
      return true;
    }
    if (priority_script <= USCRIPT_INHERITED) {
      current_set_ = next_set_;
      return true;
    }
    bool have_priority = std::find(next_set_.begin(), next_set_.end(),
                                   priority_script) != next_set_.end();
    if (current_set_it == current_end) {
      return have_priority;
    }
    auto next_it = next_set_.begin();
    auto next_end = next_set_.end();
    if (!have_priority) {
      priority_script = *next_it++;
      have_priority = std::find(current_set_it, current_end, priority_script) !=
                      current_end;
    }
    auto current_write_it = current_set_.begin();
    if (have_priority) {
      *current_write_it++ = priority_script;
    }
    if (next_it != next_end) {
      while (current_set_it != current_end) {
        const int sc = *current_set_it++;
        if (std::find(next_it, next_end, sc) != next_end) {
          *current_write_it++ = sc;
        }
      }
    }
    const auto written = std::distance(current_set_.begin(), current_write_it);
    if (written > 0) {
      current_set_.resize(written);
      return true;
    }
    return false;
  }

  void FixupStack(int resolved_script, bool exclude_last) {
    size_t count = brackets_fixup_depth_;
    if (count <= 0) {
      return;
    }
    count = std::min(count, brackets_.size());
    auto it = brackets_.rbegin();
    if (exclude_last) {
      ++it;
      --count;
      brackets_fixup_depth_ = 1;
    } else {
      brackets_fixup_depth_ = 0;
    }
    for (; count; ++it, --count) {
      it->script = resolved_script;
    }
  }

  bool Fetch(uint32_t* pos, UChar32* ch) {
    if (ahead_pos_ > length_) {
      return false;
    }
    *pos = ahead_pos_ - (ahead_character_ >= 0x10000 ? 2 : 1);
    *ch = ahead_character_;
    std::swap(next_set_, ahead_set_);
    if (ahead_pos_ == length_) {
      ahead_pos_++;
      return true;
    }
    return FetchNextCharacter();
  }

  bool FetchNextCharacter() {
    ahead_character_ = CodePointAt(text_, length_, &ahead_pos_);
    GetScripts(ahead_character_, ahead_set_);
    if (ahead_set_.empty()) {
      return false;
    }
    if (ahead_set_[0] == USCRIPT_INHERITED && ahead_set_.size() > 1) {
      if (next_set_[0] == USCRIPT_COMMON) {
        next_set_ = ahead_set_;
        next_set_.erase(next_set_.begin());
        ahead_set_.resize(1);
      } else {
        ahead_set_.resize(1);
      }
    }
    return true;
  }

  int ResolveCurrentScript() const {
    const int result = current_set_.at(0);
    return result == USCRIPT_COMMON ? common_preferred_ : result;
  }

  const char16_t* text_;
  const uint32_t length_;
  std::deque<BracketRec> brackets_;
  size_t brackets_fixup_depth_ = 0;
  ScriptList current_set_;
  ScriptList next_set_;
  ScriptList ahead_set_;
  UChar32 ahead_character_ = 0;
  uint32_t ahead_pos_ = 0;
  int common_preferred_ = USCRIPT_COMMON;
};

// ---- SymbolsIterator ----

// emoji_segmentation_category.h.
enum class EmojiSegmentationCategory : uint8_t {
  EMOJI = 0,
  EMOJI_TEXT_PRESENTATION = 1,
  EMOJI_EMOJI_PRESENTATION = 2,
  EMOJI_MODIFIER_BASE = 3,
  EMOJI_MODIFIER = 4,
  EMOJI_VS_BASE = 5,
  REGIONAL_INDICATOR = 6,
  KEYCAP_BASE = 7,
  COMBINING_ENCLOSING_KEYCAP = 8,
  COMBINING_ENCLOSING_CIRCLE_BACKSLASH = 9,
  ZWJ = 10,
  VS15 = 11,
  VS16 = 12,
  TAG_BASE = 13,
  TAG_SEQUENCE = 14,
  TAG_TERM = 15,
  kMaxCategory = 16,
  kInvalidCacheEntry = 17,
};

// The operators the generated scanner needs.
inline bool operator<(EmojiSegmentationCategory a, uint8_t b) {
  return static_cast<uint8_t>(a) < b;
}
inline bool operator>(EmojiSegmentationCategory a, uint8_t b) {
  return static_cast<uint8_t>(a) > b;
}
inline bool operator<=(EmojiSegmentationCategory a, uint8_t b) {
  return static_cast<uint8_t>(a) <= b;
}
inline bool operator<=(uint8_t a, EmojiSegmentationCategory b) {
  return a <= static_cast<uint8_t>(b);
}
inline uint8_t operator-(EmojiSegmentationCategory a, uint8_t b) {
  return static_cast<uint8_t>(a) - b;
}

bool IsEmojiKeycapBase(UChar32 ch) {
  return (ch >= '0' && ch <= '9') || ch == '#' || ch == '*';
}

// character_emoji.cc with ICU 78 (the binary properties).
bool IsEmojiEmojiDefault(UChar32 ch) {
  return u_hasBinaryProperty(ch, UCHAR_EMOJI_PRESENTATION);
}

bool IsEmojiTextDefault(UChar32 ch) {
  return u_hasBinaryProperty(ch, UCHAR_EMOJI) &&
         !u_hasBinaryProperty(ch, UCHAR_EMOJI_PRESENTATION);
}

bool IsEmojiIncludingReserved(UChar32 ch) {
  return u_hasBinaryProperty(ch, UCHAR_EMOJI) ||
         (u_charType(ch) == U_UNASSIGNED &&
          u_hasBinaryProperty(ch, UCHAR_EXTENDED_PICTOGRAPHIC));
}

// emoji_segmentation_category_inline_header.h.
EmojiSegmentationCategory GetEmojiSegmentationCategory(UChar32 codepoint) {
  using C = EmojiSegmentationCategory;
  if (codepoint <= 0x7F) {
    return IsEmojiKeycapBase(codepoint) ? C::KEYCAP_BASE : C::kMaxCategory;
  }
  if (codepoint == 0x20E3) {
    return C::COMBINING_ENCLOSING_KEYCAP;
  }
  if (codepoint == 0x20E0) {
    return C::COMBINING_ENCLOSING_CIRCLE_BACKSLASH;
  }
  if (codepoint == 0x200D) {
    return C::ZWJ;
  }
  if (codepoint == 0xFE0E) {
    return C::VS15;
  }
  if (codepoint == 0xFE0F) {
    return C::VS16;
  }
  if (codepoint == 0x1F3F4) {
    return C::TAG_BASE;
  }
  if ((codepoint >= 0xE0030 && codepoint <= 0xE0039) ||
      (codepoint >= 0xE0061 && codepoint <= 0xE007A)) {
    return C::TAG_SEQUENCE;
  }
  if (codepoint == 0xE007F) {
    return C::TAG_TERM;
  }
  if (u_hasBinaryProperty(codepoint, UCHAR_EMOJI_MODIFIER_BASE)) {
    return C::EMOJI_MODIFIER_BASE;
  }
  if (codepoint >= 0x1F3FB && codepoint <= 0x1F3FF) {
    return C::EMOJI_MODIFIER;
  }
  if (codepoint >= 0x1F1E6 && codepoint <= 0x1F1FF) {
    return C::REGIONAL_INDICATOR;
  }
  if (IsEmojiEmojiDefault(codepoint)) {
    return C::EMOJI_EMOJI_PRESENTATION;
  }
  if (IsEmojiTextDefault(codepoint)) {
    return C::EMOJI_TEXT_PRESENTATION;
  }
  if (IsEmojiIncludingReserved(codepoint)) {
    return C::EMOJI;
  }
  return C::kMaxCategory;
}

// Character::MaybeEmojiPresentation.
bool MaybeEmojiPresentation(UChar32 c) {
  if (c < 0x80) {
    return IsEmojiKeycapBase(c);
  }
  return c == 0x200D || (c >= 0x203C && c <= 0x2B55) || c == 0xFE0E ||
         c == 0x3030 || c == 0x303D || c == 0x3297 || c == 0x3299 ||
         c == 0xFE0F || c >= 65536;
}

// utf16_ragel_iterator.h UTF16RagelIterator.
class UTF16RagelIterator {
 public:
  UTF16RagelIterator() = default;
  UTF16RagelIterator(const char16_t* buffer, uint32_t size, uint32_t cursor = 0)
      : buffer_(buffer), size_(size), cursor_(cursor) {}

  UTF16RagelIterator end() const {
    UTF16RagelIterator ret = *this;
    ret.cursor_ = size_;
    return ret;
  }
  uint32_t size() const { return size_; }
  UTF16RagelIterator& SetCursor(uint32_t new_cursor) {
    cursor_ = new_cursor;
    cached_ = EmojiSegmentationCategory::kInvalidCacheEntry;
    return *this;
  }
  uint32_t Cursor() const { return cursor_; }

  UTF16RagelIterator& operator+=(int v) {
    for (; v > 0 && cursor_ < size_; --v) {
      Forward();
    }
    for (; v < 0 && cursor_ > 0; ++v) {
      Back();
    }
    cached_ = EmojiSegmentationCategory::kInvalidCacheEntry;
    return *this;
  }
  UTF16RagelIterator& operator-=(int v) { return *this += -v; }
  UTF16RagelIterator operator+(int v) const {
    UTF16RagelIterator ret = *this;
    return ret += v;
  }
  UTF16RagelIterator operator-(int v) const { return *this + -v; }
  int operator-(const UTF16RagelIterator& other) const {
    return static_cast<int>(cursor_) - static_cast<int>(other.cursor_);
  }
  UTF16RagelIterator& operator++() {
    Forward();
    cached_ = EmojiSegmentationCategory::kInvalidCacheEntry;
    return *this;
  }
  UTF16RagelIterator& operator--() {
    Back();
    cached_ = EmojiSegmentationCategory::kInvalidCacheEntry;
    return *this;
  }
  UTF16RagelIterator operator++(int) {
    UTF16RagelIterator ret = *this;
    ++(*this);
    return ret;
  }
  UTF16RagelIterator operator--(int) {
    UTF16RagelIterator ret = *this;
    --(*this);
    return ret;
  }
  UTF16RagelIterator operator=(int v) {
    UTF16RagelIterator ret = *this;
    ret.cursor_ = static_cast<uint32_t>(v);
    return ret;
  }
  EmojiSegmentationCategory operator*() {
    if (cached_ == EmojiSegmentationCategory::kInvalidCacheEntry) {
      cached_ = GetEmojiSegmentationCategory(Get(cursor_));
    }
    return cached_;
  }
  bool operator==(const UTF16RagelIterator& other) const {
    return buffer_ == other.buffer_ && size_ == other.size_ &&
           cursor_ == other.cursor_;
  }
  bool operator!=(const UTF16RagelIterator& other) const {
    return !(*this == other);
  }
  UChar32 PeekCodepoint() const {
    uint32_t temp = cursor_;
    if (temp < size_) {
      Forward(&temp);
    }
    return temp < size_ ? Get(temp) : 0xFFFD;
  }

 private:
  // U16_GET: the code point that contains unit i.
  UChar32 Get(uint32_t i) const {
    UChar32 c = buffer_[i];
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < size_ &&
        buffer_[i + 1] >= 0xDC00 && buffer_[i + 1] <= 0xDFFF) {
      return 0x10000 + ((c - 0xD800) << 10) + (buffer_[i + 1] - 0xDC00);
    }
    if (c >= 0xDC00 && c <= 0xDFFF && i > 0 && buffer_[i - 1] >= 0xD800 &&
        buffer_[i - 1] <= 0xDBFF) {
      return 0x10000 + ((buffer_[i - 1] - 0xD800) << 10) + (c - 0xDC00);
    }
    return c;
  }
  void Forward(uint32_t* cursor) const {
    const char16_t c = buffer_[(*cursor)++];
    if (c >= 0xD800 && c <= 0xDBFF && *cursor < size_ &&
        buffer_[*cursor] >= 0xDC00 && buffer_[*cursor] <= 0xDFFF) {
      ++*cursor;
    }
  }
  void Forward() { Forward(&cursor_); }
  void Back() {
    const char16_t c = buffer_[--cursor_];
    if (c >= 0xDC00 && c <= 0xDFFF && cursor_ > 0 &&
        buffer_[cursor_ - 1] >= 0xD800 && buffer_[cursor_ - 1] <= 0xDBFF) {
      --cursor_;
    }
  }

  const char16_t* buffer_ = nullptr;
  uint32_t size_ = 0;
  uint32_t cursor_ = 0;
  EmojiSegmentationCategory cached_ =
      EmojiSegmentationCategory::kInvalidCacheEntry;
};

using emoji_text_iter_t = UTF16RagelIterator;
#include "../third_party/emoji-segmenter/emoji_presentation_scanner.c"

class SymbolsIterator {
 public:
  SymbolsIterator(const char16_t* buffer, uint32_t size) {
    if (size) {
      buffer_iterator_ = UTF16RagelIterator(buffer, size);
      next_token_end_ =
          cursor_ +
          (scan_emoji_presentation(buffer_iterator_, buffer_iterator_.end(),
                                   &next_token_emoji_, &next_token_has_vs_) -
           buffer_iterator_);
    }
  }

  bool Consume(uint32_t* symbols_limit, Priority* priority) {
    if (cursor_ >= buffer_iterator_.size()) {
      return false;
    }
    bool current_token_emoji = false;
    bool curr_has_vs = false;
    do {
      cursor_ = next_token_end_;
      current_token_emoji = next_token_emoji_;
      curr_has_vs = next_token_has_vs_;
      if (cursor_ >= buffer_iterator_.end().Cursor()) {
        break;
      }
      if (!current_token_emoji &&
          !MaybeEmojiPresentation(buffer_iterator_.PeekCodepoint())) {
        ++buffer_iterator_;
        next_token_end_ = buffer_iterator_.Cursor();
        next_token_has_vs_ = false;
        continue;
      }
      buffer_iterator_.SetCursor(cursor_);
      next_token_end_ =
          cursor_ +
          (scan_emoji_presentation(buffer_iterator_, buffer_iterator_.end(),
                                   &next_token_emoji_, &next_token_has_vs_) -
           buffer_iterator_);
    } while (current_token_emoji == next_token_emoji_ &&
             curr_has_vs == next_token_has_vs_);
    if (curr_has_vs) {
      *priority = current_token_emoji ? Priority::kEmojiEmojiWithVS
                                      : Priority::kEmojiTextWithVS;
    } else {
      *priority = current_token_emoji ? Priority::kEmojiEmoji : Priority::kText;
    }
    *symbols_limit = cursor_;
    return true;
  }

 private:
  UTF16RagelIterator buffer_iterator_;
  uint32_t cursor_ = 0;
  uint32_t next_token_end_ = 0;
  bool next_token_emoji_ = false;
  bool next_token_has_vs_ = false;
};

}  // namespace

hb_script_t IcuScriptToHbScript(int script) {
  if (script <= USCRIPT_INVALID_CODE) {
    return SKIAC_HB_SCRIPT_INVALID;
  }
  return hb_script_from_string(uscript_getShortName(script), -1);
}

std::vector<Segment> SegmentItem(const char16_t* text,
                                 uint32_t length,
                                 bool is_8bit) {
  std::vector<Segment> segments;
  if (is_8bit) {
    // 8-bit text is horizontal Latin-1 (HarfBuzzShaper::Shape).
    segments.push_back({0, length, USCRIPT_LATIN, Priority::kText});
    return segments;
  }
  if (!length) {
    return segments;
  }
  ScriptRunIterator scripts(text, length);
  SymbolsIterator symbols(text, length);
  uint32_t script_position = 0;
  uint32_t symbols_position = 0;
  uint32_t last_split = 0;
  Segment candidate{0, 0, USCRIPT_INVALID_CODE, Priority::kText};
  for (;;) {
    // ConsumeIteratorPastLastSplit.
    if (script_position <= last_split && script_position < length) {
      while (scripts.Consume(&script_position, &candidate.script)) {
        if (script_position > last_split) {
          break;
        }
      }
    }
    if (symbols_position <= last_split && symbols_position < length) {
      while (symbols.Consume(&symbols_position, &candidate.priority)) {
        if (symbols_position > last_split) {
          break;
        }
      }
    }
    last_split = std::min(script_position, symbols_position);
    // Both iterators end at `length`; a split that does not move on would
    // loop for ever.
    if (last_split <= candidate.end) {
      last_split = length;
    }
    candidate.start = candidate.end;
    candidate.end = last_split;
    segments.push_back(candidate);
    if (last_split == length) {
      break;
    }
  }
  return segments;
}
