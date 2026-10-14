import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import ava, { TestFn } from 'ava'

import { createCanvas, DOMMatrix, SvgCanvas, SvgExportFlag, GlobalFonts, SKRSContext2D } from '../index'

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

// Spec getContext: a later call returns the same context and does not apply
// its attributes again, so a late { alpha: false } paints no base.
test('SvgCanvas ignores attributes on a later getContext call', (t) => {
  const draw = (late: boolean) => {
    const canvas = createCanvas(10, 10, SvgExportFlag.NoPrettyXML)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, 10, 10)
    if (late) {
      t.is(canvas.getContext('2d', { alpha: false }), ctx)
      t.true(ctx.getContextAttributes().alpha)
    }
    return canvas.getContent().toString('utf8')
  }
  t.is(draw(true), draw(false))
})

// Spec "set bitmap dimensions" resets the context to its default state, but
// alpha and colorSpace are creation settings: they stay, and an alpha:false
// canvas gets its base again. A later getContext cannot restore them.
test('SvgCanvas keeps alpha:false and colorSpace when width or height changes', (t) => {
  const fresh = (width: number, height: number) => {
    const canvas = createCanvas(width, height, SvgExportFlag.NoPrettyXML)
    canvas.getContext('2d', { alpha: false })
    return canvas.getContent().toString('utf8')
  }
  for (const dimension of ['width', 'height'] as const) {
    const canvas = createCanvas(10, 10, SvgExportFlag.NoPrettyXML)
    const ctx = canvas.getContext('2d', { alpha: false, colorSpace: 'display-p3' })
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, 10, 10)
    canvas[dimension] = 20
    t.is(ctx.getContextAttributes().alpha, false, dimension)
    t.is(ctx.getContextAttributes().colorSpace, 'display-p3', dimension)
    t.is(canvas.getContent().toString('utf8'), fresh(canvas.width, canvas.height), dimension)
  }
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

// An SvgCanvas is a canvas image source: drawImage, createPattern and its own
// getImageData read what was drawn into it, as they read a canvas (HTML spec: a
// canvas source uses its current bitmap). They used to read a raster surface
// that nothing drew into, and returned transparent black.
const RED = [255, 0, 0, 255]
const BLUE = [0, 0, 255, 255]
const CLEAR = [0, 0, 0, 0]

const redBlueSvg = () => {
  const svg = createCanvas(4, 4, SvgExportFlag.NoPrettyXML)
  const ctx = svg.getContext('2d')
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 2, 4)
  ctx.fillStyle = '#0000ff'
  ctx.fillRect(2, 0, 2, 4)
  return svg
}

test('SvgCanvas content reaches drawImage, createPattern and getImageData', (t) => {
  const svg = redBlueSvg()
  const drawn = createCanvas(8, 4).getContext('2d')
  drawn.drawImage(svg, 0, 0)
  t.deepEqual([...drawn.getImageData(0, 0, 8, 1).data], [RED, RED, BLUE, BLUE, CLEAR, CLEAR, CLEAR, CLEAR].flat())
  const patterned = createCanvas(8, 4).getContext('2d')
  patterned.fillStyle = patterned.createPattern(svg, 'repeat')
  patterned.fillRect(0, 0, 8, 4)
  t.deepEqual([...patterned.getImageData(0, 0, 8, 1).data], [RED, RED, BLUE, BLUE, RED, RED, BLUE, BLUE].flat())
  t.deepEqual([...svg.getContext('2d').getImageData(0, 0, 4, 1).data], [RED, RED, BLUE, BLUE].flat())
})

test('reading an SvgCanvas leaves its SVG output unchanged', (t) => {
  const read = redBlueSvg()
  read.getContext('2d').getImageData(0, 0, 4, 4)
  createCanvas(4, 4).getContext('2d').drawImage(read, 0, 0)
  read.getContext('2d').createPattern(read, 'repeat')
  t.is(read.getContent().toString('utf8'), redBlueSvg().getContent().toString('utf8'))
})

// The pixels are drawn from a recording when they are read, and the recording
// starts again in the current save, clip and transform state. Reads in the
// middle of nested save()/clip()/transform state must not change what the
// later drawing gives.
const nestedDrawing = (ctx: SKRSContext2D, read: () => void) => {
  ctx.fillStyle = '#ffee00'
  ctx.fillRect(0, 0, 64, 64)
  for (let i = 0; i < 4; i++) {
    ctx.save()
    ctx.translate(3, 2)
    ctx.rotate(0.1)
    ctx.beginPath()
    ctx.rect(0, 0, 50 - i * 8, 44 - i * 8)
    ctx.clip()
    ctx.fillStyle = `hsl(${i * 80}, 80%, 50%)`
    ctx.fillRect(-10, -10, 80, 80)
    read()
  }
  for (let i = 0; i < 4; i++) {
    ctx.restore()
    ctx.strokeStyle = `rgba(0, 0, 0, ${0.3 + i * 0.1})`
    ctx.lineWidth = 3
    ctx.strokeRect(4 + i * 6, 4 + i * 6, 30, 30)
    read()
  }
}

test('SvgCanvas pixels follow save, clip and transform across reads', (t) => {
  const pixels = (read: boolean) => {
    const svg = createCanvas(64, 64, SvgExportFlag.NoPrettyXML)
    const ctx = svg.getContext('2d')
    nestedDrawing(ctx, () => read && ctx.getImageData(0, 0, 1, 1))
    return ctx.getImageData(0, 0, 64, 64).data
  }
  const read = pixels(true)
  const unread = pixels(false)
  t.true(
    read.every((value, i) => value === unread[i]),
    'reads in the middle change the pixels',
  )
  // The yellow background and the hsl(240) fill.
  t.deepEqual(Array.from(read.subarray(0, 4)), [255, 238, 0, 255])
  t.true(
    read.some((value, i) => i % 4 === 2 && value > 200 && read[i - 2] < 100),
    'the hsl(240) fill is there',
  )
})

// The recording is drawn into the pixels once it pins 32 MiB, as a canvas
// recording is (issue #1342), so an SvgCanvas that is never read cannot pin
// every image drawn into it. Each 2048x2048 snapshot below is 16 MiB.
test('SvgCanvas recording is bounded and keeps its state when it is drawn', async (t) => {
  const { status, signal, stdout, stderr } = await new Promise<{
    status: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--expose-gc',
        '-e',
        `
const { createCanvas, SvgExportFlag } = require('./index.js')
const source = createCanvas(2048, 2048)
const sourceContext = source.getContext('2d')
const draw = (ctx, i) => {
  sourceContext.fillStyle = 'rgb(' + i * 20 + ', 0, 255)'
  sourceContext.fillRect(0, 0, 2048, 2048)
  ctx.drawImage(source, 0, 0, 2048, 2048, i * 6, i * 3, 8, 8)
}
const svg = createCanvas(96, 64, SvgExportFlag.NoPrettyXML)
const ctx = svg.getContext('2d')
const expected = createCanvas(96, 64).getContext('2d')
for (const c of [ctx, expected]) {
  c.save()
  c.translate(3, 1)
  c.beginPath()
  c.rect(0, 0, 60, 40)
  c.clip()
}
global.gc()
const before = process.memoryUsage().rss
for (let i = 0; i < 12; i++) draw(ctx, i)
global.gc()
const growth = (process.memoryUsage().rss - before) / 1048576
for (let i = 0; i < 12; i++) draw(expected, i)
for (const c of [ctx, expected]) {
  c.restore()
  c.fillStyle = '#00ff00'
  c.fillRect(60, 50, 30, 10)
}
const a = ctx.getImageData(0, 0, 96, 64).data
const b = expected.getImageData(0, 0, 96, 64).data
console.log(JSON.stringify({ growth, equal: a.every((v, i) => v === b[i]), clipped: b[(33 * 96 + 60) * 4 + 3] === 255 && b[(35 * 96 + 65) * 4 + 3] === 0 }))
`,
      ],
      { cwd: join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }))
  })
  t.is(status, 0, `expected exit 0, got status=${status} signal=${signal}\n${stderr}${stdout}`)
  const { growth, equal, clipped } = JSON.parse(stdout.trim().split('\n').pop()!)
  t.true(clipped, 'the clip cuts the later images')
  t.true(equal, 'the SvgCanvas pixels equal a canvas running the same drawing')
  // Unbounded, the 12 snapshots pin 192 MiB.
  t.true(growth < 96, `12 drawImage calls grew rss by ${growth.toFixed(1)} MB, expected < 96 MB`)
})

// SkSVGDevice drops the matrix of an image shader, so a pattern used to be
// written as if setTransform() was never called. The patterned element is now
// drawn under CTM x pattern matrix, with its geometry mapped back into the
// pattern's space (SVG resolves a userSpaceOnUse pattern in the user space of
// the element that uses it). Rendered in Chrome 155, the SVG of the scene below
// moves from a mean max-channel difference of 63.9 to 7.5 against Chrome's own
// canvas drawing of it; what is left is image smoothing and edge AA.
const twoColorTile = () => {
  const tile = createCanvas(4, 4)
  const ctx = tile.getContext('2d')
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 2, 4)
  ctx.fillStyle = '#0000ff'
  ctx.fillRect(2, 0, 2, 4)
  return tile
}

const patternedSvg = (matrix: DOMMatrix | null, repetition = 'repeat', draw?: (ctx: SKRSContext2D) => void) => {
  const svg = createCanvas(200, 100, SvgExportFlag.NoPrettyXML)
  const ctx = svg.getContext('2d')
  const pattern = ctx.createPattern(twoColorTile(), repetition as 'repeat')
  if (matrix) {
    pattern.setTransform(matrix)
  }
  ctx.fillStyle = pattern
  ctx.strokeStyle = pattern
  if (draw) {
    draw(ctx)
  } else {
    ctx.fillRect(10, 10, 80, 60)
    ctx.beginPath()
    ctx.arc(150, 50, 40, 0, Math.PI * 2)
    ctx.fill()
  }
  return { svg, ctx, content: svg.getContent().toString('utf8') }
}

const patternedElements = (content: string) => content.match(/<[a-z]+ fill="url\(#pattern_\d+\)"[^>]*>/g) ?? []

const pathPoints = (element: string) =>
  [...element.matchAll(/(-?[\d.]+(?:e-?\d+)?) (-?[\d.]+(?:e-?\d+)?)/g)].map(([, x, y]) => [Number(x), Number(y)])

test('SVG output draws a pattern through its matrix', (t) => {
  const matrix = new DOMMatrix().translate(7, 5).rotate(20).scale(3, 2)
  const elements = patternedElements(patternedSvg(matrix).content)
  t.is(elements.length, 2, elements.join('\n'))
  for (const element of elements) {
    t.true(element.startsWith('<path '), element)
    t.true(element.includes('transform="matrix(2.81908 1.02606 -0.68404 1.87939 7 5)"'), element)
  }
  // The rect's corners, mapped back into the canvas space by the matrix.
  const d = elements[0].slice(elements[0].indexOf(' d="'))
  const corners = pathPoints(d).map(([x, y]) => matrix.transformPoint({ x, y }))
  for (const [i, [x, y]] of [
    [10, 10],
    [90, 10],
    [90, 70],
    [10, 70],
  ].entries()) {
    t.true(Math.abs(corners[i].x - x) < 1e-3 && Math.abs(corners[i].y - y) < 1e-3, `${d}: corner ${i}`)
  }
})

test('SVG output multiplies the pattern matrix with the transform and strokes before it', (t) => {
  const { content } = patternedSvg(new DOMMatrix().scale(2, 2), 'repeat', (ctx) => {
    ctx.scale(2, 1)
    ctx.lineWidth = 4
    ctx.strokeRect(10, 10, 30, 30)
  })
  const elements = patternedElements(content)
  t.is(elements.length, 1, content)
  // The stroke outline in the pattern space: [8, 42] and [12, 38] halved.
  t.true(
    elements[0].includes('transform="scale(4 2)" d="M4 4L21 4L21 21L4 21L4 4ZM6 6L6 19L19 19L19 6L6 6Z"'),
    elements[0],
  )
})

test('SVG output draws pattern-filled text as outlines in the pattern space', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts-dir', 'iosevka-curly-regular.woff2'), 'i-curly')
  const { content } = patternedSvg(new DOMMatrix().scale(2, 2), 'repeat', (ctx) => {
    ctx.font = '20px i-curly'
    ctx.fillText('Hi', 50, 40)
  })
  const elements = patternedElements(content)
  t.is(elements.length, 1, content)
  t.true(elements[0].startsWith('<path fill="url(#pattern_0)" transform="scale(2 2)" d="M'), elements[0])
  t.false(content.includes('<text'), content)
})

// HTML spec: a pattern whose matrix cannot be inverted paints transparent
// black, as Chrome 155's canvas does.
test('SVG output paints nothing for a pattern with a singular matrix', (t) => {
  const { ctx, content } = patternedSvg(new DOMMatrix([0, 0, 0, 0, 0, 0]))
  t.deepEqual(patternedElements(content), [], content)
  t.false(content.includes('<pattern'), content)
  t.deepEqual([...new Set(ctx.getImageData(0, 0, 200, 100).data)], [0])
})

// SkSVGDevice writes a "100%" tile for a no-repeat axis; under the pattern
// matrix the element is clipped to the image instead, and a shape that misses
// the image writes nothing.
test('SVG output clips a no-repeat pattern with a matrix to its image', (t) => {
  const { content } = patternedSvg(new DOMMatrix().translate(7, 5).rotate(20).scale(3, 2), 'no-repeat')
  const elements = patternedElements(content)
  t.is(elements.length, 1, content)
  t.regex(
    content,
    /<clipPath id="cl_[0-9a-f]+"><path d="M11\.256\d* 6\.549\d*L18\.276\d* 9\.104\d*L15\.540\d* 16\.621\d*L8\.519\d* 14\.066\d*L11\.256\d* 6\.549\d*Z"\/><\/clipPath>/,
  )
})

// A pattern with no matrix keeps the output SkSVGDevice writes for it.
test('SVG output of a pattern without a matrix is unchanged', (t) => {
  for (const matrix of [null, new DOMMatrix()]) {
    const { content } = patternedSvg(matrix)
    t.false(content.includes('transform='), content)
    t.true(content.includes('<svg fill="url(#pattern_0)" x="10" y="10" width="80" height="60">'), content)
    t.true(content.includes('<path fill="url(#pattern_2)" d="M190 50'), content)
  }
})
