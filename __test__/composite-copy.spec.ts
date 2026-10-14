// clearRect and 'copy' routing. Every expected value was measured in Chrome 155
// CPU canvas (--disable-gpu, getContext('2d', { willReadFrequently: true })) on
// arm64; Chrome x64 gives the same bytes.
import test from 'ava'

import { createCanvas } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const px = (ctx: Ctx, x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data]

const BG = [200, 100, 50, 255]

function background(width: number, height: number) {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'rgb(200,100,50)'
  ctx.fillRect(0, 0, width, height)
  return { canvas, ctx }
}

// The modes Blink composites through a layer (IsFullCanvasCompositeMode), plus copy.
const UNBOUNDED_OPS = ['copy', 'source-in', 'source-out', 'destination-in', 'destination-atop'] as const

// Blink clearRect draws the rect straight with GetClearFlags and never reads
// globalCompositeOperation (canvas_2d_recorder_context.cc:1928-1985).
test('clearRect ignores globalCompositeOperation', (t) => {
  for (const op of UNBOUNDED_OPS) {
    for (const clip of [false, true]) {
      const { ctx } = background(40, 40)
      if (clip) {
        ctx.beginPath()
        ctx.rect(4, 4, 30, 30)
        ctx.clip()
      }
      ctx.globalCompositeOperation = op
      ctx.clearRect(10, 10, 4, 4)
      const label = `${op}${clip ? ' clip' : ''}`
      t.deepEqual(px(ctx, 12, 12), [0, 0, 0, 0], label)
      t.deepEqual(px(ctx, 30, 30), BG, label)
      t.deepEqual(px(ctx, 1, 1), BG, label)
    }
  }
})

test('clearRect ignores globalAlpha, shadow and filter', (t) => {
  for (const [name, set] of [
    ['destination-out', (c: Ctx) => (c.globalCompositeOperation = 'destination-out')],
    ['globalAlpha', (c: Ctx) => (c.globalAlpha = 0.5)],
    [
      'shadow',
      (c: Ctx) => {
        c.shadowColor = 'lime'
        c.shadowOffsetX = 2
      },
    ],
    ['filter', (c: Ctx) => (c.filter = 'blur(1px)')],
  ] as const) {
    const ctx = createCanvas(6, 6).getContext('2d')
    ctx.fillStyle = 'red'
    ctx.fillRect(0, 0, 6, 6)
    set(ctx)
    ctx.clearRect(0, 0, 2, 2)
    t.deepEqual(px(ctx, 0, 0), [0, 0, 0, 0], name)
    t.deepEqual(px(ctx, 4, 4), [255, 0, 0, 255], name)
    t.deepEqual(px(ctx, 2, 0), [255, 0, 0, 255], name)
  }
})

// 48x48: an opaque top half and a half-transparent bottom-left quarter, then a
// dithered gradient drawn with 'copy' inside a clip.
function copyScene(clip: [number, number, number, number], fill: (ctx: Ctx) => void) {
  const ctx = createCanvas(48, 48).getContext('2d')
  ctx.fillStyle = 'rgb(200,100,50)'
  ctx.fillRect(0, 0, 48, 24)
  ctx.fillStyle = 'rgba(40,160,220,0.5)'
  ctx.fillRect(0, 24, 24, 24)
  ctx.beginPath()
  ctx.rect(...clip)
  ctx.clip()
  ctx.globalCompositeOperation = 'copy'
  fill(ctx)
  return ctx
}

function gradientFill(ctx: Ctx) {
  const g = ctx.createLinearGradient(6, 6, 42, 42)
  g.addColorStop(0, 'rgba(255,0,0,1)')
  g.addColorStop(1, 'rgba(0,0,255,0.6)')
  ctx.fillStyle = g
  ctx.fillRect(4, 4, 40, 40)
}

// Blink DrawInternal (canvas_2d_recorder_context.h:830-837): copy clears the
// clip, then draws the foreground straight onto the canvas with kSrc. The
// gradient's 8x8 dither pattern stays in device phase; a layer opened at the
// clip origin would shift it.
test('copy draws in the device dither phase inside an unaligned clip', (t) => {
  const ctx = copyScene([5, 3, 36, 36], gradientFill)
  t.deepEqual(px(ctx, 12, 4), [236, 0, 17, 248])
  t.deepEqual(px(ctx, 8, 10), [230, 0, 24, 245])
  t.deepEqual(px(ctx, 20, 20), [151, 0, 102, 214])
  t.deepEqual(px(ctx, 2, 2), BG, 'outside the clip')
})

// The clear and the kSrc draw each apply the anti-aliased clip coverage, so an
// edge pixel ends as src * c + dst * (1 - c)^2, as in Chrome.
test('copy applies an anti-aliased clip edge twice, like Chrome', (t) => {
  const ctx = copyScene([5.5, 3.25, 36, 36], gradientFill)
  t.deepEqual(px(ctx, 5, 20), [204, 35, 51, 181])
  t.deepEqual(px(ctx, 41, 20), [128, 41, 126, 156])
  t.deepEqual(px(ctx, 20, 3), [199, 100, 52, 64])
  // A shape away from the clip edge: the edge only sees the clear.
  const solid = copyScene([5.5, 3.25, 36, 36], (c) => {
    c.fillStyle = 'rgba(0,128,255,0.8)'
    c.fillRect(10, 10, 28, 28)
  })
  t.deepEqual(px(solid, 5, 20), [201, 100, 50, 127])
  t.deepEqual(px(solid, 20, 3), [199, 100, 52, 64])
  t.deepEqual(px(solid, 7, 20), [0, 0, 0, 0])
  t.deepEqual(px(solid, 20, 20), [0, 128, 255, 204])
})

// copy draws the foreground only (kDrawForegroundOnly): no shadow.
test('copy draws no shadow', (t) => {
  const { ctx } = background(40, 40)
  ctx.shadowColor = 'lime'
  ctx.shadowOffsetX = 12
  ctx.globalCompositeOperation = 'copy'
  ctx.fillStyle = 'rgba(0,128,255,0.8)'
  ctx.fillRect(10, 10, 10, 10)
  t.deepEqual(px(ctx, 12, 12), [0, 128, 255, 204])
  t.deepEqual(px(ctx, 25, 12), [0, 0, 0, 0])
  t.deepEqual(px(ctx, 1, 1), [0, 0, 0, 0])
})

// Blink Draw returns before anything is drawn when the CTM is singular
// (canvas_2d_recorder_context.h:866-868), so copy does not clear either.
test('a draw under a singular transform changes nothing, in any mode', (t) => {
  for (const op of [...UNBOUNDED_OPS, 'source-over', 'xor'] as const) {
    for (const singular of [(c: Ctx) => c.setTransform(0, 0, 0, 0, 0, 0), (c: Ctx) => c.scale(0, 1)]) {
      const { ctx } = background(40, 40)
      ctx.globalCompositeOperation = op
      ctx.fillStyle = 'rgba(0,128,255,0.8)'
      singular(ctx)
      ctx.fillRect(1, 1, 5, 5)
      ctx.beginPath()
      ctx.rect(1, 1, 30, 30)
      ctx.fill()
      ctx.stroke()
      ctx.clearRect(0, 0, 40, 40)
      t.deepEqual(px(ctx, 3, 3), BG, op)
      t.deepEqual(px(ctx, 30, 30), BG, op)
    }
  }
})

// Blink clips the source rect to the image and returns when nothing is left
// (canvas_2d_recorder_context.cc:2310-2316), so no mode clears anything.
test('drawImage whose source rect misses the image changes nothing', (t) => {
  const src = createCanvas(8, 8)
  const sctx = src.getContext('2d')
  sctx.fillStyle = 'lime'
  sctx.fillRect(0, 0, 8, 8)
  for (const op of [...UNBOUNDED_OPS, 'source-over'] as const) {
    for (const [sx, sy] of [
      [100, 100],
      [-10, -10],
      [8, 0],
      [0, -5],
    ]) {
      const { ctx } = background(40, 40)
      ctx.globalCompositeOperation = op
      ctx.drawImage(src, sx, sy, 5, 5, 10, 10, 5, 5)
      t.deepEqual(px(ctx, 12, 12), BG, `${op} ${sx},${sy}`)
      t.deepEqual(px(ctx, 30, 30), BG, `${op} ${sx},${sy}`)
    }
  }
  // A source rect that overlaps the image still draws the overlap.
  for (const op of ['copy', 'source-in'] as const) {
    const { ctx } = background(40, 40)
    ctx.globalCompositeOperation = op
    ctx.drawImage(src, -4, -4, 8, 8, 10, 10, 8, 8)
    t.deepEqual(px(ctx, 12, 12), [0, 0, 0, 0], op)
    t.deepEqual(px(ctx, 15, 15), [0, 255, 0, 255], op)
    t.deepEqual(px(ctx, 30, 30), [0, 0, 0, 0], op)
  }
})

// drawCanvas has no Chrome counterpart; it must agree with drawImage, which
// returns when the source rect misses the source.
test('drawCanvas whose source rect misses the source canvas changes nothing', (t) => {
  const src = createCanvas(8, 8)
  const sctx = src.getContext('2d')
  sctx.fillStyle = 'lime'
  sctx.fillRect(0, 0, 8, 8)
  for (const op of [...UNBOUNDED_OPS, 'source-over'] as const) {
    for (const [sx, sy] of [
      [100, 100],
      [-10, -10],
      [8, 0],
      [0, -5],
    ]) {
      const { ctx } = background(40, 40)
      ctx.globalCompositeOperation = op
      ctx.drawCanvas(src, sx, sy, 5, 5, 10, 10, 5, 5)
      t.deepEqual(px(ctx, 12, 12), BG, `${op} ${sx},${sy}`)
      t.deepEqual(px(ctx, 30, 30), BG, `${op} ${sx},${sy}`)
    }
  }
  // A source rect that overlaps the canvas still draws the overlap.
  for (const op of ['copy', 'source-in'] as const) {
    const { ctx } = background(40, 40)
    ctx.globalCompositeOperation = op
    ctx.drawCanvas(src, -4, -4, 8, 8, 10, 10, 8, 8)
    t.deepEqual(px(ctx, 12, 12), [0, 0, 0, 0], op)
    t.deepEqual(px(ctx, 15, 15), [0, 255, 0, 255], op)
    t.deepEqual(px(ctx, 30, 30), [0, 0, 0, 0], op)
  }
})
