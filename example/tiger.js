const { promises } = require('fs')
const { join } = require('path')

const { createCanvas, Path2D } = require('../index')

const tiger = require('./tiger.json')

const canvas = createCanvas(1024, 768)

const ctx = canvas.getContext('2d')

for (const pathObject of tiger) {
  const p = new Path2D(pathObject.d)
  ctx.fillStyle = pathObject.fillStyle
  ctx.strokeStyle = pathObject.strokeStyle
  if (pathObject.lineWidth) {
    ctx.lineWidth = parseInt(pathObject.lineWidth, 10)
  }
  ctx.stroke(p)
  ctx.fill(p)
}

canvas
  .png()
  .then((data) => promises.writeFile(join(__dirname, 'tiger.png'), data))
  .catch((e) => {
    console.error(e)
  })
