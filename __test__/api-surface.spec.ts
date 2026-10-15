// The shape of the 2d API: isContextLost() and the TextMetrics class.
// Expected values were measured in Chrome 155 on arm64 macOS; emHeightAscent
// and emHeightDescent with --enable-blink-features=ExtendedTextMetrics.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, GlobalFonts } from '../index'

GlobalFonts.registerFromPath(
  join(fileURLToPath(new URL('.', import.meta.url)), 'fonts', 'Lato-Regular.ttf'),
  'LatoTest',
)

const BASELINES = ['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'] as const

// Chrome's TextMetrics prototype, in order; emHeightAscent and
// emHeightDescent are behind a flag there.
const TEXT_METRICS_KEYS = [
  'width',
  'actualBoundingBoxLeft',
  'actualBoundingBoxRight',
  'fontBoundingBoxAscent',
  'fontBoundingBoxDescent',
  'actualBoundingBoxAscent',
  'actualBoundingBoxDescent',
  'hangingBaseline',
  'alphabeticBaseline',
  'ideographicBaseline',
  'constructor',
]

test('isContextLost returns false', (t) => {
  const ctx = createCanvas(4, 4).getContext('2d')
  t.false(ctx.isContextLost())
  t.is(ctx.isContextLost.length, 0)
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ctx), 'isContextLost')!
  t.deepEqual(
    [typeof descriptor.value, descriptor.writable, descriptor.enumerable, descriptor.configurable],
    ['function', true, true, true],
  )
})

test('TextMetrics is a class with prototype getters', (t) => {
  const ctx = createCanvas(4, 4).getContext('2d')
  ctx.font = '40px LatoTest'
  const metrics = ctx.measureText('Hg')
  const proto = Object.getPrototypeOf(metrics)
  t.is(metrics.constructor.name, 'TextMetrics')
  t.deepEqual(Object.keys(metrics), [])
  t.is(JSON.stringify(metrics), '{}')
  t.is(JSON.stringify({ ...metrics }), '{}')
  t.deepEqual(
    Object.getOwnPropertyNames(proto).filter((key) => !key.startsWith('emHeight')),
    TEXT_METRICS_KEYS,
  )
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'hangingBaseline')!
  t.deepEqual(
    [typeof descriptor.get, typeof descriptor.set, descriptor.enumerable, descriptor.configurable],
    ['function', 'undefined', true, true],
  )
  // No setter: a sloppy write is ignored, a strict one throws.
  const width = metrics.width
  t.false(Reflect.set(metrics, 'width', 5))
  t.is(metrics.width, width)
  t.throws(
    () => {
      ;(metrics as any).width = 5
    },
    { instanceOf: TypeError, message: 'Cannot set property width of #<TextMetrics> which has only a getter' },
  )
  const TextMetrics = metrics.constructor as any
  const error = t.throws(() => new TextMetrics(), {
    instanceOf: TypeError,
    message: "Failed to construct 'TextMetrics': Illegal constructor",
  })
  t.is(String(error.stack).split('\n')[0], 'TypeError: Illegal constructor')
  t.deepEqual(Object.keys(error), ['message'])
})

test('TextMetrics baselines follow textBaseline', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  ctx.font = '40px LatoTest'
  ctx.textBaseline = 'alphabetic'
  const alphabetic = ctx.measureText('Hg')
  for (const baseline of BASELINES) {
    ctx.textBaseline = baseline
    const m = ctx.measureText('Hg')
    // Blink: alphabetic = -baseline_y, hanging = 0.8 * ascent - baseline_y,
    // ideographic = -descent - baseline_y (text_metrics.cc).
    t.is(m.ideographicBaseline + m.fontBoundingBoxDescent, 0, baseline)
    t.true(
      Math.abs(m.alphabeticBaseline - (m.fontBoundingBoxAscent - alphabetic.fontBoundingBoxAscent)) < 1e-4,
      baseline,
    )
    t.true(
      Math.abs(m.hangingBaseline - (0.8 * alphabetic.fontBoundingBoxAscent + m.alphabeticBaseline)) < 1e-4,
      baseline,
    )
  }
  // Each baseline is 0 at its own textBaseline (the sign of 0 aside).
  for (const [baseline, field] of [
    ['alphabetic', 'alphabeticBaseline'],
    ['hanging', 'hangingBaseline'],
    ['ideographic', 'ideographicBaseline'],
  ] as const) {
    ctx.textBaseline = baseline
    t.is(Math.abs(ctx.measureText('Hg')[field]), 0, baseline)
  }
})

test('TextMetrics em height is the OS/2 typo box scaled to the font size', (t) => {
  const ctx = createCanvas(100, 100).getContext('2d')
  // [size, emHeightAscent, emHeightDescent] at 'alphabetic'
  for (const [size, ascent, descent] of [
    [40, 32.203125, 7.796875],
    [10, 8.046875, 1.953125],
    [13, 10.46875, 2.53125],
    [50, 40.25, 9.75],
  ]) {
    ctx.font = `${size}px LatoTest`
    ctx.textBaseline = 'alphabetic'
    const m = ctx.measureText('Hg')
    t.deepEqual([m.emHeightAscent, m.emHeightDescent], [ascent, descent], `${size}px`)
    // At every baseline the box is the font size, and moves with the
    // alphabetic baseline.
    for (const baseline of BASELINES) {
      ctx.textBaseline = baseline
      const b = ctx.measureText('Hg')
      t.true(Math.abs(b.emHeightAscent + b.emHeightDescent - size) < 1e-4, `${size}px ${baseline}`)
      t.true(Math.abs(b.emHeightAscent - b.alphabeticBaseline - ascent) < 1e-4, `${size}px ${baseline}`)
    }
  }
})
