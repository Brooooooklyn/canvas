// Canvas sizes without pixels: over-limit sizes (and, below, zero sizes).
// Expected values were measured in Chrome 155 (--disable-gpu, a
// willReadFrequently canvas in a standards-mode page); arm64 and x64 gave the
// same results. Chrome gives a canvas a bitmap only when
// CanvasRenderingContextHost::IsValidImageSize holds: no side is 0 or above
// 65535, and the area is at most 32768 * 8192. Node-only APIs have no Chrome
// counterpart: they follow the layer's decisions (noted per test).
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, SvgExportFlag } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const px = (ctx: Ctx, x = 0, y = 0) => Array.from(ctx.getImageData(x, y, 1, 1).data)

const OVER_LIMIT: [number, number][] = [
  [2 ** 30, 1],
  [65536, 1],
  [65535, 4097],
  [16384, 16385],
  [100000, 100000],
]

const NO_PIXELS = { name: 'IndexSizeError', message: 'The canvas has no pixels.' }

function blueCanvas() {
  const ctx = createCanvas(4, 4).getContext('2d')
  ctx.fillStyle = '#00f'
  ctx.fillRect(0, 0, 4, 4)
  return ctx
}

test('over-limit canvases keep their size but have no pixels', (t) => {
  for (const [w, h] of OVER_LIMIT) {
    const canvas = createCanvas(w, h)
    t.deepEqual([canvas.width, canvas.height], [w, h])
    const ctx = canvas.getContext('2d')
    t.is(canvas.toDataURL(), 'data:,')
    ctx.fillStyle = '#0f0'
    ctx.fillRect(0, 0, 1, 1)
    t.deepEqual(px(ctx), [0, 0, 0, 0], `${w}x${h}`)
    t.is(canvas.toDataURL(), 'data:,')
    t.is(canvas.toDataURL('image/jpeg'), 'data:,')
  }
  // Through the setter.
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')
  canvas.width = 2 ** 30
  t.deepEqual([canvas.width, canvas.height], [2 ** 30, 10])
  ctx.fillStyle = '#0f0'
  ctx.fillRect(0, 0, 1, 1)
  t.deepEqual(px(ctx), [0, 0, 0, 0])
  t.is(canvas.toDataURL(), 'data:,')
})

test('the largest side Chrome allows still draws', (t) => {
  const canvas = createCanvas(65535, 1)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#0f0'
  ctx.fillRect(0, 0, 1, 1)
  t.deepEqual(px(ctx), [0, 255, 0, 255])
  t.true(canvas.toDataURL().startsWith('data:image/png;base64,'))
})

test('over-limit canvas: getImageData returns zeros of the asked size', (t) => {
  for (const draw of [false, true]) {
    const ctx = createCanvas(2 ** 30, 1).getContext('2d')
    if (draw) ctx.fillRect(0, 0, 5, 5)
    const data = ctx.getImageData(0, 0, 3, 2)
    t.deepEqual([data.width, data.height, data.data.length, data.colorSpace], [3, 2, 24, 'srgb'])
    t.true(data.data.every((v) => v === 0))
  }
})

test('drawImage of an over-limit canvas draws nothing', (t) => {
  for (const withContext of [true, false]) {
    const source = createCanvas(2 ** 30, 1)
    if (withContext) source.getContext('2d')
    const ctx = blueCanvas()
    // 'copy' would clear the canvas if anything were drawn.
    ctx.globalCompositeOperation = 'copy'
    ctx.drawImage(source, 0, 0)
    t.deepEqual(px(ctx), [0, 0, 255, 255])
  }
})

test('createPattern of an over-limit canvas paints transparent', (t) => {
  const expected: [Ctx['globalCompositeOperation'], number[]][] = [
    ['source-over', [0, 0, 255, 255]],
    ['copy', [0, 0, 0, 0]],
    ['source-in', [0, 0, 0, 0]],
    ['destination-in', [0, 0, 0, 0]],
  ]
  for (const [op, pixel] of expected) {
    const source = createCanvas(2 ** 30, 1)
    source.getContext('2d')
    const ctx = blueCanvas()
    const pattern = ctx.createPattern(source, 'repeat')
    t.is(pattern?.constructor.name, 'CanvasPattern')
    ctx.globalCompositeOperation = op
    ctx.fillStyle = pattern!
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual(px(ctx), pixel, op)
  }
})

test('toBlob of an over-limit canvas calls back null', async (t) => {
  const canvas = createCanvas(2 ** 30, 1)
  canvas.getContext('2d')
  const blob = await new Promise((resolve) => canvas.toBlob(resolve))
  t.is(blob, null)
})

test('convertToBlob of an over-limit canvas rejects with IndexSizeError', async (t) => {
  const canvas = createCanvas(2 ** 30, 1)
  // A rejected promise, not a synchronous throw.
  const promise = canvas.convertToBlob()
  t.true(promise instanceof Promise)
  // Chrome's OffscreenCanvas text, for every canvas without pixels.
  await t.throwsAsync(promise, {
    name: 'IndexSizeError',
    message: "Failed to execute 'convertToBlob' on 'OffscreenCanvas': The size of the OffscreenCanvas is zero.",
  })
})

test('Node-only encoders on an over-limit canvas: IndexSizeError, data URLs are data:,', async (t) => {
  // No Chrome counterpart (layer decision): the Node-only encoders throw, or
  // reject, an IndexSizeError; toDataURLAsync answers as toDataURL does.
  const canvas = createCanvas(2 ** 30, 1)
  canvas.getContext('2d')
  t.throws(() => canvas.encodeSync('png'), NO_PIXELS)
  t.throws(() => canvas.toBuffer('image/png'), NO_PIXELS)
  t.throws(() => canvas.data(), NO_PIXELS)
  t.throws(() => canvas.encodeStream('png'), NO_PIXELS)
  // @ts-expect-error savePNG is not typed
  t.throws(() => canvas.savePng(join(tmpdir(), 'napi-rs-canvas-no-pixels.png')), NO_PIXELS)
  const encoded = canvas.encode('png')
  t.true(encoded instanceof Promise)
  await t.throwsAsync(encoded, NO_PIXELS)
  t.is(await canvas.toDataURLAsync(), 'data:,')
  t.is(await canvas.toDataURLAsync('image/webp'), 'data:,')
})

test('SvgCanvas sizes have no Chrome limit', (t) => {
  // SvgCanvas has no Chrome counterpart: only a zero size means no pixels.
  const canvas = createCanvas(70000, 2, SvgExportFlag.NoPrettyXML)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#0f0'
  ctx.fillRect(0, 0, 1, 1)
  t.deepEqual(px(ctx), [0, 255, 0, 255])
  t.true(canvas.getContent().toString().includes('<rect'))
})

test('external memory stays balanced across sizes without pixels', (t) => {
  // V8 aborts when a finalizer gives back more external memory than was
  // reported; run in a child so an abort fails only this test.
  const script = `
    const { createCanvas, PDFDocument } = require('./index.js')
    function make() {
      const doc = new PDFDocument()
      doc.beginPage(100, 100)
      doc.endPage()
      doc.close()
      const a = createCanvas(2 ** 30, 1)
      a.getContext('2d').fillRect(0, 0, 1, 1)
      const b = createCanvas(100, 100)
      b.width = 2 ** 30
      b.width = 100
      b.height = 100000
    }
    for (let i = 0; i < 4; i++) make()
    gc(); gc()
    setTimeout(() => { gc(); console.log('ok') }, 20)
  `
  const child = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
    encoding: 'utf8',
  })
  t.is(child.status, 0, child.stderr)
  t.is(child.stdout.trim(), 'ok')
})
