// Broken / blocked <image> loads inside an SVG image.
const S = (body, w = 40, h = 40) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}">${body}</svg>`
const I = (href, a = 'width="20" height="20"') => `<image ${a} xlink:href="${href}"/>`
const C = {}
const add = (k, svg, w = 40, h = 40) => {
  C[k] = { svg, w, h }
}
add('b_https', S(I('https://example.com/a.png')))
add('b_http', S(I('http://127.0.0.1:1/a.png')))
add('b_file', S(I('file:///tmp/a.png')))
add('b_about', S(I('about:blank')))
add('b_rel', S(I('a.png')))
add('b_abs_path', S(I('/a.png')))
add('b_proto_rel', S(I('//example.com/a.png')))
add('b_empty', S(I('')))
add('b_space', S(I(' ')))
add('b_frag', S('<rect id="r" width="5" height="5"/>' + I('#r')))
add('b_data_empty', S(I('data:,')))
add('b_data_text', S(I('data:text/plain,hello')))
add('b_data_badpng', S(I('data:image/png;base64,AAAA')))
add('b_data_badsvg', S(I('data:image/svg+xml,%3Csvg')))
add('b_data_notsvg_xml', S(I('data:image/svg+xml,%3Cfoo/%3E')))
add('b_blob', S(I('blob:null/abc')))
add('b_1to1', S(I('https://example.com/a.png', 'width="14" height="16"'), 14, 16))
add('b_2x', S(I('https://example.com/a.png', 'width="28" height="32"'), 28, 32))
add('b_none', S(I('https://example.com/a.png', 'width="40" height="20" preserveAspectRatio="none"'), 40, 20))
add('b_slice', S(I('https://example.com/a.png', 'width="40" height="20" preserveAspectRatio="xMinYMin slice"'), 40, 20))
add('b_nosize', S(I('https://example.com/a.png', '')))
add(
  'b_pixelated',
  S(I('https://example.com/a.png', 'width="28" height="32" style="image-rendering:pixelated"'), 28, 32),
)
add('b_opacity', S(I('https://example.com/a.png', 'width="14" height="16" opacity="0.5"'), 14, 16))
add('b_frac', S(I('https://example.com/a.png', 'x="0.5" y="0.3" width="14" height="16"'), 16, 18))
module.exports = C
