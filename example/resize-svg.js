const { promises } = require('fs')
const { join } = require('path')

const { createCanvas, Image } = require('../index')

async function main() {
  const file = await promises.readFile(join(__dirname, './resize-svg.svg'))

  const image = new Image()
  image.src = file

  const w = 500
  const h = 500

  // resize SVG
  image.width = w
  image.height = h

  // create a canvas of the same size as the image
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')

  // fill the canvas with the image
  ctx.drawImage(image, 0, 0)

  const output = await canvas.encode('png')
  await promises.writeFile(join(__dirname, 'resize-svg.png'), output)
}

main()
