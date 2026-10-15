import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'ava'

import { Image } from '../index'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

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
