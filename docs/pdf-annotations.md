# PDF Annotations API

This document describes the new PDF annotation APIs added to `@napi-rs/canvas` for adding interactive elements to PDF documents.

## Overview

The PDF annotations API allows you to add clickable links and named destinations to PDF documents created with `PDFDocument`. These annotations are particularly useful for creating interactive PDFs with external links, table of contents, and cross-references.

## API Methods

All annotation methods are available on the `CanvasRenderingContext2D` object returned by `PDFDocument.beginPage()`.

### annotateLinkUrl

Creates a clickable URL link annotation in a PDF document.

```typescript
ctx.annotateLinkUrl(left: number, top: number, right: number, bottom: number, url: string): void
```

**Parameters:**
- `left`: Left coordinate of the link rectangle
- `top`: Top coordinate of the link rectangle  
- `right`: Right coordinate of the link rectangle
- `bottom`: Bottom coordinate of the link rectangle
- `url`: The URL to link to

**Example:**
```typescript
const doc = new PDFDocument()
const ctx = doc.beginPage(612, 792)

// Draw a clickable button
ctx.fillStyle = 'blue'
ctx.fillRect(50, 50, 200, 40)
ctx.fillStyle = 'white'
ctx.font = '20px sans-serif'
ctx.fillText('Visit GitHub', 60, 75)

// Add URL annotation
ctx.annotateLinkUrl(50, 50, 250, 90, 'https://github.com')

doc.endPage()
const pdfBuffer = doc.close()
```

### annotateNamedDestination

Creates a named destination at a specific point in a PDF document. This destination can be used as a target for internal links.

```typescript
ctx.annotateNamedDestination(x: number, y: number, name: string): void
```

**Parameters:**
- `x`: X coordinate of the destination point
- `y`: Y coordinate of the destination point
- `name`: Name identifier for the destination

**Example:**
```typescript
const doc = new PDFDocument()

// Page 1
const ctx1 = doc.beginPage(612, 792)
ctx1.fillText('Table of Contents', 50, 50)
doc.endPage()

// Page 2 - Create named destination
const ctx2 = doc.beginPage(612, 792)
ctx2.annotateNamedDestination(50, 50, 'chapter1')
ctx2.fillText('Chapter 1', 50, 100)
doc.endPage()

const pdfBuffer = doc.close()
```

### annotateLinkToDestination

Creates a link to a named destination within the PDF document.

```typescript
ctx.annotateLinkToDestination(left: number, top: number, right: number, bottom: number, name: string): void
```

**Parameters:**
- `left`: Left coordinate of the link rectangle
- `top`: Top coordinate of the link rectangle
- `right`: Right coordinate of the link rectangle
- `bottom`: Bottom coordinate of the link rectangle
- `name`: Name of the destination to link to

**Example:**
```typescript
const doc = new PDFDocument()

// Page 1 - Create link to destination
const ctx1 = doc.beginPage(612, 792)
ctx1.fillText('Go to Chapter 1', 50, 100)
ctx1.annotateLinkToDestination(50, 80, 200, 120, 'chapter1')
doc.endPage()

// Page 2 - Create the destination
const ctx2 = doc.beginPage(612, 792)
ctx2.annotateNamedDestination(50, 50, 'chapter1')
ctx2.fillText('Chapter 1', 50, 100)
doc.endPage()

const pdfBuffer = doc.close()
```

## Complete Example: Table of Contents

Here's a complete example showing how to create a PDF with a clickable table of contents:

```typescript
import { PDFDocument } from '@napi-rs/canvas'
import { writeFile } from 'fs/promises'

const doc = new PDFDocument({
  title: 'Document with TOC',
  author: 'Your Name',
})

// Create table of contents page
const toc = doc.beginPage(612, 792)
toc.fillStyle = 'black'
toc.font = '30px sans-serif'
toc.fillText('Table of Contents', 50, 50)

const chapters = [
  { title: 'Chapter 1: Introduction', dest: 'intro', y: 120 },
  { title: 'Chapter 2: Getting Started', dest: 'start', y: 160 },
  { title: 'Chapter 3: Advanced Topics', dest: 'advanced', y: 200 },
]

toc.font = '18px sans-serif'
chapters.forEach((chapter) => {
  toc.fillStyle = 'blue'
  toc.fillText(chapter.title, 70, chapter.y)
  toc.annotateLinkToDestination(70, chapter.y - 20, 400, chapter.y + 5, chapter.dest)
})

doc.endPage()

// Create pages for each chapter
chapters.forEach((chapter) => {
  const ctx = doc.beginPage(612, 792)
  
  // Create named destination at top of page
  ctx.annotateNamedDestination(50, 50, chapter.dest)
  
  // Add chapter content
  ctx.fillStyle = 'black'
  ctx.font = '30px sans-serif'
  ctx.fillText(chapter.title.split(':')[0], 50, 100)
  ctx.font = '18px sans-serif'
  ctx.fillText(`Content of ${chapter.title.toLowerCase()}`, 50, 150)
  
  doc.endPage()
})

const pdfBuffer = doc.close()
await writeFile('document-with-toc.pdf', pdfBuffer)
```

## Important Notes

1. **PDF-Only Feature**: These annotation methods are specifically designed for PDF documents created with `PDFDocument`. They will have no effect when used with regular canvas or SVG canvas.

2. **Coordinate System**: All coordinates are in the canvas coordinate system (points), with the origin at the top-left corner.

3. **Destination Names**: Named destinations must be unique within the PDF document. Using the same name multiple times will create multiple destinations with the same name, which may cause unpredictable behavior.

4. **URL Encoding**: URLs with special characters should be properly encoded before passing to `annotateLinkUrl`.

5. **Transformed Canvas**: When using transformations (rotate, scale, translate), annotation coordinates should be specified in the transformed coordinate space.

## Browser Support

PDF annotations are standard features supported by all major PDF viewers including:
- Adobe Acrobat Reader
- Preview (macOS)
- Chrome PDF Viewer
- Firefox PDF Viewer
- Edge PDF Viewer

## Testing

The test suite includes comprehensive tests for all annotation features. Run tests with:

```bash
yarn test __test__/pdf-annotations.spec.ts
```

## See Also

- [PDFDocument API Documentation](./README.md#pdfdocument)
- [Skia SkAnnotation Documentation](https://api.skia.org/classSkAnnotation.html)
