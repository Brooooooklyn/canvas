// SVG images that src/svg_doc prepared: SkSVGDOM draws them through a canvas
// that does what Chrome does for <image> and <text> (svg_image.cpp).

#ifndef SKIA_C_SVG_IMAGE_H
#define SKIA_C_SVG_IMAGE_H

#include "skia_c.hpp"

namespace napi_svg {

// The SkSVGDOM of a prepared document, with the images its <image>
// elements name and the font lists its font-family attributes name.
// `resources` gets what RenderPrepared needs.
sk_sp<SkSVGDOM> MakePreparedDocument(
    SkStream& stream,
    skiac_font_collection* c_collection,
    const skiac_svg_resource* images,
    size_t image_count,
    const skiac_svg_font_list* fonts,
    size_t font_count,
    sk_sp<skresources::ResourceProvider>* resources);

// Draws a prepared document on `canvas`, a raster in colour space `cs`.
// The caller holds the font collection's lock.
void RenderPrepared(SkSVGDOM* dom,
                    skresources::ResourceProvider* resources,
                    SkCanvas* canvas,
                    uint8_t cs);

// The bytes the images of a prepared document keep (encoded, decoded and
// scaled copies, nested pictures), which grow as it draws.
size_t RetainedBytes(const skresources::ResourceProvider* resources);

}  // namespace napi_svg

#endif  // SKIA_C_SVG_IMAGE_H
