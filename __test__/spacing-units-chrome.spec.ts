// letterSpacing and wordSpacing units, as Chrome 157 resolves them: against
// the context font when they are set (em, rem, ex, ch, cap, ic) and again on
// every font set, with Blink's parser and getter
// (canvas_rendering_context_2d_state.cc:83-104, :365-404, :871-944).
// Fixture: fixtures/text-fonts/spacing-units.json, captured with Lato as the
// FontFace SpLato on detached <canvas> contexts.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, getTextRenderer, GlobalFonts, setTextRenderer, type SKRSContext2D } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type Op = [string] | [string, string]

interface Values {
  letterSpacing: string
  wordSpacing: string
  font: string
  lsPx: number
  wsPx: number
  hello: number
}

interface Row {
  id: string
  ops: Op[]
  chrome: Values
}

const FIXTURE: { rows: Row[] } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'spacing-units.json'), 'utf8'),
)

GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), 'SpLato')

const context = () => createCanvas(10, 10).getContext('2d')

// The capture's run.js: the getters, then the spacing in px from widths on a
// new context with the same font and lang and no spacing.
function run(row: Row): Values {
  const ctx = context()
  const props = ctx as unknown as Record<string, string>
  for (const [op, value] of row.ops) {
    if (op === 'save') ctx.save()
    else if (op === 'restore') ctx.restore()
    else if (op === 'reset') ctx.reset()
    else props[op] = value!
  }
  const ref = context()
  ref.font = ctx.font
  ref.lang = ctx.lang
  const width = (c: SKRSContext2D, text: string) => c.measureText(text).width
  const lsPx = (width(ctx, 'Hello') - width(ref, 'Hello')) / 5
  const wsPx = (width(ctx, 'a b c') - width(ref, 'a b c') - 5 * lsPx) / 2
  return {
    letterSpacing: ctx.letterSpacing,
    wordSpacing: ctx.wordSpacing,
    font: ctx.font,
    lsPx,
    wsPx,
    hello: width(ctx, 'Hello'),
  }
}

function mismatches(rows: Row[]) {
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-3
  const out: [string, Values][] = []
  for (const row of rows) {
    const ours = run(row)
    const c = row.chrome
    const same =
      ours.letterSpacing === c.letterSpacing &&
      ours.wordSpacing === c.wordSpacing &&
      ours.font === c.font &&
      close(ours.lsPx, c.lsPx) &&
      close(ours.wsPx, c.wsPx) &&
      close(ours.hello, c.hello)
    if (!same) out.push([row.id, ours])
  }
  return out
}

// Each row on the default renderer and on the system one.
function withBothRenderers(fn: (renderer: string) => void) {
  const before = getTextRenderer()
  try {
    for (const renderer of ['portable', 'system'] as const) {
      setTextRenderer(renderer)
      fn(renderer)
    }
  } finally {
    setTextRenderer(before)
  }
}

const row = (id: string) => {
  const found = FIXTURE.rows.find((r) => r.id === id)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

test.serial(`spacing getters and px match Chrome (${FIXTURE.rows.length} rows)`, (t) => {
  t.is(FIXTURE.rows.length, 138)
  withBothRenderers((renderer) => {
    t.deepEqual(mismatches(FIXTURE.rows), [], renderer)
  })
})

test.serial('em resolves against the font size, also after a font change', (t) => {
  // The plan's pinned values: what the old fixed 16px em got wrong.
  t.is(row('ls 0.1em @40').chrome.lsPx, 4)
  t.is(row('ls 0.5em @40 then font 20').chrome.lsPx, 10)
  t.is(row('ls 1em default font').chrome.lsPx, 10)
  t.is(row('get "2px "').chrome.letterSpacing, '0px')
  t.is(row('ls calc(1px) @40').chrome.lsPx, 0)
  withBothRenderers((renderer) => {
    const ctx = context()
    ctx.font = '40px SpLato'
    ctx.letterSpacing = '0.1em'
    t.is(ctx.letterSpacing, '0.1em', renderer)
    const ref = context()
    ref.font = '40px SpLato'
    t.true(Math.abs(ctx.measureText('Hello').width - ref.measureText('Hello').width - 20) < 1e-3, renderer)
    ctx.letterSpacing = '0.5em'
    ctx.font = '20px SpLato'
    ref.font = '20px SpLato'
    t.true(Math.abs(ctx.measureText('Hello').width - ref.measureText('Hello').width - 50) < 1e-3, renderer)
    // Chrome rejects a string that is more than one dimension token.
    ctx.letterSpacing = '2px '
    t.is(ctx.letterSpacing, '0.5em', renderer)
  })
})

test.serial("after save() the getters are '' like Chrome, and restore() gives the strings back", (t) => {
  t.is(row('ls 1em @40 save font20').chrome.letterSpacing, '')
  t.is(row('ls 1ex @40 save then same font').chrome.letterSpacing, '')
  const ctx = context()
  ctx.font = '40px SpLato'
  ctx.letterSpacing = '1em'
  ctx.wordSpacing = '2px'
  ctx.save()
  t.is(ctx.letterSpacing, '')
  t.is(ctx.wordSpacing, '')
  // The same number and unit keeps ''.
  ctx.letterSpacing = '1.0em'
  t.is(ctx.letterSpacing, '')
  ctx.wordSpacing = '3px'
  t.is(ctx.wordSpacing, '3px')
  ctx.restore()
  t.is(ctx.letterSpacing, '1em')
  t.is(ctx.wordSpacing, '2px')
  ctx.save()
  ctx.reset()
  t.is(ctx.letterSpacing, '0px')
  t.is(ctx.wordSpacing, '0px')
})

// Chrome 157 reads ch and ex off the font, not off shaped text: the advance
// of the nominal "0" glyph and (on macOS) the top of the nominal "x"
// (SimpleFontData::PlatformInit / PlatformGlyphInit). NominalProbe.ttf is
// Lato whose default ccmp maps "0" to "W" and "x" to "X", so shaping "0"
// would give 40.76px and "x" 28.66px at 40px instead of 23.2px and 20.26px.
// Fixture: fixtures/text-fonts/spacing-units-nominal.json (FontFace
// SpNominal).
const NOMINAL: { spacing: Row[] } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'spacing-units-nominal.json'), 'utf8'),
)

GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'NominalProbe.ttf'), 'SpNominal')

const nominalRow = (id: string) => {
  const found = NOMINAL.spacing.find((r) => r.id === id)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

test.serial('ch and ex spacing read the nominal "0" and "x", not the ccmp glyphs', (t) => {
  t.is(NOMINAL.spacing.length, 28)
  t.true(Math.abs(nominalRow('nominal ls 1ch @40').chrome.lsPx - 23.2) < 1e-3)
  t.true(Math.abs(nominalRow('nominal ws 1ex @40').chrome.wsPx - 20.26) < 1e-3)
  withBothRenderers((renderer) => {
    // The ex of a synthetic bold font is the top of the emboldened "x" in
    // Chrome on macOS; elsewhere, and with our portable renderer on macOS,
    // it is the font's x-height (an outside difference).
    const rows = NOMINAL.spacing.filter(
      (r) => !r.id.includes('ex @40 bold') || (process.platform === 'darwin' && renderer === 'system'),
    )
    t.deepEqual(mismatches(rows), [], renderer)
  })
})

// LowXProbe.ttf is Lato whose cmap maps "x" to the underscore glyph, which is
// all below the baseline. On Apple, Blink's x-height is the top of the "x"
// glyph, here negative, and FontMetrics::HasXHeight takes an x-height of 0
// or less as none, so ex is 0.5em. Chrome 157 on macOS: 1ex is 20 at 40px
// (letterSpacing and wordSpacing, bold and italic too) and 10 at 20px. Off
// Apple, and with our portable renderer on macOS, ex is the font's x-height,
// the same as Lato's (outside finding 3).
GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'LowXProbe.ttf'), 'SpLowX')

test.serial('ex is 0.5em when the "x" glyph is all below the baseline', (t) => {
  const spacing = (font: string, prop: 'letterSpacing' | 'wordSpacing', unit: string) => {
    const values = run({
      id: '',
      ops: [
        ['font', font],
        [prop, unit],
      ],
      chrome: {} as Values,
    })
    return prop === 'letterSpacing' ? values.lsPx : values.wsPx
  }
  withBothRenderers((renderer) => {
    const apple = process.platform === 'darwin' && renderer === 'system'
    for (const [font, size] of [
      ['40px SpLowX', 40],
      ['20px SpLowX', 20],
      ['bold 40px SpLowX', 40],
      ['italic 40px SpLowX', 40],
    ] as const) {
      for (const prop of ['letterSpacing', 'wordSpacing'] as const) {
        for (const unit of ['1ex', '1rex']) {
          const ours = spacing(font, prop, unit)
          const expected = apple ? size / 2 : spacing(font.replace('SpLowX', 'SpLato'), prop, unit)
          t.true(ours > 0 && Math.abs(ours - expected) < 1e-3, `${renderer} ${font} ${prop} ${unit}: ${ours}`)
        }
      }
    }
  })
})

// Chrome 157 reads ic off the primary font as it reads ch and ex: the advance
// of the nominal U+6C34 in the font instance its text uses
// (SimpleFontData::IdeographicAdvanceWidth, simple_font_data.cc:435-445), so
// with the automatic wght of the weight and the automatic opsz of the size.
// IcWghtProbe.ttf (Science Gothic, wght 100..900) and IcOpszProbe.ttf
// (Newsreader, opsz 6..72) map U+6C34 to "M", whose advance moves with the
// axis: 900 40px is 43.76px, not the default instance's 39.72px. Fixture:
// fixtures/text-fonts/spacing-units-ic-axes.json (FontFace SpIcWght with
// weight 100 900, SpIcOpsz).
const IC_AXES: { shaped: Record<string, number>; spacing: Row[] } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'spacing-units-ic-axes.json'), 'utf8'),
)

GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'IcWghtProbe.ttf'), 'SpIcWght')
GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'IcOpszProbe.ttf'), 'SpIcOpsz')

test.serial('ic spacing reads U+6C34 from the instance of the automatic wght and opsz', (t) => {
  t.is(IC_AXES.spacing.length, 48)
  t.true(Math.abs(IC_AXES.shaped['900 40px SpIcWght'] - 43.76) < 1e-3)
  withBothRenderers((renderer) => {
    for (const row of IC_AXES.spacing) {
      const ours = run(row)
      const c = row.chrome
      const label = `${renderer} ${row.id}`
      t.is(ours.letterSpacing, c.letterSpacing, label)
      t.is(ours.wordSpacing, c.wordSpacing, label)
      t.is(ours.font, c.font, label)
      // Chrome's px. Our portable renderer's variable font advances can be
      // a few thousandths of a px off CoreText's (its text too), so 0.01.
      t.true(
        Math.abs(ours.lsPx - c.lsPx) < 0.01 && Math.abs(ours.wsPx - c.wsPx) < 0.01,
        `${label} ${ours.lsPx} ${ours.wsPx}`,
      )
      // Exactly our own shaped U+6C34 in that font, times the number.
      const ctx = context()
      ctx.font = c.font
      const water = ctx.measureText('\u6C34').width
      const n = parseFloat(row.ops[1][1]!)
      t.true(Math.abs(Math.max(ours.lsPx, ours.wsPx) - n * water) < 1e-3, `${label} ${water}`)
    }
  })
})
