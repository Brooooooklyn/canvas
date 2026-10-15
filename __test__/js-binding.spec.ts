// The published raw entrypoint, require('@napi-rs/canvas/js-binding'), skips
// the index.js wrappers. Its methods take their arguments as written.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, ImageData } from '../index'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const CREATE_IMAGE_DATA = "Failed to execute 'createImageData' on 'CanvasRenderingContext2D': "
const CREATE_PATTERN = "Failed to execute 'createPattern' on 'CanvasRenderingContext2D': "

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
    'createImageData(data, 1)': [1, 2, 8, 'srgb'],
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
