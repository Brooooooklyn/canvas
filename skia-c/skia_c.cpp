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
#define TYPEFACE_CAST reinterpret_cast<SkTypeface *>(c_typeface)

#define MAX_LAYOUT_WIDTH 100000
#define HANGING_AS_PERCENT_OF_ASCENT 80

extern "C"
{

  static SkSamplingOptions SamplingOptionsFromFQ(int fq)
  {
    switch (fq)
    {
    case 3:
      return SkSamplingOptions(SkCubicResampler{1 / 3.0f, 1 / 3.0f});
    case 2:
      return SkSamplingOptions(SkFilterMode::kLinear,
                               SkMipmapMode::kNearest);
    case 1:
      return SkSamplingOptions(SkFilterMode::kLinear, SkMipmapMode::kNone);
    case 0:
      break;
    }
    return SkSamplingOptions(SkFilterMode::kNearest, SkMipmapMode::kNone);
  }

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
    // Init() is idempotent, so can be called more than once with no adverse effect.
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

  void skiac_surface_create_svg(skiac_svg_surface *c_surface, int w, int h, int alphaType, uint32_t flag)
  {
    auto w_stream = new SkDynamicMemoryWStream();

    auto canvas = SkSVGCanvas::Make(SkRect::MakeWH(w, h), w_stream, flag);
    if (!canvas.get())
    {
      return;
    }
    auto surface = skiac_surface_create(w, h, (SkAlphaType)alphaType);
    if (!surface)
    {
      return;
    }
    c_surface->stream = reinterpret_cast<skiac_w_memory_stream *>(w_stream);
    c_surface->surface = reinterpret_cast<skiac_surface *>(surface);
    c_surface->canvas = reinterpret_cast<skiac_canvas *>(canvas.release());
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
    paint.setAlpha(SK_AlphaOPAQUE);

    const auto sampling = SkSamplingOptions(SkCubicResampler::Mitchell());
    // The original surface draws itself to the copy's canvas.
    SURFACE_CAST->draw(copy->getCanvas(), -(SkScalar)x, -(SkScalar)y, sampling, &paint);

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
      data->ptr = png_data->bytes();
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

  void skiac_surface_get_bitmap(skiac_surface *c_surface, skiac_bitmap_info *info)
  {
    auto image = SURFACE_CAST->makeImageSnapshot();
    auto bitmap = new SkBitmap();
    auto image_info = image->imageInfo();
    bitmap->allocPixels(image_info);
    image->readPixels(image_info, bitmap->getPixels(), bitmap->rowBytes(), 0, 0);
    info->bitmap = reinterpret_cast<skiac_bitmap *>(bitmap);
    info->width = (size_t)image_info.width();
    info->height = (size_t)image_info.height();
  }

  // Canvas

  void skiac_canvas_clear(skiac_canvas *c_canvas, uint32_t color)
  {
    CANVAS_CAST->clear(static_cast<SkColor>(color));
  }

  void skiac_canvas_set_transform(skiac_canvas *c_canvas, skiac_matrix *c_matrix)
  {
    CANVAS_CAST->setMatrix(*MATRIX_CAST);
  }

  void skiac_canvas_concat(skiac_canvas *c_canvas, skiac_matrix *c_matrix)
  {
    CANVAS_CAST->concat(*MATRIX_CAST);
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
    const auto sampling = SkSamplingOptions(SkCubicResampler::Mitchell());
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
    paint.setAlpha(alpha);
    paint.setBlendMode((SkBlendMode)blend_mode);
    const auto sampling = SamplingOptionsFromFQ(filter_quality);
    CANVAS_CAST->drawImage(image, left, top, sampling, &paint);
  }

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
      int filter_quality)
  {
    auto image = SURFACE_CAST->makeImageSnapshot();
    auto src = SkRect::MakeXYWH(sx, sy, sw, sh);
    auto dst = SkRect::MakeXYWH(dx, dy, dw, dh);
    const auto sampling = SamplingOptionsFromFQ(filter_quality);
    CANVAS_CAST->drawImageRect(image, src, dst, sampling, nullptr, SkCanvas::kFast_SrcRectConstraint);
  }

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
      skiac_line_metrics *c_line_metrics)
  {
    auto font_collection = c_collection->collection;
    auto font_style = SkFontStyle(weight, stretch, (SkFontStyle::Slant)slant);
    SkTArray<SkString> families;
    SkStrSplit(font_family, ",", &families);
    TextStyle text_style;
    std::vector<SkString> families_vec;
    for (auto family : families)
    {
      families_vec.emplace_back(family);
    }
    text_style.setFontFamilies(families_vec);
    text_style.setFontSize(font_size);
    text_style.setWordSpacing(0);
    text_style.setHeight(1);
    text_style.setFontStyle(font_style);
    text_style.setForegroundColor(*PAINT_CAST);
    text_style.setTextBaseline(TextBaseline::kAlphabetic);

    SkFontMetrics font_metrics;
    text_style.getFontMetrics(&font_metrics);

    ParagraphStyle paragraph_style;
    paragraph_style.turnHintingOff();
    paragraph_style.setTextStyle(text_style);
    paragraph_style.setTextAlign((TextAlign)align);
    paragraph_style.setTextDirection((TextDirection)direction);
    ParagraphBuilderImpl builder(paragraph_style, font_collection);
    builder.addText(text, text_len);
    auto paragraph = static_cast<ParagraphImpl *>(builder.Build().release());
    paragraph->layout(MAX_LAYOUT_WIDTH);

    std::vector<LineMetrics> metrics_vec;
    paragraph->getLineMetrics(metrics_vec);
    auto line_metrics = metrics_vec[0];
    auto run = paragraph->run(0);
    auto first_char_bounds = run.getBounds(0);
    auto descent = first_char_bounds.fBottom;
    auto ascent = first_char_bounds.fTop;
    auto run_size = run.size();
    auto last_char_bounds = run.getBounds(run_size - 1);
    auto last_char_pos_x = run.positionX(run_size - 1);
    for (size_t i = 1; i <= run_size - 1; ++i)
    {
      auto char_bounds = run.getBounds(i);
      auto char_bottom = char_bounds.fBottom;
      if (char_bottom > descent)
      {
        descent = char_bottom;
      }
      auto char_top = char_bounds.fTop;
      if (char_top < ascent)
      {
        ascent = char_top;
      }
    }
    auto line_width = line_metrics.fWidth;
    auto alphabetic_baseline = paragraph->getAlphabeticBaseline();
    auto css_baseline = (CssBaseline)baseline;
    SkScalar baseline_offset = 0;
    switch (css_baseline)
    {
    case CssBaseline::Top:
      baseline_offset = -alphabetic_baseline - font_metrics.fAscent;
      break;
    case CssBaseline::Hanging:
      // https://github1s.com/chromium/chromium/blob/HEAD/third_party/blink/renderer/core/html/canvas/text_metrics.cc#L21-L24
      // According to
      // http://wiki.apache.org/xmlgraphics-fop/LineLayout/AlignmentHandling
      // "FOP (Formatting Objects Processor) puts the hanging baseline at 80% of
      // the ascender height"
      baseline_offset = -alphabetic_baseline - (font_metrics.fAscent - font_metrics.fDescent) * HANGING_AS_PERCENT_OF_ASCENT / 100.0;
      break;
    case CssBaseline::Middle:
      baseline_offset = -paragraph->getHeight() / 2;
      break;
    case CssBaseline::Alphabetic:
      baseline_offset = -alphabetic_baseline;
      break;
    case CssBaseline::Ideographic:
      baseline_offset = -paragraph->getIdeographicBaseline();
      break;
    case CssBaseline::Bottom:
      baseline_offset = -alphabetic_baseline - descent;
      break;
    };

    if (c_canvas)
    {
      auto align_factor = 0;
      auto paint_x = x + line_width * align_factor;
      auto need_scale = line_width > max_width;
      if (need_scale)
      {
        CANVAS_CAST->save();
        CANVAS_CAST->scale(max_width / line_width, 1.0);
      }
      auto paint_y = y + baseline_offset;
      paragraph->paint(CANVAS_CAST, paint_x, paint_y);
      if (need_scale)
      {
        CANVAS_CAST->restore();
      }
    }
    else
    {
      auto offset = -baseline_offset - alphabetic_baseline;
      c_line_metrics->ascent = -ascent + offset;
      c_line_metrics->descent = descent - offset;
      c_line_metrics->left = line_metrics.fLeft - first_char_bounds.fLeft;
      c_line_metrics->right = last_char_pos_x + last_char_bounds.fRight;
      c_line_metrics->width = line_width;
      c_line_metrics->font_ascent = line_metrics.fAscent + offset;
      c_line_metrics->font_descent = line_metrics.fDescent - offset;
    }
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

  void skiac_canvas_reset(skiac_canvas *c_canvas)
  {
    CANVAS_CAST->restoreToCount(1);
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
    const auto sampling = SkSamplingOptions(SkCubicResampler::Mitchell());
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
    return (int)PAINT_CAST->getBlendMode_or(SkBlendMode::kSrcOver);
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

  void skiac_path_swap(skiac_path *c_path, skiac_path *other_path)
  {
    auto other = reinterpret_cast<SkPath *>(other_path);
    PATH_CAST->swap(*other);
  }

  void skiac_add_path(skiac_path *c_path, skiac_path *other_path, skiac_matrix *c_matrix)
  {
    auto path = PATH_CAST;
    path->addPath(*reinterpret_cast<SkPath *>(other_path), *MATRIX_CAST, SkPath::AddPathMode::kExtend_AddPathMode);
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

  skiac_path *skiac_path_transform(skiac_path *c_path, skiac_matrix *c_matrix)
  {
    auto new_path = new SkPath();
    PATH_CAST->transform(*MATRIX_CAST, new_path, SkApplyPerspectiveClip::kYes);
    return reinterpret_cast<skiac_path *>(new_path);
  }

  void skiac_path_transform_self(skiac_path *c_path, skiac_matrix *c_matrix)
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
                      nullptr)
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
    const SkSamplingOptions sampling_options = SamplingOptionsFromFQ(filter_quality);
    sk_sp<SkImage> image = SURFACE_CAST->makeImageSnapshot();
    auto shader = image->makeShader(
                           skia_tile_mode,
                           skia_tile_mode,
                           sampling_options,
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

  skiac_matrix *skiac_matrix_new(float a, float b, float c, float d, float e, float f)
  {
    auto m = new SkMatrix(SkMatrix::MakeAll(a, b, c, d, e, f, 0, 0, 1));
    return reinterpret_cast<skiac_matrix *>(m);
  }

  skiac_matrix *skiac_matrix_from_ts(const skiac_transform *c_ts)
  {
    auto matrix = conv_from_transform(*c_ts);
    auto m = new SkMatrix(matrix);
    return reinterpret_cast<skiac_matrix *>(m);
  }

  skiac_matrix *skiac_matrix_create_rotated(float rotation, float x, float y)
  {
    auto matrix = new SkMatrix();
    matrix->setRotate(rotation, x, y);
    return reinterpret_cast<skiac_matrix *>(matrix);
  }

  skiac_matrix *skiac_matrix_create_translated(float x, float y)
  {
    auto matrix = new SkMatrix();
    matrix->setTranslate(x, y);
    return reinterpret_cast<skiac_matrix *>(matrix);
  }

  skiac_matrix *skiac_matrix_concat(skiac_matrix *c_matrix, skiac_matrix *other)
  {
    auto m = SkMatrix::Concat(*MATRIX_CAST, *reinterpret_cast<SkMatrix *>(other));
    auto r = new SkMatrix(m);
    return reinterpret_cast<skiac_matrix *>(r);
  }

  skiac_matrix *skiac_matrix_multiply(skiac_matrix *c_matrix, skiac_matrix *other)
  {
    auto m = *MATRIX_CAST;
    auto o = *reinterpret_cast<SkMatrix *>(other);
    auto r = new SkMatrix(o * m);
    return reinterpret_cast<skiac_matrix *>(r);
  }

  void skiac_matrix_map_points(skiac_matrix *c_matrix, float x1, float y1, float x2, float y2, skiac_mapped_point *mapped_point)
  {
    SkPoint dst[2];
    auto p1 = SkPoint::Make(x1, y1);
    auto p2 = SkPoint::Make(x2, y2);
    SkPoint src[] = {p1, p2};
    MATRIX_CAST->mapPoints(src, dst, 2);
    auto dp1 = dst[0];
    auto dp2 = dst[1];
    mapped_point->x1 = dp1.fX;
    mapped_point->y1 = dp1.fY;
    mapped_point->x2 = dp2.fX;
    mapped_point->y2 = dp2.fY;
  }

  skiac_matrix *skiac_matrix_clone(skiac_matrix *c_matrix)
  {
    return reinterpret_cast<skiac_matrix *>(new SkMatrix(*MATRIX_CAST));
  }

  void skiac_matrix_pre_translate(skiac_matrix *c_matrix, float dx, float dy)
  {
    MATRIX_CAST->preTranslate(dx, dy);
  }

  void skiac_matrix_pre_concat(skiac_matrix *c_matrix, skiac_matrix *other)
  {
    MATRIX_CAST->preConcat(*reinterpret_cast<SkMatrix *>(other));
  }

  void skiac_matrix_pre_scale(skiac_matrix *c_matrix, float sx, float sy)
  {
    MATRIX_CAST->preScale(sx, sy);
  }

  void skiac_matrix_pre_concat_transform(skiac_matrix *c_matrix, skiac_transform c_ts)
  {
    auto ts = conv_from_transform(c_ts);
    MATRIX_CAST->preConcat(ts);
  }

  void skiac_matrix_pre_rotate(skiac_matrix *c_matrix, float degrees)
  {
    MATRIX_CAST->preRotate(degrees);
  }

  void skiac_matrix_pre_rotate_x_y(skiac_matrix *c_matrix, float degrees, float x, float y)
  {
    MATRIX_CAST->preRotate(degrees, x, y);
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

  skiac_image_filter *skiac_image_filter_make_drop_shadow_only(float dx, float dy, float sigma_x, float sigma_y, uint32_t color, skiac_image_filter *c_image_filter)
  {
    auto chained_filter = sk_sp(IMAGE_FILTER_CAST);
    if (c_image_filter)
    {
      chained_filter->ref();
    }
    auto filter = SkImageFilters::DropShadowOnly(dx, dy, sigma_x, sigma_y, color, chained_filter).release();
    if (filter)
    {
      return reinterpret_cast<skiac_image_filter *>(filter);
    }
    else
    {
      return nullptr;
    }
  }

  skiac_image_filter *skiac_image_filter_make_drop_shadow(float dx, float dy, float sigma_x, float sigma_y, uint32_t color, skiac_image_filter *c_image_filter)
  {
    auto chained_filter = sk_sp(IMAGE_FILTER_CAST);
    if (c_image_filter)
    {
      chained_filter->ref();
    }
    auto filter = SkImageFilters::DropShadow(dx, dy, sigma_x, sigma_y, color, chained_filter).release();
    if (filter)
    {
      return reinterpret_cast<skiac_image_filter *>(filter);
    }
    else
    {
      return nullptr;
    }
  }

  skiac_image_filter *skiac_image_filter_make_blur(float sigma_x, float sigma_y, int tile_mode, skiac_image_filter *c_image_filter)
  {
    auto chained_filter = sk_sp(IMAGE_FILTER_CAST);
    if (c_image_filter)
    {
      chained_filter->ref();
    }
    auto filter = SkImageFilters::Blur(sigma_x, sigma_y, (SkTileMode)tile_mode, chained_filter).release();
    if (filter)
    {
      return reinterpret_cast<skiac_image_filter *>(filter);
    }
    else
    {
      return nullptr;
    }
  }

  skiac_image_filter *skiac_image_filter_color_filter(float m00, float m01, float m02, float m10, float m11, float m12, float m20, float m21, float m22, float opacity, skiac_image_filter *c_image_filter)
  {
    auto chained_filter = sk_sp(IMAGE_FILTER_CAST);
    if (c_image_filter)
    {
      chained_filter->ref();
    }
    const auto color_matrix = SkColorMatrix(
        m00, m01, m02, 0.0, 0.0,
        m10, m11, m12, 0.0, 0.0,
        m20, m21, m22, 0.0, 0.0,
        0.0, 0.0, 0.0, opacity, 0.0);
    auto color_filter = SkColorFilters::Matrix(color_matrix);
    auto filter = SkImageFilters::ColorFilter(color_filter, chained_filter).release();
    if (filter)
    {
      return reinterpret_cast<skiac_image_filter *>(filter);
    }
    else
    {
      return nullptr;
    }
  }

  skiac_image_filter *skiac_image_filter_from_argb(const uint8_t table_a[256], const uint8_t table_r[256], const uint8_t table_g[256], const uint8_t table_b[256], skiac_image_filter *c_image_filter)
  {
    auto cf = SkTableColorFilter::MakeARGB(table_a, table_r, table_g, table_b);
    auto chained_filter = sk_sp(IMAGE_FILTER_CAST);
    if (c_image_filter)
    {
      chained_filter->ref();
    }
    auto filter = SkImageFilters::ColorFilter(cf, chained_filter).release();
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

  void skiac_bitmap_make_from_buffer(const uint8_t *ptr, size_t size, skiac_bitmap_info *bitmap_info)
  {
    auto data = SkData::MakeWithoutCopy(reinterpret_cast<const void *>(ptr), size);
    auto codec = SkCodec::MakeFromData(data);
    auto info = codec->getInfo();
    auto row_bytes = info.width() * info.bytesPerPixel();
    auto bitmap = new SkBitmap();
    bitmap->allocPixels(info);
    codec->getPixels(info, bitmap->getPixels(), row_bytes);
    bitmap_info->bitmap = reinterpret_cast<skiac_bitmap *>(bitmap);
    bitmap_info->width = info.width();
    bitmap_info->height = info.height();
  }

  void skiac_bitmap_make_from_svg(const uint8_t *data, size_t length, float width, float height, skiac_bitmap_info *bitmap_info)
  {
    auto svg_stream = new SkMemoryStream(data, length, false);
    auto svg_dom = SkSVGDOM::MakeFromStream(*svg_stream);
    auto svg_root = svg_dom->getRoot();
    auto svg_container_size = svg_root->intrinsicSize(SkSVGLengthContext(SkSize::Make(0, 0)));
    if (svg_container_size.isZero())
    {
      auto view_box = svg_root->getViewBox();
      if (!view_box.isValid())
      {
        return;
      }
      svg_container_size = SkSize::Make(view_box->width(), view_box->height());
      if (svg_container_size.isEmpty())
      {
        return;
      }
      svg_dom->setContainerSize(svg_container_size);
    }
    auto image_w = svg_container_size.width();
    auto image_h = svg_container_size.height();
    if (width > 0 && height > 0)
    {
      svg_root->setTransform(SkMatrix::Scale(width / image_w, height / image_h));
      image_w = width;
      image_h = height;
    }
    auto imageinfo = SkImageInfo::Make(image_w, image_h, kRGBA_8888_SkColorType, SkAlphaType::kOpaque_SkAlphaType);
    auto bitmap = new SkBitmap();
    bitmap->allocPixels(imageinfo);
    auto sk_svg_canvas = new SkCanvas(*bitmap);
    svg_dom->render(sk_svg_canvas);
    bitmap_info->bitmap = reinterpret_cast<skiac_bitmap *>(bitmap);
    bitmap_info->width = imageinfo.width();
    bitmap_info->height = imageinfo.height();
  }

  skiac_bitmap *skiac_bitmap_make_from_image_data(uint8_t *ptr, size_t width, size_t height, size_t row_bytes, size_t size, int ct, int at)
  {
    auto bitmap = new SkBitmap();
    const auto info = SkImageInfo::Make((int)width, (int)(height), (SkColorType)ct, (SkAlphaType)at);
    bitmap->installPixels(info, ptr, row_bytes);
    return reinterpret_cast<skiac_bitmap *>(bitmap);
  }

  size_t skiac_bitmap_get_width(skiac_bitmap *c_bitmap)
  {
    auto bitmap = reinterpret_cast<SkBitmap *>(c_bitmap);
    return bitmap->width();
  }

  size_t skiac_bitmap_get_height(skiac_bitmap *c_bitmap)
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

  skiac_font_collection *skiac_font_collection_create()
  {
    return new skiac_font_collection();
  }

  uint32_t skiac_font_collection_get_default_fonts_count(skiac_font_collection *c_font_collection)
  {
    return c_font_collection->assets->countFamilies();
  }

  void skiac_font_collection_get_family(skiac_font_collection *c_font_collection, uint32_t i, skiac_string *c_string, void *on_get_style_rust, skiac_on_match_font_style on_match_font_style)
  {
    auto name = new SkString();
    c_font_collection->assets->getFamilyName(i, name);
    auto font_style_set = c_font_collection->assets->matchFamily(name->c_str());
    auto style_count = font_style_set->count();
    for (auto i = 0; i < style_count; i++)
    {
      SkFontStyle style;
      font_style_set->getStyle(i, &style, nullptr);
      if (on_match_font_style)
      {
        on_match_font_style(style.width(), style.weight(), (int)style.slant(), on_get_style_rust);
      }
    }
    font_style_set->unref();
    c_string->length = name->size();
    c_string->ptr = name->c_str();
    c_string->sk_string = name;
  }

  size_t skiac_font_collection_register(skiac_font_collection *c_font_collection, const uint8_t *font, size_t length, const char *name_alias)
  {
    auto typeface_data = SkData::MakeWithoutCopy(font, length);
    auto typeface = c_font_collection->font_mgr->makeFromData(typeface_data);
    auto result = c_font_collection->assets->registerTypeface(typeface);
    if (name_alias)
    {
      auto alias = SkString(name_alias);
      c_font_collection->assets->registerTypeface(typeface, alias);
    };
    return result;
  }

  size_t skiac_font_collection_register_from_path(skiac_font_collection *c_font_collection, const char *font_path, const char *name_alias)
  {
    auto typeface = c_font_collection->font_mgr->makeFromFile(font_path);
    auto result = c_font_collection->assets->registerTypeface(typeface);
    if (name_alias)
    {
      auto alias = SkString(name_alias);
      c_font_collection->assets->registerTypeface(typeface, alias);
    }
    return result;
  }

  void skiac_font_collection_destroy(skiac_font_collection *c_font_collection)
  {
    delete c_font_collection;
  }

  // SkWStream
  void skiac_sk_w_stream_get(skiac_w_memory_stream *c_w_memory_stream, skiac_sk_data *sk_data, int width, int height)
  {
    auto stream = reinterpret_cast<SkDynamicMemoryWStream *>(c_w_memory_stream);
    stream->write("</svg>", 6);
    auto data = stream->detachAsData().release();

    sk_data->data = reinterpret_cast<skiac_data *>(data);
    sk_data->ptr = data->bytes();
    sk_data->size = data->size();
    auto string = new SkString("<?xml version=\"1.0\" encoding=\"utf-8\" ?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"");
    string->appendS32(width);
    string->append("\" height=\"");
    string->appendS32(height);
    string->append("\">\n");
    stream->write(string->c_str(), string->size());
  }

  void skiac_sk_w_stream_destroy(skiac_w_memory_stream *c_w_memory_stream)
  {
    delete reinterpret_cast<SkDynamicMemoryWStream *>(c_w_memory_stream);
  }

  // SkSVG
  void skiac_svg_text_to_path(const uint8_t *data, size_t length, skiac_font_collection *c_collection, skiac_sk_data *output_data)
  {
    auto svg_stream = new SkMemoryStream(data, length, false);
    auto w_stream = new SkDynamicMemoryWStream();
    auto svg_dom = SkSVGDOM::Builder().setFontManager(c_collection->assets).make(*svg_stream);
    auto svg_root = svg_dom->getRoot();
    auto svg_container_size = svg_root->intrinsicSize(SkSVGLengthContext(SkSize::Make(0, 0)));
    auto canvas = SkSVGCanvas::Make(SkRect::MakeSize(svg_container_size), w_stream, SkSVGCanvas::kConvertTextToPaths_Flag);
    svg_dom->render(canvas.get());
    canvas.reset();
    auto d = w_stream->detachAsData().release();
    output_data->data = reinterpret_cast<skiac_data *>(d);
    output_data->size = d->size();
    output_data->ptr = d->bytes();
  }
}
