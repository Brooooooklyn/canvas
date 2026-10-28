// rotate() and the current path. Blink keeps the path in user space, so
// rotate(a) maps it by RotateRadians(-a) (canvas_2d_recorder_context.cc:
// 1409-1412). Main mapped it by -a degrees, not radians, so a path built
// before rotate() moved: moveTo(50, 50); rotate(0.7); lineTo(...) stroked
// 1226 pixels where Chrome strokes 200. Every value is pinned to Chrome 156 CPU
// canvas (--disable-gpu, getContext('2d', { willReadFrequently: true })).
import test from 'ava'

import { createCanvas } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

/** [x0, y0, x1, y1, alpha sum] of a 100x100 canvas; the box holds the pixels with alpha > 0. */
function ink(ctx: Ctx) {
  const d = ctx.getImageData(0, 0, 100, 100).data
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  let sum = 0
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 100; x++) {
      const a = d[(y * 100 + x) * 4 + 3]
      sum += a
      if (a) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
    }
  }
  return [x0, y0, x1, y1, sum]
}

const ANGLES: Record<string, number> = {
  '0.7': 0.7,
  'π/2': Math.PI / 2,
  π: Math.PI,
  '1e10': 1e10,
  '1': 1,
  '-2': -2,
  '0.25': 0.25,
  '20': 20,
}

// (60, 50) through the inverse of rotate(a): lineTo there ends at (60, 50).
const end = (a: number): [number, number] => [60 * Math.cos(a) + 50 * Math.sin(a), -60 * Math.sin(a) + 50 * Math.cos(a)]

const SCENES: Record<string, (ctx: Ctx, a: number) => void> = {
  // The report: a 10 x 20 butt stroke from (50, 50) to (60, 50).
  'moveTo, rotate, lineTo, stroke': (ctx, a) => {
    ctx.lineWidth = 20
    ctx.lineCap = 'butt'
    ctx.moveTo(50, 50)
    ctx.rotate(a)
    ctx.lineTo(...end(a))
    ctx.stroke()
  },
  'moveTo, rotate, lineTo, resetTransform, stroke': (ctx, a) => {
    ctx.lineWidth = 20
    ctx.lineCap = 'butt'
    ctx.moveTo(50, 50)
    ctx.rotate(a)
    ctx.lineTo(...end(a))
    ctx.resetTransform()
    ctx.stroke()
  },
  'curve, rotate, stroke': (ctx, a) => {
    ctx.lineWidth = 5
    ctx.moveTo(20, 20)
    ctx.lineTo(70, 40)
    ctx.quadraticCurveTo(90, 80, 30, 85)
    ctx.rotate(a)
    ctx.stroke()
  },
  'rect + arc, rotate, fill': (ctx, a) => {
    ctx.rect(30.5, 30.25, 25, 15)
    ctx.arc(40, 70, 12, 0, 5)
    ctx.rotate(a)
    ctx.fill()
  },
  'rect, rotate, fill': (ctx, a) => {
    ctx.rect(20, 20, 30, 20)
    ctx.rotate(a)
    ctx.fill()
  },
  'lineTo between rotate(a) and rotate(-a)': (ctx, a) => {
    ctx.lineWidth = 3
    ctx.moveTo(50, 50)
    ctx.rotate(a)
    ctx.lineTo(30, 10)
    ctx.rotate(-a)
    ctx.lineTo(80, 80)
    ctx.stroke()
  },
  'rect, save, rotate, restore, fill': (ctx, a) => {
    ctx.rect(30.5, 30.25, 25, 15)
    ctx.save()
    ctx.rotate(a)
    ctx.restore()
    ctx.lineTo(10, 90)
    ctx.fill()
  },
  'rotate, lineTo, resetTransform, lineTo': (ctx, a) => {
    ctx.lineWidth = 4
    ctx.moveTo(20, 50)
    ctx.rotate(a)
    ctx.lineTo(10, 10)
    ctx.resetTransform()
    ctx.lineTo(90, 90)
    ctx.stroke()
  },
  'scale(2, 0.5), rotate, setTransform': (ctx, a) => {
    ctx.scale(2, 0.5)
    ctx.lineWidth = 3
    ctx.moveTo(10, 100)
    ctx.rotate(a)
    ctx.lineTo(20, 20)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.lineTo(90, 10)
    ctx.stroke()
  },
}

// Chrome 156 [x0, y0, x1, y1, alpha sum]; main had 300 to 1700 pixels wrong in
// each. The stroke from a lone moveTo at 1e10 and 20 is left out: its end
// column is one alpha level off (the moveTo is mapped with a fused
// multiply-add). Angles 1, -2, 0.25 and 20 also need the double-pi degrees.
const EXPECTED: Record<string, Record<string, number[]>> = {
  'moveTo, rotate, lineTo, stroke': {
    '0.7': [50, 40, 59, 59, 51000],
    'π/2': [50, 40, 59, 59, 51000],
    π: [50, 40, 59, 59, 51000],
    '1': [49, 40, 59, 59, 51000],
    '-2': [50, 40, 59, 59, 51000],
    '0.25': [49, 40, 59, 59, 51020],
  },
  'moveTo, rotate, lineTo, resetTransform, stroke': {
    '0.7': [50, 40, 59, 59, 51000],
    'π/2': [50, 40, 59, 59, 51000],
    π: [50, 40, 59, 59, 51000],
    '1': [49, 40, 59, 59, 51000],
    '-2': [50, 40, 59, 59, 51000],
    '0.25': [50, 40, 59, 59, 51000],
  },
  'curve, rotate, stroke': {
    '0.7': [19, 17, 77, 87, 166322],
    'π/2': [19, 17, 77, 87, 166322],
    π: [19, 17, 77, 87, 166322],
    '1e10': [19, 17, 77, 87, 166322],
    '1': [19, 17, 77, 87, 166322],
    '-2': [19, 17, 77, 87, 166322],
    '0.25': [19, 17, 77, 87, 166322],
    '20': [19, 17, 77, 87, 166322],
  },
  'rect + arc, rotate, fill': {
    '0.7': [28, 30, 55, 81, 214507],
    'π/2': [28, 30, 55, 81, 214501],
    π: [28, 30, 55, 81, 214501],
    '1e10': [28, 30, 55, 81, 214495],
    '1': [28, 30, 55, 81, 214440],
    '-2': [28, 30, 55, 81, 214424],
    '0.25': [28, 30, 55, 81, 214467],
    '20': [28, 30, 55, 81, 214494],
  },
  'rect, rotate, fill': {
    '0.7': [20, 20, 49, 39, 153000],
    'π/2': [20, 20, 49, 39, 153000],
    π: [20, 20, 49, 39, 153000],
    '1e10': [20, 20, 49, 39, 153000],
    '1': [19, 20, 49, 39, 153000],
    '-2': [19, 20, 49, 39, 153020],
    '0.25': [20, 20, 49, 39, 153000],
    '20': [20, 20, 49, 39, 153000],
  },
  'lineTo between rotate(a) and rotate(-a)': {
    '0.7': [15, 25, 80, 81, 84957],
    'π/2': [0, 31, 80, 81, 110237],
    π: [0, 10, 80, 81, 123179],
    '1e10': [31, 0, 81, 80, 108894],
    '1': [7, 29, 80, 81, 95408],
    '-2': [15, 0, 81, 80, 122292],
    '0.25': [25, 16, 81, 80, 79588],
    '20': [2, 30, 80, 81, 102661],
  },
  'rect, save, rotate, restore, fill': {
    '0.7': [30, 30, 55, 45, 95662],
    'π/2': [30, 30, 55, 45, 95662],
    π: [30, 30, 55, 45, 95662],
    '1e10': [30, 30, 55, 45, 95662],
    '1': [30, 30, 55, 45, 95659],
    '-2': [30, 30, 55, 45, 95645],
    '0.25': [30, 30, 55, 45, 95622],
    '20': [30, 30, 55, 45, 95662],
  },
  'rotate, lineTo, resetTransform, lineTo': {
    '0.7': [0, 10, 91, 91, 155912],
    'π/2': [0, 15, 91, 91, 148899],
    π: [0, 0, 91, 91, 175420],
    '1e10': [11, 0, 91, 91, 163403],
    '1': [0, 13, 91, 91, 150793],
    '-2': [6, 0, 91, 91, 171151],
    '0.25': [2, 5, 91, 91, 156684],
    '20': [0, 14, 91, 91, 150864],
  },
  'scale(2, 0.5), rotate, setTransform': {
    '0.7': [2, 8, 90, 50, 93465],
    'π/2': [0, 8, 89, 51, 87715],
    π: [0, 0, 90, 50, 71461],
    '1e10': [18, 2, 90, 50, 72157],
    '1': [0, 8, 90, 50, 91934],
    '-2': [18, 0, 90, 49, 63014],
    '0.25': [18, 8, 89, 50, 76603],
    '20': [0, 8, 89, 50, 88909],
  },
}

for (const [scene, byAngle] of Object.entries(EXPECTED)) {
  test(`rotate() keeps the path in place: ${scene}`, (t) => {
    for (const [label, expected] of Object.entries(byAngle)) {
      const ctx = createCanvas(100, 100).getContext('2d')
      SCENES[scene](ctx, ANGLES[label])
      t.deepEqual(ink(ctx), expected, `rotate(${label})`)
    }
  })
}

test('isPointInPath() after rotate() tests the path where it was drawn', (t) => {
  // Chrome 156: the rect stays at (30, 30)-(55, 45) for every angle.
  const points = [
    [31, 31],
    [54, 44],
    [42, 37],
    [29, 29],
    [56, 46],
    [42, 20],
  ]
  for (const [label, a] of Object.entries(ANGLES)) {
    const ctx = createCanvas(100, 100).getContext('2d')
    ctx.rect(30, 30, 25, 15)
    ctx.rotate(a)
    t.deepEqual(
      points.map(([x, y]) => ctx.isPointInPath(x, y)),
      [true, true, true, false, false, false],
      `rotate(${label})`,
    )
  }
})

test('rotate() turns the canvas by ClampTo<float>(RadToDeg(angle)) degrees', (t) => {
  // Chrome 156 converts with a double pi (angle_conversions.h:21); a float pi
  // (Chrome 155) gives f32 degrees one ulp off for about a third of angles,
  // which shows far from the origin. [x0, y0, x1, y1, alpha sum] of a 40 x 40
  // square drawn R pixels out along the rotated x axis.
  const cases: [number, number, number[]][] = [
    [1, 1e6, [22, 22, 77, 77, 407339]],
    [2, 1e6, [23, 23, 76, 76, 407128]],
    [-2, 1e6, [23, 23, 76, 76, 407824]],
    [20, 1e6, [23, 23, 76, 76, 408355]],
    [-20, 1e6, [23, 23, 76, 76, 408363]],
    [100, 1e5, [22, 22, 77, 77, 407505]],
  ]
  for (const [a, r, expected] of cases) {
    const ctx = createCanvas(100, 100).getContext('2d')
    ctx.translate(50, 50)
    ctx.rotate(a)
    ctx.translate(-r, 0)
    ctx.fillRect(r - 20, -20, 40, 40)
    t.deepEqual(ink(ctx), expected, `rotate(${a}), ${r} out`)
  }
})
