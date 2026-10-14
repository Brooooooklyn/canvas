// getContext() options and getContextAttributes(). Expected values and
// messages were measured in Chrome 155 (--disable-gpu). SvgCanvas has no
// Chrome counterpart; it converts the options the same way.
import test from 'ava'

import { createCanvas, SvgExportFlag } from '../index'

const CANVAS = "Failed to execute 'getContext' on 'HTMLCanvasElement': "
const SVG_CANVAS = "Failed to execute 'getContext' on 'SVGCanvas': "
const DICT = 'CanvasContextCreationAttributesModule'

const invalidEnum = (prefix: string, key: string, value: unknown, type: string) =>
  `${prefix}Failed to read the '${key}' property from '${DICT}': The provided value '${String(value)}' is not a valid enum value of type ${type}.`

const DEFAULTS = {
  alpha: true,
  colorSpace: 'srgb',
  colorType: 'unorm8',
  desynchronized: false,
  toneMapping: { mode: 'standard' },
  willReadFrequently: false,
}

// Untyped access for options the typings reject on purpose.
const loose = <T>(value: T) => value as any

const canvases = [
  { name: 'Canvas', prefix: CANVAS, create: () => createCanvas(2, 2) },
  { name: 'SvgCanvas', prefix: SVG_CANVAS, create: () => createCanvas(2, 2, SvgExportFlag.ConvertTextToPaths) },
]

for (const { name, prefix, create } of canvases) {
  test(`${name}: an invalid colorSpace throws TypeError`, (t) => {
    for (const colorSpace of ['bogus', 'p3', 'SRGB', '', null, 5]) {
      const canvas = create()
      t.throws(() => canvas.getContext('2d', loose({ colorSpace })), {
        instanceOf: TypeError,
        message: invalidEnum(prefix, 'colorSpace', colorSpace, 'PredefinedColorSpace'),
      })
      // The throw comes before the context is set up.
      t.is(canvas.getContext('2d', { colorSpace: 'display-p3' }).getContextAttributes().colorSpace, 'display-p3')
    }
    for (const colorSpace of ['srgb-linear', 'rec2020']) {
      t.throws(() => create().getContext('2d', loose({ colorSpace })), {
        instanceOf: TypeError,
        message: `${prefix}The provided value '${colorSpace}' is not a valid enum value of the type PredefinedColorSpace.`,
      })
    }
    // Options are converted on every call, also once the context exists.
    const canvas = create()
    const ctx = canvas.getContext('2d')
    t.throws(() => canvas.getContext('2d', loose({ colorSpace: 'bogus' })), {
      instanceOf: TypeError,
      message: invalidEnum(prefix, 'colorSpace', 'bogus', 'PredefinedColorSpace'),
    })
    t.throws(() => canvas.getContext('2d', loose({ willReadFrequently: 1 })), {
      instanceOf: TypeError,
      message: invalidEnum(prefix, 'willReadFrequently', 1, 'CanvasWillReadFrequently'),
    })
    t.is(canvas.getContext('2d', { colorSpace: 'display-p3' }), ctx)
    t.is(ctx.getContextAttributes().colorSpace, 'srgb')
    // Enum conversion runs ToString first.
    const viaToString = create().getContext('2d', loose({ colorSpace: { toString: () => 'display-p3' } }))
    t.is(viaToString.getContextAttributes().colorSpace, 'display-p3')
  })

  test(`${name}: getContext converts the other members like Chrome`, (t) => {
    const attrs = (options: unknown) => create().getContext('2d', loose(options)).getContextAttributes()
    // boolean members use ToBoolean
    t.false(attrs({ alpha: 0 }).alpha)
    t.true(attrs({ alpha: 'yes' }).alpha)
    t.false(attrs({ alpha: null }).alpha)
    t.false(attrs({ alpha: '' }).alpha)
    t.true(attrs({ desynchronized: 1 }).desynchronized)
    t.true(attrs({ desynchronized: true }).desynchronized)
    // Chrome 155 types willReadFrequently as enum {"true", "false", "undefined"}.
    t.true(attrs({ willReadFrequently: true }).willReadFrequently)
    t.true(attrs({ willReadFrequently: 'true' }).willReadFrequently)
    t.false(attrs({ willReadFrequently: false }).willReadFrequently)
    t.false(attrs({ willReadFrequently: 'false' }).willReadFrequently)
    t.false(attrs({ willReadFrequently: 'undefined' }).willReadFrequently)
    for (const willReadFrequently of [1, 0, null, 'yes']) {
      t.throws(() => attrs({ willReadFrequently }), {
        instanceOf: TypeError,
        message: invalidEnum(prefix, 'willReadFrequently', willReadFrequently, 'CanvasWillReadFrequently'),
      })
    }
    t.is(attrs({ colorType: 'float16' }).colorType, 'float16')
    t.is(attrs({ colorType: 'unorm8' }).colorType, 'unorm8')
    t.throws(() => attrs({ colorType: 'bogus' }), {
      instanceOf: TypeError,
      message: invalidEnum(prefix, 'colorType', 'bogus', 'CanvasPixelFormat'),
    })
    // A WebGL member, still converted for '2d'.
    t.deepEqual(attrs({ powerPreference: 'low-power' }), DEFAULTS)
    t.throws(() => attrs({ powerPreference: 'bogus' }), {
      instanceOf: TypeError,
      message: invalidEnum(prefix, 'powerPreference', 'bogus', 'CanvasPowerPreference'),
    })
    // toneMapping is not read by Chrome 155.
    for (const toneMapping of [{ mode: 'bogus' }, { mode: 'extended' }, 5]) {
      t.deepEqual(attrs({ toneMapping }), DEFAULTS)
    }
    // A non-object reads as {}.
    for (const options of [5, 'x', true, null, undefined, []]) {
      t.deepEqual(attrs(options), DEFAULTS, String(options))
    }
    // Members are read in lexicographic order; the first bad one throws.
    t.throws(() => attrs({ colorSpace: 'bogus', colorType: 'bogus' }), {
      message: invalidEnum(prefix, 'colorSpace', 'bogus', 'PredefinedColorSpace'),
    })
    t.throws(() => attrs({ colorType: 'bogus', powerPreference: 'bogus' }), {
      message: invalidEnum(prefix, 'colorType', 'bogus', 'CanvasPixelFormat'),
    })
    t.throws(() => attrs({ powerPreference: 'bogus', willReadFrequently: 1 }), {
      message: invalidEnum(prefix, 'powerPreference', 'bogus', 'CanvasPowerPreference'),
    })
    const order = [
      'alpha',
      'antialias',
      'colorSpace',
      'colorType',
      'depth',
      'desynchronized',
      'failIfMajorPerformanceCaveat',
      'powerPreference',
      'premultipliedAlpha',
      'preserveDrawingBuffer',
      'stencil',
      'willReadFrequently',
      'xrCompatible',
    ]
    const seen: string[] = []
    const canvas = create()
    canvas.getContext('2d', loose(new Proxy({}, { get: (_, key) => (seen.push(String(key)), undefined) })))
    t.deepEqual(seen, order)
    seen.length = 0
    canvas.getContext('2d', loose(new Proxy({}, { get: (_, key) => (seen.push(String(key)), undefined) })))
    t.deepEqual(seen, order)
  })

  test(`${name}: getContextAttributes returns every member in Chrome's key order`, (t) => {
    const defaults = create().getContext('2d').getContextAttributes()
    t.deepEqual(Object.keys(defaults), [
      'alpha',
      'colorSpace',
      'colorType',
      'desynchronized',
      'toneMapping',
      'willReadFrequently',
    ])
    t.deepEqual(defaults, DEFAULTS)
    const canvas = create()
    const ctx = canvas.getContext('2d', {
      alpha: false,
      colorSpace: 'display-p3',
      desynchronized: true,
      willReadFrequently: true,
      colorType: 'float16',
    })
    const expected = {
      alpha: false,
      colorSpace: 'display-p3',
      colorType: 'float16',
      desynchronized: true,
      toneMapping: { mode: 'standard' },
      willReadFrequently: true,
    }
    t.deepEqual(ctx.getContextAttributes(), expected)
    canvas.width = 5
    t.deepEqual(ctx.getContextAttributes(), expected)
    // A later getContext keeps the first settings.
    t.is(canvas.getContext('2d', { alpha: true, colorSpace: 'srgb', willReadFrequently: false }), ctx)
    t.deepEqual(ctx.getContextAttributes(), expected)
    // Each call returns new objects.
    t.not(ctx.getContextAttributes(), ctx.getContextAttributes())
    t.not(ctx.getContextAttributes().toneMapping, ctx.getContextAttributes().toneMapping)
  })
}
