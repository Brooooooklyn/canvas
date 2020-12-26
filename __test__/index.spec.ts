import test from 'ava'

import { createCanvas, Path2D } from '../index'

test('should be able to createCanvas', (t) => {
  t.notThrows(() => createCanvas(1920, 1080))
})

test('should be able to create Path2D', (t) => {
  t.notThrows(() => new Path2D())
  t.notThrows(
    () =>
      new Path2D(
        'M108.956,403.826c0,0,0.178,3.344-1.276,3.311  c-1.455-0.033-30.507-84.917-66.752-80.957C40.928,326.18,72.326,313.197,108.956,403.826z',
      ),
  )
  t.notThrows(() => new Path2D(new Path2D()))
})
