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
