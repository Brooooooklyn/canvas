import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import ava, { TestFn } from 'ava'

import { GlobalFonts, createCanvas, Canvas, SKRSContext2D, type CanvasTextAlign } from '../index'
import { snapshotImage } from './image-snapshot'

const __dirname = dirname(fileURLToPath(import.meta.url))

const test = ava as TestFn<{
  canvas: Canvas
  ctx: SKRSContext2D
}>

test.beforeEach((t) => {
  const canvas = createCanvas(512, 512)
  t.context.canvas = canvas
  t.context.ctx = canvas.getContext('2d')!
  t.truthy(
    GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf')),
    'Register Iosevka font failed',
  )
})

for (const align of ['center', 'end', 'left', 'right', 'start'] as CanvasTextAlign[]) {
  test(`text-align-${align}`, async (t) => {
    const { ctx, canvas } = t.context
    const x = canvas.width / 2
    ctx.strokeStyle = 'black'
    ctx.moveTo(x, 0)
    ctx.lineTo(x, canvas.height)
    ctx.stroke()
    ctx.textAlign = align
    ctx.font = '16px Iosevka Slab'
    ctx.fillText('Hello Canvas', x, 200)
    await snapshotImage(t)
  })
}

test(`fillText-line-break-as-space`, async (t) => {
  const { ctx, canvas } = t.context
  const x = canvas.width / 2
  ctx.font = '16px Iosevka Slab'
  ctx.fillText('Hello\nCanvas', x, 200)
  await snapshotImage(t)
})

test(`strokeText-line-break-as-space`, async (t) => {
  const { ctx, canvas } = t.context
  const x = canvas.width / 2
  ctx.font = '32px Iosevka Slab'
  ctx.strokeText('Hello\nCanvas', x, 200)
  await snapshotImage(t)
})

test(`measureText with suffix spaces`, async (t) => {
  const { ctx } = t.context
  ctx.font = '50px Iosevka Slab'
  const { width } = ctx.measureText('Hello')
  const { width: widthWithSpace } = ctx.measureText('hello ')
  const { width: widthWithTwoSpace } = ctx.measureText('hello  ')
  t.not(width, widthWithSpace)
  t.is(ctx.measureText(' ').width, widthWithSpace - width)
  t.is(ctx.measureText('  ').width, widthWithTwoSpace - width)
})

// https://github.com/Brooooooklyn/canvas/issues/386
test('text-baseline', async (t) => {
  const { ctx } = t.context
  ctx.font = '48px Iosevka Slab'
  ctx.textBaseline = 'bottom'
  ctx.fillText('abcdef', 50, 100)
  ctx.fillText('abcdefg', 50, 100)
  await snapshotImage(t)
})

test('text-baseline-all', async (t) => {
  const { ctx } = t.context
  const baselines = ['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'] as const
  ctx.font = '36px Iosevka Slab'
  ctx.strokeStyle = 'red'

  baselines.forEach((baseline, index) => {
    ctx.textBaseline = baseline
    const y = 75 + index * 75
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(550, y + 0.5)
    ctx.stroke()
    ctx.fillText(`Abcdefghijklmnop (${baseline})`, 0, y)
  })
  await snapshotImage(t)
})

test('letter-spacing', async (t) => {
  const canvas = createCanvas(800, 800)
  const ctx = canvas.getContext('2d')!
  ctx.font = '30px Iosevka Slab'

  // Default letter spacing
  ctx.fillText(`Hello world (default: ${ctx.letterSpacing})`, 10, 40)

  // Custom letter spacing: 10px
  ctx.letterSpacing = '10px'
  ctx.fillText(`Hello world (${ctx.letterSpacing})`, 10, 90)
  ctx.save()
  // Custom letter spacing: 20px
  ctx.letterSpacing = '20px'
  ctx.fillText(`Hello world (${ctx.letterSpacing})`, 10, 140)
  ctx.restore()
  ctx.fillText(`Hello world (${ctx.letterSpacing})`, 10, 190)

  ctx.textAlign = 'center'
  const { width } = ctx.measureText(`Hello world (${ctx.letterSpacing})`)
  ctx.fillText(`Hello world (${ctx.letterSpacing})`, width / 2 + 10, 240)

  ctx.textAlign = 'start'
  ctx.fillText(`Hello world (${ctx.letterSpacing})`, 10, 290)
  ctx.textAlign = 'right'
  ctx.fillText(`Hello world (${ctx.letterSpacing})`, -width + 10, 340)
  await snapshotImage(t, { canvas, ctx })
})

test('negative-letter-spacing', async (t) => {
  const canvas = createCanvas(800, 800)
  const ctx = canvas.getContext('2d')!
  ctx.font = '30px Iosevka Slab'

  // Default letter spacing
  ctx.fillText(`Hello world (default: ${ctx.letterSpacing})`, 10, 40)

  ctx.letterSpacing = '-5px'
  ctx.fillText(`Hello world (${ctx.letterSpacing})`, 10, 90)
  await snapshotImage(t, { canvas, ctx })
})

test('word-spacing', async (t) => {
  const canvas = createCanvas(800, 800)
  const ctx = canvas.getContext('2d')!
  ctx.font = '30px Iosevka Slab'

  // Default word spacing
  ctx.fillText(`Hello world (default: ${ctx.wordSpacing})`, 10, 40)

  // Custom word spacing: 10px
  ctx.wordSpacing = '10px'
  ctx.fillText(`Hello world (${ctx.wordSpacing})`, 10, 90)
  ctx.save()
  // Custom word spacing: 20px
  ctx.wordSpacing = '20px'
  ctx.fillText(`Hello world (${ctx.wordSpacing})`, 10, 140)
  ctx.restore()
  ctx.fillText(`Hello world (${ctx.wordSpacing})`, 10, 190)

  ctx.textAlign = 'center'
  const { width } = ctx.measureText(`Hello world (${ctx.wordSpacing})`)
  ctx.fillText(`Hello world (${ctx.wordSpacing})`, width / 2 + 10, 240)

  ctx.textAlign = 'start'
  ctx.fillText(`Hello world (${ctx.wordSpacing})`, 10, 290)
  ctx.textAlign = 'right'
  ctx.fillText(`Hello world (${ctx.wordSpacing})`, -width + 10, 340)
  await snapshotImage(t, { canvas, ctx })
})

test('text-align-with-space', async (t) => {
  if (process.platform !== 'darwin') {
    t.pass('Skip test, no fallback fonts on this platform in CI')
    return
  }
  const { ctx } = t.context
  ctx.strokeStyle = 'black'
  ctx.lineWidth = 1
  ctx.moveTo(100, 0)
  ctx.lineTo(100, 512)
  ctx.stroke()
  ctx.font = '38px Iosevka Slab'
  ctx.textAlign = 'center'
  ctx.fillText('Mona Lisa', 100, 50)
  ctx.fillText('A B C', 100, 200)
  await snapshotImage(t)
})
