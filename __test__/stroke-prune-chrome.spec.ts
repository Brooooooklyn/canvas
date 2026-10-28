// One-point paths. Chrome strokes nothing for a path whose bounds are one
// point (DrawPathInternal, canvas_2d_recorder_context.cc:1595-1602 m156): no
// caps, no shadow, no dash. Its closePath() also empties a path that is one
// moveTo plus one zero-length lineTo (CanvasPath::closePath, canvas_path.cc:
// 76-93). We do both only for a path built with arc(), ellipse(), arcTo(),
// rect() or roundRect(). pdf.js strokes PDF dots ('x y m x y l S',
// 'x y m h S') as moveTo, lineTo, closePath and curves only, and needs them
// (ISO 32000 8.5.3.2, mozilla/pdf.js#22040); Firefox and Chrome 151 draw them
// too. Pixel counts are pixels with alpha > 0, pinned to Chrome 156 CPU canvas
// (--disable-gpu, getContext('2d', { willReadFrequently: true })).
import test from 'ava'

import { createCanvas, Path2D } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>
type Target = Ctx | InstanceType<typeof Path2D>
type Build = (t: Target) => void

const TAU = 2 * Math.PI
const ctx = createCanvas(100, 100).getContext('2d')

function countPainted() {
  const data = ctx.getImageData(0, 0, 100, 100).data
  let n = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]) n++
  }
  return n
}

// The path on the context, as a Path2D, and as a Path2D copied in with
// addPath().
const APIS = ['ctx', 'Path2D', 'addPath'] as const

function stroke(api: (typeof APIS)[number], build: Build, setup: () => void) {
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
}

// [lineWidth 20 butt, round, square, lineWidth 1 round, square,
//  lineWidth 20 round with a shadow, with a dash]
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
]

function counts(build: Build) {
  return Object.fromEntries(APIS.map((api) => [api, STYLES.map((setup) => stroke(api, build, setup))]))
}

function expectCounts(t: import('ava').ExecutionContext, cases: Record<string, [Build, number[]]>) {
  for (const [name, [build, expected]] of Object.entries(cases)) {
    t.deepEqual(counts(build), Object.fromEntries(APIS.map((api) => [api, expected])), name)
  }
}

const arc0 = (t: Target, x = 50, y = 50) => t.arc(x, y, 0, 0, TAU)
const ell00 = (t: Target) => t.ellipse(50, 50, 0, 0, 0, 0, TAU)
// In float, π/2 to 5π/2 anticlockwise puts every point on (50, 90).
const collapsed = (t: Target) => t.ellipse(50, 50, 0, 40, 0, Math.PI / 2, (5 * Math.PI) / 2, true)
const zeroSweep = (t: Target) => t.ellipse(50, 50, 30, 20, 0, 1, 1)
const line = (t: Target) => {
  t.moveTo(10, 10)
  t.lineTo(30, 10)
}

const NONE = [0, 0, 0, 0, 0, 0, 0]
// moveTo(10, 10) lineTo(30, 10) alone, and with a round dot at (50, 50).
const LINE = [400, 736, 800, 44, 44, 1472, 636]
const LINE_AND_DOT = [400, 1072, 1200, 48, 48, 2142, 636]

test('a one-point path from arc(), ellipse(), arcTo(), rect() or roundRect() strokes nothing', (t) => {
  expectCounts(t, {
    'arc(p, 0) twice': [
      (c) => {
        arc0(c)
        arc0(c)
      },
      NONE,
    ],
    'moveTo(p), arc(p, 0)': [
      (c) => {
        c.moveTo(50, 50)
        arc0(c)
      },
      NONE,
    ],
    'lineTo(p), arc(p, 0)': [
      (c) => {
        c.lineTo(50, 50)
        arc0(c)
      },
      NONE,
    ],
    'ellipse radii 0 twice': [
      (c) => {
        ell00(c)
        ell00(c)
      },
      NONE,
    ],
    'moveTo(p), ellipse radii 0': [
      (c) => {
        c.moveTo(50, 50)
        ell00(c)
      },
      NONE,
    ],
    'collapsed ellipse': [collapsed, NONE],
    'moveTo, collapsed ellipse': [
      (c) => {
        c.moveTo(50, 90)
        collapsed(c)
      },
      NONE,
    ],
    'zero-sweep ellipse': [zeroSweep, NONE],
    'arc(50, 50, 10, 1, 1) twice': [
      (c) => {
        c.arc(50, 50, 10, 1, 1)
        c.arc(50, 50, 10, 1, 1)
      },
      NONE,
    ],
    'moveTo(60, 50), arc(50, 50, 10, 0, 0)': [
      (c) => {
        c.moveTo(60, 50)
        c.arc(50, 50, 10, 0, 0)
      },
      NONE,
    ],
    'pie slice of radius 0, three times': [
      (c) => {
        for (let i = 0; i < 3; i++) {
          c.moveTo(50, 50)
          c.arc(50, 50, 0, i, i + 1)
          c.closePath()
        }
      },
      NONE,
    ],
    'moveTo(p), arcTo(p, p, 10)': [
      (c) => {
        c.moveTo(50, 50)
        c.arcTo(50, 50, 50, 50, 10)
      },
      NONE,
    ],
    'moveTo(p), arcTo(p, q, 10)': [
      (c) => {
        c.moveTo(50, 50)
        c.arcTo(50, 50, 80, 20, 10)
      },
      NONE,
    ],
    'arcTo on an empty path': [(c) => c.arcTo(50, 50, 80, 20, 10), NONE],
    'rect(p, 0, 0)': [(c) => c.rect(50, 50, 0, 0), NONE],
    'rect(p, 0, 0), lineTo(p)': [
      (c) => {
        c.rect(50, 50, 0, 0)
        c.lineTo(50, 50)
      },
      NONE,
    ],
    'roundRect(p, 0, 0, 5)': [(c) => c.roundRect(50, 50, 0, 0, 5), NONE],
  })
})

test('a one-point path of moveTo, lineTo, closePath and curves keeps its dot for pdf.js', (t) => {
  // Chrome 156 strokes all of these as 0 px. pdf.js draws a PDF dot
  // ('x y m x y l S', 'x y m h S', '0 0 re S', 'x y m x y x y x y c S') with
  // exactly these calls, so they keep the cap dot that Firefox, Chrome 151,
  // Acrobat and the PDF spec draw (ISO 32000 8.5.3.2, mozilla/pdf.js#22040).
  const DOT = [0, 338, 400, 4, 4, 676, 338]
  // A dash keeps no part of a zero-length closed contour or curve.
  const CLOSED_DOT = [0, 338, 400, 4, 4, 676, 0]
  expectCounts(t, {
    'M p L p': [
      (c) => {
        c.moveTo(50, 50)
        c.lineTo(50, 50)
      },
      DOT,
    ],
    'L p': [(c) => c.lineTo(50, 50), DOT],
    'M p Z': [
      (c) => {
        c.moveTo(50, 50)
        c.closePath()
      },
      CLOSED_DOT,
    ],
    'M p L p Z': [
      (c) => {
        c.moveTo(50, 50)
        c.lineTo(50, 50)
        c.closePath()
      },
      CLOSED_DOT,
    ],
    'M p C p p p': [
      (c) => {
        c.moveTo(50, 50)
        c.bezierCurveTo(50, 50, 50, 50, 50, 50)
      },
      CLOSED_DOT,
    ],
    'M p Q p p': [
      (c) => {
        c.moveTo(50, 50)
        c.quadraticCurveTo(50, 50, 50, 50)
      },
      CLOSED_DOT,
    ],
  })
  // pdf.js rescaleAndStroke copies the path in with addPath(path, matrix).
  const path = new Path2D()
  path.moveTo(25, 25)
  path.lineTo(25, 25)
  const scaled = new Path2D()
  scaled.addPath(path, { a: 2, d: 2 })
  ctx.reset()
  ctx.lineWidth = 20
  ctx.lineCap = 'round'
  ctx.stroke(scaled)
  t.is(countPainted(), 338)
})

test('a lone point next to another subpath keeps the dot Blink gives it', (t) => {
  expectCounts(t, {
    'arc(p, 0), line': [
      (c) => {
        arc0(c)
        line(c)
      },
      LINE_AND_DOT,
    ],
    'ellipse radii 0, line': [
      (c) => {
        ell00(c)
        line(c)
      },
      LINE_AND_DOT,
    ],
    'arc(50, 50, 10, 0, 0), line': [
      (c) => {
        c.arc(50, 50, 10, 0, 0)
        line(c)
      },
      LINE_AND_DOT,
    ],
    'collapsed ellipse, line': [
      (c) => {
        collapsed(c)
        line(c)
      },
      [400, 1072, 1200, 48, 48, 1807, 636],
    ],
    'zero-sweep ellipse, line': [
      (c) => {
        zeroSweep(c)
        line(c)
      },
      [400, 1080, 1241, 48, 48, 2159, 636],
    ],
    'closePath on an empty path, arc(p, 0), line': [
      (c) => {
        c.closePath()
        arc0(c)
        line(c)
      },
      LINE_AND_DOT,
    ],
    // Blink adds only moveTo(p) for these.
    'arcTo on an empty path, line': [
      (c) => {
        c.arcTo(50, 50, 80, 20, 10)
        line(c)
      },
      LINE,
    ],
    'rect(p, 0, 0), line': [
      (c) => {
        c.rect(50, 50, 0, 0)
        line(c)
      },
      LINE,
    ],
    'line, rect(p, 0, 0)': [
      (c) => {
        line(c)
        c.rect(50, 50, 0, 0)
      },
      LINE,
    ],
  })
})

test('a lone point then a line keeps Blink zero-length line', (t) => {
  // Blink adds moveTo(p) lineTo(p), then the line: thin round and square caps
  // differ from a plain moveTo(p) lineTo(q).
  expectCounts(t, {
    'collapsed ellipse, lineTo(80, 20)': [
      (c) => {
        collapsed(c)
        c.lineTo(80, 20)
      },
      [1654, 1953, 2048, 141, 140, 3278, 1905],
    ],
    'moveTo(50, 90), collapsed ellipse, lineTo(80, 20)': [
      (c) => {
        c.moveTo(50, 90)
        collapsed(c)
        c.lineTo(80, 20)
      },
      [1654, 1953, 2048, 141, 140, 3278, 1905],
    ],
    'arc(p, 0), lineTo(80, 20)': [
      (c) => {
        arc0(c)
        c.lineTo(80, 20)
      },
      [884, 1206, 1405, 55, 55, 2252, 1217],
    ],
    'arc(p, 0), lineTo(80, 20), closePath': [
      (c) => {
        arc0(c)
        c.lineTo(80, 20)
        c.closePath()
      },
      [884, 884, 884, 61, 61, 1730, 928],
    ],
    'moveTo(10, 10), collapsed ellipse': [
      (c) => {
        c.moveTo(10, 10)
        collapsed(c)
      },
      [1938, 2256, 2306, 163, 163, 3114, 2113],
    ],
    // rect(p, 0, 0) is moveTo(p) only.
    'rect(p, 0, 0), lineTo(80, 20)': [
      (c) => {
        c.rect(50, 50, 0, 0)
        c.lineTo(80, 20)
      },
      [884, 1206, 1405, 62, 64, 2252, 1217],
    ],
  })
})

test('closePath empties a path that is one zero-length line from arc(), ellipse() or rect()', (t) => {
  expectCounts(t, {
    'arc(p, 0), closePath, line': [
      (c) => {
        arc0(c)
        c.closePath()
        line(c)
      },
      LINE,
    ],
    'arc(p, 0), closePath twice, line': [
      (c) => {
        arc0(c)
        c.closePath()
        c.closePath()
        line(c)
      },
      LINE,
    ],
    'ellipse radii 0, closePath, line': [
      (c) => {
        ell00(c)
        c.closePath()
        line(c)
      },
      LINE,
    ],
    'zero-sweep ellipse, closePath, line': [
      (c) => {
        zeroSweep(c)
        c.closePath()
        line(c)
      },
      LINE,
    ],
    'arc(50, 50, 10, 1, 1), closePath, line': [
      (c) => {
        c.arc(50, 50, 10, 1, 1)
        c.closePath()
        line(c)
      },
      LINE,
    ],
    'rect(p, 0, 0), lineTo(p), closePath, line': [
      (c) => {
        c.rect(50, 50, 0, 0)
        c.lineTo(50, 50)
        c.closePath()
        line(c)
      },
      LINE,
    ],
    // The path is empty again, so lineTo(80, 20) is one point.
    'arc(p, 0), closePath, lineTo(80, 20)': [
      (c) => {
        arc0(c)
        c.closePath()
        c.lineTo(80, 20)
      },
      NONE,
    ],
    'arc(p, 0), closePath, collapsed ellipse': [
      (c) => {
        arc0(c)
        c.closePath()
        collapsed(c)
      },
      NONE,
    ],
    'arc(p, 0), closePath, arc(50, 90, 0), line': [
      (c) => {
        arc0(c)
        c.closePath()
        arc0(c, 50, 90)
        line(c)
      },
      [400, 1072, 1200, 48, 48, 1807, 636],
    ],
    // Not one LineBuilder line in Blink: the dot stays.
    'moveTo(p), arc(p, 0), closePath, line': [
      (c) => {
        c.moveTo(50, 50)
        arc0(c)
        c.closePath()
        line(c)
      },
      LINE_AND_DOT,
    ],
    'collapsed ellipse, closePath, line': [
      (c) => {
        collapsed(c)
        c.closePath()
        line(c)
      },
      [400, 1072, 1200, 48, 48, 1807, 636],
    ],
    'arcTo on an empty path, lineTo(p), closePath, line': [
      (c) => {
        c.arcTo(50, 50, 80, 20, 10)
        c.lineTo(50, 50)
        c.closePath()
        line(c)
      },
      LINE_AND_DOT,
    ],
    'arc(p, 0), moveTo(p), closePath, line': [
      (c) => {
        arc0(c)
        c.moveTo(50, 50)
        c.closePath()
        line(c)
      },
      LINE_AND_DOT,
    ],
  })
  const path = new Path2D()
  arc0(path)
  path.closePath()
  t.is(path.toSVGString(), '')
  // pdf.js closes 'x y m x y l h' dots: Chrome 156 empties these (LINE), we
  // keep the dot.
  expectCounts(t, {
    'moveTo(p), lineTo(p), closePath, line': [
      (c) => {
        c.moveTo(50, 50)
        c.lineTo(50, 50)
        c.closePath()
        line(c)
      },
      LINE_AND_DOT,
    ],
  })
})

test('isPointInStroke sees the zero-length lines, as in Chrome', (t) => {
  // Blink prunes only the stroke, not the hit test. lineWidth 20, round caps.
  const hits = (build: Build, x: number, y: number) =>
    APIS.slice(0, 2).map((api) => {
      ctx.reset()
      ctx.lineWidth = 20
      ctx.lineCap = 'round'
      ctx.beginPath()
      if (api === 'ctx') {
        build(ctx)
        return ctx.isPointInStroke(x, y)
      }
      const path = new Path2D()
      build(path)
      return ctx.isPointInStroke(path, x, y)
    })
  t.deepEqual(hits(arc0, 50, 45), [true, true], 'arc(p, 0)')
  t.deepEqual(hits(ell00, 50, 50), [true, true], 'ellipse radii 0')
  t.deepEqual(hits(collapsed, 50, 90), [true, true], 'collapsed ellipse')
  t.deepEqual(
    hits((c) => c.arc(50, 50, 10, 0, 0), 56, 50),
    [true, true],
    'arc(50, 50, 10, 0, 0)',
  )
  // moveTo(p) only, or emptied by closePath.
  t.deepEqual(
    hits((c) => c.rect(50, 50, 0, 0), 50, 50),
    [false, false],
    'rect(p, 0, 0)',
  )
  t.deepEqual(
    hits((c) => c.arcTo(50, 50, 80, 20, 10), 50, 50),
    [false, false],
    'arcTo on an empty path',
  )
  t.deepEqual(
    hits(
      (c) => {
        arc0(c)
        c.closePath()
      },
      50,
      50,
    ),
    [false, false],
    'arc(p, 0), closePath',
  )
})

test('closePath keeps the point once Blink built the path with GetPath()', (t) => {
  // isPointInPath, isPointInStroke, clip, Path2D(path) and addPath(path) make
  // Blink build its PathBuilder from the line (GetPath, canvas_path.h:140).
  // closePath then puts back moveTo(p), so lineTo(80, 20) draws a line
  // (1206 px, lineWidth 20, round). stroke() and fill() of a one-point path
  // return before GetPath, so the path stays empty and lineTo(80, 20) is one
  // point again (0 px).
  type Read = (p: InstanceType<typeof Path2D> | null) => void
  const reads: Record<string, [Read, number, boolean]> = {
    nothing: [() => {}, 0, true],
    isPointInPath: [(p) => (p ? ctx.isPointInPath(p, 50, 50) : ctx.isPointInPath(50, 50)), 1206, true],
    isPointInStroke: [(p) => (p ? ctx.isPointInStroke(p, 50, 50) : ctx.isPointInStroke(50, 50)), 1206, true],
    clip: [
      (p) => {
        ctx.save()
        if (p) ctx.clip(p)
        else ctx.clip()
        ctx.restore()
      },
      1206,
      true,
    ],
    stroke: [(p) => (p ? ctx.stroke(p) : ctx.stroke()), 0, true],
    fill: [(p) => (p ? ctx.fill(p) : ctx.fill()), 0, true],
    'Path2D(path)': [(p) => p && new Path2D(p), 1206, false],
    'addPath(path)': [(p) => p && new Path2D().addPath(p), 1206, false],
  }
  for (const [name, [read, expected, onCtx]] of Object.entries(reads)) {
    for (const api of onCtx ? (['ctx', 'Path2D'] as const) : (['Path2D'] as const)) {
      ctx.reset()
      ctx.lineWidth = 20
      ctx.lineCap = 'round'
      const path = api === 'ctx' ? null : new Path2D()
      const target = path ?? ctx
      arc0(target)
      read(path)
      ctx.clearRect(0, 0, 100, 100)
      target.closePath()
      target.lineTo(80, 20)
      if (path) ctx.stroke(path)
      else ctx.stroke()
      t.is(countPainted(), expected, `${name} ${api}`)
    }
  }
  // save() and restore() with the identity CTM do not map the path in Blink
  // (PopStateStack), so closePath still empties it.
  ctx.reset()
  ctx.lineWidth = 20
  ctx.lineCap = 'round'
  arc0(ctx)
  ctx.save()
  ctx.restore()
  ctx.closePath()
  line(ctx)
  ctx.stroke()
  t.is(countPainted(), LINE[1])
})

test('a closed arc() on an empty path keeps the dot Chrome draws when its sweep rounds to one point', (t) => {
  // Blink keeps arc() on an empty path with radius >= 1 as an ArcBuilder
  // (canvas_path.cc:466-473 m156) whose bounds are the whole oval (:714-729),
  // so the prune never fires, and Chrome draws the closed arc as a dot. A
  // copy (addPath), radius < 1, ellipse() or any call after the arc gives a
  // plain path again, which is pruned. On the context save(), rotate() and
  // restore() map the path (PopStateStack), which makes it plain too.
  const tiny = (c: Target) => c.arc(50, 50, 30, 1, 1 + 1e-7)
  const DOT = [0, 342, 441, 4, 4, 610, 0]
  const dot = (expected: number[]) => ({ ctx: expected, Path2D: expected, addPath: NONE })
  const cases: Record<string, [Build, { ctx: number[]; Path2D: number[]; addPath: number[] }]> = {
    'arc(1, 1 + 1e-7), closePath': [
      (c) => {
        tiny(c)
        c.closePath()
      },
      dot(DOT),
    ],
    anticlockwise: [
      (c) => {
        c.arc(50, 50, 30, 1 + 1e-7, 1, true)
        c.closePath()
      },
      dot(DOT),
    ],
    'arc(50, 50 + 4e-6), closePath': [
      (c) => {
        c.arc(50, 50, 30, 50, 50 + 4e-6)
        c.closePath()
      },
      dot([0, 343, 440, 4, 4, 537, 0]),
    ],
    'radius 1': [
      (c) => {
        c.arc(50, 50, 1, 1, 1 + 1e-7)
        c.closePath()
      },
      dot([0, 347, 441, 2, 4, 694, 0]),
    ],
    'closePath twice': [
      (c) => {
        tiny(c)
        c.closePath()
        c.closePath()
      },
      dot(DOT),
    ],
    'radius 0.9': [
      (c) => {
        c.arc(50, 50, 0.9, 1, 1 + 1e-7)
        c.closePath()
      },
      dot(NONE),
    ],
    'not closed': [tiny, dot(NONE)],
    'closePath, moveTo': [
      (c) => {
        tiny(c)
        c.closePath()
        c.moveTo(80, 80)
      },
      dot(NONE),
    ],
    ellipse: [
      (c) => {
        c.ellipse(50, 50, 30, 30, 0, 1, 1 + 1e-7)
        c.closePath()
      },
      dot(NONE),
    ],
  }
  for (const [name, [build, expected]] of Object.entries(cases)) {
    t.deepEqual(counts(build), expected, name)
  }
  // isPointInPath builds Blink's PathBuilder but keeps the ArcBuilder.
  for (const api of ['ctx', 'Path2D'] as const) {
    const read = STYLES.map((setup) => {
      ctx.reset()
      setup()
      const path = api === 'ctx' ? null : new Path2D()
      const target = path ?? ctx
      tiny(target)
      if (path) ctx.isPointInPath(path, 1, 1)
      else ctx.isPointInPath(1, 1)
      target.closePath()
      if (path) ctx.stroke(path)
      else ctx.stroke()
      return countPainted()
    })
    t.deepEqual(read, DOT, `isPointInPath, closePath ${api}`)
  }
  const restored = STYLES.map((setup) => {
    ctx.reset()
    setup()
    tiny(ctx)
    ctx.save()
    ctx.rotate(0.3)
    ctx.restore()
    ctx.closePath()
    ctx.stroke()
    return countPainted()
  })
  t.deepEqual(restored, NONE, 'save, rotate, restore, closePath')
})

test('a transform call that changes Blink double CTM takes the path out of the line and arc builders', (t) => {
  // Blink maps the path (GetModifiablePath, canvas_path.h:193-196 m156) in
  // rotate() whenever its double CTM changes (canvas_2d_recorder_context.cc:
  // 1399-1412), and in resetTransform(), setTransform() and restore() when
  // that CTM is not the identity (:734-748, :1496-1546). The path then
  // leaves the LineBuilder and the ArcBuilder, even when our float map
  // snaps to the identity: rotate(1e-5), rotate(2 * PI). So closePath no
  // longer empties arc(p, 0), and a closed tiny arc() is pruned. Chrome 156
  // counts for lineWidth 20 butt and round (the line), and for STYLES (the
  // closed arc).
  const tiny = (c: Ctx) => c.arc(50, 50, 30, 1, 1 + 1e-7)
  const DOT = [0, 342, 441, 4, 4, 610, 0]
  const toLine = (c: Ctx) => c.lineTo(80, 20)
  const strokeWith = (styles: (() => void)[], build: (c: Ctx) => void) =>
    styles.map((setup) => {
      ctx.reset()
      setup()
      ctx.beginPath()
      build(ctx)
      ctx.stroke()
      return countPainted()
    })
  const LINE_20 = [884, 1206]
  const lines: Record<string, [(c: Ctx) => void, number[]]> = {
    'rotate(1e-5)': [(c) => c.rotate(1e-5), LINE_20],
    'rotate(1e-6)': [(c) => c.rotate(1e-6), LINE_20],
    'rotate(1e-20)': [(c) => c.rotate(1e-20), LINE_20],
    'rotate(2 * PI)': [(c) => c.rotate(TAU), LINE_20],
    'save, rotate(1e-5), restore': [
      (c) => {
        c.save()
        c.rotate(1e-5)
        c.restore()
      },
      LINE_20,
    ],
    'rotate(1e-5), isPointInPath': [
      (c) => {
        c.rotate(1e-5)
        c.isPointInPath(0, 0)
      },
      LINE_20,
    ],
    'rotate(0)': [(c) => c.rotate(0), [0, 0]],
    'scale(1, 1)': [(c) => c.scale(1, 1), [0, 0]],
    'translate(0, 0)': [(c) => c.translate(0, 0), [0, 0]],
  }
  for (const [name, [xf, expected]] of Object.entries(lines)) {
    const got = strokeWith(STYLES.slice(0, 2), (c) => {
      arc0(c)
      xf(c)
      c.closePath()
      toLine(c)
    })
    t.deepEqual(got, expected, `arc(p, 0), ${name}, closePath, lineTo`)
  }
  // The path is built under a rotation the float CTM snapped away. Blink's
  // double CTM is not the identity, so resetTransform(), setTransform() and
  // restore() map the path; rotating back makes it the identity again.
  const before: Record<string, [(c: Ctx) => void, (c: Ctx) => void, boolean]> = {
    resetTransform: [(c) => c.rotate(1e-5), (c) => c.resetTransform(), true],
    setTransform: [(c) => c.rotate(1e-5), (c) => c.setTransform(1, 0, 0, 1, 0, 0), true],
    restore: [
      (c) => {
        c.save()
        c.rotate(1e-5)
      },
      (c) => c.restore(),
      true,
    ],
    'rotate there and back, resetTransform': [
      (c) => {
        c.rotate(1e-5)
        c.rotate(-1e-5)
      },
      (c) => c.resetTransform(),
      false,
    ],
    'rotate there and back, restore': [
      (c) => {
        c.save()
        c.rotate(1e-5)
        c.rotate(-1e-5)
      },
      (c) => c.restore(),
      false,
    ],
  }
  for (const [name, [first, then, maps]] of Object.entries(before)) {
    const got = strokeWith(STYLES.slice(0, 2), (c) => {
      first(c)
      arc0(c)
      then(c)
      c.closePath()
      toLine(c)
    })
    t.deepEqual(got, maps ? LINE_20 : [0, 0], `line, ${name}`)
    const closed = strokeWith(STYLES, (c) => {
      first(c)
      tiny(c)
      then(c)
      c.closePath()
    })
    t.deepEqual(closed, maps ? NONE : DOT, `closed tiny arc, ${name}`)
  }
  const arcs: Record<string, [(c: Ctx) => void, number[]]> = {
    'rotate(1e-5)': [(c) => c.rotate(1e-5), NONE],
    'rotate(2 * PI)': [(c) => c.rotate(TAU), NONE],
    'rotate(1e-5), isPointInPath': [
      (c) => {
        c.rotate(1e-5)
        c.isPointInPath(0, 0)
      },
      NONE,
    ],
    'rotate(0)': [(c) => c.rotate(0), DOT],
    'scale(1, 1)': [(c) => c.scale(1, 1), DOT],
    'translate(0, 0)': [(c) => c.translate(0, 0), DOT],
  }
  for (const [name, [xf, expected]] of Object.entries(arcs)) {
    const got = strokeWith(STYLES, (c) => {
      tiny(c)
      xf(c)
      c.closePath()
    })
    t.deepEqual(got, expected, `closed tiny arc, ${name}`)
  }
})
