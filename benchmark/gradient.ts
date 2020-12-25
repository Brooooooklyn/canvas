import b from 'benny'

import { createCanvas, Canvas } from 'canvas'

import { createCanvas as skiaCreateCanvas } from '../index'

function drawGradient(factory: (width: number, height: number) => Canvas) {
  const canvas = factory(1024, 768)

  const ctx = canvas.getContext('2d')!

  const gradient = ctx.createLinearGradient(20, 0, 220, 0)

  // Add three color stops
  gradient.addColorStop(0, 'green')
  gradient.addColorStop(0.5, 'cyan')
  gradient.addColorStop(1, 'green')

  // Set the fill style and draw a rectangle
  ctx.fillStyle = gradient
  ctx.fillRect(20, 20, 200, 100)

  canvas.toBuffer('image/png')
}

export function gradient() {
  return b.suite(
    'Draw gradient',

    b.add('@napi-rs/skia', () => {
      // @ts-expect-error
      drawGradient(skiaCreateCanvas)
    }),

    b.add('node-canvas', () => {
      drawGradient(createCanvas)
    }),

    b.cycle(),
    b.complete(),
  )
}
