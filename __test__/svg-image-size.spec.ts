import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, Image, type SKRSContext2D } from '../index'

// Chrome 155 values (arm64 == x64). An SVG Image has a natural size from CSS
// default sizing of its root against 300x150 (image_loader.cc
// DensityCorrectedNaturalSize), and drawImage and createPattern size it
// against the canvas (canvas_2d_recorder_context.cc drawImage, createPattern).

const DIR = dirname(fileURLToPath(import.meta.url))

function load(svg: string | Buffer) {
  const image = new Image()
  return new Promise<Image | null>((resolve) => {
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = Buffer.from(svg)
  })
}

async function loaded(svg: string | Buffer) {
  const image = await load(svg)
  if (!image) {
    throw new Error('the svg did not load')
  }
  return image
}

async function natural(svg: string) {
  const image = await load(svg)
  return image ? [image.naturalWidth, image.naturalHeight] : 'ERR'
}

const svg = (attributes: string, content: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${content}</svg>`

// A red rect over the whole viewport and a blue one over its top left 10%.
const R =
  '<rect x="0" y="0" width="100%" height="100%" fill="red"/><rect x="0" y="0" width="10%" height="10%" fill="blue"/>'

const roots: Record<string, string> = {
  none: '',
  vb11: 'viewBox="0 0 10 10"',
  vb21: 'viewBox="0 0 20 10"',
  vb12: 'viewBox="0 0 10 20"',
  pct: 'width="50%" height="50%" viewBox="0 0 10 10"',
  pctNoVb: 'width="50%" height="50%"',
  wOnlyVb: 'width="40" viewBox="0 0 10 20"',
  wOnly: 'width="40"',
  hOnly: 'height="30"',
  hOnlyVb: 'height="30" viewBox="0 0 20 10"',
  both: 'width="40" height="30"',
  bothVb: 'width="40" height="30" viewBox="0 0 10 10"',
  em: 'width="2em" height="1em"',
  mm: 'width="10mm" height="1in"',
  zero: 'width="0" height="0"',
  zeroVb: 'viewBox="0 0 0 0"',
  frac: 'width="10.6" height="20.4"',
  huge: 'viewBox="0 0 100000 1"',
}

const naturalSizes: Record<string, number[]> = {
  none: [300, 150],
  vb11: [150, 150],
  vb21: [300, 150],
  vb12: [75, 150],
  pct: [150, 150],
  pctNoVb: [300, 150],
  wOnlyVb: [40, 80],
  wOnly: [40, 150],
  hOnly: [300, 30],
  hOnlyVb: [60, 30],
  both: [40, 30],
  bothVb: [40, 30],
  em: [32, 16],
  mm: [38, 96],
  zero: [0, 0],
  zeroVb: [300, 150],
  frac: [11, 20],
  huge: [300, 0],
}

test('svg natural size follows CSS default sizing like Chrome', async (t) => {
  for (const [name, attributes] of Object.entries(roots)) {
    const image = await loaded(svg(attributes, R))
    t.deepEqual(
      [image.naturalWidth, image.naturalHeight, image.width, image.height],
      [...naturalSizes[name], ...naturalSizes[name]],
      name,
    )
  }
})

// It used to abort the process.
test('svg with a negative root width loads like Chrome', async (t) => {
  const image = await loaded(svg('width="-10" height="20" viewBox="0 0 10 10"', R))
  t.deepEqual([image.naturalWidth, image.naturalHeight], [0, 20])
  const ctx = createCanvas(50, 40).getContext('2d')
  ctx.drawImage(image, 0, 0)
  t.is(sample(ctx, 50, 40), 'ext 0x0 blue 0x0')
  t.is(ctx.createPattern(image, 'repeat'), null)
})

// SVGSVGElement::IntrinsicWidth: the width attribute as a CSS length at 96
// dpi with a 16px font; a percentage, `auto` or a value that does not parse
// leaves the width to the default (300).
const rootWidths: Record<string, number> = {
  '10pt': 13,
  '1pc': 16,
  '1cm': 38,
  auto: 300,
  ' 40 ': 40,
  '1e1': 10,
  '40px': 40,
  '40 px': 300,
  '+40': 40,
  '40.5': 41,
  '0.4': 0,
  '40%': 300,
  'calc(10px + 5px)': 15,
  '40q': 38,
  '1Q': 1,
  '40PX': 40,
  '': 300,
  abc: 300,
  '-0': 0,
  '1vw': 0,
  '2rem': 32,
  'calc(50% + 10px)': 15,
  'calc(2 * 10px)': 20,
  'calc(10px * 2 + 1em)': 36,
  'min(10px, 20px)': 10,
  'max(10px, 20px)': 20,
  'clamp(5px, 50px, 30px)': 30,
  '1e1px': 10,
  '.5e2': 50,
  '40e': 300,
  '\t40\n': 40,
  '40px;': 300,
  inherit: 300,
  '1x': 300,
  'calc(1in)': 96,
  'calc(1in + 1%)': 97,
  '1E1': 10,
  '1e+1': 10,
  '1e-1': 0,
  '0x10': 300,
  '1.': 300,
  '.5': 1,
  '40.5px': 41,
  'calc(40.5px)': 41,
  '1mm': 4,
  '1pt': 1,
  '2.5pc': 40,
  'CALC(10px)': 10,
  '1ic': 16,
  '1cqw': 0,
  'calc(10)': 10,
  'calc(10px / 4)': 3,
  'calc((10px + 2px) * 2)': 24,
  '1vh': 0,
  '1vmin': 0,
  '1dvw': 0,
  '10px 10px': 300,
  'calc(1px*3)': 3,
  'calc(1px +2px)': 300,
  '1e1.5': 300,
  '20e-1px': 2,
  '1in ': 96,
  ' 1in': 96,
  '99999999': 33554428,
  '1e10': 33554428,
  'calc(infinity * 1px)': 33554432,
  'calc(-10px)': 0,
  '-5px': 0,
  'calc(0.5px)': 1,
  '0.5': 1,
  '0.49': 0,
  '1.5': 2,
  '2.5': 3,
  'calc(100%)': 300,
  'calc(100% + 0px)': 0,
  'calc(50% + 20px)': 30,
  'calc(10% + 100px)': 110,
  'calc(100% + 1px)': 2,
  'calc(100% - 10px)': 0,
  'calc(200% + 0px)': 0,
  'calc(50%)': 300,
  'min(50%, 10px)': 0,
  'calc(1% + 200px)': 202,
}

test('svg root lengths like Chrome', async (t) => {
  for (const [value, width] of Object.entries(rootWidths)) {
    t.deepEqual(await natural(svg(`width="${value}" height="20"`, R)), [width, 20], JSON.stringify(value))
  }
})

// ex, ch, lh and cap come from Chrome's default font at 16px: Times on macOS.
test('svg root font-relative lengths like Chrome on macOS', async (t) => {
  const widths: Record<string, number> = {
    '2ex': 14,
    '1ex': 7,
    '3ex': 22,
    '1rex': 7,
    '2ch': 16,
    '1ch': 8,
    '1rch': 8,
    '1lh': 18,
    '1rlh': 18,
    '1cap': 11,
    '100ex': 718,
    '1000ex': 7180,
    '100ch': 800,
    '100cap': 1059,
    '1000cap': 10586,
    '100lh': 1800,
    '100ic': 1600,
    '100rex': 718,
    '100rch': 800,
    '100rlh': 1800,
    '100rcap': 1059,
    '100ric': 1600,
  }
  for (const [value, width] of Object.entries(widths)) {
    const [got] = (await natural(svg(`width="${value}" height="20"`, R))) as number[]
    if (process.platform === 'darwin') {
      t.is(got, width, value)
    } else {
      // Another default font: about the same size.
      t.true(Math.abs(got - width) <= width / 5 + 1, `${value}: ${got}`)
    }
  }
})

test('svg preserveAspectRatio and viewBox parsing like Chrome', async (t) => {
  const cases: Record<string, number[]> = {
    'viewBox="0 0 10 20" preserveAspectRatio="none"': [300, 150],
    'width="40" viewBox="0 0 10 20" preserveAspectRatio="none"': [300, 150],
    'width="40" height="30" preserveAspectRatio="none"': [40, 30],
    'viewBox="0 0 10 20" preserveAspectRatio=" none "': [300, 150],
    'viewBox="0 0 10 20" preserveAspectRatio="defer none"': [75, 150],
    'viewBox="0 0 10 20" preserveAspectRatio="NONE"': [75, 150],
    'viewBox="0 0 10 20" preserveAspectRatio="none slice"': [300, 150],
    'viewBox="0 0 10 20" preserveAspectRatio="xMidYMid"': [75, 150],
    'viewBox="0 0 10 20" preserveAspectRatio="bogus"': [75, 150],
    'height="30" viewBox="0 0 10 20" preserveAspectRatio="none"': [300, 150],
    'viewBox="0,0,10,20"': [75, 150],
    'viewBox="0 0 10 20 5"': [300, 150],
    'viewBox="0 0 -10 20"': [300, 150],
    'viewBox="0 0 10"': [300, 150],
    'viewBox="0 0 10 20,"': [300, 150],
    'viewBox="0, 0, 10, 20"': [75, 150],
    'viewBox="0 0 1e1 2e1"': [75, 150],
    'viewBox="0 0 10px 20"': [300, 150],
    'viewBox="  0 0 10 20  "': [75, 150],
    'viewBox="0 0 0 20"': [300, 150],
    'viewBox="0 0 10 0"': [300, 150],
    'viewBox="0 0 10 -1"': [300, 150],
    'viewBox="-5 -5 10 20"': [75, 150],
    'viewBox="0 0 10,20"': [75, 150],
    'viewBox="0\t0\n10 20"': [75, 150],
    'viewBox="0 0 .1e2 20"': [75, 150],
    'viewBox="0 0 10 20x"': [300, 150],
    'viewBox="0 0 1e40 1"': [300, 150],
    'viewBox="0 0 10 20 ,"': [300, 150],
    'viewBox="0,,0,10,20"': [300, 150],
    'viewBox=",0 0 10 20"': [300, 150],
    'viewBox="0 0 10 +20"': [75, 150],
    'viewBox="0 0 10. 20"': [300, 150],
    'viewBox="0 0 10 20e"': [300, 150],
    'viewBox="0 0 1e-50 1"': [300, 150],
    'viewBox="none"': [300, 150],
    'width="40" viewBox="0 0 0 20"': [40, 150],
    'width="0" height="0" viewBox="0 0 10 20"': [0, 0],
    'width="0" viewBox="0 0 10 20"': [0, 0],
    'height="0" viewBox="0 0 10 20"': [0, 0],
    'width="40" height="0" viewBox="0 0 10 20"': [40, 0],
    'width="40" height="20" style="width:10px"': [40, 20],
  }
  for (const [attributes, size] of Object.entries(cases)) {
    t.deepEqual(await natural(svg(attributes, R)), size, attributes)
  }
})

// The extent of what is drawn (alpha > 127) on row 0 and column 0, and of
// the blue rect, as `ext WxH blue WxH`.
function sample(ctx: SKRSContext2D, W: number, H: number) {
  const d = ctx.getImageData(0, 0, W, H).data
  let ex = -1
  let ey = -1
  let bx = -1
  let by = -1
  for (let x = 0; x < W; x++) {
    if (d[x * 4 + 3] > 127) ex = x
    if (d[x * 4 + 2] > 127 && d[x * 4 + 3] > 127) bx = x
  }
  for (let y = 0; y < H; y++) {
    if (d[y * W * 4 + 3] > 127) ey = y
    if (d[y * W * 4 + 2] > 127 && d[y * W * 4 + 3] > 127) by = y
  }
  return `ext ${ex + 1}x${ey + 1} blue ${bx + 1}x${by + 1}`
}

// Where the blue rects start on row 0 and column 0 of a pattern drawn at
// half size.
function patternStarts(ctx: SKRSContext2D, W: number, H: number) {
  const d = ctx.getImageData(0, 0, W, H).data
  const blue = (i: number) => d[i + 2] > 127 && d[i] < 128
  const xs = []
  for (let x = 1; x < W; x++) if (blue(x * 4) && !blue((x - 1) * 4)) xs.push(x)
  const ys = []
  for (let y = 1; y < H; y++) if (blue(y * W * 4) && !blue((y - 1) * W * 4)) ys.push(y)
  return `blue starts x=${xs.join('|')} y=${ys.join('|')}`
}

// drawImage(image, 0, 0) and drawImage(image, 0, 0, 20, 20) on a 50x40 and
// a 400x300 canvas.
const draws: Record<string, [string, string, string, string]> = {
  none: ['ext 50x40 blue 5x4', 'ext 20x20 blue 2x2', 'ext 400x300 blue 40x30', 'ext 20x20 blue 2x2'],
  vb11: ['ext 40x40 blue 4x4', 'ext 20x20 blue 2x2', 'ext 300x300 blue 30x30', 'ext 20x20 blue 2x2'],
  vb21: ['ext 50x25 blue 5x3', 'ext 20x20 blue 2x2', 'ext 400x200 blue 40x20', 'ext 20x20 blue 2x2'],
  vb12: ['ext 20x40 blue 2x4', 'ext 20x20 blue 2x2', 'ext 150x300 blue 15x30', 'ext 20x20 blue 2x2'],
  pct: ['ext 40x40 blue 4x4', 'ext 20x20 blue 2x2', 'ext 300x300 blue 30x30', 'ext 20x20 blue 2x2'],
  pctNoVb: ['ext 50x40 blue 5x4', 'ext 20x20 blue 2x2', 'ext 400x300 blue 40x30', 'ext 20x20 blue 2x2'],
  wOnlyVb: ['ext 40x40 blue 4x8', 'ext 20x20 blue 2x2', 'ext 40x80 blue 4x8', 'ext 20x20 blue 2x2'],
  wOnly: ['ext 40x40 blue 4x4', 'ext 20x20 blue 2x2', 'ext 40x300 blue 4x30', 'ext 20x20 blue 2x2'],
  hOnly: ['ext 50x30 blue 5x3', 'ext 20x20 blue 2x2', 'ext 400x30 blue 40x3', 'ext 20x20 blue 2x2'],
  hOnlyVb: ['ext 50x30 blue 6x3', 'ext 20x20 blue 2x2', 'ext 60x30 blue 6x3', 'ext 20x20 blue 2x2'],
  both: ['ext 40x30 blue 4x3', 'ext 20x20 blue 2x2', 'ext 40x30 blue 4x3', 'ext 20x20 blue 2x2'],
  bothVb: ['ext 35x0 blue 8x0', 'ext 18x0 blue 4x0', 'ext 35x0 blue 8x0', 'ext 18x0 blue 4x0'],
  em: ['ext 32x16 blue 3x2', 'ext 20x20 blue 2x2', 'ext 32x16 blue 3x2', 'ext 20x20 blue 2x2'],
  mm: ['ext 38x40 blue 4x10', 'ext 20x20 blue 2x2', 'ext 38x96 blue 4x10', 'ext 20x20 blue 2x2'],
  zero: ['ext 0x0 blue 0x0', 'ext 0x0 blue 0x0', 'ext 0x0 blue 0x0', 'ext 0x0 blue 0x0'],
  zeroVb: ['ext 0x0 blue 0x0', 'ext 0x0 blue 0x0', 'ext 0x0 blue 0x0', 'ext 0x0 blue 0x0'],
  frac: ['ext 10x20 blue 1x2', 'ext 20x20 blue 2x2', 'ext 10x20 blue 1x2', 'ext 20x20 blue 2x2'],
  huge: ['ext 0x0 blue 0x0', 'ext 0x0 blue 0x0', 'ext 0x0 blue 0x0', 'ext 0x0 blue 0x0'],
}

test('drawImage of an svg uses the canvas as the default object size', async (t) => {
  for (const [name, attributes] of Object.entries(roots)) {
    const image = await loaded(svg(attributes, R))
    const got = []
    for (const [W, H] of [
      [50, 40],
      [400, 300],
    ]) {
      const ctx = createCanvas(W, H).getContext('2d')
      ctx.drawImage(image, 0, 0)
      got.push(sample(ctx, W, H))
      const ctx5 = createCanvas(W, H).getContext('2d')
      ctx5.drawImage(image, 0, 0, 20, 20)
      got.push(sample(ctx5, W, H))
    }
    t.deepEqual(got, draws[name], name)
  }
})

const patterns: Record<string, [string, string]> = {
  none: ['blue starts x=25 y=20', 'blue starts x=200 y=150'],
  vb11: ['blue starts x=20|40 y=20', 'blue starts x=150|300 y=150'],
  vb21: ['blue starts x=25 y=13|25|38', 'blue starts x=200 y=100|200'],
  vb12: ['blue starts x=10|20|30|40 y=20', 'blue starts x=75|150|225|300|375 y=150'],
  both: [
    'blue starts x=20|40 y=15|30',
    'blue starts x=20|40|60|80|100|120|140|160|180|200|220|240|260|280|300|320|340|360|380 y=15|30|45|60|75|90|105|120|135|150|165|180|195|210|225|240|255|270|285',
  ],
  frac: [
    'blue starts x=11|22|33|44 y=10|20|30',
    'blue starts x=11|22|33|44|55|66|77|88|99|110|121|132|143|154|165|176|187|198|209|220|231|242|253|264|275|286|297|308|319|330|341|352|363|374|385|396 y=10|20|30|40|50|60|70|80|90|100|110|120|130|140|150|160|170|180|190|200|210|220|230|240|250|260|270|280|290',
  ],
  zeroVb: ['blue starts x= y=', 'blue starts x= y='],
}

test('createPattern of an svg tiles at the concrete size', async (t) => {
  for (const [name, expected] of Object.entries(patterns)) {
    const image = await loaded(svg(roots[name], R))
    const got = []
    for (const [W, H] of [
      [50, 40],
      [400, 300],
    ]) {
      const ctx = createCanvas(W, H).getContext('2d')
      const pattern = ctx.createPattern(image, 'repeat')
      t.not(pattern, null, name)
      ctx.setTransform(0.5, 0, 0, 0.5, 0, 0)
      ctx.fillStyle = pattern!
      ctx.fillRect(0, 0, W * 2, H * 2)
      got.push(patternStarts(ctx, W, H))
    }
    t.deepEqual(got, expected, name)
  }
  for (const name of ['zero', 'huge']) {
    const image = await loaded(svg(roots[name], R))
    t.is(createCanvas(50, 40).getContext('2d').createPattern(image, 'repeat'), null, name)
  }
})

// A viewBox 10x10 with the left half red and the right half blue.
const halves =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="10" fill="red"/><rect x="5" width="5" height="10" fill="blue"/></svg>'

function extent(ctx: SKRSContext2D, W: number, H: number) {
  const d = ctx.getImageData(0, 0, W, H).data
  let mx = -1
  let my = -1
  let red = 0
  let blue = 0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (d[i + 3] > 127) {
        mx = Math.max(mx, x)
        my = Math.max(my, y)
        if (d[i] > 127) red++
        if (d[i + 2] > 127) blue++
      }
    }
  return { ext: [mx + 1, my + 1], red, blue }
}

test('drawImage source rect of an svg is in concrete-size units', async (t) => {
  const image = await loaded(halves)
  t.deepEqual([image.naturalWidth, image.naturalHeight], [150, 150])
  const ctx = createCanvas(400, 300).getContext('2d')
  // The concrete size is 300x300, so 150x150 is the red half.
  ctx.drawImage(image, 0, 0, 150, 150, 0, 0, 100, 100)
  t.deepEqual(extent(ctx, 400, 300), { ext: [100, 100], red: 10000, blue: 0 })
  for (const [W, H] of [
    [400, 300],
    [50, 40],
  ]) {
    const ctx5 = createCanvas(W, H).getContext('2d')
    ctx5.drawImage(image, 0, 0, 20, 20)
    t.deepEqual(extent(ctx5, W, H), { ext: [20, 20], red: 200, blue: 200 }, `5 arguments on ${W}x${H}`)
  }
  const ctx3 = createCanvas(400, 300).getContext('2d')
  ctx3.drawImage(image, 10, 5)
  t.deepEqual(extent(ctx3, 400, 300), { ext: [310, 300], red: 44250, blue: 44250 })
  const small = createCanvas(50, 40).getContext('2d')
  small.drawImage(image, 10, 5)
  t.deepEqual(extent(small, 50, 40), { ext: [50, 40], red: 700, blue: 700 })
})

// The 150x150 source is cut to the 40x40 concrete size and the destination
// with it, to 26.67x26.67. The right and bottom edges are anti-aliased by
// both the shape and the view clip, so the last column has alpha 113 and the
// last row 128: the extent is 26x27.
test('drawImage source rect of an svg cut to the concrete size like Chrome', async (t) => {
  const image = await loaded(halves)
  const ctx = createCanvas(50, 40).getContext('2d')
  ctx.drawImage(image, 0, 0, 150, 150, 0, 0, 100, 100)
  t.deepEqual(extent(ctx, 50, 40), { ext: [26, 27], red: 351, blue: 350 })
  const d = ctx.getImageData(0, 0, 50, 40).data
  t.deepEqual([d[(5 * 50 + 26) * 4 + 3], d[(26 * 50 + 5) * 4 + 3], d[(26 * 50 + 26) * 4 + 3]], [113, 128, 57])
})

test('drawImage of an svg follows the current canvas size', async (t) => {
  const image = await loaded(halves)
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  t.deepEqual(extent(ctx, 100, 100), { ext: [100, 100], red: 5000, blue: 5000 })
  canvas.width = 60
  canvas.height = 200
  ctx.drawImage(image, 0, 0)
  t.deepEqual(extent(ctx, 60, 200), { ext: [60, 60], red: 1800, blue: 1800 })
  const patternCtx = createCanvas(400, 300).getContext('2d')
  patternCtx.fillStyle = patternCtx.createPattern(image, 'no-repeat')!
  patternCtx.fillRect(0, 0, 400, 300)
  t.deepEqual(extent(patternCtx, 400, 300), { ext: [300, 300], red: 45000, blue: 45000 })
})

// Chrome draws an SVG as vectors: under a transform it is as sharp as when
// drawn at that size.
const circle =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4.3" fill="#08f"/><rect x="1" y="1" width="2.5" height="1.3" fill="#f00"/></svg>'

function alphaSum(data: Uint8ClampedArray) {
  let sum = 0
  for (let i = 3; i < data.length; i += 4) sum += data[i]
  return sum
}

test('drawImage of an svg is drawn at the size it lands at like Chrome', async (t) => {
  const image = await loaded(circle)
  const draw = (setup: (ctx: SKRSContext2D) => void, args: number[]) => {
    const ctx = createCanvas(100, 100).getContext('2d')
    setup(ctx)
    // @ts-expect-error spread of drawImage arguments
    ctx.drawImage(image, ...args)
    return ctx.getImageData(0, 0, 100, 100).data
  }
  const scaled = draw((ctx) => ctx.scale(4, 4), [0, 0, 20, 20])
  const direct = draw(() => {}, [0, 0, 80, 80])
  t.deepEqual(scaled, direct)
  t.is(alphaSum(direct), 971940)
  const huge = draw(() => {}, [-5000, -5000, 10100, 10100])
  t.deepEqual(Array.from(huge.slice((50 * 100 + 50) * 4, (50 * 100 + 50) * 4 + 4)), [0, 136, 255, 255])
  t.is(alphaSum(huge), 2550000)
  const part = draw(() => {}, [25, 25, 50, 50, 0, 0, 100, 100])
  t.is(alphaSum(part), 2550000)
  t.deepEqual(Array.from(part.slice(0, 4)), [0, 136, 255, 255])
})

// A draw bigger than 4096x4096 device pixels rasters only the part of the
// SVG near the canvas. That part must hold every pixel the shadow and
// ctx.filter read: Chrome draws their output from content far off the
// canvas. 300x150 canvas, 6000x6000 SVGs with one green rect; the expected
// values were measured in Chrome 155. Each row: the rect, where the image is
// drawn, the state, then the painted RGB, the number of painted pixels, the
// alpha sum, the alpha at x = 0, 50, 99, 100, 150, 200, 299 on y = 75, and
// the alpha at (150, 99) and (150, 100).
const offCanvas: [
  string,
  number[],
  number[],
  (ctx: SKRSContext2D) => void,
  number[],
  number,
  number,
  number[],
  number[],
][] = [
  // The green ends at device x = -300.
  [
    'shadowOffsetX 400',
    [0, 0, 5700, 6000],
    [-6000, -3000],
    (ctx) => {
      ctx.shadowColor = 'blue'
      ctx.shadowOffsetX = 400
    },
    [0, 0, 255],
    15000,
    3825000,
    [255, 255, 255, 0, 0, 0, 0],
    [0, 0],
  ],
  [
    'shadowOffsetY 400',
    [0, 0, 6000, 5700],
    [-3000, -6000],
    (ctx) => {
      ctx.shadowColor = 'blue'
      ctx.shadowOffsetY = 400
    },
    [0, 0, 255],
    30000,
    7650000,
    [255, 255, 255, 255, 255, 255, 255],
    [255, 0],
  ],
  [
    'shadowBlur 400',
    [0, 0, 5700, 6000],
    [-6000, -3000],
    (ctx) => {
      ctx.shadowColor = 'blue'
      ctx.shadowBlur = 400
    },
    [0, 0, 255],
    27000,
    146100,
    [15, 8, 4, 4, 1, 0, 0],
    [1, 1],
  ],
  [
    'shadowOffsetX 300 and shadowBlur 100',
    [0, 0, 5700, 6000],
    [-6000, -3000],
    (ctx) => {
      ctx.shadowColor = 'blue'
      ctx.shadowOffsetX = 300
      ctx.shadowBlur = 100
    },
    [0, 0, 255],
    18000,
    732000,
    [126, 38, 4, 3, 0, 0, 0],
    [0, 0],
  ],
  [
    'blur(200px)',
    [0, 0, 5700, 6000],
    [-6000, -3000],
    (ctx) => {
      ctx.filter = 'blur(200px)'
    },
    [0, 255, 0],
    26850,
    144150,
    [15, 8, 4, 3, 1, 0, 0],
    [1, 1],
  ],
  [
    'drop-shadow(400px 0 0 red)',
    [0, 0, 5700, 6000],
    [-6000, -3000],
    (ctx) => {
      ctx.filter = 'drop-shadow(400px 0 0 red)'
    },
    [255, 0, 0],
    15000,
    3825000,
    [255, 255, 255, 0, 0, 0, 0],
    [0, 0],
  ],
  [
    'blur(50px) and shadowOffsetX 400',
    [0, 0, 5700, 6000],
    [-6000, -3000],
    (ctx) => {
      ctx.filter = 'blur(50px)'
      ctx.shadowColor = 'blue'
      ctx.shadowOffsetX = 400
    },
    [0, 0, 255],
    33000,
    3830850,
    [251, 216, 129, 126, 38, 3, 0],
    [38, 38],
  ],
  // The green ends at device x = 50.
  [
    'blur(200px) on the edge',
    [0, 0, 6000, 6000],
    [-5950, -3000],
    (ctx) => {
      ctx.filter = 'blur(200px)'
    },
    [0, 255, 0],
    45000,
    3670200,
    [152, 127, 102, 101, 78, 56, 25],
    [78, 78],
  ],
  // The green starts at device x = 600.
  [
    'shadowOffsetX -400',
    [300, 0, 5700, 6000],
    [300, -3000],
    (ctx) => {
      ctx.shadowColor = 'blue'
      ctx.shadowOffsetX = -400
    },
    [0, 0, 255],
    15000,
    3825000,
    [0, 0, 0, 0, 0, 255, 255],
    [0, 0],
  ],
]

test('a large svg draw keeps the source its shadow and filter read, like Chrome', async (t) => {
  for (const [name, rect, at, setup, rgb, painted, sumA, row, column] of offCanvas) {
    const image = await loaded(
      svg(
        'width="6000" height="6000"',
        `<rect x="${rect[0]}" y="${rect[1]}" width="${rect[2]}" height="${rect[3]}" fill="#00ff00"/>`,
      ),
    )
    const ctx = createCanvas(300, 150).getContext('2d')
    setup(ctx)
    ctx.drawImage(image, at[0], at[1])
    const d = ctx.getImageData(0, 0, 300, 150).data
    let count = 0
    const colors = new Set<string>()
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]) {
        count++
        colors.add(`${d[i]},${d[i + 1]},${d[i + 2]}`)
      }
    }
    const alpha = (x: number, y: number) => d[(y * 300 + x) * 4 + 3]
    t.deepEqual(
      {
        colors: [...colors],
        painted: count,
        sumA: alphaSum(d),
        row: [0, 50, 99, 100, 150, 200, 299].map((x) => alpha(x, 75)),
        column: [alpha(150, 99), alpha(150, 100)],
      },
      { colors: [rgb.join()], painted, sumA, row, column },
      name,
    )
  }
  // A 100x100 SVG drawn 6000x6000 is rastered at the size it lands at.
  const icon = await loaded(svg('width="100" height="100"', '<rect width="95" height="100" fill="#00ff00"/>'))
  const ctx = createCanvas(300, 150).getContext('2d')
  ctx.shadowColor = 'blue'
  ctx.shadowOffsetX = 400
  ctx.drawImage(icon, -6000, -3000, 6000, 6000)
  const d = ctx.getImageData(0, 0, 300, 150).data
  t.is(alphaSum(d), 3825000)
  t.deepEqual(
    [99, 100].map((x) => Array.from(d.slice((75 * 300 + x) * 4, (75 * 300 + x) * 4 + 4))),
    [
      [0, 0, 255, 255],
      [0, 0, 0, 0],
    ],
  )
})

// Rotated or skewed, a draw bigger than 4096x4096 device pixels still
// rasters the SVG at the device scale, only the part near the canvas. Shrunk
// to fit 4096x4096 and drawn larger, a hard edge spread over three pixels.
// 300x150 canvas, a 6000x6000 SVG with one green rect; each row of a case:
// y, the first x, then the alpha from there, measured in Chrome 155. Chrome
// draws the vectors through the transform; a raster drawn through it moves
// an edge pixel by up to 15 (as the draws of smaller SVGs do).
const transformed: [string, number, number, (ctx: SKRSContext2D) => void, [number, number, number[]][]][] = [
  // The green ends at x = -300 in user space; its shadow lands at about 100.
  [
    'rotate(0.05) and shadowOffsetX 400',
    5700,
    -6000,
    (ctx) => {
      ctx.rotate(0.05)
      ctx.shadowColor = 'blue'
      ctx.shadowOffsetX = 400
    },
    [
      [0, 97, [255, 255, 152, 0, 0]],
      [75, 93, [255, 255, 216, 0, 0]],
      [149, 90, [255, 255, 40, 0, 0]],
    ],
  ],
  [
    'rotate(0.3) and shadowOffsetX 400',
    5700,
    -6000,
    (ctx) => {
      ctx.rotate(0.3)
      ctx.shadowColor = 'blue'
      ctx.shadowOffsetX = 400
    },
    [
      [0, 83, [255, 255, 216, 0, 0]],
      [75, 60, [255, 255, 152, 0, 0]],
      [149, 37, [255, 255, 184, 0, 0]],
    ],
  ],
  // The green ends at x = 100 in user space.
  [
    'rotate(0.05)',
    5700,
    -5600,
    (ctx) => ctx.rotate(0.05),
    [
      [0, 98, [255, 255, 24, 0, 0]],
      [75, 94, [255, 255, 88, 0, 0]],
      [149, 90, [255, 255, 168, 0, 0]],
    ],
  ],
  [
    'setTransform(1, 0.05, 0, 1, 0, 0) and shadowOffsetX 400',
    5700,
    -6000,
    (ctx) => {
      ctx.setTransform(1, 0.05, 0, 1, 0, 0)
      ctx.shadowColor = 'blue'
      ctx.shadowOffsetX = 400
    },
    [
      [0, 98, [255, 255, 0, 0, 0]],
      [75, 98, [255, 255, 0, 0, 0]],
      [149, 98, [255, 255, 0, 0, 0]],
    ],
  ],
]

test('a large rotated or skewed svg draw keeps its edges sharp like Chrome', async (t) => {
  for (const [name, width, x, setup, rows] of transformed) {
    const image = await loaded(
      svg('width="6000" height="6000"', `<rect width="${width}" height="6000" fill="#00ff00"/>`),
    )
    const ctx = createCanvas(300, 150).getContext('2d')
    setup(ctx)
    ctx.drawImage(image, x, -3000)
    const d = ctx.getImageData(0, 0, 300, 150).data
    for (const [y, x0, chrome] of rows) {
      const alpha = chrome.map((_, i) => d[(y * 300 + x0 + i) * 4 + 3])
      t.true(
        alpha.every((a, i) => Math.abs(a - chrome[i]) <= 15),
        `${name}, y = ${y}: ${alpha} (Chrome ${chrome})`,
      )
    }
  }
})

// Under a skew that keeps the columns of the image vertical, a lean of up to
// 0.3 or |a| and |d| both at least one device pixel rasters it at the column
// spacing, which keeps vertical edges on device pixels; a bigger lean with
// |a| or |d| under one pixel rasters it in device pixels through the whole
// transform, where Skia draws a stroke at most one pixel wide on both axes as
// a hairline of that coverage, as in Chrome. 300x150 canvas, a 1000x1000 SVG
// with a vertical <line> at x = 510.5, its center drawn at the canvas center;
// the alpha at x = 150..161 of rows 0, 75 and 149 (the same on each),
// measured in Chrome 155: each alpha within the tolerance of Chrome's and,
// with one, their sum within 20. The <line> has fill="none", which Chrome
// draws the same: SkSVG also fills a <line> as a one pixel hairline, which
// Chrome does not, and that makes these lines up to 66 darker.
const skewedLines: [string, [number, number, number, number], number, number[], number][] = [
  ['setTransform(1, 0.3, 0, 1, 0, 0), width 1.5', [1, 0.3, 0, 1], 1.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 64, 255, 64], 0],
  ['setTransform(1, 1, 0, 1, 0, 0), width 1', [1, 1, 0, 1], 1, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0], 0],
  [
    'setTransform(0.6, 0.4, 0, 0.9, 0, 0), width 1.5',
    [0.6, 0.4, 0, 0.9],
    1.5,
    [0, 0, 0, 0, 0, 39, 191, 0, 0, 0, 0, 0],
    32,
  ],
  ['setTransform(0.6, 0.4, 0, 0.9, 0, 0), width 1', [0.6, 0.4, 0, 0.9], 1, [0, 0, 0, 0, 0, 43, 172, 0, 0, 0, 0, 0], 32],
]

test('a skewed svg draw keeps thin lines about as dark as Chrome', async (t) => {
  for (const [name, [a, b, c, d], width, chrome, tolerance] of skewedLines) {
    const image = await loaded(
      svg(
        'width="1000" height="1000"',
        `<line x1="510.5" y1="100" x2="510.5" y2="900" fill="none" stroke="#000" stroke-width="${width}"/>`,
      ),
    )
    const ctx = createCanvas(300, 150).getContext('2d')
    ctx.setTransform(a, b, c, d, 0, 0)
    const det = a * d - b * c
    ctx.drawImage(image, (d * 150 - c * 75) / det - 500, (a * 75 - b * 150) / det - 500)
    const data = ctx.getImageData(0, 0, 300, 150).data
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
    const sumTolerance = tolerance ? 20 : 0
    for (const y of [0, 75, 149]) {
      const alpha = chrome.map((_, i) => data[(y * 300 + 150 + i) * 4 + 3])
      t.true(
        alpha.every((value, i) => Math.abs(value - chrome[i]) <= tolerance) &&
          Math.abs(sum(alpha) - sum(chrome)) <= sumTolerance,
        `${name}, y = ${y}: ${alpha} (Chrome ${chrome})`,
      )
    }
  }
})

// The same for rows: under setTransform(1, 0, 0.8, 1, 0, 0) the rows of the
// image stay one device pixel apart, and a raster at that spacing keeps a
// horizontal edge on a device row. 300x150 canvas, a 1000x1000 SVG with a few
// shapes, its center drawn at the canvas center; the alpha above and below
// the top edge of its rect, y = 114 and 115 at x = 110..160, measured in
// Chrome 155.
test('a heavily skewed svg draw keeps horizontal edges on device rows like Chrome', async (t) => {
  const image = await loaded(
    svg(
      'width="1000" height="1000"',
      '<circle cx="380" cy="460" r="40" fill="#ff0000"/>' +
        '<circle cx="500" cy="520" r="25.5" fill="#0000ff"/>' +
        '<polygon points="560,420 680,470 600,580" fill="#00ff00"/>' +
        '<path d="M320 590 L680 410" stroke="#000000" stroke-width="2"/>' +
        '<rect x="420" y="540" width="60" height="40" fill="#ff8800"/>',
    ),
  )
  const ctx = createCanvas(300, 150).getContext('2d')
  ctx.setTransform(1, 0, 0.8, 1, 0, 0)
  ctx.drawImage(image, -410, -425)
  const data = ctx.getImageData(0, 0, 300, 150).data
  for (const [y, chrome] of [
    [114, 0],
    [115, 255],
  ]) {
    const alpha = Array.from({ length: 51 }, (_, i) => data[(y * 300 + 110 + i) * 4 + 3])
    t.true(
      alpha.every((value) => value === chrome),
      `y = ${y}: ${alpha} (Chrome ${chrome} at each)`,
    )
  }
})

// A column spacing of at least one pixel with rows under one pixel apart
// rasters in device pixels too: under setTransform(2, 1.5, 0, 0.5, 0, 0) a
// raster at the spacing (2 by 0.5 pixels per unit) draws a 0.5 wide stroke as
// a hairline, 79 and 80 where Chrome draws 128 and 128. 300x150 canvas, a
// 1000x1000 SVG with a vertical <path> at x = 510.5, its center drawn at the
// canvas center; the alpha at x = 165..176 of rows 0, 75 and 149 (the same on
// each), measured in Chrome 155: each within 24 of Chrome's and their sum
// within 10.
test('a heavily skewed svg draw with rows under one pixel apart keeps a thin stroke like Chrome', async (t) => {
  const image = await loaded(
    svg('width="1000" height="1000"', '<path d="M510.5 100 V900" stroke="#000" stroke-width="0.5"/>'),
  )
  const ctx = createCanvas(300, 150).getContext('2d')
  ctx.setTransform(2, 1.5, 0, 0.5, 0, 0)
  ctx.drawImage(image, -425, -575)
  const data = ctx.getImageData(0, 0, 300, 150).data
  const chrome = [0, 0, 0, 0, 0, 128, 128, 0, 0, 0, 0, 0]
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  for (const y of [0, 75, 149]) {
    const alpha = chrome.map((_, i) => data[(y * 300 + 165 + i) * 4 + 3])
    t.true(
      alpha.every((value, i) => Math.abs(value - chrome[i]) <= 24) && Math.abs(sum(alpha) - sum(chrome)) <= 10,
      `y = ${y}: ${alpha} (Chrome ${chrome})`,
    )
  }
})

// That part is the canvas plus 256 px, grown in 256 px steps only for a
// shadow or filter that reaches further. A shadow or filter that reaches less
// keeps the raster of the draw without one, so an animated small shadow or
// blur reuses the cached raster instead of rastering the SVG again each
// frame. The pixels show which raster was drawn: the firefox logo covers the
// canvas opaquely, so the shadows are hidden, and a raster cut at another
// origin differs in a few gradient values (Chrome is within 1 of both).
test('a large svg draw keeps its raster for a shadow or filter that reaches less than 256 px', async (t) => {
  const image = await loaded(readFileSync(join(DIR, 'fixtures/firefox-logo.svg')))
  const draw = (setup: (ctx: SKRSContext2D) => void) => {
    const ctx = createCanvas(300, 150).getContext('2d')
    setup(ctx)
    ctx.drawImage(image, -3000, -2000, 6000, 5000)
    return ctx.getImageData(0, 0, 300, 150).data
  }
  const plain = draw(() => {})
  const cases: [string, (ctx: SKRSContext2D) => void][] = [
    [
      'shadowOffsetX 3',
      (ctx) => {
        ctx.shadowColor = 'blue'
        ctx.shadowOffsetX = 3
      },
    ],
    [
      'shadowOffsetY 7',
      (ctx) => {
        ctx.shadowColor = 'blue'
        ctx.shadowOffsetY = 7
      },
    ],
    [
      'shadowOffsetX -5 and shadowBlur 10',
      (ctx) => {
        ctx.shadowColor = 'blue'
        ctx.shadowOffsetX = -5
        ctx.shadowBlur = 10
      },
    ],
    [
      'shadowOffset 200, 100 and shadowBlur 20',
      (ctx) => {
        ctx.shadowColor = 'blue'
        ctx.shadowOffsetX = 200
        ctx.shadowOffsetY = 100
        ctx.shadowBlur = 20
      },
    ],
    [
      'drop-shadow(3px 0 0 blue)',
      (ctx) => {
        ctx.filter = 'drop-shadow(3px 0 0 blue)'
      },
    ],
    [
      'drop-shadow(50px 20px 4px blue)',
      (ctx) => {
        ctx.filter = 'drop-shadow(50px 20px 4px blue)'
      },
    ],
  ]
  for (const [name, setup] of cases) {
    const d = draw(setup)
    let changed = 0
    for (let i = 0; i < d.length; i++) {
      if (d[i] !== plain[i]) {
        changed++
      }
    }
    t.is(changed, 0, name)
  }
})

// img.width and img.height are the attributes; Chrome does not draw an SVG
// at that size.
test('img.width does not change what drawImage draws for an svg', async (t) => {
  for (const [file, natural, n, max] of [
    ['resize.svg', [10, 10], 86, [9, 9]],
    ['mountain.svg', [128, 128], 190, [29, 19]],
  ] as const) {
    const image = await loaded(readFileSync(join(DIR, file)))
    const count = () => {
      const ctx = createCanvas(512, 512).getContext('2d')
      ctx.drawImage(image, 0, 0)
      const d = ctx.getImageData(0, 0, 512, 512).data
      let count = 0
      let mx = -1
      let my = -1
      for (let y = 0; y < 512; y++)
        for (let x = 0; x < 512; x++)
          if (d[(y * 512 + x) * 4 + 3]) {
            count++
            mx = Math.max(mx, x)
            my = Math.max(my, y)
          }
      return [count, [mx, my]]
    }
    t.deepEqual(count(), [n, max], file)
    image.width = 100
    image.height = 100
    t.deepEqual([image.width, image.height, image.naturalWidth, image.naturalHeight], [100, 100, ...natural], file)
    t.deepEqual(count(), [n, max], `${file} with width 100`)
  }
})

// The createPattern tile of a 20000x20000 SVG is a 1.6 GB raster, as in
// Chrome, which rasters the whole tile. Its pages come from calloc and stay
// untouched where the SVG draws nothing; clearing them again made all 1.6 GB
// resident (+1527 MB maxRSS on macOS arm64, about +2 MB without it). Run in a
// child so the raster does not stay in the test process. A 32-bit process
// cannot allocate it (the pattern is then transparent). The memory bound is
// for calloc that maps fresh zero pages for a block this large, as macOS
// does and glibc and musl do; Windows is not measured.
test('createPattern of a large sparse svg does not touch the whole tile', (t) => {
  if (process.arch !== 'arm64' && process.arch !== 'x64') {
    t.pass('64-bit only')
    return
  }
  const script = `
const { createCanvas, Image } = require('./index.js')
const image = new Image()
image.src = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000"><rect width="10" height="10" fill="red"/></svg>')
const ctx = createCanvas(300, 150).getContext('2d')
const before = process.resourceUsage().maxRSS
ctx.fillStyle = ctx.createPattern(image, 'repeat')
ctx.fillRect(0, 0, 300, 150)
const d = ctx.getImageData(0, 0, 300, 150).data
const growth = (process.resourceUsage().maxRSS - before) / 1024
let red = 0
let other = 0
for (let i = 0; i < d.length; i += 4) {
  const x = (i / 4) % 300
  const y = Math.floor(i / 4 / 300)
  const px = d.slice(i, i + 4).join()
  if (x < 10 && y < 10 && px === '255,0,0,255') red++
  else if (px !== '0,0,0,0') other++
}
process.stdout.write(JSON.stringify({ growth, red, other }))
`
  const { status, signal, stdout, stderr } = spawnSync(process.execPath, ['-e', script], {
    cwd: join(DIR, '..'),
    encoding: 'utf8',
  })
  t.is(status, 0, `status=${status} signal=${signal}\n${stderr}`)
  const { growth, red, other } = JSON.parse(stdout)
  t.deepEqual([red, other], [100, 0])
  if (process.platform !== 'win32') {
    t.true(growth < 256, `maxRSS grew by ${growth} MB`)
  }
})
