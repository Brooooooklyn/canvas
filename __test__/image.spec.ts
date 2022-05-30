import { promises as fs } from 'fs'
import { join } from 'path'
import test from 'ava'

import { createCanvas, Image } from '../index'

import { snapshotImage } from './image-snapshot'

async function loadImageFile() {
  return await fs.readFile(join(__dirname, '../example/simple.png'))
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
  t.is(image.width, 300)
  t.is(image.height, 320)
  t.is(image.naturalWidth, 300)
  t.is(image.naturalHeight, 320)
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
  t.throws(() => (image.naturalWidth = 1919), expectation)

  // @ts-expect-error
  t.throws(() => (image.naturalHeight = 810), expectation)

  // @ts-expect-error
  t.throws(() => (image.complete = true), expectation)
})

test('svg-transparent-background', async (t) => {
  const image = new Image()
  image.src = await fs.readFile(join(__dirname, '..', 'example', 'resize-svg.svg'))

  const w = 1000
  const h = 1000

  // resize SVG
  image.width = w / 2
  image.height = h / 2

  // create a canvas of the same size as the image
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')

  // fill the canvas with the image
  ctx.fillStyle = 'pink'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(image, 250, 250)

  await snapshotImage(t, { canvas })
})
