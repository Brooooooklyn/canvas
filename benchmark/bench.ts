import { promises as fs } from 'fs'
import { join } from 'path'

import b from 'benny'
import { Summary } from 'benny/lib/internal/common-types'
import { createCanvas, Canvas } from 'canvas'

import { createCanvas as skiaCreateCanvas } from '../index'

function draw(factory: (width: number, height: number) => Canvas) {
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

  canvas.toBuffer('image/png')
}

function house() {
  return b.suite(
    'Draw house',

    b.add('@napi-rs/skia', () => {
      // @ts-expect-error
      draw(skiaCreateCanvas)
    }),

    b.add('node-canvas', () => {
      draw(createCanvas)
    }),

    b.cycle(),
    b.complete(),
  )
}

async function run() {
  const output = [await house()].map(formatSummary).join('\n')
  await fs.writeFile(join(process.cwd(), 'bench.txt'), output, 'utf8')
}

run().catch((e) => {
  console.error(e)
})

function formatSummary(summary: Summary): string {
  return summary.results
    .map(
      (result) =>
        `${summary.name}#${result.name} x ${result.ops} ops/sec ±${result.margin}% (${result.samples} runs sampled)`,
    )
    .join('\n')
}
