// Issue #1405: on Linux, require('@napi-rs/canvas') crashed Electron, because
// the addon's own calls into its cxx runtime bound to Electron's copies.
// The crash came from loading the system fonts and from drawing text, so
// this does both. run.js starts it with Electron; `node index.js` works too.

const assert = require('node:assert')
const { join } = require('node:path')

const runtime = process.versions.electron
  ? `Electron ${process.versions.electron} (Node.js ${process.version})`
  : `Node.js ${process.version}`

const { createCanvas, GlobalFonts } = require('@napi-rs/canvas')
console.log(`ok - require('@napi-rs/canvas') in ${runtime}`)

if (process.env.DISABLE_SYSTEM_FONTS_LOAD) {
  GlobalFonts.enableSystemFonts()
  console.log('ok - GlobalFonts.enableSystemFonts()')
}

const systemFamilies = GlobalFonts.families.map(({ family }) => family)
assert.ok(systemFamilies.length > 0, 'no system font found, install one (for example fonts-dejavu-core)')
console.log(`ok - ${systemFamilies.length} system font families`)
const systemFamily = systemFamilies.includes('DejaVu Sans') ? 'DejaVu Sans' : systemFamilies[0]

const registeredFamily = 'E2E Source Serif'
const fontKey = GlobalFonts.registerFromPath(
  join(__dirname, '..', '..', '__test__', 'fonts', 'SourceSerifPro-Regular.ttf'),
  registeredFamily,
)
assert.ok(fontKey, `registerFromPath failed for ${registeredFamily}`)
console.log(`ok - registered ${registeredFamily}`)

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function drawText(family) {
  const canvas = createCanvas(320, 80)
  const ctx = canvas.getContext('2d')
  ctx.font = `32px "${family}"`
  const { width } = ctx.measureText('Hello, Electron')
  assert.ok(width > 0, `measureText width is ${width}`)
  ctx.fillStyle = '#000'
  ctx.fillText('Hello, Electron', 10, 40)
  ctx.strokeStyle = '#c00'
  ctx.strokeText('Hello, Electron', 10, 72)
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  assert.ok(
    pixels.some((value) => value !== 0),
    'no pixel was drawn',
  )
  const png = await canvas.encode('png')
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), 'encode("png") did not return a PNG')
  console.log(`ok - "${family}": measureText ${width.toFixed(1)}px, fillText, strokeText, ${png.length} byte PNG`)
}

drawText(systemFamily)
  .then(() => drawText(registeredFamily))
  .catch((error) => {
    console.error(`not ok - ${error.stack ?? error}`)
    process.exitCode = 1
  })
