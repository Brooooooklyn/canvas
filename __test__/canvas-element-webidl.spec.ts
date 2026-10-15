// WebIDL behavior of the canvas classes: getContext() and the width and
// height attributes. Expected values and messages were measured in Chrome 155
// on arm64 macOS. SVGCanvas has no counterpart in Chrome; it follows the
// canvas with its own class name.
import test from 'ava'

import { createCanvas, SvgExportFlag } from '../index'

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
