// The ICU C API the text code calls. ICU is linked from libskunicode_icu
// (built with U_DISABLE_RENAMING, unversioned symbols), but its headers are
// not on the addon's include path, so the few declarations needed live here,
// copied from uchar.h and uscript.h.

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

// UCharCategory
constexpr int U_MODIFIER_LETTER = 4;
constexpr int U_NON_SPACING_MARK = 6;
constexpr int U_ENCLOSING_MARK = 7;
constexpr int U_COMBINING_SPACING_MARK = 8;
constexpr int U_MODIFIER_SYMBOL = 26;

// UScriptCode
constexpr int USCRIPT_COMMON = 0;
constexpr int USCRIPT_INHERITED = 1;

UBool u_hasBinaryProperty(UChar32 c, int which);
int8_t u_charType(UChar32 c);
int uscript_getScript(UChar32 codepoint, UErrorCode* err);

}  // extern "C"

#endif  // SKIA_C_ICU_API_H
