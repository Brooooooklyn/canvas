import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  ]
  for (const value of values) {
    t.notThrows(() => registerFont(fixture('RMStatic-Regular.ttf'), { family: `${family} Junk`, ...value }))
  }
  // The valid field is kept: this face still serves italic requests.
  registerFont(fixture('RMStatic-Regular.ttf'), { family, weight: '400', style: 'normal' })
  registerFont(fixture('RMStatic-Italic.ttf'), { family, weight: 'bolder', style: 'italic' })
  t.is(faceOf('normal', family), 'Regular')
  t.is(faceOf('italic', family), 'Italic')
})

// A null from registerFromPath also means the file failed to load, so a
// valid descriptor is never retried as `auto` (that could reuse another
// registration's key and lose the face without an error).
test.serial('registerFont throws when a valid descriptor fails, without a retry', (t) => {
  const original = GlobalFonts.registerFromPath
  const calls: unknown[] = []
  GlobalFonts.registerFromPath = ((path: string, family?: string, descriptors?: FontFaceDescriptors) => {
    calls.push(descriptors)
    return descriptors?.weight === 'auto' ? original.call(GlobalFonts, path, family, descriptors) : null
  }) as typeof original
  try {
    t.throws(() => registerFont(fixture('RMStatic-Bold.ttf'), { family: 'Compat 1472 No Retry', weight: 'bold' }), {
      message: /Failed to register font/,
    })
  } finally {
    GlobalFonts.registerFromPath = original
  }
  t.deepEqual(calls, [{ weight: 'bold', style: 'auto' }])
})

// registerFont drops only values the native parser rejects; a value it keeps
// that the parser rejects makes registerFont throw.
test.serial('registerFont drops a descriptor only when the native parser rejects it', (t) => {
  const file = fixture('RMStatic-Regular.ttf')
  const cases: Array<['weight' | 'style', string]> = [
    ...['bold', 'BOLD', '700', ' 700 ', '1', '1000', '1e3', '+700', '100 900', 'normal', 'auto'].map(
      (v) => ['weight', v] as ['weight', string],
    ),
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
  const original = GlobalFonts.registerFromPath
  for (const [field, value] of cases) {
    const valid = original.call(GlobalFonts, file, `Compat 1472 Native ${field}`, { [field]: value }) !== null
    let passed: FontFaceDescriptors | undefined
    GlobalFonts.registerFromPath = ((path: string, family?: string, descriptors?: FontFaceDescriptors) => {
      passed = descriptors
      return original.call(GlobalFonts, path, family, descriptors)
    }) as typeof original
    try {
      registerFont(file, { family: `Compat 1472 Drift ${field}`, [field]: value })
    } finally {
      GlobalFonts.registerFromPath = original
    }
    t.is(passed?.[field], valid ? value : 'auto', `${field} ${JSON.stringify(value)}`)
  }
  // An invalid value with a token the check does not read is passed as given.
  t.throws(() => registerFont(file, { family: 'Compat 1472 Unknown', weight: 'calc(' }), {
    message: /Failed to register font/,
  })
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
