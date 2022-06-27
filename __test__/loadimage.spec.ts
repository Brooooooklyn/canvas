import { join } from 'path'
import test from 'ava'
import fs from 'fs'

import { createCanvas, Image, loadImage } from '../index'

import { snapshotImage } from './image-snapshot'

test('should load file src', async (t) => {
  const img = await loadImage(join(__dirname, '../example/simple.png'))
  t.is(img instanceof Image, true)
})

test('should load file stream', async (t) => {
  const img = await loadImage(fs.createReadStream(join(__dirname, '../example/simple.png')))
  t.is(img instanceof Image, true)
})

test('should load image with alt', async (t) => {
  const img = await loadImage(join(__dirname, '../example/simple.png'), {
    alt: 'demo-image',
  })
  t.is(img.alt, 'demo-image')
})

test('should load remote url', async (t) => {
  const img = await loadImage(
    'https://raw.githubusercontent.com/Brooooooklyn/canvas/462fce53afeaee6d6b4ae5d1b407c17e2359ff7e/example/anime-girl.png',
  )
  t.is(img instanceof Image, true)
})

test('should load data uri', async (t) => {
  const img = await loadImage(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII',
  )
  t.is(img instanceof Image, true)
})

test('should draw img', async (t) => {
  const img = await loadImage(
    'https://raw.githubusercontent.com/Brooooooklyn/canvas/462fce53afeaee6d6b4ae5d1b407c17e2359ff7e/example/anime-girl.png',
  )

  // create a canvas of the same size as the image
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')

  // fill the canvas with the image
  ctx.fillStyle = '#23eff0'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 250, 250)

  await snapshotImage(t, { canvas }, 'jpeg')
})
