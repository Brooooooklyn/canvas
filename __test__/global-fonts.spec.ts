import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const FONTS = ['40px "Source Serif Pro"', '40px "SOURCE SERIF PRO"', 'bold 40px "source serif pro"', '40px Brand', '40px Brand2', '40px NoSuchFamily', '40px "EB Garamond"']
  const out = { loaded: GlobalFonts.loadFontsFromDir(PROBE_DIR), aliases: [], states: [] }
  const state = () => out.states.push(FONTS.map(width))
  // register:name[:file] (Lato by default), remove[:file]
  const keys = {}
  for (const step of PROBE_STEPS.split(',')) {
    const [kind, a, b] = step.split(':')
    if (kind === 'register') keys[b ?? 'Lato-Regular.ttf'] = GlobalFonts.registerFromPath(PROBE_FONTS + '/' + (b ?? 'Lato-Regular.ttf'), a)
    else if (kind === 'remove') GlobalFonts.remove(keys[a ?? 'Lato-Regular.ttf'])
    else if (kind === 'alias') out.aliases.push(GlobalFonts.setAlias(a, b))
    else if (kind === 'rebuild') GlobalFonts.remove(GlobalFonts.registerFromPath(PROBE_FONTS + '/Oswald.ttf', 'Unrelated'))
    else if (kind === 'switch') {
      setTextRenderer(RENDERER === 'system' ? 'portable' : 'system')
      setTextRenderer(RENDERER)
    } else state()
  }
  console.log(JSON.stringify(out))`

const FONTS_NAMES = [
  '"Source Serif Pro"',
  '"SOURCE SERIF PRO"',
  'bold "source serif pro"',
  'Brand',
  'Brand2',
  'NoSuchFamily',
  '"EB Garamond"',
]

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
    // An alias remembers the registration its face came from, through the
    // chain, whatever spelling each name has. Removing that font drops the
    // aliases: they do not move to another font registered under the same
    // name (EB Garamond here). Removing another font keeps them, and so
    // does removing a font registered after an alias of the installed
    // family.
    const ALIASES = ['alias:Source Serif Pro:Brand', 'alias:Brand:Brand2']
    const FILES = ['Lato-Regular.ttf', 'EBGaramond-Regular.ttf']
    for (const [lato, garamond] of [
      ['Source Serif Pro', 'Source Serif Pro'],
      ['source serif pro', 'source serif pro'],
      ['Source Serif Pro', 'SOURCE SERIF PRO'],
      ['SOURCE SERIF PRO', 'Source Serif Pro'],
    ]) {
      const registers = [`register:${lato}`, `register:${garamond}:EBGaramond-Regular.ttf`]
      // The alias copies what text naming "Source Serif Pro" draws: one of
      // the two registered fonts.
      const [before] = probe([...registers, ...ALIASES]).states
      t.true(near(before[3], before[0]), `${lato}, ${garamond}: Brand ${before[3]}, named ${before[0]}`)
      t.true(near(before[4], before[0]), `${lato}, ${garamond}: Brand2 ${before[4]}, named ${before[0]}`)
      const source = near(before[3], LATO) ? 0 : 1
      t.true(source === 0 || near(before[3], before[6]), `${lato}, ${garamond}: Brand ${before[3]}`)
      for (const [file, removed] of FILES.entries()) {
        const out = probe([...registers, ...ALIASES, `remove:${removed}`])
        t.true(
          out.aliases.every((ok: boolean) => ok),
          `${lato}, ${garamond}: setAlias ${out.aliases}`,
        )
        for (const [i, widths] of out.states.entries()) {
          const at = `${lato}, ${garamond}, ${removed} removed, state ${i}`
          // The other font is what the name draws now.
          t.true(near(widths[0], file === 0 ? widths[6] : LATO), `${at}: named ${widths[0]}`)
          for (const j of [3, 4]) {
            const expected = file === source ? widths[5] : before[3]
            t.true(near(widths[j], expected), `${at}: ${FONTS_NAMES[j]} ${widths[j]}, expected ${expected}`)
          }
        }
      }
    }
    for (const register of ['register:Source Serif Pro', 'register:source serif pro']) {
      for (const [i, widths] of probe([...ALIASES, register, 'remove']).states.entries()) {
        for (const j of [0, 3, 4]) {
          t.true(
            near(widths[j], installed),
            `installed alias, ${register} removed, state ${i}: ${FONTS_NAMES[j]} ${widths[j]}`,
          )
        }
      }
    }
  })
}

// hasVariations and getVariationAxes report the face that text naming the
// family draws: a variable font registered over an installed family (any
// spelling) is that face, for every style. Kept after a rebuild (an
// unrelated font removed) and a renderer switch, with each renderer.
const VARIATIONS_PROBE = `
  const { createCanvas, GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_DIR, PROBE_FONTS } = process.env
  setTextRenderer(RENDERER)
  const width = (font) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = font
    return ctx.measureText('Ag').width
  }
  const QUERIES = [['Source Serif Pro', 400], ['SOURCE SERIF PRO', 400], ['source serif pro', 700]]
  const state = () =>
    QUERIES.map(([name, weight]) => ({
      has: GlobalFonts.hasVariations(name, weight, 5, 0),
      axes: GlobalFonts.getVariationAxes(name, weight, 5, 0).map((axis) => axis.tag),
      width: width(weight + ' 40px "' + name + '"'),
    }))
  const out = { loaded: GlobalFonts.loadFontsFromDir(PROBE_DIR), states: [] }
  out.states.push(state())
  GlobalFonts.registerFromPath(PROBE_FONTS + '/RobotoMono-VariableFont_wght.ttf', 'source serif pro')
  out.robotoMono = [400, 700].map((weight) => width(weight + ' 40px "Roboto Mono"'))
  out.states.push(state())
  GlobalFonts.remove(GlobalFonts.registerFromPath(PROBE_FONTS + '/Oswald.ttf', 'Unrelated'))
  out.states.push(state())
  setTextRenderer(RENDERER === 'system' ? 'portable' : 'system')
  setTextRenderer(RENDERER)
  out.states.push(state())
  console.log(JSON.stringify(out))`

for (const renderer of ['portable', 'system'] as const) {
  test.serial(`variation queries over an installed family use the face text draws (${renderer})`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-installed-family-'))
    t.teardown(() => rmSync(dir, { recursive: true, force: true }))
    copyFileSync(fontPath, join(dir, 'SourceSerifPro-Regular.ttf'))
    const child = spawnSync(process.execPath, ['-e', VARIATIONS_PROBE], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        RENDERER: renderer,
        PROBE_DIR: dir,
        PROBE_FONTS: join(__dirname, 'fonts'),
        PROBE_INDEX: join(__dirname, '..', 'index.js'),
      },
    })
    t.is(child.status, 0, child.stderr)
    const out = JSON.parse(child.stdout)
    t.is(out.loaded, 1)
    const WGHT = 0x77676874
    const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3
    // The installed Source Serif Pro has no axes.
    for (const query of out.states[0]) {
      t.false(query.has)
      t.deepEqual(query.axes, [])
    }
    for (const [i, queries] of out.states.slice(1).entries()) {
      for (const [j, query] of queries.entries()) {
        const at = `state ${i + 1}, query ${j}`
        t.true(near(query.width, out.robotoMono[j === 2 ? 1 : 0]), `${at}: draws ${query.width}`)
        t.true(query.has, `${at}: hasVariations`)
        t.deepEqual(query.axes, [WGHT], `${at}: axes`)
      }
    }
  })
}

// The same file or buffer registered again under another name is the same
// registration (one FontKey): an alias of that name, and an alias of the
// alias, came from it, so removing it drops them (they do not move to
// another font registered under the name, EB Garamond here). Removing the
// other font keeps them. Kept after a rebuild (an unrelated font removed)
// and a renderer switch, with each renderer, for remove() and
// removeBatch().
const DEDUPED_PROBE = `
  const { readFileSync } = require('fs')
  const { createCanvas, GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_HOW, PROBE_REMOVAL, PROBE_TARGET, PROBE_FONTS } = process.env
  setTextRenderer(RENDERER)
  const width = (font) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = font
    return ctx.measureText('Hamburgefonstiv').width
  }
  const register = (file, name) =>
    PROBE_HOW === 'path'
      ? GlobalFonts.registerFromPath(PROBE_FONTS + '/' + file, name)
      : GlobalFonts.register(readFileSync(PROBE_FONTS + '/' + file), name)
  const FONTS = ['40px A', '40px B', '40px C', '40px D', '40px NoSuchFamily', '40px Lato', '40px "EB Garamond"']
  const out = { states: [], has: [] }
  const state = () => {
    out.states.push(FONTS.map(width))
    out.has.push(['A', 'B', 'C', 'D'].map((name) => GlobalFonts.has(name)))
  }
  // EB Garamond first: the face added last under B (Lato) is the one B
  // draws.
  const garamond = register('EBGaramond-Regular.ttf', 'B')
  const lato = register('Lato-Regular.ttf', 'A')
  const again = register('Lato-Regular.ttf', 'B')
  out.sameKey = lato.typefaceId === again.typefaceId
  out.aliases = [GlobalFonts.setAlias('B', 'C'), GlobalFonts.setAlias('C', 'D')]
  state()
  const removed = PROBE_TARGET === 'lato' ? lato : garamond
  out.removed = PROBE_REMOVAL === 'batch' ? GlobalFonts.removeBatch([removed]) : Number(GlobalFonts.remove(removed))
  state()
  GlobalFonts.remove(GlobalFonts.registerFromPath(PROBE_FONTS + '/Oswald.ttf', 'Unrelated'))
  state()
  setTextRenderer(RENDERER === 'system' ? 'portable' : 'system')
  setTextRenderer(RENDERER)
  state()
  console.log(JSON.stringify(out))`

for (const renderer of ['portable', 'system'] as const) {
  test.serial(`an alias of a font registered again under another name goes with it (${renderer})`, (t) => {
    const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3
    for (const how of ['path', 'buffer']) {
      for (const removal of ['single', 'batch']) {
        for (const target of ['lato', 'garamond']) {
          const at = `${how}, ${removal}, ${target} removed`
          const child = spawnSync(process.execPath, ['-e', DEDUPED_PROBE], {
            encoding: 'utf8',
            timeout: 30_000,
            env: {
              ...process.env,
              RENDERER: renderer,
              PROBE_HOW: how,
              PROBE_REMOVAL: removal,
              PROBE_TARGET: target,
              PROBE_FONTS: join(__dirname, 'fonts'),
              PROBE_INDEX: join(__dirname, '..', 'index.js'),
            },
          })
          t.is(child.status, 0, child.stderr)
          const out = JSON.parse(child.stdout)
          t.true(out.sameKey, `${at}: one FontKey`)
          t.deepEqual(out.aliases, [true, true], at)
          t.is(out.removed, 1, at)
          // [A, B, C, D, fallback, Lato, EB Garamond]
          const [before, ...after] = out.states
          const lato = before[5]
          const garamond = before[6]
          t.false(near(lato, garamond), `${at}: Lato ${lato}, EB Garamond ${garamond}`)
          // B has both fonts; the alias copies what text naming B draws:
          // Lato, added to B last.
          for (const j of [0, 1, 2, 3]) {
            t.true(near(before[j], lato), `${at}, before: ${j} ${before[j]}, Lato ${lato}`)
          }
          for (const [i, widths] of after.entries()) {
            const state = `${at}, state ${i + 1}`
            // The names listed, which tells a dropped alias from one that
            // moved to EB Garamond also where the fallback is EB Garamond
            // (a host with no installed fonts).
            t.deepEqual(
              out.has[i + 1],
              target === 'lato' ? [false, true, false, false] : [true, true, true, true],
              state,
            )
            if (target === 'lato') {
              // A, C and D fall back like an unknown name; B is EB Garamond.
              for (const j of [0, 2, 3]) {
                t.true(near(widths[j], widths[4]), `${state}: ${j} ${widths[j]}, fallback ${widths[4]}`)
              }
              t.true(near(widths[1], garamond), `${state}: B ${widths[1]}, EB Garamond ${garamond}`)
            } else {
              for (const j of [0, 1, 2, 3, 5]) {
                t.true(near(widths[j], lato), `${state}: ${j} ${widths[j]}, Lato ${lato}`)
              }
            }
          }
        }
      }
    }
  })
}

const CASE_ALIAS_PROBE = `
  const { createCanvas, GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_FONTS } = process.env
  setTextRenderer(RENDERER)
  const width = (family) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = '40px "' + family + '"'
    return ctx.measureText('Ag').width
  }
  const out = { states: [] }
  const state = () =>
    out.states.push({
      lato: width('lato'),
      latoVariations: GlobalFonts.hasVariations('lato', 400, 5, 0),
      Lato: width('Lato'),
      robotoMono: width('Roboto Mono'),
      BRAND: width('BRAND'),
      hasBRAND: GlobalFonts.has('BRAND'),
    })
  const robotoMono = () =>
    GlobalFonts.registerFromPath(PROBE_FONTS + '/RobotoMono-VariableFont_wght.ttf', 'lato') !== null
  // PROBE_ORDER 'alias-first': Lato, setAlias('Lato', 'lato'), then Roboto
  // Mono as 'lato'. 'font-first': Roboto Mono as 'lato', then Lato and
  // setAlias('Lato', 'lato').
  if (process.env.PROBE_ORDER === 'font-first') out.robotoMono = robotoMono()
  GlobalFonts.registerFromPath(PROBE_FONTS + '/Lato-Regular.ttf')
  GlobalFonts.registerFromPath(PROBE_FONTS + '/Lato-Regular.ttf', 'Brand')
  out.aliases = [GlobalFonts.setAlias('Lato', 'lato'), GlobalFonts.setAlias('Brand', 'BRAND')]
  if (process.env.PROBE_ORDER !== 'font-first') out.robotoMono = robotoMono()
  state()
  GlobalFonts.remove(GlobalFonts.registerFromPath(PROBE_FONTS + '/Oswald.ttf', 'Unrelated'))
  state()
  setTextRenderer(RENDERER === 'system' ? 'portable' : 'system')
  setTextRenderer(RENDERER)
  state()
  console.log(JSON.stringify(out))`

for (const renderer of ['portable', 'system'] as const) {
  test.serial(`a case-only alias is listed at once, in the order of the calls (${renderer})`, (t) => {
    const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3
    for (const order of ['alias-first', 'font-first']) {
      const child = spawnSync(process.execPath, ['-e', CASE_ALIAS_PROBE], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          RENDERER: renderer,
          PROBE_ORDER: order,
          PROBE_FONTS: join(__dirname, 'fonts'),
          PROBE_INDEX: join(__dirname, '..', 'index.js'),
        },
      })
      t.is(child.status, 0, child.stderr)
      const out = JSON.parse(child.stdout)
      t.deepEqual(out.aliases, [true, true], order)
      t.true(out.robotoMono, order)
      // Right after the calls, after an unrelated removal (a rebuild) and
      // after a renderer switch. 'lato' and 'Lato' are one family (Chrome
      // 157: FontFaceCache folds case), and the face added to it last
      // draws: Roboto Mono when it is registered after the alias; Lato
      // (the alias, listed at the call) when the alias comes after it.
      // 'BRAND' is listed.
      for (const [i, s] of out.states.entries()) {
        const at = `${order}, state ${i}`
        t.false(near(s.BRAND, s.robotoMono), `${at}: BRAND ${s.BRAND}, Roboto Mono ${s.robotoMono}`)
        // Roboto Mono has a wght axis, Lato none (no width match needed).
        if (order === 'alias-first') {
          t.true(near(s.lato, s.robotoMono), `${at}: lato ${s.lato}, Roboto Mono ${s.robotoMono}`)
          t.true(near(s.Lato, s.robotoMono), `${at}: Lato ${s.Lato}, Roboto Mono ${s.robotoMono}`)
          t.true(s.latoVariations, at)
        } else {
          t.true(near(s.lato, s.BRAND), `${at}: lato ${s.lato}, Lato ${s.BRAND}`)
          t.true(near(s.Lato, s.BRAND), `${at}: Lato ${s.Lato}, Lato ${s.BRAND}`)
          t.false(s.latoVariations, at)
        }
        t.true(s.hasBRAND, at)
      }
    }
  })
}

// Fonts registered under several spellings of an installed family: the face
// text draws follows the order of the registrations and setAlias calls,
// whatever spelling each used. The face added last wins (EB Garamond, then
// Roboto Mono: Roboto Mono, as with both under one spelling; Chrome 157
// lists the faces of one style newest first). And convertSVGTextToPath uses
// the face canvas text and SVG images use: Lato registered as the installed
// family gives the same path bytes as Lato under its own name. Right after
// the calls, after an unrelated removal (a rebuild) and a renderer switch.
const SPELLINGS_PROBE = `
  const { createCanvas, GlobalFonts, setTextRenderer, convertSVGTextToPath } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_STEPS, PROBE_DIR, PROBE_FONTS } = process.env
  setTextRenderer(RENDERER)
  const NAMES = ['Source Serif Pro', 'source serif pro', 'EB Garamond', 'Roboto Mono', 'Lato']
  const width = (family) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = '40px "' + family + '"'
    return ctx.measureText('Ag').width
  }
  const path = (family) =>
    convertSVGTextToPath(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="5" y="45" font-size="40" font-family="' +
        family + '">Ag</text></svg>',
    ).toString('base64')
  const out = { loaded: GlobalFonts.loadFontsFromDir(PROBE_DIR), installedPath: path('Source Serif Pro'), steps: [], states: [] }
  const state = () =>
    out.states.push({
      widths: NAMES.map(width),
      variations: NAMES.map((name) => GlobalFonts.hasVariations(name, 400, 5, 0)),
      has: NAMES.map((name) => GlobalFonts.has(name)),
      paths: NAMES.map(path),
    })
  // register:name:file, alias:from:to
  for (const step of PROBE_STEPS.split(',')) {
    const [kind, a, b] = step.split(':')
    if (kind === 'register') out.steps.push(GlobalFonts.registerFromPath(PROBE_FONTS + '/' + b, a) !== null)
    else if (kind === 'alias') out.steps.push(GlobalFonts.setAlias(a, b))
    else if (kind === 'rebuild') GlobalFonts.remove(GlobalFonts.registerFromPath(PROBE_FONTS + '/Oswald.ttf', 'Unrelated'))
    else if (kind === 'switch') {
      setTextRenderer(RENDERER === 'system' ? 'portable' : 'system')
      setTextRenderer(RENDERER)
    } else state()
  }
  console.log(JSON.stringify(out))`

for (const renderer of ['portable', 'system'] as const) {
  test.serial(
    `spellings of an installed family: the face added last wins, and SVG paths use the drawn face (${renderer})`,
    (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'canvas-spellings-'))
      t.teardown(() => rmSync(dir, { recursive: true, force: true }))
      copyFileSync(fontPath, join(dir, 'SourceSerifPro-Regular.ttf'))
      const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3
      const probe = (steps: string[]) => {
        const child = spawnSync(process.execPath, ['-e', SPELLINGS_PROBE], {
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
        t.true(
          out.steps.every((ok: boolean) => ok),
          `${steps}: ${out.steps}`,
        )
        t.is(out.states.length, 3)
        return out
      }
      const GARAMOND = 'register:EB Garamond:EBGaramond-Regular.ttf'
      const ROBOTO = 'RobotoMono-VariableFont_wght.ttf'
      for (const steps of [
        ['register:source serif pro:EBGaramond-Regular.ttf', `register:Source Serif Pro:${ROBOTO}`],
        ['register:Source Serif Pro:EBGaramond-Regular.ttf', `register:source serif pro:${ROBOTO}`],
        [GARAMOND, 'alias:EB Garamond:source serif pro', `register:Source Serif Pro:${ROBOTO}`],
        [GARAMOND, 'alias:EB Garamond:Source Serif Pro', `register:source serif pro:${ROBOTO}`],
      ]) {
        for (const [i, s] of probe(steps).states.entries()) {
          const at = `${steps} state ${i}`
          // Roboto Mono has a wght axis, EB Garamond and Source Serif Pro none.
          t.true(s.variations[3], at)
          t.false(near(s.widths[2], s.widths[3]), `${at}: EB Garamond ${s.widths[2]}, Roboto Mono ${s.widths[3]}`)
          for (const j of [0, 1]) {
            t.true(near(s.widths[j], s.widths[3]), `${at}: ${s.widths[j]}, Roboto Mono ${s.widths[3]}`)
            t.true(s.variations[j], at)
            t.true(s.has[j], at)
            t.is(s.paths[j], s.paths[3], at)
          }
        }
      }
      const out = probe(['register:Source Serif Pro:Lato-Regular.ttf'])
      for (const [i, s] of out.states.entries()) {
        const at = `Lato as Source Serif Pro, state ${i}`
        t.true(s.has[4], at)
        t.not(s.paths[4], out.installedPath, at)
        for (const j of [0, 1]) {
          t.true(near(s.widths[j], s.widths[4]), `${at}: ${s.widths[j]}, Lato ${s.widths[4]}`)
          t.is(s.paths[j], s.paths[4], at)
        }
      }
    },
  )
}

const PRELOADED_ALIAS_PROBE = `
  const { createCanvas, GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_DIR, PROBE_FONTS } = process.env
  setTextRenderer(RENDERER)
  const width = (font) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = font
    return ctx.measureText('Ag').width
  }
  const out = { states: [] }
  const state = () =>
    out.states.push({
      brand: width('40px PreBrand'),
      brandBody: width('40px PreBrand, -webkit-body'),
      aliasBody: width('40px PreAlias, -webkit-body'),
      lato: width('40px Lato'),
      latoBody: width('40px Lato, -webkit-body'),
      standard: width('40px NoSuchFamily, -webkit-body'),
      has: [GlobalFonts.has('PreBrand'), GlobalFonts.has('PreAlias'), GlobalFonts.has('Lato')],
    })
  // The standard font where no font is installed (Linux CI): one that does
  // not draw like Lato.
  GlobalFonts.registerFromPath(PROBE_FONTS + '/Oswald.ttf', 'Times New Roman')
  out.loaded = GlobalFonts.loadFontsFromDir(PROBE_DIR)
  // The path as loadFontsFromDir spells it (the platform separator; on
  // Windows '/' would make it another path, so another font).
  out.registered = GlobalFonts.registerFromPath(require('path').join(PROBE_DIR, 'Lato-Regular.ttf'), 'PreBrand') !== null
  out.alias = GlobalFonts.setAlias('PreBrand', 'PreAlias')
  state()
  GlobalFonts.remove(GlobalFonts.registerFromPath(PROBE_FONTS + '/EBGaramond-Regular.ttf', 'Unrelated'))
  state()
  setTextRenderer(RENDERER === 'system' ? 'portable' : 'system')
  setTextRenderer(RENDERER)
  state()
  console.log(JSON.stringify(out))`

// A name given by registerFromPath (and a setAlias of it) is a FontFace name
// also when loadFontsFromDir loaded the same file first: -webkit-body as the
// generic family keeps it, as it keeps any registered font. The file's own
// family name stays installed and gets the standard font. Right after the
// call, after a rebuild and after a renderer switch.
for (const renderer of ['portable', 'system'] as const) {
  test.serial(`a name registered for a file loadFontsFromDir loaded is a FontFace name (${renderer})`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-preloaded-'))
    t.teardown(() => rmSync(dir, { recursive: true, force: true }))
    copyFileSync(join(__dirname, 'fonts', 'Lato-Regular.ttf'), join(dir, 'Lato-Regular.ttf'))
    const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3
    const child = spawnSync(process.execPath, ['-e', PRELOADED_ALIAS_PROBE], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        RENDERER: renderer,
        PROBE_DIR: dir,
        PROBE_FONTS: join(__dirname, 'fonts'),
        PROBE_INDEX: join(__dirname, '..', 'index.js'),
      },
    })
    t.is(child.status, 0, child.stderr)
    const out = JSON.parse(child.stdout)
    t.is(out.loaded, 1)
    t.true(out.registered)
    t.true(out.alias)
    t.is(out.states.length, 3)
    for (const [i, s] of out.states.entries()) {
      const at = `state ${i}`
      t.deepEqual(s.has, [true, true, true], at)
      // The standard font is not Lato, so the widths tell them apart.
      t.false(near(s.standard, s.lato), `${at}: standard ${s.standard}, Lato ${s.lato}`)
      t.true(near(s.brand, s.lato), `${at}: PreBrand ${s.brand}, Lato ${s.lato}`)
      t.true(near(s.brandBody, s.lato), `${at}: PreBrand, -webkit-body ${s.brandBody}, Lato ${s.lato}`)
      t.true(near(s.aliasBody, s.lato), `${at}: PreAlias, -webkit-body ${s.aliasBody}, Lato ${s.lato}`)
      t.true(near(s.latoBody, s.standard), `${at}: Lato, -webkit-body ${s.latoBody}, standard ${s.standard}`)
    }
  })
}

// Chrome 157, FontFaces of the same files (headless, desktop mode, DPR 1;
// canvas-align-work/blink-shaper/stages/S18/chrome.json). A FontFace is a
// font of its own (BinaryDataFontFaceSource::CreateFontData makes its own
// SimpleFontData), so a name a register call gives a file loadFontsFromDir
// loaded follows the web-font rules, as the same file registered from a
// buffer does: tiny ascent and descent round, `oblique 20deg` slants and
// 600 bolds, font-size-adjust sizes it from its own aspect, and trak is
// dropped (OTS). The file's own family name stays an installed font.
const PRELOADED_TWIN_CHROME = {
  oswaldTiny: [2, 1],
  // Iosevka Slab sets USE_TYPO_METRICS: its typo descender is 273, its hhea
  // descender 205 (of 1000). CoreText (macOS system) reads hhea, 0.41 at
  // 2px, which rounds to 0 (Chrome macOS). FreeType, Fontations (Chrome
  // Linux web fonts) and DirectWrite read 273, 0.546, which rounds to 1.
  iosevkaTiny: process.platform === 'darwin' ? [2, 0] : [2, 1],
  iosevkaTinyTypo: [2, 1],
  trak: 108.79998779296875,
  // canvas CSS font-size-adjust 0.5, "40px Lato, OswaldWeb" "Ж"
  fsa: 23.38958740234375,
  // FontFaces "ReX" added in turn: Lato, Oswald, Lato again, Oswald again.
  // After each from the second on: "40px ReX" "Ag" [width, font ascent,
  // font descent] and "2px ReX" "Hg" [font ascent, font descent].
  reRegister: [
    [
      [37.31999206542969, 48, 12],
      [2, 1],
    ],
    [
      [47.639984130859375, 39, 9],
      [2, 0],
    ],
    [
      [37.31999206542969, 48, 12],
      [2, 1],
    ],
  ],
}

const PRELOADED_TWIN_PROBE = `
  const crypto = require('crypto')
  const { readFileSync } = require('fs')
  const { join } = require('path')
  const { createCanvas, GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_DIR, PROBE_FONTS, PROBE_CASE } = process.env
  setTextRenderer(RENDERER)
  const round = (v) => Math.round(v * 1000) / 1000
  const tiny = (family) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = '2px ' + family
    const m = ctx.measureText('Hg')
    return [m.fontBoundingBoxAscent, m.fontBoundingBoxDescent].map(round)
  }
  const box = (style, family) => {
    const ctx = createCanvas(300, 60).getContext('2d')
    ctx.font = style + ' 40px ' + family
    ctx.fillText('Hamburg', 5, 45)
    return ctx.measureText('Hamburg').width + '/' +
      crypto.createHash('sha1').update(ctx.getImageData(0, 0, 300, 60).data).digest('hex')
  }
  const width = (font, text, adjust) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = font
    if (adjust) ctx.fontSizeAdjust = adjust
    return ctx.measureText(text).width
  }
  const ag = (family) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = '40px ' + family
    const m = ctx.measureText('Ag')
    return [m.width, m.fontBoundingBoxAscent, m.fontBoundingBoxDescent]
  }
  const STYLES = ['normal', 'italic', 'oblique 20deg', '600', '700']
  const FILES = { Oswald: 'Oswald.ttf', Iosevka: 'iosevka-slab-regular.ttf', Trak: 'TrakProbe.ttf' }
  const out = { states: [] }
  let state
  GlobalFonts.registerFromPath(PROBE_FONTS + '/Lato-Regular.ttf')
  out.loaded = GlobalFonts.loadFontsFromDir(PROBE_DIR)
  // The paths as loadFontsFromDir spells them (the platform separator).
  if (PROBE_CASE === 'relist') {
    const lato = PROBE_FONTS + '/Lato-Regular.ttf'
    const oswald = join(PROBE_DIR, 'Oswald.ttf')
    state = () => out.states.push({ ag: ag('ReX'), tiny: tiny('ReX') })
    out.steps = [lato, oswald, lato, oswald].map((file, i) => {
      const ok = GlobalFonts.registerFromPath(file, 'ReX') !== null
      if (i > 0) state()
      return ok
    })
  } else if (PROBE_CASE === 'rules') {
    out.steps = Object.entries(FILES).map(
      ([name, file]) =>
        GlobalFonts.registerFromPath(join(PROBE_DIR, file), name + 'Web') !== null &&
        GlobalFonts.register(readFileSync(join(PROBE_FONTS, file)), name + 'Buf') !== null,
    )
    out.steps.push(GlobalFonts.setAlias('OswaldWeb', 'OswaldAlias'))
    state = () =>
      out.states.push({
        tiny: Object.fromEntries(
          ['Oswald', 'OswaldWeb', 'OswaldAlias', 'OswaldBuf', 'IosevkaWeb', 'IosevkaBuf'].map((f) => [f, tiny(f)]),
        ),
        box: Object.fromEntries(
          ['Iosevka Slab', 'IosevkaWeb', 'IosevkaBuf', 'OswaldWeb', 'OswaldBuf', 'TrakWeb', 'TrakBuf'].map((f) => [
            f,
            STYLES.map((style) => box(style, f)),
          ]),
        ),
        trak: Object.fromEntries(['TrakProbe', 'TrakWeb', 'TrakBuf'].map((f) => [f, width('40px ' + f, 'AAAA')])),
        fsa: Object.fromEntries(
          ['Oswald', 'OswaldWeb', 'OswaldBuf'].map((f) => [f, width('40px Lato, ' + f, 'Ж', '0.5')]),
        ),
      })
    state()
  }
  if (PROBE_CASE === 'replaced') {
    // The file is replaced on disk after loadFontsFromDir. The same path is
    // not read again (path dedup), so the name keeps the bytes the font was
    // loaded from in every state and in both renderer modes. The new file
    // is written next to it and renamed over it, as a font file is
    // replaced: written in place, the file the font maps changes under it
    // on Linux, so its own bytes would change too.
    const file = join(PROBE_DIR, 'Oswald.ttf')
    require('fs').copyFileSync(PROBE_FONTS + '/Lato-Regular.ttf', file + '.new')
    require('fs').renameSync(file + '.new', file)
    state = () => out.states.push({ ag: ag('Replaced'), tiny: tiny('Replaced') })
    out.steps = [GlobalFonts.registerFromPath(file, 'Replaced') !== null]
    state()
  }
  // An unrelated font removed (a rebuild), then a renderer switch and back.
  GlobalFonts.remove(GlobalFonts.registerFromPath(PROBE_FONTS + '/EBGaramond-Regular.ttf', 'UnrelatedEBG'))
  state()
  setTextRenderer(RENDERER === 'system' ? 'portable' : 'system')
  if (PROBE_CASE === 'replaced') state()
  setTextRenderer(RENDERER)
  state()
  if (PROBE_CASE === 'rules') {
    // The same FontKey: removing it drops the file's face, the FontFace
    // name and the alias of it.
    out.removed = GlobalFonts.remove(GlobalFonts.registerFromPath(join(PROBE_DIR, 'Oswald.ttf'), 'OswaldWeb'))
    out.has = ['Oswald', 'OswaldWeb', 'OswaldAlias', 'OswaldBuf'].map((f) => GlobalFonts.has(f))
  }
  console.log(JSON.stringify(out))`

function preloadedTwinProbe(t: import('ava').ExecutionContext, renderer: string, probeCase: string) {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-preloaded-twin-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  for (const file of ['Oswald.ttf', 'iosevka-slab-regular.ttf', 'TrakProbe.ttf']) {
    copyFileSync(join(__dirname, 'fonts', file), join(dir, file))
  }
  const child = spawnSync(process.execPath, ['-e', PRELOADED_TWIN_PROBE], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      RENDERER: renderer,
      PROBE_CASE: probeCase,
      PROBE_DIR: dir,
      PROBE_FONTS: join(__dirname, 'fonts'),
      PROBE_INDEX: join(__dirname, '..', 'index.js'),
    },
  })
  t.is(child.status, 0, child.stderr)
  const out = JSON.parse(child.stdout)
  t.is(out.loaded, 3)
  t.true(
    out.steps.every((ok: boolean) => ok),
    `steps ${out.steps}`,
  )
  return out
}

// A name registerFromPath gives the file loadFontsFromDir loaded (the same
// path) is a FontFace: it follows the web-font rules exactly as the same
// file registered from a buffer, right after the calls, after a rebuild and
// after a renderer switch.
for (const renderer of ['portable', 'system'] as const) {
  test.serial(`a name registered for a file loadFontsFromDir loaded follows the FontFace rules (${renderer})`, (t) => {
    const near = (a: number, b: number, d = 1e-3) => Math.abs(a - b) <= d
    const out = preloadedTwinProbe(t, renderer, 'rules')
    t.is(out.states.length, 3)
    for (const [i, s] of out.states.entries()) {
      const at = `state ${i}`
      // Tiny ascent and descent round (Chrome [2, 1]); the alias follows
      // the FontFace name. The installed family keeps the fractions.
      t.deepEqual(s.tiny.OswaldWeb, PRELOADED_TWIN_CHROME.oswaldTiny, at)
      t.deepEqual(s.tiny.OswaldAlias, PRELOADED_TWIN_CHROME.oswaldTiny, at)
      t.deepEqual(s.tiny.OswaldBuf, PRELOADED_TWIN_CHROME.oswaldTiny, at)
      t.deepEqual(s.tiny.Oswald, [2.386, 0.578], at)
      // Portable mode reads the font with FreeType on every platform, so
      // its 2px descent is the typo one there.
      t.deepEqual(s.tiny.IosevkaWeb, s.tiny.IosevkaBuf, at)
      t.deepEqual(
        s.tiny.IosevkaWeb,
        renderer === 'system' ? PRELOADED_TWIN_CHROME.iosevkaTiny : PRELOADED_TWIN_CHROME.iosevkaTinyTypo,
        at,
      )
      // Web synthesis: oblique 20deg = italic, 600 = 700, both != normal.
      for (const family of ['IosevkaWeb', 'OswaldWeb', 'TrakWeb']) {
        const [normal, italic, oblique, w600, w700] = s.box[family]
        t.deepEqual(s.box[family], s.box[family.replace('Web', 'Buf')], `${at}: ${family}`)
        t.is(oblique, italic, `${at}: ${family} oblique 20deg`)
        t.not(italic, normal, `${at}: ${family} italic`)
        t.not(w600, normal, `${at}: ${family} bold`)
        // Oswald is variable: Chrome draws a variable FontFace with no
        // weight descriptor at its default weight (a separate item).
        if (family !== 'OswaldWeb') {
          t.is(w600, w700, `${at}: ${family} 600`)
        }
      }
      // The installed family keeps the installed rules.
      const [normal, , oblique, w600] = s.box['Iosevka Slab']
      t.is(oblique, normal, `${at}: Iosevka Slab oblique 20deg`)
      t.is(w600, normal, `${at}: Iosevka Slab 600`)
      // trak is dropped for the FontFace, kept for the installed font.
      t.true(near(s.trak.TrakWeb, PRELOADED_TWIN_CHROME.trak), `${at}: TrakWeb ${s.trak.TrakWeb}`)
      t.is(s.trak.TrakWeb, s.trak.TrakBuf, at)
      t.false(near(s.trak.TrakProbe, s.trak.TrakWeb), `${at}: TrakProbe ${s.trak.TrakProbe}`)
      // font-size-adjust sizes the FontFace from its own aspect (portable
      // mode reads 23.385).
      t.is(s.fsa.OswaldWeb, s.fsa.OswaldBuf, at)
      t.true(near(s.fsa.OswaldWeb, PRELOADED_TWIN_CHROME.fsa, 0.01), `${at}: fsa ${s.fsa.OswaldWeb}`)
      t.false(near(s.fsa.Oswald, s.fsa.OswaldWeb, 0.5), `${at}: fsa Oswald ${s.fsa.Oswald}`)
    }
    t.true(out.removed)
    // `Oswald` stays: the buffer font is listed under its own name too.
    t.deepEqual(out.has, [true, false, false, true])
  })

  // Registering the same file again under a FontFace name makes it the
  // newest face of that name, as for any FontFace (the file's own name
  // keeps its installed place).
  test.serial(
    `a FontFace name of a file loadFontsFromDir loaded moves to the front when registered again (${renderer})`,
    (t) => {
      const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3
      const out = preloadedTwinProbe(t, renderer, 'relist')
      const expected = [...PRELOADED_TWIN_CHROME.reRegister, PRELOADED_TWIN_CHROME.reRegister[2]]
      t.is(out.states.length, 5)
      for (const [i, s] of out.states.entries()) {
        const [ag, tinyMetrics] = expected[Math.min(i, 2)]
        for (const [j, value] of ag.entries()) {
          t.true(near(s.ag[j], value), `step ${i}: Ag ${s.ag}, Chrome ${ag}`)
        }
        if (ag[0] < 40) {
          t.deepEqual(s.tiny, tinyMetrics, `step ${i}`)
        }
      }
    },
  )

  // The web twin is made from the font's own data, not from the file read
  // again: a name given after the file changed on disk lists the bytes
  // loadFontsFromDir loaded, also in the other renderer mode.
  test.serial(
    `a FontFace name of a file loadFontsFromDir loaded keeps its bytes after the file is replaced (${renderer})`,
    (t) => {
      // Windows does not let a mapped font file be overwritten.
      if (process.platform === 'win32') {
        t.pass()
        return
      }
      const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3
      const out = preloadedTwinProbe(t, renderer, 'replaced')
      const [ag, tinyMetrics] = PRELOADED_TWIN_CHROME.reRegister[0]
      t.is(out.states.length, 4)
      for (const [i, s] of out.states.entries()) {
        for (const [j, value] of ag.entries()) {
          t.true(near(s.ag[j], value), `state ${i}: Ag ${s.ag}, Oswald ${ag}`)
        }
        t.deepEqual(s.tiny, tinyMetrics, `state ${i}`)
      }
    },
  )
}

// Lato with no glyf table: FreeType (portable) opens it, CoreText (system,
// macOS) does not. The tables are kept as they are, only the directory is
// written again.
function withoutGlyf(font: Buffer): Buffer {
  const tables = []
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const at = 12 + 16 * i
    if (font.toString('latin1', at, at + 4) !== 'glyf') {
      tables.push({
        entry: font.subarray(at, at + 16),
        data: font.subarray(font.readUInt32BE(at + 8)).subarray(0, font.readUInt32BE(at + 12)),
      })
    }
  }
  const head = Buffer.alloc(12 + 16 * tables.length)
  font.copy(head, 0, 0, 4)
  const selector = Math.floor(Math.log2(tables.length))
  head.writeUInt16BE(tables.length, 4)
  head.writeUInt16BE(16 << selector, 6)
  head.writeUInt16BE(selector, 8)
  head.writeUInt16BE(tables.length * 16 - (16 << selector), 10)
  const parts = [head]
  let offset = head.length
  for (const [i, { entry, data }] of tables.entries()) {
    entry.copy(head, 12 + 16 * i)
    head.writeUInt32BE(offset, 12 + 16 * i + 8)
    const padded = Buffer.alloc((data.length + 3) & ~3)
    data.copy(padded)
    parts.push(padded)
    offset += padded.length
  }
  return Buffer.concat(parts)
}

// Picks a font file the portable renderer loads and the system renderer
// cannot read: Lato with no glyf table (CoreText), a Type 1 font
// (Fontations). On Windows both renderers are FreeType: none.
const REJECTED_PICK = `
  const { readFileSync } = require('fs')
  const { GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
  const files = JSON.parse(process.env.PROBE_FILES)
  setTextRenderer('system')
  const rejected = files.filter((file) => GlobalFonts.register(readFileSync(file)) === null)
  setTextRenderer('portable')
  console.log(JSON.stringify(rejected.filter((file) => GlobalFonts.register(readFileSync(file)) !== null)))`

// loadFontsFromDir loads the file with the portable renderer, the system
// renderer cannot read it, the file is replaced by Oswald, and a FontFace
// name is registered for it with the system renderer. Each state: "40px"
// "Ag" [width, font ascent, font descent] and "2px" "Hg" [font ascent,
// font descent] of the name and of the file's own family.
const REJECTED_PROBE = `
  const { dirname, join } = require('path')
  const { copyFileSync, readFileSync, renameSync } = require('fs')
  const { createCanvas, GlobalFonts, setTextRenderer } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_FILE, PROBE_OWN, PROBE_FONTS } = process.env
  const round = (v) => Math.round(v * 1000) / 1000
  const metrics = (family) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = '40px ' + family
    const m = ctx.measureText('Ag')
    ctx.font = '2px ' + family
    const tiny = ctx.measureText('Hg')
    return [m.width, m.fontBoundingBoxAscent, m.fontBoundingBoxDescent, tiny.fontBoundingBoxAscent, tiny.fontBoundingBoxDescent].map(round)
  }
  const out = { states: [] }
  const state = (at) => out.states.push({ at, name: metrics('Rejected'), own: metrics(PROBE_OWN) })
  setTextRenderer(RENDERER)
  if (RENDERER === 'system') setTextRenderer('portable')
  out.loaded = GlobalFonts.loadFontsFromDir(dirname(PROBE_FILE))
  setTextRenderer('system')
  // Renamed over the file, not written in place (the replaced-file test).
  copyFileSync(join(PROBE_FONTS, 'Oswald.ttf'), PROBE_FILE + '.new')
  renameSync(PROBE_FILE + '.new', PROBE_FILE)
  out.registered = GlobalFonts.registerFromPath(PROBE_FILE, 'Rejected') !== null
  state('system, after the call')
  GlobalFonts.remove(GlobalFonts.registerFromPath(join(PROBE_FONTS, 'EBGaramond-Regular.ttf'), 'UnrelatedEBG'))
  state('system, after a rebuild')
  for (const renderer of ['portable', 'system', 'portable', 'system']) {
    setTextRenderer(renderer)
    state(renderer + ', after a switch')
  }
  // The file now: Oswald.
  GlobalFonts.register(readFileSync(PROBE_FILE), 'NowOnDisk')
  out.onDisk = metrics('NowOnDisk')
  console.log(JSON.stringify(out))`

// The web twin is made from the preloaded font's own data. When the
// renderer of the call cannot read that data, the name is not made from
// the file read again (now another font): the font gets no twin, and the
// name lists the font's own face in both renderers, right after the call,
// after a rebuild and after every switch.
for (const renderer of ['portable', 'system'] as const) {
  test.serial(
    `a FontFace name of a preloaded font the renderer cannot read keeps the font's own face (${renderer})`,
    (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'canvas-preloaded-rejected-'))
      t.teardown(() => rmSync(dir, { recursive: true, force: true }))
      const own: Record<string, string> = {}
      const files = [
        ['Lato-Regular.ttf', 'Lato'],
        ['Roboto2-Regular.pfb', 'Roboto2'],
      ].map(([font, family], i) => {
        const file = join(mkdtempSync(join(dir, `${i}-`)), font)
        const data = readFileSync(join(__dirname, 'fonts', font))
        writeFileSync(file, font.endsWith('.ttf') ? withoutGlyf(data) : data)
        own[file] = family
        return file
      })
      const env = {
        ...process.env,
        PROBE_INDEX: join(__dirname, '..', 'index.js'),
        PROBE_FONTS: join(__dirname, 'fonts'),
      }
      const pick = spawnSync(process.execPath, ['-e', REJECTED_PICK], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...env, PROBE_FILES: JSON.stringify(files) },
      })
      t.is(pick.status, 0, pick.stderr)
      const [file] = JSON.parse(pick.stdout) as string[]
      if (!file) {
        t.is(process.platform, 'win32', 'the system renderer reads every test file')
        return
      }
      const child = spawnSync(process.execPath, ['-e', REJECTED_PROBE], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...env, RENDERER: renderer, PROBE_FILE: file, PROBE_OWN: own[file] },
      })
      t.is(child.status, 0, child.stderr)
      const out = JSON.parse(child.stdout)
      t.is(out.loaded, 1)
      t.true(out.registered)
      t.is(out.states.length, 6)
      for (const s of out.states) {
        t.deepEqual(s.name, s.own, `${s.at}: the font's own face`)
        t.deepEqual(s, { ...out.states[0], at: s.at }, s.at)
        t.notDeepEqual(s.name, out.onDisk, `${s.at}: not the file read again`)
      }
    },
  )
}

// Steps, separated by commas: reg:FONT[:NAME] (registerFromPath; buf: the
// same with register(buffer)), alias:FAMILY:NAME, remove:FONT (its latest
// registration), dir (loadFontsFromDir of PROBE_DIR), state, rebuild (an
// unrelated font removed), switch (the other renderer and back). Each state
// gives, per name of PROBE_NAMES: "Ag" and "Agक" measureText [width,
// fontBoundingBoxAscent, fontBoundingBoxDescent] at 40px, "Ag" in bold, "Ag"
// with font-variation-settings 'wght' 700 and 400 ([width, actual bounding
// box left, right, ascent]), the convertSVGTextToPath bytes at
// 400 and 700, hasVariations and getVariationAxes. At the end each font of
// PROBE_REFS is registered under a name of its own (Ref + FONT), and its
// state is given in `refs`.
const FACE_ORDER_PROBE = `
  const { readFileSync } = require('fs')
  const { createCanvas, GlobalFonts, setTextRenderer, convertSVGTextToPath } = require(process.env.PROBE_INDEX)
  const { RENDERER, PROBE_STEPS, PROBE_FONTS, PROBE_DIR } = process.env
  const NAMES = JSON.parse(process.env.PROBE_NAMES)
  const FILES = {
    Lato: 'Lato-Regular.ttf',
    Oswald: 'Oswald.ttf',
    RM: 'RobotoMono-VariableFont_wght.ttf',
    Deva: 'NotoSansDevanagari-subset.ttf',
    CJK: 'NotoSansCJKjp-Regular-subset-halt.otf',
    SHSBold: 'SourceHanSerifCN-Bold.ttf',
    SSP: 'SourceSerifPro-Regular.ttf',
  }
  setTextRenderer(RENDERER)
  const metrics = (font, text, settings) => {
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = font
    if (settings) ctx.fontVariationSettings = settings
    const m = ctx.measureText(text)
    return settings
      ? [m.width, m.actualBoundingBoxLeft, m.actualBoundingBoxRight, m.actualBoundingBoxAscent]
      : [m.width, m.fontBoundingBoxAscent, m.fontBoundingBoxDescent]
  }
  const path = (family, weight) =>
    convertSVGTextToPath(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="5" y="45" font-size="40" font-weight="' +
        weight + '" font-family="' + family + '">Ag</text></svg>',
    ).toString('base64')
  const of = (name) => ({
    w: metrics('40px "' + name + '"', 'Ag'),
    deva: metrics('40px "' + name + '"', 'Agक'),
    wb: metrics('bold 40px "' + name + '"', 'Ag'),
    fvs: metrics('40px "' + name + '"', 'Ag', "'wght' 700"),
    ink: metrics('40px "' + name + '"', 'Ag', "'wght' 400"),
    path400: path(name, 400),
    path700: path(name, 700),
    variations: GlobalFonts.hasVariations(name, 400, 5, 0),
    axes: GlobalFonts.getVariationAxes(name, 400, 5, 0).map((axis) => axis.tag),
  })
  const register = (how, font, name) =>
    how === 'buf'
      ? GlobalFonts.register(readFileSync(PROBE_FONTS + '/' + FILES[font]), name)
      : GlobalFonts.registerFromPath(PROBE_FONTS + '/' + FILES[font], name)
  const out = { steps: [], states: [], refs: {} }
  const keys = {}
  for (const step of PROBE_STEPS.split(',')) {
    const [kind, a, b] = step.split(':')
    if (kind === 'reg' || kind === 'buf') {
      keys[a] = register(kind, a, b)
      out.steps.push(keys[a] !== null)
    } else if (kind === 'alias') out.steps.push(GlobalFonts.setAlias(a, b))
    else if (kind === 'remove') out.steps.push(GlobalFonts.remove(keys[a]))
    else if (kind === 'dir') out.steps.push(GlobalFonts.loadFontsFromDir(PROBE_DIR) > 0)
    else if (kind === 'rebuild')
      GlobalFonts.remove(GlobalFonts.registerFromPath(PROBE_FONTS + '/EBGaramond-Regular.ttf', 'UnrelatedEBG'))
    else if (kind === 'switch') {
      setTextRenderer(RENDERER === 'system' ? 'portable' : 'system')
      setTextRenderer(RENDERER)
    } else out.states.push(Object.fromEntries(NAMES.map((name) => [name, of(name)])))
  }
  for (const font of JSON.parse(process.env.PROBE_REFS || '[]')) {
    register('reg', font, 'Ref' + font)
    out.refs[font] = of('Ref' + font)
  }
  out.refs.none = of('NoSuchFamily')
  console.log(JSON.stringify(out))`

function faceOrderProbe(
  t: import('ava').ExecutionContext,
  renderer: string,
  steps: string[],
  names: string[],
  refs: string[],
  dir?: string,
) {
  const child = spawnSync(process.execPath, ['-e', FACE_ORDER_PROBE], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      RENDERER: renderer,
      PROBE_STEPS: [...steps, 'state', 'rebuild', 'state', 'switch', 'state'].join(','),
      PROBE_NAMES: JSON.stringify(names),
      PROBE_REFS: JSON.stringify(refs),
      PROBE_DIR: dir ?? '',
      PROBE_FONTS: join(__dirname, 'fonts'),
      PROBE_INDEX: join(__dirname, '..', 'index.js'),
    },
  })
  t.is(child.status, 0, child.stderr)
  const out = JSON.parse(child.stdout)
  t.true(
    out.steps.every((ok: boolean) => ok),
    `${steps}: ${out.steps}`,
  )
  t.is(out.states.length, 3)
  return out
}

// Chrome 157 (fixtures/face-order.json): faces of one style under one family
// name are listed newest first (CSSSegmentedFontFace::GetFontData walks the
// faces in reverse). The face added last draws and gives the font metrics;
// the older faces of that style are its fallback, before the next family
// (FontFallbackIterator walks every face of the segmented font). Registering
// a font again makes it the newest (a FontFace added again); removing the
// newest gives the next one back.
const FACE_ORDER = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'face-order.json'), 'utf8'))
// The face each row draws for regular text (registered alone as Ref + font).
const FACE_ORDER_NEWEST: Record<string, string> = {
  'two-faces': 'Oswald',
  'two-faces-rev': 'Lato',
  'three-faces': 'RM',
  'var-last': 'RM',
  'with-bold': 'Oswald',
  'cjk-last': 'CJK',
  'alias-last': 'Oswald',
  'alias-first': 'Lato',
  'sibling-glyphs': 'Deva',
  'sibling-glyphs-rev': 'Lato',
  'removed-last': 'Lato',
  're-register': 'Lato',
}
const FACE_ORDER_SIBLINGS = new Set(['sibling-glyphs', 'sibling-glyphs-rev'])

function faceOrderSteps(chrome: string[][], how: 'reg' | 'buf') {
  return chrome.map(([kind, a, b]) => {
    if (kind === 'reg') return [how, a, b].filter(Boolean).join(':')
    if (kind === 'alias') return `alias:${a}:${b}`
    // ['remove', 'reg:FONT:NAME']
    return `remove:${a.split(':')[1]}`
  })
}

for (const renderer of ['portable', 'system'] as const) {
  test.serial(
    `faces of one style under one name: the one added last draws, and the others are its fallback (${renderer})`,
    (t) => {
      const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3
      for (const [key, newest] of Object.entries(FACE_ORDER_NEWEST)) {
        const row = FACE_ORDER.rows[key]
        for (const how of ['reg', 'buf'] as const) {
          const out = faceOrderProbe(t, renderer, faceOrderSteps(row.steps, how), [row.name], [newest])
          const ref = out.refs[newest]
          for (const [i, state] of out.states.entries()) {
            const s = state[row.name]
            const at = `${key} (${how}) state ${i}`
            for (const [j, value] of row.w.Ag.entries()) {
              t.true(near(s.w[j], value), `${at}: Ag ${s.w}, Chrome ${row.w.Ag}`)
            }
            // A character only an older face has comes from it, with the
            // newest face's metrics.
            if (FACE_ORDER_SIBLINGS.has(key)) {
              for (const [j, value] of row.w['Agक'].entries()) {
                t.true(near(s.deva[j], value), `${at}: Agक ${s.deva}, Chrome ${row.w['Agक']}`)
              }
            }
            // Not where the newest regular face is variable: Chrome does not
            // vary a FontFace with no weight descriptor for bold (a separate
            // item).
            if (newest !== 'Oswald' && newest !== 'RM') {
              for (const [j, value] of row.wb.Ag.entries()) {
                t.true(near(s.wb[j], value), `${at}: bold Ag ${s.wb}, Chrome ${row.wb.Ag}`)
              }
            }
            // SVG paths and the variation queries take the newest face.
            t.is(s.path400, ref.path400, `${at}: path`)
            t.is(s.variations, ref.variations, `${at}: hasVariations`)
            t.deepEqual(s.axes, ref.axes, `${at}: axes`)
            // font-variation-settings reach the newest face, with its
            // older face as a sibling in the same lists (where the newest
            // face has the glyphs).
            if (!FACE_ORDER_SIBLINGS.has(key)) {
              for (const [j, value] of ref.fvs.entries()) {
                t.true(near(s.fvs[j], value), `${at}: 'wght' 700 ${s.fvs}, alone ${ref.fvs}`)
              }
            }
          }
          if (key === 'var-last') {
            t.true(ref.variations, `${key}: Roboto Mono varies`)
            t.false(near(ref.fvs[2], ref.ink[2]), `${key}: 'wght' 700 ${ref.fvs}, 400 ${ref.ink}`)
          }
        }
      }
    },
  )
}

// Chrome 157 (fixtures/text-fonts/family-spellings.json): FontFaceCache keys
// families case-folded, so "Brand", "brand" and "BRAND" are one family, and
// the face is picked by style over all its faces; of two faces of one style
// the one added last draws ("ties"). A setAlias name is one more face of
// that family. The SVG path and the variation queries use the same faces.
const FAMILY_SPELLINGS = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'family-spellings.json'), 'utf8'),
)

for (const renderer of ['portable', 'system'] as const) {
  test.serial(`spellings of a registered-only family are one family (${renderer})`, (t) => {
    const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3
    const rows: [string, string[], Record<string, { w: number; wb: number }>, boolean][] = []
    for (const [key, row] of Object.entries<any>({ ...FAMILY_SPELLINGS.pinned, ...FAMILY_SPELLINGS.ties })) {
      const steps = row.faces.map(([name, font]: string[]) =>
        // Source Serif Pro under its own name: no alias.
        name === 'Source Serif Pro' ? `reg:${font}` : `reg:${font === 'RobotoMono' ? 'RM' : font}:${name}`,
      )
      rows.push([key, steps, row.names, key in FAMILY_SPELLINGS.pinned])
    }
    // A setAlias name of the family's spelling is a face of it too.
    rows.push([
      'b-alias',
      ['reg:Lato:Brand', 'reg:SHSBold:Other', 'alias:Other:brand'],
      FAMILY_SPELLINGS.pinned['b-style'].names,
      true,
    ])
    for (const [key, steps, names, styled] of rows) {
      const out = faceOrderProbe(t, renderer, steps, Object.keys(names), ['Lato', 'SHSBold', 'Oswald', 'RM', 'SSP'])
      for (const [i, state] of out.states.entries()) {
        for (const [name, chrome] of Object.entries(names)) {
          const s = state[name]
          const at = `${key} ${name} state ${i}`
          t.true(near(s.w[0], chrome.w), `${at}: ${s.w[0]}, Chrome ${chrome.w}`)
          // Ties are faces of one style: bold is that face (variable bold
          // is a separate item, so only the style rows pin it).
          if (styled) t.true(near(s.wb[0], chrome.wb), `${at}: bold ${s.wb[0]}, Chrome ${chrome.wb}`)
          const regular =
            key === 'b-own' ? 'SSP' : near(chrome.w, 47.64) ? 'Lato' : near(chrome.w, 37.32) ? 'Oswald' : 'RM'
          t.is(s.path400, out.refs[regular].path400, `${at}: path 400 ${regular}`)
          if (styled) t.is(s.path700, out.refs.SHSBold.path700, `${at}: path 700`)
          t.is(s.variations, out.refs[regular].variations, `${at}: hasVariations`)
        }
      }
    }
  })
}

// An installed family (here from loadFontsFromDir) matches in any case for
// convertSVGTextToPath, hasVariations, getVariationAxes and setAlias, as for
// canvas text (Chrome 157: "helvetica" draws Helvetica in canvas and SVG
// text).
for (const renderer of ['portable', 'system'] as const) {
  test.serial(
    `a case-only spelling of an installed family is that family for SVG paths, variation queries and setAlias (${renderer})`,
    (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'canvas-case-installed-'))
      t.teardown(() => rmSync(dir, { recursive: true, force: true }))
      copyFileSync(fontPath, join(dir, 'SourceSerifPro-Regular.ttf'))
      copyFileSync(join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf'), join(dir, 'RobotoMono.ttf'))
      const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3
      const NAMES = [
        'Source Serif Pro',
        'source serif pro',
        'SOURCE SERIF PRO',
        'Roboto Mono',
        'roboto mono',
        'SspAlias',
      ]
      // Each font is also registered alone (RefSSP, RefRM) at the end, so a
      // spelling's path is checked against that font itself. A check against
      // the fallback path does not hold on a host with no fonts installed:
      // there the fallback is one of these two fonts.
      const out = faceOrderProbe(t, renderer, ['dir', 'alias:source serif pro:SspAlias'], NAMES, ['SSP', 'RM'], dir)
      const WGHT = 0x77676874
      for (const [i, s] of out.states.entries()) {
        const at = `state ${i}`
        for (const [spelling, exact, font] of [
          ['source serif pro', 'Source Serif Pro', 'SSP'],
          ['SOURCE SERIF PRO', 'Source Serif Pro', 'SSP'],
          ['roboto mono', 'Roboto Mono', 'RM'],
        ]) {
          t.is(s[spelling].path400, s[exact].path400, `${at}: ${spelling} path`)
          t.is(s[spelling].path400, out.refs[font].path400, `${at}: ${spelling} path is ${exact}`)
          t.is(s[spelling].variations, s[exact].variations, `${at}: ${spelling} hasVariations`)
          t.deepEqual(s[spelling].axes, s[exact].axes, `${at}: ${spelling} axes`)
        }
        t.true(s['roboto mono'].variations, at)
        t.deepEqual(s['roboto mono'].axes, [WGHT], at)
        t.true(near(s.SspAlias.w[0], s['Source Serif Pro'].w[0]), `${at}: SspAlias ${s.SspAlias.w[0]}`)
        t.is(s.SspAlias.path400, s['Source Serif Pro'].path400, `${at}: SspAlias path`)
      }
    },
  )
}
