const { platform, homedir } = require('os')
const { join } = require('path')

const {
  CanvasRenderingContext2D,
  CanvasElement,
  createContext,
  SVGCanvas,
  Path2D,
  ImageData,
  Image,
  CanvasPattern,
  GlobalFonts,
  convertSVGTextToPath: _convertSVGTextToPath,
} = require('./js-binding')

const { DOMPoint, DOMMatrix, DOMRect } = require('./geometry')

const StrokeJoin = {
  Miter: 0,
  Round: 1,
  Bevel: 2,
}

const StrokeCap = {
  Butt: 0,
  Round: 1,
  Square: 2,
}

const PathOp = {
  Difference: 0, // subtract the op path from the first path
  Intersect: 1, // intersect the two paths
  Union: 2, // union (inclusive-or) the two paths
  XOR: 3, // exclusive-or the two paths
  ReverseDifference: 4, // subtract the first path from the op path
}

const FillType = {
  Winding: 0,
  EvenOdd: 1,
  InverseWinding: 2,
  InverseEvenOdd: 3,
}

const SvgExportFlag = {
  ConvertTextToPaths: 0x01,
  NoPrettyXML: 0x02,
  RelativePathEncoding: 0x04,
}

const GlobalFontsSingleton = new GlobalFonts()
let FamilyNamesSet = JSON.parse(GlobalFontsSingleton._families)

// eslint-disable-next-line sonarjs/no-unused-collection
const Fonts = []

Object.defineProperty(GlobalFontsSingleton, 'register', {
  value: function register(fontData, nameAlias = '') {
    const result = GlobalFontsSingleton._register(fontData, nameAlias)
    FamilyNamesSet = JSON.parse(GlobalFontsSingleton._families)
    Fonts.push(fontData)
    return result
  },
  configurable: false,
  enumerable: false,
  writable: false,
})

Object.defineProperty(GlobalFontsSingleton, 'registerFromPath', {
  value: function registerFromPath(path, nameAlias = '') {
    const result = GlobalFontsSingleton._registerFromPath(path, nameAlias)
    FamilyNamesSet = JSON.parse(GlobalFontsSingleton._families)
    return result
  },
  configurable: false,
  enumerable: false,
  writable: false,
})

Object.defineProperty(GlobalFontsSingleton, 'loadFontsFromDir', {
  value: function loadFontsFromDir(path) {
    const result = GlobalFontsSingleton._loadFontsFromDir(path)
    FamilyNamesSet = JSON.parse(GlobalFontsSingleton._families)
    return result
  },
  configurable: false,
  enumerable: false,
  writable: false,
})

Object.defineProperty(GlobalFontsSingleton, 'families', {
  get: function () {
    return FamilyNamesSet
  },
})

Object.defineProperty(GlobalFontsSingleton, 'has', {
  value: function has(name) {
    return !!FamilyNamesSet.find(({ family }) => family === name)
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

Path2D.prototype.stroke = function stroke(strokeOptions = {}) {
  const width = typeof strokeOptions.width === 'undefined' ? 1 : strokeOptions.width
  const miterLimit = typeof strokeOptions.miterLimit === 'undefined' ? 4 : strokeOptions.miterLimit
  const join = typeof strokeOptions.join === 'undefined' ? StrokeJoin.Miter : strokeOptions.join
  const cap = typeof strokeOptions.cap === 'undefined' ? StrokeCap.Butt : strokeOptions.cap

  return this._stroke(width, miterLimit, join, cap)
}

Path2D.prototype.getFillTypeString = function getFillTypeString() {
  const fillType = this.getFillType()

  if (fillType === FillType.Winding) {
    return 'nonzero'
  } else if (fillType === FillType.EvenOdd) {
    return 'evenodd'
  } else {
    return 'nonzero' // default
  }
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
      ? new CanvasRenderingContext2D(this.width, this.height, GlobalFontsSingleton, attrs.colorSpace, flag)
      : new CanvasRenderingContext2D(this.width, this.height, GlobalFontsSingleton, attrs.colorSpace)
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

  // See also: https://github.com/kornelski/cavif-rs#usage
  const avifDefaultQuality = 80
  const avifConfig = {
    // Quality from 1 (worst) to 100 (best), the default value is 80. The numbers have different meaning than JPEG's quality scale. Beware when comparing codecs. There is no lossless compression support.
    quality: avifDefaultQuality,

    // Calculate alphaQuality, this is consistent with cavif.
    // https://github.com/kornelski/cavif-rs/blob/37847b95bb81d4cf90e36b7fab2c7fbbcf95abe2/src/main.rs#L97
    alphaQuality: Math.min((avifDefaultQuality + 100) / 2, avifDefaultQuality + avifDefaultQuality / 4 + 2),
    threads: 0,

    // Encoding speed between 1 (best, but slowest) and 10 (fastest, but a blurry mess), the default value is 4. Speeds 1 and 2 are unbelievably slow, but make files ~3-5% smaller. Speeds 7 and above degrade compression significantly, and are not recommended.
    speed: 4,
  }

  canvasElement.encode = function encode(type, qualityOrConfig) {
    if (type === 'avif') {
      return canvasEncode.call(
        this,
        type,
        JSON.stringify({
          ...avifConfig,
          ...(qualityOrConfig || {}),
        }),
      )
    }
    return canvasEncode.call(this, type, qualityOrConfig)
  }

  canvasElement.encodeSync = function encodeSync(type, qualityOrConfig) {
    if (type === 'avif') {
      return canvasEncodeSync.call(
        this,
        type,
        JSON.stringify({
          ...avifConfig,
          ...(qualityOrConfig || {}),
        }),
      )
    }
    return canvasEncodeSync.call(this, type, qualityOrConfig)
  }

  canvasElement.toBuffer = function toBuffer(type = 'image/png', qualityOrConfig) {
    if (type === 'avif') {
      return canvasToBuffer.call(
        this,
        type,
        JSON.stringify({
          ...avifConfig,
          ...(qualityOrConfig || {}),
        }),
      )
    }
    return canvasToBuffer.call(this, type, qualityOrConfig)
  }

  canvasElement.toDataURL = function toDataURL(type = 'image/png', qualityOrConfig) {
    if (type === 'avif') {
      return canvasToDataURL.call(
        this,
        type,
        JSON.stringify({
          ...avifConfig,
          ...(qualityOrConfig || {}),
        }),
      )
    }
    return canvasToDataURL.call(this, type, qualityOrConfig)
  }

  canvasElement.toDataURLAsync = function toDataURLAsync(type = 'image/png', qualityOrConfig) {
    if (type === 'avif') {
      return canvasToDataURLAsync.call(
        this,
        type,
        JSON.stringify({
          ...avifConfig,
          ...(qualityOrConfig || {}),
        }),
      )
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
  GlobalFontsSingleton.loadSystemFonts()
  const platformName = platform()
  const homedirPath = homedir()
  switch (platformName) {
    case 'win32':
      GlobalFontsSingleton.loadFontsFromDir(join(homedirPath, 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts'))
      break
    case 'darwin':
      GlobalFontsSingleton.loadFontsFromDir(join(homedirPath, 'Library', 'Fonts'))
      break
    case 'linux':
      GlobalFontsSingleton.loadFontsFromDir(join('usr', 'local', 'share', 'fonts'))
      GlobalFontsSingleton.loadFontsFromDir(join(homedirPath, '.fonts'))
      break
  }
  FamilyNamesSet = JSON.parse(GlobalFontsSingleton._families)
}

function convertSVGTextToPath(input) {
  return _convertSVGTextToPath(Buffer.isBuffer(input) ? input : Buffer.from(input), GlobalFontsSingleton)
}

module.exports = {
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
  GlobalFonts: GlobalFontsSingleton,
  convertSVGTextToPath,
  DOMPoint,
  DOMMatrix,
  DOMRect,
}
