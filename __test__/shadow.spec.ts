import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test, { type ExecutionContext } from 'ava'

import { createCanvas, loadImage, GlobalFonts, PDFDocument, SvgExportFlag, type SKRSContext2D } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Pixel-probe tests, deliberately not snapshots: every expected value below is
// derived from Chromium's own shadow algebra, so it cannot drift with font
// rendering or anti-aliasing the way a byte-compared PNG does. The rules being
// pinned are sigma = shadowBlur * 0.5, kSrcIn colourisation with a blur only
// when sigma > 0, device-space offsets, and looper XOR image filter but never
// both (cc/paint/draw_looper.cc:21-42,
// canvas_rendering_context_2d_state.cc:849-868).

const px = (ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>, x: number, y: number) =>
  Array.from(ctx!.getImageData(x, y, 1, 1).data)

// Same as `px`, but for values on an exact .5 rounding tie, where the
// premultiplied round trip legitimately lands either side depending on the
// rasteriser (127.5 is 126 on aarch64-apple-darwin, 127 elsewhere). Asserting
// equality there pins a platform, not a behaviour; the defects these tests guard
// move the channel by 64 or more.
const pxNear = (
  t: ExecutionContext,
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  x: number,
  y: number,
  expected: number[],
  tolerance = 1,
) => {
  const actual = px(ctx, x, y)
  const ok = actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance)
  t.true(ok, `pixel (${x},${y}) was [${actual}], expected [${expected}] +/- ${tolerance}`)
}

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

// Pins that the STROKE arm of `ShadowSource::is_solid_color` (src/ctx.rs) reads
// `state.stroke_style` and not `state.fill_style`. No other shader-shadow test
// would notice: they all paint with `fillStyle`, so the wrong arm would read the
// default solid black, answer "yes", and fold under a shader -- leaving the
// "shadow" a displaced copy of the gradient.
function strokeShaderScene(makeStyle: (ctx: SKRSContext2D) => SKRSContext2D['strokeStyle']) {
  const canvas = createCanvas(300, 100)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 300, 100)
  ctx.strokeStyle = makeStyle(ctx)
  ctx.lineWidth = 20
  ctx.shadowColor = 'rgb(0, 255, 0)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 150
  ctx.strokeRect(20, 20, 60, 40)
  return ctx
}

test('shadow-zero-blur-gradient-STROKE-uses-shadowColor-not-the-gradient', (t) => {
  const ctx = strokeShaderScene((c) => {
    const gradient = c.createLinearGradient(0, 0, 100, 0)
    gradient.addColorStop(0, 'red')
    gradient.addColorStop(1, 'blue')
    return gradient
  })
  // Both ends of the shadowed stroke: flat shadowColor, no gradient ramp.
  t.deepEqual(px(ctx, 170, 40), [0, 255, 0, 255])
  t.deepEqual(px(ctx, 230, 40), [0, 255, 0, 255])
  // ...and the stroke itself still IS a gradient, so the fold has not leaked
  // onto the content pass.
  const left = px(ctx, 20, 40)
  const right = px(ctx, 80, 40)
  t.true(left[0] > right[0] && left[2] < right[2], `content is not a red->blue ramp: ${left} ${right}`)
})

test('shadow-zero-blur-pattern-STROKE-uses-shadowColor-not-the-pattern', (t) => {
  const tile = createCanvas(8, 8)
  const tileCtx = tile.getContext('2d')!
  tileCtx.fillStyle = 'rgb(255, 255, 0)'
  tileCtx.fillRect(0, 0, 8, 8)
  const ctx = strokeShaderScene((c) => c.createPattern(tile, 'repeat'))
  t.deepEqual(px(ctx, 170, 40), [0, 255, 0, 255])
  t.deepEqual(px(ctx, 230, 40), [0, 255, 0, 255])
  t.deepEqual(px(ctx, 20, 40), [255, 255, 0, 255])
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

// Shadow sigma is not affected by the CTM
// (canvas_2d_recorder_context.cc:1161-1165). Every quarter turn maps the square
// onto the same device box, so all four must share one edge profile.
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
    // 0.5 alpha over white is 127.5 -- an exact rounding tie, so these two probes
    // land on 126 or 127 depending on the rasteriser. See `pxNear`. The defect
    // each one guards is worth 64/255, far outside the +/-1 window.
    pxNear(t, ctx, 215, 215, [127, 127, 127, 255])
    // Unchanged regions.
    t.deepEqual(px(ctx, 150, 150), [191, 63, 63, 255])
    pxNear(t, ctx, 110, 110, [255, 127, 127, 255])
    t.deepEqual(px(ctx, 230, 230), [255, 255, 255, 255])
  })

  // Pins `skiac_canvas_draw_picture_rect`'s default-paint elision against a
  // shadow paint whose colour lives in a kSrcIn colour filter. The test above
  // cannot catch it: globalAlpha 0.5 stops the elision predicate firing.
  test(`shadow-zero-blur-uses-shadowColor-at-default-globalAlpha-${api}`, (t) => {
    const ctx = canvasSourceScene({ background: 'white', shadowBlur: 0, offset: 20, useDrawCanvas })
    // Shadow band only, clear of the red foreground: opaque black shadow.
    t.deepEqual(px(ctx, 215, 215), [0, 0, 0, 255])
    // The foreground is still the source colour.
    t.deepEqual(px(ctx, 110, 110), [255, 0, 0, 255])
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

    // With the filter under the dst clip the shadow's bbox is exactly the dst
    // rect plus the offset, [100,100,209,209]; unclipped it is [86,86,233,233].
    // Both bounds below are the midpoint, leaving ~7px of slack either way.
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
    t.true(minX <= 93 && minY <= 93, `shadow bbox top-left ${minX},${minY} (want <= 93, clipped is 100)`)
    t.true(maxX >= 221 && maxY >= 221, `shadow bbox bottom-right ${maxX},${maxY} (want >= 221, clipped is 209)`)
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
// kSrcIn)` and nothing else, as Chromium's looper does when `blur_sigma == 0`
// (cc/paint/draw_looper.cc:28-42). Routing it through an SkImageFilter instead
// is observable three ways, all asserted below.

// SVG_SHADOW_DX/DY are big enough that the shadow never overlaps the content on
// a 240x200 canvas, so a scene whose content is painted white on white renders
// the shadow and nothing else.
const SVG_SHADOW_DX = 100
const SVG_SHADOW_DY = 60

// Every shape is drawn by ONE function parameterised on colour, so the "shadow"
// render and the "what the shadow should look like" render cannot drift apart.
const SVG_SHADOW_SHAPES: [string, RegExp, (ctx: any, color: string) => void][] = [
  [
    'fillRect',
    /<rect /g,
    (ctx, color) => {
      ctx.fillStyle = color
      ctx.fillRect(30, 30, 80, 60)
    },
  ],
  [
    'strokeRect',
    /<rect /g,
    (ctx, color) => {
      ctx.strokeStyle = color
      ctx.lineWidth = 4
      ctx.strokeRect(30, 30, 80, 60)
    },
  ],
  [
    'fillText',
    /<text /g,
    (ctx, color) => {
      ctx.fillStyle = color
      ctx.font = '30px Iosevka Slab'
      ctx.fillText('Hi', 30, 60)
    },
  ],
  [
    'fill(path)',
    /<path /g,
    (ctx, color) => {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(70, 70, 30, 0, Math.PI * 2)
      ctx.fill()
    },
  ],
]

function svgScene(draw: (ctx: any) => void) {
  const canvas = createCanvas(240, 200, SvgExportFlag.NoPrettyXML)
  draw(canvas.getContext('2d')!)
  return canvas.getContent()
}

// Rasterise an SVG over an opaque white page, so a "shadow" that is really a
// translucent flood over the bounding box still shows up as different pixels.
async function rasterizeSvg(svg: Buffer) {
  const img = await loadImage(svg)
  const canvas = createCanvas(240, 200)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 240, 200)
  ctx.drawImage(img, 0, 0)
  return ctx.getImageData(0, 0, 240, 200).data
}

// Renders the SVG against an independent oracle rather than asserting on the
// markup alone: a shadow that renders as a solid rectangle over the shape's
// bounding box still emits exactly the right elements.
test('shadow-zero-blur-renders-the-shape-not-its-bounding-box-in-svg', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  for (const [name, element, draw] of SVG_SHADOW_SHAPES) {
    // The shadow, alone: content in white on a white page is invisible, and the
    // offset is large enough that it cannot cover the shadow.
    const shadowed = svgScene((ctx) => {
      ctx.shadowColor = 'blue'
      ctx.shadowBlur = 0
      ctx.shadowOffsetX = SVG_SHADOW_DX
      ctx.shadowOffsetY = SVG_SHADOW_DY
      draw(ctx, 'white')
    })
    // The oracle: the same shape, in the shadow colour, translated by the same
    // offset, with no shadow involved at all. A zero-blur shadow is defined to
    // be exactly this (cc/paint/draw_looper.cc:21-42).
    const oracle = svgScene((ctx) => {
      ctx.translate(SVG_SHADOW_DX, SVG_SHADOW_DY)
      draw(ctx, 'blue')
    })

    const rendered = await rasterizeSvg(shadowed)
    const expected = await rasterizeSvg(oracle)
    let differing = 0
    for (let i = 0; i < rendered.length; i += 4) {
      for (let c = 0; c < 4; c++) {
        if (rendered[i + c] !== expected[i + c]) {
          differing++
          break
        }
      }
    }
    t.is(differing, 0, `${name}: the rendered SVG shadow must be the shape, translated`)

    // Markup shape. Skia CAN serialise the kSrcIn colour filter, but it writes
    // an feFlood plus an feComposite with no `in2`
    // (skia/src/svg/SkSVGDevice.cpp:495-503), which floods the whole bounding
    // box. A solid-colour source folds the blend into the paint colour instead,
    // so no filter may appear here at all.
    const markup = shadowed.toString('utf8')
    t.is(markup.match(element)?.length, 2, `${name}: a shadow element and a content element`)
    t.false(markup.includes('filter="url(#'), `${name}: no colour filter for a solid-colour shadow`)
    t.true(/(fill|stroke)="blue"/.test(markup), `${name}: the shadow carries shadowColor as a plain paint attribute`)
    t.true(
      markup.includes(`transform="translate(${SVG_SHADOW_DX} ${SVG_SHADOW_DY})"`),
      `${name}: the shadow pass carries the offset`,
    )
  }
})

// A shader-filled shadow cannot be folded into a paint colour, so it keeps the
// kSrcIn colour filter and still hits the SkSVGDevice bug described above. That
// is a known, accepted limitation -- pin it so it is a deliberate choice rather
// than a silent one.
test('shadow-zero-blur-gradient-fill-still-needs-the-colour-filter-in-svg', (t) => {
  const markup = svgScene((ctx) => {
    const gradient = ctx.createLinearGradient(30, 0, 110, 0)
    gradient.addColorStop(0, 'red')
    gradient.addColorStop(1, 'lime')
    ctx.shadowColor = 'blue'
    ctx.shadowBlur = 0
    ctx.shadowOffsetX = SVG_SHADOW_DX
    ctx.shadowOffsetY = SVG_SHADOW_DY
    ctx.fillStyle = gradient
    ctx.fillRect(30, 30, 80, 60)
  }).toString('utf8')
  t.true(markup.includes('flood-color="blue"'), 'the gradient shadow keeps the kSrcIn colour filter')
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
  let differingPixels = 0
  let totalDelta = 0
  for (let p = 0; p < shadowed.length; p += 4) {
    let delta = 0
    for (let c = 0; c < 4; c++) delta += Math.abs(shadowed[p + c] - byHand[p + c])
    if (delta > 0) {
      differingPixels++
      totalDelta += delta
    }
  }
  // NOT `=== 0`: the two renders reach the same geometry by different matrix
  // arithmetic (Skia inverts the CTM in f32, the by-hand arm multiplies in f64),
  // so AA edges may disagree by an ulp. Both bounds sit ~5x above the observed
  // jitter and ~5x below the defect they guard.
  t.true(differingPixels <= 60, `${differingPixels} differing pixels: jitter is <= 12, the double-applied clip is 336`)
  t.true(totalDelta <= 800, `total delta ${totalDelta}: jitter is <= 141, the double-applied clip is 7170`)
})

// Pins that `ctx.filter` is the INPUT of the shadow graph, not something
// applied over its output: Blink composes `shadow(canvas_filter(source))`
// (canvas_2d_recorder_context.h:931-934), and since the graph colourises with
// kSrcIn a colour-only filter cannot reach the shadow's colour at all. Every
// expectation below is a byte-exact Chrome 150 measurement of the same scene.
function filterScene(filter: string, shadowBlur: number, shadowColor = 'rgb(0, 0, 255)') {
  const canvas = createCanvas(300, 200)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 300, 200)
  ctx.filter = filter
  ctx.shadowColor = shadowColor
  ctx.shadowBlur = shadowBlur
  ctx.shadowOffsetX = 60
  ctx.fillStyle = 'red'
  ctx.fillRect(20, 20, 60, 100)
  return ctx
}

// Chrome: [0, 0, 255]. Applying the filter to the shadow's colour instead --
// which is what a paint colour or a colour filter under `ctx.filter` gives,
// since Skia's blitter runs both BEFORE the paint's image filter -- reads
// [18, 18, 18] (0.0722 * 255, the luma of blue).
test('shadow-zero-blur-ctx-filter-does-not-recolour-the-shadow', (t) => {
  t.deepEqual(px(filterScene('grayscale(1)', 0), 110, 70), [0, 0, 255, 255])
  // ...while the CONTENT is still filtered: grayscale(red) = 0.2126 * 255 = 54.
  t.deepEqual(px(filterScene('grayscale(1)', 0), 50, 70), [54, 54, 54, 255])
})

test('shadow-zero-blur-ctx-filter-invert-does-not-recolour-the-shadow', (t) => {
  // Unchained this reads [255, 255, 0] -- the inverse of the shadow colour.
  t.deepEqual(px(filterScene('invert(1)', 0), 110, 70), [0, 0, 255, 255])
  t.deepEqual(px(filterScene('invert(1)', 0), 50, 70), [0, 255, 255, 255])
})

test('shadow-blurred-ctx-filter-does-not-recolour-the-shadow', (t) => {
  t.deepEqual(px(filterScene('grayscale(1)', 8), 110, 70), [0, 0, 255, 255])
  t.deepEqual(px(filterScene('grayscale(1)', 8), 50, 70), [54, 54, 54, 255])
})

// The other half of the rule, and the reason "drop `ctx.filter` from the shadow"
// is wrong even though it gets the colour right: a filter that moves the source
// COVERAGE must still reach the shadow. `opacity(0.5)` halves it, so the shadow
// composites at 50% over white -- [128, 128, 255], not the opaque [0, 0, 255].
test('shadow-zero-blur-ctx-filter-opacity-still-reaches-the-shadow', (t) => {
  t.deepEqual(px(filterScene('opacity(0.5)', 0), 110, 70), [128, 128, 255, 255])
})

// Same rule with a geometric filter: `blur(3px)` softens the shadow's edge.
// Sample far enough outside the sharp rect that only a blurred shadow can be
// there at all -- the un-blurred edge sits at x = 80 + 60 = 140.
test('shadow-zero-blur-ctx-filter-blur-still-reaches-the-shadow', (t) => {
  const ctx = filterScene('blur(3px)', 0)
  // Byte-identical to Chrome 150 across the edge; the bands allow a 1/255 AA
  // drift but stay tight enough that a SHARP edge cannot pass.
  for (const [x, expected] of [
    [138, 83],
    [140, 143],
    [142, 198],
    [144, 235],
  ] as const) {
    const [r, , b] = px(ctx, x, 70)
    t.is(b, 255, `x=${x} must still be blue`)
    t.true(Math.abs(r - expected) <= 3, `x=${x}: expected ~${expected} (Chrome 150), got ${r}`)
  }
})

// ------------------------------------------- isolation composite arm: device-space offsets

// `source-in` over an opaque backdrop unrolls into two independently composited
// passes (canvas_2d_recorder_context.h:924), so the surviving backdrop is
// exactly `shadow AND content` -- making its left edge a direct readout of the
// space the shadowOffset was applied in. On this arm the shadow pass records
// into a PictureRecorder at identity and is replayed under the real CTM, so an
// offset read off that canvas's own CTM comes out scaled and rotated.
//
// Returns the alpha of the surviving band along device y = 100, one entry per
// device x. Probe named columns rather than hunting for a threshold crossing:
// at `shadowBlur = 8` the band's left edge is a ~20px Gaussian ramp.
function isolationShadowRow(setup: (ctx: any) => void, shadowBlur: number) {
  const canvas = createCanvas(300, 200)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 300, 200)
  ctx.globalCompositeOperation = 'source-in'
  setup(ctx)
  ctx.shadowColor = 'rgba(0, 200, 0, 1)'
  ctx.shadowBlur = shadowBlur
  ctx.shadowOffsetX = 40
  ctx.shadowOffsetY = 0
  ctx.fillStyle = 'red'
  ctx.fillRect(10, 40, 60, 30)

  const data = ctx.getImageData(0, 0, 300, 200).data
  const row: number[] = []
  for (let x = 0; x < 300; x++) {
    const i = (100 * 300 + x) * 4
    // only the red content survives `source-in`; the blue backdrop reads as gone
    row.push(data[i] > 120 ? data[i + 3] : 0)
  }
  return row
}

// Every probe below is >= 10 device px from the nearest ramp, so a sub-pixel
// shift cannot move it: the measured values are a flat 255 or a flat 0 at both
// blur radii, and the wrong-space rendering puts the opposite extreme there.
const OPAQUE = 250
const CLEAR = 20

for (const shadowBlur of [0, 8]) {
  test(`shadow-offset-is-device-space-on-the-isolation-arm-blur-${shadowBlur}`, (t) => {
    // Content is device x 20..139. Chrome puts the shadow 40 DEVICE px right of
    // it, so the overlap is 60..139; a user-space offset would double it to 80
    // and start the overlap at 100.
    //             probe:      35        80
    //   device space (want):   0       255      overlap 60..139
    //   user space (bug):      0         0      overlap 100..139
    //   offset dropped:      255       255      overlap 20..139
    const scaled = isolationShadowRow((ctx) => ctx.scale(2, 2), shadowBlur)
    t.true(scaled[80] >= OPAQUE, `x=80 must be inside the overlap, got alpha ${scaled[80]}`)
    t.true(scaled[35] <= CLEAR, `x=35 is left of the overlap, got alpha ${scaled[35]}`)

    // Content is device x 120..179 with the axes flipped. Device-space: the
    // shadow moves RIGHT regardless, overlap 160..179. A user-space offset
    // rotates with the CTM and moves it left instead, giving 120..139.
    //             probe:     130       175
    //   device space (want):   0       255
    //   user space (bug):    255         0
    const flipped = isolationShadowRow((ctx) => {
      ctx.translate(150, 100)
      ctx.rotate(Math.PI)
      ctx.translate(-40, -55)
    }, shadowBlur)
    t.true(flipped[175] >= OPAQUE, `x=175 must be inside the overlap, got alpha ${flipped[175]}`)
    t.true(flipped[130] <= CLEAR, `x=130 is where a user-space offset would put it, got alpha ${flipped[130]}`)

    // A rotation the offset must not follow: at 0.5 rad the shadow clears the
    // content entirely, so nothing solid survives. A rotated offset leaves a
    // fully opaque overlap at x 53..75. The bound is the geometric mean of the
    // two measurements -- at blur 8 the correct render still leaves a 57/255
    // tail of the Gaussian here, and the bug reads 255.
    const rotated = isolationShadowRow((ctx) => {
      ctx.translate(40, 20)
      ctx.rotate(0.5)
    }, shadowBlur)
    const peak = Math.max(...rotated)
    t.true(peak < 120, `nothing solid may survive, peak alpha ${peak} (blur tail is <= 57, the bug is 255)`)
  })
}

// ------------------------------------- isolation composite arm: one paint per role

// Pins that one paint never plays both roles in `composited_pass`. Blink's
// `composite_flags` carries only the blend mode while the content paint rides on
// the inner draw (canvas_2d_recorder_context.h:921-952); handing the content
// paint to the layer too applies globalAlpha twice.
//
// Every expectation below is the WHATWG compositing formula against an opaque
// backdrop with alphaS = globalAlpha = 0.5, so alphaO = 0.5 -> 127 (except
// source-out, which is 0). A double-applied globalAlpha reads 63 instead.
const ISOLATION_ALPHA_EXPECTATIONS: [string, number[]][] = [
  ['source-in', [255, 0, 0, 127]],
  ['destination-in', [0, 0, 255, 127]],
  ['destination-atop', [0, 0, 255, 127]],
  ['copy', [255, 0, 0, 127]],
  ['source-out', [0, 0, 0, 0]],
]

test('isolation-layer-applies-globalAlpha-exactly-once', (t) => {
  for (const [mode, expected] of ISOLATION_ALPHA_EXPECTATIONS) {
    const canvas = createCanvas(240, 240)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'blue'
    ctx.fillRect(0, 0, 240, 240)
    ctx.globalCompositeOperation = mode as any
    ctx.globalAlpha = 0.5
    ctx.fillStyle = 'rgb(255, 0, 0)'
    ctx.fillRect(60, 60, 60, 60)
    t.deepEqual(px(ctx, 90, 90), expected, mode)
    // The layer is whole-canvas, so everything outside the draw must be gone.
    t.deepEqual(px(ctx, 220, 220), [0, 0, 0, 0], `${mode} outside the draw`)
  }
})

// The same statement with a shadow on: the shadow pass gets its OWN isolation
// layer, so its paint can be double-applied independently of the content pass's.
// Content is 60..119 in both axes, shadow band 100..159, overlap 100..119;
// `shadowColor` is opaque, so the shadow pass's only source alpha is globalAlpha.
function isolationAlphaShadowScene(mode: string, shadowBlur: number) {
  const canvas = createCanvas(240, 240)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 240, 240)
  ctx.globalCompositeOperation = mode as any
  ctx.globalAlpha = 0.5
  ctx.shadowColor = 'rgba(0, 255, 0, 1)'
  ctx.shadowBlur = shadowBlur
  ctx.shadowOffsetX = 40
  ctx.shadowOffsetY = 40
  ctx.fillStyle = 'rgb(255, 0, 0)'
  ctx.fillRect(60, 60, 60, 60)
  return ctx
}

test('isolation-layer-applies-globalAlpha-exactly-once-with-a-shadow', (t) => {
  // source-in, zero blur. Shadow pass: alphaO = 0.5 * 1 = 0.5 over the band.
  // Content pass, source-in against that: alphaO = 0.5 * 0.5 = 0.25 -> 63, Co = red.
  t.deepEqual(px(isolationAlphaShadowScene('source-in', 0), 110, 110), [255, 0, 0, 63])

  // sigma = 20 * 0.5 = 10 and (110, 110) is 10.5 device px inside both edges of
  // the shadow band, so alphaO = 0.5 * (0.5 * Phi(1.05)^2) = 0.1820 -> 46.4.
  // +/- 6, not +/- 3: this probe sits on the corner of two blurred edges, where
  // a tighter tolerance would be sensitive to a sub-pixel shift. It costs
  // nothing -- double-applying the paint reads 9.
  const blurred = px(isolationAlphaShadowScene('source-in', 20), 110, 110)
  t.deepEqual(blurred.slice(0, 3), [255, 0, 0])
  t.true(Math.abs(blurred[3] - 46) <= 6, `source-in blurred overlap alpha was ${blurred[3]}, expected 46 +/- 6`)

  // copy replaces every pixel with the foreground layer, shadow band included
  // (canvas_2d_recorder_context.h:830-837), so alphaO is exactly globalAlpha
  // however the shadow is blurred. Double-applying the shadow paint dropped this
  // to 31.
  for (const shadowBlur of [0, 20]) {
    t.deepEqual(px(isolationAlphaShadowScene('copy', shadowBlur), 90, 90), [255, 0, 0, 127], `copy blur ${shadowBlur}`)
  }
})

// Pins that destination-out is NOT isolated: it sits outside
// `IsFullCanvasCompositeMode` (canvas_2d_recorder_context.h:998-1005).
// Isolating it is observable because `composited_pass` records into a
// PictureRecorder at identity whose cull rect is therefore in USER space, so a
// draw whose user coordinates fall off-canvas is culled even though the CTM puts
// it on screen. Here the CTM is `translate(-500, 0)`, the rect is at user
// x 600..699 (device 100..199) and its shadow covers device x 140..239; both
// bands must be punched clean through.
test('destination-out-is-not-isolated', (t) => {
  const canvas = createCanvas(300, 300)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 300, 300)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.translate(-500, 0)
  ctx.shadowColor = 'rgba(0, 0, 0, 1)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 40
  ctx.fillStyle = 'rgb(0, 0, 255)'
  ctx.fillRect(600, 50, 100, 100)

  t.deepEqual(px(ctx, 150, 100), [0, 0, 0, 0], 'the content must punch a hole')
  t.deepEqual(px(ctx, 220, 100), [0, 0, 0, 0], 'the shadow must punch a hole')
  t.deepEqual(px(ctx, 260, 100), [255, 0, 0, 255], 'right of the shadow band')
  t.deepEqual(px(ctx, 150, 20), [255, 0, 0, 255], 'above the draw')
})

// ------------------------------------------------- I3: sigma under a rotating CTM

// GUARD that `shadow-blur-sigma-is-rotation-invariant` above cannot give: at
// scale 1 every quarter turn snaps `transform.a` to 0 or negative, and any
// column-norm fallback then happens to land on the right answer. These two
// shapes do not:
//   scale(2) . rotate(90deg)  a = 0     -> fallback sigma 10, device sigma 20
//   rotate(45deg)             a = 0.707 -> sigma 14.14, device sigma 14.14
// Both must read the SIGMA_10_PROFILE, because Chrome blurs in device space and
// a similarity CTM never changes the device sigma. The device box is [110,190]^2
// in every case and the offset is 200 device px, so the edge sits at x = 390.
function assertSigma10At390(t: any, data: Uint8ClampedArray, label: string) {
  for (const [x, expected] of SIGMA_10_PROFILE.slice(1)) {
    const alpha = data[(150 * 600 + (x + 90)) * 4 + 3]
    t.true(Math.abs(alpha - expected) <= 4, `${label}: alpha at x=${x + 90} was ${alpha}, expected ${expected} +/- 4`)
  }
}

test('shadow-blur-sigma-survives-a-uniform-scale-under-rotation', (t) => {
  for (const theta of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    const canvas = createCanvas(600, 300)
    const ctx = canvas.getContext('2d')!
    ctx.translate(150, 150)
    ctx.scale(2, 2)
    ctx.rotate(theta)
    ctx.shadowColor = 'black'
    ctx.shadowBlur = 20
    ctx.shadowOffsetX = 200
    ctx.fillStyle = 'red'
    ctx.fillRect(-20, -20, 40, 40)
    assertSigma10At390(t, ctx.getImageData(0, 0, 600, 300).data, `scale(2) . rotate(${theta})`)
  }
})

// Off-axis rotations, where `transform.a` is positive and simply wrong. The path
// is pre-rotated by -theta so its DEVICE image is the same [110,190]^2 box as
// every other case here -- the shape is held fixed so that only the sigma varies.
test('shadow-blur-sigma-survives-an-off-axis-rotation', (t) => {
  for (const theta of [Math.PI / 6, Math.PI / 4, Math.PI / 3]) {
    const canvas = createCanvas(600, 300)
    const ctx = canvas.getContext('2d')!
    ctx.translate(150, 150)
    ctx.rotate(theta)
    const cos = Math.cos(-theta)
    const sin = Math.sin(-theta)
    const corners = (
      [
        [-40, -40],
        [40, -40],
        [40, 40],
        [-40, 40],
      ] as [number, number][]
    ).map(([x, y]) => [x * cos - y * sin, x * sin + y * cos] as [number, number])
    ctx.shadowColor = 'black'
    ctx.shadowBlur = 20
    ctx.shadowOffsetX = 200
    ctx.fillStyle = 'red'
    ctx.beginPath()
    ctx.moveTo(corners[0][0], corners[0][1])
    for (const [x, y] of corners.slice(1)) ctx.lineTo(x, y)
    ctx.closePath()
    ctx.fill()
    assertSigma10At390(t, ctx.getImageData(0, 0, 600, 300).data, `rotate(${theta})`)
  }
})

// ----------------------------------------------------- ctx.filter is device-space
//
// HTML 4.12.5.1.20: "Filter coordinates are not affected by the current
// transformation matrix ... Filters are applied in the output bitmap's
// coordinate space." Blink implements that by opening the filter layer with the
// CTM reset to identity (canvas_2d_recorder_context.h:919-963), which is what
// `Context::composited_filter_layer` does.
//
// Every scene below paints the SAME DEVICE-SPACE rect under two different CTMs,
// so only the filter width can move. The 10-90% edge width is a Chrome-measured
// 8.27 px for `blur(3px)` and 13.56 px chained into `shadowBlur = 8`, at BOTH
// transforms. The 0.5 px tolerance sits against a defect worth 6.2 px, and the
// identity column uses the same number so a uniform scaling would still fail.

const FILTER_W = 420
const FILTER_H = 220

// 10-90% width of the band's falling right edge along y = 100, plus the 50%
// crossing. Sub-pixel, by linear interpolation between pixel centres.
function edgeProfile(ctx: SKRSContext2D, x0 = 170, x1 = 270, y = 100) {
  const d = ctx.getImageData(x0, y, x1 - x0, 1).data
  // white backdrop, black band -> darkness = 1 - G/255
  const p: number[] = []
  for (let i = 0; i < x1 - x0; i++) p.push(1 - d[i * 4 + 1] / 255)
  const cross = (level: number) => {
    for (let i = 1; i < p.length; i++) {
      if (p[i - 1] >= level && p[i] < level) {
        return x0 + i - 1 + (p[i - 1] - level) / (p[i - 1] - p[i])
      }
    }
    return NaN
  }
  return { width: cross(0.1) - cross(0.9), x50: cross(0.5) }
}

function ctmScene(scale: number, draw: (ctx: SKRSContext2D, scale: number) => void) {
  const canvas = createCanvas(FILTER_W, FILTER_H)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, FILTER_W, FILTER_H)
  ctx.scale(scale, scale)
  draw(ctx, scale)
  return ctx
}

// Device rect x 20..120, y 20..200; the shadow band is x 120..220.
const shadowBandScene = (shadowBlur: number) => (ctx: SKRSContext2D, scale: number) => {
  ctx.shadowColor = 'black'
  ctx.shadowBlur = shadowBlur
  ctx.shadowOffsetX = 100
  ctx.filter = 'blur(3px)'
  ctx.fillStyle = 'red'
  ctx.fillRect(20 / scale, 20 / scale, 100 / scale, 180 / scale)
}

function assertDeviceSpaceFilter(t: ExecutionContext, label: string, expected: number, scenes: SKRSContext2D[]) {
  for (const [i, ctx] of scenes.entries()) {
    const { width, x50 } = edgeProfile(ctx)
    t.true(
      Math.abs(width - expected) <= 0.5,
      `${label} CTM#${i}: 10-90 filter edge width was ${width.toFixed(2)}, expected ${expected} +/- 0.5 (Chrome 150)`,
    )
    // The 50% crossing pins the OFFSET, so a failure above can only be a width.
    t.true(Math.abs(x50 - 219.5) <= 0.5, `${label} CTM#${i}: 50% crossing was ${x50.toFixed(2)}, expected 219.50`)
  }
}

test('ctx-filter-blur-width-is-device-space-on-the-zero-blur-shadow-route', (t) => {
  assertDeviceSpaceFilter(t, 'shadowBlur=0', 8.27, [ctmScene(1, shadowBandScene(0)), ctmScene(2, shadowBandScene(0))])
})

test('ctx-filter-blur-width-is-device-space-on-the-blurred-shadow-route', (t) => {
  assertDeviceSpaceFilter(t, 'shadowBlur=8', 13.56, [ctmScene(1, shadowBandScene(8)), ctmScene(2, shadowBandScene(8))])
})

// No shadow at all: `ctx.filter` alone, on the foreground layer.
test('ctx-filter-blur-width-is-device-space-with-no-shadow', (t) => {
  const scene = (ctx: SKRSContext2D, scale: number) => {
    ctx.filter = 'blur(3px)'
    ctx.fillStyle = 'black'
    ctx.fillRect(120 / scale, 20 / scale, 100 / scale, 180 / scale)
  }
  assertDeviceSpaceFilter(t, 'no shadow', 8.27, [ctmScene(1, scene), ctmScene(2, scene)])
})

// The image path takes its own layer, so it needs its own guard.
test('ctx-filter-blur-width-is-device-space-on-drawImage', async (t) => {
  const opaque = createCanvas(100, 180)
  const og = opaque.getContext('2d')!
  og.fillStyle = 'black'
  og.fillRect(0, 0, 100, 180)
  const img = await loadImage(opaque.toBuffer('image/png'))
  const scene = (ctx: SKRSContext2D, scale: number) => {
    ctx.imageSmoothingEnabled = false
    ctx.filter = 'blur(3px)'
    ctx.drawImage(img, 120 / scale, 20 / scale, 100 / scale, 180 / scale)
  }
  assertDeviceSpaceFilter(t, 'drawImage', 8.27, [ctmScene(1, scene), ctmScene(2, scene)])
})

// shadowBlur alone must NOT move -- it was already device-space and this proves
// the layer did not disturb it. Chrome is 10.54 at both CTMs; we read 10.92,
// the documented analytic-vs-discrete rect-blur divergence (see
// `shadow_only_image_filter`), which is why this asserts our own number.
test('shadowBlur-alone-is-unchanged-by-the-device-space-filter-layer', (t) => {
  const scene = (ctx: SKRSContext2D, scale: number) => {
    ctx.shadowColor = 'black'
    ctx.shadowBlur = 8
    ctx.shadowOffsetX = 100
    ctx.fillStyle = 'red'
    ctx.fillRect(20 / scale, 20 / scale, 100 / scale, 180 / scale)
  }
  assertDeviceSpaceFilter(t, 'shadowBlur only', 10.92, [ctmScene(1, scene), ctmScene(2, scene)])
})

// ------------------------------------ fractional shadow offsets on image sources
//
// Skia implements `DropShadowOnly`'s dx/dy as
// `MatrixTransform(Translate(dx, dy), SkFilterMode::kLinear)`
// (SkDropShadowImageFilter.cpp:50-53), and the resample is load-bearing: a
// canvas translate has none, so a half-covered destination pixel came out fully
// covered. 200x200 source, left half opaque red, drawn at (0, 10) with
// `imageSmoothingEnabled = false`; `shadowOffsetX = 100.5` puts the shadow's
// right edge on x = 200.5, so the probe at x = 200 is exactly half covered and
// Chrome reads [127,127,255].

const HALF_OPAQUE_W = 420
const HALF_OPAQUE_H = 220

async function halfOpaqueImage() {
  const src = createCanvas(200, 200)
  const g = src.getContext('2d')!
  g.fillStyle = 'red'
  g.fillRect(0, 0, 100, 200)
  return loadImage(src.toBuffer('image/png'))
}

function imageShadowScene(
  img: Awaited<ReturnType<typeof loadImage>>,
  shadowBlur: number,
  offsetX: number,
  transform?: (ctx: SKRSContext2D) => void,
) {
  const canvas = createCanvas(HALF_OPAQUE_W, HALF_OPAQUE_H)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, HALF_OPAQUE_W, HALF_OPAQUE_H)
  ctx.imageSmoothingEnabled = false
  ctx.shadowColor = 'blue'
  ctx.shadowBlur = shadowBlur
  ctx.shadowOffsetX = offsetX
  ctx.shadowOffsetY = 0
  if (transform) transform(ctx)
  ctx.drawImage(img, 0, 10)
  return ctx
}

test('image-shadow-fractional-offset-keeps-its-half-coverage', async (t) => {
  const img = await halfOpaqueImage()
  const ctx = imageShadowScene(img, 0, 100.5)
  // Half-covered edge pixel. Was [0,0,255,255] when the offset was a translate.
  pxNear(t, ctx, 200, 100, [127, 127, 255, 255])
  // ...and the fully covered interior is untouched, so this is a resample and
  // not an opacity change.
  t.deepEqual(px(ctx, 150, 100), [0, 0, 255, 255])
  // The foreground still lands exactly where it did.
  t.deepEqual(px(ctx, 50, 100), [255, 0, 0, 255])
})

test('image-shadow-fractional-offset-keeps-its-half-coverage-when-blurred', async (t) => {
  const img = await halfOpaqueImage()
  const ctx = imageShadowScene(img, 6, 100.5)
  // Was [112,112,255,255]; Chrome reads [127,127,255].
  pxNear(t, ctx, 200, 100, [127, 127, 255, 255])
})

// An INTEGER offset must be untouched by the resample -- kLinear on a whole-pixel
// translate samples texel centres exactly.
test('image-shadow-integer-offset-is-unmoved-by-the-resample', async (t) => {
  const img = await halfOpaqueImage()
  const ctx = imageShadowScene(img, 0, 100)
  // Shadow band is x 100..199 inclusive; 200 is past its right edge.
  t.deepEqual(px(ctx, 199, 100), [0, 0, 255, 255])
  t.deepEqual(px(ctx, 200, 100), [255, 255, 255, 255])
})

// The dx/dy above are device-space vectors only because
// `composited_filter_layer` opens the shadow layer at the identity CTM; on a
// layer at the draw's own CTM a rotation sends the shadow the other way.
// translate(210, 110) . rotate(PI) maps the image's local (-100..100) onto
// device (110..310) mirrored, so the opaque half is device x 210..310 and a +60
// device-space offset puts its shadow at x 270..370.
test('image-shadow-offset-stays-device-space-under-a-rotation', async (t) => {
  const img = await halfOpaqueImage()
  const canvas = createCanvas(HALF_OPAQUE_W, HALF_OPAQUE_H)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, HALF_OPAQUE_W, HALF_OPAQUE_H)
  ctx.imageSmoothingEnabled = false
  ctx.shadowColor = 'blue'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 60
  ctx.shadowOffsetY = 0
  ctx.translate(210, 110)
  ctx.rotate(Math.PI)
  ctx.drawImage(img, -100, -100)
  // Shadow to the RIGHT of the mirrored image, in device space.
  t.deepEqual(px(ctx, 340, 100), [0, 0, 255, 255])
  // A local-space offset would have gone LEFT instead, into this pixel.
  t.deepEqual(px(ctx, 180, 100), [255, 255, 255, 255])
  // The image itself is unmoved.
  t.deepEqual(px(ctx, 250, 100), [255, 0, 0, 255])
})

// Same invariant under a non-uniform scale, where a local-space offset would be
// stretched: scale(2, 0.5) doubled a 40 px offset to 80.
test('image-shadow-offset-stays-device-space-under-a-non-uniform-scale', async (t) => {
  const img = await halfOpaqueImage()
  const canvas = createCanvas(HALF_OPAQUE_W, HALF_OPAQUE_H)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, HALF_OPAQUE_W, HALF_OPAQUE_H)
  ctx.imageSmoothingEnabled = false
  ctx.shadowColor = 'blue'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 40
  ctx.shadowOffsetY = 0
  ctx.scale(2, 0.5)
  ctx.drawImage(img, 0, 20)
  // Opaque half is device x 0..199; its shadow is x 40..239. At x = 260 a
  // doubled (local-space) 80 px offset would still be painting.
  t.deepEqual(px(ctx, 230, 60), [0, 0, 255, 255])
  t.deepEqual(px(ctx, 260, 60), [255, 255, 255, 255])
})

// `ctx.filter` must not attach to clearRect: Blink's `clearRect` is a bare
// kClear `drawRect` with no filter, shadow or composite layer. The hazard is not
// cosmetic -- a kClear layer restores by clearing its whole bounds, so clearing
// a 60x60 rect wiped the entire canvas.
test('ctx-filter-does-not-attach-to-clearRect', (t) => {
  const canvas = createCanvas(200, 100)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 200, 100)
  ctx.filter = 'blur(3px)'
  ctx.clearRect(50, 20, 60, 60)
  t.deepEqual(px(ctx, 80, 50), [0, 0, 0, 0], 'inside the cleared rect')
  t.deepEqual(px(ctx, 10, 50), [255, 0, 0, 255], 'left of the cleared rect')
  t.deepEqual(px(ctx, 180, 50), [255, 0, 0, 255], 'right of the cleared rect')
  t.deepEqual(px(ctx, 100, 5), [255, 0, 0, 255], 'above the cleared rect')
})
