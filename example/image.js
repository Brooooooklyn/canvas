const { promises } = require('fs')
const { join } = require('path')

const { createCanvas, Image } = require('../index')

async function main() {
  const file = await promises.readFile(join(__dirname, 'tiger.png'))

  const image = new Image()
  image.src = file

  const w = image.width
  const h = image.height

  // create a canvas of the same size as the image
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')

  // fill the canvas with the image
  ctx.drawImage(image, 0, 0)

  // fill a quarter of the canvas with image
  // ctx.drawImage(image, 0, 0, w / 2, h / 2)

  // fill the canvas with a quarter of the image
  // ctx.drawImage(image, 0, 0, w / 2, h / 2, 0, 0, w, h)

  const output = await canvas.encode('png')
  await promises.writeFile(join(__dirname, 'tiger-tmp.png'), output)
}

main()
