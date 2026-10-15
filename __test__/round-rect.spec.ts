// roundRect() geometry, radii and errors (Blink canvas_path.cc roundRect,
// path_builder.cc AddRoundedRect). Every expected value was measured in
// Chrome 155 CPU canvas (--disable-gpu, getContext('2d', { willReadFrequently:
// true })) in a standards-mode page; Chrome arm64 and x64 give the same
// values.
import test from 'ava'

import { createCanvas, Path2D } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

/** Bounding box [x0, y0, x1, y1] of the pixels with alpha > 0 (null if none) and the alpha sum. */
function ink(ctx: Ctx) {
  const { width, height } = ctx.canvas
  const d = ctx.getImageData(0, 0, width, height).data
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  let sum = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = d[(y * width + x) * 4 + 3]
      sum += a
      if (a) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
    }
  }
  return { box: x1 < 0 ? null : [x0, y0, x1, y1], sum }
}

/** Runs `f` on a new canvas (default 60x60) and returns the ink. */
function draw(f: (ctx: Ctx) => void, size = 60) {
  const ctx = createCanvas(size, size).getContext('2d')
  f(ctx)
  return ink(ctx)
}

/** Fills roundRect(...args) on the context, or on a Path2D. */
const fill = (args: any[]) =>
  draw((ctx) => {
    ctx.beginPath()
    ;(ctx.roundRect as any)(...args)
    ctx.fill()
  })
const fillPath2D = (args: any[]) =>
  draw((ctx) => {
    const p = new Path2D()
    ;(p.roundRect as any)(...args)
    ctx.fill(p)
  })

/** Strokes roundRect(...args) with lineWidth 3 and dash [7, 5]. */
const dashed = (args: any[]) =>
  draw((ctx) => {
    ctx.beginPath()
    ;(ctx.roundRect as any)(...args)
    ctx.setLineDash([7, 5])
    ctx.lineWidth = 3
    ctx.stroke()
  })

test('roundRect with a negative width or height swaps corners like Chrome', (t) => {
  // The 4 radii are top-left, top-right, bottom-right, bottom-left; a flip
  // swaps them like the rect.
  t.deepEqual(fill([5, 45, 40, -40, [20, 0, 0, 0]]), { box: [5, 5, 44, 44], sum: 386113 })
  t.deepEqual(fill([5, 45, 40, -40, [20, 5, 10, 0]]), { box: [5, 5, 44, 44], sum: 378516 })
  t.deepEqual(fill([45, 45, -40, -40, [20, 5, 10, 0]]), { box: [5, 5, 44, 44], sum: 378490 })
  t.deepEqual(fill([45, 5, -40, 40, [20, 0, 0, 0]]), { box: [5, 5, 44, 44], sum: 385876 })
  t.deepEqual(fillPath2D([5, 45, 40, -40, [20, 0, 0, 0]]), { box: [5, 5, 44, 44], sum: 386113 })
})

test('roundRect dashes start after the top-left corner', (t) => {
  t.deepEqual(dashed([5, 5, 40, 40, 8]), { box: [3, 3, 46, 46], sum: 65749 })
  t.deepEqual(dashed([45, 45, -40, -40, [8, 2, 4, 12]]), { box: [3, 3, 46, 46], sum: 67445 })
  t.deepEqual(dashed([5, 15, 40, 20, 100]), { box: [3, 13, 46, 36], sum: 48122 })
})

test('roundRect with zero width or height adds a plain rect', (t) => {
  const stroke = (args: any[], then?: (ctx: Ctx) => void) =>
    draw((ctx) => {
      ctx.beginPath()
      ;(ctx.roundRect as any)(...args)
      then?.(ctx)
      ctx.lineWidth = 4
      ctx.stroke()
    })
  const lineTo = (ctx: Ctx) => ctx.lineTo(40, 40)
  t.deepEqual(stroke([10, 10, 0, 30, 5]), { box: [8, 10, 11, 39], sum: 30600 })
  // No moveTo after a flat rect: the lineTo continues from the rect's start.
  t.deepEqual(stroke([10, 40, 0, -30, 5], lineTo), { box: [8, 10, 39, 41], sum: 60180 })
  t.deepEqual(stroke([40, 10, -30, 0, 5], lineTo), { box: [10, 8, 41, 39], sum: 60180 })
  t.deepEqual(
    stroke([20, 20, 0, 0, 5], (ctx) => ctx.lineTo(40, 40)),
    { box: [18, 18, 41, 41], sum: 29982 },
  )
  t.deepEqual(
    draw((ctx) => {
      ctx.beginPath()
      ctx.roundRect(50, 30, -40, 0, 5)
      ctx.setLineDash([6, 4])
      ctx.lineWidth = 4
      ctx.lineCap = 'square'
      ctx.stroke()
    }),
    { box: [8, 28, 51, 31], sum: 44880 },
  )
})

test('roundRect ends with moveTo(x, y)', (t) => {
  const stroke = (args: number[], close = false) =>
    draw((ctx) => {
      ctx.beginPath()
      ctx.roundRect(args[0], args[1], args[2], args[3], args[4])
      if (close) ctx.closePath()
      ctx.lineTo(close ? 55 : 50, close ? 55 : 50)
      ctx.lineWidth = 2
      ctx.stroke()
    })
  t.deepEqual(stroke([10, 10, 30, 20, 5]), { box: [9, 9, 50, 50], sum: 72561 })
  t.deepEqual(stroke([40, 30, -30, -20, 5]), { box: [9, 9, 50, 50], sum: 72561 })
  t.deepEqual(stroke([10, 10, 30, 30, 6], true), { box: [9, 9, 55, 55], sum: 86874 })
})

test('roundRect large radius and negative size', (t) => {
  t.deepEqual(fill([5, 5, 30, 20, 100]), { box: [5, 5, 34, 24], sum: 128714 })
  t.deepEqual(fillPath2D([5, 5, 30, 20, 100]), { box: [5, 5, 34, 24], sum: 128714 })
  t.deepEqual(fill([35, 35, -30, -30, 5]), { box: [5, 5, 34, 34], sum: 223645 })
  t.deepEqual(fill([5, 5, 40, 30, 10]), { box: [5, 5, 44, 34], sum: 281708 })
  t.deepEqual(fill([5, 5, 40, 40, [2, 6, 10, 14]]), { box: [5, 5, 44, 44], sum: 388802 })
  // 40x40 canvas, lineWidth 3.
  const scene = (args: any[], mode: 'fill' | 'stroke') =>
    draw((ctx) => {
      ctx.beginPath()
      ;(ctx.roundRect as any)(...args)
      ctx.lineWidth = 3
      ctx[mode]()
    }, 40)
  t.deepEqual(scene([35, 35, -30, -30, [10, 0, 0, 0]], 'fill'), { box: [5, 5, 34, 34], sum: 223429 })
  t.deepEqual(scene([35, 35, -30, -30, [10, 0, 0, 0]], 'stroke'), { box: [3, 3, 36, 36], sum: 89196 })
  t.deepEqual(scene([5, 5, 30, 20, 100], 'fill'), { box: [5, 5, 34, 24], sum: 128714 })
  t.deepEqual(scene([5, 5, 30, 20, 100], 'stroke'), { box: [3, 3, 36, 26], sum: 65011 })
  t.deepEqual(scene([35, 35, -30, -30, 5], 'fill'), { box: [5, 5, 34, 34], sum: 223645 })
  t.deepEqual(scene([35, 35, -30, -30, 5], 'stroke'), { box: [3, 3, 36, 36], sum: 83936 })
})
