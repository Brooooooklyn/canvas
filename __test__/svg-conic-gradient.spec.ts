// SVG export has no Chrome counterpart: the SVG must look like Chrome's raster canvas. SVG has no
// conic gradient (SkSVGDevice drops a sweep shader to its black paint color), so the export
// rasterizes the conic fill into a pattern image, one image pixel per canvas pixel, with the
// globalAlpha in it. The pattern pixels must equal the raster canvas, which matches Chrome 155
// (arm64 and x64) at these points.
import test from 'ava'

import { createCanvas, loadImage, SvgExportFlag } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>
type G = ReturnType<Ctx['createLinearGradient']>

const stops = (g: G) => {
  g.addColorStop(0, 'rgb(255, 0, 0)')
  g.addColorStop(0.25, 'rgb(0, 255, 0)')
  g.addColorStop(0.5, 'rgb(0, 0, 255)')
  g.addColorStop(0.75, 'rgb(255, 255, 0)')
  g.addColorStop(1, 'rgb(255, 0, 255)')
  return g
}

const DRAWS: Record<string, (ctx: Ctx) => void> = {
  fill: (ctx) => {
    ctx.fillStyle = stops(ctx.createConicGradient(0, 20, 20))
    ctx.fillRect(0, 0, 40, 40)
  },
  rotated: (ctx) => {
    ctx.translate(20, 20)
    ctx.rotate(Math.PI / 6)
    ctx.translate(-20, -20)
    ctx.fillStyle = stops(ctx.createConicGradient(1, 20, 20))
    ctx.fillRect(-20, -20, 80, 80)
  },
  fillPart: (ctx) => {
    ctx.fillStyle = stops(ctx.createConicGradient(0, 20, 20))
    ctx.fillRect(13, 11, 20, 20)
  },
}

// [x, y, r, g, b, a] in canvas pixels, measured in Chrome.
const CHROME_PIXELS: Record<string, number[][]> = {
  fill: [
    [38, 20, 250, 4, 0, 255],
    [20, 38, 4, 250, 0, 255],
    [1, 20, 0, 5, 251, 255],
    [20, 1, 255, 251, 4, 255],
    [30, 30, 127, 127, 0, 255],
    [14, 12, 152, 152, 102, 255],
    [32, 30, 141, 113, 0, 255],
    [25, 15, 255, 111, 144, 255],
  ],
  rotated: [
    [38, 20, 255, 243, 12, 255],
    [20, 38, 251, 3, 0, 255],
    [1, 20, 0, 252, 4, 255],
    [20, 1, 12, 12, 243, 255],
    [30, 30, 255, 119, 135, 255],
    [14, 12, 0, 95, 160, 255],
    [32, 30, 255, 134, 121, 255],
    [25, 15, 151, 151, 104, 255],
  ],
  fillPart: [
    [38, 20, 0, 0, 0, 0],
    [20, 38, 0, 0, 0, 0],
    [1, 20, 0, 0, 0, 0],
    [20, 1, 0, 0, 0, 0],
    [30, 30, 127, 127, 0, 255],
    [14, 12, 152, 152, 102, 255],
    [32, 30, 141, 113, 0, 255],
    [25, 15, 255, 111, 144, 255],
  ],
}

// The SVG of `draw`, and its pattern image decoded, placed at (x, y) in canvas pixels.
const exportSvg = async (draw: (ctx: Ctx) => void) => {
  const svg = createCanvas(40, 40, SvgExportFlag.NoPrettyXML)
  draw(svg.getContext('2d') as unknown as Ctx)
  const text = svg.getContent().toString('utf8')
  const [, x, y] = text.match(/transform="translate\(([-\d.]+) ([-\d.]+)\)"/) ?? ['', '0', '0']
  const image = await loadImage(Buffer.from(text.match(/base64,([^"]+)"/)![1], 'base64'))
  const decoded = createCanvas(image.width, image.height).getContext('2d')
  decoded.drawImage(image, 0, 0)
  const at = (px: number, py: number) => [...decoded.getImageData(px - Number(x), py - Number(y), 1, 1).data]
  return { text, image, x: Number(x), y: Number(y), at }
}

for (const [name, draw] of Object.entries(DRAWS)) {
  test(`svg export of a conic gradient ${name} is a pattern image equal to the raster`, async (t) => {
    const { text, image, x, y, at } = await exportSvg(draw)
    t.regex(text, /fill="url\(#pattern_\d+\)"/)
    // No shape painted with the sweep's black paint color (outside the clip path).
    t.notRegex(text.replace(/<clipPath[\s\S]*?<\/clipPath>/g, ''), /<rect/)
    const raster = createCanvas(40, 40).getContext('2d')
    draw(raster)
    for (const [px, py, ...rgba] of CHROME_PIXELS[name]) {
      t.deepEqual([...raster.getImageData(px, py, 1, 1).data], rgba)
      const ix = px - x,
        iy = py - y
      if (ix >= 0 && iy >= 0 && ix < image.width && iy < image.height) {
        t.deepEqual(at(px, py), rgba, `${px},${py}`)
      }
    }
  })
}

const redBlue = (g: G) => {
  g.addColorStop(0, 'rgb(255, 0, 0)')
  g.addColorStop(1, 'rgb(0, 0, 255)')
  return g
}

// The image covers the draw and its antialiased edges in whole device pixels, so the export clips
// it to the image only. A clip at the fractional geometry bounds would antialias the edges a second
// time: Chrome then renders the left edge at alpha 64 instead of its raster's 128.
test('svg export of a conic gradient on a fractional rect clips at whole pixels', async (t) => {
  const draw = (ctx: Ctx) => {
    ctx.fillStyle = redBlue(ctx.createConicGradient(0.7, 20, 20))
    ctx.fillRect(5.5, 5.3, 20.4, 20.6)
  }
  const { text, image, x, y, at } = await exportSvg(draw)
  const clips = [...text.matchAll(/<clipPath[^>]*>([\s\S]*?)<\/clipPath>/g)].map((m) => m[1])
  t.is(clips.length, 1)
  const attr = (name: string) => Number(clips[0].match(new RegExp(` ${name}="([-\\d.]+)"`))?.[1] ?? 0)
  t.deepEqual([attr('x'), attr('y'), attr('width'), attr('height')], [0, 0, image.width, image.height])
  t.deepEqual([x, y], [0, 0])
  const raster = createCanvas(40, 40).getContext('2d')
  draw(raster)
  // [x, y, r, g, b, a] measured in Chrome: the edges, then the inside, where the image equals them.
  const edges = [
    [5, 15, 143, 0, 112, 128],
    [25, 15, 57, 0, 198, 230],
    [15, 5, 104, 0, 151, 179],
    [15, 25, 192, 0, 63, 230],
    [5, 5, 123, 0, 132, 89],
    [30, 30, 0, 0, 0, 0],
  ]
  const inside = [
    [10, 10, 124, 0, 131, 255],
    [20, 20, 251, 0, 3, 255],
    [24, 8, 77, 0, 177, 255],
    [7, 22, 164, 0, 91, 255],
  ]
  for (const [px, py, ...rgba] of [...edges, ...inside]) {
    t.deepEqual([...raster.getImageData(px, py, 1, 1).data], rgba, `${px},${py}`)
  }
  for (const [px, py, ...rgba] of inside) {
    t.deepEqual(at(px, py), rgba, `${px},${py}`)
  }
})

// The globalAlpha is in the image pixels (exact), not a fill-opacity on the element.
test('svg export of a conic gradient keeps globalAlpha in the image', async (t) => {
  const draw = (ctx: Ctx) => {
    ctx.fillStyle = redBlue(ctx.createConicGradient(0.7, 20, 20))
    ctx.globalAlpha = 0.3
    ctx.fillRect(0, 0, 40, 40)
  }
  const { text, at } = await exportSvg(draw)
  t.notRegex(text, /opacity/)
  const raster = createCanvas(40, 40).getContext('2d')
  draw(raster)
  for (const [px, py, ...rgba] of [
    [38, 20, 27, 0, 228, 76],
    [20, 38, 221, 0, 34, 76],
    [1, 20, 158, 0, 101, 76],
    [20, 1, 91, 0, 164, 76],
    [30, 30, 252, 0, 3, 76],
    [14, 12, 117, 0, 138, 76],
    [32, 30, 0, 0, 255, 76],
    [25, 15, 57, 0, 201, 76],
  ]) {
    t.deepEqual([...raster.getImageData(px, py, 1, 1).data], rgba, `${px},${py}`)
    t.deepEqual(at(px, py), rgba, `${px},${py}`)
  }
})

// The image covers only the device bounds of the draw inside the clip, and the draw is skipped
// past 32768 * 8192 pixels (Chrome's largest canvas). One canvas and one getContent(): the backing
// store of such a canvas is only touched lazily.
test('svg export of a conic gradient on a huge canvas rasterizes only the clipped bounds', (t) => {
  const svg = createCanvas(32768, 8193, SvgExportFlag.NoPrettyXML)
  const ctx = svg.getContext('2d') as unknown as Ctx
  ctx.fillStyle = redBlue(ctx.createConicGradient(0, 20, 20))
  // Skipped: 32768 x 8193 pixels.
  ctx.fillRect(0, 0, 32768, 8193)
  ctx.beginPath()
  ctx.rect(0, 0, 30, 20)
  ctx.clip()
  // Drawn: a 30 x 20 image.
  ctx.fillRect(0, 0, 32768, 8193)
  const text = svg.getContent().toString('utf8')
  t.is(text.match(/<pattern/g)?.length, 1)
  t.regex(text, /<image[^>]* width="30" height="20"/)
  t.notRegex(text.replace(/<clipPath[\s\S]*?<\/clipPath>/g, ''), /<rect/)
})

// Sibling: SkSVGDevice still writes linear and radial gradients itself.
test('svg export of linear and radial gradients writes no pattern image', (t) => {
  for (const [make, element] of [
    [(c: Ctx) => c.createLinearGradient(0, 0, 40, 0), '<linearGradient'],
    [(c: Ctx) => c.createRadialGradient(20, 20, 0, 20, 20, 20), '<radialGradient'],
  ] as const) {
    const svg = createCanvas(40, 40, SvgExportFlag.NoPrettyXML)
    const ctx = svg.getContext('2d') as unknown as Ctx
    ctx.fillStyle = redBlue(make(ctx))
    ctx.fillRect(0, 0, 40, 40)
    const text = svg.getContent().toString('utf8')
    t.true(text.includes(element), text)
    t.false(text.includes('<pattern'), text)
  }
})
