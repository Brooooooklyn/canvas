import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, FontKey } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fontPath = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')
const fontData = readFileSync(fontPath)
const defaultCount = GlobalFonts.families.length

test.serial('should be able to get global font family names', (t) => {
  t.notThrows(() => GlobalFonts.families)
})

test.serial('should be able to register font and test font existence', (t) => {
  t.is(GlobalFonts.has('114514'), false)

  if (!GlobalFonts.has('Source Serif Pro')) {
    const fontKey = GlobalFonts.register(fontData)
    t.true(fontKey instanceof FontKey)
    t.is(GlobalFonts.families.length, defaultCount + 1)
    // Verify remove returns true on first removal
    t.true(GlobalFonts.remove(fontKey!))
  } else {
    t.is(GlobalFonts.families.length, defaultCount)
  }
})

test.serial('multiple identical fonts should only exist within one font family', (t) => {
  GlobalFonts.register(fontData)
  const count = GlobalFonts.families.length
  GlobalFonts.register(fontData)
  GlobalFonts.register(fontData)
  t.is(count, GlobalFonts.families.length)
})

test.serial('return false if font path not existed', (t) => {
  t.is(GlobalFonts.register(Buffer.from('whatever')), null)
})

test.serial('should be able to register font with name alias', (t) => {
  const fontAliasName = 'Cascadia-skr-canvas-test'
  const fontKey = GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Cascadia.woff2'), fontAliasName)
  t.true(fontKey instanceof FontKey, 'registerFromPath should return a FontKey')
  const styleSet = GlobalFonts.families.find(({ family }) => family === fontAliasName)
  t.deepEqual(styleSet, {
    family: 'Cascadia-skr-canvas-test',
    styles: [{ weight: 400, width: 'normal', style: 'normal' }],
  })
})

test.serial('should be able to register fonts from dir', (t) => {
  t.is(GlobalFonts.loadFontsFromDir(join(__dirname, 'fonts-dir')), 3)
})

test.serial('registerFromPath should return FontKey that can be used for removal', (t) => {
  const fontAliasName = 'RegisterFromPath-RemovalTest'
  const fontKey = GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), fontAliasName)

  // Verify FontKey is returned
  t.true(fontKey instanceof FontKey, 'registerFromPath should return a FontKey')
  t.is(typeof fontKey!.typefaceId, 'number', 'FontKey should have a numeric typefaceId')

  // Verify font exists
  t.true(GlobalFonts.families.some(({ family }) => family === fontAliasName), 'Font should exist after registration')

  // Remove using the returned FontKey
  const removeResult = GlobalFonts.remove(fontKey!)
  t.true(removeResult, 'remove() should succeed with FontKey from registerFromPath')

  // Verify font is gone
  t.false(GlobalFonts.families.some(({ family }) => family === fontAliasName), 'Font should be removed')
})

test.serial('registerFromPath should return null for non-existent path', (t) => {
  const result = GlobalFonts.registerFromPath('/non/existent/path/font.ttf')
  t.is(result, null, 'registerFromPath should return null for non-existent file')
})

test.serial('remove() should mark font as removed and return correct status', (t) => {
  const fontAliasName = 'RemovalTest-Font'
  const anotherFontPath = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')
  const anotherFontData = readFileSync(anotherFontPath)

  // Register font with unique alias
  const fontKey = GlobalFonts.register(anotherFontData, fontAliasName)
  t.true(fontKey instanceof FontKey)

  // Verify font exists in families
  const familiesBeforeRemoval = GlobalFonts.families
  const hasFont = familiesBeforeRemoval.some(({ family }) => family === fontAliasName)
  t.true(hasFont, 'Font should exist after registration')

  // Remove font and verify it returns true on first call
  const removeResult = GlobalFonts.remove(fontKey!)
  t.true(removeResult, 'remove() should return true on first removal')

  // Verify remove returns false when trying to remove again
  // (font is marked as removed in tracking, even though it may still be in Skia's internal structures)
  const secondRemoveResult = GlobalFonts.remove(fontKey!)
  t.false(secondRemoveResult, 'remove() should return false when font already removed')
})

test.serial('remove() should actually remove font from families list', (t) => {
  const fontAliasName = 'TrueRemovalTest-Font'
  const fontPath2 = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')
  const fontData2 = readFileSync(fontPath2)

  // Register font with unique alias
  const fontKey = GlobalFonts.register(fontData2, fontAliasName)
  t.true(fontKey instanceof FontKey)

  // Verify font exists after registration
  t.true(GlobalFonts.families.some(({ family }) => family === fontAliasName), 'Font should exist after registration')

  // Remove font
  const removeResult = GlobalFonts.remove(fontKey!)
  t.true(removeResult, 'remove() should return true')

  // Verify font is no longer in families list
  t.false(GlobalFonts.families.some(({ family }) => family === fontAliasName), 'Font should NOT exist after removal')
})

test.serial('re-registering font after removal should make it visible again', (t) => {
  const fontAliasName = 'ReRegisterTest-Font'
  const fontPath2 = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')
  const fontData2 = readFileSync(fontPath2)

  // Register font
  const fontKey1 = GlobalFonts.register(fontData2, fontAliasName)
  t.true(fontKey1 instanceof FontKey)
  t.true(GlobalFonts.families.some(({ family }) => family === fontAliasName), 'Font should exist after first registration')

  // Remove font
  t.true(GlobalFonts.remove(fontKey1!))
  t.false(GlobalFonts.families.some(({ family }) => family === fontAliasName), 'Font should NOT exist after removal')

  // Re-register font with same alias
  const fontKey2 = GlobalFonts.register(fontData2, fontAliasName)
  t.true(fontKey2 instanceof FontKey)
  t.true(GlobalFonts.families.some(({ family }) => family === fontAliasName), 'Font should exist after re-registration')

  // Clean up
  GlobalFonts.remove(fontKey2!)
})

test.serial('font registered with alias should be accessible under both original name and alias', (t) => {
  const fontAliasName = 'DualAccess-Alias'
  const originalFamilyName = 'Source Serif Pro'
  const fontPath2 = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')
  const fontData2 = readFileSync(fontPath2)

  // Count styles before registration (handles pre-existing registrations from other tests)
  const originalStylesBefore = GlobalFonts.families.find((f) => f.family === originalFamilyName)?.styles.length ?? 0

  // Register font with alias
  const fontKey = GlobalFonts.register(fontData2, fontAliasName)
  t.true(fontKey instanceof FontKey)

  // Verify font is accessible under alias
  t.true(GlobalFonts.families.some(({ family }) => family === fontAliasName), 'Font should exist under alias')

  // Verify font is also accessible under original family name
  t.true(GlobalFonts.families.some(({ family }) => family === originalFamilyName), 'Font should exist under original family name')

  // Count styles after registration (should have increased)
  const originalStylesAfterReg = GlobalFonts.families.find((f) => f.family === originalFamilyName)?.styles.length ?? 0
  t.true(originalStylesAfterReg > originalStylesBefore, 'Original family should have more styles after registration')

  // Remove font
  GlobalFonts.remove(fontKey!)

  // Verify alias is gone
  t.false(GlobalFonts.families.some(({ family }) => family === fontAliasName), 'Alias should be removed')

  // Verify style count returned to original (our registration's style was removed)
  const originalStylesAfterRemove = GlobalFonts.families.find((f) => f.family === originalFamilyName)?.styles.length ?? 0
  t.is(originalStylesAfterRemove, originalStylesBefore, 'Original family style count should return to pre-registration level')
})

test.serial('re-registering font after removing colliding font should return same ID (collision dedupe bypass fix)', (t) => {
  // This tests the collision bypass fix where removing a font at the base hash slot
  // would break the probe chain and cause a displaced font to get a new ID on re-registration
  //
  // Scenario being tested:
  // 1. Font A registers with hash H -> gets ID H
  // 2. Font B registers with same hash H -> collision -> gets ID H+1
  // 3. Font A is removed (erase(H) - full deletion, no tombstone)
  // 4. Font B re-registers -> should find existing entry via secondary index, not create duplicate

  const fontAAlias = 'CollisionTest-FontA'
  const fontBAlias = 'CollisionTest-FontB'

  // Use two different fonts so they have different content hashes
  // (In a real collision scenario, they'd have the same hash but different content)
  const fontAPath = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')
  const fontBPath = join(__dirname, 'fonts', 'Cascadia.woff2')
  const fontAData = readFileSync(fontAPath)
  const fontBData = readFileSync(fontBPath)

  // Register font A
  const fontKeyA = GlobalFonts.register(fontAData, fontAAlias)
  t.true(fontKeyA instanceof FontKey, 'Font A should register successfully')

  // Register font B
  const fontKeyB1 = GlobalFonts.register(fontBData, fontBAlias)
  t.true(fontKeyB1 instanceof FontKey, 'Font B should register successfully')

  // Store the internal ID of font B for comparison
  const fontBId1 = fontKeyB1!.typefaceId
  t.is(typeof fontBId1, 'number', 'typefaceId should be a number')

  // Remove font A (this would break probe chain in the old implementation)
  t.true(GlobalFonts.remove(fontKeyA!), 'Font A removal should succeed')

  // Re-register font B - should find existing entry and return same ID
  const fontKeyB2 = GlobalFonts.register(fontBData, fontBAlias)
  t.true(fontKeyB2 instanceof FontKey, 'Font B re-registration should succeed')

  // The key insight: the ID should be the same, not a new one
  const fontBId2 = fontKeyB2!.typefaceId
  t.is(fontBId2, fontBId1, 'Font B should get the same ID after re-registration')

  // Verify only one instance of font B exists in families
  const fontBFamilies = GlobalFonts.families.filter(({ family }) => family === fontBAlias)
  t.is(fontBFamilies.length, 1, 'Font B should appear exactly once in families list')

  // Clean up
  GlobalFonts.remove(fontKeyB2!)
})

test.serial('removeBatch() should remove multiple fonts with single rebuild', (t) => {
  // Use different font files to ensure they get different typeface IDs
  const fontData1 = readFileSync(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'))
  const fontData2 = readFileSync(join(__dirname, 'fonts', 'Cascadia.woff2'))
  const fontData3 = readFileSync(join(__dirname, 'fonts', 'Lato-Regular.ttf'))

  // Register multiple fonts with unique aliases
  const fontKey1 = GlobalFonts.register(fontData1, 'BatchTest-Font1')
  const fontKey2 = GlobalFonts.register(fontData2, 'BatchTest-Font2')
  const fontKey3 = GlobalFonts.register(fontData3, 'BatchTest-Font3')

  t.true(fontKey1 instanceof FontKey)
  t.true(fontKey2 instanceof FontKey)
  t.true(fontKey3 instanceof FontKey)

  // Verify all have different typeface IDs (different fonts)
  t.not(fontKey1!.typefaceId, fontKey2!.typefaceId, 'Font1 and Font2 should have different IDs')
  t.not(fontKey2!.typefaceId, fontKey3!.typefaceId, 'Font2 and Font3 should have different IDs')
  t.not(fontKey1!.typefaceId, fontKey3!.typefaceId, 'Font1 and Font3 should have different IDs')

  // Verify all exist
  t.true(GlobalFonts.families.some((f) => f.family === 'BatchTest-Font1'))
  t.true(GlobalFonts.families.some((f) => f.family === 'BatchTest-Font2'))
  t.true(GlobalFonts.families.some((f) => f.family === 'BatchTest-Font3'))

  // Remove all in batch
  const removedCount = GlobalFonts.removeBatch([fontKey1!, fontKey2!, fontKey3!])
  t.is(removedCount, 3, 'Should report 3 fonts removed')

  // Verify all are gone
  t.false(GlobalFonts.families.some((f) => f.family === 'BatchTest-Font1'))
  t.false(GlobalFonts.families.some((f) => f.family === 'BatchTest-Font2'))
  t.false(GlobalFonts.families.some((f) => f.family === 'BatchTest-Font3'))
})

test.serial('removeBatch() should return 0 when no fonts are removed', (t) => {
  const fontPath2 = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')
  const fontData2 = readFileSync(fontPath2)

  // Register and then remove a font to get a stale key
  const fontKey = GlobalFonts.register(fontData2, 'StaleKeyTest-Font')
  t.true(fontKey instanceof FontKey)
  t.true(GlobalFonts.remove(fontKey!))

  // Try to remove with stale key - should return 0
  const removedCount = GlobalFonts.removeBatch([fontKey!])
  t.is(removedCount, 0, 'Should report 0 fonts removed for stale keys')
})

test.serial('removeBatch() with empty array should return 0', (t) => {
  const removedCount = GlobalFonts.removeBatch([])
  t.is(removedCount, 0, 'Should report 0 fonts removed for empty array')
})

test.serial('removeAll() should remove all registered fonts', (t) => {
  const fontPath2 = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')
  const fontData2 = readFileSync(fontPath2)

  // Register some fonts
  const fontKey1 = GlobalFonts.register(fontData2, 'RemoveAllTest-Font1')
  const fontKey2 = GlobalFonts.register(fontData2, 'RemoveAllTest-Font2')

  t.true(fontKey1 instanceof FontKey)
  t.true(fontKey2 instanceof FontKey)

  // Get count of registered fonts (excluding system fonts - check for our test fonts)
  t.true(GlobalFonts.families.some((f) => f.family === 'RemoveAllTest-Font1'))
  t.true(GlobalFonts.families.some((f) => f.family === 'RemoveAllTest-Font2'))

  // Remove all
  const removedCount = GlobalFonts.removeAll()
  t.true(removedCount >= 2, 'Should remove at least the 2 fonts we registered')

  // Verify our test fonts are gone
  t.false(GlobalFonts.families.some((f) => f.family === 'RemoveAllTest-Font1'))
  t.false(GlobalFonts.families.some((f) => f.family === 'RemoveAllTest-Font2'))
})

test.serial('setAlias() should return false for non-existent font', (t) => {
  const result = GlobalFonts.setAlias('NonExistentFont12345', 'MyAlias')
  t.false(result, 'setAlias should return false for non-existent font')
})

test.serial('setAlias() should return true for existing font', (t) => {
  // Register a font first
  const fontPath2 = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')
  const fontData2 = readFileSync(fontPath2)
  const fontKey = GlobalFonts.register(fontData2, 'SetAliasTest-Font')
  t.true(fontKey instanceof FontKey)

  // Set alias should succeed
  const result = GlobalFonts.setAlias('SetAliasTest-Font', 'SetAliasTest-Alias')
  t.true(result, 'setAlias should return true for existing font')

  // Clean up
  GlobalFonts.remove(fontKey!)
})

test.serial('stale aliases should not transfer to newly registered fonts with same family name', (t) => {
  const fontAPath = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')
  const fontBPath = join(__dirname, 'fonts', 'Cascadia.woff2')
  const fontAData = readFileSync(fontAPath)
  const fontBData = readFileSync(fontBPath)

  // Step 1: Register Font A with alias "StaleAliasTest"
  const fontKeyA = GlobalFonts.register(fontAData, 'StaleAliasTest')
  t.true(fontKeyA instanceof FontKey)

  // Step 2: Set an alias pointing to "StaleAliasTest"
  const aliasSet = GlobalFonts.setAlias('StaleAliasTest', 'StaleAliasX')
  t.true(aliasSet, 'setAlias should succeed')

  // Verify alias exists
  t.true(GlobalFonts.families.some((f) => f.family === 'StaleAliasX'), 'Alias should exist')

  // Step 3: Remove Font A
  t.true(GlobalFonts.remove(fontKeyA!), 'Font A removal should succeed')

  // Verify alias is gone (font was removed)
  t.false(GlobalFonts.families.some((f) => f.family === 'StaleAliasX'), 'Alias should be gone after font removal')

  // Step 4: Register Font B with the SAME alias name "StaleAliasTest"
  const fontKeyB = GlobalFonts.register(fontBData, 'StaleAliasTest')
  t.true(fontKeyB instanceof FontKey)

  // Step 5: Verify "StaleAliasX" does NOT exist (the stale alias should NOT transfer)
  t.false(
    GlobalFonts.families.some((f) => f.family === 'StaleAliasX'),
    'Stale alias should NOT transfer to newly registered font',
  )

  // Step 6: Register and remove an unrelated font to trigger rebuild
  const fontKeyC = GlobalFonts.register(fontAData, 'UnrelatedFont')
  GlobalFonts.remove(fontKeyC!)

  // Step 7: Verify "StaleAliasX" STILL does not exist after rebuild
  t.false(
    GlobalFonts.families.some((f) => f.family === 'StaleAliasX'),
    'Stale alias should NOT appear after rebuild',
  )

  // Clean up
  GlobalFonts.remove(fontKeyB!)
})
