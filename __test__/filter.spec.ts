import { promises as fs, readFileSync } from 'fs'
import { join } from 'path'

import ava, { TestFn } from 'ava'

import { createCanvas, Canvas, SKRSContext2D, Image } from '../index'

import { snapshotImage } from './image-snapshot'

const test = ava as TestFn<{
  ctx: SKRSContext2D
  canvas: Canvas
}>

const FIREFOX = readFileSync(join(__dirname, 'fixtures', 'firefox-logo.svg'))
const FIREFOX_IMAGE = new Image(200, 206.433)
FIREFOX_IMAGE.src = FIREFOX

test.beforeEach((t) => {
  const canvas = createCanvas(300, 300)
  t.context.canvas = canvas
  t.context.ctx = canvas.getContext('2d')
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
  image.src = await fs.readFile(join(__dirname, 'fixtures', 'filter-brightness.jpg'))
  ctx.drawImage(image, 0, 0)
  await snapshotImage(t)
})

test('filter-contrast', async (t) => {
  const { ctx } = t.context
  ctx.filter = 'contrast(200%)'
  const image = new Image()
  image.src = await fs.readFile(join(__dirname, 'fixtures', 'filter-contrast.jpeg'))
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
  const { ctx } = t.context
  ctx.filter = 'sepia(100%)'
  ctx.drawImage(await createImage('filter-sepia.jpeg'), 0, 0)
  await snapshotImage(t)
})

test('filter-combine-contrast-brightness', async (t) => {
  const { ctx } = t.context
  ctx.filter = 'contrast(175%) brightness(103%)'
  ctx.drawImage(await createImage('filter-combine-contrast-brightness.jpeg'), 0, 0)
  await snapshotImage(t)
})

async function createImage(name: string) {
  const i = new Image()
  i.src = await fs.readFile(join(__dirname, 'fixtures', name))
  return i
}
