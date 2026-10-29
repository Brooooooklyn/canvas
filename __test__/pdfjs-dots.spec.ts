// PDF subpaths of zero length, drawn by pdf.js in Node as in Chrome. ISO 32000
// 8.5.3.2 draws them as dots with round or square caps. pdf.js 6.4.299 has no
// special case for them: it strokes the path unchanged, as moveTo, lineTo,
// closePath or bezierCurveTo on a Path2D (makePathFromDrawOPS,
// rescaleAndStroke). Chrome 156 strokes nothing for a path whose bounds are
// one point (DrawPathInternal, canvas_2d_recorder_context.cc:1595-1602), and
// its closePath() empties a path that is one zero-length line (CanvasPath::
// closePath, canvas_path.cc:76-93), so pdf.js in Chrome draws no dot for such
// an S (mozilla/pdf.js#22040). A dot next to another subpath, or a
// zero-length dash on a line, still draws. Every count below is what this
// page gives with pdfjs-dist 6.4.299 in Chrome 156.0.8078.48 (--disable-gpu),
// where the whole page is byte-identical to ours. We drew 300 px (round) and
// 400 px (square) dots for the one-point paths until the prune covered every
// path (stroke-prune-point-paths-chrome.spec.ts).
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
// box around it]. Line width 20: a round dot is 300 px. An empty content
// stream only checks another point of the line before it.
const DOTS: Record<string, [string, number, number, number]> = {
  'm l S, round cap': ['1 J 20 w 20 180 m 20 180 l S', 20, 180, 0],
  'm h S, round cap': ['1 J 20 w 60 180 m h S', 60, 180, 0],
  'm l h S, round cap': ['1 J 20 w 100 180 m 100 180 l h S', 100, 180, 0],
  '0 x 0 re S, round cap': ['1 J 20 w 140 180 0 0 re S', 140, 180, 0],
  'm c S on one point, round cap': ['1 J 20 w 180 180 m 180 180 180 180 180 180 c S', 180, 180, 0],
  'm l S, square cap': ['2 J 20 w 20 130 m 20 130 l S', 20, 130, 0],
  'm l S, butt cap': ['0 J 20 w 60 130 m 60 130 l S', 60, 130, 0],
  // The bounds of the whole path are not one point, so both dots draw.
  'two dots in one S': ['1 J 20 w 100 130 m 100 130 l 140 130 m 140 130 l S', 100, 130, 300],
  'm l S, round cap, scaled CTM': ['q 0.5 0 0 0.5 50 40 cm 1 J 40 w 100 0 m 100 0 l S Q', 100, 40, 0],
  // closePath empties the zero-length line, so only the line after it draws.
  'm l h, then a line, in one S: the dot': ['1 J 20 w 20 80 m 20 80 l h 60 80 m 90 80 l S', 20, 80, 0],
  'm l h, then a line, in one S: the line': ['', 75, 80, 500],
  // Not one line any more when closePath comes: both dots draw.
  'two dots, the second closed: first': ['1 J 20 w 120 80 m 120 80 l 160 80 m 160 80 l h S', 120, 80, 300],
  'two dots, the second closed: second': ['', 160, 80, 300],
  // Zero-length dashes on a line keep their round caps (line width 10).
  'zero-length dashes on a line, round cap': ['1 J 10 w [0 20] 0 d 20 20 m 180 20 l S [] 0 d', 20, 20, 74],
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

test('pdf.js strokes zero-length PDF subpaths as in Chrome', async (t) => {
  t.is(requireFromPdfjs('@napi-rs/canvas'), addon)
  const pdfjs = await import(pathToFileURL(PDFJS_PATH).href)
  const content =
    '1 0 0 RG\n' +
    Object.values(DOTS)
      .map(([ops]) => ops)
      .filter(Boolean)
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
