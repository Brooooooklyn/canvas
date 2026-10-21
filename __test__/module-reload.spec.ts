import { createRequire } from 'node:module'

import test, { type ExecutionContext } from 'ava'

import type { SKRSContext2D } from '../index'

// https://github.com/Brooooooklyn/canvas/issues/1394
// Jest re-evaluates the package per test file: the .js modules are dropped
// from require.cache and index.js runs again, while the .node binding (and
// the native class prototypes index.js wraps) stays loaded. Each wrapper
// must capture the native method again, not the previous wrapper: the
// padding wrappers forward a full argument list plus an ARGUMENT_COUNTS
// marker, so wrapping a wrapper corrupts the argument count the native
// method reads (drawImage(source, 0, 0) reached the 9-argument overload and
// drew nothing).

const require = createRequire(import.meta.url)

// The package's .js files; the .node binding stays cached.
const PACKAGE_FILES = ['../index.js', '../js-binding.js', '../geometry.js', '../load-image.js', '../node-canvas.js']

function reload() {
  for (const file of PACKAGE_FILES) {
    delete require.cache[require.resolve(file)]
  }
  return require('../index.js') as typeof import('../index')
}

const BLUE = [0, 0, 255, 255]

function blueSource(api: ReturnType<typeof reload>) {
  const source = api.createCanvas(4, 4)
  const sourceCtx = source.getContext('2d')
  sourceCtx.fillStyle = '#0000ff'
  sourceCtx.fillRect(0, 0, 4, 4)
  return source
}

async function assertHealthy(t: ExecutionContext, api: ReturnType<typeof reload>, load: number) {
  const label = `load ${load}`
  const { createCanvas, Path2D, DOMMatrix, SvgExportFlag } = api

  for (const [form, draw] of [
    ['3-argument', (ctx: SKRSContext2D) => ctx.drawImage(blueSource(api), 0, 0)],
    ['5-argument', (ctx: SKRSContext2D) => ctx.drawImage(blueSource(api), 0, 0, 4, 4)],
    ['9-argument', (ctx: SKRSContext2D) => ctx.drawImage(blueSource(api), 0, 0, 4, 4, 0, 0, 4, 4)],
  ] as const) {
    const canvas = createCanvas(4, 4)
    const ctx = canvas.getContext('2d')
    draw(ctx)
    t.deepEqual(Array.from(ctx.getImageData(0, 0, 1, 1).data), BLUE, `${label}: drawImage ${form} draws`)
  }

  const ctx = createCanvas(4, 4).getContext('2d')
  ctx.rect(0, 0, 4, 4)
  t.notThrows(() => ctx.fill(), `${label}: fill()`)
  t.notThrows(() => ctx.clip(), `${label}: clip()`)
  t.notThrows(() => ctx.stroke(), `${label}: stroke()`)
  t.notThrows(
    () => ctx.putImageData(ctx.createImageData(1, 1), 0, 0),
    `${label}: putImageData(createImageData(1, 1), 0, 0)`,
  )
  t.truthy(ctx.createPattern(createCanvas(4, 4), 'repeat'), `${label}: createPattern(canvas, 'repeat')`)
  const gradient = ctx.createLinearGradient(0, 0, 4, 4)
  t.notThrows(() => gradient.addColorStop(0, 'red'), `${label}: addColorStop(0, 'red')`)
  t.is(typeof ctx.isPointInPath(0, 0), 'boolean', `${label}: isPointInPath(0, 0) returns a boolean`)
  t.is(typeof ctx.isPointInStroke(0, 0), 'boolean', `${label}: isPointInStroke(0, 0) returns a boolean`)
  t.notThrows(() => ctx.setTransform(1, 0, 0, 1, 0, 0), `${label}: setTransform(1, 0, 0, 1, 0, 0)`)
  t.notThrows(() => ctx.setTransform({}), `${label}: setTransform({})`)
  t.notThrows(() => new Path2D().addPath(new Path2D()), `${label}: addPath(path)`)
  t.true(ctx.getTransform() instanceof DOMMatrix, `${label}: getTransform() returns a DOMMatrix`)

  // A requireArguments wrapper keeps its argument-count check, with the error
  // naming the method, on every load.
  const arcError = t.throws(() => (ctx.arc as () => void)(), { instanceOf: TypeError }, `${label}: arc() throws`)
  t.is(
    arcError.message,
    "Failed to execute 'arc' on 'CanvasRenderingContext2D': 5 arguments required, but only 0 present.",
    `${label}: the arc argument-count error names 'arc'`,
  )

  // canvasBrand regression: the toBlob receiver check must call the native
  // getContext, so the argument-count error names 'toBlob', not 'getContext'.
  const canvas = createCanvas(1, 1)
  const error = t.throws(() => (canvas.toBlob as () => void)(), { instanceOf: TypeError }, `${label}: toBlob() throws`)
  t.is(
    error.message,
    "Failed to execute 'toBlob' on 'HTMLCanvasElement': 1 argument required, but only 0 present.",
    `${label}: the toBlob argument-count error names 'toBlob'`,
  )

  // index.js wraps SVGCanvas.getContext in the same loop as CanvasElement's.
  const svgCanvas = createCanvas(4, 4, SvgExportFlag.NoPrettyXML)
  const svgCtx = svgCanvas.getContext('2d')
  svgCtx.fillStyle = '#0000ff'
  svgCtx.fillRect(0, 0, 4, 4)
  t.deepEqual(Array.from(svgCtx.getImageData(0, 0, 1, 1).data), BLUE, `${label}: SVGCanvas.getContext('2d') draws`)

  // toBlob and convertToBlob on the success path: wrapped twice, toBlob would
  // read the type argument as the callback and convertToBlob would nest the
  // inner wrapper's Blob, encoding 'undefined' instead of a PNG.
  const converted = await canvas.convertToBlob()
  t.true(converted instanceof Blob, `${label}: convertToBlob() returns a Blob`)
  t.is(converted.type, 'image/png', `${label}: convertToBlob() encodes a PNG`)
  t.deepEqual(
    Array.from(new Uint8Array(await converted.arrayBuffer()).subarray(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${label}: convertToBlob() encodes real PNG data`,
  )
  const blobbed = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve))
  t.true(blobbed instanceof Blob, `${label}: toBlob(callback) calls back a Blob`)
  t.is(blobbed?.type, 'image/png', `${label}: toBlob(callback) encodes a PNG`)

  // The native-method stash must stay an own, non-enumerable symbol property
  // of each wrapped prototype: Object.keys and for...in stay unaffected.
  const stash = Symbol.for('@napi-rs/canvas:native-methods')
  for (const [name, proto] of [
    ['CanvasElement', Object.getPrototypeOf(canvas)],
    ['SVGCanvas', Object.getPrototypeOf(svgCanvas)],
    ['CanvasRenderingContext2D', Object.getPrototypeOf(ctx)],
    ['CanvasGradient', Object.getPrototypeOf(gradient)],
    ['Path2D', Object.getPrototypeOf(new Path2D())],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, stash)
    t.truthy(descriptor, `${label}: ${name}.prototype has the native-method stash`)
    t.is(descriptor?.enumerable, false, `${label}: the native-method stash on ${name}.prototype is non-enumerable`)
  }
}

test('wrappers capture the native methods on every evaluation of the module', async (t) => {
  for (const load of [1, 2, 3]) {
    await assertHealthy(t, reload(), load)
  }
})
