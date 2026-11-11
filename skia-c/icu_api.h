// The ICU C API the text code calls. ICU 78.2 is compiled into
// libskunicode_icu on every target (skia/third_party/icu/BUILD.gn:
// U_DISABLE_RENAMING=1, so the C symbols carry no _78 suffix, and
// U_USING_ICU_NAMESPACE=0). Its headers are not on the addon's include path,
// so the declarations needed live here, copied from uchar.h, uscript.h,
// ustring.h, ubidi.h and unorm2.h. Enum-typed parameters and returns are
// declared as int32_t or uint8_t: every ICU enum used here is int-sized and
// U_EXPORT2 (__cdecl on Windows) is a no-op on x64 and arm64, so the ABI is
// the same.
//
// Data: the property tables behind u_*, uscript_*, ubidi_* and the NFC
// instance are compiled into the code (uchar_props_data.h, ubidi_props_data.h,
// ucase_props_data.h, NORM2_HARDCODE_NFC_DATA), so they need no icudtl.dat.
// Windows still loads icudtl.dat in SkUnicodes::ICU::Make() (text.cpp), which
// the NFD instance and break iterators would need.

#ifndef SKIA_C_ICU_API_H
#define SKIA_C_ICU_API_H

#include <stdint.h>

extern "C" {

typedef int8_t UBool;
typedef int32_t UChar32;
typedef int UErrorCode;  // U_ZERO_ERROR = 0; failures are > 0

// UProperty
constexpr int UCHAR_DEFAULT_IGNORABLE_CODE_POINT = 5;
constexpr int UCHAR_GRAPHEME_EXTEND = 11;
constexpr int UCHAR_EMOJI_PRESENTATION = 58;
constexpr int UCHAR_EMOJI_COMPONENT = 61;
constexpr int UCHAR_EXTENDED_PICTOGRAPHIC = 64;
constexpr int UCHAR_EMOJI = 57;
constexpr int UCHAR_CHANGES_WHEN_UPPERCASED = 52;

// UCharCategory
constexpr int U_MODIFIER_LETTER = 4;
constexpr int U_NON_SPACING_MARK = 6;
constexpr int U_ENCLOSING_MARK = 7;
constexpr int U_COMBINING_SPACING_MARK = 8;
constexpr int U_MODIFIER_SYMBOL = 26;

// UScriptCode
constexpr int USCRIPT_COMMON = 0;
constexpr int USCRIPT_INHERITED = 1;

// UErrorCode
constexpr int U_BUFFER_OVERFLOW_ERROR = 15;

UBool u_hasBinaryProperty(UChar32 c, int which);
uint8_t u_getCombiningClass(UChar32 c);
const char* uscript_getShortName(int script_code);
// UChar is char16_t in C++.
int32_t u_strToUpper(char16_t* dest,
                     int32_t dest_capacity,
                     const char16_t* src,
                     int32_t src_length,
                     const char* locale,
                     UErrorCode* error);
int32_t u_strToLower(char16_t* dest,
                     int32_t dest_capacity,
                     const char16_t* src,
                     int32_t src_length,
                     const char* locale,
                     UErrorCode* error);
int8_t u_charType(UChar32 c);
int uscript_getScript(UChar32 codepoint, UErrorCode* err);

// ---- shaper additions ----

constexpr int U_ZERO_ERROR = 0;

// UProperty (enumerated)
constexpr int UCHAR_BLOCK = 0x1001;
constexpr int UCHAR_EAST_ASIAN_WIDTH = 0x1004;
constexpr int UCHAR_GENERAL_CATEGORY = 0x1005;
constexpr int UCHAR_BIDI_PAIRED_BRACKET_TYPE = 0x1015;
constexpr int UCHAR_VERTICAL_ORIENTATION = 0x1018;
// UProperty (binary)
constexpr int UCHAR_EMOJI_MODIFIER = 59;
constexpr int UCHAR_EMOJI_MODIFIER_BASE = 60;
constexpr int UCHAR_REGIONAL_INDICATOR = 62;

// UBidiPairedBracketType
constexpr int U_BPT_NONE = 0;
constexpr int U_BPT_OPEN = 1;
constexpr int U_BPT_CLOSE = 2;

// UEastAsianWidth
constexpr int U_EA_HALFWIDTH = 2;
constexpr int U_EA_FULLWIDTH = 3;
constexpr int U_EA_WIDE = 5;

// UBlockCode
constexpr int UBLOCK_CJK_SYMBOLS_AND_PUNCTUATION = 61;

// UCharDirection
constexpr int U_LEFT_TO_RIGHT = 0;
constexpr int U_RIGHT_TO_LEFT = 1;
constexpr int U_RIGHT_TO_LEFT_ARABIC = 13;

// UCharCategory, all 30 (for the hb_unicode_funcs general-category map).
constexpr int U_UNASSIGNED = 0;
constexpr int U_UPPERCASE_LETTER = 1;
constexpr int U_LOWERCASE_LETTER = 2;
constexpr int U_TITLECASE_LETTER = 3;
constexpr int U_OTHER_LETTER = 5;
constexpr int U_DECIMAL_DIGIT_NUMBER = 9;
constexpr int U_LETTER_NUMBER = 10;
constexpr int U_OTHER_NUMBER = 11;
constexpr int U_SPACE_SEPARATOR = 12;
constexpr int U_LINE_SEPARATOR = 13;
constexpr int U_PARAGRAPH_SEPARATOR = 14;
constexpr int U_CONTROL_CHAR = 15;
constexpr int U_FORMAT_CHAR = 16;
constexpr int U_PRIVATE_USE_CHAR = 17;
constexpr int U_SURROGATE = 18;
constexpr int U_DASH_PUNCTUATION = 19;
constexpr int U_START_PUNCTUATION = 20;
constexpr int U_END_PUNCTUATION = 21;
constexpr int U_CONNECTOR_PUNCTUATION = 22;
constexpr int U_OTHER_PUNCTUATION = 23;
constexpr int U_MATH_SYMBOL = 24;
constexpr int U_CURRENCY_SYMBOL = 25;
constexpr int U_OTHER_SYMBOL = 27;
constexpr int U_INITIAL_PUNCTUATION = 28;
constexpr int U_FINAL_PUNCTUATION = 29;

// UScriptCode values Blink's segmenter and spacing name.
constexpr int USCRIPT_INVALID_CODE = -1;
constexpr int USCRIPT_ARABIC = 2;
constexpr int USCRIPT_ARMENIAN = 3;
constexpr int USCRIPT_BOPOMOFO = 5;
constexpr int USCRIPT_DEVANAGARI = 10;
constexpr int USCRIPT_GEORGIAN = 12;
constexpr int USCRIPT_GOTHIC = 13;
constexpr int USCRIPT_GREEK = 14;
constexpr int USCRIPT_HAN = 17;
constexpr int USCRIPT_HANGUL = 18;
constexpr int USCRIPT_HEBREW = 19;
constexpr int USCRIPT_HIRAGANA = 20;
constexpr int USCRIPT_KANNADA = 21;
constexpr int USCRIPT_KATAKANA = 22;
constexpr int USCRIPT_LATIN = 25;
constexpr int USCRIPT_MONGOLIAN = 27;
constexpr int USCRIPT_SYRIAC = 34;
constexpr int USCRIPT_THAI = 38;
constexpr int USCRIPT_KATAKANA_OR_HIRAGANA = 54;
constexpr int USCRIPT_SIMPLIFIED_HAN = 73;
constexpr int USCRIPT_TRADITIONAL_HAN = 74;
constexpr int USCRIPT_MANDAIC = 84;
constexpr int USCRIPT_NKO = 87;
constexpr int USCRIPT_PHAGS_PA = 90;
constexpr int USCRIPT_HANIFI_ROHINGYA = 182;

// UBiDiDirection and UBiDiLevel (uint8_t)
typedef uint8_t UBiDiLevel;
constexpr int UBIDI_LTR = 0;
constexpr int UBIDI_RTL = 1;
constexpr int UBIDI_MIXED = 2;
constexpr int UBIDI_NEUTRAL = 3;
constexpr UBiDiLevel UBIDI_DEFAULT_LTR = 0xfe;
constexpr UBiDiLevel UBIDI_DEFAULT_RTL = 0xff;
constexpr UBiDiLevel UBIDI_MAX_EXPLICIT_LEVEL = 125;

typedef struct UBiDi UBiDi;
typedef struct UNormalizer2 UNormalizer2;

// uchar.h
int32_t u_getIntPropertyValue(UChar32 c, int which);  // which: UProperty
int32_t u_charDirection(UChar32 c);                   // UCharDirection
UChar32 u_charMirror(UChar32 c);
UChar32 u_getBidiPairedBracket(UChar32 c);

// uscript.h
int32_t uscript_getScriptExtensions(UChar32 c,
                                    int32_t* scripts,  // UScriptCode*
                                    int32_t capacity,
                                    UErrorCode* error);
UBool uscript_hasScript(UChar32 c, int sc);

// ubidi.h
UBiDi* ubidi_open(void);
UBiDi* ubidi_openSized(int32_t max_length,
                       int32_t max_run_count,
                       UErrorCode* error);
void ubidi_close(UBiDi* bidi);
void ubidi_setPara(UBiDi* bidi,
                   const char16_t* text,
                   int32_t length,
                   UBiDiLevel para_level,
                   UBiDiLevel* embedding_levels,
                   UErrorCode* error);
int32_t ubidi_getDirection(const UBiDi* bidi);  // UBiDiDirection
UBiDiLevel ubidi_getParaLevel(const UBiDi* bidi);
int32_t ubidi_countRuns(UBiDi* bidi, UErrorCode* error);
int32_t ubidi_getVisualRun(UBiDi* bidi,  // UBiDiDirection
                           int32_t run_index,
                           int32_t* logical_start,
                           int32_t* length);
void ubidi_getLogicalRun(const UBiDi* bidi,
                         int32_t logical_position,
                         int32_t* logical_limit,
                         UBiDiLevel* level);
void ubidi_reorderVisual(const UBiDiLevel* levels,
                         int32_t length,
                         int32_t* index_map);

// unorm2.h (only for an ICU-backed hb_unicode_funcs_t, MAP Q5 (b))
const UNormalizer2* unorm2_getNFCInstance(UErrorCode* error);
UChar32 unorm2_composePair(const UNormalizer2* norm2, UChar32 a, UChar32 b);
int32_t unorm2_getRawDecomposition(const UNormalizer2* norm2,
                                   UChar32 c,
                                   char16_t* decomposition,
                                   int32_t capacity,
                                   UErrorCode* error);

}  // extern "C"

#endif  // SKIA_C_ICU_API_H
