// Blink's CompositedDraw: the draws that composite through a layer with no
// bounds (canvas_2d_recorder_context.h:897-963). Every expected value was
// measured in Chrome 155 CPU canvas (--disable-gpu, getContext('2d',
// { willReadFrequently: true })) on arm64 and x64; both give the same bytes.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, loadImage, SvgExportFlag } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = (...name: string[]) => readFileSync(join(__dirname, 'fixtures', ...name))

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>
type Op = Ctx['globalCompositeOperation']

const px = (ctx: Ctx, x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data]

const BLUE = [0, 128, 255, 255]
const BG = [200, 100, 50, 255]
const CLEAR = [0, 0, 0, 0]

// 6x6 tile for the pattern rows.
function cullTile() {
  const tile = createCanvas(6, 6)
  const c = tile.getContext('2d')
  c.fillStyle = 'rgb(0,128,255)'
  c.fillRect(0, 0, 3, 3)
  c.fillRect(3, 3, 3, 3)
  c.fillStyle = 'rgba(255,220,0,0.5)'
  c.fillRect(3, 0, 3, 3)
  return tile
}

// Paints the DEVICE rect (10,10)-(22,22) on a 60x40 rgb(200,100,50) canvas
// through the transform `xf`, so the user-space rect can lie far off the canvas.
function deviceRect(
  op: Op,
  xf: (c: Ctx) => void,
  setup: (c: Ctx) => void = () => {},
  style: (c: Ctx) => string | CanvasPattern = () => 'rgb(0,128,255)',
) {
  const ctx = createCanvas(60, 40).getContext('2d')
  ctx.fillStyle = 'rgb(200,100,50)'
  ctx.fillRect(0, 0, 60, 40)
  xf(ctx)
  const m = ctx.getTransform().inverse()
  ctx.globalCompositeOperation = op
  setup(ctx)
  ctx.fillStyle = style(ctx) as string
  const p = [
    [10, 10],
    [22, 10],
    [22, 22],
    [10, 22],
  ].map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f])
  ctx.beginPath()
  ctx.moveTo(p[0][0], p[0][1])
  for (const q of p.slice(1)) ctx.lineTo(q[0], q[1])
  ctx.closePath()
  ctx.fill()
  return ctx
}

const XF = {
  txm500: (c: Ctx) => c.translate(-500, 0),
  txp500: (c: Ctx) => c.translate(500, 300),
  sc01: (c: Ctx) => c.scale(0.1, 0.1),
  sc4: (c: Ctx) => c.scale(4, 4),
}

const blur1 = (c: Ctx) => {
  c.filter = 'blur(1px)'
}

test('source-in keeps a draw whose user rect is off the canvas', (t) => {
  for (const [name, xf] of [
    ['txm500', XF.txm500],
    ['txp500', XF.txp500],
    ['sc01', XF.sc01],
  ] as const) {
    const ctx = deviceRect('source-in', xf)
    t.deepEqual(px(ctx, 15, 15), BLUE, name)
    t.deepEqual(px(ctx, 25, 15), CLEAR, name)
    t.deepEqual(px(ctx, 45, 30), CLEAR, name)
  }
})

test('destination-in keeps the backdrop under a moved draw', (t) => {
  const ctx = deviceRect('destination-in', XF.txm500)
  t.deepEqual(px(ctx, 15, 15), BG)
  t.deepEqual(px(ctx, 45, 30), CLEAR)
})

test('destination-atop keeps the backdrop under a moved draw', (t) => {
  const ctx = deviceRect('destination-atop', XF.txp500)
  t.deepEqual(px(ctx, 15, 15), BG)
  t.deepEqual(px(ctx, 45, 30), CLEAR)
})

test('a filtered copy under a translate still replaces the canvas', (t) => {
  const ctx = deviceRect('copy', XF.txm500, blur1)
  t.deepEqual(px(ctx, 15, 15), BLUE)
  t.deepEqual(px(ctx, 25, 15), CLEAR)
  t.deepEqual(px(ctx, 45, 30), CLEAR)
})

test('a filtered source-in under scale(0.1) still composites', (t) => {
  const ctx = deviceRect('source-in', XF.sc01, blur1)
  t.deepEqual(px(ctx, 15, 15), BLUE)
  t.deepEqual(px(ctx, 45, 30), CLEAR)
})

test('a filtered source-out under a translate clears the canvas', (t) => {
  const ctx = deviceRect('source-out', XF.txm500, blur1)
  t.deepEqual(px(ctx, 15, 15), CLEAR)
  t.deepEqual(px(ctx, 45, 30), CLEAR)
})

test('a filtered destination-in under a translate', (t) => {
  const ctx = deviceRect('destination-in', XF.txm500, blur1)
  t.deepEqual(px(ctx, 15, 15), BG)
  t.deepEqual(px(ctx, 45, 30), CLEAR)
})

test('source-in with a blurred shadow under a translate', (t) => {
  const ctx = deviceRect('source-in', XF.txm500, (c) => {
    c.shadowColor = 'rgba(0,0,0,0.8)'
    c.shadowOffsetX = 6
    c.shadowBlur = 4
  })
  t.deepEqual(px(ctx, 15, 15), [0, 128, 255, 84])
  t.deepEqual(px(ctx, 25, 15), CLEAR)
  t.deepEqual(px(ctx, 45, 30), CLEAR)
})

const hardShadow = (c: Ctx) => {
  c.shadowColor = 'rgba(0,0,0,0.8)'
  c.shadowOffsetX = 6
  c.shadowBlur = 0
}
const cullPattern = (c: Ctx) => c.createPattern(cullTile(), 'repeat')!

test('copy with a pattern shadow under a translate', (t) => {
  const ctx = deviceRect('copy', XF.txm500, hardShadow, cullPattern)
  t.deepEqual(px(ctx, 15, 15), BLUE)
  t.deepEqual(px(ctx, 25, 15), CLEAR)
  t.deepEqual(px(ctx, 45, 30), CLEAR)
})

test('a filtered full-canvas mode clears the canvas when the draw is off canvas', (t) => {
  for (const op of ['source-in', 'destination-in', 'destination-atop', 'source-out'] as const) {
    const ctx = createCanvas(20, 20).getContext('2d')
    ctx.fillStyle = 'rgb(200,100,50)'
    ctx.fillRect(0, 0, 20, 20)
    ctx.globalCompositeOperation = op
    ctx.filter = 'blur(1px)'
    ctx.fillStyle = 'blue'
    ctx.fillRect(100, 100, 5, 5)
    t.deepEqual(px(ctx, 5, 5), CLEAR, op)
  }
})

// The same layers at identity, the common case. Base already drew these.
test('full-canvas modes at identity draw like Chrome', (t) => {
  const setups = {
    shadow: (c: Ctx) => {
      c.shadowColor = 'rgba(0,0,0,0.8)'
      c.shadowOffsetX = 6
      c.shadowBlur = 4
    },
    blur: blur1,
    plain: () => {},
  }
  const expected: Record<string, number[][]> = {
    'source-in.shadow': [CLEAR, [0, 128, 255, 84], [0, 127, 255, 120], CLEAR, CLEAR, CLEAR],
    'destination-in.shadow': [CLEAR, [200, 100, 49, 84], [200, 100, 51, 120], CLEAR, CLEAR, CLEAR],
    'source-out.shadow': [BLUE, BLUE, BLUE, CLEAR, CLEAR, CLEAR],
    'copy.shadow': [BLUE, BLUE, BLUE, CLEAR, CLEAR, CLEAR],
    'source-in.blur': [[0, 129, 255, 113], BLUE, [0, 129, 255, 113], CLEAR, [0, 129, 255, 85], CLEAR],
    'destination-in.blur': [[201, 99, 50, 113], BG, [201, 99, 50, 113], CLEAR, [201, 99, 51, 85], CLEAR],
    'source-out.blur': [CLEAR, CLEAR, CLEAR, CLEAR, CLEAR, CLEAR],
    'copy.blur': [[0, 129, 255, 113], BLUE, [0, 129, 255, 113], CLEAR, [0, 129, 255, 85], CLEAR],
    'source-in.plain': [BLUE, BLUE, BLUE, CLEAR, CLEAR, CLEAR],
    'destination-in.plain': [BG, BG, BG, CLEAR, CLEAR, CLEAR],
    'source-out.plain': [CLEAR, CLEAR, CLEAR, CLEAR, CLEAR, CLEAR],
    'destination-atop.plain': [BG, BG, BG, CLEAR, CLEAR, CLEAR],
    'copy.plain': [BLUE, BLUE, BLUE, CLEAR, CLEAR, CLEAR],
  }
  for (const [key, want] of Object.entries(expected)) {
    const [op, setup] = key.split('.') as [Op, keyof typeof setups]
    const ctx = createCanvas(60, 40).getContext('2d')
    ctx.fillStyle = 'rgb(200,100,50)'
    ctx.fillRect(0, 0, 60, 40)
    ctx.globalCompositeOperation = op
    setups[setup](ctx)
    ctx.fillStyle = 'rgb(0,128,255)'
    ctx.fillRect(10, 10, 12, 12)
    const got = [
      [10, 10],
      [15, 15],
      [21, 21],
      [25, 15],
      [22, 12],
      [45, 30],
    ].map(([x, y]) => px(ctx, x, y))
    t.deepEqual(got, want, key)
  }
})

// ---- Shadows: Blink's DrawInternal routing (canvas_2d_recorder_context.h:
// 571-597, 711-727, 806-857, 897-963) and its image types
// (canvas_rendering_context_2d_state.cc:814-868).

test('multiply with a pattern shadow under scale(4)', (t) => {
  const ctx = deviceRect('multiply', XF.sc4, hardShadow, cullPattern)
  t.deepEqual(px(ctx, 14, 11), [138, 80, 33, 255])
})

test('destination-atop with a pattern shadow under scale(4)', (t) => {
  const ctx = deviceRect('destination-atop', XF.sc4, hardShadow, cullPattern)
  t.deepEqual(px(ctx, 19, 14), [130, 110, 122, 255])
})

// 6x6 tile for the shadow scenes.
function shadowTile() {
  const tile = createCanvas(6, 6)
  const c = tile.getContext('2d')
  c.fillStyle = 'rgba(255,220,0,1)'
  c.fillRect(0, 0, 3, 3)
  c.fillRect(3, 3, 3, 3)
  c.fillStyle = 'rgba(120,0,200,0.5)'
  c.fillRect(3, 0, 3, 3)
  return tile
}

// 48x48: rgb(200,100,50) top half, rgba(40,160,220,0.5) bottom-left quarter.
function shadowScene(op: Op, draw: (c: Ctx) => void, shadow: (c: Ctx) => void) {
  const ctx = createCanvas(48, 48).getContext('2d')
  ctx.fillStyle = 'rgb(200,100,50)'
  ctx.fillRect(0, 0, 48, 24)
  ctx.fillStyle = 'rgba(40,160,220,0.5)'
  ctx.fillRect(0, 24, 24, 24)
  shadow(ctx)
  ctx.globalCompositeOperation = op
  draw(ctx)
  return ctx
}

const DRAW = {
  pattern: (c: Ctx) => {
    c.fillStyle = c.createPattern(shadowTile(), 'repeat')!
    c.fillRect(10, 10, 28, 28)
  },
  patstroke: (c: Ctx) => {
    c.strokeStyle = c.createPattern(shadowTile(), 'repeat')!
    c.lineWidth = 6
    c.strokeRect(12, 12, 22, 22)
  },
  solid: (c: Ctx) => {
    c.fillStyle = 'rgba(0,128,255,0.8)'
    c.fillRect(10, 10, 24, 24)
  },
}

const SHADOW = {
  blur: (c: Ctx) => {
    c.shadowColor = 'rgba(0,0,0,0.6)'
    c.shadowBlur = 4
    c.shadowOffsetX = 3
    c.shadowOffsetY = 2
  },
  hard: (c: Ctx) => {
    c.shadowColor = 'rgba(0,0,0,0.6)'
    c.shadowBlur = 0
    c.shadowOffsetX = 3
    c.shadowOffsetY = 2
  },
  frac: (c: Ctx) => {
    c.shadowColor = 'rgba(80,0,0,0.7)'
    c.shadowBlur = 0
    c.shadowOffsetX = 2.5
    c.shadowOffsetY = 1.5
  },
}

test('a blurred shadow under a pattern fill takes the image-filter route', (t) => {
  const ctx = shadowScene('source-over', DRAW.pattern, SHADOW.blur)
  t.deepEqual(px(ctx, 39, 17), [144, 72, 36, 255])
  t.deepEqual(px(ctx, 20, 40), [29, 115, 156, 149])
})

test('multiply with a pattern shadow is a composited draw', (t) => {
  const ctx = shadowScene('multiply', DRAW.pattern, SHADOW.blur)
  t.deepEqual(px(ctx, 27, 24), [55, 0, 92, 175])
})

test('a blurred shadow under a pattern stroke takes the image-filter route', (t) => {
  const ctx = shadowScene('source-over', DRAW.patstroke, SHADOW.blur)
  t.deepEqual(px(ctx, 15, 24), [22, 86, 118, 166])
})

test('a fractional shadow under a pattern stroke', (t) => {
  const ctx = shadowScene('source-over', DRAW.patstroke, SHADOW.frac)
  t.deepEqual(px(ctx, 17, 24), [40, 159, 219, 128])
  t.deepEqual(px(ctx, 36, 37), [79, 0, 0, 135])
})

test('multiply with a shadow is a composited draw', (t) => {
  const ctx = shadowScene('multiply', DRAW.solid, SHADOW.blur)
  t.deepEqual(px(ctx, 8, 24), [40, 159, 219, 128])
  t.deepEqual(px(ctx, 36, 30), [0, 0, 0, 72])
})

test('xor with a shadow is a composited draw', (t) => {
  const ctx = shadowScene('xor', DRAW.solid, SHADOW.blur)
  t.deepEqual(px(ctx, 36, 30), [0, 0, 0, 72])
  t.deepEqual(px(ctx, 36, 36), [0, 0, 0, 30])
})

test('hue with a shadow on a non-opaque image', async (t) => {
  const image = await loadImage(fixture('compositing', 'n6x6.png'))
  const ctx = shadowScene('hue', (c) => c.drawImage(image, 10, 10, 24, 24), SHADOW.hard)
  t.deepEqual(px(ctx, 12, 14), [68, 136, 218, 255])
})

test('lighter with a blurred shadow on a non-opaque image', async (t) => {
  const image = await loadImage(fixture('compositing', 'n6x6.png'))
  const ctx = shadowScene('lighter', (c) => c.drawImage(image, 10, 10, 24, 24), SHADOW.blur)
  t.deepEqual(px(ctx, 12, 12), [255, 196, 155, 255])
  t.deepEqual(px(ctx, 36, 30), [0, 0, 0, 90])
  t.deepEqual(px(ctx, 20, 36), [27, 107, 147, 191])
})

// 40x40, rgb(200,100,50) top half; shadow rgba(80,0,0,0.7) at (2.5, 1.5).
function fracShadowDraw(draw: (c: Ctx) => void) {
  const ctx = createCanvas(40, 40).getContext('2d')
  ctx.fillStyle = 'rgb(200,100,50)'
  ctx.fillRect(0, 0, 40, 20)
  ctx.shadowColor = 'rgba(80,0,0,0.7)'
  ctx.shadowOffsetX = 2.5
  ctx.shadowOffsetY = 1.5
  ctx.shadowBlur = 0
  draw(ctx)
  return ctx
}

function sixBySix(alpha: boolean) {
  const canvas = createCanvas(6, 6)
  const c = canvas.getContext('2d', { alpha })
  c.fillStyle = 'rgb(255,220,0)'
  c.fillRect(0, 0, 6, 6)
  c.fillStyle = 'rgb(120,0,200)'
  c.fillRect(3, 0, 3, 3)
  return canvas
}

// An opaque source takes the draw looper: the offset snaps to whole pixels
// (state.cc:855, 866; image type from IsOpaque, canvas_2d_recorder_context.cc:2325-2345).
test('opaque image sources shadow through the looper like Chrome', async (t) => {
  const sources = {
    'rgb png': await loadImage(fixture('compositing', 'rgb6x6.png')),
    jpeg: await loadImage(fixture('filter-invert.jpeg')),
    avif: await loadImage(fixture('issue-996.avif')),
    'alpha:false canvas': sixBySix(false),
  }
  for (const [name, source] of Object.entries(sources)) {
    const ctx = fracShadowDraw((c) => c.drawImage(source, 8, 8, 20, 20))
    t.deepEqual(px(ctx, 28, 9), BG, name)
    t.deepEqual(px(ctx, 10, 28), CLEAR, name)
    t.deepEqual(px(ctx, 30, 28), [80, 0, 0, 179], name)
  }
  // drawCanvas has no Chrome counterpart; it matches drawImage.
  const ctx = fracShadowDraw((c) => c.drawCanvas(sixBySix(false), 8, 8, 20, 20))
  t.deepEqual(px(ctx, 28, 9), BG, 'drawCanvas')
  t.deepEqual(px(ctx, 10, 28), CLEAR, 'drawCanvas')
  t.deepEqual(px(ctx, 30, 28), [80, 0, 0, 179], 'drawCanvas')
})

test('non-opaque image sources keep the image-filter shadow', async (t) => {
  const sources = {
    'rgba png with opaque pixels': await loadImage(fixture('compositing', 'rgba6x6-opaque.png')),
    'rgba png': await loadImage(fixture('compositing', 'n6x6.png')),
    'alpha:true canvas': sixBySix(true),
  }
  for (const [name, source] of Object.entries(sources)) {
    const ctx = fracShadowDraw((c) => c.drawImage(source, 8, 8, 20, 20))
    t.deepEqual(px(ctx, 10, 28), [79, 0, 0, 90], name)
    t.deepEqual(px(ctx, 30, 28), [79, 0, 0, 90], name)
  }
})

test('drawCanvas of an alpha:false canvas keeps a blurred shadow', (t) => {
  for (const kind of ['drawImage', 'drawCanvas'] as const) {
    const ctx = createCanvas(48, 48).getContext('2d')
    ctx.fillStyle = 'rgb(200,100,50)'
    ctx.fillRect(0, 0, 48, 48)
    ctx.shadowColor = 'rgba(0,0,0,.6)'
    ctx.shadowBlur = 6
    ctx.shadowOffsetX = 4
    ctx.shadowOffsetY = 4
    ctx[kind](sixBySix(false), 8, 8, 24, 24)
    t.deepEqual(px(ctx, 34, 34), [144, 72, 36, 255], kind)
  }
})

// No Chrome counterpart (G3). An opaque image takes the draw looper on every
// backend, so an SVG canvas now writes its shadow (SkSVGDevice drops the blur,
// as for fill shadows). Before, the image-filter shadow wrote nothing.
test('an SVG canvas writes the shadow of an opaque image', async (t) => {
  const image = await loadImage(fixture('compositing', 'rgb6x6.png'))
  const canvas = createCanvas(40, 40, SvgExportFlag.ConvertTextToPaths)
  const ctx = canvas.getContext('2d')
  ctx.shadowColor = 'rgba(80,0,0,0.7)'
  ctx.shadowOffsetX = 3
  ctx.shadowOffsetY = 2
  ctx.drawImage(image, 8, 8, 20, 20)
  const svg = canvas.getContent().toString()
  t.is(svg.match(/<use /g)?.length, 2)
  t.regex(svg, /flood-color="#500000"/)
})
