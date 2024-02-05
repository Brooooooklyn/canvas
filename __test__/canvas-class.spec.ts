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
  t.is(ctx.canvas, canvas)
})
