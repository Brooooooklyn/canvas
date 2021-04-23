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

test('Union boolean operation', (t) => {
  const pathOne = new Path2D(
    'M8 50H92C96.4183 50 100 53.5817 100 58V142C100 146.418 96.4183 150 92 150H8C3.58172 150 0 146.418 0 142V58C0 53.5817 3.58172 50 8 50Z',
  )
  const pathTwo = new Path2D(
    'M58 0H142C146.418 0 150 3.58172 150 8V92C150 96.4183 146.418 100 142 100H58C53.5817 100 50 96.4183 50 92V8C50 3.58172 53.5817 0 58 0Z',
  )

  t.is(
    pathOne.op(pathTwo, PathOp.Union).toSVGString(),
    'M142 0L58 0C53.5817 0 50 3.58172 50 8L50 50L8 50C3.58172 50 0 53.5817 0 58L0 142C0 146.418 3.58172 150 8 150L92 150C96.4183 150 100 146.418 100 142L100 100L142 100C146.418 100 150 96.4183 150 92L150 8C150 3.58172 146.418 0 142 0Z',
  )
})

test('Difference boolean operation', (t) => {
  const pathOne = new Path2D(
    'M8 50H92C96.4183 50 100 53.5817 100 58V142C100 146.418 96.4183 150 92 150H8C3.58172 150 0 146.418 0 142V58C0 53.5817 3.58172 50 8 50Z',
  )
  const pathTwo = new Path2D(
    'M58 0H142C146.418 0 150 3.58172 150 8V92C150 96.4183 146.418 100 142 100H58C53.5817 100 50 96.4183 50 92V8C50 3.58172 53.5817 0 58 0Z',
  )

  t.is(
    pathOne.op(pathTwo, PathOp.Difference).toSVGString(),
    'M50 50L8 50C3.58172 50 0 53.5817 0 58L0 142C0 146.418 3.58172 150 8 150L92 150C96.4183 150 100 146.418 100 142L100 100L58 100C53.5817 100 50 96.4183 50 92L50 50Z',
  )
})

test('ReverseDifference boolean operation', (t) => {
  const pathOne = new Path2D(
    'M8 50H92C96.4183 50 100 53.5817 100 58V142C100 146.418 96.4183 150 92 150H8C3.58172 150 0 146.418 0 142V58C0 53.5817 3.58172 50 8 50Z',
  )
  const pathTwo = new Path2D(
    'M58 0H142C146.418 0 150 3.58172 150 8V92C150 96.4183 146.418 100 142 100H58C53.5817 100 50 96.4183 50 92V8C50 3.58172 53.5817 0 58 0Z',
  )

  t.is(
    pathOne.op(pathTwo, PathOp.ReverseDifference).toSVGString(),
    'M142 0L58 0C53.5817 0 50 3.58172 50 8L50 50L92 50C96.4183 50 100 53.5817 100 58L100 100L142 100C146.418 100 150 96.4183 150 92L150 8C150 3.58172 146.418 0 142 0Z',
  )
})

test('Intersect boolean operation', (t) => {
  const pathOne = new Path2D(
    'M8 50H92C96.4183 50 100 53.5817 100 58V142C100 146.418 96.4183 150 92 150H8C3.58172 150 0 146.418 0 142V58C0 53.5817 3.58172 50 8 50Z',
  )
  const pathTwo = new Path2D(
    'M58 0H142C146.418 0 150 3.58172 150 8V92C150 96.4183 146.418 100 142 100H58C53.5817 100 50 96.4183 50 92V8C50 3.58172 53.5817 0 58 0Z',
  )

  t.is(
    pathOne.op(pathTwo, PathOp.Intersect).toSVGString(),
    'M100 100L58 100C53.5817 100 50 96.4183 50 92L50 50L92 50C96.4183 50 100 53.5817 100 58L100 100Z',
  )
})

test('XOR boolean operation', (t) => {
  const pathOne = new Path2D(
    'M8 50H92C96.4183 50 100 53.5817 100 58V142C100 146.418 96.4183 150 92 150H8C3.58172 150 0 146.418 0 142V58C0 53.5817 3.58172 50 8 50Z',
  )
  const pathTwo = new Path2D(
    'M58 0H142C146.418 0 150 3.58172 150 8V92C150 96.4183 146.418 100 142 100H58C53.5817 100 50 96.4183 50 92V8C50 3.58172 53.5817 0 58 0Z',
  )

  t.is(
    pathOne.op(pathTwo, PathOp.XOR).toSVGString(),
    'M142 0L58 0C53.5817 0 50 3.58172 50 8L50 50L8 50C3.58172 50 0 53.5817 0 58L0 142C0 146.418 3.58172 150 8 150L92 150C96.4183 150 100 146.418 100 142L100 100L142 100C146.418 100 150 96.4183 150 92L150 8C150 3.58172 146.418 0 142 0ZM100 100L100 58C100 53.5817 96.4183 50 92 50L50 50L50 92C50 96.4183 53.5817 100 58 100L100 100Z',
  )
})

test('FillType must be Winding after conversion by AsWinding()', (t) => {
  const path = new Path2D()
  path.rect(1, 2, 3, 4)
  path.setFillType(FillType.EvenOdd)
  t.is(path.asWinding().getFillType(), FillType.Winding)
})

test('getFillTypeString()', (t) => {
  const path = new Path2D()
  path.rect(1, 2, 3, 4)
  t.is(path.getFillTypeString(), 'nonzero')
})

test('getFillTypeString() and setFillType()', (t) => {
  const path = new Path2D()
  path.rect(1, 2, 3, 4)
  path.setFillType(FillType.EvenOdd)
  t.is(path.getFillTypeString(), 'evenodd')
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

test('Use .asWinding() and .simplify() to convert cubic Bezier curve to quadratic', (t) => {
  const path = new Path2D(
    'M0 10C0 4.47715 4.47715 0 10 0H90C95.5229 0 100 4.47715 100 10C100 15.5228 95.5229 20 90 20H10C4.47715 20 0 15.5228 0 10Z',
  )
  // Quadratic bezier curve
  const quadraticPath =
    'M0 10C0 4.47715 4.47715 0 10 0L90 0C95.5229 0 100 4.47715 100 10C100 15.5228 95.5229 20 90 20L10 20C4.47715 20 0 15.5228 0 10Z'

  t.is(path.asWinding().simplify().toSVGString(), quadraticPath)
})

test('Use .simplify() to remove overlapping paths', (t) => {
  const path = new Path2D(
    'M2.933,89.89 L89.005,3.818 Q90.412,2.411 92.249,1.65 Q94.087,0.889 96.076,0.889 Q98.065,0.889 99.903,1.65 Q101.741,2.411 103.147,3.818 L189.22,89.89 Q190.626,91.296 191.387,93.134 Q192.148,94.972 192.148,96.961 Q192.148,98.95 191.387,100.788 Q190.626,102.625 189.219,104.032 Q187.813,105.439 185.975,106.2 Q184.138,106.961 182.148,106.961 Q180.159,106.961 178.322,106.2 Q176.484,105.439 175.077,104.032 L89.005,17.96 L96.076,10.889 L103.147,17.96 L17.075,104.032 Q15.668,105.439 13.831,106.2 Q11.993,106.961 10.004,106.961 Q8.015,106.961 6.177,106.2 Q4.339,105.439 2.933,104.032 Q1.526,102.625 0.765,100.788 Q0.004,98.95 0.004,96.961 Q0.004,94.972 0.765,93.134 Q1.526,91.296 2.933,89.89 Z',
  )

  t.is(
    path.simplify().toSVGString(),
    'M89.005 3.818L2.933 89.89Q1.526 91.296 0.765 93.134Q0.004 94.972 0.004 96.961Q0.004 98.95 0.765 100.788Q1.526 102.625 2.933 104.032Q4.339 105.439 6.177 106.2Q8.015 106.961 10.004 106.961Q11.993 106.961 13.831 106.2Q15.668 105.439 17.075 104.032L96.076 25.031L175.077 104.032Q176.484 105.439 178.322 106.2Q180.159 106.961 182.148 106.961Q184.138 106.961 185.975 106.2Q187.813 105.439 189.219 104.032Q190.626 102.625 191.387 100.788Q192.148 98.95 192.148 96.961Q192.148 94.972 191.387 93.134Q190.626 91.296 189.22 89.89L103.147 3.818Q101.741 2.411 99.903 1.65Q98.065 0.889 96.076 0.889Q94.087 0.889 92.249 1.65Q90.412 2.411 89.005 3.818Z',
  )
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
  // box is now the 3 segments that look like a U. 
  // (the top segment has been removed).
  box.trim(0.25, 1)
    .stroke({ width: 10 })
    .simplify()

  const svg = `<svg width="100" height="100" viewBox="0 0 100 100"><path fill="blue" d="${box.toSVGString()}"></path></svg>`

  t.snapshot(svg)
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
