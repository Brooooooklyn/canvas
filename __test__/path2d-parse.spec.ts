// new Path2D(path): Blink's SVG path data parser (BuildPathFromString,
// core/svg/svg_path_utilities.cc:35-44; SVGPathStringSource::ParseSegment,
// svg_path_string_source.cc; GenericParseNumber, svg_parser_utilities.cc).
// A string with an error keeps the segments before it; nothing throws but a
// Symbol. Every expected value was measured in Chrome 155 CPU canvas
// (--disable-gpu, getContext('2d', { willReadFrequently: true })) in a
// standards-mode page; Chrome arm64 and x64 give the same values.
import test, { type ExecutionContext } from 'ava'

import { createCanvas, Path2D } from '../index'

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

/** 64x64, lineWidth 2: stroke(path), then fill(path). */
function draw(path: Path2D) {
  const ctx = createCanvas(64, 64).getContext('2d')
  ctx.lineWidth = 2
  ctx.stroke(path)
  ctx.fill(path)
  return ink(ctx)
}

/** The path continued with lineTo(63, 63) and stroked: shows where the current point is. */
function continued(data: string) {
  const path = new Path2D(data)
  path.lineTo(63, 63)
  const ctx = createCanvas(64, 64).getContext('2d')
  ctx.lineWidth = 2
  ctx.stroke(path)
  return ink(ctx)
}

type Row = [string, number[] | null, number] | [string, number[] | null, number, number[] | null, number]

/** Each row: the path data, the ink of draw(), and optionally the ink of continued(). */
function check(t: ExecutionContext, rows: Row[]) {
  for (const [data, box, sum, contBox, contSum] of rows) {
    t.deepEqual(draw(new Path2D(data)), { box, sum }, JSON.stringify(data))
    if (contSum !== undefined) {
      t.deepEqual(continued(data), { box: contBox, sum: contSum }, `${JSON.stringify(data)} + lineTo`)
    }
  }
}

test('new Path2D(string) keeps the segments before the first error', (t) => {
  check(t, [
    ['M 2 2 L 18 2 L 18', [2, 1, 17, 2], 8160, [2, 1, 63, 63], 45191],
    ['M2,2 L18,2 X 18,18', [2, 1, 17, 2], 8160, [2, 1, 63, 63], 45191],
    ['M 2 2 L 18 2 L 18 18 Z X 1', [0, 1, 18, 20], 48453, [0, 1, 63, 63], 60981],
    ['M 2 2 L 18 2 L 18 18 Z', [0, 1, 18, 20], 48453, [0, 1, 63, 63], 60981],
    ['M 4 50 C 4 0 60 0 60 50 L 4 4 C 1 2 3', [3, 3, 60, 51], 262331, [3, 3, 63, 63], 124737],
    ['M 10 32 L 30 10 A 20 20 0 0 1 50', [9, 9, 30, 32], 15990, [9, 8, 63, 63], 47855],
    ['M 10 32 L 30 10 A 20 20 0 2 1 50 32 Z', [9, 9, 30, 32], 15990, [9, 8, 63, 63], 47855],
    ['M 2 2 L 30 2\u0000 L 30 30 Z', [2, 1, 29, 2], 14280, [2, 1, 63, 63], 49926],
    ['M 2 2 L 30.5.5 L 30 30 Z', [0, 0, 31, 31], 132552, [0, 0, 63, 63], 73428],
    ['M 10 10', null, 0, [9, 9, 63, 63], 38849],
    ['M 1,2,3', null, 0],
    ['M 5 5 L 5\u00000 5 L 50 50 Z', null, 0],
    ['M 5 5 L 50.5.5 L 5 50 Z', [4, 0, 52, 52], 301759],
  ])
})

test('new Path2D(string) must start with a moveto', (t) => {
  check(t, [
    ['L 10 10 L 20 20', null, 0, null, 0],
    ['M ,2 2 L 30 2 L 30 30 Z', null, 0, null, 0],
    ['', null, 0, null, 0],
    ['   ', null, 0, null, 0],
    ['m 10 10 l 20 0 l 0 20 z', [7, 9, 30, 32], 70205, [7, 9, 63, 63], 59024],
    ['M 10 10 M 20 20 L 40 20 L 40 40 Z', [17, 19, 40, 42], 70205, [17, 19, 63, 63], 51614],
    ['m 10 10 l 30 0 l 0 30 z', [7, 9, 40, 42], 142789],
  ])
})

test('new Path2D(string) only skips HTML spaces', (t) => {
  check(t, [
    ['  \n M 2 2 L 30 2 L 30 30 Z', [0, 1, 30, 32], 126483, [0, 1, 63, 63], 73365],
    ['M2\v2L30 2L30 30Z', null, 0, null, 0],
    ['M2\u00a02L30 2L30 30Z', null, 0, null, 0],
    ['M\t2\n2\rL\f30 2 L 30 30 Z', [0, 1, 30, 32], 126483, [0, 1, 63, 63], 73365],
    ['  \n\tM 5 5 L 50 5 L 50 50 Z  ', [2, 4, 50, 52], 299477],
  ])
})

test('new Path2D(string) stops at a bad number', (t) => {
  check(t, [
    ['M 2 2 L 30. 2 L 30 30 Z', null, 0, [1, 1, 63, 63], 44713],
    ['M 2 2 L 30e 2 L 30 30 Z', null, 0, [1, 1, 63, 63], 44713],
    ['M 2 2 L 30ex 2 L 30 30 Z', null, 0, [1, 1, 63, 63], 44713],
    ['M 2 2 L 1e39 2 L 30 30 Z', null, 0, [1, 1, 63, 63], 44713],
    ['M 2 2 L 1e38 2 L 30 30 Z', null, 0, null, 0],
    ['M 2 2 L 30,,2 L 30 30 Z', null, 0, [1, 1, 63, 63], 44713],
    ['M 2 2 L, 30 2 L 30 30 Z', null, 0, [1, 1, 63, 63], 44713],
    ['M 2 2 L + 2', null, 0, [1, 1, 63, 63], 44713],
    ['M 0 0 L 1e38 0 L 1e38 1 Z', null, 0],
    ['M 5 5 L 50 5 L 10e38 50 Z', [5, 4, 49, 5], 22950],
    ['M 5 5 L 50 5 L 0.1e39 50 Z', [5, 4, 49, 5], 22950],
    ['M 5 5 L 0000000000000000000000000000000000000000000050 5 L 50 50 Z', null, 0],
  ])
})

test('new Path2D(string) reads every SVG number form', (t) => {
  check(t, [
    ['M 0.2e1 2 L 3e1 2 L 30 3E+1 Z', [0, 1, 30, 32], 126483, [0, 1, 63, 63], 73365],
    ['M 2 2 L 3000e-2 2 L 30 30 Z', [0, 1, 30, 32], 126483, [0, 1, 63, 63], 73365],
    ['M2-2L30-2L30+30Z', [2, 0, 30, 32], 119365, [2, 0, 63, 63], 67226],
    ['M .5 .5 L 30 .5 L 30 30 Z', [0, 0, 30, 32], 134388, [0, 0, 63, 63], 71588],
    ['M+.5e+1,5L+50-0e0 .5e1 50 50Z', [4, 0, 51, 50], 286447],
    ['M 5 5 L 50.000000000000000000000000000000000000000000000001 5 L 50 50 Z', [2, 4, 50, 52], 299477],
  ])
})

test('new Path2D(string) has no implicit command after Z', (t) => {
  check(t, [
    ['M 2 2 L 30 2 L 30 30 Z 40 40', [0, 1, 30, 32], 126483, [0, 1, 63, 63], 73365],
    ['M 2 2 L 30 2 L 30 30 Z 5', [0, 1, 30, 32], 126483, [0, 1, 63, 63], 73365],
    ['M 2 2, L 30 2 L 30 30 Z', [0, 1, 30, 32], 126483, [0, 1, 63, 63], 73365],
    ['M 2 2 L 30 2 L 30 30 Z,', [0, 1, 30, 32], 126483, [0, 1, 63, 63], 73365],
    ['M 2 2 L 30 2 L 30 30 Z é', [0, 1, 30, 32], 126483, [0, 1, 63, 63], 73365],
    ['M 2 2 L 30 2 L 30 30 Z Z', [0, 1, 30, 32], 126483, [0, 1, 63, 63], 73365],
    ['M 2 2 L 20 2 L 20 20 Z m 10 10 l 20 0 l 0 20 z', [0, 1, 32, 34], 112430, [0, 1, 63, 63], 81053],
    ['M 2 2 L 20 2 L 20 20 Z l 30 30 l 0 -20 z', [0, 0, 32, 34], 103251, [0, 0, 63, 63], 86252],
    ['M 5 5 L 50 5 L 50 50 Z L 5 50 Z', [2, 4, 50, 52], 321699],
    ['m 5 5 20 0 0 20 z m 30 0 20 0 0 20 z', [2, 4, 55, 27], 140410],
  ])
})

test('new Path2D(string) repeats a command for more numbers', (t) => {
  check(t, [
    ['M 2 2 30 2 30 30 z', [0, 1, 30, 32], 126483, [0, 1, 63, 63], 73365],
    ['m 2 2 28 0 0 28 z', [0, 1, 30, 32], 126483, [0, 1, 63, 63], 73365],
    ['M10 10 40 10 40 40', [10, 9, 40, 39], 130574],
  ])
})

test('new Path2D(string) draws lines and curves like Chrome', (t) => {
  check(t, [
    ['M 4 4 H 40 V 40 H 4 Z', [3, 3, 40, 40], 368220, [3, 3, 63, 63], 114662],
    ['M 4 4 h 36 v 36 h -36 z', [3, 3, 40, 40], 368220, [3, 3, 63, 63], 114662],
    ['M 10 10 h 20 v 20 H 5 V 40 z', [4, 9, 30, 40], 140175],
    ['M 4 40 Q 30 0 56 40 Z', [2, 19, 57, 40], 207906, [2, 19, 63, 63], 93727],
    ['m 4 40 q 26 -40 52 0 z', [2, 19, 57, 40], 207906, [2, 19, 63, 63], 93727],
    ['M 4 30 Q 14 0 24 30 T 44 30 T 60 30 Z', [2, 14, 61, 45], 184383, [2, 14, 63, 63], 110918],
    ['M 4 30 T 44 50 L 4 50 Z', [3, 28, 47, 50], 130994, [3, 28, 63, 63], 73014],
    ['M 4 30 L 10 30 T 44 50 L 4 50 Z', [3, 29, 47, 50], 145637, [3, 29, 63, 63], 80678],
    ['M 5 30 Q 15 5 25 30 T 45 30 T 60 30 Z', [3, 16, 61, 43], 153965],
    ['M 4 50 C 4 0 60 0 60 50 Z', [3, 11, 60, 50], 468322, [3, 11, 63, 63], 110217],
    ['m 4 50 c 0 -50 56 -50 56 0 z', [3, 11, 60, 50], 468322, [3, 11, 63, 63], 110217],
    ['M 4 40 C 4 10 20 10 24 40 S 50 60 60 30 Z', [3, 16, 61, 59], 282793, [3, 16, 63, 63], 116642],
    ['M 4 40 S 50 0 60 40 Z', [1, 21, 61, 40], 203926, [1, 21, 63, 63], 97245],
    ['M 4 40 Q 10 0 24 40 S 50 0 60 40 Z', [2, 19, 61, 41], 217192, [2, 19, 63, 63], 109271],
    ['M 10 50 S 30 10 50 50', [9, 31, 50, 50], 136035],
  ])
})

test('new Path2D(string) draws arcs like Chrome', (t) => {
  check(t, [
    ['M 10 32 A 20 20 0 0 1 50 32 Z', [9, 11, 50, 32], 186133, [9, 11, 63, 63], 78950],
    ['M 10 32 A 20 12 30 1 0 50 32 Z', [8, 31, 53, 50], 164733, [8, 31, 63, 63], 75599],
    ['m 10 32 a 20 20 0 0 1 40 0 z', [9, 11, 50, 32], 186133, [9, 11, 63, 63], 78950],
    ['M10 32A20 20 0 0150 32Z', [9, 11, 50, 32], 186133, [9, 11, 63, 63], 78950],
    ['M10 32a20 20 0 1 1 40 0z', [9, 11, 50, 32], 186133, [9, 11, 63, 63], 78950],
    ['M 10 32 A 0 20 0 0 1 50 50 L 10 50 Z', [9, 30, 54, 50], 120042, [9, 30, 63, 63], 74909],
    ['M 10 32 A -20 -20 0 0 1 50 32 Z', [9, 11, 50, 32], 186133, [9, 11, 63, 63], 78950],
    ['M 10 32 A 5 5 0 0 1 50 32 Z', [9, 11, 50, 32], 186133, [9, 11, 63, 63], 78950],
    ['M 10 32 A 5 5 0 0 1 10 32 L 40 40 Z', [9, 31, 40, 40], 16351, [9, 31, 63, 63], 42848],
    ['M 10 32 L 40 10 A 20 20 0 0 1 50 50 L 10 50 Z', [9, 8, 63, 50], 474497, [9, 8, 63, 63], 98363],
    ['M5 5 A 0 10 0 0 1 50 50 L 5 50 Z', [4, 2, 52, 50], 299142],
    ['M5 5 L 50 5 A 10 10 0 1 1 50 5 L 50 50 Z', [2, 4, 50, 52], 299477],
    ['M 10 32 A 20 20 0 0 2 50 32 Z', null, 0],
    ['M 10 32 A -20 20 0 0 1 50 32 Z', [9, 11, 50, 32], 186133],
  ])
})

test('new Path2D(non-string) converts with ToString', (t) => {
  const square = { box: [0, 1, 30, 32], sum: 126483 }
  const empty = { box: null, sum: 0 }
  t.deepEqual(draw(new Path2D(undefined)), empty)
  for (const value of [null, 5, {}]) {
    t.deepEqual(draw(new Path2D(value as any)), empty, String(value))
  }
  t.deepEqual(draw(new Path2D({ toString: () => 'M 2 2 L 30 2 L 30 30 Z' } as any)), square)
  t.deepEqual(draw(new Path2D(['M 2 2 L 30 2 L 30 30 Z'] as any)), square)
  t.deepEqual(draw(new Path2D(new Path2D('M 2 2 L 30 2 L 30 30 Z'))), square)
  // Only a real Path2D is copied; an object with its prototype is a string.
  t.deepEqual(draw(new Path2D(Object.create(Path2D.prototype))), empty)
  t.throws(() => new Path2D(Symbol('x') as any), {
    instanceOf: TypeError,
    message: "Failed to construct 'Path2D': Cannot convert a Symbol value to a string",
  })
  const error = new RangeError('ts')
  t.is(
    t.throws(
      () =>
        new Path2D({
          toString() {
            throw error
          },
        } as any),
    ),
    error,
  )
})

test('new Path2D(string) parses numbers to the float values Chrome gets', (t) => {
  // Chrome: SVGPathElement.getTotalLength() of 'M 0 0 L n 0'. Blink adds the
  // digits up in float, which can differ from the correctly rounded value in
  // the last bit.
  const cases: [string, number][] = [
    ['3.58172', 3.5817198753356934],
    ['1.65', 1.6500000953674316],
    ['1234.5678e-2', 12.345677375793457],
    ['0.559186', 0.5591860413551331],
    ['0.1', 0.10000000149011612],
    ['16777217', 16777216],
    ['1e-7', 1.0000000116860974e-7],
    ['7.0000001', 7],
  ]
  for (const [number, chrome] of cases) {
    const svg = new Path2D(`M 0 0 L ${number} 0`).toSVGString()
    const x = Number(/L(\S+) 0$/.exec(svg)![1])
    t.is(Math.fround(x), chrome, `${number} -> ${svg}`)
  }
})
