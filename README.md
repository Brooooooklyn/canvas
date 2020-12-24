# `@napi-rs/skia`

![CI](https://github.com/Brooooooklyn/skia-rs/workflows/CI/badge.svg)

Google Skia binding to NodeJS via `N-API`.

> ⚠️ This project is in very early stage.

# Support matrix

|             | node 10 | node12 | node14 | node15 |
| ----------- | ------- | ------ | ------ | ------ |
| Windows x64 | ✅      | ✅     | ✅     | ✅     |
| macOS x64   | ✅      | ✅     | ✅     | ✅     |
| Linux x64   | ✅      | ✅     | ✅     | ✅     |

# Usage

```js
const { promises } = require('fs')
const { join } = require('path')

const { createCanvas } = require('@napi-rs/skia')

const canvas = createCanvas(1024, 768)

const ctx = canvas.getContext('2d')

ctx.lineWidth = 10
ctx.strokeStyle = '#03a9f4'
ctx.fillStyle = '#03a9f4'

// Wall
ctx.strokeRect(75, 140, 150, 110)

// Door
ctx.fillRect(130, 190, 40, 60)

// Roof
ctx.beginPath()
ctx.moveTo(50, 140)
ctx.lineTo(150, 60)
ctx.lineTo(250, 140)
ctx.closePath()
ctx.stroke()

async function main() {
  const pngData = await canvas.png()
  // encoding in libuv thread pool, non-blocking
  await promises.writeFile(join(__dirname, 'simple.png'), pngData)
}

main()
```

![](./example/simple.png)
