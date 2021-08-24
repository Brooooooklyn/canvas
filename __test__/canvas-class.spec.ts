import test from 'ava'

import { createCanvas, Canvas } from '../index'

test('Canvas constructor should be equal to createCanvas', (t) => {
  t.deepEqual(createCanvas(200, 100), new Canvas(200, 100))
})
