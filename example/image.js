const { promises } = require('fs')
const { join } = require('path')

const { createCanvas, Image } = require('../index')

const canvas = createCanvas(1024, 768)

const ctx = canvas.getContext('2d')

async function main() {
  const file = await promises.readFile(join(__dirname, 'tiger.png'))
  const image = new Image()
  image.src = file
  ctx.drawImage(image, 0, 0)

  const output = await canvas.png()
  await promises.writeFile(join(__dirname, 'tiger-tmp.png'), output)
}

main()
