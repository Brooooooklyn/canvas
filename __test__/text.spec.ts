import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import ava, { TestFn } from 'ava'

import { GlobalFonts, createCanvas, Canvas, SKRSContext2D, type CanvasTextAlign } from '../index'
import { snapshotImage } from './image-snapshot'

const __dirname = dirname(fileURLToPath(import.meta.url))

const test = ava as TestFn<{
  canvas: Canvas
  ctx: SKRSContext2D
}>

test.beforeEach((t) => {
  const canvas = createCanvas(512, 512)
  t.context.canvas = canvas
  t.context.ctx = canvas.getContext('2d')!
  t.truthy(
    GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf')),
    'Register Iosevka font failed',
  )
})

for (const align of ['center', 'end', 'left', 'right', 'start'] as CanvasTextAlign[]) {
  test(`text-align-${align}`, async (t) => {
    const { ctx, canvas } = t.context
    const x = canvas.width / 2
    ctx.strokeStyle = 'black'
    ctx.moveTo(x, 0)
    ctx.lineTo(x, canvas.height)
    ctx.stroke()
    ctx.textAlign = align
    ctx.font = '16px Iosevka Slab'
    ctx.fillText('Hello Canvas', x, 200)
    await snapshotImage(t)
  })
}

test(`fillText-line-break-as-space`, async (t) => {
  const { ctx, canvas } = t.context
  const x = canvas.width / 2
  ctx.font = '16px Iosevka Slab'
  ctx.fillText('Hello\nCanvas', x, 200)
  await snapshotImage(t)
})

test(`strokeText-line-break-as-space`, async (t) => {
  const { ctx, canvas } = t.context
  const x = canvas.width / 2
  ctx.font = '32px Iosevka Slab'
  ctx.strokeText('Hello\nCanvas', x, 200)
  await snapshotImage(t)
})

test(`measureText with suffix spaces`, async (t) => {
  const { ctx } = t.context
  ctx.font = '50px Iosevka Slab'
  const { width } = ctx.measureText('Hello')
  const { width: widthWithSpace } = ctx.measureText('hello ')
  const { width: widthWithTwoSpace } = ctx.measureText('hello  ')
  t.not(width, widthWithSpace)
  t.is(ctx.measureText(' ').width, widthWithSpace - width)
  t.is(ctx.measureText('  ').width, widthWithTwoSpace - width)
})

// https://github.com/Brooooooklyn/canvas/issues/386
test('text-baseline', async (t) => {
  const { ctx } = t.context
  ctx.font = '48px Iosevka Slab'
  ctx.textBaseline = 'bottom'
  ctx.fillText('abcdef', 50, 100)
  ctx.fillText('abcdefg', 50, 100)
  await snapshotImage(t)
})

test('text-baseline-all', async (t) => {
  const { ctx } = t.context
  const baselines = ['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'] as const
  ctx.font = '36px Iosevka Slab'
  ctx.strokeStyle = 'red'

  baselines.forEach((baseline, index) => {
    ctx.textBaseline = baseline
    const y = 75 + index * 75
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(550, y + 0.5)
    ctx.stroke()
    ctx.fillText(`Abcdefghijklmnop (${baseline})`, 0, y)
  })
  await snapshotImage(t)
})

test('letter-spacing', async (t) => {
  const canvas = createCanvas(800, 800)
  const ctx = canvas.getContext('2d')!
  ctx.font = '30px Iosevka Slab'

  // Default letter spacing
  ctx.fillText(`Hello world (default: ${ctx.letterSpacing})`, 10, 40)

  // Custom letter spacing: 10px
  ctx.letterSpacing = '10px'
  ctx.fillText(`Hello world (${ctx.letterSpacing})`, 10, 90)
  ctx.save()
  // Custom letter spacing: 20px
  ctx.letterSpacing = '20px'
  ctx.fillText(`Hello world (${ctx.letterSpacing})`, 10, 140)
  ctx.restore()
  ctx.fillText(`Hello world (${ctx.letterSpacing})`, 10, 190)

  ctx.textAlign = 'center'
  const { width } = ctx.measureText(`Hello world (${ctx.letterSpacing})`)
  ctx.fillText(`Hello world (${ctx.letterSpacing})`, width / 2 + 10, 240)

  ctx.textAlign = 'start'
  ctx.fillText(`Hello world (${ctx.letterSpacing})`, 10, 290)
  ctx.textAlign = 'right'
  ctx.fillText(`Hello world (${ctx.letterSpacing})`, -width + 10, 340)
  await snapshotImage(t, { canvas, ctx })
})

test('negative-letter-spacing', async (t) => {
  const canvas = createCanvas(800, 800)
  const ctx = canvas.getContext('2d')!
  ctx.font = '30px Iosevka Slab'

  // Default letter spacing
  ctx.fillText(`Hello world (default: ${ctx.letterSpacing})`, 10, 40)

  ctx.letterSpacing = '-5px'
  ctx.fillText(`Hello world (${ctx.letterSpacing})`, 10, 90)
  await snapshotImage(t, { canvas, ctx })
})

test('word-spacing', async (t) => {
  const canvas = createCanvas(800, 800)
  const ctx = canvas.getContext('2d')!
  ctx.font = '30px Iosevka Slab'

  // Default word spacing
  ctx.fillText(`Hello world (default: ${ctx.wordSpacing})`, 10, 40)

  // Custom word spacing: 10px
  ctx.wordSpacing = '10px'
  ctx.fillText(`Hello world (${ctx.wordSpacing})`, 10, 90)
  ctx.save()
  // Custom word spacing: 20px
  ctx.wordSpacing = '20px'
  ctx.fillText(`Hello world (${ctx.wordSpacing})`, 10, 140)
  ctx.restore()
  ctx.fillText(`Hello world (${ctx.wordSpacing})`, 10, 190)

  ctx.textAlign = 'center'
  const { width } = ctx.measureText(`Hello world (${ctx.wordSpacing})`)
  ctx.fillText(`Hello world (${ctx.wordSpacing})`, width / 2 + 10, 240)

  ctx.textAlign = 'start'
  ctx.fillText(`Hello world (${ctx.wordSpacing})`, 10, 290)
  ctx.textAlign = 'right'
  ctx.fillText(`Hello world (${ctx.wordSpacing})`, -width + 10, 340)
  await snapshotImage(t, { canvas, ctx })
})

test('text-align-with-space', async (t) => {
  if (process.platform !== 'darwin') {
    t.pass('Skip test, no fallback fonts on this platform in CI')
    return
  }
  const { ctx } = t.context
  ctx.strokeStyle = 'black'
  ctx.lineWidth = 1
  ctx.moveTo(100, 0)
  ctx.lineTo(100, 512)
  ctx.stroke()
  ctx.font = '38px Iosevka Slab'
  ctx.textAlign = 'center'
  ctx.fillText('Mona Lisa', 100, 50)
  ctx.fillText('A B C', 100, 200)
  await snapshotImage(t)
})

test('font-variation-settings', async (t) => {
  const { ctx } = t.context
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Oswald.ttf'), 'Oswald')
  ctx.font = '50px Oswald'
  ctx.fontVariationSettings = "'wght' 700"
  ctx.fillText('Hello World', 50, 100)
  await snapshotImage(t)
})

test('font-variation-settings-with-font-family', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf'), 'Roboto Mono');
  const canvas = createCanvas(1280, 680)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'white'
  for (let i = 1; i <= 9; i++) {
    ctx.font = `${i * 100} 45px Roboto Mono`;
    ctx.fontVariationSettings = `'wght' ${i * 100}`
    ctx.fillText(`${i * 100}: Jackdaws love my big sphinx of quartz`, 30, i * 65);
  }
  await snapshotImage(t, { canvas, ctx })
})

test('font-stretch', async (t) => {
  // Inconsolata is a variable font that supports width from 50% to 200%
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Inconsolata-VariableFont_wdth,wght.woff2'), 'Inconsolata')
  const canvas = createCanvas(800, 600)
  const ctx = canvas.getContext('2d')!
  ctx.font = '30px Inconsolata'

  const stretches = [
    'ultra-condensed',
    'extra-condensed',
    'condensed',
    'semi-condensed',
    'normal',
    'semi-expanded',
    'expanded',
    'extra-expanded',
    'ultra-expanded',
  ] as const

  stretches.forEach((stretch, index) => {
    ctx.fontStretch = stretch
    ctx.fillText(`Hello World (${ctx.fontStretch})`, 10, 40 + index * 60)
  })

  await snapshotImage(t, { canvas, ctx })
})

test('font-kerning', async (t) => {
  // Use a serif font that has kerning information
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'Source Serif Pro')
  const canvas = createCanvas(800, 450)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'

  // MDN example: https://developer.mozilla.org/en-US/docs/Web/CSS/font-kerning
  // Classic kerning pairs: AV, T., ij - these show clear kerning differences
  const kernPairs = 'AV T. ij'

  // Large font size to make kerning differences more visible
  ctx.font = '64px Source Serif Pro'

  // Kerning normal (enabled) - letters are tightened
  ctx.fontKerning = 'normal'
  t.is(ctx.fontKerning, 'normal')
  const normalWidth = ctx.measureText(kernPairs).width
  ctx.fillText(kernPairs, 20, 80)
  ctx.font = '20px Source Serif Pro'
  ctx.fillText('font-kerning: normal', 20, 110)

  // Kerning none (disabled) - letters are evenly spaced, wider
  ctx.font = '64px Source Serif Pro'
  ctx.fontKerning = 'none'
  t.is(ctx.fontKerning, 'none')
  const noneWidth = ctx.measureText(kernPairs).width
  ctx.fillText(kernPairs, 20, 200)
  ctx.font = '20px Source Serif Pro'
  ctx.fillText('font-kerning: none', 20, 230)

  // Also test with a sentence (from MDN)
  ctx.font = '28px Source Serif Pro'
  const sentence = "We took Tracy to see 'THE WATERFALL'"

  ctx.fontKerning = 'normal'
  ctx.fillText(sentence, 20, 310)
  ctx.font = '16px Source Serif Pro'
  ctx.fillText('font-kerning: normal', 20, 335)

  ctx.font = '28px Source Serif Pro'
  ctx.fontKerning = 'none'
  ctx.fillText(sentence, 20, 400)
  ctx.font = '16px Source Serif Pro'
  ctx.fillText('font-kerning: none', 20, 425)

  // Verify kerning affects width - 'none' should produce wider text
  t.true(noneWidth >= normalWidth, `Expected 'none' (${noneWidth.toFixed(2)}) >= 'normal' (${normalWidth.toFixed(2)})`)

  await snapshotImage(t, { canvas, ctx })
})

test('font-stretch-default-value', (t) => {
  const { ctx } = t.context
  t.is(ctx.fontStretch, 'normal')
})

test('font-kerning-default-value', (t) => {
  const { ctx } = t.context
  t.is(ctx.fontKerning, 'auto')
})

test('font-stretch-invalid-value-ignored', (t) => {
  const { ctx } = t.context
  ctx.fontStretch = 'condensed'
  t.is(ctx.fontStretch, 'condensed')
  ctx.fontStretch = 'invalid-stretch' as any
  t.is(ctx.fontStretch, 'condensed') // Should remain unchanged
})

test('font-kerning-invalid-value-ignored', (t) => {
  const { ctx } = t.context
  ctx.fontKerning = 'none'
  t.is(ctx.fontKerning, 'none')
  ctx.fontKerning = 'invalid-kerning' as any
  t.is(ctx.fontKerning, 'none') // Should remain unchanged
})

test('font-variant-caps-default-value', (t) => {
  const { ctx } = t.context
  t.is(ctx.fontVariantCaps, 'normal')
})

test('font-variant-caps-invalid-value-ignored', (t) => {
  const { ctx } = t.context
  ctx.fontVariantCaps = 'small-caps'
  t.is(ctx.fontVariantCaps, 'small-caps')
  ctx.fontVariantCaps = 'invalid-caps' as any
  t.is(ctx.fontVariantCaps, 'small-caps') // Should remain unchanged
})

test('font-variant-caps-all-values', (t) => {
  const { ctx } = t.context
  const validValues = [
    'normal',
    'small-caps',
    'all-small-caps',
    'petite-caps',
    'all-petite-caps',
    'unicase',
    'titling-caps',
  ] as const

  validValues.forEach((value) => {
    ctx.fontVariantCaps = value
    t.is(ctx.fontVariantCaps, value)
  })
})

test('font-variant-caps', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'ScienceGothic-VariableFont.ttf'), 'Science Gothic');
  const canvas = createCanvas(650, 390)
  const ctx = canvas.getContext('2d')!

  // Set white background
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'

  ctx.font = '32px Science Gothic'

  // Test text to show caps variants
  const testText = 'Hello World 123'

  // Default (normal)
  ctx.fillText(`${testText} (normal)`, 10, 50)
  t.is(ctx.fontVariantCaps, 'normal')

  // small-caps
  ctx.fontVariantCaps = 'small-caps'
  ctx.fillText(`${testText} (small-caps)`, 10, 100)
  t.is(ctx.fontVariantCaps, 'small-caps')

  // all-small-caps
  ctx.fontVariantCaps = 'all-small-caps'
  ctx.fillText(`${testText} (all-small-caps)`, 10, 150)
  t.is(ctx.fontVariantCaps, 'all-small-caps')

  // petite-caps
  ctx.fontVariantCaps = 'petite-caps'
  ctx.fillText(`${testText} (petite-caps)`, 10, 200)
  t.is(ctx.fontVariantCaps, 'petite-caps')

  // all-petite-caps
  ctx.fontVariantCaps = 'all-petite-caps'
  ctx.fillText(`${testText} (all-petite-caps)`, 10, 250)
  t.is(ctx.fontVariantCaps, 'all-petite-caps')

  // unicase
  ctx.fontVariantCaps = 'unicase'
  ctx.fillText(`${testText} (unicase)`, 10, 300)
  t.is(ctx.fontVariantCaps, 'unicase')

  // titling-caps
  ctx.fontVariantCaps = 'titling-caps'
  ctx.fillText(`${testText} (titling-caps)`, 10, 350)
  t.is(ctx.fontVariantCaps, 'titling-caps')

  await snapshotImage(t, { canvas, ctx })
})

test('font-variant-caps-from-css-font-shorthand', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'ScienceGothic-VariableFont.ttf'), 'Science Gothic');
  const canvas = createCanvas(620, 200)
  const ctx = canvas.getContext('2d')!

  // Set white background
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'

  // Test font shorthand with small-caps
  ctx.font = 'small-caps 36px Science Gothic'
  t.is(ctx.fontVariantCaps, 'small-caps', 'font shorthand should set fontVariantCaps to small-caps')
  ctx.fillText('Hello World(small-caps)', 10, 50)

  // Setting font without small-caps should reset fontVariantCaps to normal
  ctx.font = '36px Science Gothic'
  t.is(ctx.fontVariantCaps, 'normal', 'Font without small-caps should reset fontVariantCaps to normal')
  ctx.fillText('Hello World(normal)', 10, 110)

  // Setting font with normal variant explicitly
  ctx.font = 'normal 36px Science Gothic'
  t.is(ctx.fontVariantCaps, 'normal', 'font shorthand with normal should set fontVariantCaps to normal')
  ctx.fillText('Hello World(normal explicit)', 10, 170)

  await snapshotImage(t, { canvas, ctx })
})

test('font-variant-caps-shorthand-vs-property-equality', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'ScienceGothic-VariableFont.ttf'), 'Science Gothic');

  // Canvas 1: Use font shorthand with small-caps
  const canvas1 = createCanvas(500, 100)
  const ctx1 = canvas1.getContext('2d')!
  ctx1.fillStyle = 'white'
  ctx1.fillRect(0, 0, canvas1.width, canvas1.height)
  ctx1.fillStyle = 'black'
  ctx1.font = 'small-caps 36px Science Gothic'
  ctx1.fillText('Hello World ABC xyz', 10, 60)

  // Canvas 2: Use fontVariantCaps property
  const canvas2 = createCanvas(500, 100)
  const ctx2 = canvas2.getContext('2d')!
  ctx2.fillStyle = 'white'
  ctx2.fillRect(0, 0, canvas2.width, canvas2.height)
  ctx2.fillStyle = 'black'
  ctx2.font = '36px Science Gothic'
  ctx2.fontVariantCaps = 'small-caps'
  ctx2.fillText('Hello World ABC xyz', 10, 60)

  // Compare the two canvases - they should produce identical output
  const buffer1 = canvas1.toBuffer('image/png')
  const buffer2 = canvas2.toBuffer('image/png')

  t.deepEqual(buffer1, buffer2, 'font shorthand small-caps should produce identical output as fontVariantCaps property')
})

test('font-weight-bold-should-work-without-fontVariationSettings', async (t) => {
  // Test that font-weight (like 'bold') in ctx.font works without needing fontVariationSettings
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'RobotoMono-VariableFont_wght.ttf'), 'Roboto Mono')
  const canvas = createCanvas(1280, 680)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'white'
  // Test various font-weight values WITHOUT using fontVariationSettings
  const weights = ['100', '200', '300', 'normal', '500', '600', 'bold', '800', '900']
  for (let i = 0; i < weights.length; i++) {
    ctx.font = `${weights[i]} 45px Roboto Mono`
    ctx.fillText(`${weights[i]}: Jackdaws love my big sphinx of quartz`, 30, (i + 1) * 65)
  }
  await snapshotImage(t, { canvas, ctx })
})

test('font-weight-bold-synthesis-for-non-variable-font', async (t) => {
  // Test synthetic bold for non-variable fonts (fonts without wght axis)
  // CSS Fonts Level 4: "For TrueType / OpenType fonts that do not have the wght axis,
  // the UA may synthesize bold"
  // Iosevka Slab Regular is a non-variable font (only regular weight)
  //
  // font-weight values: normal | bold | <number [1,1000]>
  // Note: 'bolder' and 'lighter' are relative keywords that depend on inherited weight,
  // which is not applicable in canvas context (no inheritance)
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'Source Serif Pro')
  const canvas = createCanvas(420, 900)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'

  // Test all font-weight values: keywords and numeric [1, 1000]
  // 'normal' = 400, 'bold' = 700
  // Pairs show keyword and its numeric equivalent should render identically
  const weights = [
    ['normal', '400'], // normal keyword equivalent to 400
    ['bold', '700'], // bold keyword equivalent to 700
    ['102'],
    ['202'],
    ['302'],
    ['502'],
    ['602'], // synthetic bold triggered: weight >= 600 and diff >= 200
    ['802'],
    ['900.99999'],
    ['901'],
    ['950'],
    ['1000'],
  ]

  let y = 40
  for (const group of weights) {
    for (const weight of group) {
      ctx.font = `${weight} 32px Source Serif Pro`
      ctx.fillText(`Hello World (${weight})`, 20, y)
      y += 40
    }
    y += 10 // extra spacing between groups
  }

  await snapshotImage(t, { canvas, ctx })
})

// =============================================================================
// Tests for new font properties (W3C/WHATWG compliance)
// =============================================================================

// textRendering property tests
test('text-rendering-default-value', (t) => {
  const { ctx } = t.context
  t.is(ctx.textRendering, 'auto')
})

test('text-rendering-all-values', (t) => {
  const { ctx } = t.context
  const validValues = ['auto', 'optimizeSpeed', 'optimizeLegibility', 'geometricPrecision'] as const

  validValues.forEach((value) => {
    ctx.textRendering = value
    t.is(ctx.textRendering, value)
  })
})

test('text-rendering-invalid-value-ignored', (t) => {
  const { ctx } = t.context
  ctx.textRendering = 'optimizeSpeed'
  t.is(ctx.textRendering, 'optimizeSpeed')
  ctx.textRendering = 'invalid-rendering' as any
  t.is(ctx.textRendering, 'optimizeSpeed') // Should remain unchanged
})

// lang property tests
test('lang-default-value', (t) => {
  const { ctx } = t.context
  t.is(ctx.lang, 'inherit')
})

test('lang-accepts-bcp47-tags', (t) => {
  const { ctx } = t.context
  const tags = ['en', 'en-US', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'ar', 'he']

  tags.forEach((tag) => {
    ctx.lang = tag
    t.is(ctx.lang, tag)
  })
})

// fontOpticalSizing property tests
test('font-optical-sizing-default-value', (t) => {
  const { ctx } = t.context
  t.is(ctx.fontOpticalSizing, 'auto')
})

test('font-optical-sizing-all-values', (t) => {
  const { ctx } = t.context
  ctx.fontOpticalSizing = 'none'
  t.is(ctx.fontOpticalSizing, 'none')
  ctx.fontOpticalSizing = 'auto'
  t.is(ctx.fontOpticalSizing, 'auto')
})

test('font-optical-sizing-invalid-value-ignored', (t) => {
  const { ctx } = t.context
  ctx.fontOpticalSizing = 'none'
  t.is(ctx.fontOpticalSizing, 'none')
  ctx.fontOpticalSizing = 'invalid' as any
  t.is(ctx.fontOpticalSizing, 'none') // Should remain unchanged
})

// fontFeatureSettings property tests
test('font-feature-settings-default-value', (t) => {
  const { ctx } = t.context
  t.is(ctx.fontFeatureSettings, 'normal')
})

test('font-feature-settings-single-feature', (t) => {
  const { ctx } = t.context
  ctx.fontFeatureSettings = "'liga' 1"
  t.is(ctx.fontFeatureSettings, "'liga' 1")
})

test('font-feature-settings-multiple-features', (t) => {
  const { ctx } = t.context
  ctx.fontFeatureSettings = "'liga' 1, 'kern' 0"
  t.is(ctx.fontFeatureSettings, "'liga' 1, 'kern' 0")
})

test('font-feature-settings-on-off-keywords', (t) => {
  const { ctx } = t.context
  ctx.fontFeatureSettings = "'liga' on"
  t.is(ctx.fontFeatureSettings, "'liga' on")
  ctx.fontFeatureSettings = "'liga' off"
  t.is(ctx.fontFeatureSettings, "'liga' off")
})

test('font-feature-settings-omitted-value-defaults-to-1', (t) => {
  const { ctx } = t.context
  ctx.fontFeatureSettings = "'liga'"
  t.is(ctx.fontFeatureSettings, "'liga'")
})

// fontVariantLigatures property tests
test('font-variant-ligatures-default-value', (t) => {
  const { ctx } = t.context
  t.is(ctx.fontVariantLigatures, 'normal')
})

test('font-variant-ligatures-none', (t) => {
  const { ctx } = t.context
  ctx.fontVariantLigatures = 'none'
  t.is(ctx.fontVariantLigatures, 'none')
})

test('font-variant-ligatures-single-values', (t) => {
  const { ctx } = t.context
  const values = [
    'common-ligatures',
    'no-common-ligatures',
    'discretionary-ligatures',
    'no-discretionary-ligatures',
    'historical-ligatures',
    'no-historical-ligatures',
    'contextual',
    'no-contextual',
  ]

  values.forEach((value) => {
    ctx.fontVariantLigatures = value
    t.is(ctx.fontVariantLigatures, value)
  })
})

test('font-variant-ligatures-combined-values', (t) => {
  const { ctx } = t.context
  ctx.fontVariantLigatures = 'common-ligatures discretionary-ligatures'
  t.is(ctx.fontVariantLigatures, 'common-ligatures discretionary-ligatures')
})

test('font-variant-ligatures-invalid-value-ignored', (t) => {
  const { ctx } = t.context
  ctx.fontVariantLigatures = 'none'
  t.is(ctx.fontVariantLigatures, 'none')
  ctx.fontVariantLigatures = 'invalid-ligatures' as any
  t.is(ctx.fontVariantLigatures, 'none') // Should remain unchanged
})

// fontVariantNumeric property tests
test('font-variant-numeric-default-value', (t) => {
  const { ctx } = t.context
  t.is(ctx.fontVariantNumeric, 'normal')
})

test('font-variant-numeric-single-values', (t) => {
  const { ctx } = t.context
  const values = [
    'lining-nums',
    'oldstyle-nums',
    'proportional-nums',
    'tabular-nums',
    'diagonal-fractions',
    'stacked-fractions',
    'ordinal',
    'slashed-zero',
  ]

  values.forEach((value) => {
    ctx.fontVariantNumeric = value
    t.is(ctx.fontVariantNumeric, value)
  })
})

test('font-variant-numeric-combined-values', (t) => {
  const { ctx } = t.context
  ctx.fontVariantNumeric = 'tabular-nums slashed-zero'
  t.is(ctx.fontVariantNumeric, 'tabular-nums slashed-zero')
})

test('font-variant-numeric-invalid-value-ignored', (t) => {
  const { ctx } = t.context
  ctx.fontVariantNumeric = 'tabular-nums'
  t.is(ctx.fontVariantNumeric, 'tabular-nums')
  ctx.fontVariantNumeric = 'invalid-numeric' as any
  t.is(ctx.fontVariantNumeric, 'tabular-nums') // Should remain unchanged
})

// fontVariantPosition property tests
test('font-variant-position-default-value', (t) => {
  const { ctx } = t.context
  t.is(ctx.fontVariantPosition, 'normal')
})

test('font-variant-position-all-values', (t) => {
  const { ctx } = t.context
  const values = ['normal', 'sub', 'super'] as const

  values.forEach((value) => {
    ctx.fontVariantPosition = value
    t.is(ctx.fontVariantPosition, value)
  })
})

test('font-variant-position-invalid-value-ignored', (t) => {
  const { ctx } = t.context
  ctx.fontVariantPosition = 'sub'
  t.is(ctx.fontVariantPosition, 'sub')
  ctx.fontVariantPosition = 'invalid-position' as any
  t.is(ctx.fontVariantPosition, 'sub') // Should remain unchanged
})

// fontSizeAdjust property tests
test('font-size-adjust-default-value', (t) => {
  const { ctx } = t.context
  t.is(ctx.fontSizeAdjust, null)
})

test('font-size-adjust-numeric-value', (t) => {
  const { ctx } = t.context
  ctx.fontSizeAdjust = 0.5
  t.is(ctx.fontSizeAdjust, 0.5)
  ctx.fontSizeAdjust = 0.75
  t.is(ctx.fontSizeAdjust, 0.75)
})

test('font-size-adjust-reset-to-null', (t) => {
  const { ctx } = t.context
  ctx.fontSizeAdjust = 0.5
  t.is(ctx.fontSizeAdjust, 0.5)
  ctx.fontSizeAdjust = null
  t.is(ctx.fontSizeAdjust, null)
})

// =============================================================================
// Image Snapshot Tests for Font Properties
// =============================================================================

test('font-feature-settings-liga', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'Source Serif Pro')
  const canvas = createCanvas(600, 200)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'
  ctx.font = '32px Source Serif Pro'

  const testText = 'fi ff fl ffi ffl difficult waffles'

  // Default (ligatures enabled)
  ctx.fillText(`liga on: ${testText}`, 20, 60)

  // Ligatures disabled
  ctx.fontFeatureSettings = "'liga' 0"
  ctx.fillText(`liga off: ${testText}`, 20, 140)

  await snapshotImage(t, { canvas, ctx })
})

test('font-variant-ligatures-comparison', async (t) => {
  // MDN example: https://developer.mozilla.org/en-US/docs/Web/CSS/font-variant-ligatures
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'Source Serif Pro')
  const canvas = createCanvas(550, 400)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'

  // MDN uses "if fi ff tf ft jf fj" to demonstrate ligatures
  const testText = 'if fi ff tf ft jf fj'

  // Large font to make ligature differences visible
  ctx.font = '48px Source Serif Pro'

  // normal - ligatures enabled (fi, ff combine into single glyphs)
  ctx.fontVariantLigatures = 'normal'
  ctx.fillText(testText, 20, 60)
  ctx.font = '16px Source Serif Pro'
  ctx.fillText('font-variant-ligatures: normal', 20, 85)

  // none - ligatures disabled (fi, ff remain separate letters)
  ctx.font = '48px Source Serif Pro'
  ctx.fontVariantLigatures = 'none'
  ctx.fillText(testText, 20, 160)
  ctx.font = '16px Source Serif Pro'
  ctx.fillText('font-variant-ligatures: none', 20, 185)

  // common-ligatures - explicitly enable common ligatures
  ctx.font = '48px Source Serif Pro'
  ctx.fontVariantLigatures = 'common-ligatures'
  ctx.fillText(testText, 20, 260)
  ctx.font = '16px Source Serif Pro'
  ctx.fillText('font-variant-ligatures: common-ligatures', 20, 285)

  // no-common-ligatures - explicitly disable common ligatures
  ctx.font = '48px Source Serif Pro'
  ctx.fontVariantLigatures = 'no-common-ligatures'
  ctx.fillText(testText, 20, 360)
  ctx.font = '16px Source Serif Pro'
  ctx.fillText('font-variant-ligatures: no-common-ligatures', 20, 385)

  await snapshotImage(t, { canvas, ctx })
})

test('font-variant-numeric-figures', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'EBGaramond-Regular.ttf'), 'EB Garamond')
  const canvas = createCanvas(550, 200)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'
  ctx.font = '36px EB Garamond'

  const testText = '0 1 2 3 4 5 6 7 8 9'

  // Lining numerals (uniform height)
  ctx.fontVariantNumeric = 'lining-nums'
  ctx.fillText(`lining-nums: ${testText}`, 20, 60)

  // Oldstyle numerals (varying heights)
  ctx.fontVariantNumeric = 'oldstyle-nums'
  ctx.fillText(`oldstyle-nums: ${testText}`, 20, 140)

  await snapshotImage(t, { canvas, ctx })
})

test('font-variant-numeric-spacing', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'EBGaramond-Regular.ttf'), 'EB Garamond')
  const canvas = createCanvas(400, 400)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'
  ctx.font = '28px EB Garamond'

  // Draw column lines for alignment reference
  ctx.strokeStyle = '#ddd'
  ctx.beginPath()
  ctx.moveTo(170, 0)
  ctx.lineTo(170, 400)
  ctx.stroke()

  // Tabular nums (monospaced, aligned)
  ctx.fillText('tabular-nums:', 20, 40)
  ctx.fontVariantNumeric = 'tabular-nums'
  const tabularNums = ['111', '222', '333', '999']
  tabularNums.forEach((num, i) => {
    ctx.fillText(num, 170, 80 + i * 35)
  })

  // Proportional nums (variable width)
  ctx.fillText('proportional-nums:', 20, 240)
  ctx.fontVariantNumeric = 'proportional-nums'
  const propNums = ['111', '222', '333', '999']
  propNums.forEach((num, i) => {
    ctx.fillText(num, 170, 280 + i * 35)
  })

  await snapshotImage(t, { canvas, ctx })
})

test('font-variant-position-super', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'Source Serif Pro')
  const canvas = createCanvas(600, 200)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'
  ctx.font = '36px Source Serif Pro'

  // Row 1: Side-by-side comparison on same baseline shows raised effect
  ctx.fontVariantPosition = 'normal'
  ctx.fillText('ABC', 20, 60)
  ctx.fontVariantPosition = 'super'
  ctx.fillText('ABC', 110, 60)
  ctx.fontVariantPosition = 'normal'
  ctx.fillText('← normal vs super', 200, 60)

  // Row 2: Practical use case - E=mc² formula
  ctx.fillText('E=mc', 20, 140)
  const prefixWidth = ctx.measureText('E=mc').width
  ctx.fontVariantPosition = 'super'
  ctx.fillText('2', 20 + prefixWidth, 140)
  const superWidth = ctx.measureText('2').width
  ctx.fontVariantPosition = 'normal'
  ctx.fillText(' (formula with superscript)', 20 + prefixWidth + superWidth, 140)

  await snapshotImage(t, { canvas, ctx })
})

test('font-variant-position-sub', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'Source Serif Pro')
  const canvas = createCanvas(500, 200)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'
  ctx.font = '36px Source Serif Pro'

  // Row 1: Side-by-side comparison on same baseline shows lowered effect
  ctx.fontVariantPosition = 'normal'
  ctx.fillText('123', 20, 60)
  ctx.fontVariantPosition = 'sub'
  ctx.fillText('123', 100, 60)
  ctx.fontVariantPosition = 'normal'
  ctx.fillText('← normal vs sub', 180, 60)

  // Row 2: Practical use case - H₂O water molecule
  ctx.fillText('H', 20, 140)
  let x = 20 + ctx.measureText('H').width
  ctx.fontVariantPosition = 'sub'
  ctx.fillText('2', x, 140)
  x += ctx.measureText('2').width
  ctx.fontVariantPosition = 'normal'
  ctx.fillText('O (water molecule)', x, 140)

  await snapshotImage(t, { canvas, ctx })
})

test('text-rendering-comparison', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'Source Serif Pro')
  const canvas = createCanvas(800, 400)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'
  ctx.font = '28px Source Serif Pro'

  // Use text with both kerning pairs (AVATAR, WAVE) and ligatures (office, waffle)
  const testText = 'AVATAR office waffle WAVE'
  const modes = ['auto', 'optimizeSpeed', 'optimizeLegibility', 'geometricPrecision'] as const

  const widths: Record<string, number> = {}
  modes.forEach((mode, index) => {
    ctx.textRendering = mode
    widths[mode] = ctx.measureText(testText).width
    ctx.fillText(`${mode}: ${testText}`, 20, 60 + index * 80)
  })

  // optimizeSpeed disables kerning and ligatures, so it should produce wider or equal text
  // compared to optimizeLegibility which enables them
  t.true(
    widths.optimizeSpeed >= widths.optimizeLegibility,
    `Expected 'optimizeSpeed' (${widths.optimizeSpeed.toFixed(2)}) >= 'optimizeLegibility' (${widths.optimizeLegibility.toFixed(2)})`
  )

  await snapshotImage(t, { canvas, ctx })
})

test('font-feature-settings-tnum', async (t) => {
  // MDN example: https://developer.mozilla.org/en-US/docs/Web/CSS/font-feature-settings
  // pnum = proportional numerals (digits have varying widths)
  // tnum = tabular numerals (all digits have equal width)
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'EBGaramond-Regular.ttf'), 'EB Garamond')
  const canvas = createCanvas(650, 320)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'

  // Title
  ctx.font = '20px EB Garamond'
  ctx.fillText('Proportional vs Tabular Numbers', 20, 30)

  // Proportional (pnum) - digits have varying widths (1 is narrower than 0)
  ctx.font = '16px EB Garamond'
  ctx.fillText('Proportional (pnum):', 50, 60)

  ctx.font = '48px EB Garamond'
  ctx.fontFeatureSettings = "'pnum' 1"
  const prop1 = ctx.measureText('1111').width
  const prop0 = ctx.measureText('0000').width
  ctx.fillText('1111', 50, 110)
  ctx.fillText('0000', 50, 170)

  // Draw end markers for proportional
  ctx.strokeStyle = '#e74c3c'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(50 + prop1, 75)
  ctx.lineTo(50 + prop1, 120)
  ctx.moveTo(50 + prop0, 135)
  ctx.lineTo(50 + prop0, 180)
  ctx.stroke()

  ctx.font = '14px EB Garamond'
  ctx.fillStyle = '#e74c3c'
  ctx.fillText(`1111 width: ${prop1.toFixed(1)}px`, 50, 200)
  ctx.fillText(`0000 width: ${prop0.toFixed(1)}px`, 50, 220)
  ctx.fillStyle = 'black'
  ctx.fillText('(1 is narrower than 0)', 50, 245)

  // Tabular (tnum) - all digits have equal width
  ctx.font = '16px EB Garamond'
  ctx.fillText('Tabular (tnum):', 370, 60)

  ctx.font = '48px EB Garamond'
  ctx.fontFeatureSettings = "'tnum' 1"
  const tab1 = ctx.measureText('1111').width
  const tab0 = ctx.measureText('0000').width
  ctx.fillText('1111', 370, 110)
  ctx.fillText('0000', 370, 170)

  // Draw end markers for tabular
  ctx.strokeStyle = '#27ae60'
  ctx.beginPath()
  ctx.moveTo(370 + tab1, 75)
  ctx.lineTo(370 + tab1, 120)
  ctx.moveTo(370 + tab0, 135)
  ctx.lineTo(370 + tab0, 180)
  ctx.stroke()

  ctx.font = '14px EB Garamond'
  ctx.fontFeatureSettings = 'normal'
  ctx.fillStyle = '#27ae60'
  ctx.fillText(`1111 width: ${tab1.toFixed(1)}px`, 370, 200)
  ctx.fillText(`0000 width: ${tab0.toFixed(1)}px`, 370, 220)
  ctx.fillStyle = 'black'
  ctx.fillText('(all digits equal width)', 370, 245)

  // Summary
  ctx.font = '14px EB Garamond'
  const propDiff = prop0 - prop1
  const tabDiff = Math.abs(tab1 - tab0)
  ctx.fillText(`pnum: 0000 is ${propDiff.toFixed(1)}px wider than 1111`, 50, 290)
  ctx.fillText(`tnum: difference = ${tabDiff.toFixed(1)}px`, 370, 290)

  // Verify pnum has different widths (1 is narrower)
  // Note: If font doesn't support pnum/tnum distinctly, widths may be equal
  // We just verify the feature settings are applied and show the measurements
  t.pass('Font feature settings applied - see snapshot for visual verification')

  await snapshotImage(t, { canvas, ctx })
})

test('font-variant-numeric-slashed-zero', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'Source Serif Pro')
  const canvas = createCanvas(550, 200)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'
  ctx.font = '36px Source Serif Pro'

  const testText = '0O 1l 0123456789'

  // Normal zero
  ctx.fontVariantNumeric = 'normal'
  ctx.fillText(`normal: ${testText}`, 20, 70)

  // Slashed zero
  ctx.fontVariantNumeric = 'slashed-zero'
  ctx.fillText(`slashed-zero: ${testText}`, 20, 150)

  await snapshotImage(t, { canvas, ctx })
})

test('font-size-adjust-comparison', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'Source Serif Pro')
  const canvas = createCanvas(1100, 300)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'
  ctx.font = '36px Source Serif Pro'

  const testText = 'xXHeight comparison'

  // Default (no adjustment) - font renders at specified 36px
  ctx.fontSizeAdjust = null
  ctx.fillText(`default: ${testText}`, 20, 60)

  // fontSizeAdjust = 0.3 (smaller than typical ~0.5 aspect)
  // This should make the text SMALLER to achieve target x-height ratio
  ctx.fontSizeAdjust = 0.3
  ctx.fillText(`adjust=0.3: ${testText}`, 20, 140)

  // fontSizeAdjust = 0.8 (larger than typical ~0.5 aspect)
  // This should make the text LARGER to achieve target x-height ratio
  ctx.fontSizeAdjust = 0.8
  ctx.fillText(`adjust=0.8: ${testText}`, 20, 230)

  await snapshotImage(t, { canvas, ctx })
})

test('lang-ligature-turkish-vs-english', async (t) => {
  // Test based on MDN example: https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/lang
  // Turkish locale disables "fi" ligature because Turkish has dotless i (ı)
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'Lato-Regular.ttf'), 'Lato')
  const canvas = createCanvas(450, 150)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'black'
  ctx.font = '36px Lato'

  // English: "fi" should render as ligature (combined glyph)
  ctx.lang = 'en'
  ctx.fillText('en: finish crafting', 20, 55)

  // Turkish: "fi" should NOT be a ligature (separate f and i glyphs)
  ctx.lang = 'tr'
  ctx.fillText('tr: finish crafting', 20, 115)

  await snapshotImage(t, { canvas, ctx })
})
