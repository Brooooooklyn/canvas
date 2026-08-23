import test from 'ava'

import { createCanvas } from '../index.js'

// https://github.com/Brooooooklyn/canvas/issues/1321
// Canvas→canvas drawImage must take a zero-copy snapshot of the source surface
// at call time: later writes into the source trigger Skia copy-on-write instead
// of leaking into the destination, and repeated unflushed blits must not each
// pin their own copy of the source pixel buffer.

test('drawImage(canvas) captures call-time pixels when source is later modified', (t) => {
  const src = createCanvas(256, 256)
  const sctx = src.getContext('2d')
  sctx.fillStyle = '#ff0000'
  sctx.fillRect(0, 0, 256, 256)

  const dst = createCanvas(256, 256)
  const dctx = dst.getContext('2d')
  dctx.drawImage(src, 0, 0)

  // Repaint the source green and force its surface write before reading the
  // destination, so the recorded blit must rely on copy-on-write.
  sctx.fillStyle = '#00ff00'
  sctx.fillRect(0, 0, 256, 256)
  src.toBuffer('image/png')

  t.deepEqual(
    Array.from(dctx.getImageData(128, 128, 1, 1).data),
    [255, 0, 0, 255],
    'destination must keep the red pixels captured when drawImage was called',
  )
})

test('drawImage(canvas) captures call-time pixels when source was encoded before the blit', (t) => {
  const src = createCanvas(256, 256)
  const sctx = src.getContext('2d')
  sctx.fillStyle = '#ff0000'
  sctx.fillRect(0, 0, 256, 256)

  // Encoding snapshots the source surface; the blit below must still hold its
  // own reference so a later source write cannot restore mutability in place.
  src.toBuffer('image/png')

  const dst = createCanvas(256, 256)
  const dctx = dst.getContext('2d')
  dctx.drawImage(src, 0, 0)

  sctx.fillStyle = '#00ff00'
  sctx.fillRect(0, 0, 256, 256)
  src.toBuffer('image/png')

  t.deepEqual(
    Array.from(dctx.getImageData(128, 128, 1, 1).data),
    [255, 0, 0, 255],
    'destination must not show the green fill drawn after the blit',
  )
})

test('drawImage(canvas) self-blit uses call-time pixels', (t) => {
  const canvas = createCanvas(256, 256)
  const actx = canvas.getContext('2d')
  actx.fillStyle = '#ff0000'
  actx.fillRect(0, 0, 256, 256)

  actx.drawImage(canvas, 16, 16)

  actx.fillStyle = '#0000ff'
  actx.fillRect(0, 0, 1, 1)

  t.deepEqual(
    Array.from(actx.getImageData(200, 200, 1, 1).data),
    [255, 0, 0, 255],
    'self-blit must copy the red pixels captured at call time',
  )
  t.deepEqual(
    Array.from(actx.getImageData(0, 0, 1, 1).data),
    [0, 0, 255, 255],
    'drawing after the self-blit must still land on the surface',
  )
})

test('drawImage(canvas) does not pin one buffer copy per blit', (t) => {
  const src = createCanvas(1920, 1080)
  const sctx = src.getContext('2d')
  sctx.fillStyle = '#ff0000'
  sctx.fillRect(0, 0, 1920, 1080)

  const dst = createCanvas(1920, 1080)
  const dctx = dst.getContext('2d')

  const before = process.memoryUsage.rss()
  for (let i = 0; i < 100; i++) {
    dctx.drawImage(src, 0, 0)
  }
  const delta = process.memoryUsage.rss() - before

  // Each eager copy of a 1080p surface is ~8.3 MB; 100 unflushed blits used to
  // pin ~800 MB. Snapshots share the pixels, so growth stays far below 100 MB.
  t.true(
    delta < 100 * 1024 * 1024,
    `100 unflushed blits grew rss by ${(delta / 1024 / 1024).toFixed(1)} MB, expected < 100 MB`,
  )
})
