// Blink keeps the CTM as a double AffineTransform (canvas_rendering_context_2d_state.h
// transform_). getTransform() returns it, and the current path, isPointInPath
// and isPointInStroke are mapped by it (canvas_2d_recorder_context.cc m156).
// The canvas draws with its SkCanvas's float SkM44, which each transform call
// changes in float. The context kept only a float matrix, so getTransform()
// returned float values, and restore(), resetTransform() and setTransform()
// mapped the path back by a matrix that was not the one Blink used. Every
// value is pinned to Chrome 156 CPU canvas (--disable-gpu,
// getContext('2d', { willReadFrequently: true })).
import test from 'ava'

import { createCanvas } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const newCtx = () => createCanvas(100, 100).getContext('2d')

/** [pixels with alpha > 0, alpha sum] of a 100x100 canvas. */
function ink(ctx: Ctx) {
  const d = ctx.getImageData(0, 0, 100, 100).data
  let n = 0
  let sum = 0
  for (let i = 3; i < d.length; i += 4) {
    if (d[i]) n++
    sum += d[i]
  }
  return [n, sum]
}

function matrix(ctx: Ctx) {
  const m = ctx.getTransform()
  return [m.a, m.b, m.c, m.d, m.e, m.f]
}

test('getTransform() returns Blink double CTM', (t) => {
  // The float CTM gave 0.9999999403953552 for a and d.
  let ctx = newCtx()
  ctx.rotate(1)
  ctx.rotate(-1)
  t.deepEqual(matrix(ctx), [1, 0, 0, 1, 0, 0])
  ctx = newCtx()
  ctx.rotate(2.5)
  ctx.rotate(-2.5)
  t.deepEqual(matrix(ctx), [0.9999999999999999, 0, 0, 0.9999999999999999, 0, 0])
  // The float CTM snapped to the identity.
  ctx = newCtx()
  ctx.rotate(1e-5)
  t.deepEqual(matrix(ctx), [0.99999999995, 0.000009999999999833334, -0.000009999999999833334, 0.99999999995, 0, 0])
  // The float CTM turned by ClampTo<float>(degrees): 0.7164095044136047, ...
  ctx = newCtx()
  ctx.rotate(1e39)
  t.deepEqual(
    matrix(ctx),
    [-0.9999750831715065, -0.007059251811535819, 0.007059251811535819, -0.9999750831715065, 0, 0],
  )
  ctx = newCtx()
  ctx.translate(10.5, 20.25)
  ctx.rotate(0.7)
  ctx.scale(3, 0.5)
  ctx.transform(1, 0.2, 0.3, 1, 5, 6)
  t.deepEqual(
    matrix(ctx),
    [
      2.2301047921697372, 2.0091372815812254, 0.36624915229008226, 0.962217035195186, 20.039979747554256,
      32.20779187041883,
    ],
  )
  // setTransform() clamps its numbers to float, as Blink's transform() does.
  ctx = newCtx()
  ctx.setTransform(1.1, 0.2, 0.3, 0.9, 1e-30, 5)
  ctx.translate(0.1, 0.1)
  t.deepEqual(
    matrix(ctx),
    [
      1.100000023841858, 0.20000000298023224, 0.30000001192092896, 0.8999999761581421, 0.1400000056624413,
      5.109999999552965,
    ],
  )
})

test('setTransform(getTransform()) after rotate(a); rotate(-a) leaves the path where Chrome does', (t) => {
  // rotate(a); rotate(-a) is the double identity for these angles, so
  // setTransform(getTransform()) maps nothing and the closed arc that rounds
  // to one point stays in Blink's ArcBuilder: Chrome strokes its dot. With
  // the float getTransform() (0.99999994...) the path left the builder and
  // the dot was pruned (0). Of 2000 such angles, 394 differed; now none.
  const dot = (i: number) => {
    const a = (i + 1) * 0.00314159
    const ctx = newCtx()
    ctx.lineWidth = 20
    ctx.lineCap = 'round'
    ctx.rotate(a)
    ctx.rotate(-a)
    ctx.arc(50, 50, 30, 1, 1 + 1e-7)
    ctx.setTransform(ctx.getTransform())
    ctx.closePath()
    ctx.resetTransform()
    ctx.stroke()
    return ink(ctx)[0]
  }
  for (const i of [3, 6, 8, 9, 11, 13]) t.is(dot(i), 342, `angle ${(i + 1) * 0.00314159}`)
  // Here rotate(-a) does not land on the double identity: Chrome prunes too.
  for (const i of [7, 12, 16]) t.is(dot(i), 0, `angle ${(i + 1) * 0.00314159}`)
})

test('a path built before a huge rotate() comes back where it was', (t) => {
  // The path goes into the rotated space by RotateRadians(-a) in double and
  // comes back by the double CTM. The float CTM turns by ClampTo<float> of
  // the degrees, a different angle from |a| >= ~1e7: the rect left the canvas
  // (0 pixels).
  const CASES: [number, number[]][] = [
    [1e20, [820, 204000]],
    [1e39, [800, 204000]],
    [-Number.MAX_VALUE, [800, 203980]],
  ]
  for (const [a, chrome] of CASES) {
    for (const end of ['resetTransform', 'setTransform', 'restore']) {
      const ctx = newCtx()
      ctx.save()
      ctx.rect(20, 30, 40, 20)
      ctx.rotate(a)
      if (end === 'resetTransform') ctx.resetTransform()
      else if (end === 'setTransform') ctx.setTransform(1, 0, 0, 1, 0, 0)
      else ctx.restore()
      ctx.fill()
      t.deepEqual(ink(ctx), chrome, `rotate(${a}), ${end}()`)
    }
  }
})

test('a path filled under a tiny rotate() keeps the rotation Chrome gives it', (t) => {
  // SkMatrix::setRotate snaps the canvas's matrix to the identity, but the
  // path turns by -a in double. The float CTM snapped the path map too:
  // 918119 for all three.
  const CASES: [number, number[]][] = [
    [1.4e-5, [3721, 918060]],
    [-1.4e-5, [3721, 918058]],
    [1.5e-5, [3721, 918060]],
  ]
  for (const [a, chrome] of CASES) {
    const ctx = newCtx()
    ctx.translate(-10000, 0)
    ctx.rect(10020.5, 20.5, 60, 60)
    ctx.rotate(a)
    ctx.fill()
    t.deepEqual(ink(ctx), chrome, `rotate(${a})`)
  }
})

test('the canvas matrix is changed in float like SkM44', (t) => {
  // SkM44::setConcat rounds every product and sum to float; SkMatrix rounds
  // a*b + c*d once from double. These 3 of 1500 random sequences differ
  // (SkMatrix gave 586706, 326060 and 177603).
  type Op = [string, ...number[]]
  const CASES: [Op[], number[]][] = [
    [
      [
        ['translate', 57.362037658691406, 40.59016036987305],
        ['rotate', 1.2415789887309074],
        ['rotate', -1.7154523245990276],
        ['scale', 1.061824917793274, 1.9980862140655518],
      ],
      [2718, 586771],
    ],
    [
      [
        ['translate', 66.70171356201172, 66.21296691894531],
        ['rotate', -1.0498483665287495],
        [
          'transform',
          0.21415549516677856,
          0.9767996072769165,
          -1.074479579925537,
          0.19273994863033295,
          1.1379575729370117,
          -1.1839826107025146,
        ],
        ['translate', -3.45875883102417, -0.15157045423984528],
        ['translate', -4.263305187225342, 4.134353160858154],
      ],
      [1600, 326022],
    ],
    [
      [
        ['translate', 68.45648193359375, 37.937225341796875],
        [
          'transform',
          -0.17885681986808777,
          0.9838750958442688,
          -1.082262635231018,
          -0.16097114980220795,
          1.9613444805145264,
          -1.447340965270996,
        ],
        ['rotate', -0.7407456021755934],
        ['scale', 0.9007195234298706, 0.6063011288642883],
      ],
      [938, 177621],
    ],
  ]
  for (const [ops, chrome] of CASES) {
    const ctx = newCtx()
    for (const [op, ...args] of ops) {
      if (op === 'translate') ctx.translate(args[0], args[1])
      else if (op === 'rotate') ctx.rotate(args[0])
      else if (op === 'scale') ctx.scale(args[0], args[1])
      else ctx.transform(args[0], args[1], args[2], args[3], args[4], args[5])
    }
    ctx.beginPath()
    ctx.moveTo(-20.3, -15.7)
    ctx.lineTo(22.1, -18.2)
    ctx.lineTo(17.9, 21.3)
    ctx.closePath()
    ctx.fill()
    ctx.lineWidth = 1.7
    ctx.strokeRect(-25.2, -25.6, 50.1, 50.3)
    t.deepEqual(ink(ctx), chrome, JSON.stringify(ops))
  }
})

test('a point added under a singular CTM goes through the double CTM', (t) => {
  // canvas_path.cc:133-135: lineTo maps its point by GetTransform(). The
  // float CTM turned rotate(1e39) by other degrees: 364 / 71587.
  const CASES: [number, number[]][] = [
    [1e39, [402, 79484]],
    [1e10, [554, 108246]],
    [0.7, [491, 96272]],
  ]
  for (const [a, chrome] of CASES) {
    const ctx = newCtx()
    ctx.lineWidth = 4
    ctx.moveTo(20, 20)
    ctx.translate(50, 50)
    ctx.rotate(a)
    ctx.scale(0, 1)
    ctx.lineTo(10, 20)
    ctx.resetTransform()
    ctx.lineTo(80, 80)
    ctx.stroke()
    t.deepEqual(ink(ctx), chrome, `rotate(${a})`)
  }
})

test('isPointInPath() and isPointInStroke() take a point like Blink', (t) => {
  // A finite point past float range is FLT_MAX (ClampTo<float>); it was inf.
  let ctx = newCtx()
  ctx.rect(0, 0, 3.4028234663852886e38, 10)
  t.deepEqual(
    [ctx.isPointInPath(1e39, 5), ctx.isPointInPath(3.4e38, 5), ctx.isPointInPath(-1e39, 5)],
    [true, true, false],
  )
  // A point that is not finite is outside, wherever the CTM maps 0.
  ctx = newCtx()
  ctx.rotate(0.5)
  ctx.rect(-10, -10, 200, 200)
  ctx.lineWidth = 10
  t.deepEqual(
    [
      ctx.isPointInPath(NaN, 50),
      ctx.isPointInPath(50, Infinity),
      ctx.isPointInPath(1e39, 1e39),
      ctx.isPointInStroke(NaN, 50),
      ctx.isPointInStroke(1e39, -1e39),
      ctx.isPointInPath(50, 50),
    ],
    [false, false, false, false, false, true],
  )
})
