import test from 'ava'

import { FillType, Path2D, PathOp, StrokeCap, StrokeJoin } from '../index'

test('should be able to call toSVGString', (t) => {
  const path = new Path2D()
  path.rect(0, 0, 100, 100)
  t.is(path.toSVGString(), 'M0 0L100 0L100 100L0 100L0 0Z')
})

test('should be able to create mountain via op', (t) => {
  const pathOne = new Path2D()
  const pathTwo = new Path2D()
  pathOne.moveTo(0, 20)
  pathOne.lineTo(10, 10)
  pathOne.lineTo(20, 20)
  pathOne.closePath()
  pathTwo.moveTo(10, 20)
  pathTwo.lineTo(20, 10)
  pathTwo.lineTo(30, 20)
  pathTwo.closePath()
  t.is(pathOne.op(pathTwo, PathOp.Union).toSVGString(), 'M10 10L0 20L30 20L20 10L15 15L10 10Z')
})

test('FillType must be Winding after conversion by AsWinding()', (t) => {
  const path = new Path2D()
  path.rect(1, 2, 3, 4)
  path.setFillType(FillType.EvenOdd)
  t.is(path.asWinding().getFillType(), FillType.Winding)
})

test('Path FillType must be converted from nonzero to evenodd', (t) => {
  const pathCircle = new Path2D(
    'M50 87.5776C70.7536 87.5776 87.5776 70.7536 87.5776 50C87.5776 29.2464 70.7536 12.4224 50 12.4224C29.2464 12.4224 12.4224 29.2464 12.4224 50C12.4224 70.7536 29.2464 87.5776 50 87.5776ZM50 100C77.6142 100 100 77.6142 100 50C100 22.3858 77.6142 0 50 0C22.3858 0 0 22.3858 0 50C0 77.6142 22.3858 100 50 100Z',
  )
  const nonzeroPathCircle =
    'M50 87.5776C29.2464 87.5776 12.4224 70.7536 12.4224 50C12.4224 29.2464 29.2464 12.4224 50 12.4224C70.7536 12.4224 87.5776 29.2464 87.5776 50C87.5776 70.7536 70.7536 87.5776 50 87.5776ZM50 100C77.6142 100 100 77.6142 100 50C100 22.3858 77.6142 0 50 0C22.3858 0 0 22.3858 0 50C0 77.6142 22.3858 100 50 100Z'

  pathCircle.setFillType(FillType.EvenOdd) // The FillType of the original path is evenodd

  t.is(pathCircle.asWinding().toSVGString(), nonzeroPathCircle)
})

test('Use .simplify() to convert cubic Bezier curve to quadratic', (t) => {
  const path = new Path2D(
    'M0 10C0 4.47715 4.47715 0 10 0H90C95.5229 0 100 4.47715 100 10C100 15.5228 95.5229 20 90 20H10C4.47715 20 0 15.5228 0 10Z',
  )
  // Quadratic bezier curve
  const quadraticPath =
    'M0 10C0 4.47715 4.47715 0 10 0L90 0C95.5229 0 100 4.47715 100 10C100 15.5228 95.5229 20 90 20L10 20C4.47715 20 0 15.5228 0 10Z'

  t.is(path.asWinding().simplify().toSVGString(), quadraticPath)
})

test('Convert fill-type to nonzero and cubic Bezier curve to quadratic', (t) => {
  const pathTriangle = new Path2D('M70 0L0.717957 120H139.282L70 0ZM70 30L26.6987 105H113.301L70 30Z')
  // Quadratic bezier curve
  const quadraticPath = 'M0.717957 120L70 0L139.282 120L0.717957 120ZM113.301 105L70 30L26.6987 105L113.301 105Z'
  pathTriangle.setFillType(FillType.EvenOdd)

  t.is(pathTriangle.asWinding().simplify().toSVGString(), quadraticPath)
})

test('Stroke', (t) => {
  const box = new Path2D()
  box.rect(0, 0, 100, 100)
  // Shrink effect, in which we subtract away from the original
  const simplified = new Path2D(box).simplify() // sometimes required for complicated paths
  const shrink = new Path2D(box).stroke({ width: 15, cap: StrokeCap.Butt }).op(simplified, PathOp.ReverseDifference)
  t.is(shrink.toSVGString(), 'M7.5 92.5L7.5 7.5L92.5 7.5L92.5 92.5L7.5 92.5Z')
})

test('Convert stroke to path', (t) => {
  const path = new Path2D(
    'M32.9641 7L53.3157 42.25C54.8553 44.9167 52.9308 48.25 49.8516 48.25H9.14841C6.0692 48.25 4.1447 44.9167 5.6843 42.25L26.0359 7C27.5755 4.33333 31.4245 4.33333 32.9641 7Z',
  )
  path.stroke({ width: 10, miterLimit: 1 }).simplify().asWinding()

  t.is(
    path.toSVGString(),
    'M57.6458 39.75L37.2942 4.5Q34.6962 -2.38419e-06 29.5 -2.38419e-06Q24.3038 -2.90573e-06 21.7058 4.5L1.35417 39.75Q-1.2439 44.25 1.35418 48.75Q3.95226 53.25 9.14841 53.25L49.8516 53.25Q55.0478 53.25 57.6458 48.75Q60.2439 44.25 57.6458 39.75ZM29.5 11L48.1195 43.25L10.8805 43.25L29.5 11Z',
  )
})

test('Convert stroke to path 2', (t) => {
  const path = new Path2D('M4 23.5L22.5 5L41 23.5')
  path.stroke({ width: 10, join: StrokeJoin.Round, miterLimit: 1 }).simplify()

  const svg = `<svg width="45" height="28" viewBox="0 0 45 28"><path fill="pink" d="${path.toSVGString()}"></path></svg>`

  t.snapshot(svg)
})

test('computeTightBounds', (t) => {
  const p = new Path2D()
  t.deepEqual(p.computeTightBounds(), [0, 0, 0, 0])
  p.arc(50, 45, 25, 0, 2 * Math.PI)
  t.deepEqual(p.computeTightBounds(), [25, 20, 75, 70])
})

test('Transform', (t) => {
  const p = new Path2D()
  p.transform({ a: 1, b: 0.2, c: 0.8, d: 1, e: 0, f: 0 })
  p.rect(0, 0, 100, 100)
  p.transform({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  p.rect(220, 0, 100, 100)
  t.is(p.toSVGString(), 'M0 0L100 0L100 100L0 100L0 0ZM220 0L320 0L320 100L220 100L220 0Z')
})

test('trim', (t) => {
  const box = new Path2D()
  box.rect(0, 0, 100, 100)
  box.trim(0.25, 1.0)
  t.snapshot(box.toSVGString())
})

function drawSimplePath() {
  const path = new Path2D()
  path.moveTo(0, 0)
  path.lineTo(10, 0)
  path.lineTo(10, 10)
  path.closePath()
  return path
}

test('Equals', (t) => {
  const p1 = drawSimplePath()
  const p2 = drawSimplePath()
  t.not(p1, p2)
  t.true(p1.equals(p2))
  t.true(p2.equals(p1))
  const blank = new Path2D()
  t.false(p1.equals(blank))
  t.false(p2.equals(blank))
  t.false(blank.equals(p1))
  t.false(blank.equals(p2))
})
