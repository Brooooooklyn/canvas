import { pbkdf2 } from 'node:crypto'

import test from 'ava'

import { createCanvas, loadImage } from '../index.js'

// Occupy every libuv worker so the async encode task is queued behind them
// and cannot start before the main thread mutates the canvas.
function occupyThreadpool(count = 8): Promise<unknown>[] {
  return Array.from(
    { length: count },
    () =>
      new Promise((resolve, reject) => {
        pbkdf2('a', 'b', 1_000_000, 32, 'sha512', (err, key) => (err ? reject(err) : resolve(key)))
      }),
  )
}

function drawRed(ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>) {
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 256, 256)
}

// https://github.com/Brooooooklyn/canvas/issues/1313
// Async encode must capture the bitmap at call time; drawing after the call
// must not change the encoded output.

test('encode(png) snapshots pixels at call time', async (t) => {
  const canvas = createCanvas(256, 256)
  const ctx = canvas.getContext('2d')
  drawRed(ctx)
  const expected = canvas.encodeSync('png')

  const occupiers = occupyThreadpool()
  const promise = canvas.encode('png')
  ctx.clearRect(0, 0, 256, 256)
  const [output] = await Promise.all([promise, ...occupiers])

  t.true(
    output.equals(expected),
    'PNG must encode the red bitmap captured at call time, not the cleared surface',
  )
})

test('encode(jpeg) snapshots pixels at call time', async (t) => {
  const canvas = createCanvas(256, 256)
  const ctx = canvas.getContext('2d')
  drawRed(ctx)
  const expected = canvas.encodeSync('jpeg', 92)

  const occupiers = occupyThreadpool()
  const promise = canvas.encode('jpeg', 92)
  ctx.clearRect(0, 0, 256, 256)
  const [output] = await Promise.all([promise, ...occupiers])

  t.true(output.equals(expected), 'JPEG must encode the bitmap captured at call time')
})

test('encode(webp) snapshots pixels at call time', async (t) => {
  const canvas = createCanvas(256, 256)
  const ctx = canvas.getContext('2d')
  drawRed(ctx)
  const expected = canvas.encodeSync('webp', 92)

  const occupiers = occupyThreadpool()
  const promise = canvas.encode('webp', 92)
  ctx.clearRect(0, 0, 256, 256)
  const [output] = await Promise.all([promise, ...occupiers])

  t.true(output.equals(expected), 'WebP must encode the bitmap captured at call time')
})

test('encode(gif) snapshots pixels at call time', async (t) => {
  const canvas = createCanvas(256, 256)
  const ctx = canvas.getContext('2d')
  drawRed(ctx)
  const expected = canvas.encodeSync('gif')

  const occupiers = occupyThreadpool()
  const promise = canvas.encode('gif')
  ctx.clearRect(0, 0, 256, 256)
  const [output] = await Promise.all([promise, ...occupiers])

  t.true(output.equals(expected), 'GIF must encode the bitmap captured at call time')
})

test('encode(avif) snapshots pixels at call time', async (t) => {
  const canvas = createCanvas(256, 256)
  const ctx = canvas.getContext('2d')

  // A fully transparent reference: with the bug, the post-call clearRect
  // leaks into the output and the bytes match this transparent encode.
  const transparent = createCanvas(256, 256)
  const transparentBytes = transparent.encodeSync('avif')

  drawRed(ctx)
  const occupiers = occupyThreadpool()
  const promise = canvas.encode('avif')
  ctx.clearRect(0, 0, 256, 256)
  const [output] = await Promise.all([promise, ...occupiers])

  t.false(
    output.equals(transparentBytes),
    'AVIF must not reflect the clearRect that happened after encode() was called',
  )
})

test('toDataURLAsync snapshots pixels at call time', async (t) => {
  const canvas = createCanvas(256, 256)
  const ctx = canvas.getContext('2d')
  drawRed(ctx)
  const expected = canvas.toDataURL('image/png')

  const occupiers = occupyThreadpool()
  const promise = canvas.toDataURLAsync('image/png')
  ctx.clearRect(0, 0, 256, 256)
  const [output] = await Promise.all([promise, ...occupiers])

  t.is(output, expected, 'toDataURLAsync must encode the bitmap captured at call time')
})

test('toBlob snapshots pixels at call time', async (t) => {
  const canvas = createCanvas(256, 256)
  const ctx = canvas.getContext('2d')
  drawRed(ctx)
  const expected = canvas.encodeSync('png')

  const occupiers = occupyThreadpool()
  const promise = new Promise<Buffer>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? blob.arrayBuffer().then((buf) => resolve(Buffer.from(buf)))
          : reject(new Error('toBlob callback received null')),
      'image/png',
    )
  })
  ctx.clearRect(0, 0, 256, 256)
  const [output] = await Promise.all([promise, ...occupiers])

  t.true(output.equals(expected), 'toBlob must encode the bitmap captured at call time')
})

test('convertToBlob snapshots pixels at call time', async (t) => {
  const canvas = createCanvas(256, 256)
  const ctx = canvas.getContext('2d')
  drawRed(ctx)
  const expected = canvas.encodeSync('png')

  const occupiers = occupyThreadpool()
  const promise = canvas.convertToBlob()
  ctx.clearRect(0, 0, 256, 256)
  const [blob] = await Promise.all([promise, ...occupiers])
  const output = Buffer.from(await blob.arrayBuffer())

  t.true(output.equals(expected), 'convertToBlob must encode the bitmap captured at call time')
})

// Drawing after encode() (not just clearRect) must also be excluded: ordinary
// draws are deferred in the PageRecorder and materialize on the next flush,
// which used to happen on the live surface the worker was encoding.
test('encode(png) excludes draws made after the call', async (t) => {
  const canvas = createCanvas(256, 256)
  const ctx = canvas.getContext('2d')
  drawRed(ctx)
  const expected = canvas.encodeSync('png')

  const occupiers = occupyThreadpool()
  const promise = canvas.encode('png')
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 256, 256)
  const [output] = await Promise.all([promise, ...occupiers])

  t.true(output.equals(expected), 'PNG must not include the blue fill drawn after encode()')
})

// canvas.data() must hand JS an owned copy: writing through a zero-copy view
// of the surface would bypass Skia's copy-on-write and corrupt snapshots
// already captured by a queued encode.
test('encode(png) is isolated from canvas.data() mutation', async (t) => {
  const canvas = createCanvas(256, 256)
  const ctx = canvas.getContext('2d')
  drawRed(ctx)
  const expected = canvas.encodeSync('png')

  const occupiers = occupyThreadpool()
  const promise = canvas.encode('png')
  canvas.data().fill(0)
  const [output] = await Promise.all([promise, ...occupiers])

  t.true(
    output.equals(expected),
    'PNG must not reflect writes through canvas.data() made after encode()',
  )
})

test('canvas.data() returns pixel bytes that are detached from the surface', (t) => {
  const canvas = createCanvas(4, 4)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 4, 4)

  const data = canvas.data()
  t.deepEqual(Array.from(data.subarray(0, 4)), [255, 0, 0, 255])

  data.fill(0)
  t.deepEqual(
    Array.from(canvas.data().subarray(0, 4)),
    [255, 0, 0, 255],
    'mutating the returned buffer must not change the surface',
  )
})

async function decodeCenterPixel(buf: Buffer): Promise<number[]> {
  const image = await loadImage(buf)
  const canvas = createCanvas(64, 64)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  return Array.from(ctx.getImageData(32, 32, 1, 1).data)
}

// GIF collapses alpha to opaque/transparent, so it must receive straight
// (non-premultiplied) RGB: feeding premultiplied bytes bakes the darkened
// color in as an opaque pixel.
test('gif encodes translucent colors from straight RGB', async (t) => {
  const canvas = createCanvas(64, 64)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'rgba(20,200,100,0.25)'
  ctx.fillRect(0, 0, 64, 64)

  const [r, g, b, a] = await decodeCenterPixel(canvas.encodeSync('gif'))
  t.true(Math.abs(r - 20) <= 10, `red channel ${r}, expected ~20`)
  t.true(Math.abs(g - 200) <= 10, `green channel ${g}, expected ~200`)
  t.true(Math.abs(b - 100) <= 10, `blue channel ${b}, expected ~100`)
  t.is(a, 255, 'non-zero alpha collapses to opaque in GIF')
})

// AVIF keeps alpha; in-library decode must round-trip the translucent color.
test('avif round-trips translucent colors', async (t) => {
  const canvas = createCanvas(64, 64)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'rgba(20,200,100,0.25)'
  ctx.fillRect(0, 0, 64, 64)

  const [r, g, b, a] = await decodeCenterPixel(canvas.encodeSync('avif'))
  t.true(Math.abs(r - 20) <= 12, `red channel ${r}, expected ~20`)
  t.true(Math.abs(g - 200) <= 12, `green channel ${g}, expected ~200`)
  t.true(Math.abs(b - 100) <= 12, `blue channel ${b}, expected ~100`)
  t.true(Math.abs(a - 64) <= 12, `alpha channel ${a}, expected ~64`)
})
