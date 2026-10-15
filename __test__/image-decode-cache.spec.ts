// Chrome draws an Image element (a lazily decoded image) from its software
// decode cache (cc/tiles/software_image_decode_cache.cc): the image decoded
// into the canvas's colour space, scaled down to the mip level the draw needs,
// then sampled linearly at every smoothing quality. On an sRGB canvas, canvas
// sources skip that step. Expected values are Chrome 155's CPU canvas
// (--disable-gpu, willReadFrequently: true), each case drawn from a fresh
// Image so that Chrome's cache is cold: we match the cold cache only, as
// Chrome builds a level from the smallest decode it has cached, so with a warm
// cache its output can depend on earlier draws. The larger byte arrays live in
// fixtures/chrome-cpu-image-levels.json (base64).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import test, { type ExecutionContext } from 'ava'

import { createCanvas, loadImage, DOMMatrix, ImageData, SvgExportFlag, type Canvas, type SKRSContext2D } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const CHROME: Record<string, string> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'chrome-cpu-image-levels.json'), 'utf8'),
)

function chrome(key: string): number[] {
  return Array.from(Buffer.from(CHROME[key], 'base64'))
}

// Rotated draws differ between Chrome's own arm64 and x64 builds.
function chromeForArch(key: string): number[] {
  return chrome(`${key}|${process.arch === 'arm64' ? 'arm64' : 'x64'}`)
}

// On x64 a rotated draw runs in Skia's raster pipeline, and Chrome's output
// there depends on the CPU: on AVX2+FMA CPUs SkOpts swaps in the ml3/ml4
// stages, whose mad() is a fused multiply-add. `x64` is Chrome 155 without
// AVX (x64 under Rosetta), `x64-fma` the same Chrome on an AVX2+FMA CPU.
// We pass when we match Chrome on either CPU.
function chromeForCpu(key: string): number[][] {
  return process.arch === 'arm64' ? [chrome(`${key}|arm64`)] : [chrome(`${key}|x64`), chrome(`${key}|x64-fma`)]
}

function deepEqualOneOf(t: ExecutionContext, actual: number[], expected: number[][], message: string) {
  t.deepEqual(actual, expected.find((e) => isDeepStrictEqual(actual, e)) ?? expected[0], message)
}

const QUALITIES = ['off', 'low', 'medium', 'high'] as const
type Quality = (typeof QUALITIES)[number]

function px(ctx: SKRSContext2D, x: number, y: number, w = 1, h = 1): number[] {
  return Array.from(ctx.getImageData(x, y, w, h).data)
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

type Source = Parameters<SKRSContext2D['drawImage']>[0]

function draw(size: number, quality: Quality, source: Source, fn: (ctx: SKRSContext2D, source: Source) => void) {
  const ctx = createCanvas(size, size).getContext('2d')
  if (quality === 'off') {
    ctx.imageSmoothingEnabled = false
  } else {
    ctx.imageSmoothingQuality = quality
  }
  fn(ctx, source)
  return px(ctx, 0, 0, size, size)
}

type PatternSource = Parameters<SKRSContext2D['createPattern']>[0]

function fillPattern(
  size: number,
  quality: Quality,
  source: PatternSource,
  setup: (ctx: SKRSContext2D, pattern: ReturnType<SKRSContext2D['createPattern']>) => void,
  repetition = 'repeat',
) {
  const ctx = createCanvas(size, size).getContext('2d')
  if (quality === 'off') {
    ctx.imageSmoothingEnabled = false
  } else {
    ctx.imageSmoothingQuality = quality
  }
  const pattern = ctx.createPattern(source, repetition)
  setup(ctx, pattern)
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, size, size)
  return px(ctx, 0, 0, size, size)
}

const scale = (sx: number, sy = sx, e = 0, f = 0) => new DOMMatrix([sx, 0, 0, sy, e, f])

const gradient64 = () => grid(64, 64, (x, y) => `rgb(${(x * 4) & 255},${(y * 4) & 255},${((x ^ y) * 4) & 255})`)
const gradient8 = () => grid(8, 8, (x, y) => `rgb(${x * 30},${y * 30},${(x + y) * 15})`)

// cc MatrixToScalingOperation + FilterQualityToSkSamplingOptions: 'medium'
// blends two mip levels, and 'high' is cubic only when both axes scale up.
test('drawImage of a canvas samples like Chrome at medium and high', (t) => {
  const source = gradient64()
  for (const quality of ['medium', 'high'] as const) {
    const data = draw(24, quality, source, (ctx, s) => ctx.drawImage(s, 0, 0, 20, 20))
    t.deepEqual(data.slice((10 * 24 + 10) * 4, (10 * 24 + 10) * 4 + 4), [132, 132, 13, 255], quality)
    t.deepEqual(data, chrome('canvas|down-64-20|medium'), quality)
  }
})

test('drawImage of an Image draws its decode level at every quality', async (t) => {
  const image = await imageFrom(gradient64())
  for (const quality of ['low', 'medium', 'high'] as const) {
    const data = draw(24, quality, image, (ctx, s) => ctx.drawImage(s, 0, 0, 20, 20))
    t.deepEqual(data.slice((10 * 24 + 10) * 4, (10 * 24 + 10) * 4 + 4), [132, 132, 5, 255], quality)
    t.deepEqual(data, chrome('image|down-64-20'), quality)
  }
  // 'off' samples the original image, nearest.
  t.deepEqual(
    draw(24, 'off', image, (ctx, s) => ctx.drawImage(s, 0, 0, 20, 20)),
    chrome('image|down-64-20|off'),
  )
})

// The decode is sampled linearly, so 'high' is not cubic for an Image.
test('drawImage scales an Image up linearly at every quality', async (t) => {
  const image = await imageFrom(gradient8())
  for (const quality of ['low', 'medium', 'high'] as const) {
    const data = draw(32, quality, image, (ctx, s) => ctx.drawImage(s, 0.3, 0.6, 27, 27))
    t.deepEqual(data.slice((10 * 32 + 10) * 4, (10 * 32 + 10) * 4 + 4), [75, 71, 73, 255], quality)
    t.deepEqual(data, chrome('image|up-27'), quality)
  }
})

// The level is made from the rounded-out source rect, which is cut to the
// image first.
test('drawImage of an Image subset draws the level of that subset', async (t) => {
  const image = await imageFrom(noise(64, 64, 7))
  for (const quality of ['low', 'medium', 'high'] as const) {
    t.deepEqual(
      draw(24, quality, image, (ctx, s) => ctx.drawImage(s, 8.5, 4.25, 40, 44, 1, 2, 13, 11)),
      chrome('image|subset'),
      quality,
    )
    t.deepEqual(
      draw(24, quality, image, (ctx, s) => ctx.drawImage(s, -6, 3, 30, 30, 1, 1, 10, 10)),
      chrome('image|subset-past-edge'),
      quality,
    )
  }
})

// The level comes from the CTM too, also when the draw is composited through
// a layer ('copy').
test('drawImage picks the Image level from the transform', async (t) => {
  const image = await imageFrom(noise(64, 64, 7))
  for (const quality of ['low', 'medium', 'high'] as const) {
    t.deepEqual(
      draw(24, quality, image, (ctx, s) => {
        ctx.translate(22, 1)
        ctx.rotate(Math.PI / 2)
        ctx.scale(0.4, 0.25)
        ctx.drawImage(s, 0, 0)
      }),
      chromeForArch('image|ctm-rot90'),
      quality,
    )
    t.deepEqual(
      draw(24, quality, image, (ctx, s) => {
        ctx.fillStyle = 'rgb(200,120,40)'
        ctx.fillRect(0, 0, 24, 24)
        ctx.globalCompositeOperation = 'copy'
        ctx.scale(0.3, 0.45)
        ctx.drawImage(s, 0, 0)
      }),
      chrome('image|ctm-copy'),
      quality,
    )
  }
})

// A target size that rounds to 0 on an axis fails the decode, so Chrome draws
// nothing at any quality. A canvas source is drawn as it is.
test('drawImage of an Image whose target size rounds to 0 draws nothing', async (t) => {
  const source = gradient8()
  const image = await imageFrom(source)
  for (const quality of QUALITIES) {
    t.deepEqual(
      draw(8, quality, image, (ctx, s) => ctx.drawImage(s, 1, 1, 3.2, 0.2)),
      Array.from({ length: 8 * 8 * 4 }, () => 0),
      quality,
    )
    t.deepEqual(
      draw(8, quality, source, (ctx, s) => ctx.drawImage(s, 1, 1, 3.2, 0.2)),
      chrome(`canvas|empty-target|${quality}`),
      `canvas ${quality}`,
    )
  }
})

// A 16x16 canvas in `colorSpace`, with `fn` drawn on it.
function drawOn(
  colorSpace: 'srgb' | 'display-p3',
  quality: Quality,
  source: Source,
  fn: (ctx: SKRSContext2D, source: Source) => void,
) {
  const ctx = createCanvas(16, 16).getContext('2d', { colorSpace })
  if (quality === 'off') {
    ctx.imageSmoothingEnabled = false
  } else {
    ctx.imageSmoothingQuality = quality
  }
  fn(ctx, source)
  return px(ctx, 0, 0, 16, 16)
}

const down16 = (ctx: SKRSContext2D, s: Source) => ctx.drawImage(s, 0, 0, 10, 10)
const up16 = (ctx: SKRSContext2D, s: Source) => ctx.drawImage(s, 2, 2, 6, 6, 0.3, 0.6, 14, 14)
const pattern16 = (sx: number) => (ctx: SKRSContext2D, s: Source) => {
  const pattern = ctx.createPattern(s as PatternSource, 'repeat')
  pattern.setTransform(scale(sx, sx, 0.5, 0.25))
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, 16, 16)
}

// Chrome decodes an Image into the canvas's colour space before it scales it
// (DoDecodeImage with the key's target colour space), so levels, the original
// and patterns are sampled in the canvas's space. The Display P3 PNG is 32x32
// noise encoded by Chrome.
test('an Image in another colour space is converted before it is scaled', async (t) => {
  const p3png = Buffer.from(CHROME['asset|p3-noise-32.png'], 'base64')
  for (const quality of ['low', 'medium', 'high'] as const) {
    for (const [key, fn] of [
      ['down', down16],
      ['up', up16],
      ['pattern-0.3', pattern16(0.3)],
      ['pattern-1.5', pattern16(1.5)],
    ] as const) {
      t.deepEqual(
        drawOn('srgb', quality, await loadImage(p3png), fn),
        chrome(`p3image|srgb|${key}`),
        `P3 Image on sRGB, ${key} ${quality}`,
      )
    }
    for (const [key, fn] of [
      ['down', down16],
      ['up', up16],
      ['pattern-0.3', pattern16(0.3)],
    ] as const) {
      t.deepEqual(
        drawOn('display-p3', quality, await imageFrom(noise(32, 32, 5)), fn),
        chrome(`image|p3|${key}`),
        `sRGB Image on display-p3, ${key} ${quality}`,
      )
    }
  }
  t.deepEqual(drawOn('srgb', 'off', await loadImage(p3png), pattern16(0.3)), chrome('p3image|srgb|pattern-0.3|off'))
})

// On a canvas that is not sRGB, Chrome sends a canvas source through its
// decode cache too (SoftwareImageDecodeCache::UseCacheForDrawImage): it is
// converted, drawn from its decode levels, sampled linearly, and a target size
// that rounds to 0 draws nothing. drawCanvas into such a canvas draws the
// source's pixels the same way. On an sRGB canvas nothing changes (the tests
// above).
test('drawImage of a canvas on a display-p3 canvas draws its decode', (t) => {
  const source = noise(32, 32, 5)
  for (const quality of ['low', 'medium', 'high'] as const) {
    for (const [key, fn] of [
      ['down', down16],
      ['up', up16],
      ['sprite', (ctx: SKRSContext2D, s: Source) => ctx.drawImage(s, 16.3, 8.6, 12, 12, 1.5, 2.25, 13, 11)],
    ] as const) {
      t.deepEqual(drawOn('display-p3', quality, source, fn), chrome(`canvas|p3|${key}`), `${key} ${quality}`)
    }
    t.deepEqual(
      drawOn('display-p3', quality, source, (ctx, s) => ctx.drawCanvas(s as Canvas, 0, 0, 10, 10)),
      chrome('canvas|p3|down'),
      `drawCanvas ${quality}`,
    )
  }
  for (const quality of QUALITIES) {
    t.deepEqual(
      drawOn('display-p3', quality, source, (ctx, s) => ctx.drawImage(s, 1, 1, 3.2, 0.2)),
      Array.from({ length: 16 * 16 * 4 }, () => 0),
      `empty target ${quality}`,
    )
  }
})

// Chrome draws an SVG Image as vectors, never from the decode cache. We keep
// sampling the SVG's raster with the smoothing quality, as before: 'high' is
// cubic and an Image pattern's 'medium' takes a mip level, so neither matches
// 'low', as decode levels would.
test('SVG Images are not drawn from decode levels', async (t) => {
  const stripes = Array.from(
    { length: 32 },
    (_, i) => `<rect x="${i * 2}" width="1" height="64" fill="${['#f00', '#0f0', '#00f'][i % 3]}"/>`,
  ).join('')
  const image = await loadImage(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${stripes}</svg>`),
  )
  const drawn = (quality: Quality) => draw(24, quality, image, (ctx, s) => ctx.drawImage(s, 0, 0, 20, 20))
  t.notDeepEqual(drawn('high'), drawn('low'))
  const filled = (quality: Quality) => fillPattern(8, quality, image, (_, p) => p.setTransform(scale(0.3)))
  t.notDeepEqual(filled('medium'), filled('low'))
})

// The decode cache is a raster step: SVG (and PDF) output embeds the original
// image.
test('SVG export embeds the original Image, not a decode level', async (t) => {
  const image = await imageFrom(gradient64())
  const embedded = (fn: (ctx: SKRSContext2D) => void) => {
    const canvas = createCanvas(40, 40, SvgExportFlag.ConvertTextToPaths)
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingQuality = 'medium'
    fn(ctx)
    const sizes = Array.from(
      canvas
        .getContent()
        .toString()
        .matchAll(/data:image\/png;base64,([\w+/=]+)/g),
      ([, b64]) => {
        const png = Buffer.from(b64, 'base64')
        return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`
      },
    )
    return Array.from(new Set(sizes))
  }
  t.deepEqual(
    embedded((ctx) => ctx.drawImage(image, 0, 0, 16, 16)),
    ['64x64'],
  )
  t.deepEqual(
    embedded((ctx) => {
      const pattern = ctx.createPattern(image, 'repeat')
      pattern.setTransform(scale(0.25))
      ctx.fillStyle = pattern
      ctx.fillRect(0, 0, 40, 40)
    }),
    ['64x64'],
  )
})

const stripes = () => grid(8, 8, (x) => ['#ff0000', '#00ff00', '#0000ff', '#ffffff'][x % 4])

test('Image pattern whose target size rounds to 0 draws nothing', async (t) => {
  const source = grid(2, 2, (x, y) => ['#ff0000', '#00ff00', '#0000ff', '#ffffff'][y * 2 + x])
  const image = await imageFrom(source)
  for (const quality of QUALITIES) {
    t.deepEqual(
      fillPattern(8, quality, image, (_, p) => p.setTransform(scale(0.2))),
      Array.from({ length: 8 * 8 * 4 }, () => 0),
      quality,
    )
    t.deepEqual(
      fillPattern(8, quality, source, (_, p) => p.setTransform(scale(0.2))),
      chrome(`pattern|canvas|empty-target|${quality}`),
      `canvas ${quality}`,
    )
  }
})

// The empty pattern still paints, as transparent black: Chrome keeps the
// composite, so on a filled canvas 'copy' and 'destination-in' clear it and
// 'source-over' leaves it as it is, with a filter or a shadow too.
test('Image pattern whose target size rounds to 0 composites as transparent black', async (t) => {
  const image = await imageFrom(grid(2, 2, (x, y) => ['#ff0000', '#00ff00', '#0000ff', '#ffffff'][y * 2 + x]))
  const filled = Array.from({ length: 8 * 8 }, (_, i) => (i < 8 * 6 ? [20, 40, 200, 255] : [0, 0, 0, 0])).flat()
  const cleared = Array.from({ length: 8 * 8 * 4 }, () => 0)
  for (const quality of QUALITIES) {
    for (const [op, expected] of [
      ['source-over', filled],
      ['copy', cleared],
      ['destination-in', cleared],
    ] as const) {
      for (const [name, setup] of [
        ['plain', () => {}],
        ['filter', (ctx: SKRSContext2D) => (ctx.filter = 'blur(1px)')],
        [
          'shadow',
          (ctx: SKRSContext2D) => {
            ctx.shadowColor = 'red'
            ctx.shadowOffsetX = 2
            ctx.shadowOffsetY = 2
          },
        ],
      ] as const) {
        const ctx = createCanvas(8, 8).getContext('2d')
        ctx.fillStyle = 'rgb(20,40,200)'
        ctx.fillRect(0, 0, 8, 6)
        if (quality === 'off') {
          ctx.imageSmoothingEnabled = false
        } else {
          ctx.imageSmoothingQuality = quality
        }
        const pattern = ctx.createPattern(image, 'repeat')
        pattern.setTransform(scale(0.2))
        ctx.globalCompositeOperation = op
        setup(ctx)
        ctx.fillStyle = pattern
        ctx.fillRect(1, 1, 5, 5)
        t.deepEqual(px(ctx, 0, 0, 8, 8), expected, `${op} ${name} ${quality}`)
      }
    }
  }
})

test('downscaled Image pattern samples its decode level at every quality', async (t) => {
  const image = await imageFrom(stripes())
  for (const quality of ['low', 'medium', 'high'] as const) {
    t.deepEqual(
      fillPattern(4, quality, image, (_, p) => p.setTransform(scale(0.3))),
      Array.from({ length: 16 }, () => [127, 127, 127, 255]).flat(),
      quality,
    )
  }
})

test('upscaled Image pattern is the same at low, medium and high', async (t) => {
  const image = await imageFrom(noise(5, 5, 3))
  for (const quality of ['low', 'medium', 'high'] as const) {
    t.deepEqual(
      fillPattern(16, quality, image, (_, p) => p.setTransform(scale(3, 3, 0.3, 0.7))),
      chrome('pattern|up-3'),
      quality,
    )
  }
})

// cc multiplies the pattern matrix by the CTM in that order
// (PaintShader::CreateDecodedImage): under a rotation the level is not the one
// the composed transform would give.
test('Image pattern picks its level from the pattern matrix and the CTM', async (t) => {
  const image33 = await imageFrom(noise(33, 33, 11))
  const image64 = await imageFrom(noise(64, 64, 7))
  for (const quality of ['low', 'medium', 'high'] as const) {
    t.deepEqual(
      fillPattern(16, quality, image33, (ctx) => ctx.scale(0.3, 0.3)),
      chrome('pattern|ctm-scale'),
      quality,
    )
    deepEqualOneOf(
      t,
      fillPattern(16, quality, image64, (ctx, p) => {
        ctx.translate(16, 0)
        ctx.rotate(Math.PI / 2)
        ctx.scale(0.25, 0.6)
        p.setTransform(scale(2, 0.5))
      }),
      chromeForCpu('pattern|ctm-rot90'),
      quality,
    )
    t.deepEqual(
      fillPattern(16, quality, image33, (_, p) => p.setTransform(scale(0.3, 0.4, 1.5, 2.25)), 'no-repeat'),
      chrome('pattern|no-repeat'),
      quality,
    )
  }
})

test('Image pattern levels match Chrome across sizes', async (t) => {
  for (const [w, h] of [
    [3, 3],
    [7, 7],
    [17, 17],
    [33, 33],
    [40, 7],
    [5, 13],
  ]) {
    const image = await imageFrom(noise(w, h, w * 100 + h))
    for (const s of [0.6, 0.35, 0.26, 0.15, 0.07]) {
      t.deepEqual(
        fillPattern(8, 'medium', image, (_, p) => p.setTransform(scale(s))),
        chrome(`pattern|grid|${w}x${h}|${s}`),
        `${w}x${h} at ${s}`,
      )
    }
  }
})
