// Gradient pixels pinned to Chrome 155 CPU canvas
// (getContext('2d', { willReadFrequently: true }), launched with --disable-gpu).
import test from 'ava'

import { createCanvas, SvgExportFlag } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const KINDS = ['linear', 'radial', 'conic'] as const

const makeGradient = (ctx: Ctx, kind: (typeof KINDS)[number], n: number) =>
  kind === 'linear'
    ? ctx.createLinearGradient(0, 0, n, 0)
    : kind === 'radial'
      ? ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n)
      : ctx.createConicGradient(0, n / 2, n / 2)

const px = (ctx: Ctx, x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data]

// rgb(32, 128, 223) at globalAlpha 0.5: Chrome dithers the blue channel to 221/223.
// prettier-ignore
const DITHERED_4X4 = [
  221, 223, 221, 223,
  223, 221, 223, 221,
  221, 223, 221, 223,
  223, 221, 223, 221,
].flatMap((b) => [32, 128, b, 128])

for (const kind of KINDS) {
  test(`${kind} gradient with no color stops paints transparent black`, (t) => {
    const canvas = createCanvas(4, 4)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'rgb(0, 128, 0)'
    ctx.fillRect(0, 0, 4, 4)
    const gradient = makeGradient(ctx, kind, 4)
    ctx.fillStyle = gradient
    ctx.strokeStyle = gradient
    t.notThrows(() => ctx.fillRect(0, 0, 4, 4))
    t.notThrows(() => ctx.strokeRect(1, 1, 2, 2))
    const source = createCanvas(2, 2)
    const sourceCtx = source.getContext('2d')
    sourceCtx.fillStyle = 'rgb(255, 0, 0)'
    sourceCtx.fillRect(0, 0, 2, 2)
    t.notThrows(() => ctx.drawImage(source, 1, 1))
    t.notThrows(() => ctx.drawCanvas(source, 1, 1))
    t.deepEqual(px(ctx, 0, 0), [0, 128, 0, 255])
    t.deepEqual(px(ctx, 1, 1), [255, 0, 0, 255])
    // `copy` with a transparent black paint clears the whole canvas.
    ctx.globalCompositeOperation = 'copy'
    ctx.fillRect(1, 1, 2, 2)
    t.deepEqual([...ctx.getImageData(0, 0, 4, 4).data], Array(64).fill(0))
  })

  for (const offset of [0, 0.3, 1]) {
    test(`${kind} gradient with one color stop at ${offset} is dithered`, (t) => {
      const ctx = createCanvas(4, 4).getContext('2d')
      const gradient = makeGradient(ctx, kind, 4)
      gradient.addColorStop(offset, 'rgb(32, 128, 223)')
      ctx.globalAlpha = 0.5
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, 4, 4)
      t.deepEqual([...ctx.getImageData(0, 0, 4, 4).data], DITHERED_4X4)
    })
  }

  // SVG has no Chrome counterpart. Per spec, a gradient with no stops is transparent black,
  // and a one-stop gradient is that stop's color everywhere, alpha included.
  test(`svg export of a ${kind} gradient with one translucent stop keeps its opacity`, (t) => {
    const canvas = createCanvas(20, 20, SvgExportFlag.ConvertTextToPaths)
    const ctx = canvas.getContext('2d')
    const gradient = makeGradient(ctx as unknown as Ctx, kind, 20)
    gradient.addColorStop(0.5, 'rgba(32, 128, 223, 0.5)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 20, 20)
    t.regex(canvas.getContent().toString('utf8'), /fill="#2080DF" fill-opacity="0\.50196081"/)
  })

  test(`svg export of a ${kind} gradient with no color stops draws nothing visible`, (t) => {
    const canvas = createCanvas(20, 20, SvgExportFlag.ConvertTextToPaths)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = makeGradient(ctx as unknown as Ctx, kind, 20)
    t.notThrows(() => ctx.fillRect(0, 0, 20, 20))
    t.notRegex(canvas.getContent().toString('utf8'), /<rect/)
  })
}

test('hsl() gradient stops keep float precision', (t) => {
  // Two equal stops: Chrome keeps the float sRGB color and dithers it.
  const expected: Record<string, number[]> = {
    'hsl(120, 50%, 50%)': [63, 191, 63, 255, 64, 192, 64, 255],
    'hsl(10, 77%, 33%)': [148, 40, 19, 255, 149, 41, 20, 255],
  }
  for (const [color, bytes] of Object.entries(expected)) {
    const ctx = createCanvas(8, 1).getContext('2d')
    const gradient = ctx.createLinearGradient(0, 0, 8, 0)
    gradient.addColorStop(0, color)
    gradient.addColorStop(1, color)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 8, 1)
    t.deepEqual([...ctx.getImageData(0, 0, 2, 1).data], bytes, color)
  }
})
