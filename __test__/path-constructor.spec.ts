import test from 'ava'

import { Path2D } from '../index'

test('Path2D constructor should accept another Path2D instance', (t) => {
  const originalPath = new Path2D()
  originalPath.rect(0, 0, 100, 100)
  
  // This should work - passing a Path2D instance to the constructor
  const copiedPath = new Path2D(originalPath)
  
  t.is(copiedPath.toSVGString(), originalPath.toSVGString())
  t.is(copiedPath.toSVGString(), 'M0 0L100 0L100 100L0 100L0 0Z')
})

test('Path2D constructor should accept a string', (t) => {
  const svgString = 'M0 0L100 0L100 100L0 100L0 0Z'
  const path = new Path2D(svgString)
  
  t.is(path.toSVGString(), svgString)
})

test('Path2D constructor should work without arguments', (t) => {
  const path = new Path2D()
  path.rect(0, 0, 50, 50)
  
  t.is(path.toSVGString(), 'M0 0L50 0L50 50L0 50L0 0Z')
})

test('Path2D constructor with Path instance should create independent copy', (t) => {
  const path1 = new Path2D()
  path1.rect(0, 0, 100, 100)
  
  const path2 = new Path2D(path1)
  
  // Modify path2
  path2.rect(200, 200, 50, 50)
  
  // path1 should be unchanged
  t.is(path1.toSVGString(), 'M0 0L100 0L100 100L0 100L0 0Z')
  t.is(path2.toSVGString(), 'M0 0L100 0L100 100L0 100L0 0ZM200 200L250 200L250 250L200 250L200 200Z')
})
