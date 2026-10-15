// The scaler each OS's Chrome draws a font with, and the typefaces the
// canvas makes from font files:
//
//             registered fonts (web fonts)              installed fonts
//   macOS     CoreText; Fontations for CBDT, COLRv1,   CoreText: every face
//             CFF2, avar2 and COLRv0 fonts              CoreText lists
//             (web_font_typeface_factory.cc)            (loadSystemFonts)
//   Linux     Fontations                                Fontations
//                                                       (loadSystemFonts)
//   others    FreeType                                  FreeType
//
// WOFF and WOFF2 are decoded to SFNT first, as Blink's OTS step hands the
// scalers SFNT data.

#include <stdint.h>
#include <string.h>
#include <algorithm>
#include <memory>
#include <vector>

// CoreText's headers declare a global TextRange, which skia_c.hpp's
// `using namespace skia::textlayout` would make ambiguous.
#if defined(__APPLE__)
#include <include/ports/SkFontMgr_mac_ct.h>
#endif

#include "skia_c.hpp"

#if defined(SKIAC_FONTATIONS)
#include <include/ports/SkTypeface_fontations.h>
#endif

#if defined(SK_DEBUG) || !defined(SK_RELEASE)
#error "skia-c must be built with SK_RELEASE like libskia (see build.rs)"
#endif

#if defined(__APPLE__) && !defined(SKIAC_FONTATIONS)
#error "macOS builds draw some web fonts with Fontations (see build.rs)"
#endif

namespace {

constexpr SkFontTableTag Tag(char a, char b, char c, char d) {
  return SkSetFourByteTag(a, b, c, d);
}

void WriteU32(uint8_t* out, uint32_t value) {
  out[0] = static_cast<uint8_t>(value >> 24);
  out[1] = static_cast<uint8_t>(value >> 16);
  out[2] = static_cast<uint8_t>(value >> 8);
  out[3] = static_cast<uint8_t>(value);
}

void WriteU16(uint8_t* out, uint16_t value) {
  out[0] = static_cast<uint8_t>(value >> 8);
  out[1] = static_cast<uint8_t>(value);
}

// An SFNT file holding `typeface`'s tables: what OTS hands Blink's scalers
// for a WOFF or WOFF2 font, which FreeType decodes for us.
sk_sp<SkData> SfntFromTypeface(const SkTypeface& typeface) {
  const int count = typeface.countTables();
  if (count <= 0 || count > UINT16_MAX) {
    return nullptr;
  }
  std::vector<SkFontTableTag> tags(count);
  typeface.readTableTags(tags);
  std::sort(tags.begin(), tags.end());
  std::vector<sk_sp<SkData>> tables;
  tables.reserve(count);
  size_t size = 12 + 16 * static_cast<size_t>(count);
  bool cff = false;
  for (SkFontTableTag tag : tags) {
    sk_sp<SkData> table = typeface.copyTableData(tag);
    if (!table) {
      return nullptr;
    }
    cff |= tag == Tag('C', 'F', 'F', ' ');
    size += (table->size() + 3) & ~static_cast<size_t>(3);
    if (size > UINT32_MAX) {
      return nullptr;
    }
    tables.push_back(std::move(table));
  }
  sk_sp<SkData> sfnt = SkData::MakeZeroInitialized(size);
  auto* out = static_cast<uint8_t*>(sfnt->writable_data());
  WriteU32(out, cff ? Tag('O', 'T', 'T', 'O') : 0x00010000);
  uint16_t selector = 0;
  while ((2 << selector) <= count) {
    ++selector;
  }
  const uint16_t search_range = static_cast<uint16_t>(16 << selector);
  WriteU16(out + 4, static_cast<uint16_t>(count));
  WriteU16(out + 6, search_range);
  WriteU16(out + 8, selector);
  WriteU16(out + 10, static_cast<uint16_t>(count * 16 - search_range));
  size_t offset = 12 + 16 * static_cast<size_t>(count);
  for (int i = 0; i < count; ++i) {
    const sk_sp<SkData>& table = tables[i];
    const uint8_t* bytes = table->bytes();
    uint32_t checksum = 0;
    for (size_t k = 0; k < table->size(); k += 4) {
      uint32_t word = 0;
      for (size_t j = 0; j < 4; ++j) {
        word = (word << 8) | (k + j < table->size() ? bytes[k + j] : 0);
      }
      checksum += word;
    }
    uint8_t* record = out + 12 + 16 * i;
    WriteU32(record, tags[i]);
    WriteU32(record + 4, checksum);
    WriteU32(record + 8, static_cast<uint32_t>(offset));
    WriteU32(record + 12, static_cast<uint32_t>(table->size()));
    if (table->size()) {
      memcpy(out + offset, bytes, table->size());
    }
    offset += (table->size() + 3) & ~static_cast<size_t>(3);
  }
  return sfnt;
}

// The font data in `stream`, with a WOFF or WOFF2 file decoded to SFNT.
sk_sp<const SkData> SfntData(std::unique_ptr<SkStreamAsset> stream) {
  if (!stream) {
    return nullptr;
  }
  uint8_t signature[4] = {};
  const bool woff =
      stream->peek(signature, 4) == 4 &&
      (!memcmp(signature, "wOFF", 4) || !memcmp(signature, "wOF2", 4));
  if (!woff) {
    if (sk_sp<const SkData> data = stream->getData()) {
      return data;
    }
    return SkData::MakeFromStream(stream.get(), stream->getLength());
  }
  sk_sp<SkTypeface> decoded =
      SkFontMgr_New_Custom_Empty()->makeFromStream(std::move(stream), 0);
  return decoded ? SfntFromTypeface(*decoded) : nullptr;
}

#if defined(__APPLE__)
const sk_sp<SkFontMgr>& CoreTextFactory() {
  static const sk_sp<SkFontMgr> manager = SkFontMgr_New_CoreText(nullptr);
  return manager;
}

// web_font_typeface_factory.cc CreateTypeface on macOS, with the checks of
// format_check.rs: which fonts Fontations draws instead of CoreText.
bool WantsFontations(const SkTypeface& probe) {
  auto has = [&probe](SkFontTableTag tag) {
    return probe.getTableSize(tag) > 0;
  };
  auto version = [&probe](SkFontTableTag tag) -> int {
    uint8_t bytes[2];
    if (probe.getTableData(tag, 0, 2, bytes) != 2) {
      return -1;
    }
    return (bytes[0] << 8) | bytes[1];
  };
  const bool variable = has(Tag('f', 'v', 'a', 'r'));
  const bool cbdt =
      has(Tag('C', 'B', 'D', 'T')) && has(Tag('C', 'B', 'L', 'C'));
  const bool sbix = has(Tag('s', 'b', 'i', 'x'));
  const bool cff2 = has(Tag('C', 'F', 'F', '2'));
  const int colr =
      has(Tag('C', 'O', 'L', 'R')) ? version(Tag('C', 'O', 'L', 'R')) : -1;
  const bool color = sbix || cbdt || colr == 0 || colr == 1;
  if (!variable && !color && !cff2) {
    return false;
  }
  if (cbdt || colr == 1) {
    return true;
  }
  if (sbix) {
    return false;
  }
  if (cff2) {
    return true;
  }
  // FontFormatAvar2 is a stable feature.
  if (has(Tag('a', 'v', 'a', 'r')) && version(Tag('a', 'v', 'a', 'r')) == 2) {
    return true;
  }
  // A variable COLRv0 font goes to Fontations, any other variable font to
  // CoreText, a COLRv0 font to Fontations.
  return colr == 0;
}
#endif

}  // namespace

sk_sp<SkFontMgr> MakeInstalledFontManager() {
#if defined(__APPLE__)
  // CoreText's installed fonts come with loadSystemFonts
  // (skiac_font_collection::enableInstalledFonts).
  return nullptr;
#else
  return SkFontMgr_New_Custom_Directory(SK_FONT_FILE_PREFIX);
#endif
}

sk_sp<SkTypeface> MakeCanvasTypeface(std::unique_ptr<SkStreamAsset> stream) {
  if (!stream) {
    return nullptr;
  }
#if defined(__APPLE__)
  sk_sp<const SkData> data = SfntData(std::move(stream));
  if (!data) {
    return nullptr;
  }
  sk_sp<SkTypeface> fontations =
      SkTypeface_Make_Fontations(data, SkFontArguments());
  if (fontations && WantsFontations(*fontations)) {
    return fontations;
  }
  return CoreTextFactory()->makeFromStream(
      SkMemoryStream::Make(std::move(data)), 0);
#elif defined(SKIAC_FONTATIONS)
  // Fontations reads the file in place (a file stream is mapped).
  uint8_t signature[4] = {};
  if (stream->peek(signature, 4) == 4 &&
      (!memcmp(signature, "wOFF", 4) || !memcmp(signature, "wOF2", 4))) {
    sk_sp<const SkData> data = SfntData(std::move(stream));
    return data ? SkTypeface_Make_Fontations(std::move(data), SkFontArguments())
                : nullptr;
  }
  return SkTypeface_Make_Fontations(std::move(stream), SkFontArguments());
#else
  return SkFontMgr_New_Custom_Empty()->makeFromStream(std::move(stream), 0);
#endif
}

sk_sp<SkTypeface> MakeCanvasTypeface(sk_sp<SkData> data) {
  return data ? MakeCanvasTypeface(SkMemoryStream::Make(std::move(data)))
              : nullptr;
}

sk_sp<SkTypeface> MakeCanvasTypefaceFromFile(const char* path) {
  return MakeCanvasTypeface(SkStream::MakeFromFile(path));
}

#if defined(__APPLE__)
sk_sp<SkFontMgr> MakeCoreTextFontManager() {
  return SkFontMgr_New_CoreText(nullptr);
}
#endif
