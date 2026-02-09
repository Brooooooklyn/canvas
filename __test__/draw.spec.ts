import { promises } from 'node:fs'
import { platform } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import ava, { TestFn } from 'ava'
import PNG from '@jimp/png'

import { GlobalFonts, createCanvas, Canvas, Image, ImageData, Path2D, SKRSContext2D, DOMMatrix } from '../index'
import { snapshotImage } from './image-snapshot'

const __dirname = dirname(fileURLToPath(import.meta.url))

const test = ava as TestFn<{
  canvas: Canvas
  ctx: SKRSContext2D
}>

const png = PNG()

test.beforeEach((t) => {
  const canvas = createCanvas(512, 512)
  t.context.canvas = canvas
  t.context.ctx = canvas.getContext('2d')!
  const fontOSRSPath = join(__dirname, 'fonts', 'osrs-font-compact.otf')
  t.truthy(
    GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf')),
    'Register Iosevka font failed',
  )
  t.truthy(
    GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')),
    'Register SourceSerifPro font failed',
  )
  t.truthy(GlobalFonts.registerFromPath(fontOSRSPath))
})

test('alpha-false', async (t) => {
  const canvas = createCanvas(512, 512)
  const ctx = canvas.getContext('2d', { alpha: false })
  await snapshotImage(t, { canvas, ctx })
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

test('clearRect-full-canvas-optimization', async (t) => {
  const { ctx, canvas } = t.context

  // Draw multiple shapes to accumulate layers
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 200, 200)
  ctx.fillStyle = 'green'
  ctx.fillRect(200, 0, 200, 200)
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 200, 200, 200)

  // Full canvas clear with identity transform - should reset layers
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // Draw new content
  ctx.fillStyle = 'purple'
  ctx.fillRect(150, 150, 200, 200)

  await snapshotImage(t)
})

test('clearRect-with-transform-preserves-outside', async (t) => {
  const { ctx, canvas } = t.context

  // Draw background
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Apply transform - clear won't cover everything
  ctx.translate(100, 100)

  // Clear "full canvas" but transform means it doesn't cover everything
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // The red area at top-left (0,0 to 100,100) should still be visible
  await snapshotImage(t)
})

test('clearRect-with-clip-preserves-outside', async (t) => {
  const { ctx, canvas } = t.context

  // Draw background
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Apply clip to center region
  ctx.beginPath()
  ctx.rect(100, 100, 300, 300)
  ctx.clip()

  // Clear "full canvas" but clip limits it
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // The red border around the clip should still be visible
  await snapshotImage(t)
})

test('clearRect-with-pending-save-preserves-state', async (t) => {
  const { ctx, canvas } = t.context
  // Test that clearRect with pending save states doesn't use the optimization
  // This ensures the save/restore stack remains consistent

  // Draw background
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Save state and set up clip
  ctx.save()
  ctx.beginPath()
  ctx.rect(100, 100, 300, 300)
  ctx.clip()

  // Draw inside clip
  ctx.fillStyle = 'green'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Full canvas clear while inside save - should NOT reset layers (has pending save)
  // The clear should only affect the clipped area
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // Draw new content inside clip
  ctx.fillStyle = 'blue'
  ctx.fillRect(150, 150, 200, 200)

  // Restore state - should work correctly
  ctx.restore()

  // Draw outside clip area to verify restore worked
  ctx.fillStyle = 'yellow'
  ctx.fillRect(0, 0, 50, 50)

  // Expected: red border (not cleared due to clip), blue square (inside clip),
  // yellow square at top-left (after restore)
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

test('clip-cumulative', async (t) => {
  const { ctx, canvas } = t.context
  // Per Canvas2D spec, multiple clip() calls should intersect with each other
  // First clip: left half of the canvas (0 to 256)
  ctx.beginPath()
  ctx.rect(0, 0, 256, 512)
  ctx.clip()

  // Second clip: right half of the canvas (128 to 512)
  // The intersection should be the middle strip (128 to 256)
  ctx.beginPath()
  ctx.rect(128, 0, 384, 512)
  ctx.clip()

  // Fill the entire canvas - only the intersection area (128-256) should be visible
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await snapshotImage(t)
})

test('clip-cumulative-with-layer-promotion', async (t) => {
  const { ctx, canvas } = t.context
  // This test verifies that cumulative clip state is correctly preserved
  // across layer promotions (triggered by getImageData).
  // Regression test for: clip state divergence when op() intersection is tracked

  ctx.fillStyle = 'lightgray'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.save()

  // First clip: left portion (0 to 300)
  ctx.beginPath()
  ctx.rect(0, 0, 300, 512)
  ctx.clip()

  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Trigger layer promotion
  ctx.getImageData(0, 0, 1, 1)

  // Second clip: overlapping region (150 to 450)
  // The cumulative clip should be (150 to 300)
  ctx.beginPath()
  ctx.rect(150, 0, 300, 512)
  ctx.clip()

  // Trigger another layer promotion - clip state must be preserved correctly
  ctx.getImageData(0, 0, 1, 1)

  // Fill with blue - should only appear in the intersection (150 to 300)
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.restore()

  // After restore, clip should be removed
  // Draw green rectangle outside the previous clip area to verify
  ctx.fillStyle = 'green'
  ctx.fillRect(350, 100, 100, 100)

  await snapshotImage(t)
})

test('clip-state-consistency-multiple-promotions', async (t) => {
  const { ctx, canvas } = t.context
  // Regression test for: clip state divergence when path intersection operation fails
  // This test verifies that clip state remains consistent across multiple layer
  // promotions, even when clips are applied between promotions.

  ctx.fillStyle = 'lightgray'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.save()

  // First clip: left region (0-250)
  ctx.beginPath()
  ctx.rect(0, 0, 250, 512)
  ctx.clip()

  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Trigger layer promotion
  ctx.getImageData(0, 0, 1, 1)

  // Second clip: overlapping region (100-350)
  // Cumulative clip should be (100-250)
  ctx.beginPath()
  ctx.rect(100, 0, 250, 512)
  ctx.clip()

  ctx.fillStyle = 'orange'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Trigger layer promotion again
  ctx.getImageData(0, 0, 1, 1)

  // Third clip: further narrowing (150-400)
  // Cumulative clip should be (150-250)
  ctx.beginPath()
  ctx.rect(150, 0, 250, 512)
  ctx.clip()

  // Trigger layer promotion a third time
  ctx.getImageData(0, 0, 1, 1)

  // Final fill - should only appear in (150-250) if state is consistent
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.restore()

  // After restore, no clip - draw marker to verify restore worked
  ctx.fillStyle = 'green'
  ctx.fillRect(400, 100, 100, 100)

  // Expected visual:
  // - Gray background
  // - Red strip at 0-100 (first clip only, before second clip)
  // - Orange strip at 100-150 (first + second clip, before third clip)
  // - Blue strip at 150-250 (all three clips)
  // - Green square at 400-500 (after restore)
  await snapshotImage(t)
})

test('clip-no-divergence-after-promotion', async (t) => {
  const { ctx, canvas } = t.context
  // This test verifies that clip state does NOT diverge between the tracked state
  // and the actual canvas clip after layer promotion.
  // The bug was: canvas had OLD∩NEW but tracked state had OLD after promotion.

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Apply first clip
  ctx.beginPath()
  ctx.rect(50, 50, 200, 200)
  ctx.clip()

  // Draw red - should be clipped to 50-250
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Layer promotion
  ctx.getImageData(0, 0, 1, 1)

  // Apply second clip - intersection should be 100-250 horizontally
  ctx.beginPath()
  ctx.rect(100, 50, 200, 200)
  ctx.clip()

  // Layer promotion
  ctx.getImageData(0, 0, 1, 1)

  // Draw blue - if state diverged, this would show in wrong region
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Layer promotion again - this is where divergence would cause problems
  ctx.getImageData(0, 0, 1, 1)

  // Draw green - should STILL be clipped to intersection (100-250)
  // If there was divergence, this might show in wrong region
  ctx.fillStyle = 'green'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // The final result should show:
  // - White background
  // - Red region at x=50-100 (first clip only, before second)
  // - Green region at x=100-250 (intersection of both clips)
  await snapshotImage(t)
})

// Regression test for https://github.com/Brooooooklyn/canvas/issues/1198
// Nested clips at different transforms should intersect in device space, not raw path coordinates
test('clip-nested-different-transforms', async (t) => {
  const canvas = createCanvas(200, 200)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 200, 200)

  // Clip 1 at 2x scale: rect(0,0,80,80) → device space 0,0 to 160,160
  ctx.setTransform(2, 0, 0, 2, 0, 0)
  const clip1 = new Path2D()
  clip1.rect(0, 0, 80, 80)
  ctx.clip(clip1)

  // Clip 2 at identity: rect(0,0,160,160) → device space 0,0 to 160,160
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const clip2 = new Path2D()
  clip2.rect(0, 0, 160, 160)
  ctx.clip(clip2)

  // Fill the intersection — should be 160x160 (both clips map to same device-space region)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = 'green'
  ctx.fillRect(0, 0, 200, 200)

  // Expected: 160x160 green area (both clips cover 0,0 to 160,160 in device space)
  // Bug: only 80x80 green area (intersection computed in raw coords without transforms)
  await snapshotImage(t, { canvas, ctx })
})

// Regression test for https://github.com/Brooooooklyn/canvas/issues/1198
// Y-flip transform with nested clip (PDF.js use case)
test('clip-nested-y-flip-transform', async (t) => {
  const canvas = createCanvas(200, 200)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 200, 200)

  // Y-flip transform: maps (0,0)-(200,200) in path coords to full canvas
  ctx.setTransform(1, 0, 0, -1, 0, 200)

  // First clip covering full canvas in flipped coords
  const clip1 = new Path2D()
  clip1.rect(0, 0, 200, 200)
  ctx.clip(clip1)

  // Second clip at different scale
  ctx.setTransform(2, 0, 0, 2, 0, 0)
  const clip2 = new Path2D()
  clip2.rect(0, 0, 50, 50)
  ctx.clip(clip2)

  // Reset transform and fill
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 200, 200)

  // Expected: 100x100 blue area (clip2 at 2x scale maps to 0,0-100,100 in device space,
  //           intersected with clip1 which covers full canvas)
  await snapshotImage(t, { canvas, ctx })
})

// Regression test for https://github.com/Brooooooklyn/canvas/issues/1198
// Current path clip (beginPath/rect/clip) also affected, not just Path2D
test('clip-nested-different-transforms-current-path', async (t) => {
  const canvas = createCanvas(200, 200)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 200, 200)

  // Clip 1 at 2x scale: rect(0,0,80,80) → device space 0,0 to 160,160
  ctx.setTransform(2, 0, 0, 2, 0, 0)
  ctx.beginPath()
  ctx.rect(0, 0, 80, 80)
  ctx.clip()

  // Clip 2 at identity: rect(0,0,160,160) → device space 0,0 to 160,160
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.beginPath()
  ctx.rect(0, 0, 160, 160)
  ctx.clip()

  // Fill the intersection — should be 160x160
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 200, 200)

  // Expected: 160x160 red area
  // Bug: only 80x80 red area
  await snapshotImage(t, { canvas, ctx })
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

test('createPattern-no-transform', async (t) => {
  const { ctx } = t.context
  const imageSrc = await promises.readFile(join(__dirname, 'canvas_createpattern.png'))
  const image = new Image()
  image.src = imageSrc
  await image.decode()
  const pattern = ctx.createPattern(image, 'repeat')
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, 300, 300)
  await snapshotImage(t)
})

test('createPattern-no-transform-imagedata', async (t) => {
  const { ctx } = t.context
  const imageSrc = await promises.readFile(join(__dirname, 'canvas_createpattern.png'))
  const imageMeta = png.decoders['image/png'](imageSrc)
  const imageData = new ImageData(new Uint8ClampedArray(imageMeta.data), imageMeta.width, imageMeta.height)
  const pattern = ctx.createPattern(imageData, 'repeat')
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, 300, 300)
  await snapshotImage(t)
})

test('createPattern-with-transform', async (t) => {
  const { ctx } = t.context
  const imageSrc = await promises.readFile(join(__dirname, 'canvas_createpattern.png'))
  const image = new Image()
  image.src = imageSrc
  await image.decode()
  const pattern = ctx.createPattern(image, 'repeat')
  const matrix = new DOMMatrix()
  pattern.setTransform(matrix.rotate(-45).scale(1.5))
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, 300, 300)
  await snapshotImage(t)
})

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

test('createConicGradient', async (t) => {
  const { ctx } = t.context
  const gradient = ctx.createConicGradient(0, 100, 100)

  // Add five color stops
  gradient.addColorStop(0, 'red')
  gradient.addColorStop(0.25, 'orange')
  gradient.addColorStop(0.5, 'yellow')
  gradient.addColorStop(0.75, 'green')
  gradient.addColorStop(1, 'blue')

  // Set the fill style and draw a rectangle
  ctx.fillStyle = gradient
  ctx.fillRect(20, 20, 200, 200)
  await snapshotImage(t)
})

test('drawImage', async (t) => {
  const { ctx } = t.context
  const filePath = './javascript.png'
  const file = await promises.readFile(join(__dirname, filePath))
  const image = new Image()
  image.src = file
  await image.decode()
  ctx.drawImage(image, 0, 0)
  await snapshotImage(t)
})

test('drawImage-svg', async (t) => {
  const { ctx } = t.context
  const filePath = './mountain.svg'
  const file = await promises.readFile(join(__dirname, filePath))
  const image = new Image()
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => {
    resolve()
  }
  image.src = file
  await promise
  ctx.drawImage(image, 0, 0)
  await snapshotImage(t)
})

test('drawImage-svg-with-only-viewBox', async (t) => {
  const { ctx } = t.context
  const filePath = './only-viewbox.svg'
  const file = await promises.readFile(join(__dirname, filePath))
  const image = new Image()
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => {
    resolve()
  }
  image.src = file
  await promise
  ctx.drawImage(image, 0, 0)
  await snapshotImage(t)
})

test('drawImage-svg-resize', async (t) => {
  const { ctx, canvas } = t.context
  const filePath = './resize.svg'
  const file = await promises.readFile(join(__dirname, filePath))
  const image = new Image()
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => {
    resolve()
  }
  image.src = file
  await promise
  image.width = 100
  image.height = 100
  ctx.drawImage(image, 0, 0)
  await snapshotImage(t, { canvas, ctx }, 'png', 0.2)
})

test.skip('drawImage-svg-with-css', async (t) => {
  const { ctx } = t.context
  const filePath = './css-style.svg'
  const file = await promises.readFile(join(__dirname, filePath))
  const image = new Image()
  image.src = file
  ctx.drawImage(image, 0, 0)
  await snapshotImage(t)
})

test('drawImage-svg without width height should be empty image', async (t) => {
  const { ctx, canvas } = t.context
  const filePath = './mountain.svg'
  const svgContent = (await promises.readFile(join(__dirname, filePath))).toString('utf-8')
  const image = new Image()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  image.onload = () => {
    resolve()
  }
  image.onerror = (err) => {
    reject(err)
  }
  image.src = Buffer.from(svgContent.replace('width="128"', '').replace('height="128"', ''))
  await promise
  ctx.drawImage(image, 0, 0)
  const output = await canvas.encode('png')
  const outputData = png.decoders['image/png'](output)
  t.deepEqual(outputData.data, Buffer.alloc(outputData.width * outputData.height * 4, 0))
})

test('draw-image-svg-noto-emoji', async (t) => {
  const { ctx } = t.context
  const filePath = './notoemoji-person.svg'
  const file = await promises.readFile(join(__dirname, filePath))
  const image = new Image()
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => {
    resolve()
  }
  image.src = file
  await promise
  ctx.drawImage(image, 0, 0)
  await snapshotImage(t)
})

test('drawImage-another-Canvas', async (t) => {
  const { ctx } = t.context

  ctx.fillStyle = 'hotpink'
  ctx.fillRect(10, 10, 100, 100)

  const anotherCanvas = createCanvas(200, 200)
  const anotherContext = anotherCanvas.getContext('2d')
  anotherContext.beginPath()
  anotherContext.ellipse(80, 80, 50, 75, Math.PI / 4, 0, 2 * Math.PI)
  anotherContext.stroke()

  // Draw the ellipse's line of reflection
  anotherContext.beginPath()
  anotherContext.setLineDash([5, 5])
  anotherContext.moveTo(10, 150)
  anotherContext.lineTo(150, 10)
  anotherContext.stroke()
  ctx.drawImage(anotherCanvas, 150, 150)
  await snapshotImage(t)
})

test('drawImage-canvas-with-source-rect', async (t) => {
  const { ctx } = t.context

  const sourceCanvas = createCanvas(200, 200)
  const sourceCtx = sourceCanvas.getContext('2d')

  // Draw quadrants
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(0, 0, 100, 100)
  sourceCtx.fillStyle = 'green'
  sourceCtx.fillRect(100, 0, 100, 100)
  sourceCtx.fillStyle = 'blue'
  sourceCtx.fillRect(0, 100, 100, 100)
  sourceCtx.fillStyle = 'yellow'
  sourceCtx.fillRect(100, 100, 100, 100)

  // Draw only green quadrant scaled up
  ctx.drawImage(sourceCanvas, 100, 0, 100, 100, 50, 50, 200, 200)

  await snapshotImage(t)
})

test('drawImage-canvas-with-alpha', async (t) => {
  const { ctx } = t.context

  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 512, 512)

  const sourceCanvas = createCanvas(200, 200)
  const sourceCtx = sourceCanvas.getContext('2d')
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(0, 0, 200, 200)

  ctx.globalAlpha = 0.5
  ctx.drawImage(sourceCanvas, 150, 150)

  // Higher tolerance (5%) due to cross-platform alpha blending differences:
  // When blending red (255,0,0) at 0.5 alpha over blue (0,0,255), the blue channel
  // calculation is: B = 0 * 0.5 + 255 * 0.5 = 127.5
  // - Linux x86-64 rounds to 127
  // - macOS ARM64 rounds to 126
  // This 1-value difference across the 200x200 blended area causes ~3.8% pixel diff.
  await snapshotImage(t, t.context, 'png', 5)
})

test('drawImage-canvas-with-transform', async (t) => {
  const { ctx } = t.context

  const sourceCanvas = createCanvas(100, 100)
  const sourceCtx = sourceCanvas.getContext('2d')
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(0, 0, 100, 100)

  ctx.translate(256, 256)
  ctx.rotate(Math.PI / 4)
  ctx.drawImage(sourceCanvas, -50, -50)

  await snapshotImage(t)
})

test('drawImage-throws-TypeError-for-invalid-image-type', (t) => {
  const { ctx } = t.context

  // Test with plain object
  t.throws(
    () => {
      // @ts-expect-error - Testing invalid type
      ctx.drawImage({}, 0, 0)
    },
    {
      instanceOf: TypeError,
      message: /Value is not one of these types/,
    },
  )

  // Test with number
  t.throws(
    () => {
      // @ts-expect-error - Testing invalid type
      ctx.drawImage(42, 0, 0)
    },
    {
      instanceOf: TypeError,
      message: /Value is not one of these types/,
    },
  )

  // Test with string
  t.throws(
    () => {
      // @ts-expect-error - Testing invalid type
      ctx.drawImage('not an image', 0, 0)
    },
    {
      instanceOf: TypeError,
      message: /Value is not one of these types/,
    },
  )

  // Test with null
  t.throws(
    () => {
      // @ts-expect-error - Testing invalid type
      ctx.drawImage(null, 0, 0)
    },
    {
      instanceOf: TypeError,
      message: /Value is not one of these types/,
    },
  )

  // Test with undefined
  t.throws(
    () => {
      // @ts-expect-error - Testing invalid type
      ctx.drawImage(undefined, 0, 0)
    },
    {
      instanceOf: TypeError,
      message: /Value is not one of these types/,
    },
  )
})

// drawCanvas tests - optimized canvas-to-canvas drawing that preserves vector graphics
test('drawCanvas-basic', async (t) => {
  const { ctx } = t.context

  // Create source canvas with some drawings
  const sourceCanvas = createCanvas(200, 200)
  const sourceCtx = sourceCanvas.getContext('2d')!

  // Draw an ellipse with dashed line (same pattern as drawImage-another-Canvas)
  sourceCtx.beginPath()
  sourceCtx.ellipse(80, 80, 50, 75, Math.PI / 4, 0, 2 * Math.PI)
  sourceCtx.stroke()

  sourceCtx.beginPath()
  sourceCtx.setLineDash([5, 5])
  sourceCtx.moveTo(10, 150)
  sourceCtx.lineTo(150, 10)
  sourceCtx.stroke()

  // Draw hotpink rect on destination first
  ctx.fillStyle = 'hotpink'
  ctx.fillRect(10, 10, 100, 100)

  // Draw source canvas to destination at position (150, 150)
  ctx.drawCanvas(sourceCanvas, 150, 150)

  await snapshotImage(t)
})

test('drawCanvas-with-scaling', async (t) => {
  const { ctx } = t.context

  // Create source canvas with a simple shape
  const sourceCanvas = createCanvas(100, 100)
  const sourceCtx = sourceCanvas.getContext('2d')!

  // Draw a filled circle
  sourceCtx.fillStyle = 'blue'
  sourceCtx.beginPath()
  sourceCtx.arc(50, 50, 40, 0, Math.PI * 2)
  sourceCtx.fill()

  // Draw a smaller version at top-left
  ctx.drawCanvas(sourceCanvas, 10, 10, 50, 50)

  // Draw a larger version at center
  ctx.drawCanvas(sourceCanvas, 150, 150, 200, 200)

  await snapshotImage(t)
})

test('drawCanvas-with-source-rect', async (t) => {
  const { ctx } = t.context

  // Create source canvas with four colored quadrants
  const sourceCanvas = createCanvas(200, 200)
  const sourceCtx = sourceCanvas.getContext('2d')!

  // Draw quadrants
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(0, 0, 100, 100)
  sourceCtx.fillStyle = 'green'
  sourceCtx.fillRect(100, 0, 100, 100)
  sourceCtx.fillStyle = 'blue'
  sourceCtx.fillRect(0, 100, 100, 100)
  sourceCtx.fillStyle = 'yellow'
  sourceCtx.fillRect(100, 100, 100, 100)

  // Draw only green quadrant scaled up
  ctx.drawCanvas(sourceCanvas, 100, 0, 100, 100, 50, 50, 200, 200)

  await snapshotImage(t)
})

test('drawCanvas-with-alpha', async (t) => {
  const { ctx } = t.context

  // Fill background with blue
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 512, 512)

  // Create source canvas with red rectangle
  const sourceCanvas = createCanvas(200, 200)
  const sourceCtx = sourceCanvas.getContext('2d')!
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(0, 0, 200, 200)

  // Draw with 50% alpha
  ctx.globalAlpha = 0.5
  ctx.drawCanvas(sourceCanvas, 150, 150)

  // Higher tolerance (5%) due to cross-platform alpha blending differences
  await snapshotImage(t, t.context, 'png', 5)
})

test('drawCanvas-with-transform', async (t) => {
  const { ctx } = t.context

  // Create source canvas with red square
  const sourceCanvas = createCanvas(100, 100)
  const sourceCtx = sourceCanvas.getContext('2d')!
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(0, 0, 100, 100)

  // Apply rotation transform
  ctx.translate(256, 256)
  ctx.rotate(Math.PI / 4)
  ctx.drawCanvas(sourceCanvas, -50, -50)

  await snapshotImage(t)
})

test('drawCanvas-with-shadow', async (t) => {
  const { ctx } = t.context

  // Create source canvas with a shape
  const sourceCanvas = createCanvas(100, 100)
  const sourceCtx = sourceCanvas.getContext('2d')!
  sourceCtx.fillStyle = 'blue'
  sourceCtx.fillRect(10, 10, 80, 80)

  // Set up shadow
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
  ctx.shadowBlur = 20
  ctx.shadowOffsetX = 10
  ctx.shadowOffsetY = 10

  // Draw canvas with shadow
  ctx.drawCanvas(sourceCanvas, 100, 100)

  await snapshotImage(t)
})

test('drawCanvas-complex-vector', async (t) => {
  const { ctx, canvas } = t.context

  // Create source canvas with complex vector graphics
  const sourceCanvas = createCanvas(200, 200)
  const sourceCtx = sourceCanvas.getContext('2d')!

  // Draw gradient-filled shape
  const gradient = sourceCtx.createLinearGradient(0, 0, 200, 200)
  gradient.addColorStop(0, 'red')
  gradient.addColorStop(0.5, 'yellow')
  gradient.addColorStop(1, 'green')

  sourceCtx.fillStyle = gradient
  sourceCtx.beginPath()
  sourceCtx.moveTo(100, 10)
  sourceCtx.lineTo(190, 190)
  sourceCtx.lineTo(10, 190)
  sourceCtx.closePath()
  sourceCtx.fill()

  // Add stroked circle
  sourceCtx.strokeStyle = 'purple'
  sourceCtx.lineWidth = 5
  sourceCtx.beginPath()
  sourceCtx.arc(100, 100, 60, 0, Math.PI * 2)
  sourceCtx.stroke()

  // Draw the source canvas at different positions and sizes
  ctx.drawCanvas(sourceCanvas, 10, 10)
  ctx.drawCanvas(sourceCanvas, 250, 10, 100, 100)
  ctx.drawCanvas(sourceCanvas, 10, 250, 150, 150)

  await snapshotImage(t, { canvas, ctx }, 'png', 0.3)
})

test('drawCanvas-preserves-vector-quality', async (t) => {
  const { ctx } = t.context

  // Create a small source canvas with crisp vector graphics
  const sourceCanvas = createCanvas(50, 50)
  const sourceCtx = sourceCanvas.getContext('2d')!

  // Draw a precise shape
  sourceCtx.strokeStyle = 'black'
  sourceCtx.lineWidth = 2
  sourceCtx.beginPath()
  sourceCtx.moveTo(5, 25)
  sourceCtx.lineTo(25, 5)
  sourceCtx.lineTo(45, 25)
  sourceCtx.lineTo(25, 45)
  sourceCtx.closePath()
  sourceCtx.stroke()

  // Scale up significantly - vector graphics should remain crisp
  ctx.drawCanvas(sourceCanvas, 50, 50, 400, 400)

  await snapshotImage(t)
})

test('drawCanvas-preserves-source-transform-after-read', async (t) => {
  const { ctx } = t.context

  const sourceCanvas = createCanvas(200, 200)
  const sourceCtx = sourceCanvas.getContext('2d')!

  // Apply transform to source
  sourceCtx.translate(100, 100)
  sourceCtx.rotate(Math.PI / 4)

  // Draw initial content with transform
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(-50, -50, 100, 100)

  // Draw source to destination (triggers layer promotion in source)
  ctx.drawCanvas(sourceCanvas, 0, 0)

  // Continue drawing on source - transform should still be active
  sourceCtx.fillStyle = 'blue'
  sourceCtx.fillRect(-25, -25, 50, 50)

  // Draw again to verify continued operations work with restored transform
  ctx.drawCanvas(sourceCanvas, 250, 0)

  await snapshotImage(t)
})

test('drawCanvas-preserves-source-clip-after-read', async (t) => {
  const { ctx } = t.context

  const sourceCanvas = createCanvas(200, 200)
  const sourceCtx = sourceCanvas.getContext('2d')!

  // Apply circular clip to source
  sourceCtx.beginPath()
  sourceCtx.arc(100, 100, 80, 0, Math.PI * 2)
  sourceCtx.clip()

  // Draw initial content (clipped to circle)
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(0, 0, 200, 200)

  // Draw source to destination (triggers layer promotion)
  ctx.drawCanvas(sourceCanvas, 0, 0)

  // Continue drawing on source - clip should still be active
  sourceCtx.fillStyle = 'blue'
  sourceCtx.fillRect(0, 0, 100, 100)

  // Draw again to verify clip was restored
  ctx.drawCanvas(sourceCanvas, 250, 0)

  await snapshotImage(t)
})

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

test('fillText', async (t) => {
  const { ctx, canvas } = t.context
  ctx.fillStyle = 'yellow'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'
  ctx.font = '48px Iosevka Slab'
  ctx.fillText('skr canvas', 50, 150)
  const gradient = ctx.createConicGradient(0, 100, 100)

  // Add five color stops
  gradient.addColorStop(0, 'red')
  gradient.addColorStop(0.15, 'orange')
  gradient.addColorStop(0.25, 'yellow')
  gradient.addColorStop(0.35, 'orange')
  gradient.addColorStop(0.5, 'green')
  gradient.addColorStop(0.75, 'cyan')
  gradient.addColorStop(1, 'blue')

  // Set the fill style and draw a rectangle
  ctx.fillStyle = gradient
  ctx.fillText('@napi-rs/canvas', 50, 250)
  await snapshotImage(t, { canvas, ctx }, 'png', 3.2)
})

test('fillText-maxWidth', async (t) => {
  const { ctx, canvas } = t.context
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'
  ctx.font = '24px Iosevka Slab'
  ctx.fillText('Hello world', 50, 90, 90)
  ctx.fillText('Hello world', 160, 90)
  await snapshotImage(t, { canvas, ctx }, 'png', 0.8)
})

test('fillText-AA', async (t) => {
  const { ctx, canvas } = t.context
  ctx.imageSmoothingEnabled = false
  ctx.font = '16px OSRSFontCompact'
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 100, 100)
  ctx.fillStyle = 'black'
  ctx.fillText('@napi-rs/canvas', 10, 10)
  ctx.fillText('ABC abc 123', 10, 40)
  await snapshotImage(t, { canvas, ctx }, 'png', 3.2)
})

test('fillText-COLRv1', async (t) => {
  const { ctx, canvas } = t.context
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'COLR-v1.ttf'), 'Colrv1')
  ctx.font = '100px Colrv1'
  ctx.fillText('abc', 50, 100)
  await snapshotImage(t, { canvas, ctx }, 'png', 0.5)
})

test('getContextAttributes', (t) => {
  const defaultCtx = t.context.ctx
  const defaultAttrs = defaultCtx.getContextAttributes()
  t.is(defaultAttrs.alpha, true)
  t.is(defaultAttrs.desynchronized, false)

  const canvas = createCanvas(512, 512)
  const ctx = canvas.getContext('2d', { alpha: false })
  const customAttrs = ctx.getContextAttributes()
  t.is(customAttrs.alpha, false)
  t.is(customAttrs.desynchronized, false)
})

test('getImageData', async (t) => {
  const { ctx } = t.context
  ctx.rect(10, 10, 100, 100)
  ctx.fill()
  const imageData = ctx.getImageData(60, 60, 200, 100)
  ctx.putImageData(imageData, 150, 10)
  await snapshotImage(t)
})

test('isPointInPath', (t) => {
  const { ctx } = t.context

  ctx.rect(0, 0, 100, 100)
  t.is(ctx.isPointInPath(50, -1), false) // Outside the rect
  t.is(ctx.isPointInPath(50, 0), true) // On the edge of the rect
  t.is(ctx.isPointInPath(50, 1), true) // Inside the rect

  ctx.rect(40, 40, 20, 20) // Overlap the area center
  t.is(ctx.isPointInPath(50, 50), true)
  t.is(ctx.isPointInPath(50, 50, 'nonzero'), true)
  t.is(ctx.isPointInPath(50, 50, 'evenodd'), false)

  const path = new Path2D()
  path.rect(0, 0, 100, 100)
  t.is(ctx.isPointInPath(path, 50, -1), false)
  t.is(ctx.isPointInPath(path, 50, 1), true)

  path.rect(40, 40, 20, 20)
  t.is(ctx.isPointInPath(path, 50, 50), true)
  t.is(ctx.isPointInPath(path, 50, 50, 'nonzero'), true)
  t.is(ctx.isPointInPath(path, 50, 50, 'evenodd'), false)
})

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

test('lineTo-with-invalid-point', async (t) => {
  const { ctx } = t.context
  ctx.beginPath() // Start a new path
  ctx.lineTo(NaN, 100)
  ctx.lineTo(50, 50)
  ctx.lineTo(100, NaN)
  ctx.lineTo(250, 100)
  ctx.stroke()
  await snapshotImage(t)
})

test('measureText', (t) => {
  const { ctx } = t.context
  ctx.font = '50px Iosevka Slab'
  const metrics = ctx.measureText('@napi-rs/canvas')
  t.is(metrics.actualBoundingBoxLeft, -3)
  t.is(metrics.actualBoundingBoxAscent, 42)
  t.is(metrics.actualBoundingBoxDescent, 10)
  t.true(Math.abs(metrics.actualBoundingBoxRight - 372) < 0.001)
  t.notThrows(() => {
    ctx.measureText('\u200b')
  })
})

test('measureText with empty string should not throw', (t) => {
  const { ctx } = t.context
  ctx.font = '50px Iosevka Slab'
  t.deepEqual(ctx.measureText(''), {
    actualBoundingBoxAscent: 0,
    actualBoundingBoxDescent: 0,
    actualBoundingBoxLeft: 0,
    actualBoundingBoxRight: 0,
    fontBoundingBoxAscent: 0,
    fontBoundingBoxDescent: 0,
    alphabeticBaseline: 0,
    emHeightAscent: 0,
    emHeightDescent: 0,
    width: 0,
  })
})

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

test('reset', async (t) => {
  const { ctx } = t.context
  // Draw something and change styles
  ctx.fillStyle = 'red'
  ctx.strokeStyle = 'blue'
  ctx.lineWidth = 5
  ctx.globalAlpha = 0.5
  ctx.shadowColor = 'green'
  ctx.shadowBlur = 10
  ctx.shadowOffsetX = 5
  ctx.shadowOffsetY = 5
  ctx.transform(1, 0.2, 0.8, 1, 0, 0)
  // Change font-related properties
  ctx.font = '24px Iosevka Slab'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.direction = 'rtl'
  ctx.letterSpacing = '5px'
  ctx.wordSpacing = '10px'
  ctx.fontStretch = 'expanded'
  ctx.fontKerning = 'none'
  ctx.fontVariationSettings = '"wght" 700'
  ctx.fillRect(50, 50, 100, 100)

  // Save state
  ctx.save()
  ctx.fillStyle = 'purple'
  ctx.save()

  // Reset the context
  ctx.reset()

  // Verify all styles are reset to defaults
  t.is(ctx.fillStyle, '#000000')
  t.is(ctx.strokeStyle, '#000000')
  t.is(ctx.lineWidth, 1)
  t.is(ctx.globalAlpha, 1)
  t.is(ctx.shadowColor, '#000000')
  t.is(ctx.shadowBlur, 0)
  t.is(ctx.shadowOffsetX, 0)
  t.is(ctx.shadowOffsetY, 0)
  t.is(ctx.lineCap, 'butt')
  t.is(ctx.lineJoin, 'miter')
  t.is(ctx.miterLimit, 10)
  t.is(ctx.lineDashOffset, 0)
  t.deepEqual(ctx.getLineDash(), [])
  // Font-related properties
  t.is(ctx.font, '10px sans-serif')
  t.is(ctx.textAlign, 'start')
  t.is(ctx.textBaseline, 'alphabetic')
  // TODO: Support direction
  // t.is(ctx.direction, 'rtl')
  t.is(ctx.letterSpacing, '0px')
  t.is(ctx.wordSpacing, '0px')
  t.is(ctx.fontStretch, 'normal')
  t.is(ctx.fontKerning, 'auto')
  t.is(ctx.fontVariationSettings, 'normal')
  t.is(ctx.fontVariantCaps, 'normal')
  // TODO Support textRendering
  // t.is(ctx.textRendering , 'auto')
  // Other properties
  t.is(ctx.globalCompositeOperation, 'source-over')
  t.is(ctx.imageSmoothingEnabled, true)
  t.is(ctx.imageSmoothingQuality, 'low')
  t.is(ctx.filter, 'none')

  // Verify transform is reset to identity
  const transform = ctx.getTransform()
  t.is(transform.a, 1)
  t.is(transform.b, 0)
  t.is(transform.c, 0)
  t.is(transform.d, 1)
  t.is(transform.e, 0)
  t.is(transform.f, 0)

  // Verify state stack is cleared (restore should not change anything)
  ctx.fillStyle = 'yellow'
  ctx.restore()
  t.is(ctx.fillStyle, 'yellow') // Should still be yellow, not restored

  // Draw a rect with default styles to verify canvas was cleared
  ctx.fillStyle = 'blue'
  ctx.fillRect(200, 200, 100, 100)
  await snapshotImage(t)
})

test('reset-clears-canvas', async (t) => {
  const { ctx, canvas } = t.context
  // Fill the entire canvas with red
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Reset should clear to transparent
  ctx.reset()

  // Draw something small to verify canvas was cleared
  ctx.fillStyle = 'green'
  ctx.fillRect(100, 100, 50, 50)
  await snapshotImage(t)
})

test('reset-clears-path', async (t) => {
  const { ctx } = t.context
  // Create a path
  ctx.beginPath()
  ctx.moveTo(50, 50)
  ctx.lineTo(200, 200)
  ctx.lineTo(50, 200)
  ctx.closePath()

  // Reset should clear the path
  ctx.reset()

  // Try to fill the path - nothing should be drawn since path was cleared
  ctx.fillStyle = 'red'
  ctx.fill()

  // Draw a small rect to show canvas is working
  ctx.fillStyle = 'green'
  ctx.fillRect(100, 100, 50, 50)
  await snapshotImage(t)
})

test('reset-clears-clip', async (t) => {
  const { ctx, canvas } = t.context
  // Create a clipping region
  ctx.beginPath()
  ctx.rect(100, 100, 100, 100)
  ctx.clip()

  // This rect should be clipped
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Reset should clear the clipping region
  ctx.reset()

  // This rect should NOT be clipped
  ctx.fillStyle = 'green'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await snapshotImage(t)
})

test('reset-mdn-example', async (t) => {
  const { ctx } = t.context

  function drawRect() {
    ctx.lineWidth = 10
    ctx.strokeRect(50, 50, 150, 100)

    ctx.font = '50px Iosevka Slab'
    ctx.fillText('Rect', 70, 110)
  }

  function drawCircle() {
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.arc(300, 100, 50, 0, 2 * Math.PI)
    ctx.stroke()

    ctx.font = '22px Iosevka Slab'
    ctx.fillText('Circle', 265, 100)
  }

  // Draw rect first
  drawRect()
  // Reset the context (simulates toggle button click)
  ctx.reset()
  // Draw circle after reset
  drawCircle()

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

test('save-restore-after-layer-promotion', async (t) => {
  const { ctx, canvas } = t.context
  // Test that save/restore state is preserved after layer promotion (getImageData)
  // This tests the fix for: https://github.com/Brooooooklyn/canvas/pull/1193

  // Draw background
  ctx.fillStyle = 'lightgray'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Save state and set up clip
  ctx.save()
  ctx.beginPath()
  ctx.rect(50, 50, 200, 200)
  ctx.clip()

  // Draw inside clip (should be visible)
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 300, 300)

  // Trigger layer promotion via getImageData
  ctx.getImageData(0, 0, 1, 1)

  // Draw more inside clip (should still be clipped after layer promotion)
  ctx.fillStyle = 'blue'
  ctx.fillRect(100, 100, 200, 200)

  // Restore state - clip should be removed
  ctx.restore()

  // Draw outside the clip area (should be visible since clip was restored)
  ctx.fillStyle = 'green'
  ctx.fillRect(300, 50, 150, 200)

  await snapshotImage(t)
})

test('save-restore-transform-after-layer-promotion', async (t) => {
  const { ctx, canvas } = t.context
  // Test that transform state is correctly restored after layer promotion
  // This tests the fix for: Canvas state not restored after layer promotion and restore

  // Draw background
  ctx.fillStyle = 'lightgray'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Set up initial transform (translate 50, 50)
  ctx.translate(50, 50)

  // Save state with the transform
  ctx.save()

  // Apply additional transform (rotate 45 degrees)
  ctx.rotate(Math.PI / 4)

  // Draw rotated red rectangle
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 100, 50)

  // Trigger layer promotion via getImageData
  ctx.getImageData(0, 0, 1, 1)

  // Draw more content with current rotated transform
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 60, 100, 50)

  // Restore state - should restore to translate(50, 50) without rotation
  ctx.restore()

  // Draw with restored transform (no rotation, just translate)
  // This rectangle should appear at (50, 200) without rotation
  ctx.fillStyle = 'green'
  ctx.fillRect(0, 150, 150, 80)

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

test('setTransform matrix', async (t) => {
  const { ctx } = t.context
  const mat = new DOMMatrix()
    .rotate(30)
    .skewX(30)
    .scale(1, Math.sqrt(3) / 2)
  ctx.setTransform(mat)
  ctx.fillStyle = 'red'
  ctx.fillRect(100, 100, 100, 100)
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
  ctx.lineJoin = 'bevel'
  ctx.lineWidth = 15
  ctx.strokeStyle = '#38f'
  ctx.strokeRect(30, 30, 160, 90)
  await snapshotImage(t)
})

test('strokeRoundRect', async (t) => {
  const canvas = createCanvas(700, 300)
  const ctx = canvas.getContext('2d')
  // Rounded rectangle with zero radius (specified as a number)
  ctx.strokeStyle = 'red'
  ctx.beginPath()
  ctx.roundRect(10, 20, 150, 100, 0)
  ctx.stroke()

  // Rounded rectangle with 40px radius (single element list)
  ctx.strokeStyle = 'blue'
  ctx.beginPath()
  ctx.roundRect(10, 20, 150, 100, [40])
  ctx.stroke()

  // Rounded rectangle with 2 different radii
  ctx.strokeStyle = 'orange'
  ctx.beginPath()
  ctx.roundRect(10, 150, 150, 100, [10, 40])
  ctx.stroke()

  // Rounded rectangle with four different radii
  ctx.strokeStyle = 'green'
  ctx.beginPath()
  ctx.roundRect(400, 20, 200, 100, [0, 30, 50, 60])
  ctx.stroke()

  // Same rectangle drawn backwards
  ctx.strokeStyle = 'magenta'
  ctx.beginPath()
  ctx.roundRect(400, 150, -200, 100, [0, 30, 50, 60])
  ctx.stroke()

  await snapshotImage(t, { canvas, ctx })
})

test('strokeText', async (t) => {
  const { ctx, canvas } = t.context
  ctx.fillStyle = 'yellow'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = 'black'
  ctx.lineWidth = 3
  ctx.font = '50px Iosevka Slab'
  ctx.strokeText('skr canvas', 50, 150)
  const gradient = ctx.createConicGradient(0, 100, 100)

  // Add five color stops
  gradient.addColorStop(0, 'red')
  gradient.addColorStop(0.15, 'orange')
  gradient.addColorStop(0.25, 'yellow')
  gradient.addColorStop(0.35, 'orange')
  gradient.addColorStop(0.5, 'green')
  gradient.addColorStop(0.75, 'cyan')
  gradient.addColorStop(1, 'blue')

  // Set the fill style and draw a rectangle
  ctx.strokeStyle = gradient
  ctx.strokeText('@napi-rs/canvas', 50, 300)
  await snapshotImage(t, { canvas, ctx }, 'png', 3.5)
})

test('empty text', async (t) => {
  const { ctx } = t.context
  t.notThrows(() => ctx.fillText('', 50, 50))
  t.notThrows(() => ctx.strokeText('', 50, 50))
})

test('draw-text-emoji', async (t) => {
  if (platform() === 'darwin') {
    t.pass('macOS definitely supports emoji')
    return
  }
  const { ctx, canvas } = t.context
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'AppleColorEmoji@2x.ttf'))
  ctx.font = '50px Apple Color Emoji'
  ctx.strokeText('😀😃😄😁😆😅', 50, 100)
  ctx.fillText('😂🤣☺️😊😊😇', 50, 220)
  await snapshotImage(t, { canvas, ctx }, 'png', 0.05)
})

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
  drawTranslate(ctx)
  await snapshotImage(t)
})

test('translate-with-transform', async (t) => {
  const { ctx } = t.context
  ctx.translate(110, 30)
  ctx.transform(1, 0, 0, 1, -20, -10)
  ctx.transform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = 'red'
  ctx.fillRect(-30, -10, 80, 80)
  await snapshotImage(t)
})

test('webp-output', async (t) => {
  const { ctx } = t.context
  drawTranslate(ctx)
  await snapshotImage(t, t.context, 'webp')
})

test('avif-output', async (t) => {
  const { ctx } = t.context
  drawTranslate(ctx)
  await snapshotImage(t, t.context, 'avif')
})

test('raw output', async (t) => {
  const { ctx, canvas } = t.context
  drawTranslate(ctx)

  const output = canvas.data()
  const pngFromCanvas = await canvas.encode('png')
  const pngOutput = png.decoders['image/png'](pngFromCanvas)
  t.deepEqual(output, pngOutput.data)
})

test('toDataURL', async (t) => {
  const { ctx, canvas } = t.context
  drawTranslate(ctx)

  const output = canvas.toDataURL()
  const prefix = 'data:image/png;base64,'
  t.true(output.startsWith(prefix))
  const imageBase64 = output.substring(prefix.length)
  const pngBuffer = Buffer.from(imageBase64, 'base64')
  t.deepEqual(pngBuffer, await canvas.encode('png'))
})

test('JPEG toDataURL with quality', async (t) => {
  const { ctx, canvas } = t.context
  drawTranslate(ctx)

  const output = canvas.toDataURL('image/jpeg', 0.2)
  const prefix = 'data:image/jpeg;base64,'
  t.true(output.startsWith(prefix))
  const imageBase64 = output.substring(prefix.length)
  const pngBuffer = Buffer.from(imageBase64, 'base64')
  t.deepEqual(pngBuffer, await canvas.encode('jpeg', 20))
})

test('WebP toDataURL with quality', async (t) => {
  const { ctx, canvas } = t.context
  drawTranslate(ctx)

  const output = canvas.toDataURL('image/webp', 1)
  const prefix = 'data:image/webp;base64,'
  t.true(output.startsWith(prefix))
  const imageBase64 = output.substring(prefix.length)
  const webpBuffer = Buffer.from(imageBase64, 'base64')
  t.deepEqual(webpBuffer, await canvas.encode('webp', 100))
})

test('toDataURLAsync', async (t) => {
  const { ctx, canvas } = t.context
  drawTranslate(ctx)
  const output = await canvas.toDataURLAsync()
  const prefix = 'data:image/png;base64,'
  t.true(output.startsWith(prefix))
  const imageBase64 = output.substring(prefix.length)
  const pngBuffer = Buffer.from(imageBase64, 'base64')
  t.deepEqual(pngBuffer, await canvas.encode('png'))
})

test('shadowOffsetX', async (t) => {
  const { ctx } = t.context
  ctx.shadowColor = 'red'
  ctx.shadowOffsetX = 25
  ctx.shadowBlur = 10

  // Rectangle
  ctx.fillStyle = 'blue'
  ctx.fillRect(20, 20, 150, 100)
  await snapshotImage(t)
})

test('should not throw while fill/stroke style is invalid', (t) => {
  const { ctx } = t.context
  t.notThrows(() => {
    ctx.fillStyle = '#'
    ctx.fillStyle = '#123'
    // @ts-expect-error
    ctx.fillStyle = {}
    ctx.strokeStyle = '#'
    ctx.strokeStyle = '#123'
    // @ts-expect-error
    ctx.strokeStyle = {}
  })
})

test('shadowOffsetY', async (t) => {
  const { ctx } = t.context
  ctx.shadowColor = 'red'
  ctx.shadowOffsetY = 25
  ctx.shadowBlur = 10

  // Rectangle
  ctx.fillStyle = 'blue'
  ctx.fillRect(20, 20, 150, 80)
  await snapshotImage(t)
})

function drawTranslate(ctx: SKRSContext2D) {
  // Moved square
  ctx.translate(110, 30)
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 80, 80)

  // Reset current transformation matrix to the identity matrix
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  // Unmoved square
  ctx.fillStyle = 'gray'
  ctx.fillRect(0, 0, 80, 80)
}
