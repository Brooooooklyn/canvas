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

// 40x40, stops red / lime / blue / yellow / magenta at 0 / .25 / .5 / .75 / 1, center (20, 20).
// Angle 0 points along +x and the sweep is clockwise; the CTM scale plays no part.
const CONIC_EXPECTED: Record<string, Record<'e' | 's' | 'w' | 'n', number[]>> = {
  '0,id': { e: [250, 4, 0, 255], s: [4, 250, 0, 255], w: [0, 5, 251, 255], n: [255, 251, 4, 255] },
  '0,rot30': { e: [255, 80, 174, 255], s: [89, 165, 0, 255], w: [0, 90, 166, 255], n: [174, 174, 81, 255] },
  '0,scale2': { e: [250, 4, 0, 255], s: [4, 250, 0, 255], w: [0, 5, 251, 255], n: [255, 251, 4, 255] },
  '1,id': { e: [255, 158, 97, 255], s: [166, 88, 0, 255], w: [0, 167, 89, 255], n: [97, 97, 158, 255] },
  '1,rot30': { e: [255, 243, 12, 255], s: [251, 3, 0, 255], w: [0, 252, 4, 255], n: [12, 12, 243, 255] },
  '1,scale2': { e: [255, 158, 97, 255], s: [166, 88, 0, 255], w: [0, 167, 89, 255], n: [97, 97, 158, 255] },
  'halfPi,id': { e: [255, 250, 4, 255], s: [255, 4, 250, 255], w: [5, 251, 0, 255], n: [4, 4, 251, 255] },
  'halfPi,rot30': { e: [174, 174, 80, 255], s: [255, 89, 165, 255], w: [90, 166, 0, 255], n: [0, 81, 174, 255] },
  'halfPi,scale2': { e: [255, 250, 4, 255], s: [255, 4, 250, 255], w: [5, 251, 0, 255], n: [4, 4, 251, 255] },
}

for (const [key, expected] of Object.entries(CONIC_EXPECTED)) {
  test(`conic gradient start angle matches Chrome (${key})`, (t) => {
    const [angle, transform] = key.split(',')
    const ctx = createCanvas(40, 40).getContext('2d')
    if (transform === 'rot30') {
      ctx.translate(20, 20)
      ctx.rotate(Math.PI / 6)
      ctx.translate(-20, -20)
    } else if (transform === 'scale2') {
      ctx.setTransform(2, 0, 0, 2, -20, -20)
    }
    const startAngle = angle === 'halfPi' ? Math.PI / 2 : Number(angle)
    const gradient = ctx.createConicGradient(startAngle, 20, 20)
    gradient.addColorStop(0, 'rgb(255, 0, 0)')
    gradient.addColorStop(0.25, 'rgb(0, 255, 0)')
    gradient.addColorStop(0.5, 'rgb(0, 0, 255)')
    gradient.addColorStop(0.75, 'rgb(255, 255, 0)')
    gradient.addColorStop(1, 'rgb(255, 0, 255)')
    ctx.fillStyle = gradient
    ctx.fillRect(-40, -40, 120, 120)
    t.deepEqual({ e: px(ctx, 38, 20), s: px(ctx, 20, 38), w: px(ctx, 1, 20), n: px(ctx, 20, 1) }, expected)
  })
}

// Image draws never read fillStyle, so a gradient that cannot become a shader (1e300 overflows
// f32) must not stop them. Chrome draws the image; drawCanvas has no Chrome counterpart and must
// match drawImage.
const UNREPRESENTABLE_GRADIENTS: Record<string, (ctx: Ctx) => ReturnType<Ctx['createLinearGradient']>> = {
  'linear x1=1e300': (ctx) => ctx.createLinearGradient(0, 0, 1e300, 0),
  'radial x0=1e300': (ctx) => ctx.createRadialGradient(1e300, 0, 0, 0, 0, 4),
  'conic startAngle=1e300': (ctx) => ctx.createConicGradient(1e300, 2, 2),
}

// prettier-ignore
const RED_2X2_AT_1_1_ON_GREEN = [
  0, 0, 0, 0,
  0, 1, 1, 0,
  0, 1, 1, 0,
  0, 0, 0, 0,
].flatMap((red) => (red ? [255, 0, 0, 255] : [0, 128, 0, 255]))

for (const [name, makeGradient] of Object.entries(UNREPRESENTABLE_GRADIENTS)) {
  test(`drawImage and drawCanvas ignore a ${name} gradient fillStyle`, (t) => {
    const source = createCanvas(2, 2)
    const sourceCtx = source.getContext('2d')
    sourceCtx.fillStyle = 'rgb(255, 0, 0)'
    sourceCtx.fillRect(0, 0, 2, 2)
    const draws: Record<string, (ctx: Ctx) => void> = {
      drawImage: (ctx) => ctx.drawImage(source, 1, 1),
      'drawImage 9 args': (ctx) => ctx.drawImage(source, 0, 0, 2, 2, 1, 1, 2, 2),
      drawCanvas: (ctx) => ctx.drawCanvas(source, 1, 1),
    }
    for (const [label, draw] of Object.entries(draws)) {
      const ctx = createCanvas(4, 4).getContext('2d')
      ctx.fillStyle = 'rgb(0, 128, 0)'
      ctx.fillRect(0, 0, 4, 4)
      const gradient = makeGradient(ctx)
      gradient.addColorStop(0, 'blue')
      gradient.addColorStop(1, 'yellow')
      ctx.fillStyle = gradient
      t.notThrows(() => draw(ctx), label)
      t.deepEqual([...ctx.getImageData(0, 0, 4, 4).data], RED_2X2_AT_1_1_ON_GREEN, label)
    }
  })
}

test('display-p3 canvas interpolates legacy gradient stops in sRGB', (t) => {
  const canvas = createCanvas(64, 2)
  const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' })
  const gradient = ctx.createLinearGradient(0, 0, 64, 0)
  gradient.addColorStop(0, '#ff0000')
  gradient.addColorStop(1, '#0000ff')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 2)
  t.deepEqual(px(ctx, 32, 0), [114, 19, 124, 255], 'display-p3 bytes')
  const out = createCanvas(64, 2)
  const outCtx = out.getContext('2d')
  outCtx.drawImage(canvas, 0, 0)
  t.deepEqual(px(outCtx, 32, 0), [125, 0, 128, 255], 'drawn into an sRGB canvas')
  t.deepEqual(px(outCtx, 16, 0), [189, 0, 66, 255], 'drawn into an sRGB canvas')
})

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

test('hsl() stop alpha stays a float off the CSS fast path', (t) => {
  // Two equal stops, 8x1. Blink rounds an hsl() alpha to k/255 only when its CSS fast path
  // parses the color: a lowercase hsl()/hsla() whose alpha is a plain number right before ')'.
  // Any other spelling keeps the float alpha, which dithers differently.
  const rounded = Array(8).fill([64, 191, 64, 84]).flat()
  // prettier-ignore
  const float = [
    64, 191, 64, 84, 64, 191, 64, 84, 64, 191, 64, 84, 64, 194, 64, 84,
    64, 191, 64, 84, 64, 191, 64, 84, 64, 191, 64, 84, 67, 194, 67, 84,
  ]
  const expected: Record<string, number[]> = {
    'hsla(120, 50%, 50%, 0.33)': rounded,
    'hsl(120 50% 50%/.33)': rounded,
    '  hsla(120, 50%, 50%,0.33)  ': rounded,
    'hsl(120 50% 50% / 33%)': float,
    'hsla(120, 50%, 50%, 33%)': float,
    'HSLA(120, 50%, 50%, 0.33)': float,
    'hsla(120, 50%, 50%, 0.33 )': float,
    'hsla(120, 50%, 50%, 3.3e-1)': float,
    // prettier-ignore
    'hsla(10, 77%, 33%, 70%)': [
      149, 40, 19, 178, 150, 42, 20, 178, 149, 40, 19, 178, 150, 42, 20, 178,
      149, 40, 19, 178, 150, 42, 20, 178, 149, 40, 19, 178, 150, 42, 20, 178,
    ],
  }
  for (const [color, bytes] of Object.entries(expected)) {
    const ctx = createCanvas(8, 1).getContext('2d')
    const gradient = ctx.createLinearGradient(0, 0, 8, 0)
    gradient.addColorStop(0, color)
    gradient.addColorStop(1, color)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 8, 1)
    t.deepEqual([...ctx.getImageData(0, 0, 8, 1).data], bytes, color)
  }
})
