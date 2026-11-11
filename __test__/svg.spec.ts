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

// convertSVGTextToPath converts the whole document, past the element budget
// an SVG image stops at (2^18): here 8^6 empty <g> instances through <use>,
// then a <rect>.
test('convertSVGTextToPath keeps the elements past the SVG image element budget', (t) => {
  let defs = '<g id="l0"/>'
  for (let i = 1; i <= 6; i++) {
    defs += `<g id="l${i}">${`<use href="#l${i - 1}"/>`.repeat(8)}</g>`
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><defs>${defs}</defs><use href="#l6"/><rect width="5" height="5"/></svg>`
  t.true(convertSVGTextToPath(svg).toString().includes('<rect width="5" height="5"/>'))
})

// The same past the reference check's budget (2^16 steps): each clip path of
// 15 levels clips its two rects with both clip paths of the next level, so
// the check takes 2^15 paths. An SVG image drops the clip there.
test('convertSVGTextToPath keeps references past the SVG image cycle check budget', (t) => {
  let defs =
    '<clipPath id="a14"><rect width="3" height="3"/></clipPath><clipPath id="b14"><rect width="3" height="3"/></clipPath>'
  for (let i = 13; i >= 0; i--) {
    for (const n of 'ab') {
      defs += `<clipPath id="${n}${i}"><rect width="9" height="9" clip-path="url(#a${i + 1})"/><rect width="9" height="9" clip-path="url(#b${i + 1})"/></clipPath>`
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><defs>${defs}</defs><rect width="20" height="20" clip-path="url(#a0)"/></svg>`
  t.true(convertSVGTextToPath(svg).toString().includes('<clipPath'))
})

// Past a budget the document goes to SkSVG with the edits of
// svg_doc::fallback, and converts as it does under the budget. `fanOut(k)`
// puts it past the element budget at k = 6: 8^k empty <g> instances through
// SVG2 <use href>.
const XLINK = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
function fanOut(k: number) {
  return `${fanOutDefs(k)}<use href="#l${k}"/>`
}

// The <g> elements of fanOut, not drawn.
function fanOutDefs(k: number, id = 'l') {
  let defs = `<g id="${id}0"/>`
  for (let i = 1; i <= k; i++) {
    defs += `<g id="${id}${i}">${`<use href="#${id}${i - 1}"/>`.repeat(8)}</g>`
  }
  return `<defs>${defs}</defs>`
}

// In a child process, killed after 20 s; with `worker`, in a worker thread
// there, on a 4 MB stack.
function convertInChild(svg: string, worker = false) {
  const convert = `
    const { convertSVGTextToPath } = require(process.env.PROBE_INDEX)
    process.stdout.write(convertSVGTextToPath(require('fs').readFileSync(0, 'utf8')))
  `
  const script = worker
    ? `new (require('worker_threads').Worker)(${JSON.stringify(convert)}, { eval: true, resourceLimits: { stackSizeMb: 4 } })`
    : convert
  return spawnSync(process.execPath, ['-e', script], {
    input: svg,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, PROBE_INDEX: join(__dirname, '..', 'index.js') },
  })
}

// An SVG image of `svg` decoded and drawn in a child process, killed after
// 20 s: prints ok.
function imageInChild(svg: string) {
  const script = `
    const { loadImage, createCanvas } = require(process.env.PROBE_INDEX)
    loadImage(require('fs').readFileSync(0)).then(
      (image) => {
        createCanvas(10, 10).getContext('2d').drawImage(image, 0, 0)
        process.stdout.write('ok')
      },
      (e) => process.stdout.write('error ' + e.message),
    )
  `
  return spawnSync(process.execPath, ['-e', script], {
    input: svg,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, PROBE_INDEX: join(__dirname, '..', 'index.js') },
  })
}

// SkSVG's <pattern> href walk has no loop check: a chain from outside into a
// cycle hung there. The reference that closes the cycle is dropped, so the
// chain walks the cycle once: c takes its size from a and its content from b.
test('convertSVGTextToPath past the budget: a pattern chain into an href cycle ends', (t) => {
  const cycle =
    '<pattern id="c" xlink:href="#a"/><pattern id="a" width="4" height="4" patternUnits="userSpaceOnUse" xlink:href="#b"/>' +
    '<pattern id="b" xlink:href="#a"><rect width="2" height="2" fill="red"/></pattern>'
  // Also as SVG2 href, which SkSVG now reads.
  for (const defs of [cycle, cycle.replaceAll('xlink:href', 'href')]) {
    const body = `<defs>${defs}</defs><rect width="5" height="5" fill="url(#c)"/>`
    const child = convertInChild(`<svg ${XLINK} width="10" height="10">${body}${fanOut(6)}</svg>`)
    t.is(child.signal, null, 'timed out')
    t.is(child.status, 0, child.stderr)
    t.is(child.stdout, convertSVGTextToPath(`<svg ${XLINK} width="10" height="10">${body}</svg>`).toString())
  }
})

// SkSVG walks a pattern's href chain only from a pattern a fill or stroke
// names: a cycle only c, never painted, runs into is kept, and b still takes
// its size from a (without it, b's paint fails and the rect is blue).
test('convertSVGTextToPath past the budget: a cycle no painted pattern runs into is kept', (t) => {
  const body =
    '<defs><pattern id="c" xlink:href="#a"/><pattern id="a" width="4" height="4" patternUnits="userSpaceOnUse" xlink:href="#b"/>' +
    '<pattern id="b" xlink:href="#a"><rect width="2" height="2" fill="red"/></pattern></defs><rect width="5" height="5" fill="url(#b) blue"/>'
  const under = convertSVGTextToPath(`<svg ${XLINK} width="10" height="10">${body}</svg>`).toString()
  t.false(under.includes('blue'))
  const child = convertInChild(`<svg ${XLINK} width="10" height="10">${body}${fanOut(6)}</svg>`)
  t.is(child.signal, null, 'timed out')
  t.is(child.status, 0, child.stderr)
  t.is(child.stdout, under)
})

// SkSVG reads only xlink:href: SVG2 href (it wins over xlink:href) and an
// XLink href under another prefix are renamed.
test('convertSVGTextToPath past the budget: SVG2 href draws', (t) => {
  const body =
    '<rect id="r" width="3" height="3" fill="red"/><rect id="s" width="3" height="3" fill="blue"/>' +
    '<use href="#r" x="5"/><use href="#r" xlink:href="#s" y="5"/>' +
    '<use xmlns:l="http://www.w3.org/1999/xlink" l:href="#s" x="5" y="5"/>' +
    '<linearGradient id="g"><stop offset="0" stop-color="green"/></linearGradient>' +
    '<linearGradient id="h" href="#g"/><rect x="10" width="3" height="3" fill="url(#h)"/>'
  const under = convertSVGTextToPath(`<svg ${XLINK} width="20" height="10">${body}</svg>`).toString()
  t.is(under.match(/<rect/g)?.length, 6)
  const past = convertSVGTextToPath(`<svg ${XLINK} width="20" height="10">${body}${fanOut(6)}</svg>`)
  t.is(past.toString(), under)
})

// The renames are made only while SkSVG's added work stays small: an 8^10
// fan-out through SVG2 href stays unread, as before, and the pattern cycle
// is still broken.
test('convertSVGTextToPath past the budget: an SVG2 href fan-out too big for SkSVG stays unread', (t) => {
  const body =
    '<defs><pattern id="c" xlink:href="#a"/><pattern id="a" width="4" height="4" patternUnits="userSpaceOnUse" xlink:href="#a">' +
    '<rect width="2" height="2" fill="red"/></pattern></defs><rect width="5" height="5" fill="url(#c)"/>'
  const child = convertInChild(`<svg ${XLINK} width="10" height="10">${fanOut(10)}${body}</svg>`)
  t.is(child.signal, null, 'timed out')
  t.is(child.status, 0, child.stderr)
  t.is(child.stdout, convertSVGTextToPath(`<svg ${XLINK} width="10" height="10">${body}</svg>`).toString())
})

// The work guard counts every url(#id) in any value, as SkSVG may follow
// it: one SkSVG does not parse keeps url(#p) or url(#big), which draw an
// 8^10 fan-out through SVG2 href, so the renames are not made and the
// fan-out stays unread.
test('convertSVGTextToPath past the budget: a value SkSVG does not parse keeps the reference before it', (t) => {
  const defs =
    fanOutDefs(10, 'm') +
    '<defs><pattern id="p" width="1" height="1"><use href="#m10"/></pattern>' +
    '<clipPath id="big"><use href="#m10"/></clipPath><clipPath id="small"><rect width="1" height="1"/></clipPath></defs>'
  for (const attrs of [
    'fill="url(#p)" style="fill:#invalid"',
    'fill="url(#p)" style="fill:rgb(nope)"',
    'fill="url(#p)" style="fill:url(#small) junk"',
    'clip-path="url(#big)" style="clip-path:url(#small) x"',
  ]) {
    const child = convertInChild(
      `<svg ${XLINK} width="10" height="10">${defs}<rect width="5" height="5" ${attrs}/>${fanOut(6)}</svg>`,
    )
    t.is(child.signal, null, `timed out: ${attrs}`)
    t.is(child.status, 0, child.stderr)
  }
})

// SkSVG follows a gradient's href while it has no <stop> child, whatever
// else it holds, one native call per link: a 50000-link chain of gradients
// holding a <g/> is too deep for the renames and stays unread.
test('convertSVGTextToPath past the budget: a long gradient href chain stays unread', (t) => {
  let defs = '<linearGradient id="g0"><stop offset="0" stop-color="green"/></linearGradient>'
  for (let i = 1; i < 50000; i++) {
    defs += `<linearGradient id="g${i}" href="#g${i - 1}"><g/></linearGradient>`
  }
  const child = convertInChild(
    `<svg ${XLINK} width="10" height="10">${fanOut(6)}<defs>${defs}</defs><rect width="5" height="5" fill="url(#g49999)"/></svg>`,
    true,
  )
  t.is(child.signal, null, 'crashed or timed out')
  t.is(child.status, 0, child.stderr)
})

// A group with a mask, filter or clip path walks the bounding box of all
// below it, <defs> too, following <use> there: under such a group a
// 50000-link <use href> chain (SIGSEGV when renamed) and an 8^11 <use href>
// fan-out (minutes) stay unread.
test('convertSVGTextToPath past the budget: SVG2 href under a bounding box walk stays unread', (t) => {
  let chain = '<g id="u0"/>'
  for (let i = 1; i < 50000; i++) {
    chain += `<use id="u${i}" href="#u${i - 1}"/>`
  }
  for (const defs of [`<defs>${chain}</defs>`, fanOutDefs(11, 'm')]) {
    const child = convertInChild(
      `<svg ${XLINK} width="10" height="10"><defs><mask id="k"><rect width="10" height="10" fill="white"/></mask></defs>` +
        `<g mask="url(#k)">${defs}<rect width="2" height="2"/></g>${fanOut(6)}</svg>`,
    )
    t.is(child.signal, null, 'crashed or timed out')
    t.is(child.status, 0, child.stderr)
    t.true(child.stdout.includes('<svg'))
  }
})

// SkSVG reads a nested style="style:fill:url(#c)": the pattern c it paints
// runs into the cycle a -> a, which is broken.
test('convertSVGTextToPath past the budget: a pattern a nested style paints is walked', (t) => {
  const body =
    '<defs><pattern id="c" href="#a"/><pattern id="a" href="#a" width="2" height="2"><rect width="1" height="1"/></pattern></defs>' +
    '<rect width="5" height="5" style="style:fill:url(#c)"/>'
  const child = convertInChild(`<svg ${XLINK} width="10" height="10">${body}${fanOut(6)}</svg>`)
  t.is(child.signal, null, 'timed out')
  t.is(child.status, 0, child.stderr)
  t.true(child.stdout.includes('<rect width="5" height="5"/>'))
})

// SkSVGPattern::resolveHref stops once x, y, width, height,
// patternTransform and the content are found: c's walk ends at a, so the
// cycle a <-> b is kept and b, also painted, keeps a's size (cut, b's paint
// fails and the rect is blue).
test('convertSVGTextToPath past the budget: a cycle every walk leaves is kept', (t) => {
  const body =
    '<defs><pattern id="c" x="0" y="0" width="4" height="4" patternTransform="translate(0)" xlink:href="#a"><rect width="4" height="4" fill="green"/></pattern>' +
    '<pattern id="a" width="4" height="4" xlink:href="#b"/><pattern id="b" xlink:href="#a"><rect width="4" height="4" fill="red"/></pattern></defs>' +
    '<rect width="4" height="4" fill="url(#c)"/><rect x="5" width="4" height="4" fill="url(#b) blue"/>'
  const child = convertInChild(`<svg ${XLINK} width="10" height="10">${body}${fanOut(6)}</svg>`)
  t.is(child.signal, null, 'timed out')
  t.is(child.status, 0, child.stderr)
  t.false(child.stdout.includes('blue'))
  t.is(child.stdout.match(/<rect/g)?.length, 2)
})

// svg_doc reads a pattern or gradient href chain once per element (it read
// each chain from each element in it: 15 s for 10^4 links). 20000 links,
// as convertSVGTextToPath and as an SVG image.
test('a long pattern or gradient href chain is read in linear time', (t) => {
  const pattern = (i: number) =>
    i
      ? `<pattern id="p${i}" xlink:href="#p${i - 1}"/>`
      : '<pattern id="p0" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="green"/></pattern>'
  const gradient = (i: number) =>
    i
      ? `<linearGradient id="g${i}" xlink:href="#g${i - 1}"/>`
      : '<linearGradient id="g0"><stop offset="0" stop-color="green"/></linearGradient>'
  for (const [link, last] of [
    [pattern, 'p19999'],
    [gradient, 'g19999'],
  ] as const) {
    const defs = Array.from({ length: 20000 }, (_, i) => link(i)).join('')
    const svg = `<svg ${XLINK} width="10" height="10"><defs>${defs}</defs><rect width="10" height="10" fill="url(#${last})"/></svg>`
    const child = convertInChild(svg)
    t.is(child.signal, null, `timed out: ${last}`)
    t.is(child.status, 0, child.stderr)
    const image = imageInChild(svg)
    t.is(image.signal, null, `image timed out: ${last}`)
    t.is(image.stdout, 'ok', image.stderr)
  }
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
