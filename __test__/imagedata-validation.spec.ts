// ImageData size and data length checks (ImageData::ValidateAndCreate,
// image_data.cc, and getImageDataInternal, base_rendering_context_2d.cc).
// Expected values were measured in Chrome 155 (--disable-gpu, arm64 = x64).
// Before, a zero width in the data forms divided by zero (abort) and sizes
// wrapped around in u32.
import test from 'ava'

import { createCanvas, ImageData } from '../index'

const CONSTRUCT = "Failed to construct 'ImageData': "
const CREATE = "Failed to execute 'createImageData' on 'CanvasRenderingContext2D': "
const GET = "Failed to execute 'getImageData' on 'CanvasRenderingContext2D': "

const WIDTH_ZERO = 'The source width is zero or not a number.'
const HEIGHT_ZERO = 'The source height is zero or not a number.'
const EXCEEDS = 'The requested image size exceeds the supported range.'
// With a period: 4 * width * height does not fit in 32 bits (createImageData
// and getImageData). Without: getImageData's int overflow checks. Not Chrome:
// there is no 2145386496-byte allocator limit (main had none), so sizes
// between that and 4 GiB are allocated and not tested here.
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
    // Not Chrome (IndexSizeError): an empty ImageData, as on main (see the
    // test below).
    [0, 1, ok(0, 1)],
    [1, 0, ok(1, 0)],
    // std::abs(INT_MIN) is above INT_MAX.
    [-2147483648, 1, indexSize(CREATE + EXCEEDS)],
    [32768, 32768, rangeError(CREATE + OOM_SIZE)],
    [65536, 65536, rangeError(CREATE + OOM_SIZE)],
    [46341, 46341, rangeError(CREATE + OOM_SIZE)],
    [1073741824, 1, rangeError(CREATE + OOM_SIZE)],
    [1, 1073741824, rangeError(CREATE + OOM_SIZE)],
    [2147483647, 1, rangeError(CREATE + OOM_SIZE)],
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
  // There is no createImageData(data, sw): the array is ToNumber'd as sw,
  // and '0,0,0,0' is NaN.
  t.deepEqual(
    result(() => loose(ctx).createImageData(u8(4), 0)),
    typeError(CREATE + "Value is not of type 'long'."),
  )
})

// Not Chrome: Chrome throws for these sizes. pdf.js passes them from malformed
// PDFs (an image /Width of 0.5 or 1e400 makes createImageData(width, 16)), and
// main returned an empty ImageData, so the page went on.
test('createImageData returns an empty ImageData for a size that converts to 0', (t) => {
  const ctx = ctx2d()
  for (const w of [0, -0, 0.5, -0.5, NaN, Infinity, -Infinity]) {
    t.deepEqual(
      result(() => ctx.createImageData(w, 16)),
      ok(0, 16),
      `createImageData(${w}, 16)`,
    )
  }
  t.deepEqual(
    result(() => ctx.createImageData(16, NaN)),
    ok(16, 0),
  )
  t.deepEqual(
    result(() => ctx.createImageData(0, 0)),
    ok(0, 0),
  )
  t.deepEqual(
    result(() => ctx.createImageData(-3, 2)),
    ok(3, 2),
  )
  // A display-p3 settings dictionary is still read.
  t.deepEqual(
    result(() => ctx.createImageData(0.5, 16, { colorSpace: 'display-p3' })),
    ok(0, 16, 'display-p3'),
  )
})

test('pdf.js can fill and put an empty createImageData chunk', (t) => {
  const ctx = ctx2d()
  ctx.fillStyle = '#f00'
  ctx.fillRect(0, 0, 4, 4)
  // putBinaryImageData / putBinaryImageMask: one 16-row chunk, written through
  // a Uint32Array view, then put at (0, i * 16).
  const chunk = ctx.createImageData(0.5, 16)
  const view = new Uint32Array(chunk.data.buffer)
  t.is(view.length, 0)
  view.fill(0xff00ff00)
  t.notThrows(() => ctx.putImageData(chunk, 0, 0))
  t.notThrows(() => ctx.putImageData(chunk, 0, 16))
  t.notThrows(() => ctx.putImageData(chunk, 0, 0, 0, 0, 4, 4))
  t.notThrows(() => ctx.putImageData(ctx.createImageData(4, NaN), 0, 0, 0, 0, 4, 4))
  t.deepEqual(Array.from(ctx.getImageData(0, 0, 4, 4).data), Array.from({ length: 16 }, () => [255, 0, 0, 255]).flat())
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
      'new(1, 1)': unsupported(CONSTRUCT),
      'new(u8(4), 0, 1)': indexSize(CONSTRUCT + WIDTH_ZERO),
      'new(u8(5), 1, undefined)': indexSize(CONSTRUCT + HEIGHT_ZERO),
      'new(u8(4), 1, 1073741825)': indexSize(CONSTRUCT + EXCEEDS),
      // Not Chrome: a zero side has no size error (see above).
      'create(0, 1)': unsupported(CREATE),
      'create(32768, 32768)': rangeError(CREATE + OOM_SIZE),
      'create(1, 1)': unsupported(CREATE),
      'get(0, 0, 0, 1)': indexSize(GET + 'The source width is 0.'),
      'get(0, 0, 46341, 46341)': rangeError(GET + OOM),
      'get(0, 0, 32768, 32768)': rangeError(GET + OOM_SIZE),
      'get(0, 0, 1, 1)': unsupported(GET),
    },
    'display-p3': {
      'new(0, 1)': indexSize(CONSTRUCT + WIDTH_ZERO),
      'new(32768, 32768)': indexSize(CONSTRUCT + EXCEEDS),
      'new(1, 1)': ok(1, 1, 'display-p3'),
      'new(u8(4), 0, 1)': indexSize(CONSTRUCT + WIDTH_ZERO),
      'new(u8(5), 1, undefined)': indexSize(CONSTRUCT + HEIGHT_ZERO),
      'new(u8(4), 1, 1073741825)': indexSize(CONSTRUCT + EXCEEDS),
      'create(0, 1)': ok(0, 1, 'display-p3'),
      'create(32768, 32768)': rangeError(CREATE + OOM_SIZE),
      'create(1, 1)': ok(1, 1, 'display-p3'),
      'get(0, 0, 0, 1)': indexSize(GET + 'The source width is 0.'),
      'get(0, 0, 46341, 46341)': rangeError(GET + OOM),
      'get(0, 0, 32768, 32768)': rangeError(GET + OOM_SIZE),
      'get(0, 0, 1, 1)': ok(1, 1, 'display-p3'),
    },
  }
  for (const [colorSpace, rows] of Object.entries(expected)) {
    const settings = loose({ colorSpace })
    const calls: Record<string, () => ImageData> = {
      'new(0, 1)': () => new ImageData(0, 1, settings),
      'new(32768, 32768)': () => new ImageData(32768, 32768, settings),
      'new(1, 1)': () => new ImageData(1, 1, settings),
      'new(u8(4), 0, 1)': () => new ImageData(u8(4), 0, 1, settings),
      'new(u8(5), 1, undefined)': () => new ImageData(u8(5), 1, undefined, settings),
      'new(u8(4), 1, 1073741825)': () => new ImageData(u8(4), 1, 1073741825, settings),
      'create(0, 1)': () => ctx.createImageData(0, 1, settings),
      'create(32768, 32768)': () => ctx.createImageData(32768, 32768, settings),
      'create(1, 1)': () => ctx.createImageData(1, 1, settings),
      'get(0, 0, 0, 1)': () => ctx.getImageData(0, 0, 0, 1, settings),
      'get(0, 0, 46341, 46341)': () => ctx.getImageData(0, 0, 46341, 46341, settings),
      'get(0, 0, 32768, 32768)': () => ctx.getImageData(0, 0, 32768, 32768, settings),
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
