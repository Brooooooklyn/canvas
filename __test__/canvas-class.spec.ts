import test from 'ava'

import { createCanvas, Canvas } from '../index'

test('Canvas constructor should be equal to createCanvas', (t) => {
  t.true(new Canvas(100, 100) instanceof createCanvas(100, 100).constructor)
})
