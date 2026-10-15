// Path2D.addPath(path, transform) (Blink path_2d.idl:35, path_2d.h:80-91):
// `optional DOMMatrix2DInit transform = {}` read like
// DOMMatrixReadOnly::fromMatrix2D; a non-finite matrix adds nothing. Every
// expected value was measured in Chrome 155 CPU canvas (--disable-gpu,
// getContext('2d', { willReadFrequently: true })) in a standards-mode page;
// Chrome arm64 and x64 give the same values.
import test from 'ava'

import { createCanvas, DOMMatrix, Path2D } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const PREFIX = "Failed to execute 'addPath' on 'Path2D': "

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

/**
 * On a 60x60 canvas: `f(p, q, ctx)` with an empty Path2D p and q =
 * rect(0, 0, 10, 10), then fill(p) (also after a stroke in `f`). The error
 * `f` throws ({ name, message } or null) and the ink.
 */
function run(f: (p: Path2D, q: Path2D, ctx: Ctx) => void) {
  const ctx = createCanvas(60, 60).getContext('2d')
  const p = new Path2D()
  const q = new Path2D()
  q.rect(0, 0, 10, 10)
  let error = null
  try {
    f(p, q, ctx)
    ctx.fill(p)
  } catch (e: any) {
    error = { name: e.name, message: e.message }
  }
  return { error, ...ink(ctx) }
}

const added = (box: number[] | null, sum: number) => ({ error: null, box, sum })
const typeError = (message: string) => ({ error: { name: 'TypeError', message: PREFIX + message }, box: null, sum: 0 })

test('addPath(path, dict) fills missing members from the identity', (t) => {
  const square = added([0, 0, 9, 9], 25500)
  t.deepEqual(
    run((p, q) => p.addPath(q)),
    square,
  )
  t.deepEqual(
    run((p, q) => p.addPath(q, undefined)),
    square,
  )
  t.deepEqual(
    run((p, q) => (p.addPath as any)(q, null)),
    square,
  )
  t.deepEqual(
    run((p, q) => p.addPath(q, { a: 2 } as any)),
    added([0, 0, 19, 9], 51000),
  )
  t.deepEqual(
    run((p, q) => p.addPath(q, { a: 2, b: 0, c: 0, d: 2, e: 5, f: 5 })),
    added([5, 5, 24, 24], 102000),
  )
  t.deepEqual(
    run((p, q) => p.addPath(q, { m41: 20 } as any)),
    added([20, 0, 29, 9], 25500),
  )
  t.deepEqual(
    run((p, q) => p.addPath(q, { b: 0.5, c: 0.25, e: 10, f: 5 } as any)),
    added([10, 5, 22, 19], 22325),
  )
  t.deepEqual(
    run((p, q) => p.addPath(q, { a: '2', e: '5' } as any)),
    added([5, 0, 24, 9], 51000),
  )
  // DOMMatrix2DInit: the 3D members are not read.
  t.deepEqual(
    run((p, q) => p.addPath(q, { m33: 3, a: 2 } as any)),
    added([0, 0, 19, 9], 51000),
  )
  t.deepEqual(
    run((p, q) => p.addPath(q, new DOMMatrix([1, 0, 0, 1, 30, 30]))),
    added([30, 30, 39, 39], 25500),
  )
  t.deepEqual(
    run((p, q) => p.addPath(q, new DOMMatrix([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 5, 5, 0, 1]))),
    added([5, 5, 24, 24], 102000),
  )
})

test('addPath with a non-finite matrix adds nothing', (t) => {
  t.deepEqual(
    run((p, q) => p.addPath(q, { a: NaN } as any)),
    added(null, 0),
  )
  t.deepEqual(
    run((p, q) => p.addPath(q, { e: Infinity } as any)),
    added(null, 0),
  )
  // A finite value outside the float range is infinite as a float: then the
  // path has no finite bounds and nothing of it is drawn.
  for (const transform of [{ a: 1e39 }, { e: 1e39 }]) {
    t.deepEqual(
      run((p, q) => {
        p.addPath(q, transform as any)
        p.rect(40, 40, 5, 5)
      }),
      added(null, 0),
      JSON.stringify(transform),
    )
  }
  // Two NaNs agree; then the matrix is not finite.
  t.deepEqual(
    run((p, q) => p.addPath(q, { a: NaN, m11: NaN, e: 5 } as any)),
    added(null, 0),
  )
})

test('addPath checks a and m11 (and so on) agree', (t) => {
  t.deepEqual(
    run((p, q) => p.addPath(q, { a: 1, m11: 2 } as any)),
    typeError('Property mismatch on matrix initialization.'),
  )
  t.deepEqual(
    run((p, q) => p.addPath(q, { a: NaN, m11: 1 } as any)),
    typeError('Property mismatch on matrix initialization.'),
  )
})

test('addPath of the path itself', (t) => {
  t.deepEqual(
    run((p) => {
      p.rect(4, 4, 10, 10)
      p.addPath(p, { e: 20 } as any)
    }),
    added([4, 4, 33, 13], 51000),
  )
  t.deepEqual(
    run((p) => {
      p.rect(4, 4, 10, 10)
      p.addPath(p)
    }),
    added([4, 4, 13, 13], 25500),
  )
  // Stroked, lineWidth 2.
  const ctx = createCanvas(60, 60).getContext('2d')
  const p = new Path2D()
  p.rect(5, 5, 10, 10)
  p.addPath(p, { e: 20 } as any)
  ctx.lineWidth = 2
  ctx.stroke(p)
  t.deepEqual(ink(ctx), { box: [4, 4, 35, 15], sum: 40800 })
})

test('addPath reads the path after the matrix getters ran', (t) => {
  t.deepEqual(
    run((p) => {
      p.rect(0, 0, 10, 10)
      p.addPath(p, {
        get f() {
          p.rect(30, 0, 10, 10)
          return 30
        },
      } as any)
    }),
    added([0, 0, 39, 39], 102000),
  )
  t.deepEqual(
    run((p, q) => {
      p.addPath(q, {
        get e() {
          q.rect(30, 30, 10, 10)
          return 0
        },
      } as any)
    }),
    added([0, 0, 39, 39], 51000),
  )
})

test('addPath keeps the open subpath of the added path', (t) => {
  t.deepEqual(
    run((p, _, ctx) => {
      const s = new Path2D()
      s.moveTo(5, 5)
      s.lineTo(30, 5)
      p.moveTo(40, 40)
      p.addPath(s, { f: 20 } as any)
      p.lineTo(50, 50)
      ctx.lineWidth = 4
      ctx.stroke(p)
    }),
    added([5, 23, 51, 51], 111426),
  )
})

test('addPath takes a Path2D subclass', (t) => {
  class Sub extends Path2D {}
  t.deepEqual(
    run((p) => {
      const s = new Sub()
      s.rect(30, 30, 10, 10)
      p.addPath(s)
    }),
    added([30, 30, 39, 39], 25500),
  )
})

test('addPath argument errors', (t) => {
  const notPath = typeError("parameter 1 is not of type 'Path2D'.")
  for (const path of [{}, null, undefined, 5, Object.create(Path2D.prototype)]) {
    t.deepEqual(
      run((p) => (p.addPath as any)(path)),
      notPath,
      String(path),
    )
  }
  t.deepEqual(
    run((p) => (p.addPath as any)({}, {})),
    notPath,
  )
  t.deepEqual(
    run((p) => (p.addPath as any)({}, 5)),
    notPath,
  )
  // The path is checked before any matrix getter runs.
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
  t.deepEqual(
    run((p) => (p.addPath as any)(5, proxy)),
    notPath,
  )
  t.is(log.join(), '')
  t.deepEqual(
    run((p, q) => p.addPath(q, proxy as any)),
    added([0, 0, 9, 9], 25500),
  )
  t.is(log.join(), 'a,b,c,d,e,f,m11,m12,m21,m22,m41,m42')
  t.deepEqual(
    run((p, q) => (p.addPath as any)(q, 5)),
    typeError("The provided value is not of type 'DOMMatrix2DInit'."),
  )
  t.deepEqual(
    run((p, q) => p.addPath(q, { e: Symbol() } as any)),
    typeError("Failed to read the 'e' property from 'DOMMatrix2DInit': Cannot convert a Symbol value to a number"),
  )
  t.deepEqual(
    run((p) => (p.addPath as any)()),
    typeError('1 argument required, but only 0 present.'),
  )
  t.throws(() => Path2D.prototype.addPath.call({}, new Path2D()), {
    instanceOf: TypeError,
    message: 'Illegal invocation',
  })
})

test('addPath reads a DOMMatrix member by member, as any other dictionary', (t) => {
  const m = new DOMMatrix([1, 0, 0, 1, 30, 30])
  Object.defineProperty(m, 'a', { value: 2 })
  t.deepEqual(
    run((p, q) => p.addPath(q, m)),
    typeError('Property mismatch on matrix initialization.'),
  )
  // A Proxy is read through its get trap only.
  const log: string[] = []
  const proxy = new Proxy(
    { e: 30, f: 30 },
    {
      getPrototypeOf() {
        log.push('getPrototypeOf')
        throw new Error('trap')
      },
      get(target, key, receiver) {
        if (typeof key === 'string') log.push(key)
        return Reflect.get(target, key, receiver)
      },
    },
  )
  t.deepEqual(
    run((p, q) => p.addPath(q, proxy as any)),
    added([30, 30, 39, 39], 25500),
  )
  t.is(log.join(), 'a,b,c,d,e,f,m11,m12,m21,m22,m41,m42')
})

test('addPath checks the receiver and the path before it reads the matrix', (t) => {
  const log: string[] = []
  const matrix = {
    get a() {
      log.push('a')
      return 1
    },
  }
  t.throws(() => Path2D.prototype.addPath.call({}, new Path2D(), matrix as any), {
    instanceOf: TypeError,
    message: 'Illegal invocation',
  })
  t.throws(() => Path2D.prototype.addPath.call(new Path2D(), {} as any, matrix as any), {
    instanceOf: TypeError,
    message: `${PREFIX}parameter 1 is not of type 'Path2D'.`,
  })
  t.is(log.join(), '')
})

test('addPath errors keep the bare text in the stack, as Chrome', (t) => {
  const p = new Path2D()
  const q = new Path2D()
  const cases: [unknown[], string, string][] = [
    [
      [q, { a: 1, m11: 2 }],
      'Property mismatch on matrix initialization.',
      'Property mismatch on matrix initialization.',
    ],
    [
      [q, 5],
      "The provided value is not of type 'DOMMatrix2DInit'.",
      "The provided value is not of type 'DOMMatrix2DInit'.",
    ],
    [
      [q, { e: Symbol() }],
      'Cannot convert a Symbol value to a number',
      "Failed to read the 'e' property from 'DOMMatrix2DInit': Cannot convert a Symbol value to a number",
    ],
    [[{}, { a: 2 }], "parameter 1 is not of type 'Path2D'.", "parameter 1 is not of type 'Path2D'."],
    [[{}], "parameter 1 is not of type 'Path2D'.", "parameter 1 is not of type 'Path2D'."],
  ]
  for (const [args, bare, message] of cases) {
    const error = t.throws(() => (p.addPath as any)(...args), { instanceOf: TypeError })!
    t.is(String(error.stack).split('\n')[0], `TypeError: ${bare}`)
    t.is(error.message, PREFIX + message)
    t.deepEqual(Object.keys(error), ['message'])
  }
})

test("addPath conversion errors keep the engine's text, as Chrome", (t) => {
  // A non-callable @@toPrimitive: V8 names the object in its own way.
  class Foo {}
  const text = (returned: string, object: string) =>
    `'${returned}' returned for property 'Symbol(Symbol.toPrimitive)' of object '${object}' is not a function`
  const cases: [object, unknown, string][] = [
    [new Foo(), 5, text('5', '#<Foo>')],
    [[], 5, text('5', '[object Array]')],
    [Object.create(null), 5, text('5', '[object Object]')],
    [{}, [1, 2], text('[object Array]', '#<Object>')],
  ]
  for (const [object, toPrimitive, bare] of cases) {
    ;(object as any)[Symbol.toPrimitive] = toPrimitive
    const error = t.throws(() => new Path2D().addPath(new Path2D(), { e: object } as any), {
      instanceOf: TypeError,
    })!
    t.is(error.message, `${PREFIX}Failed to read the 'e' property from 'DOMMatrix2DInit': ${bare}`)
    t.is(String(error.stack).split('\n')[0], `TypeError: ${bare}`)
    t.deepEqual(Object.keys(error), ['message'])
  }
})

test("addPath has Chrome's length and name", (t) => {
  t.is(Path2D.prototype.addPath.length, 1)
  t.is(Path2D.prototype.addPath.name, 'addPath')
})
