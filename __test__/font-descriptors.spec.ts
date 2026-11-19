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

import { createCanvas, type FontFaceDescriptors, GlobalFonts, Image } from '../index'

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
GlobalFonts.register(scienceGothic, 'Slant Oblique 5', { style: 'Oblique  +5DEG' as FontFaceDescriptors['style'] })
GlobalFonts.register(scienceGothic, 'Slant Oblique 20', { style: 'oblique 20deg' })

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

test('declared oblique <angle>: slnt at the angle, skewed under 14deg', (t) => {
  const at5 = (font: string) => draw(font, undefined, '"slnt" -5').pixels
  t.deepEqual(draw('32px "Slant Oblique 5"').pixels, at5('32px "Slant Normal"'))
  t.deepEqual(draw('italic 32px "Slant Oblique 5"').pixels, at5('italic 32px "Slant Normal"'))
  // 20deg: past the axis like italic, and not skewed.
  t.deepEqual(draw('italic 32px "Slant Oblique 20"').pixels, draw('32px "Slant Italic"').pixels)
})

test('style keywords are ASCII case-insensitive', (t) => {
  // (Not "Descriptors ITALIC": family names fold case too.)
  t.truthy(GlobalFonts.register(robotoMono, 'Descriptors Upper', { style: 'ITALIC' as 'italic' }))
  t.deepEqual(draw('italic 32px "Descriptors Upper"').pixels, draw('italic 32px "Descriptors Italic"').pixels)
})

test('a missing field is the FontFace default; unknown keys are ignored', (t) => {
  t.truthy(GlobalFonts.register(robotoMono, 'Descriptors Empty', {}))
  t.truthy(GlobalFonts.register(robotoMono, 'Descriptors Typo', { wieght: 700 } as unknown as FontFaceDescriptors))
  const declared400 = draw('bold italic 32px "Descriptors 400"').pixels
  t.deepEqual(draw('bold italic 32px "Descriptors Empty"').pixels, declared400)
  t.deepEqual(draw('bold italic 32px "Descriptors Typo"').pixels, declared400)
})

test('invalid descriptors register nothing and give null', (t) => {
  const garamond = font('EBGaramond-Regular.ttf')
  const invalid: unknown[] = [
    { weight: Number.NaN },
    { weight: 0 },
    { weight: -100 },
    { weight: 1001 },
    // ConsumeFontWeight checks the double, before any float rounding.
    { weight: 1000.00001 },
    { weight: 0.9999999999 },
    { weight: Number.POSITIVE_INFINITY },
    // Every member is a DOMString: these are no font-weight or font-style.
    { weight: null },
    { weight: true },
    { style: null },
    { style: 14 },
    { style: ['italic', 'normal'] },
    { style: 'bold' },
    { style: '' },
    { style: 'oblique 91deg' },
    { style: 'oblique 10' },
    { style: 'oblique 5.deg' },
    { style: 'italic italic' },
    { weight: 400, style: 'Italics' },
    // Not parsed yet (Chrome takes a string weight).
    { weight: '700' },
  ]
  for (const [i, descriptors] of invalid.entries()) {
    const name = `Descriptors Invalid ${i}`
    t.is(GlobalFonts.register(garamond, name, descriptors as FontFaceDescriptors), null, JSON.stringify(descriptors))
    t.false(GlobalFonts.has(name))
  }
  t.truthy(GlobalFonts.register(garamond, 'Descriptors Edges', { weight: 1000, style: 'oblique -90deg' }))
  t.truthy(GlobalFonts.register(garamond, 'Descriptors Edges 1', { weight: 1, style: 'oblique .5deg' }))
  // FontSelectionValue(float): 1000, in range.
  t.truthy(GlobalFonts.register(garamond, 'Descriptors Edges 2', { weight: 999.9999999 }))
  // A style is ToString'd: ['italic'] is 'italic'.
  t.truthy(
    GlobalFonts.register(garamond, 'Descriptors Edges 3', { style: ['italic'] } as unknown as FontFaceDescriptors),
  )
})

test('declared values are kept in quarter steps', (t) => {
  // FontSelectionValue truncates the declared weight and angle, which are
  // then the wght and slnt coordinates.
  const oswald = font('Oswald.ttf')
  t.truthy(GlobalFonts.register(oswald, 'Quarter 300.5', { weight: 300.5 }))
  t.truthy(GlobalFonts.register(oswald, 'Quarter 300.7', { weight: 300.7 }))
  t.deepEqual(draw('32px "Quarter 300.7"').pixels, draw('32px "Quarter 300.5"').pixels)
  t.notDeepEqual(draw('32px "Quarter 300.7"').pixels, draw('32px "Descriptors Oswald"').pixels)
  t.truthy(GlobalFonts.register(scienceGothic, 'Quarter 5.7deg', { style: 'oblique 5.7deg' }))
  t.deepEqual(draw('32px "Quarter 5.7deg"').pixels, draw('32px "Slant Normal"', undefined, '"slnt" -5.5').pixels)
})

test('style takes any CSS angle, math functions and comments', (t) => {
  // ConsumeFontStyle with ConsumeAngle: the written number of a literal is
  // limited to [-90, 90], a math function is not.
  const styles: [string, string][] = [
    ['oblique calc(5deg)', 'Slant Oblique 5'],
    ['oblique /**/ 5deg', 'Slant Oblique 5'],
    ['oblique 1rad', 'Slant Italic'],
    ['oblique 2rad', 'Slant Italic'],
    ['oblique calc(100deg)', 'Slant Italic'],
    ['italic /**/', 'Slant Italic'],
  ]
  for (const [i, [style, same]] of styles.entries()) {
    const name = `Slant Angle ${i}`
    t.truthy(GlobalFonts.register(scienceGothic, name, { style: style as FontFaceDescriptors['style'] }), style)
    t.deepEqual(draw(`32px "${name}"`).pixels, draw(`32px "${same}"`).pixels, style)
  }
})

test('descriptors that are not an object throw a TypeError and register nothing', (t) => {
  const garamond = font('EBGaramond-Regular.ttf')
  for (const [i, descriptors] of [5, 'italic', true].entries()) {
    const name = `Descriptors Primitive ${i}`
    t.throws(() => GlobalFonts.register(garamond, name, descriptors as unknown as FontFaceDescriptors), {
      instanceOf: TypeError,
      message: "The provided value is not of type 'FontFaceDescriptors'.",
    })
    t.false(GlobalFonts.has(name))
  }
})

test('members convert as DOMStrings, style then weight; a Symbol throws a TypeError', (t) => {
  const garamond = font('EBGaramond-Regular.ttf')
  const read: string[] = []
  const descriptors = {
    get weight() {
      read.push('weight')
      return 400
    },
    get style() {
      read.push('style')
      return { toString: () => (read.push('toString'), 'italic') }
    },
  }
  t.truthy(GlobalFonts.register(garamond, 'Descriptors Getters', descriptors as unknown as FontFaceDescriptors))
  t.deepEqual(read, ['style', 'toString', 'weight'])
  for (const [key, i] of [
    ['style', 0],
    ['weight', 1],
  ] as const) {
    const name = `Descriptors Symbol ${i}`
    t.throws(() => GlobalFonts.register(garamond, name, { [key]: Symbol('x') } as unknown as FontFaceDescriptors), {
      instanceOf: TypeError,
      message: `Failed to read the '${key}' property from 'FontFaceDescriptors': Cannot convert a Symbol value to a string`,
    })
    t.false(GlobalFonts.has(name))
  }
})

test('descriptors stay with their name across a rebuild and go with a remove', (t) => {
  // RegisteredFontAssets counts the names with descriptors
  // (DeclaredDescriptors' check): a rebuild carries them, a remove drops them.
  const serif = font('SourceSerifPro-Regular.ttf')
  const declared = draw('bold 32px "Descriptors 400"').pixels
  const key = GlobalFonts.register(serif, 'Descriptors Removed', { weight: 700 })
  t.truthy(key)
  // Declared 700: bold is not emboldened.
  const unemboldened = draw('bold 32px "Descriptors Removed"').pixels
  t.deepEqual(unemboldened, draw('32px "Descriptors Removed"').pixels)
  t.true(GlobalFonts.remove(key!))
  t.deepEqual(draw('bold 32px "Descriptors 400"').pixels, declared)
  t.truthy(GlobalFonts.register(serif, 'Descriptors Removed'))
  t.notDeepEqual(draw('bold 32px "Descriptors Removed"').pixels, unemboldened)
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
  const family = "'Descriptors 400', 'Descriptors Oswald'"
  const alone = svgPixels(family, 'Ham')
  t.deepEqual(svgPixels(family, `Ham${DIGRAPHS}`), alone)
  // Declared 400: bold is emboldened, unlike `auto`.
  t.notDeepEqual(alone, svgPixels("'Descriptors Auto', 'Descriptors Oswald'", 'Ham'))
})
