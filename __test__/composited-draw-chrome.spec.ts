// Blink's CompositedDraw: the draws that composite through a layer with no
// bounds (canvas_2d_recorder_context.h:897-963). Every expected value was
// measured in Chrome 155 CPU canvas (--disable-gpu, getContext('2d',
// { willReadFrequently: true })) on arm64 and x64; both give the same bytes.
import test from 'ava'

import { createCanvas } from '../index'

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
