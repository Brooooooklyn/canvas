// drawCanvas has no Chrome counterpart. Its spec analogue is drawImage of the
// canvas, which composites the source's pixels: whatever ops the source ran,
// they never reach the destination. Every expected value is Chrome 155 CPU
// canvas drawImage(source) of the same scene (--disable-gpu,
// willReadFrequently), equal on arm64 and x64.
import test from 'ava'

import { createCanvas } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const px = (ctx: Ctx, x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data]

const LIME = [0, 255, 0, 255]
const RED = [255, 0, 0, 255]
const BLUE = [0, 0, 255, 255]

// 40x40 source drawn with drawCanvas onto a 40x40 lime destination; reads
// (5,5), (15,15) and (30,30).
function viaDrawCanvas(srcSetup: (c: Ctx) => void, dstSetup: (c: Ctx) => void = () => {}) {
  const src = createCanvas(40, 40)
  srcSetup(src.getContext('2d'))
  const ctx = createCanvas(40, 40).getContext('2d')
  ctx.fillStyle = 'lime'
  ctx.fillRect(0, 0, 40, 40)
  dstSetup(ctx)
  ctx.drawCanvas(src, 0, 0)
  return [px(ctx, 5, 5), px(ctx, 15, 15), px(ctx, 30, 30)]
}

const redThen = (op: Ctx['globalCompositeOperation']) => (c: Ctx) => {
  c.fillStyle = 'red'
  c.fillRect(0, 0, 40, 40)
  c.globalCompositeOperation = op
  c.fillStyle = 'blue'
  c.fillRect(10, 10, 10, 10)
}

test('drawCanvas keeps the destination under a copy source', (t) => {
  t.deepEqual(viaDrawCanvas(redThen('copy')), [LIME, BLUE, LIME])
})

test('drawCanvas keeps the destination under a source-in source', (t) => {
  t.deepEqual(viaDrawCanvas(redThen('source-in')), [LIME, BLUE, LIME])
})

test('drawCanvas keeps the destination under a destination-in source', (t) => {
  t.deepEqual(viaDrawCanvas(redThen('destination-in')), [LIME, RED, LIME])
})

test('drawCanvas keeps the destination under a source-out source', (t) => {
  t.deepEqual(viaDrawCanvas(redThen('source-out')), [LIME, LIME, LIME])
})

test('drawCanvas keeps the destination under a destination-atop source', (t) => {
  t.deepEqual(viaDrawCanvas(redThen('destination-atop')), [LIME, RED, LIME])
})

test('drawCanvas shows the destination through a destination-out hole', (t) => {
  t.deepEqual(viaDrawCanvas(redThen('destination-out')), [RED, LIME, RED])
})

test('drawCanvas shows the destination through an xor hole', (t) => {
  t.deepEqual(viaDrawCanvas(redThen('xor')), [RED, LIME, RED])
})

test('drawCanvas shows the destination through a clearRect hole', (t) => {
  const got = viaDrawCanvas((c) => {
    c.fillStyle = 'red'
    c.fillRect(0, 0, 40, 40)
    c.clearRect(10, 10, 10, 10)
  })
  t.deepEqual(got, [RED, LIME, RED])
})

test('drawCanvas of a clipped copy keeps the destination outside the clip', (t) => {
  const got = viaDrawCanvas((c) => {
    c.fillStyle = 'red'
    c.fillRect(0, 0, 40, 40)
    c.beginPath()
    c.rect(5, 5, 20, 20)
    c.clip()
    c.globalCompositeOperation = 'copy'
    c.fillStyle = 'rgba(0,0,255,0.5)'
    c.fillRect(10, 10, 10, 10)
  })
  t.deepEqual(got, [LIME, [0, 127, 128, 255], RED])
})

test('drawCanvas of a reset() source keeps the destination', (t) => {
  const got = viaDrawCanvas((c) => {
    c.fillStyle = 'red'
    c.fillRect(0, 0, 40, 40)
    c.reset()
    c.fillStyle = 'blue'
    c.fillRect(10, 10, 10, 10)
  })
  t.deepEqual(got, [LIME, BLUE, LIME])
})

test('drawCanvas keeps the destination under a filtered copy or a shadowed source-in source', (t) => {
  const filtered = viaDrawCanvas((c) => {
    c.fillStyle = 'red'
    c.fillRect(0, 0, 40, 40)
    c.globalCompositeOperation = 'copy'
    c.filter = 'blur(1px)'
    c.fillStyle = 'blue'
    c.fillRect(10, 10, 10, 10)
  })
  t.deepEqual(filtered, [LIME, BLUE, LIME])
  const shadowed = viaDrawCanvas((c) => {
    c.fillStyle = 'red'
    c.fillRect(0, 0, 40, 40)
    c.globalCompositeOperation = 'source-in'
    c.shadowColor = 'black'
    c.shadowOffsetX = 4
    c.fillStyle = 'blue'
    c.fillRect(10, 10, 10, 10)
  })
  t.deepEqual(shadowed, [LIME, BLUE, LIME])
})

const plain = (c: Ctx) => {
  c.fillStyle = 'red'
  c.fillRect(5, 5, 20, 20)
  c.fillStyle = 'rgba(0,0,255,0.5)'
  c.fillRect(10, 10, 20, 20)
}

test('drawCanvas of a plain source is unchanged', (t) => {
  t.deepEqual(viaDrawCanvas(plain), [RED, [127, 0, 128, 255], LIME])
})

// The paths that already drew the source in a layer (a destination paint).
test('drawCanvas with a destination paint is unchanged', (t) => {
  const cases: [string, (c: Ctx) => void, number[][], number[][]][] = [
    [
      'globalAlpha',
      (c) => (c.globalAlpha = 0.5),
      [LIME, [0, 126, 128, 255], LIME],
      [[128, 126, 0, 255], [63, 126, 64, 255], LIME],
    ],
    [
      'multiply',
      (c) => (c.globalCompositeOperation = 'multiply'),
      [LIME, [0, 0, 0, 255], LIME],
      [[0, 0, 0, 255], [0, 0, 0, 255], LIME],
    ],
    [
      'source-in',
      (c) => (c.globalCompositeOperation = 'source-in'),
      [[0, 0, 0, 0], BLUE, [0, 0, 0, 0]],
      [RED, [127, 0, 128, 255], [0, 0, 0, 0]],
    ],
    [
      'shadow',
      (c) => {
        c.shadowColor = 'rgba(0,0,0,0.5)'
        c.shadowOffsetX = 3
        c.shadowOffsetY = 3
      },
      [LIME, BLUE, LIME],
      [RED, [127, 0, 128, 255], [0, 191, 0, 255]],
    ],
  ]
  for (const [name, dstSetup, copyWant, plainWant] of cases) {
    t.deepEqual(viaDrawCanvas(redThen('copy'), dstSetup), copyWant, `${name} copy`)
    t.deepEqual(viaDrawCanvas(plain, dstSetup), plainWant, `${name} plain`)
  }
})

// Not a Chrome value: Chrome's drawImage(canvas) samples the source's pixels
// and differs from a direct draw here. drawCanvas replays the vectors; its
// isolation layer (the source used copy) must keep the device's 8x8 dither
// phase, so the replay equals a direct draw of the same gradient.
test('drawCanvas isolation keeps the gradient dither phase', (t) => {
  const gradientFill = (c: Ctx) => {
    const g = c.createLinearGradient(0, 0, 200, 0)
    g.addColorStop(0, '#102030')
    g.addColorStop(1, '#203a50')
    c.fillStyle = g
    c.fillRect(0, 0, 200, 40)
  }
  const src = createCanvas(200, 40)
  const s = src.getContext('2d')
  s.globalCompositeOperation = 'copy'
  gradientFill(s)
  for (const ox of [3, 13]) {
    const a = createCanvas(256, 64).getContext('2d')
    a.drawCanvas(src, ox, 5)
    const b = createCanvas(256, 64).getContext('2d')
    b.translate(ox, 5)
    gradientFill(b)
    t.deepEqual(a.getImageData(0, 0, 256, 64).data, b.getImageData(0, 0, 256, 64).data, `ox ${ox}`)
  }
})
