// roundRect() geometry, radii and errors (Blink canvas_path.cc roundRect,
// path_builder.cc AddRoundedRect). Every expected value was measured in
// Chrome 155 CPU canvas (--disable-gpu, getContext('2d', { willReadFrequently:
// true })) in a standards-mode page; Chrome arm64 and x64 give the same
// values.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, DOMPoint, Path2D } from '../index'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

/** Bounding box [x0, y0, x1, y1] of the pixels with alpha > 0 (null if none) and the alpha sum. */
function ink(ctx: Ctx) {
  const { width, height } = ctx.canvas
  const d = ctx.getImageData(0, 0, width, height).data
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  let sum = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = d[(y * width + x) * 4 + 3]
      sum += a
      if (a) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
    }
  }
  return { box: x1 < 0 ? null : [x0, y0, x1, y1], sum }
}

/** Runs `f` on a new canvas (default 60x60) and returns the ink. */
function draw(f: (ctx: Ctx) => void, size = 60) {
  const ctx = createCanvas(size, size).getContext('2d')
  f(ctx)
  return ink(ctx)
}

/** Fills roundRect(...args) on the context, or on a Path2D. */
const fill = (args: any[]) =>
  draw((ctx) => {
    ctx.beginPath()
    ;(ctx.roundRect as any)(...args)
    ctx.fill()
  })
const fillPath2D = (args: any[]) =>
  draw((ctx) => {
    const p = new Path2D()
    ;(p.roundRect as any)(...args)
    ctx.fill(p)
  })

/** Strokes roundRect(...args) with lineWidth 3 and dash [7, 5]. */
const dashed = (args: any[]) =>
  draw((ctx) => {
    ctx.beginPath()
    ;(ctx.roundRect as any)(...args)
    ctx.setLineDash([7, 5])
    ctx.lineWidth = 3
    ctx.stroke()
  })

test('roundRect with a negative width or height swaps corners like Chrome', (t) => {
  // The 4 radii are top-left, top-right, bottom-right, bottom-left; a flip
  // swaps them like the rect.
  t.deepEqual(fill([5, 45, 40, -40, [20, 0, 0, 0]]), { box: [5, 5, 44, 44], sum: 386113 })
  t.deepEqual(fill([5, 45, 40, -40, [20, 5, 10, 0]]), { box: [5, 5, 44, 44], sum: 378516 })
  t.deepEqual(fill([45, 45, -40, -40, [20, 5, 10, 0]]), { box: [5, 5, 44, 44], sum: 378490 })
  t.deepEqual(fill([45, 5, -40, 40, [20, 0, 0, 0]]), { box: [5, 5, 44, 44], sum: 385876 })
  t.deepEqual(fillPath2D([5, 45, 40, -40, [20, 0, 0, 0]]), { box: [5, 5, 44, 44], sum: 386113 })
})

test('roundRect dashes start after the top-left corner', (t) => {
  t.deepEqual(dashed([5, 5, 40, 40, 8]), { box: [3, 3, 46, 46], sum: 65749 })
  t.deepEqual(dashed([45, 45, -40, -40, [8, 2, 4, 12]]), { box: [3, 3, 46, 46], sum: 67445 })
  t.deepEqual(dashed([5, 15, 40, 20, 100]), { box: [3, 13, 46, 36], sum: 48122 })
})

test('roundRect with zero width or height adds a plain rect', (t) => {
  const stroke = (args: any[], then?: (ctx: Ctx) => void) =>
    draw((ctx) => {
      ctx.beginPath()
      ;(ctx.roundRect as any)(...args)
      then?.(ctx)
      ctx.lineWidth = 4
      ctx.stroke()
    })
  const lineTo = (ctx: Ctx) => ctx.lineTo(40, 40)
  t.deepEqual(stroke([10, 10, 0, 30, 5]), { box: [8, 10, 11, 39], sum: 30600 })
  // No moveTo after a flat rect: the lineTo continues from the rect's start.
  t.deepEqual(stroke([10, 40, 0, -30, 5], lineTo), { box: [8, 10, 39, 41], sum: 60180 })
  t.deepEqual(stroke([40, 10, -30, 0, 5], lineTo), { box: [10, 8, 41, 39], sum: 60180 })
  t.deepEqual(
    stroke([20, 20, 0, 0, 5], (ctx) => ctx.lineTo(40, 40)),
    { box: [18, 18, 41, 41], sum: 29982 },
  )
  t.deepEqual(
    draw((ctx) => {
      ctx.beginPath()
      ctx.roundRect(50, 30, -40, 0, 5)
      ctx.setLineDash([6, 4])
      ctx.lineWidth = 4
      ctx.lineCap = 'square'
      ctx.stroke()
    }),
    { box: [8, 28, 51, 31], sum: 44880 },
  )
})

test('roundRect ends with moveTo(x, y)', (t) => {
  const stroke = (args: number[], close = false) =>
    draw((ctx) => {
      ctx.beginPath()
      ctx.roundRect(args[0], args[1], args[2], args[3], args[4])
      if (close) ctx.closePath()
      ctx.lineTo(close ? 55 : 50, close ? 55 : 50)
      ctx.lineWidth = 2
      ctx.stroke()
    })
  t.deepEqual(stroke([10, 10, 30, 20, 5]), { box: [9, 9, 50, 50], sum: 72561 })
  t.deepEqual(stroke([40, 30, -30, -20, 5]), { box: [9, 9, 50, 50], sum: 72561 })
  t.deepEqual(stroke([10, 10, 30, 30, 6], true), { box: [9, 9, 55, 55], sum: 86874 })
})

test('roundRect large radius and negative size', (t) => {
  t.deepEqual(fill([5, 5, 30, 20, 100]), { box: [5, 5, 34, 24], sum: 128714 })
  t.deepEqual(fillPath2D([5, 5, 30, 20, 100]), { box: [5, 5, 34, 24], sum: 128714 })
  t.deepEqual(fill([35, 35, -30, -30, 5]), { box: [5, 5, 34, 34], sum: 223645 })
  t.deepEqual(fill([5, 5, 40, 30, 10]), { box: [5, 5, 44, 34], sum: 281708 })
  t.deepEqual(fill([5, 5, 40, 40, [2, 6, 10, 14]]), { box: [5, 5, 44, 44], sum: 388802 })
  // 40x40 canvas, lineWidth 3.
  const scene = (args: any[], mode: 'fill' | 'stroke') =>
    draw((ctx) => {
      ctx.beginPath()
      ;(ctx.roundRect as any)(...args)
      ctx.lineWidth = 3
      ctx[mode]()
    }, 40)
  t.deepEqual(scene([35, 35, -30, -30, [10, 0, 0, 0]], 'fill'), { box: [5, 5, 34, 34], sum: 223429 })
  t.deepEqual(scene([35, 35, -30, -30, [10, 0, 0, 0]], 'stroke'), { box: [3, 3, 36, 36], sum: 89196 })
  t.deepEqual(scene([5, 5, 30, 20, 100], 'fill'), { box: [5, 5, 34, 24], sum: 128714 })
  t.deepEqual(scene([5, 5, 30, 20, 100], 'stroke'), { box: [3, 3, 36, 26], sum: 65011 })
  t.deepEqual(scene([35, 35, -30, -30, 5], 'fill'), { box: [5, 5, 34, 34], sum: 223645 })
  t.deepEqual(scene([35, 35, -30, -30, 5], 'stroke'), { box: [3, 3, 36, 36], sum: 83936 })
})

const C = "Failed to execute 'roundRect' on 'CanvasRenderingContext2D': "
const P = "Failed to execute 'roundRect' on 'Path2D': "

/** The error `f` throws, as { name, message }; null when it returns. */
function thrown(f: () => unknown) {
  try {
    f()
    return null
  } catch (e: any) {
    return { name: e.name, message: e.message }
  }
}

/** roundRect(...args) on a 60x60 context: the error, and the ink of a fill after it. */
function attempt(args: any[], before?: (ctx: Ctx) => void) {
  const ctx = createCanvas(60, 60).getContext('2d')
  before?.(ctx)
  const error = thrown(() => (ctx.roundRect as any)(...args))
  ctx.resetTransform()
  ctx.fill()
  return { error, ...ink(ctx) }
}

test('roundRect radii take numbers, DOMPointInit and iterables of them', (t) => {
  const box = [5, 5, 44, 44]
  t.deepEqual(fill([5, 5, 30, 30, [{ x: 10, y: 4 }, 2]]), { box: [5, 5, 34, 34], sum: 224194 })
  t.deepEqual(fillPath2D([5, 5, 30, 30, [{ x: 10, y: 4 }, 2]]), { box: [5, 5, 34, 34], sum: 224194 })
  t.deepEqual(fill([5, 5, 40, 30, { x: 15, y: 6 }]), { box: [5, 5, 44, 34], sum: 285119 })
  t.deepEqual(fill([5, 5, 40, 30, [{ x: 15, y: 6 }]]), { box: [5, 5, 44, 34], sum: 285119 })
  t.deepEqual(fill([5, 5, 40, 40, [{ x: 10, y: 4 }, 2, { x: 3, y: 12 }, 8]]), { box, sum: 399554 })
  t.deepEqual(fill([5, 5, 40, 40, [{ x: 10, y: 4 }, { x: 2, y: 12 }, 8]]), { box, sum: 399103 })
  t.deepEqual(fill([5, 5, 40, 40, new DOMPoint(10, 5)]), { box, sum: 396130 })
  t.deepEqual(fill([5, 45, 40, -40, [{ x: 20, y: 6 }, 0, 0, 0]]), { box, sum: 401092 })
  t.deepEqual(fill([45, 5, -40, 40, [{ x: 20, y: 6 }, 0, { x: 4, y: 18 }, 0]]), { box, sum: 396961 })
  // Radii too large for the side are scaled down together.
  t.deepEqual(
    fill([
      5,
      5,
      40,
      30,
      [
        { x: 30, y: 25 },
        { x: 30, y: 4 },
      ],
    ]),
    { box: [5, 5, 45, 34], sum: 262527 },
  )
  // A missing member is 0; null and undefined are {} in the union, and an
  // array-like without @@iterator is a DOMPointInit too.
  for (const radii of [[{}], { x: 10 }, null, undefined, -0, { length: 2, 0: 10, 1: 5 }]) {
    t.deepEqual(fill([5, 5, 40, 40, radii]), { box, sum: 408000 }, String(radii))
  }
  t.deepEqual(fill([5, 5, 40, 40]), { box, sum: 408000 })
  t.deepEqual(fill([5, 5, 40, 40, [null, 10]]), { box, sum: 395859 })
  t.deepEqual(fill([5, 5, 40, 40, [undefined, 10]]), { box, sum: 395859 })
  // ToNumber for anything else that is not an object.
  t.deepEqual(fill([5, 5, 40, 40, '10']), { box, sum: 383708 })
  t.deepEqual(fill([5, 5, 40, 40, ['10', '5']]), { box, sum: 392913 })
  // A String object is iterable: ['7'].
  t.deepEqual(fill([5, 5, 40, 40, new String('7')]), { box, sum: 396552 })
  // @@iterator null is no iterator: the object is a DOMPointInit; so is a function.
  t.deepEqual(fill([5, 5, 40, 40, { [Symbol.iterator]: null, x: 10, y: 10 }]), { box, sum: 383708 })
  t.deepEqual(fill([5, 5, 40, 40, Object.assign(() => {}, { x: 10, y: 10 })]), { box, sum: 383708 })
  t.deepEqual(
    fill([
      5,
      5,
      40,
      40,
      {
        *[Symbol.iterator]() {
          yield 10
          yield { x: 5, y: 2 }
        },
      },
    ]),
    { box, sum: 394904 },
  )
  t.deepEqual(
    draw((ctx) => {
      ctx.beginPath()
      ctx.roundRect(5, 45, 40, -40, [{ x: 12, y: 4 }, 6])
      ctx.setLineDash([5, 3])
      ctx.lineWidth = 2
      ctx.stroke()
    }),
    { box: [4, 4, 45, 45], sum: 48571 },
  )
  const ctx = createCanvas(60, 60).getContext('2d')
  ctx.roundRect(5, 5, 40, 40, [{ x: 20, y: 4 }, 0])
  t.deepEqual([ctx.isPointInPath(7, 7), ctx.isPointInPath(7, 9.5), ctx.isPointInPath(43, 7)], [false, true, true])
})

test('roundRect throws RangeError for negative radii and a bad radius count', (t) => {
  const range = (message: string) => ({ name: 'RangeError', message })
  const cases: [any, string][] = [
    [-1, 'Radius value -1 is negative.'],
    [-0.5, 'Radius value -0.5 is negative.'],
    [-0.1, 'Radius value -0.1 is negative.'],
    [-1e-7, 'Radius value -1.00000e-7 is negative.'],
    [-123456789, 'Radius value -1.23457e+8 is negative.'],
    [-1e21, 'Radius value -1.00000e+21 is negative.'],
    [-3.4e38, 'Radius value -3.40000e+38 is negative.'],
    [-1.5, 'Radius value -1.5 is negative.'],
    // The message shows the float value.
    [-0.30000001, 'Radius value -0.3 is negative.'],
    [-16777217, 'Radius value -1.67772e+7 is negative.'],
    [-1e-45, 'Radius value -1.40130e-45 is negative.'],
    [[-1, NaN], 'Radius value -1 is negative.'],
    [{ x: -0.1 }, 'X-radius value -0.1 is negative.'],
    [{ x: -1, y: 4 }, 'X-radius value -1 is negative.'],
    [{ x: 1, y: -4 }, 'Y-radius value -4 is negative.'],
    [{ y: -1e21 }, 'Y-radius value -1.00000e+21 is negative.'],
    [[], '0 radii provided. Between one and four radii are necessary.'],
    [[1, 2, 3, 4, 5], '5 radii provided. Between one and four radii are necessary.'],
    [[{}, {}, {}, {}, {}, {}], '6 radii provided. Between one and four radii are necessary.'],
  ]
  for (const [radii, message] of cases) {
    t.deepEqual(attempt([5, 5, 40, 40, radii]), { error: range(C + message), box: null, sum: 0 }, message)
  }
  // A flat rect checks its radii too.
  t.deepEqual(attempt([5, 5, 0, 40, -1]).error, range(C + 'Radius value -1 is negative.'))
  t.deepEqual(
    thrown(() => new Path2D().roundRect(0, 0, 5, 5, [])),
    range(P + '0 radii provided. Between one and four radii are necessary.'),
  )
  t.deepEqual(
    thrown(() => new Path2D().roundRect(0, 0, 5, 5, -2)),
    range(P + 'Radius value -2 is negative.'),
  )
  t.deepEqual(
    thrown(() => new Path2D().roundRect(0, 0, 5, 5, [{ x: 1, y: -2 }])),
    range(P + 'Y-radius value -2 is negative.'),
  )
})

test('roundRect RangeErrors keep the bare message in the stack', (t) => {
  // Chrome throws them from the binding: the message gets the prefix, the
  // stack keeps the bare message.
  const ctx = createCanvas(10, 10).getContext('2d')
  const path = new Path2D()
  for (const [f, prefix, msg] of [
    [() => ctx.roundRect(0, 0, 10, 10, []), C, '0 radii provided. Between one and four radii are necessary.'],
    [
      () => ctx.roundRect(0, 0, 10, 10, [1, 2, 3, 4, 5]),
      C,
      '5 radii provided. Between one and four radii are necessary.',
    ],
    [() => ctx.roundRect(0, 0, 10, 10, -1), C, 'Radius value -1 is negative.'],
    [() => ctx.roundRect(0, 0, 10, 10, [{ x: -1, y: 1 }]), C, 'X-radius value -1 is negative.'],
    [() => path.roundRect(0, 0, 10, 10, -2), P, 'Radius value -2 is negative.'],
    [() => path.roundRect(0, 0, 10, 10, []), P, '0 radii provided. Between one and four radii are necessary.'],
  ] as [() => void, string, string][]) {
    const error = t.throws(f, { instanceOf: RangeError, message: prefix + msg })
    t.is(String(error?.stack).split('\n')[0], `RangeError: ${msg}`)
  }
})

test('roundRect checks the count, then the matrix and the rect, then each radius in turn', (t) => {
  const nothing = { error: null, box: null, sum: 0 }
  const count = (n: number) => ({
    error: { name: 'RangeError', message: C + n + ' radii provided. Between one and four radii are necessary.' },
    box: null,
    sum: 0,
  })
  const singular = (ctx: Ctx) => ctx.scale(0, 1)
  t.deepEqual(attempt([NaN, 0, 5, 5, []]), count(0))
  t.deepEqual(attempt([0, 0, 5, 5, []], singular), count(0))
  t.deepEqual(attempt([5, 5, 40, 40, [1, 2, 3, 4, 5]], singular), count(5))
  // Then nothing is added, and nothing thrown, under a singular matrix, for a
  // rect outside the float range, or at the first radius that is not finite.
  t.deepEqual(attempt([5, 5, 40, 40, -1], singular), nothing)
  t.deepEqual(attempt([NaN, 5, 40, 40, -1]), nothing)
  t.deepEqual(attempt([5, 5, 1e39, 40, -1]), nothing)
  for (const radii of [
    NaN,
    [Infinity, 2],
    [NaN, -1],
    { x: NaN, y: 4 },
    [{ x: Infinity, y: 4 }],
    { x: Infinity, y: -1 },
    { x: -1, y: NaN },
    { x: 1e39, y: 1 },
    // Just above FLT_MAX: outside the float range, although it rounds to FLT_MAX.
    3.4028235e38,
    -1e39,
  ]) {
    t.deepEqual(attempt([5, 5, 40, 40, radii]), nothing, JSON.stringify(radii))
  }
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.roundRect(1e300, 0, 5, 5, 1)
  t.false(ctx.isPointInPath(1, 1))
  ctx.beginPath()
  ;(ctx.roundRect as any)(0, 0, 10, 10, true)
  t.false(ctx.isPointInPath(0.2, 0.2))
})

test('roundRect converts radii like WebIDL', (t) => {
  const type = (prefix: string, message: string) => ({ name: 'TypeError', message: prefix + message })
  const roundRect = (radii: any) => thrown(() => createCanvas(10, 10).getContext('2d').roundRect(0, 0, 5, 5, radii))
  t.deepEqual(roundRect(Symbol()), type(C, 'Cannot convert a Symbol value to a number'))
  t.deepEqual(roundRect([Symbol()]), type(C, 'Cannot convert a Symbol value to a number'))
  t.deepEqual(roundRect(1n), type(C, 'Cannot convert a BigInt value to a number'))
  // Every radius is converted before any is checked.
  t.deepEqual(roundRect([-1, Symbol()]), type(C, 'Cannot convert a Symbol value to a number'))
  const member = (key: string) =>
    `Failed to read the '${key}' property from 'DOMPointInit': Cannot convert a Symbol value to a number`
  t.deepEqual(roundRect({ x: Symbol() }), type(C, member('x')))
  t.deepEqual(roundRect({ w: Symbol() }), type(C, member('w')))
  t.deepEqual(roundRect({ x: { valueOf: () => Symbol() } }), type(C, member('x')))
  t.deepEqual(roundRect({ [Symbol.iterator]: 5 }), type(C, '@@iterator must be a function'))
  t.deepEqual(
    thrown(() => new Path2D().roundRect(0, 0, 5, 5, { [Symbol.iterator]: 5 } as any)),
    type(P, '@@iterator must be a function'),
  )
  t.deepEqual(roundRect({ [Symbol.iterator]: () => 5 }), type(C, 'Iterator object must be an object.'))
  t.deepEqual(
    roundRect({ [Symbol.iterator]: () => ({ next: () => 5 }) }),
    type(C, 'Expected iterator.next() to return an Object.'),
  )
  t.deepEqual(roundRect({ [Symbol.iterator]: () => ({ next: 5 }) }), type(C, 'Expected next() function on iterator.'))
  t.deepEqual(roundRect({ [Symbol.iterator]: () => ({}) }), type(C, 'Expected next() function on iterator.'))
  // An error from user code passes as it is.
  const error = new RangeError('it')
  const ctx = createCanvas(10, 10).getContext('2d')
  t.is(
    t.throws(() =>
      ctx.roundRect(0, 0, 5, 5, {
        [Symbol.iterator]() {
          throw error
        },
      } as any),
    ),
    error,
  )
})

test('roundRect reads radii in order', (t) => {
  const ctx = createCanvas(60, 60).getContext('2d')
  const log: string[] = []
  const point = (name: string) =>
    new Proxy(
      {},
      {
        get(_, key) {
          if (typeof key === 'string') log.push(name + '.' + key)
          return key === 'x' ? 2 : undefined
        },
      },
    )
  ctx.roundRect(1, 1, 20, 20, [point('A'), point('B')])
  t.is(log.join(), 'A.w,A.x,A.y,A.z,B.w,B.x,B.y,B.z')
  log.length = 0
  t.throws(() => ctx.roundRect(1, 1, 20, 20, [point('A'), -1, point('B')]), { name: 'RangeError' })
  t.is(log.join(), 'A.w,A.x,A.y,A.z,B.w,B.x,B.y,B.z')
  // Each value is converted as soon as the iterator gives it.
  log.length = 0
  ctx.roundRect(0, 0, 20, 20, {
    *[Symbol.iterator]() {
      log.push('n1')
      yield point('A')
      log.push('n2')
      yield point('B')
      log.push('n3')
    },
  } as any)
  t.is(log.join(), 'n1,A.w,A.x,A.y,A.z,n2,B.w,B.x,B.y,B.z,n3')
  log.length = 0
  t.throws(
    () =>
      ctx.roundRect(0, 0, 20, 20, {
        *[Symbol.iterator]() {
          log.push('n1')
          yield Symbol()
          log.push('n2')
          yield 3
        },
      } as any),
    { name: 'TypeError', message: C + 'Cannot convert a Symbol value to a number' },
  )
  t.is(log.join(), 'n1')
  // A failed conversion does not call return().
  log.length = 0
  let i = 0
  const iterator = {
    next() {
      log.push('next')
      return i++ < 1 ? { value: Symbol(), done: false } : { done: true }
    },
    return() {
      log.push('return')
      return {}
    },
  }
  t.throws(() => ctx.roundRect(0, 0, 20, 20, { [Symbol.iterator]: () => iterator } as any), { name: 'TypeError' })
  t.is(log.join(), 'next')
  // next is read once; each step reads value, then done.
  log.length = 0
  let step = 0
  const counted = {
    get next() {
      log.push('next')
      return () => {
        log.push('step')
        const done = step++ >= 1
        return {
          get done() {
            log.push('done')
            return done
          },
          get value() {
            log.push('value')
            return 4
          },
        }
      }
    },
  }
  t.deepEqual(
    draw((ctx) => {
      ctx.beginPath()
      ctx.roundRect(5, 5, 40, 40, { [Symbol.iterator]: () => counted } as any)
      ctx.fill()
    }),
    { box: [5, 5, 44, 44], sum: 404980 },
  )
  t.is(log.join(), 'next,step,value,done,step,value,done')
})

// Chrome picks the sequence overload of roundRect for an Array, or for an
// object whose @@iterator is callable (Blink canvas_path.idl, overload
// resolution in bind_gen/interface.py), then converts it as
// NativeValueTraits<IDLSequence> does (native_value_traits_impl.h).

/**
 * roundRect(5, 5, 40, 40, radii) on a 60x60 context, or on a Path2D filled
 * there: the error, and the ink. No spread: it would call
 * Array.prototype[Symbol.iterator], which some tests patch.
 */
function radiiResult(radii: unknown, onPath = false) {
  const ctx = createCanvas(60, 60).getContext('2d')
  const path = new Path2D()
  const error = thrown(() => (onPath ? path : ctx).roundRect(5, 5, 40, 40, radii as any))
  if (onPath) ctx.fill(path)
  else ctx.fill()
  return { error, ...ink(ctx) }
}
const ok = (sum: number) => ({ error: null, box: [5, 5, 44, 44], sum })
const failed = (name: string, message: string) => ({ error: { name, message }, box: null, sum: 0 })

test('roundRect reads an Array by index, never with its @@iterator', (t) => {
  // [10, 5]
  const tenFive = ok(392913)
  const log: string[] = []
  const values = Array.prototype.values
  let patched
  Array.prototype[Symbol.iterator] = function (this: unknown[]) {
    log.push('Array.prototype[@@iterator]')
    return values.call(this)
  }
  try {
    patched = [radiiResult([10, 5]), radiiResult([10, 5], true)]
  } finally {
    Array.prototype[Symbol.iterator] = values
  }
  t.deepEqual(patched, [tenFive, tenFive])
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!
  Object.defineProperty(Array.prototype, Symbol.iterator, {
    configurable: true,
    get() {
      log.push('get Array.prototype[@@iterator]')
      return values
    },
  })
  try {
    patched = radiiResult([10, 5])
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, descriptor)
  }
  t.deepEqual(patched, tenFive)
  t.is(log.join(), '')
  // An own @@iterator, even one that is not callable.
  const own = [10, 5]
  Object.defineProperty(own, Symbol.iterator, {
    get() {
      log.push('get own @@iterator')
      return function* () {
        yield 3
      }
    },
  })
  t.deepEqual(radiiResult(own), tenFive)
  t.deepEqual(radiiResult(Object.assign([10, 5], { [Symbol.iterator]: 5 })), tenFive)
  class Sub extends Array {
    *[Symbol.iterator]() {
      log.push('Sub[@@iterator]')
      yield 3
    }
  }
  const sub = new Sub(2)
  sub[0] = 10
  sub[1] = 5
  t.deepEqual(radiiResult(sub), tenFive)
  t.is(log.join(), '')
  // A hole is undefined, a DOMPointInit; [[Get]] finds an index on the
  // prototype chain.
  const holey = (length: number, items: Record<number, unknown>) => Object.assign([], items, { length })
  t.deepEqual(radiiResult(holey(2, { 1: 10 })), ok(395859))
  t.deepEqual(radiiResult(holey(1, {})), ok(408000))
  t.deepEqual(radiiResult(holey(3, { 1: 10 })), ok(395859))
  Object.defineProperty(Array.prototype, 0, {
    configurable: true,
    get() {
      log.push('Array.prototype[0]')
      return 10
    },
    // Writes, such as log.push() on an empty log, stay own data properties.
    set(value) {
      Object.defineProperty(this, 0, { value, writable: true, enumerable: true, configurable: true })
    },
  })
  try {
    patched = radiiResult(holey(2, { 1: 5 }))
  } finally {
    delete (Array.prototype as any)[0]
  }
  t.deepEqual(patched, tenFive)
  t.is(log.join(), 'Array.prototype[0]')
})

test('roundRect reads the length of an Array again after each radius', (t) => {
  const log: string[] = []
  const getters = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    Object.defineProperty(getters, i, {
      get() {
        log.push('get' + i)
        return [10, 5, 2][i]
      },
    })
  }
  t.deepEqual(radiiResult(getters), ok(398730))
  t.is(log.join(), 'get0,get1,get2')
  log.length = 0
  const grows = [1, 2]
  Object.defineProperty(grows, 0, {
    get() {
      log.push('get0')
      grows.push(3)
      return 4
    },
  })
  t.deepEqual(radiiResult(grows), ok(406302))
  t.is(log.join(), 'get0')
  const shrinks: unknown[] = [
    {
      get x() {
        shrinks.length = 1
        return 4
      },
    },
    7,
    8,
  ]
  t.deepEqual(radiiResult(shrinks), ok(408000))
  const pastFour = [1, 2, 3, 4]
  Object.defineProperty(pastFour, 3, {
    get() {
      pastFour.push(5)
      return 4
    },
  })
  t.deepEqual(
    radiiResult(pastFour),
    failed('RangeError', C + '5 radii provided. Between one and four radii are necessary.'),
  )
  // An error from an index getter passes as it is.
  const error = new Error('get1')
  const throwing = [1, 2]
  Object.defineProperty(throwing, 1, {
    get() {
      throw error
    },
  })
  t.is(
    t.throws(() => createCanvas(10, 10).getContext('2d').roundRect(0, 0, 5, 5, throwing)),
    error,
  )
})

test('roundRect takes an Array of at most 536346624 radii, like Chrome', (t) => {
  // Blink's HeapVector of 4-byte Members holds MaxAllocationSize / 4 values.
  // A getter at index 0 that throws shows whether the length passed.
  const sparse = (length: number) => {
    const array: unknown[] = []
    array.length = length
    Object.defineProperty(array, 0, {
      get() {
        throw new Error('read 0')
      },
    })
    return array
  }
  const ctx = createCanvas(10, 10).getContext('2d')
  const path = new Path2D()
  for (const [f, prefix] of [
    [(radii: any) => ctx.roundRect(0, 0, 5, 5, radii), C],
    [(radii: any) => path.roundRect(0, 0, 5, 5, radii), P],
  ] as [(radii: any) => void, string][]) {
    t.throws(() => f(sparse(536346624)), { instanceOf: Error, message: 'read 0' })
    for (const length of [536346625, 2 ** 32 - 1]) {
      const error = t.throws(() => f(sparse(length)), {
        instanceOf: RangeError,
        message: prefix + 'Array length exceeds supported limit.',
      })
      t.is(String(error?.stack).split('\n')[0], 'RangeError: Array length exceeds supported limit.')
    }
  }
})

test('roundRect keeps only the first four radii while it converts a long list', (t) => {
  // Chrome converts every radius, then throws for more than four whatever
  // their values. Keeping all of them grew the peak resident size by about
  // 375 MB for 8,000,000 holes and 195 MB for 4,000,000 iterated values
  // (macOS arm64 and x64). Each list runs in a child process of its own,
  // which reports how much its peak resident size grew during the call.
  const run = (radii: string, call: string) => {
    const script = `
const { createCanvas, Path2D } = require('./index.js')
const radii = ${radii}
const before = process.resourceUsage().maxRSS
let error = null
try {
  ${call}
} catch (e) {
  error = { message: e.name + ': ' + e.message, stack: String(e.stack).split('\\n')[0] }
}
const growthMB = (process.resourceUsage().maxRSS - before) / 1024
process.stdout.write(JSON.stringify({ error, growthMB }))
`
    const { status, signal, stdout, stderr } = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    })
    t.is(status, 0, `status=${status} signal=${signal}\n${stderr}`)
    return JSON.parse(stdout) as { error: { message: string; stack: string } | null; growthMB: number }
  }
  const count = (n: number) => n + ' radii provided. Between one and four radii are necessary.'
  const holes = run(
    'Object.assign([], { length: 8000000 })',
    'createCanvas(8, 8).getContext("2d").roundRect(0, 0, 4, 4, radii)',
  )
  t.deepEqual(holes.error, { message: 'RangeError: ' + C + count(8000000), stack: 'RangeError: ' + count(8000000) })
  const iterable = run(
    '{ *[Symbol.iterator]() { for (let i = 0; i < 4000000; i++) yield 1 } }',
    'new Path2D().roundRect(0, 0, 4, 4, radii)',
  )
  t.deepEqual(iterable.error, {
    message: 'RangeError: ' + P + count(4000000),
    stack: 'RangeError: ' + count(4000000),
  })
  // Not measured on Windows.
  if (process.platform !== 'win32') {
    t.true(holes.growthMB < 48, `8,000,000 holes grew the peak resident size by ${holes.growthMB} MB`)
    t.true(iterable.growthMB < 48, `4,000,000 iterated values grew the peak resident size by ${iterable.growthMB} MB`)
  }
})

test('roundRect reads @@iterator of any other iterable twice, like Chrome', (t) => {
  const tenFive = ok(392913)
  t.deepEqual(radiiResult(new Set([10, 5])), tenFive)
  t.deepEqual(
    radiiResult(
      (function* () {
        yield 10
        yield 5
      })(),
    ),
    tenFive,
  )
  t.deepEqual(radiiResult(new Float64Array([10, 5])), tenFive)
  t.deepEqual(radiiResult(new Set([10, 5]), true), tenFive)
  // Once to pick the overload, once to convert the sequence.
  const log: string[] = []
  const keys = (target: object) =>
    new Proxy(target, {
      get(target, key, receiver) {
        log.push(String(key))
        return Reflect.get(target, key, receiver)
      },
    })
  // A Proxy of an Array is not an Array.
  t.deepEqual(radiiResult(keys([10, 5])), tenFive)
  t.is(log.join(), 'Symbol(Symbol.iterator),Symbol(Symbol.iterator),length,0,length,1,length')
  // The two reads may differ.
  let reads = 0
  const changing = (first: unknown, second: unknown) => {
    reads = 0
    return {
      x: 10,
      y: 10,
      get [Symbol.iterator]() {
        return reads++ === 0 ? first : second
      },
    }
  }
  function* ten() {
    yield 10
  }
  t.deepEqual(radiiResult(changing(ten, ten)), ok(383708))
  t.is(reads, 2)
  t.deepEqual(
    radiiResult(changing(ten, undefined)),
    failed('TypeError', C + 'The object must have a callable @@iterator property.'),
  )
  t.is(reads, 2)
  t.deepEqual(radiiResult(changing(ten, 5)), failed('TypeError', C + '@@iterator must be a callable.'))
  t.is(reads, 2)
  // Not iterable at the first read: a DOMPointInit.
  t.deepEqual(radiiResult(changing(undefined, ten)), ok(383708))
  t.is(reads, 1)
  // A non-callable @@iterator at the first read throws its own message.
  t.deepEqual(radiiResult(changing(5, ten)), failed('TypeError', C + '@@iterator must be a function'))
  t.is(reads, 1)
})

test('roundRect steps an iterator like Chrome and never calls its return()', (t) => {
  const log: string[] = []
  /** An iterable of `values`; each result object logs its reads, return() throws. */
  const iterable = (values: unknown[]) => {
    let i = 0
    const iterator = {
      next() {
        log.push('next')
        const done = i >= values.length
        return new Proxy(
          { value: done ? 'end' : values[i++], done },
          {
            get(target, key, receiver) {
              log.push(String(key))
              return Reflect.get(target, key, receiver)
            },
          },
        )
      },
      return() {
        log.push('return')
        throw new Error('return()')
      },
    }
    return { [Symbol.iterator]: () => iterator }
  }
  t.deepEqual(radiiResult(iterable([10, 5])), ok(392913))
  t.is(log.join(), 'next,value,done,next,value,done,next,value,done')
  log.length = 0
  t.deepEqual(
    radiiResult(iterable([10, Symbol(), 5])),
    failed('TypeError', C + 'Cannot convert a Symbol value to a number'),
  )
  t.is(log.join(), 'next,value,done,next,value,done')
  log.length = 0
  const error = new Error('x')
  t.is(
    t.throws(() =>
      createCanvas(10, 10)
        .getContext('2d')
        .roundRect(
          0,
          0,
          5,
          5,
          iterable([
            {
              get x() {
                throw error
              },
            },
          ]) as any,
        ),
    ),
    error,
  )
  t.is(log.join(), 'next,value,done')
  log.length = 0
  t.deepEqual(
    radiiResult(iterable([1, 2, 3, 4, 5, 6])),
    failed('RangeError', C + '6 radii provided. Between one and four radii are necessary.'),
  )
  t.is(log.filter((step) => step === 'next' || step === 'return').join(), 'next,next,next,next,next,next,next')
  log.length = 0
  t.deepEqual(
    radiiResult(iterable([])),
    failed('RangeError', C + '0 radii provided. Between one and four radii are necessary.'),
  )
  t.deepEqual(radiiResult(new Set([10, -1])), failed('RangeError', C + 'Radius value -1 is negative.'))
  // DOMPointInit radii read their members in order: w, x, y, z.
  const point = (name: string, x: number, y: number) =>
    new Proxy(
      { x, y },
      {
        get(target, key, receiver) {
          log.push(name + '.' + String(key))
          return Reflect.get(target, key, receiver)
        },
      },
    )
  log.length = 0
  t.deepEqual(radiiResult([point('A', 10, 4), 2, point('B', 3, 12)]), ok(402971))
  t.is(log.join(), 'A.w,A.x,A.y,A.z,B.w,B.x,B.y,B.z')
  log.length = 0
  t.deepEqual(radiiResult(new Set([point('A', 10, 4), 2, point('B', 3, 12)])), ok(402971))
  t.is(log.join(), 'A.w,A.x,A.y,A.z,B.w,B.x,B.y,B.z')
})

// Chrome picks the roundRect overload from the radii (IsArray, then one
// @@iterator read) before it converts x, y, w and h (overload resolution in
// bind_gen/interface.py), and converts the radii after them.
test('roundRect picks its overload from the radii before it converts x, y, w and h', (t) => {
  const log: string[] = []
  const logged = (name: string, value: number) => ({
    valueOf() {
      log.push(name)
      return value
    },
  })
  const xywh = () => [logged('x', 2), logged('y', 2), logged('w', 60), logged('h', 44)]
  /** `target` with a logged @@iterator getter that returns `method`. */
  const iterator = <T extends object>(target: T, method: unknown) =>
    Object.defineProperty(target, Symbol.iterator, {
      get() {
        log.push('@@iterator')
        return method
      },
    })
  const values = (...items: unknown[]) =>
    function* () {
      log.push('iterate')
      yield* items
    }
  const logGets = <T extends object>(name: string, target: T) =>
    new Proxy(target, {
      get(target, key, receiver) {
        log.push(name + '.' + String(key))
        return Reflect.get(target, key, receiver)
      },
    })
  /** A function is an object: a DOMPointInit when not iterable. */
  const pointFunction = () => Object.assign(function () {}, { x: 7 })
  /** roundRect(...args()) on a 64x48 context, or on a Path2D filled there. */
  const run = (args: () => unknown[], onPath: boolean) => {
    log.length = 0
    const ctx = createCanvas(64, 48).getContext('2d')
    const path = new Path2D()
    const error = thrown(() => ((onPath ? path : ctx).roundRect as any)(...args()))
    if (onPath) ctx.fill(path)
    else ctx.fill()
    return { error, ...ink(ctx), log: log.join(' ') }
  }
  const drawn = (sum: number, order: string) => ({ error: null, box: [2, 2, 61, 45], sum, log: order })
  const cases: [string, () => unknown[], (prefix: string) => ReturnType<typeof run>][] = [
    [
      'an iterable',
      () => [...xywh(), iterator({}, values(logGets('r', { x: 5, y: 9 }), 7))],
      () => drawn(662017, '@@iterator x y w h @@iterator iterate r.w r.x r.y r.z'),
    ],
    [
      'a DOMPointInit',
      () => [...xywh(), logGets('r', { x: 6, y: 9 })],
      () => drawn(660063, 'r.Symbol(Symbol.iterator) x y w h r.w r.x r.y r.z'),
    ],
    ['@@iterator null', () => [...xywh(), iterator({ x: 6, y: 9 }, null)], () => drawn(660063, '@@iterator x y w h')],
    [
      'a function',
      () => [...xywh(), iterator(logGets('r', pointFunction()), undefined)],
      () => drawn(673200, 'r.Symbol(Symbol.iterator) @@iterator x y w h r.w r.x r.y r.z'),
    ],
    [
      'a Proxy of an Array',
      () => [...xywh(), logGets('r', [5, 10])],
      () =>
        drawn(658116, 'r.Symbol(Symbol.iterator) x y w h r.Symbol(Symbol.iterator) r.length r.0 r.length r.1 r.length'),
    ],
    [
      'a typed array',
      () => [...xywh(), iterator(new Float64Array([5, 8]), Float64Array.prototype.values)],
      () => drawn(662984, '@@iterator x y w h @@iterator'),
    ],
    // An Array is picked without user code.
    [
      'an Array',
      () => [...xywh(), [logged('r', 5), logGets('s', { x: 4 })]],
      () => drawn(673200, 'x y w h s.w s.x s.y s.z'),
    ],
    [
      'numbers but y and h',
      () => [2, logged('y', 2), 60, logged('h', 44), iterator({}, values(5))],
      () => drawn(667345, '@@iterator y h @@iterator iterate'),
    ],
    // What the overload pick throws comes first.
    [
      'a throwing @@iterator getter',
      () => [
        ...xywh(),
        Object.defineProperty({}, Symbol.iterator, {
          get() {
            log.push('@@iterator')
            throw new Error('@@iterator getter')
          },
        }),
      ],
      () => ({ error: { name: 'Error', message: '@@iterator getter' }, box: null, sum: 0, log: '@@iterator' }),
    ],
    [
      'a non-callable @@iterator after a Symbol x',
      () => [Symbol('x'), 2, 60, 44, iterator({}, 5)],
      (prefix) => ({
        error: { name: 'TypeError', message: prefix + '@@iterator must be a function' },
        box: null,
        sum: 0,
        log: '@@iterator',
      }),
    ],
    [
      'a non-callable @@iterator after a throwing w',
      () => [
        2,
        2,
        {
          valueOf() {
            log.push('w')
            throw new Error('w')
          },
        },
        44,
        iterator({}, 'not callable'),
      ],
      (prefix) => ({
        error: { name: 'TypeError', message: prefix + '@@iterator must be a function' },
        box: null,
        sum: 0,
        log: '@@iterator',
      }),
    ],
    [
      'an iterable after a Symbol x',
      () => [Symbol('x'), 2, 60, 44, iterator({}, values(5))],
      (prefix) => ({
        error: { name: 'TypeError', message: prefix + 'Cannot convert a Symbol value to a number' },
        box: null,
        sum: 0,
        log: '@@iterator',
      }),
    ],
    [
      'a DOMPointInit after a BigInt h',
      () => [2, 2, 60, 1n, iterator({ x: 5 }, undefined)],
      (prefix) => ({
        error: { name: 'TypeError', message: prefix + 'Cannot convert a BigInt value to a number' },
        box: null,
        sum: 0,
        log: '@@iterator',
      }),
    ],
  ]
  for (const [name, args, expected] of cases) {
    t.deepEqual(run(args, false), expected(C), name)
    t.deepEqual(run(args, true), expected(P), name + ' on a Path2D')
  }
  // Calls made while the arguments are converted run in full.
  for (const onPath of [false, true]) {
    log.length = 0
    const ctx = createCanvas(64, 48).getContext('2d')
    const target = onPath ? new Path2D() : ctx
    const inner = () =>
      target.roundRect(logged('ix', 40) as any, 30, 10, logged('ih', 10) as any, iterator({}, values(2)))
    target.roundRect(
      {
        valueOf() {
          log.push('x')
          inner()
          return 2
        },
      } as any,
      2,
      logged('w', 20) as any,
      20,
      iterator(
        {},
        values({
          get x() {
            log.push('r.x')
            inner()
            return 3
          },
        }),
      ),
    )
    if (onPath) ctx.fill(target as Path2D)
    else ctx.fill()
    t.deepEqual(
      { ...ink(ctx), log: log.join(' ') },
      {
        box: [2, 2, 49, 39],
        sum: 126495,
        log: '@@iterator x @@iterator ix ih @@iterator iterate w @@iterator iterate r.x @@iterator ix ih @@iterator iterate',
      },
    )
    log.length = 0
    const ctx2 = createCanvas(64, 48).getContext('2d')
    const target2 = onPath ? new Path2D() : ctx2
    let reads = 0
    const radii = Object.defineProperty({}, Symbol.iterator, {
      get() {
        log.push('@@iterator' + reads)
        if (reads++ === 0) target2.roundRect(logged('ix', 40) as any, 30, logged('iw', 10) as any, 10, 2)
        return values(4)
      },
    })
    target2.roundRect(logged('x', 2) as any, 2, 20, logged('h', 20) as any, radii)
    if (onPath) ctx2.fill(target2 as Path2D)
    else ctx2.fill()
    t.deepEqual(
      { ...ink(ctx2), log: log.join(' ') },
      { box: [2, 2, 49, 39], sum: 123445, log: '@@iterator0 ix iw x h @@iterator1 iterate' },
    )
  }
})

test('CanvasPattern.setTransform names the DOMMatrix2DInit member that fails to convert', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  const pattern = ctx.createPattern(createCanvas(2, 2), 'repeat')!
  const prefix =
    "Failed to execute 'setTransform' on 'CanvasPattern': Failed to read the 'a' property from 'DOMMatrix2DInit': "
  t.throws(() => pattern.setTransform({ a: Symbol() as any }), {
    instanceOf: TypeError,
    message: prefix + 'Cannot convert a Symbol value to a number',
  })
  t.throws(() => pattern.setTransform({ a: 1n as any }), {
    instanceOf: TypeError,
    message: prefix + 'Cannot convert a BigInt value to a number',
  })
})
