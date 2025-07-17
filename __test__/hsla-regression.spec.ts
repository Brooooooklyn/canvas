import ava, { TestFn } from 'ava'
import { createCanvas, Canvas, SKRSContext2D } from '../index'
import { snapshotImage } from './image-snapshot'

const test = ava as TestFn<{
  canvas: Canvas
  ctx: SKRSContext2D
}>

test.beforeEach((t) => {
  const canvas = createCanvas(200, 200)
  t.context.canvas = canvas
  t.context.ctx = canvas.getContext('2d')!
})

test('hsla-regression', async (t) => {
  const { ctx } = t.context
  
  // Test HSLA color parsing
  // hsla(252, 0%, 35%, 0.926) should be equivalent to rgba(89, 89, 89, 0.926)
  ctx.fillStyle = 'hsla(252, 0%, 35%, 0.926)'
  ctx.fillRect(20, 20, 80, 80)
  
  // Equivalent RGBA test for comparison
  const value = Math.round((35 / 100) * 255)
  ctx.fillStyle = `rgba(${value}, ${value}, ${value}, 0.926)`
  ctx.fillRect(120, 20, 80, 80)
  
  await snapshotImage(t)
})

test('hsla-color-formats', async (t) => {
  const { ctx } = t.context
  
  // Test various HSLA formats
  ctx.fillStyle = 'hsl(120, 50%, 50%)'
  ctx.fillRect(10, 10, 40, 40)
  
  ctx.fillStyle = 'hsla(240, 100%, 50%, 0.5)'
  ctx.fillRect(60, 10, 40, 40)
  
  ctx.fillStyle = 'hsla(0, 100%, 50%, 1.0)'
  ctx.fillRect(110, 10, 40, 40)
  
  await snapshotImage(t)
})