// SVG images src/svg_doc prepared, drawn by SkSVGDOM through a canvas that
// does what Chrome does where SkSVG cannot:
//
//   <image> raster      Chrome's decode-cache draw (DrawDecodedImage), at the
//                       element's image-rendering quality, AA, clamped to
//                       the source (graphics_context.cc:531-541)
//   <image> SVG         the nested document as vectors, clipped to its box
//                       (svg_image.cc:513-558)
//   <text>              the platform's draw font and paint, as canvas text
//                       draws (text_raster.hpp TextRasterPolicy), with
//                       the font's synthetic bold and italic where
//                       font-synthesis allows them
//   font-family         Blink's font list: registered names, the per-OS
//                       generic families, then the standard font
//                       (font_families.cpp ResolveFontFamilies)
//   a missing glyph     Blink's FontFallbackIterator per grapheme cluster:
//                       the list's fonts, the emoji priority font, the
//                       system font and the last resort font, as canvas
//                       text (SvgRunShaper)

#include "svg_image.hpp"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <modules/skshaper/include/SkShaper.h>
#include <modules/skshaper/include/SkShaper_factory.h>
#include <src/core/SkTextBlobPriv.h>
#include <src/core/SkUTF.h>

#include "icu_api.h"
#include "shaper.hpp"
#include "text.hpp"
#include "text_caches.hpp"
#include "text_raster.hpp"

#if defined(SK_DEBUG) || !defined(SK_RELEASE)
#error "skia-c must be built with SK_RELEASE like libskia (see build.rs)"
#endif

namespace napi_svg {
namespace {

constexpr char kImagePrefix[] = "napi-img:";
constexpr char kSvgPrefix[] = "napi-svg:";
constexpr char kFontPrefix[] = "napi-font:";

// The most nested SVG images one render draws. Each is drawn as vectors, so
// an image that holds ten copies of an image that holds ten copies ... costs
// ten times more per level; Chrome draws them all and slows down the same
// way. Past this, the rest are not drawn.
constexpr int kNestedDrawBudget = 1 << 17;

// The index after `prefix` in `name`, or -1.
long IndexAfter(const char* name, const char* prefix) {
  const size_t n = strlen(prefix);
  if (!name || strncmp(name, prefix, n) != 0) {
    return -1;
  }
  char* end = nullptr;
  const long index = strtol(name + n, &end, 10);
  return end != name + n && *end == '\0' && index >= 0 ? index : -1;
}

class StaticAsset final : public skresources::ImageAsset {
 public:
  explicit StaticAsset(sk_sp<SkImage> image) : image_(std::move(image)) {}
  bool isMultiFrame() override { return false; }
  FrameData getFrameData(float) override {
    return {image_, SkSamplingOptions(SkFilterMode::kLinear), SkMatrix::I(),
            SizeFit::kCenter};
  }

 private:
  sk_sp<SkImage> image_;
};

// The font request of the text fragment SkSVGText is shaping in a
// document: SkSVGText's ResolveFont asks the document's font manager for the
// fragment's typeface (onLegacyMakeTypeface) at the start of each fragment
// (SkSVGTextContext::shapeFragment), and every shapePendingBuffer of that
// fragment shapes right after, before the next fragment asks. The font
// manager keeps the request and the shaper (SvgRunShaper) reads it there:
// the font list's faces, the style and the families. A document draws
// under the font collection's lock, so one draw at a time uses it. (Not a
// thread_local: its destructor would need __cxa_thread_atexit_impl, which
// old glibc does not have.)
struct SvgFontRequest {
  // Whether a fragment asked since the last draw; else the shaper shapes as
  // SkSVG's Primitive shaper.
  bool active = false;
  // The faces of the font list for the style, in list order (the first is
  // the one ResolveFont draws with).
  std::vector<sk_sp<SkTypeface>> faces;
  SkFontStyle style;
  // The computed font-weight (style's is SkSVG's, rounded to 100s).
  float weight = 400;
  // The request's families, for the system stage (the last resort family,
  // the monospace generic).
  std::vector<std::string> names;
  std::vector<int> generics;
  // font-synthesis: whether a font may be a synthetic bold and italic.
  SyntheticStyle allowed = {true, true};
};

// The font-family lists of a document. SkSVGText asks for a typeface by
// the family attribute (napi-font:K); Blink's font list gives it. With
// `names`, the attribute is a family name (convertSVGTextToPath: the first
// name of the list, as SkSVG parses it), matched as canvas text matches a
// named family (MatchNamedFamily), so a font registered over an installed
// family is the one the paths use.
class SvgFontMgr final : public SkFontMgr {
 public:
  SvgFontMgr(skiac_font_collection* c_collection,
             const skiac_svg_font_list* lists,
             size_t count,
             bool names = false)
      : c_collection_(c_collection), names_(names) {
    // Fonts that differ only in weight or font-synthesis point at one
    // family array (sk.rs svg_font_lists); it is copied once.
    std::map<std::pair<const skiac_text_family*, size_t>, size_t> copied;
    lists_.resize(count);
    for (size_t i = 0; i < count; ++i) {
      auto [it, added] = copied.try_emplace({lists[i].families, lists[i].count},
                                            families_.size());
      if (added) {
        std::vector<Family>& families = families_.emplace_back();
        families.reserve(lists[i].count);
        for (size_t j = 0; j < lists[i].count; ++j) {
          const skiac_text_family& family = lists[i].families[j];
          families.push_back(
              {std::string(family.name ? family.name : "", family.name_len),
               family.generic});
        }
      }
      lists_[i].families = it->second;
      lists_[i].weight = lists[i].weight;
      lists_[i].allowed = {lists[i].synthetic_bold, lists[i].synthetic_italic};
    }
  }

  // The request of the fragment being shaped (onLegacyMakeTypeface).
  const SvgFontRequest& request() const { return request_; }
  // Forgets the request (its faces), after a draw.
  void EndText() const { request_ = SvgFontRequest(); }

 protected:
  int onCountFamilies() const override { return assets()->countFamilies(); }
  void onGetFamilyName(int index, SkString* name) const override {
    assets()->getFamilyName(index, name);
  }
  sk_sp<SkFontStyleSet> onCreateStyleSet(int index) const override {
    return assets()->createStyleSet(index);
  }
  sk_sp<SkFontStyleSet> onMatchFamily(const char name[]) const override {
    return assets()->matchFamily(name);
  }
  sk_sp<SkTypeface> onMatchFamilyStyle(
      const char name[],
      const SkFontStyle& style) const override {
    return assets()->matchFamilyStyle(name, style);
  }
  // Null (TypefaceFontProvider has no fallback). It must stay null: SkSVG's
  // FontMgrRunIterator splits a fragment's text at the fonts this returns,
  // where SvgRunShaper picks the font of each grapheme cluster itself.
  sk_sp<SkTypeface> onMatchFamilyStyleCharacter(
      const char name[],
      const SkFontStyle& style,
      const char* bcp47[],
      int bcp47_count,
      SkUnichar character) const override {
    return assets()->matchFamilyStyleCharacter(name, style, bcp47, bcp47_count,
                                               character);
  }
  sk_sp<SkTypeface> onMakeFromData(sk_sp<SkData> data,
                                   int index) const override {
    return assets()->makeFromData(std::move(data), index);
  }
  sk_sp<SkTypeface> onMakeFromStreamIndex(std::unique_ptr<SkStreamAsset> stream,
                                          int index) const override {
    return assets()->makeFromStream(std::move(stream), index);
  }
  sk_sp<SkTypeface> onMakeFromStreamArgs(
      std::unique_ptr<SkStreamAsset> stream,
      const SkFontArguments& args) const override {
    return assets()->makeFromStream(std::move(stream), args);
  }
  sk_sp<SkTypeface> onMakeFromFile(const char path[],
                                   int index) const override {
    return assets()->makeFromFile(path, index);
  }

  // SkSVGText ResolveFont: the first family of the list that has a face for
  // `style` (FontFallbackList::GetFontData), or the standard font.
  // The request is kept for the fragment's shaping (request_).
  sk_sp<SkTypeface> onLegacyMakeTypeface(const char name[],
                                         SkFontStyle style) const override {
    SvgFontRequest& request = request_;
    request.active = true;
    request.style = style;
    request.faces.clear();
    request.names.clear();
    request.generics.clear();
    request.weight = static_cast<float>(style.weight());
    request.allowed = {true, true};
    if (names_) {
      sk_sp<SkTypeface> face =
          name ? MatchNamedFamily(c_collection_, name, style) : nullptr;
      if (!face) {
        face = assets()->legacyMakeTypeface(name, style);
      }
      if (face) {
        request.faces.push_back(face);
      }
      if (name) {
        request.names.push_back(name);
        request.generics.push_back(0);
      }
      return face;
    }
    const long index = IndexAfter(name, kFontPrefix);
    static const List kNone;
    const List& font = index >= 0 && static_cast<size_t>(index) < lists_.size()
                           ? lists_[index]
                           : kNone;
    static const std::vector<Family> kNoFamilies;
    const std::vector<Family>& list = font.families < families_.size()
                                          ? families_[font.families]
                                          : kNoFamilies;
    request.weight = font.weight;
    request.allowed = font.allowed;
    std::vector<skiac_text_family> families;
    families.reserve(list.size());
    for (const Family& family : list) {
      families.push_back(
          {family.name.data(), family.name.size(), family.generic});
      request.names.push_back(family.name);
      request.generics.push_back(family.generic);
    }
    skiac_text_request text_request{};
    text_request.size_adjust_metric = -1;
    text_request.families = families.data();
    text_request.family_count = families.size();
    c_collection_->flushCachesIfDirty();
    const std::vector<SkString> resolved =
        ResolveFontFamilies(c_collection_, text_request);
    request.faces = c_collection_->collection->findTypefaces(resolved, style);
    return request.faces.empty() ? nullptr : request.faces.front();
  }

 private:
  struct Family {
    std::string name;
    int generic;
  };
  struct List {
    // An index into families_; kNone's is past its end.
    size_t families = SIZE_MAX;
    float weight = 400;
    SyntheticStyle allowed = {true, true};
  };

  // The collection's current assets: a font registered or removed since the
  // document was made is seen, as by canvas text.
  const sk_sp<TypefaceFontProviderCustom>& assets() const {
    return c_collection_->assets;
  }

  skiac_font_collection* c_collection_;
  bool names_;
  std::vector<std::vector<Family>> families_;
  std::vector<List> lists_;
  mutable SvgFontRequest request_;
};

// UCHAR_DEFAULT_IGNORABLE_CODE_POINT: ZWJ, ZWNJ, the variation selectors
// and the like draw nothing, so a font without them still covers a cluster.
bool IsDefaultIgnorable(SkUnichar c) {
  return u_hasBinaryProperty(c, UCHAR_DEFAULT_IGNORABLE_CODE_POINT);
}

// The font request canvas text gives SynthesizeStyle, for a fragment's font
// request: its computed weight, slope 14 for italic and oblique (Blink's
// FontSelectionRequest), its stretch.
skiac_text_request SvgStyleRequest(const SvgFontRequest& slot) {
  const SkFontStyle& style = slot.style;
  skiac_text_request request{};
  request.weight = slot.weight;
  request.slope = style.slant() == SkFontStyle::kUpright_Slant ? 0 : 14;
  request.style = style.slant();
  request.stretch = style.width();
  request.stretch_pct = 100;
  request.size_adjust_metric = -1;
  return request;
}

// The synthetic styles font-synthesis allows (FontCache::
// CreateFontPlatformData: SyntheticBoldAllowed, SyntheticItalicAllowed).
SyntheticStyle Allowed(SyntheticStyle synthetic, SyntheticStyle allowed) {
  return {synthetic.bold && allowed.bold, synthetic.italic && allowed.italic};
}

// FontPlatformData::CreateSkFont's synthetic bold and italic, as canvas
// text sets them (shaper.cpp).
void SetSynthetic(SkFont* font, SyntheticStyle synthetic) {
  font->setEmbolden(synthetic.bold);
  font->setSkewX(synthetic.italic ? -SK_Scalar1 / 4 : 0);
}

// SkSVG's Primitive shaper (SkShaper_primitive.cpp) with Blink's font
// fallback: each grapheme cluster takes the first font of
// FontFallbackIterator (font_fallback_iterator.cc) that has all its
// characters (default ignorables aside):
//   1. the font list's faces for the fragment's style (the request), in
//      order, each typeface once;
//   2. for an emoji or symbol cluster (RunSegmenter's priority), the system
//      font for that priority;
//   3. the system font for the cluster's first character (SystemFallbackFor,
//      the stage canvas text asks);
//   4. the last resort font;
//   5. else the first font, which draws its .notdef.
// Runs of clusters with one font are laid out one after another as
// Primitive lays out its one run: one glyph per character, the font's
// advances, no kerning. A fallback run draws the face at the fragment's
// size and flags. A fragment that needs no fallback is shaped by Primitive
// itself, so its output is the same. Each run's font gets its face's
// synthetic bold and italic (CSSSegmentedFontFace::GetFontData, the system
// font's traits), as canvas text's (SynthesizeStyle), where the font list's
// font-synthesis allows them; the advances do not change. SkSVG keeps its
// own layout (chunks, positions, textPath).
class SvgRunShaper final : public SkShaper {
 public:
  SvgRunShaper(skiac_font_collection* c_collection, const SvgFontMgr* mgr)
      : c_collection_(c_collection),
        mgr_(mgr),
        primitive_(SkShapers::Primitive::PrimitiveText()) {}

  void shape(const char* utf8,
             size_t utf8_bytes,
             const SkFont& font,
             bool left_to_right,
             SkScalar width,
             RunHandler* handler) const override {
    primitive_->shape(utf8, utf8_bytes, font, left_to_right, width, handler);
  }

  void shape(const char* utf8,
             size_t utf8_bytes,
             FontRunIterator& font,
             BiDiRunIterator& bidi,
             ScriptRunIterator& script,
             LanguageRunIterator& language,
             SkScalar width,
             RunHandler* handler) const override {
    this->shape({utf8, utf8_bytes}, font, bidi, script, language, {},
                {.width = width}, handler);
  }

  void shape(const char* utf8,
             size_t utf8_bytes,
             FontRunIterator& font,
             BiDiRunIterator& bidi,
             ScriptRunIterator& script,
             LanguageRunIterator& language,
             const Feature* features,
             size_t features_size,
             SkScalar width,
             RunHandler* handler) const override {
    this->shape({utf8, utf8_bytes}, font, bidi, script, language,
                {features, features_size}, {.width = width}, handler);
  }

  void shape(SkSpan<const char> utf8,
             FontRunIterator& font_runs,
             BiDiRunIterator& bidi,
             ScriptRunIterator& script,
             LanguageRunIterator& language,
             SkSpan<const Feature> features,
             const Options& options,
             RunHandler* handler) const override {
    SkFont primary;
    if (!font_runs.atEnd()) {
      font_runs.consume();
      primary = font_runs.currentFont();
    }
    const bool ours = mgr_->request().active;
    if (ours && primary.getTypeface()) {
      // The list's first font is the family's face (findTypefaces with no
      // font arguments, or MatchNamedFamily), so it is its own base.
      const skiac_text_request request = SvgStyleRequest(mgr_->request());
      SetSynthetic(&primary,
                   Allowed(SynthesizeStyle(c_collection_, primary.getTypeface(),
                                           primary.getTypeface(), request),
                           mgr_->request().allowed));
    }
    std::vector<Run> runs;
    if (ours && !utf8.empty() && primary.getTypeface() &&
        options.width >= SK_ScalarMax && !Covers(primary.getTypeface(), utf8)) {
      runs = PickFonts(utf8, primary);
    }
    if (runs.empty() || (runs.size() == 1 && runs.front().font.getTypeface() ==
                                                 primary.getTypeface())) {
      // Primitive's own output, with the first font's synthetic styles.
      TrivialFontRunIterator primary_runs(primary, utf8.size());
      primitive_->shape(utf8, primary_runs, bidi, script, language, features,
                        options, handler);
      return;
    }
    Emit(utf8, runs, options, handler);
  }

 private:
  struct Run {
    SkFont font;
    size_t start;
    size_t end;
  };

  // Whether `face` has every character of the text: then every cluster
  // takes it, as the list's first font. (A missing default ignorable goes
  // to PickFonts, which loads ICU before asking for the property.)
  static bool Covers(SkTypeface* face, SkSpan<const char> utf8) {
    const char* at = utf8.data();
    const char* end = at + utf8.size();
    while (at < end) {
      const SkUnichar c = SkUTF::NextUTF8(&at, end);
      if (c < 0) {
        return true;
      }
      if (!face->unicharToGlyph(c)) {
        return false;
      }
    }
    return true;
  }

  // The fonts of the text's grapheme clusters, as runs of one font.
  std::vector<Run> PickFonts(SkSpan<const char> utf8,
                             const SkFont& primary) const {
    sk_sp<SkUnicode>& unicode_ref = GetTextCaches(c_collection_).unicode;
    if (!unicode_ref) {
      // Loads ICU's data on Windows before the first ICU call.
      unicode_ref = SkUnicodes::ICU::Make();
    }
    const sk_sp<SkUnicode> unicode = unicode_ref;
    std::vector<Run> runs;
    if (!unicode) {
      return runs;
    }
    // The code points, and the text as UTF-16 for RunSegmenter's priority
    // (SymbolsIterator: emoji presentation and text presentation emoji).
    std::vector<SkUnichar> chars;
    std::vector<size_t> char_bytes;
    std::u16string text16;
    std::vector<size_t> unit_bytes;
    {
      const char* at = utf8.data();
      const char* end = at + utf8.size();
      while (at < end) {
        const size_t offset = at - utf8.data();
        const SkUnichar c = SkUTF::NextUTF8(&at, end);
        if (c < 0) {
          return runs;
        }
        chars.push_back(c);
        char_bytes.push_back(offset);
        uint16_t units[2];
        const size_t count = SkUTF::ToUTF16(c, units);
        for (size_t i = 0; i < count; ++i) {
          text16.push_back(static_cast<char16_t>(units[i]));
          unit_bytes.push_back(offset);
        }
      }
    }
    std::vector<Priority> unit_priority(text16.size(), Priority::kText);
    for (const Segment& segment : SegmentItem(
             text16.data(), static_cast<uint32_t>(text16.size()), false)) {
      for (uint32_t i = segment.start; i < segment.end; ++i) {
        unit_priority[i] = segment.priority;
      }
    }
    std::vector<bool> cluster_start(utf8.size() + 1, false);
    {
      auto breaks =
          unicode->makeBreakIterator(SkUnicode::BreakType::kGraphemes);
      if (!breaks ||
          !breaks->setText(utf8.data(), static_cast<int>(utf8.size()))) {
        return runs;
      }
      for (SkBreakIterator::Position at = breaks->first(); !breaks->isDone();
           at = breaks->next()) {
        if (at >= 0 && static_cast<size_t>(at) <= utf8.size()) {
          cluster_start[at] = true;
        }
      }
    }
    cluster_start[0] = true;
    cluster_start[utf8.size()] = true;

    Fallback fallback(c_collection_, mgr_->request(), primary);
    RunFont previous = {primary.refTypeface(), fallback.primary_synthetic()};
    size_t unit = 0;
    for (size_t i = 0; i < chars.size();) {
      // The cluster's characters [i, j).
      size_t j = i + 1;
      while (j < chars.size() && !cluster_start[char_bytes[j]]) {
        ++j;
      }
      const size_t start = char_bytes[i];
      const size_t end = j < chars.size() ? char_bytes[j] : utf8.size();
      const Priority priority = unit_priority[unit];
      for (size_t k = i; k < j; ++k) {
        unit += chars[k] > 0xFFFF ? 2 : 1;
      }
      RunFont face = fallback.FontFor(&chars[i], j - i, priority, previous);
      if (!runs.empty() && runs.back().font.getTypeface() == face.face.get() &&
          runs.back().font.isEmbolden() == face.synthetic.bold &&
          (runs.back().font.getSkewX() != 0) == face.synthetic.italic) {
        runs.back().end = end;
      } else {
        SkFont font = primary;
        font.setTypeface(face.face);
        SetSynthetic(&font, face.synthetic);
        runs.push_back({font, start, end});
      }
      previous = std::move(face);
      i = j;
    }
    return runs;
  }

  // A cluster's face and its synthetic styles (the SimpleFontData's
  // FontPlatformData).
  struct RunFont {
    sk_sp<SkTypeface> face;
    SyntheticStyle synthetic = {false, false};
  };

  // FontFallbackIterator over the fragment's font request.
  class Fallback {
   public:
    Fallback(skiac_font_collection* c_collection,
             const SvgFontRequest& slot,
             const SkFont& primary)
        : c_collection_(c_collection) {
      std::unordered_set<SkTypefaceID> seen;
      auto add = [&](const sk_sp<SkTypeface>& face) {
        if (face && seen.insert(face->uniqueID()).second) {
          list_.push_back(face);
        }
      };
      add(primary.refTypeface());
      for (const sk_sp<SkTypeface>& face : slot.faces) {
        add(face);
      }
      for (size_t i = 0; i < slot.names.size(); ++i) {
        families_.push_back(
            {slot.names[i].data(), slot.names[i].size(), slot.generics[i]});
      }
      request_ = SvgStyleRequest(slot);
      request_.families = families_.data();
      request_.family_count = families_.size();
      request_.size = primary.getSize();
      // Each list face is its family's face, so its own base.
      allowed_ = slot.allowed;
      for (const sk_sp<SkTypeface>& face : list_) {
        list_synthetic_.push_back(Allowed(
            SynthesizeStyle(c_collection, face.get(), face.get(), request_),
            allowed_));
      }
      SkTypeface* first = list_.front().get();
      query_.request = &request_;
      query_.primary_face = first;
      query_.primary_base = first;
      // The system fallback is asked with the first font's synthetic styles
      // after font-synthesis (GetAlternateFontPlatformData reads the
      // FontPlatformData's, which CreateFontPlatformData masked), and its
      // answer is masked too (FontFor). They are in SystemFallbackFor's
      // cache key, so a masked query does not change later draws.
      query_.primary_synthetic = list_synthetic_.front();
      query_.coretext = HasCoreTextFallbackSource(c_collection);
      query_.han_script = FallbackHanScript("");
      query_.monospace = FallbackMonospace(request_);
    }

    SyntheticStyle primary_synthetic() const { return list_synthetic_.front(); }

    // The font of a cluster of `count` characters; one with only default
    // ignorables stays with the font before it.
    RunFont FontFor(const SkUnichar* chars,
                    size_t count,
                    Priority priority,
                    const RunFont& previous) {
      uint32_t hint = 0;
      for (size_t i = 0; i < count && !hint; ++i) {
        if (!IsDefaultIgnorable(chars[i])) {
          hint = static_cast<uint32_t>(chars[i]);
        }
      }
      if (!hint) {
        return previous;
      }
      auto covers = [&](SkTypeface* face) {
        for (size_t i = 0; i < count; ++i) {
          if (!IsDefaultIgnorable(chars[i]) &&
              !face->unicharToGlyph(chars[i])) {
            return false;
          }
        }
        return true;
      };
      for (size_t i = 0; i < list_.size(); ++i) {
        if (covers(list_[i].get())) {
          return {list_[i], list_synthetic_[i]};
        }
      }
      if (IsNonTextFallbackPriority(priority)) {
        SystemFallbackFont font = SystemFont(hint, priority);
        if (font.face && covers(font.face.get())) {
          return {std::move(font.face), Allowed(font.synthetic, allowed_)};
        }
      }
      if (SystemFallbackFont font = SystemFont(hint, Priority::kText);
          font.face && covers(font.face.get())) {
        return {std::move(font.face), Allowed(font.synthetic, allowed_)};
      }
      if (!last_resort_made_) {
        last_resort_made_ = true;
        const SkFontStyle style(
            static_cast<int>(request_.weight), request_.stretch,
            static_cast<SkFontStyle::Slant>(request_.style));
        const LastResortFont font = LastResortFace(
            c_collection_, request_, style, query_.coretext, std::nullopt);
        if (font.face) {
          last_resort_ = {
              font.face, Allowed(SynthesizeStyle(c_collection_, font.face.get(),
                                                 font.base.get(), request_),
                                 allowed_)};
        }
      }
      if (last_resort_.face && covers(last_resort_.face.get())) {
        return last_resort_;
      }
      return {list_.front(), list_synthetic_.front()};
    }

   private:
    SystemFallbackFont SystemFont(uint32_t hint, Priority priority) {
      return SystemFallbackFor(c_collection_, query_, hint, priority);
    }

    skiac_font_collection* c_collection_;
    std::vector<sk_sp<SkTypeface>> list_;
    std::vector<SyntheticStyle> list_synthetic_;
    SyntheticStyle allowed_ = {true, true};
    std::vector<skiac_text_family> families_;
    skiac_text_request request_{};
    SystemFallbackRequest query_;
    RunFont last_resort_;
    bool last_resort_made_ = false;
  };

  // Primitive's layout of each run, one after another on one line.
  void Emit(SkSpan<const char> utf8,
            const std::vector<Run>& runs,
            const Options& options,
            RunHandler* handler) const {
    std::vector<RunHandler::RunInfo> infos;
    infos.reserve(runs.size());
    for (const Run& run : runs) {
      const char* text = utf8.data() + run.start;
      const size_t bytes = run.end - run.start;
      const size_t glyphs = SkUTF::CountUTF8(text, bytes);
      const SkScalar tracking =
          options.tracking * run.font.getSize() * run.font.getScaleX();
      infos.push_back(
          {run.font,
           0,
           0,
           "",
           {run.font.measureText(text, bytes, SkTextEncoding::kUTF8) +
                glyphs * tracking,
            0},
           glyphs,
           RunHandler::Range(run.start, bytes)});
    }
    handler->beginLine();
    for (const RunHandler::RunInfo& info : infos) {
      if (info.glyphCount) {
        handler->runInfo(info);
      }
    }
    handler->commitRunInfo();
    for (size_t r = 0; r < runs.size(); ++r) {
      const RunHandler::RunInfo& info = infos[r];
      if (!info.glyphCount) {
        continue;
      }
      const SkFont& font = runs[r].font;
      const char* text = utf8.data() + runs[r].start;
      const size_t bytes = runs[r].end - runs[r].start;
      std::vector<SkGlyphID> glyphs(info.glyphCount);
      font.textToGlyphs(text, bytes, SkTextEncoding::kUTF8, glyphs);
      std::vector<SkScalar> advances(info.glyphCount);
      font.getWidths(glyphs, advances);
      const SkScalar tracking =
          options.tracking * font.getSize() * font.getScaleX();
      const RunHandler::Buffer buffer = handler->runBuffer(info);
      memcpy(buffer.glyphs, glyphs.data(), info.glyphCount * sizeof(SkGlyphID));
      SkPoint position = buffer.point;
      for (size_t i = 0; i < info.glyphCount; ++i) {
        buffer.positions[i] = position;
        position.fX += advances[i] + tracking;
      }
      if (buffer.clusters) {
        const char* at = text;
        for (size_t i = 0; i < info.glyphCount; ++i) {
          buffer.clusters[i] = SkToU32(at - utf8.data());
          SkUTF::NextUTF8(&at, text + bytes);
        }
      }
      handler->commitRunBuffer(info);
    }
    handler->commitLine();
  }

  skiac_font_collection* c_collection_;
  const SvgFontMgr* mgr_;
  std::unique_ptr<SkShaper> primitive_;
};

// SkShapers::Primitive::Factory with SvgRunShaper for `mgr`'s documents.
class SvgShapingFactory final : public SkShapers::Factory {
 public:
  SvgShapingFactory(skiac_font_collection* c_collection, const SvgFontMgr* mgr)
      : c_collection_(c_collection), mgr_(mgr) {}

  std::unique_ptr<SkShaper> makeShaper(sk_sp<SkFontMgr>) override {
    return std::make_unique<SvgRunShaper>(c_collection_, mgr_);
  }
  std::unique_ptr<SkShaper::BiDiRunIterator>
  makeBidiRunIterator(const char*, size_t, uint8_t) override {
    return std::make_unique<SkShaper::TrivialBiDiRunIterator>(0, 0);
  }
  std::unique_ptr<SkShaper::ScriptRunIterator>
  makeScriptRunIterator(const char*, size_t, SkFourByteTag) override {
    return std::make_unique<SkShaper::TrivialScriptRunIterator>(0, 0);
  }
  SkUnicode* getUnicode() override { return nullptr; }

 private:
  skiac_font_collection* c_collection_;
  const SvgFontMgr* mgr_;
};

class Resources final : public skresources::ResourceProvider {
 public:
  struct Entry {
    // 0 raster, 1 SVG document.
    uint8_t kind = 0;
    // Raster: Blink's InterpolationQuality, 0 none, 1 low, 2 medium.
    uint8_t quality = 2;
    sk_sp<SkData> data;
    // SVG: the frame (rounded container) and the root's laid-out size.
    int frame_width = 0;
    int frame_height = 0;
    float root_width = 0;
    float root_height = 0;
    // Made on first use.
    sk_sp<SkImage> image;
    skiac_image_levels* levels = nullptr;
    sk_sp<SkPicture> picture;
    // The font collection's families_generation `picture` was recorded in.
    uint64_t picture_fonts = 0;
    bool loading = false;
  };

  Resources(const skiac_svg_resource* images,
            size_t count,
            sk_sp<SvgFontMgr> font_mgr,
            skiac_font_collection* c_collection)
      : font_mgr_(std::move(font_mgr)), c_collection_(c_collection) {
    entries_.resize(count);
    // Rasters of one URL share their bytes in Rust; decode them once.
    std::unordered_map<const uint8_t*, size_t> first;
    for (size_t i = 0; i < count; ++i) {
      Entry& e = entries_[i];
      e.kind = images[i].kind;
      e.quality = images[i].quality;
      e.frame_width = images[i].frame_width;
      e.frame_height = images[i].frame_height;
      e.root_width = images[i].root_width;
      e.root_height = images[i].root_height;
      if (e.kind == 0) {
        auto [it, inserted] = first.emplace(images[i].data, i);
        if (!inserted) {
          shared_raster_[i] = it->second;
          continue;
        }
      }
      e.data = SkData::MakeWithCopy(images[i].data, images[i].length);
    }
  }

  ~Resources() override {
    for (Entry& e : entries_) {
      if (e.levels) {
        skiac_image_levels_destroy(e.levels, nullptr, nullptr);
      }
    }
  }

  sk_sp<skresources::ImageAsset> loadImageAsset(const char[],
                                                const char name[],
                                                const char[]) const override {
    auto* self = const_cast<Resources*>(this);
    long index = IndexAfter(name, kImagePrefix);
    if (index < 0) {
      index = IndexAfter(name, kSvgPrefix);
    }
    if (index < 0 || static_cast<size_t>(index) >= entries_.size()) {
      return nullptr;
    }
    sk_sp<SkImage> image = self->imageFor(static_cast<size_t>(index));
    if (!image) {
      return nullptr;
    }
    self->by_id_[image->uniqueID()] = static_cast<size_t>(index);
    return sk_make_sp<StaticAsset>(std::move(image));
  }

  // The entry `image` (from loadImageAsset) stands for, or null.
  Entry* find(const SkImage* image) {
    auto it = by_id_.find(image->uniqueID());
    return it == by_id_.end() ? nullptr : &entries_[it->second];
  }

  // The nested document of an SVG entry, recorded once and again after a
  // font is registered, removed or aliased: the picture keeps the typefaces
  // its text resolved to, where the top level resolves them at each render.
  sk_sp<SkPicture> picture(Entry* e) {
    const uint64_t fonts = c_collection_->families_generation;
    if ((e->picture && e->picture_fonts == fonts) || e->loading || !e->data) {
      return e->picture;
    }
    e->loading = true;
    e->picture = nullptr;
    e->picture_fonts = fonts;
    SkMemoryStream stream(e->data);
    // Not kept: the document refs this provider.
    sk_sp<SkSVGDOM> dom =
        SkSVGDOM::Builder()
            .setFontManager(font_mgr_)
            .setResourceProvider(sk_ref_sp(this))
            .setTextShapingFactory(
                sk_make_sp<SvgShapingFactory>(c_collection_, font_mgr_.get()))
            .make(stream);
    if (dom) {
      const SkRect root = SkRect::MakeWH(e->root_width, e->root_height);
      dom->setContainerSize(SkSize::Make(e->root_width, e->root_height));
      SkPictureRecorder recorder;
      dom->render(recorder.beginRecording(root));
      e->picture = recorder.finishRecordingAsPicture();
    }
    e->loading = false;
    return e->picture;
  }

  int nested_draws_left = kNestedDrawBudget;

  // Forgets the font request of the document's text, after a draw.
  void EndText() const { font_mgr_->EndText(); }

  // What the entries keep for the document's life: the encoded copies, the
  // decoded rasters (one per URL), their scaled copies and the nested
  // documents' pictures. Rasters are decoded at the first draw that needs
  // them, so this grows as the document draws.
  size_t retainedBytes() const {
    size_t bytes = 0;
    for (size_t i = 0; i < entries_.size(); ++i) {
      const Entry& e = entries_[i];
      if (e.data) {
        bytes += e.data->size();
      }
      if (e.levels) {
        bytes += skiac_image_levels_bytes(e.levels);
      }
      if (e.picture) {
        bytes += e.picture->approximateBytesUsed();
      }
      SkPixmap pixels;
      if (e.kind == 0 && e.image && !shared_raster_.count(i) &&
          e.image->peekPixels(&pixels)) {
        bytes += pixels.computeByteSize();
      }
    }
    return bytes;
  }

 private:
  sk_sp<SkImage> imageFor(size_t index) {
    auto shared = shared_raster_.find(index);
    Entry& e = entries_[index];
    if (e.image) {
      return e.image;
    }
    if (shared != shared_raster_.end()) {
      // The same pixels as another quality of the URL, in an image of its
      // own: images are told apart by uniqueID.
      sk_sp<SkImage> pixels = imageFor(shared->second);
      SkPixmap pixmap;
      if (pixels && pixels->peekPixels(&pixmap)) {
        e.image = SkImages::RasterFromPixmap(
            pixmap,
            [](const void*, void* context) {
              static_cast<SkImage*>(context)->unref();
            },
            pixels.release());
      }
      return e.image;
    }
    if (!e.data) {
      return nullptr;
    }
    if (e.kind == 0) {
      // As an Image decodes (premultiplied, EXIF-oriented).
      skiac_bitmap_info info{};
      if (skiac_bitmap_make_from_buffer(e.data->bytes(), e.data->size(),
                                        &info)) {
        auto* bitmap = reinterpret_cast<SkBitmap*>(info.bitmap);
        e.image = SkImages::RasterFromBitmap(*bitmap);
        delete bitmap;
      }
    } else if (e.frame_width > 0 && e.frame_height > 0) {
      // A stand-in with the frame's size: SkSVGImage maps its bounds onto
      // the <image> box, and ChromeSvgCanvas draws the document there.
      SkPictureRecorder recorder;
      recorder.beginRecording(SkRect::MakeIWH(e.frame_width, e.frame_height));
      e.image = SkImages::DeferredFromPicture(
          recorder.finishRecordingAsPicture(),
          SkISize::Make(e.frame_width, e.frame_height), nullptr, nullptr,
          SkImages::BitDepth::kU8, SkColorSpace::MakeSRGB());
    }
    return e.image;
  }

  std::vector<Entry> entries_;
  std::unordered_map<size_t, size_t> shared_raster_;
  std::unordered_map<uint32_t, size_t> by_id_;
  sk_sp<SvgFontMgr> font_mgr_;
  skiac_font_collection* c_collection_;

  friend class ChromeSvgCanvas;
};

class ChromeSvgCanvas final : public SkNWayCanvas {
 public:
  ChromeSvgCanvas(SkCanvas* target, Resources* resources, uint8_t cs)
      : SkNWayCanvas(target->getBaseLayerSize().width(),
                     target->getBaseLayerSize().height()),
        target_(target),
        resources_(resources),
        cs_(cs) {
    this->addCanvas(target);
    this->setMatrix(target->getLocalToDevice());
  }

 protected:
  void onDrawImage2(const SkImage* image,
                    SkScalar x,
                    SkScalar y,
                    const SkSamplingOptions& sampling,
                    const SkPaint* paint) override {
    this->onDrawImageRect2(
        image, SkRect::Make(image->bounds()),
        SkRect::MakeXYWH(x, y, image->width(), image->height()), sampling,
        paint, kFast_SrcRectConstraint);
  }

  void onDrawImageRect2(const SkImage* image,
                        const SkRect& src,
                        const SkRect& dst,
                        const SkSamplingOptions& sampling,
                        const SkPaint* paint,
                        SrcRectConstraint constraint) override {
    Resources::Entry* e = resources_->find(image);
    if (!e) {
      SkNWayCanvas::onDrawImageRect2(image, src, dst, sampling, paint,
                                     constraint);
      return;
    }
    if (e->kind == 1) {
      this->drawNestedSvg(e, dst, paint);
      return;
    }
    // GraphicsContext::DrawImage (graphics_context.cc:531-541): the fill
    // flags (anti-aliased), drawn from the decode cache at the element's
    // interpolation quality and clamped to the source rect
    // (Image::kClampImageToSourceRect).
    SkPaint p = paint ? *paint : SkPaint();
    p.setAntiAlias(true);
    SkPixmap original;
    sk_sp<SkImage> raster = sk_ref_sp(const_cast<SkImage*>(image));
    if (!raster->peekPixels(&original)) {
      return;
    }
    if (!e->levels) {
      e->levels = skiac_image_levels_create();
    }
    const SkM44 matrix =
        this->getLocalToDevice() * SkM44(SkMatrix::RectToRect(src, dst));
    DrawDecodedImage(target_, nullptr, raster, original, e->levels, cs_, src,
                     dst, matrix, e->quality, p,
                     SkCanvas::kStrict_SrcRectConstraint);
  }

  // Blink draws SVG text with the platform's font flags, as canvas text
  // (FontPlatformData::CreateSkFont), where SkSVG sets its own (no
  // hinting, AA edging).
  void onDrawTextBlob(const SkTextBlob* blob,
                      SkScalar x,
                      SkScalar y,
                      const SkPaint& paint) override {
    skiac_text_request request{};
    request.size_adjust_metric = -1;
    const TextRasterPolicy policy(request);
    const SkMatrix device = this->getTotalMatrix();
    for (SkTextBlobRunIterator it(blob); !it.done(); it.next()) {
      const SkFont font = policy.DrawFont(it.font(), &device);
      const int count = static_cast<int>(it.glyphCount());
      SkTextBlobBuilder builder;
      const SkTextBlobBuilder::RunBuffer* run = nullptr;
      size_t scalars = 0;
      switch (it.positioning()) {
        case SkTextBlobRunIterator::kDefault_Positioning:
          run =
              &builder.allocRun(font, count, it.offset().x(), it.offset().y());
          break;
        case SkTextBlobRunIterator::kHorizontal_Positioning:
          run = &builder.allocRunPosH(font, count, it.offset().y());
          scalars = 1;
          break;
        case SkTextBlobRunIterator::kFull_Positioning:
          run = &builder.allocRunPos(font, count);
          scalars = 2;
          break;
        case SkTextBlobRunIterator::kRSXform_Positioning:
          run = &builder.allocRunRSXform(font, count);
          scalars = 4;
          break;
      }
      memcpy(run->glyphs, it.glyphs(), count * sizeof(SkGlyphID));
      if (scalars) {
        memcpy(run->pos, it.pos(), count * scalars * sizeof(SkScalar));
      }
      sk_sp<SkTextBlob> rebuilt = builder.make();
      if (rebuilt) {
        SkNWayCanvas::onDrawTextBlob(rebuilt.get(), x, y,
                                     policy.DrawPaint(font, paint));
      }
    }
  }

  // A nested document's picture plays back through this canvas, so its
  // images and text are drawn as above.
  void onDrawPicture(const SkPicture* picture,
                     const SkMatrix* matrix,
                     const SkPaint* paint) override {
    SkCanvas::onDrawPicture(picture, matrix, paint);
  }

 private:
  // SVGImage::DrawInternal (svg_image.cc:513-558): a layer for alpha, a
  // color filter or a blend mode; a hard clip to the box rounded out; the
  // root (laid out at the LayoutUnit-floored container size, measured in
  // img5.cjs) mapped onto the box, and its overflow clip.
  void drawNestedSvg(Resources::Entry* e,
                     const SkRect& dst,
                     const SkPaint* paint) {
    if (resources_->nested_draws_left <= 0) {
      return;
    }
    --resources_->nested_draws_left;
    sk_sp<SkPicture> picture = resources_->picture(e);
    if (!picture) {
      return;
    }
    SkAutoCanvasRestore restore(this, false);
    if (paint && (paint->getAlphaf() < 1 || paint->getColorFilter() ||
                  !paint->isSrcOver())) {
      this->saveLayer(&dst, paint);
    }
    this->save();
    this->clipRect(SkRect::Make(dst.roundOut()), false);
    const SkRect root = SkRect::MakeWH(e->root_width, e->root_height);
    this->concat(SkMatrix::RectToRect(root, dst));
    this->clipRect(root, true);
    this->drawPicture(picture);
  }

  SkCanvas* target_;
  Resources* resources_;
  uint8_t cs_;
};

}  // namespace

sk_sp<SkSVGDOM> MakePreparedDocument(
    SkStream& stream,
    skiac_font_collection* c_collection,
    const skiac_svg_resource* images,
    size_t image_count,
    const skiac_svg_font_list* fonts,
    size_t font_count,
    sk_sp<skresources::ResourceProvider>* resources) {
  auto font_mgr = sk_make_sp<SvgFontMgr>(c_collection, fonts, font_count);
  auto provider =
      sk_make_sp<Resources>(images, image_count, font_mgr, c_collection);
  sk_sp<SkSVGDOM> dom =
      SkSVGDOM::Builder()
          .setFontManager(font_mgr)
          .setResourceProvider(provider)
          .setTextShapingFactory(
              sk_make_sp<SvgShapingFactory>(c_collection, font_mgr.get()))
          .make(stream);
  *resources = std::move(provider);
  return dom;
}

sk_sp<SkSVGDOM> MakeTextToPathDocument(SkStream& stream,
                                       skiac_font_collection* c_collection,
                                       const skiac_svg_font_list* fonts,
                                       size_t font_count,
                                       bool prepared) {
  auto font_mgr =
      sk_make_sp<SvgFontMgr>(c_collection, fonts, font_count, !prepared);
  return SkSVGDOM::Builder()
      .setFontManager(font_mgr)
      .setTextShapingFactory(
          sk_make_sp<SvgShapingFactory>(c_collection, font_mgr.get()))
      .make(stream);
}

void RenderPrepared(SkSVGDOM* dom,
                    skresources::ResourceProvider* resources,
                    SkCanvas* canvas,
                    uint8_t cs) {
  auto* provider = static_cast<Resources*>(resources);
  provider->nested_draws_left = kNestedDrawBudget;
  ChromeSvgCanvas chrome(canvas, provider, cs);
  dom->render(&chrome);
  provider->EndText();
}

size_t RetainedBytes(const skresources::ResourceProvider* resources) {
  return static_cast<const Resources*>(resources)->retainedBytes();
}

}  // namespace napi_svg

extern "C" {

// The size of an encoded image as an Image decodes it (EXIF-oriented); false
// when Skia cannot decode it.
bool skiac_svg_image_size(const uint8_t* data,
                          size_t length,
                          int* width,
                          int* height) {
  auto codec = SkCodec::MakeFromData(SkData::MakeWithoutCopy(data, length));
  if (!codec) {
    return false;
  }
  SkISize size = codec->dimensions();
  if (SkEncodedOriginSwapsWidthHeight(codec->getOrigin())) {
    size = SkISize::Make(size.height(), size.width());
  }
  *width = size.width();
  *height = size.height();
  return !size.isEmpty();
}

}  // extern "C"
