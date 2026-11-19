// A 1:1 port of Blink's font_selection_algorithm.cc (distances) and the
// parts of font_selection_types.h it uses.

#include "font_selection.hpp"

#include <math.h>
#include <algorithm>

namespace font_selection {

namespace {

// font_selection_types.h.
const Value kItalicThreshold(14);
const Value kNormalWidthValue(100);
const Value kUpperWeightSearchThreshold(500);
const Value kLowerWeightSearchThreshold(400);

}  // namespace

// ClampTo<int16_t>(x * kFractionalEntropy).
Value::Value(float x) {
  const float scaled = x * 4;
  raw_ = isnan(scaled)      ? 0
         : scaled >= 32767  ? static_cast<int16_t>(32767)
         : scaled <= -32768 ? static_cast<int16_t>(-32768)
                            : static_cast<int16_t>(scaled);
}

void Capabilities::Expand(const Capabilities& o) {
  auto expand = [](Range& range, const Range& other) {
    range.minimum = std::min(range.minimum, other.minimum);
    range.maximum = std::max(range.maximum, other.maximum);
  };
  expand(width, o.width);
  expand(slope, o.slope);
  expand(weight, o.weight);
}

Value Algorithm::StretchDistance(const Capabilities& capabilities) const {
  const Range& width = capabilities.width;
  if (width.Includes(request_.width)) {
    return Value();
  }
  if (request_.width > kNormalWidthValue) {
    if (width.minimum > request_.width) {
      return width.minimum - request_.width;
    }
    const Value threshold = std::max(request_.width, bounds_.width.maximum);
    return threshold - width.maximum;
  }
  if (width.maximum < request_.width) {
    return request_.width - width.maximum;
  }
  const Value threshold = std::min(request_.width, bounds_.width.minimum);
  return width.minimum - threshold;
}

Value Algorithm::StyleDistance(const Capabilities& capabilities) const {
  const Range& slope = capabilities.slope;
  if (slope.Includes(request_.slope)) {
    return Value();
  }
  if (request_.slope >= kItalicThreshold) {
    if (slope.minimum > request_.slope) {
      return slope.minimum - request_.slope;
    }
    const Value threshold = std::max(request_.slope, bounds_.slope.maximum);
    return threshold - slope.maximum;
  }
  if (request_.slope >= Value()) {
    if (slope.maximum >= Value() && slope.maximum < request_.slope) {
      return request_.slope - slope.maximum;
    }
    if (slope.minimum > request_.slope) {
      return slope.minimum;
    }
    const Value threshold = std::max(request_.slope, bounds_.slope.maximum);
    return threshold - slope.maximum;
  }
  if (request_.slope > -kItalicThreshold) {
    if (slope.minimum > request_.slope && slope.minimum <= Value()) {
      return slope.minimum - request_.slope;
    }
    if (slope.maximum < request_.slope) {
      return -slope.maximum;
    }
    const Value threshold = std::min(request_.slope, bounds_.slope.minimum);
    return slope.minimum - threshold;
  }
  if (slope.maximum < request_.slope) {
    return request_.slope - slope.maximum;
  }
  const Value threshold = std::min(request_.slope, bounds_.slope.minimum);
  return slope.minimum - threshold;
}

Value Algorithm::WeightDistance(const Capabilities& capabilities) const {
  const Range& weight = capabilities.weight;
  if (weight.Includes(request_.weight)) {
    return Value();
  }
  if (request_.weight >= kLowerWeightSearchThreshold &&
      request_.weight <= kUpperWeightSearchThreshold) {
    if (weight.minimum > request_.weight &&
        weight.minimum <= kUpperWeightSearchThreshold) {
      return weight.minimum - request_.weight;
    }
    if (weight.maximum < request_.weight) {
      return kUpperWeightSearchThreshold - weight.maximum;
    }
    const Value threshold = std::min(request_.weight, bounds_.weight.minimum);
    return weight.minimum - threshold;
  }
  if (request_.weight < kLowerWeightSearchThreshold) {
    if (weight.maximum < request_.weight) {
      return request_.weight - weight.maximum;
    }
    const Value threshold = std::min(request_.weight, bounds_.weight.minimum);
    return weight.minimum - threshold;
  }
  if (weight.minimum > request_.weight) {
    return weight.minimum - request_.weight;
  }
  const Value threshold = std::max(request_.weight, bounds_.weight.maximum);
  return threshold - weight.maximum;
}

bool Algorithm::IsBetterMatchForRequest(const Capabilities& first,
                                        const Capabilities& second) const {
  const Value stretch_first = StretchDistance(first);
  const Value stretch_second = StretchDistance(second);
  if (stretch_first != stretch_second) {
    return stretch_first < stretch_second;
  }
  const Value style_first = StyleDistance(first);
  const Value style_second = StyleDistance(second);
  if (style_first != style_second) {
    return style_first < style_second;
  }
  return WeightDistance(first) < WeightDistance(second);
}

}  // namespace font_selection
