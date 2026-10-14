// Pixel values of Chrome's CPU canvas: Chrome 155 launched with --disable-gpu,
// getContext('2d', { willReadFrequently: true }). Every value below is the same
// in Chrome on arm64 and on x64. Chrome builds Skia without
// SK_FORCE_RASTER_PIPELINE_BLITTER, so most of its fills go through Skia's
// legacy 8-bit blitters; scripts/skia-gn-args.cjs builds ours the same way.
// The larger byte arrays live in fixtures/chrome-cpu-raster.json (base64).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, loadImage, DOMMatrix, ImageData, type Canvas, type Image, type SKRSContext2D } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const CHROME: Record<string, string> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'chrome-cpu-raster.json'), 'utf8'),
)

function chrome(key: string): number[] {
  return Array.from(Buffer.from(CHROME[key], 'base64'))
}

function px(ctx: SKRSContext2D, x: number, y: number, w = 1, h = 1): number[] {
  return Array.from(ctx.getImageData(x, y, w, h).data)
}

function alphaOf(data: number[]): number[] {
  return data.filter((_, i) => i % 4 === 3)
}

function grid(w: number, h: number, color: (i: number, j: number) => string): Canvas {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      ctx.fillStyle = color(i, j)
      ctx.fillRect(i, j, 1, 1)
    }
  }
  return canvas
}

// Opaque noise from a fixed LCG, written with putImageData.
function noise(w: number, h: number, seed: number): Canvas {
  const next = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = next()
    data[i * 4 + 1] = next()
    data[i * 4 + 2] = next()
    data[i * 4 + 3] = 255
  }
  const canvas = createCanvas(w, h)
  canvas.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0)
  return canvas
}

function imageFrom(canvas: Canvas) {
  return loadImage(canvas.toBuffer('image/png'))
}

test('solid fills round like the legacy blitters', (t) => {
  const a = createCanvas(1, 1).getContext('2d')
  a.globalAlpha = 0.3
  a.fillStyle = 'rgba(0,255,128,0.1)'
  a.fillRect(0, 0, 1, 1)
  t.deepEqual(px(a, 0, 0), [0, 255, 128, 8])

  const b = createCanvas(1, 1).getContext('2d')
  b.fillStyle = 'rgb(200,120,40)'
  b.fillRect(0, 0, 1, 1)
  b.globalAlpha = 0.6
  b.fillStyle = 'rgba(0,255,0,0.5)'
  b.fillRect(0, 0, 1, 1)
  t.deepEqual(px(b, 0, 0), [139, 160, 27, 255])
})

test('scaled drawImage at globalAlpha rounds like the legacy blitters', async (t) => {
  const src = createCanvas(8, 8)
  const sctx = src.getContext('2d')
  sctx.fillStyle = 'rgb(32,128,223)'
  sctx.fillRect(0, 0, 8, 8)
  const image = await imageFrom(src)
  for (const [name, source] of [
    ['canvas', src],
    ['image', image],
  ] as const) {
    for (const smoothing of [false, true]) {
      const ctx = createCanvas(16, 16).getContext('2d')
      ctx.imageSmoothingEnabled = smoothing
      ctx.imageSmoothingQuality = 'low'
      ctx.globalAlpha = 0.3
      ctx.drawImage(source, 0, 0, 16, 16)
      t.deepEqual(px(ctx, 8, 8), [30, 129, 222, 77], `${name}, smoothing ${smoothing}`)
    }
  }
})

// cc DrawImageRectOp maps the quality from the draw's matrix
// (MatrixToScalingOperation): 'medium' blends two mip levels, which Skia never
// draws through the legacy bilerp, so it must not render like 'low'.
test('drawImage of a canvas samples like Chrome at every quality', (t) => {
  const src = noise(8, 8, 7)
  for (const quality of ['off', 'low', 'medium', 'high'] as const) {
    // upscale, 1:1 and downscale
    for (const [dw, dh] of [
      [11, 10],
      [7, 7],
      [4, 3],
    ]) {
      const ctx = createCanvas(12, 12).getContext('2d')
      if (quality === 'off') {
        ctx.imageSmoothingEnabled = false
      } else {
        ctx.imageSmoothingQuality = quality
      }
      ctx.drawImage(src, 0.5, 0.5, 7, 7, 0.25, 0.5, dw, dh)
      const key = `${quality}|${dw}x${dh}`
      t.deepEqual(px(ctx, 0, 0, 12, 12), chrome(`canvas-quality|${key}`), key)
    }
  }
})

test('blurred shadow mask is blitted like Chrome', (t) => {
  const ctx = createCanvas(16, 8).getContext('2d')
  ctx.globalAlpha = 0.5
  ctx.shadowOffsetY = 100
  ctx.shadowBlur = 3
  ctx.shadowColor = 'rgb(203,52,87)'
  ctx.fillStyle = 'rgb(9,9,9)'
  ctx.fillRect(4, -110, 8, 28)
  t.deepEqual(
    px(ctx, 0, 0, 16, 1),
    [
      0, 0, 0, 0, 153, 51, 51, 5, 198, 42, 85, 18, 204, 51, 85, 45, 203, 49, 86, 83, 204, 51, 86, 110, 203, 52, 87, 123,
      203, 52, 88, 128, 203, 52, 88, 128, 203, 52, 87, 123, 204, 51, 86, 110, 203, 49, 86, 83, 204, 51, 85, 45, 198, 42,
      85, 18, 153, 51, 51, 5, 0, 0, 0, 0,
    ],
  )
  t.deepEqual(px(ctx, 0, 0, 16, 8), chrome('shadow-blur'))
})

// SK_SUPPORT_LEGACY_CONIC_CHOP splits the arc into the same segments as Chrome.
test('AA circle edge matches Chrome', (t) => {
  const ctx = createCanvas(24, 24).getContext('2d')
  ctx.fillStyle = 'rgb(200,120,40)'
  ctx.fillRect(0, 0, 24, 24)
  ctx.fillStyle = 'rgb(32,128,223)'
  ctx.beginPath()
  ctx.arc(11.3, 12.6, 9.2, 0, Math.PI * 2)
  ctx.fill()
  t.deepEqual(px(ctx, 19, 9), [47, 127, 205, 255])
  t.deepEqual(px(ctx, 0, 0, 24, 24), chrome('aa-circle'))
})

// SK_SUPPORT_LEGACY_ANISOTROPIC_MIPMAP_SCALE: the mip level comes from
// sqrt(sx * sy), not from the smaller scale.
test('non-uniform pattern downscale picks the mip level like Chrome', (t) => {
  const texture = noise(32, 32, 99)
  for (const [sx, sy] of [
    [0.9, 0.4],
    [0.5, 0.5],
  ]) {
    const ctx = createCanvas(16, 16).getContext('2d')
    ctx.imageSmoothingQuality = 'medium'
    const pattern = ctx.createPattern(texture, 'repeat')
    pattern.setTransform(new DOMMatrix([sx, 0, 0, sy, 0, 0]))
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, 16, 16)
    t.deepEqual(px(ctx, 0, 0, 16, 16), chrome(`aniso|${sx}x${sy}`), `${sx}x${sy}`)
  }
})

// Blink ShouldDrawImageAntialiased: no AA while the CTM keeps rects
// axis-aligned and the destination is at least one device pixel.
test('drawImage keeps axis-aligned edges un-antialiased like Chrome', async (t) => {
  const src = grid(8, 8, (i, j) => `rgb(${i * 30},${j * 30},${(i + j) * 15})`)
  const image = await imageFrom(src)
  for (const [name, source] of [
    ['canvas', src],
    ['image', image],
  ] as const) {
    const ctx = createCanvas(32, 32).getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(source, 0.3, 0.6, 27, 27)
    t.deepEqual(px(ctx, 5, 0), [0, 0, 0, 0], name)
    t.deepEqual(px(ctx, 27, 5), [0, 0, 0, 0], name)
    t.deepEqual(px(ctx, 0, 5), [0, 30, 15, 255], name)
    t.deepEqual(px(ctx, 0, 0, 32, 32), chrome('frac-up-27'), name)
  }
})

test('drawImage antialiases rotated edges like Chrome', async (t) => {
  const src = grid(8, 8, (i, j) => `rgb(${i * 30},${j * 30},${(i + j) * 15})`)
  const image = await imageFrom(src)
  for (const [name, source] of [
    ['canvas', src],
    ['image', image],
  ] as const) {
    const ctx = createCanvas(32, 32).getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.translate(16, 4)
    ctx.rotate(Math.PI / 7)
    ctx.drawImage(source, 0, 0, 20, 20)
    // RGB along the edges differs between Chrome's own arm64 and x64 builds;
    // the coverage does not.
    t.deepEqual(alphaOf(px(ctx, 0, 0, 32, 32)), chrome('rot|alpha'), name)
  }
})

// Blink reads the AA rule's matrix off the paint canvas, where CompositedDraw
// has put the CTM back before draw_func (canvas_2d_recorder_context.h:919-990).
// Ours records the composited ops into a layer at identity, so the rule must
// get the context's transform instead. Coverage only: RGB along the edges
// differs between Chrome's own arm64 and x64 builds.
test('drawImage antialiases from the context transform under every composite op', async (t) => {
  const src = grid(8, 8, (i, j) => `rgb(${i * 30},${j * 30},${(i + j) * 15})`)
  const image = await imageFrom(src)
  const transforms: Record<string, (ctx: SKRSContext2D, source: Canvas | Image) => void> = {
    rot: (ctx, source) => {
      ctx.translate(12, 2)
      ctx.rotate(Math.PI / 7)
      ctx.drawImage(source, 0, 0, 14, 14)
    },
    skew: (ctx, source) => {
      ctx.setTransform(1, 0, 0.5, 1, 2, 3)
      ctx.drawImage(source, 1, 1, 12, 16)
    },
    // Under one user pixel wide but 2.4 device pixels: no AA.
    up: (ctx, source) => {
      ctx.scale(4, 4)
      ctx.drawImage(source, 1.1, 1.3, 0.6, 4.2)
    },
    // Two user pixels wide but half a device pixel: AA.
    down: (ctx, source) => {
      ctx.scale(0.25, 0.25)
      ctx.drawImage(source, 21, 22, 2, 60)
    },
  }
  for (const [name, source] of [
    ['canvas', src],
    ['image', image],
  ] as const) {
    for (const [transform, draw] of Object.entries(transforms)) {
      for (const op of [
        'source-over',
        'copy',
        'source-in',
        'source-out',
        'destination-in',
        'destination-atop',
      ] as const) {
        const ctx = createCanvas(24, 24).getContext('2d')
        ctx.fillStyle = 'rgb(200,120,40)'
        ctx.fillRect(3, 3, 18, 18)
        ctx.imageSmoothingEnabled = false
        ctx.globalCompositeOperation = op
        draw(ctx, source)
        t.deepEqual(alphaOf(px(ctx, 0, 0, 24, 24)), chrome(`aa-op|${transform}|${op}`), `${name} ${transform} ${op}`)
      }
    }
  }
})

// Blink AdjustRectForCanvas: a negative width or height moves the rect's
// origin; the image is not mirrored.
test('drawImage normalises negative sizes instead of mirroring', async (t) => {
  // column i is rgb(i * 25, 0, 255 - i * 25)
  const src = grid(10, 10, (i) => `rgb(${i * 25},0,${255 - i * 25})`)
  const image = await imageFrom(src)
  for (const [name, source] of [
    ['canvas', src],
    ['image', image],
  ] as const) {
    let ctx = createCanvas(64, 64).getContext('2d')
    ctx.drawImage(source, 30, 20, -10, 10)
    t.deepEqual(px(ctx, 20, 25), [0, 0, 255, 255], `${name} negative dw`)
    t.deepEqual(px(ctx, 29, 25), [225, 0, 30, 255], `${name} negative dw`)

    ctx = createCanvas(64, 64).getContext('2d')
    ctx.drawImage(source, 30, 20, 10, -10)
    t.deepEqual(px(ctx, 30, 15), [0, 0, 255, 255], `${name} negative dh`)
    t.deepEqual(px(ctx, 35, 25), [0, 0, 0, 0], `${name} negative dh`)

    ctx = createCanvas(64, 64).getContext('2d')
    ctx.drawImage(source, 0, 0, 10, 10, 30, 20, -10, -10)
    t.deepEqual(px(ctx, 25, 15), [125, 0, 130, 255], `${name} negative dw and dh`)

    ctx = createCanvas(64, 64).getContext('2d')
    ctx.drawImage(source, 10, 0, -10, 10, 30, 20, 10, 10)
    t.deepEqual(px(ctx, 35, 25), [125, 0, 130, 255], `${name} negative sw`)
  }
})

// Blink ClipRectsToImageRect: a source rect past the image is cut to it, and
// the AA rule then sees the cut destination, here under one pixel.
test('drawImage clips a source rect past the image before choosing AA', async (t) => {
  const src = grid(8, 8, (i, j) => `rgb(${i * 30},${j * 30},${(i + j) * 15})`)
  const image = await imageFrom(src)
  for (const [name, source] of [
    ['canvas', src],
    ['image', image],
  ] as const) {
    let ctx = createCanvas(32, 32).getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(source, 7.5, 0, 4, 8, 2, 2, 4, 16)
    t.deepEqual(px(ctx, 2, 2), [211, 0, 104, 127], `${name} half-pixel column`)
    t.deepEqual(px(ctx, 3, 2), [0, 0, 0, 0], `${name} half-pixel column`)

    ctx = createCanvas(32, 32).getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(source, 0, 7.6, 8, 4, 2, 2, 16, 3)
    t.deepEqual(px(ctx, 2, 2), [0, 211, 104, 76], `${name} 0.3-pixel row`)
    t.deepEqual(px(ctx, 2, 3), [0, 0, 0, 0], `${name} 0.3-pixel row`)
  }
})

// Blink's draw looper folds shadowColor into the paint with one float product
// (SkColorFilters::Blend(shadowColor4f, kSrcIn) + RemoveColorFilter):
// alpha = round(byte(sa) / 255 * byte(fa) / 255 * ga * 255).
test('shadow alpha folds shadowColor, fillStyle and globalAlpha with one rounding', (t) => {
  const one = createCanvas(1, 1).getContext('2d')
  one.globalAlpha = 0.7
  one.shadowOffsetY = 100
  one.shadowColor = 'rgba(200,100,50,0.7)'
  one.fillStyle = 'rgba(9,9,9,1)'
  one.fillRect(0, -100, 1, 1)
  t.deepEqual(px(one, 0, 0), [200, 100, 51, 125])

  const SA = [0.3, 0.7, 0.1, 0.9, 0.55, 0.45, 0.5, 0.25, 0.35, 0.65]
  const GA = [1, 0.5, 0.3, 0.7, 0.9, 0.25]
  const FA = [1, 0.5, 0.3, 0.7]
  const ctx = createCanvas(SA.length * GA.length, FA.length).getContext('2d')
  ctx.shadowOffsetY = 100
  const expected: number[] = []
  const byte = (v: number) => Math.round(v * 255)
  FA.forEach((fa, j) =>
    SA.forEach((sa, i) =>
      GA.forEach((ga, k) => {
        ctx.globalAlpha = ga
        ctx.shadowColor = `rgba(200,100,50,${sa})`
        ctx.fillStyle = `rgba(9,9,9,${fa})`
        ctx.fillRect(i * GA.length + k, j - 100, 1, 1)
        expected.push(Math.round((((byte(sa) / 255) * byte(fa)) / 255) * ga * 255))
      }),
    ),
  )
  t.deepEqual(alphaOf(px(ctx, 0, 0, SA.length * GA.length, FA.length)), expected)
})

// Patterns carry the float globalAlpha (drawImage keeps Blink's byte-rounded
// one). At globalAlpha = (k + 0.5) / 255 Chrome's legacy blitter (repeat) gives
// alpha k + 1; its raster pipeline (repeat-x) alternates k and k + 1.
test('pattern fills keep the float globalAlpha', (t) => {
  const tile = createCanvas(4, 4)
  const tctx = tile.getContext('2d')
  tctx.fillStyle = 'rgb(32,128,223)'
  tctx.fillRect(0, 0, 4, 4)
  const ties = (draw: (ctx: SKRSContext2D, k: number) => void, repetition?: string) => {
    const ctx = createCanvas(255, 1).getContext('2d')
    if (repetition) ctx.fillStyle = ctx.createPattern(tile, repetition)
    for (let k = 0; k < 255; k++) {
      ctx.globalAlpha = (k + 0.5) / 255
      draw(ctx, k)
    }
    return px(ctx, 0, 0, 255, 1)
  }
  const fill = (ctx: SKRSContext2D, k: number) => ctx.fillRect(k, 0, 1, 1)
  const at = (data: number[], k: number) => data.slice(k * 4, k * 4 + 4)

  const repeatX = ties(fill, 'repeat-x')
  t.deepEqual(at(repeatX, 2), [0, 128, 255, 2])
  t.deepEqual(at(repeatX, 76), [34, 128, 225, 76])
  t.deepEqual(
    alphaOf(repeatX),
    Array.from({ length: 255 }, (_, k) => (k % 2 ? k + 1 : k)),
  )

  const repeat = ties(fill, 'repeat')
  t.deepEqual(at(repeat, 76), [30, 129, 222, 77])
  t.deepEqual(
    alphaOf(repeat),
    Array.from({ length: 255 }, (_, k) => k + 1),
  )

  const drawImage = ties((ctx, k) => ctx.drawImage(tile, k, 0, 1, 1))
  t.deepEqual(at(drawImage, 2), [0, 170, 255, 3])
  t.deepEqual(
    alphaOf(drawImage),
    Array.from({ length: 255 }, (_, k) => k + 1),
  )
})

// Texel (i, j) of the source is rgb(40i + 20, 40j + 20, 200); returns "ij" per pixel.
function texels(ctx: SKRSContext2D, w: number, h: number): string[] {
  const data = px(ctx, 0, 0, w, h)
  const rows: string[] = []
  for (let y = 0; y < h; y++) {
    const row: string[] = []
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4
      row.push(`${Math.round((data[k] - 20) / 40)}${Math.round((data[k + 1] - 20) / 40)}`)
    }
    rows.push(row.join(' '))
  }
  return rows
}

// Repeat/repeat nearest patterns of at least 2x2 drawn src-over take Skia's
// legacy SkBitmapProcState in Chrome. It rounds an exact texel tie down before
// it wraps (SkBitmapProcState.h), so u = k * w picks texel w - 1. Other cases
// take the raster pipeline, which wraps first and picks texel 0.
test('nearest repeat pattern picks the texel at an exact tie like Chrome', (t) => {
  const two = grid(2, 2, (i, j) => ['#ff0000', '#00ff00', '#0000ff', '#ffffff'][j * 2 + i])
  const red = [255, 0, 0, 255]
  const green = [0, 255, 0, 255]
  const blue = [0, 0, 255, 255]
  const white = [255, 255, 255, 255]
  const expected = [...white, ...blue, ...white, ...blue, ...green, ...red, ...green, ...red]

  let ctx = createCanvas(4, 2).getContext('2d')
  ctx.imageSmoothingEnabled = false
  let pattern = ctx.createPattern(two, 'repeat')
  pattern.setTransform(new DOMMatrix([1, 0, 0, 1, 0.5, 0.5]))
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, 4, 2)
  t.deepEqual(px(ctx, 0, 0, 4, 2), expected, 'pattern transform')

  ctx = createCanvas(4, 2).getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = ctx.createPattern(two, 'repeat')
  ctx.translate(0.5, 0.5)
  ctx.fillRect(-0.5, -0.5, 4, 2)
  t.deepEqual(px(ctx, 0, 0, 4, 2), expected, 'CTM')

  const four = grid(4, 4, (i, j) => `rgb(${40 * i + 20},${40 * j + 20},200)`)
  const legacy = [
    '33 03 13 23 33 03 13 23',
    '30 00 10 20 30 00 10 20',
    '31 01 11 21 31 01 11 21',
    '32 02 12 22 32 02 12 22',
  ]
  const pipeline = [
    '00 00 10 20 00 00 10 20',
    '00 00 10 20 00 00 10 20',
    '01 01 11 21 01 01 11 21',
    '02 02 12 22 02 02 12 22',
  ]
  for (const [op, rows] of [
    ['source-over', legacy],
    ['multiply', pipeline],
    ['copy', pipeline],
  ] as const) {
    ctx = createCanvas(8, 4).getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.globalCompositeOperation = op
    pattern = ctx.createPattern(four, 'repeat')
    pattern.setTransform(new DOMMatrix([1, 0, 0, 1, 0.5, 0.5]))
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, 8, 4)
    t.deepEqual(texels(ctx, 8, 4), rows, op)
  }

  // A one-pixel-high source takes the raster pipeline.
  const strip = grid(4, 1, (i) => `rgb(${40 * i + 20},20,200)`)
  ctx = createCanvas(8, 2).getContext('2d')
  ctx.imageSmoothingEnabled = false
  pattern = ctx.createPattern(strip, 'repeat')
  pattern.setTransform(new DOMMatrix([1, 0, 0, 1, 0.5, 0.5]))
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, 8, 2)
  t.deepEqual(texels(ctx, 8, 2), ['00 00 10 20 00 00 10 20', '00 00 10 20 00 00 10 20'])
})

// 'low' repeat/repeat patterns use the legacy bilerp (4-bit weights) in
// Chrome; repeat-x stays on the raster pipeline.
test("'low' pattern bilerp matches Chrome", (t) => {
  const texture = noise(8, 8, 4242)
  for (const repetition of ['repeat', 'repeat-x']) {
    const ctx = createCanvas(8, 8).getContext('2d')
    ctx.imageSmoothingQuality = 'low'
    const pattern = ctx.createPattern(texture, repetition)
    pattern.setTransform(new DOMMatrix([1.5, 0, 0, 1.5, 0.3, 0.7]))
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, 8, 8)
    t.deepEqual(px(ctx, 0, 0, 8, 8), chrome(`low|${repetition}`), repetition)
  }
})

// Chrome draws 'copy' with kSrc straight onto the cleared canvas, which Skia
// blits with its raster pipeline, not with the legacy src-over blitters.
test("'copy' draws round like Chrome's kSrc blit", (t) => {
  const solid: number[] = []
  for (let x = 0; x < 64; x++) {
    const ctx = createCanvas(1, 1).getContext('2d')
    ctx.globalCompositeOperation = 'copy'
    ctx.globalAlpha = 0.3
    const v = x * 4
    ctx.fillStyle = `rgba(${v},${255 - v},${(v * 37) & 255},0.1)`
    ctx.fillRect(0, 0, 1, 1)
    solid.push(...px(ctx, 0, 0))
  }
  t.deepEqual(solid, chrome('copy-solid|a0.1|ga0.3'))

  const src = grid(8, 8, (i, j) => `rgb(${i * 30},${j * 30},${(i + j) * 15})`)
  const ctx = createCanvas(24, 24).getContext('2d')
  ctx.globalCompositeOperation = 'copy'
  ctx.globalAlpha = 0.5
  ctx.imageSmoothingQuality = 'low'
  ctx.drawImage(src, 0, 0, 20, 20)
  t.deepEqual(px(ctx, 0, 0, 24, 24), chrome('copy-drawimage|low|ga0.5'))
})
