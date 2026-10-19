// Resolution (DPI) and text metadata in toBuffer, encode and encodeSync
// output (issue #1368). PNG gets pHYs and tEXt/iTXt chunks before the first
// IDAT; JPEG gets its JFIF density and XMP (APP1) and COM segments after the
// JFIF APP0. WebP, AVIF and GIF output, and the web export methods, never
// carry it. The pHYs bytes are node-canvas 3.2's
// (png_set_pHYs(round(ppi * 39.3701)), PNG_RESOLUTION_METER).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { crc32 } from '@node-rs/crc32'
import test from 'ava'

import { createCanvas, loadImage, type Canvas, type ImageMetadata } from '../index'

// 64x48: a gradient and a translucent rectangle, no text.
function drawn(attrs?: Parameters<Canvas['getContext']>[1]): Canvas {
  const canvas = createCanvas(64, 48)
  const ctx = canvas.getContext('2d', attrs)
  const gradient = ctx.createLinearGradient(0, 0, 64, 48)
  gradient.addColorStop(0, 'rgba(255, 0, 0, 0.8)')
  gradient.addColorStop(0.5, 'rgb(0, 200, 80)')
  gradient.addColorStop(1, 'rgba(20, 40, 255, 0.6)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 48)
  ctx.fillStyle = 'rgba(250, 250, 0, 0.5)'
  ctx.fillRect(8, 6, 30, 20)
  return canvas
}

const KINDS = {
  default: undefined,
  'alpha: false': { alpha: false },
  'display-p3': { colorSpace: 'display-p3' },
  float16: { colorType: 'float16' },
} as const

interface Chunk {
  type: string
  data: Buffer
  raw: Buffer
}

function pngChunks(png: Buffer): Chunk[] {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG')
  const chunks: Chunk[] = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const raw = png.subarray(offset, offset + 12 + length)
    if (raw.length !== 12 + length) throw new Error('truncated chunk')
    chunks.push({ type: raw.toString('latin1', 4, 8), data: raw.subarray(8, 8 + length), raw })
    offset += 12 + length
  }
  return chunks
}

const chunkTypes = (png: Buffer) => pngChunks(png).map((c) => c.type)
const crcOk = (c: Chunk) => crc32(c.raw.subarray(4, c.raw.length - 4)) === c.raw.readUInt32BE(c.raw.length - 4)
const textChunks = (png: Buffer) => pngChunks(png).filter((c) => c.type === 'tEXt' || c.type === 'iTXt')
const physHex = (png: Buffer) =>
  pngChunks(png)
    .find((c) => c.type === 'pHYs')
    ?.raw.toString('hex')
const keyword = (c: Chunk) => c.data.toString('latin1', 0, c.data.indexOf(0))

const METADATA_CHUNKS = new Set(['pHYs', 'tEXt', 'iTXt'])
function stripPng(png: Buffer) {
  return Buffer.concat([
    png.subarray(0, 8),
    ...pngChunks(png)
      .filter((c) => !METADATA_CHUNKS.has(c.type))
      .map((c) => c.raw),
  ])
}

interface Segment {
  marker: number
  offset: number
  data: Buffer
  raw: Buffer
}

// The marker segments from SOI up to and with SOS.
function jpegSegments(jpeg: Buffer): Segment[] {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG')
  const segments: Segment[] = []
  let offset = 2
  for (;;) {
    if (jpeg[offset] !== 0xff) throw new Error(`no marker at ${offset}`)
    const marker = jpeg[offset + 1]
    const length = jpeg.readUInt16BE(offset + 2)
    const raw = jpeg.subarray(offset, offset + 2 + length)
    segments.push({ marker, offset, data: raw.subarray(4), raw })
    if (marker === 0xda) return segments
    offset += 2 + length
  }
}

const XMP_SIG = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1')
const isXmp = (s: Segment) => s.marker === 0xe1 && s.data.subarray(0, XMP_SIG.length).equals(XMP_SIG)

// Undoes the JPEG patch: JFIF units 0 and density 1x1, no XMP APP1 or COM.
function stripJpeg(jpeg: Buffer) {
  const head = Buffer.from(jpeg.subarray(0, 20))
  head.set([0, 0, 1, 0, 1], 13)
  const segments = jpegSegments(jpeg)
  const sos = segments[segments.length - 1]
  const kept = segments.slice(1).filter((s) => !isXmp(s) && s.marker !== 0xfe)
  return Buffer.concat([head, ...kept.slice(0, -1).map((s) => s.raw), jpeg.subarray(sos.offset)])
}

const PHYS: [number, string][] = [
  [1, '00000009704859730000002700000027012a09914f'],
  [72, '000000097048597300000b1300000b1301009a9c18'],
  [96, '000000097048597300000ec400000ec401952b0e1b'],
  [150, '0000000970485973000017120000171201679fd252'],
  [300, '000000097048597300002e2300002e230178a53f76'],
  [600, '000000097048597300005c4600005c460114944341'],
]

const XMP_HEAD =
  '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
  '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
  '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n'
const XMP_TAIL = '</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>'

const ALL: ImageMetadata = {
  resolution: 300,
  title: 'Floor plan',
  author: 'Jane Doe',
  description: 'Ground floor, 1:100',
  copyright: '© 2026 Jane Doe',
  software: 'test',
  comment: 'a comment',
}

test('PNG pHYs bytes equal node-canvas', async (t) => {
  const canvas = drawn()
  for (const [resolution, hex] of PHYS) {
    const png = canvas.toBuffer('image/png', { resolution })
    t.deepEqual(canvas.encodeSync('png', { resolution }), png)
    t.deepEqual(await canvas.encode('png', { resolution }), png)
    t.is(physHex(png), hex, `${resolution}`)
    t.deepEqual(chunkTypes(png), ['IHDR', 'sBIT', 'sRGB', 'pHYs', 'IDAT', 'IEND'])
    t.true(pngChunks(png).every(crcOk))
  }
})

test('resolution conversion', (t) => {
  const canvas = drawn()
  const png = (resolution: number) => canvas.toBuffer('image/png', { resolution })
  const ppm = (resolution: number) => {
    const data = pngChunks(png(resolution)).find((c) => c.type === 'pHYs')!.data
    t.is(data.readUInt32BE(0), data.readUInt32BE(4))
    t.is(data[8], 1)
    return data.readUInt32BE(0)
  }
  t.deepEqual(png(300.9), png(300))
  t.is(ppm(1.5), 39)
  t.is(ppm(54546055), 2147483640)
  for (const resolution of [54546056, 2 ** 32, 1e12, 1e300]) t.is(ppm(resolution), 2147483647, `${resolution}`)

  const plain = canvas.toBuffer('image/jpeg', {})
  const jpeg = (resolution: number) => canvas.toBuffer('image/jpeg', { resolution })
  t.is(plain.subarray(0, 20).toString('hex'), 'ffd8ffe000104a46494600010100000100010000')
  const at300 = jpeg(300)
  t.is(at300.subarray(0, 20).toString('hex'), 'ffd8ffe000104a46494600010101012c012c0000')
  t.is(at300.length, plain.length)
  t.deepEqual(at300.subarray(20), plain.subarray(20))
  for (const resolution of [65535, 70000, 1e12]) {
    t.is(jpeg(resolution).subarray(13, 18).toString('hex'), '01ffffffff', `${resolution}`)
  }
  t.is(jpeg(300.9).subarray(13, 18).toString('hex'), '01012c012c')
  t.is(jpeg(1).subarray(13, 18).toString('hex'), '0100010001')
})

test('resolution values that write nothing', async (t) => {
  const canvas = drawn()
  const png = canvas.toBuffer('image/png')
  const jpeg = canvas.toBuffer('image/jpeg', {})
  const values: unknown[] = [
    0,
    -0,
    0.5,
    0.999,
    -1,
    -300,
    NaN,
    Infinity,
    -Infinity,
    '300',
    null,
    undefined,
    true,
    300n,
    new Number(300),
    {},
    [300],
  ]
  for (const resolution of values) {
    const options = { resolution } as any
    t.deepEqual(canvas.toBuffer('image/png', options), png, String(resolution))
    t.deepEqual(canvas.encodeSync('png', options), png, String(resolution))
    t.deepEqual(await canvas.encode('png', options), png, String(resolution))
    t.deepEqual(canvas.toBuffer('image/jpeg', options), jpeg, String(resolution))
  }
})

test('PNG text chunks', (t) => {
  const canvas = drawn()
  const plain = canvas.toBuffer('image/png')
  const reversed = canvas.toBuffer('image/png', {
    comment: 'm',
    software: 's',
    copyright: 'c',
    description: 'd',
    author: 'a',
    title: 't',
  })
  t.deepEqual(textChunks(reversed).map(keyword), ['Title', 'Author', 'Description', 'Copyright', 'Software', 'Comment'])
  t.deepEqual(chunkTypes(reversed), ['IHDR', 'sBIT', 'sRGB', ...Array(6).fill('tEXt'), 'IDAT', 'IEND'])
  t.true(pngChunks(reversed).every(crcOk))
  t.deepEqual(stripPng(reversed), plain)

  // The one text chunk of `title`.
  const titleChunk = (title: unknown) => {
    const chunks = textChunks(canvas.toBuffer('image/png', { title } as any))
    t.is(chunks.length, 1, String(title))
    t.true(crcOk(chunks[0]))
    return chunks[0]
  }
  t.is(titleChunk('Hello').raw.toString('hex'), '0000000b744558745469746c650048656c6c6fcdcfc0cf')
  for (const [text, hex] of [
    ['Café ©', '436166e920a9'],
    ['ÿ', 'ff'],
    ['a\nb', '610a62'],
    [' ~ ', '207ea0'],
    ['a\0b', '6162'],
  ]) {
    const chunk = titleChunk(text)
    t.is(chunk.type, 'tEXt', JSON.stringify(text))
    t.is(chunk.data.toString('hex'), Buffer.from('Title\0', 'latin1').toString('hex') + hex)
  }
  for (const text of ['Ā', '张三', '😀', 'a\tb', 'a\rb', '\u0085', '\u007f', '\u0001', 'éĀ']) {
    const chunk = titleChunk(text)
    t.is(chunk.type, 'iTXt', JSON.stringify(text))
    t.deepEqual(chunk.data, Buffer.concat([Buffer.from('Title\0\0\0\0\0', 'latin1'), Buffer.from(text, 'utf8')]))
  }
  // A lone surrogate arrives as U+FFFD.
  const lone = titleChunk('\ud800')
  t.is(lone.type, 'iTXt')
  t.is(lone.data.subarray(10).toString('hex'), 'efbfbd')
  for (const title of ['\0', '', 5, null, {}, ['x'], new String('x')]) {
    t.deepEqual(canvas.toBuffer('image/png', { title } as any), plain, String(title))
  }
  // No limit short of the chunk size.
  const description = 'x'.repeat(1 << 20)
  const big = textChunks(canvas.toBuffer('image/png', { description }))
  t.is(big.length, 1)
  t.is(big[0].data.length, 'Description\0'.length + description.length)
  t.true(crcOk(big[0]))
})

test('JPEG text segments', async (t) => {
  const canvas = drawn()
  const plain = canvas.toBuffer('image/jpeg')
  const options = {
    title: 'T&<>',
    author: 'a\rb',
    description: 'd\u0001e',
    copyright: '￾c',
    software: 's',
    comment: 'c 张',
  }
  const jpeg = canvas.toBuffer('image/jpeg', options)
  t.deepEqual(canvas.encodeSync('jpeg', options), jpeg)
  t.deepEqual(await canvas.encode('jpeg', options), jpeg)

  const packet =
    XMP_HEAD +
    '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">T&amp;&lt;&gt;</rdf:li></rdf:Alt></dc:title>\n' +
    '<dc:creator><rdf:Seq><rdf:li>a&#xD;b</rdf:li></rdf:Seq></dc:creator>\n' +
    '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">de</rdf:li></rdf:Alt></dc:description>\n' +
    '<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">c</rdf:li></rdf:Alt></dc:rights>\n' +
    '<xmp:CreatorTool>s</xmp:CreatorTool>\n' +
    XMP_TAIL
  const packetBytes = Buffer.from(packet, 'utf8')
  const segments = jpegSegments(jpeg)
  t.deepEqual(jpeg.subarray(0, 20), plain.subarray(0, 20))
  const [app0, app1, com, app2] = segments
  t.is(app0.marker, 0xe0)
  t.is(app1.marker, 0xe1)
  t.is(app1.offset, 20)
  t.is(app1.raw.readUInt16BE(2), 2 + 29 + packetBytes.length)
  t.deepEqual(app1.data.subarray(0, 29), XMP_SIG)
  t.is(app1.data.subarray(29).toString('utf8'), packet)
  t.is(com.marker, 0xfe)
  t.is(com.offset, 20 + app1.raw.length)
  t.deepEqual(com.data, Buffer.from('c 张', 'utf8'))
  t.is(app2.marker, 0xe2)
  t.is(app2.data.toString('latin1', 0, 12), 'ICC_PROFILE\0')
  t.deepEqual(jpeg.subarray(app2.offset), plain.subarray(20))

  // Only a comment: COM right after the APP0.
  const onlyComment = jpegSegments(canvas.toBuffer('image/jpeg', { comment: 'c' }))
  t.is(onlyComment[1].marker, 0xfe)
  t.is(onlyComment[1].offset, 20)
  t.false(onlyComment.some(isXmp))
  // A title that XML cannot hold any of writes no APP1.
  t.deepEqual(canvas.toBuffer('image/jpeg', { title: '\u0001' }), canvas.toBuffer('image/jpeg', {}))
})

test('JPEG limits', async (t) => {
  const canvas = drawn()
  const xmpError = (n: number) => ({
    instanceOf: RangeError,
    message: `The JPEG XMP metadata is ${n} bytes; one APP1 segment holds at most 65504.`,
  })
  const largest = canvas.toBuffer('image/jpeg', { description: 'x'.repeat(65078) })
  t.is(largest.readUInt16BE(22), 65535)
  t.is(largest.readUInt16BE(20), 0xffe1)
  const tooLarge = { description: 'x'.repeat(65079) }
  t.throws(() => canvas.toBuffer('image/jpeg', tooLarge), xmpError(65505))
  t.throws(() => canvas.encodeSync('jpeg', tooLarge), xmpError(65505))
  // Thrown, not a rejection.
  t.throws(() => canvas.encode('jpeg', tooLarge), xmpError(65505))
  // UTF-8 bytes after escaping count.
  t.notThrows(() => canvas.toBuffer('image/jpeg', { description: '张'.repeat(21692) }))
  t.throws(() => canvas.toBuffer('image/jpeg', { description: '张'.repeat(21693) }), xmpError(65505))
  t.notThrows(() => canvas.toBuffer('image/jpeg', { description: '&'.repeat(13015) }))
  t.throws(() => canvas.toBuffer('image/jpeg', { description: '&'.repeat(13016) }), xmpError(65506))

  const comment = canvas.toBuffer('image/jpeg', { comment: 'y'.repeat(65533) })
  t.is(comment.readUInt16BE(20), 0xfffe)
  t.is(comment.readUInt16BE(22), 65535)
  const comError = {
    instanceOf: RangeError,
    message: 'The JPEG comment is 65534 bytes; one COM segment holds at most 65533.',
  }
  t.throws(() => canvas.toBuffer('image/jpeg', { comment: 'y'.repeat(65534) }), comError)
  t.throws(() => canvas.encode('jpeg', { comment: 'y'.repeat(65534) }), comError)
  // The XMP limit is checked first.
  t.throws(() => canvas.toBuffer('image/jpeg', { ...tooLarge, comment: 'y'.repeat(65534) }), xmpError(65505))

  // PNG text has no such limit.
  for (const options of [tooLarge, { description: '&'.repeat(13016) }, { comment: 'y'.repeat(65534) }]) {
    const png = await canvas.encode('png', options)
    t.is(textChunks(png).length, 1)
  }
})

test('quality is unchanged', (t) => {
  const canvas = drawn()
  // toBuffer reads no quality from an object: 92.
  t.deepEqual(
    stripJpeg(canvas.toBuffer('image/jpeg', { quality: 10, resolution: 300 } as any)),
    canvas.toBuffer('image/jpeg'),
  )
  t.deepEqual(stripJpeg(canvas.encodeSync('jpeg', { quality: 50, title: 't' })), canvas.encodeSync('jpeg', 50))
  t.notDeepEqual(canvas.encodeSync('jpeg', 50), canvas.encodeSync('jpeg'))
  // An object that is not an AvifConfig has always given 92.
  t.deepEqual(
    stripJpeg(canvas.encodeSync('jpeg', { quality: 50, chromaSubsampling: true, resolution: 300 } as any)),
    canvas.encodeSync('jpeg'),
  )
})

test('metadata only inserts', async (t) => {
  for (const [kind, attrs] of Object.entries(KINDS)) {
    const canvas = drawn(attrs as any)
    const plainPng = canvas.toBuffer('image/png')
    const plainJpeg = canvas.toBuffer('image/jpeg', {})
    const png = canvas.toBuffer('image/png', ALL)
    const jpeg = canvas.toBuffer('image/jpeg', ALL)
    t.deepEqual(stripPng(png), plainPng, kind)
    t.deepEqual(stripJpeg(jpeg), plainJpeg, kind)
    t.true(pngChunks(png).every(crcOk), kind)
    const types = chunkTypes(png)
    t.is(types.indexOf('pHYs'), types.indexOf('IDAT') - 7, kind)
    if (kind === 'display-p3') {
      t.deepEqual(types.slice(0, 4), ['IHDR', 'sBIT', 'iCCP', 'pHYs'])
    }
    t.deepEqual(
      jpegSegments(jpeg)
        .slice(0, 4)
        .map((s) => s.marker),
      [0xe0, 0xe1, 0xfe, 0xe2],
      kind,
    )

    const pixels = async (data: Buffer) => {
      const image = await loadImage(data)
      const target = createCanvas(64, 48)
      const ctx = target.getContext('2d')
      ctx.drawImage(image, 0, 0)
      return Buffer.from(ctx.getImageData(0, 0, 64, 48).data)
    }
    t.deepEqual(await pixels(png), await pixels(plainPng), kind)
    t.deepEqual(await pixels(jpeg), await pixels(plainJpeg), kind)
  }
})

test('WebP, AVIF and GIF ignore metadata', async (t) => {
  const canvas = drawn()
  const pairs: [string, object, object][] = [
    ['webp', {}, { resolution: 300, title: 'x', comment: 'c' }],
    ['avif', { quality: 50, speed: 10 }, { quality: 50, speed: 10, title: 'x', resolution: 300 }],
    ['gif', {}, { title: 'x' }],
    ['webp', { quality: 'x' }, { quality: 'x', title: 'x' }],
    ['webp', { quality: 50 }, { quality: 50, ...ALL }],
  ]
  for (const [format, plain, withMetadata] of pairs) {
    const label = `${format} ${JSON.stringify(withMetadata)}`
    const c = canvas as any
    t.deepEqual(c.toBuffer(`image/${format}`, withMetadata), c.toBuffer(`image/${format}`, plain), label)
    t.deepEqual(c.encodeSync(format, withMetadata), c.encodeSync(format, plain), label)
    t.deepEqual(await c.encode(format, withMetadata), await c.encode(format, plain), label)
  }
})

test('unchanged without metadata', async (t) => {
  const canvas = drawn()
  const objects: any[] = [
    { compressionLevel: 9 },
    { foo: 1 },
    [],
    { quality: 50, speed: 10 },
    { resolution: 0, title: '', author: null, comment: 5 },
  ]
  const png = canvas.toBuffer('image/png')
  for (const object of objects) {
    const label = JSON.stringify(object)
    t.deepEqual(canvas.toBuffer('image/png', object), png, label)
    t.deepEqual(canvas.encodeSync('png', object), png, label)
    t.deepEqual(await canvas.encode('png', object), png, label)
    t.deepEqual(canvas.toBuffer('image/jpeg', object), canvas.toBuffer('image/jpeg'), label)
    t.deepEqual(canvas.toBuffer('image/webp', object), canvas.toBuffer('image/webp', 80), label)
    const quality = object.quality ?? 92
    t.deepEqual(canvas.encodeSync('jpeg', object), canvas.encodeSync('jpeg', quality), label)
    t.deepEqual(await canvas.encode('webp', object), canvas.encodeSync('webp', quality), label)
  }
  t.deepEqual(chunkTypes(png), ['IHDR', 'sBIT', 'sRGB', 'IDAT', 'IEND'])
  t.false(jpegSegments(canvas.toBuffer('image/jpeg')).some((s) => isXmp(s) || s.marker === 0xfe))
})

test('web methods never write metadata', async (t) => {
  const canvas = drawn()
  const png = canvas.toBuffer('image/png')
  const fromUrl = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
  t.deepEqual(fromUrl(canvas.toDataURL('image/png', { resolution: 300 } as any)), png)
  t.deepEqual(fromUrl(await canvas.toDataURLAsync('image/png', { resolution: 300, title: 'x' } as any)), png)
  t.is(
    canvas.toDataURL('image/avif', { quality: 50, resolution: 300, title: 'x' } as any),
    canvas.toDataURL('image/avif', { quality: 50 }),
  )
  t.is(canvas.toDataURL('image/jpeg', { resolution: 300 } as any), canvas.toDataURL('image/jpeg'))
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png', { resolution: 300, title: 'x' }),
  )
  t.deepEqual(chunkTypes(Buffer.from(await blob!.arrayBuffer())), ['IHDR', 'sBIT', 'sRGB', 'IDAT', 'IEND'])
  const converted = await canvas.convertToBlob({ type: 'image/png', resolution: 300, title: 'x' } as any)
  t.deepEqual(chunkTypes(Buffer.from(await converted.arrayBuffer())), ['IHDR', 'sBIT', 'sRGB', 'IDAT', 'IEND'])
  const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', resolution: 300, comment: 'x' } as any)
  const jpeg = Buffer.from(await jpegBlob.arrayBuffer())
  t.is(jpeg.subarray(0, 20).toString('hex'), 'ffd8ffe000104a46494600010100000100010000')
  t.false(jpegSegments(jpeg).some((s) => isXmp(s) || s.marker === 0xfe))
  // Nothing is kept on the canvas.
  canvas.toBuffer('image/png', ALL)
  t.deepEqual(fromUrl(canvas.toDataURL('image/png')), png)
  t.deepEqual(canvas.toBuffer('image/png'), png)
})

test('encodeStream and savePng write no metadata', async (t) => {
  const canvas = drawn()
  // encodeStream's quality is still a number only.
  t.throws(() => (canvas as any).encodeStream('png', { resolution: 300 }), { code: 'NumberExpected' })
  const dir = mkdtempSync(join(tmpdir(), 'image-metadata-'))
  try {
    const path = join(dir, 'out.png')
    ;(canvas as any).savePng(path)
    t.deepEqual(chunkTypes(readFileSync(path)), ['IHDR', 'sBIT', 'sRGB', 'IDAT', 'IEND'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const AVIF_MEMBERS = ['quality', 'alphaQuality', 'speed', 'threads', 'chromaSubsampling']
const METADATA_MEMBERS = ['resolution', 'title', 'author', 'description', 'copyright', 'software', 'comment']

test('property reads', async (t) => {
  const canvas = drawn()
  const log: string[] = []
  const logged = <T extends object>(target: T) =>
    new Proxy(target, {
      get(object, key, receiver) {
        log.push(String(key))
        return Reflect.get(object, key, receiver)
      },
    })
  const calls: [string, (options: any) => unknown][] = [
    ['toBuffer', (options) => canvas.toBuffer('image/png', options)],
    ['encodeSync', (options) => canvas.encodeSync('jpeg', options)],
    ['encode', (options) => canvas.encode('webp', options)],
  ]
  for (const [name, call] of calls) {
    log.length = 0
    await call(logged({}))
    t.deepEqual(log, [...AVIF_MEMBERS, ...METADATA_MEMBERS], name)
    log.length = 0
    await call(logged(function () {}))
    t.deepEqual(log, [], `${name} function`)
  }

  // Nothing is read from a number, also through Number.prototype.
  const reads: string[] = []
  for (const key of [...AVIF_MEMBERS, ...METADATA_MEMBERS]) {
    Object.defineProperty(Number.prototype, key, {
      configurable: true,
      get() {
        reads.push(key)
        return undefined
      },
    })
  }
  try {
    canvas.toBuffer('image/png', 50 as any)
    canvas.encodeSync('jpeg', 50)
  } finally {
    for (const key of [...AVIF_MEMBERS, ...METADATA_MEMBERS]) delete (Number.prototype as any)[key]
  }
  t.deepEqual(reads, [])

  // A getter that throws: its error, and nothing after it is read.
  const read: string[] = []
  const throwingAuthor = {
    get title() {
      read.push('title')
      return 't'
    },
    get author(): string {
      throw new Error('author getter')
    },
    get description() {
      read.push('description')
      return 'd'
    },
  }
  t.throws(() => canvas.toBuffer('image/png', throwingAuthor), { message: 'author getter' })
  t.throws(() => canvas.encode('png', throwingAuthor), { message: 'author getter' })
  t.deepEqual(read, ['title', 'title'])
  const throwingQuality = {
    get quality(): number {
      throw new Error('quality getter')
    },
    get resolution() {
      read.push('resolution')
      return 300
    },
  }
  t.throws(() => canvas.encodeSync('jpeg', throwingQuality), { message: 'quality getter' })
  t.throws(() => canvas.toBuffer('image/png', throwingQuality), { message: 'quality getter' })
  t.false(read.includes('resolution'))

  // Inherited members count.
  const inherited = textChunks(canvas.toBuffer('image/png', Object.create({ title: 'inh' })))
  t.is(inherited.length, 1)
  t.is(inherited[0].data.toString('latin1'), 'Title\0inh')
})

test('error order', async (t) => {
  const big = { description: 'x'.repeat(70000) }
  const empty = createCanvas(0, 0)
  t.throws(() => empty.toBuffer('image/jpeg', big), { name: 'IndexSizeError' })
  t.throws(() => empty.encodeSync('jpeg', big), { name: 'IndexSizeError' })
  await t.throwsAsync(empty.encode('jpeg', big), { name: 'IndexSizeError' })
  const canvas = drawn()
  t.throws(() => canvas.toBuffer('image/bogus' as any, big), { message: 'image/bogus is not valid mime' })
  t.throws(() => canvas.encodeSync('bogus' as any, big), { message: 'bogus is not valid format' })
  t.throws(() => canvas.encode('bogus' as any, big), { message: 'bogus is not valid format' })
  // A format that ignores metadata has no limit.
  t.notThrows(() => canvas.toBuffer('image/webp', big as any))
})
