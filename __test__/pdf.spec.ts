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
