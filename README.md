# `@napi-rs/canvas`

![CI](https://github.com/Brooooooklyn/canvas/workflows/CI/badge.svg)

Google Skia binding to Node.js via `N-API`.

> ⚠️ This project is in very early stage.<br/>
> For details on planned features and future direction please refer to the [Roadmap](https://github.com/Brooooooklyn/canvas/issues/113).

# Support matrix

|                       | node10 | node12 | node14 | node15 |
| --------------------- | ------ | ------ | ------ | ------ |
| Windows x64           | ✓      | ✓      | ✓      | ✓      |
| macOS x64             | ✓      | ✓      | ✓      | ✓      |
| macOS aarch64         | ✓      | ✓      | ✓      | ✓      |
| Linux x64 gnu         | ✓      | ✓      | ✓      | ✓      |
| Linux x64 musl        | ✓      | ✓      | ✓      | ✓      |
| Linux aarch64 gnu     | ✓      | ✓      | ✓      | ✓      |
| Linux arm gnueabihf   | ✓      | ✓      | ✓      | ✓      |
| Linux aarch64 android | ✓      | ✓      | ✓      | ✓      |

# Usage

```js
const { promises } = require('fs')
const { join } = require('path')

const { createCanvas } = require('@napi-rs/canvas')

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

# Features

## Path2D

```typescript
new Path2D()
new Path2D(path: Path2D)
// new Path2D('M108.956,403.826c0,0,0.178,3.344-1.276,3.311  c-1.455-0.033-30.507-84.917-66.752-80.957C40.928,326.18,72.326,313.197,108.956,403.826z')
new Path2D(path: string)
```

```typescript
export interface DOMMatrix2DInit {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export class Path2D {
  constructor(path?: Path2D | string)

  addPath(path: Path2D, transform?: DOMMatrix2DInit): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, anticlockwise?: boolean): void
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void
  closePath(): void
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    anticlockwise?: boolean,
  ): void
  lineTo(x: number, y: number): void
  moveTo(x: number, y: number): void
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void
  rect(x: number, y: number, w: number, h: number): void

  // PathKit methods
  op(path: Path2D, operation: PathOp): Path2D
  toSVGString(): string
  getFillType(): FillType
  setFillType(type: FillType): void
  simplify(): Path2D
  asWinding(): Path2D
  stroke(stroke?: StrokeOptions): Path2D
  transform(transform: DOMMatrix2DInit): Path2D
  getBounds(): [left: number, top: number, right: number, bottom: number]
  computeTightBounds(): [left: number, top: number, right: number, bottom: number]
  trim(start: number, end: number, isComplement?: boolean): Path2D
  equals(path: Path2D): boolean
}
```

### [Example](./example/tiger.js)

> The tiger.json was serialized from [gojs/samples/tiger](https://github.com/NorthwoodsSoftware/GoJS/blob/master/samples/tiger.html)

![](./example/tiger.png)

# Building

## Build skia from source

You can build this project from source, with no OS-specific package installing commands required:

```sh
# Clone the code:
$ git clone --recurse-submodules https://github.com/Brooooooklyn/canvas.git
$ cd canvas

# Build Skia:
$ node scripts/build-skia.js

# Install NPM packages, build the Node.js addon:
$ yarn install --ignore-scripts
$ yarn build

# All done! Run test cases or examples now:
$ yarn test
$ node example/tiger.js
```

## Pull pre-build skia binary from Github

You can pull skia pre-build binaries if you just care the `Rust` part:

```sh
# Clone the code:
$ git clone --recurse-submodules https://github.com/Brooooooklyn/canvas.git
$ cd canvas

# Download Skia binaries:
# It will pull the binaries match the git hash in `./skia` submodule
$ node scripts/release-skia-binary.js --download

# Install NPM packages, build the Node.js addon:
$ yarn install --ignore-scripts
$ yarn build

# All done! Run test cases or examples now:
$ yarn test
$ node example/tiger.js
```
