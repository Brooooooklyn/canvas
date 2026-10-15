import test from 'ava'

import { createCanvas, Canvas, SvgExportFlag } from '../index'

test('Canvas constructor should be equal to createCanvas', (t) => {
  t.true(new Canvas(100, 100) instanceof createCanvas(100, 100).constructor)
})

test('CanvasElement instance should be equal to Canvas', (t) => {
  t.true(createCanvas(100, 100) instanceof Canvas)
})

test('SVGCanvas instance should be equal to Canvas', (t) => {
  t.true(createCanvas(100, 100, SvgExportFlag.NoPrettyXML) instanceof Canvas)
})

test('ctx.canvas should be equal to canvas', (t) => {
  const canvas = createCanvas(100, 100)
  const ctx = canvas.getContext('2d')
  t.is(ctx.canvas, canvas)
})

test('[SVG] ctx.canvas should be equal to canvas', (t) => {
  const canvas = createCanvas(100, 100, SvgExportFlag.NoPrettyXML)
  const ctx = canvas.getContext('2d')
  // @ts-expect-error
  t.is(ctx.canvas, canvas)
})

test('Canvas size follows the width/height setter rule', (t) => {
  // 0 stays 0 (a canvas without pixels); a negative value is above
  // 2147483647 once converted, so it is the default 300 x 150.
  let canvas = createCanvas(0, 0)
  t.is(canvas.width, 0)
  t.is(canvas.height, 0)
  canvas = createCanvas(-1, 10)
  t.is(canvas.width, 300)
  t.is(canvas.height, 10)
  canvas = createCanvas(10, -10)
  t.is(canvas.height, 150)
  t.is(canvas.width, 10)

  const svgCanvas = createCanvas(10, -10, SvgExportFlag.ConvertTextToPaths)
  t.is(svgCanvas.height, 150)
  t.is(svgCanvas.width, 10)
})
