import test from 'ava'

import { createCanvas } from '../index'

test('toBlob with PNG format', async (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 10, 10)

  return new Promise<void>((resolve, reject) => {
    canvas.toBlob((blob) => {
      try {
        t.truthy(blob)
        t.true(blob instanceof Blob)
        t.true(blob!.size > 0)
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  })
})

test('toBlob with JPEG format and quality', async (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 10, 10)

  return new Promise<void>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        try {
          t.truthy(blob)
          t.true(blob instanceof Blob)
          t.true(blob!.size > 0)
          resolve()
        } catch (error) {
          reject(error)
        }
      },
      'image/jpeg',
      0.8,
    )
  })
})

test('toBlob with WebP format', async (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'green'
  ctx.fillRect(0, 0, 10, 10)

  return new Promise<void>((resolve, reject) => {
    canvas.toBlob((blob) => {
      try {
        t.truthy(blob)
        t.true(blob instanceof Blob)
        t.true(blob!.size > 0)
        resolve()
      } catch (error) {
        reject(error)
      }
    }, 'image/webp')
  })
})

test('toBlob with callback that converts to arrayBuffer (issue #1087)', async (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'yellow'
  ctx.fillRect(0, 0, 10, 10)

  return new Promise<void>((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      try {
        t.truthy(blob)
        // This replicates the exact use case from the issue
        const arrayBuffer = await blob!.arrayBuffer()
        t.true(arrayBuffer instanceof ArrayBuffer)
        t.true(arrayBuffer.byteLength > 0)
        resolve()
      } catch (error) {
        reject(error)
      }
    }, 'image/png')
  })
})

test('convertToBlob with PNG format', async (t) => {
  const canvas = createCanvas(10, 10)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 10, 10)

  const blob = await canvas.convertToBlob()
  t.truthy(blob)
  t.true(blob instanceof Blob)
  t.true(blob!.size > 0)
})
