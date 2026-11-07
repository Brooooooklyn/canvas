// The Blink shaper's system fallback font on Apple (shaper.hpp): a port of
// font_cache_mac.mm GetSubstituteFont and GetAlternateFontPlatformData, with
// the CoreText C API (Blink's NSArray / NSDictionary literals are CFArray /
// CFDictionary here). No language is passed at any step
// (CTFontCreateForString, not CTFontCreateForStringWithLanguage): Blink's mac
// fallback does not depend on the content language.

#if defined(__APPLE__)

// CoreText's headers declare a global TextRange, which skia_c.hpp's
// `using namespace skia::textlayout` would make ambiguous: they go first
// (as in font_scalers.cpp).
#include <CoreText/CoreText.h>
#include <include/ports/SkTypeface_mac.h>

#include "icu_api.h"
#include "shaper.hpp"

namespace {

// A CF object released when it goes out of scope (ScopedCFTypeRef).
template <typename T>
class ScopedCF {
 public:
  explicit ScopedCF(T ref = nullptr) : ref_(ref) {}
  ScopedCF(const ScopedCF&) = delete;
  ScopedCF& operator=(const ScopedCF&) = delete;
  ~ScopedCF() {
    if (ref_) {
      CFRelease(ref_);
    }
  }
  void reset(T ref) {
    if (ref_) {
      CFRelease(ref_);
    }
    ref_ = ref;
  }
  T get() const { return ref_; }
  explicit operator bool() const { return ref_ != nullptr; }

 private:
  T ref_;
};

constexpr float kCTNormalWeightValue = 0.0;
constexpr CTFontSymbolicTraits kTraitsMask =
    kCTFontTraitItalic | kCTFontTraitBold | kCTFontTraitCondensed |
    kCTFontTraitExpanded;

// font_matcher_mac.mm ToCTFontWeight.
float ToCTFontWeight(int css_weight) {
  if (css_weight <= 50 || css_weight >= 950) {
    return 0.0;
  }
  const float weights[] = {-0.80, -0.60, -0.40, 0.0, 0.23,
                           0.30,  0.40,  0.56,  0.62};
  return weights[(css_weight - 50) / 100];
}

CFNumberRef MakeNumber(float value) {
  return CFNumberCreate(kCFAllocatorDefault, kCFNumberFloatType, &value);
}

CFNumberRef MakeNumber(uint32_t value) {
  const int64_t wide = value;
  return CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt64Type, &wide);
}

CFDictionaryRef MakeDictionary(const void** keys,
                               const void** values,
                               CFIndex count) {
  return CFDictionaryCreate(kCFAllocatorDefault, keys, values, count,
                            &kCFTypeDictionaryKeyCallBacks,
                            &kCFTypeDictionaryValueCallBacks);
}

// font_cache_mac.mm CreateCopyWithTraitsAndWeightFromFont.
CTFontRef CreateCopyWithTraitsAndWeightFromFont(CTFontRef font,
                                                CTFontSymbolicTraits traits,
                                                float weight,
                                                float size) {
  ScopedCF<CFStringRef> family_name(CTFontCopyFamilyName(font));
  if (!family_name) {
    return nullptr;
  }
  ScopedCF<CFNumberRef> traits_number(MakeNumber(uint32_t{traits}));
  ScopedCF<CFNumberRef> weight_number(MakeNumber(weight));
  const void* trait_keys[] = {kCTFontSymbolicTrait, kCTFontWeightTrait};
  const void* trait_values[] = {traits_number.get(), weight_number.get()};
  ScopedCF<CFDictionaryRef> traits_dict(
      MakeDictionary(trait_keys, trait_values, 2));
  const void* keys[] = {kCTFontFamilyNameAttribute, kCTFontTraitsAttribute};
  const void* values[] = {family_name.get(), traits_dict.get()};
  ScopedCF<CFDictionaryRef> attributes(MakeDictionary(keys, values, 2));
  ScopedCF<CTFontDescriptorRef> descriptor(
      CTFontDescriptorCreateWithAttributes(attributes.get()));
  // CTFontCreateWithFontDescriptor, not CTFontCreateCopyWithAttributes: the
  // latter keeps "Menlo Regular" for an italic request (Blink's comment).
  return CTFontCreateWithFontDescriptor(descriptor.get(), size, nullptr);
}

bool IsLastResortFont(CTFontRef font) {
  ScopedCF<CFStringRef> name(CTFontCopyPostScriptName(font));
  return name && CFStringCompare(name.get(), CFSTR("LastResort"), 0) ==
                     kCFCompareEqualTo;
}

bool IsAppleColorEmojiFont(CTFontRef font) {
  ScopedCF<CFStringRef> family(CTFontCopyName(font, kCTFontFamilyNameKey));
  return family &&
         (CFStringCompare(family.get(), CFSTR("Apple Color Emoji"),
                          kCFCompareCaseInsensitive) == kCFCompareEqualTo ||
          CFStringCompare(family.get(), CFSTR(".Apple Color Emoji UI"),
                          kCFCompareCaseInsensitive) == kCFCompareEqualTo);
}

// font_cache_mac.mm GetSubstituteFont, with SystemFallbackEmojiVSSupport
// (stable).
CTFontRef GetSubstituteFont(CTFontRef ct_font, uint32_t character, float size) {
  const uint32_t utf32 = static_cast<uint32_t>(character);
  ScopedCF<CFStringRef> string(CFStringCreateWithBytes(
      kCFAllocatorDefault, reinterpret_cast<const UInt8*>(&utf32),
      sizeof(utf32), kCFStringEncodingUTF32LE, false));
  if (!string) {
    return nullptr;
  }
  const CFRange range = CFRangeMake(0, CFStringGetLength(string.get()));
  ScopedCF<CTFontRef> substitute;
  if (!ct_font) {
    // A typeface without a CTFont (Fontations): Blink substitutes from the
    // standard font of the user settings, Times.
    ScopedCF<CTFontRef> times(
        CTFontCreateWithName(CFSTR("Times"), size, nullptr));
    substitute.reset(CTFontCreateForString(times.get(), string.get(), range));
  } else {
    substitute.reset(CTFontCreateForString(ct_font, string.get(), range));
  }
  if (!substitute || IsLastResortFont(substitute.get())) {
    return nullptr;
  }
  // An emoji asked for without emoji presentation: the monochrome "Apple
  // Symbols", with the color emoji font's cascade list for English.
  if (IsAppleColorEmojiFont(substitute.get()) &&
      u_hasBinaryProperty(character, UCHAR_EMOJI)) {
    const void* languages[] = {CFSTR("en")};
    ScopedCF<CFArrayRef> language_list(CFArrayCreate(
        kCFAllocatorDefault, languages, 1, &kCFTypeArrayCallBacks));
    ScopedCF<CFArrayRef> cascade_list(CTFontCopyDefaultCascadeListForLanguages(
        substitute.get(), language_list.get()));
    const void* keys[] = {kCTFontNameAttribute, kCTFontCascadeListAttribute};
    const void* values[] = {CFSTR("Apple Symbols"), cascade_list.get()};
    ScopedCF<CFDictionaryRef> attributes(
        MakeDictionary(keys, values, cascade_list ? 2 : 1));
    ScopedCF<CTFontDescriptorRef> descriptor(
        CTFontDescriptorCreateWithAttributes(attributes.get()));
    ScopedCF<CTFontRef> mono_emoji(
        CTFontCreateWithFontDescriptor(descriptor.get(), size, nullptr));
    if (mono_emoji) {
      substitute.reset(
          CTFontCreateForString(mono_emoji.get(), string.get(), range));
    }
  }
  if (!substitute) {
    return nullptr;
  }
  CFRetain(substitute.get());
  return substitute.get();
}

float CTFontWeight(CTFontRef font) {
  ScopedCF<CFDictionaryRef> traits(CTFontCopyTraits(font));
  float weight = kCTNormalWeightValue;
  if (traits) {
    const void* value = CFDictionaryGetValue(traits.get(), kCTFontWeightTrait);
    if (value && CFGetTypeID(value) == CFNumberGetTypeID()) {
      CFNumberGetValue(static_cast<CFNumberRef>(value), kCFNumberFloatType,
                       &weight);
    }
  }
  return weight;
}

}  // namespace

SystemFallbackFont MacAlternateFont(SkTypeface* base,
                                    SyntheticStyle base_synthetic,
                                    uint32_t character,
                                    int css_weight,
                                    bool italic,
                                    float computed_pixel_size) {
  SystemFallbackFont result;
  CTFontRef ct_font = base ? SkTypeface_GetCTFontRef(base) : nullptr;
  const float size = computed_pixel_size;
  ScopedCF<CTFontRef> substitute(GetSubstituteFont(ct_font, character, size));
  if (!substitute) {
    return result;
  }
  CTFontSymbolicTraits traits;
  const float weight = ToCTFontWeight(css_weight);
  if (ct_font) {
    traits = CTFontGetSymbolicTraits(ct_font);
    if (base_synthetic.bold) {
      traits |= kCTFontTraitBold;
    }
    if (base_synthetic.italic) {
      traits |= kCTFontTraitItalic;
    }
  } else {
    traits = italic ? kCTFontTraitItalic : 0;
  }
  CTFontSymbolicTraits substitute_traits =
      CTFontGetSymbolicTraits(substitute.get());
  const float substitute_weight = CTFontWeight(substitute.get());
  if ((traits & kTraitsMask) != (substitute_traits & kTraitsMask) ||
      weight != substitute_weight || !ct_font) {
    ScopedCF<CTFontRef> best_variation(CreateCopyWithTraitsAndWeightFromFont(
        substitute.get(), traits, weight, size));
    if (best_variation) {
      const CTFontSymbolicTraits best_traits =
          CTFontGetSymbolicTraits(best_variation.get());
      const float best_weight = CTFontWeight(best_variation.get());
      ScopedCF<CFCharacterSetRef> char_set(
          CTFontCopyCharacterSet(best_variation.get()));
      if ((!ct_font || best_traits != substitute_traits ||
           best_weight != substitute_weight) &&
          char_set &&
          CFCharacterSetIsLongCharacterMember(
              char_set.get(), static_cast<UTF32Char>(character))) {
        CFRetain(best_variation.get());
        substitute.reset(best_variation.get());
        substitute_traits = CTFontGetSymbolicTraits(substitute.get());
      }
    }
  }
  result.face = SkMakeTypefaceFromCTFont(substitute.get());
  result.synthetic.bold =
      (traits & kCTFontTraitBold) && !(substitute_traits & kCTFontTraitBold);
  result.synthetic.italic = (traits & kCTFontTraitItalic) &&
                            !(substitute_traits & kCTFontTraitItalic);
  return result;
}

SyntheticStyle MacMatchedFontSynthetic(SkTypeface* face,
                                       float css_weight,
                                       bool italic) {
  // font_cache_mac.mm CreateFontPlatformData: the matched font's traits.
  CTFontRef ct_font = SkTypeface_GetCTFontRef(face);
  const CTFontSymbolicTraits traits =
      ct_font ? CTFontGetSymbolicTraits(ct_font) : 0;
  return {css_weight > 500 && !(traits & kCTFontTraitBold),
          italic && !(traits & kCTFontTraitItalic)};
}

#endif  // defined(__APPLE__)
