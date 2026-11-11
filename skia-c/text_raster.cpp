// Canvas text rasterization. By default every OS draws the same way:
//
//              draw font                              text gamma / contrast
//   default    the shaping font                        Skia's defaults
//
// After setTextRenderer('system'), like each OS's Chrome:
//
//              draw font (CreateSkFont)               text gamma / contrast
//   macOS      subpixel AA edging, normal hinting      sRGB / 0
//              (none for geometricPrecision),          (skia/BUILD.gn
//              subpixel, linear metrics, no bitmaps     SK_GAMMA_SRGB)
//   Linux      AA edging, slight hinting (none +       1.2 / 0.2
//              linear metrics for geometricPrecision),
//              subpixel, embedded bitmaps
//   others     the shaping font                        Skia's defaults
//
// The scalers themselves (CoreText, Fontations, FreeType) are picked where
// typefaces are made (font_scalers.cpp). Any new per-OS text branch must
// also check SystemFontRenderer().

#if defined(__APPLE__)
#include <include/ports/SkTypeface_mac.h>
#endif

#include "text.hpp"
#include "text_raster.hpp"

#include <math.h>
#include <stdint.h>
#include <algorithm>
#include <limits>

#if defined(SK_DEBUG) || !defined(SK_RELEASE)
#error "skia-c must be built with SK_RELEASE like libskia (see build.rs)"
#endif

namespace {

constexpr int kGeometricPrecision = 3;

#if defined(__APPLE__)
// SkScalerContext.cpp too_big_for_lcd (SK_MAX_SIZE_FOR_LCDTEXT).
constexpr float kMaxSizeForLcdText = 48;
#endif

}  // namespace

SkSurfaceProps CanvasSurfaceProps() {
  if (!SystemFontRenderer()) {
    // SkTypes.h's text contrast and gamma (what SkSurfaceProps() gives on
    // desktop), spelled out: the Android libskia is built with
    // skia_use_fixed_gamma_text (SK_GAMMA_EXPONENT=1.4,
    // SK_GAMMA_CONTRAST=0.0), and the default text is the same on every OS.
    return SkSurfaceProps(0, kUnknown_SkPixelGeometry, 0.5f, 0.0f);
  }
#if defined(__APPLE__)
  // Chrome's skia/BUILD.gn for mac: SK_GAMMA_SRGB, SK_GAMMA_CONTRAST=0.0.
  return SkSurfaceProps(0, kUnknown_SkPixelGeometry, 0.0f, 0.0f);
#elif defined(__linux__) && !defined(__ANDROID__)
  // Chrome's skia/BUILD.gn for Linux: SK_GAMMA_EXPONENT=1.2,
  // SK_GAMMA_CONTRAST=0.2.
  return SkSurfaceProps(0, kUnknown_SkPixelGeometry, 0.2f, 1.2f);
#else
  return SkSurfaceProps();
#endif
}

SkFont MetricsFont(sk_sp<SkTypeface> typeface, float size) {
  SkFont font(std::move(typeface), size);
#if defined(__APPLE__)
  if (SystemFontRenderer()) {
    // font_platform_data_mac.mm FontPlatformData::CreateSkFont.
    font.setEdging(SkFont::Edging::kSubpixelAntiAlias);
    font.setHinting(SkFontHinting::kNormal);
    font.setSubpixel(true);
    font.setLinearMetrics(true);
    font.setEmbeddedBitmaps(false);
    return font;
  }
#endif
  // The shaping font's flags (ApplyShapingFlags' defaults) with subpixel
  // positioning, which Chrome Linux forces on for the canvas.
  font.setEdging(SkFont::Edging::kAntiAlias);
  font.setHinting(SkFontHinting::kSlight);
  font.setSubpixel(true);
  return font;
}

TextRasterPolicy::TextRasterPolicy(const skiac_text_request& request)
    : geometric_precision_(request.text_rendering == kGeometricPrecision),
      system_(SystemFontRenderer()) {
#if defined(__APPLE__)
  lcd_text_ = system_ && request.lcd_text;
#endif
}

void TextRasterPolicy::ApplyShapingFlags(SkFont* font) const {
  // skparagraph's TextStyle defaults, which OneLineShaper gave the font.
  font->setEdging(SkFont::Edging::kAntiAlias);
  font->setHinting(SkFontHinting::kSlight);
  font->setSubpixel(true);
  if (!system_) {
    return;
  }
#if defined(__APPLE__)
  font->setEdging(SkFont::Edging::kSubpixelAntiAlias);
  font->setHinting(SkFontHinting::kNormal);
#endif
}

#if defined(__APPLE__)
// Whether CoreText draws `font` from LCD masks, as Chrome's opaque canvas
// does: its surface has kRGB_H geometry (canvas_resource_provider.cc
// can_use_lcd_text, legacy_display_globals.cc), the bitmap device keeps it
// for a source-over draw (SkGlyphRunPainter.cpp drawForBitmapDevice) that is
// not too big for LCD (SkScalerContext.cpp too_big_for_lcd).
bool TextRasterPolicy::UsesLcdText(const SkFont& font,
                                   const SkMatrix& device) const {
  if (!lcd_text_ || device.hasPerspective()) {
    return false;
  }
  const float size = font.getSize();
  if (device.getType() & (SkMatrix::kScale_Mask | SkMatrix::kAffine_Mask)) {
    const float area = (device.getScaleX() * device.getScaleY() -
                        device.getSkewY() * device.getSkewX()) *
                       size * size;
    return !(area > kMaxSizeForLcdText * kMaxSizeForLcdText);
  }
  return !(size > kMaxSizeForLcdText);
}
#else
bool TextRasterPolicy::UsesLcdText(const SkFont&, const SkMatrix&) const {
  return false;
}
#endif

bool TextRasterPolicy::DrawFontUsesDevice() const {
#if defined(__APPLE__)
  return geometric_precision_ && lcd_text_;
#else
  return false;
#endif
}

SkFont TextRasterPolicy::DrawFont(const SkFont& shaped,
                                  const SkMatrix* device) const {
  if (!system_) {
    return shaped;
  }
  SkFont font = shaped;
#if defined(__APPLE__)
  // font_platform_data_mac.mm FontPlatformData::CreateSkFont.
  font.setEdging(SkFont::Edging::kSubpixelAntiAlias);
  font.setEmbeddedBitmaps(false);
  font.setSubpixel(true);
  font.setLinearMetrics(true);
  font.setForceAutoHinting(false);
  // geometricPrecision turns hinting off. A CoreText run that gets LCD masks
  // ignores that and draws hinted (SkTypeface_mac_ct.cpp onFilterRec).
  const bool unhinted =
      geometric_precision_ && !(device && UsesLcdText(font, *device) &&
                                SkTypeface_GetCTFontRef(font.getTypeface()));
  font.setHinting(unhinted ? SkFontHinting::kNone : SkFontHinting::kNormal);
#elif defined(__linux__) && !defined(__ANDROID__)
  // font_platform_data.cc CreateSkFont, WebFontRenderStyle::ApplyToSkFont
  // with Chrome's defaults (web_font_render_style.cc), and
  // QuerySystemRenderStyle for geometricPrecision.
  font.setEdging(SkFont::Edging::kAntiAlias);
  font.setEmbeddedBitmaps(true);
  font.setForceAutoHinting(false);
  font.setSubpixel(true);
  font.setHinting(geometric_precision_ ? SkFontHinting::kNone
                                       : SkFontHinting::kSlight);
  font.setLinearMetrics(geometric_precision_);
#else
  (void)device;
#endif
  return font;
}

SkPaint TextRasterPolicy::DrawPaint(const SkFont& draw_font,
                                    const SkPaint& paint) const {
  if (!system_) {
    return SkPaint(paint);
  }
  SkPaint draw_paint(paint);
#if defined(__APPLE__)
  // Chrome's Skia leaves SK_GAMMA_APPLY_TO_A8 undefined, so CoreText draws
  // unhinted A8 masks without the gamma pre-blend
  // (SkTypeface_mac_ct.cpp onFilterRec). Ours defines it (Skia's BUILD.gn
  // skia_private); a mask filter turns the pre-blend off too
  // (SkScalerContext.cpp PreprocessRec), and a blur this small leaves the
  // mask as it is.
  if (draw_font.getHinting() == SkFontHinting::kNone &&
      SkTypeface_GetCTFontRef(draw_font.getTypeface()) &&
      !draw_paint.getMaskFilter()) {
    draw_paint.setMaskFilter(
        SkMaskFilter::MakeBlur(kNormal_SkBlurStyle, 0.01f, false));
  }
#else
  (void)draw_font;
#endif
  return draw_paint;
}

void TextRasterPolicy::GlyphBounds(const SkFont& draw_font,
                                   SkSpan<const SkGlyphID> glyphs,
                                   SkSpan<SkRect> bounds) const {
  if (!system_) {
    // SkFont::getBounds: whole-pixel glyph boxes.
    draw_font.getBounds(glyphs, bounds, nullptr);
    return;
  }
#if defined(__APPLE__)
  // skia_text_metrics.cc GetPathBoundsForGlyph: the outline's bounds, the
  // glyph's metrics for one without an outline. Subpixel positioning is on,
  // so no rounding.
  struct Rec {
    SkRect* bounds;
    const SkFont* font;
    const SkGlyphID* glyph;
  } rec{bounds.data(), &draw_font, glyphs.data()};
  draw_font.getPaths(
      glyphs,
      [](const SkPath* path, const SkMatrix& matrix, void* ctx) {
        auto* rec = static_cast<Rec*>(ctx);
        if (path) {
          *rec->bounds = path->makeTransform(matrix).getBounds();
        } else {
          *rec->bounds = rec->font->getBounds(*rec->glyph, nullptr);
        }
        ++rec->bounds;
        ++rec->glyph;
      },
      &rec);
#else
  // SkFont::getBounds: whole-pixel glyph boxes.
  draw_font.getBounds(glyphs, bounds, nullptr);
#endif
}

namespace {

// size_f.h SizeF::clamp and SetToNextWidth / SetToNextHeight.
constexpr float kTrivialSize = 8.f * std::numeric_limits<float>::epsilon();

float ClampSize(float size) {
  return size > kTrivialSize ? size : 0.f;
}

float NextSize(float size) {
  return std::nextafter(std::max(kTrivialSize, size),
                        std::numeric_limits<float>::max());
}

BlinkRectF MakeRectF(float x, float y, float width, float height) {
  return {x, y, ClampSize(width), ClampSize(height)};
}

// skia_conversions.cc SkRectToRectF: rect_f.cc BoundingRect, which grows the
// size to the next float when x + width misses the right edge.
BlinkRectF SkRectToRectF(const SkRect& rect) {
  const float left = std::min(rect.fLeft, rect.fRight);
  const float top = std::min(rect.fTop, rect.fBottom);
  const float right = std::max(rect.fLeft, rect.fRight);
  const float bottom = std::max(rect.fTop, rect.fBottom);
  float width = right - left;
  float height = bottom - top;
  constexpr float kInfinity = std::numeric_limits<float>::infinity();
  if (left + width != right) {
    width = std::nextafter(width, kInfinity);
    if (std::isinf(width)) {
      width = std::numeric_limits<float>::max();
    }
  }
  if (top + height != bottom) {
    height = std::nextafter(height, kInfinity);
    if (std::isinf(height)) {
      height = std::numeric_limits<float>::max();
    }
  }
  return MakeRectF(left, top, width, height);
}

// rect_f.cc RectF::Union.
void Union(BlinkRectF* rect, const BlinkRectF& other) {
  if (rect->IsEmpty()) {
    *rect = other;
    return;
  }
  if (other.IsEmpty()) {
    return;
  }
  const float rx = std::min(rect->x, other.x);
  const float ry = std::min(rect->y, other.y);
  const float rr = std::max(rect->right(), other.right());
  const float rb = std::max(rect->bottom(), other.bottom());
  *rect = MakeRectF(rx, ry, rr - rx, rb - ry);
  constexpr float kFloatMax = std::numeric_limits<float>::max();
  if (rect->right() < rr && rect->width < kFloatMax) {
    rect->width = NextSize(rect->width);
  }
  if (rect->bottom() < rb && rect->height < kFloatMax) {
    rect->height = NextSize(rect->height);
  }
}

// glyph_bounds_accumulator.h GlyphBoundsAccumulator for a horizontal run.
struct GlyphBoundsAccumulator {
  float min_x = 0;
  float max_x = 0;
  float min_y = 0;
  float max_y = 0;

  void Unite(BlinkRectF glyph, float origin, SkPoint offset) {
    if (glyph.IsEmpty()) {
      return;
    }
    glyph.x = glyph.x + origin;
    glyph.x += offset.fX;
    glyph.y += offset.fY;
    if (min_x == 0 && max_x == 0) {
      min_x = glyph.x;
      max_x = glyph.right();
      min_y = glyph.y;
      max_y = glyph.bottom();
    } else {
      min_x = std::min(min_x, glyph.x);
      max_x = std::max(max_x, glyph.right());
      min_y = std::min(min_y, glyph.y);
      max_y = std::max(max_y, glyph.bottom());
    }
  }

  BlinkRectF Bounds() const {
    return MakeRectF(min_x, min_y, max_x - min_x, max_y - min_y);
  }
};

}  // namespace

// Each item's ShapeResult::ComputeInkBounds (PlainTextNode::Shape: outset
// to the left when the item is narrower than nothing), offset to the float
// sum of the widths of the items before it, united item by item in visual
// order.
BlinkRectF MeasureBlinkInk(const BlinkLine& line,
                           const TextRasterPolicy& policy,
                           float left_edge) {
  // The runs of each item, in visual order (an RTL base's reversed LTR
  // words are drawn from the last item, but measured from the first).
  std::vector<std::vector<size_t>> item_runs(line.item_widths.size());
  for (size_t r = 0; r < line.runs.size(); ++r) {
    item_runs[line.runs[r].item].push_back(r);
  }
  BlinkRectF ink;
  float xpos = 0;
  for (size_t item = 0; item < item_runs.size(); ++item) {
    BlinkRectF item_ink;
    for (const size_t r : item_runs[item]) {
      const BlinkRun& run = line.runs[r];
      const SkFont font = policy.DrawFont(run.font, nullptr);
      std::vector<SkRect> bounds(run.glyphs.size());
      policy.GlyphBounds(font, run.glyphs, bounds);
      GlyphBoundsAccumulator accumulator;
      for (size_t i = 0; i < run.glyphs.size(); ++i) {
        // SkFontGetBoundsForGlyphs rounds out without subpixel positioning.
        const SkRect box =
            font.isSubpixel() ? bounds[i] : SkRect::Make(bounds[i].roundOut());
        accumulator.Unite(SkRectToRectF(box), run.ink_x[i], run.offsets[i]);
      }
      Union(&item_ink, accumulator.Bounds());
    }
    const float width = line.item_widths[item];
    if (width < 0) {
      // Negative spacing can put glyphs left of the item's start: the box
      // covers them (gfx::RectF::Outset of the left side).
      const float left = std::min(width, item_ink.width);
      if (left < item_ink.x) {
        const float outset = item_ink.x - left;
        item_ink = MakeRectF(item_ink.x + -outset, item_ink.y,
                             item_ink.width - (-outset + -0.0f),
                             item_ink.height - (-0.0f + -0.0f));
      }
    }
    item_ink.x += xpos - left_edge;
    Union(&ink, item_ink);
    xpos += width;
  }
  return ink;
}
