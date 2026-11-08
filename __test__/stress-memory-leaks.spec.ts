import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

import { default as ava } from 'ava'

import {
  createCanvas,
  Path2D,
  Image,
  GlobalFonts,
  SvgExportFlag,
  SvgCanvas,
  convertSVGTextToPath,
  setTextRenderer,
} from '../index'

const shouldSkip = process.env.RUN_STRESS_TESTS !== 'true'

const test = shouldSkip ? ava.skip : ava
const serialTest = shouldSkip ? ava.serial.skip : ava.serial

const __dirname = dirname(fileURLToPath(import.meta.url))
const ITERATIONS = 500

// ============================================================================
// Fix #1: Canvas-pattern shader bitmap leak (stack-allocated SkBitmap)
// Exercises: skiac_image_make_pattern_shader sampling a canvas snapshot
// Risk: dangling pointer if SkBitmap scope is wrong
// ============================================================================
test('stress: createPattern with canvas source should not crash (bitmap shader fix)', (t) => {
  const canvas = createCanvas(256, 256)
  const ctx = canvas.getContext('2d')!
  const patternCanvas = createCanvas(32, 32)
  const patternCtx = patternCanvas.getContext('2d')!

  for (let i = 0; i < ITERATIONS; i++) {
    patternCtx.fillStyle = `rgb(${i % 256}, ${(i * 7) % 256}, ${(i * 13) % 256})`
    patternCtx.fillRect(0, 0, 32, 32)

    const pattern = ctx.createPattern(patternCanvas, 'repeat')!
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, 256, 256)
  }

  t.pass(`Completed ${ITERATIONS} canvas-pattern shader cycles without crash`)
})

// ============================================================================
// Fix #2: SVG bitmap decode stream leak (stack-allocated SkMemoryStream)
// Exercises: skiac_bitmap_make_from_svg
// Risk: use-after-free if stack stream is used after destruction
// ============================================================================
test('stress: SVG image decode should not crash (SVG decode stream fix)', async (t) => {
  const svgData = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
      '<rect width="100" height="100" fill="red"/>' +
      '<circle cx="50" cy="50" r="40" fill="blue"/>' +
      '</svg>',
  )

  for (let i = 0; i < ITERATIONS; i++) {
    const image = new Image()
    image.src = svgData
    await image.decode()
    // Draw it to exercise the full pipeline
    const canvas = createCanvas(100, 100)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
  }

  t.pass(`Completed ${ITERATIONS} SVG image decode cycles without crash`)
})

// ============================================================================
// Fix #3: convertSVGTextToPath stream leaks (stack-allocated streams)
// Exercises: skiac_svg_text_to_path
// Risk: use-after-free if stack streams are used after destruction
// ============================================================================
test('stress: convertSVGTextToPath should not crash (text-to-path stream fix)', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  const svgFixture = readFileSync(join(__dirname, 'text.svg'), 'utf8')

  for (let i = 0; i < ITERATIONS; i++) {
    const result = convertSVGTextToPath(svgFixture)
    t.truthy(result.length > 0)
  }

  t.pass(`Completed ${ITERATIONS} convertSVGTextToPath cycles without crash`)
})

// ============================================================================
// Fix #4: SVGCanvas lifecycle canvas leak (is_svg + Drop)
// Exercises: SVGCanvas creation, getContent, resize, and drop
// Risk: double-free if canvas pointer not nulled after manual destroy
// ============================================================================
test('stress: SVGCanvas getContent + drop should not double-free', (t) => {
  for (let i = 0; i < ITERATIONS; i++) {
    const canvas: SvgCanvas = createCanvas(200, 200, SvgExportFlag.ConvertTextToPaths)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'red'
    ctx.fillRect(0, 0, 200, 200)

    // getContent destroys the canvas, creates a new one, then object is dropped
    // This tests the null-out-after-destroy + Drop interaction
    const content = canvas.getContent()
    t.truthy(content.length > 0)
  }
  // If we get here without SIGSEGV/SIGABRT, no double-free
  t.pass(`Completed ${ITERATIONS} SVGCanvas getContent+drop cycles without crash`)
})

test('stress: SVGCanvas resize should not leak or double-free', (t) => {
  for (let i = 0; i < ITERATIONS; i++) {
    const canvas: SvgCanvas = createCanvas(200, 200, SvgExportFlag.ConvertTextToPaths)
    const ctx = canvas.getContext('2d')
    ctx.fillRect(0, 0, 200, 200)

    // Resize triggers mem::replace which drops old Context
    // The old SVG canvas must be destroyed in Drop without double-free
    canvas.width = 100 + (i % 100)
    canvas.height = 100 + (i % 100)

    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const content = canvas.getContent()
    t.truthy(content.length > 0)
  }

  t.pass(`Completed ${ITERATIONS} SVGCanvas resize cycles without crash`)
})

test('stress: SVGCanvas drop without getContent should not leak or crash', (t) => {
  for (let i = 0; i < ITERATIONS; i++) {
    // Create, draw, then let it be GC'd WITHOUT calling getContent
    // This exercises the Drop path where canvas pointer is non-null
    const canvas: SvgCanvas = createCanvas(128, 128, SvgExportFlag.ConvertTextToPaths)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = `hsl(${i % 360}, 80%, 50%)`
    ctx.fillRect(0, 0, 128, 128)
    // canvas goes out of scope — Drop should clean up SVG canvas
  }

  t.pass(`Completed ${ITERATIONS} SVGCanvas drop-without-getContent cycles without crash`)
})

// ============================================================================
// Fix #5: SVG surface creation error-path leak (delete w_stream on error)
// Hard to trigger since SkSVGCanvas::Make rarely fails with valid dimensions.
// We test the success path heavily to ensure the normal path is unaffected.
// ============================================================================
test('stress: SVGCanvas creation at various sizes should not crash', (t) => {
  for (let i = 0; i < ITERATIONS; i++) {
    const w = 1 + (i % 500)
    const h = 1 + ((i * 7) % 500)
    const canvas: SvgCanvas = createCanvas(w, h, SvgExportFlag.ConvertTextToPaths)
    const ctx = canvas.getContext('2d')
    ctx.fillRect(0, 0, w, h)
    const content = canvas.getContent()
    t.truthy(content.length > 0)
  }

  t.pass(`Completed ${ITERATIONS} SVGCanvas creation cycles without crash`)
})

// ============================================================================
// Fix #6: Path2D CString leak (CString::from_raw after FFI)
// Exercises: Path::from_svg_path
// Risk: use-after-free if CString is reclaimed before C++ reads it
// ============================================================================
test('stress: Path2D from SVG string should not crash (CString fix)', (t) => {
  const paths = [
    'M 10 80 C 40 10, 65 10, 95 80 S 150 150, 180 80',
    'M 0 0 L 100 0 L 100 100 L 0 100 Z',
    'M108.956,403.826c0,0,0.178,3.344-1.276,3.311c-1.455-0.033-30.507-84.917-66.752-80.957',
    'M 10 10 H 90 V 90 H 10 Z',
    'M 50 0 A 50 50 0 1 0 50 100 A 50 50 0 1 0 50 0',
  ]

  for (let i = 0; i < ITERATIONS; i++) {
    const svgPath = paths[i % paths.length]
    const p = new Path2D(svgPath)

    // Also use the path to ensure it's valid
    const canvas = createCanvas(200, 200)
    const ctx = canvas.getContext('2d')!
    ctx.fill(p)
  }

  t.pass(`Completed ${ITERATIONS} Path2D SVG string cycles without crash`)
})

// ============================================================================
// Fix #7: save_png SkImage leak (image.get() instead of image.release())
// Exercises: skiac_surface_save
// Risk: if sk_sp is prematurely destroyed, image becomes invalid during encode
// ============================================================================
test('stress: savePng should not crash (SkImage lifetime fix)', (t) => {
  const tmpPath = join(tmpdir(), `canvas-stress-test-${Date.now()}.png`)

  try {
    const canvas = createCanvas(128, 128)
    const ctx = canvas.getContext('2d')!

    for (let i = 0; i < ITERATIONS; i++) {
      ctx.fillStyle = `rgb(${i % 256}, ${(i * 3) % 256}, ${(i * 7) % 256})`
      ctx.fillRect(0, 0, 128, 128)
      ctx.strokeStyle = 'white'
      ctx.strokeRect(10, 10, 108, 108)

      // This calls skiac_surface_save which we fixed
      ;(canvas as any).savePng(tmpPath)
    }

    t.pass(`Completed ${ITERATIONS} savePng cycles without crash`)
  } finally {
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath)
    }
  }
})

// Also test the encode path (skiac_surface_png_data / skiac_surface_encode_data)
// to ensure those existing correct paths still work
test('stress: encodeSync png/jpeg/webp should not crash', (t) => {
  const canvas = createCanvas(128, 128)
  const ctx = canvas.getContext('2d')!

  for (let i = 0; i < ITERATIONS; i++) {
    ctx.fillStyle = `hsl(${i % 360}, 70%, 50%)`
    ctx.fillRect(0, 0, 128, 128)

    const png = canvas.encodeSync('png')
    t.truthy(png.length > 0)

    const jpeg = canvas.encodeSync('jpeg', 80)
    t.truthy(jpeg.length > 0)

    const webp = canvas.encodeSync('webp', 80)
    t.truthy(webp.length > 0)
  }

  t.pass(`Completed ${ITERATIONS} encodeSync cycles without crash`)
})

// ============================================================================
// Fix #8: EXIF canvas leak (delete canvas after drawImage)
// Exercises: skiac_bitmap_make_from_buffer with EXIF orientation
// Risk: if canvas is deleted too early, drawImage writes to freed memory
// ============================================================================
test('stress: EXIF-rotated JPEG decode should not crash (EXIF canvas fix)', async (t) => {
  const exifJpeg = readFileSync(join(__dirname, 'fixtures', 'with-exif.jpg'))

  for (let i = 0; i < ITERATIONS; i++) {
    const image = new Image()
    image.src = exifJpeg
    await image.decode()

    // Draw the decoded image to verify it's valid
    const canvas = createCanvas(image.width, image.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
  }

  t.pass(`Completed ${ITERATIONS} EXIF JPEG decode cycles without crash`)
})

// ============================================================================
// Combined stress: exercise multiple fixed paths in interleaved sequence
// This is the most likely to trigger double-free if ownership is confused
// ============================================================================
test('stress: combined interleaved operations should not crash', async (t) => {
  const exifJpeg = readFileSync(join(__dirname, 'fixtures', 'with-exif.jpg'))
  const svgData = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
      '<circle cx="32" cy="32" r="30" fill="green"/></svg>',
  )

  for (let i = 0; i < 200; i++) {
    // Path2D from string
    const path = new Path2D('M 0 0 L 50 50 L 100 0 Z')

    // Canvas pattern from canvas
    const srcCanvas = createCanvas(64, 64)
    const srcCtx = srcCanvas.getContext('2d')!
    srcCtx.fillStyle = 'blue'
    srcCtx.fill(path)

    const dstCanvas = createCanvas(256, 256)
    const dstCtx = dstCanvas.getContext('2d')!
    const pattern = dstCtx.createPattern(srcCanvas, 'repeat')!
    dstCtx.fillStyle = pattern
    dstCtx.fillRect(0, 0, 256, 256)

    // Encode
    dstCanvas.encodeSync('png')

    // SVG canvas
    const svgCanvas: SvgCanvas = createCanvas(128, 128, SvgExportFlag.ConvertTextToPaths)
    const svgCtx = svgCanvas.getContext('2d')
    svgCtx.fillRect(0, 0, 128, 128)
    svgCanvas.width = 64
    svgCanvas.getContent()

    // SVG image decode
    const svgImg = new Image()
    svgImg.src = svgData
    await svgImg.decode()

    // EXIF decode
    const exifImg = new Image()
    exifImg.src = exifJpeg
    await exifImg.decode()
    dstCtx.drawImage(exifImg, 0, 0, 256, 256)
  }

  t.pass('Completed 200 combined interleaved cycles without crash')
})

// ============================================================================
// A failed AVIF decode frees the libavif decoder and image
// Exercises: AvifImage::decode_from returning early on a truncated file
// Risk: every failed decode leaked the decoder (base: +36 MB in 10000 decodes)
// ============================================================================
serialTest('stress: failed AVIF decodes do not leak', async (t) => {
  const avif = readFileSync(join(__dirname, 'fixtures', 'avif-cicp-1-1-6.avif'))
  const truncated = avif.subarray(0, Math.floor(avif.length * 0.6))
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  const decodeOnce = () =>
    new Promise<void>((resolve, reject) => {
      const image = new Image()
      image.onload = () => reject(new Error('a truncated AVIF must not load'))
      image.onerror = () => resolve()
      image.src = truncated
    })
  const rss: number[] = []
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 5000; i++) await decodeOnce()
    gc()
    rss.push(process.memoryUsage().rss / 1048576)
  }
  // Round 0 warms up the allocator; base grew 36 MB from round 1 to 3.
  // Serial: RSS is process-wide, so a concurrent async test would add its own memory.
  t.true(rss[3] - rss[1] < 25, `RSS MB per round: ${rss.map((v) => v.toFixed(1)).join(', ')}`)
})

// ============================================================================
// Text layout: the line cache, the shaper's HarfBuzz fonts and its system
// fallback cache stay within their budgets
// Exercises: LayOutLine / LayOutLineBlink (NAPI_RS_CANVAS_SHAPER=blink) with
// font-variation instances, family fallback and, on macOS, system fallback
// Risk: a cache that keeps every font or line it saw (DESIGN-SHAPER.md 6.2)
// ============================================================================
serialTest('stress: text layout with fallback does not grow from N to 2N lines', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf'), 'StressMono')
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceHanSerifCN-Bold.ttf'), 'StressHan')
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  // Hebrew, Thai and Devanagari have no family font: system fallback on
  // macOS, the first font's .notdef elsewhere. PUA has no fallback anywhere.
  const tails = ['水', 'שלום', 'สวัสดี', 'नमस्ते', '😀', '⌚︎', '\uE000', 'a☺️b']
  setTextRenderer('system')
  try {
    const ctx = createCanvas(200, 50).getContext('2d')
    let line = 0
    const round = async (n: number) => {
      for (let i = 0; i < n; i++, line++) {
        ctx.font = `${100 + (line % 600)} 16px StressMono, StressHan`
        ctx.measureText(`line ${line} ${tails[line % tails.length]} ${line * 7}`)
        ctx.fillText(`d${line}${tails[(line + 3) % tails.length]}`, 10, 30)
        if (i % 100 === 0) await new Promise(setImmediate)
      }
      gc()
      return process.memoryUsage().rss / 1048576
    }
    // Round 0 warms up the caches; then N lines, then 2N more.
    const rss = [await round(3000), await round(3000), await round(6000)]
    t.true(rss[2] - rss[1] < 25, `RSS MB after warm-up, N, 2N: ${rss.map((v) => v.toFixed(1)).join(', ')}`)
  } finally {
    setTextRenderer('portable')
  }
})

// ============================================================================
// Text layout: more system fallback keys than the results cache holds
// Exercises: the shaper's system fallback cache (NAPI_RS_CANVAS_SHAPER=blink,
// macOS) under eviction while the font arguments' caches drop and remake the
// primary instances
// Risk: CoreText keeps about 4 KB for each CTFont it found a fallback from;
// asking again with a remade instance grew RSS by about 4 MB per 1000 lines
// ============================================================================
serialTest('stress: system fallback past its cache budget does not grow from N to 2N lines', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf'), 'StressFallbackMono')
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  setTextRenderer('system')
  try {
    const ctx = createCanvas(200, 50).getContext('2d')
    let line = 0
    const round = async (n: number) => {
      for (let i = 0; i < n; i++, line++) {
        // 1025 weights, each a fallback key for the Thai text and a font
        // argument list (past the 256 that drop the caches).
        ctx.font = `${100 + (line % 1025) / 2} 16px StressFallbackMono`
        ctx.measureText(`สวัสดี ${line}`)
        if (i % 100 === 0) await new Promise(setImmediate)
      }
      gc()
      return process.memoryUsage().rss / 1048576
    }
    // Round 0 warms up the caches; then N lines, then 2N more.
    const rss = [await round(3075), await round(3000), await round(6000)]
    // The CoreText risk exists only on macOS, which keeps the tight bound.
    // Elsewhere (no system fallback source) the bound is the one of the test
    // above: Windows x64 CI, switch unset, gave 154.9, 145.5, 156.0 (+10.5)
    // on a path this test does not guard.
    const bound = process.platform === 'darwin' ? 10 : 25
    t.true(rss[2] - rss[1] < bound, `RSS MB after warm-up, N, 2N: ${rss.map((v) => v.toFixed(1)).join(', ')}`)
  } finally {
    setTextRenderer('portable')
  }
})

// ============================================================================
// Text layout: system fallback results dropped while a few primary fonts stay
// in use
// Exercises: the CoreText input the shaper keeps per primary font made from
// data (family face and axes), NAPI_RS_CANVAS_SHAPER=blink on macOS
// Risk: 60 weights x 73 code points (4380 keys) cycle through the results,
// and 4000 more weights on the cold lines drop the font arguments' caches
// (past 256 lists) and push the hot instances out of skia's caches; asking
// CoreText with each remade instance kept about 4 KB per instance
// ============================================================================
serialTest('stress: system fallback with remade primary instances does not grow from N to 2N lines', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf'), 'StressFallbackMono')
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  const chars: string[] = []
  for (const [first, last] of [
    [0x0e01, 0x0e2e],
    [0x05d0, 0x05ea],
  ]) {
    for (let c = first; c <= last; c++) chars.push(String.fromCodePoint(c))
  }
  setTextRenderer('system')
  try {
    const ctx = createCanvas(200, 50).getContext('2d')
    let line = 0
    const round = async (n: number) => {
      for (let i = 0; i < n; i++, line++) {
        ctx.font = `${100 + (line % 60)} 16px StressFallbackMono`
        ctx.measureText(`${chars[Math.floor(line / 60) % chars.length]} ${line}`)
        for (const cold of [0, 1]) {
          ctx.font = `${300 + ((2 * line + cold) % 4000) / 10} 16px StressFallbackMono`
          ctx.measureText(`cold ${line}`)
        }
        if (i % 100 === 0) await new Promise(setImmediate)
      }
      gc()
      return process.memoryUsage().rss / 1048576
    }
    // Round 0 warms up the caches; then N lines, then 2N more.
    const rss = [await round(4380), await round(8760), await round(17520)]
    t.true(rss[2] - rss[1] < 14, `RSS MB after warm-up, N, 2N: ${rss.map((v) => v.toFixed(1)).join(', ')}`)
  } finally {
    setTextRenderer('portable')
  }
})

// ============================================================================
// Text layout: system fallback past both of its old budgets (64 primary
// fonts kept as CoreText inputs, 4096 results)
// Exercises: the CoreText input of a primary font made from data
// (NAPI_RS_CANVAS_SHAPER=blink on macOS) when every result lookup misses and
// the primary instances are remade
// Risk: 65 weights x 73 code points (4745 keys) miss every time, and the cold
// lines remake the hot instances; asking CoreText with a remade instance kept
// about 4 KB per call (RSS +25 MB from N to 2N, the old path +4 MB)
// ============================================================================
serialTest('stress: system fallback past both cache budgets does not grow from N to 2N lines', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf'), 'StressFallbackMono')
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  const chars: string[] = []
  for (const [first, last] of [
    [0x0e01, 0x0e2e],
    [0x05d0, 0x05ea],
  ]) {
    for (let c = first; c <= last; c++) chars.push(String.fromCodePoint(c))
  }
  setTextRenderer('system')
  try {
    const ctx = createCanvas(200, 50).getContext('2d')
    let line = 0
    const round = async (n: number) => {
      for (let i = 0; i < n; i++, line++) {
        ctx.font = `${100 + (line % 65)} 16px StressFallbackMono`
        ctx.measureText(`${chars[Math.floor(line / 65) % chars.length]} ${line}`)
        for (const cold of [0, 1]) {
          ctx.font = `${300 + ((2 * line + cold) % 4000) / 10} 16px StressFallbackMono`
          ctx.measureText(`cold ${line}`)
        }
        if (i % 100 === 0) await new Promise(setImmediate)
      }
      gc()
      return process.memoryUsage().rss / 1048576
    }
    // Round 0 warms up the caches; then N lines, then 2N more.
    const rss = [await round(4745), await round(9490), await round(18980)]
    t.true(rss[2] - rss[1] < 12, `RSS MB after warm-up, N, 2N: ${rss.map((v) => v.toFixed(1)).join(', ')}`)
  } finally {
    setTextRenderer('portable')
  }
})

// ============================================================================
// Text layout: system fallback with a new primary variation on every line
// Exercises: the CGFonts the shaper keeps as CoreText inputs per primary font
// made from data (NAPI_RS_CANVAS_SHAPER=blink on macOS), past their budget
// of 1024
// Risk: one kept CGFont per variation, never dropped (RSS +14 MB over 800
// weights). CoreText's own part, about 5 KB for every new CGFont it finds a
// fallback from, stays: any input that is the real variation is a new CGFont
// (+4.5 MB over 800 weights; the old path +1 MB)
// ============================================================================
serialTest('stress: system fallback with a new primary variation per line stays within its budget', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf'), 'StressFallbackMono')
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  setTextRenderer('system')
  try {
    const ctx = createCanvas(200, 50).getContext('2d')
    let line = 0
    const round = async (n: number) => {
      for (let i = 0; i < n; i++, line++) {
        // A weight step of 0.25 (FontSelectionValue) is a new variation.
        ctx.font = `${100 + line / 4} 16px StressFallbackMono`
        ctx.measureText(`สวัสดี ${line}`)
        if (i % 100 === 0) await new Promise(setImmediate)
      }
      gc()
      return process.memoryUsage().rss / 1048576
    }
    // Round 0 fills the 1024 kept CGFonts; then N new weights, then 2N more
    // (weights 100 to 700).
    const rss = [await round(1200), await round(400), await round(800)]
    t.true(rss[2] - rss[1] < 10, `RSS MB after warm-up, N, 2N: ${rss.map((v) => v.toFixed(1)).join(', ')}`)
  } finally {
    setTextRenderer('portable')
  }
})
