// drawImage of a canvas onto a subpixel destination rect. This already
// matches Chrome; the tests guard it. Every expected value was measured in
// Chrome 155 CPU canvas (--disable-gpu, willReadFrequently) in a
// standards-mode page, each source decoded from its own Blob URL, and is
// equal on arm64 and x64.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, loadImage } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>
type Quality = 'off' | 'low' | 'high'

const NOISE = readFileSync(join(__dirname, 'fixtures', 'compositing', 'n5x5.png'))

// A w x h canvas holding the 5x5 noise image scaled to fit.
async function source(w: number, h: number) {
  const image = await loadImage(NOISE)
  const canvas = createCanvas(w, h)
  canvas.getContext('2d').drawImage(image, 0, 0, w, h)
  return canvas
}

// Every non-transparent pixel of an 8x8 destination as `x,y:r/g/b/a`.
function draw(
  src: Awaited<ReturnType<typeof source>>,
  quality: Quality,
  [x, y, w, h]: number[],
  setup: (ctx: Ctx) => void = () => {},
  colorSpace: 'srgb' | 'display-p3' = 'srgb',
) {
  const ctx = createCanvas(8, 8).getContext('2d', { colorSpace })
  if (quality === 'off') ctx.imageSmoothingEnabled = false
  else ctx.imageSmoothingQuality = quality
  setup(ctx)
  ctx.drawImage(src, x, y, w, h)
  const data = ctx.getImageData(0, 0, 8, 8).data
  const out = []
  for (let i = 0; i < 64; i++) {
    if (data[i * 4 + 3]) out.push(`${i % 8},${i >> 3}:${data.slice(i * 4, i * 4 + 4).join('/')}`)
  }
  return out.join(' ')
}

test('drawImage of a canvas on a subpixel destination rect', async (t) => {
  const c5x3 = await source(5, 3)
  const c2 = await source(2, 2)
  t.is(draw(c5x3, 'low', [0.3, 0.6, 0.52, 0.52]), '0,0:196/157/177/52 0,1:191/32/159/16')
  t.is(
    draw(c5x3, 'high', [3.7, 2.2, 2.5, 0.3]),
    '3,2:139/104/104/22 4,2:138/104/104/76 5,2:148/104/97/76 6,2:153/102/102/15',
  )
  t.is(draw(c5x3, 'low', [3.7, 2.2, 0.1, 0.1]), '3,2:128/255/255/2')
  t.is(draw(c2, 'high', [0, 0, 0.3, 0.3]), '0,0:162/104/93/22')
  t.is(
    draw(c5x3, 'off', [0.3, 0.6, 1.4, 0.6], (ctx) => ctx.scale(0.5, 0.5)),
    '0,0:106/183/77/53',
  )
  t.is(draw(c5x3, 'low', [0.3, 0.6, 1, 1], undefined, 'display-p3'), '0,1:143/111/106/255')
})
