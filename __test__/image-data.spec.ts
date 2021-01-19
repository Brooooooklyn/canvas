import test from 'ava'

import { ImageData } from '../index'

test('should be able to create ImageData', (t) => {
  t.notThrows(() => new ImageData(1024, 768))
})

test('should be able to create from Uint8ClampedArray', (t) => {
  const pixelArray = Array.from<number>({ length: 4 * 4 * 4 }).fill(255)
  const u8array = new Uint8ClampedArray(pixelArray)
  const imageData = new ImageData(u8array, 4, 4)
  t.not(imageData.data, u8array)
  t.deepEqual(imageData.data, u8array)
  t.is(imageData.width, 4)
  t.is(imageData.height, 4)
})

test('should be able to create from Uint8ClampedArray without height', (t) => {
  const pixelArray = Array.from<number>({ length: 4 * 4 * 4 }).fill(233)
  const u8array = new Uint8ClampedArray(pixelArray)
  const imageData = new ImageData(u8array, 4)
  t.not(imageData.data, u8array)
  t.deepEqual(imageData.data, u8array)
  t.is(imageData.width, 4)
  t.is(imageData.height, 4)
})

test('should throw if width * height * 4 not equal to arraybuffer length', (t) => {
  const pixelArray = Array.from<number>({ length: 4 * 4 * 4 }).fill(255)
  const u8array = new Uint8ClampedArray(pixelArray)
  t.throws(() => new ImageData(u8array, 4, 3), {
    code: 'InvalidArg',
    message: 'Index or size is negative or greater than the allowed amount',
  })
})

test('properties should be readonly', (t) => {
  const imageData = new ImageData(1024, 768)
  const fakeData = new Uint8ClampedArray()
  const expectation = {
    instanceOf: TypeError,
    message: /Cannot assign to read only property/,
  }

  // @ts-expect-error
  t.throws(() => (imageData.data = fakeData), expectation)

  // @ts-expect-error
  t.throws(() => (imageData.width = 114), expectation)

  // @ts-expect-error
  t.throws(() => (imageData.height = 514), expectation)
})
