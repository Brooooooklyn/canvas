'use strict'

const { Readable } = require('node:stream')

const {
  createCanvas: _createCanvas,
  Canvas,
  CanvasElement,
  SVGCanvas,
  GlobalFonts,
  Image,
  ImageData,
  Path2D,
  DOMPoint,
  DOMMatrix,
  DOMRect,
  loadImage,
  PDFDocument,
  SvgExportFlag,
} = require('./index.js')

// CanvasRenderingContext2D is not re-exported by index.js, grab from native bindings
const { CanvasRenderingContext2D } = require('./js-binding')

// node-canvas defaults JPEG quality to 0.75 across all paths.
// @napi-rs/canvas native default is 0.92 (matching Blink/Chrome).
const NODE_CANVAS_DEFAULT_QUALITY = 0.75

// ---------------------------------------------------------------------------
// Stream classes (node-canvas returns Node.js Readable streams)
// ---------------------------------------------------------------------------

class PNGStream extends Readable {
  constructor(canvas, options) {
    super()
    this._canvas = canvas
    this._options = options || {}
    this._done = false
  }

  _read() {
    if (this._done) return
    this._done = true
    this._canvas
      .encode('png', _pngOptions(this._options))
      .then((buf) => {
        this.push(buf)
        this.push(null)
      })
      .catch((err) => {
        this.destroy(err)
      })
  }
}

class JPEGStream extends Readable {
  constructor(canvas, options) {
    super()
    this._canvas = canvas
    const opts = options || {}
    // node-canvas quality: 0-1 (default 0.75), encode() expects 0-100
    this._quality = Math.round((opts.quality != null ? opts.quality : NODE_CANVAS_DEFAULT_QUALITY) * 100)
    this._done = false
  }

  _read() {
    if (this._done) return
    this._done = true
    this._canvas
      .encode('jpeg', this._quality)
      .then((buf) => {
        this.push(buf)
        this.push(null)
      })
      .catch((err) => {
        this.destroy(err)
      })
  }
}

// ---------------------------------------------------------------------------
// Quality normalization helpers
// ---------------------------------------------------------------------------

const MIME_FORMAT_MAP = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
}

/**
 * Extract quality from a node-canvas config object or number.
 * Returns the raw 0-1 quality value, defaulting to NODE_CANVAS_DEFAULT_QUALITY
 * for JPEG/WebP when not specified.
 *
 * @param {string} mime
 * @param {number|object|undefined} configOrQuality
 * @returns {number|undefined}  0-1 scale for JPEG/WebP, undefined for other mimes
 */
function _extractQuality(mime, configOrQuality) {
  if (mime !== 'image/jpeg' && mime !== 'image/webp') return undefined
  if (configOrQuality == null) return NODE_CANVAS_DEFAULT_QUALITY
  if (typeof configOrQuality === 'number') return configOrQuality
  if (typeof configOrQuality === 'object' && configOrQuality.quality != null) {
    return configOrQuality.quality
  }
  return NODE_CANVAS_DEFAULT_QUALITY
}

/**
 * The native PNG options for a node-canvas PngConfig: `resolution` (pHYs chunk),
 * `compressionLevel` (zlib 0-9) and `filters` (libpng filter bitmask); undefined
 * when none of them is a number, so the native call stays a plain PNG encode.
 *
 * @param {object|undefined} config
 * @returns {{ resolution?: number, compressionLevel?: number, filters?: number }|undefined}
 */
function _pngOptions(config) {
  if (config === null || typeof config !== 'object') return undefined
  const resolution = config.resolution
  const compressionLevel = config.compressionLevel
  const filters = config.filters
  const options = {}
  let hasOption = false
  if (typeof resolution === 'number') {
    options.resolution = resolution
    hasOption = true
  }
  if (typeof compressionLevel === 'number') {
    options.compressionLevel = compressionLevel
    hasOption = true
  }
  if (typeof filters === 'number') {
    options.filters = filters
    hasOption = true
  }
  return hasOption ? options : undefined
}

// ---------------------------------------------------------------------------
// Compat methods added to each canvas instance created via this module
// ---------------------------------------------------------------------------

// Keep references to the original prototype methods
const _origToBuffer = CanvasElement.prototype.toBuffer
const _origToDataURL = CanvasElement.prototype.toDataURL

function _compatCreatePNGStream(options) {
  return new PNGStream(this, options)
}

function _compatCreateJPEGStream(options) {
  return new JPEGStream(this, options)
}

/**
 * node-canvas compatible toBuffer:
 * - toBuffer()                           → PNG (sync)
 * - toBuffer('image/png', config?)       → PNG (sync)
 * - toBuffer('image/jpeg', config?)      → JPEG (sync, quality 0-1)
 * - toBuffer('raw')                      → raw pixel data (sync)
 * - toBuffer(callback)                   → PNG (async)
 * - toBuffer(callback, mime, config?)    → specified format (async)
 */
function _compatToBuffer(mimeOrCallback, configOrQuality) {
  // Callback form: toBuffer(callback) or toBuffer(callback, mime, config)
  if (typeof mimeOrCallback === 'function') {
    const callback = mimeOrCallback
    const mime = typeof configOrQuality === 'string' ? configOrQuality : 'image/png'
    const config = arguments[2]

    if (mime === 'raw') {
      let buf
      try {
        buf = this.data()
      } catch (err) {
        callback(err)
        return
      }
      callback(null, buf)
      return
    }

    const format = MIME_FORMAT_MAP[mime]
    if (!format) {
      callback(new TypeError(`Unsupported MIME type "${mime}". Supported: ${Object.keys(MIME_FORMAT_MAP).join(', ')}`))
      return
    }
    const q = _extractQuality(mime, config)
    const options = format === 'png' ? _pngOptions(config) : q != null ? Math.round(q * 100) : undefined
    this.encode(format, options).then(
      (buf) => callback(null, buf),
      (err) => callback(err),
    )
    return
  }

  // Sync: no args → PNG
  if (mimeOrCallback === undefined) {
    return _origToBuffer.call(this, 'image/png')
  }

  // Sync: raw pixel data
  if (mimeOrCallback === 'raw') {
    return this.data()
  }

  // Sync: PNG takes the resolution; JPEG / WebP a quality (0-1) scaled to
  // 0-100 for native toBuffer
  if (mimeOrCallback === 'image/png') {
    return _origToBuffer.call(this, mimeOrCallback, _pngOptions(configOrQuality))
  }
  const q = _extractQuality(mimeOrCallback, configOrQuality)
  return _origToBuffer.call(this, mimeOrCallback, q != null ? Math.round(q * 100) : undefined)
}

/**
 * node-canvas compatible toDataURL:
 * - toDataURL()                              → PNG data URL (sync)
 * - toDataURL('image/jpeg', quality)         → JPEG data URL, quality 0-1 (sync)
 * - toDataURL(callback)                      → PNG data URL (async)
 * - toDataURL(mime, callback)                → data URL (async)
 * - toDataURL(mime, quality, callback)       → data URL with quality (async)
 */
function _compatToDataURL(mimeOrCallback, qualityOrCallback) {
  // toDataURL(callback)
  if (typeof mimeOrCallback === 'function') {
    this.toDataURLAsync('image/png').then(
      (url) => mimeOrCallback(null, url),
      (err) => mimeOrCallback(err),
    )
    return
  }
  // toDataURL(mime, callback)
  if (typeof qualityOrCallback === 'function') {
    this.toDataURLAsync(mimeOrCallback, _extractQuality(mimeOrCallback, undefined)).then(
      (url) => qualityOrCallback(null, url),
      (err) => qualityOrCallback(err),
    )
    return
  }
  // toDataURL(mime, quality, callback)
  const cb = arguments[2]
  if (typeof cb === 'function') {
    // Native toDataURLAsync expects 0-1 (f64) — pass quality through as-is
    const quality = _extractQuality(mimeOrCallback, qualityOrCallback)
    this.toDataURLAsync(mimeOrCallback, quality).then(
      (url) => cb(null, url),
      (err) => cb(err),
    )
    return
  }

  // Sync form: native toDataURL expects 0-1 (f64) — pass quality through as-is
  const quality = _extractQuality(mimeOrCallback, qualityOrCallback)
  return _origToDataURL.call(this, mimeOrCallback, quality)
}

/**
 * Attach node-canvas compatible methods to a CanvasElement instance.
 */
function _addCompatMethods(canvas) {
  canvas.createPNGStream = _compatCreatePNGStream
  canvas.createJPEGStream = _compatCreateJPEGStream
  canvas.toBuffer = _compatToBuffer
  canvas.toDataURL = _compatToDataURL
  return canvas
}

// ---------------------------------------------------------------------------
// Public API: registerFont / deregisterAllFonts
// ---------------------------------------------------------------------------

// Track FontKeys from registerFont() so deregisterAllFonts() can remove
// only user-registered fonts (matching node-canvas behavior which leaves
// system fonts untouched).
const _registeredFontKeys = []

// Whether the @font-face `font-weight` / `font-style` grammar (src/font.rs
// parse_font_face_weight / parse_font_face_style) surely rejects a value. It
// reads plain keywords, numbers, dimensions and comments; a value with any
// other token (`calc()`, a quote, an escape) is passed to registerFromPath as given, and
// registerFont throws if it is invalid, so a valid value is never dropped.
const _CSS_SPACE = /[ \t\n\r\f]+/
const _NUMBER = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?'
const _IDENT = '-?[A-Za-z_][A-Za-z0-9_-]*'
const _TOKEN = new RegExp(`^(?:(${_IDENT})|(${_NUMBER})(%|${_IDENT})?)$`)

// The plain tokens of a value, or null when it has another kind of token.
function _cssTokens(value) {
  // A comment separates tokens, as whitespace does; an unclosed one runs to the end.
  const trimmed = value.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ').replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '')
  const tokens = []
  for (const word of trimmed === '' ? [] : trimmed.split(_CSS_SPACE)) {
    const match = _TOKEN.exec(word)
    if (!match) return null
    tokens.push(
      match[1] !== undefined
        ? { keyword: match[1].toLowerCase() }
        : { number: Number(match[2]), unit: match[3] === undefined ? undefined : match[3].toLowerCase() },
    )
  }
  return tokens
}

function _isInvalidFaceWeight(value) {
  const tokens = _cssTokens(value)
  if (tokens === null) return false
  const weight = (t) => t.number !== undefined && t.unit === undefined && t.number >= 1 && t.number <= 1000
  if (tokens.length === 1 && tokens[0].keyword !== undefined) {
    return !['normal', 'bold', 'auto'].includes(tokens[0].keyword)
  }
  return !(tokens.length >= 1 && tokens.length <= 2 && tokens.every(weight))
}

function _isInvalidFaceStyle(value) {
  const tokens = _cssTokens(value)
  if (tokens === null) return false
  if (tokens.length === 1 && tokens[0].keyword !== undefined) {
    return !['normal', 'italic', 'oblique', 'auto'].includes(tokens[0].keyword)
  }
  // `oblique <angle> [<angle>]`, each written number in [-90, 90].
  const angle = (t) => ['deg', 'rad', 'grad', 'turn'].includes(t.unit) && t.number >= -90 && t.number <= 90
  return !(tokens.length >= 2 && tokens.length <= 3 && tokens[0].keyword === 'oblique' && tokens.slice(1).every(angle))
}

/**
 * Register a font file with the specified font face properties.
 * Compatible with node-canvas's registerFont(path, { family, weight?, style? }).
 *
 * `weight` and `style` are passed to GlobalFonts.registerFromPath as the
 * face's @font-face descriptors, so the faces of one family are picked by
 * them with CSS font matching. Register one call per face file.
 *
 * - A field that is not given is `auto`: a call with only `family` registers
 *   the file as GlobalFonts.registerFromPath(path, family) does, and a
 *   variable font keeps its axes.
 * - An explicit weight or style, `'normal'` included, pins a variable font to
 *   it, as with @font-face. Use a range such as `'100 900'` to keep the axis.
 * - A value the @font-face grammar rejects (`'bolder'`, `''`) counts as not
 *   given, as node-canvas ignores unknown values instead of throwing. An
 *   invalid value with a `calc()`, a quote or an escape makes registerFont
 *   throw.
 *
 * @param {string} path   Absolute path to the font file (.ttf, .otf, etc.)
 * @param {{ family: string, weight?: string | number, style?: string }} fontFace
 */
function registerFont(path, fontFace) {
  const family = fontFace ? fontFace.family : undefined
  if (typeof family !== 'string') {
    throw new TypeError('registerFont requires a fontFace with a "family" property')
  }
  // node-canvas reads `weight` as a string or a number and `style` as a
  // string; any other value, or one the @font-face grammar surely rejects,
  // counts as not given. This is checked here and not by retrying: a null
  // from registerFromPath can also mean the file failed to load.
  const w = fontFace.weight
  const s = fontFace.style
  const weight =
    (typeof w === 'string' || typeof w === 'number') && !_isInvalidFaceWeight(String(w)) ? String(w) : 'auto'
  const style = typeof s === 'string' && !_isInvalidFaceStyle(s) ? s : 'auto'
  const faces = _faceCount(family)
  const key = GlobalFonts.registerFromPath(path, family, { weight, style })
  if (!key) {
    throw new Error(`Failed to register font from "${path}" with family "${family}"`)
  }
  // A call that adds no face got the key of a registration that already
  // existed (the same path, family and descriptors). deregisterAllFonts must
  // leave that one to its owner, as node-canvas removes only what
  // registerFont added.
  if (_faceCount(family) > faces) _registeredFontKeys.push(key)
}

function _faceCount(family) {
  const entry = GlobalFonts.families.find((f) => f.family === family)
  return entry ? entry.styles.length : 0
}

/**
 * Deregister all fonts previously registered via registerFont().
 * Compatible with node-canvas's deregisterAllFonts() which only removes
 * user-registered fonts and leaves system fonts untouched.
 */
function deregisterAllFonts() {
  if (_registeredFontKeys.length > 0) {
    GlobalFonts.removeBatch(_registeredFontKeys)
    _registeredFontKeys.length = 0
  }
}

// ---------------------------------------------------------------------------
// Public API: createCanvas / createImageData
// ---------------------------------------------------------------------------

/**
 * Create a new canvas instance with node-canvas compatible API.
 *
 * @param {number} width
 * @param {number} height
 * @param {'image'|'svg'} [type='image']
 * @returns {Canvas}
 */
function createCanvas(width, height, type) {
  if (type === 'svg') {
    // SvgExportFlag enum requires a valid variant; NoPrettyXML (0x02) is the
    // least impactful on rendering behavior (only affects XML whitespace).
    return _createCanvas(width, height, SvgExportFlag.NoPrettyXML)
  }
  if (type === 'pdf') {
    throw new Error(
      'createCanvas with type "pdf" is not supported. Use the PDFDocument class from @napi-rs/canvas directly.',
    )
  }
  if (type != null && type !== 'image') {
    throw new TypeError(`createCanvas: unknown type "${type}". Supported types: "image", "svg".`)
  }
  return _addCompatMethods(_createCanvas(width, height))
}

/**
 * Create an ImageData instance.
 * Compatible with node-canvas's createImageData().
 *
 * @param {Uint8ClampedArray|number} dataOrWidth
 * @param {number} widthOrHeight
 * @param {number} [height]
 * @returns {ImageData}
 */
function createImageData(dataOrWidth, widthOrHeight, height) {
  if (typeof dataOrWidth === 'number') {
    return new ImageData(dataOrWidth, widthOrHeight)
  }
  if (height != null) {
    return new ImageData(dataOrWidth, widthOrHeight, height)
  }
  return new ImageData(dataOrWidth, widthOrHeight)
}

// ---------------------------------------------------------------------------
// Canvas constructor wrapper
// ---------------------------------------------------------------------------

// In node-canvas, `new Canvas(w, h)` and `createCanvas(w, h)` produce
// equivalent canvases. Wrap the native Canvas constructor so that
// `new Canvas(w, h)` also gets compat methods, without polluting the
// prototype (which would affect @napi-rs/canvas users who don't use
// this compat layer).
const CompatCanvas = new Proxy(Canvas, {
  construct(target, args) {
    const canvas = new target(...args)
    if (canvas instanceof CanvasElement) {
      return _addCompatMethods(canvas)
    }
    return canvas
  },
})

// ---------------------------------------------------------------------------
// Exports (matches node-canvas export shape)
// ---------------------------------------------------------------------------

module.exports = {
  // Factory functions
  Canvas: CompatCanvas,
  createCanvas,
  createImageData,
  loadImage,
  registerFont,
  deregisterAllFonts,

  // Classes
  Image,
  ImageData,
  CanvasRenderingContext2D,
  Context2d: CanvasRenderingContext2D,
  PNGStream,
  JPEGStream,
  Path2D,

  // Geometry
  DOMPoint,
  DOMMatrix,
  DOMRect,

  // @napi-rs/canvas extras (available but not part of node-canvas)
  GlobalFonts,
  PDFDocument,
  CanvasElement,
  SVGCanvas,
}
