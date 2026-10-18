import test from 'ava'

import { ImageData } from '../index'

test('should be able to create ImageData', (t) => {
  t.notThrows(() => new ImageData(1024, 768))
})

test('should be able to create from Uint8ClampedArray', (t) => {
  const pixelArray = Array.from<number>({ length: 4 * 4 * 4 }).fill(255)
  const u8array = new Uint8ClampedArray(pixelArray)
  const imageData = new ImageData(u8array, 4, 4)
  // Chrome keeps the given array as the data.
  t.is(imageData.data, u8array)
  t.deepEqual(imageData.data, u8array)
  t.is(imageData.width, 4)
  t.is(imageData.height, 4)
})

test('should be able to create from Uint8ClampedArray without height', (t) => {
  const pixelArray = Array.from<number>({ length: 4 * 4 * 4 }).fill(233)
  const u8array = new Uint8ClampedArray(pixelArray)
  const imageData = new ImageData(u8array, 4)
  t.is(imageData.data, u8array)
  t.deepEqual(imageData.data, u8array)
  t.is(imageData.width, 4)
  t.is(imageData.height, 4)
})

test('should throw if width * height * 4 not equal to arraybuffer length', (t) => {
  const pixelArray = Array.from<number>({ length: 4 * 4 * 4 }).fill(255)
  const u8array = new Uint8ClampedArray(pixelArray)
  // Chrome 155: IndexSizeError (DOMException code 1).
  t.throws(() => new ImageData(u8array, 4, 3), {
    name: 'IndexSizeError',
    code: 1,
    message: "Failed to construct 'ImageData': The input data length is not equal to (4 * width * height).",
  })
})

test('properties should be readonly', (t) => {
  const imageData = new ImageData(1024, 768)
  const fakeData = new Uint8ClampedArray()
  const expectation = {
    instanceOf: TypeError,
  }

  // @ts-expect-error
  t.throws(() => (imageData.data = fakeData), expectation)

  // @ts-expect-error
  t.throws(() => (imageData.width = 114), expectation)

  // @ts-expect-error
  t.throws(() => (imageData.height = 514), expectation)
})
