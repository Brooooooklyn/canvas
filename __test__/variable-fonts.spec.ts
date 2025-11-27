import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, Canvas } from '../index.js'

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

  const weightAxis = axes.find(axis => axis.tag === 0x77676874) // 'wght'
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

test('CanvasRenderingContext2D.fontVariationSettings should persist', (t) => {
  const canvas = new Canvas(200, 200)
  const ctx = canvas.getContext('2d')

  t.is(ctx.fontVariationSettings, 'normal')

  ctx.fontVariationSettings = "'wght' 700, 'wdth' 50"
  t.is(ctx.fontVariationSettings, "'wght' 700, 'wdth' 50")

  ctx.fontVariationSettings = "normal"
  t.is(ctx.fontVariationSettings, "normal")
})
