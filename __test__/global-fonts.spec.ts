import { join } from 'path'
import test from 'ava'

import { GlobalFonts } from '../index'

const fontPath = join(__dirname, 'SourceSerifPro-Regular.ttf')
const defaultCount = GlobalFonts.families.length

test('should be able to get global font family names', (t) => {
  t.notThrows(() => GlobalFonts.families)
})

test('should be able to register font and test font existence', (t) => {
  t.is(GlobalFonts.has('114514'), false)

  if (!GlobalFonts.has('Source Serif Pro')) {
    GlobalFonts.register(fontPath)
    t.is(GlobalFonts.families.length, defaultCount + 1)
  } else {
    t.is(GlobalFonts.families.length, defaultCount)
  }
})

test('multiple identical fonts should only exist within one font family', (t) => {
  const count = GlobalFonts.families.length
  GlobalFonts.register(fontPath)
  GlobalFonts.register(fontPath)
  GlobalFonts.register(fontPath)
  t.is(count, GlobalFonts.families.length)
})
