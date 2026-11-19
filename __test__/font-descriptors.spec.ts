// GlobalFonts.register's descriptors, as Blink draws a web font declared with
// them. The face is variable (wght 100-700); declared 400, bold is the 400
// instance emboldened, where `auto` draws the 700 instance. Each face takes
// the descriptors of the family name that matched it (CSSFontSelector looks
// one family up at a time), and its own variation coordinates. Chrome 159
// draws every equivalence here alike (FontFace with the same descriptors).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts, Image } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))
const font = (name: string) => readFileSync(join(__dirname, 'fonts', name))

const robotoMono = font('RobotoMono-VariableFont_wght.ttf')
GlobalFonts.register(robotoMono, 'Descriptors Auto')
GlobalFonts.register(robotoMono, 'Descriptors 400', { weight: 400 })
GlobalFonts.register(robotoMono, 'Descriptors 700', { weight: 700 })
GlobalFonts.register(robotoMono, 'Descriptors Italic', { style: 'italic' })
// Oswald: variable (wght 200-700), has the Latin digraphs Roboto Mono lacks.
GlobalFonts.register(font('Oswald.ttf'), 'Descriptors Oswald')
// Lato: static, no Greek.
GlobalFonts.register(font('Lato-Regular.ttf'), 'Descriptors Lato')
// Science Gothic: variable, slnt -10..0 (right-slanted), wght 100-900.
const scienceGothic = font('ScienceGothic-VariableFont.ttf')
GlobalFonts.register(scienceGothic, 'Slant Auto')
GlobalFonts.register(scienceGothic, 'Slant Normal', { weight: 400 })
GlobalFonts.register(scienceGothic, 'Slant Italic', { style: 'italic' })

const GREEK = 'ΑΒΓΔΕΘΛΞ'
const DIGRAPHS = 'ǅǄǆǇǈ'

function draw(font: string, text = 'Hamburgefonts', variations = '') {
  const ctx = createCanvas(420, 60).getContext('2d')
  ctx.font = font
  ctx.fontVariationSettings = variations || 'normal'
  ctx.fillText(text, 10, 42)
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

test('declared 700 is the 700 instance, never emboldened', (t) => {
  const auto = draw('bold 32px "Descriptors Auto"').pixels
  t.deepEqual(draw('32px "Descriptors 700"').pixels, auto)
  t.deepEqual(draw('bold 32px "Descriptors 700"').pixels, auto)
})

test('declared italic, italic is not slanted', (t) => {
  t.deepEqual(draw('italic 32px "Descriptors Italic"').pixels, draw('32px "Descriptors Auto"').pixels)
})

test('one font under two names takes the descriptors of the name that matched', (t) => {
  // One registration (the same buffer): the first name matches the face.
  t.deepEqual(
    draw('bold 32px "Descriptors Auto", "Descriptors 400"').pixels,
    draw('bold 32px "Descriptors Auto"').pixels,
  )
  t.deepEqual(
    draw('bold 32px "Descriptors 400", "Descriptors Auto"').pixels,
    draw('bold 32px "Descriptors 400"').pixels,
  )
  t.deepEqual(
    draw('bold 32px "Descriptors Auto", serif, "Descriptors 400"').pixels,
    draw('bold 32px "Descriptors Auto"').pixels,
  )
})

test('each family face has its own descriptors and coordinates', (t) => {
  // A static face first, the declared one draws the Greek.
  t.deepEqual(
    draw('bold 32px "Descriptors Lato", "Descriptors 400"', GREEK).pixels,
    draw('bold 32px "Descriptors 400"', GREEK).pixels,
  )
  // An `auto` variable face first, the declared one draws the Greek.
  t.deepEqual(
    draw('bold 32px "Descriptors Oswald", "Descriptors 400"', GREEK).pixels,
    draw('bold 32px "Descriptors 400"', GREEK).pixels,
  )
  // The declared face first, the `auto` variable one draws the digraphs at
  // the request's wght.
  t.deepEqual(
    draw('bold 32px "Descriptors 400", "Descriptors Oswald"', DIGRAPHS).pixels,
    draw('bold 32px "Descriptors Oswald"', DIGRAPHS).pixels,
  )
})

test('declared normal, italic is the slnt 0 instance skewed', (t) => {
  // ResolveVariations: slnt is the declared slope (clamped to the single
  // value range), then CSSSegmentedFontFace skews it.
  const italic = draw('italic 32px "Slant Normal"').pixels
  t.deepEqual(italic, draw('italic 32px "Slant Normal"', undefined, '"slnt" 0').pixels)
  t.notDeepEqual(italic, draw('32px "Slant Normal"').pixels)
})

test('declared italic draws slanted for any request', (t) => {
  // slnt -14, clamped to the axis' -10: the `auto` face's italic, unskewed.
  const slanted = draw('italic 32px "Slant Auto"').pixels
  t.deepEqual(draw('32px "Slant Italic"').pixels, slanted)
  t.deepEqual(draw('italic 32px "Slant Italic"').pixels, slanted)
  t.notDeepEqual(slanted, draw('32px "Slant Auto"').pixels)
})

function svgPixels(family: string, text: string) {
  const img = new Image()
  img.src = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="10" y="44" font-family="${family}" font-weight="bold" font-size="32">${text}</text></svg>`,
  )
  const ctx = createCanvas(200, 60).getContext('2d')
  ctx.drawImage(img, 0, 0)
  // The left part: the "Ham" glyphs only.
  return Buffer.from(ctx.getImageData(0, 0, 60, 60).data)
}

test('SVG text: a face has the same descriptors with and without a fallback run', (t) => {
  const family = 'Descriptors 400, Descriptors Oswald'
  const alone = svgPixels(family, 'Ham')
  t.deepEqual(svgPixels(family, `Ham${DIGRAPHS}`), alone)
  // Declared 400: bold is emboldened, unlike `auto`.
  t.notDeepEqual(alone, svgPixels('Descriptors Auto, Descriptors Oswald', 'Ham'))
})
