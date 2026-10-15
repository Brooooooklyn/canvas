// Images on float16 canvases. Chrome decodes a high-bit-depth image to half
// floats for a float16 canvas, and every other image to 8 bits.
// Values: Chrome 155 (fixtures/float16/chrome-pins.json, see float16-helpers.ts).
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'

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
const fixtureUrl = (name: string) => new URL(`./fixtures/float16/${name}`, import.meta.url)
const fixture = (name: string) => readFileSync(fixtureUrl(name))

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

// Chrome keeps half-float decodes in its software decode cache, which purges
// the least recently used past 512 MiB, and decodes a purged image again at
// its next draw. Each 4096x4096 decode is 128 MiB, so the 6 below (3 Images,
// sRGB and display-p3) do not all fit: the first ones are decoded again, with
// the same pixels. They used to be kept for as long as their Image. A pattern
// keeps the decode it samples.
test('half-float decodes past 512 MiB are made again at the next draw', async (t) => {
  const script = `
    const { createCanvas, Image } = require(${JSON.stringify(fileURLToPath(new URL('../index.js', import.meta.url)))})
    const zlib = require('node:zlib')
    // A 4096x4096 16-bit RGBA PNG: a red ramp along x, the same on every row.
    const size = 4096
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
      return n >>> 0
    })
    const crc32 = (bytes) => {
      let c = 0xffffffff
      for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8)
      return (c ^ 0xffffffff) >>> 0
    }
    const chunk = (type, data) => {
      const body = Buffer.concat([Buffer.from(type), data])
      const out = Buffer.alloc(body.length + 8)
      out.writeUInt32BE(data.length, 0)
      body.copy(out, 4)
      out.writeUInt32BE(crc32(body), body.length + 4)
      return out
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(size, 0)
    ihdr.writeUInt32BE(size, 4)
    ihdr[8] = 16
    ihdr[9] = 6
    const stride = 1 + size * 8
    // Row 0 has filter None; the other rows have filter Up and all-zero data.
    const raw = Buffer.alloc(stride * size, 0)
    for (let x = 0; x < size; x++) {
      raw.writeUInt16BE(x * 16, 1 + x * 8)
      raw.writeUInt16BE(0x8000, 3 + x * 8)
      raw.writeUInt16BE(0x1234, 5 + x * 8)
      raw.writeUInt16BE(0xc000, 7 + x * 8)
    }
    for (let y = 1; y < size; y++) raw[y * stride] = 2
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
    const draw = (image, colorSpace) => {
      const ctx = createCanvas(4, 2).getContext('2d', { colorType: 'float16', colorSpace })
      const start = process.hrtime.bigint()
      ctx.drawImage(image, -1000, -7)
      const ms = Number(process.hrtime.bigint() - start) / 1e6
      return { ms, pixels: Array.from(ctx.getImageData(0, 0, 4, 2, { pixelFormat: 'rgba-float32' }).data) }
    }
    const fill = (pattern) => {
      const ctx = createCanvas(4, 2).getContext('2d', { colorType: 'float16', colorSpace: 'display-p3' })
      ctx.fillStyle = pattern
      ctx.translate(-1000, -7)
      ctx.fillRect(1000, 7, 4, 2)
      return JSON.stringify(Array.from(ctx.getImageData(0, 0, 4, 2, { pixelFormat: 'rgba-float32' }).data))
    }
    ;(async () => {
      const images = []
      for (let i = 0; i < 3; i++) {
        const image = new Image()
        image.src = Buffer.from(png)
        await image.decode()
        images.push(image)
      }
      const pattern = createCanvas(1, 1).getContext('2d').createPattern(images[0], 'repeat')
      const filled = fill(pattern)
      const first = {}
      for (const [i, image] of images.entries()) {
        for (const colorSpace of ['srgb', 'display-p3']) first[i + colorSpace] = draw(image, colorSpace)
      }
      // The most recently used decode is kept.
      const cachedMs = Math.min(...[0, 1, 2].map(() => draw(images[2], 'display-p3').ms))
      // The least recently used one is decoded again.
      const again = draw(images[0], 'srgb')
      console.log(JSON.stringify({
        decodeMs: first['0srgb'].ms,
        cachedMs,
        againMs: again.ms,
        same: JSON.stringify(again.pixels) === JSON.stringify(first['0srgb'].pixels),
        p3: JSON.stringify(draw(images[0], 'display-p3').pixels) === JSON.stringify(first['0display-p3'].pixels),
        pattern: fill(pattern) === filled,
        pixels: again.pixels.slice(0, 4),
      }))
    })().catch((error) => {
      console.error(error)
      process.exit(1)
    })
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', script], { maxBuffer: 1 << 20 })
  const out = JSON.parse(stdout)
  t.true(out.same && out.p3 && out.pattern, `a decode made again has the same pixels: ${JSON.stringify(out)}`)
  t.true(out.pixels[0] > 0.2 && out.pixels[0] < 0.3 && out.pixels[3] > 0.7, JSON.stringify(out.pixels))
  t.true(
    out.againMs > out.decodeMs / 4 && out.againMs > 10 * out.cachedMs,
    `the least recently used decode was kept: ${JSON.stringify(out)}`,
  )
})

// Each worker keeps its own half-float decodes, and drops them as it exits.
test('workers draw 16-bit PNGs on float16 canvases and exit cleanly', async (t) => {
  const index = JSON.stringify(fileURLToPath(new URL('../index.js', import.meta.url)))
  const png = JSON.stringify(fileURLToPath(fixtureUrl('hbd-8x8.png')))
  const script = `
    const { createCanvas, loadImage } = require(${index})
    ;(async () => {
      const image = await loadImage(require('node:fs').readFileSync(${png}))
      const out = []
      for (const colorSpace of ['srgb', 'display-p3']) {
        const ctx = createCanvas(8, 8).getContext('2d', { colorType: 'float16', colorSpace })
        ctx.drawImage(image, 0, 0)
        ctx.fillStyle = ctx.createPattern(image, 'repeat')
        ctx.fillRect(4, 4, 4, 4)
        out.push(Array.from(ctx.getImageData(0, 0, 8, 8, { pixelFormat: 'rgba-float32' }).data))
      }
      require('node:worker_threads').parentPort.postMessage(out)
    })()
  `
  const run = () =>
    new Promise<{ pixels: unknown; code: number }>((resolve, reject) => {
      let pixels: unknown
      const worker = new Worker(script, { eval: true })
      worker.on('message', (out) => (pixels = out))
      worker.on('error', reject)
      worker.on('exit', (code) => resolve({ pixels, code }))
    })
  const image = await loadImage(fixture('hbd-8x8.png'))
  const main = []
  for (const colorSpace of ['srgb', 'display-p3']) {
    const c = ctx(8, 8, { colorType: 'float16', colorSpace })
    c.drawImage(image, 0, 0)
    c.fillStyle = c.createPattern(image, 'repeat')!
    c.fillRect(4, 4, 4, 4)
    main.push(f32(c, 0, 0, 8, 8))
  }
  const workers = await Promise.all([run(), run(), run()])
  for (const { pixels, code } of workers) {
    t.is(code, 0)
    t.deepEqual(pixels, main)
  }
})
