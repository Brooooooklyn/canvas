// Shared by the float16 / float ImageData specs. The pins are Chrome 155
// (--disable-gpu, willReadFrequently) values: fixtures/float16/chrome-pins.json.
// Each scenario here is the probe that measured them, with the same steps and
// keys.
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { inflateSync } from 'node:zlib'

import type { ExecutionContext } from 'ava'

import { createCanvas, type SKRSContext2D } from '../index'

/** Node 22 has no Float16Array: 'rgba-float16' throws there. */
export const HAS_F16 = typeof (globalThis as any).Float16Array === 'function'
export const Float16 = (globalThis as any).Float16Array as {
  new (values: number | ArrayLike<number>): any
}

type Pin = { hw: unknown; sw?: unknown; fma?: unknown }
const PINS: Record<string, Pin> = JSON.parse(
  readFileSync(new URL('./fixtures/float16/chrome-pins.json', import.meta.url), 'utf8'),
).scenarios

/**
 * The Chrome values for this CPU. arm64: Chrome arm64. x64: Chrome x64 without
 * AVX (the macOS build under Rosetta, like our darwin-x64 CI) or with
 * AVX2+FMA+F16C (Linux and Windows x64), whichever the output matches.
 */
export function chromeFor(id: string): unknown[] {
  const pin = PINS[id]
  if (!pin) throw new Error(`no pin ${id}`)
  return process.arch === 'arm64' ? [pin.hw] : [pin.sw ?? pin.hw, pin.fma ?? pin.hw]
}

/**
 * Without Float16Array, the rgba-float16 reads are not made: the `f16` key
 * of an all3() object, and the paths in `extra`.
 */
export function withoutF16(value: unknown, extra: string[][] = []): unknown {
  if (HAS_F16) return value
  const copy = structuredClone(value)
  const walk = (v: any) => {
    if (!v || typeof v !== 'object') return
    const keys = Object.keys(v)
    if (keys.length === 3 && keys[0] === 'u8' && keys[1] === 'f16' && keys[2] === 'f32') delete v.f16
    for (const k of Object.keys(v)) walk(v[k])
  }
  walk(copy)
  for (const path of extra) {
    let v: any = copy
    for (const k of path.slice(0, -1)) v = v?.[k]
    if (v) delete v[path[path.length - 1]]
  }
  return copy
}

/**
 * deepEqual against the first Chrome value for this CPU that matches.
 * `pick` compares a part of the pin; `strip` lists rgba-float16 reads that
 * are not made without Float16Array. The actual value goes through JSON, as
 * the probe's did (undefined members drop out).
 */
export function chromeEqual(
  t: ExecutionContext,
  actual: unknown,
  id: string,
  { pick = (pin: any) => pin, strip = [] }: { pick?: (pin: any) => unknown; strip?: string[][] } = {},
) {
  const json = JSON.parse(JSON.stringify(actual) ?? 'null')
  const candidates = chromeFor(id).map((pin) => withoutF16(pick(pin), strip))
  t.deepEqual(json, candidates.find((c) => isDeepStrictEqual(json, c)) ?? candidates[0], id)
}

// The probe helpers (scen.js `helpers`).
export const num = (v: number) =>
  Number.isNaN(v) ? 'NaN' : v === Infinity ? 'Inf' : v === -Infinity ? '-Inf' : Object.is(v, -0) ? '-0' : v
export const arr = (a: ArrayLike<number>) => Array.from(a, num)
export const tag = (x: unknown) => Object.prototype.toString.call(x)
export const desc = (id: any) =>
  id
    ? {
        w: id.width,
        h: id.height,
        cs: id.colorSpace,
        pf: id.pixelFormat,
        type: tag(id.data),
        len: id.data.length,
        d: arr(id.data.slice(0, 16)),
      }
    : id
export const err = (f: () => unknown) => {
  try {
    const r: any = f()
    return { ok: true, v: r && typeof r === 'object' && 'data' in r && 'width' in r ? desc(r) : r }
  } catch (e: any) {
    return { threw: true, ctor: e?.constructor?.name, name: e?.name, message: e?.message, code: e?.code }
  }
}
export type PixelFormat = 'rgba-unorm8' | 'rgba-float16' | 'rgba-float32'
export const px = (ctx: SKRSContext2D, x: number, y: number, pf?: PixelFormat) =>
  arr(ctx.getImageData(x, y, 1, 1, pf ? { pixelFormat: pf } : undefined).data)
export const all3 = (ctx: SKRSContext2D, x = 0, y = 0) =>
  HAS_F16
    ? { u8: px(ctx, x, y), f16: px(ctx, x, y, 'rgba-float16'), f32: px(ctx, x, y, 'rgba-float32') }
    : { u8: px(ctx, x, y), f32: px(ctx, x, y, 'rgba-float32') }
export const F16 = { colorType: 'float16' } as const

export const canvas = (w: number, h: number) => createCanvas(w, h)
export const ctx = (w: number, h: number, opts: Record<string, unknown> = {}) =>
  createCanvas(w, h).getContext('2d', { willReadFrequently: true, ...opts } as any)

/** 100 fills of rgba(255,255,255,0.01) over the whole canvas. */
export const fills = (c: SKRSContext2D, n = 100) => {
  c.fillStyle = 'rgba(255,255,255,0.01)'
  for (let i = 0; i < n; i++) c.fillRect(0, 0, c.canvas.width, c.canvas.height)
}

/** The samples of an RGBA PNG (8 or 16 bit, no interlace). */
export function pngSamples(png: Uint8Array) {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  let p = 8
  let ihdr = { w: 0, h: 0, depth: 0, ct: 0 }
  const idat: Buffer[] = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], ct: data[9] }
    if (type === 'IDAT') idat.push(data)
    p += 12 + len
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[ihdr.ct]
  const bpp = (channels * ihdr.depth) / 8
  const stride = ihdr.w * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(ihdr.h * stride)
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[y * stride + x] = v & 0xff
    }
  }
  const samples: number[] = []
  for (let i = 0; i < out.length; i += ihdr.depth / 8) samples.push(ihdr.depth === 16 ? out.readUInt16BE(i) : out[i])
  return { depth: ihdr.depth, w: ihdr.w, h: ihdr.h, samples }
}
