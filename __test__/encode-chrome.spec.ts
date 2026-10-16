import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, loadImage } from '../index'

// toDataURL, toBlob and convertToBlob pick the type and the quality as
// Chrome 155 does (Blink ImageEncoderUtils::ToEncodingMimeType and
// ImageEncoder::ComputeJpegQuality / ComputeWebpOptions). The values were
// measured in Chrome 155 (--disable-gpu, standards-mode page), the same on
// arm64 and x64. Our JPEG and lossy WebP bytes for a quality are Chrome's, so
// a Chrome quality class is checked against our own encoder at that quality.

const INDEX = fileURLToPath(new URL('../index.js', import.meta.url))

// 32x32: r = x * 8, g = y * 8, b = (x ^ y) * 16.
function patternCanvas() {
  const canvas = createCanvas(32, 32)
  const ctx = canvas.getContext('2d')
  const id = ctx.createImageData(32, 32)
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      id.data.set([x * 8, y * 8, ((x ^ y) * 16) & 255, 255], (y * 32 + x) * 4)
    }
  }
  ctx.putImageData(id, 0, 0)
  return canvas
}

const prefix = (url: string) => url.slice(0, url.indexOf(','))
const payload = (url: string) => url.slice(url.indexOf(',') + 1)
const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64')

async function blob(canvas: ReturnType<typeof createCanvas>, ...args: any[]) {
  const result = await new Promise<Blob | null>((resolve) => (canvas.toBlob as any)(resolve, ...args))
  return result && { type: result.type, b64: b64(new Uint8Array(await result.arrayBuffer())) }
}

async function converted(canvas: ReturnType<typeof createCanvas>, options?: any) {
  const result = await canvas.convertToBlob(options)
  return { type: result.type, b64: b64(new Uint8Array(await result.arrayBuffer())) }
}

// Values that are not a number in [0, 1]: each gives the default quality.
const NOT_A_QUALITY = [undefined, 2, -0.1, '0.5', null, true, NaN, Infinity, {}, [0.5], 1.0000001]

test('toDataURL picks the type like Chrome', (t) => {
  const canvas = patternCanvas()
  const png = payload(canvas.toDataURL())
  for (const type of [
    undefined,
    'image/bogus',
    '',
    null,
    123,
    {},
    'image/jpeg ',
    ' image/jpeg',
    'image/jpeg;q=1',
    'image/jpg',
    'image/bmp',
    'image/svg+xml',
    'IMAGE/PNG',
  ]) {
    const url = canvas.toDataURL(type as any)
    t.is(prefix(url), 'data:image/png;base64', String(type))
    t.is(payload(url), png, String(type))
  }
  const jpeg = canvas.toDataURL('image/jpeg')
  t.is(canvas.toDataURL('IMAGE/JPEG'), jpeg)
  t.is(canvas.toDataURL({ toString: () => 'image/jpeg' } as any), jpeg)
  t.is(prefix(canvas.toDataURL('Image/WebP')), 'data:image/webp;base64')
  t.is(payload(canvas.toDataURL('Image/WebP')), payload(canvas.toDataURL('image/webp')))
  // Chrome encodes these as PNG; AVIF and GIF are this library's extra types.
  t.is(prefix(canvas.toDataURL('image/gif')), 'data:image/gif;base64')
  t.is(prefix(canvas.toDataURL('image/avif')), 'data:image/avif;base64')
  t.is(prefix(canvas.toDataURL('IMAGE/AVIF')), 'data:image/avif;base64')
  t.throws(() => canvas.toDataURL(Symbol('x') as any), {
    instanceOf: TypeError,
    message: "Failed to execute 'toDataURL' on 'HTMLCanvasElement': Cannot convert a Symbol value to a string",
  })
  const mine = new Error('mine')
  t.is(
    t.throws(() =>
      canvas.toDataURL({
        toString() {
          throw mine
        },
      } as any),
    ),
    mine,
  )
})

test('toDataURL JPEG quality rounds like Chrome', (t) => {
  const canvas = patternCanvas()
  const jpeg = (quality: number) => b64(canvas.toBuffer('image/jpeg', quality))
  for (const [quality, percent] of [
    [0.29, 29],
    [0.2899, 29],
    [0.285, 28],
    [0.284, 28],
    [0.995, 100],
    [0.994, 99],
    [0.999, 100],
    [0.555, 56],
    [0.805, 81],
    [0.5, 50],
    [0, 0],
    [-0, 0],
    [1e-9, 0],
    [0.005, 0],
    [1, 100],
  ]) {
    t.is(payload(canvas.toDataURL('image/jpeg', quality)), jpeg(percent), String(quality))
  }
  for (const quality of NOT_A_QUALITY) {
    t.is(payload(canvas.toDataURL('image/jpeg', quality)), jpeg(92), String(quality))
  }
  // A quality that is not a number is not converted.
  let calls = 0
  canvas.toDataURL('image/jpeg', {
    valueOf() {
      calls++
      return 0.5
    },
  })
  t.is(calls, 0)
  t.notThrows(() => canvas.toDataURL('image/jpeg', Symbol('x')))
})

// Exactly 1 is lossless; a lossy quality keeps its fraction (0.284 matches no
// whole-number quality), and anything else is 80.
test('toDataURL WebP quality like Chrome', (t) => {
  const canvas = patternCanvas()
  const webp = (quality: number) => b64(canvas.toBuffer('image/webp', quality))
  for (const quality of NOT_A_QUALITY) {
    t.is(payload(canvas.toDataURL('image/webp', quality)), webp(80), String(quality))
  }
  t.is(payload(canvas.toDataURL('image/webp', 1)), webp(100), 'lossless')
  for (const [quality, percent] of [
    [0.92, 92],
    [0.29, 29],
    [0.2899, 29],
    [0.285, 29],
    [0, 0],
    [-0, 0],
    [0.5, 50],
  ]) {
    t.is(payload(canvas.toDataURL('image/webp', quality)), webp(percent), String(quality))
  }
  const q0284 = payload(canvas.toDataURL('image/webp', 0.284))
  t.not(q0284, webp(28))
  t.not(q0284, webp(29))
  const q0995 = payload(canvas.toDataURL('image/webp', 0.995))
  t.is(payload(canvas.toDataURL('image/webp', 0.994)), q0995)
  t.is(payload(canvas.toDataURL('image/webp', 0.999)), q0995)
  t.not(q0995, webp(99))
  t.not(q0995, webp(100))
})

test('toBlob type and quality like Chrome', async (t) => {
  const canvas = patternCanvas()
  const png = b64(canvas.toBuffer('image/png'))
  const jpeg = (quality: number) => b64(canvas.toBuffer('image/jpeg', quality))
  const webp = (quality: number) => b64(canvas.toBuffer('image/webp', quality))
  t.deepEqual(await blob(canvas), { type: 'image/png', b64: png })
  for (const type of ['image/bogus', '', null, 5, undefined]) {
    t.deepEqual(await blob(canvas, type), { type: 'image/png', b64: png }, String(type))
  }
  t.deepEqual(await blob(canvas, 'IMAGE/JPEG'), { type: 'image/jpeg', b64: jpeg(92) })
  for (const quality of ['0.5', null, true, NaN, undefined, 2]) {
    t.deepEqual(await blob(canvas, 'image/jpeg', quality), { type: 'image/jpeg', b64: jpeg(92) }, String(quality))
  }
  t.deepEqual(await blob(canvas, 'image/jpeg', 0.5), { type: 'image/jpeg', b64: jpeg(50) })
  t.deepEqual(await blob(canvas, 'image/jpeg', 1), { type: 'image/jpeg', b64: jpeg(100) })
  t.deepEqual(await blob(canvas, 'image/webp'), { type: 'image/webp', b64: webp(80) })
  t.deepEqual(await blob(canvas, 'image/webp', 0.8), { type: 'image/webp', b64: webp(80) })
  t.deepEqual(await blob(canvas, 'image/webp', 1), { type: 'image/webp', b64: webp(100) })
  // The callback runs later, never during the call.
  let called = false
  canvas.toBlob(() => {
    called = true
  })
  t.false(called)
})

// Chrome reads toBlob's quality only when it is a number
// (html_canvas_element.cc:1517-1520): an object is never read, so a getter
// or a Proxy trap never runs, and the encode is the default one. This holds
// for AVIF too; only toDataURL takes an AvifConfig.
test('toBlob never reads an object quality, like Chrome', async (t) => {
  const canvas = patternCanvas()
  for (const type of ['image/avif', 'image/jpeg', 'image/webp']) {
    const expected = await blob(canvas, type)
    t.is(expected!.type, type)
    const reads: string[] = []
    const getters = {
      get quality() {
        reads.push('quality')
        throw new Error('boom-quality')
      },
      get speed() {
        reads.push('speed')
        throw new Error('boom-speed')
      },
    }
    const traps = Object.fromEntries(
      ['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'].map((trap) => [
        trap,
        (...args: any[]) => {
          reads.push(`proxy ${trap}`)
          return (Reflect as any)[trap](...args)
        },
      ]),
    )
    const proxy = new Proxy({ quality: 10 }, traps)
    for (const [label, quality] of [
      ['throwing getters', getters],
      ['Proxy', proxy],
      ['plain object', { quality: 10, speed: 0 }],
    ] as const) {
      t.deepEqual(await blob(canvas, type, quality), expected, `${type} ${label}`)
    }
    t.deepEqual(reads, [], type)
  }
})

test('toBlob argument errors like Chrome', (t) => {
  const canvas = patternCanvas()
  t.is(canvas.toBlob.length, 1)
  t.throws(() => (canvas.toBlob as any)(), {
    instanceOf: TypeError,
    message: "Failed to execute 'toBlob' on 'HTMLCanvasElement': 1 argument required, but only 0 present.",
  })
  for (const callback of [null, {}, 5, undefined]) {
    t.throws(() => canvas.toBlob(callback as any), {
      instanceOf: TypeError,
      message: "Failed to execute 'toBlob' on 'HTMLCanvasElement': parameter 1 is not of type 'Function'.",
    })
  }
  t.throws(() => canvas.toBlob(() => {}, Symbol('x') as any), {
    instanceOf: TypeError,
    message: "Failed to execute 'toBlob' on 'HTMLCanvasElement': Cannot convert a Symbol value to a string",
  })
  const mine = new Error('mine')
  t.is(
    t.throws(() =>
      canvas.toBlob(() => {}, {
        toString() {
          throw mine
        },
      } as any),
    ),
    mine,
  )
  t.notThrows(() => canvas.toBlob(() => {}, 'image/jpeg', Symbol('x')))
})

// Chrome reports a throw in the callback as an uncaught exception
// (window.onerror) and calls the callback once.
test('a throwing toBlob callback is an uncaught exception, called once', (t) => {
  const script = `
    const { createCanvas } = require(${JSON.stringify(INDEX)})
    let calls = 0, uncaught = 0, unhandled = 0
    process.on('uncaughtException', () => uncaught++)
    process.on('unhandledRejection', () => unhandled++)
    createCanvas(4, 4).toBlob(() => { calls++; throw new Error('boom') })
    try { createCanvas(4, 4).toBlob() } catch {}
    try { createCanvas(4, 4).toBlob(null) } catch {}
    setTimeout(() => console.log(JSON.stringify({ calls, uncaught, unhandled })), 300)
  `
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  t.is(result.status, 0, result.stderr)
  t.deepEqual(JSON.parse(result.stdout), { calls: 1, uncaught: 1, unhandled: 0 })
})

test('convertToBlob reads ImageEncodeOptions like Chrome', async (t) => {
  const canvas = patternCanvas()
  const png = { type: 'image/png', b64: b64(canvas.toBuffer('image/png')) }
  const jpeg = (quality: number) => ({ type: 'image/jpeg', b64: b64(canvas.toBuffer('image/jpeg', quality)) })
  const webp = (quality: number) => ({ type: 'image/webp', b64: b64(canvas.toBuffer('image/webp', quality)) })
  for (const options of [undefined, null, {}, () => {}, { type: 5 }, { type: 'image/bogus' }, { mime: 'image/jpeg' }]) {
    t.deepEqual(await converted(canvas, options), png, String(options && JSON.stringify(options)))
  }
  // The default quality is 1.0: JPEG 100 (4:4:4) and lossless WebP.
  t.deepEqual(await converted(canvas, { type: 'image/jpeg' }), jpeg(100))
  t.deepEqual(await converted(canvas, { type: 'IMAGE/JPEG' }), jpeg(100))
  t.deepEqual(await converted(canvas, { type: 'image/webp' }), webp(100))
  t.deepEqual(await converted(canvas, { type: 'image/webp', quality: 0.5 }), webp(50))
  // quality is an unrestricted double: converted with ToNumber.
  for (const [quality, percent] of [
    [0.5, 50],
    ['0.5', 50],
    [null, 0],
    [true, 100],
    [1, 100],
    [NaN, 92],
    [2, 92],
    [-1, 92],
  ] as const) {
    t.deepEqual(await converted(canvas, { type: 'image/jpeg', quality }), jpeg(percent), String(quality))
  }
  // quality is read before type, and there is no `mime` member.
  const order: string[] = []
  await canvas.convertToBlob({
    get type() {
      order.push('type')
      return 'image/jpeg'
    },
    get quality() {
      order.push('quality')
      return 0.5
    },
    get mime() {
      order.push('mime')
      return 'image/png'
    },
  } as any)
  t.deepEqual(order, ['quality', 'type'])
  const prefix = "Failed to execute 'convertToBlob' on 'OffscreenCanvas': "
  for (const [options, message] of [
    [5, "The provided value is not of type 'ImageEncodeOptions'."],
    ['image/jpeg', "The provided value is not of type 'ImageEncodeOptions'."],
    [
      { type: Symbol('x') },
      "Failed to read the 'type' property from 'ImageEncodeOptions': Cannot convert a Symbol value to a string",
    ],
    [
      { quality: Symbol('x') },
      "Failed to read the 'quality' property from 'ImageEncodeOptions': Cannot convert a Symbol value to a number",
    ],
    [
      { quality: 1n },
      "Failed to read the 'quality' property from 'ImageEncodeOptions': Cannot convert a BigInt value to a number",
    ],
  ] as const) {
    let promise: Promise<Blob> | undefined
    t.notThrows(() => {
      promise = canvas.convertToBlob(options as any)
    })
    t.true(promise instanceof Promise)
    await t.throwsAsync(promise!, { instanceOf: TypeError, message: prefix + message })
  }
  const q = new Error('q')
  t.is(
    await t.throwsAsync(
      canvas.convertToBlob({
        quality: {
          valueOf() {
            throw q
          },
        },
        type: {
          toString() {
            throw new Error('t')
          },
        },
      } as any),
    ),
    q,
  )
})

// Past arguments.length, arguments[i] reads Object.prototype[i]: Chrome 155
// reads none of them for toBlob(callback) and convertToBlob(), and encodes a
// PNG. The getters log each read and are removed before the call returns.
// Serial: they are on Object.prototype, which every test uses.
test.serial('toBlob and convertToBlob read only the arguments they were given, like Chrome', async (t) => {
  const canvas = patternCanvas()
  const png = { type: 'image/png', b64: b64(canvas.toBuffer('image/png')) }
  // Under the test loader, index.js has a source map. Node parses it when it
  // first formats a stack through index.js, and that parse reads
  // Object.prototype[0]: throw through index.js before the getters are there.
  void t.throws(() => (canvas.toBlob as any)())?.stack
  // What a read would get: a JPEG type, quality or options.
  const values: Record<string, unknown> = { 0: { type: 'image/jpeg' }, 1: 'image/jpeg', 2: 0.5 }
  let reads = ''
  const withIndexGetters = <T>(call: () => T): T => {
    for (const key of Object.keys(values)) {
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          reads += `${key} `
          return values[key]
        },
        set(value) {
          Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true })
        },
      })
    }
    try {
      return call()
    } finally {
      for (const key of Object.keys(values)) delete (Object.prototype as any)[key]
    }
  }
  const viaToBlob = withIndexGetters(() => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve)))
  t.is(reads.trim(), '', 'toBlob(callback)')
  const viaConvert = withIndexGetters(() => canvas.convertToBlob())
  t.is(reads.trim(), '', 'convertToBlob()')
  t.false('0' in Object.prototype)
  for (const [label, blob] of [
    ['toBlob(callback)', await viaToBlob],
    ['convertToBlob()', await viaConvert],
  ] as const) {
    t.deepEqual({ type: blob!.type, b64: b64(new Uint8Array(await blob!.arrayBuffer())) }, png, label)
  }
})

// toDataURL gives "data:," when the encoder cannot hold the size; toBlob and
// convertToBlob encode the top-left part it can hold (JPEG 65500, WebP 16383).
test('encoders crop or fail at the format maximum like Chrome', async (t) => {
  const size = async (data: Blob) => {
    const image = await loadImage(Buffer.from(await data.arrayBuffer()))
    return [image.width, image.height]
  }
  for (const [width, type, dataUrl, cropped] of [
    [16383, 'image/webp', 'data:image/webp;base64', 16383],
    [16384, 'image/webp', 'data:,', 16383],
    [65500, 'image/webp', 'data:,', 16383],
    [16384, 'image/jpeg', 'data:image/jpeg;base64', 16384],
    [65500, 'image/jpeg', 'data:image/jpeg;base64', 65500],
    [65501, 'image/jpeg', 'data:,', 65500],
    [65535, 'image/png', 'data:image/png;base64', 65535],
  ] as const) {
    const canvas = createCanvas(width, 1)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'red'
    ctx.fillRect(0, 0, width, 1)
    const label = `${width}x1 ${type}`
    const url = canvas.toDataURL(type)
    t.is(url === 'data:,' ? url : prefix(url), dataUrl, label)
    const viaToBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type))
    t.is(viaToBlob!.type, type, label)
    t.deepEqual(await size(viaToBlob!), [cropped, 1], `${label} toBlob`)
    const viaConvert = await canvas.convertToBlob({ type })
    t.deepEqual(await size(viaConvert), [cropped, 1], `${label} convertToBlob`)
  }
})

// No Chrome counterpart: the Node methods take a 0-100 quality, and a larger
// one is 100 (it used to wrap around a byte, or fail for WebP).
test('Node encoders clamp quality to 100', (t) => {
  const canvas = patternCanvas()
  const jpeg100 = canvas.encodeSync('jpeg', 100)
  const webp100 = canvas.encodeSync('webp', 100)
  for (const quality of [101, 300, 356]) {
    t.deepEqual(canvas.encodeSync('jpeg', quality), jpeg100, `encodeSync jpeg ${quality}`)
    t.deepEqual(canvas.toBuffer('image/jpeg', quality), jpeg100, `toBuffer jpeg ${quality}`)
    t.deepEqual(canvas.encodeSync('webp', quality), webp100, `encodeSync webp ${quality}`)
    t.deepEqual(canvas.toBuffer('image/webp', quality), webp100, `toBuffer webp ${quality}`)
  }
  // Without a quality: 92 for JPEG and WebP, as before.
  t.deepEqual(canvas.encodeSync('jpeg'), canvas.encodeSync('jpeg', 92))
  t.deepEqual(canvas.encodeSync('webp'), canvas.encodeSync('webp', 92))
  t.deepEqual(canvas.toBuffer('image/webp'), canvas.toBuffer('image/webp', 92))
})
