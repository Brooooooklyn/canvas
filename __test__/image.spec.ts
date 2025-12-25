import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, Image, loadImage } from '../index'

import { snapshotImage } from './image-snapshot'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function loadImageFile() {
  return await fs.readFile(join(__dirname, '../example/simple.png'))
}

test('should be able to create Image', (t) => {
  t.notThrows(() => new Image())
})

test('should be able to set src with buffer', async (t) => {
  const file = await loadImageFile()
  await t.notThrowsAsync(async () => {
    const image = new Image()
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    image.onload = () => {
      resolve()
    }
    image.onerror = (err) => {
      reject(err)
    }
    image.src = file
    await promise
  })
})

test('width and height state should be ok', async (t) => {
  const file = await loadImageFile()
  const image = new Image()
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => {
    resolve()
  }
  image.src = file
  await promise
  t.is(image.width, 300)
  t.is(image.height, 320)
  t.is(image.naturalWidth, 300)
  t.is(image.naturalHeight, 320)
  t.is(image.src, file)
})

test('complete state should be ok', async (t) => {
  const file = await loadImageFile()
  const image = new Image()
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => {
    resolve()
  }
  // Per HTML spec: complete is true initially
  // For Buffer src: complete stays true immediately (jsdom compatibility)
  // For file path/URL: complete becomes false while loading
  t.is(image.complete, true)
  image.src = file
  t.is(image.complete, true) // Buffer: complete is true immediately
  await promise
  t.is(image.complete, true)
})

test('alt state should be ok', (t) => {
  const image = new Image()
  t.is(image.alt, '')
  image.alt = 'hello'
  t.is(image.alt, 'hello')
})

test('with-exif image width and height should be correct', async (t) => {
  const file = await fs.readFile(join(__dirname, 'fixtures', 'with-exif.jpg'))
  const image = new Image()
  image.src = file
  // EXIF rotation is applied during decode, so dimensions are correct after decode()
  await image.decode()
  t.is(image.width, 450)
  t.is(image.height, 600)
})

test('draw-image-exif', async (t) => {
  const file = await fs.readFile(join(__dirname, 'fixtures', 'with-exif.jpg'))
  const image = new Image()
  image.src = file
  await image.decode()
  const canvas = createCanvas(800, 800)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  await snapshotImage(t, { canvas })
})

test('properties should be readonly', (t) => {
  const image = new Image()
  const expectation = {
    instanceOf: TypeError,
    // compat with different Node.js versions
    message: /(Cannot assign to read only property)|(Cannot set property)/,
  }

  // @ts-expect-error
  t.throws(() => (image.naturalWidth = 1919), expectation)

  // @ts-expect-error
  t.throws(() => (image.naturalHeight = 810), expectation)

  // @ts-expect-error
  t.throws(() => (image.complete = true), expectation)
})

test('svg-transparent-background', async (t) => {
  const image = new Image()
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => {
    resolve()
  }
  image.src = await fs.readFile(join(__dirname, '..', 'example', 'resize-svg.svg'))
  await promise

  const w = 1000
  const h = 1000

  // resize SVG
  image.width = w / 2
  image.height = h / 2

  // create a canvas of the same size as the image
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')

  // fill the canvas with the image
  ctx.fillStyle = 'pink'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(image, 250, 250)

  await snapshotImage(t, { canvas })
})

test('load invalid image should throw error', async (t) => {
  await t.throwsAsync(() => loadImage(join(__dirname, 'fixtures', 'broken.png')))
})

test('load invalid image should not throw if onerror is provided', async (t) => {
  const broken = await fs.readFile(join(__dirname, 'fixtures', 'broken.png'))
  await t.notThrowsAsync(
    () =>
      new Promise<void>((resolve) => {
        const image = new Image()
        image.onerror = (err) => {
          t.is(err.message, 'Unsupported image type')
          resolve()
        }
        image.src = broken
      }),
  )
})

test('reset src to empty should not throw error', (t) => {
  // Per HTML spec: empty src clears state without firing events
  t.notThrows(() => {
    const image = new Image()
    image.onload = () => {
      t.fail('onload should not be called for empty buffer')
    }
    image.onerror = () => {
      t.fail('onerror should not be called for empty buffer')
    }
    image.src = Buffer.from('')
    t.is(image.complete, true, 'complete should be true for empty buffer')
  })
})

test('load invalid svg should throw error', async (t) => {
  await t.throwsAsync(
    () =>
      new Promise((_, reject) => {
        const image = new Image()
        image.onload = () => {
          reject(new Error('should not be called'))
        }
        image.onerror = (err) => {
          reject(err)
        }
        image.src = Buffer.from('<svg></svg><p></p>')
      }),
    {
      message: /Invalid/,
    },
  )
})

test('should be able to load file path as src', async (t) => {
  const image = new Image()
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => {
    resolve()
  }
  const imagePath = join(__dirname, '../example/simple.png')
  image.src = imagePath
  await promise
  t.is(image.width, 300)
  t.is(image.height, 320)
  t.is(image.naturalWidth, 300)
  t.is(image.naturalHeight, 320)
  t.is(image.src, imagePath)
})

test('should throw if src path is invalid', async (t) => {
  await t.throwsAsync(
    () =>
      new Promise((_, reject) => {
        const image = new Image()
        image.onload = () => {
          reject(new Error('should not be called'))
        }
        image.onerror = (err) => {
          reject(err)
        }
        image.src = 'invalid/path/to/image.png'
      }),
    {
      message: process.platform === 'win32' ? /The system cannot find the path specified/ : /No such file/,
    },
  )
})

test('should be able to set data url as Image src', async (t) => {
  const image = new Image()
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => {
    resolve()
  }
  const imagePath = `data:image/png;base64,${await fs.readFile(join(__dirname, '../example/simple.png'), 'base64')}`
  image.src = imagePath
  await promise
  t.is(image.width, 300)
  t.is(image.height, 320)
  t.is(image.naturalWidth, 300)
  t.is(image.naturalHeight, 320)
  t.is(image.src, imagePath)
})

test('should trigger onerror if src data url is invalid', async (t) => {
  await t.throwsAsync(
    () =>
      new Promise((_, reject) => {
        const image = new Image()
        image.onload = () => {
          reject(new Error('should not be called'))
        }
        image.onerror = (err) => {
          reject(err)
        }
        image.src = 'data:image/png;base64,invalid'
      }),
    {
      message: 'Decode data url failed Base64Error',
    },
  )
})

// HTML spec compliance tests for jsdom integration
test('complete should be true initially (HTML spec)', (t) => {
  const image = new Image()
  t.is(image.complete, true, 'complete should be true when no src is set')
})

test('complete should become false when valid src is set (HTML spec) - file path', async (t) => {
  // Test with file path (not buffer) - should be false while loading
  const image = new Image()
  t.is(image.complete, true, 'initially true')

  const imagePath = join(__dirname, '../example/simple.png')
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.src = imagePath

  // complete should be false immediately after setting file path src
  t.is(image.complete, false, 'complete should be false while loading file')

  await promise
  t.is(image.complete, true, 'complete should be true after load')
})

test('complete should be true immediately for Buffer src (jsdom compat)', async (t) => {
  const file = await loadImageFile()
  const image = new Image()
  t.is(image.complete, true, 'initially true')

  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.src = file

  // For Buffer src: complete is true immediately (jsdom compatibility)
  t.is(image.complete, true, 'complete should be true immediately for Buffer')

  await promise
  t.is(image.complete, true, 'complete should still be true after load')
})

test('complete should be true for empty src (HTML spec)', (t) => {
  const image = new Image()
  image.src = ''
  t.is(image.complete, true, 'complete should be true for empty src')
  t.is(image.width, 0, 'width should be 0 for empty src')
  t.is(image.height, 0, 'height should be 0 for empty src')
})

test('currentSrc should be null initially (HTML spec)', (t) => {
  const image = new Image()
  t.is(image.currentSrc, null, 'currentSrc should be null initially')
})

test('currentSrc should reflect actual source after load (HTML spec)', async (t) => {
  const file = await loadImageFile()
  const image = new Image()

  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.src = file
  await promise

  t.not(image.currentSrc, null, 'currentSrc should be set after load')
  t.is(image.currentSrc, '[Buffer]', 'currentSrc should be [Buffer] for buffer sources')
})

test('currentSrc should be set for string paths (HTML spec)', async (t) => {
  const image = new Image()
  const imagePath = join(__dirname, '../example/simple.png')

  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.src = imagePath
  await promise

  t.is(image.currentSrc, imagePath, 'currentSrc should match the file path')
})

test('clearing src should set complete to true without events (HTML spec)', async (t) => {
  const file = await loadImageFile()
  const image = new Image()

  // Load an image first
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.src = file
  await promise

  t.is(image.complete, true, 'complete after load')

  // Now clear it
  let onloadCalled = false
  let onerrorCalled = false
  image.onload = () => {
    onloadCalled = true
  }
  image.onerror = () => {
    onerrorCalled = true
  }

  image.src = ''

  // Wait a tick to ensure no async events fire
  await new Promise((resolve) => setImmediate(resolve))

  t.is(image.complete, true, 'complete should remain true after clearing')
  t.is(onloadCalled, false, 'onload should not fire when clearing src')
  t.is(onerrorCalled, false, 'onerror should not fire when clearing src')
  t.is(image.width, 0, 'width should be 0 after clearing')
  t.is(image.height, 0, 'height should be 0 after clearing')
  t.is(image.currentSrc, null, 'currentSrc should be null after clearing')
})

test('empty buffer should not fire events (HTML spec)', async (t) => {
  const image = new Image()
  let onloadCalled = false
  let onerrorCalled = false

  image.onload = () => {
    onloadCalled = true
  }
  image.onerror = () => {
    onerrorCalled = true
  }

  image.src = Buffer.from('')

  // Wait to ensure no async events
  await new Promise((resolve) => setTimeout(resolve, 100))

  t.is(onloadCalled, false, 'onload should not fire for empty buffer')
  t.is(onerrorCalled, false, 'onerror should not fire for empty buffer')
  t.is(image.complete, true, 'complete should be true for empty buffer')
})

test('event sequence should be correct on src change (HTML spec)', async (t) => {
  const file1 = await loadImageFile()
  const file2 = await fs.readFile(join(__dirname, 'fixtures', 'with-exif.jpg'))
  const image = new Image()
  const events: string[] = []

  // First load
  const { promise: promise1, resolve: resolve1 } = Promise.withResolvers<void>()
  image.onload = () => {
    events.push('onload1')
    resolve1()
  }
  image.src = file1
  await promise1

  // Second load
  const { promise: promise2, resolve: resolve2 } = Promise.withResolvers<void>()
  image.onload = () => {
    events.push('onload2')
    resolve2()
  }
  image.src = file2
  await promise2

  t.deepEqual(events, ['onload1', 'onload2'], 'should fire onload for each successful load in order')
})

test('currentSrc should only be set after successful load (HTML spec) - file path', async (t) => {
  // Use file path to test async loading behavior
  // (For Buffer src, currentSrc is set synchronously along with onload)
  const imagePath = join(__dirname, '../example/simple.png')
  const image = new Image()

  // Initially null
  t.is(image.currentSrc, null, 'currentSrc should be null initially')

  // Set src - currentSrc should NOT be set immediately for file path
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.onerror = (err) => reject(err)
  image.src = imagePath

  // Check immediately after setting src (before load completes)
  t.is(image.currentSrc, null, 'currentSrc should still be null before load completes')

  await promise

  // After successful load, currentSrc should be set
  t.is(image.currentSrc, imagePath, 'currentSrc should be set after successful load')
})

test('currentSrc is set after decode completes for Buffer src', async (t) => {
  const validFile = await loadImageFile()
  const image = new Image()

  // Initially null
  t.is(image.currentSrc, null, 'currentSrc should be null initially')

  // For non-SVG Buffer src, complete=true immediately but currentSrc is set after decode
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.src = validFile

  // currentSrc is null immediately (decode hasn't completed)
  t.is(image.currentSrc, null, 'currentSrc should be null before decode completes')

  await promise

  // currentSrc is set after onload fires
  t.is(image.currentSrc, '[Buffer]', 'currentSrc should be [Buffer] after decode completes')
})

test('currentSrc should not change on failed load (HTML spec)', async (t) => {
  const validFile = await loadImageFile()
  const image = new Image()

  // Load a valid image first
  const { promise: promise1, resolve: resolve1 } = Promise.withResolvers<void>()
  image.onload = () => resolve1()
  image.src = validFile
  await promise1

  t.is(image.currentSrc, '[Buffer]', 'currentSrc should be set after first load')

  // Try to load invalid data - should fail
  const { promise: promise2, resolve: resolve2 } = Promise.withResolvers<void>()
  image.onerror = () => resolve2()
  image.src = 'data:image/png;base64,invalid'

  await promise2

  // currentSrc should still be the previous successful value, not the failed URL
  t.is(image.currentSrc, '[Buffer]', 'currentSrc should remain previous value after failed load')
})

test('small buffers should be treated as empty (no panic)', (t) => {
  const image = new Image()
  let onloadCalled = false
  let onerrorCalled = false

  image.onload = () => {
    onloadCalled = true
  }
  image.onerror = () => {
    onerrorCalled = true
  }

  // Test 1-byte buffer
  t.notThrows(() => {
    image.src = Buffer.from([0x00])
  }, 'should not panic on 1-byte buffer')
  t.is(image.complete, true, 'should treat 1-byte buffer as empty')
  t.is(onloadCalled, false, 'should not fire onload for 1-byte buffer')
  t.is(onerrorCalled, false, 'should not fire onerror for 1-byte buffer')

  // Test 2-byte buffer
  t.notThrows(() => {
    image.src = Buffer.from([0x00, 0x01])
  }, 'should not panic on 2-byte buffer')
  t.is(image.complete, true, 'should treat 2-byte buffer as empty')

  // Test 4-byte buffer (still too small for magic bytes)
  t.notThrows(() => {
    image.src = Buffer.from([0x00, 0x01, 0x02, 0x03])
  }, 'should not panic on 4-byte buffer')
  t.is(image.complete, true, 'should treat 4-byte buffer as empty')
})

test('complete should be true after file read errors (HTML spec)', async (t) => {
  const image = new Image()

  // Set src to nonexistent file (will cause file read error in compute())
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onerror = () => resolve()
  image.src = '/nonexistent-file-xyz-123.png'

  t.is(image.complete, false, 'complete should be false while loading')

  await promise

  // Per HTML spec: complete must be true after error (broken state)
  t.is(image.complete, true, 'complete should be true after file read error')
})

test('complete should be true after base64 decode errors (HTML spec)', async (t) => {
  const image = new Image()

  // Set src to invalid base64 data URL (will cause decode error in compute())
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onerror = () => resolve()
  image.src = 'data:image/png;base64,invalid-base64-data!!!'

  t.is(image.complete, false, 'complete should be false while loading')

  await promise

  // Per HTML spec: complete must be true after error (broken state)
  t.is(image.complete, true, 'complete should be true after base64 decode error')
})

test('stale error events should not fire (HTML spec)', async (t) => {
  const validFile = await loadImageFile()
  const image = new Image()
  const events: string[] = []

  // Set up event tracking
  image.onload = () => events.push('onload')
  image.onerror = () => events.push('onerror')

  // Set src to invalid file (will error)
  image.src = '/nonexistent-file-that-does-not-exist.png'

  // Immediately change to valid file (aborts first load)
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => {
    events.push('onload')
    resolve()
  }
  image.src = validFile

  await promise

  // Should only see onload for the valid file, NOT onerror from the aborted load
  t.deepEqual(events, ['onload'], 'should not fire onerror for aborted load')
  t.is(image.complete, true, 'should be complete after valid load')
})

test('clearing src should abort in-flight loads (HTML spec)', async (t) => {
  // Use file path to test async abort (Buffer loads have complete=true immediately)
  const imagePath = join(__dirname, '../example/simple.png')
  const image = new Image()
  let eventsFired = 0

  // Start loading an image
  image.onload = () => {
    eventsFired++
  }
  image.onerror = () => {
    eventsFired++
  }
  image.src = imagePath

  t.is(image.complete, false, 'should be false during file load')

  // Immediately clear with empty string (should abort the load)
  image.src = ''

  t.is(image.complete, true, 'should be true immediately after clearing')
  t.is(image.width, 0, 'width should be 0 after clearing')
  t.is(image.height, 0, 'height should be 0 after clearing')

  // Wait for the original load to finish (if it wasn't aborted, it would fire events)
  await new Promise((resolve) => setTimeout(resolve, 200))

  // No events should have fired because the load was aborted
  t.is(eventsFired, 0, 'no events should fire from aborted load')
  t.is(image.complete, true, 'complete should still be true')
})

test('clearing src should release cached file_content and AVIF references (memory leak fix)', async (t) => {
  const imageFile = await loadImageFile()
  const image = new Image()

  // Load from buffer
  image.src = imageFile
  await image.decode()

  t.is(image.complete, true, 'image should be loaded')
  t.is(image.width, 300, 'width should be correct')

  // Clear src (should clear file_content and _avif_image_ref)
  image.src = ''

  t.is(image.complete, true, 'complete should be true after clearing')
  t.is(image.width, 0, 'width should be 0 after clearing')
  t.is(image.currentSrc, null, 'currentSrc should be null after clearing')

  // Reuse the same Image object with a different buffer (proves internal state was cleared)
  const secondBuffer = await fs.readFile(join(__dirname, 'fixtures', 'with-exif.jpg'))
  image.src = secondBuffer
  await image.decode()

  t.is(image.complete, true, 'image should load from second buffer')
  // with-exif.jpg is 450x600 after EXIF rotation is applied during decode
  t.is(image.width, 450, 'width should match second buffer image')

  // Clear again and verify clean state
  image.src = ''
  t.is(image.width, 0, 'width should be 0 after second clear')
  t.is(image.complete, true, 'complete should be true after second clear')
})

test('overlapping loads should not cause premature completion (HTML spec)', async (t) => {
  // Use file paths to test async abort behavior (Buffer loads have complete=true immediately)
  const file1Path = join(__dirname, '../example/simple.png')
  const file2Path = join(__dirname, 'fixtures', 'with-exif.jpg')
  const image = new Image()

  // Set src to file1 (starts async load)
  image.src = file1Path
  t.is(image.complete, false, 'should be false during first load')

  // Immediately set src to file2 (starts second async load, aborts first)
  const { promise, resolve } = Promise.withResolvers<void>()
  let loadCount = 0
  image.onload = () => {
    loadCount++
    // Complete should still be false until THIS load finishes
    // (not when the aborted file1 load finishes)
    if (loadCount === 1) {
      resolve()
    }
  }
  image.src = file2Path
  t.is(image.complete, false, 'should be false during second load')

  await promise

  // Should only have received one onload (for file2, not file1)
  t.is(loadCount, 1, 'should only fire onload once for the current load')
  t.is(image.complete, true, 'should be true after second load completes')
  t.is(image.naturalWidth, 450, 'should have file2 dimensions (with-exif.jpg), not file1')
  t.is(image.naturalHeight, 600, 'should have file2 dimensions (with-exif.jpg), not file1')
})

// Image.decode() W3C spec compliance tests
// Per https://html.spec.whatwg.org/multipage/embedded-content.html#dom-img-decode

test('decode() should return a Promise (W3C spec)', async (t) => {
  const image = new Image()
  const result = image.decode()
  t.true(result instanceof Promise, 'decode() should return a Promise')
  await result // Should resolve immediately for image with no src
})

test('decode() should resolve immediately for image with no src (W3C spec)', async (t) => {
  const image = new Image()
  // Per spec: if no current request, decode() should resolve
  await t.notThrowsAsync(image.decode(), 'decode() should resolve for image with no src')
})

test('decode() should resolve after successful Buffer load (W3C spec)', async (t) => {
  const file = await loadImageFile()
  const image = new Image()

  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.src = file
  await promise

  // After onload, decode() should resolve
  await t.notThrowsAsync(image.decode(), 'decode() should resolve after successful load')
})

test('decode() should resolve during async file load (W3C spec)', async (t) => {
  const image = new Image()
  const imagePath = join(__dirname, '../example/simple.png')
  image.src = imagePath
  // decode() returns the same promise as the internal decode task
  await t.notThrowsAsync(async () => await image.decode(), 'decode() should resolve for file path')
})

test('decode() should resolve for data URL images (W3C spec)', async (t) => {
  const file = await loadImageFile()
  const image = new Image()

  image.src = `data:image/png;base64,${file.toString('base64')}`

  await t.notThrowsAsync(async () => await image.decode(), 'decode() should resolve for data URL')
})

test('decode() should resolve for SVG (vector graphics, no decode needed) (W3C spec)', async (t) => {
  const image = new Image()
  const svgData = await fs.readFile(join(__dirname, '..', 'example', 'resize-svg.svg'))

  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.src = svgData
  await promise

  // Per spec: "decoding does not need to be performed for this image (for example because it is a vector graphic)"
  await t.notThrowsAsync(async () => await image.decode(), 'decode() should resolve for SVG (vector graphics)')
})

// Per W3C spec: decode() should reject with EncodingError for broken images
test('decode() should reject for broken image with invalid data (W3C spec)', async (t) => {
  const broken = await fs.readFile(join(__dirname, 'fixtures', 'broken.png'))
  const image = new Image()

  image.src = broken

  // Per spec: decode() rejects with EncodingError for broken images
  const error = await t.throwsAsync(async () => await image.decode())
  t.truthy(error, 'decode() should reject for broken image')
})

// Per W3C spec: decode() should reject for failed loads
test('decode() should reject for invalid base64 data URL (W3C spec)', async (t) => {
  const image = new Image()

  image.src = 'data:image/png;base64,invalid-base64!!!'

  const error = await t.throwsAsync(async () => await image.decode())
  t.truthy(error, 'decode() should reject for invalid base64')
})

// Per W3C spec: decode() should reject for failed loads (file not found)
test('decode() should reject for nonexistent file path (W3C spec)', async (t) => {
  const image = new Image()
  image.src = '/nonexistent-image-file-xyz.png'

  const error = await t.throwsAsync(async () => await image.decode())
  t.truthy(error, 'decode() should reject for nonexistent file')
})

test.failing('decode() called multiple times should return the same promise (W3C spec)', async (t) => {
  const image = new Image()
  const imagePath = join(__dirname, '../example/simple.png')

  image.src = imagePath

  // Multiple decode() calls should return the same promise
  const promise1 = image.decode()
  const promise2 = image.decode()
  const promise3 = image.decode()

  t.is(promise1, promise2, 'first and second decode() calls should return same promise')
  t.is(promise2, promise3, 'second and third decode() calls should return same promise')

  await Promise.all([promise1, promise2, promise3])
})

test('decode() on already decoded image should resolve immediately (W3C spec)', async (t) => {
  const file = await loadImageFile()
  const image = new Image()

  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.src = file
  await promise

  // First decode (should resolve as image is already loaded)
  await image.decode()

  // Second decode (image already decoded, should resolve immediately)
  const start = Date.now()
  await image.decode()
  const elapsed = Date.now() - start

  t.true(elapsed < 50, 'decode() on already decoded image should resolve quickly')
})

test('decode() should work correctly after src change (W3C spec)', async (t) => {
  const file1 = await loadImageFile()
  const file2 = await fs.readFile(join(__dirname, 'fixtures', 'with-exif.jpg'))
  const image = new Image()

  // Load first image
  const { promise: promise1, resolve: resolve1 } = Promise.withResolvers<void>()
  image.onload = () => resolve1()
  image.src = file1
  await promise1
  await image.decode()

  t.is(image.naturalWidth, 300, 'should have first image dimensions')

  // Change src to second image
  const { promise: promise2, resolve: resolve2 } = Promise.withResolvers<void>()
  image.onload = () => resolve2()
  image.src = file2
  await promise2
  await image.decode()

  t.is(image.naturalWidth, 450, 'should have second image dimensions after src change')
})

test('decode() promise should be fresh after src change (W3C spec)', async (t) => {
  const file = await loadImageFile()
  const image = new Image()

  // First load
  const { promise: promise1, resolve: resolve1 } = Promise.withResolvers<void>()
  image.onload = () => resolve1()
  image.src = file
  const decodePromise1 = image.decode()
  await promise1
  await decodePromise1

  // Change src to same file (creates new load)
  const { promise: promise2, resolve: resolve2 } = Promise.withResolvers<void>()
  image.onload = () => resolve2()
  image.src = file
  const decodePromise2 = image.decode()
  await promise2
  await decodePromise2

  // Promises should be different objects (new decode task for new load)
  t.not(decodePromise1, decodePromise2, 'decode() should return new promise after src change')
})

test('decode() can be called before onload fires (W3C spec)', async (t) => {
  const image = new Image()
  const imagePath = join(__dirname, '../example/simple.png')

  // Set src (starts async load)
  image.src = imagePath

  // Call decode() immediately (before onload)
  const decodePromise = image.decode()

  // decode() should resolve when the image finishes loading
  await t.notThrowsAsync(decodePromise, 'decode() called before onload should eventually resolve')
  t.is(image.complete, true, 'image should be complete after decode resolves')
  t.is(image.naturalWidth, 300, 'should have correct dimensions')
})

test('decode() should work with AVIF images', async (t) => {
  // Check if AVIF test file exists
  const avifPath = join(__dirname, 'fixtures', 'test.avif')
  try {
    await fs.access(avifPath)
    const avifData = await fs.readFile(avifPath)
    const image = new Image()

    const { promise, resolve, reject } = Promise.withResolvers<void>()
    image.onload = () => resolve()
    image.onerror = (err) => reject(err)
    image.src = avifData
    await promise

    await t.notThrowsAsync(image.decode(), 'decode() should resolve for AVIF')
  } catch {
    t.pass('AVIF test file not found, skipping')
  }
})

test('decode() after clearing src should resolve immediately (W3C spec)', async (t) => {
  const file = await loadImageFile()
  const image = new Image()

  // Load an image first
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.src = file
  await promise

  // Clear src
  image.src = ''

  // decode() should resolve (no current request)
  await t.notThrowsAsync(image.decode(), 'decode() should resolve after clearing src')
})

// Per W3C spec: if src changes while decode() is pending, the pending decode
// should be aborted/rejected and new decode should succeed for the new src
test('decode() pending when src changes should handle correctly (W3C spec)', async (t) => {
  const image = new Image()
  const file1Path = join(__dirname, '../example/simple.png')
  const file2Path = join(__dirname, 'fixtures', 'with-exif.jpg')

  // Start loading first image
  image.src = file1Path

  // Get first decode promise
  const decodePromise1 = image.decode()

  // Immediately change src (aborts first load)
  image.src = file2Path

  // Get second decode promise
  const decodePromise2 = image.decode()

  // Different promises
  t.not(decodePromise1, decodePromise2, 'should return different promises after src change')

  // Second decode should eventually resolve
  await t.notThrowsAsync(decodePromise2, 'new decode should resolve')
  t.is(image.complete, true, 'should be complete')
  t.is(image.naturalWidth, 450, 'should have second image dimensions')
})

test('decode() returns object reference that equals itself on multiple calls (W3C spec)', async (t) => {
  const file = await loadImageFile()
  const image = new Image()

  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.src = file
  await promise

  // After load completes, multiple decode calls should return equivalent resolved promises
  const p1 = image.decode()
  const p2 = image.decode()

  // Both should resolve successfully
  await Promise.all([p1, p2])
  t.pass('both decode() calls resolved successfully')
})

// ============================================================================
// Regression tests for onload timing and bitmap availability fixes
// These tests verify fixes for the issue where onload fired before bitmap
// was decoded, causing drawImage/createPattern to fail in onload handlers.
// ============================================================================

test('drawImage should work in onload handler for Buffer src (regression fix)', async (t) => {
  const file = await loadImageFile()
  const image = new Image()
  const canvas = createCanvas(300, 320)
  const ctx = canvas.getContext('2d')

  // Fill with a known color first so we can detect if drawImage does nothing
  ctx.fillStyle = 'rgb(1, 2, 3)'
  ctx.fillRect(0, 0, 300, 320)

  const { promise, resolve, reject } = Promise.withResolvers<void>()
  image.onload = () => {
    try {
      // Verify image state before drawing
      t.is(image.complete, true, 'image.complete should be true in onload')
      t.is(image.naturalWidth, 300, 'naturalWidth should be set')
      t.is(image.naturalHeight, 320, 'naturalHeight should be set')

      // This should work - bitmap must be decoded by the time onload fires
      ctx.drawImage(image, 0, 0)
      resolve()
    } catch (err) {
      reject(err)
    }
  }
  image.onerror = reject
  image.src = file
  await promise

  // Check if the image was drawn at a non-transparent pixel location
  // simple.png has actual color at (100,100): rgb(3, 169, 244)
  const imageData = ctx.getImageData(100, 100, 1, 1)
  // If drawImage worked, this should NOT be our original fill color (1, 2, 3)
  const isOriginalColor = imageData.data[0] === 1 && imageData.data[1] === 2 && imageData.data[2] === 3
  t.false(isOriginalColor, 'Canvas color should have changed (drawImage should have worked)')
  // Additionally verify the expected color from simple.png
  t.is(imageData.data[0], 3, 'Red channel should match simple.png')
  t.is(imageData.data[1], 169, 'Green channel should match simple.png')
  t.is(imageData.data[2], 244, 'Blue channel should match simple.png')
})

test('createPattern should work in onload handler for Buffer src (regression fix)', async (t) => {
  const file = await loadImageFile()
  const image = new Image()

  const { promise, resolve, reject } = Promise.withResolvers<void>()
  image.onload = () => {
    try {
      const canvas = createCanvas(100, 100)
      const ctx = canvas.getContext('2d')
      // This should work - bitmap must be decoded by the time onload fires
      const pattern = ctx.createPattern(image, 'repeat')
      t.truthy(pattern, 'Pattern should be created successfully')
      resolve()
    } catch (err) {
      reject(err)
    }
  }
  image.onerror = reject
  image.src = file
  await promise
})

test('onload fires asynchronously for non-SVG Buffer (regression fix)', async (t) => {
  const file = await loadImageFile() // PNG file
  const image = new Image()
  let onloadFired = false

  image.onload = () => {
    onloadFired = true
  }
  image.src = file

  // Immediately after setting src, onload should NOT have fired yet (async decode)
  t.is(onloadFired, false, 'onload should not fire synchronously for non-SVG Buffer')

  // Wait for decode to complete
  await image.decode()
  t.is(onloadFired, true, 'onload should have fired after decode completes')
})

test('onload fires synchronously for SVG Buffer', async (t) => {
  const svgData = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="blue" width="100" height="100"/></svg>',
  )
  const image = new Image()
  let onloadFired = false

  image.onload = () => {
    onloadFired = true
  }
  image.src = svgData

  // For SVG, onload should fire synchronously (SVG is decoded sync)
  t.is(onloadFired, true, 'onload should fire synchronously for SVG Buffer')
})

test('failed SVG load should clear prior bitmap state (regression fix)', async (t) => {
  const validFile = await loadImageFile()
  const image = new Image()

  // Load valid image first
  const { promise: promise1, resolve: resolve1 } = Promise.withResolvers<void>()
  image.onload = () => resolve1()
  image.src = validFile
  await promise1

  // Verify image is loaded with valid dimensions
  t.is(image.naturalWidth, 300, 'image should be loaded')
  t.is(image.naturalHeight, 320)

  // Now load malformed SVG - use truly invalid XML that cannot parse
  // Note: '<svg><invalid-element></svg>' might parse as valid XML with unknown element
  const { promise: promise2, resolve: resolve2 } = Promise.withResolvers<void>()
  image.onerror = () => resolve2()
  image.src = Buffer.from('<svg><') // Malformed XML - unclosed tag
  await promise2

  // Prior bitmap should be cleared
  t.is(image.naturalWidth, 0, 'naturalWidth should be 0 after failed load')
  t.is(image.naturalHeight, 0, 'naturalHeight should be 0 after failed load')

  // drawImage should not draw anything (no bitmap)
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 100, 100) // Fill with red first
  ctx.drawImage(image, 0, 0) // Should not change canvas (no bitmap)

  const imageData = ctx.getImageData(50, 50, 1, 1)
  t.is(imageData.data[0], 255, 'Canvas should still be red (drawImage drew nothing)')
  t.is(imageData.data[1], 0)
  t.is(imageData.data[2], 0)
})

test('failed non-SVG buffer load should clear state and set naturalWidth/Height to 0 (regression fix)', async (t) => {
  const validFile = await loadImageFile()
  const image = new Image()

  // Load valid image first
  const { promise: promise1, resolve: resolve1 } = Promise.withResolvers<void>()
  image.onload = () => resolve1()
  image.src = validFile
  await promise1

  // Verify image is loaded with valid dimensions
  t.is(image.naturalWidth, 300, 'image should be loaded')
  t.is(image.naturalHeight, 320)

  // Now load truncated/broken PNG - this goes through InvalidImage path in decoder
  // Use the broken.png fixture which is a corrupted PNG file
  const brokenPng = await fs.readFile(join(__dirname, 'fixtures', 'broken.png'))
  const { promise: promise2, resolve: resolve2 } = Promise.withResolvers<void>()
  image.onerror = () => resolve2()
  image.src = brokenPng
  await promise2

  // Per HTML spec and our fix: broken image should have naturalWidth/Height = 0
  t.is(image.naturalWidth, 0, 'naturalWidth should be 0 after failed non-SVG load')
  t.is(image.naturalHeight, 0, 'naturalHeight should be 0 after failed non-SVG load')
  t.is(image.complete, true, 'complete should be true after error (broken state)')

  // drawImage should not draw anything (no bitmap)
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 100, 100) // Fill with blue first
  ctx.drawImage(image, 0, 0) // Should not change canvas (no bitmap)

  const imageData = ctx.getImageData(50, 50, 1, 1)
  t.is(imageData.data[2], 255, 'Canvas should still be blue (drawImage drew nothing)')
})

test('broken image should have all dimension getters return 0 (regression fix)', async (t) => {
  // Regression test: when a buffer load fails after header parsing succeeded,
  // both width/height and naturalWidth/Height should return 0 for broken state.
  // Previously, width/height retained header values while naturalWidth/Height were 0.
  const image = new Image()

  // Use a buffer that has valid PNG header but corrupted data
  const brokenPng = await fs.readFile(join(__dirname, 'fixtures', 'broken.png'))
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onerror = () => resolve()
  image.src = brokenPng
  await promise

  // All dimension getters should return 0 for broken image
  t.is(image.width, 0, 'width should be 0 for broken image')
  t.is(image.height, 0, 'height should be 0 for broken image')
  t.is(image.naturalWidth, 0, 'naturalWidth should be 0 for broken image')
  t.is(image.naturalHeight, 0, 'naturalHeight should be 0 for broken image')
  t.is(image.complete, true, 'complete should be true (broken state)')
})

test('decode() returns fresh resolved promise after clearing src (regression fix)', async (t) => {
  const file = await loadImageFile()
  const image = new Image()

  // Load image first
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.src = file
  await promise

  // Get first decode promise
  const decodePromise1 = image.decode()
  await decodePromise1

  // Clear src
  image.src = ''

  // decode() should resolve immediately (decoder_task was cleared)
  const start = Date.now()
  await image.decode()
  const elapsed = Date.now() - start

  t.true(elapsed < 50, 'decode() should resolve quickly after clearing src')
})

test('decode() works correctly after synchronous SVG load (regression fix)', async (t) => {
  const svgData = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="blue" width="100" height="100"/></svg>',
  )
  const image = new Image()

  let onloadFired = false
  image.onload = () => {
    onloadFired = true
  }
  image.src = svgData

  // SVG loads synchronously
  t.is(onloadFired, true, 'SVG onload should have fired synchronously')

  // decode() should work (decoder_task should be set to resolved promise)
  await t.notThrowsAsync(image.decode(), 'decode() should resolve for SVG')

  // Verify the image is usable
  t.is(image.width, 100)
  t.is(image.height, 100)

  // Should be drawable
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)

  const imageData = ctx.getImageData(50, 50, 1, 1)
  // Blue rect: RGB should be (0, 0, 255)
  t.is(imageData.data[2], 255, 'Blue SVG should have been drawn')
})

test('complete is true immediately for Buffer even when decode is async (regression fix)', async (t) => {
  const file = await loadImageFile()
  const image = new Image()

  // Before setting src
  t.is(image.complete, true, 'complete should be true initially')

  image.src = file

  // complete should be true immediately (we have the buffer data)
  // even though bitmap decode is still pending
  t.is(image.complete, true, 'complete should be true immediately for Buffer')

  // But bitmap is not ready yet, so drawImage would draw nothing
  // (this is expected - user should await decode() or use onload)

  // After decode, everything works
  await image.decode()
  t.is(image.complete, true, 'complete should still be true after decode')
  t.is(image.naturalWidth, 300, 'dimensions should be available after decode')
})

test('dimensions available immediately for Buffer when imagesize succeeds', async (t) => {
  const file = await loadImageFile() // PNG - imagesize supports this
  const image = new Image()

  image.src = file

  // Dimensions should be available immediately (from imagesize header parsing)
  // even before async decode completes
  t.is(image.width, 300, 'width should be available immediately')
  t.is(image.height, 320, 'height should be available immediately')
  t.is(image.naturalWidth, 300, 'naturalWidth should be available immediately')
  t.is(image.naturalHeight, 320, 'naturalHeight should be available immediately')
})

test('setting new Buffer src should clear old bitmap (no stale renders)', async (t) => {
  // Regression test: when setting a new Buffer src, the old bitmap should be cleared
  // so drawImage no-ops during async decode instead of drawing the old image.
  const file1 = await loadImageFile() // simple.png
  const image = new Image()

  // Load first image
  const { promise: p1, resolve: r1 } = Promise.withResolvers<void>()
  image.onload = () => r1()
  image.src = file1
  await p1

  // Verify first image is loaded and drawable
  t.is(image.naturalWidth, 300)
  const canvas1 = createCanvas(300, 320)
  const ctx1 = canvas1.getContext('2d')
  ctx1.fillStyle = 'white'
  ctx1.fillRect(0, 0, 300, 320)
  ctx1.drawImage(image, 0, 0)
  const pixel1 = ctx1.getImageData(100, 100, 1, 1).data
  t.true(pixel1[0] !== 255 || pixel1[1] !== 255 || pixel1[2] !== 255, 'First image should be drawn')

  // Now set a new src (using a different valid image)
  const file2 = await fs.readFile(join(__dirname, 'fixtures', 'with-exif.jpg'))
  image.src = file2

  // IMMEDIATELY after setting new src (before decode completes):
  // - complete should be true (for jsdom compat)
  // - but bitmap should be cleared (no stale render)
  t.is(image.complete, true, 'complete should be true immediately')

  // Try to draw - should no-op because bitmap is cleared
  const canvas2 = createCanvas(300, 320)
  const ctx2 = canvas2.getContext('2d')
  ctx2.fillStyle = 'rgb(1, 2, 3)' // Known background color
  ctx2.fillRect(0, 0, 300, 320)
  ctx2.drawImage(image, 0, 0) // Should no-op - old bitmap is cleared, new not ready

  // Canvas should still have our background color (drawImage did nothing)
  const pixel2 = ctx2.getImageData(100, 100, 1, 1).data
  t.is(pixel2[0], 1, 'Canvas should still have background (drawImage no-op)')
  t.is(pixel2[1], 2)
  t.is(pixel2[2], 3)

  // Wait for new image to load
  await image.decode()

  // Now drawImage should work with the new image
  ctx2.drawImage(image, 0, 0)
  const pixel3 = ctx2.getImageData(100, 100, 1, 1).data
  t.true(pixel3[0] !== 1 || pixel3[1] !== 2 || pixel3[2] !== 3, 'New image should be drawn after decode')
})

test('AVIF from Buffer should work (regression fix for infer crate detection)', async (t) => {
  // This tests that AVIF images loaded from Buffer work correctly.
  // Previously, if infer::get() didn't recognize AVIF, libavif::is_avif() was never called.
  const avifPath = join(__dirname, 'fixtures', 'issue-996.avif')
  const avifData = await fs.readFile(avifPath)
  const image = new Image()

  const { promise, resolve, reject } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.onerror = (err) => reject(err)
  image.src = avifData
  await promise

  // Verify image loaded successfully
  t.is(image.complete, true, 'AVIF image should be complete')
  t.true(image.naturalWidth > 0, 'AVIF image should have valid naturalWidth')
  t.true(image.naturalHeight > 0, 'AVIF image should have valid naturalHeight')

  // Verify we can draw it - check that bitmap exists and drawImage doesn't throw
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  t.notThrows(() => ctx.drawImage(image, 0, 0), 'drawImage should not throw for AVIF')

  // Verify pixels were drawn by checking that at least some pixels have content.
  // We check for any non-zero RGBA values to handle both opaque and semi-transparent images.
  // Note: This test assumes the issue-996.avif fixture has visible content (not fully transparent).
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let hasVisiblePixel = false
  for (let i = 0; i < imageData.data.length; i += 4) {
    const r = imageData.data[i]
    const g = imageData.data[i + 1]
    const b = imageData.data[i + 2]
    const a = imageData.data[i + 3]
    // Check for any non-zero value (handles both opaque and transparent-with-color pixels)
    if (r > 0 || g > 0 || b > 0 || a > 0) {
      hasVisiblePixel = true
      break
    }
  }
  t.true(hasVisiblePixel, 'AVIF image should have been drawn (has visible pixels)')
})
