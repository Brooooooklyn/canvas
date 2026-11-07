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
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts, setTextRenderer, SvgExportFlag } from '../index'

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
// The 'Lato fallback' rows draw characters Lato lacks with the macOS system
// fallback fonts, and those change between macOS versions (the CI image
// macos-26 gives another width than the capture's macOS 27, also with
// fontSizeAdjust none). Pin them only on the capture's Darwin major.
const SYSTEM_FALLBACK = (name: string) => name.startsWith('Lato fallback ')
const CAPTURE_DARWIN = '27'
// Hiragino Sans as the primary font: the width differs without
// font-size-adjust too (66.28 here, 67.02 in Chrome; outside
// font-size-adjust).
const SKIP = ['none', '0.5', 'from-font', 'ic-width 0.5', 'cap-height 0.5'].map((v) => `Hiragino ${v}`)

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
    if (SYSTEM_FALLBACK(name) && release().split('.')[0] !== CAPTURE_DARWIN) {
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

test.serial('every font size is floored to 1/100 px, also without font-size-adjust', (t) => {
  // FontDescription::EffectiveFontSize. Chrome 157, 'Hello world' in Lato:
  // 0.004px to 0.009px measure 0; 0.01px, 0.015px and 0.019px all 0.05074;
  // 11pt (14.6667px) is the 14.66px width 74.48737.
  withBothRenderers((renderer) => {
    const text = 'Hello world'
    for (const [size, floored] of [
      ['10.567px', '10.56px'],
      ['33.339px', '33.33px'],
      ['14.6666667px', '14.66px'],
      ['11pt', '14.66px'],
      ['0.019px', '0.01px'],
      ['99.999px', '99.99px'],
    ]) {
      t.is(width(`${size} SALato`, text), width(`${floored} SALato`, text), `${renderer} ${size}`)
    }
    t.true(width('0.009px SALato', text) < 1e-6, renderer)
    // The ctx.font getter keeps the computed size.
    t.is(context({ font: '10.567px SALato', css: {}, ctx: {} }).font, '10.567px SALato', renderer)
  })
})

test.serial('the adjusted size is not capped, and stays finite', (t) => {
  // Chrome caps only the computed size: '600' at 20px Lato is about 23692
  // px (the fixture). Past about 3.4e36 px its effective size (the 1/100
  // floor) is infinity; that size is the largest one here (DESIGN D16).
  withBothRenderers((renderer) => {
    const ctx = createCanvas(100, 40).getContext('2d')
    ctx.font = '20px SALato'
    ctx.fontSizeAdjust = '600'
    t.true(ctx.measureText('Hx').fontBoundingBoxAscent > 20000, renderer)
    const huge = ['1e35', '3e38', 'calc(infinity)', 'cap-height calc(infinity)'].map((adjust) => {
      ctx.fontSizeAdjust = adjust
      ctx.fillText('Hx', 10, 30)
      const m = ctx.measureText('Hx')
      return [m.width, m.fontBoundingBoxAscent, m.actualBoundingBoxAscent]
    })
    for (const metrics of huge) {
      t.true(
        metrics.every((v) => Number.isFinite(v)),
        `${renderer} ${metrics}`,
      )
      t.deepEqual(metrics, huge[0], renderer)
    }
    t.true(huge[0][1] > 1e36, renderer)
  })
})

test.serial('text wider than the layout width stays one line', (t) => {
  // '600' makes 20px Lato about 23692 px, so ten H are about 179112 px wide,
  // more than skparagraph's layout width. All ten must be drawn, scaled to
  // maxWidth, in the raster and in the SVG export.
  const text = 'HHHHHHHHHH'
  withBothRenderers((renderer) => {
    for (const direction of ['ltr', 'rtl'] as const) {
      const label = `${renderer} ${direction}`
      const canvas = createCanvas(200, 200)
      const ctx = canvas.getContext('2d')
      ctx.font = '20px SALato'
      ctx.fontSizeAdjust = '600'
      ctx.direction = direction
      t.true(ctx.measureText(text).width > 170000, label)
      ctx.fillText(text, direction === 'rtl' ? 190 : 10, 150, 180)
      const { data } = ctx.getImageData(0, 0, 200, 200)
      let left = 200
      let right = -1
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) {
          const x = ((i - 3) / 4) % 200
          left = Math.min(left, x)
          right = Math.max(right, x)
        }
      }
      t.true(right - left > 170, `${label} ink ${left}-${right}`)
      const svg = createCanvas(200, 200, SvgExportFlag.ConvertTextToPaths)
      const svgCtx = svg.getContext('2d')
      svgCtx.font = '20px SALato'
      svgCtx.fontSizeAdjust = '600'
      svgCtx.direction = direction
      svgCtx.fillText(text, direction === 'rtl' ? 190 : 10, 150, 180)
      const d = /\sd="([^"]*)"/.exec(svg.getContent().toString())?.[1] ?? ''
      // One contour for each H.
      t.is(d.match(/M/g)?.length, 10, label)
    }
  })
})

test.serial('a cluster takes the size of the face that draws it', (t) => {
  // Lato has U+00E9 but no U+0301: HarfBuzz composes "e\u0301" to it, so
  // Lato draws both at its size. Source Serif has no U+01E9 but k and
  // U+030C: it draws both forms of that at its own size. EB Garamond has
  // U+00C2 and U+0300 but no U+0302 or U+1EA6: HarfBuzz composes the "A\u0302"
  // of "A\u0302\u0300" and decomposes U+1EA6 to them, so EB Garamond draws
  // all three at its size.
  const pixels = (font: string, text: string, adjust: string) => {
    const canvas = createCanvas(120, 120)
    const ctx = canvas.getContext('2d')
    ctx.fontSizeAdjust = adjust
    ctx.font = font
    ctx.fillText(text, 10, 90)
    return Buffer.from(ctx.getImageData(0, 0, 120, 120).data)
  }
  withBothRenderers((renderer) => {
    for (const adjust of ['0.5', 'from-font', 'cap-height 0.5']) {
      const label = `${renderer} ${adjust} EB Garamond`
      const font = '80px SAGar, SASerif'
      const composed = width(font, '\u00C2\u0300', { fontSizeAdjust: adjust })
      t.true(close(width('80px SAGar', '\u00C2\u0300', { fontSizeAdjust: adjust }), composed), label)
      for (const text of ['A\u0302\u0300', '\u1EA6']) {
        t.true(close(width(font, text, { fontSizeAdjust: adjust }), composed), `${label} ${text}`)
        t.true(pixels(font, text, adjust).equals(pixels(font, '\u00C2\u0300', adjust)), `${label} ${text} draw`)
      }
    }
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

test.serial('a space character a face lacks takes the size of the face that draws its U+0020', (t) => {
  // Lato has no U+2002 or U+2009: HarfBuzz draws them with its space, at
  // Lato's size, not Source Han's (the fixture has U+2011, which goes to
  // Source Han: Lato has no U+2010 either).
  withBothRenderers((renderer) => {
    for (const adjust of ['0.5', 'cap-height 0.5']) {
      const label = `${renderer} ${adjust}`
      const css = { fontSizeAdjust: adjust }
      for (const text of ['\u2002', 'a\u2009b']) {
        t.true(close(width('40px SALato, SAHan', text, css), width('40px SALato', text, css)), `${label} ${text}`)
      }
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

test.serial('font-optical-sizing none gives each face its own opsz default', (t) => {
  // SpaceOpsz (only a space, opsz default 6) comes first: Newsreader still
  // draws the letters at its own default, 18, not at 6. The macOS system
  // renderer sets the default as a coordinate (DESIGN D8); the portable one
  // sets none.
  const pixels = (font: string, text: string, css: Props) => {
    const canvas = createCanvas(200, 60)
    const ctx = canvas.getContext('2d')
    Object.assign(ctx, css)
    ctx.font = font
    ctx.fillText(text, 5, 45)
    return Buffer.from(ctx.getImageData(0, 0, 200, 60).data)
  }
  withBothRenderers((renderer) => {
    for (const adjust of ['none', '0.5']) {
      const none = { fontSizeAdjust: adjust, fontOpticalSizing: 'none' }
      for (const font of ['40px SAOpsz6, SANews', '40px SAGsub, SAOpsz6, SANews']) {
        const label = `${renderer} ${adjust} ${font}`
        t.true(close(width(font, 'HHHH', none), width('40px SANews', 'HHHH', none)), label)
        t.true(pixels(font, 'HHHH', none).equals(pixels('40px SANews', 'HHHH', none)), `${label} draw`)
      }
      t.true(
        close(
          width('40px SAOpsz6, SANews', 'HHHH', none),
          width('40px SANews', 'HHHH', { fontSizeAdjust: adjust, fontVariationSettings: "'opsz' 18" }),
        ),
        `${renderer} ${adjust} opsz 18`,
      )
    }
  })
})

test.serial('synthesized small caps keep the opsz of the face that draws them', (t) => {
  // Newsreader has no smcp: its small caps are 0.7 x the font size, at its
  // own opsz (its default 18 for none, its adjusted size for auto), not at
  // SpaceOpsz's (SimpleFontData::CreateScaledFontData keeps the face).
  const pixels = (font: string, props: Props) => {
    const canvas = createCanvas(200, 60)
    const ctx = canvas.getContext('2d')
    ctx.font = font
    Object.assign(ctx, props)
    ctx.fillText('hhhh', 5, 45)
    return Buffer.from(ctx.getImageData(0, 0, 200, 60).data)
  }
  withBothRenderers((renderer) => {
    for (const css of [
      { fontOpticalSizing: 'none' },
      { fontSizeAdjust: '0.5' },
      { fontSizeAdjust: '0.5', fontOpticalSizing: 'none' },
    ]) {
      for (const caps of [
        { fontVariantCaps: 'small-caps' },
        { fontVariantCaps: 'all-small-caps', letterSpacing: '3px' },
      ]) {
        const props = { ...css, ...caps }
        const label = `${renderer} ${JSON.stringify(props)}`
        const ours = context({ font: '40px SAOpsz6, SANews', css: {}, ctx: props }).measureText('hhhh').width
        const news = context({ font: '40px SANews', css: {}, ctx: props }).measureText('hhhh').width
        t.true(close(ours, news), `${label} ${ours} ${news}`)
        t.true(pixels('40px SAOpsz6, SANews', props).equals(pixels('40px SANews', props)), `${label} draw`)
      }
    }
  })
})

test.serial('a fallback family with its own size has its own opsz', (t) => {
  // GsubOne has no letters: Newsreader draws them at its own adjusted size
  // and opsz (CSSFontFace::GetFontData), as when it is the primary font.
  const text = 'Hamburgefonstiv'.repeat(4)
  const pixels = (font: string, css: Props) => {
    const canvas = createCanvas(1400, 60)
    const ctx = canvas.getContext('2d')
    Object.assign(ctx, css)
    ctx.font = font
    ctx.fillText(text, 5, 45)
    return Buffer.from(ctx.getImageData(0, 0, 1400, 60).data)
  }
  withBothRenderers((renderer) => {
    for (const css of [
      { fontSizeAdjust: '0.5' },
      { fontSizeAdjust: '0.5', fontOpticalSizing: 'none' },
      { fontSizeAdjust: '0.5', fontVariationSettings: "'opsz' 30" },
    ]) {
      const label = `${renderer} ${JSON.stringify(css)}`
      t.true(close(width('40px SAGsub, SANews', text, css), width('40px SANews', text, css)), label)
      t.true(pixels('40px SAGsub, SANews', css).equals(pixels('40px SANews', css)), `${label} draw`)
    }
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
