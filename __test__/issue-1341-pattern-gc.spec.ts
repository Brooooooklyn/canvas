import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, DOMMatrix, Image } from '../index'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function runInChildProcess(
  script: string,
  nodeArgs: string[] = [],
  timeoutMs = 180_000,
): Promise<{
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, '-e', script], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Child process timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr })
    })
  })
}

// A pattern cloned into the save()/restore() state stack must keep its backing
// pixels alive after the JS CanvasPattern is garbage-collected (issue #1341).
test('fillStyle restored by restore() stays valid after the CanvasPattern is GCd', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(`
const { createCanvas } = require('./index.js')
const ctx = createCanvas(256, 256).getContext('2d')
;(async () => {
  for (let i = 0; i < 1000; i++) {
    const tile = createCanvas(64, 64)
    tile.getContext('2d').fillRect(0, 0, 32, 32)
    const pattern = ctx.createPattern(tile, 'repeat')

    ctx.fillStyle = pattern
    ctx.save()
    ctx.fillStyle = '#ff0000'
    ctx.restore()

    const junk = []
    for (let k = 0; k < 200; k++) junk.push(new ArrayBuffer(4096))
    await new Promise((r) => setImmediate(r))

    ctx.fillRect(0, 0, 256, 256)
  }
  console.log('finished without crash')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
`)

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

test('strokeStyle restored by restore() stays valid after the CanvasPattern is GCd', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(`
const { createCanvas } = require('./index.js')
const ctx = createCanvas(256, 256).getContext('2d')
;(async () => {
  for (let i = 0; i < 500; i++) {
    const tile = createCanvas(64, 64)
    tile.getContext('2d').fillRect(0, 0, 32, 32)
    const pattern = ctx.createPattern(tile, 'repeat-x')

    ctx.strokeStyle = pattern
    ctx.save()
    ctx.strokeStyle = '#ff0000'
    ctx.restore()

    const junk = []
    for (let k = 0; k < 200; k++) junk.push(new ArrayBuffer(4096))
    await new Promise((r) => setImmediate(r))

    ctx.strokeRect(0, 0, 256, 256)
  }
  console.log('finished without crash')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
`)

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// A pattern sourced from an Image shares the image's bitmap via Arc. It must
// stay drawable after the JS Image is garbage-collected, and the bitmap's V8
// memory accounting must not be released while the pattern still owns it.
test('pattern created from Image stays valid after the Image is GCd', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { readFileSync } = require('node:fs')
const { createCanvas, Image } = require('./index.js')
const ctx = createCanvas(256, 256).getContext('2d')
;(async () => {
  for (let i = 0; i < 100; i++) {
    const img = new Image()
    img.src = readFileSync('__test__/javascript.png')
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej })
    const pattern = ctx.createPattern(img, 'repeat')

    ctx.fillStyle = pattern
    ctx.save()
    ctx.fillStyle = '#ff0000'
    ctx.restore()

    global.gc()
    await new Promise((r) => setImmediate(r))

    ctx.fillRect(0, 0, 256, 256)
  }
  console.log('finished without crash')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// The ImageData source used to alias the JS-backed pixel buffer; the pattern
// must hold an owned copy so it cannot dangle after the ImageData is GCd.
test('pattern created from ImageData stays valid after the ImageData is GCd', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const ctx = createCanvas(256, 256).getContext('2d')
;(async () => {
  for (let i = 0; i < 200; i++) {
    const imageData = ctx.createImageData(16, 16)
    for (let k = 0; k < imageData.data.length; k += 4) {
      imageData.data[k] = 255
      imageData.data[k + 3] = 255
    }
    const pattern = ctx.createPattern(imageData, 'repeat')

    ctx.fillStyle = pattern
    ctx.save()
    ctx.fillStyle = '#ff0000'
    ctx.restore()

    global.gc()
    await new Promise((r) => setImmediate(r))

    ctx.fillRect(0, 0, 256, 256)
  }
  console.log('finished without crash')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// As in Chrome, a unorm8 ImageData's own `data` is configurable and
// ImageData.prototype has a `data` getter. Deleting the own property leaves the
// getter, which gives the same array: a per-env WeakMap keeps it alive for
// exactly the ImageData's lifetime. No native strong ref pins it, which keeps
// `id.data.owner = id` cycles collectable.
test('delete imageData.data leaves the same array and putImageData/createPattern keep working', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const ctx = createCanvas(256, 256).getContext('2d')
;(async () => {
  for (let i = 0; i < 200; i++) {
    const imageData = ctx.createImageData(16, 16)
    for (let k = 0; k < imageData.data.length; k += 4) {
      imageData.data[k] = 255
      imageData.data[k + 3] = 255
    }
    // No local reference to the array: only the ImageData keeps it.
    imageData.data.marker = i
    if (!delete imageData.data || Object.prototype.hasOwnProperty.call(imageData, 'data')) {
      throw new Error('delete imageData.data failed')
    }

    global.gc()
    await new Promise((r) => setImmediate(r))

    if (imageData.data?.marker !== i || imageData.data[0] !== 255 || imageData.data !== imageData.data) {
      throw new Error('imageData.data lost after delete')
    }

    ctx.putImageData(imageData, 0, 0)
    const pattern = ctx.createPattern(imageData, 'repeat')
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, 256, 256)
  }
  console.log('finished without crash')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// A cyclic ImageData (id.data.owner === id) must be collectable: the native
// side holds only a weak napi_ref to the typed array, so a JS cycle does not
// escape the garbage collector.
test('cyclic ImageData is garbage-collected', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas, ImageData } = require('./index.js')
const ctx = createCanvas(64, 64).getContext('2d')
// Allocate inside functions so V8's conservative stack scanning cannot pin
// the objects via stale top-level stack slots.
function makeCyclic() {
  const cyclic = ctx.createImageData(16, 16)
  cyclic.data.owner = cyclic
  return new WeakRef(cyclic)
}
function makePlain() {
  return new WeakRef(ctx.createImageData(16, 16))
}
function makeCtor() {
  const ctor = new ImageData(8, 8)
  ctor.data.owner = ctor
  return new WeakRef(ctor)
}
// A float ImageData has no own data property: only the WeakMap and the weak
// napi_ref hold its array.
function makeFloat() {
  const float = new ImageData(new Float32Array(16), 2, 2, { pixelFormat: 'rgba-float32' })
  float.data.owner = float
  return new WeakRef(float)
}
function makeFloatRead() {
  const read = ctx.getImageData(0, 0, 2, 2, { pixelFormat: 'rgba-float32' })
  read.data.owner = read
  return new WeakRef(read)
}
const cyclicRef = makeCyclic()
const plainRef = makePlain()
const ctorRef = makeCtor()
const floatRef = makeFloat()
const floatReadRef = makeFloatRead()
;(async () => {
  for (let i = 0; i < 10; i++) {
    global.gc()
    await new Promise((r) => setImmediate(r))
  }
  global.gc()
  if (cyclicRef.deref() !== undefined) {
    console.error('cyclic ImageData was not collected')
    process.exit(1)
  }
  if (plainRef.deref() !== undefined) {
    console.error('plain ImageData was not collected')
    process.exit(1)
  }
  if (ctorRef.deref() !== undefined) {
    console.error('ctor cyclic ImageData was not collected')
    process.exit(1)
  }
  if (floatRef.deref() !== undefined || floatReadRef.deref() !== undefined) {
    console.error('cyclic float ImageData was not collected')
    process.exit(1)
  }
  console.log('finished without crash')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// An ImageData whose own buffer is detached (transfer) must throw on use
// instead of dereferencing stale pixels.
test('putImageData on own-buffer-detached ImageData throws instead of crashing', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const ctx = createCanvas(256, 256).getContext('2d')
const imageData = ctx.createImageData(16, 16)
imageData.data.buffer.transfer()
let threw = false
try {
  ctx.putImageData(imageData, 0, 0)
} catch (e) {
  threw = true
}
if (!threw) {
  console.error('putImageData did not throw')
  process.exit(1)
}
let patternThrew = false
try {
  ctx.createPattern(imageData, 'repeat')
} catch (e) {
  patternThrew = true
}
if (!patternThrew) {
  console.error('createPattern did not throw')
  process.exit(1)
}
console.log('finished without crash')
`,
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// new ImageData(typedArray) keeps the caller's buffer, as Chrome does; after
// the buffer is detached (transfer) the ImageData must throw, not dereference.
test('putImageData on detached ImageData throws instead of crashing', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas, ImageData } = require('./index.js')
const ctx = createCanvas(256, 256).getContext('2d')
const ab = new ArrayBuffer(16 * 16 * 4)
const ta = new Uint8ClampedArray(ab)
ta.fill(255)
const imageData = new ImageData(ta, 16, 16)
ab.transfer()
let threw = false
try {
  ctx.putImageData(imageData, 0, 0)
} catch (e) {
  threw = e.name === 'InvalidStateError'
}
if (!threw) {
  console.error('putImageData did not throw')
  process.exit(1)
}
console.log('finished without crash')
`,
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// setTransform must mutate the shared pattern state: clones already assigned
// to fillStyle/strokeStyle or saved on the state stack pick up the new matrix
// at paint time (https://html.spec.whatwg.org/#dom-canvaspattern-settransform).
// The tile is an 8x8 canvas split vertically: left red, right blue. A
// translate(4, 0) pattern transform swaps which half lands on each pixel.
function makeSplitTile() {
  const tile = createCanvas(8, 8)
  const tileCtx = tile.getContext('2d')!
  tileCtx.fillStyle = '#ff0000'
  tileCtx.fillRect(0, 0, 4, 8)
  tileCtx.fillStyle = '#0000ff'
  tileCtx.fillRect(4, 0, 4, 8)
  return tile
}

test('setTransform after fillStyle assignment takes effect at paint time', (t) => {
  const ctx = createCanvas(64, 64).getContext('2d')!
  const pattern = ctx.createPattern(makeSplitTile(), 'repeat')!
  ctx.fillStyle = pattern
  pattern.setTransform(new DOMMatrix().translate(4, 0))
  ctx.fillRect(0, 0, 64, 64)

  const left = ctx.getImageData(0, 0, 1, 1).data
  const right = ctx.getImageData(4, 0, 1, 1).data
  t.true(left[2] > left[0], `pixel(0,0) should be blue-ish, got ${Array.from(left)}`)
  t.true(right[0] > right[2], `pixel(4,0) should be red-ish, got ${Array.from(right)}`)
})

test('setTransform between save() and restore() still applies after restore', (t) => {
  const ctx = createCanvas(64, 64).getContext('2d')!
  const pattern = ctx.createPattern(makeSplitTile(), 'repeat')!
  ctx.fillStyle = pattern
  ctx.save()
  pattern.setTransform(new DOMMatrix().translate(4, 0))
  ctx.restore()
  ctx.fillRect(0, 0, 64, 64)

  const left = ctx.getImageData(0, 0, 1, 1).data
  const right = ctx.getImageData(4, 0, 1, 1).data
  t.true(left[2] > left[0], `pixel(0,0) should be blue-ish, got ${Array.from(left)}`)
  t.true(right[0] > right[2], `pixel(4,0) should be red-ish, got ${Array.from(right)}`)
})

// Chrome shares one decoded image between all the patterns that use it. Every
// pattern over an SVG or AVIF Image used to copy the whole bitmap at its first
// paint, while V8 and the recording budget were charged for it only once: 20
// painted patterns over one 1024x1024 Image grew rss by ~80 MB. They now share
// the Image's pixels, as patterns over PNG/JPEG Images already did.
test('painted patterns over one SVG or AVIF Image share its pixels', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas, loadImage } = require('./index.js')
const source = createCanvas(1024, 1024)
const sourceContext = source.getContext('2d')
sourceContext.fillStyle = '#3a6'
sourceContext.fillRect(0, 0, 1024, 1024)
const inputs = {
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#3a6"/></svg>'),
  avif: source.toBuffer('image/avif'),
}
;(async () => {
  const growth = {}
  for (const [kind, data] of Object.entries(inputs)) {
    const image = await loadImage(data)
    const ctx = createCanvas(64, 64).getContext('2d')
    const keep = []
    const paint = () => {
      const pattern = ctx.createPattern(image, 'repeat')
      keep.push(pattern)
      ctx.fillStyle = pattern
      ctx.fillRect(0, 0, 64, 64)
      ctx.getImageData(0, 0, 1, 1)
    }
    paint()
    global.gc()
    const before = process.memoryUsage().rss
    for (let i = 0; i < 20; i++) paint()
    global.gc()
    growth[kind] = +((process.memoryUsage().rss - before) / 1048576).toFixed(1)
    if (keep.length !== 21) throw new Error('patterns were not kept')
  }
  console.log(JSON.stringify(growth))
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  const growth = JSON.parse(stdout.trim().split('\n').pop()!)
  t.true(
    growth.svg < 20 && growth.avif < 20,
    `20 patterns grew rss by ${JSON.stringify(growth)} MB, expected < 20 MB each`,
  )
})

// Mip levels are cached per image, so patterns that share an image share its
// mip chain, as Chrome's decode cache does. Every pattern over an SVG or AVIF
// Image used to get its own image of the shared pixels, and a downscaled
// medium-quality fill built a ~1.4 MB mip chain per pattern of a 1024x1024
// Image: ~27 MB for the 20 below, where PNG patterns build one.
test('downscaled patterns over one SVG or AVIF Image share its mip levels', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas, loadImage, DOMMatrix } = require('./index.js')
const source = createCanvas(1024, 1024)
const sourceContext = source.getContext('2d')
sourceContext.fillStyle = '#3a6'
sourceContext.fillRect(0, 0, 1024, 1024)
sourceContext.fillStyle = '#a36'
sourceContext.fillRect(0, 0, 512, 1024)
const inputs = {
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#3a6"/><rect width="512" height="1024" fill="#a36"/></svg>'),
  avif: source.toBuffer('image/avif'),
  png: source.toBuffer('image/png'),
}
;(async () => {
  const growth = {}
  for (const [kind, data] of Object.entries(inputs)) {
    const image = await loadImage(data)
    const ctx = createCanvas(64, 64).getContext('2d')
    ctx.imageSmoothingQuality = 'medium'
    const keep = []
    const paint = () => {
      const pattern = ctx.createPattern(image, 'repeat')
      pattern.setTransform(new DOMMatrix().scale(0.05, 0.05))
      keep.push(pattern)
      ctx.fillStyle = pattern
      ctx.fillRect(0, 0, 64, 64)
      ctx.getImageData(0, 0, 1, 1)
    }
    paint()
    global.gc()
    const before = process.memoryUsage().rss
    for (let i = 0; i < 20; i++) paint()
    global.gc()
    growth[kind] = +((process.memoryUsage().rss - before) / 1048576).toFixed(1)
    if (keep.length !== 21) throw new Error('patterns were not kept')
  }
  console.log(JSON.stringify(growth))
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  const growth = JSON.parse(stdout.trim().split('\n').pop()!)
  t.true(
    growth.svg < 8 && growth.avif < 8 && growth.png < 8,
    `20 downscaled patterns grew rss by ${JSON.stringify(growth)} MB, expected < 8 MB each`,
  )
})

// Sharing the Image's pixels keeps the capture rule: a pattern keeps the
// bitmap it was made from after the Image gets a new src.
test('a pattern over an SVG Image keeps its pixels after the Image src changes', async (t) => {
  const svg = (color: string) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="${color}"/></svg>`,
    )
  const image = new Image()
  image.src = svg('#ff0000')
  await image.decode()
  const ctx = createCanvas(4, 4).getContext('2d')!
  ctx.fillStyle = ctx.createPattern(image, 'repeat')!
  ctx.fillRect(0, 0, 4, 2)
  image.src = svg('#0000ff')
  await image.decode()
  ctx.fillRect(0, 2, 4, 2)
  t.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [255, 0, 0, 255])
  t.deepEqual([...ctx.getImageData(0, 3, 1, 1).data], [255, 0, 0, 255])
  const fresh = createCanvas(4, 4).getContext('2d')!
  fresh.fillStyle = fresh.createPattern(image, 'repeat')!
  fresh.fillRect(0, 0, 4, 4)
  t.deepEqual([...fresh.getImageData(0, 0, 1, 1).data], [0, 0, 255, 255])
})
