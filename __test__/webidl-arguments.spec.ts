// Argument count checks and WebIDL conversion of method arguments.
// Expected values and messages were measured in Chrome 155 (--disable-gpu;
// pixel reads on a willReadFrequently canvas), the same on arm64 and x64.
import test from 'ava'

import { createCanvas } from '../index'

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
