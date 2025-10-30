import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import ava, { TestFn } from 'ava'

import { PDFDocument } from '../index'

const __dirname = dirname(fileURLToPath(import.meta.url))

const test = ava as TestFn<{
  doc: PDFDocument
}>

test.beforeEach((t) => {
  t.context.doc = new PDFDocument()
})

test('should create PDF with URL link annotation', async (t) => {
  const { doc } = t.context
  const ctx = doc.beginPage(612, 792)

  // Draw a clickable link
  ctx.fillStyle = 'blue'
  ctx.fillRect(50, 50, 200, 40)
  ctx.fillStyle = 'white'
  ctx.font = '20px sans-serif'
  ctx.fillText('Click here to visit GitHub', 60, 75)

  // Add URL annotation
  ctx.annotateLinkUrl(50, 50, 250, 90, 'https://github.com/Brooooooklyn/canvas')

  doc.endPage()
  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length > 0)
  t.is(pdfBuffer.toString('utf8', 0, 5), '%PDF-')

  // Check for annotation in PDF content - look for various annotation indicators
  const pdfContent = pdfBuffer.toString('latin1')
  const hasAnnotation = pdfContent.includes('/Annot') || 
                        pdfContent.includes('/URI') || 
                        pdfContent.includes('github.com')
  t.true(hasAnnotation, 'PDF should contain annotation indicators')

  await writeFile(join(__dirname, 'pdf', 'link-annotation.pdf'), pdfBuffer)
})

test('should create PDF with named destination and link to it', async (t) => {
  const { doc } = t.context

  // Page 1 - Create link to destination
  const ctx1 = doc.beginPage(612, 792)
  ctx1.fillStyle = 'black'
  ctx1.font = '24px sans-serif'
  ctx1.fillText('Table of Contents', 50, 50)

  // Draw a clickable link to page 2
  ctx1.fillStyle = 'blue'
  ctx1.fillRect(50, 100, 200, 30)
  ctx1.fillStyle = 'white'
  ctx1.font = '18px sans-serif'
  ctx1.fillText('Go to Chapter 1', 60, 120)

  // Add link to named destination
  ctx1.annotateLinkToDestination(50, 100, 250, 130, 'chapter1')

  doc.endPage()

  // Page 2 - Create the destination
  const ctx2 = doc.beginPage(612, 792)

  // Create named destination at the top of page 2
  ctx2.annotateNamedDestination(50, 50, 'chapter1')

  ctx2.fillStyle = 'black'
  ctx2.font = '30px sans-serif'
  ctx2.fillText('Chapter 1', 50, 100)
  ctx2.font = '16px sans-serif'
  ctx2.fillText('This is the content of chapter 1.', 50, 150)

  doc.endPage()

  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length > 0)
  t.is(pdfBuffer.toString('utf8', 0, 5), '%PDF-')

  await writeFile(join(__dirname, 'pdf', 'named-destination.pdf'), pdfBuffer)
})

test('should create PDF with multiple URL links', async (t) => {
  const { doc } = t.context
  const ctx = doc.beginPage(612, 792)

  ctx.fillStyle = 'black'
  ctx.font = '24px sans-serif'
  ctx.fillText('Useful Links', 50, 50)

  const links = [
    { text: 'GitHub Repository', url: 'https://github.com/Brooooooklyn/canvas', y: 100 },
    { text: 'NPM Package', url: 'https://www.npmjs.com/package/@napi-rs/canvas', y: 160 },
    { text: 'Documentation', url: 'https://github.com/Brooooooklyn/canvas#readme', y: 220 },
  ]

  links.forEach((link, index) => {
    // Draw link background
    ctx.fillStyle = 'lightblue'
    ctx.fillRect(50, link.y, 300, 40)

    // Draw link text
    ctx.fillStyle = 'darkblue'
    ctx.font = '18px sans-serif'
    ctx.fillText(link.text, 60, link.y + 25)

    // Add URL annotation
    ctx.annotateLinkUrl(50, link.y, 350, link.y + 40, link.url)
  })

  doc.endPage()
  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length > 0)

  await writeFile(join(__dirname, 'pdf', 'multiple-links.pdf'), pdfBuffer)
})

test('should create table of contents with multiple named destinations', async (t) => {
  const { doc } = t.context

  // Table of Contents page
  const toc = doc.beginPage(612, 792)
  toc.fillStyle = 'black'
  toc.font = '30px sans-serif'
  toc.fillText('Table of Contents', 50, 50)

  const chapters = [
    { title: 'Chapter 1: Introduction', dest: 'intro', y: 120 },
    { title: 'Chapter 2: Getting Started', dest: 'getting-started', y: 160 },
    { title: 'Chapter 3: Advanced Topics', dest: 'advanced', y: 200 },
    { title: 'Chapter 4: Conclusion', dest: 'conclusion', y: 240 },
  ]

  toc.font = '18px sans-serif'
  chapters.forEach((chapter) => {
    toc.fillStyle = 'blue'
    toc.fillText(chapter.title, 70, chapter.y)
    toc.annotateLinkToDestination(70, chapter.y - 20, 400, chapter.y + 5, chapter.dest)
  })

  doc.endPage()

  // Create pages for each chapter
  chapters.forEach((chapter, index) => {
    const ctx = doc.beginPage(612, 792)
    ctx.annotateNamedDestination(50, 50, chapter.dest)
    ctx.fillStyle = 'black'
    ctx.font = '30px sans-serif'
    ctx.fillText(chapter.title.split(':')[0], 50, 100)
    ctx.font = '18px sans-serif'
    ctx.fillText(`Content of ${chapter.title.toLowerCase()}`, 50, 150)
    doc.endPage()
  })

  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length > 0)

  await writeFile(join(__dirname, 'pdf', 'toc-with-destinations.pdf'), pdfBuffer)
})

test('should handle empty string URL gracefully', (t) => {
  const { doc } = t.context
  const ctx = doc.beginPage(612, 792)

  ctx.fillStyle = 'black'
  ctx.fillRect(50, 50, 100, 100)

  // Should not crash with empty URL
  t.notThrows(() => {
    ctx.annotateLinkUrl(50, 50, 150, 150, '')
  })

  doc.endPage()
  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
})

test('should handle annotations with special characters in URL', async (t) => {
  const { doc } = t.context
  const ctx = doc.beginPage(612, 792)

  ctx.fillStyle = 'blue'
  ctx.fillRect(50, 50, 300, 40)
  ctx.fillStyle = 'white'
  ctx.font = '16px sans-serif'
  ctx.fillText('Link with special chars', 60, 75)

  // URL with query parameters and special characters
  const specialUrl = 'https://example.com/search?q=test&lang=en&special=äöü'
  ctx.annotateLinkUrl(50, 50, 350, 90, specialUrl)

  doc.endPage()
  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length > 0)

  await writeFile(join(__dirname, 'pdf', 'special-chars-link.pdf'), pdfBuffer)
})

test('should support annotations on rotated/transformed canvas', async (t) => {
  const { doc } = t.context
  const ctx = doc.beginPage(612, 792)

  // Draw without transformation
  ctx.fillStyle = 'red'
  ctx.fillRect(50, 50, 100, 40)
  ctx.annotateLinkUrl(50, 50, 150, 90, 'https://example.com/normal')

  // Apply transformation and draw
  ctx.save()
  ctx.translate(300, 300)
  ctx.rotate((45 * Math.PI) / 180)

  ctx.fillStyle = 'blue'
  ctx.fillRect(-50, -20, 100, 40)
  // Note: Annotation coordinates should be in the transformed space
  ctx.annotateLinkUrl(-50, -20, 50, 20, 'https://example.com/rotated')

  ctx.restore()

  doc.endPage()
  const pdfBuffer = doc.close()

  t.true(pdfBuffer instanceof Buffer)
  t.true(pdfBuffer.length > 0)

  await writeFile(join(__dirname, 'pdf', 'transformed-annotations.pdf'), pdfBuffer)
})
