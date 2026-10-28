// The one-point stroke prune for every path. Chrome strokes nothing for a path
// whose bounds are one point (DrawPathInternal, canvas_2d_recorder_context.cc:
// 1595-1602 m156), for stroke() and stroke(path) alike, whatever calls built
// the path: the HTML spec also removes "subpaths with just one point" before
// stroking. Its closePath() empties a path that is one zero-length line
// (CanvasPath::closePath, canvas_path.cc:76-93). fill(), clip() and
// isPointInStroke() have no such prune. We did both only for paths built with
// arc(), ellipse(), arcTo(), rect() or roundRect(), and drew a cap dot for the
// others. Pixel counts are pixels with alpha > 0, pinned to Chrome
// 156.0.8078.48 CPU canvas (--disable-gpu, getContext('2d',
// { willReadFrequently: true })).
import test from 'ava'

import { createCanvas, Path2D } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>
type Target = Ctx | InstanceType<typeof Path2D>

const ctx = createCanvas(100, 100).getContext('2d')

function countPainted() {
  const data = ctx.getImageData(0, 0, 100, 100).data
  let n = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]) n++
  }
  return n
}

// lineWidth 20 butt, round, square; lineWidth 1 round, square; lineWidth 20
// round with a shadow; with setLineDash([5, 5]); under scale(0.5); lineWidth 10
// with setLineDash([0, 12]) and round, square caps.
const STYLES: (() => void)[] = [
  ...(
    [
      [20, 'butt'],
      [20, 'round'],
      [20, 'square'],
      [1, 'round'],
      [1, 'square'],
    ] as const
  ).map(([lineWidth, cap]) => () => {
    ctx.lineWidth = lineWidth
    ctx.lineCap = cap
  }),
  () => {
    ctx.lineWidth = 20
    ctx.lineCap = 'round'
    ctx.shadowColor = 'blue'
    ctx.shadowOffsetX = 20
    ctx.shadowOffsetY = 20
  },
  () => {
    ctx.lineWidth = 20
    ctx.lineCap = 'round'
    ctx.setLineDash([5, 5])
  },
  () => {
    ctx.scale(0.5, 0.5)
    ctx.lineWidth = 20
    ctx.lineCap = 'round'
  },
  ...(['round', 'square'] as const).map((cap) => () => {
    ctx.lineWidth = 10
    ctx.lineCap = cap
    ctx.setLineDash([0, 12])
  }),
]
const NONE = STYLES.map(() => 0)

/** Stroke counts for the path on the context, as a Path2D and as a copy. */
function strokes(build: (t: Target) => void) {
  const out: Record<string, number[]> = {}
  for (const api of ['ctx', 'Path2D', 'addPath']) {
    out[api] = STYLES.map((setup) => {
      ctx.reset()
      setup()
      ctx.beginPath()
      if (api === 'ctx') {
        build(ctx)
        ctx.stroke()
      } else {
        const path = new Path2D()
        build(path)
        if (api === 'Path2D') {
          ctx.stroke(path)
        } else {
          const copy = new Path2D()
          copy.addPath(path)
          ctx.stroke(copy)
        }
      }
      return countPainted()
    })
  }
  return out
}

const same = (counts: number[]) => ({ ctx: counts, Path2D: counts, addPath: counts })

test('a one-point path of lines, closePath and curves strokes nothing', (t) => {
  const cases: Record<string, (t: Target) => void> = {
    'L p L p': (c) => {
      c.lineTo(50, 50)
      c.lineTo(50, 50)
    },
    'M p L p L p': (c) => {
      c.moveTo(50, 50)
      c.lineTo(50, 50)
      c.lineTo(50, 50)
    },
    'M p L p M p L p': (c) => {
      c.moveTo(50, 50)
      c.lineTo(50, 50)
      c.moveTo(50, 50)
      c.lineTo(50, 50)
    },
    'M p L p M q': (c) => {
      c.moveTo(50, 50)
      c.lineTo(50, 50)
      c.moveTo(80, 20)
    },
    'M p C p p p Z': (c) => {
      c.moveTo(50, 50)
      c.bezierCurveTo(50, 50, 50, 50, 50, 50)
      c.closePath()
    },
    // Not on the pixel grid.
    'M p L p at (50.3, 50.7)': (c) => {
      c.moveTo(50.3, 50.7)
      c.lineTo(50.3, 50.7)
    },
  }
  for (const [name, build] of Object.entries(cases)) {
    t.deepEqual(strokes(build), same(NONE), name)
  }
})

test('a Path2D from an SVG path string that is one point strokes nothing', (t) => {
  for (const d of ['M50 50L50 50', 'M50 50Z', 'M50 50L50 50Z', 'M50 50C50 50 50 50 50 50']) {
    t.deepEqual(
      STYLES.map((setup) => {
        ctx.reset()
        setup()
        ctx.stroke(new Path2D(d))
        return countPainted()
      }),
      NONE,
      d,
    )
  }
})

test('a path whose bounds are not one point keeps its dots', (t) => {
  // Two dots: the bounds are (20, 50) to (50, 80).
  t.deepEqual(
    strokes((c) => {
      c.moveTo(50, 50)
      c.lineTo(50, 50)
      c.moveTo(20, 80)
      c.lineTo(20, 80)
    }),
    same([0, 672, 800, 8, 8, 1174, 0, 176, 0, 0]),
  )
  // A line 1e-5 long, which float keeps: Chrome strokes its caps.
  t.deepEqual(
    strokes((c) => {
      c.moveTo(50, 50)
      c.lineTo(50, 50.00001)
    }),
    same([0, 338, 400, 4, 4, 676, 338, 90, 90, 100]),
  )
  // Zero-length dashes on a line: the bounds are the line, so each dash
  // draws its caps (the last two counts).
  t.deepEqual(
    strokes((c) => {
      c.moveTo(10, 10)
      c.lineTo(30, 10)
    }),
    same([400, 736, 800, 44, 44, 1472, 636, 190, 176, 200]),
  )
})

test('closePath empties a path that is one zero-length line, whatever built it', (t) => {
  const LINE = [400, 736, 800, 44, 44, 1472, 636, 190, 176, 200]
  const cases: Record<string, [(t: Target) => void, number[], string]> = {
    'M p L p Z': [
      (c) => {
        c.moveTo(50, 50)
        c.lineTo(50, 50)
        c.closePath()
      },
      NONE,
      '',
    ],
    'M p L p Z Z': [
      (c) => {
        c.moveTo(50, 50)
        c.lineTo(50, 50)
        c.closePath()
        c.closePath()
      },
      NONE,
      '',
    ],
    // The second line starts on an empty path again.
    'M p L p Z M p L p Z': [
      (c) => {
        c.moveTo(50, 50)
        c.lineTo(50, 50)
        c.closePath()
        c.moveTo(50, 50)
        c.lineTo(50, 50)
        c.closePath()
      },
      NONE,
      '',
    ],
    // lineTo(80, 20) on the empty path is one point.
    'M p L p Z L q': [
      (c) => {
        c.moveTo(50, 50)
        c.lineTo(50, 50)
        c.closePath()
        c.lineTo(80, 20)
      },
      NONE,
      'M80 20L80 20',
    ],
    'M p L p Z, line': [
      (c) => {
        c.moveTo(50, 50)
        c.lineTo(50, 50)
        c.closePath()
        c.moveTo(10, 10)
        c.lineTo(30, 10)
      },
      LINE,
      'M10 10L30 10',
    ],
    // A lone moveTo is not a line: closePath keeps it, and lineTo(80, 20)
    // draws from p.
    'M p Z L q': [
      (c) => {
        c.moveTo(50, 50)
        c.closePath()
        c.lineTo(80, 20)
      },
      [884, 1206, 1432, 63, 65, 2249, 1217, 313, 366, 438],
      'M50 50ZM50 50L80 20',
    ],
  }
  for (const [name, [build, expected, svg]] of Object.entries(cases)) {
    t.deepEqual(strokes(build), same(expected), name)
    const path = new Path2D()
    build(path)
    t.is(path.toSVGString(), svg, name)
  }
  // isPointInPath() builds Blink's PathBuilder (GetPath), so closePath keeps
  // moveTo(p) and lineTo(80, 20) draws the line from p.
  t.deepEqual(
    STYLES.map((setup) => {
      ctx.reset()
      setup()
      ctx.beginPath()
      ctx.moveTo(50, 50)
      ctx.lineTo(50, 50)
      ctx.isPointInPath(0, 0)
      ctx.closePath()
      ctx.lineTo(80, 20)
      ctx.stroke()
      return countPainted()
    }),
    [884, 1206, 1405, 62, 64, 2252, 1217, 315, 366, 438],
  )
})

test('fill, clip and isPointInStroke of a one-point path are not pruned', (t) => {
  const build = (c: Target) => {
    c.moveTo(50, 50)
    c.lineTo(50, 50)
  }
  // isPointInStroke still sees the round cap (lineWidth 20).
  ctx.reset()
  ctx.lineWidth = 20
  ctx.lineCap = 'round'
  ctx.beginPath()
  build(ctx)
  t.true(ctx.isPointInStroke(50, 45))
  const path = new Path2D()
  build(path)
  t.true(ctx.isPointInStroke(path, 50, 45))
  t.false(ctx.isPointInStroke(path, 50, 30))
  // A one-point path has no area: fill paints nothing and clip keeps nothing.
  ctx.reset()
  ctx.beginPath()
  build(ctx)
  ctx.fill()
  ctx.fill(path)
  t.is(countPainted(), 0)
  ctx.reset()
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 100, 100)
  ctx.clip(path)
  ctx.fillStyle = 'blue'
  ctx.fillRect(0, 0, 100, 100)
  const data = ctx.getImageData(0, 0, 100, 100).data
  t.deepEqual([data[0], data[2], data[20202], data[20200]], [255, 0, 0, 255])
})
