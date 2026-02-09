import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { default as ava } from 'ava'

import {
  createCanvas,
  Path2D,
  Image,
  GlobalFonts,
  SvgExportFlag,
  SvgCanvas,
  convertSVGTextToPath,
} from '../index'

const shouldSkip = process.env.RUN_STRESS_TESTS !== 'true'

const test = shouldSkip ? ava.skip : ava

const __dirname = dirname(fileURLToPath(import.meta.url))
const ITERATIONS = 500

// ============================================================================
// Fix #1: Canvas-pattern shader bitmap leak (stack-allocated SkBitmap)
// Exercises: skiac_bitmap_get_shader with is_canvas=true
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

    const pattern = ctx.createPattern(patternCanvas, 'repeat')
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
    const pattern = dstCtx.createPattern(srcCanvas, 'repeat')
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
