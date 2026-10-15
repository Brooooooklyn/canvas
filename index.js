const { platform, homedir } = require('os')
const { join } = require('path')

const {
  clearAllCache,
  CanvasRenderingContext2D,
  CanvasElement,
  CanvasGradient,
  CanvasPattern,
  SVGCanvas,
  Path: Path2D,
  ImageData: NativeImageData,
  Image,
  FontKey,
  GlobalFonts,
  PathOp,
  FillType,
  StrokeJoin,
  StrokeCap,
  convertSVGTextToPath,
  PdfDocument,
  GifEncoder,
  GifDisposal,
  LottieAnimation,
  TextMetrics,
  _argumentCounts,
  _imageDataConstructor,
} = require('./js-binding')

const { DOMPoint, DOMMatrix, DOMRect } = require('./geometry')

const loadImage = require('./load-image')

// Add Symbol.dispose support for GifEncoder (ECMAScript 2024 Explicit Resource Management)
if (GifEncoder && typeof Symbol.dispose !== 'undefined') {
  GifEncoder.prototype[Symbol.dispose] = function () {
    this.dispose()
  }
}

// napi-rs defines a class's accessors in name order. Chrome's TextMetrics
// prototype has them in IDL order (text_metrics.idl), which for...in shows,
// then the constructor: define them again in that order.
for (const name of [
  'width',
  'actualBoundingBoxLeft',
  'actualBoundingBoxRight',
  'fontBoundingBoxAscent',
  'fontBoundingBoxDescent',
  'actualBoundingBoxAscent',
  'actualBoundingBoxDescent',
  'hangingBaseline',
  'alphabeticBaseline',
  'ideographicBaseline',
  'emHeightAscent',
  'emHeightDescent',
  'constructor',
]) {
  const descriptor = Object.getOwnPropertyDescriptor(TextMetrics.prototype, name)
  delete TextMetrics.prototype[name]
  Object.defineProperty(TextMetrics.prototype, name, descriptor)
}

// Chrome's Symbol.toStringTag, an own property of each prototype. The
// canvas and Image classes take their HTML element names; SVGCanvas has no
// counterpart and no tag.
for (const [Class, tag] of [
  [CanvasRenderingContext2D, 'CanvasRenderingContext2D'],
  [CanvasGradient, 'CanvasGradient'],
  [CanvasPattern, 'CanvasPattern'],
  [Path2D, 'Path2D'],
  [NativeImageData, 'ImageData'],
  [TextMetrics, 'TextMetrics'],
  [CanvasElement, 'HTMLCanvasElement'],
  [Image, 'HTMLImageElement'],
]) {
  Object.defineProperty(Class.prototype, Symbol.toStringTag, { value: tag, configurable: true })
}

const SvgExportFlag = {
  ConvertTextToPaths: 0x01,
  NoPrettyXML: 0x02,
  RelativePathEncoding: 0x04,
}

if (!('families' in GlobalFonts)) {
  Object.defineProperty(GlobalFonts, 'families', {
    get: function () {
      return JSON.parse(GlobalFonts.getFamilies().toString())
    },
  })
}

if (!('has' in GlobalFonts)) {
  Object.defineProperty(GlobalFonts, 'has', {
    value: function has(name) {
      return !!JSON.parse(GlobalFonts.getFamilies().toString()).find(({ family }) => family === name)
    },
    configurable: false,
    enumerable: false,
    writable: false,
  })
}

const _toBlob = CanvasElement.prototype.toBlob
const _convertToBlob = CanvasElement.prototype.convertToBlob
if ('Blob' in globalThis) {
  CanvasElement.prototype.toBlob = function toBlob(callback, mimeType, quality) {
    _toBlob.call(
      this,
      function (/** @type {Uint8Array} */ imageBuffer) {
        const blob = new Blob([imageBuffer.buffer], { type: mimeType })
        callback(blob)
      },
      mimeType,
      quality,
    )
  }
  CanvasElement.prototype.convertToBlob = function convertToBlob(options) {
    return _convertToBlob.call(this, options).then((/** @type {Uint8Array} */ imageBuffer) => {
      const blob = new Blob([imageBuffer.buffer], { type: options?.mime || 'image/png' })
      return blob
    })
  }
} else {
  // oxlint-disable-next-line no-unused-vars
  CanvasElement.prototype.toBlob = function toBlob(callback, mimeType, quality) {
    callback(null)
  }
  // oxlint-disable-next-line no-unused-vars
  CanvasElement.prototype.convertToBlob = function convertToBlob(options) {
    return Promise.reject(new Error('Blob is not supported in this environment'))
  }
}

const _getTransform = CanvasRenderingContext2D.prototype.getTransform

CanvasRenderingContext2D.prototype.getTransform = function getTransform() {
  const transform = _getTransform.apply(this, arguments)
  // monkey patched, skip
  if (transform instanceof DOMMatrix) {
    return transform
  }
  const { a, b, c, d, e, f } = transform
  return new DOMMatrix([a, b, c, d, e, f])
}

// Chrome checks the receiver ('Illegal invocation'), then the argument count,
// before it converts any argument. `brand` is a native method of the class: a
// call on another receiver throws 'Illegal invocation'. As Blink's binding
// errors, the stack keeps the bare message and `message` gets the prefix, as
// an enumerable own property.
function argumentCountError(brand, self, method, iface, required, present) {
  brand.call(self)
  const message = `${required} argument${required === 1 ? '' : 's'} required, but only ${present} present.`
  const error = new TypeError(message)
  void error.stack
  Object.defineProperty(error, 'message', {
    value: `Failed to execute '${method}' on '${iface}': ${message}`,
    writable: true,
    enumerable: true,
    configurable: true,
  })
  throw error
}

// Wraps `proto[method]` with Chrome's argument count check; the wrapper's
// `length` is the required argument count, as Chrome's Function.length.
// napi pads missing arguments with undefined, so the native method cannot
// tell f(1) from f(1, undefined); an explicit undefined counts in Chrome.
function requireArguments(proto, brand, iface, method, required) {
  const native = proto[method]
  const wrapper = {
    [method]() {
      if (arguments.length < required) {
        argumentCountError(brand, this, method, iface, required, arguments.length)
      }
      return native.apply(this, arguments)
    },
  }[method]
  Object.defineProperty(wrapper, 'length', { value: required })
  proto[method] = wrapper
}

const ctxBrand = CanvasRenderingContext2D.prototype.getContextAttributes
for (const [method, required] of [
  ['arc', 5],
  ['arcTo', 5],
  ['bezierCurveTo', 6],
  ['clearRect', 4],
  ['ellipse', 7],
  ['fillRect', 4],
  ['fillText', 3],
  ['lineTo', 2],
  ['measureText', 1],
  ['moveTo', 2],
  ['quadraticCurveTo', 4],
  ['rect', 4],
  ['rotate', 1],
  ['roundRect', 4],
  ['scale', 2],
  ['setLineDash', 1],
  ['strokeRect', 4],
  ['strokeText', 3],
  ['transform', 6],
  ['translate', 2],
]) {
  requireArguments(CanvasRenderingContext2D.prototype, ctxBrand, 'CanvasRenderingContext2D', method, required)
}

// getContext(contextId, options): Chrome needs the id. The native method is
// its own brand: with no arguments it converts undefined to 'undefined' and
// returns null, without side effects.
for (const [Class, iface] of [
  [CanvasElement, 'HTMLCanvasElement'],
  [SVGCanvas, 'SVGCanvas'],
]) {
  requireArguments(Class.prototype, Class.prototype.getContext, iface, 'getContext', 1)
}

const pathBrand = Path2D.prototype.getFillType
for (const [method, required] of [
  ['arc', 5],
  ['arcTo', 5],
  ['bezierCurveTo', 6],
  ['ellipse', 7],
  ['lineTo', 2],
  ['moveTo', 2],
  ['quadraticCurveTo', 4],
  ['rect', 4],
  ['roundRect', 4],
]) {
  requireArguments(Path2D.prototype, pathBrand, 'Path2D', method, required)
}

// The argument-count markers for 0 to 9 arguments. napi pads missing
// arguments with undefined, so the wrappers below pass the real count after
// the positional arguments, as one of these markers: the native methods read
// a count only from a marker, and any other value there (from a raw
// js-binding call) is an extra argument.
const ARGUMENT_COUNTS = _argumentCounts()

// new ImageData(): Chrome checks `new` and the real argument count before it
// picks an overload (image_data.idl). The class napi-rs makes sees neither,
// so a native function checks them and builds the class, with the count
// after the 4 positional arguments. Instances share the class prototype, so
// instanceof works for those that createImageData and getImageData return.
const construct = Reflect.construct
const ImageData = _imageDataConstructor((args, argc, newTarget) =>
  construct(NativeImageData, [args[0], args[1], args[2], args[3], ARGUMENT_COUNTS[Math.min(argc, 4)]], newTarget),
)
Object.defineProperty(ImageData, 'length', { value: 2 })
Object.defineProperty(ImageData, 'prototype', { value: NativeImageData.prototype, writable: false })
Object.defineProperty(NativeImageData.prototype, 'constructor', {
  value: ImageData,
  writable: true,
  enumerable: false,
  configurable: true,
})

// What the wrappers below pass after their `n` positional arguments, for a
// call with `count` (1 to `n`) of them, the last one `last`. Without a marker
// the native method counts up to the last argument that is not undefined:
// that is `count` unless `last` is an explicit undefined, and only then is
// the marker needed.
function argumentCount(count, last) {
  return last === undefined ? ARGUMENT_COUNTS[count] : undefined
}

// fill(), clip(), stroke(), isPointInPath() and isPointInStroke(): WebIDL
// picks the overload from the argument count (canvas_2d_recorder_context.idl),
// and an explicit undefined counts: fill(path, undefined) is the nonzero
// fill of path, fill(undefined, 'evenodd') a TypeError.
// These wrappers and drawImage's read only the arguments the call has: past
// arguments.length, arguments[i] would read Object.prototype[i], which
// Chrome never reads.
const _fill = CanvasRenderingContext2D.prototype.fill
CanvasRenderingContext2D.prototype.fill = function fill() {
  const count = Math.min(arguments.length, 2)
  return _fill.call(
    this,
    count > 0 ? arguments[0] : undefined,
    count > 1 ? arguments[1] : undefined,
    count === 0 ? undefined : argumentCount(count, arguments[count - 1]),
  )
}

const _clip = CanvasRenderingContext2D.prototype.clip
CanvasRenderingContext2D.prototype.clip = function clip() {
  const count = Math.min(arguments.length, 2)
  return _clip.call(
    this,
    count > 0 ? arguments[0] : undefined,
    count > 1 ? arguments[1] : undefined,
    count === 0 ? undefined : argumentCount(count, arguments[count - 1]),
  )
}

const _stroke = CanvasRenderingContext2D.prototype.stroke
CanvasRenderingContext2D.prototype.stroke = function stroke() {
  if (arguments.length === 0) {
    return _stroke.call(this, undefined, undefined)
  }
  const path = arguments[0]
  return _stroke.call(this, path, argumentCount(1, path))
}

const _isPointInPath = CanvasRenderingContext2D.prototype.isPointInPath
CanvasRenderingContext2D.prototype.isPointInPath = function isPointInPath() {
  if (arguments.length < 2) {
    argumentCountError(ctxBrand, this, 'isPointInPath', 'CanvasRenderingContext2D', 2, arguments.length)
  }
  const count = Math.min(arguments.length, 4)
  return _isPointInPath.call(
    this,
    arguments[0],
    arguments[1],
    count > 2 ? arguments[2] : undefined,
    count > 3 ? arguments[3] : undefined,
    // (x, y, undefined) converts as (x, y) when x is not an object (only an
    // object can be a Path2D), so the count is not needed.
    count === 3 && typeof arguments[0] !== 'object' ? undefined : argumentCount(count, arguments[count - 1]),
  )
}
Object.defineProperty(CanvasRenderingContext2D.prototype.isPointInPath, 'length', { value: 2 })

const _isPointInStroke = CanvasRenderingContext2D.prototype.isPointInStroke
CanvasRenderingContext2D.prototype.isPointInStroke = function isPointInStroke() {
  if (arguments.length < 2) {
    argumentCountError(ctxBrand, this, 'isPointInStroke', 'CanvasRenderingContext2D', 2, arguments.length)
  }
  const count = Math.min(arguments.length, 3)
  return _isPointInStroke.call(
    this,
    arguments[0],
    arguments[1],
    count > 2 ? arguments[2] : undefined,
    argumentCount(count, arguments[count - 1]),
  )
}
Object.defineProperty(CanvasRenderingContext2D.prototype.isPointInStroke, 'length', { value: 2 })

// createImageData(): WebIDL picks the overload from the argument count, and an
// explicit undefined counts: createImageData(imagedata, undefined) is the
// (sw, sh) form.
const _createImageData = CanvasRenderingContext2D.prototype.createImageData

CanvasRenderingContext2D.prototype.createImageData = function createImageData() {
  return _createImageData.call(
    this,
    arguments[0],
    arguments[1],
    arguments[2],
    arguments[3],
    ARGUMENT_COUNTS[Math.min(arguments.length, 4)],
  )
}

// createPattern(image, repetitionType): as in Chrome, both arguments are
// required, and the image is converted before the repetition, a
// [LegacyNullToEmptyString] DOMString (canvas_2d_recorder_context.idl), so
// null is '' and undefined is 'undefined'.
const _createPattern = CanvasRenderingContext2D.prototype.createPattern

CanvasRenderingContext2D.prototype.createPattern = function createPattern(image, repetition) {
  return _createPattern.call(this, image, repetition, ARGUMENT_COUNTS[Math.min(arguments.length, 4)])
}

// Workaround for webpack bundling issue with drawImage
// Store the original drawImage method
const _drawImage = CanvasRenderingContext2D.prototype.drawImage

// Override drawImage to ensure proper type recognition in bundled environments.
// As in Chrome, it needs 3 arguments; the native method picks the overload
// from the argument count (3, 5 or 9).
CanvasRenderingContext2D.prototype.drawImage = function drawImage() {
  if (arguments.length < 3) {
    argumentCountError(ctxBrand, this, 'drawImage', 'CanvasRenderingContext2D', 3, arguments.length)
  }
  let image = arguments[0]
  // If the image is a Canvas-like object but not recognized due to bundling,
  // we need to ensure it's properly identified
  if (image && typeof image === 'object') {
    // First check if it's a wrapped canvas object
    if (image.canvas instanceof CanvasElement || image.canvas instanceof SVGCanvas) {
      image = image.canvas
    } else if (image._canvas instanceof CanvasElement || image._canvas instanceof SVGCanvas) {
      image = image._canvas
    }
    // Then check if it's a Canvas-like object by checking for getContext method
    else if (typeof image.getContext === 'function' && image.width && image.height) {
      // If it has canvas properties but isn't recognized as CanvasElement or SVGCanvas,
      // try to correct the prototype chain
      if (!(image instanceof CanvasElement) && !(image instanceof SVGCanvas)) {
        // Try to create a proper CanvasElement from the canvas-like object
        // This helps when webpack has transformed the prototype chain
        Object.setPrototypeOf(image, CanvasElement.prototype)
      }
    }
  }

  // Call the original drawImage with the potentially corrected image
  const count = Math.min(arguments.length, 9)
  return _drawImage.call(
    this,
    image,
    arguments[1],
    arguments[2],
    count > 3 ? arguments[3] : undefined,
    count > 4 ? arguments[4] : undefined,
    count > 5 ? arguments[5] : undefined,
    count > 6 ? arguments[6] : undefined,
    count > 7 ? arguments[7] : undefined,
    count > 8 ? arguments[8] : undefined,
    argumentCount(count, arguments[count - 1]),
  )
}
Object.defineProperty(CanvasRenderingContext2D.prototype.drawImage, 'length', { value: 3 })

function createCanvas(width, height, flag) {
  const isSvgBackend = typeof flag !== 'undefined'
  return isSvgBackend ? new SVGCanvas(width, height, flag) : new CanvasElement(width, height)
}

class Canvas {
  constructor(width, height, flag) {
    return createCanvas(width, height, flag)
  }

  static [Symbol.hasInstance](instance) {
    return instance instanceof CanvasElement || instance instanceof SVGCanvas
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
  FontKey,
  // Export these for better webpack compatibility
  CanvasElement,
  SVGCanvas,
  PDFDocument: PdfDocument,
  // GIF encoding
  GifEncoder,
  GifDisposal,
  // Lottie animation
  LottieAnimation,
}
