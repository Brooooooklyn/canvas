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
#include <include/core/SkColorFilter.h>
#include <include/core/SkData.h>
#include <include/core/SkDrawable.h>
#include <include/core/SkGraphics.h>
#include <include/core/SkFontMgr.h>
#include <include/core/SkPaint.h>
#include <include/core/SkPathEffect.h>
#include <include/core/SkSurface.h>
#include <include/core/SkMaskFilter.h>
#include <include/core/SkStream.h>
#include <include/core/SkPictureRecorder.h>
#include <include/core/SkStrokeRec.h>
#include <include/effects/SkColorMatrix.h>
#include <include/effects/SkDashPathEffect.h>
#include <include/effects/SkImageFilters.h>
#include <include/effects/SkTableColorFilter.h>
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
#include <modules/svg/include/SkSVGSVG.h>
#include <modules/svg/include/SkSVGNode.h>
#include <modules/svg/include/SkSVGRenderContext.h>
#include <src/ports/SkFontMgr_custom.h>
#include <src/core/SkFontDescriptor.h>
#include <src/xml/SkXMLWriter.h>

#include <stdint.h>

using namespace skia::textlayout;

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
typedef struct skiac_w_memory_stream skiac_w_memory_stream;

sk_sp<SkFontMgr> SkFontMgr_New_Custom_Empty();

enum class CssBaseline
{
  Top,
  Hanging,
  Middle,
  Alphabetic,
  Ideographic,
  Bottom,
};

class TypefaceFontProviderCustom : public TypefaceFontProvider
{
public:
  explicit TypefaceFontProviderCustom(sk_sp<SkFontMgr> mgr) : font_mgr(std::move(mgr))
  {
  }

  ~TypefaceFontProviderCustom(){};

  sk_sp<SkTypeface> onLegacyMakeTypeface(const char family_name[], SkFontStyle style) const override
  {
    auto style_set = this->onMatchFamily(family_name);
    if (!style_set)
    {
      return nullptr;
    }
    auto tf = style_set->matchStyle(style);
    if (!tf)
    {
      return nullptr;
    }
    return sk_sp<SkTypeface>(const_cast<SkTypeface *>(tf));
  }

private:
  sk_sp<SkFontMgr> font_mgr;
};

struct skiac_svg_surface
{
  skiac_w_memory_stream *stream;
  skiac_surface *surface;
  skiac_canvas *canvas;
};

struct skiac_font_collection
{
  sk_sp<FontCollection> collection;
  sk_sp<SkFontMgr> font_mgr;
  sk_sp<TypefaceFontProviderCustom> assets;
  skiac_font_collection() : collection(sk_make_sp<FontCollection>()), font_mgr(SkFontMgr_New_Custom_Empty()), assets(sk_make_sp<TypefaceFontProviderCustom>(font_mgr))
  {
    collection->setDefaultFontManager(font_mgr);
    collection->setAssetFontManager(assets);
    collection->enableFontFallback();
    assets->ref();
  }
};

struct skiac_line_metrics
{
  float ascent;
  float descent;
  float left;
  float right;
  float width;
  float font_ascent;
  float font_descent;
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

struct skiac_bitmap_info
{
  skiac_bitmap *bitmap;
  int width;
  int height;
};

struct skiac_string
{
  const char *ptr;
  size_t length;
  SkString *sk_string;
};

typedef void (*skiac_on_match_font_style)(int width, int weight, int slant, void *skiac_on_match_font_style_rust);

struct skiac_sk_data
{
  const uint8_t *ptr;
  size_t size;
  skiac_data *data;
};

struct skiac_mapped_point
{
  float x1;
  float y1;
  float x2;
  float y2;
};

extern "C"
{

  // Surface
  skiac_surface *skiac_surface_create_rgba_premultiplied(int width, int height);
  void skiac_surface_create_svg(skiac_svg_surface *c_surface, int width, int height, int alphaType, uint32_t flag);
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
  void skiac_surface_get_bitmap(skiac_surface *c_surface, skiac_bitmap_info *info);

  // Canvas
  void skiac_canvas_clear(skiac_canvas *c_canvas, uint32_t color);
  void skiac_canvas_set_transform(skiac_canvas *c_canvas, skiac_matrix *c_matrix);
  void skiac_canvas_concat(skiac_canvas *c_canvas, skiac_matrix *c_matrix);
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
      float sx,
      float sy,
      float sw,
      float sh,
      float dx,
      float dy,
      float dw,
      float dh,
      int filter_quality);
  void skiac_canvas_get_line_metrics_or_draw_text(
      const char *text,
      size_t text_len,
      float max_width,
      float x,
      float y,
      skiac_font_collection *c_collection,
      float font_size,
      int weight,
      int stretch,
      int slant,
      const char *font_family,
      int baseline,
      int align,
      int direction,
      skiac_paint *c_paint,
      skiac_canvas *c_canvas,
      skiac_line_metrics *c_line_metrics);
  void skiac_canvas_reset_transform(skiac_canvas *c_canvas);
  void skiac_canvas_clip_rect(skiac_canvas *c_canvas, float x, float y, float w, float h);
  void skiac_canvas_clip_path(skiac_canvas *c_canvas, skiac_path *c_path);
  void skiac_canvas_save(skiac_canvas *c_canvas);
  void skiac_canvas_restore(skiac_canvas *c_canvas);
  void skiac_canvas_reset(skiac_canvas *c_canvas);
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
  void skiac_path_swap(skiac_path *c_path, skiac_path *other_path);
  void skiac_add_path(skiac_path *c_path, skiac_path *other_path, skiac_matrix *c_matrix);
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
  skiac_path *skiac_path_transform(skiac_path *c_path, skiac_matrix *c_matrix);
  void skiac_path_transform_self(skiac_path *c_path, skiac_matrix *c_matrix);
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
  skiac_matrix *skiac_matrix_new(float a, float b, float c, float d, float e, float f);
  skiac_matrix *skiac_matrix_from_ts(const skiac_transform *c_ts);
  skiac_matrix *skiac_matrix_create_rotated(float rotation, float x, float y);
  skiac_matrix *skiac_matrix_create_translated(float x, float y);
  skiac_matrix *skiac_matrix_concat(skiac_matrix *c_matrix, skiac_matrix *other);
  skiac_matrix *skiac_matrix_multiply(skiac_matrix *c_matrix, skiac_matrix *other);
  skiac_matrix *skiac_matrix_clone(skiac_matrix *c_matrix);
  void skiac_matrix_map_points(skiac_matrix *c_matrix, float x1, float y1, float x2, float y2, skiac_mapped_point *mapped_point);
  void skiac_matrix_pre_translate(skiac_matrix *c_matrix, float dx, float dy);
  void skiac_matrix_pre_concat(skiac_matrix *c_matrix, skiac_matrix *other);
  void skiac_matrix_pre_scale(skiac_matrix *c_matrix, float sx, float sy);
  void skiac_matrix_pre_concat_transform(skiac_matrix *c_matrix, skiac_transform c_ts);
  void skiac_matrix_pre_rotate(skiac_matrix *c_matrix, float degrees);
  void skiac_matrix_pre_rotate_x_y(skiac_matrix *c_matrix, float degrees, float x, float y);
  bool skiac_matrix_invert(skiac_matrix *c_matrix, skiac_matrix *inverse);
  skiac_transform skiac_matrix_to_transform(skiac_matrix *c_matrix);
  void skiac_matrix_destroy(skiac_matrix *c_matrix);

  // MaskFilter
  skiac_mask_filter *skiac_mask_filter_make_blur(float radius);
  void skiac_mask_filter_destroy(skiac_mask_filter *c_mask_filter);

  // ImageFilter
  skiac_image_filter *skiac_image_filter_make_drop_shadow_only(float dx, float dy, float sigma_x, float sigma_y, uint32_t color, skiac_image_filter *c_image_filter);
  skiac_image_filter *skiac_image_filter_make_drop_shadow(float dx, float dy, float sigma_x, float sigma_y, uint32_t color, skiac_image_filter *c_image_filter);
  skiac_image_filter *skiac_image_filter_make_blur(float sigma_x, float sigma_y, int tile_mode, skiac_image_filter *c_image_filter);
  skiac_image_filter *skiac_image_filter_color_filter(float m00, float m01, float m02, float m10, float m11, float m12, float m20, float m21, float m22, float opacity, skiac_image_filter *c_image_filter);
  skiac_image_filter *skiac_image_filter_from_argb(const uint8_t table_a[256], const uint8_t table_r[256], const uint8_t table_g[256], const uint8_t table_b[256], skiac_image_filter *c_image_filter);
  void skiac_image_filter_destroy(skiac_image_filter *c_image_filter);

  // Data
  void skiac_sk_data_destroy(skiac_data *c_data);

  // Bitmap
  void skiac_bitmap_make_from_buffer(const uint8_t *ptr, size_t size, skiac_bitmap_info *bitmap_info);
  void skiac_bitmap_make_from_svg(const uint8_t *data, size_t length, float width, float height, skiac_bitmap_info *bitmap_info);
  skiac_bitmap *skiac_bitmap_make_from_image_data(uint8_t *ptr, size_t width, size_t height, size_t row_bytes, size_t size, int ct, int at);
  size_t skiac_bitmap_get_width(skiac_bitmap *c_bitmap);
  size_t skiac_bitmap_get_height(skiac_bitmap *c_bitmap);
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

  // FontCollection
  skiac_font_collection *skiac_font_collection_create();
  uint32_t skiac_font_collection_get_default_fonts_count(skiac_font_collection *c_font_collection);
  void skiac_font_collection_get_family(skiac_font_collection *c_font_collection, uint32_t i, skiac_string *c_string, void *on_get_style_rust, skiac_on_match_font_style on_match_font_style);
  size_t skiac_font_collection_register(skiac_font_collection *c_font_collection, const uint8_t *font, size_t length, const char *name_alias);
  size_t skiac_font_collection_register_from_path(skiac_font_collection *c_font_collection, const char *font_path, const char *name_alias);
  void skiac_font_collection_destroy(skiac_font_collection *c_font_collection);

  // SkDynamicMemoryWStream
  void skiac_sk_w_stream_get(skiac_w_memory_stream *c_w_memory_stream, skiac_sk_data *sk_data, int width, int height);
  void skiac_sk_w_stream_destroy(skiac_w_memory_stream *c_w_memory_stream);

  // SkSVG
  void skiac_svg_text_to_path(const uint8_t *data, size_t length, skiac_font_collection *c_collection, skiac_sk_data *output_data);
}

#endif // SKIA_CAPI_H
