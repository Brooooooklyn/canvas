// Which installed or registered family each canvas font family uses, like
// Blink's FontFallbackList::GetFontData and the platform FontCache.
//
//   family list ──> named family ──> case-folded lookup (FontFaceCache /
//               │                    fontconfig / CoreText match any case)
//               │                    ──> Linux: metric-compatible names,
//               │                        sans / serif / monospace lists
//               │                    ──> AlternateFamilyName
//               └─> generic family ──> a registered family with that name
//                                  ──> the platform setting (Chrome's
//                                      locale_settings_{mac,linux,win}.grd)
//                                  ──> the keyword as a family name
//   then the standard font (-webkit-standard), else the last resort.

#include <math.h>
#include <string.h>
#include <algorithm>
#include <string>
#include <string_view>
#include <vector>

#include <src/core/SkUTF.h>

#include "text.hpp"
#include "text_raster.hpp"

#if defined(SK_DEBUG) || !defined(SK_RELEASE)
#error "skia-c must be built with SK_RELEASE like libskia (see build.rs)"
#endif

// ICU (libskunicode_icu), unversioned symbols; the ICU headers are not part of
// the Skia checkout the addon builds against.
extern "C" int32_t u_foldCase(int32_t c, uint32_t options);

namespace {

constexpr uint32_t kFoldCaseDefault = 0;  // U_FOLD_CASE_DEFAULT

enum Generic {
  kNamed = 0,
  kSerif = 1,
  kSansSerif = 2,
  kCursive = 3,
  kFantasy = 4,
  kMonospace = 5,
  kSystemUi = 6,
  kWebkitBody = 7,
  kMath = 8,
};

const char* GenericKeyword(int generic) {
  switch (generic) {
    case kSerif:
      return "serif";
    case kSansSerif:
      return "sans-serif";
    case kCursive:
      return "cursive";
    case kFantasy:
      return "fantasy";
    case kMonospace:
      return "monospace";
    case kSystemUi:
      return "system-ui";
    case kWebkitBody:
      return "-webkit-body";
    case kMath:
      return "math";
    default:
      return "";
  }
}

// Unicode simple case folding (u_foldCase), like Blink's CaseFoldingHash for
// FontFace families.
std::string Fold(std::string_view name) {
  std::string folded;
  folded.reserve(name.size());
  const char* p = name.data();
  const char* end = p + name.size();
  while (p < end) {
    const char* start = p;
    SkUnichar c = SkUTF::NextUTF8(&p, end);
    if (c < 0) {
      // Not UTF-8 (a face's own name table): keep the byte.
      p = start + 1;
      folded.push_back(*start);
      continue;
    }
    char utf8[SkUTF::kMaxBytesInUTF8Sequence];
    size_t len = SkUTF::ToUTF8(u_foldCase(c, kFoldCaseDefault), utf8);
    folded.append(utf8, len);
  }
  return folded;
}

bool EqualsIgnoringAsciiCase(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) {
    return false;
  }
  for (size_t i = 0; i < a.size(); ++i) {
    char x = a[i];
    char y = b[i];
    if (x >= 'A' && x <= 'Z') {
      x = static_cast<char>(x - 'A' + 'a');
    }
    if (y >= 'A' && y <= 'Z') {
      y = static_cast<char>(y - 'A' + 'a');
    }
    if (x != y) {
      return false;
    }
  }
  return true;
}

void IndexFamilies(skiac_font_collection* c_collection) {
  if (c_collection->folded_families_generation ==
      c_collection->families_generation) {
    return;
  }
  auto& families = c_collection->folded_families;
  auto& registered = c_collection->folded_registered_families;
  families.clear();
  registered.clear();
  auto add = [&](SkFontMgr* manager, bool is_registered) {
    if (!manager) {
      return;
    }
    const int count = manager->countFamilies();
    for (int i = 0; i < count; ++i) {
      SkString name;
      manager->getFamilyName(i, &name);
      if (name.isEmpty()) {
        continue;
      }
      std::string key = Fold({name.c_str(), name.size()});
      auto& spellings = families[key];
      std::string spelling(name.c_str(), name.size());
      if (std::find(spellings.begin(), spellings.end(), spelling) ==
          spellings.end()) {
        spellings.push_back(std::move(spelling));
      }
      if (is_registered) {
        registered.insert(std::move(key));
      }
    }
  };
  // FontCollection asks the dynamic provider (GlobalFonts) first.
  add(c_collection->assets.get(), true);
  add(c_collection->font_mgr.get(), false);
  c_collection->folded_families_generation = c_collection->families_generation;
}

class FamilyResolver {
 public:
  explicit FamilyResolver(skiac_font_collection* c_collection)
      : c_collection_(c_collection) {
    IndexFamilies(c_collection);
  }

  // The spelling of `name` the collection knows, matched case-insensitively;
  // the exact spelling wins when two families fold alike.
  bool Find(std::string_view name, std::string* out) const {
    auto it = c_collection_->folded_families.find(Fold(name));
    if (it == c_collection_->folded_families.end()) {
      return false;
    }
    for (const auto& spelling : it->second) {
      if (spelling == name) {
        *out = spelling;
        return true;
      }
    }
    *out = it->second.front();
    return true;
  }

  bool IsRegistered(std::string_view name) const {
    return c_collection_->folded_registered_families.count(Fold(name)) > 0;
  }

  // FontCache::GetFontData(description, name): the platform font manager's
  // match for one family name.
  bool FindSystem(std::string_view name, std::string* out) const {
    return FindSystem(name, out, true);
  }

 private:
  bool FindSystem(std::string_view name,
                  std::string* out,
                  bool allow_alternate) const {
#if defined(_WIN32)
    name = AdjustFamilyNameToAvoidUnsupportedFonts(name);
#endif
    if (!name.empty() && Find(name, out)) {
      return true;
    }
#if defined(__APPLE__)
    if (MatchCoreText(name, out)) {
      return true;
    }
#endif
#if !defined(__APPLE__) && !defined(_WIN32)
    if (FindFontconfig(name, out)) {
      return true;
    }
#endif
    if (allow_alternate) {
      std::string_view alternate = AlternateFamilyName(name);
      if (!alternate.empty()) {
        return FindSystem(alternate, out, false);
      }
    }
    return false;
  }

#if defined(__APPLE__)
  // font_matcher_mac.mm MatchFontFamily: CoreText also matches families it
  // does not list (Times and Courier on macOS 27), in any case. Never a dot
  // name (font_cache_mac.mm IsSystemFontName) or LastResort.
  bool MatchCoreText(std::string_view name, std::string* out) const {
    const sk_sp<SkFontMgr>& manager = c_collection_->font_mgr;
    if (!manager || name.empty() || name.front() == '.' ||
        EqualsIgnoringAsciiCase(name, "LastResort")) {
      return false;
    }
    std::string key = Fold(name);
    auto& matches = c_collection_->coretext_families;
    auto it = matches.find(key);
    if (it == matches.end()) {
      std::string family;
      sk_sp<SkFontStyleSet> set =
          manager->matchFamily(std::string(name).c_str());
      if (sk_sp<SkTypeface> face =
              set && set->count() > 0 ? set->createTypeface(0) : nullptr) {
        SkString face_family;
        face->getFamilyName(&face_family);
        family.assign(face_family.c_str(), face_family.size());
      }
      it = matches.emplace(std::move(key), std::move(family)).first;
    }
    if (it->second.empty()) {
      return false;
    }
    *out = it->second;
    return true;
  }
#endif

  bool FindFirst(const std::vector<const char*>& names,
                 std::string* out) const {
    for (const char* name : names) {
      if (Find(name, out)) {
        return true;
      }
    }
    return false;
  }

#if !defined(__APPLE__) && !defined(_WIN32)
  // SkFontConfigInterfaceDirect::isAcceptableMatch: a family other than the
  // one asked for is used only when it is metric-compatible
  // (GetFontEquivClass), or when the request is fontconfig's own "sans",
  // "serif" or "monospace" (IsFallbackFontAllowed), whose preference lists
  // come from fontconfig's 60-latin.conf.
  bool FindFontconfig(std::string_view name, std::string* out) const {
    static const std::vector<std::vector<const char*>> kMetricClasses = {
        {"Arial", "Arimo", "Liberation Sans"},
        {"Times New Roman", "Tinos", "Liberation Serif"},
        {"Courier New", "Cousine", "Liberation Mono"},
        {"Symbol", "Symbol Neu"},
        {"Cambria", "Caladea"},
        {"Calibri", "Carlito"},
    };
    for (const auto& names : kMetricClasses) {
      for (const char* member : names) {
        if (EqualsIgnoringAsciiCase(name, member)) {
          return FindFirst(names, out);
        }
      }
    }
    if (name.empty() || EqualsIgnoringAsciiCase(name, "sans")) {
      return FindFirst(FontconfigList(kSansSerif), out);
    }
    if (EqualsIgnoringAsciiCase(name, "serif")) {
      return FindFirst(FontconfigList(kSerif), out);
    }
    if (EqualsIgnoringAsciiCase(name, "monospace")) {
      return FindFirst(FontconfigList(kMonospace), out);
    }
    return false;
  }

  static const std::vector<const char*>& FontconfigList(int generic) {
    static const std::vector<const char*> kSerifList = {
        "Noto Serif", "DejaVu Serif",       "Times New Roman", "Thorndale AMT",
        "Luxi Serif", "Nimbus Roman No9 L", "Nimbus Roman",    "Times"};
    static const std::vector<const char*> kSansList = {
        "Noto Sans",
        "DejaVu Sans",
        "Verdana",
        "Arial",
        "Albany AMT",
        "Luxi Sans",
        "Nimbus Sans L",
        "Nimbus Sans",
        "Helvetica",
        "Lucida Sans Unicode",
        "BPG Glaho International",
        "Tahoma"};
    static const std::vector<const char*> kMonospaceList = {
        "DejaVu Sans Mono", "Noto Mono",   "Noto Sans Mono", "Inconsolata",
        "Andale Mono",      "Courier New", "Cumberland AMT", "Luxi Mono",
        "Nimbus Mono L",    "Nimbus Mono", "Nimbus Mono PS", "Courier"};
    switch (generic) {
      case kSerif:
        return kSerifList;
      case kMonospace:
        return kMonospaceList;
      default:
        return kSansList;
    }
  }
#endif

#if defined(_WIN32)
  // alternate_font_family.h AdjustFamilyNameToAvoidUnsupportedFonts.
  static std::string_view AdjustFamilyNameToAvoidUnsupportedFonts(
      std::string_view name) {
    if (EqualsIgnoringAsciiCase(name, "Courier")) {
      return "Courier New";
    }
    if (EqualsIgnoringAsciiCase(name, "MS Sans Serif")) {
      return "Microsoft Sans Serif";
    }
    if (EqualsIgnoringAsciiCase(name, "MS Serif") ||
        EqualsIgnoringAsciiCase(name, "Times")) {
      return "Times New Roman";
    }
    return name;
  }
#endif

  // alternate_font_family.h AlternateFamilyName.
  static std::string_view AlternateFamilyName(std::string_view name) {
    if (EqualsIgnoringAsciiCase(name, "Courier")) {
      return "Courier New";
    }
#if !defined(_WIN32)
    if (EqualsIgnoringAsciiCase(name, "Courier New")) {
      return "Courier";
    }
#endif
    if (EqualsIgnoringAsciiCase(name, "Times")) {
      return "Times New Roman";
    }
    if (EqualsIgnoringAsciiCase(name, "Times New Roman")) {
      return "Times";
    }
    if (EqualsIgnoringAsciiCase(name, "Arial")) {
      return "Helvetica";
    }
    if (EqualsIgnoringAsciiCase(name, "Helvetica")) {
      return "Arial";
    }
    return {};
  }

  skiac_font_collection* c_collection_;
};

// Chrome's default font settings (WebPreferences *_font_family_map), from
// chrome/app/resources/locale_settings_{mac,linux,win}.grd. Windows uses
// IDS_FIXED_FONT_FAMILY_ALT_WIN (Consolas) when ClearType is on, the
// Windows default.
const char* SettingsFamily(int generic) {
#if defined(__APPLE__)
  switch (generic) {
    case kSerif:
      return "Times";
    case kSansSerif:
      return "Helvetica";
    case kMonospace:
      return "Menlo";
    case kCursive:
      return "Apple Chancery";
    case kFantasy:
      return "Papyrus";
    case kMath:
      return "STIX Two Math";
    case kWebkitBody:
      return "Times";  // standard
    default:
      return nullptr;
  }
#elif defined(_WIN32)
  switch (generic) {
    case kSerif:
      return "Times New Roman";
    case kSansSerif:
      return "Arial";
    case kMonospace:
      return "Consolas";
    case kCursive:
      return "Comic Sans MS";
    case kFantasy:
      return "Impact";
    case kMath:
      return "Cambria Math";
    case kWebkitBody:
      return "Times New Roman";  // standard
    default:
      return nullptr;
  }
#else
  switch (generic) {
    case kSerif:
      return "Times New Roman";
    case kSansSerif:
      return "Arial";
    case kMonospace:
      return "Monospace";
    case kCursive:
      return "Comic Sans MS";
    case kFantasy:
      return "Impact";
    case kMath:
      return "Latin Modern Math";
    case kWebkitBody:
      return "Times New Roman";  // standard
    default:
      return nullptr;
  }
#endif
}

// FontCache::SystemFontFamily for `system-ui`.
const char* SystemUiFamily() {
#if defined(__APPLE__)
  return "System Font";  // SFNS, CoreText's .AppleSystemUIFont
#elif defined(_WIN32)
  return "Segoe UI";
#else
  return "sans";  // the desktop default, fontconfig's sans-serif
#endif
}

bool ResolveGeneric(const FamilyResolver& resolver,
                    int generic,
                    std::string* out) {
  // A family registered under the keyword itself is how a Node program sets
  // its generic families (decision: the registered alias wins).
  const char* keyword = GenericKeyword(generic);
  if (resolver.IsRegistered(keyword) && resolver.Find(keyword, out)) {
    return true;
  }
  if (generic == kSystemUi) {
    return resolver.FindSystem(SystemUiFamily(), out);
  }
  // CSSFontSelector::GetFontData: the settings family, then
  // FontFallbackList asks the font cache for the generic name itself
  // (FontBuilder::GenericFontFamilyName: -webkit-body is -webkit-standard).
  const char* settings = SettingsFamily(generic);
  if (settings && resolver.FindSystem(settings, out)) {
    return true;
  }
  return resolver.FindSystem(
      generic == kWebkitBody ? "-webkit-standard" : keyword, out);
}

// FontCache::GetLastResortFallbackFont: macOS asks for Times, then Lucida
// Grande (font_cache_mac.mm); the other platforms for the generic family of
// the description (alternate_font_family.h GetFallbackFontFamily), "Sans" and
// "Arial", and Windows for a few more (font_cache_skia.cc).
bool ResolveLastResort(const FamilyResolver& resolver,
                       int description_generic,
                       std::string* out) {
#if defined(__APPLE__)
  return resolver.FindSystem("Times", out) ||
         resolver.FindSystem("Lucida Grande", out);
#else
  const char* fallback = "";
  switch (description_generic) {
    case kSerif:
    case kSansSerif:
    case kCursive:
    case kFantasy:
    case kMonospace:
      fallback = GenericKeyword(description_generic);
      break;
    default:
      break;
  }
  if (resolver.FindSystem(fallback, out) || resolver.FindSystem("Sans", out) ||
      resolver.FindSystem("Arial", out)) {
    return true;
  }
#if defined(_WIN32)
  for (const char* name : {"MS UI Gothic", "Microsoft Sans Serif", "Segoe UI",
                           "Calibri", "Times New Roman", "Courier New"}) {
    if (resolver.FindSystem(name, out)) {
      return true;
    }
  }
#endif
  return false;
#endif
}

// After the family list, FontFallbackList::GetFontData tries the standard
// font (-webkit-standard through the settings), then the last resort.
bool ResolveStandard(const FamilyResolver& resolver,
                     int description_generic,
                     std::string* out) {
  return resolver.FindSystem(SettingsFamily(kWebkitBody), out) ||
         ResolveLastResort(resolver, description_generic, out);
}

}  // namespace

std::vector<SkString> ResolveFontFamilies(skiac_font_collection* c_collection,
                                          const skiac_text_request& request) {
  FamilyResolver resolver(c_collection);
  std::vector<SkString> resolved;
  auto add = [&resolved](const std::string& name) {
    for (const auto& family : resolved) {
      if (family.equals(name.c_str(), name.size())) {
        return;
      }
    }
    resolved.emplace_back(name.c_str(), name.size());
  };
  // StyleBuilderConverterBase::ConvertFontFamily: the description's generic
  // family is the last serif / sans-serif / cursive / fantasy / monospace /
  // -webkit-body in the list.
  int description_generic = kNamed;
  for (size_t i = 0; i < request.family_count; ++i) {
    const auto& family = request.families[i];
    std::string name;
    bool found;
    if (family.generic) {
      found = ResolveGeneric(resolver, family.generic, &name);
      if (family.generic != kSystemUi && family.generic != kMath) {
        description_generic = family.generic;
      }
    } else {
      // FontFallbackList does not ask the system for an empty name.
      found = family.name_len > 0 &&
              resolver.FindSystem({family.name, family.name_len}, &name);
    }
    if (found) {
      add(name);
    }
  }
  std::string standard;
  if (ResolveStandard(resolver, description_generic, &standard)) {
    add(standard);
  }
  return resolved;
}

// The canvas parses `font` against a 10px `sans-serif` style made without a
// font selector (canvas_font_cache.cc CreateDefaultFontStyle), so its font is
// the platform's match for the name "sans-serif", which no platform has, and
// then the last resort. Its metrics give `ex`, `ch`, `cap`, `ic` and `lh`
// (css_to_length_conversion_data.cc, simple_font_data.cc PlatformInit).
bool skiac_font_collection_default_font_units(
    skiac_font_collection* c_collection,
    float size,
    skiac_font_units* units) {
  c_collection->flushCachesIfDirty();
  FamilyResolver resolver(c_collection);
  std::string name;
  if (!resolver.FindSystem("sans-serif", &name) &&
      !ResolveLastResort(resolver, kNamed, &name)) {
    return false;
  }
  auto typefaces = c_collection->collection->findTypefaces(
      {SkString(name.c_str(), name.size())}, SkFontStyle());
  if (typefaces.empty() || !typefaces.front()) {
    return false;
  }
  const SkFont font = MetricsFont(typefaces.front(), size);
  SkFontMetrics metrics;
  font.getMetrics(&metrics);
  units->ex = metrics.fXHeight ? metrics.fXHeight : size / 2;
#if defined(__APPLE__)
  // SimpleFontData::PlatformInit: CTFontGetXHeight counts the part of 'x'
  // below the baseline, so Blink measures the glyph's outline instead.
  if (metrics.fXHeight) {
    if (const SkGlyphID x_glyph = font.unicharToGlyph('x')) {
      const std::optional<SkPath> path = font.getPath(x_glyph);
      units->ex =
          -(path ? path->getBounds() : font.getBounds(x_glyph, nullptr)).fTop;
    }
  }
#endif
  units->cap = metrics.fCapHeight;
  SkGlyphID zero = font.unicharToGlyph('0');
  units->ch = zero ? font.getWidth(zero) : size / 2;
  SkGlyphID water = font.unicharToGlyph(0x6C34);
  units->ic = water ? font.getWidth(water) : size;
  // FontMetrics::LineSpacing for line-height: normal.
  float ascent;
  float descent;
  AscentDescentWithHacks(c_collection, font, typefaces.front().get(), &ascent,
                         &descent);
  units->lh = static_cast<float>(lroundf(ascent) + lroundf(descent) +
                                 lroundf(metrics.fLeading));
  return true;
}

uint32_t skiac_font_collection_register_system_font(
    skiac_font_collection* c_collection,
    const char* path) {
  // Installed fonts register first, as loadSystemFonts does elsewhere.
  c_collection->prepareLookup();
  sk_sp<SkTypeface> typeface = MakeCanvasTypefaceFromFile(path);
  if (!typeface) {
    return 0;
  }
  const size_t registered = c_collection->assets->getRegisteredFonts().size();
  const SkTypefaceID typeface_id = typeface->uniqueID();
  const uint32_t id =
      c_collection->assets->registerTypefaceFromPathWithTracking(path,
                                                                 typeface);
  if (!id) {
    return 0;
  }
  // A path registered before (by registerFromPath) stays what it was.
  if (c_collection->assets->getRegisteredFonts().size() > registered) {
    c_collection->system_font_ids.insert(id);
    c_collection->system_typeface_ids.insert(typeface_id);
  }
  c_collection->markCachesDirty();
  return id;
}
