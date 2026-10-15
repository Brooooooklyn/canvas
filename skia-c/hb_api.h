// The HarfBuzz C API the text code calls. HarfBuzz is linked from libskia
// (skia_use_harfbuzz, bundled, unversioned symbols), but its headers are not
// part of the Skia checkout the addon builds against, so the few declarations
// needed live here, copied from hb-common.h, hb-blob.h, hb-face.h, hb-font.h,
// hb-set.h and hb-ot-layout.h.

#ifndef SKIA_C_HB_API_H
#define SKIA_C_HB_API_H

#include <stdint.h>

extern "C" {

typedef int hb_bool_t;
typedef uint32_t hb_tag_t;
typedef int32_t hb_position_t;
typedef uint32_t hb_codepoint_t;
typedef struct hb_blob_t hb_blob_t;
typedef struct hb_set_t hb_set_t;
typedef struct hb_face_t hb_face_t;
typedef struct hb_font_t hb_font_t;
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

#define HB_OT_TAG_GSUB SKIAC_HB_TAG('G', 'S', 'U', 'B')
#define HB_OT_TAG_GPOS SKIAC_HB_TAG('G', 'P', 'O', 'S')
#define HB_OT_TAG_DEFAULT_SCRIPT SKIAC_HB_TAG('D', 'F', 'L', 'T')
#define HB_OT_TAG_DEFAULT_LANGUAGE SKIAC_HB_TAG('d', 'f', 'l', 't')

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

}  // extern "C"

#endif  // SKIA_C_HB_API_H
