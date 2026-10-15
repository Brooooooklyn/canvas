// Canvas text pixels and glyph boxes against Chrome 155's CPU canvas on the
// same OS (skia-c/text_raster.cpp, skia-c/font_scalers.cpp):
//
//   macOS   CoreText (Fontations for some web fonts), Chrome's mac draw font,
//           sRGB text gamma, outline glyph boxes
//   Linux   Fontations, Chrome's Linux draw font, gamma 1.2 / contrast 0.2
//
// Windows keeps FreeType (Chrome draws with DirectWrite there), so only the
// widths are checked on it: FreeType gives Chrome Linux's widths, which are
// regression values on Windows, not a Chrome Windows measurement.
//
// Chrome was measured on macOS 27. CoreText ships with the OS, so on another
// macOS version the pixel rows are checked loosely: the alpha sum within 2% of
// Chrome's and well above what FreeType drew before.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts, type SKRSContext2D } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type SceneRow = [number, number, string]
type MeasureRow = [number, number, number, number, number]

interface Fixture {
  fonts: Record<string, string>
  scenes: Record<string, { darwin: SceneRow; linux: SceneRow; freetype: number }>
  measure: Record<string, { darwin: MeasureRow; linux: MeasureRow }>
}

const FIXTURE: Fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'text-raster.json'), 'utf8'))

for (const [family, file] of Object.entries(FIXTURE.fonts)) {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', file), family)
}

const OS = process.platform === 'darwin' || process.platform === 'linux' ? process.platform : null
// The macOS Chrome was measured on.
const MEASURED_MACOS = Number.parseInt(release(), 10) === 27

const T = 'Hamburgefonstiv 0123'

type Draw = (ctx: SKRSContext2D) => void

interface Scene {
  width: number
  height: number
  opaque?: boolean
  draw: Draw
}

function white(width: number, height: number): Draw {
  return (ctx) => {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#000'
  }
}

const SCENES: Record<string, Scene> = {
  'lato-9': { width: 108, height: 15, draw: (c) => ((c.font = '9px RasterLato'), c.fillText(T, 2, 10)) },
  'lato-13': { width: 156, height: 21, draw: (c) => ((c.font = '13px RasterLato'), c.fillText(T, 2, 15)) },
  'lato-24': { width: 288, height: 39, draw: (c) => ((c.font = '24px RasterLato'), c.fillText(T, 2, 28)) },
  'white-13': {
    width: 160,
    height: 22,
    draw: (c) => {
      c.fillStyle = '#fff'
      c.font = '13px RasterLato'
      c.fillText(T, 2, 15)
    },
  },
  'subpx-x-0.25': { width: 80, height: 20, draw: (c) => ((c.font = '13px RasterLato'), c.fillText('illi', 4.25, 15)) },
  'subpx-y-0.5': { width: 80, height: 24, draw: (c) => ((c.font = '13px RasterLato'), c.fillText('Hxe', 4, 15.5)) },
  'lato-300': { width: 400, height: 360, draw: (c) => ((c.font = '300px RasterLato'), c.fillText('Hg', 2, 290)) },
  'fakebold-24': { width: 300, height: 40, draw: (c) => ((c.font = 'bold 24px RasterLato'), c.fillText(T, 2, 28)) },
  'stroke-24': {
    width: 300,
    height: 40,
    draw: (c) => {
      c.font = '24px RasterLato'
      c.lineWidth = 1
      c.strokeText(T, 2, 28)
    },
  },
  'shadow-13': {
    width: 170,
    height: 30,
    draw: (c) => {
      c.font = '13px RasterLato'
      c.shadowColor = 'rgba(0,0,0,0.8)'
      c.shadowBlur = 2
      c.shadowOffsetX = 2
      c.shadowOffsetY = 2
      c.fillText(T, 2, 15)
    },
  },
  'opaque-black-on-white-13': {
    width: 160,
    height: 22,
    opaque: true,
    draw: (c) => {
      white(160, 22)(c)
      c.font = '13px RasterLato'
      c.fillText(T, 2, 15)
    },
  },
  'tr-geometricPrecision-13': {
    width: 170,
    height: 22,
    draw: (c) => {
      c.textRendering = 'geometricPrecision'
      c.font = '13px RasterLato'
      c.fillText(T, 2.3, 15.4)
    },
  },
  'tr-auto-13': {
    width: 170,
    height: 22,
    draw: (c) => {
      c.textRendering = 'auto'
      c.font = '13px RasterLato'
      c.fillText(T, 2.3, 15.4)
    },
  },
  'gp-white-on-black-13': {
    width: 170,
    height: 22,
    draw: (c) => {
      c.textRendering = 'geometricPrecision'
      c.fillStyle = '#000'
      c.fillRect(0, 0, 170, 22)
      c.fillStyle = '#fff'
      c.font = '13px RasterLato'
      c.fillText(T, 2, 15)
    },
  },
  'align-right-13': {
    width: 300,
    height: 22,
    draw: (c) => {
      c.textAlign = 'right'
      c.font = '13px RasterLato'
      c.fillText(T, 150.3, 15)
    },
  },
  'woff2-virgil-24': { width: 300, height: 40, draw: (c) => ((c.font = '24px RasterVirgil'), c.fillText(T, 2, 28)) },
  'colrv1-48': { width: 200, height: 70, draw: (c) => ((c.font = '48px RasterColr'), c.fillText('abc', 2, 55)) },
  'arabic-24': {
    width: 300,
    height: 50,
    draw: (c) => {
      c.font = '24px RasterArabic'
      c.direction = 'rtl'
      c.fillText('مرحبا بالعالم', 290, 35)
    },
  },
  // geometricPrecision on an alpha:false canvas: Chrome's macOS canvas gets
  // LCD text there, and CoreText draws LCD text hinted.
  'gp-bw-opaque': {
    width: 170,
    height: 22,
    opaque: true,
    draw: (c) => {
      c.textRendering = 'geometricPrecision'
      white(170, 22)(c)
      c.font = '13px RasterLato'
      c.fillText(T, 2.3, 15.4)
    },
  },
  'gp-bw-transparent': {
    width: 170,
    height: 22,
    draw: (c) => {
      c.textRendering = 'geometricPrecision'
      white(170, 22)(c)
      c.font = '13px RasterLato'
      c.fillText(T, 2.3, 15.4)
    },
  },
  'auto-bw-opaque': {
    width: 170,
    height: 22,
    opaque: true,
    draw: (c) => {
      white(170, 22)(c)
      c.font = '13px RasterLato'
      c.fillText(T, 2.3, 15.4)
    },
  },
  'gp-opaque-46': {
    width: 200,
    height: 80,
    opaque: true,
    draw: (c) => {
      white(200, 80)(c)
      c.textRendering = 'geometricPrecision'
      c.font = '46px RasterLato'
      c.fillText('Hg', 2.3, 60.4)
    },
  },
  'gp-opaque-60': {
    width: 200,
    height: 80,
    opaque: true,
    draw: (c) => {
      white(200, 80)(c)
      c.textRendering = 'geometricPrecision'
      c.font = '60px RasterLato'
      c.fillText('Hg', 2.3, 60.4)
    },
  },
  'gp-opaque-atop-13': {
    width: 170,
    height: 30,
    opaque: true,
    draw: (c) => {
      white(170, 30)(c)
      c.textRendering = 'geometricPrecision'
      c.globalCompositeOperation = 'source-atop'
      c.font = '13px RasterLato'
      c.fillText('Hamburgefonstiv', 2.3, 15.4)
    },
  },
  'gp-opaque-scale4-13': {
    width: 200,
    height: 80,
    opaque: true,
    draw: (c) => {
      white(200, 80)(c)
      c.scale(4, 4)
      c.textRendering = 'geometricPrecision'
      c.font = '13px RasterLato'
      c.fillText('Hg', 0.6, 15.1)
    },
  },
  'gp-opaque-filter-13': {
    width: 170,
    height: 30,
    opaque: true,
    draw: (c) => {
      white(170, 30)(c)
      c.textRendering = 'geometricPrecision'
      c.filter = 'blur(0px)'
      c.font = '13px RasterLato'
      c.fillText('Hamburgefonstiv', 2.3, 15.4)
    },
  },
  'gp-opaque-shadow-13': {
    width: 170,
    height: 30,
    opaque: true,
    draw: (c) => {
      white(170, 30)(c)
      c.textRendering = 'geometricPrecision'
      c.shadowColor = 'red'
      c.shadowOffsetY = 4
      c.font = '13px RasterLato'
      c.fillText('Hamburgefonstiv', 2.3, 15.4)
    },
  },
  'gp-opaque-alpha-13': {
    width: 170,
    height: 22,
    opaque: true,
    draw: (c) => {
      white(170, 22)(c)
      c.textRendering = 'geometricPrecision'
      c.globalAlpha = 0.6
      c.font = '13px RasterLato'
      c.fillText(T, 2.3, 15.4)
    },
  },
  'gp-opaque-rotate-13': {
    width: 170,
    height: 60,
    opaque: true,
    draw: (c) => {
      white(170, 60)(c)
      c.textRendering = 'geometricPrecision'
      c.translate(4, 15)
      c.rotate(0.2)
      c.font = '13px RasterLato'
      c.fillText('Hamburgefonstiv', 0, 0)
    },
  },
  'gp-opaque-multiply-13': {
    width: 170,
    height: 22,
    opaque: true,
    draw: (c) => {
      white(170, 22)(c)
      c.textRendering = 'geometricPrecision'
      c.globalCompositeOperation = 'multiply'
      c.font = '13px RasterLato'
      c.fillText(T, 2.3, 15.4)
    },
  },
  // One context draws geometricPrecision, auto, geometricPrecision.
  'tr-leak': {
    width: 170,
    height: 66,
    draw: (c) => {
      c.font = '13px RasterLato'
      c.textRendering = 'geometricPrecision'
      c.fillText(T, 2.3, 15.4)
      c.textRendering = 'auto'
      c.fillText(T, 2.3, 37.4)
      c.textRendering = 'geometricPrecision'
      c.fillText(T, 2.3, 59.4)
    },
  },
}

function render(name: string) {
  const { width, height, opaque, draw } = SCENES[name]
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d', opaque ? { alpha: false } : undefined)
  draw(ctx)
  const data = ctx.getImageData(0, 0, width, height).data
  let alpha = 0
  let rgb = 0
  for (let i = 0; i < data.length; i += 4) {
    alpha += data[i + 3]
    rgb += data[i] + data[i + 1] + data[i + 2]
  }
  const sha = createHash('sha1').update(data).digest('hex').slice(0, 16)
  return [alpha, rgb, sha] as SceneRow
}

function sceneTest(title: string, names: string[]) {
  const run = OS ? test : test.skip
  run(title, (t) => {
    for (const name of names) {
      const row = FIXTURE.scenes[name]
      const got = render(name)
      if (OS === 'darwin' && !MEASURED_MACOS) {
        // CoreText is another version: Chrome's alpha within 2%, well above
        // FreeType's.
        const [alpha] = row.darwin
        t.true(Math.abs(got[0] - alpha) <= alpha * 0.02, `${name}: alpha ${got[0]}, Chrome ${alpha}`)
        if (row.freetype * 1.3 < alpha) {
          t.true(got[0] > row.freetype * 1.3, `${name}: alpha ${got[0]}, FreeType ${row.freetype}`)
        }
      } else {
        t.deepEqual(got, row[OS!], name)
      }
    }
  })
}

sceneTest('Lato draws like Chrome at 9, 13 and 24px', ['lato-9', 'lato-13', 'lato-24'])
sceneTest("white text uses Chrome's text gamma", ['white-13'])
sceneTest('glyphs keep their fractional x and y like Chrome', ['subpx-x-0.25', 'subpx-y-0.5', 'lato-300'])
sceneTest('fake bold and stroked glyphs draw like Chrome', ['fakebold-24', 'stroke-24'])
sceneTest('text shadows draw like Chrome', ['shadow-13'])
sceneTest('alpha:false text draws like Chrome', ['opaque-black-on-white-13'])
sceneTest('geometricPrecision draws unhinted glyphs like Chrome', [
  'tr-geometricPrecision-13',
  'tr-auto-13',
  'gp-white-on-black-13',
])
sceneTest('geometricPrecision does not leak into a later auto draw', ['tr-leak'])
sceneTest('right-aligned text draws like Chrome', ['align-right-13'])
sceneTest('WOFF2, COLRv1 and Arabic text draw like Chrome', ['woff2-virgil-24', 'colrv1-48', 'arabic-24'])
sceneTest('geometricPrecision on an alpha:false canvas draws like Chrome', [
  'gp-bw-opaque',
  'gp-bw-transparent',
  'auto-bw-opaque',
  'gp-opaque-46',
  'gp-opaque-60',
  'gp-opaque-atop-13',
  'gp-opaque-scale4-13',
  'gp-opaque-filter-13',
  'gp-opaque-shadow-13',
  'gp-opaque-alpha-13',
  'gp-opaque-rotate-13',
  'gp-opaque-multiply-13',
])

const MEASURE_FIELDS = [
  'width',
  'actualBoundingBoxLeft',
  'actualBoundingBoxRight',
  'actualBoundingBoxAscent',
  'actualBoundingBoxDescent',
] as const

// "<font>|<text>", or "textRendering <value>|<font>" for the fixture text.
function measure(key: string) {
  const ctx = createCanvas(10, 10).getContext('2d')
  let [font, text] = key.split('|')
  if (font.startsWith('textRendering ')) {
    ctx.textRendering = font.slice('textRendering '.length) as CanvasTextRendering
    font = text
    text = T
  }
  ctx.font = font
  const metrics = ctx.measureText(text)
  return MEASURE_FIELDS.map((field) => metrics[field])
}

test('measureText widths and glyph boxes equal Chrome', (t) => {
  for (const [key, row] of Object.entries(FIXTURE.measure)) {
    const got = measure(key)
    if (OS) {
      t.deepEqual(got, row[OS], key)
    } else {
      // Windows: FreeType's widths equal Chrome Linux's.
      t.is(got[0], row.linux[0], key)
    }
  }
})
