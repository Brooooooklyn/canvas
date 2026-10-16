// measureText, fillText and strokeText keep the laid out line of a text and
// reuse it for the same text and font settings. A line's runs are drawn as
// one text blob, from its first draw, when that puts every glyph on the same
// pixel. A line drawn again must paint and measure what its first draw did,
// the one blob must paint what the runs paint, and an SVG canvas must write a
// line the same way however often it was drawn before. Cascadia and Source
// Han Serif lines are drawn as one blob; Lato's descenders reach its font
// box, so a Lato line keeps its runs.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts, SvgExportFlag, type SKRSContext2D } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Cascadia.woff2'), 'CacheCascadia')
GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), 'CacheLato')
GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceHanSerifCN-Bold.ttf'), 'CacheHan')

interface Line {
  font: string
  caps: CanvasFontVariantCaps
  letterSpacing: string
  wordSpacing: string
  direction: CanvasDirection
  text: string
}

const LINES: Line[] = [
  {
    font: '22px CacheCascadia',
    caps: 'normal',
    letterSpacing: '0px',
    wordSpacing: '0px',
    direction: 'ltr',
    text: 'The quick brown fox jumps over the lazy dog',
  },
  {
    font: '22px CacheLato',
    caps: 'normal',
    letterSpacing: '0px',
    wordSpacing: '0px',
    direction: 'ltr',
    text: 'The quick brown fox jumps over the lazy dog',
  },
  {
    font: '22px CacheCascadia, CacheHan',
    caps: 'normal',
    letterSpacing: '0px',
    wordSpacing: '0px',
    direction: 'ltr',
    text: 'Mixed 日本語 and 中文 words in one line',
  },
  {
    font: '22px CacheCascadia',
    caps: 'small-caps',
    letterSpacing: '0px',
    wordSpacing: '0px',
    direction: 'ltr',
    text: 'Small Caps Words Drawn Twice',
  },
  {
    font: '22px CacheCascadia',
    caps: 'normal',
    letterSpacing: '1.5px',
    wordSpacing: '-3px',
    direction: 'rtl',
    text: 'Spaced words drawn right to left',
  },
]

// x, y and a canvas translation. 10.37 has too many binary digits for the
// one-blob draw, so lines drawn there keep their runs.
const PLACES: [number, number, number][] = [
  [10, 40, 0],
  [10.37, 40.6, 0],
  [3.5, 40, 6.25],
]

function setUp(ctx: SKRSContext2D, line: Line) {
  ctx.font = line.font
  ctx.fontVariantCaps = line.caps
  ctx.letterSpacing = line.letterSpacing
  ctx.wordSpacing = line.wordSpacing
  ctx.direction = line.direction
  ctx.textAlign = 'left'
}

function draw(line: Line, text: string, [x, y, tx]: [number, number, number], stroke: boolean) {
  const ctx = createCanvas(760, 60).getContext('2d')
  setUp(ctx, line)
  ctx.translate(tx, 0)
  const before = ctx.measureText(text).width
  if (stroke) {
    ctx.strokeText(text, x, y)
  } else {
    ctx.fillText(text, x, y)
  }
  return { pixels: Buffer.from(ctx.getImageData(0, 0, 760, 60).data), before, after: ctx.measureText(text).width }
}

for (const stroke of [false, true]) {
  test(`a line ${stroke ? 'stroked' : 'filled'} again paints what its first draw painted`, (t) => {
    LINES.forEach((line, i) => {
      PLACES.forEach((place, j) => {
        // A text of its own, so the first draw here is the line's first.
        const text = `${line.text} ${stroke ? 's' : 'f'}${i}${j}`
        const first = draw(line, text, place, stroke)
        t.true(
          first.pixels.some((v) => v !== 0),
          `${text}: nothing drawn`,
        )
        for (let again = 0; again < 2; again++) {
          const next = draw(line, text, place, stroke)
          t.true(next.pixels.equals(first.pixels), `${text} at ${place}: draw ${again + 2} differs`)
          t.is(next.before, first.before)
          t.is(next.after, first.before)
        }
      })
    })
  })
}

// A translation of 2^-23 px has too many binary digits for the one-blob draw,
// so the line keeps its runs, and it rounds away in every glyph's x sum when
// the line starts at x >= 4.
for (const stroke of [false, true]) {
  test(`a line ${stroke ? 'stroked' : 'filled'} as one blob paints what its runs paint`, (t) => {
    LINES.forEach((line, i) => {
      for (const x of [10, 4.25, 200.5]) {
        const text = `${line.text} ${stroke ? 'S' : 'F'}${i}`
        const blob = draw(line, text, [x, 40.5, 0], stroke)
        const runs = draw(line, text, [x, 40.5, 2 ** -23], stroke)
        t.true(
          blob.pixels.some((v) => v !== 0),
          `${text}: nothing drawn`,
        )
        t.true(blob.pixels.equals(runs.pixels), `${text} at ${x}: the one blob paints differently`)
      }
    })
  })
}

function svg(line: Line, text: string, x: number) {
  const canvas = createCanvas(760, 60, SvgExportFlag.NoPrettyXML)
  const ctx = canvas.getContext('2d')
  setUp(ctx, line)
  ctx.fillText(text, x, 40)
  return canvas.getContent().toString()
}

test('an SVG canvas writes a line the same way however often it was drawn before', (t) => {
  LINES.forEach((line, i) => {
    for (const x of [10, 10.37]) {
      const text = `${line.text} v${i}${x}`
      const first = svg(line, text, x)
      draw(line, text, [x, 40, 0], false)
      t.is(svg(line, text, x), first, `${text} at ${x}`)
    }
  })
  // One text element where FreeType draws: the Cascadia line is drawn as one
  // blob from its first draw. CoreText and Fontations place glyphs at Blink's
  // 16.16 advances, whose float sums are exact only on short lines, so there
  // a line this long keeps its runs.
  const elements = svg(LINES[0], `${LINES[0].text} one`, 10).match(/<text/g)?.length
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    t.is(elements, 1)
  } else {
    t.true(elements! > 1)
  }
})

// skparagraph's own cache of shaped paragraphs took sizes and spacings
// within 1/4096 px for the same, so a line laid out after a nearly equal one
// took that one's shaping. The laid out lines are kept by their exact
// settings instead.
test('a line laid out after a nearly equal one measures what it measures alone', (t) => {
  const text = 'Hello AVAWAY world, fluffy Tokyo'
  const pairs: [Partial<Line>, Partial<Line>][] = [
    [{ font: '16px CacheLato' }, { font: '16.0001px CacheLato' }],
    [{ letterSpacing: '1px' }, { letterSpacing: '1.0001px' }],
  ]
  const measure = (settings: Partial<Line>) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    setUp(ctx, { ...LINES[1], ...settings })
    const metrics = ctx.measureText(text)
    return [metrics.width, metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight]
  }
  pairs.forEach(([first, second], i) => {
    measure(first)
    const after = measure(second)
    // A new alias drops every cached layout.
    t.true(GlobalFonts.setAlias('CacheLato', `CacheLatoAlone${i}`))
    t.deepEqual(after, measure(second), JSON.stringify(second))
  })
})

// The laid out lines are kept within a budget of bytes, the least recently
// used dropped first, but never fewer than the last 128 used, which
// skparagraph's ParagraphCache (now off) kept whatever their size. So a loop
// over 128 lines that pass the budget together lays each line out once:
// lines kept from earlier tests are older and go first. Only the time shows
// it here: measuring a kept line takes a small part of a layout's time
// (src/sk.rs text_line_tests checks which lines are kept).
test('a loop over 128 lines longer than the budget allows lays each one out once', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = '8px CacheLato'
  // 20,000 glyphs a line, about 25 MB of glyph ids and positions in all.
  const lines = Array.from({ length: 128 }, (_, i) => `${i}${'i'.repeat(20000)}`)
  const medianTime = () => {
    const times = lines.map((line) => {
      const start = process.hrtime.bigint()
      ctx.measureText(line)
      return Number(process.hrtime.bigint() - start)
    })
    return times.sort((a, b) => a - b)[times.length >> 1]
  }
  const layout = medianTime()
  const kept = medianTime()
  t.true(kept * 5 < layout, `${kept} ns a kept line vs ${layout} ns a layout`)
})
