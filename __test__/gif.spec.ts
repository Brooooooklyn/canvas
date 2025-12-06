import test from 'ava'

import { createCanvas, GifEncoder, GifDisposal } from '../index'

// GIF magic bytes: GIF87a or GIF89a
const GIF_MAGIC = Buffer.from([0x47, 0x49, 0x46, 0x38]) // "GIF8"

function isValidGif(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.subarray(0, 4).equals(GIF_MAGIC)
}

// Single-frame GIF encoding tests

test('encode single-frame GIF using canvas.encode()', async (t) => {
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 100, 100)

  const buffer = await canvas.encode('gif')
  t.true(Buffer.isBuffer(buffer))
  t.true(buffer.length > 0)
  t.true(isValidGif(buffer))
})

test('encode single-frame GIF with quality option', async (t) => {
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 100, 100)

  const bufferLowQuality = await canvas.encode('gif', 30)
  const bufferHighQuality = await canvas.encode('gif', 1)

  t.true(isValidGif(bufferLowQuality))
  t.true(isValidGif(bufferHighQuality))
  // Higher quality (lower number) should generally produce similar or larger files
  // due to more accurate color quantization
  t.true(bufferLowQuality.length > 0)
  t.true(bufferHighQuality.length > 0)
})

test('toDataURL with image/gif MIME type', (t) => {
  const canvas = createCanvas(50, 50)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'green'
  ctx.fillRect(0, 0, 50, 50)

  const dataUrl = canvas.toDataURL('image/gif')
  t.true(dataUrl.startsWith('data:image/gif;base64,'))

  // Decode and verify it's a valid GIF
  const base64Data = dataUrl.split(',')[1]
  const buffer = Buffer.from(base64Data, 'base64')
  t.true(isValidGif(buffer))
})

test('toDataURLAsync with image/gif MIME type', async (t) => {
  const canvas = createCanvas(50, 50)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'yellow'
  ctx.fillRect(0, 0, 50, 50)

  const dataUrl = await canvas.toDataURLAsync('image/gif')
  t.true(dataUrl.startsWith('data:image/gif;base64,'))

  const base64Data = dataUrl.split(',')[1]
  const buffer = Buffer.from(base64Data, 'base64')
  t.true(isValidGif(buffer))
})

test('toBuffer with image/gif MIME type', (t) => {
  const canvas = createCanvas(50, 50)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'purple'
  ctx.fillRect(0, 0, 50, 50)

  const buffer = canvas.toBuffer('image/gif')
  t.true(Buffer.isBuffer(buffer))
  t.true(isValidGif(buffer))
})

test('toBlob with image/gif MIME type', async (t) => {
  const canvas = createCanvas(50, 50)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'orange'
  ctx.fillRect(0, 0, 50, 50)

  return new Promise<void>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        try {
          t.truthy(blob)
          t.true(blob instanceof Blob)
          t.true(blob!.size > 0)
          resolve()
        } catch (error) {
          reject(error)
        }
      },
      'image/gif',
    )
  })
})

test('convertToBlob with image/gif MIME type', async (t) => {
  const canvas = createCanvas(50, 50)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'cyan'
  ctx.fillRect(0, 0, 50, 50)

  const blob = await canvas.convertToBlob({ mime: 'image/gif' })
  t.truthy(blob)
  t.true(blob instanceof Blob)
  t.true(blob.size > 0)
})

// GifEncoder (animated GIF) tests

test('GifEncoder constructor', (t) => {
  const encoder = new GifEncoder(100, 100)
  t.truthy(encoder)
  t.is(encoder.width, 100)
  t.is(encoder.height, 100)
  t.is(encoder.frameCount, 0)
})

test('GifEncoder with config options', (t) => {
  const encoder = new GifEncoder(200, 150, {
    repeat: 0,
    quality: 10,
  })
  t.truthy(encoder)
  t.is(encoder.width, 200)
  t.is(encoder.height, 150)
})

test('GifEncoder.addFrame with RGBA data', (t) => {
  const encoder = new GifEncoder(10, 10)

  // Create a 10x10 red RGBA image
  const rgbaData = new Uint8Array(10 * 10 * 4)
  for (let i = 0; i < 10 * 10; i++) {
    rgbaData[i * 4 + 0] = 255 // R
    rgbaData[i * 4 + 1] = 0   // G
    rgbaData[i * 4 + 2] = 0   // B
    rgbaData[i * 4 + 3] = 255 // A
  }

  encoder.addFrame(rgbaData, 10, 10, { delay: 100 })
  t.is(encoder.frameCount, 1)
})

test('GifEncoder.finish produces valid GIF', (t) => {
  const encoder = new GifEncoder(10, 10)

  // Red frame
  const redFrame = new Uint8Array(10 * 10 * 4)
  for (let i = 0; i < 10 * 10; i++) {
    redFrame[i * 4 + 0] = 255
    redFrame[i * 4 + 1] = 0
    redFrame[i * 4 + 2] = 0
    redFrame[i * 4 + 3] = 255
  }

  encoder.addFrame(redFrame, 10, 10, { delay: 100 })

  const buffer = encoder.finish()
  t.true(Buffer.isBuffer(buffer))
  t.true(isValidGif(buffer))
})

test('GifEncoder creates animated GIF with multiple frames', (t) => {
  const encoder = new GifEncoder(10, 10, { repeat: 0 })

  // Red frame
  const redFrame = new Uint8Array(10 * 10 * 4)
  for (let i = 0; i < 10 * 10; i++) {
    redFrame[i * 4 + 0] = 255
    redFrame[i * 4 + 1] = 0
    redFrame[i * 4 + 2] = 0
    redFrame[i * 4 + 3] = 255
  }

  // Blue frame
  const blueFrame = new Uint8Array(10 * 10 * 4)
  for (let i = 0; i < 10 * 10; i++) {
    blueFrame[i * 4 + 0] = 0
    blueFrame[i * 4 + 1] = 0
    blueFrame[i * 4 + 2] = 255
    blueFrame[i * 4 + 3] = 255
  }

  // Green frame
  const greenFrame = new Uint8Array(10 * 10 * 4)
  for (let i = 0; i < 10 * 10; i++) {
    greenFrame[i * 4 + 0] = 0
    greenFrame[i * 4 + 1] = 255
    greenFrame[i * 4 + 2] = 0
    greenFrame[i * 4 + 3] = 255
  }

  encoder.addFrame(redFrame, 10, 10, { delay: 500 })
  encoder.addFrame(blueFrame, 10, 10, { delay: 500 })
  encoder.addFrame(greenFrame, 10, 10, { delay: 500 })

  t.is(encoder.frameCount, 3)

  const buffer = encoder.finish()
  t.true(isValidGif(buffer))
  // Animated GIF should be larger than single frame
  t.true(buffer.length > 100)
})

test('GifEncoder with disposal methods', (t) => {
  const encoder = new GifEncoder(10, 10, { repeat: 0 })

  const frame = new Uint8Array(10 * 10 * 4)
  for (let i = 0; i < 10 * 10; i++) {
    frame[i * 4 + 0] = 255
    frame[i * 4 + 1] = 0
    frame[i * 4 + 2] = 0
    frame[i * 4 + 3] = 255
  }

  encoder.addFrame(frame, 10, 10, { delay: 100, disposal: GifDisposal.Keep })
  encoder.addFrame(frame, 10, 10, { delay: 100, disposal: GifDisposal.Background })
  encoder.addFrame(frame, 10, 10, { delay: 100, disposal: GifDisposal.Previous })

  const buffer = encoder.finish()
  t.true(isValidGif(buffer))
})

test('GifEncoder with frame offset (left/top)', (t) => {
  const encoder = new GifEncoder(20, 20, { repeat: 0 })

  // Small 5x5 frame
  const smallFrame = new Uint8Array(5 * 5 * 4)
  for (let i = 0; i < 5 * 5; i++) {
    smallFrame[i * 4 + 0] = 255
    smallFrame[i * 4 + 1] = 0
    smallFrame[i * 4 + 2] = 0
    smallFrame[i * 4 + 3] = 255
  }

  encoder.addFrame(smallFrame, 5, 5, { delay: 100, left: 0, top: 0 })
  encoder.addFrame(smallFrame, 5, 5, { delay: 100, left: 5, top: 5 })
  encoder.addFrame(smallFrame, 5, 5, { delay: 100, left: 10, top: 10 })

  const buffer = encoder.finish()
  t.true(isValidGif(buffer))
})

test('GifEncoder throws error with no frames', (t) => {
  const encoder = new GifEncoder(10, 10)

  const error = t.throws(() => {
    encoder.finish()
  })
  t.truthy(error)
})

test('GifEncoder throws error with invalid data length', (t) => {
  const encoder = new GifEncoder(10, 10)

  // Wrong size data (should be 10*10*4 = 400 bytes)
  const wrongData = new Uint8Array(100)

  const error = t.throws(() => {
    encoder.addFrame(wrongData, 10, 10)
  })
  t.truthy(error)
})

test('GifEncoder clears frames after finish()', (t) => {
  const encoder = new GifEncoder(10, 10)

  const frame = new Uint8Array(10 * 10 * 4)
  for (let i = 0; i < 10 * 10; i++) {
    frame[i * 4 + 0] = 255
    frame[i * 4 + 1] = 0
    frame[i * 4 + 2] = 0
    frame[i * 4 + 3] = 255
  }

  encoder.addFrame(frame, 10, 10, { delay: 100 })
  t.is(encoder.frameCount, 1)

  encoder.finish()
  t.is(encoder.frameCount, 0)
})

test('GifEncoder with finite repeat count', (t) => {
  const encoder = new GifEncoder(10, 10, { repeat: 3 }) // Play 3 times

  const frame = new Uint8Array(10 * 10 * 4)
  for (let i = 0; i < 10 * 10; i++) {
    frame[i * 4 + 0] = 128
    frame[i * 4 + 1] = 128
    frame[i * 4 + 2] = 128
    frame[i * 4 + 3] = 255
  }

  encoder.addFrame(frame, 10, 10, { delay: 100 })
  encoder.addFrame(frame, 10, 10, { delay: 100 })

  const buffer = encoder.finish()
  t.true(isValidGif(buffer))
})

// Test with canvas-drawn content

test('GifEncoder with canvas-drawn frames', (t) => {
  const width = 50
  const height = 50
  const encoder = new GifEncoder(width, height, { repeat: 0, quality: 10 })

  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')

  // Frame 1: Red circle
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = 'red'
  ctx.beginPath()
  ctx.arc(25, 25, 20, 0, Math.PI * 2)
  ctx.fill()

  let imageData = ctx.getImageData(0, 0, width, height)
  encoder.addFrame(new Uint8Array(imageData.data.buffer), width, height, { delay: 200 })

  // Frame 2: Blue circle
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = 'blue'
  ctx.beginPath()
  ctx.arc(25, 25, 20, 0, Math.PI * 2)
  ctx.fill()

  imageData = ctx.getImageData(0, 0, width, height)
  encoder.addFrame(new Uint8Array(imageData.data.buffer), width, height, { delay: 200 })

  // Frame 3: Green circle
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = 'green'
  ctx.beginPath()
  ctx.arc(25, 25, 20, 0, Math.PI * 2)
  ctx.fill()

  imageData = ctx.getImageData(0, 0, width, height)
  encoder.addFrame(new Uint8Array(imageData.data.buffer), width, height, { delay: 200 })

  t.is(encoder.frameCount, 3)

  const buffer = encoder.finish()
  t.true(isValidGif(buffer))
  t.true(buffer.length > 500) // Should be reasonably sized
})

test('GifEncoder with transparency', (t) => {
  const encoder = new GifEncoder(10, 10, { repeat: 0 })

  // Frame with semi-transparent pixels
  const frame = new Uint8Array(10 * 10 * 4)
  for (let i = 0; i < 10 * 10; i++) {
    frame[i * 4 + 0] = 255
    frame[i * 4 + 1] = 0
    frame[i * 4 + 2] = 0
    frame[i * 4 + 3] = i < 50 ? 0 : 255 // Half transparent, half opaque
  }

  encoder.addFrame(frame, 10, 10, { delay: 100 })

  const buffer = encoder.finish()
  t.true(isValidGif(buffer))
})

test('encode GIF with gradient (color quantization test)', async (t) => {
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')

  // Create a gradient with many colors
  const gradient = ctx.createLinearGradient(0, 0, 100, 100)
  gradient.addColorStop(0, 'red')
  gradient.addColorStop(0.25, 'yellow')
  gradient.addColorStop(0.5, 'green')
  gradient.addColorStop(0.75, 'blue')
  gradient.addColorStop(1, 'purple')

  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 100, 100)

  // GIF can only have 256 colors, so this tests the color quantization
  const buffer = await canvas.encode('gif', 10)
  t.true(isValidGif(buffer))
  t.true(buffer.length > 0)
})

// Symbol.dispose tests

test('GifEncoder.dispose() clears frames', (t) => {
  const encoder = new GifEncoder(10, 10)

  const frame = new Uint8Array(10 * 10 * 4)
  for (let i = 0; i < 10 * 10; i++) {
    frame[i * 4 + 0] = 255
    frame[i * 4 + 1] = 0
    frame[i * 4 + 2] = 0
    frame[i * 4 + 3] = 255
  }

  encoder.addFrame(frame, 10, 10, { delay: 100 })
  t.is(encoder.frameCount, 1)

  encoder.dispose()
  t.is(encoder.frameCount, 0)
})

test('GifEncoder has Symbol.dispose method', (t) => {
  // Symbol.dispose is available in Node.js 20+ with --harmony flag or Node.js 22+
  if (typeof Symbol.dispose === 'undefined') {
    t.pass('Symbol.dispose not available in this Node.js version, skipping')
    return
  }

  const encoder = new GifEncoder(10, 10)
  t.true(typeof (encoder as any)[Symbol.dispose] === 'function')
})

test('GifEncoder Symbol.dispose calls dispose()', (t) => {
  if (typeof Symbol.dispose === 'undefined') {
    t.pass('Symbol.dispose not available in this Node.js version, skipping')
    return
  }

  const encoder = new GifEncoder(10, 10)

  const frame = new Uint8Array(10 * 10 * 4)
  for (let i = 0; i < 10 * 10; i++) {
    frame[i * 4 + 0] = 255
    frame[i * 4 + 1] = 0
    frame[i * 4 + 2] = 0
    frame[i * 4 + 3] = 255
  }

  encoder.addFrame(frame, 10, 10, { delay: 100 })
  t.is(encoder.frameCount, 1)

  // Call Symbol.dispose directly
  ;(encoder as any)[Symbol.dispose]()
  t.is(encoder.frameCount, 0)
})
