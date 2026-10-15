// data() of a float16 canvas.
import test from 'ava'

import { createCanvas } from '../index'

import { chromeFor } from './float16-helpers'

const loose = (value: unknown) => value as any

// No Chrome counterpart: data() gives the stored pixels, premultiplied half
// floats on a float16 canvas.
test('data() of a float16 canvas is its premultiplied half floats', (t) => {
  const c = createCanvas(1, 1)
  const ctx = c.getContext('2d', loose({ colorType: 'float16' }))
  ctx.fillStyle = 'rgba(255,255,255,0.01)'
  for (let i = 0; i < 100; i++) ctx.fillRect(0, 0, 1, 1)
  const data = c.data()
  t.is(data.length, 8)
  const half = (i: number) => {
    const bits = data.readUInt16LE(i)
    const exp = (bits >> 10) & 0x1f
    const frac = bits & 0x3ff
    const sign = bits >> 15 ? -1 : 1
    if (exp === 0) return sign * 2 ** -14 * (frac / 1024)
    return sign * 2 ** (exp - 15) * (1 + frac / 1024)
  }
  // White at P1's alpha: the premultiplied channels equal the alpha.
  const alpha = (chromeFor('P1-100-fills') as any[]).map((pin) => pin.float16.transparent.f32[3])
  t.true(alpha.includes(half(6)), String(half(6)))
  t.deepEqual([half(0), half(2), half(4)], [half(6), half(6), half(6)])
})
