import { spawnSync } from 'node:child_process'
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
import { createCanvas as nativeCreateCanvas, getTextRenderer, setTextRenderer } from '../index'

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
// from Buffers, so a direct registration of the same path in a test never
// reuses one.
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

// node-canvas's deregisterAllFonts removes only what registerFont added. Each
// registerFont call makes a registration of its own, which only registerFont
// calls of the same N-API env share: a direct registration of the same file
// and family stays a registration of its own, and keeps its key. (Lato: no
// other compat test registers it.)
test.serial('deregisterAllFonts keeps a direct registration of the same file and family', (t) => {
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

// A registration under '' takes the file's own family name; deregisterAllFonts
// removes it.
test.serial('deregisterAllFonts removes a registerFont face registered under an empty family', (t) => {
  const embedded = 'RMStatic'
  const faces = () => GlobalFonts.families.find((f) => f.family === embedded)?.styles.length ?? 0
  const before = faces()
  registerFont(fixture('RMStatic-BoldItalic.ttf'), { family: '', weight: 'bold', style: 'italic' })
  t.is(faces(), before + 1)
  deregisterAllFonts()
  t.is(faces(), before)
})

// deregisterAllFonts removes the registerFont registrations of its env whole,
// as GlobalFonts.remove(key) removes one; GlobalFonts registrations are never
// touched. Each test starts with no registerFont registration live.
const stylesOf = (family: string) => GlobalFonts.families.find((f) => f.family === family)?.styles.length ?? 0
const familyNames = () => GlobalFonts.families.map((f) => f.family)
const BOLD = { weight: 'bold', style: 'auto' }

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

// FontKey of a path (computePathHash, FNV-1a over its bytes); the keys of
// declaration twins (and of registerFont registrations) start at 0x80000000.
function pathKey(path: string) {
  let hash = 2166136261
  for (const byte of Buffer.from(path)) {
    hash = Math.imul(hash ^ byte, 16777619) >>> 0
  }
  return hash || 1
}

// A path whose key is below the twin keys, so the keys issued so far never
// move it.
function lowKeyCopy(t: { teardown: (fn: () => void) => void }, name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-compat-key-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  let n = 0
  while (pathKey(join(dir, `${n}-${name}`)) >= 0x80000000) n++
  const file = join(dir, `${n}-${name}`)
  copyFileSync(fixture(name), file)
  return file
}

// While both are live, a file registered with registerFont and with a direct
// call has a face from each.
test.serial('deregisterAllFonts keeps a direct registration made after registerFont', (t) => {
  deregisterAllFonts()
  const family = 'Compat 1472 Case 2'
  registerFont(fixture('EBGaramond-Regular.ttf'), { family, weight: 'bold' })
  const key = GlobalFonts.registerFromPath(fixture('EBGaramond-Regular.ttf'), family, BOLD)
  t.truthy(key)
  t.is(stylesOf(family), 2, 'a registration each')
  deregisterAllFonts()
  t.is(stylesOf(family), 1)
  t.true(GlobalFonts.remove(key!))
  t.false(GlobalFonts.has(family))
})

// The registerFont registration never takes the key a direct call gets for
// the path, in either order, and GlobalFonts.remove of the direct key leaves
// it.
test.serial('registerFont never changes a direct key', (t) => {
  deregisterAllFonts()
  const family = 'Compat 1472 Direct Key'
  for (const order of ['direct first', 'registerFont first']) {
    const file = lowKeyCopy(t, 'EBGaramond-Regular.ttf')
    if (order === 'direct first') {
      const key = GlobalFonts.registerFromPath(file, family)
      registerFont(file, { family })
      t.is(key!.typefaceId, pathKey(file), order)
      t.true(GlobalFonts.remove(key!), order)
    } else {
      registerFont(file, { family })
      const key = GlobalFonts.registerFromPath(file, family)
      t.is(key!.typefaceId, pathKey(file), order)
      t.true(GlobalFonts.remove(key!), order)
    }
    t.is(stylesOf(family), 1, `${order}: the registerFont face stays`)
    deregisterAllFonts()
    t.false(GlobalFonts.has(family), order)
  }
})

// 3a: a spelling of a direct name; 3b: another name of the same file.
test.serial('deregisterAllFonts removes the names registerFont gave a file a direct call registered', (t) => {
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

// A setAlias entry names the face text naming the family draws (the newest
// equal face), and goes with that face's registration, as with
// GlobalFonts.remove. So an alias made while a registerFont face of the family
// is the newest goes with deregisterAllFonts, also when a direct registration
// declares the family too; one made before it, or of a name only a direct
// registration lists, stays.
test.serial('deregisterAllFonts drops the setAlias entries made from registerFont faces', (t) => {
  deregisterAllFonts()
  registerFont(fixture('NotoSansNKo-Regular.ttf'), { family: 'Compat 1472 Alias Only' })
  t.true(GlobalFonts.setAlias('Compat 1472 Alias Only', 'Compat 1472 Alias A'))
  const file = fixture('Oswald.ttf')
  const brand = 'Compat 1472 Alias Brand'
  const key = GlobalFonts.registerFromPath(file, brand, BOLD)
  t.true(GlobalFonts.setAlias(brand, 'Compat 1472 Alias B'))
  registerFont(file, { family: brand, weight: 'bold' })
  t.true(GlobalFonts.setAlias(brand, 'Compat 1472 Alias C'))
  const direct = GlobalFonts.registerFromPath(fixture('Harmattan-Regular.ttf'), 'Compat 1472 Alias Direct')
  t.true(GlobalFonts.setAlias('Compat 1472 Alias Direct', 'Compat 1472 Alias D'))
  const aliases = ['A', 'B', 'C', 'D'].map((x) => `Compat 1472 Alias ${x}`)
  t.deepEqual(
    aliases.map((a) => GlobalFonts.has(a)),
    [true, true, true, true],
  )
  deregisterAllFonts()
  // A: its font is gone. B: made before registerFont, from the direct face.
  // C: made from the registerFont face, the newest of the two equal faces.
  // D: a name only a direct registration lists.
  t.deepEqual(
    aliases.map((a) => GlobalFonts.has(a)),
    [false, true, false, true],
  )
  t.true(GlobalFonts.has(brand))
  t.deepEqual(drawText('30px "Compat 1472 Alias B"'), drawText(`30px "${brand}"`))
  t.true(GlobalFonts.remove(key!))
  t.false(GlobalFonts.has('Compat 1472 Alias B'))
  t.true(GlobalFonts.remove(direct!))
})

// The aliases kept when a cleanup removes a registration keep their names:
// the ones made before the dropped alias stay in place in the list.
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

// Case 4: registerFont under '' lists the file's own family; once it goes,
// the own family is what the direct registration lists.
test.serial('deregisterAllFonts leaves the own family as it was after a registerFont under an empty family', (t) => {
  deregisterAllFonts()
  const file = fixture('Harmattan-Regular.ttf')
  const own = 'Harmattan'
  const key = GlobalFonts.registerFromPath(file, 'Compat 1472 Own X')
  t.truthy(key)
  const before = { styles: stylesOf(own), bold: drawText(`bold 30px "${own}"`) }
  registerFont(file, { family: '', weight: 'bold' })
  t.is(stylesOf(own), before.styles + 1)
  deregisterAllFonts()
  t.true(GlobalFonts.has('Compat 1472 Own X'))
  t.deepEqual({ styles: stylesOf(own), bold: drawText(`bold 30px "${own}"`) }, before)
  t.true(GlobalFonts.remove(key!))
})

// GlobalFonts.remove of a direct registration leaves the registerFont one of
// the same file and family; deregisterAllFonts removes it, and never a direct
// registration of the same path made again.
test.serial('deregisterAllFonts after a direct remove of the same file and family', (t) => {
  deregisterAllFonts()
  const file = fixture('EBGaramond-Regular.ttf')
  const family = 'Compat 1472 Removed'
  registerFont(file, { family })
  const key = GlobalFonts.registerFromPath(file, family)
  t.true(GlobalFonts.remove(key!))
  t.true(GlobalFonts.has(family), 'the registerFont face stays')
  const again = GlobalFonts.registerFromPath(file, family)
  t.truthy(again)
  deregisterAllFonts()
  t.is(stylesOf(family), 1, 'the direct registration made again stays')
  t.true(GlobalFonts.remove(again!))
  t.false(GlobalFonts.has(family))
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

// With no registerFont registration live, deregisterAllFonts changes nothing:
// no rebuild, so the cached FontFaces of a family stay (fontFaceCores counts
// the ones made).
test.serial('deregisterAllFonts with no registerFont registration does not rebuild', (t) => {
  deregisterAllFonts()
  const family = 'Compat 1472 Quiet'
  const key = GlobalFonts.registerFromPath(fixture('Harmattan-Regular.ttf'), family, BOLD)
  const ctx = nativeCreateCanvas(10, 10).getContext('2d') as unknown as {
    font: string
    __debugTextLine(text: string): string
  }
  ctx.font = `20px "${family}"`
  let n = 0
  const cores = () => JSON.parse(ctx.__debugTextLine(`line ${n++}`)).fontFaceCores as number
  const before = cores()
  t.is(cores(), before, 'a new line reuses the cached FontFaces')
  t.false(binding._releaseFontFaces(), 'nothing goes')
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

// A file loadFontsFromDir loaded is an installed font: registerFont makes a
// registration of its own of it, which goes, and the font stays. Also when
// loadFontsFromDir loads a file registerFont registered before.
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
  const harmattan = stylesOf('Harmattan')
  registerFont(later, { family: laterFamily })
  t.is(GlobalFonts.loadFontsFromDir(laterDir), 1, 'loadFontsFromDir registers the file as without registerFont')
  deregisterAllFonts()
  t.false(GlobalFonts.has(laterFamily))
  t.is(stylesOf('Harmattan'), harmattan + 1, 'loadFontsFromDir keeps it')
})

// registerFont under another name of a file loadFontsFromDir loaded lists
// that name only, as every registerFont with a family does: the file's own
// family stays an installed font with the faces it had (a FontFace in it would
// hide them: font_families.cpp FamilyResolver::IsWebFont).
test.serial('registerFont of a file loadFontsFromDir loaded leaves its own family an installed font', (t) => {
  deregisterAllFonts()
  const {
    dir,
    files: [file],
  } = copies(t, ['Oswald.ttf'])
  const own = 'Oswald'
  t.is(GlobalFonts.loadFontsFromDir(dir), 1)
  const before = { styles: stylesOf(own), regular: drawText(`30px "${own}"`), bold: drawText(`bold 30px "${own}"`) }
  const family = 'Compat 1472 Dir Alias'
  registerFont(file, { family, weight: 'bold' })
  t.true(GlobalFonts.has(family))
  t.deepEqual(
    { styles: stylesOf(own), regular: drawText(`30px "${own}"`), bold: drawText(`bold 30px "${own}"`) },
    before,
  )
  deregisterAllFonts()
  t.false(GlobalFonts.has(family))
  t.is(stylesOf(own), before.styles)
})

// registerFont under another name of a file loadFontsFromDir loads gives the
// same result whichever comes first: the registration lists that name only
// (never the file's own family), so a setAlias of the own family names the
// installed font, which outlives deregisterAllFonts. In a child process per
// order, with no other fonts.
const DIR_ORDER_PROBE = `
const crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path')
const { createCanvas, GlobalFonts, registerFont, deregisterAllFonts } = require('./node-canvas.js')
const own = 'RMStatic', family = 'Compat 1472 Order Other', alias = 'Compat 1472 Order Alias'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-compat-order-'))
const file = path.join(dir, 'RMStatic.ttf')
fs.copyFileSync(path.join('__test__', 'fonts', 'RMStatic-Regular.ttf'), file)
const m = (name) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  return [9.5, 30].map((size) => {
    ctx.font = size + 'px "' + name + '"'
    const t = ctx.measureText('Hamburgefonstiv')
    return [t.width, t.actualBoundingBoxAscent, t.actualBoundingBoxDescent, t.fontBoundingBoxAscent, t.fontBoundingBoxDescent]
  })
}
const pixels = (name) => {
  const ctx = createCanvas(420, 60).getContext('2d')
  ctx.font = '30px "' + name + '"'
  ctx.fillText('Hamburgefonstiv', 10, 42)
  return crypto.createHash('sha1').update(ctx.getImageData(0, 0, 420, 60).data).digest('hex')
}
const state = () => ({
  ownStyles: GlobalFonts.families.find((f) => f.family === own)?.styles.length ?? 0,
  own: m(own),
  ownPixels: pixels(own),
  family: GlobalFonts.has(family),
  familyMetrics: m(family),
  alias: GlobalFonts.has(alias),
  aliasMetrics: m(alias),
  // Measured at the same point: on Linux an installed font is the fallback
  // of a family nobody lists.
  missing: m('Compat 1472 No Such Font'),
})
const out = {}
if (process.env.ORDER === 'dir first') {
  out.loaded = GlobalFonts.loadFontsFromDir(dir)
  registerFont(file, { family })
} else {
  registerFont(file, { family })
  out.loaded = GlobalFonts.loadFontsFromDir(dir)
}
out.aliased = GlobalFonts.setAlias(own, alias)
out.live = state()
deregisterAllFonts()
out.after = state()
fs.rmSync(dir, { recursive: true, force: true })
process.stdout.write(JSON.stringify(out))
`

test.serial('registerFont and loadFontsFromDir of one file give the same result in either order', (t) => {
  const run = (order: string) => {
    const { stdout, stderr, status } = spawnSync(process.execPath, ['-e', DIR_ORDER_PROBE], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, DISABLE_SYSTEM_FONTS_LOAD: '1', ORDER: order },
      encoding: 'utf8',
      timeout: 60_000,
    })
    if (status !== 0) throw new Error(stderr)
    return JSON.parse(stdout)
  }
  const dirFirst = run('dir first')
  const registerFirst = run('registerFont first')
  for (const [order, out] of [
    ['dir first', dirFirst],
    ['registerFont first', registerFirst],
  ]) {
    t.is(out.loaded, 1, order)
    t.true(out.aliased, order)
    t.is(out.live.ownStyles, 1, `${order}: the own family lists the installed face only`)
    t.true(out.live.family, order)
    t.deepEqual(out.live.familyMetrics, out.live.own, `${order}: the registerFont name draws the file`)
    t.deepEqual(out.live.aliasMetrics, out.live.own, `${order}: the alias draws the own family`)
    t.false(out.after.family, `${order}: the registerFont name goes`)
    t.deepEqual(out.after.familyMetrics, out.after.missing, `${order}: the registerFont name is a missing family`)
    t.true(out.after.alias, `${order}: the alias of the installed font stays`)
    t.deepEqual(out.after.aliasMetrics, out.after.own, order)
    t.is(out.after.ownStyles, 1, order)
    t.deepEqual(out.after.own, out.live.own, `${order}: the own family is as it was`)
    t.is(out.after.ownPixels, out.live.ownPixels, order)
  }
  t.deepEqual(registerFirst, dirFirst)
})

// The registry is one per process; each worker's node-canvas module removes
// only its own registerFont registrations, whichever thread registered first.
test.serial('deregisterAllFonts in a worker keeps what the main thread registered', async (t) => {
  deregisterAllFonts()
  const file = fixture('EBGaramond-Regular.ttf')
  const family = 'Compat 1472 Worker'
  // The worker registers, says so, waits for the main thread, then cleans up.
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

// The registrations of a worker that exits without deregisterAllFonts go
// with it (an env cleanup hook). The same declaration in the main thread and
// in a worker is a registration each. The worker stays until the main thread
// has counted its registration, then exits on its own.
test.serial('a worker that exits without deregisterAllFonts leaves no registration', async (t) => {
  deregisterAllFonts()
  const file = fixture('EBGaramond-Regular.ttf')
  const family = 'Compat 1472 Worker Exit'
  const code = `
    const { parentPort, workerData } = require('node:worker_threads')
    const { registerFont, GlobalFonts } = require(workerData.nodeCanvas)
    registerFont(workerData.file, { family: workerData.family })
    parentPort.once('message', () => parentPort.close())
    parentPort.postMessage({ during: GlobalFonts.has(workerData.family) })
  `
  for (const order of ['worker alone', 'main first']) {
    const main = order === 'main first'
    if (main) {
      registerFont(file, { family })
    }
    const worker = new Worker(code, {
      eval: true,
      workerData: { nodeCanvas: join(__dirname, '..', 'node-canvas.js'), file, family },
    })
    t.teardown(() => worker.terminate())
    const exited = once(worker, 'exit')
    const [registered] = await once(worker, 'message')
    t.deepEqual(registered, { during: true }, order)
    t.is(stylesOf(family), main ? 2 : 1, `${order}: a registration per env`)
    worker.postMessage('exit')
    await exited
    t.is(stylesOf(family), main ? 1 : 0, `${order}: after the worker exits`)
    deregisterAllFonts()
    t.false(GlobalFonts.has(family), `${order}: after the main thread cleans up`)
  }
})

// Two weights of one file in one env are two registrations (the second a
// twin of the first); both go, and a loadFontsFromDir of the file made
// meanwhile stays.
test.serial('registerFont of two weights of one file is two faces, both released', (t) => {
  deregisterAllFonts()
  const own = 'Oswald'
  const family = 'Compat 1472 Dir Twin'
  const {
    dir,
    files: [file],
  } = copies(t, ['Oswald.ttf'])
  const before = stylesOf(own)
  registerFont(file, { family, weight: 'bold' })
  registerFont(file, { family, weight: '100' })
  t.is(stylesOf(family), 2)
  t.is(GlobalFonts.loadFontsFromDir(dir), 1)
  deregisterAllFonts()
  t.false(GlobalFonts.has(family))
  t.is(stylesOf(own), before + 1, 'the file loadFontsFromDir loaded stays')
})

// A worker's registerFont made a registration of the file, under its family
// only; a direct call with other descriptors then made one of its own, which
// lists the file's own family too. When the worker exits, the direct one
// stays as it was, and so
// does a direct setAlias of the own family made from its face (the newest of
// the own family's faces). The fixture's own family is registered nowhere
// else in this file (as Harmattan is), so the alias names this file's face.
test.serial('a worker exit keeps the own family of a file a direct call registered too', async (t) => {
  deregisterAllFonts()
  const own = 'Noto Sans Devanagari'
  const family = 'Compat 1472 Embedded'
  const {
    files: [file, reference],
  } = copies(t, ['NotoSansDevanagari-subset.ttf', 'NotoSansDevanagari-subset.ttf'])
  const before = stylesOf(own)
  t.is(before, 0)
  const text = 'नमस्ते हिन्दी'
  const widthOf = (font: string) => {
    const ctx = nativeCreateCanvas(10, 10).getContext('2d')
    ctx.font = font
    return ctx.measureText(text).width
  }
  const missing = widthOf('30px "Compat 1472 No Such Font"')
  // Had the worker never registered the file: the direct call alone.
  const referenceKey = GlobalFonts.registerFromPath(reference, 'Compat 1472 Embedded Ref', { weight: '700' })
  t.truthy(referenceKey)
  t.is(stylesOf(own), before + 1, 'the direct call alone lists the own family')
  const ownDrawn = drawText(`30px "${own}"`)
  const drawn = drawText('bold 30px "Compat 1472 Embedded Ref"')
  const width = widthOf(`30px "${own}"`)
  t.not(width, missing, 'the own family draws the file')
  // A direct setAlias of the own family names the direct call's face.
  const alias = 'Compat 1472 Embedded Alias'
  t.true(GlobalFonts.setAlias(own, alias))
  t.is(widthOf(`30px "${alias}"`), width)
  t.true(GlobalFonts.remove(referenceKey!))
  t.is(stylesOf(own), before)
  t.false(GlobalFonts.has(alias), 'the alias goes with the face it named')

  const code = `
    const { parentPort, workerData } = require('node:worker_threads')
    const { registerFont } = require(workerData.nodeCanvas)
    registerFont(workerData.file, { family: workerData.family, weight: '400' })
    parentPort.once('message', () => parentPort.close())
    parentPort.postMessage('registered')
  `
  const worker = new Worker(code, {
    eval: true,
    workerData: { nodeCanvas: join(__dirname, '..', 'node-canvas.js'), file, family },
  })
  t.teardown(() => worker.terminate())
  const exited = once(worker, 'exit')
  t.deepEqual(await once(worker, 'message'), ['registered'])
  t.is(stylesOf(own), before, "the worker's registration lists its family only")
  const key = GlobalFonts.registerFromPath(file, family, { weight: '700' })
  t.truthy(key)
  t.is(stylesOf(family), 2, 'the direct call makes a registration of its own')
  t.is(stylesOf(own), before + 1, 'which lists the own family too')
  // Made from the direct call's face, the newest of the own family.
  t.true(GlobalFonts.setAlias(own, alias))
  worker.postMessage('exit')
  await exited
  t.is(stylesOf(family), 1, "the worker's face goes")
  t.is(stylesOf(own), before + 1, 'the own family stays')
  t.true(GlobalFonts.has(own))
  t.deepEqual(drawText(`30px "${own}"`), ownDrawn)
  t.deepEqual(drawText(`bold 30px "${family}"`), drawn)
  t.is(widthOf(`30px "${own}"`), width, 'the own family draws the file')
  t.is(widthOf('30px "Compat 1472 Embedded Ref"'), missing, 'the reference name is gone')
  t.is(widthOf(`bold 30px "${family}"`), width, 'the direct face draws the file')
  t.true(GlobalFonts.has(alias), 'the direct setAlias stays')
  t.is(widthOf(`30px "${alias}"`), width, 'the alias draws the file')
  // The direct registration goes with the own family.
  t.true(GlobalFonts.remove(key!))
  t.false(GlobalFonts.has(family))
  t.is(stylesOf(own), before)
  t.false(GlobalFonts.has(alias), 'the alias goes with the face it named')
})

// loadFontsFromDir never reuses a registerFont registration: it makes the
// installed font it makes with no registerFont call, so once registerFont's
// registration goes, a character the font list lacks comes from the file
// (installed-fallback.spec.ts). A direct registerFromPath of the file with
// other descriptors (DIRECT_FACE) made before the load is the path's first
// registration, which the load reuses (it registers nothing new), so the file
// is no fallback font, as on main;
// made after the load, it is a twin of the installed font, which stays a
// fallback font. Each case runs in a child process with no other fonts
// loaded.
const DIR_FALLBACK_PROBE = `
const fs = require('fs'), os = require('os'), path = require('path')
const { createCanvas, GlobalFonts, registerFont, deregisterAllFonts } = require('./node-canvas.js')
const F = path.join('__test__', 'fonts')
const m = (text) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = '32px "Compat 1472 Lato Only"'
  const t = ctx.measureText(text)
  return [t.width, t.actualBoundingBoxLeft, t.actualBoundingBoxRight, t.actualBoundingBoxAscent, t.actualBoundingBoxDescent]
}
GlobalFonts.registerFromPath(path.join(F, 'Lato-Regular.ttf'), 'Compat 1472 Lato Only')
const ch = String.fromCodePoint(0x1e290)
const out = { none: m(ch) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-compat-fallback-'))
const file = path.join(dir, 'NamedInstanceProbe.ttf')
fs.copyFileSync(path.join(F, 'NamedInstanceProbe.ttf'), file)
const fontFace = JSON.parse(process.env.FONT_FACE || 'null')
const direct = JSON.parse(process.env.DIRECT_FACE || 'null')
const registerDirect = () => GlobalFonts.registerFromPath(file, direct.family, { weight: direct.weight })
if (fontFace) registerFont(file, fontFace)
if (direct && !direct.afterDir) registerDirect()
out.loaded = GlobalFonts.loadFontsFromDir(dir)
if (direct && direct.afterDir) registerDirect()
if (fontFace) deregisterAllFonts()
out.glyph = m(ch)
out.family = GlobalFonts.has('Named Instance Probe')
fs.rmSync(dir, { recursive: true, force: true })
process.stdout.write(JSON.stringify(out))
`

interface DirectFace {
  family: string
  weight: string
  afterDir: boolean
}

function dirFallback(fontFace: object | null, direct: DirectFace | null = null) {
  const { stdout, stderr, status } = spawnSync(process.execPath, ['-e', DIR_FALLBACK_PROBE], {
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      DISABLE_SYSTEM_FONTS_LOAD: '1',
      FONT_FACE: JSON.stringify(fontFace),
      DIRECT_FACE: JSON.stringify(direct),
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (status !== 0) throw new Error(stderr)
  return JSON.parse(stdout) as { none: number[]; loaded: number; glyph: number[]; family: boolean }
}

test.serial('deregisterAllFonts leaves a file loadFontsFromDir loaded a fallback font', (t) => {
  const alone = dirFallback(null)
  t.is(alone.loaded, 1)
  t.true(alone.family)
  if (JSON.stringify(alone.glyph) === JSON.stringify(alone.none)) {
    t.fail('loadFontsFromDir alone gives no glyph for U+1E290')
    return
  }
  for (const fontFace of [
    { family: 'Compat 1472 Fallback' },
    { family: 'Named Instance Probe' },
    { family: 'Named Instance Probe', weight: 'bold' },
    { family: '' },
  ]) {
    const at = JSON.stringify(fontFace)
    const released = dirFallback(fontFace)
    t.is(released.loaded, 1, at)
    t.true(released.family, at)
    t.deepEqual(released.none, alone.none, at)
    t.deepEqual(released.glyph, alone.glyph, at)
  }
  // A direct registration of the file, made before or after the load: the
  // same glyph as the direct call and the load alone.
  for (const afterDir of [false, true]) {
    const direct = { family: 'Compat 1472 Fallback Direct', weight: '700', afterDir }
    const at = JSON.stringify(direct)
    const reference = dirFallback(null, direct)
    t.is(reference.loaded, 1, at)
    t.deepEqual(reference.glyph, afterDir ? alone.glyph : alone.none, at)
    const released = dirFallback({ family: direct.family, weight: '400' }, direct)
    t.is(released.loaded, 1, at)
    t.true(released.family, at)
    t.deepEqual(released.glyph, reference.glyph, at)
  }
})

// GlobalFonts.removeAll removes everything, registerFont registrations too;
// deregisterAllFonts then removes nothing, and registerFont works after it.
// In a child process: removeAll would remove the other tests' fonts.
const REMOVE_ALL_PROBE = `
const path = require('path')
const { GlobalFonts, registerFont, deregisterAllFonts } = require('./node-canvas.js')
const binding = require('./js-binding.js')
const file = path.join('__test__', 'fonts', 'EBGaramond-Regular.ttf')
const family = 'Compat 1472 Remove All'
registerFont(file, { family })
const out = { during: GlobalFonts.has(family) }
GlobalFonts.removeAll()
out.removed = !GlobalFonts.has(family)
out.released = binding._releaseFontFaces()
registerFont(file, { family })
out.again = GlobalFonts.has(family)
deregisterAllFonts()
out.after = GlobalFonts.has(family)
process.stdout.write(JSON.stringify(out))
`

test.serial('GlobalFonts.removeAll removes registerFont faces; deregisterAllFonts then removes nothing', (t) => {
  const { stdout, stderr, status } = spawnSync(process.execPath, ['-e', REMOVE_ALL_PROBE], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, DISABLE_SYSTEM_FONTS_LOAD: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  })
  t.is(status, 0, stderr)
  t.deepEqual(JSON.parse(stdout), { during: true, removed: true, released: false, again: true, after: false })
})

// registerFont of the same declarations again reuses this env's registrations
// (each call makes its face the newest, as registerFromPath does), so nothing
// grows with the number of calls, and the face registered last draws (no
// descriptors), also after a rebuild.
test.serial('registerFont of the same declarations again is bounded and makes it the newest', async (t) => {
  deregisterAllFonts()
  const family = 'Compat 1472 Bound'
  const {
    files: [regular, bold, other],
  } = copies(t, ['RMStatic-Regular.ttf', 'RMStatic-Bold.ttf', 'Harmattan-Regular.ttf'])
  registerFont(regular, { family })
  registerFont(bold, { family })
  t.is(stylesOf(family), 2)
  const families = GlobalFonts.families.length
  for (let i = 0; i < 2000; i++) {
    registerFont(i % 2 ? bold : regular, { family })
    await new Promise((resolve) => setImmediate(resolve))
  }
  t.is(stylesOf(family), 2, 'after 2000 more calls')
  t.is(GlobalFonts.families.length, families)
  t.is(faceOf('normal', family), 'Bold')
  t.true(GlobalFonts.remove(GlobalFonts.registerFromPath(other, 'Compat 1472 Bound Rebuild')!))
  t.is(stylesOf(family), 2, 'after a rebuild')
  t.is(faceOf('normal', family), 'Bold')
  registerFont(regular, { family })
  t.is(faceOf('normal', family), 'Regular')
  deregisterAllFonts()
  t.false(GlobalFonts.has(family))
})

// registerFont and deregisterAllFonts in a loop use no new key: a released
// registration's key goes to the next one, so the declaration twins of
// GlobalFonts calls still get the next key of their counter.
test.serial('registerFont and deregisterAllFonts in a loop use no new key', async (t) => {
  deregisterAllFonts()
  const {
    files: [file],
  } = copies(t, ['EBGaramond-Regular.ttf'])
  // A path key below the twin keys, so the twin's first registration never
  // takes a twin key.
  const twinFile = lowKeyCopy(t, 'Harmattan-Regular.ttf')
  const family = 'Compat 1472 Key Loop'
  const twinKey = () => {
    // A declaration twin: the same path and name with other descriptors.
    const first = GlobalFonts.registerFromPath(twinFile, 'Compat 1472 Key Twin', BOLD)
    const twin = GlobalFonts.registerFromPath(twinFile, 'Compat 1472 Key Twin', { weight: '100' })
    t.true(GlobalFonts.remove(twin!))
    t.true(GlobalFonts.remove(first!))
    return twin!.typefaceId
  }
  registerFont(file, { family })
  deregisterAllFonts()
  const before = twinKey()
  for (let i = 0; i < 2000; i++) {
    registerFont(file, { family })
    deregisterAllFonts()
    await new Promise((resolve) => setImmediate(resolve))
  }
  t.is(twinKey(), before + 1)
  t.false(GlobalFonts.has(family))
})

// A rebuild (a font removed, a renderer switch) keeps a registerFont
// registration its own: a direct call of the same path still makes a
// registration of its own, and deregisterAllFonts still removes it.
test.serial('a rebuild keeps registerFont registrations private and releasable', (t) => {
  deregisterAllFonts()
  const {
    files: [file, other],
  } = copies(t, ['EBGaramond-Regular.ttf', 'Harmattan-Regular.ttf'])
  const family = 'Compat 1472 Rebuilt'
  for (const rebuild of ['remove', 'renderer'] as const) {
    registerFont(file, { family, weight: 'bold' })
    if (rebuild === 'remove') {
      t.true(GlobalFonts.remove(GlobalFonts.registerFromPath(other, 'Compat 1472 Rebuilt Other')!))
    } else {
      const renderer = getTextRenderer()
      setTextRenderer(renderer === 'portable' ? 'system' : 'portable')
      setTextRenderer(renderer)
    }
    t.is(stylesOf(family), 1, rebuild)
    const key = GlobalFonts.registerFromPath(file, family, BOLD)
    t.is(stylesOf(family), 2, `${rebuild}: the direct call makes its own`)
    deregisterAllFonts()
    t.is(stylesOf(family), 1, rebuild)
    t.true(GlobalFonts.remove(key!), rebuild)
    t.false(GlobalFonts.has(family), rebuild)
  }
})

test.serial('registerFont without weight keeps the wght axis of a variable font', (t) => {
  const family = 'Compat 1472 VF'
  registerFont(robotoMonoPath, { family })
  t.deepEqual(drawText(`bold 30px "${family}"`), drawText('30px "Compat Ref RobotoMono"', '"wght" 700'))
  t.deepEqual(drawText(`100 30px "${family}"`), drawText('30px "Compat Ref RobotoMono"', '"wght" 100'))
})

// With only family, registerFont registers the file as registerFromPath
// registers a new path: a face of its own next to the direct one, drawn as
// the direct one is. Except that it lists the family only, as
// new FontFace(family, ...): the direct call lists the file's own family
// (RMStatic) too, registerFont adds no face to it.
test.serial('registerFont with only family registers the file as registerFromPath does', (t) => {
  deregisterAllFonts()
  const family = 'Compat 1472 Auto'
  const own = 'RMStatic'
  const key = GlobalFonts.registerFromPath(fixture('RMStatic-Bold.ttf'), family)
  const direct = facesOf(family)
  const ownStyles = stylesOf(own)
  registerFont(fixture('RMStatic-Bold.ttf'), { family })
  t.is(stylesOf(family), 2)
  t.deepEqual(facesOf(family), direct)
  t.is(stylesOf(own), ownStyles, 'the own family gets no registerFont face')
  deregisterAllFonts()
  t.is(stylesOf(family), 1)
  t.true(GlobalFonts.remove(key!))
})

// Behavior change from 1.2.0: registerFont with a family lists the face under
// that family only, as new FontFace('X', ...) in Chrome; the family embedded
// in the file is listed only for family '' or that same name. In a child
// process with no other fonts, so no other registration lists the embedded
// family.
const ONLY_FAMILY_PROBE = `
const path = require('path')
const { createCanvas, GlobalFonts, registerFont, deregisterAllFonts } = require('./node-canvas.js')
const file = path.join('__test__', 'fonts', 'Harmattan-Regular.ttf')
const own = 'Harmattan', family = 'Compat 1472 Only Name'
const m = (name) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  ctx.font = '30px "' + name + '"'
  return ctx.measureText('Hamburgefonstiv').width
}
const state = () => ({
  own: GlobalFonts.has(own),
  ownStyles: GlobalFonts.families.find((f) => f.family === own)?.styles.length ?? 0,
  ownDraws: m(own) !== m('Compat 1472 No Such Font'),
  family: GlobalFonts.has(family),
})
const out = { before: state() }
registerFont(file, { family })
out.named = state()
deregisterAllFonts()
registerFont(file, { family: '' })
out.empty = state()
deregisterAllFonts()
registerFont(file, { family: own })
out.same = state()
deregisterAllFonts()
registerFont(file, { family })
registerFont(file, { family: '' })
out.both = state()
deregisterAllFonts()
out.after = state()
process.stdout.write(JSON.stringify(out))
`

test.serial('registerFont with a family does not list the embedded family', (t) => {
  const { stdout, stderr, status } = spawnSync(process.execPath, ['-e', ONLY_FAMILY_PROBE], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, DISABLE_SYSTEM_FONTS_LOAD: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  })
  t.is(status, 0, stderr)
  const none = { own: false, ownStyles: 0, ownDraws: false, family: false }
  t.deepEqual(JSON.parse(stdout), {
    before: none,
    named: { ...none, family: true },
    empty: { own: true, ownStyles: 1, ownDraws: true, family: false },
    same: { own: true, ownStyles: 1, ownDraws: true, family: false },
    both: { own: true, ownStyles: 1, ownDraws: true, family: true },
    after: none,
  })
})

// The registration loadFontsFromDir made of a file, removed through its key
// (GlobalFonts.registerFromPath of the path with no name returns it), leaves
// a registerFont registration of the file under another name working, made
// before or after the load, and the file's own family exactly as in a run
// without registerFont, also when the path is registered again. In a child
// process per order, with no other fonts.
const DIR_KEY_REMOVE_PROBE = `
const fs = require('fs'), os = require('os'), path = require('path')
const { createCanvas, GlobalFonts, registerFont, deregisterAllFonts } = require('./node-canvas.js')
const own = 'RMStatic', family = 'Compat 1472 Dir Key Other'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-compat-dir-key-'))
const file = path.join(dir, 'RMStatic.ttf')
fs.copyFileSync(path.join('__test__', 'fonts', 'RMStatic-Regular.ttf'), file)
const m = (name) => {
  const ctx = createCanvas(10, 10).getContext('2d')
  return [9.5, 30].map((size) => {
    ctx.font = size + 'px "' + name + '"'
    const t = ctx.measureText('Hamburgefonstiv')
    return [t.width, t.actualBoundingBoxAscent, t.actualBoundingBoxDescent, t.fontBoundingBoxAscent, t.fontBoundingBoxDescent]
  })
}
const state = () => ({
  has: GlobalFonts.has(own),
  styles: GlobalFonts.families.find((f) => f.family === own)?.styles.length ?? 0,
  metrics: m(own),
})
const order = process.env.ORDER
const out = { missing: m('Compat 1472 No Such Font') }
if (order === 'registerFont first') registerFont(file, { family })
out.loaded = GlobalFonts.loadFontsFromDir(dir)
if (order === 'dir first') registerFont(file, { family })
out.live = state()
const familyLive = m(family)
const key = GlobalFonts.registerFromPath(file)
out.removed = !!key && GlobalFonts.remove(key)
out.removedState = state()
if (order !== 'none') {
  out.family = GlobalFonts.has(family)
  out.familyDraws = JSON.stringify(m(family)) !== JSON.stringify(out.missing)
  out.familyKept = JSON.stringify(m(family)) === JSON.stringify(familyLive)
}
const again = GlobalFonts.registerFromPath(file)
out.again = state()
out.againRemoved = !!again && GlobalFonts.remove(again)
deregisterAllFonts()
out.after = state()
fs.rmSync(dir, { recursive: true, force: true })
process.stdout.write(JSON.stringify(out))
`

test.serial(
  'removing the loadFontsFromDir registration through its key keeps registerFont and the own family',
  async (t) => {
    const run = (order: string) => {
      const { stdout, stderr, status } = spawnSync(process.execPath, ['-e', DIR_KEY_REMOVE_PROBE], {
        cwd: join(__dirname, '..'),
        env: { ...process.env, DISABLE_SYSTEM_FONTS_LOAD: '1', ORDER: order },
        encoding: 'utf8',
        timeout: 60_000,
      })
      if (status !== 0) throw new Error(stderr)
      return JSON.parse(stdout)
    }
    const baseline = run('none')
    t.is(baseline.loaded, 1)
    t.true(baseline.removed)
    t.true(baseline.live.has)
    t.false(baseline.removedState.has, 'the own family goes with the key')
    t.deepEqual(baseline.removedState.metrics, baseline.missing)
    t.true(baseline.again.has, 'registering the path again lists the own family')
    t.true(baseline.againRemoved)
    for (const order of ['registerFont first', 'dir first']) {
      await new Promise((resolve) => setImmediate(resolve))
      const out = run(order)
      t.true(out.family, `${order}: the registerFont family stays`)
      t.true(out.familyDraws, `${order}: it draws the file`)
      t.true(out.familyKept, `${order}: as before the remove`)
      const own = { ...out }
      for (const field of ['family', 'familyDraws', 'familyKept']) delete own[field]
      t.deepEqual(own, baseline, `${order}: the own family is as without registerFont`)
    }
  },
)

// The FontKeys GlobalFonts calls get, and what GlobalFonts.remove of each
// (also a stale one, tried again) returns, are the same with registerFont
// and deregisterAllFonts calls in between as without them: a registerFont
// registration takes no key a GlobalFonts call could get, and leaves no
// trace in how they are issued. The files have path hashes (the FontKey of
// a new path) of each kind: one in the first keys a declaration twin gets
// (from 0x80000000 on), one past them with the high bit set, and one
// without it. In a child process per run, with no other fonts.
const PUBLIC_KEYS_PROBE = `
const fs = require('fs'), os = require('os'), path = require('path')
const { GlobalFonts, registerFont, deregisterAllFonts } = require('./node-canvas.js')
const compat = process.env.COMPAT === '1'
const src = path.join('__test__', 'fonts', 'SourceSerifPro-Regular.ttf')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-compat-keys-'))
// FNV-1a over the path bytes (skia_c.hpp computePathHash).
const fnv = (hash, bytes) => {
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0
  return hash
}
// A copy of the font in dir whose path hash is in [lo, hi).
const copyWithHash = (tag, lo, hi) => {
  const prefix = fnv(2166136261, Buffer.from(path.join(dir, tag)))
  for (let i = 0; ; i++) {
    const name = tag + i.toString(36) + '.ttf'
    let hash = prefix
    for (let j = tag.length; j < name.length; j++) hash = Math.imul(hash ^ name.charCodeAt(j), 16777619) >>> 0
    if (hash >= lo && hash < hi) {
      const file = path.join(dir, name)
      fs.copyFileSync(src, file)
      return { file, hash }
    }
  }
}
const twinBase = 0x80000000
// Past the few twin keys the run takes itself.
const nearTwins = copyWithHash('t', twinBase + 16, twinBase + 256)
const high = copyWithHash('h', 0xc0000000, 0x100000000)
const low = copyWithHash('l', 0, twinBase)
// registerFont of 256 declarations of one family (each its own face)
// before the fix took the first 256 twin keys.
const compatFile = path.join(dir, 'compat.ttf')
fs.copyFileSync(src, compatFile)
const declare = () => {
  if (!compat) return
  for (let i = 0; i < 256; i++) registerFont(compatFile, { family: 'Compat Keys', weight: String(101 + i) })
}
const release = () => compat && deregisterAllFonts()
const id = (key) => (key ? key.typefaceId : null)
const out = { hashes: [nearTwins.hash, high.hash, low.hash] }
declare()
const a = GlobalFonts.registerFromPath(nearTwins.file)
const b = GlobalFonts.registerFromPath(high.file)
const c = GlobalFonts.registerFromPath(low.file)
GlobalFonts.registerFromPath(low.file, 'Keys Twin', { weight: '400' })
const t1 = GlobalFonts.registerFromPath(low.file, 'Keys Twin', { weight: '700' })
out.first = [a, b, c, t1].map(id)
release()
out.removed = [GlobalFonts.remove(a), GlobalFonts.remove(t1)]
declare()
release()
if (compat) registerFont(compatFile, { family: 'Compat Keys Kept' })
const t2 = GlobalFonts.registerFromPath(low.file, 'Keys Twin', { weight: '900' })
const t3 = GlobalFonts.registerFromPath(low.file, 'Keys Twin', { weight: '300' })
out.second = [t2, t3].map(id)
// The stale keys tried again, before and after the path is registered again.
out.stale = [GlobalFonts.remove(a), GlobalFonts.remove(t1)]
const a2 = GlobalFonts.registerFromPath(nearTwins.file)
out.again = id(a2)
out.staleAgain = [GlobalFonts.remove(t1), GlobalFonts.remove(a), GlobalFonts.remove(a2)]
out.rest = [b, c, t2, t3].map((key) => GlobalFonts.remove(key))
release()
fs.rmSync(dir, { recursive: true, force: true })
process.stdout.write(JSON.stringify(out))
`

test.serial('registerFont and deregisterAllFonts leave the GlobalFonts keys as without them', (t) => {
  const run = (compat: boolean) => {
    const { stdout, stderr, status } = spawnSync(process.execPath, ['-e', PUBLIC_KEYS_PROBE], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, DISABLE_SYSTEM_FONTS_LOAD: '1', COMPAT: compat ? '1' : '0' },
      encoding: 'utf8',
      timeout: 120_000,
    })
    if (status !== 0) throw new Error(stderr)
    return JSON.parse(stdout)
  }
  const baseline = run(false)
  // A new path's key is its hash; a twin's is a new one from 0x80000000.
  t.deepEqual(baseline.first.slice(0, 3), baseline.hashes)
  t.true(baseline.first[3] >= 0x80000000)
  t.deepEqual(baseline.removed, [true, true])
  t.deepEqual(baseline.stale, [false, false], 'a removed key names no other font')
  t.is(baseline.again, baseline.hashes[0])
  t.deepEqual(baseline.staleAgain, [false, true, false])
  t.true(baseline.second.every((key: number) => key >= 0x80000000))
  t.deepEqual(baseline.rest, [true, true, true, true])
  const out = run(true)
  t.deepEqual(out.first.slice(0, 3), out.hashes, 'with registerFont: a new path still gets its hash')
  // Each run has its own files (other path hashes) of the same kinds: a key
  // that is a file's path hash is compared as that file's.
  const symbolic = (result: { hashes: number[] }) =>
    JSON.parse(
      JSON.stringify(result, (_, value) =>
        typeof value === 'number' && result.hashes.includes(value) ? `hash ${result.hashes.indexOf(value)}` : value,
      ),
    )
  t.deepEqual(symbolic(out), symbolic(baseline), 'the same keys and remove results')
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
