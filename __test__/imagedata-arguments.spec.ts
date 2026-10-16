// putImageData(imagedata, dx, dy) or (imagedata, dx, dy, dirtyX, dirtyY,
// dirtyWidth, dirtyHeight) with [EnforceRange] long numbers, the argument
// counts of getImageData and putImageData, and the lengths of the ImageData
// methods (base_rendering_context_2d.idl). Expected values were measured in
// Chrome 155 (--disable-gpu, willReadFrequently, arm64 = x64).
import test from 'ava'

import { createCanvas, ImageData } from '../index'

const PUT = "Failed to execute 'putImageData' on 'CanvasRenderingContext2D': "
const GET = "Failed to execute 'getImageData' on 'CanvasRenderingContext2D': "
const NOT_IMAGE_DATA = "parameter 1 is not of type 'ImageData'."
const OVERLOAD = 'Overload resolution failed.'

const ctx2d = (w = 2, h = 2): any => createCanvas(w, h).getContext('2d')
const result = (fn: () => unknown) => {
  try {
    const value = fn()
    return { ok: value === undefined ? 'undefined' : value }
  } catch (e: any) {
    return { ctor: e?.constructor?.name, msg: String(e?.message), stack0: String(e?.stack).split('\n')[0] }
  }
}
const typeError = (prefix: string, msg: string) => ({
  ctor: 'TypeError',
  msg: prefix + msg,
  stack0: `TypeError: ${msg}`,
})
// 2x2: (0,0) red, (1,0) green, (0,1) blue, (1,1) white.
const quad = () =>
  new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]), 2, 2)
const read = (ctx: any, w: number, h: number) => Array.from(ctx.getImageData(0, 0, w, h).data)

test('the ImageData methods have Chrome lengths', (t) => {
  const proto = Object.getPrototypeOf(ctx2d())
  t.deepEqual(
    ['createImageData', 'getImageData', 'putImageData'].map((name) => proto[name].length),
    [1, 4, 3],
  )
})

test('putImageData takes 3 or 7 arguments', (t) => {
  const c = ctx2d()
  const id = new ImageData(1, 1)
  const required = (present: number) => typeError(PUT, `3 arguments required, but only ${present} present.`)
  const cases: [string, () => unknown, object][] = [
    ['()', () => c.putImageData(), required(0)],
    ['(id)', () => c.putImageData(id), required(1)],
    ['(id, 0)', () => c.putImageData(id, 0), required(2)],
    ['(id, 0, 0, 0)', () => c.putImageData(id, 0, 0, 0), typeError(PUT, OVERLOAD)],
    ['(id, 0, 0, 0, 0)', () => c.putImageData(id, 0, 0, 0, 0), typeError(PUT, OVERLOAD)],
    ['(id, 0, 0, 0, 0, 1)', () => c.putImageData(id, 0, 0, 0, 0, 1), typeError(PUT, OVERLOAD)],
    ['(id, 0, 0, undefined)', () => c.putImageData(id, 0, 0, undefined), typeError(PUT, OVERLOAD)],
    ["(id, 0, 0, 0, 0, 1, 1, 'x')", () => c.putImageData(id, 0, 0, 0, 0, 1, 1, 'x'), { ok: 'undefined' }],
    ['(id, 0, 0, 0, 0, 1, 1, Symbol())', () => c.putImageData(id, 0, 0, 0, 0, 1, 1, Symbol('s')), { ok: 'undefined' }],
    // The image data is checked first.
    [
      '(undefined, undefined, undefined)',
      () => c.putImageData(undefined, undefined, undefined),
      typeError(PUT, NOT_IMAGE_DATA),
    ],
    ['(null, 0, 0)', () => c.putImageData(null, 0, 0), typeError(PUT, NOT_IMAGE_DATA)],
    [
      '({width, height, data}, 0, 0)',
      () => c.putImageData({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, 0, 0),
      typeError(PUT, NOT_IMAGE_DATA),
    ],
    ['(canvas, 0, 0)', () => c.putImageData(c.canvas, 0, 0), typeError(PUT, NOT_IMAGE_DATA)],
    [
      '(u8c(4), 0, 0, 0, 0, 1, 1)',
      () => c.putImageData(new Uint8ClampedArray(4), 0, 0, 0, 0, 1, 1),
      typeError(PUT, NOT_IMAGE_DATA),
    ],
    ['(id, undefined, 0)', () => c.putImageData(id, undefined, 0), typeError(PUT, "Value is not of type 'long'.")],
  ]
  for (const [label, fn, expected] of cases) {
    t.deepEqual(result(fn), expected, `putImageData${label}`)
  }
})

test('putImageData checks the overload and the image data before it converts', (t) => {
  const log: string[] = []
  const v = (tag: string, value: number) => ({
    valueOf() {
      log.push(tag)
      return value
    },
  })
  const c = ctx2d()
  const id = new ImageData(1, 1)
  log.push(result(() => c.putImageData({}, v('dx', 0), v('dy', 0))).msg as string)
  log.push(result(() => c.putImageData(id, v('dx', 0), v('dy', NaN), v('x', 0))).msg as string)
  const r = result(() => c.putImageData(id, v('dx', 0), v('dy', 0), v('x', 0), v('y', 0), v('w', 1), v('h', 1)))
  log.push(r.ok ? 'ok' : (r.msg as string))
  t.deepEqual(log, [PUT + NOT_IMAGE_DATA, PUT + OVERLOAD, 'dx', 'dy', 'x', 'y', 'w', 'h', 'ok'])
})

test('putImageData converts its numbers as [EnforceRange] long', (t) => {
  const c = ctx2d()
  const id = new ImageData(1, 1)
  const cases: [string, () => unknown, object][] = [
    ['(id, NaN, 0)', () => c.putImageData(id, NaN, 0), typeError(PUT, "Value is not of type 'long'.")],
    [
      '(id, Infinity, 0)',
      () => c.putImageData(id, Infinity, 0),
      typeError(PUT, "Value is infinite and not of type 'long'."),
    ],
    [
      '(id, 0, -Infinity)',
      () => c.putImageData(id, 0, -Infinity),
      typeError(PUT, "Value is infinite and not of type 'long'."),
    ],
    [
      '(id, 2 ** 31, 0)',
      () => c.putImageData(id, 2 ** 31, 0),
      typeError(PUT, "Value is outside the 'long' value range."),
    ],
    [
      '(id, 0, -(2 ** 31) - 1)',
      () => c.putImageData(id, 0, -(2 ** 31) - 1),
      typeError(PUT, "Value is outside the 'long' value range."),
    ],
    [
      '(id, 0, 0, 0, 0, 1e300, 1)',
      () => c.putImageData(id, 0, 0, 0, 0, 1e300, 1),
      typeError(PUT, "Value is outside the 'long' value range."),
    ],
    [
      '(id, 0, 0, NaN, 0, 1, 1)',
      () => c.putImageData(id, 0, 0, NaN, 0, 1, 1),
      typeError(PUT, "Value is not of type 'long'."),
    ],
    [
      '(id, Symbol(), 0)',
      () => c.putImageData(id, Symbol('s'), 0),
      typeError(PUT, 'Cannot convert a Symbol value to a number'),
    ],
    [
      '(id, 1n, 0)',
      () => c.putImageData(id, BigInt(1), 0),
      typeError(PUT, 'Cannot convert a BigInt value to a number'),
    ],
    ["(id, '1', 0)", () => c.putImageData(id, '1', 0), { ok: 'undefined' }],
    [
      '(id, {valueOf: {}, toString: {}}, 0)',
      () => c.putImageData(id, { valueOf: () => ({}), toString: () => ({}) }, 0),
      typeError(PUT, 'Cannot convert object to primitive value'),
    ],
    [
      '(id, 0, 0, 0, 0, 0, Symbol())',
      () => c.putImageData(id, 0, 0, 0, 0, 0, Symbol('s')),
      typeError(PUT, 'Cannot convert a Symbol value to a number'),
    ],
  ]
  for (const [label, fn, expected] of cases) {
    t.deepEqual(result(fn), expected, `putImageData${label}`)
  }
  // Conversion comes before the detach check.
  const ab = new ArrayBuffer(4)
  const detached = new ImageData(new Uint8ClampedArray(ab), 1, 1)
  ab.transfer()
  t.deepEqual(
    result(() => c.putImageData(detached, NaN, 0)),
    typeError(PUT, "Value is not of type 'long'."),
  )
})

test('putImageData truncates every number', (t) => {
  const cases: [string, number, number, unknown[], number[]][] = [
    [
      '0.9, 0.9',
      3,
      3,
      [0.9, 0.9],
      [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, ...Array(16).fill(0)],
    ],
    [
      '-0.9, 1.5',
      3,
      3,
      [-0.9, 1.5],
      [
        ...Array(12).fill(0),
        255,
        0,
        0,
        255,
        0,
        255,
        0,
        255,
        0,
        0,
        0,
        0,
        0,
        0,
        255,
        255,
        255,
        255,
        255,
        255,
        0,
        0,
        0,
        0,
      ],
    ],
    ['0, 0, 0.5, 0.5, 1.5, 1.5', 2, 2, [0, 0, 0.5, 0.5, 1.5, 1.5], [255, 0, 0, 255, ...Array(12).fill(0)]],
    ['0, 0, 1.9, 0, 0.9, 2', 2, 2, [0, 0, 1.9, 0, 0.9, 2], Array(16).fill(0)],
    ['0, 0, 1, 1.7, -0.5, -1.2', 2, 2, [0, 0, 1, 1.7, -0.5, -1.2], Array(16).fill(0)],
    ['0, 0, 2, 0, -1.5, 1.9', 2, 2, [0, 0, 2, 0, -1.5, 1.9], [0, 0, 0, 0, 0, 255, 0, 255, ...Array(8).fill(0)]],
    ['0, 0, -1, 0, -2, 2', 2, 2, [0, 0, -1, 0, -2, 2], Array(16).fill(0)],
    ['0, 0, 2, 2, -1, -1', 2, 2, [0, 0, 2, 2, -1, -1], [...Array(12).fill(0), 255, 255, 255, 255]],
    [
      "'1', '0', '0', '0', '1', '2'",
      2,
      2,
      ['1', '0', '0', '0', '1', '2'],
      [0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255],
    ],
  ]
  for (const [label, w, h, args, expected] of cases) {
    const c = ctx2d(w, h)
    c.putImageData(quad(), ...args)
    t.deepEqual(read(c, w, h), expected, `putImageData(quad, ${label})`)
  }
})

test('putImageData ignores a dirty rect whose area overflows an int', (t) => {
  for (const dirty of [
    [65536, 65536],
    [65536, 32768],
    [-65536, 32769],
  ]) {
    const c = ctx2d()
    t.is(c.putImageData(quad(), 0, 0, 0, 0, ...dirty), undefined)
    t.deepEqual(read(c, 2, 2), Array(16).fill(0), `dirty ${dirty.join('x')}`)
  }
  // Huge offsets draw nothing and do not throw.
  const c = ctx2d()
  const id = quad()
  for (const args of [
    [2147483647, 2147483647],
    [-2147483648, -2147483648],
    [0, 0, 2147483647, 2147483647, 2147483647, 2147483647],
    [0, 0, -2147483648, 0, -2147483648, 1],
    [0, 0, 2147483647, 0, 2147483647, 1],
    [2147483647, 0, -2147483648, 0, 2147483647, 1],
    [0, 0, 1, 0, -2147483648, 1],
  ]) {
    t.is(c.putImageData(id, ...args), undefined, args.join(', '))
  }
  t.deepEqual(read(c, 2, 2), Array(16).fill(0))
})

/**
 * Runs `f` with a getter on target[key] for each key of `values`, then
 * removes them. The keys read, in order.
 */
function withIndexGetters(target: object, values: Record<string, unknown>, f: () => void) {
  let reads = ''
  const keys = Object.keys(values)
  for (const key of keys) {
    Object.defineProperty(target, key, {
      configurable: true,
      get() {
        reads += key
        return values[key]
      },
      set(value) {
        Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true })
      },
    })
  }
  try {
    f()
  } finally {
    for (const key of keys) delete (target as any)[key]
  }
  return reads
}

// Serial: the getters are on prototypes that every test in the file uses.
test.serial('putImageData reads no argument that was not passed, as Chrome', (t) => {
  // Under the test loader, index.js has a source map. Node parses it when it
  // first formats a stack through index.js, and that parse reads
  // Object.prototype[0]: throw through index.js before the getters are there.
  void t.throws(() => ctx2d().putImageData())?.stack
  const from = (first: number, value: unknown) =>
    Object.fromEntries(Array.from({ length: 10 - first }, (_, i) => [first + i, value]))
  // All of quad(), its (0,0) pixel only, nothing.
  const all = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]
  const red = [255, 0, 0, 255, ...Array(12).fill(0)]
  const none = Array(16).fill(0)
  const overload = typeError(PUT, OVERLOAD)
  const cases: [object, Record<string, unknown>, (c: any, id: ImageData) => unknown, object, number[]][] = [
    [Object.prototype, { 3: 0, 4: 0, 5: 1, 6: 1 }, (c, id) => c.putImageData(id, 0, 0), { ok: 'undefined' }, all],
    [Object.prototype, from(3, 1), (c, id) => c.putImageData(id, 0, 0), { ok: 'undefined' }, all],
    [Object.prototype, from(3, 'x'), (c, id) => c.putImageData(id, 0, 0), { ok: 'undefined' }, all],
    [
      Object.prototype,
      from(3, 0),
      (c, id) => c.putImageData(id, 1, 1),
      { ok: 'undefined' },
      [...Array(12).fill(0), 255, 0, 0, 255],
    ],
    [Object.prototype, from(4, 1), (c, id) => c.putImageData(id, 0, 0, undefined), overload, none],
    [Object.prototype, from(5, 1), (c, id) => c.putImageData(id, 0, 0, 0, 0), overload, none],
    [Object.prototype, from(6, 1), (c, id) => c.putImageData(id, 0, 0, 0, 0, 1), overload, none],
    [Object.prototype, from(7, 1), (c, id) => c.putImageData(id, 0, 0, 0, 0, 1, 1), { ok: 'undefined' }, red],
    [
      Object.prototype,
      from(3, 1),
      (c, id) => c.putImageData.call({}, id, 0, 0),
      { ctor: 'TypeError', msg: 'Illegal invocation', stack0: 'TypeError: Illegal invocation' },
      none,
    ],
    [Array.prototype, from(0, 1), (c, id) => c.putImageData(id, 0, 0), { ok: 'undefined' }, all],
  ]
  for (const [target, values, f, expected, pixels] of cases) {
    const c = ctx2d()
    const id = quad()
    let r: object = { not: 'run' }
    const reads = withIndexGetters(target, values, () => {
      r = result(() => f(c, id))
    })
    t.deepEqual([r, read(c, 2, 2)], [expected, pixels], f.toString())
    t.is(reads, '', f.toString())
  }
  t.false('3' in Object.prototype)
  t.false('0' in Array.prototype)
})

test('getImageData needs 4 arguments', (t) => {
  const c = ctx2d()
  const required = (present: number) => typeError(GET, `4 arguments required, but only ${present} present.`)
  const size = (fn: () => ImageData) => {
    const r = result(fn) as any
    return r.ok ? { ok: [r.ok.width, r.ok.height, r.ok.colorSpace, r.ok.data.length] } : r
  }
  t.deepEqual(
    size(() => c.getImageData()),
    required(0),
  )
  t.deepEqual(
    size(() => c.getImageData(0)),
    required(1),
  )
  t.deepEqual(
    size(() => c.getImageData(0, 0, 1)),
    required(3),
  )
  t.deepEqual(
    size(() => c.getImageData(0, 0, 1, undefined)),
    typeError(GET, "Value is not of type 'long'."),
  )
  t.deepEqual(
    size(() => c.getImageData(0, 0, 1, 1, undefined)),
    { ok: [1, 1, 'srgb', 4] },
  )
  t.deepEqual(
    size(() => c.getImageData(0, 0, 1, 1, undefined, 'x')),
    { ok: [1, 1, 'srgb', 4] },
  )
  // The count is checked before any conversion.
  let conversions = 0
  const v = {
    valueOf() {
      conversions++
      return 0
    },
  }
  t.deepEqual(
    size(() => c.getImageData(v, v, v)),
    required(3),
  )
  t.is(conversions, 0)
})
