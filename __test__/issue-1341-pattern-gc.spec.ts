import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, DOMMatrix } from '../index'

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

// `imageData.data` is a non-configurable, non-writable own property: `delete`
// is a no-op (and throws in strict mode), so the typed array stays reachable
// for exactly the ImageData's lifetime via ordinary GC tracing. No native
// strong ref pins it, which keeps `id.data.owner = id` cycles collectable.
test('delete imageData.data is a no-op and putImageData/createPattern keep working', async (t) => {
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
    if (delete imageData.data) {
      throw new Error('delete imageData.data unexpectedly succeeded')
    }
    if (!(imageData.data instanceof Uint8ClampedArray)) {
      throw new Error('imageData.data lost after delete')
    }

    global.gc()
    await new Promise((r) => setImmediate(r))

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
const cyclicRef = makeCyclic()
const plainRef = makePlain()
const ctorRef = makeCtor()
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

// createImageData(typedArray) borrows the caller's buffer zero-copy; after the
// buffer is detached (transfer) the ImageData must throw, not dereference.
test('putImageData on detached ImageData throws instead of crashing', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const ctx = createCanvas(256, 256).getContext('2d')
const ab = new ArrayBuffer(16 * 16 * 4)
const ta = new Uint8ClampedArray(ab)
ta.fill(255)
const imageData = ctx.createImageData(ta, 16, 16)
ab.transfer()
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
  const pattern = ctx.createPattern(makeSplitTile(), 'repeat')
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
  const pattern = ctx.createPattern(makeSplitTile(), 'repeat')
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
