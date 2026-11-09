import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import {
  convertSVGTextToPath,
  createCanvas,
  FontKey,
  getTextRenderer,
  GlobalFonts,
  Image,
  setTextRenderer,
  SvgExportFlag,
} from '../index'

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
  t.true(
    GlobalFonts.families.some(({ family }) => family === fontAliasName),
    'Font should exist after registration',
  )

  // Remove using the returned FontKey
  const removeResult = GlobalFonts.remove(fontKey!)
  t.true(removeResult, 'remove() should succeed with FontKey from registerFromPath')

  // Verify font is gone
  t.false(
    GlobalFonts.families.some(({ family }) => family === fontAliasName),
    'Font should be removed',
  )
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
  t.true(
    GlobalFonts.families.some(({ family }) => family === fontAliasName),
    'Font should exist after registration',
  )

  // Remove font
  const removeResult = GlobalFonts.remove(fontKey!)
  t.true(removeResult, 'remove() should return true')

  // Verify font is no longer in families list
  t.false(
    GlobalFonts.families.some(({ family }) => family === fontAliasName),
    'Font should NOT exist after removal',
  )
})

test.serial('re-registering font after removal should make it visible again', (t) => {
  const fontAliasName = 'ReRegisterTest-Font'
  const fontPath2 = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')
  const fontData2 = readFileSync(fontPath2)

  // Register font
  const fontKey1 = GlobalFonts.register(fontData2, fontAliasName)
  t.true(fontKey1 instanceof FontKey)
  t.true(
    GlobalFonts.families.some(({ family }) => family === fontAliasName),
    'Font should exist after first registration',
  )

  // Remove font
  t.true(GlobalFonts.remove(fontKey1!))
  t.false(
    GlobalFonts.families.some(({ family }) => family === fontAliasName),
    'Font should NOT exist after removal',
  )

  // Re-register font with same alias
  const fontKey2 = GlobalFonts.register(fontData2, fontAliasName)
  t.true(fontKey2 instanceof FontKey)
  t.true(
    GlobalFonts.families.some(({ family }) => family === fontAliasName),
    'Font should exist after re-registration',
  )

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
  t.true(
    GlobalFonts.families.some(({ family }) => family === fontAliasName),
    'Font should exist under alias',
  )

  // Verify font is also accessible under original family name
  t.true(
    GlobalFonts.families.some(({ family }) => family === originalFamilyName),
    'Font should exist under original family name',
  )

  // Count styles after registration (should have increased)
  const originalStylesAfterReg = GlobalFonts.families.find((f) => f.family === originalFamilyName)?.styles.length ?? 0
  t.true(originalStylesAfterReg > originalStylesBefore, 'Original family should have more styles after registration')

  // Remove font
  GlobalFonts.remove(fontKey!)

  // Verify alias is gone
  t.false(
    GlobalFonts.families.some(({ family }) => family === fontAliasName),
    'Alias should be removed',
  )

  // Verify style count returned to original (our registration's style was removed)
  const originalStylesAfterRemove =
    GlobalFonts.families.find((f) => f.family === originalFamilyName)?.styles.length ?? 0
  t.is(
    originalStylesAfterRemove,
    originalStylesBefore,
    'Original family style count should return to pre-registration level',
  )
})

test.serial(
  're-registering font after removing colliding font should return same ID (collision dedupe bypass fix)',
  (t) => {
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
  },
)

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
  t.true(
    GlobalFonts.families.some((f) => f.family === 'StaleAliasX'),
    'Alias should exist',
  )

  // Step 3: Remove Font A
  t.true(GlobalFonts.remove(fontKeyA!), 'Font A removal should succeed')

  // Verify alias is gone (font was removed)
  t.false(
    GlobalFonts.families.some((f) => f.family === 'StaleAliasX'),
    'Alias should be gone after font removal',
  )

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

// A removed font is freed: neither the old font provider nor Skia's glyph
// cache keeps it. Each cycle copies the 4.7 MB font; before, every removed
// copy stayed (about 5 MB per cycle).
test.serial('register / draw / remove of a buffer font keeps memory flat', (t) => {
  const data = readFileSync(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  const canvas = createCanvas(200, 40)
  const ctx = canvas.getContext('2d')
  let rssAt10 = 0
  for (let i = 1; i <= 40; i++) {
    const key = GlobalFonts.register(data, 'RssCycleFont')
    t.true(key instanceof FontKey)
    ctx.font = `${12 + (i % 5)}px RssCycleFont`
    t.true(ctx.measureText('cycle ' + i).width > 0)
    ctx.fillText('cycle ' + i, 2, 30)
    // Draws the pending recording, which holds the fonts it drew with.
    ctx.getImageData(0, 0, 1, 1)
    t.true(GlobalFonts.remove(key!))
    if (i === 10) {
      rssAt10 = process.memoryUsage().rss
    }
  }
  const growth = (process.memoryUsage().rss - rssAt10) / 1048576
  t.true(growth < 20, `RSS grew ${growth.toFixed(1)} MB from cycle 10 to 40`)
})

// A font registered from a path maps its file; the mapping goes with the
// removed font.
const linuxTest = process.platform === 'linux' ? test.serial : test.serial.skip
linuxTest('a removed path font leaves no mapping of its file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-free-fonts-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'FreedLato.ttf')
  copyFileSync(join(__dirname, 'fonts', 'Lato-Regular.ttf'), file)
  const ctx = createCanvas(10, 10).getContext('2d')
  for (let i = 0; i < 50; i++) {
    const key = GlobalFonts.registerFromPath(file, 'FreedLato')
    t.true(key instanceof FontKey)
    ctx.font = '16px FreedLato'
    t.true(ctx.measureText('mapped ' + i).width > 0)
    t.true(GlobalFonts.remove(key!))
  }
  const mapped = readFileSync('/proc/self/maps', 'utf8')
    .split('\n')
    .filter((line) => line.includes(file))
  t.is(mapped.length, 0)
})

// Objects made while a font is registered stay usable once it is removed
// and its provider is freed (the case the old providers were kept for):
// an SVG image with text, an SVG canvas, and a raster canvas drawn later as
// a source.
test.serial('objects made with a removed font draw after more rebuilds and a renderer switch', async (t) => {
  const renderer = getTextRenderer()
  t.teardown(() => setTextRenderer(renderer))
  const key = GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), 'FreedFontX')
  t.true(key instanceof FontKey)
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40">' +
      '<text x="2" y="30" font-family="FreedFontX" font-size="24">Freed text</text></svg>',
  )
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = (err) => reject(err)
    image.src = svg
  })
  const svgCanvas = createCanvas(200, 40, SvgExportFlag.ConvertTextToPaths)
  const svgCtx = svgCanvas.getContext('2d')
  svgCtx.font = '24px FreedFontX'
  svgCtx.fillText('Freed svg', 2, 30)
  const raster = createCanvas(200, 40)
  const rasterCtx = raster.getContext('2d')
  rasterCtx.font = '24px FreedFontX'
  rasterCtx.fillText('Freed raster', 2, 30)
  const expected = createCanvas(200, 40)
  expected.getContext('2d').drawImage(raster, 0, 0)
  const expectedPixels = expected.getContext('2d').getImageData(0, 0, 200, 40).data

  t.true(GlobalFonts.remove(key!))
  // Three more rebuilds and a renderer switch free every provider that
  // listed the font.
  const other = readFileSync(join(__dirname, 'fonts', 'Virgil.woff2'))
  for (let i = 0; i < 3; i++) {
    t.true(GlobalFonts.remove(GlobalFonts.register(other, 'FreedFontOther')!))
  }
  setTextRenderer(renderer === 'portable' ? 'system' : 'portable')

  // The raster source draws what it drew before.
  const again = createCanvas(200, 40)
  again.getContext('2d').drawImage(raster, 0, 0)
  t.deepEqual(again.getContext('2d').getImageData(0, 0, 200, 40).data, expectedPixels)

  const out = createCanvas(200, 40)
  const outCtx = out.getContext('2d')
  outCtx.drawImage(image, 0, 0)
  outCtx.drawImage(raster, 0, 0)
  svgCtx.fillText('after', 2, 10)
  t.true(svgCanvas.getContent().length > 0)
  t.true(convertSVGTextToPath(svg).length > 0)
  rasterCtx.fillText('after', 2, 10)
  // The removed family now falls back like any unknown family. A host with
  // no system fonts (the node:slim CI images) has no fallback font, so the
  // width is 0 there; compare with a new context instead of with 0.
  const fresh = createCanvas(200, 40).getContext('2d')
  fresh.font = '24px FreedFontX'
  t.is(rasterCtx.measureText('after').width, fresh.measureText('after').width)
  t.true(out.toBuffer('image/png').length > 0)
})

// Removing one font drops every cached glyph; a kept font draws the same
// pixels after it.
test.serial('a kept font draws the same pixels after another font is removed', (t) => {
  const keep = GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'EBGaramond-Regular.ttf'), 'FreedKeepA')
  const drop = GlobalFonts.register(readFileSync(join(__dirname, 'fonts', 'Oswald.ttf')), 'FreedDropB')
  t.true(keep instanceof FontKey)
  t.true(drop instanceof FontKey)
  t.teardown(() => {
    GlobalFonts.remove(keep!)
  })
  const draw = () => {
    const canvas = createCanvas(240, 50)
    const ctx = canvas.getContext('2d')
    ctx.font = '28px FreedKeepA'
    ctx.fillText('Kept glyphs 123', 4, 36)
    ctx.font = '28px FreedDropB'
    ctx.measureText('Dropped')
    return ctx.getImageData(0, 0, 240, 50).data
  }
  const before = draw()
  t.true(GlobalFonts.remove(drop!))
  const after = createCanvas(240, 50)
  const ctx = after.getContext('2d')
  ctx.font = '28px FreedKeepA'
  ctx.fillText('Kept glyphs 123', 4, 36)
  t.deepEqual(ctx.getImageData(0, 0, 240, 50).data, before)
})

// A name registered over an installed family works like a FontFace (Chrome's
// FontFaceCache): a family list that names it draws the registered faces,
// for every style; the generic families and the standard font keep the
// installed faces. In a child process, as the registrations would change the
// other tests. Lato "Ag" 40px = 47.64 on every OS.
test.serial('a name registered over an installed family is used only where it is named', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-installed-family-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  copyFileSync(fontPath, join(dir, 'SourceSerifPro-Regular.ttf'))
  // The serif setting and fontconfig's serif list (font_families.cpp
  // SettingsFamily, FindFontconfig, AlternateFamilyName), in lookup order.
  const SERIF = [
    'Times New Roman',
    'Tinos',
    'Liberation Serif',
    'Times',
    'Noto Serif',
    'DejaVu Serif',
    'Thorndale AMT',
    'Luxi Serif',
    'Nimbus Roman No9 L',
    'Nimbus Roman',
  ]
  const script = `
    const { createCanvas, GlobalFonts } = require(${JSON.stringify(join(__dirname, '..', 'index.js'))})
    const width = (font) => {
      const ctx = createCanvas(10, 10).getContext('2d')
      ctx.font = font
      return ctx.measureText('Ag').width
    }
    const FONTS = ['40px "Source Serif Pro"', 'bold 40px "Source Serif Pro"', '40px NoSuchFamily, "Source Serif Pro"']
    const out = { loaded: GlobalFonts.loadFontsFromDir(${JSON.stringify(dir)}) }
    out.before = FONTS.map(width)
    GlobalFonts.registerFromPath(${JSON.stringify(join(__dirname, 'fonts', 'Lato-Regular.ttf'))}, 'Source Serif Pro')
    out.after = FONTS.map(width)
    out.serifName = ${JSON.stringify(SERIF)}.find((name) => GlobalFonts.has(name)) ?? null
    if (out.serifName) {
      out.serifBefore = width('40px serif')
      GlobalFonts.registerFromPath(${JSON.stringify(join(__dirname, 'fonts', 'Lato-Regular.ttf'))}, out.serifName)
      out.serifAfter = width('40px serif')
      out.serifNamed = width('40px "' + out.serifName + '"')
    }
    console.log(JSON.stringify(out))`
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 })
  t.is(child.status, 0, child.stderr)
  const out = JSON.parse(child.stdout)
  const LATO = 47.63996887207031
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3
  t.is(out.loaded, 1)
  for (const before of out.before) {
    t.false(near(before, LATO), `before: ${before}`)
  }
  for (const after of out.after) {
    t.true(near(after, LATO), `after: ${after}`)
  }
  if (out.serifName) {
    t.true(near(out.serifAfter, out.serifBefore), `serif (${out.serifName}): ${out.serifBefore} -> ${out.serifAfter}`)
    t.true(near(out.serifNamed, LATO), `"${out.serifName}": ${out.serifNamed}`)
  }
})

// The same over an installed family with another spelling of the name (Chrome
// 157: FontFace "helvetica" draws for "40px Helvetica" and "40px HELVETICA",
// Blink's FontFaceCache folds case), and setAlias over it: setAlias(a, b)
// aliases the face text naming a uses now (the registered one), so an alias
// chain draws it and setAlias(a, a) changes nothing. Kept after a rebuild (an
// unrelated font removed) and a renderer switch, with each renderer.
const OVER_INSTALLED_PROBE = `
  const { createCanvas, GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_STEPS, PROBE_DIR, PROBE_FONTS } = process.env
  setTextRenderer(RENDERER)
  const width = (font) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = font
    return ctx.measureText('Ag').width
  }
  const FONTS = ['40px "Source Serif Pro"', '40px "SOURCE SERIF PRO"', 'bold 40px "source serif pro"', '40px Brand', '40px Brand2', '40px NoSuchFamily']
  const out = { loaded: GlobalFonts.loadFontsFromDir(PROBE_DIR), aliases: [], states: [] }
  const state = () => out.states.push(FONTS.map(width))
  let lato = null
  for (const step of PROBE_STEPS.split(',')) {
    const [kind, a, b] = step.split(':')
    if (kind === 'register') lato = GlobalFonts.registerFromPath(PROBE_FONTS + '/Lato-Regular.ttf', a)
    else if (kind === 'remove') GlobalFonts.remove(lato)
    else if (kind === 'alias') out.aliases.push(GlobalFonts.setAlias(a, b))
    else if (kind === 'rebuild') GlobalFonts.remove(GlobalFonts.registerFromPath(PROBE_FONTS + '/Oswald.ttf', 'Unrelated'))
    else if (kind === 'switch') {
      setTextRenderer(RENDERER === 'system' ? 'portable' : 'system')
      setTextRenderer(RENDERER)
    } else state()
  }
  console.log(JSON.stringify(out))`

for (const renderer of ['portable', 'system'] as const) {
  test.serial(`a name registered over an installed family, other spellings and setAlias (${renderer})`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-installed-family-'))
    t.teardown(() => rmSync(dir, { recursive: true, force: true }))
    copyFileSync(fontPath, join(dir, 'SourceSerifPro-Regular.ttf'))
    const probe = (steps: string[]) => {
      const child = spawnSync(process.execPath, ['-e', OVER_INSTALLED_PROBE], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          RENDERER: renderer,
          PROBE_STEPS: [...steps, 'state', 'rebuild', 'state', 'switch', 'state'].join(','),
          PROBE_DIR: dir,
          PROBE_FONTS: join(__dirname, 'fonts'),
          PROBE_INDEX: join(__dirname, '..', 'index.js'),
        },
      })
      t.is(child.status, 0, child.stderr)
      const out = JSON.parse(child.stdout)
      t.is(out.loaded, 1)
      return out
    }
    const LATO = 47.63996887207031
    const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3
    const installed = probe([]).states[0][0]
    t.false(near(installed, LATO), `installed: ${installed}`)
    const check = (steps: string[], expected: (boolean | null)[]) => {
      const out = probe(steps)
      t.true(
        out.aliases.every((ok: boolean) => ok),
        `${steps}: setAlias ${out.aliases}`,
      )
      for (const [i, widths] of out.states.entries()) {
        for (const [j, lato] of expected.entries()) {
          if (lato !== null) {
            t.is(near(widths[j], LATO), lato, `${steps} state ${i}: ${widths[j]}`)
          }
        }
      }
    }
    // Every spelling draws Lato, for every style.
    check(['register:source serif pro'], [true, true, true, null, null])
    check(['register:SOURCE SERIF PRO'], [true, true, true, null, null])
    // An alias and an alias chain of a name over an installed family.
    check(
      ['register:Source Serif Pro', 'alias:Source Serif Pro:Brand', 'alias:Brand:Brand2'],
      [true, true, true, true, true],
    )
    check(['register:source serif pro', 'alias:Source Serif Pro:Brand'], [true, true, true, true, null])
    // setAlias(a, a) changes nothing.
    check(['register:Source Serif Pro', 'alias:Source Serif Pro:Source Serif Pro'], [true, true, true, null, null])
    check(
      ['register:Source Serif Pro', 'state', 'alias:Source Serif Pro:SOURCE SERIF PRO'],
      [true, true, true, null, null],
    )
    // Removing the registered font drops the aliases made from it, also when
    // the alias named another spelling: they do not move to the installed
    // family (Brand and Brand2 fall back like an unknown name).
    for (const register of ['register:Source Serif Pro', 'register:source serif pro']) {
      const out = probe([register, 'alias:Source Serif Pro:Brand', 'alias:Brand:Brand2', 'remove'])
      t.true(
        out.aliases.every((ok: boolean) => ok),
        `${register}: setAlias ${out.aliases}`,
      )
      for (const [i, widths] of out.states.entries()) {
        t.true(near(widths[0], installed), `${register} state ${i}: ${widths[0]}`)
        t.true(near(widths[3], widths[5]), `${register} state ${i}: Brand ${widths[3]}, fallback ${widths[5]}`)
        t.true(near(widths[4], widths[5]), `${register} state ${i}: Brand2 ${widths[4]}, fallback ${widths[5]}`)
      }
    }
  })
}
