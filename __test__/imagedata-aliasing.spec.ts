// new ImageData(data, sw, sh?) keeps the given Uint8ClampedArray as its data
// (image_data.cc ValidateAndCreate), and rejects shared and resizable buffers
// (no [AllowShared] in image_data.idl). Expected values were measured in
// Chrome 155 (--disable-gpu, arm64 = x64).
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

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

// new ImageData over buffers whose resizable and detached properties lie.
// Blink reads the state of the buffer itself (IsResizableByUserJavaScript),
// so no property, getter, prototype or Proxy changes the result, and no
// script runs. Plain JavaScript: a worker runs its source text too. `realm`
// gives the globals of another realm, or null.
function checkBufferState(ImageData: any, realm: () => any) {
  const run = (fn: () => any) => {
    try {
      const value = fn()
      return value && typeof value === 'object' && 'width' in value ? 'ok' : `value ${String(value)}`
    } catch (e: any) {
      return `${e.constructor.name} ${e.name}: ${e.message}`
    }
  }
  const resizable = () => new ArrayBuffer(16, { maxByteLength: 64 })
  // Replaces the getter `key` of ArrayBuffer.prototype while `fn` runs.
  const patched = (key: string, get: (this: ArrayBuffer) => unknown, fn: () => unknown) => {
    const saved = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, key)!
    Object.defineProperty(ArrayBuffer.prototype, key, { get, configurable: true })
    try {
      return fn()
    } finally {
      Object.defineProperty(ArrayBuffer.prototype, key, saved)
    }
  }
  const out: Record<string, unknown> = {}
  // An own property, a prototype that shadows, a patched getter.
  out.ownFalse = run(() => {
    const ab = resizable()
    Object.defineProperty(ab, 'resizable', { value: false })
    return new ImageData(new Uint8ClampedArray(ab), 2, 2)
  })
  out.ownFalseFixedView = run(() => {
    const ab = resizable()
    Object.defineProperty(ab, 'resizable', { value: false })
    return new ImageData(new Uint8ClampedArray(ab, 0, 16), 2)
  })
  out.ownFalseFloat32 = run(() => {
    const ab = new ArrayBuffer(64, { maxByteLength: 128 })
    Object.defineProperty(ab, 'resizable', { value: false })
    return new ImageData(new Float32Array(ab), 2, 2)
  })
  out.prototypeFalse = run(() => {
    const ab = resizable()
    Object.setPrototypeOf(ab, Object.create(ArrayBuffer.prototype, { resizable: { value: false } }))
    return new ImageData(new Uint8ClampedArray(ab), 2, 2)
  })
  out.patchedResizableFalse = patched(
    'resizable',
    () => false,
    () => run(() => new ImageData(new Uint8ClampedArray(resizable()), 2, 2)),
  )
  out.patchedDetachedTrue = patched(
    'detached',
    () => true,
    () => run(() => new ImageData(new Uint8ClampedArray(resizable()), 2, 2)),
  )
  out.fixedOwnTrue = run(() => {
    const ab = new ArrayBuffer(16)
    Object.defineProperty(ab, 'resizable', { value: true })
    const u = new Uint8ClampedArray(ab)
    return new ImageData(u, 2, 2).data === u ? 'same data' : 'other data'
  })
  out.fixedPatchedTrue = patched(
    'resizable',
    () => true,
    () => run(() => new ImageData(new Uint8ClampedArray(new ArrayBuffer(16)), 2, 2)),
  )
  // Getters that throw.
  out.fixedOwnThrows = run(() => {
    const ab = new ArrayBuffer(16)
    for (const key of ['resizable', 'detached']) {
      Object.defineProperty(ab, key, {
        get() {
          throw new Error(`${key} getter ran`)
        },
      })
    }
    return new ImageData(new Uint8ClampedArray(ab), 2, 2)
  })
  class ThrowingBuffer extends ArrayBuffer {
    get resizable(): boolean {
      throw new Error('subclass resizable getter ran')
    }
    get detached(): boolean {
      throw new Error('subclass detached getter ran')
    }
  }
  out.subclassThrows = [
    run(() => new ImageData(new Uint8ClampedArray(new ThrowingBuffer(16)), 2, 2)),
    run(() => new ImageData(new Uint8ClampedArray(new ThrowingBuffer(16, { maxByteLength: 64 })), 2, 2)),
  ]
  // No getter runs: own ones, or patched ones that call the real getter.
  const calls: string[] = []
  const counted = resizable()
  Object.defineProperty(counted, 'resizable', {
    get() {
      calls.push('own resizable')
      return true
    },
  })
  Object.defineProperty(counted, 'detached', {
    get() {
      calls.push('own detached')
      return false
    },
  })
  out.ownCounted = run(() => new ImageData(new Uint8ClampedArray(counted), 2, 2))
  const real: [string, PropertyDescriptor][] = ['resizable', 'detached'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, key)!,
  ])
  try {
    for (const [key, descriptor] of real) {
      Object.defineProperty(ArrayBuffer.prototype, key, {
        get() {
          calls.push(key)
          return Reflect.apply(descriptor.get!, this, [])
        },
        configurable: true,
      })
    }
    const ab = resizable()
    const view = new Uint8ClampedArray(ab)
    ab.transfer()
    out.patchedCounted = [
      run(() => new ImageData(new Uint8ClampedArray(new ArrayBuffer(16)), 2, 2)),
      run(() => new ImageData(new Uint8ClampedArray(resizable()), 2, 2)),
      run(() => new ImageData(view, 2, 2)),
    ]
  } finally {
    for (const [key, descriptor] of real) {
      Object.defineProperty(ArrayBuffer.prototype, key, descriptor)
    }
  }
  out.calls = calls
  // A detached buffer is not resizable, whatever its properties say.
  out.detachedOwnFalse = run(() => {
    const ab = resizable()
    const view = new Uint8ClampedArray(ab)
    ab.transfer()
    Object.defineProperty(ab, 'detached', { value: false })
    return new ImageData(view, 2, 2)
  })
  // Getters that would detach or shrink the buffer do not run.
  const transferred = resizable()
  Object.defineProperty(transferred, 'resizable', {
    get() {
      transferred.transfer()
      return true
    },
  })
  out.getterTransfers = [run(() => new ImageData(new Uint8ClampedArray(transferred), 2, 2)), transferred.detached]
  const shrunk = resizable()
  Object.defineProperty(shrunk, 'resizable', {
    get() {
      ArrayBuffer.prototype.resize.call(shrunk, 8)
      return false
    },
  })
  out.getterShrinks = [run(() => new ImageData(new Uint8ClampedArray(shrunk), 2, 2)), shrunk.byteLength]
  // A Proxy in the prototype chain, and a Proxy of a typed array (not one).
  const traps: string[] = []
  const lying = (value: boolean) =>
    new Proxy(ArrayBuffer.prototype, {
      get(target, key, receiver) {
        if (typeof key === 'string') traps.push(key)
        return key === 'resizable' ? value : Reflect.get(target, key, receiver)
      },
    })
  out.proxyPrototype = [
    run(() => new ImageData(new Uint8ClampedArray(Object.setPrototypeOf(resizable(), lying(false))), 2, 2)),
    run(() => new ImageData(new Uint8ClampedArray(Object.setPrototypeOf(new ArrayBuffer(16), lying(true))), 2, 2)),
  ]
  out.traps = traps
  // The size form: ToNumber of the Proxy fails in %TypedArray%.prototype.join,
  // whose message names the receiver differently in each V8.
  out.proxyOfView = run(() => new ImageData(new Proxy(new Uint8ClampedArray(resizable()), {}), 2, 2)).replace(
    / receiver .*/,
    ' receiver',
  )
  // Shared buffers never reach the getters.
  const sharedCalls: string[] = []
  const growable = new SharedArrayBuffer(16, { maxByteLength: 64 })
  for (const key of ['growable', 'resizable', 'detached']) {
    Object.defineProperty(growable, key, {
      get() {
        sharedCalls.push(key)
        return false
      },
    })
  }
  out.shared = [
    run(() => new ImageData(new Uint8ClampedArray(growable), 2, 2)),
    run(
      () =>
        new ImageData(
          new Uint8ClampedArray(Object.setPrototypeOf(new SharedArrayBuffer(16), ArrayBuffer.prototype)),
          2,
          2,
        ),
    ),
    sharedCalls,
  ]
  // Buffers of another realm, whose ArrayBuffer.prototype may lie too.
  const other = realm()
  out.otherRealm = other && [
    run(() => new ImageData(new other.Uint8ClampedArray(new other.ArrayBuffer(16, { maxByteLength: 64 })), 2, 2)),
    run(() => {
      other.Object.defineProperty(other.ArrayBuffer.prototype, 'resizable', { get: () => false, configurable: true })
      const ab = new other.ArrayBuffer(16, { maxByteLength: 64 })
      Object.defineProperty(ab, 'resizable', { value: false })
      return new ImageData(new other.Uint8ClampedArray(ab), 2, 2)
    }),
    run(() => {
      const u = new other.Uint8ClampedArray(new other.ArrayBuffer(16))
      return new ImageData(u, 2, 2).data === u ? 'same data' : 'other data'
    }),
    run(() => {
      const ab = new other.ArrayBuffer(16, { maxByteLength: 64 })
      const view = new other.Uint8ClampedArray(ab)
      ab.transfer()
      return new ImageData(view, 2, 2)
    }),
  ]
  return out
}

// Chrome 155: a page (other realm: a same-origin iframe) and a dedicated
// worker give the same values.
const RESIZABLE =
  "TypeError TypeError: Failed to construct 'ImageData': The provided Uint8ClampedArray value must not be resizable."
const SHARED_ERROR =
  "TypeError TypeError: Failed to construct 'ImageData': The provided Uint8ClampedArray value must not be shared."
const ZERO = "DOMException InvalidStateError: Failed to construct 'ImageData': The input data has zero elements."
const CHROME_BUFFER_STATE = {
  ownFalse: RESIZABLE,
  ownFalseFixedView: RESIZABLE,
  ownFalseFloat32:
    "TypeError TypeError: Failed to construct 'ImageData': The provided Float32Array value must not be resizable.",
  prototypeFalse: RESIZABLE,
  patchedResizableFalse: RESIZABLE,
  patchedDetachedTrue: RESIZABLE,
  fixedOwnTrue: 'value same data',
  fixedPatchedTrue: 'ok',
  fixedOwnThrows: 'ok',
  subclassThrows: ['ok', RESIZABLE],
  ownCounted: RESIZABLE,
  patchedCounted: ['ok', RESIZABLE, ZERO],
  calls: [],
  detachedOwnFalse: ZERO,
  getterTransfers: [RESIZABLE, false],
  getterShrinks: [RESIZABLE, 16],
  proxyPrototype: [RESIZABLE, 'ok'],
  traps: [],
  proxyOfView: 'TypeError TypeError: Method %TypedArray%.prototype.join called on incompatible receiver',
  shared: [SHARED_ERROR, SHARED_ERROR, []],
  otherRealm: [RESIZABLE, RESIZABLE, 'value same data', ZERO],
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('new ImageData reads whether the buffer is resizable from the buffer, not its properties', async (t) => {
  const vm = createRequire(import.meta.url)('node:vm')
  t.deepEqual(
    checkBufferState(ImageData, () => vm.runInNewContext('globalThis')),
    CHROME_BUFFER_STATE,
  )
  // A worker has its own realm and its own ArrayBuffer.prototype.
  const inWorker = await new Promise((resolve, reject) => {
    const worker = new Worker(
      `
        const { parentPort } = require('node:worker_threads')
        const { ImageData } = require(${JSON.stringify(join(root, 'index.js'))})
        const checkBufferState = ${checkBufferState.toString()}
        parentPort.postMessage(checkBufferState(ImageData, () => null))
      `,
      { eval: true },
    )
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) => code !== 0 && reject(new Error(`worker exit ${code}`)))
  })
  t.deepEqual(inWorker, { ...CHROME_BUFFER_STATE, otherRealm: null })
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
