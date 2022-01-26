const fs = require('fs').promises
const { join } = require('path')

const { createCanvas, Image } = require('../index')
/* eslint-disable no-console */

async function main() {
  const w = 1052
  const h = 744

  // create a canvas
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')

  ctx.beginPath()
  ctx.lineTo(100, 100)
  ctx.lineTo(300, 150)
  ctx.stroke()

  const data = await canvas.encode('png')
  await fs.writeFile(join(__dirname, 'path-empty-line-to.png'), data)
}

main()
