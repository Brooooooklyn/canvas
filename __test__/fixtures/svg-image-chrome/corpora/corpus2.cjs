// Geometry / general feature corpus (no CSS sheet features), to compare raster fidelity.
const S = (body, attrs = 'width="60" height="60"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`
const C = {}
const add = (k, svg, w = 60, h = 60, dst) => {
  C[k] = { svg, w, h, dst }
}
add('g_circle', S('<circle cx="30" cy="30" r="22.3" fill="#3a7"/>'))
add('g_ellipse', S('<ellipse cx="30" cy="30" rx="25" ry="11" fill="navy" transform="rotate(30 30 30)"/>'))
add('g_path_curves', S('<path d="M5 50 C 10 5, 50 5, 55 50 Q 30 30 5 50Z" fill="purple"/>'))
add('g_arc', S('<path d="M10 30 A 20 15 0 1 1 50 30" fill="none" stroke="black" stroke-width="3"/>'))
add(
  'g_stroke_join',
  S(
    '<polyline points="5,50 20,10 35,50 50,10" fill="none" stroke="teal" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>',
  ),
)
add(
  'g_stroke_miter',
  S('<polyline points="5,50 20,10 35,50 50,10" fill="none" stroke="teal" stroke-width="6" stroke-miterlimit="10"/>'),
)
add(
  'g_dash',
  S(
    '<circle cx="30" cy="30" r="20" fill="none" stroke="black" stroke-width="2" stroke-dasharray="5 3" stroke-dashoffset="2"/>',
  ),
)
add('g_hairline', S('<line x1="3" y1="7.5" x2="57" y2="52.3" stroke="black" stroke-width="0.5"/>'))
add(
  'g_lingrad',
  S(
    '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="red"/><stop offset="0.5" stop-color="yellow" stop-opacity="0.5"/><stop offset="1" stop-color="blue"/></linearGradient><rect width="60" height="60" fill="url(#g)"/>',
  ),
)
add(
  'g_radgrad',
  S(
    '<radialGradient id="g" cx="0.4" cy="0.4" r="0.5" fx="0.3" fy="0.3" spreadMethod="reflect"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="green"/></radialGradient><rect width="60" height="60" fill="url(#g)"/>',
  ),
)
add(
  'g_grad_userspace',
  S(
    '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="50" y2="0" gradientTransform="rotate(20)"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient><circle cx="30" cy="30" r="25" fill="url(#g)"/>',
  ),
)
add(
  'g_opacity_group',
  S(
    '<g opacity="0.5"><rect width="40" height="40" fill="red"/><rect x="20" y="20" width="40" height="40" fill="blue"/></g>',
  ),
)
add(
  'g_fill_opacity',
  S(
    '<rect width="40" height="40" fill="red" fill-opacity="0.3"/><rect x="20" y="20" width="40" height="40" fill="blue" fill-opacity="0.6" stroke="black" stroke-opacity="0.5" stroke-width="4"/>',
  ),
)
add(
  'g_transform_skew',
  S('<rect x="10" y="10" width="30" height="30" fill="orange" transform="skewX(20) rotate(10)"/>'),
)
add(
  'g_pattern',
  S(
    '<pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="black"/><circle cx="7.5" cy="7.5" r="2" fill="red"/></pattern><rect width="60" height="60" fill="url(#p)"/>',
  ),
)
add(
  'g_pattern_transform',
  S(
    '<pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(30) scale(1.5)"><rect width="5" height="5" fill="black"/></pattern><circle cx="30" cy="30" r="28" fill="url(#p)"/>',
  ),
)
add(
  'g_mask_lum',
  S(
    '<mask id="m"><rect width="60" height="60" fill="white"/><circle cx="30" cy="30" r="15" fill="#444"/></mask><rect width="60" height="60" fill="blue" mask="url(#m)"/>',
  ),
)
add(
  'g_mask_alpha_type',
  S(
    '<mask id="m" mask-type="alpha"><rect width="60" height="60" fill="black" fill-opacity="0.5"/></mask><rect width="60" height="60" fill="blue" mask="url(#m)"/>',
  ),
)
add(
  'g_blur',
  S(
    '<filter id="f"><feGaussianBlur stdDeviation="3"/></filter><rect x="15" y="15" width="30" height="30" fill="black" filter="url(#f)"/>',
  ),
)
add(
  'g_dropshadow',
  S(
    '<filter id="f"><feDropShadow dx="3" dy="3" stdDeviation="2" flood-color="red"/></filter><rect x="10" y="10" width="30" height="30" fill="blue" filter="url(#f)"/>',
  ),
)
add(
  'g_colormatrix',
  S(
    '<filter id="f"><feColorMatrix type="saturate" values="0.2"/></filter><rect width="60" height="60" fill="red" filter="url(#f)"/>',
  ),
)
add(
  'g_use',
  S(
    '<defs><circle id="c" cx="10" cy="10" r="8" fill="red"/></defs><use xlink:href="#c" x="20" y="20"/><use href="#c" x="35" y="0"/>',
  ),
)
add(
  'g_use_href_only',
  S('<defs><circle id="c" cx="10" cy="10" r="8" fill="red"/></defs><use href="#c" x="20" y="20"/>'),
)
add(
  'g_grad_href',
  S(
    '<linearGradient id="a"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><linearGradient id="b" href="#a" x1="0" x2="0" y2="1"/><rect width="60" height="60" fill="url(#b)"/>',
  ),
)
add(
  'g_symbol',
  S(
    '<symbol id="s" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="green"/></symbol><use xlink:href="#s" x="10" y="10" width="40" height="40"/>',
  ),
)
add(
  'g_marker',
  S(
    '<marker id="m" markerWidth="6" markerHeight="6" refX="3" refY="3"><circle cx="3" cy="3" r="3" fill="red"/></marker><polyline points="10,10 30,50 50,10" fill="none" stroke="black" marker-start="url(#m)" marker-mid="url(#m)" marker-end="url(#m)"/>',
  ),
)
add(
  'g_nested_svg',
  S(
    '<svg x="10" y="10" width="40" height="40" viewBox="0 0 10 10" preserveAspectRatio="xMidYMid slice"><rect width="10" height="10" fill="red"/><circle cx="5" cy="5" r="5" fill="blue"/></svg>',
  ),
)
add('g_root_viewbox_par', S('<rect width="10" height="20" fill="red"/>', 'width="60" height="60" viewBox="0 0 10 20"'))
add('g_root_overflow', S('<circle cx="0" cy="0" r="20" fill="red"/>', 'width="60" height="60" viewBox="-10 -10 40 40"'))
add(
  'g_switch',
  S(
    '<switch><rect width="60" height="30" fill="blue" systemLanguage="xx"/><rect y="30" width="60" height="30" fill="green"/></switch>',
  ),
)
add('g_a_link', S('<a href="#"><rect width="60" height="60" fill="blue"/></a>'))
add(
  'g_foreignobject',
  S(
    '<foreignObject width="60" height="60"><div xmlns="http://www.w3.org/1999/xhtml" style="width:60px;height:60px;background:blue"></div></foreignObject>',
  ),
)
add(
  'g_color_modern',
  S(
    '<rect width="30" height="60" fill="rgb(100% 0% 0% / 50%)"/><rect x="30" width="30" height="60" fill="hsl(120deg 100% 25%)"/>',
  ),
)
add(
  'g_color_rgba',
  S('<rect width="30" height="60" fill="rgba(255,0,0,0.5)"/><rect x="30" width="30" height="60" fill="transparent"/>'),
)
add(
  'g_color_named',
  S('<rect width="30" height="60" fill="rebeccapurple"/><rect x="30" width="30" height="60" fill="#0f08"/>'),
)
add('g_currentcolor', S('<g color="green"><rect width="60" height="60" fill="currentColor"/></g>'))
add(
  'g_paint_order',
  S('<rect x="10" y="10" width="40" height="40" fill="red" stroke="black" stroke-width="10" paint-order="stroke"/>'),
)
add(
  'g_vector_effect',
  S(
    '<rect x="5" y="5" width="10" height="10" fill="none" stroke="black" stroke-width="1" vector-effect="non-scaling-stroke" transform="scale(3)"/>',
  ),
)
add('g_shape_rendering', S('<circle cx="30" cy="30" r="20.5" fill="black" shape-rendering="crispEdges"/>'))
add(
  'g_mix_blend',
  S(
    '<rect width="40" height="40" fill="red"/><rect x="20" y="20" width="40" height="40" fill="blue" style="mix-blend-mode:multiply"/>',
  ),
)
add(
  'g_visibility',
  S(
    '<g visibility="hidden"><rect width="60" height="30" fill="red"/><rect y="30" width="60" height="30" fill="blue" visibility="visible"/></g>',
  ),
)
add(
  'g_display_none',
  S('<g display="none"><rect width="60" height="60" fill="red"/></g><rect width="10" height="10" fill="blue"/>'),
)
add('g_fill_rule', S('<path fill-rule="evenodd" d="M5 5H55V55H5Z M15 15H45V45H15Z" fill="black"/>'))
add('g_rect_rx', S('<rect x="5" y="5" width="50" height="50" rx="12" ry="6" fill="maroon"/>'))
add('g_poly', S('<polygon points="30,3 57,57 3,57" fill="gold" stroke="black"/>'))
add('g_text_anchor', S('<text x="30" y="30" font-family="Arial" font-size="14" text-anchor="middle">Mid</text>'))
add(
  'g_text_tspan',
  S('<text x="5" y="20" font-family="Arial" font-size="12">A<tspan dy="10" fill="red">B</tspan></text>'),
)
add('g_scaled_draw', S('<circle cx="10" cy="10" r="8" fill="blue"/>', 'width="20" height="20"'), 60, 60, [0, 0, 60, 60])
add('g_scaled_draw_down', S('<circle cx="30" cy="30" r="25" fill="blue"/>'), 60, 60, [0, 0, 23, 23])
add('g_offset_draw', S('<circle cx="10" cy="10" r="8" fill="blue"/>', 'width="20" height="20"'), 60, 60, [10.5, 10.25])
module.exports = C
