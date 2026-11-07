// The Blink shaper's accept and reject counters (DESIGN-SHAPER.md D40):
// with NAPI_RS_CANVAS_SHAPER=blink, every request the current stage covers
// is laid out by the shaper, and each request it does not cover yet is
// counted under its reason and laid out by the old path. Also the guard that
// the text caches never change while the shaper holds references into them.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts, setTextRenderer } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const binding = require('../js-binding.js') as { __shaperStats(reset: boolean): string }

interface Stats {
  accepted: number
  rejected: number[]
  cacheChanges: number
}

function stats(): Stats {
  return JSON.parse(binding.__shaperStats(true))
}

// skia-c/shaper.hpp ShaperReject.
const REASONS = ['notImplemented', 'letterSpacing', 'wordSpacing', 'caps', 'faceSizes', 'fallback', 'variationSelector']

function rejected(s: Stats) {
  return Object.fromEntries(s.rejected.flatMap((n, i) => (n ? [[REASONS[i] ?? String(i), n]] : [])))
}

const BLINK = process.env.NAPI_RS_CANVAS_SHAPER === 'blink'

for (const [family, file] of [
  ['StatsLato', 'Lato-Regular.ttf'],
  ['StatsSerif', 'SourceSerifPro-Regular.ttf'],
  ['StatsGaramond', 'EBGaramond-Regular.ttf'],
  ['StatsMono', 'RobotoMono-VariableFont_wght.ttf'],
  ['StatsHan', 'SourceHanSerifCN-Bold.ttf'],
]) {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', file), family)
}

// A text and settings the layout cache has not seen.
let serial = 0
function measure(font: string, text: string, props: Record<string, string> = {}) {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = font
  Object.assign(ctx, props)
  return ctx.measureText(`${text}${' '.repeat(serial++ % 3)}`)
}

const LATIN = [
  'Hello world',
  'AVATAR Ta To We',
  'office affine fi fl ffi',
  'The quick brown fox jumps over the lazy dog',
  '1234567890',
  'x.y,z; (a) [b] {c}',
  'Wörld Ünïcödé',
  ' leading and trailing ',
]

test.serial(
  'every Latin request without spacing, caps, font-size-adjust or fallback is laid out by the shaper',
  (t) => {
    stats()
    let count = 0
    for (const renderer of ['portable', 'system'] as const) {
      setTextRenderer(renderer)
      for (const font of ['40px StatsLato', '13px StatsSerif', 'bold 24px StatsGaramond', 'italic 30px StatsMono']) {
        for (const text of LATIN) {
          for (const props of [
            {},
            { direction: 'rtl' },
            { fontKerning: 'none' },
            { textRendering: 'optimizeLegibility' },
            { lang: 'tr' },
            { fontVariantLigatures: 'none' },
          ]) {
            t.true(measure(font, text, props).width > 0)
            count++
          }
        }
      }
    }
    setTextRenderer('system')
    const s = stats()
    if (BLINK) {
      t.deepEqual(rejected(s), {})
      t.is(s.accepted, count)
    } else {
      t.deepEqual(s, { accepted: 0, rejected: Array.from({ length: 16 }, () => 0), cacheChanges: 0 })
    }
    t.is(s.cacheChanges, 0)
  },
)

test.serial('each request the shaper cannot lay out yet is counted under its reason', (t) => {
  stats()
  const cases: [string, string, Record<string, string>, string][] = [
    ['40px StatsLato', 'Hello', { letterSpacing: '2px' }, 'letterSpacing'],
    ['40px StatsLato', 'Hello', { wordSpacing: '2px' }, 'wordSpacing'],
    ['40px StatsLato', 'Hello', { fontVariantCaps: 'small-caps' }, 'caps'],
    ['40px StatsLato, StatsHan', 'Hello', { fontSizeAdjust: '0.5' }, 'faceSizes'],
    ['40px StatsLato', '', {}, 'fallback'],
    ['40px StatsLato', 'a️b', {}, 'variationSelector'],
  ]
  for (const [font, text, props, reason] of cases) {
    measure(font, text, props)
    const s = stats()
    if (BLINK) {
      t.deepEqual(rejected(s), { [reason]: 1 }, reason)
      t.is(s.accepted, 0, reason)
    } else {
      t.deepEqual(rejected(s), {}, reason)
    }
  }
})

test.serial('text in two families is laid out by the shaper', (t) => {
  stats()
  t.true(measure('40px StatsLato, StatsHan', 'Hamburgefonstiv水Hamburgefonstiv').width > 0)
  t.true(measure('40px StatsLato, StatsHan', '水 water').width > 0)
  const s = stats()
  t.deepEqual(rejected(s), {})
  t.is(s.accepted, BLINK ? 2 : 0)
})

test.serial('the text caches never change during a layout, also when a layout passes the font argument budget', (t) => {
  stats()
  // Each line has its own wght, so its own font argument list: the 257th
  // list passes the budget (skiac_font_collection::kMaxFontArguments) inside
  // a layout, and the caches are dropped only after it.
  const widths: number[] = []
  for (let i = 0; i < 300; i++) {
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = `${100 + i} 16px StatsMono, StatsHan`
    widths.push(ctx.measureText('a水').width)
  }
  const s = stats()
  t.is(s.cacheChanges, 0)
  t.deepEqual(rejected(s), {})
  t.is(s.accepted, BLINK ? 300 : 0)
  t.true(widths.every((w) => w > 0))
})
