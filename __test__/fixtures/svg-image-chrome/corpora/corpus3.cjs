// Cascade / var / url / use semantics. 20x20 unless noted; probe pixel at (10,10) mostly.
const S = (body, attrs = 'width="20" height="20"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`
const R = (a = '') => `<rect width="20" height="20" ${a}/>`
const C = {}
const add = (k, svg, w = 20, h = 20) => {
  C[k] = { svg, w, h }
}
// importance / origin
add('imp_styleattr_vs_sheet', S('<style>rect{fill:blue!important}</style>' + R('style="fill:red!important"')))
add('imp_sheet_vs_styleattr_normal', S('<style>rect{fill:blue!important}</style>' + R('style="fill:red"')))
add('pres_attr_important_ignored', S('<style>rect{fill:blue}</style>' + R('fill="red !important"')))
add('pres_attr_ws', S(R('fill=" blue "')))
add('pres_attr_semicolon', S('<g fill="blue">' + R('fill="red;"') + '</g>'))
add('pres_attr_invalid_inherits', S('<g fill="blue">' + R('fill="bogus"') + '</g>'))
add('sheet_invalid_falls_to_attr', S('<style>rect{fill:bogus}</style>' + R('fill="blue"')))
add('sheet_later_invalid_keeps_earlier', S('<style>rect{fill:blue} rect{fill:bogus}</style>' + R()))
add('layer_unlayered_wins', S('<style>@layer a{rect{fill:red}} rect{fill:blue}</style>' + R()))
add('layer_order', S('<style>@layer a,b; @layer b{rect{fill:blue}} @layer a{rect{fill:red}}</style>' + R()))
add(
  'layer_important_reverse',
  S('<style>@layer a,b; @layer a{rect{fill:blue!important}} @layer b{rect{fill:red!important}}</style>' + R()),
)
add('supports_true', S('<style>@supports (fill: blue){rect{fill:blue}}</style>' + R()))
add('supports_false', S('<style>rect{fill:blue} @supports (bogus: x){rect{fill:red}}</style>' + R()))
add('media_width_true', S('<style>@media (min-width: 10px){rect{fill:blue}}</style>' + R()))
add('media_width_false', S('<style>rect{fill:blue} @media (min-width: 30px){rect{fill:red}}</style>' + R()))
add(
  'media_width_vb',
  S(
    '<style>rect{fill:blue} @media (min-width: 30px){rect{fill:red}}</style>' + R(),
    'width="20" height="20" viewBox="0 0 100 100"',
  ),
)
add('media_dark', S('<style>rect{fill:blue} @media (prefers-color-scheme: dark){rect{fill:red}}</style>' + R()))
add('media_attr_print', S('<style media="print">rect{fill:red}</style>' + R('fill="blue"')))
add('media_attr_screen', S('<style media="screen">rect{fill:blue}</style>' + R('fill="red"')))
add('import_ignored', S('<style>@import url(x.css); rect{fill:blue}</style>' + R()))
add('ns_prefix_style', S('<style>svg|rect{fill:blue} @namespace svg url(http://www.w3.org/2000/svg);</style>' + R()))
add('case_type_sel', S('<style>RECT{fill:red} rect{fill:blue}</style>' + R()))
add('case_class', S('<style>.A{fill:red} .a{fill:blue}</style>' + R('class="a"')))
add('attr_sel_i', S('<style>[data-x="AB" i]{fill:blue}</style>' + R('data-x="ab"')))
add('sel_is_where', S('<style>:where(#r){fill:red} :is(rect){fill:blue}</style>' + R('id="r"')))
add('sel_sibling', S('<style>circle + rect{fill:blue} circle ~ rect{stroke:red}</style><circle r="1"/>' + R()))
add('sel_root', S('<style>:root{fill:blue}</style>' + R()))
add('sel_has', S('<style>g:has(rect){fill:blue}</style><g>' + R() + '</g>'))
add('sel_empty_lastchild', S('<style>rect:last-child:empty{fill:blue}</style>' + R()))
add('sel_hover_never', S('<style>rect{fill:blue} rect:hover{fill:red}</style>' + R()))
add('sel_link', S('<style>:link{fill:blue}</style><a xlink:href="#x">' + R() + '</a>'))
add('sel_link_child', S('<style>a:link rect{fill:blue}</style><a xlink:href="#x">' + R() + '</a>'))
// keywords
add('kw_inherit', S('<g fill="blue"><g fill="red">' + R('style="fill:inherit"') + '</g></g>'))
add('kw_initial', S('<g fill="red">' + R('style="fill:initial"') + '</g>'))
add('kw_unset_inherited', S('<g fill="blue">' + R('fill="red" style="fill:unset"') + '</g>'))
add('kw_revert', S('<g fill="blue">' + R('fill="red" style="fill:revert"') + '</g>'))
add('kw_inherit_noninherited', S('<g opacity="0.5">' + R('fill="blue" style="opacity:inherit"') + '</g>'))
// var()
add('var_fallback_comma', S(R('style="stroke-width:4px;stroke:var(--x, rgb(0, 0, 255));fill:none"')))
add(
  'var_in_transform',
  S('<rect width="10" height="20" fill="blue" style="--t: translate(10px, 0); transform: var(--t)"/>'),
)
add('var_in_font', S('<text style="--s: 18px; font: var(--s) serif" y="16">I</text>'))
add(
  'var_pres_attr_geometry',
  S('<rect x="var(--x)" width="10" height="20" fill="blue"/>', 'width="20" height="20" style="--x: 10px"'),
)
add(
  'var_use_instance',
  S(
    '<defs><rect id="r" width="20" height="20" style="fill: var(--c, red)"/></defs><use xlink:href="#r" style="--c: blue"/>',
  ),
)
add(
  'var_currentcolor',
  S('<g style="--c: currentColor; color: red"><rect width="20" height="20" style="color: blue; fill: var(--c)"/></g>'),
)
add('var_empty', S('<g fill="blue"><rect width="20" height="20" style="--e: ; fill: var(--e) green"/></g>'))
add('var_initial_kw', S('<g fill="blue"><rect width="20" height="20" style="--i: initial; fill: var(--i, red)"/></g>'))
add('var_in_sheet_class', S('<style>.a{--c: blue} rect{fill: var(--c)}</style><g class="a">' + R() + '</g>'))
add(
  'var_in_stop',
  S(
    '<linearGradient id="g" style="--s: blue"><stop offset="0" style="stop-color: var(--s)"/><stop offset="1" stop-color="var(--s)"/></linearGradient><rect width="20" height="20" fill="url(#g)"/>',
  ),
)
add(
  'var_into_custom_from_root',
  S(
    '<style>svg{--a: 10px} rect{stroke-width: var(--a); stroke: blue; fill: none}</style><rect x="5" y="5" width="10" height="10"/>',
  ),
)
// use / inheritance
add('use_inherits_from_use', S('<defs><rect id="r" width="20" height="20"/></defs><use xlink:href="#r" fill="blue"/>'))
add(
  'use_sheet_matches_original',
  S(
    '<style>defs rect{fill:blue} use rect{fill:red}</style><defs><rect id="r" width="20" height="20"/></defs><use xlink:href="#r"/>',
  ),
)
add('use_cycle', S('<g id="a"><use xlink:href="#a"/></g><rect width="10" height="10" fill="blue"/>'))
add(
  'use_href_precedence',
  S(
    '<defs><rect id="a" width="20" height="20" fill="blue"/><rect id="b" width="20" height="20" fill="red"/></defs><use href="#a" xlink:href="#b"/>',
  ),
)
add(
  'use_other_prefix',
  S(
    '<defs><rect id="a" width="20" height="20" fill="blue"/></defs><use xmlns:x="http://www.w3.org/1999/xlink" x:href="#a"/>',
  ),
)
add(
  'use_svg_target',
  S(
    '<defs><svg id="s" viewBox="0 0 10 10" width="5" height="5"><rect width="10" height="10" fill="blue"/></svg></defs><use xlink:href="#s" width="20" height="20"/>',
  ),
)
add('use_external', S('<rect width="20" height="20" fill="blue"/><use xlink:href="other.svg#a"/>'))
add(
  'use_display_none_target',
  S(
    '<defs><rect id="a" width="20" height="20" fill="red" display="none"/></defs><rect width="20" height="20" fill="blue"/><use xlink:href="#a"/>',
  ),
)
add(
  'use_target_in_clippath',
  S('<clipPath id="c"><rect id="a" width="20" height="20" fill="blue"/></clipPath><use xlink:href="#a"/>'),
)
// url
add('url_ref_wrong_type', S('<rect id="x" width="1" height="1"/><rect width="20" height="20" fill="url(#x) blue"/>'))
add(
  'url_ref_wrong_type_nofb',
  S('<rect id="x" width="1" height="1"/><g fill="red"><rect width="20" height="20" fill="url(#x)"/></g>'),
)
add(
  'url_escape',
  S(
    '<linearGradient id="a b"><stop stop-color="blue"/></linearGradient><rect width="20" height="20" fill="url(#a\\ b)"/>',
  ),
)
add(
  'url_quoted_escape',
  S(
    '<linearGradient id="a)b"><stop stop-color="blue"/></linearGradient><rect width="20" height="20" fill="url(&quot;#a)b&quot;)"/>',
  ),
)
add('url_filter_missing', S('<rect width="20" height="20" fill="blue" filter="url(#nope)"/>'))
add('url_mask_missing', S('<rect width="20" height="20" fill="blue" mask="url(#nope)"/>'))
add('url_marker_missing', S('<path d="M2 10H18" stroke="blue" stroke-width="20" marker-end="url(#nope)"/>'))
add(
  'url_absolute_same_doc',
  S(
    '<linearGradient id="g"><stop stop-color="blue"/></linearGradient><rect width="20" height="20" fill="url(about:blank#g)"/>',
  ),
)
add(
  'url_stroke_missing_fallback_none',
  S('<rect x="5" y="5" width="10" height="10" fill="blue" stroke="url(#nope)" stroke-width="10"/>'),
)
// css-only / mixed
add('css_d_prop', S('<style>path{d: path("M0 0H20V20H0Z")}</style><path fill="blue" d="M0 0H1V1Z"/>'))
add('css_r_prop', S('<style>circle{r: 10px}</style><circle cx="10" cy="10" r="1" fill="blue"/>'))
add('css_rx_auto', S('<style>rect{rx: auto}</style><rect width="20" height="20" ry="10" fill="blue"/>'))
add('css_x_attr_units', S('<rect x="0.5em" width="20" height="20" fill="blue" font-size="20"/>'))
add(
  'css_stroke_width_em',
  S(
    '<rect x="10" y="10" width="0" height="0" fill="none" stroke="blue" style="font-size:10px;stroke-width:2em;stroke-linecap:square" />',
  ),
)
add('css_stroke_width_pct', S('<line x1="0" y1="10" x2="20" y2="10" stroke="blue" stroke-width="50%"/>'))
add('css_font_shorthand', S('<style>text{font: bold 18px serif}</style><text y="16">I</text>'))
add('css_opacity_pct', S(R('fill="blue" opacity="50%"')))
add('css_fill_opacity_pct', S(R('fill="blue" fill-opacity="30%"')))
add(
  'css_calc',
  S(
    '<style>rect{stroke-width: calc(2px + 3px); stroke: blue; fill: none}</style><rect x="5" y="5" width="10" height="10"/>',
  ),
)
add(
  'css_color_currentcolor_inherit',
  S('<g color="blue" fill="currentColor"><rect width="20" height="20" color="red"/></g>'),
)
add(
  'css_transform_attr_vs_css',
  S(
    '<style>rect{transform: translateX(10px)}</style><rect width="10" height="20" fill="blue" transform="translate(5 0)"/>',
  ),
)
add('css_transform_3d', S('<rect width="10" height="20" fill="blue" style="transform: translate3d(10px, 0, 0)"/>'))
add(
  'css_transform_origin_px',
  S('<rect width="10" height="10" fill="blue" style="transform: scale(2); transform-origin: 10px 10px"/>'),
)
add(
  'css_transform_rotate_turn',
  S(
    '<rect width="10" height="10" x="10" fill="blue" style="transform: rotate(0.25turn); transform-origin: 10px 10px"/>',
  ),
)
add(
  'css_display_none_root_child',
  S(
    '<style>g{display:none}</style><rect width="20" height="20" fill="blue"/><g><rect width="20" height="20" fill="red"/></g>',
  ),
)
add('css_visibility_collapse', S(R('fill="red" visibility="collapse"')))
add(
  'css_fill_rule_attr_vs_style',
  S('<path style="fill-rule:evenodd" fill-rule="nonzero" fill="blue" d="M0 0H20V20H0Z M5 5H15V15H5Z"/>'),
)
add(
  'stop_style_offset',
  S(
    '<linearGradient id="g"><stop offset="50%" stop-color="blue"/><stop offset="50%" stop-color="red"/></linearGradient><rect width="20" height="20" fill="url(#g)"/>',
  ),
)
module.exports = C
