import ava, { TestInterface } from 'ava'

import { createCanvas, Canvas, SKRSContext2D } from '../index'
import { snapshotImage } from './image-snapshot'

const test = ava as TestInterface<{
  canvas: Canvas
  ctx: SKRSContext2D
}>

test.beforeEach((t) => {
  const canvas = createCanvas(512, 512)
  t.context.canvas = canvas
  t.context.ctx = canvas.getContext('2d')!
})

test('transform-with-state', async (t) => {
  const canvas = createCanvas(256, 256)
  const ctx = canvas.getContext('2d')
  ctx.translate(128.5, 128.5)
  ctx.scale(1, 1)
  ctx.clearRect(-128, -128, 256, 256)
  ctx.beginPath()
  ctx.moveTo(-52.5, -38.5)
  ctx.lineTo(52.5, -38.5)
  ctx.lineTo(52.5, 38.5)
  ctx.lineTo(-52.5, 38.5)
  ctx.lineTo(-52.5, -38.5)
  ctx.closePath()
  ctx.save()
  const p = ctx.createLinearGradient(0, 0, 0, 77)
  p.addColorStop(1, 'rgba(0, 128, 128, 1)')
  p.addColorStop(0.6, 'rgba(0, 255, 255, 1)')
  p.addColorStop(0.3, 'rgba(176, 199, 45, 1)')
  p.addColorStop(0.0, 'rgba(204, 82, 51, 1)')
  ctx.fillStyle = p
  ctx.transform(1, 0, 0, 1, -52.5, -38.5)
  ctx.transform(1, 0, 0, 1, 0, 0)
  ctx.fill()
  ctx.restore()
  await snapshotImage(t, { canvas, ctx })
})
