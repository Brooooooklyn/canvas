// The Blink shaper's installed-font fallback source (shaper.hpp
// InstalledFallback): the font a character no family has is taken from when
// CoreText gives none. It runs with the portable renderer on every OS, with
// the system renderer off Apple, and on Apple's system renderer after
// CoreText found nothing (then only over the faces CoreText does not know:
// loadFontsFromDir's). Chrome's Linux and Windows font caches pick from every
// installed font (font_cache_linux.cc PlatformFallbackFontForCharacter,
// font_cache_skia_win.cc), never from a FontFace: only installed faces are
// candidates here.

#include <algorithm>
#include <cstring>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <tuple>
#include <unordered_map>
#include <utility>
#include <vector>

#include "icu_api.h"
#include "shaper.hpp"

namespace {

// FontDescription's kBoldThreshold, kBoldWeightValue and kItalicSlopeValue.
constexpr float kBoldThreshold = 600;
constexpr float kBoldWeight = 700;
constexpr float kItalicSlope = 14;

// A sorted list of [first, last] code point ranges.
using Coverage = std::vector<std::pair<uint32_t, uint32_t>>;

bool Covers(const Coverage& coverage, uint32_t c) {
  auto it = std::upper_bound(
      coverage.begin(), coverage.end(), c,
      [](uint32_t value, const std::pair<uint32_t, uint32_t>& range) {
        return value < range.first;
      });
  return it != coverage.begin() && c <= std::prev(it)->second;
}

// Only the tables HarfBuzz's cmap accelerator reads: `cmap`, and `maxp`
// for the glyph count it checks the glyph IDs against.
hb_blob_t* ReferenceCmapTable(hb_face_t*, hb_tag_t tag, void* user_data) {
  if (tag != SkSetFourByteTag('c', 'm', 'a', 'p') &&
      tag != SkSetFourByteTag('m', 'a', 'x', 'p')) {
    return nullptr;
  }
  sk_sp<SkData> data = static_cast<SkTypeface*>(user_data)->copyTableData(tag);
  if (!data) {
    return nullptr;
  }
  SkData* table = data.release();
  return hb_blob_create(static_cast<const char*>(table->data()),
                        static_cast<unsigned int>(table->size()),
                        HB_MEMORY_MODE_READONLY, table,
                        [](void* ptr) { static_cast<SkData*>(ptr)->unref(); });
}

// Whether the face has a Unicode or a symbol cmap: the subtables
// fontconfig's charset reads (FcFreeTypeCharSet: FreeType's
// FT_ENCODING_UNICODE, from (0,0..4), (0,6), (3,1) and (3,10), and
// FT_ENCODING_MS_SYMBOL, (3,0)). A face with only legacy subtables (Mac
// Roman (1,0), say) has no characters for Chrome Linux's fallback, and
// collect_unicodes would list a legacy subtable's own codes as code points.
bool HasUnicodeCmap(hb_face_t* face) {
  hb_blob_t* blob =
      hb_face_reference_table(face, SkSetFourByteTag('c', 'm', 'a', 'p'));
  unsigned int length = 0;
  const auto* data =
      reinterpret_cast<const uint8_t*>(hb_blob_get_data(blob, &length));
  bool unicode = false;
  if (data && length >= 4) {
    const unsigned int count = (data[2] << 8) | data[3];
    for (unsigned int i = 0; i < count && 4 + 8 * (i + 1) <= length; ++i) {
      const uint8_t* record = data + 4 + 8 * i;
      const unsigned int platform = (record[0] << 8) | record[1];
      const unsigned int encoding = (record[2] << 8) | record[3];
      if ((platform == 0 && encoding != 5) ||
          (platform == 3 &&
           (encoding == 0 || encoding == 1 || encoding == 10))) {
        unicode = true;
        break;
      }
    }
  }
  hb_blob_destroy(blob);
  return unicode;
}

// The characters a face maps, as HarfBuzz's nominal glyph lookup (the one
// the shaper draws with) maps them. Only the range list is kept: the face's
// own tables are freed here. A face whose data is a file or a buffer is read
// from that data (a file is mapped, and only the pages of the table
// directory, `cmap` and `maxp` are touched, then unmapped): asking the
// typeface for its tables opens a FreeType face it keeps for its life, which
// for every installed face of a host is hundreds of MB.
Coverage ReadCoverage(SkTypeface* face) {
  Coverage coverage;
  int ttc_index = 0;
  std::unique_ptr<SkStreamAsset> stream = face->openExistingStream(&ttc_index);
  hb_face_t* hb_face = nullptr;
  if (stream && stream->getMemoryBase() && stream->getLength() > 0 &&
      stream->getLength() <= UINT32_MAX && ttc_index >= 0) {
    hb_blob_t* blob = hb_blob_create(
        static_cast<const char*>(stream->getMemoryBase()),
        static_cast<unsigned int>(stream->getLength()), HB_MEMORY_MODE_READONLY,
        /*user_data=*/nullptr, /*destroy=*/nullptr);
    hb_face = hb_face_create(blob, static_cast<unsigned int>(ttc_index));
    hb_blob_destroy(blob);
    // Not an sfnt HarfBuzz reads (a WOFF or WOFF2 file, a Type 1 font):
    // the typeface's own tables.
    if (!hb_face_get_glyph_count(hb_face)) {
      hb_face_destroy(hb_face);
      hb_face = nullptr;
    }
  }
  if (!hb_face) {
    hb_face = hb_face_create_for_tables(ReferenceCmapTable, face,
                                        /*destroy=*/nullptr);
  }
  hb_set_t* set = hb_set_create();
  if (HasUnicodeCmap(hb_face)) {
    hb_face_collect_unicodes(hb_face, set);
  }
  // A symbol font (a (3,0) cmap): HarfBuzz's nominal glyph also maps
  // U+0000..U+00FF to U+F000..U+F0FF (_hb_symbol_pua_map), as fontconfig's
  // charset (FcFreeTypeCharSet) and Windows do, but collect_unicodes lists
  // only the U+F0xx codes. The codes the lookup maps are added.
  hb_codepoint_t pua = 0xEFFF;
  if (hb_set_next(set, &pua) && pua <= 0xF0FF) {
    hb_font_t* font = hb_font_create(hb_face);
    for (hb_codepoint_t c = 0; c <= 0xFF; ++c) {
      hb_codepoint_t glyph = 0;
      if (hb_font_get_nominal_glyph(font, c, &glyph)) {
        hb_set_add(set, c);
      }
    }
    hb_font_destroy(font);
  }
  hb_codepoint_t first = HB_SET_VALUE_INVALID;
  hb_codepoint_t last = HB_SET_VALUE_INVALID;
  while (hb_set_next_range(set, &first, &last)) {
    coverage.emplace_back(first, last);
  }
  coverage.shrink_to_fit();
  hb_set_destroy(set);
  hb_face_destroy(hb_face);
  return coverage;
}

// What makes a face the same face as another: its offset table and table
// directory (each table's tag, checksum, offset and length) and its index in
// a collection, from the face's own data. A file both `assets` and the font
// manager list is one face; a subset or another style of the family is not.
// The manager also lists each named instance of a variable face (the index's
// high 16 bits, SkFontMgr_custom_directory.cpp) where loadSystemFonts
// registers the face once: an instance is the same face as its face, which
// AtRequestAxes takes at the request's axes.
// Empty when the data is not an sfnt in memory (never the same face).
std::string ReadFaceIdentity(SkTypeface* face) {
  int ttc_index = 0;
  std::unique_ptr<SkStreamAsset> stream = face->openExistingStream(&ttc_index);
  if (!stream || !stream->getMemoryBase() || ttc_index < 0) {
    return {};
  }
  ttc_index &= 0xFFFF;
  const auto* data = static_cast<const uint8_t*>(stream->getMemoryBase());
  const size_t length = stream->getLength();
  auto u32 = [&](size_t at) {
    return (uint32_t{data[at]} << 24) | (uint32_t{data[at + 1]} << 16) |
           (uint32_t{data[at + 2]} << 8) | uint32_t{data[at + 3]};
  };
  size_t offset = 0;
  if (length >= 12 && !memcmp(data, "ttcf", 4)) {
    const size_t index = static_cast<size_t>(ttc_index);
    if (index >= u32(8) || 12 + 4 * (index + 1) > length) {
      return {};
    }
    offset = u32(12 + 4 * index);
  }
  if (offset > length || length - offset < 12) {
    return {};
  }
  const uint32_t version = u32(offset);
  if (version != 0x00010000 &&
      version != SkSetFourByteTag('O', 'T', 'T', 'O') &&
      version != SkSetFourByteTag('t', 'r', 'u', 'e')) {
    return {};
  }
  const size_t tables = (size_t{data[offset + 4]} << 8) | data[offset + 5];
  if (!tables || (length - offset - 12) / 16 < tables) {
    return {};
  }
  std::string identity = std::to_string(ttc_index) + ':';
  identity.append(reinterpret_cast<const char*>(data + offset),
                  12 + 16 * tables);
  return identity;
}

// The faces of one installed family that have a character, matched to the
// request's style by the CSS3 rule (SkFontStyleSet::matchStyleCSS3).
class FaceSet final : public SkFontStyleSet {
 public:
  explicit FaceSet(std::vector<sk_sp<SkTypeface>> faces)
      : faces_(std::move(faces)) {}
  int count() override { return static_cast<int>(faces_.size()); }
  void getStyle(int index, SkFontStyle* style, SkString* name) override {
    if (style) {
      *style = faces_[index]->fontStyle();
    }
    if (name) {
      name->reset();
    }
  }
  sk_sp<SkTypeface> createTypeface(int index) override { return faces_[index]; }
  sk_sp<SkTypeface> matchStyle(const SkFontStyle& pattern) override {
    return matchStyleCSS3(pattern);
  }

 private:
  std::vector<sk_sp<SkTypeface>> faces_;
};

// Character::GetScriptBasedOnUnicodeBlock, by ISO 15924 name: the script
// Blink gives a Common or Inherited character of these blocks
// (u_getIntPropertyValue(UCHAR_BLOCK) is ublock_getCode).
const char* ScriptOfBlock(uint32_t c) {
  switch (u_getIntPropertyValue(static_cast<UChar32>(c), UCHAR_BLOCK)) {
    case 8:  // UBLOCK_GREEK
      return "Grek";
    case 10:  // UBLOCK_ARMENIAN
      return "Armn";
    case 12:  // UBLOCK_ARABIC
      return "Arab";
    case 15:  // UBLOCK_DEVANAGARI
      return "Deva";
    case 22:  // UBLOCK_KANNADA
      return "Knda";
    case 25:  // UBLOCK_THAI
      return "Thai";
    case 29:  // UBLOCK_GEORGIAN
      return "Geor";
    case 61:  // UBLOCK_CJK_SYMBOLS_AND_PUNCTUATION
      return "Hani";
    case 62:  // UBLOCK_HIRAGANA
    case 63:  // UBLOCK_KATAKANA
      return "Hrkt";
    case 89:  // UBLOCK_GOTHIC
      return "Goth";
    default:
      return "Zyyy";
  }
}

// font_fallback_win.cc GetScript: ICU's script, else the block's.
std::string ScriptOf(uint32_t c) {
  UErrorCode status = U_ZERO_ERROR;
  const int script = uscript_getScript(static_cast<UChar32>(c), &status);
  if (status > U_ZERO_ERROR || script <= USCRIPT_INHERITED) {
    return ScriptOfBlock(c);
  }
  const char* name = uscript_getShortName(script);
  return name ? name : "Zyyy";
}

struct ScriptFamilies {
  const char* script;
  std::vector<const char*> families;
};

// font_fallback_win.cc InitializeScriptFontMap, by ISO 15924 name; the
// Han names ("Hani" is the host's Han script, the UI locale's in Blink).
const std::vector<ScriptFamilies>& WindowsScriptFamilies() {
  static const std::vector<ScriptFamilies> kFamilies = {
      {"Arab", {"Tahoma", "Segoe UI"}},
      {"Armn", {"Segoe UI", "Sylfaen"}},
      {"Beng", {"Nirmala UI", "Vrinda"}},
      {"Brah", {"Segoe UI Historic"}},
      {"Brai", {"Segoe UI Symbol"}},
      {"Bugi", {"Leelawadee UI"}},
      {"Cans", {"Gadugi", "Euphemia"}},
      {"Cari", {"Segoe UI Historic"}},
      {"Cher", {"Gadugi", "Plantagenet"}},
      {"Copt", {"Segoe UI Symbol"}},
      {"Xsux", {"Segoe UI Historic"}},
      {"Cprt", {"Segoe UI Historic"}},
      {"Cyrl", {"Times New Roman"}},
      {"Dsrt", {"Segoe UI Symbol"}},
      {"Deva", {"Nirmala UI", "Mangal"}},
      {"Egyp", {"Segoe UI Historic"}},
      {"Ethi",
       {"Nyala", "Abyssinica SIL", "Ethiopia Jiret", "Visual Geez Unicode",
        "GF Zemen Unicode", "Ebrima"}},
      {"Geor", {"Sylfaen", "Segoe UI"}},
      {"Glag", {"Segoe UI Historic", "Segoe UI Symbol"}},
      {"Goth", {"Segoe UI Historic", "Segoe UI Symbol"}},
      {"Grek", {"Times New Roman"}},
      {"Gujr", {"Nirmala UI", "Shruti"}},
      {"Guru", {"Nirmala UI", "Raavi"}},
      {"Hang", {"Noto Sans KR", "Noto Sans CJK KR", "Malgun Gothic", "Gulim"}},
      {"Hebr", {"David", "Segoe UI"}},
      {"Armi", {"Segoe UI Historic"}},
      {"Phli", {"Segoe UI Historic"}},
      {"Prti", {"Segoe UI Historic"}},
      {"Java", {"Javanese Text"}},
      {"Knda", {"Tunga", "Nirmala UI"}},
      {"Hira",
       {"Noto Sans JP", "Noto Sans CJK JP", "Meiryo", "Yu Gothic", "MS PGothic",
        "Microsoft YaHei"}},
      {"Kana",
       {"Noto Sans JP", "Noto Sans CJK JP", "Meiryo", "Yu Gothic", "MS PGothic",
        "Microsoft YaHei"}},
      {"Hrkt",
       {"Noto Sans JP", "Noto Sans CJK JP", "Meiryo", "Yu Gothic", "MS PGothic",
        "Microsoft YaHei"}},
      {"Khar", {"Segoe UI Historic"}},
      {"Khmr",
       {"Leelawadee UI", "Khmer UI", "Khmer OS", "MoolBoran", "DaunPenh"}},
      {"Laoo",
       {"Leelawadee UI", "Lao UI", "DokChampa", "Saysettha OT", "Phetsarath OT",
        "Code2000"}},
      {"Latn", {"Times New Roman"}},
      {"Lisu", {"Segoe UI"}},
      {"Lyci", {"Segoe UI Historic"}},
      {"Lydi", {"Segoe UI Historic"}},
      {"Mlym", {"Nirmala UI", "Kartika"}},
      {"Mtei", {"Nirmala UI"}},
      {"Merc", {"Segoe UI Historic", "Segoe UI Symbol"}},
      {"Mong", {"Mongolian Baiti"}},
      {"Mymr", {"Myanmar Text", "Padauk", "Parabaik", "Myanmar3", "Code2000"}},
      {"Talu", {"Microsoft New Tai Lue"}},
      {"Nkoo", {"Ebrima"}},
      {"Ogam", {"Segoe UI Historic", "Segoe UI Symbol"}},
      {"Olck", {"Nirmala UI"}},
      {"Ital", {"Segoe UI Historic", "Segoe UI Symbol"}},
      {"Xpeo", {"Segoe UI Historic"}},
      {"Sarb", {"Segoe UI Historic"}},
      {"Orya", {"Kalinga", "ori1Uni", "Lohit Oriya", "Nirmala UI"}},
      {"Orkh", {"Segoe UI Historic", "Segoe UI Symbol"}},
      {"Osma", {"Ebrima"}},
      {"Phag", {"Microsoft PhagsPa"}},
      {"Runr", {"Segoe UI Historic", "Segoe UI Symbol"}},
      {"Shaw", {"Segoe UI Historic"}},
      {"Hans",
       {"Noto Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", "simsun"}},
      {"Sinh", {"Iskoola Pota", "AksharUnicode", "Nirmala UI"}},
      {"Sora", {"Nirmala UI"}},
      {"Zsym", {"Segoe UI Symbol"}},
      {"Syrc", {"Estrangelo Edessa", "Estrangelo Nisibin", "Code2000"}},
      {"Tale", {"Microsoft Tai Le"}},
      {"Taml", {"Nirmala UI", "Latha"}},
      {"Telu", {"Nirmala UI", "Gautami"}},
      {"Thaa", {"MV Boli"}},
      {"Thai", {"Tahoma", "Leelawadee UI", "Leelawadee"}},
      {"Tibt", {"Microsoft Himalaya", "Jomolhari", "Tibetan Machine Uni"}},
      {"Tfng", {"Ebrima"}},
      {"Hant",
       {"Noto Sans TC", "Noto Sans CJK TC", "Microsoft JhengHei", "pmingli"}},
      {"Bopo",
       {"Noto Sans TC", "Noto Sans CJK TC", "Microsoft JhengHei", "pmingli"}},
      {"Vaii", {"Ebrima"}},
      {"Yiii", {"Microsoft Yi Baiti", "Nuosu SIL", "Code2000"}},
  };
  return kFamilies;
}

const std::vector<const char*>* FamiliesOf(
    const std::vector<ScriptFamilies>& table,
    const std::string& script) {
  for (const auto& entry : table) {
    if (script == entry.script) {
      return &entry.families;
    }
  }
  return nullptr;
}

// The ISO 15924 name of a Han script HanScriptForLocale gives.
const char* HanScriptName(int han_script) {
  switch (han_script) {
    case USCRIPT_SIMPLIFIED_HAN:
      return "Hans";
    case USCRIPT_TRADITIONAL_HAN:
      return "Hant";
    case USCRIPT_HANGUL:
      return "Hang";
    case USCRIPT_KATAKANA_OR_HIRAGANA:
      return "Hrkt";
    default:
      return nullptr;
  }
}

bool InRange(uint32_t c, uint32_t first, uint32_t last) {
  return c >= first && c <= last;
}

// font_fallback_win.cc GetFontBasedOnUnicodeBlock, by the blocks' ranges:
// the symbol and math blocks' fonts.
std::vector<const char*> WindowsBlockFamilies(uint32_t c) {
  // UBLOCK_EMOTICONS, UBLOCK_ENCLOSED_ALPHANUMERIC_SUPPLEMENT: text
  // presentation (GetMonoEmojiFont).
  if (InRange(c, 0x1F600, 0x1F64F) || InRange(c, 0x1F100, 0x1F1FF)) {
    return {"Segoe UI Symbol", "Segoe UI Emoji"};
  }
  // Playing cards, miscellaneous symbols (and arrows, and pictographs),
  // transport and map, alchemical, dingbats, Gothic.
  if (InRange(c, 0x1F0A0, 0x1F0FF) || InRange(c, 0x2600, 0x26FF) ||
      InRange(c, 0x2B00, 0x2BFF) || InRange(c, 0x1F300, 0x1F5FF) ||
      InRange(c, 0x1F680, 0x1F6FF) || InRange(c, 0x1F700, 0x1F77F) ||
      InRange(c, 0x2700, 0x27BF) || InRange(c, 0x10330, 0x1034F)) {
    return {"Segoe UI Symbol"};
  }
  // Arrows, mathematical operators, miscellaneous technical, geometric
  // shapes (and extended), the mathematical symbols and arrows supplements,
  // mathematical alphanumerics, Arabic mathematical alphabetics
  // (GetMathFont).
  if (InRange(c, 0x2190, 0x21FF) || InRange(c, 0x2200, 0x22FF) ||
      InRange(c, 0x2300, 0x23FF) || InRange(c, 0x25A0, 0x25FF) ||
      InRange(c, 0x27C0, 0x27EF) || InRange(c, 0x27F0, 0x27FF) ||
      InRange(c, 0x2900, 0x297F) || InRange(c, 0x2980, 0x29FF) ||
      InRange(c, 0x2A00, 0x2AFF) || InRange(c, 0x1D400, 0x1D7FF) ||
      InRange(c, 0x1EE00, 0x1EEFF) || InRange(c, 0x1F780, 0x1F7FF)) {
    return {"Cambria Math", "Segoe UI Symbol", "Code2000"};
  }
  return {};
}

#if defined(__APPLE__)
// The font Chrome 157's CoreText cascade picks on macOS for a character of
// each script when the font list lacks it (CSS.getPlatformFontsForNode, an
// English host; stages/S19/chrome-mac-list.json), asked by name when it is
// installed. No language (D20). PingFang is a MobileAsset font outside
// /System/Library/Fonts, which loadSystemFonts does not read: the Han
// scripts then take Hiragino Sans GB, the next Simplified Chinese font of
// CoreText's cascade that is in that folder.
const std::vector<ScriptFamilies>& MacScriptFamilies() {
  static const std::vector<ScriptFamilies> kFamilies = {
      {"Hani", {"PingFang SC", "Hiragino Sans GB"}},
      {"Hans", {"PingFang SC", "Hiragino Sans GB"}},
      {"Hant", {"PingFang SC", "Hiragino Sans GB"}},
      {"Hira", {"PingFang SC", "Hiragino Sans GB"}},
      {"Kana", {"PingFang SC", "Hiragino Sans GB"}},
      {"Hrkt", {"PingFang SC", "Hiragino Sans GB"}},
      {"Bopo", {"PingFang SC", "Hiragino Sans GB"}},
      {"Hang", {"Apple SD Gothic Neo"}},
      {"Thai", {"Thonburi"}},
      {"Deva", {"Kohinoor Devanagari"}},
      {"Arab", {"Geeza Pro"}},
      {"Hebr", {"Lucida Grande"}},
      {"Ethi", {"Kefa III"}},
      {"Beng", {"Kohinoor Bangla"}},
      {"Taml", {"Tamil Sangam MN"}},
      {"Armn", {"Noto Sans Armenian"}},
      {"Geor", {"Helvetica"}},
      {"Khmr", {"Khmer Sangam MN"}},
      {"Laoo", {"Lao Sangam MN"}},
      {"Mymr", {"Noto Sans Myanmar"}},
      {"Sinh", {"Sinhala Sangam MN"}},
      {"Tibt", {"Kailasa"}},
      {"Gujr", {"Kohinoor Gujarati"}},
      {"Guru", {"Mukta Mahee"}},
      {"Knda", {"Noto Sans Kannada"}},
      {"Mlym", {"Malayalam Sangam MN"}},
      {"Telu", {"Kohinoor Telugu"}},
      {"Orya", {"Noto Sans Oriya"}},
      {"Cher", {"Galvji"}},
      {"Mong", {"Noto Sans Mongolian"}},
      {"Brai", {"Apple Braille"}},
  };
  return kFamilies;
}
#endif

constexpr SkFourByteTag kWght = SkSetFourByteTag('w', 'g', 'h', 't');
constexpr SkFourByteTag kWdth = SkSetFourByteTag('w', 'd', 't', 'h');
constexpr SkFourByteTag kSlnt = SkSetFourByteTag('s', 'l', 'n', 't');

uint32_t Bits(float value) {
  uint32_t bits;
  memcpy(&bits, &value, sizeof(bits));
  return bits;
}

}  // namespace

struct InstalledFallbackIndex {
  struct Family {
    std::string folded;
    std::vector<sk_sp<SkTypeface>> faces;
  };
  // The families_generation and renderer mode the families were listed for.
  uint64_t generation = 0;
  bool system = false;
  bool listed = false;
  // The installed families in scan order: `assets`' by case-folded name,
  // then the asset font manager's that `assets` has no installed face for.
  // A family both have lists `assets`' faces, then the manager's faces
  // `assets` does not list (fontconfig and DirectWrite list faces, not
  // families: a loaded face of an installed family does not hide the
  // family's other faces).
  std::vector<Family> families;
  // ReadFaceIdentity of the faces a family both list, by typeface ID.
  std::unordered_map<SkTypefaceID, std::string> identities;
  // The characters of each face the scan reached, by typeface ID (never
  // reused); kept across listings for the faces that stay.
  std::unordered_map<SkTypefaceID, Coverage> coverage;
  std::unordered_map<SkTypefaceID, bool> color;
  // The instances AtRequestAxes made, by face and axis values, so a face
  // keeps one instance (one typeface ID) for a style; at most 64, dropped
  // with each listing.
  std::map<std::tuple<SkTypefaceID, uint32_t, uint32_t, uint32_t>,
           sk_sp<SkTypeface>>
      instances;

  const Coverage& CoverageOf(SkTypeface* face) {
    auto found = coverage.find(face->uniqueID());
    if (found == coverage.end()) {
      found = coverage.emplace(face->uniqueID(), ReadCoverage(face)).first;
    }
    return found->second;
  }
  bool Has(SkTypeface* face, uint32_t c) { return Covers(CoverageOf(face), c); }
  const std::string& IdentityOf(SkTypeface* face) {
    auto found = identities.find(face->uniqueID());
    if (found == identities.end()) {
      found =
          identities.emplace(face->uniqueID(), ReadFaceIdentity(face)).first;
    }
    return found->second;
  }
  // FontCache::GetFontPlatformData by family name, then
  // FontContainsCharacter: the installed family's face for the style, when
  // it has the character.
  sk_sp<SkTypeface> Named(std::string_view name,
                          const SkFontStyle& style,
                          uint32_t c) {
    const std::string folded = FoldFamilyName(name);
    for (const auto& family : families) {
      if (family.folded != folded) {
        continue;
      }
      FaceSet set(family.faces);
      sk_sp<SkTypeface> face = set.matchStyle(style);
      return face && Has(face.get(), c) ? face : nullptr;
    }
    return nullptr;
  }
  // A variable face at the request's wght, wdth and slnt, as a named
  // installed family is (FontVariations): the instance fontconfig's and
  // DirectWrite's match of the style gives Chrome, not the default one.
  sk_sp<SkTypeface> AtRequestAxes(sk_sp<SkTypeface> face,
                                  const skiac_text_request& request) {
    const int count = face->getVariationDesignPosition({});
    if (count <= 0) {
      return face;
    }
    std::vector<SkFontArguments::VariationPosition::Coordinate> coordinates(
        count);
    std::vector<SkFontParameters::Variation::Axis> axes(
        std::max(face->getVariationDesignParameters({}), 0));
    if (face->getVariationDesignPosition(coordinates) != count ||
        face->getVariationDesignParameters(axes) !=
            static_cast<int>(axes.size())) {
      return face;
    }
    bool changed = false;
    for (auto& coordinate : coordinates) {
      float value = coordinate.value;
      if (coordinate.axis == kWght) {
        value = request.weight;
      } else if (coordinate.axis == kWdth) {
        value = request.stretch_pct;
      } else if (coordinate.axis == kSlnt) {
        // CSS slants clockwise, OpenType counter-clockwise.
        value = -request.slope;
      } else {
        continue;
      }
      for (const auto& axis : axes) {
        if (axis.tag == coordinate.axis) {
          value = std::max(std::min(value, axis.max), axis.min);
        }
      }
      if (value != coordinate.value) {
        coordinate.value = value;
        changed = true;
      }
    }
    if (!changed) {
      return face;
    }
    const auto key =
        std::make_tuple(face->uniqueID(), Bits(request.weight),
                        Bits(request.stretch_pct), Bits(request.slope));
    if (auto found = instances.find(key); found != instances.end()) {
      return found->second;
    }
    SkFontArguments args;
    args.setVariationDesignPosition(
        {coordinates.data(), static_cast<int>(coordinates.size())});
    sk_sp<SkTypeface> instance = face->makeClone(args);
    if (!instance) {
      return face;
    }
    if (instances.size() >= 64) {
      instances.clear();
    }
    instances.emplace(key, instance);
    return instance;
  }
  bool Color(SkTypeface* face) {
    auto found = color.find(face->uniqueID());
    if (found == color.end()) {
      found =
          color.emplace(face->uniqueID(), TypefaceHasColorTable(face)).first;
    }
    return found->second;
  }
};

void InstalledFallbackIndexDeleter::operator()(
    InstalledFallbackIndex* index) const {
  delete index;
}

InstalledFallbackIndex* MakeInstalledFallbackIndex() {
  return new InstalledFallbackIndex();
}

bool ListInstalledFallbackFamilies(skiac_font_collection* c_collection,
                                   InstalledFallbackIndex* index) {
  const bool system = SystemFontRenderer();
  if (index->listed && index->generation == c_collection->families_generation &&
      index->system == system) {
    return false;
  }
  index->listed = true;
  index->generation = c_collection->families_generation;
  index->system = system;
  index->families.clear();
  index->instances.clear();
  // CoreText already asked: on Apple with the system renderer, the faces it
  // lists (loadSystemFonts') are not asked again.
  bool coretext = false;
#if defined(__APPLE__)
  coretext = system && c_collection->font_mgr;
#endif
  std::map<std::string, std::vector<sk_sp<SkTypeface>>> listed;
  for (const auto& [id, font] : c_collection->assets->getRegisteredFonts()) {
    if (!font.typeface || !c_collection->system_font_ids.count(id) ||
        (coretext && font.installed)) {
      continue;
    }
    SkString family;
    font.typeface->getFamilyName(&family);
    std::string folded = FoldFamilyName({family.c_str(), family.size()});
    // font_cache_mac.mm: never the LastResort font.
    if (folded.empty() || folded == "lastresort") {
      continue;
    }
    listed[std::move(folded)].push_back(font.typeface);
  }
  // Each family `assets` lists, by its place in `families`.
  std::map<std::string, size_t> in_assets;
  for (auto& [folded, faces] : listed) {
    in_assets.emplace(folded, index->families.size());
    index->families.push_back({folded, std::move(faces)});
  }
  // The asset font manager's own families (Linux, Windows and Android with
  // DISABLE_SYSTEM_FONTS_LOAD find them by name too). Not CoreText's.
  // The manager's faces `assets` lists already: their identities are kept,
  // so the next listing does not read them again.
  std::set<SkTypefaceID> duplicates;
  const sk_sp<SkFontMgr>& manager = c_collection->font_mgr;
  if (manager && !coretext) {
    std::map<std::string, std::vector<sk_sp<SkTypeface>>> others;
    const int count = manager->countFamilies();
    for (int i = 0; i < count; ++i) {
      SkString family;
      manager->getFamilyName(i, &family);
      std::string folded = FoldFamilyName({family.c_str(), family.size()});
      if (folded.empty() || folded == "lastresort") {
        continue;
      }
      // A family `assets` lists too takes the manager's faces it does not
      // list (the same file loadSystemFonts or loadFontsFromDir loaded).
      const auto merged = in_assets.find(folded);
      std::set<std::string> loaded;
      if (merged != in_assets.end()) {
        for (const auto& face : index->families[merged->second].faces) {
          if (const std::string& identity = index->IdentityOf(face.get());
              !identity.empty()) {
            loaded.insert(identity);
          }
        }
      }
      sk_sp<SkFontStyleSet> set = manager->createStyleSet(i);
      for (int j = 0; set && j < set->count(); ++j) {
        sk_sp<SkTypeface> face = set->createTypeface(j);
        if (!face) {
          continue;
        }
        if (merged == in_assets.end()) {
          others[folded].push_back(std::move(face));
          continue;
        }
        const std::string& identity = index->IdentityOf(face.get());
        if (identity.empty() || !loaded.count(identity)) {
          index->families[merged->second].faces.push_back(std::move(face));
        } else {
          duplicates.insert(face->uniqueID());
        }
      }
    }
    for (auto& [folded, faces] : others) {
      index->families.push_back({folded, std::move(faces)});
    }
  }
  // Forget the faces no family lists any more.
  std::set<SkTypefaceID> kept;
  for (const auto& family : index->families) {
    for (const auto& face : family.faces) {
      kept.insert(face->uniqueID());
    }
  }
  for (auto it = index->coverage.begin(); it != index->coverage.end();) {
    it = kept.count(it->first) ? std::next(it) : index->coverage.erase(it);
  }
  for (auto it = index->color.begin(); it != index->color.end();) {
    it = kept.count(it->first) ? std::next(it) : index->color.erase(it);
  }
  for (auto it = index->identities.begin(); it != index->identities.end();) {
    it = kept.count(it->first) || duplicates.count(it->first)
             ? std::next(it)
             : index->identities.erase(it);
  }
  return true;
}

SystemFallbackFont InstalledFallback(skiac_font_collection* c_collection,
                                     InstalledFallbackIndex* index,
                                     const skiac_text_request& request,
                                     SkTypeface* first_family,
                                     uint32_t character,
                                     Priority priority,
                                     int han_script,
                                     bool monospace) {
  (void)c_collection;
  SystemFallbackFont result;
  const bool emoji_presentation = priority == Priority::kEmojiEmoji ||
                                  priority == Priority::kEmojiEmojiWithVS;
  // SystemFallbackEmojiVSSupport: an emoji character as text is asked for
  // as text presentation emoji.
  const bool text_emoji =
      priority == Priority::kEmojiText ||
      priority == Priority::kEmojiTextWithVS ||
      (priority == Priority::kText &&
       u_hasBinaryProperty(static_cast<UChar32>(character), UCHAR_EMOJI));
  const bool bold = request.weight >= kBoldThreshold;
  const bool italic = request.slope == kItalicSlope;
  const SkFontStyle style(static_cast<int>(request.weight + 0.5f),
                          request.stretch,
                          static_cast<SkFontStyle::Slant>(request.style));
  // CreateFontPlatformDataForTypeface: bold or italic the face lacks is
  // synthesized.
  auto found = [&](sk_sp<SkTypeface> face) {
    face = index->AtRequestAxes(std::move(face), request);
    result.synthetic = {bold && !face->isBold(), italic && !face->isItalic()};
    result.face = std::move(face);
    return result;
  };
  // 0. FallbackOnStandardFontStyle (font_cache_skia.cc): for italic text or
  // a weight of 700 or more (font_cache_skia_win.cc asks at kBoldWeightValue;
  // the face is then made bold from kBoldThreshold), the first family at the
  // normal style, made bold or italic, when it has the character. Not for
  // emoji presentation.
  if (first_family && !emoji_presentation &&
      (italic || request.weight >= kBoldWeight)) {
    SkString family;
    first_family->getFamilyName(&family);
    if (sk_sp<SkTypeface> normal =
            index->Named({family.c_str(), family.size()}, SkFontStyle::Normal(),
                         character)) {
      result.face = std::move(normal);
      result.synthetic = {bold, italic};
      return result;
    }
  }
  // 1. Windows' hard-coded choices (font_cache_skia_win.cc
  // GetFallbackFamilyNameFromHardcodedChoices, font_fallback_win.cc
  // GetFallbackFamily): the emoji, block or script family by name, with the
  // request's style, when it has the character.
  auto installed = [&](const char* name) {
    const std::string folded = FoldFamilyName(name);
    return std::any_of(index->families.begin(), index->families.end(),
                       [&](const InstalledFallbackIndex::Family& family) {
                         return family.folded == folded;
                       });
  };
  // FirstAvailableFont: the first installed name of a list, or none.
  auto first_installed = [&](const std::vector<const char*>& list) {
    for (const char* name : list) {
      if (installed(name)) {
        return name;
      }
    }
    return static_cast<const char*>(nullptr);
  };
  const char* name = nullptr;
  if (emoji_presentation) {
    name = first_installed({"Segoe UI Emoji", "Segoe UI Symbol"});
  } else if (text_emoji) {
    name = first_installed({"Segoe UI Symbol", "Segoe UI Emoji"});
  } else if (const std::vector<const char*> block =
                 WindowsBlockFamilies(character);
             block.size() == 1) {
    // GetFontBasedOnUnicodeBlock's symbol blocks name Segoe UI Symbol
    // whether it is installed or not: when it is not, the pan-Unicode lists
    // come next, not the script's fonts.
    name = block.front();
  } else {
    name = first_installed(block);
  }
  std::string script = ScriptOf(character);
  bool han = false;
  if (!name) {
    if (character > 0xFF00 && character < 0xFF5F) {
      script = "Hani";
    }
    if (script == "Zyyy") {
      script = ScriptOfBlock(character);
    }
    if (script == "Hani") {
      // LayoutLocale::LocaleForHan: the content language's, else the
      // host's; with none, Han keeps the host's (simplified) list and the
      // CJK list below.
      if (const char* han_name = HanScriptName(han_script)) {
        script = han_name;
      } else {
        han = true;
        script = "Hans";
      }
    }
    // GetFontFamilyForScript, for the BMP only: FindMonospaceFontForScript,
    // then the script's list.
    if (character <= 0xFFFF) {
      if (monospace && (script == "Arab" || script == "Hebr")) {
        name = "courier new";
      } else if (const auto* families =
                     FamiliesOf(WindowsScriptFamilies(), script)) {
        name = first_installed(*families);
      }
    }
    if (!name) {
      switch (character >> 16) {
        case 1:
          name = "code2001";
          break;
        case 2:
          name = character >= 0x2EBF0 && character <= 0x2EE5F ? "simsun-extg"
                 : han_script == USCRIPT_TRADITIONAL_HAN      ? "pmingliu-extb"
                                                              : "simsun-extb";
          break;
        case 3:
          name = "simsun-extg";
          break;
        default:
          name = "lucida sans unicode";
          break;
      }
    }
  }
  if (sk_sp<SkTypeface> face = index->Named(name, style, character)) {
    return found(std::move(face));
  }
#if defined(__APPLE__)
  // 1b. Chrome mac's CoreText cascade, by name.
  {
    const std::string mac_script =
        emoji_presentation ? std::string() : ScriptOf(character);
    const std::vector<const char*> emoji = {"Apple Color Emoji"};
    const std::vector<const char*>* families =
        emoji_presentation
            ? &emoji
            : FamiliesOf(MacScriptFamilies(), mac_script == "Zyyy"
                                                  ? ScriptOfBlock(character)
                                                  : mac_script);
    for (size_t i = 0; families && i < families->size(); ++i) {
      if (sk_sp<SkTypeface> face =
              index->Named((*families)[i], style, character)) {
        return found(std::move(face));
      }
    }
  }
#endif
  // Windows' pan-Unicode lists (CJK for an unresolved Han character).
  static const char* const kCjkFonts[] = {"arial unicode ms",
                                          "ms pgothic",
                                          "simsun",
                                          "gulim",
                                          "pmingliu",
                                          "wenquanyi zen hei",
                                          "ar pl shanheisun uni",
                                          "ar pl zenkai uni",
                                          "han nom a",
                                          "code2000"};
  static const char* const kCommonFonts[] = {"tahoma",
                                             "arial unicode ms",
                                             "lucida sans unicode",
                                             "microsoft sans serif",
                                             "palatino linotype",
                                             "dejavu serif",
                                             "dejavu sasns",
                                             "freeserif",
                                             "freesans",
                                             "gentium",
                                             "gentiumalt",
                                             "ms pgothic",
                                             "simsun",
                                             "gulim",
                                             "pmingliu",
                                             "code2000"};
  if (!emoji_presentation) {
    const auto pan = han ? std::vector<const char*>(std::begin(kCjkFonts),
                                                    std::end(kCjkFonts))
                         : std::vector<const char*>(std::begin(kCommonFonts),
                                                    std::end(kCommonFonts));
    for (const char* name : pan) {
      if (sk_sp<SkTypeface> face = index->Named(name, style, character)) {
        return found(std::move(face));
      }
    }
  }
  // 2. The scan (fontconfig's sorted list, DirectWrite's
  // matchFamilyStyleCharacter): the first family with a face that has the
  // character, and the face of it that matches the request's style. For
  // emoji presentation, faces with color tables first.
  for (int pass = emoji_presentation ? 0 : 1; pass < 2; ++pass) {
    for (const auto& entry : index->families) {
      std::vector<sk_sp<SkTypeface>> faces;
      for (const auto& face : entry.faces) {
        if (index->Has(face.get(), character) &&
            (pass == 1 || index->Color(face.get()))) {
          faces.push_back(face);
        }
      }
      if (faces.empty()) {
        continue;
      }
      FaceSet set(std::move(faces));
      if (sk_sp<SkTypeface> face = set.matchStyle(style)) {
        return found(std::move(face));
      }
    }
  }
  return result;
}
