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
  const canvas = createCanvas(600, 300)
  const ctx = canvas.getContext('2d')!
  ctx.font = '48px Source Serif Pro'

  // Test text with common kerning pairs: AV, Ta, We
  const testText = 'AVA Ta We'

  // Default (auto)
  ctx.fillText(`${testText} (auto)`, 10, 60)
  t.is(ctx.fontKerning, 'auto')

  // Kerning normal
  ctx.fontKerning = 'normal'
  ctx.fillText(`${testText} (normal)`, 10, 140)
  t.is(ctx.fontKerning, 'normal')

  // Kerning none - characters should be evenly spread
  ctx.fontKerning = 'none'
  ctx.fillText(`${testText} (none)`, 10, 220)
  t.is(ctx.fontKerning, 'none')

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

test('direction-all-values', (t) => {
  const { ctx } = t.context
  const validValues = [
    'ltr',
    'rtl',
    'inherit',
  ] as const

  validValues.forEach((value) => {
    ctx.direction = value
    if (value === 'inherit') {
      t.is(ctx.direction, 'ltr')
    } else {
      t.is(ctx.direction, value)
    }
  })
})

// MDN example: https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/direction
test('direction-letter-spacing', async (t) => {
  const canvas = createCanvas(600, 360)
  const ctx = canvas.getContext('2d')!
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'ScienceGothic-VariableFont.ttf'), 'Science Gothic')
  const x = canvas.width / 2

  // 1. Fill background first
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // 2. Draw center line
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, canvas.height)
  ctx.strokeStyle = 'green'
  ctx.stroke()

  ctx.font = '45px Science Gothic'
  ctx.fillStyle = 'black'
  ctx.letterSpacing = '20px'

  // First line: default direction (should be ltr)
  ctx.fillText('Hi!', x, 50)
  // Second line: rtl direction - "Hi!" should become "!Hi" visually
  ctx.direction = 'rtl'
  ctx.fillText('Hi!', x, 130)

  ctx.letterSpacing = '12.832px'
  ctx.fillText('Hello world!', x, 210, 236.21)
  ctx.direction = 'ltr'
  ctx.fillText('Hello world!', x, 280, 236.21)

  await snapshotImage(t, { canvas, ctx })
})

function drawDirectionAlignTest(
  ctx: SKRSContext2D,
  { text, maxWidth, letterSpacing }: { text?: string; maxWidth?: number; letterSpacing: string },
) {
  const canvas = ctx.canvas
  const x = canvas.width / 2

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Draw center line
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, canvas.height)
  ctx.strokeStyle = 'green'
  ctx.stroke()

  ctx.font = '48px Science Gothic'
  ctx.fillStyle = 'black'
  ctx.letterSpacing = letterSpacing

  const getText = (dir: string, align: string) => text ?? `${dir} ${align}!`

  // ltr align (start = left in ltr)
  ctx.direction = 'ltr'
  ctx.fillText(getText('ltr', 'start'), 0, 50, maxWidth)
  ctx.direction = 'inherit' // inherit = ltr
  ctx.textAlign = 'left'
  ctx.fillText(getText('ltr', 'left'), 0, 100, maxWidth)

  ctx.textAlign = 'center'
  ctx.fillText(getText('ltr', 'center'), x, 150, maxWidth)

  // end = right in ltr
  ctx.textAlign = 'end'
  ctx.fillText(getText('ltr', 'end'), canvas.width, 200, maxWidth)
  ctx.textAlign = 'right'
  ctx.fillText(getText('ltr', 'right'), canvas.width, 250, maxWidth)

  // rtl align (start = right in rtl)
  ctx.direction = 'rtl'
  ctx.textAlign = 'start'
  ctx.fillText(getText('rtl', 'start'), canvas.width, 350, maxWidth)
  ctx.textAlign = 'right'
  ctx.fillText(getText('rtl', 'right'), canvas.width, 400, maxWidth)

  ctx.textAlign = 'center'
  ctx.fillText(getText('rtl', 'center'), x, 450, maxWidth)

  // end = left in rtl
  ctx.textAlign = 'end'
  ctx.fillText(getText('rtl', 'end'), 0, 500, maxWidth)
  ctx.textAlign = 'left'
  ctx.fillText(getText('rtl', 'left'), 0, 550, maxWidth)
}

test('direction-align', async (t) => {
  const canvas = createCanvas(500, 580)
  const ctx = canvas.getContext('2d')!
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'ScienceGothic-VariableFont.ttf'), 'Science Gothic')
  drawDirectionAlignTest(ctx, { letterSpacing: '3px' })
  await snapshotImage(t, { canvas, ctx })
})

test('direction-align-max-width', async (t) => {
  const canvas = createCanvas(500, 580)
  const ctx = canvas.getContext('2d')!
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'ScienceGothic-VariableFont.ttf'), 'Science Gothic')
  drawDirectionAlignTest(ctx, { text: 'Hello!', maxWidth: 160, letterSpacing: '20px' })
  await snapshotImage(t, { canvas, ctx })
})

test('direction-save-restore', async (t) => {
  const canvas = createCanvas(400, 160)
  const ctx = canvas.getContext('2d')!
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'ScienceGothic-VariableFont.ttf'), 'Science Gothic')

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.font = '38px Science Gothic'
  ctx.fillStyle = 'black'

  // Default direction
  ctx.fillText(`direction: ${ctx.direction}`, 0, 50)

  ctx.save()
  ctx.direction = 'rtl'
  ctx.fillText(`direction: ${ctx.direction}`, canvas.width, 90)
  ctx.restore()

  // Should be back to default after restore
  ctx.fillText(`direction: ${ctx.direction}`, 0, 130)

  t.is(ctx.direction, 'ltr')
  await snapshotImage(t, { canvas, ctx })
})

test('direction-stroke-letter-spacing', async (t) => {
  const canvas = createCanvas(500, 260)
  const ctx = canvas.getContext('2d')!
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf'), 'Source Serif Pro')
  const x = canvas.width / 2

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Draw center line
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, canvas.height)
  ctx.strokeStyle = 'green'
  ctx.stroke()

  ctx.font = '38px Source Serif Pro'
  ctx.letterSpacing = '10px'

  // LTR with letterSpacing
  ctx.direction = 'ltr'
  ctx.fillStyle = 'black'
  ctx.fillText('LTR text', x, 50)
  ctx.strokeStyle = 'blue'
  ctx.lineWidth = 1.5
  ctx.strokeText('LTR text', x, 100)

  // RTL with letterSpacing
  ctx.direction = 'rtl'
  ctx.fillStyle = 'black'
  ctx.fillText('RTL text', x, 170)
  ctx.strokeStyle = 'red'
  ctx.strokeText('RTL text', x, 220)

  await snapshotImage(t, { canvas, ctx })
})

test('direction-negative-letter-spacing', async (t) => {
  const canvas = createCanvas(500, 200)
  const ctx = canvas.getContext('2d')!
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'ScienceGothic-VariableFont.ttf'), 'Science Gothic')
  const x = canvas.width / 2

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Draw center line
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, canvas.height)
  ctx.strokeStyle = 'green'
  ctx.stroke()

  ctx.font = '40px Science Gothic'
  ctx.fillStyle = 'black'
  ctx.letterSpacing = '-5px'

  ctx.direction = 'ltr'
  ctx.fillText('Negative', x, 60)

  ctx.direction = 'rtl'
  ctx.fillText('Negative', x, 140)

  await snapshotImage(t, { canvas, ctx })
})

// Ensure that measureText.width is exactly the same in LRT and RTL.
// This is consistent with the behavior of Chrome and Firefox.
test('direction-measure-text', (t) => {
  const canvas = createCanvas(400, 100)
  const ctx = canvas.getContext('2d')!
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'ScienceGothic-VariableFont.ttf'), 'Science Gothic')

  ctx.font = '38px Science Gothic'

  // Test without internal spaces
  const textNoSpaces = 'Hello'
  ctx.direction = 'ltr'
  const ltrMetrics1 = ctx.measureText(textNoSpaces)
  ctx.direction = 'rtl'
  const rtlMetrics1 = ctx.measureText(textNoSpaces)
  t.is(ltrMetrics1.width, rtlMetrics1.width, 'Text without spaces should have same width in LTR and RTL')

  // Test with internal spaces
  const textWithSpaces = 'Hello World!'
  ctx.direction = 'ltr'
  const ltrMetrics2 = ctx.measureText(textWithSpaces)
  ctx.direction = 'rtl'
  const rtlMetrics2 = ctx.measureText(textWithSpaces)
  t.is(ltrMetrics2.width, rtlMetrics2.width, 'Text with spaces should have same width in LTR and RTL')

  // Test with trailing spaces
  const textTrailingSpace = '  Hello World '
  ctx.direction = 'ltr'
  const ltrMetrics3 = ctx.measureText(textTrailingSpace)
  ctx.direction = 'rtl'
  const rtlMetrics3 = ctx.measureText(textTrailingSpace)
  t.is(ltrMetrics3.width, rtlMetrics3.width, 'Text with trailing space should have same width in LTR and RTL')
})
