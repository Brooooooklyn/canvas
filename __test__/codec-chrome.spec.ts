import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, loadImage } from '../index'

// Values measured in Chrome 155 (--disable-gpu, willReadFrequently,
// standards-mode page); arm64 and x64 give the same.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

// The sampling factors (hex) of the components in the first SOF0-2 marker:
// '11,11,11' is 4:4:4, '22,11,11' is 4:2:0.
function sof(bytes: Uint8Array): string | null {
  for (let i = 2; i < bytes.length - 9;) {
    if (bytes[i] !== 0xff) {
      i++
      continue
    }
    const marker = bytes[i + 1]
    const length = (bytes[i + 2] << 8) | bytes[i + 3]
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const components = bytes[i + 9]
      const factors = []
      for (let k = 0; k < components; k++) factors.push(bytes[i + 11 + k * 3].toString(16))
      return factors.join(',')
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    i += 2 + length
  }
  return null
}

function dataUrlBytes(url: string) {
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
}

// A 4x1 canvas of red, blue, green and white.
function rgbwCanvas(alpha = true) {
  const canvas = createCanvas(4, 1)
  const ctx = canvas.getContext('2d', { alpha })
  const id = ctx.createImageData(4, 1)
  id.data.set([255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 255])
  ctx.putImageData(id, 0, 0)
  return canvas
}

async function decode4x1(data: string | Buffer) {
  const canvas = createCanvas(4, 1)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(await loadImage(data), 0, 0)
  return Array.from(ctx.getImageData(0, 0, 4, 1).data)
}

// Blink ImageEncoder::Encode (image_encoder.cc:52-54): quality 100 keeps the
// chroma at full resolution (4:4:4); below 100 it is 4:2:0.
test('jpeg quality 100 encodes chroma at full resolution like Chrome', async (t) => {
  const canvas = rgbwCanvas()
  t.is(sof(dataUrlBytes(canvas.toDataURL('image/jpeg', 1))), '11,11,11', 'toDataURL 1')
  t.is(sof(canvas.toBuffer('image/jpeg', 100)), '11,11,11', 'toBuffer 100')
  t.is(sof(canvas.encodeSync('jpeg', 100)), '11,11,11', 'encodeSync 100')
  t.is(sof(await canvas.encode('jpeg', 100)), '11,11,11', 'encode 100')
  const chunks: Buffer[] = []
  for await (const chunk of canvas.encodeStream('jpeg', 100)) chunks.push(chunk)
  t.is(sof(Buffer.concat(chunks)), '11,11,11', 'encodeStream 100')
  t.is(sof(canvas.encodeSync('jpeg', 99)), '22,11,11', 'encodeSync 99')
  t.is(sof(dataUrlBytes(canvas.toDataURL('image/jpeg', 0.99))), '22,11,11', 'toDataURL 0.99')
  t.is(sof(dataUrlBytes(canvas.toDataURL('image/jpeg'))), '22,11,11', 'toDataURL default')
})

test('jpeg quality 100 decodes to the colors Chrome gets', async (t) => {
  t.deepEqual(
    await decode4x1(rgbwCanvas().toDataURL('image/jpeg', 1)),
    [254, 0, 0, 255, 0, 0, 254, 255, 0, 255, 1, 255, 255, 255, 255, 255],
  )
  t.deepEqual(
    await decode4x1(rgbwCanvas(false).toDataURL('image/jpeg', 1)),
    [254, 0, 0, 255, 0, 0, 254, 255, 0, 255, 1, 255, 255, 255, 255, 255],
    'alpha:false',
  )
  t.deepEqual(
    await decode4x1(rgbwCanvas().toDataURL('image/jpeg', 0.99)),
    [150, 24, 150, 255, 103, 0, 103, 255, 76, 202, 76, 255, 181, 255, 181, 255],
    '0.99',
  )
  t.deepEqual(
    await decode4x1(rgbwCanvas().toDataURL('image/jpeg')),
    [152, 23, 152, 255, 105, 0, 105, 255, 74, 203, 74, 255, 179, 255, 179, 255],
    'default quality',
  )
})

// The fixtures hold Display P3 255,0,0 (left half) and 200,100,50 (right
// half) with a Display P3 ICC profile and EXIF orientation 1 to 8 (p3.jpg has
// no EXIF). Chrome converts them from P3 at any orientation.
test('EXIF-rotated display-p3 JPEG keeps its ICC profile like Chrome', async (t) => {
  const expected = JSON.parse(readFileSync(join(FIXTURES, 'exif-p3', 'chrome-155.json'), 'utf8'))
  const names = ['p3.jpg', ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `p3-exif${n}.jpg`)]
  for (const name of names) {
    const image = await loadImage(join(FIXTURES, 'exif-p3', name))
    for (const colorSpace of ['srgb', 'display-p3'] as const) {
      const canvas = createCanvas(4, 4)
      const ctx = canvas.getContext('2d', { colorSpace })
      ctx.drawImage(image, 0, 0)
      const data = ctx.getImageData(0, 0, 4, 4).data
      const px = []
      for (let i = 0; i < 16; i++) px.push(Array.from(data.slice(i * 4, i * 4 + 3)).join(','))
      const want = expected[`${name} ${colorSpace}`]
      t.deepEqual({ w: image.width, h: image.height, px: px.join(' ') }, want, `${name} ${colorSpace}`)
    }
  }
})

// with-exif.jpg: an Apple RGB ICC profile and EXIF orientation 6.
test('with-exif.jpg draws like Chrome', async (t) => {
  const image = await loadImage(join(FIXTURES, 'with-exif.jpg'))
  t.deepEqual([image.naturalWidth, image.naturalHeight], [450, 600])
  const canvas = createCanvas(800, 800)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data)
  t.deepEqual(px(10, 10), [148, 154, 71, 255])
  t.deepEqual(px(200, 300), [13, 15, 23, 255])
  t.deepEqual(px(400, 400), [37, 37, 23, 255])
  t.deepEqual(px(600, 100), [0, 0, 0, 0])
})
