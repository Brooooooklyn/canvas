import test from 'ava'

import { createCanvas, Canvas } from '../index'

test('Canvas constructor should be equal to createCanvas', (t) => {
  t.true(new Canvas(100, 100) instanceof createCanvas(100, 100).constructor)
})

test('ctx.canvas should be equal to canvas', (t) => {
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')
  t.is(ctx.canvas, canvas)
})
