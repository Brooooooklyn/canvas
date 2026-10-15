// Default state and the fillStyle / strokeStyle / shadowColor getters.
// Expected values were measured in Chrome 155 (--disable-gpu, a
// willReadFrequently canvas in a standards-mode page); arm64 and x64 gave the
// same results. SvgCanvas and PDF pages have no Chrome counterpart: they
// follow the same rules (HTML spec).
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
