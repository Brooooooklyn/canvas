// Pinned to Chrome 155 CPU canvas (getContext('2d', { willReadFrequently: true }), --disable-gpu),
// measured on arm64 and on x64 (Rosetta); both gave the same values.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts, SvgExportFlag } from '../index'

// A Linux test container has no system fonts, and each spec file runs in its
// own process, so the text below uses a font this file registers.
GlobalFonts.registerFromPath(
  join(fileURLToPath(new URL('.', import.meta.url)), 'fonts', 'Lato-Regular.ttf'),
  'GradientLato',
)

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
    ctx.font = '8px GradientLato'
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

// Blink kDisallow (gradient.cc): linear p0 == p1, or radial p0 == p1 and r0 == r1 after the f32
// clamp, is an empty shader: the draw (and its shadow) paints nothing, like a gradient with no stops.
const DEGENERATE: Record<string, (c: Ctx) => G> = {
  'linear (2,2)-(2,2)': (c) => c.createLinearGradient(2, 2, 2, 2),
  'linear (0,0)-(-0,0)': (c) => c.createLinearGradient(0, 0, -0, 0),
  'linear x1=2+1e-7 (equal as float)': (c) => c.createLinearGradient(2, 2, 2 + 1e-7, 2),
  'linear 1e39-2e39 (both clamp to FLT_MAX)': (c) => c.createLinearGradient(1e39, 0, 2e39, 0),
  'radial equal circles r=1': (c) => c.createRadialGradient(2, 2, 1, 2, 2, 1),
  'radial equal circles r=0': (c) => c.createRadialGradient(2, 2, 0, 2, 2, 0),
  'radial radii 1e33 and 2e33 (both clamp)': (c) => c.createRadialGradient(2, 2, 1e33, 2, 2, 2e33),
  'radial equal as float': (c) => c.createRadialGradient(2, 2, 1, 2 + 1e-7, 2, 1 + 1e-8),
  'radial r1=1+1e-7 (not equal as float)': (c) => c.createRadialGradient(2, 2, 1, 2, 2, 1 + 1e-7),
}
const DEGENERATE_EXPECTED: Record<string, { before: number[]; copy: number[] }> = {
  'linear (2,2)-(2,2)': {
    before: rgba([
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
    ]),
    copy: rgba([
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
    ]),
  },
  'linear (0,0)-(-0,0)': {
    before: rgba([
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
    ]),
    copy: rgba([
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
    ]),
  },
  'linear x1=2+1e-7 (equal as float)': {
    before: rgba([
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
    ]),
    copy: rgba([
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
    ]),
  },
  'linear 1e39-2e39 (both clamp to FLT_MAX)': {
    before: rgba([
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
    ]),
    copy: rgba([
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
    ]),
  },
  'radial equal circles r=1': {
    before: rgba([
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
    ]),
    copy: rgba([
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
    ]),
  },
  'radial equal circles r=0': {
    before: rgba([
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
    ]),
    copy: rgba([
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
    ]),
  },
  'radial radii 1e33 and 2e33 (both clamp)': {
    before: rgba([
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
    ]),
    copy: rgba([
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
    ]),
  },
  'radial equal as float': {
    before: rgba([
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
      '0,128,0,255 0,128,0,255 0,128,0,255 0,128,0,255',
    ]),
    copy: rgba([
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
    ]),
  },
  'radial r1=1+1e-7 (not equal as float)': {
    before: rgba([
      '0,0,255,255 32,0,223,255 64,0,191,255 191,0,64,255',
      '0,0,255,255 255,0,0,255 255,0,0,255 127,0,128,255',
      '0,0,255,255 255,0,0,255 255,0,0,255 127,0,128,255',
      '0,96,64,255 32,48,128,255 64,32,128,255 96,48,64,255',
    ]),
    copy: rgba([
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
      '0,0,0,0 255,0,0,255 255,0,0,255 0,0,0,0',
      '0,0,0,0 255,0,0,255 255,0,0,255 0,0,0,0',
      '0,0,0,0 0,0,0,0 0,0,0,0 0,0,0,0',
    ]),
  },
}

for (const [name, make] of Object.entries(DEGENERATE)) {
  test(`degenerate gradient: ${name}`, (t) => {
    const ctx = createCanvas(4, 4).getContext('2d')
    ctx.fillStyle = 'rgb(0, 128, 0)'
    ctx.fillRect(0, 0, 4, 4)
    const g = redBlue(make(ctx))
    ctx.fillStyle = g
    ctx.strokeStyle = g
    ctx.shadowColor = 'rgb(255, 0, 0)'
    ctx.shadowOffsetX = 1
    ctx.fillRect(0, 0, 3, 3)
    ctx.strokeRect(1, 1, 2, 2)
    const before = all(ctx, 4, 4)
    ctx.shadowColor = 'rgba(0, 0, 0, 0)'
    ctx.globalCompositeOperation = 'copy'
    ctx.fillRect(1, 1, 2, 2)
    t.deepEqual({ before, copy: all(ctx, 4, 4) }, DEGENERATE_EXPECTED[name])
  })
}

// Nearly degenerate still paints (Skia's own handling of tiny gradients).
const NEAR: Record<string, (c: Ctx) => G> = {
  'linear x1=2.00001': (c) => c.createLinearGradient(2, 2, 2.00001, 2),
  'radial r1=1.00001': (c) => c.createRadialGradient(2, 2, 1, 2, 2, 1.00001),
  'radial x1=2.00001': (c) => c.createRadialGradient(2, 2, 1, 2.00001, 2, 1),
}
const NEAR_EXPECTED: Record<string, number[]> = {
  'linear x1=2.00001': rgba([
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
  ]),
  'radial r1=1.00001': rgba([
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
    '0,0,255,255 255,0,0,255 255,0,0,255 0,0,255,255',
    '0,0,255,255 255,0,0,255 255,0,0,255 0,0,255,255',
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
  ]),
  'radial x1=2.00001': rgba([
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
    '0,0,255,255 255,0,0,255 255,0,0,255 0,0,255,255',
    '0,0,255,255 255,0,0,255 255,0,0,255 0,0,255,255',
    '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
  ]),
}

for (const [name, make] of Object.entries(NEAR)) {
  test(`nearly degenerate gradient paints: ${name}`, (t) => {
    const ctx = createCanvas(4, 4).getContext('2d')
    ctx.fillStyle = 'rgb(0, 128, 0)'
    ctx.fillRect(0, 0, 4, 4)
    ctx.fillStyle = redBlue(make(ctx))
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual(all(ctx, 4, 4), NEAR_EXPECTED[name])
  })
}

// A degenerate gradient paints no text either, and with destination-out it clears nothing.
test('a degenerate gradient paints no text and keeps the destination under destination-out', (t) => {
  const ctx = createCanvas(16, 16).getContext('2d')
  ctx.fillStyle = 'rgb(0, 128, 0)'
  ctx.fillRect(0, 0, 16, 16)
  ctx.fillStyle = redBlue(ctx.createLinearGradient(3, 3, 3, 3))
  ctx.font = '16px GradientLato'
  ctx.fillText('MW', 0, 14)
  t.is(all(ctx, 16, 16).filter((v, i) => i % 4 === 0 && v !== 0).length, 0)
  ctx.scale(2, 2)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillRect(0, 0, 8, 8)
  t.deepEqual(px(ctx, 5, 5), [0, 128, 0, 255])
})

// SVG has no Chrome counterpart: the SVG must look like Chrome's raster, which paints nothing.
test('svg export of a degenerate gradient draws nothing', (t) => {
  for (const make of [
    (c: Ctx) => c.createLinearGradient(5, 5, 5, 5),
    (c: Ctx) => c.createRadialGradient(20, 20, 5, 20, 20, 5),
  ]) {
    const svg = createCanvas(40, 40, SvgExportFlag.NoPrettyXML)
    const ctx = svg.getContext('2d') as unknown as Ctx
    ctx.fillStyle = redBlue(make(ctx))
    ctx.fillRect(0, 0, 40, 40)
    t.notRegex(svg.getContent().toString('utf8'), /<rect|<path/)
  }
})
