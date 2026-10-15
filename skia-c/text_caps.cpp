// font-variant-caps like Blink's HarfBuzzShaper: the OpenType caps features
// when the font has them (OpenTypeCapsSupport), else small caps made from
// the uppercase letters at 70% of the font size, rounded to whole pixels
// (SimpleFontData::SmallCapsFontData). Each run of letters that changes when
// uppercased, or does not (SmallCapsIterator), is shaped on its own.

#include <math.h>
#include <algorithm>
#include <optional>
#include <string>
#include <vector>

#include <src/core/SkUTF.h>
#include "icu_api.h"
#include "text.hpp"

#if defined(SK_DEBUG) || !defined(SK_RELEASE)
#error "skia-c must be built with SK_RELEASE like libskia (see build.rs)"
#endif

namespace {

// request.variant_caps (FontDescription::FontVariantCaps).
enum VariantCaps {
  kCapsNormal = 0,
  kSmallCaps,
  kAllSmallCaps,
  kPetiteCaps,
  kAllPetiteCaps,
  kUnicase,
  kTitlingCaps,
};

enum class FontSupport { kFull, kFallback, kNone };
enum class CapsSynthesis { kNone, kLowerToSmallCaps, kUpperToSmallCaps, kBoth };
enum class CaseRun { kUppercaseNeeded, kSameCase };

// Bits of the caps features a face has for a script.
enum : uint8_t {
  kSmcp = 1,
  kC2sc = 2,
  kPcap = 4,
  kC2pc = 8,
  kUnic = 16,
  kTitl = 32,
  kChecked = 128,
};

constexpr float kSmallCapsFontSizeMultiplier = 0.7f;

bool AatSelectorPresent(hb_face_t* face,
                        hb_aat_layout_feature_type_t type,
                        hb_aat_layout_feature_selector_t selector) {
  unsigned int count = hb_aat_layout_feature_type_get_selector_infos(
      face, type, 0, nullptr, nullptr, nullptr);
  std::vector<hb_aat_layout_feature_selector_info_t> infos(count);
  unsigned int default_index = 0;
  if (!hb_aat_layout_feature_type_get_selector_infos(
          face, type, 0, &count, infos.data(), &default_index)) {
    return false;
  }
  for (unsigned int i = 0; i < count && i < infos.size(); ++i) {
    if (infos[i].enable == selector) {
      return true;
    }
  }
  return false;
}

// OpenTypeCapsSupport::SupportsAatFeature: only small caps and capitals to
// small caps.
uint8_t AatCapsFeatures(hb_face_t* face) {
  unsigned int count =
      hb_aat_layout_get_feature_types(face, 0, nullptr, nullptr);
  std::vector<hb_aat_layout_feature_type_t> types(count);
  if (!hb_aat_layout_get_feature_types(face, 0, &count, types.data())) {
    return 0;
  }
  types.resize(count);
  auto has = [&](hb_aat_layout_feature_type_t type) {
    return std::find(types.begin(), types.end(), type) != types.end();
  };
  uint8_t features = 0;
  if ((has(HB_AAT_LAYOUT_FEATURE_TYPE_LOWER_CASE) &&
       AatSelectorPresent(
           face, HB_AAT_LAYOUT_FEATURE_TYPE_LOWER_CASE,
           HB_AAT_LAYOUT_FEATURE_SELECTOR_LOWER_CASE_SMALL_CAPS)) ||
      (has(HB_AAT_LAYOUT_FEATURE_TYPE_LETTER_CASE) &&
       AatSelectorPresent(face, HB_AAT_LAYOUT_FEATURE_TYPE_LETTER_CASE,
                          HB_AAT_LAYOUT_FEATURE_SELECTOR_SMALL_CAPS))) {
    features |= kSmcp;
  }
  if (has(HB_AAT_LAYOUT_FEATURE_TYPE_UPPER_CASE) &&
      AatSelectorPresent(
          face, HB_AAT_LAYOUT_FEATURE_TYPE_UPPER_CASE,
          HB_AAT_LAYOUT_FEATURE_SELECTOR_UPPER_CASE_SMALL_CAPS)) {
    features |= kC2sc;
  }
  return features;
}

// SupportsOpenTypeFeature: the GSUB features of the script's default
// language system.
uint8_t OpenTypeCapsFeatures(hb_face_t* face, hb_script_t script) {
  if (!hb_ot_layout_has_substitution(face)) {
    return 0;
  }
  hb_tag_t script_tags[2] = {};
  unsigned int script_count = 2;
  hb_ot_tags_from_script_and_language(script, HB_LANGUAGE_INVALID,
                                      &script_count, script_tags, nullptr,
                                      nullptr);
  unsigned int script_index = 0;
  hb_ot_layout_table_select_script(face, HB_OT_TAG_GSUB, script_count,
                                   script_tags, &script_index, nullptr);
  constexpr std::pair<hb_tag_t, uint8_t> kFeatures[] = {
      {SKIAC_HB_TAG('s', 'm', 'c', 'p'), kSmcp},
      {SKIAC_HB_TAG('c', '2', 's', 'c'), kC2sc},
      {SKIAC_HB_TAG('p', 'c', 'a', 'p'), kPcap},
      {SKIAC_HB_TAG('c', '2', 'p', 'c'), kC2pc},
      {SKIAC_HB_TAG('u', 'n', 'i', 'c'), kUnic},
      {SKIAC_HB_TAG('t', 'i', 't', 'l'), kTitl},
  };
  uint8_t features = 0;
  for (const auto& [tag, bit] : kFeatures) {
    if (hb_ot_layout_language_find_feature(face, HB_OT_TAG_GSUB, script_index,
                                           HB_OT_LAYOUT_DEFAULT_LANGUAGE_INDEX,
                                           tag, nullptr)) {
      features |= bit;
    }
  }
  return features;
}

uint8_t CapsFeatures(skiac_font_collection* c_collection,
                     SkTypeface* face,
                     hb_script_t script) {
  auto& cache = c_collection->caps_features;
  if (cache.size() > 1024) {
    cache.clear();
  }
  uint8_t& features = cache[{face->uniqueID(), script}];
  if (!(features & kChecked)) {
    hb_face_t* hb_face = CreateHbFace(face);
    // GetFontFormat: AAT when the font has morx or mort and no GSUB.
    const bool aat =
        (face->getTableSize(SkSetFourByteTag('m', 'o', 'r', 'x')) ||
         face->getTableSize(SkSetFourByteTag('m', 'o', 'r', 't'))) &&
        !hb_ot_layout_has_substitution(hb_face);
    features = kChecked | (aat ? AatCapsFeatures(hb_face)
                               : OpenTypeCapsFeatures(hb_face, script));
    hb_face_destroy(hb_face);
  }
  return features;
}

struct Support {
  FontSupport font = FontSupport::kFull;
  CapsSynthesis synthesis = CapsSynthesis::kNone;
};

// OpenTypeCapsSupport::DetermineFontSupport.
Support DetermineFontSupport(int caps, uint8_t has) {
  Support s;
  const bool smcp = has & kSmcp;
  const bool c2sc = has & kC2sc;
  switch (caps) {
    case kSmallCaps:
      if (!smcp) {
        s = {FontSupport::kNone, CapsSynthesis::kLowerToSmallCaps};
      }
      break;
    case kAllSmallCaps:
      if (!(smcp && c2sc)) {
        s = {FontSupport::kNone, CapsSynthesis::kBoth};
      }
      break;
    case kPetiteCaps:
      if (!(has & kPcap)) {
        s = smcp
                ? Support{FontSupport::kFallback, CapsSynthesis::kNone}
                : Support{FontSupport::kNone, CapsSynthesis::kLowerToSmallCaps};
      }
      break;
    case kAllPetiteCaps:
      if (!((has & kPcap) && (has & kC2pc))) {
        s = smcp && c2sc ? Support{FontSupport::kFallback, CapsSynthesis::kNone}
                         : Support{FontSupport::kNone, CapsSynthesis::kBoth};
      }
      break;
    case kUnicase:
      if (!(has & kUnic)) {
        s = {smcp ? FontSupport::kFallback : FontSupport::kNone,
             CapsSynthesis::kUpperToSmallCaps};
      }
      break;
    case kTitlingCaps:
      if (!(has & kTitl)) {
        s.font = FontSupport::kNone;
      }
      break;
    default:
      break;
  }
  return s;
}

// FontFeatureToUse.
int FeatureToUse(const Support& s, int caps, CaseRun run) {
  if (s.font == FontSupport::kFull) {
    return caps;
  }
  if (s.font == FontSupport::kFallback) {
    if (caps == kAllPetiteCaps) {
      return kAllSmallCaps;
    }
    if (caps == kPetiteCaps ||
        (caps == kUnicase && run == CaseRun::kSameCase)) {
      return kSmallCaps;
    }
  }
  return kCapsNormal;
}

enum class CaseMapIntend { kKeepSameCase, kUpperCase, kLowerCase };

// NeedsCaseChange.
CaseMapIntend CaseChange(const Support& s, CaseRun run) {
  if (s.font == FontSupport::kFull) {
    return CaseMapIntend::kKeepSameCase;
  }
  if (run == CaseRun::kSameCase) {
    return s.font == FontSupport::kFallback &&
                   (s.synthesis == CapsSynthesis::kBoth ||
                    s.synthesis == CapsSynthesis::kUpperToSmallCaps)
               ? CaseMapIntend::kLowerCase
               : CaseMapIntend::kKeepSameCase;
  }
  return s.font != FontSupport::kFallback &&
                 (s.synthesis == CapsSynthesis::kLowerToSmallCaps ||
                  s.synthesis == CapsSynthesis::kBoth)
             ? CaseMapIntend::kUpperCase
             : CaseMapIntend::kKeepSameCase;
}

// NeedsSyntheticFont.
bool SyntheticFont(const Support& s, int caps, CaseRun run) {
  if (s.font != FontSupport::kNone || caps == kTitlingCaps) {
    return false;
  }
  if (run == CaseRun::kUppercaseNeeded) {
    return s.synthesis == CapsSynthesis::kLowerToSmallCaps ||
           s.synthesis == CapsSynthesis::kBoth;
  }
  return s.synthesis == CapsSynthesis::kUpperToSmallCaps ||
         s.synthesis == CapsSynthesis::kBoth;
}

// CaseMap::Locale: the ICU locale for case mapping, root for most
// languages.
bool LocaleMatches(std::string_view locale, std::string_view lang) {
  if (locale.size() < lang.size()) {
    return false;
  }
  for (size_t i = 0; i < lang.size(); ++i) {
    char c = locale[i];
    if (c >= 'A' && c <= 'Z') {
      c = static_cast<char>(c - 'A' + 'a');
    }
    if (c != lang[i]) {
      return false;
    }
  }
  return locale.size() == lang.size() || locale[lang.size()] == '-' ||
         locale[lang.size()] == '_' || locale[lang.size()] == '@';
}

const char* CaseMapLocale(const skiac_text_request& request) {
  const std::string_view lang(request.lang ? request.lang : "",
                              request.lang ? request.lang_len : 0);
  if (LocaleMatches(lang, "tr") || LocaleMatches(lang, "az")) {
    return "tr";
  }
  if (LocaleMatches(lang, "el")) {
    return "el";
  }
  if (LocaleMatches(lang, "lt")) {
    return "lt";
  }
  if (LocaleMatches(lang, "nl")) {
    return "nl";
  }
  return "";
}

std::u16string MapCase(CaseMapIntend intend,
                       const char* locale,
                       const std::u16string& text) {
  auto map = intend == CaseMapIntend::kUpperCase ? u_strToUpper : u_strToLower;
  std::u16string out(text.size(), u'\0');
  UErrorCode error = 0;
  int32_t length =
      map(out.data(), static_cast<int32_t>(out.size()), text.data(),
          static_cast<int32_t>(text.size()), locale, &error);
  if (error == U_BUFFER_OVERFLOW_ERROR) {
    out.assign(length, u'\0');
    error = 0;
    length = map(out.data(), length, text.data(),
                 static_cast<int32_t>(text.size()), locale, &error);
  }
  if (error > 0) {
    return text;
  }
  out.resize(length);
  return out;
}

void AppendUtf16(std::u16string* out, SkUnichar c) {
  uint16_t units[2];
  const size_t count = SkUTF::ToUTF16(c, units);
  out->append(reinterpret_cast<const char16_t*>(units), count);
}

void AppendUtf8(std::string* out, const std::u16string& text) {
  const uint16_t* ptr = reinterpret_cast<const uint16_t*>(text.data());
  const uint16_t* const end = ptr + text.size();
  while (ptr < end) {
    const SkUnichar c = SkUTF::NextUTF16(&ptr, end);
    char utf8[SkUTF::kMaxBytesInUTF8Sequence];
    out->append(utf8, SkUTF::ToUTF8(c < 0 ? 0xFFFD : c, utf8));
  }
}

struct CodePoint {
  SkUnichar value;
  size_t utf8_start;
  size_t utf8_end;
  size_t utf16_start;
  size_t utf16_end;
};

hb_script_t HbScript(int script) {
  const char* name = uscript_getShortName(script);
  return name ? hb_script_from_string(name, -1) : 0;
}

}  // namespace

void AddCapsFeatures(TextStyle* style, int caps) {
  switch (caps) {
    case kSmallCaps:
      style->addFontFeature(SkString("smcp"), 1);
      break;
    case kAllSmallCaps:
      style->addFontFeature(SkString("smcp"), 1);
      style->addFontFeature(SkString("c2sc"), 1);
      break;
    case kPetiteCaps:
      style->addFontFeature(SkString("pcap"), 1);
      break;
    case kAllPetiteCaps:
      style->addFontFeature(SkString("pcap"), 1);
      style->addFontFeature(SkString("c2pc"), 1);
      break;
    case kUnicase:
      style->addFontFeature(SkString("unic"), 1);
      break;
    case kTitlingCaps:
      style->addFontFeature(SkString("titl"), 1);
      break;
    default:
      break;
  }
}

float SmallCapsSize(float size) {
  return lroundf(size * kSmallCapsFontSizeMultiplier);
}

std::vector<CapsPiece> SplitCaps(skiac_font_collection* c_collection,
                                 SkTypeface* face,
                                 std::string_view word,
                                 const skiac_text_request& request) {
  const int caps = request.variant_caps;
  std::vector<CodePoint> code_points;
  std::u16string utf16;
  {
    const char* ptr = word.data();
    const char* const end = word.data() + word.size();
    while (ptr < end) {
      const size_t start = ptr - word.data();
      const SkUnichar c = SkUTF::NextUTF8(&ptr, end);
      if (c < 0 || !face) {
        return {{std::string(word), caps, false}};
      }
      const size_t utf16_start = utf16.size();
      AppendUtf16(&utf16, c);
      code_points.push_back({c, start, static_cast<size_t>(ptr - word.data()),
                             utf16_start, utf16.size()});
    }
  }
  if (code_points.empty()) {
    return {};
  }
  // RunSegmenter's script runs: common and inherited characters take the
  // script of the run they are in, or of the first run after them.
  std::vector<int> scripts(code_points.size(), USCRIPT_COMMON);
  {
    int current = USCRIPT_COMMON;
    size_t pending = 0;
    for (size_t i = 0; i < code_points.size(); ++i) {
      UErrorCode error = 0;
      int script = uscript_getScript(code_points[i].value, &error);
      if (error > 0 || script == USCRIPT_INHERITED) {
        script = USCRIPT_COMMON;
      }
      if (script == USCRIPT_COMMON) {
        scripts[i] = current;
        continue;
      }
      if (current == USCRIPT_COMMON) {
        for (; pending < i; ++pending) {
          scripts[pending] = script;
        }
      }
      current = script;
      scripts[i] = script;
      pending = i + 1;
    }
  }

  const char* locale = CaseMapLocale(request);
  // CaseMappingHarfBuzzBufferFiller maps the whole word and takes the run
  // from it, or maps the run character by character when the mapping
  // changes the length.
  std::u16string upper;
  std::u16string lower;
  auto mapped = [&](CaseMapIntend intend, size_t from, size_t to) {
    std::u16string& whole = intend == CaseMapIntend::kUpperCase ? upper : lower;
    if (whole.empty()) {
      whole = MapCase(intend, locale, utf16);
    }
    std::string out;
    if (whole.size() == utf16.size()) {
      AppendUtf8(&out, whole.substr(code_points[from].utf16_start,
                                    code_points[to - 1].utf16_end -
                                        code_points[from].utf16_start));
      return out;
    }
    for (size_t i = from; i < to; ++i) {
      AppendUtf8(&out, MapCase(intend, locale,
                               utf16.substr(code_points[i].utf16_start,
                                            code_points[i].utf16_end -
                                                code_points[i].utf16_start)));
    }
    return out;
  };
  auto original = [&](size_t from, size_t to) {
    return std::string(word.substr(
        code_points[from].utf8_start,
        code_points[to - 1].utf8_end - code_points[from].utf8_start));
  };

  std::vector<CapsPiece> pieces;
  for (size_t run_start = 0; run_start < code_points.size();) {
    size_t run_end = run_start + 1;
    while (run_end < code_points.size() &&
           scripts[run_end] == scripts[run_start]) {
      ++run_end;
    }
    const Support support = DetermineFontSupport(
        caps, CapsFeatures(c_collection, face, HbScript(scripts[run_start])));
    if (support.font == FontSupport::kFull || caps == kTitlingCaps) {
      // NeedsRunCaseSplitting is false.
      pieces.push_back({original(run_start, run_end),
                        FeatureToUse(support, caps, CaseRun::kSameCase),
                        false});
      run_start = run_end;
      continue;
    }
    // SmallCapsIterator: combining marks go with the letters before them.
    for (size_t start = run_start; start < run_end;) {
      std::optional<CaseRun> behavior;
      size_t end = start;
      for (; end < run_end; ++end) {
        const SkUnichar c = code_points[end].value;
        if (u_getCombiningClass(c)) {
          continue;
        }
        const CaseRun next =
            u_hasBinaryProperty(c, UCHAR_CHANGES_WHEN_UPPERCASED)
                ? CaseRun::kUppercaseNeeded
                : CaseRun::kSameCase;
        if (behavior && *behavior != next) {
          break;
        }
        behavior = next;
      }
      const CaseRun run = behavior.value_or(CaseRun::kSameCase);
      const CaseMapIntend intend = CaseChange(support, run);
      pieces.push_back({intend == CaseMapIntend::kKeepSameCase
                            ? original(start, end)
                            : mapped(intend, start, end),
                        FeatureToUse(support, caps, run),
                        SyntheticFont(support, caps, run)});
      start = end;
    }
    run_start = run_end;
  }
  return pieces;
}
