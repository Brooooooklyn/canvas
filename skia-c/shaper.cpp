// The Blink-style text shaper (shaper.hpp): the switch, the entry point, the
// font list and the shaping loop (a port of HarfBuzzShaper::ShapeSegment,
// ExtractShapeResults and CommitGlyphs, harfbuzz_shaper.cc, with
// ShapeResult::InsertRun, shape_result.cc), and its counters.

#include "shaper.hpp"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <atomic>
#include <deque>
#include <limits>
#include <optional>
#include <string_view>
#include <unordered_map>
#include <unordered_set>

#include "icu_api.h"

namespace {

std::atomic<uint64_t> g_accepted{0};
std::atomic<uint64_t> g_rejected[kShaperRejectSlots];
std::atomic<uint64_t> g_text_caches_changes{0};
std::atomic<uint64_t> g_cache_changes{0};

bool Reject(ShaperReject reason) {
  g_rejected[static_cast<size_t>(reason)].fetch_add(1,
                                                    std::memory_order_relaxed);
  return false;
}

constexpr const char* kOtShaperList[] = {"ot", nullptr};

// HarfBuzzRunGlyphData::kMaxCharacterIndex and kMaxGlyphs.
constexpr uint32_t kMaxCharacterIndex = (1u << 15) - 1;
constexpr uint32_t kMaxGlyphs = 1u << 15;

bool IsNonTextFallbackPriority(Priority priority) {
  return priority == Priority::kEmojiText ||
         priority == Priority::kEmojiEmoji ||
         priority == Priority::kEmojiTextWithVS ||
         priority == Priority::kEmojiEmojiWithVS;
}

bool IsEmojiPresentationEmoji(Priority priority) {
  return priority == Priority::kEmojiEmoji ||
         priority == Priority::kEmojiEmojiWithVS;
}

#if defined(__APPLE__)
uint32_t FloatBits(float value) {
  uint32_t bits;
  memcpy(&bits, &value, sizeof(bits));
  return bits;
}

// The variation design position of a typeface, as a hash.
uint64_t VariationHash(SkTypeface* face) {
  const int count = face->getVariationDesignPosition({});
  if (count <= 0) {
    return 0;
  }
  std::vector<SkFontArguments::VariationPosition::Coordinate> coordinates(
      count);
  if (face->getVariationDesignPosition(coordinates) != count) {
    return 0;
  }
  uint64_t hash = 0;
  for (const auto& coordinate : coordinates) {
    hash = hash * 1000003 + coordinate.axis;
    hash = hash * 1000003 + FloatBits(coordinate.value);
  }
  return hash;
}
#endif

// The fonts of one line: Blink's FontFallbackList (the family entries),
// the last resort font, and the system fallback fonts the line asked for.
// Entries live in deques, so the runs' pointers to them stay valid.
class LineFonts {
 public:
  LineFonts(skiac_font_collection* c_collection,
            const skiac_text_request& request,
            const TextRasterPolicy& policy,
            const UsedSizes& sizes)
      : c_collection_(c_collection),
        request_(request),
        policy_(policy),
        sizes_(sizes) {
    policy_.ApplyToTextStyle(&flags_);
  }

  // Fills `entry`'s fonts: the shaping font OneLineShaper builds, the draw
  // font with the synthetic styles, and the HarfBuzz font. False when the
  // typeface has no data.
  bool Finish(FontEntry* entry) const {
    SkFont font(entry->face, entry->size);
    font.setEdging(flags_.getFontEdging());
    font.setHinting(flags_.getFontHinting());
    font.setSubpixel(flags_.getSubpixel());
    font.setEmbolden(entry->synthetic.bold);
    font.setSkewX(entry->synthetic.italic ? -SK_Scalar1 / 4 : 0);
    entry->shaping_font = font;
    entry->draw_font = policy_.DrawFont(font, nullptr);
    entry->space_glyph = HbNominalGlyph(c_collection_, entry->face.get(), 0x20);
    return MakeEntryFont(c_collection_, entry);
  }

  // A family entry (Blink's SimpleFontData of a font-family font).
  bool AddFamily(sk_sp<SkTypeface> face, SkTypeface* base) {
    FontEntry entry;
    entry.face = std::move(face);
    entry.base = base;
    entry.size = sizes_.effective;
    entry.opsz = sizes_.opsz;
    entry.synthetic =
        SynthesizeStyle(c_collection_, entry.face.get(), base, request_);
    if (!Finish(&entry)) {
      return false;
    }
    families_.push_back(std::move(entry));
    return true;
  }

  std::deque<FontEntry>& families() { return families_; }

  // SimpleFontData::SmallCapsFontData: `font` at the synthesized small caps
  // size (CreateScaledFontData: the computed size, without
  // font-size-adjust, times 0.7, rounded), with its face, opsz and synthetic
  // styles; made once per font of the line.
  FontEntry* SmallCaps(FontEntry* font) {
    auto [found, made] = small_caps_index_.try_emplace(font, font);
    if (made) {
      FontEntry entry;
      entry.face = font->face;
      entry.base = font->base;
      entry.size = SmallCapsSize(request_.size);
      entry.opsz = font->opsz;
      entry.synthetic = font->synthetic;
      entry.small_caps = true;
      if (Finish(&entry)) {
        small_caps_.push_back(std::move(entry));
        found->second = &small_caps_.back();
      }
    }
    return found->second;
  }

  // Whether this host has a system fallback source the shaper ports: the
  // CoreText one, with the system renderer once the installed fonts are on.
  void set_system_source(bool system_source) { system_source_ = system_source; }
  bool system_source() const { return system_source_; }

  // The standard font of the lang's script where it is not the family
  // list's own (LocaleStandardFamily), found before the layout takes any
  // reference into the caches.
  void set_locale_standard(sk_sp<SkTypeface> face) {
    locale_standard_ = std::move(face);
  }
  SkTypeface* locale_standard() const { return locale_standard_.get(); }

  // FontCache::GetLastResortFallbackFont through the family matching, found
  // before the layout takes any reference into the caches.
  void set_last_resort(sk_sp<SkTypeface> face, SkTypeface* base) {
    last_resort_face_ = std::move(face);
    last_resort_base_ = base;
  }

  FontEntry* LastResort() {
    if (!last_resort_made_) {
      last_resort_made_ = true;
      if (last_resort_face_) {
        FontEntry entry;
        entry.face = last_resort_face_;
        entry.base = last_resort_base_;
        entry.size = sizes_.effective;
        entry.opsz = sizes_.opsz;
        entry.synthetic = SynthesizeStyle(c_collection_, entry.face.get(),
                                          last_resort_base_, request_);
        if (Finish(&entry)) {
          others_.push_back(std::move(entry));
          last_resort_ = &others_.back();
        }
      }
    }
    return last_resort_;
  }

  // FontCache::FallbackFontForCharacter: none for a private use or
  // non-character; on Apple, Apple Color Emoji for emoji presentation, else
  // the CoreText helper from the primary font (the font list's first font,
  // FontFallbackList::PrimarySimpleFontDataWithSpace).
  FontEntry* SystemFallback(uint32_t hint, Priority priority) {
    if (!system_source_ || IsPrivateUseOrNonCharacter(hint)) {
      return nullptr;
    }
#if defined(__APPLE__)
    const FontEntry& primary = families_.front();
    const bool emoji = IsEmojiPresentationEmoji(priority);
    const bool italic = request_.slope != 0;
    // The primary font by its family face and its axes, not by the
    // instance's typeface ID: a dropped and remade instance (the font
    // arguments' caches) is the same font, and a new CTFont per line would
    // grow CoreText's per-font fallback tables.
    const SystemFallbackKey key = {
        hint, emoji,
        primary.base ? primary.base->uniqueID() : primary.face->uniqueID(),
        VariationHash(primary.face.get()), FloatBits(request_.weight),
        FloatBits(request_.slope),
        // FontDescription::ComputedPixelSize.
        static_cast<int>(request_.size + 0.5f)};
    SystemFallbackFont font;
    if (const SystemFallbackFont* found =
            FindSystemFallback(c_collection_, key)) {
      font = *found;
    } else {
      if (emoji && c_collection_->font_mgr) {
        const SkFontStyle style(
            static_cast<int>(roundf(request_.weight)), request_.stretch,
            static_cast<SkFontStyle::Slant>(request_.style));
        font.face = c_collection_->font_mgr->matchFamilyStyle(
            "Apple Color Emoji", style);
        if (font.face) {
          font.synthetic =
              MacMatchedFontSynthetic(font.face.get(), request_.weight, italic);
        }
      }
      if (!font.face) {
        font = MacAlternateFont(
            primary.face.get(), SystemFallbackInputs(c_collection_), key,
            primary.synthetic, hint, static_cast<int>(request_.weight), italic,
            static_cast<float>(key.pixel_size));
      }
      StoreSystemFallback(c_collection_, key, font);
    }
    if (!font.face) {
      return nullptr;
    }
    // FontPlatformDataFromCTFont(..., EffectiveFontSize, SpecifiedSize, ...,
    // no variation settings): opsz at the specified size, no request axes.
    sk_sp<SkTypeface> face =
        request_.optical_sizing == 0
            ? SystemFallbackInstance(c_collection_, font.face, request_.size)
            : font.face;
    for (FontEntry& entry : others_) {
      if (!entry.base && entry.face->uniqueID() == face->uniqueID() &&
          entry.synthetic.bold == font.synthetic.bold &&
          entry.synthetic.italic == font.synthetic.italic) {
        return &entry;
      }
    }
    FontEntry entry;
    entry.face = std::move(face);
    entry.size = sizes_.effective;
    entry.opsz = request_.size;
    entry.synthetic = font.synthetic;
    if (!Finish(&entry)) {
      return nullptr;
    }
    others_.push_back(std::move(entry));
    return &others_.back();
#else
    (void)priority;
    return nullptr;
#endif
  }

 private:
  skiac_font_collection* c_collection_;
  const skiac_text_request& request_;
  const TextRasterPolicy& policy_;
  const UsedSizes& sizes_;
  TextStyle flags_;
  std::deque<FontEntry> families_;
  std::deque<FontEntry> others_;
  // The small caps copies, by the font they copy.
  std::deque<FontEntry> small_caps_;
  std::unordered_map<const FontEntry*, FontEntry*> small_caps_index_;
  bool system_source_ = false;
  sk_sp<SkTypeface> locale_standard_;
  sk_sp<SkTypeface> last_resort_face_;
  SkTypeface* last_resort_base_ = nullptr;
  bool last_resort_made_ = false;
  FontEntry* last_resort_ = nullptr;
};

// FontFallbackIterator (font_fallback_iterator.cc) over a LineFonts: the
// family entries, each typeface once (UniqueOrNext); for an emoji or symbol
// segment one font for the first hint with the segment's priority; one
// system font per call for the hint ChooseHintIndex picks, each hint asked
// once; the last resort font; the first candidate, whose .notdef is drawn.
// Without a system source (off Apple) the iterator stops after the family
// entries and the request is turned down.
class FallbackIterator {
 public:
  FallbackIterator(LineFonts& fonts, Priority priority)
      : fonts_(fonts), priority_(priority) {}

  bool HasNext() const { return stage_ != Stage::kOutOfLuck; }
  bool needs_system_source() const { return needs_system_source_; }
  // Next stopped after the family entries, before the system fonts, for the
  // caller to tell whether the lang's standard font has a character still to
  // shape; the next call goes on to the system fonts.
  bool at_locale_standard() const { return at_locale_standard_; }

  void Reset() {
    index_ = 0;
    stage_ = Stage::kFontGroupFonts;
    locale_standard_asked_ = false;
    asked_.clear();
    returned_.clear();
    first_candidate_ = nullptr;
  }

  FontEntry* Next(const std::vector<uint32_t>& hints) {
    at_locale_standard_ = false;
    switch (stage_) {
      case Stage::kOutOfLuck:
        return nullptr;
      case Stage::kFallbackPriorityFonts:
        stage_ = Stage::kSystemFonts;
        if (FontEntry* font = fonts_.SystemFallback(hints[0], priority_)) {
          return UniqueOrNext(font, hints);
        }
        return Next(hints);
      case Stage::kSystemFonts:
        if (FontEntry* font = UniqueSystemFontForHintList(hints)) {
          return UniqueOrNext(font, hints);
        }
        stage_ = Stage::kFirstCandidateForNotdefGlyph;
        return UniqueOrNext(fonts_.LastResort(), hints);
      case Stage::kFirstCandidateForNotdefGlyph:
        stage_ = Stage::kOutOfLuck;
        return first_candidate_;
      case Stage::kFontGroupFonts:
        break;
    }
    std::deque<FontEntry>& families = fonts_.families();
    if (index_ >= families.size()) {
      if (!fonts_.system_source()) {
        needs_system_source_ = true;
        return nullptr;
      }
      // FontFallbackList::GetFontData: Chrome's last family is the standard
      // font, unless a family entry already gave it.
      if (SkTypeface* standard = fonts_.locale_standard();
          standard && !locale_standard_asked_) {
        locale_standard_asked_ = true;
        if (!returned_.count(standard->uniqueID())) {
          at_locale_standard_ = true;
          return nullptr;
        }
      }
      stage_ = IsNonTextFallbackPriority(priority_)
                   ? Stage::kFallbackPriorityFonts
                   : Stage::kSystemFonts;
      return Next(hints);
    }
    return UniqueOrNext(&families[index_++], hints);
  }

 private:
  enum class Stage {
    kFontGroupFonts,
    kFallbackPriorityFonts,
    kSystemFonts,
    kFirstCandidateForNotdefGlyph,
    kOutOfLuck,
  };

  FontEntry* UniqueOrNext(FontEntry* candidate,
                          const std::vector<uint32_t>& hints) {
    if (!candidate) {
      return Next(hints);
    }
    if (!returned_.insert(candidate->face->uniqueID()).second) {
      return Next(hints);
    }
    if (!first_candidate_) {
      first_candidate_ = candidate;
    }
    return candidate;
  }

  // ChooseHintIndex: with more than one hint, the first after the first
  // with a likely script.
  static size_t ChooseHintIndex(const std::vector<uint32_t>& hints) {
    if (hints.size() <= 1) {
      return 0;
    }
    for (size_t i = 1; i < hints.size(); ++i) {
      if (HasLikelyScript(hints[i])) {
        return i;
      }
    }
    return 0;
  }

  FontEntry* UniqueSystemFontForHintList(const std::vector<uint32_t>& hints) {
    if (hints.empty()) {
      return nullptr;
    }
    const uint32_t hint = hints[ChooseHintIndex(hints)];
    if (!hint || !asked_.insert(hint).second) {
      return nullptr;
    }
    return fonts_.SystemFallback(hint, Priority::kText);
  }

  LineFonts& fonts_;
  const Priority priority_;
  Stage stage_ = Stage::kFontGroupFonts;
  size_t index_ = 0;
  std::unordered_set<uint32_t> asked_;
  std::unordered_set<SkTypefaceID> returned_;
  FontEntry* first_candidate_ = nullptr;
  bool needs_system_source_ = false;
  bool locale_standard_asked_ = false;
  bool at_locale_standard_ = false;
};

enum class QueueAction { kNextFont, kRange, kReset };

struct QueueItem {
  QueueAction action;
  uint32_t start;
  uint32_t num_characters;
};

struct BufferSlice {
  uint32_t start_character_index;
  uint32_t num_characters;
  uint32_t start_glyph_index;
  uint32_t num_glyphs;
};

// HarfBuzzShaper for one item (RangeContext over the whole item).
class ItemShaper {
 public:
  ItemShaper(const char16_t* text,
             uint32_t length,
             bool rtl,
             hb_buffer_t* buffer,
             const std::vector<hb_feature_t>& features,
             hb_language_t language,
             skiac_font_collection* c_collection,
             int variant_caps,
             const char* case_map_locale,
             LineFonts& fonts,
             ShapeResult* result)
      : text_(text),
        length_(length),
        rtl_(rtl),
        buffer_(buffer),
        features_(features),
        language_(language),
        c_collection_(c_collection),
        variant_caps_(variant_caps),
        case_map_locale_(case_map_locale),
        fonts_(fonts),
        result_(result) {}

  // HarfBuzzShaper::ShapeSegment. False when a character no family font
  // has needs a system fallback font this host has no source for
  // (ShaperReject::kFallback), or one the lang's standard font has, which
  // the family list does not have yet (kLocaleFallback): reject_reason().
  bool ShapeSegment(const Segment& segment) {
    FallbackIterator iterator(fonts_, segment.priority);
    queue_.clear();
    queue_.push_back({QueueAction::kNextFont, 0, 0});
    queue_.push_back(
        {QueueAction::kRange, segment.start, segment.end - segment.start});
    FontEntry* font = nullptr;
    bool font_cycle_queued = false;
    stage_ = FallbackStage::kIntermediate;
    // The canvas's font-variant-emoji is normal.
    VariationSelectorMode mode = VariationSelectorMode::kUseSpecified;
    while (!queue_.empty()) {
      QueueItem current = queue_.front();
      queue_.pop_front();
      if (current.action != QueueAction::kRange) {
        if (current.action == QueueAction::kReset) {
          // The last font left variation sequences unshaped whose base
          // characters a font has: shape them again from the first font,
          // ignoring the selectors.
          iterator.Reset();
          stage_ = FallbackStage::kIntermediateIgnoreVS;
          mode = VariationSelectorMode::kIgnore;
        }
        if (!CollectFallbackHintChars()) {
          queue_.clear();
          break;
        }
        font = iterator.Next(hints_);
        if (iterator.needs_system_source()) {
          reject_reason_ = ShaperReject::kFallback;
          return false;
        }
        if (iterator.at_locale_standard()) {
          if (QueuedRangesHaveGlyphs(fonts_.locale_standard())) {
            reject_reason_ = ShaperReject::kLocaleFallback;
            return false;
          }
          font = iterator.Next(hints_);
        }
        if (!font) {
          break;
        }
        font_cycle_queued = false;
        continue;
      }
      if (!iterator.HasNext()) {
        stage_ = ChangeStageToLast(stage_);
      }
      // font-variant-caps for this font: its own caps features for the
      // segment's script, or synthesized small caps from it, each case run
      // shaped on its own (the rest of the range goes back to the queue's
      // front for the same font).
      CapsSupport caps_support;
      CaseRun case_run = CaseRun::kSameCase;
      if (variant_caps_) {
        caps_support =
            FontCapsSupport(c_collection_, font->face.get(), variant_caps_,
                            IcuScriptToHbScript(segment.script));
        if (NeedsRunCaseSplitting(caps_support, variant_caps_)) {
          SplitUntilNextCaseChange(&current, &case_run);
        }
      }
      const uint32_t shape_start = current.start;
      const uint32_t shape_end =
          std::min(length_, current.start + current.num_characters);
      FontEntry* adjusted_font = font;
      CaseMapIntend case_map_intend = CaseMapIntend::kKeepSameCase;
      if (variant_caps_) {
        case_map_intend = NeedsCaseChange(caps_support, case_run);
        if (NeedsSyntheticFont(caps_support, variant_caps_, case_run)) {
          adjusted_font = fonts_.SmallCaps(font);
        }
      }
      FillBuffer(case_map_intend, shape_start, shape_end - shape_start);
      hb_buffer_set_language(buffer_, language_);
      hb_buffer_set_script(buffer_, IcuScriptToHbScript(segment.script));
      hb_buffer_set_direction(buffer_,
                              rtl_ ? HB_DIRECTION_RTL : HB_DIRECTION_LTR);
      SetVariationSelectorMode(adjusted_font, mode);
      const int caps_feature =
          CapsFeatureToUse(caps_support, variant_caps_, case_run);
      const std::vector<hb_feature_t>* features = &features_;
      if (caps_feature) {
        caps_features_ = features_;
        PrependCapsFeatures(&caps_features_, caps_feature);
        features = &caps_features_;
      }
      hb_shape_full(adjusted_font->hb.get(), buffer_, features->data(),
                    static_cast<unsigned int>(features->size()), kOtShaperList);
      if (!adjusted_font->draw_font.isSubpixel()) {
        RoundBufferPositions();
      }
      ExtractShapeResults(current, adjusted_font, segment.script,
                          &font_cycle_queued);
      hb_buffer_reset(buffer_);
    }
    return true;
  }

  ShaperReject reject_reason() const { return reject_reason_; }

 private:
  // HarfBuzzShaper::FallbackFontStage.
  enum class FallbackStage {
    kIntermediate,
    kIntermediateWithVS,
    kIntermediateIgnoreVS,
    kLast,
    kLastWithVS,
    kLastIgnoreVS,
  };

  bool IsLastFontToShape() const {
    return stage_ == FallbackStage::kLast ||
           stage_ == FallbackStage::kLastIgnoreVS;
  }

  static FallbackStage ChangeStageToLast(FallbackStage stage) {
    switch (stage) {
      case FallbackStage::kIntermediate:
        return FallbackStage::kLast;
      case FallbackStage::kIntermediateWithVS:
        return FallbackStage::kLastWithVS;
      case FallbackStage::kIntermediateIgnoreVS:
        return FallbackStage::kLastIgnoreVS;
      default:
        return stage;
    }
  }

  // ChangeStageToVS; the second pass ignores the selectors, so it never
  // sees kUnmatchedVSGlyphId.
  static FallbackStage ChangeStageToVS(FallbackStage stage) {
    switch (stage) {
      case FallbackStage::kIntermediate:
        return FallbackStage::kIntermediateWithVS;
      case FallbackStage::kLast:
        return FallbackStage::kLastWithVS;
      default:
        return stage;
    }
  }

  // CollectFallbackHintChars without a hint list (no font is segmented by
  // unicode-range here): the code points of the queued ranges before the
  // next font, up to the first that is not Common or Inherited.
  bool CollectFallbackHintChars() {
    if (queue_.empty()) {
      return false;
    }
    hints_.clear();
    for (const QueueItem& item : queue_) {
      if (item.action != QueueAction::kRange) {
        break;
      }
      const uint32_t end = std::min(length_, item.start + item.num_characters);
      for (uint32_t i = item.start; i < end;) {
        uint32_t c = text_[i++];
        if (c >= 0xD800 && c <= 0xDBFF && i < end && text_[i] >= 0xDC00 &&
            text_[i] <= 0xDFFF) {
          c = 0x10000 + ((c - 0xD800) << 10) + (text_[i++] - 0xDC00);
        }
        hints_.push_back(c);
        if (!IsCommonOrInheritedScript(c)) {
          return true;
        }
      }
    }
    return !hints_.empty();
  }

  // Whether `face` has a glyph for a code point of the ranges queued for the
  // next font.
  bool QueuedRangesHaveGlyphs(SkTypeface* face) const {
    for (const QueueItem& item : queue_) {
      if (item.action != QueueAction::kRange) {
        break;
      }
      const uint32_t end = std::min(length_, item.start + item.num_characters);
      for (uint32_t i = item.start; i < end;) {
        uint32_t c = text_[i++];
        if (c >= 0xD800 && c <= 0xDBFF && i < end && text_[i] >= 0xDC00 &&
            text_[i] <= 0xDFFF) {
          c = 0x10000 + ((c - 0xD800) << 10) + (text_[i++] - 0xDC00);
        }
        if (face->unicharToGlyph(static_cast<SkUnichar>(c))) {
          return true;
        }
      }
    }
    return false;
  }

  // SplitUntilNextCaseChange: `current` ends at its first case change
  // (SmallCapsIterator), and the rest goes to the front of the queue.
  void SplitUntilNextCaseChange(QueueItem* current, CaseRun* case_run) {
    const uint32_t end =
        std::min(length_, current->start + current->num_characters);
    const uint32_t until =
        NextCaseRun(text_ + current->start, end - current->start, case_run);
    if (until > 0 && until < current->num_characters) {
      queue_.push_front({QueueAction::kRange, current->start + until,
                         current->num_characters - until});
      current->num_characters = until;
    }
  }

  // The item upper or lower cased (CaseMap of the lang), made once per item.
  const std::u16string& CaseMapped(CaseMapIntend intend) {
    std::optional<std::u16string>& mapped =
        intend == CaseMapIntend::kUpperCase ? upper_ : lower_;
    if (!mapped) {
      mapped = MapCase(intend, case_map_locale_,
                       std::u16string(text_, text_ + length_));
    }
    return *mapped;
  }

  // CaseMappingHarfBuzzBufferFiller: [start, start + count) of the item,
  // with the whole item as context. Case mapped, the item's mapping when it
  // keeps the length; else each character mapped on its own, all of its
  // mapping at its own index (FillSlowCase), with the unmapped item as
  // context. The clusters stay item indices.
  void FillBuffer(CaseMapIntend intend, uint32_t start, uint32_t count) {
    const auto* text = reinterpret_cast<const uint16_t*>(text_);
    if (intend == CaseMapIntend::kKeepSameCase) {
      hb_buffer_add_utf16(buffer_, text, static_cast<int>(length_), start,
                          static_cast<int>(count));
      return;
    }
    const std::u16string& mapped = CaseMapped(intend);
    if (mapped.size() == length_) {
      hb_buffer_add_utf16(
          buffer_, reinterpret_cast<const uint16_t*>(mapped.data()),
          static_cast<int>(length_), start, static_cast<int>(count));
      return;
    }
    hb_buffer_add_utf16(buffer_, text, static_cast<int>(length_), start, 0);
    for (uint32_t i = start; i < start + count;) {
      uint32_t next = i + 1;
      if (text_[i] >= 0xD800 && text_[i] <= 0xDBFF && next < length_ &&
          text_[next] >= 0xDC00 && text_[next] <= 0xDFFF) {
        ++next;
      }
      const std::u16string one = MapCase(
          intend, case_map_locale_, std::u16string(text_ + i, text_ + next));
      for (size_t j = 0; j < one.size();) {
        uint32_t c = one[j++];
        if (c >= 0xD800 && c <= 0xDBFF && j < one.size() && one[j] >= 0xDC00 &&
            one[j] <= 0xDFFF) {
          c = 0x10000 + ((c - 0xD800) << 10) + (one[j++] - 0xDC00);
        }
        hb_buffer_add(buffer_, c, i);
      }
      i = next;
    }
    hb_buffer_add_utf16(buffer_, text, static_cast<int>(length_), start + count,
                        0);
  }

  // RoundHarfBuzzBufferPositions.
  void RoundBufferPositions() {
    unsigned int length = 0;
    hb_glyph_position_t* positions =
        hb_buffer_get_glyph_positions(buffer_, &length);
    auto round = [](hb_position_t* value) {
      if (*value & 0xFFFF) {
        *value = static_cast<hb_position_t>(
                     ::round(static_cast<float>(*value) / (1 << 16)))
                 << 16;
      }
    };
    for (unsigned int i = 0; i < length; ++i) {
      round(&positions[i].x_offset);
      round(&positions[i].y_offset);
      round(&positions[i].x_advance);
      round(&positions[i].y_advance);
    }
  }

  BufferSlice ComputeSlice(const QueueItem& current,
                           const hb_glyph_info_t* glyph_info,
                           uint32_t num_glyphs,
                           uint32_t old_glyph_index,
                           uint32_t new_glyph_index) const {
    BufferSlice result;
    result.start_glyph_index = old_glyph_index;
    result.num_glyphs = new_glyph_index - old_glyph_index;
    const uint32_t shape_end =
        std::min(length_, current.start + current.num_characters);
    if (!rtl_) {
      result.start_character_index = glyph_info[old_glyph_index].cluster;
      if (new_glyph_index == num_glyphs) {
        result.num_characters = shape_end - result.start_character_index;
      } else {
        result.num_characters =
            glyph_info[new_glyph_index].cluster - result.start_character_index;
      }
    } else {
      result.start_character_index = glyph_info[new_glyph_index - 1].cluster;
      if (old_glyph_index == 0) {
        result.num_characters = shape_end - result.start_character_index;
      } else {
        result.num_characters = glyph_info[old_glyph_index - 1].cluster -
                                glyph_info[new_glyph_index - 1].cluster;
      }
    }
    return result;
  }

  void QueueCharacters(bool* font_cycle_queued, const BufferSlice& slice) {
    if (!*font_cycle_queued) {
      queue_.push_back({stage_ == FallbackStage::kLastWithVS
                            ? QueueAction::kReset
                            : QueueAction::kNextFont,
                        0, 0});
      *font_cycle_queued = true;
    }
    queue_.push_back({QueueAction::kRange, slice.start_character_index,
                      slice.num_characters});
  }

  // ShapeResult::InsertRun (LimitNumGlyphs, ComputeGlyphPositions, the
  // visual order of the runs). Returns the glyph after the run.
  uint32_t InsertRun(ShapedRun run,
                     uint32_t start_glyph,
                     uint32_t num_glyphs,
                     const hb_glyph_info_t* infos,
                     const hb_glyph_position_t* positions,
                     uint32_t* run_characters) {
    // LimitNumGlyphs: every character index must fit in 15 bits.
    const hb_glyph_info_t* left = &infos[start_glyph];
    const hb_glyph_info_t* right = &left[num_glyphs - 1];
    if (!rtl_) {
      const uint32_t start_cluster = left->cluster;
      const uint32_t max_cluster = start_cluster + kMaxCharacterIndex;
      if (right->cluster > max_cluster) {
        const hb_glyph_info_t* limit =
            std::upper_bound(left, right + 1, max_cluster,
                             [](uint32_t cluster, const hb_glyph_info_t& info) {
                               return cluster < info.cluster;
                             });
        --limit;
        right = limit;
        num_glyphs = static_cast<uint32_t>(right - left + 1);
        run.num_characters = right[1].cluster - start_cluster;
      }
    } else {
      const uint32_t start_cluster = right->cluster;
      const uint32_t last_cluster = left->cluster;
      if (last_cluster > start_cluster + kMaxCharacterIndex) {
        const uint32_t min_cluster = last_cluster - kMaxCharacterIndex;
        const hb_glyph_info_t* limit =
            std::upper_bound(left, right + 1, min_cluster,
                             [](uint32_t cluster, const hb_glyph_info_t& info) {
                               return cluster > info.cluster;
                             });
        --limit;
        right = limit;
        num_glyphs = static_cast<uint32_t>(right - left + 1);
        run.start = right->cluster;
        run.num_characters = last_cluster - right[1].cluster;
      }
    }
    // LimitNumGlyphs, then at most kMaxGlyphs glyphs, cut at the last
    // cluster boundary before it (or at kMaxGlyphs, the rest of that
    // cluster dropped, when the first cluster alone is longer).
    uint32_t num_glyphs_removed = 0;
    if (num_glyphs > kMaxGlyphs) {
      const uint32_t old_num_glyphs = num_glyphs;
      num_glyphs = kMaxGlyphs;
      const uint32_t end_cluster = infos[start_glyph + num_glyphs].cluster;
      for (; num_glyphs; --num_glyphs) {
        if (infos[start_glyph + num_glyphs - 1].cluster != end_cluster) {
          break;
        }
      }
      if (!num_glyphs) {
        num_glyphs = kMaxGlyphs;
        num_glyphs_removed = old_num_glyphs - num_glyphs;
      } else if (!rtl_) {
        run.num_characters = end_cluster - infos[start_glyph].cluster;
      } else {
        run.num_characters = infos[start_glyph].cluster - end_cluster;
        run.start = infos[start_glyph + num_glyphs - 1].cluster;
      }
    }
    // ComputeGlyphPositions.
    int64_t total_advance = 0;
    run.glyphs.resize(num_glyphs);
    for (uint32_t i = 0; i < num_glyphs; ++i) {
      const hb_glyph_info_t& info = infos[start_glyph + i];
      const hb_glyph_position_t& pos = positions[start_glyph + i];
      ShapedGlyph& glyph = run.glyphs[i];
      glyph.glyph = static_cast<SkGlyphID>(info.codepoint);
      glyph.character_index = info.cluster - run.start;
      glyph.advance = pos.x_advance;
      glyph.x_offset = 0;
      glyph.y_offset = 0;
      if (pos.x_offset || pos.y_offset) {
        glyph.x_offset = static_cast<float>(pos.x_offset) / (1 << 16);
        glyph.y_offset = -(static_cast<float>(pos.y_offset) / (1 << 16));
        run.has_offsets = true;
        run.has_vertical_offsets = run.has_vertical_offsets || pos.y_offset;
      }
      total_advance += pos.x_advance;
    }
    run.width =
        static_cast<float>(std::max<int64_t>(total_advance, 0)) / (1 << 16);
    result_->width += run.width;
    *run_characters = run.num_characters;
    // ShapeResult::InsertRun(run): LTR before the next run with a bigger
    // start, RTL before the next run with a smaller one.
    auto at = std::lower_bound(
        result_->runs.begin(), result_->runs.end(), run.start,
        [this](const ShapedRun& existing, uint32_t start) {
          return rtl_ ? existing.start > start : existing.start < start;
        });
    result_->runs.insert(at, std::move(run));
    return start_glyph + num_glyphs + num_glyphs_removed;
  }

  void CommitGlyphs(const FontEntry* font,
                    int script,
                    const BufferSlice& slice) {
    const hb_glyph_info_t* infos = hb_buffer_get_glyph_infos(buffer_, nullptr);
    const hb_glyph_position_t* positions =
        hb_buffer_get_glyph_positions(buffer_, nullptr);
    BufferSlice current = slice;
    uint32_t run_start_index = slice.start_character_index;
    for (;;) {
      ShapedRun run;
      run.font = font;
      run.script = script;
      run.rtl = rtl_;
      run.start = run_start_index;
      run.num_characters = current.num_characters;
      uint32_t run_characters = 0;
      const uint32_t next_start_glyph =
          InsertRun(std::move(run), current.start_glyph_index,
                    current.num_glyphs, infos, positions, &run_characters);
      const uint32_t next_num_glyphs =
          current.num_glyphs - (next_start_glyph - current.start_glyph_index);
      if (!next_num_glyphs) {
        break;
      }
      // The rest of the slice goes in another run.
      current = {current.start_character_index + run_characters,
                 current.num_characters - run_characters, next_start_glyph,
                 next_num_glyphs};
      if (!rtl_) {
        run_start_index = current.start_character_index;
      }
    }
  }

  void ExtractShapeResults(const QueueItem& current,
                           const FontEntry* font,
                           int script,
                           bool* font_cycle_queued) {
    const uint32_t num_glyphs = hb_buffer_get_length(buffer_);
    const hb_glyph_info_t* glyph_info =
        hb_buffer_get_glyph_infos(buffer_, nullptr);
    if (!num_glyphs) {
      return;
    }
    enum ClusterResult { kShaped, kNotDef, kUnknown };
    ClusterResult current_cluster_result = kUnknown;
    ClusterResult previous_cluster_result = kUnknown;
    uint32_t previous_cluster = 0;
    uint32_t current_cluster = 0;
    uint32_t last_change_glyph_index = 0;
    uint32_t previous_cluster_start_glyph_index = 0;
    const SkGlyphID space_glyph = font->space_glyph;
    for (uint32_t glyph_index = 0; glyph_index < num_glyphs; ++glyph_index) {
      const hb_glyph_info_t& glyph = glyph_info[glyph_index];
      previous_cluster = current_cluster;
      current_cluster = glyph.cluster;
      const hb_codepoint_t glyph_id = glyph.codepoint;
      ClusterResult glyph_result;
      if (glyph_id == 0) {
        glyph_result = kNotDef;
      } else if (glyph_id == space_glyph && !IsLastFontToShape() &&
                 text_[current_cluster] == 0x3000) {
        // HarfBuzz draws U+3000 with the space glyph; Blink tries the next
        // font for it (crbug.com/1193282).
        glyph_result = kNotDef;
      } else if (glyph_id == kUnmatchedVSGlyphId) {
        stage_ = ChangeStageToVS(stage_);
        glyph_result = kNotDef;
      } else {
        glyph_result = kShaped;
      }
      if (current_cluster != previous_cluster) {
        if (previous_cluster_result != current_cluster_result &&
            previous_cluster_result != kUnknown) {
          const BufferSlice slice = ComputeSlice(
              current, glyph_info, num_glyphs, last_change_glyph_index,
              previous_cluster_start_glyph_index);
          if (current_cluster_result == kShaped && !IsLastFontToShape()) {
            QueueCharacters(font_cycle_queued, slice);
          } else {
            CommitGlyphs(font, script, slice);
          }
          last_change_glyph_index = previous_cluster_start_glyph_index;
        }
        previous_cluster_result = current_cluster_result;
        previous_cluster_start_glyph_index = glyph_index;
        current_cluster_result = glyph_result;
      } else {
        current_cluster_result =
            glyph_result == kShaped && (current_cluster_result == kShaped ||
                                        current_cluster_result == kUnknown)
                ? kShaped
                : kNotDef;
      }
    }
    if (current_cluster_result != previous_cluster_result &&
        previous_cluster_result != kUnknown && !IsLastFontToShape()) {
      if (current_cluster_result == kShaped) {
        QueueCharacters(font_cycle_queued,
                        ComputeSlice(current, glyph_info, num_glyphs,
                                     last_change_glyph_index,
                                     previous_cluster_start_glyph_index));
        CommitGlyphs(
            font, script,
            ComputeSlice(current, glyph_info, num_glyphs,
                         previous_cluster_start_glyph_index, num_glyphs));
      } else {
        CommitGlyphs(font, script,
                     ComputeSlice(current, glyph_info, num_glyphs,
                                  last_change_glyph_index,
                                  previous_cluster_start_glyph_index));
        QueueCharacters(
            font_cycle_queued,
            ComputeSlice(current, glyph_info, num_glyphs,
                         previous_cluster_start_glyph_index, num_glyphs));
      }
    } else {
      const BufferSlice slice = ComputeSlice(
          current, glyph_info, num_glyphs, last_change_glyph_index, num_glyphs);
      if (current_cluster_result == kNotDef && !IsLastFontToShape()) {
        QueueCharacters(font_cycle_queued, slice);
      } else {
        CommitGlyphs(font, script, slice);
      }
    }
  }

  const char16_t* text_;
  const uint32_t length_;
  const bool rtl_;
  hb_buffer_t* buffer_;
  const std::vector<hb_feature_t>& features_;
  hb_language_t language_;
  skiac_font_collection* c_collection_;
  const int variant_caps_;
  const char* case_map_locale_;
  LineFonts& fonts_;
  ShapeResult* result_;
  // The features with the caps ones in front, for a range that has them.
  std::vector<hb_feature_t> caps_features_;
  std::optional<std::u16string> upper_;
  std::optional<std::u16string> lower_;
  std::deque<QueueItem> queue_;
  std::vector<uint32_t> hints_;
  FallbackStage stage_ = FallbackStage::kIntermediate;
  ShaperReject reject_reason_ = ShaperReject::kFallback;
};

// The HarfBuzz language of ctx.lang: "und" for none ("" or "inherit"; the
// host language comes with stage S8), as skshaper does for none.
hb_language_t ShapingLanguage(const skiac_text_request& request) {
  static const hb_language_t und = hb_language_from_string("und", -1);
  const std::string_view lang(request.lang ? request.lang : "",
                              request.lang ? request.lang_len : 0);
  if (lang.empty() || lang == "inherit") {
    return und;
  }
  const hb_language_t language =
      hb_language_from_string(lang.data(), static_cast<int>(lang.size()));
  return language == HB_LANGUAGE_INVALID ? und : language;
}

}  // namespace

void NoteTextCachesChange() {
  g_text_caches_changes.fetch_add(1, std::memory_order_relaxed);
}

bool BlinkShaperOn() {
  static const bool on = [] {
    const char* value = getenv("NAPI_RS_CANVAS_SHAPER");
    return value && strcmp(value, "blink") == 0;
  }();
  return on;
}

bool LayOutLineBlink(skiac_font_collection* c_collection,
                     const skiac_text_request& request,
                     TextCaches::Line* line) {
  auto font_collection = c_collection->collection;
  const SkFontStyle font_style(static_cast<int>(roundf(request.weight)),
                               request.stretch,
                               static_cast<SkFontStyle::Slant>(request.style));
  // The FontList, with every noteFontArguments call, before any reference
  // into the caches is taken. The families are copied: the cache entry is
  // a reference into TextCaches.
  const std::vector<SkString> families =
      CachedFontFamilies(c_collection, request);
  const std::vector<sk_sp<SkTypeface>> base_faces =
      font_collection->findTypefaces(families, font_style);
  const UsedSizes sizes = ComputeUsedSizes(c_collection, base_faces, request);
  if (!sizes.faces.empty()) {
    return Reject(ShaperReject::kFaceSizes);
  }
  const std::vector<SkFontArguments::VariationPosition::Coordinate> coords =
      FontVariations(base_faces, request, sizes.opsz);
  std::optional<FontArguments> font_args;
  if (!coords.empty()) {
    SkFontArguments args;
    args.setVariationDesignPosition(
        {coords.data(), static_cast<int>(coords.size())});
    font_args.emplace(args);
    c_collection->noteFontArguments(std::hash<FontArguments>()(*font_args));
  }
  const std::vector<sk_sp<SkTypeface>> faces =
      coords.empty()
          ? base_faces
          : font_collection->findTypefaces(families, font_style, font_args);

  TextCaches::Line scratch;
  SkTypeface* primary = faces.empty() ? nullptr : faces.front().get();
  SkTypeface* primary_base =
      base_faces.empty() ? nullptr : base_faces.front().get();
  scratch.primary =
      CachedPrimaryFont(c_collection, primary, primary_base, sizes.effective);
  if (request.text_len == 0 ||
      (request.size_adjust_metric >= 0 && !(sizes.effective > 0))) {
    scratch.empty = true;
    *line = std::move(scratch);
    g_accepted.fetch_add(1, std::memory_order_relaxed);
    return true;
  }
  if (faces.empty()) {
    return Reject(ShaperReject::kFallback);
  }
  PreparedText prepared = PrepareText(request.text, request.text_len);
  // The system fallback source: CoreText's, with the system renderer and
  // the installed fonts on (the old path's defaultFallback asks the same
  // manager). Elsewhere a character no family has is turned down.
  bool system_source = false;
  sk_sp<SkTypeface> last_resort_face;
  sk_sp<SkTypeface> last_resort_base;
  sk_sp<SkTypeface> locale_standard;
#if defined(__APPLE__)
  system_source = SystemFontRenderer() && c_collection->font_mgr;
  if (system_source) {
    if (const std::string name = LocaleStandardFamily(c_collection, request);
        !name.empty()) {
      const std::vector<sk_sp<SkTypeface>> standard =
          font_collection->findTypefaces({SkString(name.c_str(), name.size())},
                                         font_style);
      if (!standard.empty()) {
        locale_standard = standard.front();
      }
    }
    const std::string name = LastResortFamily(c_collection, request);
    if (!name.empty()) {
      const std::vector<SkString> last_resort = {
          SkString(name.c_str(), name.size())};
      const std::vector<sk_sp<SkTypeface>> base =
          font_collection->findTypefaces(last_resort, font_style);
      if (!base.empty()) {
        last_resort_base = base.front();
        last_resort_face = base.front();
        if (font_args) {
          const std::vector<sk_sp<SkTypeface>> instance =
              font_collection->findTypefaces(last_resort, font_style,
                                             font_args);
          if (!instance.empty()) {
            last_resort_face = instance.front();
          }
        }
      }
    }
  }
#endif

  // From here the layout holds references into the caches (HarfBuzz fonts,
  // the buffer): none may be dropped before it ends.
  const uint64_t caches_changes =
      g_text_caches_changes.load(std::memory_order_relaxed);
  sk_sp<SkUnicode>& unicode = GetTextCaches(c_collection).unicode;
  if (!unicode) {
    // Loads ICU's data on Windows before the first ICU call.
    unicode = SkUnicodes::ICU::Make();
  }

  // The family entries (Blink's SimpleFontData): the shaping font
  // OneLineShaper builds, its synthetic styles, and the draw font.
  const TextRasterPolicy policy(request);
  LineFonts fonts(c_collection, request, policy, sizes);
  for (size_t i = 0; i < faces.size(); ++i) {
    if (!fonts.AddFamily(faces[i], faces.size() == base_faces.size()
                                       ? base_faces[i].get()
                                       : faces[i].get())) {
      return Reject(ShaperReject::kFallback);
    }
  }
  fonts.set_system_source(system_source);
  fonts.set_locale_standard(std::move(locale_standard));
  fonts.set_last_resort(last_resort_face, last_resort_base.get());

  const bool word_by_word = CanShapeWordByWord(
      c_collection, faces, request,
      [](skiac_font_collection* collection, SkTypeface* face) {
        return HbNominalGlyph(collection, face, 0x20);
      });
  const bool rtl = request.direction == static_cast<int>(TextDirection::kRtl);
  const ItemList items = SegmentText(prepared, rtl, word_by_word);
  const std::vector<hb_feature_t> features = BlinkFeatures(request);
  const hb_language_t language = ShapingLanguage(request);
  const char* case_map_locale = CaseMapLocale(request);
  hb_buffer_t* buffer = ShaperBuffer(c_collection);
  hb_buffer_reset(buffer);

  std::vector<ShapedItem> shaped;
  shaped.reserve(items.items.size());
  for (const Item& item : items.items) {
    ShapedItem result{item, {}};
    const char16_t* text = prepared.text.data() + item.start;
    ItemShaper shaper(text, item.length, item.rtl, buffer, features, language,
                      c_collection, request.variant_caps, case_map_locale,
                      fonts, &result.result);
    for (const Segment& segment :
         SegmentItem(text, item.length, prepared.is_8bit)) {
      if (!shaper.ShapeSegment(segment)) {
        hb_buffer_reset(buffer);
        return Reject(shaper.reject_reason());
      }
    }
    shaped.push_back(std::move(result));
  }
  // PlainTextNode::Shape: the spacing over the whole text, item by item.
  ApplySpacing(prepared, request.letter_spacing, request.word_spacing, &shaped);

  PlacedLine placed =
      PlaceItems(shaped, prepared, items.contains_rtl, items.rtl_base);
  scratch.line_width = placed.line_width;
  // Blink places the glyphs from the left edge: no skparagraph offsets.
  scratch.paragraph_width = placed.line_width;
  scratch.layout_width = placed.line_width;
  scratch.line_baseline = 0;
  scratch.letter_spacing_offset = 0;
  scratch.last_word_advance = placed.last_item_width;
  scratch.blink = std::move(placed.blink);
  if (g_text_caches_changes.load(std::memory_order_relaxed) != caches_changes) {
    g_cache_changes.fetch_add(1, std::memory_order_relaxed);
  }
  *line = std::move(scratch);
  g_accepted.fetch_add(1, std::memory_order_relaxed);
  return true;
}

extern "C" {

void skiac_debug_shaper_stats(skiac_shaper_stats* stats, bool reset) {
  stats->accepted = reset ? g_accepted.exchange(0, std::memory_order_relaxed)
                          : g_accepted.load(std::memory_order_relaxed);
  for (size_t i = 0; i < kShaperRejectSlots; ++i) {
    stats->rejected[i] =
        reset ? g_rejected[i].exchange(0, std::memory_order_relaxed)
              : g_rejected[i].load(std::memory_order_relaxed);
  }
  stats->cache_changes =
      reset ? g_cache_changes.exchange(0, std::memory_order_relaxed)
            : g_cache_changes.load(std::memory_order_relaxed);
}

}  // extern "C"
