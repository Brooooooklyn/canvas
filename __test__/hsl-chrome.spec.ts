// hsl() color pixels pinned to Chrome 155 CPU canvas
// (getContext('2d', { willReadFrequently: true }), launched with --disable-gpu).
import test from 'ava'

import { createCanvas } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const HSL_EXPECTED: Record<string, number[]> = {
  'hsl(0, 0%, 50%)': [128, 128, 128, 255],
  'hsl(0, 50%, 20%)': [77, 26, 26, 255],
  'hsl(0, 80%, 50%)': [230, 25, 25, 255],
  'hsl(210,75%,50%)': [32, 128, 223, 255],
  'hsl(120, 50%, 50%)': [64, 191, 64, 255],
  // Chrome GPU gives 178 here; we follow the CPU canvas.
  'hsl(0, 0%, 70%)': [179, 179, 179, 255],
  'hsla(200,50%,50%,0.5)': [64, 149, 191, 128],
  'hsl(-30, 80%, 60%)': [235, 71, 153, 255],
  'hsl(0.5turn 60% 40%)': [41, 163, 163, 255],
}

const PAINTS: Record<string, (ctx: Ctx, color: string) => void> = {
  fillStyle: (ctx, color) => {
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
  },
  strokeStyle: (ctx, color) => {
    ctx.strokeStyle = color
    ctx.lineWidth = 4
    ctx.strokeRect(0, 0, 1, 1)
  },
  shadowColor: (ctx, color) => {
    ctx.shadowColor = color
    ctx.shadowOffsetX = 1000
    ctx.fillStyle = '#000'
    ctx.fillRect(-1000, 0, 1, 1)
  },
}

for (const [paint, draw] of Object.entries(PAINTS)) {
  test(`hsl() ${paint} rounds like Chrome`, (t) => {
    for (const [color, expected] of Object.entries(HSL_EXPECTED)) {
      const ctx = createCanvas(1, 1).getContext('2d')
      draw(ctx, color)
      t.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], expected, color)
    }
  })
}

test('drop-shadow() filter accepts hsl() colors', (t) => {
  const expected: Record<string, number[]> = {
    'drop-shadow(4px 0 0 hsl(120, 100%, 25%))': [0, 128, 0, 255],
    'drop-shadow(4px 0 0 hsla(0, 100%, 50%, 0.5))': [255, 0, 0, 128],
  }
  for (const [filter, shadow] of Object.entries(expected)) {
    const ctx = createCanvas(20, 4).getContext('2d')
    ctx.filter = filter
    t.is(ctx.filter, filter)
    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual([...ctx.getImageData(1, 1, 1, 1).data], [0, 0, 0, 255], filter)
    t.deepEqual([...ctx.getImageData(6, 1, 1, 1).data], shadow, filter)
  }
})

test('drop-shadow() color function names are case-insensitive', (t) => {
  // Chrome 155 keeps each filter and draws the shadow at (6, 1); a second shadow lands at (1, 6).
  const expected: Record<string, { right: number[]; below?: number[] }> = {
    'drop-shadow(4px 0 0 HSL(120, 100%, 25%))': { right: [0, 128, 0, 255] },
    'drop-shadow(4px 0 0 HsLa(0, 100%, 50%, 0.5))': { right: [255, 0, 0, 128] },
    'drop-shadow(4px 0 0 HSL(120 100% 25%))': { right: [0, 128, 0, 255] },
    'drop-shadow(4px 0 0 RGB(0, 128, 0))': { right: [0, 128, 0, 255] },
    'drop-shadow(4px 0 0 rGbA(255, 0, 0, 0.5))': { right: [255, 0, 0, 128] },
    'drop-shadow(4px 0 0 RGB(0 128 0 / 50%))': { right: [0, 128, 0, 128] },
    'drop-shadow(4px 0 0 HSL(120, 100%, 25%)) drop-shadow(0 4px 0 RGB(0, 0, 255))': {
      right: [0, 128, 0, 255],
      below: [0, 0, 255, 255],
    },
  }
  for (const [filter, { right, below = [0, 0, 0, 0] }] of Object.entries(expected)) {
    const ctx = createCanvas(20, 12).getContext('2d')
    ctx.filter = filter
    t.is(ctx.filter, filter)
    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual([...ctx.getImageData(1, 1, 1, 1).data], [0, 0, 0, 255], filter)
    t.deepEqual([...ctx.getImageData(6, 1, 1, 1).data], right, filter)
    t.deepEqual([...ctx.getImageData(1, 6, 1, 1).data], below, filter)
  }
})
