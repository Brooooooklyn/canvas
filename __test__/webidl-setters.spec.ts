// WebIDL conversion of the CanvasRenderingContext2D attribute setters.
// Expected values and messages were measured in Chrome 155 on arm64 macOS
// (--disable-gpu; pixel reads on a willReadFrequently canvas).
import test from 'ava'

import { createCanvas } from '../index'

// Untyped access for values the typings reject on purpose.
const loose = <T>(value: T) => value as any

const setterPrefix = (attr: string) => `Failed to set the '${attr}' property on 'CanvasRenderingContext2D': `

const NUMBER_ATTRS = [
  ['globalAlpha', 0.25],
  ['lineWidth', 3],
  ['miterLimit', 4],
  ['shadowBlur', 2],
  ['shadowOffsetX', 6],
  ['shadowOffsetY', 7],
  ['lineDashOffset', 1.5],
] as const

const FLT_MAX = 3.4028234663852886e38

// [input, getter value after the assignment for each of NUMBER_ATTRS], each
// from the start value in NUMBER_ATTRS.
const NUMBER_INPUTS: [unknown, number[]][] = [
  [
    '0.3',
    [
      0.3, 0.30000001192092896, 0.30000001192092896, 0.30000001192092896, 0.30000001192092896, 0.30000001192092896,
      0.30000001192092896,
    ],
  ],
  ['0x10', [0.25, 16, 16, 16, 16, 16, 16]],
  ['', [0, 3, 4, 0, 0, 0, 0]],
  [' 2 ', [0.25, 2, 2, 2, 2, 2, 2]],
  ['abc', [0.25, 3, 4, 2, 6, 7, 1.5]],
  [true, [1, 1, 1, 1, 1, 1, 1]],
  [false, [0, 3, 4, 0, 0, 0, 0]],
  [null, [0, 3, 4, 0, 0, 0, 0]],
  [undefined, [0.25, 3, 4, 2, 6, 7, 1.5]],
  [
    { valueOf: () => 0.4 },
    [
      0.4, 0.4000000059604645, 0.4000000059604645, 0.4000000059604645, 0.4000000059604645, 0.4000000059604645,
      0.4000000059604645,
    ],
  ],
  [{ toString: () => '0.5' }, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]],
  [[], [0, 3, 4, 0, 0, 0, 0]],
  [[2], [0.25, 2, 2, 2, 2, 2, 2]],
  [['3'], [0.25, 3, 3, 3, 3, 3, 3]],
  [NaN, [0.25, 3, 4, 2, 6, 7, 1.5]],
  [Infinity, [0.25, 3, 4, 2, 6, 7, 1.5]],
  [-Infinity, [0.25, 3, 4, 2, 6, 7, 1.5]],
  [-1, [0.25, 3, 4, 2, -1, -1, -1]],
  [0, [0, 3, 4, 0, 0, 0, 0]],
  [-0, [-0, 3, 4, -0, -0, -0, -0]],
  [1e40, [0.25, FLT_MAX, FLT_MAX, FLT_MAX, FLT_MAX, FLT_MAX, FLT_MAX]],
  [5, [0.25, 5, 5, 5, 5, 5, 5]],
  [2.5, [0.25, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5]],
  [new Date(0), [0, 3, 4, 0, 0, 0, 0]],
]

const context = () => createCanvas(10, 10).getContext('2d')

test('number setters convert with ToNumber like Chrome', (t) => {
  for (const [input, expected] of NUMBER_INPUTS) {
    NUMBER_ATTRS.forEach(([attr, start], i) => {
      const ctx = loose(context())
      ctx[attr] = start
      ctx[attr] = input
      t.true(Object.is(ctx[attr], expected[i]), `${attr} = ${String(input)}: ${ctx[attr]} !== ${expected[i]}`)
    })
  }
})

test('number setters clamp to the float range', (t) => {
  const ctx = context()
  ctx.lineWidth = 0.1
  t.is(ctx.lineWidth, 0.10000000149011612)
  ctx.globalAlpha = 0.1
  t.is(ctx.globalAlpha, 0.1)
  ctx.lineWidth = 1e30
  t.is(ctx.lineWidth, 1.0000000150474662e30)
  for (const attr of ['lineWidth', 'miterLimit', 'shadowBlur', 'shadowOffsetX', 'lineDashOffset']) {
    const c = loose(context())
    c[attr] = 1e39
    t.is(c[attr], FLT_MAX, attr)
  }
})

test('number setters throw a prefixed TypeError for Symbol and BigInt', (t) => {
  for (const [attr, start] of NUMBER_ATTRS) {
    const ctx = loose(context())
    ctx[attr] = start
    t.throws(
      () => {
        ctx[attr] = Symbol('s')
      },
      { instanceOf: TypeError, message: `${setterPrefix(attr)}Cannot convert a Symbol value to a number` },
    )
    t.throws(
      () => {
        ctx[attr] = 1n
      },
      { instanceOf: TypeError, message: `${setterPrefix(attr)}Cannot convert a BigInt value to a number` },
    )
    t.is(ctx[attr], start)
  }
})

test('the prefixed message is an enumerable own property, the stack keeps the bare text', (t) => {
  const ctx = loose(context())
  const error = t.throws(() => {
    ctx.lineWidth = Symbol('s')
  })
  t.deepEqual(Object.keys(error), ['message'])
  t.is(
    JSON.stringify(error),
    JSON.stringify({ message: `${setterPrefix('lineWidth')}Cannot convert a Symbol value to a number` }),
  )
  t.is(String(error.stack).split('\n')[0], 'TypeError: Cannot convert a Symbol value to a number')
})

test('number setters pass errors from valueOf through unchanged', (t) => {
  for (const [attr, start] of NUMBER_ATTRS) {
    const ctx = loose(context())
    ctx[attr] = start
    t.throws(
      () => {
        ctx[attr] = {
          valueOf() {
            throw new RangeError('boom')
          },
        }
      },
      { instanceOf: RangeError, message: 'boom' },
    )
    t.is(ctx[attr], start)
  }
  const ctx = loose(context())
  t.throws(
    () => {
      ctx.lineWidth = {
        valueOf() {
          throw new TypeError('Cannot convert a Symbol value to a number')
        },
      }
    },
    { instanceOf: TypeError, message: 'Cannot convert a Symbol value to a number' },
  )
})

test('ToPrimitive failures get the prefix, the stack does not', (t) => {
  const prefix = setterPrefix('lineWidth')
  const ctx = loose(context())
  t.throws(
    () => {
      ctx.lineWidth = { valueOf: () => Symbol('s') }
    },
    { instanceOf: TypeError, message: `${prefix}Cannot convert a Symbol value to a number` },
  )
  for (const value of [{ [Symbol.toPrimitive]: () => ({}) }, Object.create(null)]) {
    const error = t.throws(
      () => {
        ctx.lineWidth = value
      },
      { instanceOf: TypeError, message: `${prefix}Cannot convert object to primitive value` },
    )
    t.is(String(error.stack).split('\n')[0], 'TypeError: Cannot convert object to primitive value')
  }
  let hint
  ctx.lineWidth = {
    [Symbol.toPrimitive](h: string) {
      hint = h
      return 2
    },
  }
  t.is(hint, 'number')
  t.is(ctx.lineWidth, 2)
})

test('a non-callable Symbol.toPrimitive throws a prefixed TypeError', (t) => {
  const ctx = loose(context())
  const error = t.throws(() => {
    ctx.lineWidth = { [Symbol.toPrimitive]: 5 }
  })
  t.true(error instanceof TypeError)
  // The text after the prefix is the engine's own.
  t.true(error.message.startsWith(setterPrefix('lineWidth')), error.message)
})

// An object of `make()` whose Symbol.toPrimitive getter returns 5 (not
// callable) on its first read and throws on any later read.
const toPrimitiveReadOnce = (make: () => object = () => ({})) => {
  const counts = { reads: 0 }
  const value = Object.defineProperty(make(), Symbol.toPrimitive, {
    get() {
      counts.reads++
      if (counts.reads === 1) return 5
      throw new RangeError('Symbol.toPrimitive read again')
    },
  })
  return { value, counts }
}

const notAFunction = (receiver: string) =>
  `'5' returned for property 'Symbol(Symbol.toPrimitive)' of object '${receiver}' is not a function`

test('a non-callable Symbol.toPrimitive is read once', (t) => {
  const targets: [string, (value: unknown) => void][] = [
    [
      setterPrefix('lineWidth'),
      (value) => {
        loose(context()).lineWidth = value
      },
    ],
    [
      setterPrefix('font'),
      (value) => {
        loose(context()).font = value
      },
    ],
    [
      setterPrefix('fillStyle'),
      (value) => {
        loose(context()).fillStyle = value
      },
    ],
    [
      "Failed to execute 'setLineDash' on 'CanvasRenderingContext2D': ",
      (value) => context().setLineDash([loose(value)]),
    ],
    [
      "Failed to set the 'width' property on 'HTMLCanvasElement': ",
      (value) => {
        loose(createCanvas(10, 10)).width = value
      },
    ],
  ]
  for (const [prefix, assign] of targets) {
    const { value, counts } = toPrimitiveReadOnce()
    // Chrome 155 reads it once and throws the engine's TypeError.
    const error = t.throws(() => assign(value), { instanceOf: TypeError, message: prefix + notAFunction('#<Object>') })
    t.is(counts.reads, 1, prefix)
    t.is(String(error.stack).split('\n')[0], `TypeError: ${notAFunction('#<Object>')}`)
  }
  // The engine names the receiver as Chrome does: by its constructor, or
  // by the source text of a function.
  class Foo {}
  const named = function named() {
    return 1
  }
  for (const [make, receiver] of [
    [() => new Foo(), '#<Foo>'],
    [() => named, String(named)],
  ] as const) {
    const { value, counts } = toPrimitiveReadOnce(make)
    t.throws(
      () => {
        loose(context()).lineWidth = value
      },
      { instanceOf: TypeError, message: setterPrefix('lineWidth') + notAFunction(receiver) },
    )
    t.is(counts.reads, 1)
  }
})

test('number setters run valueOf before they borrow the context', (t) => {
  const ctx = loose(context())
  ctx.lineWidth = {
    valueOf() {
      ctx.lineWidth = 7
      return 3
    },
  }
  t.is(ctx.lineWidth, 3)
  ctx.globalAlpha = {
    valueOf() {
      return ctx.lineWidth / 10
    },
  }
  t.is(ctx.globalAlpha, 0.3)
})

test('lineWidth 0 or Infinity keeps the old stroke width', (t) => {
  for (const width of [0, Infinity]) {
    const ctx = context()
    ctx.lineWidth = 3
    ctx.lineWidth = width
    ctx.strokeStyle = '#00f'
    ctx.beginPath()
    ctx.moveTo(0, 5)
    ctx.lineTo(10, 5)
    ctx.stroke()
    const column = []
    for (let y = 2; y <= 7; y++) column.push(ctx.getImageData(5, y, 1, 1).data[3])
    t.deepEqual(column, [0, 127, 255, 255, 127, 0], `lineWidth = ${width}`)
  }
})

const SET_LINE_DASH = "Failed to execute 'setLineDash' on 'CanvasRenderingContext2D': "

const dashContext = () => {
  const ctx = context()
  ctx.setLineDash([5, 6])
  return ctx
}

test('setLineDash converts each entry with ToNumber', (t) => {
  const cases: [unknown[], number[]][] = [
    [
      ['1', '2'],
      [1, 2],
    ],
    [
      [true, false],
      [1, 0],
    ],
    [
      [[3], [4]],
      [3, 4],
    ],
    [[{ valueOf: () => 7 }], [7, 7]],
    [
      [0.1, 0.2],
      [0.10000000149011612, 0.20000000298023224],
    ],
    [
      [1e39, 1],
      [FLT_MAX, 1],
    ],
  ]
  for (const [input, expected] of cases) {
    const ctx = dashContext()
    ctx.setLineDash(loose(input))
    t.deepEqual(ctx.getLineDash(), expected, JSON.stringify(input))
  }
  const ctx = dashContext()
  ctx.setLineDash([-0, 1])
  t.true(Object.is(ctx.getLineDash()[0], -0))
})

test('setLineDash accepts any iterable', (t) => {
  const cases: [Iterable<number>, number[]][] = [
    [new Set([3, 4]), [3, 4]],
    [new Float32Array([3, 4]), [3, 4]],
    [
      [1, 2, 3],
      [1, 2, 3, 1, 2, 3],
    ],
    [
      [0, 0],
      [0, 0],
    ],
    [[], []],
  ]
  for (const [input, expected] of cases) {
    const ctx = dashContext()
    ctx.setLineDash(loose(input))
    t.deepEqual(ctx.getLineDash(), expected)
  }
})

test('setLineDash ignores a list with a negative or non-finite entry', (t) => {
  for (const input of [
    [1, -1],
    [1, NaN],
    [1, Infinity],
    [1, 'a'],
    [2, -1e300],
  ]) {
    const ctx = dashContext()
    ctx.setLineDash(loose(input))
    t.deepEqual(ctx.getLineDash(), [5, 6], JSON.stringify(input))
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(0, 5)
    ctx.lineTo(10, 5)
    t.notThrows(() => ctx.stroke())
  }
})

test('setLineDash throws for a value that is not a sequence', (t) => {
  const cases: [unknown, string][] = [
    [5, 'The provided value cannot be converted to a sequence.'],
    ['12', 'The provided value cannot be converted to a sequence.'],
    [null, 'The provided value cannot be converted to a sequence.'],
    [undefined, 'The provided value cannot be converted to a sequence.'],
    [{}, 'The object must have a callable @@iterator property.'],
    [{ length: 2, 0: 1, 1: 2 }, 'The object must have a callable @@iterator property.'],
    [{ [Symbol.iterator]: 5 }, '@@iterator must be a callable.'],
    [{ [Symbol.iterator]: () => 5 }, 'Iterator object must be an object.'],
    [{ [Symbol.iterator]: () => ({ next: () => 5 }) }, 'Expected iterator.next() to return an Object.'],
    [{ [Symbol.iterator]: () => ({ next: 5 }) }, 'Expected next() function on iterator.'],
    [[Symbol('s')], 'Cannot convert a Symbol value to a number'],
  ]
  for (const [input, message] of cases) {
    const ctx = dashContext()
    const error = t.throws(() => ctx.setLineDash(loose(input)), {
      instanceOf: TypeError,
      message: `${SET_LINE_DASH}${message}`,
    })
    t.is(String(error.stack).split('\n')[0], `TypeError: ${message}`)
    t.deepEqual(ctx.getLineDash(), [5, 6])
  }
  const ctx = dashContext()
  t.throws(
    () =>
      ctx.setLineDash(
        loose({
          [Symbol.iterator]() {
            throw new RangeError('it')
          },
        }),
      ),
    { instanceOf: RangeError, message: 'it' },
  )
})

test('setLineDash converts before it borrows the context', (t) => {
  const ctx = dashContext()
  ctx.setLineDash(
    loose([
      {
        valueOf() {
          ctx.setLineDash([9, 9])
          return 2
        },
      },
      3,
    ]),
  )
  t.deepEqual(ctx.getLineDash(), [2, 3])
})

// Alpha sum of a 4px wide stroke (2,20)->(38,20) on a 40x40 canvas.
const dashedStroke = (dash: number[] | null, offset?: number, cap?: 'round') => {
  const ctx = createCanvas(40, 40).getContext('2d')
  ctx.lineWidth = 4
  if (cap) ctx.lineCap = cap
  if (dash) ctx.setLineDash(dash)
  if (offset !== undefined) ctx.lineDashOffset = offset
  ctx.beginPath()
  ctx.moveTo(2, 20)
  ctx.lineTo(38, 20)
  ctx.stroke()
  const data = ctx.getImageData(0, 0, 40, 40).data
  let sum = 0
  for (let i = 3; i < data.length; i += 4) sum += data[i]
  // fillRect must not throw whatever the dash state.
  ctx.fillRect(0, 30, 4, 4)
  return { sum, dash: ctx.getLineDash(), offset: ctx.lineDashOffset }
}

test('a dash list Skia cannot dash strokes solid', (t) => {
  t.deepEqual(dashedStroke(null), { sum: 36720, dash: [], offset: 0 })
  t.deepEqual(dashedStroke([0, 0]), { sum: 36720, dash: [0, 0], offset: 0 })
  t.deepEqual(dashedStroke([0]), { sum: 36720, dash: [0, 0], offset: 0 })
  t.deepEqual(dashedStroke([FLT_MAX, FLT_MAX]), { sum: 36720, dash: [FLT_MAX, FLT_MAX], offset: 0 })
  t.deepEqual(dashedStroke([1e300, 1e300]), { sum: 36720, dash: [FLT_MAX, FLT_MAX], offset: 0 })
  t.is(dashedStroke([0, 0], undefined, 'round').sum, 39812)
})

test('lineDashOffset ignores non-finite values and clamps to the float range', (t) => {
  t.deepEqual(dashedStroke([4, 2]), { sum: 24480, dash: [4, 2], offset: 0 })
  t.deepEqual(dashedStroke([4, 2], 1e300), { sum: 24480, dash: [4, 2], offset: FLT_MAX })
  t.deepEqual(dashedStroke([4, 2], NaN), { sum: 24480, dash: [4, 2], offset: 0 })
  t.deepEqual(dashedStroke([4, 2], Infinity), { sum: 24480, dash: [4, 2], offset: 0 })
})

// [attribute, a valid value set first, another valid value, invalid values
// that keep the first one]. Enum attributes ignore a value outside the enum,
// case-sensitive, after ToString.
const ENUM_ATTRS: [string, string, string, unknown[]][] = [
  ['textAlign', 'left', 'center', ['CENTER', 'middle', 'justify', '', null, undefined, 5, true]],
  ['textBaseline', 'bottom', 'top', ['TOP', 'center', '', null, undefined, 5, true]],
  ['direction', 'ltr', 'rtl', ['RTL', 'auto', '', null, undefined, 5, true]],
  ['fontKerning', 'normal', 'none', ['NONE', 'off', '', null, undefined, 5, true]],
  ['fontStretch', 'expanded', 'condensed', ['CONDENSED', '50%', '100%', 'wider', '', null, undefined, 5, true]],
  ['fontVariantCaps', 'unicase', 'small-caps', ['SMALL-CAPS', 'smallcaps', '', null, undefined, 5, true]],
  ['textRendering', 'geometricPrecision', 'optimizeSpeed', ['optimizespeed', 'fast', '', null, undefined, 5, true]],
  ['imageSmoothingQuality', 'medium', 'high', ['HIGH', 'best', 'Low', '', null, undefined, 5, true]],
  [
    'globalCompositeOperation',
    'xor',
    'multiply',
    [
      'MULTIPLY',
      'bogus',
      'destination',
      'source',
      'modulate',
      'plus-lighter',
      'plus-darker',
      'darker',
      ' multiply',
      'multiply ',
      '',
      null,
      undefined,
      5,
      true,
    ],
  ],
  ['lineCap', 'square', 'round', ['ROUND', 'Round', 'bogus', '', null, undefined, 5, true]],
  ['lineJoin', 'miter', 'bevel', ['BEVEL', 'Bevel', 'bogus', '', null, undefined, 5, true]],
]

test('enum setters ignore invalid values and convert objects', (t) => {
  for (const [attr, first, valid, invalid] of ENUM_ATTRS) {
    for (const value of invalid) {
      const ctx = loose(context())
      ctx[attr] = first
      t.notThrows(() => {
        ctx[attr] = value
      })
      t.is(ctx[attr], first, `${attr} = ${String(value)}`)
    }
    for (const value of [valid, { toString: () => valid }, [valid]]) {
      const ctx = loose(context())
      ctx[attr] = first
      ctx[attr] = value
      t.is(ctx[attr], valid, `${attr} = ${String(value)}`)
    }
  }
})

test('lang is a DOMString', (t) => {
  const cases: [unknown, string][] = [
    [null, 'null'],
    [undefined, 'undefined'],
    [5, '5'],
    [true, 'true'],
    ['EN', 'EN'],
    [{ toString: () => 'en' }, 'en'],
    [['en'], 'en'],
  ]
  for (const [value, expected] of cases) {
    const ctx = loose(context())
    ctx.lang = value
    t.is(ctx.lang, expected)
  }
})

test('font, letterSpacing, wordSpacing and filter convert with ToString', (t) => {
  const ctx = loose(context())
  ctx.font = { toString: () => '12px serif' }
  t.is(ctx.font, '12px serif')
  ctx.letterSpacing = ['2px']
  t.is(ctx.letterSpacing, '2px')
  ctx.wordSpacing = { toString: () => '3px' }
  t.is(ctx.wordSpacing, '3px')
  ctx.filter = { toString: () => 'blur(2px)' }
  t.is(ctx.filter, 'blur(2px)')
  for (const value of [null, undefined, 5, 'bogus']) {
    ctx.filter = value
    t.is(ctx.filter, 'blur(2px)')
  }
})

test('font, textAlign, textBaseline and shadowColor do not throw on invalid values', (t) => {
  const ctx = loose(context())
  ctx.font = '12px serif'
  // ctx.font = 5 is left out: the font parser takes the unitless '5' as a
  // size (the font shorthand item); Chrome ignores it.
  for (const value of ['bogus', '', null, 'inherit', 'initial', 'var(--x) serif']) {
    t.notThrows(() => {
      ctx.font = value
    })
    t.is(ctx.font, '12px serif', String(value))
  }
  ctx.textAlign = 'center'
  t.notThrows(() => {
    ctx.textAlign = 'CENTER'
  })
  t.is(ctx.textAlign, 'center')
  ctx.textBaseline = 'top'
  t.notThrows(() => {
    ctx.textBaseline = 'bogus'
  })
  t.is(ctx.textBaseline, 'top')
  ctx.shadowColor = '#ff0000'
  for (const value of ['bogus', '', 'notacolor', null, 5]) {
    t.notThrows(() => {
      ctx.shadowColor = value
    })
    t.is(ctx.shadowColor, '#ff0000', String(value))
  }
})

test('string setters throw a prefixed TypeError for Symbol', (t) => {
  for (const attr of ['lineCap', 'textAlign', 'font', 'fillStyle', 'strokeStyle', 'shadowColor', 'filter', 'lang']) {
    const ctx = loose(context())
    const error = t.throws(
      () => {
        ctx[attr] = Symbol('s')
      },
      { instanceOf: TypeError, message: `${setterPrefix(attr)}Cannot convert a Symbol value to a string` },
    )
    t.is(String(error.stack).split('\n')[0], 'TypeError: Cannot convert a Symbol value to a string')
  }
})

const pixel = (ctx: ReturnType<typeof context>, x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data)

test('currentcolor paints opaque black', (t) => {
  for (const value of ['currentcolor', 'CurrentColor']) {
    const ctx = createCanvas(4, 4).getContext('2d')
    ctx.fillStyle = 'red'
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual(pixel(ctx, 1, 1), [0, 0, 0, 255], value)
  }
  {
    const ctx = createCanvas(4, 4).getContext('2d')
    ctx.strokeStyle = 'red'
    ctx.strokeStyle = 'currentcolor'
    ctx.lineWidth = 4
    ctx.strokeRect(0, 0, 4, 4)
    t.deepEqual(pixel(ctx, 0, 0), [0, 0, 0, 255])
  }
  {
    const ctx = createCanvas(4, 4).getContext('2d')
    ctx.shadowColor = 'red'
    t.notThrows(() => {
      ctx.shadowColor = 'currentcolor'
    })
    ctx.shadowOffsetX = 2
    ctx.fillStyle = '#00f'
    ctx.fillRect(0, 0, 2, 4)
    t.deepEqual(pixel(ctx, 3, 1), [0, 0, 0, 255])
  }
  {
    const ctx = createCanvas(4, 4).getContext('2d')
    const gradient = ctx.createLinearGradient(0, 0, 4, 0)
    t.notThrows(() => {
      gradient.addColorStop(0, 'currentcolor')
      gradient.addColorStop(1, 'currentcolor')
    })
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual(pixel(ctx, 1, 1), [0, 0, 0, 255])
  }
})

test('fillStyle converts values that are not a style with ToString', (t) => {
  const cases: [unknown, number[]][] = [
    [5, [0, 255, 0, 255]],
    [null, [0, 255, 0, 255]],
    [undefined, [0, 255, 0, 255]],
    [true, [0, 255, 0, 255]],
    [{}, [0, 255, 0, 255]],
    [{ toString: () => 'red' }, [255, 0, 0, 255]],
    [['blue'], [0, 0, 255, 255]],
  ]
  for (const [value, expected] of cases) {
    const ctx = loose(context())
    ctx.fillStyle = '#00ff00'
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual(pixel(ctx, 1, 1), expected, String(value))
  }
  const ctx = loose(context())
  ctx.fillStyle = '#00ff00'
  // An object that passes instanceof but wraps no gradient: ToString, then
  // an invalid color, so the assignment is ignored.
  const fake = Object.create(Object.getPrototypeOf(ctx.createLinearGradient(0, 0, 1, 1)))
  t.notThrows(() => {
    ctx.fillStyle = fake
  })
  t.is(ctx.fillStyle, '#00ff00')
  // A gradient or pattern is kept as the object.
  const gradient = ctx.createLinearGradient(0, 0, 1, 1)
  ctx.fillStyle = gradient
  t.is(ctx.fillStyle, gradient)
  const pattern = ctx.createPattern(createCanvas(2, 2), 'repeat')
  ctx.strokeStyle = pattern
  t.is(ctx.strokeStyle, pattern)
})

test('string setters run toString before they borrow the context', (t) => {
  const ctx = loose(context())
  ctx.textAlign = {
    toString() {
      return ctx.textBaseline === 'alphabetic' ? 'center' : 'left'
    },
  }
  t.is(ctx.textAlign, 'center')
  ctx.globalAlpha = 0.3
  ctx.fillStyle = {
    toString() {
      ctx.fillRect(0, 0, 1, 1)
      return 'red'
    },
  }
  t.deepEqual(pixel(ctx, 0, 0), [0, 0, 0, 77])
})
