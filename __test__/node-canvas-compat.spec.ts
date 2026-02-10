import { Readable } from 'node:stream'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import {
  createCanvas,
  createImageData,
  registerFont,
  deregisterAllFonts,
  loadImage,
  Canvas,
  Image,
  ImageData,
  PNGStream,
  JPEGStream,
  CanvasRenderingContext2D,
  Context2d,
  DOMPoint,
  DOMMatrix,
  GlobalFonts,
} from '../node-canvas'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fontPath = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test('exports all expected symbols', (t) => {
  t.is(typeof createCanvas, 'function')
  t.is(typeof createImageData, 'function')
  t.is(typeof registerFont, 'function')
  t.is(typeof deregisterAllFonts, 'function')
  t.is(typeof loadImage, 'function')
  t.truthy(Canvas)
  t.truthy(Image)
  t.truthy(ImageData)
  t.truthy(PNGStream)
  t.truthy(JPEGStream)
  t.truthy(CanvasRenderingContext2D)
  t.is(Context2d, CanvasRenderingContext2D, 'Context2d should be an alias')
  t.truthy(DOMPoint)
  t.truthy(DOMMatrix)
  t.truthy(GlobalFonts)
})

// ---------------------------------------------------------------------------
// createCanvas
// ---------------------------------------------------------------------------

test('createCanvas returns a canvas with compat methods', (t) => {
  const canvas = createCanvas(100, 100)
  t.is(canvas.width, 100)
  t.is(canvas.height, 100)
  t.is(typeof canvas.getContext, 'function')
  t.is(typeof canvas.createPNGStream, 'function')
  t.is(typeof canvas.createJPEGStream, 'function')
  t.is(typeof canvas.toBuffer, 'function')
  t.is(typeof canvas.toDataURL, 'function')
})

test('createCanvas 2d context works', (t) => {
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')
  t.truthy(ctx)
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 100, 100)
  t.pass()
})

// ---------------------------------------------------------------------------
// registerFont
// ---------------------------------------------------------------------------

test.serial('registerFont accepts node-canvas style arguments', (t) => {
  t.notThrows(() => {
    registerFont(fontPath, { family: 'TestSourceSerif' })
  })
  t.true(GlobalFonts.has('TestSourceSerif'))
})

test('registerFont throws without family', (t) => {
  t.throws(
    () => {
      // @ts-expect-error testing invalid args
      registerFont(fontPath, {})
    },
    { instanceOf: TypeError },
  )
  t.throws(
    () => {
      // @ts-expect-error testing invalid args
      registerFont(fontPath)
    },
    { instanceOf: TypeError },
  )
})

test.serial('registerFont accepts weight and style (compat)', (t) => {
  t.notThrows(() => {
    registerFont(fontPath, { family: 'TestSourceSerifWeighted', weight: 'bold', style: 'italic' })
  })
  t.true(GlobalFonts.has('TestSourceSerifWeighted'))
})

// ---------------------------------------------------------------------------
// deregisterAllFonts
// ---------------------------------------------------------------------------

test.serial('deregisterAllFonts removes only user-registered fonts', (t) => {
  // Clear any fonts tracked by prior tests
  deregisterAllFonts()
  const baselineCount = GlobalFonts.families.length
  registerFont(fontPath, { family: 'ToBeRemoved' })
  t.true(GlobalFonts.has('ToBeRemoved'))
  deregisterAllFonts()
  t.false(GlobalFonts.has('ToBeRemoved'))
  // Only user-registered fonts should be removed, baseline stays the same
  t.is(GlobalFonts.families.length, baselineCount)
})

// ---------------------------------------------------------------------------
// toBuffer
// ---------------------------------------------------------------------------

test('toBuffer() with no args returns PNG buffer', (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 10, 10)
  const buf = canvas.toBuffer()
  t.true(Buffer.isBuffer(buf))
  // PNG magic bytes
  t.is(buf[0], 0x89)
  t.is(buf[1], 0x50) // P
  t.is(buf[2], 0x4e) // N
  t.is(buf[3], 0x47) // G
})

test('toBuffer("image/png") returns PNG buffer', (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const buf = canvas.toBuffer('image/png')
  t.true(Buffer.isBuffer(buf))
  t.is(buf[0], 0x89) // PNG magic
})

test('toBuffer("image/png", config) accepts PngConfig', (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const buf = canvas.toBuffer('image/png', { compressionLevel: 9 })
  t.true(Buffer.isBuffer(buf))
  t.is(buf[0], 0x89)
})

test('toBuffer("image/jpeg") returns JPEG buffer', (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const buf = canvas.toBuffer('image/jpeg')
  t.true(Buffer.isBuffer(buf))
  // JPEG magic bytes: FF D8
  t.is(buf[0], 0xff)
  t.is(buf[1], 0xd8)
})

test('toBuffer("image/jpeg", { quality }) maps 0-1 quality', (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 10, 10)

  const lowQ = canvas.toBuffer('image/jpeg', { quality: 0.1 })
  const highQ = canvas.toBuffer('image/jpeg', { quality: 0.99 })
  t.true(Buffer.isBuffer(lowQ))
  t.true(Buffer.isBuffer(highQ))
  // Higher quality should produce a larger buffer (in most cases)
  t.true(highQ.length >= lowQ.length, `highQ (${highQ.length}) should be >= lowQ (${lowQ.length})`)
})

test('toBuffer("raw") returns raw pixel data', (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const buf = canvas.toBuffer('raw')
  t.true(Buffer.isBuffer(buf))
  // Raw RGBA: 10*10*4 = 400 bytes
  t.is(buf.length, 400)
})

test('toBuffer(callback) calls back with PNG buffer', async (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const buf = await new Promise<Buffer>((resolve, reject) => {
    canvas.toBuffer((err: Error | null, result: Buffer) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
  t.true(Buffer.isBuffer(buf))
  t.is(buf[0], 0x89) // PNG
})

test('toBuffer(callback, "image/jpeg", config) calls back with JPEG', async (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const buf = await new Promise<Buffer>((resolve, reject) => {
    canvas.toBuffer(
      (err: Error | null, result: Buffer) => {
        if (err) reject(err)
        else resolve(result)
      },
      'image/jpeg',
      { quality: 0.9 },
    )
  })
  t.true(Buffer.isBuffer(buf))
  t.is(buf[0], 0xff) // JPEG
  t.is(buf[1], 0xd8)
})

// ---------------------------------------------------------------------------
// toDataURL
// ---------------------------------------------------------------------------

test('toDataURL() returns PNG data URL', (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const url = canvas.toDataURL()
  t.true(url.startsWith('data:image/png;base64,'))
})

test('toDataURL("image/jpeg", quality) maps quality 0-1', (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const url = canvas.toDataURL('image/jpeg', 0.5)
  t.true(url.startsWith('data:image/jpeg;base64,'))
})

test('toDataURL(callback) calls back async', async (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const url = await new Promise<string>((resolve, reject) => {
    canvas.toDataURL((err: Error | null, result: string) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
  t.true(url.startsWith('data:image/png;base64,'))
})

// ---------------------------------------------------------------------------
// createPNGStream / createJPEGStream
// ---------------------------------------------------------------------------

test('createPNGStream returns a Readable with PNG data', async (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#00ff00'
  ctx.fillRect(0, 0, 10, 10)

  const stream = canvas.createPNGStream()
  t.true(stream instanceof Readable)
  t.true(stream instanceof PNGStream)

  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  const buf = Buffer.concat(chunks)
  t.true(buf.length > 0)
  t.is(buf[0], 0x89) // PNG magic
})

test('createJPEGStream returns a Readable with JPEG data', async (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#0000ff'
  ctx.fillRect(0, 0, 10, 10)

  const stream = canvas.createJPEGStream({ quality: 0.8 })
  t.true(stream instanceof Readable)
  t.true(stream instanceof JPEGStream)

  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  const buf = Buffer.concat(chunks)
  t.true(buf.length > 0)
  t.is(buf[0], 0xff) // JPEG magic
  t.is(buf[1], 0xd8)
})

test('createJPEGStream with default quality', async (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const stream = canvas.createJPEGStream()

  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  const buf = Buffer.concat(chunks)
  t.is(buf[0], 0xff)
  t.is(buf[1], 0xd8)
})

// ---------------------------------------------------------------------------
// createImageData
// ---------------------------------------------------------------------------

test('createImageData(width, height) creates blank ImageData', (t) => {
  const data = createImageData(10, 20)
  t.is(data.width, 10)
  t.is(data.height, 20)
  t.is(data.data.length, 10 * 20 * 4)
})

test('createImageData(array, width) creates ImageData from data', (t) => {
  const arr = new Uint8ClampedArray(40)
  const data = createImageData(arr, 10, 1)
  t.is(data.width, 10)
  t.is(data.height, 1)
})

// ---------------------------------------------------------------------------
// loadImage
// ---------------------------------------------------------------------------

test('loadImage loads from file path', async (t) => {
  const img = await loadImage(join(__dirname, '..', 'example', 'simple.png'))
  t.true(img instanceof Image)
  t.true(img.width > 0)
  t.true(img.height > 0)
})

// ---------------------------------------------------------------------------
// SVG canvas
// ---------------------------------------------------------------------------

test('createCanvas with svg type returns SvgCanvas', (t) => {
  const canvas = createCanvas(100, 100, 'svg')
  t.truthy(canvas)
  const ctx = canvas.getContext('2d')
  t.truthy(ctx)
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 100, 100)
  // SVG canvas should have getContent for vector output
  t.is(typeof (canvas as any).getContent, 'function')
  const content = (canvas as any).getContent() as Buffer
  t.true(content.toString('utf-8').includes('<svg'))
  // SVG canvas should NOT have raster compat methods
  t.is(typeof (canvas as any).createPNGStream, 'undefined')
  t.is(typeof (canvas as any).createJPEGStream, 'undefined')
})

// ---------------------------------------------------------------------------
// Multiple canvas instances are independent
// ---------------------------------------------------------------------------

test('compat methods are per-instance (no prototype pollution)', async (t) => {
  const { createCanvas: origCreateCanvas } = await import('../index')
  const origCanvas = origCreateCanvas(10, 10)

  // Original canvas should NOT have createPNGStream
  t.is(typeof (origCanvas as any).createPNGStream, 'undefined')

  // Compat canvas should have it
  const compatCanvas = createCanvas(10, 10)
  t.is(typeof compatCanvas.createPNGStream, 'function')
})
