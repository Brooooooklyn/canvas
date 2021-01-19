const { loadBinding } = require('@node-rs/helper')

/**
 * __dirname means load native addon from current dir
 * 'skia' means native addon name is `skia`
 * the first arguments was decided by `napi.name` field in `package.json`
 * the second arguments was decided by `name` field in `package.json`
 * loadBinding helper will load `skia.[PLATFORM].node` from `__dirname` first
 * If failed to load addon, it will fallback to load from `@napi-rs/skia-[PLATFORM]`
 */
const { CanvasRenderingContext2D, CanvasElement, Path2D, ImageData, Image } = loadBinding(
  __dirname,
  'skia',
  '@napi-rs/skia',
)

CanvasRenderingContext2D.prototype.getImageData = function getImageData(x, y, w, h) {
  const data = this._getImageData(x, y, w, h)
  return new ImageData(data, w, h)
}

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

  Object.defineProperty(ctx, 'createImageData', {
    value: function createImageData(widthOrImage, height) {
      if (widthOrImage instanceof ImageData) {
        return new ImageData(widthOrImage.width, widthOrImage.height)
      }
      return new ImageData(widthOrImage, height)
    },
    configurable: false,
    enumerable: false,
    writable: false,
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
  ImageData,
  Image,
}
