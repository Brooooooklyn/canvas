// GlobalFonts.register's descriptors, as Blink draws a web font declared with
// them. The face is variable (wght 100-700); declared 400, bold is the 400
// instance emboldened, where `auto` draws the 700 instance. Each face takes
// the descriptors of the family name that matched it (CSSFontSelector looks
// one family up at a time), and its own variation coordinates. Chrome 159
// draws every equivalence here alike (FontFace with the same descriptors).

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { convertSVGTextToPath, createCanvas, type FontFaceDescriptors, GlobalFonts, Image } from '../index'

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
    // ConsumeFontWeight in font-face mode: no `bolder` / `lighter`, a
    // literal in [1, 1000], at most two values, no CSS-wide keywords.
    { weight: 'bolder' },
    { weight: 'lighter' },
    { weight: '0' },
    { weight: '1001' },
    { weight: '700 1001' },
    { weight: '700px' },
    { weight: '' },
    { weight: 'inherit' },
    { weight: 'initial' },
    { weight: 'var(--x)' },
    { weight: '100 900 500' },
    { weight: 'auto 700' },
    { weight: '700 auto' },
    { weight: 'bold 900' },
    // ToString: "1e+21", out of range.
    { weight: 1e21 },
    // ConsumeFontStyle in font-face mode.
    { style: 'italic 10deg' },
    { style: 'normal 10deg' },
    { style: 'oblique 91deg 10deg' },
    { style: 'oblique 10deg 91deg' },
    { style: 'oblique 10deg 20deg 30deg' },
    { style: 'oblique 10deg auto' },
    { style: 'oblique 10 20deg' },
    { style: 'oblique 0 20deg' },
    { style: 'auto auto' },
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
    // Font-relative units resolve against the initial 16px font.
    ['oblique calc(1em / 1px * 1deg)', 'Slant Italic'],
    ['oblique calc(80deg * 1px / 1em)', 'Slant Oblique 5'],
    ['italic /**/', 'Slant Italic'],
  ]
  for (const [i, [style, same]] of styles.entries()) {
    const name = `Slant Angle ${i}`
    t.truthy(GlobalFonts.register(scienceGothic, name, { style: style as FontFaceDescriptors['style'] }), style)
    t.deepEqual(draw(`32px "${name}"`).pixels, draw(`32px "${same}"`).pixels, style)
  }
})

// Registers `data` under `name` with `descriptors` and checks it took them.
function declare(t: import('ava').ExecutionContext, data: Buffer, name: string, descriptors: FontFaceDescriptors) {
  t.truthy(GlobalFonts.register(data, name, descriptors), `${name} ${JSON.stringify(descriptors)}`)
}

test('weight ranges clamp the wght and synthesize from their maximum', (t) => {
  // ClampAxisValue clamps the request to an explicit range;
  // CSSSegmentedFontFace emboldens when the range's maximum is under 600.
  declare(t, robotoMono, 'Range 100 900', { weight: '100 900' })
  declare(t, robotoMono, 'Range 900 100', { weight: '900 100' })
  declare(t, robotoMono, 'Range 100 500', { weight: '100 500' })
  declare(t, robotoMono, 'Range 500 700', { weight: '500 700' })
  declare(t, robotoMono, 'Range 300 300', { weight: '300 300' })
  declare(t, robotoMono, 'Range 500', { weight: 500 })
  declare(t, robotoMono, 'Range 300', { weight: 300 })
  const px = (font: string) => draw(font).pixels
  t.deepEqual(px('bold 32px "Range 100 900"'), px('bold 32px "Descriptors Auto"'))
  t.deepEqual(px('bold 32px "Range 900 100"'), px('bold 32px "Range 100 900"'))
  t.deepEqual(px('200 32px "Range 100 900"'), px('200 32px "Descriptors Auto"'))
  t.deepEqual(px('1 32px "Range 100 900"'), px('100 32px "Descriptors Auto"'))
  // 500 emboldened.
  const bold500 = px('bold 32px "Range 500"')
  t.deepEqual(px('bold 32px "Range 100 500"'), bold500)
  t.deepEqual(px('800 32px "Range 100 500"'), bold500)
  t.notDeepEqual(bold500, px('500 32px "Descriptors Auto"'))
  t.deepEqual(px('32px "Range 100 500"'), px('32px "Descriptors Auto"'))
  t.deepEqual(px('300 32px "Range 500 700"'), px('32px "Range 500"'))
  t.deepEqual(px('900 32px "Range 500 700"'), px('32px "Descriptors 700"'))
  t.deepEqual(px('600 32px "Range 500 700"'), px('600 32px "Descriptors Auto"'))
  t.deepEqual(px('32px "Range 300 300"'), px('32px "Range 300"'))
  t.deepEqual(px('32px "Range 300"'), px('300 32px "Descriptors Auto"'))
})

test('a static face is emboldened only when its range stays under 600', (t) => {
  const lato = font('Lato-Regular.ttf')
  declare(t, lato, 'Lato 100 900', { weight: '100 900' })
  declare(t, lato, 'Lato 100 500', { weight: '100 500' })
  declare(t, lato, 'Lato 400', { weight: 400 })
  const px = (font: string) => draw(font).pixels
  t.deepEqual(px('bold 32px "Lato 100 900"'), px('32px "Descriptors Lato"'))
  t.notDeepEqual(px('bold 32px "Lato 100 900"'), px('bold 32px "Descriptors Lato"'))
  t.deepEqual(px('bold 32px "Lato 100 500"'), px('bold 32px "Lato 400"'))
})

test('style ranges clamp the slnt and skew from their maximum', (t) => {
  declare(t, scienceGothic, 'Slant 0 20', { style: 'oblique 0deg 20deg' })
  declare(t, scienceGothic, 'Slant 20 0', { style: 'oblique 20deg 0deg' })
  declare(t, scienceGothic, 'Slant 0 10', { style: 'oblique 0deg 10deg' })
  declare(t, scienceGothic, 'Slant 10', { style: 'oblique 10deg' })
  declare(t, scienceGothic, 'Slant 5 8', { style: 'oblique 5deg 8deg' })
  declare(t, scienceGothic, 'Slant 7', { style: 'oblique 7deg' })
  declare(t, scienceGothic, 'Slant 8', { style: 'oblique 8deg' })
  declare(t, scienceGothic, 'Slant -10 10', { style: 'oblique -10deg 10deg' })
  declare(t, scienceGothic, 'Slant 0 0', { style: 'oblique 0deg 0deg' })
  declare(t, scienceGothic, 'Slant calc 8', { style: 'oblique calc(5deg + 2deg) 8deg' })
  declare(t, scienceGothic, 'Slant 7 8', { style: 'OBLIQUE 7DEG 8DEG' as FontFaceDescriptors['style'] })
  const px = (font: string) => draw(font).pixels
  // slnt -14, clamped to the axis' -10; a maximum of 14 or more: no skew.
  const slanted = px('32px "Slant Italic"')
  t.deepEqual(px('italic 32px "Slant 0 20"'), slanted)
  t.deepEqual(px('italic 32px "Slant Auto"'), slanted)
  t.deepEqual(px('italic 32px "Slant 20 0"'), slanted)
  t.deepEqual(px('32px "Slant 0 20"'), px('32px "Slant Normal"'))
  // A maximum under 14: slnt -10 and skewed.
  t.deepEqual(px('italic 32px "Slant 0 10"'), px('italic 32px "Slant 10"'))
  t.notDeepEqual(px('italic 32px "Slant 0 10"'), px('32px "Slant 10"'))
  t.deepEqual(px('oblique 7deg 32px "Slant 5 8"'), px('32px "Slant 7"'))
  t.deepEqual(px('italic 32px "Slant 5 8"'), px('italic 32px "Slant 8"'))
  t.deepEqual(px('32px "Slant 5 8"'), px('32px "Slant Oblique 5"'))
  t.deepEqual(px('32px "Slant -10 10"'), px('32px "Slant Normal"'))
  t.deepEqual(px('oblique 5deg 32px "Slant -10 10"'), px('32px "Slant Oblique 5"'))
  t.deepEqual(px('italic 32px "Slant 0 0"'), px('italic 32px "Slant Normal"'))
  t.deepEqual(px('32px "Slant calc 8"'), px('32px "Slant 7"'))
  t.deepEqual(px('italic 32px "Slant calc 8"'), px('italic 32px "Slant 7 8"'))
})

test('a calc() weight outside [1, 1000] makes every descriptor auto', (t) => {
  // GetFontSelectionCapabilities returns normal_capabilities: the style is
  // dropped too.
  declare(t, scienceGothic, 'Reset Italic', { weight: 'calc(2000)', style: 'italic' })
  declare(t, robotoMono, 'Reset Range', { weight: 'calc(-5) 700' })
  declare(t, robotoMono, 'Reset Small', { weight: 'calc(0.5)' })
  const px = (font: string) => draw(font).pixels
  t.deepEqual(px('32px "Reset Italic"'), px('32px "Slant Auto"'))
  t.notDeepEqual(px('32px "Reset Italic"'), px('32px "Slant Italic"'))
  t.deepEqual(px('italic 32px "Reset Italic"'), px('italic 32px "Slant Auto"'))
  for (const name of ['Reset Range', 'Reset Small']) {
    t.deepEqual(px(`32px "${name}"`), px('32px "Descriptors Auto"'), name)
    t.deepEqual(px(`bold 32px "${name}"`), px('bold 32px "Descriptors Auto"'), name)
  }
  // Only `from < 1` and `to > 1000` reset a range: [500, 2000].
  declare(t, robotoMono, 'Range calc 500', { weight: 'calc(2000) 500' })
  t.deepEqual(px('300 32px "Range calc 500"'), px('500 32px "Descriptors Auto"'))
  t.deepEqual(px('bold 32px "Range calc 500"'), px('32px "Descriptors 700"'))
})

test('auto per descriptor: that field follows the axes, the other is declared', (t) => {
  declare(t, robotoMono, 'Weight Auto', { weight: 'auto' })
  declare(t, scienceGothic, 'Slant Weight Auto', { weight: 'auto' })
  declare(t, scienceGothic, 'Slant Style Auto', { style: 'auto' })
  declare(t, scienceGothic, 'Slant Style AUTO', { style: 'AUTO' as 'auto' })
  const px = (font: string) => draw(font).pixels
  t.deepEqual(px('bold 32px "Weight Auto"'), px('bold 32px "Descriptors Auto"'))
  // The default style is `normal`: italic is the slnt 0 instance skewed.
  t.deepEqual(px('bold 32px "Slant Weight Auto"'), px('bold 32px "Slant Auto"'))
  t.deepEqual(px('italic 32px "Slant Weight Auto"'), px('italic 32px "Slant Normal"'))
  // The default weight is `normal`: bold is the 400 instance emboldened.
  for (const name of ['Slant Style Auto', 'Slant Style AUTO']) {
    t.deepEqual(px(`italic 32px "${name}"`), px('italic 32px "Slant Auto"'), name)
    t.deepEqual(px(`bold 32px "${name}"`), px('bold 32px "Slant Normal"'), name)
    t.notDeepEqual(px(`bold 32px "${name}"`), px('bold 32px "Slant Auto"'), name)
  }
})

test('weight strings are CSS: keywords, numbers, calc(); numbers are ToString-ed', (t) => {
  const px = (font: string) => draw(font).pixels
  const weights: [unknown, string][] = [
    ['700', '32px "Descriptors 700"'],
    ['bold', '32px "Descriptors 700"'],
    ['BOLD', '32px "Descriptors 700"'],
    [' 700 ', '32px "Descriptors 700"'],
    ['+700', '32px "Descriptors 700"'],
    ['700.0', '32px "Descriptors 700"'],
    ['calc(350 + 350)', '32px "Descriptors 700"'],
    ['/**/700', '32px "Descriptors 700"'],
    ['normal', 'bold 32px "Descriptors 400"'],
    ['400', 'bold 32px "Descriptors 400"'],
    ['1e3', '1000 32px "Descriptors Auto"'],
    [1000, '1000 32px "Descriptors Auto"'],
    // An object's toString: the range.
    [{ toString: () => '100 900' }, 'bold 32px "Descriptors Auto"'],
  ]
  for (const [i, [weight, same]] of weights.entries()) {
    const name = `Weight String ${i}`
    declare(t, robotoMono, name, { weight } as FontFaceDescriptors)
    const request = same.startsWith('32px') ? '32px' : same.split(' 32px')[0] + ' 32px'
    t.deepEqual(px(`${request} "${name}"`), px(same), String(weight))
  }
  // An all-auto object is no descriptors.
  declare(t, robotoMono, 'Weight All Auto', { weight: 'auto', style: 'auto' })
  t.deepEqual(px('bold 32px "Weight All Auto"'), px('bold 32px "Descriptors Auto"'))
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

test('the font data is read after the descriptors convert', (t) => {
  // FontFace::Create reads the source's ByteSpan() after the bindings
  // converted the descriptors: a getter that detaches the buffer leaves no
  // data (status 'error'), one that shrinks it leaves the bytes it keeps.
  const lato = font('Lato-Regular.ttf')
  const detach: [string, (data: Uint8Array) => unknown][] = [
    ['transfer', (data) => data.buffer.transfer()],
    ['structuredClone', (data) => structuredClone(data, { transfer: [data.buffer] })],
  ]
  for (const [how, detachData] of detach) {
    const data = new Uint8Array(lato)
    const name = `Descriptors Detached ${how}`
    const descriptors = {
      get weight() {
        detachData(data)
        return 400
      },
    }
    t.is(GlobalFonts.register(data, name, descriptors), null, how)
    t.true(data.buffer.detached, how)
    t.false(GlobalFonts.has(name), how)
  }
  const buffer = new ArrayBuffer(lato.length, { maxByteLength: lato.length })
  const data = new Uint8Array(buffer)
  data.set(lato)
  const descriptors = {
    get weight() {
      buffer.resize(16)
      return 400
    },
  }
  t.is(GlobalFonts.register(data, 'Descriptors Shrunk', descriptors), null)
  t.false(GlobalFonts.has('Descriptors Shrunk'))
})

// The layout counters of skiac_debug_text_line (cumulative per collection).
type LineCounters = { familyInstanceFaces: number; requestInstanceFaces: number; descriptorLookups: number }
function lineCounters(font: string, text: string): LineCounters {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = font
  return JSON.parse((ctx as unknown as { __debugTextLine(text: string): string }).__debugTextLine(text))
}

// The instances one cold layout (a new text) of `font` looked up: at the
// request's coordinates for the whole list (ResolveLineFaces) and a family
// entry's own (FamilyFaces).
function instanceDelta(font: string, text: string) {
  const before = lineCounters('32px "Descriptors Lato"', `${text} (before)`)
  const after = lineCounters(font, text)
  return {
    request: after.requestInstanceFaces - before.requestInstanceFaces,
    family: after.familyInstanceFaces - before.familyInstanceFaces,
  }
}

// The faces the list adds after its families: the standard font, when the
// host has one (FontFallbackList::GetFontData's -webkit-standard).
function standardFaces(t: import('ava').ExecutionContext, text: string) {
  const standard = instanceDelta('32px "Descriptors Auto"', text).request - 1
  t.true(standard === 0 || standard === 1, `standard faces ${standard}`)
  return standard
}

test('a face with its own descriptors is the only face cloned at its coordinates', (t) => {
  // Six faces (one file padded apart), each declared with its own weight: a
  // cold layout looks up one instance per face, not every matched face at
  // each face's coordinates (36 and more).
  const names = Array.from({ length: 6 }, (_, i) => {
    const name = `Descriptors Own Instance ${i}`
    const data = Buffer.concat([robotoMono, Buffer.alloc(4 * (i + 1))])
    t.truthy(GlobalFonts.register(data, name, { weight: 100 + 100 * i }))
    return `"${name}"`
  })
  // The registrations dropped the caches: the layout of the list is cold.
  const delta = instanceDelta(`32px ${names.join(', ')}`, 'Own instances')
  t.is(delta.family, 6)
  // None is also cloned at the request's coordinates; only the standard
  // font (no descriptors) is.
  t.is(delta.request, standardFaces(t, 'Own instances standard'))
})

test('the debug line reports its instance and descriptor lookups', (t) => {
  const counters = lineCounters('32px "Descriptors 400"', 'Counters')
  t.is(typeof counters.requestInstanceFaces, 'number')
  t.is(typeof counters.descriptorLookups, 'number')
  t.is(typeof counters.familyInstanceFaces, 'number')
})

test('request instances: one per matched face without its own', (t) => {
  // A face with descriptors gets only its own instance (FamilyFaces); the
  // others take the request's coordinates, one lookup each.
  const standard = standardFaces(t, 'Request standard')
  t.deepEqual(instanceDelta('32px "Descriptors 400", "Descriptors Oswald"', 'Request 400 Oswald'), {
    request: 1 + standard,
    family: 1,
  })
  // No face has its own: one lookup of the whole list, as before.
  t.deepEqual(instanceDelta('32px "Descriptors Auto", "Descriptors Oswald"', 'Request Auto Oswald'), {
    request: 2 + standard,
    family: 0,
  })
})

// A child process (its own counters): fonts with no descriptors, drawn
// through every DeclaredDescriptors caller (font list, font-size-adjust,
// SVG text), then one declared face.
const NO_DESCRIPTORS_PROBE = `
  const { readFileSync } = require('fs')
  const { createCanvas, GlobalFonts, Image, setTextRenderer } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_DIR, PROBE_FONTS } = process.env
  setTextRenderer(RENDERER)
  const font = (name) => readFileSync(PROBE_FONTS + '/' + name)
  const out = { loaded: GlobalFonts.loadFontsFromDir(PROBE_DIR), keys: [] }
  out.keys.push(GlobalFonts.register(font('RobotoMono-VariableFont_wght.ttf'), 'Guard Mono'))
  out.keys.push(GlobalFonts.register(font('Oswald.ttf'), 'Guard Oswald', null))
  out.keys.push(GlobalFonts.register(font('Lato-Regular.ttf')))
  out.keys.push(GlobalFonts.registerFromPath(PROBE_FONTS + '/ScienceGothic-VariableFont.ttf', 'Guard Slant'))
  const FONTS = [
    '32px "Guard Mono"', 'bold 32px "Guard Mono", serif', 'italic 32px "Guard Slant"',
    '300 32px "Guard Oswald", "Guard Mono"', '32px Lato', 'bold italic 32px Lato, "Source Serif Pro"',
    '32px "Source Serif Pro"', '32px sans-serif', '32px monospace', '32px NoSuchFamily, "Guard Oswald"',
  ]
  const ctx = createCanvas(400, 60).getContext('2d')
  const counters = (text) => JSON.parse(ctx.__debugTextLine(text))
  for (let i = 0; i < 50; ++i) {
    ctx.font = FONTS[i % FONTS.length]
    ctx.fontSizeAdjust = i % 3 === 0 ? '0.5' : 'none'
    ctx.fillText('Line ' + i + ' Hamburgefonts ΑΒΓ ǅǄ', 10, 40)
  }
  ctx.fontSizeAdjust = 'none'
  for (const family of ['Guard Mono', 'Guard Slant', 'Lato', 'Source Serif Pro']) {
    const img = new Image()
    img.src = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="10" y="44" font-family="' + family + '" font-weight="bold" font-size="32">Ham</text></svg>')
    ctx.drawImage(img, 0, 0)
  }
  out.none = counters('Line done')
  out.keys.push(GlobalFonts.register(font('RobotoMono-VariableFont_wght.ttf'), 'Guard Declared', { weight: 400 }))
  ctx.font = 'bold 32px "Guard Declared"'
  out.declared = counters('Line declared')
  console.log(JSON.stringify(out))`

for (const renderer of ['portable', 'system'] as const) {
  test(`no font with descriptors: no descriptor lookup (${renderer})`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-no-descriptors-'))
    t.teardown(() => rmSync(dir, { recursive: true, force: true }))
    copyFileSync(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), join(dir, 'SourceSerifPro-Regular.ttf'))
    const child = spawnSync(process.execPath, ['-e', NO_DESCRIPTORS_PROBE], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        RENDERER: renderer,
        PROBE_DIR: dir,
        PROBE_FONTS: join(__dirname, 'fonts'),
        PROBE_INDEX: join(__dirname, '..', 'index.js'),
      },
    })
    t.is(child.status, 0, child.stderr)
    const out = JSON.parse(child.stdout)
    t.is(out.loaded, 1)
    t.true(
      out.keys.every((key: unknown) => key !== null),
      `keys ${out.keys}`,
    )
    t.is(out.none.descriptorLookups, 0)
    // The counter counts: a declared face is looked up.
    t.true(out.declared.descriptorLookups > 0)
  })
}

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

// setAlias lists the face of its target under the alias: the face has the
// target's descriptors there, looked up through the alias at draw time, so
// along a chain and after the target is declared again.
test('setAlias of a declared name takes its descriptors', (t) => {
  const declared = draw('bold 32px "Descriptors 400"').pixels
  t.notDeepEqual(declared, draw('bold 32px "Descriptors Auto"').pixels)
  t.true(GlobalFonts.setAlias('Descriptors 400', 'Alias 400'))
  t.deepEqual(draw('bold 32px "Alias 400"').pixels, declared)
  t.deepEqual(draw('bold 32px "alias 400"').pixels, declared)
  // After an auto face: the alias face draws the Greek with its descriptors.
  t.deepEqual(
    draw('bold 32px "Descriptors Lato", "Alias 400"', GREEK).pixels,
    draw('bold 32px "Descriptors 400"', GREEK).pixels,
  )
  t.true(GlobalFonts.setAlias('Descriptors Italic', 'Alias Italic'))
  t.deepEqual(draw('italic 32px "Alias Italic"').pixels, draw('32px "Descriptors Auto"').pixels)
})

test('setAlias of an alias takes the descriptors at the end of the chain', (t) => {
  const declared = draw('bold 32px "Descriptors 400"').pixels
  t.true(GlobalFonts.setAlias('Descriptors 400', 'Alias Chain 1'))
  t.true(GlobalFonts.setAlias('Alias Chain 1', 'Alias Chain 2'))
  t.deepEqual(draw('bold 32px "Alias Chain 2"').pixels, declared)
  // A loop back to a name in the chain changes nothing.
  t.true(GlobalFonts.setAlias('Alias Chain 2', 'Alias Chain 1'))
  t.deepEqual(draw('bold 32px "Alias Chain 1"').pixels, declared)
  t.deepEqual(draw('bold 32px "Alias Chain 2"').pixels, declared)
  // A loop of aliases of an auto name ends: auto.
  t.true(GlobalFonts.setAlias('Descriptors Auto', 'Alias Loop 1'))
  t.true(GlobalFonts.setAlias('Alias Loop 1', 'Alias Loop 2'))
  t.true(GlobalFonts.setAlias('Alias Loop 2', 'Alias Loop 1'))
  t.deepEqual(draw('bold 32px "Alias Loop 1", "Alias Loop 2"').pixels, draw('bold 32px "Descriptors Auto"').pixels)
  // A rebuild (an unrelated remove) makes the faces and aliases again.
  const key = GlobalFonts.register(Buffer.concat([robotoMono, Buffer.alloc(96)]), 'Alias Chain Removed')
  t.truthy(key)
  t.true(GlobalFonts.remove(key!))
  t.deepEqual(draw('bold 32px "Alias Chain 2"').pixels, declared)
})

test('an alias keeps the face it named when its target is declared again', (t) => {
  // Own bytes: no other name shares the registration.
  const data = Buffer.concat([robotoMono, Buffer.alloc(64)])
  const key400 = GlobalFonts.register(data, 'Redeclare', { weight: 400 })
  t.truthy(key400)
  t.true(GlobalFonts.setAlias('Redeclare', 'Redeclare Alias'))
  const declared400 = draw('bold 32px "Descriptors 400"').pixels
  t.deepEqual(draw('bold 32px "Redeclare Alias"').pixels, declared400)
  // A second declaration is a face of its own (a FontKey of its own); the
  // alias lists the face it named, whose descriptors stay {400}.
  const key700 = GlobalFonts.register(data, 'Redeclare', { weight: 700 })
  t.truthy(key700)
  t.not(key700!.typefaceId, key400!.typefaceId)
  t.deepEqual(draw('bold 32px "Redeclare Alias"').pixels, declared400)
})

test('SVG text: an alias takes its target descriptors', (t) => {
  t.true(GlobalFonts.setAlias('Descriptors 400', 'Alias SVG 400'))
  const declared = svgPixels("'Descriptors 400'", 'Ham')
  t.notDeepEqual(declared, svgPixels("'Descriptors Auto'", 'Ham'))
  t.deepEqual(svgPixels("'Alias SVG 400'", 'Ham'), declared)
  // convertSVGTextToPath: the attribute names one family (MatchNamedFamily).
  const paths = (family: string) =>
    convertSVGTextToPath(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="10" y="44" font-family="${family}" font-weight="bold" font-size="32">Ham</text></svg>`,
    )
      .toString()
      .match(/ d="[^"]*"/g)
  const declaredPaths = paths('Descriptors 400')
  t.truthy(declaredPaths)
  t.notDeepEqual(declaredPaths, paths('Descriptors Auto'))
  t.deepEqual(paths('Alias SVG 400'), declaredPaths)
})

// One FontKey per declaration: the same bytes registered again under a name
// with other descriptors are a face of their own, as a second FontFace of
// that family is (FontFaceCache::Add keeps both); the same declaration again
// is the same face, and another name is the same registration.
test('the same bytes declared again with other descriptors are a face of their own', (t) => {
  // Own bytes: no other name shares the registrations.
  const data = Buffer.concat([robotoMono, Buffer.alloc(128)])
  const key400 = GlobalFonts.register(data, 'Twin', { weight: 400 })
  const key700 = GlobalFonts.register(data, 'Twin', { weight: '700' })
  t.truthy(key400)
  t.truthy(key700)
  t.not(key700!.typefaceId, key400!.typefaceId)
  t.is(GlobalFonts.register(data, 'Twin', { weight: 700 })?.typefaceId, key700!.typefaceId)
  t.is(GlobalFonts.register(data, 'twin', { weight: 400 })?.typefaceId, key400!.typefaceId)
  // `auto` is a declaration too.
  const keyAuto = GlobalFonts.register(data, 'Twin')
  t.truthy(keyAuto)
  t.not(keyAuto!.typefaceId, key400!.typefaceId)
  t.not(keyAuto!.typefaceId, key700!.typefaceId)
  t.is(GlobalFonts.register(data, 'Twin Other')?.typefaceId, key400!.typefaceId)
  // Removing a declaration keeps the others.
  t.true(GlobalFonts.remove(key700!))
  t.true(GlobalFonts.remove(keyAuto!))
  t.true(GlobalFonts.has('Twin'))
  t.deepEqual(draw('32px "Twin"').pixels, draw('32px "Descriptors 400"').pixels)
  t.deepEqual(draw('bold 32px "Twin"').pixels, draw('bold 32px "Descriptors 400"').pixels)
  t.true(GlobalFonts.remove(key400!))
  t.false(GlobalFonts.has('Twin'))
  t.false(GlobalFonts.has('Twin Other'))
})

test('removing the first declaration keeps the face declared after it', (t) => {
  const data = Buffer.concat([robotoMono, Buffer.alloc(192)])
  const key400 = GlobalFonts.register(data, 'Twin Later', { weight: 400 })
  const key700 = GlobalFonts.register(data, 'Twin Later', { weight: 700 })
  t.truthy(key400)
  t.truthy(key700)
  t.true(GlobalFonts.remove(key400!))
  t.true(GlobalFonts.has('Twin Later'))
  const declared700 = draw('32px "Descriptors 700"').pixels
  t.deepEqual(draw('32px "Twin Later"').pixels, declared700)
  t.deepEqual(draw('bold 32px "Twin Later"').pixels, declared700)
  t.true(GlobalFonts.remove(key700!))
  t.false(GlobalFonts.has('Twin Later'))
})

// A child process: both declarations of one file stay faces of their own
// across a rebuild (an unrelated remove) and a renderer switch; the face
// listing that only names the file's own family is no declaration.
const TWIN_PROBE = `
  const { readFileSync } = require('fs')
  const { createCanvas, GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_FONTS } = process.env
  setTextRenderer(RENDERER)
  const font = (name) => readFileSync(PROBE_FONTS + '/' + name)
  const pixels = (font) => {
    const ctx = createCanvas(420, 60).getContext('2d')
    ctx.font = font
    ctx.fillText('Hamburgefonts', 10, 42)
    return Buffer.from(ctx.getImageData(0, 0, 420, 60).data).toString('base64')
  }
  const styles = (name) => {
    const family = JSON.parse(GlobalFonts.getFamilies().toString()).find((f) => f.family === name)
    return family ? family.styles.length : 0
  }
  const out = {}
  // register(V, 'F') lists V under its own family too; a call with that
  // family and descriptors is the first declaration of it.
  const oswald = font('Oswald.ttf')
  const guard = [GlobalFonts.register(oswald, 'Guard F'), GlobalFonts.register(oswald, undefined, { weight: 700 })]
  out.guardSameKey = guard[0].typefaceId === guard[1].typefaceId
  out.guardDraws700 = pixels('40px Oswald') === pixels('700 40px "Guard F"')
  const mono = font('RobotoMono-VariableFont_wght.ttf')
  // Own bytes: the V{700} reference.
  GlobalFonts.register(Buffer.concat([mono, Buffer.alloc(64)]), 'Ref 700', { weight: 700 })
  const key400 = GlobalFonts.register(mono, 'M', { weight: 400 })
  const key700 = GlobalFonts.register(mono, 'M', { weight: 700 })
  out.keysDiffer = key400.typefaceId !== key700.typefaceId
  out.styles = [styles('M')]
  GlobalFonts.remove(GlobalFonts.registerFromPath(PROBE_FONTS + '/Lato-Regular.ttf', 'Unrelated'))
  out.styles.push(styles('M'))
  setTextRenderer(RENDERER === 'system' ? 'portable' : 'system')
  setTextRenderer(RENDERER)
  out.styles.push(styles('M'))
  // The rebuilds listed both registrations of the bytes again.
  out.sameAgain = [
    GlobalFonts.register(mono, 'M', { weight: 400 }).typefaceId === key400.typefaceId,
    GlobalFonts.register(mono, 'M', { weight: 700 }).typefaceId === key700.typefaceId,
  ]
  out.removed400 = GlobalFonts.remove(key400)
  out.has = [GlobalFonts.has('M')]
  out.draws700 = pixels('40px M') === pixels('40px "Ref 700"') && pixels('bold 40px M') === pixels('40px "Ref 700"')
  out.removed700 = GlobalFonts.remove(key700)
  out.has.push(GlobalFonts.has('M'))
  console.log(JSON.stringify(out))`

for (const renderer of ['portable', 'system'] as const) {
  test(`declarations of one file keep their FontKeys across a rebuild and a switch (${renderer})`, (t) => {
    const child = spawnSync(process.execPath, ['-e', TWIN_PROBE], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        RENDERER: renderer,
        PROBE_FONTS: join(__dirname, 'fonts'),
        PROBE_INDEX: join(__dirname, '..', 'index.js'),
      },
    })
    t.is(child.status, 0, child.stderr)
    t.deepEqual(JSON.parse(child.stdout), {
      guardSameKey: true,
      guardDraws700: true,
      keysDiffer: true,
      styles: [2, 2, 2],
      sameAgain: [true, true],
      removed400: true,
      has: [true, false],
      draws700: true,
      removed700: true,
    })
  })
}

// A child process: a declaration twin made and removed again and again
// frees its face (it shares the bytes of the first declaration).
const TWIN_MEMORY_PROBE = `
  const { readFileSync } = require('fs')
  const { createCanvas, GlobalFonts } = require(process.env.PROBE_INDEX)
  const mono = readFileSync(process.env.PROBE_FONTS + '/RobotoMono-VariableFont_wght.ttf')
  GlobalFonts.register(mono, 'Mem', { weight: 400 })
  const ctx = createCanvas(200, 60).getContext('2d')
  const round = async (n) => {
    for (let i = 0; i < n; ++i) {
      const key = GlobalFonts.register(mono, 'Mem', { weight: 700 })
      ctx.font = 'bold 32px Mem'
      ctx.fillText('Ham ' + i, 10, 40)
      GlobalFonts.remove(key)
      await new Promise(setImmediate)
    }
    gc()
    return process.memoryUsage().rss / 1048576
  }
  ;(async () => {
    const rss = [await round(20), await round(200)]
    console.log(JSON.stringify({ rss, size: mono.length }))
  })()`

test('a declaration twin made and removed 200 times does not grow RSS', (t) => {
  const child = spawnSync(process.execPath, ['--expose-gc', '-e', TWIN_MEMORY_PROBE], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, PROBE_FONTS: join(__dirname, 'fonts'), PROBE_INDEX: join(__dirname, '..', 'index.js') },
  })
  t.is(child.status, 0, child.stderr)
  const { rss } = JSON.parse(child.stdout)
  t.true(rss[1] - rss[0] < 20, `RSS MB after 20, then 200 more: ${rss.map((v: number) => v.toFixed(1)).join(', ')}`)
})

// registerFromPath takes the same descriptors as register; a declaration of
// the same path under the same name with other descriptors is a face of its
// own (FontFaceCache::Add keeps every FontFace of a family).
test('registerFromPath declares the face with its descriptors', (t) => {
  const path = join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf')
  const key = GlobalFonts.registerFromPath(path, 'Path 400', { weight: 400 })
  t.truthy(key)
  const bold400 = draw('bold 32px "Descriptors 400"').pixels
  t.deepEqual(draw('bold 32px "Path 400"').pixels, bold400)
  t.notDeepEqual(bold400, draw('bold 32px "Descriptors Auto"').pixels)
  t.is(GlobalFonts.registerFromPath(path, 'Path Bad', { weight: 'bolder' }), null)
  t.false(GlobalFonts.has('Path Bad'))
  for (const [i, descriptors] of [1, 'italic'].entries()) {
    const name = `Path Primitive ${i}`
    t.throws(() => GlobalFonts.registerFromPath(path, name, descriptors as unknown as FontFaceDescriptors), {
      instanceOf: TypeError,
      message: "The provided value is not of type 'FontFaceDescriptors'.",
    })
    t.false(GlobalFonts.has(name))
  }
})

test('the same path declared again with other descriptors is a face of its own', (t) => {
  // Its own path: no other name shares the registrations.
  const dir = mkdtempSync(join(tmpdir(), 'canvas-path-twin-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'PathTwin.ttf')
  copyFileSync(join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf'), path)
  const key400 = GlobalFonts.registerFromPath(path, 'Path Twin', { weight: 400 })
  const key700 = GlobalFonts.registerFromPath(path, 'Path Twin', { weight: '700' })
  t.truthy(key400)
  t.truthy(key700)
  t.not(key700!.typefaceId, key400!.typefaceId)
  t.is(GlobalFonts.registerFromPath(path, 'Path Twin', { weight: 700 })?.typefaceId, key700!.typefaceId)
  t.is(GlobalFonts.registerFromPath(path, 'path twin', { weight: 400 })?.typefaceId, key400!.typefaceId)
  t.is(GlobalFonts.registerFromPath(path, 'Path Twin Other')?.typefaceId, key400!.typefaceId)
  t.true(GlobalFonts.remove(key700!))
  t.true(GlobalFonts.has('Path Twin'))
  t.deepEqual(draw('32px "Path Twin"').pixels, draw('32px "Descriptors 400"').pixels)
  t.deepEqual(draw('bold 32px "Path Twin"').pixels, draw('bold 32px "Descriptors 400"').pixels)
  t.true(GlobalFonts.remove(key400!))
  t.false(GlobalFonts.has('Path Twin'))
  t.false(GlobalFonts.has('Path Twin Other'))
})

// A child process: a file loadFontsFromDir loaded is an installed font and
// takes no descriptors, so registerFromPath of it with descriptors makes a
// twin (one more face of its family); without them it is the installed
// registration, as before. Path twins keep their FontKeys across a rebuild
// (an unrelated remove) and a renderer switch.
const PATH_TWIN_PROBE = `
  const { GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_DIR, PROBE_TWIN, PROBE_FONTS } = process.env
  setTextRenderer(RENDERER)
  const styles = (name) => {
    const family = JSON.parse(GlobalFonts.getFamilies().toString()).find((f) => f.family === name)
    return family ? family.styles.length : 0
  }
  const out = {}
  const preloaded = PROBE_DIR + '/RobotoMono-VariableFont_wght.ttf'
  out.loaded = GlobalFonts.loadFontsFromDir(PROBE_DIR)
  const before = styles('Roboto Mono')
  const plain = GlobalFonts.registerFromPath(preloaded)
  out.plainStyles = styles('Roboto Mono') - before
  const twin = GlobalFonts.registerFromPath(preloaded, undefined, { weight: 400 })
  out.twinStyles = styles('Roboto Mono') - before
  out.twinKey = twin !== null && twin.typefaceId !== plain.typefaceId
  out.twinAgain = GlobalFonts.registerFromPath(preloaded, undefined, { weight: 400 }).typefaceId === twin.typefaceId
  out.plainAgain = GlobalFonts.registerFromPath(preloaded).typefaceId === plain.typefaceId
  const path = PROBE_TWIN
  const key400 = GlobalFonts.registerFromPath(path, 'PT', { weight: 400 })
  const key700 = GlobalFonts.registerFromPath(path, 'PT', { weight: 700 })
  out.keysDiffer = key400.typefaceId !== key700.typefaceId
  out.styles = [styles('PT')]
  GlobalFonts.remove(GlobalFonts.registerFromPath(PROBE_FONTS + '/Lato-Regular.ttf', 'Unrelated'))
  out.styles.push(styles('PT'))
  setTextRenderer(RENDERER === 'system' ? 'portable' : 'system')
  setTextRenderer(RENDERER)
  out.styles.push(styles('PT'))
  out.sameAgain = [
    GlobalFonts.registerFromPath(path, 'PT', { weight: 400 }).typefaceId === key400.typefaceId,
    GlobalFonts.registerFromPath(path, 'PT', { weight: 700 }).typefaceId === key700.typefaceId,
    GlobalFonts.registerFromPath(preloaded, undefined, { weight: 400 }).typefaceId === twin.typefaceId,
  ]
  out.removedTwin = GlobalFonts.remove(twin)
  out.afterRemove = styles('Roboto Mono') - before
  console.log(JSON.stringify(out))`

for (const renderer of ['portable', 'system'] as const) {
  test(`registerFromPath of a preloaded file with descriptors makes a twin (${renderer})`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-path-descriptors-'))
    const twinDir = mkdtempSync(join(tmpdir(), 'canvas-path-twin-'))
    t.teardown(() => {
      rmSync(dir, { recursive: true, force: true })
      rmSync(twinDir, { recursive: true, force: true })
    })
    const mono = join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf')
    copyFileSync(mono, join(dir, 'RobotoMono-VariableFont_wght.ttf'))
    // Another family: the twin's count stays its own.
    copyFileSync(join(__dirname, 'fonts', 'Oswald.ttf'), join(twinDir, 'PathTwin.ttf'))
    const child = spawnSync(process.execPath, ['-e', PATH_TWIN_PROBE], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        RENDERER: renderer,
        PROBE_DIR: dir,
        PROBE_TWIN: join(twinDir, 'PathTwin.ttf'),
        PROBE_FONTS: join(__dirname, 'fonts'),
        PROBE_INDEX: join(__dirname, '..', 'index.js'),
      },
    })
    t.is(child.status, 0, child.stderr)
    t.deepEqual(JSON.parse(child.stdout), {
      loaded: 1,
      plainStyles: 0,
      twinStyles: 1,
      twinKey: true,
      twinAgain: true,
      plainAgain: true,
      keysDiffer: true,
      styles: [2, 2, 2],
      sameAgain: [true, true, true],
      removedTwin: true,
      afterRemove: 0,
    })
  })
}

// A child process: a face a register / registerFromPath call gave the name
// of a family loadFontsFromDir loaded is a FontFace of that name. Chrome
// asks FontFaceCache first for a non-generic name and the font cache only
// when it has no face (CSSFontSelector::GetFontData), so the explicit name
// draws the registered face alone, with its descriptors, whatever installed
// faces the family has; after remove the installed faces draw again. The
// own family a call with another alias lists the face under is no FontFace
// (FontFaceCache keeps a face in the one family it was given), so it does
// not shadow the installed faces.
const CALL_NAME_PROBE = `
  const { readFileSync } = require('fs')
  const { createCanvas, GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_DIR, PROBE_FONTS } = process.env
  setTextRenderer(RENDERER)
  const font = (name) => readFileSync(PROBE_FONTS + '/' + name)
  const pixels = (font) => {
    const ctx = createCanvas(420, 60).getContext('2d')
    ctx.font = font
    ctx.fillText('Hamburgefonts', 10, 42)
    return Buffer.from(ctx.getImageData(0, 0, 420, 60).data).toString('base64')
  }
  const out = { loaded: GlobalFonts.loadFontsFromDir(PROBE_DIR) }
  const MONO = 'bold 32px "Roboto Mono"'
  const installedMono = pixels(MONO)
  const installedStatic = pixels('40px RMStatic')
  const mono = font('RobotoMono-VariableFont_wght.ttf')
  const bold = font('RMStatic-Bold.ttf')
  const states = {}
  // register(sameBytes, undefined, {weight: 400}).
  let key = GlobalFonts.register(mono, undefined, { weight: 400 })
  states.buffer = pixels(MONO)
  out.removed = [GlobalFonts.remove(key)]
  out.bufferAfter = pixels(MONO) === installedMono
  // registerFromPath(sameFile, undefined, {weight: 400}): its twin.
  key = GlobalFonts.registerFromPath(PROBE_DIR + '/RobotoMono-VariableFont_wght.ttf', undefined, { weight: 400 })
  states.path = pixels(MONO)
  out.removed.push(GlobalFonts.remove(key))
  out.pathAfter = pixels(MONO) === installedMono
  // No descriptors: the Bold file of the family, no alias.
  key = GlobalFonts.register(bold)
  states.plain = pixels('40px RMStatic')
  states.plainBold = pixels('bold 40px RMStatic')
  // ... across a rebuild (an unrelated remove) and a renderer switch.
  GlobalFonts.remove(GlobalFonts.register(font('Lato-Regular.ttf'), 'Unrelated'))
  setTextRenderer(RENDERER === 'system' ? 'portable' : 'system')
  setTextRenderer(RENDERER)
  states.plainRebuilt = pixels('40px RMStatic')
  out.removed.push(GlobalFonts.remove(key))
  out.plainAfter = pixels('40px RMStatic') === installedStatic
  // Guard: the Bold file under another name.
  key = GlobalFonts.register(bold, 'Brand')
  out.guard = pixels('40px RMStatic') === installedStatic
  const brand = pixels('40px Brand')
  const brandBold = pixels('bold 40px Brand')
  out.removed.push(GlobalFonts.remove(key))
  // References: the same faces under a name no installed font has.
  GlobalFonts.register(mono, 'Ref 400', { weight: 400 })
  const ref400 = pixels('bold 32px "Ref 400"')
  out.refs = [ref400 !== installedMono, brand !== installedStatic]
  out.buffer = states.buffer === ref400
  out.path = states.path === ref400
  out.plain = [states.plain === brand, states.plainBold === brandBold, states.plainRebuilt === brand]
  console.log(JSON.stringify(out))`

for (const renderer of ['portable', 'system'] as const) {
  test(`a registered face is a FontFace of the installed family name its call gave (${renderer})`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-call-name-'))
    t.teardown(() => rmSync(dir, { recursive: true, force: true }))
    copyFileSync(
      join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf'),
      join(dir, 'RobotoMono-VariableFont_wght.ttf'),
    )
    copyFileSync(join(__dirname, 'fonts', 'RMStatic-Regular.ttf'), join(dir, 'RMStatic-Regular.ttf'))
    const child = spawnSync(process.execPath, ['-e', CALL_NAME_PROBE], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        RENDERER: renderer,
        PROBE_DIR: dir,
        PROBE_FONTS: join(__dirname, 'fonts'),
        PROBE_INDEX: join(__dirname, '..', 'index.js'),
      },
    })
    t.is(child.status, 0, child.stderr)
    t.deepEqual(JSON.parse(child.stdout), {
      loaded: 2,
      removed: [true, true, true, true],
      bufferAfter: true,
      pathAfter: true,
      plainAfter: true,
      guard: true,
      refs: [true, true],
      // bold "Roboto Mono" is the {400} FontFace drawn bold, not wght 700.
      buffer: true,
      path: true,
      // "RMStatic" is the Bold FontFace for every request.
      plain: [true, true, true],
    })
  })
}

// A family that declares descriptors chooses its faces by them, as Blink's
// FontFaceCache does: a face's capabilities are its descriptors (`auto` the
// normal value, never the file's style), faces with the same ones are one
// CSSSegmentedFontFace (newest first), and the request takes the nearest
// (FontSelectionAlgorithm). RMStatic: the static wght 400 / 700 instances of
// Roboto Mono.
const rmRegular = font('RMStatic-Regular.ttf')
const rmBold = font('RMStatic-Bold.ttf')
GlobalFonts.register(rmRegular, 'Cap Ref Regular')
GlobalFonts.register(rmRegular, 'Cap Ref R700', { weight: 700 })
GlobalFonts.register(rmBold, 'Cap Ref Bold')

test('declared weights choose the face, not the file', (t) => {
  declare(t, rmRegular, 'Cap Swapped', { weight: 700 })
  declare(t, rmBold, 'Cap Swapped', { weight: 400 })
  const regular = draw('32px "Cap Ref Regular"').pixels
  t.notDeepEqual(regular, draw('bold 32px "Cap Ref Regular"').pixels)
  t.deepEqual(draw('32px "Cap Swapped"').pixels, draw('32px "Cap Ref Bold"').pixels)
  // Declared 700: not emboldened.
  t.deepEqual(draw('bold 32px "Cap Swapped"').pixels, regular)
})

test('auto and 400 are one segment, newest face first', (t) => {
  declare(t, rmRegular, 'Cap 400 Auto', { weight: 400 })
  t.truthy(GlobalFonts.register(rmBold, 'Cap 400 Auto'))
  const boldFile = draw('32px "Cap Ref Bold"').pixels
  t.deepEqual(draw('32px "Cap 400 Auto"').pixels, boldFile)
  t.deepEqual(draw('bold 32px "Cap 400 Auto"').pixels, boldFile)
  t.truthy(GlobalFonts.register(rmBold, 'Cap Auto 400'))
  declare(t, rmRegular, 'Cap Auto 400', { weight: 400 })
  // The Regular face, emboldened: the segment's maximum is under 600.
  t.deepEqual(draw('bold 32px "Cap Auto 400"').pixels, draw('bold 32px "Cap Ref Regular"').pixels)
})

test('one buffer declared twice draws each declaration for its weight', (t) => {
  const v400 = draw('32px "Descriptors 400"').pixels
  const v700 = draw('32px "Descriptors 700"').pixels
  const first = Buffer.concat([robotoMono, Buffer.alloc(256)])
  declare(t, first, 'Cap Twin', { weight: 400 })
  declare(t, first, 'Cap Twin', { weight: 700 })
  const second = Buffer.concat([robotoMono, Buffer.alloc(320)])
  declare(t, second, 'Cap Twin Reversed', { weight: 700 })
  declare(t, second, 'Cap Twin Reversed', { weight: 400 })
  for (const name of ['Cap Twin', 'Cap Twin Reversed']) {
    t.deepEqual(draw(`32px "${name}"`).pixels, v400, name)
    t.deepEqual(draw(`bold 32px "${name}"`).pixels, v700, name)
  }
})

test('a character the matched segment lacks comes from the next family', (t) => {
  // The {700} face has the Greek, the {400} one not: Blink's fallback walks
  // the matched segment's faces only, then the next family.
  declare(t, robotoMono, 'Cap Segment', { weight: 700 })
  declare(t, font('Lato-Regular.ttf'), 'Cap Segment', { weight: 400 })
  t.deepEqual(
    draw('32px "Cap Segment", "Descriptors Auto"', GREEK).pixels,
    draw('32px "Descriptors Auto"', GREEK).pixels,
  )
  t.deepEqual(draw('32px "Cap Segment"').pixels, draw('32px "Descriptors Lato"').pixels)
})

test('an older face of the matched segment draws what the newest lacks', (t) => {
  // Both declared 400: one segment, whatever the files' weights.
  declare(t, rmBold, 'Cap Older', { weight: 400 })
  declare(t, font('Lato-Regular.ttf'), 'Cap Older', { weight: 400 })
  t.deepEqual(draw('32px "Cap Older"', GREEK).pixels, draw('32px "Cap Ref Bold"', GREEK).pixels)
  t.deepEqual(draw('32px "Cap Older"').pixels, draw('32px "Descriptors Lato"').pixels)
})

test('SVG text: a declared family chooses its faces like canvas text', (t) => {
  // svgPixels draws font-weight bold: the face declared 700.
  t.deepEqual(svgPixels("'Cap Swapped'", 'Ham'), svgPixels("'Cap Ref R700'", 'Ham'))
  t.notDeepEqual(svgPixels("'Cap Swapped'", 'Ham'), svgPixels("'Cap Ref Bold'", 'Ham'))
})

test('measureText follows the face the descriptors choose', (t) => {
  declare(t, font('Oswald.ttf'), 'Cap Width', { weight: 400 })
  declare(t, font('Lato-Regular.ttf'), 'Cap Width', { weight: 700 })
  const ctx = createCanvas(10, 10).getContext('2d')
  const width = (font: string) => {
    ctx.font = font
    return ctx.measureText('Hamburgefonts').width
  }
  t.not(width('32px "Descriptors Oswald"'), width('32px "Descriptors Lato"'))
  t.is(width('32px "Cap Width"'), width('32px "Descriptors Oswald"'))
  t.is(width('bold 32px "Cap Width"'), width('32px "Descriptors Lato"'))
})

// A child process: two declared faces under the name of a family
// loadFontsFromDir loaded are FontFaces of that name ("\x01w\x01"): they
// choose by their descriptors, across a rebuild and a renderer switch; after
// remove the installed face draws again.
const INSTALLED_NAME_PROBE = `
  const { readFileSync } = require('fs')
  const { createCanvas, GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_DIR, PROBE_FONTS } = process.env
  setTextRenderer(RENDERER)
  const font = (name) => readFileSync(PROBE_FONTS + '/' + name)
  const pixels = (font) => {
    const ctx = createCanvas(420, 60).getContext('2d')
    ctx.font = font
    ctx.fillText('Hamburgefonts', 10, 42)
    return Buffer.from(ctx.getImageData(0, 0, 420, 60).data).toString('base64')
  }
  const out = { loaded: GlobalFonts.loadFontsFromDir(PROBE_DIR) }
  const installed = pixels('40px RMStatic')
  const regular = font('RMStatic-Regular.ttf')
  const bold = font('RMStatic-Bold.ttf')
  const keys = [
    GlobalFonts.register(regular, 'RMStatic', { weight: 700 }),
    GlobalFonts.register(bold, 'RMStatic', { weight: 400 }),
  ]
  const states = [[pixels('40px RMStatic'), pixels('bold 40px RMStatic')]]
  GlobalFonts.remove(GlobalFonts.register(font('Lato-Regular.ttf'), 'Unrelated'))
  setTextRenderer(RENDERER === 'system' ? 'portable' : 'system')
  setTextRenderer(RENDERER)
  states.push([pixels('40px RMStatic'), pixels('bold 40px RMStatic')])
  out.removed = keys.map((key) => GlobalFonts.remove(key))
  out.after = pixels('40px RMStatic') === installed
  // References under names no installed font has.
  GlobalFonts.register(regular, 'Ref Regular')
  GlobalFonts.register(bold, 'Ref Bold')
  const refs = [pixels('40px "Ref Bold"'), pixels('40px "Ref Regular"')]
  out.refs = refs[0] !== installed && refs[1] === installed
  out.states = states.map(([normal, boldText]) => [normal === refs[0], boldText === refs[1]])
  console.log(JSON.stringify(out))`

for (const renderer of ['portable', 'system'] as const) {
  test(`declared faces under an installed family name choose by their descriptors (${renderer})`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-installed-name-'))
    t.teardown(() => rmSync(dir, { recursive: true, force: true }))
    copyFileSync(join(__dirname, 'fonts', 'RMStatic-Regular.ttf'), join(dir, 'RMStatic-Regular.ttf'))
    const child = spawnSync(process.execPath, ['-e', INSTALLED_NAME_PROBE], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        RENDERER: renderer,
        PROBE_DIR: dir,
        PROBE_FONTS: join(__dirname, 'fonts'),
        PROBE_INDEX: join(__dirname, '..', 'index.js'),
      },
    })
    t.is(child.status, 0, child.stderr)
    t.deepEqual(JSON.parse(child.stdout), {
      loaded: 1,
      removed: [true, true],
      after: true,
      refs: true,
      // normal: the Bold file declared 400; bold: the Regular file declared 700.
      states: [
        [true, true],
        [true, true],
      ],
    })
  })
}

// FontVariableItalicAxis (ResolveVariations, font_custom_platform_data.cc):
// on a registered face with an ital axis, the `italic` keyword draws ital 1,
// slnt at the axis default and no synthetic italic, before the declared
// slope; any other style draws ital 0, not the axis default; the request's
// variations win. FontStyleTest-ital: ital 0..1; FontStyleTest-slnt_ital:
// slnt -15..0, ital 0..1 (default 0.5). Chrome 159 draws each pair alike
// (one FontFace per draw: its CacheKey has no StyleSyntax).
const italFont = font('FontStyleTest-ital-VF.woff2')
const slntItalFont = font('FontStyleTest-slnt_ital-VF.woff2')
GlobalFonts.register(italFont, 'Ital Auto')
GlobalFonts.register(italFont, 'Ital 700', { weight: 700 })
GlobalFonts.register(slntItalFont, 'Slnt Ital Auto')
GlobalFonts.register(slntItalFont, 'Slnt Ital Normal', { style: 'normal' })
GlobalFonts.register(slntItalFont, 'Slnt Ital Italic', { style: 'italic' })

const ITAL_TEXT = 'varfont Hamb'
type ItalDraw = [font: string, variations?: string]
const ITAL_1: ItalDraw = ['40px "Ital Auto"', '"ital" 1']
const SLNT_ITAL_0_SLANTED: ItalDraw = ['40px "Slnt Ital Auto"', '"ital" 0, "slnt" -14']
const SLNT_ITAL_1: ItalDraw = ['40px "Slnt Ital Auto"', '"ital" 1, "slnt" 0']
// [title, drawn, reference]: equal pixels and widths.
const ITAL_CASES: [string, ItalDraw, ItalDraw][] = [
  ['italic is ital 1, unskewed', ['italic 40px "Ital Auto"'], ITAL_1],
  ['the request variations set ital last', ['italic 40px "Ital Auto"', '"ital" 0'], ['40px "Ital Auto"']],
  ['oblique is ital 0 (not the default) at the slnt', ['oblique 40px "Slnt Ital Auto"'], SLNT_ITAL_0_SLANTED],
  ['italic sets slnt to the axis default', ['italic 40px "Slnt Ital Auto"'], SLNT_ITAL_1],
  ['declared normal: italic is still ital 1, unskewed', ['italic 40px "Slnt Ital Normal"'], SLNT_ITAL_1],
  ['declared italic: a normal request is ital 0 at the slope', ['40px "Slnt Ital Italic"'], SLNT_ITAL_0_SLANTED],
  ['declared 700: bold italic is ital 1, not emboldened', ['bold italic 40px "Ital 700"'], ITAL_1],
]

function drawItal([font, variations]: ItalDraw) {
  const { pixels } = draw(font, ITAL_TEXT, variations)
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = font
  ctx.fontVariationSettings = variations || 'normal'
  return { pixels, width: ctx.measureText(ITAL_TEXT).width }
}

for (const [title, drawn, reference] of ITAL_CASES) {
  test(`ital axis: ${title}`, (t) => {
    const ref = drawItal(reference)
    const got = drawItal(drawn)
    t.deepEqual(got.pixels, ref.pixels)
    t.is(got.width, ref.width)
  })
}

test('ital axis: italic and oblique differ', (t) => {
  t.notDeepEqual(drawItal(['italic 40px "Ital Auto"']).pixels, drawItal(['oblique 40px "Ital Auto"']).pixels)
})

// A child process per renderer: the cases above, and an installed face with
// an ital axis (loadFontsFromDir) that gets no ital coordinate (FontCache
// sets none): italic stays the skewed default instance, as oblique.
const ITAL_PROBE = `
  const { readFileSync } = require('fs')
  const { createCanvas, GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_DIR, PROBE_FONTS, ITAL_CASES, ITAL_TEXT } = process.env
  setTextRenderer(RENDERER)
  const font = (name) => readFileSync(PROBE_FONTS + '/' + name)
  const pixels = ([font, variations]) => {
    const ctx = createCanvas(420, 60).getContext('2d')
    ctx.font = font
    ctx.fontVariationSettings = variations || 'normal'
    ctx.fillText(ITAL_TEXT, 10, 42)
    return Buffer.from(ctx.getImageData(0, 0, 420, 60).data).toString('base64')
  }
  const out = { loaded: GlobalFonts.loadFontsFromDir(PROBE_DIR) }
  const installedItalic = pixels(['italic 40px FontStyleTest'])
  out.installed = [
    installedItalic === pixels(['oblique 40px FontStyleTest']),
    installedItalic !== pixels(['40px FontStyleTest']),
  ]
  const ital = font('FontStyleTest-ital-VF.woff2')
  const keys = [GlobalFonts.register(ital, 'Ital Auto'), GlobalFonts.register(ital, 'Ital 700', { weight: 700 })]
  // The same file registered: its name draws ital 1, the installed family
  // keeps the installed face. (Before the slnt_ital file, whose family is
  // also FontStyleTest.)
  out.registered = pixels(['italic 40px "Ital Auto"']) !== installedItalic
  out.installedAfter = pixels(['italic 40px FontStyleTest']) === installedItalic
  const slntItal = font('FontStyleTest-slnt_ital-VF.woff2')
  keys.push(
    GlobalFonts.register(slntItal, 'Slnt Ital Auto'),
    GlobalFonts.register(slntItal, 'Slnt Ital Normal', { style: 'normal' }),
    GlobalFonts.register(slntItal, 'Slnt Ital Italic', { style: 'italic' }),
  )
  out.keys = keys.every((key) => key !== null)
  out.cases = JSON.parse(ITAL_CASES).map(([, drawn, reference]) => pixels(drawn) === pixels(reference))
  console.log(JSON.stringify(out))`

for (const renderer of ['portable', 'system'] as const) {
  test(`ital axis: registered faces only (${renderer})`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-ital-'))
    t.teardown(() => rmSync(dir, { recursive: true, force: true }))
    copyFileSync(join(__dirname, 'fonts', 'FontStyleTest-ital-VF.woff2'), join(dir, 'FontStyleTest-ital-VF.woff2'))
    const child = spawnSync(process.execPath, ['-e', ITAL_PROBE], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        RENDERER: renderer,
        PROBE_DIR: dir,
        PROBE_FONTS: join(__dirname, 'fonts'),
        PROBE_INDEX: join(__dirname, '..', 'index.js'),
        ITAL_CASES: JSON.stringify(ITAL_CASES),
        ITAL_TEXT,
      },
    })
    t.is(child.status, 0, child.stderr)
    t.deepEqual(JSON.parse(child.stdout), {
      loaded: 1,
      installed: [true, true],
      keys: true,
      cases: ITAL_CASES.map(() => true),
      registered: true,
      installedAfter: true,
    })
  })
}

// SVG text draws the instances canvas text draws: Blink makes SVG text's Font
// from the same FontDescription and font selector
// (LayoutSVGInlineText::ComputeNewScaledFontForStyle), so ResolveVariations
// runs for it: wght, slnt and ital from the style, opsz at the font-size, a
// declared face's own coordinates, the request's for a fallback run and for
// an installed face. Chrome 159 (an SVG image with @font-face) draws bold
// RobotoMono as wght 700 and 300 as wght 300, italic ScienceGothic as slnt
// -10 (= oblique), italic FontStyleTest-ital as ital 1 (not oblique),
// Newsreader at font-size 32 as opsz 32, and declared {weight: 400} 300 as
// normal. Each case is drawn per glyph at fixed x, as SVG text and as canvas
// text, in a child process per renderer: the convertSVGTextToPath outlines
// against the SVG canvas export of canvas text (both renderers), and the
// pixels with the system renderer, which draws SVG text with canvas text's
// draw font.
const SVG_VARIATIONS_PROBE = `
  const { readFileSync } = require('fs')
  const { createHash } = require('crypto')
  const { convertSVGTextToPath, createCanvas, GlobalFonts, Image, Path2D, setTextRenderer, SvgExportFlag } =
    require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_DIR, PROBE_FONTS } = process.env
  setTextRenderer(RENDERER)
  const font = (name) => readFileSync(PROBE_FONTS + '/' + name)
  const out = { loaded: GlobalFonts.loadFontsFromDir(PROBE_DIR), keys: [] }
  const mono = font('RobotoMono-VariableFont_wght.ttf')
  out.keys.push(
    GlobalFonts.register(mono, 'SV Rm'),
    GlobalFonts.register(mono, 'SV Rm 400', { weight: 400 }),
    GlobalFonts.register(font('Oswald.ttf'), 'SV Oswald'),
    GlobalFonts.register(font('ScienceGothic-VariableFont.ttf'), 'SV Sg'),
    GlobalFonts.register(font('FontStyleTest-ital-VF.woff2'), 'SV It'),
    GlobalFonts.register(font('Newsreader-opsz-only.ttf'), 'SV Nw'),
  )
  const XS = [4, 40.5, 77.25, 113.75]
  const W = 160
  const ATTRS = { n: ['normal', 400], b: ['normal', 700], w300: ['normal', 300], i: ['italic', 400], o: ['oblique', 400] }
  const CASES = JSON.parse(process.env.SVG_CASES)
  const svgOf = (family, s, text, head = '') =>
    head + '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="60"><text x="' +
    XS.slice(0, [...text].length).join(' ') + '" y="44" font-family="' + family + '" font-size="32" font-style="' +
    ATTRS[s][0] + '" font-weight="' + ATTRS[s][1] + '">' + text + '</text></svg>'
  const cssOf = (family, s) =>
    ATTRS[s][0] + ' ' + ATTRS[s][1] + ' 32px ' + family.split(',').map((f) => '"' + f.trim().replace(/'/g, '') + '"').join(', ')
  const sha1 = (data) => createHash('sha1').update(data).digest('hex')
  const svgPixels = (svg) => {
    const img = new Image()
    img.src = Buffer.from(svg)
    const ctx = createCanvas(W, 60).getContext('2d')
    ctx.drawImage(img, 0, 0)
    return ctx.getImageData(0, 0, W, 60).data
  }
  const canvasText = (ctx, family, s, text) => {
    ctx.font = cssOf(family, s)
    ;[...text].forEach((ch, k) => ctx.fillText(ch, XS[k], 44))
  }
  const canvasPixels = (family, s, text) => {
    const ctx = createCanvas(W, 60).getContext('2d')
    canvasText(ctx, family, s, text)
    return ctx.getImageData(0, 0, W, 60).data
  }
  const bounds = (xml) => {
    let b = [Infinity, Infinity, -Infinity, -Infinity]
    for (const m of xml.matchAll(/<path([^>]*)>/g)) {
      const d = (m[1].match(/ d="([^"]*)"/) || [])[1]
      if (!d) continue
      const t = (m[1].match(/translate\\(([-\\d.e]+)[ ,]+([-\\d.e]+)\\)/) || [0, 0, 0]).slice(1).map(Number)
      const p = new Path2D(d).computeTightBounds()
      b = [Math.min(b[0], p[0] + t[0]), Math.min(b[1], p[1] + t[1]), Math.max(b[2], p[2] + t[0]), Math.max(b[3], p[3] + t[1])]
    }
    return b.map((v) => Math.round(v * 1000) / 1000)
  }
  const canvasPaths = (family, s, text) => {
    const canvas = createCanvas(W, 60, SvgExportFlag.ConvertTextToPaths)
    canvasText(canvas.getContext('2d'), family, s, text)
    return bounds(canvas.getContent().toString())
  }
  const alphaDiff = (a, b) => {
    let n = 0
    for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) n++
    return n
  }
  out.sha = {}
  out.oracle = {}
  out.paths = {}
  for (const [id, family, s, text] of CASES) {
    const svg = svgOf(family, s, text)
    out.sha[id] = sha1(svgPixels(svg))
    out.oracle[id] = alphaDiff(svgPixels(svg), canvasPixels(family, s, text))
    out.paths[id] = { svg: bounds(convertSVGTextToPath(svg).toString()), canvas: canvasPaths(family, s, text) }
  }
  // A document only SkSVG reads (Latin-1): its font-family is one name
  // (MatchNamedFamily).
  const latin1 = svgOf('SV Rm', 'b', 'Hag', '<?xml version="1.0" encoding="ISO-8859-1"?><!-- \\xe9 -->')
  out.named = bounds(convertSVGTextToPath(Buffer.from(latin1, 'latin1')).toString())
  // The instances' font arguments count toward the caches' budget, and the
  // drop runs after the render: a line laid out before is cold again.
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = '32px "SV Rm"'
  const requests = () => JSON.parse(ctx.__debugTextLine('Budget line')).requestInstanceFaces
  const cold = requests()
  const warm = requests()
  let sizes = ''
  for (let i = 0; i < 300; ++i) sizes += '<text x="0" y="' + (i + 10) + '" font-family="SV Nw" font-size="' + (10 + i / 4) + '">H</text>'
  const many = new Image()
  many.src = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="320">' + sizes + '</svg>')
  createCanvas(40, 320).getContext('2d').drawImage(many, 0, 0)
  out.budget = { warm: warm - cold, after: requests() - warm }
  console.log(JSON.stringify(out))`

// [id, font-family, style, text]. SkSVG's Primitive shaper applies no GSUB,
// so the texts leave out the glyphs these fonts swap by their axes (rvrn:
// FontStyleTest's and ScienceGothic's 'a').
const SVG_CASES: [string, string, string, string][] = [
  ['rm.n', 'SV Rm', 'n', 'Hag'],
  ['rm.b', 'SV Rm', 'b', 'Hag'],
  ['rm.w300', 'SV Rm', 'w300', 'Hag'],
  ['rm400.n', "'SV Rm 400'", 'n', 'Hag'],
  ['rm400.w300', "'SV Rm 400'", 'w300', 'Hag'],
  ['rm400.b', "'SV Rm 400'", 'b', 'Hag'],
  ['sg.n', 'SV Sg', 'n', 'Hbg'],
  ['sg.i', 'SV Sg', 'i', 'Hbg'],
  ['sg.o', 'SV Sg', 'o', 'Hbg'],
  ['sg.b', 'SV Sg', 'b', 'Hbg'],
  ['it.i', 'SV It', 'i', 'opst'],
  ['it.o', 'SV It', 'o', 'opst'],
  ['nw.n', 'SV Nw', 'n', 'Hag'],
  ['oswald.b', 'SV Oswald', 'b', 'Hbg'],
  // Roboto Mono has no digraphs: the Oswald run, at the request's wght, as
  // Oswald alone draws them. (Canvas text decomposes them: Oswald's ccmp.)
  ['fallback.n', "'SV Rm', 'SV Oswald'", 'n', 'ǅǄ'],
  ['fallback.b', "'SV Rm', 'SV Oswald'", 'b', 'ǅǄ'],
  ['oswald.dg.n', 'SV Oswald', 'n', 'ǅǄ'],
  ['oswald.dg.b', 'SV Oswald', 'b', 'ǅǄ'],
  // loadFontsFromDir: an installed variable face takes the request's wght.
  ['installed.b', 'Roboto Mono', 'b', 'Hag'],
]

interface SvgVariations {
  loaded: number
  keys: (string | null)[]
  sha: Record<string, string>
  oracle: Record<string, number>
  paths: Record<string, { svg: number[]; canvas: number[] }>
  named: number[]
  budget: { warm: number; after: number }
}

const svgVariations = new Map<string, SvgVariations>()
function svgVariationsOf(renderer: string): SvgVariations {
  if (!svgVariations.has(renderer)) {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-svg-variations-'))
    try {
      copyFileSync(
        join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf'),
        join(dir, 'RobotoMono-VariableFont_wght.ttf'),
      )
      const child = spawnSync(process.execPath, ['-e', SVG_VARIATIONS_PROBE], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          RENDERER: renderer,
          PROBE_DIR: dir,
          PROBE_FONTS: join(__dirname, 'fonts'),
          PROBE_INDEX: join(__dirname, '..', 'index.js'),
          SVG_CASES: JSON.stringify(SVG_CASES),
        },
      })
      if (child.status !== 0) throw new Error(child.stderr)
      svgVariations.set(renderer, JSON.parse(child.stdout))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  return svgVariations.get(renderer)!
}

for (const renderer of ['portable', 'system'] as const) {
  test(`SVG text: wght, slnt, ital and opsz as canvas text (${renderer})`, (t) => {
    const { loaded, keys, sha, paths } = svgVariationsOf(renderer)
    t.is(loaded, 1)
    t.true(
      keys.every((key) => key !== null),
      `keys ${keys}`,
    )
    // Synthetic bold outlines differ in width between the two exports
    // (svg-synthetic-style.spec.ts), so rm400.b is checked by pixels only.
    for (const [id] of SVG_CASES.filter(([id]) => id !== 'rm400.b')) {
      const { svg, canvas } = paths[id]
      t.true(
        svg.every((v, k) => Math.abs(v - canvas[k]) < 0.01),
        `${id} outlines ${JSON.stringify(svg)} vs ${JSON.stringify(canvas)}`,
      )
    }
    t.not(sha['rm.b'], sha['rm.n'])
    t.not(sha['rm.w300'], sha['rm.n'])
    // Declared 400: 300 clamps to 400.
    t.is(sha['rm400.w300'], sha['rm400.n'])
    t.not(sha['sg.i'], sha['sg.n'])
    t.is(sha['sg.o'], sha['sg.i'])
    t.not(sha['sg.b'], sha['sg.n'])
    t.not(sha['it.i'], sha['it.o'])
    t.not(sha['fallback.b'], sha['fallback.n'])
    t.is(sha['fallback.n'], sha['oswald.dg.n'])
    t.is(sha['fallback.b'], sha['oswald.dg.b'])
  })

  test(`SVG text: a document only SkSVG reads draws the same instances (${renderer})`, (t) => {
    const { named, paths } = svgVariationsOf(renderer)
    t.true(
      named.every((v, k) => Math.abs(v - paths['rm.b'].canvas[k]) < 0.01),
      `${JSON.stringify(named)} vs ${JSON.stringify(paths['rm.b'].canvas)}`,
    )
  })

  test(`SVG text: the instances count toward the font argument budget (${renderer})`, (t) => {
    const { budget } = svgVariationsOf(renderer)
    t.is(budget.warm, 0)
    // The SVG's 300 opsz instances dropped the caches after its render.
    t.true(budget.after > 0, `${budget.after} request instances`)
  })
}

const svgPixelTest = process.platform === 'darwin' || process.platform === 'linux' ? test : test.skip
svgPixelTest('SVG text draws the pixels canvas text draws (system)', (t) => {
  const { oracle } = svgVariationsOf('system')
  for (const [id, , , text] of SVG_CASES) {
    if (text !== 'ǅǄ') t.is(oracle[id], 0, `${id}: ${oracle[id]} px differ from canvas text`)
  }
})
