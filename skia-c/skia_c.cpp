#include <assert.h>
#include <math.h>

#include "skia_c.hpp"

#define SURFACE_CAST reinterpret_cast<SkSurface *>(c_surface)
#define CANVAS_CAST reinterpret_cast<SkCanvas *>(c_canvas)
#define PAINT_CAST reinterpret_cast<SkPaint *>(c_paint)
#define BITMAP_CAST reinterpret_cast<SkBitmap *>(c_bitmap)
#define PATH_CAST reinterpret_cast<SkPath *>(c_path)
#define MATRIX_CAST reinterpret_cast<SkMatrix *>(c_matrix)
#define MASK_FILTER_CAST reinterpret_cast<SkMaskFilter *>(c_mask_filter)
#define IMAGE_FILTER_CAST reinterpret_cast<SkImageFilter *>(c_image_filter)
#define FONT_METRICS_CAST reinterpret_cast<SkFontMetrics *>(c_font_metrics)
#define TYPEFACE_CAST reinterpret_cast<SkTypeface *>(c_typeface)

#define MAX_LAYOUT_WIDTH 100000

extern "C"
{

  static SkMatrix conv_from_transform(const skiac_transform &c_ts)
  {
    return SkMatrix::MakeAll(c_ts.a, c_ts.c, c_ts.e,
                             c_ts.b, c_ts.d, c_ts.f,
                             0, 0, 1);
  }

  static skiac_transform conv_to_transform(const SkMatrix &matrix)
  {
    return skiac_transform{
        matrix.getScaleX(),
        matrix.getSkewY(), // Yes, inverted.
        matrix.getSkewX(), // Skia uses such order for some reasons.
        matrix.getScaleY(),
        matrix.getTranslateX(),
        matrix.getTranslateY(),
    };
  }

  // Surface

  static SkSurface *skiac_surface_create(int width, int height, SkAlphaType alphaType)
  {
    // Init() is indempotent, so can be called more than once with no adverse effect.
    SkGraphics::Init();

    auto info = SkImageInfo::Make(width, height, kRGBA_8888_SkColorType, alphaType);
    auto surface = SkSurface::MakeRaster(info);

    if (surface)
    {
      // The surface ref count will equal one after the pointer is returned.
      return surface.release();
    }
    else
    {
      return nullptr;
    }
  }

  skiac_surface *skiac_surface_create_rgba_premultiplied(int width, int height)
  {
    return reinterpret_cast<skiac_surface *>(
        skiac_surface_create(width, height, kPremul_SkAlphaType));
  }

  skiac_surface *skiac_surface_create_rgba(int width, int height)
  {
    return reinterpret_cast<skiac_surface *>(
        skiac_surface_create(width, height, kUnpremul_SkAlphaType));
  }

  bool skiac_surface_save(skiac_surface *c_surface, const char *path)
  {
    auto image = SURFACE_CAST->makeImageSnapshot();
    auto data = image->encodeToData(SkEncodedImageFormat::kPNG, 0);
    if (data)
    {
      SkFILEWStream stream(path);
      if (stream.write(data->data(), data->size()))
      {
        stream.flush();
        return true;
      }
    }

    return false;
  }

  void skiac_surface_destroy(skiac_surface *c_surface)
  {
    // SkSurface is ref counted.
    SURFACE_CAST->unref();
  }

  skiac_surface *skiac_surface_copy_rgba(
      skiac_surface *c_surface,
      uint32_t x, uint32_t y, uint32_t width, uint32_t height)
  {
    // x, y, width, height are source rectangle coordinates.
    auto copy = skiac_surface_create((int)width, (int)height, kUnpremul_SkAlphaType);
    if (!copy)
    {
      return nullptr;
    }

    SkPaint paint;
    paint.setFilterQuality(SkFilterQuality::kLow_SkFilterQuality);
    paint.setAlpha(SK_AlphaOPAQUE);

    // The original surface draws itself to the copy's canvas.
    SURFACE_CAST->draw(copy->getCanvas(), -(SkScalar)x, -(SkScalar)y, &paint);

    return reinterpret_cast<skiac_surface *>(copy);
  }

  int skiac_surface_get_width(skiac_surface *c_surface)
  {
    return SURFACE_CAST->width();
  }

  int skiac_surface_get_height(skiac_surface *c_surface)
  {
    return SURFACE_CAST->height();
  }

  skiac_canvas *skiac_surface_get_canvas(skiac_surface *c_surface)
  {
    return reinterpret_cast<skiac_canvas *>(SURFACE_CAST->getCanvas());
  }

  void skiac_surface_read_pixels(skiac_surface *c_surface, skiac_surface_data *data)
  {
    data->ptr = nullptr;
    data->size = 0;

    SkPixmap pixmap;
    if (SURFACE_CAST->peekPixels(&pixmap))
    {
      data->ptr = static_cast<uint8_t *>(pixmap.writable_addr());
      data->size = pixmap.computeByteSize();
    }
  }

  bool skiac_surface_read_pixels_rect(skiac_surface *c_surface, uint8_t *data, int x, int y, int w, int h)
  {
    auto image_info = SkImageInfo::Make(w, h, SkColorType::kRGBA_8888_SkColorType, SkAlphaType::kUnpremul_SkAlphaType, SkColorSpace::MakeSRGB());
    auto result = SURFACE_CAST->readPixels(image_info, data, w * 4, x, y);
    return result;
  }

  void skiac_surface_png_data(skiac_surface *c_surface, skiac_sk_data *data)
  {
    auto image = SURFACE_CAST->makeImageSnapshot();
    auto png_data = image->encodeToData().release();
    if (png_data)
    {
      data->ptr = const_cast<uint8_t *>(png_data->bytes());
      data->size = png_data->size();
      data->data = reinterpret_cast<skiac_data *>(png_data);
    }
  }

  void skiac_surface_encode_data(skiac_surface *c_surface, skiac_sk_data *data, int format, int quality)
  {
    auto image = SURFACE_CAST->makeImageSnapshot();
    auto encoded_data = image->encodeToData((SkEncodedImageFormat)format, quality).release();
    if (encoded_data)
    {
      data->ptr = const_cast<uint8_t *>(encoded_data->bytes());
      data->size = encoded_data->size();
      data->data = reinterpret_cast<skiac_data *>(encoded_data);
    }
  }

  int skiac_surface_get_alpha_type(skiac_surface *c_surface)
  {
    return SURFACE_CAST->imageInfo().alphaType();
  }

  // Canvas

  void skiac_canvas_clear(skiac_canvas *c_canvas, uint32_t color)
  {
    CANVAS_CAST->clear(static_cast<SkColor>(color));
  }

  void skiac_canvas_set_transform(skiac_canvas *c_canvas, skiac_transform c_ts)
  {
    CANVAS_CAST->setMatrix(conv_from_transform(c_ts));
  }

  void skiac_canvas_concat(skiac_canvas *c_canvas, skiac_transform c_ts)
  {
    CANVAS_CAST->concat(conv_from_transform(c_ts));
  }

  void skiac_canvas_scale(skiac_canvas *c_canvas, float sx, float sy)
  {
    CANVAS_CAST->scale(sx, sy);
  }

  void skiac_canvas_translate(skiac_canvas *c_canvas, float dx, float dy)
  {
    CANVAS_CAST->translate(dx, dy);
  }

  void skiac_canvas_rotate(skiac_canvas *c_canvas, float degrees)
  {
    CANVAS_CAST->rotate(degrees);
  }

  skiac_matrix *skiac_canvas_get_total_transform_matrix(skiac_canvas *c_canvas)
  {
    auto martix = CANVAS_CAST->getTotalMatrix();
    return reinterpret_cast<skiac_matrix *>(new SkMatrix(martix));
  }

  skiac_transform skiac_canvas_get_total_transform(skiac_canvas *c_canvas)
  {
    return conv_to_transform(CANVAS_CAST->getTotalMatrix());
  }

  void skiac_canvas_draw_color(skiac_canvas *c_canvas, float r, float g, float b, float a)
  {
    CANVAS_CAST->drawColor(SkColor4f{r, g, b, a});
  }

  void skiac_canvas_draw_image(skiac_canvas *c_canvas, skiac_bitmap *c_bitmap, float sx, float sy, float s_width, float s_height, float dx, float dy, float d_width, float d_height, skiac_paint *c_paint)
  {
    const auto src_rect = SkRect::MakeXYWH(sx, sy, s_width, s_height);
    const auto dst_rect = SkRect::MakeXYWH(dx, dy, d_width, d_height);
    auto sk_image = SkImage::MakeFromBitmap(*BITMAP_CAST);
    const auto sampling = SkSamplingOptions();
    auto paint = reinterpret_cast<const SkPaint *>(c_paint);
    CANVAS_CAST->drawImageRect(sk_image, src_rect, dst_rect, sampling, paint, SkCanvas::kFast_SrcRectConstraint);
  }

  void skiac_canvas_draw_path(skiac_canvas *c_canvas, skiac_path *c_path, skiac_paint *c_paint)
  {
    CANVAS_CAST->drawPath(*PATH_CAST, *PAINT_CAST);
  }

  void skiac_canvas_draw_rect(
      skiac_canvas *c_canvas,
      float x, float y, float w, float h,
      skiac_paint *c_paint)
  {
    CANVAS_CAST->drawRect(SkRect::MakeXYWH(x, y, w, h), *PAINT_CAST);
  }

  void skiac_canvas_draw_surface(
      skiac_canvas *c_canvas,
      skiac_surface *c_surface,
      float left,
      float top,
      uint8_t alpha,
      int blend_mode,
      int filter_quality)
  {
    auto image = SURFACE_CAST->makeImageSnapshot();
    SkPaint paint;
    paint.setFilterQuality((SkFilterQuality)filter_quality);
    paint.setAlpha(alpha);
    paint.setBlendMode((SkBlendMode)blend_mode);
    const auto sampling = SkSamplingOptions();
    CANVAS_CAST->drawImage(image, left, top, sampling, &paint);
  }

  void skiac_canvas_draw_surface_rect(
      skiac_canvas *c_canvas,
      skiac_surface *c_surface,
      float x, float y, float w, float h,
      int filter_quality)
  {
    auto image = SURFACE_CAST->makeImageSnapshot();
    SkPaint paint;
    paint.setFilterQuality((SkFilterQuality)filter_quality);
    auto src = SkRect::MakeXYWH(0, 0, image->width(), image->height());
    auto dst = SkRect::MakeXYWH(x, y, w, h);
    const auto sampling = SkSamplingOptions();
    CANVAS_CAST->drawImageRect(image, src, dst, sampling, &paint, SkCanvas::kFast_SrcRectConstraint);
  }

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
      skiac_paint *c_paint)
  {
    TextStyle text_style;
    auto font_style = SkFontStyle(weight, width, (SkFontStyle::Slant)slant);
    const std::vector<SkString> families = {SkString(font_family)};
    text_style.setFontFamilies(families);
    text_style.setFontSize(font_size);
    text_style.setForegroundColor(*PAINT_CAST);
    text_style.setWordSpacing(0);
    text_style.setHeight(1);
    text_style.setFontStyle(font_style);

    ParagraphStyle paragraph_style;
    paragraph_style.turnHintingOff();
    paragraph_style.setTextStyle(text_style);
    paragraph_style.setTextAlign((TextAlign)align);
    auto builder = ParagraphBuilderImpl::make(paragraph_style, font_collection->collection).release();
    builder->pushStyle(text_style);
    builder->addText(text, text_len);

    auto paragraph = reinterpret_cast<ParagraphImpl *>(builder->Build().release());
    auto alphabetic_baseline = paragraph->getAlphabeticBaseline();

    auto paint_x = x + max_width * align_factor;
    paragraph->layout(MAX_LAYOUT_WIDTH);
    auto metrics = std::vector<LineMetrics>();
    paragraph->getLineMetrics(metrics);
    auto line_metric = metrics[0];
    auto line_width = line_metric.fWidth;
    auto need_scale = line_width > max_width;
    if (need_scale)
    {
      CANVAS_CAST->save();
      CANVAS_CAST->scale(max_width / line_width, 1.0);
    }

    auto paint_y = y + baseline_offset - paragraph->getHeight() - alphabetic_baseline;
    paragraph->paint(CANVAS_CAST, paint_x, paint_y);
    if (need_scale)
    {
      CANVAS_CAST->restore();
    }
    delete paragraph;
  }

  skiac_line_metrics skiac_canvas_get_line_metrics(
      const char *text,
      skiac_font_collection *c_collection,
      float font_size,
      const char *font_family,
      uint8_t align,
      float align_factor,
      skiac_paint *c_paint)
  {
    auto font_collection = c_collection->collection;

    TextStyle text_style;
    text_style.setFontFamilies({SkString(font_family)});
    text_style.setFontSize(font_size);
    text_style.setWordSpacing(0);
    text_style.setHeight(1);

    ParagraphStyle paragraph_style;
    paragraph_style.turnHintingOff();
    paragraph_style.setTextStyle(text_style);
    paragraph_style.setTextAlign((TextAlign)align);

    auto builder = ParagraphBuilder::make(paragraph_style, font_collection);
    builder->addText(text, strlen(text));

    auto paragraph = builder->Build();
    paragraph->layout(MAX_LAYOUT_WIDTH);

    auto metrics_vec = std::vector<LineMetrics>();
    paragraph->getLineMetrics(metrics_vec);
    auto line_metrics = metrics_vec[0];
    SkDebugf("ascent %f\ndescent %f\nleft %f\nwidth %f\nbaseline %f\n",
             line_metrics.fAscent,
             line_metrics.fDescent,
             line_metrics.fLeft,
             line_metrics.fWidth,
             line_metrics.fBaseline);
    skiac_line_metrics result;
    result.ascent = line_metrics.fAscent;
    result.descent = line_metrics.fDescent;
    result.left = line_metrics.fLeft;
    result.width = line_metrics.fWidth;
    result.baseline = line_metrics.fBaseline;
    return result;
  }

  void skiac_canvas_reset_transform(skiac_canvas *c_canvas)
  {
    CANVAS_CAST->resetMatrix();
  }

  void skiac_canvas_clip_rect(skiac_canvas *c_canvas, float x, float y, float w, float h)
  {
    auto rect = SkRect::MakeXYWH(x, y, w, h);
    CANVAS_CAST->clipRect(rect, true);
  }

  void skiac_canvas_clip_path(skiac_canvas *c_canvas, skiac_path *c_path)
  {
    auto path = reinterpret_cast<SkPath *>(c_path);
    CANVAS_CAST->clipPath(*path, true);
  }

  void skiac_canvas_save(skiac_canvas *c_canvas)
  {
    CANVAS_CAST->save();
  }

  void skiac_canvas_restore(skiac_canvas *c_canvas)
  {
    CANVAS_CAST->restore();
  }

  void skiac_canvas_write_pixels(skiac_canvas *c_canvas, int width, int height, uint8_t *pixels, size_t row_bytes, int x, int y)
  {
    auto info = SkImageInfo::Make(width, height, SkColorType::kRGBA_8888_SkColorType, SkAlphaType::kUnpremul_SkAlphaType);
    CANVAS_CAST->writePixels(info, pixels, row_bytes, x, y);
  }

  void skiac_canvas_write_pixels_dirty(skiac_canvas *c_canvas, int width, int height, uint8_t *pixels, size_t row_bytes, size_t length, float x, float y, float dirty_x, float dirty_y, float dirty_width, float dirty_height)
  {
    auto info = SkImageInfo::Make(width, height, SkColorType::kRGBA_8888_SkColorType, SkAlphaType::kUnpremul_SkAlphaType);
    auto data = SkData::MakeFromMalloc(pixels, length);
    auto image = SkImage::MakeRasterData(info, data, row_bytes);
    auto src_rect = SkRect::MakeXYWH(dirty_x, dirty_y, dirty_width, dirty_height);
    auto dst_rect = SkRect::MakeXYWH(x + dirty_x, y + dirty_y, dirty_width, dirty_height);
    const auto sampling = SkSamplingOptions();
    CANVAS_CAST->drawImageRect(image, src_rect, dst_rect, sampling, nullptr, SkCanvas::kFast_SrcRectConstraint);
  }

  // Paint

  skiac_paint *skiac_paint_create()
  {
    return reinterpret_cast<skiac_paint *>(new SkPaint());
  }

  skiac_paint *skiac_paint_clone(skiac_paint *c_paint)
  {
    auto cloned_paint = new SkPaint(*PAINT_CAST);
    return reinterpret_cast<skiac_paint *>(cloned_paint);
  }

  void skiac_paint_destroy(skiac_paint *c_paint)
  {
    // Will unref() Shader and PathEffect.

    // SkPaint is not ref counted, so explicitly delete.
    delete PAINT_CAST;
  }

  void skiac_paint_set_color(skiac_paint *c_paint, uint8_t r, uint8_t g, uint8_t b, uint8_t a)
  {
    PAINT_CAST->setARGB(a, r, g, b);
  }

  void skiac_paint_set_alpha(skiac_paint *c_paint, uint8_t a)
  {
    PAINT_CAST->setAlpha(a);
  }

  uint8_t skiac_paint_get_alpha(skiac_paint *c_paint)
  {
    return PAINT_CAST->getAlpha();
  }

  void skiac_paint_set_anti_alias(skiac_paint *c_paint, bool aa)
  {
    PAINT_CAST->setAntiAlias(aa);
  }

  void skiac_paint_set_blend_mode(skiac_paint *c_paint, int blend_mode)
  {
    PAINT_CAST->setBlendMode((SkBlendMode)blend_mode);
  }

  int skiac_paint_get_blend_mode(skiac_paint *c_paint)
  {
    return (int)PAINT_CAST->getBlendMode();
  }

  void skiac_paint_set_shader(skiac_paint *c_paint, skiac_shader *c_shader)
  {
    sk_sp<SkShader> shader(reinterpret_cast<SkShader *>(c_shader));

    // setShader accepts a smart pointer which will be destructed on delete.
    // Therefore we have to reference the object once more, to keep it valid in Rust.
    shader->ref();

    PAINT_CAST->setShader(shader);
  }

  void skiac_paint_set_path_effect(skiac_paint *c_paint, skiac_path_effect *c_path_effect)
  {
    sk_sp<SkPathEffect> pathEffect(reinterpret_cast<SkPathEffect *>(c_path_effect));

    // setPathEffect accepts a smart pointer which will be destructed on delete.
    // Therefore we have to reference the object once more, to keep it valid in Rust.
    pathEffect->ref();

    PAINT_CAST->setPathEffect(pathEffect);
  }

  void skiac_paint_set_mask_filter(skiac_paint *c_paint, skiac_mask_filter *c_mask_filter)
  {
    sk_sp<SkMaskFilter> maskFilter(reinterpret_cast<SkMaskFilter *>(c_mask_filter));
    maskFilter->ref();

    PAINT_CAST->setMaskFilter(maskFilter);
  }

  void skiac_paint_set_image_filter(skiac_paint *c_paint, skiac_image_filter *c_image_filter)
  {
    sk_sp<SkImageFilter> imageFilter(reinterpret_cast<SkImageFilter *>(c_image_filter));
    imageFilter->ref();

    PAINT_CAST->setImageFilter(imageFilter);
  }

  void skiac_paint_set_style(skiac_paint *c_paint, int style)
  {
    PAINT_CAST->setStyle((SkPaint::Style)style);
  }

  void skiac_paint_set_stroke_width(skiac_paint *c_paint, float width)
  {
    PAINT_CAST->setStrokeWidth(width);
  }

  float skiac_paint_get_stroke_width(skiac_paint *c_paint)
  {
    return PAINT_CAST->getStrokeWidth();
  }

  void skiac_paint_set_stroke_cap(skiac_paint *c_paint, int cap)
  {
    PAINT_CAST->setStrokeCap((SkPaint::Cap)cap);
  }

  int skiac_paint_get_stroke_cap(skiac_paint *c_paint)
  {
    return PAINT_CAST->getStrokeCap();
  }

  void skiac_paint_set_stroke_join(skiac_paint *c_paint, uint8_t join)
  {
    PAINT_CAST->setStrokeJoin((SkPaint::Join)join);
  }

  uint8_t skiac_paint_get_stroke_join(skiac_paint *c_paint)
  {
    return PAINT_CAST->getStrokeJoin();
  }

  void skiac_paint_set_stroke_miter(skiac_paint *c_paint, float miter)
  {
    PAINT_CAST->setStrokeMiter(miter);
  }

  float skiac_paint_get_stroke_miter(skiac_paint *c_paint)
  {
    return PAINT_CAST->getStrokeMiter();
  }

  // Path

  skiac_path *skiac_path_create()
  {
    return reinterpret_cast<skiac_path *>(new SkPath());
  }

  skiac_path *skiac_path_from_svg(char *svg_path)
  {
    auto path = new SkPath();
    SkParsePath::FromSVGString(svg_path, path);
    return reinterpret_cast<skiac_path *>(path);
  }

  skiac_path *skiac_path_clone(skiac_path *c_path)
  {
    auto new_path = new SkPath(*PATH_CAST);
    return reinterpret_cast<skiac_path *>(new_path);
  }

  void skiac_add_path(skiac_path *c_path, skiac_path *other_path, skiac_transform c_transform)
  {
    auto path = PATH_CAST;
    path->addPath(*reinterpret_cast<SkPath *>(other_path), conv_from_transform(c_transform), SkPath::AddPathMode::kExtend_AddPathMode);
  }

  bool skiac_path_op(skiac_path *c_path_one, skiac_path *c_path_two, int op)
  {
    auto path_one = reinterpret_cast<SkPath *>(c_path_one);
    return Op(*path_one, *reinterpret_cast<SkPath *>(c_path_two), (SkPathOp)op, path_one);
  }

  void skiac_path_to_svg_string(skiac_path *c_path, skiac_string *c_string)
  {
    auto string = new SkString();
    SkParsePath::ToSVGString(*PATH_CAST, string);
    c_string->length = string->size();
    c_string->ptr = string->c_str();
    c_string->sk_string = string;
  }

  bool skiac_path_simplify(skiac_path *c_path)
  {
    return Simplify(*PATH_CAST, PATH_CAST);
  }

  bool skiac_path_as_winding(skiac_path *c_path)
  {
    return AsWinding(*PATH_CAST, PATH_CAST);
  }

  bool skiac_path_stroke(skiac_path *c_path, int cap, uint8_t join, float width, float miter_limit)
  {
    auto path = PATH_CAST;
    SkPaint p;
    p.setStyle(SkPaint::kStroke_Style);
    p.setStrokeCap((SkPaint::Cap)cap);
    p.setStrokeJoin((SkPaint::Join)join);
    p.setStrokeWidth(width);
    p.setStrokeMiter(miter_limit);

    return p.getFillPath(*path, path);
  }

  void skiac_path_compute_tight_bounds(skiac_path *c_path, skiac_rect *c_rect)
  {
    auto rect = PATH_CAST->computeTightBounds();
    c_rect->left = rect.fLeft;
    c_rect->top = rect.fTop;
    c_rect->right = rect.fRight;
    c_rect->bottom = rect.fBottom;
  }

  void skiac_path_get_bounds(skiac_path *c_path, skiac_rect *c_rect)
  {
    auto rect = PATH_CAST->getBounds();
    c_rect->left = rect.fLeft;
    c_rect->top = rect.fTop;
    c_rect->right = rect.fRight;
    c_rect->bottom = rect.fBottom;
  }

  bool skiac_path_trim(skiac_path *c_path, float start_t, float stop_t, bool is_complement)
  {
    auto mode = is_complement ? SkTrimPathEffect::Mode::kInverted : SkTrimPathEffect::Mode::kNormal;
    auto pe = SkTrimPathEffect::Make(start_t, stop_t, mode);
    if (!pe)
    {
      return false;
    }
    SkStrokeRec rec(SkStrokeRec::InitStyle::kHairline_InitStyle);
    if (pe->filterPath(PATH_CAST, *PATH_CAST, &rec, nullptr))
    {
      return true;
    }
    return false;
  }

  bool skiac_path_dash(skiac_path *c_path, float on, float off, float phase)
  {
    float intervals[] = {on, off};
    auto pe = SkDashPathEffect::Make(intervals, 2, phase);
    if (!pe)
    {
      return false;
    }
    SkStrokeRec rec(SkStrokeRec::InitStyle::kHairline_InitStyle);
    if (pe->filterPath(PATH_CAST, *PATH_CAST, &rec, nullptr))
    {
      return true;
    }
    return false;
  }

  bool skiac_path_equals(skiac_path *c_path, skiac_path *other_path)
  {
    return *PATH_CAST == *reinterpret_cast<SkPath *>(other_path);
  }

  void skiac_path_destroy(skiac_path *c_path)
  {
    // SkPath is NOT ref counted
    delete PATH_CAST;
  }

  void skiac_path_set_fill_type(skiac_path *c_path, int type)
  {
    PATH_CAST->setFillType((SkPathFillType)type);
  }

  int skiac_path_get_fill_type(skiac_path *c_path)
  {
    return (int)PATH_CAST->getFillType();
  }

  void skiac_path_arc_to_tangent(skiac_path *c_path, float x1, float y1, float x2, float y2, float radius)
  {
    PATH_CAST->arcTo(x1, y1, x2, y2, radius);
  }

  void skiac_path_arc_to(skiac_path *c_path, float left, float top, float right, float bottom, float startAngle, float sweepAngle, bool forceMoveTo)
  {
    SkRect rect = SkRect::MakeLTRB(left, top, right, bottom);
    PATH_CAST->arcTo(rect, startAngle, sweepAngle, forceMoveTo);
  }

  void skiac_path_move_to(skiac_path *c_path, float x, float y)
  {
    PATH_CAST->moveTo(x, y);
  }

  void skiac_path_line_to(skiac_path *c_path, float x, float y)
  {
    PATH_CAST->lineTo(x, y);
  }

  void skiac_path_cubic_to(
      skiac_path *c_path,
      float x1, float y1, float x2, float y2, float x3, float y3)
  {
    PATH_CAST->cubicTo(x1, y1, x2, y2, x3, y3);
  }

  void skiac_path_quad_to(skiac_path *c_path, float cpx, float cpy, float x, float y)
  {
    PATH_CAST->quadTo(cpx, cpy, x, y);
  }

  void skiac_path_close(skiac_path *c_path)
  {
    PATH_CAST->close();
  }

  void skiac_path_add_rect(skiac_path *c_path, float x, float y, float width, float height)
  {
    SkRect rect = SkRect::MakeXYWH(x, y, width, height);
    PATH_CAST->addRect(rect);
  }

  void skiac_path_add_circle(skiac_path *c_path, float x, float y, float r)
  {
    PATH_CAST->addCircle(x, y, r);
  }

  void skiac_path_transform(skiac_path *c_path, skiac_transform c_transform)
  {
    SkMatrix matrix = conv_from_transform(c_transform);
    PATH_CAST->transform(matrix, SkApplyPerspectiveClip::kYes);
  }

  void skiac_path_transform_matrix(skiac_path *c_path, skiac_matrix *c_matrix)
  {
    SkMatrix matrix = *reinterpret_cast<SkMatrix *>(c_matrix);
    PATH_CAST->transform(matrix, SkApplyPerspectiveClip::kYes);
  }

  bool skiac_path_is_empty(skiac_path *c_path)
  {
    return PATH_CAST->isEmpty();
  }

  bool skiac_path_hit_test(skiac_path *c_path, float x, float y, int type)
  {
    auto prev_fill = PATH_CAST->getFillType();
    PATH_CAST->setFillType((SkPathFillType)type);
    auto result = PATH_CAST->contains(x, y);
    PATH_CAST->setFillType(prev_fill);
    return result;
  }

  bool skiac_path_stroke_hit_test(skiac_path *c_path, float x, float y, float stroke_w)
  {
    auto path = PATH_CAST;
    auto prev_fill = path->getFillType();
    path->setFillType(SkPathFillType::kWinding);
    SkPaint paint;
    paint.setStrokeWidth(stroke_w);
    paint.setStyle(SkPaint::kStroke_Style);
    SkPath traced_path;

    bool result;
    auto precision = 0.3; // Based on config in Chromium
    if (paint.getFillPath(*path, &traced_path, nullptr, precision))
    {
      result = traced_path.contains(x, y);
    }
    else
    {
      result = path->contains(x, y);
    }

    path->setFillType(prev_fill);
    return result;
  }

  // PathEffect

  skiac_path_effect *skiac_path_effect_make_dash_path(const float *intervals, int count, float phase)
  {
    auto effect = SkDashPathEffect::Make(intervals, count, phase).release();
    if (effect)
    {
      return reinterpret_cast<skiac_path_effect *>(effect);
    }
    else
    {
      return nullptr;
    }
  }

  void skiac_path_effect_destroy(skiac_path_effect *c_path_effect)
  {
    // SkPathEffect is ref counted.
    auto effect = reinterpret_cast<SkPathEffect *>(c_path_effect);
    effect->unref();
  }

  // Shader

  skiac_shader *skiac_shader_make_linear_gradient(
      const skiac_point *c_points,
      const uint32_t *colors,
      const float *positions,
      int count,
      int tile_mode,
      uint32_t flags,
      skiac_transform c_ts)
  {
    const auto points = reinterpret_cast<const SkPoint *>(c_points);
    const auto skia_tile_mode = (SkTileMode)tile_mode;
    const auto ts = conv_from_transform(c_ts);
    auto shader = SkGradientShader::MakeLinear(
                      points,
                      colors,
                      positions,
                      count,
                      skia_tile_mode,
                      flags,
                      &ts)
                      .release();

    if (shader)
    {
      return reinterpret_cast<skiac_shader *>(shader);
    }
    else
    {
      return nullptr;
    }
  }

  skiac_shader *skiac_shader_make_radial_gradient(
      skiac_point c_start_point,
      float start_radius,
      skiac_point c_end_point,
      float end_radius,
      const uint32_t *colors,
      const float *positions,
      int count,
      int tile_mode,
      uint32_t flags,
      skiac_transform c_ts)
  {
    const SkPoint startPoint = {c_start_point.x, c_start_point.y};
    const SkPoint endPoint = {c_end_point.x, c_end_point.y};
    const auto ts = conv_from_transform(c_ts);
    auto shader = SkGradientShader::MakeTwoPointConical(
                      startPoint,
                      start_radius,
                      endPoint,
                      end_radius,
                      colors,
                      positions,
                      count,
                      (SkTileMode)tile_mode,
                      flags,
                      &ts)
                      .release();

    if (shader)
    {
      return reinterpret_cast<skiac_shader *>(shader);
    }
    else
    {
      return nullptr;
    }
  }

  skiac_shader *skiac_shader_make_conic_gradient(
      SkScalar cx,
      SkScalar cy,
      SkScalar radius,
      const uint32_t *colors,
      const float *positions,
      int count,
      int tile_mode,
      uint32_t flags,
      skiac_transform c_ts)
  {
    auto ts = conv_from_transform(c_ts);
    // Skia's sweep gradient angles are relative to the x-axis, not the y-axis.
    ts.preRotate(radius - 90.0, cx, cy);
    auto shader = SkGradientShader::MakeSweep(
                      cx,
                      cy,
                      colors,
                      positions,
                      count,
                      (SkTileMode)tile_mode,
                      radius,
                      360.0,
                      flags,
                      &ts)
                      .release();

    if (shader)
    {
      return reinterpret_cast<skiac_shader *>(shader);
    }
    else
    {
      return nullptr;
    }
  }

  skiac_shader *skiac_shader_make_from_surface_image(
      skiac_surface *c_surface,
      skiac_transform c_ts,
      int filter_quality)
  {
    auto skia_tile_mode = SkTileMode::kRepeat;
    const auto ts = conv_from_transform(c_ts);
    const auto sampling_options = new SkSamplingOptions((SkFilterQuality)filter_quality);
    sk_sp<SkImage> image = SURFACE_CAST->makeImageSnapshot();
    auto shader = image->makeShader(
                           skia_tile_mode,
                           skia_tile_mode,
                           *sampling_options,
                           &ts)
                      .release();

    if (shader)
    {
      return reinterpret_cast<skiac_shader *>(shader);
    }
    return nullptr;
  }

  void skiac_shader_destroy(skiac_shader *c_shader)
  {
    // SkShader is ref counted.
    auto shader = reinterpret_cast<SkShader *>(c_shader);
    shader->unref();
  }

  skiac_matrix *skiac_matrix_create()
  {
    return reinterpret_cast<skiac_matrix *>(new SkMatrix());
  }

  skiac_matrix *skiac_matrix_clone(skiac_matrix *c_matrix)
  {
    return reinterpret_cast<skiac_matrix *>(new SkMatrix(*MATRIX_CAST));
  }

  void skiac_matrix_pre_translate(skiac_matrix *c_matrix, float dx, float dy)
  {
    MATRIX_CAST->preTranslate(dx, dy);
  }

  void skiac_matrix_pre_rotate(skiac_matrix *c_matrix, float degrees)
  {
    MATRIX_CAST->preRotate(degrees);
  }

  bool skiac_matrix_invert(skiac_matrix *c_matrix, skiac_matrix *inverse)
  {
    return MATRIX_CAST->invert(reinterpret_cast<SkMatrix *>(inverse));
  }

  skiac_transform skiac_matrix_to_transform(skiac_matrix *c_matrix)
  {
    return conv_to_transform(*MATRIX_CAST);
  }

  void skiac_matrix_destroy(skiac_matrix *c_matrix)
  {
    delete MATRIX_CAST;
  }

  // SkMaskFilter

  skiac_mask_filter *skiac_mask_filter_make_blur(float radius)
  {
    auto filter = SkMaskFilter::MakeBlur(SkBlurStyle::kNormal_SkBlurStyle, radius, false).release();
    if (filter)
    {
      return reinterpret_cast<skiac_mask_filter *>(filter);
    }
    else
    {
      return nullptr;
    }
  }

  void skiac_mask_filter_destroy(skiac_mask_filter *c_mask_filter)
  {
    auto mask_filter = MASK_FILTER_CAST;
    mask_filter->unref();
  }

  // SkImageFilter

  skiac_image_filter *skiac_image_filter_make_drop_shadow(float dx, float dy, float sigma_x, float sigma_y, uint32_t color)
  {
    auto filter = SkImageFilters::DropShadowOnly(dx, dy, sigma_x, sigma_y, color, nullptr).release();
    if (filter)
    {
      return reinterpret_cast<skiac_image_filter *>(filter);
    }
    else
    {
      return nullptr;
    }
  }

  void skiac_image_filter_destroy(skiac_image_filter *c_image_filter)
  {
    auto image_filter = IMAGE_FILTER_CAST;
    image_filter->unref();
  }

  // SkData

  void skiac_sk_data_destroy(skiac_data *c_data)
  {
    auto data = reinterpret_cast<SkData *>(c_data);
    data->unref();
  }

  // Bitmap

  skiac_bitmap *skiac_bitmap_make_from_buffer(const uint8_t *ptr, size_t size)
  {
    auto data = SkData::MakeWithoutCopy(reinterpret_cast<const void *>(ptr), size);
    auto codec = SkCodec::MakeFromData(data);
    auto info = codec->getInfo();
    auto row_bytes = info.width() * info.bytesPerPixel();
    auto bitmap = new SkBitmap();
    bitmap->allocPixels(info);
    codec->getPixels(info, bitmap->getPixels(), row_bytes);
    return reinterpret_cast<skiac_bitmap *>(bitmap);
  }

  skiac_bitmap *skiac_bitmap_make_from_svg(const uint8_t *data, size_t length)
  {
    auto svg_stream = new SkMemoryStream(data, length, false);
    auto svg_dom = SkSVGDOM::MakeFromStream(*svg_stream);
    auto svg_container_size = svg_dom->containerSize();
    auto imageinfo = SkImageInfo::Make(svg_container_size.width(), svg_container_size.height(), kRGBA_8888_SkColorType, SkAlphaType::kOpaque_SkAlphaType);
    auto bitmap = new SkBitmap();
    if (imageinfo.width() == 0 || imageinfo.height() == 0)
    {
      return nullptr;
    }
    bitmap->allocPixels(imageinfo);
    auto sk_svg_canvas = new SkCanvas(*bitmap);
    svg_dom->render(sk_svg_canvas);
    return reinterpret_cast<skiac_bitmap *>(bitmap);
  }

  skiac_bitmap *skiac_bitmap_make_from_image_data(uint8_t *ptr, size_t width, size_t height, size_t row_bytes, size_t size, int ct, int at)
  {
    auto bitmap = new SkBitmap();
    const auto info = SkImageInfo::Make((int)width, (int)(height), (SkColorType)ct, (SkAlphaType)at);
    bitmap->installPixels(info, ptr, row_bytes);
    return reinterpret_cast<skiac_bitmap *>(bitmap);
  }

  uint32_t skiac_bitmap_get_width(skiac_bitmap *c_bitmap)
  {
    auto bitmap = reinterpret_cast<SkBitmap *>(c_bitmap);
    return bitmap->width();
  }

  uint32_t skiac_bitmap_get_height(skiac_bitmap *c_bitmap)
  {
    auto bitmap = reinterpret_cast<SkBitmap *>(c_bitmap);
    return bitmap->height();
  }

  skiac_shader *skiac_bitmap_get_shader(
      skiac_bitmap *c_bitmap,
      int repeat_x,
      int repeat_y,
      float B,
      float C, // See SkSamplingOptions.h for docs.
      skiac_transform c_ts)
  {
    const auto ts = conv_from_transform(c_ts);
    auto bitmap = reinterpret_cast<SkBitmap *>(c_bitmap);
    auto shader = bitmap->makeShader((SkTileMode)repeat_x, (SkTileMode)repeat_y, SkSamplingOptions({B, C}), &ts).release();
    if (shader)
    {
      return reinterpret_cast<skiac_shader *>(shader);
    }
    return nullptr;
  }

  void skiac_bitmap_destroy(skiac_bitmap *c_bitmap)
  {
    delete BITMAP_CAST;
  }

  // SkString
  void skiac_delete_sk_string(skiac_sk_string *c_sk_string)
  {
    delete reinterpret_cast<SkString *>(c_sk_string);
  }

  skiac_font_metrics *skiac_font_metrics_create(const char *font_family, float font_size)
  {
    auto text_style = new TextStyle();
    text_style->setFontFamilies({SkString(font_family)});
    text_style->setFontSize(font_size);
    text_style->setWordSpacing(0);
    text_style->setHeight(1);
    auto metrics = new SkFontMetrics();
    text_style->getFontMetrics(metrics);
    return reinterpret_cast<skiac_font_metrics *>(metrics);
  }

  void skiac_font_metrics_destroy(skiac_font_metrics *c_font_metrics)
  {
    delete FONT_METRICS_CAST;
  }

  skiac_font_collection *skiac_font_collection_create()
  {
    return new skiac_font_collection();
  }

  skiac_font_collection *skiac_font_collection_clone(skiac_font_collection *c_font_collection)
  {
    return new skiac_font_collection(c_font_collection->collection);
  }

  uint32_t skiac_font_collection_get_default_fonts_count(skiac_font_collection *c_font_collection)
  {
    return c_font_collection->font_mgr->countFamilies();
  }

  void skiac_font_collection_get_family(skiac_font_collection *c_font_collection, uint32_t i, skiac_string *c_string)
  {
    auto name = new SkString();
    c_font_collection->font_mgr->getFamilyName(i, name);
    c_string->length = name->size();
    c_string->ptr = name->c_str();
    c_string->sk_string = name;
  }

  size_t skiac_font_collection_register(skiac_font_collection *c_font_collection, const uint8_t *font, size_t length)
  {
    auto typeface_data = SkData::MakeWithCopy(font, length);
    auto typeface = c_font_collection->font_mgr->makeFromData(typeface_data);
    return c_font_collection->assets->registerTypeface(typeface);
  }

  size_t skiac_font_collection_register_from_path(skiac_font_collection *c_font_collection, const char *font_path)
  {
    auto typeface = c_font_collection->font_mgr->makeFromFile(font_path);
    return c_font_collection->assets->registerTypeface(typeface);
  }

  void skiac_font_collection_destroy(skiac_font_collection *c_font_collection)
  {
    delete c_font_collection;
  }
}
