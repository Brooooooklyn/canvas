import { cyan } from 'colorette'
import { Bench } from 'tinybench'

import { createCanvas, Image } from '../index'

// An SVG image with a style sheet, var(), <use> and a nested SVG <image>:
// read once per src (src/svg_doc), then drawn by each drawImage.
const NESTED = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="9" fill="#e24329"/></svg>',
)
const SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" style="--accent: #fc6d26">
  <style>.tile { fill: var(--accent); stroke: #333 } .tile:nth-child(odd) { fill: #fca326 }</style>
  <defs><rect id="r" class="tile" width="18" height="18"/></defs>
  <g>${Array.from({ length: 100 }, (_, i) => `<use href="#r" x="${(i % 10) * 20}" y="${Math.floor(i / 10) * 20}"/>`).join('')}</g>
  <image href="data:image/svg+xml,${NESTED}" x="90" y="90" width="20" height="20"/>
</svg>`,
)

function load() {
  const image = new Image()
  image.src = SVG
  return image
}

export async function svgImage() {
  const bench = new Bench({
    name: 'svg image',
  })
  const image = load()
  const canvas = createCanvas(200, 200)
  const ctx = canvas.getContext('2d')

  bench
    .add('@napi-rs/skia load', () => {
      load()
    })
    .add('@napi-rs/skia drawImage', () => {
      ctx.drawImage(image, 0, 0)
    })

  await bench.run()
  console.info(cyan('Load an SVG image with CSS and draw it'))
  console.table(bench.table())

  return bench
}
