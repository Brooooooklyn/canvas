// DOMMatrixInit dictionaries in DOMMatrix.fromMatrix, multiply,
// multiplySelf, preMultiplySelf and DOMPoint.matrixTransform. Expected values
// were measured in Chrome 155 (arm64 = x64). Before, fromMatrix and
// matrixTransform threw "ReferenceError: SVGMatrix is not defined" for
// anything but a DOMMatrix, and the multiply family read other[values].
import test from 'ava'

import { createCanvas, DOMMatrix, DOMPoint } from '../index'

// Untyped: most calls below pass values the typings reject on purpose.
const DM: any = DOMMatrix
const DP: any = DOMPoint

// -0 reads as 0, as in the Chrome probe output.
const num = (v: number) => (v === 0 ? 0 : v)
const mat = (m: number[], is2D: boolean) => ({ m, is2D })
const pt = (p: number[]) => ({ p })
const err = (name: string, msg: string) => ({ name, msg })

const run = (fn: () => unknown) => {
  try {
    const r: any = fn()
    if (r instanceof DOMMatrix) {
      const { m11, m12, m13, m14, m21, m22, m23, m24, m31, m32, m33, m34, m41, m42, m43, m44 } = r
      return mat([m11, m12, m13, m14, m21, m22, m23, m24, m31, m32, m33, m34, m41, m42, m43, m44].map(num), r.is2D)
    }
    if (r instanceof DOMPoint) return pt([r.x, r.y, r.z, r.w].map(num))
    return r
  } catch (e: any) {
    return err(e?.name, String(e?.message))
  }
}

const check = (t: any, rows: [string, () => unknown, unknown][]) => {
  for (const [label, fn, expected] of rows) t.deepEqual(run(fn), expected, label)
}

test('fromMatrix accepts DOMMatrixInit dictionaries', (t) => {
  check(t, [
    ['fromMatrix/empty', () => DM.fromMatrix({}), mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true)],
    [
      'fromMatrix/a2d3',
      () => DM.fromMatrix({ a: 2, d: 3 }),
      mat([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true),
    ],
    [
      'fromMatrix/m11only',
      () => DM.fromMatrix({ m11: 2 }),
      mat([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true),
    ],
    [
      'fromMatrix/e5f6',
      () => DM.fromMatrix({ e: 5, f: 6 }),
      mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1], true),
    ],
    ['fromMatrix/m41', () => DM.fromMatrix({ m41: 7 }), mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 0, 0, 1], true)],
    ['fromMatrix/m33', () => DM.fromMatrix({ m33: 2 }), mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1], false)],
    [
      'fromMatrix/m13',
      () => DM.fromMatrix({ m13: 0.5 }),
      mat([1, 0, 0.5, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], false),
    ],
    [
      'fromMatrix/is2Dtrue',
      () => DM.fromMatrix({ is2D: true, a: 2 }),
      mat([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true),
    ],
    [
      'fromMatrix/is2Dfalse',
      () => DM.fromMatrix({ is2D: false, a: 2 }),
      mat([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], false),
    ],
    [
      'fromMatrix/is2DtrueM34zero',
      () => DM.fromMatrix({ is2D: true, m34: 0, m44: 1 }),
      mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true),
    ],
    [
      'fromMatrix/is2DtrueM13negzero',
      () => DM.fromMatrix({ is2D: true, m13: -0 }),
      mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true),
    ],
    [
      'fromMatrix/m33NegZero',
      () => DM.fromMatrix({ m33: 1, m44: 1, m13: -0 }),
      mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true),
    ],
    [
      'fromMatrix/matchA',
      () => DM.fromMatrix({ a: 2, m11: 2 }),
      mat([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true),
    ],
    [
      'fromMatrix/mismatchNaN',
      () => DM.fromMatrix({ a: NaN, m11: NaN }),
      mat([NaN, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true),
    ],
    [
      'fromMatrix/zeroNegZero',
      () => DM.fromMatrix({ b: 0, m12: -0 }),
      mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true),
    ],
    ['fromMatrix/nanA', () => DM.fromMatrix({ a: NaN }), mat([NaN, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true)],
    [
      'fromMatrix/infE',
      () => DM.fromMatrix({ e: Infinity }),
      mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, Infinity, 0, 0, 1], true),
    ],
    ['fromMatrix/strA', () => DM.fromMatrix({ a: '3' }), mat([3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true)],
    [
      'fromMatrix/objValueOf',
      () =>
        DM.fromMatrix({
          a: {
            valueOf() {
              return 4
            },
          },
        }),
      mat([4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true),
    ],
    [
      'fromMatrix/symbolIs2D',
      () => DM.fromMatrix({ is2D: Symbol() }),
      mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true),
    ],
    [
      'fromMatrix/dommatrix3d',
      () => DM.fromMatrix(new DM([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])),
      mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1], false),
    ],
    [
      'fromMatrix/dommatrix2d',
      () => DM.fromMatrix(new DM([2, 0, 0, 2, 1, 1])),
      mat([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1], true),
    ],
    [
      'fromMatrix/is2D-of-3d-dommatrix',
      () => DM.fromMatrix(new DM([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])).is2D,
      false,
    ],
    ['fromMatrix/is2D-of-3d-dict', () => DM.fromMatrix({ m13: 0 }).is2D, true],
    ['fromMatrix/is2D-of-m33-1', () => DM.fromMatrix({ m33: 1 }).is2D, true],
    [
      'fromMatrix/returnsNew',
      () =>
        (() => {
          const m = new DM([1, 2, 3, 4, 5, 6])
          return DM.fromMatrix(m) !== m
        })(),
      true,
    ],
    ['fromMatrix/instanceof', () => DM.fromMatrix({ a: 2 }) instanceof DM, true],
  ])
})

test('fromMatrix returns a plain DOMMatrix', (t) => {
  // No own enumerable properties, as in Chrome.
  t.deepEqual(Object.keys(DM.fromMatrix(new DM([1, 2, 3, 4, 5, 6]))), [])
  t.deepEqual(Object.keys(DM.fromMatrix({ a: 2 })), [])
})

test('fromMatrix validates and fixes up', (t) => {
  check(t, [
    [
      'fromMatrix/is2DtrueM33',
      () => DM.fromMatrix({ is2D: true, m33: 2 }),
      err(
        'TypeError',
        "Failed to execute 'fromMatrix' on 'DOMMatrix': The is2D member is set to true but the input matrix is a 3d matrix.",
      ),
    ],
    [
      'fromMatrix/is2DtrueM44',
      () => DM.fromMatrix({ is2D: true, m44: 3 }),
      err(
        'TypeError',
        "Failed to execute 'fromMatrix' on 'DOMMatrix': The is2D member is set to true but the input matrix is a 3d matrix.",
      ),
    ],
    [
      'fromMatrix/mismatchA',
      () => DM.fromMatrix({ a: 1, m11: 2 }),
      err('TypeError', "Failed to execute 'fromMatrix' on 'DOMMatrix': Property mismatch on matrix initialization."),
    ],
    [
      'fromMatrix/mismatchF',
      () => DM.fromMatrix({ f: 1, m42: 2 }),
      err('TypeError', "Failed to execute 'fromMatrix' on 'DOMMatrix': Property mismatch on matrix initialization."),
    ],
  ])
})

test('fromMatrix rejects non-objects', (t) => {
  // undefined and null are {}; arrays and functions are objects.
  check(t, [
    ['fromMatrix/noarg', () => DM.fromMatrix(), mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true)],
    ['fromMatrix/nullInit', () => DM.fromMatrix(null), mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true)],
    ['fromMatrix/undef', () => DM.fromMatrix(undefined), mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true)],
    [
      'fromMatrix/arr',
      () => DM.fromMatrix([2, 0, 0, 2, 0, 0]),
      mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true),
    ],
    ['fromMatrix/fn', () => DM.fromMatrix(() => {}), mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true)],
    [
      'fromMatrix/domPointLike',
      () => DM.fromMatrix({ x: 1, y: 2 }),
      mat([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true),
    ],
    [
      'fromMatrix/num',
      () => DM.fromMatrix(5),
      err(
        'TypeError',
        "Failed to execute 'fromMatrix' on 'DOMMatrix': The provided value is not of type 'DOMMatrixInit'.",
      ),
    ],
    [
      'fromMatrix/str',
      () => DM.fromMatrix('matrix(1,0,0,1,0,0)'),
      err(
        'TypeError',
        "Failed to execute 'fromMatrix' on 'DOMMatrix': The provided value is not of type 'DOMMatrixInit'.",
      ),
    ],
    [
      'fromMatrix/bool',
      () => DM.fromMatrix(true),
      err(
        'TypeError',
        "Failed to execute 'fromMatrix' on 'DOMMatrix': The provided value is not of type 'DOMMatrixInit'.",
      ),
    ],
  ])
})

test('fromMatrix reads members in WebIDL order', (t) => {
  // Conversion errors get Chrome's context; what user code throws does not.
  check(t, [
    [
      'fromMatrix/bigintA',
      () => DM.fromMatrix({ a: 1n }),
      err(
        'TypeError',
        "Failed to execute 'fromMatrix' on 'DOMMatrix': Failed to read the 'a' property from 'DOMMatrix2DInit': Cannot convert a BigInt value to a number",
      ),
    ],
    [
      'fromMatrix/bigintM13',
      () => DM.fromMatrix({ m13: 2n }),
      err(
        'TypeError',
        "Failed to execute 'fromMatrix' on 'DOMMatrix': Failed to read the 'm13' property from 'DOMMatrixInit': Cannot convert a BigInt value to a number",
      ),
    ],
    [
      'fromMatrix/symbolM13',
      () => DM.fromMatrix({ m13: Symbol() }),
      err(
        'TypeError',
        "Failed to execute 'fromMatrix' on 'DOMMatrix': Failed to read the 'm13' property from 'DOMMatrixInit': Cannot convert a Symbol value to a number",
      ),
    ],
    [
      'fromMatrix/valueOfBigint',
      () =>
        DM.fromMatrix({
          a: {
            valueOf() {
              return 1n
            },
          },
        }),
      err(
        'TypeError',
        "Failed to execute 'fromMatrix' on 'DOMMatrix': Failed to read the 'a' property from 'DOMMatrix2DInit': Cannot convert a BigInt value to a number",
      ),
    ],
    [
      'fromMatrix/valueOfThrowsType',
      () =>
        DM.fromMatrix({
          a: {
            valueOf() {
              throw new TypeError('vo')
            },
          },
        }),
      err('TypeError', 'vo'),
    ],
    [
      'fromMatrix/getterThrowsRange',
      () =>
        DM.fromMatrix({
          get a() {
            throw new RangeError('boom')
          },
        }),
      err('RangeError', 'boom'),
    ],
    [
      'fromMatrix/getterThrowsType',
      () =>
        DM.fromMatrix({
          get m22() {
            throw new TypeError('gt')
          },
        }),
      err('TypeError', 'gt'),
    ],
    [
      'fromMatrix/getterOrder',
      () =>
        (() => {
          const log: string[] = []
          const o: any = {}
          for (const k of [
            'a',
            'b',
            'c',
            'd',
            'e',
            'f',
            'm11',
            'm12',
            'm13',
            'm14',
            'm21',
            'm22',
            'm23',
            'm24',
            'm31',
            'm32',
            'm33',
            'm34',
            'm41',
            'm42',
            'm43',
            'm44',
            'is2D',
          ])
            Object.defineProperty(o, k, {
              get() {
                log.push(k)
                return undefined
              },
            })
          DM.fromMatrix(o)
          return log.join(',')
        })(),
      'a,b,c,d,e,f,m11,m12,m21,m22,m41,m42,is2D,m13,m14,m23,m24,m31,m32,m33,m34,m43,m44',
    ],
    [
      'fromMatrix/valueOfOrder',
      () =>
        (() => {
          const log: string[] = []
          const v = (k: string, n: number) => ({
            valueOf() {
              log.push(k)
              return n
            },
          })
          DM.fromMatrix({ m44: v('m44', 1), a: v('a', 1), m11: v('m11', 1) })
          return log.join(',')
        })(),
      'a,m11,m44',
    ],
  ])
  const ex = (fn: () => unknown) => {
    try {
      return (fn() as any).a
    } catch (e: any) {
      return `${e.name}: ${e.message}`
    }
  }
  const READ_A =
    "TypeError: Failed to execute 'fromMatrix' on 'DOMMatrix': Failed to read the 'a' property from 'DOMMatrix2DInit': "
  t.is(
    ex(() => DM.fromMatrix({ a: { valueOf: null, toString: null } })),
    READ_A + 'Cannot convert object to primitive value',
  )
  t.is(
    ex(() => DM.fromMatrix({ a: { [Symbol.toPrimitive]: 5 } })),
    READ_A + "'5' returned for property 'Symbol(Symbol.toPrimitive)' of object '#<Object>' is not a function",
  )
  t.is(
    ex(() => DM.fromMatrix({ a: { [Symbol.toPrimitive]: () => ({}) } })),
    READ_A + 'Cannot convert object to primitive value',
  )
  t.is(
    ex(() => DM.fromMatrix({ a: { [Symbol.toPrimitive]: () => Symbol() } })),
    READ_A + 'Cannot convert a Symbol value to a number',
  )
  let hint
  DM.fromMatrix({
    a: {
      [Symbol.toPrimitive](h: string) {
        hint = h
        return 2
      },
    },
  })
  t.is(hint, 'number')
  t.is(
    ex(() => DM.fromMatrix({ a: { valueOf: null, toString: () => '7' } })),
    7,
  )
  t.is(
    ex(() =>
      DM.fromMatrix({
        a: {
          valueOf() {
            throw new TypeError('Cannot convert a BigInt value to a number')
          },
        },
      }),
    ),
    'TypeError: Cannot convert a BigInt value to a number',
  )
})

test('multiply family accepts dictionaries', (t) => {
  check(t, [
    [
      'multiply/empty',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply({}),
      mat([1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1], true),
    ],
    [
      'multiply/a2d3',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply({ a: 2, d: 3 }),
      mat([2, 4, 0, 0, 9, 12, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1], true),
    ],
    [
      'multiply/m11only',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply({ m11: 2 }),
      mat([2, 4, 0, 0, 3, 4, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1], true),
    ],
    [
      'multiply/e5f6',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply({ e: 5, f: 6 }),
      mat([1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 1, 0, 28, 40, 0, 1], true),
    ],
    [
      'multiply/m33',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply({ m33: 2 }),
      mat([1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 2, 0, 5, 6, 0, 1], false),
    ],
    [
      'multiply/m13',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply({ m13: 0.5 }),
      mat([1, 2, 0.5, 0, 3, 4, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1], false),
    ],
    [
      'multiply/is2Dtrue',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply({ is2D: true, a: 2 }),
      mat([2, 4, 0, 0, 3, 4, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1], true),
    ],
    [
      'multiply/is2Dfalse',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply({ is2D: false, a: 2 }),
      mat([2, 4, 0, 0, 3, 4, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1], false),
    ],
    [
      'multiply/noarg',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply(),
      mat([1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1], true),
    ],
    [
      'multiply/nullInit',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply(null),
      mat([1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1], true),
    ],
    [
      'multiply/strA',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply({ a: '3' }),
      mat([3, 6, 0, 0, 3, 4, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1], true),
    ],
    [
      'multiply/dommatrix2d',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply(new DM([2, 0, 0, 2, 1, 1])),
      mat([2, 4, 0, 0, 6, 8, 0, 0, 0, 0, 1, 0, 9, 12, 0, 1], true),
    ],
    [
      'multiply/dommatrix3d',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply(new DM([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])),
      mat([1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 2, 0, 5, 6, 0, 1], false),
    ],
    [
      'multiply/is2DtrueM33',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply({ is2D: true, m33: 2 }),
      err(
        'TypeError',
        "Failed to execute 'multiply' on 'DOMMatrixReadOnly': The is2D member is set to true but the input matrix is a 3d matrix.",
      ),
    ],
    [
      'multiply/mismatchA',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply({ a: 1, m11: 2 }),
      err(
        'TypeError',
        "Failed to execute 'multiply' on 'DOMMatrixReadOnly': Property mismatch on matrix initialization.",
      ),
    ],
    [
      'multiply/num',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply(5),
      err(
        'TypeError',
        "Failed to execute 'multiply' on 'DOMMatrixReadOnly': The provided value is not of type 'DOMMatrixInit'.",
      ),
    ],
    [
      'multiply/bigintA',
      () => new DM([1, 2, 3, 4, 5, 6]).multiply({ a: 1n }),
      err(
        'TypeError',
        "Failed to execute 'multiply' on 'DOMMatrixReadOnly': Failed to read the 'a' property from 'DOMMatrix2DInit': Cannot convert a BigInt value to a number",
      ),
    ],
    [
      'multiply/valueOfThrowsType',
      () =>
        new DM([1, 2, 3, 4, 5, 6]).multiply({
          a: {
            valueOf() {
              throw new TypeError('vo')
            },
          },
        }),
      err('TypeError', 'vo'),
    ],
    [
      'multiply/getterThrowsRange',
      () =>
        new DM([1, 2, 3, 4, 5, 6]).multiply({
          get a() {
            throw new RangeError('boom')
          },
        }),
      err('RangeError', 'boom'),
    ],
    [
      'multiply/returnsNew',
      () =>
        (() => {
          const m = new DM([1, 2, 3, 4, 5, 6])
          const r = m.multiply({ a: 2 })
          return [r !== m, m.a]
        })(),
      [true, 1],
    ],
    [
      'multiply/is2D-of-3d-this',
      () =>
        (() => {
          const m = new DM([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])
          return m.multiply(new DM()).is2D
        })(),
      false,
    ],
    [
      'multiply/is2D-of-3d-this-dict',
      () =>
        (() => {
          const m = new DM([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])
          return m.multiply({ a: 2 }).is2D
        })(),
      false,
    ],
    [
      'multiply/getterOrder',
      () =>
        (() => {
          const log: string[] = []
          const o: any = {}
          for (const k of ['m44', 'is2D', 'a', 'm11', 'f', 'm13'])
            Object.defineProperty(o, k, {
              get() {
                log.push(k)
                return undefined
              },
            })
          new DM().multiply(o)
          return log.join(',')
        })(),
      'a,f,m11,is2D,m13,m44',
    ],
    [
      'multiplySelf/a2d3',
      () => new DM([1, 2, 3, 4, 5, 6]).multiplySelf({ a: 2, d: 3 }),
      mat([2, 4, 0, 0, 9, 12, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1], true),
    ],
    [
      'multiplySelf/e5f6',
      () => new DM([1, 2, 3, 4, 5, 6]).multiplySelf({ e: 5, f: 6 }),
      mat([1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 1, 0, 28, 40, 0, 1], true),
    ],
    [
      'multiplySelf/m13',
      () => new DM([1, 2, 3, 4, 5, 6]).multiplySelf({ m13: 0.5 }),
      mat([1, 2, 0.5, 0, 3, 4, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1], false),
    ],
    [
      'multiplySelf/noarg',
      () => new DM([1, 2, 3, 4, 5, 6]).multiplySelf(),
      mat([1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1], true),
    ],
    [
      'multiplySelf/dommatrix2d',
      () => new DM([1, 2, 3, 4, 5, 6]).multiplySelf(new DM([2, 0, 0, 2, 1, 1])),
      mat([2, 4, 0, 0, 6, 8, 0, 0, 0, 0, 1, 0, 9, 12, 0, 1], true),
    ],
    [
      'multiplySelf/is2DtrueM44',
      () => new DM([1, 2, 3, 4, 5, 6]).multiplySelf({ is2D: true, m44: 3 }),
      err(
        'TypeError',
        "Failed to execute 'multiplySelf' on 'DOMMatrix': The is2D member is set to true but the input matrix is a 3d matrix.",
      ),
    ],
    [
      'multiplySelf/mismatchA',
      () => new DM([1, 2, 3, 4, 5, 6]).multiplySelf({ a: 1, m11: 2 }),
      err('TypeError', "Failed to execute 'multiplySelf' on 'DOMMatrix': Property mismatch on matrix initialization."),
    ],
    [
      'multiplySelf/num',
      () => new DM([1, 2, 3, 4, 5, 6]).multiplySelf(5),
      err(
        'TypeError',
        "Failed to execute 'multiplySelf' on 'DOMMatrix': The provided value is not of type 'DOMMatrixInit'.",
      ),
    ],
    [
      'multiplySelf/bigintM13',
      () => new DM([1, 2, 3, 4, 5, 6]).multiplySelf({ m13: 2n }),
      err(
        'TypeError',
        "Failed to execute 'multiplySelf' on 'DOMMatrix': Failed to read the 'm13' property from 'DOMMatrixInit': Cannot convert a BigInt value to a number",
      ),
    ],
    [
      'multiplySelf/returnsThis',
      () =>
        (() => {
          const m = new DM([1, 2, 3, 4, 5, 6])
          return m.multiplySelf({ a: 2 }) === m
        })(),
      true,
    ],
    [
      'multiplySelf/is2D-after-3d',
      () =>
        (() => {
          const m = new DM([1, 2, 3, 4, 5, 6])
          m.multiplySelf({ m33: 2 })
          return m.is2D
        })(),
      false,
    ],
    [
      'preMultiplySelf/a2d3',
      () => new DM([1, 2, 3, 4, 5, 6]).preMultiplySelf({ a: 2, d: 3 }),
      mat([2, 6, 0, 0, 6, 12, 0, 0, 0, 0, 1, 0, 10, 18, 0, 1], true),
    ],
    [
      'preMultiplySelf/e5f6',
      () => new DM([1, 2, 3, 4, 5, 6]).preMultiplySelf({ e: 5, f: 6 }),
      mat([1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 1, 0, 10, 12, 0, 1], true),
    ],
    [
      'preMultiplySelf/m13',
      () => new DM([1, 2, 3, 4, 5, 6]).preMultiplySelf({ m13: 0.5 }),
      mat([1, 2, 0.5, 0, 3, 4, 1.5, 0, 0, 0, 1, 0, 5, 6, 2.5, 1], false),
    ],
    [
      'preMultiplySelf/is2Dtrue',
      () => new DM([1, 2, 3, 4, 5, 6]).preMultiplySelf({ is2D: true, a: 2 }),
      mat([2, 2, 0, 0, 6, 4, 0, 0, 0, 0, 1, 0, 10, 6, 0, 1], true),
    ],
    [
      'preMultiplySelf/strA',
      () => new DM([1, 2, 3, 4, 5, 6]).preMultiplySelf({ a: '3' }),
      mat([3, 2, 0, 0, 9, 4, 0, 0, 0, 0, 1, 0, 15, 6, 0, 1], true),
    ],
    [
      'preMultiplySelf/noarg',
      () => new DM([1, 2, 3, 4, 5, 6]).preMultiplySelf(),
      mat([1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1], true),
    ],
    [
      'preMultiplySelf/dommatrix2d',
      () => new DM([1, 2, 3, 4, 5, 6]).preMultiplySelf(new DM([2, 0, 0, 2, 1, 1])),
      mat([2, 4, 0, 0, 6, 8, 0, 0, 0, 0, 1, 0, 11, 13, 0, 1], true),
    ],
    [
      'preMultiplySelf/dommatrix3d',
      () => new DM([1, 2, 3, 4, 5, 6]).preMultiplySelf(new DM([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])),
      mat([1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 2, 0, 5, 6, 0, 1], false),
    ],
    [
      'preMultiplySelf/is2DtrueM44',
      () => new DM([1, 2, 3, 4, 5, 6]).preMultiplySelf({ is2D: true, m44: 3 }),
      err(
        'TypeError',
        "Failed to execute 'preMultiplySelf' on 'DOMMatrix': The is2D member is set to true but the input matrix is a 3d matrix.",
      ),
    ],
    [
      'preMultiplySelf/mismatchA',
      () => new DM([1, 2, 3, 4, 5, 6]).preMultiplySelf({ a: 1, m11: 2 }),
      err(
        'TypeError',
        "Failed to execute 'preMultiplySelf' on 'DOMMatrix': Property mismatch on matrix initialization.",
      ),
    ],
    [
      'preMultiplySelf/num',
      () => new DM([1, 2, 3, 4, 5, 6]).preMultiplySelf(5),
      err(
        'TypeError',
        "Failed to execute 'preMultiplySelf' on 'DOMMatrix': The provided value is not of type 'DOMMatrixInit'.",
      ),
    ],
    [
      'preMultiplySelf/symbolM13',
      () => new DM([1, 2, 3, 4, 5, 6]).preMultiplySelf({ m13: Symbol() }),
      err(
        'TypeError',
        "Failed to execute 'preMultiplySelf' on 'DOMMatrix': Failed to read the 'm13' property from 'DOMMatrixInit': Cannot convert a Symbol value to a number",
      ),
    ],
    [
      'preMultiplySelf/is2D-after-3d',
      () =>
        (() => {
          const m = new DM([1, 2, 3, 4, 5, 6])
          m.preMultiplySelf({ m33: 2 })
          return m.is2D
        })(),
      false,
    ],
  ])
})

test('DOMPoint.matrixTransform accepts dictionaries', (t) => {
  check(t, [
    ['matrixTransform/empty', () => new DP(1, 2).matrixTransform({}), pt([1, 2, 0, 1])],
    ['matrixTransform3d/empty', () => new DP(1, 2, 3, 1).matrixTransform({}), pt([1, 2, 3, 1])],
    ['matrixTransform/a2d3', () => new DP(1, 2).matrixTransform({ a: 2, d: 3 }), pt([2, 6, 0, 1])],
    ['matrixTransform3d/a2d3', () => new DP(1, 2, 3, 1).matrixTransform({ a: 2, d: 3 }), pt([2, 6, 3, 1])],
    ['matrixTransform/e5f6', () => new DP(1, 2).matrixTransform({ e: 5, f: 6 }), pt([6, 8, 0, 1])],
    ['matrixTransform/m33', () => new DP(1, 2).matrixTransform({ m33: 2 }), pt([1, 2, 0, 1])],
    ['matrixTransform3d/m33', () => new DP(1, 2, 3, 1).matrixTransform({ m33: 2 }), pt([1, 2, 6, 1])],
    ['matrixTransform/m13', () => new DP(1, 2).matrixTransform({ m13: 0.5 }), pt([1, 2, 0.5, 1])],
    ['matrixTransform3d/m13', () => new DP(1, 2, 3, 1).matrixTransform({ m13: 0.5 }), pt([1, 2, 3.5, 1])],
    ['matrixTransform/is2Dtrue', () => new DP(1, 2).matrixTransform({ is2D: true, a: 2 }), pt([2, 2, 0, 1])],
    ['matrixTransform/nanA', () => new DP(1, 2).matrixTransform({ a: NaN }), pt([NaN, 2, 0, 1])],
    ['matrixTransform3d/nanA', () => new DP(1, 2, 3, 1).matrixTransform({ a: NaN }), pt([NaN, 2, 3, 1])],
    ['matrixTransform/noarg', () => new DP(1, 2).matrixTransform(), pt([1, 2, 0, 1])],
    ['matrixTransform/nullInit', () => new DP(1, 2).matrixTransform(null), pt([1, 2, 0, 1])],
    ['matrixTransform/arr', () => new DP(1, 2).matrixTransform([2, 0, 0, 2, 0, 0]), pt([1, 2, 0, 1])],
    ['matrixTransform/dommatrix2d', () => new DP(1, 2).matrixTransform(new DM([2, 0, 0, 2, 1, 1])), pt([3, 5, 0, 1])],
    [
      'matrixTransform3d/dommatrix2d',
      () => new DP(1, 2, 3, 1).matrixTransform(new DM([2, 0, 0, 2, 1, 1])),
      pt([3, 5, 3, 1]),
    ],
    [
      'matrixTransform3d/dommatrix3d',
      () => new DP(1, 2, 3, 1).matrixTransform(new DM([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])),
      pt([1, 2, 6, 1]),
    ],
    [
      'matrixTransform/is2DtrueM44',
      () => new DP(1, 2).matrixTransform({ is2D: true, m44: 3 }),
      err(
        'TypeError',
        "Failed to execute 'matrixTransform' on 'DOMPointReadOnly': The is2D member is set to true but the input matrix is a 3d matrix.",
      ),
    ],
    [
      'matrixTransform/mismatchA',
      () => new DP(1, 2).matrixTransform({ a: 1, m11: 2 }),
      err(
        'TypeError',
        "Failed to execute 'matrixTransform' on 'DOMPointReadOnly': Property mismatch on matrix initialization.",
      ),
    ],
    [
      'matrixTransform/num',
      () => new DP(1, 2).matrixTransform(5),
      err(
        'TypeError',
        "Failed to execute 'matrixTransform' on 'DOMPointReadOnly': The provided value is not of type 'DOMMatrixInit'.",
      ),
    ],
    [
      'matrixTransform3d/bigintM13',
      () => new DP(1, 2, 3, 1).matrixTransform({ m13: 2n }),
      err(
        'TypeError',
        "Failed to execute 'matrixTransform' on 'DOMPointReadOnly': Failed to read the 'm13' property from 'DOMMatrixInit': Cannot convert a BigInt value to a number",
      ),
    ],
    [
      'matrixTransform/valueOfThrowsType',
      () =>
        new DP(1, 2).matrixTransform({
          a: {
            valueOf() {
              throw new TypeError('vo')
            },
          },
        }),
      err('TypeError', 'vo'),
    ],
    [
      'matrixTransform/getterOrder',
      () =>
        (() => {
          const log: string[] = []
          const o: any = {}
          for (const k of ['m44', 'is2D', 'a', 'm11', 'f', 'm13'])
            Object.defineProperty(o, k, {
              get() {
                log.push(k)
                return undefined
              },
            })
          new DP(1, 2).matrixTransform(o)
          return log.join(',')
        })(),
      'a,f,m11,is2D,m13,m44',
    ],
  ])
})

test('fromMatrix round-trips through the 2D context', (t) => {
  const ctx = createCanvas(4, 4).getContext('2d')
  ctx.setTransform(2, 0, 0, 3, 1, 1)
  t.deepEqual(
    run(() => DM.fromMatrix(ctx.getTransform())),
    mat([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1], true),
  )
  ctx.setTransform(DM.fromMatrix({ a: 2, d: 3, e: 1 }))
  const { a, b, c, d, e, f } = ctx.getTransform()
  t.deepEqual([a, b, c, d, e, f], [2, 0, 0, 3, 1, 0])
})
