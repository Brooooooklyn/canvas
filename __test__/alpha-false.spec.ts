// alpha:false canvases. Unless a test says otherwise, every expected value was
// measured in Chrome 155 CPU canvas (--disable-gpu, getContext('2d', { alpha:
// false, willReadFrequently: true })). Chrome keeps such a canvas in a kOpaque
// surface cleared to black.
import test from 'ava'

import { createCanvas, ImageData, loadImage, SvgExportFlag } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const px = (ctx: Ctx, x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data]

function opaque(width: number, height: number) {
  const canvas = createCanvas(width, height)
  return { canvas, ctx: canvas.getContext('2d', { alpha: false }) }
}

function transparent(width: number, height: number) {
  const canvas = createCanvas(width, height)
  return { canvas, ctx: canvas.getContext('2d') }
}

// Chrome allocates the backing store lazily and reads a never-drawn alpha:false
// canvas as 0,0,0,0 (canvas_rendering_context_2d.cc GetImage, then the zero
// fill in getImageData). We keep it opaque black from creation: that is what the
// spec asks for and what Chrome shows on screen.
test('alpha:false starts opaque black', (t) => {
  t.deepEqual(px(opaque(4, 4).ctx, 0, 0), [0, 0, 0, 255])
})

test('alpha:false is opaque black after a draw, a resize and reset()', (t) => {
  const { canvas, ctx } = opaque(4, 4)
  ctx.fillStyle = 'red'
  ctx.fillRect(3, 3, 1, 1)
  t.deepEqual(px(ctx, 0, 0), [0, 0, 0, 255])
  ctx.fillRect(0, 0, 4, 4)
  canvas.height = 6
  ctx.fillRect(3, 5, 1, 1)
  t.deepEqual(px(ctx, 0, 0), [0, 0, 0, 255])
  ctx.fillRect(0, 0, 4, 4)
  ctx.reset()
  t.deepEqual(px(ctx, 0, 0), [0, 0, 0, 255])
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.fillRect(2, 2, 2, 2)
  t.deepEqual(px(ctx, 3, 3), [128, 128, 128, 255])
  t.false(ctx.getContextAttributes().alpha)
})

test('alpha:false blends over black', (t) => {
  {
    const { ctx } = opaque(4, 4)
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual(px(ctx, 0, 0), [128, 128, 128, 255])
  }
  {
    const { ctx } = opaque(4, 4)
    ctx.globalAlpha = 0.25
    ctx.fillStyle = 'red'
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual(px(ctx, 0, 0), [64, 0, 0, 255])
  }
  {
    const { ctx } = opaque(20, 20)
    ctx.shadowColor = 'rgba(255,0,0,0.5)'
    ctx.shadowOffsetX = 5
    ctx.fillStyle = 'blue'
    ctx.fillRect(2, 2, 4, 4)
    t.deepEqual(px(ctx, 8, 3), [128, 0, 0, 255])
  }
  {
    const { ctx } = opaque(4, 4)
    ctx.fillStyle = 'rgba(255,0,0,0.5)'
    ctx.fillRect(0, 0, 4, 4)
    ctx.fillStyle = 'rgba(0,255,0,0.3)'
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual(px(ctx, 0, 0), [89, 77, 0, 255])
  }
  {
    const canvas = createCanvas(4, 4)
    const ctx = canvas.getContext('2d', { alpha: false, colorSpace: 'display-p3' })
    ctx.fillStyle = 'red'
    ctx.fillRect(3, 3, 1, 1)
    t.deepEqual(px(ctx, 0, 0), [0, 0, 0, 255], 'display-p3 base')
    ctx.fillStyle = 'rgba(32,128,223,0.5)'
    ctx.fillRect(0, 0, 2, 2)
    t.deepEqual(px(ctx, 0, 0), [32, 63, 108, 255], 'display-p3 blend')
    const srgb = transparent(4, 4)
    srgb.ctx.drawImage(canvas, 0, 0)
    t.deepEqual(px(srgb.ctx, 0, 0), [19, 64, 112, 255], 'display-p3 drawn on srgb')
  }
})

// Blink GetClearFlags (canvas_2d_recorder_context.cc:1917-1926): alpha:false
// clears by filling opaque black, source-over, no anti-aliasing.
test('alpha:false clearRect gives opaque black and ignores composite, alpha, shadow and filter', (t) => {
  for (const [name, set] of [
    ['copy', (c: Ctx) => (c.globalCompositeOperation = 'copy')],
    ['source-in', (c: Ctx) => (c.globalCompositeOperation = 'source-in')],
    ['destination-out', (c: Ctx) => (c.globalCompositeOperation = 'destination-out')],
    ['globalAlpha', (c: Ctx) => (c.globalAlpha = 0.5)],
    [
      'shadow',
      (c: Ctx) => {
        c.shadowColor = 'lime'
        c.shadowOffsetX = 2
      },
    ],
    ['filter', (c: Ctx) => (c.filter = 'blur(1px)')],
  ] as const) {
    const { ctx } = opaque(6, 6)
    ctx.fillStyle = 'red'
    ctx.fillRect(0, 0, 6, 6)
    set(ctx)
    ctx.clearRect(0, 0, 2, 2)
    t.deepEqual(px(ctx, 0, 0), [0, 0, 0, 255], name)
    t.deepEqual(px(ctx, 4, 4), [255, 0, 0, 255], name)
    t.deepEqual(px(ctx, 2, 0), [255, 0, 0, 255], name)
  }
  {
    const { ctx } = opaque(6, 6)
    ctx.fillStyle = 'red'
    ctx.fillRect(0, 0, 6, 6)
    ctx.translate(2, 2)
    ctx.beginPath()
    ctx.rect(0, 0, 1, 1)
    ctx.clip()
    ctx.clearRect(0, 0, 3, 3)
    t.deepEqual(px(ctx, 2, 2), [0, 0, 0, 255], 'clip')
    t.deepEqual(px(ctx, 3, 3), [255, 0, 0, 255], 'clip')
  }
  {
    const { ctx } = opaque(6, 6)
    ctx.fillStyle = 'red'
    ctx.fillRect(0, 0, 6, 6)
    ctx.clearRect(0.5, 0.5, 2, 2)
    t.deepEqual(
      [px(ctx, 0, 0), px(ctx, 1, 1), px(ctx, 2, 2), px(ctx, 3, 3)],
      [
        [255, 0, 0, 255],
        [0, 0, 0, 255],
        [0, 0, 0, 255],
        [255, 0, 0, 255],
      ],
      'fractional',
    )
  }
  {
    // The whole-canvas clearRect takes a fast path.
    const { ctx } = opaque(6, 6)
    ctx.fillStyle = 'red'
    ctx.fillRect(0, 0, 6, 6)
    ctx.clearRect(0, 0, 6, 6)
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillRect(0, 0, 6, 6)
    t.deepEqual(px(ctx, 0, 0), [128, 128, 128, 255], 'whole canvas')
  }
})

// Blink PutByteArray labels the pixels kOpaque, so the write is a memcpy and
// getImageData reads the bytes back as given, alpha included
// (base_rendering_context_2d.cc:619-643). The spec would ignore the alpha.
test('alpha:false putImageData stores the bytes as given, like Chrome', async (t) => {
  const bytes = [10, 20, 30, 0, 10, 20, 30, 128, 10, 20, 30, 255, 200, 100, 50, 1]
  const { canvas, ctx } = opaque(4, 1)
  ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes), 4, 1), 0, 0)
  const row = (c: Ctx) => [0, 1, 2, 3].map((x) => px(c, x, 0))
  t.deepEqual(row(ctx), [
    [10, 20, 30, 0],
    [10, 20, 30, 128],
    [10, 20, 30, 255],
    [200, 100, 50, 1],
  ])
  const url = canvas.toDataURL('image/png')
  t.is(Buffer.from(url.split(',')[1], 'base64')[25], 6, 'PNG color type RGBA')
  const decoded = transparent(4, 1)
  decoded.ctx.drawImage(await loadImage(url), 0, 0)
  t.deepEqual(row(decoded.ctx), [
    [0, 0, 0, 0],
    [10, 20, 30, 128],
    [10, 20, 30, 255],
    [255, 0, 0, 1],
  ])
  const drawn = transparent(4, 1)
  drawn.ctx.drawImage(canvas, 0, 0)
  t.deepEqual(row(drawn.ctx), [
    [0, 0, 0, 0],
    [20, 40, 60, 128],
    [10, 20, 30, 255],
    [255, 255, 255, 1],
  ])
  // source-over keeps the stored alpha: no reset for it.
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.fillRect(0, 0, 4, 1)
  t.deepEqual(row(ctx), [
    [133, 138, 143, 128],
    [133, 138, 143, 192],
    [133, 138, 143, 255],
    [228, 178, 153, 128],
  ])
  const dirty = opaque(4, 1)
  dirty.ctx.fillStyle = 'red'
  dirty.ctx.fillRect(0, 0, 4, 1)
  dirty.ctx.putImageData(
    new ImageData(new Uint8ClampedArray([10, 20, 30, 0, 10, 20, 30, 0, 10, 20, 30, 0, 10, 20, 30, 0]), 4, 1),
    0,
    0,
    1,
    0,
    2,
    1,
  )
  t.deepEqual(row(dirty.ctx), [
    [255, 0, 0, 255],
    [10, 20, 30, 0],
    [10, 20, 30, 0],
    [255, 0, 0, 255],
  ])
})

// The unpremultiplying readback zeroes RGB where alpha is 0, as Skia does; an
// alpha:false canvas can hold such pixels (see putImageData above). For
// alpha:true nothing changes: premultiplied pixels with alpha 0 already have
// RGB 0, and every pixel still reads as Skia's conversion of the stored
// premultiplied bytes (SkSwizzler_opts.inc), which main 0b502f6 also passes.
test('alpha:true getImageData still unpremultiplies the stored bytes like Skia', (t) => {
  const { canvas, ctx } = transparent(64, 64)
  for (let i = 0; i < 64; i++) {
    ctx.fillStyle = `rgba(${(i * 37) % 256},${(i * 91) % 256},${(i * 53) % 256},${i / 63})`
    ctx.beginPath()
    ctx.arc((i * 13) % 64, (i * 29) % 64, 3 + (i % 9), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.clearRect(20, 20, 12, 12)
  const read = ctx.getImageData(0, 0, 64, 64).data
  const stored = canvas.data()
  const f = Math.fround
  const unpremul = (c: number, a: number) => {
    if (a === 255) return c
    if (a === 0) return 0
    const reciprocal = f(1 / f(a * f(1 / 255)))
    const v = Math.min(f(f(f(c * f(1 / 255)) * reciprocal) * 255), 255)
    // round half to even
    const r = Math.round(v)
    return r - v === 0.5 && r % 2 === 1 ? r - 1 : r
  }
  let zeroAlpha = 0
  for (let i = 0; i < read.length; i += 4) {
    const a = stored[i + 3]
    if (a === 0) zeroAlpha++
    const expected = [unpremul(stored[i], a), unpremul(stored[i + 1], a), unpremul(stored[i + 2], a), a]
    if (read[i] !== expected[0] || read[i + 1] !== expected[1] || read[i + 2] !== expected[2] || read[i + 3] !== a) {
      t.fail(
        `pixel ${i / 4}: read ${Array.from(read.subarray(i, i + 4))}, stored ${Array.from(stored.subarray(i, i + 4))}`,
      )
      return
    }
  }
  t.true(zeroAlpha > 0)
})

test('an alpha:false canvas is opaque as a source and when encoded', async (t) => {
  const a = opaque(4, 4)
  a.ctx.fillStyle = 'red'
  a.ctx.fillRect(0, 0, 4, 4)
  a.ctx.clearRect(0, 0, 2, 2)
  const viaImage = transparent(4, 4)
  viaImage.ctx.drawImage(a.canvas, 0, 0)
  t.deepEqual(px(viaImage.ctx, 0, 0), [0, 0, 0, 255], 'drawImage')
  const viaPattern = transparent(4, 4)
  viaPattern.ctx.fillStyle = viaPattern.ctx.createPattern(a.canvas, 'repeat')!
  viaPattern.ctx.fillRect(0, 0, 4, 4)
  t.deepEqual(px(viaPattern.ctx, 0, 0), [0, 0, 0, 255], 'createPattern')
  const scaled = transparent(8, 8)
  scaled.ctx.drawImage(a.canvas, 0, 0, 8, 8)
  t.deepEqual(px(scaled.ctx, 0, 0), [0, 0, 0, 255], 'scaled drawImage')
  // drawCanvas has no Chrome counterpart; it must agree with drawImage.
  const viaCanvas = transparent(4, 4)
  viaCanvas.ctx.drawCanvas(a.canvas, 0, 0)
  t.deepEqual(px(viaCanvas.ctx, 0, 0), [0, 0, 0, 255], 'drawCanvas')
  for (const mime of ['image/png', 'image/jpeg', 'image/webp'] as const) {
    const url = a.canvas.toDataURL(mime, 1)
    const decoded = transparent(4, 4)
    decoded.ctx.drawImage(await loadImage(url), 0, 0)
    const [r, g, b, alpha] = px(decoded.ctx, 0, 0)
    // Chrome: 0,0,0,255 for all three. The lossy codecs are held to "opaque
    // and near black": our JPEG at quality 1 already differs by 1 on alpha:true.
    t.is(alpha, 255, mime)
    t.true(r < 8 && g < 8 && b < 8, `${mime}: ${r},${g},${b}`)
    if (mime === 'image/png') t.deepEqual([r, g, b], [0, 0, 0], mime)
  }
  // Chrome encodes from a kUnpremul readback, so the PNG stays RGBA.
  t.is(a.canvas.toBuffer('image/png')[25], 6, 'toBuffer PNG color type')
  t.is(Buffer.from(a.canvas.toDataURL().split(',')[1], 'base64')[25], 6, 'toDataURL PNG color type')
  t.is((await a.canvas.encode('png'))[25], 6, 'encode PNG color type')
})

// No Chrome counterpart (canvas.ctx is internal); the spec says context
// creation gives a new opaque black bitmap.
test('state set through canvas.ctx before getContext does not reach the alpha:false base', (t) => {
  const canvas = createCanvas(10, 10)
  const pre = (canvas as any).ctx
  const g = pre.createLinearGradient(0, 0, 10, 0)
  g.addColorStop(0, 'red')
  g.addColorStop(1, 'blue')
  pre.fillStyle = g
  pre.globalCompositeOperation = 'destination-out'
  const ctx = canvas.getContext('2d', { alpha: false })
  for (const [x, y] of [
    [0, 0],
    [9, 0],
    [5, 5],
  ]) {
    t.deepEqual(px(ctx, x, y), [0, 0, 0, 255], `${x},${y}`)
  }
})

// No Chrome counterpart; the spec's opaque black rule, as for the raster canvas.
test('SvgCanvas alpha:false: black base, again after getContent, and black clearRect', (t) => {
  const body = (s: string) => s.replace(/^.*?<svg[^>]*>/s, '').replace(/<\/svg>\s*$/, '')
  const canvas = createCanvas(10, 10, SvgExportFlag.NoPrettyXML)
  const ctx = canvas.getContext('2d', { alpha: false })
  t.is(body(canvas.getContent().toString()), '<rect width="10" height="10"/>')
  t.is(body(canvas.getContent().toString()), '<rect width="10" height="10"/>')
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 10, 10)
  ctx.clearRect(0, 0, 5, 5)
  t.is(
    body(canvas.getContent().toString()),
    '<rect width="10" height="10"/><rect fill="red" width="10" height="10"/><rect width="5" height="5"/>',
  )
  canvas.width = 20
  t.is(body(canvas.getContent().toString()), '<rect width="20" height="10"/>')
  const leaky = createCanvas(10, 10, SvgExportFlag.NoPrettyXML)
  const pre = (leaky as any).ctx
  pre.translate(5, 5)
  pre.fillStyle = 'red'
  leaky.getContext('2d', { alpha: false })
  t.is(body(leaky.getContent().toString()), '<rect width="10" height="10"/>')
})
