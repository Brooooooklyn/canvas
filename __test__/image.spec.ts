import { promises as fs } from 'fs'
import { join } from 'path'
import test from 'ava'

import { createCanvas, Image, loadImage } from '../index'

import { snapshotImage } from './image-snapshot'

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
  t.is(image.complete, false)
  image.src = file
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

test('reset src to empty should not throw error', async (t) => {
  await t.notThrowsAsync(
    () =>
      new Promise<void>((resolve, reject) => {
        const image = new Image()
        image.onload = () => {
          resolve()
        }
        image.onerror = (err) => {
          reject(err)
        }
        image.src = Buffer.from('')
      }),
  )
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
