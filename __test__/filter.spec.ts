import { promises as fs, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import ava, { TestFn } from 'ava'

import { createCanvas, Canvas, SKRSContext2D, Image } from '../index'

import { snapshotImage } from './image-snapshot'

const __dirname = dirname(fileURLToPath(import.meta.url))

const test = ava as TestFn<{
  ctx: SKRSContext2D
  canvas: Canvas
}>

const FIREFOX = readFileSync(join(__dirname, 'fixtures', 'firefox-logo.svg'))
const FIREFOX_IMAGE = new Image(200, 206.433)
const { promise: firefoxImageLoad, resolve } = Promise.withResolvers<void>()
FIREFOX_IMAGE.onload = () => {
  resolve()
}
FIREFOX_IMAGE.src = FIREFOX

test.beforeEach(async (t) => {
  const canvas = createCanvas(300, 300)
  t.context.canvas = canvas
  t.context.ctx = canvas.getContext('2d')
  await firefoxImageLoad
})

test('filter-blur', async (t) => {
  const { ctx } = t.context
  ctx.filter = 'blur(5px)'
  ctx.drawImage(FIREFOX_IMAGE, 0, 0)
  await snapshotImage(t)
})

test('filter-brightness', async (t) => {
  const { ctx } = t.context
  ctx.filter = 'brightness(2)'
  const image = new Image()
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => {
    resolve()
  }
  image.src = await fs.readFile(join(__dirname, 'fixtures', 'filter-brightness.jpg'))
  await promise
  ctx.drawImage(image, 0, 0)
  await snapshotImage(t)
})

test('filter-contrast', async (t) => {
  const { ctx } = t.context
  ctx.filter = 'contrast(200%)'
  const image = new Image()
  const { promise, resolve } = Promise.withResolvers<void>()
  image.onload = () => {
    resolve()
  }
  image.src = await fs.readFile(join(__dirname, 'fixtures', 'filter-contrast.jpeg'))
  await promise
  ctx.drawImage(image, 0, 0)
  await snapshotImage(t)
})

test('filter-contrast-ff', async (t) => {
  const { ctx } = t.context
  ctx.filter = 'contrast(200%)'
  ctx.drawImage(FIREFOX_IMAGE, 0, 0)
  await snapshotImage(t)
})

test('filter-grayscale', async (t) => {
  const { ctx } = t.context
  ctx.filter = 'grayscale(80%)'
  ctx.drawImage(FIREFOX_IMAGE, 0, 0)
  await snapshotImage(t)
})

test('filter-hue-rotate', async (t) => {
  const { ctx } = t.context
  ctx.filter = 'hue-rotate(90deg)'
  ctx.drawImage(FIREFOX_IMAGE, 0, 0)
  await snapshotImage(t)
})

test('filter-drop-shadow', async (t) => {
  const { ctx } = t.context
  ctx.filter = 'drop-shadow(16px 16px 10px black)'
  ctx.drawImage(await createImage('filter-drop-shadow.jpeg'), 0, 0)
  await snapshotImage(t)
})

test('filter-invert', async (t) => {
  const { ctx } = t.context
  ctx.filter = 'invert(100%)'
  ctx.drawImage(await createImage('filter-invert.jpeg'), 0, 0)
  await snapshotImage(t)
})

test('filter-opacity', async (t) => {
  const { ctx } = t.context
  ctx.filter = 'opacity(20%)'
  ctx.drawImage(await createImage('filter-opacity.jpeg'), 0, 0)
  await snapshotImage(t)
})

test('filter-saturate', async (t) => {
  const { ctx } = t.context
  ctx.filter = 'saturate(200%)'
  ctx.drawImage(await createImage('filter-saturate.jpeg'), 0, 0)
  await snapshotImage(t)
})

test('filter-sepia', async (t) => {
  const { ctx, canvas } = t.context
  ctx.filter = 'sepia(100%)'
  ctx.drawImage(await createImage('filter-sepia.jpeg'), 0, 0)
  await snapshotImage(t, { ctx, canvas }, 'png', 0.05)
})

test('filter-combine-contrast-brightness', async (t) => {
  const { ctx } = t.context
  ctx.filter = 'contrast(175%) brightness(103%)'
  ctx.drawImage(await createImage('filter-combine-contrast-brightness.jpeg'), 0, 0)
  await snapshotImage(t)
})

test('filter-save-restore', async (t) => {
  const { ctx } = t.context
  ctx.filter = 'none'
  ctx.save()
  ctx.filter = 'invert(100%)'
  ctx.restore()
  ctx.drawImage(await createImage('filter-invert.jpeg'), 0, 0)
  await snapshotImage(t)
})

async function createImage(name: string) {
  const i = new Image()
  const { promise, resolve } = Promise.withResolvers<void>()
  i.onload = () => {
    resolve()
  }
  i.src = await fs.readFile(join(__dirname, 'fixtures', name))
  await promise
  return i
}
