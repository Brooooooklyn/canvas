// The published raw entrypoint, require('@napi-rs/canvas/js-binding'), skips
// the index.js wrappers. Its methods take their arguments as written.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// index.js patches the shared prototypes once it is loaded, so the raw
// binding is tested in a fresh process that never loads index.js.
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
run('createImageData(2, 3)', () => size(ctx.createImageData(2, 3)))
run('createImageData(2, 3, settings)', () => size(ctx.createImageData(2, 3, { colorSpace: 'display-p3' })))
run('createImageData(imagedata)', () => size(ctx.createImageData(new ImageData(2, 3))))
run('createImageData(data, 1)', () => size(ctx.createImageData(new Uint8ClampedArray(8), 1)))
run('createImageData()', () => size(ctx.createImageData()))
run('createImageData(imagedata, undefined)', () => size(ctx.createImageData(new ImageData(2, 3), undefined)))
run("createPattern(canvas, 'repeat')", () => ctx.createPattern(source, 'repeat') instanceof CanvasPattern)
run('createPattern(canvas, null)', () => ctx.createPattern(source, null) instanceof CanvasPattern)
run('createPattern(canvas)', () => ctx.createPattern(source))
process.stdout.write(JSON.stringify(out))
`

test('the raw js-binding createImageData and createPattern take positional arguments', (t) => {
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' }))
  t.deepEqual(out, {
    'createImageData(2, 3)': [2, 3, 24, 'srgb'],
    'createImageData(2, 3, settings)': [2, 3, 24, 'display-p3'],
    'createImageData(imagedata)': [2, 3, 24, 'srgb'],
    'createImageData(data, 1)': [1, 2, 8, 'srgb'],
    'createImageData()': {
      error: 'TypeError',
      message:
        "Failed to execute 'createImageData' on 'CanvasRenderingContext2D': 1 argument required, but only 0 present.",
    },
    // Without the argument count that index.js passes, a trailing undefined
    // counts as a missing argument (napi pads missing ones with undefined).
    'createImageData(imagedata, undefined)': [2, 3, 24, 'srgb'],
    "createPattern(canvas, 'repeat')": true,
    'createPattern(canvas, null)': true,
    'createPattern(canvas)': {
      error: 'TypeError',
      message:
        "Failed to execute 'createPattern' on 'CanvasRenderingContext2D': 2 arguments required, but only 1 present.",
    },
  })
})
