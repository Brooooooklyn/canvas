// font-variant-caps against Chrome 155 (CPU canvas, Linux x64). Blink uses
// the OpenType caps features when the font has them for the text's script;
// otherwise it makes small caps from uppercase letters at 70% of the font
// size, rounded to whole pixels, with the lang's case mapping (Turkish i
// becomes a dotted capital), and shapes each run of letters that change when
// uppercased, or do not, on its own (OpenTypeCapsSupport, SmallCapsIterator,
// SimpleFontData::SmallCapsFontData).
import { readFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type Row = [number, number, number, number, number, string]
type Draw = [
  string,
  CanvasFontVariantCaps,
  string,
  { lang?: string; letterSpacing?: string; direction?: CanvasDirection },
]

interface Fixture {
  caps: Record<string, Row>
  sizes: Record<string, Row>
  misc: Record<string, { draw: Draw; chrome: Row }>
  widths: Record<string, number>
}

// Chrome on macOS reads the fonts through CoreText: its own rows there.
const RAW = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'small-caps.json'), 'utf8'))
const FIXTURE: Fixture = process.platform === 'darwin' ? { ...RAW, ...RAW.darwin } : RAW

// Chrome's macOS rows were measured on macOS 27. CoreText ships with the OS,
// so on another macOS version the painted pixels are not compared.
const PIXEL_PINS = process.platform !== 'darwin' || Number.parseInt(release(), 10) === 27

const FONTS: Record<string, string> = {
  LatoT: 'Lato-Regular.ttf',
  OswaldT: 'Oswald.ttf',
  SerifProT: 'SourceSerifPro-Regular.ttf',
  GothicT: 'ScienceGothic-VariableFont.ttf',
  RobotoMonoT: 'RobotoMono-VariableFont_wght.ttf',
  IosevkaT: 'iosevka-slab-regular.ttf',
  VirgilT: 'Virgil.woff2',
  HanT: 'SourceHanSerifCN-Bold.ttf',
}
for (const [family, file] of Object.entries(FONTS)) {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', file), family)
}

function inkBox(ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>, w: number, h: number) {
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
  return [left, top, right, bottom]
}

function draw([font, caps, text, options]: Draw) {
  const ctx = createCanvas(700, 90).getContext('2d')
  if (options.lang) ctx.lang = options.lang
  ctx.font = font
  ctx.fontVariantCaps = caps
  if (options.letterSpacing) ctx.letterSpacing = options.letterSpacing
  if (options.direction) ctx.direction = options.direction
  ctx.fillText(text, 10, 60)
  const m = ctx.measureText(text)
  return {
    box: [m.actualBoundingBoxLeft, m.actualBoundingBoxRight, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent],
    width: m.width,
    ink: inkBox(ctx, 700, 90),
  }
}

// On Windows, which keeps FreeType, these glyph boxes and pixels are a pixel
// off Chrome's (Fontations): the small caps glyphs of the fonts that have
// them, and Oswald's Turkish i. macOS and Linux draw with Chrome's scalers.
const FREETYPE = process.platform !== 'darwin' && process.platform !== 'linux'
const ENGINE_GAPS = /^(SerifProT|GothicT|RobotoMonoT|IosevkaT|VirgilT) |^OswaldT tr-TR unicase$/

// The fields of a draw that differ from Chrome: the width by more than
// 1/1000; the box and the ink by more than 1/1000, or than a pixel where the
// glyph engines differ.
function mismatches(key: string, d: Draw, chrome: Row) {
  const { box, width, ink } = draw(d)
  const tolerance = FREETYPE && ENGINE_GAPS.test(key) ? 1 + 1e-3 : 1e-3
  const out: string[] = []
  if (!(Math.abs(width - chrome[0]) <= 1e-3)) out.push(`${key} width: ${width} (Chrome ${chrome[0]})`)
  if (!box.every((v, i) => Math.abs(v - chrome[i + 1]) <= tolerance)) {
    out.push(`${key} box: ${box} (Chrome ${chrome.slice(1, 5)})`)
  }
  const chromeInk = chrome[5].split(',').map(Number)
  if (PIXEL_PINS && !ink.every((v, i) => Math.abs(v - chromeInk[i]) <= tolerance)) {
    out.push(`${key} ink: ${ink} (Chrome ${chrome[5]})`)
  }
  return out
}

test('each variant caps value uses the font features or synthesizes like Chrome', (t) => {
  const out: string[] = []
  for (const [key, row] of Object.entries(FIXTURE.caps)) {
    const [family, caps] = key.split(' ')
    out.push(...mismatches(key, [`30px ${family}`, caps as CanvasFontVariantCaps, 'Hello World ß fi 123 Éé', {}], row))
  }
  t.deepEqual(out, [])
})

test('synthesized small caps are 70% of the font size, rounded to whole pixels', (t) => {
  const out: string[] = []
  for (const [key, row] of Object.entries(FIXTURE.sizes)) {
    const [, size, caps] = key.split(' ')
    out.push(...mismatches(key, [`${size}px LatoT`, caps as CanvasFontVariantCaps, 'Small Caps xyz', {}], row))
  }
  t.deepEqual(out, [])
})

test('small caps follow the lang, spacing, direction and fallback fonts like Chrome', (t) => {
  const out: string[] = []
  for (const [key, { draw: d, chrome }] of Object.entries(FIXTURE.misc)) {
    out.push(...mismatches(key, d, chrome))
  }
  t.deepEqual(out, [])
})

test('the font shorthand small-caps synthesizes like Chrome', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  const out: string[] = []
  for (const [font, width] of Object.entries(FIXTURE.widths)) {
    ctx.font = font
    const actual = ctx.measureText('abc').width
    if (!(Math.abs(actual - width) <= 1e-3)) out.push(`${font}: ${actual} (Chrome ${width})`)
  }
  t.deepEqual(out, [])
})
