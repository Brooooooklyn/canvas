// The exceptions of drawImage: argument count, overload, image type, number
// conversion and the broken image state.
// Expected values and messages were measured in Chrome 155 (--disable-gpu;
// pixel reads on a willReadFrequently canvas). Chrome lists its own image
// types in the type error; ours lists our classes.
import test from 'ava'

import { createCanvas, Image, ImageData, Path2D } from '../index'

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
