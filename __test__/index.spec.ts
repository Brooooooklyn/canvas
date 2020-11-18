import test from 'ava'

import { createCanvas } from '../index'

test('should be able to createCanvas', (t) => {
  t.notThrows(() => createCanvas(1920, 1080))
})
