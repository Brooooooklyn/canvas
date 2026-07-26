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

    // The sharpest signature of the defect: with the filter under the dst clip
    // the bbox is exactly the dst rect plus the offset, [100,100,209,209], with
    // NOTHING outside it -- the alpha steps 0 -> 255 at x = 100. Unclipped it is
    // [86,86,233,233], a Gaussian tail reading 1,1,2,3,4 at x = 86..90. Both
    // bounds below are the midpoint of the two, so the tail has ~7px to retreat
    // and the clip ~7px to leak before either verdict changes.
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
// kSrcIn)` and nothing else, exactly as Chromium's looper does when
// `blur_sigma == 0` (cc/paint/draw_looper.cc:28-42). Routing it through an
// SkImageFilter instead is observable three ways, and all three are asserted
// below: the vector backends cannot express an image filter, and the implicit
// saveLayer applies an antialiased clip twice.

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

// The previous version of this test asserted on the emitted markup only -- two
// elements, a translate, a flood-color -- and every one of those held while the
// shadow rendered as a solid rectangle over the shape's bounding box, so it
// could not see the regression it existed to catch. It now RENDERS the SVG and
// compares it against an independent oracle.
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

    // Markup shape, as a second and much more specific guard than the old
    // "there are two elements" assertion. Skia CAN serialise the kSrcIn colour
    // filter that colourises a shadow, but it writes
    //   <feFlood .../><feComposite in="flood" operator="in"/>
    // with no `in2` (skia/src/svg/SkSVGDevice.cpp:495-503). SVG 1.1 11.1.1 says
    // a missing `in2` on a non-first primitive is the PREVIOUS result -- the
    // flood -- so the composite floods the whole filter region, which is the
    // bounding box. For a solid-colour source the blend is folded into the paint
    // colour instead (src/ctx.rs, `ShadowSource::is_solid_color`), which is what
    // makes the render above come out right, so no filter may appear here.
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
  // NOT `=== 0`, even though this scene measures exactly 0 on arm64. The two
  // renders reach the same geometry by different matrix arithmetic -- Skia
  // inverts the CTM in f32 inside `apply_shadow_offset_matrix_to_canvas`, the
  // by-hand arm multiplies it in f64 in JS -- so the shadow rect's own AA edges
  // are free to disagree by an ulp, and aarch64 (FMA contraction) and x86-64
  // SSE2 do not have to round that the same way. Sweeping this scene over 60
  // clip angles and 6 offsets on the fixed build: at most 12 differing pixels,
  // 141 total delta, and those are bidirectional (some lighter, some darker) and
  // sit on the rect's edges, not on the clip boundary.
  //
  // The defect this guards is not subtle at that scale. With the shadow drawn
  // through an image filter (i.e. inside a saveLayer, so the rotated clip is
  // antialiased twice) the very same scene measures 336 differing pixels and
  // 7170 total delta -- a uniform darkening along the clip edge. Both bounds
  // below sit ~5x above the observed f32 jitter and ~5x below the defect.
  t.true(differingPixels <= 60, `${differingPixels} differing pixels: jitter is <= 12, the double-applied clip is 336`)
  t.true(totalDelta <= 800, `total delta ${totalDelta}: jitter is <= 141, the double-applied clip is 7170`)
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

// ------------------------------------------- isolation composite arm: device-space offsets

// `source-in` over an opaque backdrop unrolls into two independently composited
// passes (canvas_2d_recorder_context.h:924), so the surviving backdrop is
// exactly `shadow AND content` -- which makes its left edge a direct readout of
// the space the shadowOffset was applied in.
//
// The shadow pass records into a PictureRecorder whose canvas sits at identity
// and is replayed under the real CTM, so a shadow offset applied off that
// canvas's own CTM came out scaled and rotated. Expected values are Chrome
// 150.0.7871.184 measurements of the identical scene.
//
// Returns the alpha of the surviving band along device y = 100, one entry per
// device x. Probing named columns rather than hunting for a threshold crossing
// matters at `shadowBlur = 8`: the band's left edge is then a ~20px Gaussian
// ramp climbing 53 -> 72 -> 93 -> 116 -> 139 -> 162, so "the first column over
// 120" sits 5/255 from flipping to its neighbour, while a column in the middle
// of the plateau is 255 and a column outside the ramp is 0.
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

// Blink's `CompositedDraw` never lets one paint play both roles: `composite_flags`
// is a FRESH PaintFlags carrying only `setBlendMode(state.GlobalComposite())` --
// alpha 1, no shader, no filter -- while the content paint rides on the inner
// draw with its blend forced to source-over (canvas_2d_recorder_context.h:
// 921-922, :946-952). Handing the content paint to the layer as well applies
// globalAlpha (and the shadow's drop-shadow filter) TWICE, because
// `SkCanvas::drawPicture` with a paint is `saveLayer(cullRect, paint) + playback
// + restore` (skia/src/core/SkCanvasPriv.cpp:32-45) and the restore paint keeps
// alpha, colour filter and blend mode (skia/src/core/SkCanvas.cpp:895-906).
//
// Every expectation below is the WHATWG compositing formula against an OPAQUE
// backdrop (alphaB = 1) with alphaS = globalAlpha = 0.5:
//   source-in         alphaO = alphaS * alphaB       = 0.5   Co = Cs
//   destination-in    alphaO = alphaB * alphaS       = 0.5   Co = Cb
//   destination-atop  alphaO = alphaS                = 0.5   Co = Cb
//   copy              alphaO = alphaS                = 0.5   Co = Cs
//   source-out        alphaO = alphaS * (1 - alphaB) = 0
// 0.5 * 255 = 127.5, and the premultiplied round trip lands on 127. A
// double-applied globalAlpha reads 0.25 -> 63 instead.
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

// The same statement with a shadow on, which is the combination nothing covered:
// the shadow pass gets its OWN isolation layer, so its paint is double-applied
// independently of the content pass's.
//
// Content is 60..119 in both axes, shadow offset (+40, +40) so the shadow band is
// 100..159 and the overlap is 100..119. `shadowColor` is opaque, so the shadow
// pass's only source alpha is globalAlpha.
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
  // the shadow band, so the shadow's own coverage is Phi(1.05)^2 = 0.7278 and
  // alphaO = 0.5 * (0.5 * 0.7278) = 0.1820 -> 46.4.
  //
  // +/- 6, not +/- 3: this probe sits on the corner of two blurred edges, where
  // the alpha climbs ~1.5/255 per device px, so a tolerance under the local
  // gradient would be sensitive to a sub-pixel shift as well as to the algebra.
  // It costs nothing -- the measurement is 47, and double-applying the paint
  // reads 9.
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

// `IsFullCanvasCompositeMode` is exactly {kSrcIn, kSrcOut, kDstIn, kDstATop}
// (canvas_2d_recorder_context.h:998-1005). destination-out is deliberately not in
// it -- it is listed under `BlendModeSupportsShadowFilter` (h:692-697) and is
// never isolated, "as the platforms already implement the specification's
// behavior".
//
// Isolating it is observable because `composited_pass` records into a
// PictureRecorder that sits at IDENTITY with the canvas rect as its cull rect, so
// that cull rect is in USER space. A draw whose user coordinates fall outside the
// canvas is then culled even though the CTM puts it on screen. Here the CTM is
// `translate(-500, 0)` and the rect is at user x 600..699, i.e. device x 100..199,
// with an opaque black shadow at (+40, 0) covering device x 140..239.
// destination-out against an opaque backdrop is alphaO = alphaB * (1 - alphaS),
// so both bands must be punched clean through.
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

// GUARD for the column-norm decomposition, which `shadow-blur-sigma-is-rotation-
// invariant` above cannot see: at scale 1 every quarter turn snaps `transform.a`
// to exactly 0 (`SkScalarCosSnapToZero`, SkMatrix.cpp:458) or to a negative
// number, the `scale_x.is_finite() && scale_x > 0` guard then falls back to the
// unscaled sigma, and that fallback happens to be the right answer. These two
// shapes have no such luck:
//   scale(2) . rotate(90deg)  a = 0     -> fallback sigma 10, device sigma 20
//   rotate(45deg)             a = 0.707 -> sigma 14.14, device sigma 14.14
// Both must instead read the SIGMA_10_PROFILE, because Chrome maps sigma with a
// single scalar and blurs in device space (SkBlurMaskFilterImpl.cpp:111-115), so
// a similarity CTM never changes the device sigma.
//
// Device box is [110,190]^2 in every case below and the shadow offset is 200
// device px, so the blurred edge sits at x = 390 and the profile is read at
// x = 380 / 390 / 400 / 410.
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
