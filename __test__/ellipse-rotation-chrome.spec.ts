// ellipse() with a rotation. Blink maps the whole path by the inverse of
// Translation(x, y) · RotateRadians(rotation), adds the arc around the origin
// and maps the whole path back (path_builder.cc:482-504 m156). It builds both
// matrices in double and clamps them to float (affine_transform.cc). We used
// f32 matrices that rotate by degrees about (x, y), with the arc built at
// (x, y), so the arc and every earlier point landed a few ulps away from
// Chrome's, and some strokes and fills differed by a pixel. Pixel counts are
// pixels with alpha > 0, pinned to Chrome 156 CPU canvas (--disable-gpu,
// getContext('2d', { willReadFrequently: true })).
import test from 'ava'

import { createCanvas, Path2D } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>
type Target = Ctx | InstanceType<typeof Path2D>

const TAU = 2 * Math.PI
const f = Math.fround

const ctx = createCanvas(100, 100).getContext('2d')

function countPainted(c: Ctx) {
  const data = c.getImageData(0, 0, c.canvas.width, c.canvas.height).data
  let n = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]) n++
  }
  return n
}

// Blink ToSkMatrix: ClampToFloat on each entry, NaN to 0.
function clampToFloat(v: number) {
  if (Number.isNaN(v)) return 0
  return f(Math.max(-3.4028234663852886e38, Math.min(3.4028234663852886e38, v)))
}

// AffineTransform::Translation(x, y).RotateRadians(rotation) and its Inverse()
// in double, as DOMMatrix-like objects. Every entry is at least 1e7 double ulps
// from an f32 rounding midpoint for the rotations used here, so a libm that
// differs from V8's by an ulp gives the same f32 matrix.
function blinkMatrices(x: number, y: number, rotation: number) {
  const c = Math.cos(f(rotation))
  const s = Math.sin(f(rotation))
  const m = [c, s, -s, c, f(x) + 0, f(y) + 0]
  const det = m[0] * m[3] - m[1] * m[2]
  const inv = [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ]
  const toObject = ([a, b, cc, d, e, ff]: number[]) => ({
    a: clampToFloat(a),
    b: clampToFloat(b),
    c: clampToFloat(cc),
    d: clampToFloat(d),
    e: clampToFloat(e),
    f: clampToFloat(ff),
  })
  return { matrix: toObject(m), inverse: toObject(inv) }
}

// What Blink's AddEllipse with a rotation does, built from other Path2D calls.
function blinkEllipse(pre: (t: Target) => void, [x, y, rx, ry, rotation, start, end, ccw]: EllipseArgs) {
  const { matrix, inverse } = blinkMatrices(x, y, rotation)
  const out = new Path2D()
  pre(out)
  out.transform(inverse)
  out.ellipse(0, 0, rx, ry, 0, start, end, ccw)
  out.transform(matrix)
  return out
}

type EllipseArgs = [number, number, number, number, number, number, number, boolean]

const PRE: Record<string, (t: Target) => void> = {
  empty: () => {},
  moveTo: (t) => t.moveTo(10, 10),
  lines: (t) => {
    t.moveTo(5, 7.3)
    t.lineTo(93.1, 11.7)
    t.lineTo(20.3, 88.9)
  },
  closed: (t) => {
    t.moveTo(12.7, 80.1)
    t.lineTo(40.3, 95.2)
    t.lineTo(8.9, 97.7)
    t.closePath()
  },
  rotatedEllipse: (t) => t.ellipse(30.3, 60.7, 12.1, 7.3, 1.1, 0, 2),
  bezier: (t) => {
    t.moveTo(3.3, 50.1)
    t.bezierCurveTo(20.7, 2.9, 70.1, 97.3, 96.6, 40.4)
  },
}

const SWEEPS: Record<string, [number, number, boolean]> = {
  cw: [0.3, 1.3, false],
  fullccw: [-1, -1 - TAU, true],
  over: [2, 9, false],
}

test('a rotated ellipse() has the points of Blink double matrices', (t) => {
  for (const [preName, pre] of Object.entries(PRE)) {
    for (const rotation of [0.7, -2, Math.PI / 4]) {
      for (const [sweepName, [start, end, ccw]] of Object.entries(SWEEPS)) {
        for (const [x, y, rx, ry] of [
          [50, 50, 30, 20],
          [37.5, 61.25, 1e-3, 30],
        ]) {
          const args: EllipseArgs = [x, y, rx, ry, rotation, start, end, ccw]
          const actual = new Path2D()
          pre(actual)
          actual.ellipse(...args)
          t.is(
            actual.toSVGString(),
            blinkEllipse(pre, args).toSVGString(),
            `${preName} rotation ${rotation} ${sweepName} ${rx},${ry}`,
          )
        }
      }
    }
  }
})

test('a rotated ellipse() moves earlier points like Blink', (t) => {
  // Blink's round trip moves 10 to 9.9999962 here; our f32 matrices about
  // (50, 50) moved 50 to 50.000004 and 10 to 10.000004.
  const p = new Path2D()
  p.moveTo(50, 50)
  p.lineTo(10, 20)
  p.ellipse(50, 50, 30, 20, 0.7, 0, 1)
  t.true(p.toSVGString().startsWith('M50 50L9.9999962 20L72.945267 69.32653Q'), p.toSVGString())
})

// [lineWidth 1 butt stroke, lineWidth 6 round stroke, fill]
function paint(build: (t: Target) => void) {
  const counts: Record<string, number[]> = {}
  for (const api of ['ctx', 'Path2D']) {
    const n: number[] = []
    for (const [lineWidth, cap] of [
      [1, 'butt'],
      [6, 'round'],
    ] as const) {
      ctx.reset()
      ctx.lineWidth = lineWidth
      ctx.lineCap = cap
      ctx.beginPath()
      if (api === 'ctx') {
        build(ctx)
        ctx.stroke()
      } else {
        const p = new Path2D()
        build(p)
        ctx.stroke(p)
      }
      n.push(countPainted(ctx))
    }
    ctx.reset()
    ctx.beginPath()
    if (api === 'ctx') {
      build(ctx)
      ctx.fill()
    } else {
      const p = new Path2D()
      build(p)
      ctx.fill(p)
    }
    n.push(countPainted(ctx))
    counts[api] = n
  }
  return counts
}

test('a rotated ellipse() strokes and fills like Chrome', (t) => {
  // [pre, rx, ry, rotation, sweep] -> Chrome 156 [stroke 1 butt, stroke 6 round, fill].
  // The comment gives what the f32 matrices painted.
  const cases: [string, number, number, number, string, number[]][] = [
    ['empty', 1e-3, 30, 0.7, 'over', [92, 472, 48]], // fill 55
    ['empty', 1e-3, 30, -2, 'over', [112, 478, 77]], // fill 69
    ['empty', 1e-3, 30, 1e10, 'over', [108, 467, 45]], // fill 33
    ['moveTo', 30, 20, -2, 'cw', [114, 469, 222]], // stroke 1: 112
    ['moveTo', 25.5, 25.5, -2, 'fullccw', [356, 1395, 2125]], // stroke 1: 353
    ['lines', 1e-3, 30, Math.PI / 2, 'fullccw', [549, 2061, 2064]], // 548, fill 2061
  ]
  for (const [preName, rx, ry, rotation, sweepName, expected] of cases) {
    const [start, end, ccw] = SWEEPS[sweepName]
    const counts = paint((p) => {
      PRE[preName](p)
      p.ellipse(50, 50, rx, ry, rotation, start, end, ccw)
    })
    const name = `${preName} ${rx},${ry} rotation ${rotation} ${sweepName}`
    t.deepEqual(counts, { ctx: expected, Path2D: expected }, name)
  }
})

test('a chain of rotated ellipses paints like Chrome', (t) => {
  // Each ellipse() maps every earlier point there and back, so the f32 matrices
  // drifted further from Chrome with every call.
  const chain = (k: number, rotation: number) => (p: Target) => {
    PRE.lines(p)
    for (let i = 0; i < k; i++) {
      p.ellipse(20 + ((i * 7.31) % 60), 20 + ((i * 13.7) % 60), 9.7, 4.1, rotation + i * 0.37, 0.3 + i, 1.3 + i, false)
    }
  }
  const expected: [number, number, number[]][] = [
    [2, 0.7, [488, 2042, 3082]], // was 487, fill 3081
    [2, -2, [544, 2161, 3323]], // was 543
    [20, 0.7, [1322, 3831, 3379]], // was 1321
    [20, -2, [1443, 4243, 3704]], // was 1444
    [100, 0.7, [3512, 6165, 4895]],
    [100, -2, [3457, 5921, 4822]], // was 3458
  ]
  for (const [k, rotation, counts] of expected) {
    t.deepEqual(paint(chain(k, rotation)), { ctx: counts, Path2D: counts }, `k ${k} rotation ${rotation}`)
  }
})

test('a thin rotated ellipse() strokes its tips like Chrome', (t) => {
  // ellipse(50, 50, 1e-3, 30, ...) is 0.002 wide, so an ulp in a control point
  // turns the tips of a wide stroke. With the f32 matrices about (50, 50) a
  // lineWidth 20 stroke lost up to 160 pixels and fill() painted 22 pixels
  // where Chrome paints 4. [pre, rotation, start, end, anticlockwise] ->
  // Chrome 156 [lineWidth 1 butt, 1 round, 1 square, 20 butt, 20 round,
  // 20 square, fill]. The comment gives what the f32 matrices painted.
  const cases: [string, number, number, number, boolean, number[]][] = [
    ['empty', 0.7, 0, TAU, false, [92, 92, 92, 1468, 1466, 1469, 4]], // 20: 1308, 1305, 1307, fill 22
    ['moveTo', -2, 1, 2, false, [138, 138, 138, 1751, 1905, 1926, 134]], // 1 butt: 136, fill 133
    ['lineAfter', 1e10, Math.PI / 2, Math.PI / 2 - TAU, true, [218, 224, 224, 2522, 2680, 2754, 11]], // 20: 2686, 2841, 2917
  ]
  const styles = [
    [1, 'butt'],
    [1, 'round'],
    [1, 'square'],
    [20, 'butt'],
    [20, 'round'],
    [20, 'square'],
  ] as const
  for (const [preName, rotation, start, end, ccw, expected] of cases) {
    const build = (p: Target) => {
      if (preName === 'moveTo') p.moveTo(10, 10)
      p.ellipse(50, 50, 1e-3, 30, rotation, start, end, ccw)
      if (preName === 'lineAfter') p.lineTo(80, 20)
    }
    for (const api of ['ctx', 'Path2D']) {
      const counts: number[] = []
      for (const style of [...styles, null]) {
        ctx.reset()
        ctx.beginPath()
        const p = api === 'ctx' ? null : new Path2D()
        build(p ?? ctx)
        if (style) {
          ctx.lineWidth = style[0]
          ctx.lineCap = style[1]
          if (p) ctx.stroke(p)
          else ctx.stroke()
        } else if (p) ctx.fill(p)
        else ctx.fill()
        counts.push(countPainted(ctx))
      }
      t.deepEqual(counts, expected, `${api} ${preName} rotation ${rotation}`)
    }
  }
})
