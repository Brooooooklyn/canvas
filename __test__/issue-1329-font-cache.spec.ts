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
const regularData = readFileSync(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'))
const boldData = readFileSync(join(__dirname, 'fonts', 'SourceHanSerifCN-Bold.ttf'))

const SAMPLE = 'Andilly (95)'

function measure(font: string) {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = font
  return ctx.measureText(SAMPLE).width
}

test.serial('registering a family invalidates a lookup cached before it existed', (t) => {
  const family = 'Issue1329Late'

  // Poison the cache: the family has no face yet, so this resolves to the
  // fallback and the miss is memoized under {[family], 400, upright}.
  const stale = measure(`400 60px "${family}"`)

  GlobalFonts.register(regularData, family)

  // A family list the cache has never seen resolves the registered face.
  // It is the ground truth for what the poisoned key must now return.
  const expected = measure(`400 60px "${family}", serif`)

  t.not(stale, expected, 'fallback and registered face must differ, otherwise the test proves nothing')
  t.is(measure(`400 60px "${family}"`), expected)
})

test.serial('registering a second weight invalidates the cached first weight', (t) => {
  const family = 'Issue1329Weight'

  GlobalFonts.register(boldData, family)

  // Only the bold face exists, so weight 400 resolves to it and is memoized.
  const stale = measure(`400 60px "${family}"`)
  t.is(stale, measure(`700 60px "${family}"`), 'weight 400 must fall back to the only face')

  GlobalFonts.register(regularData, family)

  const expected = measure(`400 60px "${family}", serif`)
  t.not(stale, expected, 'the two faces must have different metrics')
  t.is(measure(`400 60px "${family}"`), expected)

  // The bold face must survive the invalidation.
  t.is(measure(`700 60px "${family}"`), stale)
})

test.serial('font size is not part of the cache key', (t) => {
  const family = 'Issue1329Size'

  GlobalFonts.register(boldData, family)
  measure(`400 60px "${family}"`)
  GlobalFonts.register(regularData, family)

  t.is(measure(`400 30px "${family}"`), measure(`400 30px "${family}", serif`))
})

test.serial('setAlias invalidates a lookup cached before the alias existed', (t) => {
  const family = 'Issue1329AliasTarget'
  const alias = 'Issue1329Alias'

  GlobalFonts.register(regularData, family)

  const stale = measure(`400 60px "${alias}"`)

  t.true(GlobalFonts.setAlias(family, alias))

  const expected = measure(`400 60px "${alias}", serif`)
  t.not(stale, expected, 'fallback and aliased face must differ, otherwise the test proves nothing')
  t.is(measure(`400 60px "${alias}"`), expected)
})

test.serial('registerFromPath invalidates a lookup cached before it existed', (t) => {
  const family = 'Issue1329Path'

  const stale = measure(`400 60px "${family}"`)

  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), family)

  const expected = measure(`400 60px "${family}", serif`)
  t.not(stale, expected, 'fallback and registered face must differ, otherwise the test proves nothing')
  t.is(measure(`400 60px "${family}"`), expected)
})
