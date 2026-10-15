// WebIDL conversion of the CanvasRenderingContext2D attribute setters.
// Expected values and messages were measured in Chrome 155 (--disable-gpu;
// pixel reads on a willReadFrequently canvas), the same on arm64 and x64.
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
