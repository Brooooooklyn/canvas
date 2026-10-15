// setTransform() overloads (Blink canvas_2d_recorder_context.idl:28-29):
// six numbers, or `optional DOMMatrixInit transform = {}` read like
// DOMMatrixReadOnly::fromMatrix (dom_matrix_read_only.cc). Every expected
// value was measured in Chrome 155 CPU canvas (--disable-gpu,
// getContext('2d', { willReadFrequently: true })) in a standards-mode page;
// Chrome arm64 and x64 give the same values.
import test from 'ava'

import { createCanvas, DOMMatrix } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const PREFIX = "Failed to execute 'setTransform' on 'CanvasRenderingContext2D': "
const SCALE_2 = [2, 0, 0, 2, 0, 0]

/** The current matrix as [a, b, c, d, e, f] (-0 as 0). */
function matrix(ctx: Ctx) {
  const m = ctx.getTransform()
  return [m.a, m.b, m.c, m.d, m.e, m.f].map((v) => v + 0)
}

/**
 * Runs `f` on a new context, after scale(2, 2) when `scaled`, and returns the
 * error it throws ({ name, message } or null) and the matrix after it.
 */
function run(f: (ctx: Ctx) => void, scaled = true) {
  const ctx = createCanvas(20, 20).getContext('2d')
  if (scaled) ctx.scale(2, 2)
  let error = null
  try {
    f(ctx)
  } catch (e: any) {
    error = { name: e.name, message: e.message }
  }
  return { error, m: matrix(ctx) }
}

const setTransform = (...args: any[]) => run((ctx) => (ctx.setTransform as any)(...args))
const ok = (m: number[]) => ({ error: null, m })
const typeError = (message: string, m = SCALE_2) => ({ error: { name: 'TypeError', message: PREFIX + message }, m })

test('setTransform(dict) fills missing members from the identity', (t) => {
  t.deepEqual(setTransform({ a: 2, d: 3 }), ok([2, 0, 0, 3, 0, 0]))
  t.deepEqual(setTransform({ b: 0.5, c: -0.25, e: 3 }), ok([1, 0.5, -0.25, 1, 3, 0]))
  t.deepEqual(setTransform({ a: '2', d: '3' }), ok([2, 0, 0, 3, 0, 0]))
})

test('setTransform() and setTransform(undefined, null, {}, an array or a function) reset to identity', (t) => {
  const identity = ok([1, 0, 0, 1, 0, 0])
  t.deepEqual(setTransform(), identity)
  for (const value of [undefined, null, {}, [2, 0, 0, 2, 0, 0], function () {}]) {
    t.deepEqual(setTransform(value), identity, String(value))
  }
  t.deepEqual(setTransform(undefined, 5), identity)
})

test('setTransform(dict) takes m11..m42 and checks them against a..f', (t) => {
  t.deepEqual(setTransform({ m11: 2, m22: 3, m41: 4, m42: 5 }), ok([2, 0, 0, 3, 4, 5]))
  t.deepEqual(setTransform({ a: 2, m22: 3, e: 4, m42: 5 }), ok([2, 0, 0, 3, 4, 5]))
  t.deepEqual(setTransform({ b: -0, m12: 0, a: 2 }), ok([2, 0, 0, 1, 0, 0]))
  // Two NaNs agree; then the non-finite matrix is ignored.
  t.deepEqual(setTransform({ a: NaN, m11: NaN }), ok(SCALE_2))
  t.deepEqual(setTransform({ a: 1, m11: 2 }), typeError('Property mismatch on matrix initialization.'))
  t.deepEqual(setTransform({ f: 1, m42: 2 }), typeError('Property mismatch on matrix initialization.'))
})

test('setTransform(dict) accepts DOMMatrixInit 3D members and checks is2D', (t) => {
  t.deepEqual(setTransform({ m11: 2, m33: 5, m13: 1 }), ok([2, 0, 0, 1, 0, 0]))
  t.deepEqual(setTransform({ m44: 2, a: 2 }), ok([2, 0, 0, 1, 0, 0]))
  t.deepEqual(setTransform({ is2D: true, a: 3 }), ok([3, 0, 0, 1, 0, 0]))
  t.deepEqual(setTransform({ is2D: false, a: 3 }), ok([3, 0, 0, 1, 0, 0]))
  t.deepEqual(setTransform({ is2D: null, a: 2 }), ok([2, 0, 0, 1, 0, 0]))
  const is3D = 'The is2D member is set to true but the input matrix is a 3d matrix.'
  t.deepEqual(setTransform({ is2D: true, m33: 2 }), typeError(is3D))
  t.deepEqual(setTransform({ is2D: 'yes', m33: 2 }), typeError(is3D))
})

test('setTransform(dict) with a non-finite member does nothing', (t) => {
  for (const value of [{ a: NaN }, { e: Infinity }, { a: 'x' }]) {
    t.deepEqual(setTransform(value), ok(SCALE_2), JSON.stringify(value))
  }
})

test('setTransform picks the number overload only for six or more arguments', (t) => {
  const notInit = "The provided value is not of type 'DOMMatrixInit'."
  t.deepEqual(setTransform(5), typeError(notInit))
  t.deepEqual(setTransform('x'), typeError(notInit))
  t.deepEqual(setTransform(1, 0, 0), typeError(notInit))
  t.deepEqual(setTransform(1, 0, 0, 1, 5), typeError(notInit))
  t.deepEqual(setTransform({ a: 3 }, 5), ok([3, 0, 0, 1, 0, 0]))
  t.deepEqual(setTransform(1, 0, 0, 1, 5, 6, 7), ok([1, 0, 0, 1, 5, 6]))
  t.deepEqual(setTransform('2', '0', '0', '2', '1', '1'), ok([2, 0, 0, 2, 1, 1]))
  // Six arguments are six numbers: ToNumber({ a: 3 }) and undefined are NaN.
  t.deepEqual(setTransform({ a: 3 }, 0, 0, 1, 0, 0), ok(SCALE_2))
  t.deepEqual(setTransform(1, 0, 0, 1, 0, undefined), ok(SCALE_2))
  const log: string[] = []
  const v = (name: string, value: number) => ({
    valueOf() {
      log.push(name)
      return value
    },
  })
  t.deepEqual(setTransform(v('a', 2), v('b', 0), v('c', 0), v('d', 2), v('e', 1), v('f', 1)), ok([2, 0, 0, 2, 1, 1]))
  t.is(log.join(), 'a,b,c,d,e,f')
  log.length = 0
  const thrown = new RangeError('vb')
  const throwing = {
    valueOf() {
      log.push('b')
      throw thrown
    },
  }
  t.deepEqual(setTransform(1, throwing, v('c', 0), 1, 0, 0), {
    error: { name: 'RangeError', message: 'vb' },
    m: SCALE_2,
  })
  t.is(log.join(), 'b')
})

test('setTransform takes a DOMMatrix', (t) => {
  t.deepEqual(setTransform(new DOMMatrix([2, 0, 0, 2, 3, 4])), ok([2, 0, 0, 2, 3, 4]))
  t.deepEqual(setTransform(new DOMMatrix([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 7, 8, 0, 1])), ok([2, 0, 0, 3, 7, 8]))
  t.deepEqual(setTransform(new DOMMatrix().translate(3, 4).scale(2)), ok([2, 0, 0, 2, 3, 4]))
  t.deepEqual(setTransform(new DOMMatrix([NaN, 0, 0, 1, 0, 0])), ok(SCALE_2))
  t.deepEqual(setTransform(new DOMMatrix([1, 0, 0, 1, Infinity, 0])), ok(SCALE_2))
  t.deepEqual(setTransform(new DOMMatrix([2, 0, 0, 2, 3, 4]), 5), ok([2, 0, 0, 2, 3, 4]))
  t.deepEqual(setTransform(new DOMMatrix([3, 0, 0, 3, 0, 0]), 0, 0, 1, 0, 0), ok(SCALE_2))
  const mutated = new DOMMatrix([2, 0, 0, 2, 3, 4])
  mutated.a = 7
  mutated.f = 9
  t.deepEqual(setTransform(mutated), ok([7, 0, 0, 2, 3, 9]))
  const m33 = new DOMMatrix([2, 0, 0, 2, 3, 4])
  m33.m33 = 5
  t.deepEqual(setTransform(m33), ok([2, 0, 0, 2, 3, 4]))
  // A subclass is read member by member, as any other dictionary.
  class Plain extends DOMMatrix {}
  t.deepEqual(setTransform(new Plain([2, 0, 0, 2, 3, 4])), ok([2, 0, 0, 2, 3, 4]))
  class OwnA extends DOMMatrix {
    get a() {
      return 5
    }
  }
  t.deepEqual(setTransform(new OwnA([2, 0, 0, 2, 3, 4])), typeError('Property mismatch on matrix initialization.'))
  // getTransform() and back: the float values round-trip.
  const roundTrip = run((ctx) => {
    ctx.setTransform(0.1, 0.2, 0.3, 0.4, 0.5, 0.6)
    const m = ctx.getTransform()
    ctx.resetTransform()
    ctx.setTransform(m)
  })
  t.deepEqual(
    roundTrip,
    ok([0.10000000149011612, 0.20000000298023224, 0.30000001192092896, 0.4000000059604645, 0.5, 0.6000000238418579]),
  )
  const proto = Object.getPrototypeOf(createCanvas(1, 1).getContext('2d'))
  t.throws(() => proto.setTransform.call({}, new DOMMatrix()), { instanceOf: TypeError, message: 'Illegal invocation' })
  t.throws(() => proto.setTransform.call({}, 1, 0, 0, 1, 0, 0), {
    instanceOf: TypeError,
    message: 'Illegal invocation',
  })
})

test('setTransform clamps huge values to the float range', (t) => {
  const max = 3.4028234663852886e38
  t.deepEqual(setTransform({ a: 1e39, f: -1e40 }), ok([max, 0, 0, 1, 0, -max]))
  t.deepEqual(setTransform(new DOMMatrix([1e39, 0, 0, 1, 0, -1e40])), ok([max, 0, 0, 1, 0, -max]))
  t.deepEqual(setTransform({ a: 1e-46 }), ok([0, 0, 0, 1, 0, 0]))
})

test('setTransform conversion errors name setTransform and the member', (t) => {
  const member = (key: string, dictionary: string, what: string) =>
    `Failed to read the '${key}' property from '${dictionary}': Cannot convert a ${what} value to a number`
  t.deepEqual(setTransform({ a: Symbol() }), typeError(member('a', 'DOMMatrix2DInit', 'Symbol')))
  t.deepEqual(setTransform({ a: 1n }), typeError(member('a', 'DOMMatrix2DInit', 'BigInt')))
  t.deepEqual(setTransform({ m33: Symbol() }), typeError(member('m33', 'DOMMatrixInit', 'Symbol')))
  t.deepEqual(setTransform({ a: { valueOf: () => Symbol() } }), typeError(member('a', 'DOMMatrix2DInit', 'Symbol')))
  t.deepEqual(setTransform(1, 0, 0, 1, 0, Symbol()), typeError('Cannot convert a Symbol value to a number'))
  t.deepEqual(
    setTransform({ valueOf: () => Symbol() }, 0, 0, 1, 0, 0),
    typeError('Cannot convert a Symbol value to a number'),
  )
  t.deepEqual(
    setTransform({ valueOf: null, toString: null }, 0, 0, 1, 0, 0),
    typeError('Cannot convert object to primitive value'),
  )
  // The numbers are converted in order, up to the first that fails.
  const log: string[] = []
  const v = (name: string, value: unknown) => ({
    valueOf() {
      log.push(name)
      return value
    },
  })
  t.deepEqual(
    setTransform(v('a', 1), v('b', Symbol()), v('c', 0), 1, 0, 0),
    typeError('Cannot convert a Symbol value to a number'),
  )
  t.is(log.join(), 'a,b')
})

test('setTransform reads all members before checking them', (t) => {
  const log: string[] = []
  const proxy = new Proxy(
    {},
    {
      get(_, key) {
        if (typeof key === 'string') log.push(key)
        return undefined
      },
    },
  )
  t.deepEqual(setTransform(proxy), ok([1, 0, 0, 1, 0, 0]))
  t.is(log.join(), 'a,b,c,d,e,f,m11,m12,m21,m22,m41,m42,is2D,m13,m14,m23,m24,m31,m32,m33,m34,m43,m44')
  t.deepEqual(
    setTransform({
      get d() {
        throw new RangeError('boom')
      },
    }),
    { error: { name: 'RangeError', message: 'boom' }, m: SCALE_2 },
  )
})

test("setTransform has Chrome's length and name", (t) => {
  const proto = Object.getPrototypeOf(createCanvas(1, 1).getContext('2d'))
  t.is(proto.setTransform.length, 0)
  t.is(proto.setTransform.name, 'setTransform')
})
