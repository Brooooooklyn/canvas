#ifndef SKIA_CAPI_H
#define SKIA_CAPI_H

#include <include/codec/SkCodec.h>
#include <include/codec/SkEncodedImageFormat.h>
#include <include/core/SkAnnotation.h>
#include <include/core/SkBBHFactory.h>
#include <include/core/SkBitmap.h>
#include <include/core/SkBlender.h>
#include <include/core/SkBlurTypes.h>
#include <include/core/SkCanvas.h>
#include <include/core/SkColorFilter.h>
#include <include/core/SkColorSpace.h>
#include <include/core/SkData.h>
#include <include/core/SkDrawable.h>
#include <include/core/SkFontMgr.h>
#include <include/core/SkGraphics.h>
#include <include/core/SkM44.h>
#include <include/core/SkMaskFilter.h>
#include <include/core/SkPaint.h>
#include <include/core/SkPathBuilder.h>
#include <include/core/SkPathEffect.h>
#include <include/core/SkPathUtils.h>
#include <include/core/SkPicture.h>
#include <include/core/SkPictureRecorder.h>
#include <include/core/SkPixelRef.h>
#include <include/core/SkRRect.h>
#include <include/core/SkRegion.h>
#include <include/core/SkSamplingOptions.h>
#include <include/core/SkStream.h>
#include <include/core/SkString.h>
#include <include/core/SkStrokeRec.h>
#include <include/core/SkSurface.h>
#include <include/core/SkTextBlob.h>
#include <include/core/SkVertices.h>
#include <include/docs/SkPDFDocument.h>
#include <include/docs/SkPDFJpegHelpers.h>
#include <include/effects/SkColorMatrix.h>
#include <include/effects/SkCornerPathEffect.h>
#include <include/effects/SkDashPathEffect.h>
#include <include/effects/SkGradient.h>
#include <include/effects/SkImageFilters.h>
#include <include/effects/SkTrimPathEffect.h>
#include <include/encode/SkJpegEncoder.h>
#include <include/encode/SkPngEncoder.h>
#include <include/encode/SkWebpEncoder.h>
#include <include/pathops/SkPathOps.h>
#include <include/svg/SkSVGCanvas.h>
#include <include/utils/SkNWayCanvas.h>
#include <include/utils/SkParsePath.h>
#include <modules/skottie/include/Skottie.h>
#include <modules/skparagraph/include/FontCollection.h>
#include <modules/skparagraph/include/Paragraph.h>
#include <modules/skparagraph/include/ParagraphBuilder.h>
#include <modules/skparagraph/include/TypefaceFontProvider.h>
#include <modules/skparagraph/src/ParagraphBuilderImpl.h>
#include <modules/skparagraph/src/ParagraphImpl.h>
#include <modules/skresources/include/SkResources.h>
#include <modules/skunicode/include/SkUnicode_icu.h>
#include <modules/svg/include/SkSVGDOM.h>
#include <modules/svg/include/SkSVGNode.h>
#include <modules/svg/include/SkSVGRenderContext.h>
#include <modules/svg/include/SkSVGSVG.h>
#include <src/core/SkFontDescriptor.h>
#include <src/core/SkRectPriv.h>
#include <src/ports/SkFontMgr_custom.h>
#include <src/shaders/SkShaderBase.h>
#include <src/text/GlyphRun.h>
#include <src/xml/SkDOM.h>
#include <src/xml/SkXMLWriter.h>
#include <algorithm>
#include <cstring>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <tuple>
#include <unordered_set>
#include <vector>

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
typedef struct skiac_image_levels skiac_image_levels;
typedef struct skiac_sk_string skiac_sk_string;
typedef struct skiac_font_metrics skiac_font_metrics;
typedef struct skiac_typeface skiac_typeface;
typedef struct skiac_font_mgr skiac_font_mgr;
typedef struct skiac_typeface_font_provider skiac_typeface_font_provider;
typedef struct skiac_w_memory_stream skiac_w_memory_stream;
typedef struct skiac_picture_recorder skiac_picture_recorder;
typedef struct skiac_picture skiac_picture;
typedef struct skiac_drawable skiac_drawable;
typedef struct skiac_encoder skiac_encoder;
typedef struct skiac_document skiac_document;
typedef struct skiac_skottie_animation skiac_skottie_animation;
typedef struct skiac_svg_document skiac_svg_document;

#if defined(WIN32) || defined(_WIN32) || defined(__WIN32__) || defined(__NT__)
#define SK_FONT_FILE_PREFIX "C:/Windows/Fonts"
#elif __APPLE__
#define SK_FONT_FILE_PREFIX "/System/Library/Fonts/"
#elif __linux__
#define SK_FONT_FILE_PREFIX "/usr/share/fonts/"
#endif

sk_sp<SkFontMgr> SkFontMgr_New_Custom_Directory(const char* dir);

sk_sp<SkFontMgr> SkFontMgr_New_Custom_Empty();

// font_scalers.cpp: typefaces drawn by FreeType, or after
// setTextRenderer('system') by the scaler of each OS's Chrome.
// Whether setTextRenderer('system') is on. Set only under the font lock.
bool SystemFontRenderer();
void SetSystemFontRenderer(bool enabled);
// The installed fonts the collection resolves by name before loadSystemFonts
// (none on macOS with the system renderer).
sk_sp<SkFontMgr> MakeInstalledFontManager();
// A registered (web) font, or a font file loadFontsFromDir finds: face 0.
sk_sp<SkTypeface> MakeCanvasTypeface(std::unique_ptr<SkStreamAsset> stream);
sk_sp<SkTypeface> MakeCanvasTypeface(sk_sp<SkData> data);
sk_sp<SkTypeface> MakeCanvasTypefaceFromFile(const char* path);
#if defined(__APPLE__)
// Every font CoreText lists, by name.
sk_sp<SkFontMgr> MakeCoreTextFontManager();
// The family "system-ui": CoreText's UI font and its bold, italic and bold
// italic; `ids` gets their typeface ids.
sk_sp<SkFontMgr> MakeSystemUiFontManager(std::set<SkTypefaceID>* ids);
// A CoreText typeface's style from its font's traits. SkTypeface::fontStyle
// takes them from the font's descriptor, which for CoreText's italic UI font
// (CTFontCreateCopyWithSymbolicTraits) and its instances has only the italic
// trait: upright 400 to Skia.
SkFontStyle CoreTextFontStyle(SkTypeface* face);
#endif
// text_raster.cpp: the text gamma and contrast of Chrome's canvas surfaces
// with the system renderer, else Skia's defaults.
SkSurfaceProps CanvasSurfaceProps();
// skia_c.cpp: draws `src` of a raster as Chrome draws an image from its
// decode cache (DrawImageRectOp::RasterWithFlags). Returns the decode it drew
// in place of the source, or null.
sk_sp<SkImage> DrawDecodedImage(
    SkCanvas* canvas,
    const SkBitmap* bitmap,
    const sk_sp<SkImage>& snapshot,
    const SkPixmap& original,
    skiac_image_levels* levels,
    uint8_t cs,
    const SkRect& src,
    const SkRect& dst,
    const SkM44& matrix,
    int fq,
    const SkPaint& paint,
    SkCanvas::SrcRectConstraint constraint = SkCanvas::kFast_SrcRectConstraint);

enum class CssBaseline {
  Top,
  Hanging,
  Middle,
  Alphabetic,
  Ideographic,
  Bottom,
};

// Compute stable content-based ID from font data using FNV-1a hash
// IMPORTANT: Never returns 0 because Rust wrapper treats 0 as failure
inline uint32_t computeFontContentHash(const sk_sp<SkData>& data) {
  if (!data)
    return 1;  // Use 1 instead of 0 (0 means failure to Rust)
  const uint8_t* bytes = static_cast<const uint8_t*>(data->data());
  size_t size = data->size();
  // FNV-1a hash
  uint32_t hash = 2166136261u;
  for (size_t i = 0; i < size && i < 1024; i++) {  // Hash first 1KB for speed
    hash ^= bytes[i];
    hash *= 16777619u;
  }
  // Include size in hash to differentiate similar prefixes
  hash ^= static_cast<uint32_t>(size);
  return hash ? hash : 1;  // Never return 0
}

// Compute stable content-based ID from file path using FNV-1a hash
// IMPORTANT: Never returns 0 because Rust wrapper treats 0 as failure
inline uint32_t computePathHash(const std::string& path) {
  if (path.empty())
    return 1;  // Use 1 for empty path (0 means failure to Rust)
  uint32_t hash = 2166136261u;
  for (char c : path) {
    hash ^= static_cast<uint8_t>(c);
    hash *= 16777619u;
  }
  return hash ? hash : 1;  // Never return 0
}

// Stores font data needed to recreate a typeface after rebuild
struct RegisteredFont {
  sk_sp<SkData> data;  // For buffer-registered fonts (null for path-registered)
  std::string path;  // For path-registered fonts (empty for buffer-registered)
  // An installed font (macOS loadSystemFonts): no data or path, only the
  // typeface.
  bool installed = false;
  // The face registered now. A rebuild that cannot make the font again (its
  // file is gone, or the new renderer mode cannot read it, as Fontations a
  // Type 1 font) registers this one again, so the font keeps its FontKey and
  // the next rebuild tries again.
  sk_sp<SkTypeface> typeface;
  std::vector<std::string> aliases;  // All aliases for this font
  // When each alias was registered (parallel to aliases). A rebuild
  // registers every (face, alias) pair again in this order, so the
  // provider's first family (its fallback, onLegacyMakeTypeface) and the
  // first face of a family stay as in a process that never rebuilt.
  std::vector<uint64_t> orders;
};

class TypefaceFontProviderCustom : public TypefaceFontProvider {
 public:
  explicit TypefaceFontProviderCustom(sk_sp<SkFontMgr> mgr)
      : font_mgr(std::move(mgr)) {}

  ~TypefaceFontProviderCustom() {};

  // Get font manager for rebuild
  sk_sp<SkFontMgr> getFontMgr() const { return font_mgr; }

  // Get registered fonts for rebuild
  const std::map<uint32_t, RegisteredFont>& getRegisteredFonts() const {
    return registered_fonts;
  }

  // Register typeface with data tracking for rebuild capability
  uint32_t registerTypefaceWithTracking(sk_sp<SkData> data,
                                        sk_sp<SkTypeface> typeface) {
    if (!typeface || !data) {
      return 0;
    }
    // Use content-based hash instead of uniqueID for stable deduplication
    uint32_t content_hash = computeFontContentHash(data);

    // First, check the secondary index for existing registration with same
    // content This handles the case where the probe chain was broken by a
    // removal
    auto index_it = content_hash_index.find(content_hash);
    if (index_it != content_hash_index.end()) {
      for (uint32_t existing_id : index_it->second) {
        auto font_it = registered_fonts.find(existing_id);
        if (font_it != registered_fonts.end() && font_it->second.data) {
          if (font_it->second.data->size() == data->size() &&
              memcmp(font_it->second.data->data(), data->data(),
                     data->size()) == 0) {
            // Found matching content via index - true duplicate
            return existing_id;
          }
        }
      }
    }

    // Find an available slot using linear probe
    uint32_t id = content_hash;
    while (registered_fonts.find(id) != registered_fonts.end()) {
      id++;
      if (id == 0) {
        return 0;  // Overflow protection - treat as registration failure
      }
    }

    // Get original family name
    SkString familyName;
    typeface->getFamilyName(&familyName);
    std::string originalName = std::string(familyName.c_str());

    // Store font data with original family name for rebuild
    RegisteredFont font_info;
    font_info.data = data;
    font_info.typeface = typeface;
    font_info.aliases.push_back(
        originalName);  // Track under what name it's registered
    font_info.orders.push_back(++registrations);
    registered_fonts[id] = std::move(font_info);

    // Update secondary index
    content_hash_index[content_hash].insert(id);

    this->registerTypeface(std::move(typeface));
    return id;
  }

  uint32_t registerTypefaceWithTracking(sk_sp<SkData> data,
                                        sk_sp<SkTypeface> typeface,
                                        const SkString& alias) {
    if (!typeface || !data) {
      return 0;
    }
    // Use content-based hash instead of uniqueID for stable deduplication
    uint32_t content_hash = computeFontContentHash(data);
    std::string aliasStr = std::string(alias.c_str());

    // Get original family name from typeface
    SkString familyName;
    typeface->getFamilyName(&familyName);
    std::string originalName = std::string(familyName.c_str());

    // First, check the secondary index for existing registration with same
    // content This handles the case where the probe chain was broken by a
    // removal
    auto index_it = content_hash_index.find(content_hash);
    if (index_it != content_hash_index.end()) {
      for (uint32_t existing_id : index_it->second) {
        auto font_it = registered_fonts.find(existing_id);
        if (font_it != registered_fonts.end() && font_it->second.data) {
          if (font_it->second.data->size() == data->size() &&
              memcmp(font_it->second.data->data(), data->data(),
                     data->size()) == 0) {
            // Found matching content via index - true duplicate, add alias if
            // new
            auto& aliases = font_it->second.aliases;
            if (std::find(aliases.begin(), aliases.end(), aliasStr) ==
                aliases.end()) {
              aliases.push_back(aliasStr);
              font_it->second.orders.push_back(++registrations);
              this->registerTypeface(typeface, alias);
            }
            return existing_id;
          }
        }
      }
    }

    // Find an available slot using linear probe
    uint32_t id = content_hash;
    while (registered_fonts.find(id) != registered_fonts.end()) {
      id++;
      if (id == 0) {
        return 0;  // Overflow protection - treat as registration failure
      }
    }

    // Store font data - avoid duplicates if alias equals original name
    RegisteredFont font_info;
    font_info.data = data;
    font_info.typeface = typeface;
    font_info.aliases.push_back(originalName);  // Track original name
    font_info.orders.push_back(++registrations);

    // Only add alias if different from original name
    if (aliasStr != originalName) {
      font_info.aliases.push_back(aliasStr);
      font_info.orders.push_back(++registrations);
    }
    registered_fonts[id] = std::move(font_info);

    // Update secondary index
    content_hash_index[content_hash].insert(id);

    // Register under original name
    this->registerTypeface(typeface);

    // Only register under alias if different from original
    if (aliasStr != originalName) {
      this->registerTypeface(std::move(typeface), alias);
    }
    return id;
  }

  // An installed font (macOS loadSystemFonts). Returns its ID, 0 on failure.
  uint32_t registerInstalledTypeface(sk_sp<SkTypeface> typeface) {
    if (!typeface) {
      return 0;
    }
    uint32_t id = computePathHash("\x01installed:" +
                                  std::to_string(typeface->uniqueID()));
    while (registered_fonts.find(id) != registered_fonts.end()) {
      id++;
      if (id == 0) {
        return 0;
      }
    }
    SkString family;
    typeface->getFamilyName(&family);
    RegisteredFont font_info;
    font_info.installed = true;
    font_info.typeface = typeface;
    font_info.aliases.push_back(std::string(family.c_str()));
    font_info.orders.push_back(++registrations);
    registered_fonts[id] = std::move(font_info);
    this->registerTypeface(std::move(typeface));
    return id;
  }

  // A rebuild: the font `id` of the old provider, made again as `typeface`
  // (its FontKey stays), with no name yet. addRebuiltAlias registers it
  // under each of its names.
  void addRebuiltFont(uint32_t id,
                      const RegisteredFont& old,
                      sk_sp<SkTypeface> typeface) {
    RegisteredFont font_info;
    font_info.data = old.data;
    font_info.path = old.path;
    font_info.installed = old.installed;
    font_info.typeface = std::move(typeface);
    registered_fonts[id] = std::move(font_info);

    // Update secondary index
    uint32_t content_hash;
    if (old.installed) {
      content_hash = 0;
    } else if (!old.path.empty()) {
      content_hash = computePathHash(old.path);
    } else if (old.data) {
      content_hash = computeFontContentHash(old.data);
    } else {
      content_hash = id;  // Fallback to id if no path or data
    }
    if (content_hash) {
      content_hash_index[content_hash].insert(id);
    }
  }

  // A rebuild: registers the font `id` (addRebuiltFont) under `name`.
  void addRebuiltAlias(uint32_t id, const std::string& name) {
    RegisteredFont& font_info = registered_fonts.at(id);
    font_info.aliases.push_back(name);
    font_info.orders.push_back(++registrations);
    this->registerTypeface(font_info.typeface, SkString(name.c_str()));
  }

  /**
   * Register a typeface from a file path.
   *
   * Fonts are deduplicated by path string: if the same path is registered
   * multiple times, subsequent calls return the existing ID without re-reading
   * the file. This is intentional to prevent memory waste from duplicate
   * registrations.
   *
   * IMPORTANT: Path-based deduplication means that if a font file is modified
   * on disk and this function is called again with the same path, the new
   * contents will NOT be loaded - it will return the existing registration.
   *
   * To reload a font after modifying the file on disk:
   * 1. Call removeTypeface() with the existing ID
   * 2. Call this function again to register the updated font
   *
   * @param path The file path to the font
   * @param typeface The typeface created from the font file
   * @return The font ID (content hash), or 0 on failure
   */
  uint32_t registerTypefaceFromPathWithTracking(const std::string& path,
                                                sk_sp<SkTypeface> typeface) {
    if (!typeface) {
      return 0;
    }
    // Use path-based hash instead of uniqueID for stable deduplication
    uint32_t content_hash = computePathHash(path);

    // First, check the secondary index for existing registration with same path
    // This handles the case where the probe chain was broken by a removal
    auto index_it = content_hash_index.find(content_hash);
    if (index_it != content_hash_index.end()) {
      for (uint32_t existing_id : index_it->second) {
        auto font_it = registered_fonts.find(existing_id);
        if (font_it != registered_fonts.end() &&
            !font_it->second.path.empty() && font_it->second.path == path) {
          // Found matching path via index - true duplicate
          return existing_id;
        }
      }
    }

    // Find an available slot using linear probe
    uint32_t id = content_hash;
    while (registered_fonts.find(id) != registered_fonts.end()) {
      id++;
      if (id == 0) {
        return 0;  // Overflow protection - treat as registration failure
      }
    }

    // Get original family name
    SkString familyName;
    typeface->getFamilyName(&familyName);
    std::string originalName = std::string(familyName.c_str());

    // Store path (not data) with original family name for rebuild
    RegisteredFont font_info;
    font_info.path = path;
    font_info.typeface = typeface;
    font_info.aliases.push_back(originalName);
    font_info.orders.push_back(++registrations);
    registered_fonts[id] = std::move(font_info);

    // Update secondary index
    content_hash_index[content_hash].insert(id);

    this->registerTypeface(std::move(typeface));
    return id;
  }

  uint32_t registerTypefaceFromPathWithTracking(const std::string& path,
                                                sk_sp<SkTypeface> typeface,
                                                const SkString& alias) {
    if (!typeface) {
      return 0;
    }
    // Use path-based hash instead of uniqueID for stable deduplication
    uint32_t content_hash = computePathHash(path);
    std::string aliasStr = std::string(alias.c_str());

    // Get original family name from typeface
    SkString familyName;
    typeface->getFamilyName(&familyName);
    std::string originalName = std::string(familyName.c_str());

    // First, check the secondary index for existing registration with same path
    // This handles the case where the probe chain was broken by a removal
    auto index_it = content_hash_index.find(content_hash);
    if (index_it != content_hash_index.end()) {
      for (uint32_t existing_id : index_it->second) {
        auto font_it = registered_fonts.find(existing_id);
        if (font_it != registered_fonts.end() &&
            !font_it->second.path.empty() && font_it->second.path == path) {
          // Found matching path via index - true duplicate, add alias if new
          auto& aliases = font_it->second.aliases;
          if (std::find(aliases.begin(), aliases.end(), aliasStr) ==
              aliases.end()) {
            aliases.push_back(aliasStr);
            font_it->second.orders.push_back(++registrations);
            this->registerTypeface(typeface, alias);
          }
          return existing_id;
        }
      }
    }

    // Find an available slot using linear probe
    uint32_t id = content_hash;
    while (registered_fonts.find(id) != registered_fonts.end()) {
      id++;
      if (id == 0) {
        return 0;  // Overflow protection - treat as registration failure
      }
    }

    // Store path (not data) - avoid duplicates if alias equals original name
    RegisteredFont font_info;
    font_info.path = path;
    font_info.typeface = typeface;
    font_info.aliases.push_back(originalName);
    font_info.orders.push_back(++registrations);

    // Only add alias if different from original name
    if (aliasStr != originalName) {
      font_info.aliases.push_back(aliasStr);
      font_info.orders.push_back(++registrations);
    }
    registered_fonts[id] = std::move(font_info);

    // Update secondary index
    content_hash_index[content_hash].insert(id);

    // Register under original name
    this->registerTypeface(typeface);

    // Only register under alias if different from original
    if (aliasStr != originalName) {
      this->registerTypeface(std::move(typeface), alias);
    }
    return id;
  }

  // Remove typeface from tracking
  // Note: caller must also clean up set_aliases in skiac_font_collection
  // to prevent stale alias persistence bug
  bool removeTypeface(uint32_t typeface_id,
                      std::vector<std::string>* removed_aliases = nullptr) {
    auto it = registered_fonts.find(typeface_id);
    if (it == registered_fonts.end()) {
      return false;
    }

    // Return the aliases so caller can clean up set_aliases
    if (removed_aliases) {
      *removed_aliases = it->second.aliases;
    }

    // Get the content hash to update the secondary index
    uint32_t content_hash;
    const auto& font_info = it->second;
    if (!font_info.path.empty()) {
      // Path-registered font
      content_hash = computePathHash(font_info.path);
    } else if (font_info.data) {
      // Buffer-registered font
      content_hash = computeFontContentHash(font_info.data);
    } else {
      // No data - just erase
      registered_fonts.erase(it);
      return true;
    }

    // Remove from secondary index
    auto index_it = content_hash_index.find(content_hash);
    if (index_it != content_hash_index.end()) {
      index_it->second.erase(typeface_id);
      if (index_it->second.empty()) {
        content_hash_index.erase(index_it);
      }
    }

    registered_fonts.erase(it);
    return true;
  }

  // Remove all typefaces from tracking
  // Note: caller must also clear set_aliases in skiac_font_collection
  size_t removeAllTypefaces() {
    size_t count = registered_fonts.size();
    registered_fonts.clear();
    content_hash_index.clear();
    return count;
  }

 private:
  sk_sp<SkFontMgr> font_mgr;
  std::map<uint32_t, RegisteredFont> registered_fonts;
  uint64_t registrations = 0;
  // Secondary index: content hash -> set of registered IDs with that hash
  // This enables fast duplicate detection even after removals break the probe
  // chain. Complexity is O(k) where k is the number of hash collisions
  // (typically 1-2).
  std::map<uint32_t, std::set<uint32_t>> content_hash_index;
};

struct skiac_svg_surface {
  skiac_w_memory_stream* stream;
  skiac_surface* surface;
  skiac_canvas* canvas;
};

// text.cpp: the laid out lines of recent requests and other text work,
// kept by the font collection.
struct TextCaches;
struct TextCachesDeleter {
  void operator()(TextCaches* caches) const;
};

struct skiac_font_collection {
  sk_sp<FontCollection> collection;
  // FontCollection's asset font manager, asked by name after `assets`:
  // FreeType over SK_FONT_FILE_PREFIX (SkFontMgr_Custom). With the system
  // renderer on macOS it is null until loadSystemFonts turns CoreText's on.
  // On Android the
  // prefix is /usr/share/fonts/, which is not there, so it has no fonts;
  // loadSystemFonts puts /system/fonts in `assets` instead. Only CoreText
  // picks a fallback font for a character no family has: SkFontMgr_Custom
  // and TypefaceFontProvider (`assets`) return null from
  // onMatchFamilyStyleCharacter, so on Linux, Windows and Android such a
  // character draws the first font's .notdef.
  // Registered fonts are made by MakeCanvasTypeface.
  sk_sp<SkFontMgr> font_mgr;
  sk_sp<TypefaceFontProviderCustom> assets;
  // Keep old providers alive to avoid destruction issues
  std::vector<sk_sp<TypefaceFontProviderCustom>> retired_assets;
  // Track setAlias mappings for rebuild: {family, alias} pairs, in call
  // order, so an alias of an alias is replayed after the alias it names.
  std::vector<std::pair<std::string, std::string>> set_aliases;

  void addSetAlias(const char* family, const char* alias) {
    std::pair<std::string, std::string> entry(family, alias);
    if (std::find(set_aliases.begin(), set_aliases.end(), entry) ==
        set_aliases.end()) {
      set_aliases.push_back(std::move(entry));
    }
  }
  // Set when the dynamic provider gains a face or an alias. FontCollection
  // memoizes findTypefaces() per {family list, weight, slant}, including
  // fallback misses, so any such change can invalidate an existing match.
  bool caches_dirty = false;
  // font_families.cpp: every registered and system family name by its
  // case-folded spelling, rebuilt when families_generation moves.
  std::map<std::string, std::vector<std::string>> folded_families;
  std::set<std::string> folded_registered_families;
  uint64_t families_generation = 1;
  uint64_t folded_families_generation = 0;
  // Fonts loadSystemFonts / loadFontsFromDir registered (font_families.cpp
  // skiac_font_collection_register_system_font): Blink keeps tiny system
  // fonts' ascent and descent unrounded, never a web font's.
  std::set<uint32_t> system_font_ids;
  std::set<SkTypefaceID> system_typeface_ids;
  // text_words.cpp CanShapeWordByWord: whether a face's GPOS / GSUB lookups
  // touch the space glyph, per typeface (cleared with the match caches).
  std::map<SkTypefaceID, uint8_t> space_in_lookups;
  // text_caps.cpp: the OpenType caps features of a face for a script.
  std::map<std::pair<SkTypefaceID, uint32_t>, uint8_t> caps_features;
  // FontCollection keeps a clone of every face for every list of font
  // arguments it was asked for; text.cpp counts the lists (by hash) and
  // drops the caches past kMaxFontArguments.
  static constexpr size_t kMaxFontArguments = 256;
  std::unordered_set<size_t> font_arguments;
  // text.cpp: the resolved families, primary font metrics and laid out lines
  // of recent requests; dropped with the match caches.
  std::unique_ptr<TextCaches, TextCachesDeleter> text_caches;
#if defined(__APPLE__)
  // loadSystemFonts turned the installed fonts on (kept across renderer
  // switches); they are registered the first time a font is looked up or
  // registered.
  bool installed_fonts_enabled = false;
  bool installed_fonts_pending = false;
  // Installed fonts resolve by name (loadSystemFonts ran once); removeAll
  // does not turn this off.
  bool installed_lookup = false;
  uint32_t installed_font_count = 0;
  // The installed font files (Rust's FONT_PATH and user folders), in order.
  // Without the system renderer face 0 of each is registered, as
  // loadSystemFonts does elsewhere.
  std::vector<std::string> installed_files;
  // font_families.cpp MatchCoreText: CoreText's family for a case-folded
  // name it does not list, empty for none.
  std::map<std::string, std::string> coretext_families;
  // CoreText's UI font under the family "system-ui", which Blink's mac font
  // cache gives that font (font_cache_mac.mm CreateFontPlatformData).
  // CoreText does not list it (a dot name), so it is not with the installed
  // fonts; FontCollection asks it after them (its test font manager).
  sk_sp<SkFontMgr> system_ui;
  std::set<SkTypefaceID> system_ui_ids;
#endif

  skiac_font_collection()
      : collection(sk_make_sp<FontCollection>()),
        font_mgr(MakeInstalledFontManager()),
        assets(sk_make_sp<TypefaceFontProviderCustom>(font_mgr)) {
    collection->setDefaultFontManager(SkFontMgr_New_Custom_Empty());
    collection->setAssetFontManager(font_mgr);
    collection->setDynamicFontManager(assets);
    collection->enableFontFallback();
    // text.cpp keeps the laid out lines (TextCaches::lines), so a paragraph
    // is only built for a line it does not have. skparagraph's own cache
    // would keep up to 128 more paragraphs, each several times the bytes of
    // a kept line (up to about 25x with fallback runs), and takes sizes and
    // spacings within 1/4096 px for equal.
    collection->getParagraphCache()->turnOn(false);
  }

#if defined(__APPLE__)
  // `paths` (count of them) are the installed font files; new ones are kept.
  // With the system renderer, Chrome's font set on macOS is every font
  // CoreText lists, and CoreText picks the fallback font for a character.
  // Without loadSystemFonts (DISABLE_SYSTEM_FONTS_LOAD) only registered
  // fonts resolve then.
  void enableInstalledFonts(const char* const* paths, size_t count) {
    for (size_t i = 0; i < count; ++i) {
      std::string path(paths[i]);
      if (std::find(installed_files.begin(), installed_files.end(), path) ==
          installed_files.end()) {
        installed_files.push_back(std::move(path));
      }
    }
    if (installed_fonts_enabled) {
      return;
    }
    installed_fonts_enabled = true;
    installed_lookup = true;
    startInstalledFonts();
  }

  // Registers every installed face (once). Returns how many that registered.
  uint32_t registerInstalledFonts() {
    return registerInstalledFonts(assets.get(), &system_font_ids);
  }

  // Registers every installed face (once) in `target`, their IDs in `ids`.
  uint32_t registerInstalledFonts(TypefaceFontProviderCustom* target,
                                  std::set<uint32_t>* ids) {
    if (!installed_fonts_pending) {
      return installed_font_count;
    }
    installed_fonts_pending = false;
    uint32_t count = 0;
    auto add = [&](sk_sp<SkTypeface> typeface) {
      if (!typeface) {
        return;
      }
      const SkTypefaceID typeface_id = typeface->uniqueID();
      if (const uint32_t id =
              target->registerInstalledTypeface(std::move(typeface))) {
        ids->insert(id);
        system_typeface_ids.insert(typeface_id);
        ++count;
      }
    };
    if (SystemFontRenderer()) {
      const int families = font_mgr->countFamilies();
      for (int i = 0; i < families; ++i) {
        sk_sp<SkFontStyleSet> set = font_mgr->createStyleSet(i);
        const int styles = set ? set->count() : 0;
        for (int j = 0; j < styles; ++j) {
          add(set->createTypeface(j));
        }
      }
    } else {
      for (const auto& path : installed_files) {
        add(MakeCanvasTypefaceFromFile(path.c_str()));
      }
    }
    markCachesDirty();
    installed_font_count = count;
    return count;
  }

  // GlobalFonts.removeAll() removed the installed fonts: they stay out
  // across renderer switches until loadSystemFonts turns them on again.
  void disableInstalledFonts() {
    installed_fonts_enabled = false;
    installed_fonts_pending = false;
    installed_font_count = 0;
  }
#endif

  // Before a lookup: the installed fonts loadSystemFonts turned on.
  void prepareLookup() {
#if defined(__APPLE__)
    registerInstalledFonts();
#endif
  }

  // Defer invalidation to the next text lookup instead of clearing on every
  // registration: loadFontsFromDir() registers one face per file, and
  // clearCaches() also purges the process-wide HarfBuzz face cache.
  void markCachesDirty() {
    caches_dirty = true;
    ++families_generation;
  }

  void flushCachesIfDirty() {
    prepareLookup();
    if (caches_dirty) {
      collection->clearCaches();
      space_in_lookups.clear();
      caps_features.clear();
      font_arguments.clear();
      text_caches.reset();
      caches_dirty = false;
    }
  }

  // Called before a lookup with font arguments whose hash is `hash`.
  void noteFontArguments(size_t hash) {
    if (font_arguments.insert(hash).second &&
        font_arguments.size() > kMaxFontArguments) {
      collection->clearCaches();
      space_in_lookups.clear();
      caps_features.clear();
      text_caches.reset();
      font_arguments = {hash};
    }
  }

  // Rebuild the dynamic font provider with only remaining fonts
  // Since sk_sp is reference-counted, old providers stay alive as long as any
  // typeface from them is still in use. We can safely clear retired_assets.
  // `relist_installed` (a renderer switch, macOS): the installed fonts of the
  // old mode give their place to the current mode's, registered where the
  // first of the old ones was.
  void rebuildAssets(bool relist_installed = false) {
    // The installed fonts loadSystemFonts turned on are registered first, so
    // the rebuild keeps them.
    if (!relist_installed) {
      prepareLookup();
    }
    // Get current registered fonts before swap
    auto old_fonts = assets->getRegisteredFonts();

    // Clear caches before swap
    collection->clearCaches();
    space_in_lookups.clear();
    caps_features.clear();
    font_arguments.clear();
    text_caches.reset();
    caches_dirty = false;
    ++families_generation;

    // Create new provider
    auto new_assets = sk_make_sp<TypefaceFontProviderCustom>(font_mgr);

    // Re-register all remaining fonts, preserving original IDs, under each
    // name in the order the names were registered (IDs are hashes, and a
    // name a font gained later goes after the fonts registered between).
    std::vector<std::tuple<uint64_t, uint32_t, size_t>> names;
    for (const auto& [id, font_info] : old_fonts) {
      for (size_t i = 0; i < font_info.aliases.size(); ++i) {
        names.emplace_back(font_info.orders[i], id, i);
      }
    }
    std::sort(names.begin(), names.end());
    std::set<uint32_t> kept_system_font_ids;
    system_typeface_ids.clear();
    // Each font made again, by ID; null when it is not kept.
    std::map<uint32_t, sk_sp<SkTypeface>> made;
    [[maybe_unused]] bool relisted = false;
    for (const auto& [order, id, index] : names) {
      const RegisteredFont& font_info = old_fonts.at(id);
      if (font_info.installed && relist_installed) {
#if defined(__APPLE__)
        if (!relisted) {
          relisted = true;
          registerInstalledFonts(new_assets.get(), &kept_system_font_ids);
        }
#endif
        continue;
      }
      auto it = made.find(id);
      if (it == made.end()) {
        sk_sp<SkTypeface> typeface;
        if (font_info.installed) {
          typeface = font_info.typeface;
        } else if (!font_info.path.empty()) {
          // Path-registered font: reload from path (lazy loading)
          typeface = MakeCanvasTypefaceFromFile(font_info.path.c_str());
        } else if (font_info.data) {
          // Buffer-registered font: recreate from stored data
          typeface = MakeCanvasTypeface(font_info.data);
        }
        // Not made again (its file is gone, or this mode cannot read it):
        // the face it had stays.
        if (!typeface) {
          typeface = font_info.typeface;
        }
        if (typeface) {
          if (system_font_ids.count(id)) {
            kept_system_font_ids.insert(id);
            system_typeface_ids.insert(typeface->uniqueID());
          }
          new_assets->addRebuiltFont(id, font_info, typeface);
        }
        it = made.emplace(id, std::move(typeface)).first;
      }
      if (it->second) {
        new_assets->addRebuiltAlias(id, font_info.aliases[index]);
      }
    }
#if defined(__APPLE__)
    // None was registered yet, but the setAlias replay needs them.
    if (relist_installed && !relisted) {
      registerInstalledFonts(new_assets.get(), &kept_system_font_ids);
    }
#endif
    system_font_ids = std::move(kept_system_font_ids);

    // Replay setAlias mappings
    // These aliases intentionally shadow/override existing family names
    for (const auto& [family, alias] : set_aliases) {
      auto style = SkFontStyle();
      auto typeface = new_assets->matchFamilyStyle(family.c_str(), style);
      if (typeface) {
        // Register the alias - this may shadow existing families (intended
        // behavior)
        new_assets->registerTypeface(std::move(typeface),
                                     SkString(alias.c_str()));
      }
    }

    // IMPORTANT: Font Provider Lifecycle Management
    //
    // Old providers must be kept alive because:
    // - Skia typefaces hold references to their parent provider
    // - If provider is destroyed while typefaces are in use, crash occurs
    // - Typefaces may be held by Paragraphs, Pictures, or cached renders
    //
    // Current approach: Fixed-size FIFO buffer of retired providers
    // - Cap of 1000 handles most real-world scenarios
    // - Memory impact is minimal (providers contain metadata, not font data)
    //
    // LIMITATION: If an application:
    // 1. Performs 1000+ font removal operations, AND
    // 2. Keeps references to typefaces from the oldest removals
    // Then a use-after-free crash can occur.
    //
    // This is acceptable for typical usage but may need ref-counting
    // for heavy font manipulation utilities.
    static constexpr size_t kMaxRetiredAssets = 1000;
    if (retired_assets.size() >= kMaxRetiredAssets) {
      retired_assets.erase(retired_assets.begin());  // Remove oldest
    }
    retired_assets.push_back(assets);

    // Swap to new provider
    assets = new_assets;
    collection->setDynamicFontManager(assets);
  }

  // setTextRenderer(): every font is made again for the new mode, and
  // every cache that holds a typeface or a laid out line is dropped. Returns
  // whether the mode changed. Called with the font lock held.
  bool setSystemFontRenderer(bool enabled) {
    if (SystemFontRenderer() == enabled) {
      return false;
    }
    // Typefaces made from here on are made in the new mode.
    SetSystemFontRenderer(enabled);
#if defined(__APPLE__)
    // The installed fonts belong to the mode they were listed in: the
    // rebuild puts the new mode's in their place.
    bool listed = false;
    for (const auto& [id, font_info] : assets->getRegisteredFonts()) {
      listed = listed || font_info.installed;
    }
    font_mgr = MakeInstalledFontManager();
    collection->setAssetFontManager(font_mgr);
    system_ui = nullptr;
    system_ui_ids.clear();
    collection->setTestFontManager(nullptr);
    coretext_families.clear();
    installed_fonts_pending = false;
    installed_font_count = 0;
    // Registered installed fonts are listed now, so they keep their place
    // before the fonts registered after them; the setAlias replay needs the
    // installed families too. Otherwise they are listed at the next lookup,
    // as at startup.
    const bool eager =
        installed_fonts_enabled && (listed || !set_aliases.empty());
    if (eager) {
      startInstalledFonts();
    } else if (installed_lookup && !installed_fonts_enabled) {
      // After removeAll the installed fonts still resolve by name.
      useInstalledLookup();
    }
#endif
    rebuildAssets(/*relist_installed=*/true);
#if defined(__APPLE__)
    if (installed_fonts_enabled && !eager) {
      startInstalledFonts();
    }
#endif
    return true;
  }

 private:
#if defined(__APPLE__)
  // The installed fonts of the current mode resolve by name, and are
  // registered at the next lookup.
  void startInstalledFonts() {
    useInstalledLookup();
    installed_fonts_pending = true;
    markCachesDirty();
  }

  // With the system renderer, CoreText's installed fonts resolve by name.
  void useInstalledLookup() {
    if (SystemFontRenderer()) {
      font_mgr = MakeCoreTextFontManager();
      collection->setAssetFontManager(font_mgr);
      system_ui = MakeSystemUiFontManager(&system_ui_ids);
      collection->setTestFontManager(system_ui);
      coretext_families.clear();
    }
  }
#endif
};

typedef void (*write_callback_t)(const void* buffer,
                                 size_t size,
                                 void* context);

class SkJavaScriptWStream : public SkWStream {
 public:
  SkJavaScriptWStream(write_callback_t write_callback, void* context)
      : fBytesWritten(0), fWriteCallback(write_callback), fContext(context) {}

  bool write(const void* buffer, size_t size) override {
    fBytesWritten += size;
    fWriteCallback(buffer, size, fContext);
    return true;
  }

  void flush() override { fBytesWritten = 0; }

  size_t bytesWritten() const override { return fBytesWritten; }

 private:
  size_t fBytesWritten;
  write_callback_t fWriteCallback;
  void* fContext;
};
struct skiac_line_metrics {
  float ascent;
  float descent;
  float left;
  float right;
  float width;
  float font_ascent;
  float font_descent;
  float alphabetic_baseline;
  // The drawn glyph ink, left and right of the anchor x, before a maxWidth
  // squeeze (the alpha:false reset): -left and right.
  float ink_left;
  float ink_right;
  // Blink's TextMetrics baselines, relative to the textBaseline:
  // hanging = 0.8 * ascent - baseline_y, ideographic = -descent - baseline_y.
  float hanging_baseline;
  float ideographic_baseline;
  // Blink's em box (ExtendedTextMetrics), relative to the textBaseline.
  float em_height_ascent;
  float em_height_descent;
  // SkFontMetrics fXHeight and fCapHeight of the primary font (0 when the
  // font does not say).
  float x_height;
  float cap_height;
};

struct skiac_rect {
  float left;
  float top;
  float right;
  float bottom;
};

struct skiac_transform {
  float a;
  float b;
  float c;
  float d;
  float e;
  float f;
};

struct skiac_point {
  float x;
  float y;
};

// An unpremultiplied RGBA float color: sk::Color4f in src/sk.rs. The gradient
// functions copy it into SkColor4f values; skia_c.cpp checks both layouts.
struct skiac_color4f {
  float r;
  float g;
  float b;
  float a;
};

struct skiac_surface_data {
  uint8_t* ptr;
  size_t size;
};

struct skiac_bitmap_info {
  skiac_bitmap* bitmap;
  int width;
  int height;
  bool is_canvas;
};

struct skiac_string {
  const char* ptr;
  size_t length;
  SkString* sk_string;
};

typedef void (*skiac_on_match_font_style)(int width,
                                          int weight,
                                          int slant,
                                          void* skiac_on_match_font_style_rust);

struct skiac_sk_data {
  const uint8_t* ptr;
  size_t size;
  skiac_data* data;
};

struct skiac_mapped_point {
  float x;
  float y;
};

struct skiac_pdf_document {
  skiac_document* document;
  skiac_w_memory_stream* stream;
};

struct skiac_pdf_metadata {
  const char* title;
  const char* author;
  const char* subject;
  const char* keywords;
  const char* creator;
  const char* producer;
  float raster_dpi;
  int encoding_quality;
  bool pdfa;
  int compression_level;  // -1 = default, 0 = none, 1 = low, 6 = average, 9 =
                          // high
};

struct skiac_variable_font_axis {
  uint32_t tag;  // OpenType tag (e.g., 'wght', 'wdth', 'slnt', 'ital')
  float value;   // Current value for this axis
  float min;     // Minimum value for this axis
  float max;     // Maximum value for this axis
  float def;     // Default value for this axis
  bool hidden;   // Whether this axis should be hidden
};

struct skiac_font_variation {
  uint32_t tag;  // OpenType tag
  float value;   // Value for this axis
};

// One family of the canvas font (font.rs FamilyName). `name` is UTF-8 and
// not NUL-terminated; a generic family has no name.
struct skiac_text_family {
  const char* name;
  size_t name_len;
  // 0 named, 1 serif, 2 sans-serif, 3 cursive, 4 fantasy, 5 monospace,
  // 6 system-ui, 7 -webkit-body, 8 math.
  int generic;
};

// An image of a prepared SVG document (src/svg_doc Resource), which its
// <image> elements name napi-img:K or napi-svg:K (svg_image.cpp).
struct skiac_svg_resource {
  // 0: a raster, `data` holds its encoded bytes; 1: an SVG document, `data`
  // holds its prepared text.
  uint8_t kind;
  // Raster: Blink's InterpolationQuality, 0 none, 1 low, 2 medium.
  uint8_t quality;
  const uint8_t* data;
  size_t length;
  // SVG: the frame (the rounded container size) and the root's laid-out
  // size.
  int frame_width;
  int frame_height;
  float root_width;
  float root_height;
};

// A font-family list of a prepared SVG document, which its font-family
// attributes name napi-font:K.
struct skiac_svg_font_list {
  const skiac_text_family* families;
  size_t count;
};

// The text and the canvas text settings of one measureText, fillText or
// strokeText (text.cpp).
struct skiac_text_request {
  // UTF-8, not NUL-terminated: a U+0000 in the text is text.
  const char* text;
  size_t text_len;
  const skiac_text_family* families;
  size_t family_count;
  float size;
  // CSS font-weight, 1..1000 in quarter steps.
  float weight;
  // Degrees, 14 for italic and plain oblique.
  float slope;
  // The font-style keyword: SkFontStyle::Slant values.
  int style;
  // SkFontStyle::Width values (font.rs FontStretch).
  int stretch;
  // The fontStretch percentage, 100 for normal.
  float stretch_pct;
  int baseline;
  int align;
  int direction;
  float letter_spacing;
  float word_spacing;
  const skiac_font_variation* variations;
  int variations_count;
  int kerning;
  int variant_caps;
  // The lang attribute, not NUL-terminated; empty or "inherit" for none.
  const char* lang;
  size_t lang_len;
  int text_rendering;
  // The draw may get LCD glyph masks (macOS): an alpha:false raster canvas,
  // source-over, no filter layer. text_raster.cpp checks the size and matrix.
  bool lcd_text;
};

extern "C" {
void skiac_clear_all_cache();
// Surface. `pf` is the CanvasPixelFormat: 0 unorm8, 1 float16.
skiac_surface* skiac_surface_create_rgba_premultiplied(int width,
                                                       int height,
                                                       uint8_t cs,
                                                       uint8_t pf);
void skiac_surface_create_svg(skiac_svg_surface* c_surface,
                              int width,
                              int height,
                              int alphaType,
                              uint32_t flag,
                              uint8_t cs,
                              uint8_t pf);
void skiac_svg_canvas_flush(skiac_canvas* c_canvas);
skiac_surface* skiac_surface_create_rgba(int width, int height, uint8_t cs);
skiac_surface* skiac_surface_create_rgba_opaque(int width,
                                                int height,
                                                uint8_t cs,
                                                uint8_t pf);
void skiac_surface_ref(skiac_surface* c_surface);
void skiac_surface_destroy(skiac_surface* c_surface);
skiac_surface* skiac_surface_copy_rgba(skiac_surface* c_surface,
                                       uint32_t x,
                                       uint32_t y,
                                       uint32_t width,
                                       uint32_t height,
                                       uint8_t cs);
skiac_canvas* skiac_surface_get_canvas(skiac_surface* c_surface);
int skiac_surface_get_width(skiac_surface* c_surface);
int skiac_surface_get_height(skiac_surface* c_surface);
void skiac_surface_read_pixels(skiac_surface* c_surface,
                               skiac_surface_data* data);
bool skiac_surface_read_pixels_rect(skiac_surface* c_surface,
                                    uint8_t* data,
                                    int x,
                                    int y,
                                    int w,
                                    int h,
                                    uint8_t cs);
// getImageData / putImageData of an ImageData pixel format: 0 rgba-unorm8,
// 1 rgba-float16, 2 rgba-float32.
bool skiac_surface_read_pixels_format(skiac_surface* c_surface,
                                      uint8_t* data,
                                      size_t row_bytes,
                                      int x,
                                      int y,
                                      int w,
                                      int h,
                                      uint8_t cs,
                                      uint8_t pf);
bool skiac_canvas_write_pixels_format(skiac_canvas* c_canvas,
                                      const uint8_t* pixels,
                                      int w,
                                      int h,
                                      uint8_t cs,
                                      uint8_t pf,
                                      bool opaque,
                                      int sx,
                                      int sy,
                                      int sw,
                                      int sh,
                                      int dx,
                                      int dy);
bool skiac_image_data_to_unorm8(const uint8_t* pixels,
                                int w,
                                int h,
                                uint8_t cs,
                                uint8_t pf,
                                uint8_t* out);
// Direct access to a raster surface's pixels. Succeeds only for
// premultiplied RGBA_8888 surfaces in sRGB (0) or Display P3 (1).
struct skiac_peek_pixels {
  const uint8_t* ptr;
  size_t row_bytes;
  int width;
  int height;
  uint8_t color_space;
};
bool skiac_surface_peek_premul_rgba(skiac_surface* c_surface,
                                    skiac_peek_pixels* peek);
void skiac_surface_png_data(skiac_surface* c_surface, skiac_sk_data* data);
void skiac_surface_encode_data(skiac_surface* c_surface,
                               skiac_sk_data* data,
                               int format,
                               float quality,
                               bool lossless);
bool skiac_surface_encode_stream(skiac_surface* c_surface,
                                 int format,
                                 float quality,
                                 bool lossless,
                                 write_callback_t write_callback,
                                 void* context);
int skiac_surface_get_alpha_type(skiac_surface* c_surface);
bool skiac_surface_save(skiac_surface* c_surface, const char* path);
void skiac_surface_get_bitmap(skiac_surface* c_surface,
                              skiac_bitmap_info* info);

// Canvas
void skiac_canvas_clear(skiac_canvas* c_canvas, uint32_t color);
void skiac_canvas_set_transform(skiac_canvas* c_canvas, skiac_matrix* c_matrix);
void skiac_canvas_concat(skiac_canvas* c_canvas, skiac_matrix* c_matrix);
void skiac_canvas_scale(skiac_canvas* c_canvas, float sx, float sy);
void skiac_canvas_translate(skiac_canvas* c_canvas, float dx, float dy);
void skiac_canvas_rotate(skiac_canvas* c_canvas, float degrees);
skiac_transform skiac_canvas_get_total_transform(skiac_canvas* c_canvas);
skiac_matrix* skiac_canvas_get_total_transform_matrix(skiac_canvas* c_canvas);
void skiac_canvas_draw_color(skiac_canvas* c_canvas,
                             float r,
                             float g,
                             float b,
                             float a);
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
                             size_t* c_decoded_bytes);
void skiac_canvas_draw_path(skiac_canvas* c_canvas,
                            skiac_path* c_path,
                            skiac_paint* c_paint);
void skiac_canvas_draw_rect(skiac_canvas* c_canvas,
                            float x,
                            float y,
                            float w,
                            float h,
                            skiac_paint* c_paint);
void skiac_canvas_draw_surface(skiac_canvas* c_canvas,
                               skiac_surface* c_surface,
                               float left,
                               float top,
                               uint8_t alpha,
                               int blend_mode,
                               int filter_quality);
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
                                    int filter_quality);
// Text (text.cpp)
void skiac_text_measure(skiac_font_collection* c_collection,
                        const skiac_text_request* request,
                        skiac_paint* c_paint,
                        skiac_line_metrics* c_line_metrics);
void skiac_text_draw(skiac_canvas* c_canvas,
                     skiac_font_collection* c_collection,
                     const skiac_text_request* request,
                     skiac_paint* c_paint,
                     float x,
                     float y,
                     float max_width);
// Whether the laid out line of `request` is kept, without laying it out or
// marking it used (tests).
bool skiac_text_line_kept(skiac_font_collection* c_collection,
                          const skiac_text_request* request);
bool skiac_font_collection_ideographic_advance(
    skiac_font_collection* c_collection,
    const skiac_text_request* request,
    float* advance);
void skiac_canvas_reset_transform(skiac_canvas* c_canvas);
bool skiac_canvas_get_device_clip_bounds(skiac_canvas* c_canvas, int32_t* ltrb);
void skiac_canvas_clip_rect(skiac_canvas* c_canvas,
                            float x,
                            float y,
                            float w,
                            float h);
void skiac_canvas_clip_path(skiac_canvas* c_canvas, skiac_path* c_path);
void skiac_canvas_save(skiac_canvas* c_canvas);
void skiac_canvas_save_layer(skiac_canvas* c_canvas, skiac_paint* c_paint);
void skiac_canvas_restore(skiac_canvas* c_canvas);
void skiac_canvas_reset(skiac_canvas* c_canvas);
void skiac_canvas_write_pixels(skiac_canvas* c_canvas,
                               int width,
                               int height,
                               uint8_t* pixels,
                               size_t row_bytes,
                               int x,
                               int y);
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
                                 bool opaque);
void skiac_canvas_draw_picture(skiac_canvas* c_canvas,
                               skiac_picture* c_picture,
                               skiac_matrix* c_matrix,
                               skiac_paint* c_paint);
// Optimized: combines save/clip/transform/draw/restore into single call
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
                                    skiac_paint* c_paint,
                                    bool isolate);
void skiac_canvas_destroy(skiac_canvas* c_canvas);

// Paint
skiac_paint* skiac_paint_create();
skiac_paint* skiac_paint_clone(skiac_paint* c_paint);
void skiac_paint_destroy(skiac_paint* c_paint);
void skiac_paint_set_style(skiac_paint* c_paint, int style);
void skiac_paint_set_color(skiac_paint* c_paint,
                           uint8_t r,
                           uint8_t g,
                           uint8_t b,
                           uint8_t a);
void skiac_paint_set_alpha(skiac_paint* c_paint, uint8_t a);
void skiac_paint_set_alphaf(skiac_paint* c_paint, float a);
float skiac_paint_get_alphaf(skiac_paint* c_paint);
uint32_t skiac_paint_get_color(skiac_paint* c_paint);
void skiac_paint_set_anti_alias(skiac_paint* c_paint, bool aa);
void skiac_paint_set_dither(skiac_paint* c_paint, bool dither);
void skiac_paint_set_blend_mode(skiac_paint* c_paint, int blend_mode);
int skiac_paint_get_blend_mode(skiac_paint* c_paint);
void skiac_paint_set_shader(skiac_paint* c_paint, skiac_shader* c_shader);
void skiac_paint_set_stroke_width(skiac_paint* c_paint, float width);
float skiac_paint_get_stroke_width(skiac_paint* c_paint);
void skiac_paint_set_stroke_cap(skiac_paint* c_paint, int cap);
int skiac_paint_get_stroke_cap(skiac_paint* c_paint);
void skiac_paint_set_stroke_join(skiac_paint* c_paint, uint8_t join);
uint8_t skiac_paint_get_stroke_join(skiac_paint* c_paint);
void skiac_paint_set_stroke_miter(skiac_paint* c_paint, float miter);
float skiac_paint_get_stroke_miter(skiac_paint* c_paint);
void skiac_paint_set_path_effect(skiac_paint* c_paint,
                                 skiac_path_effect* c_path_effect);
void skiac_paint_set_mask_filter(skiac_paint* c_paint,
                                 skiac_mask_filter* c_mask_filter);
void skiac_paint_set_image_filter(skiac_paint* c_paint,
                                  skiac_image_filter* c_image_filter);
void skiac_paint_set_src_in_color_filter(skiac_paint* c_paint,
                                         uint8_t r,
                                         uint8_t g,
                                         uint8_t b,
                                         uint8_t a);
void skiac_paint_set_color4f(skiac_paint* c_paint, skiac_color4f color);
void skiac_paint_set_src_in_color_filter4f(skiac_paint* c_paint,
                                           skiac_color4f color);

// Color conversions: the skcms math Blink's Color uses (color.cc).
uint32_t skiac_color4f_to_sk_color(skiac_color4f color);
bool skiac_color_space_params(int space, float* matrix, float* transfer_fn);
bool skiac_skcms_matrix3x3_invert(const float* matrix, float* inverse);
float skiac_skcms_transfer_fn_eval(const float* transfer_fn, float x);
bool skiac_skcms_transfer_fn_invert(const float* transfer_fn, float* inverse);

// Path
skiac_path* skiac_path_create();
skiac_path* skiac_path_from_svg(char* svg_path);
skiac_path* skiac_path_clone(skiac_path* c_path);
void skiac_path_swap(skiac_path* c_path, skiac_path* other_path);
void skiac_add_path(skiac_path* c_path,
                    skiac_path* other_path,
                    skiac_matrix* c_matrix);
bool skiac_path_op(skiac_path* c_path_one, skiac_path* c_path_two, int op);
void skiac_path_to_svg_string(skiac_path* c_path, skiac_string* c_string);
bool skiac_path_simplify(skiac_path* c_path);
bool skiac_path_stroke(skiac_path* c_path,
                       int cap,
                       uint8_t join,
                       float width,
                       float miter_limit);
void skiac_path_get_bounds(skiac_path* c_path, skiac_rect* c_rect);
void skiac_path_compute_tight_bounds(skiac_path* c_path, skiac_rect* c_rect);
bool skiac_path_trim(skiac_path* c_path,
                     float start_t,
                     float stop_t,
                     bool is_complement);
bool skiac_path_dash(skiac_path* c_path, float on, float off, float phase);
bool skiac_path_round(skiac_path* c_path, float radius);
bool skiac_path_equals(skiac_path* c_path, skiac_path* other_path);
void skiac_path_destroy(skiac_path* c_path);
void skiac_path_set_fill_type(skiac_path* c_path, int type);
int skiac_path_get_fill_type(skiac_path* c_path);
bool skiac_path_as_winding(skiac_path* c_path);
void skiac_path_arc_to(skiac_path* c_path,
                       float left,
                       float top,
                       float right,
                       float bottom,
                       float startAngle,
                       float sweepAngle,
                       bool forceMoveTo);
void skiac_path_arc_to_tangent(skiac_path* c_path,
                               float x1,
                               float y1,
                               float x2,
                               float y2,
                               float radius);
void skiac_path_move_to(skiac_path* c_path, float x, float y);
void skiac_path_line_to(skiac_path* c_path, float x, float y);
void skiac_path_cubic_to(skiac_path* c_path,
                         float x1,
                         float y1,
                         float x2,
                         float y2,
                         float x3,
                         float y3);
void skiac_path_quad_to(skiac_path* c_path,
                        float cpx,
                        float cpy,
                        float x,
                        float y);
void skiac_path_arc_to_svg(skiac_path* c_path,
                           float rx,
                           float ry,
                           float x_axis_rotate,
                           bool large_arc,
                           bool sweep,
                           float x,
                           float y);
void skiac_path_close(skiac_path* c_path);
void skiac_path_add_rect(skiac_path* c_path,
                         float l,
                         float t,
                         float r,
                         float b);
void skiac_path_add_circle(skiac_path* c_path, float x, float y, float r);
skiac_path* skiac_path_transform(skiac_path* c_path, skiac_matrix* c_matrix);
void skiac_path_transform_self(skiac_path* c_path, skiac_matrix* c_matrix);
bool skiac_path_is_empty(skiac_path* c_path);
int skiac_path_count_points(skiac_path* c_path);
int skiac_path_count_verbs(skiac_path* c_path);
uint32_t skiac_path_generation_id(skiac_path* c_path);
bool skiac_path_hit_test(skiac_path* c_path, float x, float y, int type);
bool skiac_path_stroke_hit_test(skiac_path* c_path,
                                float x,
                                float y,
                                float stroke_w);
void skiac_path_round_rect(skiac_path* c_path,
                           SkScalar x,
                           SkScalar y,
                           SkScalar width,
                           SkScalar height,
                           const SkScalar* radii,
                           bool clockwise);

// PathEffect
skiac_path_effect* skiac_path_effect_make_dash_path(const float* intervals,
                                                    int count,
                                                    float phase);
void skiac_path_effect_destroy(skiac_path_effect* c_path_effect);

// Shader
skiac_shader* skiac_shader_make_linear_gradient(const skiac_point* points,
                                                const skiac_color4f* colors,
                                                const float* positions,
                                                int count,
                                                int tile_mode,
                                                uint32_t flags,
                                                int interpolation_space,
                                                skiac_transform c_ts);
skiac_shader* skiac_shader_make_radial_gradient(skiac_point start_point,
                                                float start_radius,
                                                skiac_point end_point,
                                                float end_radius,
                                                const skiac_color4f* colors,
                                                const float* positions,
                                                int count,
                                                int tile_mode,
                                                uint32_t flags,
                                                int interpolation_space,
                                                skiac_transform c_ts);
skiac_shader* skiac_shader_make_conic_gradient(float cx,
                                               float cy,
                                               float rotation,
                                               const skiac_color4f* colors,
                                               const float* positions,
                                               int count,
                                               int tile_mode,
                                               uint32_t flags,
                                               int interpolation_space,
                                               skiac_transform c_ts);
skiac_shader* skiac_shader_make_from_surface_image(skiac_surface* c_surface,
                                                   skiac_transform c_ts,
                                                   int filter_quality);

void skiac_shader_ref(skiac_shader* c_shader);
void skiac_shader_destroy(skiac_shader* c_shader);

// Matrix
skiac_matrix* skiac_matrix_create();
skiac_matrix* skiac_matrix_new(float a,
                               float b,
                               float c,
                               float d,
                               float e,
                               float f);
skiac_matrix* skiac_matrix_from_ts(const skiac_transform* c_ts);
skiac_matrix* skiac_matrix_create_rotated(float rotation, float x, float y);
skiac_matrix* skiac_matrix_create_translated(float x, float y);
skiac_matrix* skiac_matrix_concat(skiac_matrix* c_matrix, skiac_matrix* other);
skiac_matrix* skiac_matrix_multiply(skiac_matrix* c_matrix,
                                    skiac_matrix* other);
skiac_matrix* skiac_matrix_clone(skiac_matrix* c_matrix);
void skiac_matrix_map_points_1(skiac_matrix* c_matrix,
                               float x,
                               float y,
                               skiac_mapped_point* mapped_point);
void skiac_matrix_pre_translate(skiac_matrix* c_matrix, float dx, float dy);
void skiac_matrix_pre_concat(skiac_matrix* c_matrix, skiac_matrix* other);
void skiac_matrix_pre_scale(skiac_matrix* c_matrix, float sx, float sy);
void skiac_matrix_pre_concat_transform(skiac_matrix* c_matrix,
                                       skiac_transform c_ts);
void skiac_matrix_pre_rotate(skiac_matrix* c_matrix, float degrees);
void skiac_matrix_pre_rotate_x_y(skiac_matrix* c_matrix,
                                 float degrees,
                                 float x,
                                 float y);
bool skiac_matrix_invert(skiac_matrix* c_matrix, skiac_matrix* inverse);
skiac_transform skiac_matrix_to_transform(skiac_matrix* c_matrix);
void skiac_matrix_destroy(skiac_matrix* c_matrix);

// MaskFilter
skiac_mask_filter* skiac_mask_filter_make_blur(float radius);
void skiac_mask_filter_destroy(skiac_mask_filter* c_mask_filter);

// ImageFilter
skiac_image_filter* skiac_image_filter_make_drop_shadow_only(
    float dx,
    float dy,
    float sigma_x,
    float sigma_y,
    uint32_t color,
    skiac_image_filter* c_image_filter);
skiac_image_filter* skiac_image_filter_make_drop_shadow(
    float dx,
    float dy,
    float sigma_x,
    float sigma_y,
    uint32_t color,
    skiac_image_filter* c_image_filter);
skiac_image_filter* skiac_image_filter_make_blur(
    float sigma_x,
    float sigma_y,
    skiac_image_filter* c_image_filter);
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
    skiac_image_filter* c_image_filter);
skiac_image_filter* skiac_image_filter_from_argb(
    const uint8_t table_a[256],
    const uint8_t table_r[256],
    const uint8_t table_g[256],
    const uint8_t table_b[256],
    skiac_image_filter* c_image_filter);
bool skiac_image_filter_is_a_color_filter(skiac_image_filter* c_image_filter);
uint32_t skiac_image_filter_filter_color(skiac_image_filter* c_image_filter,
                                         uint32_t color);
bool skiac_image_filter_input_bounds(skiac_image_filter* c_image_filter,
                                     int32_t bounds[4]);
void skiac_image_filter_destroy(skiac_image_filter* c_image_filter);

// SkImage (for PageCache)
skiac_image* skiac_surface_make_image_snapshot(skiac_surface* c_surface);
void skiac_image_ref(skiac_image* c_image);
void skiac_image_destroy(skiac_image* c_image);
int skiac_image_get_width(skiac_image* c_image);
int skiac_image_get_height(skiac_image* c_image);
void skiac_image_encode_data(skiac_image* c_image,
                             skiac_sk_data* data,
                             int format,
                             float quality,
                             bool lossless,
                             bool crop_to_max_dimension,
                             bool unpremul_readback);
bool skiac_image_read_pixels(skiac_image* c_image,
                             uint8_t* dst,
                             size_t row_bytes,
                             int alpha_type,
                             uint8_t cs);
uint8_t skiac_image_color_space(skiac_image* c_image);
void skiac_canvas_draw_sk_image(skiac_canvas* c_canvas,
                                skiac_image* c_image,
                                float left,
                                float top,
                                int filter_quality);

// Data
void skiac_sk_data_destroy(skiac_data* c_data);

// Bitmap
bool skiac_bitmap_make_from_buffer(const uint8_t* ptr,
                                   size_t size,
                                   skiac_bitmap_info* bitmap_info);
skiac_svg_document* skiac_svg_document_make(const uint8_t* data,
                                            size_t length,
                                            skiac_font_collection* c_collection,
                                            bool prepared,
                                            const skiac_svg_resource* images,
                                            size_t image_count,
                                            const skiac_svg_font_list* fonts,
                                            size_t font_count);
bool skiac_svg_image_size(const uint8_t* data,
                          size_t length,
                          int* width,
                          int* height);
bool skiac_svg_document_attribute(skiac_svg_document* document,
                                  int index,
                                  const char** ptr,
                                  size_t* length);
bool skiac_svg_document_render(skiac_svg_document* document,
                               float layout_width,
                               float layout_height,
                               float view_width,
                               float view_height,
                               float da,
                               float db,
                               float dc,
                               float dd,
                               float de,
                               float df,
                               float sx,
                               float sy,
                               float tx,
                               float ty,
                               float clip_left,
                               float clip_top,
                               float clip_right,
                               float clip_bottom,
                               int width,
                               int height,
                               uint8_t cs,
                               skiac_bitmap_info* bitmap_info);
size_t skiac_svg_document_retained_bytes(skiac_svg_document* document);
void skiac_svg_document_destroy(skiac_svg_document* document);
bool skiac_font_collection_default_font_metrics(
    skiac_font_collection* c_collection,
    float* metrics);
skiac_bitmap* skiac_bitmap_make_from_image_data(uint8_t* ptr,
                                                size_t width,
                                                size_t height,
                                                size_t row_bytes,
                                                size_t size,
                                                int ct,
                                                int at);
skiac_bitmap* skiac_bitmap_make_premul_from_image_data(uint8_t* ptr,
                                                       size_t width,
                                                       size_t height,
                                                       size_t row_bytes,
                                                       uint8_t cs,
                                                       uint8_t pf);
bool skiac_bitmap_set_color_space(skiac_bitmap* c_bitmap,
                                  const uint8_t* icc,
                                  size_t icc_len,
                                  uint16_t primaries,
                                  uint16_t transfer,
                                  uint16_t matrix,
                                  bool is_mono);
bool skiac_bitmap_orient(skiac_bitmap_info* bitmap_info, int origin);
bool skiac_bitmap_is_high_bit_depth(const uint8_t* ptr, size_t size);
bool skiac_bitmap_make_high_bit_depth(const uint8_t* ptr,
                                      size_t size,
                                      uint8_t cs,
                                      skiac_bitmap_info* bitmap_info);
bool skiac_bitmap_source_is_opaque(skiac_bitmap* c_bitmap, bool is_canvas);
int skiac_bitmap_source_bytes_per_pixel(skiac_bitmap* c_bitmap, bool is_canvas);
size_t skiac_bitmap_get_width(skiac_bitmap* c_bitmap);
size_t skiac_bitmap_get_height(skiac_bitmap* c_bitmap);
void skiac_bitmap_set_immutable(skiac_bitmap* c_bitmap);
skiac_image* skiac_bitmap_make_image(skiac_bitmap* c_bitmap);
skiac_shader* skiac_image_make_pattern_shader(skiac_image* c_image,
                                              bool is_canvas,
                                              int repeat_x,
                                              int repeat_y,
                                              int filter_quality,
                                              skiac_transform c_ts);
int skiac_image_pattern_level(int width,
                              int height,
                              skiac_transform c_ts,
                              skiac_transform c_ctm,
                              int filter_quality);
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
    size_t* c_decoded_bytes);
void skiac_bitmap_destroy(skiac_bitmap* c_bitmap);

// Image decode-cache levels
// Called with the byte size of each level freed after its cache is destroyed.
typedef void (*skiac_level_release)(void* release_context, size_t bytes);
skiac_image_levels* skiac_image_levels_create();
// Destroys the cache. Returns the bytes of the levels a recorded draw or a
// shader still holds; `release` is called as each of them is freed.
size_t skiac_image_levels_destroy(skiac_image_levels* c_levels,
                                  skiac_level_release release,
                                  void* release_context);
size_t skiac_image_levels_bytes(skiac_image_levels* c_levels);

// SkString
void skiac_delete_sk_string(skiac_sk_string* c_sk_string);

// FontCollection
skiac_font_collection* skiac_font_collection_create();
uint32_t skiac_font_collection_get_default_fonts_count(
    skiac_font_collection* c_font_collection);
void skiac_font_collection_get_family(
    skiac_font_collection* c_font_collection,
    uint32_t i,
    skiac_string* c_string,
    void* on_get_style_rust,
    skiac_on_match_font_style on_match_font_style);
uint32_t skiac_font_collection_register(
    skiac_font_collection* c_font_collection,
    const uint8_t* font,
    size_t length,
    const char* name_alias);
uint32_t skiac_font_collection_register_from_path(
    skiac_font_collection* c_font_collection,
    const char* font_path,
    const char* name_alias);
size_t skiac_font_collection_unregister(
    skiac_font_collection* c_font_collection,
    uint32_t typeface_id);
size_t skiac_font_collection_unregister_batch(
    skiac_font_collection* c_font_collection,
    const uint32_t* typeface_ids,
    size_t count);
size_t skiac_font_collection_unregister_all(
    skiac_font_collection* c_font_collection);
bool skiac_font_collection_set_alias(skiac_font_collection* c_font_collection,
                                     const char* family,
                                     const char* alias);
// macOS: the installed fonts resolve, registered at the first lookup
// (index.js): CoreText's with the system renderer, else face 0 of each of
// `paths`. load_installed_fonts registers them now and returns how many.
// No-ops elsewhere.
void skiac_font_collection_enable_installed_fonts(
    skiac_font_collection* c_font_collection,
    const char* const* paths,
    size_t count);
uint32_t skiac_font_collection_load_installed_fonts(
    skiac_font_collection* c_font_collection,
    const char* const* paths,
    size_t count);
// setTextRenderer(): the first sets the mode before the collection is
// made; the second makes every font of `c_font_collection` again for the new
// mode and returns whether it changed.
void skiac_set_system_font_renderer(bool enabled);
bool skiac_font_collection_set_system_font_renderer(
    skiac_font_collection* c_font_collection,
    bool enabled);
void skiac_font_collection_destroy(skiac_font_collection* c_font_collection);

// Variable Fonts
int skiac_typeface_get_variation_design_position(
    skiac_font_collection* c_font_collection,
    const char* family_name,
    int weight,
    int width,
    int slant,
    skiac_variable_font_axis* axes,
    int max_axis_count);
bool skiac_font_has_variations(skiac_font_collection* c_font_collection,
                               const char* family_name,
                               int weight,
                               int width,
                               int slant);

// SkDynamicMemoryWStream
void skiac_sk_w_stream_get(skiac_w_memory_stream* c_w_memory_stream,
                           skiac_sk_data* sk_data,
                           int width,
                           int height);
void skiac_sk_w_stream_destroy(skiac_w_memory_stream* c_w_memory_stream);

// SkSVG
void skiac_svg_text_to_path(const uint8_t* data,
                            size_t length,
                            skiac_font_collection* c_collection,
                            skiac_sk_data* output_data);

// SkPictureRecorder
void skiac_picture_ref(skiac_picture* c_picture);
void skiac_picture_destroy(skiac_picture* c_picture);
void skiac_picture_playback(skiac_picture* c_picture, skiac_canvas* c_canvas);
size_t skiac_picture_approximate_bytes(skiac_picture* c_picture);
uint32_t skiac_picture_unique_id(skiac_picture* c_picture);
skiac_picture_recorder* skiac_picture_recorder_create();
void skiac_picture_recorder_destroy(skiac_picture_recorder* c_picture_recorder);
void skiac_picture_recorder_begin_recording(
    skiac_picture_recorder* c_picture_recorder,
    float x,
    float y,
    float width,
    float height,
    bool use_bbh);
skiac_canvas* skiac_picture_recorder_get_recording_canvas(
    skiac_picture_recorder* c_picture_recorder);
skiac_picture* skiac_picture_recorder_finish_recording_as_picture(
    skiac_picture_recorder* c_picture_recorder);
skiac_drawable* skiac_picture_recorder_finish_recording_as_drawable(
    skiac_picture_recorder* c_picture_recorder);

// SkDrawable
void skiac_canvas_draw_drawable(skiac_canvas* c_canvas,
                                skiac_drawable* c_drawable,
                                skiac_matrix* c_matrix);
void skiac_drawable_destroy(skiac_drawable* c_drawable);

// SkDocument
void skiac_document_create(skiac_pdf_document* c_document,
                           const skiac_pdf_metadata* metadata = nullptr);
void skiac_document_destroy(skiac_pdf_document* c_document);
skiac_canvas* skiac_document_begin_page(skiac_pdf_document* c_document,
                                        float width,
                                        float height,
                                        skiac_rect* content = nullptr);
void skiac_document_end_page(skiac_pdf_document* c_document);
void skiac_document_close(skiac_pdf_document* c_document,
                          skiac_sk_data* output_data);

// SkAnnotation
void skiac_canvas_annotate_link_url(skiac_canvas* c_canvas,
                                    const skiac_rect* rect,
                                    const char* url);
void skiac_canvas_annotate_named_destination(skiac_canvas* c_canvas,
                                             float x,
                                             float y,
                                             const char* name);
void skiac_canvas_annotate_link_to_destination(skiac_canvas* c_canvas,
                                               const skiac_rect* rect,
                                               const char* name);

// Skottie (Lottie Animation)
skiac_skottie_animation* skiac_skottie_animation_make(
    const char* data,
    size_t length,
    const char* resource_path);
skiac_skottie_animation* skiac_skottie_animation_make_from_file(
    const char* path);
void skiac_skottie_animation_destroy(skiac_skottie_animation* c_animation);
double skiac_skottie_animation_get_duration(
    skiac_skottie_animation* c_animation);
double skiac_skottie_animation_get_fps(skiac_skottie_animation* c_animation);
double skiac_skottie_animation_get_in_point(
    skiac_skottie_animation* c_animation);
double skiac_skottie_animation_get_out_point(
    skiac_skottie_animation* c_animation);
void skiac_skottie_animation_get_size(skiac_skottie_animation* c_animation,
                                      float* width,
                                      float* height);
void skiac_skottie_animation_get_version(skiac_skottie_animation* c_animation,
                                         skiac_string* c_string);
void skiac_skottie_animation_seek(skiac_skottie_animation* c_animation,
                                  float t);
void skiac_skottie_animation_seek_frame(skiac_skottie_animation* c_animation,
                                        double frame);
void skiac_skottie_animation_seek_frame_time(
    skiac_skottie_animation* c_animation,
    double t);
void skiac_skottie_animation_render(skiac_skottie_animation* c_animation,
                                    skiac_canvas* c_canvas,
                                    const skiac_rect* dst);
void skiac_skottie_animation_render_with_flags(
    skiac_skottie_animation* c_animation,
    skiac_canvas* c_canvas,
    const skiac_rect* dst,
    uint32_t flags);
}

#endif  // SKIA_CAPI_H
