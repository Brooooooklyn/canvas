// ImageDataSettings handling. Expected values and messages were measured in
// Chrome 155 (--disable-gpu; pixel reads on a willReadFrequently canvas).
import test from 'ava'

import { createCanvas, ImageData } from '../index'

type ColorSpace = 'srgb' | 'display-p3'

const filled = (colorSpace?: ColorSpace) => {
  const ctx = createCanvas(2, 2).getContext('2d', colorSpace ? { colorSpace } : undefined)
  ctx.fillStyle = 'rgb(32,128,223)'
  ctx.fillRect(0, 0, 2, 2)
  return ctx
}

const GET_IMAGE_DATA = "Failed to execute 'getImageData' on 'CanvasRenderingContext2D': "
const CREATE_IMAGE_DATA = "Failed to execute 'createImageData' on 'CanvasRenderingContext2D': "
const CONSTRUCT = "Failed to construct 'ImageData': "
const NOT_SETTINGS = "The provided value is not of type 'ImageDataSettings'."

const invalidEnum = (prefix: string, value: unknown) =>
  `${prefix}Failed to read the 'colorSpace' property from 'ImageDataSettings': The provided value '${String(value)}' is not a valid enum value of type PredefinedColorSpace.`
const unsupported = (prefix: string, value: string) =>
  `${prefix}The provided value '${value}' is not a valid enum value of the type PredefinedColorSpace.`

// Untyped access for arguments the typings reject on purpose.
const loose = <T>(value: T) => value as any

test('getImageData takes an ImageDataSettings dictionary', (t) => {
  const srgb = filled()
  const a = srgb.getImageData(0, 0, 1, 1, { colorSpace: 'srgb' })
  t.deepEqual([...a.data], [32, 128, 223, 255])
  t.is(a.colorSpace, 'srgb')
  const b = srgb.getImageData(0, 0, 1, 1, { colorSpace: 'display-p3' })
  t.deepEqual([...b.data], [63, 126, 216, 255])
  t.is(b.colorSpace, 'display-p3')
  const p3 = filled('display-p3')
  const c = p3.getImageData(0, 0, 1, 1, { colorSpace: 'srgb' })
  t.deepEqual([...c.data], [31, 128, 223, 255])
  t.is(c.colorSpace, 'srgb')
  // A missing colorSpace is the context color space. An array, a function and
  // a String object are objects, so they read as {}.
  for (const settings of [
    {},
    undefined,
    null,
    { colorSpace: undefined },
    { pixelFormat: 'rgba-unorm8' },
    [],
    () => {},
    new String('srgb'),
  ]) {
    const d = p3.getImageData(0, 0, 1, 1, loose(settings))
    t.deepEqual([...d.data], [63, 126, 216, 255], String(settings))
    t.is(d.colorSpace, 'display-p3', String(settings))
  }
})

test('getImageData throws TypeError for a 5th argument that is not a dictionary', (t) => {
  const p3 = filled('display-p3')
  // The old non-standard string form is gone, as in Chrome.
  for (const settings of ['srgb', 'display-p3', 5, true]) {
    t.throws(() => p3.getImageData(0, 0, 1, 1, loose(settings)), {
      instanceOf: TypeError,
      message: GET_IMAGE_DATA + NOT_SETTINGS,
    })
  }
})

test('a missing colorSpace falls back to the default color space', (t) => {
  const srgb = createCanvas(1, 1).getContext('2d')
  const p3 = createCanvas(1, 1).getContext('2d', { colorSpace: 'display-p3' })
  t.is(srgb.createImageData(1, 1, {}).colorSpace, 'srgb')
  t.is(srgb.createImageData(1, 1, { colorSpace: 'display-p3' }).colorSpace, 'display-p3')
  t.is(p3.createImageData(1, 1, {}).colorSpace, 'display-p3')
  t.is(p3.createImageData(1, 1).colorSpace, 'display-p3')
  t.is(p3.createImageData(1, 1, undefined).colorSpace, 'display-p3')
  t.is(p3.createImageData(1, 1, loose(null)).colorSpace, 'display-p3')
  t.is(p3.createImageData(1, 1, { colorSpace: 'srgb' }).colorSpace, 'srgb')
  // The constructor defaults to srgb.
  for (const settings of [{}, undefined, null]) {
    t.is(new ImageData(1, 1, loose(settings)).colorSpace, 'srgb')
    const withData = new ImageData(new Uint8ClampedArray([1, 2, 3, 4]), 1, 1, loose(settings))
    t.is(withData.colorSpace, 'srgb')
    t.deepEqual([...withData.data], [1, 2, 3, 4])
  }
  t.is(new ImageData(1, 1, { colorSpace: 'display-p3' }).colorSpace, 'display-p3')
  t.is(new ImageData(new Uint8ClampedArray(4), 1, 1, { colorSpace: 'display-p3' }).colorSpace, 'display-p3')
  // createImageData(1, 1, {}) on a P3 context round-trips through put/get.
  const red = p3.createImageData(1, 1, {})
  red.data.set([255, 0, 0, 255])
  p3.putImageData(red, 0, 0)
  const back = p3.getImageData(0, 0, 1, 1)
  t.deepEqual([...back.data], [255, 0, 0, 255])
  t.is(back.colorSpace, 'display-p3')
})

test('a settings argument that is not a dictionary throws TypeError', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d')
  for (const settings of [5, 'srgb']) {
    t.throws(() => ctx.createImageData(1, 1, loose(settings)), {
      instanceOf: TypeError,
      message: CREATE_IMAGE_DATA + NOT_SETTINGS,
    })
  }
  for (const settings of [5, 'x']) {
    t.throws(() => new ImageData(1, 1, loose(settings)), { instanceOf: TypeError, message: CONSTRUCT + NOT_SETTINGS })
  }
  t.throws(() => new ImageData(new Uint8ClampedArray(4), 1, 1, loose(5)), {
    instanceOf: TypeError,
    message: CONSTRUCT + NOT_SETTINGS,
  })
})

test('the data constructor reads its 3rd argument as the height, not as settings', (t) => {
  const data = () => new Uint8ClampedArray([1, 2, 3, 4])
  // Chrome throws IndexSizeError "The source height is zero or not a number.":
  // a dictionary, null or an explicit undefined before settings is height 0.
  t.throws(() => new ImageData(data(), 1, loose({ colorSpace: 'display-p3' })))
  t.throws(() => new ImageData(data(), 1, loose({})))
  t.throws(() => new ImageData(data(), 1, loose(null)))
  t.throws(() => new ImageData(data(), 1, undefined, { colorSpace: 'display-p3' }))
  // A trailing undefined is a missing height; a numeric string is a number.
  for (const imageData of [
    new ImageData(data(), 1, undefined),
    new ImageData(data(), 1, undefined, undefined),
    new ImageData(data(), 1, loose('1')),
    new ImageData(data(), 1, 1.5),
  ]) {
    t.is(imageData.width, 1)
    t.is(imageData.height, 1)
    t.is(imageData.colorSpace, 'srgb')
    t.deepEqual([...imageData.data], [1, 2, 3, 4])
  }
})

test('ImageData exposes colorSpace and pixelFormat', (t) => {
  const names = Object.getOwnPropertyNames(ImageData.prototype)
  for (const name of ['colorSpace', 'pixelFormat']) {
    t.true(names.includes(name), name)
    const desc = Object.getOwnPropertyDescriptor(ImageData.prototype, name)!
    t.is(typeof desc.get, 'function', name)
    t.is(desc.set, undefined, name)
    t.true(desc.enumerable, name)
    t.true(desc.configurable, name)
  }
  const imageData = new ImageData(1, 1)
  t.is(imageData.colorSpace, 'srgb')
  t.is(imageData.pixelFormat, 'rgba-unorm8')
  t.is(new ImageData(1, 1, { colorSpace: 'display-p3' }).colorSpace, 'display-p3')
  t.is(filled('display-p3').getImageData(0, 0, 1, 1).colorSpace, 'display-p3')
  // Getters only: assigning throws in strict code (ES modules are strict).
  t.throws(
    () => {
      loose(imageData).colorSpace = 'display-p3'
    },
    { instanceOf: TypeError, message: 'Cannot set property colorSpace of #<ImageData> which has only a getter' },
  )
  t.throws(
    () => {
      loose(imageData).pixelFormat = 'rgba-float16'
    },
    { instanceOf: TypeError, message: 'Cannot set property pixelFormat of #<ImageData> which has only a getter' },
  )
  t.is(imageData.colorSpace, 'srgb')
  t.is(imageData.pixelFormat, 'rgba-unorm8')
  t.false(Object.prototype.hasOwnProperty.call(imageData, 'colorSpace'))
  t.deepEqual(Object.keys(imageData), ['data'])
})

test('an invalid colorSpace throws TypeError in every ImageData API', (t) => {
  const ctx = createCanvas(2, 2).getContext('2d')
  for (const colorSpace of ['bogus', 'p3', 'SRGB', '', null, 5]) {
    const settings = loose({ colorSpace })
    t.throws(() => new ImageData(1, 1, settings), {
      instanceOf: TypeError,
      message: invalidEnum(CONSTRUCT, colorSpace),
    })
    t.throws(() => new ImageData(new Uint8ClampedArray(4), 1, 1, settings), {
      instanceOf: TypeError,
      message: invalidEnum(CONSTRUCT, colorSpace),
    })
    t.throws(() => ctx.createImageData(1, 1, settings), {
      instanceOf: TypeError,
      message: invalidEnum(CREATE_IMAGE_DATA, colorSpace),
    })
    t.throws(() => ctx.getImageData(0, 0, 1, 1, settings), {
      instanceOf: TypeError,
      message: invalidEnum(GET_IMAGE_DATA, colorSpace),
    })
  }
  // Values of Chrome's enum that are behind a flag fail one step later, with
  // another message.
  for (const colorSpace of ['srgb-linear', 'rec2020']) {
    const settings = loose({ colorSpace })
    t.throws(() => new ImageData(1, 1, settings), {
      instanceOf: TypeError,
      message: unsupported(CONSTRUCT, colorSpace),
    })
    t.throws(() => new ImageData(new Uint8ClampedArray(4), 1, 1, settings), {
      instanceOf: TypeError,
      message: unsupported(CONSTRUCT, colorSpace),
    })
    t.throws(() => ctx.createImageData(1, 1, settings), {
      instanceOf: TypeError,
      message: unsupported(CREATE_IMAGE_DATA, colorSpace),
    })
    t.throws(() => ctx.getImageData(0, 0, 1, 1, settings), {
      instanceOf: TypeError,
      message: unsupported(GET_IMAGE_DATA, colorSpace),
    })
  }
  // Enum conversion runs ToString first.
  t.is(new ImageData(1, 1, loose({ colorSpace: { toString: () => 'display-p3' } })).colorSpace, 'display-p3')
  // pixelFormat is an enum too; colorSpace is read first.
  t.throws(() => ctx.getImageData(0, 0, 1, 1, loose({ pixelFormat: 'bogus' })), {
    instanceOf: TypeError,
    message: `${GET_IMAGE_DATA}Failed to read the 'pixelFormat' property from 'ImageDataSettings': The provided value 'bogus' is not a valid enum value of type ImageDataPixelFormat.`,
  })
  t.throws(() => ctx.getImageData(0, 0, 1, 1, loose({ colorSpace: 'bogus', pixelFormat: 'bogus' })), {
    instanceOf: TypeError,
    message: invalidEnum(GET_IMAGE_DATA, 'bogus'),
  })
  // Members are read in lexicographic order.
  const seen: string[] = []
  new ImageData(1, 1, loose(new Proxy({}, { get: (_, key) => (seen.push(String(key)), undefined) })))
  t.deepEqual(seen, ['colorSpace', 'pixelFormat'])
})

test('createImageData(imagedata) copies size and colorSpace, not data', (t) => {
  const srgb = createCanvas(1, 1).getContext('2d')
  const p3Source = new ImageData(new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]), 2, 1, { colorSpace: 'display-p3' })
  const copy = srgb.createImageData(p3Source)
  t.is(copy.width, 2)
  t.is(copy.height, 1)
  t.is(copy.colorSpace, 'display-p3')
  t.is(copy.pixelFormat, 'rgba-unorm8')
  t.not(copy.data, p3Source.data)
  t.deepEqual([...copy.data], [0, 0, 0, 0, 0, 0, 0, 0])
  const p3 = createCanvas(1, 1).getContext('2d', { colorSpace: 'display-p3' })
  t.is(p3.createImageData(new ImageData(2, 1)).colorSpace, 'srgb')
  // The copy keeps its color space through putImageData.
  const one = srgb.createImageData(new ImageData(1, 1, { colorSpace: 'display-p3' }))
  one.data.set([32, 128, 223, 255])
  srgb.putImageData(one, 0, 0)
  t.deepEqual([...srgb.getImageData(0, 0, 1, 1).data], [0, 130, 230, 255])
  // Two or more arguments select createImageData(long sw, long sh).
  for (const args of [[5], [5, 5]]) {
    t.throws(() => loose(srgb).createImageData(p3Source, ...args), {
      instanceOf: TypeError,
      message: `${CREATE_IMAGE_DATA}Value is not of type 'long'.`,
    })
  }
  for (const source of [{ width: 2, height: 1, data: new Uint8ClampedArray(8) }, null, 5]) {
    t.throws(() => srgb.createImageData(loose(source)), {
      instanceOf: TypeError,
      message: `${CREATE_IMAGE_DATA}parameter 1 is not of type 'ImageData'.`,
    })
  }
})

// There is no createImageData(Uint8ClampedArray, sw, sh?, settings?): the
// array is ToNumber'd as sw, as in Chrome. createimagedata-args.spec.ts has
// the full table.
test('createImageData has no typed array form', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d', { colorSpace: 'display-p3' })
  const data = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8])
  for (const args of [
    [data, 1, 2],
    [data, 2],
    [data, 2, 1, { colorSpace: 'display-p3' }],
  ]) {
    t.throws(() => loose(ctx).createImageData(...args), {
      instanceOf: TypeError,
      message: `${CREATE_IMAGE_DATA}Value is not of type 'long'.`,
    })
  }
  // The settings are not read when sw is not a long.
  let reads = 0
  t.throws(() =>
    loose(ctx).createImageData(data, 2, 1, {
      get colorSpace() {
        reads++
        return 'bogus'
      },
    }),
  )
  t.is(reads, 0)
})

// Chrome 155 stores these formats as Float16Array / Float32Array (the values
// are in imagedata-float.spec.ts). Node 22 has no Float16Array: rgba-float16
// is a NotSupportedError there.
test('the float pixel formats are accepted in every ImageData API', (t) => {
  const ctx = createCanvas(2, 2).getContext('2d')
  const formats: [string, string][] = [['rgba-float32', '[object Float32Array]']]
  if (typeof (globalThis as any).Float16Array === 'function') formats.push(['rgba-float16', '[object Float16Array]'])
  for (const [pixelFormat, type] of formats) {
    const settings = loose({ pixelFormat })
    for (const imageData of [
      new ImageData(1, 1, settings),
      ctx.createImageData(1, 1, settings),
      ctx.getImageData(0, 0, 1, 1, settings),
    ]) {
      t.is(imageData.pixelFormat, pixelFormat)
      t.is(Object.prototype.toString.call(imageData.data), type)
      t.is(imageData.data.length, 4)
    }
  }
  const unorm8 = { pixelFormat: 'rgba-unorm8' as const }
  for (const imageData of [
    new ImageData(1, 1, unorm8),
    new ImageData(new Uint8ClampedArray(4), 1, 1, unorm8),
    ctx.createImageData(1, 1, unorm8),
    ctx.getImageData(0, 0, 1, 1, unorm8),
  ]) {
    t.is(imageData.pixelFormat, 'rgba-unorm8')
    t.true(imageData.data instanceof Uint8ClampedArray)
  }
  t.is(createCanvas(1, 1).getContext('2d', { colorType: 'float16' }).getContextAttributes().colorType, 'float16')
})

test('getImageData settings getters may use the same context', (t) => {
  // The settings are converted before the call runs, as in Chrome.
  const ctx = createCanvas(2, 2).getContext('2d')
  const read = ctx.getImageData(
    0,
    0,
    1,
    1,
    loose({
      get colorSpace() {
        ctx.fillStyle = 'red'
        ctx.fillRect(0, 0, 2, 2)
        return 'srgb'
      },
    }),
  )
  t.deepEqual([...read.data], [255, 0, 0, 255])
})

test('createImageData picks its overload from the real argument count', (t) => {
  const ctx = createCanvas(2, 2).getContext('2d')
  t.throws(() => loose(ctx).createImageData(), {
    instanceOf: TypeError,
    message: `${CREATE_IMAGE_DATA}1 argument required, but only 0 present.`,
  })
  // An explicit undefined is an argument: two or more select
  // createImageData([EnforceRange] long sw, [EnforceRange] long sh, ...), and
  // neither an ImageData nor undefined is a long. sw and sh are converted
  // before the settings.
  const source = new ImageData(2, 3)
  let reads = 0
  const settings = {
    get colorSpace() {
      reads++
      return 'srgb'
    },
  }
  for (const args of [
    [source, undefined],
    [source, undefined, undefined],
    [source, undefined, settings],
    [source, 5, settings],
    [5, undefined],
    [5, undefined, settings],
    [undefined, 5],
  ]) {
    t.throws(() => loose(ctx).createImageData(...args), {
      instanceOf: TypeError,
      message: `${CREATE_IMAGE_DATA}Value is not of type 'long'.`,
    })
  }
  t.is(reads, 0)
  // One argument is createImageData(imagedata).
  const copy = ctx.createImageData(source)
  t.deepEqual([copy.width, copy.height], [2, 3])
  t.throws(() => loose(ctx).createImageData(undefined), {
    instanceOf: TypeError,
    message: `${CREATE_IMAGE_DATA}parameter 1 is not of type 'ImageData'.`,
  })
  // Arguments after the settings are ignored.
  t.is(loose(ctx).createImageData(2, 3, { colorSpace: 'display-p3' }, 'x').colorSpace, 'display-p3')
  t.is(loose(ctx).createImageData(2, 3, undefined, undefined, 0).width, 2)
  t.is(ctx.createImageData(2, 3, undefined).width, 2)
})

test('createImageData settings getters may use the same context', (t) => {
  // The settings are converted before the call runs, as in Chrome.
  const ctx = createCanvas(2, 2).getContext('2d')
  const created = ctx.createImageData(
    1,
    1,
    loose({
      get colorSpace() {
        ctx.fillRect(0, 0, 1, 1)
        return 'display-p3'
      },
    }),
  )
  t.is(created.colorSpace, 'display-p3')
  const fromAttributes = ctx.createImageData(
    1,
    1,
    loose({
      get colorSpace() {
        return ctx.getContextAttributes().colorSpace
      },
    }),
  )
  t.is(fromAttributes.colorSpace, 'srgb')
})
