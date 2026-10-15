// The published raw entrypoint, require('@napi-rs/canvas/js-binding'), skips
// the index.js wrappers. Its methods take their arguments as written.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import test from 'ava'

import { createCanvas, ImageData } from '../index'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const CREATE_IMAGE_DATA = "Failed to execute 'createImageData' on 'CanvasRenderingContext2D': "
const CREATE_PATTERN = "Failed to execute 'createPattern' on 'CanvasRenderingContext2D': "
const FILL = "Failed to execute 'fill' on 'CanvasRenderingContext2D': "

// index.js patches the shared prototypes once it is loaded, so the raw
// binding is tested in a fresh process that never loads index.js.
const runRaw = (body: string) => {
  const script = `
const { CanvasElement, CanvasPattern, ImageData } = require('./js-binding.js')
const ctx = new CanvasElement(4, 4).getContext('2d')
const source = new CanvasElement(2, 2)
const out = {}
const run = (name, fn) => {
  try {
    out[name] = fn()
  } catch (e) {
    out[name] = { error: e.constructor.name, message: e.message }
  }
}
const size = (d) => [d.width, d.height, d.data.length, d.colorSpace]
${body}
process.stdout.write(JSON.stringify(out))
`
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' }))
}

test('the raw js-binding createImageData and createPattern take positional arguments', (t) => {
  const out = runRaw(`
run('createImageData(2, 3)', () => size(ctx.createImageData(2, 3)))
run('createImageData(2, 3, settings)', () => size(ctx.createImageData(2, 3, { colorSpace: 'display-p3' })))
run('createImageData(imagedata)', () => size(ctx.createImageData(new ImageData(2, 3))))
run('createImageData(data, 1)', () => size(ctx.createImageData(new Uint8ClampedArray(8), 1)))
run('createImageData()', () => size(ctx.createImageData()))
run('createImageData(imagedata, undefined)', () => size(ctx.createImageData(new ImageData(2, 3), undefined)))
run("createPattern(canvas, 'repeat')", () => ctx.createPattern(source, 'repeat') instanceof CanvasPattern)
run('createPattern(canvas, null)', () => ctx.createPattern(source, null) instanceof CanvasPattern)
run('createPattern(canvas)', () => ctx.createPattern(source))
`)
  t.deepEqual(out, {
    'createImageData(2, 3)': [2, 3, 24, 'srgb'],
    'createImageData(2, 3, settings)': [2, 3, 24, 'display-p3'],
    'createImageData(imagedata)': [2, 3, 24, 'srgb'],
    // No typed array form: the array is ToNumber'd as sw ('0,0,...' is NaN).
    'createImageData(data, 1)': {
      error: 'TypeError',
      message: `${CREATE_IMAGE_DATA}Value is not of type 'long'.`,
    },
    'createImageData()': {
      error: 'TypeError',
      message: `${CREATE_IMAGE_DATA}1 argument required, but only 0 present.`,
    },
    // Without the argument count that index.js passes, a trailing undefined
    // counts as a missing argument (napi pads missing ones with undefined).
    'createImageData(imagedata, undefined)': [2, 3, 24, 'srgb'],
    "createPattern(canvas, 'repeat')": true,
    'createPattern(canvas, null)': true,
    'createPattern(canvas)': {
      error: 'TypeError',
      message: `${CREATE_PATTERN}2 arguments required, but only 1 present.`,
    },
  })
})

test('the raw js-binding createImageData has no typed array form for huge sizes', (t) => {
  // Without a trailing undefined, the raw method counts as index.js does:
  // the values Chrome gives.
  const out = runRaw(`
run('createImageData(u8c(0), 2 ** 31, 2 ** 31)', () => size(ctx.createImageData(new Uint8ClampedArray(0), 2 ** 31, 2 ** 31)))
run('createImageData(u8c(0), 65536, 65536)', () => size(ctx.createImageData(new Uint8ClampedArray(0), 65536, 65536)))
run('createImageData(u8c([16]), 2 ** 25)', () => size(ctx.createImageData(new Uint8ClampedArray([16]), 2 ** 25)))
`)
  t.deepEqual(out, {
    'createImageData(u8c(0), 2 ** 31, 2 ** 31)': {
      error: 'TypeError',
      message: `${CREATE_IMAGE_DATA}Value is outside the 'long' value range.`,
    },
    'createImageData(u8c(0), 65536, 65536)': {
      error: 'TypeError',
      message: `${CREATE_IMAGE_DATA}The provided value is not of type 'ImageDataSettings'.`,
    },
    'createImageData(u8c([16]), 2 ** 25)': {
      error: 'RangeError',
      message: `${CREATE_IMAGE_DATA}Out of memory at ImageData creation`,
    },
  })
})

test('the raw js-binding ImageData class takes positional arguments', (t) => {
  // index.js exports a native function that checks new and the real argument
  // count; the class itself only sees padded arguments.
  const out = runRaw(`
run('new ImageData(1)', () => size(new ImageData(1)))
run('new ImageData(1, 1, {}, undefined)', () => size(new ImageData(1, 1, {}, undefined)))
run('new ImageData(data, 1).data', () => {
  const a = new Uint8ClampedArray(4)
  return new ImageData(a, 1).data === a
})
run('new ImageData(u16, 1, 1, {})', () => size(new ImageData(new Uint16Array(4), 1, 1, {})))
`)
  t.deepEqual(out, {
    'new ImageData(1)': {
      error: 'TypeError',
      message: "Failed to construct 'ImageData': 2 arguments required, but only 1 present.",
    },
    // Without the argument count that index.js passes, a trailing undefined
    // counts as a missing argument.
    'new ImageData(1, 1, {}, undefined)': [1, 1, 4, 'srgb'],
    'new ImageData(data, 1).data': true,
    'new ImageData(u16, 1, 1, {})': {
      error: 'TypeError',
      message: "Failed to construct 'ImageData': Overload resolution failed.",
    },
  })
})

// Values for the argument after the positional ones: createImageData's 5th
// and createPattern's 3rd.
const EXTRA = [0, 2, 'x', {}]

test('an extra raw js-binding argument does not change the overload', (t) => {
  // index.js passes the argument count in that slot. A value a raw caller
  // puts there is only an extra argument, ignored.
  const out = runRaw(`
for (const [i, x] of ${JSON.stringify(EXTRA)}.entries()) {
  run('createImageData(imagedata, u, u, u, x) ' + i, () =>
    size(ctx.createImageData(new ImageData(2, 3), undefined, undefined, undefined, x)))
  run('createImageData(u, u, u, u, x) ' + i, () => ctx.createImageData(undefined, undefined, undefined, undefined, x))
  run('createPattern(canvas, u, x) ' + i, () => ctx.createPattern(source, undefined, x))
}
`)
  const expected: Record<string, unknown> = {}
  for (const i of EXTRA.keys()) {
    expected[`createImageData(imagedata, u, u, u, x) ${i}`] = [2, 3, 24, 'srgb']
    expected[`createImageData(u, u, u, u, x) ${i}`] = {
      error: 'TypeError',
      message: `${CREATE_IMAGE_DATA}1 argument required, but only 0 present.`,
    }
    expected[`createPattern(canvas, u, x) ${i}`] = {
      error: 'TypeError',
      message: `${CREATE_PATTERN}2 arguments required, but only 1 present.`,
    }
  }
  t.deepEqual(out, expected)
})

test('only a marker from _argumentCounts() is read as an argument count', (t) => {
  // The markers that index.js passes are objects: ArrayBuffers over memory
  // of the addon. Native code reads a marker's count from where its data
  // starts, which script cannot choose: it never reads another value there
  // as a count, and nothing script does to a marker gives it another count.
  const out = runRaw(`
const binding = require('./js-binding.js')
const { types } = require('node:util')
const markers = binding._argumentCounts()
run('markers', () => markers.map((m) => [typeof m, types.isExternal(m)]))
// createImageData(imagedata, undefined) is the (sw, sh) form with a count
// of 2, the (imagedata) form with a count of 1.
const withCount = (x) => size(ctx.createImageData(new ImageData(2, 3), undefined, undefined, undefined, x))
run('marker 1', () => withCount(markers[1]))
run('marker 2', () => withCount(markers[2]))
run('marker 2 of another call', () => withCount(binding._argumentCounts()[2]))
const traps = []
const TRAPS = ['get', 'has', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'ownKeys']
const handler = Object.fromEntries(TRAPS.map((trap) => [trap, (...args) => (traps.push(trap), Reflect[trap](...args))]))
const others = {
  'Object.create(marker 2)': () => Object.create(markers[2]),
  'Proxy of marker 2': () => new Proxy(markers[2], handler),
  'copy of marker 2': () => ({ ...markers[2] }),
  'structuredClone(marker 2)': () => structuredClone(markers[2]),
  '[marker 2]': () => [markers[2]],
  ImageData: () => new ImageData(2, 2),
  canvas: () => source,
  context: () => ctx,
  2: () => 2,
  'slice of marker 2': () => markers[2].slice(0),
  'Uint8Array of marker 2': () => new Uint8Array(markers[2]),
  'DataView of marker 2': () => new DataView(markers[2]),
  ArrayBuffer: () => new ArrayBuffer(1),
  SharedArrayBuffer: () => new SharedArrayBuffer(1),
  Buffer: () => Buffer.alloc(1),
  'ArrayBuffer of a Buffer': () => Buffer.alloc(1).buffer,
  function: () => () => 2,
  symbol: () => Symbol('2'),
}
for (const [name, make] of Object.entries(others)) run(name, () => withCount(make()))
run('traps', () => traps)
run('changed marker 1', () => {
  const marker = markers[1]
  new Uint8Array(marker)[0] = 2
  Object.setPrototypeOf(marker, markers[2])
  Object.defineProperty(marker, 'valueOf', { value: () => 2 })
  Object.freeze(marker)
  return withCount(marker)
})
// transfer() to another length copies; to the same length it may move the
// memory, and the count with it.
run('marker 2 transferred to length 2', () => withCount(binding._argumentCounts()[2].transfer(2)))
const moved = binding._argumentCounts()[2]
run('marker 2 transferred to length 1', () => withCount(moved.transfer()))
run('marker 2 after its transfer', () => withCount(moved))
// A marker has no native object behind it: with the prototype of Path2D it
// still is not a Path2D.
run('marker 2 with the prototype of Path2D', () => {
  ctx.fill(Object.setPrototypeOf(binding._argumentCounts()[2], binding.Path.prototype))
})
`)
  const counted2 = { error: 'TypeError', message: `${CREATE_IMAGE_DATA}Value is not of type 'long'.` }
  const counted1 = [2, 3, 24, 'srgb']
  const { 'marker 2 transferred to length 1': moved, ...rest } = out
  t.true([counted1, counted2].some((count) => isDeepStrictEqual(moved, count)))
  t.deepEqual(rest, {
    markers: Array.from({ length: 10 }, () => ['object', false]),
    'marker 1': counted1,
    'marker 2': counted2,
    'marker 2 of another call': counted2,
    // Not a marker: an extra argument, and the count is up to the last
    // argument that is not undefined.
    'Object.create(marker 2)': counted1,
    'Proxy of marker 2': counted1,
    'copy of marker 2': counted1,
    'structuredClone(marker 2)': counted1,
    '[marker 2]': counted1,
    ImageData: counted1,
    canvas: counted1,
    context: counted1,
    2: counted1,
    'slice of marker 2': counted1,
    'Uint8Array of marker 2': counted1,
    'DataView of marker 2': counted1,
    ArrayBuffer: counted1,
    SharedArrayBuffer: counted1,
    Buffer: counted1,
    'ArrayBuffer of a Buffer': counted1,
    function: counted1,
    symbol: counted1,
    traps: [],
    'changed marker 1': counted1,
    'marker 2 transferred to length 2': counted1,
    'marker 2 after its transfer': counted1,
    'marker 2 with the prototype of Path2D': {
      error: 'TypeError',
      message: `${FILL}The provided value '[object Object]' is not a valid enum value of type CanvasFillRule.`,
    },
  })
})

test('through index.js, the same calls use the real argument count, as in Chrome', (t) => {
  // Measured in Chrome 155: 5 arguments select createImageData(sw, sh, ...),
  // and 3 arguments to createPattern make the repetition 'undefined'.
  const ctx = createCanvas(4, 4).getContext('2d') as any
  const source = createCanvas(2, 2)
  for (const x of EXTRA) {
    t.throws(() => ctx.createImageData(new ImageData(2, 3), undefined, undefined, undefined, x), {
      instanceOf: TypeError,
      message: `${CREATE_IMAGE_DATA}Value is not of type 'long'.`,
    })
    t.throws(() => ctx.createImageData(undefined, undefined, undefined, undefined, x), {
      instanceOf: TypeError,
      message: `${CREATE_IMAGE_DATA}Value is not of type 'long'.`,
    })
    t.throws(() => ctx.createPattern(source, undefined, x), {
      instanceOf: DOMException,
      name: 'SyntaxError',
      message: `${CREATE_PATTERN}The provided type ('undefined') is not one of 'repeat', 'no-repeat', 'repeat-x', or 'repeat-y'.`,
    })
    t.is(ctx.createImageData(2, 3, undefined, undefined, x).width, 2)
    t.true(ctx.createPattern(source, 'repeat', x) !== null)
  }
  // Fewer arguments: a trailing undefined still counts.
  t.throws(() => ctx.createImageData(new ImageData(2, 3), undefined), {
    instanceOf: TypeError,
    message: `${CREATE_IMAGE_DATA}Value is not of type 'long'.`,
  })
  t.throws(() => ctx.createImageData(undefined), {
    instanceOf: TypeError,
    message: `${CREATE_IMAGE_DATA}parameter 1 is not of type 'ImageData'.`,
  })
  t.throws(() => ctx.createPattern(source, undefined), {
    instanceOf: DOMException,
    name: 'SyntaxError',
  })
})

test('the raw js-binding setTransform and addPath also take a matrix dictionary', (t) => {
  // index.js reads the dictionary itself and passes six numbers. A raw call
  // may pass the dictionary in place of the first number.
  const out = runRaw(`
const { Path } = require('./js-binding.js')
const matrix = () => { const m = ctx.getTransform(); return [m.a, m.b, m.c, m.d, m.e, m.f] }
run('setTransform(1, 2, 3, 4, 5, 6)', () => (ctx.setTransform(1, 2, 3, 4, 5, 6), matrix()))
run('setTransform({ a: 2, d: 3, e: 4 })', () => (ctx.setTransform({ a: 2, d: 3, e: 4 }), matrix()))
run('setTransform(getTransform())', () => {
  ctx.setTransform(1, 0, 0, 2, 3, 4)
  const m = ctx.getTransform()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.setTransform(m)
  return matrix()
})
run('setTransform({ a: 1, m11: 2 })', () => ctx.setTransform({ a: 1, m11: 2 }))
const square = new Path()
square.rect(0, 0, 1, 1)
const bounds = (...args) => { const p = new Path(); p.addPath(square, ...args); return p.computeTightBounds() }
run('addPath(path)', () => bounds())
run('addPath(path, { e: 5, f: 6 })', () => bounds({ e: 5, f: 6 }))
run('addPath(path, { a: 1, m11: 2 })', () => bounds({ a: 1, m11: 2 }))
`)
  t.deepEqual(out, {
    'setTransform(1, 2, 3, 4, 5, 6)': [1, 2, 3, 4, 5, 6],
    'setTransform({ a: 2, d: 3, e: 4 })': [2, 0, 0, 3, 4, 0],
    'setTransform(getTransform())': [1, 0, 0, 2, 3, 4],
    'setTransform({ a: 1, m11: 2 })': {
      error: 'TypeError',
      message:
        "Failed to execute 'setTransform' on 'CanvasRenderingContext2D': Property mismatch on matrix initialization.",
    },
    'addPath(path)': [0, 0, 1, 1],
    'addPath(path, { e: 5, f: 6 })': [5, 6, 6, 7],
    'addPath(path, { a: 1, m11: 2 })': {
      error: 'TypeError',
      message: "Failed to execute 'addPath' on 'Path2D': Property mismatch on matrix initialization.",
    },
  })
})
