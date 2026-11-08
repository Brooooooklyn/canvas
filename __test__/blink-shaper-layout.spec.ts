// Layouts of the Blink shaper that no Chrome capture covers: a character no
// family has without a fallback source, a host without fonts, a line of
// many runs, a registered Type 1 font (Chrome cannot load one), and the text
// caches across a cache drop. These were checked against the old
// (skparagraph) path until it was removed (stage S10); the values here are
// the ones both paths gave (stages/S10/tests.md).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import test from 'ava'

import { createCanvas, GlobalFonts, setTextRenderer } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

for (const [family, file] of [
  ['LayoutLato', 'Lato-Regular.ttf'],
  ['LayoutSerif', 'SourceSerifPro-Regular.ttf'],
  ['LayoutMono', 'RobotoMono-VariableFont_wght.ttf'],
  ['LayoutHan', 'SourceHanSerifCN-Bold.ttf'],
  ['RunsIosevka', 'iosevka-slab-regular.ttf'],
  ['RunsArabic', 'Harmattan-Regular.ttf'],
  ['LayoutType1A', 'Roboto2-Regular.pfa'],
]) {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', file), family)
}
GlobalFonts.register(readFileSync(join(__dirname, 'fonts', 'Roboto2-Regular.pfb')), 'LayoutType1B')

interface LineDump {
  runs: { family: string; glyphs: number[] }[]
}

function context(font: string, props: Record<string, string> = {}, width = 10, height = 10) {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.font = font
  Object.assign(ctx, props)
  return ctx
}

function dump(ctx: ReturnType<typeof context>, text: string): LineDump {
  return JSON.parse((ctx as unknown as { __debugTextLine(text: string): string }).__debugTextLine(text))
}

const near = (a: number, b: number, tolerance = 1e-3) => Math.abs(a - b) <= tolerance

// Stage P2: where the shaper has no system fallback source (the portable
// renderer everywhere; the system renderer off macOS) the system stages find
// no font, as Blink's do on a platform whose fallback returns none, and a
// character no family has draws the first font's .notdef (glyph 0), as the
// old path drew it. The portable widths are the old path's (and the
// shaper's) on macOS 27.2.
test.serial('a character no family has draws the first font .notdef without a fallback source', (t) => {
  const FONTS = ['40px LayoutLato', '13px LayoutLato, LayoutSerif', 'bold 24px LayoutLato', '14.6666667px LayoutLato']
  const TEXTS = ['\uE000', 'a\uE000b', '\uE000\uE001 \uF8FF', 'Hello \u{10FFFD} world']
  const PORTABLE = [
    [21.259979248046875, 63.89994812011719, 71.49992370605469, 232.219757],
    [6.9095001220703125, 20.76751708984375, 23.237503, 75.47157287597656],
    [12.756088256835938, 38.34027099609375, 42.900299072265625, 139.3330078125],
    [7.789703369140625, 23.4130859375, 26.197738647460938, 85.08583068847656],
  ]
  const renderers = process.platform === 'darwin' ? ['portable'] : ['portable', 'system']
  try {
    for (const renderer of renderers) {
      setTextRenderer(renderer as 'portable' | 'system')
      for (const [f, font] of FONTS.entries()) {
        for (const [i, text] of TEXTS.entries()) {
          const ctx = context(font)
          const width = ctx.measureText(text).width
          const name = `${renderer} ${font} ${JSON.stringify(text)}`
          t.true(width > 0, name)
          if (renderer === 'portable') {
            t.true(near(width, PORTABLE[f][i]), `${name}: ${width} (${PORTABLE[f][i]})`)
          }
          const runs = dump(ctx, text).runs
          t.true(
            runs.every((run) => run.family === 'Lato'),
            `${name}: ${runs.map((run) => run.family)}`,
          )
          const notdefs = runs.flatMap((run) => run.glyphs).filter((glyph) => glyph === 0).length
          t.is(notdefs, [...text.matchAll(/\p{Co}/gu)].length, name)
        }
      }
    }
  } finally {
    setTextRenderer('system')
  }
})

// Stage S9: a process with no registered font and no installed fonts
// (DISABLE_SYSTEM_FONTS_LOAD; on a host without fonts the same holds for the
// portable renderer). The family matching still gives a face, the default
// font manager's empty typeface (FontCollection::findTypefaces), so the
// shaper lays the line out with it as its last resort font, as Blink's
// FontFallbackList always ends in one. The empty typeface has no glyph and
// no ink: a line without ink is 0 wide (the old path left FLT_MIN,
// 1.1754943508222875e-38, for a line it found no glyph for). The rows are
// the old path's on macOS 27.2 but for that FLT_MIN.
test.serial('a host without fonts draws nothing with the empty typeface', (t) => {
  const script = `
    const { createCanvas, setTextRenderer } = require(${JSON.stringify(join(__dirname, '..', 'index.js'))})
    const out = []
    for (const renderer of ['portable', 'system']) {
      setTextRenderer(renderer)
      for (const font of ['40px NoSuchFamily', '13px sans-serif', 'bold 20px serif']) {
        for (const text of ['Hello', 'a水', '\uE000 x']) {
          const canvas = createCanvas(120, 40)
          const ctx = canvas.getContext('2d')
          ctx.font = font
          const m = ctx.measureText(text)
          ctx.fillText(text, 5, 30)
          const data = ctx.getImageData(0, 0, 120, 40).data
          let ink = 0
          for (let i = 3; i < data.length; i += 4) ink += data[i] ? 1 : 0
          out.push([renderer, font, text, m.width, m.actualBoundingBoxRight, m.fontBoundingBoxAscent, ink])
        }
      }
    }
    console.log(JSON.stringify(out))`
  const rows = JSON.parse(
    execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, DISABLE_SYSTEM_FONTS_LOAD: '1' },
      encoding: 'utf8',
      timeout: 20_000,
    }),
  ) as [string, string, string, number, number, number, number][]
  t.is(rows.length, 18)
  for (const [renderer, font, text, width, right, , ink] of rows) {
    const name = `${renderer} ${font} ${JSON.stringify(text)}: ${width} ${right} ${ink}`
    // Never the old path's FLT_MIN for a line without glyphs.
    t.true(width === 0 || width > 1e-30, name)
    t.true(right === 0 || Math.abs(right) > 1e-30, name)
    // No ink: no font drew it, so the empty typeface laid it out.
    if (ink === 0) {
      t.true(width === 0 && right === 0, name)
    } else {
      t.true(width > 0, name)
    }
  }
  if (process.platform === 'darwin' && release().split('.')[0] === '27') {
    t.deepEqual(rows, [
      ['portable', '40px NoSuchFamily', 'Hello', 88.8671875, 87.8671875, 36, 1020],
      ['portable', '40px NoSuchFamily', 'a水', 48.8671875, 43.75390625, 36, 307],
      ['portable', '40px NoSuchFamily', '\uE000 x', 61.11328125, 61.11328125, 36, 276],
      ['portable', '13px sans-serif', 'Hello', 29.62451171875, 29.39453125, 12, 163],
      ['portable', '13px sans-serif', 'a水', 16.97998046875, 16.22998046875, 12, 80],
      ['portable', '13px sans-serif', '\uE000 x', 19.86181640625, 20.36181640625, 12, 63],
      ['portable', 'bold 20px serif', 'Hello', 45.546875, 45.546875, 18, 375],
      ['portable', 'bold 20px serif', 'a水', 25.556640625, 23, 18, 119],
      ['portable', 'bold 20px serif', '\uE000 x', 30.556640625, 30.556640625, 18, 110],
      ...['40px NoSuchFamily', '13px sans-serif', 'bold 20px serif'].flatMap((font) =>
        ['Hello', 'a水', '\uE000 x'].map((text) => ['system', font, text, 0, 0, 0, 0]),
      ),
    ])
  }
})

// A line whose characters alternate between the first family and the next
// one: each character the second font draws is a run between two of the
// first font's runs. Putting each run in the middle of the item's runs as it
// was shaped took quadratic time (64000 pairs: 2.5 s on an M-series Mac;
// the old path 0.3 s, the shaper now 0.05 s), so each line has an absolute
// bound of 2 s. With Iosevka's and Source Serif's 5 px advances the widths
// are exact. RTL too (Harmattan, then Source Serif for U+20AB): 954443.25,
// the shaper's 16.16 sums (the old path's float sums gave 954756.8125).
test.serial('a line of many runs is laid out in linear time', (t) => {
  const lines: { width: number; ms: number }[] = []
  try {
    for (const [renderer, font, text, direction] of [
      ['portable', '10px RunsIosevka, LayoutSerif', 'a₫', 'ltr'],
      ['system', '10px RunsIosevka, LayoutSerif', 'a₫', 'ltr'],
      ['portable', '10px RunsArabic, LayoutSerif', 'ب₫', 'rtl'],
    ]) {
      setTextRenderer(renderer as 'portable' | 'system')
      const ctx = context(font, { direction })
      const line = text.repeat(64000)
      const start = process.hrtime.bigint()
      const width = ctx.measureText(line).width
      lines.push({ width, ms: Number(process.hrtime.bigint() - start) / 1e6 })
    }
  } finally {
    setTextRenderer('system')
  }
  t.deepEqual(
    lines.slice(0, 2).map((line) => line.width),
    [640000, 640000],
  )
  t.true(near(lines[2].width, 954443.25, 1e-3 * 954443.25), `${lines[2].width}`)
  for (const [i, line] of lines.entries()) {
    t.true(line.ms < 2000, `line ${i}: ${line.ms} ms`)
  }
})

// A registered Type 1 font (FreeType loads it; it has no SFNT tables, so no
// cmap for HarfBuzz): the shaper maps its characters with Skia, as skshaper
// does, and draws its glyphs, not the fallback font's. Chrome cannot load
// such a font (OTS turns it down). Both files (.pfa and .pfb) give the same
// line; the text the font has all, in its own glyphs (the glyph ids are the
// font's own, and the portable widths the ones the old path gave). The
// fixtures hold the characters of "HELLO, WORLD!" only; the space and the
// lowercase letters come from the fallback font, which differs per host.
test.serial('a registered Type 1 font keeps its glyphs', (t) => {
  const ROWS: [string, Record<string, string>, number[][], number][] = [
    ['H', {}, [[5]], 22.019974],
    ['WORLD!', {}, [[9, 7, 8, 6, 3, 1]], 112.49989318847656],
    ['HELLO', { letterSpacing: '3px' }, [[5, 4, 6, 6, 7]], 109.04989624023438],
    ['Hello', { fontVariantCaps: 'small-caps' }, [[5], [4, 6, 6, 7]], 72.44076538085938],
  ]
  const MIXED = ['HELLO, WORLD!', 'Hello World']
  try {
    for (const renderer of ['portable', 'system'] as const) {
      setTextRenderer(renderer)
      const lines: Record<string, unknown[]> = {}
      for (const family of ['LayoutType1A', 'LayoutType1B']) {
        lines[family] = []
        for (const [text, props, glyphs, portable] of [
          ...ROWS,
          ...MIXED.map((text) => [text, {}, null, null] as const),
        ]) {
          const ctx = context(`30px ${family}`, props, 260, 50)
          const m = ctx.measureText(text)
          ctx.fillText(text, 5, 35)
          const pixels = createHash('sha1')
            .update(ctx.getImageData(0, 0, 260, 50).data)
            .digest('hex')
          const runs = dump(ctx, text).runs
          const name = `${renderer} ${family} ${text}`
          if (glyphs) {
            t.true(
              runs.every((run) => run.family === 'Roboto2'),
              `${name}: ${runs.map((run) => run.family)}`,
            )
            t.deepEqual(
              runs.map((run) => run.glyphs),
              glyphs,
              name,
            )
            if (renderer === 'portable') {
              t.true(near(m.width, portable!), `${name}: ${m.width} (${portable})`)
            }
          } else {
            t.is(runs[0].family, 'Roboto2', name)
          }
          if (text === 'H') {
            t.true(near(m.width, 22.02, 0.01), `${name}: ${m.width}`)
          }
          lines[family].push([
            text,
            m.width,
            m.actualBoundingBoxAscent,
            m.actualBoundingBoxDescent,
            pixels,
            runs.map((run) => [run.family, run.glyphs]),
          ])
        }
      }
      t.deepEqual(lines.LayoutType1B, lines.LayoutType1A, renderer)
    }
  } finally {
    setTextRenderer('system')
  }
})

// noteFontArguments past its budget drops the text caches only after the
// layout that passed it (skia_c.hpp dropCachesIfOverBudget, D39). Each line
// has its own wght, so its own font argument list: the 257th list passes
// the budget (skiac_font_collection::kMaxFontArguments) inside a layout.
// The lines laid out again after the drop give the same widths.
test.serial('a cache drop during a run of variable font lines keeps the widths', (t) => {
  const widths = () =>
    Array.from({ length: 300 }, (_, i) => context(`${100 + i} 16px LayoutMono, LayoutHan`).measureText('a水').width)
  const first = widths()
  t.true(first.every((w) => w > 0))
  t.deepEqual(widths(), first)
})
