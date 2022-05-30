import { readFileSync } from 'fs'
import { join } from 'path'

import ava, { TestFn } from 'ava'

import { GlobalFonts, createCanvas, Canvas, SKRSContext2D } from '../index'
import { snapshotImage } from './image-snapshot'

const test = ava as TestFn<{
  canvas: Canvas
  ctx: SKRSContext2D
}>

const fontIosevka = readFileSync(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))

console.assert(GlobalFonts.register(fontIosevka), 'Register Iosevka font failed')

test.beforeEach((t) => {
  const canvas = createCanvas(512, 512)
  t.context.canvas = canvas
  t.context.ctx = canvas.getContext('2d')!
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
  ctx.fillText('abcdef', 50, 50)
  ctx.fillText('abcdefg', 50, 50)
  await snapshotImage(t)
})
