const { promises } = require('fs')
const { join } = require('path')

const { createCanvas, Image } = require('../index')

async function main() {
  const file = await promises.readFile(join(__dirname, './resize-svg.svg'))

  const image = new Image()
  image.src = file

  const w = 500
  const h = 500

  // create a canvas of the size to draw the SVG at
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')

  // fill the canvas with the image: an SVG is drawn at the size given to
  // drawImage, as in browsers (img.width and img.height do not size it)
  ctx.drawImage(image, 0, 0, w, h)

  const output = await canvas.encode('png')
  await promises.writeFile(join(__dirname, 'resize-svg.png'), output)
}

main()
