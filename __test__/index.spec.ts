import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import ava, { TestFn } from 'ava'

import { createCanvas, Path2D, Canvas, SKRSContext2D, DOMMatrix, loadImage, ImageData } from '../index'

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

// Expected values are Chrome 155's CPU canvas. getImageData() and
// createImageData() default to the context's color space; drawImage into an
// sRGB canvas reads the pixel back as sRGB.
test('display-p3 context uses a display-p3 backing surface', (t) => {
  const canvas = createCanvas(2, 2)
  const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' })
  ctx.fillStyle = 'rgb(32,128,223)'
  ctx.fillRect(0, 0, 1, 1)
  t.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [63, 126, 216, 255])
  t.deepEqual([...canvas.data().subarray(0, 4)], [63, 126, 216, 255])
  const srgb = createCanvas(2, 2).getContext('2d')
  srgb.drawImage(canvas, 0, 0)
  t.deepEqual([...srgb.getImageData(0, 0, 1, 1).data], [31, 128, 223, 255])
  ctx.putImageData(new ImageData(new Uint8ClampedArray([32, 128, 223, 255]), 1, 1, { colorSpace: 'display-p3' }), 0, 0)
  t.deepEqual([...canvas.data().subarray(0, 4)], [32, 128, 223, 255])
  // A later getContext returns the same context and ignores its attributes.
  t.is(canvas.getContext('2d', { colorSpace: 'srgb' }), ctx)
  t.deepEqual([...canvas.data().subarray(0, 4)], [32, 128, 223, 255])
  ctx.fillStyle = 'rgb(32,128,223)'
  ctx.fillRect(0, 0, 1, 1)
  t.deepEqual([...canvas.data().subarray(0, 4)], [63, 126, 216, 255])
  const red = ctx.createImageData(1, 1)
  red.data.set([255, 0, 0, 255])
  ctx.putImageData(red, 1, 1)
  t.deepEqual([...canvas.data().subarray(12, 16)], [255, 0, 0, 255])
})

test('display-p3 context preserves its color space after resize', (t) => {
  const canvas = createCanvas(2, 2)
  const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' })
  for (const dimension of ['width', 'height'] as const) {
    canvas[dimension] = 3
    t.is(canvas.getContext('2d'), ctx)
    ctx.fillStyle = 'rgb(32,128,223)'
    ctx.fillRect(0, 0, 1, 1)
    t.deepEqual([...canvas.data().subarray(0, 4)], [63, 126, 216, 255])
    t.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [63, 126, 216, 255])
  }
})

// Setting width or height resets the bitmap but keeps alpha:false
// (Chrome 155: alpha stays false and a half-transparent fill lands opaque).
test('alpha:false survives width/height changes', (t) => {
  for (const dimension of ['width', 'height'] as const) {
    const canvas = createCanvas(4, 4)
    const ctx = canvas.getContext('2d', { alpha: false })
    const base = [...ctx.getImageData(0, 0, 1, 1).data]
    canvas[dimension] = 8
    t.false(ctx.getContextAttributes().alpha)
    const pixels = canvas.width * canvas.height
    t.deepEqual([...ctx.getImageData(0, 0, canvas.width, canvas.height).data], Array(pixels).fill(base).flat())
    ctx.fillStyle = 'rgba(255,0,0,0.5)'
    ctx.fillRect(0, 0, 1, 1)
    t.is(ctx.getImageData(0, 0, 1, 1).data[3], 255)
  }
})

// GIF has no color profile, so the spec converts its pixels to sRGB. Chrome
// 155 gives 31,128,223 for this P3 pixel in sRGB (drawImage into an sRGB
// canvas, and the P3 PNG round trip). Our AVIF encoder writes no profile, so
// AVIF is converted too; it is lossy, so it is held to an sRGB canvas that
// holds the same pixels.
test('gif and avif output of a display-p3 canvas is converted to sRGB', async (t) => {
  const p3 = createCanvas(8, 8)
  const p3Context = p3.getContext('2d', { colorSpace: 'display-p3' })
  p3Context.fillStyle = 'rgb(32,128,223)'
  p3Context.fillRect(0, 0, 8, 8)
  const srgb = createCanvas(8, 8)
  srgb.getContext('2d').drawImage(p3, 0, 0)
  const decode = async (data: Buffer) => {
    const ctx = createCanvas(8, 8).getContext('2d')
    ctx.drawImage(await loadImage(data), 0, 0)
    return [...ctx.getImageData(4, 4, 1, 1).data]
  }
  const gif: [string, (canvas: Canvas) => Buffer][] = [
    ['toBuffer gif', (canvas) => canvas.toBuffer('image/gif')],
    ['encodeSync gif', (canvas) => canvas.encodeSync('gif')],
  ]
  for (const [name, encode] of gif) {
    t.deepEqual(await decode(encode(p3)), [31, 128, 223, 255], name)
  }
  const avif: [string, (canvas: Canvas) => Buffer][] = [
    ['toBuffer avif', (canvas) => canvas.toBuffer('image/avif')],
    ['encodeSync avif', (canvas) => canvas.encodeSync('avif')],
  ]
  for (const [name, encode] of avif) {
    t.deepEqual(await decode(encode(p3)), await decode(encode(srgb)), name)
  }
})

// drawCanvas has no Chrome counterpart, so it is held to drawImage: a P3
// gradient drawn into an sRGB canvas must give the same pixels either way.
test('drawCanvas of a display-p3 source matches drawImage', (t) => {
  const source = createCanvas(256, 1)
  const sourceContext = source.getContext('2d', { colorSpace: 'display-p3' })
  const gradient = sourceContext.createLinearGradient(0, 0, 256, 0)
  gradient.addColorStop(0, '#ff0000')
  gradient.addColorStop(1, '#0000ff')
  sourceContext.fillStyle = gradient
  sourceContext.fillRect(0, 0, 256, 1)
  const viaCanvas = createCanvas(256, 1).getContext('2d')
  viaCanvas.drawCanvas(source, 0, 0)
  const viaImage = createCanvas(256, 1).getContext('2d')
  viaImage.drawImage(source, 0, 0)
  t.deepEqual([...viaCanvas.getImageData(128, 0, 1, 1).data], [...viaImage.getImageData(128, 0, 1, 1).data])
})

// drawCanvas takes a picture replay into a destination in the same colour
// space and the source bitmap into another one. Both arms treat a negative
// size as drawImage does (Blink AdjustRectForCanvas): the origin moves, the
// image is not mirrored.
test('drawCanvas normalises negative sizes like drawImage', (t) => {
  // column i is rgb(i * 25, 0, 255 - i * 25)
  const source = createCanvas(10, 10)
  const sourceContext = source.getContext('2d')
  for (let i = 0; i < 10; i++) {
    sourceContext.fillStyle = `rgb(${i * 25},0,${255 - i * 25})`
    sourceContext.fillRect(i, 0, 1, 10)
  }
  const args: [number, number, number, number, number?, number?, number?, number?][] = [
    [30, 20, -10, 10],
    [30, 20, 10, -10],
    [0, 0, 10, 10, 30, 20, -10, -10],
    [10, 0, -10, 10, 30, 20, 10, 10],
    // past the f32 range: nothing is drawn
    [0, 0, 1e39, 10],
    [0, 0, -1e39, 10],
  ]
  for (const colorSpace of ['srgb', 'display-p3'] as const) {
    for (const a of args) {
      const viaCanvas = createCanvas(64, 64).getContext('2d', { colorSpace })
      // @ts-expect-error the 4- and 8-argument forms
      viaCanvas.drawCanvas(source, ...a)
      const viaImage = createCanvas(64, 64).getContext('2d', { colorSpace })
      // @ts-expect-error the 4- and 8-argument forms
      viaImage.drawImage(source, ...a)
      t.deepEqual(
        [...viaCanvas.getImageData(0, 0, 64, 64).data],
        [...viaImage.getImageData(0, 0, 64, 64).data],
        `${colorSpace} ${a.join(',')}`,
      )
    }
  }
  const ctx = createCanvas(64, 64).getContext('2d')
  ctx.drawCanvas(source, 30, 20, -10, 10)
  t.deepEqual([...ctx.getImageData(20, 25, 1, 1).data], [0, 0, 255, 255])
  t.deepEqual([...ctx.getImageData(29, 25, 1, 1).data], [225, 0, 30, 255])
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

const stripeCanvas = (size: number) => {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffffff']
  for (let x = 0; x < size; x++) {
    ctx.fillStyle = colors[x % 4]
    ctx.fillRect(x, 0, 1, size)
  }
  return canvas
}

const scaledPatternRow = (
  source: Parameters<SKRSContext2D['createPattern']>[0],
  scale: number,
  quality: SKRSContext2D['imageSmoothingQuality'],
) => {
  const ctx = createCanvas(4, 1).getContext('2d')
  ctx.imageSmoothingQuality = quality
  const pattern = ctx.createPattern(source, 'repeat')!
  pattern.setTransform(new DOMMatrix([scale, 0, 0, scale, 0, 0]))
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, 4, 1)
  return [...ctx.getImageData(0, 0, 4, 1).data]
}

// Expected values are Chrome 155's CPU canvas: a scaled-down canvas pattern
// blends two mip levels at 'medium' and 'high'.
test('downscaled canvas pattern blends two mip levels', (t) => {
  const source = stripeCanvas(4)
  for (const quality of ['medium', 'high'] as const) {
    t.deepEqual(
      scaledPatternRow(source, 0.4, quality),
      [116, 138, 26, 255, 150, 138, 165, 255, 104, 116, 165, 255, 138, 116, 26, 255],
      quality,
    )
  }
})

// Expected values are Chrome 155's CPU canvas: a scaled-down Image pattern
// samples a single mip level at 'medium' and 'high'.
test('downscaled image pattern samples one mip level', async (t) => {
  const source = await loadImage(stripeCanvas(8).toBuffer('image/png'))
  for (const quality of ['medium', 'high'] as const) {
    t.deepEqual(
      scaledPatternRow(source, 0.2, quality),
      [127, 127, 127, 255, 127, 127, 127, 255, 127, 127, 127, 255, 127, 127, 127, 255],
      quality,
    )
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
    const expected = mode === 'gradient' ? [32, 128, 221, 128] : [32, 128, 223, 128]
    t.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], expected, mode)
  }
})

for (const paint of ['fill', 'stroke'] as const) {
  test(`gradient ${paint} dithers translucent pixels without changing solid paints`, (t) => {
    // chrome 149 cpu canvas: constant stops still use gradient dithering.
    const expected = Array.from({ length: 16 }, (_, i) => [
      32,
      128,
      ((i % 4) + Math.floor(i / 4)) % 2 === 0 ? 221 : 223,
      128,
    ]).flat()
    for (const kind of ['linear', 'radial', 'conic']) {
      const ctx = createCanvas(4, 4).getContext('2d')
      const gradient =
        kind === 'linear'
          ? ctx.createLinearGradient(0, 0, 4, 0)
          : kind === 'radial'
            ? ctx.createRadialGradient(2, 2, 0, 2, 2, 4)
            : ctx.createConicGradient(0, 2, 2)
      gradient.addColorStop(0, 'rgb(32, 128, 223)')
      gradient.addColorStop(1, 'rgb(32, 128, 223)')
      ctx.globalAlpha = 0.5
      if (paint === 'fill') {
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, 4, 4)
      } else {
        ctx.strokeStyle = gradient
        ctx.lineWidth = 4
        ctx.beginPath()
        ctx.moveTo(0, 2)
        ctx.lineTo(4, 2)
        ctx.stroke()
      }
      t.deepEqual([...ctx.getImageData(0, 0, 4, 4).data], expected, kind)
      ctx.clearRect(0, 0, 4, 4)
      ctx.fillStyle = 'rgb(32, 128, 223)'
      ctx.fillRect(0, 0, 4, 4)
      t.deepEqual([...ctx.getImageData(0, 0, 4, 4).data], Array(16).fill([32, 128, 223, 128]).flat(), kind)
    }
  })
}

// drawImage does not use fillStyle, so a gradient fillStyle must not dither it.
// Chrome 155 CPU: every pixel [32, 128, 223, 128]. Scaled on purpose: a 1:1
// draw stays exact even with a dithered paint.
test('drawImage is not dithered by a gradient fillStyle', async (t) => {
  const source = createCanvas(8, 8)
  const sourceContext = source.getContext('2d')
  sourceContext.fillStyle = 'rgb(32, 128, 223)'
  sourceContext.fillRect(0, 0, 8, 8)
  const image = await loadImage(source.toBuffer('image/png'))
  for (const [name, src] of [
    ['image', image],
    ['canvas', source],
  ] as const) {
    const ctx = createCanvas(16, 16).getContext('2d')
    const gradient = ctx.createLinearGradient(0, 0, 8, 0)
    gradient.addColorStop(0, 'red')
    gradient.addColorStop(1, 'blue')
    ctx.fillStyle = gradient
    ctx.globalAlpha = 0.5
    ctx.drawImage(src, 0, 0, 16, 16)
    t.deepEqual([...ctx.getImageData(0, 0, 16, 16).data], Array(256).fill([32, 128, 223, 128]).flat(), name)
  }
})

// drawCanvas has no Chrome counterpart, so it is held to the drawImage rule:
// the fillStyle must not change its pixels. The rect is fractional on purpose:
// an integer 2x drawCanvas stays exact even with a dithered paint.
test('drawCanvas is not dithered by a gradient fillStyle', (t) => {
  const source = createCanvas(8, 8)
  const sourceContext = source.getContext('2d')
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      sourceContext.fillStyle = `rgb(${x * 30}, ${y * 30}, ${(x + y) * 15})`
      sourceContext.fillRect(x, y, 1, 1)
    }
  }
  const draw = (useGradient: boolean) => {
    const ctx = createCanvas(32, 32).getContext('2d')
    if (useGradient) {
      const gradient = ctx.createLinearGradient(0, 0, 32, 0)
      gradient.addColorStop(0, 'red')
      gradient.addColorStop(1, 'blue')
      ctx.fillStyle = gradient
    } else {
      ctx.fillStyle = 'rgb(9, 9, 9)'
    }
    ctx.globalAlpha = 0.5
    ctx.drawCanvas(source, 0.3, 0.6, 27, 27)
    return [...ctx.getImageData(0, 0, 32, 32).data]
  }
  t.deepEqual(draw(true), draw(false))
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

// Patterns keep the float globalAlpha (raster-precision.spec.ts); a 'repeat'
// pattern drawn src-over still lands on a byte, because Skia's legacy blitter
// rounds the paint alpha itself, as in Chrome's CPU canvas.
test("repeat pattern globalAlpha lands on a byte like Chrome's legacy blitter", (t) => {
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
