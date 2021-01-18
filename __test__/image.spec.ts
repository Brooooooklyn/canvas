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

test('shoule be able to set src with buffer', async (t) => {
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
