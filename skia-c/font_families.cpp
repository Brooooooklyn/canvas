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
//
// By default every OS uses Linux's rules and settings, so the same fonts give
// the same families everywhere. Each OS's own rules (CoreText matching, the
// Windows renames, the per-OS settings) apply after setTextRenderer('system').

#include <math.h>
#include <string.h>
#include <algorithm>
#include <string>
#include <string_view>
#include <vector>

#include <src/core/SkUTF.h>

// Before text.hpp: CoreText's headers declare a global TextRange, which
// skia_c.hpp's `using namespace skia::textlayout` would make ambiguous.
#if defined(__APPLE__)
#include <CoreText/CoreText.h>
#endif

#include "icu_api.h"
#include "shaper.hpp"
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

#if defined(__APPLE__)
// The family of CoreText's UI font in skiac_font_collection::system_ui.
constexpr char kSystemUiFamily[] = "system-ui";
#endif

#if defined(_WIN32)
constexpr bool kWindows = true;
#else
constexpr bool kWindows = false;
#endif
// Linux and Android, whose rules every OS uses by default.
#if defined(__APPLE__) || defined(_WIN32)
constexpr bool kFontconfigOs = false;
#else
constexpr bool kFontconfigOs = true;
#endif

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

#if defined(__APPLE__)
// Whether an installed font has the family `name`, asked with CoreText's
// auto-activation disallowed. Blink's font_matcher_mac.mm runs in the
// sandboxed renderer, where CoreText cannot download a font, so a
// downloadable font that is not installed is not available. CoreText's own
// matching (SkFontMgr_Mac) would download it instead and wait for the font
// registry's UI, which never answers without a login session (macOS CI:
// the zh-TW host's font settings kept a process waiting for ever).
bool HasInstalledFamily(std::string_view name) {
  CFStringRef family = CFStringCreateWithBytes(
      kCFAllocatorDefault, reinterpret_cast<const UInt8*>(name.data()),
      static_cast<CFIndex>(name.size()), kCFStringEncodingUTF8, false);
  if (!family) {
    return false;
  }
  const void* keys[] = {kCTFontFamilyNameAttribute};
  const void* values[] = {family};
  CFDictionaryRef attributes = CFDictionaryCreate(
      kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFRelease(family);
  CTFontDescriptorRef descriptor =
      CTFontDescriptorCreateWithAttributes(attributes);
  CFRelease(attributes);
  const void* descriptors[] = {descriptor};
  CFArrayRef request = CFArrayCreate(kCFAllocatorDefault, descriptors, 1,
                                     &kCFTypeArrayCallBacks);
  CFRelease(descriptor);
  const void* option_keys[] = {kCTFontCollectionDisallowAutoActivationOption};
  const void* option_values[] = {kCFBooleanTrue};
  CFDictionaryRef options = CFDictionaryCreate(
      kCFAllocatorDefault, option_keys, option_values, 1,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CTFontCollectionRef collection =
      CTFontCollectionCreateWithFontDescriptors(request, options);
  CFRelease(request);
  CFRelease(options);
  CFArrayRef matches =
      collection ? CTFontCollectionCreateMatchingFontDescriptors(collection)
                 : nullptr;
  if (collection) {
    CFRelease(collection);
  }
  const bool found = matches && CFArrayGetCount(matches) > 0;
  if (matches) {
    CFRelease(matches);
  }
  return found;
}
#endif

class FamilyResolver {
 public:
  explicit FamilyResolver(skiac_font_collection* c_collection)
      : c_collection_(c_collection), system_(SystemFontRenderer()) {
    IndexFamilies(c_collection);
  }

  // Whether this lookup uses the OS's own rules (setTextRenderer('system')),
  // read once so one lookup never mixes modes.
  bool system() const { return system_; }

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

  // Whether `name` is a font the program registered (a web font: Blink's
  // FontFaceCache), not an installed one the collection lists (macOS).
  // FontFaceCache::Get finds the family by name and takes its best face for
  // any request, so one registered face of any style makes the family a web
  // font, also next to installed faces of the same name (Chrome 157: a bold
  // FontFace "AppleMyungjo", lang ja "40px AppleMyungjo, -webkit-body" and
  // "bold 40px AppleMyungjo, -webkit-body" draw the FontFace, 53.28).
  // A setAlias name is a FontFace(alias, local(family)): in FontFaceCache
  // whatever face it names, an installed one too (Chrome 157: FontFace
  // "BrandFont" or "Helvetica" with local(Arial), lang ja "40px BrandFont,
  // -webkit-body" draws Arial, 48.93). removeFont and removeAll drop the
  // aliases of the families they remove, and an alias whose family a
  // rebuild does not find is not listed again (not active).
  // Every spelling of the name counts (FontFaceCache folds case: Chrome
  // 157, FontFace "helvetica": "40px Helvetica" and "40px HELVETICA" draw
  // the FontFace, 47.64).
  bool IsWebFont(std::string_view name) const {
    if (!IsRegistered(name)) {
      return false;
    }
    const std::string folded = Fold(name);
    auto it = c_collection_->folded_families.find(folded);
    if (it == c_collection_->folded_families.end()) {
      return false;
    }
    for (const auto& entry : c_collection_->set_aliases) {
      if (entry.active && Fold(entry.alias) == folded) {
        return true;
      }
    }
    for (const auto& spelling : it->second) {
      const sk_sp<SkFontStyleSet> faces =
          c_collection_->assets->matchFamily(spelling.c_str());
      for (int i = 0; faces && i < faces->count(); ++i) {
        const sk_sp<SkTypeface> face = faces->createTypeface(i);
        if (face && !IsSystemTypeface(c_collection_, face.get())) {
          return true;
        }
      }
    }
    return false;
  }

  // FontCache::GetFontData(description, name): the platform font manager's
  // match for one family name. A family registered over an installed one
  // (both kinds of faces, Kinds) is a FontFace that only a family list
  // naming it uses (CSSFontSelector::GetFontData asks FontFaceCache for a
  // named family only): the font cache gives the installed faces, under the
  // tagged name "\x01i\x01" + family (MakeSplitFamily). Chrome 157, Lato
  // FontFace "Helvetica": "40px sans-serif" is still Helvetica, 48.93;
  // "Times": "40px serif" is still Times, 48.89 (followups/
  // item1-registered-installed-family/cmp.txt). A name no installed font
  // has keeps serving every lookup (Node has no other way to give a
  // fontless host its fonts; a deviation).
  bool FindSystem(std::string_view name, std::string* out) const {
    if (!name.empty() && name.front() == '\x01') {
      return false;  // a tagged name is never asked for
    }
    if (!FindSystem(name, out, true)) {
      return false;
    }
#if defined(__APPLE__)
    if (system_ && *out == kSystemUiFamily) {
      return true;
    }
#endif
    const uint8_t kinds = Kinds(*out);
    if ((kinds & kWebFaces) &&
        (kinds & (kInstalledFaces | kInstalledElsewhere))) {
      *out = std::string(kInstalledTag) + *out;
    }
    return true;
  }

  // A web font (IsWebFont) named by a family list: FontFaceCache's faces
  // only, for every style (CSSSegmentedFontFace picks among them, and
  // synthesizes bold or italic from them). When the family also has
  // installed faces in `assets`, under the tagged name "\x01w\x01" +
  // family (MakeSplitFamily). Chrome 157, Lato FontFace "Helvetica":
  // "bold 40px Helvetica" is Lato, 47.64; FontFace "Helvetica" with
  // local(Arial) (setAlias('Arial', 'Helvetica')): bold is Arial made bold,
  // 48.93.
  bool FindWebFont(std::string_view name, std::string* out) const {
    if (!Find(name, out)) {
      return false;
    }
    if (Kinds(*out) & kInstalledFaces) {
      *out = std::string(kWebTag) + *out;
      return true;
    }
    // `assets` matches a name case-sensitively: the spelling it has when
    // `name` is the spelling of an installed family outside it (Lato
    // registered as "helvetica", "40px Helvetica").
    if (!HasAssetsFamily(*out)) {
      for (const auto& spelling :
           c_collection_->folded_families.at(Fold(name))) {
        if (HasAssetsFamily(spelling)) {
          *out = spelling;
          break;
        }
      }
    }
    return true;
  }

  // The faces of a tagged name (MakeSplitFamily): `web` the family's web
  // faces, in registration order, else its installed faces in `assets`.
  // `elsewhere` gets the installed family outside `assets` when there is
  // none in it.
  std::vector<sk_sp<SkTypeface>> Faces(std::string_view name,
                                       bool web,
                                       sk_sp<SkFontStyleSet>* elsewhere) const {
    std::vector<sk_sp<SkTypeface>> faces;
    const std::string folded = Fold(name);
    std::vector<SkTypefaceID> aliases;
    for (const auto& entry : c_collection_->set_aliases) {
      if (entry.active && entry.face_id && Fold(entry.alias) == folded) {
        aliases.push_back(entry.face_id);
      }
    }
    auto it = c_collection_->folded_families.find(folded);
    if (it != c_collection_->folded_families.end()) {
      for (const auto& spelling : it->second) {
        // The provider's own family, not a tagged one.
        const sk_sp<SkFontStyleSet> set =
            c_collection_->assets->TypefaceFontProvider::onMatchFamily(
                spelling.c_str());
        for (int i = 0; set && i < set->count(); ++i) {
          sk_sp<SkTypeface> face = set->createTypeface(i);
          if (!face) {
            continue;
          }
          const bool alias = std::find(aliases.begin(), aliases.end(),
                                       face->uniqueID()) != aliases.end();
          const bool system = IsSystemTypeface(c_collection_, face.get());
          SkString family;
          face->getFamilyName(&family);
          const bool own = Fold({family.c_str(), family.size()}) == folded;
          // A registered face of the family itself (registerFromPath of a
          // font file, which also registers it under its own name next to
          // an alias) is that family again, not a FontFace over it: it is
          // neither kind, and the family keeps its installed faces first
          // (a deviation: a FontFace of its own name would win in Chrome).
          const bool keep = web ? alias || (!system && !own) : system && own;
          if (keep &&
              std::find(faces.begin(), faces.end(), face) == faces.end()) {
            faces.push_back(std::move(face));
          }
        }
      }
    }
    if (!web && faces.empty() && elsewhere) {
      *elsewhere = InstalledElsewhere(name);
    }
    return faces;
  }

 private:
  static constexpr char kInstalledTag[] = "\x01i\x01";
  static constexpr char kWebTag[] = "\x01w\x01";
  static constexpr uint8_t kWebFaces = 1;
  static constexpr uint8_t kInstalledFaces = 2;
  static constexpr uint8_t kInstalledElsewhere = 4;

  // Which kinds of faces the family `name` has, all its spellings
  // together (FontFaceCache folds case): web faces (a registered face of
  // another family, or the face a setAlias call names), installed faces in
  // `assets` (an installed face of that family: loadSystemFonts,
  // loadFontsFromDir), and an installed family outside `assets` (CoreText's
  // match with the system renderer, else the asset font manager's). Only a
  // family `assets` has can have web faces; cached per families_generation.
  uint8_t Kinds(std::string_view name) const {
    if (!IsRegistered(name)) {
      return 0;
    }
    if (c_collection_->family_kinds_generation !=
        c_collection_->families_generation) {
      c_collection_->family_kinds.clear();
      c_collection_->family_kinds_generation =
          c_collection_->families_generation;
    }
    std::string key = Fold(name);
    auto found = c_collection_->family_kinds.find(key);
    if (found != c_collection_->family_kinds.end()) {
      return found->second;
    }
    uint8_t kinds = 0;
    if (!Faces(name, true, nullptr).empty()) {
      kinds |= kWebFaces;
      if (!Faces(name, false, nullptr).empty()) {
        kinds |= kInstalledFaces;
      } else if (InstalledElsewhere(name)) {
        kinds |= kInstalledElsewhere;
      }
    }
    c_collection_->family_kinds.emplace(std::move(key), kinds);
    return kinds;
  }

  // Whether `assets` itself has the family spelled `spelling`.
  bool HasAssetsFamily(const std::string& spelling) const {
    const sk_sp<SkFontStyleSet> set =
        c_collection_->assets->TypefaceFontProvider::onMatchFamily(
            spelling.c_str());
    return set && set->count() > 0;
  }

  // The installed family `name` outside `assets`, null for none.
  sk_sp<SkFontStyleSet> InstalledElsewhere(std::string_view name) const {
    const sk_sp<SkFontMgr>& manager = c_collection_->font_mgr;
    if (!manager) {
      return nullptr;
    }
    std::string family(name);
#if defined(__APPLE__)
    // CoreText's match, never a download (MatchCoreText).
    if (system_ && !MatchCoreText(name, &family)) {
      return nullptr;
    }
#endif
    sk_sp<SkFontStyleSet> set = manager->matchFamily(family.c_str());
    return set && set->count() > 0 ? set : nullptr;
  }
  bool FindSystem(std::string_view name,
                  std::string* out,
                  bool allow_alternate) const {
#if defined(_WIN32)
    if (system_) {
      name = AdjustFamilyNameToAvoidUnsupportedFonts(name);
    }
#endif
    if (!name.empty() && Find(name, out)) {
      return true;
    }
#if defined(__APPLE__)
    if (system_) {
      // font_cache_mac.mm CreateFontPlatformData: the family "system-ui"
      // (also quoted, and BlinkMacSystemFont) is CoreText's UI font
      // (MatchSystemUIFont), compared case-sensitively.
      if (name == kSystemUiFamily) {
        if (!c_collection_->system_ui) {
          return false;
        }
        *out = kSystemUiFamily;
        return true;
      }
      if (MatchCoreText(name, out)) {
        return true;
      }
    }
#endif
    if ((!system_ || kFontconfigOs) && FindFontconfig(name, out)) {
      return true;
    }
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
          HasInstalledFamily(name)
              ? manager->matchFamily(std::string(name).c_str())
              : nullptr;
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
  std::string_view AlternateFamilyName(std::string_view name) const {
    if (EqualsIgnoringAsciiCase(name, "Courier")) {
      return "Courier New";
    }
    if (!(kWindows && system_) &&
        EqualsIgnoringAsciiCase(name, "Courier New")) {
      return "Courier";
    }
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
  bool system_;
};

// Chrome's default font settings (WebPreferences *_font_family_map), from
// chrome/app/resources/locale_settings_{mac,linux,win}.grd; Linux's unless
// `system`. Windows uses IDS_FIXED_FONT_FAMILY_ALT_WIN (Consolas) when
// ClearType is on, the Windows default.
const char* SettingsFamily(int generic, bool system) {
#if defined(__APPLE__)
  if (system) {
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
  }
#elif defined(_WIN32)
  if (system) {
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
  }
#else
  (void)system;
#endif
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
}

// FontCache::SystemFontFamily for `system-ui`; Linux's unless `system`.
const char* SystemUiFamily(bool system) {
#if defined(__APPLE__)
  if (system) {
    return kSystemUiFamily;  // CoreText's UI font (skiac_font_collection)
  }
#elif defined(_WIN32)
  if (system) {
    return "Segoe UI";
  }
#else
  (void)system;
#endif
  return "sans";  // the desktop default, fontconfig's sans-serif
}

// `script_setting`, when not empty, is the setting of the locale's script
// for this generic family (LocaleFamilies::generic), in place of the common
// one. `*registered` is whether `out` is the family registered under the
// keyword.
bool ResolveGeneric(const FamilyResolver& resolver,
                    int generic,
                    std::string_view script_setting,
                    std::string* out,
                    bool* registered) {
  // A family registered under the keyword itself is how a Node program sets
  // its generic families (decision: the registered alias wins).
  const char* keyword = GenericKeyword(generic);
  *registered = resolver.IsRegistered(keyword) && resolver.Find(keyword, out);
  if (*registered) {
    return true;
  }
  if (generic == kSystemUi) {
    return resolver.FindSystem(SystemUiFamily(resolver.system()), out);
  }
  // CSSFontSelector::GetFontData: the settings family
  // (GenericFontFamilySettings::Serif(script) etc.: the script's own when it
  // has one, else the common one), then FontFallbackList asks the font cache
  // for the generic name itself (FontBuilder::GenericFontFamilyName:
  // -webkit-body is -webkit-standard).
  const char* common = SettingsFamily(generic, resolver.system());
  const std::string_view settings = !script_setting.empty() ? script_setting
                                    : common ? std::string_view(common)
                                             : std::string_view();
  if (!settings.empty() && resolver.FindSystem(settings, out)) {
    return true;
  }
  return resolver.FindSystem(
      generic == kWebkitBody ? "-webkit-standard" : keyword, out);
}

// FontCache::GetLastResortFallbackFont: macOS asks for Times, then Lucida
// Grande (font_cache_mac.mm); the other platforms for the generic family of
// the description (alternate_font_family.h GetFallbackFontFamily), "Sans" and
// "Arial", and Windows for a few more (font_cache_skia.cc). Linux's unless
// the system renderer is on.
bool ResolveLastResort(const FamilyResolver& resolver,
                       int description_generic,
                       std::string* out) {
#if defined(__APPLE__)
  if (resolver.system()) {
    return resolver.FindSystem("Times", out) ||
           resolver.FindSystem("Lucida Grande", out);
  }
#endif
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
  if (resolver.system()) {
    for (const char* name : {"MS UI Gothic", "Microsoft Sans Serif", "Segoe UI",
                             "Calibri", "Times New Roman", "Courier New"}) {
      if (resolver.FindSystem(name, out)) {
        return true;
      }
    }
  }
#endif
  return false;
}

// After the family list, FontFallbackList::GetFontData tries the standard
// font (-webkit-standard through the settings), then the last resort.
bool ResolveStandard(const FamilyResolver& resolver,
                     int description_generic,
                     std::string* out) {
  return resolver.FindSystem(SettingsFamily(kWebkitBody, resolver.system()),
                             out) ||
         ResolveLastResort(resolver, description_generic, out);
}

// Whether `name` is one of ScriptNameToCode's names
// (locale_to_script_mapping.cc kScriptNameCodeList) other than "zzzz"
// (USCRIPT_UNKNOWN, which does not end a walk) and the Japanese, Korean,
// Han and Devanagari ones, 4 letters each.
bool IsOtherScriptName(std::string_view name) {
  static constexpr std::string_view kNames =
      "zyyy qaai arab armn beng bopo cher copt cyrl dsrt ethi geor goth grek "
      "gujr guru hani hebr knda khmr laoo latn mlym mong mymr ogam ital orya "
      "runr sinh syrc taml telu thaa thai tibt cans yiii tglg hano buhd tagb "
      "brai cprt limb linb osma shaw tale ugar bugi glag khar sylo talu tfng "
      "xpeo bali batk blis brah cham cirt cyrs egyd egyh egyp geok hmng hung "
      "inds java kali latf latg lepc lina mand maya mero nkoo orkh perm phag "
      "phnx plrd roro sara syre syrj syrn teng vaii visp xsux zxxx";
  if (name.size() != 4) {
    return false;
  }
  // Letters only, so that the search matches one whole name ("y qa" would
  // match across "zyyy qaai").
  std::string lower(name);
  for (char& c : lower) {
    c = static_cast<char>(c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c);
    if (c < 'a' || c > 'z') {
      return false;
    }
  }
  return kNames.find(lower) != std::string_view::npos;
}

// The scripts macOS Chrome has a standard font of their own for
// (locale_settings_mac.grd IDS_STANDARD_FONT_FAMILY_*); the others use the
// common one, Times. (On every OS also the Han script of a locale,
// HanScriptForLocale.)
enum class StandardScript {
  kCommon,
  kJapanese,
  kKorean,
  kSimplifiedHan,
  kTraditionalHan,
  kDevanagari,
};

// locale_to_script_mapping.cc LocaleToScriptCodeForFontSelection, telling
// only the scripts above apart. Its list's other entries are all a bare
// language, so they end the search where the tag has no subtag left anyway.
// With `whole_tag`, the list entry `lang` is, without the walk (kCommon
// when it is none: no entry is kCommon).
StandardScript LocaleStandardScript(std::string_view lang,
                                    bool whole_tag = false) {
  struct Subtag {
    const char* subtag;
    StandardScript script;
  };
  static constexpr Subtag kLocaleScripts[] = {
      {"hi", StandardScript::kDevanagari},
      {"ja", StandardScript::kJapanese},
      {"ko", StandardScript::kKorean},
      {"kok", StandardScript::kDevanagari},
      {"mai", StandardScript::kDevanagari},
      {"mr", StandardScript::kDevanagari},
      {"ne", StandardScript::kDevanagari},
      {"sa", StandardScript::kDevanagari},
      {"zh", StandardScript::kSimplifiedHan},
      {"cdo", StandardScript::kSimplifiedHan},
      {"cjy", StandardScript::kSimplifiedHan},
      {"cmn", StandardScript::kSimplifiedHan},
      {"cpx", StandardScript::kSimplifiedHan},
      {"czh", StandardScript::kSimplifiedHan},
      {"czo", StandardScript::kSimplifiedHan},
      {"gan", StandardScript::kSimplifiedHan},
      {"hsn", StandardScript::kSimplifiedHan},
      {"mnp", StandardScript::kSimplifiedHan},
      {"wuu", StandardScript::kSimplifiedHan},
      {"hak", StandardScript::kTraditionalHan},
      {"lzh", StandardScript::kTraditionalHan},
      {"nan", StandardScript::kTraditionalHan},
      {"yue", StandardScript::kTraditionalHan},
      {"zh-cdo", StandardScript::kSimplifiedHan},
      {"zh-cjy", StandardScript::kSimplifiedHan},
      {"zh-cmn", StandardScript::kSimplifiedHan},
      {"zh-cpx", StandardScript::kSimplifiedHan},
      {"zh-czh", StandardScript::kSimplifiedHan},
      {"zh-czo", StandardScript::kSimplifiedHan},
      {"zh-gan", StandardScript::kSimplifiedHan},
      {"zh-hsn", StandardScript::kSimplifiedHan},
      {"zh-mnp", StandardScript::kSimplifiedHan},
      {"zh-wuu", StandardScript::kSimplifiedHan},
      {"zh-hak", StandardScript::kTraditionalHan},
      {"zh-lzh", StandardScript::kTraditionalHan},
      {"zh-nan", StandardScript::kTraditionalHan},
      {"zh-yue", StandardScript::kTraditionalHan},
      {"zh-hk", StandardScript::kTraditionalHan},
      {"zh-mo", StandardScript::kTraditionalHan},
      {"zh-tw", StandardScript::kTraditionalHan},
  };
  // ScriptNameToCode: a 4-letter subtag naming a script of its list (every
  // name but "zzzz", USCRIPT_UNKNOWN) ends the search.
  static constexpr Subtag kScriptNames[] = {
      {"deva", StandardScript::kDevanagari},
      {"hang", StandardScript::kKorean},
      {"kore", StandardScript::kKorean},
      {"hira", StandardScript::kJapanese},
      {"kana", StandardScript::kJapanese},
      {"hrkt", StandardScript::kJapanese},
      {"jpan", StandardScript::kJapanese},
      {"hans", StandardScript::kSimplifiedHan},
      {"hant", StandardScript::kTraditionalHan},
  };
  // No list entry is longer than 6 bytes: a longer whole tag is none, without
  // the copy (HanScriptForLocale asks once per subtag of the tag).
  if (whole_tag && lang.size() > 6) {
    return StandardScript::kCommon;
  }
  // BCP 47's '-', also for ICU's '_'.
  std::string tag(lang);
  std::replace(tag.begin(), tag.end(), '_', '-');
  std::string_view view(tag);
  while (!view.empty()) {
    // Only a view of at most 6 bytes can be a list entry: a long tag walks
    // without the compares.
    if (view.size() <= 6) {
      for (const Subtag& entry : kLocaleScripts) {
        if (EqualsIgnoringAsciiCase(view, entry.subtag)) {
          return entry.script;
        }
      }
    }
    if (whole_tag) {
      break;
    }
    const size_t pos = view.rfind('-');
    if (pos == std::string_view::npos) {
      break;
    }
    if (view.size() - (pos + 1) == 4) {
      const std::string_view name = view.substr(pos + 1);
      for (const Subtag& entry : kScriptNames) {
        if (EqualsIgnoringAsciiCase(name, entry.subtag)) {
          return entry.script;
        }
      }
      // The list's other names: scripts with the common standard font.
      if (IsOtherScriptName(name)) {
        return StandardScript::kCommon;
      }
    }
    view = view.substr(0, pos);
  }
  return StandardScript::kCommon;
}

}  // namespace

int HanScriptForLocale(std::string_view lang) {
  // ScriptNameToCode's names (locale_to_script_mapping.cc; "zzzz", Unknown,
  // is not one): 0 for a script that is not an unambiguous Han script.
  auto script_name = [](std::string_view name) -> int {
    struct Name {
      const char* name;
      int script;
    };
    static constexpr Name kHan[] = {
        {"hang", USCRIPT_HANGUL},
        {"hira", USCRIPT_KATAKANA_OR_HIRAGANA},
        {"kana", USCRIPT_KATAKANA_OR_HIRAGANA},
        {"hrkt", USCRIPT_KATAKANA_OR_HIRAGANA},
        {"hans", USCRIPT_SIMPLIFIED_HAN},
        {"hant", USCRIPT_TRADITIONAL_HAN},
        {"jpan", USCRIPT_KATAKANA_OR_HIRAGANA},
        {"kore", USCRIPT_HANGUL},
    };
    for (const Name& entry : kHan) {
      if (EqualsIgnoringAsciiCase(name, entry.name)) {
        return entry.script;
      }
    }
    // Every other name ("deva" too).
    return IsOtherScriptName(name) || EqualsIgnoringAsciiCase(name, "deva")
               ? 0
               : -1;
  };
  // LayoutLocale::ComputeScriptForHan: the locale's script
  // (LocaleToScriptCodeForFontSelection) when it is an unambiguous Han
  // script, ...
  std::string tag(lang);
  std::replace(tag.begin(), tag.end(), '_', '-');
  std::string_view view(tag);
  while (!view.empty()) {
    // A listed tag ends the walk (the list's other entries are bare
    // languages, which end it too).
    const StandardScript standard = LocaleStandardScript(view, true);
    // From the end: a forward search would scan a long first subtag once per
    // step of the walk.
    const size_t pos = view.rfind('-');
    if (standard != StandardScript::kCommon || pos == view.npos) {
      switch (standard) {
        case StandardScript::kJapanese:
          return USCRIPT_KATAKANA_OR_HIRAGANA;
        case StandardScript::kKorean:
          return USCRIPT_HANGUL;
        case StandardScript::kSimplifiedHan:
          return USCRIPT_SIMPLIFIED_HAN;
        case StandardScript::kTraditionalHan:
          return USCRIPT_TRADITIONAL_HAN;
        default:
          break;
      }
      break;
    }
    if (view.size() - (pos + 1) == 4) {
      const int script = script_name(view.substr(pos + 1));
      if (script > 0) {
        return script;
      }
      if (script == 0) {
        break;
      }
    }
    view = view.substr(0, pos);
  }
  // ... else the first region or script subtag naming one
  // (ScriptCodeForHanFromSubtags, on the locale as given), else Simplified
  // Han.
  struct Region {
    const char* region;
    int script;
  };
  static constexpr Region kRegions[] = {
      {"hk", USCRIPT_TRADITIONAL_HAN}, {"jp", USCRIPT_KATAKANA_OR_HIRAGANA},
      {"kr", USCRIPT_HANGUL},          {"mo", USCRIPT_TRADITIONAL_HAN},
      {"tw", USCRIPT_TRADITIONAL_HAN},
  };
  size_t end = lang.find('-');
  while (end != std::string_view::npos) {
    const size_t begin = end + 1;
    end = lang.find('-', begin);
    const std::string_view subtag = lang.substr(
        begin, (end == std::string_view::npos ? lang.size() : end) - begin);
    if (subtag.size() == 2) {
      for (const Region& entry : kRegions) {
        if (EqualsIgnoringAsciiCase(subtag, entry.region)) {
          return entry.script;
        }
      }
    } else if (subtag.size() == 4) {
      if (const int script = script_name(subtag); script > 0) {
        return script;
      }
    }
  }
  return USCRIPT_SIMPLIFIED_HAN;
}

std::vector<SkString> ResolveFontFamilies(skiac_font_collection* c_collection,
                                          const skiac_text_request& request,
                                          std::vector<bool>* generic,
                                          const LocaleFamilies* locale) {
  FamilyResolver resolver(c_collection);
  std::vector<SkString> resolved;
  auto add = [&resolved, generic](const std::string& name, bool is_generic) {
    for (const auto& family : resolved) {
      if (family.equals(name.c_str(), name.size())) {
        return;
      }
    }
    resolved.emplace_back(name.c_str(), name.size());
    if (generic) {
      generic->push_back(is_generic);
    }
  };
  // StyleBuilderConverterBase::ConvertFontFamily: the description's generic
  // family is the last serif / sans-serif / cursive / fantasy / monospace /
  // -webkit-body in the list.
  int description_generic = kNamed;
  for (size_t i = 0; i < request.family_count; ++i) {
    const int g = request.families[i].generic;
    if (g && g != kSystemUi && g != kMath) {
      description_generic = g;
    }
  }
  // FontSelector::FamilyNameFromSettings: when the description's generic
  // family is -webkit-body, CSSFontSelector::GetFontData gives every family
  // of the list that is not a web font (system-ui, math, the other generic
  // families and installed names too) Standard(script), before the font
  // cache sees the name. Chrome 157: lang ja "40px Helvetica, -webkit-body"
  // and "40px serif, -webkit-body" "Ag" are Hiragino Kaku Gothic ProN 55.64,
  // no lang "40px Helvetica, -webkit-body" is Times 48.89. Only with the
  // shaper's locale settings.
  std::string body_standard;
  if (locale && description_generic == kWebkitBody) {
    body_standard = locale->standard;
    if (body_standard.empty() &&
        !resolver.FindSystem(SettingsFamily(kWebkitBody, resolver.system()),
                             &body_standard)) {
      body_standard.clear();
    }
  }
  for (size_t i = 0; i < request.family_count; ++i) {
    const auto& family = request.families[i];
    if (!body_standard.empty() &&
        !(family.generic
              ? resolver.IsRegistered(GenericKeyword(family.generic))
              : resolver.IsWebFont({family.name, family.name_len}))) {
      add(body_standard, true);
      continue;
    }
    std::string name;
    bool found;
    bool registered = false;
    if (family.generic) {
      found =
          ResolveGeneric(resolver, family.generic,
                         locale && family.generic > 0 && family.generic < 9
                             ? std::string_view(locale->generic[family.generic])
                             : std::string_view(),
                         &name, &registered);
    } else {
      // FontFallbackList does not ask the system for an empty name. A web
      // font comes from FontFaceCache, before the font cache.
      const std::string_view named(family.name, family.name_len);
      found = !named.empty() && named.front() != '\x01' &&
              (resolver.IsWebFont(named) ? resolver.FindWebFont(named, &name)
                                         : resolver.FindSystem(named, &name));
    }
    if (found) {
      // A -webkit-body that is not the description's generic family is
      // named after the common standard font (FontBuilder::
      // GenericFontFamilyName) and comes from the font cache by that name,
      // as an installed family (with the shaper's locale settings). A
      // family registered under -webkit-body (setAlias) stays a generic
      // family, as one registered under serif does.
      add(name, family.generic != kNamed &&
                    !(locale && family.generic == kWebkitBody && !registered));
    }
  }
  // The standard font comes through the font selector as a generic family
  // (-webkit-standard): the one of the locale's script when the caller has
  // it, else the common one.
  std::string standard(locale ? locale->standard : std::string());
  if (!standard.empty() ||
      ResolveStandard(resolver, description_generic, &standard)) {
    add(standard, true);
  }
  return resolved;
}

std::string LastResortFamily(skiac_font_collection* c_collection,
                             const skiac_text_request& request) {
  FamilyResolver resolver(c_collection);
  // The description's generic family, as ResolveFontFamilies finds it.
  int description_generic = kNamed;
  for (size_t i = 0; i < request.family_count; ++i) {
    const int generic = request.families[i].generic;
    if (generic && generic != kSystemUi && generic != kMath) {
      description_generic = generic;
    }
  }
  std::string name;
  if (!ResolveLastResort(resolver, description_generic, &name)) {
    name.clear();
  }
  return name;
}

std::string LocaleStandardFamily(skiac_font_collection* c_collection,
                                 std::string_view lang,
                                 std::string_view host_language) {
#if defined(__APPLE__)
  FamilyResolver resolver(c_collection);
  if (!resolver.system() || lang.empty()) {
    return {};
  }
  const StandardScript script = LocaleStandardScript(lang);
  // PrefsTabHelper::RegisterProfilePrefs: Chrome has no default per-script
  // font for the script of its UI locale (GetScriptOfBrowserLocale), so that
  // script gets the common standard font. Chrome 157 with -AppleLanguages
  // (ja): lang "ja" draws "→" like "en" (Times, then the system fallback),
  // and with (zh-Hant-TW) "ja" gets Hiragino and "zh-TW" does not.
  if (script == LocaleStandardScript(host_language)) {
    return {};
  }
  // GenericFontFamilySettings::Standard: a list (a leading ',') is its first
  // available family (FontCache::FirstAvailableOrFirst).
  std::vector<const char*> names;
  switch (script) {
    case StandardScript::kJapanese:
      names = {"Hiragino Kaku Gothic ProN"};
      break;
    case StandardScript::kKorean:
      names = {"Apple SD Gothic Neo"};
      break;
    case StandardScript::kSimplifiedHan:
      names = {"PingFang SC", "STHeiti"};
      break;
    case StandardScript::kTraditionalHan:
      names = {"PingFang TC", "Heiti TC"};
      break;
    case StandardScript::kDevanagari:
      names = {"Devanagari MT"};
      break;
    case StandardScript::kCommon:
      break;
  }
  std::string name;
  for (const char* candidate : names) {
    if (resolver.FindSystem(candidate, &name)) {
      return name;
    }
  }
#else
  (void)c_collection;
  (void)lang;
  (void)host_language;
#endif
  return {};
}

LocaleFamilies LocaleFontFamilies(skiac_font_collection* c_collection,
                                  std::string_view lang,
                                  std::string_view host_language) {
  LocaleFamilies families;
  families.standard = LocaleStandardFamily(c_collection, lang, host_language);
#if defined(__APPLE__)
  FamilyResolver resolver(c_collection);
  if (!resolver.system() || lang.empty()) {
    return families;
  }
  // locale_settings_mac.grd IDS_{SERIF,SANS_SERIF,CURSIVE,FIXED}_FONT_FAMILY_*
  // as kFontDefaults registers them on macOS. A list (a leading ',') is its
  // first available family (gfx::FontList::FirstAvailableOrFirst), the same
  // lists as the standard font's.
  struct Settings {
    std::vector<const char*> standard;
    std::vector<const char*> serif;
    std::vector<const char*> sans_serif;
    std::vector<const char*> cursive;
    std::vector<const char*> monospace;
  };
  // The common entries (USCRIPT_COMMON) come from the UI locale's own
  // locale_settings_mac_<ui>.xtb, which changes them for ja, ko, zh-CN,
  // zh-TW, ar, he and fa; empty: the en ones (SettingsFamily). Desktop
  // Chrome 157 with -AppleLanguages (ja): no lang and lang "en" / "ar"
  // "40px serif Ag" 50.84 (Hiragino Mincho ProN), "40px BSNo Ag" with
  // (zh-TW) 49.92 (PingFang TC); (ar) "40px monospace Ag" 48.01 (Courier
  // New). Headless Chrome does not apply the common entries (its common
  // monospace is Courier on every host), so these come from headed captures.
  // The ja UI's fixed font ",Osaka,BIZ UDGothic,Menlo" is not modeled
  // (Osaka-Mono, below) and keeps Menlo.
  Settings common;
  if (host_language == "ja") {
    common = {{"Hiragino Kaku Gothic ProN"},
              {"Hiragino Mincho ProN"},
              {"Hiragino Kaku Gothic ProN"},
              {},
              {}};
  } else if (host_language == "ko") {
    common = {{"Apple SD Gothic Neo"},
              {"AppleMyungjo"},
              {"Apple SD Gothic Neo"},
              {},
              {}};
  } else if (host_language == "zh-CN") {
    common = {{"PingFang SC", "STHeiti"},
              {"Songti SC"},
              {"PingFang SC", "STHeiti"},
              {"Kaiti SC"},
              {}};
  } else if (host_language == "zh-TW") {
    common = {{"PingFang TC", "Heiti TC"},
              {"Songti TC"},
              {"PingFang TC", "Heiti TC"},
              {"Kaiti TC"},
              {}};
  } else if (host_language == "ar" || host_language == "he" ||
             host_language == "fa") {
    common = {{}, {"Times New Roman"}, {"Arial"}, {}, {"Courier New"}};
  }
  // The same scripts and host rule as the standard font: PrefsTabHelper::
  // RegisterProfilePrefs registers the per-script defaults of every generic
  // family in one loop (kFontDefaults) and skips them all for the script of
  // the UI locale, which then gets the common entries. Not modeled: the
  // Japanese fixed font (",Osaka,BIZ UDGothic,Menlo", Osaka, which Fixed()
  // turns into Osaka-Mono): Osaka-Mono is the "Regular-Mono" face of the
  // family Osaka, which only the PostScript-name match of font_matcher_mac.mm
  // MatchFontFamily finds; lang "ja" monospace keeps the common Menlo.
  Settings own;
  const StandardScript script = LocaleStandardScript(lang);
  if (script != LocaleStandardScript(host_language)) {
    switch (script) {
      case StandardScript::kJapanese:
        own = {{},
               {"Hiragino Mincho ProN"},
               {"Hiragino Kaku Gothic ProN"},
               {},
               {}};
        break;
      case StandardScript::kKorean:
        own = {{}, {"AppleMyungjo"}, {"Apple SD Gothic Neo"}, {}, {}};
        break;
      case StandardScript::kSimplifiedHan:
        own = {{}, {"Songti SC"}, {"PingFang SC", "STHeiti"}, {"Kaiti SC"}, {}};
        break;
      case StandardScript::kTraditionalHan:
        own = {
            {}, {"Songti TC"}, {"PingFang TC", "Heiti TC"}, {"Kaiti TC"}, {}};
        break;
      case StandardScript::kDevanagari:
        own = {{}, {"Devanagari MT"}, {"Kohinoor Devanagari"}, {}, {"Menlo"}};
        break;
      case StandardScript::kCommon:
        break;
    }
  }
  auto first_available = [&resolver](const std::vector<const char*>& names) {
    std::string name;
    for (const char* candidate : names) {
      if (resolver.FindSystem(candidate, &name)) {
        return std::string(candidate);
      }
    }
    return names.empty() ? std::string() : std::string(names.front());
  };
  // GenericFontFamilySettings::GenericFontFamilyForScript: the script's own
  // entry, else the common one.
  auto setting = [&first_available](
                     const std::vector<const char*>& script_own,
                     const std::vector<const char*>& common_one) {
    return first_available(!script_own.empty() ? script_own : common_one);
  };
  families.generic[kSerif] = setting(own.serif, common.serif);
  families.generic[kSansSerif] = setting(own.sans_serif, common.sans_serif);
  families.generic[kCursive] = setting(own.cursive, common.cursive);
  families.generic[kMonospace] = setting(own.monospace, common.monospace);
  // A -webkit-body entry is named after Standard() of the common script
  // (FontBuilder::GenericFontFamilyName); as the description's generic
  // family it is Standard(script) (ResolveFontFamilies).
  families.generic[kWebkitBody] = first_available(common.standard);
  // Standard(script): LocaleStandardFamily, else the common entry.
  if (families.standard.empty()) {
    std::string name;
    for (const char* candidate : common.standard) {
      if (resolver.FindSystem(candidate, &name)) {
        families.standard = name;
        break;
      }
    }
  }
#else
  (void)host_language;
#endif
  return families;
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
  if (resolver.system() && metrics.fXHeight) {
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

sk_sp<SkFontStyleSet> MakeSplitFamily(skiac_font_collection* c_collection,
                                      std::string_view tagged) {
  // "\x01" kind "\x01" family (FamilyResolver::FindSystem, FindWebFont).
  if (tagged.size() < 4 || tagged[0] != '\x01' || tagged[2] != '\x01' ||
      (tagged[1] != 'i' && tagged[1] != 'w')) {
    return nullptr;
  }
  const std::string_view name = tagged.substr(3);
  FamilyResolver resolver(c_collection);
  sk_sp<SkFontStyleSet> elsewhere;
  std::vector<sk_sp<SkTypeface>> faces =
      resolver.Faces(name, tagged[1] == 'w', &elsewhere);
  if (faces.empty()) {
    return elsewhere;
  }
  auto set =
      sk_make_sp<TypefaceFontStyleSet>(SkString(name.data(), name.size()));
  for (auto& face : faces) {
    set->appendTypeface(std::move(face));
  }
  return set;
}

sk_sp<SkTypeface> MatchNamedFamily(skiac_font_collection* c_collection,
                                   const char* family,
                                   const SkFontStyle& style) {
  // The named branch of ResolveFontFamilies: a web font by FindWebFont's
  // name, a tagged one from its split set. A name that starts with \x01 is
  // no family (the tags), as for a font list.
  if (family[0] == '\x01') {
    return nullptr;
  }
  FamilyResolver resolver(c_collection);
  std::string name;
  if (family[0] && resolver.IsWebFont(family) &&
      resolver.FindWebFont(family, &name)) {
    const sk_sp<SkFontStyleSet> set =
        name.front() == '\x01'
            ? MakeSplitFamily(c_collection, name)
            : c_collection->assets->matchFamily(name.c_str());
    return set ? set->matchStyle(style) : nullptr;
  }
  return c_collection->assets->matchFamilyStyle(family, style);
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
