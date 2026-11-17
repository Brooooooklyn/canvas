// GlobalFonts.register's descriptors, as Blink draws a web font declared with
// them. The face is variable (wght 100-700); declared 400, bold is the 400
// instance emboldened, where `auto` draws the 700 instance.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const robotoMono = readFileSync(join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf'))
GlobalFonts.register(robotoMono, 'Descriptors Auto')
GlobalFonts.register(robotoMono, 'Descriptors 400', { weight: 400 })
GlobalFonts.register(robotoMono, 'Descriptors Italic', { style: 'italic' })

function draw(font: string) {
  const ctx = createCanvas(420, 60).getContext('2d')
  ctx.font = font
  ctx.fillText('Hamburgefonts', 10, 42)
  const { data } = ctx.getImageData(0, 0, 420, 60)
  let ink = 0
  for (let i = 3; i < data.length; i += 4) ink += data[i]
  return { ink, pixels: Buffer.from(data) }
}

test('declared 400, bold is the 400 instance emboldened', (t) => {
  const regular = draw('32px "Descriptors 400"')
  const bold = draw('bold 32px "Descriptors 400"')
  t.true(bold.ink > regular.ink * 1.05)
  t.notDeepEqual(bold.pixels, draw('bold 32px "Descriptors Auto"').pixels)
})

test('declared italic, italic is not slanted', (t) => {
  t.deepEqual(draw('italic 32px "Descriptors Italic"').pixels, draw('32px "Descriptors Auto"').pixels)
})
