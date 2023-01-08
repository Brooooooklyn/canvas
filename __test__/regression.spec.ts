import { promises as fs } from 'fs'
import { join } from 'path'

import test from 'ava'

import { createCanvas, loadImage, GlobalFonts } from '../index'
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

test('fill-alpha-should-not-effect-drawImage', async (t) => {
  const canvas = createCanvas(300, 320)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'rgba(3, 169, 244, 0.5)'

  // Image
  const image = await fs.readFile(join(__dirname, 'javascript.png'))
  ctx.drawImage(await loadImage(image), 0, 0, 200, 100)
  await snapshotImage(t, { ctx, canvas })
})

test('global-alpha-should-effect-drawImage', async (t) => {
  const canvas = createCanvas(300, 320)
  const ctx = canvas.getContext('2d')
  ctx.globalAlpha = 0.2

  // Image
  const image = await fs.readFile(join(__dirname, 'javascript.png'))
  ctx.drawImage(await loadImage(image), 0, 0, 200, 100)
  await snapshotImage(t, { ctx, canvas }, 'png', 1)
})

test('draw-text-maxWidth', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  const canvas = createCanvas(150, 150)
  const ctx = canvas.getContext('2d')
  const pad = 10 // padding
  ctx.textBaseline = 'top'
  ctx.font = '50px Iosevka Slab'

  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.fillStyle = 'blue'
  ctx.fillRect(pad, pad, canvas.width - pad * 2, canvas.height - pad * 2)

  const maxWidth = canvas.width - pad * 2
  ctx.fillStyle = 'white'
  ctx.fillText('Short text', pad, 10, maxWidth)
  ctx.fillText(`Very ${'long '.repeat(2)} text`, pad, 80, maxWidth)
  await snapshotImage(t, { ctx, canvas })
})
