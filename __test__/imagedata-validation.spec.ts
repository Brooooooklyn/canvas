// ImageData size and data length checks (ImageData::ValidateAndCreate,
// image_data.cc, and getImageDataInternal, base_rendering_context_2d.cc).
// Expected values were measured in Chrome 155 (--disable-gpu, arm64 = x64).
// Before, a zero width in the data forms divided by zero (abort), sizes
// wrapped around in u32, and huge sizes allocated up to 4 GiB.
import test from 'ava'

import { createCanvas, ImageData } from '../index'

const CONSTRUCT = "Failed to construct 'ImageData': "
const CREATE = "Failed to execute 'createImageData' on 'CanvasRenderingContext2D': "
const GET = "Failed to execute 'getImageData' on 'CanvasRenderingContext2D': "

const WIDTH_ZERO = 'The source width is zero or not a number.'
const HEIGHT_ZERO = 'The source height is zero or not a number.'
const EXCEEDS = 'The requested image size exceeds the supported range.'
// With a period: 4 * width * height does not fit in 32 bits (createImageData
// and getImageData). Without: Chrome's allocator limit of 2145386496 bytes,
// or getImageData's int overflow checks.
const OOM_SIZE = 'Out of memory at ImageData creation.'
const OOM = 'Out of memory at ImageData creation'

const indexSize = (msg: string) => ({ ctor: 'DOMException', name: 'IndexSizeError', code: 1, msg })
const invalidState = (msg: string) => ({ ctor: 'DOMException', name: 'InvalidStateError', code: 11, msg })
const rangeError = (msg: string) => ({ ctor: 'RangeError', name: 'RangeError', code: undefined, msg })
const typeError = (msg: string) => ({ ctor: 'TypeError', name: 'TypeError', code: undefined, msg })
const ok = (width: number, height: number, colorSpace = 'srgb') => ({
  ok: [width, height, width * height * 4, colorSpace],
})

const result = (fn: () => ImageData) => {
  try {
    const d = fn()
    return { ok: [d.width, d.height, d.data.length, d.colorSpace] }
  } catch (e: any) {
    return { ctor: e?.constructor?.name, name: e?.name, code: e?.code, msg: String(e?.message) }
  }
}

// Untyped access for arguments the typings reject on purpose.
const loose = (value: unknown) => value as any
const u8 = (n: number) => new Uint8ClampedArray(n)
const ctx2d = () => createCanvas(4, 4).getContext('2d')

test('ImageData rejects zero and out-of-range sizes', (t) => {
  const cases: [number, number, object][] = [
    [0, 1, indexSize(CONSTRUCT + WIDTH_ZERO)],
    [NaN, 1, indexSize(CONSTRUCT + WIDTH_ZERO)],
    [Infinity, 1, indexSize(CONSTRUCT + WIDTH_ZERO)],
    [1, 0, indexSize(CONSTRUCT + HEIGHT_ZERO)],
    // unsigned long: -1 is 4294967295.
    [-1, 1, indexSize(CONSTRUCT + EXCEEDS)],
    [1, -1, indexSize(CONSTRUCT + EXCEEDS)],
    [2147483648, 1, indexSize(CONSTRUCT + EXCEEDS)],
    [1, 2147483648, indexSize(CONSTRUCT + EXCEEDS)],
    [32768, 32768, indexSize(CONSTRUCT + EXCEEDS)],
    [65536, 65536, indexSize(CONSTRUCT + EXCEEDS)],
    [46341, 46341, indexSize(CONSTRUCT + EXCEEDS)],
    [1073741824, 1, indexSize(CONSTRUCT + EXCEEDS)],
    [1, 1073741824, indexSize(CONSTRUCT + EXCEEDS)],
    // Above 2145386496 bytes; nothing is allocated.
    [23170, 23170, rangeError(CONSTRUCT + OOM)],
    [32767, 32767, rangeError(CONSTRUCT + OOM)],
    [1073741823, 1, rangeError(CONSTRUCT + OOM)],
    [536346625, 1, rangeError(CONSTRUCT + OOM)],
    [524289, 1023, rangeError(CONSTRUCT + OOM)],
    [3, 2, ok(3, 2)],
  ]
  for (const [w, h, expected] of cases) {
    t.deepEqual(
      result(() => new ImageData(w, h)),
      expected,
      `new ImageData(${w}, ${h})`,
    )
  }
})

test('ImageData data forms validate before dividing', (t) => {
  const cases: [string, () => ImageData, object][] = [
    ['u8(4), 0', () => new ImageData(u8(4), 0), indexSize(CONSTRUCT + WIDTH_ZERO)],
    ['u8(4), NaN', () => new ImageData(u8(4), NaN), indexSize(CONSTRUCT + WIDTH_ZERO)],
    ['u8(4), 0, 1', () => new ImageData(u8(4), 0, 1), indexSize(CONSTRUCT + WIDTH_ZERO)],
    ['u8(0), 0', () => new ImageData(u8(0), 0), indexSize(CONSTRUCT + WIDTH_ZERO)],
    ['u16(4), 0', () => new ImageData(new Uint16Array(4), 0), indexSize(CONSTRUCT + WIDTH_ZERO)],
    ['f32(4), 0', () => new ImageData(new Float32Array(4), 0), indexSize(CONSTRUCT + WIDTH_ZERO)],
    ['f32(4), 1, 0', () => new ImageData(new Float32Array(4), 1, 0), indexSize(CONSTRUCT + HEIGHT_ZERO)],
    ['u8(0), 1', () => new ImageData(u8(0), 1), invalidState(CONSTRUCT + 'The input data has zero elements.')],
    ['u8(0), 1, 1', () => new ImageData(u8(0), 1, 1), invalidState(CONSTRUCT + 'The input data has zero elements.')],
    ['u8(0), 1, 0', () => new ImageData(u8(0), 1, 0), indexSize(CONSTRUCT + HEIGHT_ZERO)],
    ['u8(4), 1, 0', () => new ImageData(u8(4), 1, 0), indexSize(CONSTRUCT + HEIGHT_ZERO)],
    [
      'u8(5), 1',
      () => new ImageData(u8(5), 1),
      invalidState(CONSTRUCT + 'The input data length is not a multiple of 4.'),
    ],
    [
      'u8(6), 1, 1',
      () => new ImageData(u8(6), 1, 1),
      invalidState(CONSTRUCT + 'The input data length is not a multiple of 4.'),
    ],
    [
      'u8(12), 2',
      () => new ImageData(u8(12), 2),
      indexSize(CONSTRUCT + 'The input data length is not a multiple of (4 * width).'),
    ],
    [
      'u8(8), 1, 1',
      () => new ImageData(u8(8), 1, 1),
      indexSize(CONSTRUCT + 'The input data length is not equal to (4 * width * height).'),
    ],
    [
      'u8(8), 1, 3',
      () => new ImageData(u8(8), 1, 3),
      indexSize(CONSTRUCT + 'The input data length is not equal to (4 * width * height).'),
    ],
    // The size checks run first, with the given height.
    ['u8(4), -1', () => new ImageData(u8(4), -1), indexSize(CONSTRUCT + EXCEEDS)],
    ['u8(4), 1, 2147483648', () => new ImageData(u8(4), 1, 2147483648), indexSize(CONSTRUCT + EXCEEDS)],
    ['u8(16), 4294967295', () => new ImageData(u8(16), 4294967295), indexSize(CONSTRUCT + EXCEEDS)],
    ['u8(16), 2147483648', () => new ImageData(u8(16), 2147483648), indexSize(CONSTRUCT + EXCEEDS)],
    ['u8(4), 1, 1073741825', () => new ImageData(u8(4), 1, 1073741825), indexSize(CONSTRUCT + EXCEEDS)],
    ['u8(8), 2, 1073741824', () => new ImageData(u8(8), 2, 1073741824), indexSize(CONSTRUCT + EXCEEDS)],
    ['u8(4), 1, 1073741824', () => new ImageData(u8(4), 1, 1073741824), indexSize(CONSTRUCT + EXCEEDS)],
    ['u8(16), 2', () => new ImageData(u8(16), 2), ok(2, 2)],
    ['u8(16), 2, 2', () => new ImageData(u8(16), 2, 2), ok(2, 2)],
    ['u8(16), 4', () => new ImageData(u8(16), 4), ok(4, 1)],
  ]
  for (const [label, fn, expected] of cases) {
    t.deepEqual(result(fn), expected, `new ImageData(${label})`)
  }
})

test('createImageData validates sizes in context error mode', (t) => {
  const ctx = ctx2d()
  const cases: [number, number, object][] = [
    [0, 1, indexSize(CREATE + WIDTH_ZERO)],
    [1, 0, indexSize(CREATE + HEIGHT_ZERO)],
    // std::abs(INT_MIN) is above INT_MAX.
    [-2147483648, 1, indexSize(CREATE + EXCEEDS)],
    [32768, 32768, rangeError(CREATE + OOM_SIZE)],
    [65536, 65536, rangeError(CREATE + OOM_SIZE)],
    [46341, 46341, rangeError(CREATE + OOM_SIZE)],
    [1073741824, 1, rangeError(CREATE + OOM_SIZE)],
    [1, 1073741824, rangeError(CREATE + OOM_SIZE)],
    [2147483647, 1, rangeError(CREATE + OOM_SIZE)],
    [23170, 23170, rangeError(CREATE + OOM)],
    [32767, 32767, rangeError(CREATE + OOM)],
    [1073741823, 1, rangeError(CREATE + OOM)],
    [536346625, 1, rangeError(CREATE + OOM)],
    [-536346625, 1, rangeError(CREATE + OOM)],
    [524289, 1023, rangeError(CREATE + OOM)],
    [3, 2, ok(3, 2)],
    [-3, -2, ok(3, 2)],
    [-1, 1, ok(1, 1)],
    [1, -1, ok(1, 1)],
  ]
  for (const [w, h, expected] of cases) {
    t.deepEqual(
      result(() => ctx.createImageData(w, h)),
      expected,
      `createImageData(${w}, ${h})`,
    )
  }
  t.deepEqual(
    result(() => ctx.createImageData(new ImageData(3, 2))),
    ok(3, 2),
  )
  // The non-standard createImageData(data, sw) has no Chrome counterpart; a
  // zero width throws like createImageData(0, sh) instead of dividing by zero.
  t.deepEqual(
    result(() => loose(ctx).createImageData(u8(4), 0)),
    indexSize(CREATE + WIDTH_ZERO),
  )
})

test('getImageData rejects zero and overflowing sizes', (t) => {
  const ctx = ctx2d()
  const cases: [number[], object][] = [
    [[0, 0, 0, 1], indexSize(GET + 'The source width is 0.')],
    [[0, 0, -0.5, 1], indexSize(GET + 'The source width is 0.')],
    [[0, 0, 0.5, 1], indexSize(GET + 'The source width is 0.')],
    [[0, 0, 1, 0], indexSize(GET + 'The source height is 0.')],
    [[0, 0, 1, -0.9], indexSize(GET + 'The source height is 0.')],
    // sw * sh does not fit in an int.
    [[0, 0, 46341, 46341], rangeError(GET + OOM)],
    [[0, 0, 65536, 65536], rangeError(GET + OOM)],
    [[0, 0, 100000, 100000], rangeError(GET + OOM)],
    // 4 * sw * sh does not fit in 32 bits.
    [[0, 0, 32768, 32768], rangeError(GET + OOM_SIZE)],
    [[0, 0, 40000, 40000], rangeError(GET + OOM_SIZE)],
    [[0, 0, 1073741824, 1], rangeError(GET + OOM_SIZE)],
    [[0, 0, 1, 1073741824], rangeError(GET + OOM_SIZE)],
    [[0, 0, 2147483647, 1], rangeError(GET + OOM_SIZE)],
    [[0, 0, -2147483648, 1], rangeError(GET + OOM_SIZE)],
    // Above 2145386496 bytes; nothing is allocated.
    [[0, 0, 23170, 23170], rangeError(GET + OOM)],
    [[0, 0, 32767, 32767], rangeError(GET + OOM)],
    [[0, 0, 1073741823, 1], rangeError(GET + OOM)],
    [[0, 0, 536346625, 1], rangeError(GET + OOM)],
    [[0, 0, -536346625, 1], rangeError(GET + OOM)],
    [[0, 0, 524289, 1023], rangeError(GET + OOM)],
    [[0, 0, 3, 2], ok(3, 2)],
    [[1, 1, 2, 2], ok(2, 2)],
    [[2, 0, -1, 1], ok(1, 1)],
  ]
  for (const [args, expected] of cases) {
    const [x, y, w, h] = args
    t.deepEqual(
      result(() => ctx.getImageData(x, y, w, h)),
      expected,
      `getImageData(${args.join(', ')})`,
    )
  }
})

test('size checks run before the colorSpace support check', (t) => {
  const ctx = ctx2d()
  const unsupported = (prefix: string) =>
    typeError(`${prefix}The provided value 'rec2020' is not a valid enum value of the type PredefinedColorSpace.`)
  const invalidEnum = (prefix: string) =>
    typeError(
      `${prefix}Failed to read the 'colorSpace' property from 'ImageDataSettings': The provided value 'bogus' is not a valid enum value of type PredefinedColorSpace.`,
    )
  const expected: Record<string, Record<string, object>> = {
    rec2020: {
      'new(0, 1)': indexSize(CONSTRUCT + WIDTH_ZERO),
      'new(32768, 32768)': indexSize(CONSTRUCT + EXCEEDS),
      // The allocator limit comes after the colorSpace check.
      'new(23170, 23170)': unsupported(CONSTRUCT),
      'new(1, 1)': unsupported(CONSTRUCT),
      'new(u8(4), 0, 1)': indexSize(CONSTRUCT + WIDTH_ZERO),
      'new(u8(5), 1, undefined)': indexSize(CONSTRUCT + HEIGHT_ZERO),
      'new(u8(4), 1, 1073741825)': indexSize(CONSTRUCT + EXCEEDS),
      'create(0, 1)': indexSize(CREATE + WIDTH_ZERO),
      'create(32768, 32768)': rangeError(CREATE + OOM_SIZE),
      'create(23170, 23170)': unsupported(CREATE),
      'create(1, 1)': unsupported(CREATE),
      'get(0, 0, 0, 1)': indexSize(GET + 'The source width is 0.'),
      'get(0, 0, 46341, 46341)': rangeError(GET + OOM),
      'get(0, 0, 32768, 32768)': rangeError(GET + OOM_SIZE),
      'get(0, 0, 23170, 23170)': unsupported(GET),
      'get(0, 0, 1, 1)': unsupported(GET),
    },
    'display-p3': {
      'new(0, 1)': indexSize(CONSTRUCT + WIDTH_ZERO),
      'new(32768, 32768)': indexSize(CONSTRUCT + EXCEEDS),
      'new(23170, 23170)': rangeError(CONSTRUCT + OOM),
      'new(1, 1)': ok(1, 1, 'display-p3'),
      'new(u8(4), 0, 1)': indexSize(CONSTRUCT + WIDTH_ZERO),
      'new(u8(5), 1, undefined)': indexSize(CONSTRUCT + HEIGHT_ZERO),
      'new(u8(4), 1, 1073741825)': indexSize(CONSTRUCT + EXCEEDS),
      'create(0, 1)': indexSize(CREATE + WIDTH_ZERO),
      'create(32768, 32768)': rangeError(CREATE + OOM_SIZE),
      'create(23170, 23170)': rangeError(CREATE + OOM),
      'create(1, 1)': ok(1, 1, 'display-p3'),
      'get(0, 0, 0, 1)': indexSize(GET + 'The source width is 0.'),
      'get(0, 0, 46341, 46341)': rangeError(GET + OOM),
      'get(0, 0, 32768, 32768)': rangeError(GET + OOM_SIZE),
      'get(0, 0, 23170, 23170)': rangeError(GET + OOM),
      'get(0, 0, 1, 1)': ok(1, 1, 'display-p3'),
    },
  }
  for (const [colorSpace, rows] of Object.entries(expected)) {
    const settings = loose({ colorSpace })
    const calls: Record<string, () => ImageData> = {
      'new(0, 1)': () => new ImageData(0, 1, settings),
      'new(32768, 32768)': () => new ImageData(32768, 32768, settings),
      'new(23170, 23170)': () => new ImageData(23170, 23170, settings),
      'new(1, 1)': () => new ImageData(1, 1, settings),
      'new(u8(4), 0, 1)': () => new ImageData(u8(4), 0, 1, settings),
      'new(u8(5), 1, undefined)': () => new ImageData(u8(5), 1, undefined, settings),
      'new(u8(4), 1, 1073741825)': () => new ImageData(u8(4), 1, 1073741825, settings),
      'create(0, 1)': () => ctx.createImageData(0, 1, settings),
      'create(32768, 32768)': () => ctx.createImageData(32768, 32768, settings),
      'create(23170, 23170)': () => ctx.createImageData(23170, 23170, settings),
      'create(1, 1)': () => ctx.createImageData(1, 1, settings),
      'get(0, 0, 0, 1)': () => ctx.getImageData(0, 0, 0, 1, settings),
      'get(0, 0, 46341, 46341)': () => ctx.getImageData(0, 0, 46341, 46341, settings),
      'get(0, 0, 32768, 32768)': () => ctx.getImageData(0, 0, 32768, 32768, settings),
      'get(0, 0, 23170, 23170)': () => ctx.getImageData(0, 0, 23170, 23170, settings),
      'get(0, 0, 1, 1)': () => ctx.getImageData(0, 0, 1, 1, settings),
    }
    for (const [call, fn] of Object.entries(calls)) {
      t.deepEqual(result(fn), rows[call], `${call} ${colorSpace}`)
    }
    // A value outside the enum fails in the bindings, before any size check.
    if (colorSpace === 'rec2020') {
      const bogus = loose({ colorSpace: 'bogus' })
      t.deepEqual(
        result(() => new ImageData(0, 1, bogus)),
        invalidEnum(CONSTRUCT),
      )
      t.deepEqual(
        result(() => new ImageData(u8(4), 0, 1, bogus)),
        invalidEnum(CONSTRUCT),
      )
      t.deepEqual(
        result(() => ctx.createImageData(0, 1, bogus)),
        invalidEnum(CREATE),
      )
      t.deepEqual(
        result(() => ctx.getImageData(0, 0, 0, 1, bogus)),
        invalidEnum(GET),
      )
    }
  }
})
