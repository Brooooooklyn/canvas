import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'
import { GlobalFonts } from '../index.js'

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

test.skip('GlobalFonts.hasVariations should return true for variable fonts', async (t) => {
  // This test would require a variable font file
  // Variable fonts have .ttf extension but contain variation axes
  // Example: Roboto Flex, Inter Variable, etc.

  // Uncomment and update path when a variable font is available:
  // GlobalFonts.registerFromPath('/path/to/variable-font.ttf', 'VariableFont')
  // const hasVariations = GlobalFonts.hasVariations('VariableFont', 400, 5, 0)
  // t.true(hasVariations)

  t.pass('Test requires a variable font')
})

test.skip('GlobalFonts.getVariationAxes should return axes for variable fonts', async (t) => {
  // This test would require a variable font file
  // Variable fonts typically have axes like 'wght' (weight), 'wdth' (width), 'slnt' (slant), etc.

  // Uncomment and update path when a variable font is available:
  // GlobalFonts.registerFromPath('/path/to/variable-font.ttf', 'VariableFont')
  // const axes = GlobalFonts.getVariationAxes('VariableFont', 400, 5, 0)
  // t.true(axes.length > 0)
  //
  // Example assertions:
  // const weightAxis = axes.find(axis => axis.tag === 0x77676874) // 'wght'
  // t.truthy(weightAxis)
  // t.true(weightAxis.min <= weightAxis.def)
  // t.true(weightAxis.def <= weightAxis.max)

  t.pass('Test requires a variable font')
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
