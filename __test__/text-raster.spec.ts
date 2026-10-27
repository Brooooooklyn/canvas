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
import './use-system-text-renderer'

import { readFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { measureContext, registerTextFonts, sceneRow, textScenes } from './text-scenes'

const __dirname = dirname(fileURLToPath(import.meta.url))

type SceneRow = [number, number, string]
type MeasureRow = [number, number, number, number, number]

interface Fixture {
  scenes: Record<string, { darwin: SceneRow; linux: SceneRow; freetype: number }>
  measure: Record<string, { darwin: MeasureRow; linux: MeasureRow }>
}

const FIXTURE: Fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'text-raster.json'), 'utf8'))

// The fonts Chrome loaded (FIXTURE.fonts), under the same names.
registerTextFonts('Raster')

const OS = process.platform === 'darwin' || process.platform === 'linux' ? process.platform : null
// The macOS Chrome was measured on.
const MEASURED_MACOS = Number.parseInt(release(), 10) === 27

const SCENES = textScenes('Raster')

function sceneTest(title: string, names: string[]) {
  const run = OS ? test : test.skip
  run(title, (t) => {
    for (const name of names) {
      const row = FIXTURE.scenes[name]
      const got = sceneRow(SCENES[name])
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

function measure(key: string) {
  const { ctx, text } = measureContext(key)
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
