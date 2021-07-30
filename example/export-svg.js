const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')

const { createCanvas, GlobalFonts, SvgExportFlag } = require('../index.js')

const WoffFontPath = join(__dirname, '..', '__test__', 'fonts', 'Virgil.woff2')

GlobalFonts.registerFromPath(WoffFontPath, 'Virgil')

const canvas = createCanvas(1024, 768, SvgExportFlag.ConvertTextToPaths)
const ctx = canvas.getContext('2d')
ctx.fillStyle = 'yellow'
ctx.fillRect(0, 0, canvas.width, canvas.height)
ctx.strokeStyle = 'cyan'
ctx.lineWidth = 3
ctx.font = '50px Virgil'
ctx.strokeText('skr canvas', 50, 150)

ctx.strokeStyle = 'hotpink'

ctx.strokeText('@napi-rs/canvas', 50, 300)

ctx.strokeStyle = 'gray'

ctx.strokeRect(50, 450, 100, 100)

ctx.fillStyle = 'hotpink'

ctx.arc(500, 120, 90, 0, Math.PI * 2)
ctx.fill()

const b = canvas.getContent()

writeFileSync(join(__dirname, 'export-text.svg'), b)
