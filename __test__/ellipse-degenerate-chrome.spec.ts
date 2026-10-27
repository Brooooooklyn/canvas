// ellipse() with a zero radius or a zero sweep. Blink draws it as straight
// lines through the start point, each multiple of π/2 inside the sweep, and
// the end point (DegenerateEllipse, canvas_path.cc m156). We used to draw a
// flat oval of curves, whose ends are round, not square. Pixel counts are
// pixels with alpha > 0, pinned to Chrome 156 CPU canvas (--disable-gpu,
// getContext('2d', { willReadFrequently: true })).
import test, { type ExecutionContext } from 'ava'

import { createCanvas, Path2D } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const TAU = 2 * Math.PI
// win32-arm64 Skia is built with FP contraction (see arc-full-sweep-chrome),
// which can move stroke edges by a pixel. Path structure is checked everywhere.
const WIN_ARM64 = process.platform === 'win32' && process.arch === 'arm64'

const ctx = createCanvas(100, 100).getContext('2d')

function countPainted(c: Ctx) {
  const data = c.getImageData(0, 0, c.canvas.width, c.canvas.height).data
  let n = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]) n++
  }
  return n
}

// "M10 10L66.2 50" -> [['M', 10, 10], ['L', 66.2, 50]]
function parse(svg: string) {
  return [...svg.matchAll(/([A-Za-z])([^A-Za-z]*)/g)].map(([, cmd, args]) => [
    cmd,
    ...args
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number),
  ])
}

// Coordinates within 1e-3, so libm ulps do not matter.
function assertPath(
  t: ExecutionContext,
  path: InstanceType<typeof Path2D>,
  expected: [string, number, number][],
  name: string,
) {
  const actual = parse(path.toSVGString())
  t.is(actual.map((c) => c[0]).join(''), expected.map((c) => c[0]).join(''), `${name} commands`)
  expected.forEach(([, x, y], i) => {
    const [, ax, ay] = actual[i] as [string, number, number]
    t.true(Math.abs(ax - x) < 1e-3 && Math.abs(ay - y) < 1e-3, `${name} point ${i}: ${ax},${ay} != ${x},${y}`)
  })
}

test('a zero-radius ellipse is straight lines through every quarter turn', (t) => {
  // Start 0, then π/2, π, 3π/2, and the end 2π. On an empty path the first
  // lineTo is moveTo plus a zero-length line, as in Blink.
  const full = new Path2D()
  full.ellipse(50, 50, 0, 30, 0, 0, TAU)
  assertPath(
    t,
    full,
    [
      ['M', 50, 50],
      ['L', 50, 50],
      ['L', 50, 80],
      ['L', 50, 50],
      ['L', 50, 20],
      ['L', 50, 50],
    ],
    'rx 0 full',
  )

  // Anticlockwise from 1 to -1 passes 0 only.
  const c = Math.cos(1)
  const partial = new Path2D()
  partial.moveTo(10, 10)
  partial.ellipse(50, 50, 30, 0, 0, 1, -1, true)
  assertPath(
    t,
    partial,
    [
      ['M', 10, 10],
      ['L', 50 + 30 * c, 50],
      ['L', 80, 50],
      ['L', 50 + 30 * c, 50],
    ],
    'ry 0 anticlockwise',
  )
})

test('a degenerate ellipse rotates its points by the rotation in radians', (t) => {
  // Blink rotates each point with AffineTransform::RotateRadians in double.
  // 1e10 is exact in float; a float degrees conversion would lose it.
  const r = 1e10
  const [c, s] = [Math.cos(r), Math.sin(r)]
  const path = new Path2D()
  path.ellipse(50, 50, 30, 0, r, 0, Math.PI)
  assertPath(
    t,
    path,
    [
      ['M', 50 + 30 * c, 50 + 30 * s],
      ['L', 50 + 30 * c, 50 + 30 * s],
      ['L', 50, 50],
      ['L', 50 - 30 * c, 50 - 30 * s],
    ],
    'rotation 1e10',
  )
})

test('a zero-sweep ellipse adds only its start point', (t) => {
  const p = [50 + 30 * Math.cos(1), 50 + 20 * Math.sin(1)]
  const empty = new Path2D()
  empty.ellipse(50, 50, 30, 20, 0, 1, 1)
  t.is(empty.toSVGString(), '')
  const afterMoveTo = new Path2D()
  afterMoveTo.moveTo(10, 10)
  afterMoveTo.ellipse(50, 50, 30, 20, 0, 1, 1)
  assertPath(
    t,
    afterMoveTo,
    [
      ['M', 10, 10],
      ['L', p[0], p[1]],
    ],
    'zero sweep',
  )

  // Chrome does not stroke a path whose points all coincide.
  ctx.reset()
  ctx.lineWidth = 20
  ctx.lineCap = 'round'
  ctx.ellipse(50, 50, 30, 20, 0, 1, 1)
  ctx.stroke()
  t.is(countPainted(ctx), 0)
})

test('a degenerate ellipse whose points all land on the start point is a lone point', (t) => {
  // In float, π/2 to 5π/2 anticlockwise leaves a 4.8e-7 sweep, not 0, so
  // every point Blink adds is the start point. Chrome strokes nothing.
  const strokeRound = (lineWidth: number, args: Parameters<Ctx['ellipse']>) => {
    ctx.reset()
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'round'
    ctx.ellipse(...args)
    ctx.stroke()
    return countPainted(ctx)
  }
  const cases: Parameters<Ctx['ellipse']>[] = [
    [50, 50, 0, 40, 0, Math.PI / 2, (5 * Math.PI) / 2, true],
    [50, 50, 0, 40, 0, -Math.PI / 2, (-5 * Math.PI) / 2, false],
    [50, 50, 40, 0, 0, Math.PI, 3 * Math.PI, true],
    [70, 70, 0, 40, -2.2, 7.5, 7.5 + TAU, true],
  ]
  for (const args of cases) {
    const name = args.join(',')
    const path = new Path2D()
    path.ellipse(...args)
    t.is(path.toSVGString(), '', name)
    t.is(strokeRound(1, args), 0, `${name} lineWidth 1`)
    t.is(strokeRound(20, args), 0, `${name} lineWidth 20`)
  }

  // At center 50 the rotated end point is 4e-6 off the start, so the bounds
  // are not empty and Chrome strokes it (4 px and 346 px).
  const offByLittle: Parameters<Ctx['ellipse']> = [50, 50, 0, 40, -2.2, 7.5, 7.5 + TAU, true]
  t.true(strokeRound(1, offByLittle) > 0)
  t.true(strokeRound(20, offByLittle) > 0)
})

test('a degenerate ellipse strokes and fills like Chrome', (t) => {
  const stroke = (lineWidth: number, cap: 'butt' | 'square', build: (c: Ctx) => InstanceType<typeof Path2D> | void) => {
    ctx.reset()
    ctx.lineWidth = lineWidth
    ctx.lineCap = cap
    const path = build(ctx)
    if (path) ctx.stroke(path)
    else ctx.stroke()
    return countPainted(ctx)
  }
  const counts = {
    // The flat oval had round ends: 1616 px.
    'rx 0, rotation -2': stroke(20, 'butt', (c) => c.ellipse(50, 50, 0, 30, -2, 2, 2 + TAU)),
    'rx 0, rotation -2, Path2D': stroke(20, 'butt', () => {
      const p = new Path2D()
      p.ellipse(50, 50, 0, 30, -2, 2, 2 + TAU)
      return p
    }),
    'ry 0, rotation 1e10, anticlockwise': stroke(20, 'butt', (c) => c.ellipse(50, 50, 30, 0, 1e10, 1, 1 - TAU, true)),
    'ry 0 after moveTo, square cap': stroke(20, 'square', (c) => {
      c.moveTo(10, 10)
      c.ellipse(50, 50, 30, 0, 0, 1, -1, true)
    }),
  }
  ctx.reset()
  ctx.moveTo(10, 90)
  ctx.ellipse(50, 50, 30, 0, -2, 1, -2, true)
  ctx.fill()
  const fill = countPainted(ctx)
  if (!WIN_ARM64) {
    t.deepEqual(counts, {
      'rx 0, rotation -2': 1290,
      'rx 0, rotation -2, Path2D': 1290,
      'ry 0, rotation 1e10, anticlockwise': 1293,
      'ry 0 after moveTo, square cap': 1936,
    })
    t.is(fill, 854)
  } else {
    t.pass()
  }
})

test('isPointInPath sees the lines of a degenerate ellipse', (t) => {
  ctx.reset()
  ctx.ellipse(50, 50, 0, 30, 0, 0, TAU)
  t.true(ctx.isPointInPath(50, 50))
  ctx.beginPath()
  ctx.moveTo(10, 10)
  ctx.ellipse(50, 50, 0, 30, 0, 0, TAU)
  t.true(ctx.isPointInPath(30, 30))
})
