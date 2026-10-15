// createImageData(imagedata) or createImageData([EnforceRange] long sw,
// [EnforceRange] long sh, optional ImageDataSettings settings), as in Chrome
// (base_rendering_context_2d.idl): there is no typed array form, so a typed
// array is converted to a number like any other value. Expected values were
// measured in Chrome 155 (--disable-gpu, arm64 = x64).
import test from 'ava'

import { createCanvas, ImageData } from '../index'

const CREATE = "Failed to execute 'createImageData' on 'CanvasRenderingContext2D': "
const NOT_LONG = "Value is not of type 'long'."

// Untyped access for arguments the typings reject on purpose.
const loose = (value: unknown) => value as any

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>
const ctx2d = (colorSpace?: 'display-p3'): any =>
  createCanvas(2, 2).getContext('2d', colorSpace ? { colorSpace } : undefined)

const result = (fn: () => ImageData) => {
  try {
    const d = fn()
    return { ok: [d.width, d.height, d.colorSpace, d.data.length], zeros: d.data.every((v: number) => v === 0) }
  } catch (e: any) {
    return { ctor: e?.constructor?.name, name: e?.name, code: e?.code, msg: String(e?.message) }
  }
}
const ok = (width: number, height: number, colorSpace = 'srgb') => ({
  ok: [width, height, colorSpace, width * height * 4],
  zeros: true,
})
const typeError = (msg: string) => ({ ctor: 'TypeError', name: 'TypeError', code: undefined, msg: CREATE + msg })
const indexSize = (msg: string) => ({ ctor: 'DOMException', name: 'IndexSizeError', code: 1, msg: CREATE + msg })

test('createImageData reads a typed array argument as a number, like Chrome', (t) => {
  const u8c = (values: number[] | number) => new Uint8ClampedArray(values as any)
  const cases: [string, (ctx: any) => ImageData, object][] = [
    // '1,2,3,4' is NaN.
    ['u8c([1, 2, 3, 4]), 1, 1', (c) => c.createImageData(u8c([1, 2, 3, 4]), 1, 1), typeError(NOT_LONG)],
    ['u8c([1, 2, 3, 4]), 1', (c) => c.createImageData(u8c([1, 2, 3, 4]), 1), typeError(NOT_LONG)],
    [
      "u8c([1, 2, 3, 4]), 1, 1, {colorSpace: 'srgb'}",
      (c) => c.createImageData(u8c([1, 2, 3, 4]), 1, 1, { colorSpace: 'srgb' }),
      typeError(NOT_LONG),
    ],
    ['u8c(4), 0', (c) => c.createImageData(u8c(4), 0), typeError(NOT_LONG)],
    [
      'SAB u8c(8), 1',
      (c) => c.createImageData(new Uint8ClampedArray(new SharedArrayBuffer(8)), 1),
      typeError(NOT_LONG),
    ],
    ['u8c([1, ..., 8]), 1, 2', (c) => c.createImageData(u8c([1, 2, 3, 4, 5, 6, 7, 8]), 1, 2), typeError(NOT_LONG)],
    // One argument is createImageData(imagedata).
    [
      'u8c([1, 2, 3, 4])',
      (c) => c.createImageData(u8c([1, 2, 3, 4])),
      typeError("parameter 1 is not of type 'ImageData'."),
    ],
    // A one-element array is its element; '' is 0.
    ['u8c([3]), 1', (c) => c.createImageData(u8c([3]), 1), ok(3, 1)],
    ['u8c([3]), 1, null', (c) => c.createImageData(u8c([3]), 1, null), ok(3, 1)],
    [
      "u8c([3]), 1, {colorSpace: 'display-p3'}",
      (c) => c.createImageData(u8c([3]), 1, { colorSpace: 'display-p3' }),
      ok(3, 1, 'display-p3'),
    ],
    [
      'u8c([3]), 1, 1',
      (c) => c.createImageData(u8c([3]), 1, 1),
      typeError("The provided value is not of type 'ImageDataSettings'."),
    ],
    ['u8c([2]), u8c([3])', (c) => c.createImageData(u8c([2]), u8c([3])), ok(2, 3)],
    ['u16([2]), 1', (c) => c.createImageData(new Uint16Array([2]), 1), ok(2, 1)],
    ["'2', '3'", (c) => c.createImageData('2', '3'), ok(2, 3)],
    ['[2], [3]', (c) => c.createImageData([2], [3]), ok(2, 3)],
    ['true, true', (c) => c.createImageData(true, true), ok(1, 1)],
    ['1.9, -1.9', (c) => c.createImageData(1.9, -1.9), ok(1, 1)],
    ['-3.7, 2.2', (c) => c.createImageData(-3.7, 2.2), ok(3, 2)],
    ['u8c([]), 1', (c) => c.createImageData(u8c([]), 1), indexSize('The source width is zero or not a number.')],
    ['null, 1', (c) => c.createImageData(null, 1), indexSize('The source width is zero or not a number.')],
    // [EnforceRange] long.
    ['NaN, 1', (c) => c.createImageData(NaN, 1), typeError(NOT_LONG)],
    ['1, Infinity', (c) => c.createImageData(1, Infinity), typeError("Value is infinite and not of type 'long'.")],
    ['2 ** 31, 1', (c) => c.createImageData(2 ** 31, 1), typeError("Value is outside the 'long' value range.")],
    [
      '-(2 ** 31), 1',
      (c) => c.createImageData(-(2 ** 31), 1),
      indexSize('The requested image size exceeds the supported range.'),
    ],
    [
      "Symbol('s'), 1",
      (c) => c.createImageData(Symbol('s'), 1),
      typeError('Cannot convert a Symbol value to a number'),
    ],
    ['1n, 1', (c) => c.createImageData(BigInt(1), 1), typeError('Cannot convert a BigInt value to a number')],
    [
      '{valueOf: Symbol}, 1',
      (c) => c.createImageData({ valueOf: () => Symbol('s') }, 1),
      typeError('Cannot convert a Symbol value to a number'),
    ],
    [
      '{valueOf: {}, toString: {}}, 1',
      (c) => c.createImageData({ valueOf: () => ({}), toString: () => ({}) }, 1),
      typeError('Cannot convert object to primitive value'),
    ],
    // ToNumber runs on an ImageData too.
    [
      'imagedata with valueOf, 3',
      (c) => {
        const id = new ImageData(1, 1) as any
        id.valueOf = () => 2
        return c.createImageData(id, 3)
      },
      ok(2, 3),
    ],
  ]
  for (const [label, fn, expected] of cases) {
    t.deepEqual(
      result(() => fn(ctx2d())),
      expected,
      `createImageData(${label})`,
    )
  }
  // The size comes from the numbers; the data is new.
  const arr = new Uint8ClampedArray([3])
  t.not(ctx2d().createImageData(loose(arr), 1).data, arr)
  // A display-p3 context gives display-p3 ImageData.
  t.deepEqual(
    result(() => ctx2d('display-p3').createImageData(loose(new Uint8ClampedArray([3])), 1)),
    ok(3, 1, 'display-p3'),
  )
})

test('createImageData converts sw, then sh, then the settings', (t) => {
  const log: string[] = []
  const c = ctx2d()
  const a = new Uint8ClampedArray([2]) as any
  a.valueOf = () => (log.push('a'), 2)
  const d = c.createImageData(
    a,
    {
      valueOf() {
        log.push('b')
        return 3
      },
    },
    {
      get colorSpace() {
        log.push('cs')
        return 'srgb'
      },
    },
  )
  log.push(`${d.width}x${d.height}`)
  t.deepEqual(log, ['a', 'b', 'cs', '2x3'])
  // A bad sh stops before the settings.
  const order: string[] = []
  t.throws(
    () =>
      c.createImageData(
        {
          valueOf() {
            order.push('a')
            return 1
          },
        },
        {
          valueOf() {
            order.push('b')
            return NaN
          },
        },
        {
          get colorSpace() {
            order.push('cs')
            return 'srgb'
          },
        },
      ),
    { instanceOf: TypeError, message: CREATE + NOT_LONG },
  )
  t.deepEqual(order, ['a', 'b'])
})

test('createImageData binding errors keep the bare message in the stack', (t) => {
  const c = ctx2d()
  for (const [fn, msg] of [
    [() => c.createImageData(NaN, 1), NOT_LONG],
    [() => c.createImageData(undefined), "parameter 1 is not of type 'ImageData'."],
    [() => c.createImageData(), '1 argument required, but only 0 present.'],
  ] as [() => unknown, string][]) {
    const error = t.throws(fn, { instanceOf: TypeError, message: CREATE + msg })
    t.is(String(error?.stack).split('\n')[0], `TypeError: ${msg}`)
  }
})

test('createImageData(imagedata) still copies only the size and color space', (t) => {
  // The sibling overload: unchanged.
  const source = new ImageData(new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]), 2, 1, { colorSpace: 'display-p3' })
  const ctx: Ctx = createCanvas(1, 1).getContext('2d')
  const copy = ctx.createImageData(source)
  t.deepEqual(
    [copy.width, copy.height, copy.colorSpace, Array.from(copy.data)],
    [2, 1, 'display-p3', [0, 0, 0, 0, 0, 0, 0, 0]],
  )
  t.not(copy.data, source.data)
})
