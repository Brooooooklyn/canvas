import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import ava, { TestFn } from 'ava'

import { createCanvas, SvgCanvas, SvgExportFlag, GlobalFonts } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const test = ava as TestFn<{
  canvas: SvgCanvas
}>

test.beforeEach((t) => {
  t.context.canvas = createCanvas(1024, 768, SvgExportFlag.ConvertTextToPaths)
})

test('should be able to adjust size', (t) => {
  const { canvas } = t.context
  canvas.width = 512
  canvas.height = 384

  t.is(canvas.width, 512)
  t.is(canvas.height, 384)
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

// REGRESSION GUARD, do not weaken to a snapshot.
//
// `ctx.filter` used to be hoisted onto an explicit `saveLayer` image filter for
// every draw, shadowed or not, so that its lengths would be device-space. The
// SVG backend cannot make a layer device -- `SkSVGDevice` inherits
// `SkDevice::createDevice`'s `return nullptr` and `SkCanvas` then substitutes
// "an explicit NoPixelsDevice ... squashing draw calls that target something
// that doesn't exist" -- so every filtered draw was DISCARDED and the export
// came back as a bare 148-byte `<svg/>`. A filter with no spatial component is
// left on the content paint on this backend now; see `Context::render_passes`.
test('ctx.filter without a shadow must not swallow the drawing', (t) => {
  const { canvas } = t.context
  const ctx = canvas.getContext('2d')
  ctx.filter = 'grayscale(1)'
  ctx.fillStyle = 'blue'
  ctx.fillRect(40, 40, 80, 60)
  ctx.strokeStyle = 'red'
  ctx.lineWidth = 6
  ctx.strokeRect(200, 40, 80, 60)
  ctx.beginPath()
  ctx.moveTo(400, 40)
  ctx.lineTo(500, 40)
  ctx.lineTo(450, 140)
  ctx.closePath()
  ctx.fill()

  const svg = canvas.getContent().toString('utf8')
  t.is((svg.match(/<rect/g) ?? []).length, 2, `fillRect and strokeRect must both survive: ${svg}`)
  t.is((svg.match(/<path/g) ?? []).length, 1, `fill(path) must survive: ${svg}`)
})

// The CTM is irrelevant to a filter with no spatial component, so the drawing
// has to survive under one too -- this is the case a CTM-based fix would miss.
test('ctx.filter without a shadow survives a non-identity transform', (t) => {
  const { canvas } = t.context
  const ctx = canvas.getContext('2d')
  ctx.filter = 'grayscale(1)'
  ctx.scale(2, 2)
  ctx.fillStyle = 'blue'
  ctx.fillRect(40, 40, 80, 60)

  const svg = canvas.getContent().toString('utf8')
  t.is((svg.match(/<rect/g) ?? []).length, 1, `the scaled fillRect must survive: ${svg}`)
})

test('ctx.filter without a shadow must not swallow text', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts-dir', 'iosevka-curly-regular.woff2'), 'i-curly')
  const { canvas } = t.context
  const ctx = canvas.getContext('2d')
  ctx.filter = 'grayscale(1)'
  ctx.fillStyle = 'black'
  ctx.font = '50px i-curly'
  ctx.fillText('napi-rs', 50, 300)

  const svg = canvas.getContent().toString('utf8')
  t.true((svg.match(/<path/g) ?? []).length > 0, `fillText must survive: ${svg}`)
})
