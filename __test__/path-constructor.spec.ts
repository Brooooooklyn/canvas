import test from 'ava'

import { Path2D } from '../index'

test('Path2D constructor should accept Path instances', (t) => {
  const original = new Path2D()
  original.rect(0, 0, 100, 100)

  const copy = new Path2D(original)

  t.is(copy.toSVGString(), 'M0 0L100 0L100 100L0 100L0 0Z')
  t.is(original.toSVGString(), copy.toSVGString())
})

test('Path2D constructor should accept string arguments', (t) => {
  const path = new Path2D('M0 0L100 0L100 100L0 100L0 0Z')

  t.is(path.toSVGString(), 'M0 0L100 0L100 100L0 100L0 0Z')
})

test('Path2D constructor should create independent copies', (t) => {
  const original = new Path2D()
  original.rect(0, 0, 100, 100)

  const copy = new Path2D(original)

  // Modify the copy
  copy.rect(200, 200, 50, 50)

  // Original should remain unchanged
  t.is(original.toSVGString(), 'M0 0L100 0L100 100L0 100L0 0Z')

  // Copy should have both rectangles
  t.is(copy.toSVGString(), 'M0 0L100 0L100 100L0 100L0 0ZM200 200L250 200L250 250L200 250L200 200Z')
})

test('Path2D constructor should handle empty path', (t) => {
  const empty = new Path2D()

  t.is(empty.toSVGString(), '')
})

test('Path2D constructor should copy complex paths', (t) => {
  const original = new Path2D()
  original.moveTo(10, 10)
  original.lineTo(20, 20)
  original.bezierCurveTo(30, 30, 40, 40, 50, 50)
  original.closePath()

  const copy = new Path2D(original)

  t.is(original.toSVGString(), copy.toSVGString())
})
