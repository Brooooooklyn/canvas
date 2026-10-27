// Full-sweep arc() and ellipse() (issue #1403). A clockwise s -> s + 2π sweep
// used to draw nothing for about 7% of start angles (e.g. -π/2). Every count
// is the number of pixels with alpha > 0, pinned to Chrome 156 CPU canvas
// (--disable-gpu, getContext('2d', { willReadFrequently: true })).
import test from 'ava'

import { createCanvas, Path2D } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const TAU = 2 * Math.PI
const WIN_ARM64 = process.platform === 'win32' && process.arch === 'arm64'

const small = createCanvas(40, 40).getContext('2d')
const big = createCanvas(200, 200).getContext('2d')

function countPainted(ctx: Ctx) {
  const { width, height } = ctx.canvas
  const data = ctx.getImageData(0, 0, width, height).data
  let n = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]) n++
  }
  return n
}

// The reporter's setup: lineWidth 2, a new path, then stroke.
function stroke(ctx: Ctx, build: (ctx: Ctx) => void) {
  ctx.reset()
  ctx.lineWidth = 2
  ctx.beginPath()
  build(ctx)
  ctx.stroke()
  return countPainted(ctx)
}

const STARTS: Record<string, number> = {
  '0': 0,
  '-1': -1,
  '-π/4': -Math.PI / 4,
  '-π/2': -Math.PI / 2,
  '5π/4': (5 * Math.PI) / 4,
}

test('arc() strokes a full circle for every start', (t) => {
  const expected: Record<string, number> = { '0': 299, '-1': 298, '-π/2': 299, '5π/4': 289 }
  for (const [name, n] of Object.entries(expected)) {
    const s = STARTS[name]
    t.is(
      stroke(small, (ctx) => ctx.arc(20, 20, 15, s, s + TAU)),
      n,
      name,
    )
  }
})

test('arc() at -π/4 strokes a full circle', (t) => {
  const s = -Math.PI / 4
  // win32-arm64: the prebuilt Skia is built by clang-cl without
  // -ffp-contract=off (gn/skia/BUILD.gn adds it only `if (is_clang && !is_win)`),
  // so SkPoint::DotProduct in SkConic::BuildUnitArc becomes one fmadd. For the
  // second 180° half the dot is -0.99999994, not -1, that half's conics move
  // 1-2 ulps, and 9 faint edge pixels (alpha <= 7) round to 0. Same ring, no gap.
  const full = WIN_ARM64 ? 290 : 299
  // Chrome's general route: a path that is not empty before arc().
  const afterMoveTo = stroke(small, (ctx) => {
    ctx.moveTo(20 + 15 * Math.cos(s), 20 + 15 * Math.sin(s))
    ctx.arc(20, 20, 15, s, s + TAU)
  })
  t.is(afterMoveTo, full)
  // Chrome 156 draws nothing here: arc() on an empty path takes its drawArc
  // fast path, which sends the 359.99997 degree sweep to Skia as one arcTo.
  // The set of such starts changes between Chrome releases, and the spec says
  // the arc is the whole circumference, so we draw it like Chrome's ellipse()
  // and moveTo + arc() do.
  t.is(
    stroke(small, (ctx) => ctx.arc(20, 20, 15, s, s + TAU)),
    full,
  )
})

test('ellipse() strokes a full ellipse for every start', (t) => {
  const expected: Record<string, number> = { '0': 256, '-1': 237, '-π/4': 248, '-π/2': 256, '5π/4': 248 }
  for (const [name, n] of Object.entries(expected)) {
    const s = STARTS[name]
    t.is(
      stroke(small, (ctx) => ctx.ellipse(20, 20, 15, 10, 0, s, s + TAU)),
      n,
      name,
    )
  }
  t.is(
    stroke(big, (ctx) => ctx.ellipse(100, 100, 80, 40, 0, -Math.PI / 2, (3 * Math.PI) / 2)),
    1166,
  )
})

test('a tiny negative start still gives a full sweep', (t) => {
  // f32(-1e-45) + 2π rounds to 2π; Blink folds it back to 0 (crbug.com/503422).
  // A start of 2π draws the same points as 0, so this pins the output, not the fold.
  for (const s of [-1e-8, -1e-38, -1e-45, -5e-324]) {
    t.is(
      stroke(small, (ctx) => ctx.ellipse(20, 20, 15, 10, 0, s, s + TAU)),
      256,
      `ellipse ${s}`,
    )
    t.is(
      stroke(small, (ctx) => {
        ctx.moveTo(20 + 15 * Math.cos(s), 20 + 15 * Math.sin(s))
        ctx.arc(20, 20, 15, s, s + TAU)
      }),
      299,
      `moveTo + arc ${s}`,
    )
  }
})

test('Path2D.arc() at -π/2 strokes a full circle', (t) => {
  const path = new Path2D()
  path.arc(20, 20, 15, -Math.PI / 2, (3 * Math.PI) / 2)
  t.not(path.toSVGString(), '')
  small.reset()
  small.lineWidth = 2
  small.stroke(path)
  t.is(countPainted(small), 299)
})

// WPT 2d.path.arc.twopie.6
test('arc() from 5 to 5 + 2π fills the circle', (t) => {
  const ctx = createCanvas(100, 50).getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, 100, 50)
  ctx.fillStyle = '#000'
  ctx.beginPath()
  ctx.moveTo(50, 25)
  ctx.arc(50, 25, 50, 5, 5 + 2 * Math.PI, false)
  ctx.closePath()
  ctx.fill()
  t.deepEqual([...ctx.getImageData(5, 25, 1, 1).data], [0, 0, 0, 255])
})

test('a zero-radius full arc draws nothing', (t) => {
  for (const s of [0, -Math.PI / 2]) {
    big.reset()
    big.lineWidth = 20
    big.lineCap = 'round'
    big.beginPath()
    big.arc(100, 100, 0, s, s + TAU)
    big.stroke()
    t.is(countPainted(big), 0, `start ${s}`)
  }
})

// Chrome's general route (ellipse(), or arc() on a non-empty path) is never
// empty on this grid. The counts vary per start, so only check "not empty".
test('full and near-full sweeps are never empty', async (t) => {
  const builds: Record<string, (ctx: Ctx, s: number) => void> = {
    'arc cw': (ctx, s) => ctx.arc(20, 20, 15, s, s + TAU),
    'arc ccw': (ctx, s) => ctx.arc(20, 20, 15, s, s - TAU, true),
    'arc cw +0.5': (ctx, s) => ctx.arc(20, 20, 15, s, s + TAU + 0.5),
    'arc cw -1e-6': (ctx, s) => ctx.arc(20, 20, 15, s, s + TAU - 1e-6),
    'ellipse cw': (ctx, s) => ctx.ellipse(20, 20, 15, 10, 0, s, s + TAU),
    'ellipse ccw': (ctx, s) => ctx.ellipse(20, 20, 15, 10, 0, s, s - TAU, true),
    'ellipse cw +0.5': (ctx, s) => ctx.ellipse(20, 20, 15, 10, 0, s, s + TAU + 0.5),
    'ellipse cw -1e-6': (ctx, s) => ctx.ellipse(20, 20, 15, 10, 0, s, s + TAU - 1e-6),
  }
  const empty: string[] = []
  const unequal: number[] = []
  for (let i = -1000; i <= 1000; i++) {
    const s = i * 0.02
    for (const [name, build] of Object.entries(builds)) {
      if (!stroke(small, (ctx) => build(ctx, s))) {
        empty.push(`${name} ${s}`)
      }
    }
    // arc() is ellipse() with equal radii; both build the same path.
    const arc = stroke(small, (ctx) => ctx.arc(20, 20, 15, s, s + TAU))
    const arcData = small.getImageData(0, 0, 40, 40).data
    const ellipse = stroke(small, (ctx) => ctx.ellipse(20, 20, 15, 15, 0, s, s + TAU))
    if (arc !== ellipse || !Buffer.from(arcData).equals(Buffer.from(small.getImageData(0, 0, 40, 40).data))) {
      unequal.push(s)
    }
    await new Promise(setImmediate)
  }
  t.deepEqual(empty, [])
  t.deepEqual(unequal, [])
})
