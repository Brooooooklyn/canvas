// Images on float16 canvases. Chrome decodes a high-bit-depth image to half
// floats for a float16 canvas, and every other image to 8 bits.
// Values: Chrome 155 (fixtures/float16/chrome-pins.json, see float16-helpers.ts).
import { readFileSync } from 'node:fs'

import test from 'ava'

import { loadImage } from '../index'

import { F16, arr, chromeEqual, ctx } from './float16-helpers'

const loose = (value: unknown) => value as any
const F16P3 = { colorType: 'float16', colorSpace: 'display-p3' }

// 2x1 RGBA PNGs: 16-bit [0x8000,0x4000,0xffff,0xffff, 0x1234,0xabcd,0x0100,0x8000]
// and 8-bit [200,100,50,128, 10,20,30,255].
const png16 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABEAYAAACksqPJAAAAGUlEQVR4nGNoYHBg+P///38hk9VnGRkaGABAagb8Zk4jSwAAAABJRU5ErkJggg=='
const png8 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGM4kWLUwCUi9x8ADlADGpXP8icAAAAASUVORK5CYII='

const DEST = { u8: {}, f16: F16, f16p3: F16P3 }
const fixture = (name: string) => readFileSync(new URL(`./fixtures/float16/${name}`, import.meta.url))

const f32 = (c: any, x: number, y: number, w: number, h: number) =>
  arr(c.getImageData(x, y, w, h, loose({ pixelFormat: 'rgba-float32' })).data)

test('a 16-bit PNG keeps 16 bits on a float16 canvas', async (t) => {
  const img = await loadImage(png16)
  const M1: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ u8: {}, f16: F16 })) {
    const c = ctx(2, 1, o)
    c.drawImage(img, 0, 0)
    M1[k] = { f32: f32(c, 0, 0, 2, 1), u8: arr(c.getImageData(0, 0, 2, 1).data) }
  }
  chromeEqual(t, M1, 'M1-16bit-png-drawn')

  const H1: Record<string, unknown> = {}
  for (const name of ['hbd-4x1.png', 'hbd-8x8.png']) {
    const image = await loadImage(fixture(name))
    for (const [dk, dopts] of Object.entries(DEST)) {
      const c = ctx(image.width, image.height, dopts)
      c.drawImage(image, 0, 0)
      const n = Math.min(image.width, 4)
      H1[name + '-' + dk] = { f32: f32(c, 0, 0, n, 1), u8: arr(c.getImageData(0, 0, n, 1).data) }
    }
  }
  chromeEqual(t, H1, 'H1-hbd-fixtures')
})

// Each image is new to the decode cache: Chrome's shared cache can scale a
// draw's decode from an earlier draw of the image on another colour space
// (SoftwareImageDecodeCache::FindCachedCandidate does not compare them).
test('medium-quality downscale of a 16-bit PNG decodes per canvas', async (t) => {
  const down = async (dk: keyof typeof DEST, fullFirst: boolean) => {
    const image = await loadImage(fixture('hbd-8x8.png'))
    if (fullFirst) ctx(8, 8, DEST[dk]).drawImage(image, 0, 0)
    const sm = ctx(4, 4, DEST[dk])
    sm.imageSmoothingQuality = 'medium'
    sm.drawImage(image, 0, 0, 3, 3)
    return f32(sm, 1, 1, 1, 1)
  }
  const H2: Record<string, unknown> = {}
  for (const dk of Object.keys(DEST) as (keyof typeof DEST)[]) H2[dk + '-down'] = await down(dk, false)
  for (const dk of Object.keys(DEST) as (keyof typeof DEST)[]) H2[dk + '-full-then-down'] = await down(dk, true)
  chromeEqual(t, H2, 'H2-hbd-down-fresh')
})

test('scaled draws and patterns of a 16-bit PNG on float16', async (t) => {
  const img = await loadImage(png16)
  const X3: Record<string, unknown> = {}
  const c = ctx(2, 1, F16P3)
  c.drawImage(img, 0, 0)
  X3['draw-f16p3'] = f32(c, 0, 0, 2, 1)
  for (const [dk, dopts] of Object.entries({ u8: {}, f16: F16 })) {
    const p = ctx(2, 2, dopts)
    p.fillStyle = p.createPattern(img, 'repeat')!
    p.fillRect(0, 0, 2, 2)
    X3['pattern-' + dk] = f32(p, 0, 1, 2, 1)
    const big = ctx(4, 2, dopts)
    big.imageSmoothingQuality = 'high'
    big.drawImage(img, 0, 0, 4, 2)
    X3['up-' + dk] = f32(big, 0, 0, 4, 1)
  }
  chromeEqual(t, X3, 'X3-png16-variants')
})

test('8-bit PNGs on float16 and display-p3', async (t) => {
  const img = await loadImage(png8)
  const M2: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ u8: {}, f16: F16 })) {
    const c = ctx(2, 1, o)
    c.drawImage(img, 0, 0)
    M2[k] = { f32: f32(c, 0, 0, 2, 1), u8: arr(c.getImageData(0, 0, 2, 1).data) }
  }
  chromeEqual(t, M2, 'M2-8bit-png-drawn-translucent')
  const M3: Record<string, unknown> = {}
  for (const [dk, dopts] of Object.entries({ u8p3: { colorSpace: 'display-p3' }, f16p3: F16P3 })) {
    const c = ctx(2, 1, dopts)
    c.drawImage(img, 0, 0)
    M3[dk] = { f32: f32(c, 0, 0, 2, 1), u8: arr(c.getImageData(0, 0, 2, 1).data) }
  }
  chromeEqual(t, M3, 'M3-8bit-translucent-png-on-p3')
})
