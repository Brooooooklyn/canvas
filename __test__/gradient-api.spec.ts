// Pinned to Chrome 155 CPU canvas (getContext('2d', { willReadFrequently: true }), --disable-gpu),
// measured on arm64 and on x64 (Rosetta); both gave the same values.
import test from 'ava'

import { createCanvas } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

// 'r,g,b,a r,g,b,a ...' rows -> flat RGBA bytes
const rgba = (rows: string[]) =>
  rows.flatMap((row) =>
    row
      .trim()
      .split(/\s+/)
      .flatMap((p) => p.split(',').map(Number)),
  )
const all = (ctx: Ctx, w: number, h: number) => [...ctx.getImageData(0, 0, w, h).data]

type Expect = { ok: true } | { type: string; message: string } | { dom: string; code: number; message: string }

const check = (t: import('ava').ExecutionContext, run: () => unknown, expected: Expect) => {
  if ('ok' in expected) {
    t.notThrows(run)
    return
  }
  const error = t.throws(run) as Error & { code?: number }
  if ('dom' in expected) {
    t.true(error instanceof DOMException)
    t.is(error.name, expected.dom)
    t.is(error.code, expected.code)
  } else {
    t.is(error.constructor, globalThis[expected.type as 'TypeError'])
  }
  t.is(error.message, expected.message)
}

const lin = () => createCanvas(8, 8).getContext('2d').createLinearGradient(0, 0, 8, 0)

// addColorStop(offset, color): WebIDL arity and restricted double first, then the range check
// (IndexSizeError, offset printed like WTF String::Number), then the color (SyntaxError).
const STOP_CASES: Record<string, unknown[]> = {
  neg: [-0.1, 'red'],
  over: [1.1, 'red'],
  tiny: [-1e-7, 'red'],
  over1: [1.0000001, 'red'],
  big: [12345678.9, 'red'],
  huge: [1e21, 'red'],
  hugeNeg: [-1.5e300, 'red'],
  frac: [1.23456789, 'red'],
  third: [-1 / 3, 'red'],
  minVal: [-5e-324, 'red'],
  nan: [NaN, 'red'],
  inf: [Infinity, 'red'],
  ninf: [-Infinity, 'red'],
  negzero: [-0, 'red'],
  one: [1, 'red'],
  zero: [0, 'red'],
  nanBad: [NaN, 'notacolor'],
  rangeBad: [2, 'notacolor'],
  empty: [0, ''],
  space: [0, ' '],
  bogus: [0, 'notacolor'],
  inherit: [0, 'inherit'],
  initial: [0, 'initial'],
  unset: [0, 'unset'],
  currentcolor: [0, 'currentcolor'],
  CurrentColor: [0, 'CurrentColor'],
  currentcolorSp: [0, ' currentColor '],
  trailing: [0, 'red blue'],
  semicolon: [0, 'red;'],
  comma: [0, 'red,'],
  important: [0, 'red !important'],
  comment: [0, 'red /* x */'],
  transparent: [0, 'transparent'],
  spaces: [0, '  red  '],
  upper: [0, 'RED'],
  hex8: [0, '#ff000080'],
  hex3: [0, '#f00'],
  badHex: [0, '#ff00'],
  rgbNone: [0, 'rgb(none 0 0)'],
  nulStr: [0, 'red\u0000'],
  quotes: [0, '"red"'],
  func: [0, 'rgb(1,2)'],
  longMsg: [0, 'x'.repeat(10)],
  strOffset: ['0.5', 'red'],
  strBadOffset: ['abc', 'red'],
  boolOffset: [true, 'red'],
  nullOffset: [null, 'red'],
  objOffset: [
    {
      valueOf() {
        return 0.25
      },
    },
    'red',
  ],
  nullColor: [0, null],
  numColor: [0, 0x123456],
  undefColor: [0, undefined],
  objColor: [
    0,
    {
      toString() {
        return 'red'
      },
    },
  ],
  noArgs: [],
  oneArg: [0.5],
  threeArgs: [0.5, 'red', 'extra'],
}
const STOP_EXPECTED: Record<string, Expect> = {
  neg: {
    dom: 'IndexSizeError',
    code: 1,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (-0.1) is outside the range (0.0, 1.0).",
  },
  over: {
    dom: 'IndexSizeError',
    code: 1,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (1.1) is outside the range (0.0, 1.0).",
  },
  tiny: {
    dom: 'IndexSizeError',
    code: 1,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (-1.00000e-7) is outside the range (0.0, 1.0).",
  },
  over1: {
    dom: 'IndexSizeError',
    code: 1,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (1) is outside the range (0.0, 1.0).",
  },
  big: {
    dom: 'IndexSizeError',
    code: 1,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (1.23457e+7) is outside the range (0.0, 1.0).",
  },
  huge: {
    dom: 'IndexSizeError',
    code: 1,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (1.00000e+21) is outside the range (0.0, 1.0).",
  },
  hugeNeg: {
    dom: 'IndexSizeError',
    code: 1,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (-1.50000e+300) is outside the range (0.0, 1.0).",
  },
  frac: {
    dom: 'IndexSizeError',
    code: 1,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (1.23457) is outside the range (0.0, 1.0).",
  },
  third: {
    dom: 'IndexSizeError',
    code: 1,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (-0.333333) is outside the range (0.0, 1.0).",
  },
  minVal: {
    dom: 'IndexSizeError',
    code: 1,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (-4.94066e-324) is outside the range (0.0, 1.0).",
  },
  nan: {
    type: 'TypeError',
    message: "Failed to execute 'addColorStop' on 'CanvasGradient': The provided double value is non-finite.",
  },
  inf: {
    type: 'TypeError',
    message: "Failed to execute 'addColorStop' on 'CanvasGradient': The provided double value is non-finite.",
  },
  ninf: {
    type: 'TypeError',
    message: "Failed to execute 'addColorStop' on 'CanvasGradient': The provided double value is non-finite.",
  },
  negzero: { ok: true },
  one: { ok: true },
  zero: { ok: true },
  nanBad: {
    type: 'TypeError',
    message: "Failed to execute 'addColorStop' on 'CanvasGradient': The provided double value is non-finite.",
  },
  rangeBad: {
    dom: 'IndexSizeError',
    code: 1,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (2) is outside the range (0.0, 1.0).",
  },
  empty: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('') could not be parsed as a color.",
  },
  space: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided (' ') could not be parsed as a color.",
  },
  bogus: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('notacolor') could not be parsed as a color.",
  },
  inherit: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('inherit') could not be parsed as a color.",
  },
  initial: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('initial') could not be parsed as a color.",
  },
  unset: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('unset') could not be parsed as a color.",
  },
  currentcolor: { ok: true },
  CurrentColor: { ok: true },
  currentcolorSp: { ok: true },
  trailing: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('red blue') could not be parsed as a color.",
  },
  semicolon: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('red;') could not be parsed as a color.",
  },
  comma: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('red,') could not be parsed as a color.",
  },
  important: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('red !important') could not be parsed as a color.",
  },
  comment: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('red /* x */') could not be parsed as a color.",
  },
  transparent: { ok: true },
  spaces: { ok: true },
  upper: { ok: true },
  hex8: { ok: true },
  hex3: { ok: true },
  badHex: { ok: true },
  rgbNone: { ok: true },
  nulStr: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('red\u0000') could not be parsed as a color.",
  },
  quotes: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('\"red\"') could not be parsed as a color.",
  },
  func: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('rgb(1,2)') could not be parsed as a color.",
  },
  longMsg: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('xxxxxxxxxx') could not be parsed as a color.",
  },
  strOffset: { ok: true },
  strBadOffset: {
    type: 'TypeError',
    message: "Failed to execute 'addColorStop' on 'CanvasGradient': The provided double value is non-finite.",
  },
  boolOffset: { ok: true },
  nullOffset: { ok: true },
  objOffset: { ok: true },
  nullColor: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('null') could not be parsed as a color.",
  },
  numColor: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('1193046') could not be parsed as a color.",
  },
  undefColor: {
    dom: 'SyntaxError',
    code: 12,
    message:
      "Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('undefined') could not be parsed as a color.",
  },
  objColor: { ok: true },
  noArgs: {
    type: 'TypeError',
    message: "Failed to execute 'addColorStop' on 'CanvasGradient': 2 arguments required, but only 0 present.",
  },
  oneArg: {
    type: 'TypeError',
    message: "Failed to execute 'addColorStop' on 'CanvasGradient': 2 arguments required, but only 1 present.",
  },
  threeArgs: { ok: true },
}

for (const [name, args] of Object.entries(STOP_CASES)) {
  test(`addColorStop ${name}`, (t) => {
    check(t, () => (lin().addColorStop as (...a: unknown[]) => void)(...args), STOP_EXPECTED[name])
  })
}

// Not Chrome: a NaN or infinite Number does not throw in createLinearGradient
// and createRadialGradient (Chrome: the TypeError of a WebIDL double); the
// gradient paints nothing. pdf.js passes them from malformed PDFs, and main
// did not throw there. Other values that convert to NaN or an infinity keep
// Chrome's TypeError, and a negative radius (-Infinity too) keeps its
// IndexSizeError. createConicGradient is Chrome's.
const CREATE_CASES: Record<string, (c: any) => unknown> = {
  linNaN: (c) => c.createLinearGradient(NaN, 0, 1, 1),
  linInf0: (c) => c.createLinearGradient(0, Infinity, 1, 1),
  linInf: (c) => c.createLinearGradient(0, 0, Infinity, 1),
  linNInf: (c) => c.createLinearGradient(0, 0, 1, -Infinity),
  linNaNInf: (c) => c.createLinearGradient(NaN, Infinity, 1, 1),
  lin3: (c) => c.createLinearGradient(0, 0, 1),
  lin0: (c) => c.createLinearGradient(),
  linStr: (c) => c.createLinearGradient('0', '0', '8', '0'),
  linBadStr: (c) => c.createLinearGradient('a', 0, 8, 0),
  linInfStr: (c) => c.createLinearGradient(0, 'Infinity', 8, 0),
  linNaNObj: (c) => c.createLinearGradient(0, 0, { valueOf: () => NaN }, 0),
  linNull: (c) => c.createLinearGradient(null, 0, 8, 0),
  radNeg0: (c) => c.createRadialGradient(0, 0, -1, 0, 0, 1),
  radNeg1: (c) => c.createRadialGradient(0, 0, 1, 0, 0, -1),
  radNegBoth: (c) => c.createRadialGradient(0, 0, -1, 0, 0, -1),
  radNegZero: (c) => c.createRadialGradient(0, 0, -0, 0, 0, 1),
  radNegTiny: (c) => c.createRadialGradient(0, 0, -1e-300, 0, 0, 1),
  radNaN: (c) => c.createRadialGradient(0, 0, NaN, 0, 0, 1),
  radNegNaN: (c) => c.createRadialGradient(0, 0, -1, 0, 0, NaN),
  radNaNNeg: (c) => c.createRadialGradient(NaN, 0, 1, 0, 0, -1),
  radInfR: (c) => c.createRadialGradient(0, 0, Infinity, 0, 0, 1),
  radInfR1: (c) => c.createRadialGradient(0, 0, 0, 0, 0, Infinity),
  radInfCenter: (c) => c.createRadialGradient(Infinity, 0, 0, 0, 0, 1),
  radNaNStr: (c) => c.createRadialGradient(0, 0, 'NaN', 0, 0, 1),
  radNInfR: (c) => c.createRadialGradient(0, 0, 0, 0, 0, -Infinity),
  rad5: (c) => c.createRadialGradient(0, 0, 0, 0, 0),
  radNeg5: (c) => c.createRadialGradient(0, 0, -1, 0, 0),
  conNaN: (c) => c.createConicGradient(NaN, 0, 0),
  conInf: (c) => c.createConicGradient(0, Infinity, 0),
  conInfY: (c) => c.createConicGradient(0, 0, -Infinity),
  con2: (c) => c.createConicGradient(0, 0),
}
const CREATE_EXPECTED: Record<string, Expect> = {
  linNaN: { ok: true },
  linInf0: { ok: true },
  linInf: { ok: true },
  linNInf: { ok: true },
  linNaNInf: { ok: true },
  lin3: {
    type: 'TypeError',
    message:
      "Failed to execute 'createLinearGradient' on 'CanvasRenderingContext2D': 4 arguments required, but only 3 present.",
  },
  lin0: {
    type: 'TypeError',
    message:
      "Failed to execute 'createLinearGradient' on 'CanvasRenderingContext2D': 4 arguments required, but only 0 present.",
  },
  linStr: { ok: true },
  linBadStr: {
    type: 'TypeError',
    message:
      "Failed to execute 'createLinearGradient' on 'CanvasRenderingContext2D': The provided double value is non-finite.",
  },
  linNull: { ok: true },
  linInfStr: {
    type: 'TypeError',
    message:
      "Failed to execute 'createLinearGradient' on 'CanvasRenderingContext2D': The provided double value is non-finite.",
  },
  linNaNObj: {
    type: 'TypeError',
    message:
      "Failed to execute 'createLinearGradient' on 'CanvasRenderingContext2D': The provided double value is non-finite.",
  },
  radNeg0: {
    dom: 'IndexSizeError',
    code: 1,
    message: "Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The r0 provided is less than 0.",
  },
  radNeg1: {
    dom: 'IndexSizeError',
    code: 1,
    message: "Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The r1 provided is less than 0.",
  },
  radNegBoth: {
    dom: 'IndexSizeError',
    code: 1,
    message: "Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The r0 provided is less than 0.",
  },
  radNegZero: { ok: true },
  radNegTiny: {
    dom: 'IndexSizeError',
    code: 1,
    message: "Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The r0 provided is less than 0.",
  },
  radNaN: { ok: true },
  radNegNaN: {
    dom: 'IndexSizeError',
    code: 1,
    message: "Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The r0 provided is less than 0.",
  },
  radNaNNeg: {
    dom: 'IndexSizeError',
    code: 1,
    message: "Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The r1 provided is less than 0.",
  },
  radInfR: { ok: true },
  radInfR1: { ok: true },
  radInfCenter: { ok: true },
  radNaNStr: {
    type: 'TypeError',
    message:
      "Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The provided double value is non-finite.",
  },
  radNInfR: {
    dom: 'IndexSizeError',
    code: 1,
    message: "Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The r1 provided is less than 0.",
  },
  rad5: {
    type: 'TypeError',
    message:
      "Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': 6 arguments required, but only 5 present.",
  },
  radNeg5: {
    type: 'TypeError',
    message:
      "Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': 6 arguments required, but only 5 present.",
  },
  conNaN: {
    type: 'TypeError',
    message:
      "Failed to execute 'createConicGradient' on 'CanvasRenderingContext2D': The provided double value is non-finite.",
  },
  conInf: {
    type: 'TypeError',
    message:
      "Failed to execute 'createConicGradient' on 'CanvasRenderingContext2D': The provided double value is non-finite.",
  },
  conInfY: {
    type: 'TypeError',
    message:
      "Failed to execute 'createConicGradient' on 'CanvasRenderingContext2D': The provided double value is non-finite.",
  },
  con2: {
    type: 'TypeError',
    message:
      "Failed to execute 'createConicGradient' on 'CanvasRenderingContext2D': 3 arguments required, but only 2 present.",
  },
}

for (const [name, make] of Object.entries(CREATE_CASES)) {
  test(`gradient factory ${name}`, (t) => {
    check(t, () => make(createCanvas(8, 8).getContext('2d')), CREATE_EXPECTED[name])
  })
}

test('a gradient with a NaN or infinite Number paints nothing', (t) => {
  // Not Chrome (a TypeError); see CREATE_CASES.
  const gradients: [string, (c: Ctx) => ReturnType<Ctx['createLinearGradient']>][] = [
    ['linear NaN', (c) => c.createLinearGradient(NaN, 0, 4, 0)],
    ['linear Infinity', (c) => c.createLinearGradient(0, 0, Infinity, 0)],
    ['linear -Infinity', (c) => c.createLinearGradient(0, -Infinity, 4, 0)],
    ['radial NaN center', (c) => c.createRadialGradient(NaN, 2, 0, 2, 2, 4)],
    ['radial Infinity center', (c) => c.createRadialGradient(2, 2, 0, Infinity, 2, 4)],
    ['radial NaN r0', (c) => c.createRadialGradient(2, 2, NaN, 2, 2, 4)],
    ['radial Infinity r0', (c) => c.createRadialGradient(2, 2, Infinity, 2, 2, 4)],
    ['radial Infinity r1', (c) => c.createRadialGradient(2, 2, 0, 2, 2, Infinity)],
    ['radial NaN r1', (c) => c.createRadialGradient(2, 2, 0, 2, 2, NaN)],
  ]
  for (const [name, make] of gradients) {
    const ctx = createCanvas(4, 4).getContext('2d')
    ctx.fillStyle = '#336699'
    ctx.fillRect(0, 0, 4, 4)
    const before = all(ctx, 4, 4)
    const gradient = make(ctx)
    gradient.addColorStop(0, 'red')
    gradient.addColorStop(1, 'lime')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 4, 4)
    ctx.strokeStyle = gradient
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, 2, 2)
    t.deepEqual(all(ctx, 4, 4), before, name)
  }
})

test('gradient method lengths match Chrome', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d')
  t.deepEqual(
    [
      ctx.createLinearGradient.length,
      ctx.createRadialGradient.length,
      ctx.createConicGradient.length,
      lin().addColorStop.length,
    ],
    [4, 6, 3, 2],
  )
})

test('arguments convert in order and the first failure throws', (t) => {
  const log: string[] = []
  const g = lin()
  const v = (name: string, value: unknown) => ({
    valueOf: () => (log.push(name), value),
    toString: () => (log.push(name), value),
  })
  t.throws(() => g.addColorStop(v('off', 2) as unknown as number, v('col', 'red') as unknown as string))
  t.throws(() => g.addColorStop(v('off', NaN) as unknown as number, v('col', 'red') as unknown as string))
  const ctx = createCanvas(1, 1).getContext('2d')
  t.throws(() =>
    ctx.createLinearGradient(v('a', 0) as never, v('b', NaN) as never, v('c', 0) as never, v('d', 0) as never),
  )
  t.throws(() =>
    ctx.createRadialGradient(
      ...(['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => v(n, i === 5 ? -1 : 0)) as never as [0, 0, 0, 0, 0, 0]),
    ),
  )
  t.deepEqual(log, ['off', 'col', 'off', 'a', 'b', 'a', 'b', 'c', 'd', 'e', 'f'])
})

// ToPrimitive TypeErrors get the Blink method prefix; errors thrown by user code pass through.
const TO_PRIMITIVE_OFFSET: Record<string, [unknown, string]> = {
  num5: [
    { [Symbol.toPrimitive]: 5 },
    "TypeError: Failed to execute 'addColorStop' on 'CanvasGradient': '5' returned for property 'Symbol(Symbol.toPrimitive)' of object '#<Object>' is not a function",
  ],
  str: [
    { [Symbol.toPrimitive]: 'x' },
    "TypeError: Failed to execute 'addColorStop' on 'CanvasGradient': 'x' returned for property 'Symbol(Symbol.toPrimitive)' of object '#<Object>' is not a function",
  ],
  obj: [
    { [Symbol.toPrimitive]: {} },
    "TypeError: Failed to execute 'addColorStop' on 'CanvasGradient': '#<Object>' returned for property 'Symbol(Symbol.toPrimitive)' of object '#<Object>' is not a function",
  ],
  nul: [
    { [Symbol.toPrimitive]: null },
    "TypeError: Failed to execute 'addColorStop' on 'CanvasGradient': The provided double value is non-finite.",
  ],
  retObj: [
    { [Symbol.toPrimitive]: () => ({}) },
    "TypeError: Failed to execute 'addColorStop' on 'CanvasGradient': Cannot convert object to primitive value",
  ],
  retSym: [
    { valueOf: () => Symbol() },
    "TypeError: Failed to execute 'addColorStop' on 'CanvasGradient': Cannot convert a Symbol value to a number",
  ],
  fn: [
    function () {},
    "TypeError: Failed to execute 'addColorStop' on 'CanvasGradient': The provided double value is non-finite.",
  ],
  noProto: [
    Object.create(null),
    "TypeError: Failed to execute 'addColorStop' on 'CanvasGradient': Cannot convert object to primitive value",
  ],
  symbol: [
    Symbol(),
    "TypeError: Failed to execute 'addColorStop' on 'CanvasGradient': Cannot convert a Symbol value to a number",
  ],
  bigint: [
    1n,
    "TypeError: Failed to execute 'addColorStop' on 'CanvasGradient': Cannot convert a BigInt value to a number",
  ],
}

for (const [name, [offset, expected]] of Object.entries(TO_PRIMITIVE_OFFSET)) {
  test(`addColorStop offset conversion error: ${name}`, (t) => {
    const error = t.throws(() => lin().addColorStop(offset as number, 'red'))!
    t.is(`${error.name}: ${error.message}`, expected)
  })
}

const TO_PRIMITIVE_COLOR: Record<string, [unknown, string]> = {
  num5: [
    { [Symbol.toPrimitive]: 5 },
    "TypeError: Failed to execute 'addColorStop' on 'CanvasGradient': '5' returned for property 'Symbol(Symbol.toPrimitive)' of object '#<Object>' is not a function",
  ],
  nul: [
    { [Symbol.toPrimitive]: null },
    "SyntaxError: Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('[object Object]') could not be parsed as a color.",
  ],
  retObj: [
    { [Symbol.toPrimitive]: () => ({}) },
    "TypeError: Failed to execute 'addColorStop' on 'CanvasGradient': Cannot convert object to primitive value",
  ],
  noProto: [
    Object.create(null),
    "TypeError: Failed to execute 'addColorStop' on 'CanvasGradient': Cannot convert object to primitive value",
  ],
  retSym: [
    { toString: () => Symbol() },
    "TypeError: Failed to execute 'addColorStop' on 'CanvasGradient': Cannot convert a Symbol value to a string",
  ],
}

for (const [name, [color, expected]] of Object.entries(TO_PRIMITIVE_COLOR)) {
  test(`addColorStop color conversion error: ${name}`, (t) => {
    const error = t.throws(() => lin().addColorStop(0, color as string))!
    t.is(`${error.name}: ${error.message}`, expected)
  })
}

test('factory conversion errors carry the factory prefix', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d')
  t.is(
    t.throws(() => ctx.createLinearGradient(Symbol() as never, 0, 0, 0))!.message,
    "Failed to execute 'createLinearGradient' on 'CanvasRenderingContext2D': Cannot convert a Symbol value to a number",
  )
  t.is(
    t.throws(() => ctx.createConicGradient({ [Symbol.toPrimitive]: 5 } as never, 0, 0))!.message,
    "Failed to execute 'createConicGradient' on 'CanvasRenderingContext2D': '5' returned for property 'Symbol(Symbol.toPrimitive)' of object '#<Object>' is not a function",
  )
})

test('an error thrown by valueOf or toString passes through unchanged', (t) => {
  const marker = new RangeError('mine')
  const ctx = createCanvas(1, 1).getContext('2d')
  t.is(
    t.throws(() =>
      lin().addColorStop(
        {
          valueOf: () => {
            throw marker
          },
        } as never,
        'red',
      ),
    ),
    marker,
  )
  t.is(
    t.throws(() =>
      lin().addColorStop(0, {
        toString: () => {
          throw marker
        },
      } as never),
    ),
    marker,
  )
  t.is(
    t.throws(() =>
      ctx.createRadialGradient(
        0,
        0,
        {
          valueOf: () => {
            throw marker
          },
        } as never,
        0,
        0,
        1,
      ),
    ),
    marker,
  )
})

// A stop that throws is not stored.
for (const [name, args] of Object.entries({
  range: [-0.1, 'rgb(255, 0, 0)'],
  nan: [NaN, 'rgb(255, 0, 0)'],
  color: [0.5, 'notacolor'],
  empty: [0.5, ''],
})) {
  test(`a rejected stop (${name}) leaves the gradient unchanged`, (t) => {
    const ctx = createCanvas(4, 1).getContext('2d')
    const g = ctx.createLinearGradient(0, 0, 4, 0)
    g.addColorStop(0, 'rgb(0, 0, 255)')
    g.addColorStop(1, 'rgb(0, 0, 255)')
    t.throws(() => g.addColorStop(...(args as [number, string])))
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 4, 1)
    t.deepEqual(all(ctx, 4, 1), rgba(['0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255']))
  })
}

// 'currentcolor' (any case, HTML spaces around it) is opaque black in a gradient stop.
test('currentcolor stops paint opaque black', (t) => {
  for (const color of ['currentcolor', 'currentColor', 'CURRENTCOLOR', '\t currentcolor\n']) {
    const ctx = createCanvas(2, 1).getContext('2d')
    ctx.fillStyle = 'rgb(0, 128, 0)'
    ctx.fillRect(0, 0, 2, 1)
    const g = ctx.createLinearGradient(0, 0, 2, 0)
    g.addColorStop(0, color)
    g.addColorStop(1, color)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 2, 1)
    t.deepEqual(all(ctx, 2, 1), rgba(['0,0,0,255 0,0,0,255']), color)
  }
})

test('currentcolor to white blends from black', (t) => {
  const ctx = createCanvas(8, 1).getContext('2d')
  const g = ctx.createLinearGradient(0, 0, 8, 0)
  g.addColorStop(0, 'currentcolor')
  g.addColorStop(1, 'rgb(255, 255, 255)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 8, 1)
  t.deepEqual(
    all(ctx, 8, 1),
    rgba([
      '15,15,15,255 48,48,48,255 79,79,79,255 112,112,112,255 143,143,143,255 176,176,176,255 207,207,207,255 240,240,240,255',
    ]),
  )
})

// ParseCanvasColorString (canvas_style.cc): HTML spaces are stripped, a named color must be the
// whole string, and anything else must be one CSS color with nothing after it. Both stops get the
// color; a 1x1 fill then shows it.
const STOP_COLOR_SYNTAX: [string, 'SyntaxError' | number[]][] = [
  ['red /* x */', 'SyntaxError'],
  ['/**/red', 'SyntaxError'],
  ['red/**/', 'SyntaxError'],
  ['#f00 /* x */', [255, 0, 0, 255]],
  ['rgb(255,0,0)/**/', [255, 0, 0, 255]],
  ['/**/rgb(255,0,0)', [255, 0, 0, 255]],
  ['r\\65 d', 'SyntaxError'],
  ['r\\65 d ', 'SyntaxError'],
  ['transparent /**/', 'SyntaxError'],
  ['currentcolor /**/', 'SyntaxError'],
  ['currentcolor;', 'SyntaxError'],
  ['\tcurrentcolor\n', [0, 0, 0, 255]],
  [' red', 'SyntaxError'],
  ['red ', 'SyntaxError'],
  ['\u000bred', 'SyntaxError'],
  ['rgb(255 0 0) blue', 'SyntaxError'],
  ['rgb(255,0,0) ,', 'SyntaxError'],
  ['hsl(0 100% 50%) x', 'SyntaxError'],
  ['#ff0000 #00ff00', 'SyntaxError'],
  ['RED', [255, 0, 0, 255]],
  ['Red', [255, 0, 0, 255]],
  ['currentColor', [0, 0, 0, 255]],
  ['CURRENTCOLOR', [0, 0, 0, 255]],
  ['rgb(255,0,0', [255, 0, 0, 255]],
  ['hsl(0,100%,50%', [255, 0, 0, 255]],
  ['rgba(255,0,0,0.5) ', [255, 0, 0, 128]],
  ['inherit', 'SyntaxError'],
  ['revert', 'SyntaxError'],
  ['none', 'SyntaxError'],
  ['-webkit-link', 'SyntaxError'],
  ['red!', 'SyntaxError'],
  ['transparent', [0, 0, 0, 0]],
]

for (const [color, expected] of STOP_COLOR_SYNTAX) {
  test(`addColorStop color syntax: ${JSON.stringify(color)}`, (t) => {
    const ctx = createCanvas(1, 1).getContext('2d')
    const g = ctx.createLinearGradient(0, 0, 1, 0)
    if (expected === 'SyntaxError') {
      const error = t.throws(() => g.addColorStop(0, color)) as DOMException
      t.is(error.name, 'SyntaxError')
      return
    }
    g.addColorStop(0, color)
    g.addColorStop(1, color)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 1, 1)
    t.deepEqual(all(ctx, 1, 1), expected)
  })
}

const STOP_COLOR_ACCEPTED: [string, boolean][] = [
  ['url(x)', false],
  ['var(--x)', false],
  ['#ff', false],
  ['#ggg', false],
  ['rgb(255,0,0,)', false],
  ['rgb(100%, 0, 0)', false],
  ['rgb(100%, 0%, 0%)', true],
  ['#f00f', true],
  ['#ff0000ff', true],
  ['#FFF', true],
  ['RGB(255,0,0)', true],
  ['rgba(255,0,0,.5)', true],
  ['rgb(255 0 0 / 50%)', true],
]

for (const [color, accepted] of STOP_COLOR_ACCEPTED) {
  test(`addColorStop accepts ${JSON.stringify(color)}: ${accepted}`, (t) => {
    const g = lin()
    if (accepted) {
      t.notThrows(() => g.addColorStop(0, color))
    } else {
      t.is((t.throws(() => g.addColorStop(0, color)) as DOMException).name, 'SyntaxError')
    }
  })
}

// As a Blink binding error: the stack keeps the bare message, and `message`, with the method prefix,
// is an own enumerable property.
test('gradient binding errors keep the bare message in their stack', (t) => {
  const ctx = createCanvas(4, 4).getContext('2d')
  const g = ctx.createLinearGradient(0, 0, 4, 0)
  const cases: [() => unknown, string][] = [
    [() => (g.addColorStop as (...a: unknown[]) => void)(0), 'TypeError: 2 arguments required, but only 1 present.'],
    [() => g.addColorStop(NaN, 'red'), 'TypeError: The provided double value is non-finite.'],
    [() => g.addColorStop(Symbol() as never, 'red'), 'TypeError: Cannot convert a Symbol value to a number'],
    [() => g.addColorStop(0, Symbol() as never), 'TypeError: Cannot convert a Symbol value to a string'],
    [() => g.addColorStop(Object.create(null), 'red'), 'TypeError: Cannot convert object to primitive value'],
    [
      () => (ctx.createLinearGradient as (...a: unknown[]) => unknown)(0, 0, 0),
      'TypeError: 4 arguments required, but only 3 present.',
    ],
    [() => ctx.createLinearGradient(0, 0, 0, 'NaN' as never), 'TypeError: The provided double value is non-finite.'],
    [
      () => (ctx.createConicGradient as (...a: unknown[]) => unknown)(0),
      'TypeError: 3 arguments required, but only 1 present.',
    ],
    [() => ctx.createConicGradient(Symbol() as never, 0, 0), 'TypeError: Cannot convert a Symbol value to a number'],
  ]
  for (const [run, stack] of cases) {
    const error = t.throws(run) as Error
    t.is(String(error.stack).split('\n')[0], stack)
    t.deepEqual(Object.keys(error), ['message'])
  }
})
