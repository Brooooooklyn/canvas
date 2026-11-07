// ctx.lang and ligatures against Chrome 157 (CPU canvas, macOS). Blink adds
// no per-language feature rule: liga, clig and calt follow only
// textRendering, letterSpacing and font-variant-ligatures
// (FontFeatureRange::FromFontDescription). The language reaches HarfBuzz
// (hb_buffer_set_language), so a font's own Turkish or Azerbaijani language
// system decides what changes: EB Garamond and Source Serif Pro swap i for a
// dotted form (locl), which breaks their fi ligature; Lato has no such
// language system and keeps fi. ffl has no i and stays a ligature.
import './use-system-text-renderer'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Chrome was measured on macOS only: the widths are pinned there. Every OS
// checks how the widths relate, which is the same in Chrome everywhere.
const FIXTURE: { darwin: { widths: Record<string, number> } } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'lang-ligatures.json'), 'utf8'),
)

const FONTS: Record<string, string> = {
  LatoT: 'Lato-Regular.ttf',
  GaramondT: 'EBGaramond-Regular.ttf',
  SerifProT: 'SourceSerifPro-Regular.ttf',
}
for (const [family, file] of Object.entries(FONTS)) {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', file), family)
}

const TURKIC = ['tr', 'az', 'tr-TR', 'TR', 'az-Latn-AZ']

function width(family: string, lang: string, text: string) {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.lang = lang
  ctx.font = `100px ${family}`
  return ctx.measureText(text).width
}

test('measureText follows ctx.lang like Chrome', (t) => {
  if (process.platform !== 'darwin') {
    t.pass('Chrome widths are pinned on macOS')
    return
  }
  const out = Object.entries(FIXTURE.darwin.widths)
    .map(([key, chrome]) => {
      const [, family, lang, text] = /^(\S+) (\S+) (".*")$/.exec(key)!
      return [key, chrome, width(family, lang, JSON.parse(text))] as const
    })
    .filter(([, chrome, actual]) => !(Math.abs(actual - chrome) <= 1e-3))
    .map(([key, chrome, actual]) => `${key}: ${actual} (Chrome ${chrome})`)
  t.deepEqual(out, [])
})

test('Turkish keeps the fi ligature of a font without a Turkish locl like Chrome', (t) => {
  const en = width('LatoT', 'en', 'fi')
  // Chrome: 57 for every language; 59.3 is f and i side by side.
  for (const lang of TURKIC) {
    t.true(Math.abs(width('LatoT', lang, 'fi') - en) <= 1e-3, lang)
    t.true(Math.abs(width('LatoT', lang, 'fikir') - width('LatoT', 'en', 'fikir')) <= 1e-3, lang)
  }
})

test("Turkish breaks fi through the font's own locl like Chrome", (t) => {
  for (const family of ['GaramondT', 'SerifProT']) {
    const en = width(family, 'en', 'fi')
    // Chrome: EB Garamond 51.8 en, 63.3 tr; Source Serif Pro 61.7 en, 68.3 tr.
    for (const lang of TURKIC) {
      t.true(width(family, lang, 'fi') > en + 1, `${family} ${lang}`)
      t.true(Math.abs(width(family, lang, 'fi') - width(family, 'tr', 'fi')) <= 1e-3, `${family} ${lang}`)
    }
    t.true(Math.abs(width(family, 'inherit', 'fi') - en) <= 1e-3, family)
  }
})

test('Turkish keeps the ffl ligature like Chrome', (t) => {
  // Chrome: EB Garamond 76.1 and Source Serif Pro 91.5 for every language;
  // without the ligature they are 87.6 and 99.6.
  for (const family of ['LatoT', 'GaramondT', 'SerifProT']) {
    const en = width(family, 'en', 'ffl')
    for (const lang of TURKIC) {
      t.true(Math.abs(width(family, lang, 'ffl') - en) <= 1e-3, `${family} ${lang}`)
    }
  }
})
