// How Chrome samples the images it draws. Expected values are Chrome 155's CPU
// canvas (--disable-gpu, willReadFrequently: true). The larger byte arrays live
// in fixtures/chrome-cpu-image-levels.json (base64).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, type Canvas, type SKRSContext2D } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const CHROME: Record<string, string> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'chrome-cpu-image-levels.json'), 'utf8'),
)

function chrome(key: string): number[] {
  return Array.from(Buffer.from(CHROME[key], 'base64'))
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
