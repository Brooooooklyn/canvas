// Which family a canvas font uses, against Chrome 155 (CPU canvas, standards
// mode page): family names match like Blink's FontFaceCache (Unicode case
// folding), generic families use Chrome's per-platform font settings, a
// family the platform does not have is skipped, and the standard font comes
// last (font_fallback_list.cc GetFontData). The font-relative units of the
// font shorthand come from the default style's font
// (canvas_font_cache.cc CreateDefaultFontStyle).
import './use-system-fonts'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type Os = 'darwin' | 'linux'

interface Fixture {
  generic: Record<Os, Record<string, number>>
  defaultFont: Record<Os, number>
  fold: Record<string, Record<Os, number>>
  linuxFamilies: string[]
}

interface Shorthand {
  start: string
  fontRelative: { input: string; darwin: string; linux: string }[]
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'generic-families.json'), 'utf8'),
)
const SHORTHAND: Shorthand = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'font-shorthand.json'), 'utf8'),
)

// The Chrome Linux reference had DejaVu Sans, Sans Mono and Serif only; with
// other fonts installed fontconfig and the metric-compatible names pick others.
const SYSTEM_FAMILIES = GlobalFonts.families.map((f) => f.family)
const DEJAVU_ONLY =
  process.platform === 'linux' &&
  FIXTURE.linuxFamilies.every((name) => SYSTEM_FAMILIES.includes(name)) &&
  SYSTEM_FAMILIES.every((name) => FIXTURE.linuxFamilies.includes(name))
const OS: Os | null = process.platform === 'darwin' ? 'darwin' : DEJAVU_ONLY ? 'linux' : null

// A Linux test container has no fonts at all (each spec file runs in its own
// process), so a family that is not found would fall back to the only font
// this file registers, Lato, and the tests below could not tell. There,
// Source Serif Pro stands in for Chrome Linux's standard font (Times New
// Roman, the -webkit-standard setting), which every lookup ends with.
if (!(width('20px serif', 'Hamburg') > 0)) {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'Times New Roman')
}

const LATO = join(__dirname, 'fonts', 'Lato-Regular.ttf')
for (const alias of ['LatoT', 'ÄLatoT', 'StraßeT', 'KelvinT']) {
  GlobalFonts.registerFromPath(LATO, alias)
}

function width(font: string, text: string) {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = font
  return ctx.measureText(text).width
}

function near(actual: number, expected: number) {
  return Math.abs(actual - expected) <= 0.01
}

test.serial('font family names match with Unicode case folding, like Chrome', (t) => {
  const lato = width('20px LatoT', 'Hamburg')
  const mismatches: string[] = []
  for (const [font, expected] of Object.entries(FIXTURE.fold)) {
    const actual = width(font, 'Hamburg')
    // Rows that find Lato are the same on every platform; the others fall
    // back to the platform's standard font.
    const pinned = near(expected.darwin, expected.linux) ? expected.darwin : OS ? expected[OS] : null
    const ok = pinned === null ? !near(actual, lato) : near(actual, pinned)
    if (!ok) {
      mismatches.push(`${font}: ${actual} (Chrome ${pinned ?? 'not Lato'})`)
    }
  }
  t.deepEqual(mismatches, [])
})

test.serial('a family registered after a lookup is found in any case', (t) => {
  const before = width('20px LATEREGISTERED', 'Hamburg')
  GlobalFonts.registerFromPath(LATO, 'LateRegistered')
  const after = width('20px LATEREGISTERED', 'Hamburg')
  t.false(near(before, after), String(before))
  t.true(near(after, FIXTURE.fold['20px LatoT'].darwin), String(after))
})

const genericTest = OS ? test.serial : test.serial.skip
genericTest(`generic families and family lists follow Chrome (${OS ?? 'no reference'})`, (t) => {
  const rows = FIXTURE.generic[OS!]
  const mismatches: string[] = []
  for (const [family, expected] of Object.entries(rows)) {
    const actual = width(`20px ${family}`, 'Hamburgefonstiv a b')
    if (!near(actual, expected)) {
      mismatches.push(`${family}: ${actual} (Chrome ${expected})`)
    }
  }
  t.deepEqual(mismatches, [])
})

genericTest('the default font is the platform sans-serif', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  const actual = ctx.measureText('Hamburgefonstiv a b').width
  t.true(near(actual, FIXTURE.defaultFont[OS!]), String(actual))
})

// macOS Chrome reads x-height and line spacing through CoreText (and grows
// the Times ascent by 15%); our FreeType metrics give other ex and lh values
// there, so on macOS only the advance- and cap-height-based units are pinned.
const ENGINE_INDEPENDENT = /^1r?(ch|cap|ic) /
genericTest('font-relative units in the font shorthand use the default font', (t) => {
  const rows = SHORTHAND.fontRelative.filter((row) => OS === 'linux' || ENGINE_INDEPENDENT.test(row.input))
  const actual = rows.map(({ input }) => {
    const ctx = createCanvas(1, 1).getContext('2d')
    ctx.font = SHORTHAND.start
    ctx.font = input
    return [input, ctx.font]
  })
  t.deepEqual(
    actual,
    rows.map((row) => [row.input, row[OS!]]),
  )
})

// GlobalFonts is how a Node program sets its generic families: a family
// registered under the keyword is used for it (Chrome reads its font
// settings instead). Last: it changes `cursive` for the rest of this file.
test.serial('a family registered under a generic keyword is used for it', (t) => {
  const lato = width('20px LatoT', 'Hamburgefonstiv a b')
  t.false(near(width('20px cursive', 'Hamburgefonstiv a b'), lato))
  const key = GlobalFonts.registerFromPath(LATO, 'cursive')
  t.true(near(width('20px cursive', 'Hamburgefonstiv a b'), lato))
  t.true(near(width('20px CURSIVE', 'Hamburgefonstiv a b'), lato))
  if (key) {
    GlobalFonts.remove(key)
  }
})
