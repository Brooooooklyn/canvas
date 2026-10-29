// A moveTo that ends the path, carried through a CTM change. The context
// keeps its path in user space, so rotate(), transform() and setTransform()
// map it by the inverse (canvas_2d_recorder_context.cc). Skia drops a
// trailing moveTo from SkPath, so skiac_path_transform_self maps that point
// on its own with SkMatrix::mapPoint, inlined in skia_c.cpp. Chromium and
// libskia are compiled with -ffp-contract=off; skia_c.cpp was not, so on
// arm64 clang fused (x * sx + y * kx) + tx into one FMA and the point moved
// 1 ulp off libskia's mapPoints and Chrome. x64 builds have no FMA by default
// and matched already. Every value is pinned to Chrome 156 CPU canvas
// (--disable-gpu, getContext('2d', { willReadFrequently: true })).
import test from 'ava'

import { createCanvas } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

function alphaSum(ctx: Ctx) {
  const d = ctx.getImageData(0, 0, 100, 100).data
  let sum = 0
  for (let i = 3; i < d.length; i += 4) sum += d[i]
  return sum
}

type Op = 'rotate' | 'transform' | 'setTransform'

/** moveTo(p), the CTM change, lineTo(q), stroke: a 4 px square-cap line. */
function draw(op: Op, p: [number, number], a: number, q: [number, number]) {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.lineWidth = 4
  ctx.lineCap = 'square'
  ctx.moveTo(...p)
  const c = Math.cos(a)
  const s = Math.sin(a)
  if (op === 'rotate') ctx.rotate(a)
  else if (op === 'transform') ctx.transform(c, s, -s, c, 10, 5)
  else ctx.setTransform(c, s, -s, c, 10, 5)
  ctx.lineTo(...q)
  ctx.stroke()
  return alphaSum(ctx)
}

// [op, moveTo, angle, lineTo, Chrome 156 alpha sum]. The arm64 build with the
// FMA gave 68699, 82596, 31879, 87712, 87712 and 60346. Of 378 such scenes
// (3 ops, 6 points, 7 angles, 3 ends) it was off Chrome in 34; now in none.
const CASES: [Op, [number, number], number, [number, number], number][] = [
  ['rotate', [10.3, 20.7], 1, [80, 30], 68740],
  ['rotate', [77.7, 22.2], 2, [50, 80], 82544],
  ['rotate', [77.7, 22.2], -1, [20, 50], 31929],
  ['transform', [77.7, 22.2], 1, [80, 30], 87384],
  ['setTransform', [77.7, 22.2], 1, [80, 30], 87384],
  ['transform', [45.5, 70.1], 2, [20, 50], 60447],
]

test('a trailing moveTo follows a CTM change like Chrome', (t) => {
  for (const [op, p, a, q, chrome] of CASES) {
    t.is(draw(op, p, a, q), chrome, `${op}(${a}) from (${p}) to (${q})`)
  }
})
