// fontFeatureSettings, fontVariantLigatures, fontVariantNumeric and
// fontVariantPosition against Chrome 157. Chrome's canvas has none of these
// attributes, but it applies the CSS longhands set on the <canvas> element;
// the fixture comes from that (canvas + element CSS). Blink's feature order
// (FontFeatureRange::FromFontDescription): caps, kern 0, the ligature rules,
// numeric, font-feature-settings, position; a later feature wins.
//
// gsubtest-lookup1.otf has one GSUB lookup per tag: a char is 2304 units
// wide when its tag is on, 2299 when off, so each tag reads from a width.
// gsubtest-lookup3.otf: a "liga" alternate char turns into the 2299-unit
// glyph when the liga value picks it. These hold on every OS and with both
// text renderers. The real-font widths are pinned on macOS.
import './use-system-text-renderer'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts, setTextRenderer, SvgExportFlag, type SKRSContext2D } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type Props = Partial<Record<string, string>>
interface Case {
  css: Props
  ctx: Props
}
const FIXTURE: {
  fonts: Record<string, string>
  chars: { lookup1: Record<string, number>; lookup3: Record<string, number> }
  lookup1: Record<string, Case & { on: string[] }>
  lookup3: Record<string, Case & { pass: string[] }>
  darwin: { widths: Record<string, Case & { font: string; text: string; width: number }> }
} = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'font-features.json'), 'utf8'))

for (const [family, file] of Object.entries(FIXTURE.fonts)) {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', file), family)
}

// DESIGN D10: skparagraph appends `liga 0` to every block with a positive
// letter spacing (OneLineShaper.cpp), after font-feature-settings, so
// `"liga"` cannot turn liga back on there. Chrome turns it on. The Blink
// shaper (NAPI_RS_CANVAS_SHAPER=blink, DESIGN-SHAPER.md S4) puts letter
// spacing's `liga 0` before font-feature-settings, as Blink's
// FontFeatureRange::FromFontDescription does, and matches Chrome; the old
// path still differs until the shaper is the default (S9).
const D10_LOOKUP1 = ['ls 1px + ffs liga,dlig,calt,clig,hlig']
const D10_WIDTHS = ['Lato fi ls 1px + ffs liga @40', 'Lato fi ls 1px + ffs liga @100']
const BLINK = process.env.NAPI_RS_CANVAS_SHAPER === 'blink'
const d10Test = BLINK ? test.serial : test.serial.failing

// The six go on the context (Chrome: element CSS), then the font and the
// context attributes, as the capture did.
function context(font: string, c: Case) {
  const ctx = createCanvas(10, 10).getContext('2d')
  Object.assign(ctx, c.css)
  ctx.font = font
  Object.assign(ctx, c.ctx)
  return ctx
}

function spacing(c: Case) {
  return c.ctx.letterSpacing ? parseFloat(c.ctx.letterSpacing) : 0
}

function lookup1On(c: Case) {
  const ctx = context('200px GsubOne', c)
  return Object.keys(FIXTURE.chars.lookup1).filter(
    (tag) => ctx.measureText(String.fromCodePoint(FIXTURE.chars.lookup1[tag])).width - spacing(c) > 460.3,
  )
}

function lookup3Pass(c: Case) {
  const ctx = context('200px GsubThree', c)
  return Object.keys(FIXTURE.chars.lookup3).filter(
    (alt) => ctx.measureText(String.fromCodePoint(FIXTURE.chars.lookup3[alt])).width < 460.3,
  )
}

function mismatches(names: string[]) {
  const out: string[] = []
  for (const name of names) {
    const chrome = FIXTURE.lookup1[name]
    const on = lookup1On(chrome)
    if (on.join(' ') !== chrome.on.join(' ')) {
      out.push(`${name}: ${on.join(' ')} (Chrome ${chrome.on.join(' ')})`)
    }
  }
  return out
}

// Runs `fn` with each text renderer; the spec runs with 'system'.
function withBothRenderers(fn: (renderer: string) => void) {
  try {
    for (const renderer of ['system', 'portable'] as const) {
      setTextRenderer(renderer)
      fn(renderer)
    }
  } finally {
    setTextRenderer('system')
  }
}

test.serial('the features that fire in gsubtest-lookup1 match Chrome', (t) => {
  const names = Object.keys(FIXTURE.lookup1).filter((name) => !D10_LOOKUP1.includes(name))
  t.true(names.length >= 50)
  withBothRenderers((renderer) => {
    t.deepEqual(mismatches(names), [], renderer)
  })
})

test.serial('font-feature-settings values pick the gsubtest-lookup3 alternate like Chrome', (t) => {
  withBothRenderers((renderer) => {
    const out = Object.entries(FIXTURE.lookup3)
      .map(([name, chrome]) => [name, lookup3Pass(chrome).join(' '), chrome.pass.join(' ')])
      .filter(([, ours, chrome]) => ours !== chrome)
      .map(([name, ours, chrome]) => `${name}: ${ours} (Chrome ${chrome})`)
    t.deepEqual(out, [], renderer)
  })
})

d10Test('D10: "liga" turns liga back on with a positive letterSpacing like Chrome', (t) => {
  t.deepEqual(mismatches(D10_LOOKUP1), [])
})

function widthMismatches(names: string[]) {
  return names
    .map((name) => {
      const chrome = FIXTURE.darwin.widths[name]
      return [name, chrome.width, context(chrome.font, chrome).measureText(chrome.text).width] as const
    })
    .filter(([, chrome, ours]) => !(Math.abs(ours - chrome) <= 1e-3))
    .map(([name, chrome, ours]) => `${name}: ${ours} (Chrome ${chrome})`)
}

test.serial('real-font widths match Chrome on macOS', (t) => {
  if (process.platform !== 'darwin') {
    t.pass('Chrome widths are pinned on macOS')
    return
  }
  const names = Object.keys(FIXTURE.darwin.widths).filter((name) => !D10_WIDTHS.includes(name))
  t.deepEqual(widthMismatches(names), [])
})

d10Test('D10: Lato fi with letterSpacing 1px and "liga" is a ligature like Chrome', (t) => {
  if (process.platform !== 'darwin') {
    // test.serial.failing needs a failure off macOS too.
    if (BLINK) {
      t.pass('Chrome widths are pinned on macOS')
    } else {
      t.fail('Chrome widths are pinned on macOS')
    }
    return
  }
  t.deepEqual(widthMismatches(D10_WIDTHS), [])
})

test.serial('each property is part of the layout cache key', (t) => {
  // One context and one text: a cached line of another setting must not be
  // reused.
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = '200px GsubOne'
  const width = (tag: string) => ctx.measureText(String.fromCodePoint(FIXTURE.chars.lookup1[tag])).width
  const toggles: [keyof SKRSContext2D, string, string][] = [
    ['fontFeatureSettings', '"ss01"', 'ss01'],
    ['fontFeatureSettings', '"liga" 0', 'liga'],
    ['fontVariantLigatures', 'discretionary-ligatures', 'dlig'],
    ['fontVariantLigatures', 'historical-ligatures', 'hlig'],
    ['fontVariantLigatures', 'no-common-ligatures', 'liga'],
    ['fontVariantLigatures', 'no-contextual', 'calt'],
    ['fontVariantNumeric', 'tabular-nums', 'tnum'],
    ['fontVariantNumeric', 'slashed-zero', 'zero'],
    ['fontVariantPosition', 'sub', 'subs'],
    ['fontVariantPosition', 'super', 'sups'],
  ]
  for (const [prop, value, tag] of toggles) {
    const before = width(tag)
    Object.assign(ctx, { [prop]: value })
    const after = width(tag)
    t.true(Math.abs(after - before) > 0.5, `${prop} = ${value}`)
    ctx.reset()
    ctx.font = '200px GsubOne'
    t.is(width(tag), before, `${prop} reset`)
  }
})

test.serial('fillText and measureText agree on the features', (t) => {
  // "liga" 0 on Lato "fi": the ligature glyph goes, so the ink is wider.
  const ink = (ffs: string) => {
    const canvas = createCanvas(200, 120)
    const ctx = canvas.getContext('2d')
    ctx.fontFeatureSettings = ffs
    ctx.font = '100px FFLato'
    ctx.fillText('fi', 10, 100)
    const { data } = ctx.getImageData(0, 0, 200, 120)
    let right = 0
    for (let x = 0; x < 200; x++) {
      for (let y = 0; y < 120; y++) {
        if (data[(y * 200 + x) * 4 + 3] > 0) {
          right = x
        }
      }
    }
    return [right, ctx.measureText('fi').width]
  }
  const [ligRight, ligWidth] = ink('normal')
  const [plainRight, plainWidth] = ink('"liga" 0')
  t.true(plainWidth > ligWidth + 1)
  t.true(plainRight > ligRight)
})

test.serial('SVG export: "liga" 0 changes the exported glyph run', (t) => {
  const svg = (ffs: string) => {
    const canvas = createCanvas(200, 120, SvgExportFlag.ConvertTextToPaths)
    const ctx = canvas.getContext('2d')
    ctx.fontFeatureSettings = ffs
    ctx.font = '100px FFLato'
    ctx.fillText('fi', 10, 100)
    return canvas.getContent().toString()
  }
  const ligature = svg('normal')
  t.is(svg('"liga" 1'), ligature)
  t.not(svg('"liga" 0'), ligature)
})
