// Installed fonts on macOS are CoreText's, as in Chrome 155: index.js turns
// them on and they are listed at the first font lookup (or by an explicit
// loadSystemFonts). Chrome matches a family name with CoreText
// (font_matcher_mac.mm MatchFontFamily), which finds Times and Courier though
// macOS 27 does not list them, and never matches a hidden "." family or
// LastResort (font_cache_mac.mm IsSystemFontName).
import { spawnSync } from 'node:child_process'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const macTest = process.platform === 'darwin' ? test : test.skip
// The installed fonts differ between macOS versions; Chrome was measured on 27.
const MEASURED_MACOS = process.platform === 'darwin' && Number.parseInt(release(), 10) === 27

// Chrome 155 on macOS 27 (arm64 = x64), each family first with a missing
// family after it: "Hamburgefonstiv" width, actualBoundingBoxAscent,
// fontBoundingBoxAscent and fontBoundingBoxDescent, and the width of "永和"
// (a fallback font draws it). The hidden and LastResort rows draw with the
// default font, Times.
const CHROME: Record<string, [number, number, number, number, number]> = {
  Times: [139.619140625, 13.65234375, 18, 5, 40],
  times: [139.619140625, 13.65234375, 18, 5, 40],
  TIMES: [139.619140625, 13.65234375, 18, 5, 40],
  'Times New Roman': [139.609375, 13.88671875, 18, 4, 40],
  Courier: [180.029296875, 13.4375, 18, 5, 40],
  courier: [180.029296875, 13.4375, 18, 5, 40],
  'Courier New': [180.029296875, 12.666015625, 17, 6, 40],
  Helvetica: [151.181640625, 14.55078125, 18, 5, 40],
  'helvetica neue': [152.79989624023438, 14.440000534057617, 19, 4, 40],
  Menlo: [180.615234375, 15.1953125, 19, 5, 40],
  Geneva: [164.66796875, 15.76171875, 20, 5, 40],
  Monaco: [180.029296875, 16.064453125, 20, 5, 40],
  Arial: [151.181640625, 14.560546875, 18, 4, 40],
  Georgia: [155.185546875, 15.126953125, 18, 4, 40],
  Avenir: [153.31988525390625, 15.3600006103515625, 20, 7, 40],
  Palatino: [157.01171875, 14.55078125, 16, 6, 40],
  '.SF NS': [139.619140625, 13.65234375, 18, 5, 40],
  LastResort: [139.619140625, 13.65234375, 18, 5, 40],
  'Apple Color Emoji': [139.619140625, 13.65234375, 22, 7, 40],
  'PingFang SC': [158.13987731933594, 14.559999465942383, 21, 7, 40],
  'Hiragino Sans': [171.55990600585938, 15.5, 18, 2, 40],
}

function measure(family: string) {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = `20px "${family}", NoSuchFontAtAll`
  const m = ctx.measureText('Hamburgefonstiv')
  return [
    m.width,
    m.actualBoundingBoxAscent,
    m.fontBoundingBoxAscent,
    m.fontBoundingBoxDescent,
    ctx.measureText('永和').width,
  ]
}

;(MEASURED_MACOS ? test : test.skip)('installed font families resolve like Chrome on macOS', (t) => {
  const actual = Object.fromEntries(Object.keys(CHROME).map((family) => [family, measure(family)]))
  t.deepEqual(actual, CHROME)
})

// Chrome 155 on macOS 27, "Hamburgefonstiv a b" at 20px: system-ui, and
// BlinkMacSystemFont (which serializes as "system-ui"), is CoreText's UI font
// (font_cache_mac.mm CreateFontPlatformData, font_matcher_mac.mm
// MatchSystemUIFont); -apple-system and the ui-* keywords are no family
// Chrome knows, so Times draws them. actualBoundingBoxLeft, Ascent and
// Descent, fontBoundingBoxAscent and Descent, and the width for Times. SF's
// width is left out: Chrome applies its AAT tracking at the font size
// (harfbuzz_face.cc hb_font_set_ptem), skparagraph's HarfBuzz at 12pt.
const SYSTEM_UI: Record<string, number[]> = {
  '20px system-ui': [-1.695404052734375, 14.690093994140625, 3.687896728515625, 19, 4],
  'bold 20px system-ui': [-1.58203125, 15.384368896484375, 3.744659423828125, 19, 4],
  '20px BlinkMacSystemFont': [-1.695404052734375, 14.690093994140625, 3.687896728515625, 19, 4],
  'bold 20px BlinkMacSystemFont': [-1.58203125, 15.384368896484375, 3.744659423828125, 19, 4],
  '20px -apple-system': [-0.322265625, 13.65234375, 4.35546875, 18, 5, 168.49609375],
  'bold 20px -apple-system': [-0.361328125, 13.818359375, 4.150390625, 18, 5, 181.123046875],
  '20px ui-sans-serif': [-0.322265625, 13.65234375, 4.35546875, 18, 5, 168.49609375],
  'bold 20px ui-sans-serif': [-0.361328125, 13.818359375, 4.150390625, 18, 5, 181.123046875],
  '20px ui-serif': [-0.322265625, 13.65234375, 4.35546875, 18, 5, 168.49609375],
  'bold 20px ui-serif': [-0.361328125, 13.818359375, 4.150390625, 18, 5, 181.123046875],
  '20px ui-monospace': [-0.322265625, 13.65234375, 4.35546875, 18, 5, 168.49609375],
  'bold 20px ui-monospace': [-0.361328125, 13.818359375, 4.150390625, 18, 5, 181.123046875],
  '20px ui-rounded': [-0.322265625, 13.65234375, 4.35546875, 18, 5, 168.49609375],
  'bold 20px ui-rounded': [-0.361328125, 13.818359375, 4.150390625, 18, 5, 181.123046875],
}

;(MEASURED_MACOS ? test : test.skip)("system-ui is CoreText's UI font like Chrome on macOS", (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  const actual = Object.fromEntries(
    Object.entries(SYSTEM_UI).map(([font, expected]) => {
      ctx.font = font
      const m = ctx.measureText('Hamburgefonstiv a b')
      const values = [
        m.actualBoundingBoxLeft,
        m.actualBoundingBoxAscent,
        m.actualBoundingBoxDescent,
        m.fontBoundingBoxAscent,
        m.fontBoundingBoxDescent,
        m.width,
      ]
      return [font, values.slice(0, expected.length)]
    }),
  )
  t.deepEqual(actual, SYSTEM_UI)
})

macTest('the family "system-ui" is the UI font only by its exact name', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  const width = (font: string) => {
    ctx.font = font
    return ctx.measureText('Hamburgefonstiv a b').width
  }
  t.is(width('20px "system-ui"'), width('20px system-ui'))
  t.is(width('20px BlinkMacSystemFont'), width('20px system-ui'))
  t.not(width('20px system-ui'), width('20px Times'))
  t.is(width('20px "SYSTEM-UI"'), width('20px Times'))
})

macTest('installed family names match in any case, and hidden families never', (t) => {
  t.deepEqual(measure('TIMES'), measure('Times'))
  t.deepEqual(measure('courier'), measure('Courier'))
  t.notDeepEqual(measure('Courier'), measure('NoSuchFontAtAll'))
  t.deepEqual(measure('.SF NS'), measure('NoSuchFontAtAll'))
  t.deepEqual(measure('LastResort'), measure('NoSuchFontAtAll'))
})

// A fresh process, as index.js runs at startup.
function run(script: string, env: Record<string, string> = {}) {
  const { stdout, stderr, status } = spawnSync(process.execPath, ['-e', script], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  if (status !== 0) throw new Error(stderr)
  return JSON.parse(stdout)
}

const PROBE = `
const { createCanvas, GlobalFonts } = require('./index.js')
const width = (family) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = '20px ' + family
  return ctx.measureText('Hamburgefonstiv').width
}
const out = { families: GlobalFonts.families.length, helvetica: width('Helvetica') }
out.loaded = GlobalFonts.loadSystemFonts()
out.loadedAgain = GlobalFonts.loadSystemFonts()
out.faces = GlobalFonts.families.reduce((n, family) => n + family.styles.length, 0)
out.hasHelvetica = GlobalFonts.has('Helvetica')
out.helveticaAfter = width('Helvetica')
console.log(JSON.stringify(out))
`

macTest('DISABLE_SYSTEM_FONTS_LOAD leaves only the registered fonts until loadSystemFonts', (t) => {
  const out = run(PROBE, { DISABLE_SYSTEM_FONTS_LOAD: '1' })
  // Nothing resolves "Helvetica" (or draws at all) before loadSystemFonts.
  t.is(out.families, 0)
  t.is(out.helvetica, 0)
  // loadSystemFonts registers every face CoreText lists, once.
  t.true(out.loaded > 0)
  t.is(out.loadedAgain, out.loaded)
  t.is(out.faces, out.loaded)
  t.true(out.hasHelvetica)
  t.true(out.helveticaAfter > 0)
})

// The font-relative sizes of an SVG image come from Chrome's default font,
// Times on macOS (svg-image-size.spec.ts). With no installed font they fall
// back to the CSS answer: 1ex is 0.5em.
const SVG_PROBE = `
const { Image, GlobalFonts } = require('./index.js')
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2ex" height="20"></svg>'
const width = async () => {
  const image = new Image()
  const loaded = await new Promise((resolve) => {
    image.onload = () => resolve(true)
    image.onerror = () => resolve(false)
    image.src = Buffer.from(svg)
  })
  return loaded ? image.naturalWidth : 'error'
}
;(async () => {
  const out = { before: await width() }
  GlobalFonts.loadSystemFonts()
  out.after = await width()
  console.log(JSON.stringify(out))
})()
`

macTest('an SVG image sized in ex loads before loadSystemFonts with DISABLE_SYSTEM_FONTS_LOAD', (t) => {
  t.deepEqual(run(SVG_PROBE, { DISABLE_SYSTEM_FONTS_LOAD: '1' }), { before: 16, after: 14 })
})

macTest('the installed fonts are listed at the first font lookup', (t) => {
  const out = run(PROBE)
  t.true(out.families > 0)
  t.true(out.helvetica > 0)
  // Already registered: loadSystemFonts returns the same count.
  t.is(out.loadedAgain, out.loaded)
  t.is(out.faces, out.loaded)
})
