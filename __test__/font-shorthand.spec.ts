// The canvas `font` attribute against Chrome 155 (detached <canvas> in a
// standards-mode page, CPU canvas). Blink parses the value as the CSS `font`
// shorthand and the getter serializes the computed font
// (base_rendering_context_2d.cc font()). The fixture rows were measured on
// macOS arm64, macOS x64 and Linux x64 Chrome.
import './use-system-text-renderer'

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

// Blink's setLang re-sets a realized font from its own serialization,
// setFont(font()) (base_rendering_context_2d.cc:1161-1175). font() writes
// only `small-caps`, so a lang change sends every other fontVariantCaps and
// fontStretch back to normal; the same lang again is a no-op, and caps set
// after lang is kept. Chrome 157 rows, element canvas = OffscreenCanvas.
interface LangRow {
  id: string
  ops: [string, string][]
  text: string
  chrome: Record<string, string | number>
}

const LANG_RESET: { rows: LangRow[] } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'lang-font-reset.json'), 'utf8'),
)

GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), 'BSLato')
GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'NotoSansNKo-Regular.ttf'), 'BSNKo')
GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'BSSerif')

function runLangRow(row: LangRow) {
  const ctx = createCanvas(300, 100).getContext('2d') as unknown as Record<string, unknown> & {
    save(): void
    restore(): void
    measureText(text: string): TextMetrics
  }
  for (const [key, value] of row.ops) {
    if (key === 'save') ctx.save()
    else if (key === 'restore') ctx.restore()
    else ctx[key] = value
  }
  return {
    w: ctx.measureText(row.text).width,
    caps: ctx.fontVariantCaps,
    stretch: ctx.fontStretch,
    kern: ctx.fontKerning,
    ls: ctx.letterSpacing,
    ws: ctx.wordSpacing,
    tr: ctx.textRendering,
    font: ctx.font,
    lang: ctx.lang,
  }
}

test(`a lang change re-sets the font like Blink (${LANG_RESET.rows.length} Chrome rows)`, (t) => {
  const getters = ({ w: _w, ...rest }: Record<string, unknown>) => rest
  t.deepEqual(
    LANG_RESET.rows.map((row) => [row.id, getters(runLangRow(row))]),
    LANG_RESET.rows.map((row) => [row.id, getters(row.chrome)]),
  )
})

test('widths after a lang change match Chrome', (t) => {
  // Left out: 40px BSLato alone (no U+0130, so tr caps falls back to a
  // system font), the default 10px sans-serif of a fresh context, and the
  // unfloored 14.999999px row with no lang (the portable renderer is off by
  // 0.04 there before any lang change).
  const portable = (row: LangRow) =>
    !row.id.startsWith('40px BSLato |') && !row.id.startsWith('fresh ctx') && row.id !== '14.999999px BSLato only'
  const rows = LANG_RESET.rows.filter(portable)
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-3
  t.deepEqual(
    rows.filter((row) => !close(runLangRow(row).w, row.chrome.w as number)).map((row) => [row.id, runLangRow(row).w]),
    [],
  )
  const width = (id: string) => LANG_RESET.rows.find((row) => row.id === id)!.chrome.w as number
  // The plan's rows: caps then lang is plain iI; lang then caps keeps caps.
  t.true(close(width('40px BSLato, BSNKo | caps=all-small-caps then lang=tr'), 22.52))
  t.true(close(width('40px BSLato, BSNKo | caps=all-small-caps then lang=en'), 22.52))
  t.true(close(width('40px BSLato, BSNKo | lang=tr then caps=all-small-caps'), 18.088))
  t.true(close(width('40px BSLato, BSNKo | lang=en then caps=all-small-caps'), 17.192))
  t.true(close(width('40px BSSerif | caps=all-small-caps then lang=en'), 26.76))
  t.true(close(width('40px BSSerif | lang=en then caps=all-small-caps'), 29.04))
  t.is(rows.length, 102)
})
