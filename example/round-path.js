const { writeFileSync } = require('fs')
const { join } = require('path')

const { createCanvas, Path2D } = require('../index.js')

const canvas = createCanvas(400, 400)
const ctx = canvas.getContext('2d')

const points = [
  { x: 50, y: 50 },
  { x: 150, y: 80 },
  { x: 250, y: 50 },
  { x: 350, y: 150 },
  { x: 300, y: 250 },
  { x: 200, y: 350 },
  { x: 100, y: 250 },
  { x: 50, y: 150 },
]

const path = new Path2D()

path.moveTo(points[0].x, points[0].y)

for (let i = 1; i < points.length; i++) {
  path.lineTo(points[i].x, points[i].y)
}

path.closePath()

const roundedPath = path.round(20)

ctx.strokeStyle = '#03a9f4'
ctx.lineWidth = 5

ctx.stroke(roundedPath)

const pngData = canvas.toBuffer('image/png')
writeFileSync(join(__dirname, 'round-path.png'), pngData)

console.log('Saved example/round-path.png')
