import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'
import PNG from '@jimp/png'

import { createCanvas, loadImage, GlobalFonts, Image, ImageData, DOMMatrix, DOMPoint, SKRSContext2D } from '../index'
import { snapshotImage } from './image-snapshot'

const __dirname = dirname(fileURLToPath(import.meta.url))

// https://github.com/Brooooooklyn/canvas/issues/1250
test('drawImage with imageSmoothingEnabled should not produce gray halo around transparent PNG edges', async (t) => {
  // Build a small PNG whose transparent pixels have RGB=(0,0,0) underneath — the
  // standard storage for PNG images with transparency. A 10x10 image with a 6x6
  // opaque-white interior (x,y ∈ [2,8)) and a fully-transparent (0,0,0,0) border.
  const SRC = 10
  const srcCanvas = createCanvas(SRC, SRC)
  const srcCtx = srcCanvas.getContext('2d')
  const srcData = srcCtx.createImageData(SRC, SRC)
  for (let y = 0; y < SRC; y++) {
    for (let x = 0; x < SRC; x++) {
      const i = (y * SRC + x) * 4
      const inside = x >= 2 && x < 8 && y >= 2 && y < 8
      if (inside) {
        srcData.data[i] = 255
        srcData.data[i + 1] = 255
        srcData.data[i + 2] = 255
        srcData.data[i + 3] = 255
      }
      // else: leave as (0,0,0,0) — transparent black, the classic halo-causing pattern
    }
  }
  srcCtx.putImageData(srcData, 0, 0)
  const pngBuffer = srcCanvas.toBuffer('image/png')

  // Draw the PNG scaled 10x (10→100) with high-quality smoothing onto a white
  // background. With unpremultiplied-alpha sampling the transparent black pixels
  // bleed into the edge, producing a visible gray halo.
  const image = await loadImage(pngBuffer)
  const DST = 100
  const dstCanvas = createCanvas(DST, DST)
  const dstCtx = dstCanvas.getContext('2d')
  dstCtx.fillStyle = '#ffffff'
  dstCtx.fillRect(0, 0, DST, DST)
  dstCtx.imageSmoothingEnabled = true
  dstCtx.imageSmoothingQuality = 'high'
  dstCtx.drawImage(image, 0, 0, DST, DST)

  // Probe a pixel in the halo zone: destination (18, 50) lies inside the
  // transparent border region (source x≈1.8, transparent) but close to the
  // opaque-white interior edge (source x=2). With the bug the cubic filter
  // mixes opaque white RGB with black-but-transparent neighbors, then composites
  // the resulting semi-transparent gray onto the white background, yielding a
  // pixel noticeably darker than white. With correct premultiplied sampling the
  // pixel should remain very close to the white background.
  const halo = dstCtx.getImageData(18, 50, 1, 1).data
  t.true(halo[0] >= 250, `halo R should be ~255 (white bg), got ${halo[0]}`)
  t.true(halo[1] >= 250, `halo G should be ~255 (white bg), got ${halo[1]}`)
  t.true(halo[2] >= 250, `halo B should be ~255 (white bg), got ${halo[2]}`)
})

// https://github.com/Brooooooklyn/canvas/issues/1210
test('putImageData should not blend opaque pixels with semi-transparent neighbors', (t) => {
  // Simulate pdfjs putBinaryImageData: canvas filled in 16-row chunks,
  // each chunk has MIXED pixels — mostly semi-transparent (edge/anti-alias
  // pixels from SMask) plus one fully opaque content pixel.
  const WIDTH = 20
  const CHUNK_HEIGHT = 16
  const NUM_CHUNKS = 3
  const canvas = createCanvas(WIDTH, CHUNK_HEIGHT * NUM_CHUNKS)
  const ctx = canvas.getContext('2d')

  for (let c = 0; c < NUM_CHUNKS; c++) {
    const imgData = ctx.createImageData(WIDTH, CHUNK_HEIGHT)
    // Fill with semi-transparent light gray (alpha=14)
    for (let i = 0; i < imgData.data.length; i += 4) {
      imgData.data[i] = 230
      imgData.data[i + 1] = 229
      imgData.data[i + 2] = 229
      imgData.data[i + 3] = 14
    }
    // One fully opaque dark pixel in the middle
    const idx = (8 * WIDTH + 10) * 4
    const v = 50 + c * 48
    imgData.data[idx] = v
    imgData.data[idx + 1] = v
    imgData.data[idx + 2] = v
    imgData.data[idx + 3] = 255
    ctx.putImageData(imgData, 0, c * CHUNK_HEIGHT)
  }

  const pngCodec = PNG()
  const decoded = pngCodec.decoders['image/png'](canvas.toBuffer('image/png'))
  for (let c = 0; c < NUM_CHUNKS; c++) {
    const row = c * CHUNK_HEIGHT + 8
    const idx = (row * WIDTH + 10) * 4
    const expected = 50 + c * 48
    t.is(decoded.data[idx], expected, `Chunk ${c}: R should be ${expected}`)
    t.is(decoded.data[idx + 1], expected, `Chunk ${c}: G should be ${expected}`)
    t.is(decoded.data[idx + 2], expected, `Chunk ${c}: B should be ${expected}`)
    t.is(decoded.data[idx + 3], 255, `Chunk ${c}: A should be 255`)
  }
})

// https://github.com/Brooooooklyn/canvas/issues/1212
test('putImageData should snapshot pixel data when the same ImageData is reused', (t) => {
  const CHUNK_HEIGHT = 16
  const width = 100
  const height = 80 // 5 chunks of 16 rows
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')

  // Build a simple RGB gradient as source data
  const src = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      src[i] = ((x * 255) / width) | 0 // R: horizontal gradient
      src[i + 1] = ((y * 255) / height) | 0 // G: vertical gradient
      src[i + 2] = 128 // B: constant
    }
  }

  // Reuse the same ImageData object across all putImageData calls (as pdfjs-dist does)
  const chunkImgData = ctx.createImageData(width, CHUNK_HEIGHT)
  const dest = chunkImgData.data
  let srcPos = 0
  for (let i = 0; i < height / CHUNK_HEIGHT; i++) {
    let destPos = 0
    for (let j = width * CHUNK_HEIGHT; j--; ) {
      dest[destPos++] = src[srcPos++]
      dest[destPos++] = src[srcPos++]
      dest[destPos++] = src[srcPos++]
      dest[destPos++] = 255
    }
    ctx.putImageData(chunkImgData, 0, i * CHUNK_HEIGHT)
  }

  // Verify pixel at (0, 0) — should be R≈0, G≈0, B=128 (first chunk)
  const result = ctx.getImageData(0, 0, width, height)
  t.is(result.data[0], 0, 'Pixel (0,0) R should be 0')
  t.is(result.data[1], 0, 'Pixel (0,0) G should be 0 (not from last chunk)')
  t.is(result.data[2], 128, 'Pixel (0,0) B should be 128')

  // Verify a pixel in the middle chunk (chunk 2, y=32)
  const midIdx = (32 * width + 50) * 4
  const expectedR = ((50 * 255) / width) | 0
  const expectedG = ((32 * 255) / height) | 0
  t.is(result.data[midIdx], expectedR, `Pixel (50,32) R should be ${expectedR}`)
  t.is(result.data[midIdx + 1], expectedG, `Pixel (50,32) G should be ${expectedG}`)
  t.is(result.data[midIdx + 2], 128, 'Pixel (50,32) B should be 128')
})

// https://github.com/Brooooooklyn/canvas/issues/1204
test('putImageData should modify the canvas', (t) => {
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')

  // Fill canvas with red
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 100, 100)

  // Get image data and modify to green
  const imageData = ctx.getImageData(0, 0, 10, 10)
  for (let i = 0; i < imageData.data.length; i += 4) {
    imageData.data[i] = 0 // R
    imageData.data[i + 1] = 255 // G
    imageData.data[i + 2] = 0 // B
    imageData.data[i + 3] = 255 // A
  }

  // putImageData should replace pixels at (0,0)
  ctx.putImageData(imageData, 0, 0)

  // Read back and verify the pixels were actually written
  const result = ctx.getImageData(0, 0, 1, 1)
  t.is(result.data[0], 0, 'R should be 0 (green)')
  t.is(result.data[1], 255, 'G should be 255 (green)')
  t.is(result.data[2], 0, 'B should be 0 (green)')
  t.is(result.data[3], 255, 'A should be 255')
})

// https://github.com/Brooooooklyn/canvas/issues/1204
test('putImageData with dirty rect should modify the canvas', (t) => {
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')

  // Fill canvas with blue
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 100, 100)

  // Create green image data
  const imageData = ctx.getImageData(0, 0, 20, 20)
  for (let i = 0; i < imageData.data.length; i += 4) {
    imageData.data[i] = 0 // R
    imageData.data[i + 1] = 255 // G
    imageData.data[i + 2] = 0 // B
    imageData.data[i + 3] = 255 // A
  }

  // putImageData with dirty rect
  ctx.putImageData(imageData, 10, 10, 0, 0, 10, 10)

  // Pixel at (15, 15) should be green (inside dirty rect)
  const inside = ctx.getImageData(15, 15, 1, 1)
  t.is(inside.data[0], 0, 'R should be 0 (green) inside dirty rect')
  t.is(inside.data[1], 255, 'G should be 255 (green) inside dirty rect')
  t.is(inside.data[2], 0, 'B should be 0 (green) inside dirty rect')
  t.is(inside.data[3], 255, 'A should be 255 inside dirty rect')

  // Pixel at (25, 25) should still be blue (outside dirty rect)
  const outside = ctx.getImageData(25, 25, 1, 1)
  t.is(outside.data[0], 0, 'R should be 0 (blue) outside dirty rect')
  t.is(outside.data[1], 0, 'G should be 0 (blue) outside dirty rect')
  t.is(outside.data[2], 255, 'B should be 255 (blue) outside dirty rect')
  t.is(outside.data[3], 255, 'A should be 255 outside dirty rect')
})

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

// https://github.com/Brooooooklyn/canvas/issues/1112
test('DOMMatrix::invertSelf should return self for non-invertible matrices', (t) => {
  // Test invertible matrix - should modify this and return this
  const invertibleMatrix = new DOMMatrix([2, 0, 0, 2, 10, 10])
  const originalInvertible = invertibleMatrix
  const result1 = invertibleMatrix.invertSelf()

  t.is(result1, originalInvertible, 'invertSelf should return the same object for invertible matrix')
  t.is(invertibleMatrix.a, 0.5, 'Matrix should be modified in place for invertible matrix')
  t.is(invertibleMatrix.e, -5, 'Matrix translation should be inverted')

  // Test non-invertible matrix - should set to NaN and return this (not undefined)
  const nonInvertibleMatrix = new DOMMatrix([0, 0, 0, 0, 100, 200])
  const originalNonInvertible = nonInvertibleMatrix
  const result2 = nonInvertibleMatrix.invertSelf()

  t.is(result2, originalNonInvertible, 'invertSelf should return the same object for non-invertible matrix')
  t.not(result2, undefined, 'invertSelf should not return undefined for non-invertible matrix')
  t.true(Number.isNaN(nonInvertibleMatrix.a), 'Non-invertible matrix elements should be NaN')
  t.false(nonInvertibleMatrix.is2D, 'Non-invertible matrix should have is2D set to false')

  // Test destructuring (what was failing in pdf.js)
  t.notThrows(() => {
    const { a } = result2
    t.true(Number.isNaN(a), 'Destructured values should be NaN')
  }, 'Should be able to destructure result of invertSelf on non-invertible matrix')
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

// https://github.com/Brooooooklyn/canvas/issues/1226
test('putImageData with negative dx/dy should draw correctly', (t) => {
  const canvas = createCanvas(200, 200)
  const ctx = canvas.getContext('2d')
  // Fill canvas with black
  ctx.fillStyle = 'black'
  ctx.fillRect(0, 0, 200, 200)
  // Create a 100x100 white ImageData
  const imageData = new ImageData(100, 100)
  imageData.data.fill(255)
  // putImageData at (-20, -20): should place an 80x80 white region at (0,0)
  ctx.putImageData(imageData, -20, -20)
  // Pixel at (0,0) should be white (within the drawn region)
  const topLeft = ctx.getImageData(0, 0, 1, 1).data
  t.is(topLeft[0], 255)
  t.is(topLeft[1], 255)
  t.is(topLeft[2], 255)
  t.is(topLeft[3], 255)
  // Pixel at (79,79) should be white (last pixel of the drawn region)
  const edge = ctx.getImageData(79, 79, 1, 1).data
  t.is(edge[0], 255)
  t.is(edge[1], 255)
  t.is(edge[2], 255)
  t.is(edge[3], 255)
  // Pixel at (80,80) should be black (outside the drawn region)
  const outside = ctx.getImageData(80, 80, 1, 1).data
  t.is(outside[0], 0)
  t.is(outside[1], 0)
  t.is(outside[2], 0)
  t.is(outside[3], 255)
})

// https://github.com/Brooooooklyn/canvas/issues/1226
test('getImageData with negative x/y should return correct pixels', (t) => {
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')
  // Fill entire canvas red
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 100, 100)
  // getImageData(-10, -10, 20, 20): top-left 10x10 is outside canvas (transparent black),
  // bottom-right 10x10 is canvas pixels (red)
  const data = ctx.getImageData(-10, -10, 20, 20)
  t.is(data.width, 20)
  t.is(data.height, 20)
  // Pixel at (0,0) in the ImageData corresponds to canvas (-10,-10) — outside, should be transparent black
  const outOfBounds = [data.data[0], data.data[1], data.data[2], data.data[3]]
  t.deepEqual(outOfBounds, [0, 0, 0, 0])
  // Pixel at (5,5) in the ImageData is still outside canvas (-5,-5) — transparent black
  const stillOutside = 4 * (5 * 20 + 5)
  t.deepEqual(
    [data.data[stillOutside], data.data[stillOutside + 1], data.data[stillOutside + 2], data.data[stillOutside + 3]],
    [0, 0, 0, 0],
  )
  // Pixel at (10,10) in the ImageData corresponds to canvas (0,0) — should be red
  const insideOffset = 4 * (10 * 20 + 10)
  t.is(data.data[insideOffset], 255) // R
  t.is(data.data[insideOffset + 1], 0) // G
  t.is(data.data[insideOffset + 2], 0) // B
  t.is(data.data[insideOffset + 3], 255) // A
  // Pixel at (19,19) in the ImageData corresponds to canvas (9,9) — should be red
  const cornerOffset = 4 * (19 * 20 + 19)
  t.is(data.data[cornerOffset], 255) // R
  t.is(data.data[cornerOffset + 1], 0) // G
  t.is(data.data[cornerOffset + 2], 0) // B
  t.is(data.data[cornerOffset + 3], 255) // A
})

test('getImageData with negative width/height should flip the region per spec', (t) => {
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')
  // Paint a 10x10 green square at (5,5)
  ctx.fillStyle = 'green'
  ctx.fillRect(5, 5, 10, 10)
  // getImageData(15, 15, -10, -10) per spec: sx=15+(-10)=5, sy=15+(-10)=5, sw=10, sh=10
  // Should return the 10x10 region starting at (5,5) — the green square
  const data = ctx.getImageData(15, 15, -10, -10)
  t.is(data.width, 10)
  t.is(data.height, 10)
  t.is(data.data.length, 10 * 10 * 4)
  // Center pixel (5,5) in the ImageData should be green
  const centerOffset = 4 * (5 * 10 + 5)
  t.is(data.data[centerOffset], 0) // R
  t.is(data.data[centerOffset + 1], 128) // G (green is 0,128,0)
  t.is(data.data[centerOffset + 2], 0) // B
  t.is(data.data[centerOffset + 3], 255) // A
})

test('createImageData with negative dimensions should use absolute values', (t) => {
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(-50, -30)
  t.is(imageData.width, 50)
  t.is(imageData.height, 30)
  t.is(imageData.data.length, 50 * 30 * 4)
})

// https://github.com/Brooooooklyn/canvas/issues/987
test('draw-canvas-on-canvas', async (t) => {
  const backCanvas = createCanvas(1920, 1080)
  const backCtx = backCanvas.getContext('2d')

  const picCanvas = createCanvas(640, 480)
  const picCtx = picCanvas.getContext('2d')

  backCtx.fillStyle = '#000000'
  backCtx.fillRect(0, 0, 1920, 1080)

  // load images from disk or from a URL
  const catImage = await loadImage(join(__dirname, 'javascript.png'))

  picCtx.drawImage(catImage, 0, 0, catImage.width, catImage.height)

  backCtx.drawImage(picCanvas, 240, 0, 1440, 1080)

  await snapshotImage(t, { ctx: backCtx, canvas: backCanvas })
})

// https://github.com/Brooooooklyn/canvas/issues/1000
test('transform-with-non-inverted-matrix', (t) => {
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')
  t.notThrows(() => {
    ctx.transform(0, 0, 0, 0, 1019, 1165)
  })
})

// https://github.com/Brooooooklyn/canvas/issues/996
test('draw-avif-image', async (t) => {
  const canvas = createCanvas(1920, 1080)
  const ctx = canvas.getContext('2d')
  const image = await loadImage(join(__dirname, 'fixtures', 'issue-996.avif'))
  ctx.drawImage(image, 0, 0)
  await snapshotImage(t, { ctx, canvas })
})

// https://github.com/Brooooooklyn/canvas/issues/1010
test('canvas-pattern-1010', async (t) => {
  const canvas = createCanvas(512, 512)
  const tmpCanvas = createCanvas(512, 512)
  const ctx = canvas.getContext('2d')
  const tmpCtx = tmpCanvas.getContext('2d')
  const image = await loadImage(join(__dirname, 'javascript.png'))
  tmpCtx.drawImage(image, 0, 0)
  const pattern = ctx.createPattern(image, 'repeat')
  const pattern2 = ctx.createPattern(tmpCanvas, 'repeat')
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, 512 / 2, 512)

  ctx.fillStyle = pattern2
  ctx.fillRect(512 / 2, 0, 512 / 2, 512)
  await snapshotImage(t, { ctx, canvas })
})

// https://github.com/Brooooooklyn/canvas/issues/1106
test('canvas-pattern-should-capture-state-at-creation-1106', async (t) => {
  const width = 200
  const height = 150

  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  const tmpCanvas = createCanvas(width, height)
  const tmpContext = tmpCanvas.getContext('2d')

  // Create initial red pattern
  tmpContext.fillStyle = 'red'
  tmpContext.fillRect(0, 0, width, height)

  const pattern = tmpContext.createPattern(tmpCanvas, 'no-repeat')

  // Modify the tmpCanvas after pattern creation
  tmpCanvas.width = width / 2
  tmpCanvas.height = height / 2
  tmpContext.fillStyle = 'blue'
  tmpContext.fillRect(0, 0, width / 2, height / 2)

  const pattern2 = tmpContext.createPattern(tmpCanvas, 'no-repeat')

  // Fill with the first pattern (should still be red, not affected by blue changes)
  context.fillStyle = pattern!
  context.fillRect(width / 2, height / 2, width / 2, height / 2)

  // Fill with the second pattern (should be blue)
  context.fillStyle = pattern2!
  context.fillRect(0, 0, width / 2, height / 2)

  await snapshotImage(t, { ctx: context, canvas })
})

// https://github.com/Brooooooklyn/canvas/issues/1018
test('draw-non-string-text', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  const canvas = createCanvas(300, 300)
  const ctx = canvas.getContext('2d')
  ctx.font = '36px Iosevka Slab'
  ctx.fillStyle = 'red'
  // @ts-expect-error
  ctx.fillText(2015, 100, 100)
  t.notThrows(() => {
    // @ts-expect-error
    ctx.measureText(2015)
  })
  await snapshotImage(t, { ctx, canvas })
})

// https://github.com/Brooooooklyn/canvas/issues/1038
test('scale-svg-image', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  const image = await loadImage(join(__dirname, 'image-og.svg'))
  image.width = image.naturalWidth * 2
  image.height = image.naturalHeight * 2
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  await snapshotImage(t, { ctx, canvas })
})

// https://github.com/Brooooooklyn/canvas/issues/1059
test('shadow-alpha-with-global-alpha', async (t) => {
  const canvas = createCanvas(200, 100)
  const ctx = canvas.getContext('2d')

  // Fill with white background
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 200, 100)

  // Set globalAlpha to 1 (full opacity)
  ctx.globalAlpha = 1

  // Set shadow with semi-transparent black
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
  ctx.shadowBlur = 10
  ctx.shadowOffsetX = 5
  ctx.shadowOffsetY = 5

  // Draw a rectangle with shadow
  ctx.fillStyle = 'blue'
  ctx.fillRect(20, 20, 60, 40)

  // The checked-in baseline comes from Linux x64. Skia's mask-filter raster
  // differs on ARM64, while the shadow's placement and alpha remain the same.
  await snapshotImage(t, { ctx, canvas }, 'png', process.arch === 'x64' ? 0.015 : 6.1)
})

// https://github.com/Brooooooklyn/canvas/issues/1060
test('shadow-clipping-beyond-canvas-bounds', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  const canvas = createCanvas(200, 200)
  const ctx = canvas.getContext('2d')

  // Fill with white background
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 200, 200)

  // Test 1: Rectangle near right edge with shadow extending beyond canvas
  ctx.shadowColor = 'rgba(255, 0, 0, 0.8)'
  ctx.shadowBlur = 20
  ctx.shadowOffsetX = 30
  ctx.shadowOffsetY = 10
  ctx.fillStyle = 'blue'
  ctx.fillRect(160, 50, 30, 30) // Rectangle positioned so shadow extends beyond right edge

  // Reset shadow for next shape
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0

  // Test 2: Circle near bottom edge with shadow extending beyond canvas
  ctx.shadowColor = 'rgba(0, 255, 0, 0.8)'
  ctx.shadowBlur = 15
  ctx.shadowOffsetX = 10
  ctx.shadowOffsetY = 25
  ctx.fillStyle = 'purple'
  ctx.beginPath()
  ctx.arc(100, 170, 20, 0, 2 * Math.PI)
  ctx.fill()

  // Reset shadow for text
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0

  // Test 3: Text near top edge with shadow extending beyond canvas
  ctx.shadowColor = 'rgba(0, 0, 255, 0.8)'
  ctx.shadowBlur = 10
  ctx.shadowOffsetX = 5
  ctx.shadowOffsetY = -15
  ctx.fillStyle = 'black'
  ctx.font = '16px Iosevka Slab'
  ctx.fillText('Shadow Test', 50, 20) // Text positioned so shadow extends beyond top edge

  // Reset shadow for stroke test
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0

  // Test 4: Stroke near left edge with shadow extending beyond canvas
  ctx.shadowColor = 'rgba(255, 255, 0, 0.8)'
  ctx.shadowBlur = 12
  ctx.shadowOffsetX = -20
  ctx.shadowOffsetY = 5
  ctx.strokeStyle = 'red'
  ctx.lineWidth = 3
  ctx.strokeRect(10, 110, 40, 40) // Rectangle positioned so shadow extends beyond left edge

  await snapshotImage(t, { ctx, canvas }, 'png', process.arch === 'x64' ? 0.015 : 2.8)
})

test('pass invalid args to setLineDash should not throw', (t) => {
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')
  t.notThrows(() => {
    ctx.setLineDash([NaN, 10])
    ctx.setLineDash([
      // @ts-expect-error
      {
        cmd: 'n',
      },
      // @ts-expect-error
      {
        cmd: 'one',
      },
    ])
  })
})

// https://github.com/Brooooooklyn/canvas/issues/1121
test('shadow-offset-with-transform', async (t) => {
  // Test for issue #1121 - shadow offset should be in device coordinates
  const canvas = createCanvas(300, 300)
  const ctx = canvas.getContext('2d')

  // Fill with white background
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 300, 300)

  // Apply transform - scale down by 0.5 and translate
  ctx.transform(0.5, 0, 0, 0.5, 100, 100)

  // Set shadow properties
  ctx.shadowColor = 'rgba(0, 0, 0, 1)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 5
  ctx.shadowOffsetY = 5

  // Draw green rectangle
  ctx.fillStyle = 'green'
  ctx.rect(0, 0, 100, 100)
  ctx.fill()

  // The shadow should be offset by exactly 5px in both X and Y directions
  // in device/screen coordinates, regardless of the transform applied
  await snapshotImage(t, { canvas, ctx }, 'png', 0.3)
})

// https://github.com/Brooooooklyn/canvas/issues/1297
test('shadow opacity should scale linearly with shadowColor alpha', (t) => {
  // A blurred shadow's darkness must be proportional to the shadowColor alpha:
  // alpha 0.5 should be ~half as dark as alpha 1.0. The bug applied the shadow
  // alpha twice (baked into the drop-shadow filter colour AND via a redundant
  // paint set_alpha), so darkness scaled with alpha**2 -- alpha 0.5 came out at
  // ~0.25 strength, alpha 0.3 at ~0.09, making low-opacity shadows near-invisible.
  const haloDarkness = (alpha: number) => {
    const canvas = createCanvas(200, 200)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 200, 200)
    ctx.shadowColor = `rgba(0, 0, 0, ${alpha})`
    ctx.shadowBlur = 20
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
    ctx.fillStyle = '#000000'
    ctx.fillRect(80, 80, 40, 40)
    // Probe a halo pixel just outside the left edge (box left edge x=80).
    const gray = ctx.getImageData(75, 100, 1, 1).data[0]
    return (255 - gray) / 255
  }

  const full = haloDarkness(1)
  const half = haloDarkness(0.5)

  // Sanity: the full-opacity shadow must actually be visible at the probe.
  t.true(full > 0.05, `full-opacity shadow darkness should be visible, got ${full}`)

  const ratio = half / full
  // Linear scaling => ~0.5. The squared bug => ~0.25. Allow a generous window
  // around the linear expectation that still excludes the buggy value.
  t.true(
    ratio > 0.4 && ratio < 0.6,
    `alpha-0.5 shadow should be ~0.5x the alpha-1.0 shadow (linear), got ${ratio.toFixed(3)}`,
  )
})

test('shadowOffsetX/Y are device-space on the image path, not local-space', (t) => {
  // Pins that shadowOffsetX/Y are device-space on every path, as they are in
  // Blink (cc/paint/draw_looper.cc:37-40 for the looper, a `ScopedResetCtm` for
  // the image filter). A `DropShadowOnly` dx/dy is a local-space vector unless
  // its layer is opened at the device identity, so the CTM would rotate it.
  const W = 600
  const H = 400
  // Red foreground, blue shadow, so the two are separable per pixel.
  const source = createCanvas(100, 100)
  const sourceCtx = source.getContext('2d')
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(0, 0, 100, 100)

  // translate(300, 200) + rotate(PI) puts the 100x100 square back on device
  // [250, 350] x [150, 250]; a device-space +100 offset must therefore centre
  // the shadow on device x = 400, and a local-space one on x = 200.
  const measure = (draw: (ctx: ReturnType<typeof source.getContext>) => void) => {
    const canvas = createCanvas(W, H)
    const ctx = canvas.getContext('2d')
    ctx.translate(300, 200)
    ctx.rotate(Math.PI)
    ctx.shadowColor = 'rgba(0, 0, 255, 1)'
    ctx.shadowBlur = 20
    ctx.shadowOffsetX = 100
    ctx.shadowOffsetY = 0
    ctx.fillStyle = 'red'
    draw(ctx)

    const data = canvas.data()
    let minX = Infinity
    let maxX = -Infinity
    let weight = 0
    let weightedX = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        const alpha = data[i + 3]
        // shadow pixels only: blue present, red absent
        if (alpha === 0 || data[i + 2] <= 8 || data[i] >= 8) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        weightedX += x * alpha
        weight += alpha
      }
    }
    return { minX, maxX, centroidX: Number((weightedX / weight).toFixed(1)) }
  }

  // The geometry path has always been device-space; it is the oracle here.
  const oracle = measure((ctx) => ctx.fillRect(-50, -50, 100, 100))
  t.true(
    oracle.centroidX > 380 && oracle.centroidX < 420,
    `the geometry shadow should sit around device x = 400, got ${oracle.centroidX}`,
  )

  for (const [name, draw] of [
    ['drawImage', (ctx: any) => ctx.drawImage(source, -50, -50, 100, 100)],
    ['drawCanvas', (ctx: any) => ctx.drawCanvas(source, -50, -50, 100, 100)],
  ] as const) {
    const measured = measure(draw)
    // Before the fix this was { minX: 133, maxX: 263, centroidX: 197.5 } -- the
    // shadow 100 device px to the LEFT, mirrored by the rotation.
    // Chromium deliberately uses a mask filter for geometry and an image
    // filter for non-opaque images. Their Gaussian tails differ by a couple of
    // pixels, so compare placement rather than requiring byte-identical bounds.
    t.true(
      Math.abs(measured.centroidX - oracle.centroidX) <= 1 &&
        Math.abs(measured.minX - oracle.minX) <= 2 &&
        Math.abs(measured.maxX - oracle.maxX) <= 2,
      `${name} shadow should match the geometry placement, got ${JSON.stringify(measured)} vs ${JSON.stringify(oracle)}`,
    )
  }
})

test('a scaled CTM does not scale the image path shadow offset', (t) => {
  // Same rule under a pure scale: scale(2, 0.5) + a 40px offset must move the
  // shadow 40 DEVICE px, not 80.
  const source = createCanvas(100, 100)
  const sourceCtx = source.getContext('2d')
  sourceCtx.fillStyle = 'red'
  sourceCtx.fillRect(0, 0, 100, 100)

  const canvas = createCanvas(400, 300)
  const ctx = canvas.getContext('2d')
  ctx.scale(2, 0.5)
  ctx.shadowColor = 'rgba(0, 0, 255, 1)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 40
  ctx.shadowOffsetY = 0
  // local [5, 25] x [40, 120] -> device [10, 50] x [20, 60]
  ctx.drawImage(source, 5, 40, 20, 80)

  const data = canvas.data()
  let minX = Infinity
  let maxX = -Infinity
  for (let x = 0; x < 400; x++) {
    const i = (40 * 400 + x) * 4
    if (data[i + 3] !== 0 && data[i + 2] > 8 && data[i] < 8) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
    }
  }
  // device [10, 50] shifted by 40 device px is [50, 90), i.e. the last lit
  // column is 89. The local-space bug scaled the offset to 80 and gave [90, 129].
  t.deepEqual([minX, maxX], [50, 89], `zero-blur shadow span at device y = 40, got ${[minX, maxX]}`)
})

test('the shadow setters discard the values Blink rejects', (t) => {
  // setShadowBlur drops a non-finite or negative assignment, setShadowOffsetX/Y
  // a non-finite one, and both keep the previous value
  // (canvas_2d_recorder_context.cc:1170-1211). Storing them is not inert: the
  // blur becomes the sigma, `SkImageFilters::Blur` rejects it, and the Blur node
  // is silently dropped -- leaving every later shadow hard-edged.
  const ctx = createCanvas(10, 10).getContext('2d')

  ctx.shadowBlur = 10
  for (const bad of [-5, NaN, Infinity, -Infinity]) {
    ctx.shadowBlur = bad
    t.is(ctx.shadowBlur, 10, `shadowBlur = ${bad} should be ignored`)
  }
  ctx.shadowBlur = 0
  t.is(ctx.shadowBlur, 0, 'zero blur is a legal assignment')

  ctx.shadowOffsetX = 10
  ctx.shadowOffsetY = 20
  for (const bad of [NaN, Infinity, -Infinity]) {
    ctx.shadowOffsetX = bad
    ctx.shadowOffsetY = bad
    t.is(ctx.shadowOffsetX, 10, `shadowOffsetX = ${bad} should be ignored`)
    t.is(ctx.shadowOffsetY, 20, `shadowOffsetY = ${bad} should be ignored`)
  }
  // Negative offsets are legal -- they cast the shadow left/up.
  ctx.shadowOffsetX = -30
  ctx.shadowOffsetY = -40
  t.is(ctx.shadowOffsetX, -30)
  t.is(ctx.shadowOffsetY, -40)

  // A finite double out of float range saturates at +/-FLT_MAX, matching
  // Blink's ClampTo<float> (platform/wtf/math_extras.h:192-206); a plain cast
  // would overflow it to an infinity that Skia then rejects.
  ctx.shadowBlur = 1e300
  t.is(ctx.shadowBlur, 3.4028234663852886e38, 'an out-of-range blur clamps to FLT_MAX')

  // A rejected assignment must leave rendering untouched, not merely the getter.
  const haloLeftEdge = (mutate: (c: typeof ctx) => void) => {
    const canvas = createCanvas(200, 200)
    const c = canvas.getContext('2d')
    c.shadowColor = 'black'
    c.shadowBlur = 10
    mutate(c)
    c.fillStyle = 'red'
    c.fillRect(20, 20, 60, 60)
    const data = canvas.data()
    let minX = Infinity
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 200; x++) {
        if (data[(y * 200 + x) * 4 + 3] !== 0 && x < minX) minX = x
      }
    }
    return minX
  }
  const blurred = haloLeftEdge(() => {})
  t.true(blurred < 20, `blur 10 should push the halo left of the rect, got ${blurred}`)
  t.is(
    haloLeftEdge((c) => (c.shadowBlur = NaN)),
    blurred,
    'shadowBlur = NaN must not erase the blur',
  )
  t.is(
    haloLeftEdge((c) => (c.shadowBlur = -5)),
    blurred,
    'shadowBlur = -5 must not erase the blur',
  )
})

// CanvasGradient.addColorStop must keep stops that share an offset in the order they were added
// (https://html.spec.whatwg.org/multipage/canvas.html#dom-canvasgradient-addcolorstop). An
// insertion scan that breaks on `val >= offset` puts a later equal-offset stop *before* the
// earlier one, turning a hard step into a mirrored ramp.
//
// Every expectation below is the byte-exact getImageData readback from headless
// Chrome 151.0.7922.34 (playwright chromium-1234) running the identical scene.
const GRADIENT_ROW_WIDTH = 20

function gradientRow(
  paint: (ctx: SKRSContext2D, w: number, h: number) => void,
  w = GRADIENT_ROW_WIDTH,
  h = 1,
  row = 0,
): number[] {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  paint(ctx, w, h)
  return Array.from(ctx.getImageData(0, row, w, 1).data)
}

// `tolerance` is 0 where we are byte-identical to Chrome. It is 1 for gradients that contain a
// real ramp: Chrome and Skia round the interpolated channel differently by at most one ULP, which
// the duplicate-free control scenes in this file exhibit too.
function assertRowMatchesChrome(
  t: { is: (a: unknown, b: unknown, m?: string) => void; true: (v: boolean, m?: string) => void },
  actual: number[],
  chrome: number[],
  tolerance: number,
  message: string,
) {
  t.is(actual.length, chrome.length, `${message}: pixel count`)
  let max = 0
  let worst = -1
  for (let i = 0; i < chrome.length; i++) {
    const delta = Math.abs(actual[i] - chrome[i])
    if (delta > max) {
      max = delta
      worst = i
    }
  }
  const detail =
    worst < 0
      ? ''
      : ` — worst at px ${Math.floor(worst / 4)} channel ${'rgba'[worst % 4]}: chrome=${chrome[worst]} ours=${actual[worst]}`
  t.true(max <= tolerance, `${message}: max |chrome - ours| = ${max}, tolerance ${tolerance}${detail}`)
}

// prettier-ignore
const RED_10_THEN_TRANSPARENT_10 = [
  255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
  255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]

// prettier-ignore
const RED_10_THEN_BLUE_10 = [
  255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
  255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
  0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255,
  0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255,
]

test('duplicated gradient color stops render a hard step, in the order added', (t) => {
  // The reported case: one opaque stop and one transparent stop, both at 0.5, nothing else.
  // Correct: opaque red for the first half, fully transparent for the second.
  // Before the fix we produced the exact mirror image (max |chrome - ours| = 255).
  assertRowMatchesChrome(
    t,
    gradientRow((ctx, w, h) => {
      const gradient = ctx.createLinearGradient(0, 0, w, 0)
      gradient.addColorStop(0.5, 'rgba(255,0,0,1)')
      gradient.addColorStop(0.5, 'rgba(255,0,0,0)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, w, h)
    }),
    RED_10_THEN_TRANSPARENT_10,
    0,
    'two stops at offset 0.5',
  )

  // The canonical "hard stop" idiom: red flat to 0.5, then blue flat to 1.
  // Before the fix the stop order came out red/blue/red/blue and Skia drew the red→blue ramp
  // twice (max |chrome - ours| = 242).
  assertRowMatchesChrome(
    t,
    gradientRow((ctx, w, h) => {
      const gradient = ctx.createLinearGradient(0, 0, w, 0)
      gradient.addColorStop(0, 'rgba(255,0,0,1)')
      gradient.addColorStop(0.5, 'rgba(255,0,0,1)')
      gradient.addColorStop(0.5, 'rgba(0,0,255,1)')
      gradient.addColorStop(1, 'rgba(0,0,255,1)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, w, h)
    }),
    RED_10_THEN_BLUE_10,
    0,
    'red/red/blue/blue hard step',
  )

  // Three stops at the same offset: only the first (red) and the last (blue) are observable,
  // the green in between is infinitesimally wide. white→red for the first half, blue→black
  // for the second.
  // prettier-ignore
  const whiteRedBlueBlack = [
    255, 242, 242, 255, 255, 217, 217, 255, 255, 191, 191, 255, 255, 166, 166, 255, 255, 140, 140, 255,
    255, 115, 115, 255, 255, 89, 89, 255, 255, 64, 64, 255, 255, 38, 38, 255, 255, 13, 13, 255,
    0, 0, 242, 255, 0, 0, 217, 255, 0, 0, 191, 255, 0, 0, 166, 255, 0, 0, 140, 255,
    0, 0, 115, 255, 0, 0, 89, 255, 0, 0, 64, 255, 0, 0, 38, 255, 0, 0, 13, 255,
  ]
  assertRowMatchesChrome(
    t,
    gradientRow((ctx, w, h) => {
      const gradient = ctx.createLinearGradient(0, 0, w, 0)
      gradient.addColorStop(0, '#ffffff')
      gradient.addColorStop(0.5, '#ff0000')
      gradient.addColorStop(0.5, '#00ff00')
      gradient.addColorStop(0.5, '#0000ff')
      gradient.addColorStop(1, '#000000')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, w, h)
    }),
    whiteRedBlueBlack,
    0,
    'three stops at offset 0.5',
  )
})

test('duplicated gradient color stops at the 0 and 1 boundaries', (t) => {
  // Duplicates at offset 0: red is first so it sits at the very start and is only visible under
  // clamping; the visible ramp starts from blue. Before the fix the two were swapped and the ramp
  // started from red (max |chrome - ours| = 249).
  // prettier-ignore
  const blueToGreen = [
    0, 6, 248, 255, 0, 19, 236, 255, 0, 32, 223, 255, 0, 45, 211, 255, 0, 57, 197, 255,
    0, 70, 185, 255, 0, 83, 172, 255, 0, 96, 160, 255, 0, 108, 146, 255, 0, 121, 134, 255,
    0, 134, 121, 255, 0, 147, 109, 255, 0, 159, 95, 255, 0, 172, 83, 255, 0, 185, 70, 255,
    0, 198, 58, 255, 0, 210, 44, 255, 0, 223, 32, 255, 0, 236, 19, 255, 0, 249, 7, 255,
  ]
  assertRowMatchesChrome(
    t,
    gradientRow((ctx, w, h) => {
      const gradient = ctx.createLinearGradient(0, 0, w, 0)
      gradient.addColorStop(0, '#ff0000')
      gradient.addColorStop(0, '#0000ff')
      gradient.addColorStop(1, '#00ff00')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, w, h)
    }),
    blueToGreen,
    1,
    'two stops at offset 0',
  )

  // Duplicates at offset 1: blue is added first so the ramp ends on blue, and green sits beyond it.
  // Before the fix the ramp ended on green (max |chrome - ours| = 249).
  // prettier-ignore
  const redToBlue = [
    248, 0, 6, 255, 236, 0, 19, 255, 223, 0, 32, 255, 211, 0, 45, 255, 197, 0, 57, 255,
    185, 0, 70, 255, 172, 0, 83, 255, 160, 0, 96, 255, 146, 0, 108, 255, 134, 0, 121, 255,
    121, 0, 134, 255, 109, 0, 147, 255, 95, 0, 159, 255, 83, 0, 172, 255, 70, 0, 185, 255,
    58, 0, 198, 255, 44, 0, 210, 255, 32, 0, 223, 255, 19, 0, 236, 255, 7, 0, 249, 255,
  ]
  assertRowMatchesChrome(
    t,
    gradientRow((ctx, w, h) => {
      const gradient = ctx.createLinearGradient(0, 0, w, 0)
      gradient.addColorStop(0, '#ff0000')
      gradient.addColorStop(1, '#0000ff')
      gradient.addColorStop(1, '#00ff00')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, w, h)
    }),
    redToBlue,
    1,
    'two stops at offset 1',
  )

  // Control: the very same red→blue ramp with no duplicate at all must be untouched by the fix,
  // and is byte-identical to `redToBlue` above.
  assertRowMatchesChrome(
    t,
    gradientRow((ctx, w, h) => {
      const gradient = ctx.createLinearGradient(0, 0, w, 0)
      gradient.addColorStop(0, '#ff0000')
      gradient.addColorStop(1, '#0000ff')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, w, h)
    }),
    redToBlue,
    1,
    'control: red→blue with no duplicate stop',
  )
})

test('out-of-order gradient stop insertion mixed with duplicates stays stable', (t) => {
  // Added as 1/0.5/0.25/0.5/0/0.25, so every stop but the first travels the O(n) insertion path.
  // Sorted stably that is white@0, yellow@0.25, cyan@0.25, red@0.5, blue@0.5, black@1:
  // white→yellow, hard step to cyan, cyan→red, hard step to blue, blue→black.
  // Before the fix each duplicate pair was flipped (max |chrome - ours| = 242).
  // prettier-ignore
  const chrome = [
    255, 255, 229, 255, 255, 255, 179, 255, 255, 255, 127, 255, 255, 255, 77, 255, 255, 255, 25, 255,
    26, 230, 230, 255, 76, 178, 178, 255, 128, 128, 128, 255, 178, 76, 76, 255, 230, 26, 26, 255,
    0, 0, 242, 255, 0, 0, 217, 255, 0, 0, 191, 255, 0, 0, 166, 255, 0, 0, 140, 255,
    0, 0, 115, 255, 0, 0, 89, 255, 0, 0, 64, 255, 0, 0, 38, 255, 0, 0, 13, 255,
  ]
  assertRowMatchesChrome(
    t,
    gradientRow((ctx, w, h) => {
      const gradient = ctx.createLinearGradient(0, 0, w, 0)
      gradient.addColorStop(1, '#000000')
      gradient.addColorStop(0.5, '#ff0000')
      gradient.addColorStop(0.25, '#ffff00')
      gradient.addColorStop(0.5, '#0000ff')
      gradient.addColorStop(0, '#ffffff')
      gradient.addColorStop(0.25, '#00ffff')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, w, h)
    }),
    chrome,
    1,
    'six stops added out of order, two duplicated offsets',
  )
})

test('duplicated color stops behave the same on radial and conic gradients', (t) => {
  // Radial: a red disc of radius 8 with a hard edge into blue. Row 16 cuts through the centre,
  // so it reads blue up to x=8, red for 8..24, blue again after.
  // Before the fix the disc was an inverted double ramp (max |chrome - ours| = 252).
  // prettier-ignore
  const radialRow16 = [
    0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255,
    0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255,
    255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
    255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
    255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
    255, 0, 0, 255,
    0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255,
    0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255,
  ]
  assertRowMatchesChrome(
    t,
    gradientRow(
      (ctx, w, h) => {
        const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
        gradient.addColorStop(0, '#ff0000')
        gradient.addColorStop(0.5, '#ff0000')
        gradient.addColorStop(0.5, '#0000ff')
        gradient.addColorStop(1, '#0000ff')
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, w, h)
      },
      32,
      32,
      16,
    ),
    radialRow16,
    0,
    'radial gradient with a duplicated stop at 0.5',
  )

  // Conic: our angular origin does not match Chrome's, so instead of comparing against Chrome we
  // assert the property the bug destroyed — with a duplicated stop the sweep must be a hard step
  // between two flat colors, with no interpolated pixel anywhere. Before the fix every pixel was
  // an intermediate blend.
  const size = 64
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createConicGradient(0, size / 2, size / 2)
  gradient.addColorStop(0, '#ff0000')
  gradient.addColorStop(0.5, '#ff0000')
  gradient.addColorStop(0.5, '#0000ff')
  gradient.addColorStop(1, '#0000ff')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const data = ctx.getImageData(0, 0, size, size).data
  let pureRed = 0
  let pureBlue = 0
  let blended = 0
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
    if (r === 255 && g === 0 && b === 0 && a === 255) pureRed++
    else if (r === 0 && g === 0 && b === 255 && a === 255) pureBlue++
    else blended++
  }
  t.is(blended, 0, 'a conic gradient with a duplicated stop must not interpolate anywhere')
  t.is(pureRed, (size * size) / 2, 'half the conic sweep is pure red')
  t.is(pureBlue, (size * size) / 2, 'the other half is pure blue')
})

test('an unparseable ctx.filter must not crash the process on the next draw', (t) => {
  // The SIGSEGV lands on the DRAW, not on the assignment: an empty filter list
  // that yields `Some(ImageFilter(null))` is stored by the setter and then
  // dereferenced by `skiac_paint_set_image_filter`. `''`, `'   '` and
  // `'garbage'` all parse to an empty list. If this regresses, the whole ava
  // worker dies rather than this assertion failing.
  for (const bad of ['', '   ', 'garbage', 'not-a-filter(1)', 'inherit', 'initial', 'unset', 'revert']) {
    const canvas = createCanvas(50, 50)
    const ctx = canvas.getContext('2d')
    ctx.filter = bad
    ctx.fillStyle = 'red'
    ctx.fillRect(10, 10, 30, 30)
    const data = canvas.data()
    // Unfiltered: the rect is solid red and nothing bleeds outside it.
    const inside = (25 * 50 + 25) * 4
    t.deepEqual(
      [data[inside], data[inside + 1], data[inside + 2], data[inside + 3]],
      [255, 0, 0, 255],
      `ctx.filter = ${JSON.stringify(bad)} should draw an unfiltered red rect`,
    )
    t.is(data[(25 * 50 + 9) * 4 + 3], 0, `ctx.filter = ${JSON.stringify(bad)} should not blur the edge`)
  }
})

test('an unparseable ctx.filter is discarded and the previous filter survives', (t) => {
  // Blink's setter plain `return`s when parsing yields null, leaving the state
  // untouched (canvas_2d_recorder_context.cc:1332-1350), so an invalid
  // assignment neither throws nor resets to `none`. Every value below --
  // `''`, whitespace, junk and the CSS-wide keywords -- is rejected by Blink,
  // verified against Chrome 150.
  const ctx = createCanvas(50, 50).getContext('2d')

  t.is(ctx.filter, 'none', 'the initial value is "none"')

  ctx.filter = 'blur(3px)'
  t.is(ctx.filter, 'blur(3px)')
  for (const bad of ['', '   ', 'garbage', 'inherit', 'initial', 'unset', 'revert', 'none garbage']) {
    ctx.filter = bad
    t.is(ctx.filter, 'blur(3px)', `ctx.filter = ${JSON.stringify(bad)} should be ignored`)
  }

  // ...and an invalid assignment from the default state leaves "none" in place,
  // rather than echoing the junk back as the old setter did.
  const fresh = createCanvas(50, 50).getContext('2d')
  fresh.filter = 'garbage'
  t.is(fresh.filter, 'none')

  // `none` is a real value that clears the filter, and the getter replays the
  // raw string, unnormalised, exactly as `UnparsedCSSFilter()` does.
  ctx.filter = 'none'
  t.is(ctx.filter, 'none')
  ctx.filter = 'blur(3px)'
  ctx.filter = 'NONE'
  t.is(ctx.filter, 'NONE', '`none` is an ident, so it is matched case-insensitively')
})

test('a partially invalid ctx.filter list is rejected whole, not truncated to its valid prefix', (t) => {
  // A `<filter-value-list>` is all-or-nothing: Blink's parser is greedy but the
  // junk it stops at stays in the stream, and `!stream.AtEnd()` then rejects the
  // whole declaration (css_property_parser.cc:118-120). Chrome 150 keeps no
  // valid prefix, so neither may we.
  const measure = (filter: string) => {
    const canvas = createCanvas(50, 50)
    const ctx = canvas.getContext('2d')
    ctx.filter = filter
    ctx.fillStyle = 'red'
    ctx.fillRect(10, 10, 30, 30)
    // One pixel outside the rect: nonzero alpha means a blur is still active.
    return { filter: ctx.filter, edgeAlpha: canvas.data()[(25 * 50 + 9) * 4 + 3] }
  }

  const blurred = measure('blur(3px)')
  t.true(blurred.edgeAlpha > 0, 'the control really does blur past the rect edge')

  const partial = measure('blur(3px) notafilter(1)')
  t.is(partial.filter, 'none', 'the whole list is rejected, so the default value stands')
  t.is(partial.edgeAlpha, 0, 'the blur(3px) prefix must not survive')

  // A fully valid multi-function list still works.
  const both = measure('blur(3px) grayscale(50%)')
  t.is(both.filter, 'blur(3px) grayscale(50%)')
  t.true(both.edgeAlpha > 0)
})

// https://github.com/Brooooooklyn/canvas/issues/1317
test('putImageData ignores the current transform even after a getImageData', (t) => {
  // In deferred mode, getImageData promotes the pending record and re-applies
  // the canvas state (transform/clip) to the fresh recording. putImageData then
  // began its pixel record *without finishing* the pending one, so the draw was
  // appended after the stale state ops and inherited the transform.
  const makePatch = () => {
    const patch = new ImageData(new Uint8ClampedArray(32 * 32 * 4), 32, 32)
    for (let i = 0; i < 32 * 32; i++) {
      patch.data[i * 4] = 255
      patch.data[i * 4 + 3] = 255
    }
    return patch
  }
  // [minX, minY, count] of opaque red pixels
  const locate = (ctx: SKRSContext2D) => {
    const { data } = ctx.getImageData(0, 0, 128, 128)
    let x = Infinity
    let y = Infinity
    let n = 0
    for (let p = 0; p < 128 * 128; p++) {
      if (data[p * 4] > 200 && data[p * 4 + 3] > 200) {
        x = Math.min(x, p % 128)
        y = Math.min(y, (p / 128) | 0)
        n++
      }
    }
    return [x, y, n]
  }

  // The reported trigger: non-identity transform, then getImageData.
  {
    const ctx = createCanvas(128, 128).getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 24, 24)
    ctx.getImageData(0, 0, 1, 1)
    ctx.putImageData(makePatch(), 10, 10)
    t.deepEqual(locate(ctx), [10, 10, 1024], 'write must not be offset by the transform')
  }

  // The whole CTM was applied, not just the translation: a 2x scale turned the
  // 32x32 patch into a 64x64 block at (20, 20).
  {
    const ctx = createCanvas(128, 128).getContext('2d')
    ctx.setTransform(2, 0, 0, 2, 0, 0)
    ctx.getImageData(0, 0, 1, 1)
    ctx.putImageData(makePatch(), 10, 10)
    t.deepEqual(locate(ctx), [10, 10, 1024], 'write must not be scaled by the transform')
  }

  // A stale clip leaked the same way: putImageData must ignore it too.
  {
    const ctx = createCanvas(128, 128).getContext('2d')
    ctx.beginPath()
    ctx.rect(0, 0, 5, 5)
    ctx.clip()
    ctx.getImageData(0, 0, 1, 1)
    ctx.putImageData(makePatch(), 10, 10)
    t.deepEqual(locate(ctx), [10, 10, 1024], 'write must not be clipped')
  }

  // Subsequent ordinary draws must still respect the transform (the fix only
  // isolates the pixel write; it must not drop the state for later layers).
  {
    const ctx = createCanvas(128, 128).getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 24, 24)
    ctx.getImageData(0, 0, 1, 1)
    ctx.putImageData(makePatch(), 10, 10)
    ctx.fillStyle = 'rgb(255,0,0)'
    ctx.fillRect(6, 6, 32, 32) // under the transform -> lands at (30,30)..(62,62)
    // union: 1024 (patch) + 1024 (rect) - 144 (12x12 overlap)
    t.deepEqual(locate(ctx), [10, 10, 1904], 'draws after putImageData keep the transform')
  }
})
