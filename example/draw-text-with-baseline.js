const { writeFileSync } = require('fs')
const { join } = require('path')

const { createCanvas, GlobalFonts } = require('../index.js')

const fontPath = join(__dirname, '..', '__test__', 'fonts', 'iosevka-slab-regular.ttf')

console.info(GlobalFonts.families)

GlobalFonts.registerFromPath(fontPath)

console.info(GlobalFonts.families)

const canvas = createCanvas(1024, 768)
const ctx = canvas.getContext('2d')
ctx.fillStyle = 'yellow'
ctx.fillRect(0, 0, canvas.width, canvas.height)
const baselines = ['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom']
ctx.font = '36px Iosevka Slab'
ctx.strokeStyle = 'red'
ctx.fillStyle = 'black'

baselines.forEach(function (baseline, index) {
  ctx.textBaseline = baseline
  const y = 75 + index * 75
  ctx.beginPath()
  ctx.moveTo(0, y + 0.5)
  ctx.lineTo(550, y + 0.5)
  ctx.stroke()
  ctx.fillText('Abcdefghijklmnop (' + baseline + ')', 0, y)
})

const b = canvas.toBuffer('image/png')

writeFileSync(join(__dirname, 'draw-text-with-baseline.png'), b)
