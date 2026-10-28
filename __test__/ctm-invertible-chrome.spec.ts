// Blink decides whether the CTM is invertible from its double CTM:
// AffineTransform::IsInvertible() is std::isnormal(Det()) (affine_transform.cc
// m156), set with every SetTransform (canvas_rendering_context_2d_state.cc).
// Under a singular CTM Blink draws nothing, clips nothing, adds no rect, arc
// or ellipse, maps moveTo/lineTo points by the CTM, ignores translate(), and
// leaves the path where it is on a transform call or restore()
// (canvas_path.cc, canvas_2d_recorder_context.cc). The context asked the float
// canvas matrix, which can be singular where the double CTM is not, and the
// other way round. Every value is pinned to Chrome 156 CPU canvas
// (--disable-gpu, getContext('2d', { willReadFrequently: true })).
import test from 'ava'

import { createCanvas } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const FLT_MAX = 3.4028234663852886e38

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

interface Probe {
  /** getTransform() after translate(1, 2). */
  afterTranslate: number[]
  /** isPointInPath(25, 25), isPointInPath(5, 5) of rect(1, 1, 10, 10). */
  hit: boolean[]
  /** That rect filled after resetTransform(). */
  rect: number[]
  /** moveTo, lineTo, lineTo, arc, filled after resetTransform(). */
  lines: number[]
  /** clip(rect(0, 0, 1, 1)), then fillRect(0, 0, 100, 100) at the identity. */
  clip: number[]
}

function probe(setup: (ctx: Ctx) => void): Probe {
  let ctx = newCtx()
  ctx.translate(20, 20)
  setup(ctx)
  ctx.translate(1, 2)
  const afterTranslate = matrix(ctx)
  ctx.beginPath()
  ctx.rect(1, 1, 10, 10)
  const hit = [ctx.isPointInPath(25, 25), ctx.isPointInPath(5, 5)]
  ctx.resetTransform()
  ctx.fill()
  const rect = ink(ctx)

  ctx = newCtx()
  ctx.translate(20, 20)
  setup(ctx)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(30, 5)
  ctx.lineTo(5, 30)
  ctx.arc(10, 10, 8, 0, 6)
  ctx.resetTransform()
  ctx.fill()
  const lines = ink(ctx)

  ctx = newCtx()
  ctx.translate(20, 20)
  setup(ctx)
  ctx.beginPath()
  ctx.rect(0, 0, 1, 1)
  ctx.clip()
  ctx.resetTransform()
  ctx.fillRect(0, 0, 100, 100)
  return { afterTranslate, hit, rect, lines, clip: ink(ctx) }
}

test('a double CTM that is invertible works when the float matrix is singular', (t) => {
  // Double det 9.5e-8; the float entries give 0.4 * 16 - 0.8 * 8 = 0.
  const floatSingular = probe((ctx) => {
    ctx.scale(1, 0.8)
    ctx.transform(0.4, 1, 8, 20, 0, 0)
  })
  t.deepEqual(floatSingular, {
    afterTranslate: [
      0.4000000059604645, 0.800000011920929, 8, 16.00000023841858, 36.400000005960464, 52.80000048875809,
    ],
    hit: [false, false],
    rect: [9, 80],
    lines: [12, 107],
    // The canvas clips with its float matrix: nothing is left.
    clip: [0, 0],
  })
  // The float matrix is 0, then stays 0; the double CTM comes back.
  const tinyBack = probe((ctx) => {
    ctx.scale(1e-30, 1e-30)
    ctx.scale(1e-30, 1e-30)
    ctx.scale(1e30, 1e30)
    ctx.scale(1e30, 1e30)
  })
  const back = {
    afterTranslate: [1.0000000364370867, 0, 0, 1.0000000364370867, 21.000000036437086, 22.000000072874172],
    hit: [true, false],
    rect: [100, 25500],
    lines: [394, 87131],
    clip: [0, 0],
  }
  t.deepEqual(tinyBack, back)
  // The float matrix overflows to inf.
  const hugeBack = probe((ctx) => {
    ctx.scale(1e30, 1e30)
    ctx.scale(1e30, 1e30)
    ctx.scale(1e-30, 1e-30)
    ctx.scale(1e-30, 1e-30)
  })
  t.deepEqual(hugeBack, back)
  // SkM44 puts NaN in the float 2x2 (inf * 0); translate() still works.
  const nan = probe((ctx) => {
    ctx.translate(FLT_MAX, FLT_MAX)
    ctx.translate(FLT_MAX, FLT_MAX)
    ctx.rotate(0.5)
    ctx.translate(-FLT_MAX, -FLT_MAX)
    ctx.translate(-FLT_MAX, -FLT_MAX)
  })
  t.deepEqual(
    nan.afterTranslate,
    [
      0.8775825618903728, 0.479425538604203, -0.479425538604203, 0.8775825618903728, 4.0959308084819926e38,
      -2.42967108410516e38,
    ],
  )
  t.deepEqual(nan.clip, [0, 0])
})

test('a double CTM that is singular draws and builds nothing when the float matrix is not', (t) => {
  // Double det 0; the float entries give 3 * 4.9 - 2.1 * 7 = 9.5e-7.
  const setup = (ctx: Ctx) => {
    ctx.scale(1, 0.7)
    ctx.transform(3, 3, 7, 7, 0, 0)
  }
  t.deepEqual(probe(setup), {
    afterTranslate: [3, 2.099999964237213, 7, 4.899999916553497, 20, 20],
    hit: [false, false],
    rect: [0, 0],
    lines: [0, 0],
    clip: [10000, 2550000],
  })
  const ctx = newCtx()
  ctx.translate(20, 20)
  setup(ctx)
  ctx.fillRect(0, 0, 10, 10)
  t.deepEqual(ink(ctx), [0, 0])
})

test('restore() maps the path by the restored double CTM only when it is invertible', (t) => {
  const run = (setup: (ctx: Ctx) => void) => {
    const ctx = newCtx()
    ctx.translate(20, 20)
    setup(ctx)
    ctx.save()
    ctx.resetTransform()
    ctx.beginPath()
    ctx.rect(30, 30, 20, 20)
    ctx.restore()
    ctx.resetTransform()
    ctx.fill()
    return [...ink(ctx), ctx.isPointInPath(40, 40)]
  }
  // Invertible double CTM, singular float matrix: the rect goes into the
  // restored space and back by a matrix the float canvas cannot draw.
  t.deepEqual(
    run((ctx) => {
      ctx.scale(1, 0.8)
      ctx.transform(0.4, 1, 8, 20, 0, 0)
    }),
    [0, 0, false],
  )
  t.deepEqual(
    run((ctx) => {
      ctx.scale(1e-30, 1e-30)
      ctx.scale(1e-30, 1e-30)
    }),
    [0, 0, false],
  )
  // Singular double CTM: the rect stays in device space.
  t.deepEqual(
    run((ctx) => {
      ctx.scale(1, 0.7)
      ctx.transform(3, 3, 7, 7, 0, 0)
    }),
    [400, 102000, true],
  )
})

test('a path point mapped past float range stays in the path', (t) => {
  // Blink maps the path in place (PathBuilder::Transform): scale(1e-39)
  // sends the earlier points to inf, and the path is no longer finite.
  const ctx = newCtx()
  ctx.translate(50, 50)
  ctx.moveTo(-30, -30)
  ctx.lineTo(30, -20)
  ctx.lineTo(0, 30)
  ctx.scale(1e-39, 1e-39)
  ctx.rect(-10, -10, 30, 20)
  t.deepEqual(matrix(ctx), [1.0000002153053333e-39, 0, 0, 1.0000002153053333e-39, 50, 50])
  t.is(ctx.isPointInPath(50, 50), false)
  t.is(ctx.isPointInStroke(50, 50), false)
  ctx.resetTransform()
  ctx.fill()
  t.deepEqual(ink(ctx), [0, 0])
})
