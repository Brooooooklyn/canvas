// Default state and the fillStyle / strokeStyle / shadowColor getters.
// Expected values were measured in Chrome 155 (--disable-gpu, a
// willReadFrequently canvas in a standards-mode page); arm64 and x64 gave the
// same results. SvgCanvas and PDF pages have no Chrome counterpart: they
// follow the same rules (HTML spec).
import test from 'ava'

import { createCanvas, PDFDocument, SvgExportFlag } from '../index'

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>

const px = (ctx: Ctx, x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data)

test('shadowColor defaults to transparent black', (t) => {
  for (const canvas of [createCanvas(20, 20), createCanvas(20, 20, SvgExportFlag.ConvertTextToPaths)]) {
    const ctx = canvas.getContext('2d')
    t.is(ctx.shadowColor, 'rgba(0, 0, 0, 0)')
    ctx.shadowColor = 'red'
    ctx.reset()
    t.is(ctx.shadowColor, 'rgba(0, 0, 0, 0)')
    ctx.shadowColor = 'red'
    // eslint-disable-next-line no-self-assign
    canvas.width = canvas.width
    t.is(ctx.shadowColor, 'rgba(0, 0, 0, 0)')
    ctx.shadowColor = 'red'
    canvas.height = 25
    t.is(ctx.shadowColor, 'rgba(0, 0, 0, 0)')
  }
  const doc = new PDFDocument()
  t.is(doc.beginPage(20, 20).shadowColor, 'rgba(0, 0, 0, 0)')
  doc.endPage()
  doc.close()
})

test('shadowBlur and shadowOffset alone draw no shadow', (t) => {
  const ctx = createCanvas(30, 20).getContext('2d')
  ctx.shadowBlur = 6
  ctx.shadowOffsetX = 8
  ctx.fillStyle = '#00f'
  ctx.fillRect(5, 5, 10, 10)
  t.deepEqual(px(ctx, 20, 10), [0, 0, 0, 0])
  t.deepEqual(px(ctx, 10, 10), [0, 0, 255, 255])

  const ctx2 = createCanvas(40, 20).getContext('2d')
  ctx2.shadowOffsetX = 20
  ctx2.fillRect(0, 0, 10, 10)
  t.deepEqual(px(ctx2, 25, 5), [0, 0, 0, 0])
  t.deepEqual(px(ctx2, 5, 5), [0, 0, 0, 255])
})

test('SvgCanvas: no shadow without a shadowColor', (t) => {
  const draw = (shadow: boolean) => {
    const canvas = createCanvas(30, 20, SvgExportFlag.NoPrettyXML)
    const ctx = canvas.getContext('2d')
    if (shadow) {
      ctx.shadowBlur = 6
      ctx.shadowOffsetX = 8
    }
    ctx.fillStyle = '#00f'
    ctx.fillRect(5, 5, 10, 10)
    return canvas.getContent().toString()
  }
  t.is(draw(true), draw(false))
})
