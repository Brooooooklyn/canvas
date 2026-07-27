import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import ava, { TestFn } from 'ava'

import { createCanvas, SvgCanvas, SvgExportFlag, GlobalFonts } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const test = ava as TestFn<{
  canvas: SvgCanvas
}>

test.beforeEach((t) => {
  t.context.canvas = createCanvas(1024, 768, SvgExportFlag.ConvertTextToPaths)
})

test('should be able to adjust size', (t) => {
  const { canvas } = t.context
  canvas.width = 512
  canvas.height = 384

  t.is(canvas.width, 512)
  t.is(canvas.height, 384)
})

test('should be able to export path/arc/rect', (t) => {
  const { canvas } = t.context
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'yellow'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.lineWidth = 3
  ctx.strokeStyle = 'hotpink'
  ctx.strokeRect(50, 450, 100, 100)
  ctx.fillStyle = 'hotpink'
  ctx.arc(500, 120, 90, 0, Math.PI * 2)
  ctx.fill()
  t.snapshot(canvas.getContent().toString('utf8'))
})

test('should be able to export text', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts-dir', 'iosevka-curly-regular.woff2'), 'i-curly')
  const { canvas } = t.context
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'yellow'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.lineWidth = 3
  ctx.strokeStyle = 'hotpink'
  ctx.font = '50px i-curly'
  ctx.strokeText('@napi-rs/canvas', 50, 300)
  t.snapshot(canvas.getContent().toString('utf8'))
})

// REGRESSION GUARD, do not weaken to a snapshot.
//
// `SkSVGDevice` cannot make a layer device -- `SkCanvas` substitutes a
// `NoPixelsDevice` that squashes every draw -- so a `ctx.filter` hoisted onto an
// explicit `saveLayer` discards the whole draw and the export comes back as a
// bare 148-byte `<svg/>`. A colour-only filter is left on the content paint on
// this backend; see `Context::render_passes`.
test('ctx.filter without a shadow must not swallow the drawing', (t) => {
  const { canvas } = t.context
  const ctx = canvas.getContext('2d')
  ctx.filter = 'grayscale(1)'
  ctx.fillStyle = 'blue'
  ctx.fillRect(40, 40, 80, 60)
  ctx.strokeStyle = 'red'
  ctx.lineWidth = 6
  ctx.strokeRect(200, 40, 80, 60)
  ctx.beginPath()
  ctx.moveTo(400, 40)
  ctx.lineTo(500, 40)
  ctx.lineTo(450, 140)
  ctx.closePath()
  ctx.fill()

  const svg = canvas.getContent().toString('utf8')
  t.is((svg.match(/<rect/g) ?? []).length, 2, `fillRect and strokeRect must both survive: ${svg}`)
  t.is((svg.match(/<path/g) ?? []).length, 1, `fill(path) must survive: ${svg}`)
})

// The CTM is irrelevant to a filter with no spatial component, so the drawing
// has to survive under one too -- this is the case a CTM-based fix would miss.
test('ctx.filter without a shadow survives a non-identity transform', (t) => {
  const { canvas } = t.context
  const ctx = canvas.getContext('2d')
  ctx.filter = 'grayscale(1)'
  ctx.scale(2, 2)
  ctx.fillStyle = 'blue'
  ctx.fillRect(40, 40, 80, 60)

  const svg = canvas.getContent().toString('utf8')
  t.is((svg.match(/<rect/g) ?? []).length, 1, `the scaled fillRect must survive: ${svg}`)
})

test('ctx.filter without a shadow must not swallow text', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts-dir', 'iosevka-curly-regular.woff2'), 'i-curly')
  const { canvas } = t.context
  const ctx = canvas.getContext('2d')
  ctx.filter = 'grayscale(1)'
  ctx.fillStyle = 'black'
  ctx.font = '50px i-curly'
  ctx.fillText('napi-rs', 50, 300)

  const svg = canvas.getContent().toString('utf8')
  t.true((svg.match(/<path/g) ?? []).length > 0, `fillText must survive: ${svg}`)
})

// Every `ctx.filter` Skia can answer with `asAColorFilter`, i.e. every one this
// backend takes off the layer. `blur()` and `drop-shadow()` are deliberately
// absent; they keep the layer and are guarded separately below.
const COLOUR_ONLY_FILTERS = ['grayscale(1)', 'opacity(0.5)', 'sepia(1)', 'invert(1)', 'brightness(0.5)', 'saturate(2)']

// REGRESSION GUARD, do not weaken to a snapshot.
//
// The guard above pins the CONTENT pass; this pins the SHADOW pass, which picks
// its route through `shadow_takes_image_filter`. That predicate must consult
// `filter_takes_layer` too, or a colour-only `ctx.filter` sends the shadow onto
// the same `NoPixelsDevice` and the shadow element vanishes while the content
// element survives.
for (const filter of COLOUR_ONLY_FILTERS) {
  test(`a colour-only ctx.filter must not swallow the shadow (${filter})`, (t) => {
    const { canvas } = t.context
    const ctx = canvas.getContext('2d')
    ctx.filter = filter
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
    ctx.shadowOffsetX = 40
    ctx.fillStyle = 'blue'
    ctx.fillRect(40, 40, 80, 60)
    ctx.strokeStyle = 'red'
    ctx.lineWidth = 6
    ctx.strokeRect(200, 40, 80, 60)
    ctx.beginPath()
    ctx.moveTo(400, 40)
    ctx.lineTo(500, 40)
    ctx.lineTo(450, 140)
    ctx.closePath()
    ctx.fill()

    const svg = canvas.getContent().toString('utf8')
    // A shadow element AND a content element for each of the three draws.
    t.is((svg.match(/<rect/g) ?? []).length, 4, `fillRect and strokeRect each need a shadow: ${svg}`)
    t.is((svg.match(/<path/g) ?? []).length, 2, `fill(path) needs a shadow: ${svg}`)
    // The offset is the canvas translate, which is what `canvas_shadow_offset`
    // still owes on the layer-free route -- exactly three of them, one per
    // shadow, never zero and never doubled.
    t.is(
      (svg.match(/transform="translate\(40 0\)"/g) ?? []).length,
      3,
      `each shadow is the offset draw and nothing else is: ${svg}`,
    )
  })
}

test('a colour-only ctx.filter must not swallow a text shadow', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts-dir', 'iosevka-curly-regular.woff2'), 'i-curly')
  const { canvas } = t.context
  const ctx = canvas.getContext('2d')
  ctx.filter = 'grayscale(1)'
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
  ctx.shadowOffsetX = 40
  ctx.fillStyle = 'blue'
  ctx.font = '50px i-curly'
  ctx.fillText('napi-rs', 50, 300)

  const svg = canvas.getContent().toString('utf8')
  t.is((svg.match(/transform="translate\(40 0\)"/g) ?? []).length, 1, `the text shadow must survive: ${svg}`)
})

// Only the ALPHA a colour filter leaves on the source can reach a shadow, since
// kSrcIn throws the filtered RGB away. `shadow_paint` folds that one number in,
// in Blink's `colourise(ctx.filter(source))` order; putting `ctx.filter` back on
// the shadow paint would invert the order and tint the shadow instead. With
// `shadowColor` alpha 0.8: grayscale(1) leaves 0.8, opacity(0.5) leaves 0.4.
for (const [filter, opacity] of [
  ['grayscale(1)', '0.80000001'],
  ['sepia(1)', '0.80000001'],
  ['invert(1)', '0.80000001'],
  ['opacity(0.5)', '0.40000001'],
] as const) {
  test(`a colour-only ctx.filter reaches the shadow through its alpha only (${filter})`, (t) => {
    const { canvas } = t.context
    const ctx = canvas.getContext('2d')
    ctx.filter = filter
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
    ctx.shadowOffsetX = 40
    ctx.fillStyle = 'blue'
    ctx.fillRect(40, 40, 80, 60)

    const svg = canvas.getContent().toString('utf8')
    t.true(
      svg.includes(`<rect fill-opacity="${opacity}" transform="translate(40 0)"`),
      `the shadow keeps shadowColor and takes only the filter's alpha: ${svg}`,
    )
  })
}

// "Colour-only" is Skia's answer, not a list of filter names, and a CHAIN can
// be colour-only too: `SkImageFilters::ColorFilter` collapses adjacent
// colour-filter nodes into one, so `asAColorFilter`'s `getInput(0) == nullptr`
// still holds. Do not re-scope the fix to single filters.
test('a colour-only ctx.filter CHAIN also keeps its shadow', (t) => {
  const { canvas } = t.context
  const ctx = canvas.getContext('2d')
  ctx.filter = 'opacity(0.5) grayscale(1)'
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
  ctx.shadowOffsetX = 40
  ctx.fillStyle = 'blue'
  ctx.fillRect(40, 40, 80, 60)

  const svg = canvas.getContent().toString('utf8')
  t.true(
    svg.includes('<rect fill-opacity="0.40000001" transform="translate(40 0)"'),
    `the collapsed chain still folds its alpha into the shadow: ${svg}`,
  )
})

// The other direction. A spatial filter keeps the layer, and on SVG that costs
// the whole draw. These are not owed a rescue and must not quietly acquire one.
// A chain is judged by the same rule: one spatial member is enough.
for (const filter of ['blur(3px)', 'drop-shadow(5px 5px 3px black)', 'blur(2px) grayscale(1)']) {
  test(`a spatial ctx.filter keeps its device-space layer (${filter})`, (t) => {
    const { canvas } = t.context
    const ctx = canvas.getContext('2d')
    ctx.filter = filter
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
    ctx.shadowOffsetX = 40
    ctx.fillStyle = 'blue'
    ctx.fillRect(40, 40, 80, 60)

    const svg = canvas.getContent().toString('utf8')
    t.is((svg.match(/<rect/g) ?? []).length, 0, `a spatial filter is unrepresentable here: ${svg}`)
  })
}
