// Encoding float16 canvases. Chrome's toDataURL encodes an unpremultiplied
// readback of the canvas (image_data_buffer.cc), toBlob and convertToBlob the
// premultiplied pixels (canvas_async_blob_creator.cc); a float16 PNG is 16-bit.
// Values: Chrome 155 (fixtures/float16/chrome-pins.json, see float16-helpers.ts).
import { createHash } from 'node:crypto'

import test from 'ava'

import { createCanvas, type Canvas } from '../index'

import { chromeEqual, chromeFor, pngSamples } from './float16-helpers'

const loose = (value: unknown) => value as any

/** The pin form of encoded bytes: PNG samples, or the sha256 of the rest. */
function encoded(bytes: Uint8Array) {
  if (bytes[1] === 0x50 && bytes[2] === 0x4e) return { png: pngSamples(bytes) }
  return { sha256: createHash('sha256').update(bytes).digest('hex') }
}
const fromDataUrl = (url: string) => encoded(Buffer.from(url.replace(/^data:[^,]*,/, ''), 'base64'))
const blobBytes = (c: Canvas, type: string, quality?: number) =>
  new Promise<Uint8Array>((resolve, reject) =>
    c.toBlob(
      (blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error('null'))),
      type,
      quality,
    ),
  )

/** E1 and E3: four pixels a float16 canvas keeps apart from unorm8. */
function fourPixels(opts: object) {
  const c = createCanvas(4, 1)
  const ctx = c.getContext('2d', loose({ willReadFrequently: true, ...opts }))
  ctx.fillStyle = 'rgb(32,128,223)'
  ctx.fillRect(0, 0, 1, 1)
  ctx.fillStyle = 'rgba(255,255,255,0.01)'
  for (let i = 0; i < 100; i++) ctx.fillRect(1, 0, 1, 1)
  ctx.fillStyle = 'rgba(200,100,50,0.3)'
  ctx.fillRect(2, 0, 1, 1)
  ctx.fillStyle = 'rgba(10,20,30,0.002)'
  ctx.fillRect(3, 0, 1, 1)
  return c
}

/** E2 and E4: a translucent gradient. */
function gradient(opts: object) {
  const c = createCanvas(8, 8)
  const ctx = c.getContext('2d', loose({ willReadFrequently: true, ...opts }))
  const g = ctx.createLinearGradient(0, 0, 8, 8)
  g.addColorStop(0, 'rgb(250,10,20)')
  g.addColorStop(1, 'rgba(10,200,250,0.5)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 8, 8)
  return c
}

const F16 = { colorType: 'float16' }
const F16P3 = { colorType: 'float16', colorSpace: 'display-p3' }

test('toDataURL png of float16 encodes the unpremultiplied readback', (t) => {
  const out: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({
    u8: {},
    f16: F16,
    f16p3: F16P3,
    f16opaque: { colorType: 'float16', alpha: false },
  })) {
    out[k] = fromDataUrl(fourPixels(o).toDataURL('image/png'))
  }
  chromeEqual(t, out, 'E1-png-of-f16')
})

test('toDataURL jpeg and webp of float16', (t) => {
  const out: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ u8: {}, f16: F16 })) {
    const c = gradient(o)
    out[k + '.jpeg'] = fromDataUrl(c.toDataURL('image/jpeg', 0.9))
    out[k + '.webp'] = fromDataUrl(c.toDataURL('image/webp', 0.9))
    out[k + '.webpLossless'] = fromDataUrl(c.toDataURL('image/webp', 1))
  }
  chromeEqual(t, out, 'E2-jpeg-webp-of-f16')
})

test('toBlob png of float16 encodes the premultiplied pixels', async (t) => {
  const bytes = await blobBytes(fourPixels(F16), 'image/png')
  chromeEqual(t, { _: encoded(bytes) }, 'E3-toBlob-png-of-f16')
  // convertToBlob encodes the same pixels.
  const blob = await fourPixels(F16).convertToBlob()
  chromeEqual(t, { _: encoded(new Uint8Array(await blob.arrayBuffer())) }, 'E3-toBlob-png-of-f16')
})

test('toBlob jpeg, webp and png of float16 and display-p3 float16', async (t) => {
  const out: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ u8: {}, f16: F16, f16p3: F16P3 })) {
    const c = gradient(o)
    for (const [type, q] of [
      ['image/jpeg', 0.9],
      ['image/webp', 0.9],
      ['image/webp', 1],
      ['image/png', undefined],
    ] as const) {
      out[`${k} ${type} ${q}`] = encoded(await blobBytes(c, type, q))
    }
  }
  chromeEqual(t, out, 'E4-toBlob-jpeg-webp-of-f16')
})

// No Chrome counterpart: the Node encoders take toBlob's path.
test('the Node encoders encode float16 like toBlob', async (t) => {
  const c = fourPixels(F16)
  chromeEqual(t, { _: encoded(c.toBuffer('image/png')) }, 'E3-toBlob-png-of-f16')
  chromeEqual(t, { _: encoded(c.encodeSync('png')) }, 'E3-toBlob-png-of-f16')
  chromeEqual(t, { _: encoded(await c.encode('png')) }, 'E3-toBlob-png-of-f16')
})

// No Chrome counterpart: data() gives the stored pixels, premultiplied half
// floats on a float16 canvas.
test('data() of a float16 canvas is its premultiplied half floats', (t) => {
  const c = createCanvas(1, 1)
  const ctx = c.getContext('2d', loose({ colorType: 'float16' }))
  ctx.fillStyle = 'rgba(255,255,255,0.01)'
  for (let i = 0; i < 100; i++) ctx.fillRect(0, 0, 1, 1)
  const data = c.data()
  t.is(data.length, 8)
  const half = (i: number) => {
    const bits = data.readUInt16LE(i)
    const exp = (bits >> 10) & 0x1f
    const frac = bits & 0x3ff
    const sign = bits >> 15 ? -1 : 1
    if (exp === 0) return sign * 2 ** -14 * (frac / 1024)
    return sign * 2 ** (exp - 15) * (1 + frac / 1024)
  }
  // White at P1's alpha: the premultiplied channels equal the alpha.
  const alpha = (chromeFor('P1-100-fills') as any[]).map((pin) => pin.float16.transparent.f32[3])
  t.true(alpha.includes(half(6)), String(half(6)))
  t.deepEqual([half(0), half(2), half(4)], [half(6), half(6), half(6)])
})
