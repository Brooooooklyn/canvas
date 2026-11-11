// SVG text draws synthetic bold and italic where the family lacks the face,
// with the rules canvas text uses (Blink's CSSSegmentedFontFace::GetFontData
// for a registered font, the installed font's traits), as Chrome 157 does:
// SVG images, the SVG images nested in them, an SVG image drawn on an SVG
// canvas, and convertSVGTextToPath. The advances do not change.
// fixtures/svg-synthetic-style.json holds Chrome's rows.
//
// Every probe runs in a child process with only __test__/fonts registered:
// Lato-Regular as SynthLato (regular only), Source Han Serif CN Bold as
// SynthShsBold (bold only) and Roboto Mono's variable font (wght 100-700,
// upright only) as SynthRMono. Rows with Chrome's pixels are pinned on
// macOS 27 (the capture's Darwin major) with the system renderer.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface ChromeRow {
  id: string
  file: string | null
  style: string
  weight: number
  form: 'inline' | 'img'
  length: number
  bbox: number[]
  ink: number[]
  mass: number
  png: string
}

const CHROME: ChromeRow[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'svg-synthetic-style.json'), 'utf8'),
).rows

const DARWIN = process.platform === 'darwin' ? Number.parseInt(release(), 10) : 0

type Box = [number, number, number, number]

interface Stats {
  ink: Box | null
  mass: number
  sha: string
}

interface Probe {
  // Pixels that differ between the SVG image of "Hagf" at fixed x and
  // canvas fillText of each glyph at the same x.
  oracle: Record<string, number>
  // The "Hamburg" SVG image of each style.
  hamburg: Record<string, Stats>
  // Tight bounds of the "H" outline: convertSVGTextToPath, and the SVG
  // canvas path export of canvas fillText.
  paths: Record<string, { svg: Box; canvas: Box }>
  // convertSVGTextToPath of a stroked "H" (64px; b300: 300px bold; brot:
  // 200px bold, rotated glyph under a non-uniform scale): the
  // path data and stroke widths it writes, and the raster of the output and
  // of the source.
  stroke: Record<string, { d: string[]; width: number[]; raster: string; source: string }>
  // The bold row: nested in an <image>, and the PNG an SVG canvas embeds.
  nested: { top: string; nested: string }
  svgCanvas: { bold: string; regular: string; raster: string }
  // font-synthesis on a bold italic "Hamburg" (and "H中" in SynthLato,
  // SynthShsBold), and weights 550 and 599: the raster's sha, and the "H"
  // outline's bounds.
  synthesis: Record<string, string>
  // A filled "Hm" in SynthLato at 9, 12, 24 and 36px, regular and bold:
  // the bounds of convertSVGTextToPath's paths as written, and the ink of
  // the source and of the export under scale(25, 18, 9, 6).
  smallFill: Record<string, Record<string, { bounds: Box; source: number; path: number }>>
  synthesisPath: Box
  w550Path: Box
  // Chrome rows: gray (255 - min(r, g, b)) differences against Chrome's PNG.
  chrome: Record<string, { pixels: number; max: number; ink: Box | null; mass: number }>
}

const PROBE = `
const { createHash } = require('crypto')
const path = require('path')
const { createCanvas, GlobalFonts, setTextRenderer, convertSVGTextToPath, Image, Path2D, SvgExportFlag } = require('./index.js')
setTextRenderer(process.env.RENDERER)
const F = path.join('__test__', 'fonts')
GlobalFonts.registerFromPath(path.join(F, 'Lato-Regular.ttf'), 'SynthLato')
GlobalFonts.registerFromPath(path.join(F, 'SourceHanSerifCN-Bold.ttf'), 'SynthShsBold')
GlobalFonts.registerFromPath(path.join(F, 'RobotoMono-VariableFont_wght.ttf'), 'SynthRMono')
const CHROME = JSON.parse(process.env.CHROME_ROWS)
const sha1 = (data) => createHash('sha1').update(data).digest('hex')
const STYLES = {
  n: ['normal', 400], w500: ['normal', 500], w600: ['normal', 600], b: ['normal', 700],
  i: ['italic', 400], o: ['oblique', 400], bi: ['italic', 700],
}
const FAMILY = { lato: 'SynthLato', shsb: 'SynthShsBold', rmono: 'SynthRMono', chalk: 'Chalkduster' }
const svgOf = (family, s, text = 'Hamburg', x = 2, w = 260) =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="60"><text x="' + x + '" y="40" font-family="' +
  family + '" font-size="32" font-weight="' + STYLES[s][1] + '" font-style="' + STYLES[s][0] + '">' + text + '</text></svg>'
const cssOf = (family, s) => STYLES[s][0] + ' ' + STYLES[s][1] + ' 32px ' + family
const image = (src) => {
  const img = new Image()
  img.src = src
  return img
}
const raster = (svg, w = 260, h = 60, white = false) => {
  const ctx = createCanvas(w, h).getContext('2d')
  if (white) {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
  }
  ctx.drawImage(image(Buffer.from(svg)), 0, 0)
  return ctx.getImageData(0, 0, w, h).data
}
const stats = (data, w, gray) => {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, mass = 0
  for (let i = 0; i < data.length / 4; i++) {
    const v = gray ? 255 - Math.min(data[4 * i], data[4 * i + 1], data[4 * i + 2]) : data[4 * i + 3]
    if (!v) continue
    mass += v
    const x = i % w, y = Math.floor(i / w)
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  return { ink: x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1], mass, sha: sha1(data) }
}
const alphaDiff = (a, b) => {
  let n = 0
  for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) n++
  return n
}
const bounds = (xml) => {
  let b = [Infinity, Infinity, -Infinity, -Infinity]
  for (const m of xml.matchAll(/<path([^>]*)>/g)) {
    const d = (m[1].match(/ d="([^"]*)"/) || [])[1]
    if (!d) continue
    const t = (m[1].match(/translate\\(([-\\d.e]+)[ ,]+([-\\d.e]+)\\)/) || [0, 0, 0]).slice(1).map(Number)
    const p = new Path2D(d).computeTightBounds()
    b = [Math.min(b[0], p[0] + t[0]), Math.min(b[1], p[1] + t[1]), Math.max(b[2], p[2] + t[0]), Math.max(b[3], p[3] + t[1])]
  }
  return b
}
const out = { oracle: {}, hamburg: {}, paths: {}, stroke: {}, chrome: {} }
const XS = [2, 30.5, 61.25, 92.75]
for (const [f, styles] of [['lato', ['n', 'w500', 'w600', 'b', 'i', 'o', 'bi']], ['shsb', ['n', 'b', 'i', 'bi']], ['rmono', ['n', 'i']]]) {
  for (const s of styles) {
    const id = f + '.' + s
    const svg = raster(svgOf(FAMILY[f], s, 'Hagf', XS.join(' '), 200), 200)
    const ctx = createCanvas(200, 60).getContext('2d')
    ctx.font = cssOf(FAMILY[f], s)
    ;[...'Hagf'].forEach((ch, i) => ctx.fillText(ch, XS[i], 40))
    out.oracle[id] = alphaDiff(svg, ctx.getImageData(0, 0, 200, 60).data)
  }
}
for (const s of Object.keys(STYLES)) out.hamburg[s] = stats(raster(svgOf('SynthLato', s)), 260, false)
for (const s of ['n', 'b', 'i', 'bi']) {
  const canvas = createCanvas(260, 60, SvgExportFlag.ConvertTextToPaths)
  const ctx = canvas.getContext('2d')
  ctx.font = cssOf('SynthLato', s)
  ctx.fillText('H', 2, 40)
  out.paths[s] = { svg: bounds(convertSVGTextToPath(svgOf('SynthLato', s, 'H')).toString()), canvas: bounds(canvas.getContent().toString()) }
}
const strokeOf = (s, size) =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + (size + 20) + '" height="' + (size + 20) + '"><text x="4" y="' + size +
  '" font-family="SynthLato" font-size="' + size + '" font-weight="' + STYLES[s][1] +
  '" fill="none" stroke="black" stroke-width="0.25">H</text></svg>'
// A glyph rotated by 45deg under scale(1.5 .2): 200 * 1.5 is over 256 px
// before the rotation, about 191 px after it.
const rotated =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><g transform="translate(50 200) scale(1.5 .2)">' +
  '<text rotate="45" font-family="SynthLato" font-size="200" font-weight="700" fill="none" stroke="black" stroke-width="0.25">H</text></g></svg>'
for (const [id, s, size] of [['n', 'n', 64], ['b', 'b', 64], ['b300', 'b', 300], ['brot', 'b', 300]]) {
  const svg = id === 'brot' ? rotated : strokeOf(s, size)
  const xml = convertSVGTextToPath(svg).toString()
  out.stroke[id] = {
    d: [...xml.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]),
    width: [...xml.matchAll(/stroke-width="([^"]*)"/g)].map((m) => Number(m[1])),
    raster: sha1(raster(xml, size + 20, size + 20)),
    source: sha1(raster(svg, size + 20, size + 20)),
  }
}
// Filled "Hm" at a small size, as written (bounds), and under a scale the
// raster still draws from glyph masks (ink; 216-225 device px).
const fillOf = (w, size, scale) =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><g transform="scale(' + scale + ')"><text x="1" y="' +
  size + '" font-family="SynthLato" font-size="' + size + '" font-weight="' + w + '">Hm</text></g></svg>'
out.smallFill = {}
for (const [size, scale] of [[9, 25], [12, 18], [24, 9], [36, 6]]) {
  const row = {}
  for (const w of [400, 700]) {
    const scaled = fillOf(w, size, scale)
    const xml = convertSVGTextToPath(scaled).toString()
    row[w] = {
      bounds: bounds(convertSVGTextToPath(fillOf(w, size, 1)).toString()),
      source: stats(raster(scaled, 400, 300), 400, false).mass,
      path: stats(raster(xml, 400, 300), 400, false).mass,
    }
  }
  out.smallFill[size] = row
}
const bold = svgOf('SynthLato', 'b')
const outer =
  '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="120">' + bold.replace(/^<svg[^>]*>|<\\/svg>$/g, '') +
  '<image y="60" width="260" height="60" href="data:image/svg+xml,' + encodeURIComponent(bold) + '"/></svg>'
const both = raster(outer, 260, 120)
out.nested = { top: sha1(both.slice(0, 260 * 60 * 4)), nested: sha1(both.slice(260 * 60 * 4)) }
const pngOf = (svg) => {
  const canvas = createCanvas(260, 60, SvgExportFlag.NoPrettyXML)
  canvas.getContext('2d').drawImage(image(Buffer.from(svg)), 0, 0)
  const png = /xlink:href="data:image\\/png;base64,([^"]+)"/.exec(canvas.getContent().toString())
  const ctx = createCanvas(260, 60).getContext('2d')
  ctx.drawImage(image(Buffer.from(png[1], 'base64')), 0, 0)
  return sha1(ctx.getImageData(0, 0, 260, 60).data)
}
out.svgCanvas = { bold: pngOf(bold), regular: pngOf(svgOf('SynthLato', 'n')), raster: sha1(raster(bold)) }
const withSynthesis = (svg, decl, text = '') => svg.replace('<text ', text + '<text ' + decl + ' ')
const BI = svgOf('SynthLato', 'bi')
const MIXED = (s) => svgOf('SynthLato, SynthShsBold', s, 'H\u4e2d')
const sha = (svg) => stats(raster(svg), 260, false).sha
out.synthesis = {
  none: sha(withSynthesis(BI, 'style="font-synthesis: none"')),
  weight: sha(withSynthesis(BI, 'style="font-synthesis: weight"')),
  style: sha(withSynthesis(BI, 'style="font-synthesis: style"')),
  weightNone: sha(withSynthesis(BI, 'style="font-synthesis-weight: none"')),
  styleNone: sha(withSynthesis(BI, 'style="font-synthesis-style: none"')),
  inherited: sha(withSynthesis(BI, '', '<g style="font-synthesis: none">').replace('</svg>', '</g></svg>')),
  sheet: sha(withSynthesis(BI, '', '<style>text { font-synthesis: none }</style>')),
  attribute: sha(withSynthesis(BI, 'font-synthesis="none"')),
  variable: sha(withSynthesis(BI, 'style="--syn: none; font-synthesis: var(--syn)"')),
  commented: sha(withSynthesis(BI, 'style="font-synthesis: none/**/"')),
  commentedWeight: sha(withSynthesis(BI, 'style="font-synthesis:/*c*/weight"')),
  escaped: sha(withSynthesis(BI, 'style="font-synthesis: \\\\6e one"')),
  commentedVariable: sha(withSynthesis(BI, 'style="--syn: /**/none; font-synthesis: var(--syn)"')),
  variableWeight: sha(withSynthesis(BI, 'style="--syn: weight; font-synthesis: var(--syn)"')),
  w550: sha(svgOf('SynthLato', 'n').replace('font-weight="400"', 'font-weight="550"')),
  w599: sha(svgOf('SynthLato', 'n').replace('font-weight="400"', 'font-weight="599"')),
  mixedNone: sha(withSynthesis(MIXED('bi'), 'style="font-synthesis: none"')),
  mixedN: sha(MIXED('n')),
  mixedBi: sha(MIXED('bi')),
}
out.w550Path = bounds(convertSVGTextToPath(svgOf('SynthLato', 'n', 'H').replace('font-weight="400"', 'font-weight="550"')).toString())
out.synthesisPath = bounds(convertSVGTextToPath(withSynthesis(svgOf('SynthLato', 'bi', 'H'), 'style="font-synthesis: none"')).toString())
if (process.env.CHROME_PIXELS) {
  for (const row of CHROME) {
    const [f, s] = row.id.split('.')
    const ours = raster(svgOf(FAMILY[f], s), 260, 60, true)
    const ctx = createCanvas(260, 60).getContext('2d')
    ctx.drawImage(image(Buffer.from(row.png, 'base64')), 0, 0)
    const theirs = ctx.getImageData(0, 0, 260, 60).data
    let pixels = 0, max = 0
    for (let i = 0; i < ours.length; i += 4) {
      const d = Math.abs(Math.min(ours[i], ours[i + 1], ours[i + 2]) - Math.min(theirs[i], theirs[i + 1], theirs[i + 2]))
      if (d) pixels++
      max = Math.max(max, d)
    }
    const { ink, mass } = stats(ours, 260, true)
    out.chrome[row.id] = { pixels, max, ink, mass }
  }
}
console.log(JSON.stringify(out))
`

function probe(renderer: string): Probe {
  const pixels = renderer === 'system' && DARWIN === 27
  const { stdout, stderr, status } = spawnSync(process.execPath, ['-e', PROBE], {
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      RENDERER: renderer,
      CHROME_ROWS: JSON.stringify(pixels ? CHROME : []),
      CHROME_PIXELS: pixels ? '1' : '',
    },
    encoding: 'utf8',
    maxBuffer: 16 << 20,
    timeout: 60_000,
  })
  if (status !== 0) throw new Error(stderr)
  return JSON.parse(stdout)
}

const probes = new Map<string, Probe>()
const probeOf = (renderer: string) => {
  if (!probes.has(renderer)) probes.set(renderer, probe(renderer))
  return probes.get(renderer)!
}

// The system renderer draws SVG text with the draw font canvas text uses
// (TextRasterPolicy::DrawFont sets every raster flag on macOS and Linux), so
// glyphs at the same x give the same pixels. The portable renderer keeps
// SkSVG's own raster flags, so only relations are checked there.
const oracleTest = process.platform === 'darwin' || process.platform === 'linux' ? test : test.skip
oracleTest('SVG text draws the synthetic styles canvas text draws (system)', (t) => {
  const { oracle } = probeOf('system')
  // Regular Lato; bold and italic Lato (regular only); Source Han Serif
  // Bold (bold only: no extra bold, italic is synthetic); Roboto Mono's
  // variable font italic (no slnt axis).
  for (const id of Object.keys(oracle)) t.is(oracle[id], 0, `${id}: ${oracle[id]} px differ from canvas text`)
  t.is(Object.keys(oracle).length, 13)
})

for (const renderer of ['portable', 'system'] as const) {
  test(`SVG text gets synthetic bold at 600 and up, and italic for italic and oblique (${renderer})`, (t) => {
    const { hamburg } = probeOf(renderer)
    const { n, w500, w600, b, i, o, bi } = hamburg
    t.is(w500.sha, n.sha, '500 is not bold')
    t.not(b.sha, n.sha)
    t.is(w600.sha, b.sha, '600 is bold')
    t.true(b.mass > n.mass * 1.05, `bold ink ${b.mass} vs ${n.mass}`)
    t.not(i.sha, n.sha)
    t.is(o.sha, i.sha, 'oblique is italic')
    t.true(i.ink![2] > n.ink![2], `italic right edge ${i.ink![2]} vs ${n.ink![2]}`)
    t.not(bi.sha, i.sha)
    t.not(bi.sha, b.sha)
  })

  // The SVG canvas export writes a 32px synthetic bold with SkFont::getPaths'
  // 64px fake bold width (32 / 32); convertSVGTextToPath writes the raster's
  // (32 * interp(32), 1.049), so its bold outline is 0.0247 wider per
  // straight side, and a bit more at bold italic's skewed corners.
  test(`convertSVGTextToPath outlines are the SVG canvas export's (${renderer})`, (t) => {
    const { paths } = probeOf(renderer)
    const grow = (32 * (1 / 24 + (23 / 27) * (1 / 32 - 1 / 24)) - 1) / 2
    for (const [s, { svg, canvas }] of Object.entries(paths)) {
      const out = s === 'b' ? [-grow, -grow, grow, grow] : [0, 0, 0, 0]
      svg.forEach((v, k) => {
        const msg = `${s}: ${JSON.stringify(svg)} vs ${JSON.stringify(canvas)}`
        if (s === 'bi') {
          const d = k < 2 ? canvas[k] - v : v - canvas[k]
          t.true(d >= grow - 1e-3 && d < 0.1, msg)
        } else {
          t.true(Math.abs(v - canvas[k] - out[k]) < 1e-3, msg)
        }
      })
    }
    // Fake bold grows the outline by half a pixel per side; the skew moves
    // the top right.
    t.true(paths.b.svg[0] < paths.n.svg[0] - 0.4, JSON.stringify(paths.b.svg))
    t.true(paths.b.svg[2] > paths.n.svg[2] + 0.4, JSON.stringify(paths.b.svg))
    t.true(paths.i.svg[2] > paths.n.svg[2] + 5, JSON.stringify(paths.i.svg))
    t.true(Math.abs(paths.i.svg[0] - paths.n.svg[0]) < 1e-3, 'the skew keeps the baseline')
  })

  // A stroke of a synthetic bold glyph drawn from glyph masks widens the
  // stroke of the plain outline by the fake bold width (64 / 32 at 64px), so
  // the export writes that, not the fill outline's three contours stroked
  // one by one. Over 256 px the raster draws glyphs as paths and strokes the
  // fake bold contours, so the export keeps them and draws the same pixels.
  test(`convertSVGTextToPath strokes a synthetic bold outline as the raster does (${renderer})`, (t) => {
    const { stroke } = probeOf(renderer)
    t.deepEqual(stroke.n.width, [0.25])
    t.deepEqual(stroke.b.width, [0.25 + 64 / 32])
    t.deepEqual(stroke.b.d, stroke.n.d)
    t.deepEqual(stroke.b300.width, [0.25])
    t.is(stroke.b300.raster, stroke.b300.source)
    // The raster decides per glyph with its rotation.
    t.deepEqual(stroke.brot.width, [0.25 + 200 / 32])
    t.is(stroke.brot.d.length, 1)
  })

  // A filled synthetic bold glyph drawn from glyph masks is its outline
  // stroked and filled by size * interp(size) (1/24 at 9px .. 1/32 from
  // 36px); SkFont::getPaths makes the outline at 64px, so size / 32. The
  // export writes the raster's width: half of it per side on the straight
  // edges of "Hm". Under a scale, the export's ink over the source's is the
  // same as at 36px, where both widths are size / 32 (before the fix: 9px
  // 0.92 vs 1.01).
  test(`convertSVGTextToPath fills a small synthetic bold outline as the raster does (${renderer})`, (t) => {
    const { smallFill } = probeOf(renderer)
    const ratio = (size: string) => smallFill[size][700].path / smallFill[size][700].source
    for (const [size, row] of Object.entries(smallFill)) {
      const s = Number(size)
      const scale = 1 / 24 + ((Math.min(Math.max(s, 9), 36) - 9) / 27) * (1 / 32 - 1 / 24)
      const half = (s * scale) / 2
      const [n, b] = [row[400].bounds, row[700].bounds]
      t.true(Math.abs(n[0] - b[0] - half) < 1e-3, `${size}px left: ${n[0] - b[0]} vs ${half}`)
      t.true(Math.abs(b[2] - n[2] - half) < 1e-3, `${size}px right: ${b[2] - n[2]} vs ${half}`)
      t.true(Math.abs(b[3] - n[3] - half) < 1e-3, `${size}px bottom: ${b[3] - n[3]} vs ${half}`)
      t.true(Math.abs(ratio(size) - ratio('36')) < 0.01, `${size}px ink: ${ratio(size)} vs ${ratio('36')}`)
    }
  })

  // font-synthesis (Chrome 157: the shorthand, its longhands, inherited,
  // from a style sheet; not a presentation attribute) turns the synthetic
  // styles off for every font of the list.
  test(`font-synthesis turns off synthetic bold and italic (${renderer})`, (t) => {
    const { synthesis, synthesisPath, hamburg, paths } = probeOf(renderer)
    t.is(synthesis.none, hamburg.n.sha)
    t.is(synthesis.weight, hamburg.b.sha)
    t.is(synthesis.style, hamburg.i.sha)
    t.is(synthesis.weightNone, hamburg.i.sha)
    t.is(synthesis.styleNone, hamburg.b.sha)
    t.is(synthesis.inherited, hamburg.n.sha)
    t.is(synthesis.sheet, hamburg.n.sha)
    t.is(synthesis.attribute, hamburg.bi.sha)
    t.is(synthesis.variable, hamburg.n.sha)
    t.is(synthesis.variableWeight, hamburg.b.sha)
    // CSS tokens: comments are not part of the value, an escape is its
    // character (Chrome 157).
    t.is(synthesis.commented, hamburg.n.sha)
    t.is(synthesis.commentedWeight, hamburg.b.sha)
    t.is(synthesis.escaped, hamburg.n.sha)
    t.is(synthesis.commentedVariable, hamburg.n.sha)
    // 中 is Source Han Serif Bold's, a list font after Lato.
    t.is(synthesis.mixedNone, synthesis.mixedN)
    t.not(synthesis.mixedBi, synthesis.mixedN)
    synthesisPath.forEach((v, k) => t.true(Math.abs(v - paths.n.svg[k]) < 1e-3, JSON.stringify(synthesisPath)))
  })

  // SkSVG reads font-weight rounded to 100s; the synthetic bold is decided
  // at the computed weight, so 550 and 599 are not bold (Chrome 157).
  test(`SVG text below weight 600 is not a synthetic bold (${renderer})`, (t) => {
    const { synthesis, w550Path, hamburg, paths } = probeOf(renderer)
    t.is(synthesis.w550, hamburg.n.sha)
    t.is(synthesis.w599, hamburg.n.sha)
    w550Path.forEach((v, k) => t.true(Math.abs(v - paths.n.svg[k]) < 1e-3, JSON.stringify(w550Path)))
  })

  test(`a nested SVG image and an SVG canvas keep the synthetic styles (${renderer})`, (t) => {
    const { nested, svgCanvas, hamburg } = probeOf(renderer)
    t.is(nested.nested, nested.top)
    t.is(svgCanvas.raster, hamburg.b.sha)
    t.is(svgCanvas.bold, svgCanvas.raster, 'the embedded PNG is the bold raster')
    t.not(svgCanvas.bold, svgCanvas.regular)
  })
}

// A draw under font-synthesis: none does not change later draws, and is not
// changed by earlier ones: the system fallback (CoreText on macOS) is asked
// as for any other text and keeps one answer per key. 中 bold italic (Lato
// has no 中) as SVG text with and without font-synthesis and as canvas
// text, each process drawing STEPS in order.
const ORDER = `
const { createHash } = require('crypto')
const { createCanvas, GlobalFonts, setTextRenderer, Image } = require('./index.js')
setTextRenderer(process.env.RENDERER)
GlobalFonts.registerFromPath(require('path').join('__test__', 'fonts', 'Lato-Regular.ttf'), 'SynthLato')
const svg = (decl) => '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><text x="4" y="64" font-family="SynthLato" ' +
  'font-size="64" font-weight="700" font-style="italic" style="' + decl + '">\u4e2d</text></svg>'
const sha = (ctx) => createHash('sha1').update(ctx.getImageData(0, 0, 200, 80).data).digest('hex')
const image = (decl) => {
  const ctx = createCanvas(200, 80).getContext('2d')
  const img = new Image()
  img.src = Buffer.from(svg(decl))
  ctx.drawImage(img, 0, 0)
  return sha(ctx)
}
const text = () => {
  const ctx = createCanvas(200, 80).getContext('2d')
  ctx.font = 'italic 700 64px SynthLato'
  ctx.fillText('\u4e2d', 4, 64)
  return sha(ctx)
}
const draws = { image: () => image(''), none: () => image('font-synthesis: none'), text }
console.log(JSON.stringify(process.env.STEPS.split(' ').map((step) => draws[step]())))
`

for (const renderer of ['portable', 'system'] as const) {
  test(`a font-synthesis: none draw does not change later text (${renderer})`, (t) => {
    const run = (steps: string): string[] => {
      const { stdout, stderr, status } = spawnSync(process.execPath, ['-e', ORDER], {
        cwd: join(__dirname, '..'),
        env: { ...process.env, RENDERER: renderer, STEPS: steps },
        encoding: 'utf8',
        timeout: 60_000,
      })
      if (status !== 0) throw new Error(stderr)
      return JSON.parse(stdout)
    }
    const [image, text] = run('image text')
    const [none] = run('none')
    t.deepEqual(run('none image text'), [none, image, text])
    t.deepEqual(run('image text none'), [image, text, none])
  })
}

// CoreText is asked for a fallback font with the first font's synthetic
// styles after font-synthesis (Blink's GetAlternateFontPlatformData reads
// the FontPlatformData's), so under font-synthesis: none italic Ѣ (Lato has
// none) gets the upright face. The x of "H" after it, from
// convertSVGTextToPath, at 64px; each STEPS order in one process.
const FALLBACK = `
const { convertSVGTextToPath, GlobalFonts, setTextRenderer } = require('./index.js')
setTextRenderer('system')
GlobalFonts.registerFromPath(require('path').join('__test__', 'fonts', 'Lato-Regular.ttf'), 'SynthLato')
const hx = (step) => {
  const [style, weight, synthesis] = step.split('/')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80"><text x="0" y="64" font-family="SynthLato" ' +
    'font-size="64" font-style="' + style + '" font-weight="' + weight + '" style="font-synthesis: ' + synthesis + '">ѢH</text></svg>'
  return Number([...convertSVGTextToPath(Buffer.from(svg)).toString().matchAll(/translate\\(([^ )]+) /g)][1][1])
}
console.log(JSON.stringify(process.env.STEPS.split(' ').map(hx)))
`

const darwinTest = process.platform === 'darwin' ? test : test.skip
darwinTest('font-synthesis: none asks CoreText for the fallback font without synthetic styles (system)', (t) => {
  const run = (steps: string): number[] => {
    const { stdout, stderr, status } = spawnSync(process.execPath, ['-e', FALLBACK], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, STEPS: steps },
      encoding: 'utf8',
      timeout: 60_000,
    })
    if (status !== 0) throw new Error(stderr)
    return JSON.parse(stdout)
  }
  const steps = [
    'normal/400/auto',
    'normal/700/auto',
    'italic/400/auto',
    'italic/700/auto',
    'italic/400/none',
    'italic/700/none',
    'italic/400/weight',
    'italic/700/style',
  ]
  const forward = run(steps.join(' '))
  const [normal, bold, italic, boldItalic, none, boldNone, weight, style] = forward
  t.deepEqual(run([...steps].reverse().join(' ')), [...forward].reverse(), 'the draw order does not matter')
  // No synthetic italic allowed: the fallback face of plain text.
  t.is(none, normal)
  t.is(boldNone, bold)
  t.is(weight, normal)
  // Synthetic italic allowed: the italic face.
  t.is(style, boldItalic)
  if (DARWIN === 27) {
    // Chrome 157 (macOS 27, inline SVG, getStartPositionOfChar); the path
    // export writes 4 decimals.
    const chrome = [51.40625, 49.78125, 42.6875, 53.3125, 51.40625, 49.78125, 51.40625, 53.3125]
    forward.forEach((x, k) => t.true(Math.abs(x - chrome[k]) < 1e-3, `${steps[k]}: ${x} vs ${chrome[k]}`))
    t.not(italic, none, 'Ѣ has an italic fallback face here')
  }
})

// Chrome 157's pixels, macOS 27, the system renderer. Lato and Roboto Mono
// have no kerning pair in "Hamburg", so the rows match Chrome's pixels
// (Chrome rasterizes a fake bold glyph from a slightly wider stroke).
// Source Han Serif Bold and Chalkduster have kerning, which SkSVG's shaper
// does not apply; their ink mass and box are checked.
const darwinSystem = DARWIN === 27 ? test : test.skip
darwinSystem('SVG text synthetic styles match Chrome 157 (macOS 27, system)', (t) => {
  const { chrome } = probeOf('system')
  t.is(Object.keys(chrome).length, CHROME.length)
  for (const row of CHROME) {
    const ours = chrome[row.id]
    const label = `${row.id}: ${ours.pixels} px, max ${ours.max}, ink ${JSON.stringify(ours.ink)} ${ours.mass}`
    if (row.id.startsWith('lato.') || row.id.startsWith('rmono.')) {
      t.true(ours.pixels <= 4 && ours.max <= 32, label)
    } else {
      t.true(Math.abs(ours.mass - row.mass) <= row.mass * 1e-3, label)
      ours.ink!.forEach((v, k) => t.true(Math.abs(v - row.ink[k]) <= 2, label))
    }
  }
})
