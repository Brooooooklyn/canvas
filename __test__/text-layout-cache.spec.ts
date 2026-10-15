// measureText, fillText and strokeText keep the laid out line of a text and
// reuse it for the same text and font settings. From the second draw of a
// line its runs are drawn as one text blob when that puts every glyph on
// the same pixel. A line drawn again must paint and measure what its first
// draw did. Cascadia and Source Han Serif lines are drawn as one blob from
// the second draw; Lato's descenders reach its font box, so a Lato line
// keeps its runs.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts } from '../index'

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

function draw(line: Line, text: string, [x, y, tx]: [number, number, number], stroke: boolean) {
  const ctx = createCanvas(760, 60).getContext('2d')
  ctx.font = line.font
  ctx.fontVariantCaps = line.caps
  ctx.letterSpacing = line.letterSpacing
  ctx.wordSpacing = line.wordSpacing
  ctx.direction = line.direction
  ctx.textAlign = 'left'
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
