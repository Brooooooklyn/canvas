// new ImageData(...) overload resolution, as Chrome's generated binding does
// it (image_data.idl): the data forms take only a Uint8ClampedArray,
// Float16Array or Float32Array (a brand check); any other first argument is
// the width of new ImageData(sw, sh, settings?). Float data needs a float
// pixelFormat. Expected values were measured in Chrome 155 (--disable-gpu,
// arm64 = x64).
import test from 'ava'

import { ImageData } from '../index'

const CONSTRUCT = "Failed to construct 'ImageData': "
const NOT_SETTINGS = "The provided value is not of type 'ImageDataSettings'."
const WIDTH_ZERO = 'The source width is zero or not a number.'
const HEIGHT_ZERO = 'The source height is zero or not a number.'

// Untyped access for arguments the typings reject on purpose.
const loose = (value: unknown) => value as any
const LooseImageData = ImageData as any

const result = (fn: () => ImageData) => {
  try {
    const d = fn()
    return {
      ok: [d.width, d.height, d.colorSpace, d.data.length, Object.prototype.toString.call(d.data)],
      zeros: d.data.every((v: number) => v === 0),
    }
  } catch (e: any) {
    return { ctor: e?.constructor?.name, name: e?.name, code: e?.code, msg: String(e?.message) }
  }
}
const ok = (width: number, height: number, colorSpace = 'srgb') => ({
  ok: [width, height, colorSpace, width * height * 4, '[object Uint8ClampedArray]'],
  zeros: true,
})
const typeError = (msg: string) => ({ ctor: 'TypeError', name: 'TypeError', code: undefined, msg: CONSTRUCT + msg })
const indexSize = (msg: string) => ({ ctor: 'DOMException', name: 'IndexSizeError', code: 1, msg: CONSTRUCT + msg })
const invalidState = (msg: string) => ({
  ctor: 'DOMException',
  name: 'InvalidStateError',
  code: 11,
  msg: CONSTRUCT + msg,
})

test('new ImageData picks its overload from the first argument', (t) => {
  const cases: [string, () => ImageData, object][] = [
    // Not a data array: (sw, sh, settings), and a number is not a dictionary.
    [
      'u16([65535, 0, 0, 65535]), 1, 1',
      () => new ImageData(loose(new Uint16Array([65535, 0, 0, 65535])), 1, 1),
      typeError(NOT_SETTINGS),
    ],
    ['u8(4), 1, 1', () => new ImageData(loose(new Uint8Array(4)), 1, 1), typeError(NOT_SETTINGS)],
    ['u16(4), 0, 1', () => new ImageData(loose(new Uint16Array(4)), 0, 1), typeError(NOT_SETTINGS)],
    // (sw, sh): the array is ToNumber'd through its string, '3' is 3.
    ['u16([3]), 1', () => new ImageData(loose(new Uint16Array([3])), 1), ok(3, 1)],
    [
      "u16([3]), 2, {colorSpace: 'display-p3'}",
      () => new ImageData(loose(new Uint16Array([3])), 2, { colorSpace: 'display-p3' }),
      ok(3, 2, 'display-p3'),
    ],
    ['u8([2]), 1', () => new ImageData(loose(new Uint8Array([2])), 1), ok(2, 1)],
    ['i8([2]), 1', () => new ImageData(loose(new Int8Array([2])), 1), ok(2, 1)],
    ['f64([2]), 1', () => new ImageData(loose(new Float64Array([2])), 1), ok(2, 1)],
    ['[2], 1', () => new ImageData(loose([2]), 1), ok(2, 1)],
    ['{valueOf: 2}, 1', () => new ImageData(loose({ valueOf: () => 2 }), 1), ok(2, 1)],
    ["'2', '3'", () => new ImageData(loose('2'), loose('3')), ok(2, 3)],
    ['1, u8c([3])', () => new ImageData(1, loose(new Uint8ClampedArray([3]))), ok(1, 3)],
    // A toStringTag is not the brand.
    [
      "{toStringTag: 'Float16Array', valueOf: 2}, 1",
      () => new ImageData(loose({ [Symbol.toStringTag]: 'Float16Array', valueOf: () => 2 }), 1),
      ok(2, 1),
    ],
    [
      "u16([2]) with toStringTag 'Float16Array', 1",
      () => {
        const a = new Uint16Array([2])
        Object.defineProperty(a, Symbol.toStringTag, { value: 'Float16Array' })
        return new ImageData(loose(a), 1)
      },
      ok(2, 1),
    ],
    // ToUint32 of NaN is 0.
    [
      'u16([65535, 0, 0, 65535]), 1',
      () => new ImageData(loose(new Uint16Array([65535, 0, 0, 65535])), 1),
      indexSize(WIDTH_ZERO),
    ],
    ['u8(4), 1', () => new ImageData(loose(new Uint8Array(4)), 1), indexSize(WIDTH_ZERO)],
    ['DataView, 1', () => new ImageData(loose(new DataView(new ArrayBuffer(4))), 1), indexSize(WIDTH_ZERO)],
    ['ArrayBuffer, 1', () => new ImageData(loose(new ArrayBuffer(4)), 1), indexSize(WIDTH_ZERO)],
    ['[1, 2, 3, 4], 1', () => new ImageData(loose([1, 2, 3, 4]), 1), indexSize(WIDTH_ZERO)],
    ['null, 1', () => new ImageData(loose(null), 1), indexSize(WIDTH_ZERO)],
    ['BigInt64Array(1), 1', () => new ImageData(loose(new BigInt64Array(1)), 1), indexSize(WIDTH_ZERO)],
    ['u16(4), 1, null', () => new ImageData(loose(new Uint16Array(4)), 1, loose(null)), indexSize(WIDTH_ZERO)],
    // Engine conversion errors get the prefix.
    [
      "Symbol('s'), 1",
      () => new ImageData(loose(Symbol('s')), 1),
      typeError('Cannot convert a Symbol value to a number'),
    ],
    ['1n, 1', () => new ImageData(loose(BigInt(1)), 1), typeError('Cannot convert a BigInt value to a number')],
    [
      '{valueOf: Symbol}, 1',
      () => new ImageData(loose({ valueOf: () => Symbol('s') }), 1),
      typeError('Cannot convert a Symbol value to a number'),
    ],
    // The data form converts its numbers too.
    ["u8c(4), '1'", () => new ImageData(new Uint8ClampedArray(4), loose('1')), ok(1, 1)],
    ["u8c(4), 1, '1', null", () => new ImageData(new Uint8ClampedArray(4), 1, loose('1'), loose(null)), ok(1, 1)],
    ['u8c(4), -4294967295', () => new ImageData(new Uint8ClampedArray(4), -4294967295), ok(1, 1)],
  ]
  for (const [label, fn, expected] of cases) {
    const r = result(fn)
    // Only the width and height forms make new data.
    t.deepEqual(r, expected, `new ImageData(${label})`)
  }
  // A non-data first argument never becomes the data.
  const u16 = new Uint16Array([3])
  t.not(new ImageData(loose(u16), 1).data, loose(u16))
  // A user error from valueOf passes as it is.
  t.throws(
    () =>
      new ImageData(
        loose({
          valueOf() {
            throw new RangeError('mine')
          },
        }),
        1,
      ),
    { instanceOf: RangeError, message: 'mine' },
  )
  // The engine's own errors keep the bare message in the stack, as in Chrome.
  const error = t.throws(() => new ImageData(loose(Symbol('s')), 1))
  t.is(String(error?.stack).split('\n')[0], 'TypeError: Cannot convert a Symbol value to a number')
})

test('new ImageData converts its arguments in order', (t) => {
  const log: string[] = []
  const v = (tag: string, value: number) => ({
    valueOf() {
      log.push(tag)
      return value
    },
  })
  new ImageData(
    new Uint8ClampedArray(4),
    loose(v('sw', 1)),
    loose(v('sh', 1)),
    loose({
      get colorSpace() {
        log.push('cs')
        return 'srgb'
      },
      get pixelFormat() {
        log.push('pf')
        return 'rgba-unorm8'
      },
    }),
  )
  new ImageData(
    loose(v('sw2', 1)),
    loose(v('sh2', 1)),
    loose({
      get colorSpace() {
        log.push('cs2')
        return 'srgb'
      },
    }),
  )
  t.deepEqual(log, ['sw', 'sh', 'cs', 'pf', 'sw2', 'sh2', 'cs2'])
  // A typed array that is not data is ToNumber'd as the width, before sh.
  const order: string[] = []
  const u = new Uint16Array([2]) as any
  u.valueOf = () => (order.push('arg0'), 2)
  const d = new ImageData(u, loose({ valueOf: () => (order.push('sh'), 1) }))
  order.push(`${d.width}x${d.height}`)
  t.deepEqual(order, ['arg0', 'sh', '2x1'])
})

test('Float32Array and Float16Array data need a float pixelFormat', (t) => {
  const F32 = 'Float32Array must use rgba-float32 pixelFormat.'
  const cases: [string, () => ImageData, object][] = [
    ['f32([1, 0, 0, 1]), 1, 1', () => new LooseImageData(new Float32Array([1, 0, 0, 1]), 1, 1), invalidState(F32)],
    ['f32([1, 0, 0, 1]), 1', () => new LooseImageData(new Float32Array([1, 0, 0, 1]), 1), invalidState(F32)],
    [
      "f32(4), 1, 1, {pixelFormat: 'rgba-unorm8'}",
      () => new LooseImageData(new Float32Array(4), 1, 1, { pixelFormat: 'rgba-unorm8' }),
      invalidState(F32),
    ],
    // The data type is checked before the data length.
    ['f32(0), 1', () => new LooseImageData(new Float32Array(0), 1), invalidState(F32)],
    ['f32(5), 1', () => new LooseImageData(new Float32Array(5), 1), invalidState(F32)],
    ['f32(4), 1, 2', () => new LooseImageData(new Float32Array(4), 1, 2), invalidState(F32)],
    [
      "f32(4), 1, 1, {colorSpace: 'display-p3'}",
      () => new LooseImageData(new Float32Array(4), 1, 1, { colorSpace: 'display-p3' }),
      invalidState(F32),
    ],
    // ... and after the size and the color space.
    ['f32(4), 0', () => new LooseImageData(new Float32Array(4), 0), indexSize(WIDTH_ZERO)],
    [
      'f32(4), 1, undefined, {}',
      () => new LooseImageData(new Float32Array(4), 1, undefined, {}),
      indexSize(HEIGHT_ZERO),
    ],
    ['f32(4), 1, null', () => new LooseImageData(new Float32Array(4), 1, null), indexSize(HEIGHT_ZERO)],
    [
      "f32(4), 1, 1, {colorSpace: 'rec2020'}",
      () => new LooseImageData(new Float32Array(4), 1, 1, { colorSpace: 'rec2020' }),
      typeError("The provided value 'rec2020' is not a valid enum value of the type PredefinedColorSpace."),
    ],
    [
      'f32 over a detached resizable buffer, 1',
      () => {
        const ab = new ArrayBuffer(16, { maxByteLength: 32 })
        const f = new Float32Array(ab)
        ab.transfer()
        return new LooseImageData(f, 1)
      },
      invalidState(F32),
    ],
  ]
  if (typeof Float16Array === 'function') {
    const F16 = 'Float16Array must use rgba-float16 pixelFormat.'
    cases.push(
      ['f16([1, 0, 0, 1]), 1, 1', () => new LooseImageData(new Float16Array([1, 0, 0, 1]), 1, 1), invalidState(F16)],
      ['f16(4), 1', () => new LooseImageData(new Float16Array(4), 1), invalidState(F16)],
      ['f16(0), 1', () => new LooseImageData(new Float16Array(0), 1), invalidState(F16)],
    )
  }
  for (const [label, fn, expected] of cases) {
    t.deepEqual(result(fn), expected, `new ImageData(${label})`)
  }
})
