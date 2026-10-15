// WebIDL behavior of the canvas classes: getContext() and the width and
// height attributes. Expected values and messages were measured in Chrome 155
// on arm64 macOS. SVGCanvas has no counterpart in Chrome; it follows the
// canvas with its own class name.
import test from 'ava'

import { createCanvas, Image, SvgExportFlag } from '../index'

// Untyped access for arguments the typings reject on purpose.
const loose = <T>(value: T) => value as any

const GET_CONTEXT = "Failed to execute 'getContext' on 'HTMLCanvasElement': "

test('getContext returns null for an unsupported id', (t) => {
  // Chrome returns contexts for 'webgl', 'webgl2', 'webgpu', 'bitmaprenderer'
  // and 'experimental-webgl'; this library has none of them.
  for (const id of [
    'foo',
    '2D',
    '',
    null,
    undefined,
    2,
    ' 2d',
    '2d ',
    'webgl',
    'webgl2',
    'webgpu',
    'bitmaprenderer',
    'experimental-webgl',
  ]) {
    t.is(loose(createCanvas(4, 4)).getContext(id), null, String(id))
    t.is(loose(createCanvas(4, 4, SvgExportFlag.NoPrettyXML)).getContext(id), null, `SVGCanvas ${String(id)}`)
  }
  // After '2d', another id is still null; '2d' after another id works.
  const canvas = createCanvas(4, 4)
  const ctx = canvas.getContext('2d')
  t.is(canvas.getContext('foo'), null)
  t.is(canvas.getContext('2d'), ctx)
  const later = createCanvas(4, 4)
  t.is(later.getContext('foo'), null)
  t.truthy(later.getContext('2d'))
})

test('getContext converts the id with ToString', (t) => {
  const canvas = createCanvas(4, 4)
  const ctx = canvas.getContext('2d')
  t.is(loose(canvas).getContext({ toString: () => '2d' }), ctx)

  const error = t.throws(() => loose(createCanvas(4, 4)).getContext(Symbol()), {
    instanceOf: TypeError,
    message: `${GET_CONTEXT}Cannot convert a Symbol value to a string`,
  })
  t.is(String(error.stack).split('\n')[0], 'TypeError: Cannot convert a Symbol value to a string')
  t.deepEqual(Object.keys(error), ['message'])
  t.throws(() => loose(createCanvas(4, 4, SvgExportFlag.NoPrettyXML)).getContext(Symbol()), {
    instanceOf: TypeError,
    message: "Failed to execute 'getContext' on 'SVGCanvas': Cannot convert a Symbol value to a string",
  })

  // The id is converted before the options; a Symbol stops before them.
  const log: string[] = []
  const options = {
    get colorSpace() {
      log.push('colorSpace')
      return 'srgb'
    },
    get alpha() {
      log.push('alpha')
      return true
    },
  }
  const id = {
    toString() {
      log.push('id')
      return 'foo'
    },
  }
  t.is(loose(createCanvas(4, 4)).getContext(id, options), null)
  t.deepEqual(log.splice(0), ['id', 'alpha', 'colorSpace'])
  t.throws(() => loose(createCanvas(4, 4)).getContext(Symbol(), options), { instanceOf: TypeError })
  t.deepEqual(log, [])
})

test('getContext needs one argument', (t) => {
  const canvas = loose(createCanvas(4, 4))
  t.is(canvas.getContext.length, 1)
  const error = t.throws(() => canvas.getContext(), {
    instanceOf: TypeError,
    message: `${GET_CONTEXT}1 argument required, but only 0 present.`,
  })
  t.is(String(error.stack).split('\n')[0], 'TypeError: 1 argument required, but only 0 present.')
  t.deepEqual(Object.keys(error), ['message'])
  const svg = loose(createCanvas(4, 4, SvgExportFlag.NoPrettyXML))
  t.is(svg.getContext.length, 1)
  t.throws(() => svg.getContext(), {
    instanceOf: TypeError,
    message: "Failed to execute 'getContext' on 'SVGCanvas': 1 argument required, but only 0 present.",
  })
  // A foreign receiver throws 'Illegal invocation' first.
  const getContext = Object.getPrototypeOf(canvas).getContext
  t.throws(() => getContext.call({}), { instanceOf: TypeError, message: 'Illegal invocation' })
  t.throws(() => getContext.call({}, '2d'), { instanceOf: TypeError, message: 'Illegal invocation' })
})

test('getContext still converts the options for an unsupported id', (t) => {
  t.throws(() => loose(createCanvas(4, 4)).getContext('foo', { colorSpace: 'bogus' }), {
    instanceOf: TypeError,
    message: `${GET_CONTEXT}Failed to read the 'colorSpace' property from 'CanvasContextCreationAttributesModule': The provided value 'bogus' is not a valid enum value of type PredefinedColorSpace.`,
  })
})

// [value, width, height]. Chrome gives 0 x 0 for 0, null, NaN, 'abc' and
// the infinities; a canvas without pixels is not supported here, so those
// keep the 350 x 150 fallback and are not pinned.
const CANVAS_SIZES: [unknown, number, number][] = [
  ['7', 7, 7],
  [1.9, 1, 1],
  [4294967297, 1, 1],
  [true, 1, 1],
  [{ valueOf: () => 9 }, 9, 9],
  ['0x10', 16, 16],
  [[5], 5, 5],
  [-1, 300, 150],
]

test('canvas width and height convert with ToNumber and ToUint32', (t) => {
  for (const make of [() => createCanvas(4, 4), () => createCanvas(4, 4, SvgExportFlag.NoPrettyXML)]) {
    for (const [value, width, height] of CANVAS_SIZES) {
      const a = loose(make())
      a.width = value
      const b = loose(make())
      b.height = value
      t.deepEqual([a.width, b.height], [width, height], String(value))
    }
    // Above 2147483647 is the default.
    const big = loose(make())
    big.width = 2147483648
    t.is(big.width, 300)
  }
})

test('canvas width and height throw a prefixed TypeError for Symbol and BigInt', (t) => {
  const canvas = loose(createCanvas(4, 4))
  t.throws(
    () => {
      canvas.width = Symbol()
    },
    {
      instanceOf: TypeError,
      message: "Failed to set the 'width' property on 'HTMLCanvasElement': Cannot convert a Symbol value to a number",
    },
  )
  t.throws(
    () => {
      canvas.width = 3n
    },
    {
      instanceOf: TypeError,
      message: "Failed to set the 'width' property on 'HTMLCanvasElement': Cannot convert a BigInt value to a number",
    },
  )
  t.is(canvas.width, 4)
  const svg = loose(createCanvas(4, 4, SvgExportFlag.NoPrettyXML))
  t.throws(
    () => {
      svg.height = Symbol()
    },
    {
      instanceOf: TypeError,
      message: "Failed to set the 'height' property on 'SVGCanvas': Cannot convert a Symbol value to a number",
    },
  )
})

// A 2x2 PNG.
const RED_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwnwEJMGBwAKUwA/0ghlmZAAAAAElFTkSuQmCC'

const loadedImage = async () => {
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = (error) => reject(error)
    image.src = RED_PNG
  })
  return image
}

// [value, width or height]: Chrome's values for a loaded image and for one
// without src.
const IMAGE_SIZES: [unknown, number][] = [
  ['50', 50],
  [-1, 0],
  [1.9, 1],
  [{ valueOf: () => 7 }, 7],
  [NaN, 0],
  [Infinity, 0],
  [2147483648, 0],
  [2147483647, 2147483647],
  [0, 0],
  [null, 0],
  [undefined, 0],
  [true, 1],
  [-0.5, 0],
  [4294967297, 1],
  ['0x10', 16],
  [[5], 5],
]

test('Image width and height are WebIDL unsigned long', async (t) => {
  for (const [value, expected] of IMAGE_SIZES) {
    for (const image of [loose(await loadedImage()), loose(new Image())]) {
      image.width = value
      t.is(image.width, expected, `width ${String(value)}`)
    }
    for (const image of [loose(await loadedImage()), loose(new Image())]) {
      image.height = value
      t.is(image.height, expected, `height ${String(value)}`)
    }
  }
  // The natural size does not change.
  const image = loose(await loadedImage())
  image.height = 50
  t.is(image.naturalHeight, 2)

  const fresh = loose(new Image())
  t.throws(
    () => {
      fresh.width = Symbol()
    },
    {
      instanceOf: TypeError,
      message: "Failed to set the 'width' property on 'HTMLImageElement': Cannot convert a Symbol value to a number",
    },
  )
  t.throws(
    () => {
      fresh.height = 1n
    },
    {
      instanceOf: TypeError,
      message: "Failed to set the 'height' property on 'HTMLImageElement': Cannot convert a BigInt value to a number",
    },
  )
})

test('Image alt is a DOMString', (t) => {
  const image = loose(new Image())
  for (const [value, expected] of [
    [5, '5'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{ toString: () => 'x' }, 'x'],
    [true, 'true'],
  ] as const) {
    image.alt = value
    t.is(image.alt, expected)
  }
  t.throws(
    () => {
      image.alt = Symbol()
    },
    {
      instanceOf: TypeError,
      message: "Failed to set the 'alt' property on 'HTMLImageElement': Cannot convert a Symbol value to a string",
    },
  )
})
