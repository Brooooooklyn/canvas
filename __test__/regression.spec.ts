import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import test from 'ava'

import { createCanvas, loadImage, GlobalFonts, Image, DOMMatrix, DOMPoint } from '../index'
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

test('draw-text-right-maxWidth', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  const canvas = createCanvas(500, 100)
  const ctx = canvas.getContext('2d')
  const padding = 50
  const maxWidth = canvas.width - padding * 2
  // The background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'blue'
  ctx.fillRect(padding, 0, maxWidth, canvas.height)
  ctx.font = '16px Iosevka Slab'
  ctx.textAlign = 'right'
  ctx.fillStyle = 'white'
  ctx.textBaseline = 'top'
  /** Short text */
  ctx.fillText('Short text', canvas.width - padding, 10, maxWidth)
  /** Very long text (10 repetitions) */
  ctx.fillText(`Very ${'long '.repeat(10)} text`, canvas.width - padding, 30, maxWidth)
  /** Very long text (20 repetitions) */
  ctx.fillText(`Very ${'long '.repeat(20)} text`, canvas.width - padding, 50, maxWidth)
  await snapshotImage(t, { ctx, canvas })
})

test('draw-text-center-maxWidth', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  const canvas = createCanvas(500, 100)
  const ctx = canvas.getContext('2d')
  const padding = 50
  const maxWidth = canvas.width - padding * 2
  // The background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'blue'
  ctx.fillRect(padding, 0, maxWidth, canvas.height)
  ctx.font = '16px Iosevka Slab'
  ctx.textAlign = 'center'
  ctx.fillStyle = 'white'
  ctx.textBaseline = 'top'
  /** Short text */
  ctx.fillText('Short text', canvas.width / 2, 10, maxWidth)
  /** Very long text (10 repetitions) */
  ctx.fillText(`Very ${'long '.repeat(10)} text`, canvas.width / 2, 30, maxWidth)
  /** Very long text (20 repetitions) */
  ctx.fillText(`Very ${'long '.repeat(20)} text`, canvas.width / 2, 50, maxWidth)
  await snapshotImage(t, { ctx, canvas })
})

test('draw-svg-with-text', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  const canvas = createCanvas(1200, 700)
  const ctx = canvas.getContext('2d')
  const ViceCityGradient = ctx.createLinearGradient(0, 0, 1200, 0)
  ViceCityGradient.addColorStop(0, '#3494e6')
  ViceCityGradient.addColorStop(1, '#EC6EAD')
  ctx.fillStyle = ViceCityGradient
  ctx.fillRect(0, 0, 1200, 700)
  ctx.fillStyle = 'white'
  ctx.font = '48px Iosevka Slab'
  const Title = '@napi-rs/image'
  ctx.fillText(Title, 80, 100)

  const Arrow = new Image()
  const { promise, resolve } = Promise.withResolvers<void>()
  Arrow.onload = () => {
    resolve()
  }
  Arrow.src = await fs.readFile(join(__dirname, 'image-og.svg'))
  await promise
  ctx.drawImage(Arrow, 80, 60)
  await snapshotImage(t, { ctx, canvas }, 'png', process.arch === 'x64' && process.platform !== 'darwin' ? 0.15 : 0.3)
})

test('DOMMatrix::transformPoint', (t) => {
  t.deepEqual(new DOMMatrix().transformPoint({ x: 1, y: 2 }), new DOMPoint(1, 2))
})

test('isPointInPath with translate', (t) => {
  const canvas = createCanvas(1200, 700)
  const ctx = canvas.getContext('2d')
  ctx.translate(10, 10)
  ctx.rect(0, 0, 100, 100)
  t.false(ctx.isPointInPath(0, 0))
  t.true(ctx.isPointInPath(10, 10))
  t.true(ctx.isPointInPath(100, 100))
  t.true(ctx.isPointInPath(110, 110))
})

test('restore from scale(0, 0)', (t) => {
  const canvas = createCanvas(1200, 700)
  const ctx = canvas.getContext('2d')
  t.notThrows(() => {
    ctx.scale(0, 0)
    ctx.save()
    ctx.restore()
  })
})

// https://github.com/Brooooooklyn/canvas/issues/856
test('shadow-blur-with-translate', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  const canvas = createCanvas(500, 500)
  const ctx = canvas.getContext('2d')
  ctx.font = '48px Iosevka Slab'
  ctx.shadowColor = 'rgb(255, 0, 0)'
  ctx.shadowBlur = 10
  ctx.translate(50, 50)
  ctx.fillText('TEST', 0, 0)
  ctx.strokeRect(-50, -50, 200, 100)
  await snapshotImage(t, { ctx, canvas })
})

// https://github.com/Brooooooklyn/canvas/issues/857
test('shadow-blur-zero-with-text', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  const canvas = createCanvas(500, 500)
  const ctx = canvas.getContext('2d')
  ctx.font = '48px Iosevka Slab'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 20
  ctx.shadowOffsetY = 20
  ctx.shadowColor = 'red'
  ctx.fillStyle = 'green'
  ctx.fillText('TEST', 100, 100)
  await snapshotImage(t, { ctx, canvas })
})

// https://github.com/Brooooooklyn/canvas/issues/973
test('putImageData double free', (t) => {
  const canvas = createCanvas(1920, 1080)
  const ctx = canvas.getContext('2d')

  const canvas2 = createCanvas(640, 480)
  const ctx2 = canvas2.getContext('2d')
  ctx2.fillStyle = 'white'
  ctx2.fillRect(0, 0, canvas2.width, canvas2.height)

  let imgData = ctx2.getImageData(0, 0, canvas2.width, canvas2.height)

  t.notThrows(() => {
    ctx.putImageData(imgData, 0, 0, 0, 0, canvas.width, canvas.height)
  })
})
