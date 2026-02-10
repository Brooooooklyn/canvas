/**
 * Cross-compatibility tests: @napi-rs/canvas/node-canvas compat layer vs real node-canvas.
 *
 * These tests run the same operations against both libraries to verify that
 * the compat layer behaves the same way as the real node-canvas package.
 * This is important for consumers like fabric.js that depend on specific
 * API patterns from node-canvas.
 *
 * NOTE: We do NOT compare pixel-by-pixel output (Skia vs Cairo render differently),
 * exact buffer sizes, raw buffer formats, or PDF support.
 *
 * These tests require the `canvas` (node-canvas) npm package to be installed.
 * They are skipped on platforms where it is not available (e.g. Linux CI).
 */

import { Readable } from 'node:stream'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import test from 'ava'

// @napi-rs/canvas compat layer
import {
  createCanvas as napiCreateCanvas,
  createImageData as napiCreateImageData,
  registerFont as napiRegisterFont,
  deregisterAllFonts as napiDeregisterAllFonts,
} from '../node-canvas'

// Real node-canvas — skip all tests if not available
const require = createRequire(import.meta.url)
let nodeCanvas: typeof import('canvas')
try {
  nodeCanvas = require('canvas')
} catch {
  test('cross-compat tests skipped: canvas (node-canvas) package not available', (t) => {
    t.pass()
  })
}

// @ts-expect-error nodeCanvas is used before assignment check — guarded by the macro below
const ncCreateCanvas = nodeCanvas?.createCanvas
// @ts-expect-error same guard
const ncCreateImageData = nodeCanvas?.createImageData
// @ts-expect-error same guard
const ncRegisterFont = nodeCanvas?.registerFont
// @ts-expect-error same guard
const ncDeregisterAllFonts = nodeCanvas?.deregisterAllFonts

const hasNodeCanvas = !!ncCreateCanvas

// Conditional test: skip when node-canvas is not installed
const ctest = hasNodeCanvas ? test : test.skip
const cserial = hasNodeCanvas ? test.serial : test.serial.skip

const __dirname = dirname(fileURLToPath(import.meta.url))
const fontPath = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')
const latoFontPath = join(__dirname, 'fonts', 'Lato-Regular.ttf')
const iosevkaFontPath = join(__dirname, 'fonts', 'iosevka-slab-regular.ttf')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]
const JPEG_MAGIC = [0xff, 0xd8]

function isPng(buf: Buffer): boolean {
  return buf[0] === PNG_MAGIC[0] && buf[1] === PNG_MAGIC[1] && buf[2] === PNG_MAGIC[2] && buf[3] === PNG_MAGIC[3]
}

function isJpeg(buf: Buffer): boolean {
  return buf[0] === JPEG_MAGIC[0] && buf[1] === JPEG_MAGIC[1]
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------------------
// createCanvas
// ---------------------------------------------------------------------------

ctest('createCanvas: both return canvas with matching dimensions', (t) => {
  const napiCanvas = napiCreateCanvas(100, 200)
  const ncCanvas = ncCreateCanvas(100, 200)
  t.is(napiCanvas.width, ncCanvas.width)
  t.is(napiCanvas.height, ncCanvas.height)
})

ctest('createCanvas: both support getContext("2d")', (t) => {
  const napiCanvas = napiCreateCanvas(50, 50)
  const ncCanvas = ncCreateCanvas(50, 50)
  const napiCtx = napiCanvas.getContext('2d')
  const ncCtx = ncCanvas.getContext('2d')
  t.truthy(napiCtx)
  t.truthy(ncCtx)
})

ctest('createCanvas: both return width/height of 1x1', (t) => {
  const napiCanvas = napiCreateCanvas(1, 1)
  const ncCanvas = ncCreateCanvas(1, 1)
  t.is(napiCanvas.width, 1)
  t.is(ncCanvas.width, 1)
  t.is(napiCanvas.height, 1)
  t.is(ncCanvas.height, 1)
})

ctest('createCanvas: both return width/height of large canvas', (t) => {
  const napiCanvas = napiCreateCanvas(4096, 2048)
  const ncCanvas = ncCreateCanvas(4096, 2048)
  t.is(napiCanvas.width, ncCanvas.width)
  t.is(napiCanvas.height, ncCanvas.height)
})

// ---------------------------------------------------------------------------
// registerFont
// ---------------------------------------------------------------------------

cserial('registerFont: both accept {family} signature', (t) => {
  t.notThrows(() => {
    napiRegisterFont(fontPath, { family: 'CrossTestNapi' })
  })
  t.notThrows(() => {
    ncRegisterFont(fontPath, { family: 'CrossTestNC' })
  })
})

cserial('registerFont: both accept {family, weight, style} signature', (t) => {
  t.notThrows(() => {
    napiRegisterFont(latoFontPath, { family: 'CrossTestLatoNapi', weight: 'bold', style: 'italic' })
  })
  t.notThrows(() => {
    ncRegisterFont(latoFontPath, { family: 'CrossTestLatoNC', weight: 'bold', style: 'italic' })
  })
})

cserial('registerFont: registered fonts can be used to draw text (both produce output)', (t) => {
  napiRegisterFont(iosevkaFontPath, { family: 'CrossIosevkaNapi' })
  ncRegisterFont(iosevkaFontPath, { family: 'CrossIosevkaNC' })

  const napiCanvas = napiCreateCanvas(200, 50)
  const napiCtx = napiCanvas.getContext('2d')
  napiCtx.font = '20px CrossIosevkaNapi'
  napiCtx.fillText('Hello', 10, 30)
  const napiBuf = napiCanvas.toBuffer()
  t.true(isPng(napiBuf))
  t.true(napiBuf.length > 100, 'napi canvas should produce non-trivial PNG after text draw')

  const ncCanvas = ncCreateCanvas(200, 50)
  const ncCtx = ncCanvas.getContext('2d')
  ncCtx.font = '20px CrossIosevkaNC'
  ncCtx.fillText('Hello', 10, 30)
  const ncBuf = ncCanvas.toBuffer()
  t.true(isPng(ncBuf))
  t.true(ncBuf.length > 100, 'node-canvas should produce non-trivial PNG after text draw')
})

// ---------------------------------------------------------------------------
// deregisterAllFonts
// ---------------------------------------------------------------------------

ctest('deregisterAllFonts: both expose the function', (t) => {
  t.is(typeof napiDeregisterAllFonts, 'function')
  t.is(typeof ncDeregisterAllFonts, 'function')
})

ctest('deregisterAllFonts: both are callable without error', (t) => {
  // We don't test cross-library side-effects since they have separate font registries.
  // Just verify the function exists and is callable.
  t.notThrows(() => napiDeregisterAllFonts())
  t.notThrows(() => ncDeregisterAllFonts())
})

// ---------------------------------------------------------------------------
// toBuffer() - no args defaults to PNG
// ---------------------------------------------------------------------------

ctest('toBuffer(): both default to PNG buffer', (t) => {
  const napiCanvas = napiCreateCanvas(10, 10)
  napiCanvas.getContext('2d').fillRect(0, 0, 10, 10)
  const napiBuf = napiCanvas.toBuffer()

  const ncCanvas = ncCreateCanvas(10, 10)
  ncCanvas.getContext('2d').fillRect(0, 0, 10, 10)
  const ncBuf = ncCanvas.toBuffer()

  t.true(Buffer.isBuffer(napiBuf))
  t.true(Buffer.isBuffer(ncBuf))
  t.true(isPng(napiBuf), 'napi toBuffer() should produce PNG')
  t.true(isPng(ncBuf), 'node-canvas toBuffer() should produce PNG')
})

// ---------------------------------------------------------------------------
// toBuffer('image/png')
// ---------------------------------------------------------------------------

ctest('toBuffer("image/png"): both produce PNG buffers', (t) => {
  const napiCanvas = napiCreateCanvas(10, 10)
  napiCanvas.getContext('2d').fillRect(0, 0, 10, 10)
  const napiBuf = napiCanvas.toBuffer('image/png')

  const ncCanvas = ncCreateCanvas(10, 10)
  ncCanvas.getContext('2d').fillRect(0, 0, 10, 10)
  const ncBuf = ncCanvas.toBuffer('image/png')

  t.true(Buffer.isBuffer(napiBuf))
  t.true(Buffer.isBuffer(ncBuf))
  t.true(isPng(napiBuf))
  t.true(isPng(ncBuf))
})

// ---------------------------------------------------------------------------
// toBuffer('image/jpeg', { quality })
// ---------------------------------------------------------------------------

ctest('toBuffer("image/jpeg", { quality: 0.75 }): both produce JPEG buffers', (t) => {
  const napiCanvas = napiCreateCanvas(10, 10)
  const napiCtx = napiCanvas.getContext('2d')
  napiCtx.fillStyle = '#ff0000'
  napiCtx.fillRect(0, 0, 10, 10)
  const napiBuf = napiCanvas.toBuffer('image/jpeg', { quality: 0.75 })

  const ncCanvas = ncCreateCanvas(10, 10)
  const ncCtx = ncCanvas.getContext('2d')
  ncCtx.fillStyle = '#ff0000'
  ncCtx.fillRect(0, 0, 10, 10)
  const ncBuf = ncCanvas.toBuffer('image/jpeg', { quality: 0.75 })

  t.true(Buffer.isBuffer(napiBuf))
  t.true(Buffer.isBuffer(ncBuf))
  t.true(isJpeg(napiBuf), 'napi should produce JPEG')
  t.true(isJpeg(ncBuf), 'node-canvas should produce JPEG')
})

// ---------------------------------------------------------------------------
// toBuffer(callback) - async callback form defaults to PNG
// ---------------------------------------------------------------------------

ctest('toBuffer(callback): both call back with PNG buffer', async (t) => {
  const napiCanvas = napiCreateCanvas(10, 10)
  napiCanvas.getContext('2d').fillRect(0, 0, 10, 10)
  const napiBuf = await new Promise<Buffer>((resolve, reject) => {
    napiCanvas.toBuffer((err: Error | null, result: Buffer) => {
      if (err) reject(err)
      else resolve(result)
    })
  })

  const ncCanvas = ncCreateCanvas(10, 10)
  ncCanvas.getContext('2d').fillRect(0, 0, 10, 10)
  const ncBuf = await new Promise<Buffer>((resolve, reject) => {
    ncCanvas.toBuffer((err: Error | null, result: Buffer) => {
      if (err) reject(err)
      else resolve(result)
    })
  })

  t.true(Buffer.isBuffer(napiBuf))
  t.true(Buffer.isBuffer(ncBuf))
  t.true(isPng(napiBuf), 'napi callback should produce PNG')
  t.true(isPng(ncBuf), 'node-canvas callback should produce PNG')
})

// ---------------------------------------------------------------------------
// toBuffer(callback, 'image/jpeg', { quality })
// ---------------------------------------------------------------------------

ctest('toBuffer(callback, "image/jpeg", { quality: 0.9 }): both call back with JPEG', async (t) => {
  const napiCanvas = napiCreateCanvas(10, 10)
  napiCanvas.getContext('2d').fillRect(0, 0, 10, 10)
  const napiBuf = await new Promise<Buffer>((resolve, reject) => {
    napiCanvas.toBuffer(
      (err: Error | null, result: Buffer) => {
        if (err) reject(err)
        else resolve(result)
      },
      'image/jpeg',
      { quality: 0.9 },
    )
  })

  const ncCanvas = ncCreateCanvas(10, 10)
  ncCanvas.getContext('2d').fillRect(0, 0, 10, 10)
  const ncBuf = await new Promise<Buffer>((resolve, reject) => {
    ncCanvas.toBuffer(
      (err: Error | null, result: Buffer) => {
        if (err) reject(err)
        else resolve(result)
      },
      'image/jpeg',
      { quality: 0.9 },
    )
  })

  t.true(Buffer.isBuffer(napiBuf))
  t.true(Buffer.isBuffer(ncBuf))
  t.true(isJpeg(napiBuf), 'napi callback should produce JPEG')
  t.true(isJpeg(ncBuf), 'node-canvas callback should produce JPEG')
})

// ---------------------------------------------------------------------------
// createPNGStream
// ---------------------------------------------------------------------------

ctest('createPNGStream: both return Readable streams producing PNG data', async (t) => {
  const napiCanvas = napiCreateCanvas(10, 10)
  const napiCtx = napiCanvas.getContext('2d')
  napiCtx.fillStyle = '#00ff00'
  napiCtx.fillRect(0, 0, 10, 10)
  const napiStream = napiCanvas.createPNGStream()
  t.true(napiStream instanceof Readable, 'napi createPNGStream should return Readable')
  const napiBuf = await streamToBuffer(napiStream)
  t.true(isPng(napiBuf), 'napi PNG stream should produce PNG data')
  t.true(napiBuf.length > 0)

  const ncCanvas = ncCreateCanvas(10, 10)
  const ncCtx = ncCanvas.getContext('2d')
  ncCtx.fillStyle = '#00ff00'
  ncCtx.fillRect(0, 0, 10, 10)
  const ncStream = ncCanvas.createPNGStream()
  t.true(ncStream instanceof Readable, 'node-canvas createPNGStream should return Readable')
  const ncBuf = await streamToBuffer(ncStream)
  t.true(isPng(ncBuf), 'node-canvas PNG stream should produce PNG data')
  t.true(ncBuf.length > 0)
})

// ---------------------------------------------------------------------------
// createJPEGStream
// ---------------------------------------------------------------------------

ctest('createJPEGStream({ quality: 0.8 }): both return Readable streams producing JPEG data', async (t) => {
  const napiCanvas = napiCreateCanvas(10, 10)
  const napiCtx = napiCanvas.getContext('2d')
  napiCtx.fillStyle = '#0000ff'
  napiCtx.fillRect(0, 0, 10, 10)
  const napiStream = napiCanvas.createJPEGStream({ quality: 0.8 })
  t.true(napiStream instanceof Readable, 'napi createJPEGStream should return Readable')
  const napiBuf = await streamToBuffer(napiStream)
  t.true(isJpeg(napiBuf), 'napi JPEG stream should produce JPEG data')
  t.true(napiBuf.length > 0)

  const ncCanvas = ncCreateCanvas(10, 10)
  const ncCtx = ncCanvas.getContext('2d')
  ncCtx.fillStyle = '#0000ff'
  ncCtx.fillRect(0, 0, 10, 10)
  const ncStream = ncCanvas.createJPEGStream({ quality: 0.8 })
  t.true(ncStream instanceof Readable, 'node-canvas createJPEGStream should return Readable')
  const ncBuf = await streamToBuffer(ncStream)
  t.true(isJpeg(ncBuf), 'node-canvas JPEG stream should produce JPEG data')
  t.true(ncBuf.length > 0)
})

// ---------------------------------------------------------------------------
// toDataURL() - no args defaults to PNG
// ---------------------------------------------------------------------------

ctest('toDataURL(): both return PNG data URLs', (t) => {
  const napiCanvas = napiCreateCanvas(10, 10)
  napiCanvas.getContext('2d').fillRect(0, 0, 10, 10)
  const napiUrl = napiCanvas.toDataURL()

  const ncCanvas = ncCreateCanvas(10, 10)
  ncCanvas.getContext('2d').fillRect(0, 0, 10, 10)
  const ncUrl = ncCanvas.toDataURL()

  t.true(napiUrl.startsWith('data:image/png;base64,'), 'napi toDataURL() should start with PNG data URL prefix')
  t.true(ncUrl.startsWith('data:image/png;base64,'), 'node-canvas toDataURL() should start with PNG data URL prefix')
})

// ---------------------------------------------------------------------------
// toDataURL('image/jpeg', quality)
// ---------------------------------------------------------------------------

ctest('toDataURL("image/jpeg", 0.5): both return JPEG data URLs', (t) => {
  const napiCanvas = napiCreateCanvas(10, 10)
  napiCanvas.getContext('2d').fillRect(0, 0, 10, 10)
  const napiUrl = napiCanvas.toDataURL('image/jpeg', 0.5)

  const ncCanvas = ncCreateCanvas(10, 10)
  ncCanvas.getContext('2d').fillRect(0, 0, 10, 10)
  const ncUrl = ncCanvas.toDataURL('image/jpeg', 0.5)

  t.true(
    napiUrl.startsWith('data:image/jpeg;base64,'),
    'napi toDataURL("image/jpeg") should start with JPEG data URL prefix',
  )
  t.true(
    ncUrl.startsWith('data:image/jpeg;base64,'),
    'node-canvas toDataURL("image/jpeg") should start with JPEG data URL prefix',
  )
})

// ---------------------------------------------------------------------------
// createImageData
// ---------------------------------------------------------------------------

ctest('createImageData(width, height): both return ImageData with correct dimensions', (t) => {
  const napiData = napiCreateImageData(20, 30)
  const ncData = ncCreateImageData(20, 30)

  t.is(napiData.width, ncData.width, 'widths should match')
  t.is(napiData.height, ncData.height, 'heights should match')
  t.is(napiData.data.length, ncData.data.length, 'data array lengths should match')
  t.is(napiData.data.length, 20 * 30 * 4, 'data length should be width * height * 4')
})

// ---------------------------------------------------------------------------
// Drawing operations produce similar results
// ---------------------------------------------------------------------------

ctest('drawing fillRect: both produce valid non-empty PNGs', (t) => {
  const napiCanvas = napiCreateCanvas(50, 50)
  const napiCtx = napiCanvas.getContext('2d')
  napiCtx.fillStyle = '#ff0000'
  napiCtx.fillRect(5, 5, 40, 40)
  const napiBuf = napiCanvas.toBuffer()

  const ncCanvas = ncCreateCanvas(50, 50)
  const ncCtx = ncCanvas.getContext('2d')
  ncCtx.fillStyle = '#ff0000'
  ncCtx.fillRect(5, 5, 40, 40)
  const ncBuf = ncCanvas.toBuffer()

  t.true(isPng(napiBuf))
  t.true(isPng(ncBuf))
  t.true(napiBuf.length > 50, 'napi fillRect PNG should be non-trivial')
  t.true(ncBuf.length > 50, 'node-canvas fillRect PNG should be non-trivial')
})

ctest('drawing strokeRect: both produce valid non-empty PNGs', (t) => {
  const napiCanvas = napiCreateCanvas(50, 50)
  const napiCtx = napiCanvas.getContext('2d')
  napiCtx.strokeStyle = '#0000ff'
  napiCtx.lineWidth = 3
  napiCtx.strokeRect(5, 5, 40, 40)
  const napiBuf = napiCanvas.toBuffer()

  const ncCanvas = ncCreateCanvas(50, 50)
  const ncCtx = ncCanvas.getContext('2d')
  ncCtx.strokeStyle = '#0000ff'
  ncCtx.lineWidth = 3
  ncCtx.strokeRect(5, 5, 40, 40)
  const ncBuf = ncCanvas.toBuffer()

  t.true(isPng(napiBuf))
  t.true(isPng(ncBuf))
  t.true(napiBuf.length > 50)
  t.true(ncBuf.length > 50)
})

ctest('drawing arc: both produce valid non-empty PNGs', (t) => {
  const napiCanvas = napiCreateCanvas(100, 100)
  const napiCtx = napiCanvas.getContext('2d')
  napiCtx.beginPath()
  napiCtx.arc(50, 50, 40, 0, 2 * Math.PI)
  napiCtx.fillStyle = '#00ff00'
  napiCtx.fill()
  const napiBuf = napiCanvas.toBuffer()

  const ncCanvas = ncCreateCanvas(100, 100)
  const ncCtx = ncCanvas.getContext('2d')
  ncCtx.beginPath()
  ncCtx.arc(50, 50, 40, 0, 2 * Math.PI)
  ncCtx.fillStyle = '#00ff00'
  ncCtx.fill()
  const ncBuf = ncCanvas.toBuffer()

  t.true(isPng(napiBuf))
  t.true(isPng(ncBuf))
  t.true(napiBuf.length > 50)
  t.true(ncBuf.length > 50)
})

ctest('drawing fillText: both produce valid non-empty PNGs', (t) => {
  const napiCanvas = napiCreateCanvas(200, 50)
  const napiCtx = napiCanvas.getContext('2d')
  napiCtx.font = '20px sans-serif'
  napiCtx.fillStyle = '#000000'
  napiCtx.fillText('Hello World', 10, 30)
  const napiBuf = napiCanvas.toBuffer()

  const ncCanvas = ncCreateCanvas(200, 50)
  const ncCtx = ncCanvas.getContext('2d')
  ncCtx.font = '20px sans-serif'
  ncCtx.fillStyle = '#000000'
  ncCtx.fillText('Hello World', 10, 30)
  const ncBuf = ncCanvas.toBuffer()

  t.true(isPng(napiBuf))
  t.true(isPng(ncBuf))
  t.true(napiBuf.length > 50)
  t.true(ncBuf.length > 50)
})

ctest('drawing drawImage (canvas onto canvas): both produce valid non-empty PNGs', (t) => {
  // Create a source canvas with both libraries
  const napiSrc = napiCreateCanvas(20, 20)
  const napiSrcCtx = napiSrc.getContext('2d')
  napiSrcCtx.fillStyle = '#ff00ff'
  napiSrcCtx.fillRect(0, 0, 20, 20)

  const napiDst = napiCreateCanvas(50, 50)
  const napiDstCtx = napiDst.getContext('2d')
  napiDstCtx.drawImage(napiSrc, 10, 10)
  const napiBuf = napiDst.toBuffer()

  const ncSrc = ncCreateCanvas(20, 20)
  const ncSrcCtx = ncSrc.getContext('2d')
  ncSrcCtx.fillStyle = '#ff00ff'
  ncSrcCtx.fillRect(0, 0, 20, 20)

  const ncDst = ncCreateCanvas(50, 50)
  const ncDstCtx = ncDst.getContext('2d')
  ncDstCtx.drawImage(ncSrc, 10, 10)
  const ncBuf = ncDst.toBuffer()

  t.true(isPng(napiBuf))
  t.true(isPng(ncBuf))
  t.true(napiBuf.length > 50)
  t.true(ncBuf.length > 50)
})

// ---------------------------------------------------------------------------
// Combined drawing operations
// ---------------------------------------------------------------------------

ctest('drawing complex scene: both produce valid non-empty PNGs', (t) => {
  // Draw the same complex scene with both libraries
  function drawScene(ctx: any) {
    // Background
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 200, 200)

    // Red rectangle
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(10, 10, 80, 80)

    // Blue stroked rectangle
    ctx.strokeStyle = '#0000ff'
    ctx.lineWidth = 2
    ctx.strokeRect(50, 50, 80, 80)

    // Green circle
    ctx.beginPath()
    ctx.arc(150, 50, 30, 0, 2 * Math.PI)
    ctx.fillStyle = '#00ff00'
    ctx.fill()

    // Text
    ctx.fillStyle = '#000000'
    ctx.font = '16px sans-serif'
    ctx.fillText('Test', 10, 180)
  }

  const napiCanvas = napiCreateCanvas(200, 200)
  drawScene(napiCanvas.getContext('2d'))
  const napiBuf = napiCanvas.toBuffer()

  const ncCanvas = ncCreateCanvas(200, 200)
  drawScene(ncCanvas.getContext('2d'))
  const ncBuf = ncCanvas.toBuffer()

  t.true(isPng(napiBuf))
  t.true(isPng(ncBuf))
  t.true(napiBuf.length > 200, 'napi complex scene PNG should be substantial')
  t.true(ncBuf.length > 200, 'node-canvas complex scene PNG should be substantial')
})

// ---------------------------------------------------------------------------
// API shape compatibility: both canvas instances have same method names
// ---------------------------------------------------------------------------

ctest('API shape: both canvas instances expose the same core methods', (t) => {
  const napiCanvas = napiCreateCanvas(10, 10)
  const ncCanvas = ncCreateCanvas(10, 10)

  const coreMethods = ['getContext', 'toBuffer', 'toDataURL', 'createPNGStream', 'createJPEGStream']

  for (const method of coreMethods) {
    t.is(typeof (napiCanvas as any)[method], 'function', `napi canvas should have ${method}`)
    t.is(typeof (ncCanvas as any)[method], 'function', `node-canvas should have ${method}`)
  }
})

ctest('API shape: both contexts expose the same core drawing methods', (t) => {
  const napiCtx = napiCreateCanvas(10, 10).getContext('2d')
  const ncCtx = ncCreateCanvas(10, 10).getContext('2d')

  const coreMethods = [
    'fillRect',
    'strokeRect',
    'clearRect',
    'fillText',
    'strokeText',
    'beginPath',
    'closePath',
    'moveTo',
    'lineTo',
    'arc',
    'arcTo',
    'bezierCurveTo',
    'quadraticCurveTo',
    'fill',
    'stroke',
    'drawImage',
    'createLinearGradient',
    'createRadialGradient',
    'createPattern',
    'save',
    'restore',
    'scale',
    'rotate',
    'translate',
    'transform',
    'setTransform',
    'getImageData',
    'putImageData',
  ]

  for (const method of coreMethods) {
    t.is(typeof (napiCtx as any)[method], 'function', `napi context should have ${method}`)
    t.is(typeof (ncCtx as any)[method], 'function', `node-canvas context should have ${method}`)
  }
})

// ---------------------------------------------------------------------------
// Factory function signatures match
// ---------------------------------------------------------------------------

ctest('API shape: both export createCanvas, createImageData, registerFont, deregisterAllFonts', (t) => {
  t.is(typeof napiCreateCanvas, 'function')
  t.is(typeof ncCreateCanvas, 'function')
  t.is(typeof napiCreateImageData, 'function')
  t.is(typeof ncCreateImageData, 'function')
  t.is(typeof napiRegisterFont, 'function')
  t.is(typeof ncRegisterFont, 'function')
  t.is(typeof napiDeregisterAllFonts, 'function')
  t.is(typeof ncDeregisterAllFonts, 'function')
})
