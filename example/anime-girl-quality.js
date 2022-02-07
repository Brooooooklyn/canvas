const fs = require('fs').promises
const { join } = require('path')
const { performance } = require('perf_hooks')

const { createCanvas, Image } = require('../index')
/* eslint-disable no-console */

async function main() {
  const file = await fs.readFile(join(__dirname, './anime-girl.svg'))

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

  const webpData = await canvas.encode('webp')
  await fs.writeFile(join(__dirname, 'anime-girl-default.webp'), webpData)

  const webpData80 = await canvas.encode('webp', 80)
  await fs.writeFile(join(__dirname, 'anime-girl-80.webp'), webpData80)

  const webpData92 = await canvas.encode('webp', 92)
  await fs.writeFile(join(__dirname, 'anime-girl-92.webp'), webpData92)

  console.log('✨ webp default quality size', webpData.length)
  console.log('✨ webp quality 80 size', webpData80.length)
  console.log('✨ webp quality 92 size', webpData92.length)
}

main()
