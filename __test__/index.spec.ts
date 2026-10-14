import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import ava, { TestFn } from 'ava'

import { createCanvas, Path2D, Canvas, SKRSContext2D, DOMMatrix, loadImage } from '../index'

import { snapshotImage } from './image-snapshot'

const __dirname = dirname(fileURLToPath(import.meta.url))

const test = ava as TestFn<{
  canvas: Canvas
  ctx: SKRSContext2D
}>

test.beforeEach((t) => {
  const canvas = createCanvas(1024, 768)
  t.context.canvas = canvas
  t.context.ctx = canvas.getContext('2d')!
})

test('pattern snapshots preserve integer texels after canvas mutation', (t) => {
  const source = createCanvas(2, 2)
  const src = source.getContext('2d')
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffffff']
  for (let i = 0; i < colors.length; i++) {
    src.fillStyle = colors[i]
    src.fillRect(i % 2, Math.floor(i / 2), 1, 1)
  }
  const expected = [...src.getImageData(0, 0, 2, 2).data]
  const ctx = createCanvas(2, 2).getContext('2d')
  ctx.fillStyle = ctx.createPattern(source, 'repeat')!
  source.width = 1
  ctx.fillRect(0, 0, 2, 2)
  t.deepEqual([...ctx.getImageData(0, 0, 2, 2).data], expected)
})

test('pattern sampling follows smoothing changes after assignment', (t) => {
  const source = createCanvas(2, 1)
  const src = source.getContext('2d')
  src.fillStyle = '#ff0000'
  src.fillRect(0, 0, 1, 1)
  src.fillStyle = '#00ff00'
  src.fillRect(1, 0, 1, 1)
  const ctx = createCanvas(4, 1).getContext('2d')
  const pattern = ctx.createPattern(source, 'repeat')!
  pattern.setTransform(new DOMMatrix([2, 0, 0, 1, 0, 0]))
  ctx.fillStyle = pattern
  ctx.imageSmoothingEnabled = false
  ctx.fillRect(0, 0, 4, 1)
  const expected = [255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255]
  t.deepEqual([...ctx.getImageData(0, 0, 4, 1).data], expected)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'low'
  ctx.fillRect(0, 0, 4, 1)
  // Chrome 155's CPU canvas
  t.deepEqual(
    [...ctx.getImageData(0, 0, 4, 1).data],
    [191, 64, 0, 255, 191, 64, 0, 255, 64, 191, 0, 255, 64, 191, 0, 255],
  )
  ctx.imageSmoothingEnabled = false
  ctx.fillRect(0, 0, 4, 1)
  t.deepEqual([...ctx.getImageData(0, 0, 4, 1).data], expected)
})

// Expected values are Chrome 155's CPU canvas: filtering premultiplied texels
// keeps the red at full strength next to a transparent texel.
test('canvas pattern filters premultiplied texels', (t) => {
  const source = createCanvas(2, 1)
  const src = source.getContext('2d')
  src.fillStyle = '#ff0000'
  src.fillRect(0, 0, 1, 1)
  const ctx = createCanvas(8, 1).getContext('2d')
  const pattern = ctx.createPattern(source, 'repeat')!
  pattern.setTransform(new DOMMatrix([4, 0, 0, 1, 0, 0]))
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, 8, 1)
  t.deepEqual(
    [...ctx.getImageData(0, 0, 8, 1).data],
    [
      255, 0, 0, 159, 255, 0, 0, 223, 255, 0, 0, 223, 255, 0, 0, 159, 255, 0, 0, 96, 255, 0, 0, 32, 255, 0, 0, 32, 255,
      0, 0, 96,
    ],
  )
})

// Chrome samples patterns linearly at every smoothing quality (never cubic), so
// an untransformed pattern copies its texels unchanged.
test('identity pattern keeps texels at every smoothing quality', (t) => {
  const source = createCanvas(2, 1)
  const src = source.getContext('2d')
  src.fillStyle = '#ff00ff'
  src.fillRect(0, 0, 1, 1)
  for (const quality of ['low', 'medium', 'high'] as const) {
    const ctx = createCanvas(2, 1).getContext('2d')
    ctx.imageSmoothingQuality = quality
    ctx.fillStyle = ctx.createPattern(source, 'repeat')!
    ctx.fillRect(0, 0, 2, 1)
    t.deepEqual([...ctx.getImageData(0, 0, 2, 1).data], [255, 0, 255, 255, 0, 0, 0, 0], quality)
  }
})

// Chrome 155 paints nothing with a canvas or image pattern whose matrix cannot
// be inverted.
test('pattern with a singular transform paints nothing', async (t) => {
  const source = createCanvas(4, 4)
  const src = source.getContext('2d')
  src.fillStyle = '#ff0000'
  src.fillRect(0, 0, 4, 4)
  const sources = {
    canvas: source,
    image: await loadImage(source.toBuffer('image/png')),
    imageData: src.getImageData(0, 0, 4, 4),
  }
  for (const [name, input] of Object.entries(sources)) {
    const ctx = createCanvas(4, 4).getContext('2d')
    ctx.fillStyle = '#0000ff'
    ctx.fillRect(0, 0, 4, 4)
    const pattern = ctx.createPattern(input, 'repeat')!
    pattern.setTransform(new DOMMatrix([0, 0, 0, 0, 0, 0]))
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual([...ctx.getImageData(1, 1, 1, 1).data], [0, 0, 255, 255], name)
  }
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

test('globalAlpha retains fractional state through save and restore', (t) => {
  const { ctx } = t.context
  ctx.globalAlpha = 0.501
  ctx.save()
  ctx.globalAlpha = 0.1
  t.is(ctx.globalAlpha, 0.1)
  ctx.restore()
  t.is(ctx.globalAlpha, 0.501)
  for (const invalid of [NaN, Infinity, -Number.EPSILON, 1 + Number.EPSILON]) {
    ctx.globalAlpha = invalid
    t.is(ctx.globalAlpha, 0.501)
  }
})

test('globalAlpha draws half opacity without an early byte truncation', (t) => {
  const canvas = createCanvas(1, 1)
  const ctx = canvas.getContext('2d')
  ctx.globalAlpha = 0.5
  ctx.fillStyle = 'rgb(32, 128, 223)'
  ctx.fillRect(0, 0, 1, 1)
  t.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [32, 128, 223, 128])
})

test('globalAlpha leaves rounded CSS alpha intact at full opacity', (t) => {
  for (const { alpha, expected } of [
    { alpha: 0.1, expected: [29, 128, 226, 26] },
    { alpha: 0.25, expected: [32, 128, 223, 64] },
    { alpha: 0.5, expected: [32, 128, 223, 128] },
    { alpha: 0.9, expected: [32, 128, 223, 230] },
  ]) {
    const canvas = createCanvas(1, 1)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = `rgba(32, 128, 223, ${alpha})`
    ctx.fillRect(0, 0, 1, 1)
    t.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], expected)
  }
})

test('globalAlpha preserves half opacity across native paint sources', async (t) => {
  const source = createCanvas(4, 4)
  const sourceContext = source.getContext('2d')
  sourceContext.fillStyle = 'rgb(32, 128, 223)'
  sourceContext.fillRect(0, 0, 4, 4)
  const image = await loadImage(source.toBuffer('image/png'))
  for (const mode of ['fill', 'stroke', 'gradient', 'pattern', 'image', 'canvas']) {
    const canvas = createCanvas(4, 4)
    const ctx = canvas.getContext('2d')
    ctx.globalAlpha = 0.5
    ctx.fillStyle = 'rgb(32, 128, 223)'
    ctx.strokeStyle = ctx.fillStyle
    if (mode === 'stroke') {
      ctx.lineWidth = 2
      ctx.strokeRect(1, 1, 2, 2)
    } else if (mode === 'gradient') {
      const gradient = ctx.createLinearGradient(0, 0, 4, 0)
      gradient.addColorStop(0, 'rgb(32, 128, 223)')
      gradient.addColorStop(1, 'rgb(32, 128, 223)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, 4, 4)
    } else if (mode === 'pattern') {
      ctx.fillStyle = ctx.createPattern(source, 'repeat')!
      ctx.fillRect(0, 0, 4, 4)
    } else if (mode === 'image') {
      ctx.drawImage(image, 0, 0)
    } else if (mode === 'canvas') {
      ctx.drawImage(source, 0, 0)
    } else {
      ctx.fillRect(0, 0, 4, 4)
    }
    t.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [32, 128, 223, 128], mode)
  }
})

// Image and pattern paints take globalAlpha rounded to k/255. Unrounded, 'high'
// drawImage and a pattern (smoothing on or off) drift to 76 / 178 for 0.3 /
// 0.7, and a scaled 'high' drawImage can turn 0.5 into 127. Expected values are
// Chrome 155's CPU canvas; where only the alpha is compared, Chrome's 8-bit path
// gives a different RGB.
const alphaSet = (ctx: SKRSContext2D, x: number, y: number, w: number, h: number) => [
  ...new Set(ctx.getImageData(x, y, w, h).data.filter((_, i) => i % 4 === 3)),
]

test('globalAlpha is rounded to 8 bits for high quality drawImage', async (t) => {
  const source = createCanvas(8, 8)
  const sourceContext = source.getContext('2d')
  sourceContext.fillStyle = 'rgb(32, 128, 223)'
  sourceContext.fillRect(0, 0, 8, 8)
  const image = await loadImage(source.toBuffer('image/png'))
  for (const { alpha, expected } of [
    { alpha: 0.5, expected: [32, 128, 223, 128] },
    { alpha: 0.3, expected: [33, 129, 222, 77] },
    { alpha: 0.7, expected: [31, 128, 224, 179] },
  ]) {
    for (const [name, src] of [
      ['canvas', source],
      ['image', image],
    ] as const) {
      const canvas = createCanvas(24, 24)
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingQuality = 'high'
      ctx.globalAlpha = alpha
      ctx.drawImage(src, 1, 1, 20, 20)
      t.deepEqual(alphaSet(ctx, 2, 2, 18, 18), [expected[3]], `${name} ${alpha}`)
      if (name === 'canvas') {
        t.deepEqual([...ctx.getImageData(4, 4, 1, 1).data], expected, `${name} ${alpha}`)
      }
    }
  }
})

test('globalAlpha is rounded to 8 bits for patterns', (t) => {
  const source = createCanvas(8, 8)
  const sourceContext = source.getContext('2d')
  sourceContext.fillStyle = 'rgb(32, 128, 223)'
  sourceContext.fillRect(0, 0, 8, 8)
  for (const { alpha, expected } of [
    { alpha: 0.5, expected: 128 },
    { alpha: 0.3, expected: 77 },
    { alpha: 0.7, expected: 179 },
  ]) {
    for (const scale of [1, 2]) {
      const canvas = createCanvas(16, 16)
      const ctx = canvas.getContext('2d')
      ctx.scale(scale, scale)
      ctx.globalAlpha = alpha
      ctx.fillStyle = ctx.createPattern(source, 'repeat')!
      ctx.fillRect(0, 0, 16, 16)
      t.deepEqual(alphaSet(ctx, 0, 0, 16, 16), [expected], `fill scale ${scale} ${alpha}`)
    }
    const canvas = createCanvas(16, 16)
    const ctx = canvas.getContext('2d')
    ctx.scale(2, 2)
    ctx.globalAlpha = alpha
    ctx.strokeStyle = ctx.createPattern(source, 'repeat')!
    ctx.lineWidth = 2
    ctx.strokeRect(2, 2, 4, 4)
    t.deepEqual(alphaSet(ctx, 2, 2, 12, 4), [expected], `stroke scale 2 ${alpha}`)
    if (alpha === 0.5) {
      t.deepEqual([...ctx.getImageData(5, 4, 1, 1).data], [32, 128, 223, 128])
    }
  }
})

test('addColorStop rounds rgba alpha', (t) => {
  for (const { alpha, expected } of [
    { alpha: 0.25, expected: [32, 128, 223, 64] },
    { alpha: 0.5, expected: [32, 128, 223, 128] },
  ]) {
    const canvas = createCanvas(16, 4)
    const ctx = canvas.getContext('2d')
    const gradient = ctx.createLinearGradient(0, 0, 16, 0)
    gradient.addColorStop(0, `rgba(32, 128, 223, ${alpha})`)
    gradient.addColorStop(1, `rgba(32, 128, 223, ${alpha})`)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 16, 4)
    t.deepEqual([...ctx.getImageData(8, 2, 1, 1).data], expected, `${alpha}`)
  }
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
  t.is(ctx.fillStyle, '#000000')
  ctx.fillStyle = 'hotpink'
  t.is(ctx.fillStyle, 'hotpink')
})

test('strokeStyle state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.strokeStyle, '#000000')
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
