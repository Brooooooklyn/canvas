import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, loadImage, GlobalFonts, PDFDocument, SvgExportFlag } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Pixel-probe tests, deliberately not snapshots: every expected value below is
// derived from Chromium's own shadow algebra, so it cannot drift with font
// rendering or anti-aliasing the way a byte-compared PNG does.
//
// Chromium references used throughout:
//   sigma = shadowBlur * 0.5             blink/renderer/core/style/shadow_data.h:76-82
//   SrcIn colourise, blur only if sigma>0  cc/paint/draw_looper.cc:21-42
//   offsets are device-space             cc/paint/draw_looper.cc:37-40 (kPostTransformFlag)
//   looper XOR image filter, never both  canvas_rendering_context_2d_state.cc:849-868
//   drawImage hoists the filter above the dst clip
//                                        canvas_2d_recorder_context.cc:2118-2148

const px = (ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>, x: number, y: number) =>
  Array.from(ctx!.getImageData(x, y, 1, 1).data)

// Foreground at x 10..90, shadow band at x 130..210, probed dead centre at (170, 60).
function zeroBlurScene({
  globalAlpha = 1,
  shadowColor,
  fillStyle,
  shadowBlur = 0,
}: {
  globalAlpha?: number
  shadowColor: string
  fillStyle: string
  shadowBlur?: number
}) {
  const canvas = createCanvas(300, 120)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 300, 120)
  ctx.globalAlpha = globalAlpha
  ctx.shadowColor = shadowColor
  ctx.shadowBlur = shadowBlur
  ctx.shadowOffsetX = 120
  ctx.fillStyle = fillStyle
  ctx.fillRect(10, 20, 80, 80)
  return ctx
}

// ---------------------------------------------------------------- I2: zero blur

// shadow.a = shadowColor.a(1) * fillStyle.a(0.5) * globalAlpha(0.5) = 0.25
// over white -> 255 * (1 - 0.25) = 191.25 -> 192 after the premultiplied round trip.
test('shadow-zero-blur-preserves-globalAlpha-and-fillStyle-alpha', (t) => {
  const ctx = zeroBlurScene({ globalAlpha: 0.5, shadowColor: 'rgba(0, 0, 0, 1)', fillStyle: 'rgba(0, 0, 255, 0.5)' })
  t.deepEqual(px(ctx, 170, 60), [192, 192, 192, 255])
})

// shadow.a = 1 * 1 * 0.5 = 0.5; red over white -> R 255, G = B = 128.
test('shadow-zero-blur-globalAlpha-only', (t) => {
  const ctx = zeroBlurScene({ globalAlpha: 0.5, shadowColor: 'red', fillStyle: 'green' })
  t.deepEqual(px(ctx, 170, 60), [255, 128, 128, 255])
})

// shadow.a = 1 * 0.5 * 1 = 0.5 -> 255 * 0.5 = 128.
test('shadow-zero-blur-fillStyle-alpha-only', (t) => {
  const ctx = zeroBlurScene({ shadowColor: 'black', fillStyle: 'rgba(0, 0, 255, 0.5)' })
  t.deepEqual(px(ctx, 170, 60), [128, 128, 128, 255])
})

// GUARD. Already correct before the zero-blur rewrite (commit 2cd4e1a fixed the
// squaring); it must stay 0.5 and never regress to 0.25.
test('shadow-zero-blur-applies-shadowColor-alpha-exactly-once', (t) => {
  const ctx = zeroBlurScene({ shadowColor: 'rgba(0, 0, 0, 0.5)', fillStyle: 'green' })
  t.deepEqual(px(ctx, 170, 60), [128, 128, 128, 255])
})

// GUARD. The same alpha algebra must hold with a blur, i.e. zero blur is not a
// special case -- it is the sigma-0 degenerate of the one code path.
test('shadow-blur-and-zero-blur-agree-on-the-alpha-algebra', (t) => {
  const ctx = zeroBlurScene({
    globalAlpha: 0.5,
    shadowColor: 'rgba(0, 0, 0, 1)',
    fillStyle: 'rgba(0, 0, 255, 0.5)',
    shadowBlur: 4,
  })
  t.deepEqual(px(ctx, 170, 60), [192, 192, 192, 255])
})

function gradientScene(globalAlpha: number) {
  const canvas = createCanvas(300, 100)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 300, 100)
  const gradient = ctx.createLinearGradient(0, 0, 100, 0)
  gradient.addColorStop(0, 'red')
  gradient.addColorStop(1, 'blue')
  ctx.globalAlpha = globalAlpha
  ctx.fillStyle = gradient
  ctx.shadowColor = 'rgb(0, 255, 0)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 150
  ctx.fillRect(0, 20, 100, 40)
  return ctx
}

// SrcIn discards the source RGB wholesale, shader included
// (SkBlendModeColorFilter.cpp:71-79), so the shadow is flat green -- not the
// displaced copy of the gradient that `SkPaint::setColor` used to leave behind.
test('shadow-zero-blur-gradient-uses-shadowColor-not-the-gradient', (t) => {
  const ctx = gradientScene(1)
  t.deepEqual(px(ctx, 160, 40), [0, 255, 0, 255])
  t.deepEqual(px(ctx, 240, 40), [0, 255, 0, 255])
})

test('shadow-zero-blur-gradient-with-globalAlpha', (t) => {
  const ctx = gradientScene(0.5)
  t.deepEqual(px(ctx, 160, 40), [128, 255, 128, 255])
  t.deepEqual(px(ctx, 240, 40), [128, 255, 128, 255])
})

// Proves the image filter reaches the text path too.
test('shadow-zero-blur-gradient-text-uses-shadowColor', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  const canvas = createCanvas(400, 200)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 400, 200)
  const gradient = ctx.createLinearGradient(20, 0, 120, 0)
  gradient.addColorStop(0, 'red')
  gradient.addColorStop(1, 'blue')
  ctx.font = '90px Iosevka Slab'
  ctx.fillStyle = gradient
  ctx.shadowColor = 'rgb(0, 255, 0)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 150
  ctx.fillText('I', 20, 120)

  // Most saturated pixel in the shadow band must be pure green at full coverage.
  const data = ctx.getImageData(150, 20, 110, 120).data
  let best = [255, 255, 255, 255]
  let bestSaturation = -1
  for (let i = 0; i < data.length; i += 4) {
    const saturation = 255 - Math.min(data[i], data[i + 1], data[i + 2])
    if (saturation > bestSaturation) {
      bestSaturation = saturation
      best = [data[i], data[i + 1], data[i + 2], data[i + 3]]
    }
  }
  t.deepEqual(best, [0, 255, 0, 255])
})

// The offset is a device-space translate (kPostTransformFlag), so a 2x/0.5x CTM
// must not stretch it. Device rect x 10..50, shadow x 50..90.
test('shadow-zero-blur-offset-is-device-space-under-non-uniform-scale', (t) => {
  const canvas = createCanvas(300, 120)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 300, 120)
  ctx.scale(2, 0.5)
  ctx.shadowColor = 'rgba(0, 0, 0, 1)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 40
  ctx.fillStyle = 'green'
  ctx.fillRect(5, 40, 20, 80)
  t.deepEqual(px(ctx, 70, 40), [0, 0, 0, 255])

  // A degenerate CTM makes the sigma conversion divide 0 by 0; the short circuit
  // in `shadow_only_image_filter` exists so that this stays inert, not NaN.
  t.notThrows(() => {
    ctx.setTransform(0, 0, 0, 0, 0, 0)
    ctx.fillRect(5, 40, 20, 80)
  })
})

// ---------------------------------------------------------------- I3: one Gaussian

// Shape right edge is device x=100, shadow right edge device x=300. A step blurred
// at sigma=10 gives 255*Phi(-(x+0.5-300)/10) = 248/211/122/37/5; Skia's box
// approximation of that kernel measures 251/213/122/36/3.
// Two stacked Gaussians (sigma 10*sqrt(2)) would read 235/192/124/59/18.
const SIGMA_10_PROFILE: [number, number][] = [
  [280, 251],
  [290, 213],
  [300, 122],
  [310, 36],
  [320, 3],
]

function geometryShadowScene() {
  const canvas = createCanvas(400, 100)
  const ctx = canvas.getContext('2d')!
  ctx.shadowColor = 'black'
  ctx.shadowBlur = 20
  ctx.shadowOffsetX = 200
  ctx.fillStyle = 'red'
  ctx.fillRect(-100, -50, 200, 200)
  return ctx
}

test('shadow-blur-sigma-is-half-the-blur-radius', (t) => {
  const data = geometryShadowScene().getImageData(0, 0, 400, 100).data
  for (const [x, expected] of SIGMA_10_PROFILE) {
    const alpha = data[(50 * 400 + x) * 4 + 3]
    t.true(Math.abs(alpha - expected) <= 4, `alpha at x=${x} was ${alpha}, expected ${expected} +/- 4`)
  }
})

// The statement of the defect itself: geometry and images must convolve at the
// same sigma. Must use a decoded Image, not a Canvas -- a Canvas source takes the
// `is_canvas` branch (skia-c/skia_c.cpp:403) rather than plain drawImageRect.
test('shadow-blur-geometry-matches-image', async (t) => {
  const source = createCanvas(200, 200)
  const sourceCtx = source.getContext('2d')!
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(0, 0, 200, 200)
  const image = await loadImage(source.toBuffer('image/png'))

  const canvas = createCanvas(400, 100)
  const ctx = canvas.getContext('2d')!
  ctx.shadowColor = 'black'
  ctx.shadowBlur = 20
  ctx.shadowOffsetX = 200
  ctx.drawImage(image, -100, -50)

  const imageAlpha = ctx.getImageData(0, 0, 400, 100).data
  const geometryAlpha = geometryShadowScene().getImageData(0, 0, 400, 100).data
  let maxDelta = 0
  let maxDeltaX = -1
  for (let x = 250; x < 400; x++) {
    const i = (50 * 400 + x) * 4 + 3
    const delta = Math.abs(geometryAlpha[i] - imageAlpha[i])
    if (delta > maxDelta) {
      maxDelta = delta
      maxDeltaX = x
    }
  }
  t.true(maxDelta <= 4, `geometry and image shadows differ by ${maxDelta} at x=${maxDeltaX}`)
})

// Shadows are not affected by the CTM (canvas_2d_recorder_context.cc:1161-1165).
// Every quarter turn maps the square onto the same device box, and the sigma is
// unmapped through the CTM's column norms, so all four must share one profile.
// Using the raw `transform.a` instead sends rotate(90deg) to sigma=+inf and
// rotate(180deg) to a negative sigma, both of which silently drop the blur.
test('shadow-blur-sigma-is-rotation-invariant', (t) => {
  for (const theta of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    const canvas = createCanvas(600, 300)
    const ctx = canvas.getContext('2d')!
    ctx.translate(150, 150)
    ctx.rotate(theta)
    ctx.shadowColor = 'black'
    ctx.shadowBlur = 20
    ctx.shadowOffsetX = 200
    ctx.fillStyle = 'red'
    ctx.fillRect(-40, -40, 80, 80)
    const data = ctx.getImageData(0, 0, 600, 300).data
    // Device box is [110,190]^2 for every theta, so the shadow edge is x=390.
    for (const [x, expected] of SIGMA_10_PROFILE.slice(1)) {
      const alpha = data[(150 * 600 + (x + 90)) * 4 + 3]
      t.true(
        Math.abs(alpha - expected) <= 4,
        `theta=${theta}: alpha at x=${x + 90} was ${alpha}, expected ${expected} +/- 4`,
      )
    }
  }
})

// ---------------------------------------------------------------- I4: halo vs dst clip

function canvasSourceScene({
  background,
  shadowBlur,
  offset,
  globalAlpha = 1,
  useDrawCanvas,
}: {
  background: string | null
  shadowBlur: number
  offset: number
  globalAlpha?: number
  useDrawCanvas: boolean
}) {
  const source = createCanvas(100, 100)
  const sourceCtx = source.getContext('2d')!
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(0, 0, 100, 100)

  const canvas = createCanvas(400, 400)
  const ctx = canvas.getContext('2d')!
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, 400, 400)
  }
  ctx.globalAlpha = globalAlpha
  ctx.shadowColor = '#000'
  ctx.shadowBlur = shadowBlur
  ctx.shadowOffsetX = offset
  ctx.shadowOffsetY = offset
  if (useDrawCanvas) {
    ctx.drawCanvas(source, 100, 100, 100, 100)
  } else {
    ctx.drawImage(source, 100, 100, 100, 100)
  }
  return ctx
}

for (const useDrawCanvas of [false, true]) {
  const api = useDrawCanvas ? 'drawCanvas' : 'drawImage'

  // Foreground [100,200]^2, shadow [120,220]^2. shadowAlpha = 1 * 1 * 0.5 = 0.5,
  // over white -> 127. A double-applied globalAlpha (the isolation-layer defect)
  // would give 191 instead.
  test(`shadow-offset-escapes-the-destination-rect-${api}`, (t) => {
    const ctx = canvasSourceScene({ background: 'white', shadowBlur: 0, offset: 20, globalAlpha: 0.5, useDrawCanvas })
    t.deepEqual(px(ctx, 215, 215), [127, 127, 127, 255])
    // Unchanged regions.
    t.deepEqual(px(ctx, 150, 150), [191, 63, 63, 255])
    t.deepEqual(px(ctx, 110, 110), [255, 126, 126, 255])
    t.deepEqual(px(ctx, 230, 230), [255, 255, 255, 255])
  })

  // sigma = 20 * 0.5 = 10; the halo reaches ~3 sigma past the dst rect.
  test(`shadow-blur-halo-escapes-the-destination-rect-${api}`, (t) => {
    const ctx = canvasSourceScene({ background: null, shadowBlur: 20, offset: 10, useDrawCanvas })
    const data = ctx.getImageData(0, 0, 400, 400).data
    const alphaAt = (x: number, y: number) => data[(y * 400 + x) * 4 + 3]
    for (const [x, y, expected, tolerance] of [
      [205, 150, 172, 8],
      [215, 150, 74, 8],
      [225, 150, 14, 6],
      [95, 150, 17, 6],
      [150, 205, 172, 8],
    ]) {
      const alpha = alphaAt(x, y)
      t.true(
        Math.abs(alpha - expected) <= tolerance,
        `alpha at (${x},${y}) was ${alpha}, expected ${expected} +/- ${tolerance}`,
      )
    }
    t.deepEqual(px(ctx, 150, 150), [255, 0, 0, 255])

    // The sharpest signature of the defect: the bbox used to be exactly the dst
    // rect [100,100,199,199]. The unclipped reference is [86,86,233,233].
    let minX = 400
    let minY = 400
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < 400; y++) {
      for (let x = 0; x < 400; x++) {
        if (alphaAt(x, y) !== 0) {
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
    }
    t.true(minX <= 90 && minY <= 90, `shadow bbox top-left ${minX},${minY} did not escape the destination rect`)
    t.true(maxX >= 228 && maxY >= 228, `shadow bbox bottom-right ${maxX},${maxY} did not escape the destination rect`)
  })

  // Colour anchors, not just alpha.
  test(`shadow-blur-halo-colour-over-white-${api}`, (t) => {
    const ctx = canvasSourceScene({ background: 'white', shadowBlur: 20, offset: 10, useDrawCanvas })
    for (const [x, expected] of [
      [205, 83],
      [215, 181],
      [225, 241],
      [95, 238],
    ]) {
      const [r, g, b] = px(ctx, x, 150)
      t.true(
        Math.abs(r - expected) <= 4 && r === g && g === b,
        `pixel at (${x},150) was ${r},${g},${b}, expected ${expected} grey +/- 4`,
      )
    }
  })
}

// The strongest invariant: a decoded Image, a Canvas passed to drawImage and the
// same Canvas passed to drawCanvas must all produce the identical shadow. The
// raster path already went through SkCanvas's own filter-bounds logic, which is
// what the other two now match.
test('shadow-blur-halo-is-identical-for-Image-Canvas-and-drawCanvas', async (t) => {
  const source = createCanvas(100, 100)
  const sourceCtx = source.getContext('2d')!
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(0, 0, 100, 100)
  const image = await loadImage(source.toBuffer('image/png'))

  const render = (draw: (ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void) => {
    const canvas = createCanvas(400, 400)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, 400, 400)
    ctx.shadowColor = '#000'
    ctx.shadowBlur = 20
    ctx.shadowOffsetX = 10
    ctx.shadowOffsetY = 10
    draw(ctx)
    return ctx.getImageData(0, 0, 400, 400).data
  }
  const fromImage = render((ctx) => ctx!.drawImage(image, 100, 100, 100, 100))
  const fromCanvas = render((ctx) => ctx!.drawImage(source, 100, 100, 100, 100))
  const fromDrawCanvas = render((ctx) => ctx!.drawCanvas(source, 100, 100, 100, 100))

  const maxDelta = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    let max = 0
    for (let i = 0; i < a.length; i++) {
      const delta = Math.abs(a[i] - b[i])
      if (delta > max) max = delta
    }
    return max
  }
  t.true(maxDelta(fromImage, fromCanvas) <= 2, 'drawImage(<Image>) and drawImage(<Canvas>) disagree')
  t.true(maxDelta(fromImage, fromDrawCanvas) <= 2, 'drawImage(<Image>) and drawCanvas() disagree')
})

// The recorded saveLayer's bounds must be outset by the filter, or the page
// recorder's bounding-box hierarchy culls the halo away on encode.
test('shadow-blur-halo-survives-the-png-round-trip', async (t) => {
  const ctx = canvasSourceScene({ background: null, shadowBlur: 20, offset: 10, useDrawCanvas: false })
  const decoded = await loadImage(ctx.canvas.toBuffer('image/png'))
  const canvas = createCanvas(400, 400)
  const roundTripped = canvas.getContext('2d')!
  roundTripped.drawImage(decoded, 0, 0)
  const data = roundTripped.getImageData(0, 0, 400, 400).data
  t.true(Math.abs(data[(150 * 400 + 215) * 4 + 3] - 74) <= 8)
  t.true(Math.abs(data[(150 * 400 + 95) * 4 + 3] - 17) <= 6)
})

// ---------------------------------------------------------------- setter validation

// Blink discards a non-finite or negative shadowBlur and keeps the previous value
// (canvas_2d_recorder_context.cc:1202-1207); offsets reject only non-finite
// (:1170-1179, :1186-1195) because a negative offset is meaningful.
test('shadow-setters-discard-invalid-assignments', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')!

  ctx.shadowBlur = 7
  ctx.shadowBlur = -5
  t.is(ctx.shadowBlur, 7)
  ctx.shadowBlur = NaN
  t.is(ctx.shadowBlur, 7)
  ctx.shadowBlur = Infinity
  t.is(ctx.shadowBlur, 7)
  ctx.shadowBlur = 0
  t.is(ctx.shadowBlur, 0)

  ctx.shadowOffsetX = 12
  ctx.shadowOffsetX = NaN
  t.is(ctx.shadowOffsetX, 12)
  ctx.shadowOffsetX = -3
  t.is(ctx.shadowOffsetX, -3)

  ctx.shadowOffsetY = 9
  ctx.shadowOffsetY = -Infinity
  t.is(ctx.shadowOffsetY, 9)
})

// ---------------------------------------------------------------- zero blur is layer-free

// A zero-blur shadow is colourised by an `SkColorFilters::Blend(shadowColor,
// kSrcIn)` and nothing else, exactly as Chromium's looper does when
// `blur_sigma == 0` (cc/paint/draw_looper.cc:28-42). Routing it through an
// SkImageFilter instead is observable three ways, and all three are asserted
// below: the vector backends cannot express an image filter, and the implicit
// saveLayer applies an antialiased clip twice.

function svgShadowScene(draw: (ctx: any) => void) {
  const canvas = createCanvas(240, 200, SvgExportFlag.NoPrettyXML)
  const ctx = canvas.getContext('2d')!
  ctx.shadowColor = 'rgba(0, 0, 255, 1)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 15
  ctx.shadowOffsetY = 15
  draw(ctx)
  return canvas.getContent().toString('utf8')
}

test('shadow-zero-blur-is-emitted-by-the-svg-backend', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  const cases: [string, RegExp, (ctx: any) => void][] = [
    [
      'fillRect',
      /<rect /g,
      (ctx) => {
        ctx.fillStyle = 'red'
        ctx.fillRect(30, 30, 80, 60)
      },
    ],
    [
      'strokeRect',
      /<rect /g,
      (ctx) => {
        ctx.strokeStyle = 'red'
        ctx.lineWidth = 4
        ctx.strokeRect(30, 30, 80, 60)
      },
    ],
    [
      'fillText',
      /<text /g,
      (ctx) => {
        ctx.fillStyle = 'red'
        ctx.font = '30px Iosevka Slab'
        ctx.fillText('Hi', 30, 80)
      },
    ],
    [
      'fill(path)',
      /<path /g,
      (ctx) => {
        ctx.fillStyle = 'red'
        ctx.beginPath()
        ctx.arc(70, 70, 30, 0, Math.PI * 2)
        ctx.fill()
      },
    ],
  ]
  for (const [name, element, draw] of cases) {
    const svg = svgShadowScene(draw)
    // one element for the shadow pass, one for the content pass
    t.is(svg.match(element)?.length, 2, `${name}: expected a shadow element and a content element`)
    t.true(svg.includes('transform="translate(15 15)"'), `${name}: the shadow pass carries the offset`)
    // SkSVGDevice only understands a kSrcIn colour filter, which it writes out
    // as feFlood + feComposite (skia/src/svg/SkSVGDevice.cpp:431-436, :472-505)
    t.true(svg.includes('flood-color="blue"'), `${name}: the shadow is colourised to shadowColor`)
  }
})

test('shadow-zero-blur-keeps-pdf-text-vector', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  const doc = new PDFDocument()
  const ctx = doc.beginPage(240, 200)
  ctx.shadowColor = 'rgba(0, 0, 255, 1)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 15
  ctx.shadowOffsetY = 15
  ctx.fillStyle = 'red'
  ctx.font = '30px Iosevka Slab'
  ctx.fillText('Hi', 30, 80)
  doc.endPage()
  const pdf = doc.close().toString('latin1')
  // An image filter forces SkPDFDevice onto a raster device
  // (skia/src/pdf/SkPDFDevice.cpp:305-315); a colour filter is folded into the
  // paint colour instead (:274-277) and the glyphs stay real text.
  t.false(/\/Subtype\s*\/Image/.test(pdf), 'the shadowed text must not be rasterised')
  t.true(/\/Type\s*\/Font/.test(pdf))
})

// The shadow pass must be exactly "the same draw, translated in device space,
// in shadowColor" -- no layer. A saveLayer would antialias the clip edge once
// inside the layer and once again when the layer is composited.
test('shadow-zero-blur-does-not-double-apply-an-antialiased-clip', (t) => {
  const render = (withShadow: boolean) => {
    const canvas = createCanvas(400, 400)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, 400, 400)
    ctx.translate(100, 100)
    ctx.rotate(0.5)
    ctx.beginPath()
    ctx.rect(-40, -40, 200, 200)
    ctx.clip()
    if (withShadow) {
      ctx.shadowColor = 'rgb(0, 0, 0)'
      ctx.shadowBlur = 0
      ctx.shadowOffsetX = 60
      ctx.fillStyle = 'red'
      ctx.fillRect(0, 0, 100, 100)
    } else {
      ctx.save()
      const m = ctx.getTransform()
      // the same device-space post-translate the shadow pass applies
      ctx.setTransform(1, 0, 0, 1, 60, 0)
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f)
      ctx.fillStyle = 'black'
      ctx.fillRect(0, 0, 100, 100)
      ctx.restore()
      ctx.fillStyle = 'red'
      ctx.fillRect(0, 0, 100, 100)
    }
    return ctx.getImageData(0, 0, 400, 400).data
  }
  const shadowed = render(true)
  const byHand = render(false)
  let differing = 0
  for (let i = 0; i < shadowed.length; i++) {
    if (shadowed[i] !== byHand[i]) differing++
  }
  t.is(differing, 0)
})

// `ctx.filter` is installed on the paint by fill_paint/stroke_paint. The
// zero-blur route must not overwrite it, so the shadow is filtered too --
// Blink composes `Compose(Compose(fg, shadow), canvas_filter)`
// (canvas_2d_recorder_context.h:931-934). grayscale(blue) = 0.0722 * 255 = 18.
test('shadow-zero-blur-keeps-ctx-filter', (t) => {
  const canvas = createCanvas(300, 200)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 300, 200)
  ctx.filter = 'grayscale(1)'
  ctx.shadowColor = 'rgba(0, 0, 255, 1)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 60
  ctx.fillStyle = 'red'
  ctx.fillRect(20, 20, 60, 100)
  t.deepEqual(px(ctx, 110, 70), [18, 18, 18, 255])
})
