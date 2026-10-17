const S = (body, attrs = 'width="20" height="20"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`
const C = {}
const add = (k, svg, w = 20, h = 20) => {
  C[k] = { svg, w, h }
}
const U = '<use xlink:href="#r"/>'
add('ui_type', S('<style>rect{fill:blue}</style><defs><rect id="r" width="20" height="20"/></defs>' + U))
add('ui_class', S('<style>.c{fill:blue}</style><defs><rect id="r" class="c" width="20" height="20"/></defs>' + U))
add('ui_id', S('<style>#r{fill:blue}</style><defs><rect id="r" width="20" height="20"/></defs>' + U))
add(
  'ui_child_of_defs',
  S('<style>defs > rect{fill:blue}</style><defs><rect id="r" width="20" height="20"/></defs>' + U),
)
add('ui_desc_of_svg', S('<style>svg rect{fill:blue}</style><defs><rect id="r" width="20" height="20"/></defs>' + U))
add(
  'ui_first_child',
  S('<style>rect:first-child{fill:blue}</style><defs><circle r="1"/><rect id="r" width="20" height="20"/></defs>' + U),
)
add('ui_g_inner', S('<style>g > rect{fill:blue}</style><defs><g id="r"><rect width="20" height="20"/></g></defs>' + U))
add(
  'ui_g_outer_ancestor',
  S('<style>.o rect{fill:blue}</style><g class="o"><defs><g id="r"><rect width="20" height="20"/></g></defs></g>' + U),
)
add(
  'ui_use_class',
  S(
    '<style>.u rect{fill:red} .u{fill:blue}</style><defs><rect id="r" width="20" height="20"/></defs><use class="u" xlink:href="#r"/>',
  ),
)
add('ui_root', S('<style>:root rect{fill:blue}</style><defs><rect id="r" width="20" height="20"/></defs>' + U))
add('ui_style_attr', S('<defs><rect id="r" width="20" height="20" style="fill:blue"/></defs>' + U))
add(
  'ui_style_vs_use_attr',
  S('<defs><rect id="r" width="20" height="20"/></defs><use xlink:href="#r" style="fill:blue" fill="red"/>'),
)
add('link_href', S('<style>:link{fill:blue}</style><a href="#x"><rect width="20" height="20"/></a>'))
add('link_anylink', S('<style>:any-link{fill:blue}</style><a href="#x"><rect width="20" height="20"/></a>'))
add('nested_svg_root_sel', S('<style>svg svg rect{fill:blue}</style><svg><rect width="20" height="20"/></svg>'))
add('attr_ns_sel', S('<style>[*|href]{fill:blue}</style><a xlink:href="#x"><rect width="20" height="20"/></a>'))
module.exports = C
