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
