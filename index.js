const { platform, homedir } = require('os')
const { join } = require('path')

const {
  clearAllCache,
  CanvasRenderingContext2D,
  CanvasElement,
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

function createCanvas(width, height, flag) {
  const isSvgBackend = typeof flag !== 'undefined'
  const canvasElement = isSvgBackend ? new SVGCanvas(width, height, flag) : new CanvasElement(width, height)
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
