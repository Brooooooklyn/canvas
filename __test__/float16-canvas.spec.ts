// getContext('2d', { colorType: 'float16' }) stores half floats, as in Chrome.
// Values: Chrome 155 (fixtures/float16/chrome-pins.json, see float16-helpers.ts).
import test from 'ava'

import { createCanvas, ImageData, SvgExportFlag, type SKRSContext2D } from '../index'

import { F16, Float16, HAS_F16, all3, arr, canvas, chromeEqual, ctx, err, fills, px } from './float16-helpers'

const AnyImageData = ImageData as any
const loose = (value: unknown) => value as any
const F16P3 = { colorType: 'float16', colorSpace: 'display-p3' }

test('colorType float16 is reported and kept across resize, reset and a second getContext', (t) => {
  const A1: Record<string, string> = {}
  for (const [k, o] of Object.entries({
    def: {},
    f16: { colorType: 'float16' },
    u8: { colorType: 'unorm8' },
    f16p3: { colorType: 'float16', colorSpace: 'display-p3', alpha: false },
  })) {
    A1[k] = ctx(1, 1, o).getContextAttributes().colorType
  }
  chromeEqual(t, A1, 'A1-attrs')
  chromeEqual(
    t,
    err(() => {
      ctx(1, 1, { colorType: 'float32' })
      return 'ok'
    }),
    'A2-bogus-colorType',
  )

  const c17 = canvas(4, 4)
  const p17 = c17.getContext('2d', loose({ willReadFrequently: true, colorType: 'float16' }))
  c17.width = 1
  c17.height = 1
  fills(p17)
  const afterResize = px(p17, 0, 0)
  p17.reset()
  fills(p17)
  chromeEqual(
    t,
    { afterResize, afterReset: px(p17, 0, 0), attrs: p17.getContextAttributes().colorType },
    'P17-resize-keeps-f16',
  )

  const c14 = canvas(1, 1)
  const x14 = c14.getContext('2d', loose({ colorType: 'float16', willReadFrequently: true }))
  x14.fillStyle = 'red'
  x14.fillRect(0, 0, 1, 1)
  x14.clearRect(0, 0, 1, 1)
  const cleared = px(x14, 0, 0, 'rgba-float32')
  c14.width = 1
  chromeEqual(t, { cleared, afterResize: px(x14, 0, 0, 'rgba-float32') }, 'X14-reset-and-clear-f16')

  const c15 = canvas(1, 1)
  const a = c15.getContext('2d', loose({ colorType: 'float16' }))
  const b = c15.getContext('2d', loose({ colorType: 'unorm8' }))
  fills(b)
  chromeEqual(
    t,
    { same: a === b, attrs: b.getContextAttributes().colorType, px: arr(b.getImageData(0, 0, 1, 1).data) },
    'X15-second-getContext-other-type',
  )
})

test('float16 keeps what unorm8 rounds away', (t) => {
  const p1 = (opts: object) => {
    const c = ctx(1, 1, opts)
    c.fillStyle = 'rgba(255,255,255,0.01)'
    for (let i = 0; i < 100; i++) c.fillRect(0, 0, 1, 1)
    const transparent = all3(c)
    c.clearRect(0, 0, 1, 1)
    c.fillStyle = 'rgb(0,0,0)'
    c.fillRect(0, 0, 1, 1)
    c.fillStyle = 'rgba(255,255,255,0.01)'
    for (let i = 0; i < 100; i++) c.fillRect(0, 0, 1, 1)
    return { transparent, black: all3(c) }
  }
  chromeEqual(t, { unorm8: p1({}), float16: p1(F16) }, 'P1-100-fills')

  const p2 = (opts: object) => {
    const c = ctx(1, 1, opts)
    c.fillStyle = 'rgba(10,200,77,0.3)'
    c.fillRect(0, 0, 1, 1)
    c.fillStyle = 'rgba(250,3,140,0.37)'
    c.fillRect(0, 0, 1, 1)
    return all3(c)
  }
  chromeEqual(t, { unorm8: p2({}), float16: p2(F16) }, 'P2-two-fills')

  const p3 = ctx(1, 1, F16)
  p3.fillStyle = 'rgba(255,0,0,0.01)'
  p3.fillRect(0, 0, 1, 1)
  chromeEqual(t, all3(p3), 'P3-one-low-alpha-color')

  const p4 = ctx(1, 1, F16)
  p4.globalAlpha = 0.01
  p4.fillStyle = 'white'
  p4.fillRect(0, 0, 1, 1)
  chromeEqual(t, all3(p4), 'P4-globalAlpha-0.01')

  const p5 = ctx(1, 1, F16)
  p5.fillStyle = 'rgb(32,128,223)'
  p5.fillRect(0, 0, 1, 1)
  chromeEqual(t, all3(p5), 'P5-opaque-rgb')

  const P6: Record<string, unknown> = {}
  const P7: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ u8: {}, f16: F16 })) {
    const c6 = ctx(1, 1, o)
    c6.fillStyle = 'rgba(200,100,50,0.3)'
    c6.fillRect(0, 0, 1, 1)
    P6[k] = all3(c6)
    const c7 = ctx(1, 1, o)
    c7.fillStyle = 'rgba(200,150,100,0.75)'
    c7.fillRect(0, 0, 1, 1)
    c7.globalCompositeOperation = 'lighter'
    c7.fillRect(0, 0, 1, 1)
    P7[k] = all3(c7)
  }
  chromeEqual(t, P6, 'P6-translucent-u8-vs-f16')
  chromeEqual(t, P7, 'P7-lighter-overflow')

  const P10: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ u8: {}, f16: F16 })) {
    const c = ctx(256, 1, o)
    const g = c.createLinearGradient(0, 0, 256, 0)
    g.addColorStop(0, 'rgb(0,0,0)')
    g.addColorStop(1, 'rgb(255,128,64)')
    c.fillStyle = g
    c.fillRect(0, 0, 256, 1)
    const u8 = c.getImageData(0, 0, 256, 1).data
    const f32 = c.getImageData(0, 0, 256, 1, loose({ pixelFormat: 'rgba-float32' })).data
    const xs = [0, 1, 7, 63, 100, 128, 200, 255]
    P10[k] = {
      u8: xs.map((x) => arr(u8.slice(x * 4, x * 4 + 4))),
      f32: xs.map((x) => arr(f32.slice(x * 4, x * 4 + 4))),
    }
  }
  chromeEqual(t, P10, 'P10-gradient')

  const P16src = canvas(1, 1)
  const s16 = P16src.getContext('2d', F16)
  s16.fillStyle = 'rgba(255,128,0,0.6)'
  s16.fillRect(0, 0, 1, 1)
  const d16 = ctx(1, 1, F16)
  d16.globalAlpha = 0.5
  d16.drawImage(P16src, 0, 0)
  chromeEqual(t, { src: all3(s16), dst: all3(d16) }, 'P16-f16-to-f16-chain')

  const p19 = ctx(1, 1, F16P3)
  p19.fillStyle = 'rgb(255,0,0)'
  p19.fillRect(0, 0, 1, 1)
  const srgb = (pf: string) => arr(p19.getImageData(0, 0, 1, 1, loose({ colorSpace: 'srgb', pixelFormat: pf })).data)
  chromeEqual(
    t,
    { ...all3(p19), srgbU8: srgb('rgba-unorm8'), srgbF32: srgb('rgba-float32') },
    'P19-p3-f16-canvas-read',
    {
      strip: [['f16']],
    },
  )

  const P20: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ u8: {}, f16: F16 })) {
    const c = ctx(40, 20, o)
    c.fillStyle = 'black'
    c.fillRect(2, 2, 30, 1)
    c.beginPath()
    c.arc(20, 12, 6.3, 0, Math.PI * 2)
    c.fill()
    const d = c.getImageData(0, 0, 40, 20).data
    let s = 0
    for (let i = 3; i < d.length; i += 4) s += d[i]
    const f = c.getImageData(0, 0, 40, 20, loose({ pixelFormat: 'rgba-float32' })).data
    let sf = 0
    for (let i = 3; i < f.length; i += 4) sf += f[i]
    P20[k] = { alphaSum: s, alphaSumF: sf, edge: px(c, 26, 12), edgeF: px(c, 26, 12, 'rgba-float32') }
  }
  chromeEqual(t, P20, 'P20-text-coverage-sum')

  const g6 = ctx(1, 1, F16)
  g6.fillStyle = 'rgba(123,45,67,0.02)'
  g6.fillRect(0, 0, 1, 1)
  chromeEqual(t, all3(g6), 'G6-premul-roundtrip-f16')

  const x4 = ctx(1, 1, { colorSpace: 'display-p3' })
  fills(x4)
  chromeEqual(t, all3(x4), 'X4-u8p3-100-fills')
  const x5 = ctx(1, 1, F16P3)
  fills(x5)
  chromeEqual(t, all3(x5), 'X5-f16p3-100-fills')
})

test('composite operations on float16', (t) => {
  const out: Record<string, unknown> = {}
  for (const op of ['copy', 'multiply', 'screen', 'destination-out', 'xor', 'hue', 'difference']) {
    for (const [k, o] of Object.entries({ u8: {}, f16: F16 })) {
      const c = ctx(1, 1, o)
      c.fillStyle = 'rgba(40,120,200,0.6)'
      c.fillRect(0, 0, 1, 1)
      c.globalCompositeOperation = op as any
      c.fillStyle = 'rgba(220,60,10,0.45)'
      c.fillRect(0, 0, 1, 1)
      out[op + '-' + k] = px(c, 0, 0, 'rgba-float32')
    }
  }
  chromeEqual(t, out, 'X6-composite-ops-f16')
})

test('strokes, clips, shadows and filters on float16', (t) => {
  const P11: Record<string, unknown> = {}
  const P12: Record<string, unknown> = {}
  const X10: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ u8: {}, f16: F16 })) {
    const c11 = ctx(20, 20, o)
    c11.shadowBlur = 4
    c11.shadowColor = 'rgba(0,0,0,0.5)'
    c11.shadowOffsetX = 3
    c11.fillStyle = 'rgb(255,0,0)'
    c11.fillRect(5, 5, 8, 8)
    P11[k] = {
      u8: [px(c11, 14, 9), px(c11, 16, 9), px(c11, 9, 3)],
      f32: [px(c11, 14, 9, 'rgba-float32'), px(c11, 16, 9, 'rgba-float32'), px(c11, 9, 3, 'rgba-float32')],
    }
    const c12 = ctx(20, 20, o)
    c12.filter = 'blur(2px)'
    c12.fillStyle = 'rgb(0,0,255)'
    c12.fillRect(5, 5, 8, 8)
    P12[k] = {
      u8: [px(c12, 4, 9), px(c12, 13, 9), px(c12, 9, 9)],
      f32: [px(c12, 4, 9, 'rgba-float32'), px(c12, 13, 9, 'rgba-float32'), px(c12, 9, 9, 'rgba-float32')],
    }
    const c10 = ctx(10, 10, o)
    c10.lineWidth = 1.3
    c10.strokeStyle = 'rgb(10,100,200)'
    c10.beginPath()
    c10.moveTo(1.2, 1.7)
    c10.lineTo(8.6, 7.1)
    c10.stroke()
    X10[k] = { a: px(c10, 4, 4, 'rgba-float32'), b: px(c10, 5, 4, 'rgba-float32'), c: px(c10, 4, 3, 'rgba-float32') }
  }
  chromeEqual(t, P11, 'P11-shadow')
  chromeEqual(t, P12, 'P12-filter-blur')
  chromeEqual(t, X10, 'X10-clip-aa-and-stroke')

  const probe = (c: SKRSContext2D) => ({
    img: px(c, 2, 2, 'rgba-float32'),
    shadow: px(c, 7, 2, 'rgba-float32'),
    edge: px(c, 10, 2, 'rgba-float32'),
  })
  const shadow = (c: SKRSContext2D) => {
    c.shadowColor = 'rgba(255,0,0,0.7)'
    c.shadowOffsetX = 5
    c.shadowBlur = 2
  }
  const square = (o: object) => {
    const c = canvas(4, 4)
    const s = c.getContext('2d', loose(o))
    s.fillStyle = 'rgba(0,128,255,0.5)'
    s.fillRect(0, 0, 4, 4)
    return c
  }

  const x8src = square(F16)
  const X8: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ u8: {}, f16: F16 })) {
    const c = ctx(12, 12, o)
    shadow(c)
    c.drawImage(x8src, 1, 1)
    X8[k] = probe(c)
  }
  chromeEqual(t, X8, 'X8-shadow-from-f16-image')

  const Y1: Record<string, unknown> = {}
  const srcs = { f16: square(F16), u8: square({}) }
  for (const [sk, src] of Object.entries(srcs)) {
    for (const [vk, setup] of Object.entries({
      none: () => {},
      blur0: (c: SKRSContext2D) => {
        c.shadowColor = 'rgba(255,0,0,0.7)'
        c.shadowOffsetX = 5
      },
      blur2: shadow,
      filter: (c: SKRSContext2D) => {
        c.filter = 'blur(1px)'
      },
      alpha: (c: SKRSContext2D) => {
        c.globalAlpha = 0.5
      },
      multiply: (c: SKRSContext2D) => {
        c.globalCompositeOperation = 'multiply'
      },
    })) {
      const c = ctx(12, 12, F16)
      setup(c)
      c.drawImage(src, 1, 1)
      Y1[sk + '-' + vk] = probe(c)
    }
  }
  chromeEqual(t, Y1, 'Y1-image-shadow-variants')

  const y2 = ctx(12, 12, F16)
  shadow(y2)
  y2.fillStyle = 'rgba(0,128,255,0.5)'
  y2.fillRect(1, 1, 4, 4)
  chromeEqual(t, probe(y2), 'Y2-fill-shadow-f16')

  const y3 = ctx(12, 12, F16)
  shadow(y3)
  y3.fillStyle = y3.createPattern(square(F16), 'no-repeat')!
  y3.translate(1, 1)
  y3.fillRect(0, 0, 4, 4)
  chromeEqual(t, probe(y3), 'Y3-pattern-shadow-f16')

  const Y3b: Record<string, unknown> = {}
  const Y4: Record<string, unknown> = {}
  const Y5: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ u8: {}, f16: F16 })) {
    for (const rep of ['no-repeat', 'repeat']) {
      const c = ctx(12, 12, o)
      shadow(c)
      c.fillStyle = c.createPattern(square(o), rep)!
      c.fillRect(1, 1, 4, 4)
      Y3b[k + '-' + rep] = probe(c)
    }
    const c4 = ctx(20, 12, o)
    shadow(c4)
    c4.strokeStyle = 'rgba(0,128,255,0.5)'
    c4.lineWidth = 2
    c4.strokeRect(2, 2, 4, 4)
    Y4[k] = { s: px(c4, 2, 3, 'rgba-float32'), sh: px(c4, 7, 3, 'rgba-float32'), e: px(c4, 12, 4, 'rgba-float32') }
    for (const v of ['filter', 'multiply', 'copy']) {
      const c = ctx(12, 12, o)
      c.fillStyle = 'rgba(20,200,30,0.4)'
      c.fillRect(0, 0, 12, 12)
      shadow(c)
      if (v === 'filter') c.filter = 'opacity(0.8)'
      else c.globalCompositeOperation = v as any
      c.drawImage(square(o), 1, 1)
      Y5[k + '-' + v] = probe(c)
    }
  }
  chromeEqual(t, Y3b, 'Y3b-pattern-shadow')
  chromeEqual(t, Y4, 'Y4-text-and-stroke-shadow-f16')
  chromeEqual(t, Y5, 'Y5-image-shadow-with-filter-and-composite-f16')
})

test('drawImage and createPattern between unorm8 and float16 canvases', (t) => {
  const p13src = canvas(1, 1)
  const s13 = p13src.getContext('2d')
  s13.fillStyle = 'rgba(10,200,77,0.3)'
  s13.fillRect(0, 0, 1, 1)
  const d13 = ctx(1, 1, F16)
  d13.drawImage(p13src, 0, 0)
  chromeEqual(t, { src: all3(s13), dst: all3(d13) }, 'P13-drawImage-u8-onto-f16')

  const p14src = canvas(1, 1)
  const s14 = p14src.getContext('2d', F16)
  fills(s14)
  const u8 = ctx(1, 1, {})
  u8.drawImage(p14src, 0, 0)
  const f16 = ctx(1, 1, F16)
  f16.drawImage(p14src, 0, 0)
  const f16b = ctx(1, 1, F16)
  f16b.fillStyle = 'rgb(0,0,0)'
  f16b.fillRect(0, 0, 1, 1)
  f16b.drawImage(p14src, 0, 0)
  chromeEqual(
    t,
    { src: all3(s14), u8: all3(u8), f16: all3(f16), f16OnBlack: all3(f16b) },
    'P14-drawImage-f16-onto-u8-and-f16',
  )

  const P15: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ u8: {}, f16: F16 })) {
    const c = ctx(2, 2, o)
    c.fillStyle = c.createPattern(p14src, 'repeat')!
    c.fillRect(0, 0, 2, 2)
    P15[k] = all3(c, 1, 1)
  }
  chromeEqual(t, P15, 'P15-pattern-of-f16-canvas')

  const x2src = canvas(8, 8)
  const s2 = x2src.getContext('2d', F16)
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      s2.fillStyle = `rgba(${x * 30},${y * 30},128,${0.1 + 0.1 * ((x + y) % 9)})`
      s2.fillRect(x, y, 1, 1)
    }
  }
  const X2: Record<string, unknown> = {}
  for (const q of ['low', 'medium', 'high'] as const) {
    for (const [dk, dopts] of Object.entries({ u8: {}, f16: F16 })) {
      const c = ctx(4, 4, dopts)
      c.imageSmoothingQuality = q
      c.drawImage(x2src, 0, 0, 3, 3)
      X2[q + '-' + dk] = px(c, 1, 1, 'rgba-float32')
      const up = ctx(16, 16, dopts)
      up.imageSmoothingQuality = q
      up.drawImage(x2src, 0, 0, 16, 16)
      X2[q + '-up-' + dk] = px(up, 5, 7, 'rgba-float32')
    }
  }
  chromeEqual(t, X2, 'X2-f16src-scaled')

  const x12src = canvas(2, 2)
  const s12 = x12src.getContext('2d', F16)
  s12.fillStyle = 'rgba(255,0,0,0.3)'
  s12.fillRect(0, 0, 1, 1)
  s12.fillStyle = 'rgba(0,0,255,0.6)'
  s12.fillRect(1, 1, 1, 1)
  const X12: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ u8: {}, f16: F16 })) {
    const c = ctx(4, 4, o)
    const p = c.createPattern(x12src, 'repeat')!
    p.setTransform({ a: 1.5, b: 0, c: 0, d: 1.5, e: 0.25, f: 0 })
    c.fillStyle = p
    c.fillRect(0, 0, 4, 4)
    X12[k] = [px(c, 1, 1, 'rgba-float32'), px(c, 2, 2, 'rgba-float32')]
  }
  chromeEqual(t, X12, 'X12-createPattern-imagedata-like')
})

test('putImageData on float16 canvases', (t) => {
  const d3 = ctx(1, 1, F16)
  const D3: Record<string, unknown> = {}
  d3.putImageData(
    new AnyImageData(new Float32Array([0.123, 0.456, 0.789, 0.5]), 1, 1, { pixelFormat: 'rgba-float32' }),
    0,
    0,
  )
  D3.f32 = all3(d3)
  if (HAS_F16) {
    d3.putImageData(
      new AnyImageData(new Float16([0.123, 0.456, 0.789, 0.5]), 1, 1, { pixelFormat: 'rgba-float16' }),
      0,
      0,
    )
    D3.f16 = all3(d3)
  }
  d3.putImageData(new ImageData(new Uint8ClampedArray([255, 128, 0, 128]), 1, 1), 0, 0)
  D3.u8 = all3(d3)
  chromeEqual(t, D3, 'D3-put-float-on-f16', { strip: [['f16']] })

  const D4: Record<string, unknown> = {}
  const D5: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ u8: {}, f16: F16 })) {
    const c = ctx(4, 1, o)
    const data = new Float32Array([2, -1, 0.5, 1, 0.5, 0.5, 0.5, 2, NaN, 0.5, Infinity, 1, 0.25, 0.5, 0.75, -0.5])
    c.putImageData(new AnyImageData(data, 4, 1, { pixelFormat: 'rgba-float32' }), 0, 0)
    D4[k] = {
      u8: arr(c.getImageData(0, 0, 4, 1).data),
      f32: arr(c.getImageData(0, 0, 4, 1, loose({ pixelFormat: 'rgba-float32' })).data),
    }
    const c5 = ctx(1, 1, o)
    c5.putImageData(
      new AnyImageData(new Float32Array([0.3, 0.6, 0.9, 1]), 1, 1, {
        pixelFormat: 'rgba-float32',
        colorSpace: 'display-p3',
      }),
      0,
      0,
    )
    D5[k] = all3(c5)
  }
  chromeEqual(t, D4, 'D4-put-out-of-range')
  chromeEqual(t, D5, 'D5-put-p3-f32-on-srgb-u8')

  const d6 = ctx(3, 1, F16)
  const id6 = new AnyImageData(new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]), 3, 1, {
    pixelFormat: 'rgba-float32',
  })
  d6.putImageData(id6, 0, 0, 1, 0, 1, 1)
  chromeEqual(t, arr(d6.getImageData(0, 0, 3, 1, loose({ pixelFormat: 'rgba-float32' })).data), 'D6-put-dirty-float')

  const d7 = ctx(1, 1, { colorType: 'float16', alpha: false })
  d7.putImageData(new AnyImageData(new Float32Array([0.6, 0.4, 0.2, 0.5]), 1, 1, { pixelFormat: 'rgba-float32' }), 0, 0)
  chromeEqual(t, all3(d7), 'D7-put-alpha-false-f16')

  const i5 = new AnyImageData(1, 1, { pixelFormat: 'rgba-float32' })
  i5.data[0] = 0.75
  i5.data[1] = 2
  i5.data[3] = 1
  const c5 = ctx(1, 1, F16)
  c5.putImageData(i5, 0, 0)
  chromeEqual(t, all3(c5), 'I5-float-data-writes')

  const x7 = ctx(3, 1, F16)
  x7.putImageData(
    new AnyImageData(new Float32Array([70000, 1e-8, 65504, 1, -70000, 0.5, 6e-8, 1, 0.5, 0.5, 0.5, 1e-6]), 3, 1, {
      pixelFormat: 'rgba-float32',
    }),
    0,
    0,
  )
  chromeEqual(
    t,
    {
      f32: arr(x7.getImageData(0, 0, 3, 1, loose({ pixelFormat: 'rgba-float32' })).data),
      u8: arr(x7.getImageData(0, 0, 3, 1).data),
    },
    'X7-put-huge-and-tiny',
  )

  const x9 = ctx(1, 1, F16P3)
  x9.putImageData(
    new AnyImageData(new Float32Array([0.3, 0.6, 0.9, 0.7]), 1, 1, {
      pixelFormat: 'rgba-float32',
      colorSpace: 'display-p3',
    }),
    0,
    0,
  )
  chromeEqual(
    t,
    {
      p3: arr(x9.getImageData(0, 0, 1, 1, loose({ pixelFormat: 'rgba-float32' })).data),
      srgb: arr(x9.getImageData(0, 0, 1, 1, loose({ pixelFormat: 'rgba-float32', colorSpace: 'srgb' })).data),
      u8: px(x9, 0, 0),
    },
    'X9-p3-f32-roundtrip-on-p3-f16',
  )

  const vals: number[] = []
  for (let i = 0; i < 4 * 3 * 2; i++) vals.push(((i * 37) % 101) / 100)
  const D11: Record<string, unknown> = {}
  for (const [dk, args] of Object.entries({
    neg: [1, 0, -1, -2, -2, -1],
    negx: [0, 0, -1, 0, -2, 2],
    out: [2, 1, 0, 0, 3, 2],
    big: [-1, -1, -5, -5, 100, 100],
  })) {
    const c = ctx(3, 2, F16)
    c.fillStyle = 'rgb(10,20,30)'
    c.fillRect(0, 0, 3, 2)
    const [dx, dy, x, y, w, h] = args
    c.putImageData(new AnyImageData(new Float32Array(vals), 3, 2, { pixelFormat: 'rgba-float32' }), dx, dy, x, y, w, h)
    D11['f16-' + dk] = arr(c.getImageData(0, 0, 3, 2, loose({ pixelFormat: 'rgba-float32' })).data)
  }
  chromeEqual(t, D11, 'D11-put-float-dirty-variants', {
    pick: (pin) => Object.fromEntries(Object.entries(pin).filter(([k]) => k.startsWith('f16-'))),
  })
})

test('getImageData on float16 canvases', (t) => {
  chromeEqual(
    t,
    err(() => ctx(1, 1, F16).getImageData(0, 0, 1, 1)),
    'G1-default-pf-on-f16',
  )

  const g4 = ctx(2, 2, F16)
  g4.fillStyle = 'rgb(255,0,0)'
  g4.fillRect(0, 0, 2, 2)
  const G4: Record<string, unknown> = {
    f32: err(() => g4.getImageData(-1, 0, 2, 1, loose({ pixelFormat: 'rgba-float32' }))),
  }
  if (HAS_F16) G4.f16out = err(() => g4.getImageData(5, 5, 1, 1, loose({ pixelFormat: 'rgba-float16' })))
  chromeEqual(t, G4, 'G4-partly-outside-float', { strip: [['f16out']] })

  const g7 = ctx(3, 2, F16)
  g7.fillStyle = 'rgba(250,100,20,0.4)'
  g7.fillRect(0, 0, 3, 2)
  g7.translate(1, 1)
  g7.beginPath()
  g7.rect(0, 0, 1, 1)
  g7.clip()
  chromeEqual(
    t,
    {
      f32: arr(g7.getImageData(-1, -1, 3, 2, loose({ pixelFormat: 'rgba-float32' })).data),
      f16neg: arr(g7.getImageData(3, 2, -2, -1, loose({ pixelFormat: 'rgba-float32' })).data),
      p3: arr(g7.getImageData(0, 0, 1, 1, loose({ pixelFormat: 'rgba-float32', colorSpace: 'display-p3' })).data),
    },
    'G7-float-read-variants',
  )
})

test('alpha:false float16', (t) => {
  const c = ctx(1, 1, { colorType: 'float16', alpha: false })
  c.fillStyle = 'rgba(255,0,0,0.5)'
  c.fillRect(0, 0, 1, 1)
  const filled = all3(c)
  fills(c)
  // `base` (an untouched canvas) is left out: Chrome reads zeros before its
  // lazy allocation; this library paints the alpha:false base at creation.
  chromeEqual(t, { filled, many: all3(c) }, 'P18-alpha-false-f16')
})

test('extended-range colors keep their range on float16', (t) => {
  const P8: Record<string, unknown> = {}
  for (const color of [
    'color(srgb 1.5 0.5 -0.25)',
    'color(srgb 0.5 0.25 0.125 / 0.5)',
    'color(srgb-linear 0.5 0.5 0.5)',
  ]) {
    const c = ctx(1, 1, F16)
    c.fillStyle = color
    c.fillRect(0, 0, 1, 1)
    P8[color] = { style: c.fillStyle, ...all3(c) }
  }
  chromeEqual(t, P8, 'P8-extended-srgb-color', {
    strip: ['color(srgb 1.5 0.5 -0.25)', 'color(srgb 0.5 0.25 0.125 / 0.5)', 'color(srgb-linear 0.5 0.5 0.5)'].map(
      (k) => [k, 'f16'],
    ),
  })

  const P9: Record<string, unknown> = {}
  for (const [k, o] of Object.entries({ srgbF16: F16, p3F16: F16P3, srgbU8: {} })) {
    const c = ctx(1, 1, o)
    c.fillStyle = 'color(display-p3 1 0 0)'
    c.fillRect(0, 0, 1, 1)
    P9[k] = all3(c)
  }
  chromeEqual(t, P9, 'P9-p3-color-on-srgb-f16')
})

test('createPattern(rgba-float16 ImageData) on float16', (t) => {
  if (!HAS_F16) {
    t.pass('no Float16Array')
    return
  }
  const vals = [0.123, 0.456, 0.789, 0.3, 2, -1, 0.5, 1, 0.25, 0.5, 0.75, 1, 0.1, 0.2, 0.3, 0.004]
  const id = new AnyImageData(new Float16(vals), 2, 2, { pixelFormat: 'rgba-float16' })
  const c = ctx(2, 2, F16)
  c.fillStyle = c.createPattern(id, 'repeat')!
  c.fillRect(0, 0, 2, 2)
  chromeEqual(
    t,
    arr(c.getImageData(0, 0, 2, 2, loose({ pixelFormat: 'rgba-float32' })).data),
    'Z1-pattern-float16-imagedata',
    {
      pick: (pin) => pin['f16>f16'],
    },
  )
})

// No Chrome API: drawCanvas must draw what drawImage draws (P13, P14).
test('drawCanvas draws pixels across pixel formats', (t) => {
  const u8src = createCanvas(1, 1)
  const s13 = u8src.getContext('2d')
  s13.fillStyle = 'rgba(10,200,77,0.3)'
  s13.fillRect(0, 0, 1, 1)
  const d13 = ctx(1, 1, F16)
  d13.drawCanvas(u8src, 0, 0)
  chromeEqual(t, all3(d13), 'P13-drawImage-u8-onto-f16', { pick: (pin) => pin.dst })

  const f16src = createCanvas(1, 1)
  fills(f16src.getContext('2d', F16))
  const u8 = ctx(1, 1, {})
  u8.drawCanvas(f16src, 0, 0)
  const f16 = ctx(1, 1, F16)
  f16.drawCanvas(f16src, 0, 0)
  chromeEqual(t, { u8: all3(u8), f16: all3(f16) }, 'P14-drawImage-f16-onto-u8-and-f16', {
    pick: (pin) => ({ u8: pin.u8, f16: pin.f16 }),
  })
})

// No Chrome counterpart: an SVGCanvas reads like a Canvas of the same settings.
test('SVGCanvas getContext colorType float16 has a float16 raster', (t) => {
  const svg = createCanvas(1, 1, SvgExportFlag.NoPrettyXML)
  const c = svg.getContext('2d', loose({ colorType: 'float16' }))
  t.is(c.getContextAttributes().colorType, 'float16')
  c.fillStyle = 'rgba(255,255,255,0.01)'
  for (let i = 0; i < 100; i++) c.fillRect(0, 0, 1, 1)
  chromeEqual(t, px(c, 0, 0, 'rgba-float32'), 'P1-100-fills', { pick: (pin) => pin.float16.transparent.f32 })
})

// Chrome draws a canvas source on a canvas that is not sRGB from an N32 decode
// (SoftwareImageDecodeCache: F16 only for high-bit-depth images), also when the
// source is float16 and in the canvas's own color space.
test('float16 canvas sources on display-p3 canvases go through the 8-bit decode', (t) => {
  const filled = (o: object) => {
    const c = canvas(1, 1)
    fills(c.getContext('2d', loose(o)))
    return c
  }
  const X1: Record<string, unknown> = {}
  for (const [sk, so] of Object.entries({ f16: F16, f16p3: F16P3, u8p3: { colorSpace: 'display-p3' } })) {
    const src = filled(so)
    for (const [dk, dopts] of Object.entries({ u8: {}, f16: F16, f16p3: F16P3, u8p3: { colorSpace: 'display-p3' } })) {
      const c = ctx(1, 1, dopts)
      c.drawImage(src, 0, 0)
      X1[sk + '->' + dk] = px(c, 0, 0, 'rgba-float32')
    }
  }
  chromeEqual(t, X1, 'X1-f16src-to-dest-variants')

  const grid = (o: object) => {
    const c = canvas(8, 8)
    const s = c.getContext('2d', loose(o))
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        s.fillStyle = `rgba(${x * 30},${y * 30},128,${0.1 + 0.1 * ((x + y) % 9)})`
        s.fillRect(x, y, 1, 1)
      }
    }
    return c
  }
  const X16: Record<string, unknown> = {}
  for (const [sk, so] of Object.entries({ f16: F16, f16p3: F16P3 })) {
    const src = grid(so)
    for (const [dk, dopts] of Object.entries({ f16p3: F16P3, u8p3: { colorSpace: 'display-p3' } })) {
      for (const q of ['low', 'medium', 'high'] as const) {
        const c = ctx(4, 4, dopts)
        c.imageSmoothingQuality = q
        c.drawImage(src, 0, 0, 3, 3)
        X16[sk + '->' + dk + '-' + q] = px(c, 1, 1, 'rgba-float32')
      }
      const c = ctx(8, 8, dopts)
      c.drawImage(src, 0, 0)
      X16[sk + '->' + dk + '-1x'] = px(c, 3, 2, 'rgba-float32')
    }
  }
  chromeEqual(t, X16, 'X16-f16-canvas-source-scaled-on-p3')

  const x17src = canvas(2, 2)
  fills(x17src.getContext('2d', F16))
  const X17: Record<string, unknown> = {}
  for (const [dk, dopts] of Object.entries({ f16p3: F16P3, u8p3: { colorSpace: 'display-p3' } })) {
    const c = ctx(2, 2, dopts)
    c.fillStyle = c.createPattern(x17src, 'repeat')!
    c.fillRect(0, 0, 2, 2)
    X17[dk] = px(c, 1, 1, 'rgba-float32')
  }
  chromeEqual(t, X17, 'X17-f16-pattern-on-p3')

  const X18: Record<string, unknown> = {}
  for (const [sk, so] of Object.entries({ f16p3: F16P3, f16: F16 })) {
    const src = canvas(2, 2)
    fills(src.getContext('2d', loose(so)))
    for (const [dk, dopts] of Object.entries({ f16p3: F16P3, u8p3: { colorSpace: 'display-p3' }, f16: F16, u8: {} })) {
      const c = ctx(2, 2, dopts)
      c.fillStyle = c.createPattern(src, 'repeat')!
      c.fillRect(0, 0, 2, 2)
      X18[sk + '->' + dk] = px(c, 1, 1, 'rgba-float32')
      const sc = ctx(4, 4, dopts)
      const p = sc.createPattern(src, 'repeat')!
      p.setTransform({ a: 0.5, d: 0.5 })
      sc.imageSmoothingQuality = 'medium'
      sc.fillStyle = p
      sc.fillRect(0, 0, 4, 4)
      X18[sk + '->' + dk + '-half'] = px(sc, 1, 1, 'rgba-float32')
    }
  }
  chromeEqual(t, X18, 'X18-f16p3-pattern-on-p3')
})
