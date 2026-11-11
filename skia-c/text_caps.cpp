// font-variant-caps like Blink's HarfBuzzShaper: the OpenType caps features
// when the font has them (OpenTypeCapsSupport), else small caps made from
// the uppercase letters at 70% of the font size, rounded to whole pixels
// (SimpleFontData::SmallCapsFontData). Each run of letters that changes when
// uppercased, or does not (SmallCapsIterator), is shaped on its own.

#include <math.h>
#include <algorithm>
#include <string>
#include <vector>

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

using FontSupport = CapsSupport::Font;
using CapsSynthesis = CapsSupport::Synthesis;

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

using Support = CapsSupport;

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
  if (run == CaseRun::kUppercaseNeeded) {
    return s.font != FontSupport::kFallback &&
                   (s.synthesis == CapsSynthesis::kLowerToSmallCaps ||
                    s.synthesis == CapsSynthesis::kBoth)
               ? CaseMapIntend::kUpperCase
               : CaseMapIntend::kKeepSameCase;
  }
  // A run of combining marks only (SmallCapsIterator's kSmallCapsInvalid).
  return CaseMapIntend::kKeepSameCase;
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
  if (run == CaseRun::kSameCase) {
    return s.synthesis == CapsSynthesis::kUpperToSmallCaps ||
           s.synthesis == CapsSynthesis::kBoth;
  }
  return false;
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

}  // namespace

const char* CaseMapLocale(std::string_view lang) {
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

float SmallCapsSize(float size) {
  return lroundf(size * kSmallCapsFontSizeMultiplier);
}

CapsSupport FontCapsSupport(skiac_font_collection* c_collection,
                            SkTypeface* face,
                            int caps,
                            hb_script_t script) {
  if (caps == kCapsNormal) {
    return {};
  }
  return DetermineFontSupport(caps, CapsFeatures(c_collection, face, script));
}

bool NeedsRunCaseSplitting(const CapsSupport& support, int caps) {
  // Lack of titling case support is ignored: titling case is not
  // synthesized.
  return support.font != FontSupport::kFull && caps != kTitlingCaps;
}

int CapsFeatureToUse(const CapsSupport& support, int caps, CaseRun run) {
  return FeatureToUse(support, caps, run);
}

CaseMapIntend NeedsCaseChange(const CapsSupport& support, CaseRun run) {
  return CaseChange(support, run);
}

bool NeedsSyntheticFont(const CapsSupport& support, int caps, CaseRun run) {
  return SyntheticFont(support, caps, run);
}

uint32_t NextCaseRun(const char16_t* text, uint32_t length, CaseRun* run) {
  CaseRun current = CaseRun::kInvalid;
  for (uint32_t i = 0; i < length;) {
    const uint32_t at = i;
    uint32_t c = text[i++];
    if (c >= 0xD800 && c <= 0xDBFF && i < length && text[i] >= 0xDC00 &&
        text[i] <= 0xDFFF) {
      c = 0x10000 + ((c - 0xD800) << 10) + (text[i++] - 0xDC00);
    }
    const CaseRun previous = current;
    // Combining marks combine with the small caps uppercased text as well:
    // their own case does not split.
    if (!u_getCombiningClass(static_cast<UChar32>(c))) {
      current = u_hasBinaryProperty(static_cast<UChar32>(c),
                                    UCHAR_CHANGES_WHEN_UPPERCASED)
                    ? CaseRun::kUppercaseNeeded
                    : CaseRun::kSameCase;
    }
    if (previous != current && previous != CaseRun::kInvalid) {
      *run = previous;
      return at;
    }
  }
  *run = current;
  return length;
}

void PrependCapsFeatures(std::vector<hb_feature_t>* features, int caps) {
  auto prepend = [features](char a, char b, char c, char d) {
    features->insert(features->begin(),
                     {SKIAC_HB_TAG(a, b, c, d), 1, HB_FEATURE_GLOBAL_START,
                      HB_FEATURE_GLOBAL_END});
  };
  if (caps == kSmallCaps || caps == kAllSmallCaps) {
    prepend('s', 'm', 'c', 'p');
    if (caps == kAllSmallCaps) {
      prepend('c', '2', 's', 'c');
    }
  }
  if (caps == kPetiteCaps || caps == kAllPetiteCaps) {
    prepend('p', 'c', 'a', 'p');
    if (caps == kAllPetiteCaps) {
      prepend('c', '2', 'p', 'c');
    }
  }
  if (caps == kUnicase) {
    prepend('u', 'n', 'i', 'c');
  }
  if (caps == kTitlingCaps) {
    prepend('t', 'i', 't', 'l');
  }
}
