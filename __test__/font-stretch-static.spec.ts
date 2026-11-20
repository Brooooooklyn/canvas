// Non-variable / static installed font-stretch matching (CSS Fonts L4
// MatchStyleCSS3): exact width 1..9 (fixing Skia's matchStyleCSS3 width > 5
// exact-match bug), directional fallback for <= normal and > normal,
// Width > Style > Weight priority, and unquoted generic alias matching.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { type CanvasFontStretch, createCanvas, GlobalFonts } from '../index'

import { withStaticStyle } from './font-fixtures'

const __dirname = dirname(fileURLToPath(import.meta.url))
const lato = readFileSync(join(__dirname, 'fonts', 'Lato-Regular.ttf'))

const STRETCH_KEYWORDS: readonly CanvasFontStretch[] = [
  'ultra-condensed',
  'extra-condensed',
  'condensed',
  'semi-condensed',
  'normal',
  'semi-expanded',
  'expanded',
  'extra-expanded',
  'ultra-expanded',
]

// Lato has unitsPerEm = 2000; at 40px, advanceM produces exact width 40 * advanceM / 2000.
const widthPx = (advanceM: number) => (40 * advanceM) / 2000

function loadFamily(
  t: import('ava').ExecutionContext,
  family: string,
  faces: { widthClass: number; weightClass?: number; italic?: boolean; advanceM: number }[],
) {
  const dir = mkdtempSync(join(tmpdir(), `canvas-stretch-${family}-`))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  for (const [i, spec] of faces.entries()) {
    writeFileSync(join(dir, `${family}-${i}.ttf`), withStaticStyle(lato, { family, ...spec }))
  }
  t.is(GlobalFonts.loadFontsFromDir(dir), faces.length)
}

function measureM(font: string, stretch?: CanvasFontStretch): number {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = font
  if (stretch !== undefined) {
    ctx.fontStretch = stretch
  }
  return Math.round(ctx.measureText('M').width * 100) / 100
}

test('exact width match for every width 1..9 (including width > 5)', (t) => {
  const faces = Array.from({ length: 9 }, (_, i) => ({
    widthClass: i + 1,
    advanceM: 600 + (i + 1) * 200,
  }))
  loadFamily(t, 'Sw01', faces)

  for (const [i, keyword] of STRETCH_KEYWORDS.entries()) {
    const expected = widthPx(faces[i].advanceM)
    t.is(measureM(`${keyword} 40px "Sw01"`), expected, `shorthand ${keyword} (width ${i + 1})`)
    t.is(measureM('40px "Sw01"', keyword), expected, `fontStretch ${keyword} (width ${i + 1})`)
  }
})

test('directional fallback for width > normal: wider first, then narrower descending', (t) => {
  // Family with {5, 8}: semi-expanded (6) and expanded (7) pick 8 (wider) over 5 (narrower).
  loadFamily(t, 'Sw02', [
    { widthClass: 5, advanceM: 1000 },
    { widthClass: 8, advanceM: 2200 },
  ])
  t.is(measureM('semi-expanded 40px "Sw02"'), widthPx(2200))
  t.is(measureM('expanded 40px "Sw02"'), widthPx(2200))
  t.is(measureM('extra-expanded 40px "Sw02"'), widthPx(2200))
  t.is(measureM('ultra-expanded 40px "Sw02"'), widthPx(2200))
  t.is(measureM('normal 40px "Sw02"'), widthPx(1000))

  // Family with {3, 5}: expanded (7) picks 5 (narrower descending) over 3.
  loadFamily(t, 'Sw03', [
    { widthClass: 3, advanceM: 1200 },
    { widthClass: 5, advanceM: 2400 },
  ])
  t.is(measureM('semi-expanded 40px "Sw03"'), widthPx(2400))
  t.is(measureM('expanded 40px "Sw03"'), widthPx(2400))
  t.is(measureM('ultra-expanded 40px "Sw03"'), widthPx(2400))
})

test('directional fallback for width <= normal: narrower first, then wider ascending', (t) => {
  // Family with {1, 4}: condensed (3) picks 1 (narrower) over 4 (wider).
  loadFamily(t, 'Sw04', [
    { widthClass: 1, advanceM: 1000 },
    { widthClass: 4, advanceM: 2000 },
  ])
  t.is(measureM('condensed 40px "Sw04"'), widthPx(1000))
  t.is(measureM('extra-condensed 40px "Sw04"'), widthPx(1000))
  t.is(measureM('semi-condensed 40px "Sw04"'), widthPx(2000))
  t.is(measureM('normal 40px "Sw04"'), widthPx(2000))

  // Family with {6, 9}: normal (5) picks 6 (wider ascending) over 9.
  loadFamily(t, 'Sw05', [
    { widthClass: 6, advanceM: 1400 },
    { widthClass: 9, advanceM: 2600 },
  ])
  t.is(measureM('normal 40px "Sw05"'), widthPx(1400))
  t.is(measureM('condensed 40px "Sw05"'), widthPx(1400))
  t.is(measureM('ultra-condensed 40px "Sw05"'), widthPx(1400))
})

test('matching priority is Width > Style > Weight', (t) => {
  // (expanded, upright, 400) vs (normal, upright, 700): bold expanded picks (expanded, 400).
  loadFamily(t, 'Sw06', [
    { widthClass: 7, weightClass: 400, italic: false, advanceM: 1200 },
    { widthClass: 5, weightClass: 700, italic: false, advanceM: 2400 },
  ])
  t.is(measureM('bold expanded 40px "Sw06"'), widthPx(1200))
  t.is(measureM('bold 40px "Sw06"'), widthPx(2400))

  // (expanded, upright, 400) vs (normal, italic, 700): italic bold expanded picks (expanded, 400).
  loadFamily(t, 'Sw07', [
    { widthClass: 7, weightClass: 400, italic: false, advanceM: 1300 },
    { widthClass: 5, weightClass: 700, italic: true, advanceM: 2500 },
  ])
  t.is(measureM('italic bold expanded 40px "Sw07"'), widthPx(1300))

  // (normal, italic, 400) vs (normal, upright, 700): italic bold picks (italic, 400).
  loadFamily(t, 'Sw08', [
    { widthClass: 5, weightClass: 400, italic: true, advanceM: 1500 },
    { widthClass: 5, weightClass: 700, italic: false, advanceM: 2700 },
  ])
  t.is(measureM('italic bold 40px "Sw08"'), widthPx(1500))
})

test('unquoted generic alias uses MatchStyleCSS3 for static width > normal faces', (t) => {
  const keys = [6, 7, 8, 9].map((widthClass) => {
    const key = GlobalFonts.register(
      withStaticStyle(lato, { family: `Sg0${widthClass}`, widthClass, advanceM: 800 + widthClass * 200 }),
      'fantasy',
    )
    t.truthy(key)
    return key!
  })
  t.teardown(() => {
    for (const key of keys) {
      GlobalFonts.remove(key)
    }
  })
  t.is(measureM('semi-expanded 40px fantasy'), widthPx(2000))
  t.is(measureM('expanded 40px fantasy'), widthPx(2200))
  t.is(measureM('extra-expanded 40px fantasy'), widthPx(2400))
  t.is(measureM('ultra-expanded 40px fantasy'), widthPx(2600))
})

const STATIC_RENDERER_PROBE = `
  const { createCanvas, GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
  setTextRenderer(process.env.RENDERER)
  GlobalFonts.loadFontsFromDir(process.env.PROBE_DIR)
  const ctx = createCanvas(10, 10).getContext('2d')
  const m = (font) => { ctx.font = font; return Math.round(ctx.measureText('M').width * 100) / 100 }
  const stretches = [
    'ultra-condensed', 'extra-condensed', 'condensed', 'semi-condensed',
    'normal', 'semi-expanded', 'expanded', 'extra-expanded', 'ultra-expanded',
  ]
  console.log(JSON.stringify({
    exact: stretches.map((s) => m(s + ' 40px "Sr01"')),
    wideFallback: [m('semi-expanded 40px "Sr02"'), m('expanded 40px "Sr02"')],
    narrowFallback: [m('condensed 40px "Sr03"'), m('normal 40px "Sr03"')],
  }))`

for (const renderer of ['portable', 'system'] as const) {
  test(`static font-stretch matching works on ${renderer} renderer`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), `canvas-stretch-${renderer}-`))
    t.teardown(() => rmSync(dir, { recursive: true, force: true }))
    for (let w = 1; w <= 9; w++) {
      writeFileSync(
        join(dir, `sr01-${w}.ttf`),
        withStaticStyle(lato, { family: 'Sr01', widthClass: w, advanceM: 600 + w * 200 }),
      )
    }
    writeFileSync(join(dir, 'sr02-5.ttf'), withStaticStyle(lato, { family: 'Sr02', widthClass: 5, advanceM: 1000 }))
    writeFileSync(join(dir, 'sr02-8.ttf'), withStaticStyle(lato, { family: 'Sr02', widthClass: 8, advanceM: 2200 }))
    writeFileSync(join(dir, 'sr03-1.ttf'), withStaticStyle(lato, { family: 'Sr03', widthClass: 1, advanceM: 1000 }))
    writeFileSync(join(dir, 'sr03-4.ttf'), withStaticStyle(lato, { family: 'Sr03', widthClass: 4, advanceM: 2000 }))

    const child = spawnSync(process.execPath, ['-e', STATIC_RENDERER_PROBE], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        RENDERER: renderer,
        PROBE_DIR: dir,
        PROBE_INDEX: join(__dirname, '..', 'index.js'),
      },
    })
    t.is(child.status, 0, child.stderr)
    t.deepEqual(JSON.parse(child.stdout), {
      exact: [16, 20, 24, 28, 32, 36, 40, 44, 48],
      wideFallback: [44, 44],
      narrowFallback: [20, 40],
    })
  })
}

if (process.platform === 'darwin') {
  test('macOS system CoreText named fonts keep width priority after removeAll', (t) => {
    const script = `
      const { createCanvas, GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
      setTextRenderer('system')
      const ctx = createCanvas(400, 100).getContext('2d')
      const m = (font) => {
        ctx.font = font
        return ctx.measureText('HHHHHHHHHH').width
      }
      const beforeNormal = m('40px "Helvetica Neue"')
      const beforeCondensed = m('condensed 40px "Helvetica Neue"')
      GlobalFonts.removeAll()
      const afterNormal = m('40px "Helvetica Neue"')
      const afterCondensed = m('condensed 40px "Helvetica Neue"')
      process.stdout.write(JSON.stringify({ beforeNormal, beforeCondensed, afterNormal, afterCondensed }))
    `
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PROBE_INDEX: join(__dirname, '..', 'index.js') },
    })
    t.is(child.status, 0, child.stderr)
    const { beforeNormal, beforeCondensed, afterNormal, afterCondensed } = JSON.parse(child.stdout)
    t.true(beforeCondensed < beforeNormal)
    t.is(afterNormal, beforeNormal)
    t.is(afterCondensed, beforeCondensed)
  })
}
