// new ImageData(data, sw, sh?) keeps the given Uint8ClampedArray as its data
// (image_data.cc ValidateAndCreate), and rejects shared and resizable buffers
// (no [AllowShared] in image_data.idl). Expected values were measured in
// Chrome 155 (--disable-gpu, arm64 = x64).
import { createRequire } from 'node:module'

import test from 'ava'

import { createCanvas, ImageData } from '../index'

const CONSTRUCT = "Failed to construct 'ImageData': "
const PUT = "Failed to execute 'putImageData' on 'CanvasRenderingContext2D': "

// Untyped access for arguments the typings reject on purpose.
const loose = (value: unknown) => value as any
const LooseImageData = ImageData as any

const result = (fn: () => unknown) => {
  try {
    const value = fn()
    return { ok: value === undefined ? 'undefined' : value }
  } catch (e: any) {
    return { ctor: e?.constructor?.name, name: e?.name, code: e?.code, msg: String(e?.message) }
  }
}
const typeError = (msg: string) => ({ ctor: 'TypeError', name: 'TypeError', code: undefined, msg: CONSTRUCT + msg })
const invalidState = (prefix: string, msg: string) => ({
  ctor: 'DOMException',
  name: 'InvalidStateError',
  code: 11,
  msg: prefix + msg,
})
const read = (ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>, w: number, h: number) =>
  Array.from(ctx.getImageData(0, 0, w, h).data)

test('new ImageData(data, sw, sh) keeps the given Uint8ClampedArray', (t) => {
  const a = new Uint8ClampedArray(4)
  const id = new ImageData(a, 1, 1)
  t.is(id.data, a)
  t.is(id.data.buffer, a.buffer)
  // A later write to the array shows in putImageData.
  const ctx = createCanvas(1, 1).getContext('2d')
  const later = new Uint8ClampedArray(4)
  const laterData = new ImageData(later, 1)
  later.set([255, 0, 0, 255])
  ctx.putImageData(laterData, 0, 0)
  t.deepEqual(read(ctx, 1, 1), [255, 0, 0, 255])
  // A write through data shows in the array.
  const through = new Uint8ClampedArray(4)
  new ImageData(through, 1).data[0] = 7
  t.is(through[0], 7)
  // A subarray is used as it is, with its offset.
  const sub = new Uint8ClampedArray(12).subarray(4)
  const subData = new ImageData(sub, 2)
  t.deepEqual(
    [subData.data === sub, subData.width, subData.height, subData.data.byteOffset, subData.data.length],
    [true, 2, 1, 4, 8],
  )
  const base = new Uint8ClampedArray(12)
  base.set([0, 0, 255, 255], 4)
  base.set([0, 255, 0, 255], 8)
  const two = createCanvas(2, 1).getContext('2d')
  two.putImageData(new ImageData(base.subarray(4), 2), 0, 0)
  t.deepEqual(read(two, 2, 1), [0, 0, 255, 255, 0, 255, 0, 255])
  // Two ImageData over one array share it.
  const shared = new Uint8ClampedArray(4)
  t.is(new ImageData(shared, 1).data, new ImageData(shared, 1).data)
  const eight = new Uint8ClampedArray(8)
  const derived = new ImageData(eight, 2)
  t.deepEqual([derived.width, derived.height, derived.data === eight], [2, 1, true])
  // A subclass and an array from another realm are Uint8ClampedArrays too.
  class U extends Uint8ClampedArray {}
  const u = new U(4)
  t.is(new ImageData(u, 1).data, u)
  const OtherRealm = createRequire(import.meta.url)('node:vm').runInNewContext('Uint8ClampedArray')
  const other = new OtherRealm(4)
  t.is(new ImageData(other, 1).data, other)
  // The data own property holds the array: not writable, enumerable.
  const descriptor = Object.getOwnPropertyDescriptor(new ImageData(a, 1), 'data')!
  t.deepEqual([descriptor.value === a, descriptor.writable, descriptor.enumerable], [true, false, true])
})

test('putImageData reads the data array as it is when called', (t) => {
  const base = new Uint8ClampedArray(12)
  const id = new ImageData(base.subarray(4), 2)
  base.set([9, 9, 9, 9, 1, 2, 3, 255, 4, 5, 6, 255])
  const ctx = createCanvas(2, 1).getContext('2d')
  ctx.putImageData(id, 0, 0)
  t.deepEqual(
    [Array.from(id.data), read(ctx, 2, 1)],
    [
      [1, 2, 3, 255, 4, 5, 6, 255],
      [1, 2, 3, 255, 4, 5, 6, 255],
    ],
  )
  const a = new Uint8ClampedArray([255, 0, 0, 255])
  const red = new ImageData(a, 1, 1)
  const one = createCanvas(1, 1).getContext('2d')
  a.set([0, 0, 255, 255])
  one.putImageData(red, 0, 0)
  t.deepEqual(read(one, 1, 1), [0, 0, 255, 255])
})

test('new ImageData rejects shared and resizable buffers', (t) => {
  const SHARED = 'The provided Uint8ClampedArray value must not be shared.'
  const RESIZABLE = 'The provided Uint8ClampedArray value must not be resizable.'
  const throwingWidth = {
    valueOf() {
      throw new Error('sw ran')
    },
  }
  const cases: [string, () => unknown, object][] = [
    ['SAB, 1', () => new ImageData(new Uint8ClampedArray(new SharedArrayBuffer(8)), 1), typeError(SHARED)],
    [
      'growable SAB, 1',
      () => new ImageData(new Uint8ClampedArray(new SharedArrayBuffer(8, { maxByteLength: 16 })), 1),
      typeError(SHARED),
    ],
    ['SAB, 1, 2', () => new ImageData(new Uint8ClampedArray(new SharedArrayBuffer(8)), 1, 2), typeError(SHARED)],
    // Checked when the data is converted, before the width.
    ['SAB, 0', () => new ImageData(new Uint8ClampedArray(new SharedArrayBuffer(8)), 0), typeError(SHARED)],
    [
      'SAB, throwing sw',
      () => new ImageData(new Uint8ClampedArray(new SharedArrayBuffer(4)), loose(throwingWidth)),
      typeError(SHARED),
    ],
    [
      'f32 SAB, 1',
      () => new LooseImageData(new Float32Array(new SharedArrayBuffer(16)), 1),
      typeError('The provided Float32Array value must not be shared.'),
    ],
    [
      'f32 growable SAB, 1',
      () => new LooseImageData(new Float32Array(new SharedArrayBuffer(16, { maxByteLength: 32 })), 1),
      typeError('The provided Float32Array value must not be shared.'),
    ],
    [
      'resizable, 1',
      () => new ImageData(new Uint8ClampedArray(new ArrayBuffer(4, { maxByteLength: 16 })), 1),
      typeError(RESIZABLE),
    ],
    [
      'fixed view of resizable, 1',
      () => new ImageData(new Uint8ClampedArray(new ArrayBuffer(8, { maxByteLength: 16 }), 0, 4), 1),
      typeError(RESIZABLE),
    ],
    [
      'length-tracking view of resizable, 1',
      () => new ImageData(new Uint8ClampedArray(new ArrayBuffer(8, { maxByteLength: 16 }), 4), 1),
      typeError(RESIZABLE),
    ],
    [
      'resizable, 0',
      () => new ImageData(new Uint8ClampedArray(new ArrayBuffer(4, { maxByteLength: 16 })), 0),
      typeError(RESIZABLE),
    ],
    [
      'resizable, throwing sw',
      () => new ImageData(new Uint8ClampedArray(new ArrayBuffer(4, { maxByteLength: 8 })), loose(throwingWidth)),
      typeError(RESIZABLE),
    ],
    [
      'f32 resizable, 1',
      () => new LooseImageData(new Float32Array(new ArrayBuffer(16, { maxByteLength: 32 })), 1),
      typeError('The provided Float32Array value must not be resizable.'),
    ],
    // A detached buffer is no longer resizable: it has no data.
    [
      'detached resizable, 1',
      () => {
        const ab = new ArrayBuffer(4, { maxByteLength: 16 })
        const u = new Uint8ClampedArray(ab)
        ab.transfer()
        return new ImageData(u, 1)
      },
      invalidState(CONSTRUCT, 'The input data has zero elements.'),
    ],
    [
      'detached resizable, 1, 1',
      () => {
        const ab = new ArrayBuffer(4, { maxByteLength: 16 })
        const u = new Uint8ClampedArray(ab)
        ab.transfer()
        return new ImageData(u, 1, 1)
      },
      invalidState(CONSTRUCT, 'The input data has zero elements.'),
    ],
    [
      'detached, 1',
      () => {
        const ab = new ArrayBuffer(4)
        const u = new Uint8ClampedArray(ab)
        ab.transfer()
        return new ImageData(u, 1)
      },
      invalidState(CONSTRUCT, 'The input data has zero elements.'),
    ],
  ]
  if (typeof Float16Array === 'function') {
    cases.push(
      [
        'f16 resizable, 1',
        () => new LooseImageData(new Float16Array(new ArrayBuffer(8, { maxByteLength: 16 })), 1),
        typeError('The provided Float16Array value must not be resizable.'),
      ],
      [
        'f16 SAB, 1',
        () => new LooseImageData(new Float16Array(new SharedArrayBuffer(8)), 1),
        typeError('The provided Float16Array value must not be shared.'),
      ],
    )
  }
  for (const [label, fn, expected] of cases) {
    t.deepEqual(result(fn), expected, `new ImageData(${label})`)
  }
  // A binding error: the stack keeps the bare message, as in Chrome.
  const error = t.throws(() => new ImageData(new Uint8ClampedArray(new SharedArrayBuffer(4)), 1))
  t.is(String(error?.stack).split('\n')[0], `TypeError: ${SHARED}`)
})

test('putImageData throws InvalidStateError once the data buffer is detached', (t) => {
  const detached = () => {
    const ab = new ArrayBuffer(4)
    const u = new Uint8ClampedArray(ab)
    const id = new ImageData(u, 1, 1)
    ab.transfer()
    return { id, u }
  }
  const DETACHED = invalidState(PUT, 'The source data has been detached.')
  const ctx = createCanvas(2, 2).getContext('2d')
  const { id, u } = detached()
  t.deepEqual(
    result(() => ctx.putImageData(id, 0, 0)),
    DETACHED,
  )
  t.deepEqual([id.data === u, id.data.length, id.width, id.height], [true, 0, 1, 1])
  // createImageData(imagedata) reads only the size and color space.
  const copy = ctx.createImageData(id)
  t.deepEqual([copy.width, copy.height, copy.colorSpace, Array.from(copy.data)], [1, 1, 'srgb', [0, 0, 0, 0]])
  // The dirty form too, and after a CheckMul overflow nothing is checked.
  t.deepEqual(
    result(() => ctx.putImageData(detached().id, 0, 0, 0, 0, 1, 1)),
    DETACHED,
  )
  t.deepEqual(
    result(() => ctx.putImageData(detached().id, 0, 0, 0, 0, 0, 0)),
    DETACHED,
  )
  t.deepEqual(
    result(() => ctx.putImageData(detached().id, 5, 5, 0, 0, 1, 1)),
    DETACHED,
  )
  t.deepEqual(
    result(() => ctx.putImageData(detached().id, 0, 0, 0, 0, 65536, 65536)),
    { ok: 'undefined' },
  )
  t.deepEqual(
    result(() => ctx.putImageData(detached().id, 0, 0, 0, 0, -65536, 65536)),
    { ok: 'undefined' },
  )
  // An ImageData's own buffer, detached.
  const own = new ImageData(1, 1)
  own.data.buffer.transfer()
  t.deepEqual(
    result(() => ctx.putImageData(own, 0, 0)),
    DETACHED,
  )
  const created = ctx.createImageData(1, 1)
  created.data.buffer.transfer()
  t.deepEqual(
    result(() => ctx.putImageData(created, 0, 0)),
    DETACHED,
  )
  const read = ctx.getImageData(0, 0, 1, 1)
  read.data.buffer.transfer()
  t.deepEqual(
    result(() => ctx.putImageData(read, 0, 0)),
    DETACHED,
  )
  const error = t.throws(() => ctx.putImageData(own, 0, 0))
  t.is(String(error?.stack).split('\n')[0], `InvalidStateError: ${PUT}The source data has been detached.`)
})
