// The six non-standard CSS font properties on the 2D context
// (fontFeatureSettings, fontVariantLigatures, fontVariantNumeric,
// fontVariantPosition, fontSizeAdjust, fontOpticalSizing). Chrome's canvas has
// none of them; each getter returns what Chrome's getComputedStyle gives for
// the CSS property of the same name. The fixture is Chrome 157's CSS.supports
// and getComputedStyle for every input.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, type SKRSContext2D } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PROPS = [
  'fontFeatureSettings',
  'fontVariantLigatures',
  'fontVariantNumeric',
  'fontVariantPosition',
  'fontSizeAdjust',
  'fontOpticalSizing',
] as const
type Prop = (typeof PROPS)[number]

interface Fixture {
  chrome: string
  defaults: Record<Prop, string>
  properties: Record<Prop, [string, string | null][]>
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'text-fonts', 'font-props-parse.json'), 'utf8'),
)

// A valid value per property that no fixture input computes to by accident,
// so a rejected input visibly keeps it.
const START: Record<Prop, [string, string]> = {
  fontFeatureSettings: ['"zzzz" 5', '"zzzz" 5'],
  fontVariantLigatures: ['historical-ligatures no-contextual', 'historical-ligatures no-contextual'],
  fontVariantNumeric: ['oldstyle-nums stacked-fractions', 'oldstyle-nums stacked-fractions'],
  fontVariantPosition: ['super', 'super'],
  fontSizeAdjust: ['ic-height 0.25', 'ic-height 0.25'],
  fontOpticalSizing: ['none', 'none'],
}

// Valid CSS, but ignored by the canvas setters like Chrome's font,
// letterSpacing and filter setters ignore them: the CSS-wide keywords alone,
// any var(), and an empty or CSS-whitespace-only value.
function ignoredByCanvas(input: string) {
  const s = input.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '')
  return s === '' || /^(inherit|initial|unset|revert|revert-layer)$/i.test(s) || /var\(/i.test(input)
}

// Chrome resolves from-font against the element's font; the canvas getter
// keeps from-font (the font can change with ctx.font), with the metric.
function expected(prop: Prop, input: string, computed: string) {
  if (prop === 'fontSizeAdjust' && /from-font/i.test(input)) {
    return computed.replace(/\S+$/, 'from-font')
  }
  return computed
}

function props(ctx: SKRSContext2D) {
  return ctx as unknown as Record<Prop, unknown>
}

for (const prop of PROPS) {
  test(`${prop}: getter is Chrome's computed value, invalid input keeps the old value`, (t) => {
    const ctx = createCanvas(1, 1).getContext('2d')
    const p = props(ctx)
    const [start, startComputed] = START[prop]
    let checked = 0
    for (const [input, computed] of FIXTURE.properties[prop]) {
      p[prop] = start
      t.is(p[prop], startComputed)
      p[prop] = input
      const want = computed === null || ignoredByCanvas(input) ? startComputed : expected(prop, input, computed)
      t.is(p[prop], want, `${prop} = ${JSON.stringify(input)}`)
      checked++
    }
    t.true(checked > 20)
  })
}

test('defaults are the CSS initial values', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d')
  for (const prop of PROPS) {
    t.is(props(ctx)[prop], FIXTURE.defaults[prop], prop)
  }
  t.deepEqual(FIXTURE.defaults, {
    fontFeatureSettings: 'normal',
    fontVariantLigatures: 'normal',
    fontVariantNumeric: 'normal',
    fontVariantPosition: 'normal',
    fontSizeAdjust: 'none',
    fontOpticalSizing: 'auto',
  })
})

test('setters take a DOMString: numbers and objects are converted, null and undefined are invalid', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d')
  const p = props(ctx)
  p.fontSizeAdjust = 0.5
  t.is(ctx.fontSizeAdjust, '0.5')
  p.fontSizeAdjust = 1e21
  t.is(ctx.fontSizeAdjust, '1e+21')
  p.fontSizeAdjust = null
  t.is(ctx.fontSizeAdjust, '1e+21')
  p.fontSizeAdjust = undefined
  t.is(ctx.fontSizeAdjust, '1e+21')
  p.fontSizeAdjust = -1
  t.is(ctx.fontSizeAdjust, '1e+21')
  p.fontSizeAdjust = { toString: () => 'cap-height 0.5' }
  t.is(ctx.fontSizeAdjust, 'cap-height 0.5')
  // A number is never a valid value of the other five.
  p.fontFeatureSettings = 1
  t.is(ctx.fontFeatureSettings, 'normal')
  p.fontOpticalSizing = 0
  t.is(ctx.fontOpticalSizing, 'auto')
  p.fontVariantPosition = { toString: () => 'SUB' }
  t.is(ctx.fontVariantPosition, 'sub')
  t.throws(
    () => {
      p.fontVariantNumeric = Symbol('x')
    },
    { instanceOf: TypeError },
  )
  t.is(ctx.fontVariantNumeric, 'normal')
})

const SET: Record<Prop, [string, string]> = {
  fontFeatureSettings: ['"liga" 0, "kern"', '"kern", "liga" 0'],
  fontVariantLigatures: ['contextual no-common-ligatures', 'no-common-ligatures contextual'],
  fontVariantNumeric: ['slashed-zero tabular-nums', 'tabular-nums slashed-zero'],
  fontVariantPosition: ['SUPER', 'super'],
  fontSizeAdjust: ['Cap-Height from-font', 'cap-height from-font'],
  fontOpticalSizing: ['NONE', 'none'],
}

function setAll(ctx: SKRSContext2D) {
  for (const prop of PROPS) props(ctx)[prop] = SET[prop][0]
}

function getAll(ctx: SKRSContext2D) {
  return Object.fromEntries(PROPS.map((prop) => [prop, props(ctx)[prop]]))
}

const SET_COMPUTED = Object.fromEntries(PROPS.map((prop) => [prop, SET[prop][1]]))

test('save() and restore() keep the six', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d')
  const defaults = getAll(ctx)
  ctx.save()
  setAll(ctx)
  t.deepEqual(getAll(ctx), SET_COMPUTED)
  ctx.save()
  ctx.fontFeatureSettings = '"smcp"'
  ctx.fontSizeAdjust = '0.5'
  ctx.restore()
  t.deepEqual(getAll(ctx), SET_COMPUTED)
  ctx.restore()
  t.deepEqual(getAll(ctx), defaults)
})

test('ctx.font keeps the six, and its getter does not show them', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d')
  setAll(ctx)
  ctx.font = 'small-caps bold 20px serif'
  t.deepEqual(getAll(ctx), SET_COMPUTED)
  const plain = createCanvas(1, 1).getContext('2d')
  plain.font = 'small-caps bold 20px serif'
  t.is(ctx.font, plain.font)
  ctx.font = 'not a font'
  t.deepEqual(getAll(ctx), SET_COMPUTED)
})

test('reset() and context loss bring back the defaults', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d')
  const defaults = getAll(ctx)
  setAll(ctx)
  ctx.save()
  ctx.reset()
  t.deepEqual(getAll(ctx), defaults)

  const canvas = createCanvas(10, 10)
  const lost = canvas.getContext('2d')
  setAll(lost)
  canvas.width = 2 ** 30
  lost.fillRect(0, 0, 1, 1)
  t.true(lost.isContextLost())
  t.deepEqual(getAll(lost), defaults)
})

test('the six are context attributes; the fixture is from Chrome 157', (t) => {
  const ctx = createCanvas(1, 1).getContext('2d')
  for (const prop of PROPS) {
    t.true(prop in ctx, prop)
  }
  t.is(FIXTURE.chrome.split('.')[0], '157')
})
