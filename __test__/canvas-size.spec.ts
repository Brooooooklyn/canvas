// Canvas sizes without pixels: over-limit sizes (and, below, zero sizes).
// Expected values were measured in Chrome 155 (--disable-gpu, a
// willReadFrequently canvas in a standards-mode page); arm64 and x64 gave the
// same results. Chrome gives a canvas a bitmap only when
// CanvasRenderingContextHost::IsValidImageSize holds: no side is 0 or above
// 65535, and the area is at most 32768 * 8192. Node-only APIs have no Chrome
// counterpart: they follow the layer's decisions (noted per test).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, ImageData, LottieAnimation, SvgExportFlag } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const px = (ctx: Ctx, x = 0, y = 0) => Array.from(ctx.getImageData(x, y, 1, 1).data)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// LottieAnimation (no Chrome counterpart) renders a frame as a draw.
const animation = LottieAnimation.loadFromData(readFileSync(join(ROOT, 'example/flat-lottie.json'), 'utf-8'))
const FRAME = { x: 0, y: 0, width: 64, height: 64 }

const OVER_LIMIT: [number, number][] = [
  [2 ** 30, 1],
  [65536, 1],
  [65535, 4097],
  [16384, 16385],
  [100000, 100000],
]

const NO_PIXELS = { name: 'IndexSizeError', message: 'The canvas has no pixels.' }

// Untyped access for values the typings reject on purpose.
const loose = <T>(value: T) => value as any

const ZERO: [number, number][] = [
  [0, 20],
  [20, 0],
  [0, 0],
]

const ZERO_SOURCE = (method: string) => ({
  name: 'InvalidStateError',
  message: `Failed to execute '${method}' on 'CanvasRenderingContext2D': The image argument is a canvas element with a width or height of 0.`,
})

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
    cwd: ROOT,
    encoding: 'utf8',
  })
  t.is(child.status, 0, child.stderr)
  t.is(child.stdout.trim(), 'ok')
})

// [value, width, height] for the width and height setters (HTML: a reflected
// unsigned long, default 300 x 150 above 2147483647). Layer 02's tests pin the
// other rows of this table.
const SETTER_SIZES: [unknown, number, number][] = [
  [0, 0, 0],
  [NaN, 0, 0],
  [-0.5, 0, 0],
  ['abc', 0, 0],
  [null, 0, 0],
  [undefined, 0, 0],
  [Infinity, 0, 0],
  [-Infinity, 0, 0],
  [4294967296, 0, 0],
  [' 8 ', 8, 8],
  ['1e2', 100, 100],
  [4294967295, 300, 150],
  [-2147483648, 300, 150],
]

test('canvas width and height setters keep 0 and convert like Chrome', (t) => {
  for (const make of [() => createCanvas(4, 4), () => createCanvas(4, 4, SvgExportFlag.NoPrettyXML)]) {
    for (const [value, width, height] of SETTER_SIZES) {
      const a = loose(make())
      a.width = value
      const b = loose(make())
      b.height = value
      t.deepEqual([a.width, b.height], [width, height], String(value))
    }
  }
  // The largest size: no pixels, so nothing is allocated. (An SvgCanvas has
  // no size limit and allocates its raster, which fails at this size.)
  const canvas = createCanvas(4, 4)
  canvas.width = 2147483647
  canvas.height = 2147483647
  t.deepEqual([canvas.width, canvas.height], [2147483647, 2147483647])
})

test('createCanvas sizes convert as the width and height setters do', (t) => {
  // No Chrome counterpart: the size is set as canvas.width and canvas.height
  // would set it, and a missing size is the default 300 x 150.
  for (const flag of [undefined, SvgExportFlag.NoPrettyXML]) {
    const make = (...args: unknown[]) => {
      const canvas = loose(createCanvas)(args[0], args[1], flag)
      return [canvas.width, canvas.height]
    }
    t.deepEqual(make(0, 0), [0, 0])
    t.deepEqual(make(-1, 10), [300, 10])
    t.deepEqual(make(10, -10), [10, 150])
    t.deepEqual(make(10.7, 20.2), [10, 20])
    t.deepEqual(make('7', null), [7, 0])
    t.deepEqual(make(NaN, 4294967297), [0, 1])
    t.deepEqual(make(), [300, 150])
    t.deepEqual(make(10), [10, 150])
    t.throws(() => make(Symbol(), 1), { instanceOf: TypeError })
    t.throws(() => make(1, 3n), { instanceOf: TypeError })
  }
  const canvas = loose(createCanvas)()
  t.true(canvas.getContext('2d').canvas === canvas)
})

test('a zero-size canvas has no pixels', (t) => {
  for (const [w, h] of ZERO) {
    const canvas = createCanvas(w, h)
    t.deepEqual([canvas.width, canvas.height], [w, h])
    t.is(canvas.toDataURL(), 'data:,')
    const ctx = canvas.getContext('2d')
    t.deepEqual(
      [canvas.toDataURL(), canvas.toDataURL('image/jpeg'), canvas.toDataURL('image/webp')],
      ['data:,', 'data:,', 'data:,'],
    )
    t.deepEqual(px(ctx), [0, 0, 0, 0])
    const data = ctx.getImageData(0, 0, 2, 3)
    t.deepEqual([data.width, data.height, data.data.length, data.colorSpace], [2, 3, 24, 'srgb'])
    t.true(data.data.every((v) => v === 0))
    const p3 = createCanvas(w, h).getContext('2d', { colorSpace: 'display-p3' })
    t.is(p3.getImageData(0, 0, 2, 2).colorSpace, 'display-p3')
  }
})

test('zero-size canvas: getImageData with a zero source size still throws', (t) => {
  const ctx = createCanvas(0, 20).getContext('2d')
  t.throws(() => ctx.getImageData(0, 0, 0, 2), {
    name: 'IndexSizeError',
    message: "Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The source width is 0.",
  })
})

test('zero-size canvas: state works but transforms and hit tests do not', (t) => {
  for (const [w, h] of ZERO) {
    const ctx = createCanvas(w, h).getContext('2d')
    ctx.fillStyle = 'red'
    ctx.save()
    ctx.translate(3, 4)
    t.is(ctx.getTransform().e, 0)
    ctx.fillStyle = 'blue'
    t.is(ctx.fillStyle, '#0000ff')
    ctx.restore()
    t.is(ctx.fillStyle, '#ff0000')
    ctx.scale(2, 2)
    ctx.rotate(1)
    ctx.transform(1, 0, 0, 1, 5, 5)
    ctx.setTransform(1, 0, 0, 1, 6, 6)
    const m = ctx.getTransform()
    t.deepEqual([m.a, m.e, m.f], [1, 0, 0])
    ctx.rect(-10, -10, 100, 100)
    t.false(ctx.isPointInPath(0, 0))
    t.false(ctx.isPointInStroke(-10, -10))
    t.notThrows(() => ctx.putImageData(ctx.createImageData(1, 1), 0, 0))
    t.is(typeof ctx.measureText('abc').width, 'number')
    t.false(ctx.isContextLost())
  }
})

test('zero-size canvas recovers after a resize', (t) => {
  for (const [w, h] of ZERO) {
    const canvas = createCanvas(w, h)
    const ctx = canvas.getContext('2d')
    ctx.fillRect(0, 0, 1, 1)
    canvas.width = 5
    canvas.height = 5
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual(px(ctx), [0, 0, 0, 255])

    const clipped = createCanvas(w, h)
    const clippedCtx = clipped.getContext('2d')
    clippedCtx.rect(0, 0, 1, 1)
    clippedCtx.clip()
    clippedCtx.save()
    clipped.width = 5
    clipped.height = 5
    clippedCtx.fillRect(0, 0, 5, 5)
    t.deepEqual(px(clippedCtx, 3, 3), [0, 0, 0, 255])
  }
})

test('drawImage of a zero-size canvas throws InvalidStateError', (t) => {
  for (const [w, h] of ZERO) {
    for (const withContext of [true, false]) {
      const source = () => {
        const canvas = createCanvas(w, h)
        if (withContext) canvas.getContext('2d')
        return canvas
      }
      const ctx = createCanvas(4, 4).getContext('2d')
      t.throws(() => ctx.drawImage(source(), 0, 0), ZERO_SOURCE('drawImage'))
      t.throws(() => ctx.drawImage(source(), 0, 0, 2, 2), ZERO_SOURCE('drawImage'))
      t.throws(() => ctx.drawImage(source(), 0, 0, 1, 1, 0, 0, 2, 2), ZERO_SOURCE('drawImage'))
      // Before the finite check.
      t.throws(() => ctx.drawImage(source(), NaN, 0), ZERO_SOURCE('drawImage'))
    }
  }
  // No Chrome counterpart: an SvgCanvas source and drawCanvas do the same.
  const ctx = createCanvas(4, 4).getContext('2d')
  t.throws(() => ctx.drawImage(createCanvas(0, 5, SvgExportFlag.NoPrettyXML), 0, 0), ZERO_SOURCE('drawImage'))
  t.throws(() => ctx.drawCanvas(createCanvas(5, 0), 0, 0), ZERO_SOURCE('drawImage'))
})

test('drawImage onto a zero-size canvas does nothing', (t) => {
  const source = createCanvas(2, 2)
  source.getContext('2d').fillRect(0, 0, 2, 2)
  for (const [w, h] of ZERO) {
    const ctx = createCanvas(w, h).getContext('2d')
    t.notThrows(() => ctx.drawImage(source, 0, 0))
    t.notThrows(() => ctx.drawCanvas(source, 0, 0))
  }
})

test('createPattern of a zero-size canvas throws InvalidStateError before the repetition check', (t) => {
  for (const [w, h] of ZERO) {
    const ctx = createCanvas(4, 4).getContext('2d')
    t.throws(() => ctx.createPattern(createCanvas(w, h), 'repeat'), ZERO_SOURCE('createPattern'))
    t.throws(() => ctx.createPattern(createCanvas(w, h), loose('bogus')), ZERO_SOURCE('createPattern'))
    const source = createCanvas(w, h)
    source.getContext('2d')
    t.throws(() => ctx.createPattern(source, 'no-repeat'), ZERO_SOURCE('createPattern'))
  }
  const ctx = createCanvas(4, 4).getContext('2d')
  t.throws(
    () => ctx.createPattern(createCanvas(0, 5, SvgExportFlag.NoPrettyXML), 'repeat'),
    ZERO_SOURCE('createPattern'),
  )
})

test('a pattern keeps its pixels when its source becomes zero-size', (t) => {
  const source = createCanvas(4, 4)
  const sourceCtx = source.getContext('2d')
  sourceCtx.fillStyle = '#f00'
  sourceCtx.fillRect(0, 0, 4, 4)
  const ctx = createCanvas(4, 4).getContext('2d')
  const pattern = ctx.createPattern(source, 'repeat')!
  source.width = 0
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, 4, 4)
  t.deepEqual(px(ctx), [255, 0, 0, 255])
})

test('toBlob and convertToBlob of a zero-size canvas', async (t) => {
  for (const [w, h] of ZERO) {
    const canvas = createCanvas(w, h)
    canvas.getContext('2d')
    t.is(await new Promise((resolve) => canvas.toBlob(resolve)), null)
    await t.throwsAsync(createCanvas(w, h).convertToBlob(), {
      name: 'IndexSizeError',
      message: "Failed to execute 'convertToBlob' on 'OffscreenCanvas': The size of the OffscreenCanvas is zero.",
    })
  }
})

test('Node-only encoders on a zero-size canvas', async (t) => {
  // No Chrome counterpart (layer decision): data() has no pixels to give, an
  // empty buffer; the encoders throw, or reject, an IndexSizeError.
  for (const [w, h] of ZERO) {
    const canvas = createCanvas(w, h)
    canvas.getContext('2d')
    t.is(canvas.data().length, 0)
    t.throws(() => canvas.encodeSync('png'), NO_PIXELS)
    t.throws(() => canvas.toBuffer('image/png'), NO_PIXELS)
    await t.throwsAsync(canvas.encode('png'), NO_PIXELS)
    t.is(await canvas.toDataURLAsync(), 'data:,')
  }
})

test('a zero-size SvgCanvas draws nothing', (t) => {
  // No Chrome counterpart: as a canvas, a 0 side means no pixels.
  const canvas = createCanvas(0, 0, SvgExportFlag.ConvertTextToPaths)
  t.deepEqual([canvas.width, canvas.height], [0, 0])
  const ctx = canvas.getContext('2d')
  t.notThrows(() => ctx.fillRect(0, 0, 10, 10))
  t.deepEqual(px(ctx), [0, 0, 0, 0])
  // Also the draws that return before they ask for the bitmap, which 'copy'
  // would otherwise send to the SVG.
  ctx.globalCompositeOperation = 'copy'
  ctx.fillRect(0, 0, 0, 0)
  ctx.strokeRect(0, 0, 0, 0)
  ctx.fill()
  ctx.stroke()
  const svg = canvas.getContent().toString()
  t.true(svg.includes('width="0"'), svg)
  t.false(svg.includes('<rect'), svg)
  t.false(svg.includes('<path'), svg)
})

// Chrome loses the context of an over-limit canvas the first time an op
// asks for the bitmap (LoseContext(kInvalidCanvasSize), which resets the
// state: canvas_rendering_context_2d.cc). [op, lost, lineWidth after]: the
// state had lineWidth 7.
const LOST_CONTEXT_OPS: [string, (ctx: Ctx) => unknown, boolean, number][] = [
  ['none', () => {}, false, 7],
  ['fillRect', (ctx) => ctx.fillRect(0, 0, 1, 1), true, 1],
  ['fillRect 0 x 0', (ctx) => ctx.fillRect(0, 0, 0, 0), false, 7],
  ['fillRect NaN', (ctx) => ctx.fillRect(NaN, 0, 1, 1), false, 7],
  ['strokeRect', (ctx) => ctx.strokeRect(0, 0, 1, 1), true, 1],
  ['save', (ctx) => ctx.save(), true, 1],
  ['restore', (ctx) => ctx.restore(), false, 7],
  ['translate', (ctx) => ctx.translate(1, 1), true, 1],
  ['translate NaN', (ctx) => ctx.translate(NaN, 1), true, 1],
  ['scale', (ctx) => ctx.scale(2, 2), true, 1],
  ['rotate', (ctx) => ctx.rotate(1), true, 1],
  ['transform', (ctx) => ctx.transform(1, 0, 0, 1, 1, 1), true, 1],
  ['setTransform', (ctx) => ctx.setTransform(1, 0, 0, 1, 2, 2), true, 1],
  ['setTransform NaN', (ctx) => ctx.setTransform(NaN, 0, 0, 1, 2, 2), false, 7],
  ['resetTransform', (ctx) => ctx.resetTransform(), true, 1],
  ['getTransform', (ctx) => ctx.getTransform(), false, 7],
  [
    'clip',
    (ctx) => {
      ctx.rect(0, 0, 1, 1)
      ctx.clip()
    },
    true,
    1,
  ],
  ['beginPath', (ctx) => ctx.beginPath(), false, 7],
  ['rect', (ctx) => ctx.rect(0, 0, 1, 1), false, 7],
  [
    'fillStyle',
    (ctx) => {
      ctx.fillStyle = 'red'
    },
    false,
    7,
  ],
  ['fill of an empty path', (ctx) => ctx.fill(), false, 7],
  [
    'fill',
    (ctx) => {
      ctx.rect(0, 0, 1, 1)
      ctx.fill()
    },
    true,
    1,
  ],
  ['stroke of an empty path', (ctx) => ctx.stroke(), false, 7],
  [
    'stroke',
    (ctx) => {
      ctx.rect(0, 0, 1, 1)
      ctx.stroke()
    },
    true,
    1,
  ],
  ['clearRect', (ctx) => ctx.clearRect(0, 0, 1, 1), true, 1],
  ['fillText', (ctx) => ctx.fillText('a', 0, 5), true, 1],
  ['fillText of an empty text', (ctx) => ctx.fillText('', 0, 5), true, 1],
  ['strokeText', (ctx) => ctx.strokeText('a', 0, 5), true, 1],
  ['measureText', (ctx) => ctx.measureText('a'), false, 7],
  ['putImageData', (ctx) => ctx.putImageData(new ImageData(1, 1), 0, 0), true, 1],
  ['getImageData', (ctx) => ctx.getImageData(0, 0, 1, 1), false, 7],
  ['drawImage', (ctx) => ctx.drawImage(createCanvas(2, 2), 0, 0), true, 1],
  ['drawImage NaN', (ctx) => ctx.drawImage(createCanvas(2, 2), NaN, 0), true, 1],
  ['isPointInPath', (ctx) => ctx.isPointInPath(0, 0), true, 1],
  ['isPointInStroke', (ctx) => ctx.isPointInStroke(0, 0), true, 1],
  ['reset', (ctx) => ctx.reset(), false, 1],
  ['toDataURL', (ctx) => loose(ctx).canvas.toDataURL(), false, 7],
  ['createPattern', (ctx) => ctx.createPattern(createCanvas(2, 2), 'repeat'), false, 7],
  ['getContextAttributes', (ctx) => ctx.getContextAttributes(), false, 7],
  ['setLineDash', (ctx) => ctx.setLineDash([1, 2]), false, 7],
  ['createImageData', (ctx) => ctx.createImageData(1, 1), false, 7],
  ['LottieAnimation.render', (ctx) => animation.render(ctx, FRAME), true, 1],
]

test('over-limit canvas: these ops lose the context and reset the state', (t) => {
  for (const [name, op, lost, lineWidth] of LOST_CONTEXT_OPS) {
    const canvas = createCanvas(10, 10)
    const ctx = canvas.getContext('2d')
    canvas.width = 2 ** 30
    ctx.lineWidth = 7
    op(ctx)
    t.deepEqual([ctx.isContextLost(), ctx.lineWidth], [lost, lineWidth], name)
  }
})

test('over-limit canvas: save() itself loses the state', (t) => {
  const ctx = createCanvas(2 ** 30, 1).getContext('2d')
  ctx.fillStyle = 'blue'
  ctx.save()
  ctx.translate(3, 4)
  t.is(ctx.getTransform().e, 0)
  t.is(ctx.fillStyle, '#000000')
  t.true(ctx.isContextLost())
})

test('lost context: setters work, save/restore and transforms do nothing', (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')
  canvas.width = 2 ** 30
  ctx.fillRect(0, 0, 1, 1)
  t.true(ctx.isContextLost())
  ctx.fillStyle = 'red'
  ctx.lineWidth = 5
  t.deepEqual([ctx.fillStyle, ctx.lineWidth], ['#ff0000', 5])
  ctx.translate(3, 3)
  t.is(ctx.getTransform().e, 0)
  ctx.fillStyle = 'red'
  ctx.save()
  ctx.fillStyle = 'blue'
  ctx.restore()
  t.is(ctx.fillStyle, '#0000ff')
  ctx.setLineDash([1, 2])
  t.deepEqual(ctx.getLineDash(), [1, 2])
  t.is(ctx.createImageData(2, 2).width, 2)
  // reset() resets the state but keeps the context lost.
  ctx.reset()
  t.deepEqual([ctx.isContextLost(), ctx.fillStyle], [true, '#000000'])
  // So does a size without pixels.
  canvas.width = 0
  t.true(ctx.isContextLost())
  canvas.width = 100000
  t.true(ctx.isContextLost())
})

test('LottieAnimation.render takes the bitmap first, like a draw', (t) => {
  // Created over the limit: the first frame loses the context.
  const ctx = createCanvas(2 ** 30, 1).getContext('2d')
  ctx.lineWidth = 7
  animation.render(ctx, FRAME)
  t.deepEqual([ctx.isContextLost(), ctx.lineWidth], [true, 1])
  // A lost context: render does nothing, and the context stays lost.
  ctx.lineWidth = 5
  animation.render(ctx)
  t.deepEqual([ctx.isContextLost(), ctx.lineWidth], [true, 5])
  // A zero-size canvas has no bitmap either, but keeps its context and state.
  for (const [width, height] of ZERO) {
    const canvas = createCanvas(width, height)
    const zeroCtx = canvas.getContext('2d')
    zeroCtx.lineWidth = 7
    animation.render(zeroCtx, FRAME)
    t.deepEqual([zeroCtx.isContextLost(), zeroCtx.lineWidth, canvas.toDataURL()], [false, 7, 'data:,'])
  }
})

test('a zero-size canvas never loses its context', (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')
  canvas.width = 0
  ctx.lineWidth = 7
  ctx.fillRect(0, 0, 1, 1)
  ctx.translate(2, 2)
  t.deepEqual([ctx.isContextLost(), ctx.lineWidth, ctx.getTransform().e], [false, 7, 0])
})

test('back to a valid size after an over-limit size', async (t) => {
  // Chrome restores a lost context two tasks after the resize; here it is
  // restored at the resize. Only the cases that agree are pinned.
  for (const touch of [
    () => {},
    (ctx: Ctx) => ctx.getImageData(0, 0, 1, 1),
    (ctx: Ctx) => loose(ctx).canvas.toDataURL(),
  ]) {
    const canvas = createCanvas(10, 10)
    const ctx = canvas.getContext('2d')
    canvas.width = 2 ** 30
    touch(ctx)
    canvas.width = 10
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual([ctx.isContextLost(), px(ctx)], [false, [0, 0, 0, 255]])
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')
  canvas.width = 2 ** 30
  ctx.fillRect(0, 0, 1, 1)
  t.true(ctx.isContextLost())
  for (let i = 0; i < 4; i++) await tick()
  canvas.width = 10
  await tick()
  await tick()
  ctx.fillRect(0, 0, 4, 4)
  t.deepEqual([ctx.isContextLost(), px(ctx)], [false, [0, 0, 0, 255]])
})
