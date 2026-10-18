// Hand-made one-page PDFs for pdfjs-malformed.spec.ts. Every page is 200 x 200
// and draws a red square at (10, 10)-(40, 40) BEFORE the case's operators, the
// case's operators, then a green square at (150, 10)-(180, 40) AFTER them. At
// scale 1 the squares are at canvas pixels (25, 175) and (165, 175).
import { deflateSync } from 'node:zlib'

// pdf.js's Lexer.getNumber: 401 digits are Infinity; 401 digits, '.' and 400
// digits are Infinity / Infinity = NaN.
const INF = '1' + '0'.repeat(400)
const NAN = INF + '.' + '0'.repeat(400)
const BIG = '1' + '0'.repeat(308) // 1e308, finite
const E20 = '1' + '0'.repeat(20)
const E38 = '1' + '0'.repeat(38)
const E38x3 = '3' + '0'.repeat(38)
const E200 = '1' + '0'.repeat(200)

type Stream = { dict: string; data: Buffer }
type PdfObject = string | Stream

const latin1 = (s: string) => Buffer.from(s, 'latin1')

// Objects: 1 catalog, 2 pages, 3 page, 4 contents, 5... `extra`.
function pdf(
  resources: string,
  content: string,
  extra: PdfObject[] = [],
  { mediaBox = '[0 0 200 200]', pageExtra = '' } = {},
): Buffer {
  const objs: PdfObject[] = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox} ${pageExtra} /Resources ${resources} /Contents 4 0 R >>`
  objs[4] = { dict: '', data: latin1(`1 0 0 rg 10 10 30 30 re f\n${content}\n0 1 0 rg 150 10 30 30 re f\n`) }
  extra.forEach((o, i) => (objs[5 + i] = o))
  const chunks = [latin1('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')]
  let offset = chunks[0].length
  const offsets: number[] = []
  for (let i = 1; i < objs.length; i++) {
    const o = objs[i]
    const b =
      typeof o === 'string'
        ? latin1(`${i} 0 obj\n${o}\nendobj\n`)
        : Buffer.concat([
            latin1(`${i} 0 obj\n<< ${o.dict} /Length ${o.data.length} >>\nstream\n`),
            o.data,
            latin1('\nendstream\nendobj\n'),
          ])
    offsets[i] = offset
    chunks.push(b)
    offset += b.length
  }
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`
  for (let i = 1; i < objs.length; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  xref += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`
  chunks.push(latin1(xref))
  return Buffer.concat(chunks)
}

const image = (dict: string, data: Buffer): Stream => ({ dict: `/Type /XObject /Subtype /Image ${dict}`, data })
const mask = (width: string | number, height = 16, data = Buffer.alloc(16, 0)) =>
  image(`/Width ${width} /Height ${height} /ImageMask true /BitsPerComponent 1`, data)
// Im1 drawn 100 x 100 at (50, 50); a mask paints blue.
const drawIm1 = (blue = true) => `${blue ? '0 0 1 rg ' : ''}q 100 0 0 100 50 50 cm /Im1 Do Q`
const IM1 = '<< /XObject << /Im1 5 0 R >> >>'

const tilePattern = (bbox: string, xstep: string | number, ystep: string | number): Stream => ({
  dict: `/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox ${bbox} /XStep ${xstep} /YStep ${ystep} /Resources << >>`,
  data: latin1('0 0 1 rg 0 0 5 5 re f'),
})
const tile = (bbox: string, xstep: string | number, ystep: string | number) =>
  pdf('<< /Pattern << /P1 5 0 R >> >>', '/Pattern cs /P1 scn 50 50 100 100 re f', [tilePattern(bbox, xstep, ystep)])

// An isolated transparency group drawn with ca 0.5 (pdf.js draws it on its
// own canvas).
const group = (pre: string, bbox: string, matrix = '') =>
  pdf('<< /XObject << /Fm1 5 0 R >> /ExtGState << /GS1 << /ca 0.5 >> >> >>', `q ${pre} /GS1 gs /Fm1 Do Q`, [
    {
      dict: `/Type /XObject /Subtype /Form /BBox ${bbox} ${matrix} /Group << /S /Transparency /I true >> /Resources << >>`,
      data: latin1('0 0 1 rg 0 0 100 100 re f'),
    },
  ])
const form = (groupDict: string, body = '0 0 1 rg 0 0 100 100 re f'): Stream => ({
  dict: `/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency ${groupDict} >> /Resources << >>`,
  data: latin1(body),
})
const CA = '/ExtGState << /GS1 << /ca 0.5 >> >>'
const SMASK = '<< /ExtGState << /GS1 << /SMask << /S /Luminosity /G 5 0 R >> >> >> >>'
// Two `1e20 0 0 1e20 0 0 cm`: the float CTM overflows.
const OVF = `${E20} 0 0 ${E20} 0 0 cm ${E20} 0 0 ${E20} 0 0 cm`

// Axial (2) or radial (3) shadings, painted with `sh` or as a fill pattern.
const FN = '<< /FunctionType 2 /Domain [0 1] /C0 [1 1 0] /C1 [0 0 1] /N 1 >>'
const shading = (type: number, coords: string) =>
  `/ShadingType ${type} /ColorSpace /DeviceRGB /Coords ${coords} /Function ${FN} /Extend [true true]`
const sh = (type: number, coords: string) =>
  pdf('<< /Shading << /Sh1 5 0 R >> >>', 'q 50 50 100 100 re W n /Sh1 sh Q', [`<< ${shading(type, coords)} >>`])
// The pattern /Matrix makes a 1e308 coordinate overflow in pdf.js's
// Util.applyTransform.
const shpat = (type: number, coords: string, matrix = '') =>
  pdf('<< /Pattern << /P1 5 0 R >> >>', '/Pattern cs /P1 scn 50 50 100 100 re f', [
    `<< /Type /Pattern /PatternType 2 ${matrix && `/Matrix ${matrix}`} /Shading << ${shading(type, coords)} >> >>`,
  ])

const mask05 = () => mask(0.5)
const repeat12 = (op: (i: number) => string) => Array.from({ length: 12 }, (_, i) => op(i)).join(' ')

export const pdfs = {
  ok_base: pdf('<< >>', ''),

  // Image /Width 0.5 or Infinity: pdf.js calls createImageData(width, 16).
  r1_mask_w05: pdf(IM1, drawIm1(), [mask05()]),
  r1_mask_winf: pdf(IM1, drawIm1(), [mask(INF)]),
  r1_rgb_w05: pdf(IM1, drawIm1(false), [
    image('/Width 0.5 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8', Buffer.alloc(64, 0x40)),
  ]),
  r1_rgb_w05_flate: pdf(IM1, drawIm1(false), [
    image(
      '/Width 0.5 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode',
      deflateSync(Buffer.alloc(64, 0x40)),
    ),
  ]),
  r1_gray1_w05: pdf(IM1, drawIm1(false), [
    image('/Width 0.5 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 1', Buffer.alloc(16, 0)),
  ]),
  r1_mask_w1_ok: pdf(IM1, drawIm1(), [mask(2)]),
  // A 200 x 200 gray group: pdf.js reads it with getImageData.
  r2_gray_group: pdf('<< /XObject << /Fm1 5 0 R >> >>', 'q /Fm1 Do Q', [
    {
      dict: '/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Group << /S /Transparency /CS /DeviceGray >> /Resources << >>',
      data: latin1('0 0 1 rg 50 50 100 100 re f'),
    },
  ]),
  // A non-finite /BBox: pdf.js drops it, so the group canvas is the page's.
  r2_gray_group_nobbox: pdf('<< /XObject << /Fm1 5 0 R >> >>', 'q /Fm1 Do Q', [
    {
      dict: `/Type /XObject /Subtype /Form /BBox [0 0 ${INF} 200] /Group << /S /Transparency /CS /DeviceGray >> /Resources << >>`,
      data: latin1('0 0 1 rg 50 50 100 100 re f'),
    },
  ]),

  // NaN or Infinity sizes: pdf.js calls createCanvas(NaN, ...) for tiles and
  // groups.
  r24_tile_ok: tile('[0 0 10 10]', 10, 10),
  r24_tile_xstep_nan: tile('[0 0 10 10]', NAN, 10),
  r24_tile_ystep_nan: tile('[0 0 10 10]', 10, NAN),
  r24_tile_bbox_infinf: tile(`[${INF} 0 ${INF} 10]`, 10, 10),
  r24_tile_bbox_nan: tile(`[0 0 ${NAN} 10]`, 10, 10),
  r24_group_ok: group('1 0 0 1 50 50 cm', '[0 0 100 100]'),
  r24_group_bbox_nan: group('1 0 0 1 50 50 cm', `[0 0 ${NAN} 100]`),
  r24_group_bbox_inf: group('0 1 -1 0 150 50 cm', `[0 0 ${INF} 100]`),
  r24_group_ctm_inf: group(`${INF} 0 0 1 50 50 cm`, '[0 0 100 100]'),
  r24_group_ctm_big_shear: group(`${BIG} ${BIG} ${BIG} ${BIG} 0 0 cm`, '[-100 -100 100 100]'),
  r24_group_matrix_inf: group('1 0 0 1 50 50 cm', '[0 0 100 100]', `/Matrix [${INF} 0 0 1 0 0]`),
  r24_group_big_bbox_shear: group('1 1 -1 1 100 100 cm', `[-${E38x3} -${E38x3} ${E38x3} ${E38x3}]`),
  r24_group_ctm_overflow_e20x2: group(OVF, '[0 0 100 100]'),
  r24_group_ctm_overflow_e200x2: group(`${E200} 0 0 ${E200} 0 0 cm ${E200} 0 0 ${E200} 0 0 cm`, '[0 0 100 100]'),
  r24_group_ctm_overflow_e38x9: group(Array(9).fill(`${E38} 0 0 ${E38} 0 0 cm`).join(' '), '[0 0 100 100]'),

  // Non-finite or overflowing gradient coordinates, and negative radii.
  r28_axial_ok: sh(2, '[50 0 150 0]'),
  r28_axial_inf: sh(2, `[0 0 ${INF} 0]`),
  r28_axial_nan: sh(2, `[0 0 ${NAN} 0]`),
  r28_axial_inf_x0: sh(2, `[${INF} 0 100 0]`),
  r28_radial_inf: sh(3, `[100 100 0 100 100 ${INF}]`),
  r28_radial_inf_center: sh(3, `[${INF} 100 0 100 100 50]`),
  r28_radial_inf_r0: sh(3, `[100 100 ${INF} 100 100 50]`),
  r28_radial_nan_r1: sh(3, `[100 100 0 100 100 ${NAN}]`),
  r28_radial_big_r1: sh(3, `[100 100 0 100 100 ${BIG}]`),
  r28_radial_neg: sh(3, '[100 100 -5 100 100 50]'),
  r28_radial_neg_r1: sh(3, '[100 100 0 100 100 -50]'),
  r28_pat_axial_ok: shpat(2, '[0 0 150 0]'),
  r28_pat_axial_inf: shpat(2, `[0 0 ${INF} 0]`),
  r28_pat_axial_overflow: shpat(2, `[0 0 ${BIG} 0]`, '[10 0 0 10 0 0]'),
  r28_pat_radial_inf_r1: shpat(3, `[0 0 0 0 0 ${INF}]`),
  r28_pat_radial_overflow: shpat(3, `[0 0 0 0 0 ${BIG}]`, '[10 0 0 10 0 0]'),
  r28_pat_radial_neg: shpat(3, '[0 0 -5 0 0 80]'),

  // Groups, soft masks, transfer functions and tiles under the overflowing
  // CTM: pdf.js calls createCanvas(NaN, NaN), then reads it back.
  e_knockout_ovf: pdf(`<< /XObject << /Fm1 5 0 R >> ${CA} >>`, `q ${OVF} /GS1 gs /Fm1 Do Q`, [form('/I true /K true')]),
  e_gray_ovf: pdf(`<< /XObject << /Fm1 5 0 R >> ${CA} >>`, `q ${OVF} /GS1 gs /Fm1 Do Q`, [
    form('/I true /CS /DeviceGray'),
  ]),
  e_tr_ovf: pdf(
    '<< /XObject << /Fm1 5 0 R >> /ExtGState << /GS1 << /ca 0.5 /TR << /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [0] /N 1 >> >> >> >>',
    `q ${OVF} /GS1 gs /Fm1 Do Q`,
    [form('/I true')],
  ),
  e_smask_ovf: pdf(SMASK, `q ${OVF} /GS1 gs 0 0 1 rg 0 0 1 1 re f Q`, [
    form('/CS /DeviceGray', '1 g 0 0 100 100 re f'),
  ]),
  e_smask_ok: pdf(SMASK, 'q /GS1 gs 0 0 1 rg 50 50 100 100 re f Q', [form('/CS /DeviceGray', '1 g 0 0 200 200 re f')]),
  e_tile_ovf: pdf('<< /Pattern << /P1 5 0 R >> >>', `q ${OVF} /Pattern cs /P1 scn 0 0 1e-30 1e-30 re f Q`, [
    tilePattern('[0 0 10 10]', 10, 10),
  ]),
  // pdf.js throws "Invalid canvas size" for a 0 tile size.
  e_tile_xstep0: tile('[0 0 10 10]', 0, 10),
  e_tile_all_nan: tile(`[0 0 ${NAN} 10]`, NAN, NAN),
  // /Width 0.5 masks drawn twice (pdf.js caches them), 12 times, and 12
  // different ones.
  e_mask05_twice: pdf(IM1, '0 0 1 rg q 50 0 0 50 50 50 cm /Im1 Do Q q 50 0 0 50 100 100 cm /Im1 Do Q', [mask05()]),
  e_mask05_repeat12: pdf(IM1, '0 0 1 rg ' + repeat12((i) => `q 8 0 0 8 ${50 + i * 8} 100 cm /Im1 Do Q`), [mask05()]),
  e_mask05_group12: pdf(
    `<< /XObject << ${repeat12((i) => `/M${i} ${5 + i} 0 R`)} >> >>`,
    '0 0 1 rg ' + repeat12((i) => `q 8 0 0 8 ${50 + i * 8} 100 cm /M${i} Do Q`),
    Array.from({ length: 12 }, mask05),
  ),
  // pdf.js throws "Invalid canvas size" for create(-3, 16).
  e_mask_wneg: pdf(IM1, drawIm1(), [mask(-3)]),
  // An inline image /W 0.5; pdf.js throws a RangeError on main too.
  e_inline_w05: pdf('<< >>', `q 100 0 0 100 50 50 cm BI /W 0.5 /H 16 /CS /G /BPC 8 ID ${'@'.repeat(16)} EI Q`),
  // Viewports of Infinity x 200 and 0.2 x 0.2: the page canvas is
  // createCanvas(viewport.width, viewport.height).
  e_mediabox_inf: pdf('<< >>', '', [], { mediaBox: `[0 0 ${INF} 200]` }),
  e_userunit_tiny: pdf('<< >>', '', [], { pageExtra: '/UserUnit 0.001' }),
  e_userunit_tiny_transp: pdf(`<< /XObject << /Fm1 5 0 R >> ${CA} >>`, 'q /GS1 gs /Fm1 Do Q', [form('/I true')], {
    pageExtra: '/UserUnit 0.001',
  }),
  // pdf.js downscales a 64 x 64 image drawn 4 x 4 in halving steps
  // (canvasFactory.reset), and a 0.5-wide mask drawn 2 x 2.
  e_img_downscale: pdf(IM1, 'q 4 0 0 4 98 98 cm /Im1 Do Q', [
    image('/Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8', Buffer.alloc(64 * 64 * 3, 0x20)),
  ]),
  e_mask05_downscale: pdf(IM1, '0 0 1 rg q 2 0 0 2 99 99 cm /Im1 Do Q', [mask05()]),
  // A 70000 x 1 mask or image: a canvas side over 65535 with a tiny area.
  e_mask_w70000: pdf(IM1, drawIm1(), [mask(70000, 1, Buffer.alloc(8750, 0))]),
  e_img_w70000: pdf(IM1, drawIm1(false), [
    image('/Width 70000 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8', Buffer.alloc(70000 * 3, 0x20)),
  ]),
  // A tiling pattern chosen under a soft mask, used after the mask is gone.
  e_pattern_after_smask: pdf(
    '<< /Pattern << /P1 6 0 R >> /ExtGState << /GS1 << /SMask << /S /Luminosity /G 5 0 R >> >> /GS2 << /SMask /None >> >> >>',
    'q /GS1 gs /Pattern cs /P1 scn /GS2 gs 50 50 100 100 re f Q',
    [form('/CS /DeviceGray', '1 g 0 0 200 200 re f'), tilePattern('[0 0 10 10]', 10, 10)],
  ),
}
