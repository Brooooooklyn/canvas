// The default font renderer draws and measures a registered font the same way
// on every OS and CPU: FreeType, no per-OS gamma, no LCD text. This spec never
// switches the renderer, and checks the text-raster scenes and metrics against
// ONE shared snapshot and fixture, made on macOS arm64 with UPDATE_SNAPSHOT=1.
//
// The fonts are registered under names no OS installs (Port*). Installed
// fonts, and so the generic families and the default font that ex/ch/... in
// ctx.font read, still differ per OS (README "Text rendering"), so nothing
// here uses them.
import { createHash } from 'node:crypto'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import PNG from '@jimp/png'
import test from 'ava'

import { createCanvas, SvgExportFlag, type SKRSContext2D } from '../index'
import { drawScene, measureContext, registerTextFonts, T, textScenes } from './text-scenes'

const __dirname = dirname(fileURLToPath(import.meta.url))

const png = PNG()

const SNAPSHOT = join(__dirname, 'snapshots', 'portable-text.png')
const FIXTURE_PATH = join(__dirname, 'fixtures', 'text-portable.json')
const UPDATE = !!process.env.UPDATE_SNAPSHOT || !existsSync(SNAPSHOT) || !existsSync(FIXTURE_PATH)

interface Fixture {
  note: string
  atlasSha1: string
  measure: Record<string, number[]>
  filter: Record<string, number[]>
  svg: Record<string, string>
}

const FIXTURE: Fixture | null = UPDATE ? null : JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
// Each test fills in its part, and the last one writes the fixture.
const update: Fixture = {
  note: 'Default font renderer, made on macOS arm64 by portable-text.spec.ts with UPDATE_SNAPSHOT=1. measure rows are the METRICS fields in order.',
  atlasSha1: '',
  measure: {},
  filter: {},
  svg: {},
}

registerTextFonts('Port')

const SCENES = textScenes('Port')

// The scenes stacked top to bottom, each copied from its own canvas.
function drawAtlas() {
  const images = Object.entries(SCENES).map(([name, scene]) => ({ name, image: drawScene(scene) }))
  const width = Math.max(...images.map(({ image }) => image.width))
  const height = images.reduce((sum, { image }) => sum + image.height, 0)
  const atlas = createCanvas(width, height)
  const ctx = atlas.getContext('2d')
  const rects: { name: string; y: number; width: number; height: number }[] = []
  let y = 0
  for (const { name, image } of images) {
    ctx.putImageData(image, 0, y)
    rects.push({ name, y, width: image.width, height: image.height })
    y += image.height
  }
  return { atlas, rects }
}

const decode = (buffer: Buffer): { width: number; data: Uint8Array } => png.decoders['image/png'](buffer)

test('text-raster scenes draw the same pixels on every OS', async (t) => {
  const { atlas, rects } = drawAtlas()
  const encoded = await atlas.encode('png')
  const actual = decode(encoded)
  const sha1 = createHash('sha1').update(actual.data).digest('hex')
  if (UPDATE) {
    await fs.writeFile(SNAPSHOT, encoded)
    update.atlasSha1 = sha1
    t.pass()
    return
  }
  const expected = decode(await fs.readFile(SNAPSHOT))
  t.is(actual.width, expected.width)
  t.is(actual.data.length, expected.data.length)
  t.log(
    sha1 === FIXTURE!.atlasSha1
      ? 'atlas SHA-1 matches exactly'
      : `atlas SHA-1 ${sha1}, made with ${FIXTURE!.atlasSha1}`,
  )
  // A pixel is inked when it is not the scene's background (its top left
  // pixel). An x64 build differs from an arm64 one by 1 level on a few
  // pixels; another gamma, LCD text or scaler moves thousands by 40+.
  let inked = 0
  let differing = 0
  let maxDiff = 0
  for (const { name, y, width, height } of rects) {
    let sceneDiffering = 0
    const at = (row: number, column: number) => ((y + row) * actual.width + column) * 4
    const background = at(0, 0)
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const i = at(row, column)
        let diff = 0
        let ink = false
        for (let c = 0; c < 4; c++) {
          diff = Math.max(diff, Math.abs(actual.data[i + c] - expected.data[i + c]))
          ink ||= expected.data[i + c] !== expected.data[background + c]
        }
        if (ink) inked++
        if (diff) sceneDiffering++
        maxDiff = Math.max(maxDiff, diff)
      }
    }
    if (sceneDiffering) t.log(`${name}: ${sceneDiffering} pixels differ`)
    differing += sceneDiffering
  }
  const pass = maxDiff <= 2 && differing <= inked * 0.02
  if (!pass) {
    await fs.writeFile(join(__dirname, 'failure', 'portable-text.png'), encoded)
  }
  t.true(pass, `${differing} of ${inked} inked pixels differ, by up to ${maxDiff}`)
})

const METRICS = [
  'width',
  'actualBoundingBoxLeft',
  'actualBoundingBoxRight',
  'actualBoundingBoxAscent',
  'actualBoundingBoxDescent',
  'fontBoundingBoxAscent',
  'fontBoundingBoxDescent',
  'emHeightAscent',
  'emHeightDescent',
  'hangingBaseline',
  'alphabeticBaseline',
  'ideographicBaseline',
] as const

const RASTER_MEASURE: Record<string, unknown> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'text-raster.json'), 'utf8'),
).measure

// The text-raster measure keys, then more text settings on 13px PortLato.
const MEASURE: Record<string, () => { ctx: SKRSContext2D; text: string }> = Object.fromEntries(
  Object.keys(RASTER_MEASURE).map((key) => {
    const portable = key.replaceAll('Raster', 'Port')
    return [portable, () => measureContext(portable)]
  }),
)
const lato =
  (set: (ctx: SKRSContext2D) => void, text = T) =>
  () => {
    const { ctx } = measureContext('13px PortLato|')
    set(ctx)
    return { ctx, text }
  }
Object.assign(MEASURE, {
  'empty string': lato(() => {}, ''),
  'letterSpacing 2px': lato((c) => (c.letterSpacing = '2px')),
  'wordSpacing 5px': lato((c) => (c.wordSpacing = '5px')),
  'fontKerning none': lato((c) => (c.fontKerning = 'none')),
  'textBaseline top': lato((c) => (c.textBaseline = 'top')),
  'textBaseline hanging': lato((c) => (c.textBaseline = 'hanging')),
  'textBaseline middle': lato((c) => (c.textBaseline = 'middle')),
  'textBaseline ideographic': lato((c) => (c.textBaseline = 'ideographic')),
  'textBaseline bottom': lato((c) => (c.textBaseline = 'bottom')),
  'textAlign center': lato((c) => (c.textAlign = 'center')),
  'textRendering optimizeSpeed': lato((c) => (c.textRendering = 'optimizeSpeed')),
  'textRendering optimizeLegibility': lato((c) => (c.textRendering = 'optimizeLegibility')),
  'small-caps': lato((c) => (c.font = 'small-caps 13px PortLato')),
  'rtl Arabic': lato((c) => ((c.font = '24px PortArabic'), (c.direction = 'rtl')), 'مرحبا بالعالم'),
})

// Text metrics match within 1e-3, as text-metrics-chrome.spec.ts does.
function close(actual: number[], expected: number[]) {
  return actual.length === expected.length && actual.every((value, i) => Math.abs(value - expected[i]) <= 1e-3)
}

test('measureText gives the same metrics on every OS', (t) => {
  let exact = 0
  for (const [key, setup] of Object.entries(MEASURE)) {
    const { ctx, text } = setup()
    const metrics = ctx.measureText(text)
    const row = METRICS.map((field) => metrics[field])
    if (UPDATE) {
      update.measure[key] = row
      continue
    }
    const expected = FIXTURE!.measure[key]
    t.true(close(row, expected ?? []), `${key}: ${JSON.stringify(row)} vs ${JSON.stringify(expected)}`)
    if (JSON.stringify(row) === JSON.stringify(expected)) exact++
  }
  if (UPDATE) {
    t.pass()
  } else {
    t.deepEqual(Object.keys(MEASURE), Object.keys(FIXTURE!.measure))
    t.log(`${exact} of ${Object.keys(MEASURE).length} rows match exactly`)
  }
})

// The font-relative lengths of ctx.filter read the canvas font, here
// 20px PortLato: the x of the red shadow's ink centre.
test('ctx.filter font-relative lengths are the same on every OS', (t) => {
  for (const unit of ['ex', 'ch', 'cap']) {
    const canvas = createCanvas(320, 30)
    const ctx = canvas.getContext('2d')
    ctx.font = '20px PortLato'
    ctx.filter = `drop-shadow(10${unit} 0 0 red)`
    ctx.fillRect(4, 10, 10, 10)
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let sum = 0
    let weight = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 0) {
        sum += ((i / 4) % canvas.width) * data[i]
        weight += data[i]
      }
    }
    const row = [weight ? sum / weight : -1]
    const key = `drop-shadow(10${unit} 0 0 red)`
    if (UPDATE) {
      update.filter[key] = row
    } else {
      t.true(close(row, FIXTURE!.filter[key]), `${key}: ${row} vs ${FIXTURE!.filter[key]}`)
    }
  }
  t.pass()
})

const NUMBER = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g

// How far apart the numbers of two texts are, or Infinity when the texts
// differ in more than their numbers.
function numberDistance(actual: string, expected: string) {
  if (actual.replace(NUMBER, '#') !== expected.replace(NUMBER, '#')) return Infinity
  const want = expected.match(NUMBER) ?? []
  return Math.max(0, ...(actual.match(NUMBER) ?? []).map((value, i) => Math.abs(Number(value) - Number(want[i]))))
}

test('SvgCanvas text is the same on every OS', (t) => {
  for (const [name, flag] of [
    ['text', SvgExportFlag.NoPrettyXML],
    ['paths', SvgExportFlag.ConvertTextToPaths],
  ] as const) {
    const canvas = createCanvas(240, 40, flag)
    const ctx = canvas.getContext('2d')
    ctx.font = '24px PortLato'
    ctx.fillText('Hamburgefonstiv', 4, 30)
    const svg = canvas.getContent().toString('utf8')
    if (UPDATE) {
      update.svg[name] = svg
    } else {
      const distance = numberDistance(svg, FIXTURE!.svg[name])
      t.true(distance <= 1e-3, `${name}: numbers differ by ${distance}`)
      if (svg === FIXTURE!.svg[name]) t.log(`${name}: exact`)
    }
  }
  t.pass()
})

test.after.always(async () => {
  if (UPDATE) {
    // One line per row of numbers.
    const json = JSON.stringify(update, null, 2).replace(
      /\[\s+([-\d.e,\s]*?)\s+\]/g,
      (_, row: string) => `[${row.split(/,\s+/).join(', ')}]`,
    )
    await fs.writeFile(FIXTURE_PATH, json + '\n')
  }
})
