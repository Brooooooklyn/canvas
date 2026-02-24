#ifndef SKIA_CAPI_H
#define SKIA_CAPI_H

#include <include/codec/SkCodec.h>
#include <include/codec/SkEncodedImageFormat.h>
#include <include/core/SkAnnotation.h>
#include <include/core/SkBBHFactory.h>
#include <include/core/SkBitmap.h>
#include <include/core/SkBlurTypes.h>
#include <include/core/SkCanvas.h>
#include <include/core/SkColorFilter.h>
#include <include/core/SkData.h>
#include <include/core/SkDrawable.h>
#include <include/core/SkFontMgr.h>
#include <include/core/SkGraphics.h>
#include <include/core/SkMaskFilter.h>
#include <include/core/SkPaint.h>
#include <include/core/SkPathBuilder.h>
#include <include/core/SkPathEffect.h>
#include <include/core/SkPathUtils.h>
#include <include/core/SkPicture.h>
#include <include/core/SkPictureRecorder.h>
#include <include/core/SkSamplingOptions.h>
#include <include/core/SkStream.h>
#include <include/core/SkString.h>
#include <include/core/SkStrokeRec.h>
#include <include/core/SkSurface.h>
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
#include <src/ports/SkFontMgr_custom.h>
#include <src/xml/SkXMLWriter.h>
#include <algorithm>
#include <cstring>
#include <map>
#include <set>
#include <string>
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

#if defined(WIN32) || defined(_WIN32) || defined(__WIN32__) || defined(__NT__)
#define SK_FONT_FILE_PREFIX "C:/Windows/Fonts"
#elif __APPLE__
#define SK_FONT_FILE_PREFIX "/System/Library/Fonts/"
#elif __linux__
#define SK_FONT_FILE_PREFIX "/usr/share/fonts/"
#endif

sk_sp<SkFontMgr> SkFontMgr_New_Custom_Directory(const char* dir);

sk_sp<SkFontMgr> SkFontMgr_New_Custom_Empty();

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
  std::vector<std::string> aliases;  // All aliases for this font
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
    font_info.aliases.push_back(
        originalName);  // Track under what name it's registered
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
    font_info.aliases.push_back(originalName);  // Track original name

    // Only add alias if different from original name
    if (aliasStr != originalName) {
      font_info.aliases.push_back(aliasStr);
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

  // Register with explicit ID (used during rebuild to preserve FontKey)
  // Only registers under the names in aliases (which includes original family
  // name if tracked)
  void registerTypefaceWithId(uint32_t id,
                              sk_sp<SkData> data,
                              const std::string& path,
                              sk_sp<SkTypeface> typeface,
                              const std::vector<std::string>& aliases) {
    if (!typeface) {
      return;
    }

    RegisteredFont font_info;
    font_info.data = data;
    font_info.path = path;
    font_info.aliases = aliases;
    registered_fonts[id] = std::move(font_info);

    // Update secondary index
    uint32_t content_hash;
    if (!path.empty()) {
      content_hash = computePathHash(path);
    } else if (data) {
      content_hash = computeFontContentHash(data);
    } else {
      content_hash = id;  // Fallback to id if no path or data
    }
    content_hash_index[content_hash].insert(id);

    // Register under each tracked name (first one is typically original family
    // name)
    for (const auto& name : aliases) {
      this->registerTypeface(typeface, SkString(name.c_str()));
    }
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
    font_info.aliases.push_back(originalName);
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
    font_info.aliases.push_back(originalName);

    // Only add alias if different from original name
    if (aliasStr != originalName) {
      font_info.aliases.push_back(aliasStr);
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

struct skiac_font_collection {
  sk_sp<FontCollection> collection;
  sk_sp<SkFontMgr> font_mgr;
  sk_sp<TypefaceFontProviderCustom> assets;
  // Keep old providers alive to avoid destruction issues
  std::vector<sk_sp<TypefaceFontProviderCustom>> retired_assets;
  // Track setAlias mappings for rebuild: {family, alias} pairs
  std::set<std::pair<std::string, std::string>> set_aliases;

  skiac_font_collection()
      : collection(sk_make_sp<FontCollection>()),
        font_mgr(SkFontMgr_New_Custom_Directory(SK_FONT_FILE_PREFIX)),
        assets(sk_make_sp<TypefaceFontProviderCustom>(font_mgr)) {
    collection->setDefaultFontManager(SkFontMgr_New_Custom_Empty());
    collection->setAssetFontManager(font_mgr);
    collection->setDynamicFontManager(assets);
    collection->enableFontFallback();
  }

  // Rebuild the dynamic font provider with only remaining fonts
  // Since sk_sp is reference-counted, old providers stay alive as long as any
  // typeface from them is still in use. We can safely clear retired_assets.
  void rebuildAssets() {
    // Get current registered fonts before swap
    auto old_fonts = assets->getRegisteredFonts();

    // Clear caches before swap
    collection->clearCaches();

    // Create new provider
    auto new_assets = sk_make_sp<TypefaceFontProviderCustom>(font_mgr);

    // Re-register all remaining fonts, preserving original IDs
    for (const auto& [id, font_info] : old_fonts) {
      sk_sp<SkTypeface> typeface;

      if (!font_info.path.empty()) {
        // Path-registered font: reload from path (lazy loading)
        typeface = font_mgr->makeFromFile(font_info.path.c_str());
      } else if (font_info.data) {
        // Buffer-registered font: recreate from stored data
        typeface = font_mgr->makeFromData(font_info.data);
      }

      if (typeface) {
        new_assets->registerTypefaceWithId(id, font_info.data, font_info.path,
                                           typeface, font_info.aliases);
      }
    }

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

extern "C" {
void skiac_clear_all_cache();
// Surface
skiac_surface* skiac_surface_create_rgba_premultiplied(int width,
                                                       int height,
                                                       uint8_t cs);
void skiac_surface_create_svg(skiac_svg_surface* c_surface,
                              int width,
                              int height,
                              int alphaType,
                              uint32_t flag,
                              uint8_t cs);
skiac_surface* skiac_surface_create_rgba(int width, int height, uint8_t cs);
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
void skiac_surface_png_data(skiac_surface* c_surface, skiac_sk_data* data);
void skiac_surface_encode_data(skiac_surface* c_surface,
                               skiac_sk_data* data,
                               int format,
                               int quality);
bool skiac_surface_encode_stream(skiac_surface* c_surface,
                                 int format,
                                 int quality,
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
                             skiac_paint* c_paint);
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
    int text_rendering);
void skiac_canvas_reset_transform(skiac_canvas* c_canvas);
void skiac_canvas_clip_rect(skiac_canvas* c_canvas,
                            float x,
                            float y,
                            float w,
                            float h);
void skiac_canvas_clip_path(skiac_canvas* c_canvas, skiac_path* c_path);
void skiac_canvas_save(skiac_canvas* c_canvas);
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
                                 bool snapshot);
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
                                    skiac_paint* c_paint);
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
uint8_t skiac_paint_get_alpha(skiac_paint* c_paint);
void skiac_paint_set_anti_alias(skiac_paint* c_paint, bool aa);
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
                           SkScalar* radii,
                           bool clockwise);

// PathEffect
skiac_path_effect* skiac_path_effect_make_dash_path(const float* intervals,
                                                    int count,
                                                    float phase);
void skiac_path_effect_destroy(skiac_path_effect* c_path_effect);

// Shader
skiac_shader* skiac_shader_make_linear_gradient(const skiac_point* points,
                                                const uint32_t* colors,
                                                const float* positions,
                                                int count,
                                                int tile_mode,
                                                uint32_t flags,
                                                skiac_transform c_ts);
skiac_shader* skiac_shader_make_radial_gradient(skiac_point start_point,
                                                float start_radius,
                                                skiac_point end_point,
                                                float end_radius,
                                                const uint32_t* colors,
                                                const float* positions,
                                                int count,
                                                int tile_mode,
                                                uint32_t flags,
                                                skiac_transform c_ts);
skiac_shader* skiac_shader_make_conic_gradient(float cx,
                                               float cy,
                                               float radius,
                                               const uint32_t* colors,
                                               const float* positions,
                                               int count,
                                               int tile_mode,
                                               uint32_t flags,
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
void skiac_image_filter_destroy(skiac_image_filter* c_image_filter);

// SkImage (for PageCache)
skiac_image* skiac_surface_make_image_snapshot(skiac_surface* c_surface);
void skiac_image_ref(skiac_image* c_image);
void skiac_image_destroy(skiac_image* c_image);
int skiac_image_get_width(skiac_image* c_image);
int skiac_image_get_height(skiac_image* c_image);
void skiac_canvas_draw_sk_image(skiac_canvas* c_canvas,
                                skiac_image* c_image,
                                float left,
                                float top,
                                int filter_quality);

// Data
void skiac_sk_data_destroy(skiac_data* c_data);

// Bitmap
void skiac_bitmap_make_from_buffer(const uint8_t* ptr,
                                   size_t size,
                                   skiac_bitmap_info* bitmap_info);
bool skiac_bitmap_make_from_svg(const uint8_t* data,
                                size_t length,
                                float width,
                                float height,
                                skiac_bitmap_info* bitmap_info,
                                skiac_font_collection* c_collection,
                                uint8_t cs);
skiac_bitmap* skiac_bitmap_make_from_image_data(uint8_t* ptr,
                                                size_t width,
                                                size_t height,
                                                size_t row_bytes,
                                                size_t size,
                                                int ct,
                                                int at);
size_t skiac_bitmap_get_width(skiac_bitmap* c_bitmap);
size_t skiac_bitmap_get_height(skiac_bitmap* c_bitmap);
skiac_shader* skiac_bitmap_get_shader(
    bool is_canvas,
    skiac_bitmap* c_bitmap,
    int repeat_x,
    int repeat_y,
    float B,
    float C,  // See SkSamplingOptions.h for docs.
    skiac_transform c_ts);
void skiac_bitmap_destroy(skiac_bitmap* c_bitmap);

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
