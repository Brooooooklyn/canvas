import { join } from 'node:path'

import ava, { TestFn } from 'ava'

import { createCanvas, Path2D, Canvas, SKRSContext2D, DOMMatrix, loadImage } from '../index'

import { snapshotImage } from './image-snapshot'

const test = ava as TestFn<{
  canvas: Canvas
  ctx: SKRSContext2D
}>

test.beforeEach((t) => {
  const canvas = createCanvas(1024, 768)
  t.context.canvas = canvas
  t.context.ctx = canvas.getContext('2d')!
})

test('should be able to create Path2D', (t) => {
  t.notThrows(() => new Path2D())
  t.notThrows(
    () =>
      new Path2D(
        'M108.956,403.826c0,0,0.178,3.344-1.276,3.311  c-1.455-0.033-30.507-84.917-66.752-80.957C40.928,326.18,72.326,313.197,108.956,403.826z',
      ),
  )
  t.notThrows(() => new Path2D(new Path2D()))
})

test('miterLimit state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.miterLimit, 10)
  ctx.miterLimit = 20
  t.is(ctx.miterLimit, 20)
})

test('globalAlpha state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.globalAlpha, 1)
  ctx.globalAlpha = 0.2
  t.is(ctx.globalAlpha, 0.2)
})

test('globalCompositeOperation state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.globalCompositeOperation, 'source-over')
  ctx.globalCompositeOperation = 'xor'
  t.is(ctx.globalCompositeOperation, 'xor')
})

test('imageSmoothingEnabled state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.imageSmoothingEnabled, true)
  ctx.imageSmoothingEnabled = false
  t.is(ctx.imageSmoothingEnabled, false)
})

for (const quality of ['low', 'medium', 'high'] as const) {
  test(`draw-image-quality-${quality}`, async (t) => {
    const { ctx } = t.context
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = quality
    t.is(ctx.imageSmoothingQuality, quality)
    const image = await loadImage(join(__dirname, 'fixtures', 'filter-drop-shadow.jpeg'))
    ctx.drawImage(image, 0, 0, 426, 322)
    await snapshotImage(t)
  })
}

test('lineCap state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.lineCap, 'butt')
  ctx.lineCap = 'round'
  t.is(ctx.lineCap, 'round')
})

test('lineDashOffset state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.lineDashOffset, 0)
  ctx.lineDashOffset = 10
  t.is(ctx.lineDashOffset, 10)
})

test('lineJoin state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.lineJoin, 'miter')
  ctx.lineJoin = 'round'
  t.is(ctx.lineJoin, 'round')
})

test('lineWidth state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.lineWidth, 1)
  ctx.lineWidth = 10
  t.is(ctx.lineWidth, 10)
})

test('fillStyle state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.fillStyle, '#000')
  ctx.fillStyle = 'hotpink'
  t.is(ctx.fillStyle, 'hotpink')
})

test('strokeStyle state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.strokeStyle, '#000')
  ctx.strokeStyle = 'hotpink'
  t.is(ctx.strokeStyle, 'hotpink')
})

test('shadowBlur state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.shadowBlur, 0)
  ctx.shadowBlur = 10
  t.is(ctx.shadowBlur, 10)
})

test('shadowColor state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.shadowColor, '#000000')
  ctx.shadowColor = 'hotpink'
  t.is(ctx.shadowColor, 'hotpink')
})

test('shadowOffsetX state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.shadowOffsetX, 0)
  ctx.shadowOffsetX = 10
  t.is(ctx.shadowOffsetX, 10)
})

test('shadowOffsetY state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.shadowOffsetY, 0)
  ctx.shadowOffsetY = 10
  t.is(ctx.shadowOffsetY, 10)
})

test('lineDash state should be ok', (t) => {
  const { ctx } = t.context
  const lineDash = [1, 2, 4.5, 7]
  ctx.setLineDash(lineDash)
  t.deepEqual(ctx.getLineDash(), lineDash)
})

test('textAlign state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.textAlign, 'start')
  ctx.textAlign = 'center'
  t.is(ctx.textAlign, 'center')
})

test('textBaseline state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.textBaseline, 'alphabetic')
  ctx.textBaseline = 'hanging'
  t.is(ctx.textBaseline, 'hanging')
})

test('getTransform', (t) => {
  const { ctx } = t.context
  t.deepEqual(ctx.getTransform(), new DOMMatrix([1, 0, 0, 1, 0, 0]))
})

test('stroke-and-filling-jpeg', async (t) => {
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
  await snapshotImage(t, t.context, 'jpeg')
})

test('composition-destination-in', async (t) => {
  const { ctx } = t.context
  t.context.canvas.width = 300
  t.context.canvas.height = 300
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 300, 300)
  ctx.save()
  ctx.globalCompositeOperation = 'destination-in'
  ctx.fillStyle = 'green'
  ctx.beginPath()
  ctx.arc(150, 150, 100, 0, Math.PI * 2)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  await snapshotImage(t, t.context, 'png')
})

test('composition-source-in', async (t) => {
  const { ctx } = t.context
  t.context.canvas.width = 300
  t.context.canvas.height = 300
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 300, 300)
  ctx.save()
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = 'green'
  ctx.beginPath()
  ctx.arc(150, 150, 100, 0, Math.PI * 2)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  await snapshotImage(t, t.context, 'png')
})

test('should be able to encode image stream', async (t) => {
  const { ctx } = t.context
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 100, 100)
  const buffers = []
  for await (const chunk of ctx.canvas.encodeStream('png')) {
    buffers.push(chunk)
  }
  t.deepEqual(Buffer.concat(buffers), await ctx.canvas.encode('png'))
})
