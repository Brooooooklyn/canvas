import { pbkdf2 } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReadableStream } from 'node:stream/web'

import test, { type ExecutionContext } from 'ava'

import { createCanvas, type Canvas, type SKRSContext2D } from '../index.js'

// While an async encode is pending, the canvas stays usable, as in Chrome:
// CanvasAsyncBlobCreator holds only the call-time snapshot, never the canvas.
// Each pending result is the bitmap at the time of its call.

type Output = Buffer | string

// Occupy every libuv worker so the async encode task is queued behind them
// and cannot start before the main thread uses the canvas. This makes the
// call-time snapshot check strict. It costs 8 pbkdf2 jobs per test, so it
// runs on arm64 macOS CI only; elsewhere the tests still check that each
// call works while the encode is pending (the borrow guard of napi-rs #3584).
const OCCUPY_THREADPOOL = process.platform === 'darwin' && process.arch === 'arm64' && !!process.env.CI

function occupyThreadpool(count = OCCUPY_THREADPOOL ? 8 : 0): Promise<unknown>[] {
  return Array.from(
    { length: count },
    () =>
      new Promise((resolve, reject) => {
        pbkdf2('a', 'b', 1_000_000, 32, 'sha512', (err, key) => (err ? reject(err) : resolve(key)))
      }),
  )
}

function drawRed(ctx: SKRSContext2D) {
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 256, 256)
}

function drawBlue(ctx: SKRSContext2D) {
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 256, 256)
}

function redCanvas() {
  const canvas = createCanvas(256, 256)
  const ctx = canvas.getContext('2d')
  drawRed(ctx)
  return { canvas, ctx }
}

const blobBytes = async (blob: Blob) => Buffer.from(await blob.arrayBuffer())

async function streamBytes(stream: ReadableStream<Buffer>) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

// savePng is not in index.d.ts.
type SavePngCanvas = Canvas & { savePng(path: string): void }

function savedPng(canvas: Canvas) {
  const dir = mkdtempSync(join(tmpdir(), 'async-encode-pending-'))
  try {
    const path = join(dir, 'out.png')
    ;(canvas as SavePngCanvas).savePng(path)
    return readFileSync(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const pixel = (ctx: SKRSContext2D) => [...ctx.getImageData(128, 128, 1, 1).data]
const BLUE = [0, 0, 255, 255]

interface Op {
  name: string
  /** Starts the async op; the native call runs before this returns. */
  start(canvas: Canvas): Promise<Output>
  /** The sync form that gives the same bytes for the current pixels. */
  sync(canvas: Canvas): Output
}

const OPS: Op[] = [
  {
    name: "encode('png')",
    start: (canvas) => canvas.encode('png'),
    sync: (canvas) => canvas.encodeSync('png'),
  },
  {
    name: "toDataURLAsync('image/png')",
    start: (canvas) => canvas.toDataURLAsync('image/png'),
    sync: (canvas) => canvas.toDataURL('image/png'),
  },
  {
    name: 'toBlob(callback)',
    start: (canvas) =>
      new Promise<Buffer>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? blobBytes(blob).then(resolve, reject) : reject(new Error('toBlob callback received null'))),
          'image/png',
        )
      }),
    sync: (canvas) => canvas.encodeSync('png'),
  },
  {
    name: 'convertToBlob()',
    start: (canvas) => canvas.convertToBlob().then(blobBytes),
    sync: (canvas) => canvas.encodeSync('png'),
  },
]

function same(t: ExecutionContext, actual: Output, expected: Output, message: string) {
  if (typeof expected === 'string') {
    t.is(actual, expected, message)
  } else {
    t.true(Buffer.isBuffer(actual) && actual.equals(expected), message)
  }
}

function differs(t: ExecutionContext, actual: Output, expected: Output, message: string) {
  if (typeof expected === 'string') {
    t.not(actual, expected, message)
  } else {
    t.false(Buffer.isBuffer(actual) && actual.equals(expected), message)
  }
}

for (const op of OPS) {
  test(`canvas.width = 512 while ${op.name} is pending`, async (t) => {
    const { canvas } = redCanvas()
    const expected = op.sync(canvas)
    const occupiers = occupyThreadpool()
    const pending = op.start(canvas)
    canvas.width = 512
    t.is(canvas.width, 512)
    const [output] = await Promise.all([pending, ...occupiers])
    same(t, output, expected, 'the pending result is the 256x256 red bitmap of the call')
  })

  test(`canvas.height = 64 while ${op.name} is pending`, async (t) => {
    const { canvas } = redCanvas()
    const expected = op.sync(canvas)
    const occupiers = occupyThreadpool()
    const pending = op.start(canvas)
    canvas.height = 64
    t.is(canvas.height, 64)
    const [output] = await Promise.all([pending, ...occupiers])
    same(t, output, expected, 'the pending result is the 256x256 red bitmap of the call')
  })

  test(`width and height getters while ${op.name} is pending`, async (t) => {
    const { canvas } = redCanvas()
    const expected = op.sync(canvas)
    const occupiers = occupyThreadpool()
    const pending = op.start(canvas)
    t.is(canvas.width, 256)
    t.is(canvas.height, 256)
    const [output] = await Promise.all([pending, ...occupiers])
    same(t, output, expected, 'the pending result is the red bitmap of the call')
  })

  test(`canvas.data() while ${op.name} is pending`, async (t) => {
    const { canvas } = redCanvas()
    const expected = op.sync(canvas)
    const occupiers = occupyThreadpool()
    const pending = op.start(canvas)
    const data = canvas.data()
    t.is(data.length, 256 * 256 * 4)
    data.fill(0)
    const [output] = await Promise.all([pending, ...occupiers])
    same(t, output, expected, 'writes through canvas.data() do not reach the pending result')
  })

  test(`getContext('2d') and a draw while ${op.name} is pending`, async (t) => {
    const { canvas } = redCanvas()
    const expected = op.sync(canvas)
    const occupiers = occupyThreadpool()
    const pending = op.start(canvas)
    drawBlue(canvas.getContext('2d'))
    const [output] = await Promise.all([pending, ...occupiers])
    same(t, output, expected, 'the pending result is the red bitmap of the call')
    differs(t, op.sync(canvas), expected, 'the blue draw happened')
  })

  for (const second of OPS) {
    test(`${second.name} while ${op.name} is pending`, async (t) => {
      const { canvas, ctx } = redCanvas()
      const expected = op.sync(canvas)
      const occupiers = occupyThreadpool()
      const first = op.start(canvas)
      drawBlue(ctx)
      const next = second.start(canvas)
      const expected2 = second.sync(canvas)
      ctx.clearRect(0, 0, 256, 256)
      const [output, output2] = await Promise.all([first, next, ...occupiers])
      same(t, output, expected, 'the first result is the red bitmap')
      same(t, output2, expected2, 'the second result is the blue bitmap')
      differs(t, expected2, second.sync(redCanvas().canvas), 'the second snapshot is blue, not red')
    })
  }

  // Using the canvas as a source of another context borrows it as an
  // argument (&mut CanvasElement), not as the receiver. Before the fix,
  // drawCanvas and createPattern failed at that argument borrow; drawImage
  // failed earlier, at the source.width read in the index.js wrapper.
  const SOURCE_USES: [string, (target: SKRSContext2D, source: Canvas) => void][] = [
    ['drawImage', (target, source) => target.drawImage(source, 0, 0)],
    [
      'createPattern and a fill',
      (target, source) => {
        const pattern = target.createPattern(source, 'repeat')
        if (!pattern) throw new Error('createPattern returned null')
        target.fillStyle = pattern
        target.fillRect(0, 0, 256, 256)
      },
    ],
    ['drawCanvas', (target, source) => target.drawCanvas(source, 0, 0)],
  ]

  for (const [use, draw] of SOURCE_USES) {
    test(`another context's ${use} of the canvas while ${op.name} is pending`, async (t) => {
      const { canvas, ctx } = redCanvas()
      const expected = op.sync(canvas)
      const target = createCanvas(256, 256).getContext('2d')
      const occupiers = occupyThreadpool()
      const pending = op.start(canvas)
      drawBlue(ctx)
      draw(target, canvas)
      t.deepEqual(pixel(target), BLUE, `${use} draws the current blue pixels`)
      const [output] = await Promise.all([pending, ...occupiers])
      same(t, output, expected, 'the pending result is the red bitmap of the call')
    })
  }

  test(`encodeStream while ${op.name} is pending`, async (t) => {
    const { canvas, ctx } = redCanvas()
    const expected = op.sync(canvas)
    const twin = createCanvas(256, 256)
    drawBlue(twin.getContext('2d'))
    const occupiers = occupyThreadpool()
    const pending = op.start(canvas)
    drawBlue(ctx)
    const stream = canvas.encodeStream('png')
    ctx.clearRect(0, 0, 256, 256)
    const [output, streamed, twinStreamed] = await Promise.all([
      pending,
      streamBytes(stream),
      streamBytes(twin.encodeStream('png')),
      ...occupiers,
    ])
    t.true(streamed.length > 0 && streamed.equals(twinStreamed), 'the stream gives the blue pixels of its call')
    const redStreamed = await streamBytes(redCanvas().canvas.encodeStream('png'))
    t.false(streamed.equals(redStreamed), 'the stream bytes depend on the pixels')
    same(t, output, expected, 'the pending result is the red bitmap of the call')
  })

  test(`savePng while ${op.name} is pending`, async (t) => {
    const { canvas, ctx } = redCanvas()
    const expected = op.sync(canvas)
    const twin = createCanvas(256, 256)
    drawBlue(twin.getContext('2d'))
    const occupiers = occupyThreadpool()
    const pending = op.start(canvas)
    drawBlue(ctx)
    const saved = savedPng(canvas)
    t.true(saved.length > 0 && saved.equals(savedPng(twin)), 'savePng writes the current blue pixels')
    t.false(saved.equals(savedPng(redCanvas().canvas)), 'the saved bytes depend on the pixels')
    const [output] = await Promise.all([pending, ...occupiers])
    same(t, output, expected, 'the pending result is the red bitmap of the call')
  })

  test(`encodeSync, toBuffer and toDataURL while ${op.name} is pending`, async (t) => {
    const { canvas, ctx } = redCanvas()
    const expected = op.sync(canvas)
    const twin = createCanvas(256, 256)
    drawBlue(twin.getContext('2d'))
    const occupiers = occupyThreadpool()
    const pending = op.start(canvas)
    drawBlue(ctx)
    t.true(canvas.encodeSync('png').equals(twin.encodeSync('png')), 'encodeSync gives the current pixels')
    t.true(canvas.toBuffer('image/png').equals(twin.toBuffer('image/png')), 'toBuffer gives the current pixels')
    t.is(canvas.toDataURL('image/png'), twin.toDataURL('image/png'), 'toDataURL gives the current pixels')
    const [output] = await Promise.all([pending, ...occupiers])
    same(t, output, expected, 'the pending result is the red bitmap of the call')
  })
}

// Without pixels the async encoders settle as before, and the canvas stays
// usable after the call.
test('async encoders on a canvas without pixels', async (t) => {
  const encoded = createCanvas(0, 0)
  const encode = encoded.encode('png')
  encoded.width = 10
  await t.throwsAsync(encode, { name: 'IndexSizeError', message: 'The canvas has no pixels.' })

  const converted = createCanvas(0, 0)
  const convert = converted.convertToBlob()
  converted.width = 10
  await t.throwsAsync(convert, {
    name: 'IndexSizeError',
    message: "Failed to execute 'convertToBlob' on 'OffscreenCanvas': The size of the OffscreenCanvas is zero.",
  })

  const blobbed = createCanvas(0, 0)
  const blob = new Promise<Blob | null>((resolve) => blobbed.toBlob(resolve))
  blobbed.width = 10
  t.is(await blob, null)

  const dataUrl = createCanvas(0, 0)
  const url = dataUrl.toDataURLAsync('image/png')
  dataUrl.width = 10
  t.is(await url, 'data:,')
})
