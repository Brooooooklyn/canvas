// The macOS values of draw.spec, svg.spec and svg-canvas.spec with the system
// font renderer, where CoreText draws the registered fonts. By default those
// specs check FreeType's values, the same on every OS.
import './use-system-text-renderer'

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { convertSVGTextToPath, createCanvas, GlobalFonts, SvgExportFlag } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const macTest = process.platform === 'darwin' ? test : test.skip

test.before(() => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts', 'iosevka-slab-regular.ttf'))
  GlobalFonts.registerFromPath(join(__dirname, 'fonts-dir', 'iosevka-curly-regular.woff2'), 'i-curly')
})

macTest('measureText', (t) => {
  const ctx = createCanvas(512, 512).getContext('2d')
  ctx.font = '50px Iosevka Slab'
  const metrics = ctx.measureText('@napi-rs/canvas')
  // Chrome 155 macOS: CoreText outlines.
  const [left, ascent, descent, right] = [-3.45, 41.15, 10.25, 371.6]
  t.true(Math.abs(metrics.actualBoundingBoxLeft - left) < 0.001)
  t.true(Math.abs(metrics.actualBoundingBoxAscent - ascent) < 0.001)
  t.true(Math.abs(metrics.actualBoundingBoxDescent - descent) < 0.001)
  t.true(Math.abs(metrics.actualBoundingBoxRight - right) < 0.001)
  // CoreText's descent.
  t.is(ctx.measureText('').fontBoundingBoxDescent, 10)
})

macTest('SvgCanvas text export', (t) => {
  const canvas = createCanvas(1024, 768, SvgExportFlag.ConvertTextToPaths)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'yellow'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.lineWidth = 3
  ctx.strokeStyle = 'hotpink'
  ctx.font = '50px i-curly'
  ctx.strokeText('@napi-rs/canvas', 50, 300)
  const svg = canvas.getContent().toString('utf8')
  // CoreText's outline points are within 0.02px of FreeType's, which
  // fixtures/svg-export-text.svg holds.
  t.true(numberDistance(svg, readFileSync(join(__dirname, 'fixtures', 'svg-export-text.svg'), 'utf8')) <= 0.02)
})

macTest('convertSVGTextToPath', (t) => {
  const result = convertSVGTextToPath(readFileSync(join(__dirname, 'text.svg'), 'utf8'))
  const output = readFileSync(join(__dirname, 'text-to-path.svg'), 'utf8')
  // CoreText's outline points are within 0.05px of FreeType's, which
  // text-to-path.svg holds.
  const trimmed = (svg: string) =>
    svg
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
  t.true(numberDistance(trimmed(result.toString('utf8')), trimmed(output)) <= 0.05)
})

const NUMBER = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g

// How far apart the numbers of two texts are, or Infinity when the texts
// differ in more than their numbers.
function numberDistance(actual: string, expected: string) {
  if (actual.replace(NUMBER, '#') !== expected.replace(NUMBER, '#')) return Infinity
  const want = expected.match(NUMBER) ?? []
  return Math.max(0, ...(actual.match(NUMBER) ?? []).map((value, i) => Math.abs(Number(value) - Number(want[i]))))
}
