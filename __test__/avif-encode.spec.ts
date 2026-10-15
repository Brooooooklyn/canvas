import test from 'ava'

import { createCanvas, loadImage } from '../index'

// Chrome has no AVIF encoder: these follow our own AvifConfig doc.

// A 64x64 canvas with a smooth and a sharp part, without text (no fonts).
function sampleCanvas() {
  const canvas = createCanvas(64, 64)
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, 64, 64)
  gradient.addColorStop(0, 'red')
  gradient.addColorStop(1, 'blue')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)
  ctx.fillStyle = '#0f0'
  ctx.fillRect(10, 20, 8, 24)
  ctx.fillRect(30, 10, 24, 6)
  return canvas
}

// speed is aom's 0 (slowest) to 10 (fastest); it used to wrap before the
// clamp, so 256 was speed 0.
test('avif speed above 10 is the fastest speed', (t) => {
  const canvas = sampleCanvas()
  const fastest = canvas.toBuffer('image/avif', { speed: 10 }).length
  const slowest = canvas.toBuffer('image/avif', { speed: 0 }).length
  t.not(fastest, slowest)
  for (const speed of [11, 255, 256, 266]) {
    t.is(canvas.toBuffer('image/avif', { speed }).length, fastest, `speed ${speed}`)
  }
})

// threads: 0 or unset is one per core; aom takes at most 64.
test('avif threads above 64 do not throw', async (t) => {
  const canvas = sampleCanvas()
  for (const threads of [0, 1, 64, 65, 100]) {
    const data = canvas.toBuffer('image/avif', { threads })
    const image = await loadImage(data)
    t.deepEqual([image.width, image.height], [64, 64], `threads ${threads}`)
  }
})
