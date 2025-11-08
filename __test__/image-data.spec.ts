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
  }

  // @ts-expect-error
  t.throws(() => (imageData.data = fakeData), expectation)

  // @ts-expect-error
  t.throws(() => (imageData.width = 114), expectation)

  // @ts-expect-error
  t.throws(() => (imageData.height = 514), expectation)
})

test('should be able to create from Uint16Array', (t) => {
  // Create a 2x2 image with Uint16Array (4 pixels * 4 channels = 16 elements)
  const pixelArray = Array.from<number>({ length: 2 * 2 * 4 }).fill(65535) // max value for Uint16
  const u16array = new Uint16Array(pixelArray)
  const imageData = new ImageData(u16array, 2, 2)
  
  t.is(imageData.width, 2)
  t.is(imageData.height, 2)
  // The data should be converted to Uint8ClampedArray
  t.true(imageData.data instanceof Uint8ClampedArray)
  // Values should be scaled from 16-bit to 8-bit
  t.is(imageData.data.length, 16)
  // 65535 in 16-bit should map to 255 in 8-bit
  t.is(imageData.data[0], 255)
})

test('should be able to create from Uint16Array without height', (t) => {
  const pixelArray = Array.from<number>({ length: 2 * 2 * 4 }).fill(32768) // mid value
  const u16array = new Uint16Array(pixelArray)
  const imageData = new ImageData(u16array, 2)
  
  t.is(imageData.width, 2)
  t.is(imageData.height, 2)
  t.true(imageData.data instanceof Uint8ClampedArray)
  // 32768 in 16-bit should map to approximately 128 in 8-bit
  t.true(imageData.data[0] >= 127 && imageData.data[0] <= 129)
})

test('should be able to create from Float32Array', (t) => {
  // Create a 2x2 image with Float32Array (4 pixels * 4 channels = 16 elements)
  const pixelArray = Array.from<number>({ length: 2 * 2 * 4 }).fill(1.0) // max normalized value
  const f32array = new Float32Array(pixelArray)
  const imageData = new ImageData(f32array, 2, 2)
  
  t.is(imageData.width, 2)
  t.is(imageData.height, 2)
  // The data should be converted to Uint8ClampedArray
  t.true(imageData.data instanceof Uint8ClampedArray)
  t.is(imageData.data.length, 16)
  // 1.0 in float should map to 255 in 8-bit
  t.is(imageData.data[0], 255)
})

test('should be able to create from Float32Array without height', (t) => {
  const pixelArray = Array.from<number>({ length: 2 * 2 * 4 }).fill(0.5) // mid normalized value
  const f32array = new Float32Array(pixelArray)
  const imageData = new ImageData(f32array, 2)
  
  t.is(imageData.width, 2)
  t.is(imageData.height, 2)
  t.true(imageData.data instanceof Uint8ClampedArray)
  // 0.5 in float should map to approximately 128 in 8-bit
  t.true(imageData.data[0] >= 127 && imageData.data[0] <= 128)
})

test('should clamp Float32Array values', (t) => {
  // Test clamping: values < 0 should become 0, values > 1 should become 255
  const pixelArray = [-0.5, 0.0, 0.5, 1.0, 1.5, 2.0, 0.25, 0.75, -1.0, 0.1, 0.9, 1.1, 0.0, 0.5, 1.0, 2.0]
  const f32array = new Float32Array(pixelArray)
  const imageData = new ImageData(f32array, 2, 2)
  
  t.is(imageData.width, 2)
  t.is(imageData.height, 2)
  t.is(imageData.data[0], 0) // -0.5 clamped to 0
  t.is(imageData.data[1], 0) // 0.0
  t.true(imageData.data[2] >= 127 && imageData.data[2] <= 128) // 0.5
  t.is(imageData.data[3], 255) // 1.0
  t.is(imageData.data[4], 255) // 1.5 clamped to 255
  t.is(imageData.data[5], 255) // 2.0 clamped to 255
})
