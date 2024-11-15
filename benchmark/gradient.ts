import { createCanvas, Canvas } from 'canvas'
import { cyan } from 'colorette'
import { Bench } from 'tinybench'
import { Canvas as SkiaCanvas } from 'skia-canvas'

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

  if (canvas instanceof SkiaCanvas) {
    canvas.toBufferSync('png')
  } else {
    // @ts-expect-error
    canvas.async = false
    canvas.toBuffer('image/png')
  }
}

export async function gradient() {
  const bench = new Bench({
    name: 'gradient',
  })

  bench
    .add('@napi-rs/skia', () => {
      // @ts-expect-error
      drawGradient(skiaCreateCanvas)
    })
    .add('skia-canvas', () => {
      // @ts-expect-error
      drawGradient((w, h) => new SkiaCanvas(w, h))
    })
    .add('node-canvas', () => {
      drawGradient(createCanvas)
    })

  await bench.run()
  console.info(cyan('Draw Gradient and export to PNG'))
  console.table(bench.table())

  return bench
}
