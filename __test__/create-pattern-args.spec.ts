// createPattern(), imageSmoothingEnabled and CanvasPattern.setTransform()
// argument handling. Expected values and messages were measured in Chrome 155
// (--disable-gpu; pixel reads on a willReadFrequently canvas).
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, DOMMatrix, Image, ImageData } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const CREATE_PATTERN = "Failed to execute 'createPattern' on 'CanvasRenderingContext2D': "
const SET_TRANSFORM = "Failed to execute 'setTransform' on 'CanvasPattern': "

const syntaxError = (type: string) => ({
  instanceOf: DOMException,
  name: 'SyntaxError',
  code: 12,
  message: `${CREATE_PATTERN}The provided type ('${type}') is not one of 'repeat', 'no-repeat', 'repeat-x', or 'repeat-y'.`,
})

// Untyped access for arguments the typings reject on purpose.
const loose = <T>(value: T) => value as any

const source = () => {
  const canvas = createCanvas(2, 2)
  canvas.getContext('2d').fillRect(0, 0, 2, 2)
  return canvas
}

const loadInto = (image: Image, src: Buffer) =>
  new Promise<void>((resolve) => {
    image.onload = () => resolve()
    image.onerror = () => resolve()
    image.src = src
  })

test('an invalid repetition is a DOMException SyntaxError', (t) => {
  const ctx = createCanvas(4, 4).getContext('2d')
  const src = source()
  for (const repetition of ['bogus', 'REPEAT', 'repeat ']) {
    t.throws(() => ctx.createPattern(src, loose(repetition)), syntaxError(repetition))
  }
  // ToString: undefined is 'undefined' and 5 is '5'.
  t.throws(() => ctx.createPattern(src, undefined as any), syntaxError('undefined'))
  t.throws(() => ctx.createPattern(src, loose(5)), syntaxError('5'))
  // [LegacyNullToEmptyString]: null is '', which is 'repeat'.
  for (const repetition of [null, '', 'repeat', 'repeat-x', 'repeat-y', 'no-repeat', { toString: () => 'repeat-x' }]) {
    t.true(ctx.createPattern(src, loose(repetition)) !== null, String(repetition))
  }
  // Extra arguments are ignored.
  t.true(loose(ctx).createPattern(src, 'repeat', 'x') !== null)
})

test('createPattern needs 2 arguments', (t) => {
  const ctx = createCanvas(4, 4).getContext('2d')
  t.throws(() => loose(ctx).createPattern(source()), {
    instanceOf: TypeError,
    message: `${CREATE_PATTERN}2 arguments required, but only 1 present.`,
  })
  t.throws(() => loose(ctx).createPattern(), {
    instanceOf: TypeError,
    message: `${CREATE_PATTERN}2 arguments required, but only 0 present.`,
  })
})

test('an image argument of the wrong type is a TypeError', (t) => {
  const ctx = createCanvas(4, 4).getContext('2d')
  // The image is checked before the repetition.
  for (const [image, repetition] of [
    [null, 'repeat'],
    [undefined, 'repeat'],
    [{}, 'repeat'],
    [5, 'repeat'],
    [null, 'bogus'],
  ]) {
    const error = t.throws(() => ctx.createPattern(loose(image), loose(repetition)), { instanceOf: TypeError })
    t.true(error?.message.startsWith(`${CREATE_PATTERN}The provided value is not of type '(`), error?.message)
  }
  // ImageData is our own extension and stays accepted.
  t.true(ctx.createPattern(new ImageData(2, 2), 'repeat') !== null)
})

test('createPattern returns null for an image that is not ready and throws for a broken one', async (t) => {
  const ctx = createCanvas(4, 4).getContext('2d')
  // no src
  const empty = new Image()
  t.is(ctx.createPattern(empty, 'repeat'), null)
  // The repetition is checked before the image state.
  t.throws(() => ctx.createPattern(empty, loose('bogus')), syntaxError('bogus'))
  // still decoding
  const png = await source().encode('png')
  const decoding = new Image()
  const decoded = loadInto(decoding, png)
  t.is(ctx.createPattern(decoding, 'repeat'), null)
  await decoded
  t.true(ctx.createPattern(decoding, 'repeat') !== null)
  // still loading from a file
  const file = join(__dirname, 'javascript.png')
  const loading = new Image()
  const loaded = new Promise<void>((resolve) => {
    loading.onload = () => resolve()
    loading.onerror = () => resolve()
  })
  loading.src = file
  t.false(loading.complete)
  t.is(ctx.createPattern(loading, 'repeat'), null)
  await loaded
  t.true(ctx.createPattern(loading, 'repeat') !== null)
  // broken
  const broken = new Image()
  await loadInto(broken, await fs.readFile(join(__dirname, 'fixtures', 'broken.png')))
  t.true(broken.complete)
  t.throws(() => ctx.createPattern(broken, 'repeat'), {
    instanceOf: DOMException,
    name: 'InvalidStateError',
    code: 11,
    message: `${CREATE_PATTERN}Source image is in the 'broken' state.`,
  })
  t.throws(() => ctx.createPattern(broken, loose('bogus')), syntaxError('bogus'))
  // a new src clears the broken state
  await loadInto(broken, png)
  t.true(ctx.createPattern(broken, 'repeat') !== null)
})

test('without a global DOMException the error keeps its name and code', (t) => {
  const ctx = createCanvas(4, 4).getContext('2d')
  const src = source()
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'DOMException')!
  // Node < 17 has no global DOMException.
  delete (globalThis as any).DOMException
  let error: any
  try {
    ctx.createPattern(src, loose('bogus'))
  } catch (e) {
    error = e
  } finally {
    Object.defineProperty(globalThis, 'DOMException', saved)
  }
  t.true(error instanceof Error)
  t.is(error.name, 'SyntaxError')
  t.is(error.code, 12)
  t.is(error.message, syntaxError('bogus').message)
})

test('imageSmoothingEnabled converts its value with ToBoolean', (t) => {
  for (const value of [0, -0, '', null, undefined, NaN, 0n]) {
    const ctx = createCanvas(1, 1).getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingEnabled = loose(value)
    t.false(ctx.imageSmoothingEnabled, String(value))
  }
  for (const value of [1, 'x', {}, [], 'false']) {
    const ctx = createCanvas(1, 1).getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.imageSmoothingEnabled = loose(value)
    t.true(ctx.imageSmoothingEnabled, String(value))
  }
  // The converted value is the one drawing uses: 0 means nearest neighbor.
  const src = createCanvas(2, 1)
  const srcCtx = src.getContext('2d')
  srcCtx.fillStyle = '#f00'
  srcCtx.fillRect(0, 0, 1, 1)
  srcCtx.fillStyle = '#00f'
  srcCtx.fillRect(1, 0, 1, 1)
  const ctx = createCanvas(8, 1).getContext('2d')
  ctx.imageSmoothingEnabled = loose(0)
  ctx.drawImage(src, 0, 0, 8, 1)
  const red = [255, 0, 0, 255]
  const blue = [0, 0, 255, 255]
  t.deepEqual(
    [...ctx.getImageData(0, 0, 8, 1).data],
    [...red, ...red, ...red, ...red, ...blue, ...blue, ...blue, ...blue],
  )
})

test('CanvasPattern.setTransform takes a DOMMatrix2DInit', (t) => {
  const IDENTITY = [255, 0, 0, 255, 0, 0, 255, 255]
  const SHIFTED = [0, 0, 255, 255, 255, 0, 0, 255]
  // A 2x1 red|blue tile, shifted by 1 before each call; then the first two
  // pixels of a 4x1 fill.
  const paint = (apply: (pattern: { setTransform(transform?: unknown): void }) => void) => {
    const ctx = createCanvas(4, 1).getContext('2d')
    const tile = createCanvas(2, 1)
    const tileCtx = tile.getContext('2d')
    tileCtx.fillStyle = '#f00'
    tileCtx.fillRect(0, 0, 1, 1)
    tileCtx.fillStyle = '#00f'
    tileCtx.fillRect(1, 0, 1, 1)
    const pattern = ctx.createPattern(tile, 'repeat')!
    pattern.setTransform(new DOMMatrix([1, 0, 0, 1, 1, 0]))
    ctx.imageSmoothingEnabled = false
    let error: unknown
    try {
      apply(pattern)
    } catch (e) {
      error = e
    }
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, 4, 1)
    return { error, pixels: [...ctx.getImageData(0, 0, 2, 1).data] }
  }
  // undefined, null and any object without members are the identity
  for (const init of [undefined, null, {}, [1, 0, 0, 1, 0, 0], () => {}, { is2D: false }, { a: 1, m11: 1 }]) {
    t.deepEqual(
      paint((p) => p.setTransform(init)),
      { error: undefined, pixels: IDENTITY },
      String(init),
    )
  }
  t.deepEqual(
    paint((p) => p.setTransform()),
    { error: undefined, pixels: IDENTITY },
  )
  t.deepEqual(
    paint((p) => p.setTransform(new DOMMatrix([1, 0, 0, 1, 0, 0]))),
    { error: undefined, pixels: IDENTITY },
  )
  t.deepEqual(
    paint((p) => p.setTransform({ m11: 1, m12: 0, m21: 0, m22: 1, m41: 0, m42: 0 })),
    {
      error: undefined,
      pixels: IDENTITY,
    },
  )
  // e, m41 and a numeric string all translate
  for (const init of [{ e: 1 }, { m41: 1 }, { e: '1' }]) {
    t.deepEqual(
      paint((p) => p.setTransform(init)),
      { error: undefined, pixels: SHIFTED },
      JSON.stringify(init),
    )
  }
  // a NaN matrix paints nothing
  t.deepEqual(paint((p) => p.setTransform({ a: NaN })).pixels, [0, 0, 0, 0, 0, 0, 0, 0])
  t.deepEqual(paint((p) => p.setTransform({ a: NaN, m11: NaN })).pixels, [0, 0, 0, 0, 0, 0, 0, 0])
  // errors keep the previous transform
  for (const init of [
    { a: 1, m11: 2 },
    { f: 1, m42: 2 },
  ]) {
    const { error, pixels } = paint((p) => p.setTransform(init))
    t.true(error instanceof TypeError)
    t.is((error as Error).message, `${SET_TRANSFORM}Property mismatch on matrix initialization.`)
    t.deepEqual(pixels, SHIFTED)
  }
  for (const init of [5, 'x', true]) {
    const { error, pixels } = paint((p) => p.setTransform(init))
    t.true(error instanceof TypeError, String(init))
    t.is((error as Error).message, `${SET_TRANSFORM}The provided value is not of type 'DOMMatrix2DInit'.`)
    t.deepEqual(pixels, SHIFTED)
  }
  // members are read in lexicographic order
  const seen: string[] = []
  paint((p) => p.setTransform(new Proxy({}, { get: (_, key) => (seen.push(String(key)), undefined) })))
  t.deepEqual(seen, ['a', 'b', 'c', 'd', 'e', 'f', 'm11', 'm12', 'm21', 'm22', 'm41', 'm42'])
})
