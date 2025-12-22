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
  // Per HTML spec: complete is true initially, becomes false while loading, then true when loaded
  t.is(image.complete, true)
  image.src = file
  t.is(image.complete, false)
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
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => {
    resolve()
  }
  image.src = file
  await promise
  t.is(image.width, 450)
  t.is(image.height, 600)
})

test('draw-image-exif', async (t) => {
  const file = await fs.readFile(join(__dirname, 'fixtures', 'with-exif.jpg'))
  const image = new Image()
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => {
    resolve()
  }
  image.src = file
  await promise
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

test('complete should become false when valid src is set (HTML spec)', async (t) => {
  const file = await loadImageFile()
  const image = new Image()
  t.is(image.complete, true, 'initially true')

  // Set src but don't wait for load
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.src = file

  // complete should be false immediately after setting src
  t.is(image.complete, false, 'complete should be false while loading')

  await promise
  t.is(image.complete, true, 'complete should be true after load')
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

test('currentSrc should only be set after successful load (HTML spec)', async (t) => {
  const validFile = await loadImageFile()
  const image = new Image()

  // Initially null
  t.is(image.currentSrc, null, 'currentSrc should be null initially')

  // Set src - currentSrc should NOT be set immediately
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  image.onload = () => resolve()
  image.onerror = (err) => reject(err)
  image.src = validFile

  // Check immediately after setting src (before load completes)
  t.is(image.currentSrc, null, 'currentSrc should still be null before load completes')

  await promise

  // After successful load, currentSrc should be set
  t.is(image.currentSrc, '[Buffer]', 'currentSrc should be set after successful load')
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
  const slowFile = await loadImageFile()
  const image = new Image()
  let eventsFired = 0

  // Start loading an image
  image.onload = () => {
    eventsFired++
  }
  image.onerror = () => {
    eventsFired++
  }
  image.src = slowFile

  t.is(image.complete, false, 'should be false during load')

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

  // Load from file (internally caches file_content)
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Failed to load image'))
    image.src = imageFile
  })

  t.is(image.complete, true, 'image should be loaded')
  t.is(image.width, 300, 'width should be correct')

  // Clear src (should clear file_content and _avif_image_ref)
  image.src = ''

  t.is(image.complete, true, 'complete should be true after clearing')
  t.is(image.width, 0, 'width should be 0 after clearing')
  t.is(image.currentSrc, null, 'currentSrc should be null after clearing')

  // Reuse the same Image object with a different buffer (proves internal state was cleared)
  const secondBuffer = await fs.readFile(join(__dirname, 'fixtures', 'with-exif.jpg'))
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Failed to load second buffer'))
    image.src = secondBuffer
  })

  t.is(image.complete, true, 'image should load from second buffer')
  t.is(image.width, 450, 'width should match second buffer image')

  // Clear again and verify clean state
  image.src = ''
  t.is(image.width, 0, 'width should be 0 after second clear')
  t.is(image.complete, true, 'complete should be true after second clear')
})

test('overlapping loads should not cause premature completion (HTML spec)', async (t) => {
  const file1 = await loadImageFile()
  const file2 = await fs.readFile(join(__dirname, 'fixtures', 'with-exif.jpg'))
  const image = new Image()

  // Set src to file1 (starts async load)
  image.src = file1
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
  image.src = file2
  t.is(image.complete, false, 'should be false during second load')

  await promise

  // Should only have received one onload (for file2, not file1)
  t.is(loadCount, 1, 'should only fire onload once for the current load')
  t.is(image.complete, true, 'should be true after second load completes')
  t.is(image.naturalWidth, 450, 'should have file2 dimensions (with-exif.jpg), not file1')
  t.is(image.naturalHeight, 600, 'should have file2 dimensions (with-exif.jpg), not file1')
})
