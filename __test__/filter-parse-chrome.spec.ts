// ctx.filter parsed with the CSS filter grammar, as Blink's
// CSSParser::ParseSingleValue(kFilter) reads it, and resolved like an
// OffscreenCanvas filter (Node has no document): em and rem are 16px,
// viewport units are 0, and a drop-shadow() without a color is black.
// Every expected value was measured in Chrome 155 CPU canvas (--disable-gpu,
// willReadFrequently) on an OffscreenCanvas in a standards-mode page, and is
// equal on arm64 and x64, except where a test says otherwise.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { GlobalFonts, createCanvas } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const px = (ctx: Ctx, x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data]

function getter(before: string, filter: string) {
  const ctx = createCanvas(2, 2).getContext('2d')
  ctx.filter = before
  ctx.filter = filter
  return ctx.filter
}

test('ctx.filter accepts what Chrome 155 accepts', (t) => {
  for (const filter of [
    'BLUR(2px)',
    'Blur(2px)',
    'blur(2PX)',
    'blur()',
    'blur(0)',
    'blur(1em)',
    'blur(1rem)',
    'blur(1ex)',
    'blur(1ch)',
    'blur(1lh)',
    'blur(1cap)',
    'blur(calc(1px + 1px))',
    'blur(calc(1px - 3px))',
    'blur(1vw)',
    'blur(1vmin)',
    'blur(1in)',
    'blur(1q)',
    'blur(1Q)',
    'blur(+1px)',
    'blur(1e1px)',
    'blur(.5px)',
    'blur(1px',
    'blur( 2px )',
    'url(#x)',
    'url(x.svg#f)',
    'url("#x")',
    'URL(#x)',
    'url(#x) blur(2px)',
    'blur(2px) url(#x)',
    'grayscale()',
    'grayscale(2)',
    'grayscale(50%)',
    'GRAYSCALE(1)',
    'opacity(150%)',
    'opacity()',
    'opacity(calc(50% + 10%))',
    'opacity(calc(2))',
    'brightness()',
    'contrast()',
    'invert()',
    'sepia()',
    'saturate()',
    'hue-rotate()',
    'hue-rotate(0)',
    'hue-rotate(1turn)',
    'hue-rotate(100grad)',
    'hue-rotate(1.5rad)',
    'hue-rotate(90DEG)',
    'drop-shadow(red 2px 2px)',
    'drop-shadow(2px 2px)',
    'drop-shadow(2px 2px currentcolor)',
    'DROP-SHADOW(2px 2px red)',
    'drop-shadow(0 0 0 red)',
    'drop-shadow(2px 2px 2px transparent)',
    'drop-shadow(2px 2px 2px oklch(0.6 0.2 30))',
    'drop-shadow(2px 2px 2px hwb(0 0% 0%))',
    'drop-shadow(2px 2px 2px color(srgb 0 0 1))',
    'blur(1px)blur(1px)',
    ' blur(1px) ',
    'none',
    'NONE',
    'opacity(0.5)opacity(0.5)',
    'contrast(calc(-1))',
  ]) {
    t.is(getter('saturate(1)', filter), filter, filter)
  }
})

test('ctx.filter rejects what Chrome 155 rejects', (t) => {
  for (const filter of [
    'blur(-1px)',
    'blur(2)',
    'blur(2%)',
    'blur(2 px)',
    'grayscale(-1)',
    'opacity(-0.5)',
    'brightness(-1)',
    'saturate(-1)',
    'hue-rotate(90)',
    'hue-rotate(90 deg)',
    'drop-shadow(2px 2px -1px red)',
    'drop-shadow(2px)',
    'drop-shadow(2px 2px 2px 2px red)',
    'drop-shadow(2px 2px red 2px)',
    'drop-shadow(2px, 2px, red)',
    'blur(1px),blur(1px)',
    'inherit',
    'initial',
    'unset',
    'revert',
    'revert-layer',
    '',
    'blur(1px) none',
    'none blur(1px)',
    'opacity(50 %)',
    'blur(2px) ; ',
    'blur(2px) !important',
    'foo(1)',
    'blur(1px) foo(1)',
    'blur(var(--x))',
  ]) {
    t.is(getter('saturate(1)', filter), 'saturate(1)', filter)
  }
  // Math functions are typed: the result must be a length, a number, a
  // percentage or an angle, as the slot asks.
  for (const filter of [
    ...[
      'sign(-3px)',
      'round(2.5px)',
      'calc(1px * 2px)',
      'calc(1px + 2)',
      'calc(6px / 2px)',
      'calc(1px+2px)',
      'calc(0)',
      'calc(1px',
      'calc(100% - 1px)',
      'calc(1px + 0%)',
      'progress(5px, 0px, 10px)',
      'var(--x)',
      'env(safe-area-inset-left, 3px)',
      'attr(x px)',
      'calc-size(auto, 3px)',
    ].map((l) => `drop-shadow(${l} 0 0 red)`),
    ...['calc(0.25 + 25%)', 'calc(0.5px)', 'calc(50% * 50%)', 'calc(1 + 1%)'].map((n) => `opacity(${n})`),
    ...['calc(90)', 'calc(0)', 'calc(90deg / 1deg)', 'calc(90deg + 1px)', 'calc(90deg + 0)', 'HUE(1)'].map(
      (a) => `hue-rotate(${a})`,
    ),
  ]) {
    t.is(getter('none', filter), 'none', filter)
  }
})

// 24x24, an 8x8 rgb(40,120,200) rect at (8,8); C=(12,12), E=(17,17), O=(4,4).
function scene(filter: string) {
  const ctx = createCanvas(24, 24).getContext('2d')
  ctx.filter = 'saturate(1)'
  ctx.filter = filter
  ctx.fillStyle = 'rgb(40,120,200)'
  ctx.fillRect(8, 8, 8, 8)
  return [px(ctx, 12, 12), px(ctx, 17, 17), px(ctx, 4, 4)]
}

const PLAIN = [
  [40, 120, 200, 255],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
]
const BLUR2 = [
  [40, 120, 199, 224],
  [32, 112, 191, 16],
  [0, 0, 0, 1],
]
const BLUR1 = [
  [40, 120, 200, 255],
  [0, 128, 128, 2],
  [0, 0, 0, 0],
]
const center = (c: number[]) => [c, [0, 0, 0, 0], [0, 0, 0, 0]]
const edge = (e: number[], o = [0, 0, 0, 0]) => [[40, 120, 200, 255], e, o]
const QUARTER_TURN = center([200, 75, 177, 255])

test('filter functions draw like Chrome 155', (t) => {
  const cases: [string, number[][]][] = [
    ['BLUR(2px)', BLUR2],
    ['blur(2PX)', BLUR2],
    ['blur( 2px )', BLUR2],
    ['blur(calc(1px + 1px))', BLUR2],
    ['blur()', PLAIN],
    ['blur(0)', PLAIN],
    ['blur(.5px)', PLAIN],
    ['blur(+1px)', BLUR1],
    ['blur(1px', BLUR1],
    [' blur(1px) ', BLUR1],
    ['blur(1q)', BLUR1],
    [
      'blur(1e1px)',
      [
        [42, 117, 202, 24],
        [40, 121, 201, 19],
        [34, 119, 204, 15],
      ],
    ],
    ['blur(1in)', center([0, 0, 0, 0])],
    ['grayscale()', center([109, 109, 109, 255])],
    ['grayscale(2)', center([109, 109, 109, 255])],
    ['GRAYSCALE(1)', center([109, 109, 109, 255])],
    ['grayscale(50%)', center([74, 114, 154, 255])],
    ['invert()', center([215, 135, 55, 255])],
    ['sepia()', center([146, 130, 101, 255])],
    ['opacity(150%)', PLAIN],
    ['opacity()', PLAIN],
    ['brightness()', PLAIN],
    ['contrast()', PLAIN],
    ['saturate()', PLAIN],
    ['opacity(.5)', center([40, 120, 201, 127])],
    ['opacity(0.5)opacity(0.5)', center([40, 121, 198, 63])],
    ['brightness(1.5)', center([60, 180, 255, 255])],
    ['saturate(200%)', center([0, 131, 255, 255])],
    ['contrast(200%)', center([0, 112, 255, 255])],
    ['hue-rotate()', PLAIN],
    ['hue-rotate(0)', PLAIN],
    ['hue-rotate(1turn)', PLAIN],
    ['hue-rotate(0.25turn)', QUARTER_TURN],
    ['hue-rotate(100grad)', QUARTER_TURN],
    ['hue-rotate(90DEG)', QUARTER_TURN],
    ['hue-rotate(-90deg)', center([17, 143, 40, 255])],
    ['hue-rotate(1.5rad)', center([195, 76, 184, 255])],
    ['drop-shadow(red 2px 2px)', edge([255, 0, 0, 255])],
    ['drop-shadow(2px 2px red)', edge([255, 0, 0, 255])],
    ['DROP-SHADOW(2px 2px red)', edge([255, 0, 0, 255])],
    ['drop-shadow(2px 2px 2px hsl(0 100% 50%))', edge([255, 0, 0, 88])],
    ['drop-shadow(2px 2px 2px oklch(0.6 0.2 30))', edge([223, 61, 46, 88])],
    ['drop-shadow(2px 2px 2px hwb(0 0% 0%))', edge([255, 0, 0, 88])],
    ['drop-shadow(2px 2px 2px color(srgb 0 0 1))', edge([0, 0, 255, 88])],
    ['drop-shadow(2px 2px 2px rgb(0 0 255 / 50%))', edge([0, 0, 255, 44])],
    ['drop-shadow(2px 2px 2px #00f8)', edge([0, 0, 255, 47])],
    ['drop-shadow(0 0 2px red)', edge([255, 0, 0, 16], [255, 0, 0, 1])],
    ['drop-shadow(0 0 0 red)', PLAIN],
    ['drop-shadow(2px 2px 2px transparent)', PLAIN],
    [
      'blur(1px) blur(1px)',
      [
        [41, 120, 201, 251],
        [36, 109, 219, 7],
        [0, 0, 0, 0],
      ],
    ],
    ['none', PLAIN],
    ['NONE', PLAIN],
  ]
  for (const [filter, want] of cases) {
    t.deepEqual(scene(filter), want, filter)
  }
  t.deepEqual(scene('blur(1px'), scene('blur(1px)'))
})

test('url() filters are skipped and keep the chain', (t) => {
  for (const filter of ['url(#x)', 'url(x.svg#f)', 'url("#x")', 'URL(#x)']) {
    t.deepEqual(scene(filter), PLAIN, filter)
  }
  t.deepEqual(scene('url(#x) blur(2px)'), BLUR2)
  t.deepEqual(scene('blur(2px) url(#x)'), BLUR2)
  const ctx = createCanvas(16, 16).getContext('2d')
  ctx.filter = 'url(#x) invert(1)'
  ctx.fillStyle = 'rgb(40,120,200)'
  ctx.fillRect(4, 4, 8, 8)
  t.deepEqual(px(ctx, 8, 8), [215, 135, 55, 255])
})

// 40x8, `drop-shadow(L 0 0 red)` of a blue dot at (2,2): the shadow pixels of
// row 2 as `x:r/a`.
function shadowRow(length: string) {
  const ctx = createCanvas(40, 8).getContext('2d')
  ctx.filter = 'none'
  ctx.filter = `drop-shadow(${length} 0 0 red)`
  ctx.fillStyle = 'blue'
  ctx.fillRect(2, 2, 1, 1)
  const row = ctx.getImageData(0, 2, 40, 1).data
  const xs = []
  for (let x = 0; x < 40; x++) {
    if (row[x * 4] > 0 && row[x * 4 + 3] > 0) xs.push(`${x}:${row[x * 4]}/${row[x * 4 + 3]}`)
  }
  return xs.join(' ')
}

test('calc() and math lengths resolve like Chrome 155', (t) => {
  const cases: [string, string][] = [
    ['calc(1px + 2px)', '5:255/255'],
    ['calc(2px * 3)', '8:255/255'],
    ['calc(12px / 4)', '5:255/255'],
    ['calc(3 * 2px)', '8:255/255'],
    ['calc((1px + 1px) * 2)', '6:255/255'],
    ['min(3px, 5px)', '5:255/255'],
    ['max(3px, 5px)', '7:255/255'],
    ['clamp(1px, 8px, 4px)', '6:255/255'],
    ['abs(-3px)', '5:255/255'],
    ['calc(abs(-3px))', '5:255/255'],
    ['calc(sign(5px) * 3px)', '5:255/255'],
    ['round(2.6px, 1px)', '5:255/255'],
    ['round(up, 2.2px, 1px)', '5:255/255'],
    ['round(down, 2.8px, 1px)', '4:255/255'],
    ['round(to-zero, 2.8px, 1px)', '4:255/255'],
    ['mod(7px, 3px)', '3:255/255'],
    ['rem(7px, 3px)', '3:255/255'],
    ['mod(-7px, 3px)', '4:255/255'],
    ['rem(-7px, 3px)', '1:255/255'],
    ['calc(sin(90deg) * 3px)', '5:255/255'],
    ['calc(cos(0) * 4px)', '6:255/255'],
    ['calc(tan(45deg) * 5px)', '7:255/255'],
    ['calc(pow(2, 2) * 1px)', '6:255/255'],
    ['calc(sqrt(9) * 1px)', '5:255/255'],
    ['hypot(3px, 4px)', '7:255/255'],
    ['calc(log(e) * 3px)', '5:255/255'],
    ['calc(exp(0) * 3px)', '5:255/255'],
    ['calc(pi * 1px)', '5:255/219 6:255/36'],
    ['calc(e * 1px)', '4:255/72 5:255/183'],
    ['calc(NaN * 1px)', ''],
    ['calc(1em + 1px)', '19:255/255'],
    ['CALC(1px + 2px)', '5:255/255'],
    ['calc( 1px + 2px )', '5:255/255'],
    ['calc(1px - -2px)', '5:255/255'],
    ['calc(0px)', ''],
    ['min(1px)', '3:255/255'],
    ['max(5px, 1em)', '18:255/255'],
    ['calc(5px - 10px)', ''],
    ['calc(2px*3)', '8:255/255'],
    ['calc(asin(1) / 1deg * 0.1px)', '11:255/255'],
    ['calc(atan2(1, 1) / 1deg * 0.1px)', '6:255/128 7:255/128'],
    ['calc(1in - 90px)', '8:255/255'],
    ['calc(10px * (1 + 0.2))', '14:255/255'],
    ['calc(1px / 0)', ''],
  ]
  for (const [length, want] of cases) {
    t.is(shadowRow(length), want, length)
  }
})

test('calc() numbers resolve like Chrome 155', (t) => {
  const alpha = (n: string) => {
    const ctx = createCanvas(4, 4).getContext('2d')
    ctx.filter = `opacity(${n})`
    ctx.fillStyle = 'blue'
    ctx.fillRect(0, 0, 4, 4)
    return px(ctx, 1, 1)[3]
  }
  const cases: [string, number][] = [
    ['calc(0.5)', 127],
    ['calc(50%)', 127],
    ['calc(25% + 25%)', 127],
    ['calc(0.25 + 0.25)', 127],
    ['calc(2 * 25%)', 127],
    ['min(0.5, 0.7)', 127],
    ['max(20%, 30%)', 76],
    ['clamp(0, 0.3, 1)', 76],
    ['calc(1 - 0.75)', 63],
    ['calc(-0.5)', 0],
    ['calc(150%)', 255],
    ['abs(-0.5)', 127],
    ['round(0.26, 0.1)', 76],
    ['calc(sin(30deg))', 127],
    ['calc(1 / 3)', 85],
    ['calc(50% / 2)', 63],
    ['calc(1 / 0)', 255],
    ['calc(e - 2)', 183],
    ['calc(infinity)', 255],
    ['calc(-infinity)', 0],
    ['calc(NaN)', 0],
    ['sign(-1)', 0],
  ]
  for (const [n, want] of cases) {
    t.is(alpha(n), want, n)
  }
  // A negative math result clamps to 0 in contrast(), saturate() and
  // brightness() too: 256x4 gradient source, pixel (100, 0).
  const src = createCanvas(256, 4)
  const s = src.getContext('2d')
  const data = s.createImageData(256, 4)
  for (let i = 0; i < 256 * 4; i++) {
    const x = i % 256
    data.data.set([x, (x * 3) % 256, 255 - x, 255], i * 4)
  }
  s.putImageData(data, 0, 0)
  for (const [filter, want] of [
    ['contrast(calc(-1))', [127, 127, 127, 255]],
    ['saturate(calc(-1))', [64, 64, 64, 255]],
    ['brightness(calc(-1))', [0, 0, 0, 255]],
  ] as const) {
    const ctx = createCanvas(256, 4).getContext('2d')
    ctx.filter = filter
    ctx.drawImage(src, 0, 0)
    t.deepEqual(px(ctx, 100, 0), want, filter)
  }
})

test('calc() angles resolve like Chrome 155', (t) => {
  const rotated = (a: string) => {
    const ctx = createCanvas(4, 4).getContext('2d')
    ctx.filter = `hue-rotate(${a})`
    ctx.fillStyle = 'rgb(40,120,200)'
    ctx.fillRect(0, 0, 4, 4)
    return px(ctx, 1, 1)
  }
  const QUARTER = [200, 75, 177, 255]
  const HALF = [177, 97, 17, 255]
  const cases: [string, number[]][] = [
    ['calc(45deg * 2)', QUARTER],
    ['calc(0.25turn)', QUARTER],
    ['calc(100grad)', QUARTER],
    ['min(90deg, 1turn)', QUARTER],
    ['calc(1.5708rad)', QUARTER],
    ['calc(acos(0))', QUARTER],
    ['calc(1deg * 90)', QUARTER],
    ['calc(90deg / 1)', QUARTER],
    ['calc(1turn - 270deg)', QUARTER],
    ['calc(90deg + 0.25turn)', HALF],
    ['calc(90deg * 2)', HALF],
    ['calc(-90deg)', [17, 143, 40, 255]],
    ['calc(atan(1))', [125, 93, 222, 255]],
    ['atan2(1, 1)', [125, 93, 222, 255]],
    ['calc(NaN * 1deg)', [40, 120, 200, 255]],
    ['calc(1e3deg)', [7, 144, 57, 255]],
    // ClampAngle, then a float hue.
    ['calc(infinity * 1deg)', [46, 137, 13, 255]],
  ]
  for (const [a, want] of cases) {
    t.deepEqual(rotated(a), want, a)
  }
})

// 40x40, an rgb(40,120,200) 10x10 rect at (15,15).
function blurred(setup: (ctx: Ctx) => void) {
  const ctx = createCanvas(40, 40).getContext('2d')
  setup(ctx)
  ctx.fillStyle = 'rgb(40,120,200)'
  ctx.fillRect(15, 15, 10, 10)
  return ctx.getImageData(0, 0, 40, 40).data
}
const blurPx = (n: number) => blurred((c) => (c.filter = `blur(${n}px)`))

test('blur() calc results clamp when used', (t) => {
  const cases: [string, number][] = [
    ['calc(1px + 2px)', 3],
    ['calc(1px - 3px)', 0],
    ['max(-5px, 2px)', 2],
    ['calc(0.5 * 4px)', 2],
    ['calc(-1px)', 0],
    ['calc(NaN * 1px)', 0],
    ['min(3px, 5px)', 3],
    ['max(3px, 5px)', 5],
    ['clamp(1px, 8px, 4px)', 4],
    ['calc(0.2em + 1px)', 4],
    ['0.0625in', 6],
    ['3pt', 4],
    ['0.25pc', 4],
  ]
  for (const [b, n] of cases) {
    t.deepEqual(
      blurred((c) => (c.filter = `blur(${b})`)),
      blurPx(n),
      b,
    )
  }
})

test('em and rem in ctx.filter are 16px, whatever ctx.font is', (t) => {
  const half = blurPx(8)
  t.deepEqual(
    blurred((c) => (c.filter = 'blur(0.5em)')),
    half,
  )
  t.deepEqual(
    blurred((c) => {
      c.font = '20px serif'
      c.filter = 'blur(0.5em)'
    }),
    half,
  )
  t.deepEqual(
    blurred((c) => {
      c.filter = 'blur(0.5em)'
      c.font = '20px serif'
      c.filter = 'blur(0.5em)'
    }),
    half,
  )
  t.deepEqual(
    blurred((c) => {
      c.font = '20px serif'
      c.filter = 'blur(0.25rem)'
    }),
    blurPx(4),
  )
  t.deepEqual(scene('drop-shadow(2px 2px 1em red)'), edge([255, 0, 0, 9], [255, 0, 0, 7]))
})

// A document canvas uses the element's color and taints the canvas; Node has
// no element, so this is the OffscreenCanvas answer.
test('drop-shadow without a color or with currentcolor is black', (t) => {
  t.deepEqual(scene('drop-shadow(2px 2px)'), edge([0, 0, 0, 255]))
  t.deepEqual(scene('drop-shadow(2px 2px currentcolor)'), edge([0, 0, 0, 255]))
})

test('viewport, container and line-height units resolve to 0', (t) => {
  for (const unit of ['vw', 'vmin', 'svh', 'cqw', 'lh', 'rlh']) {
    const filter = `drop-shadow(calc(1${unit} + 2px) 2px red)`
    t.deepEqual(scene(filter), edge([255, 0, 0, 255]), filter)
  }
  t.deepEqual(scene('drop-shadow(2px 2px calc(1vw) red)'), edge([255, 0, 0, 255]))
  t.deepEqual(scene('blur(1vw)'), PLAIN)
  t.deepEqual(scene('blur(1lh)'), PLAIN)
})

// An OffscreenCanvas hangs on these; the values are Chrome 155's document
// canvas, where nothing depends on the document: the draw leaves no pixel.
test('infinite drop-shadow offsets and blurs draw nothing', (t) => {
  for (const filter of [
    'drop-shadow(calc(infinity * 1px) 0 0 red)',
    'drop-shadow(calc(-infinity * 1px) 0 0 red)',
    'drop-shadow(1e30px 0 0 red)',
    'blur(calc(infinity * 1px))',
    'blur(1e30px)',
  ]) {
    const ctx = createCanvas(40, 8).getContext('2d')
    ctx.filter = filter
    ctx.fillStyle = 'blue'
    ctx.fillRect(2, 2, 4, 4)
    t.true(
      ctx.getImageData(0, 0, 40, 8).data.every((v) => v === 0),
      filter,
    )
  }
})

// Not Chrome values: ex, ch and cap come from the canvas font, so they depend
// on the installed fonts. ch is the advance of "0" in ctx.font, read when the
// filter is assigned.
test('ch in ctx.filter is the advance of "0" in ctx.font', (t) => {
  for (const font of ['10px sans-serif', '20px serif']) {
    const ctx = createCanvas(4, 4).getContext('2d')
    ctx.font = font
    const width = ctx.measureText('0').width
    const at = (length: string, setup: (c: Ctx) => void) => {
      const c = createCanvas(400, 4).getContext('2d')
      setup(c)
      c.filter = `drop-shadow(${length} 0 0 red)`
      c.font = '40px serif'
      c.fillStyle = 'blue'
      c.fillRect(0, 0, 1, 4)
      return c.getImageData(0, 1, 400, 1).data
    }
    t.deepEqual(
      at('calc(10 * 1ch)', (c) => (c.font = font)),
      at(`${10 * width}px`, () => {}),
      font,
    )
  }
})

// Chrome 155 OffscreenCanvas resolves a drop-shadow() color with the
// filter's own lengths, so ex, ch, cap and their root forms come from the
// canvas font when the filter is set (filter_operation_resolver.cc:285-297,
// style_builder_converter.cc:2721-2724); ic is 1em for Lato, which has no
// U+6C34, em and rem 16px, lh 0. Lato is the registered test font (a
// FontFace in the Chrome probe).
test('font-relative units in a drop-shadow() color use the canvas font', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), 'Lato')
  // The shadow pixel of a 20x20 blue rect.
  const shadowPixel = (filter: string, font: string, fontAfter?: string) => {
    const ctx = createCanvas(100, 40).getContext('2d')
    ctx.font = font
    ctx.filter = filter
    if (fontAfter) ctx.font = fontAfter
    t.is(ctx.filter, filter)
    ctx.fillStyle = 'rgb(0 0 255)'
    ctx.fillRect(10, 10, 20, 20)
    return px(ctx, 40, 20)
  }
  const red = (r: number) => [r, 0, 0, 255]
  const color = (c: string) => `drop-shadow(20px 0 0 ${c})`
  const cases: [string, number[]][] = [
    [color('rgb(calc(10ch / 1px) 0 0)'), red(116)],
    [color('rgb(calc(10cap / 1px) 0 0)'), red(143)],
    [color('rgb(calc(10ic / 1px) 0 0)'), red(160)],
    [color('rgb(calc(10rch / 1px) 0 0)'), red(116)],
    [color('rgb(calc(10rcap / 1px) 0 0)'), red(143)],
    [color('rgb(calc(10em / 1px) 0 0)'), red(160)],
    [color('rgb(calc(10lh / 1px) 0 0)'), red(0)],
    ['drop-shadow(rgb(calc(10ch / 1px) 0 0) 20px 0 0)', red(116)],
    [color('rgb(calc(calc(5ch / 1px) * 2) 0 0)'), red(116)],
    [color('rgb(calc((1ch + 1cap) / 1px * 4) 0 0)'), red(104)],
    [color('color-mix(in srgb, rgb(calc(10ch / 1px) 0 0), rgb(0 calc(10cap / 1px) 0))'), [58, 72, 0, 255]],
    [color('rgb(from rgb(0 0 0) calc(10ch / 1px) g b)'), red(116)],
    [color('rgb(calc(10\\63 h / 1px) 0 0)'), red(116)],
  ]
  for (const [filter, want] of cases) {
    t.deepEqual(shadowPixel(filter, '20px Lato'), want, filter)
  }
  t.deepEqual(shadowPixel(color('rgb(calc(10ch / 1px) 0 0)'), '40px Lato'), red(232))
  // Read when the filter is set, not when it draws.
  t.deepEqual(shadowPixel(color('rgb(calc(10ch / 1px) 0 0)'), '20px Lato', '40px Lato'), red(116))

  // ex is the x-height. On macOS Blink and we both read it off the "x" glyph
  // (our measureText's actualBoundingBoxAscent), where we round it: 10px for
  // 20px Lato and 21px for 40px, Chrome 10.13px and 20.26px, so Chrome draws
  // 101 and 203 where we draw 100 and 210 (decisions.md 08-Q4: our font
  // metrics). Elsewhere it is the font's x-height.
  const ex = (font: string) => shadowPixel(color('rgb(calc(10ex / 1px) 0 0)'), font)
  const exAfter = shadowPixel(color('rgb(calc(10ex / 1px) 0 0)'), '20px Lato', '40px Lato')
  const rex = shadowPixel(color('rgb(calc(10rex / 1px) 0 0)'), '20px Lato')
  if (process.platform === 'darwin') {
    const xTop = (font: string) => {
      const ctx = createCanvas(4, 4).getContext('2d')
      ctx.font = font
      return Math.round(10 * ctx.measureText('x').actualBoundingBoxAscent)
    }
    t.deepEqual(ex('20px Lato'), red(xTop('20px Lato')))
    t.deepEqual(ex('40px Lato'), red(xTop('40px Lato')))
  }
  t.true(ex('20px Lato')[0] > 90, 'ex is the x-height')
  t.true(ex('40px Lato')[0] > ex('20px Lato')[0])
  t.deepEqual(exAfter, ex('20px Lato'))
  t.deepEqual(rex, ex('20px Lato'))
})

// Chrome 155 OffscreenCanvas: ic and ric are the advance of U+6C34 in the
// primary font of ctx.font when the filter is set. That is the first family
// of the list that exists, whether or not it has the glyph; when it has none,
// ic and ric are em and rem, 16px (FontSizes::Ic and Ric,
// css_to_length_conversion_data.cc:139-167; font_fallback_list.cc:88-195).
// HYXiXingKaiW and Source Han Serif CN have U+6C34 one em wide, Lato has
// none. All three are FontFaces in the Chrome probe.
test('ic in ctx.filter is the U+6C34 advance of the first font of ctx.font', (t) => {
  const fonts = join(__dirname, 'fonts')
  GlobalFonts.registerFromPath(join(fonts, 'Lato-Regular.ttf'), 'Lato')
  GlobalFonts.registerFromPath(join(fonts, 'HYXiXingKaiW.ttf'), 'HYXiXingKaiW')
  GlobalFonts.registerFromPath(join(fonts, 'SourceHanSerifCN-Bold.ttf'), 'Source Han Serif CN')
  const setUp = (filter: string, font: string, fontAfter?: string) => {
    const ctx = createCanvas(160, 40).getContext('2d')
    ctx.font = font
    ctx.filter = filter
    if (fontAfter) ctx.font = fontAfter
    t.is(ctx.filter, filter)
    ctx.fillStyle = 'rgb(0 0 255)'
    return ctx
  }
  // The shadow pixel of a 20x20 blue rect, 20px to the right.
  const shadowPixel = (filter: string, font: string, fontAfter?: string) => {
    const ctx = setUp(filter, font, fontAfter)
    ctx.fillRect(10, 10, 20, 20)
    return px(ctx, 40, 20)
  }
  // Where the shadow of a 4px wide rect at x = 0 starts.
  const shadowStart = (filter: string, font: string, fontAfter?: string) => {
    const ctx = setUp(filter, font, fontAfter)
    ctx.fillRect(0, 10, 4, 20)
    const row = ctx.getImageData(0, 20, 160, 1).data
    const x = row.findIndex((v, i) => i % 4 === 0 && v > 0) / 4
    t.deepEqual(
      [...row.slice(x * 4, x * 4 + 12)].filter((_, i) => i % 4 === 0),
      [255, 255, 255],
      filter,
    )
    return x
  }
  const red = (r: number) => [r, 0, 0, 255]
  const color = (unit: string) => `drop-shadow(20px 0 0 rgb(calc(10${unit} / 1px) 0 0))`
  const colors: [string, number][] = [
    ['20px HYXiXingKaiW', 200],
    ['40px HYXiXingKaiW', 255],
    ['13.5px HYXiXingKaiW', 135],
    ['bold 20px HYXiXingKaiW', 200],
    ['italic 20px HYXiXingKaiW', 200],
    ['20px "Source Han Serif CN"', 200],
    ['40px "Source Han Serif CN"', 255],
    ['bold 20px "Source Han Serif CN"', 200],
    ['20px Lato', 160],
    ['40px Lato', 160],
    // The first family exists and has no U+6C34: the next one is not read.
    ['20px Lato, HYXiXingKaiW', 160],
    ['20px HYXiXingKaiW, Lato', 200],
    // A family that does not exist is skipped.
    ['20px NoSuchFontXyz, HYXiXingKaiW', 200],
    ['20px NoSuchFontXyz, Lato', 160],
  ]
  for (const [font, r] of colors) {
    t.deepEqual(shadowPixel(color('ic'), font), red(r), font)
    t.deepEqual(shadowPixel(color('ric'), font), red(r), font)
  }
  // Read when the filter is set, not when it draws.
  t.deepEqual(shadowPixel(color('ic'), '20px HYXiXingKaiW', '40px HYXiXingKaiW'), red(200))
  t.deepEqual(shadowPixel(color('ic'), '20px HYXiXingKaiW', '20px Lato'), red(200))
  t.deepEqual(shadowPixel(color('ic'), '20px Lato', '20px HYXiXingKaiW'), red(160))
  const kai = '20px HYXiXingKaiW'
  const shadow = (c: string) => `drop-shadow(20px 0 0 ${c})`
  t.deepEqual(shadowPixel(shadow('rgb(calc(10ic / 1px) calc(5ric / 1px) 0)'), kai), [200, 100, 0, 255])
  t.deepEqual(shadowPixel(shadow('rgb(calc((1ic + 1em) / 1px * 4) 0 0)'), kai), red(144))
  // Unhinted: exactly 1em, 13.5px at 13.5px.
  t.deepEqual(shadowPixel(shadow('rgb(calc((1ic - 13px) / 1px * 500) 0 0)'), '13.5px HYXiXingKaiW'), red(250))
  t.deepEqual(shadowPixel(shadow('rgb(calc((1ic - 19.9px) / 1px * 1000) 0 0)'), kai), red(100))
  t.deepEqual(shadowPixel(shadow('rgb(calc((20.1px - 1ic) / 1px * 1000) 0 0)'), kai), red(100))
  t.deepEqual(shadowPixel(shadow('rgb(calc((1ic - 15.9px) / 1px * 1000) 0 0)'), '20px Lato'), red(100))
  t.deepEqual(shadowPixel(shadow('rgb(calc((16.1px - 1ic) / 1px * 1000) 0 0)'), '20px Lato'), red(100))

  // ic as a length.
  const starts: [string, string, number, string?][] = [
    ['drop-shadow(1ic 0 0 red)', kai, 20],
    ['drop-shadow(1ic 0 0 red)', '40px HYXiXingKaiW', 40],
    ['drop-shadow(0.5ric 0 0 red)', '40px HYXiXingKaiW', 20],
    ['drop-shadow(2ic 0 0 red)', '20px "Source Han Serif CN"', 40],
    ['drop-shadow(calc(1ic + 1ric) 0 0 red)', kai, 40],
    ['drop-shadow(1ic 0 0 red)', '20px Lato', 16],
    ['drop-shadow(1ic 0 0 red)', '20px Lato, HYXiXingKaiW', 16],
    ['drop-shadow(1ic 0 0 red)', '20px NoSuchFontXyz, HYXiXingKaiW', 20],
    ['blur(calc(1ic - 20px)) drop-shadow(1ic 0 0 red)', kai, 20],
    ['drop-shadow(1ic 0 0 red)', kai, 20, '40px HYXiXingKaiW'],
    ['drop-shadow(1ic 0 0 red)', '20px Lato', 16, '40px HYXiXingKaiW'],
  ]
  for (const [filter, font, x, fontAfter] of starts) {
    t.is(shadowStart(filter, font, fontAfter), x, `${font} ${filter}`)
  }

  // macOS system fonts, measured on this Mac's Chrome 155. Apple SD Gothic
  // Neo's U+6C34 is 0.865em wide.
  if (process.platform === 'darwin') {
    for (const [font, r] of [
      ['20px "Hiragino Sans"', 200],
      ['40px "Hiragino Sans"', 255],
      ['20px "Hiragino Sans GB"', 200],
      ['20px "Apple SD Gothic Neo"', 173],
      ['20px Lato, "Hiragino Sans"', 160],
      ['20px "Hiragino Sans", Lato', 200],
      ['20px NoSuchFontXyz, "Hiragino Sans"', 200],
    ] as const) {
      t.deepEqual(shadowPixel(color('ic'), font), red(r), font)
      t.deepEqual(shadowPixel(color('ric'), font), red(r), font)
    }
    t.deepEqual(shadowPixel(shadow('rgb(calc((1ic - 17px) / 1px * 500) 0 0)'), '20px "Apple SD Gothic Neo"'), red(150))
    t.is(shadowStart('drop-shadow(1ic 0 0 red)', '20px "Hiragino Sans"'), 20)
    t.is(shadowStart('drop-shadow(1ic 0 0 red)', '20px "Apple SD Gothic Neo"'), 17)
    t.is(shadowStart('drop-shadow(1ic 0 0 red)', '40px "Apple SD Gothic Neo"'), 34)
  }
})
