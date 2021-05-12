#ifndef SKIA_CAPI_H
#define SKIA_CAPI_H

#include <include/codec/SkCodec.h>
#include <include/core/SkPicture.h>
#include <include/core/SkSamplingOptions.h>
#include <include/core/SkString.h>
#include <include/effects/SkImageFilters.h>
#include <include/pathops/SkPathOps.h>
#include <include/utils/SkParsePath.h>
#include <include/core/SkBitmap.h>
#include <include/core/SkCanvas.h>
#include <include/core/SkData.h>
#include <include/core/SkGraphics.h>
#include <include/core/SkPaint.h>
#include <include/core/SkPathEffect.h>
#include <include/core/SkSurface.h>
#include <include/core/SkMaskFilter.h>
#include <include/core/SkStream.h>
#include <include/core/SkStrokeRec.h>
#include <include/effects/SkDashPathEffect.h>
#include <include/effects/SkTrimPathEffect.h>
#include <include/effects/SkGradientShader.h>
#include <include/svg/SkSVGCanvas.h>
#include <modules/skparagraph/include/FontCollection.h>
#include <modules/skparagraph/include/Paragraph.h>
#include <modules/skparagraph/include/ParagraphBuilder.h>
#include <modules/skparagraph/src/ParagraphBuilderImpl.h>
#include <modules/skparagraph/src/ParagraphImpl.h>
#include <modules/skparagraph/include/TypefaceFontProvider.h>
#include <modules/svg/include/SkSVGDOM.h>
#include <src/ports/SkFontMgr_custom.h>

#include <stdint.h>

using namespace skia::textlayout;

template <typename T>
inline sk_sp<T> sp_from_const(const T *pt)
{
  return sk_sp<T>(const_cast<T *>(pt));
}

typedef struct skiac_surface skiac_surface;
typedef struct skiac_canvas skiac_canvas;
typedef struct skiac_paint skiac_paint;
typedef struct skiac_path skiac_path;
typedef struct skiac_shader skiac_shader;
typedef struct skiac_path_effect skiac_path_effect;
typedef struct skiac_matrix skiac_matrix;
typedef struct skiac_mask_filter skiac_mask_filter;
typedef struct skiac_image_filter skiac_image_filter;
typedef struct skiac_data skiac_data;
typedef struct skiac_image skiac_image;
typedef struct skiac_bitmap skiac_bitmap;
typedef struct skiac_sk_string skiac_sk_string;
typedef struct skiac_font_metrics skiac_font_metrics;
typedef struct skiac_typeface skiac_typeface;
typedef struct skiac_font_mgr skiac_font_mgr;
typedef struct skiac_typeface_font_provider skiac_typeface_font_provider;
typedef struct skiac_font_collection skiac_font_collection;

sk_sp<SkFontMgr> SkFontMgr_New_Custom_Empty();

struct skiac_font_collection
{
  sk_sp<FontCollection> collection;
  sk_sp<SkFontMgr> font_mgr;
  sk_sp<TypefaceFontProvider> assets;
  skiac_font_collection()
  {
    font_mgr = SkFontMgr_New_Custom_Empty();
    assets = sk_make_sp<TypefaceFontProvider>();
    collection = sk_make_sp<FontCollection>();
    collection->setDefaultFontManager(font_mgr);
    collection->setAssetFontManager(assets);
    collection->enableFontFallback();
  }
  skiac_font_collection(sk_sp<FontCollection> collection)
  {
    font_mgr = SkFontMgr_New_Custom_Empty();
    assets = sk_make_sp<TypefaceFontProvider>();
    collection->setDefaultFontManager(font_mgr);
    collection->enableFontFallback();
    collection->setAssetFontManager(assets);
    this->collection = collection;
  }
};

struct skiac_line_metrics
{
  float ascent;
  float descent;
  float left;
  float width;
  float baseline;
};

struct skiac_rect
{
  float left;
  float top;
  float right;
  float bottom;
};

struct skiac_transform
{
  float a;
  float b;
  float c;
  float d;
  float e;
  float f;
};

struct skiac_point
{
  float x;
  float y;
};

struct skiac_surface_data
{
  uint8_t *ptr;
  size_t size;
};

struct skiac_string
{
  const char *ptr;
  size_t length;
  SkString *sk_string;
};

struct skiac_sk_data
{
  uint8_t *ptr;
  size_t size;
  skiac_data *data;
};

extern "C"
{

  // Surface
  skiac_surface *skiac_surface_create_rgba_premultiplied(int width, int height);
  skiac_surface *skiac_surface_create_rgba(int width, int height);
  void skiac_surface_destroy(skiac_surface *c_surface);
  skiac_surface *skiac_surface_copy_rgba(
      skiac_surface *c_surface,
      uint32_t x,
      uint32_t y,
      uint32_t width,
      uint32_t height);
  skiac_canvas *skiac_surface_get_canvas(skiac_surface *c_surface);
  int skiac_surface_get_width(skiac_surface *c_surface);
  int skiac_surface_get_height(skiac_surface *c_surface);
  void skiac_surface_read_pixels(skiac_surface *c_surface, skiac_surface_data *data);
  bool skiac_surface_read_pixels_rect(skiac_surface *c_surface, uint8_t *data, int x, int y, int w, int h);
  void skiac_surface_png_data(skiac_surface *c_surface, skiac_sk_data *data);
  void skiac_surface_encode_data(skiac_surface *c_surface, skiac_sk_data *data, int format, int quality);
  int skiac_surface_get_alpha_type(skiac_surface *c_surface);
  bool skiac_surface_save(skiac_surface *c_surface, const char *path);

  // Canvas
  void skiac_canvas_clear(skiac_canvas *c_canvas, uint32_t color);
  void skiac_canvas_set_transform(skiac_canvas *c_canvas, skiac_transform c_ts);
  void skiac_canvas_concat(skiac_canvas *c_canvas, skiac_transform c_ts);
  void skiac_canvas_scale(skiac_canvas *c_canvas, float sx, float sy);
  void skiac_canvas_translate(skiac_canvas *c_canvas, float dx, float dy);
  void skiac_canvas_rotate(skiac_canvas *c_canvas, float degrees);
  skiac_transform skiac_canvas_get_total_transform(skiac_canvas *c_canvas);
  skiac_matrix *skiac_canvas_get_total_transform_matrix(skiac_canvas *c_canvas);
  void skiac_canvas_draw_color(skiac_canvas *c_canvas, float r, float g, float b, float a);
  void skiac_canvas_draw_image(skiac_canvas *c_canvas, skiac_bitmap *c_bitmap, float sx, float sy, float s_width, float s_height, float dx, float dy, float d_width, float d_height, skiac_paint *c_paint);
  void skiac_canvas_draw_path(skiac_canvas *c_canvas, skiac_path *c_path, skiac_paint *c_paint);
  void skiac_canvas_draw_rect(
      skiac_canvas *c_canvas,
      float x, float y, float w, float h,
      skiac_paint *c_paint);
  void skiac_canvas_draw_surface(
      skiac_canvas *c_canvas,
      skiac_surface *c_surface,
      float left,
      float top,
      uint8_t alpha,
      int blend_mode,
      int filter_quality);
  void skiac_canvas_draw_surface_rect(
      skiac_canvas *c_canvas,
      skiac_surface *c_surface,
      float x, float y, float w, float h,
      int filter_quality);
  void skiac_canvas_draw_text(
      skiac_canvas *c_canvas,
      const char *text,
      size_t text_len,
      float x,
      float y,
      float max_width,
      int weight,
      int width,
      int slant,
      skiac_font_collection *font_collection,
      float font_size,
      const char *font_family,
      float baseline_offset,
      uint8_t align,
      float align_factor,
      skiac_paint *c_paint);
  skiac_line_metrics skiac_canvas_get_line_metrics(
      const char *text,
      skiac_font_collection *c_collection,
      float font_size,
      const char *font_family,
      uint8_t align,
      float align_factor,
      skiac_paint *c_paint);
  void skiac_canvas_reset_transform(skiac_canvas *c_canvas);
  void skiac_canvas_clip_rect(skiac_canvas *c_canvas, float x, float y, float w, float h);
  void skiac_canvas_clip_path(skiac_canvas *c_canvas, skiac_path *c_path);
  void skiac_canvas_save(skiac_canvas *c_canvas);
  void skiac_canvas_restore(skiac_canvas *c_canvas);
  void skiac_canvas_write_pixels(skiac_canvas *c_canvas, int width, int height, uint8_t *pixels, size_t row_bytes, int x, int y);
  void skiac_canvas_write_pixels_dirty(skiac_canvas *c_canvas, int width, int height, uint8_t *pixels, size_t row_bytes, size_t length, float x, float y, float dirty_x, float dirty_y, float dirty_width, float dirty_height);

  // Paint
  skiac_paint *skiac_paint_create();
  skiac_paint *skiac_paint_clone(skiac_paint *c_paint);
  void skiac_paint_destroy(skiac_paint *c_paint);
  void skiac_paint_set_style(skiac_paint *c_paint, int style);
  void skiac_paint_set_color(skiac_paint *c_paint, uint8_t r, uint8_t g, uint8_t b, uint8_t a);
  void skiac_paint_set_alpha(skiac_paint *c_paint, uint8_t a);
  uint8_t skiac_paint_get_alpha(skiac_paint *c_paint);
  void skiac_paint_set_anti_alias(skiac_paint *c_paint, bool aa);
  void skiac_paint_set_blend_mode(skiac_paint *c_paint, int blend_mode);
  int skiac_paint_get_blend_mode(skiac_paint *c_paint);
  void skiac_paint_set_shader(skiac_paint *c_paint, skiac_shader *c_shader);
  void skiac_paint_set_stroke_width(skiac_paint *c_paint, float width);
  float skiac_paint_get_stroke_width(skiac_paint *c_paint);
  void skiac_paint_set_stroke_cap(skiac_paint *c_paint, int cap);
  int skiac_paint_get_stroke_cap(skiac_paint *c_paint);
  void skiac_paint_set_stroke_join(skiac_paint *c_paint, uint8_t join);
  uint8_t skiac_paint_get_stroke_join(skiac_paint *c_paint);
  void skiac_paint_set_stroke_miter(skiac_paint *c_paint, float miter);
  float skiac_paint_get_stroke_miter(skiac_paint *c_paint);
  void skiac_paint_set_path_effect(skiac_paint *c_paint, skiac_path_effect *c_path_effect);
  void skiac_paint_set_mask_filter(skiac_paint *c_paint, skiac_mask_filter *c_mask_filter);
  void skiac_paint_set_image_filter(skiac_paint *c_paint, skiac_image_filter *c_image_filter);

  // Path
  skiac_path *skiac_path_create();
  skiac_path *skiac_path_from_svg(char *svg_path);
  skiac_path *skiac_path_clone(skiac_path *c_path);
  void skiac_add_path(skiac_path *c_path, skiac_path *other_path, skiac_transform c_transform);
  bool skiac_path_op(skiac_path *c_path_one, skiac_path *c_path_two, int op);
  void skiac_path_to_svg_string(skiac_path *c_path, skiac_string *c_string);
  bool skiac_path_simplify(skiac_path *c_path);
  bool skiac_path_stroke(skiac_path *c_path, int cap, uint8_t join, float width, float miter_limit);
  void skiac_path_get_bounds(skiac_path *c_path, skiac_rect *c_rect);
  void skiac_path_compute_tight_bounds(skiac_path *c_path, skiac_rect *c_rect);
  bool skiac_path_trim(skiac_path *c_path, float start_t, float stop_t, bool is_complement);
  bool skiac_path_dash(skiac_path *c_path, float on, float off, float phase);
  bool skiac_path_equals(skiac_path *c_path, skiac_path *other_path);
  void skiac_path_destroy(skiac_path *c_path);
  void skiac_path_set_fill_type(skiac_path *c_path, int type);
  int skiac_path_get_fill_type(skiac_path *c_path);
  bool skiac_path_as_winding(skiac_path *c_path);
  void skiac_path_arc_to(skiac_path *c_path, float left, float top, float right, float bottom, float startAngle, float sweepAngle, bool forceMoveTo);
  void skiac_path_arc_to_tangent(skiac_path *c_path, float x1, float y1, float x2, float y2, float radius);
  void skiac_path_move_to(skiac_path *c_path, float x, float y);
  void skiac_path_line_to(skiac_path *c_path, float x, float y);
  void skiac_path_cubic_to(
      skiac_path *c_path,
      float x1, float y1, float x2, float y2, float x3, float y3);
  void skiac_path_quad_to(skiac_path *c_path, float cpx, float cpy, float x, float y);
  void skiac_path_close(skiac_path *c_path);
  void skiac_path_add_rect(skiac_path *c_path, float l, float t, float r, float b);
  void skiac_path_add_circle(skiac_path *c_path, float x, float y, float r);
  void skiac_path_transform(skiac_path *c_path, skiac_transform c_transform);
  void skiac_path_transform_matrix(skiac_path *c_path, skiac_matrix *c_matrix);
  bool skiac_path_is_empty(skiac_path *c_path);
  bool skiac_path_hit_test(skiac_path *c_path, float x, float y, int type);
  bool skiac_path_stroke_hit_test(skiac_path *c_path, float x, float y, float stroke_w);

  // PathEffect
  skiac_path_effect *skiac_path_effect_make_dash_path(const float *intervals, int count, float phase);
  void skiac_path_effect_destroy(skiac_path_effect *c_path_effect);

  // Shader
  skiac_shader *skiac_shader_make_linear_gradient(
      const skiac_point *points,
      const uint32_t *colors,
      const float *positions,
      int count,
      int tile_mode,
      uint32_t flags,
      skiac_transform c_ts);
  skiac_shader *skiac_shader_make_radial_gradient(
      skiac_point start_point,
      float start_radius,
      skiac_point end_point,
      float end_radius,
      const uint32_t *colors,
      const float *positions,
      int count,
      int tile_mode,
      uint32_t flags,
      skiac_transform c_ts);
  skiac_shader *skiac_shader_make_conic_gradient(
      float cx,
      float cy,
      float radius,
      const uint32_t *colors,
      const float *positions,
      int count,
      int tile_mode,
      uint32_t flags,
      skiac_transform c_ts);
  skiac_shader *skiac_shader_make_from_surface_image(
      skiac_surface *c_surface,
      skiac_transform c_ts,
      int filter_quality);

  void skiac_shader_destroy(skiac_shader *c_shader);

  // Matrix
  skiac_matrix *skiac_matrix_create();
  skiac_matrix *skiac_matrix_clone(skiac_matrix *c_matrix);
  void skiac_matrix_pre_translate(skiac_matrix *c_matrix, float dx, float dy);
  void skiac_matrix_pre_rotate(skiac_matrix *c_matrix, float degrees);
  bool skiac_matrix_invert(skiac_matrix *c_matrix, skiac_matrix *inverse);
  skiac_transform skiac_matrix_to_transform(skiac_matrix *c_matrix);
  void skiac_matrix_destroy(skiac_matrix *c_matrix);

  // MaskFilter
  skiac_mask_filter *skiac_mask_filter_make_blur(float radius);
  void skiac_mask_filter_destroy(skiac_mask_filter *c_mask_filter);

  // ImageFilter
  skiac_image_filter *skiac_image_filter_make_drop_shadow(float dx, float dy, float sigma_x, float sigma_y, uint32_t color);
  void skiac_image_filter_destroy(skiac_image_filter *c_image_filter);

  // Data
  void skiac_sk_data_destroy(skiac_data *c_data);

  // Bitmap
  skiac_bitmap *skiac_bitmap_make_from_buffer(const uint8_t *ptr, size_t size);
  skiac_bitmap *skiac_bitmap_make_from_svg(const uint8_t *data, size_t length);
  skiac_bitmap *skiac_bitmap_make_from_image_data(uint8_t *ptr, size_t width, size_t height, size_t row_bytes, size_t size, int ct, int at);
  uint32_t skiac_bitmap_get_width(skiac_bitmap *c_bitmap);
  uint32_t skiac_bitmap_get_height(skiac_bitmap *c_bitmap);
  skiac_shader *skiac_bitmap_get_shader(
      skiac_bitmap *c_bitmap,
      int repeat_x,
      int repeat_y,
      float B,
      float C, // See SkSamplingOptions.h for docs.
      skiac_transform c_ts);
  void skiac_bitmap_destroy(skiac_bitmap *c_bitmap);

  // SkString
  void skiac_delete_sk_string(skiac_sk_string *c_sk_string);

  // TypefaceFontProvider
  skiac_typeface_font_provider *skiac_typeface_font_provider_create();
  size_t skiac_typeface_font_provider_register(skiac_typeface_font_provider *c_typeface_font_provider, skiac_font_mgr *c_font_mgr, uint8_t *font, size_t length);
  size_t skiac_typeface_font_provider_register_from_file(skiac_typeface_font_provider *c_typeface_font_provider, skiac_font_mgr *c_font_mgr, const char *font_path);
  void skiac_typeface_font_provider_ref(skiac_typeface_font_provider *c_typeface_font_provider);
  void skiac_typeface_font_provider_unref(skiac_typeface_font_provider *c_typeface_font_provider);

  // FontMetrics
  skiac_font_metrics *skiac_font_metrics_create(const char *font_family, float font_size);
  void skiac_font_metrics_destroy(skiac_font_metrics *c_font_metrics);

  // FontCollection
  skiac_font_collection *skiac_font_collection_create();
  skiac_font_collection *skiac_font_collection_clone(skiac_font_collection *c_font_collection);
  uint32_t skiac_font_collection_get_default_fonts_count(skiac_font_collection *c_font_collection);
  void skiac_font_collection_get_family(skiac_font_collection *c_font_collection, uint32_t i, skiac_string *c_string);
  size_t skiac_font_collection_register(skiac_font_collection *c_font_collection, const uint8_t *font, size_t length);
  size_t skiac_font_collection_register_from_path(skiac_font_collection *c_font_collection, const char *font_path);
  void skiac_font_collection_destroy(skiac_font_collection *c_font_collection);
}

#endif // SKIA_CAPI_H
