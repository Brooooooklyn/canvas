// DOM and binding exceptions: drawImage (argument count, overload, image
// type, number conversion, broken image), negative radii, Image decode() and
// onerror. Expected values and messages were measured in Chrome 155 on arm64
// macOS (--disable-gpu; pixel reads on a willReadFrequently canvas). Chrome
// lists its own image types in the drawImage type error; ours lists our
// classes.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, Image, ImageData, loadImage, Path2D } from '../index'

// Untyped access for arguments the typings reject on purpose.
const loose = <T>(value: T) => value as any

const DRAW_IMAGE = "Failed to execute 'drawImage' on 'CanvasRenderingContext2D': "
const NOT_AN_IMAGE = "The provided value is not of type '(CanvasElement or Image or SVGCanvas)'."
const OVERLOAD = 'Overload resolution failed.'
const BROKEN = "The HTMLImageElement provided is in the 'broken' state."
// A 2x2 PNG.
const RED_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwnwEJMGBwAKUwA/0ghlmZAAAAAElFTkSuQmCC'

const context = () => createCanvas(10, 10).getContext('2d')
const pixel = (ctx: ReturnType<typeof context>, x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data)

// A 2x2 opaque blue canvas.
const blueSource = () => {
  const canvas = createCanvas(2, 2)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#00f'
  ctx.fillRect(0, 0, 2, 2)
  return canvas
}

// Chrome's binding errors: the stack keeps the bare message, and `message`
// gets the prefix, as an enumerable own property.
const assertBindingError = (t: any, fn: () => unknown, message: string) => {
  const error = t.throws(fn, { instanceOf: TypeError, message: `${DRAW_IMAGE}${message}` })
  t.is(String(error.stack).split('\n')[0], `TypeError: ${message}`)
  t.deepEqual(Object.keys(error), ['message'])
}

const recorder = () => {
  const log: number[] = []
  const value = (n: number) => ({
    valueOf() {
      log.push(n)
      return n
    },
  })
  return { log, value }
}

const brokenImage = async () => {
  const image = new Image()
  await new Promise<void>((resolve) => {
    image.onload = () => resolve()
    image.onerror = () => resolve()
    image.src = 'data:image/png;base64,AAAAAAAAAAAA'
  })
  return image
}

test('drawImage needs 3 arguments', (t) => {
  const ctx = loose(context())
  const source = blueSource()
  t.is(ctx.drawImage.length, 3)
  assertBindingError(t, () => ctx.drawImage(), '3 arguments required, but only 0 present.')
  assertBindingError(t, () => ctx.drawImage(source), '3 arguments required, but only 1 present.')
  assertBindingError(t, () => ctx.drawImage(source, 0), '3 arguments required, but only 2 present.')
  assertBindingError(t, () => ctx.drawImage(undefined, undefined), '3 arguments required, but only 2 present.')
  assertBindingError(t, () => ctx.drawImage({}, 0), '3 arguments required, but only 2 present.')
})

test('drawImage needs 3, 5 or 9 arguments', (t) => {
  const ctx = loose(context())
  const source = blueSource()
  for (const count of [4, 6, 7, 8]) {
    const args = Array.from({ length: count - 1 }, () => 1)
    assertBindingError(t, () => ctx.drawImage(source, ...args), OVERLOAD)
    assertBindingError(t, () => ctx.drawImage({}, ...args), OVERLOAD)
  }
  // Nothing is converted before the overload fails.
  const { log, value } = recorder()
  assertBindingError(t, () => ctx.drawImage({}, value(1), value(2), value(3), value(4), value(5)), OVERLOAD)
  t.deepEqual(log, [])
  // A 10th argument is ignored, not converted.
  t.notThrows(() => ctx.drawImage(source, 0, 0, 2, 2, 4, 4, 2, 2, Symbol()))
  t.deepEqual(pixel(ctx, 5, 5), [0, 0, 255, 255])
  // An explicit undefined counts: 4 arguments, and a NaN height in 5.
  assertBindingError(t, () => ctx.drawImage(source, 0, 0, undefined), OVERLOAD)
  const nan = context()
  t.notThrows(() => nan.drawImage(source, 0, 0, 4, undefined))
  t.deepEqual(pixel(nan, 1, 1), [0, 0, 0, 0])
})

// Runs `call` with index getters on Object.prototype, which log each read;
// they are removed before it returns. Past arguments.length, arguments[i]
// reads Object.prototype[i]: Chrome 155 reads none of them. `result` is what
// `call` returns, or the error it throws as a string.
const withIndexGetters = (values: Record<number, unknown>, call: () => unknown) => {
  let reads = ''
  const keys = Object.keys(values)
  for (const key of keys) {
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      get() {
        reads += `${key} `
        return values[Number(key)]
      },
      set(value) {
        Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true })
      },
    })
  }
  let result: unknown
  try {
    result = call()
  } catch (error) {
    result = String(error)
  } finally {
    for (const key of keys) delete loose(Object.prototype)[key]
  }
  return { result, reads: reads.trim() }
}

test.serial('drawImage reads only the arguments it was given', (t) => {
  const source = blueSource()
  const blue = [0, 0, 255, 255]
  const none = [0, 0, 0, 0]
  // Getters that would make each call the 9-argument form.
  const nine = { 3: 1, 4: 1, 5: 0, 6: 0, 7: 8, 8: 8 }
  // [the arguments after the image, the getters, what drawImage gives, the
  // pixels at (1, 1) and (5, 5)] (Chrome 155)
  for (const [args, values, result, pixels] of [
    [[0, 0], nine, undefined, [blue, none]],
    [[0, 0, 8, 8], { 5: 0, 6: 0, 7: 1, 8: 1 }, undefined, [blue, blue]],
    [[0, undefined], nine, undefined, [none, none]],
    // 4 arguments: no overload.
    [[0, 0, 1], { 4: 1, 5: 0, 6: 0, 7: 8, 8: 8 }, `TypeError: ${DRAW_IMAGE}${OVERLOAD}`, [none, none]],
  ] as const) {
    const ctx = context()
    t.deepEqual(
      withIndexGetters(values, () => loose(ctx).drawImage(source, ...args)),
      { result, reads: '' },
      String(args),
    )
    t.deepEqual([pixel(ctx, 1, 1), pixel(ctx, 5, 5)], pixels, String(args))
  }
})

test('drawImage rejects a value that is not an image', (t) => {
  const ctx = loose(context())
  for (const value of [
    null,
    undefined,
    {},
    5,
    'x',
    new ImageData(1, 1),
    new Path2D(),
    Object.create(Image.prototype),
  ]) {
    assertBindingError(t, () => ctx.drawImage(value, 0, 0), NOT_AN_IMAGE)
  }
  // The image is checked before the numbers are converted.
  const { log, value } = recorder()
  assertBindingError(t, () => ctx.drawImage({}, value(1), value(2)), NOT_AN_IMAGE)
  t.deepEqual(log, [])
})

test('drawImage converts numbers with ToNumber, in order', (t) => {
  const ctx = loose(context())
  const source = blueSource()
  const { log, value } = recorder()
  ctx.drawImage(source, value(1), value(2), value(3), value(4), value(5), value(6), value(7), value(8))
  t.deepEqual(log.splice(0), [1, 2, 3, 4, 5, 6, 7, 8])

  // A Symbol stops the conversion: the error has the prefix, the stack not.
  const symbol = 'Cannot convert a Symbol value to a number'
  assertBindingError(t, () => ctx.drawImage(source, value(1), Symbol()), symbol)
  t.deepEqual(log.splice(0), [1])
  assertBindingError(t, () => ctx.drawImage(source, value(1), value(2), Symbol(), value(4)), symbol)
  t.deepEqual(log.splice(0), [1, 2])
  assertBindingError(
    t,
    () => ctx.drawImage(source, value(1), value(2), value(3), value(4), value(5), Symbol(), value(7), value(8)),
    symbol,
  )
  t.deepEqual(log.splice(0), [1, 2, 3, 4, 5])
  t.throws(() => ctx.drawImage(source, 1n, 0), {
    instanceOf: TypeError,
    message: `${DRAW_IMAGE}Cannot convert a BigInt value to a number`,
  })
  // An exception from user code passes through as it is.
  const error = t.throws(
    () =>
      ctx.drawImage(
        source,
        value(1),
        {
          valueOf() {
            throw new RangeError('boom')
          },
        },
        value(3),
        value(4),
      ),
    { instanceOf: RangeError, message: 'boom' },
  )
  t.deepEqual(Object.keys(error), [])
  t.deepEqual(log.splice(0), [1])

  // [arguments after the image, pixels at (0, 0), (3, 3), (5, 5), (9, 9)]
  const blue = [0, 0, 255, 255]
  const none = [0, 0, 0, 0]
  for (const [args, expected] of [
    [
      ['3', '3'],
      [none, blue, none, none],
    ],
    [
      [[3], '3', '4', '4'],
      [none, blue, blue, none],
    ],
    [
      [0, 0, 2, 2, '4', '4', 2, 2],
      [none, none, blue, none],
    ],
    [
      [0, 0, 2, 2, 4, 4, 2, 2, 99],
      [none, none, blue, none],
    ],
    [
      [NaN, 0],
      [none, none, none, none],
    ],
    [
      [0, 0, Infinity, 4],
      [none, none, none, none],
    ],
    [
      [1, 1, undefined, undefined],
      [none, none, none, none],
    ],
  ] as const) {
    const target = loose(context())
    target.drawImage(source, ...args)
    t.deepEqual(
      [pixel(target, 0, 0), pixel(target, 3, 3), pixel(target, 5, 5), pixel(target, 9, 9)],
      expected,
      String(args),
    )
  }
})

test('drawImage runs valueOf before it borrows the context', (t) => {
  const ctx = context()
  const source = createCanvas(2, 2)
  source.getContext('2d').fillRect(0, 0, 2, 2)
  ctx.drawImage(
    source,
    loose({
      valueOf() {
        ctx.fillStyle = '#0f0'
        ctx.fillRect(0, 0, 10, 10)
        return 3
      },
    }),
    3,
  )
  t.deepEqual(pixel(ctx, 0, 0), [0, 255, 0, 255])
  t.deepEqual(pixel(ctx, 3, 3), [0, 0, 0, 255])
})

test('drawImage of a broken image throws InvalidStateError', async (t) => {
  const image = await brokenImage()
  t.true(image.complete)
  const error = t.throws(() => context().drawImage(image, 0, 0), { instanceOf: DOMException })
  t.is(error.name, 'InvalidStateError')
  t.is(error.code, 11)
  t.is(error.message, `${DRAW_IMAGE}${BROKEN}`)
  t.is(String(error.stack).split('\n')[0], `InvalidStateError: ${DRAW_IMAGE}${BROKEN}`)
  t.deepEqual(Object.keys(error), [])
  // Chrome returns on a non-finite number first, then checks the image.
  for (const [args, throws] of [
    [[NaN, 0], false],
    [[Infinity, 0], false],
    [[0, 0, 0, 0], true],
    [[0, 0, NaN, 1], false],
    [[0, 0, 0, 0, 0, 0, 0, 0], true],
    [[0, 0, 1, 1, 0, 0, 1, 1], true],
    [[0, 0, 1, 1, 0, NaN, 1, 1], false],
    [[-1e300, 1e300], true],
  ] as const) {
    const draw = () => loose(context()).drawImage(image, ...args)
    if (throws) {
      t.throws(draw, { instanceOf: DOMException, message: `${DRAW_IMAGE}${BROKEN}` }, String(args))
    } else {
      t.notThrows(draw, String(args))
    }
  }
  // The numbers are converted before the image state is checked.
  t.throws(() => loose(context()).drawImage(image, Symbol(), 0), { instanceOf: TypeError })
})

test('drawImage of an image without src or still loading does nothing', async (t) => {
  const ctx = context()
  t.notThrows(() => ctx.drawImage(new Image(), 0, 0))
  const loading = new Image()
  loading.src = RED_PNG
  t.notThrows(() => ctx.drawImage(loading, 0, 0))
  const cleared = await brokenImage()
  cleared.src = ''
  t.true(cleared.complete)
  t.notThrows(() => ctx.drawImage(cleared, 0, 0))
  t.deepEqual(pixel(ctx, 0, 0), [0, 0, 0, 0])
})

const radiusMessage = (method: string, iface: string, name: string, value: string) =>
  `Failed to execute '${method}' on '${iface}': The ${name} provided (${value}) is negative.`

test('arc, arcTo and ellipse throw IndexSizeError for a negative radius', (t) => {
  const ctx = context()
  const error = t.throws(() => ctx.arc(1, 1, -1, 0, 1), { instanceOf: DOMException })
  const message = radiusMessage('arc', 'CanvasRenderingContext2D', 'radius', '-1')
  t.is(error.name, 'IndexSizeError')
  t.is(error.code, 1)
  t.is(error.message, message)
  t.is(String(error.stack).split('\n')[0], `IndexSizeError: ${message}`)
  t.deepEqual(Object.keys(error), [])

  const CTX = 'CanvasRenderingContext2D'
  for (const [call, method, iface, name, value] of [
    [() => ctx.arcTo(0, 0, 1, 1, -1), 'arcTo', CTX, 'radius', '-1'],
    [() => loose(ctx).arcTo(0, 0, 1, 1, '-3'), 'arcTo', CTX, 'radius', '-3'],
    [() => ctx.ellipse(1, 1, -1, 1, 0, 0, 1), 'ellipse', CTX, 'major-axis radius', '-1'],
    [() => ctx.ellipse(1, 1, 1, -2, 0, 0, 1), 'ellipse', CTX, 'minor-axis radius', '-2'],
    [() => ctx.ellipse(1, 1, -1, -2, 0, 0, 1), 'ellipse', CTX, 'major-axis radius', '-1'],
    [() => new Path2D().arc(1, 1, -1, 0, 1), 'arc', 'Path2D', 'radius', '-1'],
    [() => new Path2D().arcTo(0, 0, 1, 1, -1), 'arcTo', 'Path2D', 'radius', '-1'],
    [() => new Path2D().ellipse(1, 1, -1, 1, 0, 0, 1), 'ellipse', 'Path2D', 'major-axis radius', '-1'],
    [() => new Path2D().ellipse(1, 1, 1, -2, 0, 0, 1), 'ellipse', 'Path2D', 'minor-axis radius', '-2'],
  ] as const) {
    t.throws(call, {
      instanceOf: DOMException,
      name: 'IndexSizeError',
      message: radiusMessage(method, iface, name, value),
    })
  }

  // Also under a singular transform.
  const singular = context()
  singular.setTransform(0, 0, 0, 0, 0, 0)
  t.throws(() => singular.arc(1, 1, -1, 0, 1), { instanceOf: DOMException, message })

  // The failed call adds nothing to the path.
  const filled = context()
  filled.beginPath()
  filled.rect(0, 0, 10, 10)
  t.throws(() => filled.arc(5, 5, -1, 0, 7))
  t.throws(() => filled.ellipse(5, 5, 1, -1, 0, 0, 7))
  t.throws(() => filled.arcTo(0, 0, 1, 1, -1))
  filled.fill()
  const path = new Path2D()
  path.rect(0, 0, 10, 10)
  t.throws(() => path.arc(5, 5, -1, 0, 7))
  const pathTarget = context()
  pathTarget.fill(path)
  t.deepEqual([pixel(filled, 5, 5)[3], pixel(pathTarget, 5, 5)[3]], [255, 255])
})

test('the radius is checked after the finite check', (t) => {
  const ctx = context()
  // -1e-300 is -0 as a float; a value beyond the float range is an infinity.
  for (const radius of [-0, -1e-300, -Infinity, -3.4028235e38, -1e39]) {
    t.notThrows(() => ctx.arc(1, 1, radius, 0, 1), String(radius))
    t.notThrows(() => ctx.arcTo(0, 0, 1, 1, radius), String(radius))
    t.notThrows(() => ctx.ellipse(1, 1, radius, 1, 0, 0, 1), String(radius))
    t.notThrows(() => new Path2D().arc(1, 1, radius, 0, 1), String(radius))
  }
  t.notThrows(() => ctx.arc(NaN, 1, -1, 0, 1))
  t.notThrows(() => ctx.arcTo(NaN, 0, 1, 1, -1))
  t.notThrows(() => ctx.ellipse(1, 1, -1, 1, NaN, 0, 1))
  t.notThrows(() => ctx.ellipse(1, 1, 1, -1, 0, Infinity, 1))
  t.notThrows(() => new Path2D().arcTo(0, 0, 1, Infinity, -1))
})

test('the radius text has six significant digits', (t) => {
  const ctx = context()
  for (const [radius, text] of [
    [-1, '-1'],
    [-2.5, '-2.5'],
    [-0.1, '-0.1'],
    [-1.1, '-1.1'],
    [-0.30000001, '-0.3'],
    [-0.5, '-0.5'],
    [-1e10, '-1.00000e+10'],
    [-123456789, '-1.23457e+8'],
    [-1e-7, '-1.00000e-7'],
    [-0.000123456789, '-0.000123457'],
    [-3.4e38, '-3.40000e+38'],
    [-1234567, '-1.23457e+6'],
    [-1234565, '-1.23457e+6'],
    [-100000, '-100000'],
    [-1000000, '-1.00000e+6'],
    [-999999.5, '-1.00000e+6'],
    [-1.5e-5, '-0.000015'],
    [-16777217, '-1.67772e+7'],
    [-1e-40, '-9.99995e-41'],
    [-3.4028234663852886e38, '-3.40282e+38'],
  ] as const) {
    t.throws(() => ctx.arc(1, 1, radius, 0, 1), {
      instanceOf: DOMException,
      message: radiusMessage('arc', 'CanvasRenderingContext2D', 'radius', text),
    })
  }
})

const ENCODING_ERROR = {
  instanceOf: DOMException,
  name: 'EncodingError',
  message: 'The source image cannot be decoded.',
}
const BROKEN_URL = 'data:image/png;base64,AAAAAAAAAAAA'
const SIMPLE_PNG = `data:image/png;base64,${readFileSync(
  join(fileURLToPath(new URL('.', import.meta.url)), '..', 'example', 'simple.png'),
).toString('base64')}`

const settle = (image: Image) =>
  new Promise<string>((resolve) => {
    image.onload = () => resolve('load')
    image.onerror = () => resolve('error')
  })

test('decode() rejects with EncodingError', async (t) => {
  // No src.
  const error = await t.throwsAsync(new Image().decode(), ENCODING_ERROR)
  t.is(error.code, 0)

  // A broken image: before and after the load ends.
  const broken = new Image()
  const brokenEvent = settle(broken)
  broken.src = BROKEN_URL
  await t.throwsAsync(broken.decode(), ENCODING_ERROR)
  t.is(await brokenEvent, 'error')
  await t.throwsAsync(broken.decode(), ENCODING_ERROR)

  // Pending, then src changes to a broken image or to another valid one:
  // the first decode() rejects; the second follows the new src.
  const second = createCanvas(3, 2)
  second.getContext('2d').fillRect(0, 0, 3, 2)
  const secondPng = second.toDataURL('image/png')
  const toBroken = new Image()
  toBroken.src = SIMPLE_PNG
  const pendingBroken = t.throwsAsync(toBroken.decode(), ENCODING_ERROR)
  toBroken.src = BROKEN_URL
  await t.throwsAsync(toBroken.decode(), ENCODING_ERROR)
  await pendingBroken
  const toValid = new Image()
  toValid.src = SIMPLE_PNG
  const pendingValid = t.throwsAsync(toValid.decode(), ENCODING_ERROR)
  toValid.src = secondPng
  await t.notThrowsAsync(toValid.decode())
  await pendingValid
  t.is(toValid.naturalWidth, 3)

  // Loaded, then src changes or is cleared before the decode() settles.
  for (const next of [secondPng, '']) {
    const loaded = new Image()
    loaded.src = SIMPLE_PNG
    await loaded.decode()
    const pending = t.throwsAsync(loaded.decode(), ENCODING_ERROR)
    loaded.src = next
    await pending
  }

  // Cleared.
  const cleared = new Image()
  cleared.src = SIMPLE_PNG
  await cleared.decode()
  cleared.src = ''
  t.true(cleared.complete)
  await t.throwsAsync(cleared.decode(), ENCODING_ERROR)
})

test('decode() resolves for a loaded image and for the same src set again', async (t) => {
  const image = new Image()
  const event = settle(image)
  image.src = SIMPLE_PNG
  t.is(await event, 'load')
  await t.notThrowsAsync(image.decode())

  const again = new Image()
  again.src = SIMPLE_PNG
  const first = again.decode()
  again.src = SIMPLE_PNG
  const second = again.decode()
  await t.notThrowsAsync(first)
  await t.notThrowsAsync(second)
})

test('decode() returns a new promise on each call', async (t) => {
  const image = new Image()
  image.src = SIMPLE_PNG
  const first = image.decode()
  const second = image.decode()
  t.not(first, second)
  await Promise.allSettled([first, second])
})

test('onerror gets an Event of type error', async (t) => {
  const image = new Image()
  const event = await new Promise<Event>((resolve) => {
    image.onerror = (event) => resolve(event)
    image.src = BROKEN_URL
  })
  t.true(event instanceof Event)
  t.false(event instanceof Error)
  t.is(event.type, 'error')
  t.is(Object.prototype.toString.call(event), '[object Event]')
  t.false(event.bubbles)
  t.false(event.cancelable)
  t.true(image.complete)
  // loadImage() still rejects with an Error that has a message.
  await t.throwsAsync(() => loadImage(Buffer.from(BROKEN_URL.split(',')[1], 'base64')), {
    instanceOf: Error,
    message: 'Unsupported image type',
  })
})

test('a failed HTTP load fires onerror and decode() rejects', async (t) => {
  const server = createServer((request, response) => {
    if (request.url === '/garbage.png') {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end('not a png')
    } else {
      response.writeHead(404)
      response.end('missing')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    const { port } = server.address() as { port: number }
    for (const name of ['missing', 'garbage']) {
      const image = new Image()
      const event = new Promise<Event>((resolve, reject) => {
        image.onload = () => reject(new Error('onload'))
        image.onerror = (event) => resolve(event)
      })
      image.src = `http://127.0.0.1:${port}/${name}.png`
      const decoded = t.throwsAsync(image.decode(), ENCODING_ERROR)
      t.is((await event).type, 'error', name)
      await decoded
      t.true(image.complete, name)
    }
  } finally {
    server.close()
  }
})
