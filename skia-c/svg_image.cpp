// SVG images src/svg_doc prepared, drawn by SkSVGDOM through a canvas that
// does what Chrome does where SkSVG cannot:
//
//   <image> raster      Chrome's decode-cache draw (DrawDecodedImage), at the
//                       element's image-rendering quality, AA, clamped to
//                       the source (graphics_context.cc:531-541)
//   <image> SVG         the nested document as vectors, clipped to its box
//                       (svg_image.cc:513-558)
//   <text>              the platform's draw font and paint, as canvas text
//                       draws (text_raster.hpp TextRasterPolicy)
//   font-family         Blink's font list: registered names, the per-OS
//                       generic families, then the standard font
//                       (font_families.cpp ResolveFontFamilies)

#include "svg_image.hpp"

#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <src/core/SkTextBlobPriv.h>

#include "text.hpp"
#include "text_raster.hpp"

#if defined(SK_DEBUG) || !defined(SK_RELEASE)
#error "skia-c must be built with SK_RELEASE like libskia (see build.rs)"
#endif

namespace napi_svg {
namespace {

constexpr char kImagePrefix[] = "napi-img:";
constexpr char kSvgPrefix[] = "napi-svg:";
constexpr char kFontPrefix[] = "napi-font:";

// The most nested SVG images one render draws. Each is drawn as vectors, so
// an image that holds ten copies of an image that holds ten copies ... costs
// ten times more per level; Chrome draws them all and slows down the same
// way. Past this, the rest are not drawn.
constexpr int kNestedDrawBudget = 1 << 17;

// The index after `prefix` in `name`, or -1.
long IndexAfter(const char* name, const char* prefix) {
  const size_t n = strlen(prefix);
  if (!name || strncmp(name, prefix, n) != 0) {
    return -1;
  }
  char* end = nullptr;
  const long index = strtol(name + n, &end, 10);
  return end != name + n && *end == '\0' && index >= 0 ? index : -1;
}

class StaticAsset final : public skresources::ImageAsset {
 public:
  explicit StaticAsset(sk_sp<SkImage> image) : image_(std::move(image)) {}
  bool isMultiFrame() override { return false; }
  FrameData getFrameData(float) override {
    return {image_, SkSamplingOptions(SkFilterMode::kLinear), SkMatrix::I(),
            SizeFit::kCenter};
  }

 private:
  sk_sp<SkImage> image_;
};

// The font-family lists of a document. SkSVGText asks for a typeface by
// the family attribute (napi-font:K); Blink's font list gives it.
class SvgFontMgr final : public SkFontMgr {
 public:
  SvgFontMgr(skiac_font_collection* c_collection,
             const skiac_svg_font_list* lists,
             size_t count)
      : c_collection_(c_collection) {
    lists_.resize(count);
    for (size_t i = 0; i < count; ++i) {
      for (size_t j = 0; j < lists[i].count; ++j) {
        const skiac_text_family& family = lists[i].families[j];
        lists_[i].push_back(
            {std::string(family.name ? family.name : "", family.name_len),
             family.generic});
      }
    }
  }

 protected:
  int onCountFamilies() const override { return assets()->countFamilies(); }
  void onGetFamilyName(int index, SkString* name) const override {
    assets()->getFamilyName(index, name);
  }
  sk_sp<SkFontStyleSet> onCreateStyleSet(int index) const override {
    return assets()->createStyleSet(index);
  }
  sk_sp<SkFontStyleSet> onMatchFamily(const char name[]) const override {
    return assets()->matchFamily(name);
  }
  sk_sp<SkTypeface> onMatchFamilyStyle(
      const char name[],
      const SkFontStyle& style) const override {
    return assets()->matchFamilyStyle(name, style);
  }
  sk_sp<SkTypeface> onMatchFamilyStyleCharacter(
      const char name[],
      const SkFontStyle& style,
      const char* bcp47[],
      int bcp47_count,
      SkUnichar character) const override {
    return assets()->matchFamilyStyleCharacter(name, style, bcp47, bcp47_count,
                                               character);
  }
  sk_sp<SkTypeface> onMakeFromData(sk_sp<SkData> data,
                                   int index) const override {
    return assets()->makeFromData(std::move(data), index);
  }
  sk_sp<SkTypeface> onMakeFromStreamIndex(std::unique_ptr<SkStreamAsset> stream,
                                          int index) const override {
    return assets()->makeFromStream(std::move(stream), index);
  }
  sk_sp<SkTypeface> onMakeFromStreamArgs(
      std::unique_ptr<SkStreamAsset> stream,
      const SkFontArguments& args) const override {
    return assets()->makeFromStream(std::move(stream), args);
  }
  sk_sp<SkTypeface> onMakeFromFile(const char path[],
                                   int index) const override {
    return assets()->makeFromFile(path, index);
  }

  // SkSVGText ResolveFont: the first family of the list that has a face for
  // `style` (FontFallbackList::GetFontData), or the standard font.
  sk_sp<SkTypeface> onLegacyMakeTypeface(const char name[],
                                         SkFontStyle style) const override {
    const long index = IndexAfter(name, kFontPrefix);
    static const std::vector<Family> kNone;
    const std::vector<Family>& list =
        index >= 0 && static_cast<size_t>(index) < lists_.size() ? lists_[index]
                                                                 : kNone;
    std::vector<skiac_text_family> families;
    families.reserve(list.size());
    for (const Family& family : list) {
      families.push_back(
          {family.name.data(), family.name.size(), family.generic});
    }
    skiac_text_request request{};
    request.families = families.data();
    request.family_count = families.size();
    c_collection_->flushCachesIfDirty();
    const std::vector<SkString> resolved =
        ResolveFontFamilies(c_collection_, request);
    const std::vector<sk_sp<SkTypeface>> faces =
        c_collection_->collection->findTypefaces(resolved, style);
    return faces.empty() ? nullptr : faces.front();
  }

 private:
  struct Family {
    std::string name;
    int generic;
  };

  // The collection's current assets: a font registered or removed since the
  // document was made is seen, as by canvas text.
  const sk_sp<TypefaceFontProviderCustom>& assets() const {
    return c_collection_->assets;
  }

  skiac_font_collection* c_collection_;
  std::vector<std::vector<Family>> lists_;
};

class Resources final : public skresources::ResourceProvider {
 public:
  struct Entry {
    // 0 raster, 1 SVG document.
    uint8_t kind = 0;
    // Raster: Blink's InterpolationQuality, 0 none, 1 low, 2 medium.
    uint8_t quality = 2;
    sk_sp<SkData> data;
    // SVG: the frame (rounded container) and the root's laid-out size.
    int frame_width = 0;
    int frame_height = 0;
    float root_width = 0;
    float root_height = 0;
    // Made on first use.
    sk_sp<SkImage> image;
    skiac_image_levels* levels = nullptr;
    sk_sp<SkPicture> picture;
    // The font collection's families_generation `picture` was recorded in.
    uint64_t picture_fonts = 0;
    bool loading = false;
  };

  Resources(const skiac_svg_resource* images,
            size_t count,
            sk_sp<SkFontMgr> font_mgr,
            skiac_font_collection* c_collection)
      : font_mgr_(std::move(font_mgr)), c_collection_(c_collection) {
    entries_.resize(count);
    // Rasters of one URL share their bytes in Rust; decode them once.
    std::unordered_map<const uint8_t*, size_t> first;
    for (size_t i = 0; i < count; ++i) {
      Entry& e = entries_[i];
      e.kind = images[i].kind;
      e.quality = images[i].quality;
      e.frame_width = images[i].frame_width;
      e.frame_height = images[i].frame_height;
      e.root_width = images[i].root_width;
      e.root_height = images[i].root_height;
      if (e.kind == 0) {
        auto [it, inserted] = first.emplace(images[i].data, i);
        if (!inserted) {
          shared_raster_[i] = it->second;
          continue;
        }
      }
      e.data = SkData::MakeWithCopy(images[i].data, images[i].length);
    }
  }

  ~Resources() override {
    for (Entry& e : entries_) {
      if (e.levels) {
        skiac_image_levels_destroy(e.levels, nullptr, nullptr);
      }
    }
  }

  sk_sp<skresources::ImageAsset> loadImageAsset(const char[],
                                                const char name[],
                                                const char[]) const override {
    auto* self = const_cast<Resources*>(this);
    long index = IndexAfter(name, kImagePrefix);
    if (index < 0) {
      index = IndexAfter(name, kSvgPrefix);
    }
    if (index < 0 || static_cast<size_t>(index) >= entries_.size()) {
      return nullptr;
    }
    sk_sp<SkImage> image = self->imageFor(static_cast<size_t>(index));
    if (!image) {
      return nullptr;
    }
    self->by_id_[image->uniqueID()] = static_cast<size_t>(index);
    return sk_make_sp<StaticAsset>(std::move(image));
  }

  // The entry `image` (from loadImageAsset) stands for, or null.
  Entry* find(const SkImage* image) {
    auto it = by_id_.find(image->uniqueID());
    return it == by_id_.end() ? nullptr : &entries_[it->second];
  }

  // The nested document of an SVG entry, recorded once and again after a
  // font is registered, removed or aliased: the picture keeps the typefaces
  // its text resolved to, where the top level resolves them at each render.
  sk_sp<SkPicture> picture(Entry* e) {
    const uint64_t fonts = c_collection_->families_generation;
    if ((e->picture && e->picture_fonts == fonts) || e->loading || !e->data) {
      return e->picture;
    }
    e->loading = true;
    e->picture = nullptr;
    e->picture_fonts = fonts;
    SkMemoryStream stream(e->data);
    // Not kept: the document refs this provider.
    sk_sp<SkSVGDOM> dom = SkSVGDOM::Builder()
                              .setFontManager(font_mgr_)
                              .setResourceProvider(sk_ref_sp(this))
                              .make(stream);
    if (dom) {
      const SkRect root = SkRect::MakeWH(e->root_width, e->root_height);
      dom->setContainerSize(SkSize::Make(e->root_width, e->root_height));
      SkPictureRecorder recorder;
      dom->render(recorder.beginRecording(root));
      e->picture = recorder.finishRecordingAsPicture();
    }
    e->loading = false;
    return e->picture;
  }

  int nested_draws_left = kNestedDrawBudget;

  // What the entries keep for the document's life: the encoded copies, the
  // decoded rasters (one per URL), their scaled copies and the nested
  // documents' pictures. Rasters are decoded at the first draw that needs
  // them, so this grows as the document draws.
  size_t retainedBytes() const {
    size_t bytes = 0;
    for (size_t i = 0; i < entries_.size(); ++i) {
      const Entry& e = entries_[i];
      if (e.data) {
        bytes += e.data->size();
      }
      if (e.levels) {
        bytes += skiac_image_levels_bytes(e.levels);
      }
      if (e.picture) {
        bytes += e.picture->approximateBytesUsed();
      }
      SkPixmap pixels;
      if (e.kind == 0 && e.image && !shared_raster_.count(i) &&
          e.image->peekPixels(&pixels)) {
        bytes += pixels.computeByteSize();
      }
    }
    return bytes;
  }

 private:
  sk_sp<SkImage> imageFor(size_t index) {
    auto shared = shared_raster_.find(index);
    Entry& e = entries_[index];
    if (e.image) {
      return e.image;
    }
    if (shared != shared_raster_.end()) {
      // The same pixels as another quality of the URL, in an image of its
      // own: images are told apart by uniqueID.
      sk_sp<SkImage> pixels = imageFor(shared->second);
      SkPixmap pixmap;
      if (pixels && pixels->peekPixels(&pixmap)) {
        e.image = SkImages::RasterFromPixmap(
            pixmap,
            [](const void*, void* context) {
              static_cast<SkImage*>(context)->unref();
            },
            pixels.release());
      }
      return e.image;
    }
    if (!e.data) {
      return nullptr;
    }
    if (e.kind == 0) {
      // As an Image decodes (premultiplied, EXIF-oriented).
      skiac_bitmap_info info{};
      if (skiac_bitmap_make_from_buffer(e.data->bytes(), e.data->size(),
                                        &info)) {
        auto* bitmap = reinterpret_cast<SkBitmap*>(info.bitmap);
        e.image = SkImages::RasterFromBitmap(*bitmap);
        delete bitmap;
      }
    } else if (e.frame_width > 0 && e.frame_height > 0) {
      // A stand-in with the frame's size: SkSVGImage maps its bounds onto
      // the <image> box, and ChromeSvgCanvas draws the document there.
      SkPictureRecorder recorder;
      recorder.beginRecording(SkRect::MakeIWH(e.frame_width, e.frame_height));
      e.image = SkImages::DeferredFromPicture(
          recorder.finishRecordingAsPicture(),
          SkISize::Make(e.frame_width, e.frame_height), nullptr, nullptr,
          SkImages::BitDepth::kU8, SkColorSpace::MakeSRGB());
    }
    return e.image;
  }

  std::vector<Entry> entries_;
  std::unordered_map<size_t, size_t> shared_raster_;
  std::unordered_map<uint32_t, size_t> by_id_;
  sk_sp<SkFontMgr> font_mgr_;
  skiac_font_collection* c_collection_;

  friend class ChromeSvgCanvas;
};

class ChromeSvgCanvas final : public SkNWayCanvas {
 public:
  ChromeSvgCanvas(SkCanvas* target, Resources* resources, uint8_t cs)
      : SkNWayCanvas(target->getBaseLayerSize().width(),
                     target->getBaseLayerSize().height()),
        target_(target),
        resources_(resources),
        cs_(cs) {
    this->addCanvas(target);
    this->setMatrix(target->getLocalToDevice());
  }

 protected:
  void onDrawImage2(const SkImage* image,
                    SkScalar x,
                    SkScalar y,
                    const SkSamplingOptions& sampling,
                    const SkPaint* paint) override {
    this->onDrawImageRect2(
        image, SkRect::Make(image->bounds()),
        SkRect::MakeXYWH(x, y, image->width(), image->height()), sampling,
        paint, kFast_SrcRectConstraint);
  }

  void onDrawImageRect2(const SkImage* image,
                        const SkRect& src,
                        const SkRect& dst,
                        const SkSamplingOptions& sampling,
                        const SkPaint* paint,
                        SrcRectConstraint constraint) override {
    Resources::Entry* e = resources_->find(image);
    if (!e) {
      SkNWayCanvas::onDrawImageRect2(image, src, dst, sampling, paint,
                                     constraint);
      return;
    }
    if (e->kind == 1) {
      this->drawNestedSvg(e, dst, paint);
      return;
    }
    // GraphicsContext::DrawImage (graphics_context.cc:531-541): the fill
    // flags (anti-aliased), drawn from the decode cache at the element's
    // interpolation quality and clamped to the source rect
    // (Image::kClampImageToSourceRect).
    SkPaint p = paint ? *paint : SkPaint();
    p.setAntiAlias(true);
    SkPixmap original;
    sk_sp<SkImage> raster = sk_ref_sp(const_cast<SkImage*>(image));
    if (!raster->peekPixels(&original)) {
      return;
    }
    if (!e->levels) {
      e->levels = skiac_image_levels_create();
    }
    const SkM44 matrix =
        this->getLocalToDevice() * SkM44(SkMatrix::RectToRect(src, dst));
    DrawDecodedImage(target_, nullptr, raster, original, e->levels, cs_, src,
                     dst, matrix, e->quality, p,
                     SkCanvas::kStrict_SrcRectConstraint);
  }

  // Blink draws SVG text with the platform's font flags, as canvas text
  // (FontPlatformData::CreateSkFont), where SkSVG sets its own (no
  // hinting, AA edging).
  void onDrawTextBlob(const SkTextBlob* blob,
                      SkScalar x,
                      SkScalar y,
                      const SkPaint& paint) override {
    skiac_text_request request{};
    const TextRasterPolicy policy(request);
    const SkMatrix device = this->getTotalMatrix();
    for (SkTextBlobRunIterator it(blob); !it.done(); it.next()) {
      const SkFont font = policy.DrawFont(it.font(), &device);
      const int count = static_cast<int>(it.glyphCount());
      SkTextBlobBuilder builder;
      const SkTextBlobBuilder::RunBuffer* run = nullptr;
      size_t scalars = 0;
      switch (it.positioning()) {
        case SkTextBlobRunIterator::kDefault_Positioning:
          run =
              &builder.allocRun(font, count, it.offset().x(), it.offset().y());
          break;
        case SkTextBlobRunIterator::kHorizontal_Positioning:
          run = &builder.allocRunPosH(font, count, it.offset().y());
          scalars = 1;
          break;
        case SkTextBlobRunIterator::kFull_Positioning:
          run = &builder.allocRunPos(font, count);
          scalars = 2;
          break;
        case SkTextBlobRunIterator::kRSXform_Positioning:
          run = &builder.allocRunRSXform(font, count);
          scalars = 4;
          break;
      }
      memcpy(run->glyphs, it.glyphs(), count * sizeof(SkGlyphID));
      if (scalars) {
        memcpy(run->pos, it.pos(), count * scalars * sizeof(SkScalar));
      }
      sk_sp<SkTextBlob> rebuilt = builder.make();
      if (rebuilt) {
        SkNWayCanvas::onDrawTextBlob(rebuilt.get(), x, y,
                                     policy.DrawPaint(font, paint));
      }
    }
  }

  // A nested document's picture plays back through this canvas, so its
  // images and text are drawn as above.
  void onDrawPicture(const SkPicture* picture,
                     const SkMatrix* matrix,
                     const SkPaint* paint) override {
    SkCanvas::onDrawPicture(picture, matrix, paint);
  }

 private:
  // SVGImage::DrawInternal (svg_image.cc:513-558): a layer for alpha, a
  // color filter or a blend mode; a hard clip to the box rounded out; the
  // root (laid out at the LayoutUnit-floored container size, measured in
  // img5.cjs) mapped onto the box, and its overflow clip.
  void drawNestedSvg(Resources::Entry* e,
                     const SkRect& dst,
                     const SkPaint* paint) {
    if (resources_->nested_draws_left <= 0) {
      return;
    }
    --resources_->nested_draws_left;
    sk_sp<SkPicture> picture = resources_->picture(e);
    if (!picture) {
      return;
    }
    SkAutoCanvasRestore restore(this, false);
    if (paint && (paint->getAlphaf() < 1 || paint->getColorFilter() ||
                  !paint->isSrcOver())) {
      this->saveLayer(&dst, paint);
    }
    this->save();
    this->clipRect(SkRect::Make(dst.roundOut()), false);
    const SkRect root = SkRect::MakeWH(e->root_width, e->root_height);
    this->concat(SkMatrix::RectToRect(root, dst));
    this->clipRect(root, true);
    this->drawPicture(picture);
  }

  SkCanvas* target_;
  Resources* resources_;
  uint8_t cs_;
};

}  // namespace

sk_sp<SkSVGDOM> MakePreparedDocument(
    SkStream& stream,
    skiac_font_collection* c_collection,
    const skiac_svg_resource* images,
    size_t image_count,
    const skiac_svg_font_list* fonts,
    size_t font_count,
    sk_sp<skresources::ResourceProvider>* resources) {
  auto font_mgr = sk_make_sp<SvgFontMgr>(c_collection, fonts, font_count);
  auto provider =
      sk_make_sp<Resources>(images, image_count, font_mgr, c_collection);
  sk_sp<SkSVGDOM> dom = SkSVGDOM::Builder()
                            .setFontManager(font_mgr)
                            .setResourceProvider(provider)
                            .make(stream);
  *resources = std::move(provider);
  return dom;
}

void RenderPrepared(SkSVGDOM* dom,
                    skresources::ResourceProvider* resources,
                    SkCanvas* canvas,
                    uint8_t cs) {
  auto* provider = static_cast<Resources*>(resources);
  provider->nested_draws_left = kNestedDrawBudget;
  ChromeSvgCanvas chrome(canvas, provider, cs);
  dom->render(&chrome);
}

size_t RetainedBytes(const skresources::ResourceProvider* resources) {
  return static_cast<const Resources*>(resources)->retainedBytes();
}

}  // namespace napi_svg

extern "C" {

// The size of an encoded image as an Image decodes it (EXIF-oriented); false
// when Skia cannot decode it.
bool skiac_svg_image_size(const uint8_t* data,
                          size_t length,
                          int* width,
                          int* height) {
  auto codec = SkCodec::MakeFromData(SkData::MakeWithoutCopy(data, length));
  if (!codec) {
    return false;
  }
  SkISize size = codec->dimensions();
  if (SkEncodedOriginSwapsWidthHeight(codec->getOrigin())) {
    size = SkISize::Make(size.height(), size.width());
  }
  *width = size.width();
  *height = size.height();
  return !size.isEmpty();
}

}  // extern "C"
