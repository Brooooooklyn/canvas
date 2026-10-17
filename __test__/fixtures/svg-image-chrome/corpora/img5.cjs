// Fractional container mapping for nested SVG <image>.
const S = (body, w = 48, h = 48) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}">${body}</svg>`
const N = (rootAttrs, vb) =>
  'data:image/svg+xml;base64,' +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" ${rootAttrs}><rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="blue"/></svg>`,
  ).toString('base64')
const C = {}
const add = (k, svg) => {
  C[k] = { svg, w: 48, h: 48 }
}
// A: natural 10.6x7.3, pAR none: container = natural
add(
  'A_nat_frac_none',
  S(
    `<image width="40" height="20" preserveAspectRatio="none" href="${N('width="10.6" height="7.3" viewBox="0 0 10.6 7.3"', [0, 0, 10.6, 7.3])}"/>`,
  ),
)
// B: ratio only, pAR none, box 40x35
add(
  'B_ratio_none',
  S(`<image width="40" height="35" preserveAspectRatio="none" href="${N('viewBox="0 0 75 65"', [0, 0, 75, 65])}"/>`),
)
// C: pAR default, fractional box: container = box
add('C_box_frac', S(`<image width="40.4" height="35.3" href="${N('viewBox="0 0 40.4 35.3"', [0, 0, 40.4, 35.3])}"/>`))
add(
  'C2_box_frac_vbint',
  S(
    `<image width="40.4" height="35.3" href="${N('viewBox="0 0 40 35" preserveAspectRatio="none"', [0, 0, 40, 35])}"/>`,
  ),
)
add(
  'D_box_frac_xy',
  S(
    `<image x="2.3" y="1.6" width="30.7" height="20.2" href="${N('viewBox="0 0 30 20" preserveAspectRatio="none"', [0, 0, 30, 20])}"/>`,
  ),
)
add(
  'E_nat_frac_none_big',
  S(
    `<image width="44" height="44" preserveAspectRatio="none" href="${N('width="5.3" height="5.7" viewBox="0 0 5.3 5.7"', [0, 0, 5.3, 5.7])}"/>`,
  ),
)
add(
  'F_nat_int_none',
  S(
    `<image width="44" height="44" preserveAspectRatio="none" href="${N('width="5" height="6" viewBox="0 0 5 6"', [0, 0, 5, 6])}"/>`,
  ),
)
add(
  'G_nat_frac_novb',
  S(
    `<image width="44" height="44" preserveAspectRatio="none" href="${N('width="5.3" height="5.7"', [0, 0, 5.3, 5.7])}"/>`,
  ),
)
module.exports = C
