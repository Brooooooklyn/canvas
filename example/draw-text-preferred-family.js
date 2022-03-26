const { writeFileSync } = require('fs')
const { join } = require('path')

const { createCanvas, GlobalFonts } = require('../index')

GlobalFonts.registerFromPath(
  join(__dirname, '..', '__test__', 'fonts', 'Copal Std Decorated.otf'),
  'Copal Std Decorated',
)
GlobalFonts.registerFromPath(join(__dirname, '..', '__test__', 'fonts', 'Copal Std Solid.otf'), 'Copal Std Solid')

console.info(GlobalFonts.families)

const width = 800,
  height = 300
const canvas = createCanvas(width, height)
const ctx = canvas.getContext('2d')

ctx.fillStyle = '#FFFFFF'
ctx.fillRect(0, 0, width, height)

ctx.fillStyle = 'red'
ctx.font = '50px Copal Std Solid'
ctx.fillText('Copal Std Solid', 50, 100)

ctx.font = '50px Copal Std Decorated'
ctx.fillText('Copal Std Decorated', 50, 200)

const pngBuffer = canvas.toBuffer('image/png')
writeFileSync(join(__dirname, 'draw-text.png'), pngBuffer)
