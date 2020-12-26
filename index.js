const { loadBinding } = require('@node-rs/helper')

/**
 * __dirname means load native addon from current dir
 * 'skia' means native addon name is `skia`
 * the first arguments was decided by `napi.name` field in `package.json`
 * the second arguments was decided by `name` field in `package.json`
 * loadBinding helper will load `skia.[PLATFORM].node` from `__dirname` first
 * If failed to load addon, it will fallback to load from `@napi-rs/skia-[PLATFORM]`
 */
const { CanvasRenderingContext2D, CanvasElement, Path2D } = loadBinding(__dirname, 'skia', '@napi-rs/skia')

function createCanvas(width, height) {
  const canvasElement = new CanvasElement(width, height)
  const ctx = new CanvasRenderingContext2D(width, height)

  // napi can not define writable: true but enumerable: false property
  Object.defineProperty(ctx, '_fillStyle', {
    value: '#000',
    configurable: false,
    enumerable: false,
    writable: true,
  })

  Object.defineProperty(ctx, '_strokeStyle', {
    value: '#000',
    configurable: false,
    enumerable: false,
    writable: true,
  })

  Object.defineProperty(canvasElement, 'ctx', {
    value: ctx,
    enumerable: false,
    configurable: false,
  })

  ctx.canvas = canvasElement

  return canvasElement
}

module.exports = {
  createCanvas,
  Path2D,
}
