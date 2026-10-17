// Pinned to Chrome 155 CPU canvas (getContext('2d', { willReadFrequently: true }), --disable-gpu),
// measured on arm64 and on x64 (Rosetta); both gave the same values.
import test from 'ava'

import { createCanvas } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

// 'r,g,b,a r,g,b,a ...' rows -> flat RGBA bytes
const rgba = (rows: string[]) =>
  rows.flatMap((row) =>
    row
      .trim()
      .split(/\s+/)
      .flatMap((p) => p.split(',').map(Number)),
  )
const all = (ctx: Ctx, w: number, h: number) => [...ctx.getImageData(0, 0, w, h).data]

// A CanvasGradient is live (Blink CanvasStyle keeps the object; AddColorStop drops the cached shader):
// stops added after it became fillStyle / strokeStyle apply to later draws.
const makeKind = (ctx: Ctx, kind: string) =>
  kind === 'linear'
    ? ctx.createLinearGradient(0, 0, 4, 0)
    : kind === 'radial'
      ? ctx.createRadialGradient(2, 2, 0, 2, 2, 2)
      : ctx.createConicGradient(0, 2, 2)

const RED_4X4 = rgba([
  '255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255',
  '255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255',
  '255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255',
  '255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255',
])
const BLUE_4X4 = rgba([
  '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
  '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
  '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
  '0,0,255,255 0,0,255,255 0,0,255,255 0,0,255,255',
])

for (const kind of ['linear', 'radial', 'conic']) {
  test(`${kind} stops added after fillStyle apply`, (t) => {
    const ctx = createCanvas(4, 4).getContext('2d')
    const g = makeKind(ctx, kind)
    ctx.fillStyle = g
    g.addColorStop(0, 'rgb(255, 0, 0)')
    g.addColorStop(1, 'rgb(255, 0, 0)')
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual(all(ctx, 4, 4), RED_4X4)
  })

  test(`${kind} stops added after strokeStyle apply`, (t) => {
    const ctx = createCanvas(4, 4).getContext('2d')
    const g = makeKind(ctx, kind)
    ctx.strokeStyle = g
    g.addColorStop(0, 'rgb(0, 0, 255)')
    g.addColorStop(1, 'rgb(0, 0, 255)')
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(0, 2)
    ctx.lineTo(4, 2)
    ctx.stroke()
    t.deepEqual(all(ctx, 4, 4), BLUE_4X4)
  })
}

test('a stop added after a draw changes later draws only', (t) => {
  const ctx = createCanvas(8, 2).getContext('2d')
  const g = ctx.createLinearGradient(0, 0, 8, 0)
  g.addColorStop(0, 'rgb(255, 0, 0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 8, 1)
  g.addColorStop(1, 'rgb(0, 0, 255)')
  ctx.fillRect(0, 1, 8, 1)
  t.deepEqual(
    all(ctx, 8, 2),
    rgba([
      '255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255 255,0,0,255',
      '239,0,16,255 207,0,48,255 176,0,80,255 143,0,112,255 112,0,143,255 79,0,175,255 48,0,207,255 16,0,239,255',
    ]),
  )
})

test('restore() brings back the same live gradient', (t) => {
  const ctx = createCanvas(8, 1).getContext('2d')
  const g = ctx.createLinearGradient(0, 0, 8, 0)
  g.addColorStop(0, 'rgb(0, 255, 0)')
  ctx.fillStyle = g
  ctx.save()
  g.addColorStop(1, 'rgb(0, 0, 255)')
  ctx.restore()
  ctx.fillRect(0, 0, 8, 1)
  t.is(ctx.fillStyle, g)
  t.deepEqual(
    all(ctx, 8, 1),
    rgba(['0,239,15,255 0,207,48,255 0,175,79,255 0,144,112,255 0,111,143,255 0,80,176,255 0,48,207,255 0,16,240,255']),
  )
})

test('one gradient shared by two contexts is live in both', (t) => {
  const a = createCanvas(8, 1).getContext('2d')
  const b = createCanvas(8, 1).getContext('2d')
  const g = a.createLinearGradient(0, 0, 8, 0)
  a.fillStyle = g
  b.fillStyle = g
  g.addColorStop(0, 'rgb(255, 0, 0)')
  g.addColorStop(1, 'rgb(0, 0, 255)')
  b.fillRect(0, 0, 8, 1)
  t.deepEqual(
    all(b, 8, 1),
    rgba(['239,0,15,255 207,0,48,255 175,0,79,255 144,0,112,255 111,0,143,255 80,0,176,255 48,0,207,255 16,0,240,255']),
  )
})

// The offset and color convert before the stop is stored: user code that draws with (and adds
// stops to) the same gradient meanwhile sees the stops it has at that moment.
test('drawing from inside the argument conversion of addColorStop', (t) => {
  const ctx = createCanvas(4, 1).getContext('2d')
  const g = ctx.createLinearGradient(0, 0, 4, 0)
  g.addColorStop(0, 'rgb(255, 0, 0)')
  ctx.fillStyle = g
  const offset = {
    valueOf() {
      ctx.fillRect(0, 0, 4, 1)
      g.addColorStop(0.5, 'rgb(0, 255, 0)')
      return 1
    },
  }
  const color = {
    toString() {
      ctx.fillRect(0, 0, 2, 1)
      return 'rgb(0, 0, 255)'
    },
  }
  g.addColorStop(offset as unknown as number, color as unknown as string)
  t.deepEqual(all(ctx, 4, 1), rgba(['191,63,0,255 64,192,0,255 255,0,0,255 255,0,0,255']))
  ctx.clearRect(0, 0, 4, 1)
  ctx.fillRect(0, 0, 4, 1)
  t.deepEqual(all(ctx, 4, 1), rgba(['191,63,0,255 64,192,0,255 0,191,63,255 0,64,192,255']))
})

// User code in the conversion may also make the gradient the style and draw with it.
test('assigning and drawing the gradient from inside the conversion of addColorStop', (t) => {
  const ctx = createCanvas(4, 1).getContext('2d')
  const g = ctx.createLinearGradient(0, 0, 4, 0)
  g.addColorStop(0, {
    toString() {
      ctx.strokeStyle = g
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 4, 1)
      return 'red'
    },
  } as unknown as string)
  g.addColorStop(
    {
      valueOf() {
        ctx.fillRect(0, 0, 4, 1)
        return 1
      },
    } as unknown as number,
    'blue',
  )
  ctx.fillRect(3, 0, 1, 1)
  t.deepEqual(all(ctx, 4, 1), rgba(['255,0,0,255 255,0,0,255 255,0,0,255 32,0,224,255']))
})
