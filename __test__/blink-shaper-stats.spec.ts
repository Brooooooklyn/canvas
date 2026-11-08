// The Blink shaper's accept and reject counters (DESIGN-SHAPER.md D40):
// with NAPI_RS_CANVAS_SHAPER=blink, every request the current stage covers
// is laid out by the shaper, and each request it does not cover yet is
// counted under its reason and laid out by the old path. Also the guard that
// the text caches never change while the shaper holds references into them.
import { execFileSync } from 'node:child_process'
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
const REASONS = [
  'notImplemented',
  'letterSpacing',
  'wordSpacing',
  'caps',
  'faceSizes',
  'fallback',
  'variationSelector',
  'localeFallback',
]

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

// Stage P2: where the shaper has no system fallback source (the portable
// renderer everywhere; the system renderer off macOS) the system stages find
// no font, as Blink's do on a platform whose fallback returns none, and a
// character no family has draws the first font's .notdef, as the old path
// draws it: no request is turned down for it.
test.serial('a character no family has is laid out by the shaper without a fallback source', (t) => {
  stats()
  setTextRenderer('portable')
  const texts = ['\uE000', '\u{10FFFD}', 'a\uE000b', '水', 'x\u3000y', 'a\u263A\uFE0Fb']
  try {
    for (const text of texts) {
      t.true(measure('40px StatsLato', text).width > 0, text)
      const s = stats()
      t.deepEqual(rejected(s), {}, text)
      t.is(s.accepted, BLINK ? 1 : 0, text)
    }
  } finally {
    setTextRenderer('system')
  }
})

// The same lines with the switch unset (the old path) and on, each in its own
// process (the switch is read once per process): the shaper lays them out
// and gives the old path's widths, on every OS. The system renderer has no
// fallback source off macOS too; on macOS it has CoreText's (stage S3).
test.serial('a character no family has keeps the old path width without a fallback source', (t) => {
  const renderers = process.platform === 'darwin' ? ['portable'] : ['portable', 'system']
  const script = `
    const { createCanvas, GlobalFonts, setTextRenderer } = require(${JSON.stringify(join(__dirname, '..', 'index.js'))})
    const binding = require(${JSON.stringify(join(__dirname, '..', 'js-binding.js'))})
    GlobalFonts.registerFromPath(${JSON.stringify(join(__dirname, 'fonts', 'Lato-Regular.ttf'))}, 'StatsLato')
    GlobalFonts.registerFromPath(${JSON.stringify(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'))}, 'StatsSerif')
    const out = { widths: [], stats: null }
    binding.__shaperStats(true)
    for (const renderer of ${JSON.stringify(renderers)}) {
      setTextRenderer(renderer)
      for (const font of ['40px StatsLato', '13px StatsLato, StatsSerif', 'bold 24px StatsLato', '14.6666667px StatsLato']) {
        for (const text of ['\\uE000', 'a\\uE000b', '\\uE000\\uE001 \\uF8FF', 'Hello \\u{10FFFD} world']) {
          const ctx = createCanvas(10, 10).getContext('2d')
          ctx.font = font
          out.widths.push(ctx.measureText(text).width)
        }
      }
    }
    out.stats = JSON.parse(binding.__shaperStats(true))
    console.log(JSON.stringify(out))`
  const run = (shaper: string) =>
    JSON.parse(
      execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, NAPI_RS_CANVAS_SHAPER: shaper },
        encoding: 'utf8',
        timeout: 20_000,
      }),
    ) as { widths: number[]; stats: Stats }
  const old = run('skparagraph')
  const blink = run('blink')
  t.is(old.stats.accepted, 0)
  t.deepEqual(rejected(blink.stats), {})
  t.is(blink.stats.accepted, blink.widths.length)
  t.true(blink.widths.every((w) => w > 0))
  t.deepEqual(blink.widths, old.widths)
})

// Stage S4: ShapeResultSpacing. Letter and word spacing (positive, negative,
// tiny, in every renderer and direction) are laid out by the shaper: no
// request is turned down for spacing.
test.serial('letter and word spacing are laid out by the shaper', (t) => {
  stats()
  let count = 0
  for (const renderer of ['portable', 'system'] as const) {
    setTextRenderer(renderer)
    for (const text of ['Hello world', ' a  b ', 'office fi', 'q\u0301x', '\u00a0ab\u00a0']) {
      for (const props of [
        { letterSpacing: '2px' },
        { wordSpacing: '3px' },
        { letterSpacing: '-10px', wordSpacing: '-60px' },
        { letterSpacing: '0.0002px', direction: 'rtl' },
        { letterSpacing: '1px', fontFeatureSettings: '"liga"' },
      ]) {
        // Lato has no U+0301: without a family font for it, the line would
        // need the system fallback, which only macOS has on the shaper.
        measure(text.includes('\u0301') ? '40px StatsSerif' : '40px StatsLato', text, props)
        count++
      }
    }
  }
  setTextRenderer('system')
  const s = stats()
  t.deepEqual(rejected(s), {})
  t.is(s.accepted, BLINK ? count : 0)
  t.is(s.cacheChanges, 0)
})

// Stage S5: font-variant-caps per font in the shaping loop. Every value, on
// a font with the caps features (Source Serif: smcp, c2sc; Roboto Mono:
// smcp) and without them (Lato, synthesized), with a fallback family, the
// lang's case mapping, marks, spacing and RTL, is laid out by the shaper: no
// request is turned down for caps.
test.serial('font-variant-caps is laid out by the shaper', (t) => {
  stats()
  let count = 0
  for (const renderer of ['portable', 'system'] as const) {
    setTextRenderer(renderer)
    for (const fontVariantCaps of [
      'small-caps',
      'all-small-caps',
      'petite-caps',
      'all-petite-caps',
      'unicase',
      'titling-caps',
    ]) {
      for (const [font, text, props] of [
        ['40px StatsLato', 'Hello World ß fi 123 Éé', {}],
        ['40px StatsSerif', 'Hello World ß fi 123 Éé', {}],
        ['40px StatsMono', 'aBcDeF', {}],
        ['40px StatsLato, StatsSerif', 'Hello αβγ q\u0301x', {}],
        ['40px StatsLato, StatsHan', 'ab水cd Ef', {}],
        ['40px StatsSerif', 'İstanbul ılık iI', { lang: 'tr' }],
        ['40px StatsSerif', 'άλφα Ωμέγα', { lang: 'el' }],
        ['40px StatsSerif', '\u0301\u0308 Straße', {}],
        ['40px StatsLato', 'Hello World', { letterSpacing: '5px', direction: 'rtl' }],
      ] as [string, string, Record<string, string>][]) {
        measure(font, text, { ...props, fontVariantCaps })
        count++
      }
    }
  }
  setTextRenderer('system')
  const s = stats()
  t.deepEqual(rejected(s), {})
  t.is(s.accepted, BLINK ? count : 0)
  t.is(s.cacheChanges, 0)
})

// Stage S6: each family entry has its own size and opsz (UsedSizes::faces),
// shaped in one pass, and HarfBuzz gets ptem at the specified size. A family
// sized by its own aspect (font-size-adjust, a number and from-font), a
// missing family before it, a variable font's opsz at its own size, and
// font-optical-sizing none (each face's own opsz default with the system
// renderer on Apple) are laid out by the shaper: no request is turned down
// for a per-face size.
test.serial('per-face sizes and opsz are laid out by the shaper', (t) => {
  stats()
  let count = 0
  for (const renderer of ['portable', 'system'] as const) {
    setTextRenderer(renderer)
    for (const [font, text, props] of [
      ['40px StatsLato, StatsSerif', 'ke\u030c Te\u030c', { fontSizeAdjust: '0.5' }],
      ['40px StatsLato, StatsSerif', 'ke\u030c Te\u030c', { fontSizeAdjust: 'from-font' }],
      ['40px NoSuchFamily, StatsLato, StatsSerif', 'ke\u030c', { fontSizeAdjust: '0.5' }],
      ['40px StatsLato, StatsHan', 'Hamburgefonstiv水Hamburgefonstiv', { fontSizeAdjust: 'ex-height 0.6' }],
      ['40px StatsLato, StatsHan', 'Hello 水', { fontSizeAdjust: 'cap-height 0.7', direction: 'rtl' }],
      ['40px StatsMono, StatsSerif', 'ab q\u0301x', { fontSizeAdjust: '0.4', letterSpacing: '2px' }],
      ['40px StatsLato, StatsSerif', 'ke\u030c', { fontSizeAdjust: '0.5', fontVariantCaps: 'small-caps' }],
      ['40px StatsLato, StatsSerif', 'ke\u030c', { fontSizeAdjust: '0.5', fontOpticalSizing: 'none' }],
    ] as [string, string, Record<string, string>][]) {
      t.true(measure(font, text, props).width > 0, `${font} ${text}`)
      count++
    }
  }
  setTextRenderer('system')
  const s = stats()
  t.deepEqual(rejected(s), {})
  t.is(s.accepted, BLINK ? count : 0)
  t.is(s.cacheChanges, 0)
})

// Stage S3: the fallback stages. A variation selector the family fonts can
// shape (also the second pass that ignores it) is laid out by the shaper
// everywhere. With the system renderer on macOS, a character no family has
// goes to CoreText's fallback (or, for private use and non-characters, to the
// first font's .notdef); elsewhere (stage P2) to the first font's .notdef.
// Nothing is turned down.
test.serial('variation selectors and system fallback are laid out by the shaper', (t) => {
  stats()
  // A selector after a character it makes no variation sequence with is not
  // looked at (Character::IsVariationSequence).
  for (const text of ['a\uFE0Fb', 'a\uFE0Eb', '水\uFE00']) {
    t.true(measure('40px StatsLato, StatsHan', text).width > 0, text)
  }
  let s = stats()
  t.deepEqual(rejected(s), {})
  t.is(s.accepted, BLINK ? 3 : 0)
  // U+2205 U+FE00 is a standardized variation sequence: a font with only the
  // base gives kUnmatchedVSGlyphId, and the second pass ignores the selector.
  const fallback = ['\uE000', '\uFFFE', 'שלום', '😀', '⌚\uFE0E', 'a☺️b', 'x\u3000y', 'こんにちは', '\u2205\uFE00']
  for (const text of fallback) {
    measure('40px StatsLato', text)
  }
  s = stats()
  t.deepEqual(rejected(s), {})
  t.is(s.accepted, BLINK ? fallback.length : 0)
  t.is(s.cacheChanges, 0)
})

// Chrome's last family is the standard font of the locale's script
// (-webkit-standard, GenericFontFamilySettings::Standard): on macOS Hiragino
// Kaku Gothic ProN for Japanese, Apple SD Gothic Neo for Korean, PingFang
// SC / TC for Han, Devanagari MT for Devanagari. Since stage S8 the shaper's
// family list has it, so these lines are laid out by the shaper (the old
// localeFallback reason is not used any more).
test.serial('a character the standard font of the lang has is laid out by the shaper', (t) => {
  stats()
  for (const [text, lang] of [
    ['直骨', 'ja'],
    ['ア', 'ja'],
    ['直骨', 'ko'],
    ['直骨', 'zh-CN'],
    ['这们', 'zh-Hant'],
    ['नम', 'hi'],
    ['直骨', 'en-Jpan'],
    ['直骨', 'en-Hang'],
    ['直骨', 'ja-Cyrl'],
    ['这们', 'ja'],
    ['直骨', 'inherit'],
    ['Hello', 'ja'],
  ]) {
    measure('40px StatsLato', text, { lang })
    const s = stats()
    // Off macOS the standard font is not per script and the shaper has no
    // system fallback: a character no family has draws the first font's
    // .notdef (stage P2), also on the shaper.
    t.deepEqual(rejected(s), {}, `${text} ${lang}`)
    t.is(s.accepted, BLINK ? 1 : 0, `${text} ${lang}`)
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
