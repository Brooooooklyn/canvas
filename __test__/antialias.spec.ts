import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, getTextRenderer, GlobalFonts, Path2D, setTextRenderer } from '../index'
import { createCanvas as createNodeCanvas } from '../node-canvas'

GlobalFonts.registerFromPath(
  join(fileURLToPath(new URL('.', import.meta.url)), 'fonts', 'Lato-Regular.ttf'),
  'AntialiasLato',
)

function uniqueColors(data: Uint8ClampedArray): Set<number> {
  const colors = new Set<number>()
  for (let i = 0; i < data.length; i += 4) {
    const rgba = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0
    colors.add(rgba)
  }
  return colors
}

function uniqueAlphas(data: Uint8ClampedArray): Set<number> {
  const alphas = new Set<number>()
  for (let i = 3; i < data.length; i += 4) {
    alphas.add(data[i])
  }
  return alphas
}

test('ctx.antialias getter/setter, defaults, invalid values, and WebIDL coercion', (t) => {
  const canvas = createCanvas(16, 16)
  const ctx = canvas.getContext('2d')

  t.is(ctx.antialias, 'default')

  for (const mode of ['none', 'gray', 'subpixel', 'default'] as const) {
    ctx.antialias = mode
    t.is(ctx.antialias, mode)
  }

  ctx.antialias = 'none'
  for (const invalid of ['invalid', 'NONE', 'Default', 'Gray', 'Subpixel', '', ' none', 1, null, undefined]) {
    ;(ctx as any).antialias = invalid
    t.is(ctx.antialias as string, 'none', `invalid value ${String(invalid)} should be ignored`)
  }

  // WebIDL DOMString conversion runs toString() on objects and rejects Symbol
  ctx.antialias = 'default'
  ;(ctx as any).antialias = { toString: () => 'none' }
  t.is(ctx.antialias as string, 'none')

  t.throws(
    () => {
      ;(ctx as any).antialias = Symbol('x')
    },
    { instanceOf: TypeError },
  )
  t.is(ctx.antialias as string, 'none')
})

test('ctx.antialias participates in save(), restore(), and reset()', (t) => {
  const canvas = createCanvas(20, 20)
  const ctx = canvas.getContext('2d')

  t.is(ctx.antialias, 'default')
  ctx.save()
  ctx.antialias = 'none'
  t.is(ctx.antialias, 'none')

  ctx.save()
  ctx.antialias = 'subpixel'
  t.is(ctx.antialias, 'subpixel')

  ctx.restore()
  t.is(ctx.antialias as string, 'none')

  // Verify paint AA flag is also disabled after restoring to 'none'
  ctx.fillStyle = '#000001'
  ctx.fillRect(0, 0, 20, 20)
  ctx.fillStyle = '#00012c'
  ctx.beginPath()
  ctx.arc(8.3, 8.3, 5.2, 0, Math.PI * 2)
  ctx.fill()
  t.is(uniqueColors(ctx.getImageData(0, 0, 20, 20).data).size, 2)

  ctx.restore()
  t.is(ctx.antialias as string, 'default')

  // Verify paint AA flag is re-enabled after restoring to 'default'
  ctx.fillStyle = '#000001'
  ctx.fillRect(0, 0, 20, 20)
  ctx.fillStyle = '#00012c'
  ctx.beginPath()
  ctx.arc(8.3, 8.3, 5.2, 0, Math.PI * 2)
  ctx.fill()
  t.true(uniqueColors(ctx.getImageData(0, 0, 20, 20).data).size > 2)

  // Verify reset() restores both the property and paint AA flag to 'default'
  ctx.antialias = 'none'
  ctx.reset()
  t.is(ctx.antialias as string, 'default')
  ctx.fillStyle = '#000001'
  ctx.fillRect(0, 0, 20, 20)
  ctx.fillStyle = '#00012c'
  ctx.beginPath()
  ctx.arc(8.3, 8.3, 5.2, 0, Math.PI * 2)
  ctx.fill()
  t.true(uniqueColors(ctx.getImageData(0, 0, 20, 20).data).size > 2)
})

test('issue #1458: fractional arc has strictly 2 unique colors with antialias = "none"', (t) => {
  const renderArc = (mode: 'default' | 'none' | 'gray' | 'subpixel') => {
    const canvas = createCanvas(20, 20)
    const ctx = canvas.getContext('2d')
    ctx.antialias = mode
    ctx.fillStyle = '#000001'
    ctx.fillRect(0, 0, 20, 20)
    ctx.fillStyle = '#00012c'
    ctx.beginPath()
    ctx.arc(8.3, 8.3, 5.2, 0, Math.PI * 2)
    ctx.fill()
    return uniqueColors(ctx.getImageData(0, 0, 20, 20).data).size
  }

  t.is(renderArc('none'), 2)
  t.true(renderArc('default') > 2)
  t.true(renderArc('gray') > 2)
  t.true(renderArc('subpixel') > 2)
})

test('hard-edged strokes, rotated rects, bezier curves, roundRect, and gradient fills under "none"', (t) => {
  const shapes: Array<[string, (ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void]> = [
    [
      'diagonal stroke',
      (ctx) => {
        ctx.strokeStyle = '#ff0000'
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.moveTo(2.3, 3.7)
        ctx.lineTo(37.4, 35.1)
        ctx.stroke()
      },
    ],
    [
      'rotated rect',
      (ctx) => {
        ctx.fillStyle = '#00ff00'
        ctx.translate(20, 20)
        ctx.rotate(0.45)
        ctx.fillRect(-10, -8, 20, 16)
      },
    ],
    [
      'bezier curve',
      (ctx) => {
        ctx.strokeStyle = '#0000ff'
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.moveTo(3, 35)
        ctx.bezierCurveTo(10, 2, 30, 38, 37, 5)
        ctx.stroke()
      },
    ],
    [
      'roundRect',
      (ctx) => {
        ctx.fillStyle = '#ff00ff'
        ctx.beginPath()
        ctx.roundRect(4.4, 4.6, 30.2, 28.8, 7.5)
        ctx.fill()
      },
    ],
    [
      'gradient fill',
      (ctx) => {
        const grad = ctx.createLinearGradient(0, 0, 40, 40)
        grad.addColorStop(0, '#ff0000')
        grad.addColorStop(1, '#0000ff')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(20.3, 20.7, 14.2, 0, Math.PI * 2)
        ctx.fill()
      },
    ],
  ]

  for (const [name, draw] of shapes) {
    const cNone = createCanvas(40, 40)
    const ctxNone = cNone.getContext('2d')
    ctxNone.antialias = 'none'
    draw(ctxNone)
    const alphasNone = uniqueAlphas(ctxNone.getImageData(0, 0, 40, 40).data)
    t.deepEqual(
      Array.from(alphasNone).sort((a, b) => a - b),
      [0, 255],
      `${name} under "none" should have binary alpha`,
    )

    const cDefault = createCanvas(40, 40)
    const ctxDefault = cDefault.getContext('2d')
    draw(ctxDefault)
    const alphasDefault = uniqueAlphas(ctxDefault.getImageData(0, 0, 40, 40).data)
    t.true(alphasDefault.size > 2, `${name} under "default" should have antialiased alpha`)
  }
})

test('hard-edged clips (current path and Path2D) and PageRecorder replay preserve recorded AA', (t) => {
  // 1. Fractional/rotated clip under 'none' produces strictly 2 colors
  const renderClipped = (mode: 'default' | 'none', usePath2D: boolean, midFrameFlush: boolean) => {
    const canvas = createCanvas(32, 32)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#000001'
    ctx.fillRect(0, 0, 32, 32)
    ctx.antialias = mode
    ctx.translate(16.3, 16.7)
    ctx.rotate(0.5)
    if (usePath2D) {
      const p = new Path2D()
      p.arc(0, 0, 9.4, 0, Math.PI * 2)
      ctx.clip(p)
    } else {
      ctx.beginPath()
      ctx.arc(0, 0, 9.4, 0, Math.PI * 2)
      ctx.clip()
    }
    if (midFrameFlush) {
      // Forces PageRecorder::promote_layer + resume_recording
      ctx.getImageData(0, 0, 1, 1)
    }
    ctx.resetTransform()
    ctx.fillStyle = '#00012c'
    ctx.fillRect(0, 0, 32, 32)
    return ctx.getImageData(0, 0, 32, 32).data
  }

  for (const usePath2D of [false, true]) {
    const noneDirect = renderClipped('none', usePath2D, false)
    const noneFlushed = renderClipped('none', usePath2D, true)
    const defaultDirect = renderClipped('default', usePath2D, false)

    t.is(uniqueColors(noneDirect).size, 2, `usePath2D=${usePath2D} under "none"`)
    t.deepEqual(noneFlushed, noneDirect, `usePath2D=${usePath2D} mid-frame getImageData matches byte-for-byte`)
    t.true(uniqueColors(defaultDirect).size > 2, `usePath2D=${usePath2D} under "default"`)
  }

  // 2. Toggling ctx.antialias = 'default' AFTER ctx.clip() + mid-frame getImageData()
  //    must still replay the clip with its recorded aa = false.
  const canvas = createCanvas(32, 32)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000001'
  ctx.fillRect(0, 0, 32, 32)

  ctx.antialias = 'none'
  ctx.beginPath()
  ctx.arc(16.3, 16.7, 9.4, 0, Math.PI * 2)
  ctx.clip()

  ctx.antialias = 'default'
  // Trigger PageRecorder replay while ctx.antialias is now 'default'
  ctx.getImageData(0, 0, 1, 1)

  // Fill whole canvas (integer rect, so only the clip boundary can introduce blended colors)
  ctx.fillStyle = '#00012c'
  ctx.fillRect(0, 0, 32, 32)

  t.is(uniqueColors(ctx.getImageData(0, 0, 32, 32).data).size, 2)
})

test('drawImage and drawCanvas under "none" produce hard-edged borders without blending', (t) => {
  // Source canvas with default AA (used for drawImage and cropped drawCanvas)
  const srcDefault = createCanvas(16, 16)
  const sdctx = srcDefault.getContext('2d')
  sdctx.fillStyle = '#00012c'
  sdctx.fillRect(0, 0, 16, 16)

  // Source canvas recorded with antialias = 'none' (vector replay keeps source op AA)
  const srcAliased = createCanvas(16, 16)
  const sactx = srcAliased.getContext('2d')
  sactx.antialias = 'none'
  sactx.fillStyle = '#00012c'
  sactx.fillRect(0, 0, 16, 16)

  // Source canvas with non-source-over op to exercise drawCanvas isolate=true path
  const srcIsolated = createCanvas(16, 16)
  const sictx = srcIsolated.getContext('2d')
  sictx.antialias = 'none'
  sictx.fillStyle = '#00012c'
  sictx.fillRect(0, 0, 16, 16)
  sictx.clearRect(4, 4, 4, 4)
  sictx.fillStyle = '#00012c'
  sictx.fillRect(4, 4, 4, 4)

  const renderDraw = (
    method: 'drawImage' | 'drawCanvasDefault' | 'drawCanvasCropped' | 'drawCanvasAliased' | 'drawCanvasIsolated',
    mode: 'default' | 'none',
  ) => {
    const dst = createCanvas(40, 40)
    const dctx = dst.getContext('2d')
    dctx.fillStyle = '#000001'
    dctx.fillRect(0, 0, 40, 40)
    dctx.imageSmoothingEnabled = false
    dctx.antialias = mode
    dctx.translate(20.3, 20.7)
    dctx.rotate(0.4)
    if (method === 'drawImage') {
      dctx.drawImage(srcDefault, -8, -8, 16, 16)
    } else if (method === 'drawCanvasDefault') {
      // Uncropped drawCanvas from a default-AA source must also respect destination antialias = 'none'
      dctx.drawCanvas(srcDefault, -8, -8, 16, 16)
    } else if (method === 'drawCanvasCropped') {
      // Interior crop: the boundary comes solely from skiac_canvas_draw_picture_rect's clipRect
      dctx.drawCanvas(srcDefault, 2, 2, 12, 12, -6, -6, 12, 12)
    } else if (method === 'drawCanvasAliased') {
      dctx.drawCanvas(srcAliased, -8, -8, 16, 16)
    } else {
      dctx.drawCanvas(srcIsolated, -8, -8, 16, 16)
    }
    return uniqueColors(dctx.getImageData(0, 0, 40, 40).data).size
  }

  for (const method of [
    'drawImage',
    'drawCanvasDefault',
    'drawCanvasCropped',
    'drawCanvasAliased',
    'drawCanvasIsolated',
  ] as const) {
    t.is(renderDraw(method, 'none'), 2, `${method} under "none" should have strictly 2 colors`)
    t.true(renderDraw(method, 'default') > 2, `${method} under "default" should have >2 colors`)
  }

  // Opaque source canvas shadow rect under drawCanvas also respects ctx.antialias = 'none'
  const opaqueSrc = createCanvas(16, 16)
  const octx = opaqueSrc.getContext('2d', { alpha: false })
  octx.antialias = 'none'
  octx.fillStyle = '#00012c'
  octx.fillRect(0, 0, 16, 16)

  const renderOpaqueShadow = (mode: 'default' | 'none') => {
    const dst = createCanvas(48, 48)
    const dctx = dst.getContext('2d')
    dctx.fillStyle = '#000001'
    dctx.fillRect(0, 0, 48, 48)
    dctx.antialias = mode
    dctx.shadowColor = '#ff0000'
    dctx.shadowOffsetX = 12
    dctx.shadowOffsetY = 12
    dctx.translate(16.3, 16.7)
    dctx.rotate(0.4)
    dctx.drawCanvas(opaqueSrc, -6, -6, 12, 12)
    return uniqueColors(dctx.getImageData(0, 0, 48, 48).data).size
  }

  t.is(renderOpaqueShadow('none'), 3, 'opaque drawCanvas shadow under "none" has only bg, shadow, and source colors')
  t.true(renderOpaqueShadow('default') > 3, 'opaque drawCanvas shadow under "default" has antialiased edge colors')
})

test.serial('fillText and strokeText under "none" produce hard edges and do not collide in text cache', (t) => {
  const prevRenderer = getTextRenderer()
  try {
    for (const renderer of ['portable', 'system'] as const) {
      setTextRenderer(renderer)

      const renderText = (
        op: 'fillText' | 'strokeText',
        mode: 'default' | 'none',
        textRendering: 'auto' | 'geometricPrecision' = 'auto',
      ) => {
        const canvas = createCanvas(120, 50)
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#000001'
        ctx.fillRect(0, 0, 120, 50)
        ctx.font = '28px AntialiasLato'
        ctx.textRendering = textRendering
        ctx.antialias = mode
        if (op === 'fillText') {
          ctx.fillStyle = '#ffffff'
          ctx.fillText('Hello', 10.3, 36.4)
        } else {
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 2
          ctx.strokeText('Hello', 10.3, 36.4)
        }
        return uniqueColors(ctx.getImageData(0, 0, 120, 50).data).size
      }

      // Alternating default -> none -> default on the exact same string + font
      // must not return stale cached text blobs.
      t.true(renderText('fillText', 'default') > 2, `${renderer} fillText default #1`)
      t.is(renderText('fillText', 'none'), 2, `${renderer} fillText none`)
      t.true(renderText('fillText', 'default') > 2, `${renderer} fillText default #2`)

      // Also verify geometricPrecision (which adds a blur mask filter on macOS system renderer)
      t.is(renderText('fillText', 'none', 'geometricPrecision'), 2, `${renderer} fillText none + geometricPrecision`)

      t.true(renderText('strokeText', 'default') > 2, `${renderer} strokeText default #1`)
      t.is(renderText('strokeText', 'none'), 2, `${renderer} strokeText none`)
      t.true(renderText('strokeText', 'default') > 2, `${renderer} strokeText default #2`)
    }
  } finally {
    setTextRenderer(prevRenderer)
  }
})

test.serial('measureText() layout and advances are invariant across ctx.antialias', (t) => {
  const prevRenderer = getTextRenderer()
  const sentence = 'The quick brown fox jumps over the lazy dog 0123456789'
  try {
    for (const renderer of ['portable', 'system'] as const) {
      setTextRenderer(renderer)
      for (const font of ['9px AntialiasLato', '28px AntialiasLato']) {
        const canvas = createCanvas(300, 60)
        const ctx = canvas.getContext('2d')
        ctx.font = font
        ctx.antialias = 'default'
        const baseline = ctx.measureText(sentence)
        for (const mode of ['none', 'gray', 'subpixel', 'default'] as const) {
          ctx.antialias = mode
          const m = ctx.measureText(sentence)
          t.is(m.width, baseline.width, `${renderer} ${font} width under "${mode}"`)
          t.is(
            m.actualBoundingBoxLeft,
            baseline.actualBoundingBoxLeft,
            `${renderer} ${font} actualBoundingBoxLeft under "${mode}"`,
          )
          t.is(
            m.actualBoundingBoxRight,
            baseline.actualBoundingBoxRight,
            `${renderer} ${font} actualBoundingBoxRight under "${mode}"`,
          )
          t.is(
            m.actualBoundingBoxAscent,
            baseline.actualBoundingBoxAscent,
            `${renderer} ${font} actualBoundingBoxAscent under "${mode}"`,
          )
          t.is(
            m.actualBoundingBoxDescent,
            baseline.actualBoundingBoxDescent,
            `${renderer} ${font} actualBoundingBoxDescent under "${mode}"`,
          )
        }
      }
    }
  } finally {
    setTextRenderer(prevRenderer)
  }
})

test('node-canvas compatibility entrypoint supports ctx.antialias', (t) => {
  const canvas = createNodeCanvas(20, 20)
  const ctx = canvas.getContext('2d')

  t.is(ctx.antialias, 'default')
  ctx.antialias = 'none'
  t.is(ctx.antialias, 'none')

  ctx.fillStyle = '#000001'
  ctx.fillRect(0, 0, 20, 20)
  ctx.fillStyle = '#00012c'
  ctx.beginPath()
  ctx.arc(8.3, 8.3, 5.2, 0, Math.PI * 2)
  ctx.fill()

  t.is(uniqueColors(ctx.getImageData(0, 0, 20, 20).data).size, 2)
})
