// SVG export has no Chrome counterpart: the SVG must look like Chrome's raster canvas. SVG has no
// conic gradient (SkSVGDevice drops a sweep shader to its black paint color), so the export
// rasterizes the conic fill into a pattern image, one image pixel per canvas pixel, with the
// globalAlpha in it. The pattern pixels must equal the raster canvas, which matches Chrome 155
// (arm64 and x64) at these points. An image of more than 2048 * 2048 pixels has a border of 1
// pixel, and past 4096 * 4096 pixels the image is scaled down to fit that many pixels.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, DOMMatrix, loadImage, SvgExportFlag } from '../index'

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

// The pattern images of an SVG, in order.
const patternImages = (text: string) =>
  [...text.matchAll(/<image [^>]*width="(\d+)" height="(\d+)" xlink:href="data:image\/png;base64,([^"]+)"/g)].map(
    (m) => ({ width: Number(m[1]), height: Number(m[2]), base64: m[3] }),
  )

// The transform [a, b, c, d, e, f] of the first path filled with a pattern.
const patternPathTransform = (text: string) => {
  const [, kind, args] = text.match(/<path fill="url\(#pattern_\d+\)"(?: transform="(\w+)\(([^)]*)\)")?/)!
  const n = (args ?? '').split(' ').map(Number)
  return kind === 'matrix'
    ? n
    : kind === 'translate'
      ? [1, 0, 0, 1, n[0], n[1]]
      : kind === 'scale'
        ? [n[0], 0, 0, n[1], 0, 0]
        : [1, 0, 0, 1, 0, 0]
}

// The SVG of `draw`, and its pattern image decoded, placed at (x, y) in canvas pixels: one image
// pixel per canvas pixel, so the transform only moves it by whole pixels (up to float noise, which a
// rotated CTM leaves in it).
const exportSvg = async (draw: (ctx: Ctx) => void) => {
  const svg = createCanvas(40, 40, SvgExportFlag.NoPrettyXML)
  draw(svg.getContext('2d') as unknown as Ctx)
  const text = svg.getContent().toString('utf8')
  const [, , , , e, f] = patternPathTransform(text)
  const x = Math.round(e)
  const y = Math.round(f)
  const image = await loadImage(Buffer.from(text.match(/base64,([^"]+)"/)![1], 'base64'))
  const decoded = createCanvas(image.width, image.height).getContext('2d')
  decoded.drawImage(image, 0, 0)
  const at = (px: number, py: number) => [...decoded.getImageData(px - x, py - y, 1, 1).data]
  return { text, image, x, y, at }
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

// The pattern tile is the image at any canvas size, not the viewport. Chrome draws an SVG pattern
// through an SkPictureShader, which rasterizes a tile of more than 2048 * 2048 device pixels at that
// many pixels: with a viewport ("100%") tile, a 300 x 300 fill on a 6000 x 6000 canvas came out
// with alpha 193 instead of 255 on its last column in Chrome; on a 2000 x 2000 canvas it was exact.
// The image starts at a multiple of 8, Skia's dither period, so its pixels equal the raster canvas.
// An image larger than 2048 * 2048 pixels, which Chrome resamples, has a border of 1 pixel of the
// same gradient so that its edges do not mix with the other side of the tile.
// [canvas size, rect x and y, rect size, image border]
for (const [n, x0, size, border] of [
  [40, 13, 20, 0],
  [2000, 1000, 300, 0],
  [6000, 1000, 300, 0],
  [6000, 1003, 3000, 1],
]) {
  test(`svg export of a conic gradient ${size}x${size} on a ${n}x${n} canvas tiles its pattern with the image`, async (t) => {
    const draw = (ctx: Ctx) => {
      ctx.fillStyle = stops(ctx.createConicGradient(0.4, x0 + size / 2, x0 + size / 2))
      ctx.fillRect(x0, x0, size, size)
    }
    const svg = createCanvas(n, n, SvgExportFlag.NoPrettyXML)
    draw(svg.getContext('2d') as unknown as Ctx)
    const text = svg.getContent().toString('utf8')
    const images = patternImages(text)
    t.is(images.length, 1)
    const { width, height, base64 } = images[0]
    t.regex(text, new RegExp(`<pattern [^>]* width="${width}" height="${height}"`))
    t.notRegex(text, /"100%"/)
    // One image pixel per canvas pixel, from a multiple of 8 to the antialiased edge of the draw (one
    // pixel out), in its border.
    const [a, b, c, d, e, f] = patternPathTransform(text)
    t.deepEqual([a, b, c, d], [1, 0, 0, 1])
    t.true(Number.isInteger(e / 8) && Number.isInteger(f / 8), `image at ${e},${f}`)
    for (const origin of [e, f]) {
      t.true(origin + border <= x0 - 1 && origin + border > x0 - 1 - 8, `image at ${e},${f}`)
    }
    t.deepEqual([e + width - border, f + height - border], [x0 + size + 1, x0 + size + 1])
    // Clipped to the image inside its border.
    const clips = [...text.matchAll(/<clipPath[^>]*>([\s\S]*?)<\/clipPath>/g)].map((m) => m[1])
    t.is(clips.length, 1)
    const attr = (name: string) => Number(clips[0].match(new RegExp(` ${name}="([-\\d.]+)"`))?.[1] ?? 0)
    t.deepEqual(['x', 'y', 'width', 'height'].map(attr), [
      e + border,
      f + border,
      width - 2 * border,
      height - 2 * border,
    ])
    const image = await loadImage(Buffer.from(base64, 'base64'))
    const decoded = createCanvas(width, height).getContext('2d')
    decoded.drawImage(image, 0, 0)
    const at = (px: number, py: number) => [...decoded.getImageData(px - e, py - f, 1, 1).data]
    // The image pixels equal the raster canvas, here a canvas of the 8 x 8 dither cell of (px, py).
    const last = x0 + size - 1
    for (const [px, py] of [
      [x0, x0],
      [last, x0],
      [x0, last],
      [last, last],
      [x0 + 3, x0 + size / 2],
      [x0 + size / 2, last - 2],
      [x0 + size / 4, x0 + size / 5],
    ]) {
      const raster = createCanvas(8, 8).getContext('2d')
      raster.translate(-(px & ~7), -(py & ~7))
      draw(raster)
      const want = [...raster.getImageData(px & 7, py & 7, 1, 1).data]
      t.is(want[3], 255, `${px},${py}`)
      t.deepEqual(at(px, py), want, `${px},${py}`)
    }
    // The border is the gradient too.
    if (border) {
      for (const [px, py] of [
        [e, f + height / 2],
        [e + width - 1, f + height / 2],
        [e + width / 2, f],
        [e + width / 2, f + height - 1],
      ]) {
        t.is(at(Math.floor(px), Math.floor(py))[3], 255, `${px},${py}`)
      }
    }
  })
}

// A 1 pixel clip strip at a multiple of 8 (or at 0) gave a 1 pixel image side, which SkImageShader
// tiles with clamp, not repeat, and SkSVGDevice writes a clamp side as a viewport ("100%") tile: on
// a 6000 x 6000 canvas Chrome drew the strip with alpha 58 instead of 255. That side of the image
// has 2 pixels (the second is the gradient too, outside the clip), so the tile is the image.
// [clip rect x, y, width, height, then [x, y, r, g, b, a] in canvas pixels measured in Chrome]
for (const [cx, cy, cw, ch, pixels] of [
  [
    0,
    3000,
    6000,
    1,
    [
      [0, 3000, 0, 124, 130, 255],
      [1000, 3000, 0, 176, 78, 255],
      [2000, 3000, 48, 206, 0, 255],
      [3000, 3000, 176, 78, 0, 255],
      [5999, 3000, 255, 9, 247, 255],
    ],
  ],
  [
    2496,
    0,
    1,
    6000,
    [
      [2496, 0, 245, 245, 9, 255],
      [2496, 1000, 255, 228, 26, 255],
      [2496, 2000, 255, 48, 206, 255],
      [2496, 3000, 123, 131, 0, 255],
      [2496, 5999, 69, 186, 0, 255],
    ],
  ],
  [
    0,
    0,
    6000,
    1,
    [
      [0, 0, 78, 78, 176, 255],
      [1000, 0, 131, 131, 123, 255],
      [2000, 0, 206, 206, 48, 255],
      [3000, 0, 255, 228, 26, 255],
      [5999, 0, 255, 124, 132, 255],
    ],
  ],
] as [number, number, number, number, number[][]][]) {
  test(`svg export of a conic gradient in a ${cw}x${ch} clip at ${cx},${cy} on a 6000x6000 canvas tiles its pattern with the image`, async (t) => {
    const draw = (ctx: Ctx) => {
      ctx.beginPath()
      ctx.rect(cx, cy, cw, ch)
      ctx.clip()
      ctx.fillStyle = stops(ctx.createConicGradient(0.3, 2000, 2000))
      ctx.fillRect(0, 0, 6000, 6000)
    }
    const svg = createCanvas(6000, 6000, SvgExportFlag.NoPrettyXML)
    draw(svg.getContext('2d') as unknown as Ctx)
    const text = svg.getContent().toString('utf8')
    const images = patternImages(text)
    t.is(images.length, 1)
    const { width, height, base64 } = images[0]
    t.notRegex(text, /"100%"/)
    t.regex(text, new RegExp(`<pattern [^>]* width="${width}" height="${height}"`))
    t.deepEqual([width, height], [Math.max(cw, 2), Math.max(ch, 2)])
    // One image pixel per canvas pixel, from the strip's corner.
    t.deepEqual(patternPathTransform(text), [1, 0, 0, 1, cx, cy])
    const image = await loadImage(Buffer.from(base64, 'base64'))
    const decoded = createCanvas(width, height).getContext('2d')
    decoded.drawImage(image, 0, 0)
    const at = (px: number, py: number) => [...decoded.getImageData(px - cx, py - cy, 1, 1).data]
    for (const [px, py, ...rgba] of pixels) {
      // The raster canvas, here a canvas of the 8 x 8 dither cell of (px, py), equals Chrome.
      const raster = createCanvas(8, 8).getContext('2d')
      raster.translate(-(px & ~7), -(py & ~7))
      draw(raster)
      t.deepEqual([...raster.getImageData(px & 7, py & 7, 1, 1).data], rgba, `raster ${px},${py}`)
      t.deepEqual(at(px, py), rgba, `${px},${py}`)
      // The second pixel across the strip.
      t.is(at(px + (cw === 1 ? 1 : 0), py + (ch === 1 ? 1 : 0))[3], 255, `next to ${px},${py}`)
    }
  })
}

// The most pixels a conic raster image has, its border included: 4096 * 4096 (64 MiB N32).
const BUDGET = 4096 * 4096

// The longest side of a PNG that Skia's encoder writes: libpng's default user limit
// (PNG_USER_WIDTH_MAX and PNG_USER_HEIGHT_MAX).
const PNG_SIDE = 1_000_000

// Runs `code` in a child process at the package root (maxRSS, or memory-heavy draws).
const runChild = (code: string) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })

// What an SVG renderer shows at canvas pixel (x, y) for the first conic draw: its pattern image under
// the path's transform, sampled bilinearly (how Chrome upscales it). Transparent outside the image,
// where the SVG repeats the tile: without the border the edges fade.
const renderFirstPattern = async (text: string) => {
  const image = await loadImage(Buffer.from(patternImages(text)[0].base64, 'base64'))
  const [a, b, c, d, e, f] = patternPathTransform(text)
  return (x: number, y: number) => {
    const ctx = createCanvas(1, 1).getContext('2d')
    const pattern = ctx.createPattern(image, 'no-repeat')!
    pattern.setTransform(new DOMMatrix([a, b, c, d, e - x, f - y]))
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, 1, 1)
    return [...ctx.getImageData(0, 0, 1, 1).data]
  }
}

// The raster canvas pixel (x, y) of a full conic fill on an n x n canvas, from a 1 x 1 canvas moved to
// (x, y) (equal to the n x n canvas at these points: they are multiples of 8, Skia's dither period, or
// edges, where the dither does not change the value).
const rasterConicAt = (n: number, x: number, y: number) => {
  const ctx = createCanvas(1, 1).getContext('2d')
  ctx.translate(-x, -y)
  ctx.fillStyle = stops(ctx.createConicGradient(0, n / 2, n / 2))
  ctx.fillRect(0, 0, n, n)
  return [...ctx.getImageData(0, 0, 1, 1).data]
}

// [x, y, r, g, b, a] of a full conic fill measured in Chrome's raster canvas: four points about 50 px
// from the center off the seam (3 levels per px, so a misplaced image shows), then the four edges.
const LARGE_CHROME_PIXELS: Record<number, number[][]> = {
  4097: [
    [2000, 2032, 52, 52, 202, 255],
    [2064, 2000, 255, 202, 52, 255],
    [2032, 2096, 0, 202, 52, 255],
    [2088, 2088, 127, 127, 0, 255],
    [0, 1024, 75, 75, 179, 255],
    [4096, 1024, 255, 75, 179, 255],
    [1024, 4096, 0, 179, 75, 255],
    [1024, 0, 179, 179, 75, 255],
  ],
  8192: [
    [4048, 4080, 51, 51, 203, 255],
    [4112, 4048, 255, 200, 54, 255],
    [4080, 4144, 0, 204, 50, 255],
    [4136, 4136, 127, 127, 0, 255],
    [0, 2048, 75, 75, 179, 255],
    [8191, 2048, 255, 75, 179, 255],
    [2048, 8191, 0, 179, 75, 255],
    [2048, 0, 179, 179, 75, 255],
  ],
}

// Past the budget each image pixel covers k x k canvas pixels, k the smallest whole number that fits
// (SkSVGDevice writes the transform with 6 significant digits, exact for a whole k), with a 1 image
// pixel border of the same gradient so the upscale does not mix the edges with the outside. The
// pattern tile is the image: Chrome rasterizes a pattern tile larger than 2048 * 2048 device pixels
// at that many pixels, so the transparent rest of a viewport-sized tile faded the edges. The upscale
// blurs the gradient's seam and center (accepted); at these points, away from both, the result stays
// within 3 of Chrome's raster, and the edges keep their full alpha.
for (const n of [4097, 8192]) {
  test(`svg export of a conic gradient on a ${n}x${n} canvas scales the raster to 4096 * 4096 pixels`, async (t) => {
    const svg = createCanvas(n, n, SvgExportFlag.NoPrettyXML)
    const ctx = svg.getContext('2d') as unknown as Ctx
    ctx.fillStyle = stops(ctx.createConicGradient(0, n / 2, n / 2))
    ctx.fillRect(0, 0, n, n)
    const text = svg.getContent().toString('utf8')
    const images = patternImages(text)
    t.is(images.length, 1)
    const { width, height } = images[0]
    t.true(width * height <= BUDGET, `${width}x${height}`)
    t.regex(text, new RegExp(`<pattern [^>]* width="${width}" height="${height}"`))
    t.regex(text, /<path fill="url\(#pattern_0\)"[^>]* d="M/)
    // Image pixel 1 + i covers canvas pixels k * i to k * (i + 1); the border lies outside the canvas.
    const [k, b, c, d, e, f] = patternPathTransform(text)
    t.deepEqual([b, c, d, e, f], [0, 0, k, -k, -k])
    t.true(Number.isInteger(k) && k >= 2, `k = ${k}`)
    t.deepEqual([width - 2, height - 2], [Math.ceil(n / k), Math.ceil(n / k)])
    t.true((Math.ceil(n / (k - 1)) + 2) ** 2 > BUDGET, `k - 1 = ${k - 1} fits too`)
    // Clipped to the image inside the border, not to the bordered image.
    const clips = [...text.matchAll(/<clipPath[^>]*>([\s\S]*?)<\/clipPath>/g)].map((m) => m[1])
    t.is(clips.length, 1)
    const attr = (name: string) => Number(clips[0].match(new RegExp(` ${name}="([-\\d.]+)"`))?.[1] ?? 0)
    t.deepEqual([attr('x'), attr('y'), attr('width'), attr('height')], [0, 0, k * (width - 2), k * (height - 2)])
    const shown = await renderFirstPattern(text)
    for (const [x, y, ...rgba] of LARGE_CHROME_PIXELS[n]) {
      t.deepEqual(rasterConicAt(n, x, y), rgba, `raster ${x},${y}`)
      const pixel = shown(x, y)
      t.true(
        pixel.every((v, i) => Math.abs(v - rgba[i]) <= 3),
        `${x},${y}: svg ${pixel} vs raster ${rgba}`,
      )
    }
  })
}

// Every fill gets its own image within the budget, and the memory does not follow the canvas size
// (1:1, each fill held a 256 MiB raster and its PNG encoder). maxRSS in a child process.
test('svg export of 10 conic fills on an 8192x8192 canvas keeps each raster within the budget', async (t) => {
  const { status, stdout, stderr } = await runChild(`
const { createCanvas, SvgExportFlag } = require('./index.js')
const n = 8192
const svg = createCanvas(n, n, SvgExportFlag.NoPrettyXML)
const ctx = svg.getContext('2d')
const g = ctx.createConicGradient(0.3, n / 2, n / 2)
g.addColorStop(0, 'red')
g.addColorStop(0.5, 'lime')
g.addColorStop(1, 'blue')
ctx.fillStyle = g
const before = process.resourceUsage().maxRSS
for (let i = 0; i < 10; i++) ctx.fillRect(0, 0, n, n)
const content = svg.getContent()
const growth = (process.resourceUsage().maxRSS - before) / 1024
const images = []
for (let i = content.indexOf('<image '); i !== -1; i = content.indexOf('<image ', i + 1)) {
  const head = content.subarray(i, i + 200).toString('latin1')
  images.push([Number(head.match(/ width="(\\d+)"/)[1]), Number(head.match(/ height="(\\d+)"/)[1])])
}
console.log(JSON.stringify({ growth, images }))
`)
  t.is(status, 0, stderr)
  const { growth, images } = JSON.parse(stdout.trim().split('\n').pop()!)
  t.is(images.length, 10)
  for (const [width, height] of images) {
    t.true(width * height <= BUDGET, `${width}x${height}`)
  }
  t.true(growth < 256, `10 fills grew maxRSS by ${growth.toFixed(1)} MB, expected < 256 MB`)
})

// SkSVGDevice encodes the image as a PNG, which fails for a side over PNG_SIDE; the path was then
// written with no fill, so the conic fill came out black (from a canvas width of about 2,000,000 at
// k = 2). Each image side, border included, stays within PNG_SIDE, and the border counts in the
// budget: a 1 pixel high strip had an image of 3 rows, about 3 times the budget. maxRSS in a child
// process, one per canvas.
for (const [w, h] of [
  [2000010, 10],
  [20000000, 1],
]) {
  test(`svg export of a conic gradient on a ${w}x${h} canvas keeps its image within the PNG side limit`, async (t) => {
    const { status, stdout, stderr } = await runChild(`
const { createCanvas, SvgExportFlag } = require('./index.js')
const svg = createCanvas(${w}, ${h}, SvgExportFlag.NoPrettyXML)
const ctx = svg.getContext('2d')
const g = ctx.createConicGradient(0.3, ${w} / 2, ${h} / 2)
g.addColorStop(0, 'red')
g.addColorStop(0.5, 'lime')
g.addColorStop(1, 'blue')
ctx.fillStyle = g
const before = process.resourceUsage().maxRSS
ctx.fillRect(0, 0, ${w}, ${h})
const text = svg.getContent().toString('latin1')
const growth = (process.resourceUsage().maxRSS - before) / 1024
const images = [...text.matchAll(/<image [^>]*width="(\\d+)" height="(\\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])])
const path = text.match(/<path [^>]*/)[0]
console.log(JSON.stringify({ growth, images, path }))
`)
    t.is(status, 0, stderr)
    t.notRegex(stderr, /libpng/)
    const { growth, images, path } = JSON.parse(stdout.trim().split('\n').pop()!)
    t.is(images.length, 1)
    const [[width, height]] = images
    t.true(width <= PNG_SIDE && height <= PNG_SIDE && width * height <= BUDGET, `${width}x${height}`)
    t.regex(path, /^<path fill="url\(#pattern_0\)"/)
    t.true(growth < 64, `the fill grew maxRSS by ${growth.toFixed(1)} MB, expected < 64 MB`)
  })
}

// The image covers only the device bounds of the draw inside the clip; a draw past the budget is
// scaled, not skipped. One canvas and one getContent(): the backing store of such a canvas is only
// touched lazily.
test('svg export of a conic gradient on a huge canvas rasterizes only the clipped bounds', (t) => {
  const svg = createCanvas(32768, 8193, SvgExportFlag.NoPrettyXML)
  const ctx = svg.getContext('2d') as unknown as Ctx
  ctx.fillStyle = redBlue(ctx.createConicGradient(0, 20, 20))
  // Scaled: 32768 x 8193 pixels.
  ctx.fillRect(0, 0, 32768, 8193)
  ctx.beginPath()
  ctx.rect(0, 0, 30, 20)
  ctx.clip()
  // 1:1: a 30 x 20 image.
  ctx.fillRect(0, 0, 32768, 8193)
  const text = svg.getContent().toString('utf8')
  t.is(text.match(/<pattern/g)?.length, 2)
  const [scaled, clipped] = patternImages(text)
  t.true(scaled.width * scaled.height <= BUDGET, `${scaled.width}x${scaled.height}`)
  t.true(
    Math.abs((scaled.width - 2) / (scaled.height - 2) - 32768 / 8193) < 0.01,
    `${scaled.width}x${scaled.height} keeps the aspect ratio`,
  )
  t.deepEqual([clipped.width, clipped.height], [30, 20])
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
