// pixelFormat 'rgba-float16' and 'rgba-float32' ImageData, on unorm8 canvases.
// Values: Chrome 155 (fixtures/float16/chrome-pins.json, see float16-helpers.ts).
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, ImageData, PDFDocument, SvgExportFlag } from '../index'

import { HAS_F16, Float16, all3, arr, chromeEqual, ctx, desc, err, px } from './float16-helpers'

const AnyImageData = ImageData as any
const loose = (value: unknown) => value as any

test('new ImageData(sw, sh, {pixelFormat}) makes Float16Array and Float32Array data', (t) => {
  const out: Record<string, unknown> = {}
  if (HAS_F16) out.f16 = err(() => new AnyImageData(1, 1, { pixelFormat: 'rgba-float16' }))
  out.f32 = err(() => new AnyImageData(2, 1, { pixelFormat: 'rgba-float32', colorSpace: 'display-p3' }))
  out.u8 = err(() => new AnyImageData(1, 1, { pixelFormat: 'rgba-unorm8' }))
  out.bogus = err(() => new AnyImageData(1, 1, { pixelFormat: 'bogus' }))
  out.f32name = err(() => new AnyImageData(1, 1, { pixelFormat: 'float32' }))
  chromeEqual(t, out, 'I1-ctor-sizes', { strip: [['f16']] })
})

test('new ImageData(floatArray, ...) keeps the array and needs the matching pixelFormat', (t) => {
  const out: Record<string, unknown> = {}
  const f32 = new Float32Array([0.5, 0.25, 1, 1, 0, 0, 0, 0])
  out.f32 = err(() => {
    const id = new AnyImageData(f32, 2, 1, { pixelFormat: 'rgba-float32' })
    return { same: id.data === f32, ...desc(id) }
  })
  out.f32noh = err(() => new AnyImageData(new Float32Array(8), 1, undefined, { pixelFormat: 'rgba-float32' }))
  out.f32h = err(() => new AnyImageData(new Float32Array(8), 1, 2, { pixelFormat: 'rgba-float32' }))
  if (HAS_F16) {
    const f16 = new Float16(4)
    out.f16 = err(() => {
      const id = new AnyImageData(f16, 1, 1, { pixelFormat: 'rgba-float16' })
      return { same: id.data === f16, ...desc(id) }
    })
    out.f16asf32 = err(() => new AnyImageData(new Float16(4), 1, 1, { pixelFormat: 'rgba-float32' }))
    out.u8asf16 = err(() => new AnyImageData(new Uint8ClampedArray(4), 1, 1, { pixelFormat: 'rgba-float16' }))
  }
  out.f32asf16 = err(() => new AnyImageData(new Float32Array(4), 1, 1, { pixelFormat: 'rgba-float16' }))
  out.u8asf32 = err(() => new AnyImageData(new Uint8ClampedArray(4), 1, 1, { pixelFormat: 'rgba-float32' }))
  out.f32len5 = err(() => new AnyImageData(new Float32Array(5), 1, undefined, { pixelFormat: 'rgba-float32' }))
  out.f32len0 = err(() => new AnyImageData(new Float32Array(0), 1, undefined, { pixelFormat: 'rgba-float32' }))
  out.f32w3 = err(() => new AnyImageData(new Float32Array(8), 3, undefined, { pixelFormat: 'rgba-float32' }))
  out.f32h3 = err(() => new AnyImageData(new Float32Array(8), 1, 3, { pixelFormat: 'rgba-float32' }))
  out.f64 = err(() => new AnyImageData(new Float64Array(4), 1, 1, { pixelFormat: 'rgba-float32' }))
  chromeEqual(t, out, 'I2-ctor-data', { strip: [['f16'], ['f16asf32'], ['u8asf16']] })
})

test('createImageData takes pixelFormat and copies it from an ImageData', (t) => {
  const c = ctx(1, 1, { colorType: 'float16' })
  const p3 = new AnyImageData(1, 2, { pixelFormat: 'rgba-float32', colorSpace: 'display-p3' })
  const out: Record<string, unknown> = { def: err(() => c.createImageData(1, 1)) }
  if (HAS_F16) out.f16 = err(() => c.createImageData(1, 1, loose({ pixelFormat: 'rgba-float16' })))
  out.f32 = err(() => c.createImageData(1, 1, loose({ pixelFormat: 'rgba-float32' })))
  out.copy = err(() => c.createImageData(p3))
  out.bogus = err(() => c.createImageData(1, 1, loose({ pixelFormat: 'bogus' })))
  out.getBogus = err(() => c.getImageData(0, 0, 1, 1, loose({ pixelFormat: 'bogus' })))
  chromeEqual(t, out, 'I3-createImageData', { strip: [['f16']] })
})

test('ImageDataSettings reads colorSpace before pixelFormat', (t) => {
  const log: string[] = []
  const settings = {
    get colorSpace() {
      log.push('cs')
      return 'srgb'
    },
    get pixelFormat() {
      log.push('pf')
      return 'rgba-float32'
    },
  }
  const r = err(() => new AnyImageData(1, 1, settings))
  chromeEqual(t, { log, r }, 'I4-settings-order')
})

test('float ImageData sizes count bytes per element', (t) => {
  const out = {
    big: err(() => new AnyImageData(4096, 4096, { pixelFormat: 'rgba-float32' }).data.byteLength),
    getBig: err(() => ctx(2, 2).getImageData(0, 0, 2048, 2048, loose({ pixelFormat: 'rgba-float32' })).data.byteLength),
  }
  chromeEqual(t, out, 'I6-float-sizes')
})

test('float ImageData over 2 GiB is a RangeError', (t) => {
  // The byte size is checked before the Float16Array one, so these throw the
  // same RangeError on every runtime. f32_8192 (1 GiB) is pinned but not
  // allocated here.
  const out = {
    f32_16384x8192: err(() => new AnyImageData(16384, 8192, { pixelFormat: 'rgba-float32' }).data.byteLength),
    f16_16384x16384: err(() => new AnyImageData(16384, 16384, { pixelFormat: 'rgba-float16' }).data.byteLength),
    f32_23170: err(() => new AnyImageData(23170, 23170, { pixelFormat: 'rgba-float32' }).data.byteLength),
  }
  chromeEqual(t, out, 'I7-float-byte-limits', {
    pick: (pin) => Object.fromEntries(Object.entries(pin).filter(([k]) => k !== 'f32_8192')),
  })
})

test('float data is a prototype getter; unorm8 data is also a configurable own property', (t) => {
  const c = ctx(1, 1)
  const out: Record<string, unknown> = {}
  for (const pf of HAS_F16 ? ['rgba-unorm8', 'rgba-float16', 'rgba-float32'] : ['rgba-unorm8', 'rgba-float32']) {
    const id = c.getImageData(0, 0, 1, 1, loose({ pixelFormat: pf }))
    const own = Object.getOwnPropertyDescriptor(id, 'data')
    const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(id), 'data')
    out[pf] = {
      own: own ? { w: own.writable, e: own.enumerable, c: own.configurable } : null,
      proto: proto
        ? { get: typeof proto.get, set: typeof proto.set, e: proto.enumerable, c: proto.configurable }
        : null,
      same: id.data === id.data,
      keys: Object.keys(id),
      json: JSON.stringify(id).slice(0, 60),
    }
  }
  chromeEqual(t, out, 'G5-float-data-property', { strip: [['rgba-float16']] })
})

test('getImageData reads float pixels from a unorm8 canvas', (t) => {
  const g2 = ctx(1, 1)
  g2.fillStyle = 'rgb(32,128,223)'
  g2.fillRect(0, 0, 1, 1)
  const read = (c: any, settings: object) => err(() => c.getImageData(0, 0, 1, 1, settings))
  const G2: Record<string, unknown> = {}
  if (HAS_F16) G2.f16 = read(g2, { pixelFormat: 'rgba-float16' })
  G2.f32 = read(g2, { pixelFormat: 'rgba-float32' })
  G2.u8 = read(g2, { pixelFormat: 'rgba-unorm8' })
  chromeEqual(t, G2, 'G2-u8-canvas-float-reads', { strip: [['f16']] })

  const g3 = ctx(1, 1)
  g3.fillStyle = 'red'
  g3.fillRect(0, 0, 1, 1)
  const G3: Record<string, unknown> = {}
  if (HAS_F16) G3.f16 = read(g3, { pixelFormat: 'rgba-float16', colorSpace: 'display-p3' })
  G3.f32 = read(g3, { pixelFormat: 'rgba-float32', colorSpace: 'display-p3' })
  chromeEqual(t, G3, 'G3-u8-canvas-p3-float-read', { strip: [['f16']] })

  const x13 = ctx(4, 1)
  x13.fillStyle = 'rgba(1,2,3,0.004)'
  x13.fillRect(0, 0, 1, 1)
  x13.fillStyle = 'rgba(254,253,252,0.996)'
  x13.fillRect(1, 0, 1, 1)
  x13.fillStyle = 'rgba(77,155,233,0.5)'
  x13.fillRect(2, 0, 1, 1)
  x13.fillStyle = 'rgba(100,0,50,1)'
  x13.fillRect(3, 0, 1, 1)
  const X13: Record<string, unknown> = {}
  if (HAS_F16) X13.f16 = arr(x13.getImageData(0, 0, 4, 1, loose({ pixelFormat: 'rgba-float16' })).data)
  X13.f32 = arr(x13.getImageData(0, 0, 4, 1, loose({ pixelFormat: 'rgba-float32' })).data)
  X13.u8 = arr(x13.getImageData(0, 0, 4, 1).data)
  chromeEqual(t, X13, 'X13-getImageData-f16-precision-from-u8', { strip: [['f16']] })
})

test('putImageData converts float data to the canvas format first', (t) => {
  const d1 = ctx(1, 1)
  d1.putImageData(new AnyImageData(new Float32Array([0.5, 0.25, 1, 1]), 1, 1, { pixelFormat: 'rgba-float32' }), 0, 0)
  chromeEqual(t, all3(d1), 'D1-put-f32-on-u8')

  if (HAS_F16) {
    const d2 = ctx(1, 1)
    d2.putImageData(new AnyImageData(new Float16([0.5, 0.25, 1, 1]), 1, 1, { pixelFormat: 'rgba-float16' }), 0, 0)
    chromeEqual(t, all3(d2), 'D2-put-f16-on-u8')
  }

  const d8 = ctx(1, 1)
  d8.putImageData(
    new AnyImageData(new Float32Array([0.123, 0.456, 0.789, 0.3]), 1, 1, { pixelFormat: 'rgba-float32' }),
    0,
    0,
  )
  chromeEqual(t, all3(d8), 'D8-put-translucent-f32-on-u8')

  if (HAS_F16) {
    const d10 = ctx(4, 1)
    const vals = [0.1, 0.2, 0.3, 0.4, 0.00196, 0.5019, 0.998, 1, 0.0039, 0.0059, 0.502, 0.25, 1 / 3, 2 / 3, 0.7, 0.9]
    d10.putImageData(new AnyImageData(new Float16(vals), 4, 1, { pixelFormat: 'rgba-float16' }), 0, 0)
    chromeEqual(t, arr(d10.getImageData(0, 0, 4, 1).data), 'D10-put-f16-precision-on-u8')
  }

  const d5 = ctx(1, 1)
  d5.putImageData(
    new AnyImageData(new Float32Array([0.3, 0.6, 0.9, 1]), 1, 1, {
      pixelFormat: 'rgba-float32',
      colorSpace: 'display-p3',
    }),
    0,
    0,
  )
  chromeEqual(t, all3(d5), 'D5-put-p3-f32-on-srgb-u8', { pick: (pin) => pin.u8 })

  const d4 = ctx(4, 1)
  const data = new Float32Array([2, -1, 0.5, 1, 0.5, 0.5, 0.5, 2, NaN, 0.5, Infinity, 1, 0.25, 0.5, 0.75, -0.5])
  d4.putImageData(new AnyImageData(data, 4, 1, { pixelFormat: 'rgba-float32' }), 0, 0)
  chromeEqual(
    t,
    {
      u8: arr(d4.getImageData(0, 0, 4, 1).data),
      f32: arr(d4.getImageData(0, 0, 4, 1, loose({ pixelFormat: 'rgba-float32' })).data),
    },
    'D4-put-out-of-range',
    { pick: (pin) => pin.u8 },
  )
})

test('putImageData of float data with a dirty rect on unorm8 canvases', (t) => {
  const vals: number[] = []
  for (let i = 0; i < 4 * 3 * 2; i++) vals.push(((i * 37) % 101) / 100)
  const out: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ u8: {}, u8p3: { colorSpace: 'display-p3' } })) {
    for (const [dk, args] of Object.entries({
      neg: [1, 0, -1, -2, -2, -1],
      negx: [0, 0, -1, 0, -2, 2],
      out: [2, 1, 0, 0, 3, 2],
      big: [-1, -1, -5, -5, 100, 100],
    })) {
      const c = ctx(3, 2, o)
      c.fillStyle = 'rgb(10,20,30)'
      c.fillRect(0, 0, 3, 2)
      const [dx, dy, x, y, w, h] = args
      c.putImageData(
        new AnyImageData(new Float32Array(vals), 3, 2, { pixelFormat: 'rgba-float32' }),
        dx,
        dy,
        x,
        y,
        w,
        h,
      )
      out[k + '-' + dk] = arr(c.getImageData(0, 0, 3, 2, loose({ pixelFormat: 'rgba-float32' })).data)
    }
  }
  chromeEqual(t, out, 'D11-put-float-dirty-variants', {
    pick: (pin) => Object.fromEntries(Object.entries(pin).filter(([k]) => !k.startsWith('f16-'))),
  })
})

// A float putImageData writes the canvas pixels directly, past the
// recording: what it writes reaches the readers that use the recording too.
test('drawImage and createPattern of a canvas show a float putImageData', (t) => {
  const src = ctx(2, 1)
  src.fillStyle = 'rgb(10,20,30)'
  src.fillRect(0, 0, 2, 1)
  // Read the canvas once before the put, so a stale copy would show.
  ctx(2, 1).drawImage(src.canvas, 0, 0)
  src.putImageData(new AnyImageData(new Float32Array([0.5, 0.25, 1, 1]), 1, 1, { pixelFormat: 'rgba-float32' }), 1, 0)
  chromeEqual(t, { u8: px(src, 1, 0) }, 'D1-put-f32-on-u8', { pick: (pin) => ({ u8: pin.u8 }) })
  const want = arr(src.getImageData(0, 0, 2, 1).data)
  t.deepEqual(want.slice(0, 4), [10, 20, 30, 255])
  const drawn = ctx(2, 1)
  drawn.drawImage(src.canvas, 0, 0)
  t.deepEqual(arr(drawn.getImageData(0, 0, 2, 1).data), want)
  const patterned = ctx(2, 1)
  patterned.fillStyle = patterned.createPattern(src.canvas, 'no-repeat')!
  patterned.fillRect(0, 0, 2, 1)
  t.deepEqual(arr(patterned.getImageData(0, 0, 2, 1).data), want)
})

// No Chrome counterpart: an SVGCanvas takes float data as rgba-unorm8 data.
// (With the dirty rect: without it an SVGCanvas draws no ImageData at all.)
test('putImageData of float data on an SVGCanvas', (t) => {
  const svg = createCanvas(1, 1, SvgExportFlag.NoPrettyXML).getContext('2d')
  const data = new AnyImageData(new Float32Array([0.5, 0.25, 1, 1]), 1, 1, { pixelFormat: 'rgba-float32' })
  svg.putImageData(data, 0, 0, 0, 0, 1, 1)
  chromeEqual(t, { u8: px(svg, 0, 0) }, 'D1-put-f32-on-u8', { pick: (pin) => ({ u8: pin.u8 }) })
})

// No Chrome counterpart: SVG and PDF draw float data as the same data in
// rgba-unorm8, also for a dirty rect that goes past the data.
test('putImageData of float data on SVG and PDF draws what the same unorm8 data draws', (t) => {
  const u8 = new ImageData(
    new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 51]),
    2,
    2,
  )
  const f32 = new AnyImageData(new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 0.2]), 2, 2, {
    pixelFormat: 'rgba-float32',
  })
  const draw = (data: ImageData) => {
    const svgCanvas = createCanvas(2, 2, SvgExportFlag.NoPrettyXML)
    const svg = svgCanvas.getContext('2d')
    const pdf = new PDFDocument({ creationDate: new Date(0), modDate: new Date(0) })
    const page = pdf.beginPage(2, 2)
    for (const ctx of [svg, page]) {
      ctx.putImageData(data, 0, 0, 0, 0, 1, 1)
      ctx.putImageData(data, 0, 0, 1, 1, 5, 5)
    }
    pdf.endPage()
    const pixels = arr(svg.getImageData(0, 0, 2, 2).data)
    // The clip path ids count every SVG document made in the process.
    const text = svgCanvas.getContent().toString()
    return { pixels, svg: text.replace(/cl_\d+/g, 'cl'), pdf: pdf.close() }
  }
  const want = draw(u8)
  const got = draw(f32)
  t.deepEqual(want.pixels, [255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 51])
  t.deepEqual(got.pixels, want.pixels)
  t.is(got.svg, want.svg)
  t.true(got.pdf.equals(want.pdf))
})

// No Chrome counterpart: SVG and PDF convert float data only for a draw that
// shows some of it. A dirty rect that is empty or misses the data draws
// nothing, and without a dirty rect these backends draw no ImageData at all.
// Each of these calls used to convert the whole 4096x4096 rgba-float32 data,
// which added 64 MiB to the peak memory.
test('putImageData of float data that draws nothing on SVG and PDF converts nothing', (t) => {
  const script = `
    const { createCanvas, ImageData, PDFDocument, SvgExportFlag } = require(${JSON.stringify(fileURLToPath(new URL('../index.js', import.meta.url)))})
    const id = new ImageData(4096, 4096, { pixelFormat: 'rgba-float32' })
    id.data.fill(0.5)
    const svg = createCanvas(16, 16, SvgExportFlag.NoPrettyXML).getContext('2d')
    const pdf = new PDFDocument()
    const page = pdf.beginPage(16, 16)
    const rects = { empty: [0, 0, 0, 0], negative: [0, 0, -1, 4], outside: [4096, 0, 8, 8], below: [0, 4096, 8, 8], none: [] }
    const growthMiB = {}
    for (const [name, ctx] of [['svg', svg], ['pdf', page]]) {
      for (const [rect, dirty] of Object.entries(rects)) {
        const before = process.resourceUsage().maxRSS
        ctx.putImageData(id, 0, 0, ...dirty)
        growthMiB[name + '-' + rect] = Math.round((process.resourceUsage().maxRSS - before) / 1024)
      }
    }
    console.log(JSON.stringify(growthMiB))
  `
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  t.is(child.status, 0, child.stderr)
  const growthMiB: Record<string, number> = JSON.parse(child.stdout)
  const total = Object.values(growthMiB).reduce((a, b) => a + b, 0)
  t.true(total < 16, `peak memory grew by ${JSON.stringify(growthMiB)} MiB`)
})

test('putImageData of a detached float ImageData throws InvalidStateError', (t) => {
  const c = ctx(1, 1)
  const a = new Float32Array(4)
  const id = new AnyImageData(a, 1, 1, { pixelFormat: 'rgba-float32' })
  ;(a.buffer as any).transfer()
  chromeEqual(
    t,
    err(() => c.putImageData(id, 0, 0)),
    'D9-put-detached-float',
  )
})

test('createPattern(rgba-float16 ImageData) samples like createImageBitmap(imageData)', (t) => {
  const vals = [0.123, 0.456, 0.789, 0.3, 2, -1, 0.5, 1, 0.25, 0.5, 0.75, 1, 0.1, 0.2, 0.3, 0.004]
  if (HAS_F16) {
    const id = new AnyImageData(new Float16(vals), 2, 2, { pixelFormat: 'rgba-float16' })
    const c = ctx(2, 2)
    c.fillStyle = c.createPattern(id, 'repeat')!
    c.fillRect(0, 0, 2, 2)
    chromeEqual(
      t,
      arr(c.getImageData(0, 0, 2, 2, loose({ pixelFormat: 'rgba-float32' })).data),
      'Z1-pattern-float16-imagedata',
      {
        pick: (pin) => pin['f16>u8'],
      },
    )
  }
  // rgba-float32: no Chrome reference (createImageBitmap of it crashes the
  // Chrome 155 renderer). Pixels 1 and 2 hold values that float16 keeps
  // exactly, so they paint as the float16 pattern does.
  const f32 = new AnyImageData(new Float32Array(vals), 2, 2, { pixelFormat: 'rgba-float32' })
  const c = ctx(2, 2)
  const pattern = c.createPattern(f32, 'repeat')
  t.is(Object.prototype.toString.call(pattern), '[object CanvasPattern]')
  c.fillStyle = pattern!
  c.fillRect(0, 0, 2, 2)
  chromeEqual(
    t,
    arr(c.getImageData(0, 0, 2, 2, loose({ pixelFormat: 'rgba-float32' })).data).slice(4, 12),
    'Z1-pattern-float16-imagedata',
    {
      pick: (pin) => pin['f16>u8'].slice(4, 12),
    },
  )
})

test('rgba-float16 without Float16Array is a NotSupportedError', (t) => {
  if (HAS_F16) {
    t.pass('this runtime has Float16Array')
    return
  }
  const c = createCanvas(1, 1).getContext('2d')
  const error = (prefix: string) => ({
    name: 'NotSupportedError',
    message: `${prefix}Float16Array is not supported by this JavaScript runtime.`,
  })
  t.throws(() => new AnyImageData(1, 1, { pixelFormat: 'rgba-float16' }), error("Failed to construct 'ImageData': "))
  t.throws(
    () => c.createImageData(1, 1, loose({ pixelFormat: 'rgba-float16' })),
    error("Failed to execute 'createImageData' on 'CanvasRenderingContext2D': "),
  )
  t.throws(
    () => c.getImageData(0, 0, 1, 1, loose({ pixelFormat: 'rgba-float16' })),
    error("Failed to execute 'getImageData' on 'CanvasRenderingContext2D': "),
  )
})

// No Chrome counterpart: Blink makes the array itself. Here the global
// Float16Array makes it, so a replaced one can hand back any object; the
// pixels are only read from a Float16Array.
test('rgba-float16 data from a replaced Float16Array is not read', (t) => {
  const script = `
    globalThis.Float16Array = function () { return new Uint8Array(64 * 64 * 4) }
    const { createCanvas, ImageData } = require(${JSON.stringify(fileURLToPath(new URL('../index.js', import.meta.url)))})
    const id = new ImageData(64, 64, { pixelFormat: 'rgba-float16' })
    const out = []
    for (const opts of [{}, { colorType: 'float16' }]) {
      const c = createCanvas(64, 64).getContext('2d', opts)
      for (const run of [() => c.putImageData(id, 0, 0), () => c.createPattern(id, 'repeat')]) {
        try { run(); out.push('ok') } catch (e) { out.push(e.message) }
      }
    }
    console.log(JSON.stringify(out))
  `
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  t.is(child.status, 0, child.stderr)
  t.deepEqual(JSON.parse(child.stdout), Array(4).fill('ImageData data is not a Float16Array'))
})
