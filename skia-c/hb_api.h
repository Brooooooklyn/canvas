// The HarfBuzz C API the text code calls. HarfBuzz 13.1.0 is compiled into
// the prebuilt Skia archives (skia_use_harfbuzz, bundled, unversioned C
// symbols). Its objects are in libskshaper on every target and also in
// libskia where skia_pdf_subset_harfbuzz is on, which is every target except
// x86_64-pc-windows-msvc and the two musl targets (scripts/skia-gn-args.cjs
// PDF_HARFBUZZ_SUBSET_CRASHING_TARGETS; skia/BUILD.gn `if
// (skia_pdf_subset_harfbuzz) deps += harfbuzz`). The headers are not on the
// addon's include path (CI does not sync skia/third_party/externals), so the
// declarations needed live here, copied from hb-common.h, hb-blob.h,
// hb-buffer.h, hb-face.h, hb-font.h, hb-set.h, hb-shape.h, hb-unicode.h,
// hb-ot-font.h and hb-ot-layout.h of HarfBuzz 13.1.0.

#ifndef SKIA_C_HB_API_H
#define SKIA_C_HB_API_H

#include <stdint.h>

// ---- types ----
extern "C" {

typedef int hb_bool_t;
typedef uint32_t hb_tag_t;
typedef int32_t hb_position_t;
typedef uint32_t hb_codepoint_t;
typedef uint32_t hb_mask_t;
typedef struct hb_blob_t hb_blob_t;
typedef struct hb_set_t hb_set_t;
typedef struct hb_face_t hb_face_t;
typedef struct hb_font_t hb_font_t;
typedef struct hb_buffer_t hb_buffer_t;
typedef struct hb_font_funcs_t hb_font_funcs_t;
typedef struct hb_unicode_funcs_t hb_unicode_funcs_t;
typedef void (*hb_destroy_func_t)(void* user_data);
typedef hb_blob_t* (*hb_reference_table_func_t)(hb_face_t* face,
                                                hb_tag_t tag,
                                                void* user_data);

// hb_memory_mode_t
typedef enum {
  HB_MEMORY_MODE_DUPLICATE,
  HB_MEMORY_MODE_READONLY,
  HB_MEMORY_MODE_WRITABLE,
  HB_MEMORY_MODE_READONLY_MAY_MAKE_WRITABLE
} hb_memory_mode_t;

// hb_direction_t
typedef enum {
  HB_DIRECTION_INVALID = 0,
  HB_DIRECTION_LTR = 4,
  HB_DIRECTION_RTL,
  HB_DIRECTION_TTB,
  HB_DIRECTION_BTT
} hb_direction_t;

#define SKIAC_HB_TAG(c1, c2, c3, c4)            \
  ((hb_tag_t)((((uint32_t)(c1) & 0xFF) << 24) | \
              (((uint32_t)(c2) & 0xFF) << 16) | \
              (((uint32_t)(c3) & 0xFF) << 8) | ((uint32_t)(c4) & 0xFF)))

// hb_ot_layout_baseline_tag_t (an enum of tags, int sized)
typedef enum {
  HB_OT_LAYOUT_BASELINE_TAG_ROMAN = SKIAC_HB_TAG('r', 'o', 'm', 'n'),
  HB_OT_LAYOUT_BASELINE_TAG_HANGING = SKIAC_HB_TAG('h', 'a', 'n', 'g'),
  HB_OT_LAYOUT_BASELINE_TAG_IDEO_EMBOX_BOTTOM_OR_LEFT =
      SKIAC_HB_TAG('i', 'd', 'e', 'o'),
} hb_ot_layout_baseline_tag_t;

// hb_script_t and the AAT enums are int-sized enums of tags or numbers.
typedef uint32_t hb_script_t;
typedef const struct hb_language_impl_t* hb_language_t;
typedef unsigned int hb_ot_name_id_t;
typedef int hb_aat_layout_feature_type_t;
typedef int hb_aat_layout_feature_selector_t;
typedef struct hb_aat_layout_feature_selector_info_t {
  hb_ot_name_id_t name_id;
  hb_aat_layout_feature_selector_t enable;
  hb_aat_layout_feature_selector_t disable;
  unsigned int reserved;
} hb_aat_layout_feature_selector_info_t;

#define HB_LANGUAGE_INVALID ((hb_language_t)0)
#define HB_OT_LAYOUT_DEFAULT_LANGUAGE_INDEX 0xFFFFu
#define HB_AAT_LAYOUT_FEATURE_TYPE_LETTER_CASE 3
#define HB_AAT_LAYOUT_FEATURE_TYPE_LOWER_CASE 37
#define HB_AAT_LAYOUT_FEATURE_TYPE_UPPER_CASE 38
#define HB_AAT_LAYOUT_FEATURE_SELECTOR_SMALL_CAPS 3
#define HB_AAT_LAYOUT_FEATURE_SELECTOR_LOWER_CASE_SMALL_CAPS 1
#define HB_AAT_LAYOUT_FEATURE_SELECTOR_UPPER_CASE_SMALL_CAPS 1

#define HB_OT_TAG_GSUB SKIAC_HB_TAG('G', 'S', 'U', 'B')
#define HB_OT_TAG_GPOS SKIAC_HB_TAG('G', 'P', 'O', 'S')
#define HB_OT_TAG_DEFAULT_SCRIPT SKIAC_HB_TAG('D', 'F', 'L', 'T')
#define HB_OT_TAG_DEFAULT_LANGUAGE SKIAC_HB_TAG('d', 'f', 'l', 't')

// ---- shaper additions: types ----

// hb_script_t values the shaper names (hb-common.h, tags in ISO 15924).
#define SKIAC_HB_SCRIPT_COMMON SKIAC_HB_TAG('Z', 'y', 'y', 'y')
#define SKIAC_HB_SCRIPT_INHERITED SKIAC_HB_TAG('Z', 'i', 'n', 'h')
#define SKIAC_HB_SCRIPT_UNKNOWN SKIAC_HB_TAG('Z', 'z', 'z', 'z')
#define SKIAC_HB_SCRIPT_LATIN SKIAC_HB_TAG('L', 'a', 't', 'n')
#define SKIAC_HB_SCRIPT_INVALID ((hb_script_t)0)

#define HB_FEATURE_GLOBAL_START 0u
#define HB_FEATURE_GLOBAL_END ((unsigned int)-1)

typedef union _hb_var_int_t {
  uint32_t u32;
  int32_t i32;
  uint16_t u16[2];
  int16_t i16[2];
  uint8_t u8[4];
  int8_t i8[4];
} hb_var_int_t;

typedef struct hb_user_data_key_t {
  char unused;
} hb_user_data_key_t;

typedef struct hb_feature_t {
  hb_tag_t tag;
  uint32_t value;
  unsigned int start;
  unsigned int end;
} hb_feature_t;

typedef struct hb_variation_t {
  hb_tag_t tag;
  float value;
} hb_variation_t;

typedef struct hb_glyph_info_t {
  hb_codepoint_t codepoint;
  hb_mask_t mask;  // private
  uint32_t cluster;
  hb_var_int_t var1;  // private
  hb_var_int_t var2;  // private
} hb_glyph_info_t;

typedef struct hb_glyph_position_t {
  hb_position_t x_advance;
  hb_position_t y_advance;
  hb_position_t x_offset;
  hb_position_t y_offset;
  hb_var_int_t var;  // private
} hb_glyph_position_t;

typedef struct hb_glyph_extents_t {
  hb_position_t x_bearing;
  hb_position_t y_bearing;
  hb_position_t width;
  hb_position_t height;
} hb_glyph_extents_t;

typedef struct hb_font_extents_t {
  hb_position_t ascender;
  hb_position_t descender;
  hb_position_t line_gap;
  hb_position_t reserved9;
  hb_position_t reserved8;
  hb_position_t reserved7;
  hb_position_t reserved6;
  hb_position_t reserved5;
  hb_position_t reserved4;
  hb_position_t reserved3;
  hb_position_t reserved2;
  hb_position_t reserved1;
} hb_font_extents_t;

// hb_buffer_content_type_t
typedef enum {
  HB_BUFFER_CONTENT_TYPE_INVALID = 0,
  HB_BUFFER_CONTENT_TYPE_UNICODE,
  HB_BUFFER_CONTENT_TYPE_GLYPHS
} hb_buffer_content_type_t;

// hb_glyph_flags_t
typedef enum {
  HB_GLYPH_FLAG_UNSAFE_TO_BREAK = 0x00000001,
  HB_GLYPH_FLAG_UNSAFE_TO_CONCAT = 0x00000002,
  HB_GLYPH_FLAG_SAFE_TO_INSERT_TATWEEL = 0x00000004,
  HB_GLYPH_FLAG_DEFINED = 0x00000007
} hb_glyph_flags_t;

// hb_unicode_general_category_t (order differs from ICU's UCharCategory)
typedef enum {
  HB_UNICODE_GENERAL_CATEGORY_CONTROL,
  HB_UNICODE_GENERAL_CATEGORY_FORMAT,
  HB_UNICODE_GENERAL_CATEGORY_UNASSIGNED,
  HB_UNICODE_GENERAL_CATEGORY_PRIVATE_USE,
  HB_UNICODE_GENERAL_CATEGORY_SURROGATE,
  HB_UNICODE_GENERAL_CATEGORY_LOWERCASE_LETTER,
  HB_UNICODE_GENERAL_CATEGORY_MODIFIER_LETTER,
  HB_UNICODE_GENERAL_CATEGORY_OTHER_LETTER,
  HB_UNICODE_GENERAL_CATEGORY_TITLECASE_LETTER,
  HB_UNICODE_GENERAL_CATEGORY_UPPERCASE_LETTER,
  HB_UNICODE_GENERAL_CATEGORY_SPACING_MARK,
  HB_UNICODE_GENERAL_CATEGORY_ENCLOSING_MARK,
  HB_UNICODE_GENERAL_CATEGORY_NON_SPACING_MARK,
  HB_UNICODE_GENERAL_CATEGORY_DECIMAL_NUMBER,
  HB_UNICODE_GENERAL_CATEGORY_LETTER_NUMBER,
  HB_UNICODE_GENERAL_CATEGORY_OTHER_NUMBER,
  HB_UNICODE_GENERAL_CATEGORY_CONNECT_PUNCTUATION,
  HB_UNICODE_GENERAL_CATEGORY_DASH_PUNCTUATION,
  HB_UNICODE_GENERAL_CATEGORY_CLOSE_PUNCTUATION,
  HB_UNICODE_GENERAL_CATEGORY_FINAL_PUNCTUATION,
  HB_UNICODE_GENERAL_CATEGORY_INITIAL_PUNCTUATION,
  HB_UNICODE_GENERAL_CATEGORY_OTHER_PUNCTUATION,
  HB_UNICODE_GENERAL_CATEGORY_OPEN_PUNCTUATION,
  HB_UNICODE_GENERAL_CATEGORY_CURRENCY_SYMBOL,
  HB_UNICODE_GENERAL_CATEGORY_MODIFIER_SYMBOL,
  HB_UNICODE_GENERAL_CATEGORY_MATH_SYMBOL,
  HB_UNICODE_GENERAL_CATEGORY_OTHER_SYMBOL,
  HB_UNICODE_GENERAL_CATEGORY_LINE_SEPARATOR,
  HB_UNICODE_GENERAL_CATEGORY_PARAGRAPH_SEPARATOR,
  HB_UNICODE_GENERAL_CATEGORY_SPACE_SEPARATOR
} hb_unicode_general_category_t;

// hb_unicode_combining_class_t: the canonical combining class 0..254, plus
// INVALID. Only the two ends are named; the callback returns the ICU number
// cast to this type, as hb-icu.cc does.
typedef enum {
  HB_UNICODE_COMBINING_CLASS_NOT_REORDERED = 0,
  HB_UNICODE_COMBINING_CLASS_INVALID = 255
} hb_unicode_combining_class_t;

// Font callbacks (hb-font.h).
typedef hb_bool_t (*hb_font_get_nominal_glyph_func_t)(hb_font_t* font,
                                                      void* font_data,
                                                      hb_codepoint_t unicode,
                                                      hb_codepoint_t* glyph,
                                                      void* user_data);
typedef hb_bool_t (*hb_font_get_variation_glyph_func_t)(
    hb_font_t* font,
    void* font_data,
    hb_codepoint_t unicode,
    hb_codepoint_t variation_selector,
    hb_codepoint_t* glyph,
    void* user_data);
typedef hb_position_t (*hb_font_get_glyph_advance_func_t)(hb_font_t* font,
                                                          void* font_data,
                                                          hb_codepoint_t glyph,
                                                          void* user_data);
typedef hb_font_get_glyph_advance_func_t hb_font_get_glyph_h_advance_func_t;
typedef hb_font_get_glyph_advance_func_t hb_font_get_glyph_v_advance_func_t;
typedef void (*hb_font_get_glyph_advances_func_t)(
    hb_font_t* font,
    void* font_data,
    unsigned int count,
    const hb_codepoint_t* first_glyph,
    unsigned int glyph_stride,
    hb_position_t* first_advance,
    unsigned int advance_stride,
    void* user_data);
typedef hb_font_get_glyph_advances_func_t hb_font_get_glyph_h_advances_func_t;
typedef hb_bool_t (*hb_font_get_glyph_origin_func_t)(hb_font_t* font,
                                                     void* font_data,
                                                     hb_codepoint_t glyph,
                                                     hb_position_t* x,
                                                     hb_position_t* y,
                                                     void* user_data);
typedef hb_font_get_glyph_origin_func_t hb_font_get_glyph_v_origin_func_t;
typedef hb_bool_t (*hb_font_get_glyph_extents_func_t)(
    hb_font_t* font,
    void* font_data,
    hb_codepoint_t glyph,
    hb_glyph_extents_t* extents,
    void* user_data);

// Unicode callbacks (hb-unicode.h), for an ICU-backed hb_unicode_funcs_t.
typedef hb_unicode_combining_class_t (*hb_unicode_combining_class_func_t)(
    hb_unicode_funcs_t* ufuncs,
    hb_codepoint_t unicode,
    void* user_data);
typedef hb_unicode_general_category_t (*hb_unicode_general_category_func_t)(
    hb_unicode_funcs_t* ufuncs,
    hb_codepoint_t unicode,
    void* user_data);
typedef hb_codepoint_t (*hb_unicode_mirroring_func_t)(
    hb_unicode_funcs_t* ufuncs,
    hb_codepoint_t unicode,
    void* user_data);
typedef hb_script_t (*hb_unicode_script_func_t)(hb_unicode_funcs_t* ufuncs,
                                                hb_codepoint_t unicode,
                                                void* user_data);
typedef hb_bool_t (*hb_unicode_compose_func_t)(hb_unicode_funcs_t* ufuncs,
                                               hb_codepoint_t a,
                                               hb_codepoint_t b,
                                               hb_codepoint_t* ab,
                                               void* user_data);
typedef hb_bool_t (*hb_unicode_decompose_func_t)(hb_unicode_funcs_t* ufuncs,
                                                 hb_codepoint_t ab,
                                                 hb_codepoint_t* a,
                                                 hb_codepoint_t* b,
                                                 void* user_data);

}  // extern "C"

// ---- functions ----
extern "C" {

hb_blob_t* hb_blob_create(const char* data,
                          unsigned int length,
                          hb_memory_mode_t mode,
                          void* user_data,
                          hb_destroy_func_t destroy);
hb_face_t* hb_face_create_for_tables(hb_reference_table_func_t reference_table,
                                     void* user_data,
                                     hb_destroy_func_t destroy);
void hb_face_destroy(hb_face_t* face);
hb_font_t* hb_font_create(hb_face_t* face);
void hb_font_set_scale(hb_font_t* font, int x_scale, int y_scale);
void hb_font_destroy(hb_font_t* font);
hb_bool_t hb_ot_layout_get_baseline(hb_font_t* font,
                                    hb_ot_layout_baseline_tag_t baseline_tag,
                                    hb_direction_t direction,
                                    hb_tag_t script_tag,
                                    hb_tag_t language_tag,
                                    hb_position_t* coord);
hb_set_t* hb_set_create(void);
void hb_set_destroy(hb_set_t* set);
hb_bool_t hb_set_has(const hb_set_t* set, hb_codepoint_t codepoint);
hb_bool_t hb_ot_layout_has_substitution(hb_face_t* face);
hb_bool_t hb_ot_layout_has_positioning(hb_face_t* face);
unsigned int hb_ot_layout_table_get_lookup_count(hb_face_t* face,
                                                 hb_tag_t table_tag);
void hb_ot_layout_lookup_collect_glyphs(hb_face_t* face,
                                        hb_tag_t table_tag,
                                        unsigned int lookup_index,
                                        hb_set_t* glyphs_before,
                                        hb_set_t* glyphs_input,
                                        hb_set_t* glyphs_after,
                                        hb_set_t* glyphs_output);
hb_script_t hb_script_from_string(const char* str, int len);
void hb_ot_tags_from_script_and_language(hb_script_t script,
                                         hb_language_t language,
                                         unsigned int* script_count,
                                         hb_tag_t* script_tags,
                                         unsigned int* language_count,
                                         hb_tag_t* language_tags);
hb_bool_t hb_ot_layout_table_select_script(hb_face_t* face,
                                           hb_tag_t table_tag,
                                           unsigned int script_count,
                                           const hb_tag_t* script_tags,
                                           unsigned int* script_index,
                                           hb_tag_t* chosen_script);
hb_bool_t hb_ot_layout_language_find_feature(hb_face_t* face,
                                             hb_tag_t table_tag,
                                             unsigned int script_index,
                                             unsigned int language_index,
                                             hb_tag_t feature_tag,
                                             unsigned int* feature_index);
unsigned int hb_aat_layout_get_feature_types(
    hb_face_t* face,
    unsigned int start_offset,
    unsigned int* feature_count,
    hb_aat_layout_feature_type_t* features);
unsigned int hb_aat_layout_feature_type_get_selector_infos(
    hb_face_t* face,
    hb_aat_layout_feature_type_t feature_type,
    unsigned int start_offset,
    unsigned int* selector_count,
    hb_aat_layout_feature_selector_info_t* selectors,
    unsigned int* default_index);

// ---- shaper additions: functions ----

// hb-common.h
hb_language_t hb_language_from_string(const char* str, int len);
hb_language_t hb_language_get_default(void);
const char* hb_language_to_string(hb_language_t language);
hb_tag_t hb_tag_from_string(const char* str, int len);
const char* hb_version_string(void);

// hb-blob.h
void hb_blob_destroy(hb_blob_t* blob);
hb_blob_t* hb_blob_get_empty(void);

// hb-face.h
unsigned int hb_face_count(hb_blob_t* blob);
hb_face_t* hb_face_create(hb_blob_t* blob, unsigned int index);
hb_face_t* hb_face_reference(hb_face_t* face);
unsigned int hb_face_get_upem(const hb_face_t* face);
unsigned int hb_face_get_glyph_count(const hb_face_t* face);
void hb_face_make_immutable(hb_face_t* face);

// hb-font.h
hb_font_t* hb_font_create_sub_font(hb_font_t* parent);
hb_font_t* hb_font_reference(hb_font_t* font);
hb_font_t* hb_font_get_parent(hb_font_t* font);
hb_face_t* hb_font_get_face(hb_font_t* font);
void hb_font_make_immutable(hb_font_t* font);
void hb_font_set_funcs(hb_font_t* font,
                       hb_font_funcs_t* klass,
                       void* font_data,
                       hb_destroy_func_t destroy);
void hb_font_get_scale(hb_font_t* font, int* x_scale, int* y_scale);
void hb_font_set_ptem(hb_font_t* font, float ptem);
float hb_font_get_ptem(hb_font_t* font);
void hb_font_set_variations(hb_font_t* font,
                            const hb_variation_t* variations,
                            unsigned int variations_length);
hb_bool_t hb_font_get_nominal_glyph(hb_font_t* font,
                                    hb_codepoint_t unicode,
                                    hb_codepoint_t* glyph);
hb_bool_t hb_font_get_variation_glyph(hb_font_t* font,
                                      hb_codepoint_t unicode,
                                      hb_codepoint_t variation_selector,
                                      hb_codepoint_t* glyph);
hb_bool_t hb_font_get_glyph(hb_font_t* font,
                            hb_codepoint_t unicode,
                            hb_codepoint_t variation_selector,
                            hb_codepoint_t* glyph);
hb_position_t hb_font_get_glyph_h_advance(hb_font_t* font,
                                          hb_codepoint_t glyph);
void hb_font_get_glyph_h_advances(hb_font_t* font,
                                  unsigned int count,
                                  const hb_codepoint_t* first_glyph,
                                  unsigned int glyph_stride,
                                  hb_position_t* first_advance,
                                  unsigned int advance_stride);
hb_bool_t hb_font_get_glyph_extents(hb_font_t* font,
                                    hb_codepoint_t glyph,
                                    hb_glyph_extents_t* extents);

hb_font_funcs_t* hb_font_funcs_create(void);
void hb_font_funcs_destroy(hb_font_funcs_t* ffuncs);
void hb_font_funcs_make_immutable(hb_font_funcs_t* ffuncs);
void hb_font_funcs_set_nominal_glyph_func(hb_font_funcs_t* ffuncs,
                                          hb_font_get_nominal_glyph_func_t func,
                                          void* user_data,
                                          hb_destroy_func_t destroy);
void hb_font_funcs_set_variation_glyph_func(
    hb_font_funcs_t* ffuncs,
    hb_font_get_variation_glyph_func_t func,
    void* user_data,
    hb_destroy_func_t destroy);
void hb_font_funcs_set_glyph_h_advance_func(
    hb_font_funcs_t* ffuncs,
    hb_font_get_glyph_h_advance_func_t func,
    void* user_data,
    hb_destroy_func_t destroy);
void hb_font_funcs_set_glyph_h_advances_func(
    hb_font_funcs_t* ffuncs,
    hb_font_get_glyph_h_advances_func_t func,
    void* user_data,
    hb_destroy_func_t destroy);
void hb_font_funcs_set_glyph_v_advance_func(
    hb_font_funcs_t* ffuncs,
    hb_font_get_glyph_v_advance_func_t func,
    void* user_data,
    hb_destroy_func_t destroy);
void hb_font_funcs_set_glyph_v_origin_func(
    hb_font_funcs_t* ffuncs,
    hb_font_get_glyph_v_origin_func_t func,
    void* user_data,
    hb_destroy_func_t destroy);
void hb_font_funcs_set_glyph_extents_func(hb_font_funcs_t* ffuncs,
                                          hb_font_get_glyph_extents_func_t func,
                                          void* user_data,
                                          hb_destroy_func_t destroy);

// hb-ot-font.h, hb-ot-layout.h
void hb_ot_font_set_funcs(hb_font_t* font);
hb_language_t hb_ot_tag_to_language(hb_tag_t tag);

// hb-buffer.h
hb_buffer_t* hb_buffer_create(void);
void hb_buffer_destroy(hb_buffer_t* buffer);
void hb_buffer_reset(hb_buffer_t* buffer);
void hb_buffer_clear_contents(hb_buffer_t* buffer);
hb_bool_t hb_buffer_pre_allocate(hb_buffer_t* buffer, unsigned int size);
hb_bool_t hb_buffer_allocation_successful(hb_buffer_t* buffer);
void hb_buffer_set_content_type(hb_buffer_t* buffer,
                                hb_buffer_content_type_t content_type);
void hb_buffer_set_unicode_funcs(hb_buffer_t* buffer,
                                 hb_unicode_funcs_t* unicode_funcs);
void hb_buffer_set_direction(hb_buffer_t* buffer, hb_direction_t direction);
hb_direction_t hb_buffer_get_direction(const hb_buffer_t* buffer);
void hb_buffer_set_script(hb_buffer_t* buffer, hb_script_t script);
void hb_buffer_set_language(hb_buffer_t* buffer, hb_language_t language);
void hb_buffer_add(hb_buffer_t* buffer,
                   hb_codepoint_t codepoint,
                   unsigned int cluster);
void hb_buffer_add_utf8(hb_buffer_t* buffer,
                        const char* text,
                        int text_length,
                        unsigned int item_offset,
                        int item_length);
void hb_buffer_add_utf16(hb_buffer_t* buffer,
                         const uint16_t* text,
                         int text_length,
                         unsigned int item_offset,
                         int item_length);
void hb_buffer_add_latin1(hb_buffer_t* buffer,
                          const uint8_t* text,
                          int text_length,
                          unsigned int item_offset,
                          int item_length);
unsigned int hb_buffer_get_length(const hb_buffer_t* buffer);
hb_glyph_info_t* hb_buffer_get_glyph_infos(hb_buffer_t* buffer,
                                           unsigned int* length);
hb_glyph_position_t* hb_buffer_get_glyph_positions(hb_buffer_t* buffer,
                                                   unsigned int* length);
// hb-buffer.h also defines this name as a macro that reads info->mask; the
// parentheses keep the declaration valid next to that macro.
hb_glyph_flags_t(hb_glyph_info_get_glyph_flags)(const hb_glyph_info_t* info);

// hb-shape.h
hb_bool_t hb_shape_full(hb_font_t* font,
                        hb_buffer_t* buffer,
                        const hb_feature_t* features,
                        unsigned int num_features,
                        const char* const* shaper_list);

// hb-set.h
void hb_set_clear(hb_set_t* set);

// hb-unicode.h (only for an ICU-backed hb_unicode_funcs_t, MAP Q5 (b))
hb_unicode_funcs_t* hb_unicode_funcs_get_default(void);
hb_unicode_funcs_t* hb_unicode_funcs_create(hb_unicode_funcs_t* parent);
void hb_unicode_funcs_destroy(hb_unicode_funcs_t* ufuncs);
void hb_unicode_funcs_make_immutable(hb_unicode_funcs_t* ufuncs);
void hb_unicode_funcs_set_combining_class_func(
    hb_unicode_funcs_t* ufuncs,
    hb_unicode_combining_class_func_t func,
    void* user_data,
    hb_destroy_func_t destroy);
void hb_unicode_funcs_set_general_category_func(
    hb_unicode_funcs_t* ufuncs,
    hb_unicode_general_category_func_t func,
    void* user_data,
    hb_destroy_func_t destroy);
void hb_unicode_funcs_set_mirroring_func(hb_unicode_funcs_t* ufuncs,
                                         hb_unicode_mirroring_func_t func,
                                         void* user_data,
                                         hb_destroy_func_t destroy);
void hb_unicode_funcs_set_script_func(hb_unicode_funcs_t* ufuncs,
                                      hb_unicode_script_func_t func,
                                      void* user_data,
                                      hb_destroy_func_t destroy);
void hb_unicode_funcs_set_compose_func(hb_unicode_funcs_t* ufuncs,
                                       hb_unicode_compose_func_t func,
                                       void* user_data,
                                       hb_destroy_func_t destroy);
void hb_unicode_funcs_set_decompose_func(hb_unicode_funcs_t* ufuncs,
                                         hb_unicode_decompose_func_t func,
                                         void* user_data,
                                         hb_destroy_func_t destroy);

// hb-unicode.h queries and hb-common.h, for the UCD parity tripwire
// (shaper_ucd.cpp). Present on every target as the functions above: the
// q13 symbol dumps list each in libskshaper (and libskia where HB is there).
hb_unicode_combining_class_t hb_unicode_combining_class(
    hb_unicode_funcs_t* ufuncs,
    hb_codepoint_t unicode);
hb_unicode_general_category_t hb_unicode_general_category(
    hb_unicode_funcs_t* ufuncs,
    hb_codepoint_t unicode);
hb_codepoint_t hb_unicode_mirroring(hb_unicode_funcs_t* ufuncs,
                                    hb_codepoint_t unicode);
hb_script_t hb_unicode_script(hb_unicode_funcs_t* ufuncs,
                              hb_codepoint_t unicode);
hb_bool_t hb_unicode_compose(hb_unicode_funcs_t* ufuncs,
                             hb_codepoint_t a,
                             hb_codepoint_t b,
                             hb_codepoint_t* ab);
hb_bool_t hb_unicode_decompose(hb_unicode_funcs_t* ufuncs,
                               hb_codepoint_t ab,
                               hb_codepoint_t* a,
                               hb_codepoint_t* b);

}  // extern "C"

#endif  // SKIA_C_HB_API_H
