import test from 'ava'

import { Path2D, createCanvas } from '../index'

// https://github.com/Brooooooklyn/canvas/issues/1352
// Path2D.addPath used Skia's kExtend mode, which turns the added path's first
// moveTo into a lineTo from the current contour. The Canvas spec adds the
// path's subpaths as they are, so each added path must start a new subpath.

function square(x: number) {
  const path = new Path2D()
  path.rect(x, 10, 20, 20)
  return path
}

const SQUARE_10 = 'M10 10L30 10L30 30L10 30L10 10Z'
const SQUARE_60 = 'M60 10L80 10L80 30L60 30L60 10Z'

test('addPath keeps each added path as its own subpath', (t) => {
  const path = new Path2D()
  path.addPath(square(10))
  path.addPath(square(60))
  t.is(path.toSVGString(), SQUARE_10 + SQUARE_60)
})

test('addPath does not join an open contour to the added path', (t) => {
  const path = new Path2D()
  path.moveTo(0, 0)
  path.lineTo(5, 5)
  path.addPath(square(60))
  t.is(path.toSVGString(), 'M0 0L5 5' + SQUARE_60)
})

test('addPath applies the transform and still starts a new subpath', (t) => {
  const path = new Path2D()
  path.addPath(square(10))
  path.addPath(square(10), { a: 1, b: 0, c: 0, d: 1, e: 50, f: 0 })
  t.is(path.toSVGString(), SQUARE_10 + SQUARE_60)
})

test('filling the combined path leaves the gap between added paths empty', (t) => {
  const path = new Path2D()
  path.addPath(square(10))
  path.addPath(square(60))
  const ctx = createCanvas(100, 40).getContext('2d')
  ctx.fill(path)
  t.is(ctx.getImageData(20, 20, 1, 1).data[3], 255)
  t.is(ctx.getImageData(45, 20, 1, 1).data[3], 0)
  t.is(ctx.getImageData(70, 20, 1, 1).data[3], 255)
})
