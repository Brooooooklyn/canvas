// Gradient pixels pinned to Chrome 155 CPU canvas
// (getContext('2d', { willReadFrequently: true }), launched with --disable-gpu).
import test from 'ava'

import { createCanvas } from '../index'

test('hsl() gradient stops keep float precision', (t) => {
  // Two equal stops: Chrome keeps the float sRGB color and dithers it.
  const expected: Record<string, number[]> = {
    'hsl(120, 50%, 50%)': [63, 191, 63, 255, 64, 192, 64, 255],
    'hsl(10, 77%, 33%)': [148, 40, 19, 255, 149, 41, 20, 255],
  }
  for (const [color, bytes] of Object.entries(expected)) {
    const ctx = createCanvas(8, 1).getContext('2d')
    const gradient = ctx.createLinearGradient(0, 0, 8, 0)
    gradient.addColorStop(0, color)
    gradient.addColorStop(1, color)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 8, 1)
    t.deepEqual([...ctx.getImageData(0, 0, 2, 1).data], bytes, color)
  }
})
