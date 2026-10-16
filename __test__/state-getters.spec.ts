// Default state and the fillStyle / strokeStyle / shadowColor getters.
// Expected values were measured in Chrome 155 (--disable-gpu, a
// willReadFrequently canvas in a standards-mode page); arm64 and x64 gave the
// same results. SvgCanvas and PDF pages have no Chrome counterpart: they
// follow the same rules (HTML spec).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test, { type ExecutionContext } from 'ava'

import { createCanvas, PDFDocument, SvgExportFlag } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const px = (ctx: Ctx, x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data)

test('shadowColor defaults to transparent black', (t) => {
  for (const canvas of [createCanvas(20, 20), createCanvas(20, 20, SvgExportFlag.ConvertTextToPaths)]) {
    const ctx = canvas.getContext('2d')
    t.is(ctx.shadowColor, 'rgba(0, 0, 0, 0)')
    ctx.shadowColor = 'red'
    ctx.reset()
    t.is(ctx.shadowColor, 'rgba(0, 0, 0, 0)')
    ctx.shadowColor = 'red'
    // eslint-disable-next-line no-self-assign
    canvas.width = canvas.width
    t.is(ctx.shadowColor, 'rgba(0, 0, 0, 0)')
    ctx.shadowColor = 'red'
    canvas.height = 25
    t.is(ctx.shadowColor, 'rgba(0, 0, 0, 0)')
  }
  const doc = new PDFDocument()
  t.is(doc.beginPage(20, 20).shadowColor, 'rgba(0, 0, 0, 0)')
  doc.endPage()
  doc.close()
})

test('shadowBlur and shadowOffset alone draw no shadow', (t) => {
  const ctx = createCanvas(30, 20).getContext('2d')
  ctx.shadowBlur = 6
  ctx.shadowOffsetX = 8
  ctx.fillStyle = '#00f'
  ctx.fillRect(5, 5, 10, 10)
  t.deepEqual(px(ctx, 20, 10), [0, 0, 0, 0])
  t.deepEqual(px(ctx, 10, 10), [0, 0, 255, 255])

  const ctx2 = createCanvas(40, 20).getContext('2d')
  ctx2.shadowOffsetX = 20
  ctx2.fillRect(0, 0, 10, 10)
  t.deepEqual(px(ctx2, 25, 5), [0, 0, 0, 0])
  t.deepEqual(px(ctx2, 5, 5), [0, 0, 0, 255])
})

test('SvgCanvas: no shadow without a shadowColor', (t) => {
  const draw = (shadow: boolean) => {
    const canvas = createCanvas(30, 20, SvgExportFlag.NoPrettyXML)
    const ctx = canvas.getContext('2d')
    if (shadow) {
      ctx.shadowBlur = 6
      ctx.shadowOffsetX = 8
    }
    ctx.fillStyle = '#00f'
    ctx.fillRect(5, 5, 10, 10)
    return canvas.getContent().toString()
  }
  t.is(draw(true), draw(false))
})

const COLOR_PROPS = ['fillStyle', 'strokeStyle', 'shadowColor'] as const

// [input, getter] pairs measured in Chrome; '#123456' means Chrome ignored
// the input (each property is set to '#123456' first). The Chrome-only
// syntaxes (hwb, lab, oklch, color(), color-mix, relative colors, system
// colors, calc) are not in it.
const COLOR_FIXTURE: [string, string][] = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'canvas-color-getters.json'), 'utf8'),
)

const readColors = (ctx: Ctx, entries: [string, string][], t: ExecutionContext, label: string) => {
  for (const [input, expected] of entries) {
    for (const prop of COLOR_PROPS) {
      ctx[prop] = '#123456'
      ctx[prop] = input
      t.is(ctx[prop], expected, `${label} ${prop} ${JSON.stringify(input)}`)
    }
  }
}

test('fillStyle, strokeStyle and shadowColor serialize like Chrome', (t) => {
  readColors(createCanvas(4, 4).getContext('2d'), COLOR_FIXTURE, t, 'canvas')
  readColors(
    createCanvas(4, 4, SvgExportFlag.ConvertTextToPaths).getContext('2d'),
    COLOR_FIXTURE.slice(0, 200),
    t,
    'svg',
  )
  const doc = new PDFDocument()
  readColors(doc.beginPage(4, 4), COLOR_FIXTURE.slice(0, 200), t, 'pdf')
  doc.endPage()
  doc.close()
})

test('color getters: pinned examples', (t) => {
  const pins: [string, string][] = [
    ['hotpink', '#ff69b4'],
    ['RED', '#ff0000'],
    ['#F00', '#ff0000'],
    ['#f008', 'rgba(255, 0, 0, 0.533)'],
    ['#abcdef80', 'rgba(171, 205, 239, 0.5)'],
    ['#12345678', 'rgba(18, 52, 86, 0.47)'],
    ['transparent', 'rgba(0, 0, 0, 0)'],
    [`rgba(10, 20, 30, ${1 / 255})`, 'rgba(10, 20, 30, 0.004)'],
    // The CSS fast path and the legacy (comma) syntax keep an 8-bit alpha;
    // the full parser keeps the float of the modern syntax.
    ['rgb(1 2 3 / 99.9%)', 'rgba(1, 2, 3, 1)'],
    ['rgba(1,2,3,99.9%)', '#010203'],
    ['RGBA(1,2,3,0.999)', '#010203'],
    ['RGB(1 2 3 / 0.999)', 'rgba(1, 2, 3, 1)'],
    ['rgb(1 2 3 / 0.999)', '#010203'],
    ['rgb( 1 2 3 / 0.999 )', 'rgba(1, 2, 3, 1)'],
    ['rgb(1 2 3 / 0.999)/*,*/', 'rgba(1, 2, 3, 1)'],
    ['rgb(1 2 3 / /*,*/ 0.999)', 'rgba(1, 2, 3, 1)'],
    ['rgb(1/*,*/2 3 / 0.999)', 'rgba(1, 2, 3, 1)'],
    ['hsla(10, 60%, 30%, 0.999)', '#7a2e1f'],
    ['HSLA(10, 60%, 30%, 0.999)', 'rgba(122, 46, 31, 1)'],
    ['hsla(10, 60%, 30%, 99.9%)', 'rgba(122, 46, 31, 1)'],
    ['hsla(10,60%,30%,0.998)', 'rgba(122, 46, 31, 0.996)'],
    ['rgba(300, -5, 128, 2)', '#ff0080'],
    ['rgb(10.6, 20.4, 30.5)', '#0b141f'],
    ['RGBA(10.5,0,0,0.5)', 'rgba(11, 0, 0, 0.5)'],
    ['hsl(120, 50%, 50%)', '#40bf40'],
    // HTML spaces around the color are stripped.
    ['  red  ', '#ff0000'],
    ['\tred\n', '#ff0000'],
    // An unclosed function and comments after a non-keyword color are fine.
    ['rgb(1,2,3', '#010203'],
    ['rgb(1 2 3 / 0.5', 'rgba(1, 2, 3, 0.5)'],
    ['#f00/**/', '#ff0000'],
    ['/**/#f00', '#ff0000'],
    ['rgb(1,/**/2,3)', '#010203'],
    ['hsl(0 50% 50% / none)', 'rgba(191, 64, 64, 0)'],
    ['rgb(10 20 30 / none)', 'rgba(10, 20, 30, 0)'],
    ['hsl(none 50% 50%)', '#bf4040'],
    // Without an element, currentcolor is opaque black.
    ['currentcolor', '#000000'],
    ['CurrentColor', '#000000'],
    [' currentColor\n', '#000000'],
  ]
  readColors(createCanvas(4, 4).getContext('2d'), pins, t, 'canvas')
})

test('color getters: Chrome ignores these', (t) => {
  const ignored = [
    '\u00a0red',
    'red\u00a0',
    '\vred',
    'red blue',
    '#f00 x',
    'red,',
    'red;',
    'rgb(1,2,3) x',
    'rgb(1,2,3);',
    // A keyword must be the whole string.
    'red/**/',
    '/**/red',
    'hotpink/**/',
    'transparent/**/',
    're\\64',
    'r\\65 d',
    '-red',
    '\\#f00',
    'red !important',
    'rgb(1,2,3)/**/x',
    '/**/currentcolor',
    'currentcolor/**/',
    'currentcolor x',
    'currentcolo\\72',
    'ff0000',
    '',
  ]
  readColors(
    createCanvas(4, 4).getContext('2d'),
    ignored.map((s) => [s, '#123456']),
    t,
    'canvas',
  )
})

test('an ignored color does not change the paint', (t) => {
  const ctx = createCanvas(4, 4).getContext('2d')
  ctx.fillStyle = '#00ff00'
  ctx.fillStyle = 'red blue'
  ctx.fillRect(0, 0, 4, 4)
  t.deepEqual(px(ctx, 1, 1), [0, 255, 0, 255])

  const stroke = createCanvas(8, 8).getContext('2d')
  stroke.strokeStyle = '#00ff00'
  stroke.strokeStyle = 'red;'
  stroke.lineWidth = 4
  stroke.strokeRect(2, 2, 4, 4)
  t.deepEqual(px(stroke, 2, 2), [0, 255, 0, 255])

  const shadow = createCanvas(8, 4).getContext('2d')
  shadow.shadowColor = '#0000ff'
  shadow.shadowColor = 'red blue'
  shadow.shadowOffsetX = 4
  shadow.fillStyle = '#f00'
  shadow.fillRect(0, 0, 2, 4)
  t.deepEqual(px(shadow, 5, 1), [0, 0, 255, 255])
})

test('the none keyword in colors paints like Chrome', (t) => {
  const paints: [string, number[]][] = [
    ['hsl(0 50% 50% / none)', [0, 0, 0, 0]],
    ['hsl(none 50% 50%)', [191, 64, 64, 255]],
    ['hsl(0 none 50%)', [128, 128, 128, 255]],
    ['hsl(0 50% none)', [0, 0, 0, 255]],
    ['rgb(10 20 30 / none)', [0, 0, 0, 0]],
    ['rgb(none 20 30)', [0, 20, 30, 255]],
  ]
  for (const [input, expected] of paints) {
    const ctx = createCanvas(4, 4).getContext('2d')
    ctx.fillStyle = '#00ff00'
    ctx.fillStyle = input
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual(px(ctx, 1, 1), expected, input)
  }
  const shadow = createCanvas(8, 4).getContext('2d')
  shadow.shadowColor = 'hsl(0 50% 50% / none)'
  shadow.shadowOffsetX = 4
  shadow.fillStyle = '#f00'
  shadow.fillRect(0, 0, 2, 4)
  t.deepEqual(px(shadow, 5, 1), [0, 0, 0, 0])
})

test('an invalid shadowColor keeps the previous value', (t) => {
  const ctx = createCanvas(4, 4).getContext('2d')
  ctx.shadowColor = 'red'
  t.notThrows(() => {
    ctx.shadowColor = 'bogus'
  })
  t.is(ctx.shadowColor, '#ff0000')
})

test('currentcolor shadow paints opaque black', (t) => {
  const ctx = createCanvas(6, 4).getContext('2d')
  ctx.shadowColor = 'currentcolor'
  ctx.shadowOffsetX = 2
  ctx.fillStyle = '#00f'
  ctx.fillRect(0, 0, 2, 4)
  t.is(ctx.shadowColor, '#000000')
  t.deepEqual(px(ctx, 3, 1), [0, 0, 0, 255])
})

// A Canvas, an SvgCanvas and a PDF page, each with its 2D context.
const contexts = (): [string, () => { ctx: Ctx; resize?: () => void }][] => [
  [
    'canvas',
    () => {
      const canvas = createCanvas(20, 20)
      return { ctx: canvas.getContext('2d'), resize: () => (canvas.width = 20) }
    },
  ],
  [
    'svg',
    () => {
      const canvas = createCanvas(20, 20, SvgExportFlag.ConvertTextToPaths)
      return { ctx: canvas.getContext('2d'), resize: () => (canvas.height = 20) }
    },
  ],
  ['pdf', () => ({ ctx: new PDFDocument().beginPage(20, 20) })],
]

test('fillStyle and strokeStyle getters follow save() and restore()', (t) => {
  const sequence = (ctx: Ctx, prop: (typeof COLOR_PROPS)[number], a: string, b: string) => {
    ctx[prop] = a
    ctx.save()
    ctx[prop] = b
    const values = [ctx[prop]]
    ctx.restore()
    values.push(ctx[prop])
    ctx.restore()
    values.push(ctx[prop])
    return values
  }
  for (const [label, make] of contexts()) {
    t.deepEqual(sequence(make().ctx, 'fillStyle', '#ff0000', '#0000ff'), ['#0000ff', '#ff0000', '#ff0000'], label)
    t.deepEqual(sequence(make().ctx, 'strokeStyle', '#00ff00', '#123456'), ['#123456', '#00ff00', '#00ff00'], label)
    t.deepEqual(
      sequence(make().ctx, 'shadowColor', '#ff0000', 'rgba(0, 0, 255, 0.5)'),
      ['rgba(0, 0, 255, 0.5)', '#ff0000', '#ff0000'],
      label,
    )
    // Invalid values keep the current one; a toString() object is a string.
    const { ctx } = make()
    ctx.fillStyle = 'red'
    ctx.save()
    const values = []
    for (const value of ['notacolor', 5, null, { toString: () => 'blue' }]) {
      ctx.fillStyle = value as any
      values.push(ctx.fillStyle)
    }
    ctx.restore()
    values.push(ctx.fillStyle)
    t.deepEqual(values, ['#ff0000', '#ff0000', '#ff0000', '#0000ff', '#ff0000'], label)
  }
})

test('gradient and pattern getters keep identity across save() and restore()', (t) => {
  for (const [label, make] of contexts()) {
    const { ctx } = make()
    const g1 = ctx.createLinearGradient(0, 0, 10, 0)
    g1.addColorStop(0, 'red')
    g1.addColorStop(1, 'blue')
    const g2 = ctx.createRadialGradient(5, 5, 1, 5, 5, 5)
    const p1 = ctx.createPattern(createCanvas(2, 2), 'repeat')
    const r: unknown[] = []
    ctx.fillStyle = g1
    r.push(ctx.fillStyle === g1)
    ctx.save()
    r.push(ctx.fillStyle === g1)
    ctx.fillStyle = 'red'
    r.push(ctx.fillStyle)
    ctx.save()
    ctx.fillStyle = p1
    r.push(ctx.fillStyle === p1)
    ctx.save()
    ctx.fillStyle = g2
    r.push(ctx.fillStyle === g2)
    ctx.restore()
    r.push(ctx.fillStyle === p1)
    ctx.restore()
    r.push(ctx.fillStyle)
    ctx.restore()
    r.push(ctx.fillStyle === g1)
    ctx.restore()
    r.push(ctx.fillStyle === g1)
    ctx.strokeStyle = p1
    ctx.save()
    ctx.strokeStyle = g2
    ctx.restore()
    r.push(ctx.strokeStyle === p1)
    ctx.fillStyle = g1
    ctx.fillStyle = g1
    r.push(ctx.fillStyle === g1)
    for (let i = 0; i < 5; i++) {
      ctx.save()
      ctx.fillStyle = i % 2 ? g2 : p1
    }
    for (let i = 0; i < 5; i++) ctx.restore()
    r.push(ctx.fillStyle === g1)
    ctx.fillStyle = g2
    ctx.save()
    ctx.fillStyle = p1
    ctx.reset()
    r.push(ctx.fillStyle, ctx.strokeStyle)
    ctx.restore()
    r.push(ctx.fillStyle)
    t.deepEqual(
      r,
      [
        true,
        true,
        '#ff0000',
        true,
        true,
        true,
        '#ff0000',
        true,
        true,
        true,
        true,
        true,
        '#000000',
        '#000000',
        '#000000',
      ],
      label,
    )

    const more: unknown[] = []
    // The same gradient at two depths, then a color over it.
    ctx.fillStyle = g1
    ctx.save()
    ctx.fillStyle = g1
    ctx.fillStyle = 'red'
    ctx.restore()
    more.push(ctx.fillStyle === g1)
    // A color over the depth's own gradient, then a gradient one level up.
    ctx.fillStyle = g2
    ctx.fillStyle = 'blue'
    ctx.save()
    ctx.fillStyle = g1
    ctx.restore()
    more.push(ctx.fillStyle)
    ctx.save()
    ctx.fillStyle = g1
    ctx.restore()
    ctx.save()
    more.push(ctx.fillStyle)
    ctx.fillStyle = g2
    ctx.restore()
    more.push(ctx.fillStyle)
    ctx.fillStyle = g1
    ctx.strokeStyle = g2
    ctx.save()
    ctx.fillStyle = g2
    ctx.strokeStyle = g1
    ctx.restore()
    more.push(ctx.fillStyle === g1, ctx.strokeStyle === g2)
    // Extra restores and an invalid color keep the gradient.
    ctx.restore()
    ctx.restore()
    more.push(ctx.fillStyle === g1)
    ctx.fillStyle = 'bogus'
    more.push(ctx.fillStyle === g1)
    t.deepEqual(more, [true, '#0000ff', '#0000ff', '#0000ff', true, true, true, true], label)
  }
})

test('PDF page style defaults', (t) => {
  const ctx = new PDFDocument().beginPage(20, 20)
  t.is(ctx.fillStyle, '#000000')
  t.is(ctx.strokeStyle, '#000000')
})

test('resize clears the saved styles', (t) => {
  for (const [label, make] of contexts().slice(0, 2)) {
    const { ctx, resize } = make()
    ctx.fillStyle = 'red'
    ctx.save()
    ctx.fillStyle = 'blue'
    resize!()
    t.is(ctx.fillStyle, '#000000', label)
    ctx.restore()
    t.is(ctx.fillStyle, '#000000', label)

    const gradient = ctx.createLinearGradient(0, 0, 1, 1)
    ctx.fillStyle = gradient
    ctx.save()
    ctx.strokeStyle = gradient
    resize!()
    t.deepEqual([ctx.fillStyle, ctx.strokeStyle], ['#000000', '#000000'], label)
    ctx.restore()
    t.deepEqual([ctx.fillStyle, ctx.strokeStyle], ['#000000', '#000000'], label)
  }
})

test('paint follows restore', (t) => {
  const ctx = createCanvas(4, 4).getContext('2d')
  ctx.fillStyle = '#ff0000'
  ctx.save()
  ctx.fillStyle = '#0000ff'
  ctx.restore()
  ctx.fillRect(0, 0, 4, 4)
  t.deepEqual(px(ctx, 0, 0), [255, 0, 0, 255])
})

test('saved style objects do not pile up', (t) => {
  for (const [label, make] of contexts()) {
    const { ctx } = make()
    for (let i = 0; i < 1000; i++) {
      ctx.save()
      ctx.fillStyle = ctx.createLinearGradient(0, 0, 1, 1)
      ctx.strokeStyle = ctx.createLinearGradient(0, 0, 1, 1)
      ctx.restore()
    }
    const held = Reflect.ownKeys(ctx)
      .map((key) => Object.getOwnPropertyDescriptor(ctx, key)!.value)
      .filter(Array.isArray)
    t.true(
      held.every((array) => array.length <= 2),
      label,
    )
  }
})

// The saved gradient and pattern objects live in the JS heap: a style that
// refers back to its context does not keep the context alive.
test('a style that holds its context does not keep it alive', async (t) => {
  const script = `
const { createCanvas, SvgExportFlag } = require('./index.js')
;(async () => {
  // A plain function: an async function's block scope could keep the last
  // canvas alive.
  const make = (svg) => {
    const canvas = svg ? createCanvas(8, 8, SvgExportFlag.ConvertTextToPaths) : createCanvas(8, 8)
    const ctx = canvas.getContext('2d')
    const gradient = ctx.createLinearGradient(0, 0, 8, 0)
    const pattern = ctx.createPattern(createCanvas(2, 2), 'repeat')
    gradient.ctx = ctx
    pattern.canvas = canvas
    ctx.fillStyle = gradient
    ctx.save()
    ctx.strokeStyle = pattern
    return [new WeakRef(ctx), new WeakRef(canvas)]
  }
  const refs = [...make(false), ...make(true)]
  for (let i = 0; i < 10 && refs.some((ref) => ref.deref()); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    global.gc()
  }
  console.log(refs.map((ref) => ref.deref() === undefined).join(','))
})()
`
  const child = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
    encoding: 'utf8',
  })
  t.is(child.status, 0, child.stderr)
  t.is(child.stdout.trim(), 'true,true,true,true')
})
