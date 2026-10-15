const S = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="48" height="48">${body}</svg>`
const N = (rootAttrs, vb) =>
  'data:image/svg+xml;base64,' +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" ${rootAttrs}><rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="blue"/></svg>`,
  ).toString('base64')
const C = {}
const add = (k, a, root = 'viewBox="0 0 30 20" preserveAspectRatio="none"', vb = [0, 0, 30, 20]) => {
  C[k] = { svg: S(`<image ${a} href="${N(root, vb)}"/>`), w: 48, h: 48 }
}
add('pos_int_size_frac', 'x="2" y="1" width="30.7" height="20.2"')
add('pos_frac_size_int', 'x="2.3" y="1.6" width="30" height="20"')
add('pos_frac_size_int_big', 'x="2.3" y="1.6" width="40" height="40"')
add('pos_0_size_frac_y', 'width="30" height="20.2"')
add('pos_0_size_frac_y2', 'width="30" height="20.5"')
add('pos_0_size_frac_y3', 'width="30" height="20.8"')
add('pos_0_size_frac_x', 'width="30.4" height="20"')
add('pos_frac_y_only', 'y="1.6" width="30" height="20"')
add('pos_frac_y_only2', 'y="1.25" width="30" height="20"')
module.exports = C
