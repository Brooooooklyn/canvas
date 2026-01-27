#include <assert.h>
#include <math.h>
#include <algorithm>
#include <optional>
#include <vector>

#ifdef _WIN32
#include <string.h>
#define strncasecmp _strnicmp
#else
#include <strings.h>
#endif

#include "skia_c.hpp"
#define SURFACE_CAST reinterpret_cast<SkSurface*>(c_surface)
#define CANVAS_CAST reinterpret_cast<SkCanvas*>(c_canvas)
#define PAINT_CAST reinterpret_cast<SkPaint*>(c_paint)
#define BITMAP_CAST reinterpret_cast<SkBitmap*>(c_bitmap)
#define MATRIX_CAST reinterpret_cast<SkMatrix*>(c_matrix)

// skiac_path struct with lazy caching for SkPath
struct skiac_path {
  SkPathBuilder builder;
  mutable std::optional<SkPath> cached_path;

  skiac_path() = default;
  explicit skiac_path(const SkPath& path) : builder(path), cached_path(path) {}
  explicit skiac_path(SkPathFillType ft) : builder(ft) {}

  void invalidate() { cached_path.reset(); }

  const SkPath& path() const {
    if (!cached_path) {
      cached_path = builder.snapshot();
    }
    return *cached_path;
  }

  void replace_from_path(const SkPath& p) {
    builder = SkPathBuilder(p);
    cached_path.reset();
  }
};
#define MASK_FILTER_CAST reinterpret_cast<SkMaskFilter*>(c_mask_filter)
#define IMAGE_FILTER_CAST reinterpret_cast<SkImageFilter*>(c_image_filter)
#define TYPEFACE_CAST reinterpret_cast<SkTypeface*>(c_typeface)
#define COLOR_SPACE_CAST                                    \
  cs == 0 ? SkColorSpace::MakeSRGB()                        \
          : SkColorSpace::MakeRGB(SkNamedTransferFn::kSRGB, \
                                  SkNamedGamut::kDisplayP3)

#define MAX_LAYOUT_WIDTH 100000
#define HANGING_AS_PERCENT_OF_ASCENT 80

extern "C" {
void SkStrSplit(const char* str,
                const char* delimiters,
                skia_private::TArray<SkString>* out) {
  // Skip any delimiters.
  str += strspn(str, delimiters);
  if (!*str) {
    return;
  }

  while (true) {
    // Find a token.
    const size_t len = strcspn(str, delimiters);
    if (len > 0) {
      out->push_back().set(str, len);
      str += len;
    }

    if (!*str) {
      return;
    }
    // Skip any delimiters.
    str += strspn(str, delimiters);
  }
}

// https://source.chromium.org/chromium/chromium/src/+/refs/tags/131.0.6778.9:cc/paint/paint_flags.cc;l=171
static SkSamplingOptions SamplingOptionsFromFQ(int fq) {
  switch (fq) {
    case 3:
      return SkSamplingOptions(SkCubicResampler::Mitchell());
    case 2:
      return SkSamplingOptions(SkFilterMode::kLinear, SkMipmapMode::kNearest);
    case 1:
      return SkSamplingOptions(SkFilterMode::kLinear, SkMipmapMode::kNone);
    case 0:
      break;
  }
  return SkSamplingOptions(SkFilterMode::kNearest, SkMipmapMode::kNone);
}

static SkMatrix conv_from_transform(const skiac_transform& c_ts) {
  return SkMatrix::MakeAll(c_ts.a, c_ts.c, c_ts.e, c_ts.b, c_ts.d, c_ts.f, 0, 0,
                           1);
}

static skiac_transform conv_to_transform(const SkMatrix& matrix) {
  return skiac_transform{
      matrix.getScaleX(),
      matrix.getSkewY(),  // Yes, inverted.
      matrix.getSkewX(),  // Skia uses such order for some reasons.
      matrix.getScaleY(), matrix.getTranslateX(), matrix.getTranslateY(),
  };
}

void skiac_clear_all_cache() {
  SkGraphics::PurgeAllCaches();
}

// Surface

static SkSurface* skiac_surface_create(int width,
                                       int height,
                                       SkAlphaType alphaType,
                                       uint8_t cs) {
  // Init() is idempotent, so can be called more than once with no adverse
  // effect.
  SkGraphics::Init();
  auto color_space = COLOR_SPACE_CAST;
  auto info = SkImageInfo::Make(width, height, kRGBA_8888_SkColorType,
                                alphaType, color_space);
  auto surface = SkSurfaces::Raster(info);
  if (surface) {
    // The surface ref count will equal one after the pointer is returned.
    return surface.release();
  } else {
    return nullptr;
  }
}

void skiac_surface_create_svg(skiac_svg_surface* c_surface,
                              int w,
                              int h,
                              int alphaType,
                              uint32_t flag,
                              uint8_t cs) {
  auto w_stream = new SkDynamicMemoryWStream();

  auto canvas = SkSVGCanvas::Make(SkRect::MakeWH(w, h), w_stream, flag);
  if (!canvas.get()) {
    return;
  }
  auto surface = skiac_surface_create(w, h, (SkAlphaType)alphaType, cs);
  if (!surface) {
    return;
  }
  c_surface->stream = reinterpret_cast<skiac_w_memory_stream*>(w_stream);
  c_surface->surface = reinterpret_cast<skiac_surface*>(surface);
  c_surface->canvas = reinterpret_cast<skiac_canvas*>(canvas.release());
}

skiac_surface* skiac_surface_create_rgba_premultiplied(int width,
                                                       int height,
                                                       uint8_t cs) {
  return reinterpret_cast<skiac_surface*>(
      skiac_surface_create(width, height, kPremul_SkAlphaType, cs));
}

skiac_surface* skiac_surface_create_rgba(int width, int height, uint8_t cs) {
  return reinterpret_cast<skiac_surface*>(
      skiac_surface_create(width, height, kUnpremul_SkAlphaType, cs));
}

bool skiac_surface_save(skiac_surface* c_surface, const char* path) {
  auto image = SURFACE_CAST->makeImageSnapshot();
  auto data =
      SkPngEncoder::Encode(nullptr, image.release(), SkPngEncoder::Options());
  if (data) {
    SkFILEWStream stream(path);
    if (stream.write(data->data(), data->size())) {
      stream.flush();
      return true;
    }
  }

  return false;
}

void skiac_surface_destroy(skiac_surface* c_surface) {
  // SkSurface is ref counted.
  SURFACE_CAST->unref();
}

skiac_surface* skiac_surface_copy_rgba(skiac_surface* c_surface,
                                       uint32_t x,
                                       uint32_t y,
                                       uint32_t width,
                                       uint32_t height,
                                       uint8_t cs) {
  // x, y, width, height are source rectangle coordinates.
  auto copy =
      skiac_surface_create((int)width, (int)height, kUnpremul_SkAlphaType, cs);
  if (!copy) {
    return nullptr;
  }

  SkPaint paint;
  paint.setAlpha(SK_AlphaOPAQUE);

  const auto sampling = SkSamplingOptions(SkCubicResampler::Mitchell());
  // The original surface draws itself to the copy's canvas.
  SURFACE_CAST->draw(copy->getCanvas(), -(SkScalar)x, -(SkScalar)y, sampling,
                     &paint);

  return reinterpret_cast<skiac_surface*>(copy);
}

int skiac_surface_get_width(skiac_surface* c_surface) {
  return SURFACE_CAST->width();
}

int skiac_surface_get_height(skiac_surface* c_surface) {
  return SURFACE_CAST->height();
}

skiac_canvas* skiac_surface_get_canvas(skiac_surface* c_surface) {
  return reinterpret_cast<skiac_canvas*>(SURFACE_CAST->getCanvas());
}

void skiac_surface_read_pixels(skiac_surface* c_surface,
                               skiac_surface_data* data) {
  data->ptr = nullptr;
  data->size = 0;

  SkPixmap pixmap;
  if (SURFACE_CAST->peekPixels(&pixmap)) {
    data->ptr = static_cast<uint8_t*>(pixmap.writable_addr());
    data->size = pixmap.computeByteSize();
  }
}

bool skiac_surface_read_pixels_rect(skiac_surface* c_surface,
                                    uint8_t* data,
                                    int x,
                                    int y,
                                    int w,
                                    int h,
                                    uint8_t cs) {
  auto color_space = COLOR_SPACE_CAST;
  auto image_info =
      SkImageInfo::Make(w, h, SkColorType::kRGBA_8888_SkColorType,
                        SkAlphaType::kUnpremul_SkAlphaType, color_space);
  auto result = SURFACE_CAST->readPixels(image_info, data, w * 4, x, y);
  return result;
}

void skiac_surface_png_data(skiac_surface* c_surface, skiac_sk_data* data) {
  auto image = SURFACE_CAST->makeImageSnapshot().release();
  auto png_data = SkPngEncoder::Encode(nullptr, image, SkPngEncoder::Options());
  image->unref();
  if (png_data) {
    data->ptr = png_data->bytes();
    data->size = png_data->size();
    data->data = reinterpret_cast<skiac_data*>(png_data.release());
  }
}

void skiac_surface_encode_data(skiac_surface* c_surface,
                               skiac_sk_data* data,
                               int format,
                               int quality) {
  auto image = SURFACE_CAST->makeImageSnapshot().release();
  sk_sp<SkData> encoded_data;
  if (format == int(SkEncodedImageFormat::kJPEG)) {
    SkJpegEncoder::Options options;
    options.fQuality = quality;
    encoded_data = SkJpegEncoder::Encode(nullptr, image, options);
  } else if (format == int(SkEncodedImageFormat::kPNG)) {
    encoded_data =
        SkPngEncoder::Encode(nullptr, image, SkPngEncoder::Options());
  } else if (format == int(SkEncodedImageFormat::kWEBP)) {
    SkWebpEncoder::Options options;
    options.fCompression = quality == 100
                               ? SkWebpEncoder::Compression::kLossless
                               : SkWebpEncoder::Compression::kLossy;
    options.fQuality = quality == 100 ? 75 : quality;
    encoded_data = SkWebpEncoder::Encode(nullptr, image, options);
  }
  image->unref();
  if (encoded_data) {
    data->ptr = const_cast<uint8_t*>(encoded_data->bytes());
    data->size = encoded_data->size();
    data->data = reinterpret_cast<skiac_data*>(encoded_data.release());
  }
}

bool skiac_surface_encode_stream(skiac_surface* c_surface,
                                 int format,
                                 int quality,
                                 write_callback_t write_callback,
                                 void* context) {
  auto sk_pixmap = new SkPixmap();
  if (!SURFACE_CAST->peekPixels(sk_pixmap)) {
    return false;
  }
  SkJavaScriptWStream stream(write_callback, context);
  std::unique_ptr<SkEncoder> encoder;
  if (format == int(SkEncodedImageFormat::kJPEG)) {
    SkJpegEncoder::Options options;
    options.fQuality = quality;
    encoder = SkJpegEncoder::Make(&stream, *sk_pixmap, options);
  } else if (format == int(SkEncodedImageFormat::kPNG)) {
    encoder = SkPngEncoder::Make(&stream, *sk_pixmap, SkPngEncoder::Options());
  } else if (format == int(SkEncodedImageFormat::kWEBP)) {
    SkWebpEncoder::Options options;
    options.fCompression = quality == 100
                               ? SkWebpEncoder::Compression::kLossless
                               : SkWebpEncoder::Compression::kLossy;
    options.fQuality = quality == 100 ? 75 : quality;
    return SkWebpEncoder::Encode(&stream, *sk_pixmap, options);
  }
  if (encoder) {
    return encoder->encodeRows(sk_pixmap->height());
  }
  return false;
}

int skiac_surface_get_alpha_type(skiac_surface* c_surface) {
  return SURFACE_CAST->imageInfo().alphaType();
}

void skiac_surface_get_bitmap(skiac_surface* c_surface,
                              skiac_bitmap_info* info) {
  info->is_canvas = true;
  info->bitmap = reinterpret_cast<skiac_bitmap*>(c_surface);
  info->width = (size_t)SURFACE_CAST->width();
  info->height = (size_t)SURFACE_CAST->height();
}

// Canvas

void skiac_canvas_clear(skiac_canvas* c_canvas, uint32_t color) {
  CANVAS_CAST->clear(static_cast<SkColor>(color));
}

void skiac_canvas_set_transform(skiac_canvas* c_canvas,
                                skiac_matrix* c_matrix) {
  CANVAS_CAST->setMatrix(*MATRIX_CAST);
}

void skiac_canvas_concat(skiac_canvas* c_canvas, skiac_matrix* c_matrix) {
  CANVAS_CAST->concat(*MATRIX_CAST);
}

void skiac_canvas_scale(skiac_canvas* c_canvas, float sx, float sy) {
  CANVAS_CAST->scale(sx, sy);
}

void skiac_canvas_translate(skiac_canvas* c_canvas, float dx, float dy) {
  CANVAS_CAST->translate(dx, dy);
}

void skiac_canvas_rotate(skiac_canvas* c_canvas, float degrees) {
  CANVAS_CAST->rotate(degrees);
}

skiac_matrix* skiac_canvas_get_total_transform_matrix(skiac_canvas* c_canvas) {
  auto martix = CANVAS_CAST->getTotalMatrix();
  return reinterpret_cast<skiac_matrix*>(new SkMatrix(martix));
}

skiac_transform skiac_canvas_get_total_transform(skiac_canvas* c_canvas) {
  return conv_to_transform(CANVAS_CAST->getTotalMatrix());
}

void skiac_canvas_draw_color(skiac_canvas* c_canvas,
                             float r,
                             float g,
                             float b,
                             float a) {
  CANVAS_CAST->drawColor(SkColor4f{r, g, b, a});
}

void skiac_canvas_draw_image(skiac_canvas* c_canvas,
                             skiac_bitmap* c_bitmap,
                             bool is_canvas,
                             float sx,
                             float sy,
                             float s_width,
                             float s_height,
                             float dx,
                             float dy,
                             float d_width,
                             float d_height,
                             bool enable_smoothing,
                             int filter_quality,
                             skiac_paint* c_paint) {
  auto fq = enable_smoothing ? filter_quality : 0;
  const auto sampling = SamplingOptionsFromFQ(fq);
  auto paint = reinterpret_cast<const SkPaint*>(c_paint);
  if (is_canvas) {
    auto src_surface = reinterpret_cast<SkSurface*>(c_bitmap);
    CANVAS_CAST->save();
    // Translate to the destination position
    CANVAS_CAST->translate(dx, dy);
    CANVAS_CAST->clipRect(SkRect::MakeWH(d_width, d_height));
    // Scale using the ratio of destination size to source surface size
    CANVAS_CAST->scale(d_width / s_width, d_height / s_height);
    // Draw the surface directly
    src_surface->draw(CANVAS_CAST, -sx, -sy, sampling, paint);
    CANVAS_CAST->restore();
  } else {
    const auto src_rect = SkRect::MakeXYWH(sx, sy, s_width, s_height);
    const auto dst_rect = SkRect::MakeXYWH(dx, dy, d_width, d_height);
    CANVAS_CAST->drawImageRect(SkImages::RasterFromBitmap(*BITMAP_CAST),
                               src_rect, dst_rect, sampling, paint,
                               SkCanvas::kFast_SrcRectConstraint);
  }
}

void skiac_canvas_draw_path(skiac_canvas* c_canvas,
                            skiac_path* c_path,
                            skiac_paint* c_paint) {
  CANVAS_CAST->drawPath(c_path->path(), *PAINT_CAST);
}

void skiac_canvas_draw_rect(skiac_canvas* c_canvas,
                            float x,
                            float y,
                            float w,
                            float h,
                            skiac_paint* c_paint) {
  CANVAS_CAST->drawRect(SkRect::MakeXYWH(x, y, w, h), *PAINT_CAST);
}

void skiac_canvas_draw_surface(skiac_canvas* c_canvas,
                               skiac_surface* c_surface,
                               float left,
                               float top,
                               uint8_t alpha,
                               int blend_mode,
                               int filter_quality) {
  auto image = SURFACE_CAST->makeImageSnapshot();
  SkPaint paint;
  paint.setAlpha(alpha);
  paint.setBlendMode((SkBlendMode)blend_mode);
  const auto sampling = SamplingOptionsFromFQ(filter_quality);
  CANVAS_CAST->drawImage(image, left, top, sampling, &paint);
}

void skiac_canvas_draw_surface_rect(skiac_canvas* c_canvas,
                                    skiac_surface* c_surface,
                                    float sx,
                                    float sy,
                                    float sw,
                                    float sh,
                                    float dx,
                                    float dy,
                                    float dw,
                                    float dh,
                                    int filter_quality) {
  auto image = SURFACE_CAST->makeImageSnapshot();
  auto src = SkRect::MakeXYWH(sx, sy, sw, sh);
  auto dst = SkRect::MakeXYWH(dx, dy, dw, dh);
  const auto sampling = SamplingOptionsFromFQ(filter_quality);
  CANVAS_CAST->drawImageRect(image, src, dst, sampling, nullptr,
                             SkCanvas::kFast_SrcRectConstraint);
}

void skiac_canvas_get_line_metrics_or_draw_text(
    const char* text,
    size_t text_len,
    float max_width,
    float x,
    float y,
    float canvas_width,
    skiac_font_collection* c_collection,
    float font_size,
    int weight,
    int stretch,
    float stretch_width,
    int slant,
    const char* font_family,
    int baseline,
    int align,
    int direction,
    float letter_spacing,
    float world_spacing,
    skiac_paint* c_paint,
    skiac_canvas* c_canvas,
    skiac_line_metrics* c_line_metrics,
    const skiac_font_variation* variations,
    int variations_count,
    int kerning,
    int variant_caps,
    const char* lang,
    int text_rendering) {
  auto font_collection = c_collection->collection;
  auto font_style = SkFontStyle(weight, stretch, (SkFontStyle::Slant)slant);
  auto text_direction = (TextDirection)direction;
  skia_private::TArray<SkString> families;
  SkStrSplit(font_family, ",", &families);
  TextStyle text_style;
  std::vector<SkString> families_vec;
  for (auto family : families) {
    families_vec.emplace_back(family);
  }
  text_style.setFontFamilies(families_vec);
  text_style.setFontSize(font_size);
  text_style.setWordSpacing(world_spacing);
  text_style.setLetterSpacing(letter_spacing);
  text_style.setHeight(1);
  text_style.setFontStyle(font_style);

  std::vector<SkFontArguments::VariationPosition::Coordinate> coords;

  // Apply variable font variations if provided
  if (variations && variations_count > 0) {
    coords.reserve(variations_count + 1);
    for (int i = 0; i < variations_count; i++) {
      coords.push_back({variations[i].tag, variations[i].value});
    }
  }

  // Apply font stretch as 'wdth' variation for variable fonts
  // 'wdth' tag = 0x77647468
  if (stretch_width != 100.0f) {
    coords.push_back({SkSetFourByteTag('w', 'd', 't', 'h'), stretch_width});
  }

  if (!coords.empty()) {
    SkFontArguments font_args;
    font_args.setVariationDesignPosition(
        {coords.data(), static_cast<int>(coords.size())});
    text_style.setFontArguments(std::make_optional(font_args));
  }

  // Apply font kerning feature
  // kerning: 0=auto (don't set feature), 1=none (disable), 2=normal (enable)
  if (kerning == 1) {
    text_style.addFontFeature(SkString("kern"), 0);
  } else if (kerning == 2) {
    text_style.addFontFeature(SkString("kern"), 1);
  }

  // TODO: Support fontFeatureSettings
  // Apply font variant caps features
  // variant_caps: 0=normal, 1=small-caps, 2=all-small-caps, 3=petite-caps,
  // 4=all-petite-caps, 5=unicase, 6=titling-caps
  if (variant_caps == 1) {
    // small-caps
    text_style.addFontFeature(SkString("smcp"), 1);
  } else if (variant_caps == 2) {
    // all-small-caps
    text_style.addFontFeature(SkString("smcp"), 1);
    text_style.addFontFeature(SkString("c2sc"), 1);
  } else if (variant_caps == 3) {
    // petite-caps
    text_style.addFontFeature(SkString("pcap"), 1);
  } else if (variant_caps == 4) {
    // all-petite-caps
    text_style.addFontFeature(SkString("pcap"), 1);
    text_style.addFontFeature(SkString("c2pc"), 1);
  } else if (variant_caps == 5) {
    // unicase
    text_style.addFontFeature(SkString("unic"), 1);
  } else if (variant_caps == 6) {
    // titling-caps
    text_style.addFontFeature(SkString("titl"), 1);
  }

  // Apply language/locale for language-specific glyph variants
  // lang: BCP-47 language tag (e.g., "en", "tr", "zh-Hans") or
  // nullptr/"inherit"
  if (lang != nullptr && strcmp(lang, "") != 0 &&
      strcmp(lang, "inherit") != 0) {
    text_style.setLocale(SkString(lang));

    // Turkish/Azerbaijani locale: disable standard and contextual ligatures
    // These languages have a dotless i (ı) as a separate letter from dotted i.
    // The "fi" ligature would incorrectly merge "f" with "i", obscuring the dot
    // which is semantically significant. Browsers disable common ligatures
    // (liga + clig) for these locales per MDN CanvasRenderingContext2D.lang
    // spec. Use case-insensitive comparison per BCP-47 (RFC 5646).
    if ((strncasecmp(lang, "tr", 2) == 0 || strncasecmp(lang, "az", 2) == 0) &&
        (lang[2] == '\0' || lang[2] == '-' || lang[2] == '_')) {
      text_style.addFontFeature(SkString("liga"), 0);
      text_style.addFontFeature(SkString("clig"), 0);
    }
  }

  // Apply textRendering: only optimizeSpeed changes behavior.
  // Per Chromium's implementation in font_features.cc, textRendering does NOT
  // affect kerning - that's controlled solely by fontKerning.
  // textRendering only affects ligatures (liga, clig) and contextual alternates
  // (calt) when set to optimizeSpeed.
  // text_rendering: 0=auto, 1=optimizeSpeed, 2=optimizeLegibility,
  // 3=geometricPrecision
  if (text_rendering == 1) {
    // optimizeSpeed: disable ligatures and contextual alternates for speed
    // Note: kern is NOT touched here - it's fontKerning's responsibility
    text_style.addFontFeature(SkString("liga"), 0);
    text_style.addFontFeature(SkString("clig"), 0);
    text_style.addFontFeature(SkString("calt"), 0);
  }
  // auto, optimizeLegibility, geometricPrecision: use HarfBuzz/Skia defaults
  // (liga, clig, calt are ON by default)

  text_style.setForegroundColor(*PAINT_CAST);
  text_style.setTextBaseline(TextBaseline::kAlphabetic);
  StrutStyle struct_style;
  struct_style.setLeading(0);

  ParagraphStyle paragraph_style;
  paragraph_style.setTextStyle(text_style);
  paragraph_style.setTextDirection(text_direction);
  paragraph_style.setStrutStyle(struct_style);
  ParagraphBuilderImpl builder(paragraph_style, font_collection,
                               SkUnicodes::ICU::Make());
  builder.addText(text, text_len);
  auto paragraph = static_cast<ParagraphImpl*>(builder.Build().release());
  paragraph->layout(MAX_LAYOUT_WIDTH);
  std::vector<LineMetrics> metrics_vec;
  paragraph->getLineMetrics(metrics_vec);
  auto line_metrics = metrics_vec[0];
  auto run = paragraph->run(0);
  auto font = run.font();
  SkFontMetrics font_metrics;
  font.getMetrics(&font_metrics);
  std::vector<SkRect> bounds(text_len);
  auto glyphs = run.glyphs();
  auto glyphs_size = glyphs.size();
  font.getBounds(glyphs, bounds, PAINT_CAST);

  // line_metrics.fWidth doesn't contain the suffix spaces
  // run.calculateWidth will return 0 if font is rendering as fallback
  //
  // So we use `getMaxIntrinsicWidth()` to get the `line_width`.
  // - For single-run text without internal spaces: uses run.advance().fX from
  // HarfBuzz shaping
  // - For text with internal spaces or multiple runs: uses TextWrapper's
  // cluster-based calculation Both are direction-independent and include
  // trailing spaces.
  //
  // Note: Using `getRectsForRange()` may cause `measureText.width` to return
  // different values for LTR and RTL layouts.
  auto line_width = paragraph->getMaxIntrinsicWidth();
  auto first_char_bounds = bounds[0];
  auto descent = first_char_bounds.fBottom;
  auto ascent = first_char_bounds.fTop;
  auto last_char_bounds = bounds[glyphs_size - 1];
  auto last_char_pos_x = run.positionX(glyphs_size - 1);

  for (size_t i = 1; i <= glyphs_size - 1; ++i) {
    auto char_bounds = bounds[i];
    auto char_bottom = char_bounds.fBottom;
    if (char_bottom > descent) {
      descent = char_bottom;
    }
    auto char_top = char_bounds.fTop;
    if (char_top < ascent) {
      ascent = char_top;
    }
  }
  auto alphabetic_baseline = paragraph->getAlphabeticBaseline();
  auto css_baseline = (CssBaseline)baseline;
  SkScalar baseline_offset = 0;
  switch (css_baseline) {
    case CssBaseline::Top:
      baseline_offset = -alphabetic_baseline - font_metrics.fAscent -
                        font_metrics.fUnderlinePosition -
                        font_metrics.fUnderlineThickness;
      break;
    case CssBaseline::Hanging:
      // https://github.com/chromium/chromium/blob/104.0.5092.1/third_party/blink/renderer/core/html/canvas/text_metrics.cc#L21-L25
      // According to
      // http://wiki.apache.org/xmlgraphics-fop/LineLayout/AlignmentHandling
      // "FOP (Formatting Objects Processor) puts the hanging baseline at 80% of
      // the ascender height"
      baseline_offset =
          -alphabetic_baseline -
          font_metrics.fAscent * HANGING_AS_PERCENT_OF_ASCENT / 100.0;
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
      baseline_offset = -alphabetic_baseline + font_metrics.fStrikeoutPosition +
                        font_metrics.fStrikeoutThickness;
      break;
  };

  auto line_center = line_width / 2.0f;
  float paint_x;
  float offset_x = 0.0f;

  // RTL: Skia lays out text from MAX_LAYOUT_WIDTH right edge, compensate here.
  // Separated from paint_x to avoid being affected by maxWidth scaling.
  float rtl_offset = (text_direction == TextDirection::kRtl)
                         ? (MAX_LAYOUT_WIDTH - line_width)
                         : 0.0f;

  // LTR: Skia adds letter_spacing/2 before first char, compensate here.
  // Separated from paint_x to avoid being affected by maxWidth scaling.
  //
  // However, Cursive Scripts do not allow gaps between their letters for either
  // justification or letter-spacing.
  // Cursive scripts are included:
  // Arabic, Hanifi Rohingya, Mandaic, Mongolian, N’Ko, Phags Pa, Syriac
  //
  // CSS Spec: https://www.w3.org/TR/css-text-3/#cursive-tracking
  // Blink CL: https://chromium-review.googlesource.com/c/chromium/src/+/6399436
  // Skia CL: https://skia-review.googlesource.com/c/skia/+/1099477
  float letter_spacing_offset =
      (text_direction == TextDirection::kLtr && !run.isCursiveScript())
          ? -letter_spacing / 2
          : 0.0f;

  // Determine alignment type
  auto text_align = (TextAlign)align;
  bool is_right_aligned =
      text_align == TextAlign::kRight ||
      (text_align == TextAlign::kStart &&
       text_direction == TextDirection::kRtl) ||
      (text_align == TextAlign::kEnd && text_direction == TextDirection::kLtr);

  // Calculate paint_x and offset_x based on alignment
  if (text_align == TextAlign::kCenter) {
    paint_x = x - line_center;
    offset_x = line_center;
  } else if (is_right_aligned) {
    paint_x = x - line_width;
    offset_x = line_width;
  } else if (text_align == TextAlign::kJustify) {
    // Unreachable
    paint_x = x;
  } else {
    paint_x = x;
  }

  if (c_canvas) {
    auto need_scale = line_width > max_width;
    float ratio = need_scale ? max_width / line_width : 1.0f;
    if (need_scale) {
      CANVAS_CAST->save();
      CANVAS_CAST->scale(ratio, 1.0f);
    }
    // final_x: scale user coords (paint_x, offset_x), then apply Skia offsets
    float final_x = need_scale ? (paint_x + (1 - ratio) * offset_x) / ratio -
                                     rtl_offset + letter_spacing_offset
                               : paint_x - rtl_offset + letter_spacing_offset;
    paragraph->paint(CANVAS_CAST, final_x, y + baseline_offset);
    if (need_scale) {
      CANVAS_CAST->restore();
    }
  } else {
    auto offset = -baseline_offset - alphabetic_baseline;
    float metrics_paint_x = paint_x + letter_spacing_offset;
    c_line_metrics->ascent = -ascent + offset;
    c_line_metrics->descent = descent - offset;
    c_line_metrics->left =
        -metrics_paint_x + line_metrics.fLeft - first_char_bounds.fLeft;
    c_line_metrics->right =
        metrics_paint_x + last_char_pos_x + last_char_bounds.fRight;
    c_line_metrics->width = line_width;
    c_line_metrics->font_ascent = -font_metrics.fAscent + offset;
    c_line_metrics->font_descent = font_metrics.fDescent - offset;
    c_line_metrics->alphabetic_baseline = -font_metrics.fAscent + offset;
  }
  delete paragraph;
}

void skiac_canvas_reset_transform(skiac_canvas* c_canvas) {
  CANVAS_CAST->resetMatrix();
}

void skiac_canvas_clip_rect(skiac_canvas* c_canvas,
                            float x,
                            float y,
                            float w,
                            float h) {
  auto rect = SkRect::MakeXYWH(x, y, w, h);
  CANVAS_CAST->clipRect(rect, true);
}

void skiac_canvas_clip_path(skiac_canvas* c_canvas, skiac_path* c_path) {
  CANVAS_CAST->clipPath(c_path->path(), true);
}

void skiac_canvas_save(skiac_canvas* c_canvas) {
  CANVAS_CAST->save();
}

void skiac_canvas_restore(skiac_canvas* c_canvas) {
  CANVAS_CAST->restore();
}

void skiac_canvas_reset(skiac_canvas* c_canvas) {
  CANVAS_CAST->restoreToCount(1);
}

void skiac_canvas_write_pixels(skiac_canvas* c_canvas,
                               int width,
                               int height,
                               uint8_t* pixels,
                               size_t row_bytes,
                               int x,
                               int y) {
  auto info =
      SkImageInfo::Make(width, height, SkColorType::kRGBA_8888_SkColorType,
                        SkAlphaType::kUnpremul_SkAlphaType);
  CANVAS_CAST->writePixels(info, pixels, row_bytes, x, y);
}

void skiac_canvas_write_pixels_dirty(skiac_canvas* c_canvas,
                                     int width,
                                     int height,
                                     uint8_t* pixels,
                                     size_t row_bytes,
                                     size_t length,
                                     float x,
                                     float y,
                                     float dirty_x,
                                     float dirty_y,
                                     float dirty_width,
                                     float dirty_height,
                                     uint8_t cs) {
  auto color_space = COLOR_SPACE_CAST;
  auto info =
      SkImageInfo::Make(width, height, SkColorType::kRGBA_8888_SkColorType,
                        SkAlphaType::kUnpremul_SkAlphaType, color_space);
  auto pixmap = SkPixmap(info, pixels, row_bytes);
  auto image = SkImages::RasterFromPixmap(pixmap, nullptr, nullptr);
  auto src_rect = SkRect::MakeXYWH(dirty_x, dirty_y, dirty_width, dirty_height);
  auto dst_rect =
      SkRect::MakeXYWH(x + dirty_x, y + dirty_y, dirty_width, dirty_height);
  const auto sampling = SkSamplingOptions(SkCubicResampler::Mitchell());
  CANVAS_CAST->drawImageRect(image, src_rect, dst_rect, sampling, nullptr,
                             SkCanvas::kFast_SrcRectConstraint);
}

void skiac_canvas_draw_picture(skiac_canvas* c_canvas,
                               skiac_picture* c_picture,
                               skiac_matrix* c_matrix,
                               skiac_paint* c_paint) {
  auto picture = reinterpret_cast<SkPicture*>(c_picture);
  CANVAS_CAST->drawPicture(picture, MATRIX_CAST, PAINT_CAST);
}

// Optimized version that combines save/clip/transform/draw/restore into single
// call Uses pre-computed matrix like skia-canvas for better performance
void skiac_canvas_draw_picture_rect(skiac_canvas* c_canvas,
                                    skiac_picture* c_picture,
                                    float sx,
                                    float sy,
                                    float sw,
                                    float sh,
                                    float dx,
                                    float dy,
                                    float dw,
                                    float dh,
                                    skiac_paint* c_paint) {
  if (c_canvas == nullptr || c_picture == nullptr) {
    return;
  }

  auto canvas = CANVAS_CAST;
  auto picture = reinterpret_cast<SkPicture*>(c_picture);

  // Guard against division by zero
  if (sw == 0.0f || sh == 0.0f) {
    return;
  }

  // Pre-compute matrix like skia-canvas does
  float scale_x = dw / sw;
  float scale_y = dh / sh;

  // Build transformation matrix: scale then translate
  // postTranslate ensures translation is not scaled
  SkMatrix matrix = SkMatrix::I();
  matrix.setScale(scale_x, scale_y);
  matrix.postTranslate(dx - sx * scale_x, dy - sy * scale_y);

  canvas->save();
  canvas->clipRect(SkRect::MakeXYWH(dx, dy, dw, dh), SkClipOp::kIntersect,
                   true /* antialias */);

  // Optimization: skip paint if it's default (SrcOver blend, full alpha, no
  // filter) This matches skia-canvas behavior
  const SkPaint* paint = PAINT_CAST;
  if (paint != nullptr) {
    auto blendMode = paint->asBlendMode();
    if (blendMode.has_value() && blendMode.value() == SkBlendMode::kSrcOver &&
        paint->getAlpha() == 255 && paint->getImageFilter() == nullptr) {
      paint = nullptr;  // Skip paint for default case
    }
  }

  // Pass matrix directly to drawPicture instead of using canvas transforms
  canvas->drawPicture(picture, &matrix, paint);
  canvas->restore();
}

void skiac_canvas_destroy(skiac_canvas* c_canvas) {
  if (c_canvas) {
    delete CANVAS_CAST;
  }
}

// Paint

skiac_paint* skiac_paint_create() {
  return reinterpret_cast<skiac_paint*>(new SkPaint());
}

skiac_paint* skiac_paint_clone(skiac_paint* c_paint) {
  auto cloned_paint = new SkPaint(*PAINT_CAST);
  return reinterpret_cast<skiac_paint*>(cloned_paint);
}

void skiac_paint_destroy(skiac_paint* c_paint) {
  // Will unref() Shader and PathEffect.

  // SkPaint is not ref counted, so explicitly delete.
  delete PAINT_CAST;
}

void skiac_paint_set_color(skiac_paint* c_paint,
                           uint8_t r,
                           uint8_t g,
                           uint8_t b,
                           uint8_t a) {
  PAINT_CAST->setARGB(a, r, g, b);
}

void skiac_paint_set_alpha(skiac_paint* c_paint, uint8_t a) {
  PAINT_CAST->setAlpha(a);
}

uint8_t skiac_paint_get_alpha(skiac_paint* c_paint) {
  return PAINT_CAST->getAlpha();
}

void skiac_paint_set_anti_alias(skiac_paint* c_paint, bool aa) {
  PAINT_CAST->setAntiAlias(aa);
}

void skiac_paint_set_blend_mode(skiac_paint* c_paint, int blend_mode) {
  PAINT_CAST->setBlendMode((SkBlendMode)blend_mode);
}

int skiac_paint_get_blend_mode(skiac_paint* c_paint) {
  return (int)PAINT_CAST->getBlendMode_or(SkBlendMode::kSrcOver);
}

void skiac_paint_set_shader(skiac_paint* c_paint, skiac_shader* c_shader) {
  sk_sp<SkShader> shader(reinterpret_cast<SkShader*>(c_shader));

  // setShader accepts a smart pointer which will be destructed on delete.
  // Therefore we have to reference the object once more, to keep it valid in
  // Rust.
  shader->ref();

  PAINT_CAST->setShader(shader);
}

void skiac_paint_set_path_effect(skiac_paint* c_paint,
                                 skiac_path_effect* c_path_effect) {
  sk_sp<SkPathEffect> pathEffect(
      reinterpret_cast<SkPathEffect*>(c_path_effect));

  // setPathEffect accepts a smart pointer which will be destructed on delete.
  // Therefore we have to reference the object once more, to keep it valid in
  // Rust.
  pathEffect->ref();

  PAINT_CAST->setPathEffect(pathEffect);
}

void skiac_paint_set_mask_filter(skiac_paint* c_paint,
                                 skiac_mask_filter* c_mask_filter) {
  sk_sp<SkMaskFilter> maskFilter(
      reinterpret_cast<SkMaskFilter*>(c_mask_filter));
  maskFilter->ref();
  PAINT_CAST->setMaskFilter(maskFilter);
}

void skiac_paint_set_image_filter(skiac_paint* c_paint,
                                  skiac_image_filter* c_image_filter) {
  sk_sp<SkImageFilter> imageFilter(
      reinterpret_cast<SkImageFilter*>(c_image_filter));
  imageFilter->ref();

  PAINT_CAST->setImageFilter(imageFilter);
}

void skiac_paint_set_style(skiac_paint* c_paint, int style) {
  PAINT_CAST->setStyle((SkPaint::Style)style);
}

void skiac_paint_set_stroke_width(skiac_paint* c_paint, float width) {
  PAINT_CAST->setStrokeWidth(width);
}

float skiac_paint_get_stroke_width(skiac_paint* c_paint) {
  return PAINT_CAST->getStrokeWidth();
}

void skiac_paint_set_stroke_cap(skiac_paint* c_paint, int cap) {
  PAINT_CAST->setStrokeCap((SkPaint::Cap)cap);
}

int skiac_paint_get_stroke_cap(skiac_paint* c_paint) {
  return PAINT_CAST->getStrokeCap();
}

void skiac_paint_set_stroke_join(skiac_paint* c_paint, uint8_t join) {
  PAINT_CAST->setStrokeJoin((SkPaint::Join)join);
}

uint8_t skiac_paint_get_stroke_join(skiac_paint* c_paint) {
  return PAINT_CAST->getStrokeJoin();
}

void skiac_paint_set_stroke_miter(skiac_paint* c_paint, float miter) {
  PAINT_CAST->setStrokeMiter(miter);
}

float skiac_paint_get_stroke_miter(skiac_paint* c_paint) {
  return PAINT_CAST->getStrokeMiter();
}

// Path

skiac_path* skiac_path_create() {
  return new skiac_path();
}

skiac_path* skiac_path_from_svg(char* svg_path) {
  auto maybe_path = SkParsePath::FromSVGString(svg_path);
  if (maybe_path) {
    return new skiac_path(*maybe_path);
  }
  return nullptr;
}

skiac_path* skiac_path_clone(skiac_path* c_path) {
  return new skiac_path(c_path->path());
}

void skiac_picture_ref(skiac_picture* c_picture) {
  reinterpret_cast<SkPicture*>(c_picture)->ref();
}

void skiac_picture_destroy(skiac_picture* c_picture) {
  reinterpret_cast<SkPicture*>(c_picture)->unref();
}

// Direct playback without matrix/paint overhead
void skiac_picture_playback(skiac_picture* c_picture, skiac_canvas* c_canvas) {
  reinterpret_cast<SkPicture*>(c_picture)->playback(
      reinterpret_cast<SkCanvas*>(c_canvas));
}

// SkPictureRecorder
skiac_picture_recorder* skiac_picture_recorder_create() {
  return reinterpret_cast<skiac_picture_recorder*>(new SkPictureRecorder());
}

void skiac_picture_recorder_begin_recording(
    skiac_picture_recorder* c_picture_recorder,
    float x,
    float y,
    float width,
    float height,
    bool use_bbh) {
  auto rect = SkRect::MakeXYWH(x, y, width, height);
  auto recorder = reinterpret_cast<SkPictureRecorder*>(c_picture_recorder);
  if (use_bbh) {
    // Create an RTree for bounding box hierarchy - enables efficient culling
    // during playback
    sk_sp<SkBBoxHierarchy> bbh = SkRTreeFactory()();
    recorder->beginRecording(rect, std::move(bbh));
  } else {
    recorder->beginRecording(rect);
  }
}

skiac_canvas* skiac_picture_recorder_get_recording_canvas(
    skiac_picture_recorder* c_picture_recorder) {
  auto canvas = reinterpret_cast<SkPictureRecorder*>(c_picture_recorder)
                    ->getRecordingCanvas();
  return reinterpret_cast<skiac_canvas*>(canvas);
}

skiac_picture* skiac_picture_recorder_finish_recording_as_picture(
    skiac_picture_recorder* c_picture_recorder) {
  auto picture = reinterpret_cast<SkPictureRecorder*>(c_picture_recorder)
                     ->finishRecordingAsPicture();
  return reinterpret_cast<skiac_picture*>(picture.release());
}

skiac_drawable* skiac_picture_recorder_finish_recording_as_drawable(
    skiac_picture_recorder* c_picture_recorder) {
  auto drawable = reinterpret_cast<SkPictureRecorder*>(c_picture_recorder)
                      ->finishRecordingAsDrawable();
  return reinterpret_cast<skiac_drawable*>(drawable.release());
}

void skiac_canvas_draw_drawable(skiac_canvas* c_canvas,
                                skiac_drawable* c_drawable,
                                skiac_matrix* c_matrix) {
  auto canvas = reinterpret_cast<SkCanvas*>(c_canvas);
  auto drawable = reinterpret_cast<SkDrawable*>(c_drawable);
  if (c_matrix) {
    canvas->drawDrawable(drawable, MATRIX_CAST);
  } else {
    canvas->drawDrawable(drawable);
  }
}

void skiac_drawable_destroy(skiac_drawable* c_drawable) {
  reinterpret_cast<SkDrawable*>(c_drawable)->unref();
}

void skiac_path_swap(skiac_path* c_path, skiac_path* other_path) {
  std::swap(c_path->builder, other_path->builder);
  std::swap(c_path->cached_path, other_path->cached_path);
}

void skiac_add_path(skiac_path* c_path,
                    skiac_path* other_path,
                    skiac_matrix* c_matrix) {
  c_path->builder.addPath(other_path->path(), *MATRIX_CAST,
                          SkPath::AddPathMode::kExtend_AddPathMode);
  c_path->invalidate();
}

bool skiac_path_op(skiac_path* c_path_one, skiac_path* c_path_two, int op) {
  SkPath result;
  if (Op(c_path_one->path(), c_path_two->path(), (SkPathOp)op, &result)) {
    c_path_one->replace_from_path(result);
    return true;
  }
  return false;
}

void skiac_path_to_svg_string(skiac_path* c_path, skiac_string* c_string) {
  auto string = SkParsePath::ToSVGString(c_path->path());
  auto length = string.size();
  auto result_string = new SkString(length);
  string.swap(*result_string);
  c_string->length = length;
  c_string->ptr = result_string->c_str();
  c_string->sk_string = result_string;
}

bool skiac_path_simplify(skiac_path* c_path) {
  SkPath result;
  if (Simplify(c_path->path(), &result)) {
    c_path->replace_from_path(result);
    return true;
  }
  return false;
}

bool skiac_path_as_winding(skiac_path* c_path) {
  SkPath result;
  if (AsWinding(c_path->path(), &result)) {
    c_path->replace_from_path(result);
    return true;
  }
  return false;
}

bool skiac_path_stroke(skiac_path* c_path,
                       int cap,
                       uint8_t join,
                       float width,
                       float miter_limit) {
  SkPaint p;
  p.setStyle(SkPaint::kStroke_Style);
  p.setStrokeCap((SkPaint::Cap)cap);
  p.setStrokeJoin((SkPaint::Join)join);
  p.setStrokeWidth(width);
  p.setStrokeMiter(miter_limit);
  SkPath result;
  if (skpathutils::FillPathWithPaint(c_path->path(), p, &result)) {
    c_path->replace_from_path(result);
    return true;
  }
  return false;
}

void skiac_path_compute_tight_bounds(skiac_path* c_path, skiac_rect* c_rect) {
  // Use SkPath::computeTightBounds() for precise bounds that evaluate curves
  auto rect = c_path->path().computeTightBounds();
  c_rect->left = rect.fLeft;
  c_rect->top = rect.fTop;
  c_rect->right = rect.fRight;
  c_rect->bottom = rect.fBottom;
}

void skiac_path_get_bounds(skiac_path* c_path, skiac_rect* c_rect) {
  // Use SkPath::getBounds() which has internal caching
  auto rect = c_path->path().getBounds();
  c_rect->left = rect.fLeft;
  c_rect->top = rect.fTop;
  c_rect->right = rect.fRight;
  c_rect->bottom = rect.fBottom;
}

bool skiac_path_trim(skiac_path* c_path,
                     float start_t,
                     float stop_t,
                     bool is_complement) {
  auto mode = is_complement ? SkTrimPathEffect::Mode::kInverted
                            : SkTrimPathEffect::Mode::kNormal;
  auto pe = SkTrimPathEffect::Make(start_t, stop_t, mode);
  if (!pe) {
    return false;
  }
  SkStrokeRec rec(SkStrokeRec::InitStyle::kHairline_InitStyle);
  SkPath result;
  if (pe->filterPath(&result, c_path->path(), &rec, nullptr)) {
    c_path->replace_from_path(result);
    return true;
  }
  return false;
}

bool skiac_path_dash(skiac_path* c_path, float on, float off, float phase) {
  float intervals[] = {on, off};
  auto pe = SkDashPathEffect::Make(intervals, phase);
  if (!pe) {
    return false;
  }
  SkStrokeRec rec(SkStrokeRec::InitStyle::kHairline_InitStyle);
  SkPath result;
  if (pe->filterPath(&result, c_path->path(), &rec, nullptr)) {
    c_path->replace_from_path(result);
    return true;
  }
  return false;
}

bool skiac_path_round(skiac_path* c_path, float radius) {
  auto pe = SkCornerPathEffect::Make(radius);
  if (!pe) {
    return false;
  }
  SkStrokeRec rec(SkStrokeRec::InitStyle::kHairline_InitStyle);
  SkPath result;
  if (pe->filterPath(&result, c_path->path(), &rec, nullptr)) {
    c_path->replace_from_path(result);
    return true;
  }
  return false;
}

bool skiac_path_equals(skiac_path* c_path, skiac_path* other_path) {
  return c_path->path() == other_path->path();
}

void skiac_path_destroy(skiac_path* c_path) {
  delete c_path;
}

void skiac_path_set_fill_type(skiac_path* c_path, int type) {
  c_path->builder.setFillType((SkPathFillType)type);
  c_path->invalidate();
}

int skiac_path_get_fill_type(skiac_path* c_path) {
  return (int)c_path->builder.fillType();
}

void skiac_path_arc_to_tangent(skiac_path* c_path,
                               float x1,
                               float y1,
                               float x2,
                               float y2,
                               float radius) {
  c_path->builder.arcTo(SkPoint::Make(x1, y1), SkPoint::Make(x2, y2), radius);
  c_path->invalidate();
}

void skiac_path_arc_to(skiac_path* c_path,
                       float left,
                       float top,
                       float right,
                       float bottom,
                       float startAngle,
                       float sweepAngle,
                       bool forceMoveTo) {
  SkRect rect = SkRect::MakeLTRB(left, top, right, bottom);
  c_path->builder.arcTo(rect, startAngle, sweepAngle, forceMoveTo);
  c_path->invalidate();
}

void skiac_path_move_to(skiac_path* c_path, float x, float y) {
  c_path->builder.moveTo(x, y);
  c_path->invalidate();
}

void skiac_path_line_to(skiac_path* c_path, float x, float y) {
  c_path->builder.lineTo(x, y);
  c_path->invalidate();
}

void skiac_path_cubic_to(skiac_path* c_path,
                         float x1,
                         float y1,
                         float x2,
                         float y2,
                         float x3,
                         float y3) {
  c_path->builder.cubicTo(x1, y1, x2, y2, x3, y3);
  c_path->invalidate();
}

void skiac_path_quad_to(skiac_path* c_path,
                        float cpx,
                        float cpy,
                        float x,
                        float y) {
  c_path->builder.quadTo(cpx, cpy, x, y);
  c_path->invalidate();
}

void skiac_path_close(skiac_path* c_path) {
  c_path->builder.close();
  c_path->invalidate();
}

void skiac_path_add_rect(skiac_path* c_path,
                         float x,
                         float y,
                         float width,
                         float height) {
  SkRect rect = SkRect::MakeXYWH(x, y, width, height);
  c_path->builder.addRect(rect);
  c_path->invalidate();
}

void skiac_path_add_circle(skiac_path* c_path, float x, float y, float r) {
  c_path->builder.addCircle(x, y, r);
  c_path->invalidate();
}

skiac_path* skiac_path_transform(skiac_path* c_path, skiac_matrix* c_matrix) {
  SkMatrix matrix = *MATRIX_CAST;

  // Check for trailing moveTo (Skia trims these during SkPath creation)
  SkSpan<const SkPathVerb> verbs = c_path->builder.verbs();
  bool hasTrailingMove = !verbs.empty() && verbs.back() == SkPathVerb::kMove;
  SkPoint trailingMovePoint =
      hasTrailingMove ? c_path->builder.points().back() : SkPoint{0, 0};

  // Transform the path (this will lose trailing moveTo)
  SkPath transformed = c_path->path().makeTransform(matrix);
  skiac_path* result = new skiac_path(transformed);

  // Restore trailing moveTo with transformed coordinates
  if (hasTrailingMove) {
    SkPoint transformedPoint = matrix.mapPoint(trailingMovePoint);
    result->builder.moveTo(transformedPoint);
    result->invalidate();
  }

  return result;
}

void skiac_path_transform_self(skiac_path* c_path, skiac_matrix* c_matrix) {
  SkMatrix matrix = *reinterpret_cast<SkMatrix*>(c_matrix);

  // Check for trailing moveTo before transform (Skia trims these during SkPath
  // creation)
  SkSpan<const SkPathVerb> verbs = c_path->builder.verbs();
  bool hasTrailingMove = !verbs.empty() && verbs.back() == SkPathVerb::kMove;
  SkPoint trailingMovePoint = {0, 0};
  if (hasTrailingMove) {
    trailingMovePoint = c_path->builder.points().back();
  }

  // Transform the path (this will lose trailing moveTo)
  SkPath transformed = c_path->path().makeTransform(matrix);
  c_path->replace_from_path(transformed);

  // Restore trailing moveTo with transformed coordinates
  if (hasTrailingMove) {
    SkPoint transformedPoint = matrix.mapPoint(trailingMovePoint);
    c_path->builder.moveTo(transformedPoint);
    c_path->invalidate();
  }
}

bool skiac_path_is_empty(skiac_path* c_path) {
  return c_path->builder.isEmpty();
}

bool skiac_path_hit_test(skiac_path* c_path, float x, float y, int type) {
  // Create a temporary path with the desired fill type to avoid mutating the
  // builder
  SkPathBuilder temp_builder(c_path->path());
  temp_builder.setFillType((SkPathFillType)type);
  return temp_builder.snapshot().contains(x, y);
}

bool skiac_path_stroke_hit_test(skiac_path* c_path,
                                float x,
                                float y,
                                float stroke_w) {
  SkPath path_with_winding = c_path->path();
  path_with_winding.setFillType(SkPathFillType::kWinding);

  SkPaint paint;
  paint.setStrokeWidth(stroke_w);
  paint.setStyle(SkPaint::kStroke_Style);
  SkPath traced_path;

  auto precision = 0.3;  // Based on config in Chromium
  if (skpathutils::FillPathWithPaint(path_with_winding, paint, &traced_path,
                                     nullptr, precision)) {
    return traced_path.contains(x, y);
  }
  return path_with_winding.contains(x, y);
}

void skiac_path_round_rect(skiac_path* c_path,
                           SkScalar x,
                           SkScalar y,
                           SkScalar width,
                           SkScalar height,
                           SkScalar* radii,
                           bool clockwise) {
  // Convert 4 scalar radii to uniform SkVector radii (same x/y per corner)
  SkVector radii_vectors[4];
  for (size_t i = 0; i < 4; i++) {
    radii_vectors[i] = {radii[i], radii[i]};
  }
  SkRect rect = SkRect::MakeXYWH(x, y, width, height);
  SkRRect rrect;
  rrect.setRectRadii(rect, radii_vectors);
  auto direction = clockwise ? SkPathDirection::kCW : SkPathDirection::kCCW;
  c_path->builder.addRRect(rrect, direction);
  c_path->invalidate();
}

// PathEffect

skiac_path_effect* skiac_path_effect_make_dash_path(const float* intervals,
                                                    int count,
                                                    float phase) {
  SkSpan<const SkScalar> intervals_span(intervals, count);
  auto effect = SkDashPathEffect::Make(intervals_span, phase).release();
  if (effect) {
    return reinterpret_cast<skiac_path_effect*>(effect);
  } else {
    return nullptr;
  }
}

void skiac_path_effect_destroy(skiac_path_effect* c_path_effect) {
  // SkPathEffect is ref counted.
  auto effect = reinterpret_cast<SkPathEffect*>(c_path_effect);
  effect->unref();
}

// Shader

skiac_shader* skiac_shader_make_linear_gradient(const skiac_point* c_points,
                                                const uint32_t* colors,
                                                const float* positions,
                                                int count,
                                                int tile_mode,
                                                uint32_t flags,
                                                skiac_transform c_ts) {
  const auto points = reinterpret_cast<const SkPoint*>(c_points);
  const auto skia_tile_mode = (SkTileMode)tile_mode;
  const auto ts = conv_from_transform(c_ts);
  auto shader = SkGradientShader::MakeLinear(points, colors, positions, count,
                                             skia_tile_mode, flags, &ts)
                    .release();

  if (shader) {
    return reinterpret_cast<skiac_shader*>(shader);
  } else {
    return nullptr;
  }
}

skiac_shader* skiac_shader_make_radial_gradient(skiac_point c_start_point,
                                                float start_radius,
                                                skiac_point c_end_point,
                                                float end_radius,
                                                const uint32_t* colors,
                                                const float* positions,
                                                int count,
                                                int tile_mode,
                                                uint32_t flags,
                                                skiac_transform c_ts) {
  const SkPoint startPoint = {c_start_point.x, c_start_point.y};
  const SkPoint endPoint = {c_end_point.x, c_end_point.y};
  auto shader = SkGradientShader::MakeTwoPointConical(
                    startPoint, start_radius, endPoint, end_radius, colors,
                    positions, count, (SkTileMode)tile_mode, flags, nullptr)
                    .release();

  if (shader) {
    return reinterpret_cast<skiac_shader*>(shader);
  } else {
    return nullptr;
  }
}

skiac_shader* skiac_shader_make_conic_gradient(SkScalar cx,
                                               SkScalar cy,
                                               SkScalar radius,
                                               const uint32_t* colors,
                                               const float* positions,
                                               int count,
                                               int tile_mode,
                                               uint32_t flags,
                                               skiac_transform c_ts) {
  auto ts = conv_from_transform(c_ts);
  // Skia's sweep gradient angles are relative to the x-axis, not the y-axis.
  ts.preRotate(radius - 90.0, cx, cy);
  auto shader = SkGradientShader::MakeSweep(cx, cy, colors, positions, count,
                                            (SkTileMode)tile_mode, radius,
                                            360.0, flags, &ts)
                    .release();

  if (shader) {
    return reinterpret_cast<skiac_shader*>(shader);
  } else {
    return nullptr;
  }
}

skiac_shader* skiac_shader_make_from_surface_image(skiac_surface* c_surface,
                                                   skiac_transform c_ts,
                                                   int filter_quality) {
  auto skia_tile_mode = SkTileMode::kRepeat;
  const auto ts = conv_from_transform(c_ts);
  const SkSamplingOptions sampling_options =
      SamplingOptionsFromFQ(filter_quality);
  sk_sp<SkImage> image = SURFACE_CAST->makeImageSnapshot();
  auto shader =
      image->makeShader(skia_tile_mode, skia_tile_mode, sampling_options, &ts)
          .release();

  if (shader) {
    return reinterpret_cast<skiac_shader*>(shader);
  }
  return nullptr;
}

void skiac_shader_ref(skiac_shader* c_shader) {
  auto shader = reinterpret_cast<SkShader*>(c_shader);
  shader->ref();
}

void skiac_shader_destroy(skiac_shader* c_shader) {
  // SkShader is ref counted.
  auto shader = reinterpret_cast<SkShader*>(c_shader);
  shader->unref();
}

skiac_matrix* skiac_matrix_create() {
  return reinterpret_cast<skiac_matrix*>(new SkMatrix());
}

skiac_matrix* skiac_matrix_new(float a,
                               float b,
                               float c,
                               float d,
                               float e,
                               float f) {
  auto m = new SkMatrix(SkMatrix::MakeAll(a, b, c, d, e, f, 0, 0, 1));
  return reinterpret_cast<skiac_matrix*>(m);
}

skiac_matrix* skiac_matrix_from_ts(const skiac_transform* c_ts) {
  auto matrix = conv_from_transform(*c_ts);
  auto m = new SkMatrix(matrix);
  return reinterpret_cast<skiac_matrix*>(m);
}

skiac_matrix* skiac_matrix_create_rotated(float rotation, float x, float y) {
  auto matrix = new SkMatrix();
  matrix->setRotate(rotation, x, y);
  return reinterpret_cast<skiac_matrix*>(matrix);
}

skiac_matrix* skiac_matrix_create_translated(float x, float y) {
  auto matrix = new SkMatrix();
  matrix->setTranslate(x, y);
  return reinterpret_cast<skiac_matrix*>(matrix);
}

skiac_matrix* skiac_matrix_concat(skiac_matrix* c_matrix, skiac_matrix* other) {
  auto m = SkMatrix::Concat(*MATRIX_CAST, *reinterpret_cast<SkMatrix*>(other));
  auto r = new SkMatrix(m);
  return reinterpret_cast<skiac_matrix*>(r);
}

skiac_matrix* skiac_matrix_multiply(skiac_matrix* c_matrix,
                                    skiac_matrix* other) {
  auto m = *MATRIX_CAST;
  auto o = *reinterpret_cast<SkMatrix*>(other);
  auto r = new SkMatrix(o * m);
  return reinterpret_cast<skiac_matrix*>(r);
}

void skiac_matrix_map_points_1(skiac_matrix* c_matrix,
                               float x,
                               float y,
                               skiac_mapped_point* mapped_point) {
  SkPoint dst[1];
  auto p = SkPoint::Make(x, y);
  SkPoint src[] = {p};
  MATRIX_CAST->mapPoints({dst, 1}, {src, 1});
  auto dp = dst[0];
  mapped_point->x = dp.fX;
  mapped_point->y = dp.fY;
}

skiac_matrix* skiac_matrix_clone(skiac_matrix* c_matrix) {
  return reinterpret_cast<skiac_matrix*>(new SkMatrix(*MATRIX_CAST));
}

void skiac_matrix_pre_translate(skiac_matrix* c_matrix, float dx, float dy) {
  MATRIX_CAST->preTranslate(dx, dy);
}

void skiac_matrix_pre_concat(skiac_matrix* c_matrix, skiac_matrix* other) {
  MATRIX_CAST->preConcat(*reinterpret_cast<SkMatrix*>(other));
}

void skiac_matrix_pre_scale(skiac_matrix* c_matrix, float sx, float sy) {
  MATRIX_CAST->preScale(sx, sy);
}

void skiac_matrix_pre_concat_transform(skiac_matrix* c_matrix,
                                       skiac_transform c_ts) {
  auto ts = conv_from_transform(c_ts);
  MATRIX_CAST->preConcat(ts);
}

void skiac_matrix_pre_rotate(skiac_matrix* c_matrix, float degrees) {
  MATRIX_CAST->preRotate(degrees);
}

void skiac_matrix_pre_rotate_x_y(skiac_matrix* c_matrix,
                                 float degrees,
                                 float x,
                                 float y) {
  MATRIX_CAST->preRotate(degrees, x, y);
}

bool skiac_matrix_invert(skiac_matrix* c_matrix, skiac_matrix* inverse) {
  return MATRIX_CAST->invert(reinterpret_cast<SkMatrix*>(inverse));
}

skiac_transform skiac_matrix_to_transform(skiac_matrix* c_matrix) {
  return conv_to_transform(*MATRIX_CAST);
}

void skiac_matrix_destroy(skiac_matrix* c_matrix) {
  delete MATRIX_CAST;
}

// SkMaskFilter

skiac_mask_filter* skiac_mask_filter_make_blur(float radius) {
  auto filter =
      SkMaskFilter::MakeBlur(SkBlurStyle::kNormal_SkBlurStyle, radius, false)
          .release();
  if (filter) {
    return reinterpret_cast<skiac_mask_filter*>(filter);
  } else {
    return nullptr;
  }
}

void skiac_mask_filter_destroy(skiac_mask_filter* c_mask_filter) {
  auto mask_filter = MASK_FILTER_CAST;
  mask_filter->unref();
}

// SkImageFilter

skiac_image_filter* skiac_image_filter_make_drop_shadow_only(
    float dx,
    float dy,
    float sigma_x,
    float sigma_y,
    uint32_t color,
    skiac_image_filter* c_image_filter) {
  auto chained_filter = sk_sp(IMAGE_FILTER_CAST);
  if (c_image_filter) {
    chained_filter->ref();
  }
  auto filter = SkImageFilters::DropShadowOnly(dx, dy, sigma_x, sigma_y, color,
                                               chained_filter)
                    .release();
  if (filter) {
    return reinterpret_cast<skiac_image_filter*>(filter);
  } else {
    return nullptr;
  }
}

skiac_image_filter* skiac_image_filter_make_drop_shadow(
    float dx,
    float dy,
    float sigma_x,
    float sigma_y,
    uint32_t color,
    skiac_image_filter* c_image_filter) {
  auto chained_filter = sk_sp(IMAGE_FILTER_CAST);
  if (c_image_filter) {
    chained_filter->ref();
  }
  auto filter = SkImageFilters::DropShadow(dx, dy, sigma_x, sigma_y, color,
                                           chained_filter)
                    .release();
  if (filter) {
    return reinterpret_cast<skiac_image_filter*>(filter);
  } else {
    return nullptr;
  }
}

skiac_image_filter* skiac_image_filter_make_blur(
    float sigma_x,
    float sigma_y,
    skiac_image_filter* c_image_filter) {
  auto chained_filter = sk_sp(IMAGE_FILTER_CAST);
  if (c_image_filter) {
    chained_filter->ref();
  }
  auto filter =
      SkImageFilters::Blur(sigma_x, sigma_y, chained_filter).release();
  if (filter) {
    return reinterpret_cast<skiac_image_filter*>(filter);
  } else {
    return nullptr;
  }
}

skiac_image_filter* skiac_image_filter_color_filter(
    float m00,
    float m01,
    float m02,
    float m10,
    float m11,
    float m12,
    float m20,
    float m21,
    float m22,
    float opacity,
    skiac_image_filter* c_image_filter) {
  auto chained_filter = sk_sp(IMAGE_FILTER_CAST);
  if (c_image_filter) {
    chained_filter->ref();
  }
  const auto color_matrix =
      SkColorMatrix(m00, m01, m02, 0.0, 0.0, m10, m11, m12, 0.0, 0.0, m20, m21,
                    m22, 0.0, 0.0, 0.0, 0.0, 0.0, opacity, 0.0);
  auto color_filter = SkColorFilters::Matrix(color_matrix);
  auto filter =
      SkImageFilters::ColorFilter(color_filter, chained_filter).release();
  if (filter) {
    return reinterpret_cast<skiac_image_filter*>(filter);
  } else {
    return nullptr;
  }
}

skiac_image_filter* skiac_image_filter_from_argb(
    const uint8_t table_a[256],
    const uint8_t table_r[256],
    const uint8_t table_g[256],
    const uint8_t table_b[256],
    skiac_image_filter* c_image_filter) {
  auto cf = SkColorFilters::TableARGB(table_a, table_r, table_g, table_b);
  auto chained_filter = sk_sp(IMAGE_FILTER_CAST);
  if (c_image_filter) {
    chained_filter->ref();
  }
  auto filter = SkImageFilters::ColorFilter(cf, chained_filter).release();
  if (filter) {
    return reinterpret_cast<skiac_image_filter*>(filter);
  } else {
    return nullptr;
  }
}

void skiac_image_filter_ref(skiac_image_filter* c_image_filter) {
  auto image_filter = IMAGE_FILTER_CAST;
  image_filter->ref();
}

void skiac_image_filter_destroy(skiac_image_filter* c_image_filter) {
  auto image_filter = IMAGE_FILTER_CAST;
  image_filter->unref();
}

// SkImage (for PageCache)
#define IMAGE_CAST reinterpret_cast<SkImage*>(c_image)

skiac_image* skiac_surface_make_image_snapshot(skiac_surface* c_surface) {
  auto image = SURFACE_CAST->makeImageSnapshot();
  if (image) {
    return reinterpret_cast<skiac_image*>(image.release());
  }
  return nullptr;
}

void skiac_image_ref(skiac_image* c_image) {
  IMAGE_CAST->ref();
}

void skiac_image_destroy(skiac_image* c_image) {
  IMAGE_CAST->unref();
}

int skiac_image_get_width(skiac_image* c_image) {
  return IMAGE_CAST->width();
}

int skiac_image_get_height(skiac_image* c_image) {
  return IMAGE_CAST->height();
}

void skiac_canvas_draw_sk_image(skiac_canvas* c_canvas,
                                skiac_image* c_image,
                                float left,
                                float top,
                                int filter_quality) {
  const auto sampling = SamplingOptionsFromFQ(filter_quality);
  CANVAS_CAST->drawImage(IMAGE_CAST, left, top, sampling, nullptr);
}

// SkData

void skiac_sk_data_destroy(skiac_data* c_data) {
  auto data = reinterpret_cast<SkData*>(c_data);
  data->unref();
}

// Bitmap

void skiac_bitmap_make_from_buffer(const uint8_t* ptr,
                                   size_t size,
                                   skiac_bitmap_info* bitmap_info) {
  auto data = SkData::MakeWithoutCopy(reinterpret_cast<const void*>(ptr), size);
  auto codec = SkCodec::MakeFromData(data);
  auto info = codec->getInfo();
  auto row_bytes = info.minRowBytes();
  auto bitmap = new SkBitmap();
  bitmap->allocPixels(info);
  codec->getPixels(info, bitmap->getPixels(), row_bytes);
  auto dimension = codec->dimensions();
  auto origin = codec->getOrigin();
  auto width = dimension.width();
  auto height = dimension.height();
  // https://github.com/chromium/chromium/blob/126.0.6423.1/third_party/blink/renderer/platform/graphics/image.cc#L124
  // need to create a new bitmap with the correct orientation
  if (origin != SkEncodedOrigin::kTopLeft_SkEncodedOrigin) {
    if (origin == SkEncodedOrigin::kLeftTop_SkEncodedOrigin ||
        origin == SkEncodedOrigin::kRightTop_SkEncodedOrigin ||
        origin == SkEncodedOrigin::kRightBottom_SkEncodedOrigin ||
        origin == SkEncodedOrigin::kLeftBottom_SkEncodedOrigin) {
      width = height;
      height = dimension.width();
    }
    auto oriented_bitmap = new SkBitmap();
    auto oriented_bitmap_info =
        SkImageInfo::Make(width, height, info.colorType(), info.alphaType());
    oriented_bitmap->allocPixels(oriented_bitmap_info);
    auto canvas = new SkCanvas(*oriented_bitmap);
    auto matrix = SkEncodedOriginToMatrix(origin, width, height);
    canvas->setMatrix(matrix);
    auto image = SkImages::RasterFromBitmap(*bitmap);
    canvas->drawImage(image, 0, 0);
    oriented_bitmap->setImmutable();
    bitmap_info->bitmap = reinterpret_cast<skiac_bitmap*>(oriented_bitmap);
    delete bitmap;
  } else {
    bitmap->setImmutable();
    bitmap_info->bitmap = reinterpret_cast<skiac_bitmap*>(bitmap);
  }
  bitmap_info->width = width;
  bitmap_info->height = height;
}

bool skiac_bitmap_make_from_svg(const uint8_t* data,
                                size_t length,
                                float width,
                                float height,
                                skiac_bitmap_info* bitmap_info,
                                skiac_font_collection* c_collection,
                                uint8_t cs) {
  auto color_space = COLOR_SPACE_CAST;
  auto svg_stream = new SkMemoryStream(data, length, false);
  auto svg_dom = SkSVGDOM::Builder()
                     .setFontManager(c_collection->assets)
                     .make(*svg_stream);
  if (!svg_dom) {
    return false;
  }
  auto svg_root = svg_dom->getRoot();
  auto svg_container_size =
      svg_root->intrinsicSize(SkSVGLengthContext(SkSize::Make(0, 0)));
  if (svg_container_size.isZero()) {
    auto view_box = svg_root->getViewBox();
    if (!view_box) {
      return true;
    }
    svg_container_size = SkSize::Make(view_box->width(), view_box->height());
    if (svg_container_size.isEmpty()) {
      return true;
    }
    svg_dom->setContainerSize(svg_container_size);
  }
  auto image_w = svg_container_size.width();
  auto image_h = svg_container_size.height();
  if (width > 0 && height > 0) {
    svg_root->setTransform(SkMatrix::Scale(width / image_w, height / image_h));
    image_w = width;
    image_h = height;
  }
  auto imageinfo =
      SkImageInfo::Make(image_w, image_h, kRGBA_8888_SkColorType,
                        SkAlphaType::kPremul_SkAlphaType, color_space);
  auto bitmap = new SkBitmap();
  bitmap->allocPixels(imageinfo);
  auto sk_svg_canvas = new SkCanvas(*bitmap);
  svg_dom->render(sk_svg_canvas);
  delete sk_svg_canvas;
  bitmap_info->bitmap = reinterpret_cast<skiac_bitmap*>(bitmap);
  bitmap_info->width = imageinfo.width();
  bitmap_info->height = imageinfo.height();
  return true;
}

skiac_bitmap* skiac_bitmap_make_from_image_data(uint8_t* ptr,
                                                size_t width,
                                                size_t height,
                                                size_t row_bytes,
                                                size_t size,
                                                int ct,
                                                int at) {
  auto bitmap = new SkBitmap();
  const auto info = SkImageInfo::Make((int)width, (int)(height),
                                      (SkColorType)ct, (SkAlphaType)at);
  bitmap->installPixels(info, ptr, row_bytes);
  return reinterpret_cast<skiac_bitmap*>(bitmap);
}

size_t skiac_bitmap_get_width(skiac_bitmap* c_bitmap) {
  auto bitmap = reinterpret_cast<SkBitmap*>(c_bitmap);
  return bitmap->width();
}

size_t skiac_bitmap_get_height(skiac_bitmap* c_bitmap) {
  auto bitmap = reinterpret_cast<SkBitmap*>(c_bitmap);
  return bitmap->height();
}

skiac_shader* skiac_bitmap_get_shader(
    bool is_canvas,
    skiac_bitmap* c_bitmap,
    int repeat_x,
    int repeat_y,
    float B,
    float C,  // See SkSamplingOptions.h for docs.
    skiac_transform c_ts) {
  const auto ts = conv_from_transform(c_ts);
  SkBitmap* bitmap;
  if (is_canvas) {
    auto surface = reinterpret_cast<SkSurface*>(c_bitmap);
    auto bm = new SkBitmap();
    bm->allocPixels(surface->imageInfo());
    if (surface->readPixels(*bm, 0, 0)) {
      bitmap = bm;
    } else {
      return nullptr;
    }
  } else {
    bitmap = reinterpret_cast<SkBitmap*>(c_bitmap);
  }
  auto shader = bitmap
                    ->makeShader((SkTileMode)repeat_x, (SkTileMode)repeat_y,
                                 SkSamplingOptions({B, C}), &ts)
                    .release();
  if (shader) {
    return reinterpret_cast<skiac_shader*>(shader);
  }
  return nullptr;
}

void skiac_bitmap_destroy(skiac_bitmap* c_bitmap) {
  delete BITMAP_CAST;
}

// SkString
void skiac_delete_sk_string(skiac_sk_string* c_sk_string) {
  delete reinterpret_cast<SkString*>(c_sk_string);
}

skiac_font_collection* skiac_font_collection_create() {
  return new skiac_font_collection();
}

uint32_t skiac_font_collection_get_default_fonts_count(
    skiac_font_collection* c_font_collection) {
  return c_font_collection->assets->countFamilies();
}

void skiac_font_collection_get_family(
    skiac_font_collection* c_font_collection,
    uint32_t i,
    skiac_string* c_string,
    void* on_get_style_rust,
    skiac_on_match_font_style on_match_font_style) {
  auto name = new SkString();
  c_font_collection->assets->getFamilyName(i, name);
  auto font_style_set = c_font_collection->assets->matchFamily(name->c_str());
  auto style_count = font_style_set->count();
  for (auto i = 0; i < style_count; i++) {
    SkFontStyle style;
    font_style_set->getStyle(i, &style, nullptr);
    if (on_match_font_style) {
      on_match_font_style(style.width(), style.weight(), (int)style.slant(),
                          on_get_style_rust);
    }
  }
  c_string->length = name->size();
  c_string->ptr = name->c_str();
  c_string->sk_string = name;
}

size_t skiac_font_collection_register(skiac_font_collection* c_font_collection,
                                      const uint8_t* font,
                                      size_t length,
                                      const char* name_alias) {
  auto typeface_data = SkData::MakeWithoutCopy(font, length);
  auto typeface = c_font_collection->font_mgr->makeFromData(typeface_data);
  auto result = c_font_collection->assets->registerTypeface(typeface);
  if (name_alias) {
    auto alias = SkString(name_alias);
    c_font_collection->assets->registerTypeface(typeface, alias);
  };
  return result;
}

size_t skiac_font_collection_register_from_path(
    skiac_font_collection* c_font_collection,
    const char* font_path,
    const char* name_alias) {
  auto typeface = c_font_collection->font_mgr->makeFromFile(font_path);
  auto result = c_font_collection->assets->registerTypeface(typeface);
  if (name_alias) {
    auto alias = SkString(name_alias);
    c_font_collection->assets->registerTypeface(typeface, alias);
  }
  return result;
}

void skiac_font_collection_set_alias(skiac_font_collection* c_font_collection,
                                     const char* family,
                                     const char* alias) {
  auto style = SkFontStyle();
  auto typeface = c_font_collection->assets->matchFamilyStyle(family, style);
  c_font_collection->assets->registerTypeface(sk_sp(typeface), SkString(alias));
}

void skiac_font_collection_destroy(skiac_font_collection* c_font_collection) {
  delete c_font_collection;
}

// Variable Fonts
int skiac_typeface_get_variation_design_position(
    skiac_font_collection* c_font_collection,
    const char* family_name,
    int weight,
    int width,
    int slant,
    skiac_variable_font_axis* axes,
    int max_axis_count) {
  if (!c_font_collection || !family_name || !axes || max_axis_count <= 0) {
    return 0;
  }

  auto font_style = SkFontStyle(weight, width, (SkFontStyle::Slant)slant);
  auto typeface =
      c_font_collection->assets->matchFamilyStyle(family_name, font_style);
  if (!typeface) {
    return 0;
  }

  // Use getVariationDesignParameters to get the full axis details (min, max,
  // def)
  int axis_count = typeface->getVariationDesignParameters({});
  if (axis_count <= 0) {
    return 0;
  }

  std::vector<SkFontParameters::Variation::Axis> params(axis_count);
  typeface->getVariationDesignParameters({params.data(), params.size()});

  // Also get current position to fill in the 'value' field
  int pos_count = typeface->getVariationDesignPosition({});
  std::vector<SkFontArguments::VariationPosition::Coordinate> coords(pos_count);
  if (pos_count > 0) {
    typeface->getVariationDesignPosition({coords.data(), coords.size()});
  }

  int count = std::min(axis_count, max_axis_count);
  for (int i = 0; i < count; i++) {
    axes[i].tag = params[i].tag;
    axes[i].min = params[i].min;
    axes[i].max = params[i].max;
    axes[i].def = params[i].def;
    axes[i].hidden = params[i].isHidden();

    // Default to 'def' value
    axes[i].value = params[i].def;

    // If we have a current value for this axis, use it
    for (int j = 0; j < pos_count; j++) {
      if (coords[j].axis == params[i].tag) {
        axes[i].value = coords[j].value;
        break;
      }
    }
  }

  return count;
}

bool skiac_font_has_variations(skiac_font_collection* c_font_collection,
                               const char* family_name,
                               int weight,
                               int width,
                               int slant) {
  if (!c_font_collection || !family_name) {
    return false;
  }

  auto font_style = SkFontStyle(weight, width, (SkFontStyle::Slant)slant);
  auto typeface =
      c_font_collection->assets->matchFamilyStyle(family_name, font_style);
  if (!typeface) {
    return false;
  }

  int axis_count = typeface->getVariationDesignParameters({});
  return axis_count > 0;
}

// SkWStream
void skiac_sk_w_stream_get(skiac_w_memory_stream* c_w_memory_stream,
                           skiac_sk_data* sk_data,
                           int width,
                           int height) {
  auto stream = reinterpret_cast<SkDynamicMemoryWStream*>(c_w_memory_stream);
  auto size = stream->bytesWritten();
  auto data = SkData::MakeUninitialized(size);
  stream->copyTo(data->writable_data());
  auto data_ptr = data.release();
  sk_data->data = reinterpret_cast<skiac_data*>(data_ptr);
  sk_data->ptr = data_ptr->bytes();
  sk_data->size = data_ptr->size();
}

void skiac_sk_w_stream_destroy(skiac_w_memory_stream* c_w_memory_stream) {
  delete reinterpret_cast<SkDynamicMemoryWStream*>(c_w_memory_stream);
}

// SkSVG
void skiac_svg_text_to_path(const uint8_t* data,
                            size_t length,
                            skiac_font_collection* c_collection,
                            skiac_sk_data* output_data) {
  auto svg_stream = new SkMemoryStream(data, length, false);
  auto w_stream = new SkDynamicMemoryWStream();
  auto svg_dom = SkSVGDOM::Builder()
                     .setFontManager(c_collection->assets)
                     .make(*svg_stream);
  auto svg_root = svg_dom->getRoot();
  auto svg_container_size =
      svg_root->intrinsicSize(SkSVGLengthContext(SkSize::Make(0, 0)));
  auto canvas =
      SkSVGCanvas::Make(SkRect::MakeSize(svg_container_size), w_stream,
                        SkSVGCanvas::kConvertTextToPaths_Flag);
  svg_dom->render(canvas.get());
  canvas.reset();
  auto d = w_stream->detachAsData().release();
  output_data->data = reinterpret_cast<skiac_data*>(d);
  output_data->size = d->size();
  output_data->ptr = d->bytes();
}

// SkDocument
void skiac_document_create(skiac_pdf_document* c_document,
                           const skiac_pdf_metadata* metadata) {
  auto w_stream = new SkDynamicMemoryWStream();

  SkPDF::Metadata pdf_metadata;
  if (metadata) {
    if (metadata->title) {
      pdf_metadata.fTitle = SkString(metadata->title);
    }
    if (metadata->author) {
      pdf_metadata.fAuthor = SkString(metadata->author);
    }
    if (metadata->subject) {
      pdf_metadata.fSubject = SkString(metadata->subject);
    }
    if (metadata->keywords) {
      pdf_metadata.fKeywords = SkString(metadata->keywords);
    }
    if (metadata->creator) {
      pdf_metadata.fCreator = SkString(metadata->creator);
    }
    if (metadata->producer) {
      pdf_metadata.fProducer = SkString(metadata->producer);
    }
    if (metadata->raster_dpi > 0) {
      pdf_metadata.fRasterDPI = metadata->raster_dpi;
    }
    if (metadata->encoding_quality >= 0) {
      pdf_metadata.fEncodingQuality = metadata->encoding_quality;
    }
    pdf_metadata.fPDFA = metadata->pdfa;

    switch (metadata->compression_level) {
      case -1:
        pdf_metadata.fCompressionLevel =
            SkPDF::Metadata::CompressionLevel::Default;
        break;
      case 0:
        pdf_metadata.fCompressionLevel =
            SkPDF::Metadata::CompressionLevel::None;
        break;
      case 1:
        pdf_metadata.fCompressionLevel =
            SkPDF::Metadata::CompressionLevel::LowButFast;
        break;
      case 6:
        pdf_metadata.fCompressionLevel =
            SkPDF::Metadata::CompressionLevel::Average;
        break;
      case 9:
        pdf_metadata.fCompressionLevel =
            SkPDF::Metadata::CompressionLevel::HighButSlow;
        break;
      default:
        pdf_metadata.fCompressionLevel =
            SkPDF::Metadata::CompressionLevel::Default;
        break;
    }
  }

  pdf_metadata.jpegDecoder = SkPDF::JPEG::Decode;
  pdf_metadata.jpegEncoder = SkPDF::JPEG::Encode;

  auto doc = SkPDF::MakeDocument(w_stream, pdf_metadata);
  c_document->document = reinterpret_cast<skiac_document*>(doc.release());
  c_document->stream = reinterpret_cast<skiac_w_memory_stream*>(w_stream);
}

void skiac_document_destroy(skiac_pdf_document* c_document) {
  auto doc = reinterpret_cast<SkDocument*>(c_document->document);
  SkSafeUnref(doc);
  delete reinterpret_cast<SkDynamicMemoryWStream*>(c_document->stream);
}

skiac_canvas* skiac_document_begin_page(skiac_pdf_document* c_document,
                                        float width,
                                        float height,
                                        skiac_rect* content) {
  auto doc = reinterpret_cast<SkDocument*>(c_document->document);

  SkCanvas* canvas = nullptr;

  if (content) {
    auto rect = SkRect::MakeLTRB(content->left, content->top, content->right,
                                 content->bottom);
    canvas = doc->beginPage(width, height, &rect);
  } else {
    canvas = doc->beginPage(width, height);
  }

  if (canvas) {
    return reinterpret_cast<skiac_canvas*>(canvas);
  }
  return nullptr;
}

void skiac_document_end_page(skiac_pdf_document* c_document) {
  auto doc = reinterpret_cast<SkDocument*>(c_document->document);
  doc->endPage();
}

void skiac_document_close(skiac_pdf_document* c_document,
                          skiac_sk_data* output_data) {
  auto doc = reinterpret_cast<SkDocument*>(c_document->document);
  auto stream = reinterpret_cast<SkDynamicMemoryWStream*>(c_document->stream);
  doc->close();
  auto data = stream->detachAsData();
  auto raw_data = data.get();
  output_data->size = raw_data ? raw_data->size() : 0;
  output_data->ptr = raw_data ? raw_data->bytes() : nullptr;
  output_data->data = reinterpret_cast<skiac_data*>(data.release());
}

// SkAnnotation
void skiac_canvas_annotate_link_url(skiac_canvas* c_canvas,
                                    const skiac_rect* rect,
                                    const char* url) {
  if (!c_canvas || !rect || !url) {
    return;
  }
  auto canvas = CANVAS_CAST;
  SkRect sk_rect =
      SkRect::MakeLTRB(rect->left, rect->top, rect->right, rect->bottom);
  sk_sp<SkData> url_data = SkData::MakeWithCString(url);
  SkAnnotateRectWithURL(canvas, sk_rect, url_data.get());
}

void skiac_canvas_annotate_named_destination(skiac_canvas* c_canvas,
                                             float x,
                                             float y,
                                             const char* name) {
  if (!c_canvas || !name) {
    return;
  }
  auto canvas = CANVAS_CAST;
  SkPoint point = SkPoint::Make(x, y);
  sk_sp<SkData> name_data = SkData::MakeWithCString(name);
  SkAnnotateNamedDestination(canvas, point, name_data.get());
}

void skiac_canvas_annotate_link_to_destination(skiac_canvas* c_canvas,
                                               const skiac_rect* rect,
                                               const char* name) {
  if (!c_canvas || !rect || !name) {
    return;
  }
  auto canvas = CANVAS_CAST;
  SkRect sk_rect =
      SkRect::MakeLTRB(rect->left, rect->top, rect->right, rect->bottom);
  sk_sp<SkData> name_data = SkData::MakeWithCString(name);
  SkAnnotateLinkToDestination(canvas, sk_rect, name_data.get());
}

// Skottie (Lottie Animation)
struct skiac_skottie_animation_impl {
  sk_sp<skottie::Animation> animation;
  SkString version;
};

#define SKOTTIE_CAST \
  reinterpret_cast<skiac_skottie_animation_impl*>(c_animation)

skiac_skottie_animation* skiac_skottie_animation_make(
    const char* data,
    size_t length,
    const char* resource_path) {
  // Use kPreferEmbeddedFonts flag to prioritize embedded glyph paths over
  // system fonts This ensures Lottie files with embedded chars render correctly
  // without requiring the original fonts to be installed
  skottie::Animation::Builder builder(
      skottie::Animation::Builder::kPreferEmbeddedFonts);

  // Provide system font manager as fallback for any missing glyphs
  auto fontMgr = SkFontMgr_New_Custom_Directory(SK_FONT_FILE_PREFIX);
  builder.setFontManager(fontMgr);

  // Create base resource provider (file-based if path provided, otherwise null)
  sk_sp<skresources::ResourceProvider> baseProvider;
  if (resource_path && resource_path[0] != '\0') {
    baseProvider = skresources::FileResourceProvider::Make(
        SkString(resource_path), skresources::ImageDecodeStrategy::kLazyDecode);
  }

  // Wrap with DataURIResourceProviderProxy to support embedded base64 images
  builder.setResourceProvider(skresources::DataURIResourceProviderProxy::Make(
      std::move(baseProvider), skresources::ImageDecodeStrategy::kLazyDecode,
      fontMgr));

  auto animation = builder.make(data, length);
  if (!animation) {
    return nullptr;
  }

  auto impl = new skiac_skottie_animation_impl();
  impl->animation = std::move(animation);
  impl->version = impl->animation->version();
  return reinterpret_cast<skiac_skottie_animation*>(impl);
}

skiac_skottie_animation* skiac_skottie_animation_make_from_file(
    const char* path) {
  // Use kPreferEmbeddedFonts flag to prioritize embedded glyph paths over
  // system fonts
  skottie::Animation::Builder builder(
      skottie::Animation::Builder::kPreferEmbeddedFonts);

  // Provide system font manager as fallback for any missing glyphs
  auto fontMgr = SkFontMgr_New_Custom_Directory(SK_FONT_FILE_PREFIX);
  builder.setFontManager(fontMgr);

  // Extract directory from path for resource loading
  sk_sp<skresources::ResourceProvider> baseProvider;
  const char* last_slash = strrchr(path, '/');
  if (!last_slash) {
    last_slash = strrchr(path, '\\');
  }
  if (last_slash) {
    SkString dir(path, last_slash - path + 1);
    baseProvider = skresources::FileResourceProvider::Make(
        dir, skresources::ImageDecodeStrategy::kLazyDecode);
  }

  // Wrap with DataURIResourceProviderProxy to support embedded base64 images
  builder.setResourceProvider(skresources::DataURIResourceProviderProxy::Make(
      std::move(baseProvider), skresources::ImageDecodeStrategy::kLazyDecode,
      fontMgr));

  auto animation = builder.makeFromFile(path);
  if (!animation) {
    return nullptr;
  }

  auto impl = new skiac_skottie_animation_impl();
  impl->animation = std::move(animation);
  impl->version = impl->animation->version();
  return reinterpret_cast<skiac_skottie_animation*>(impl);
}

void skiac_skottie_animation_destroy(skiac_skottie_animation* c_animation) {
  if (c_animation) {
    delete SKOTTIE_CAST;
  }
}

double skiac_skottie_animation_get_duration(
    skiac_skottie_animation* c_animation) {
  if (!c_animation) {
    return 0.0;
  }
  return SKOTTIE_CAST->animation->duration();
}

double skiac_skottie_animation_get_fps(skiac_skottie_animation* c_animation) {
  if (!c_animation) {
    return 0.0;
  }
  return SKOTTIE_CAST->animation->fps();
}

double skiac_skottie_animation_get_in_point(
    skiac_skottie_animation* c_animation) {
  if (!c_animation) {
    return 0.0;
  }
  return SKOTTIE_CAST->animation->inPoint();
}

double skiac_skottie_animation_get_out_point(
    skiac_skottie_animation* c_animation) {
  if (!c_animation) {
    return 0.0;
  }
  return SKOTTIE_CAST->animation->outPoint();
}

void skiac_skottie_animation_get_size(skiac_skottie_animation* c_animation,
                                      float* width,
                                      float* height) {
  if (!c_animation || !width || !height) {
    return;
  }
  const auto& size = SKOTTIE_CAST->animation->size();
  *width = size.width();
  *height = size.height();
}

void skiac_skottie_animation_get_version(skiac_skottie_animation* c_animation,
                                         skiac_string* c_string) {
  if (!c_animation || !c_string) {
    return;
  }
  c_string->ptr = SKOTTIE_CAST->version.c_str();
  c_string->length = SKOTTIE_CAST->version.size();
  c_string->sk_string = nullptr;
}

void skiac_skottie_animation_seek(skiac_skottie_animation* c_animation,
                                  float t) {
  if (!c_animation) {
    return;
  }
  SKOTTIE_CAST->animation->seek(t);
}

void skiac_skottie_animation_seek_frame(skiac_skottie_animation* c_animation,
                                        double frame) {
  if (!c_animation) {
    return;
  }
  SKOTTIE_CAST->animation->seekFrame(frame);
}

void skiac_skottie_animation_seek_frame_time(
    skiac_skottie_animation* c_animation,
    double t) {
  if (!c_animation) {
    return;
  }
  SKOTTIE_CAST->animation->seekFrameTime(t);
}

void skiac_skottie_animation_render(skiac_skottie_animation* c_animation,
                                    skiac_canvas* c_canvas,
                                    const skiac_rect* dst) {
  if (!c_animation || !c_canvas) {
    return;
  }
  auto canvas = CANVAS_CAST;
  if (dst) {
    SkRect sk_rect =
        SkRect::MakeLTRB(dst->left, dst->top, dst->right, dst->bottom);
    SKOTTIE_CAST->animation->render(canvas, &sk_rect);
  } else {
    SKOTTIE_CAST->animation->render(canvas);
  }
}

void skiac_skottie_animation_render_with_flags(
    skiac_skottie_animation* c_animation,
    skiac_canvas* c_canvas,
    const skiac_rect* dst,
    uint32_t flags) {
  if (!c_animation || !c_canvas) {
    return;
  }
  auto canvas = CANVAS_CAST;
  if (dst) {
    SkRect sk_rect =
        SkRect::MakeLTRB(dst->left, dst->top, dst->right, dst->bottom);
    SKOTTIE_CAST->animation->render(
        canvas, &sk_rect, static_cast<skottie::Animation::RenderFlags>(flags));
  } else {
    SKOTTIE_CAST->animation->render(
        canvas, nullptr, static_cast<skottie::Animation::RenderFlags>(flags));
  }
}
}
