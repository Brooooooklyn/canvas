// fontSizeAdjust and fontOpticalSizing against Chrome 157. Chrome's canvas
// has neither attribute, but it applies the CSS longhands set on the
// <canvas> element; the fixture comes from that (canvas + element CSS).
//
// font-size-adjust: the primary font's size becomes value / aspect x the
// font size, floored to 1/100 px (FontBuilder::UpdateAdjustedSize,
// FontDescription::EffectiveFontSize); a registered or generic family gets
// its own aspect, a named installed family and the system fallback the
// primary's size (DESIGN D7). Synthesized small caps stay 0.7 x the font
// size (SimpleFontData::CreateScaledFontData). font-optical-sizing: auto
// sets opsz to the adjusted size, none to the face's default.
//
// The metrics are pinned on macOS with the system text renderer; the
// relations below hold on every OS and with both renderers.
import './use-system-text-renderer'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts, setTextRenderer } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type Props = Partial<Record<string, string>>
interface Case {
  font: string
  text: string
  css: Props
  ctx: Props
  computed: string
  // [width, fontBoundingBoxAscent, fontBoundingBoxDescent,
  //  actualBoundingBoxAscent, actualBoundingBoxDescent, hangingBaseline,
  //  ideographicBaseline]
  metrics: number[]
  dom: number
}
const FIXTURE: {
  fonts: Record<string, string>
  darwin: { metrics: Record<string, Case>; opsz: Record<string, Case> }
} = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'font-size-adjust.json'), 'utf8'))

for (const [family, file] of Object.entries(FIXTURE.fonts)) {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', file), family)
}

// Chrome's canvas gives a named installed family and the system fallback no
// font-size-adjust at all (it skips FontBuilder::UpdateAdjustedSize); its
// DOM gives them the primary font's adjusted size, as we do (DESIGN D7).
// These cases are checked against the DOM width.
const DOM_CASES = (name: string) => /Hiragino|fallback/.test(name)
// Chrome floors every font size to 1/100 px, also without font-size-adjust
// (EffectiveFontSize); a fractional ctx.font size is not floored here
// (outside font-size-adjust).
// Hiragino Sans as the primary font: the width differs without
// font-size-adjust too (66.28 here, 67.02 in Chrome; outside
// font-size-adjust).
const SKIP = [
  '13.348px auto',
  ...['none', '0.5', 'from-font', 'ic-width 0.5', 'cap-height 0.5'].map((v) => `Hiragino ${v}`),
]

function context(c: Pick<Case, 'font' | 'css' | 'ctx'>) {
  const ctx = createCanvas(10, 10).getContext('2d')
  Object.assign(ctx, c.css)
  ctx.font = c.font
  Object.assign(ctx, c.ctx)
  return ctx
}

function metrics(c: Pick<Case, 'font' | 'text' | 'css' | 'ctx'>) {
  const m = context(c).measureText(c.text)
  return [
    m.width,
    m.fontBoundingBoxAscent,
    m.fontBoundingBoxDescent,
    m.actualBoundingBoxAscent,
    m.actualBoundingBoxDescent,
    m.hangingBaseline,
    m.ideographicBaseline,
  ]
}

const FIELDS = ['width', 'fontAscent', 'fontDescent', 'actualAscent', 'actualDescent', 'hanging', 'ideographic']

function mismatches(cases: Record<string, Case>) {
  const out: string[] = []
  for (const [name, chrome] of Object.entries(cases)) {
    if (SKIP.includes(name)) {
      continue
    }
    const ours = metrics(chrome)
    if (DOM_CASES(name)) {
      if (!(Math.abs(ours[0] - chrome.dom) <= 1 / 64 + 1e-3)) {
        out.push(`${name}: width ${ours[0]} (Chrome DOM ${chrome.dom})`)
      }
      continue
    }
    ours.forEach((value, i) => {
      // Long lines add up float error (about 2e-7 of the width).
      const tolerance = i === 0 ? Math.max(1e-3, 1e-6 * Math.abs(value)) : 1e-3
      if (!(Math.abs(value - chrome.metrics[i]) <= tolerance)) {
        out.push(`${name}: ${FIELDS[i]} ${value} (Chrome ${chrome.metrics[i]})`)
      }
    })
  }
  return out
}

test.serial('font-size-adjust metrics match Chrome on macOS', (t) => {
  if (process.platform !== 'darwin') {
    t.pass('Chrome metrics are pinned on macOS')
    return
  }
  t.true(Object.keys(FIXTURE.darwin.metrics).length >= 120)
  t.deepEqual(mismatches(FIXTURE.darwin.metrics), [])
})

test.serial('font-optical-sizing widths match Chrome on macOS', (t) => {
  if (process.platform !== 'darwin') {
    t.pass('Chrome metrics are pinned on macOS')
    return
  }
  t.deepEqual(mismatches(FIXTURE.darwin.opsz), [])
})

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

const width = (font: string, text: string, css: Props = {}) => context({ font, css, ctx: {} }).measureText(text).width
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-3

test.serial('font-size-adjust 0 draws nothing and measures 0', (t) => {
  withBothRenderers((renderer) => {
    const canvas = createCanvas(100, 40)
    const ctx = canvas.getContext('2d')
    ctx.fontSizeAdjust = '0'
    ctx.font = '20px SALato'
    const m = ctx.measureText('Hxgy fi')
    t.is(m.width, 0, renderer)
    t.is(m.fontBoundingBoxAscent, 0, renderer)
    ctx.fillText('Hxgy fi', 10, 30)
    t.true(
      ctx.getImageData(0, 0, 100, 40).data.every((v) => v === 0),
      renderer,
    )
  })
})

test.serial('font-size-adjust picks the used size from the primary font', (t) => {
  withBothRenderers((renderer) => {
    const text = 'Hxgy 0123 fi'
    // Lato has no U+6C34: aspect 1, so ic-width 0.5 at 20px is 10px.
    t.true(close(width('20px SALato', text, { fontSizeAdjust: 'ic-width 0.5' }), width('10px SALato', text)), renderer)
    // from-font is the font's own aspect: the size stays.
    t.true(close(width('20px SALato', text, { fontSizeAdjust: 'from-font' }), width('20px SALato', text)), renderer)
    t.true(
      close(width('20px SALato', text, { fontSizeAdjust: 'cap-height from-font' }), width('20px SALato', text)),
      renderer,
    )
    // SourceSerifPro's x-height is 0.475 em: 0.95 doubles the size.
    t.true(close(width('20px SASerif', text, { fontSizeAdjust: '0.95' }), width('40px SASerif', text)), renderer)
    // The ctx.font getter keeps the computed size.
    const ctx = context({ font: '20px SALato', css: { fontSizeAdjust: '0.5' }, ctx: {} })
    t.is(ctx.font, '20px SALato', renderer)
  })
})

test.serial('a cluster takes the size of the face that draws its NFC or NFD form', (t) => {
  // Lato has U+00E9 but no U+0301: HarfBuzz composes "e\u0301" to it, so
  // Lato draws both at its size. Source Serif has no U+01E9 but k and
  // U+030C: it draws both forms of that at its own size.
  const pixels = (font: string, text: string, adjust: string) => {
    const canvas = createCanvas(120, 80)
    const ctx = canvas.getContext('2d')
    ctx.fontSizeAdjust = adjust
    ctx.font = font
    ctx.fillText(text, 10, 60)
    return Buffer.from(ctx.getImageData(0, 0, 120, 80).data)
  }
  withBothRenderers((renderer) => {
    const font = '40px SALato, SASerif'
    for (const adjust of ['0.5', 'from-font', 'cap-height 0.5']) {
      const label = `${renderer} ${adjust}`
      const composed = width(font, '\u00E9', { fontSizeAdjust: adjust })
      t.true(close(width(font, 'e\u0301', { fontSizeAdjust: adjust }), composed), label)
      t.true(close(width('40px SALato', '\u00E9', { fontSizeAdjust: adjust }), composed), label)
      t.true(pixels(font, 'e\u0301', adjust).equals(pixels(font, '\u00E9', adjust)), `${label} draw`)
      const caron = width(font, '\u01E9', { fontSizeAdjust: adjust })
      t.true(close(width(font, 'k\u030C', { fontSizeAdjust: adjust }), caron), label)
      if (adjust !== 'from-font') {
        // from-font takes the primary's aspect: Lato's here.
        t.true(close(width('40px SASerif', '\u01E9', { fontSizeAdjust: adjust }), caron), label)
      }
      t.true(pixels(font, 'k\u030C', adjust).equals(pixels(font, '\u01E9', adjust)), `${label} draw caron`)
    }
  })
})

test.serial('font-optical-sizing none is the opsz default, auto the used size', (t) => {
  withBothRenderers((renderer) => {
    const text = 'Hamburgefonstiv '.repeat(4)
    for (const size of [6, 12, 36, 72]) {
      const none = width(`${size}px SANews`, text, { fontOpticalSizing: 'none' })
      const opsz18 = width(`${size}px SANews`, text, { fontVariationSettings: "'opsz' 18" })
      t.true(close(none, opsz18), `${renderer} ${size}px none`)
      const auto = width(`${size}px SANews`, text, { fontOpticalSizing: 'auto' })
      const opszSize = width(`${size}px SANews`, text, { fontVariationSettings: `'opsz' ${size}` })
      t.true(close(auto, opszSize), `${renderer} ${size}px auto`)
      if (size !== 18) {
        t.false(close(auto, none), `${renderer} ${size}px auto differs from none`)
      }
    }
    // auto takes the adjusted size: 40px with ic-width 0.5 (aspect 1) is
    // 20px at opsz 20.
    t.true(
      close(
        width('40px SANews', text, { fontSizeAdjust: 'ic-width 0.5' }),
        width('20px SANews', text, { fontVariationSettings: "'opsz' 20" }),
      ),
      renderer,
    )
    // An explicit opsz wins over both.
    t.true(
      close(
        width('12px SANews', text, { fontOpticalSizing: 'none', fontVariationSettings: "'opsz' 40" }),
        width('12px SANews', text, { fontVariationSettings: "'opsz' 40" }),
      ),
      renderer,
    )
  })
})

test.serial('font-size-adjust and font-optical-sizing are part of the layout cache key', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  const toggles: [string, string, string][] = [
    ['fontSizeAdjust', '0.5', '20px SALato'],
    ['fontSizeAdjust', 'cap-height 0.5', '20px SALato'],
    ['fontSizeAdjust', 'from-font', '20px SALato, SAHan'],
    ['fontOpticalSizing', 'none', '12px SANews'],
  ]
  for (const [prop, value, font] of toggles) {
    ctx.font = font
    const before = ctx.measureText('Hx水 Hamburg').width
    Object.assign(ctx, { [prop]: value })
    const after = ctx.measureText('Hx水 Hamburg').width
    t.true(Math.abs(after - before) > 0.01, `${prop} = ${value}`)
    ctx.reset()
    ctx.font = font
    t.is(ctx.measureText('Hx水 Hamburg').width, before, `${prop} reset`)
  }
})

test.serial('the filter ic unit follows font-size-adjust', (t) => {
  // drop-shadow(1ic 0): Source Han's U+6C34 is 1em wide, so 1ic is the used
  // size.
  const shadowX = (adjust: string) => {
    const canvas = createCanvas(80, 10)
    const ctx = canvas.getContext('2d')
    ctx.fontSizeAdjust = adjust
    ctx.font = '20px SAHan'
    ctx.filter = 'drop-shadow(1ic 0 0 #f00)'
    ctx.fillStyle = '#00f'
    ctx.fillRect(0, 0, 4, 10)
    const { data } = ctx.getImageData(0, 0, 80, 10)
    for (let x = 4; x < 80; x++) {
      if (data[(5 * 80 + x) * 4] > 128) {
        return x
      }
    }
    return -1
  }
  t.is(shadowX('none'), 20)
  t.is(shadowX('ic-width 0.5'), 10)
})
