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

// Not in Chrome; kept as it was. The array is used as is, not copied.
test('the non-standard createImageData(Uint8ClampedArray, sw, sh?, settings?) form still works', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d', { colorSpace: 'display-p3' })
  const data = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8])
  const withHeight = loose(ctx).createImageData(data, 1, 2)
  t.is(withHeight.data, data)
  t.is(withHeight.width, 1)
  t.is(withHeight.height, 2)
  t.is(withHeight.colorSpace, 'srgb')
  const derived = loose(ctx).createImageData(data, 2)
  t.is(derived.width, 2)
  t.is(derived.height, 1)
  t.is(loose(ctx).createImageData(data, 2, 1, { colorSpace: 'display-p3' }).colorSpace, 'display-p3')
  t.throws(() => loose(ctx).createImageData(data, 2, 1, { colorSpace: 'bogus' }), {
    instanceOf: TypeError,
    message: invalidEnum(CREATE_IMAGE_DATA, 'bogus'),
  })
})
