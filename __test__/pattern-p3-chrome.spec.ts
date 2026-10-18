// Canvas, ImageData and SVG Image patterns on a display-p3 canvas. Chrome draws
// every non-texture image through its software decode cache when the target
// colour space is not sRGB (cc/tiles/software_image_decode_cache.cc:538-560),
// so the pattern samples a decode level converted to display-p3. Every
// expected value was measured in Chrome 155 CPU canvas (--disable-gpu,
// willReadFrequently) on arm64 and x64; both give the same bytes. Chrome has no
// ImageData pattern: its values are those of createImageBitmap(imageData).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, DOMMatrix, ImageData, loadImage } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>
type Source = Parameters<Ctx['createPattern']>[0]

const px = (ctx: Ctx, x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data]

function noise(w: number, h: number, seed: number, alphaPattern = false) {
  const next = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = next()
    data[i * 4 + 1] = next()
    data[i * 4 + 2] = next()
    data[i * 4 + 3] = alphaPattern ? (i % 3 ? 255 : 128) : 255
  }
  return data
}

function sourceCanvas(seed: number, alpha: boolean, colorSpace?: 'display-p3') {
  const canvas = createCanvas(32, 32)
  const ctx = canvas.getContext('2d', colorSpace ? { colorSpace } : undefined)
  ctx.putImageData(new ImageData(noise(32, 32, seed, alpha), 32, 32), 0, 0)
  return canvas
}

type Quality = 'off' | 'low' | 'medium' | 'high'

// A 16x16 canvas filled with the pattern under setTransform([s,0,0,s,0.5,0.25]).
function fill(
  source: Source,
  quality: Quality,
  s: number,
  size: number,
  colorSpace: 'display-p3' | 'srgb' = 'display-p3',
) {
  const ctx = createCanvas(16, 16).getContext('2d', { colorSpace })
  if (quality === 'off') ctx.imageSmoothingEnabled = false
  else ctx.imageSmoothingQuality = quality
  const pattern = ctx.createPattern(source, 'repeat')!
  pattern.setTransform(new DOMMatrix([s, 0, 0, s, 0.5, 0.25]))
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, size, size)
  return ctx
}

test('a canvas pattern on a display-p3 canvas, smoothing off', (t) => {
  t.deepEqual(px(fill(sourceCanvas(5, false), 'off', 0.3, 16), 0, 9), [84, 28, 146, 255])
})

test('a canvas pattern on a display-p3 canvas, low', (t) => {
  const ctx = fill(sourceCanvas(5, false), 'low', 0.3, 16)
  t.deepEqual(px(ctx, 9, 5), [108, 129, 99, 255])
  t.deepEqual(
    [px(ctx, 0, 0), px(ctx, 3, 3), px(ctx, 7, 7), px(ctx, 12, 12)],
    [
      [132, 105, 149, 255],
      [164, 193, 131, 255],
      [111, 115, 139, 255],
      [141, 130, 129, 255],
    ],
  )
})

test('a canvas pattern on a display-p3 canvas, medium', (t) => {
  t.deepEqual(px(fill(sourceCanvas(5, false), 'medium', 0.3, 16), 10, 8), [152, 167, 140, 255])
})

test('a canvas pattern on a display-p3 canvas, high', (t) => {
  t.deepEqual(px(fill(sourceCanvas(5, false), 'high', 1.5, 16), 15, 2), [158, 140, 183, 255])
})

test('an ImageData pattern on a display-p3 canvas', (t) => {
  const data = new ImageData(noise(32, 32, 5, true), 32, 32)
  t.deepEqual(px(fill(data, 'off', 0.3, 24), 0, 9), [84, 28, 146, 255])
  t.deepEqual(px(fill(data, 'low', 1.5, 24), 15, 2), [175, 108, 180, 191])
})

test('a display-p3 canvas pattern on a display-p3 canvas', (t) => {
  t.deepEqual(px(fill(sourceCanvas(9, true, 'display-p3'), 'low', 0.3, 24), 11, 11), [100, 111, 141, 203])
})

test('a canvas pattern keeps the source as it was at createPattern', (t) => {
  const source = sourceCanvas(5, false)
  const ctx = createCanvas(16, 16).getContext('2d', { colorSpace: 'display-p3' })
  ctx.imageSmoothingQuality = 'low'
  const pattern = ctx.createPattern(source, 'repeat')!
  pattern.setTransform(new DOMMatrix([0.3, 0, 0, 0.3, 0.5, 0.25]))
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, 8, 16)
  const sourceCtx = source.getContext('2d')
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(0, 0, 32, 32)
  ctx.fillRect(8, 0, 8, 16)
  t.deepEqual(
    [px(ctx, 3, 5), px(ctx, 9, 5), px(ctx, 12, 12)],
    [
      [139, 140, 123, 255],
      [108, 129, 99, 255],
      [141, 130, 129, 255],
    ],
  )
})

test('an SVG Image pattern on a display-p3 canvas', async (t) => {
  const image = await loadImage(readFileSync(join(__dirname, 'fixtures', 'compositing', 'stripes.svg')))
  const at = (ctx: Ctx) => [px(ctx, 0, 3), px(ctx, 2, 7), px(ctx, 5, 6), px(ctx, 11, 12)]
  t.deepEqual(at(fill(image, 'low', 0.3, 16)), [
    [152, 126, 129, 255],
    [92, 37, 80, 255],
    [107, 45, 41, 255],
    [72, 140, 146, 255],
  ])
  t.deepEqual(at(fill(image, 'off', 0.3, 16)), [
    [93, 197, 103, 255],
    [110, 24, 33, 255],
    [110, 24, 33, 255],
    [93, 197, 103, 255],
  ])
  t.deepEqual(at(fill(image, 'low', 1.5, 16)), [
    [152, 126, 129, 255],
    [211, 55, 156, 255],
    [93, 197, 103, 255],
    [44, 59, 212, 255],
  ])
})

// The sRGB canvas keeps drawing the pattern image as it is (base already
// equal to Chrome).
test('a canvas pattern on an sRGB canvas is unchanged', (t) => {
  const source = sourceCanvas(5, false)
  t.deepEqual(px(fill(source, 'off', 0.3, 16, 'srgb'), 0, 9), [92, 23, 152, 255])
  t.deepEqual(px(fill(source, 'low', 1.5, 16, 'srgb'), 15, 2), [117, 122, 185, 255])
})
