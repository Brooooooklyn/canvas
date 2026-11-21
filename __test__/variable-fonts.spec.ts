import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, Canvas, type SKRSContext2D } from '../index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// This test demonstrates the new variable font support
// It requires a variable font to be present in the test fonts directory

test('GlobalFonts.hasVariations should return false for non-variable fonts', (t) => {
  // Load a standard font
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-regular.ttf'), 'Iosevka')

  // Check if it has variations (it shouldn't for a non-variable font)
  const hasVariations = GlobalFonts.hasVariations('Iosevka', 400, 5, 0)
  t.false(hasVariations)
})

test('GlobalFonts.getVariationAxes should return empty array for non-variable fonts', (t) => {
  // Load a standard font
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-regular.ttf'), 'Iosevka')

  // Get variation axes (should be empty for non-variable font)
  const axes = GlobalFonts.getVariationAxes('Iosevka', 400, 5, 0)
  t.is(axes.length, 0)
})

test('GlobalFonts.hasVariations should return true for variable fonts', (t) => {
  const fontPath = join(__dirname, 'fonts', 'Oswald.ttf')
  GlobalFonts.registerFromPath(fontPath, 'Oswald')
  const hasVariations = GlobalFonts.hasVariations('Oswald', 400, 5, 0)
  t.true(hasVariations)
})

test('GlobalFonts.getVariationAxes should return axes for variable fonts', (t) => {
  const fontPath = join(__dirname, 'fonts', 'Oswald.ttf')
  GlobalFonts.registerFromPath(fontPath, 'Oswald')
  const axes = GlobalFonts.getVariationAxes('Oswald', 400, 5, 0)
  t.true(axes.length > 0)

  const weightAxis = axes.find((axis) => axis.tag === 0x77676874) // 'wght'
  t.truthy(weightAxis)
  if (weightAxis) {
    t.is(weightAxis.min, 200)
    t.is(weightAxis.max, 700)
    t.is(weightAxis.def, 400)
  }
})

test('FontVariationAxis interface has correct properties', (t) => {
  // Load a standard font and get its axes (even if empty)
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-regular.ttf'), 'Iosevka')
  const axes = GlobalFonts.getVariationAxes('Iosevka', 400, 5, 0)

  // Verify the interface even with empty array
  t.true(Array.isArray(axes))

  // If there were axes, they would have these properties:
  // - tag: number (OpenType tag as 32-bit integer)
  // - value: number (current value)
  // - min: number (minimum value)
  // - max: number (maximum value)
  // - def: number (default value)
  // - hidden: boolean (whether hidden from UI)

  t.pass()
})

test('CanvasRenderingContext2D.fontVariationSettings parses and serializes like Chrome CSS', (t) => {
  const canvas = new Canvas(200, 200)
  const ctx = canvas.getContext('2d')

  t.is(ctx.fontVariationSettings, 'normal')

  // Normalized to Chrome's computed form: double-quoted, sorted by tag, deduped (last wins)
  ctx.fontVariationSettings = "'wght' 700, 'wdth' 50"
  t.is(ctx.fontVariationSettings, '"wdth" 50, "wght" 700')

  ctx.fontVariationSettings = '"wght" 300, "wght" calc(300 + 400)'
  t.is(ctx.fontVariationSettings, '"wght" 700')

  ctx.fontVariationSettings = '"wght" /*comment*/ -0, "w,ht" 1.5, "w\\"ht" 2, "w\\\\ht" 3'
  t.is(ctx.fontVariationSettings, '"w\\"ht" 2, "w,ht" 1.5, "w\\\\ht" 3, "wght" 0')

  ctx.fontVariationSettings = '"wght" calc(1 / 0), "wdth" calc(0 / 0)'
  t.is(ctx.fontVariationSettings, '"wdth" 0, "wght" 3.40282e+38')

  ctx.fontVariationSettings = 'NORMAL'
  t.is(ctx.fontVariationSettings, 'normal')
})

test('CanvasRenderingContext2D.fontVariationSettings ignores invalid values and keeps state', (t) => {
  const canvas = new Canvas(200, 200)
  const ctx = canvas.getContext('2d')

  ctx.fontVariationSettings = '"wght" 700'
  t.is(ctx.fontVariationSettings, '"wght" 700')

  const invalid = [
    '',
    '   ',
    'invalid',
    'inherit',
    'initial',
    'unset',
    'revert',
    'revert-layer',
    'var(--w)',
    '"wght" var(--w)',
    '"wght" NaN',
    '"wght" Infinity',
    '"wght" -Infinity',
    '"wght" 700,',
    ', "wght" 700',
    ',',
    '"wght" 700px',
    '"wght"',
    '"wgh" 700',
    '"wghtx" 700',
    '"w\x1fht" 700',
    '"w\x7fht" 700',
    '"wght" 700 !important',
    '"wght" 100, invalid',
  ]
  for (const value of invalid) {
    ctx.fontVariationSettings = value
    t.is(ctx.fontVariationSettings, '"wght" 700', `invalid input ${JSON.stringify(value)}`)
  }

  // WebIDL DOMString coercion
  const raw = ctx as unknown as Record<'fontVariationSettings', unknown>
  raw.fontVariationSettings = 700
  t.is(ctx.fontVariationSettings, '"wght" 700')
  raw.fontVariationSettings = null
  t.is(ctx.fontVariationSettings, '"wght" 700')
  raw.fontVariationSettings = undefined
  t.is(ctx.fontVariationSettings, '"wght" 700')
  raw.fontVariationSettings = { toString: () => "'wght' 650" }
  t.is(ctx.fontVariationSettings, '"wght" 650')
  t.throws(
    () => {
      raw.fontVariationSettings = Symbol('x')
    },
    { instanceOf: TypeError },
  )
  t.is(ctx.fontVariationSettings, '"wght" 650')
})

test('CanvasRenderingContext2D.fontVariationSettings save/restore/reset and ctx.font preservation', (t) => {
  const canvas = new Canvas(200, 200)
  const ctx: SKRSContext2D = canvas.getContext('2d')

  ctx.save()
  ctx.fontVariationSettings = "'wght' 700, 'wdth' 75"
  ctx.font = 'bold 20px sans-serif'
  t.is(ctx.fontVariationSettings, '"wdth" 75, "wght" 700')
  ctx.restore()
  t.is(ctx.fontVariationSettings, 'normal')

  ctx.fontVariationSettings = "'wght' 600"
  ctx.reset()
  t.is(ctx.fontVariationSettings, 'normal')
})

test('installed variable font does not synthesize bold or italic when fontVariationSettings overrides wght/slnt', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'napi-rs-canvas-vf-installed-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  copyFileSync(join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf'), join(dir, 'RobotoMono-VF.ttf'))
  copyFileSync(join(__dirname, 'fonts', 'ScienceGothic-VariableFont.ttf'), join(dir, 'ScienceGothic-VF.ttf'))
  t.is(GlobalFonts.loadFontsFromDir(dir), 2)

  const render = (font: string, fvs?: string) => {
    const canvas = new Canvas(300, 80)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, 300, 80)
    ctx.fillStyle = '#000'
    ctx.font = font
    if (fvs) ctx.fontVariationSettings = fvs
    ctx.fillText('Hello', 10, 60)
    return Buffer.from(ctx.getImageData(0, 0, 300, 80).data)
  }

  // Installed variable font with wght 100..700: font-weight 700 + 'wght' 400 matches weight 400 (no fake bold)
  const rm400 = render('400 40px "Roboto Mono"')
  const rm700Override400 = render('700 40px "Roboto Mono"', '"wght" 400')
  t.true(rm400.equals(rm700Override400))

  // Installed variable font with slnt -10..0: italic + 'slnt' 0 matches upright (no fake italic)
  const sgNormal = render('400 40px "Science Gothic"')
  const sgItalicOverrideSlnt0 = render('italic 40px "Science Gothic"', '"slnt" 0')
  t.true(sgNormal.equals(sgItalicOverrideSlnt0))
})
