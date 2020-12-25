const { promises } = require('fs')
const { join } = require('path')

const { createCanvas } = require('../index')

const canvas = createCanvas(1024, 768)

const ctx = canvas.getContext('2d')

const gradient = ctx.createLinearGradient(20, 0, 220, 0)

// Add three color stops
gradient.addColorStop(0, 'green')
gradient.addColorStop(0.5, 'cyan')
gradient.addColorStop(1, 'green')

// Set the fill style and draw a rectangle
ctx.fillStyle = gradient
ctx.fillRect(20, 20, 200, 100)

canvas
  .png()
  .then((data) => promises.writeFile(join(__dirname, 'gradient.png'), data))
  .catch((e) => {
    console.error(e)
  })
