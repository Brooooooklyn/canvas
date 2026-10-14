// Chrome draws an Image element (a lazily decoded image) from its software
// decode cache (cc/tiles/software_image_decode_cache.cc): the image scaled down
// to the mip level the draw needs, then sampled linearly at every smoothing
// quality. Canvas sources skip that step. Expected values are Chrome 155's CPU
// canvas (--disable-gpu, willReadFrequently: true), each case drawn from a
// fresh Image so that Chrome's cache is cold. The larger byte arrays live in
// fixtures/chrome-cpu-image-levels.json (base64).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, loadImage, ImageData, SvgExportFlag, type Canvas, type SKRSContext2D } from '../index'

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

const gradient64 = () => grid(64, 64, (x, y) => `rgb(${(x * 4) & 255},${(y * 4) & 255},${((x ^ y) * 4) & 255})`)
const gradient8 = () => grid(8, 8, (x, y) => `rgb(${x * 30},${y * 30},${(x + y) * 15})`)

// cc MatrixToScalingOperation + FilterQualityToSkSamplingOptions: 'medium'
// blends two mip levels, and 'high' is cubic only when both axes scale up.
test('drawImage of a canvas samples like Chrome for each quality', (t) => {
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
})
