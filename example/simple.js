const { writeFileSync } = require('fs')
const { join } = require('path')

const { createCanvas } = require('../index')

const canvas = createCanvas(1024, 768)

const ctx = canvas.getContext('2d')

ctx.lineWidth = 10

// Wall
ctx.strokeRect(75, 140, 150, 110)

ctx.fillStyle = '#03a9f4'

// Door
ctx.fillRect(130, 190, 40, 60)

// Roof
ctx.beginPath()
ctx.moveTo(50, 140)
ctx.lineTo(150, 60)
ctx.lineTo(250, 140)
ctx.closePath()
ctx.stroke()

writeFileSync(join(__dirname, 'simple.png'), canvas.toBuffer())
