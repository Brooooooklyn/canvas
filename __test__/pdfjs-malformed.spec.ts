// pdf.js must draw malformed PDFs at least as well as main (1.0.11) did.
//
// pdf.js (pdfjs-dist, legacy build) draws in Node with this package: its
// NodeCanvasFactory calls require('@napi-rs/canvas').createCanvas(w, h).
// Malformed PDFs reach the canvas API as NaN, Infinity or 0.5 sizes and
// non-finite gradient coordinates, where Chrome throws; pdf.js has no guard
// for them, and a throw rejects the whole page render. Each PDF here is one
// page (pdfjs-malformed-pdfs.ts) with a red square drawn before the bad
// operators and a green square after them. The expected outcome of each case
// is main's.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import test from 'ava'

import { pdfs } from './pdfjs-malformed-pdfs'

type Outcome =
  /** The render resolves, with the red and the green square. */
  | 'draws'
  /**
   * As 'draws', but the case paints over the red square, as Chrome does
   * (main drew nothing there).
   */
  | 'draws-over'
  /** As 'draws', and the image at (100, 100) is painted. */
  | 'paints'
  /**
   * The render resolves on a page canvas made from a non-finite or tiny
   * viewport: the canvas has pixels and (100, 100) is white.
   */
  | 'blank'
  /** The render rejects, as on main. */
  | 'rejects'

const EXPECTED: Record<keyof typeof pdfs, Outcome> = {
  ok_base: 'draws',
  r1_mask_w1_ok: 'draws',
  r2_gray_group: 'draws',
  r2_gray_group_nobbox: 'draws',
  r24_tile_ok: 'draws',
  r24_tile_bbox_infinf: 'draws',
  r24_tile_bbox_nan: 'draws',
  r24_group_ok: 'draws',
  r24_group_bbox_inf: 'draws',
  r24_group_bbox_nan: 'draws',
  r24_group_big_bbox_shear: 'draws',
  r24_group_ctm_big_shear: 'draws',
  r24_group_matrix_inf: 'draws',
  r28_axial_ok: 'draws',
  r28_pat_axial_ok: 'draws',
  r28_radial_big_r1: 'draws',
  e_smask_ok: 'draws',
  e_tile_ovf: 'draws',
  e_img_downscale: 'draws',
  e_mask05_downscale: 'draws',
  e_pattern_after_smask: 'draws',

  // createImageData(0.5 or Infinity, 16).
  r1_mask_w05: 'draws',
  r1_mask_winf: 'draws',
  r1_rgb_w05: 'draws',
  r1_rgb_w05_flate: 'draws',
  r1_gray1_w05: 'draws',
  e_mask05_twice: 'draws',
  e_mask05_repeat12: 'draws',
  e_mask05_group12: 'draws',
  // createCanvas(NaN, ...), then drawn, used as a pattern or read back.
  r24_tile_xstep_nan: 'draws',
  r24_tile_ystep_nan: 'draws',
  r24_group_ctm_overflow_e20x2: 'draws',
  r24_group_ctm_overflow_e200x2: 'draws',
  r24_group_ctm_overflow_e38x9: 'draws',
  e_knockout_ovf: 'draws',
  e_gray_ovf: 'draws',
  e_tr_ovf: 'draws',
  e_smask_ovf: 'draws',
  e_tile_all_nan: 'draws',
  // createRadialGradient with a non-finite radius.
  r28_radial_inf: 'draws',
  r28_radial_inf_r0: 'draws',
  r28_radial_nan_r1: 'draws',
  r28_pat_radial_inf_r1: 'draws',
  r28_pat_radial_overflow: 'draws',

  // `1e400 0 0 1 50 50 cm`: transform() ignores the Infinity scale, as in
  // Chrome, so the half-transparent group lands on the red square. Main drew
  // no group.
  r24_group_ctm_inf: 'draws-over',

  // The page canvas is createCanvas(Infinity, 200) or (0.2, 0.2).
  e_mediabox_inf: 'blank',
  e_userunit_tiny: 'blank',
  e_userunit_tiny_transp: 'blank',
  // A 70000 x 1 canvas.
  e_img_w70000: 'paints',
  e_mask_w70000: 'paints',

  // Main rejects these too: pdf.js's "Invalid canvas size" (0 or negative
  // size), a RangeError in pdf.js, or a negative gradient radius.
  e_tile_xstep0: 'rejects',
  e_mask_wneg: 'rejects',
  e_inline_w05: 'rejects',
  r28_radial_neg: 'rejects',
  r28_radial_neg_r1: 'rejects',
  r28_pat_radial_neg: 'rejects',
  // Non-finite axial coordinates or radial center: main fails to make the
  // Skia shader ("Get shader of ... gradient failed").
  r28_axial_inf: 'rejects',
  r28_axial_nan: 'rejects',
  r28_axial_inf_x0: 'rejects',
  r28_pat_axial_inf: 'rejects',
  r28_pat_axial_overflow: 'rejects',
  r28_radial_inf_center: 'rejects',
}

const require = createRequire(import.meta.url)
// The addon built from this repo, through the CommonJS cache.
const ADDON_PATH = require.resolve('../index')
const addon: typeof import('../index') = require(ADDON_PATH)
const CANVAS_PROTO = Object.getPrototypeOf(addon.createCanvas(1, 1))

// pdf.js loads the package with createRequire(import.meta.url)('@napi-rs/canvas')
// for its DOMMatrix and Path2D polyfills and for NodeCanvasFactory. A checkout
// whose node_modules belongs to another checkout resolves that elsewhere: point
// it at ../index, so only this addon is loaded.
const PDFJS_PATH = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
const requireFromPdfjs = createRequire(PDFJS_PATH)
const resolvedByPdfjs = requireFromPdfjs.resolve('@napi-rs/canvas')
if (resolvedByPdfjs !== ADDON_PATH) {
  require.cache[resolvedByPdfjs] = require.cache[ADDON_PATH]
}

let pdfjs: any

test.before(async () => {
  pdfjs = await import(pathToFileURL(PDFJS_PATH).href)
})

test.serial('pdf.js draws with the addon built from this repo', (t) => {
  t.is(requireFromPdfjs('@napi-rs/canvas'), addon)
  t.is((globalThis as any).DOMMatrix, addon.DOMMatrix)
  t.is((globalThis as any).Path2D, addon.Path2D)
})

const RED = [255, 0, 0, 255]
const GREEN = [0, 255, 0, 255]
const WHITE = [255, 255, 255, 255]
const pixel = (ctx: any, x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data)

for (const [name, expected] of Object.entries(EXPECTED)) {
  test.serial(`${name} ${expected}`, async (t) => {
    const task = pdfjs.getDocument({ data: new Uint8Array(pdfs[name as keyof typeof pdfs]), verbosity: 0 })
    try {
      const doc = await task.promise
      const page = await doc.getPage(1)
      const viewport = page.getViewport({ scale: 1 })
      const { canvas, context } = doc.canvasFactory.create(viewport.width, viewport.height)
      t.is(Object.getPrototypeOf(canvas), CANVAS_PROTO)
      const render = page.render({ canvasContext: context, viewport }).promise
      if (expected === 'rejects') {
        await t.throwsAsync(render, { any: true })
        return
      }
      await t.notThrowsAsync(render)
      if (expected === 'blank') {
        t.true(canvas.width > 0 && canvas.height > 0, `${canvas.width} x ${canvas.height}`)
        t.deepEqual(pixel(context, 100, 100), WHITE)
        return
      }
      const before = pixel(context, 25, 175)
      if (expected === 'draws-over') {
        t.true(before[0] > 0 && before[3] === 255, `the red square, under the case: ${before}`)
      } else {
        t.deepEqual(before, RED, 'the red square, before the bad operators')
      }
      t.deepEqual(pixel(context, 165, 175), GREEN, 'the green square, after the bad operators')
      if (expected === 'paints') {
        t.notDeepEqual(pixel(context, 100, 100), WHITE, 'the image')
      }
    } finally {
      await task.destroy()
    }
  })
}
