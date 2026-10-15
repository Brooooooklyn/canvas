// The current path keeps its device position when the matrix changes, and a
// singular matrix follows Blink's model (canvas_2d_recorder_context.cc
// scale/rotate/translate/transform/resetTransform/setTransform/PopStateStack,
// canvas_path.cc). Every expected value was measured in Chrome 155 CPU canvas
// (--disable-gpu, getContext('2d', { willReadFrequently: true })) in a
// standards-mode page; Chrome arm64 and x64 give the same values.
import test from 'ava'

import { createCanvas, DOMMatrix, Path2D } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

/** Bounding box [x0, y0, x1, y1] of the pixels with alpha > 0 (null if none) and the alpha sum. */
function ink(ctx: Ctx) {
  const { width, height } = ctx.canvas
  const d = ctx.getImageData(0, 0, width, height).data
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  let sum = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = d[(y * width + x) * 4 + 3]
      sum += a
      if (a) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
    }
  }
  return { box: x1 < 0 ? null : [x0, y0, x1, y1], sum }
}

const matrixOf = (ctx: Ctx) => {
  const m = ctx.getTransform()
  return [m.a, m.b, m.c, m.d, m.e, m.f]
}

/** Runs `f` on a new 100x60 canvas (default black fill). */
function scene(f: (ctx: Ctx) => unknown, width = 100, height = 60) {
  const ctx = createCanvas(width, height).getContext('2d')
  const extra = f(ctx)
  return { ...ink(ctx), extra: extra === undefined ? null : extra, m: matrixOf(ctx) }
}

const box = (f: (ctx: Ctx) => unknown, width?: number, height?: number) => {
  const { box, sum } = scene(f, width, height)
  return { box, sum }
}

const SQUARE = { box: [0, 0, 9, 9], sum: 25500 }

test('setTransform() keeps the current path where it was drawn', (t) => {
  t.deepEqual(
    box((ctx) => {
      ctx.rect(0, 0, 10, 10)
      ctx.setTransform(1, 0, 0, 1, 50, 0)
      ctx.fill()
    }),
    SQUARE,
  )
  t.deepEqual(
    box((ctx) => {
      ctx.rect(0, 0, 10, 10)
      ctx.setTransform(new DOMMatrix([1, 0, 0, 1, 50, 0]))
      ctx.fill()
    }),
    SQUARE,
  )
})

test('resetTransform() keeps the current path where it was drawn', (t) => {
  t.deepEqual(
    box((ctx) => {
      ctx.translate(50, 0)
      ctx.rect(0, 0, 10, 10)
      ctx.resetTransform()
      ctx.fill()
    }),
    { box: [50, 0, 59, 9], sum: 25500 },
  )
})

test('stroke after setTransform() uses the new matrix for the pen only', (t) => {
  t.deepEqual(
    box((ctx) => {
      ctx.moveTo(5, 20)
      ctx.lineTo(45, 20)
      ctx.setTransform(1, 0, 0, 4, 0, 0)
      ctx.lineWidth = 2
      ctx.stroke()
    }),
    { box: [5, 16, 44, 23], sum: 81600 },
  )
  // The stroke is 8 device pixels tall.
  t.deepEqual(
    scene((ctx) => {
      ctx.moveTo(10, 20)
      ctx.lineTo(90, 20)
      ctx.setTransform(1, 0, 0, 8, 0, 0)
      ctx.lineWidth = 2
      return [ctx.isPointInStroke(50, 27), ctx.isPointInStroke(50, 12), ctx.isPointInStroke(50, 29)]
    }).extra,
    [true, true, false],
  )
})

test('isPointInPath/isPointInStroke see the path where it was drawn after setTransform()', (t) => {
  t.deepEqual(
    scene((ctx) => {
      ctx.rect(0, 0, 10, 10)
      ctx.setTransform(1, 0, 0, 1, 50, 0)
      return [ctx.isPointInPath(5, 5), ctx.isPointInPath(55, 5)]
    }).extra,
    [true, false],
  )
  t.deepEqual(
    scene((ctx) => {
      ctx.rect(0, 0, 10, 10)
      ctx.setTransform(1, 0, 0, 1, 50, 0)
      return [ctx.isPointInStroke(0, 5), ctx.isPointInStroke(50, 5)]
    }).extra,
    [true, false],
  )
})

test('clip() after setTransform() clips where the path was drawn', (t) => {
  t.deepEqual(
    box((ctx) => {
      ctx.rect(0, 0, 10, 10)
      ctx.setTransform(1, 0, 0, 1, 50, 0)
      ctx.clip()
      ctx.resetTransform()
      ctx.fillRect(0, 0, 100, 60)
    }),
    SQUARE,
  )
})

test('setTransform() after scale/rotate keeps device positions', (t) => {
  t.deepEqual(
    box((ctx) => {
      ctx.scale(2, 2)
      ctx.rect(0, 0, 10, 10)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fill()
    }),
    { box: [0, 0, 19, 19], sum: 102000 },
  )
  t.deepEqual(
    box((ctx) => {
      ctx.translate(30, 10)
      ctx.rotate(0.5)
      ctx.rect(0, 0, 20, 10)
      ctx.setTransform(2, 0, 0, 2, 0, 0)
      ctx.fill()
    }),
    { box: [25, 10, 47, 28], sum: 50815 },
  )
  t.deepEqual(
    box((ctx) => {
      ctx.moveTo(10, 10)
      ctx.lineTo(30, 10)
      ctx.setTransform(1, 0, 0, 1, 40, 0)
      ctx.lineTo(0, 30)
      ctx.closePath()
      ctx.resetTransform()
      ctx.fill()
    }),
    { box: [10, 10, 39, 29], sum: 51010 },
  )
  t.deepEqual(
    box((ctx) => {
      ctx.translate(30, 10)
      ctx.rotate(0.4)
      ctx.rect(0, 0, 30, 15)
      ctx.setTransform(0.5, 0.3, -0.2, 1.5, 7, 3)
      ctx.fill()
    }),
    { box: [24, 10, 57, 35], sum: 114356 },
  )
})

test('a singular matrix leaves the path in the last invertible space', (t) => {
  for (const [name, f] of [
    ['scale(0, 1)', () => {}],
    ['scale(0, 1), scale(3, 3)', (ctx: Ctx) => ctx.scale(3, 3)],
    ['scale(0, 1), rotate(1)', (ctx: Ctx) => ctx.rotate(1)],
    ['scale(0, 1), transform(2, 0, 0, 2, 5, 5)', (ctx: Ctx) => ctx.transform(2, 0, 0, 2, 5, 5)],
  ] as const) {
    // The path drawn at 2x stays in the 2x user space under the singular
    // matrix, and resetTransform() does not map it out of a singular one.
    t.deepEqual(
      box((ctx) => {
        ctx.scale(2, 2)
        ctx.rect(0, 0, 10, 10)
        ctx.scale(0, 1)
        f(ctx)
        ctx.resetTransform()
        ctx.fill()
      }),
      SQUARE,
      name,
    )
  }
  t.deepEqual(
    scene((ctx) => {
      ctx.rect(0, 0, 10, 10)
      ctx.setTransform(0, 0, 0, 0, 0, 0)
      ctx.setTransform(1, 0, 0, 1, 20, 0)
      ctx.fill()
    }),
    { ...SQUARE, extra: null, m: [1, 0, 0, 1, 20, 0] },
  )
  // The new invertible matrix still maps the path into its space.
  t.deepEqual(
    scene((ctx) => {
      ctx.rect(0, 0, 10, 10)
      ctx.setTransform(0, 0, 0, 0, 0, 0)
      ctx.setTransform(2, 0, 0, 2, 0, 0)
      ctx.fill()
    }),
    { ...SQUARE, extra: null, m: [2, 0, 0, 2, 0, 0] },
  )
})

test('rect/arc/ellipse/roundRect add nothing under a singular matrix', (t) => {
  for (const [name, f] of [
    ['rect', (ctx: Ctx) => ctx.rect(20, 0, 10, 10)],
    ['arc', (ctx: Ctx) => ctx.arc(50, 30, 10, 0, 6.3)],
    ['ellipse', (ctx: Ctx) => ctx.ellipse(50, 30, 10, 5, 0, 0, 6.3)],
    ['roundRect', (ctx: Ctx) => ctx.roundRect(40, 20, 20, 20, 5)],
  ] as const) {
    t.deepEqual(
      box((ctx) => {
        ctx.rect(0, 0, 10, 10)
        ctx.scale(0, 0)
        f(ctx)
        ctx.resetTransform()
        ctx.fill()
      }),
      SQUARE,
      name,
    )
  }
})

test('moveTo/lineTo/curves/arcTo map their points through a singular matrix', (t) => {
  // setTransform(0, 0, 0, 0, 5, 40) puts every new point at (5, 40).
  const mapped = (f: (ctx: Ctx) => void) =>
    box((ctx) => {
      ctx.moveTo(0, 0)
      ctx.lineTo(30, 0)
      ctx.setTransform(0, 0, 0, 0, 5, 40)
      f(ctx)
      ctx.resetTransform()
      ctx.fill()
    })
  t.deepEqual(
    mapped((ctx) => ctx.lineTo(30, 30)),
    { box: [0, 0, 29, 39], sum: 153030 },
  )
  t.deepEqual(
    mapped((ctx) => ctx.bezierCurveTo(1, 2, 3, 4, 5, 6)),
    { box: [0, 0, 29, 39], sum: 153147 },
  )
  t.deepEqual(
    mapped((ctx) => ctx.quadraticCurveTo(1, 2, 3, 4)),
    { box: [0, 0, 29, 39], sum: 153051 },
  )
  t.deepEqual(
    mapped((ctx) => ctx.arcTo(1, 2, 3, 4, 5)),
    { box: [0, 0, 29, 39], sum: 153030 },
  )
  t.deepEqual(
    box((ctx) => {
      ctx.setTransform(0, 0, 0, 0, 20, 20)
      ctx.moveTo(30, 30)
      ctx.resetTransform()
      ctx.lineTo(60, 20)
      ctx.lineTo(60, 40)
      ctx.fill()
    }),
    { box: [20, 20, 59, 39], sum: 102000 },
  )
  // A degenerate arcTo becomes lineTo(x1, y1), mapped once.
  t.deepEqual(
    box((ctx) => {
      ctx.moveTo(0, 0)
      ctx.lineTo(60, 0)
      ctx.setTransform(0, 0, 0, 0, 30, 50)
      ctx.arcTo(5, 5, 5, 5, 3)
      ctx.resetTransform()
      ctx.fill()
    }),
    { box: [0, 0, 59, 49], sum: 382530 },
  )
  t.deepEqual(
    box((ctx) => {
      ctx.moveTo(10, 10)
      ctx.lineTo(50, 10)
      ctx.lineTo(50, 40)
      ctx.closePath()
      ctx.setTransform(0, 0, 0, 0, 90, 50)
      ctx.lineTo(0, 0)
      ctx.resetTransform()
      ctx.lineTo(10, 50)
      ctx.fill()
    }),
    { box: [10, 10, 89, 49], sum: 509985 },
  )
})

test('an empty path starts curves at their unmapped first point under a singular matrix', (t) => {
  // canvas_path.cc: the implicit moveTo of an empty path uses the control
  // point as given; the rest is mapped to (40, 30).
  const empty = (f: (ctx: Ctx) => void) =>
    box((ctx) => {
      ctx.setTransform(0, 0, 0, 0, 40, 30)
      f(ctx)
    })
  t.deepEqual(
    empty((ctx) => {
      ctx.quadraticCurveTo(10, 10, 90, 50)
      ctx.resetTransform()
      ctx.lineTo(90, 5)
      ctx.fill()
    }),
    { box: [10, 5, 89, 29], sum: 223098 },
  )
  t.deepEqual(
    empty((ctx) => {
      ctx.bezierCurveTo(10, 10, 20, 20, 90, 50)
      ctx.resetTransform()
      ctx.lineTo(90, 5)
      ctx.fill()
    }),
    { box: [10, 5, 89, 29], sum: 222882 },
  )
  t.deepEqual(
    empty((ctx) => {
      ctx.arcTo(10, 10, 90, 50, 5)
      ctx.resetTransform()
      ctx.lineTo(90, 5)
      ctx.lineTo(10, 50)
      ctx.fill()
    }),
    { box: [10, 5, 89, 49], sum: 31830 },
  )
})

test('restore() out of a singular matrix keeps the path', (t) => {
  t.deepEqual(
    box((ctx) => {
      ctx.rect(0, 0, 10, 10)
      ctx.save()
      ctx.scale(0, 1)
      ctx.restore()
      ctx.fill()
    }),
    SQUARE,
  )
  t.deepEqual(
    box((ctx) => {
      ctx.save()
      ctx.scale(2, 2)
      ctx.rect(0, 0, 10, 10)
      ctx.scale(0, 1)
      ctx.restore()
      ctx.fill()
    }),
    SQUARE,
  )
  // The lineTo under the singular matrix lands at (0, 0) of the 2x space.
  t.deepEqual(
    scene((ctx) => {
      ctx.scale(2, 2)
      ctx.rect(0, 0, 10, 10)
      ctx.save()
      ctx.scale(0, 1)
      ctx.lineTo(40, 25)
      ctx.restore()
      ctx.fill()
    }),
    { ...SQUARE, extra: null, m: [2, 0, 0, 2, 0, 0] },
  )
  t.deepEqual(
    box((ctx) => {
      ctx.save()
      ctx.translate(20, 10)
      ctx.rect(0, 0, 10, 10)
      ctx.transform(1, 1, 1, 1, 0, 0)
      ctx.rotate(0.7)
      ctx.restore()
      ctx.fill()
    }),
    SQUARE,
  )
})

test('translate() is a no-op under a singular matrix', (t) => {
  t.deepEqual(
    scene((ctx) => {
      ctx.scale(0, 1)
      ctx.translate(10, 10)
    }).m,
    [0, 0, 0, 1, 0, 0],
  )
  t.deepEqual(
    scene((ctx) => {
      ctx.scale(0, 1)
      ctx.scale(3, 3)
    }).m,
    [0, 0, 0, 3, 0, 0],
  )
  t.deepEqual(
    scene((ctx) => {
      ctx.setTransform(0, 0, 0, 0, 3, 4)
      ctx.translate(10, 10)
      ctx.rotate(0.5)
      ctx.scale(2, 3)
    }).m,
    [0, 0, 0, 0, 3, 4],
  )
})

test('isPointInPath/isPointInStroke are false under a singular matrix', (t) => {
  t.deepEqual(
    scene((ctx) => {
      ctx.rect(0, 0, 10, 10)
      ctx.scale(0, 1)
      return [ctx.isPointInPath(5, 5), ctx.isPointInPath(0, 5), ctx.isPointInStroke(0, 5)]
    }).extra,
    [false, false, false],
  )
  t.deepEqual(
    scene((ctx) => {
      const p = new Path2D()
      p.rect(0, 0, 10, 10)
      ctx.scale(0, 1)
      return [ctx.isPointInPath(p, 5, 5), ctx.isPointInPath(p, 0, 5), ctx.isPointInStroke(p, 0, 5)]
    }).extra,
    [false, false, false],
  )
})

test('clip() is a no-op under a singular matrix', (t) => {
  t.deepEqual(
    box((ctx) => {
      ctx.rect(0, 0, 10, 10)
      ctx.scale(0, 0)
      ctx.clip()
      ctx.resetTransform()
      ctx.fillRect(0, 0, 100, 60)
    }),
    { box: [0, 0, 99, 59], sum: 1530000 },
  )
  // Also inside a clipped level, with a mid-frame read.
  for (const read of [false, true]) {
    const ctx = createCanvas(48, 48).getContext('2d')
    ctx.save()
    ctx.beginPath()
    ctx.arc(24, 24, 16, 0, 7)
    ctx.clip()
    ctx.save()
    ctx.scale(0, 1)
    ctx.beginPath()
    ctx.rect(0, 0, 5, 5)
    ctx.clip()
    ctx.restore()
    ctx.fillStyle = 'red'
    ctx.fillRect(0, 0, 48, 48)
    if (read) ctx.getImageData(0, 0, 1, 1)
    ctx.restore()
    ctx.fillStyle = 'rgba(0,0,255,0.4)'
    ctx.fillRect(0, 0, 48, 48)
    const data = ctx.getImageData(0, 0, 48, 48).data
    const sums = [0, 0, 0, 0]
    for (let i = 0; i < data.length; i++) sums[i & 3] += data[i]
    t.deepEqual(sums, [124215, 0, 463305, 357273], `read: ${read}`)
  }
})

test('near-singular scales are still invertible', (t) => {
  for (const s of [1e-30, 1e-20]) {
    t.deepEqual(
      box((ctx) => {
        ctx.rect(0, 0, 10, 10)
        ctx.scale(s, s)
        ctx.resetTransform()
        ctx.fill()
      }),
      SQUARE,
      String(s),
    )
  }
  t.deepEqual(
    scene((ctx) => {
      ctx.rect(0, 0, 10, 10)
      ctx.setTransform(1e-20, 0, 0, 1e-20, 0, 0)
      ctx.setTransform(1, 0, 0, 1, 30, 0)
      ctx.fill()
    }),
    { ...SQUARE, extra: null, m: [1, 0, 0, 1, 30, 0] },
  )
})

test('restore() maps the path back', (t) => {
  t.deepEqual(
    box((ctx) => {
      ctx.save()
      ctx.translate(30, 0)
      ctx.rect(0, 0, 10, 10)
      ctx.restore()
      ctx.fill()
    }),
    { box: [30, 0, 39, 9], sum: 25500 },
  )
  t.deepEqual(
    box((ctx) => {
      ctx.save()
      ctx.scale(3, 2)
      ctx.rect(0, 0, 10, 10)
      ctx.restore()
      ctx.fill()
    }),
    { box: [0, 0, 29, 19], sum: 153000 },
  )
})

test('an empty path still starts curves at their first control point', (t) => {
  const stroke = (f: (ctx: Ctx) => void) =>
    box(
      (ctx) => {
        f(ctx)
        ctx.lineWidth = 2
        ctx.stroke()
      },
      60,
      60,
    )
  t.deepEqual(
    stroke((ctx) => {
      ctx.lineTo(10, 10)
      ctx.lineTo(50, 10)
    }),
    { box: [10, 9, 49, 10], sum: 20400 },
  )
  t.deepEqual(
    stroke((ctx) => ctx.quadraticCurveTo(10, 50, 50, 50)),
    { box: [10, 49, 49, 50], sum: 20400 },
  )
  t.deepEqual(
    stroke((ctx) => ctx.bezierCurveTo(10, 50, 30, 10, 50, 50)),
    { box: [9, 31, 50, 50], sum: 27793 },
  )
  t.deepEqual(
    stroke((ctx) => {
      ctx.arcTo(10, 10, 50, 10, 5)
      ctx.lineTo(50, 50)
    }),
    { box: [9, 9, 50, 50], sum: 29320 },
  )
})

test('fill(path) under a singular matrix draws nothing; the Path2D is unchanged', (t) => {
  t.deepEqual(
    box((ctx) => {
      const p = new Path2D()
      p.rect(0, 0, 10, 10)
      ctx.scale(0, 1)
      ctx.fill(p)
      ctx.resetTransform()
      ctx.fill(p)
    }),
    SQUARE,
  )
})
