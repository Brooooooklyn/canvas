#include <assert.h>
#include <math.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <list>
#include <memory>
#include <optional>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#include <string.h>
#define strncasecmp _strnicmp
#else
#include <strings.h>
#endif

#include "skia_c.hpp"

// libskia is built with SK_RELEASE; a debug skia-c would see other class
// layouts in the shared Skia headers (see build.rs).
#if defined(SK_DEBUG) || !defined(SK_RELEASE)
#error "skia-c must be built with SK_RELEASE like libskia (see build.rs)"
#endif

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

// Blink's em box (SimpleFontData::TrySetNormalizedTypoAscentAndDescent): the
// ascent:descent ratio scaled to the font size, in LayoutUnits (1/64 px,
// rounded half away from zero).
static bool NormalizedEmHeight(float font_size,
                               float ascent,
                               float descent,
                               float* em_ascent,
                               float* em_descent) {
  const float height = ascent + descent;
  if (height <= 0 || ascent < 0 || ascent > height) {
    return false;
  }
  auto layout_unit = [](float value) { return roundf(value * 64) / 64; };
  *em_ascent = layout_unit(font_size * ascent / height);
  *em_descent = layout_unit(font_size) - *em_ascent;
  return true;
}

// Blink's SimpleFontData::NormalizedTypoAscentAndDescent: the OS/2
// sTypoAscender and sTypoDescender (offset 68) when the ascender is
// positive, else the font's ascent and descent.
static void EmHeight(const SkFont& font,
                     const SkFontMetrics& font_metrics,
                     float* em_ascent,
                     float* em_descent) {
  uint8_t os2[4];
  SkTypeface* typeface = font.getTypeface();
  if (typeface && typeface->getTableData(SkSetFourByteTag('O', 'S', '/', '2'),
                                         68, sizeof(os2), os2) == sizeof(os2)) {
    float typo_ascender = static_cast<int16_t>((os2[0] << 8) | os2[1]);
    float typo_descender = -static_cast<int16_t>((os2[2] << 8) | os2[3]);
    if (typo_ascender > 0 &&
        NormalizedEmHeight(font.getSize(), typo_ascender, typo_descender,
                           em_ascent, em_descent)) {
      return;
    }
  }
  if (NormalizedEmHeight(font.getSize(), -font_metrics.fAscent,
                         font_metrics.fDescent, em_ascent, em_descent)) {
    return;
  }
  *em_ascent = 0;
  *em_descent = 0;
}

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

// How Chrome samples an image it draws as it is, with no decode cache step (a
// canvas source): cc MatrixToScalingOperation (cc/paint/paint_op.cc:134-142)
// and PaintFlags::FilterQualityToSkSamplingOptions (cc/paint/paint_flags.cc:
// 178-207). 'high' is cubic only when both axes scale up, and 'medium' blends
// two mip levels.
static SkSamplingOptions CcSampling(int fq, const SkMatrix& matrix) {
  SkSize scale;
  const bool upscale =
      matrix.decomposeScale(&scale) && scale.width() > 1 && scale.height() > 1;
  switch (fq) {
    case 3:
      if (upscale) {
        return SkSamplingOptions(SkCubicResampler::Mitchell());
      }
      [[fallthrough]];
    case 2:
      return SkSamplingOptions(SkFilterMode::kLinear, SkMipmapMode::kLinear);
    case 1:
      return SkSamplingOptions(SkFilterMode::kLinear, SkMipmapMode::kNone);
    default:
      return SkSamplingOptions(SkFilterMode::kNearest, SkMipmapMode::kNone);
  }
}

// Chrome samples a pattern through cc PaintShader::GetSkShader, which maps the
// quality with ScalingOperation::kUnknown (cc/paint/paint_shader.cc and
// PaintFlags::FilterQualityToSkSamplingOptions in cc/paint/paint_flags.cc):
// 'medium' and 'high' are both linear with linear mipmaps, never cubic. A
// raster Image on a raster canvas takes the decode cache instead
// (skiac_image_make_decoded_pattern_shader). ImageData and SVG Image patterns,
// and Image patterns on PDF and SVG, still sample here, with one nearest mip
// level at 'medium' and 'high'.
static SkSamplingOptions PatternSamplingOptions(int fq, bool is_canvas) {
  switch (fq) {
    case 3:
    case 2:
      return SkSamplingOptions(
          SkFilterMode::kLinear,
          is_canvas ? SkMipmapMode::kLinear : SkMipmapMode::kNearest);
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

// The glyph outlines of a text blob drawn at (x, y), as SkSVGDevice draws text
// with kConvertTextToPaths_Flag (AddPath in src/svg/SkSVGDevice.cpp).
static SkPath TextBlobPath(const SkTextBlob* blob, SkScalar x, SkScalar y) {
  struct Rec {
    SkPathBuilder* path;
    SkPoint origin;
    const SkPoint* position;
  };
  sktext::GlyphRunBuilder builder;
  const auto& list = builder.blobToGlyphRunList(*blob, {x, y});
  SkPathBuilder path;
  for (const auto& run : list) {
    Rec rec{&path, list.origin(), run.positions().data()};
    run.font().getPaths(
        run.glyphsIDs(),
        [](const SkPath* glyph, const SkMatrix& mx, void* ctx) {
          auto rec = static_cast<Rec*>(ctx);
          if (glyph) {
            auto matrix = mx;
            matrix.postTranslate(rec->position->fX + rec->origin.fX,
                                 rec->position->fY + rec->origin.fY);
            rec->path->addPath(*glyph, matrix);
          }
          rec->position++;
        },
        &rec);
  }
  return path.detach();
}

// The canvas an SVGCanvas context draws into. It sits in front of the
// SkSVGCanvas and does two things with every call:
//
// - It sends the call to the SVG writer. SkSVGDevice drops the local matrix of
//   an image shader (addImageShaderResources in src/svg/SkSVGDevice.cpp never
//   writes a patternTransform), so a draw whose pattern has a non-identity
//   matrix is rewritten for it, see drawPatternForSvg. It has no conic
//   gradient either, so a conic gradient draw is rewritten as an image
//   pattern, see rasterizeSweep.
// - It records the call, so drawImage, createPattern and getImageData read the
//   SVGCanvas like a canvas source. The recording is drawn into the raster
//   surface only when the surface is read (skiac_svg_canvas_flush), or when it
//   grows past the PageRecorder cap (src/page_recorder.rs). Drawing an SVG that
//   is never read costs no rasterization.
//
// Deleting it finishes the SVG document: the SkSVGCanvas destructor writes the
// closing tags.
class SkiacSvgCanvas final : public SkNWayCanvas {
 public:
  SkiacSvgCanvas(int width,
                 int height,
                 std::unique_ptr<SkCanvas> svg,
                 sk_sp<SkSurface> raster)
      : SkNWayCanvas(width, height),
        fSvg(std::move(svg)),
        fRaster(std::move(raster)) {
    fLevels.emplace_back();
    this->addCanvas(fSvg.get());
    this->beginRecording();
  }

  ~SkiacSvgCanvas() override {
    this->removeAll();
    fSvg.reset();
  }

  // Draws the pending recording into the raster surface. A layer cannot be
  // split across two recordings, so this waits for its restore; reads never
  // happen inside a layer.
  void flush() {
    if (!fPendingDraws || fLayers > 0) {
      return;
    }
    auto picture = fRecorder.finishRecordingAsPicture();
    auto canvas = fRaster->getCanvas();
    const auto count = canvas->save();
    picture->playback(canvas);
    canvas->restoreToCount(count);
    this->beginRecording();
  }

 protected:
  void willSave() override {
    fLevels.back().matrix = this->getLocalToDevice();
    fLevels.emplace_back();
    INHERITED::willSave();
  }

  SaveLayerStrategy getSaveLayerStrategy(const SaveLayerRec& rec) override {
    fLevels.back().matrix = this->getLocalToDevice();
    fLevels.emplace_back().layer = true;
    fLayers++;
    return INHERITED::getSaveLayerStrategy(rec);
  }

  void willRestore() override {
    if (fLevels.back().layer) {
      fLayers--;
    }
    fLevels.pop_back();
    INHERITED::willRestore();
  }

  void didRestore() override { this->flushIfOverLimit(); }

  void onClipRect(const SkRect& rect,
                  SkClipOp op,
                  ClipEdgeStyle edge) override {
    auto& clip = this->addClip(edge);
    clip.rect = rect;
    clip.op = op;
    INHERITED::onClipRect(rect, op, edge);
  }

  void onClipRRect(const SkRRect& rrect,
                   SkClipOp op,
                   ClipEdgeStyle edge) override {
    auto& clip = this->addClip(edge);
    clip.kind = Clip::Kind::kRRect;
    clip.rrect = rrect;
    clip.op = op;
    INHERITED::onClipRRect(rrect, op, edge);
  }

  void onClipPath(const SkPath& path,
                  SkClipOp op,
                  ClipEdgeStyle edge) override {
    auto& clip = this->addClip(edge);
    clip.kind = Clip::Kind::kPath;
    clip.path = path;
    clip.op = op;
    INHERITED::onClipPath(path, op, edge);
  }

  void onClipShader(sk_sp<SkShader> shader, SkClipOp op) override {
    auto& clip = this->addClip(kHard_ClipEdgeStyle);
    clip.kind = Clip::Kind::kShader;
    clip.shader = shader;
    clip.op = op;
    INHERITED::onClipShader(std::move(shader), op);
  }

  void onClipRegion(const SkRegion& region, SkClipOp op) override {
    auto& clip = this->addClip(kHard_ClipEdgeStyle);
    clip.kind = Clip::Kind::kRegion;
    clip.region = region;
    clip.op = op;
    INHERITED::onClipRegion(region, op);
  }

  void onDrawPaint(const SkPaint& paint) override {
    if (NeedsSvgRewrite(paint)) {
      fRecording->drawPaint(paint);
      this->drawForSvg(SkPath::Rect(this->getLocalClipBounds()), paint);
    } else {
      INHERITED::onDrawPaint(paint);
    }
    this->didDraw(0, &paint);
  }

  void onDrawPoints(PointMode mode,
                    size_t count,
                    const SkPoint pts[],
                    const SkPaint& paint) override {
    if (NeedsSvgRewrite(paint)) {
      fRecording->drawPoints(mode, {pts, count}, paint);
      // As SkSVGDevice::drawPoints builds its path.
      SkPathBuilder path;
      for (size_t i = 0; i < count; i++) {
        if (mode == kPoints_PointMode) {
          path.moveTo(pts[i]);
          path.lineTo(pts[i]);
        } else if (mode == kLines_PointMode && i % 2 == 1) {
          path.moveTo(pts[i - 1]);
          path.lineTo(pts[i]);
        }
      }
      if (mode == kPolygon_PointMode && count > 1) {
        path.addPolygon({pts, count}, false);
      }
      this->drawForSvg(path.detach(), paint);
    } else {
      INHERITED::onDrawPoints(mode, count, pts, paint);
    }
    this->didDraw(count * sizeof(SkPoint), &paint);
  }

  void onDrawRect(const SkRect& rect, const SkPaint& paint) override {
    if (NeedsSvgRewrite(paint)) {
      fRecording->drawRect(rect, paint);
      this->drawForSvg(SkPath::Rect(rect), paint);
    } else {
      INHERITED::onDrawRect(rect, paint);
    }
    this->didDraw(0, &paint);
  }

  void onDrawOval(const SkRect& rect, const SkPaint& paint) override {
    if (NeedsSvgRewrite(paint)) {
      fRecording->drawOval(rect, paint);
      this->drawForSvg(SkPath::Oval(rect), paint);
    } else {
      INHERITED::onDrawOval(rect, paint);
    }
    this->didDraw(0, &paint);
  }

  void onDrawRRect(const SkRRect& rrect, const SkPaint& paint) override {
    if (NeedsSvgRewrite(paint)) {
      fRecording->drawRRect(rrect, paint);
      this->drawForSvg(SkPath::RRect(rrect), paint);
    } else {
      INHERITED::onDrawRRect(rrect, paint);
    }
    this->didDraw(0, &paint);
  }

  void onDrawPath(const SkPath& path, const SkPaint& paint) override {
    if (NeedsSvgRewrite(paint)) {
      fRecording->drawPath(path, paint);
      this->drawForSvg(path, paint);
    } else {
      INHERITED::onDrawPath(path, paint);
    }
    this->didDraw(path.approximateBytesUsed(), &paint);
  }

  void onDrawTextBlob(const SkTextBlob* blob,
                      SkScalar x,
                      SkScalar y,
                      const SkPaint& paint) override {
    if (NeedsSvgRewrite(paint)) {
      fRecording->drawTextBlob(blob, x, y, paint);
      // The glyph outlines, so they can be drawn in the pattern's space.
      this->drawForSvg(TextBlobPath(blob, x, y), paint);
    } else {
      INHERITED::onDrawTextBlob(blob, x, y, paint);
    }
    this->didDraw(0, &paint);
  }

  // Played back through this canvas, so the SVG output rewrites the pattern
  // paints inside the picture too (a composited draw records its paint into
  // one). SkCanvas::onDrawPicture is what SkSVGCanvas itself does with it.
  void onDrawPicture(const SkPicture* picture,
                     const SkMatrix* matrix,
                     const SkPaint* paint) override {
    SkCanvas::onDrawPicture(picture, matrix, paint);
  }

  void onDrawRegion(const SkRegion& region, const SkPaint& paint) override {
    INHERITED::onDrawRegion(region, paint);
    this->didDraw(0, &paint);
  }

  void onDrawArc(const SkRect& rect,
                 SkScalar start,
                 SkScalar sweep,
                 bool use_center,
                 const SkPaint& paint) override {
    INHERITED::onDrawArc(rect, start, sweep, use_center, paint);
    this->didDraw(0, &paint);
  }

  void onDrawDRRect(const SkRRect& outer,
                    const SkRRect& inner,
                    const SkPaint& paint) override {
    INHERITED::onDrawDRRect(outer, inner, paint);
    this->didDraw(0, &paint);
  }

  void onDrawBehind(const SkPaint& paint) override {
    INHERITED::onDrawBehind(paint);
    this->didDraw(0, &paint);
  }

  void onDrawImage2(const SkImage* image,
                    SkScalar left,
                    SkScalar top,
                    const SkSamplingOptions& sampling,
                    const SkPaint* paint) override {
    INHERITED::onDrawImage2(image, left, top, sampling, paint);
    this->didDraw(this->imageBytes(image), paint);
  }

  void onDrawImageRect2(const SkImage* image,
                        const SkRect& src,
                        const SkRect& dst,
                        const SkSamplingOptions& sampling,
                        const SkPaint* paint,
                        SrcRectConstraint constraint) override {
    INHERITED::onDrawImageRect2(image, src, dst, sampling, paint, constraint);
    this->didDraw(this->imageBytes(image), paint);
  }

  void onDrawImageLattice2(const SkImage* image,
                           const Lattice& lattice,
                           const SkRect& dst,
                           SkFilterMode filter,
                           const SkPaint* paint) override {
    INHERITED::onDrawImageLattice2(image, lattice, dst, filter, paint);
    this->didDraw(this->imageBytes(image), paint);
  }

  void onDrawAtlas2(const SkImage* image,
                    const SkRSXform xform[],
                    const SkRect tex[],
                    const SkColor colors[],
                    int count,
                    SkBlendMode mode,
                    const SkSamplingOptions& sampling,
                    const SkRect* cull,
                    const SkPaint* paint) override {
    INHERITED::onDrawAtlas2(image, xform, tex, colors, count, mode, sampling,
                            cull, paint);
    this->didDraw(this->imageBytes(image), paint);
  }

  void onDrawEdgeAAImageSet2(const ImageSetEntry set[],
                             int count,
                             const SkPoint clips[],
                             const SkMatrix matrices[],
                             const SkSamplingOptions& sampling,
                             const SkPaint* paint,
                             SrcRectConstraint constraint) override {
    INHERITED::onDrawEdgeAAImageSet2(set, count, clips, matrices, sampling,
                                     paint, constraint);
    size_t bytes = 0;
    for (int i = 0; i < count; i++) {
      bytes += this->imageBytes(set[i].fImage.get());
    }
    this->didDraw(bytes, paint);
  }

  void onDrawGlyphRunList(const sktext::GlyphRunList& list,
                          const SkPaint& paint) override {
    INHERITED::onDrawGlyphRunList(list, paint);
    this->didDraw(0, &paint);
  }

  void onDrawSlug(const sktext::gpu::Slug* slug,
                  const SkPaint& paint) override {
    INHERITED::onDrawSlug(slug, paint);
    this->didDraw(0, &paint);
  }

  void onDrawPatch(const SkPoint cubics[12],
                   const SkColor colors[4],
                   const SkPoint tex[4],
                   SkBlendMode mode,
                   const SkPaint& paint) override {
    INHERITED::onDrawPatch(cubics, colors, tex, mode, paint);
    this->didDraw(0, &paint);
  }

  void onDrawVerticesObject(const SkVertices* vertices,
                            SkBlendMode mode,
                            const SkPaint& paint) override {
    INHERITED::onDrawVerticesObject(vertices, mode, paint);
    this->didDraw(vertices->approximateSize(), &paint);
  }

  void onDrawMesh(const SkMesh& mesh,
                  sk_sp<SkBlender> blender,
                  const SkPaint& paint) override {
    INHERITED::onDrawMesh(mesh, std::move(blender), paint);
    this->didDraw(0, &paint);
  }

  void onDrawShadowRec(const SkPath& path,
                       const SkDrawShadowRec& rec) override {
    INHERITED::onDrawShadowRec(path, rec);
    this->didDraw(path.approximateBytesUsed(), nullptr);
  }

  void onDrawDrawable(SkDrawable* drawable, const SkMatrix* matrix) override {
    INHERITED::onDrawDrawable(drawable, matrix);
    this->didDraw(drawable->approximateBytesUsed(), nullptr);
  }

  void onDrawEdgeAAQuad(const SkRect& rect,
                        const SkPoint clip[4],
                        QuadAAFlags aa,
                        const SkColor4f& color,
                        SkBlendMode mode) override {
    INHERITED::onDrawEdgeAAQuad(rect, clip, aa, color, mode);
    this->didDraw(0, nullptr);
  }

 private:
  using INHERITED = SkNWayCanvas;

  // Recorded-byte cap after which the recording is drawn into the raster
  // surface: MAX_RECORDED_BYTES and BYTES_PER_RECORDED_OP in
  // src/page_recorder.rs.
  static constexpr size_t kMaxRecordedBytes = 32 * 1024 * 1024;
  static constexpr size_t kBytesPerRecordedOp = 256;

  struct Clip {
    enum class Kind { kRect, kRRect, kPath, kShader, kRegion };
    Kind kind = Kind::kRect;
    SkM44 matrix;
    SkRect rect;
    SkRRect rrect;
    SkPath path;
    sk_sp<SkShader> shader;
    SkRegion region;
    SkClipOp op = SkClipOp::kIntersect;
    bool aa = false;
  };

  // One save level: its clips, each with the matrix it was made under, and the
  // matrix a restore to this level gives back.
  struct Level {
    std::vector<Clip> clips;
    SkM44 matrix;
    bool layer = false;
  };

  // A pattern whose matrix SkSVGDevice would drop.
  static bool HasPatternMatrix(const SkPaint& paint) {
    SkMatrix matrix;
    auto shader = paint.getShader();
    return shader && shader->isAImage(&matrix, nullptr) && !matrix.isIdentity();
  }

  // A conic gradient: SkSVGDevice writes only linear, radial and two-point
  // conical gradients (addGradientShaderResources) and fills anything else
  // with the paint color, black.
  static bool IsSweepGradient(const SkPaint& paint) {
    auto shader = paint.getShader();
    return shader &&
           as_SB(shader)->asGradient() == SkShaderBase::GradientType::kSweep;
  }

  static bool NeedsSvgRewrite(const SkPaint& paint) {
    return HasPatternMatrix(paint) || IsSweepGradient(paint);
  }

  // The SVG half of a draw SkSVGDevice cannot write as it is.
  void drawForSvg(const SkPath& path, const SkPaint& paint) {
    if (!IsSweepGradient(paint)) {
      this->drawPatternForSvg(path, paint);
      return;
    }
    SkPaint image_paint;
    SkRect image_clip;
    if (this->rasterizeSweep(path, paint, &image_paint, &image_clip)) {
      this->drawPatternForSvg(path, image_paint, &image_clip);
    }
  }

  // The most pixels a conic raster image has, its border included: 4096 *
  // 4096, a 64 MiB N32 image. Past it, an image pixel covers k x k device
  // pixels.
  static constexpr int64_t kMaxSweepPixels = 4096 * 4096;

  // The longest side of a conic raster image, its border included. Skia
  // encodes it as a PNG with libpng, whose default user limits reject a wider
  // or higher image (PNG_USER_WIDTH_MAX and PNG_USER_HEIGHT_MAX in
  // third_party/externals/libpng/scripts/pnglibconf.h.prebuilt); SkSVGDevice
  // then writes no pattern and fills the path with the paint color, black.
  static constexpr int64_t kMaxSweepSide = 1000000;

  // The largest pattern tile Chrome draws at one pixel per device pixel. It
  // draws an SVG pattern through an SkPictureShader (cc/paint/paint_shader.cc),
  // which rasterizes a larger tile at 2048 * 2048 pixels and scales that up
  // (kMaxTileArea, src/shaders/SkPictureShader.cpp).
  static constexpr int64_t kMaxExactTilePixels = 2048 * 2048;

  // Where a conic raster image lies: it covers the device rect `cover` in
  // image pixels of kx x ky device pixels, `width` x `height` of them, inside a
  // border of `border` image pixels on each side.
  struct SweepGrid {
    SkIRect cover;
    int64_t kx;
    int64_t ky;
    int64_t width;
    int64_t height;
    int border;
  };

  // The grid of `device` at k device pixels per image pixel (no more than a
  // side). At one image pixel per device pixel, the image, border included,
  // starts at a multiple of 8: Skia dithers with an 8x8 pattern placed by the
  // device position, so the image dithers like the raster canvas.
  //
  // No image side is 1 pixel: SkImageShader tiles a 1 pixel side with clamp,
  // not repeat (optimize, src/shaders/SkImageShader.cpp), and SkSVGDevice
  // writes a clamp side as a viewport ("100%") tile. A border makes a side at
  // least 3 pixels; without one, a 1 pixel side (a clip strip) gets a second
  // pixel of the gradient, outside the clip. Such a side starts at a multiple
  // of 8, so adding 2 does not overflow.
  static SweepGrid MakeSweepGrid(const SkIRect& device, int64_t k, int border) {
    SweepGrid grid;
    grid.cover = device;
    if (k == 1) {
      grid.cover.fLeft = ((device.fLeft - border) & ~7) + border;
      grid.cover.fTop = ((device.fTop - border) & ~7) + border;
      if (border == 0 && grid.cover.width64() == 1) {
        grid.cover.fRight = grid.cover.fLeft + 2;
      }
      if (border == 0 && grid.cover.height64() == 1) {
        grid.cover.fBottom = grid.cover.fTop + 2;
      }
    }
    grid.kx = std::min(k, grid.cover.width64());
    grid.ky = std::min(k, grid.cover.height64());
    grid.width = (grid.cover.width64() + grid.kx - 1) / grid.kx;
    grid.height = (grid.cover.height64() + grid.ky - 1) / grid.ky;
    grid.border = border;
    return grid;
  }

  // Whether the image of `grid`, border included, fits kMaxSweepPixels and
  // kMaxSweepSide.
  static bool SweepGridFits(const SweepGrid& grid) {
    const int64_t width = grid.width + 2 * grid.border;
    const int64_t height = grid.height + 2 * grid.border;
    return width <= kMaxSweepSide && height <= kMaxSweepSide &&
           width * height <= kMaxSweepPixels;
  }

  // `paint` with its conic gradient replaced by an image of what the raster
  // canvas paints with it, globalAlpha included, over the device bounds of the
  // draw inside the clip: one image pixel per device pixel, or k x k device
  // pixels per image pixel for bounds that do not fit kMaxSweepPixels or
  // kMaxSweepSide. The image is the pattern tile (repeat, and no side of 1
  // pixel, see MakeSweepGrid), not the viewport (a "100%" decal tile): in
  // Chrome the transparent rest of a viewport tile larger than
  // kMaxExactTilePixels faded the image's edges. An image Chrome does not
  // draw exactly (larger than kMaxExactTilePixels, or scaled) has a border of
  // 1 image pixel of the same gradient, so that resampling it does not mix
  // its edges with the other side of the tile. The image's matrix maps
  // its pixels back to local space, and `clip` is the part of the image inside
  // the border. False: nothing to draw (nothing visible, a singular matrix or
  // no memory for the image).
  bool rasterizeSweep(const SkPath& path,
                      const SkPaint& paint,
                      SkPaint* out,
                      SkRect* clip) {
    const SkMatrix ctm = this->getTotalMatrix();
    SkMatrix inverse;
    if (!ctm.invert(&inverse)) {
      return false;
    }
    // A stroke's outline, or the path of a fill or a hairline.
    SkRect local = path.getBounds();
    if (paint.getStyle() != SkPaint::kFill_Style || paint.getPathEffect()) {
      SkPathBuilder builder;
      if (skpathutils::FillPathWithPaint(path, paint, &builder, nullptr, ctm)) {
        local = builder.computeBounds();
      }
    }
    // One more pixel on each side for the antialiased edges.
    SkIRect device = ctm.mapRect(local).roundOut().makeOutset(1, 1);
    if (!device.intersect(this->getDeviceClipBounds())) {
      return false;
    }
    SweepGrid grid = MakeSweepGrid(device, 1, 0);
    if (grid.width * grid.height > kMaxExactTilePixels ||
        !SweepGridFits(grid)) {
      // The smallest whole k that fits: SkSVGDevice writes the element
      // transform with 6 significant digits (svg_transform), which only a
      // whole k keeps exact. The SVG renderer scales the image back up,
      // bilinear in Chrome. No k below the square root of the area ratio or
      // below the longest side over kMaxSweepSide fits; both are rounded down
      // so that rounding noise cannot skip the smallest k.
      const int64_t w = device.width64();
      const int64_t h = device.height64();
      int64_t k = std::max<int64_t>({1,
                                     static_cast<int64_t>(std::sqrt(
                                         static_cast<double>(w * h) /
                                         static_cast<double>(kMaxSweepPixels))),
                                     std::max(w, h) / kMaxSweepSide});
      grid = MakeSweepGrid(device, k, 1);
      while (!SweepGridFits(grid)) {
        grid = MakeSweepGrid(device, ++k, 1);
      }
    }
    const int border = grid.border;
    auto surface = SkSurfaces::Raster(SkImageInfo::MakeN32Premul(
        static_cast<int>(grid.width + 2 * border),
        static_cast<int>(grid.height + 2 * border), SkColorSpace::MakeSRGB()));
    if (!surface) {
      return false;
    }
    auto canvas = surface->getCanvas();
    canvas->translate(border, border);
    canvas->scale(1.0f / grid.kx, 1.0f / grid.ky);
    canvas->translate(-grid.cover.fLeft, -grid.cover.fTop);
    canvas->concat(ctm);
    SkPaint fill;
    fill.setShader(paint.refShader());
    fill.setAlphaf(paint.getAlphaf());
    fill.setDither(paint.isDither());
    fill.setBlendMode(SkBlendMode::kSrc);
    canvas->drawPaint(fill);
    SkMatrix matrix = inverse;
    matrix.preTranslate(grid.cover.fLeft, grid.cover.fTop);
    matrix.preScale(grid.kx, grid.ky);
    matrix.preTranslate(-border, -border);
    *clip = SkRect::MakeXYWH(border, border, grid.width, grid.height);
    *out = paint;
    // The alpha is in the image.
    out->setAlphaf(1);
    out->setShader(surface->makeImageSnapshot()->makeShader(
        SkTileMode::kRepeat, SkTileMode::kRepeat, SkSamplingOptions(),
        &matrix));
    return true;
  }

  Clip& addClip(ClipEdgeStyle edge) {
    auto& clip = fLevels.back().clips.emplace_back();
    clip.matrix = this->getLocalToDevice();
    clip.aa = edge == kSoft_ClipEdgeStyle;
    return clip;
  }

  // Starts a recording in the current state: every level's clips under the
  // matrices they were made with, and the matrix each restore gives back.
  void beginRecording() {
    if (fRecording) {
      this->removeCanvas(fRecording);
    }
    const auto size = this->getBaseLayerSize();
    fRecording = fRecorder.beginRecording(SkRect::Make(size));
    for (size_t i = 0; i < fLevels.size(); i++) {
      for (const auto& clip : fLevels[i].clips) {
        fRecording->setMatrix(clip.matrix);
        switch (clip.kind) {
          case Clip::Kind::kRect:
            fRecording->clipRect(clip.rect, clip.op, clip.aa);
            break;
          case Clip::Kind::kRRect:
            fRecording->clipRRect(clip.rrect, clip.op, clip.aa);
            break;
          case Clip::Kind::kPath:
            fRecording->clipPath(clip.path, clip.op, clip.aa);
            break;
          case Clip::Kind::kShader:
            fRecording->clipShader(clip.shader, clip.op);
            break;
          case Clip::Kind::kRegion:
            fRecording->clipRegion(clip.region, clip.op);
            break;
        }
      }
      if (i + 1 < fLevels.size()) {
        fRecording->setMatrix(fLevels[i].matrix);
        fRecording->save();
      }
    }
    fRecording->setMatrix(this->getLocalToDevice());
    this->addCanvas(fRecording);
    fPendingDraws = false;
    fPendingBytes = 0;
    fRecordedImages.clear();
  }

  // Bytes of an image the recording pins, once per image per recording.
  size_t imageBytes(const SkImage* image) {
    if (!image || !fRecordedImages.insert(image->uniqueID()).second) {
      return 0;
    }
    return image->imageInfo().computeMinByteSize();
  }

  // A recorded op pins `bytes`, and the image its paint samples (a pattern)
  // like the image of a drawImage.
  void didDraw(size_t bytes, const SkPaint* paint) {
    if (paint && paint->getShader()) {
      bytes += this->imageBytes(paint->getShader()->isAImage(nullptr, nullptr));
    }
    fPendingDraws = true;
    fPendingBytes += kBytesPerRecordedOp + bytes;
    this->flushIfOverLimit();
  }

  void flushIfOverLimit() {
    if (fPendingBytes >= kMaxRecordedBytes) {
      this->flush();
    }
  }

  // The SVG half of a draw whose pattern has the matrix M. SVG resolves a
  // userSpaceOnUse pattern in the user space of the element that uses it, so
  // the element is drawn under CTM * M, with its geometry mapped back by M^-1
  // and a pattern with no matrix. A stroke is turned into its fill first, so M
  // does not scale it. A no-repeat axis is clipped to the image, because
  // SkSVGDevice writes a "100%" tile for it. `image_clip`: a rasterized conic
  // gradient, which already covers the draw and its antialiased edges in whole
  // device pixels; it is clipped to that rect of the image only (the image
  // without its border, whatever the tile mode), since a clip at the geometry
  // bounds would antialias those edges a second time.
  void drawPatternForSvg(const SkPath& path,
                         const SkPaint& paint,
                         const SkRect* image_clip = nullptr) {
    SkMatrix matrix;
    SkTileMode tile[2];
    auto image = paint.getShader()->isAImage(&matrix, tile);
    SkMatrix inverse;
    if (!matrix.invert(&inverse)) {
      // A singular pattern matrix paints transparent black (HTML spec,
      // CanvasPattern setTransform), so there is nothing to write.
      return;
    }
    SkPaint fill(paint);
    SkPath geometry = path;
    if (paint.getStyle() != SkPaint::kFill_Style || paint.getPathEffect()) {
      SkPathBuilder builder;
      if (skpathutils::FillPathWithPaint(path, paint, &builder, nullptr,
                                         this->getTotalMatrix())) {
        fill.setStyle(SkPaint::kFill_Style);
      } else {
        fill.setStyle(SkPaint::kStroke_Style);
        fill.setStrokeWidth(0);
      }
      fill.setPathEffect(nullptr);
      geometry = builder.detach();
    }
    geometry = geometry.makeTransform(inverse);
    const bool decal =
        tile[0] == SkTileMode::kDecal || tile[1] == SkTileMode::kDecal;
    const bool clip = decal || image_clip;
    auto bounds = geometry.getBounds();
    if (image_clip) {
      bounds = *image_clip;
    }
    if (tile[0] == SkTileMode::kDecal) {
      bounds.fLeft = std::max(bounds.fLeft, 0.0f);
      bounds.fRight = std::min(bounds.fRight, (float)image->width());
    }
    if (tile[1] == SkTileMode::kDecal) {
      bounds.fTop = std::max(bounds.fTop, 0.0f);
      bounds.fBottom = std::min(bounds.fBottom, (float)image->height());
    }
    if (clip && bounds.isEmpty()) {
      return;
    }
    fill.setShader(
        sk_ref_sp(image)->makeShader(tile[0], tile[1], SkSamplingOptions()));
    fSvg->save();
    fSvg->concat(matrix);
    if (clip) {
      fSvg->clipRect(bounds, paint.isAntiAlias());
    }
    fSvg->drawPath(geometry, fill);
    fSvg->restore();
  }

  std::unique_ptr<SkCanvas> fSvg;
  sk_sp<SkSurface> fRaster;
  SkPictureRecorder fRecorder;
  SkCanvas* fRecording = nullptr;
  std::vector<Level> fLevels;
  int fLayers = 0;
  bool fPendingDraws = false;
  size_t fPendingBytes = 0;
  std::unordered_set<uint32_t> fRecordedImages;
};

void skiac_surface_create_svg(skiac_svg_surface* c_surface,
                              int w,
                              int h,
                              int alphaType,
                              uint32_t flag,
                              uint8_t cs) {
  auto w_stream = new SkDynamicMemoryWStream();

  auto canvas = SkSVGCanvas::Make(SkRect::MakeWH(w, h), w_stream, flag);
  if (!canvas.get()) {
    delete w_stream;
    return;
  }
  // A raster cannot be 0 wide or high: a canvas with a 0 side has no pixels,
  // and its raster is a stand-in that nothing reads (Context::new_svg).
  auto surface = skiac_surface_create(std::max(w, 1), std::max(h, 1),
                                      (SkAlphaType)alphaType, cs);
  if (!surface) {
    canvas.reset();
    delete w_stream;
    return;
  }
  c_surface->stream = reinterpret_cast<skiac_w_memory_stream*>(w_stream);
  c_surface->surface = reinterpret_cast<skiac_surface*>(surface);
  c_surface->canvas = reinterpret_cast<skiac_canvas*>(
      new SkiacSvgCanvas(w, h, std::move(canvas), sk_ref_sp(surface)));
}

// Draws what an SVGCanvas context recorded into its raster surface, before the
// surface is read. `c_canvas` is the canvas skiac_surface_create_svg made.
void skiac_svg_canvas_flush(skiac_canvas* c_canvas) {
  static_cast<SkiacSvgCanvas*>(CANVAS_CAST)->flush();
}

skiac_surface* skiac_surface_create_rgba_premultiplied(int width,
                                                       int height,
                                                       uint8_t cs) {
  return reinterpret_cast<skiac_surface*>(
      skiac_surface_create(width, height, kPremul_SkAlphaType, cs));
}

// alpha:false backing store. Blink gives such a canvas a kOpaque resource
// (canvas_2d_color_params.h GetAlphaType, canvas_resource_provider.cc
// CreateSkSurface), so putImageData and getImageData copy the bytes as given.
skiac_surface* skiac_surface_create_rgba_opaque(int width,
                                                int height,
                                                uint8_t cs) {
  return reinterpret_cast<skiac_surface*>(
      skiac_surface_create(width, height, kOpaque_SkAlphaType, cs));
}

skiac_surface* skiac_surface_create_rgba(int width, int height, uint8_t cs) {
  return reinterpret_cast<skiac_surface*>(
      skiac_surface_create(width, height, kUnpremul_SkAlphaType, cs));
}

// Blink encodes canvas output from a kUnpremul readback (image_data_buffer.cc),
// which is a plain copy for a kOpaque canvas, so an alpha:false canvas still
// encodes as RGBA with its stored alpha. Skia's PNG encoder would write RGB for
// a kOpaque image. The view shares the pixels: `image` must outlive it.
static sk_sp<SkImage> encodable_image(SkImage* image) {
  SkPixmap pixmap;
  if (image->alphaType() != kOpaque_SkAlphaType ||
      !image->peekPixels(&pixmap)) {
    return sk_ref_sp(image);
  }
  return SkImages::RasterFromPixmap(
      SkPixmap(pixmap.info().makeAlphaType(kUnpremul_SkAlphaType),
               pixmap.addr(), pixmap.rowBytes()),
      nullptr, nullptr);
}

// Blink's JPEG encoder blends its kUnpremul readback on black
// (image_encoder.cc:51). Skia applies it to kUnpremul input only
// (SkJpegEncoderImpl.cpp), which here is the view of an alpha:false canvas
// (encodable_image); premultiplied pixels encode as before.
static constexpr auto kJpegAlphaOption =
    SkJpegEncoder::AlphaOption::kBlendOnBlack;

bool skiac_surface_save(skiac_surface* c_surface, const char* path) {
  auto snapshot = SURFACE_CAST->makeImageSnapshot();
  auto image = encodable_image(snapshot.get());
  auto data =
      SkPngEncoder::Encode(nullptr, image.get(), SkPngEncoder::Options());
  if (data) {
    SkFILEWStream stream(path);
    if (stream.write(data->data(), data->size())) {
      stream.flush();
      return true;
    }
  }

  return false;
}

void skiac_surface_ref(skiac_surface* c_surface) {
  // SkSurface is ref counted.
  if (c_surface) {
    SURFACE_CAST->ref();
  }
}

void skiac_surface_destroy(skiac_surface* c_surface) {
  // SkSurface is ref counted.
  if (c_surface) {
    SURFACE_CAST->unref();
  }
}

skiac_surface* skiac_surface_copy_rgba(skiac_surface* c_surface,
                                       uint32_t x,
                                       uint32_t y,
                                       uint32_t width,
                                       uint32_t height,
                                       uint8_t cs) {
  // x, y, width, height are source rectangle coordinates.
  // Premultiplied like the source canvas: pattern shaders filter the stored
  // texels, and unpremul texels would pull transparent black into the color.
  // An alpha:false source stays kOpaque, like Blink's snapshot of it.
  auto alpha_type = SURFACE_CAST->imageInfo().alphaType() == kOpaque_SkAlphaType
                        ? kOpaque_SkAlphaType
                        : kPremul_SkAlphaType;
  auto copy = skiac_surface_create((int)width, (int)height, alpha_type, cs);
  if (!copy) {
    return nullptr;
  }

  SkPaint paint;
  paint.setAlpha(SK_AlphaOPAQUE);

  const auto sampling = SkSamplingOptions(SkFilterMode::kNearest);
  // integer-coordinate snapshots copy texels without filtering their neighbors
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

bool skiac_surface_peek_premul_rgba(skiac_surface* c_surface,
                                    skiac_peek_pixels* peek) {
  SkPixmap pixmap;
  if (!SURFACE_CAST->peekPixels(&pixmap) ||
      pixmap.info().colorType() != SkColorType::kRGBA_8888_SkColorType ||
      pixmap.info().alphaType() != SkAlphaType::kPremul_SkAlphaType) {
    return false;
  }
  uint8_t cs;
  if (SkColorSpace::Equals(pixmap.info().colorSpace(),
                           SkColorSpace::MakeSRGB().get())) {
    cs = 0;
  } else if (SkColorSpace::Equals(
                 pixmap.info().colorSpace(),
                 SkColorSpace::MakeRGB(SkNamedTransferFn::kSRGB,
                                       SkNamedGamut::kDisplayP3)
                     .get())) {
    cs = 1;
  } else {
    return false;
  }
  peek->ptr = static_cast<const uint8_t*>(pixmap.addr());
  peek->row_bytes = pixmap.rowBytes();
  peek->width = pixmap.width();
  peek->height = pixmap.height();
  peek->color_space = cs;
  return true;
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
  // size_t math: w * 4 would overflow int for very wide requests.
  auto result = SURFACE_CAST->readPixels(image_info, data, (size_t)w * 4, x, y);
  return result;
}

void skiac_surface_png_data(skiac_surface* c_surface, skiac_sk_data* data) {
  auto snapshot = SURFACE_CAST->makeImageSnapshot();
  auto image = encodable_image(snapshot.get());
  auto png_data =
      SkPngEncoder::Encode(nullptr, image.get(), SkPngEncoder::Options());
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
  auto snapshot = SURFACE_CAST->makeImageSnapshot();
  auto image_ref = encodable_image(snapshot.get());
  auto image = image_ref.get();
  sk_sp<SkData> encoded_data;
  if (format == int(SkEncodedImageFormat::kJPEG)) {
    SkJpegEncoder::Options options;
    options.fQuality = quality;
    options.fAlphaOption = kJpegAlphaOption;
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
  SkPixmap sk_pixmap;
  if (!SURFACE_CAST->peekPixels(&sk_pixmap)) {
    return false;
  }
  // alpha:false: encode RGBA with the stored alpha, see encodable_image.
  if (sk_pixmap.alphaType() == kOpaque_SkAlphaType) {
    sk_pixmap = SkPixmap(sk_pixmap.info().makeAlphaType(kUnpremul_SkAlphaType),
                         sk_pixmap.addr(), sk_pixmap.rowBytes());
  }
  SkJavaScriptWStream stream(write_callback, context);
  std::unique_ptr<SkEncoder> encoder;
  if (format == int(SkEncodedImageFormat::kJPEG)) {
    SkJpegEncoder::Options options;
    options.fQuality = quality;
    options.fAlphaOption = kJpegAlphaOption;
    encoder = SkJpegEncoder::Make(&stream, sk_pixmap, options);
  } else if (format == int(SkEncodedImageFormat::kPNG)) {
    encoder = SkPngEncoder::Make(&stream, sk_pixmap, SkPngEncoder::Options());
  } else if (format == int(SkEncodedImageFormat::kWEBP)) {
    SkWebpEncoder::Options options;
    options.fCompression = quality == 100
                               ? SkWebpEncoder::Compression::kLossless
                               : SkWebpEncoder::Compression::kLossy;
    options.fQuality = quality == 100 ? 75 : quality;
    return SkWebpEncoder::Encode(&stream, sk_pixmap, options);
  }
  if (encoder) {
    return encoder->encodeRows(sk_pixmap.height());
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

// Blink Canvas2DRecorderContext::ShouldDrawImageAntialiased
// (canvas_2d_recorder_context.cc:2071-2101): drawImage turns AA on only when
// the CTM does not keep rects axis-aligned, or when the destination is under
// one device pixel on either axis. The sizes are gfx::RectF ones.
static bool ShouldDrawImageAntialiased(const SkMatrix& ctm,
                                       float dst_width,
                                       float dst_height) {
  if (!ctm.rectStaysRect()) {
    return true;
  }
  // rectStaysRect: either scale and no skew, or skew and no scale.
  SkScalar width_expansion, height_expansion;
  if (ctm.getType() & SkMatrix::kAffine_Mask) {
    width_expansion = ctm[SkMatrix::kMSkewY];
    height_expansion = ctm[SkMatrix::kMSkewX];
  } else {
    width_expansion = ctm[SkMatrix::kMScaleX];
    height_expansion = ctm[SkMatrix::kMScaleY];
  }
  return dst_width * fabs(width_expansion) < 1 ||
         dst_height * fabs(height_expansion) < 1;
}

namespace {
// gfx::RectF maths, which Blink uses for the drawImage rects: origin and size,
// where a size at or under 8 * epsilon is 0 (ui/gfx/geometry/size_f.h:106-108).
// One float operation per statement, as Chromium builds with -ffp-contract=off.
struct GfxRectF {
  GfxRectF(float x, float y, float w, float h)
      : x(x), y(y), w(ClampSize(w)), h(ClampSize(h)) {}
  static float ClampSize(float s) {
    return s > 8.f * std::numeric_limits<float>::epsilon() ? s : 0.f;
  }
  float right() const { return x + w; }
  float bottom() const { return y + h; }
  bool IsEmpty() const { return w == 0 || h == 0; }
  // RectF::Intersect (ui/gfx/geometry/rect_f.cc:99-116).
  void Intersect(const GfxRectF& r) {
    if (IsEmpty() || r.IsEmpty()) {
      *this = GfxRectF(0, 0, 0, 0);
      return;
    }
    float rx = std::max(x, r.x);
    float ry = std::max(y, r.y);
    float rr = std::min(right(), r.right());
    float rb = std::min(bottom(), r.bottom());
    if (rx >= rr || ry >= rb) {
      *this = GfxRectF(0, 0, 0, 0);
      return;
    }
    *this = GfxRectF(rx, ry, rr - rx, rb - ry);
  }
  // gfx::RectFToSkRect (ui/gfx/geometry/skia_conversions.cc:62-66).
  SkRect ToSkRect() const { return SkRect::MakeLTRB(x, y, right(), bottom()); }
  float x, y, w, h;
};

// Blink ClipRectsToImageRect (canvas_2d_recorder_context.cc:1989-2010): a
// source rect past the image is cut to it, and the destination in proportion.
void ClipRectsToImageRect(const GfxRectF& image, GfxRectF* src, GfxRectF* dst) {
  if (src->x >= image.x && src->right() <= image.right() && src->y >= image.y &&
      src->bottom() <= image.bottom()) {
    return;
  }
  const float scale_x = dst->w / src->w;
  const float scale_y = dst->h / src->h;
  const float scaled_src_x = src->x * scale_x;
  const float scaled_src_y = src->y * scale_y;
  const float offset_x = dst->x - scaled_src_x;
  const float offset_y = dst->y - scaled_src_y;
  src->Intersect(image);
  const float scaled_x = src->x * scale_x;
  const float scaled_y = src->y * scale_y;
  *dst = GfxRectF(scaled_x + offset_x, scaled_y + offset_y, src->w * scale_x,
                  src->h * scale_y);
}
}  // namespace

// Chrome draws an Image element (a lazily decoded image) from its software
// decode cache (cc/tiles/software_image_decode_cache.cc), which holds the
// image decoded into the canvas's colour space and scaled down to the mip
// level the draw needs. This is ours, one per decoded Image: a copy per
// (source rect, level size, colour space), most recently used last. Chrome
// builds a level from the smallest cached decode that is big enough; we always
// build it from the original, which is what Chrome does on a cold cache. We
// match the cold cache only. Not followed either: on a cold cache Chrome
// decodes a JPEG whose sides are whole MCUs straight to the level size
// (libjpeg's k/8 scaling) when the source rect is the whole image; we keep no
// encoded bytes to do that, and scale the full decode.
//
// A level the cache drops can still be held by a recorded draw or a pattern
// shader, so its bytes are counted in `live` until its pixels are freed;
// `live` is what Rust reports to V8. `bytes` is the cache's own share, which
// the budget limits. Each level holds a ref to this counter, so it outlives
// the cache while a level is alive. Once the cache is destroyed, `release`
// reports each level freed after it (skiac_image_levels_destroy). Levels are
// freed where their recordings and shaders drop, on the JS thread, so
// `release` is set and called on that thread only.
struct skiac_image_level_bytes : SkNVRefCnt<skiac_image_level_bytes> {
  std::atomic<size_t> live{0};
  skiac_level_release release = nullptr;
  void* release_context = nullptr;
};

struct skiac_image_levels {
  struct Key {
    SkIRect src;
    SkISize size;
    // The canvas colour space the level was converted to (`cs`, as in
    // COLOR_SPACE_CAST), or kNoConversion.
    int32_t cs;
    bool operator==(const Key& other) const {
      return src == other.src && size == other.size && cs == other.cs;
    }
  };
  static constexpr int32_t kNoConversion = -1;
  struct KeyHash {
    size_t operator()(const Key& key) const {
      // FNV-1a over the seven ints.
      uint64_t hash = 0xcbf29ce484222325ull;
      for (int32_t value :
           {key.src.fLeft, key.src.fTop, key.src.fRight, key.src.fBottom,
            key.size.fWidth, key.size.fHeight, key.cs}) {
        hash = (hash ^ static_cast<uint32_t>(value)) * 0x100000001b3ull;
      }
      return static_cast<size_t>(hash);
    }
  };
  struct Level {
    Key key;
    sk_sp<SkImage> image;
    size_t bytes;
  };
  // Least recently used first, found through `index`.
  std::list<Level> lru;
  std::unordered_map<Key, std::list<Level>::iterator, KeyHash> index;
  size_t bytes = 0;
  sk_sp<skiac_image_level_bytes> counter =
      sk_make_sp<skiac_image_level_bytes>();
};

// cc/tiles/mipmap_util.cc ScaleAxisToMipLevel: a level's size rounds up.
static int CcScaleAxisToMipLevel(int axis_base_size, int mip_level) {
  if (mip_level == 0) {
    return axis_base_size;
  }
  // base::CheckedNumeric gives INT_MAX on overflow.
  const int64_t base_size =
      std::min<int64_t>(int64_t{axis_base_size} + (int64_t{1} << mip_level) - 1,
                        std::numeric_limits<int>::max());
  return std::max(1, static_cast<int>(base_size >> mip_level));
}

static SkISize CcSizeForLevel(SkISize src, int mip_level) {
  return SkISize::Make(CcScaleAxisToMipLevel(src.width(), mip_level),
                       CcScaleAxisToMipLevel(src.height(), mip_level));
}

// MipMapUtil::GetLevelForSize (cc/tiles/mipmap_util.cc:36-67): the last level
// whose next one is not smaller than the target on either axis.
static int CcGetLevelForSize(SkISize src, SkISize target) {
  int next_mip_height = src.height();
  int next_mip_width = src.width();
  for (int mip_level = 0;; mip_level++) {
    const int mip_height = next_mip_height;
    const int mip_width = next_mip_width;
    next_mip_height = CcScaleAxisToMipLevel(src.height(), mip_level + 1);
    next_mip_width = CcScaleAxisToMipLevel(src.width(), mip_level + 1);
    if (next_mip_height < target.height() || next_mip_width < target.width()) {
      return mip_level;
    }
    if (mip_height == 1 && mip_width == 1) {
      return mip_level;
    }
  }
}

namespace {
// The decode Chrome draws an Image element from.
struct CcDecodeKey {
  // The target size rounds to 0 on an axis. The decode fails and Chrome draws
  // nothing, whatever the quality (DecodeImageIfNecessary).
  bool empty = false;
  // 0: the original image. Above 0: `src` scaled to `size`.
  int level = 0;
  SkIRect src = SkIRect::MakeEmpty();
  SkISize size = SkISize::MakeEmpty();
};
}  // namespace

// SoftwareImageDecodeCacheUtils::CacheKey::FromDrawImage
// (cc/tiles/software_image_decode_cache_utils.cc:287-363). Not followed: the
// kSubrectOriginal key for images of 4096 px or more, which draws a copy of
// the source rect instead of the original.
static CcDecodeKey CcDecodeKeyFor(SkISize image,
                                  const SkIRect& draw_src,
                                  const SkM44& matrix,
                                  int fq) {
  CcDecodeKey key;
  // DrawImage's ExtractScale (cc/paint/draw_image.cc:14-26).
  SkSize scale = SkSize::Make(matrix.rc(0, 0), matrix.rc(1, 1));
  bool decomposable = true;
  const SkMatrix matrix33 = matrix.asM33();
  if (matrix33.getType() & SkMatrix::kAffine_Mask) {
    if (!matrix33.decomposeScale(&scale)) {
      scale.set(1, 1);
      decomposable = false;
    }
  }
  // GetSrcRect (software_image_decode_cache_utils.cc:40-49).
  key.src = draw_src;
  if (!key.src.intersect(SkIRect::MakeSize(image))) {
    key.src.setEmpty();
  }
  const float target_width = key.src.width() * scale.width();
  const float target_height = key.src.height() * scale.height();
  const SkISize target =
      SkISize::Make(SkScalarRoundToInt(std::abs(target_width)),
                    SkScalarRoundToInt(std::abs(target_height)));
  if (target.isEmpty()) {
    key.empty = true;
    return key;
  }
  const int mip_level = CcGetLevelForSize(key.src.size(), target);
  // 'off', level 0 or a perspective matrix: the original image.
  if (fq == 0 || mip_level == 0 || !decomposable) {
    return key;
  }
  key.level = mip_level;
  key.size = CcSizeForLevel(key.src.size(), mip_level);
  return key;
}

// The decode is sampled linearly, or nearest for 'off'
// (GetDecodedFilterQuality, software_image_decode_cache.cc:145-149).
static SkSamplingOptions DecodedSampling(int fq) {
  return SkSamplingOptions(
      fq == 0 ? SkFilterMode::kNearest : SkFilterMode::kLinear,
      SkMipmapMode::kNone);
}

namespace {
// A level's pixels and the counter they are charged to.
struct LevelPixels {
  sk_sp<skiac_image_level_bytes> counter;
  size_t bytes;
};
}  // namespace

static void ReleaseLevelPixels(void* addr, void* context) {
  sk_free(addr);
  auto* pixels = static_cast<LevelPixels*>(context);
  skiac_image_level_bytes* counter = pixels->counter.get();
  counter->live.fetch_sub(pixels->bytes, std::memory_order_relaxed);
  if (counter->release) {
    counter->release(counter->release_context, pixels->bytes);
  }
  delete pixels;
}

// Chrome decodes into the canvas's colour space (`cs`) before it scales
// (DoDecodeImage with the key's target_color_params), and an untagged image
// is sRGB. The colour space `original` has to be converted to, or null.
static sk_sp<SkColorSpace> ConversionTarget(const SkPixmap& original,
                                            uint8_t cs) {
  sk_sp<SkColorSpace> target = COLOR_SPACE_CAST;
  sk_sp<SkColorSpace> source = original.refColorSpace();
  if (!source) {
    source = SkColorSpace::MakeSRGB();
  }
  return SkColorSpace::Equals(source.get(), target.get()) ? nullptr : target;
}

// GenerateCacheEntryFromCandidate (software_image_decode_cache_utils.cc:
// 183-270) with the original decode as the candidate: the src subset, in
// `target` when it is set (DoDecodeImage), scaled to the level size with
// kMedium (linear, nearest mip) into N32 premul. With `counter` the pixels
// count in it until they are freed.
static sk_sp<SkImage> MakeLevelImage(const SkPixmap& original,
                                     const SkIRect& src,
                                     SkISize size,
                                     sk_sp<SkColorSpace> target,
                                     skiac_image_level_bytes* counter) {
  SkPixmap subset;
  if (!original.extractSubset(&subset, src)) {
    return nullptr;
  }
  SkBitmap converted;
  if (target && size != src.size()) {
    if (!converted.tryAllocPixels(SkImageInfo::Make(
            src.size(), kN32_SkColorType, kPremul_SkAlphaType, target)) ||
        !subset.readPixels(converted.pixmap())) {
      return nullptr;
    }
    subset = converted.pixmap();
  }
  const SkImageInfo info =
      SkImageInfo::Make(size, kN32_SkColorType, kPremul_SkAlphaType,
                        target ? target : original.refColorSpace());
  SkBitmap level;
  if (counter) {
    const size_t row_bytes = info.minRowBytes();
    const size_t bytes = info.computeByteSize(row_bytes);
    if (SkImageInfo::ByteSizeOverflowed(bytes)) {
      return nullptr;
    }
    void* addr = sk_malloc_canfail(bytes);
    if (!addr) {
      return nullptr;
    }
    counter->live.fetch_add(bytes, std::memory_order_relaxed);
    // On failure installPixels calls the release proc, which uncounts them.
    if (!level.installPixels(info, addr, row_bytes, ReleaseLevelPixels,
                             new LevelPixels{sk_ref_sp(counter), bytes})) {
      return nullptr;
    }
  } else if (!level.tryAllocPixels(info)) {
    return nullptr;
  }
  // Same size: scalePixels copies, converting to the level's colour space.
  if (!subset.scalePixels(
          level.pixmap(),
          SkSamplingOptions(SkFilterMode::kLinear, SkMipmapMode::kNearest))) {
    return nullptr;
  }
  level.setImmutable();
  return SkImages::RasterFromBitmap(level);
}

// The cached level for (src, size) on a canvas in colour space `cs`, made on
// a miss. The cache holds at most the original's byte size and drops the least
// recently used levels first; a recorded draw keeps its own ref to the level
// it drew, which stays counted in `live` until it is freed.
static sk_sp<SkImage> FindOrMakeLevel(skiac_image_levels* cache,
                                      const SkPixmap& original,
                                      const SkIRect& src,
                                      SkISize size,
                                      uint8_t cs) {
  sk_sp<SkColorSpace> target = ConversionTarget(original, cs);
  const skiac_image_levels::Key key{
      src, size, target ? cs : skiac_image_levels::kNoConversion};
  auto found = cache->index.find(key);
  if (found != cache->index.end()) {
    cache->lru.splice(cache->lru.end(), cache->lru, found->second);
    return found->second->image;
  }
  sk_sp<SkImage> image = MakeLevelImage(original, src, size, std::move(target),
                                        cache->counter.get());
  if (!image) {
    return nullptr;
  }
  const size_t bytes = image->imageInfo().computeMinByteSize();
  const size_t budget = std::max(original.computeByteSize(), bytes);
  while (!cache->lru.empty() && cache->bytes + bytes > budget) {
    cache->bytes -= cache->lru.front().bytes;
    cache->index.erase(cache->lru.front().key);
    cache->lru.pop_front();
  }
  cache->bytes += bytes;
  cache->lru.push_back({key, image, bytes});
  cache->index.emplace(key, std::prev(cache->lru.end()));
  return image;
}

// The pixels of `image` a draw of `src` under `matrix` (source to device) can
// sample: the device pixels it touches, mapped back, and one more for the
// filter.
static SkIRect SampledBounds(const SkRect& src,
                             const SkMatrix& matrix,
                             SkISize image) {
  const SkIRect all = SkIRect::MakeSize(image);
  SkMatrix inverse;
  if (!matrix.invert(&inverse)) {
    return all;
  }
  const SkRect device = matrix.mapRect(src).makeOutset(1, 1);
  SkIRect bounds = inverse.mapRect(device).makeOutset(1, 1).roundOut();
  return bounds.intersect(all) ? bounds : all;
}

// DrawImageRectOp::RasterWithFlags for a source Chrome draws from its decode
// cache (cc/paint/paint_op.cc:1455-1485): draw the decode of the rounded-out
// src, in the canvas's colour space `cs`. A level is a copy of the src subset,
// so the src rect moves to its origin and scales with it
// (AdjustSrcRectForScale, paint_op.cc:93-102). `original` is the source's
// pixels: an Image's `bitmap`, or a canvas's `snapshot`. `levels` is an
// Image's level cache; a canvas source has none, and its decode is made for
// the one draw. Returns the decode it drew in place of the source, which a
// recording keeps, or null.
static sk_sp<SkImage> DrawDecodedImage(SkCanvas* canvas,
                                       const SkBitmap* bitmap,
                                       const sk_sp<SkImage>& snapshot,
                                       const SkPixmap& original,
                                       skiac_image_levels* levels,
                                       uint8_t cs,
                                       const SkRect& src,
                                       const SkRect& dst,
                                       const SkM44& matrix,
                                       int fq,
                                       const SkPaint& paint) {
  SkIRect int_src;
  src.roundOut(&int_src);
  const CcDecodeKey key =
      CcDecodeKeyFor(original.dimensions(), int_src, matrix, fq);
  if (key.empty) {
    return nullptr;
  }
  sk_sp<SkColorSpace> target = ConversionTarget(original, cs);
  // The part of the source the decode holds, and its size.
  SkIRect decoded_src = key.src;
  SkISize decoded_size = key.size;
  if (key.level == 0) {
    if (!target) {
      sk_sp<SkImage> image =
          snapshot ? snapshot : SkImages::RasterFromBitmap(*bitmap);
      if (image) {
        canvas->drawImageRect(image.get(), src, dst, DecodedSampling(fq),
                              &paint, SkCanvas::kFast_SrcRectConstraint);
      }
      return nullptr;
    }
    // The original in the canvas's colour space: the whole image, as Chrome
    // decodes it, or for a canvas source only the pixels this draw samples.
    decoded_src =
        levels ? SkIRect::MakeSize(original.dimensions())
               : SampledBounds(src, matrix.asM33(), original.dimensions());
    decoded_size = decoded_src.size();
  }
  sk_sp<SkImage> decoded =
      levels ? FindOrMakeLevel(levels, original, decoded_src, decoded_size, cs)
             : MakeLevelImage(original, decoded_src, decoded_size,
                              std::move(target), nullptr);
  if (!decoded) {
    return nullptr;
  }
  // One float operation per statement, see GfxRectF.
  const SkRect offset_src = src.makeOffset(-decoded_src.x(), -decoded_src.y());
  const float adjust_x =
      static_cast<float>(decoded_size.width()) / decoded_src.width();
  const float adjust_y =
      static_cast<float>(decoded_size.height()) / decoded_src.height();
  const float level_x = offset_src.x() * adjust_x;
  const float level_y = offset_src.y() * adjust_y;
  const float level_w = offset_src.width() * adjust_x;
  const float level_h = offset_src.height() * adjust_y;
  canvas->drawImageRect(
      decoded.get(), SkRect::MakeXYWH(level_x, level_y, level_w, level_h), dst,
      DecodedSampling(fq), &paint, SkCanvas::kFast_SrcRectConstraint);
  return decoded;
}

skiac_image_levels* skiac_image_levels_create() {
  return new skiac_image_levels();
}

size_t skiac_image_levels_destroy(skiac_image_levels* c_levels,
                                  skiac_level_release release,
                                  void* release_context) {
  sk_sp<skiac_image_level_bytes> counter = c_levels->counter;
  // Frees the levels only the cache holds.
  delete c_levels;
  counter->release = release;
  counter->release_context = release_context;
  return counter->live.load(std::memory_order_relaxed);
}

size_t skiac_image_levels_bytes(skiac_image_levels* c_levels) {
  return c_levels->counter->live.load(std::memory_order_relaxed);
}

// The rects come in normalised (Blink AdjustRectForCanvas, done by the Rust
// caller). Canvas and Image sources are drawn alike, as Blink's
// drawImage (canvas_2d_recorder_context.cc:2312-2316) and
// StaticBitmapImage::DrawHelper (static_bitmap_image.cc:83-116) do: clip the
// rects to the image, pick AA on the clipped destination, then drawImageRect
// with kFast (Image::kDoNotClampImageToSourceRect).
// `c_ctm` is the context's transform. The AA rule and the sampling read it,
// not the canvas matrix: the canvas may be a recorder that sits at identity
// (the composited ops), while Blink reads the CTM that CompositedDraw has put
// back on the paint canvas (canvas_2d_recorder_context.h:919-990).
// `vector_device` is true on the PDF and SVG backends.
// With `decode` the source is drawn from Chrome's decode cache, in the
// canvas's colour space `cs`: an Image on a raster canvas, whose levels
// `c_levels` keeps, or a canvas source on a raster canvas that is not sRGB.
// Everything else is drawn as it is. `c_decoded_id` and `c_decoded_bytes` get
// the uniqueID and byte size of the decode drawn in place of the source, which
// a recording keeps; the size is 0 when the source itself was drawn.
void skiac_canvas_draw_image(skiac_canvas* c_canvas,
                             skiac_bitmap* c_bitmap,
                             bool is_canvas,
                             bool decode,
                             skiac_image_levels* c_levels,
                             uint8_t cs,
                             skiac_transform c_ctm,
                             bool vector_device,
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
                             skiac_paint* c_paint,
                             uint32_t* c_decoded_id,
                             size_t* c_decoded_bytes) {
  *c_decoded_id = 0;
  *c_decoded_bytes = 0;
  auto fq = enable_smoothing ? filter_quality : 0;
  auto src_surface =
      is_canvas ? reinterpret_cast<SkSurface*>(c_bitmap) : nullptr;
  const SkISize image_size =
      is_canvas ? SkISize::Make(src_surface->width(), src_surface->height())
                : BITMAP_CAST->dimensions();
  const GfxRectF image_rect(0, 0, image_size.width(), image_size.height());
  GfxRectF src(sx, sy, s_width, s_height);
  GfxRectF dst(dx, dy, d_width, d_height);
  ClipRectsToImageRect(image_rect, &src, &dst);
  // DrawHelper intersects once more (static_bitmap_image.cc:89-93).
  src.Intersect(image_rect);
  if (src.IsEmpty() || dst.IsEmpty()) {
    return;
  }
  const SkMatrix ctm = conv_from_transform(c_ctm);
  SkPaint paint = c_paint ? *PAINT_CAST : SkPaint();
  paint.setAntiAlias(ShouldDrawImageAntialiased(ctm, dst.w, dst.h));
  const SkRect src_rect = src.ToSkRect();
  const SkRect dst_rect = dst.ToSkRect();
  // DrawImageRectOp::RasterWithFlags (cc/paint/paint_op.cc:1456-1457).
  const SkM44 matrix =
      SkM44(ctm) * SkM44(SkMatrix::RectToRect(src_rect, dst_rect));
  // Snapshot instead of SkSurface::draw -- on a never-snapshotted surface
  // SkSurface::draw copies the whole pixel buffer on every call (#1321).
  // The snapshot shares the pixels; a later write into the source
  // copies-on-write, which keeps call-time capture semantics.
  sk_sp<SkImage> snapshot =
      is_canvas ? src_surface->makeImageSnapshot() : nullptr;
  if (decode) {
    SkPixmap original;
    if (is_canvas ? snapshot && snapshot->peekPixels(&original)
                  : BITMAP_CAST->peekPixels(&original)) {
      sk_sp<SkImage> decoded = DrawDecodedImage(
          CANVAS_CAST, is_canvas ? nullptr : BITMAP_CAST, snapshot, original,
          c_levels, cs, src_rect, dst_rect, matrix, fq, paint);
      if (decoded) {
        *c_decoded_id = decoded->uniqueID();
        *c_decoded_bytes = decoded->imageInfo().computeMinByteSize();
      }
    }
    return;
  }
  sk_sp<SkImage> image = is_canvas ? std::move(snapshot)
                                   : SkImages::RasterFromBitmap(*BITMAP_CAST);
  if (!image) {
    return;
  }
  const SkSamplingOptions sampling =
      is_canvas ? CcSampling(fq, matrix.asM33()) : SamplingOptionsFromFQ(fq);
  if (is_canvas && vector_device) {
    // SkPDFDevice draws a source rect smaller than the image as a subset image
    // of its own, so a sprite sheet would embed one copy per sprite. Draw the
    // whole snapshot under a clip instead: every draw shares one image.
    // Trade-off: a PDF viewer filters the crop edge with the pixels past it,
    // so that edge can differ from an Image source, which gets a subset image.
    // Canvas sources have always been drawn this way on PDF. The SVG device
    // draws both sources as clip + whole image anyway.
    CANVAS_CAST->save();
    CANVAS_CAST->clipRect(dst_rect);
    CANVAS_CAST->concat(SkMatrix::RectToRect(src_rect, dst_rect));
    CANVAS_CAST->drawImage(image.get(), 0, 0, sampling, &paint);
    CANVAS_CAST->restore();
    return;
  }
  CANVAS_CAST->drawImageRect(image.get(), src_rect, dst_rect, sampling, &paint,
                             SkCanvas::kFast_SrcRectConstraint);
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
    bool collect_ink,
    const skiac_font_variation* variations,
    int variations_count,
    int kerning,
    int variant_caps,
    const char* lang,
    int text_rendering) {
  // A face or alias registered since the last lookup can change an existing
  // match, and FontCollection caches matches until told otherwise.
  c_collection->flushCachesIfDirty();
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
  // https://github.com/chromium/chromium/blob/104.0.5092.1/third_party/blink/renderer/core/html/canvas/text_metrics.cc#L21-L25
  // According to
  // http://wiki.apache.org/xmlgraphics-fop/LineLayout/AlignmentHandling
  // "FOP (Formatting Objects Processor) puts the hanging baseline at 80% of
  // the ascender height". Shared by the Hanging case and hangingBaseline, so
  // hangingBaseline is exactly 0 at 'hanging'.
  SkScalar hanging_offset =
      -alphabetic_baseline -
      font_metrics.fAscent * HANGING_AS_PERCENT_OF_ASCENT / 100.0;
  switch (css_baseline) {
    case CssBaseline::Top:
      baseline_offset = -alphabetic_baseline - font_metrics.fAscent -
                        font_metrics.fUnderlinePosition -
                        font_metrics.fUnderlineThickness;
      break;
    case CssBaseline::Hanging:
      baseline_offset = hanging_offset;
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
    // Blink (text_metrics.cc), with offset = -baseline_y:
    // alphabetic = -baseline_y, hanging = 0.8 * ascent - baseline_y,
    // ideographic = -descent - baseline_y.
    c_line_metrics->alphabetic_baseline = offset;
    c_line_metrics->hanging_baseline = hanging_offset - baseline_offset;
    c_line_metrics->ideographic_baseline = -c_line_metrics->font_descent;
    float em_ascent;
    float em_descent;
    EmHeight(font, font_metrics, &em_ascent, &em_descent);
    c_line_metrics->em_height_ascent = em_ascent + offset;
    c_line_metrics->em_height_descent = em_descent - offset;
    // The ink of every glyph the draw above paints, where it paints it:
    // visit() walks the text blobs paint() draws, and the origin is the
    // draw's own, rtl_offset and letter_spacing_offset included. Relative to
    // x, unscaled. Only the alpha:false reset asks for it; the walk is a
    // large share of a measure, so measureText skips it.
    SkScalar ink_left = SK_ScalarInfinity;
    SkScalar ink_right = SK_ScalarNegativeInfinity;
    if (collect_ink) {
      paragraph->visit([&](int, const Paragraph::VisitorInfo* info) {
        if (!info) {
          return;
        }
        std::vector<SkRect> glyph_bounds(info->count);
        info->font.getBounds({info->glyphs, static_cast<size_t>(info->count)},
                             glyph_bounds, PAINT_CAST);
        for (int i = 0; i < info->count; ++i) {
          if (glyph_bounds[i].isEmpty()) {
            continue;
          }
          auto glyph_x = info->origin.fX + info->positions[i].fX;
          ink_left = std::min(ink_left, glyph_x + glyph_bounds[i].fLeft);
          ink_right = std::max(ink_right, glyph_x + glyph_bounds[i].fRight);
        }
      });
    }
    auto draw_x = paint_x - rtl_offset + letter_spacing_offset - x;
    // No ink (only spaces) or not asked for: an empty box at the anchor.
    c_line_metrics->ink_left = ink_left <= ink_right ? draw_x + ink_left : 0;
    c_line_metrics->ink_right = ink_left <= ink_right ? draw_x + ink_right : 0;
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

// Explicit layer for a blend mode plus image filter, mirroring Blink's
// `CompositedDraw` (canvas_2d_recorder_context.h:919-963): a canvas2d filter
// length is device-space, so content and filter need different matrices. Null
// bounds on purpose -- SkCanvas then sizes the layer from the device clip, so
// no halo is truncated.
void skiac_canvas_save_layer(skiac_canvas* c_canvas, skiac_paint* c_paint) {
  CANVAS_CAST->saveLayer(nullptr, PAINT_CAST);
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

// putImageData: uses drawImageRect with kSrc blend mode for direct pixel
// replacement. Per HTML spec, putImageData must replace pixels, not composite.
// Uses drawImageRect (recordable by PictureRecorder) instead of
// SkCanvas::writePixels (which only works on raster surfaces).
void skiac_canvas_put_image_data(skiac_canvas* c_canvas,
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
                                 uint8_t cs,
                                 bool snapshot,
                                 bool opaque) {
  auto color_space = COLOR_SPACE_CAST;
  // alpha:false: Blink's PutByteArray labels the pixels kOpaque, so the write
  // onto the kOpaque canvas is a plain copy, alpha included
  // (base_rendering_context_2d.cc PutByteArray, skbug 6157).
  auto info =
      SkImageInfo::Make(width, height, SkColorType::kRGBA_8888_SkColorType,
                        opaque ? SkAlphaType::kOpaque_SkAlphaType
                               : SkAlphaType::kUnpremul_SkAlphaType,
                        color_space);
  auto pixmap = SkPixmap(info, pixels, row_bytes);
  // When snapshot=true (deferred/recorded mode), copy the pixel data so the
  // SkPicture owns an independent snapshot. Without this, reusing and mutating
  // the same ImageData buffer between putImageData calls would corrupt earlier
  // recorded frames (they all alias the same JS buffer).
  // When snapshot=false (direct mode), the pixels are consumed immediately by
  // drawImageRect so a zero-copy reference is safe.
  auto image = snapshot ? SkImages::RasterFromPixmapCopy(pixmap)
                        : SkImages::RasterFromPixmap(pixmap, nullptr, nullptr);
  auto src_rect = SkRect::MakeXYWH(dirty_x, dirty_y, dirty_width, dirty_height);
  auto dst_rect =
      SkRect::MakeXYWH(x + dirty_x, y + dirty_y, dirty_width, dirty_height);
  const auto sampling =
      SkSamplingOptions(SkFilterMode::kNearest, SkMipmapMode::kNone);
  SkPaint paint;
  paint.setBlendMode(SkBlendMode::kSrc);
  CANVAS_CAST->drawImageRect(image, src_rect, dst_rect, sampling, &paint,
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

  const auto dst_rect = SkRect::MakeXYWH(dx, dy, dw, dh);
  const SkPaint* paint = PAINT_CAST;

  canvas->save();
  // The source crop -- `drawPicture` replays the whole picture. The clip
  // would truncate a halo, so `paint` must carry no image filter.
  canvas->clipRect(dst_rect, SkClipOp::kIntersect, true /* antialias */);

  // Optimization: skip paint if it's default (SrcOver blend, full alpha, no
  // filter) This matches skia-canvas behavior
  // The colour-filter test must stay: eliding a paint colourised by a kSrcIn
  // colour filter renders a shadow as a displaced copy of the source.
  if (paint != nullptr) {
    auto blendMode = paint->asBlendMode();
    if (blendMode.has_value() && blendMode.value() == SkBlendMode::kSrcOver &&
        paint->getAlpha() == 255 && paint->getImageFilter() == nullptr &&
        paint->getColorFilter() == nullptr) {
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

void skiac_paint_set_alphaf(skiac_paint* c_paint, float a) {
  PAINT_CAST->setAlphaf(a);
}

float skiac_paint_get_alphaf(skiac_paint* c_paint) {
  return PAINT_CAST->getAlphaf();
}

uint32_t skiac_paint_get_color(skiac_paint* c_paint) {
  return PAINT_CAST->getColor();
}

void skiac_paint_set_anti_alias(skiac_paint* c_paint, bool aa) {
  PAINT_CAST->setAntiAlias(aa);
}

void skiac_paint_set_dither(skiac_paint* c_paint, bool dither) {
  PAINT_CAST->setDither(dither);
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

// Colourise like Chromium's shadow looper: source RGB (shader included) is
// replaced, coverage multiplied by the colour's alpha (draw_looper.cc:33-34).
// kSrcIn is the only mode SkSVGDevice accepts -- do not generalise it.
void skiac_paint_set_src_in_color_filter(skiac_paint* c_paint,
                                         uint8_t r,
                                         uint8_t g,
                                         uint8_t b,
                                         uint8_t a) {
  PAINT_CAST->setColorFilter(
      SkColorFilters::Blend(SkColor4f::FromColor(SkColorSetARGB(a, r, g, b)),
                            nullptr, SkBlendMode::kSrcIn));
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
  if (c_picture) {
    reinterpret_cast<SkPicture*>(c_picture)->ref();
  }
}

void skiac_picture_destroy(skiac_picture* c_picture) {
  if (c_picture) {
    reinterpret_cast<SkPicture*>(c_picture)->unref();
  }
}

// Direct playback without matrix/paint overhead
void skiac_picture_playback(skiac_picture* c_picture, skiac_canvas* c_canvas) {
  if (c_picture == nullptr || c_canvas == nullptr) {
    return;
  }
  reinterpret_cast<SkPicture*>(c_picture)->playback(
      reinterpret_cast<SkCanvas*>(c_canvas));
}

size_t skiac_picture_approximate_bytes(skiac_picture* c_picture) {
  if (c_picture == nullptr) {
    return 0;
  }
  return reinterpret_cast<SkPicture*>(c_picture)->approximateBytesUsed();
}

// Process-unique, never-recycled picture identity -- safe as a retention
// dedup key even for draws that end up not retaining the picture object.
uint32_t skiac_picture_unique_id(skiac_picture* c_picture) {
  if (c_picture == nullptr) {
    return 0;
  }
  return reinterpret_cast<SkPicture*>(c_picture)->uniqueID();
}

// SkPictureRecorder
skiac_picture_recorder* skiac_picture_recorder_create() {
  return reinterpret_cast<skiac_picture_recorder*>(new SkPictureRecorder());
}

void skiac_picture_recorder_destroy(
    skiac_picture_recorder* c_picture_recorder) {
  delete reinterpret_cast<SkPictureRecorder*>(c_picture_recorder);
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
  if (c_canvas == nullptr || c_drawable == nullptr) {
    return;
  }
  auto canvas = reinterpret_cast<SkCanvas*>(c_canvas);
  auto drawable = reinterpret_cast<SkDrawable*>(c_drawable);
  if (c_matrix) {
    canvas->drawDrawable(drawable, MATRIX_CAST);
  } else {
    canvas->drawDrawable(drawable);
  }
}

void skiac_drawable_destroy(skiac_drawable* c_drawable) {
  if (c_drawable) {
    reinterpret_cast<SkDrawable*>(c_drawable)->unref();
  }
}

void skiac_path_swap(skiac_path* c_path, skiac_path* other_path) {
  std::swap(c_path->builder, other_path->builder);
  std::swap(c_path->cached_path, other_path->cached_path);
}

void skiac_add_path(skiac_path* c_path,
                    skiac_path* other_path,
                    skiac_matrix* c_matrix) {
  // Path2D.addPath adds the other path's subpaths as they are; kExtend would
  // turn its first moveTo into a lineTo from the current contour.
  c_path->builder.addPath(other_path->path(), *MATRIX_CAST,
                          SkPath::AddPathMode::kAppend_AddPathMode);
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
  SkPathBuilder result;
  if (skpathutils::FillPathWithPaint(c_path->path(), p, &result)) {
    c_path->replace_from_path(result.detach());
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
  SkPathBuilder result;
  if (pe->filterPath(&result, c_path->path(), &rec)) {
    c_path->replace_from_path(result.detach());
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
  SkPathBuilder result;
  if (pe->filterPath(&result, c_path->path(), &rec)) {
    c_path->replace_from_path(result.detach());
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
  SkPathBuilder result;
  if (pe->filterPath(&result, c_path->path(), &rec)) {
    c_path->replace_from_path(result.detach());
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

// SVG elliptical arc, as Blink PathBuilder::ArcTo (path_builder.cc:309-323).
void skiac_path_arc_to_svg(skiac_path* c_path,
                           float rx,
                           float ry,
                           float x_axis_rotate,
                           bool large_arc,
                           bool sweep,
                           float x,
                           float y) {
  c_path->builder.arcTo(
      SkVector{rx, ry}, x_axis_rotate,
      large_arc ? SkPathBuilder::kLarge_ArcSize : SkPathBuilder::kSmall_ArcSize,
      sweep ? SkPathDirection::kCW : SkPathDirection::kCCW, SkPoint{x, y});
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

int skiac_path_count_points(skiac_path* c_path) {
  return c_path->path().countPoints();
}

int skiac_path_count_verbs(skiac_path* c_path) {
  return c_path->path().countVerbs();
}

// SkPathData uniqueID via SkPath::getGenerationID: globally unique per
// path-data version, stable while copies share the same data. Any
// point/verb/conic change allocates fresh SkPathData with a fresh id
// (fill-type changes do not touch the data). Safe retention-dedup key.
uint32_t skiac_path_generation_id(skiac_path* c_path) {
  return c_path->path().getGenerationID();
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
  SkPathBuilder traced_path;

  if (skpathutils::FillPathWithPaint(path_with_winding, paint, &traced_path)) {
    return traced_path.detach().contains(x, y);
  }
  return path_with_winding.contains(x, y);
}

void skiac_path_round_rect(skiac_path* c_path,
                           SkScalar x,
                           SkScalar y,
                           SkScalar width,
                           SkScalar height,
                           const SkScalar* radii,
                           bool clockwise) {
  // radii: (rx, ry) of the upper-left, upper-right, lower-right and
  // lower-left corners (SkRRect order).
  SkVector radii_vectors[4];
  for (size_t i = 0; i < 4; i++) {
    radii_vectors[i] = {radii[2 * i], radii[2 * i + 1]};
  }
  SkRect rect = SkRect::MakeXYWH(x, y, width, height);
  SkRRect rrect;
  rrect.setRectRadii(rect, radii_vectors);
  auto direction = clockwise ? SkPathDirection::kCW : SkPathDirection::kCCW;
  // Blink PathBuilder::AddRoundedRect (path_builder.cc:352-360) starts at
  // the upper-left, after the corner radius (index 0), not at SkPathBuilder's
  // default start.
  c_path->builder.addRRect(rrect, direction, 0);
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

// sk::Color4f (src/sk.rs), skiac_color4f and SkColor4f all hold r, g, b, a as
// four floats. The stops are copied field by field, so nothing reads Rust
// memory as an SkColor4f; the asserts keep the three layouts in step.
static_assert(sizeof(skiac_color4f) == 16 && alignof(skiac_color4f) == 4,
              "skiac_color4f must match sk::Color4f in src/sk.rs");
static_assert(offsetof(skiac_color4f, r) == 0 &&
                  offsetof(skiac_color4f, g) == 4 &&
                  offsetof(skiac_color4f, b) == 8 &&
                  offsetof(skiac_color4f, a) == 12,
              "skiac_color4f must match sk::Color4f in src/sk.rs");
static_assert(sizeof(skiac_color4f) == sizeof(SkColor4f) &&
                  alignof(skiac_color4f) == alignof(SkColor4f),
              "skiac_color4f must have the size and alignment of SkColor4f");
static_assert(offsetof(skiac_color4f, r) == offsetof(SkColor4f, fR) &&
                  offsetof(skiac_color4f, g) == offsetof(SkColor4f, fG) &&
                  offsetof(skiac_color4f, b) == offsetof(SkColor4f, fB) &&
                  offsetof(skiac_color4f, a) == offsetof(SkColor4f, fA),
              "skiac_color4f must have the channel order of SkColor4f");

// `count` unpremultiplied sRGB gradient stop colors.
static std::vector<SkColor4f> gradient_stop_colors(const skiac_color4f* colors,
                                                   int count) {
  std::vector<SkColor4f> colors4f(count);
  for (int i = 0; i < count; i++) {
    colors4f[i] = {colors[i].r, colors[i].g, colors[i].b, colors[i].a};
  }
  return colors4f;
}

// Canvas gradient stops are legacy sRGB colors, and Blink interpolates them in
// sRGB whatever the canvas color space (gradient.cc:305-315 picks kSRGB,
// :248-250 maps it to SkGradient's kSRGB). kDestination would mix them in
// display-p3 on a P3 canvas.
static SkGradient::Interpolation legacy_stop_interpolation(uint32_t flags) {
  auto interpolation = SkGradient::Interpolation::FromFlags(flags);
  interpolation.fColorSpace = SkGradient::Interpolation::ColorSpace::kSRGB;
  return interpolation;
}

skiac_shader* skiac_shader_make_linear_gradient(const skiac_point* c_points,
                                                const skiac_color4f* colors,
                                                const float* positions,
                                                int count,
                                                int tile_mode,
                                                uint32_t flags,
                                                skiac_transform c_ts) {
  const auto points = reinterpret_cast<const SkPoint*>(c_points);
  const auto skia_tile_mode = (SkTileMode)tile_mode;
  const auto ts = conv_from_transform(c_ts);
  const auto colors4f = gradient_stop_colors(colors, count);
  SkSpan<const float> posSpan =
      positions ? SkSpan<const float>(positions, count) : SkSpan<const float>();
  SkGradient::Colors gradColors(SkSpan<const SkColor4f>(colors4f.data(), count),
                                posSpan, skia_tile_mode);
  SkGradient grad(gradColors, legacy_stop_interpolation(flags));
  auto shader = SkShaders::LinearGradient(points, grad, &ts).release();

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
                                                const skiac_color4f* colors,
                                                const float* positions,
                                                int count,
                                                int tile_mode,
                                                uint32_t flags,
                                                skiac_transform c_ts) {
  const SkPoint startPoint = {c_start_point.x, c_start_point.y};
  const SkPoint endPoint = {c_end_point.x, c_end_point.y};
  const auto colors4f = gradient_stop_colors(colors, count);
  SkSpan<const float> posSpan =
      positions ? SkSpan<const float>(positions, count) : SkSpan<const float>();
  SkGradient::Colors gradColors(SkSpan<const SkColor4f>(colors4f.data(), count),
                                posSpan, (SkTileMode)tile_mode);
  SkGradient grad(gradColors, legacy_stop_interpolation(flags));
  auto shader =
      SkShaders::TwoPointConicalGradient(startPoint, start_radius, endPoint,
                                         end_radius, grad, nullptr)
          .release();

  if (shader) {
    return reinterpret_cast<skiac_shader*>(shader);
  } else {
    return nullptr;
  }
}

skiac_shader* skiac_shader_make_conic_gradient(SkScalar cx,
                                               SkScalar cy,
                                               SkScalar rotation,
                                               const skiac_color4f* colors,
                                               const float* positions,
                                               int count,
                                               int tile_mode,
                                               uint32_t flags,
                                               skiac_transform c_ts) {
  auto ts = conv_from_transform(c_ts);
  // Blink ConicGradient::CreateShader (gradient.cc:509-522): Skia's sweep
  // gradient angles are relative to the x-axis, not the y-axis, and the sweep
  // always runs from 0 to 360 degrees.
  const float skia_rotation = rotation - 90;
  if (skia_rotation) {
    ts.preRotate(skia_rotation, cx, cy);
  }
  const auto colors4f = gradient_stop_colors(colors, count);
  SkSpan<const float> posSpan =
      positions ? SkSpan<const float>(positions, count) : SkSpan<const float>();
  SkGradient::Colors gradColors(SkSpan<const SkColor4f>(colors4f.data(), count),
                                posSpan, (SkTileMode)tile_mode);
  SkGradient grad(gradColors, legacy_stop_interpolation(flags));
  auto shader =
      SkShaders::SweepGradient({cx, cy}, 0.0f, 360.0f, grad, &ts).release();

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

// Would Skia replace this image filter by a plain colour filter
// (SkImageFilter.h:71-76)? Then it has no spatial parameter and needs no layer.
// `asAColorFilter` asserts on a null out param and returns a ref to release.
bool skiac_image_filter_is_a_color_filter(skiac_image_filter* c_image_filter) {
  SkColorFilter* color_filter = nullptr;
  if (!IMAGE_FILTER_CAST->asAColorFilter(&color_filter)) {
    return false;
  }
  SkSafeUnref(color_filter);
  return true;
}

// Evaluate a colour-only image filter on one 8-bit sRGB `SkColor` --
// `Context::shadow_paint` colourises after `ctx.filter`, not before. A spatial
// filter has no single answer, so `color` comes back untouched.
uint32_t skiac_image_filter_filter_color(skiac_image_filter* c_image_filter,
                                         uint32_t color) {
  SkColorFilter* color_filter = nullptr;
  if (!IMAGE_FILTER_CAST->asAColorFilter(&color_filter)) {
    return color;
  }
  sk_sp<SkColorFilter> owned(color_filter);
  auto srgb = SkColorSpace::MakeSRGB();
  return owned
      ->filterColor4f(SkColor4f::FromColor(color), srgb.get(), srgb.get())
      .toSkColor();
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
  if (c_image) {
    IMAGE_CAST->ref();
  }
}

void skiac_image_destroy(skiac_image* c_image) {
  if (c_image) {
    IMAGE_CAST->unref();
  }
}

int skiac_image_get_width(skiac_image* c_image) {
  return c_image ? IMAGE_CAST->width() : 0;
}

int skiac_image_get_height(skiac_image* c_image) {
  return c_image ? IMAGE_CAST->height() : 0;
}

// Encodes the image directly; the caller keeps ownership of c_image.
void skiac_image_encode_data(skiac_image* c_image,
                             skiac_sk_data* data,
                             int format,
                             int quality) {
  auto image_ref = encodable_image(IMAGE_CAST);
  auto image = image_ref.get();
  sk_sp<SkData> encoded_data;
  if (format == int(SkEncodedImageFormat::kJPEG)) {
    SkJpegEncoder::Options options;
    options.fQuality = quality;
    options.fAlphaOption = kJpegAlphaOption;
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
  if (encoded_data) {
    data->ptr = const_cast<uint8_t*>(encoded_data->bytes());
    data->size = encoded_data->size();
    data->data = reinterpret_cast<skiac_data*>(encoded_data.release());
  }
}

bool skiac_image_read_pixels(skiac_image* c_image,
                             uint8_t* dst,
                             size_t row_bytes,
                             int alpha_type,
                             uint8_t cs) {
  if (!c_image || !dst) {
    return false;
  }
  if (alpha_type != int(kPremul_SkAlphaType) &&
      alpha_type != int(kUnpremul_SkAlphaType)) {
    return false;
  }
  auto image = IMAGE_CAST;
  // GIF has no color profile, so the spec wants its pixels converted to
  // sRGB (cs 0). AVIF carries the canvas color space as CICP, so it reads
  // the pixels in the image's own color space.
  auto info =
      SkImageInfo::Make(image->width(), image->height(), kRGBA_8888_SkColorType,
                        static_cast<SkAlphaType>(alpha_type), COLOR_SPACE_CAST);
  return image->readPixels(nullptr, info, dst, row_bytes, 0, 0);
}

// 1 when the image is display-p3, else 0 (sRGB): the two canvas color spaces.
uint8_t skiac_image_color_space(skiac_image* c_image) {
  auto p3 =
      SkColorSpace::MakeRGB(SkNamedTransferFn::kSRGB, SkNamedGamut::kDisplayP3);
  return SkColorSpace::Equals(IMAGE_CAST->colorSpace(), p3.get()) ? 1 : 0;
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

bool skiac_bitmap_make_from_buffer(const uint8_t* ptr,
                                   size_t size,
                                   skiac_bitmap_info* bitmap_info) {
  auto data = SkData::MakeWithoutCopy(reinterpret_cast<const void*>(ptr), size);
  auto codec = SkCodec::MakeFromData(data);
  if (!codec) {
    return false;
  }
  auto info = codec->getInfo();
  // PNG/WebP/GIF codecs report unpremultiplied alpha (required by those
  // formats on disk). Ask the codec to output premultiplied pixels so that
  // downstream bilinear/cubic sampling in drawImage does not bleed
  // black-but-transparent border pixels into visible edges.
  // See https://github.com/Brooooooklyn/canvas/issues/1250.
  if (info.alphaType() == kUnpremul_SkAlphaType) {
    info = info.makeAlphaType(kPremul_SkAlphaType);
  }
  auto row_bytes = info.minRowBytes();
  auto bitmap = std::make_unique<SkBitmap>();
  if (!bitmap->tryAllocPixels(info)) {
    return false;
  }
  auto result = codec->getPixels(info, bitmap->getPixels(), row_bytes);
  if (result != SkCodec::kSuccess && result != SkCodec::kIncompleteInput &&
      result != SkCodec::kErrorInInput) {
    return false;
  }
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
    auto oriented_bitmap = std::make_unique<SkBitmap>();
    auto oriented_bitmap_info =
        SkImageInfo::Make(width, height, info.colorType(), info.alphaType());
    if (!oriented_bitmap->tryAllocPixels(oriented_bitmap_info)) {
      return false;
    }
    SkCanvas canvas(*oriented_bitmap);
    auto matrix = SkEncodedOriginToMatrix(origin, width, height);
    canvas.setMatrix(matrix);
    auto image = SkImages::RasterFromBitmap(*bitmap);
    if (!image) {
      return false;
    }
    canvas.drawImage(image, 0, 0);
    oriented_bitmap->setImmutable();
    bitmap_info->bitmap =
        reinterpret_cast<skiac_bitmap*>(oriented_bitmap.release());
  } else {
    bitmap->setImmutable();
    bitmap_info->bitmap = reinterpret_cast<skiac_bitmap*>(bitmap.release());
  }
  bitmap_info->width = width;
  bitmap_info->height = height;
  return true;
}

bool skiac_bitmap_make_from_svg(const uint8_t* data,
                                size_t length,
                                float width,
                                float height,
                                skiac_bitmap_info* bitmap_info,
                                skiac_font_collection* c_collection,
                                uint8_t cs) {
  auto color_space = COLOR_SPACE_CAST;
  SkMemoryStream svg_stream(data, length, false);
  auto svg_dom =
      SkSVGDOM::Builder().setFontManager(c_collection->assets).make(svg_stream);
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
  // The caller's buffer is owned by a GC-managed object (ImageData, decoded
  // image) that may be freed while the bitmap is still referenced. Install an
  // owned copy instead of aliasing it, and fail rather than hand back a
  // silently empty bitmap.
  // https://github.com/Brooooooklyn/canvas/issues/1341
  if (!bitmap->tryAllocPixels(info) ||
      !bitmap->writePixels(SkPixmap(info, ptr, row_bytes), 0, 0)) {
    delete bitmap;
    return nullptr;
  }
  return reinterpret_cast<skiac_bitmap*>(bitmap);
}

// ImageData pattern copy: RGBA unpremul bytes in, premultiplied texels out, as
// putImageData stores them in a canvas and as createImageBitmap(imageData)
// does, so filtering never pulls transparent black into the color. A
// display-p3 ImageData (`cs` 1) is tagged so a draw converts it to the canvas
// color space, as putImageData and Chrome's pattern over
// createImageBitmap(imageData) do. An sRGB one stays untagged, which draws the
// same and keeps the PNG that the SVG output embeds unchanged.
skiac_bitmap* skiac_bitmap_make_premul_from_image_data(uint8_t* ptr,
                                                       size_t width,
                                                       size_t height,
                                                       size_t row_bytes,
                                                       uint8_t cs) {
  auto bitmap = new SkBitmap();
  const auto src_info = SkImageInfo::Make(
      (int)width, (int)height, kRGBA_8888_SkColorType, kUnpremul_SkAlphaType,
      cs == 0 ? nullptr : COLOR_SPACE_CAST);
  if (!bitmap->tryAllocPixels(src_info.makeAlphaType(kPremul_SkAlphaType)) ||
      !bitmap->writePixels(SkPixmap(src_info, ptr, row_bytes), 0, 0)) {
    delete bitmap;
    return nullptr;
  }
  return reinterpret_cast<skiac_bitmap*>(bitmap);
}

// The color space Chrome gives a CICP AVIF (avif_image_decoder.cc GetColorSpace
// and ui/gfx/color_space.cc GetTransferFunction), or null to leave it untagged.
// 2 (unspecified) means BT.709 primaries and the sRGB transfer, and Chrome
// draws the BT.709 family of transfers (1, 6, 14, 15) with the sRGB curve, not
// the 2.4 gamma that SkColorSpace::MakeCICP uses for them. Chrome cannot decode
// transfers 9-12, and tone maps PQ (16) and HLG (18), so those stay untagged.
static sk_sp<SkColorSpace> avif_cicp_color_space(uint16_t primaries,
                                                 uint16_t transfer) {
  switch (transfer) {
    case 1:
    case 2:
    case 6:
    case 14:
    case 15:
      transfer = 13;
      break;
    case 4:
    case 5:
    case 7:
    case 8:
    case 13:
    case 17:
      break;
    default:
      return nullptr;
  }
  primaries = primaries == 2 ? 1 : primaries;
  if (primaries > UINT8_MAX) {
    return nullptr;
  }
  return SkColorSpace::MakeCICP(
      static_cast<SkNamedPrimaries::CicpId>(primaries),
      static_cast<SkNamedTransferFn::CicpId>(transfer));
}

// Tag decoded AVIF pixels with the file's color space, as Chrome's AVIF
// decoder does (avif_image_decoder.cc:868-914): an ICC profile wins, else the
// CICP primaries and transfer. sRGB stays untagged, as before.
void skiac_bitmap_set_color_space(skiac_bitmap* c_bitmap,
                                  const uint8_t* icc,
                                  size_t icc_len,
                                  uint16_t primaries,
                                  uint16_t transfer) {
  sk_sp<SkColorSpace> color_space;
  if (icc && icc_len) {
    skcms_ICCProfile profile;
    if (skcms_Parse(icc, icc_len, &profile)) {
      color_space = SkColorSpace::Make(profile);
    }
  }
  if (!color_space) {
    color_space = avif_cicp_color_space(primaries, transfer);
  }
  if (color_space && !color_space->isSRGB()) {
    BITMAP_CAST->setColorSpace(std::move(color_space));
  }
}

size_t skiac_bitmap_get_width(skiac_bitmap* c_bitmap) {
  auto bitmap = reinterpret_cast<SkBitmap*>(c_bitmap);
  return bitmap->width();
}

size_t skiac_bitmap_get_height(skiac_bitmap* c_bitmap) {
  auto bitmap = reinterpret_cast<SkBitmap*>(c_bitmap);
  return bitmap->height();
}

void skiac_bitmap_set_immutable(skiac_bitmap* c_bitmap) {
  BITMAP_CAST->setImmutable();
}

// The image a pattern samples; Bitmap::make_image, for ImagePattern, is the
// only caller. It shares the bitmap's pixels, as Chrome shares one decoded
// image between all the patterns that use it. Sharing a mutable bitmap is safe
// because nothing writes to a bitmap after its skiac_bitmap_make_* factory
// returns: a new src or size makes a new bitmap. An immutable bitmap (decoded
// by SkCodec: PNG, JPEG, WebP, GIF, ...; an ImageData copy) is shared by
// RasterFromBitmap. That would copy a mutable one (SVG, AVIF), so it is
// wrapped instead, and the image holds a ref on its pixel ref. Null when the
// bitmap has no pixels.
skiac_image* skiac_bitmap_make_image(skiac_bitmap* c_bitmap) {
  if (BITMAP_CAST->isImmutable()) {
    return reinterpret_cast<skiac_image*>(
        SkImages::RasterFromBitmap(*BITMAP_CAST).release());
  }
  SkPixmap pixmap;
  if (!BITMAP_CAST->peekPixels(&pixmap)) {
    return nullptr;
  }
  auto pixel_ref = SkSafeRef(BITMAP_CAST->pixelRef());
  auto image = SkImages::RasterFromPixmap(
      pixmap,
      [](const void*, void* ctx) {
        SkSafeUnref(static_cast<SkPixelRef*>(ctx));
      },
      pixel_ref);
  if (!image) {
    // RasterFromPixmap calls the release proc only once it made the image.
    SkSafeUnref(pixel_ref);
    return nullptr;
  }
  return reinterpret_cast<skiac_image*>(image.release());
}

skiac_shader* skiac_image_make_pattern_shader(skiac_image* c_image,
                                              bool is_canvas,
                                              int repeat_x,
                                              int repeat_y,
                                              int filter_quality,
                                              skiac_transform c_ts) {
  const auto ts = conv_from_transform(c_ts);
  // A null image gives an empty shader, which paints nothing.
  auto shader = SkShaders::Image(
      sk_ref_sp(IMAGE_CAST), (SkTileMode)repeat_x, (SkTileMode)repeat_y,
      PatternSamplingOptions(filter_quality, is_canvas), &ts);
  return reinterpret_cast<skiac_shader*>(shader.release());
}

// PaintShader::CreateDecodedImage (cc/paint/paint_shader.cc:437-494): the
// decode level of an Image pattern drawn under `c_ctm`, or -1 when the target
// size rounds to empty, which draws nothing.
int skiac_image_pattern_level(int width,
                              int height,
                              skiac_transform c_ts,
                              skiac_transform c_ctm,
                              int filter_quality) {
  // Chrome's order: the pattern matrix, then preConcat the CTM.
  SkMatrix total = conv_from_transform(c_ts);
  total.preConcat(conv_from_transform(c_ctm));
  const CcDecodeKey key = CcDecodeKeyFor(SkISize::Make(width, height),
                                         SkIRect::MakeWH(width, height),
                                         SkM44(total), filter_quality);
  return key.empty ? -1 : key.level;
}

// An Image pattern's shader at a level from skiac_image_pattern_level, on a
// canvas in colour space `cs`: the original image (`c_image`) at level 0, the
// scaled copy of `c_bitmap` above it with the pattern matrix scaled back by
// the same factor (paint_shader.cc:458-465), and the empty shader at -1. A
// copy converted to `cs` stands in for the original when the image is in
// another colour space. `c_decoded_id` and `c_decoded_bytes` get the uniqueID
// and byte size of the copy the shader samples, which a recorded paint keeps;
// the size is 0 when it samples the original.
skiac_shader* skiac_image_make_decoded_pattern_shader(
    skiac_bitmap* c_bitmap,
    skiac_image* c_image,
    skiac_image_levels* c_levels,
    int level,
    int repeat_x,
    int repeat_y,
    int filter_quality,
    skiac_transform c_ts,
    uint8_t cs,
    uint32_t* c_decoded_id,
    size_t* c_decoded_bytes) {
  *c_decoded_id = 0;
  *c_decoded_bytes = 0;
  if (level < 0) {
    return reinterpret_cast<skiac_shader*>(SkShaders::Empty().release());
  }
  auto ts = conv_from_transform(c_ts);
  sk_sp<SkImage> image;
  SkPixmap original;
  if (!BITMAP_CAST->peekPixels(&original)) {
    // A null image gives an empty shader below.
  } else if (level == 0 && !ConversionTarget(original, cs)) {
    image = sk_ref_sp(IMAGE_CAST);
  } else {
    const SkIRect src = SkIRect::MakeSize(original.dimensions());
    const SkISize size = CcSizeForLevel(src.size(), level);
    image = FindOrMakeLevel(c_levels, original, src, size, cs);
    if (image) {
      *c_decoded_id = image->uniqueID();
      *c_decoded_bytes = image->imageInfo().computeMinByteSize();
    }
    const float adjust_x = static_cast<float>(size.width()) / src.width();
    const float adjust_y = static_cast<float>(size.height()) / src.height();
    const float inverse_x = 1.f / adjust_x;
    const float inverse_y = 1.f / adjust_y;
    ts.preScale(inverse_x, inverse_y);
  }
  // A null image gives an empty shader, which paints nothing.
  auto shader = SkShaders::Image(std::move(image), (SkTileMode)repeat_x,
                                 (SkTileMode)repeat_y,
                                 DecodedSampling(filter_quality), &ts);
  return reinterpret_cast<skiac_shader*>(shader.release());
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

uint32_t skiac_font_collection_register(
    skiac_font_collection* c_font_collection,
    const uint8_t* font,
    size_t length,
    const char* name_alias) {
  auto typeface_data = SkData::MakeWithCopy(font, length);
  auto typeface = c_font_collection->font_mgr->makeFromData(typeface_data);
  if (!typeface) {
    return 0;
  }
  uint32_t typeface_id;
  if (name_alias) {
    auto alias = SkString(name_alias);
    typeface_id = c_font_collection->assets->registerTypefaceWithTracking(
        typeface_data, typeface, alias);
  } else {
    typeface_id = c_font_collection->assets->registerTypefaceWithTracking(
        typeface_data, typeface);
  }
  if (typeface_id) {
    c_font_collection->markCachesDirty();
  }
  return typeface_id;
}

uint32_t skiac_font_collection_register_from_path(
    skiac_font_collection* c_font_collection,
    const char* font_path,
    const char* name_alias) {
  // Use lazy loading - don't load entire file into memory
  // System fonts are always on disk, so we just need to track the path for
  // rebuild
  auto typeface = c_font_collection->font_mgr->makeFromFile(font_path);
  if (!typeface) {
    return 0;
  }

  std::string path_str(font_path);
  uint32_t typeface_id;
  if (name_alias) {
    auto alias = SkString(name_alias);
    typeface_id =
        c_font_collection->assets->registerTypefaceFromPathWithTracking(
            path_str, typeface, alias);
  } else {
    typeface_id =
        c_font_collection->assets->registerTypefaceFromPathWithTracking(
            path_str, typeface);
  }
  if (typeface_id) {
    c_font_collection->markCachesDirty();
  }
  return typeface_id;
}

size_t skiac_font_collection_unregister(
    skiac_font_collection* c_font_collection,
    uint32_t typeface_id) {
  // Get aliases before removal so we can clean up set_aliases
  std::vector<std::string> removed_aliases;
  bool removed =
      c_font_collection->assets->removeTypeface(typeface_id, &removed_aliases);
  if (removed) {
    // Clean up set_aliases entries for this font's family names
    // This prevents stale aliases from transferring to newly registered fonts
    for (const auto& alias : removed_aliases) {
      auto it = c_font_collection->set_aliases.begin();
      while (it != c_font_collection->set_aliases.end()) {
        if (it->first == alias) {
          it = c_font_collection->set_aliases.erase(it);
        } else {
          ++it;
        }
      }
    }
    // Rebuild provider with remaining fonts (old provider is kept alive)
    c_font_collection->rebuildAssets();
    return 1;
  }
  return 0;
}

size_t skiac_font_collection_unregister_batch(
    skiac_font_collection* c_font_collection,
    const uint32_t* typeface_ids,
    size_t count) {
  size_t removed_count = 0;
  std::vector<std::string> all_removed_aliases;
  for (size_t i = 0; i < count; i++) {
    std::vector<std::string> removed_aliases;
    if (c_font_collection->assets->removeTypeface(typeface_ids[i],
                                                  &removed_aliases)) {
      removed_count++;
      // Collect all removed aliases for cleanup
      all_removed_aliases.insert(all_removed_aliases.end(),
                                 removed_aliases.begin(),
                                 removed_aliases.end());
    }
  }
  if (removed_count > 0) {
    // Clean up set_aliases entries for all removed fonts' family names
    for (const auto& alias : all_removed_aliases) {
      auto it = c_font_collection->set_aliases.begin();
      while (it != c_font_collection->set_aliases.end()) {
        if (it->first == alias) {
          it = c_font_collection->set_aliases.erase(it);
        } else {
          ++it;
        }
      }
    }
    // Single rebuild for all removals
    c_font_collection->rebuildAssets();
  }
  return removed_count;
}

size_t skiac_font_collection_unregister_all(
    skiac_font_collection* c_font_collection) {
  size_t removed_count = c_font_collection->assets->removeAllTypefaces();
  if (removed_count > 0) {
    // Clear all set_aliases since all fonts are removed
    c_font_collection->set_aliases.clear();
    c_font_collection->rebuildAssets();
  }
  return removed_count;
}

bool skiac_font_collection_set_alias(skiac_font_collection* c_font_collection,
                                     const char* family,
                                     const char* alias) {
  auto style = SkFontStyle();
  auto typeface = c_font_collection->assets->matchFamilyStyle(family, style);

  // Only proceed if the family exists
  if (!typeface) {
    return false;  // Family doesn't exist, don't store invalid mapping
  }

  // Check if this alias already points to the SAME typeface (true idempotency)
  // We compare by uniqueID rather than just checking if the alias exists,
  // because the alias might exist as a system font that we want to shadow.
  auto existing_typeface =
      c_font_collection->assets->matchFamilyStyle(alias, style);
  if (existing_typeface &&
      existing_typeface->uniqueID() == typeface->uniqueID()) {
    // Alias already points to the same typeface - true idempotency, no need to
    // re-register
    c_font_collection->set_aliases.insert(
        {std::string(family), std::string(alias)});
    return true;
  }

  // Track the alias for rebuild (only valid mappings, std::set
  // auto-deduplicates)
  c_font_collection->set_aliases.insert(
      {std::string(family), std::string(alias)});

  // Register the alias - this will shadow any existing font with the same name
  c_font_collection->assets->registerTypeface(std::move(typeface),
                                              SkString(alias));
  c_font_collection->markCachesDirty();
  return true;
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
  SkMemoryStream svg_stream(data, length, false);
  SkDynamicMemoryWStream w_stream;
  auto svg_dom =
      SkSVGDOM::Builder().setFontManager(c_collection->assets).make(svg_stream);
  auto svg_root = svg_dom->getRoot();
  auto svg_container_size =
      svg_root->intrinsicSize(SkSVGLengthContext(SkSize::Make(0, 0)));
  auto canvas =
      SkSVGCanvas::Make(SkRect::MakeSize(svg_container_size), &w_stream,
                        SkSVGCanvas::kConvertTextToPaths_Flag);
  svg_dom->render(canvas.get());
  canvas.reset();
  auto d = w_stream.detachAsData().release();
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
