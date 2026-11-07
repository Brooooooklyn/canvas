// The UCD parity tripwire: the shaper lets HarfBuzz use its own Unicode
// data (HarfBuzz 13.1 in the Skia archives), where Chromium builds HarfBuzz
// with ICU's (HAVE_ICU, HB_NO_UCD). Both give the same answers today for
// every code point; a cargo test calls this after each Skia bump, and a
// difference means the shaper must switch to ICU-backed unicode funcs (a
// port of hb-icu.cc), set with hb_buffer_set_unicode_funcs after every
// hb_buffer_reset.

#include "icu_api.h"
#include "shaper.hpp"

#include <set>
#include <utility>

namespace {

// hb-icu.cc hb_icu_unicode_general_category.
hb_unicode_general_category_t IcuGeneralCategory(UChar32 c) {
  switch (u_getIntPropertyValue(c, UCHAR_GENERAL_CATEGORY)) {
    case U_UNASSIGNED:
      return HB_UNICODE_GENERAL_CATEGORY_UNASSIGNED;
    case U_UPPERCASE_LETTER:
      return HB_UNICODE_GENERAL_CATEGORY_UPPERCASE_LETTER;
    case U_LOWERCASE_LETTER:
      return HB_UNICODE_GENERAL_CATEGORY_LOWERCASE_LETTER;
    case U_TITLECASE_LETTER:
      return HB_UNICODE_GENERAL_CATEGORY_TITLECASE_LETTER;
    case U_MODIFIER_LETTER:
      return HB_UNICODE_GENERAL_CATEGORY_MODIFIER_LETTER;
    case U_OTHER_LETTER:
      return HB_UNICODE_GENERAL_CATEGORY_OTHER_LETTER;
    case U_NON_SPACING_MARK:
      return HB_UNICODE_GENERAL_CATEGORY_NON_SPACING_MARK;
    case U_ENCLOSING_MARK:
      return HB_UNICODE_GENERAL_CATEGORY_ENCLOSING_MARK;
    case U_COMBINING_SPACING_MARK:
      return HB_UNICODE_GENERAL_CATEGORY_SPACING_MARK;
    case U_DECIMAL_DIGIT_NUMBER:
      return HB_UNICODE_GENERAL_CATEGORY_DECIMAL_NUMBER;
    case U_LETTER_NUMBER:
      return HB_UNICODE_GENERAL_CATEGORY_LETTER_NUMBER;
    case U_OTHER_NUMBER:
      return HB_UNICODE_GENERAL_CATEGORY_OTHER_NUMBER;
    case U_SPACE_SEPARATOR:
      return HB_UNICODE_GENERAL_CATEGORY_SPACE_SEPARATOR;
    case U_LINE_SEPARATOR:
      return HB_UNICODE_GENERAL_CATEGORY_LINE_SEPARATOR;
    case U_PARAGRAPH_SEPARATOR:
      return HB_UNICODE_GENERAL_CATEGORY_PARAGRAPH_SEPARATOR;
    case U_CONTROL_CHAR:
      return HB_UNICODE_GENERAL_CATEGORY_CONTROL;
    case U_FORMAT_CHAR:
      return HB_UNICODE_GENERAL_CATEGORY_FORMAT;
    case U_PRIVATE_USE_CHAR:
      return HB_UNICODE_GENERAL_CATEGORY_PRIVATE_USE;
    case U_SURROGATE:
      return HB_UNICODE_GENERAL_CATEGORY_SURROGATE;
    case U_DASH_PUNCTUATION:
      return HB_UNICODE_GENERAL_CATEGORY_DASH_PUNCTUATION;
    case U_START_PUNCTUATION:
      return HB_UNICODE_GENERAL_CATEGORY_OPEN_PUNCTUATION;
    case U_END_PUNCTUATION:
      return HB_UNICODE_GENERAL_CATEGORY_CLOSE_PUNCTUATION;
    case U_CONNECTOR_PUNCTUATION:
      return HB_UNICODE_GENERAL_CATEGORY_CONNECT_PUNCTUATION;
    case U_OTHER_PUNCTUATION:
      return HB_UNICODE_GENERAL_CATEGORY_OTHER_PUNCTUATION;
    case U_MATH_SYMBOL:
      return HB_UNICODE_GENERAL_CATEGORY_MATH_SYMBOL;
    case U_CURRENCY_SYMBOL:
      return HB_UNICODE_GENERAL_CATEGORY_CURRENCY_SYMBOL;
    case U_MODIFIER_SYMBOL:
      return HB_UNICODE_GENERAL_CATEGORY_MODIFIER_SYMBOL;
    case U_OTHER_SYMBOL:
      return HB_UNICODE_GENERAL_CATEGORY_OTHER_SYMBOL;
    case U_INITIAL_PUNCTUATION:
      return HB_UNICODE_GENERAL_CATEGORY_INITIAL_PUNCTUATION;
    case U_FINAL_PUNCTUATION:
      return HB_UNICODE_GENERAL_CATEGORY_FINAL_PUNCTUATION;
  }
  return HB_UNICODE_GENERAL_CATEGORY_UNASSIGNED;
}

// hb-icu.cc hb_icu_unicode_script (hb_icu_script_to_script).
hb_script_t IcuScript(UChar32 c) {
  UErrorCode status = U_ZERO_ERROR;
  const int script = uscript_getScript(c, &status);
  if (status > U_ZERO_ERROR) {
    return SKIAC_HB_SCRIPT_UNKNOWN;
  }
  if (script == USCRIPT_INVALID_CODE) {
    return SKIAC_HB_SCRIPT_INVALID;
  }
  return hb_script_from_string(uscript_getShortName(script), -1);
}

// hb-icu.cc hb_icu_unicode_compose.
bool IcuCompose(const UNormalizer2* nfc,
                hb_codepoint_t a,
                hb_codepoint_t b,
                hb_codepoint_t* ab) {
  const UChar32 composed = unorm2_composePair(nfc, a, b);
  if (composed < 0) {
    return false;
  }
  *ab = composed;
  return true;
}

// The code point at `units[*i]` (U16_NEXT_UNSAFE); moves `*i` past it.
hb_codepoint_t NextUnit(const char16_t* units, int* i) {
  const hb_codepoint_t lead = units[(*i)++];
  if (lead >= 0xD800 && lead < 0xDC00) {
    const hb_codepoint_t trail = units[(*i)++];
    return (lead << 10) + trail - ((0xD800 << 10) + 0xDC00 - 0x10000);
  }
  return lead;
}

// hb-icu.cc hb_icu_unicode_decompose.
bool IcuDecompose(const UNormalizer2* nfc,
                  hb_codepoint_t ab,
                  hb_codepoint_t* a,
                  hb_codepoint_t* b) {
  char16_t decomposed[4];
  UErrorCode error = U_ZERO_ERROR;
  const int length = unorm2_getRawDecomposition(nfc, ab, decomposed, 4, &error);
  if (error > U_ZERO_ERROR || length < 0) {
    return false;
  }
  // u_countChar32.
  int count = 0;
  for (int i = 0; i < length; ++count) {
    NextUnit(decomposed, &i);
  }
  int at = 0;
  if (count == 1) {
    *a = NextUnit(decomposed, &at);
    *b = 0;
    return *a != ab;
  }
  if (count == 2) {
    *a = NextUnit(decomposed, &at);
    *b = NextUnit(decomposed, &at);
  }
  return true;
}

}  // namespace

extern "C" {

void skiac_debug_ucd_icu_diffs(skiac_ucd_icu_diffs* diffs) {
  *diffs = {};
  diffs->first = 0xFFFFFFFF;
  UErrorCode error = U_ZERO_ERROR;
  const UNormalizer2* nfc = unorm2_getNFCInstance(&error);
  if (error > U_ZERO_ERROR || !nfc) {
    // Counted as a difference in every code point.
    diffs->decompose = diffs->compose = 0xFFFFFFFF;
    return;
  }
  hb_unicode_funcs_t* ucd = hb_unicode_funcs_get_default();
  auto differs = [diffs](uint32_t* count, hb_codepoint_t c) {
    ++*count;
    if (diffs->first == 0xFFFFFFFF) {
      diffs->first = c;
    }
  };
  // Every (a, b) a decomposition gives, from either side.
  std::set<std::pair<hb_codepoint_t, hb_codepoint_t>> pairs;
  for (hb_codepoint_t c = 0; c <= 0x10FFFF; ++c) {
    const hb_unicode_general_category_t category = IcuGeneralCategory(c);
    if (category != HB_UNICODE_GENERAL_CATEGORY_UNASSIGNED) {
      ++diffs->assigned;
    }
    if (hb_unicode_general_category(ucd, c) != category) {
      differs(&diffs->general_category, c);
    }
    if (static_cast<int>(hb_unicode_combining_class(ucd, c)) !=
        static_cast<int>(u_getCombiningClass(c))) {
      differs(&diffs->combining_class, c);
    }
    if (hb_unicode_mirroring(ucd, c) !=
        static_cast<hb_codepoint_t>(u_charMirror(c))) {
      differs(&diffs->mirroring, c);
    }
    if (hb_unicode_script(ucd, c) != IcuScript(c)) {
      differs(&diffs->script, c);
    }
    hb_codepoint_t a1 = 0, b1 = 0, a2 = 0, b2 = 0;
    const bool ucd_decomposes = hb_unicode_decompose(ucd, c, &a1, &b1);
    const bool icu_decomposes = IcuDecompose(nfc, c, &a2, &b2);
    if (ucd_decomposes != icu_decomposes ||
        (ucd_decomposes && (a1 != a2 || b1 != b2))) {
      differs(&diffs->decompose, c);
    }
    if (ucd_decomposes && b1) {
      pairs.insert({a1, b1});
    }
    if (icu_decomposes && b2) {
      pairs.insert({a2, b2});
    }
  }
  // Each first half of a pair with each second half (Hangul L+V and LV+T
  // among them).
  std::set<hb_codepoint_t> firsts, seconds;
  for (const auto& [a, b] : pairs) {
    firsts.insert(a);
    seconds.insert(b);
  }
  for (hb_codepoint_t a : firsts) {
    for (hb_codepoint_t b : seconds) {
      ++diffs->compose_pairs;
      hb_codepoint_t ab1 = 0, ab2 = 0;
      const bool ucd_composes = hb_unicode_compose(ucd, a, b, &ab1);
      const bool icu_composes = IcuCompose(nfc, a, b, &ab2);
      if (ucd_composes != icu_composes || (ucd_composes && ab1 != ab2)) {
        differs(&diffs->compose, a);
      }
    }
  }
}

}  // extern "C"
