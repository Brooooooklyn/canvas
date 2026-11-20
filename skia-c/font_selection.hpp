// Blink's choice among the faces of one web font family
// (font_selection_types.h, font_selection_algorithm.cc): each face has the
// capabilities its descriptors give, and FontFaceCache::Get takes the best
// match for the request (stretch, then style, then weight distance).

#ifndef SKIA_C_FONT_SELECTION_H
#define SKIA_C_FONT_SELECTION_H

#include <stdint.h>

namespace font_selection {

// FontSelectionValue: a signed 16-bit fixed-point number with two
// fractional bits (0.25 steps, truncated, clamped to the int16 range).
class Value {
 public:
  constexpr Value() = default;
  explicit Value(float x);
  constexpr bool operator==(const Value& o) const { return raw_ == o.raw_; }
  constexpr bool operator!=(const Value& o) const { return raw_ != o.raw_; }
  constexpr bool operator<(const Value& o) const { return raw_ < o.raw_; }
  constexpr bool operator<=(const Value& o) const { return raw_ <= o.raw_; }
  constexpr bool operator>(const Value& o) const { return raw_ > o.raw_; }
  constexpr bool operator>=(const Value& o) const { return raw_ >= o.raw_; }
  // Wraps as Blink's operator- (int16 backing, unchecked).
  Value operator-(const Value& o) const { return Raw(raw_ - o.raw_); }
  Value operator-() const { return Raw(-raw_); }
  float ToFloat() const { return raw_ / 4.0f; }

 private:
  static Value Raw(int raw) {
    Value v;
    v.raw_ = static_cast<int16_t>(raw);
    return v;
  }
  int16_t raw_ = 0;
};

// FontSelectionRange; == ignores whether it came from `auto`.
struct Range {
  Value minimum;
  Value maximum;
  bool operator==(const Range& o) const {
    return minimum == o.minimum && maximum == o.maximum;
  }
  bool Includes(Value v) const { return v >= minimum && v <= maximum; }
};

struct Capabilities {
  Range width;
  Range slope;
  Range weight;
  bool operator==(const Capabilities& o) const {
    return width == o.width && slope == o.slope && weight == o.weight;
  }
  // FontSelectionCapabilities::Expand.
  void Expand(const Capabilities& o);
};

struct Request {
  Value weight;
  Value width;
  Value slope;
};

// FontSelectionAlgorithm: `bounds` is every candidate's capabilities
// expanded (FontFaceCache::CapabilitiesSet::Get).
class Algorithm {
 public:
  Algorithm(const Request& request, const Capabilities& bounds)
      : request_(request), bounds_(bounds) {}
  bool IsBetterMatchForRequest(const Capabilities& first,
                               const Capabilities& second) const;

 private:
  Value StretchDistance(const Capabilities& capabilities) const;
  Value StyleDistance(const Capabilities& capabilities) const;
  Value WeightDistance(const Capabilities& capabilities) const;

  Request request_;
  Capabilities bounds_;
};

}  // namespace font_selection

#endif  // SKIA_C_FONT_SELECTION_H
