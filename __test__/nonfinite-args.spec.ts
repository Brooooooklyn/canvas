// Non-finite and float-overflow arguments of path methods, transforms,
// Path2D.addPath and clearRect. Every expected value was measured in Chrome 155
// CPU canvas (--disable-gpu, getContext('2d', { willReadFrequently: true })) in
// a standards-mode page; Chrome arm64 and x64 give the same values.
import test from 'ava'

import { createCanvas, Path2D } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

// Untyped access for arguments the typings reject on purpose.
const loose = <T>(value: T) => value as any

/** Alpha sum and FNV-1a hash of every byte of the canvas. */
function sum(ctx: Ctx) {
  const data = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data
  let a = 0
  let h = 2166136261
  for (let i = 0; i < data.length; i++) {
    if ((i & 3) === 3) a += data[i]
    h = Math.imul(h ^ data[i], 16777619) >>> 0
  }
  return { a, h: h.toString(16) }
}

const px = (ctx: Ctx, x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data]

// getTransform() rounded to 6 significant digits.
const transformOf = (ctx: Ctx) => {
  const m = ctx.getTransform()
  return [m.a, m.b, m.c, m.d, m.e, m.f].map((v) => Number(v.toPrecision(6)))
}

const BAD = [NaN, Infinity, -Infinity, 1e300, -1e300, 3.5e38, 1e39]

const PATH_OPS: Record<string, number[]> = {
  moveTo: [20, 20],
  lineTo: [30, 5],
  quadraticCurveTo: [30, 5, 30, 30],
  bezierCurveTo: [10, 5, 20, 5, 30, 30],
  arcTo: [30, 5, 30, 30, 5],
  rect: [12, 12, 10, 10],
  roundRect: [12, 12, 10, 10, 3],
  arc: [20, 20, 5, 0, 6],
  ellipse: [20, 20, 6, 4, 0.5, 0, 6],
}

/**
 * rect(1,1,8,8); <call>; rect(30,30,8,8); fill() on a 40x40 canvas, on the
 * context path or on a Path2D.
 */
function pathScene(target: 'ctx' | 'Path2D', call: (path: any) => void) {
  const ctx = createCanvas(40, 40).getContext('2d')
  const path: any = target === 'ctx' ? ctx : new Path2D()
  path.rect(1, 1, 8, 8)
  call(path)
  path.rect(30, 30, 8, 8)
  if (target === 'ctx') {
    ctx.fill()
    return { s: sum(ctx), ipp: [ctx.isPointInPath(5, 5), ctx.isPointInPath(34, 34)] }
  }
  ctx.fill(path)
  return { s: sum(ctx), ipp: [ctx.isPointInPath(path, 5, 5), ctx.isPointInPath(path, 34, 34)] }
}

// Only the two rects: the bad call added nothing and broke nothing.
const NO_OP = { s: { a: 32640, h: 'c814ddc5' }, ipp: [true, true] }

// Blink canvas_path.cc: saturated_cast<float> of every argument, then a
// non-finite one makes the call a no-op. Before, arc/ellipse aborted the
// process and the other methods put Infinity/NaN into the path.
test('path methods ignore non-finite and float-overflow arguments', (t) => {
  for (const target of ['ctx', 'Path2D'] as const) {
    for (const [op, base] of Object.entries(PATH_OPS)) {
      for (let i = 0; i < base.length; i++) {
        for (const v of BAD) {
          const args = base.map((b, j) => (j === i ? v : b))
          t.deepEqual(
            pathScene(target, (p) => p[op](...args)),
            NO_OP,
            `${target}.${op}(${args.join(', ')})`,
          )
        }
      }
    }
    // Each radius is checked in the order given, before the negative check
    // (canvas_path.cc:597-628).
    for (const v of BAD) {
      for (const radii of [[v], [2, v], [v, -1]]) {
        t.deepEqual(
          pathScene(target, (p) => p.roundRect(12, 12, 10, 10, radii)),
          NO_OP,
          `${target}.roundRect(12, 12, 10, 10, [${radii.join(', ')}])`,
        )
      }
    }
  }
})

test('the float range ends at FLT_MAX for path methods', (t) => {
  // 3.4028235e38 rounds to FLT_MAX in a plain f64 -> f32 cast, but
  // saturated_cast<float> treats it as out of range.
  for (const target of ['ctx', 'Path2D'] as const) {
    for (const v of [3.4028235e38, 3.4028235677973362e38, 3.4028235677973366e38]) {
      t.deepEqual(
        pathScene(target, (p) => p.lineTo(v, 5)),
        NO_OP,
        `${target}.lineTo(${v}, 5)`,
      )
      t.deepEqual(
        pathScene(target, (p) => p.arc(v, 20, 5, 0, 6)),
        NO_OP,
        `${target}.arc(${v}, 20, 5, 0, 6)`,
      )
    }
    // FLT_MAX itself is kept: the huge triangle covers the whole canvas and
    // with the rects makes a zero winding sum, so nothing is painted.
    const kept = { s: { a: 0, h: 'f4deb1c5' }, ipp: [true, true] }
    t.deepEqual(
      pathScene(target, (p) => p.lineTo(3.4028234663852886e38, 5)),
      kept,
      `${target}.lineTo(FLT_MAX)`,
    )
    t.deepEqual(
      pathScene(target, (p) => p.arc(3.4028234663852886e38, 20, 5, 0, 6)),
      kept,
      `${target}.arc(FLT_MAX)`,
    )
  }
})

test('arc with a non-finite center keeps the path usable', (t) => {
  for (const v of [NaN, Infinity, 1e300]) {
    const ctx = createCanvas(40, 40).getContext('2d')
    ctx.beginPath()
    ctx.moveTo(2, 20)
    ctx.lineTo(38, 20)
    ctx.arc(v, 20, 5, 0, 1)
    ctx.lineTo(38, 38)
    ctx.lineWidth = 2
    ctx.stroke()
    t.deepEqual(sum(ctx), { a: 27540, h: '71c4bb75' }, String(v))
  }
})

test('rotated ellipses draw like Chrome, also with a huge finite rotation', (t) => {
  // [rotation, ellipse(20,20,5,4,r,0,6), ellipse(20,20,6,4,r,0,6)]. Up to
  // 1e20 the values are unchanged; 3e38 aborted the process before.
  const cases: [number, string, string][] = [
    [0.5, '47580 230fc8d', '50276 bed6d629'],
    [Math.PI / 2, '48248 fe249977', '51403 83608308'],
    [Math.PI, '49403 4634adfa', '52360 d375775f'],
    [1e10, '48734 33ffab45', '52237 2c7d3642'],
    [1e20, '47166 b0fdea05', '49883 9e0848ea'],
    [3e38, '48768 b117985', '52388 ae6da11f'],
  ]
  for (const target of ['ctx', 'Path2D'] as const) {
    for (const [r, small, large] of cases) {
      for (const [rx, expected] of [
        [5, small],
        [6, large],
      ] as const) {
        const { s, ipp } = pathScene(target, (p) => p.ellipse(20, 20, rx, 4, r, 0, 6))
        t.is(`${s.a} ${s.h}`, expected, `${target}.ellipse(20, 20, ${rx}, 4, ${r}, 0, 6)`)
        t.deepEqual(ipp, [true, true])
      }
    }
    // Chrome 47998 / 50941: ours rotates in f32 around the center, Blink in
    // double around the origin, so a few edge pixels differ. It must draw.
    for (const rx of [5, 6]) {
      t.true(pathScene(target, (p) => p.ellipse(20, 20, rx, 4, 1e38, 0, 6)).s.a > 47000, `${target} rotation 1e38`)
    }
  }
})

const TRANSFORM_OPS: Record<string, number[]> = {
  scale: [2, 2],
  rotate: [0.5],
  translate: [3, 3],
  transform: [1, 0, 0, 1, 3, 3],
  setTransform: [1, 0, 0, 1, 3, 3],
}

/** rect(2,2,6,6); <call>; fill(); fillRect(10,10,6,6); resetTransform(); fillRect(30,30,6,6). */
function transformScene(call: (ctx: Ctx) => void) {
  const ctx = createCanvas(40, 40).getContext('2d')
  ctx.rect(2, 2, 6, 6)
  call(ctx)
  const transform = transformOf(ctx)
  ctx.fill()
  ctx.fillRect(10, 10, 6, 6)
  const s1 = sum(ctx)
  ctx.resetTransform()
  ctx.fillRect(30, 30, 6, 6)
  return { transform, s1, s2: sum(ctx) }
}

const UNCHANGED = { transform: [1, 0, 0, 1, 0, 0], s1: { a: 18360, h: 'a6b63e85' }, s2: { a: 27540, h: '9c10ffe5' } }

// canvas_2d_recorder_context.cc:1354-1553: a non-finite argument makes the
// call a no-op. Before, NaN/Infinity went into the matrix and every later
// draw painted nothing until resetTransform().
test('transforms ignore non-finite arguments', (t) => {
  for (const [op, base] of Object.entries(TRANSFORM_OPS)) {
    for (let i = 0; i < base.length; i++) {
      for (const v of [NaN, Infinity, -Infinity]) {
        const args = base.map((b, j) => (j === i ? v : b))
        t.deepEqual(
          transformScene((ctx) => loose(ctx)[op](...args)),
          UNCHANGED,
          `${op}(${args.join(', ')})`,
        )
      }
    }
  }
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
    for (const v of [NaN, Infinity, -Infinity]) {
      t.deepEqual(
        transformScene((ctx) => ctx.setTransform({ a: 1, b: 0, c: 0, d: 1, e: 3, f: 3, [key]: v })),
        UNCHANGED,
        `setTransform({ ${key}: ${v} })`,
      )
    }
  }
})

test('transform arguments clamp to FLT_MAX', (t) => {
  const MAX = 3.40282e38
  const cases: [(ctx: Ctx) => void, number[]][] = [
    [(ctx) => ctx.translate(1e300, 3), [1, 0, 0, 1, MAX, 3]],
    [(ctx) => ctx.translate(3, -1e300), [1, 0, 0, 1, 3, -MAX]],
    [(ctx) => ctx.translate(3.5e38, 0), [1, 0, 0, 1, MAX, 0]],
    [(ctx) => ctx.scale(1e300, 2), [MAX, 0, 0, 2, 0, 0]],
    [(ctx) => ctx.scale(1, -1e39), [1, 0, 0, -MAX, 0, 0]],
    [(ctx) => ctx.transform(1e300, 0, 0, 1, 3, 3), [MAX, 0, 0, 1, 3, 3]],
    [(ctx) => ctx.setTransform(1, 1e300, 0, 1, 3, 3), [1, MAX, 0, 1, 3, 3]],
    [(ctx) => ctx.setTransform({ a: 1, b: 0, c: 0, d: 1, e: 1e300, f: 3 }), [1, 0, 0, 1, MAX, 3]],
  ]
  for (const [call, expected] of cases) {
    const ctx = createCanvas(40, 40).getContext('2d')
    call(ctx)
    t.deepEqual(transformOf(ctx), expected, call.toString())
  }
})

test('rotate paints like Chrome for huge angles', (t) => {
  // Blink paints with ClampTo<float>(base::RadToDeg(angle)) degrees, a double
  // pi in Chrome 156; before, the f32 degrees overflowed and the matrix became
  // NaN (nothing painted).
  const cases: [number, string][] = [
    [1e300, '45452 3cae86f5'],
    [-1e300, '45455 1445a014'],
    // The double degrees overflow to inf; Blink's ClampTo makes them FLT_MAX.
    [3.13756645e306, '45452 3cae86f5'],
    [-3.13756645e306, '45455 1445a014'],
    [Number.MAX_VALUE, '45452 3cae86f5'],
    [-Number.MAX_VALUE, '45455 1445a014'],
    [3.5e38, '45452 3cae86f5'],
    [1e39, '45452 3cae86f5'],
    [1e10, '46098 d7d95f45'],
    [1e7, '46178 1937ad1b'],
    [12345.678, '46052 178c6623'],
    [0.1, '46174 d71fe815'],
    [1, '45969 71211682'],
  ]
  for (const [angle, expected] of cases) {
    const ctx = createCanvas(40, 40).getContext('2d')
    ctx.translate(20, 20)
    ctx.rotate(angle)
    ctx.fillRect(-15, -3, 30, 6)
    const { a, h } = sum(ctx)
    t.is(`${a} ${h}`, expected, `rotate(${angle})`)
    const m = ctx.getTransform()
    t.true([m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite), `rotate(${angle}) matrix`)
  }
})

test('Path2D.addPath skips a non-finite matrix', (t) => {
  // Blink path_2d.h addPath: the call adds nothing; before, the whole path
  // was lost (sum 0).
  for (const [key, v] of [
    ['a', NaN],
    ['b', -Infinity],
    ['e', Infinity],
    ['f', NaN],
  ] as const) {
    const ctx = createCanvas(40, 40).getContext('2d')
    const p = new Path2D()
    p.rect(1, 1, 5, 5)
    const q = new Path2D()
    q.rect(20, 20, 5, 5)
    q.addPath(p, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, [key]: v })
    ctx.fill(q)
    t.deepEqual(sum(ctx), { a: 6375, h: '467d1f8' }, `${key}: ${v}`)
  }
})

test('clearRect ignores non-finite and empty rects', (t) => {
  // ValidateRectForCanvas (canvas_2d_recorder_context.h:968): all finite and
  // not 0 x 0. Before, clearRect(0, 0, Infinity, Infinity) cleared the canvas.
  const scene = (args: number[]) => {
    const ctx = createCanvas(40, 40).getContext('2d')
    ctx.fillStyle = 'rgb(200,100,50)'
    ctx.fillRect(0, 0, 40, 40)
    loose(ctx).clearRect(...args)
    return { s: sum(ctx), px: px(ctx, 20, 20) }
  }
  const untouched = { s: { a: 408000, h: '38898545' }, px: [200, 100, 50, 255] }
  for (const args of [
    [0, 0, Infinity, Infinity],
    [-Infinity, -Infinity, Infinity, Infinity],
    [NaN, 0, 40, 40],
    [0, NaN, 40, 40],
    [0, 0, NaN, 40],
    [0, 0, 40, NaN],
    [0, 0, 0, 0],
    [5, 5, 0, 20],
    [5, 5, 20, 0],
  ]) {
    t.deepEqual(scene(args), untouched, `clearRect(${args.join(', ')})`)
  }
  // A finite overflow clamps to FLT_MAX and clears everything.
  const cleared = { s: { a: 0, h: 'f4deb1c5' }, px: [0, 0, 0, 0] }
  t.deepEqual(scene([0, 0, 1e300, 1e300]), cleared)
  t.deepEqual(scene([0, 0, 40, 40]), cleared)
  t.deepEqual(scene([10, 10, 10, 10]), { s: { a: 382500, h: '5f7b148d' }, px: [200, 100, 50, 255] })
})
