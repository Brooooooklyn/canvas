import { join, dirname } from 'node:path'
import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import { URL, pathToFileURL, fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, Image, loadImage } from '../index'

import { snapshotImage } from './image-snapshot'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
  t.is(
    (await loadImage(
      new URL(
        'https://raw.githubusercontent.com/Brooooooklyn/canvas/462fce53afeaee6d6b4ae5d1b407c17e2359ff7e/example/anime-girl.png',
      ),
    )) instanceof Image,
    true,
  )
})

test('should load arrayBuffer', async (t) => {
  const imageBuffer = await readFile(join(__dirname, '../example/simple.png'))
  const img = await loadImage(imageBuffer.buffer)
  t.is(img instanceof Image, true)
  t.true(img.width > 0)
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

  await snapshotImage(t, { canvas }, 'jpeg', process.arch === 'x64' ? 0.05 : 0.3)
})

test('should load issue-672 img', async (t) => {
  const img = await loadImage(join(__dirname, './issue-672.jpeg'))
  t.is(img.width, 297)
  t.is(img.height, 465)
})

test('should load file url', async (t) => {
  const url = new URL('__test__/javascript.png', pathToFileURL(__dirname))
  const img = await loadImage(url)
  t.is(img.width, 512)
  t.is(img.height, 512)
})
