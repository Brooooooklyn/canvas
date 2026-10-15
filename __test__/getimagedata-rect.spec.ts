// getImageData(sx, sy, sw, sh): [EnforceRange] long arguments, truncated
// before a negative size flips the rect, int overflow checks, and
// transparent black for a rect outside the canvas (getImageDataInternal,
// base_rendering_context_2d.cc). Expected values were measured in Chrome 155
// (--disable-gpu, willReadFrequently, arm64 = x64).
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, ImageData, SvgExportFlag } from '../index'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const GET = "Failed to execute 'getImageData' on 'CanvasRenderingContext2D': "

// Untyped access for arguments the typings reject on purpose.
const loose = (value: unknown) => value as any

// 4x4 canvas, pixel (x, y) = rgb(10 * (x + 1), 10 * (y + 1), 0).
const grid = (w = 4, h = 4) => {
  const ctx = createCanvas(w, h).getContext('2d')
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      ctx.fillStyle = `rgb(${10 * (x + 1)},${10 * (y + 1)},0)`
      ctx.fillRect(x, y, 1, 1)
    }
  }
  return ctx
}

// [width, height, ...data]
const read = (fn: () => ImageData) => {
  try {
    const d = fn()
    return [d.width, d.height, ...Array.from(d.data)]
  } catch (e: any) {
    return { ctor: e?.constructor?.name, name: e?.name, code: e?.code, msg: String(e?.message) }
  }
}
const error = (ctor: string, name: string, msg: string, code?: number) => ({ ctor, name, code, msg: GET + msg })

test('getImageData truncates its arguments before it flips a negative size', (t) => {
  const cases: [number[], number[]][] = [
    [
      [2, 0, -1.5, 1],
      [1, 1, 20, 10, 0, 255],
    ],
    [
      [0, 2, 1, -1.5],
      [1, 1, 10, 20, 0, 255],
    ],
    [
      [3, 0, -2.5, 1],
      [2, 1, 20, 10, 0, 255, 30, 10, 0, 255],
    ],
    [
      [1.9, 0, 1, 1],
      [1, 1, 20, 10, 0, 255],
    ],
    [
      [2.5, 0, -1.5, 1],
      [1, 1, 20, 10, 0, 255],
    ],
    [
      [-0.5, 0, 1, 1],
      [1, 1, 10, 10, 0, 255],
    ],
    [
      [0, 0, 1.9, 1],
      [1, 1, 10, 10, 0, 255],
    ],
    [
      [1, 0, -1, 1],
      [1, 1, 10, 10, 0, 255],
    ],
    [
      [1, 1, -1, -1],
      [1, 1, 10, 10, 0, 255],
    ],
    [
      [4, 0, -4.7, 1],
      [4, 1, 10, 10, 0, 255, 20, 10, 0, 255, 30, 10, 0, 255, 40, 10, 0, 255],
    ],
    [
      [3.99, 3.99, -2.99, -2.99],
      [2, 2, 20, 20, 0, 255, 30, 20, 0, 255, 20, 30, 0, 255, 30, 30, 0, 255],
    ],
    [
      [-1.5, 0, 2, 1],
      [2, 1, 0, 0, 0, 0, 10, 10, 0, 255],
    ],
    [
      [2, 0, -3, 1],
      [3, 1, 0, 0, 0, 0, 10, 10, 0, 255, 20, 10, 0, 255],
    ],
    [
      [1, 0, -3, 1],
      [3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 10, 10, 0, 255],
    ],
    [
      [-1.5, -0.5, 2, 1],
      [2, 1, 0, 0, 0, 0, 10, 10, 0, 255],
    ],
    [
      [4, 4, -1, -1],
      [1, 1, 40, 40, 0, 255],
    ],
  ]
  for (const [args, expected] of cases) {
    const [x, y, w, h] = args
    t.deepEqual(
      read(() => grid().getImageData(x, y, w, h)),
      expected,
      `getImageData(${args.join(', ')})`,
    )
  }
  // ToNumber, then truncation.
  t.deepEqual(
    read(() => grid().getImageData(0, 0, loose('2'), 1)),
    [2, 1, 10, 10, 0, 255, 20, 10, 0, 255],
  )
  t.deepEqual(
    read(() => grid().getImageData(0, 0, loose({ valueOf: () => 2 }), 1)),
    [2, 1, 10, 10, 0, 255, 20, 10, 0, 255],
  )
  // -0 and -0.9 are 0.
  const flat = createCanvas(2, 2).getContext('2d')
  flat.fillStyle = 'rgb(1,2,3)'
  flat.fillRect(0, 0, 2, 2)
  t.deepEqual(
    read(() => flat.getImageData(-0, -0.9, 1, 1)),
    [1, 1, 1, 2, 3, 255],
  )
  t.deepEqual(
    read(() => flat.getImageData(-0.9, 0, 1.9, 1.9)),
    [1, 1, 1, 2, 3, 255],
  )
})

test('getImageData converts its arguments in order, before it reads', (t) => {
  const log: string[] = []
  const v = (tag: string, value: number) => ({
    valueOf() {
      log.push(tag)
      return value
    },
  })
  grid().getImageData(
    loose(v('sx', 0)),
    loose(v('sy', 0)),
    loose(v('sw', 1)),
    loose(v('sh', 1)),
    loose({
      get colorSpace() {
        log.push('cs')
        return 'srgb'
      },
    }),
  )
  t.deepEqual(log, ['sx', 'sy', 'sw', 'sh', 'cs'])
  const order: string[] = []
  const w = (tag: string, value: number) => ({
    valueOf() {
      order.push(tag)
      return value
    },
  })
  try {
    grid().getImageData(loose(w('sx', 0)), loose(w('sy', NaN)), loose(w('sw', 1)), loose(w('sh', 1)))
  } catch (e: any) {
    order.push(e.constructor.name)
  }
  t.deepEqual(order, ['sx', 'sy', 'TypeError'])
  // A valueOf may draw on the same context.
  const ctx = createCanvas(2, 2).getContext('2d')
  const got = ctx.getImageData(
    loose({
      valueOf() {
        ctx.fillStyle = 'red'
        ctx.fillRect(0, 0, 2, 2)
        return 0
      },
    }),
    0,
    1,
    1,
  )
  t.deepEqual(Array.from(got.data), [255, 0, 0, 255])
})

test('getImageData throws IndexSizeError for a size that truncates to 0', (t) => {
  const width = error('DOMException', 'IndexSizeError', 'The source width is 0.', 1)
  const height = error('DOMException', 'IndexSizeError', 'The source height is 0.', 1)
  t.deepEqual(
    read(() => grid().getImageData(0, 0, -0.5, 1)),
    width,
  )
  t.deepEqual(
    read(() => grid().getImageData(0, 0, 0.5, 1)),
    width,
  )
  t.deepEqual(
    read(() => grid().getImageData(0, 0, -0, 1)),
    width,
  )
  t.deepEqual(
    read(() => grid().getImageData(0, 0, 1, -0.9)),
    height,
  )
})

test('getImageData of a rect outside the canvas gives transparent black', (t) => {
  const cases: [number[], number[]][] = [
    [
      [0, 0, -1, 1],
      [1, 1, 0, 0, 0, 0],
    ],
    [
      [2 ** 31 - 1, 0, -1, 1],
      [1, 1, 0, 0, 0, 0],
    ],
    [
      [-(2 ** 31), 0, 1, 1],
      [1, 1, 0, 0, 0, 0],
    ],
    [
      [0, 0, -1, -1],
      [1, 1, 0, 0, 0, 0],
    ],
    [
      [1e9, 0, 1, 1],
      [1, 1, 0, 0, 0, 0],
    ],
    [
      [0.999, 0, -1.999, 1],
      [1, 1, 0, 0, 0, 0],
    ],
    [
      [-5, 0, 2, 1],
      [2, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    ],
    [
      [10, 10, 2, 2],
      [2, 2, ...Array(16).fill(0)],
    ],
    [
      [-1, -1, 3, 3],
      [3, 3, ...Array(16).fill(0), 10, 10, 0, 255, 20, 10, 0, 255, 0, 0, 0, 0, 10, 20, 0, 255, 20, 20, 0, 255],
    ],
  ]
  for (const [args, expected] of cases) {
    const [x, y, w, h] = args
    t.deepEqual(
      read(() => grid().getImageData(x, y, w, h)),
      expected,
      `getImageData(${args.join(', ')})`,
    )
  }
  // At each edge.
  const edge = createCanvas(4, 4).getContext('2d')
  edge.fillStyle = 'rgb(9,8,7)'
  edge.fillRect(0, 0, 4, 4)
  for (const [x, y] of [
    [4, 0],
    [0, 4],
    [-1, 0],
    [0, -1],
  ]) {
    t.deepEqual(
      read(() => edge.getImageData(x, y, 1, 1)),
      [1, 1, 0, 0, 0, 0],
      `edge ${x}, ${y}`,
    )
  }
  t.deepEqual(
    read(() => edge.getImageData(3, 3, 1, 1)),
    [1, 1, 9, 8, 7, 255],
  )
  // In the requested color space.
  const p3 = createCanvas(2, 2).getContext('2d', { colorSpace: 'display-p3' })
  const outside = p3.getImageData(5, 5, 1, 1)
  t.deepEqual([outside.colorSpace, ...Array.from(outside.data)], ['display-p3', 0, 0, 0, 0])
  const srgb = p3.getImageData(5, 5, 1, 1, { colorSpace: 'srgb' })
  t.deepEqual([srgb.colorSpace, ...Array.from(srgb.data)], ['srgb', 0, 0, 0, 0])
  const p3Read = grid().getImageData(10, 0, 1, 1, { colorSpace: 'display-p3' })
  t.deepEqual([p3Read.colorSpace, ...Array.from(p3Read.data)], ['display-p3', 0, 0, 0, 0])
  // alpha: false: outside is still transparent black.
  const opaque = createCanvas(2, 2).getContext('2d', { alpha: false })
  opaque.fillStyle = 'rgb(10,20,30)'
  opaque.fillRect(0, 0, 2, 2)
  t.deepEqual(
    read(() => opaque.getImageData(10, 10, 1, 1)),
    [1, 1, 0, 0, 0, 0],
  )
  t.deepEqual(
    read(() => opaque.getImageData(-1, 0, 2, 1)),
    [2, 1, 0, 0, 0, 0, 10, 20, 30, 255],
  )
  // A read outside does not stop later reads.
  const after = grid()
  t.deepEqual(
    read(() => after.getImageData(-3, 0, 2, 1)),
    [2, 1, 0, 0, 0, 0, 0, 0, 0, 0],
  )
  t.deepEqual(Array.from(after.getImageData(0, 0, 1, 1).data), [10, 10, 0, 255])
  // A large rect far outside.
  const far = createCanvas(4, 4).getContext('2d').getImageData(1000000, 0, 1000, 1000)
  t.deepEqual([far.width, far.height, far.data.length, far.data.every((v) => v === 0)], [1000, 1000, 4000000, true])
  const big = grid().getImageData(100, 100, 1000, 1000)
  t.deepEqual([big.width, big.height, big.data.length], [1000, 1000, 4000000])
})

test('getImageData sizes above 2^24 keep every pixel', (t) => {
  const wide = createCanvas(4, 4).getContext('2d').getImageData(0, 0, 16777217, 1)
  t.deepEqual([wide.width, wide.height, wide.data.length], [16777217, 1, 67108868])
  const tall = createCanvas(4, 4).getContext('2d').getImageData(0, 0, 1, 16777217)
  t.deepEqual([tall.width, tall.height, tall.data.length], [1, 16777217, 67108868])
  const flipped = grid().getImageData(16777217, 0, -16777216, 1)
  t.deepEqual(
    [flipped.width, flipped.height, flipped.data.length, ...Array.from(flipped.data.slice(4, 8))],
    [16777216, 1, 67108864, 30, 10, 0, 255],
  )
})

test('getImageData long conversion and int overflow errors', (t) => {
  const oom = error('RangeError', 'RangeError', 'Out of memory at ImageData creation')
  const cases: [unknown[], object][] = [
    // CheckAdd(sx, sw) and the flips overflow an int.
    [[2 ** 31 - 1, 0, 1, 1], oom],
    [[-(2 ** 31), 0, -1, 1], oom],
    [[2 ** 30, 0, 2 ** 30, 1], oom],
    [[-2147483648, 0, -1, 1], oom],
    // CheckMul(sw, sh).
    [[0, 0, -2147483648, -2147483648], oom],
    // ValidateAndCreate: 4 * sw * sh does not fit (with a period).
    [[0, 0, -(2 ** 31), 1], error('RangeError', 'RangeError', 'Out of memory at ImageData creation.')],
    [[2147483647, 0, -2147483648, 1], error('RangeError', 'RangeError', 'Out of memory at ImageData creation.')],
    [
      [-2147483648, -2147483648, 2147483647, 1],
      error('RangeError', 'RangeError', 'Out of memory at ImageData creation.'),
    ],
    // [EnforceRange] long.
    [[NaN, 0, 1, 1], error('TypeError', 'TypeError', "Value is not of type 'long'.")],
    [[0, 0, Infinity, 1], error('TypeError', 'TypeError', "Value is infinite and not of type 'long'.")],
    [[0, 0, 2 ** 31, 1], error('TypeError', 'TypeError', "Value is outside the 'long' value range.")],
    [[0, 0, 1e10, 1], error('TypeError', 'TypeError', "Value is outside the 'long' value range.")],
    [[0, 0, Symbol('s'), 1], error('TypeError', 'TypeError', 'Cannot convert a Symbol value to a number')],
    [[0, 0, BigInt(1), 1], error('TypeError', 'TypeError', 'Cannot convert a BigInt value to a number')],
    [
      [{ valueOf: () => ({}), toString: () => ({}) }, 0, 1, 1],
      error('TypeError', 'TypeError', 'Cannot convert object to primitive value'),
    ],
    [
      [{ valueOf: () => Symbol('s') }, 0, 1, 1],
      error('TypeError', 'TypeError', 'Cannot convert a Symbol value to a number'),
    ],
  ]
  for (const [args, expected] of cases) {
    t.deepEqual(
      read(() => (grid() as any).getImageData(...args)),
      expected,
      `getImageData(${args.map((a) => (typeof a === 'object' ? 'object' : String(a))).join(', ')})`,
    )
  }
  // A user error from valueOf passes as it is.
  t.throws(
    () =>
      grid().getImageData(
        loose({
          valueOf() {
            throw new RangeError('mine')
          },
        }),
        0,
        1,
        1,
      ),
    { instanceOf: RangeError, message: 'mine' },
  )
  // Conversion errors keep the bare message in the stack.
  const ctx = createCanvas(2, 2).getContext('2d')
  for (const [args, msg] of [
    [[NaN, 0, 1, 1], "Value is not of type 'long'."],
    [[0, 0, Symbol('s'), 1], 'Cannot convert a Symbol value to a number'],
  ] as [unknown[], string][]) {
    const e = t.throws(() => (ctx as any).getImageData(...args))
    t.is(String(e?.stack).split('\n')[0], `TypeError: ${msg}`)
  }
  const zero = t.throws(() => ctx.getImageData(0, 0, 0, 1))
  t.is(String(zero?.stack).split('\n')[0], `IndexSizeError: ${GET}The source width is 0.`)
  // So do the RangeErrors.
  for (const [args, msg] of [
    [[2 ** 31 - 1, 0, 1, 1], 'Out of memory at ImageData creation'],
    [[0, 0, -2147483648, -2147483648], 'Out of memory at ImageData creation'],
    [[-(2 ** 31), 0, -1, 1], 'Out of memory at ImageData creation'],
    [[0, 0, -(2 ** 31), 1], 'Out of memory at ImageData creation.'],
  ] as [number[], string][]) {
    const e = t.throws(() => ctx.getImageData(args[0], args[1], args[2], args[3]), {
      instanceOf: RangeError,
      message: GET + msg,
    })
    t.is(String(e?.stack).split('\n')[0], `RangeError: ${msg}`)
  }
})

test('getImageData on an SVG canvas reads its raster mirror the same way', (t) => {
  // The sibling backend of Context::get_image_data. Chrome has none; the
  // rules are the 2D context's.
  const ctx = createCanvas(4, 4, SvgExportFlag.ConvertTextToPaths).getContext('2d')
  ctx.fillStyle = 'rgb(10,20,30)'
  ctx.fillRect(0, 0, 4, 4)
  t.deepEqual(
    read(() => ctx.getImageData(1, 1, 1, 1)),
    [1, 1, 10, 20, 30, 255],
  )
  t.deepEqual(
    read(() => ctx.getImageData(-1, 0, 2, 1)),
    [2, 1, 0, 0, 0, 0, 10, 20, 30, 255],
  )
  t.deepEqual(
    read(() => ctx.getImageData(2, 0, -1.5, 1)),
    [1, 1, 10, 20, 30, 255],
  )
  t.deepEqual(
    read(() => ctx.getImageData(10, 10, 1, 1)),
    [1, 1, 0, 0, 0, 0],
  )
})

test('getImageData on a PDF page throws NotSupportedError instead of crashing', (t) => {
  // A PDF page has no pixels (and Chrome has no PDF page). It used to read
  // through a null surface and crash the process.
  const script = `
const { PDFDocument } = require('./index.js')
const doc = new PDFDocument()
const ctx = doc.beginPage(4, 4)
ctx.fillStyle = 'rgb(10,20,30)'
ctx.fillRect(0, 0, 4, 4)
const out = []
for (const args of [[1, 1, 1, 1], [-1, 0, 2, 1], [10, 10, 1, 1], [2, 0, -1.5, 1]]) {
  try {
    ctx.getImageData(...args)
    out.push('no error')
  } catch (e) {
    out.push([e.constructor.name, e.name, e.code, e.message])
  }
}
process.stdout.write(JSON.stringify(out))
`
  const { status, signal, stdout, stderr } = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DISABLE_SYSTEM_FONTS_LOAD: '1' },
  })
  t.is(status, 0, `status=${status} signal=${signal}\n${stderr}`)
  const expected = ['DOMException', 'NotSupportedError', 9, 'getImageData() is not supported on a PDF page']
  t.deepEqual(JSON.parse(stdout), [expected, expected, expected, expected])
})
