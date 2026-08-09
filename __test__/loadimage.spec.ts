import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import { URL, pathToFileURL, fileURLToPath } from 'node:url'

import test from 'ava'
import { crc32 } from '@node-rs/crc32'

import { createCanvas, Image, loadImage } from '../index'

import { snapshotImage } from './image-snapshot'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('should load file src', async (t) => {
  const img = await loadImage(join(__dirname, '../example/simple.png'))
  t.is(img instanceof Image, true)
})

test('should load file stream', async (t) => {
  const img = await loadImage(fs.createReadStream(join(__dirname, '../example/simple.png')))
  t.is(img instanceof Image, true)
})

test('should load image with alt', async (t) => {
  const img = await loadImage(join(__dirname, '../example/simple.png'), {
    alt: 'demo-image',
  })
  t.is(img.alt, 'demo-image')
})

test('should load remote url', async (t) => {
  const img = await loadImage(
    'https://raw.githubusercontent.com/Brooooooklyn/canvas/462fce53afeaee6d6b4ae5d1b407c17e2359ff7e/example/anime-girl.png',
  )
  t.is(img instanceof Image, true)
  t.is(
    (await loadImage(
      new URL(
        'https://raw.githubusercontent.com/Brooooooklyn/canvas/462fce53afeaee6d6b4ae5d1b407c17e2359ff7e/example/anime-girl.png',
      ),
    )) instanceof Image,
    true,
  )
})

test('should load arrayBuffer', async (t) => {
  const imageBuffer = await readFile(join(__dirname, '../example/simple.png'))
  const img = await loadImage(imageBuffer.buffer)
  t.is(img instanceof Image, true)
  t.true(img.width > 0)
})

test('should load data uri', async (t) => {
  const img = await loadImage(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII',
  )
  t.is(img instanceof Image, true)
})

test('should prefer a PNG signature over an SVG marker in the buffer (issue #1308)', async (t) => {
  const canvas = createCanvas(64, 64)
  const png = canvas.toBuffer('image/png')
  const pngWithSvgMarker = Buffer.concat([png, Buffer.from('<svg xmlns')])

  const img = await loadImage(pngWithSvgMarker)

  t.is(img.width, 64)
  t.is(img.height, 64)
})

test('should draw img', async (t) => {
  const img = await loadImage(
    'https://raw.githubusercontent.com/Brooooooklyn/canvas/462fce53afeaee6d6b4ae5d1b407c17e2359ff7e/example/anime-girl.png',
  )

  // create a canvas of the same size as the image
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')

  // fill the canvas with the image
  ctx.fillStyle = '#23eff0'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 250, 250)

  await snapshotImage(t, { canvas }, 'jpeg', process.arch === 'x64' ? 0.05 : 0.3)
})

test('should load issue-672 img', async (t) => {
  const img = await loadImage(join(__dirname, './issue-672.jpeg'))
  t.is(img.width, 297)
  t.is(img.height, 465)
})

test('should load file url', async (t) => {
  const url = new URL('__test__/javascript.png', pathToFileURL(__dirname))
  const img = await loadImage(url)
  t.is(img.width, 512)
  t.is(img.height, 512)
})

// Regression tests for https://github.com/Brooooooklyn/canvas/issues/1255
// loadImage must settle (resolve or reject) for invalid inputs — must not hang.

const TIMEOUT_SENTINEL = Symbol('loadImage timed out')

async function settles<T>(promise: Promise<T>, ms = 2000): Promise<T | typeof TIMEOUT_SENTINEL> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race<T | typeof TIMEOUT_SENTINEL>([
      promise,
      new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test('loadImage settles on empty Buffer (issue #1255)', async (t) => {
  const result = await settles(loadImage(Buffer.alloc(0)).catch((e) => e))
  t.not(result, TIMEOUT_SENTINEL, 'loadImage(Buffer.alloc(0)) hung')
})

test('loadImage settles on tiny invalid Buffer (issue #1255)', async (t) => {
  const result = await settles(loadImage(Buffer.from([1])).catch((e) => e))
  t.not(result, TIMEOUT_SENTINEL, 'loadImage(Buffer.from([1])) hung')
})

test('loadImage settles on invalid base64 data URL (issue #1255)', async (t) => {
  const result = await settles(loadImage('data:image/png;base64,=').catch((e) => e))
  t.not(result, TIMEOUT_SENTINEL, 'loadImage("data:image/png;base64,=") hung')
})

// Regression tests for https://github.com/Brooooooklyn/canvas/issues/1309
// Run malformed inputs in child processes so a native crash is reported as a
// test failure instead of terminating the entire test runner.

function patchIhdr(png: Buffer, width: number, height: number, colorType?: number): Buffer {
  const result = Buffer.from(png)
  result.writeUInt32BE(width, 16)
  result.writeUInt32BE(height, 20)
  if (colorType !== undefined) result[25] = colorType
  result.writeUInt32BE(crc32(result.subarray(12, 29)), 29)
  return result
}

function runInChildProcess(
  script: string,
  args: string[],
): Promise<{
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Child process timed out after 10 seconds'))
    }, 10_000)

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr })
    })
  })
}

test('loadImage rejects malformed raster images without terminating the process (issue #1309)', async (t) => {
  const canvas = createCanvas(64, 64)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#345678'
  ctx.fillRect(0, 0, 64, 64)
  const png = canvas.toBuffer('image/png')

  const jpegSignature = Buffer.from(png)
  jpegSignature.set([0xff, 0xd8, 0xff, 0xe0], 0)

  const malformedImages = [
    ['PNG truncated mid-IDAT', png.subarray(0, 40)],
    ['PNG truncated after IHDR', png.subarray(0, 33)],
    [
      'PNG signature with random data and IEND',
      Buffer.concat([png.subarray(0, 8), Buffer.from('malformed raster payload'), png.subarray(-12)]),
    ],
    ['PNG with invalid color type', patchIhdr(png, 64, 64, 9)],
    ['PNG with zero dimensions', patchIhdr(png, 0, 0)],
    ['PNG payload with a JPEG signature', jpegSignature],
    ['PNG with excessive dimensions', patchIhdr(png, 100_000, 100_000)],
  ] as const

  const entrypoint = join(__dirname, '..', 'index.js')
  const script = `
    const { loadImage } = require(process.argv[1])
    loadImage(Buffer.from(process.argv[2], 'base64')).then(
      () => {
        console.error('unexpectedly resolved')
        process.exitCode = 2
      },
      (error) => console.log('rejected:', error.message),
    )
  `

  for (const [name, image] of malformedImages) {
    const child = await runInChildProcess(script, [entrypoint, image.toString('base64')])

    t.is(child.signal, null, `${name}: child terminated with ${child.signal}\n${child.stderr}`)
    t.is(child.status, 0, `${name}: child exited with ${child.status}\n${child.stderr}`)
    t.regex(child.stdout, /^rejected: Unsupported image type\n$/, name)
  }
})

test('loadImage preserves Skia partial decoding for sufficiently complete PNG data (issue #1309)', async (t) => {
  const canvas = createCanvas(64, 64)
  const png = canvas.toBuffer('image/png')

  const image = await loadImage(png.subarray(0, 119))

  t.is(image.width, 64)
  t.is(image.height, 64)
})
