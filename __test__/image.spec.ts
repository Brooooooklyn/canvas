import { promises } from 'fs'
import { join } from 'path'
import test from 'ava'

import { Image } from '../index'

async function loadImageFile() {
  return await promises.readFile(join(__dirname, '../example/simple.png'))
}

test('should be able to create Image', (t) => {
  t.notThrows(() => new Image())
})

test('should be able to set src with buffer', async (t) => {
  const file = await loadImageFile()
  t.notThrows(() => {
    const image = new Image()
    image.src = file
  })
})

test('width and height state should be ok', async (t) => {
  const file = await loadImageFile()
  const image = new Image()
  image.src = file
  t.is(image.width, 1024)
  t.is(image.height, 768)
  t.is(image.naturalWidth, 1024)
  t.is(image.naturalHeight, 768)
  t.is(image.src, file)
})

test('complete state should be ok', async (t) => {
  const file = await loadImageFile()
  const image = new Image()
  t.is(image.complete, false)
  image.src = file
  t.is(image.complete, true)
})

test('alt state should be ok', (t) => {
  const image = new Image()
  t.is(image.alt, '')
  image.alt = 'hello'
  t.is(image.alt, 'hello')
})

test('properties should be readonly', (t) => {
  const image = new Image()
  const expectation = {
    instanceOf: TypeError,
    // compat with different Node.js versions
    message: /(Cannot assign to read only property)|(Cannot set property)/,
  }

  // @ts-expect-error
  t.throws(() => (image.width = 114), expectation)

  // @ts-expect-error
  t.throws(() => (image.height = 514), expectation)

  // @ts-expect-error
  t.throws(() => (image.naturalWidth = 1919), expectation)

  // @ts-expect-error
  t.throws(() => (image.naturalHeight = 810), expectation)

  // @ts-expect-error
  t.throws(() => (image.complete = true), expectation)
})
