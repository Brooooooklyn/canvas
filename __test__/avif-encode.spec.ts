import test from 'ava'

import { createCanvas, loadImage } from '../index'

// Chrome has no AVIF encoder: these follow our own AvifConfig doc.

// A 64x64 canvas with a smooth and a sharp part, without text (no fonts).
function sampleCanvas() {
  const canvas = createCanvas(64, 64)
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, 64, 64)
  gradient.addColorStop(0, 'red')
  gradient.addColorStop(1, 'blue')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)
  ctx.fillStyle = '#0f0'
  ctx.fillRect(10, 20, 8, 24)
  ctx.fillRect(30, 10, 24, 6)
  return canvas
}

// speed is aom's 0 (slowest) to 10 (fastest); it used to wrap before the
// clamp, so 256 was speed 0.
test('avif speed above 10 is the fastest speed', (t) => {
  const canvas = sampleCanvas()
  const fastest = canvas.toBuffer('image/avif', { speed: 10 }).length
  const slowest = canvas.toBuffer('image/avif', { speed: 0 }).length
  t.not(fastest, slowest)
  for (const speed of [11, 255, 256, 266]) {
    t.is(canvas.toBuffer('image/avif', { speed }).length, fastest, `speed ${speed}`)
  }
})

// threads: 0 or unset is one per core; aom takes at most 64.
test('avif threads above 64 do not throw', async (t) => {
  const canvas = sampleCanvas()
  for (const threads of [0, 1, 64, 65, 100]) {
    const data = canvas.toBuffer('image/avif', { threads })
    const image = await loadImage(data)
    t.deepEqual([image.width, image.height], [64, 64], `threads ${threads}`)
  }
})

// A number is the AVIF quality: 0-100 for the Node methods, 0-1 for
// toDataURL (rounded to a percentage as for JPEG). It used to be ignored.
test('avif numeric quality is honored', async (t) => {
  const canvas = sampleCanvas()
  t.true(canvas.toBuffer('image/avif', 10).length < canvas.toBuffer('image/avif', 90).length)
  const q50 = canvas.toBuffer('image/avif', { quality: 50 })
  t.deepEqual(canvas.toBuffer('image/avif', 50), q50, 'toBuffer')
  t.deepEqual(canvas.encodeSync('avif', 50), q50, 'encodeSync')
  t.deepEqual(await canvas.encode('avif', 50), q50, 'encode')
  t.deepEqual(Buffer.from(canvas.toDataURL('image/avif', 0.5).split(',')[1], 'base64'), q50, 'toDataURL')
  // Above 100 is 100.
  t.deepEqual(canvas.toBuffer('image/avif', 1000), canvas.toBuffer('image/avif', 100))
})

// The CICP of the 'colr' nclx box: primaries, transfer, matrix, full range.
function colr(data: Uint8Array) {
  const buffer = Buffer.from(data)
  const at = buffer.indexOf('colrnclx')
  return [buffer.readUInt16BE(at + 8), buffer.readUInt16BE(at + 10), buffer.readUInt16BE(at + 12), buffer[at + 14] >> 7]
}

// 16x16 random pixels; with `alpha`, every 4th pixel is opaque and the others
// have a random alpha.
function randomCanvas(alpha: boolean) {
  let seed = 7
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24
  const canvas = createCanvas(16, 16)
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(16, 16)
  for (let i = 0; i < 256; i++) {
    imageData.data.set([next(), next(), next(), alpha && i % 4 !== 0 ? next() : 255], i * 4)
  }
  ctx.putImageData(imageData, 0, 0)
  return { canvas, pixels: [...ctx.getImageData(0, 0, 16, 16).data] }
}

async function decode(data: Uint8Array) {
  const ctx = createCanvas(16, 16).getContext('2d')
  ctx.drawImage(await loadImage(Buffer.from(data)), 0, 0)
  return [...ctx.getImageData(0, 0, 16, 16).data]
}

// Like WebP quality 1 in Chrome (image_encoder.cc:119-123), the best AVIF
// quality is lossless: 4:4:4 with the identity matrix (CICP matrix 0), so
// R, G and B are coded as they are. Chrome 155 decodes these files to the
// source pixels too.
test('avif quality 100 is lossless', async (t) => {
  const { canvas, pixels } = randomCanvas(false)
  const blob = await canvas.convertToBlob({ type: 'image/avif' })
  for (const [name, data] of [
    ['toBuffer 100', canvas.toBuffer('image/avif', 100)],
    ['toBuffer {quality: 100}', canvas.toBuffer('image/avif', { quality: 100 })],
    ['encodeSync 100', canvas.encodeSync('avif', 100)],
    ['encode 100', await canvas.encode('avif', 100)],
    ['toDataURL 1', Buffer.from(canvas.toDataURL('image/avif', 1).split(',')[1], 'base64')],
    ['convertToBlob default quality', new Uint8Array(await blob.arrayBuffer())],
  ] as const) {
    t.deepEqual(colr(data), [1, 13, 0, 1], name)
    t.deepEqual(await decode(data), pixels, name)
  }
})

// The alpha is lossless at quality 100 unless alphaQuality says otherwise.
// Only the alpha and the opaque pixels can be compared: a decoder stores
// premultiplied pixels, so the color of a translucent pixel can round.
test('avif quality 100 keeps the alpha lossless', async (t) => {
  const { canvas, pixels } = randomCanvas(true)
  const alphas = (data: number[]) => data.filter((_, i) => i % 4 === 3)
  const opaque = (data: number[]) => data.filter((_, i) => i % 16 < 4)
  t.true(
    opaque(pixels).every((value, i) => i % 4 !== 3 || value === 255),
    'every 4th pixel is opaque',
  )
  for (const [name, data] of [
    ['toBuffer 100', canvas.toBuffer('image/avif', 100)],
    ['toBuffer {quality: 100}', canvas.toBuffer('image/avif', { quality: 100 })],
    ['toDataURL 1', Buffer.from(canvas.toDataURL('image/avif', 1).split(',')[1], 'base64')],
  ] as const) {
    const decoded = await decode(data)
    t.deepEqual(alphas(decoded), alphas(pixels), `${name} alpha`)
    t.deepEqual(opaque(decoded), opaque(pixels), `${name} opaque pixels`)
  }
  const lossyAlpha = await decode(canvas.toBuffer('image/avif', { quality: 100, alphaQuality: 50 }))
  t.notDeepEqual(alphas(lossyAlpha), alphas(pixels), 'alphaQuality 50')
})

// Below 100, or with chroma subsampling, the file is lossy BT.601 YUV.
test('avif below quality 100 or with chroma subsampling stays BT.601', (t) => {
  const { canvas } = randomCanvas(false)
  t.deepEqual(colr(canvas.toBuffer('image/avif', 99)), [1, 13, 6, 1], '99')
  t.deepEqual(colr(canvas.toBuffer('image/avif', { quality: 100, chromaSubsampling: 2 })), [1, 13, 6, 1], '4:2:0')
  t.deepEqual(colr(canvas.toBuffer('image/avif', { quality: 100, chromaSubsampling: 1 })), [1, 13, 6, 1], '4:2:2')
})
