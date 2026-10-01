import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { ImageData, LottieAnimation, createCanvas } from '../index'

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

// Every draw on the raster backend is appended to a deferred SkPicture
// recording that used to grow ~265 B/op until encode/toBuffer flushed it. Pure
// draw loops (issue #1342) and getImageData loops never flushed, so RSS grew
// linearly. The recorder now flushes once charged bytes pass MAX_RECORDED_BYTES
// (32 MiB, ~256 B/op + payload estimates) and on every getImageData, so 800k
// strokes must stay far below the old ~265 B/op linear growth (~214 MB here).
test.serial('deferred recording is flushed at the op limit in a pure draw loop', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const ctx = createCanvas(640, 480).getContext('2d')
ctx.strokeStyle = '#f0f'
ctx.lineWidth = 1
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
global.gc()
const before = process.memoryUsage().rss
for (let i = 0; i < 800000; i++) {
  ctx.beginPath()
  ctx.moveTo(i % 600, i % 400)
  ctx.lineTo((i % 600) + 30, (i % 400) + 30)
  ctx.stroke()
}
global.gc()
const growth = process.memoryUsage().rss - before
console.log(\`rss growth after 800k strokes: \${mb(growth)} MB\`)
// Unbounded recording would grow ~214 MB at ~265 B/op; the capped recorder
// only retains the last flush window (~32 MiB charged) plus an O(canvas)
// snapshot. Measured on the fix: ~60 MB; without it: ~214 MB.
if (growth > 100 * 1024 * 1024) {
  console.error(\`deferred recording grew unbounded: \${mb(growth)} MB\`)
  process.exit(1)
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// getImageData must flush the recording first, so a read/draw loop must not
// grow the recording linearly either; it pays one snapshot consolidate per read.
test.serial('interleaved getImageData keeps the recording bounded and correct', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const ctx = createCanvas(64, 64).getContext('2d')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
global.gc()
const before = process.memoryUsage().rss
for (let i = 0; i < 3000; i++) {
  ctx.fillStyle = i % 2 ? '#00ff00' : '#ff0000'
  ctx.fillRect(0, 0, 64, 64)
  const px = ctx.getImageData(32, 32, 1, 1).data
  const expected = i % 2 ? [0, 255, 0] : [255, 0, 0]
  if (px[0] !== expected[0] || px[1] !== expected[1] || px[2] !== expected[2] || px[3] !== 255) {
    console.error(\`wrong pixel at iteration \${i}: \${Array.from(px)}\`)
    process.exit(1)
  }
}
global.gc()
const growth = process.memoryUsage().rss - before
console.log(\`rss growth after 3k draw+getImageData iterations: \${mb(growth)} MB\`)
if (growth > 60 * 1024 * 1024) {
  console.error(\`deferred recording grew unbounded: \${mb(growth)} MB\`)
  process.exit(1)
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// draw -> getImageData -> draw -> getImageData: the second read must see both
// draws even though the first read flushed and consolidated the recording.
test.serial('pixels stay correct across repeated getImageData flushes', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')!

  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 50, 100)
  let px = ctx.getImageData(25, 50, 1, 1).data
  t.deepEqual(Array.from(px), [255, 0, 0, 255])
  px = ctx.getImageData(75, 50, 1, 1).data
  t.deepEqual(Array.from(px), [0, 0, 0, 0])

  ctx.fillStyle = '#0000ff'
  ctx.fillRect(50, 0, 50, 100)
  px = ctx.getImageData(25, 50, 1, 1).data
  t.deepEqual(Array.from(px), [255, 0, 0, 255])
  px = ctx.getImageData(75, 50, 1, 1).data
  t.deepEqual(Array.from(px), [0, 0, 255, 255])
})

// putImageData must ignore transform and clip per the HTML spec; the recorder
// gives it a fresh clip-free identity layer, so reading after a flush must see
// the pixels at the requested coords, not the transformed/clipped ones.
test.serial('putImageData between draws ignores transform and clip', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')!

  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 100, 100)

  ctx.translate(50, 50)
  ctx.beginPath()
  ctx.rect(60, 60, 10, 10)
  ctx.clip()

  const imageData = ctx.createImageData(4, 4)
  for (let i = 0; i < imageData.data.length; i += 4) {
    imageData.data[i + 2] = 255
    imageData.data[i + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)

  const px = ctx.getImageData(1, 1, 1, 1).data
  t.deepEqual(Array.from(px), [0, 0, 255, 255])
  // Outside the putImageData rect, inside the clip: still the first fill.
  const clipped = ctx.getImageData(64, 64, 1, 1).data
  t.deepEqual(Array.from(clipped), [255, 0, 0, 255])
})

// Encoding after a draw+getImageData loop must still contain every op: flush
// on read consolidates the layers into a snapshot picture, and encode replays
// the recorder's remaining layers after its own flush.
test.serial('encode stays correct after a draw and getImageData loop', async (t) => {
  const ctx = createCanvas(64, 64).getContext('2d')!
  for (let i = 0; i < 50; i++) {
    ctx.fillStyle = i % 2 ? '#00ff00' : '#ff0000'
    ctx.fillRect(0, 0, 64, 64)
    ctx.getImageData(0, 0, 1, 1)
  }
  const png = await ctx.canvas.encode('png')
  t.true(png.length > 0)
  // Last iteration (i = 49) filled green.
  const px = ctx.getImageData(32, 32, 1, 1).data
  t.deepEqual(Array.from(px), [0, 255, 0, 255])
})

// The byte cap can trip on a state op (save/clip/transform), not just on a
// draw. The flush must run at a point where the recorder's synced
// transform/clip/save_count still matches the state the pending ops ran under;
// a flush that fires mid-method inside with_canvas_state resumes the recording
// with stale metadata (e.g. a translate flushing there draws at the
// pre-translate origin). Charges are deterministic -- putImageData pins
// exactly w*h*4 bytes and every other recorded op is charged 256 -- so each
// pad() lands the budget k ops before the 32 MiB cap and the cap trips on the
// state op under test.
test.serial('state ops keep their transform and clip when the byte cap trips', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const ctx = createCanvas(200, 200).getContext('2d')
const CAP = 32 * 1024 * 1024
const tile = ctx.createImageData(64, 64) // pins exactly 16384 bytes per putImageData
tile.data.fill(255)
const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data)
const isRed = (p) => p[0] === 255 && p[1] === 0 && p[2] === 0 && p[3] === 255
const isBlue = (p) => p[0] === 0 && p[1] === 0 && p[2] === 255 && p[3] === 255
// The padding puts paint an opaque white field over [0,163)^2; any spot the
// boundary ops must not touch still reads white.
const isWhite = (p) => p[0] === 255 && p[1] === 255 && p[2] === 255 && p[3] === 255
function fail(msg, p) {
  console.error(msg + ' px=' + Array.from(p))
  process.exit(1)
}
// Full clear resets the recorder (pending=0). 2047 puts charge
// 2047*16384 = CAP - 16384; each fillRect charges 256 more.
function pad(fills) {
  ctx.clearRect(0, 0, 200, 200)
  for (let i = 0; i < 2047; i++) ctx.putImageData(tile, i % 130, i % 110)
  ctx.fillStyle = '#000000'
  for (let i = 0; i < fills; i++) ctx.fillRect(0, 0, 1, 1)
}
// translate boundary: pending = CAP-256, so translate's op reaches the cap
// and the NEXT op's check flushes after translate is fully synced.
pad(63)
ctx.translate(10, 0)
ctx.fillStyle = '#ff0000'
ctx.fillRect(5, 50, 10, 10) // draw [15,25) only if the translate applied
ctx.resetTransform()
if (!isRed(px(20, 55))) fail('translate-boundary: draw missing at translated x', px(20, 55))
if (!isWhite(px(8, 55))) fail('translate-boundary: stale transform drew at unshifted x', px(8, 55))

// clip boundary: pending = CAP-256 at clip's op. If the flush there resumes
// with stale clip metadata, the full-canvas fill escapes the clip.
pad(62) // CAP-512: save crosses to CAP-256, clip is the boundary op
ctx.save()
ctx.beginPath()
ctx.rect(40, 40, 20, 20)
ctx.clip()
ctx.fillStyle = '#ff0000'
ctx.fillRect(0, 0, 200, 200) // confined to [40,60)x[40,60) by the clip
ctx.restore()
if (!isWhite(px(5, 5))) fail('clip-boundary: draw escaped the clip', px(5, 5))
if (!isRed(px(50, 50))) fail('clip-boundary: clipped fill missing', px(50, 50))

// save boundary: pending = CAP-256 at save's op. A stale save_count makes the
// epoch's transform survive restore(), shifting the blue sentinel.
pad(63)
ctx.save()
ctx.translate(20, 0)
ctx.fillStyle = '#ff0000'
ctx.fillRect(100, 80, 10, 10)
ctx.restore()
ctx.fillStyle = '#0000ff'
ctx.fillRect(0, 90, 10, 10) // sentinel: lands at [0,10) only if restore undid the translate
if (!isBlue(px(5, 95))) fail('save-boundary: transform leaked past restore()', px(5, 95))
if (!isWhite(px(25, 95))) fail('save-boundary: stale transform drew shifted', px(25, 95))

// restore boundary: pending = CAP-256 at restore's first recorded op.
pad(60) // CAP-768: save, translate, fillRect lead; restore is the boundary op
ctx.save()
ctx.translate(20, 0)
ctx.fillStyle = '#ff0000'
ctx.fillRect(100, 120, 10, 10)
ctx.restore()
ctx.fillStyle = '#0000ff'
ctx.fillRect(0, 140, 10, 10)
if (!isBlue(px(5, 145))) fail('restore-boundary: transform leaked past restore()', px(5, 145))
if (!isWhite(px(25, 145))) fail('restore-boundary: stale transform drew shifted', px(25, 145))
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// Broad coverage across many cap crossings: ~1.5 KB charged per iteration, so
// the 32 MiB cap trips ~5-6 times inside randomly-placed ops. Each iteration's
// clipped fill lands inside [60+t,80+t)x[40,60) with a per-iteration colour;
// a clip or save_count that survives restore() lets a later fill paint the
// permanently-green sentinel corner, which every sampled check verifies.
test.serial('many cap crossings inside state ops keep canvas state consistent', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const ctx = createCanvas(220, 200).getContext('2d')
const COLORS = ['#ff0000', '#00ff00', '#0000ff']
const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data)
const RGB = [[255, 0, 0], [0, 255, 0], [0, 0, 255]]
let last = { t: 0, c: 0 }
for (let i = 0; i < 120000; i++) {
  const tOff = i % 50
  const c = i % 3
  ctx.save()
  ctx.translate(tOff, 0)
  ctx.beginPath()
  ctx.rect(60, 40, 20, 20)
  ctx.clip()
  ctx.fillStyle = COLORS[c]
  ctx.fillRect(0, 0, 220, 200) // clipped to [60+t,80+t)x[40,60)
  ctx.restore()
  ctx.fillStyle = '#00ff00'
  ctx.fillRect(0, 0, 20, 20) // sentinel: outside every clip, under no transform
  last = { t: tOff, c }
  if (i % 2000 === 0) {
    const sentinel = px(10, 10)
    if (!(sentinel[0] === 0 && sentinel[1] === 255 && sentinel[2] === 0)) {
      console.error(\`iteration \${i}: sentinel px(10,10)=\${sentinel} -- state leaked past restore()\`)
      process.exit(1)
    }
    const hit = px(60 + tOff + 10, 50)
    const e = RGB[c]
    if (hit[0] !== e[0] || hit[1] !== e[1] || hit[2] !== e[2]) {
      console.error(\`iteration \${i}: epoch draw landed wrong, px=\${hit}\`)
      process.exit(1)
    }
  }
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// An op-count budget misses payload size: stroking one cumulative path pins a
// copy of its points in every recorded op. 4000 points ~= 64 KB/op charged, so
// 3000 strokes is ~190 MB without a byte budget vs ~32 MiB windows with one.
test.serial('repeated strokes of one large cumulative path stay bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const ctx = createCanvas(200, 200).getContext('2d')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
// One path accumulated across strokes -- no beginPath between them.
for (let i = 0; i < 4000; i++) {
  if (i === 0) ctx.moveTo(10, 10)
  ctx.lineTo(10 + (i % 50), 10 + (i % 50))
}
global.gc()
const before = process.memoryUsage().rss
for (let i = 0; i < 3000; i++) {
  ctx.stroke()
}
global.gc()
const growth = process.memoryUsage().rss - before
console.log(\`rss growth after 3k strokes of a 4000-point path: \${mb(growth)} MB\`)
if (growth > 150 * 1024 * 1024) {
  console.error(\`path payload grew unbounded: \${mb(growth)} MB\`)
  process.exit(1)
}
// The recording still holds the strokes: fill a known rect and read it back.
ctx.fillStyle = '#ff0000'
ctx.fillRect(0, 0, 10, 10)
const px = ctx.getImageData(5, 5, 1, 1).data
if (px[0] !== 255 || px[1] !== 0 || px[2] !== 0 || px[3] !== 255) {
  console.error(\`final draw missing after flushes: \${Array.from(px)}\`)
  process.exit(1)
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// A 1x1 putImageData pins almost no pixel bytes, but its layer's SkPicture /
// SkImage overhead is ~1.2 KB/put. Without a per-layer charge, 200k puts keep
// ~240 MB of layer objects alive (measured ~1.2 KB/put); the per-layer charge
// bounds it to the ~32 MiB window.
test.serial('putImageData layer overhead stays bounded by the byte budget', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const ctx = createCanvas(200, 200).getContext('2d')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const imageData = ctx.createImageData(1, 1)
imageData.data.fill(255)
global.gc()
const before = process.memoryUsage().rss
for (let i = 0; i < 200000; i++) {
  ctx.putImageData(imageData, i % 200, i % 200)
}
global.gc()
const growth = process.memoryUsage().rss - before
console.log(\`rss growth after 200k 1x1 putImageData: \${mb(growth)} MB\`)
// Measured with the fix: ~42 MB; without the per-layer charge: ~240 MB.
if (growth > 150 * 1024 * 1024) {
  console.error(\`putImageData layers grew unbounded: \${mb(growth)} MB\`)
  process.exit(1)
}
const px = ctx.getImageData(199 % 200, 199 % 200, 1, 1).data
if (px[0] !== 255 || px[3] !== 255) {
  console.error(\`putImageData pixels missing: \${Array.from(px)}\`)
  process.exit(1)
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// putImageData pins a snapshot copy of the whole ImageData buffer in the
// recording, so 64x64 (16 KB) put 6000 times is ~96 MB retained without a byte
// budget vs ~32 MiB windows with one.
test.serial('putImageData loop stays bounded by the byte budget', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const ctx = createCanvas(200, 200).getContext('2d')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const imageData = ctx.createImageData(64, 64)
for (let k = 0; k < imageData.data.length; k += 4) {
  imageData.data[k] = 255
  imageData.data[k + 3] = 255
}
global.gc()
const before = process.memoryUsage().rss
for (let i = 0; i < 6000; i++) {
  ctx.putImageData(imageData, i % 100, i % 100)
}
global.gc()
const growth = process.memoryUsage().rss - before
console.log(\`rss growth after 6k putImageData: \${mb(growth)} MB\`)
if (growth > 70 * 1024 * 1024) {
  console.error(\`putImageData pinned buffers grew unbounded: \${mb(growth)} MB\`)
  process.exit(1)
}
const px = ctx.getImageData((6000 - 1) % 100, (6000 - 1) % 100, 1, 1).data
if (px[0] !== 255 || px[3] !== 255) {
  console.error(\`putImageData pixels missing: \${Array.from(px)}\`)
  process.exit(1)
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// drawCanvas records a drawPicture op that retains the SOURCE canvas's whole
// composite SkRecord. Drawing many unique sources pins megabytes in the dest's
// recording while the 256 B base charge sees only one op per draw; the
// approx_bytes_used charge bounds it to the ~32 MiB window. Sources are built
// inside the loop and unreferenced, so only the dest's retained recording
// matters (async yields let V8 actually collect each source).
test.serial('drawCanvas of unique sources keeps dest recording bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const dest = createCanvas(64, 64).getContext('2d')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
function build() {
  const src = createCanvas(64, 64).getContext('2d')
  for (let i = 0; i < 8000; i++) {
    src.beginPath()
    src.moveTo(i % 64, i % 64)
    src.lineTo((i % 64) + 5, (i % 64) + 5)
    src.stroke()
  }
  return src.canvas
}
;(async () => {
  global.gc()
  const before = process.memoryUsage().rss
  for (let s = 0; s < 80; s++) {
    const srcCanvas = build()
    dest.drawCanvas(srcCanvas, 0, 0)
    await new Promise((r) => setImmediate(r))
    if (s % 10 === 9) global.gc()
  }
  global.gc()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 80x 8k-op drawCanvas sources: \${mb(growth)} MB\`)
  // Sources total ~200 MB of records; without the picture charge the dest
  // retains them all (~3.5 MB/source, linear), with it the dest plateaus.
  // Measured with the fix: ~108 MB plateau; without: >200 MB at this scale.
  if (growth > 130 * 1024 * 1024) {
    console.error(\`drawCanvas pinned pictures grew unbounded: \${mb(growth)} MB\`)
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

// gc() alone uses conservative stack scanning, which can keep a just-dropped
// buffer alive via stale stack slots; yielding between GCs settles the scan.
const SETTLE = `
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    global.gc()
    await new Promise((r) => setImmediate(r))
  }
}
`

// Boundary ordering: padding lands pending_bytes just under the 32 MiB cap,
// then one oversized putImageData (64 MB) both trips the cap and becomes the
// recorder's only layer. The check must run BEFORE the payload charge so the
// flush can't erase it, and should_consolidate must accept a single layer, or
// the 64 MB layer is never consolidated by the read-only flushes below.
test.serial('oversized putImageData at the budget boundary still consolidates', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
;(async () => {
  await settle()
  const before = process.memoryUsage().rss
  const ctx = createCanvas(64, 64).getContext('2d')
  const tile = ctx.createImageData(64, 64)
  tile.data.fill(255)
  // clearRect resets pending to 0; 2047 puts x 16KB + 63 fills x 256B
  // land pending one op short of the 32 MiB cap.
  ctx.clearRect(0, 0, 64, 64)
  for (let i = 0; i < 2047; i++) ctx.putImageData(tile, i % 60, i % 60)
  ctx.fillStyle = '#000000'
  for (let i = 0; i < 63; i++) ctx.fillRect(0, 0, 1, 1)
  let big = ctx.createImageData(4096, 4096)
  for (let k = 0; k < big.data.length; k += 4) {
    big.data[k + 2] = 255
    big.data[k + 3] = 255
  }
  ctx.putImageData(big, 0, 0)
  big = null
  // Read-only calls only from here: they flush and (must) consolidate.
  for (let i = 0; i < 5; i++) ctx.getImageData(0, 0, 10, 10)
  ctx.canvas.toBuffer('image/png')
  const p = ctx.getImageData(30, 30, 1, 1).data
  if (p[2] !== 255 || p[3] !== 255) {
    console.error(\`oversized putImageData pixel wrong: \${Array.from(p)}\`)
    process.exit(1)
  }
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after boundary oversized putImageData: \${mb(growth)} MB\`)
  // Measured with the fix: ~176 MB (64 MB JS buffer + record copy + the
  // consolidated pad window churn). If the layer stayed pinned the growth
  // adds the payload again on top of those transients.
  if (growth > 260 * 1024 * 1024) {
    console.error(\`oversized layer stayed pinned: \${mb(growth)} MB\`)
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

// One oversized putImageData on a FRESH canvas leaves the recorder with a
// single oversized layer; read-only flushes must consolidate it (F4). With
// four canvases the pinned-layer regression would retain ~64 MB per canvas on
// top of the per-canvas transient, which stays flat when consolidation works.
test.serial('single oversized putImageData layers consolidate on read-only flushes', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
function scenario() {
  const ctx = createCanvas(64, 64).getContext('2d')
  const imageData = ctx.createImageData(4096, 4096)
  for (let k = 0; k < imageData.data.length; k += 4) {
    imageData.data[k + 2] = 255
    imageData.data[k + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)
  const p = ctx.getImageData(30, 30, 1, 1).data
  if (p[2] !== 255 || p[3] !== 255) {
    console.error(\`oversized putImageData pixel wrong: \${Array.from(p)}\`)
    process.exit(1)
  }
  ctx.getImageData(0, 0, 10, 10)
  ctx.canvas.toBuffer('image/png')
  return ctx
}
;(async () => {
  await settle()
  const before = process.memoryUsage().rss
  const keep = []
  for (let n = 0; n < 4; n++) {
    keep.push(scenario())
    await settle()
  }
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 4x oversized-put canvases: \${mb(growth)} MB\`)
  // Measured with the fix: ~134 MB; each canvas that keeps its 64 MB layer
  // pinned adds that much again (unfixed: ~390 MB at this scale).
  if (growth > 250 * 1024 * 1024) {
    console.error(\`single oversized layers stayed pinned: \${mb(growth)} MB\`)
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

// If a payload charge lands BEFORE the flush check it can be erased: the
// flush consolidates and zeroes pending_bytes, then the op records and pins
// its 41 MB source bitmap until another ~32 MiB of charges arrive. The check
// runs at the top of the entry point instead, so each canvas below flushes
// the oversized drawImage on its next op and retains nothing oversized.
test.serial('oversized drawImage charge survives the flush it may trigger', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
;(async () => {
  await settle()
  const before = process.memoryUsage().rss
  const keep = []
  for (let n = 0; n < 3; n++) {
    const ctx = createCanvas(64, 64).getContext('2d')
    const tile = ctx.createImageData(64, 64)
    tile.data.fill(255)
    ctx.clearRect(0, 0, 64, 64)
    for (let i = 0; i < 2047; i++) ctx.putImageData(tile, i % 60, i % 60)
    ctx.fillStyle = '#000000'
    for (let i = 0; i < 63; i++) ctx.fillRect(0, 0, 1, 1)
    // pending is one op under the cap; the 41 MB source's charge lands the
    // recording far over it. The op pins the source's surface pixels.
    let src = createCanvas(3200, 3200)
    const sctx = src.getContext('2d')
    sctx.fillStyle = '#ff0000'
    sctx.fillRect(0, 0, 3200, 3200)
    ctx.drawImage(src, 0, 0)
    src = null
    // ~10 MB of cheap ops: not enough to re-trip the cap, so an erased
    // charge keeps the 41 MB bitmap pinned through GC.
    for (let i = 0; i < 40000; i++) ctx.fillRect(0, 0, 1, 1)
    keep.push(ctx)
    await settle()
  }
  const p = keep[0].getImageData(30, 30, 1, 1).data
  if (p[0] !== 255 || p[1] !== 0 || p[2] !== 0 || p[3] !== 255) {
    console.error(\`drawImage pixel wrong: \${Array.from(p)}\`)
    process.exit(1)
  }
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 3x boundary drawImage canvases: \${mb(growth)} MB\`)
  // Measured with the fix: ~101 MB; with the erase-ordering defect each
  // canvas keeps its 41 MB source pinned (~225 MB at this scale).
  if (growth > 170 * 1024 * 1024) {
    console.error(\`drawImage source bitmaps stayed pinned: \${mb(growth)} MB\`)
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

// SkPicture::approximateBytesUsed excludes referenced images, so a source
// picture containing a putImageData pins ~1 MB the op charge cannot see. The
// destination is charged the source's retained recording bytes instead.
test.serial('drawCanvas of image-backed sources keeps dest recording bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const dest = createCanvas(64, 64).getContext('2d')
function build() {
  const src = createCanvas(512, 512).getContext('2d')
  const imageData = src.createImageData(512, 512)
  for (let k = 3; k < imageData.data.length; k += 4) imageData.data[k] = 255
  src.putImageData(imageData, 0, 0)
  return src.canvas
}
;(async () => {
  await settle()
  const before = process.memoryUsage().rss
  for (let s = 0; s < 120; s++) {
    const srcCanvas = build()
    dest.drawCanvas(srcCanvas, 0, 0)
    await new Promise((r) => setImmediate(r))
    if (s % 20 === 19) await settle()
  }
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 120x drawCanvas(image-backed src): \${mb(growth)} MB\`)
  // Sources pin ~1 MB of pixels each; without the source-bytes charge the
  // dest recording retains all of them (~125 MB linear); with it the window
  // plateaus (measured ~66 MB).
  if (growth > 100 * 1024 * 1024) {
    console.error(\`drawCanvas pinned image payloads: \${mb(growth)} MB\`)
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

// A recorded fill keeps its paint's shader: a canvas pattern shader retains
// the whole backing surface clone (~1 MB for 512x512). Charged per op, a loop
// of unique patterns stays inside the budget window.
test.serial('unique large image patterns keep fills bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const ctx = createCanvas(64, 64).getContext('2d')
function build() {
  const src = createCanvas(512, 512).getContext('2d')
  src.fillStyle = '#f0f'
  src.fillRect(0, 0, 512, 512)
  return src.canvas
}
;(async () => {
  await settle()
  const before = process.memoryUsage().rss
  for (let s = 0; s < 200; s++) {
    ctx.fillStyle = ctx.createPattern(build(), 'repeat')
    ctx.fillRect(0, 0, 64, 64)
    await new Promise((r) => setImmediate(r))
    if (s % 20 === 19) await settle()
  }
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 200x unique-pattern fills: \${mb(growth)} MB\`)
  // Each retained shader pins ~1 MB of backing pixels; uncharged, the
  // recording keeps ~200 MB; charged, it flushes at ~32 MiB (measured ~68 MB).
  if (growth > 150 * 1024 * 1024) {
    console.error(\`pattern bitmaps stayed pinned: \${mb(growth)} MB\`)
    process.exit(1)
  }
  const p = ctx.getImageData(30, 30, 1, 1).data
  if (p[0] !== 255 || p[1] !== 0 || p[2] !== 255 || p[3] !== 255) {
    console.error(\`pattern fill pixel wrong: \${Array.from(p)}\`)
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

// setLineDash rebuilds a PathEffect for every recorded stroke, copying the
// whole interval array each time. A 500k-entry dash list costs ~2 MB per
// stroke in the recording; charged, strokes flush at the cap instead of
// growing linearly (~300 MB for 150 strokes uncharged).
test.serial('large dash arrays keep strokes bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
;(async () => {
  const ctx = createCanvas(64, 64).getContext('2d')
  ctx.setLineDash(new Array(500000).fill(0).map((_, i) => (i % 3) + 0.5))
  await settle()
  const before = process.memoryUsage().rss
  for (let i = 0; i < 150; i++) {
    ctx.strokeRect(i % 30, i % 30, 10, 10)
  }
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 150x 2MB-dash strokes: \${mb(growth)} MB\`)
  // Measured with the fix: ~71 MB (transient PathEffect churn dominates);
  // without the dash charge it is ~300 MB and linear.
  if (growth > 130 * 1024 * 1024) {
    console.error(\`dash path effects stayed pinned: \${mb(growth)} MB\`)
    process.exit(1)
  }
  // A dashed stroke edge is antialiased: assert the top edge drew at all.
  const p = ctx.getImageData(15, 10, 1, 1).data
  if (p[3] === 0) {
    console.error(\`dash stroke pixel wrong: \${Array.from(p)}\`)
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

// A canvas used ONLY as a drawCanvas source never gets an encode/drawImage/
// getImageData flush of its own, so a source whose last op crossed the cap
// would keep its recording pinned forever. drawCanvas now flush-checks the
// source before get_picture(), so each oversized source consolidates on the
// first drawCanvas that references it.
test.serial('drawCanvas flush-checks an oversized source recording', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const dest = createCanvas(64, 64).getContext('2d')
function build() {
  const src = createCanvas(64, 64)
  const sctx = src.getContext('2d')
  // One 64 MB recorded putImageData crosses the 32 MiB source cap at once.
  const imageData = sctx.createImageData(4096, 4096)
  for (let k = 0; k < imageData.data.length; k += 4) {
    imageData.data[k + 2] = 255
    imageData.data[k + 3] = 255
  }
  sctx.putImageData(imageData, 0, 0)
  return src
}
;(async () => {
  await settle()
  const before = process.memoryUsage().rss
  const keep = []
  for (let n = 0; n < 4; n++) {
    const src = build()
    for (let k = 0; k < 5; k++) dest.drawCanvas(src, 0, 0)
    keep.push(src)
    await settle()
  }
  const p = dest.getImageData(30, 30, 1, 1).data
  if (p[2] !== 255 || p[3] !== 255) {
    console.error(\`drawCanvas pixel wrong: \${Array.from(p)}\`)
    process.exit(1)
  }
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 4x oversized-source drawCanvas: \${mb(growth)} MB\`)
  // With the source flush each 64 MB layer consolidates to a 16 KB snapshot
  // (measured ~133 MB of transients); without it every kept-alive source
  // pins its 64 MB payload on top of that (~390 MB).
  if (growth > 180 * 1024 * 1024) {
    console.error(\`oversized drawCanvas sources stayed pinned: \${mb(growth)} MB\`)
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

// Every draw under a ctx.filter records a saveLayer paint holding a chained
// SkImageFilter, one node per CSS token, and each unique chain is retained by
// the ops that referenced it (~3.5 KB per 40-token chain). The charge is
// filters_string.len() * 8 (~3.5 KB/op here), so the recording flushes inside
// the 32 MiB window instead of retaining every chain forever.
// The draws run under an EMPTY CLIP: saveLayer playback allocates real layer
// bitmaps, and that churn (~147 KB/draw measured) dwarfs retained memory and
// would make any RSS bound meaningless. Clipped-out ops still record and
// charge, but replay to nothing, so RSS tracks retention.
test.serial('long ctx.filter chains keep draws bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const ctx = createCanvas(64, 64).getContext('2d')
;(async () => {
  await settle()
  const before = process.memoryUsage().rss
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, 0, 0)
  ctx.clip()
  for (let i = 0; i < 80000; i++) {
    // Unique 40-token chain (~440 B source string) per draw.
    let f = ''
    for (let k = 0; k < 40; k++) f += 'blur(' + (0.5 + i * 1e-4).toFixed(6) + 'px) '
    ctx.filter = f
    ctx.fillRect(0, 0, 64, 64)
  }
  ctx.restore()
  ctx.filter = 'none'
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 80k filtered draws: \${mb(growth)} MB\`)
  // Charged (~3.5 KB/op): measured ~27 MB. Uncharged: ~279 MB of retained
  // chains at this scale, and linearly worse with more draws.
  if (growth > 80 * 1024 * 1024) {
    console.error(\`filter chains stayed pinned: \${mb(growth)} MB\`)
    process.exit(1)
  }
  // A real filtered draw still renders correctly after all the flushes.
  ctx.filter = 'blur(2px)'
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(20, 20, 24, 24)
  ctx.filter = 'none'
  const p = ctx.getImageData(32, 32, 1, 1).data
  if (p[0] !== 255 || p[3] !== 255) {
    console.error(\`filtered draw pixel wrong: \${Array.from(p)}\`)
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

// A recorded fillText pins an SkTextBlob (~2 B/glyph id + ~8 B/glyph position
// + run overhead), so charging only text.len() under-counts ~16x for ASCII.
// 5k-char strings charge 80 KB/op now, so a 3000-iteration loop flushes many
// times instead of retaining ~200+ MB of unflushed blobs.
test.serial('long fillText strings stay bounded by the byte budget', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const ctx = createCanvas(64, 64).getContext('2d')
;(async () => {
  const text = 'abcdefghij'.repeat(500)
  await settle()
  const before = process.memoryUsage().rss
  for (let i = 0; i < 3000; i++) {
    ctx.fillText(text + i, 0, 10)
    if (i % 500 === 499) await new Promise((r) => setImmediate(r))
  }
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 3k 5k-char fillText: \${mb(growth)} MB\`)
  // Charged at len()*16 the window flushes at ~32 MiB (measured ~35 MB); at
  // len() the same loop retains ~150-200 MB of glyph blobs before flushing.
  if (growth > 100 * 1024 * 1024) {
    console.error(\`text blobs stayed pinned: \${mb(growth)} MB\`)
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

// measureText -> get_line_metrics builds a paint via fill_paint(), which used
// to charge the recorder as a side effect: a measureText-only loop with an
// image-pattern fillStyle inflated pending_bytes and triggered spurious
// flush+consolidate cycles. Paint construction is side-effect free now, so a
// measureText loop records nothing and changes nothing.
test.serial('measureText does not charge the recording budget', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const ctx = createCanvas(64, 64).getContext('2d')
;(async () => {
  const tile = createCanvas(512, 512)
  const tctx = tile.getContext('2d')
  tctx.fillStyle = '#00ff00'
  tctx.fillRect(0, 0, 512, 512)
  // ~1 MB backing bitmap: the OLD side effect charged it on every
  // measureText, flushing + consolidating every ~32 calls.
  ctx.fillStyle = ctx.createPattern(tile, 'repeat')
  ctx.fillRect(0, 0, 64, 64)
  await settle()
  const before = process.memoryUsage().rss
  for (let i = 0; i < 20000; i++) {
    const m = ctx.measureText('measure me ' + i)
    if (m.width <= 0) {
      console.error('measureText returned non-positive width')
      process.exit(1)
    }
  }
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 20k measureText: \${mb(growth)} MB\`)
  // Nothing is recorded, so RSS stays flat; a later draw still renders the
  // pattern correctly through the (untouched) recording.
  if (growth > 60 * 1024 * 1024) {
    console.error(\`measureText inflated the recording budget: \${mb(growth)} MB\`)
    process.exit(1)
  }
  ctx.fillRect(0, 0, 64, 64)
  const p = ctx.getImageData(32, 32, 1, 1).data
  if (p[0] !== 0 || p[1] !== 255 || p[2] !== 0 || p[3] !== 255) {
    console.error(\`draw after measureText loop wrong: \${Array.from(p)}\`)
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

// A large VECTOR-only drawCanvas source used to charge the destination
// width*height*4 (~16 MB for 2000x2000) plus the full retained recording on
// every draw, forcing a flush+consolidate (whole-canvas snapshot blit) almost
// every draw -- a stall. The dest is now charged approx_bytes_used +
// retained_raster_bytes only, so repeated draws of a vector source stay cheap.
// Asserted via wall clock + RSS since consolidation frequency is internal.
test.serial('repeated drawCanvas of a large vector source does not stall or grow', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
// Vector-only source: 5k strokes recorded, no raster payload.
const src = createCanvas(2000, 2000)
const sctx = src.getContext('2d')
sctx.strokeStyle = '#0000ff'
for (let i = 0; i < 5000; i++) {
  sctx.beginPath()
  sctx.moveTo(i % 2000, i % 2000)
  sctx.lineTo((i % 2000) + 40, (i % 2000) + 40)
  sctx.stroke()
}
const dest = createCanvas(64, 64).getContext('2d')
global.gc()
const before = process.memoryUsage().rss
const t0 = Date.now()
for (let i = 0; i < 200; i++) {
  dest.drawCanvas(src, 0, 0)
}
const elapsed = Date.now() - t0
global.gc()
const growth = process.memoryUsage().rss - before
console.log(\`200x drawCanvas(2000x2000 vector): \${elapsed} ms, \${mb(growth)} MB\`)
// Old accounting charged ~16 MB + record per draw, so ~200 draws flushed +
// snapshotted almost every iteration. The vector-record charge now stays
// inside the 32 MiB window: measured 19 ms / 1.4 MB with the fix.
if (elapsed > 30_000) {
  console.error(\`drawCanvas stalled: \${elapsed} ms\`)
  process.exit(1)
}
if (growth > 80 * 1024 * 1024) {
  console.error(\`drawCanvas grew unbounded: \${mb(growth)} MB\`)
  process.exit(1)
}
// Source strokes land on the dest: a pixel on the diagonal must be covered
// (opaque blue) -- the drawn content survives every flush.
const p = dest.getImageData(0, 0, 1, 1).data
if (p[3] !== 255) {
  console.error(\`drawCanvas pixel missing: \${Array.from(p)}\`)
  process.exit(1)
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// A draw whose paint construction fails records nothing, so it must leave no
// charge behind. setLineDash([0,0]) makes every fillRect's PathEffect creation
// fail; with a 512x512 image pattern as fillStyle the pre-fix order charged
// ~1 MB per FAILED op, flushing the recording almost every iteration. Charges
// now land only after the fallible paint build succeeds.
test.serial('failing draws leave no phantom charge behind', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const ctx = createCanvas(64, 64).getContext('2d')
const src = createCanvas(512, 512)
src.getContext('2d').fillRect(0, 0, 512, 512)
ctx.fillStyle = ctx.createPattern(src, 'repeat')
ctx.setLineDash([0, 0])
let failures = 0
global.gc()
const before = process.memoryUsage().rss
const t0 = Date.now()
for (let i = 0; i < 2000; i++) {
  try {
    ctx.fillRect(0, 0, 64, 64)
  } catch (e) {
    failures++
  }
}
const elapsed = Date.now() - t0
global.gc()
const growth = process.memoryUsage().rss - before
console.log(\`2000 failing fillRect: \${elapsed} ms, \${mb(growth)} MB, failures=\${failures}\`)
if (failures !== 2000) {
  console.error('expected every draw to fail')
  process.exit(1)
}
// Phantom charges would flush ~every 32 failed ops (1 MB charge each),
// rasterizing the canvas each time; fixed ordering shows no flushes at all.
if (elapsed > 30_000) {
  console.error(\`phantom-charge flush stall: \${elapsed} ms\`)
  process.exit(1)
}
if (growth > 80 * 1024 * 1024) {
  console.error(\`phantom charges grew the recording: \${mb(growth)} MB\`)
  process.exit(1)
}
// Recovery: the canvas still draws correctly afterwards.
ctx.setLineDash([])
ctx.fillStyle = '#ff0000'
ctx.fillRect(0, 0, 64, 64)
const p = ctx.getImageData(32, 32, 1, 1).data
if (p[0] !== 255 || p[1] !== 0 || p[2] !== 0 || p[3] !== 255) {
  console.error(\`post-failure draw pixel wrong: \${Array.from(p)}\`)
  process.exit(1)
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// Full-canvas composite modes (source-in/out, destination-in/atop, copy)
// record each draw into a fresh inner SkPicture that the outer record pins
// via drawPicture -- invisible to the 256 B base charge. approx_bytes_used is
// now accumulated per composited pass and charged after the op lands, so a
// source-in loop plateaus instead of growing linearly.
test.serial('source-in composite draws stay bounded by nested-picture charge', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const ctx = createCanvas(64, 64).getContext('2d')
global.gc()
const before = process.memoryUsage().rss
for (let i = 0; i < 300000; i++) {
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = '#f0f'
  ctx.fillRect(0, 0, 64, 64)
  ctx.globalCompositeOperation = 'source-over'
}
global.gc()
const growth = process.memoryUsage().rss - before
console.log(\`rss growth after 300k source-in fills: \${mb(growth)} MB\`)
// Each draw retains an inner picture; uncharged they accumulate ~300k layers'
// worth of record. Charged, the recording flushes at the 32 MiB window:
// measured ~29 MB plateau (uncharged inner pictures grew ~460 B/draw ->
// ~140 MB and linear at this scale).
if (growth > 100 * 1024 * 1024) {
  console.error(\`nested pictures stayed pinned: \${mb(growth)} MB\`)
  process.exit(1)
}
// Pixels still correct after all the flushes.
ctx.globalCompositeOperation = 'source-over'
ctx.fillStyle = '#ff0000'
ctx.fillRect(0, 0, 64, 64)
const p = ctx.getImageData(32, 32, 1, 1).data
if (p[0] !== 255 || p[1] !== 0 || p[2] !== 0 || p[3] !== 255) {
  console.error(\`post-loop draw pixel wrong: \${Array.from(p)}\`)
  process.exit(1)
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// A recorded fillText's SkTextBlob keeps its SkFont/SkTypeface alive, and the
// backing font file can be megabytes -- approx_bytes_used cannot see it. A
// flat 1 MiB per text draw is charged so cycling many fonts flushes the
// recording instead of pinning every typeface.
test.serial('fillText cycling many fonts stays bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas, GlobalFonts } = require('./index.js')
const { readdirSync } = require('node:fs')
const { join } = require('node:path')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
for (const f of readdirSync('__test__/fonts')) {
  try {
    GlobalFonts.registerFromPath(join(process.cwd(), '__test__/fonts', f))
  } catch (e) {}
}
const families = GlobalFonts.families.map((f) => f.family.split(',')[0]).filter(Boolean)
const ctx = createCanvas(200, 100).getContext('2d')
global.gc()
const before = process.memoryUsage().rss
for (let i = 0; i < 2000; i++) {
  ctx.font = '20px ' + JSON.stringify(families[i % families.length])
  ctx.fillText('hello', 10, 50)
}
global.gc()
const growth = process.memoryUsage().rss - before
console.log(\`rss growth after 2k fillText over \${families.length} fonts: \${mb(growth)} MB\`)
// Measured with the 1 MiB/typeface charge: ~50 MB (font loading dominates);
// uncharged, every recorded blob keeps its typeface ref and the recording
// never flushes, so retention grows with iteration count.
if (growth > 200 * 1024 * 1024) {
  console.error(\`typefaces stayed pinned: \${mb(growth)} MB\`)
  process.exit(1)
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// ImagePattern::estimated_bytes used to call bitmap accessors on the `bitmap`
// field, which for canvas/SVG-backed patterns is actually a SkSurface*
// (get_bitmap_ptr) -- reading SkBitmap dims off a surface is type confusion
// and returned garbage sizes, charging megabytes per fill of a 1x1 tile and
// flushing almost every op (200 fills on 4096x4096: 37.5 s / +192 MB on this
// machine). The raster size is now captured from the real source at
// construction, and the charge is deduplicated per backing pointer inside a
// recording window.
test.serial('canvas-backed pattern fills charge real dims once per window', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const ctx = createCanvas(4096, 4096).getContext('2d')
const tile = createCanvas(1, 1)
const tctx = tile.getContext('2d')
tctx.fillStyle = '#ff0000'
tctx.fillRect(0, 0, 1, 1)
ctx.fillStyle = ctx.createPattern(tile, 'repeat')
;(async () => {
  await settle()
  const before = process.memoryUsage().rss
  const t0 = Date.now()
  for (let i = 0; i < 50; i++) {
    ctx.fillRect(0, 0, 4096, 4096)
  }
  const elapsed = Date.now() - t0
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`50x canvas-pattern fills: \${elapsed} ms, \${mb(growth)} MB\`)
  // The 4-byte tile is charged once per window; nothing should flush, so the
  // draws never rasterize (measured: ~0 ms / ~0 MB; pre-fix: ~9 s / ~50 MB at
  // this scale, 37.5 s / +192 MB at 200 fills).
  if (elapsed > 20_000) {
    console.error(\`canvas-pattern fills stalled: \${elapsed} ms\`)
    process.exit(1)
  }
  if (growth > 100 * 1024 * 1024) {
    console.error(\`canvas-pattern fills grew unbounded: \${mb(growth)} MB\`)
    process.exit(1)
  }
  const p = ctx.getImageData(2048, 2048, 1, 1).data
  if (p[0] !== 255 || p[1] !== 0 || p[2] !== 0 || p[3] !== 255) {
    console.error(\`pattern fill pixel wrong: \${Array.from(p)}\`)
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

// A recorded drawImage op retains a shared reference to the source raster, so
// N draws of the same source pin one backing, not N. The charge used to land
// unconditionally per op (16 MiB for a 2048^2 source), forcing a flush +
// consolidate every ~3 draws; it is now keyed on the source pointer and
// charged once per recording window.
test.serial('repeated drawImage of one source charges its raster once', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const src = createCanvas(2048, 2048)
const sctx = src.getContext('2d')
sctx.fillStyle = '#00ff00'
sctx.fillRect(0, 0, 2048, 2048)
const dest = createCanvas(1024, 1024).getContext('2d')
;(async () => {
  await settle()
  const before = process.memoryUsage().rss
  const t0 = Date.now()
  for (let i = 0; i < 100; i++) {
    dest.drawImage(src, 0, 0, 64, 64)
  }
  const elapsed = Date.now() - t0
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`100x drawImage(same 2048 src): \${elapsed} ms, \${mb(growth)} MB\`)
  // One 16 MiB charge per window stays under the 32 MiB cap: no flush churn.
  // Unbounded per-op charges would still be released by the flushes they
  // force, so the distinguishing signal is retained size, not linear growth.
  if (elapsed > 5_000) {
    console.error(\`drawImage stalled on consolidation churn: \${elapsed} ms\`)
    process.exit(1)
  }
  if (growth > 100 * 1024 * 1024) {
    console.error(\`shared drawImage source grew unbounded: \${mb(growth)} MB\`)
    process.exit(1)
  }
  const p = dest.getImageData(10, 10, 1, 1).data
  if (p[1] !== 255 || p[3] !== 255) {
    console.error(\`drawImage pixel wrong: \${Array.from(p)}\`)
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

// The pointer dedup above must not collapse DISTINCT generations: every
// recorded drawImage(canvas) pins a fresh makeImageSnapshot of the source, so
// mutating the source between draws copy-on-writes a new ~16 MiB raster per
// op. Keyed on the stable SkSurface* alone, only the first generation was
// charged and the recording pinned every snapshot without ever tripping the
// byte cap (+257 MB over 16 draws of a mutated 2048^2 source). The key is now
// (surface ptr, source content_version), so each generation re-charges and
// the window flushes at 32 MiB.
test.serial('drawImage of a mutated canvas source re-charges each generation', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const src = createCanvas(2048, 2048)
const sctx = src.getContext('2d')
sctx.fillStyle = '#00ff00'
sctx.fillRect(0, 0, 2048, 2048)
const dest = createCanvas(64, 64).getContext('2d')
;(async () => {
  await settle()
  const before = process.memoryUsage().rss
  for (let i = 0; i < 60; i++) {
    // 1 px mutation per iteration: bumps the source's content version and
    // makes the next recorded drawImage pin a fresh COW raster.
    sctx.fillStyle = '#ff0000'
    sctx.fillRect(i % 64, Math.floor(i / 64), 1, 1)
    dest.drawImage(src, 0, 0, 64, 64)
  }
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`60x drawImage(mutated 2048 src): \${mb(growth)} MB\`)
  // Generation-blind dedup retained ~16 MiB/draw (~960 MB at this scale);
  // versioned keys flush at the 32 MiB window. Measured on the fix: ~50 MB.
  if (growth > 120 * 1024 * 1024) {
    console.error(\`mutated drawImage source grew unbounded: \${mb(growth)} MB\`)
    process.exit(1)
  }
  // Call-time capture still holds: a final all-red source must read back red.
  sctx.fillRect(0, 0, 2048, 2048)
  dest.drawImage(src, 0, 0, 64, 64)
  const p = dest.getImageData(32, 32, 1, 1).data
  if (p[0] !== 255 || p[1] !== 0 || p[3] !== 255) {
    console.error(\`latest generation missing: \${Array.from(p)}\`)
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

// Canvas::draw_text's CString conversions fail on interior NUL AFTER the
// len*16 + 1 MiB budget charges had already committed, so each failed
// fillText looked like a 1 MiB recorded op: ~32 failures tripped a flush,
// and on a large canvas each consolidate cost real work (1000 failures on
// 4096^2: +193 MB). The NUL check now runs before any charge lands.
test.serial('failing NUL fillText leaves no phantom charge', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const ctx = createCanvas(4096, 4096).getContext('2d')
let failures = 0
;(async () => {
  await settle()
  const before = process.memoryUsage().rss
  const t0 = Date.now()
  // A literal NUL cannot appear in the child script itself (spawn rejects
  // argv with NUL bytes), so build the string at runtime.
  const nulText = 'a' + String.fromCharCode(0) + 'b'
  for (let i = 0; i < 1000; i++) {
    try {
      ctx.fillText(nulText, 0, 10)
    } catch (e) {
      failures++
    }
    ctx.fillRect(0, 0, 1, 1)
  }
  const elapsed = Date.now() - t0
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`1000 NUL fillText + fillRect: \${elapsed} ms, \${mb(growth)} MB, failures=\${failures}\`)
  if (failures !== 1000) {
    console.error('expected every fillText to fail')
    process.exit(1)
  }
  // Phantom 1 MiB charges flushed ~every 32 failures: pre-fix measured
  // ~193 MB retained; with the preflight check the loop stays flat.
  if (elapsed > 30_000) {
    console.error(\`NUL fillText flush stall: \${elapsed} ms\`)
    process.exit(1)
  }
  if (growth > 80 * 1024 * 1024) {
    console.error(\`NUL fillText grew the recording: \${mb(growth)} MB\`)
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

// The NUL preflight above covers text-content failures, but fillText /
// strokeText charged the ACTIVE PAINT's resources before reaching it: a
// fillText that threw on NUL still billed ~1 MiB per unique image pattern,
// driving pending_bytes over the 32 MiB cap with nothing recorded. The first
// real draw afterwards hit the post-op check and consolidated to a full
// 4096^2 snapshot (+64 MB) it never needed. Paint charges now land inside
// draw_text, after every fallible step, so a failing draw stays free and the
// fillRect below must not consolidate.
test.serial('failing NUL fillText/strokeText leave no paint charge behind', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const ctx = createCanvas(4096, 4096).getContext('2d')
function build() {
  const src = createCanvas(512, 512).getContext('2d')
  src.fillStyle = '#f0f'
  src.fillRect(0, 0, 512, 512)
  return src.canvas
}
;(async () => {
  await settle()
  const before = process.memoryUsage().rss
  // Retain every pattern: freed backings would let the charges dedup.
  const patterns = []
  for (let i = 0; i < 96; i++) {
    patterns.push(ctx.createPattern(build(), 'repeat'))
  }
  await settle()
  const afterPatterns = process.memoryUsage().rss
  // A literal NUL cannot appear in argv; build the text at runtime.
  const nulText = 'a' + String.fromCharCode(0) + 'b'
  let failures = 0
  for (const pattern of patterns) {
    ctx.fillStyle = pattern
    ctx.strokeStyle = pattern
    try {
      ctx.fillText(nulText, 0, 10)
    } catch (e) {
      failures++
    }
    try {
      ctx.strokeText(nulText, 0, 10)
    } catch (e) {
      failures++
    }
  }
  await settle()
  const afterFails = process.memoryUsage().rss
  const patternGrowth = afterPatterns - before
  const failGrowth = afterFails - afterPatterns
  console.log(\`patterns: +\${mb(patternGrowth)} MB; 192 failing text draws: +\${mb(failGrowth)} MB, failures=\${failures}\`)
  if (failures !== patterns.length * 2) {
    console.error('expected every fillText/strokeText to throw')
    process.exit(1)
  }
  // Each failed draw still builds and caches its pattern shader (~1 MiB per
  // canvas-backed pattern) inside fill_paint/stroke_paint, which is real work
  // any draw attempt pays. Assert only that it stays near the creation
  // baseline instead of doubling it.
  if (afterFails - before > 2 * patternGrowth + 32 * 1024 * 1024) {
    console.error(
      \`failing text draws doubled memory: \${mb(afterFails - before)} MB vs baseline \${mb(patternGrowth)} MB\`,
    )
    process.exit(1)
  }
  // Phantom ~1 MiB paint charges push pending_bytes past the cap with an
  // EMPTY recording; this fillRect then hits the post-op check, flushes, and
  // consolidates to a 4096^2 snapshot (+64 MB measured pre-fix).
  ctx.fillStyle = '#f00'
  ctx.fillRect(0, 0, 4096, 4096)
  await settle()
  const growth = process.memoryUsage().rss - afterFails
  console.log(\`post-failure fillRect: +\${mb(growth)} MB\`)
  if (growth > 32 * 1024 * 1024) {
    console.error(\`phantom charges forced a post-op consolidate: \${mb(growth)} MB\`)
    process.exit(1)
  }
  // Recovery: the canvas still draws correctly afterwards.
  const px = ctx.getImageData(2048, 2048, 1, 1).data
  if (px[0] !== 255 || px[1] !== 0 || px[2] !== 0 || px[3] !== 255) {
    console.error(\`post-failure draw pixel wrong: \${Array.from(px)}\`)
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

// A drawCanvas whose source rect is empty (skiac_canvas_draw_picture_rect's
// `sw == 0 || sh == 0` early return, or an empty/non-finite dst clip) records
// NOTHING, but the byte and raster charges used to commit anyway: each call
// billed the ~1 MB composite picture, pushing dest's pending_bytes over the
// cap so every ~32nd call flushed and consolidated -- rasterizing all pending
// content each time (~4s here) and paying ~64 MB of snapshot churn. The
// preflight now returns before paint construction, so no charge lands.
// (The stale dedup-key half of the defect needs a freed picture's address to
// be reused by another SkPicture -- allocator-dependent and not
// deterministically reproducible; the dedup key is now the picture's
// process-unique id, which can never alias.)
test.serial('zero-source-rect drawCanvas leaves no phantom charge', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const ctx = createCanvas(1024, 1024).getContext('2d')
// ~1 MB composite picture per get_picture(): each no-op used to charge it.
const src = createCanvas(64, 64)
const sctx = src.getContext('2d')
for (let i = 0; i < 8000; i++) {
  sctx.beginPath()
  sctx.moveTo(i % 64, i % 64)
  sctx.lineTo((i % 64) + 5, (i % 64) + 5)
  sctx.stroke()
}
// Pending content that is expensive to rasterize, so a spurious over-cap
// flush is measurable as time AND as consolidate snapshots: 2000 blurred
// fills replay in ~6 s per flush (measured) and each consolidate pins a
// new snapshot picture.
ctx.filter = 'blur(8px)'
for (let i = 0; i < 2000; i++) {
  ctx.fillRect(i % 700, i % 700, 150, 150)
}
ctx.filter = 'none'
;(async () => {
  await settle()
  const before = process.memoryUsage().rss
  const t0 = Date.now()
  for (let i = 0; i < 300; i++) {
    // Zero source width AND zero source height: native early-outs both.
    ctx.drawCanvas(src, 0, 0, 0, 64, 0, 0, 64, 64)
    ctx.drawCanvas(src, 0, 0, 64, 0, 0, 0, 64, 64)
  }
  const elapsed = Date.now() - t0
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`600 zero-src drawCanvas over 2000 filtered fills: \${elapsed} ms, +\${mb(growth)} MB\`)
  // Phantom ~1 MB charges trip the cap every ~32 calls -> ~18 consolidations
  // of the 2000-op pending recording: ~12 s and +142 MB measured pre-fix.
  if (elapsed > 20_000) {
    console.error(\`no-op drawCanvas flush stall: \${elapsed} ms\`)
    process.exit(1)
  }
  if (growth > 16 * 1024 * 1024) {
    console.error(\`no-op drawCanvas left phantom charges: \${mb(growth)} MB\`)
    process.exit(1)
  }
  // The no-ops drew nothing: a corner the (max ~880px plus ~24px blur halo)
  // fills cannot reach stays transparent.
  const blank = ctx.getImageData(950, 950, 1, 1).data
  if (blank[3] !== 0) {
    console.error(\`no-op drawCanvas painted pixels: \${Array.from(blank)}\`)
    process.exit(1)
  }
  // A real drawCanvas of the same source still lands.
  ctx.drawCanvas(src, 0, 0)
  const px = ctx.getImageData(0, 0, 1, 1).data
  if (px[3] !== 255) {
    console.error(\`drawCanvas pixel missing: \${Array.from(px)}\`)
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

// clearRect's full-canvas fast path resets the recorder AND clears the backing
// surface (a COW mutation), but used to leave content_version unchanged. A dest
// recording that pinned the pre-clear snapshot then deduped every subsequent
// draw under the same (pointer, version) key: 30 clear+draw cycles of a
// 2048^2 source pinned ~480 MB uncharged. reset() now bumps the generation, so
// each cycle re-charges ~16 MiB and the window flushes at the 32 MiB cap.
test.serial('clearRect-mutated drawImage source re-charges each generation', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
;(async () => {
  const src = createCanvas(2048, 2048).getContext('2d')
  const dest = createCanvas(64, 64).getContext('2d')
  await settle()
  const before = process.memoryUsage().rss
  for (let i = 0; i < 30; i++) {
    src.fillStyle = '#f00'
    src.fillRect(0, 0, 2048, 2048)
    src.clearRect(0, 0, 2048, 2048)
    dest.drawImage(src.canvas, 0, 0)
    await new Promise((r) => setImmediate(r))
  }
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 30 clearRect+drawImage cycles: \${mb(growth)} MB\`)
  // Stale-version dedup pinned ~16 MiB per draw uncharged (~480 MB measured).
  // Charged per generation the recording flushes at the cap: ~64 MB measured.
  if (growth > 150 * 1024 * 1024) {
    console.error(\`clearRect mutation escaped the dedup key: \${mb(growth)} MB\`)
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

// drawImage(canvas) dedup keys were keyed on the raw SkSurface*: a dropped
// canvas frees it, the allocator hands the address to the next canvas, and
// the new source collides with the stale key at generation 0 -- its raster
// escapes the charge entirely. 40 temp 1024^2 canvases pinned ~161 MB; keyed
// on the Context's monotonic resource_id, each unique source charges ~4 MiB
// and the window flushes at the 32 MiB cap.
test.serial('drawImage of short-lived canvases cannot alias a freed source', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
;(async () => {
  const dest = createCanvas(64, 64).getContext('2d')
  await settle()
  const before = process.memoryUsage().rss
  for (let i = 0; i < 40; i++) {
    const tmp = createCanvas(1024, 1024).getContext('2d')
    tmp.fillStyle = '#00f'
    tmp.fillRect(0, 0, 1024, 1024)
    dest.drawImage(tmp.canvas, 0, 0)
    await new Promise((r) => setImmediate(r))
    if (i % 10 === 9) global.gc()
  }
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 40 temp-canvas drawImages: \${mb(growth)} MB\`)
  // Pointer-recycled keys let every second source go uncharged (~161 MB
  // measured); resource ids charge all 40 (~48 MB measured).
  if (growth > 120 * 1024 * 1024) {
    console.error(\`temp-canvas sources escaped the dedup key: \${mb(growth)} MB\`)
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

// Same pointer-recycling hole for image-pattern charges: the dedup key was
// the pattern's backing SkBitmap pointer, so a GC'd pattern's freed bitmap
// address reused by the next pattern deduped its ~4 MiB raster charge. 40
// unique 1024^2 ImageData patterns pinned ~258 MB uncharged; patterns now
// carry a resource_id minted at construction.
test.serial('unique image patterns cannot alias a freed pattern backing', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
;(async () => {
  const ctx = createCanvas(64, 64).getContext('2d')
  await settle()
  const before = process.memoryUsage().rss
  for (let i = 0; i < 40; i++) {
    const imageData = ctx.createImageData(1024, 1024)
    imageData.data[0] = 255
    imageData.data[3] = 255
    const pattern = ctx.createPattern(imageData, 'repeat')
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, 64, 64)
    await new Promise((r) => setImmediate(r))
    if (i % 10 === 9) global.gc()
  }
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 40 unique pattern fills: \${mb(growth)} MB\`)
  // Recycled backing pointers dropped ~half the charges (~258 MB measured);
  // per-pattern ids charge all 40 (~105 MB measured).
  if (growth > 200 * 1024 * 1024) {
    console.error(\`unique patterns escaped the dedup key: \${mb(growth)} MB\`)
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

// LottieAnimation::render draws straight onto the surface. It must flush the
// deferred recording first so the frame lands OVER the ops recorded before it
// -- without the flush, a pending draw replays later and overwrites the frame.
test.serial('lottie render lands over ops recorded before it', (t) => {
  const lottie = LottieAnimation.loadFromData(readFileSync(join(root, 'example/flat-lottie.json'), 'utf-8'))
  const ctx = createCanvas(256, 256).getContext('2d')!
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 256, 256)

  lottie.render(ctx, { x: 0, y: 0, width: 256, height: 64 })

  // flat-lottie.json paints opaque pixels in the band; a reordering bug would
  // replay the recorded red fill on top of the frame and leave them at
  // (255,0,0).
  const frame = ctx.getImageData(48, 0, 1, 1).data
  t.false(
    frame[0] === 255 && frame[1] === 0 && frame[2] === 0,
    `lottie frame was overwritten by the recorded fill: ${Array.from(frame)}`,
  )

  // An op recorded after render must still land over the frame.
  ctx.fillStyle = '#00ff00'
  ctx.fillRect(0, 0, 256, 64)
  const over = ctx.getImageData(48, 0, 1, 1).data
  t.deepEqual(Array.from(over), [0, 255, 0, 255])
})

// The direct lottie write COWs the surface raster: the dest drawImage key is
// (resource_id, content_version), so every render is a new generation that
// re-charges w*h*4 until flush. An unbumped version would keep drawing fresh
// rasters under the stale key, never hitting the byte cap.
test.serial('lottie render + drawImage loop stays bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { readFileSync } = require('node:fs')
const { createCanvas, LottieAnimation } = require('./index.js')
const lottie = LottieAnimation.loadFromData(readFileSync('example/flat-lottie.json', 'utf-8'))
const src = createCanvas(256, 256)
const srcCtx = src.getContext('2d')
const dst = createCanvas(256, 256)
const dstCtx = dst.getContext('2d')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
global.gc()
const before = process.memoryUsage().rss
for (let i = 0; i < 400; i++) {
  lottie.seek(i / 400)
  lottie.render(srcCtx, { x: 0, y: 0, width: 256, height: 256 })
  dstCtx.drawImage(src, 0, 0)
}
global.gc()
const growth = process.memoryUsage().rss - before
console.log(\`rss growth after 400 render+drawImage iterations: \${mb(growth)} MB\`)
// Stale content_version would uncharge every lottie raster (~104 MB measured
// for 400 iterations of 256x256) instead of paying +flushing per generation.
if (growth > 90 * 1024 * 1024) {
  console.error(\`lottie renders escaped the byte budget: \${mb(growth)} MB\`)
  process.exit(1)
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// getContext('2d', { alpha: false }) paints an opaque base fill straight onto
// the surface. It must flush pending recorded ops under it (a recorded op
// issued before the call renders OVER the fill) and bump the content version.
test.serial('alpha:false base fill lands over ops recorded before it', (t) => {
  const canvas = createCanvas(64, 64)
  canvas.getContext('2d')!.fillStyle = '#ff0000'
  canvas.getContext('2d')!.fillRect(0, 0, 64, 64)
  canvas.getContext('2d', { alpha: false })

  const px = canvas.getContext('2d')!.getImageData(32, 32, 1, 1).data
  t.deepEqual(Array.from(px), [255, 255, 255, 255], `base fill was overwritten by the recorded fill: ${Array.from(px)}`)
})

test.serial('repeated alpha:false getContext + drawImage stays bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const src = createCanvas(256, 256)
const srcCtx = src.getContext('2d', { alpha: false })
srcCtx.fillStyle = '#0000ff'
srcCtx.fillRect(0, 0, 256, 256)
const dst = createCanvas(256, 256)
const dstCtx = dst.getContext('2d')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
global.gc()
const before = process.memoryUsage().rss
for (let i = 0; i < 600; i++) {
  // Each call re-paints the opaque base fill (a direct surface write).
  src.getContext('2d', { alpha: false })
  dstCtx.drawImage(src, 0, 0)
}
global.gc()
const growth = process.memoryUsage().rss - before
console.log(\`rss growth after 600 getContext+drawImage iterations: \${mb(growth)} MB\`)
// A stale content_version would uncharge every fresh raster (~157 MB measured
// for 600 iterations) instead of paying +flushing per generation.
if (growth > 120 * 1024 * 1024) {
  console.error(\`alpha:false fills escaped the byte budget: \${mb(growth)} MB\`)
  process.exit(1)
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// An Image's bitmap is immutable per AccountedBitmap, whose resource_id keys
// the dedup: redrawing one unchanged image must charge its raster once per
// window, not w*h*4 per draw. A nonce-per-draw key hit the 32 MiB cap every
// ~32 draws and paid a flush+consolidate each time (measured ~901 ms, +224 MB
// for 1000 draws of a 2048x2048 source; ~3 ms per flush at 512x512).
test.serial('repeated drawImage of an unchanged Image dedups and does not stall', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas, Image } = require('./index.js')
;(async () => {
  const maker = createCanvas(512, 512)
  const makerCtx = maker.getContext('2d')
  makerCtx.fillStyle = '#0080ff'
  makerCtx.fillRect(0, 0, 512, 512)
  const img = new Image()
  img.src = await maker.toBuffer('image/png')
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej })

  const ctx = createCanvas(512, 512).getContext('2d')
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
  global.gc()
  const before = process.memoryUsage().rss
  const start = Date.now()
  for (let i = 0; i < 200; i++) {
    ctx.drawImage(img, 0, 0)
    if (i === 100) {
      const px = ctx.getImageData(256, 256, 1, 1).data
      if (px[2] !== 255) {
        console.error(\`wrong pixel mid-loop: \${Array.from(px)}\`)
        process.exit(1)
      }
    }
  }
  const elapsed = Date.now() - start
  global.gc()
  const growth = process.memoryUsage().rss - before
  console.log(\`200 draws of a 512x512 image: \${elapsed} ms, rss growth \${mb(growth)} MB\`)
  if (elapsed > 3000) {
    console.error(\`drawImage loop stalled: \${elapsed} ms\`)
    process.exit(1)
  }
  if (growth > 80 * 1024 * 1024) {
    console.error(\`unchanged image re-charged per draw: \${mb(growth)} MB\`)
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

// A reassigned src decodes to a fresh AccountedBitmap with a fresh identity,
// so each generation re-charges (correct) and flushes under the byte budget.
test.serial('drawImage of a reassigned Image stays bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas, Image } = require('./index.js')
;(async () => {
  const maker = createCanvas(256, 256)
  const makerCtx = maker.getContext('2d')
  makerCtx.fillStyle = '#ff0000'
  makerCtx.fillRect(0, 0, 256, 256)
  const redPng = await maker.toBuffer('image/png')
  makerCtx.fillStyle = '#0000ff'
  makerCtx.fillRect(0, 0, 256, 256)
  const bluePng = await maker.toBuffer('image/png')

  const img = new Image()
  const ctx = createCanvas(256, 256).getContext('2d')
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
  global.gc()
  const before = process.memoryUsage().rss
  for (let i = 0; i < 200; i++) {
    img.src = i % 2 ? bluePng : redPng
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej })
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(128, 128, 1, 1).data
    const expected = i % 2 ? 2 : 0
    if (px[expected] !== 255) {
      console.error(\`wrong pixel at iteration \${i}: \${Array.from(px)}\`)
      process.exit(1)
    }
  }
  global.gc()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 200 reassigned-image draws: \${mb(growth)} MB\`)
  if (growth > 150 * 1024 * 1024) {
    console.error(\`reassigned images escaped the byte budget: \${mb(growth)} MB\`)
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

// A direct surface write (alpha:false base fill, lottie frame) bypasses the
// recording, so with_surface_canvas rebases the recorder's layers on the
// post-write snapshot. Without that, get_picture() (the drawCanvas source
// path) replays the stale pre-write layers while drawImage reads the fresh
// surface -- the two draw paths disagree.
test.serial('drawCanvas and drawImage agree after alpha:false direct fill', (t) => {
  const src = createCanvas(64, 64)
  src.getContext('2d')!.fillStyle = '#ff0000'
  src.getContext('2d')!.fillRect(0, 0, 64, 64)
  src.getContext('2d', { alpha: false })

  const viaImage = createCanvas(64, 64).getContext('2d')!
  viaImage.drawImage(src, 0, 0)
  t.deepEqual(Array.from(viaImage.getImageData(32, 32, 1, 1).data), [255, 255, 255, 255])

  const viaCanvas = createCanvas(64, 64).getContext('2d')!
  viaCanvas.drawCanvas(src, 0, 0)
  t.deepEqual(
    Array.from(viaCanvas.getImageData(32, 32, 1, 1).data),
    [255, 255, 255, 255],
    'drawCanvas replayed the stale pre-fill recording',
  )
})

test.serial('drawCanvas and drawImage agree after a lottie render', (t) => {
  const lottie = LottieAnimation.loadFromData(readFileSync(join(root, 'example/flat-lottie.json'), 'utf-8'))
  const src = createCanvas(256, 256)
  const sctx = src.getContext('2d')!
  sctx.fillStyle = '#ff0000'
  sctx.fillRect(0, 0, 256, 256)
  lottie.render(sctx, { x: 0, y: 0, width: 256, height: 64 })

  const isRed = (d: Uint8ClampedArray) => d[0] === 255 && d[1] === 0 && d[2] === 0
  const viaImage = createCanvas(256, 256).getContext('2d')!
  viaImage.drawImage(src, 0, 0)
  const imgPx = viaImage.getImageData(48, 0, 1, 1).data
  t.false(isRed(imgPx), `drawImage lost the lottie frame: ${Array.from(imgPx)}`)

  const viaCanvas = createCanvas(256, 256).getContext('2d')!
  viaCanvas.drawCanvas(src, 0, 0)
  const canvasPx = viaCanvas.getImageData(48, 0, 1, 1).data
  t.false(isRed(canvasPx), `drawCanvas replayed the stale pre-lottie recording: ${Array.from(canvasPx)}`)
  t.deepEqual(Array.from(canvasPx), Array.from(imgPx), 'drawCanvas and drawImage disagree')
})

// CanvasPatterns built from one unchanged Image share its AccountedBitmap, so
// the dedup key is the bitmap's resource_id: N fresh wrappers over one image
// pin its raster once, not N times. Keying on the pattern wrapper instead
// charged w*h*4 per pattern (measured: 6.2 s / +48 MB for 100 fills on a
// 2048x2048 dest from a 1024x1024 Image; ~25 s / +192 MB at reviewer scale).
test.serial('fresh patterns over one unchanged Image stay fast and bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas, Image } = require('./index.js')
;(async () => {
  const maker = createCanvas(1024, 1024)
  maker.getContext('2d').fillRect(0, 0, 1024, 1024)
  const img = new Image()
  img.src = await maker.toBuffer('image/png')
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej })

  const ctx = createCanvas(2048, 2048).getContext('2d')
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
  global.gc()
  const before = process.memoryUsage().rss
  const start = Date.now()
  for (let i = 0; i < 100; i++) {
    ctx.fillStyle = ctx.createPattern(img, 'repeat')
    ctx.fillRect(0, 0, 2048, 2048)
  }
  const elapsed = Date.now() - start
  global.gc()
  const growth = process.memoryUsage().rss - before
  const px = ctx.getImageData(0, 0, 1, 1).data
  console.log(\`100 fresh-pattern fills: \${elapsed} ms, rss growth \${mb(growth)} MB\`)
  if (px[3] !== 255) {
    console.error(\`pattern fill produced no pixels: \${Array.from(px)}\`)
    process.exit(1)
  }
  if (elapsed > 3000) {
    console.error(\`fresh-pattern fills stalled: \${elapsed} ms\`)
    process.exit(1)
  }
  if (growth > 60 * 1024 * 1024) {
    console.error(\`shared bitmap backing re-charged per wrapper: \${mb(growth)} MB\`)
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

// A single oversized op must consolidate on its OWN charge, not on the next
// entry point's pre-check: three otherwise-idle 64x64 canvases each recording
// one putImageData from a shared 4096x4096 ImageData pinned ~192 MB before the
// post-op check (each held a 64 MB layer); after it, each consolidates to its
// 64x64 snapshot and the recorded pixel copies are released.
test.serial('one oversized putImageData consolidates without a follow-up call', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
;(async () => {
  let imageData = new (require('./index.js').ImageData)(4096, 4096)
  for (let i = 0; i < imageData.data.length; i += 4) imageData.data[i + 3] = 255
  const ctxs = [
    createCanvas(64, 64).getContext('2d'),
    createCanvas(64, 64).getContext('2d'),
    createCanvas(64, 64).getContext('2d'),
  ]
  await settle()
  const before = process.memoryUsage().rss
  for (const ctx of ctxs) {
    ctx.putImageData(imageData, 0, 0)
    // Deliberately no further canvas call: the post-op check must flush.
  }
  imageData = null
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss after 3 oversized putImageData, no follow-up: \${mb(growth)} MB\`)
  // ~64 MB measured (transient 64 MB JS buffer + malloc arena retention);
  // pre-fix pinned ~192 MB across the three recordings.
  if (growth > 110 * 1024 * 1024) {
    console.error(\`oversized layers stayed pinned: \${mb(growth)} MB\`)
    process.exit(1)
  }
  // Pixels still correct after the post-op flush consolidated the layers.
  for (const ctx of ctxs) {
    const px = ctx.getImageData(32, 32, 1, 1).data
    if (px[3] !== 255) {
      console.error(\`pixel lost after post-op consolidation: \${Array.from(px)}\`)
      process.exit(1)
    }
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

// Same post-op shape through drawImage: one draw of a large source pins its
// raster (~64 MB for 4096^2) inside the dest recording; on an idle canvas it
// must consolidate immediately rather than wait for the next op.
test.serial('one oversized drawImage consolidates without a follow-up call', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
;(async () => {
  const src = createCanvas(4096, 4096)
  src.getContext('2d').fillRect(0, 0, 4096, 4096)
  const ctxs = [createCanvas(64, 64).getContext('2d'), createCanvas(64, 64).getContext('2d')]
  await settle()
  const before = process.memoryUsage().rss
  for (const ctx of ctxs) ctx.drawImage(src, 0, 0)
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss after 2 oversized drawImage, no follow-up: \${mb(growth)} MB\`)
  // Each dest consolidates to its 64x64 snapshot; the 4096^2 source bitmap
  // (~64 MB) stays alive, but the per-draw pinned copies do not.
  if (growth > 110 * 1024 * 1024) {
    console.error(\`oversized drawImage layers stayed pinned: \${mb(growth)} MB\`)
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

// retained_rasters dedups drawCanvas picture charges (SkPicture::uniqueID)
// and drawImage source charges (next_resource_id + content_version) in one
// set. uniqueID and next_resource_id are independent counters that advance
// in lockstep through this sequence, so under one flat (u64, u64) key a
// blank 1x1 drawImage source's (rid, 0) key aliased the NEXT drawCanvas
// picture's (uid, 0) key: its ~4 MB retained-raster charge was deduped
// away, pending_bytes never crossed the cap, and every picture's pinned
// raster accumulated. Keys are now namespaced (RasterKey::Resource vs
// RasterKey::Picture) so the counters cannot collide.
test.serial('alternating small drawImage and large drawCanvas sources stay dedup-namespaced', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas, ImageData } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
;(async () => {
  const ctx = createCanvas(1024, 1024).getContext('2d')
  const imageData = new ImageData(1024, 1024)
  for (let i = 0; i < imageData.data.length; i += 4) imageData.data[i + 3] = 255
  await settle()
  const before = process.memoryUsage().rss
  for (let i = 0; i < 40; i++) {
    // Blank 1x1 source: content_version 0, so its retained-raster key is
    // (resource_id, 0) -- the exact shape a picture's (uniqueID, 0) key
    // collided with while the counters advance in lockstep.
    const tiny = createCanvas(1, 1)
    ctx.drawImage(tiny, 0, 0)
    // 1024^2 putImageData source: its composite picture pins a ~4 MB raster
    // copy the dedup aliasing used to silently uncharge.
    const big = createCanvas(1024, 1024)
    big.getContext('2d').putImageData(imageData, 0, 0)
    ctx.drawCanvas(big, 0, 0)
    if (i % 8 === 7) await settle()
  }
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss after 40 alternating drawImage/drawCanvas: \${mb(growth)} MB\`)
  // Aliased keys dropped every big-source charge: +198 MB measured pre-fix.
  // Namespaced keys charge ~4 MB/draw, so the cap still flushes and the
  // baseline settles at ~85 MB.
  if (growth > 120 * 1024 * 1024) {
    console.error(\`retained-raster keys collided across namespaces: \${mb(growth)} MB\`)
    process.exit(1)
  }
  const px = ctx.getImageData(0, 0, 1, 1).data
  if (px[3] !== 255) {
    console.error(\`drawCanvas pixel missing: \${Array.from(px)}\`)
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

// putImageData dirty params that make the src or dst rect Skia builds
// unfillable (NaN, +/-inf, f32 edge collapse like dirtyX=16777216 w=1) record
// nothing -- fillable() rejects them. The wrapper used to still pay
// put_pixels' full-ImageData pixel copy + charge first, so each rejected call
// consumed ~1 MB of budget and its rasterized-flush cost anyway.
test.serial('unfillable dirty-rect putImageData is a charge-free no-op', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas, ImageData } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
;(async () => {
  const ctx = createCanvas(1024, 1024).getContext('2d')
  const imageData = new ImageData(512, 512) // 1 MB pixel copy per charge
  for (let i = 0; i < imageData.data.length; i += 4) imageData.data[i + 3] = 255
  // Expensive pending recording so a spurious over-cap flush shows up as
  // both elapsed time and consolidate-snapshot RSS.
  ctx.filter = 'blur(8px)'
  for (let i = 0; i < 1200; i++) {
    ctx.fillRect(i % 700, i % 700, 150, 150)
  }
  ctx.filter = 'none'
  await settle()
  const before = process.memoryUsage().rss
  const t0 = Date.now()
  for (let i = 0; i < 8; i++) {
    // f32 edge collapse: 16777216+1 rounds back to 16777216.
    ctx.putImageData(imageData, 0, 0, 16777216, 0, 1, 8)
    // Same collapse on the destination side: dx + dirtyX overflows.
    ctx.putImageData(imageData, 16777216, 0, 0, 0, 1, 8)
    // NaN and +/-inf make src/dst rects non-finite or empty.
    ctx.putImageData(imageData, 0, 0, NaN, 0, 8, 8)
    ctx.putImageData(imageData, 0, 0, Infinity, 0, 8, 8)
    ctx.putImageData(imageData, 0, 0, 0, 0, -Infinity, 8)
    ctx.putImageData(imageData, 0, 0, 0, 0, 8, NaN)
  }
  const elapsed = Date.now() - t0
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`48 rejected putImageData over 1200 filtered fills: \${elapsed} ms, +\${mb(growth)} MB\`)
  // Charging before the record: 32 calls took ~3.6 s and +141 MB pre-fix.
  if (elapsed > 15000) {
    console.error(\`rejected putImageData triggered flush work: \${elapsed} ms\`)
    process.exit(1)
  }
  if (growth > 16 * 1024 * 1024) {
    console.error(\`rejected putImageData left phantom charges: \${mb(growth)} MB\`)
    process.exit(1)
  }
  // The no-ops painted nothing: a corner outside the fills stays transparent.
  const blank = ctx.getImageData(950, 950, 1, 1).data
  if (blank[3] !== 0) {
    console.error(\`rejected putImageData painted pixels: \${Array.from(blank)}\`)
    process.exit(1)
  }
  // A valid dirty rect still lands.
  ctx.putImageData(imageData, 20, 20, 0, 0, 8, 8)
  const px = ctx.getImageData(21, 21, 1, 1).data
  if (px[3] !== 255) {
    console.error(\`valid dirty-rect putImageData pixel missing: \${Array.from(px)}\`)
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

// A zero-area / non-finite fillRect paints nothing, but the paint charge used
// to land first: each distinct image pattern pinned its full raster in
// pending_bytes, forcing a flush that replays the pending blurred fills.
// fill_rect now preflights the sorted-rect fillability before
// account_paint_resources.
test.serial('zero-area pattern fillRects leave no phantom charge', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas, ImageData } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
;(async () => {
  const ctx = createCanvas(4096, 4096).getContext('2d')
  ctx.filter = 'blur(8px)'
  for (let i = 0; i < 1200; i++) {
    ctx.fillRect(i % 700, i % 700, 150, 150)
  }
  ctx.filter = 'none'
  // Distinct ~1 MB image patterns: the charge a zero-area fillRect must not pay.
  const pd = new ImageData(512, 512)
  for (let i = 0; i < pd.data.length; i += 4) {
    pd.data[i] = 255
    pd.data[i + 3] = 255
  }
  const patterns = []
  for (let i = 0; i < 40; i++) {
    const pc = createCanvas(512, 512)
    pc.getContext('2d').putImageData(pd, 0, 0)
    patterns.push(ctx.createPattern(pc, 'repeat'))
  }
  await settle()
  const before = process.memoryUsage().rss
  const t0 = Date.now()
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = patterns[i]
    ctx.fillRect(0, 0, 0, 0)
    // f32 edge collapse: 16777216 + 1 rounds back to 16777216.
    ctx.fillRect(16777216, 0, 1, 8)
    // Non-finite rects.
    ctx.fillRect(NaN, 0, 8, 8)
    ctx.fillRect(0, 0, 8, Infinity)
  }
  const elapsed = Date.now() - t0
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`160 no-op pattern fillRects over 1200 blurred fills: \${elapsed} ms, +\${mb(growth)} MB\`)
  // Charging before the no-record check: 104 s and +260 MB measured pre-fix.
  if (elapsed > 20000) {
    console.error(\`no-op fillRect triggered flush work: \${elapsed} ms\`)
    process.exit(1)
  }
  if (growth > 64 * 1024 * 1024) {
    console.error(\`no-op fillRect left phantom charges: \${mb(growth)} MB\`)
    process.exit(1)
  }
  // Nothing painted where the blurred fills cannot reach.
  const blank = ctx.getImageData(3000, 3000, 1, 1).data
  if (blank[3] !== 0) {
    console.error(\`no-op fillRect painted pixels: \${Array.from(blank)}\`)
    process.exit(1)
  }
  // drawRect sorts its rect: negative dims still paint and must not skip.
  ctx.fillStyle = '#0f0'
  ctx.fillRect(100, 100, -50, -50)
  const neg = ctx.getImageData(75, 75, 1, 1).data
  if (neg[1] !== 255 || neg[3] !== 255) {
    console.error(\`negative-size fillRect pixel missing: \${Array.from(neg)}\`)
    process.exit(1)
  }
  // A real fillRect of a pattern still lands.
  ctx.fillStyle = patterns[0]
  ctx.fillRect(10, 10, 20, 20)
  const px = ctx.getImageData(15, 15, 1, 1).data
  if (px[3] !== 255) {
    console.error(\`real fillRect pixel missing: \${Array.from(px)}\`)
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

// An empty path (no verbs, or degenerate all-moveTo bounds) fills nothing --
// Skia rejects it in onDrawPath -- but fill() used to charge the paint's
// raster payload plus the path bytes anyway. Same for stroke() on a path
// whose bounds are non-finite.
test.serial('empty-path fill and stroke leave no phantom charge', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `${SETTLE}
const { createCanvas, ImageData } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
;(async () => {
  const ctx = createCanvas(4096, 4096).getContext('2d')
  ctx.filter = 'blur(8px)'
  for (let i = 0; i < 1200; i++) {
    ctx.fillRect(i % 700, i % 700, 150, 150)
  }
  ctx.filter = 'none'
  const pd = new ImageData(512, 512)
  for (let i = 0; i < pd.data.length; i += 4) {
    pd.data[i] = 255
    pd.data[i + 3] = 255
  }
  const patterns = []
  for (let i = 0; i < 40; i++) {
    const pc = createCanvas(512, 512)
    pc.getContext('2d').putImageData(pd, 0, 0)
    patterns.push(ctx.createPattern(pc, 'repeat'))
  }
  await settle()
  const before = process.memoryUsage().rss
  const t0 = Date.now()
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = patterns[i]
    ctx.strokeStyle = patterns[(i + 1) % 40]
    // No verbs at all.
    ctx.beginPath()
    ctx.fill()
    // Degenerate bounds: moveTo only -- zero fill coverage.
    ctx.beginPath()
    ctx.moveTo(500, 500)
    ctx.fill()
    // Verb-less path: no cap can paint, even for stroke.
    ctx.beginPath()
    ctx.stroke()
  }
  const elapsed = Date.now() - t0
  await settle()
  const growth = process.memoryUsage().rss - before
  console.log(\`120 empty-path fills/strokes over 1200 blurred fills: \${elapsed} ms, +\${mb(growth)} MB\`)
  if (elapsed > 20000) {
    console.error(\`empty-path draw triggered flush work: \${elapsed} ms\`)
    process.exit(1)
  }
  if (growth > 64 * 1024 * 1024) {
    console.error(\`empty-path draw left phantom charges: \${mb(growth)} MB\`)
    process.exit(1)
  }
  // A real fill still lands.
  ctx.fillStyle = '#f00'
  ctx.beginPath()
  ctx.rect(10, 10, 20, 20)
  ctx.fill()
  const px = ctx.getImageData(15, 15, 1, 1).data
  if (px[0] !== 255 || px[3] !== 255) {
    console.error(\`real fill pixel missing: \${Array.from(px)}\`)
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

// Round-16 regression: the deferred-recording preflights must skip only ops
// that paint NOTHING. skiac_canvas_draw_image's canvas arm and
// skiac_canvas_draw_picture_rect clip with clipRect(MakeWH/MakeXYWH), which
// runs makeSorted() -- negative dw/dh sort to a positive span and the draw
// paints, mirrored. An earlier preflight demanded positive dims and dropped
// the pixels. These draws must land.
test('negative destination dims still paint through drawImage and drawCanvas', (t) => {
  const src = createCanvas(10, 10)
  const sctx = src.getContext('2d')
  sctx.fillStyle = '#f00'
  sctx.fillRect(0, 0, 10, 10)

  // drawImage(canvas, dx, dy, dw, dh) with negative dw / dh.
  let ctx = createCanvas(64, 64).getContext('2d')
  ctx.drawImage(src, 30, 20, -10, 10)
  t.deepEqual(Array.from(ctx.getImageData(25, 25, 1, 1).data), [255, 0, 0, 255])
  ctx = createCanvas(64, 64).getContext('2d')
  ctx.drawImage(src, 30, 20, 10, -10)
  t.deepEqual(Array.from(ctx.getImageData(35, 15, 1, 1).data), [255, 0, 0, 255])

  // 9-arg form with negative dw AND dh.
  ctx = createCanvas(64, 64).getContext('2d')
  ctx.drawImage(src, 0, 0, 10, 10, 30, 20, -10, -10)
  t.deepEqual(Array.from(ctx.getImageData(25, 15, 1, 1).data), [255, 0, 0, 255])

  // drawCanvas goes through draw_picture_rect: same sorted clip.
  sctx.fillStyle = '#0f0'
  sctx.fillRect(0, 0, 10, 10)
  ctx = createCanvas(64, 64).getContext('2d')
  ctx.drawCanvas(src, 30, 20, -10, 10)
  t.deepEqual(Array.from(ctx.getImageData(25, 25, 1, 1).data), [0, 255, 0, 255])
  ctx = createCanvas(64, 64).getContext('2d')
  ctx.drawCanvas(src, 0, 0, 10, 10, 30, 20, -10, -10)
  t.deepEqual(Array.from(ctx.getImageData(25, 15, 1, 1).data), [0, 255, 0, 255])

  // Genuinely empty spans still skip: nothing painted, no charge.
  ctx = createCanvas(64, 64).getContext('2d')
  ctx.drawCanvas(src, 0, 0, 0, 10)
  ctx.drawImage(src, 0, 0, 10, 0)
  t.deepEqual(Array.from(ctx.getImageData(0, 0, 1, 1).data), [0, 0, 0, 0])
})

// putImageData draws through drawImageRect, whose fillable() checks run on
// the UNSORTED dirty rects -- a negative dirty span legitimately paints
// nothing, and the preflight's rect_fillable mirrors that. Negative dx/dy
// keep painting (the bitmap is clipped by the canvas, not rejected).
test('putImageData negative dirty span paints nothing, negative dx/dy paint', (t) => {
  const ctx = createCanvas(32, 32).getContext('2d')
  const red = new ImageData(8, 8)
  for (let i = 0; i < red.data.length; i += 4) {
    red.data[i] = 255
    red.data[i + 3] = 255
  }
  ctx.putImageData(red, 10, 10, 0, 0, -4, 8)
  ctx.putImageData(red, 20, 20, 0, 0, 8, -4)
  t.deepEqual(Array.from(ctx.getImageData(12, 12, 1, 1).data), [0, 0, 0, 0])
  t.deepEqual(Array.from(ctx.getImageData(22, 22, 1, 1).data), [0, 0, 0, 0])
  ctx.putImageData(red, -4, -4)
  t.deepEqual(Array.from(ctx.getImageData(1, 1, 1, 1).data), [255, 0, 0, 255])
})

// Round-17 regression: the canvas-arm drawImage preflight used to gate on a
// derived `dx - sx*scale_x` term that the C++ never forms -- it applies
// translate and scale SEQUENTIALLY to the ambient CTM. Under a tiny-scale
// CTM the derived term overflows f32 while the composed matrix stays finite
// (a=30, e=30 here), so a painting draw was dropped.
test('drawImage under extreme CTM paints when the composed matrix is finite', (t) => {
  const src = createCanvas(10, 10)
  const sctx = src.getContext('2d')
  sctx.fillStyle = '#f00'
  sctx.fillRect(0, 0, 10, 10)
  const ctx = createCanvas(64, 64).getContext('2d')
  ctx.setTransform(-1e-37, 0, 0, 1, 0, 0)
  ctx.drawImage(src, 9, 0, 1, 10, -3e38, 0, -3e38, 10)
  t.deepEqual(Array.from(ctx.getImageData(45, 5, 1, 1).data), [255, 0, 0, 255])
})

// Round-17 regression: drawCanvas gated the dst clip on endpoint
// fillability, but SkCanvas::clipRect IGNORES a non-finite rect -- the clip
// stays open and the CTM can rescale content back into view. Only a finite
// collapsed span (dw == 0 / edge collapse) empties the clip.
test('drawCanvas with overflowing clip endpoint still paints', (t) => {
  const src = createCanvas(10, 10)
  const sctx = src.getContext('2d')
  sctx.fillStyle = '#0f0'
  sctx.fillRect(0, 0, 10, 10)
  const ctx = createCanvas(64, 64).getContext('2d')
  ctx.setTransform(1e-37, 0, 0, 1, 0, 0)
  // dx + dw overflows f32 to +inf: clipRect ignores it, effective scale 34
  // maps the source into the visible region.
  ctx.drawCanvas(src, 1, 0, 1, 10, 3.4e38, 0, 3.4e38, 10)
  t.deepEqual(Array.from(ctx.getImageData(50, 5, 1, 1).data), [0, 255, 0, 255])

  // A finite collapsed clip still records nothing and must stay skipped.
  const empty = createCanvas(64, 64).getContext('2d')
  empty.drawCanvas(src, 16777216, 0, 1, 10)
  t.deepEqual(Array.from(empty.getImageData(10, 5, 1, 1).data), [0, 0, 0, 0])
})

// Round-18 regression: draw_canvas used to gate on the finiteness of the
// postTranslate term `dx - sx*scale_x`, computed with separate f32 mul+sub.
// The C++ helper forms the same term but release builds contract it to a
// fused fma, which rounds differently at the boundary: Rust got -inf and
// skipped while Skia gets a finite term and paints. The preflight now only
// skips conditions decidable without replicating C++ float math (sw==0 /
// sh==0, finite-collapsed clip).
test('drawCanvas with a fused-arithmetic boundary term still paints', (t) => {
  const src = createCanvas(10, 10)
  const sctx = src.getContext('2d')
  sctx.fillStyle = '#f00'
  sctx.fillRect(0, 0, 10, 10)
  const ctx = createCanvas(64, 64).getContext('2d')
  ctx.setTransform(-1e-30, 0, 0, 1, 0, 0)
  // FLT_MAX dx, 1e38 dw: dx - sx*scale_x overflows to -inf under unfused
  // evaluation but stays finite when the C++ contracts to fmsub; the
  // composed CTM maps a band of the source into view.
  ctx.drawCanvas(src, 34028238848, 0, 1e10, 10, 3.4028235e38, 0, 1e38, 10)
  const row = ctx.getImageData(0, 5, 64, 1).data
  let painted = false
  for (let x = 0; x < 64; x++) {
    if (row[x * 4 + 3] !== 0) {
      painted = true
      break
    }
  }
  t.true(painted, 'expected a painted band; all 64 row pixels transparent')
})

// Round-19 regression: a recorded fill/stroke/clip pins the path's SkPathData
// (~16 B/point + 8 B/verb), which approximateBytesUsed cannot see and which
// used to be missing from retained_raster_bytes entirely -- so a dest that
// drawCanvas-es disposable sources each holding one 100k-point path grew
// linearly and unboundedly (measured +52/+97/+187/+371 MB for 25/50/100/200
// sources). The charge now dedups per unique path-data version
// (SkPath::getGenerationID) and lands in the retained tally, so the dest
// pays it once per source, hits the byte cap, and consolidates to O(canvas)
// pictures. The gc/yield pairs let napi finalizers free the dropped sources;
// without yields deferred finalization dominates the RSS reading.
test.serial('drawCanvas of disposable path-heavy sources stays bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas, Path2D } = require('./index.js')
const dest = createCanvas(64, 64)
const dctx = dest.getContext('2d')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const tick = () => new Promise((r) => setImmediate(r))
function makeSource() {
  const src = createCanvas(64, 64)
  const sctx = src.getContext('2d')
  const p = new Path2D()
  for (let i = 0; i < 100000; i++) {
    if (i === 0) p.moveTo(0, 0)
    else p.lineTo(i % 64, (i * 7) % 64)
  }
  sctx.stroke(p)
  return src
}
;(async () => {
  global.gc()
  await tick()
  const before = process.memoryUsage().rss
  for (let i = 0; i < 200; i++) {
    dctx.drawCanvas(makeSource(), 0, 0)
    if (i % 25 === 24) {
      global.gc()
      await tick()
    }
  }
  global.gc()
  await tick()
  await tick()
  global.gc()
  const growth = process.memoryUsage().rss - before
  console.log(\`rss growth after 200 path-heavy drawCanvas sources: \${mb(growth)} MB\`)
  // ~190 MB/source retained before the fix (~370 MB at N=200); the dest
  // consolidates once raster_bytes crosses the 32 MiB cap.
  if (growth > 120 * 1024 * 1024) {
    console.error(\`source path payloads never consolidated: \${mb(growth)} MB\`)
    process.exit(1)
  }
  // The recorded picture still renders: last source's stroke must be visible.
  const px = dctx.getImageData(0, 0, 64, 64).data
  let painted = 0
  for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) painted++
  if (painted === 0) {
    console.error('dest lost all recorded content')
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

// Round-19 regression (inverse direction): repeated draws of ONE unchanged
// Path2D share its SkPathData, but the flat per-draw charge paid the full
// payload every time -- 360 strokes of a 100k-point path crossed the 32 MiB
// cap and started flushing every ~14 draws (measured ~298 ms). Charging by
// path-data generation dedups them: one ~2.4 MB charge per window.
test.serial('repeated strokes of one unchanged Path2D dedup and do not stall', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas, Path2D } = require('./index.js')
const ctx = createCanvas(64, 64).getContext('2d')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const p = new Path2D()
for (let i = 0; i < 100000; i++) {
  if (i === 0) p.moveTo(0, 0)
  else p.lineTo(i % 64, (i * 7) % 64)
}
global.gc()
const before = process.memoryUsage().rss
const start = Date.now()
for (let i = 0; i < 720; i++) ctx.stroke(p)
const elapsed = Date.now() - start
global.gc()
const growth = process.memoryUsage().rss - before
console.log(\`720 strokes of one 100k-point Path2D: \${elapsed} ms, rss growth \${mb(growth)} MB\`)
if (elapsed > 3000) {
  console.error(\`same-path draws tripped the budget: \${elapsed} ms\`)
  process.exit(1)
}
if (growth > 150 * 1024 * 1024) {
  console.error(\`shared path data charged per draw: \${mb(growth)} MB\`)
  process.exit(1)
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// Round-19 regression: with_surface_canvas used to rebase the recorder on a
// fresh surface snapshot after EVERY direct write. The snapshot picture pins
// the raster, so the next direct write copy-on-writes the whole canvas --
// 60 lottie frames at 4096x4096 paid ~1.9 s and +128 MB for a 2-frame warm
// start. The rebase is now lazy (note_surface_write drops the already-flushed
// layers without snapshotting), so write-only loops never pay the COW; the
// snapshot materializes only when a read-out (drawCanvas/get_picture)
// consumes the picture.
test.serial('lottie render loop without read-outs does not COW the surface', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { readFileSync } = require('node:fs')
const { createCanvas, LottieAnimation } = require('./index.js')
const lottie = LottieAnimation.loadFromData(readFileSync('example/flat-lottie.json', 'utf-8'))
const ctx = createCanvas(4096, 4096).getContext('2d')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
global.gc()
const before = process.memoryUsage().rss
const start = Date.now()
for (let i = 0; i < 30; i++) {
  lottie.seek(i / 30)
  lottie.render(ctx, { x: 0, y: 0, width: 4096, height: 4096 })
}
const elapsed = Date.now() - start
global.gc()
const growth = process.memoryUsage().rss - before
console.log(\`30 lottie frames at 4096x4096: \${elapsed} ms, rss growth \${mb(growth)} MB\`)
// A per-frame snapshot+COW would pin +64 MB/frame warm and ~+96 MB here;
// the rasterization itself is ~35 ms/frame either way.
if (growth > 80 * 1024 * 1024) {
  console.error(\`direct writes COW'd the surface per frame: \${mb(growth)} MB\`)
  process.exit(1)
}
if (elapsed > 3500) {
  console.error(\`lottie loop regressed: \${elapsed} ms\`)
  process.exit(1)
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// The lazy rebase must still materialize a complete picture on read-out:
// ops recorded AFTER a direct surface write land on the surface over it,
// and get_picture() snapshots the post-write raster plus those ops.
test.serial('drawCanvas shows ops recorded after a direct write, over it', (t) => {
  const lottie = LottieAnimation.loadFromData(readFileSync(join(root, 'example/flat-lottie.json'), 'utf-8'))
  const src = createCanvas(256, 256)
  const sctx = src.getContext('2d')!
  sctx.fillStyle = '#ff0000'
  sctx.fillRect(0, 0, 256, 256)
  lottie.render(sctx, { x: 0, y: 0, width: 256, height: 64 })
  sctx.fillStyle = '#00ff00'
  sctx.fillRect(0, 200, 256, 56)

  const viaCanvas = createCanvas(256, 256).getContext('2d')!
  viaCanvas.drawCanvas(src, 0, 0)
  const isRed = (d: Uint8ClampedArray) => d[0] === 255 && d[1] === 0 && d[2] === 0
  t.false(isRed(viaCanvas.getImageData(48, 10, 1, 1).data), 'drawCanvas lost the direct write')
  t.deepEqual(
    Array.from(viaCanvas.getImageData(48, 220, 1, 1).data),
    [0, 255, 0, 255],
    'drawCanvas lost the post-write recorded fill',
  )
})

// Round-20 regression: resume_recording() re-records the tracked clip path
// into every fresh layer without charging its SkPathData. After
// consolidate_with_snapshot() clears retained_rasters, the resumed clip
// rides into the next retained pictures uncharged, so a dest drawCanvas-ing
// clipped disposable sources grew ~1 MB/source (measured +143 -> +192 MB
// physical footprint for 24 -> 48 sources). The restored clip is now charged
// under RasterKey::Path by generation id: once per window, re-charged after
// each consolidation when the new layer actually re-pins the data.
test.serial('drawCanvas of clip-heavy consolidated sources stays bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas, Path2D, ImageData } = require('./index.js')
const dest = createCanvas(64, 64)
const dctx = dest.getContext('2d')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const tick = () => new Promise((r) => setImmediate(r))
function makeSource() {
  const src = createCanvas(16, 16)
  const sctx = src.getContext('2d')
  const p = new Path2D()
  for (let i = 0; i < 50000; i++) p.rect(0, 0, 16, 16)
  sctx.clip(p)
  // putImageData + getImageData promote and consolidate, forcing a resumed
  // recording that re-pins the clip path data on the NEXT layer.
  sctx.putImageData(new ImageData(16, 16), 0, 0)
  sctx.getImageData(0, 0, 1, 1)
  sctx.fillStyle = '#f00'
  sctx.fillRect(0, 0, 16, 16)
  return src
}
;(async () => {
  global.gc()
  await tick()
  for (let i = 0; i < 24; i++) {
    dctx.drawCanvas(makeSource(), 0, 0)
    if (i % 8 === 7) {
      global.gc()
      await tick()
    }
  }
  global.gc()
  await tick()
  await tick()
  global.gc()
  const mid = process.memoryUsage().rss
  for (let i = 0; i < 24; i++) {
    dctx.drawCanvas(makeSource(), 0, 0)
    if (i % 8 === 7) {
      global.gc()
      await tick()
    }
  }
  global.gc()
  await tick()
  await tick()
  global.gc()
  const growth = process.memoryUsage().rss - mid
  console.log(\`rss growth for the second 24 clipped sources: \${mb(growth)} MB\`)
  // Uncharged resumed clips pinned ~1 MB/source (~+25-50 MB for 24); the
  // charge now consolidates them, leaving only window + finalizer slack.
  if (growth > 40 * 1024 * 1024) {
    console.error(\`resumed clip payloads escaped the budget: \${mb(growth)} MB\`)
    process.exit(1)
  }
  // Clip must still apply: dest content is the last source's clipped fill.
  const px = dctx.getImageData(8, 8, 1, 1).data
  if (!(px[0] === 255 && px[1] === 0 && px[2] === 0 && px[3] === 255)) {
    console.error(\`clipped fill lost: \${Array.from(px)}\`)
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

// Round-21 regression: every paint payload the recorded op retains but
// SkPicture::approximateBytesUsed cannot see must ride the raster tally so a
// drawCanvas destination is charged. Dash PathEffects are rebuilt per draw
// (stroke_paint constructs a fresh one from line_dash_list each call), so the
// charge is per draw with no dedup key; before the fix it went to
// recorded_bytes only and drawCanvas sources dropped it -- RSS grew ~102 MB
// per 100 disposable dash-heavy sources, linearly. With the charge
// propagated, the dest consolidates under the 32 MiB cap and a second
// identical phase adds ~0.
test.serial('drawCanvas of disposable dash-heavy sources stays bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const dest = createCanvas(64, 64)
const dctx = dest.getContext('2d')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const tick = () => new Promise((r) => setImmediate(r))
function makeSource() {
  const src = createCanvas(64, 64)
  const sctx = src.getContext('2d')
  // 250k-entry dash array ~= 1 MB of PathEffect retained per recorded stroke.
  sctx.setLineDash(new Array(250000).fill(1.5))
  sctx.strokeRect(1, 1, 20, 20)
  return src
}
async function phase(n) {
  for (let i = 0; i < n; i++) {
    dctx.drawCanvas(makeSource(), 0, 0)
    if (i % 25 === 24) {
      global.gc()
      await tick()
    }
  }
}
;(async () => {
  global.gc()
  await tick()
  const before = process.memoryUsage().rss
  await phase(200)
  global.gc()
  await tick()
  await tick()
  global.gc()
  const phase1 = process.memoryUsage().rss - before
  const mark = process.memoryUsage().rss
  await phase(200)
  global.gc()
  await tick()
  await tick()
  global.gc()
  const phase2 = process.memoryUsage().rss - mark
  console.log(
    \`400 dash-heavy drawCanvas sources: phase1 +\${mb(phase1)} MB, phase2 +\${mb(phase2)} MB\`,
  )
  // Pre-fix the second phase grew like the first (~+200 MB); post-fix the
  // dest consolidates under the byte cap and re-uses a flat window.
  if (phase2 > 80 * 1024 * 1024) {
    console.error(\`dash payloads never consolidated: phase2 +\${mb(phase2)} MB\`)
    process.exit(1)
  }
  // The recorded picture still renders: the last source's stroke is visible.
  const px = dctx.getImageData(0, 0, 64, 64).data
  let painted = 0
  for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) painted++
  if (painted === 0) {
    console.error('dest lost all recorded content')
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

// Round-21 regression: the drawImage canvas-source dedup key is (resource_id,
// content_version), and the version must advance only when an op can alter
// pixels. Before the fix get_recording_canvas bumped it for every recorded
// op -- save/restore included -- so state-only churn between draws of an
// unchanged source drew under a fresh key each time and re-paid the raster
// charge (200 draws of a 512x512 source: +193 MB). Now state ops leave the
// generation alone: phase A must stay near-flat like a truly unchanged
// source, while the phase-B control proves a real mutation still bumps the
// key and re-charges.
test.serial('state-only ops between drawImage reads keep the source deduped', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const tick = () => new Promise((r) => setImmediate(r))
const src = createCanvas(512, 512)
const sctx = src.getContext('2d')
sctx.fillStyle = '#f00'
sctx.fillRect(0, 0, 512, 512)
const dest = createCanvas(1024, 1024)
const dctx = dest.getContext('2d')
;(async () => {
  global.gc()
  await tick()
  const before = process.memoryUsage().rss
  const t0 = Date.now()
  // Phase A: state-only churn between draws -- pixels never change.
  for (let i = 0; i < 200; i++) {
    sctx.save()
    sctx.translate(4, 4)
    sctx.restore()
    dctx.drawImage(src, i % 512, i % 512, 64, 64, 0, 0, 64, 64)
  }
  const elapsed = Date.now() - t0
  global.gc()
  await tick()
  await tick()
  global.gc()
  const stateGrowth = process.memoryUsage().rss - before
  console.log(
    \`200 draws with save/restore/translate between reads: \${elapsed} ms, rss +\${mb(
      stateGrowth,
    )} MB\`,
  )
  if (elapsed > 3000) {
    console.error(\`dedup churned on state-only ops: \${elapsed} ms\`)
    process.exit(1)
  }
  if (stateGrowth > 40 * 1024 * 1024) {
    console.error(\`state-only ops defeated the dedup key: +\${mb(stateGrowth)} MB\`)
    process.exit(1)
  }
  // Phase B (control): real mutations must still advance the generation --
  // every draw pins a fresh 1 MB snapshot generation and the dest re-charges.
  const mark = process.memoryUsage().rss
  for (let i = 0; i < 200; i++) {
    sctx.fillRect(i % 512, i % 512, 1, 1)
    dctx.drawImage(src, i % 512, i % 512, 64, 64, 0, 0, 64, 64)
  }
  global.gc()
  await tick()
  await tick()
  global.gc()
  const mutateGrowth = process.memoryUsage().rss - mark
  console.log(\`200 draws with a real mutation between reads: rss +\${mb(mutateGrowth)} MB\`)
  if (mutateGrowth < stateGrowth + 24 * 1024 * 1024) {
    console.error(
      \`mutated source failed to re-charge: +\${mb(mutateGrowth)} MB vs state +\${mb(
        stateGrowth,
      )} MB\`,
    )
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

// Round-22 regression: a deterministically-empty clearRect must not reach the
// recording at all. Before the fix the partial-clear path had no preflight,
// so clearRect(0,0,0,0) recorded a drawRect, bumped the source's
// content_version and defeated drawImage dedup: 200 no-op clears +
// drawImage(512x512) cost ~16 ms/+193 MB vs ~1 ms/+1 MB unchanged. Phase A
// asserts the deduped baseline, phase B is the mutated control (a real
// nonzero clear must still advance the generation and re-charge).
test.serial('no-op clearRect keeps a canvas drawImage source deduped', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const tick = () => new Promise((r) => setImmediate(r))
const src = createCanvas(512, 512)
const sctx = src.getContext('2d')
sctx.fillStyle = '#f00'
sctx.fillRect(0, 0, 512, 512)
const dest = createCanvas(1024, 1024)
const dctx = dest.getContext('2d')
;(async () => {
  global.gc()
  await tick()
  const before = process.memoryUsage().rss
  const t0 = Date.now()
  for (let i = 0; i < 200; i++) {
    sctx.clearRect(0, 0, 0, 0) // zero-area: paints nothing, must not bump
    dctx.drawImage(src, i % 512, i % 512, 64, 64, 0, 0, 64, 64)
  }
  const elapsed = Date.now() - t0
  global.gc()
  await tick()
  await tick()
  global.gc()
  const clearGrowth = process.memoryUsage().rss - before
  console.log(
    \`200 draws with no-op clearRect between reads: \${elapsed} ms, rss +\${mb(clearGrowth)} MB\`,
  )
  if (elapsed > 3000) {
    console.error(\`dedup churned on no-op clearRect: \${elapsed} ms\`)
    process.exit(1)
  }
  if (clearGrowth > 40 * 1024 * 1024) {
    console.error(\`no-op clearRect defeated the dedup key: +\${mb(clearGrowth)} MB\`)
    process.exit(1)
  }
  // Control: a nonzero-area clear mutates pixels and must re-charge.
  const mark = process.memoryUsage().rss
  for (let i = 0; i < 200; i++) {
    sctx.clearRect(10, 10, 1, 1)
    dctx.drawImage(src, i % 512, i % 512, 64, 64, 0, 0, 64, 64)
  }
  global.gc()
  await tick()
  await tick()
  global.gc()
  const mutateGrowth = process.memoryUsage().rss - mark
  console.log(\`200 draws with real clearRect between reads: rss +\${mb(mutateGrowth)} MB\`)
  if (mutateGrowth < clearGrowth + 24 * 1024 * 1024) {
    console.error(
      \`mutated source failed to re-charge: +\${mb(mutateGrowth)} MB vs +\${mb(clearGrowth)} MB\`,
    )
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

// Round-22 regression: with_canvas_state bumped the DIRECT backend's
// content_version on every state op, so an SVG source that only did
// save/translate/restore between drawImage reads drew under a fresh key each
// time. Direct state ops write no pixels; the generation now advances only at
// the pixel writers (render_passes' direct arm, reset, put_image_data).
test.serial('SVG source state-only ops between drawImage reads stay deduped', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas, SvgExportFlag } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const tick = () => new Promise((r) => setImmediate(r))
const src = createCanvas(512, 512, SvgExportFlag.NoPrettyXML)
const sctx = src.getContext('2d')
sctx.fillStyle = '#f00'
sctx.fillRect(0, 0, 512, 512)
const dest = createCanvas(1024, 1024)
const dctx = dest.getContext('2d')
;(async () => {
  global.gc()
  await tick()
  const before = process.memoryUsage().rss
  for (let i = 0; i < 200; i++) {
    sctx.save()
    sctx.translate(4, 4)
    sctx.restore()
    dctx.drawImage(src, i % 512, i % 512, 64, 64, 0, 0, 64, 64)
  }
  global.gc()
  await tick()
  await tick()
  global.gc()
  const stateGrowth = process.memoryUsage().rss - before
  console.log(\`200 draws with SVG state churn between reads: rss +\${mb(stateGrowth)} MB\`)
  if (stateGrowth > 40 * 1024 * 1024) {
    console.error(\`SVG state ops defeated the dedup key: +\${mb(stateGrowth)} MB\`)
    process.exit(1)
  }
  // Control: a real draw on the SVG source must still bump and re-charge.
  const mark = process.memoryUsage().rss
  for (let i = 0; i < 200; i++) {
    sctx.fillRect(i % 512, i % 512, 1, 1)
    dctx.drawImage(src, i % 512, i % 512, 64, 64, 0, 0, 64, 64)
  }
  global.gc()
  await tick()
  await tick()
  global.gc()
  const mutateGrowth = process.memoryUsage().rss - mark
  console.log(\`200 draws with SVG draws between reads: rss +\${mb(mutateGrowth)} MB\`)
  if (mutateGrowth < stateGrowth + 4 * 1024 * 1024) {
    console.error(
      \`mutated SVG source failed to re-charge: +\${mb(mutateGrowth)} MB vs +\${mb(stateGrowth)} MB\`,
    )
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

// Round-22 regression: ctx.filter builds ONE refcounted ImageFilter DAG on the
// state; every recorded paint shares it. Billing filters_string.len() * 8 per
// draw flushed the recording every ~125 draws for a 32 KB chain (5000 draws:
// ~40 consolidations, ~650 ms). The charge is now deduped under the chain's
// minted id, so 20k draws of one unchanged filter stay a single charge.
test.serial('one reused long filter chain stays a single charge', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const ctx = createCanvas(512, 512).getContext('2d')
ctx.filter = new Array(2000).fill('brightness(1.1)').join(' ')
global.gc()
const before = process.memoryUsage().rss
const t0 = Date.now()
for (let i = 0; i < 20000; i++) {
  ctx.fillRect(i % 64, i % 64, 4, 4)
}
const elapsed = Date.now() - t0
global.gc()
const growth = process.memoryUsage().rss - before
console.log(\`20000 draws under one 2000-node filter: \${elapsed} ms, rss +\${mb(growth)} MB\`)
// Pre-fix the per-draw charge flushed ~160 times, rasterising the chain each
// flush; post-fix there is one ~256 KB charge and no filter playback at all.
if (elapsed > 15000) {
  console.error(\`reused filter chain forced consolidation churn: \${elapsed} ms\`)
  process.exit(1)
}
if (growth > 128 * 1024 * 1024) {
  console.error(\`reused filter chain billed per draw: +\${mb(growth)} MB\`)
  process.exit(1)
}
console.log('finished without crash')
`,
    ['--expose-gc'],
  )

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  t.true(stdout.includes('finished without crash'), `unexpected output:\n${stdout}`)
})

// Round-22 regression: isolation-layer pictures from composited_pass are
// already inside the parent picture's approximateBytesUsed
// (SkRecordCanvas::onDrawPicture folds child bytes into
// fApproxBytesUsedBySubPictures), so they must sit in pending_bytes only --
// routing them to raster_bytes double-counted them for every drawCanvas of
// the source. Observable effect is premature destination consolidations
// (forced replays); this exercises a composite-heavy source end to end and
// asserts the dest stays bounded and correct.
test.serial('drawCanvas of composite-heavy sources stays bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const tick = () => new Promise((r) => setImmediate(r))
function makeSource() {
  const src = createCanvas(64, 64)
  const sctx = src.getContext('2d')
  sctx.fillStyle = '#0a0a0a'
  sctx.fillRect(0, 0, 64, 64) // base content for source-in to keep
  sctx.globalCompositeOperation = 'source-in' // every draw isolates into a nested picture
  for (let i = 0; i < 200; i++) sctx.fillRect(8, 8, 4, 4)
  return src
}
const dest = createCanvas(128, 128)
const dctx = dest.getContext('2d')
;(async () => {
  global.gc()
  await tick()
  const before = process.memoryUsage().rss
  for (let i = 0; i < 50; i++) {
    dctx.drawCanvas(makeSource(), 0, 0)
    if (i % 25 === 24) {
      global.gc()
      await tick()
    }
  }
  global.gc()
  await tick()
  await tick()
  global.gc()
  const growth = process.memoryUsage().rss - before
  console.log(\`50 drawCanvas of 200-op source-in sources: rss +\${mb(growth)} MB\`)
  if (growth > 96 * 1024 * 1024) {
    console.error(\`composite-heavy sources never consolidated: +\${mb(growth)} MB\`)
    process.exit(1)
  }
  const px = dctx.getImageData(0, 0, 128, 128).data
  let painted = 0
  for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) painted++
  if (painted === 0) {
    console.error('dest lost all recorded content')
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

// Round-22 regression: every recorded text blob refs the SAME resolved
// typeface for a repeated font descriptor, so the flat 1 MiB typeface charge
// must dedup per window rather than bill per draw (320 fillText forced ~10
// consolidations and +194 MB pre-fix). The dedup key folds in the
// font-collection generation so GlobalFonts.register between draws re-charges.
test.serial('repeated fillText on one font stays bounded', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { createCanvas } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const tick = () => new Promise((r) => setImmediate(r))
const ctx = createCanvas(1024, 1024).getContext('2d')
ctx.font = '40px sans-serif'
;(async () => {
  global.gc()
  await tick()
  const before = process.memoryUsage().rss
  const t0 = Date.now()
  for (let i = 0; i < 320; i++) {
    ctx.fillText('hello', i % 512, i % 512)
    if (i % 100 === 99) {
      global.gc()
      await tick()
    }
  }
  const elapsed = Date.now() - t0
  global.gc()
  await tick()
  await tick()
  global.gc()
  const growth = process.memoryUsage().rss - before
  console.log(\`320 fillText on one font: \${elapsed} ms, rss +\${mb(growth)} MB\`)
  if (elapsed > 5000) {
    console.error(\`fillText loop forced consolidation churn: \${elapsed} ms\`)
    process.exit(1)
  }
  if (growth > 64 * 1024 * 1024) {
    console.error(\`typeface billed per draw: +\${mb(growth)} MB\`)
    process.exit(1)
  }
  // The text actually rendered.
  const px = ctx.getImageData(0, 0, 512, 512).data
  let painted = 0
  for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) painted++
  if (painted === 0) {
    console.error('text never painted')
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

// Round-23 regression: loadFontsFromDir must advance the font-collection
// generation per registration while the collection lock is held. Before the
// fix the generation moved once after the whole directory, so a draw on
// another thread between files could resolve a freshly-registered typeface
// under the stale RasterKey::Typeface dedup key and under-charge it. The
// deterministic halves: draws interleaved with the concurrent load never
// panic and stay bounded, and after the load Lato resolves differently than
// the fallback it measured as before.
test.serial('concurrent loadFontsFromDir invalidates typeface dedup keys', async (t) => {
  const { status, signal, stdout, stderr } = await runInChildProcess(
    `
const { Worker } = require('node:worker_threads')
const { createCanvas, GlobalFonts } = require('./index.js')
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)
const tick = () => new Promise((r) => setImmediate(r))
;(async () => {
  const ctx = createCanvas(256, 64).getContext('2d')
  ctx.font = '30px Lato'
  const beforeWidth = ctx.measureText('Hello World').width
  global.gc()
  const before = process.memoryUsage().rss
  const loader = new Worker(
    \`
      const { GlobalFonts } = require('./index.js')
      const n = GlobalFonts.loadFontsFromDir('__test__/fonts')
      require('node:worker_threads').parentPort.postMessage(n)
    \`,
    { eval: true },
  )
  const loaded = new Promise((res, rej) => {
    loader.on('message', res)
    loader.on('error', rej)
    loader.on('exit', (code) => code !== 0 && rej(new Error('worker exit ' + code)))
  })
  // Draws interleave with the worker's per-file registrations: each resolves
  // the Lato descriptor against whatever the collection holds at that moment
  // and must charge under the CURRENT generation, never a stale one.
  for (let i = 0; i < 400; i++) {
    ctx.fillText('Hello World', 4, 40)
    ctx.measureText('Hello World')
    if (i % 50 === 49) await tick()
  }
  const count = await loaded
  await loader.terminate()
  const afterWidth = ctx.measureText('Hello World').width
  global.gc()
  await tick()
  await tick()
  global.gc()
  const growth = process.memoryUsage().rss - before
  console.log(
    \`worker loaded \${count} fonts; 400 draws during load, rss +\${mb(growth)} MB; Lato width \${beforeWidth} -> \${afterWidth}\`,
  )
  if (count <= 0) {
    console.error('worker loaded no fonts')
    process.exit(1)
  }
  if (afterWidth === beforeWidth) {
    console.error('Lato did not resolve after the directory load')
    process.exit(1)
  }
  if (growth > 96 * 1024 * 1024) {
    console.error(\`text recording stayed unbounded during load: +\${mb(growth)} MB\`)
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
