const { platform, homedir } = require('os')
const { join } = require('path')

const {
  clearAllCache,
  CanvasRenderingContext2D,
  CanvasElement,
  createContext,
  SVGCanvas,
  Path2D,
  ImageData,
  Image,
  CanvasPattern,
  GlobalFonts,
  PathOp,
  FillType,
  StrokeJoin,
  StrokeCap,
  convertSVGTextToPath,
} = require('./js-binding')

const { DOMPoint, DOMMatrix, DOMRect } = require('./geometry')

const loadImage = require('./load-image')

const SvgExportFlag = {
  ConvertTextToPaths: 0x01,
  NoPrettyXML: 0x02,
  RelativePathEncoding: 0x04,
}

// eslint-disable-next-line sonarjs/no-unused-collection
const Fonts = []

Object.defineProperty(GlobalFonts, 'families', {
  get: function () {
    return JSON.parse(GlobalFonts.getFamilies())
  },
})

Object.defineProperty(GlobalFonts, 'has', {
  value: function has(name) {
    return !!JSON.parse(GlobalFonts.getFamilies()).find(({ family }) => family === name)
  },
  configurable: false,
  enumerable: false,
  writable: false,
})

CanvasRenderingContext2D.prototype.createPattern = function createPattern(image, repetition) {
  if (image instanceof ImageData) {
    const pattern = new CanvasPattern(image, repetition, 0)
    Object.defineProperty(pattern, '_imageData', {
      writable: true,
      configurable: false,
      enumerable: false,
      value: null,
    })
    return pattern
  } else if (image instanceof Image) {
    return new CanvasPattern(image, repetition, 1)
  } else if (image instanceof CanvasElement || image instanceof SVGCanvas) {
    return new CanvasPattern(image, repetition, 2)
  }
  throw TypeError('Image should be instance of ImageData or Image')
}

CanvasRenderingContext2D.prototype.getImageData = function getImageData(x, y, w, h) {
  const data = this._getImageData(x, y, w, h)
  return new ImageData(data, w, h)
}

function createCanvas(width, height, flag) {
  const isSvgBackend = typeof flag !== 'undefined'
  const canvasElement = isSvgBackend ? new SVGCanvas(width, height) : new CanvasElement(width, height)

  let ctx
  canvasElement.getContext = function getContext(type, attr = {}) {
    if (type !== '2d') {
      throw new Error('Unsupported type')
    }
    const attrs = { alpha: true, colorSpace: 'srgb', ...attr }
    ctx = ctx
      ? ctx
      : isSvgBackend
      ? new CanvasRenderingContext2D(this.width, this.height, attrs.colorSpace, flag)
      : new CanvasRenderingContext2D(this.width, this.height, attrs.colorSpace)
    createContext(ctx, this.width, this.height, attrs)

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
      value: function createImageData(widthOrImage, height, attrs = {}) {
        if (widthOrImage instanceof ImageData) {
          return new ImageData(widthOrImage.data, widthOrImage.width, widthOrImage.height)
        }
        return new ImageData(widthOrImage, height, { colorSpace: 'srgb', ...attrs })
      },
      configurable: true,
      enumerable: false,
      writable: true,
    })

    Object.defineProperty(canvasElement, 'ctx', {
      value: ctx,
      enumerable: false,
      configurable: false,
    })

    ctx.canvas = canvasElement

    return ctx
  }

  const {
    encode: canvasEncode,
    encodeSync: canvasEncodeSync,
    toBuffer: canvasToBuffer,
    toDataURL: canvasToDataURL,
    toDataURLAsync: canvasToDataURLAsync,
  } = Object.getPrototypeOf(canvasElement)

  canvasElement.encode = function encode(type, qualityOrConfig = {}) {
    if (type === 'avif') {
      return canvasEncode.call(this, type, JSON.stringify(qualityOrConfig))
    }
    return canvasEncode.call(this, type, qualityOrConfig)
  }

  canvasElement.encodeSync = function encodeSync(type, qualityOrConfig = {}) {
    if (type === 'avif') {
      return canvasEncodeSync.call(this, type, JSON.stringify(qualityOrConfig))
    }
    return canvasEncodeSync.call(this, type, qualityOrConfig)
  }

  canvasElement.toBuffer = function toBuffer(type = 'image/png', qualityOrConfig = {}) {
    if (type === 'avif') {
      return canvasToBuffer.call(this, type, JSON.stringify(qualityOrConfig))
    }
    return canvasToBuffer.call(this, type, qualityOrConfig)
  }

  canvasElement.toDataURL = function toDataURL(type = 'image/png', qualityOrConfig = {}) {
    if (type === 'avif') {
      return canvasToDataURL.call(this, type, JSON.stringify(qualityOrConfig))
    }
    return canvasToDataURL.call(this, type, qualityOrConfig)
  }

  canvasElement.toDataURLAsync = function toDataURLAsync(type = 'image/png', qualityOrConfig = {}) {
    if (type === 'avif') {
      return canvasToDataURLAsync.call(this, type, JSON.stringify(qualityOrConfig))
    }
    return canvasToDataURLAsync.call(this, type, qualityOrConfig)
  }

  return canvasElement
}

class Canvas {
  constructor(width, height, flag) {
    return createCanvas(width, height, flag)
  }
}

if (!process.env.DISABLE_SYSTEM_FONTS_LOAD) {
  GlobalFonts.loadSystemFonts()
  const platformName = platform()
  const homedirPath = homedir()
  switch (platformName) {
    case 'win32':
      GlobalFonts.loadFontsFromDir(join(homedirPath, 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts'))
      break
    case 'darwin':
      GlobalFonts.loadFontsFromDir(join(homedirPath, 'Library', 'Fonts'))
      break
    case 'linux':
      GlobalFonts.loadFontsFromDir(join('usr', 'local', 'share', 'fonts'))
      GlobalFonts.loadFontsFromDir(join(homedirPath, '.fonts'))
      break
  }
}

module.exports = {
  clearAllCache,
  Canvas,
  createCanvas,
  Path2D,
  ImageData,
  Image,
  PathOp,
  FillType,
  StrokeCap,
  StrokeJoin,
  SvgExportFlag,
  GlobalFonts: GlobalFonts,
  convertSVGTextToPath,
  DOMPoint,
  DOMMatrix,
  DOMRect,
  loadImage,
}
