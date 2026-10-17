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

const WIN_ARM64 = process.platform === 'win32' && process.arch === 'arm64'
const LINUX_X64_MUSL =
  process.platform === 'linux' &&
  process.arch === 'x64' &&
  (process.report.getReport() as any).header.glibcVersionRuntime === undefined

/**
 * Two prebuilt Skia builds are not compiled like Chrome's Skia, and Chrome
 * never gives these values. Each entry is the value that build gave on CI,
 * written over the arm64 pin (`hw`), for that target only. Drop an entry when
 * its build is fixed.
 *
 * - win32-arm64: Skia's gn/skia/BUILD.gn adds -ffp-contract=off only `if
 *   (is_clang && !is_win)`, so clang-cl (default -ffp-contract=on) fuses a*b+c
 *   into fmadd. Chromium adds /clang:-ffp-contract=off on Windows too
 *   (build/config/compiler/BUILD.gn). The fused skcms code moves the small
 *   results of colour conversions by a few float16 steps. macOS arm64 gives
 *   exactly these values when SkOpts, SkColorSpace, SkColorSpaceXformSteps,
 *   SkRasterPipeline and skcms are rebuilt with -ffp-contract=on (skcms alone
 *   gives P19 and H1), and gives the Chrome values with Skia's own flags.
 * - linux-x64-musl on an AVX2 CPU: scripts/skia-gn-args.cjs adds
 *   -march=sandybridge to extra_cflags_cc. It comes after the -march=x86-64-v3
 *   of Skia's ml3 opts on the compile line, so SkOpts_ml3.cpp is built without
 *   AVX2, FMA and F16C, while skcms keeps its AVX2+F16C code (-mavx2 -mf16c
 *   stay on). Chrome runs both at the AVX2 level (`fma`) or both at the
 *   baseline (`sw`); this build runs a mix, which matches neither. The CI
 *   binding gives these values under qemu -cpu max, and the glibc binding gives
 *   the same values once BMI2 is hidden (Skia's ml3 check needs it, skcms's
 *   does not). On a CPU without AVX2 the musl build gives `sw`, as before.
 */
const BUILD_VALUES: Record<string, Record<string, unknown>> = WIN_ARM64
  ? {
      'P19-p3-f16-canvas-read': {
        srgbF32: [0.999847412109375, 0.0004047706024721265, 0.000187480662134476, 1],
      },
      'P9-p3-color-on-srgb-f16': {
        p3F16: {
          f16: [1, -0.000023424625396728516, -0.00004738569259643555, 1],
          f32: [1, -0.000023424625396728516, -0.00004738569259643555, 1],
        },
      },
      'H1-hbd-fixtures': {
        'hbd-8x8.png-f16p3': {
          f32: [
            -0.00001329183578491211, -0.000027835369110107422, 0.478759765625, 1, 0.11095718294382095,
            0.006124055478721857, 0.47884130477905273, 0.96923828125, 0.22620904445648193, 0.0217758696526289,
            0.4797191619873047, 0.93896484375, 0.34139785170555115, 0.04902553930878639, 0.48091399669647217,
            0.908203125,
          ],
        },
      },
    }
  : LINUX_X64_MUSL
    ? {
        'H1-hbd-fixtures': {
          'hbd-4x1.png-f16p3': {
            f32: [
              0.46728515625, 0.262939453125, 0.962890625, 1, 0.308349609375, 0.66064453125, 0.1893310546875, 0.5,
              0.9173177480697632, 0.2001953125, 0.4973958432674408, 0.75, 0.273681640625, 0.55419921875, 0.35400390625,
              1,
            ],
            u8: [119, 67, 246, 255, 79, 168, 48, 128, 234, 51, 127, 191, 70, 141, 90, 255],
          },
          'hbd-8x8.png-f16p3': {
            f32: [
              0, 0, 0.478515625, 1, 0.11089421063661575, 0.006120119709521532, 0.47884130477905273, 0.96923828125,
              0.2260790318250656, 0.0217758696526289, 0.47945916652679443, 0.93896484375, 0.34112903475761414,
              0.04902553930878639, 0.48091399669647217, 0.908203125,
            ],
          },
        },
        'H2-hbd-down-fresh': {
          'f16-down': [0.43220338225364685, 0.43739745020866394, 0.5921267867088318, 0.89306640625],
          'f16p3-down': [0.4414980709552765, 0.4390377104282379, 0.581191897392273, 0.89306640625],
          'f16-full-then-down': [0.43220338225364685, 0.43739745020866394, 0.5921267867088318, 0.89306640625],
          'f16p3-full-then-down': [0.4414980709552765, 0.4390377104282379, 0.581191897392273, 0.89306640625],
        },
      }
    : {}

/** `pin` with the members of `values` written over it; arrays are replaced. */
function overwrite(pin: unknown, values: Record<string, unknown>): unknown {
  const copy: any = structuredClone(pin)
  const write = (to: any, from: Record<string, any>) => {
    for (const [k, v] of Object.entries(from)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) write(to[k], v)
      else to[k] = v
    }
  }
  write(copy, values)
  return copy
}

/**
 * The Chrome values for this CPU. arm64: Chrome arm64. x64: Chrome x64 without
 * AVX (the macOS build under Rosetta, like our darwin-x64 CI) or with
 * AVX2+FMA+F16C (Linux and Windows x64), whichever the output matches. Then
 * the value of this build, where BUILD_VALUES has one.
 */
export function chromeFor(id: string): unknown[] {
  const pin = PINS[id]
  if (!pin) throw new Error(`no pin ${id}`)
  const chrome = process.arch === 'arm64' ? [pin.hw] : [pin.sw ?? pin.hw, pin.fma ?? pin.hw]
  const build = BUILD_VALUES[id]
  return build ? [...chrome, overwrite(pin.hw, build)] : chrome
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
