// Canvas text preparation and maxWidth against Chrome 155 (CPU canvas, Linux
// x64). Blink makes U+0009 to U+000D spaces and the zero width characters
// (soft hyphen, bidi marks and controls, BOM, U+FFFC) zero width spaces that
// end words (PlainTextNode::NormalizeSpacesAndMaybeBidi), draws the line and
// paragraph separators with the space glyph (HarfBuzzFace), and draws
// nothing for a maxWidth that is not a positive finite number
// (BaseRenderingContext2D::DrawTextInternal).
import './use-system-fonts'

import { readFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type Row = [number, number, number, number, number]

interface Fixture {
  chars: Record<string, string>
  zwsChars: Record<string, string>
  wsMeasure: Record<string, Row>
  zwsWords: Record<string, Row>
  wsDraw: Record<string, [string, string] | string>
  maxWidth: Record<string, [string, string]>
  maxWidthAlign: Record<string, string>
  coords: Record<string, [string, string]>
}

// Chrome on macOS reads the fonts through CoreText: its own rows there.
const RAW = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'whitespace-maxwidth.json'), 'utf8'))
const FIXTURE: Fixture = process.platform === 'darwin' ? { ...RAW, ...RAW.darwin } : RAW

// Chrome's macOS rows were measured on macOS 27. CoreText ships with the OS,
// so on another macOS version the painted pixels are not compared.
const PIXEL_PINS = process.platform !== 'darwin' || Number.parseInt(release(), 10) === 27

GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), 'LatoT')

// Lato has no glyph for these: Chrome draws them from Lato (.notdef, or a
// HarfBuzz space), we may pick an installed font.
const FONT_DEPENDENT = new Set(['nel', 'ctl', 'fs', 'ideo', 'en'])
const CHARS = Object.entries(FIXTURE.chars).filter(([name]) => !FONT_DEPENDENT.has(name))

const FIELDS = [
  'width',
  'actualBoundingBoxLeft',
  'actualBoundingBoxRight',
  'actualBoundingBoxAscent',
  'actualBoundingBoxDescent',
] as const

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

function rowMismatch(key: string, m: TextMetrics, row: Row) {
  const actual = FIELDS.map((field) => m[field])
  return actual.every((v, i) => Math.abs(v - row[i]) <= 1e-3) ? [] : [`${key}: ${actual} (Chrome ${row})`]
}

// The painted box, or on another macOS version only whether anything drew.
function seen(box: string) {
  return PIXEL_PINS ? box : box.endsWith(',-1,-1,-1') ? 'nothing' : 'drawn'
}

function inkBox(ctx: Ctx, w: number, h: number) {
  const data = ctx.getImageData(0, 0, w, h).data
  let top = -1
  let bottom = -1
  let left = w
  let right = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
        if (top < 0) top = y
        bottom = y
        left = Math.min(left, x)
        right = Math.max(right, x)
      }
    }
  }
  return top < 0 ? 'none' : [left, top, right, bottom].join(',')
}

test('canvas whitespace measures like Chrome', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d')
  ctx.font = '20px LatoT'
  const out: string[] = []
  for (const [name, ch] of CHARS) {
    out.push(...rowMismatch(name, ctx.measureText(`a${ch}b`), FIXTURE.wsMeasure[name]))
    out.push(...rowMismatch(`${name} only`, ctx.measureText(ch), FIXTURE.wsMeasure[`${name} only`]))
    out.push(...rowMismatch(`${name} lead`, ctx.measureText(`${ch}ab`), FIXTURE.wsMeasure[`${name} lead`]))
  }
  t.deepEqual(out, [])
})

test('zero width characters end words like Chrome', (t) => {
  // Lato kerns "VA" and "Ta"; Blink shapes the words on either side apart.
  const ctx = createCanvas(1, 1).getContext('2d')
  ctx.font = '30px LatoT'
  const out: string[] = []
  for (const [name, ch] of Object.entries(FIXTURE.zwsChars)) {
    out.push(...rowMismatch(name, ctx.measureText(`AV${ch}AV`), FIXTURE.zwsWords[name]))
    out.push(...rowMismatch(`${name} Ta`, ctx.measureText(`T${ch}a`), FIXTURE.zwsWords[`${name} Ta`]))
  }
  t.deepEqual(out, [])
})

test('fillText and strokeText draw canvas whitespace like Chrome', (t) => {
  const out: string[] = []
  for (const [name, ch] of CHARS) {
    for (const op of ['fill', 'stroke'] as const) {
      const ctx = createCanvas(200, 40).getContext('2d')
      ctx.font = '20px LatoT'
      if (op === 'fill') ctx.fillText(`a${ch}b`, 10, 30)
      else ctx.strokeText(`a${ch}b`, 10, 30)
      const chrome = op === 'fill' ? (FIXTURE.wsDraw[name] as [string, string])[1] : FIXTURE.wsDraw[`${name} stroke`]
      const box = inkBox(ctx, 200, 40)
      if (seen(box) !== seen(chrome)) out.push(`${op} ${name}: ${box} (Chrome ${chrome})`)
    }
  }
  t.deepEqual(out, [])
})

const MAX_WIDTHS: [string, unknown][] = [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['0', 0],
  ['-1', -1],
  ['0.5', 0.5],
  ['10', 10],
  ['30', 30],
  ['10000000000', 1e10],
  ['50.5', 50.5],
  ['20(str)', '20'],
  ['null', null],
  ['undefined', undefined],
  ['(str)', ''],
  ['abc(str)', 'abc'],
]

test('maxWidth that is not a positive finite number draws nothing like Chrome', (t) => {
  const out: string[] = []
  for (const [label, maxWidth] of MAX_WIDTHS) {
    for (const op of ['fill', 'stroke'] as const) {
      const ctx = createCanvas(200, 40).getContext('2d')
      ctx.font = '20px LatoT'
      if (op === 'fill') ctx.fillText('Hello', 10, 30, maxWidth as number)
      else ctx.strokeText('Hello', 10, 30, maxWidth as number)
      const chrome = FIXTURE.maxWidth[`${op} ${label}`][1]
      const box = inkBox(ctx, 200, 40)
      if (seen(box) !== seen(chrome)) out.push(`${op} ${label}: ${box} (Chrome ${chrome})`)
    }
  }
  t.deepEqual(out, [])
})

test('maxWidth squeezes the text around the aligned anchor like Chrome', (t) => {
  const actual: Record<string, string> = {}
  for (const key of Object.keys(FIXTURE.maxWidthAlign)) {
    const ctx = createCanvas(200, 40).getContext('2d')
    ctx.font = '20px LatoT'
    if (key === 'ls5 mw40') {
      ctx.letterSpacing = '5px'
      ctx.fillText('Hello', 10, 30, 40)
    } else {
      const [align, direction] = key.split(' ')
      ctx.textAlign = align as CanvasTextAlign
      ctx.direction = direction as CanvasDirection
      ctx.fillText('Hello World', 100, 30, 40)
    }
    actual[key] = seen(inkBox(ctx, 200, 40))
  }
  t.deepEqual(actual, Object.fromEntries(Object.entries(FIXTURE.maxWidthAlign).map(([key, box]) => [key, seen(box)])))
})

test('non-finite and far away anchors draw nothing like Chrome', (t) => {
  const actual: Record<string, string> = {}
  for (const key of Object.keys(FIXTURE.coords)) {
    const [op, xy] = key.split(' ')
    const [x, y] = xy.split(',').map(Number)
    const ctx = createCanvas(100, 40).getContext('2d')
    ctx.font = '20px LatoT'
    if (op === 'fill') ctx.fillText('Hi', x, y)
    else ctx.strokeText('Hi', x, y)
    actual[key] = seen(inkBox(ctx, 100, 40))
  }
  t.deepEqual(actual, Object.fromEntries(Object.entries(FIXTURE.coords).map(([key, [, box]]) => [key, seen(box)])))
})
