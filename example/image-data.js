const { promises } = require('fs')
const { join } = require('path')
const PNGReader = require('png.js')

const { createCanvas, ImageData } = require('../index')

const canvas = createCanvas(1024, 768)

const ctx = canvas.getContext('2d')

async function main() {
  const image = await promises.readFile(join(__dirname, 'tiger.png'))
  const reader = new PNGReader(image)

  reader.parse(async (err, png) => {
    if (err) throw err

    const u8array = new Uint8ClampedArray(png.pixels)
    const data = new ImageData(u8array, png.width, png.height)
    ctx.putImageData(data, 0, 0)

    const output = await canvas.png()
    await promises.writeFile(join(__dirname, 'tiger-tmp.png'), output)
  })
}

main()
