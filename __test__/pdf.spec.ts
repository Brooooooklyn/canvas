import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import ava, { TestFn } from 'ava'

import { PDFDocument, GlobalFonts } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const test = ava as TestFn<{
  doc: PDFDocument
}>

test.beforeEach((t) => {
  t.context.doc = new PDFDocument()
})

test('should create a basic PDF document', (t) => {
  const { doc } = t.context
  const ctx = doc.beginPage(612, 792) // Letter size in points

  ctx.fillStyle = 'blue'
  ctx.fillRect(50, 50, 200, 200)

  doc.endPage()
  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length > 0)
  // PDF files start with %PDF-
  t.is(pdfBuffer.toString('utf8', 0, 5), '%PDF-')
})

test('should create PDF with metadata', (t) => {
  const doc = new PDFDocument({
    title: 'Test Document',
    author: 'Test Author',
    subject: 'Test Subject',
    keywords: 'test, pdf, canvas',
    creator: 'Test Creator',
  })

  const ctx = doc.beginPage(612, 792)
  ctx.fillStyle = 'red'
  ctx.fillRect(100, 100, 100, 100)
  doc.endPage()

  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length > 0)
  t.is(pdfBuffer.toString('utf8', 0, 5), '%PDF-')

  // Check if metadata is present in the PDF
  const pdfContent = pdfBuffer.toString('latin1')
  t.true(pdfContent.includes('Test Document'))
  t.true(pdfContent.includes('Test Author'))
})

test('should create multi-page PDF', (t) => {
  const { doc } = t.context

  // Page 1
  const ctx1 = doc.beginPage(612, 792)
  ctx1.fillStyle = 'red'
  ctx1.fillRect(50, 50, 100, 100)
  ctx1.font = '24px sans-serif'
  ctx1.fillText('Page 1', 50, 200)
  doc.endPage()

  // Page 2
  const ctx2 = doc.beginPage(612, 792)
  ctx2.fillStyle = 'blue'
  ctx2.fillRect(50, 50, 100, 100)
  ctx2.font = '24px sans-serif'
  ctx2.fillText('Page 2', 50, 200)
  doc.endPage()

  // Page 3
  const ctx3 = doc.beginPage(612, 792)
  ctx3.fillStyle = 'green'
  ctx3.fillRect(50, 50, 100, 100)
  ctx3.font = '24px sans-serif'
  ctx3.fillText('Page 3', 50, 200)
  doc.endPage()

  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length > 0)

  // Check for multiple pages - PDF should contain page references
  const pdfContent = pdfBuffer.toString('latin1')
  t.true(pdfContent.includes('/Type /Page'))
})

test('should draw various shapes on PDF', (t) => {
  const { doc } = t.context
  const ctx = doc.beginPage(800, 600)

  // Background
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 800, 600)

  // Rectangle
  ctx.fillStyle = 'red'
  ctx.fillRect(50, 50, 100, 100)

  // Stroked rectangle
  ctx.strokeStyle = 'blue'
  ctx.lineWidth = 5
  ctx.strokeRect(200, 50, 100, 100)

  // Circle
  ctx.fillStyle = 'green'
  ctx.beginPath()
  ctx.arc(400, 100, 50, 0, Math.PI * 2)
  ctx.fill()

  // Line
  ctx.strokeStyle = 'purple'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(50, 250)
  ctx.lineTo(350, 250)
  ctx.stroke()

  // Path with bezier curves
  ctx.strokeStyle = 'orange'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(50, 350)
  ctx.bezierCurveTo(150, 300, 250, 400, 350, 350)
  ctx.stroke()

  doc.endPage()
  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length > 0)
  t.is(pdfBuffer.toString('utf8', 0, 5), '%PDF-')
})

test('should render text on PDF', async (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts-dir', 'iosevka-curly-regular.woff2'), 'i-curly')
  const { doc } = t.context
  const ctx = doc.beginPage(612, 792)

  ctx.fillStyle = 'black'
  ctx.font = '24px sans-serif'
  ctx.fillText('Hello PDF World!', 50, 100)

  ctx.font = '36px i-curly'
  ctx.fillStyle = 'blue'
  ctx.fillText('@napi-rs/canvas', 50, 200)

  ctx.strokeStyle = 'red'
  ctx.lineWidth = 1
  ctx.font = '48px sans-serif'
  ctx.strokeText('Stroked Text', 50, 300)

  doc.endPage()
  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length > 0)
  t.is(pdfBuffer.toString('utf8', 0, 5), '%PDF-')
  await writeFile(join(__dirname, 'pdf', 'text.pdf'), pdfBuffer)
})

test('should support gradients on PDF', async (t) => {
  const { doc } = t.context
  const ctx = doc.beginPage(400, 400)

  // Linear gradient
  const linearGradient = ctx.createLinearGradient(0, 0, 200, 0)
  linearGradient.addColorStop(0, 'red')
  linearGradient.addColorStop(0.5, 'yellow')
  linearGradient.addColorStop(1, 'green')
  ctx.fillStyle = linearGradient
  ctx.fillRect(50, 50, 200, 100)

  // Radial gradient
  const radialGradient = ctx.createRadialGradient(150, 250, 10, 150, 250, 80)
  radialGradient.addColorStop(0, 'white')
  radialGradient.addColorStop(1, 'blue')
  ctx.fillStyle = radialGradient
  ctx.fillRect(50, 200, 200, 150)

  doc.endPage()
  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length > 0)
  await writeFile(join(__dirname, 'pdf', 'gradients.pdf'), pdfBuffer)
})

test('should support different page sizes', async (t) => {
  const { doc } = t.context

  // A4 size (210mm x 297mm = 595pt x 842pt)
  const ctx1 = doc.beginPage(595, 842)
  ctx1.fillStyle = 'lightblue'
  ctx1.fillRect(0, 0, 595, 842)
  ctx1.fillStyle = 'black'
  ctx1.font = '20px sans-serif'
  ctx1.fillText('A4 Page', 50, 50)
  doc.endPage()

  // Letter size (8.5in x 11in = 612pt x 792pt)
  const ctx2 = doc.beginPage(612, 792)
  ctx2.fillStyle = 'lightgreen'
  ctx2.fillRect(0, 0, 612, 792)
  ctx2.fillStyle = 'black'
  ctx2.font = '20px sans-serif'
  ctx2.fillText('Letter Page', 50, 50)
  doc.endPage()

  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length > 0)

  await writeFile(join(__dirname, 'pdf', 'multi-page.pdf'), pdfBuffer)
})

test('should support PDF/A and compression settings', (t) => {
  const doc = new PDFDocument({
    title: 'Compressed PDF',
    pdfa: true,
    compressionLevel: 9, // High compression
    encodingQuality: 85,
  })

  const ctx = doc.beginPage(612, 792)
  ctx.fillStyle = 'red'
  ctx.fillRect(50, 50, 200, 200)
  doc.endPage()

  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length > 0)
  t.is(pdfBuffer.toString('utf8', 0, 5), '%PDF-')
})

test('should handle empty PDF document', (t) => {
  const { doc } = t.context
  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length == 0)
})

function countPdfImages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length
}

// REGRESSION GUARD, paired with the SVG ones in svg-canvas.spec.ts.
//
// `ctx.filter` on an explicit `saveLayer` costs the PDF backend its vector-ness:
// `SkPDFDevice::createDevice` answers a layer paint carrying an image filter
// with a raster device, and the page comes back with `/Subtype /Image` XObjects.
// A colour-only filter stays on the content paint here and keeps it vector.
test('a colour-only ctx.filter must not rasterise the page', (t) => {
  const { doc } = t.context
  const ctx = doc.beginPage(240, 200)
  ctx.filter = 'grayscale(1)'
  ctx.fillStyle = 'blue'
  ctx.fillRect(40, 40, 80, 60)
  doc.endPage()

  const pdf = doc.close()
  t.is(countPdfImages(pdf), 0, 'the page must stay vector')
})

// The other direction, and why the fix is scoped to colour-only filters:
// `blur()` has a length, that length is device-space, and only the layer can
// give it one. Rasterising is the price.
test('a spatial ctx.filter keeps its device-space layer', (t) => {
  const doc = new PDFDocument()
  const ctx = doc.beginPage(240, 200)
  ctx.filter = 'blur(3px)'
  ctx.fillStyle = 'blue'
  ctx.fillRect(40, 40, 80, 60)
  doc.endPage()

  const pdf = doc.close()
  t.true(countPdfImages(pdf) > 0, 'a blur has to go through the filter layer')
})

// The pair above pins the CONTENT pass; this pins the SHADOW pass, which picks
// its route from `shadow_takes_image_filter`. That predicate must consult
// `filter_takes_layer` too, or a page with both a colour-only `ctx.filter` and a
// zero-blur shadow rasterises through the layer the shadow keeps.
for (const filter of ['grayscale(1)', 'opacity(0.5)', 'sepia(1)', 'invert(1)', 'brightness(0.5)', 'saturate(2)']) {
  test(`a colour-only ctx.filter with a shadow must not rasterise the page (${filter})`, (t) => {
    const { doc } = t.context
    const ctx = doc.beginPage(240, 200)
    ctx.filter = filter
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
    ctx.shadowOffsetX = 40
    ctx.fillStyle = 'blue'
    ctx.fillRect(40, 40, 80, 60)
    ctx.strokeStyle = 'red'
    ctx.lineWidth = 6
    ctx.strokeRect(40, 120, 80, 60)
    doc.endPage()

    const pdf = doc.close()
    t.is(countPdfImages(pdf), 0, 'the shadowed page must stay vector')
  })
}

// KNOWN LIMITATION, deliberately pinned -- the one cell the rescue above gives
// back. On `windows-11-arm` a PDF glyph run drawn through a colour-filtered
// paint faults with 0xC0000005; a glyph run is the one draw whose colour filter
// reaches SkPDFDevice's strike machinery rather than only the blitter
// (`internalDrawGlyphRun` passes the raw paint, src/pdf/SkPDFDevice.cpp:948). So
// `filter_takes_layer` keeps the layer for PDF glyphs and PDF text under a
// colour-only `ctx.filter` rasterises. SVG keeps its text rescue.
test('a colour-only ctx.filter with a text shadow rasterises the page on PDF', (t) => {
  GlobalFonts.registerFromPath(join(__dirname, 'fonts-dir', 'iosevka-curly-regular.woff2'), 'i-curly')
  const { doc } = t.context
  const ctx = doc.beginPage(240, 200)
  ctx.filter = 'grayscale(1)'
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
  ctx.shadowOffsetX = 40
  ctx.fillStyle = 'blue'
  ctx.font = '30px i-curly'
  ctx.fillText('napi-rs', 40, 100)
  doc.endPage()

  const pdf = doc.close()
  t.true(countPdfImages(pdf) > 0, 'PDF glyphs keep the layer, so the page rasterises')
})

// The split itself, pinned from both sides so neither half can flip silently:
// the same scene, filter and shadow, differing only in whether the draw emits a
// glyph run. `fillRect` stays vector; `fillText` takes the layer.
for (const filter of ['grayscale(1)', 'opacity(0.5)', 'invert(1)']) {
  test(`only GLYPHS lose the colour-only rescue on PDF (${filter})`, (t) => {
    GlobalFonts.registerFromPath(join(__dirname, 'fonts-dir', 'iosevka-curly-regular.woff2'), 'i-curly')

    const scene = (draw: (ctx: ReturnType<PDFDocument['beginPage']>) => void) => {
      const doc = new PDFDocument()
      const ctx = doc.beginPage(240, 200)
      ctx.filter = filter
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
      ctx.shadowOffsetX = 40
      ctx.fillStyle = 'blue'
      ctx.font = '30px i-curly'
      draw(ctx)
      doc.endPage()
      return countPdfImages(doc.close())
    }

    t.is(
      scene((ctx) => ctx.fillRect(40, 40, 80, 60)),
      0,
      'geometry keeps the rescue and stays vector',
    )
    t.true(scene((ctx) => ctx.fillText('napi-rs', 40, 100)) > 0, 'glyphs keep the layer and rasterise')
  })
}

// And the other direction, with a shadow this time: a spatial `ctx.filter` still
// needs the layer, so the page still rasterises. `main` did the same.
test('a spatial ctx.filter with a shadow keeps its device-space layer', (t) => {
  const doc = new PDFDocument()
  const ctx = doc.beginPage(240, 200)
  ctx.filter = 'blur(3px)'
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)'
  ctx.shadowOffsetX = 40
  ctx.fillStyle = 'blue'
  ctx.fillRect(40, 40, 80, 60)
  doc.endPage()

  const pdf = doc.close()
  t.true(countPdfImages(pdf) > 0, 'a blur has to go through the filter layer')
})
