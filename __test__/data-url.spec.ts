import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { createCanvas, Image, loadImage } from '../index'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const base64 = (path: string) => readFileSync(join(FIXTURES, path)).toString('base64')

// 4x4 rgb(0, 128, 255) with a white corner; 4x4 red JPEG, WebP and GIF; a
// 16x16 AVIF.
const png = base64('data-url/4x4.png')
const jpeg = base64('data-url/4x4.jpg')
const webp = base64('data-url/4x4.webp')
const gif = base64('data-url/4x4.gif')
const avif = base64('avif-chrome/m1-full-420-d8.avif')

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>'
const svgHash = svg.replace('fill="red"', 'fill="#00f"')
const svgBase64 = Buffer.from(svg).toString('base64')

const cases: Record<string, string> = {
  svgB64: 'data:image/svg+xml;base64,' + svgBase64,
  svgUtf8: 'data:image/svg+xml;utf8,' + svg,
  svgPct: 'data:image/svg+xml,' + encodeURIComponent(svg),
  svgPlain: 'data:image/svg+xml,' + svg,
  svgCharset: 'data:image/svg+xml;charset=utf-8;base64,' + svgBase64,
  svgUpperMime: 'data:IMAGE/SVG+XML;base64,' + svgBase64,
  svgMimeSpaces: 'data: image/svg+xml ;base64,' + svgBase64,
  svgBase64Space: 'data:image/svg+xml; base64,' + svgBase64,
  // A raw '#' starts the fragment, so the SVG is cut there.
  svgHashRaw: 'data:image/svg+xml,' + svgHash,
  svgHashPct: 'data:image/svg+xml,' + svgHash.replace('#', '%23'),
  svgUnicode: 'data:image/svg+xml,' + svg.replace('<rect', '<title>é</title><rect'),
  // A '%' without two hex digits stays: the fill is invalid, so black.
  svgBadPct: 'data:image/svg+xml,' + svg.replace('red', 'red%zz'),
  svgTabs: 'data:image/svg+xml,' + svg.replace(' width', '\t\n width'),
  // An SVG needs the image/svg+xml type; other types are sniffed as raster.
  svgTextPlain: 'data:text/plain;base64,' + svgBase64,
  svgTextPlainPct: 'data:text/plain,' + encodeURIComponent(svg),
  svgNoMime: 'data:;base64,' + svgBase64,
  svgNoMimeComma: 'data:,' + encodeURIComponent(svg),
  svgAsPng: 'data:image/png;base64,' + svgBase64,
  pngB64: 'data:image/png;base64,' + png,
  pngWrongMime: 'data:image/jpeg;base64,' + png,
  pngNoMime: 'data:;base64,' + png,
  pngTextPlain: 'data:text/plain;base64,' + png,
  pngAsSvg: 'data:image/svg+xml;base64,' + png,
  pngUpperBase64: 'data:image/png;BASE64,' + png,
  pngSpaces: 'data:image/png;base64,' + png.slice(0, 10) + ' \n' + png.slice(10),
  pngSpaces7: 'data:image/png;base64,' + png.replace(/(.{7})/g, '$1 '),
  pngPctEncoded:
    'data:image/png,' + [...Buffer.from(png, 'base64')].map((b) => '%' + b.toString(16).padStart(2, '0')).join(''),
  pngPctB64: 'data:image/png;base64,' + png.replace(/\+/g, '%2B').replace(/\//g, '%2F'),
  pngNoPad: 'data:image/png;base64,' + png.replace(/=+$/, ''),
  pngMod1: 'data:image/png;base64,' + png.replace(/=+$/, '') + 'A',
  pngBadChar: 'data:image/png;base64,' + png.slice(0, 8) + '*' + png.slice(8),
  pngStar: 'data:image/png;base64,*' + png,
  pngNoComma: 'data:image/png;base64' + png,
  pngExtraParam: 'data:image/png;foo=bar;base64,' + png,
  // ";base64" must come last, else the body is not base64.
  pngBase64NotLast: 'data:image/png;base64;foo=bar,' + png,
  pngTrailingSpace: 'data:image/png;base64,' + png + '   ',
  // The query is part of the body.
  pngQuery: 'data:image/png;base64,' + png + '?x=1',
  pngHashFrag: 'data:image/png;base64,' + png + '#frag',
  pngTrailCtl: 'data:image/png;base64,' + png + '\u0001',
  pngLeadingSpace: ' data:image/png;base64,' + png,
  pngLeadingCtl: '\u0001\u001f data:image/png;base64,' + png,
  pngUpperScheme: 'DATA:image/png;base64,' + png,
  pngEmpty: 'data:image/png;base64,',
  pngGarbage: 'data:image/png;base64,AAAA',
  avifB64: 'data:image/avif;base64,' + avif,
  avifOctet: 'data:application/octet-stream;base64,' + avif,
  avifNoMime: 'data:;base64,' + avif,
  jpegB64: 'data:image/jpeg;base64,' + jpeg,
  webpB64: 'data:image/webp;base64,' + webp,
  gifB64: 'data:image/gif;base64,' + gif,
}

// Chrome 155 (arm64 == x64): the natural size and pixel (0, 0) after
// drawImage(img, 0, 0) on a 4x4 canvas; null is onerror.
const chrome: Record<string, { natural: number[]; px: number[] } | null> = {
  svgB64: { natural: [20, 10], px: [255, 0, 0, 255] },
  svgUtf8: { natural: [20, 10], px: [255, 0, 0, 255] },
  svgPct: { natural: [20, 10], px: [255, 0, 0, 255] },
  svgPlain: { natural: [20, 10], px: [255, 0, 0, 255] },
  svgCharset: { natural: [20, 10], px: [255, 0, 0, 255] },
  svgUpperMime: { natural: [20, 10], px: [255, 0, 0, 255] },
  svgMimeSpaces: { natural: [20, 10], px: [255, 0, 0, 255] },
  svgBase64Space: { natural: [20, 10], px: [255, 0, 0, 255] },
  svgHashRaw: null,
  svgHashPct: { natural: [20, 10], px: [0, 0, 255, 255] },
  svgUnicode: { natural: [20, 10], px: [255, 0, 0, 255] },
  svgBadPct: { natural: [20, 10], px: [0, 0, 0, 255] },
  svgTabs: { natural: [20, 10], px: [255, 0, 0, 255] },
  svgTextPlain: null,
  svgTextPlainPct: null,
  svgNoMime: null,
  svgNoMimeComma: null,
  svgAsPng: null,
  pngB64: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngWrongMime: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngNoMime: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngTextPlain: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngAsSvg: null,
  pngUpperBase64: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngSpaces: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngSpaces7: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngPctEncoded: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngPctB64: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngNoPad: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngMod1: null,
  pngBadChar: null,
  pngStar: null,
  pngNoComma: null,
  pngExtraParam: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngBase64NotLast: null,
  pngTrailingSpace: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngQuery: null,
  pngHashFrag: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngTrailCtl: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngLeadingSpace: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngLeadingCtl: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngUpperScheme: { natural: [4, 4], px: [0, 128, 255, 255] },
  pngEmpty: null,
  pngGarbage: null,
  avifB64: { natural: [16, 16], px: [0, 0, 48, 255] },
  avifOctet: { natural: [16, 16], px: [0, 0, 48, 255] },
  avifNoMime: { natural: [16, 16], px: [0, 0, 48, 255] },
  jpegB64: { natural: [4, 4], px: [255, 0, 0, 255] },
  webpB64: { natural: [4, 4], px: [255, 1, 0, 255] },
  gifB64: { natural: [4, 4], px: [255, 0, 0, 255] },
}

function load(src: string | Buffer) {
  const image = new Image()
  return new Promise<Image | null>((resolve) => {
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = src
  })
}

// The Fetch data: URL processor (https://fetch.spec.whatwg.org/#data-url-processor)
// after the URL parser: a case-insensitive scheme, leading and trailing C0
// controls and spaces and every tab and newline dropped, the fragment cut,
// percent-decoding, and forgiving-base64 for ";base64" at the end of the type.
test('img.src data: URLs load like Chrome 155', async (t) => {
  t.deepEqual(Object.keys(cases).sort(), Object.keys(chrome).sort())
  for (const [name, url] of Object.entries(cases)) {
    const image = await load(url)
    let got = null
    if (image) {
      const ctx = createCanvas(4, 4).getContext('2d')
      ctx.drawImage(image, 0, 0)
      got = { natural: [image.naturalWidth, image.naturalHeight], px: [...ctx.getImageData(0, 0, 1, 1).data] }
    }
    t.deepEqual(got, chrome[name], name)
  }
})

test('a data: URL in a Buffer loads too', async (t) => {
  const image = await load(Buffer.from(cases.svgPct))
  t.deepEqual(image && [image.naturalWidth, image.naturalHeight], [20, 10])
})

test('loadImage(data: URL) sets the string as src', async (t) => {
  const url = cases.svgPct
  const image = await loadImage(url)
  t.is(image.src, url)
  t.deepEqual([image.width, image.height], [20, 10])
  const fromUrl = await loadImage(new URL(cases.pngB64))
  t.deepEqual([fromUrl.width, fromUrl.height], [4, 4])
  await t.throwsAsync(loadImage(cases.pngEmpty))
  await t.throwsAsync(loadImage(cases.svgTextPlain))
})
