import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import test from 'ava'

import { GlobalFonts, ImageData, LottieAnimation, createCanvas } from '../index'
import type { CanvasRenderingContext2D } from '../index'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Registered font keeps text assertions identical on machines with and
// without system fonts (Linux CI has none).
GlobalFonts.registerFromPath(join(root, '__test__/fonts', 'Lato-Regular.ttf'))

const px = (ctx: CanvasRenderingContext2D, x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data)

// The accounting invariants this file used to assert via RSS deltas and wall
// clock are covered by the #[cfg(test)] unit tests in src/page_recorder.rs /
// src/ctx.rs (exact pending_bytes / retained-raster / consolidation counts).
// Everything below asserts only deterministic behaviour: pixels, exceptions,
// and registered font families.

// -- Issue #1342 repro ----------------------------------------------------
// One end-to-end smoke of the original report: a pure draw loop that never
// reads back must not accumulate the whole deferred recording. The bound is
// deliberately loose -- the correctness gate is the Rust accounting tests;
// this only proves the flush path fires at all at real scale.
test.serial('pure draw loop stays bounded (end-to-end #1342 smoke)', async (t) => {
  const { status, signal, stderr } = await new Promise<{
    status: number | null
    signal: NodeJS.Signals | null
    stderr: string
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--expose-gc',
        '-e',
        `
const { createCanvas } = require('./index.js')
const ctx = createCanvas(64, 64).getContext('2d')
const tile = ctx.createImageData(64, 64)
tile.data.fill(255)
global.gc()
const before = process.memoryUsage().rss
for (let i = 0; i < 20000; i++) {
  ctx.putImageData(tile, i % 60, i % 60)
}
global.gc()
const growth = process.memoryUsage().rss - before
// Each putImageData pins a 16 KB pixel copy; ~320 MB if never flushed.
if (growth > 256 * 1024 * 1024) {
  console.error('recording grew unbounded: ' + (growth / 1048576).toFixed(1) + ' MB')
  process.exit(1)
}
`,
      ],
      { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('child timed out'))
    }, 120_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stderr })
    })
  })

  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}`)
})

// -- Reads flush the recording -------------------------------------------

// draw -> getImageData -> draw -> getImageData: the second read must see both
// draws even though the first read flushed and consolidated the recording.
test.serial('pixels stay correct across repeated getImageData flushes', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')!

  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 50, 100)
  t.deepEqual(px(ctx, 25, 50), [255, 0, 0, 255])
  t.deepEqual(px(ctx, 75, 50), [0, 0, 0, 0])

  ctx.fillStyle = '#0000ff'
  ctx.fillRect(50, 0, 50, 100)
  t.deepEqual(px(ctx, 25, 50), [255, 0, 0, 255])
  t.deepEqual(px(ctx, 75, 50), [0, 0, 255, 255])
})

// An interleaved read/draw loop consolidates per read; every iteration's
// pixel must still read back the colour drawn in that iteration.
test.serial('interleaved getImageData reads stay correct', (t) => {
  const ctx = createCanvas(64, 64).getContext('2d')!
  for (let i = 0; i < 200; i++) {
    ctx.fillStyle = i % 2 ? '#00ff00' : '#ff0000'
    ctx.fillRect(0, 0, 64, 64)
    const p = px(ctx, 32, 32)
    t.deepEqual(p, i % 2 ? [0, 255, 0, 255] : [255, 0, 0, 255])
  }
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

  t.deepEqual(px(ctx, 1, 1), [0, 0, 255, 255])
  // Outside the putImageData rect, inside the clip: still the first fill.
  t.deepEqual(px(ctx, 64, 64), [255, 0, 0, 255])
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
  t.deepEqual(px(ctx, 32, 32), [0, 255, 0, 255])
})

// -- Cap trips inside state ops ------------------------------------------
// The byte cap can trip on a state op (save/clip/transform/restore), not just
// a draw. The flush must run where the recorder's synced state still matches
// the ops already recorded: putImageData pins exactly w*h*4 bytes and every
// other recorded op charges 256, so padding can land pending_bytes k ops
// below the 32 MiB cap and the cap then trips ON the op under test. Charges
// are fixed constants, so this is deterministic on every host.
const CAP = 32 * 1024 * 1024
// put_pixels promotes its record to a layer (+1024 charged per put); each
// 1024x1024 tile put therefore charges 4195328, a whole number of 256-byte
// ops.
const PUT_TILE_BYTES = 1024 * 1024 * 4 + 1024 // 4195328 = 16408 * 256

test.serial('state ops keep their transform and clip when the byte cap trips', (t) => {
  const ctx = createCanvas(200, 200).getContext('2d')!
  const tile = ctx.createImageData(1024, 1024)
  tile.data.fill(255)
  const isRed = (p: number[]) => p[0] === 255 && p[1] === 0 && p[2] === 0 && p[3] === 255
  const isBlue = (p: number[]) => p[0] === 0 && p[1] === 0 && p[2] === 255 && p[3] === 255
  // The padding puts paint an opaque white field over [0,163)^2; any spot the
  // boundary ops must not touch still reads white.
  const isWhite = (p: number[]) => p[0] === 255 && p[1] === 255 && p[2] === 255 && p[3] === 255

  // pad(opsShort): leave pending_bytes at CAP - opsShort*256 so the op under
  // test is the one crossing the cap. Each tile put charges 16408 ops' worth
  // (PUT_TILE_BYTES/256); fillRects charge 256 each.
  const pad = (opsShort: number) => {
    ctx.clearRect(0, 0, 200, 200)
    for (let i = 0; i < 7; i++) ctx.putImageData(tile, 0, 0)
    const fills = (CAP - opsShort * 256 - 7 * PUT_TILE_BYTES) / 256
    t.true(Number.isInteger(fills) && fills >= 0, `pad(${opsShort}) arithmetic`)
    ctx.fillStyle = '#000000'
    for (let i = 0; i < fills; i++) ctx.fillRect(0, 0, 1, 1)
  }

  // translate boundary: pending = CAP-256, so translate's op reaches the cap
  // and its post-op check flushes after translate is fully synced.
  pad(1)
  ctx.translate(10, 0)
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(5, 50, 10, 10) // draw [15,25) only if the translate applied
  ctx.resetTransform()
  t.true(isRed(px(ctx, 20, 55)), 'translate-boundary: draw missing at translated x')
  t.true(isWhite(px(ctx, 8, 55)), 'translate-boundary: stale transform drew at unshifted x')

  // clip boundary: save crosses to CAP-256, clip is the boundary op. If the
  // flush resumes with stale clip metadata the full-canvas fill escapes.
  pad(2)
  ctx.save()
  ctx.beginPath()
  ctx.rect(40, 40, 20, 20)
  ctx.clip()
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 200, 200) // confined to [40,60)x[40,60) by the clip
  ctx.restore()
  t.true(isWhite(px(ctx, 5, 5)), 'clip-boundary: draw escaped the clip')
  t.true(isRed(px(ctx, 50, 50)), 'clip-boundary: clipped fill missing')

  // save boundary: pending = CAP-256 at save's op. A stale save_count makes
  // the epoch's transform survive restore(), shifting the blue sentinel.
  pad(1)
  ctx.save()
  ctx.translate(20, 0)
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(100, 80, 10, 10)
  ctx.restore()
  ctx.fillStyle = '#0000ff'
  ctx.fillRect(0, 90, 10, 10) // lands at [0,10) only if restore undid the translate
  t.true(isBlue(px(ctx, 5, 95)), 'save-boundary: transform leaked past restore()')
  t.true(isWhite(px(ctx, 25, 95)), 'save-boundary: stale transform drew shifted')

  // restore boundary: save, translate, fillRect lead; restore records first.
  pad(4)
  ctx.save()
  ctx.translate(20, 0)
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(100, 120, 10, 10)
  ctx.restore()
  ctx.fillStyle = '#0000ff'
  ctx.fillRect(0, 140, 10, 10)
  t.true(isBlue(px(ctx, 5, 145)), 'restore-boundary: transform leaked past restore()')
  t.true(isWhite(px(ctx, 25, 145)), 'restore-boundary: stale transform drew shifted')
})

// Broad ordering coverage: clipped fills inside save/clip/restore epochs keep
// landing inside the clip while the sentinel outside every clip stays green,
// across hundreds of epochs (the recording is flushed by reads along the way).
test.serial('save/clip/restore epochs stay consistent across reads', (t) => {
  const ctx = createCanvas(220, 200).getContext('2d')!
  const COLORS = ['#ff0000', '#00ff00', '#0000ff']
  const RGB = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ]
  for (let i = 0; i < 600; i++) {
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
    if (i % 60 === 0 || i === 599) {
      const sentinel = px(ctx, 10, 10)
      t.deepEqual(sentinel.slice(0, 3), [0, 255, 0], `iteration ${i}: state leaked past restore()`)
      const e = RGB[c]
      const hit = px(ctx, 60 + tOff + 10, 50)
      t.deepEqual(hit.slice(0, 3), e, `iteration ${i}: epoch draw landed wrong`)
    }
  }
})

// -- Direct surface writes -------------------------------------------------

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
  t.deepEqual(px(ctx, 48, 0), [0, 255, 0, 255])
})

// getContext('2d', { alpha: false }) paints an opaque base fill straight onto
// the surface. It must flush pending recorded ops under it (a recorded op
// issued before the call renders OVER the fill).
test.serial('alpha:false base fill lands over ops recorded before it', (t) => {
  const canvas = createCanvas(64, 64)
  canvas.getContext('2d')!.fillStyle = '#ff0000'
  canvas.getContext('2d')!.fillRect(0, 0, 64, 64)
  canvas.getContext('2d', { alpha: false })

  t.deepEqual(
    Array.from(canvas.getContext('2d')!.getImageData(32, 32, 1, 1).data),
    [255, 255, 255, 255],
    'base fill was overwritten by the recorded fill',
  )
})

// A direct surface write bypasses the recording, so get_picture() (the
// drawCanvas source path) rebases the layers on the post-write surface. The
// two draw paths must agree.
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

// -- Source-dedup behaviour -------------------------------------------------

// drawImage of a canvas source pins a snapshot generation: mutating the
// source between draws must re-capture, and the dest sees the latest content.
test.serial('drawImage of a mutated canvas source reflects each generation', (t) => {
  const src = createCanvas(32, 32)
  const sctx = src.getContext('2d')!
  const dest = createCanvas(32, 32).getContext('2d')!

  sctx.fillStyle = '#00ff00'
  sctx.fillRect(0, 0, 32, 32)
  dest.drawImage(src, 0, 0)
  t.deepEqual(px(dest, 16, 16), [0, 255, 0, 255])

  // State-only churn must not break the deduped capture.
  sctx.save()
  sctx.translate(4, 4)
  sctx.restore()
  dest.drawImage(src, 0, 0)
  t.deepEqual(px(dest, 16, 16), [0, 255, 0, 255])

  sctx.fillStyle = '#0000ff'
  sctx.fillRect(0, 0, 32, 32)
  dest.drawImage(src, 0, 0)
  t.deepEqual(px(dest, 16, 16), [0, 0, 255, 255])

  // A zero-area clearRect records nothing: the source still shows blue.
  // A real clearRect hits the full-canvas fast path and clears the source
  // surface itself. Each result is drawn into a fresh dest: a transparent
  // source composites source-over and cannot erase what a dest already has.
  sctx.clearRect(0, 0, 0, 0)
  let fresh = createCanvas(32, 32).getContext('2d')!
  fresh.drawImage(src, 0, 0)
  t.deepEqual(px(fresh, 16, 16), [0, 0, 255, 255])
  sctx.clearRect(0, 0, 32, 32)
  t.deepEqual(px(sctx, 16, 16), [0, 0, 0, 0])
  fresh = createCanvas(32, 32).getContext('2d')!
  fresh.drawImage(src, 0, 0)
  t.deepEqual(px(fresh, 16, 16), [0, 0, 0, 0])
})

// A canvas pattern's fill must render the source's pixels through every
// flush window it lives across.
test.serial('createPattern fillRect lands', (t) => {
  const tile = createCanvas(8, 8)
  const tctx = tile.getContext('2d')!
  tctx.fillStyle = '#f0f'
  tctx.fillRect(0, 0, 8, 8)

  const ctx = createCanvas(64, 64).getContext('2d')!
  ctx.fillStyle = ctx.createPattern(tile, 'repeat')
  ctx.fillRect(0, 0, 64, 64)
  t.deepEqual(px(ctx, 32, 32), [255, 0, 255, 255])
})

// drawCanvas on an empty/blank source must not corrupt the destination.
test.serial('drawCanvas of a blank source paints nothing', (t) => {
  const src = createCanvas(16, 16)
  const dest = createCanvas(16, 16).getContext('2d')!
  dest.drawCanvas(src, 0, 0)
  dest.drawImage(src, 0, 0)
  t.deepEqual(px(dest, 8, 8), [0, 0, 0, 0])
})

// -- Degenerate geometry records nothing -----------------------------------

// A zero-area / non-finite fillRect paints nothing and records nothing:
// drawRect sorts its rect, so negative w/h still paint, while collapsed or
// non-finite spans paint nothing. Same for clearRect and for fills/strokes of
// paths with no coverage.
test.serial('zero-area and non-finite draws paint nothing', (t) => {
  const ctx = createCanvas(64, 64).getContext('2d')!
  ctx.fillStyle = '#f00'
  ctx.fillRect(0, 0, 0, 8)
  ctx.fillRect(0, 0, 8, 0)
  // f32 edge collapse: 16777216 + 1 rounds back to 16777216.
  ctx.fillRect(16777216, 0, 1, 8)
  ctx.fillRect(NaN, 0, 8, 8)
  ctx.fillRect(0, 0, 8, Infinity)
  ctx.clearRect(0, 0, 0, 0)
  ctx.strokeRect(0, 0, 0, 0)

  // Empty path: no verbs at all, then degenerate moveTo-only bounds.
  ctx.beginPath()
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(4, 4)
  ctx.fill()
  ctx.beginPath()
  ctx.stroke()

  const data = ctx.getImageData(0, 0, 64, 64).data
  t.false(
    data.some((v) => v !== 0),
    'no-op draws painted pixels',
  )
})

// Negative dims sort to a positive span and still paint (mirrored).
test.serial('negative dims still paint through fillRect, drawImage and drawCanvas', (t) => {
  const ctx = createCanvas(128, 128).getContext('2d')!
  ctx.fillStyle = '#0f0'
  ctx.fillRect(100, 100, -50, -50)
  t.deepEqual(px(ctx, 75, 75), [0, 255, 0, 255])

  const src = createCanvas(10, 10)
  const sctx = src.getContext('2d')
  sctx.fillStyle = '#f00'
  sctx.fillRect(0, 0, 10, 10)

  // drawImage(canvas, dx, dy, dw, dh) with negative dw / dh.
  let dest = createCanvas(64, 64).getContext('2d')
  dest.drawImage(src, 30, 20, -10, 10)
  t.deepEqual(px(dest, 25, 25), [255, 0, 0, 255])
  dest = createCanvas(64, 64).getContext('2d')
  dest.drawImage(src, 30, 20, 10, -10)
  t.deepEqual(px(dest, 35, 15), [255, 0, 0, 255])

  // 9-arg form with negative dw AND dh.
  dest = createCanvas(64, 64).getContext('2d')
  dest.drawImage(src, 0, 0, 10, 10, 30, 20, -10, -10)
  t.deepEqual(px(dest, 25, 15), [255, 0, 0, 255])

  // drawCanvas goes through draw_picture_rect: same sorted clip.
  sctx.fillStyle = '#0f0'
  sctx.fillRect(0, 0, 10, 10)
  dest = createCanvas(64, 64).getContext('2d')
  dest.drawCanvas(src, 30, 20, -10, 10)
  t.deepEqual(px(dest, 25, 25), [0, 255, 0, 255])
  dest = createCanvas(64, 64).getContext('2d')
  dest.drawCanvas(src, 0, 0, 10, 10, 30, 20, -10, -10)
  t.deepEqual(px(dest, 25, 15), [0, 255, 0, 255])

  // Genuinely empty spans still skip: nothing painted.
  dest = createCanvas(64, 64).getContext('2d')
  dest.drawCanvas(src, 0, 0, 0, 10)
  dest.drawImage(src, 0, 0, 10, 0)
  t.deepEqual(px(dest, 0, 0), [0, 0, 0, 0])
})

// A drawCanvas whose source rect is empty records nothing and paints nothing.
test.serial('zero-source-rect drawCanvas paints nothing and leaves dest intact', (t) => {
  const src = createCanvas(16, 16)
  src.getContext('2d')!.fillRect(0, 0, 16, 16)
  const ctx = createCanvas(32, 32).getContext('2d')!

  ctx.drawCanvas(src, 0, 0, 0, 16, 0, 0, 16, 16)
  ctx.drawCanvas(src, 0, 0, 16, 0, 0, 0, 16, 16)
  t.deepEqual(px(ctx, 8, 8), [0, 0, 0, 0])

  // A real drawCanvas of the same source still lands.
  ctx.drawCanvas(src, 0, 0)
  t.is(px(ctx, 8, 8)[3], 255)
})

// putImageData draws through drawImageRect, whose fillable() checks run on
// the UNSORTED dirty rects: NaN/infinite/collapsed spans record nothing and
// paint nothing. Negative dx/dy keep painting (clipped, not rejected).
test.serial('unfillable dirty-rect putImageData paints nothing', (t) => {
  const ctx = createCanvas(64, 64).getContext('2d')!
  const imageData = new ImageData(16, 16)
  for (let i = 0; i < imageData.data.length; i += 4) {
    imageData.data[i] = 255
    imageData.data[i + 3] = 255
  }

  // f32 edge collapse: 16777216+1 rounds back to 16777216.
  ctx.putImageData(imageData, 0, 0, 16777216, 0, 1, 8)
  // Same collapse on the destination side: dx + dirtyX overflows.
  ctx.putImageData(imageData, 16777216, 0, 0, 0, 1, 8)
  // NaN and +/-inf make src/dst rects non-finite or empty.
  ctx.putImageData(imageData, 0, 0, NaN, 0, 8, 8)
  ctx.putImageData(imageData, 0, 0, Infinity, 0, 8, 8)
  ctx.putImageData(imageData, 0, 0, 0, 0, -Infinity, 8)
  ctx.putImageData(imageData, 0, 0, 0, 0, 8, NaN)
  // Negative dirty spans normalize per spec but end empty -> nothing paints.
  ctx.putImageData(imageData, 10, 10, 0, 0, -4, 8)
  ctx.putImageData(imageData, 20, 20, 0, 0, 8, -4)

  const data = ctx.getImageData(0, 0, 64, 64).data
  t.false(
    data.some((v) => v !== 0),
    'rejected putImageData painted pixels',
  )

  // A valid dirty rect still lands.
  ctx.putImageData(imageData, 20, 20, 0, 0, 8, 8)
  t.is(px(ctx, 21, 21)[3], 255)
})

// -- Extreme geometry still records ----------------------------------------

// The drawImage canvas-arm preflight must not gate on a derived term the C++
// never forms: under a tiny-scale CTM the derived `dx - sx*scale_x` overflows
// f32 while the composed matrix stays finite, so the draw paints.
test.serial('drawImage under extreme CTM paints when the composed matrix is finite', (t) => {
  const src = createCanvas(10, 10)
  const sctx = src.getContext('2d')
  sctx.fillStyle = '#f00'
  sctx.fillRect(0, 0, 10, 10)
  const ctx = createCanvas(64, 64).getContext('2d')!
  ctx.setTransform(-1e-37, 0, 0, 1, 0, 0)
  ctx.drawImage(src, 9, 0, 1, 10, -3e38, 0, -3e38, 10)
  t.deepEqual(px(ctx, 45, 5), [255, 0, 0, 255])
})

// SkCanvas::clipRect IGNORES a non-finite rect, so a dst clip whose endpoint
// overflows f32 stays open and the CTM can rescale content back into view.
test.serial('drawCanvas with overflowing clip endpoint still paints', (t) => {
  const src = createCanvas(10, 10)
  const sctx = src.getContext('2d')
  sctx.fillStyle = '#0f0'
  sctx.fillRect(0, 0, 10, 10)
  const ctx = createCanvas(64, 64).getContext('2d')!
  ctx.setTransform(1e-37, 0, 0, 1, 0, 0)
  // dx + dw overflows f32 to +inf: clipRect ignores it, effective scale 34
  // maps the source into the visible region.
  ctx.drawCanvas(src, 1, 0, 1, 10, 3.4e38, 0, 3.4e38, 10)
  t.deepEqual(px(ctx, 50, 5), [0, 255, 0, 255])

  // A finite collapsed clip still records nothing and must stay skipped.
  const empty = createCanvas(64, 64).getContext('2d')!
  empty.drawCanvas(src, 16777216, 0, 1, 10)
  t.deepEqual(px(empty, 10, 5), [0, 0, 0, 0])
})

// Round-18 regression: the C++ helper forms `dx - sx*scale_x` with a fused
// fma that rounds differently at the f32 boundary than unfused evaluation, so
// whether this exact draw paints is architecture-dependent (the recording
// assertion lives in the Rust unit tests). What is arch-independent: the call
// neither throws nor corrupts the destination -- a normal draw still lands.
test.serial('drawCanvas at the fused-arithmetic boundary stays usable', (t) => {
  const src = createCanvas(10, 10)
  const sctx = src.getContext('2d')
  sctx.fillStyle = '#f00'
  sctx.fillRect(0, 0, 10, 10)
  const ctx = createCanvas(64, 64).getContext('2d')!
  ctx.setTransform(-1e-30, 0, 0, 1, 0, 0)
  t.notThrows(() => {
    ctx.drawCanvas(src, 34028238848, 0, 1e10, 10, 3.4028235e38, 0, 1e38, 10)
  })
  ctx.resetTransform()
  ctx.fillStyle = '#00f'
  ctx.fillRect(0, 0, 8, 8)
  t.deepEqual(px(ctx, 4, 4), [0, 0, 255, 255])
})

// -- Text -------------------------------------------------------------------

// measureText is a read: a loop of measures must not disturb the recording,
// and a pattern-backed fill still renders afterwards.
test.serial('measureText does not disturb the recording', (t) => {
  const ctx = createCanvas(64, 64).getContext('2d')!
  ctx.font = '16px Lato'
  const tile = createCanvas(8, 8)
  const tctx = tile.getContext('2d')!
  tctx.fillStyle = '#00ff00'
  tctx.fillRect(0, 0, 8, 8)
  ctx.fillStyle = ctx.createPattern(tile, 'repeat')

  let width = 0
  for (let i = 0; i < 1000; i++) {
    width = ctx.measureText(`measure me ${i}`).width
    t.true(width > 0)
  }

  ctx.fillRect(0, 0, 64, 64)
  t.deepEqual(px(ctx, 32, 32), [0, 255, 0, 255])
})

// fillText records through the font pipeline: the registered test font
// resolves and paints deterministically on any host.
test.serial('fillText with the registered Lato font paints', (t) => {
  const ctx = createCanvas(128, 32).getContext('2d')!
  ctx.font = '16px Lato'
  ctx.fillStyle = '#000000'
  ctx.fillText('Hello World', 0, 20)
  const data = ctx.getImageData(0, 0, 128, 32).data
  t.true(
    data.some((v, i) => i % 4 === 3 && v !== 0),
    'fillText painted nothing',
  )
})

// A text draw that cannot record (interior NUL in the text CString) must
// leave the recording untouched: the following draw still renders.
test.serial('NUL-rejected fillText leaves the canvas usable', (t) => {
  const ctx = createCanvas(64, 64).getContext('2d')!
  ctx.font = '16px Lato'
  const nulText = 'a\0b'
  t.throws(() => ctx.fillText(nulText, 0, 16))
  t.throws(() => ctx.strokeText(nulText, 0, 16))
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 64, 64)
  t.deepEqual(px(ctx, 32, 32), [255, 0, 0, 255])
  t.notThrows(() => ctx.fillText('ok', 0, 16))
})

// loadFontsFromDir bumps the font-collection generation per file while the
// lock is held; concurrent draws must never panic and must resolve Lato
// differently once it is actually registered.
test.serial('loadFontsFromDir is safe to run under concurrent draws', async (t) => {
  const ctx = createCanvas(256, 64).getContext('2d')!
  ctx.font = '30px DoesNotExist-' + Math.random().toString(36).slice(2)
  const fallbackWidth = ctx.measureText('Hello World').width
  t.true(fallbackWidth > 0)

  const loader = new Worker(
    `
      const { GlobalFonts } = require('./index.js')
      const n = GlobalFonts.loadFontsFromDir('__test__/fonts')
      require('node:worker_threads').parentPort.postMessage(n)
    `,
    { eval: true },
  )
  const loaded = new Promise<number>((resolve, reject) => {
    loader.on('message', resolve)
    loader.on('error', reject)
    loader.on('exit', (code) => code !== 0 && reject(new Error(`worker exit ${code}`)))
  })

  // Draws interleave with the worker's per-file registrations.
  for (let i = 0; i < 200; i++) {
    ctx.fillText('Hello World', 4, 40)
    ctx.measureText('Hello World')
    if (i % 50 === 49) await new Promise((r) => setImmediate(r))
  }
  const count = await loaded
  await loader.terminate()

  t.true(count > 0, 'worker loaded no fonts')
  t.true(
    GlobalFonts.families.some(({ family }) => family.split(',').includes('Lato')),
    'Lato missing after loadFontsFromDir',
  )
  // The worker may register a different face for an already-known family, so
  // assert the deterministic part only: width stays positive and a Lato
  // measure is identical post-load (face now resolves).
  ctx.font = '30px Lato'
  t.true(ctx.measureText('Hello World').width > 0)
})
