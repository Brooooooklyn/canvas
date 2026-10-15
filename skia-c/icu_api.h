// The ICU C API the text code calls. ICU is linked from libskunicode_icu
// (built with U_DISABLE_RENAMING, unversioned symbols), but its headers are
// not on the addon's include path, so the few declarations needed live here,
// copied from uchar.h, uscript.h and ustring.h.

#ifndef SKIA_C_ICU_API_H
#define SKIA_C_ICU_API_H

#include <stdint.h>

extern "C" {

typedef int8_t UBool;
typedef int32_t UChar32;
typedef int UErrorCode;  // U_ZERO_ERROR = 0; failures are > 0

// UProperty
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

}  // extern "C"

#endif  // SKIA_C_ICU_API_H
