import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, promises as fs } from 'node:fs'

import test from 'ava'

import { convertSVGTextToPath, createCanvas, GlobalFonts, Image } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const FIXTURE = readFileSync(join(__dirname, 'text.svg'), 'utf8')

test.beforeEach((t) => {
  t.truthy(GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf')))
})

test('convertSVGTextToPath should work', async (t) => {
  const result = convertSVGTextToPath(FIXTURE)
  const outputPath = join(__dirname, 'text-to-path.svg')
  const output = await fs.readFile(outputPath, 'utf8')
  if (process.platform === 'win32') {
    t.pass('Skip on windows')
  } else {
    result
      .toString('utf8')
      .split('\n')
      .forEach((line, index) => {
        t.deepEqual(line.trim(), output.split('\n')[index]?.trim())
      })
  }
})

// Bytes that are not an SVG document (not XML, a repeated attribute, a
// U+FFFF character) throw the error a document SkSVG cannot read throws,
// instead of crashing the process. In a child process, so a crash fails
// this test and not the run.
test('convertSVGTextToPath throws on bytes that are not an SVG document', (t) => {
  const script = `
    const { convertSVGTextToPath } = require(process.env.PROBE_INDEX)
    const inputs = ['not svg', '<svg a="1" a="2"/>', '<svg xmlns="http://www.w3.org/2000/svg">\\uFFFF</svg>']
    console.log(JSON.stringify(inputs.map((input) => {
      try {
        return { length: convertSVGTextToPath(input).length }
      } catch (e) {
        return { error: e.message }
      }
    })))
  `
  const child = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, PROBE_INDEX: join(__dirname, '..', 'index.js') },
  })
  t.is(child.signal, null, child.stderr)
  t.is(child.status, 0, child.stderr)
  t.deepEqual(JSON.parse(child.stdout), [
    { error: 'Convert svg text to path failed' },
    { error: 'Convert svg text to path failed' },
    { error: 'Convert svg text to path failed' },
  ])
})

// convertSVGTextToPath keeps the root's size, coordinates and transform:
// a root sized by its style="" declarations, a root sized in physical units
// with no viewBox (1in is 96px, for the root as for its content, as the SVG
// image is sized), and a root with a transform.
test('convertSVGTextToPath keeps the root size, coordinates and transform', (t) => {
  const out = (root: string, body = '<rect width="50" height="20"/>') =>
    convertSVGTextToPath(`<svg xmlns="http://www.w3.org/2000/svg" ${root}>${body}</svg>`)
      .toString()
      .replace(/\s+/g, ' ')
  const rect = '<rect width="50" height="20"/>'
  for (const [root, size] of [
    ['style="width:200px;height:60px"', 'width="200" height="60"'],
    ['width="100" height="30" style="width:200px;height:60px"', 'width="200" height="60"'],
    ['width="100" height="30" style="width:auto"', 'width="100" height="30"'],
    ['width="1in" height="1in"', 'width="96" height="96"'],
    ['width="20mm" height="10mm"', 'width="76" height="38"'],
    ['width="1in" height="1in" viewBox="0 0 96 96"', 'width="96" height="96"'],
  ]) {
    const svg = out(root)
    t.true(svg.includes(` ${size}>`), `${root}: ${svg}`)
    t.true(svg.includes(rect), `${root}: ${svg}`)
  }
  t.true(
    out('width="1in" height="1in"', '<rect x=".5in" y=".5in" width=".5in" height=".5in"/>').includes(
      '<rect x="48" y="48" width="48" height="48"/>',
    ),
  )
  const moved = out('width="200" height="60" transform="translate(50 0)"')
  t.true(moved.includes('<rect transform="translate(50 0)" width="50" height="20"/>'), moved)
})

// Text as Blink lays it out in an SVG image and in convertSVGTextToPath: a
// visibility: hidden fragment draws nothing and keeps its advance, and a
// text position in physical units is at 96 dpi, as the shapes are.
test('hidden text fragments keep their advance, and text positions in inches are at 96 dpi', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), 'SvgSpecLato')
  const svgOf = (root: string, body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" ${root}><text font-family="SvgSpecLato" font-size="20" ${body}</text></svg>`
  const xs = (svg: string) =>
    [
      ...convertSVGTextToPath(svg)
        .toString()
        .matchAll(/<path transform="translate\(([^ )]+) ([^)]+)\)"/g),
    ].map((m) => [Number(m[1]), Number(m[2])])
  const pixels = (svg: string, w: number, h: number) => {
    const image = new Image()
    image.src = Buffer.from(svg)
    const ctx = createCanvas(w, h).getContext('2d')
    ctx.drawImage(image, 0, 0)
    return Buffer.from(ctx.getImageData(0, 0, w, h).data)
  }
  const size = 'width="200" height="60"'
  const hidden = svgOf(size, 'x="2" y="40">A<tspan visibility="hidden">SECRET</tspan>B')
  const shown = xs(svgOf(size, 'x="2" y="40">ASECRETB'))
  t.deepEqual(xs(hidden), [shown[0], shown[7]])
  // The image is A and B where the whole text has them.
  const b = shown[7][0]
  t.deepEqual(pixels(hidden, 200, 60), pixels(svgOf(size, `x="2 ${b}" y="40">AB`), 200, 60))
  const inches = 'width="1in" height="1in"'
  const inch = svgOf(inches, 'x=".5in" y=".5in">A')
  t.deepEqual(xs(inch), [[48, 48]])
  t.deepEqual(pixels(inch, 96, 96), pixels(svgOf(inches, 'x="48" y="48">A'), 96, 96))
})

// convertSVGTextToPath lays the content out at the size its output's root
// gets (the root's style="" first), and the SVG image and the conversion
// read clipping text and whitespace as Chrome 157 does: a clip text
// position in inches is at 96 dpi as the text it clips, and xml:space on a
// tspan keeps its spaces (SVGTextContentElement presentation attribute).
test('convertSVGTextToPath lays out at the root size it writes; clip text and tspan xml:space', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), 'SvgSpecLato')
  const pixels = (svg: string, w: number, h: number) => {
    const image = new Image()
    image.src = Buffer.from(svg)
    const ctx = createCanvas(w, h).getContext('2d')
    ctx.drawImage(image, 0, 0)
    return Buffer.from(ctx.getImageData(0, 0, w, h).data)
  }
  const converted = (svg: string, w: number, h: number) => pixels(convertSVGTextToPath(svg).toString(), w, h)
  const xs = (svg: string) =>
    [
      ...convertSVGTextToPath(svg)
        .toString()
        .matchAll(/<path transform="translate\(([^ )]+) ([^)]+)\)"/g),
    ].map((m) => [Number(m[1]), Number(m[2])])
  const doc = (root: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" ${root}>${body}</svg>`
  // Percentages of a root sized by its style.
  const shapes =
    '<line x1="0" y1="10" x2="50%" y2="10" stroke="black" stroke-width="4"/><ellipse cx="50%" cy="50%" rx="25%" ry="25%"/>'
  t.deepEqual(
    converted(doc('width="100" height="30" style="width:200px;height:60px"', shapes), 200, 60),
    converted(doc('width="200" height="60"', shapes), 200, 60),
  )
  // A text clipped by the same text, in inches and in px.
  const clipped = (at: string) =>
    doc(
      'width="200" height="100"',
      `<clipPath id="c"><text x="${at}" y="${at}" font-family="SvgSpecLato" font-size="40">A</text></clipPath>` +
        `<text x="${at}" y="${at}" font-family="SvgSpecLato" font-size="40" clip-path="url(#c)">A</text>`,
    )
  t.deepEqual(pixels(clipped('.5in'), 200, 100), pixels(clipped('48'), 200, 100))
  t.deepEqual(converted(clipped('.5in'), 200, 100), converted(clipped('48'), 200, 100))
  // Two spaces kept by a tspan, as by the text.
  const text = (attrs: string, body: string) =>
    doc('width="200" height="60"', `<text x="2" y="40" font-family="SvgSpecLato" font-size="20"${attrs}>${body}</text>`)
  const tspan = text('', 'A<tspan xml:space="preserve">  B</tspan>C')
  const whole = text(' xml:space="preserve"', 'A  BC')
  t.deepEqual(xs(tspan), xs(whole))
  t.deepEqual(pixels(tspan, 200, 60), pixels(whole, 200, 60))
})

// SkSVG sizes convertSVGTextToPath's output from the root's width, height
// and style="" in document order, an invalid value keeping the one before
// it; and a hidden tspan in a clip path's text adds no outline to the clip
// (Chrome 157 clips to A and B only).
test('convertSVGTextToPath root size takes the last valid value; hidden clip text adds no outline', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), 'SvgSpecLato')
  const root = (attrs: string) =>
    /<svg [^>]*>/
      .exec(
        convertSVGTextToPath(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="50" height="20"/></svg>`)
          .toString()
          .replace(/<\?xml[^>]*>\s*/, ''),
      )![0]
      .replace(/ xmlns(:xlink)?="[^"]*"/g, '')
  t.is(root('height="60" style="width:400px;width:invalid"'), '<svg width="400" height="60">')
  t.is(root('width="100" style="height:60px;height:bad"'), '<svg width="100" height="60">')
  t.is(root('style="width:200px;height:60px" width="100" height="30"'), '<svg width="100" height="30">')
  const clipped =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><clipPath id="c">' +
    '<text x="2" y="40" font-family="SvgSpecLato" font-size="20">A<tspan visibility="hidden">SECRET</tspan>B</text>' +
    '</clipPath><rect width="200" height="60" clip-path="url(#c)"/></svg>'
  // Ink right of A and left of where Chrome puts B (87.84): SECRET's outlines.
  const secret = (svg: string) => {
    const image = new Image()
    image.src = Buffer.from(svg)
    const ctx = createCanvas(200, 60).getContext('2d')
    ctx.drawImage(image, 0, 0)
    const data = ctx.getImageData(30, 0, 55, 60).data
    return data.filter((_, i) => i % 4 === 3 && data[i] > 0).length
  }
  t.is(secret(clipped), 0)
  t.is(secret(convertSVGTextToPath(clipped).toString()), 0)
})
