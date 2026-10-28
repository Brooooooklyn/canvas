// arc() with start == end. Blink compares the raw float angles before it
// canonicalizes them, and then adds only
// lineTo(x + r·cosf(start), y + r·sinf(start)) (canvas_path.cc:457-461 m156).
// We used to canonicalize first, which can move the end 1 ulp off the start,
// so arc(50, 50, 30, 50, 50) drew an almost full circle. Pixel counts are
// pixels with alpha > 0, pinned to Chrome 156 CPU canvas (--disable-gpu,
// getContext('2d', { willReadFrequently: true })).
import test, { type ExecutionContext } from 'ava'

import { createCanvas, Path2D } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>
type Target = Ctx | InstanceType<typeof Path2D>

const ctx = createCanvas(100, 100).getContext('2d')

function countPainted(c: Ctx) {
  const data = c.getImageData(0, 0, c.canvas.width, c.canvas.height).data
  let n = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]) n++
  }
  return n
}

// Blink's point, in float.
function blinkPoint(x: number, y: number, r: number, angle: number) {
  const f = Math.fround
  const a = f(angle)
  return [f(f(x) + f(f(r) * f(Math.cos(a)))), f(f(y) + f(f(r) * f(Math.sin(a))))]
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

// Stroke (or fill, with no style) on ctx or through a Path2D.
function paint(api: 'ctx' | 'Path2D', build: (c: Target) => void, style?: [number, CanvasLineCap]) {
  ctx.reset()
  if (style) {
    ctx.lineWidth = style[0]
    ctx.lineCap = style[1]
  }
  let path: InstanceType<typeof Path2D> | undefined
  if (api === 'ctx') {
    build(ctx)
  } else {
    path = new Path2D()
    build(path)
  }
  if (style) {
    if (path) ctx.stroke(path)
    else ctx.stroke()
  } else if (path) {
    ctx.fill(path)
  } else {
    ctx.fill()
  }
  return countPainted(ctx)
}

const APIS = ['ctx', 'Path2D'] as const

// [start, anticlockwise]
const BIG_STARTS: [number, boolean][] = [
  [50, false],
  [100, true],
  [33.3, false],
  [77, true],
  [1e6, false],
  [12.5, false],
  [-100, false],
]

test('arc() with start == end draws no circle, whatever the start', (t) => {
  for (const [s, ccw] of BIG_STARTS) {
    const name = `arc(50, 50, 30, ${s}, ${s}, ${ccw})`
    const arc = (c: Target) => c.arc(50, 50, 30, s, s, ccw)
    const empty = new Path2D()
    arc(empty)
    t.is(empty.toSVGString(), '', name)
    const p = blinkPoint(50, 50, 30, s)
    const afterMoveTo = new Path2D()
    afterMoveTo.moveTo(10, 10)
    arc(afterMoveTo)
    assertPath(
      t,
      afterMoveTo,
      [
        ['M', 10, 10],
        ['L', p[0], p[1]],
      ],
      name,
    )
    // The circle painted 3961 px (lineWidth 20, round) and filled 2906 px.
    for (const api of APIS) {
      t.is(paint(api, arc, [20, 'round']), 0, `${name} ${api} stroke`)
      t.is(paint(api, arc), 0, `${name} ${api} fill`)
    }
  }
  ctx.reset()
  ctx.arc(50, 50, 30, 50, 50)
  t.false(ctx.isPointInPath(50, 50))
})

test('arc() with start == end strokes and fills like Chrome', (t) => {
  const counts: Record<string, number[]> = {}
  const cases: Record<string, (c: Target) => void> = {
    // Was 472 / 4782 / 4802 px with a 2901 px fill.
    'moveTo, arc(50, 50)': (c) => {
      c.moveTo(10, 10)
      c.arc(50, 50, 30, 50, 50)
    },
    // A pie slice of size 0 is a line to the rim and back. Was 395 / 4380.
    'pie slice at 50': (c) => {
      c.moveTo(50, 50)
      c.arc(50, 50, 30, 50, 50)
      c.closePath()
    },
    // Blink drops a lineTo that is not finite. The arc route made the whole
    // path non-finite, so it painted nothing.
    'moveTo, lineTo, arc at x 3e38': (c) => {
      c.moveTo(10, 10)
      c.lineTo(80, 20)
      c.arc(3e38, 50, 1e38, 0, 0)
    },
    // Blink's lineTo after closePath starts at the moveTo point, even when
    // the arc's point is the last vertex. Was 132 / 1851 / 1851.
    'closed, then arc on the last vertex': (c) => {
      const p = blinkPoint(50, 50, 30, 1)
      c.moveTo(10, 10)
      c.lineTo(p[0], p[1])
      c.closePath()
      c.arc(50, 50, 30, 1, 1)
    },
    // An arc that ends at angle 1, then arc(1, 1): Blink adds a zero-length
    // line, which changes the square cap. Was 56 / 1062 px square.
    'arc(0, 1), arc(1, 1)': (c) => {
      c.arc(50, 50, 30, 0, 1)
      c.arc(50, 50, 30, 1, 1)
    },
    // The point 1e-4 away from the current point is a line in Blink. The arc
    // route skipped points within 1/4096. Was 1853 px butt.
    'lineTo near the point, arc(1, 1)': (c) => {
      const p = blinkPoint(50, 50, 30, 1)
      c.moveTo(10, 10)
      c.lineTo(p[0] + 1e-4, p[1])
      c.arc(50, 50, 30, 1, 1)
    },
  }
  for (const [name, build] of Object.entries(cases)) {
    for (const api of APIS) {
      counts[`${name} ${api}`] = [
        paint(api, build, [1, 'square']),
        paint(api, build, [20, 'butt']),
        paint(api, build, [20, 'square']),
        paint(api, build),
      ]
    }
  }
  const expected: Record<string, number[]> = {
    'moveTo, arc(50, 50)': [142, 1638, 2015, 0],
    'pie slice at 50': [57, 659, 659, 0],
    'moveTo, lineTo, arc at x 3e38': [144, 1530, 1910, 0],
    'closed, then arc on the last vertex': [134, 1851, 2226, 0],
    'arc(0, 1), arc(1, 1)': [57, 650, 1066, 106],
    'lineTo near the point, arc(1, 1)': [133, 2094, 2321, 0],
  }
  t.deepEqual(
    counts,
    Object.fromEntries(APIS.flatMap((api) => Object.entries(expected).map(([k, v]) => [`${k} ${api}`, v]))),
  )
})

test('arc() with start == end adds Blink point and only that', (t) => {
  // Empty path: only the moveTo (see degenerate_line_to in src/sk.rs).
  for (const ccw of [false, true]) {
    const empty = new Path2D()
    empty.arc(50, 50, 30, -1, -1, ccw)
    t.is(empty.toSVGString(), '')
    const path = new Path2D()
    path.moveTo(10, 10)
    path.arc(50, 50, 30, -1, -1, ccw)
    assertPath(
      t,
      path,
      [
        ['M', 10, 10],
        ['L', 66.209068, 24.755871],
      ],
      `start -1 ccw ${ccw}`,
    )
  }

  // After other path, a point equal to the current point still gets Blink's
  // zero-length line, because the path cannot be one point any more.
  const p = blinkPoint(50, 50, 30, 1)
  const onPoint = new Path2D()
  onPoint.moveTo(10, 10)
  onPoint.lineTo(p[0], p[1])
  onPoint.arc(50, 50, 30, 1, 1)
  assertPath(
    t,
    onPoint,
    [
      ['M', 10, 10],
      ['L', p[0], p[1]],
      ['L', p[0], p[1]],
    ],
    'on the current point',
  )

  // A point that is not finite is dropped, as Blink's lineTo does.
  const overflow = new Path2D()
  overflow.moveTo(10, 10)
  overflow.lineTo(80, 20)
  overflow.arc(3e38, 50, 1e38, 0.5, 0.5)
  t.is(overflow.toSVGString(), 'M10 10L80 20')
})

test('arc() with start == end on a path that is one point strokes nothing, as in Chrome', (t) => {
  // Blink adds only zero-length lines here, and Chrome skips a stroke whose
  // path bounds are one point (canvas_2d_recorder_context.cc:1595-1602 m156).
  // Our stroke has no such check, so we add no line while the first and the
  // last point of the path are within 1/4096 of the new point.
  const cases: Record<string, (c: Target) => void> = {
    'arc(1, 1) twice': (c) => {
      c.arc(50, 50, 30, 1, 1)
      c.arc(50, 50, 30, 1, 1)
    },
    'arc(1, 1) three times': (c) => {
      c.arc(50, 50, 30, 1, 1)
      c.arc(50, 50, 30, 1, 1)
      c.arc(50, 50, 30, 1, 1)
    },
    'arc(50, 50) twice': (c) => {
      c.arc(50, 50, 30, 50, 50)
      c.arc(50, 50, 30, 50, 50)
    },
    // The zero-sweep ellipse keeps Skia's point, a few ulps off Blink's.
    'zero-sweep ellipse at 2, then arc(2, 2)': (c) => {
      c.ellipse(50, 50, 30, 30, 0, 2, 2)
      c.arc(50, 50, 30, 2, 2)
    },
    'zero-sweep ellipse at 5π/4, then arc(5π/4, 5π/4)': (c) => {
      c.ellipse(50, 50, 30, 30, 0, (5 * Math.PI) / 4, (5 * Math.PI) / 4)
      c.arc(50, 50, 30, (5 * Math.PI) / 4, (5 * Math.PI) / 4)
    },
  }
  // Not here, and the same as before this change: Chrome strokes a dot for a
  // zero-sweep ellipse at -1 then arc(-1, -1) (its two points differ by an
  // ulp, 347 px round), and for moveTo(p + 1e-4) then arc() at p (342 px);
  // we paint 0. moveTo(80, 50) then arc(50, 50, 30, 0, 0) paints a 338 px dot
  // where Chrome paints 0 (next test).
  for (const [name, build] of Object.entries(cases)) {
    for (const api of APIS) {
      for (const cap of ['round', 'square'] as const) {
        t.is(paint(api, build, [20, cap]), 0, `${name} ${api} ${cap}`)
      }
    }
  }
})

test('moveTo(x + r, y) then arc(x, y, r, 0, 0) keeps a dot at each point, as in Chrome', (t) => {
  // At a start that canonicalizes to 0 the old Skia route always added the
  // line, and a path of several such dots is not one point, so Chrome strokes
  // each dot. -1e-8 and -1e-30 canonicalize to 0 in float.
  for (const s of [0, 2 * Math.PI, -1e-8, -1e-30]) {
    const dots = (c: Target) => {
      for (const [x, y] of [
        [25, 25],
        [75, 25],
        [25, 75],
        [75, 75],
      ]) {
        c.moveTo(x + 10, y)
        c.arc(x, y, 10, s, s)
      }
    }
    for (const api of APIS) {
      t.deepEqual(
        [paint(api, dots, [20, 'round']), paint(api, dots, [20, 'square']), paint(api, dots, [1, 'round'])],
        [1344, 1600, 16],
        `start ${s} ${api}`,
      )
    }
  }
})
