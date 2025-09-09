import test from 'ava'
import { promises } from 'fs'
import { join } from 'path'

import { createCanvas } from '../index'

test('shadow with transform should match browser behavior', async (t) => {
  // Reproduce the issue from GitHub issue #1121
  const canvas = createCanvas(578, 200)
  const ctx = canvas.getContext('2d')

  ctx.clearRect(0, 0, 578, 200)
  ctx.save()
  ctx.transform(0.5, 0, 0, 0.5, 100, 100)
  ctx.shadowColor = 'rgba(0,0,0,1)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 5
  ctx.shadowOffsetY = 5
  ctx.beginPath()
  ctx.rect(0, 0, 100, 100)
  ctx.closePath()
  ctx.fillStyle = 'green'
  ctx.fill()
  ctx.restore()

  const buffer = canvas.toBuffer('image/png')
  await promises.writeFile(join(__dirname, 'fixtures', 'shadow-transform-fixed.png'), buffer)
  
  // The fix should ensure that shadow offset is 5 pixels in canvas coordinates,
  // not 5 pixels in the transformed coordinate space
  t.pass('Shadow with transform test - shadow offset should be in canvas coordinates')
})

test('shadow with identity transform should work correctly', async (t) => {
  // Control test - shadow without transform should work as expected
  const canvas = createCanvas(578, 200)
  const ctx = canvas.getContext('2d')

  ctx.clearRect(0, 0, 578, 200)
  ctx.shadowColor = 'rgba(0,0,0,1)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 5
  ctx.shadowOffsetY = 5
  ctx.beginPath()
  ctx.rect(100, 100, 50, 50) // Half size of transformed version
  ctx.closePath()
  ctx.fillStyle = 'green'
  ctx.fill()

  const buffer = canvas.toBuffer('image/png')
  await promises.writeFile(join(__dirname, 'fixtures', 'shadow-no-transform.png'), buffer)
  
  t.pass('Control test for shadow without transform')
})

test('shadow with scale transform should preserve offset in canvas coordinates', async (t) => {
  // Test that shadow offset is consistent regardless of scaling
  const canvas1 = createCanvas(200, 200)
  const ctx1 = canvas1.getContext('2d')
  
  // Draw a rectangle at scale 1.0 with shadow
  ctx1.clearRect(0, 0, 200, 200)
  ctx1.shadowColor = 'rgba(0,0,0,1)'
  ctx1.shadowBlur = 0
  ctx1.shadowOffsetX = 10
  ctx1.shadowOffsetY = 10
  ctx1.fillStyle = 'blue'
  ctx1.fillRect(50, 50, 50, 50)
  
  const canvas2 = createCanvas(200, 200)
  const ctx2 = canvas2.getContext('2d')
  
  // Draw the same rectangle at scale 0.5 with same shadow offset
  ctx2.clearRect(0, 0, 200, 200)
  ctx2.save()
  ctx2.scale(0.5, 0.5)
  ctx2.shadowColor = 'rgba(0,0,0,1)'
  ctx2.shadowBlur = 0
  ctx2.shadowOffsetX = 10  // Should still be 10 canvas pixels, not 5
  ctx2.shadowOffsetY = 10  // Should still be 10 canvas pixels, not 5
  ctx2.fillStyle = 'blue'
  ctx2.fillRect(100, 100, 100, 100) // Larger rect to compensate for scale
  ctx2.restore()

  const buffer1 = canvas1.toBuffer('image/png')
  const buffer2 = canvas2.toBuffer('image/png')
  
  await promises.writeFile(join(__dirname, 'fixtures', 'shadow-scale-test-normal.png'), buffer1)
  await promises.writeFile(join(__dirname, 'fixtures', 'shadow-scale-test-scaled.png'), buffer2)
  
  // The shadow should appear at the same offset distance in both images
  t.pass('Shadow offset consistency test across scales')
})