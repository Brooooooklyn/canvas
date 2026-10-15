// SVG images that reference themselves, nest deep or blow up. Each case:
// { svg, w, h }: drawImage(img, 0, 0) on a w x h canvas.
const X = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
const S = (body, w = 40, h = 40) => `<svg ${X} width="${w}" height="${h}">${body}</svg>`
const c = (svg, w = 40, h = 40) => ({ svg, w, h })

// A data: URL of an SVG document, percent-encoding only what must be.
const url = (svg) =>
  'data:image/svg+xml,' +
  svg.replace(/%/g, '%25').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/"/g, '%22').replace(/#/g, '%23')

// `depth` SVG images, each the only <image> of the next; the innermost
// draws a blue 4x4 rect.
const chain = (depth) => {
  let inner = `<svg ${X} width="4" height="4"><rect width="4" height="4" fill="#00f"/></svg>`
  for (let d = 0; d < depth; d++)
    inner = `<svg ${X} width="4" height="4"><image width="4" height="4" href="${url(inner)}"/></svg>`
  return inner.replace('width="4" height="4"', 'width="20" height="20"')
}

// Every level draws the level below 10 times (one <image>, 9 <use>).
const fan = (depth) => {
  let inner = `<svg ${X} width="4" height="4"><rect width="4" height="4" fill="#00f"/></svg>`
  for (let d = 0; d < depth; d++) {
    let b = `<image id="i" width="4" height="4" href="${url(inner)}"/>`
    for (let k = 1; k < 10; k++) b += `<use href="#i" x="${k}"/>`
    inner = `<svg ${X} width="4" height="4">${b}</svg>`
  }
  return inner.replace('width="4" height="4"', 'width="20" height="20"')
}

// A custom property `n` bytes long: a dash list ("5 5 ... 5"), so a valid
// one dashes the line and an invalid one leaves it solid.
const dashes = (n) => (n % 2 ? '5 '.repeat((n - 1) / 2) + '5' : '5 '.repeat(n / 2 - 1) + '55')
const capped = (n, chained) =>
  S(
    `<line x1="0" y1="5" x2="40" y2="5" stroke="#00f" stroke-width="4" style="--d: ${dashes(n)};${chained ? ' --e: var(--d);' : ''} stroke-dasharray: var(${chained ? '--e' : '--d'})"/>`,
    40,
    10,
  )

module.exports = {
  // <use>
  use_self: c(S('<rect width="10" height="10" fill="#00f"/><use id="u" href="#u" x="20"/>')),
  use_ancestor: c(S('<g id="a"><rect width="10" height="10" fill="#00f"/><use href="#a" x="20"/></g>')),
  use_mutual: c(
    S(
      '<g id="a"><rect width="10" height="10" fill="#00f"/><use href="#b" x="10"/></g><g id="b"><rect y="20" width="10" height="10" fill="#0a0"/><use href="#a" y="10"/></g>',
    ),
  ),
  use_bomb4: c(
    S(
      (() => {
        let b = '<defs><rect id="l0" width="1" height="1" fill="#f00"/>'
        for (let i = 1; i <= 4; i++) {
          b += `<g id="l${i}">`
          for (let k = 0; k < 10; k++) b += `<use href="#l${i - 1}" x="${k % 3}"/>`
          b += '</g>'
        }
        return b + '</defs><use href="#l4"/>'
      })(),
    ),
  ),
  // clipPath
  clip_self: c(
    S(
      '<clipPath id="c" clip-path="url(#c)"><rect width="20" height="20"/></clipPath><rect width="40" height="40" fill="#0a0" clip-path="url(#c)"/>',
    ),
  ),
  clip_child_self: c(
    S(
      '<clipPath id="c"><rect width="20" height="20" clip-path="url(#c)"/></clipPath><rect width="40" height="40" fill="#0a0" clip-path="url(#c)"/>',
    ),
  ),
  clip_mutual: c(
    S(
      '<clipPath id="a" clip-path="url(#b)"><rect width="20" height="20"/></clipPath><clipPath id="b" clip-path="url(#a)"><rect x="10" width="20" height="20"/></clipPath><rect width="40" height="40" fill="#0a0" clip-path="url(#a)"/>',
    ),
  ),
  // mask
  mask_self: c(
    S(
      '<mask id="m"><rect width="40" height="40" fill="#fff" mask="url(#m)"/></mask><rect width="40" height="40" fill="#0a0" mask="url(#m)"/>',
    ),
  ),
  mask_mutual: c(
    S(
      '<mask id="a"><rect width="20" height="40" fill="#fff" mask="url(#b)"/></mask><mask id="b"><rect width="40" height="20" fill="#fff" mask="url(#a)"/></mask><rect width="40" height="40" fill="#0a0" mask="url(#a)"/>',
    ),
  ),
  // gradient href chains
  grad_href_self: c(
    S(
      '<linearGradient id="g" href="#g"><stop offset="0" stop-color="#00f"/><stop offset="1" stop-color="#f00"/></linearGradient><rect width="40" height="40" fill="url(#g)"/>',
    ),
  ),
  grad_href_mutual: c(
    S(
      '<linearGradient id="a" href="#b" x2="0" y2="1"/><linearGradient id="b" href="#a"><stop offset="0" stop-color="#00f"/><stop offset="1" stop-color="#f00"/></linearGradient><rect width="20" height="40" fill="url(#a)"/><rect x="20" width="20" height="40" fill="url(#b)"/>',
    ),
  ),
  grad_href_loop3: c(
    S(
      '<linearGradient id="a" href="#b"/><linearGradient id="b" href="#c" x2="0" y2="1"/><linearGradient id="c" href="#a"><stop offset="0" stop-color="#00f"/><stop offset="1" stop-color="#0a0"/></linearGradient><rect width="40" height="40" fill="url(#a)"/>',
    ),
  ),
  // pattern content
  pattern_self: c(
    S(
      '<pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="url(#p)"/><rect x="5" width="5" height="5" fill="#0a0"/></pattern><rect width="40" height="40" fill="url(#p)"/>',
    ),
  ),
  pattern_mutual: c(
    S(
      '<pattern id="a" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="url(#b)"/></pattern><pattern id="b" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="url(#a)"/></pattern><rect width="40" height="40" fill="url(#a)"/>',
    ),
  ),
  // <image>
  image_frag_self: c(S('<image id="i" href="#i" width="20" height="20"/>')),
  image_chain_12: c(chain(12), 20, 20),
  image_chain_64: c(chain(64), 20, 20),
  image_chain_65: c(chain(65), 20, 20),
  image_fan_d4: c(fan(4), 20, 20),
  // custom properties: Blink's 2,097,152-byte cap
  var_exp28: c(
    S(
      (() => {
        let s = '--v0: xx;'
        for (let i = 1; i <= 28; i++) s += `--v${i}: var(--v${i - 1}) var(--v${i - 1});`
        return `<rect width="10" height="10" style="${s} fill: var(--v28, red)"/>`
      })(),
    ),
  ),
  var_cap_2097152: c(capped(2097152, false), 40, 10),
  var_cap_2097153: c(capped(2097153, false), 40, 10),
  var_cap_chained_2097152: c(capped(2097152, true), 40, 10),
  var_cap_chained_2097153: c(capped(2097153, true), 40, 10),
  // nesting: the root counts as 1
  depth_5000: c(
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">${'<g>'.repeat(4998)}<rect width="10" height="10"/>${'</g>'.repeat(4998)}</svg>`,
    20,
    20,
  ),
  depth_5001: c(
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">${'<g>'.repeat(4999)}<rect width="10" height="10"/>${'</g>'.repeat(4999)}</svg>`,
    20,
    20,
  ),
}
