import { join } from 'path'

import ava, { TestFn } from 'ava'

import { createCanvas, SvgCanvas, SvgExportFlag, GlobalFonts } from '../index'

const test = ava as TestFn<{
  canvas: SvgCanvas
}>

test.beforeEach((t) => {
  t.context.canvas = createCanvas(1024, 768, SvgExportFlag.ConvertTextToPaths)
})

test('should be able to export path/arc/rect', (t) => {
  const { canvas } = t.context
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'yellow'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.lineWidth = 3
  ctx.strokeStyle = 'hotpink'
  ctx.strokeRect(50, 450, 100, 100)
  ctx.fillStyle = 'hotpink'
  ctx.arc(500, 120, 90, 0, Math.PI * 2)
  ctx.fill()
  t.snapshot(canvas.getContent().toString('utf8'))
})

test('should be able to export text', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts-dir', 'iosevka-curly-regular.woff2'), 'i-curly')
  const { canvas } = t.context
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'yellow'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.lineWidth = 3
  ctx.strokeStyle = 'hotpink'
  ctx.font = '50px i-curly'
  ctx.strokeText('@napi-rs/canvas', 50, 300)
  t.snapshot(canvas.getContent().toString('utf8'))
})
