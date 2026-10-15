// Variable font axes and synthetic bold and italic against Chrome 155 (CPU
// canvas, Linux x64). A registered font is a web font with `auto`
// descriptors: font-weight, font-stretch and the oblique angle drive its
// wght, wdth and slnt axes, and Blink only fakes bold (weight >= 600) or
// italic (slope >= 14deg) when the face has no axis that goes there
// (FontCustomPlatformData::GetFontPlatformData). An installed font fakes
// bold when the weight is more than 200 above the face's, and italic only
// for `italic` and plain `oblique` (FontCache::CreateFontPlatformData).
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type Row = [number, number, number, number, number, string]

interface Fixture {
  weights: Record<string, number>
  quant: Record<string, number>
  misc: Record<string, number>
  stretch: Record<string, [number, number]>
  synthetic: Record<string, Row>
  web: Record<string, Row>
  system: Record<string, Row>
  systemFaces: Record<string, string[]>
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'variable-fonts.json'), 'utf8'),
)

const FONTS: Record<string, string> = {
  OswaldT: 'Oswald.ttf',
  GothicT: 'ScienceGothic-VariableFont.ttf',
  RobotoMonoT: 'RobotoMono-VariableFont_wght.ttf',
  InconsolataT: 'Inconsolata-VariableFont_wdth,wght.woff2',
  LatoT: 'Lato-Regular.ttf',
  SerifProT: 'SourceSerifPro-Regular.ttf',
  HanT: 'SourceHanSerifCN-Bold.ttf',
}
for (const [family, file] of Object.entries(FONTS)) {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', file), family)
}

function width(font: string, text: string) {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = font
  return ctx.measureText(text).width
}

function widthMismatches(table: Record<string, number>, read: (key: string) => number) {
  return Object.entries(table)
    .filter(([key, expected]) => !(Math.abs(read(key) - expected) <= 0.01))
    .map(([key, expected]) => `${key}: ${read(key)} (Chrome ${expected})`)
}

function inkBox(ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>, w: number, h: number) {
  const data = ctx.getImageData(0, 0, w, h).data
  let top = -1
  let bottom = -1
  let left = w
  let right = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
        if (top < 0) top = y
        bottom = y
        left = Math.min(left, x)
        right = Math.max(right, x)
      }
    }
  }
  return [left, top, right, bottom].join(',')
}

// fillText("Hamburg", 10, 55) on 400x80: the measured box and the painted
// ink box.
function draw(font: string): Row {
  const ctx = createCanvas(400, 80).getContext('2d')
  ctx.font = font
  ctx.fillText('Hamburg', 10, 55)
  const m = ctx.measureText('Hamburg')
  return [
    m.width,
    m.actualBoundingBoxLeft,
    m.actualBoundingBoxRight,
    m.actualBoundingBoxAscent,
    m.actualBoundingBoxDescent,
    inkBox(ctx, 400, 80),
  ]
}

function rowMismatches(table: Record<string, Row>) {
  const out: string[] = []
  for (const [font, expected] of Object.entries(table)) {
    const actual = draw(font)
    const same = expected.every((value, i) =>
      typeof value === 'string' ? value === actual[i] : Math.abs((actual[i] as number) - value) <= (i ? 1e-3 : 0.01),
    )
    if (!same) out.push(`${font}: ${JSON.stringify(actual)} (Chrome ${JSON.stringify(expected)})`)
  }
  return out
}

test('font-weight drives the wght axis of variable fonts like Chrome', (t) => {
  t.deepEqual(
    widthMismatches(FIXTURE.weights, (key) => {
      const [family, weight] = key.split(' ')
      return width(`${weight} 40px ${family}`, 'Hamburg')
    }),
    [],
  )
  t.deepEqual(
    widthMismatches(FIXTURE.misc, (font) => width(font, 'Hamburg')),
    [],
  )
})

test('the weight and the oblique angle reach the axes in quarter steps like Chrome', (t) => {
  t.deepEqual(
    widthMismatches(FIXTURE.quant, (key) => {
      const font = key.startsWith('w') ? `${key.slice(1)} 400px GothicT` : `oblique ${key.slice(1)} 400px GothicT`
      return width(font, 'Hamburgefonstiv')
    }),
    [],
  )
})

test('the axes stay right once the face caches start over', (t) => {
  // Every weight is a new list of font arguments, and a clone of the face;
  // the collection drops its caches past a few hundred lists.
  const ctx = createCanvas(10, 10).getContext('2d')
  for (let weight = 100; weight <= 900; weight += 1.25) {
    ctx.font = `${weight} 40px GothicT`
    ctx.measureText('Hamburg')
  }
  t.deepEqual(
    widthMismatches(
      Object.fromEntries(Object.entries(FIXTURE.weights).filter(([key]) => key.startsWith('GothicT'))),
      (key) => width(`${key.split(' ')[1]} 40px GothicT`, 'Hamburg'),
    ),
    [],
  )
})

test('font-stretch drives the wdth axis like Chrome', (t) => {
  const out: string[] = []
  for (const [key, [property, shorthand]] of Object.entries(FIXTURE.stretch)) {
    const [family, stretch] = key.split(' ')
    const ctx = createCanvas(10, 10).getContext('2d')
    ctx.font = `40px ${family}`
    ctx.fontStretch = stretch as CanvasFontStretch
    const viaProperty = ctx.measureText('Hamburg').width
    const viaShorthand = width(`${stretch} 40px ${family}`, 'Hamburg')
    if (!(Math.abs(viaProperty - property) <= 0.01 && Math.abs(viaShorthand - shorthand) <= 0.01)) {
      out.push(`${key}: ${viaProperty} ${viaShorthand} (Chrome ${property} ${shorthand})`)
    }
  }
  t.deepEqual(out, [])
})

test('web fonts get synthetic bold and italic like Chrome', (t) => {
  t.deepEqual(rowMismatches(FIXTURE.synthetic), [])
  t.deepEqual(rowMismatches(FIXTURE.web), [])
})

// The rows were measured with the DejaVu faces Linux Chrome had installed;
// only families installed here with the same faces are compared.
function installedFaces(family: string) {
  const entry = GlobalFonts.families.find((f) => f.family === family)
  return entry ? entry.styles.map((s) => `${s.weight} ${s.style}`).sort() : []
}
const SAME_FACES = Object.keys(FIXTURE.systemFaces).filter(
  (family) => JSON.stringify(installedFaces(family)) === JSON.stringify(FIXTURE.systemFaces[family]),
)
const systemTest = SAME_FACES.length ? test : test.skip
systemTest('installed fonts get synthetic bold and italic like Chrome', (t) => {
  const rows = Object.fromEntries(
    Object.entries(FIXTURE.system).filter(([font]) => SAME_FACES.some((family) => font.endsWith(` ${family}`))),
  )
  t.deepEqual(rowMismatches(rows), [])
})

const FONTS_DIR = mkdtempSync(join(tmpdir(), 'napi-rs-canvas-synthetic-'))
test.after.always(() => rmSync(FONTS_DIR, { recursive: true, force: true }))

test('an installed font follows the installed-font rules, a registered one the web rules', (t) => {
  // Iosevka Slab has one face (400, upright), installed from a directory and
  // registered as a web font.
  const file = join(__dirname, 'fonts', 'iosevka-slab-regular.ttf')
  copyFileSync(file, join(FONTS_DIR, 'iosevka-slab-regular.ttf'))
  t.is(GlobalFonts.loadFontsFromDir(FONTS_DIR), 1)
  GlobalFonts.registerFromPath(file, 'IosevkaWeb')
  const box = (style: string, family: string) => draw(`${style} 40px ${family}`)[5]
  const installed = 'Iosevka Slab'
  // The DejaVu rows above: only `italic` and plain oblique (14deg) slant an
  // installed face, and 600 is not more than 200 above 400.
  t.is(box('oblique 20deg', installed), box('normal', installed))
  t.is(box('oblique 14deg', installed), box('italic', installed))
  t.not(box('italic', installed), box('normal', installed))
  t.is(box('600', installed), box('normal', installed))
  t.not(box('700', installed), box('normal', installed))
  // The LatoT rows: any slope from 14deg slants a web face, any weight from
  // 600 makes it bold.
  t.is(box('oblique 20deg', 'IosevkaWeb'), box('italic', 'IosevkaWeb'))
  t.not(box('italic', 'IosevkaWeb'), box('normal', 'IosevkaWeb'))
  t.is(box('600', 'IosevkaWeb'), box('700', 'IosevkaWeb'))
  t.not(box('600', 'IosevkaWeb'), box('normal', 'IosevkaWeb'))
})

// Our fontVariationSettings (Chrome has none) comes after the axes the font
// sets, like CSS font-variation-settings (FontCustomPlatformData appends
// them), so its values win.
test('fontVariationSettings overrides the axes font-weight and font-stretch set', (t) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = '700 40px GothicT'
  ctx.fontStretch = 'expanded'
  ctx.fontVariationSettings = "'wght' 100, 'wdth' 100"
  t.true(Math.abs(ctx.measureText('Hamburg').width - FIXTURE.weights['GothicT 100']) <= 0.01)
})
