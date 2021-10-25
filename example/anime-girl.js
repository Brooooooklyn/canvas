const fs = require('fs').promises
const { join } = require('path')
const { performance } = require('perf_hooks')

const { createCanvas, Image } = require('../index')
/* eslint-disable no-console */

async function main() {
  const file = await fs.readFile(join(__dirname, './anime-girl.svg'))

  const t0 = performance.now()
  const image = new Image()
  image.src = file

  const w = 1052
  const h = 744

  // resize SVG
  image.width = w
  image.height = h

  // create a canvas of the same size as the image
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')

  // fill the canvas with the image
  ctx.drawImage(image, 0, 0)

  const pngData = await canvas.encode('png')
  await fs.writeFile(join(__dirname, 'anime-girl.png'), pngData)
  const t1 = performance.now()

  const avifData = await canvas.encode('avif', {
    quality: 79,
    speed: 5,
  })
  await fs.writeFile(join(__dirname, 'anime-girl.avif'), avifData)

  const t2 = performance.now()

  console.log('✨ png done in', t1 - t0, 'ms')
  console.log('✨ avif done in', t2 - t0, 'ms')
}

main()
