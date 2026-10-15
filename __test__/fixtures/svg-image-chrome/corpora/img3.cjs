// Nested SVG <image> sizing: container size, root pAR vs image pAR.
const S = (body, w = 40, h = 20) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}">${body}</svg>`
const N = (rootAttrs, body = '<rect width="10" height="10" fill="blue"/><rect width="5" height="5" fill="red"/>') =>
  'data:image/svg+xml;base64,' +
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${rootAttrs}>${body}</svg>`).toString('base64')
const I = (href, a = 'width="40" height="20"') => `<image ${a} href="${href}"/>`
const C = {}
const add = (k, svg, w = 40, h = 20) => {
  C[k] = { svg, w, h }
}
add('n_vb_meet', S(I(N('viewBox="0 0 10 10"'))))
add('n_vb_imgnone', S(I(N('viewBox="0 0 10 10"'), 'width="40" height="20" preserveAspectRatio="none"')))
add('n_vb_rootnone', S(I(N('viewBox="0 0 10 10" preserveAspectRatio="none"'))))
add(
  'n_vb_rootnone_imgnone',
  S(I(N('viewBox="0 0 10 10" preserveAspectRatio="none"'), 'width="40" height="20" preserveAspectRatio="none"')),
)
add('n_wh_vb', S(I(N('width="10" height="10" viewBox="0 0 10 10"'))))
add(
  'n_wh_vb_imgnone',
  S(I(N('width="10" height="10" viewBox="0 0 10 10"'), 'width="40" height="20" preserveAspectRatio="none"')),
)
add('n_wh_novb', S(I(N('width="10" height="10"'))))
add('n_wh_novb_imgnone', S(I(N('width="10" height="10"'), 'width="40" height="20" preserveAspectRatio="none"')))
add('n_vb_imgslice', S(I(N('viewBox="0 0 10 10"'), 'width="40" height="20" preserveAspectRatio="xMinYMin slice"')))
add('n_vb_rootslice', S(I(N('viewBox="0 0 10 10" preserveAspectRatio="xMinYMin slice"'))))
add('n_vb_rootxmax', S(I(N('viewBox="0 0 10 10" preserveAspectRatio="xMaxYMax meet"'))))
add('n_vb_imgxmax', S(I(N('viewBox="0 0 10 10"'), 'width="40" height="20" preserveAspectRatio="xMaxYMax meet"')))
add(
  'n_wh20x10_novb_imgxmax',
  S(I(N('width="20" height="10"'), 'width="40" height="20" preserveAspectRatio="xMaxYMax meet"')),
)
add('n_wh_vb_autosize', S(I(N('width="10" height="10" viewBox="0 0 10 10"'), '')))
add('n_vb_autosize', S(I(N('viewBox="0 0 10 10"'), '')), 40, 40)
add('n_novb_autosize', S(I(N(''), '')), 40, 40)
add('n_w_only_autosize', S(I(N('width="10" viewBox="0 0 10 5"'), '')))
add('n_overflow', S(I(N('viewBox="0 0 10 10"', '<rect x="-10" y="-10" width="30" height="30" fill="blue"/>'))))
add('n_frac_box', S(I(N('viewBox="0 0 10 10"'), 'x="0.5" y="0.25" width="20.5" height="15.3"')))
add(
  'n_vb_imgnone_fracnat',
  S(I(N('width="10.6" height="7.3" viewBox="0 0 10 10"'), 'width="40" height="20" preserveAspectRatio="none"')),
)
add(
  'n_pct_wh',
  S(I(N('width="50%" height="50%" viewBox="0 0 10 10"'), 'width="40" height="20" preserveAspectRatio="none"')),
)
module.exports = C
