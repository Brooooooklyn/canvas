// measureText's width and actualBoundingBox against Chrome 155 (CPU canvas,
// Linux x64). Blink shapes the text word by word (PlainTextNode: kerning
// and ligatures never cross a space unless kerning or ligatures are asked
// for and the font kerns or ligates the space), measures the ink of every
// glyph of every run, and reports left and right from the text's own left
// edge (TextMetrics::MeasureRuns and Update). A letter spacing other than 0
// turns the optional ligatures off.
//
// Two engine differences are left out: Chrome reads Harmattan's glyph boxes
// through Fontations (one pixel taller here) and rasterizes one NKo column
// differently.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type Row = [number, number, number, number, number, string?]

interface Fixture {
  rtl: Record<string, Row>
  spacing: Record<string, Row>
  fallbackRuns: Record<string, Row>
  words: Record<string, number>
  wordShape: Record<string, number>
  emptyUnion: Record<string, Row>
  large: Record<string, Row>
  zeroWidth: Record<string, Row>
  negativeSpacing: Record<string, Row>
  alphaReset: Record<'copy' | 'xor', [number, number, number][]>
}

const FIXTURE: Fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'text-bbox.json'), 'utf8'))

const FONTS: Record<string, string> = {
  LatoT: 'Lato-Regular.ttf',
  HanT: 'SourceHanSerifCN-Bold.ttf',
  SerifProT: 'SourceSerifPro-Regular.ttf',
  IosevkaT: 'iosevka-slab-regular.ttf',
  OswaldT: 'Oswald.ttf',
  HarmattanT: 'Harmattan-Regular.ttf',
  NKoT: 'NotoSansNKo-Regular.ttf',
}
for (const [family, file] of Object.entries(FONTS)) {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', file), family)
}

const FIELDS = [
  'width',
  'actualBoundingBoxLeft',
  'actualBoundingBoxRight',
  'actualBoundingBoxAscent',
  'actualBoundingBoxDescent',
] as const

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

function inkBox(ctx: Ctx, width: number, height: number) {
  const data = ctx.getImageData(0, 0, width, height).data
  let top = -1
  let bottom = -1
  let left = width
  let right = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (top < 0) top = y
        bottom = y
        left = Math.min(left, x)
        right = Math.max(right, x)
      }
    }
  }
  return [left, top, right, bottom].join(',')
}

// The fields of `row` that differ from Chrome by more than 1/1000, and the
// painted box if it differs. `skip` names fields to leave out ('ink' for the
// painted box).
function differences(key: string, row: Row, measured: TextMetrics, box: string | null, skip: string[]) {
  const out: string[] = []
  FIELDS.forEach((field, i) => {
    if (!skip.includes(field) && !(Math.abs(measured[field] - row[i]) <= 1e-3)) {
      out.push(`${key} ${field}: ${measured[field]} (Chrome ${row[i]})`)
    }
  })
  if (box !== null && !skip.includes('ink') && box !== row[5]) {
    out.push(`${key} ink: ${box} (Chrome ${row[5]})`)
  }
  return out
}

function engineGaps(family: string) {
  if (family === 'HarmattanT') return ['actualBoundingBoxAscent', 'ink']
  if (family === 'NKoT') return ['ink']
  return []
}

test('RTL and aligned text have Chrome bounds', (t) => {
  const out: string[] = []
  for (const [key, row] of Object.entries(FIXTURE.rtl)) {
    const [, family, text, direction, align] = /^(\w+) (".*") (ltr|rtl) (\w+)$/.exec(key)!
    const ctx = createCanvas(400, 80).getContext('2d')
    ctx.font = `30px ${family}`
    ctx.direction = direction as CanvasDirection
    ctx.textAlign = align as CanvasTextAlign
    ctx.fillText(JSON.parse(text), 200, 50)
    out.push(...differences(key, row, ctx.measureText(JSON.parse(text)), inkBox(ctx, 400, 80), engineGaps(family)))
  }
  t.deepEqual(out, [])
})

test('letter- and word-spaced text has Chrome bounds', (t) => {
  const out: string[] = []
  for (const [key, row] of Object.entries(FIXTURE.spacing)) {
    const [, family, text, direction, ls, ws] = /^(\w+) (".*") (ltr|rtl) ls(\S+) ws(\S+)$/.exec(key)!
    const ctx = createCanvas(400, 80).getContext('2d')
    ctx.font = `30px ${family}`
    ctx.direction = direction as CanvasDirection
    ctx.letterSpacing = ls
    ctx.wordSpacing = ws
    ctx.fillText(JSON.parse(text), 60, 50)
    out.push(...differences(key, row, ctx.measureText(JSON.parse(text)), inkBox(ctx, 400, 80), engineGaps(family)))
  }
  t.deepEqual(out, [])
})

test('the bounds cover every font run like Chrome', (t) => {
  const out: string[] = []
  for (const [key, row] of Object.entries(FIXTURE.fallbackRuns)) {
    const [, font, text, direction] = /^(.*, \w+) (".*") (ltr|rtl)$/.exec(key)!
    const ctx = createCanvas(500, 80).getContext('2d')
    ctx.font = `40px ${font}`
    ctx.direction = direction as CanvasDirection
    ctx.fillText(JSON.parse(text), 20, 55)
    out.push(...differences(key, row, ctx.measureText(JSON.parse(text)), inkBox(ctx, 500, 80), []))
  }
  t.deepEqual(out, [])
})

test('text without ink keeps the box of its last word like Chrome', (t) => {
  const out: string[] = []
  for (const [key, row] of Object.entries(FIXTURE.emptyUnion)) {
    const [, direction, align, text] = /^(ltr|rtl) (\w+?)2? (".*")$/.exec(key)!
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = '20px LatoT'
    ctx.direction = direction as CanvasDirection
    ctx.textAlign = align as CanvasTextAlign
    out.push(...differences(key, row, ctx.measureText(JSON.parse(text)), null, []))
  }
  t.deepEqual(out, [])
})

// Draws and measures each row's text at (300, 80) with the row's font,
// direction, textAlign, letterSpacing and wordSpacing.
function spacedRows(rows: Record<string, Row>) {
  const out: string[] = []
  for (const [key, row] of Object.entries(rows)) {
    const [, font, text, direction, align, ls, ws] = /^(.*?) (".*") (ltr|rtl) (\w+) ls(\S+) ws(\S+)$/.exec(key)!
    const ctx = createCanvas(600, 120).getContext('2d')
    ctx.font = font
    ctx.direction = direction as CanvasDirection
    ctx.textAlign = align as CanvasTextAlign
    ctx.letterSpacing = ls
    ctx.wordSpacing = ws
    ctx.fillText(JSON.parse(text), 300, 80)
    out.push(...differences(key, row, ctx.measureText(JSON.parse(text)), inkBox(ctx, 600, 120), []))
  }
  return out
}

// The zero width spaces that end words (soft hyphen, U+200B, bidi marks,
// U+FEFF, U+FFFC) get no letter spacing (ShapeResultSpacing skips
// Character::TreatAsZeroWidthSpace), and text that starts with one is not
// moved by half a letter spacing.
test('zero width spaces get no letter spacing like Chrome', (t) => {
  t.deepEqual(spacedRows(FIXTURE.zeroWidth), [])
})

// Blink gives no letter spacing to a HarfBuzz cluster that starts with a
// default ignorable code point, form feed, carriage return or U+FFFC
// (Character::TreatAsZeroWidthSpace), whether it shapes word by word or the
// whole text (fontKerning normal and optimizeLegibility do for this font,
// whose space is kerned). Its clusters are graphemes: a ZWJ, U+034F or a
// variation selector is inside the cluster before it. Above U+FFFF it reads
// a lead surrogate, so U+E0001, which starts a cluster, is spaced. The
// characters stay in their word's shaping: 'AV' keeps its kerning across a
// ZWJ or U+2060. Chrome 155.0.8059.80, macOS arm64, 40px Source Serif Pro
// from a FontFace.
const NO_SPACING_MODES: Record<string, Partial<Ctx>> = {
  default: {},
  'fontKerning normal': { fontKerning: 'normal' },
  optimizeLegibility: { textRendering: 'optimizeLegibility' },
}
const NO_SPACING_ROWS: [string, string, string, number][] = [
  ...['6px', '-3px'].flatMap((ls) =>
    Object.keys(NO_SPACING_MODES).flatMap((mode) =>
      ['', '\u200B', '\uFEFF', '\u00AD', '\u200D', '\u2060'].map((zw): [string, string, string, number] => [
        ls,
        mode,
        `a${zw}b`,
        ls === '6px' ? 55.43998718261719 : 37.43998718261719,
      ]),
    ),
  ),
  ['6px', 'default', 'AV', 60.75999450683594],
  ['6px', 'default', 'A\u200DV', 60.75999450683594],
  ['6px', 'default', 'A\u2060V', 60.75999450683594],
  ['6px', 'fontKerning normal', 'A\u200DV', 60.75999450683594],
  ['6px', 'fontKerning normal', 'A\u2060V', 60.75999450683594],
  ['6px', 'default', 'a\u200Cb', 55.43998718261719],
  ['6px', 'default', 'a\u034Fb', 55.43998718261719],
  ['6px', 'default', 'a\uFE0Fb', 55.43998718261719],
  ['6px', 'default', 'a\u{E0100}b', 55.43998718261719],
  ['6px', 'default', 'a\u{E0001}b', 61.43998718261719],
]

function spacedContext(ls: string, mode: string, width = 10, height = 10) {
  const ctx = createCanvas(width, height).getContext('2d')
  ctx.font = '40px SerifProT'
  ctx.letterSpacing = ls
  Object.assign(ctx, NO_SPACING_MODES[mode])
  return ctx
}

test('default ignorable characters get no letter spacing in either shaping like Chrome', (t) => {
  const out: string[] = []
  for (const [ls, mode, text, chrome] of NO_SPACING_ROWS) {
    const width = spacedContext(ls, mode).measureText(text).width
    if (!(Math.abs(width - chrome) <= 1e-3)) {
      out.push(`${ls} ${mode} ${JSON.stringify(text)}: ${width} (Chrome ${chrome})`)
    }
  }
  t.deepEqual(out, [])
  // Drawn, 'b' sits where it sits in 'ab' (Chrome: the same ink).
  const pixels = (text: string) => {
    const ctx = spacedContext('6px', 'fontKerning normal', 300, 80)
    ctx.fillText(text, 10, 55)
    return Buffer.from(ctx.getImageData(0, 0, 300, 80).data)
  }
  const ab = pixels('ab')
  t.true(ab.some((v) => v !== 0))
  t.true(pixels('a\u200Bb').equals(ab))
  t.true(pixels('a\u2060b').equals(ab))
  // A ZWJ emoji sequence stays one shaping, one glyph and one cluster
  // (Chrome on macOS: 40 and 46). Only with an emoji font that joins it:
  // Linux test containers have none.
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
  const width = (text: string, ls: string) => spacedContext(ls, 'default').measureText(text).width
  if (Math.abs(width(family, '0px') - width('\u{1F468}', '0px')) <= 1e-3) {
    t.true(Math.abs(width(family, '6px') - width(family, '0px') - 6) <= 1e-3, String(width(family, '6px')))
    t.is(spacedContext('6px', 'fontKerning normal').measureText(family).width, width(family, '6px'))
  }
})

// A word piece whose spacing outweighs its advance (a space with a large
// negative wordSpacing or letterSpacing) moves the words after it left, and
// nothing is clipped.
test('words after a negative-width piece sit where Chrome draws them', (t) => {
  t.deepEqual(spacedRows(FIXTURE.negativeSpacing), [])
})

// Blink adds the advances of the words, so spacing that is not negative
// never moves a word left of the text before it. The marked letters fall
// back to the second font, and skparagraph leaves one of their glyphs at the
// end of the separator's run in the first font, outside its clusters and not
// moved by the spacing before it, so its glyph positions go backwards
// although no piece is narrower than nothing.
test('spacing that is not negative moves no word left of the text before it', (t) => {
  const out: string[] = []
  const marked = 'a\u0308\u0323'
  const ctx = createCanvas(600, 120).getContext('2d')
  for (const font of [
    '16px NKoT, SerifProT',
    '16px NKoT, IosevkaT',
    '16px NKoT, OswaldT',
    '16px HarmattanT, SerifProT',
  ]) {
    for (const [letterSpacing, wordSpacing] of [
      ['1px', '10px'],
      ['1px', '0px'],
      ['0px', '0px'],
    ]) {
      for (const separator of [' ', '\u2009']) {
        ctx.font = font
        ctx.letterSpacing = letterSpacing
        ctx.wordSpacing = wordSpacing
        const before = `Hello ${marked}`
        const text = `${before}${separator}${marked}`
        // The last word starts no left of where `before` ends.
        const least = ctx.measureText(before).width + ctx.measureText(marked).actualBoundingBoxRight
        const right = ctx.measureText(text).actualBoundingBoxRight
        if (!(right >= least - 1e-3)) {
          out.push(`${font} ls${letterSpacing} ws${wordSpacing} ${JSON.stringify(text)}: right ${right} < ${least}`)
        }
        ctx.clearRect(0, 0, 600, 120)
        ctx.fillText(text, 300, 80)
        const inkRight = Number(inkBox(ctx, 600, 120).split(',')[2])
        if (!(inkRight >= Math.floor(300 + least) - 1)) {
          out.push(
            `${font} ls${letterSpacing} ws${wordSpacing} ${JSON.stringify(text)}: ink right ${inkRight} < ${300 + least}`,
          )
        }
      }
    }
  }
  t.deepEqual(out, [])
})

// Above 256px Skia measures glyphs on a scaled path strike, so the boxes
// have fractions. Blink keeps them: subpixel positioning is on (Chrome
// Linux's WebFontRenderStyle), so SkFontGetBoundsForGlyphs does not round
// them out.
test('glyph boxes above 256px keep their fractions like Chrome', (t) => {
  const out: string[] = []
  const ctx = createCanvas(10, 10).getContext('2d')
  for (const [key, row] of Object.entries(FIXTURE.large)) {
    const [, font, text] = /^(\S+ \w+) (".*")$/.exec(key)!
    ctx.font = font
    out.push(...differences(key, row, ctx.measureText(JSON.parse(text)), null, []))
  }
  t.deepEqual(out, [])
})

test('words are shaped one by one like Chrome', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  const actual: Record<string, number> = {}
  for (const key of Object.keys(FIXTURE.words)) {
    const [, family, text] = /^(\w+) (".*")$/.exec(key)!
    ctx.font = `20px ${family}`
    actual[key] = ctx.measureText(JSON.parse(text)).width
  }
  const out = Object.entries(FIXTURE.words)
    .filter(([key, width]) => !(Math.abs(actual[key] - width) <= 1e-3))
    .map(([key, width]) => `${key}: ${actual[key]} (Chrome ${width})`)
  t.deepEqual(out, [])
})

test('kerning, ligatures and letter spacing pick the shaping like Chrome', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  const actual: Record<string, number> = {}
  // Source Serif Pro kerns the space: with kerning asked for, the text is
  // shaped as one run (FontFallbackList::CanShapeWordByWord).
  ctx.font = '48px SerifProT'
  for (const kerning of ['auto', 'normal', 'none'] as const) {
    ctx.fontKerning = kerning
    actual[`kern ${kerning}`] = ctx.measureText('AVA Ta We').width
  }
  ctx.fontKerning = 'auto'
  for (const rendering of ['optimizeLegibility', 'geometricPrecision', 'optimizeSpeed'] as const) {
    ctx.textRendering = rendering
    actual[`tr ${rendering}`] = ctx.measureText('AVA Ta We').width
  }
  ctx.font = '28px SerifProT'
  for (const rendering of ['auto', 'optimizeSpeed', 'optimizeLegibility', 'geometricPrecision'] as const) {
    ctx.textRendering = rendering
    actual[`office ${rendering}`] = ctx.measureText('office waffle').width
  }
  ctx.textRendering = 'auto'
  ctx.font = '30px IosevkaT'
  for (const ls of ['0px', '10px', '-5px']) {
    ctx.letterSpacing = ls
    actual[`ios ls${ls}`] = ctx.measureText(`Hello world (${ls})`).width
  }
  // Any letter spacing turns Harmattan's ligatures off, even a negative one;
  // Arabic itself gets no spacing.
  ctx.font = '30px HarmattanT'
  for (const ls of ['0px', '6px', '-3px']) {
    ctx.letterSpacing = ls
    actual[`harm ls${ls}`] = ctx.measureText('سلام').width
  }
  const out = Object.entries(FIXTURE.wordShape)
    .filter(([key, width]) => !(Math.abs(actual[key] - width) <= 1e-3))
    .map(([key, width]) => `${key}: ${actual[key]} (Chrome ${width})`)
  t.deepEqual(out, [])
})

// The alpha:false reset takes the measured glyph box: with the ink of every
// run in it, only anti-aliased pixels at its right edge stay below 255
// (Chrome: one, at x 244).
test('the alpha:false reset covers the ink of every run', (t) => {
  for (const op of ['copy', 'xor'] as const) {
    const ctx = createCanvas(300, 70).getContext('2d', { alpha: false })
    ctx.fillStyle = 'rgb(200,100,50)'
    ctx.fillRect(0, 0, 300, 70)
    ctx.globalCompositeOperation = op
    ctx.fillStyle = 'rgba(0,0,255,0.5)'
    ctx.font = '40px LatoT, HanT'
    ctx.fillText('Defaul中 text', 10.3, 50.2)
    const right = 10.3 + ctx.measureText('Defaul中 text').actualBoundingBoxRight
    const data = ctx.getImageData(0, 0, 300, 70).data
    const below: number[][] = []
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) below.push([((i - 3) / 4) % 300, Math.floor((i - 3) / 1200)])
    }
    t.true(below.length > 0 && below.length < 5, `${op}: ${JSON.stringify(below)}`)
    t.true(
      below.every(([x]) => x === Math.floor(right)),
      `${op}: ${JSON.stringify(below)} (Chrome ${JSON.stringify(FIXTURE.alphaReset[op])})`,
    )
  }
})
