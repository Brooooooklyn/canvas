// Part-focused corpus. All 40x40 unless noted.
const S = (body, attrs = 'width="40" height="40"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const RED20 =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>'
const VB =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20"><rect width="10" height="10" fill="red"/><rect y="10" width="10" height="10" fill="blue"/></svg>'
// a 2x2 PNG: red, green / blue, transparent
const PNG2 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAWSURBVAiZBcEBAQAAAIAQ/08XIgkFAz/SBftalC1IAAAAAElFTkSuQmCC'
const C = {}
const add = (k, svg, w = 40, h = 40, dst) => {
  C[k] = { svg, w, h, dst }
}
// ---- part 1: clipPath content model
add(
  'cp_rect',
  S(
    '<clipPath id="a"><rect width="20" height="40"/></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>',
  ),
)
add(
  'cp_g',
  S(
    '<clipPath id="a"><g><rect width="20" height="40"/></g></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>',
  ),
)
add(
  'cp_g_issue1150',
  S(
    '<defs><clipPath id="a"><g><rect width="20" height="40"/></g></clipPath></defs><g clip-path="url(#a)"><rect width="40" height="20" fill="red"/></g>',
  ),
)
add(
  'cp_use_rect',
  S(
    '<defs><rect id="r" width="20" height="40"/></defs><clipPath id="a"><use xlink:href="#r"/></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>',
  ),
)
add(
  'cp_use_g',
  S(
    '<defs><g id="r"><rect width="20" height="40"/></g></defs><clipPath id="a"><use xlink:href="#r"/></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>',
  ),
)
add(
  'cp_text',
  S(
    '<clipPath id="a"><text x="0" y="30" font-size="40">H</text></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>',
  ),
)
add(
  'cp_image',
  S(
    `<clipPath id="a"><image width="20" height="40" xlink:href="data:image/png;base64,${PNG2}"/></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>`,
  ),
)
add('cp_empty', S('<clipPath id="a"></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>'))
add('cp_missing', S('<rect clip-path="url(#nope)" width="40" height="40" fill="red"/>'))
add(
  'cp_display_none_child',
  S(
    '<clipPath id="a"><rect width="20" height="40" display="none"/><rect x="30" width="10" height="40"/></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>',
  ),
)
add(
  'cp_visibility_hidden_child',
  S(
    '<clipPath id="a"><rect width="20" height="40" visibility="hidden"/><rect x="30" width="10" height="40"/></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>',
  ),
)
add(
  'cp_child_clip',
  S(
    '<clipPath id="b"><rect width="10" height="40"/></clipPath><clipPath id="a"><rect width="20" height="40" clip-path="url(#b)"/></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>',
  ),
)
add(
  'cp_on_clippath',
  S(
    '<clipPath id="b"><rect y="0" width="40" height="10"/></clipPath><clipPath id="a" clip-path="url(#b)"><rect width="20" height="40"/></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>',
  ),
)
add(
  'cp_obb',
  S(
    '<clipPath id="a" clipPathUnits="objectBoundingBox"><rect width="0.5" height="1"/></clipPath><rect x="8" y="8" clip-path="url(#a)" width="24" height="24" fill="red"/>',
  ),
)
add(
  'cp_evenodd',
  S(
    '<clipPath id="a"><path clip-rule="evenodd" d="M0 0H40V40H0Z M10 10H30V30H10Z"/></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>',
  ),
)
add(
  'cp_transform',
  S(
    '<clipPath id="a" transform="translate(10 0)"><rect width="20" height="40"/></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>',
  ),
)
add(
  'cp_circle_g_mix',
  S(
    '<clipPath id="a"><circle cx="10" cy="10" r="8"/><g><rect x="20" y="20" width="20" height="20"/></g></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>',
  ),
)
add(
  'cp_switch',
  S(
    '<clipPath id="a"><switch><rect width="20" height="40"/></switch></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>',
  ),
)
add(
  'cp_a_elem',
  S(
    '<clipPath id="a"><a><rect width="20" height="40"/></a></clipPath><rect clip-path="url(#a)" width="40" height="40" fill="red"/>',
  ),
)
// ---- part 2: <style>
add('st_class', S('<style>.a{fill:blue}</style><rect class="a" width="40" height="40"/>'))
add('st_type', S('<style>rect{fill:blue}</style><rect width="40" height="40"/>'))
add('st_id', S('<style>#r{fill:blue}</style><rect id="r" width="40" height="40"/>'))
add('st_universal', S('<style>*{fill:blue}</style><rect width="40" height="40"/>'))
add(
  'st_descendant',
  S('<style>g rect{fill:blue}</style><g><rect width="20" height="40"/></g><rect x="20" width="20" height="40"/>'),
)
add(
  'st_child',
  S('<style>svg > rect{fill:blue}</style><g><rect width="20" height="40"/></g><rect x="20" width="20" height="40"/>'),
)
add(
  'st_attr',
  S('<style>[x="20"]{fill:blue}</style><rect width="20" height="40"/><rect x="20" width="20" height="40"/>'),
)
add(
  'st_first_child',
  S(
    '<style>rect:first-child{fill:blue}</style><g><rect width="20" height="40"/><rect x="20" width="20" height="40"/></g>',
  ),
)
add(
  'st_nth_child',
  S(
    '<style>rect:nth-child(2){fill:blue}</style><g><rect width="20" height="40"/><rect x="20" width="20" height="40"/></g>',
  ),
)
add(
  'st_not',
  S(
    '<style>rect:not(.x){fill:blue}</style><rect class="x" width="20" height="40"/><rect x="20" width="20" height="40"/>',
  ),
)
add(
  'st_group',
  S(
    '<style>.a, .b{fill:blue}</style><rect class="a" width="20" height="40"/><rect class="b" x="20" width="20" height="40"/>',
  ),
)
add(
  'st_multi_class',
  S(
    '<style>.a.b{fill:blue}</style><rect class="a b" width="20" height="40"/><rect class="a" x="20" width="20" height="40"/>',
  ),
)
add(
  'st_spec_id_vs_class',
  S('<style>#r{fill:blue} .a{fill:red}</style><rect id="r" class="a" width="40" height="40"/>'),
)
add('st_order', S('<style>.a{fill:red} .a{fill:blue}</style><rect class="a" width="40" height="40"/>'))
add(
  'st_important',
  S(
    '<style>.a{fill:blue!important} #r{fill:red}</style><rect id="r" class="a" width="40" height="40" style="fill:green"/>',
  ),
)
add('st_vs_attr', S('<style>.a{fill:blue}</style><rect class="a" fill="red" width="40" height="40"/>'))
add('st_vs_style_attr', S('<style>.a{fill:red}</style><rect class="a" style="fill:blue" width="40" height="40"/>'))
add('style_attr_vs_pres_attr', S('<rect style="fill:blue" fill="red" width="40" height="40"/>'))
add('pres_attr_vs_style_attr_order', S('<rect fill="red" style="fill:blue" width="40" height="40"/>'))
add('st_in_defs', S('<defs><style>.a{fill:blue}</style></defs><rect class="a" width="40" height="40"/>'))
add('st_after', S('<rect class="a" width="40" height="40"/><style>.a{fill:blue}</style>'))
add('st_cdata', S('<style><![CDATA[ .a{fill:blue} ]]></style><rect class="a" width="40" height="40"/>'))
add('st_comment', S('<style>/* c */ .a{fill:blue} /* d */</style><rect class="a" width="40" height="40"/>'))
add(
  'st_two_sheets',
  S('<style>.a{fill:red}</style><style>.a{fill:blue}</style><rect class="a" width="40" height="40"/>'),
)
add('st_media', S('<style>@media screen { .a{fill:blue} }</style><rect class="a" width="40" height="40"/>'))
add(
  'st_media_print',
  S('<style>.a{fill:blue} @media print { .a{fill:red} }</style><rect class="a" width="40" height="40"/>'),
)
add(
  'st_type_other',
  S('<style type="text/foo">.a{fill:red}</style><rect class="a" fill="blue" width="40" height="40"/>'),
)
add('st_inherit_g', S('<style>.g{fill:blue}</style><g class="g"><rect width="40" height="40"/></g>'))
add(
  'st_stroke',
  S('<style>.a{fill:none;stroke:blue;stroke-width:10px}</style><rect class="a" x="5" y="5" width="30" height="30"/>'),
)
add(
  'st_display_none',
  S(
    '<style>.h{display:none}</style><rect width="40" height="40" fill="blue"/><rect class="h" width="40" height="40" fill="red"/>',
  ),
)
add('st_opacity', S('<style>.a{opacity:0.5}</style><rect class="a" width="40" height="40" fill="blue"/>'))
add(
  'st_stop_color',
  S(
    '<style>.s{stop-color:blue}</style><linearGradient id="g"><stop class="s" offset="0"/><stop class="s" offset="1"/></linearGradient><rect fill="url(#g)" width="40" height="40"/>',
  ),
)
add(
  'st_transform',
  S('<style>.a{transform:translate(20px,0)}</style><rect class="a" width="20" height="40" fill="blue"/>'),
)
add('st_geometry', S('<style>.a{width:20px;height:40px;x:20px}</style><rect class="a" fill="blue"/>'))
add(
  'st_issue749',
  `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 26" width="56" height="52"><defs><style>.cls-1 {fill: #fc6d26;} .cls-1, .cls-2, .cls-3 {stroke-width: 0px;} .cls-2 {fill: #e24329;} .cls-3 {fill: #fca326;}</style></defs><g><path class="cls-2" d="m14,26l5.16-15.99h-10.31l5.16,15.99Z"/><path class="cls-1" d="m14,26l-5.16-15.99H1.62l12.38,15.99Z"/><path class="cls-3" d="m1.62,10L.05,14.86c-.07.22-.07.45,0,.66.07.22.21.4.39.54l13.56,9.93L1.62,10Z"/><path class="cls-2" d="m1.62,10h7.23L5.74.37c-.04-.11-.1-.2-.19-.27-.09-.07-.2-.1-.31-.1s-.22.04-.31.1c-.09.07-.16.16-.19.27L1.62,10Z"/><path class="cls-1" d="m14,26l5.16-15.99h7.23l-12.38,15.99Z"/><path class="cls-3" d="m26.38,10l1.57,4.86c.07.22.07.45,0,.66-.07.22-.21.4-.39.54l-13.56,9.93,12.38-16Z"/><path class="cls-2" d="m26.38,10h-7.23L22.26.37c.03-.11.1-.2.19-.27.09-.07.2-.1.31-.1s.22.04.31.1c.09.07.16.16.19.27l3.11,9.63Z"/></g></svg>`,
  56,
  52,
)
// ---- part 3: url() forms
const G =
  '<linearGradient id="g"><stop offset="0" stop-color="blue"/><stop offset="1" stop-color="blue"/></linearGradient>'
add('url_plain', S(G + '<rect fill="url(#g)" width="40" height="40"/>'))
add('url_quot', S(G + '<rect fill="url(&quot;#g&quot;)" width="40" height="40"/>'))
add('url_squote', S(G + `<rect fill="url('#g')" width="40" height="40"/>`))
add('url_dquote_in_squote_attr', S(G + `<rect fill='url("#g")' width="40" height="40"/>`))
add('url_spaces', S(G + '<rect fill="url( #g )" width="40" height="40"/>'))
add('url_style_quot', S(G + '<rect style="fill: url(&quot;#g&quot;);" width="40" height="40"/>'))
add(
  'url_clip_quot',
  S(
    '<clipPath id="c"><rect width="20" height="40"/></clipPath><rect clip-path="url(&quot;#c&quot;)" width="40" height="40" fill="blue"/>',
  ),
)
add(
  'url_mask_quot',
  S(
    '<mask id="m"><rect width="20" height="40" fill="white"/></mask><rect mask="url(&quot;#m&quot;)" width="40" height="40" fill="blue"/>',
  ),
)
add(
  'url_filter_quot',
  S(
    '<filter id="f"><feFlood flood-color="blue"/></filter><rect filter="url(&quot;#f&quot;)" x="10" y="10" width="20" height="20" fill="red"/>',
  ),
)
add('url_fallback', S('<rect fill="url(#nope) blue" width="40" height="40"/>'))
add('url_missing', S('<rect fill="url(#nope)" width="40" height="40"/>'))
add(
  'url_issue1029',
  `<?xml version="1.0" encoding="utf-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs><radialGradient gradientUnits="userSpaceOnUse" cx="50" cy="50" r="25" id="gradient-0"><stop offset="0" style="stop-color: rgb(84.706% 84.706% 84.706%)"/><stop offset="1" style="stop-color: rgb(48.42% 48.42% 48.42%)"/></radialGradient></defs><rect x="25" y="25" width="50" height="50" style="stroke: rgb(0, 0, 0); fill: url(&quot;#gradient-0&quot;);"/></svg>`,
  100,
  100,
)
// ---- part 4: var()
add('var_basic', S('<rect style="fill: var(--c)" width="40" height="40"/>', 'width="40" height="40" style="--c: blue"'))
add('var_fallback', S('<rect style="fill: var(--nope, blue)" width="40" height="40"/>'))
add('var_inherit_g', S('<g style="--c: blue"><rect style="fill: var(--c)" width="40" height="40"/></g>'))
add('var_in_sheet', S('<style>:root{--c: blue} .a{fill: var(--c)}</style><rect class="a" width="40" height="40"/>'))
add('var_sheet_svg_sel', S('<style>svg{--c: blue} rect{fill: var(--c)}</style><rect width="40" height="40"/>'))
add('var_nested', S('<rect style="--a: blue; --b: var(--a); fill: var(--b)" width="40" height="40"/>'))
add('var_pres_attr', S('<rect fill="var(--c)" width="40" height="40"/>', 'width="40" height="40" style="--c: blue"'))
add('var_invalid', S('<g fill="green"><rect style="fill: var(--nope)" width="40" height="40"/></g>'))
add(
  'var_stroke_width',
  S('<rect style="--w: 10px; fill:none; stroke: blue; stroke-width: var(--w)" x="5" y="5" width="30" height="30"/>'),
)
add('var_cycle', S('<rect style="--a: var(--b); --b: var(--a); fill: var(--a, blue)" width="40" height="40"/>'))
// ---- part 5: nested images
add('img_svg_b64_href', S(`<image width="20" height="20" href="data:image/svg+xml;base64,${b64(RED20)}"/>`))
add('img_svg_b64_xlink', S(`<image width="20" height="20" xlink:href="data:image/svg+xml;base64,${b64(RED20)}"/>`))
add(
  'img_svg_utf8',
  S(`<image width="20" height="20" xlink:href="data:image/svg+xml;utf8,${encodeURIComponent(RED20)}"/>`),
)
add(
  'img_svg_plain_pct',
  S(`<image width="20" height="20" xlink:href="data:image/svg+xml,${encodeURIComponent(RED20)}"/>`),
)
add(
  'img_svg_scaled',
  S(
    `<image width="40" height="40" xlink:href="data:image/svg+xml;base64,${b64('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="9" fill="blue"/></svg>')}"/>`,
  ),
)
add('img_svg_vb_par_default', S(`<image width="40" height="40" xlink:href="data:image/svg+xml;base64,${b64(VB)}"/>`))
add(
  'img_svg_vb_par_none',
  S(`<image width="40" height="40" preserveAspectRatio="none" xlink:href="data:image/svg+xml;base64,${b64(VB)}"/>`),
)
add(
  'img_svg_nosize_in_image',
  S(
    `<image width="40" height="40" xlink:href="data:image/svg+xml;base64,${b64('<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="red"/></svg>')}"/>`,
  ),
)
add('img_png_href', S(`<image width="20" height="20" href="data:image/png;base64,${PNG2}"/>`))
add('img_png_xlink', S(`<image width="20" height="20" xlink:href="data:image/png;base64,${PNG2}"/>`))
add('img_png_auto_size', S(`<image xlink:href="data:image/png;base64,${PNG2}"/>`))
add('img_svg_auto_size', S(`<image xlink:href="data:image/svg+xml;base64,${b64(RED20)}"/>`))
add(
  'img_http',
  S('<rect width="40" height="40" fill="blue"/><image width="20" height="20" xlink:href="https://example.com/a.png"/>'),
)
add('img_file', S('<rect width="40" height="40" fill="blue"/><image width="20" height="20" xlink:href="a.png"/>'))
add(
  'img_png_pixelated',
  S(`<image width="40" height="40" style="image-rendering:pixelated" xlink:href="data:image/png;base64,${PNG2}"/>`),
)
add('img_png_smooth', S(`<image width="40" height="40" xlink:href="data:image/png;base64,${PNG2}"/>`))
add(
  'img_issue859_tri',
  S(
    `<image x="0" y="0" width="40" height="35" href="data:image/svg+xml;utf8,%3Csvg  fill=%22%23000%22 xmlns=%22http://www.w3.org/2000/svg%22 width=%22NaN%22 height=%22null%22 viewBox=%220 0 75 65%22%3E%3Cpath d=%22M37.59.25l36.95 64H.64l36.95-64z%22%3E%3C/path%3E%3C/svg%3E" preserveAspectRatio="none"/>`,
  ),
)
add(
  'feimage_svg',
  S(
    `<filter id="f" x="0" y="0" width="1" height="1"><feImage xlink:href="data:image/svg+xml;base64,${b64(RED20)}"/></filter><rect filter="url(#f)" width="40" height="40" fill="blue"/>`,
  ),
)
// ---- part 6: text
add('text_hi', S('<text x="0" y="20" font-size="20" fill="black">Hi</text>', 'width="60" height="30"'), 60, 30)
add(
  'text_serif',
  S('<text x="0" y="20" font-size="20" font-family="serif">Hi</text>', 'width="60" height="30"'),
  60,
  30,
)
add(
  'text_sans',
  S('<text x="0" y="20" font-size="20" font-family="sans-serif">Hi</text>', 'width="60" height="30"'),
  60,
  30,
)
add(
  'text_arial',
  S('<text x="0" y="20" font-size="20" font-family="Arial">Hi</text>', 'width="60" height="30"'),
  60,
  30,
)
add('text_rect_stem', S('<text x="0" y="30" font-size="40" font-family="Arial">I</text>', 'width="40" height="40"'))
module.exports = C
