import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, FontKey } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fontPath = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')
const fontData = readFileSync(fontPath)
const defaultCount = GlobalFonts.families.length

test('should be able to get global font family names', (t) => {
  t.notThrows(() => GlobalFonts.families)
})

test('should be able to register font and test font existence', (t) => {
  t.is(GlobalFonts.has('114514'), false)

  if (!GlobalFonts.has('Source Serif Pro')) {
    const fontKey = GlobalFonts.register(fontData)
    t.true(fontKey instanceof FontKey)
    t.is(GlobalFonts.families.length, defaultCount + 1)
    t.notThrows(() => {
      GlobalFonts.remove(fontKey!)
    })
  } else {
    t.is(GlobalFonts.families.length, defaultCount)
  }
})

test('multiple identical fonts should only exist within one font family', (t) => {
  GlobalFonts.register(fontData)
  const count = GlobalFonts.families.length
  GlobalFonts.register(fontData)
  GlobalFonts.register(fontData)
  t.is(count, GlobalFonts.families.length)
})

test('return false if font path not existed', (t) => {
  t.is(GlobalFonts.register(Buffer.from('whatever')), null)
})

test('should be able to register font with name alias', (t) => {
  const fontAliasName = 'Cascadia-skr-canvas-test'
  t.true(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Cascadia.woff2'), fontAliasName))
  const styleSet = GlobalFonts.families.find(({ family }) => family === fontAliasName)
  t.deepEqual(styleSet, {
    family: 'Cascadia-skr-canvas-test',
    styles: [{ weight: 400, width: 'normal', style: 'normal' }],
  })
})

test('should be able to register fonts from dir', (t) => {
  t.is(GlobalFonts.loadFontsFromDir(join(__dirname, 'fonts-dir')), 3)
})
