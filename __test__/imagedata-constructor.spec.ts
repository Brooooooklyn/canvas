// The ImageData constructor checks `new` and the real argument count before
// it picks an overload (v8_image_data.cc ConstructorCallback), and is a
// native function shaped like Chrome's. Expected values were measured in
// Chrome 155 (--disable-gpu, arm64 = x64).
import test from 'ava'

import { createCanvas, ImageData } from '../index'

const CONSTRUCT = "Failed to construct 'ImageData': "
const NEW = "Please use the 'new' operator, this DOM object constructor cannot be called as a function."
const OVERLOAD = 'Overload resolution failed.'
const required = (present: number) => `2 arguments required, but only ${present} present.`

// Untyped access for calls the typings reject on purpose.
const AnyImageData = ImageData as any

const result = (fn: () => ImageData) => {
  try {
    const d = fn()
    return { ok: [d.width, d.height, d.colorSpace, d.data.length] }
  } catch (e: any) {
    return { ctor: e?.constructor?.name, name: e?.name, code: e?.code, msg: String(e?.message) }
  }
}
const typeError = (msg: string) => ({ ctor: 'TypeError', name: 'TypeError', code: undefined, msg: CONSTRUCT + msg })
const indexSize = (msg: string) => ({ ctor: 'DOMException', name: 'IndexSizeError', code: 1, msg: CONSTRUCT + msg })

test('ImageData must be called with new and 2 arguments', (t) => {
  const cases: [string, () => ImageData, object][] = [
    ['new ImageData()', () => new AnyImageData(), typeError(required(0))],
    ['new ImageData(1)', () => new AnyImageData(1), typeError(required(1))],
    ['new ImageData(imagedata)', () => new AnyImageData(new ImageData(1, 1)), typeError(required(1))],
    ['new ImageData(u8c(4))', () => new AnyImageData(new Uint8ClampedArray(4)), typeError(required(1))],
    ['new ImageData(undefined)', () => new AnyImageData(undefined), typeError(required(1))],
    [
      'super(1)',
      () => {
        class Sub extends AnyImageData {
          constructor() {
            super(1)
          }
        }
        return new Sub() as any
      },
      typeError(required(1)),
    ],
    ['ImageData(1, 1)', () => AnyImageData(1, 1), typeError(NEW)],
    ['ImageData()', () => AnyImageData(), typeError(NEW)],
    ['ImageData.call(imagedata, 1, 1)', () => AnyImageData.call(new ImageData(1, 1), 1, 1), typeError(NEW)],
    // An explicit undefined is an argument.
    [
      'new ImageData(1, undefined)',
      () => new AnyImageData(1, undefined),
      indexSize('The source height is zero or not a number.'),
    ],
  ]
  for (const [label, fn, expected] of cases) {
    t.deepEqual(result(fn), expected, label)
  }
  // No argument is converted before the count check.
  let conversions = 0
  t.throws(
    () =>
      new AnyImageData({
        valueOf() {
          conversions++
          return 1
        },
      }),
    { instanceOf: TypeError, message: CONSTRUCT + required(1) },
  )
  t.is(conversions, 0)
  // Called without new, it does not touch its receiver.
  const holder = { ImageData: AnyImageData }
  t.throws(() => holder.ImageData(1, 1), { instanceOf: TypeError, message: CONSTRUCT + NEW })
  t.false('data' in holder)
  // Binding errors keep the bare message in the stack.
  for (const [fn, msg] of [
    [() => new AnyImageData(), required(0)],
    [() => AnyImageData(1, 1), NEW],
    [() => new AnyImageData(1, 1, {}, 1), OVERLOAD],
  ] as [() => unknown, string][]) {
    const error = t.throws(fn)
    t.is(String(error?.stack).split('\n')[0], `TypeError: ${msg}`)
  }
})

test('new ImageData counts its arguments like Chrome', (t) => {
  const u8c = () => new Uint8ClampedArray(4)
  const cases: [string, () => ImageData, object][] = [
    // Four or more arguments need data first.
    ['1, 1, {}, undefined', () => new AnyImageData(1, 1, {}, undefined), typeError(OVERLOAD)],
    ['1, 1, undefined, undefined', () => new AnyImageData(1, 1, undefined, undefined), typeError(OVERLOAD)],
    ['1, 1, {}, 5', () => new AnyImageData(1, 1, {}, 5), typeError(OVERLOAD)],
    ["'1', 1, {}, {}", () => new AnyImageData('1', 1, {}, {}), typeError(OVERLOAD)],
    ['u16(4), 1, 1, {}', () => new AnyImageData(new Uint16Array(4), 1, 1, {}), typeError(OVERLOAD)],
    ['u16(4), 1, 1, undefined', () => new AnyImageData(new Uint16Array(4), 1, 1, undefined), typeError(OVERLOAD)],
    ['u8c(4), 1, 1, {}, 5', () => new AnyImageData(u8c(), 1, 1, {}, 5), { ok: [1, 1, 'srgb', 4] }],
    ['1, 1, undefined', () => new AnyImageData(1, 1, undefined), { ok: [1, 1, 'srgb', 4] }],
    ['1, 1, null', () => new AnyImageData(1, 1, null), { ok: [1, 1, 'srgb', 4] }],
    ['u8c(4), 1, undefined', () => new AnyImageData(u8c(), 1, undefined), { ok: [1, 1, 'srgb', 4] }],
    [
      'u8c(4), 1, undefined, undefined',
      () => new AnyImageData(u8c(), 1, undefined, undefined),
      { ok: [1, 1, 'srgb', 4] },
    ],
    [
      'u8c(4), 1, undefined, undefined, undefined',
      () => new AnyImageData(u8c(), 1, undefined, undefined, undefined),
      { ok: [1, 1, 'srgb', 4] },
    ],
    ['u8c(4), 1, 1, undefined, 5', () => new AnyImageData(u8c(), 1, 1, undefined, 5), { ok: [1, 1, 'srgb', 4] }],
    // Any argument that is not undefined, even the 5th, makes the height
    // present: undefined is then 0.
    [
      'u8c(4), 1, undefined, undefined, 5',
      () => new AnyImageData(u8c(), 1, undefined, undefined, 5),
      indexSize('The source height is zero or not a number.'),
    ],
  ]
  for (const [label, fn, expected] of cases) {
    t.deepEqual(result(fn), expected, `new ImageData(${label})`)
  }
  // The overload fails before any conversion.
  const log: string[] = []
  const v = (tag: string) => ({
    valueOf() {
      log.push(tag)
      return 1
    },
  })
  t.throws(() => new AnyImageData(v('a'), v('b'), {}, {}), { instanceOf: TypeError, message: CONSTRUCT + OVERLOAD })
  t.deepEqual(log, [])
})

test("ImageData is a native constructor shaped like Chrome's", (t) => {
  t.deepEqual([ImageData.length, ImageData.name], [2, 'ImageData'])
  const descriptor = (object: object, key: string) => {
    const d = Object.getOwnPropertyDescriptor(object, key)!
    return [d.value, d.writable, d.enumerable, d.configurable]
  }
  t.deepEqual(descriptor(ImageData, 'length'), [2, false, false, true])
  t.deepEqual(descriptor(ImageData, 'name'), ['ImageData', false, false, true])
  t.deepEqual(descriptor(ImageData, 'prototype').slice(1), [false, false, false])
  t.deepEqual(descriptor(ImageData.prototype, 'constructor'), [ImageData, true, false, true])
  t.is(Function.prototype.toString.call(ImageData), 'function ImageData() { [native code] }')
  t.is(Object.getPrototypeOf(ImageData), Function.prototype)
  // Node < 25 (V8 < 14) gives every native function own arguments and caller.
  if (Number(process.versions.v8.split('.')[0]) >= 14) {
    t.deepEqual(Object.getOwnPropertyNames(ImageData).sort(), ['length', 'name', 'prototype'])
  }
  const id = new ImageData(1, 1)
  t.is(id.constructor, ImageData)
  t.is(ImageData.prototype.constructor, ImageData)
  t.is(Object.prototype.toString.call(id), '[object ImageData]')
  // Instances made by the context share the prototype.
  const ctx = createCanvas(1, 1).getContext('2d')
  t.true(ctx.createImageData(1, 1) instanceof ImageData)
  t.true(ctx.getImageData(0, 0, 1, 1) instanceof ImageData)
  t.is(Object.getPrototypeOf(ctx.createImageData(1, 1)), ImageData.prototype)
  t.true(ctx.createImageData(new ImageData(1, 1)) instanceof ImageData)
  // Subclasses.
  class Sub extends AnyImageData {
    extra: number
    constructor(...args: unknown[]) {
      super(...args)
      this.extra = 1
    }
  }
  const s = new Sub(2, 1) as any
  t.deepEqual(
    [
      s instanceof Sub,
      s instanceof ImageData,
      Object.getPrototypeOf(s) === Sub.prototype,
      s.width,
      s.extra,
      s.colorSpace,
    ],
    [true, true, true, 2, 1, 'srgb'],
  )
  class Plain extends AnyImageData {}
  const red = new Plain(new Uint8ClampedArray([255, 0, 0, 255]), 1) as any
  const one = createCanvas(1, 1).getContext('2d')
  one.putImageData(red, 0, 0)
  t.deepEqual(Array.from(one.getImageData(0, 0, 1, 1).data), [255, 0, 0, 255])
  // Reflect.construct.
  t.deepEqual(
    result(() => Reflect.construct(ImageData, [1, 1])),
    { ok: [1, 1, 'srgb', 4] },
  )
  const o = Reflect.construct(ImageData, [1, 1], Object)
  t.deepEqual(
    [Object.getPrototypeOf(o) === Object.prototype, o instanceof ImageData, Object.prototype.toString.call(o)],
    [true, false, '[object Object]'],
  )
})
