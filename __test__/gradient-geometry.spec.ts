// Pinned to Chrome 155 CPU canvas (getContext('2d', { willReadFrequently: true }), --disable-gpu),
// measured on arm64 and on x64 (Rosetta); both gave the same values.
import test from 'ava'

import { createCanvas } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>
type G = ReturnType<Ctx['createLinearGradient']>

// 'r,g,b,a r,g,b,a ...' rows -> flat RGBA bytes
const rgba = (rows: string[]) =>
  rows.flatMap((row) =>
    row
      .trim()
      .split(/\s+/)
      .flatMap((p) => p.split(',').map(Number)),
  )
const all = (ctx: Ctx, w: number, h: number) => [...ctx.getImageData(0, 0, w, h).data]
const px = (ctx: Ctx, x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data]
const redBlue = (g: G) => {
  g.addColorStop(0, 'rgb(255, 0, 0)')
  g.addColorStop(1, 'rgb(0, 0, 255)')
  return g
}

// Coordinates past f32 clamp to +-FLT_MAX/1e6 (linear points, radial centers and radii); a conic
// start angle whose degrees overflow f32 has no shader and paints the paint color, black.
// Top two rows at globalAlpha 1, bottom two at 0.5, over rgb(0, 200, 0).
const HUGE: Record<string, (c: Ctx) => G> = {
  'linear 0 to 1e39': (c) => c.createLinearGradient(0, 0, 1e39, 0),
  'linear -1e39 to 1e39': (c) => c.createLinearGradient(-1e39, 0, 1e39, 0),
  'linear 1e39 to 0': (c) => c.createLinearGradient(1e39, 0, 0, 0),
  'linear 0 to 1e33': (c) => c.createLinearGradient(0, 0, 1e33, 0),
  'radial x0=1e39': (c) => c.createRadialGradient(1e39, 2, 0, 2, 2, 3),
  'radial x1=1e39': (c) => c.createRadialGradient(2, 2, 0, 1e39, 2, 3),
  'radial r1=1e39': (c) => c.createRadialGradient(2, 2, 0, 2, 2, 1e39),
  'radial r0=1e39': (c) => c.createRadialGradient(2, 2, 1e39, 2, 2, 0),
  'radial x0=1e39 x1=-1e39': (c) => c.createRadialGradient(1e39, 0, 0, -1e39, 0, 10),
  'conic cx=1e39': (c) => c.createConicGradient(0, 1e39, 2),
  'conic startAngle=1e39': (c) => c.createConicGradient(1e39, 2, 2),
  'conic startAngle=-1e39': (c) => c.createConicGradient(-1e39, 2, 2),
  'conic startAngle=1e37': (c) => c.createConicGradient(1e37, 2, 2),
  // Distinct floats that both clamp to FLT_MAX / 1e6: not degenerate (Blink compares the points
  // before the clamp), so Skia gets equal points and paints the last stop.
  'linear 1e34 to 2e34': (c) => c.createLinearGradient(1e34, 0, 2e34, 0),
  // The degrees of the start angle overflow f32 just above FLT_MAX / 57.29578.
  'conic startAngle=6e36': (c) => c.createConicGradient(6e36, 2, 2),
  'conic startAngle=5.9e36': (c) => c.createConicGradient(5.9e36, 2, 2),
}
const HUGE_EXPECTED: Record<string, number[]> = {
  'linear 0 to 1e39': rgba([
    '255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255',
    '255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255',
    '127,100,0,255 128,100,0,255 127,100,0,255 128,100,0,255',
    '128,100,0,255 127,100,0,255 128,100,0,255 127,100,0,255',
  ]),
  'linear -1e39 to 1e39': rgba([
    '127,0,127,255 128,0,128,255 127,0,127,255 128,0,128,255',
    '128,0,128,255 127,0,127,255 128,0,128,255 127,0,127,255',
    '63,100,63,255 64,100,64,255 63,100,63,255 64,100,64,255',
    '64,100,64,255 64,100,64,255 64,100,64,255 64,100,64,255',
  ]),
  'linear 1e39 to 0': rgba([
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
    '0,100,127,255 0,100,128,255 0,100,127,255 0,100,128,255',
    '0,100,128,255 0,100,127,255 0,100,128,255 0,100,127,255',
  ]),
  'linear 0 to 1e33': rgba([
    '255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255',
    '255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255',
    '127,100,0,255 128,100,0,255 127,100,0,255 128,100,0,255',
    '128,100,0,255 127,100,0,255 128,100,0,255 127,100,0,255',
  ]),
  'radial x0=1e39': rgba([
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
    '0,100,127,255 0,100,128,255 0,100,127,255 0,100,128,255',
    '0,100,128,255 0,100,127,255 0,100,128,255 0,100,127,255',
  ]),
  'radial x1=1e39': rgba([
    '0,200,0,255 0,200,0,255 0,200,0,255 0,200,0,255',
    '0,200,0,255 0,200,0,255 0,200,0,255 0,200,0,255',
    '0,200,0,255 0,200,0,255 0,200,0,255 0,200,0,255',
    '0,200,0,255 0,200,0,255 0,200,0,255 0,200,0,255',
  ]),
  'radial r1=1e39': rgba([
    '255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255',
    '255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255',
    '127,100,0,255 128,100,0,255 127,100,0,255 128,100,0,255',
    '128,100,0,255 127,100,0,255 128,100,0,255 127,100,0,255',
  ]),
  'radial r0=1e39': rgba([
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
    '0,100,127,255 0,100,128,255 0,100,127,255 0,100,128,255',
    '0,100,128,255 0,100,127,255 0,100,128,255 0,100,127,255',
  ]),
  'radial x0=1e39 x1=-1e39': rgba([
    '127,0,127,255 128,0,128,255 127,0,127,255 128,0,128,255',
    '128,0,128,255 127,0,127,255 128,0,128,255 127,0,127,255',
    '63,100,63,255 64,100,64,255 63,100,63,255 64,100,64,255',
    '64,100,64,255 64,100,64,255 64,100,64,255 64,100,64,255',
  ]),
  'conic cx=1e39': rgba([
    '127,0,127,255 128,0,128,255 127,0,127,255 128,0,128,255',
    '128,0,128,255 127,0,127,255 128,0,128,255 127,0,127,255',
    '63,100,63,255 64,100,64,255 63,100,63,255 64,100,64,255',
    '64,100,64,255 64,100,64,255 64,100,64,255 64,100,64,255',
  ]),
  'conic startAngle=1e39': rgba([
    '0,0,0,255 0,0,0,255 0,0,0,255 0,0,0,255',
    '0,0,0,255 0,0,0,255 0,0,0,255 0,0,0,255',
    '0,100,0,255 0,100,0,255 0,100,0,255 0,100,0,255',
    '0,100,0,255 0,100,0,255 0,100,0,255 0,100,0,255',
  ]),
  'conic startAngle=-1e39': rgba([
    '0,0,0,255 0,0,0,255 0,0,0,255 0,0,0,255',
    '0,0,0,255 0,0,0,255 0,0,0,255 0,0,0,255',
    '0,100,0,255 0,100,0,255 0,100,0,255 0,100,0,255',
    '0,100,0,255 0,100,0,255 0,100,0,255 0,100,0,255',
  ]),
  'conic startAngle=1e37': rgba([
    '0,0,0,255 0,0,0,255 0,0,0,255 0,0,0,255',
    '0,0,0,255 0,0,0,255 0,0,0,255 0,0,0,255',
    '0,100,0,255 0,100,0,255 0,100,0,255 0,100,0,255',
    '0,100,0,255 0,100,0,255 0,100,0,255 0,100,0,255',
  ]),
  'linear 1e34 to 2e34': rgba([
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
    '0,100,128,255 0,100,128,255 0,100,128,255 0,100,128,255',
    '0,100,128,255 0,100,128,255 0,100,128,255 0,100,128,255',
  ]),
  'conic startAngle=6e36': rgba([
    '0,0,0,255 0,0,0,255 0,0,0,255 0,0,0,255',
    '0,0,0,255 0,0,0,255 0,0,0,255 0,0,0,255',
    '0,100,0,255 0,100,0,255 0,100,0,255 0,100,0,255',
    '0,100,0,255 0,100,0,255 0,100,0,255 0,100,0,255',
  ]),
  'conic startAngle=5.9e36': rgba([
    '10,0,244,255 247,0,9,255 220,0,34,255 202,0,54,255',
    '29,0,226,255 10,0,244,255 202,0,53,255 183,0,72,255',
    '27,100,99,255 38,100,91,255 69,100,58,255 79,100,49,255',
    '37,100,90,255 46,100,81,255 60,100,68,255 69,100,58,255',
  ]),
}

for (const [name, make] of Object.entries(HUGE)) {
  test(`huge gradient coordinates: ${name}`, (t) => {
    const ctx = createCanvas(4, 4).getContext('2d')
    ctx.fillStyle = 'rgb(0, 200, 0)'
    ctx.fillRect(0, 0, 4, 4)
    ctx.fillStyle = redBlue(make(ctx))
    t.notThrows(() => ctx.fillRect(0, 0, 4, 2))
    ctx.globalAlpha = 0.5
    ctx.fillRect(0, 2, 4, 2)
    t.deepEqual(all(ctx, 4, 4), HUGE_EXPECTED[name])
  })
}

const HUGE_OPS_EXPECTED: Record<string, { w: boolean; stroke: number[]; shape: number[]; shadow: number[] }> = {
  'linear 0 to 1e39': { w: true, stroke: [255, 0, 0, 255], shape: [255, 0, 0, 255], shadow: [0, 255, 0, 255] },
  'radial x0=1e39': { w: true, stroke: [0, 0, 255, 255], shape: [0, 0, 255, 255], shadow: [0, 255, 0, 255] },
  'conic startAngle=1e39': { w: true, stroke: [0, 0, 0, 255], shape: [0, 0, 0, 255], shadow: [0, 255, 0, 255] },
}

for (const [name, expected] of Object.entries(HUGE_OPS_EXPECTED)) {
  test(`huge gradient works with stroke, text and shadow: ${name}`, (t) => {
    const ctx = createCanvas(8, 8).getContext('2d')
    const g = redBlue(HUGE[name](ctx))
    ctx.strokeStyle = g
    ctx.fillStyle = g
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, 6, 6)
    ctx.font = '8px sans-serif'
    const w = ctx.measureText('a').width > 0
    t.notThrows(() => ctx.fillText('a', 2, 6))
    ctx.shadowColor = 'rgb(0, 255, 0)'
    ctx.shadowOffsetY = 4
    ctx.fillRect(3, 0, 2, 2)
    t.deepEqual({ w, stroke: px(ctx, 1, 1), shape: px(ctx, 3, 0), shadow: px(ctx, 3, 4) }, expected)
  })
}

test('huge gradient coordinates under a tiny scale', (t) => {
  const ctx = createCanvas(4, 4).getContext('2d')
  ctx.fillStyle = 'rgb(0, 200, 0)'
  ctx.fillRect(0, 0, 4, 4)
  ctx.scale(1e-30, 1)
  const g = redBlue(ctx.createLinearGradient(0, 0, 1e39, 0))
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 4, 2)
  ctx.globalAlpha = 0.5
  ctx.fillRect(0, 2, 4, 2)
  t.deepEqual(
    all(ctx, 4, 4),
    rgba([
      '255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255',
      '255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255',
      '127,100,0,255 128,100,0,255 127,100,0,255 128,100,0,255',
      '128,100,0,255 127,100,0,255 128,100,0,255 127,100,0,255',
    ]),
  )
})
