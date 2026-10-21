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
  _toNumber: toNumber,
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

// Re-evaluating this module (Jest resets its module registry per test
// file; the .node binding and its prototypes stay loaded) must wrap the
// native methods again, not the previous wrappers: their argument padding
// would corrupt the argument count the native methods read.
const NATIVE_METHODS = Symbol.for('@napi-rs/canvas:native-methods')
function nativeMethods(proto) {
  let stash = proto[NATIVE_METHODS]
  if (stash === undefined) {
    stash = {}
    Object.defineProperty(proto, NATIVE_METHODS, { value: stash })
  }
  return stash
}

const canvasNative = nativeMethods(CanvasElement.prototype)
const _toBlob = (canvasNative.toBlob ??= CanvasElement.prototype.toBlob)
const _convertToBlob = (canvasNative.convertToBlob ??= CanvasElement.prototype.convertToBlob)
// A native method of CanvasElement for the receiver check: with no arguments
// it has no side effects.
const canvasBrand = (canvasNative.getContext ??= CanvasElement.prototype.getContext)
if ('Blob' in globalThis) {
  // toBlob(callback, type, quality), as Chrome: the receiver, the argument
  // count and the callback are checked first, then the native method converts
  // the type and encodes. The callback gets the Blob, or null without pixels
  // or when the encoder fails, from a task. A throw in it is an uncaught
  // exception, as in Chrome (window.onerror).
  CanvasElement.prototype.toBlob = function toBlob(callback) {
    if (arguments.length < 1) {
      argumentCountError(canvasBrand, this, 'toBlob', 'HTMLCanvasElement', 1, 0)
    }
    if (typeof callback !== 'function') {
      bindingTypeError(canvasBrand, this, 'toBlob', 'HTMLCanvasElement', "parameter 1 is not of type 'Function'.")
    }
    // Only the arguments that were passed: past arguments.length,
    // arguments[i] reads Object.prototype[i], which Chrome never reads.
    const type = arguments.length > 1 ? arguments[1] : undefined
    const quality = arguments.length > 2 ? arguments[2] : undefined
    _toBlob.call(this, type, quality).then(
      (result) => {
        const blob = result === null ? null : new Blob([result.data], { type: result.type })
        queueMicrotask(() => callback(blob))
      },
      () => queueMicrotask(() => callback(null)),
    )
  }
  // convertToBlob(options): Chrome's OffscreenCanvas method. An options error
  // rejects the promise, as a WebIDL conversion error of a promise method.
  CanvasElement.prototype.convertToBlob = function convertToBlob() {
    let pending
    try {
      pending = _convertToBlob.call(this, arguments.length > 0 ? arguments[0] : undefined)
    } catch (error) {
      return Promise.reject(error)
    }
    return pending.then((result) => new Blob([result.data], { type: result.type }))
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

const ctxNative = nativeMethods(CanvasRenderingContext2D.prototype)
const _getTransform = (ctxNative.getTransform ??= CanvasRenderingContext2D.prototype.getTransform)

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

// A TypeError as Blink's bindings throw it after the receiver check, with the
// message formatted as argumentCountError does.
function bindingTypeError(brand, self, method, iface, message) {
  brand.call(self)
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
  const stash = nativeMethods(proto)
  const native = (stash[method] ??= proto[method])
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
  ['createConicGradient', 3],
  ['createLinearGradient', 4],
  ['createRadialGradient', 6],
  ['ellipse', 7],
  ['fillRect', 4],
  ['fillText', 3],
  ['getImageData', 4],
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
  const stash = nativeMethods(Class.prototype)
  requireArguments(Class.prototype, (stash.getContext ??= Class.prototype.getContext), iface, 'getContext', 1)
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
// so a native function checks them and builds the instance itself, from
// new.target.prototype. Instances share the class prototype, so instanceof
// works for those that createImageData and getImageData return.
const ImageData = _imageDataConstructor()
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
const _fill = (ctxNative.fill ??= CanvasRenderingContext2D.prototype.fill)
CanvasRenderingContext2D.prototype.fill = function fill() {
  const count = Math.min(arguments.length, 2)
  return _fill.call(
    this,
    count > 0 ? arguments[0] : undefined,
    count > 1 ? arguments[1] : undefined,
    count === 0 ? undefined : argumentCount(count, arguments[count - 1]),
  )
}

const _clip = (ctxNative.clip ??= CanvasRenderingContext2D.prototype.clip)
CanvasRenderingContext2D.prototype.clip = function clip() {
  const count = Math.min(arguments.length, 2)
  return _clip.call(
    this,
    count > 0 ? arguments[0] : undefined,
    count > 1 ? arguments[1] : undefined,
    count === 0 ? undefined : argumentCount(count, arguments[count - 1]),
  )
}

const _stroke = (ctxNative.stroke ??= CanvasRenderingContext2D.prototype.stroke)
CanvasRenderingContext2D.prototype.stroke = function stroke() {
  if (arguments.length === 0) {
    return _stroke.call(this, undefined, undefined)
  }
  const path = arguments[0]
  return _stroke.call(this, path, argumentCount(1, path))
}

const _isPointInPath = (ctxNative.isPointInPath ??= CanvasRenderingContext2D.prototype.isPointInPath)
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

const _isPointInStroke = (ctxNative.isPointInStroke ??= CanvasRenderingContext2D.prototype.isPointInStroke)
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

// A TypeError as Chrome's bindings throw it, as in argumentCountError: the
// stack keeps the bare message, and `message` gets the prefix.
function contextTypeError(prefix, message) {
  const error = new TypeError(message)
  void error.stack
  Object.defineProperty(error, 'message', {
    value: prefix + message,
    writable: true,
    enumerable: true,
    configurable: true,
  })
  return error
}

// An `unrestricted double` member of a matrix dictionary; undefined when it
// is absent. The native ToNumber keeps the engine's texts, and the error
// names the member, as in Chrome.
function matrixMember(value, key, dictionary, prefix) {
  if (typeof value === 'number' || value === undefined) return value
  return toNumber(value, `${prefix}Failed to read the '${key}' property from '${dictionary}': `)
}

// a and m11 (and so on) disagree: both given and not equal. Two NaNs agree.
const mismatch = (x, y) => x !== undefined && y !== undefined && x !== y && (x === x || y === y)
// A 3D member against its identity value; absent is the identity. As C++
// truthiness, NaN counts as 3D and -0 as 0.
const notZero = (v) => v !== undefined && v !== 0
const notOne = (v) => v !== undefined && v !== 1

// The matrix of a DOMMatrix2DInit, or of a DOMMatrixInit when `full`, as
// [m11, m12, m21, m22, m41, m42]; undefined and null are {}. As Blink's
// bindings, every member is read with [[Get]], in order (a..f, m11, m12,
// m21, m22, m41, m42, then is2D and m13..m44), then checked as
// DOMMatrixReadOnly::ValidateAndFixup (dom_matrix_read_only.cc). A DOMMatrix
// is read the same way: an own property, a patched getter or a Proxy may
// make its members disagree. The result is one shared array: read it before
// any other user code runs.
const MATRIX = [1, 0, 0, 1, 0, 0]
function matrix2DFromInit(init, prefix, full) {
  if (init === undefined || init === null) {
    MATRIX[0] = 1
    MATRIX[1] = 0
    MATRIX[2] = 0
    MATRIX[3] = 1
    MATRIX[4] = 0
    MATRIX[5] = 0
    return MATRIX
  }
  if (typeof init !== 'object' && typeof init !== 'function') {
    throw contextTypeError(prefix, `The provided value is not of type '${full ? 'DOMMatrixInit' : 'DOMMatrix2DInit'}'.`)
  }
  const D2 = 'DOMMatrix2DInit'
  const a = matrixMember(init.a, 'a', D2, prefix)
  const b = matrixMember(init.b, 'b', D2, prefix)
  const c = matrixMember(init.c, 'c', D2, prefix)
  const d = matrixMember(init.d, 'd', D2, prefix)
  const e = matrixMember(init.e, 'e', D2, prefix)
  const f = matrixMember(init.f, 'f', D2, prefix)
  const m11 = matrixMember(init.m11, 'm11', D2, prefix)
  const m12 = matrixMember(init.m12, 'm12', D2, prefix)
  const m21 = matrixMember(init.m21, 'm21', D2, prefix)
  const m22 = matrixMember(init.m22, 'm22', D2, prefix)
  const m41 = matrixMember(init.m41, 'm41', D2, prefix)
  const m42 = matrixMember(init.m42, 'm42', D2, prefix)
  let is3DIn2D = false
  if (full) {
    const D = 'DOMMatrixInit'
    const is2D = init.is2D
    const m13 = matrixMember(init.m13, 'm13', D, prefix)
    const m14 = matrixMember(init.m14, 'm14', D, prefix)
    const m23 = matrixMember(init.m23, 'm23', D, prefix)
    const m24 = matrixMember(init.m24, 'm24', D, prefix)
    const m31 = matrixMember(init.m31, 'm31', D, prefix)
    const m32 = matrixMember(init.m32, 'm32', D, prefix)
    const m33 = matrixMember(init.m33, 'm33', D, prefix)
    const m34 = matrixMember(init.m34, 'm34', D, prefix)
    const m43 = matrixMember(init.m43, 'm43', D, prefix)
    const m44 = matrixMember(init.m44, 'm44', D, prefix)
    // is2D is a boolean member: ToBoolean when present.
    is3DIn2D =
      is2D !== undefined &&
      !!is2D &&
      (notZero(m31) ||
        notZero(m32) ||
        notZero(m13) ||
        notZero(m23) ||
        notZero(m43) ||
        notZero(m14) ||
        notZero(m24) ||
        notZero(m34) ||
        notOne(m33) ||
        notOne(m44))
  }
  if (
    mismatch(a, m11) ||
    mismatch(b, m12) ||
    mismatch(c, m21) ||
    mismatch(d, m22) ||
    mismatch(e, m41) ||
    mismatch(f, m42)
  ) {
    throw contextTypeError(prefix, 'Property mismatch on matrix initialization.')
  }
  if (is3DIn2D) {
    throw contextTypeError(prefix, 'The is2D member is set to true but the input matrix is a 3d matrix.')
  }
  MATRIX[0] = m11 !== undefined ? m11 : a !== undefined ? a : 1
  MATRIX[1] = m12 !== undefined ? m12 : b !== undefined ? b : 0
  MATRIX[2] = m21 !== undefined ? m21 : c !== undefined ? c : 0
  MATRIX[3] = m22 !== undefined ? m22 : d !== undefined ? d : 1
  MATRIX[4] = m41 !== undefined ? m41 : e !== undefined ? e : 0
  MATRIX[5] = m42 !== undefined ? m42 : f !== undefined ? f : 0
  return MATRIX
}

// setTransform(): six or more arguments are six numbers, fewer a DOMMatrixInit
// (canvas_2d_recorder_context.idl), and an explicit undefined counts. The
// DOMMatrixInit is read above; the native method takes six numbers. It reads
// a first argument that is not a number as a DOMMatrixInit, the form a raw
// js-binding call may use, so ToNumber runs here for such an `a`.
const _setTransform = (ctxNative.setTransform ??= CanvasRenderingContext2D.prototype.setTransform)
// A cheap native method: on another receiver it throws 'Illegal invocation',
// which Chrome checks before it converts any argument.
const ctxReceiver = CanvasRenderingContext2D.prototype.isContextLost
const SET_TRANSFORM = "Failed to execute 'setTransform' on 'CanvasRenderingContext2D': "
CanvasRenderingContext2D.prototype.setTransform = function setTransform() {
  if (arguments.length >= 6) {
    let a = arguments[0]
    if (typeof a !== 'number') {
      ctxReceiver.call(this)
      a = toNumber(a, SET_TRANSFORM)
    }
    return _setTransform.call(this, a, arguments[1], arguments[2], arguments[3], arguments[4], arguments[5])
  }
  // Past arguments.length, arguments[0] would read Object.prototype[0].
  const init = arguments.length > 0 ? arguments[0] : undefined
  if (init !== undefined && init !== null) ctxReceiver.call(this)
  const m = matrix2DFromInit(init, SET_TRANSFORM, true)
  return _setTransform.call(this, m[0], m[1], m[2], m[3], m[4], m[5])
}

// addPath(path, transform = {}): Chrome checks the receiver, the argument
// count and the path, then reads the DOMMatrix2DInit, read above. The native
// method takes six numbers after the path; anything else there is a
// DOMMatrix2DInit, which only a raw js-binding call passes. Without a
// transform (undefined or null is `{}`), a native method that takes only the
// path adds it as it is; Chrome's Path2D has no such method, so it comes off
// the prototype.
const pathNative = nativeMethods(Path2D.prototype)
const _addPath = (pathNative.addPath ??= Path2D.prototype.addPath)
const _addPathWithoutTransform = (pathNative._addPathWithoutTransform ??= Path2D.prototype._addPathWithoutTransform)
delete Path2D.prototype._addPathWithoutTransform
const ADD_PATH = "Failed to execute 'addPath' on 'Path2D': "
Path2D.prototype.addPath = function addPath() {
  if (arguments.length < 1) {
    argumentCountError(pathBrand, this, 'addPath', 'Path2D', 1, arguments.length)
  }
  const path = arguments[0]
  // Past arguments.length, arguments[1] would read Object.prototype[1].
  const transform = arguments.length > 1 ? arguments[1] : undefined
  if (transform === undefined || transform === null) {
    return _addPathWithoutTransform.call(this, path)
  }
  pathBrand.call(this)
  try {
    pathBrand.call(path)
  } catch {
    throw contextTypeError(ADD_PATH, "parameter 1 is not of type 'Path2D'.")
  }
  const m = matrix2DFromInit(transform, ADD_PATH, false)
  return _addPath.call(this, path, m[0], m[1], m[2], m[3], m[4], m[5])
}
Object.defineProperty(Path2D.prototype.addPath, 'length', { value: 1 })

// createImageData(): WebIDL picks the overload from the argument count, and an
// explicit undefined counts: createImageData(imagedata, undefined) is the
// (sw, sh) form.
const _createImageData = (ctxNative.createImageData ??= CanvasRenderingContext2D.prototype.createImageData)

CanvasRenderingContext2D.prototype.createImageData = function createImageData() {
  const count = arguments.length
  // Past arguments.length, arguments[i] would read Object.prototype[i]: pass
  // undefined there, as napi pads missing arguments.
  return _createImageData.call(
    this,
    count > 0 ? arguments[0] : undefined,
    count > 1 ? arguments[1] : undefined,
    count > 2 ? arguments[2] : undefined,
    count > 3 ? arguments[3] : undefined,
    ARGUMENT_COUNTS[Math.min(count, 4)],
  )
}
Object.defineProperty(CanvasRenderingContext2D.prototype.createImageData, 'length', { value: 1 })

// putImageData(imagedata, dx, dy) or (imagedata, dx, dy, dirtyX, dirtyY,
// dirtyWidth, dirtyHeight): as in Chrome, it needs 3 arguments; the native
// method picks the overload from the argument count (3 or 7).
const _putImageData = (ctxNative.putImageData ??= CanvasRenderingContext2D.prototype.putImageData)

CanvasRenderingContext2D.prototype.putImageData = function putImageData() {
  const count = arguments.length
  if (count < 3) {
    argumentCountError(ctxBrand, this, 'putImageData', 'CanvasRenderingContext2D', 3, count)
  }
  // Past arguments.length, arguments[i] would read Object.prototype[i]: pass
  // undefined there, as napi pads missing arguments.
  return _putImageData.call(
    this,
    arguments[0],
    arguments[1],
    arguments[2],
    count > 3 ? arguments[3] : undefined,
    count > 4 ? arguments[4] : undefined,
    count > 5 ? arguments[5] : undefined,
    count > 6 ? arguments[6] : undefined,
    ARGUMENT_COUNTS[Math.min(count, 7)],
  )
}
Object.defineProperty(CanvasRenderingContext2D.prototype.putImageData, 'length', { value: 3 })

// createPattern(image, repetitionType): as in Chrome, both arguments are
// required, and the image is converted before the repetition, a
// [LegacyNullToEmptyString] DOMString (canvas_2d_recorder_context.idl), so
// null is '' and undefined is 'undefined'.
const _createPattern = (ctxNative.createPattern ??= CanvasRenderingContext2D.prototype.createPattern)

CanvasRenderingContext2D.prototype.createPattern = function createPattern(image, repetition) {
  return _createPattern.call(this, image, repetition, ARGUMENT_COUNTS[Math.min(arguments.length, 4)])
}

// addColorStop(offset, color): both arguments are required. CanvasGradient
// has no other native method to check the receiver first, so the native
// method itself reads the real count from the marker after them.
const gradientNative = nativeMethods(CanvasGradient.prototype)
const _addColorStop = (gradientNative.addColorStop ??= CanvasGradient.prototype.addColorStop)
CanvasGradient.prototype.addColorStop = function addColorStop(offset, color) {
  return _addColorStop.call(this, offset, color, ARGUMENT_COUNTS[Math.min(arguments.length, 2)])
}

// Workaround for webpack bundling issue with drawImage
// Store the original drawImage method
const _drawImage = (ctxNative.drawImage ??= CanvasRenderingContext2D.prototype.drawImage)

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
  // macOS: CoreText's installed fonts, user fonts included, listed at the
  // first font lookup.
  GlobalFonts.enableSystemFonts()
  const platformName = platform()
  const homedirPath = homedir()
  switch (platformName) {
    case 'win32':
      GlobalFonts.loadFontsFromDir(join(homedirPath, 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts'))
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
