import ava, { TestInterface } from 'ava'

import { createCanvas, Canvas, Path2D } from '../index'
import { snapshotImage } from './image-snapshot'

const test = ava as TestInterface<{
  canvas: Canvas
  ctx: CanvasRenderingContext2D
}>

test.beforeEach((t) => {
  const canvas = createCanvas(512, 512)
  t.context.canvas = canvas
  t.context.ctx = canvas.getContext('2d')!
})

test('arc', async (t) => {
  const { ctx } = t.context
  ctx.beginPath()
  ctx.arc(100, 75, 50, 0, 2 * Math.PI)
  ctx.stroke()
  await snapshotImage(t)
})

test('arcTo', async (t) => {
  const { ctx } = t.context
  ctx.beginPath()
  ctx.moveTo(180, 90)
  ctx.arcTo(180, 130, 110, 130, 130)
  ctx.lineTo(110, 130)
  ctx.stroke()
  await snapshotImage(t)
})

test('arcTo-colorful', async (t) => {
  const { ctx } = t.context
  ctx.beginPath()
  ctx.strokeStyle = 'gray'
  ctx.moveTo(200, 20)
  ctx.lineTo(200, 130)
  ctx.lineTo(50, 20)
  ctx.stroke()

  // Arc
  ctx.beginPath()
  ctx.strokeStyle = 'black'
  ctx.lineWidth = 5
  ctx.moveTo(200, 20)
  ctx.arcTo(200, 130, 50, 20, 40)
  ctx.stroke()

  // Start point
  ctx.beginPath()
  ctx.fillStyle = 'blue'
  ctx.arc(200, 20, 5, 0, 2 * Math.PI)
  ctx.fill()

  // Control points
  ctx.beginPath()
  ctx.fillStyle = 'red'
  ctx.arc(200, 130, 5, 0, 2 * Math.PI) // Control point one
  ctx.arc(50, 20, 5, 0, 2 * Math.PI) // Control point two
  ctx.fill()
  await snapshotImage(t)
})

test('beginPath', async (t) => {
  const { ctx } = t.context
  ctx.beginPath()
  ctx.strokeStyle = 'blue'
  ctx.moveTo(20, 20)
  ctx.lineTo(200, 20)
  ctx.stroke()

  // Second path
  ctx.beginPath()
  ctx.strokeStyle = 'green'
  ctx.moveTo(20, 20)
  ctx.lineTo(120, 120)
  ctx.stroke()
  await snapshotImage(t)
})

test('bezierCurveTo', async (t) => {
  const { ctx } = t.context
  ctx.beginPath()
  ctx.moveTo(30, 30)
  ctx.bezierCurveTo(120, 160, 180, 10, 220, 140)
  ctx.stroke()
  await snapshotImage(t)
})

test('bezierCurveTo-colorful', async (t) => {
  const { ctx } = t.context
  const start = { x: 50, y: 20 }
  const cp1 = { x: 230, y: 30 }
  const cp2 = { x: 150, y: 80 }
  const end = { x: 250, y: 100 }

  // Cubic Bézier curve
  ctx.beginPath()
  ctx.moveTo(start.x, start.y)
  ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y)
  ctx.stroke()

  // Start and end points
  ctx.fillStyle = 'blue'
  ctx.beginPath()
  ctx.arc(start.x, start.y, 5, 0, 2 * Math.PI) // Start point
  ctx.arc(end.x, end.y, 5, 0, 2 * Math.PI) // End point
  ctx.fill()

  // Control points
  ctx.fillStyle = 'red'
  ctx.beginPath()
  ctx.arc(cp1.x, cp1.y, 5, 0, 2 * Math.PI) // Control point one
  ctx.arc(cp2.x, cp2.y, 5, 0, 2 * Math.PI) // Control point two
  ctx.fill()
  await snapshotImage(t)
})

test('clearRect', async (t) => {
  const { ctx, canvas } = t.context
  ctx.beginPath()
  ctx.fillStyle = '#ff6'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Draw blue triangle
  ctx.beginPath()
  ctx.fillStyle = 'blue'
  ctx.moveTo(20, 20)
  ctx.lineTo(180, 20)
  ctx.lineTo(130, 130)
  ctx.closePath()
  ctx.fill()

  // Clear part of the canvas
  ctx.clearRect(10, 10, 120, 100)
  await snapshotImage(t)
})

test('clip', async (t) => {
  const { ctx, canvas } = t.context
  // Create circular clipping region
  ctx.beginPath()
  ctx.arc(100, 75, 50, 0, Math.PI * 2)
  ctx.clip()

  // Draw stuff that gets clipped
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'orange'
  ctx.fillRect(0, 0, 100, 100)
  await snapshotImage(t)
})

test('closePath', async (t) => {
  const { ctx } = t.context
  ctx.beginPath()
  ctx.moveTo(20, 140) // Move pen to bottom-left corner
  ctx.lineTo(120, 10) // Line to top corner
  ctx.lineTo(220, 140) // Line to bottom-right corner
  ctx.closePath() // Line to bottom-left corner
  ctx.stroke()
  await snapshotImage(t)
})

test('closePath-arc', async (t) => {
  const { ctx } = t.context
  ctx.beginPath()
  ctx.arc(240, 20, 40, 0, Math.PI)
  ctx.moveTo(100, 20)
  ctx.arc(60, 20, 40, 0, Math.PI)
  ctx.moveTo(215, 80)
  ctx.arc(150, 80, 65, 0, Math.PI)
  ctx.closePath()
  ctx.lineWidth = 6
  ctx.stroke()

  await snapshotImage(t)
})

test.todo('createImageData')

test('createLinearGradient', async (t) => {
  const { ctx } = t.context
  const gradient = ctx.createLinearGradient(20, 0, 220, 0)

  // Add three color stops
  gradient.addColorStop(0, 'green')
  gradient.addColorStop(0.5, 'cyan')
  gradient.addColorStop(1, 'green')

  // Set the fill style and draw a rectangle
  ctx.fillStyle = gradient
  ctx.fillRect(20, 20, 200, 100)
  await snapshotImage(t)
})

test.todo('createPattern')

test('createRadialGradient', async (t) => {
  const { ctx } = t.context
  const gradient = ctx.createRadialGradient(110, 90, 30, 100, 100, 70)

  // Add three color stops
  gradient.addColorStop(0, 'pink')
  gradient.addColorStop(0.9, 'white')
  gradient.addColorStop(1, 'green')

  // Set the fill style and draw a rectangle
  ctx.fillStyle = gradient
  ctx.fillRect(20, 20, 160, 160)
  await snapshotImage(t)
})

test.todo('drawImage')

test('ellipse', async (t) => {
  const { ctx } = t.context
  // Draw the ellipse
  ctx.beginPath()
  ctx.ellipse(100, 100, 50, 75, Math.PI / 4, 0, 2 * Math.PI)
  ctx.stroke()

  // Draw the ellipse's line of reflection
  ctx.beginPath()
  ctx.setLineDash([5, 5])
  ctx.moveTo(0, 200)
  ctx.lineTo(200, 0)
  ctx.stroke()
  await snapshotImage(t)
})

test('fill', async (t) => {
  const { ctx } = t.context
  const region = new Path2D()
  region.moveTo(30, 90)
  region.lineTo(110, 20)
  region.lineTo(240, 130)
  region.lineTo(60, 130)
  region.lineTo(190, 20)
  region.lineTo(270, 90)
  region.closePath()

  // Fill path
  ctx.fillStyle = 'green'
  ctx.fill(region, 'evenodd')
  await snapshotImage(t)
})

test('fillRect', async (t) => {
  const { ctx } = t.context
  ctx.fillStyle = 'hotpink'
  ctx.fillRect(20, 10, 150, 100)
  await snapshotImage(t)
})
