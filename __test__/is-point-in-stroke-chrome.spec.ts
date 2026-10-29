// isPointInStroke() strokes with the whole stroke state, as Blink's
// IsPointInStrokeInternal does (canvas_2d_recorder_context.cc): lineWidth,
// lineCap, lineJoin, miterLimit, the line dash and lineDashOffset, at the
// resolution scale of the CTM (Path::StrokePath, path.cc). It used to take
// only lineWidth, so caps were always butt, joins always miter with limit 4,
// and dashes were ignored. Every expected value is pinned to Chrome 156 CPU
// canvas (--disable-gpu, getContext('2d', { willReadFrequently: true })).
import test from 'ava'

import { createCanvas, Path2D } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

function setup() {
  const ctx = createCanvas(200, 200).getContext('2d')
  ctx.lineWidth = 20
  return ctx
}

// A 100px horizontal segment, 20px wide.
function line(ctx: Ctx) {
  ctx.beginPath()
  ctx.moveTo(50, 50)
  ctx.lineTo(150, 50)
}

// A 90-degree V with its apex at (100, 100); the miter ratio is about 1.414.
function vee(ctx: Ctx) {
  ctx.beginPath()
  ctx.moveTo(50, 150)
  ctx.lineTo(100, 100)
  ctx.lineTo(150, 150)
}

test('isPointInStroke uses lineCap', (t) => {
  const ctx = setup()
  line(ctx)
  t.false(ctx.isPointInStroke(155, 50))
  ctx.lineCap = 'round'
  t.true(ctx.isPointInStroke(155, 50))
  t.true(ctx.isPointInStroke(42, 50))
  t.false(ctx.isPointInStroke(158, 58))
  ctx.lineCap = 'square'
  t.true(ctx.isPointInStroke(158, 58))
  t.true(ctx.isPointInStroke(159, 50))
  t.false(ctx.isPointInStroke(161, 50))
})

test('isPointInStroke(path) uses lineCap', (t) => {
  const ctx = setup()
  const path = new Path2D()
  path.moveTo(50, 50)
  path.lineTo(150, 50)
  t.false(ctx.isPointInStroke(path, 155, 50))
  ctx.lineCap = 'round'
  t.true(ctx.isPointInStroke(path, 155, 50))
})

test('isPointInStroke caps a zero-length segment', (t) => {
  const ctx = setup()
  ctx.beginPath()
  ctx.moveTo(100, 50)
  ctx.lineTo(100, 50)
  t.false(ctx.isPointInStroke(100, 55))
  ctx.lineCap = 'round'
  t.true(ctx.isPointInStroke(100, 55))
  ctx.lineCap = 'square'
  t.true(ctx.isPointInStroke(100, 55))
})

test('isPointInStroke uses lineJoin and miterLimit', (t) => {
  const ctx = setup()
  vee(ctx)
  t.true(ctx.isPointInStroke(100, 88))
  ctx.miterLimit = 1.5
  t.true(ctx.isPointInStroke(100, 88))
  ctx.miterLimit = 1.4
  t.false(ctx.isPointInStroke(100, 88))
  ctx.miterLimit = 10
  ctx.lineJoin = 'bevel'
  t.false(ctx.isPointInStroke(100, 88))
  t.true(ctx.isPointInStroke(100, 94))
  ctx.lineJoin = 'round'
  t.false(ctx.isPointInStroke(100, 88))
  t.true(ctx.isPointInStroke(100, 91))
})

test('isPointInStroke uses the line dash and lineDashOffset', (t) => {
  const ctx = setup()
  line(ctx)
  ctx.setLineDash([10, 10])
  t.true(ctx.isPointInStroke(55, 50))
  t.false(ctx.isPointInStroke(65, 50))
  ctx.lineDashOffset = 10
  t.false(ctx.isPointInStroke(55, 50))
  t.true(ctx.isPointInStroke(65, 50))
  ctx.lineDashOffset = -7
  t.deepEqual(
    [55, 58, 62, 65, 68, 72, 75].map((x) => ctx.isPointInStroke(x, 50)),
    [false, true, true, true, false, false, false],
  )
  ctx.lineDashOffset = 0
  // An odd list repeats: [10] dashes as [10, 10].
  ctx.setLineDash([10])
  t.false(ctx.isPointInStroke(65, 50))
  // A list of zeros strokes solid.
  ctx.setLineDash([0, 0])
  t.true(ctx.isPointInStroke(65, 50))
})

test('isPointInStroke caps zero-length dashes', (t) => {
  const ctx = setup()
  line(ctx)
  ctx.setLineDash([0, 10])
  ctx.lineCap = 'round'
  t.true(ctx.isPointInStroke(70, 50))
  t.false(ctx.isPointInStroke(65, 59.5))
  ctx.lineCap = 'butt'
  t.false(ctx.isPointInStroke(70, 50))
})

test('isPointInStroke dashes in user space under a transform', (t) => {
  const ctx = setup()
  ctx.translate(100, 0)
  ctx.scale(2, 1)
  ctx.setLineDash([10, 10])
  ctx.beginPath()
  ctx.moveTo(0, 50)
  ctx.lineTo(50, 50)
  t.true(ctx.isPointInStroke(110, 50))
  t.false(ctx.isPointInStroke(130, 50))
  t.true(ctx.isPointInStroke(110, 59))
})

test('isPointInStroke is false for a singular CTM and a non-finite point', (t) => {
  const ctx = setup()
  line(ctx)
  ctx.lineCap = 'round'
  ctx.setTransform(0, 0, 0, 0, 0, 0)
  t.false(ctx.isPointInStroke(100, 50))
  ctx.resetTransform()
  t.false(ctx.isPointInStroke(NaN, 50))
  t.false(ctx.isPointInStroke(Infinity, 50))
})

// A unit circle under scale(S), 2 device px wide: the stroke outline is made
// at resolution scale S, so it follows the circle to within a fraction of a
// device pixel. Counts of hits among 720 points on the circles of device radius
// S - 0.97, S + 0.97, S - 1.03 and S + 1.03 around the centre.
test('isPointInStroke strokes at the resolution of the CTM', (t) => {
  const ctx = createCanvas(200, 200).getContext('2d')
  const expected: Record<number, number[]> = {
    10: [720, 720, 0, 212],
    50: [216, 720, 0, 564],
  }
  for (const [s, counts] of Object.entries(expected)) {
    const S = Number(s)
    ctx.reset()
    ctx.scale(S, S)
    ctx.lineWidth = 2 / S
    ctx.beginPath()
    ctx.arc(1, 1, 1, 0, Math.PI * 2)
    const got = [-0.97, 0.97, -1.03, 1.03].map((d) => {
      let n = 0
      for (let i = 0; i < 720; i++) {
        const a = (i / 720) * Math.PI * 2
        if (ctx.isPointInStroke(S + (S + d) * Math.cos(a), S + (S + d) * Math.sin(a))) n++
      }
      return n
    })
    t.deepEqual(got, counts, `scale(${S})`)
  }
})
