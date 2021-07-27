const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')

const { createCanvas, GlobalFonts } = require('../index.js')

const fontPath = join(__dirname, '..', '__test__', 'fonts', 'iosevka-slab-regular.ttf')
const fontData = readFileSync(fontPath)

const WoffFontPath = join(__dirname, '..', '__test__', 'fonts', 'Virgil.woff2')

console.info(GlobalFonts.families)

GlobalFonts.register(fontData)
GlobalFonts.registerFromPath(WoffFontPath)

console.info(GlobalFonts.families)

const canvas = createCanvas(1024, 768)
const ctx = canvas.getContext('2d')
ctx.fillStyle = 'yellow'
ctx.fillRect(0, 0, canvas.width, canvas.height)
ctx.strokeStyle = 'black'
ctx.lineWidth = 3
ctx.font = '50px Iosevka Slab'
ctx.strokeText('skr canvas', 50, 150)
const gradient = ctx.createConicGradient(0, 100, 100)

// Add five color stops
gradient.addColorStop(0, 'red')
gradient.addColorStop(0.15, 'orange')
gradient.addColorStop(0.25, 'yellow')
gradient.addColorStop(0.35, 'orange')
gradient.addColorStop(0.5, 'green')
gradient.addColorStop(0.75, 'cyan')
gradient.addColorStop(1, 'blue')

// Set the fill style and draw a rectangle
ctx.strokeStyle = gradient
ctx.strokeText('@napi-rs/canvas', 50, 300)

const b = canvas.toBuffer('image/png')

writeFileSync(join(__dirname, 'draw-text.png'), b)
