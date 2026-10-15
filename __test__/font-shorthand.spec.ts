// The canvas `font` attribute against Chrome 155 (detached <canvas> in a
// standards-mode page, CPU canvas). Blink parses the value as the CSS `font`
// shorthand and the getter serializes the computed font
// (base_rendering_context_2d.cc font()). The fixture rows were measured on
// macOS arm64, macOS x64 and Linux x64 Chrome.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface Fixture {
  start: string
  cases: [string, string | null][]
  viewport: [string, string][]
  perOs: { input: string; darwin: string | null; linux: string | null }[]
  sideEffects: Record<string, unknown>
  capsSetter: Record<string, unknown>
  defaults: string[]
  saveRestore: string
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'font-shorthand.json'), 'utf8'),
)

GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Oswald.ttf'), 'OswaldShorthand')

function fontAfter(input: string) {
  const ctx = createCanvas(1, 1).getContext('2d')
  ctx.font = FIXTURE.start
  ctx.font = input
  return ctx.font
}

test(`font getter matches Chrome for ${FIXTURE.cases.length} shorthand values`, (t) => {
  t.deepEqual(
    FIXTURE.cases.map(([input]) => [input, fontAfter(input)]),
    FIXTURE.cases.map(([input, expected]) => [input, expected ?? FIXTURE.start]),
  )
})

test('viewport and container units in font are 0, like an OffscreenCanvas', (t) => {
  t.deepEqual(
    FIXTURE.viewport.map(([input]) => [input, fontAfter(input)]),
    FIXTURE.viewport,
  )
})

test('BlinkMacSystemFont is system-ui only on macOS', (t) => {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  t.deepEqual(
    FIXTURE.perOs.map(({ input }) => [input, fontAfter(input)]),
    FIXTURE.perOs.map((row) => [row.input, row[os] ?? FIXTURE.start]),
  )
})

test('font resets fontStretch and fontVariantCaps and keeps the other text settings', (t) => {
  const actual: Record<string, unknown> = {}
  for (const font of Object.keys(FIXTURE.sideEffects).filter((key) => key !== 'sameString')) {
    const ctx = createCanvas(1, 1).getContext('2d')
    ctx.fontKerning = 'none'
    ctx.fontStretch = 'expanded'
    ctx.fontVariantCaps = 'all-small-caps'
    ctx.letterSpacing = '3px'
    ctx.wordSpacing = '2px'
    ctx.textRendering = 'optimizeSpeed'
    ctx.font = font
    actual[font] = {
      font: ctx.font,
      kerning: ctx.fontKerning,
      stretch: ctx.fontStretch,
      caps: ctx.fontVariantCaps,
      ls: ctx.letterSpacing,
      ws: ctx.wordSpacing,
      tr: ctx.textRendering,
    }
  }
  // Setting the same string again resets them too.
  const ctx = createCanvas(1, 1).getContext('2d')
  ctx.font = '12px serif'
  ctx.fontStretch = 'expanded'
  ctx.fontVariantCaps = 'unicase'
  ctx.font = '12px serif'
  actual.sameString = [ctx.font, ctx.fontStretch, ctx.fontVariantCaps]
  t.deepEqual(actual, FIXTURE.sideEffects)
})

test('font getter shows small-caps only for fontVariantCaps small-caps', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d')
  ctx.font = 'bold 12px serif'
  ctx.fontVariantCaps = 'small-caps'
  const afterCaps = ctx.font
  ctx.fontVariantCaps = 'all-small-caps'
  const afterAllCaps = ctx.font
  ctx.fontStretch = 'condensed'
  const afterStretch = ctx.font
  ctx.font = 'italic small-caps 900 condensed 20px serif'
  t.deepEqual(
    { afterCaps, afterAllCaps, afterStretch, full: [ctx.font, ctx.fontStretch, ctx.fontVariantCaps] },
    FIXTURE.capsSetter,
  )
})

test('default font and save/restore', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d')
  t.deepEqual([ctx.font, ctx.fontStretch, ctx.fontVariantCaps, ctx.fontKerning], FIXTURE.defaults)
  ctx.font = 'bold 20px serif'
  ctx.save()
  ctx.font = '30px monospace'
  ctx.restore()
  t.is(ctx.font, FIXTURE.saveRestore)
})

test('a weight that is not a multiple of 100 is a weight, not the size', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d')
  ctx.font = '550 40px OswaldShorthand'
  t.is(ctx.font, '550 40px OswaldShorthand')
  const width = ctx.measureText('Hamburg').width
  // Read as a 550px font this was 2128.5 wide; Chrome: 142.56 (a variable
  // font's wght axis, layer C6), between the 400 and 700 widths.
  ctx.font = '40px OswaldShorthand'
  t.true(width < 200, String(width))
  t.true(width >= ctx.measureText('Hamburg').width, String(width))
})
