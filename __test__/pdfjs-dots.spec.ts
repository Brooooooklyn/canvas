// pdf.js must keep drawing PDF dots: a subpath of zero length stroked with
// round or square caps is a dot (ISO 32000 8.5.3.2), which CAD drawings use
// for dotted lines. pdf.js strokes it unchanged, as moveTo, lineTo, closePath
// or bezierCurveTo on a Path2D (makePathFromDrawOPS, rescaleAndStroke).
// Chrome 156 skips such strokes (mozilla/pdf.js#22040); we skip only one-point
// paths built with arc(), ellipse(), arcTo(), rect() or roundRect(), which
// pdf.js does not stroke (stroke-prune-chrome.spec.ts).
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import test from 'ava'

const require = createRequire(import.meta.url)
// The addon built from this repo, through the CommonJS cache (as in
// pdfjs-malformed.spec.ts).
const ADDON_PATH = require.resolve('../index')
const addon: typeof import('../index') = require(ADDON_PATH)
const PDFJS_PATH = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
const requireFromPdfjs = createRequire(PDFJS_PATH)
const resolvedByPdfjs = requireFromPdfjs.resolve('@napi-rs/canvas')
if (resolvedByPdfjs !== ADDON_PATH) {
  require.cache[resolvedByPdfjs] = require.cache[ADDON_PATH]
}

// [content stream, dot centre in PDF space (y up), red pixels in the 25 x 25
// box around it]. Line width 20: a round dot is 300 px, a square 400 px.
const DOTS: Record<string, [string, number, number, number]> = {
  'm l S, round cap': ['1 J 20 w 20 180 m 20 180 l S', 20, 180, 300],
  'm h S, round cap': ['1 J 20 w 60 180 m h S', 60, 180, 300],
  'm l h S, round cap': ['1 J 20 w 100 180 m 100 180 l h S', 100, 180, 300],
  '0 x 0 re S, round cap': ['1 J 20 w 140 180 0 0 re S', 140, 180, 300],
  'm c S on one point, round cap': ['1 J 20 w 180 180 m 180 180 180 180 180 180 c S', 180, 180, 300],
  'm l S, square cap': ['2 J 20 w 20 130 m 20 130 l S', 20, 130, 400],
  'm l S, butt cap': ['0 J 20 w 60 130 m 60 130 l S', 60, 130, 0],
  'two dots in one S': ['1 J 20 w 100 130 m 100 130 l 140 130 m 140 130 l S', 100, 130, 300],
  'm l S, round cap, scaled CTM': ['q 0.5 0 0 0.5 50 40 cm 1 J 40 w 100 0 m 100 0 l S Q', 100, 40, 300],
}

function pdf(content: string) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ]
  let s = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(s.length)
    s += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = s.length
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  s += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(s)
}

test('pdf.js draws zero-length PDF subpaths as dots', async (t) => {
  t.is(requireFromPdfjs('@napi-rs/canvas'), addon)
  const pdfjs = await import(pathToFileURL(PDFJS_PATH).href)
  const content =
    '1 0 0 RG\n' +
    Object.values(DOTS)
      .map(([ops]) => ops)
      .join('\n') +
    '\n'
  const task = pdfjs.getDocument({ data: pdf(content), verbosity: 0 })
  try {
    const doc = await task.promise
    const page = await doc.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    const { context } = doc.canvasFactory.create(viewport.width, viewport.height)
    await page.render({ canvasContext: context, viewport }).promise
    const image = context.getImageData(0, 0, 200, 200).data
    for (const [name, [, x, y, expected]] of Object.entries(DOTS)) {
      const [cx, cy] = [x, 200 - y]
      let red = 0
      for (let j = -12; j <= 12; j++) {
        for (let i = -12; i <= 12; i++) {
          const k = ((cy + j) * 200 + cx + i) * 4
          if (image[k] > 128 && image[k + 1] < 100) red++
        }
      }
      t.is(red, expected, name)
    }
  } finally {
    await task.destroy()
  }
})
