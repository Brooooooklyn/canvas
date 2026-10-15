import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test, { type ExecutionContext } from 'ava'

import { createCanvas, Image } from '../index'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const AVIF = join(FIXTURES, 'avif-chrome')

interface ChromeDecode {
  natural?: [number, number]
  srgb?: string
  onBlack?: string
  error?: true
}
const chrome: Record<string, ChromeDecode> = JSON.parse(readFileSync(join(AVIF, 'chrome-155.json'), 'utf8'))

function load(src: Buffer) {
  const image = new Image()
  return new Promise<{ image: Image; ok: boolean }>((resolve) => {
    image.onload = () => resolve({ image, ok: true })
    image.onerror = () => resolve({ image, ok: false })
    image.src = src
  })
}

// The decoder and image libavif made for a failed decode are freed (the
// gated stress test counts the memory); the Image is broken, as in Chrome.
test('a truncated AVIF fires onerror', async (t) => {
  const avif = readFileSync(join(FIXTURES, 'avif-cicp-1-1-6.avif'))
  const { image, ok } = await load(avif.subarray(0, Math.floor(avif.length * 0.6)))
  t.false(ok)
  t.true(image.complete)
  t.is(image.naturalWidth, 0)
  t.is(image.naturalHeight, 0)
})

// Draws a fixture the way chrome-155.json was measured: a max(16, natural)
// canvas, drawImage(img, 0, 0), getImageData of the whole canvas.
async function drawFixture(name: string, background?: string) {
  const { image, ok } = await load(readFileSync(join(AVIF, name)))
  if (!ok) {
    return null
  }
  const width = Math.max(16, image.naturalWidth)
  const height = Math.max(16, image.naturalHeight)
  const ctx = createCanvas(width, height).getContext('2d')
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, width, height)
  }
  ctx.drawImage(image, 0, 0)
  return {
    natural: [image.naturalWidth, image.naturalHeight],
    pixels: Buffer.from(ctx.getImageData(0, 0, width, height).data),
  }
}

// How many bytes differ, and by how much at most.
function compare(actual: Buffer, expected: Buffer) {
  let differing = 0
  let maxDiff = 0
  for (let i = 0; i < expected.length; i++) {
    const diff = Math.abs(actual[i] - expected[i])
    if (diff) {
      differing++
      maxDiff = Math.max(maxDiff, diff)
    }
  }
  return { length: actual.length, differing, maxDiff }
}

async function expectChrome(t: ExecutionContext, name: string) {
  const expected = chrome[name]
  const drawn = await drawFixture(name)
  if (expected.error) {
    t.is(drawn, null, `${name} fires onerror`)
    return
  }
  if (!drawn) {
    t.fail(`${name} fired onerror`)
    return
  }
  t.deepEqual(drawn.natural, expected.natural, `${name} natural size`)
  const srgb = Buffer.from(expected.srgb!, 'base64')
  t.deepEqual(compare(drawn.pixels, srgb), { length: srgb.length, differing: 0, maxDiff: 0 }, name)
  if (expected.onBlack) {
    const onBlack = Buffer.from(expected.onBlack, 'base64')
    const drawnOnBlack = (await drawFixture(name, '#000'))!.pixels
    t.deepEqual(
      compare(drawnOnBlack, onBlack),
      { length: onBlack.length, differing: 0, maxDiff: 0 },
      `${name} over black`,
    )
  }
}

// Chrome 155 converts AVIF YUV to RGB with CrabbyAvif: libyuv for BT.601,
// BT.709, BT.2020 and chroma-derived matrices with known primaries (bilinear
// 4:2:0, linear 4:2:2, nearest for 12-bit 4:2:0, a downshift to 8 bits for
// other 12-bit images), its own f32 code for the others (identity m0, FCC m4,
// SMPTE 240 m7, YCgCo m8), and premultiplies alpha with libyuv's
// ARGBAttenuate. The names are m<matrix>-<range>-<subsampling>-d<depth>; a-
// and xa- have alpha; odd- are 17x13; matrix 15 is unknown to CrabbyAvif and
// decodes as unspecified (BT.601).
test('avif decodes YUV to RGB like Chrome 155', async (t) => {
  for (const name of [
    'm1-full-420-d8.avif',
    'm1-limited-422-d8.avif',
    'm5-limited-444-d8.avif',
    'm6-full-400-d8.avif',
    'm9-limited-420-d10.avif',
    'm9-full-444-d10.avif',
    'm6-limited-422-d12.avif',
    'm1-full-420-d12.avif',
    'm0-limited-444-d10.avif',
    'x-m4-limited-444.avif',
    'x-m7-full-420.avif',
    'x-m8-full-420.avif',
    'x-m12-full-420.avif',
    'm15.avif',
    'odd-m1-full-420-d10.avif',
    'odd-m1-limited-420-d8.avif',
    'odd-m1-limited-422-d8.avif',
    'odd-m5-full-422-d10.avif',
    'odd-m6-full-420-d10.avif',
    'odd-m6-limited-422-d12.avif',
    'odd-m6-limited-444-d8.avif',
    'odd-m9-limited-420-d12.avif',
  ]) {
    await expectChrome(t, name)
  }
})

test('avif premultiplies alpha like Chrome 155', async (t) => {
  for (const name of [
    'a-m1-full-420-d8.avif',
    'a-m6-limited-444-d8.avif',
    'xa-m0-full-444.avif',
    'xa-m8-full-444.avif',
    'odda-m6-full-444-d8.avif',
  ]) {
    await expectChrome(t, name)
  }
})
