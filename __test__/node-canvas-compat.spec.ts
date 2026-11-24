import { once } from 'node:events'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { inflateSync } from 'node:zlib'

import test from 'ava'

import {
  createCanvas,
  createImageData,
  registerFont,
  deregisterAllFonts,
  loadImage,
  Canvas,
  Image,
  ImageData,
  PNGStream,
  JPEGStream,
  CanvasRenderingContext2D,
  Context2d,
  DOMPoint,
  DOMMatrix,
  GlobalFonts,
} from '../node-canvas'
import type { FontFaceDescriptors } from '../index'
import { createCanvas as nativeCreateCanvas } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fontPath = join(__dirname, 'fonts', 'SourceSerifPro-Regular.ttf')

// The native functions node-canvas.js registerFont and deregisterAllFonts
// call (not API), read from the binding at each call so a test can stub them.
const binding = createRequire(import.meta.url)('../js-binding.js') as {
  _registerFontFace: (path: string, family: string, weight: string, style: string) => boolean
  _releaseFontFaces: () => boolean
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test('exports all expected symbols', (t) => {
  t.is(typeof createCanvas, 'function')
  t.is(typeof createImageData, 'function')
  t.is(typeof registerFont, 'function')
  t.is(typeof deregisterAllFonts, 'function')
  t.is(typeof loadImage, 'function')
  t.truthy(Canvas)
  t.truthy(Image)
  t.truthy(ImageData)
  t.truthy(PNGStream)
  t.truthy(JPEGStream)
  t.truthy(CanvasRenderingContext2D)
  t.is(Context2d, CanvasRenderingContext2D, 'Context2d should be an alias')
  t.truthy(DOMPoint)
  t.truthy(DOMMatrix)
  t.truthy(GlobalFonts)
})

// ---------------------------------------------------------------------------
// createCanvas
// ---------------------------------------------------------------------------

test('createCanvas returns a canvas with compat methods', (t) => {
  const canvas = createCanvas(100, 100)
  t.is(canvas.width, 100)
  t.is(canvas.height, 100)
  t.is(typeof canvas.getContext, 'function')
  t.is(typeof canvas.createPNGStream, 'function')
  t.is(typeof canvas.createJPEGStream, 'function')
  t.is(typeof canvas.toBuffer, 'function')
  t.is(typeof canvas.toDataURL, 'function')
})

test('new Canvas() returns a canvas with compat methods', async (t) => {
  const canvas = new Canvas(100, 100)
  t.is(canvas.width, 100)
  t.is(canvas.height, 100)
  t.is(typeof canvas.createPNGStream, 'function')
  t.is(typeof canvas.createJPEGStream, 'function')
  t.is(typeof canvas.toBuffer, 'function')
  t.is(typeof canvas.toDataURL, 'function')
  // instanceof should still work
  const { Canvas: OrigCanvas } = await import('../index')
  t.true(canvas instanceof OrigCanvas)
})

test('new Canvas() with SvgExportFlag does not get raster compat methods', async (t) => {
  const { SvgExportFlag } = await import('../index')
  const canvas = new Canvas(100, 100, SvgExportFlag.NoPrettyXML)
  t.is(canvas.width, 100)
  t.is(typeof (canvas as any).getContent, 'function')
  // SVG canvas should NOT have raster compat methods
  t.is(typeof (canvas as any).createPNGStream, 'undefined')
  t.is(typeof (canvas as any).createJPEGStream, 'undefined')
})

test('createCanvas 2d context works', (t) => {
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')
  t.truthy(ctx)
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 100, 100)
  t.pass()
})

// ---------------------------------------------------------------------------
// registerFont
// ---------------------------------------------------------------------------

test.serial('registerFont accepts node-canvas style arguments', (t) => {
  t.notThrows(() => {
    registerFont(fontPath, { family: 'TestSourceSerif' })
  })
  t.true(GlobalFonts.has('TestSourceSerif'))
})

test('registerFont throws without family', (t) => {
  t.throws(
    () => {
      // @ts-expect-error testing invalid args
      registerFont(fontPath, {})
    },
    { instanceOf: TypeError },
  )
  t.throws(
    () => {
      // @ts-expect-error testing invalid args
      registerFont(fontPath)
    },
    { instanceOf: TypeError },
  )
})

test('registerFont throws for invalid font path', (t) => {
  t.throws(
    () => {
      registerFont('/nonexistent/path/font.ttf', { family: 'NonexistentFont' })
    },
    { instanceOf: Error, message: /Failed to register font/ },
  )
})

test.serial('registerFont accepts weight and style (compat)', (t) => {
  t.notThrows(() => {
    registerFont(fontPath, { family: 'TestSourceSerifWeighted', weight: 'bold', style: 'italic' })
  })
  t.true(GlobalFonts.has('TestSourceSerifWeighted'))
})

// registerFont passes weight and style as @font-face descriptors (#1472): one
// call per face file picks each face. RMStatic is monospaced, so the faces are
// told apart by their pixels, not their widths. The references are registered
// from Buffers: a reference on the same path would share a FontKey with the
// compat face, and deregisterAllFonts would remove it.
const fixture = (name: string) => join(__dirname, 'fonts', name)
const RM_FACES = ['Regular', 'Bold', 'Italic', 'BoldItalic'] as const
for (const face of RM_FACES) {
  GlobalFonts.register(readFileSync(fixture(`RMStatic-${face}.ttf`)), `Compat Ref ${face}`)
}
const robotoMonoPath = fixture('RobotoMono-VariableFont_wght.ttf')
GlobalFonts.register(readFileSync(robotoMonoPath), 'Compat Ref RobotoMono')

function drawText(font: string, variations = 'normal') {
  const ctx = createCanvas(420, 60).getContext('2d')
  ctx.font = font
  ctx.fontVariationSettings = variations
  ctx.fillText('Hamburgefonstiv', 10, 42)
  return Buffer.from(ctx.getImageData(0, 0, 420, 60).data)
}

// The reference face (and the synthesis on it) that draws `request` in `family`.
function faceOf(request: string, family: string) {
  const pixels = drawText(`${request} 30px "${family}"`)
  for (const face of RM_FACES) {
    for (const [synthesis, prefix] of [
      ['', ''],
      ['+synthetic bold', 'bold '],
      ['+synthetic italic', 'italic '],
    ]) {
      if (pixels.equals(drawText(`${prefix}30px "Compat Ref ${face}"`))) return face + synthesis
    }
  }
  return 'unknown'
}

const REQUESTS = ['normal', 'bold', 'italic', 'italic bold']
const facesOf = (family: string) => REQUESTS.map((request) => faceOf(request, family))

test.serial('registerFont picks each face of a family by its weight and style', (t) => {
  const family = 'Compat 1472 Four'
  registerFont(fixture('RMStatic-Regular.ttf'), { family })
  registerFont(fixture('RMStatic-Bold.ttf'), { family, weight: 'bold' })
  registerFont(fixture('RMStatic-Italic.ttf'), { family, style: 'italic' })
  registerFont(fixture('RMStatic-BoldItalic.ttf'), { family, weight: '700', style: 'italic' })
  t.deepEqual(facesOf(family), ['Regular', 'Bold', 'Italic', 'BoldItalic'])
})

test.serial('registerFont face choice does not depend on the registration order', (t) => {
  const family = 'Compat 1472 Reverse'
  registerFont(fixture('RMStatic-Italic.ttf'), { family, weight: '400', style: 'italic' })
  registerFont(fixture('RMStatic-Bold.ttf'), { family, weight: '700', style: 'normal' })
  registerFont(fixture('RMStatic-Regular.ttf'), { family, weight: '400', style: 'normal' })
  t.deepEqual(facesOf(family), ['Regular', 'Bold', 'Italic', 'Italic+synthetic bold'])
})

test.serial('registerFont accepts a numeric weight', (t) => {
  const family = 'Compat 1472 Numeric'
  registerFont(fixture('RMStatic-Regular.ttf'), { family, weight: 400 })
  registerFont(fixture('RMStatic-Bold.ttf'), { family, weight: 700 })
  t.is(faceOf('normal', family), 'Regular')
  t.is(faceOf('bold', family), 'Bold')
})

test.serial('registerFont treats values the @font-face grammar rejects as not given', (t) => {
  const family = 'Compat 1472 Invalid'
  const values: Array<Record<string, unknown>> = [
    { weight: 'bolder' },
    { weight: 'lighter' },
    { weight: '' },
    { weight: null },
    { weight: 0 },
    { weight: 'light' },
    { weight: '1001' },
    { style: '' },
    { style: 1 },
    { style: 'slanted' },
    { style: 'oblique 10' },
    { weight: 'bolder', style: '' },
    { weight: 'bolder /* inherited */' },
  ]
  for (const value of values) {
    t.notThrows(() => registerFont(fixture('RMStatic-Regular.ttf'), { family: `${family} Junk`, ...value }))
  }
  // The valid field is kept: this face still serves italic requests.
  registerFont(fixture('RMStatic-Regular.ttf'), { family, weight: '400', style: 'normal' })
  registerFont(fixture('RMStatic-Italic.ttf'), { family, weight: 'bolder /* inherited */', style: 'italic' })
  t.is(faceOf('normal', family), 'Regular')
  t.is(faceOf('italic', family), 'Italic')
})

// A null from the registration also means the file failed to load, so a
// valid descriptor is never retried as `auto` (that could reuse another
// registration's key and lose the face without an error).
test.serial('registerFont throws when a valid descriptor fails, without a retry', (t) => {
  const original = binding._registerFontFace
  const calls: unknown[] = []
  binding._registerFontFace = (_path, _family, weight, style) => {
    calls.push([weight, style])
    return false
  }
  try {
    t.throws(() => registerFont(fixture('RMStatic-Bold.ttf'), { family: 'Compat 1472 No Retry', weight: 'bold' }), {
      message: /Failed to register font/,
    })
  } finally {
    binding._registerFontFace = original
  }
  t.deepEqual(calls, [['bold', 'auto']])
})

// registerFont reads `weight` and `style` each on its own, natively, as
// registerFromPath reads them: a value the @font-face grammar rejects counts
// as not given (`auto`) and the other field is kept; one it accepts
// (calc() too) is honoured. Each face is drawn against a registerFromPath
// reference declared with what registerFont should have kept.
test.serial('registerFont reads each descriptor with the native @font-face grammar', async (t) => {
  const file = fixture('RMStatic-Regular.ttf')
  const cases: Array<['weight' | 'style', string]> = [
    ...[
      'bold',
      'BOLD',
      '/**/bold',
      'bold /* x */',
      '700',
      ' 700 ',
      '1',
      '1000',
      '1e3',
      '+700',
      '100 900',
      'normal',
      'auto',
      'calc(700)',
      'calc(350 * 2)',
      'CALC(700)',
      'calc(2000)',
    ].map((v) => ['weight', v] as ['weight', string]),
    ...[
      'bolder',
      'lighter',
      'light',
      '',
      ' ',
      '0',
      '1001',
      '-5',
      '1e400',
      '.5',
      'x-bold',
      '700px',
      '70%',
      '10e',
      '100 2000',
      '100 bold',
      'normal bold',
      '100 200 300',
      'calc(',
      'var(--font-weight)',
      "'bold'",
      '700,800',
    ].map((v) => ['weight', v] as ['weight', string]),
    ...[
      'normal',
      'italic',
      'Italic',
      'OBLIQUE',
      'auto',
      'oblique 10deg',
      'oblique  -90deg 90deg',
      'oblique 2rad',
      'oblique 1turn',
      'oblique 20deg 10deg',
      'oblique 10DEG',
      'oblique calc(5deg * 2)',
    ].map((v) => ['style', v] as ['style', string]),
    ...[
      'slanted',
      'x',
      '',
      '\n',
      'oblique 0',
      'oblique 10',
      'oblique 10 20',
      'oblique 100deg',
      'oblique 100grad',
      'oblique 10px',
      'oblique 10%',
      'oblique 1deg 2deg 3deg',
      'italic 10deg',
      'oblique bold',
    ].map((v) => ['style', v] as ['style', string]),
  ]
  const other = { weight: 'style', style: 'weight' } as const
  const kept = { weight: 'bold', style: 'italic' }
  for (const [n, [field, value]] of cases.entries()) {
    const at = `${field} ${JSON.stringify(value)}`
    // The native parser's verdict on the value alone.
    const valid = GlobalFonts.registerFromPath(file, `Compat 1472 Native ${field}`, { [field]: value }) !== null
    const declared = { weight: 'auto', style: 'auto', [other[field]]: kept[other[field]] }
    const reference = `Compat 1472 Field Ref ${n}`
    t.truthy(GlobalFonts.registerFromPath(file, reference, { ...declared, ...(valid ? { [field]: value } : {}) }), at)
    const family = `Compat 1472 Field ${n}`
    t.notThrows(() => registerFont(file, { family, [field]: value, [other[field]]: kept[other[field]] }), at)
    t.deepEqual(
      REQUESTS.map((request) => drawText(`${request} 30px "${family}"`)),
      REQUESTS.map((request) => drawText(`${request} 30px "${reference}"`)),
      at,
    )
    await new Promise((resolve) => setImmediate(resolve))
  }
  // calc() is honoured: a face declared bold draws bold requests as it is.
  registerFont(file, { family: 'Compat 1472 Calc', weight: 'calc(700)' })
  t.is(faceOf('bold', 'Compat 1472 Calc'), 'Regular')
  registerFont(file, { family: 'Compat 1472 Calc Rejected', weight: 'calc(' })
  t.is(faceOf('bold', 'Compat 1472 Calc Rejected'), 'Regular+synthetic bold')
})

// node-canvas's deregisterAllFonts removes only what registerFont added. A
// registerFont call with the same path, family and descriptors as a direct
// registration gets the direct one's key and must not remove it. (Lato: no
// other compat test registers it, and a key is shared by path.)
test.serial('deregisterAllFonts keeps a direct registration that registerFont reused', (t) => {
  for (const [index, [direct, compat]] of [
    [
      { weight: 'bold', style: 'normal' },
      { weight: 'bold', style: 'normal' },
    ],
    [undefined, {}],
  ].entries()) {
    const family = `Compat 1472 Owner ${index}`
    const key = GlobalFonts.registerFromPath(fixture('Lato-Regular.ttf'), family, direct as FontFaceDescriptors)
    registerFont(fixture('Lato-Regular.ttf'), { family, ...compat })
    deregisterAllFonts()
    t.true(GlobalFonts.has(family), family)
    t.true(GlobalFonts.remove(key!), family)
  }
})

// A registration under '' takes the file's own family name; it is still
// tracked, so deregisterAllFonts removes it.
test.serial('deregisterAllFonts removes a registerFont face registered under an empty family', (t) => {
  const embedded = 'RMStatic'
  const faces = () => GlobalFonts.families.find((f) => f.family === embedded)?.styles.length ?? 0
  const before = faces()
  registerFont(fixture('RMStatic-BoldItalic.ttf'), { family: '', weight: 'bold', style: 'italic' })
  t.is(faces(), before + 1)
  deregisterAllFonts()
  t.is(faces(), before)
})

// deregisterAllFonts takes back each registerFont declaration; the registry
// keeps a name a GlobalFonts call also declares, and a registration with such
// a name. Each test starts with no registerFont declaration live.
const stylesOf = (family: string) => GlobalFonts.families.find((f) => f.family === family)?.styles.length ?? 0
const familyNames = () => GlobalFonts.families.map((f) => f.family)
const BOLD = { weight: 'bold', style: 'auto' }

test.serial('deregisterAllFonts keeps a direct registration made after registerFont', (t) => {
  deregisterAllFonts()
  const family = 'Compat 1472 Case 2'
  registerFont(fixture('EBGaramond-Regular.ttf'), { family, weight: 'bold' })
  const key = GlobalFonts.registerFromPath(fixture('EBGaramond-Regular.ttf'), family, BOLD)
  t.truthy(key)
  t.is(stylesOf(family), 1, 'one registration')
  deregisterAllFonts()
  t.true(GlobalFonts.has(family))
  t.true(GlobalFonts.remove(key!))
  t.false(GlobalFonts.has(family))
})

// 3a: a spelling of a direct name; 3b: another name on the same registration.
test.serial('deregisterAllFonts drops only the names registerFont added to a direct registration', (t) => {
  deregisterAllFonts()
  const file = fixture('Oswald.ttf')
  const key = GlobalFonts.registerFromPath(file, 'Compat 1472 Owned Brand', BOLD)
  t.truthy(key)
  registerFont(file, { family: 'compat 1472 owned brand', weight: 'bold' })
  registerFont(file, { family: 'Compat 1472 Other Name', weight: 'bold' })
  t.true(familyNames().includes('compat 1472 owned brand'))
  t.true(GlobalFonts.has('Compat 1472 Other Name'))
  deregisterAllFonts()
  t.true(GlobalFonts.has('Compat 1472 Owned Brand'))
  t.false(familyNames().includes('compat 1472 owned brand'))
  t.false(GlobalFonts.has('Compat 1472 Other Name'))
  t.is(stylesOf('Compat 1472 Owned Brand'), 1)
  t.true(GlobalFonts.remove(key!))
})

// An alias goes when the face it named is no longer listed by any name.
test.serial('deregisterAllFonts drops the setAlias entries of the names it drops', (t) => {
  deregisterAllFonts()
  registerFont(fixture('NotoSansNKo-Regular.ttf'), { family: 'Compat 1472 Alias Only' })
  t.true(GlobalFonts.setAlias('Compat 1472 Alias Only', 'Compat 1472 Alias A'))
  const file = fixture('Oswald.ttf')
  const key = GlobalFonts.registerFromPath(file, 'Compat 1472 Alias Brand', BOLD)
  registerFont(file, { family: 'compat 1472 alias brand', weight: 'bold' })
  registerFont(file, { family: 'Compat 1472 Alias Other', weight: 'bold' })
  t.true(GlobalFonts.setAlias('Compat 1472 Alias Other', 'Compat 1472 Alias B'))
  t.true(GlobalFonts.setAlias('compat 1472 alias brand', 'Compat 1472 Alias C'))
  t.true(GlobalFonts.setAlias('Compat 1472 Alias Brand', 'Compat 1472 Alias D'))
  const aliases = ['A', 'B', 'C', 'D'].map((x) => `Compat 1472 Alias ${x}`)
  t.deepEqual(
    aliases.map((a) => GlobalFonts.has(a)),
    [true, true, true, true],
  )
  deregisterAllFonts()
  // A: its font is gone. B: its name is gone. C: the name is still listed in
  // another case. D: a direct name.
  t.deepEqual(
    aliases.map((a) => GlobalFonts.has(a)),
    [false, false, true, true],
  )
  t.deepEqual(drawText('30px "Compat 1472 Alias D"'), drawText('30px "Compat 1472 Alias Brand"'))
  t.true(GlobalFonts.remove(key!))
  t.false(GlobalFonts.has('Compat 1472 Alias D'))
})

// The aliases kept when a cleanup trims a name off a kept font keep their
// names: the ones made before the dropped alias stay in place in the list.
test.serial('deregisterAllFonts keeps the setAlias entries made before the one it drops', (t) => {
  deregisterAllFonts()
  const unrelated = GlobalFonts.registerFromPath(fixture('Harmattan-Regular.ttf'), 'Compat 1472 Unrelated')
  t.true(GlobalFonts.setAlias('Compat 1472 Unrelated', 'Compat 1472 Unrelated Alias'))
  const key = GlobalFonts.registerFromPath(fixture('RMStatic-Bold.ttf'), 'Compat 1472 Kept Owner', BOLD)
  t.true(GlobalFonts.setAlias('Compat 1472 Kept Owner', 'Compat 1472 Kept Alias'))
  registerFont(fixture('RMStatic-Bold.ttf'), { family: 'Compat 1472 Trimmed', weight: 'bold' })
  t.true(GlobalFonts.setAlias('Compat 1472 Trimmed', 'Compat 1472 Trimmed Alias'))
  deregisterAllFonts()
  t.true(GlobalFonts.has('Compat 1472 Unrelated Alias'))
  t.true(GlobalFonts.has('Compat 1472 Kept Alias'))
  t.false(GlobalFonts.has('Compat 1472 Trimmed'))
  t.false(GlobalFonts.has('Compat 1472 Trimmed Alias'))
  t.deepEqual(drawText('bold 30px "Compat 1472 Kept Alias"'), drawText('bold 30px "Compat 1472 Kept Owner"'))
  t.true(GlobalFonts.remove(key!))
  t.true(GlobalFonts.remove(unrelated!))
})

// Case 4 on a registration a direct alias made: registerFont under '' declares
// the file's own family, and the cleanup makes it what it was.
test.serial('deregisterAllFonts restores the own family a registerFont call under an empty family declared', (t) => {
  deregisterAllFonts()
  const file = fixture('Harmattan-Regular.ttf')
  const own = 'Harmattan'
  const key = GlobalFonts.registerFromPath(file, 'Compat 1472 Own X')
  t.truthy(key)
  const before = { styles: stylesOf(own), bold: drawText(`bold 30px "${own}"`) }
  registerFont(file, { family: '', weight: 'bold' })
  deregisterAllFonts()
  t.true(GlobalFonts.has('Compat 1472 Own X'))
  t.deepEqual({ styles: stylesOf(own), bold: drawText(`bold 30px "${own}"`) }, before)
  t.true(GlobalFonts.remove(key!))
})

test.serial('deregisterAllFonts after a direct remove of a shared registration', (t) => {
  deregisterAllFonts()
  const file = fixture('EBGaramond-Regular.ttf')
  const family = 'Compat 1472 Removed'
  registerFont(file, { family })
  const key = GlobalFonts.registerFromPath(file, family)
  t.true(GlobalFonts.remove(key!))
  t.false(GlobalFonts.has(family))
  // The same path registered again may get the same key; the stale
  // declaration does not remove it.
  const again = GlobalFonts.registerFromPath(file, family)
  t.truthy(again)
  t.notThrows(() => deregisterAllFonts())
  t.true(GlobalFonts.has(family))
  t.true(GlobalFonts.remove(again!))
})

test.serial('deregisterAllFonts twice releases nothing the second time', (t) => {
  deregisterAllFonts()
  const file = fixture('EBGaramond-Regular.ttf')
  const family = 'Compat 1472 Twice'
  registerFont(file, { family })
  deregisterAllFonts()
  t.false(GlobalFonts.has(family))
  const key = GlobalFonts.registerFromPath(file, family)
  deregisterAllFonts()
  t.true(GlobalFonts.has(family))
  t.true(GlobalFonts.remove(key!))
})

test.serial('deregisterAllFonts removes a declaration registerFont made twice', (t) => {
  deregisterAllFonts()
  const family = 'Compat 1472 Same Twice'
  registerFont(fixture('EBGaramond-Regular.ttf'), { family, weight: 'bold' })
  registerFont(fixture('EBGaramond-Regular.ttf'), { family, weight: 'bold' })
  t.is(stylesOf(family), 1)
  deregisterAllFonts()
  t.false(GlobalFonts.has(family))
})

// A release that leaves every name declared and in its place changes
// nothing: no rebuild, so the cached FontFaces of a family stay
// (fontFaceCores counts the ones made). The direct call registers the face
// again last, so the face keeps the place it has without the release.
test.serial('deregisterAllFonts does not rebuild the fonts when nothing goes', (t) => {
  deregisterAllFonts()
  const family = 'Compat 1472 Quiet'
  const key = GlobalFonts.registerFromPath(fixture('Harmattan-Regular.ttf'), family, BOLD)
  registerFont(fixture('Harmattan-Regular.ttf'), { family, weight: 'bold' })
  t.deepEqual(GlobalFonts.registerFromPath(fixture('Harmattan-Regular.ttf'), family, BOLD), key)
  t.is(stylesOf(family), 1)
  const ctx = nativeCreateCanvas(10, 10).getContext('2d') as unknown as {
    font: string
    __debugTextLine(text: string): string
  }
  ctx.font = `20px "${family}"`
  let n = 0
  const cores = () => JSON.parse(ctx.__debugTextLine(`line ${n++}`)).fontFaceCores as number
  const before = cores()
  t.is(cores(), before, 'a new line reuses the cached FontFaces')
  deregisterAllFonts()
  t.is(cores(), before, 'no rebuild')
  t.true(GlobalFonts.has(family))
  // The control: a release that removes a font rebuilds.
  registerFont(fixture('EBGaramond-Regular.ttf'), { family: 'Compat 1472 Quiet Control' })
  const registered = cores()
  deregisterAllFonts()
  t.true(cores() > registered, 'a rebuild')
  t.true(GlobalFonts.remove(key!))
})

test.serial('deregisterAllFonts keeps the descriptors a direct registration declares for the name', (t) => {
  deregisterAllFonts()
  const family = 'Compat 1472 Kept Descriptors'
  // Regular declared bold: a bold request takes it as it is, no synthesis.
  const key = GlobalFonts.registerFromPath(fixture('RMStatic-Regular.ttf'), family, BOLD)
  registerFont(fixture('RMStatic-Italic.ttf'), { family, weight: '100' })
  deregisterAllFonts()
  t.is(faceOf('bold', family), 'Regular')
  t.true(GlobalFonts.remove(key!))
})

// A file loadFontsFromDir loaded is an installed font: registerFont names on
// it go, the font stays. Also when loadFontsFromDir loads a file registerFont
// registered before.
test.serial('deregisterAllFonts keeps a font loadFontsFromDir loaded', (t) => {
  deregisterAllFonts()
  const dir = mkdtempSync(join(tmpdir(), 'canvas-compat-dir-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'IosevkaSlab.ttf')
  copyFileSync(fixture('iosevka-slab-regular.ttf'), file)
  t.is(GlobalFonts.loadFontsFromDir(dir), 1)
  const own = 'Iosevka Slab'
  t.is(stylesOf(own), 1)
  const brand = 'Compat 1472 Dir Brand'
  for (const fontFace of [{ family: '' }, { family: own }, { family: brand }, { family: own, weight: 'bold' }]) {
    registerFont(file, fontFace)
    deregisterAllFonts()
    const at = JSON.stringify(fontFace)
    t.is(stylesOf(own), 1, at)
    t.false(GlobalFonts.has(brand), at)
  }

  const laterDir = mkdtempSync(join(tmpdir(), 'canvas-compat-dir-'))
  t.teardown(() => rmSync(laterDir, { recursive: true, force: true }))
  const later = join(laterDir, 'Harmattan.ttf')
  copyFileSync(fixture('Harmattan-Regular.ttf'), later)
  const laterFamily = 'Compat 1472 Dir Later'
  registerFont(later, { family: laterFamily })
  const harmattan = stylesOf('Harmattan')
  t.is(GlobalFonts.loadFontsFromDir(laterDir), 1)
  deregisterAllFonts()
  t.false(GlobalFonts.has(laterFamily))
  t.is(stylesOf('Harmattan'), harmattan, 'loadFontsFromDir keeps it')
})

// The registry is one per process; each worker's node-canvas module releases
// only its own registerFont declarations, whichever thread declared first.
test.serial('deregisterAllFonts in a worker keeps what the main thread registered', async (t) => {
  deregisterAllFonts()
  const file = fixture('EBGaramond-Regular.ttf')
  const family = 'Compat 1472 Worker'
  // The worker declares, says so, waits for the main thread, then cleans up.
  const code = `
    const { parentPort, workerData } = require('node:worker_threads')
    const { registerFont, deregisterAllFonts, GlobalFonts } = require(workerData.nodeCanvas)
    registerFont(workerData.file, { family: workerData.family })
    parentPort.postMessage({ during: GlobalFonts.has(workerData.family) })
    parentPort.once('message', () => {
      deregisterAllFonts()
      parentPort.postMessage({ after: GlobalFonts.has(workerData.family) })
    })
  `
  for (const order of ['main first', 'worker first']) {
    if (order === 'main first') {
      registerFont(file, { family })
    }
    const worker = new Worker(code, {
      eval: true,
      workerData: { nodeCanvas: join(__dirname, '..', 'node-canvas.js'), file, family },
    })
    const exited = once(worker, 'exit')
    const [registered] = await once(worker, 'message')
    t.deepEqual(registered, { during: true }, order)
    if (order === 'worker first') {
      registerFont(file, { family })
    }
    worker.postMessage('clean up')
    const [cleaned] = await once(worker, 'message')
    await exited
    t.deepEqual(cleaned, { after: true }, order)
    t.true(GlobalFonts.has(family), order)
    deregisterAllFonts()
    t.false(GlobalFonts.has(family), order)
  }
})

// The declarations of a worker that exits without deregisterAllFonts go
// with it (an env cleanup hook), so they never keep a face the main thread
// then cleans up.
test.serial('a worker that exits without deregisterAllFonts leaves no declaration', async (t) => {
  deregisterAllFonts()
  const file = fixture('EBGaramond-Regular.ttf')
  const family = 'Compat 1472 Worker Exit'
  const code = `
    const { parentPort, workerData } = require('node:worker_threads')
    const { registerFont, GlobalFonts } = require(workerData.nodeCanvas)
    registerFont(workerData.file, { family: workerData.family })
    parentPort.postMessage({ during: GlobalFonts.has(workerData.family) })
  `
  for (const order of ['worker alone', 'main first']) {
    if (order === 'main first') {
      registerFont(file, { family })
    }
    const worker = new Worker(code, {
      eval: true,
      workerData: { nodeCanvas: join(__dirname, '..', 'node-canvas.js'), file, family },
    })
    const exited = once(worker, 'exit')
    const [registered] = await once(worker, 'message')
    t.deepEqual(registered, { during: true }, order)
    await exited
    t.is(GlobalFonts.has(family), order === 'main first', `${order}: after the worker exits`)
    deregisterAllFonts()
    t.false(GlobalFonts.has(family), `${order}: after the main thread cleans up`)
  }
})

// Copies of fixtures at paths no other test registers (so keys of their
// own), in a temp dir removed after the test.
function copies(t: { teardown: (fn: () => void) => void }, names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-compat-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  return {
    dir,
    files: names.map((name, i) => {
      const file = join(dir, `${i}-${name}`)
      copyFileSync(fixture(name), file)
      return file
    }),
  }
}

// registerFont registering a face again makes it the newest of equal faces
// under the name; the release puts it back where the other owners of the
// name left it, also across a rebuild (which numbers every order again).
test.serial('deregisterAllFonts puts back the order of a face registerFont registered again', (t) => {
  deregisterAllFonts()
  const { files } = copies(t, ['RMStatic-Regular.ttf', 'RMStatic-Bold.ttf', 'Harmattan-Regular.ttf'])
  const [regular, bold, other] = files
  const declared = { weight: '400', style: 'normal' }
  const family = 'Compat 1472 Order'
  const keys = [
    GlobalFonts.registerFromPath(regular, family, declared),
    GlobalFonts.registerFromPath(bold, family, declared),
  ]
  t.is(faceOf('normal', family), 'Bold', 'the newest of two equal faces')
  const rebuild = () => {
    const key = GlobalFonts.registerFromPath(other, 'Compat 1472 Order Rebuild')
    t.true(GlobalFonts.remove(key!))
  }
  for (const rebuilt of [false, true]) {
    registerFont(regular, { family, ...declared })
    t.is(faceOf('normal', family), 'Regular', `registered again (rebuild ${rebuilt})`)
    if (rebuilt) rebuild()
    t.is(faceOf('normal', family), 'Regular', `before the cleanup (rebuild ${rebuilt})`)
    deregisterAllFonts()
    t.is(faceOf('normal', family), 'Bold', `after the cleanup (rebuild ${rebuilt})`)
  }
  // A direct call registered Regular again first: that order stays.
  for (const rebuilt of [false, true]) {
    GlobalFonts.registerFromPath(regular, family, declared)
    t.is(faceOf('normal', family), 'Regular')
    registerFont(bold, { family, ...declared })
    registerFont(regular, { family, ...declared })
    if (rebuilt) rebuild()
    t.is(faceOf('normal', family), 'Regular')
    deregisterAllFonts()
    t.is(faceOf('normal', family), 'Regular', `the direct order (rebuild ${rebuilt})`)
    GlobalFonts.registerFromPath(bold, family, declared)
    t.is(faceOf('normal', family), 'Bold')
  }
  for (const key of keys) t.true(GlobalFonts.remove(key!))
})

// An alias kept for a spelling of its family that a direct call listed
// after the alias is made again from its font, though the rebuild replays
// that spelling after the alias.
test.serial('deregisterAllFonts keeps an alias of a spelling listed after it', (t) => {
  deregisterAllFonts()
  const {
    dir,
    files: [file],
  } = copies(t, ['Lato-Regular.ttf'])
  t.is(GlobalFonts.loadFontsFromDir(dir), 1)
  const family = 'Compat 1472 Late Spelling'
  const upper = family.toUpperCase()
  const alias = 'Compat 1472 Late Alias'
  registerFont(file, { family, weight: 'bold' })
  t.true(GlobalFonts.setAlias(family, alias))
  const key = GlobalFonts.registerFromPath(file, upper, BOLD)
  t.truthy(key)
  const drawn = drawText(`bold 30px "${alias}"`)
  deregisterAllFonts()
  t.true(GlobalFonts.has(upper))
  t.true(GlobalFonts.has(alias))
  t.deepEqual(drawText(`bold 30px "${alias}"`), drawn)
  t.deepEqual(drawText(`bold 30px "${alias}"`), drawText(`bold 30px "${upper}"`))
  t.true(GlobalFonts.remove(key!))
  t.false(GlobalFonts.has(alias))
})

// FontKey of a path (computePathHash, FNV-1a over its bytes); the keys of
// declaration twins start at 0x80000000.
function pathKey(path: string) {
  let hash = 2166136261
  for (const byte of Buffer.from(path)) {
    hash = Math.imul(hash ^ byte, 16777619) >>> 0
  }
  return hash || 1
}

// loadFontsFromDir of a file registerFont registered under two weights holds
// the registration that lists the file's own family, never the weight twin,
// whichever key sorts first.
test.serial('deregisterAllFonts keeps the own family loadFontsFromDir holds, not a twin', (t) => {
  deregisterAllFonts()
  const own = 'Oswald'
  const family = 'Compat 1472 Dir Twin'
  for (const [label, wanted] of [
    ['path key before the twin keys', (key: number) => key < 0x80000000],
    ['path key after the twin keys', (key: number) => key >= 0xc0000000],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'canvas-compat-twin-'))
    t.teardown(() => rmSync(dir, { recursive: true, force: true }))
    let n = 0
    while (!wanted(pathKey(join(dir, `Oswald-${n}.ttf`)))) n++
    const file = join(dir, `Oswald-${n}.ttf`)
    copyFileSync(fixture('Oswald.ttf'), file)
    const before = stylesOf(own)
    registerFont(file, { family, weight: 'bold' })
    registerFont(file, { family, weight: '100' })
    t.is(stylesOf(family), 2, label)
    t.is(GlobalFonts.loadFontsFromDir(dir), 1, label)
    deregisterAllFonts()
    t.false(GlobalFonts.has(family), label)
    t.is(stylesOf(own), before + 1, `${label}: the file loadFontsFromDir loaded stays`)
  }
})

test.serial('registerFont without weight keeps the wght axis of a variable font', (t) => {
  const family = 'Compat 1472 VF'
  registerFont(robotoMonoPath, { family })
  t.deepEqual(drawText(`bold 30px "${family}"`), drawText('30px "Compat Ref RobotoMono"', '"wght" 700'))
  t.deepEqual(drawText(`100 30px "${family}"`), drawText('30px "Compat Ref RobotoMono"', '"wght" 100'))
})

test.serial('registerFont with only family registers the file as registerFromPath does', (t) => {
  const family = 'Compat 1472 Auto'
  const styles = () => GlobalFonts.families.find((f) => f.family === family)?.styles.length ?? 0
  GlobalFonts.registerFromPath(fixture('RMStatic-Bold.ttf'), family)
  registerFont(fixture('RMStatic-Bold.ttf'), { family })
  t.is(styles(), 1)
})

// ---------------------------------------------------------------------------
// deregisterAllFonts
// ---------------------------------------------------------------------------

test.serial('deregisterAllFonts removes only user-registered fonts', (t) => {
  // Clear any fonts tracked by prior tests
  deregisterAllFonts()
  const baselineCount = GlobalFonts.families.length
  registerFont(fontPath, { family: 'ToBeRemoved' })
  t.true(GlobalFonts.has('ToBeRemoved'))
  deregisterAllFonts()
  t.false(GlobalFonts.has('ToBeRemoved'))
  // Only user-registered fonts should be removed, baseline stays the same
  t.is(GlobalFonts.families.length, baselineCount)
})

// ---------------------------------------------------------------------------
// toBuffer
// ---------------------------------------------------------------------------

test('toBuffer() with no args returns PNG buffer', (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 10, 10)
  const buf = canvas.toBuffer()
  t.true(Buffer.isBuffer(buf))
  // PNG magic bytes
  t.is(buf[0], 0x89)
  t.is(buf[1], 0x50) // P
  t.is(buf[2], 0x4e) // N
  t.is(buf[3], 0x47) // G
})

test('toBuffer("image/png") returns PNG buffer', (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const buf = canvas.toBuffer('image/png')
  t.true(Buffer.isBuffer(buf))
  t.is(buf[0], 0x89) // PNG magic
})

test('toBuffer("image/png", config) accepts PngConfig', (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const buf = canvas.toBuffer('image/png', { compressionLevel: 9 })
  t.true(Buffer.isBuffer(buf))
  t.is(buf[0], 0x89)
})

test('toBuffer("image/jpeg") returns JPEG buffer', (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const buf = canvas.toBuffer('image/jpeg')
  t.true(Buffer.isBuffer(buf))
  // JPEG magic bytes: FF D8
  t.is(buf[0], 0xff)
  t.is(buf[1], 0xd8)
})

test('toBuffer("image/jpeg", { quality }) maps 0-1 quality', (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 10, 10)

  const lowQ = canvas.toBuffer('image/jpeg', { quality: 0.1 })
  const highQ = canvas.toBuffer('image/jpeg', { quality: 0.99 })
  t.true(Buffer.isBuffer(lowQ))
  t.true(Buffer.isBuffer(highQ))
  // Higher quality should produce a larger buffer (in most cases)
  t.true(highQ.length >= lowQ.length, `highQ (${highQ.length}) should be >= lowQ (${lowQ.length})`)
})

test('toBuffer("raw") returns raw pixel data', (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const buf = canvas.toBuffer('raw')
  t.true(Buffer.isBuffer(buf))
  // Raw RGBA: 10*10*4 = 400 bytes
  t.is(buf.length, 400)
})

test('toBuffer(callback) calls back with PNG buffer', async (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const buf = await new Promise<Buffer>((resolve, reject) => {
    canvas.toBuffer((err: Error | null, result: Buffer) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
  t.true(Buffer.isBuffer(buf))
  t.is(buf[0], 0x89) // PNG
})

test('toBuffer(callback, "image/jpeg", config) calls back with JPEG', async (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const buf = await new Promise<Buffer>((resolve, reject) => {
    canvas.toBuffer(
      (err: Error | null, result: Buffer) => {
        if (err) reject(err)
        else resolve(result)
      },
      'image/jpeg',
      { quality: 0.9 },
    )
  })
  t.true(Buffer.isBuffer(buf))
  t.is(buf[0], 0xff) // JPEG
  t.is(buf[1], 0xd8)
})

test('toBuffer(callback, invalidMime) calls back with error', async (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const err = await new Promise<Error>((resolve) => {
    canvas.toBuffer((err: Error | null, _result: Buffer) => {
      resolve(err!)
    }, 'image/jepg' as any)
  })
  t.truthy(err)
  t.true(err instanceof TypeError)
  t.regex(err.message, /Unsupported MIME type/)
})

test('toBuffer(callback, "raw") calls back with raw pixel data', async (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const buf = await new Promise<Buffer>((resolve, reject) => {
    canvas.toBuffer((err: Error | null, result: Buffer) => {
      if (err) reject(err)
      else resolve(result)
    }, 'raw' as any)
  })
  t.true(Buffer.isBuffer(buf))
  t.is(buf.length, 10 * 10 * 4) // RGBA
})

// ---------------------------------------------------------------------------
// toDataURL
// ---------------------------------------------------------------------------

test('toDataURL() returns PNG data URL', (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const url = canvas.toDataURL()
  t.true(url.startsWith('data:image/png;base64,'))
})

test('toDataURL("image/jpeg", quality) maps quality 0-1', (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const url = canvas.toDataURL('image/jpeg', 0.5)
  t.true(url.startsWith('data:image/jpeg;base64,'))
})

test('toDataURL(callback) calls back async', async (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const url = await new Promise<string>((resolve, reject) => {
    canvas.toDataURL((err: Error | null, result: string) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
  t.true(url.startsWith('data:image/png;base64,'))
})

test('toDataURL("image/jpeg", callback) calls back with JPEG data URL', async (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const url = await new Promise<string>((resolve, reject) => {
    canvas.toDataURL('image/jpeg', (err: Error | null, result: string) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
  t.true(url.startsWith('data:image/jpeg;base64,'))
})

test('toDataURL("image/jpeg", 0.9, callback) calls back with JPEG data URL', async (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const url = await new Promise<string>((resolve, reject) => {
    canvas.toDataURL('image/jpeg', 0.9, (err: Error | null, result: string) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
  t.true(url.startsWith('data:image/jpeg;base64,'))
})

// ---------------------------------------------------------------------------
// createPNGStream / createJPEGStream
// ---------------------------------------------------------------------------

test('createPNGStream returns a Readable with PNG data', async (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#00ff00'
  ctx.fillRect(0, 0, 10, 10)

  const stream = canvas.createPNGStream()
  t.true(stream instanceof Readable)
  t.true(stream instanceof PNGStream)

  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  const buf = Buffer.concat(chunks)
  t.true(buf.length > 0)
  t.is(buf[0], 0x89) // PNG magic
})

test('createJPEGStream returns a Readable with JPEG data', async (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#0000ff'
  ctx.fillRect(0, 0, 10, 10)

  const stream = canvas.createJPEGStream({ quality: 0.8 })
  t.true(stream instanceof Readable)
  t.true(stream instanceof JPEGStream)

  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  const buf = Buffer.concat(chunks)
  t.true(buf.length > 0)
  t.is(buf[0], 0xff) // JPEG magic
  t.is(buf[1], 0xd8)
})

test('createJPEGStream with default quality', async (t) => {
  const canvas = createCanvas(10, 10)
  canvas.getContext('2d').fillRect(0, 0, 10, 10)
  const stream = canvas.createJPEGStream()

  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  const buf = Buffer.concat(chunks)
  t.is(buf[0], 0xff)
  t.is(buf[1], 0xd8)
})

// ---------------------------------------------------------------------------
// PngConfig.resolution: the pHYs chunk node-canvas writes
// ---------------------------------------------------------------------------

const PHYS_300 = '000000097048597300002e2300002e230178a53f76'
const PHYS_72 = '000000097048597300000b1300000b1301009a9c18'

function pngChunk(png: Buffer, type: string): string | undefined {
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    if (png.toString('latin1', offset + 4, offset + 8) === type) {
      return png.subarray(offset, offset + 12 + length).toString('hex')
    }
    offset += 12 + length
  }
  return undefined
}

function drawnCanvas<T extends { getContext(id: '2d'): any }>(canvas: T): T {
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#00ff00'
  ctx.fillRect(0, 0, 10, 10)
  ctx.fillStyle = 'rgba(0, 0, 255, 0.5)'
  ctx.fillRect(4, 4, 10, 10)
  return canvas
}

test('PngConfig.resolution writes a pHYs chunk', async (t) => {
  const canvas = drawnCanvas(createCanvas(16, 16))
  t.is(pngChunk(canvas.toBuffer('image/png', { resolution: 300, compressionLevel: 9 }), 'pHYs'), PHYS_300)
  const viaCallback = await new Promise<Buffer>((resolve, reject) => {
    canvas.toBuffer((err, buf) => (err ? reject(err) : resolve(buf)), 'image/png', { resolution: 300 })
  })
  t.is(pngChunk(viaCallback, 'pHYs'), PHYS_300)
  const streamed = Buffer.concat(await canvas.createPNGStream({ resolution: 300 }).toArray())
  t.is(pngChunk(streamed, 'pHYs'), PHYS_300)
  // The fraction is dropped, as node-canvas does.
  t.is(pngChunk(canvas.toBuffer('image/png', { resolution: 72.6 }), 'pHYs'), PHYS_72)
})

test('PngConfig.compressionLevel and filters are forwarded', async (t) => {
  const canvas = drawnCanvas(createCanvas(16, 16))
  const config = { compressionLevel: 1 as const, filters: 0x20 }
  const idatZlib = (png: Buffer) => {
    const parts: Buffer[] = []
    let offset = 8
    while (offset < png.length) {
      const length = png.readUInt32BE(offset)
      if (png.toString('latin1', offset + 4, offset + 8) === 'IDAT') {
        parts.push(png.subarray(offset + 8, offset + 8 + length))
      }
      offset += 12 + length
    }
    return Buffer.concat(parts)
  }
  const viaCallback = await new Promise<Buffer>((resolve, reject) => {
    canvas.toBuffer((err, buf) => (err ? reject(err) : resolve(buf)), 'image/png', config)
  })
  const streamed = Buffer.concat(await canvas.createPNGStream(config).toArray())
  for (const png of [canvas.toBuffer('image/png', config), viaCallback, streamed]) {
    const zlib = idatZlib(png)
    t.is(zlib[1] >> 6, 0)
    const rows = inflateSync(zlib)
    for (let y = 0; y < 16; y++) t.is(rows[y * (16 * 4 + 1)], 2)
  }

  // Each PngConfig getter is read once.
  const reads: string[] = []
  const oneShot = {
    get resolution() {
      reads.push('resolution')
      return reads.filter((k) => k === 'resolution').length === 1 ? 300 : undefined
    },
    get compressionLevel() {
      reads.push('compressionLevel')
      return reads.filter((k) => k === 'compressionLevel').length === 1 ? 1 : undefined
    },
    get filters() {
      reads.push('filters')
      return reads.filter((k) => k === 'filters').length === 1 ? 0x20 : undefined
    },
  }
  const png = canvas.toBuffer('image/png', oneShot as any)
  t.deepEqual(reads, ['resolution', 'compressionLevel', 'filters'])
  t.is(pngChunk(png, 'pHYs'), PHYS_300)
  const zlib = idatZlib(png)
  t.is(zlib[1] >> 6, 0)
  const rows = inflateSync(zlib)
  for (let y = 0; y < 16; y++) t.is(rows[y * (16 * 4 + 1)], 2)
})

test('PngConfig without usable options gives the plain PNG', async (t) => {
  const canvas = drawnCanvas(createCanvas(16, 16))
  const plain = drawnCanvas(nativeCreateCanvas(16, 16)).toBuffer('image/png')
  const configs: any[] = [
    { compressionLevel: 10, filters: 1 },
    { resolution: 0 },
    { resolution: NaN },
    { resolution: '300' },
    { resolution: -1 },
    // Text is not forwarded: node-canvas writes none.
    { title: 'x' },
  ]
  for (const config of configs) {
    t.deepEqual(canvas.toBuffer('image/png', config), plain, JSON.stringify(config))
    const viaCallback = await new Promise<Buffer>((resolve, reject) => {
      canvas.toBuffer((err, buf) => (err ? reject(err) : resolve(buf)), 'image/png', config)
    })
    t.deepEqual(viaCallback, plain, JSON.stringify(config))
    t.deepEqual(Buffer.concat(await canvas.createPNGStream(config).toArray()), plain, JSON.stringify(config))
  }
  t.deepEqual(canvas.toBuffer(), plain)
})

test('JpegConfig.resolution is not forwarded', (t) => {
  const canvas = drawnCanvas(createCanvas(16, 16))
  const jpeg = canvas.toBuffer('image/jpeg', { quality: 0.5, resolution: 300 } as any)
  t.deepEqual(jpeg, drawnCanvas(nativeCreateCanvas(16, 16)).toBuffer('image/jpeg', 50))
  // JFIF units 0, density 1x1.
  t.is(jpeg.subarray(13, 18).toString('hex'), '0000010001')
})

// ---------------------------------------------------------------------------
// createImageData
// ---------------------------------------------------------------------------

test('createImageData(width, height) creates blank ImageData', (t) => {
  const data = createImageData(10, 20)
  t.is(data.width, 10)
  t.is(data.height, 20)
  t.is(data.data.length, 10 * 20 * 4)
})

test('createImageData(array, width) creates ImageData from data', (t) => {
  const arr = new Uint8ClampedArray(40)
  const data = createImageData(arr, 10, 1)
  t.is(data.width, 10)
  t.is(data.height, 1)
})

// ---------------------------------------------------------------------------
// loadImage
// ---------------------------------------------------------------------------

test('loadImage loads from file path', async (t) => {
  const img = await loadImage(join(__dirname, '..', 'example', 'simple.png'))
  t.true(img instanceof Image)
  t.true(img.width > 0)
  t.true(img.height > 0)
})

// ---------------------------------------------------------------------------
// SVG canvas
// ---------------------------------------------------------------------------

test('createCanvas with pdf type throws', (t) => {
  t.throws(
    () => {
      // @ts-expect-error testing unsupported type
      createCanvas(100, 100, 'pdf')
    },
    { instanceOf: Error, message: /not supported/ },
  )
})

test('createCanvas with unknown type throws', (t) => {
  t.throws(
    () => {
      // @ts-expect-error testing invalid type
      createCanvas(100, 100, 'foobar')
    },
    { instanceOf: TypeError, message: /unknown type/ },
  )
})

test('createCanvas with svg type returns SvgCanvas', (t) => {
  const canvas = createCanvas(100, 100, 'svg')
  t.truthy(canvas)
  const ctx = canvas.getContext('2d')
  t.truthy(ctx)
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 100, 100)
  // SVG canvas should have getContent for vector output
  t.is(typeof (canvas as any).getContent, 'function')
  const content = (canvas as any).getContent() as Buffer
  t.true(content.toString('utf-8').includes('<svg'))
  // SVG canvas should NOT have raster compat methods
  t.is(typeof (canvas as any).createPNGStream, 'undefined')
  t.is(typeof (canvas as any).createJPEGStream, 'undefined')
})

// ---------------------------------------------------------------------------
// Multiple canvas instances are independent
// ---------------------------------------------------------------------------

test('compat methods are per-instance (no prototype pollution)', async (t) => {
  const { createCanvas: origCreateCanvas } = await import('../index')
  const origCanvas = origCreateCanvas(10, 10)

  // Original canvas should NOT have createPNGStream
  t.is(typeof (origCanvas as any).createPNGStream, 'undefined')

  // Compat canvas should have it
  const compatCanvas = createCanvas(10, 10)
  t.is(typeof compatCanvas.createPNGStream, 'function')
})
