// SVG images drawn like Chrome 155 (CPU canvas, willReadFrequently,
// standards-mode page): the `<style>` cascade, var(), quoted url(),
// `<use>`, the clipPath content model, `<image>` and `<text>`
// (src/svg_doc, skia-c/svg_image.cpp).
//
// fixtures/svg-image-chrome/ref.json.gz holds Chrome's pixels for every case
// of corpora/*.cjs: each case loads `svg` from a Buffer, draws it with
// drawImage(image, ...(args ?? dst ?? [0, 0])) on a w x h canvas and reads
// it back. `px_x64` is Chrome under Rosetta where it differs from arm64.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, inflateRawSync } from 'node:zlib'

import test from 'ava'

import { createCanvas, Image } from '../index'

const DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(DIR, 'fixtures', 'svg-image-chrome')
const require = createRequire(import.meta.url)

interface RefCase {
  W: number
  H: number
  nw: number
  nh: number
  dec: string
  px: string
  px_x64?: string
}

interface Ref {
  chrome: string
  corpora: Record<string, { file: string; cases: Record<string, RefCase> }>
}

interface Case {
  svg: string
  w: number
  h: number
  dst?: number[]
  args?: number[]
}

const REF: Ref = JSON.parse(gunzipSync(readFileSync(join(FIXTURES, 'ref.json.gz'))).toString('utf8'))

// What still differs from Chrome: the largest channel difference measured
// (`x64` where our x64 build differs), so a change for the worse fails.
const KNOWN_GAPS: Record<string, { max: number; x64?: number; why: string }> = {
  'corpus1/cp_text': {
    max: 255,
    why: 'text in a clipPath: Chrome clips with a mask of the drawn text (layout_svg_resource_clipper.cc:69-71), SkSVG with the glyph outlines',
  },
  'corpus1/url_issue1029': { max: 1, why: 'gradient: Chrome dithers it (gradient.cc), SkSVG does not' },
  'corpus1/feimage_svg': { max: 255, why: 'feImage: Blink filter graph, not in this change' },
  'corpus2/g_lingrad': { max: 2, why: 'gradient dither' },
  'corpus2/g_radgrad': { max: 1, why: 'gradient dither' },
  'corpus2/g_grad_href': { max: 1, why: 'gradient dither' },
  'corpus2/g_grad_userspace': {
    max: 6,
    x64: 128,
    why: 'gradient dither; on x64 the gradient differs as before this change',
  },
  'corpus2/g_pattern_transform': {
    max: 18,
    x64: 0,
    why: 'pattern tile: Blink samples its tile, SkSVG draws a picture shader',
  },
  'corpus2/g_dropshadow': { max: 255, why: 'filters: Blink filter graph, not in this change' },
  'corpus2/g_marker': { max: 255, why: 'markers on <path>: not in this change' },
  'corpus2/g_foreignobject': { max: 255, why: '<foreignObject> needs HTML layout' },
  'corpus2/g_vector_effect': { max: 255, why: 'vector-effect: non-scaling-stroke: not in this change' },
  'corpus2/g_shape_rendering': { max: 135, why: 'shape-rendering: crispEdges: SkSVG always anti-aliases' },
  'corpus2/g_mix_blend': { max: 255, why: 'mix-blend-mode: not in this change' },
  'img4/b_2x': { max: 16, why: 'broken-image icon scaled up: Chrome samples it differently' },
  'img4/b_slice': { max: 5, why: 'broken-image icon scaled up: Chrome samples it differently' },
  'safety/grad_href_self': { max: 1, why: 'gradient dither' },
  'safety/grad_href_mutual': { max: 1, why: 'gradient dither' },
  'safety/grad_href_loop3': { max: 1, why: 'gradient dither' },
  'safety/image_chain_65': {
    max: 255,
    why: 'SVG images nest through <image> at most 64 deep here (svg_doc MAX_NESTING); Chrome has no limit',
  },
}

const X64 = process.arch === 'x64'
const MACOS = process.platform === 'darwin'

function load(svg: string) {
  const image = new Image()
  return new Promise<Image | null>((resolve) => {
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = Buffer.from(svg, 'utf8')
  })
}

async function draw(c: Case) {
  const image = await load(c.svg)
  const canvas = createCanvas(c.w, c.h)
  const ctx = canvas.getContext('2d')
  if (image) {
    ctx.drawImage(image, ...((c.args ?? c.dst ?? [0, 0]) as [number, number]))
  }
  return { image, data: ctx.getImageData(0, 0, c.w, c.h).data }
}

function pixel(data: Uint8ClampedArray, width: number, x: number, y: number) {
  const i = (y * width + x) * 4
  return [data[i], data[i + 1], data[i + 2], data[i + 3]]
}

for (const [tag, corpus] of Object.entries(REF.corpora)) {
  const cases: Record<string, Case> = require(join(FIXTURES, 'corpora', corpus.file))
  for (const [name, ref] of Object.entries(corpus.cases)) {
    const c = cases[name]
    // Glyphs come from the platform's fonts: Chrome was measured on macOS.
    const text = /<text\b/.test(c.svg)
    test(`svg chrome: ${tag}/${name}`, async (t) => {
      const { image, data } = await draw(c)
      if (ref.dec !== 'ok') {
        t.is(image, null, 'Chrome fails to load it')
        return
      }
      t.truthy(image, 'Chrome loads it')
      t.deepEqual([image!.naturalWidth, image!.naturalHeight], [ref.nw, ref.nh])
      if (text && !MACOS) {
        t.pass('glyphs measured on macOS only')
        return
      }
      const want = inflateRawSync(Buffer.from(X64 && ref.px_x64 ? ref.px_x64 : ref.px, 'base64'))
      let max = 0
      let count = 0
      let first = -1
      for (let i = 0; i < want.length; i += 4) {
        let m = 0
        for (let j = 0; j < 4; j++) {
          m = Math.max(m, Math.abs(data[i + j] - want[i + j]))
        }
        if (m) {
          count++
          if (first < 0) first = i / 4
        }
        max = Math.max(max, m)
      }
      const gap = KNOWN_GAPS[`${tag}/${name}`]
      const allowed = gap ? ((X64 ? gap.x64 : undefined) ?? gap.max) : 0
      t.true(
        max <= allowed,
        `max channel diff ${max} (allowed ${allowed}) in ${count} px, first at (${first % c.w}, ${Math.floor(first / c.w)})`,
      )
    })
  }
}

async function chromePixel(tag: string, name: string, x: number, y: number) {
  const c: Case = require(join(FIXTURES, 'corpora', REF.corpora[tag].file))[name]
  const { data } = await draw(c)
  return pixel(data, c.w, x, y)
}

// The parts of issue rows #1150, #749, #1029 and #859, as Chrome 155 draws
// them (arm64 = x64).
test('svg issue #1150: a clipPath child <g> does not clip', async (t) => {
  t.deepEqual(await chromePixel('corpus1', 'cp_g_issue1150', 5, 5), [0, 0, 0, 0])
})

test('svg issue #749: <style> class rules apply', async (t) => {
  t.deepEqual(await chromePixel('corpus1', 'st_issue749', 10, 10), [226, 67, 41, 255])
})

test('svg issue #1029: url() with &quot; quotes finds the gradient', async (t) => {
  t.deepEqual(await chromePixel('corpus1', 'url_quot', 10, 10), [0, 0, 255, 255])
  t.deepEqual(await chromePixel('corpus1', 'url_issue1029', 50, 50), [213, 213, 213, 255])
})

test('svg var(): a custom property gives the fill', async (t) => {
  t.deepEqual(await chromePixel('corpus1', 'var_basic', 10, 10), [0, 0, 255, 255])
})

test('svg issue #859: a nested SVG data URL <image> draws', async (t) => {
  t.deepEqual(await chromePixel('corpus1', 'img_issue859_tri', 20, 20), [0, 0, 0, 255])
})

test('svg <image> that cannot load draws the broken-image icon', async (t) => {
  t.deepEqual(await chromePixel('img4', 'b_https', 5, 5), [243, 247, 253, 255])
})

const macos = MACOS ? test : test.skip
macos('svg <text> is drawn with canvas text anti-aliasing', async (t) => {
  // An Arial "I" stem at y = 20: alpha 119, 255, 255, 255, 184 at x = 3..7.
  const c: Case = require(join(FIXTURES, 'corpora', 'corpus1.cjs')).text_rect_stem
  const { data } = await draw(c)
  const row = [3, 4, 5, 6, 7].map((x) => pixel(data, c.w, x, 20)[3])
  t.deepEqual(row, [119, 255, 255, 255, 184])
})

test('drawImage(svg) with an empty source rect draws nothing', async (t) => {
  const c: Case = require(join(FIXTURES, 'corpora', 'draw.cjs')).empty_sw
  const { data } = await draw(c)
  t.true(
    data.every((v) => v === 0),
    'nothing drawn',
  )
})

test('an SVG image deeper than 5000 elements fails to load', async (t) => {
  const deep = (depth: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">${'<g>'.repeat(depth - 2)}<rect width="10" height="10"/>${'</g>'.repeat(depth - 2)}</svg>`
  t.truthy(await load(deep(5000)))
  t.is(await load(deep(5001)), null)
})

// Inputs that crashed or blew up before (critic/hostile.cjs of the design
// notes), drawn as there: drawImage(image, 0, 0, 200, 200) on a 200x200
// canvas. Each runs in a process of its own, so a crash fails this test
// instead of the run.
test('hostile SVG images load without crashing', (t) => {
  const script = `
    const { Image, createCanvas } = require(${JSON.stringify(join(DIR, '..', 'index.js'))})
    const X = 'xmlns="http://www.w3.org/2000/svg"'
    const S = (body, w = 200, h = 200) => \`<svg \${X} xmlns:xlink="http://www.w3.org/1999/xlink" width="\${w}" height="\${h}">\${body}</svg>\`
    const inputs = {
      deep_nest_50k: S('<g>'.repeat(50000) + '<rect width="10" height="10"/>' + '</g>'.repeat(50000)),
      fe_many_prims: \`<svg \${X} width="60" height="60"><filter id="f" >\${'<feOffset dx="0.1"/>'.repeat(20000)}</filter><rect x="10" y="10" width="40" height="40" fill="#0a0" filter="url(#f)"/></svg>\`,
      use_bomb5: (() => {
        let b = '<defs><rect id="l0" width="1" height="1" fill="#f00"/>'
        for (let i = 1; i <= 5; i++) {
          b += \`<g id="l\${i}">\`
          for (let k = 0; k < 10; k++) b += \`<use href="#l\${i - 1}" x="\${k % 3}"/>\`
          b += '</g>'
        }
        return S(b + '</defs><use href="#l5"/>')
      })(),
      var_exp28: (() => {
        let s = '--v0: xx;'
        for (let i = 1; i <= 28; i++) s += \`--v\${i}: var(--v\${i - 1}) var(--v\${i - 1});\`
        return S(\`<rect width="10" height="10" style="\${s} fill: var(--v28, red)"/>\`)
      })(),
    }
    const out = {}
    for (const [name, svg] of Object.entries(inputs)) {
      const image = new Image()
      let loaded = null
      image.onload = () => (loaded = true)
      image.onerror = () => (loaded = false)
      image.src = Buffer.from(svg, 'utf8')
      const ctx = createCanvas(200, 200).getContext('2d')
      if (loaded) ctx.drawImage(image, 0, 0, 200, 200)
      const data = ctx.getImageData(0, 0, 200, 200).data
      let painted = 0
      for (let i = 3; i < data.length; i += 4) if (data[i]) painted++
      out[name] = [loaded, painted]
    }
    console.log(JSON.stringify(out))
  `
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 120_000 })
  t.is(run.status, 0, run.stderr)
  const out = JSON.parse(run.stdout)
  // Chrome 155: 50k levels fail to load, the fan-out paints 11 px and the
  // doubling var() 100 px.
  t.deepEqual(out.deep_nest_50k, [false, 0])
  t.deepEqual(out.use_bomb5, [true, 11])
  t.deepEqual(out.var_exp28, [true, 100])
  // Chrome paints nothing here; SkSVG's filters are not Blink's.
  t.is(out.fe_many_prims[0], true)
})

// A raster in an SVG image is decoded at the first draw and kept with the
// image. V8 is told about it, so dropped images are collected without an
// explicit gc(), as plain PNG images are.
test('dropped SVG images with a nested raster are collected', (t) => {
  const script = `
    const { Image, createCanvas } = require(${JSON.stringify(join(DIR, '..', 'index.js'))})
    // 1024 x 1024: 4 MiB decoded, about 50 KB encoded.
    const source = createCanvas(1024, 1024)
    const sctx = source.getContext('2d')
    const gradient = sctx.createLinearGradient(0, 0, 1024, 1024)
    gradient.addColorStop(0, 'red')
    gradient.addColorStop(1, 'blue')
    sctx.fillStyle = gradient
    sctx.fillRect(0, 0, 1024, 1024)
    const png = source.toBuffer('image/png').toString('base64')
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
        '<image href="data:image/png;base64,' + png + '" width="64" height="64"/></svg>',
    )
    const N = 40
    let collected = 0
    const registry = new FinalizationRegistry(() => collected++)
    const ctx = createCanvas(8, 8).getContext('2d')
    ;(async () => {
      for (let i = 0; i < N; i++) {
        const image = new Image()
        image.src = svg
        ctx.drawImage(image, 0, 0, 8, 8)
        registry.register(image, i)
        await new Promise((resolve) => setImmediate(resolve))
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      console.log(JSON.stringify({ N, collected, alpha: ctx.getImageData(4, 4, 1, 1).data[3] }))
    })()
  `
  const run = spawnSync(process.execPath, ['--max-old-space-size=4096', '-e', script], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  t.is(run.status, 0, run.stderr)
  const out = JSON.parse(run.stdout)
  t.is(out.alpha, 255, 'the nested raster draws')
  t.true(out.collected >= out.N / 2, `${out.collected} of ${out.N} dropped images collected`)
})
