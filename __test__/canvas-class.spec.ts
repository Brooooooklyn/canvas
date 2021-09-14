import test from 'ava'
import { omit } from 'lodash'

import { createCanvas, Canvas } from '../index'

test('Canvas constructor should be equal to createCanvas', (t) => {
  t.deepEqual(omit(createCanvas(200, 100), 'getContext'), omit(new Canvas(200, 100), 'getContext'))
})
