// ctx.filter values built like Blink's FilterEffectBuilder: component
// transfer tables with truncating ClampToU8 (fe_component_transfer.cc), the
// FEColorMatrix saturate coefficients (fe_color_matrix.cc) and drop-shadow()
// blur taken as a standard deviation (filter_effect_builder.cc, "stored in
// sigma form"). Every expected value was measured in Chrome 155 CPU canvas
// (--disable-gpu, willReadFrequently) in a standards-mode page, and is equal
// on arm64 and x64.
import test from 'ava'

import { createCanvas } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const px = (ctx: Ctx, x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data]

// 256x4 source: pixel (x, y) = [x, (x * 3) % 256, 255 - x, [255, 200, 128, 31][y]].
function source() {
  const canvas = createCanvas(256, 4)
  const ctx = canvas.getContext('2d')
  const data = ctx.createImageData(256, 4)
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4
      data.data[i] = x
      data.data[i + 1] = (x * 3) % 256
      data.data[i + 2] = 255 - x
      data.data[i + 3] = [255, 200, 128, 31][y]
    }
  }
  ctx.putImageData(data, 0, 0)
  return canvas
}

function filtered(filter: string, points: [number, number][]) {
  const ctx = createCanvas(256, 4).getContext('2d')
  ctx.filter = filter
  ctx.drawImage(source(), 0, 0)
  return points.map(([x, y]) => px(ctx, x, y))
}

test("brightness() uses Blink's linear transfer", (t) => {
  t.deepEqual(
    filtered('brightness(0.5)', [
      [0, 0],
      [100, 0],
    ]),
    [
      [0, 0, 127, 255],
      [50, 22, 77, 255],
    ],
  )
  t.deepEqual(
    filtered('brightness(0.9)', [
      [0, 0],
      [64, 0],
    ]),
    [
      [0, 0, 229, 255],
      [57, 172, 171, 255],
    ],
  )
})

test("contrast() uses Blink's linear transfer", (t) => {
  t.deepEqual(
    filtered('contrast(2)', [
      [22, 0],
      [100, 0],
    ]),
    [
      [0, 4, 255, 255],
      [72, 0, 182, 255],
    ],
  )
  t.deepEqual(filtered('contrast(0.3)', [[0, 0]]), [[89, 89, 165, 255]])
})

test("saturate() uses Blink's colour matrix", (t) => {
  t.deepEqual(filtered('saturate(1.5)', [[65, 0]]), [[14, 209, 202, 255]])
  t.deepEqual(filtered('saturate(0.5)', [[65, 0]]), [[116, 181, 178, 255]])
})

test("opacity() truncates like Blink's table", (t) => {
  t.deepEqual(
    filtered('opacity(0.5)', [
      [0, 0],
      [100, 0],
    ]),
    [
      [0, 0, 255, 127],
      [100, 44, 155, 127],
    ],
  )
  t.deepEqual(
    filtered('opacity(0.1)', [
      [0, 0],
      [100, 0],
    ]),
    [
      [0, 0, 255, 25],
      [102, 41, 153, 25],
    ],
  )
})

test("invert() truncates like Blink's table", (t) => {
  t.deepEqual(filtered('invert(1)', [[1, 0]]), [[254, 252, 0, 255]])
})

test('chained filters', (t) => {
  t.deepEqual(filtered('grayscale(1) invert(1)', [[50, 0]]), [[121, 121, 121, 255]])
  t.deepEqual(filtered('opacity(0.5) contrast(2)', [[100, 0]]), [[72, 0, 183, 127]])
})

// 300x100, a black rect over x < 100, alpha along row y = 50.
function dropShadowRow(filter: string, xs: number[]) {
  const ctx = createCanvas(300, 100).getContext('2d')
  ctx.filter = filter
  ctx.fillStyle = 'black'
  ctx.fillRect(-100, 0, 200, 100)
  return xs.map((x) => px(ctx, x, 50))
}

test('drop-shadow() blur is a standard deviation', (t) => {
  const alpha = (filter: string, xs: number[]) => dropShadowRow(filter, xs).map((p) => p[3])
  t.deepEqual(alpha('drop-shadow(150px 0 4px black)', [246, 250, 254]), [202, 116, 37])
  // The same edge as blur(4px), which also takes a standard deviation.
  t.deepEqual(alpha('blur(4px)', [96, 100, 104]), [202, 116, 37])
  t.deepEqual(alpha('drop-shadow(150px 0 2px black)', [250]), [105])
  t.deepEqual(dropShadowRow('drop-shadow(150px 0 4px rgba(255,0,0,0.5))', [250]), [[255, 0, 0, 58]])
})

test('a transparent or zero drop-shadow keeps the rest of the chain', (t) => {
  for (const filter of [
    'drop-shadow(0 0 0 red) invert(1)',
    'drop-shadow(2px 2px 2px transparent) invert(1)',
    'invert(1) drop-shadow(0 0 0 red)',
  ]) {
    const ctx = createCanvas(16, 16).getContext('2d')
    ctx.filter = filter
    ctx.fillStyle = 'rgb(40,120,200)'
    ctx.fillRect(4, 4, 8, 8)
    t.deepEqual(px(ctx, 8, 8), [215, 135, 55, 255], filter)
  }
})
