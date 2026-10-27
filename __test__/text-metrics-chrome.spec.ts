// TextMetrics and where fillText puts the glyphs for each textBaseline,
// against Chrome 155 (CPU canvas, Linux x64). Blink measures the primary font
// (the first family's face): the ascent and descent rounded to whole pixels
// (tiny installed fonts keep fractions), the OS/2 typo box scaled to the font
// size for top, middle and bottom, the BASE table for hanging, ideographic
// and alphabetic (TextMetrics::GetFontBaseline). The glyphs are painted with
// their alphabetic baseline that far below y.
//
// On macOS the tables under "darwin" are Chrome's on macOS, which reads the
// fonts through CoreText; other platforms check the Linux rows.
import './use-system-fonts'

import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type Row = number[]

interface Fixture {
  fonts: Record<string, string>
  keys: string[]
  baselines: Record<string, Row>
  tiny: Record<string, Row>
  installed: Record<string, Row>
  empty: Record<string, Row>
  primary: Record<string, Row>
  ink: Record<string, Row>
  negativeZero: Record<string, string>
  em: Record<string, Row>
}

const RAW = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'text-metrics.json'), 'utf8'))
const FIXTURE: Fixture = process.platform === 'darwin' ? { ...RAW, ...RAW.darwin } : RAW

// Chrome's macOS rows were measured on macOS 27. CoreText ships with the OS,
// so on another macOS version the painted pixels are not compared.
const PIXEL_PINS = process.platform !== 'darwin' || Number.parseInt(release(), 10) === 27

for (const [family, file] of Object.entries(FIXTURE.fonts)) {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', file), family)
}

const BASELINE = /^(.*) ([\d.]+) (\w+)$/
// The TextMetrics fields read from the font, not the glyphs.
const FONT_FIELDS = [
  'fontBoundingBoxAscent',
  'fontBoundingBoxDescent',
  'hangingBaseline',
  'alphabeticBaseline',
  'ideographicBaseline',
]
const INK_FIELDS = ['actualBoundingBoxAscent', 'actualBoundingBoxDescent']
const X_FIELDS = ['width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight']

function measure(font: string, baseline: string, text: string) {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = font
  ctx.textBaseline = baseline as CanvasTextBaseline
  return ctx.measureText(text)
}

// The rows of `table` whose `fields` differ from Chrome by more than 1/1000.
function mismatches(
  table: Record<string, Row>,
  fields: string[],
  read: (key: string) => { font: string; baseline: string; text: string },
) {
  const out: string[] = []
  for (const [key, expected] of Object.entries(table)) {
    const { font, baseline, text } = read(key)
    const metrics = measure(font, baseline, text) as unknown as Record<string, number>
    for (const field of fields) {
      const want = expected[FIXTURE.keys.indexOf(field)]
      if (!(Math.abs(metrics[field] - want) <= 1e-3)) {
        out.push(`${key} ${field}: ${metrics[field]} (Chrome ${want})`)
      }
    }
  }
  return out
}

function sized(text: (family: string) => string) {
  return (key: string) => {
    const [, family, size, baseline] = BASELINE.exec(key)!
    return { font: `${size}px ${family}`, baseline, text: text(family) }
  }
}

const SAMPLE: Record<string, string> = { HanT: '中文Hg', HarmattanT: 'سلام' }

test('the font metrics and baselines follow textBaseline like Chrome', (t) => {
  t.deepEqual(
    mismatches(
      FIXTURE.baselines,
      FONT_FIELDS,
      sized((family) => SAMPLE[family] ?? 'Hg'),
    ),
    [],
  )
})

test('the glyph box moves with textBaseline like Chrome', (t) => {
  // Every run's glyphs count (HanT's "中文Hg" is two runs). On Windows,
  // which keeps FreeType, Harmattan's 13px glyph boxes are one pixel taller
  // than Chrome's (Fontations).
  const freetype = process.platform !== 'darwin' && process.platform !== 'linux'
  const out = mismatches(
    FIXTURE.baselines,
    [...X_FIELDS, ...INK_FIELDS],
    sized((family) => SAMPLE[family] ?? 'Hg'),
  ).filter((line) => !freetype || !/^HarmattanT 13 \w+ actualBoundingBoxAscent:/.test(line))
  t.deepEqual(out, [])
})

test('tiny web fonts round the ascent and descent like Chrome', (t) => {
  t.deepEqual(
    mismatches(
      FIXTURE.tiny,
      [...FONT_FIELDS, ...INK_FIELDS],
      sized(() => 'Hg'),
    ),
    [],
  )
})

// Blink keeps the fractional ascent and descent of an installed font below
// 3px (FontMetrics::AscentDescentWithHacks); the reference is DejaVu Sans.
const installedTest = GlobalFonts.has('DejaVu Sans') ? test : test.skip
installedTest('tiny installed fonts keep a fractional ascent and descent like Chrome', (t) => {
  t.deepEqual(
    mismatches(
      FIXTURE.installed,
      FONT_FIELDS,
      sized(() => 'Hg'),
    ),
    [],
  )
})

const FONTS_DIR = mkdtempSync(join(tmpdir(), 'napi-rs-canvas-fonts-'))
test.after.always(() => rmSync(FONTS_DIR, { recursive: true, force: true }))

test('a font loaded from a directory is an installed font', (t) => {
  // Oswald's ascent and descent are 1.193 and 0.289 em (OS/2 and hhea): at
  // 2px an installed font keeps the fractions, a registered (web) font
  // rounds them, like the DejaVu Sans and LatoT rows above.
  const oswald = join(__dirname, 'fonts', 'Oswald.ttf')
  copyFileSync(oswald, join(FONTS_DIR, 'Oswald.ttf'))
  t.is(GlobalFonts.loadFontsFromDir(FONTS_DIR), 1)
  GlobalFonts.registerFromPath(oswald, 'OswaldWeb')
  const metrics = (family: string) => {
    const m = measure(`2px ${family}`, 'alphabetic', 'Hg')
    return [m.fontBoundingBoxAscent, m.fontBoundingBoxDescent].map((v) => Math.round(v * 1000) / 1000)
  }
  t.deepEqual(metrics('Oswald'), [2.386, 0.578])
  t.deepEqual(metrics('OswaldWeb'), [2, 1])
})

test('measureText of the empty string keeps the font metrics like Chrome', (t) => {
  t.deepEqual(
    mismatches(FIXTURE.empty, [...X_FIELDS, ...FONT_FIELDS, ...INK_FIELDS], (key) => {
      const [, family, size, baseline] = BASELINE.exec(key)!
      return { font: `${size}px ${family}`, baseline, text: '' }
    }),
    [],
  )
})

test('TextMetrics fields are -0 where Chrome has -0', (t) => {
  const actual: Record<string, string> = {}
  for (const key of Object.keys(FIXTURE.negativeZero)) {
    const [, font, text, baseline] = /^(\S+ \w+) (".*") (\w+)$/.exec(key)!
    const m = measure(font, baseline, JSON.parse(text)) as unknown as Record<string, number>
    actual[key] = FIXTURE.keys.filter((field) => Object.is(m[field], -0)).join(',')
  }
  t.deepEqual(actual, FIXTURE.negativeZero)
})

test('the first family gives the font metrics, whichever font draws the text', (t) => {
  t.deepEqual(
    mismatches(FIXTURE.primary, [...FONT_FIELDS, ...INK_FIELDS], (key) => {
      const [, font, text, baseline] = /^(.*, \w+) (\S+) (\w+)$/.exec(key)!
      return { font, baseline, text }
    }),
    [],
  )
})

test('emHeight is the OS/2 typo box at the font size like Chrome', (t) => {
  const out: string[] = []
  for (const [key, expected] of Object.entries(FIXTURE.em)) {
    const [, family, text, size, baseline] = /^(\w+) (".*") ([\d.]+) (\w+)$/.exec(key)!
    const m = measure(`${size}px ${family}`, baseline, JSON.parse(text))
    if (!(Math.abs(m.emHeightAscent - expected[0]) <= 1e-3 && Math.abs(m.emHeightDescent - expected[1]) <= 1e-3)) {
      out.push(`${key}: ${m.emHeightAscent} ${m.emHeightDescent} (Chrome ${expected})`)
    }
  }
  t.deepEqual(out, [])
})

function inkBox(data: Uint8ClampedArray, width: number, height: number) {
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
  return [left, top, right, bottom]
}

;(PIXEL_PINS ? test : test.skip)('fillText paints the glyphs at the textBaseline like Chrome', (t) => {
  const actual: Record<string, Row> = {}
  for (const key of Object.keys(FIXTURE.ink)) {
    const ctx = createCanvas(200, 160).getContext('2d')
    const yRow = /^(\w+) top y([\d.]+)$/.exec(key)
    if (yRow) {
      ctx.font = `40px ${yRow[1]}`
      ctx.textBaseline = 'top'
      ctx.fillText('Hg', 10, Number(yRow[2]))
    } else {
      const [family, baseline] = key.split(' ')
      ctx.font = `40px ${family}`
      ctx.textBaseline = baseline as CanvasTextBaseline
      ctx.fillText(family === 'HanT' ? '中H' : 'Hg', 10.25, 80)
    }
    actual[key] = inkBox(ctx.getImageData(0, 0, 200, 160).data, 200, 160)
  }
  t.deepEqual(actual, FIXTURE.ink)
})
