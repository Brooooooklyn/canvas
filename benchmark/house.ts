import { createCanvas, Canvas } from 'canvas'
import { cyan } from 'colorette'
import { Bench } from 'tinybench'
import { Canvas as SkiaCanvas } from 'skia-canvas'

import { createCanvas as skiaCreateCanvas } from '../index'

function drawHouse(factory: (width: number, height: number) => Canvas) {
  const canvas = factory(1024, 768)

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

  if (canvas instanceof SkiaCanvas) {
    canvas.toBufferSync('png')
  } else {
    // @ts-expect-error
    canvas.async = false
    canvas.toBuffer('image/png')
  }
}

export async function house() {
  const bench = new Bench({
    name: 'house',
  })

  bench
    .add('@napi-rs/skia', () => {
      // @ts-expect-error
      drawHouse(skiaCreateCanvas)
    })
    .add('skia-canvas', () => {
      // @ts-expect-error
      drawHouse((w, h) => new SkiaCanvas(w, h))
    })
    .add('node-canvas', () => {
      drawHouse(createCanvas)
    })

  await bench.run()

  console.info(cyan('Draw a House and export to PNG'))
  console.table(bench.table())

  return bench
}
