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

#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#elif defined(_WIN32)
// kernel32's GetUserDefaultLocaleName (winnls.h), declared here so that
// <windows.h>'s macros stay out of this file.
extern "C" __declspec(dllimport) int __stdcall GetUserDefaultLocaleName(
    wchar_t* locale_name,
    int length);
#endif

namespace {

std::atomic<uint64_t> g_accepted{0};
std::atomic<uint64_t> g_text_caches_changes{0};
std::atomic<uint64_t> g_cache_changes{0};

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
        sizes_(sizes),
        system_renderer_(SystemFontRenderer()) {
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
    // HarfBuzzShaper passes the description's specified size, whichever
    // font shapes (also a small caps or fallback font).
    EntryFontOptions options;
    options.ptem = request_.size > 0 ? request_.size : entry->size;
    // A registered font is Chrome's web font; a system fallback font (no
    // base) is installed. Only a face with `trak` is affected, so only such
    // a face is looked up.
    options.web_font = entry->base &&
                       TypefaceHasTrak(c_collection_, entry->face.get()) &&
                       !IsSystemTypeface(c_collection_, entry->base);
    options.system_renderer = system_renderer_;
    return MakeEntryFont(c_collection_, entry, options);
  }

  // A family entry (Blink's SimpleFontData of a font-family font), at the
  // family's own size and opsz (UsedSizes::face_sizes, face_opsz). False,
  // and no entry, for a face without font data.
  bool AddFamily(sk_sp<SkTypeface> face,
                 SkTypeface* base,
                 float size,
                 float opsz) {
    FontEntry entry;
    entry.face = std::move(face);
    entry.base = base;
    entry.size = size;
    entry.opsz = opsz;
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
  // Without one, SystemFallback finds no font, as Blink's FontCache does on
  // a platform whose fallback returns none.
  void set_system_source(bool system_source) { system_source_ = system_source; }

  // FontCache::GetLastResortFallbackFont through the family matching, found
  // before the layout takes any reference into the caches. Set only with a
  // system source: without one the old path draws the first font's .notdef
  // (no font manager gives a fallback, skia_c.hpp), and so does the shaper.
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
    if (!system_source_ || families_.empty() ||
        IsPrivateUseOrNonCharacter(hint)) {
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
  const bool system_renderer_;
  TextStyle flags_;
  std::deque<FontEntry> families_;
  std::deque<FontEntry> others_;
  // The small caps copies, by the font they copy.
  std::deque<FontEntry> small_caps_;
  std::unordered_map<const FontEntry*, FontEntry*> small_caps_index_;
  bool system_source_ = false;
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
// Without a system source (off Apple, or the portable renderer) the system
// stages find no font and there is no last resort font, so a character no
// family has is drawn with the first candidate's .notdef.
class FallbackIterator {
 public:
  FallbackIterator(LineFonts& fonts, Priority priority)
      : fonts_(fonts), priority_(priority) {}

  bool HasNext() const { return stage_ != Stage::kOutOfLuck; }

  void Reset() {
    index_ = 0;
    stage_ = Stage::kFontGroupFonts;
    asked_.clear();
    returned_.clear();
    first_candidate_ = nullptr;
  }

  FontEntry* Next(const std::vector<uint32_t>& hints) {
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
             int han_script,
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
        han_script_(han_script),
        c_collection_(c_collection),
        variant_caps_(variant_caps),
        case_map_locale_(case_map_locale),
        fonts_(fonts),
        result_(result) {}

  // The order of the runs InsertRun's lower_bound inserts give, after the
  // item's last segment: by start, LTR ascending and RTL descending, a run
  // before the runs of its start inserted earlier (the runs' characters are
  // disjoint, so no two have one start, but the order would hold for them
  // too). Reversed, then sorted stably: O(n log n) for n runs.
  void SortRuns() {
    std::vector<ShapedRun>& runs = result_->runs;
    std::reverse(runs.begin(), runs.end());
    std::stable_sort(runs.begin(), runs.end(),
                     [this](const ShapedRun& a, const ShapedRun& b) {
                       return rtl_ ? a.start > b.start : a.start < b.start;
                     });
  }

  // HarfBuzzShaper::ShapeSegment.
  void ShapeSegment(const Segment& segment) {
    HanKerning han_kerning(text_, length_, segment.start, segment.end);
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
      // HanKerning's `halt` ranges for this range and font, on a copy of
      // its features (Blink's FontFeatureRangesSaver drops them after it),
      // with the FontData of the locale (LocaleOrDefault).
      bool han_kerning_computed = false;
      if (han_kerning.MayApply() &&
          han_kerning.RangeMayApply(shape_start, shape_end)) {
        const HanKerningFontData data = CachedHanKerningFontData(
            c_collection_, *adjusted_font, language_, han_script_);
        han_features_ = *features;
        han_kerning_computed = han_kerning.AppendFontFeatures(
            shape_start, shape_end, data, &han_features_);
        if (han_kerning_computed) {
          features = &han_features_;
        }
      }
      hb_shape_full(adjusted_font->hb.get(), buffer_, features->data(),
                    static_cast<unsigned int>(features->size()), kOtShaperList);
      if (!adjusted_font->draw_font.isSubpixel()) {
        RoundBufferPositions();
      }
      ExtractShapeResults(current, adjusted_font, segment.script,
                          &font_cycle_queued);
      // TextSpacingTrimFallback: the next fonts' ranges see the classes this
      // font gave its characters.
      if (han_kerning_computed && !queue_.empty()) {
        han_kerning.PrepareFallback();
      }
      hb_buffer_reset(buffer_);
    }
  }

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
    // start, RTL before the next run with a smaller one. Blink's runs are
    // pointers; these hold their glyphs, and moving every later run for each
    // run put in the middle (each character a fallback font draws, between
    // the first font's runs) is quadratic. So the run is appended, and
    // SortRuns gives the item's runs that order once it is shaped.
    result_->runs.push_back(std::move(run));
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
  int han_script_;
  skiac_font_collection* c_collection_;
  const int variant_caps_;
  const char* case_map_locale_;
  LineFonts& fonts_;
  ShapeResult* result_;
  // The features with the caps ones in front, for a range that has them.
  std::vector<hb_feature_t> caps_features_;
  std::vector<hb_feature_t> han_features_;
  std::optional<std::u16string> upper_;
  std::optional<std::u16string> lower_;
  std::deque<QueueItem> queue_;
  std::vector<uint32_t> hints_;
  FallbackStage stage_ = FallbackStage::kIntermediate;
};

// A family entry's face (the instance at its opsz), its face before font
// arguments, its size and its opsz.
struct FamilyFace {
  sk_sp<SkTypeface> face;
  SkTypeface* base;
  float size;
  float opsz;
};

// The FontList's family entries (DESIGN-SHAPER 2.8): for each found face k
// (an index into `base_faces`, not into `families`), the size and opsz
// ComputeUsedSizes gives its family, and its instance at that opsz from the
// same findTypefaces call and cloneTypeface cache as the old path (so the
// same SkTypeface). A face of no family in `sizes.faces`, or one whose
// instance list has another count than `base_faces`, takes the primary's
// size, opsz and instance. Every font argument list is noted here, before
// the layout takes any reference into the caches.
std::vector<FamilyFace> FamilyFaces(
    skiac_font_collection* c_collection,
    const std::vector<SkString>& families,
    const SkFontStyle& font_style,
    const std::vector<sk_sp<SkTypeface>>& base_faces,
    const std::vector<sk_sp<SkTypeface>>& faces,
    const UsedSizes& sizes,
    const skiac_text_request& request) {
  std::vector<FamilyFace> out;
  out.reserve(faces.size());
  const bool same_count = faces.size() == base_faces.size();
  // The instances at each other opsz, by opsz.
  std::vector<std::pair<float, std::vector<sk_sp<SkTypeface>>>> instances;
  for (size_t k = 0; k < faces.size(); ++k) {
    FamilyFace family{faces[k],
                      same_count ? base_faces[k].get() : faces[k].get(),
                      sizes.effective, sizes.opsz};
    if (!sizes.faces.empty() && same_count) {
      // The family of the face, as the old path's family_of finds it.
      std::optional<size_t> index;
      for (size_t i = 0; !index && i < sizes.faces.size(); ++i) {
        if (sizes.faces[i]->uniqueID() == base_faces[k]->uniqueID()) {
          index = i;
        }
      }
      if (!index && sizes.faces.size() == base_faces.size()) {
        index = k;
      }
      if (index) {
        const float opsz = sizes.face_opsz[*index];
        if (opsz != sizes.opsz) {
          auto known = std::find_if(
              instances.begin(), instances.end(),
              [opsz](const auto& entry) { return entry.first == opsz; });
          if (known == instances.end()) {
            std::vector<sk_sp<SkTypeface>> found;
            const auto own = FontVariations({base_faces[k]}, request, opsz);
            if (!own.empty()) {
              SkFontArguments args;
              args.setVariationDesignPosition(
                  {own.data(), static_cast<int>(own.size())});
              const std::optional<FontArguments> arguments(args);
              c_collection->noteFontArguments(
                  std::hash<FontArguments>()(*arguments));
              found = c_collection->collection->findTypefaces(
                  families, font_style, arguments);
            }
            instances.emplace_back(opsz, std::move(found));
            known = instances.end() - 1;
          }
          if (known->second.empty()) {
            // No variation to set: the face at the request's axes.
            family.size = sizes.face_sizes[*index];
            family.opsz = opsz;
          } else if (known->second.size() == base_faces.size()) {
            family.face = known->second[k];
            family.size = sizes.face_sizes[*index];
            family.opsz = opsz;
          }
        } else {
          family.size = sizes.face_sizes[*index];
        }
      }
    }
    out.push_back(std::move(family));
  }
  return out;
}

// Chrome's UI locales (build/config/locales.gni platform_pak_locales off
// Android; the .lproj names of Chrome.app on macOS).
constexpr std::string_view kChromeLocales[] = {
    "af", "am",  "ar",    "bg",    "bn", "ca",     "cs",    "da",
    "de", "el",  "en-GB", "en-US", "es", "es-419", "et",    "fa",
    "fi", "fil", "fr",    "gu",    "he", "hi",     "hr",    "hu",
    "id", "it",  "ja",    "kn",    "ko", "lt",     "lv",    "ml",
    "mr", "ms",  "nb",    "nl",    "pl", "pt-BR",  "pt-PT", "ro",
    "ru", "sk",  "sl",    "sr",    "sv", "sw",     "ta",    "te",
    "th", "tr",  "uk",    "ur",    "vi", "zh-CN",  "zh-TW",
};

bool IsChromeLocale(std::string_view locale) {
  return std::find(std::begin(kChromeLocales), std::end(kChromeLocales),
                   locale) != std::end(kChromeLocales);
}

bool EqualsAscii(std::string_view a, std::string_view b) {
  return a.size() == b.size() &&
         std::equal(a.begin(), a.end(), b.begin(), [](char x, char y) {
           auto lower = [](char c) {
             return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
           };
           return lower(x) == lower(y);
         });
}

// l10n_util::CheckAndResolveLocale over Chrome's UI locales: the locale, or
// its language with Chrome's region mapping, or an alias; empty for none.
std::string CheckAndResolveLocale(const std::string& locale) {
  if (IsChromeLocale(locale)) {
    return locale;
  }
  if (locale.find('@') != std::string::npos) {
    return {};
  }
  const std::string lang = locale.substr(0, locale.find('-'));
  if (lang.size() < locale.size()) {
    const std::string_view region =
        std::string_view(locale).substr(lang.size() + 1);
    std::string tmp = lang;
    if (EqualsAscii(lang, "es") && !EqualsAscii(region, "es")) {
      tmp += "-419";
    } else if (EqualsAscii(lang, "pt") && !EqualsAscii(region, "br")) {
      tmp += "-PT";
    } else if (EqualsAscii(lang, "zh")) {
      tmp += EqualsAscii(region, "hk") || EqualsAscii(region, "mo") ? "-TW"
                                                                    : "-CN";
    } else if (EqualsAscii(lang, "en")) {
      tmp += EqualsAscii(region, "lr") || EqualsAscii(region, "ph") ? "-US"
                                                                    : "-GB";
    }
    if (IsChromeLocale(tmp)) {
      return tmp;
    }
  }
  static constexpr std::pair<std::string_view, std::string_view> kAliases[] = {
      {"en", "en-US"}, {"iw", "he"},  {"no", "nb"},
      {"pt", "pt-BR"}, {"tl", "fil"}, {"zh", "zh-CN"}};
  for (const auto& [source, dest] : kAliases) {
    if (EqualsAscii(lang, source) && IsChromeLocale(dest)) {
      return std::string(dest);
    }
  }
  return {};
}

// base::i18n::GetCanonicalLocale of a POSIX locale name
// ("language[_territory][.codeset][@modifier]"): "ja-JP"; a modifier stays
// as "@..." (CheckAndResolveLocale turns it down); "C" and "POSIX" (ICU's
// en_US_POSIX) are none.
std::string CanonicalPosixLocale(std::string_view name) {
  std::string modifier;
  if (const size_t at = name.find('@'); at != std::string_view::npos) {
    modifier = "@" + std::string(name.substr(at + 1));
    name = name.substr(0, at);
  }
  name = name.substr(0, name.find('.'));
  if (name.empty() || name == "C" || name == "POSIX") {
    return {};
  }
  std::string out;
  size_t part = 0;
  size_t begin = 0;
  while (begin <= name.size()) {
    size_t end = name.find_first_of("_-", begin);
    if (end == std::string_view::npos) {
      end = name.size();
    }
    std::string subtag(name.substr(begin, end - begin));
    for (char& c : subtag) {
      // The language lower case, a script title case, a region upper case.
      const bool upper = part > 0 && (subtag.size() != 4 || &c == &subtag[0]);
      if (upper && c >= 'a' && c <= 'z') {
        c = static_cast<char>(c - 'a' + 'A');
      } else if (!upper && c >= 'A' && c <= 'Z') {
        c = static_cast<char>(c - 'A' + 'a');
      }
    }
    if (!subtag.empty()) {
      out += (out.empty() ? "" : "-") + subtag;
    }
    ++part;
    begin = end + 1;
  }
  return out.empty() ? std::string() : out + modifier;
}

// GetApplicationLocaleInternalNonMac with GLib (Linux): g_get_language_names
// (LANGUAGE as a ':' list, else LC_ALL, else LC_MESSAGES, else LANG; "C"
// last), each through CheckAndResolveLocale; else "en-US". GLib lists each
// name's variants, the one without the modifier after the one with it
// (g_get_locale_variants: "de_DE@euro", "de_DE", "de@euro", "de"), and
// CheckAndResolveLocale turns down every name with a modifier, so
// "de_DE@euro" is "de".
std::string PosixHostLanguage() {
  const char* value = nullptr;
  for (const char* name : {"LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"}) {
    value = getenv(name);
    if (value && *value) {
      break;
    }
    value = nullptr;
  }
  std::string_view list = value ? value : "";
  while (!list.empty()) {
    const size_t colon = list.find(':');
    const std::string_view name = list.substr(0, colon);
    std::string resolved = CheckAndResolveLocale(CanonicalPosixLocale(name));
    if (resolved.empty() && name.find('@') != std::string_view::npos) {
      resolved = CheckAndResolveLocale(
          CanonicalPosixLocale(name.substr(0, name.find('@'))));
    }
    if (!resolved.empty()) {
      return resolved;
    }
    list = colon == std::string_view::npos ? std::string_view()
                                           : list.substr(colon + 1);
  }
  return "en-US";
}

#if defined(__APPLE__)
// l10n_util::OverrideLocaleWithCocoaLocale: the first of the outer bundle's
// preferredLocalizations (the user's language list matched against
// Chrome.app's .lproj names), '_' as '-', "en" as "en-US".
std::string AppleHostLanguage() {
  std::vector<CFStringRef> names;
  for (std::string_view locale : kChromeLocales) {
    std::string lproj(locale == "en-US" ? "en" : locale);
    std::replace(lproj.begin(), lproj.end(), '-', '_');
    names.push_back(CFStringCreateWithBytes(
        kCFAllocatorDefault, reinterpret_cast<const UInt8*>(lproj.data()),
        static_cast<CFIndex>(lproj.size()), kCFStringEncodingASCII, false));
  }
  CFArrayRef available = CFArrayCreate(
      kCFAllocatorDefault, reinterpret_cast<const void**>(names.data()),
      static_cast<CFIndex>(names.size()), &kCFTypeArrayCallBacks);
  for (CFStringRef name : names) {
    CFRelease(name);
  }
  std::string out;
  if (CFArrayRef preferred =
          CFBundleCopyLocalizationsForPreferences(available, nullptr)) {
    if (CFArrayGetCount(preferred) > 0) {
      CFStringRef first =
          static_cast<CFStringRef>(CFArrayGetValueAtIndex(preferred, 0));
      char buffer[64];
      if (CFStringGetCString(first, buffer, sizeof(buffer),
                             kCFStringEncodingASCII)) {
        out = buffer;
      }
    }
    CFRelease(preferred);
  }
  CFRelease(available);
  std::replace(out.begin(), out.end(), '_', '-');
  if (out.empty() || out == "en") {
    out = "en-US";
  }
  return out;
}
#endif

#if defined(_WIN32)
// GetApplicationLocaleInternalNonMac on Windows without --lang or a pref:
// ICU's configured locale (the user default locale) through
// CheckAndResolveLocale; else "en-US".
std::string WindowsHostLanguage() {
  wchar_t name[85];  // LOCALE_NAME_MAX_LENGTH
  const int length = GetUserDefaultLocaleName(name, 85);
  std::string ascii;
  for (int i = 0; i + 1 < length; ++i) {
    if (name[i] > 0x7f) {
      return "en-US";
    }
    ascii += static_cast<char>(name[i]);
  }
  const std::string resolved =
      CheckAndResolveLocale(CanonicalPosixLocale(ascii));
  return resolved.empty() ? "en-US" : resolved;
}
#endif

}  // namespace

// LayoutLocale::GetDefault's language (DefaultLanguage: the browser's UI
// locale, D19), read once per process. NAPI_RS_CANVAS_TEST_POSIX_LANGUAGE=1
// (tests only) uses the Linux rule on every OS, so a test can set the
// language through LANGUAGE / LC_ALL / LC_MESSAGES / LANG in a child process
// without changing the host's settings.
const std::string& HostLanguage() {
  static const std::string language = [] {
    if (const char* test = getenv("NAPI_RS_CANVAS_TEST_POSIX_LANGUAGE");
        test && strcmp(test, "1") == 0) {
      return PosixHostLanguage();
    }
#if defined(__APPLE__)
    return AppleHostLanguage();
#elif defined(_WIN32)
    return WindowsHostLanguage();
#else
    return PosixHostLanguage();
#endif
  }();
  return language;
}

namespace {

// FontDescription::LocaleOrDefault for ctx.lang, as a language tag: the
// host language for "inherit" (a canvas with no lang of its own: D19),
// "und" for "" (LayoutLocale of "": HarfBuzz's dflt, R17), else the tag.
std::string ResolvedLanguage(const skiac_text_request& request) {
  const std::string_view lang(request.lang ? request.lang : "",
                              request.lang ? request.lang_len : 0);
  if (lang == "inherit") {
    return HostLanguage();
  }
  if (lang.empty()) {
    return "und";
  }
  return std::string(lang);
}

// The HarfBuzz language of a resolved language (LayoutLocale's
// HarfbuzzLanguage); "und" when HarfBuzz has none for it.
hb_language_t ShapingLanguage(const std::string& lang) {
  static const hb_language_t und = hb_language_from_string("und", -1);
  const hb_language_t language =
      hb_language_from_string(lang.data(), static_cast<int>(lang.size()));
  return language == HB_LANGUAGE_INVALID ? und : language;
}

}  // namespace

FontResolution ResolveFontRequest(skiac_font_collection* c_collection,
                                  const skiac_text_request& request) {
  const std::string_view lang(request.lang ? request.lang : "",
                              request.lang ? request.lang_len : 0);
  FontResolution fonts;
  if (!BlinkShaperOn()) {
    fonts.lang = std::string(lang);
    return fonts;
  }
  fonts.lang = ResolvedLanguage(request);
  // A generic family takes the setting of the locale's script
  // (FontSelector::FamilyNameFromSettings), and the last family is the
  // standard font of that script (FontFallbackList::GetFontData's
  // -webkit-standard).
  fonts.families = LocaleFontFamilies(c_collection, fonts.lang, HostLanguage());
  return fonts;
}

void NoteTextCachesChange() {
  g_text_caches_changes.fetch_add(1, std::memory_order_relaxed);
}

bool BlinkShaperOn() {
  static const bool on = [] {
    const char* value = getenv("NAPI_RS_CANVAS_SHAPER");
    return !value || strcmp(value, "skparagraph") != 0;
  }();
  return on;
}

void LayOutLineBlink(skiac_font_collection* c_collection,
                     const skiac_text_request& request,
                     const FontResolution& resolution,
                     TextCaches::Line* line) {
  auto font_collection = c_collection->collection;
  const SkFontStyle font_style(static_cast<int>(roundf(request.weight)),
                               request.stretch,
                               static_cast<SkFontStyle::Slant>(request.style));
  // FontDescription::LocaleOrDefault: the HarfBuzz language, the case map
  // locale, HanKerning's locale and the standard font's script.
  const std::string& lang = resolution.lang;
  // The FontList, with every noteFontArguments call, before any reference
  // into the caches is taken. The families are copied: the cache entry is
  // a reference into TextCaches. The families and ComputeUsedSizes take the
  // locale's font settings (a generic family, the standard font too, at its
  // own aspect under font-size-adjust).
  const std::vector<SkString> families =
      CachedFontFamilies(c_collection, request, resolution.locale());
  const std::vector<sk_sp<SkTypeface>> base_faces =
      font_collection->findTypefaces(families, font_style);
  const UsedSizes sizes =
      ComputeUsedSizes(c_collection, base_faces, request, resolution.locale());
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
  const std::vector<FamilyFace> family_faces = FamilyFaces(
      c_collection, families, font_style, base_faces, faces, sizes, request);

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
    return;
  }
  PreparedText prepared = PrepareText(request.text, request.text_len);
  // The system fallback source: CoreText's, with the system renderer and
  // the installed fonts on (the old path's defaultFallback asks the same
  // manager). Elsewhere there is none: a character no family has is drawn
  // with the first family font's .notdef, as the old path draws it.
  bool system_source = false;
  sk_sp<SkTypeface> last_resort_face;
  sk_sp<SkTypeface> last_resort_base;
#if defined(__APPLE__)
  system_source = SystemFontRenderer() && c_collection->font_mgr;
  if (system_source) {
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
  // A face without font data is never a candidate (FontFallbackIterator::
  // UniqueOrNext skips a font data without a typeface). The family matching
  // always gives a face (FontCollection::findTypefaces ends with the default
  // manager's empty typeface), so a list without one does not happen; if it
  // did, Skia's empty typeface is its last resort font, which draws an
  // inkless, zero-width .notdef, as a host without fonts draws today.
  for (const FamilyFace& family : family_faces) {
    fonts.AddFamily(family.face, family.base, family.size, family.opsz);
  }
  if (fonts.families().empty()) {
    fonts.AddFamily(SkTypeface::MakeEmpty(), nullptr, sizes.effective,
                    sizes.opsz);
  }
  fonts.set_system_source(system_source);
  fonts.set_last_resort(last_resort_face, last_resort_base.get());

  const bool word_by_word = CanShapeWordByWord(
      c_collection, faces, request,
      [](skiac_font_collection* collection, SkTypeface* face) {
        return HbNominalGlyph(collection, face, 0x20);
      });
  const bool rtl = request.direction == static_cast<int>(TextDirection::kRtl);
  const ItemList items = SegmentText(prepared, rtl, word_by_word);
  const std::vector<hb_feature_t> features =
      BlinkFeatures(request, /*default_chws=*/true);
  const hb_language_t language = ShapingLanguage(lang);
  const int han_script = HanScriptForLocale(lang);
  const char* case_map_locale = CaseMapLocale(lang);
  hb_buffer_t* buffer = ShaperBuffer(c_collection);
  hb_buffer_reset(buffer);

  std::vector<ShapedItem> shaped;
  shaped.reserve(items.items.size());
  for (const Item& item : items.items) {
    ShapedItem result{item, {}};
    const char16_t* text = prepared.text.data() + item.start;
    ItemShaper shaper(text, item.length, item.rtl, buffer, features, language,
                      han_script, c_collection, request.variant_caps,
                      case_map_locale, fonts, &result.result);
    for (const Segment& segment :
         SegmentItem(text, item.length, prepared.is_8bit)) {
      shaper.ShapeSegment(segment);
    }
    shaper.SortRuns();
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
}

extern "C" {

bool skiac_blink_shaper_on() {
  return BlinkShaperOn();
}

void skiac_debug_shaper_stats(skiac_shaper_stats* stats, bool reset) {
  stats->accepted = reset ? g_accepted.exchange(0, std::memory_order_relaxed)
                          : g_accepted.load(std::memory_order_relaxed);
  // No request is turned down since stage S9.
  for (uint64_t& rejected : stats->rejected) {
    rejected = 0;
  }
  stats->cache_changes =
      reset ? g_cache_changes.exchange(0, std::memory_order_relaxed)
            : g_cache_changes.load(std::memory_order_relaxed);
}

}  // extern "C"
