import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts } from '../index'

// https://github.com/Brooooooklyn/canvas/issues/1329
// skparagraph's FontCollection memoizes findTypefaces() per
// {family list, weight, slant}. Registering a face never invalidated that
// cache, so any family/weight resolved before its face existed stayed pinned
// to the older match for the rest of the process.

const __dirname = dirname(fileURLToPath(import.meta.url))
const serifPath = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')
const serifData = readFileSync(serifPath)
const boldData = readFileSync(join(__dirname, 'fonts', 'SourceHanSerifCN-Bold.ttf'))
const anchorData = readFileSync(join(__dirname, 'fonts', 'Oswald.ttf'))

const SAMPLE = 'Andilly (95)'

function measure(font: string) {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = font
  return ctx.measureText(SAMPLE).width
}

// A registered anchor family, appended to every family list that starts with a
// family under test. Before the family under test has a face the list resolves
// to the anchor; afterwards the first entry must win. CI images carry no system
// fonts, so relying on the ambient fallback instead would not be deterministic.
const ANCHOR = 'Issue1329Anchor'
GlobalFonts.register(anchorData, ANCHOR)

// Reference widths, each read through a family that is registered up front and
// never mutated, so no cache entry under test can influence them.
GlobalFonts.register(serifData, 'Issue1329SerifRef')
GlobalFonts.register(boldData, 'Issue1329BoldRef')

const ANCHOR_WIDTH = measure(`400 60px "${ANCHOR}"`)
const SERIF_WIDTH = measure(`400 60px "Issue1329SerifRef"`)
const SERIF_WIDTH_30 = measure(`400 30px "Issue1329SerifRef"`)
const BOLD_WIDTH = measure(`700 60px "Issue1329BoldRef"`)
const BOLD_WIDTH_30 = measure(`700 30px "Issue1329BoldRef"`)

test.serial('the three reference faces have distinct metrics', (t) => {
  // Guards every assertion below: equal widths would make them pass vacuously.
  t.not(ANCHOR_WIDTH, SERIF_WIDTH)
  t.not(BOLD_WIDTH, SERIF_WIDTH)
  t.not(BOLD_WIDTH_30, SERIF_WIDTH_30)
})

test.serial('registering a family invalidates a lookup cached before it existed', (t) => {
  const family = 'Issue1329Late'

  // Poison the cache: the family has no face yet, so the list falls through to
  // the anchor and that match is memoized under {[family, ANCHOR], 400, upright}.
  t.is(measure(`400 60px "${family}", "${ANCHOR}"`), ANCHOR_WIDTH)

  GlobalFonts.register(serifData, family)

  t.is(measure(`400 60px "${family}", "${ANCHOR}"`), SERIF_WIDTH)
})

test.serial('registering a second weight invalidates the cached first weight', (t) => {
  const family = 'Issue1329Weight'

  GlobalFonts.register(boldData, family)

  // Only the bold face exists, so weight 400 resolves to it and is memoized.
  t.is(measure(`400 60px "${family}"`), BOLD_WIDTH)

  GlobalFonts.register(serifData, family)

  t.is(measure(`400 60px "${family}"`), SERIF_WIDTH)
  // The bold face must survive the invalidation.
  t.is(measure(`700 60px "${family}"`), BOLD_WIDTH)
})

test.serial('font size is not part of the cache key', (t) => {
  const family = 'Issue1329Size'

  GlobalFonts.register(boldData, family)
  // Poison at 60px; 30px shares the key because size lives in SkFont, not in
  // the SkFontStyle the key is built from.
  t.is(measure(`400 60px "${family}"`), BOLD_WIDTH)

  GlobalFonts.register(serifData, family)

  t.is(measure(`400 30px "${family}"`), SERIF_WIDTH_30)
})

test.serial('setAlias invalidates a lookup cached before the alias existed', (t) => {
  const family = 'Issue1329AliasTarget'
  const alias = 'Issue1329Alias'

  GlobalFonts.register(serifData, family)

  t.is(measure(`400 60px "${alias}", "${ANCHOR}"`), ANCHOR_WIDTH)

  t.true(GlobalFonts.setAlias(family, alias))

  t.is(measure(`400 60px "${alias}", "${ANCHOR}"`), SERIF_WIDTH)
})

test.serial('registerFromPath invalidates a lookup cached before it existed', (t) => {
  const family = 'Issue1329Path'

  t.is(measure(`400 60px "${family}", "${ANCHOR}"`), ANCHOR_WIDTH)

  GlobalFonts.registerFromPath(serifPath, family)

  t.is(measure(`400 60px "${family}", "${ANCHOR}"`), SERIF_WIDTH)
})
