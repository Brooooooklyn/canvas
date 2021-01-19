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

test('createImageData', async (t) => {
  const { ctx } = t.context
  const imageData = ctx.createImageData(256, 256)

  // Iterate through every pixel
  for (let i = 0; i < imageData.data.length; i += 4) {
    // Modify pixel data
    imageData.data[i + 0] = 190 // R value
    imageData.data[i + 1] = 0 // G value
    imageData.data[i + 2] = 210 // B value
    imageData.data[i + 3] = 255 // A value
  }

  // Draw image data to the canvas
  ctx.putImageData(imageData, 20, 20)
  await snapshotImage(t)
})

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

test.todo('fillText')

test.todo('getContextAttributes')

test('getImageData', async (t) => {
  const { ctx } = t.context
  ctx.rect(10, 10, 100, 100)
  ctx.fill()
  const imageData = ctx.getImageData(60, 60, 200, 100)
  ctx.putImageData(imageData, 150, 10)
  await snapshotImage(t)
})

test.todo('isPointInPath')

test('isPointInStroke', (t) => {
  const { ctx } = t.context
  ctx.rect(10, 10, 100, 100)
  ctx.stroke()
  t.is(ctx.isPointInStroke(50, 9), false) // Outside the rect
  t.is(ctx.isPointInStroke(50, 10), true) // On the edge of the rect
  t.is(ctx.isPointInStroke(50, 11), false) // Inside the rect

  ctx.lineWidth = 3
  ctx.stroke()
  // All points on the edge now
  t.is(ctx.isPointInStroke(50, 9), true)
  t.is(ctx.isPointInStroke(50, 10), true)
  t.is(ctx.isPointInStroke(50, 11), true)

  ctx.lineWidth = 1
  const path = new Path2D()
  path.rect(10, 10, 100, 100)
  t.is(ctx.isPointInStroke(path, 50, 9), false)
  t.is(ctx.isPointInStroke(path, 50, 10), true)
  t.is(ctx.isPointInStroke(path, 50, 11), false)
})

test('lineTo', async (t) => {
  const { ctx } = t.context
  ctx.beginPath() // Start a new path
  ctx.moveTo(30, 50) // Move the pen to (30, 50)
  ctx.lineTo(150, 100) // Draw a line to (150, 100)
  ctx.stroke() // Render the path
  await snapshotImage(t)
})

test.todo('measureText')

test('moveTo', async (t) => {
  const { ctx } = t.context
  ctx.beginPath()
  ctx.moveTo(50, 50) // Begin first sub-path
  ctx.lineTo(200, 50)
  ctx.moveTo(50, 90) // Begin second sub-path
  ctx.lineTo(280, 120)
  ctx.stroke()
  await snapshotImage(t)
})

test('putImageData', async (t) => {
  const { ctx } = t.context
  function putImageData(
    imageData: ImageData,
    dx: number,
    dy: number,
    dirtyX: number,
    dirtyY: number,
    dirtyWidth: number,
    dirtyHeight: number,
  ) {
    const data = imageData.data
    const height = imageData.height
    const width = imageData.width
    dirtyX = dirtyX || 0
    dirtyY = dirtyY || 0
    dirtyWidth = dirtyWidth !== undefined ? dirtyWidth : width
    dirtyHeight = dirtyHeight !== undefined ? dirtyHeight : height
    const limitBottom = dirtyY + dirtyHeight
    const limitRight = dirtyX + dirtyWidth
    for (let y = dirtyY; y < limitBottom; y++) {
      for (let x = dirtyX; x < limitRight; x++) {
        const pos = y * width + x
        ctx.fillStyle =
          'rgba(' +
          data[pos * 4 + 0] +
          ',' +
          data[pos * 4 + 1] +
          ',' +
          data[pos * 4 + 2] +
          ',' +
          data[pos * 4 + 3] / 255 +
          ')'
        ctx.fillRect(x + dx, y + dy, 1, 1)
      }
    }
  }

  // Draw content onto the canvas
  ctx.fillRect(0, 0, 100, 100)
  // Create an ImageData object from it
  const imagedata = ctx.getImageData(0, 0, 100, 100)
  // use the putImageData function that illustrates how putImageData works
  putImageData(imagedata, 150, 0, 50, 50, 25, 25)

  await snapshotImage(t)
})

test('quadraticCurveTo', async (t) => {
  const { ctx } = t.context
  // Quadratic Bézier curve
  ctx.beginPath()
  ctx.moveTo(50, 20)
  ctx.quadraticCurveTo(230, 30, 50, 100)
  ctx.stroke()

  // Start and end points
  ctx.fillStyle = 'blue'
  ctx.beginPath()
  ctx.arc(50, 20, 5, 0, 2 * Math.PI) // Start point
  ctx.arc(50, 100, 5, 0, 2 * Math.PI) // End point
  ctx.fill()

  // Control point
  ctx.fillStyle = 'red'
  ctx.beginPath()
  ctx.arc(230, 30, 5, 0, 2 * Math.PI)
  ctx.fill()
  await snapshotImage(t)
})

test('rect', async (t) => {
  const { ctx } = t.context
  ctx.fillStyle = 'yellow'
  ctx.rect(10, 20, 150, 100)
  ctx.fill()
  await snapshotImage(t)
})

test('resetTransform', async (t) => {
  const { ctx } = t.context
  // Skewed rects
  ctx.transform(1, 0, 1.7, 1, 0, 0)
  ctx.fillStyle = 'gray'
  ctx.fillRect(40, 40, 50, 20)
  ctx.fillRect(40, 90, 50, 20)

  // Non-skewed rects
  ctx.resetTransform()
  ctx.fillStyle = 'red'
  ctx.fillRect(40, 40, 50, 20)
  ctx.fillRect(40, 90, 50, 20)
  await snapshotImage(t)
})

test('save-restore', async (t) => {
  const { ctx } = t.context
  // Save the default state
  ctx.save()

  ctx.fillStyle = 'green'
  ctx.fillRect(10, 10, 100, 100)

  // Restore the default state
  ctx.restore()

  ctx.fillRect(150, 40, 100, 100)

  await snapshotImage(t)
})

test('rotate', async (t) => {
  const { ctx } = t.context
  // Point of transform origin
  ctx.arc(0, 0, 5, 0, 2 * Math.PI)
  ctx.fillStyle = 'blue'
  ctx.fill()

  // Non-rotated rectangle
  ctx.fillStyle = 'gray'
  ctx.fillRect(100, 0, 80, 20)

  // Rotated rectangle
  ctx.rotate((45 * Math.PI) / 180)
  ctx.fillStyle = 'red'
  ctx.fillRect(100, 0, 80, 20)
  // Reset transformation matrix to the identity matrix
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  ctx.fillStyle = 'hotpink'
  ctx.fillRect(100, 50, 80, 20)
  await snapshotImage(t)
})

test('scale', async (t) => {
  const { ctx } = t.context
  // Scaled rectangle
  ctx.scale(9, 3)
  ctx.fillStyle = 'red'
  ctx.fillRect(10, 10, 8, 20)

  // Reset current transformation matrix to the identity matrix
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  // Non-scaled rectangle
  ctx.fillStyle = 'gray'
  ctx.fillRect(10, 10, 8, 20)
  await snapshotImage(t)
})

test('setLineDash', async (t) => {
  const { ctx } = t.context
  // Dashed line
  ctx.beginPath()
  ctx.setLineDash([5, 15])
  ctx.moveTo(0, 50)
  ctx.lineTo(300, 50)
  ctx.stroke()

  // Solid line
  ctx.beginPath()
  ctx.setLineDash([])
  ctx.moveTo(0, 100)
  ctx.lineTo(300, 100)
  ctx.stroke()
  await snapshotImage(t)
})

test('setTransform', async (t) => {
  const { ctx } = t.context
  ctx.setTransform(1, 0.2, 0.8, 1, 0, 0)
  ctx.fillRect(0, 0, 100, 100)
  await snapshotImage(t)
})

test('stroke', async (t) => {
  const { ctx } = t.context
  // First sub-path
  ctx.lineWidth = 26
  ctx.strokeStyle = 'orange'
  ctx.moveTo(20, 20)
  ctx.lineTo(160, 20)
  ctx.stroke()

  // Second sub-path
  ctx.lineWidth = 14
  ctx.strokeStyle = 'green'
  ctx.moveTo(20, 80)
  ctx.lineTo(220, 80)
  ctx.stroke()

  // Third sub-path
  ctx.lineWidth = 4
  ctx.strokeStyle = 'pink'
  ctx.moveTo(20, 140)
  ctx.lineTo(280, 140)
  ctx.stroke()
  await snapshotImage(t)
})

test('stroke-and-filling', async (t) => {
  const { ctx } = t.context
  ctx.lineWidth = 16
  ctx.strokeStyle = 'red'

  // Stroke on top of fill
  ctx.beginPath()
  ctx.rect(25, 25, 100, 100)
  ctx.fill()
  ctx.stroke()

  // Fill on top of stroke
  ctx.beginPath()
  ctx.rect(175, 25, 100, 100)
  ctx.stroke()
  ctx.fill()
  await snapshotImage(t)
})

test('strokeRect', async (t) => {
  const { ctx } = t.context
  ctx.shadowColor = '#d53'
  ctx.shadowBlur = 20
  ctx.lineJoin = 'bevel'
  ctx.lineWidth = 15
  ctx.strokeStyle = '#38f'
  ctx.strokeRect(30, 30, 160, 90)
  await snapshotImage(t)
})

test.todo('strokeText')

test('transform', async (t) => {
  const { ctx } = t.context
  ctx.transform(1, 0.2, 0.8, 1, 0, 0)
  ctx.fillRect(0, 0, 100, 100)
  ctx.resetTransform()
  ctx.fillRect(220, 0, 100, 100)
  await snapshotImage(t)
})

test('translate', async (t) => {
  const { ctx } = t.context
  // Moved square
  ctx.translate(110, 30)
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 80, 80)

  // Reset current transformation matrix to the identity matrix
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  // Unmoved square
  ctx.fillStyle = 'gray'
  ctx.fillRect(0, 0, 80, 80)
  await snapshotImage(t)
})
