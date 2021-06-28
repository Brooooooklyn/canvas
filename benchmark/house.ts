import b from 'benny'

import { createCanvas, Canvas } from 'canvas'
// @ts-expect-error
import { Canvas as SkiaCanvas } from 'skia-canvas'

import { createCanvas as skiaCreateCanvas } from '../index'

function drawHouse(factory: (width: number, height: number) => Canvas) {
  const canvas = factory(1024, 768)

  // @ts-expect-error
  canvas.async = false

  const ctx = canvas.getContext('2d')!

  ctx.lineWidth = 10
  ctx.strokeStyle = '#03a9f4'
  ctx.fillStyle = '#03a9f4'

  // Wall
  ctx.strokeRect(75, 140, 150, 110)

  // Door
  ctx.fillRect(130, 190, 40, 60)

  // Roof
  ctx.beginPath()
  ctx.moveTo(50, 140)
  ctx.lineTo(150, 60)
  ctx.lineTo(250, 140)
  ctx.closePath()
  ctx.stroke()

  canvas.toBuffer('image/png')
}

export function house() {
  return b.suite(
    'Draw house',

    b.add('skia-canvas', () => {
      drawHouse((w, h) => new SkiaCanvas(w, h))
    }),

    b.add('node-canvas', () => {
      drawHouse(createCanvas)
    }),

    b.add('@napi-rs/skia', () => {
      // @ts-expect-error
      drawHouse(skiaCreateCanvas)
    }),

    b.cycle(),
    b.complete(),
  )
}
