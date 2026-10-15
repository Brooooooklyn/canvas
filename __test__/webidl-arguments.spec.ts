// Argument count checks and WebIDL conversion of method arguments.
// Expected values and messages were measured in Chrome 155 on arm64 macOS
// (--disable-gpu; pixel reads on a willReadFrequently canvas).
import test from 'ava'

import { createCanvas, Path2D } from '../index'

// Untyped access for arguments the typings reject on purpose.
const loose = <T>(value: T) => value as any

const CTX = 'CanvasRenderingContext2D'
const execute = (method: string, iface = CTX) => `Failed to execute '${method}' on '${iface}': `
const required = (n: number, present: number) =>
  `${n} argument${n === 1 ? '' : 's'} required, but only ${present} present.`

const context = (width = 10, height = 10) => {
  const ctx = createCanvas(width, height).getContext('2d')
  ctx.fillStyle = '#f00'
  ctx.strokeStyle = '#00f'
  return ctx
}

const pixel = (ctx: ReturnType<typeof context>, x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data)

// [method, required argument count]
const CTX_ARITY: [string, number][] = [
  ['scale', 2],
  ['rotate', 1],
  ['translate', 2],
  ['transform', 6],
  ['clearRect', 4],
  ['fillRect', 4],
  ['strokeRect', 4],
  ['setLineDash', 1],
  ['fillText', 3],
  ['strokeText', 3],
  ['measureText', 1],
  ['moveTo', 2],
  ['lineTo', 2],
  ['quadraticCurveTo', 4],
  ['bezierCurveTo', 6],
  ['arcTo', 5],
  ['rect', 4],
  ['roundRect', 4],
  ['arc', 5],
  ['ellipse', 7],
]

test('context methods throw TypeError for too few arguments', (t) => {
  for (const [method, n] of CTX_ARITY) {
    for (let present = 0; present < n; present++) {
      const ctx = loose(context())
      const error = t.throws(() => ctx[method](...Array(present).fill(1)), {
        instanceOf: TypeError,
        message: `${execute(method)}${required(n, present)}`,
      })
      t.is(String(error.stack).split('\n')[0], `TypeError: ${required(n, present)}`)
      t.deepEqual(Object.keys(error), ['message'])
    }
  }
})

test('the argument count is checked before any conversion', (t) => {
  const ctx = loose(context())
  const log: number[] = []
  const v = (n: number) => ({
    valueOf() {
      log.push(n)
      return n
    },
  })
  t.throws(() => ctx.fillRect(v(1), v(2), v(3)), {
    instanceOf: TypeError,
    message: `${execute('fillRect')}${required(4, 3)}`,
  })
  t.deepEqual(log, [])
})

test('an explicit undefined counts as an argument', (t) => {
  const ctx = loose(context())
  t.notThrows(() => ctx.fillRect(undefined, undefined, undefined, undefined))
  t.notThrows(() => ctx.arc(undefined, undefined, undefined, undefined, undefined))
  t.notThrows(() => ctx.lineTo(1, undefined))
  t.is(ctx.measureText(undefined).width, ctx.measureText('undefined').width)
  t.is(ctx.measureText(null).width, ctx.measureText('null').width)
})

test('a foreign receiver still throws Illegal invocation', (t) => {
  const proto = loose(Object.getPrototypeOf(context()))
  t.throws(() => proto.fillRect.call({}, 0), { instanceOf: TypeError, message: 'Illegal invocation' })
  t.throws(() => proto.fillRect.call({}, 0, 0, 1, 1), { instanceOf: TypeError, message: 'Illegal invocation' })
})

test("context methods have Chrome's length", (t) => {
  const ctx = loose(context())
  for (const [method, n] of CTX_ARITY) {
    t.is(ctx[method].length, n, method)
    t.is(ctx[method].name, method)
  }
})

test('context methods convert arguments with ToNumber', (t) => {
  let ctx = context()
  ctx.fillRect(loose('0'), loose('0'), loose('10'), loose('10'))
  t.deepEqual(pixel(ctx, 5, 5), [255, 0, 0, 255])

  ctx = context()
  ctx.fillRect(loose({ valueOf: () => 1 }), loose([2]), loose(true), loose('4'))
  t.deepEqual(
    [pixel(ctx, 1, 2), pixel(ctx, 1, 5), pixel(ctx, 2, 2)],
    [
      [255, 0, 0, 255],
      [255, 0, 0, 255],
      [0, 0, 0, 0],
    ],
  )

  ctx = context()
  ctx.fillRect(loose(null), loose(null), 5, 5)
  t.deepEqual(pixel(ctx, 0, 0), [255, 0, 0, 255])

  ctx = context()
  ctx.lineWidth = 2
  ctx.strokeRect(loose('2'), loose('2'), loose('6'), loose('6'))
  t.deepEqual(pixel(ctx, 2, 5), [0, 0, 255, 255])

  ctx = context()
  ctx.fillRect(0, 0, 10, 10)
  ctx.clearRect(loose('0'), loose('0'), loose('5'), loose('5'))
  t.deepEqual(pixel(ctx, 2, 2), [0, 0, 0, 0])

  ctx = context()
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(loose('1'), loose('5'))
  ctx.lineTo(loose('9'), loose('5'))
  ctx.stroke()
  t.deepEqual(pixel(ctx, 5, 5), [0, 0, 255, 255])

  ctx = context()
  ctx.beginPath()
  ctx.rect(loose('0'), loose('0'), loose('10'), loose('10'))
  ctx.fill()
  t.deepEqual(pixel(ctx, 5, 5), [255, 0, 0, 255])

  ctx = context()
  ctx.beginPath()
  ctx.arc(loose('5'), loose('5'), loose('4'), loose('0'), loose('7'))
  ctx.fill()
  t.deepEqual(pixel(ctx, 5, 5), [255, 0, 0, 255])

  // anticlockwise is a boolean: the string 'false' is true.
  ctx = context()
  ctx.beginPath()
  ctx.moveTo(5, 5)
  ctx.arc(5, 5, 4, 0, Math.PI / 2, loose('false'))
  ctx.fill()
  t.deepEqual(
    [pixel(ctx, 5, 8), pixel(ctx, 2, 2)],
    [
      [0, 0, 0, 0],
      [255, 0, 0, 255],
    ],
  )

  ctx = context()
  ctx.beginPath()
  ctx.ellipse(loose('5'), loose('5'), loose('4'), loose('4'), loose('0'), loose('0'), loose('7'))
  ctx.fill()
  t.deepEqual(pixel(ctx, 5, 5), [255, 0, 0, 255])

  ctx = context()
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, 5)
  ctx.quadraticCurveTo(loose('5'), loose('5'), loose('10'), loose('5'))
  ctx.stroke()
  t.deepEqual(pixel(ctx, 5, 5), [0, 0, 255, 255])

  ctx = context()
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, 5)
  ctx.bezierCurveTo(loose('3'), loose('5'), loose('6'), loose('5'), loose('10'), loose('5'))
  ctx.stroke()
  t.deepEqual(pixel(ctx, 5, 5), [0, 0, 255, 255])

  ctx = context()
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, 5)
  ctx.arcTo(loose('5'), loose('5'), loose('10'), loose('5'), loose('1'))
  ctx.lineTo(10, 5)
  ctx.stroke()
  t.deepEqual(pixel(ctx, 5, 5), [0, 0, 255, 255])

  ctx = context()
  ctx.beginPath()
  ctx.roundRect(loose('0'), loose('0'), loose('10'), loose('10'))
  ctx.fill()
  t.deepEqual(pixel(ctx, 5, 5), [255, 0, 0, 255])

  ctx = context()
  ctx.translate(loose('2'), loose('3'))
  t.deepEqual([ctx.getTransform().e, ctx.getTransform().f], [2, 3])

  ctx = context()
  ctx.scale(loose('2'), loose('3'))
  t.deepEqual([ctx.getTransform().a, ctx.getTransform().d], [2, 3])

  // The matrix is f32 here and double in Chrome (0.8775825618903728,
  // 0.479425538604203): the transform item.
  ctx = context()
  ctx.rotate(loose('0.5'))
  t.true(Math.abs(ctx.getTransform().a - 0.8775825618903728) < 1e-6)
  t.true(Math.abs(ctx.getTransform().b - 0.479425538604203) < 1e-6)

  ctx = context()
  ctx.transform(loose('2'), loose('0'), loose('0'), loose('2'), loose('1'), loose('1'))
  const m = ctx.getTransform()
  t.deepEqual([m.a, m.d, m.e], [2, 2, 1])

  ctx = context()
  ctx.font = '10px sans-serif'
  ctx.fillText(loose(5), loose('0'), loose('9'))
  t.true(ctx.measureText(loose(5)).width > 0)
})

test('method arguments throw a prefixed TypeError for Symbol and BigInt', (t) => {
  const ctx = loose(context(4, 4))
  const fillRect = execute('fillRect')
  for (const [args, message] of [
    [[Symbol('s'), 0, 1, 1], 'Cannot convert a Symbol value to a number'],
    [[1n, 0, 1, 1], 'Cannot convert a BigInt value to a number'],
    [[{ valueOf: () => Symbol('s') }, 0, 1, 1], 'Cannot convert a Symbol value to a number'],
    [[{ valueOf: () => ({}), toString: () => ({}) }, 0, 1, 1], 'Cannot convert object to primitive value'],
  ] as const) {
    t.throws(() => ctx.fillRect(...args), { instanceOf: TypeError, message: `${fillRect}${message}` })
  }
  t.throws(
    () =>
      ctx.fillRect(
        {
          valueOf() {
            throw new RangeError('boom')
          },
        },
        0,
        1,
        1,
      ),
    { instanceOf: RangeError, message: 'boom' },
  )
  t.throws(
    () =>
      ctx.fillRect(
        {
          valueOf() {
            throw new TypeError('mine')
          },
        },
        0,
        1,
        1,
      ),
    { instanceOf: TypeError, message: 'mine' },
  )
  t.throws(() => ctx.fillText(Symbol('s'), 0, 0), {
    instanceOf: TypeError,
    message: `${execute('fillText')}Cannot convert a Symbol value to a string`,
  })
  t.throws(() => ctx.measureText(Symbol('s')), {
    instanceOf: TypeError,
    message: `${execute('measureText')}Cannot convert a Symbol value to a string`,
  })
  // anticlockwise is a boolean: ToBoolean never throws.
  t.notThrows(() => ctx.arc(1, 1, 1, 0, 1, Symbol('s')))
  // The arguments are converted in order, and the first error stops it.
  const log: unknown[] = []
  const v = (n: number) => ({
    valueOf() {
      log.push(n)
      return n
    },
  })
  try {
    ctx.fillRect(v(1), v(2), Symbol('s'), v(4))
  } catch (e) {
    log.push((e as Error).name)
  }
  t.deepEqual(log, [1, 2, 'TypeError'])
})

test('a non-callable Symbol.toPrimitive argument is read once', (t) => {
  const NOT_A_FUNCTION =
    "'5' returned for property 'Symbol(Symbol.toPrimitive)' of object '#<Object>' is not a function"
  const source = createCanvas(1, 1)
  const calls: [string, (ctx: any, value: unknown) => void][] = [
    ['fillRect', (ctx, value) => ctx.fillRect(value, 0, 1, 1)],
    ['fill', (ctx, value) => ctx.fill(value)],
    ['isPointInPath', (ctx, value) => ctx.isPointInPath(value, 0)],
    ['drawImage', (ctx, value) => ctx.drawImage(source, value, 0)],
  ]
  for (const [method, call] of calls) {
    // Its getter returns 5 (not callable) on the first read and throws on
    // any later read.
    let reads = 0
    const value = {
      get [Symbol.toPrimitive]() {
        reads++
        if (reads === 1) return 5
        throw new RangeError('Symbol.toPrimitive read again')
      },
    }
    // Chrome 155 reads it once and throws the engine's TypeError.
    const error = t.throws(() => call(context(4, 4), value), {
      instanceOf: TypeError,
      message: execute(method) + NOT_A_FUNCTION,
    })
    t.is(reads, 1, method)
    t.is(String(error.stack).split('\n')[0], `TypeError: ${NOT_A_FUNCTION}`)
  }
})

test('method arguments run valueOf before they borrow the context', (t) => {
  const ctx = context(4, 4)
  ctx.globalAlpha = 0.3
  ctx.fillStyle = '#00f'
  ctx.fillRect(
    loose({
      valueOf() {
        ctx.save()
        ctx.restore()
        return 1
      },
    }),
    1,
    1,
    1,
  )
  t.deepEqual(pixel(ctx, 1, 1), [0, 0, 255, 77])
})

const ENUM_ERROR = (value: string) => `The provided value '${value}' is not a valid enum value of type CanvasFillRule.`
const NOT_PATH = "parameter 1 is not of type 'Path2D'."

// A path whose center (5, 5) is inside for nonzero and outside for evenodd.
const ruleContext = () => {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.fillStyle = '#f00'
  ctx.beginPath()
  ctx.rect(0, 0, 10, 10)
  ctx.rect(2, 2, 6, 6)
  return ctx
}
const rulePath = () => {
  const path = new Path2D()
  path.rect(0, 0, 10, 10)
  path.rect(2, 2, 6, 6)
  return path
}
const centerAlpha = (ctx: ReturnType<typeof ruleContext>) => ctx.getImageData(5, 5, 1, 1).data[3]

// [arguments, alpha at the center or an error message]
const FILL_RULE_CASES: [() => unknown[], number | string][] = [
  [() => [], 255],
  [() => ['nonzero'], 255],
  [() => ['evenodd'], 0],
  [() => ['bogus'], ENUM_ERROR('bogus')],
  [() => ['EVENODD'], ENUM_ERROR('EVENODD')],
  [() => [undefined], 255],
  [() => [null], ENUM_ERROR('null')],
  [() => [5], ENUM_ERROR('5')],
  [() => [{ toString: () => 'evenodd' }], 0],
  [() => [{}], ENUM_ERROR('[object Object]')],
  [() => [undefined, 'evenodd'], NOT_PATH],
  [() => ['evenodd', undefined], NOT_PATH],
  [() => ['evenodd', 'bogus'], NOT_PATH],
  [() => [{}, 'evenodd'], NOT_PATH],
  [() => [null, 'evenodd'], NOT_PATH],
  [() => [rulePath()], 255],
  [() => [rulePath(), 'evenodd'], 0],
  [() => [rulePath(), 'bogus'], ENUM_ERROR('bogus')],
  [() => [rulePath(), undefined], 255],
  [() => [rulePath(), null], ENUM_ERROR('null')],
  [() => [rulePath(), 'evenodd', 'extra'], 0],
]

test('fill and clip take a CanvasFillRule and an optional Path2D', (t) => {
  for (const method of ['fill', 'clip'] as const) {
    for (const [args, expected] of FILL_RULE_CASES) {
      const ctx = ruleContext()
      const call = () => {
        loose(ctx)[method](...args())
        if (method === 'clip') ctx.fillRect(0, 0, 10, 10)
        return centerAlpha(ctx)
      }
      if (typeof expected === 'number') {
        t.is(call(), expected, `${method}(${args().map(String)})`)
      } else {
        const error = t.throws(call, { instanceOf: TypeError, message: `${execute(method)}${expected}` })
        t.is(String(error.stack).split('\n')[0], `TypeError: ${expected}`)
      }
    }
  }
})

test('stroke with an argument needs a Path2D', (t) => {
  for (const value of [{}, null, undefined, 5]) {
    const ctx = ruleContext()
    t.throws(() => ctx.stroke(loose(value)), {
      instanceOf: TypeError,
      message: `${execute('stroke')}${NOT_PATH}`,
    })
  }
  const ctx = ruleContext()
  ctx.lineWidth = 2
  t.notThrows(() => ctx.stroke(rulePath()))
})

test('isPointInPath overloads', (t) => {
  const ctx = loose(ruleContext())
  const ipp = execute('isPointInPath')
  t.is(ctx.isPointInPath(5, 5), true)
  t.is(ctx.isPointInPath(5, 5, 'evenodd'), false)
  t.is(ctx.isPointInPath(5, 5, undefined), true)
  t.is(ctx.isPointInPath(rulePath(), 5, 5), true)
  t.is(ctx.isPointInPath(rulePath(), 5, 5, 'evenodd'), false)
  t.is(ctx.isPointInPath(rulePath(), 5), false)
  t.is(ctx.isPointInPath(rulePath(), 5, undefined), false)
  t.is(ctx.isPointInPath('5', '5', 'evenodd'), false)
  t.is(ctx.isPointInPath(NaN, 5), false)
  t.is(ctx.isPointInPath(Infinity, 5), false)
  for (const [args, message] of [
    [[5, 5, 'bogus'], ENUM_ERROR('bogus')],
    [[5, 5, null], ENUM_ERROR('null')],
    [[rulePath(), 5, 5, 'bogus'], ENUM_ERROR('bogus')],
    [[{}, 5, 5], ENUM_ERROR('5')],
    [[null, 5, 5], ENUM_ERROR('5')],
    [[5, 5, 5, 'evenodd'], NOT_PATH],
  ] as const) {
    t.throws(() => ctx.isPointInPath(...args), { instanceOf: TypeError, message: `${ipp}${message}` })
  }
})

test('isPointInStroke overloads', (t) => {
  const ctx = loose(ruleContext())
  ctx.lineWidth = 2
  t.is(ctx.isPointInStroke(0, 5), true)
  t.is(ctx.isPointInStroke(rulePath(), 0, 5), true)
  t.is(ctx.isPointInStroke(rulePath(), 0), false)
  t.is(ctx.isPointInStroke(NaN, 5), false)
  for (const args of [
    [{}, 0, 5],
    [0, 5, 7],
    [0, 5, undefined],
  ]) {
    t.throws(() => ctx.isPointInStroke(...args), {
      instanceOf: TypeError,
      message: `${execute('isPointInStroke')}${NOT_PATH}`,
    })
  }
})

test("fill, clip, stroke, isPointInPath and isPointInStroke have Chrome's length", (t) => {
  const ctx = ruleContext()
  t.deepEqual(
    [ctx.fill.length, ctx.clip.length, ctx.stroke.length, ctx.isPointInPath.length, ctx.isPointInStroke.length],
    [0, 0, 0, 2, 2],
  )
  for (const method of ['isPointInPath', 'isPointInStroke']) {
    t.throws(() => loose(ctx)[method](1), {
      instanceOf: TypeError,
      message: `${execute(method)}${required(2, 1)}`,
    })
  }
})

// [method, required argument count]
const PATH_ARITY: [string, number][] = [
  ['moveTo', 2],
  ['lineTo', 2],
  ['quadraticCurveTo', 4],
  ['bezierCurveTo', 6],
  ['arcTo', 5],
  ['rect', 4],
  ['roundRect', 4],
  ['arc', 5],
  ['ellipse', 7],
]

test('Path2D methods throw TypeError for too few arguments', (t) => {
  for (const [method, count] of PATH_ARITY) {
    const error = t.throws(() => loose(new Path2D())[method](...Array(count - 1).fill(1)), {
      instanceOf: TypeError,
      message: `${execute(method, 'Path2D')}${required(count, count - 1)}`,
    })
    t.is(String(error.stack).split('\n')[0], `TypeError: ${required(count, count - 1)}`)
    t.deepEqual(Object.keys(error), ['message'])
  }
  t.throws(() => loose(new Path2D()).moveTo(), {
    instanceOf: TypeError,
    message: `${execute('moveTo', 'Path2D')}${required(2, 0)}`,
  })
  // The count is checked before any argument is converted.
  const log: number[] = []
  const value = (n: number) => ({
    valueOf() {
      log.push(n)
      return n
    },
  })
  t.throws(() => loose(new Path2D()).rect(value(1), value(2), value(3)), { instanceOf: TypeError })
  t.deepEqual(log, [])
  // A foreign receiver throws 'Illegal invocation' first.
  for (const args of [[1, 2], [1]]) {
    t.throws(() => Path2D.prototype.moveTo.call({}, ...args), { instanceOf: TypeError, message: 'Illegal invocation' })
  }
})

test("Path2D methods have Chrome's length", (t) => {
  const path = loose(new Path2D())
  t.deepEqual(
    PATH_ARITY.map(([method]) => path[method].length),
    PATH_ARITY.map(([, count]) => count),
  )
})

test('Path2D methods convert arguments with ToNumber', (t) => {
  const fillAlpha = (build: (path: any) => void) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    const path = new Path2D()
    build(path)
    ctx.fill(path)
    return ctx.getImageData(5, 5, 1, 1).data[3]
  }
  const builds: ((path: any) => void)[] = [
    (p) => {
      p.moveTo('0', '0')
      p.lineTo('10', '0')
      p.lineTo('10', '10')
      p.lineTo('0', '10')
    },
    (p) => p.rect('0', '0', '10', '10'),
    (p) => p.arc('5', '5', '4', '0', '7'),
    (p) => p.ellipse('5', '5', '4', '4', '0', '0', '7'),
    (p) => {
      p.moveTo(0, 0)
      p.quadraticCurveTo('10', '0', '10', '10')
      p.lineTo(0, 10)
    },
    (p) => {
      p.moveTo(0, 0)
      p.bezierCurveTo('10', '0', '10', '0', '10', '10')
      p.lineTo(0, 10)
    },
    (p) => {
      p.moveTo(0, 0)
      p.arcTo('10', '0', '10', '10', '1')
      p.lineTo(10, 10)
      p.lineTo(0, 10)
    },
    (p) => p.roundRect('0', '0', '10', '10'),
    (p) => p.rect([0], null, { valueOf: () => 10 }, '10'),
  ]
  t.deepEqual(
    builds.map((build) => fillAlpha(build)),
    builds.map(() => 255),
  )

  const log: (number | string)[] = []
  const value = (n: number) => ({
    valueOf() {
      log.push(n)
      return n
    },
  })
  // anticlockwise is a boolean: ToBoolean runs no user code.
  loose(new Path2D()).ellipse(
    value(1),
    value(2),
    value(3),
    value(4),
    value(5),
    value(6),
    value(7),
    loose({
      valueOf() {
        log.push('anticlockwise')
        return 1
      },
    }),
  )
  t.deepEqual(log.splice(0), [1, 2, 3, 4, 5, 6, 7])

  const symbol = 'Cannot convert a Symbol value to a number'
  const error = t.throws(() => loose(new Path2D()).arc(Symbol(), 0, 1, 0, 1), {
    instanceOf: TypeError,
    message: `${execute('arc', 'Path2D')}${symbol}`,
  })
  t.is(String(error.stack).split('\n')[0], `TypeError: ${symbol}`)
  t.deepEqual(Object.keys(error), ['message'])
  t.throws(() => loose(new Path2D()).bezierCurveTo(value(1), value(2), Symbol(), value(4), value(5), value(6)), {
    instanceOf: TypeError,
    message: `${execute('bezierCurveTo', 'Path2D')}${symbol}`,
  })
  t.deepEqual(log.splice(0), [1, 2])
  t.throws(() => loose(new Path2D()).lineTo(1n, 0), {
    instanceOf: TypeError,
    message: `${execute('lineTo', 'Path2D')}Cannot convert a BigInt value to a number`,
  })
  // undefined is NaN: no exception.
  const path = loose(new Path2D())
  t.notThrows(() => path.arc(undefined, undefined, undefined, undefined, undefined))
  t.notThrows(() => path.ellipse(undefined, undefined, undefined, undefined, undefined, undefined, undefined))
  t.notThrows(() => path.arcTo(undefined, undefined, undefined, undefined, undefined))
  t.notThrows(() => path.moveTo(undefined, undefined))
})

test('Path2D arc and ellipse convert anticlockwise with ToBoolean', (t) => {
  // A pie from 0 to PI/2: clockwise covers (7, 7), anticlockwise (3, 3).
  const pie = (method: 'arc' | 'ellipse', anticlockwise: unknown) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    const path = loose(new Path2D())
    path.moveTo(5, 5)
    if (method === 'arc') {
      path.arc(5, 5, 4, 0, Math.PI / 2, anticlockwise)
    } else {
      path.ellipse(5, 5, 4, 4, 0, 0, Math.PI / 2, anticlockwise)
    }
    ctx.fill(path)
    return [ctx.getImageData(3, 3, 1, 1).data[3], ctx.getImageData(7, 7, 1, 1).data[3]]
  }
  const clockwise = [0, 255]
  const counter = [255, 0]
  for (const [value, expected] of [
    [undefined, clockwise],
    [false, clockwise],
    [true, counter],
    ['', clockwise],
    ['x', counter],
    [0, clockwise],
    [1, counter],
    [{}, counter],
    [null, clockwise],
    [NaN, clockwise],
  ] as const) {
    t.deepEqual(pie('arc', value), expected, String(value))
  }
  t.deepEqual(pie('ellipse', 'x'), counter)
  t.deepEqual(pie('ellipse', 0), clockwise)
})
