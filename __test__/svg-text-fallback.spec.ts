// SVG text takes a character its first font lacks from the next font of the
// font-family list, then from the system's fonts, as Chrome 157 does
// (FontFallbackIterator per grapheme cluster): SVG images, the SVG images
// nested in them, an SVG image drawn on an SVG canvas, and
// convertSVGTextToPath. fixtures/svg-text-fallback.json holds Chrome's rows.
//
// Every probe runs in a child process with only __test__/fonts registered:
// Lato-Regular as MyLatoOnly (no CJK) and Source Han Serif CN Bold as SHSReg.
// Rows that need system fonts are pinned on macOS 27 (the capture's
// Darwin major).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface ChromeRow {
  id: string
  family: string
  text: string
  length: number
  x: number[]
  platformFonts: [string, number][]
  ink: number[]
  imageInk?: number[]
  darwin?: number
}

const CHROME: Record<string, ChromeRow> = Object.fromEntries(
  (JSON.parse(readFileSync(join(__dirname, 'fixtures', 'svg-text-fallback.json'), 'utf8')).rows as ChromeRow[]).map(
    (row) => [row.id, row],
  ),
)

const DARWIN = process.platform === 'darwin' ? Number.parseInt(release(), 10) : 0

interface Glyph {
  x: number
  y: number
  d: string
}

type Box = [number, number, number, number] | null

interface Probe {
  paths: Record<string, Glyph[]>
  ink: Record<string, Box>
  // Pixels at x >= 25 of the list row "A中" and of SHSReg "中" at 23.76.
  right: { list: string; shs: string }
  nested: { top: string; nested: string; right: string }
  svgCanvas: { png: string; pngRight: string; raster: string; fillText: string }
  canvas: Record<string, number>
  color: Record<string, number>
}

// convertSVGTextToPath, the SVG image raster and canvas text of one
// renderer, in a child process.
const PROBE = `
const { createHash } = require('crypto')
const path = require('path')
const { createCanvas, GlobalFonts, setTextRenderer, convertSVGTextToPath, Image, SvgExportFlag } = require('./index.js')
setTextRenderer(process.env.RENDERER)
const F = path.join('__test__', 'fonts')
GlobalFonts.registerFromPath(path.join(F, 'Lato-Regular.ttf'), 'MyLatoOnly')
GlobalFonts.registerFromPath(path.join(F, 'SourceHanSerifCN-Bold.ttf'), 'SHSReg')
const sha1 = (data) => createHash('sha1').update(data).digest('hex')
const textOf = (family, text, x = 2) =>
  '<text x="' + x + '" y="40" font-family="' + family + '" font-size="32" font-weight="700">' + text + '</text>'
const svgOf = (body, height = 60) =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="' + height + '">' + body + '</svg>'
const glyphs = (svg) =>
  [...convertSVGTextToPath(svg).toString().matchAll(/<path transform="translate\\(([^ )]+) ([^)]+)\\)" d="([^"]*)"/g)].map(
    (m) => ({ x: Number(m[1]), y: Number(m[2]), d: m[3] }),
  )
const image = (svg) => {
  const img = new Image()
  img.src = Buffer.from(svg)
  return img
}
const raster = (svg, height = 60) => {
  const ctx = createCanvas(200, height).getContext('2d')
  ctx.drawImage(image(svg), 0, 0)
  return ctx.getImageData(0, 0, 200, height).data
}
const inkOf = (data, y0 = 0, y1 = 60) => {
  let a = 1e9, b = 1e9, c = -1, d = -1
  for (let y = y0; y < y1; y++)
    for (let x = 0; x < 200; x++)
      if (data[(y * 200 + x) * 4 + 3]) { a = Math.min(a, x); b = Math.min(b, y - y0); c = Math.max(c, x); d = Math.max(d, y - y0) }
  return c < 0 ? null : [a, b, c + 1, d + 1]
}
// The pixels of columns x >= from.
const columns = (data, from, y0 = 0, y1 = 60) => {
  const rows = []
  for (let y = y0; y < y1; y++) rows.push(Buffer.from(data.slice((y * 200 + from) * 4, (y + 1) * 200 * 4)).toString('hex'))
  return sha1(rows.join('/'))
}
// Pixels that are not gray: a color glyph.
const colored = (data) => {
  let n = 0
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] && (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2])) n++
  return n
}
const LIST = 'MyLatoOnly, SHSReg'
const rows = {
  'list.A中': [LIST, 'A中'],
  'list.中': [LIST, '中'],
  'list.中中': [LIST, '中中'],
  'list.中A': [LIST, '中A'],
  'list.é中': [LIST, 'é中'],
  'list.e\\u0301中': [LIST, 'e\\u0301中'],
  'list.中\\u0301': [LIST, '中\\u0301'],
  'lato.A中': ['MyLatoOnly', 'A中'],
  'lato.中A': ['MyLatoOnly', '中A'],
  'lato.A😀': ['MyLatoOnly', 'A😀'],
  'arial.中': ['Arial', '中'],
  'nosuch.中': ['NoSuchFamily, SHSReg', '中'],
  'shs.中': ['SHSReg', '中'],
  'lato.A': ['MyLatoOnly', 'A'],
  'pingfang.中\\u0301': ['PingFang SC', '中\\u0301'],
  // One fragment's font request does not leak into the next fragment.
  tspan: ['SHSReg', '中<tspan font-family="MyLatoOnly">中A</tspan>'],
}
const out = { paths: {}, ink: {}, canvas: {}, color: {} }
for (const [id, [family, text]] of Object.entries(rows)) {
  const svg = svgOf(textOf(family, text))
  out.paths[id] = glyphs(svg)
  out.ink[id] = inkOf(raster(svg))
}
out.color['lato.A😀'] = colored(raster(svgOf(textOf('MyLatoOnly', 'A😀'))))
const list = raster(svgOf(textOf(LIST, 'A中')))
out.right = { list: columns(list, 25), shs: columns(raster(svgOf(textOf('SHSReg', '中', 23.76))), 25) }
// The list row inside an <image> of an SVG image.
const inner = svgOf(textOf(LIST, 'A中'))
const outer = raster(
  svgOf(textOf(LIST, 'A中') + '<image y="60" width="200" height="60" href="data:image/svg+xml,' + encodeURIComponent(inner) + '"/>', 120),
  120,
)
out.nested = { top: columns(outer, 0, 0, 60), nested: columns(outer, 0, 60, 120), right: columns(outer, 25, 60, 120) }
// The SVG image drawn on an SVG canvas is a PNG of its raster.
const svgCanvas = createCanvas(200, 60, SvgExportFlag.NoPrettyXML)
svgCanvas.getContext('2d').drawImage(image(inner), 0, 0)
const png = /xlink:href="data:image\\/png;base64,([^"]+)"/.exec(svgCanvas.getContent().toString())
const decoded = image(Buffer.from(png[1], 'base64'))
const pngCtx = createCanvas(200, 60).getContext('2d')
pngCtx.drawImage(decoded, 0, 0)
const fillCanvas = createCanvas(200, 60, SvgExportFlag.NoPrettyXML)
const fill = fillCanvas.getContext('2d')
fill.font = 'bold 32px MyLatoOnly, SHSReg'
fill.fillText('A中', 2, 40)
out.svgCanvas = {
  png: columns(pngCtx.getImageData(0, 0, 200, 60).data, 0),
  pngRight: columns(pngCtx.getImageData(0, 0, 200, 60).data, 25),
  raster: columns(list, 0),
  fillText: fillCanvas.getContent().toString(),
}
const ctx = createCanvas(10, 10).getContext('2d')
ctx.font = 'bold 32px MyLatoOnly'
out.canvas.lato中 = ctx.measureText('中').width
console.log(JSON.stringify(out))
`

function probe(renderer: string): Probe {
  const { stdout, stderr, status } = spawnSync(process.execPath, ['-e', PROBE], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, RENDERER: renderer },
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (status !== 0) throw new Error(stderr)
  return JSON.parse(stdout)
}

// Chrome lays SVG text out in LayoutUnits (1/64 px); SkSVG in floats.
const near = (a: number, b: number) => Math.abs(a - b) <= 1 / 64 + 1e-6

const probes = new Map<string, Probe>()
const probeOf = (renderer: string) => {
  if (!probes.has(renderer)) probes.set(renderer, probe(renderer))
  return probes.get(renderer)!
}

for (const renderer of ['portable', 'system'] as const) {
  test(`convertSVGTextToPath takes a character the first family lacks from the next one (${renderer})`, (t) => {
    const { paths } = probeOf(renderer)
    const [a, han] = paths['list.A中']
    t.is(paths['list.A中'].length, 2)
    t.is(a.d, paths['lato.A'][0].d, 'A is Lato')
    t.is(han.d, paths['shs.中'][0].d, '中 is Source Han Serif')
    t.true(near(han.x, CHROME['list.A中'].x[1]), `中 at ${han.x}`)
    // Chrome: the text length is the advances' sum.
    t.true(near(han.x - 2 + 32, CHROME['list.A中'].length))
    // A family that matches nothing is skipped (FontFallbackList).
    t.deepEqual(paths['nosuch.中'], paths['shs.中'])
    t.deepEqual(paths['list.中'], paths['shs.中'])
    t.is(paths['list.中中'][1].d, paths['shs.中'][0].d)
    t.true(near(paths['list.中中'][1].x, CHROME['list.中中'].x[1]))
  })

  test(`a later character keeps its own font: "中A" (${renderer})`, (t) => {
    const { paths } = probeOf(renderer)
    const [han, a] = paths['list.中A']
    t.is(han.d, paths['shs.中'][0].d)
    t.is(a.d, paths['lato.A'][0].d)
    t.true(near(a.x, CHROME['list.中A'].x[1]), `A at ${a.x}`)
  })

  test(`a grapheme cluster takes one font (${renderer})`, (t) => {
    const { paths } = probeOf(renderer)
    // é from Lato, 中 from Source Han Serif after it.
    const [e, han] = paths['list.é中']
    t.not(e.d, han.d)
    t.is(han.d, paths['shs.中'][0].d)
    t.true(near(han.x, CHROME['list.é中'].x[1]), `中 at ${han.x}`)
    // e + U+0301 stays with Lato, which has both (SkSVG does not compose
    // them as HarfBuzz does, so the advance is Lato's e).
    const decomposed = paths['list.é中']
    t.is(decomposed.length, 3)
    t.is(decomposed[2].d, paths['shs.中'][0].d)
  })

  test(`an SVG image draws the fallback glyph where Chrome does (${renderer})`, (t) => {
    const { right, ink } = probeOf(renderer)
    // Right of A, the list row is Source Han Serif's 中 at 23.76.
    t.is(right.list, right.shs)
    const chrome = CHROME['list.A中'].ink
    const box = ink['list.A中']!
    // Chrome bolds Lato's A (synthetic bold): its left edge is not compared.
    t.deepEqual(box.slice(1), chrome.slice(1), `ink ${JSON.stringify(box)}`)
  })

  test(`each text fragment falls back from its own font list (${renderer})`, (t) => {
    const { paths, canvas } = probeOf(renderer)
    const [first, han, a] = paths.tspan
    t.is(first.d, paths['shs.中'][0].d)
    // The tspan's 中 is MyLatoOnly's fallback, as on its own and as canvas
    // text advances it, not the fragment before's Source Han Serif.
    t.is(han.d, paths['lato.中A'][0].d)
    t.true(Math.abs(a.x - han.x - canvas.lato中) < 1e-3, `${a.x - han.x} vs canvas ${canvas.lato中}`)
  })

  test(`a nested SVG image and an SVG canvas draw the same fallback (${renderer})`, (t) => {
    const { nested, svgCanvas, right } = probeOf(renderer)
    t.is(nested.nested, nested.top)
    t.is(nested.right, right.shs, 'the nested 中 is Source Han Serif')
    t.is(svgCanvas.png, svgCanvas.raster)
    t.is(svgCanvas.pngRight, right.shs, 'the PNG 中 is Source Han Serif')
    // Canvas text on an SVG canvas names the fallback font.
    t.true(svgCanvas.fillText.includes('Source Han Serif CN'), svgCanvas.fillText)
  })
}

// With no family that has 中, the system's fonts give it: here a font
// loadFontsFromDir loaded (the shared stage canvas text asks). SVG text then
// draws what canvas text draws.
const DIR_PROBE = `
const fs = require('fs'), os = require('os'), path = require('path')
const { createCanvas, GlobalFonts, setTextRenderer, convertSVGTextToPath } = require('./index.js')
setTextRenderer(process.env.RENDERER)
const F = path.join('__test__', 'fonts')
GlobalFonts.registerFromPath(path.join(F, 'Lato-Regular.ttf'), 'MyLatoOnly')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-text-fallback-'))
fs.copyFileSync(path.join(F, 'SourceHanSerifCN-Bold.ttf'), path.join(dir, 'SourceHanSerifCN-Bold.ttf'))
GlobalFonts.loadFontsFromDir(dir)
const glyphs = (family, text) =>
  [...convertSVGTextToPath('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="2" y="40" font-size="32" font-weight="700" font-family="' + family + '">' + text + '</text></svg>').toString().matchAll(/translate\\(([^ )]+) [^)]+\\)" d="([^"]*)"/g)].map((m) => ({ x: Number(m[1]), d: m[2] }))
const ctx = createCanvas(10, 10).getContext('2d')
ctx.font = 'bold 32px MyLatoOnly'
const out = {
  lato: glyphs('MyLatoOnly', '中A'),
  shs: glyphs('Source Han Serif CN', '中'),
  notdef: glyphs('MyLatoOnly', '\\uE000'),
  canvas: ctx.measureText('中').width,
}
fs.rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify(out))
`

for (const renderer of ['portable', 'system'] as const) {
  test(`SVG text takes a character no family has from the installed fonts, as canvas text (${renderer})`, (t) => {
    const { stdout, stderr, status } = spawnSync(process.execPath, ['-e', DIR_PROBE], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, RENDERER: renderer, DISABLE_SYSTEM_FONTS_LOAD: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    })
    t.is(status, 0, stderr)
    const out = JSON.parse(stdout)
    const [han, a] = out.lato
    t.not(han.d, out.notdef[0].d, 'not .notdef')
    t.true(Math.abs(a.x - 2 - out.canvas) < 1e-3, `advance ${a.x - 2} vs canvas ${out.canvas}`)
    // A host with no other font that has 中 (Linux CI) takes it from the
    // loaded Source Han Serif.
    if (out.canvas === 32 && process.platform === 'linux') t.is(han.d, out.shs[0].d)
  })
}

// macOS 27, the system renderer: CoreText's font, as canvas text and Chrome
// 157 (PingFang SC, Apple Color Emoji). The left edge of A is not compared
// (Chrome bolds Lato's A).
const darwinSystem = DARWIN === 27 ? test : test.skip
darwinSystem('SVG text takes CoreText fallback fonts as Chrome 157 does (macOS 27, system)', (t) => {
  const { paths, ink, color } = probeOf('system')
  for (const id of ['lato.A中', 'lato.A😀']) {
    t.true(near(paths[id][1].x, CHROME[id].x[1]), `${id}: x ${paths[id][1].x}`)
    t.deepEqual(ink[id]!.slice(1), CHROME[id].ink.slice(1), `${id}: ink ${JSON.stringify(ink[id])}`)
  }
  t.true(color['lato.A😀'] > 100, `${color['lato.A😀']} color pixels`)
  // Arial lacks 中: Chrome's <img> draws PingFang SC.
  t.deepEqual(ink['arial.中'], CHROME['arial.中'].imageInk)
  // 中 + U+0301: Source Han Serif lacks the mark, so the cluster takes
  // PingFang SC, which has both (Chrome: PingFangSC-Semibold, 2 glyphs).
  t.deepEqual(
    paths['list.中́'].map((g) => g.d),
    paths['pingfang.中́'].map((g) => g.d),
  )
})
