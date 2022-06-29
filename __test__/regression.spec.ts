import test from 'ava'

import { createCanvas } from '../index'
import { snapshotImage } from './image-snapshot'

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

test('transform-with-radial-gradient', async (t) => {
  const canvas = createCanvas(256, 256)
  const ctx = canvas.getContext('2d')
  ctx.translate(128.5, 128.5)
  ctx.scale(1, 1)
  ctx.clearRect(-128, -128, 256, 256)
  ctx.beginPath()
  ctx.save()
  ctx.transform(1, 0, 0, 0.9090909090909091, 0, 0)
  ctx.arc(0, 0, 110, 0, 6.283185307179586, false)
  ctx.restore()
  ctx.save()
  const p = ctx.createRadialGradient(0.5, 0.5, 0, 0.2, 0.4, 0.5)
  p.addColorStop(1, 'rgba(0, 0, 255, 1)')
  p.addColorStop(0, 'rgba(200, 200, 200, 0)')
  ctx.fillStyle = p
  ctx.transform(220, 0, 0, 200, -110, -100)
  ctx.transform(1, 0, 0, 1, 0, 0)
  ctx.fill()
  ctx.restore()
  await snapshotImage(t, { canvas, ctx })
})

test('transform-with-radial-gradient-x', async (t) => {
  if (process.arch === 'arm') {
    t.pass('skip on arm')
    return
  }
  const canvas = createCanvas(400, 282)
  const ctx = canvas.getContext('2d')
  ctx.translate(200.5, 141.5)
  ctx.scale(1, 1)
  ctx.clearRect(-181.5, -128, 363, 256)
  ctx.beginPath()
  ctx.save()
  ctx.transform(1, 0, 0, 0.5555555555555556, 0, 0)
  ctx.arc(0, 0, 180, 0, 6.283185307179586, false)
  ctx.restore()
  ctx.save()
  const p = ctx.createRadialGradient(0.5, 0.5, 0, 0.5, 0.5, 0.5)
  p.addColorStop(1, 'rgba(0, 0, 255, 1)')
  p.addColorStop(0, 'rgba(200, 200, 200, 0)')
  ctx.fillStyle = p
  ctx.transform(360, 0, 0, 200, -180, -100)
  ctx.transform(1, 0, 0, 1, 0, 0)
  ctx.fill()
  ctx.restore()
  await snapshotImage(t, { canvas, ctx })
})
