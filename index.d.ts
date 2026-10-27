import { ReadableStream } from 'node:stream/web'

// Clear all type of caches in Skia
export function clearAllCache(): void

export type TextRenderer = 'portable' | 'system'

/**
 * Selects how text is drawn.
 *
 * `'portable'` (the default) draws text the same way on every OS: FreeType,
 * Skia's default text gamma, no LCD text and one font family table. The same
 * registered fonts give the same pixels and TextMetrics on macOS, Linux and
 * Windows.
 *
 * `'system'` draws text with each OS's own font renderer, as Chrome does:
 * CoreText on macOS (Fontations for some color and variable fonts) with
 * CoreText's installed fonts and fallback, Fontations on Linux, FreeType
 * elsewhere; plus each OS's text gamma and contrast, LCD text on opaque macOS
 * canvases, Chrome's per-OS font family settings and macOS metric rules.
 *
 * Applies to the whole process, worker threads included. Call it once at
 * startup, before creating canvases. Setting the mode in use again changes
 * nothing. Any other value throws a TypeError. Registered fonts keep their
 * FontKey. A canvas created before the switch keeps its text gamma until its
 * width or height is set. A `ctx.font` value set before the switch keeps its
 * parsed form: sizes in `ex`/`ch`/... units and, on macOS, the
 * BlinkMacSystemFont to system-ui rewrite. Set `ctx.font` again after the
 * switch.
 */
export function setTextRenderer(renderer: TextRenderer): void

/** The text renderer in use, set by {@link setTextRenderer}. */
export function getTextRenderer(): TextRenderer

interface CanvasRenderingContext2D
  extends CanvasCompositing,
  CanvasDrawPath,
  CanvasFillStrokeStyles,
  CanvasFilters,
  CanvasImageData,
  CanvasImageSmoothing,
  CanvasPath,
  CanvasPathDrawingStyles,
  CanvasRect,
  CanvasSettings,
  CanvasShadowStyles,
  CanvasState,
  CanvasText,
  CanvasTextDrawingStyles,
  CanvasTransform,
  CanvasPDFAnnotations { }

interface CanvasState {
  isContextLost(): boolean
  reset(): void
  restore(): void
  save(): void
}
interface CanvasShadowStyles {
  shadowBlur: number
  shadowColor: string
  shadowOffsetX: number
  shadowOffsetY: number
}
type CanvasPixelFormat = 'float16' | 'unorm8'
interface CanvasToneMapping {
  mode?: 'extended' | 'standard'
}
interface CanvasRenderingContext2DSettings {
  alpha?: boolean
  colorSpace?: PredefinedColorSpace
  /** 'float16' stores half floats, as Chrome does; `canvas.data()` then gives them premultiplied, 8 bytes a pixel. */
  colorType?: CanvasPixelFormat
  desynchronized?: boolean
  /** Not read by getContext() (as in Chrome); getContextAttributes() reports `{ mode: 'standard' }`. */
  toneMapping?: CanvasToneMapping
  willReadFrequently?: boolean
}
interface CanvasSettings {
  getContextAttributes(): Required<CanvasRenderingContext2DSettings>
}

interface CanvasRect {
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
}

interface TextMetrics {
  readonly actualBoundingBoxAscent: number
  readonly actualBoundingBoxDescent: number
  readonly actualBoundingBoxLeft: number
  readonly actualBoundingBoxRight: number
  readonly alphabeticBaseline: number
  readonly emHeightAscent: number
  readonly emHeightDescent: number
  readonly fontBoundingBoxAscent: number
  readonly fontBoundingBoxDescent: number
  readonly hangingBaseline: number
  readonly ideographicBaseline: number
  readonly width: number
}

interface CanvasText {
  fillText(text: string, x: number, y: number, maxWidth?: number): void
  measureText(text: string): TextMetrics
  strokeText(text: string, x: number, y: number, maxWidth?: number): void
}

type CanvasLineCap = 'butt' | 'round' | 'square'
type CanvasLineJoin = 'bevel' | 'miter' | 'round'

interface CanvasPathDrawingStyles {
  lineCap: CanvasLineCap
  lineDashOffset: number
  lineJoin: CanvasLineJoin
  lineWidth: number
  miterLimit: number
  getLineDash(): number[]
  setLineDash(segments: number[]): void
}

interface CanvasPath {
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void
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
    counterclockwise?: boolean,
  ): void
  lineTo(x: number, y: number): void
  moveTo(x: number, y: number): void
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void
  rect(x: number, y: number, w: number, h: number): void
  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii?: number | DOMPointInit | Iterable<number | DOMPointInit>,
  ): void
}

type ImageSmoothingQuality = 'high' | 'low' | 'medium'

interface CanvasImageSmoothing {
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: ImageSmoothingQuality
}

interface CanvasTransform {
  resetTransform(): void
  rotate(angle: number): void
  scale(x: number, y: number): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  /** Missing members default to the identity; `a` and `m11` (and so on) must agree when both are given. */
  setTransform(
    transform?: Partial<DOMMatrixInit> & {
      m11?: number
      m12?: number
      m21?: number
      m22?: number
      m41?: number
      m42?: number
    },
  ): void
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void
  translate(x: number, y: number): void
}

interface CanvasPDFAnnotations {
  /**
   * Create a clickable URL link annotation in a PDF document.
   * This is only effective when used with PDF documents.
   * @param left - Left coordinate of the link rectangle
   * @param top - Top coordinate of the link rectangle
   * @param right - Right coordinate of the link rectangle
   * @param bottom - Bottom coordinate of the link rectangle
   * @param url - The URL to link to
   */
  annotateLinkUrl(left: number, top: number, right: number, bottom: number, url: string): void

  /**
   * Create a named destination at a specific point in a PDF document.
   * This destination can be used as a target for internal links.
   * @param x - X coordinate of the destination point
   * @param y - Y coordinate of the destination point
   * @param name - Name identifier for the destination
   */
  annotateNamedDestination(x: number, y: number, name: string): void

  /**
   * Create a link to a named destination within the PDF document.
   * This is only effective when used with PDF documents.
   * @param left - Left coordinate of the link rectangle
   * @param top - Top coordinate of the link rectangle
   * @param right - Right coordinate of the link rectangle
   * @param bottom - Bottom coordinate of the link rectangle
   * @param name - Name of the destination to link to
   */
  annotateLinkToDestination(left: number, top: number, right: number, bottom: number, name: string): void
}

type PredefinedColorSpace = 'display-p3' | 'srgb'
/** 'rgba-float16' throws a NotSupportedError on a runtime without Float16Array (Node 22). */
type ImageDataPixelFormat = 'rgba-unorm8' | 'rgba-float16' | 'rgba-float32'
/** Float16Array, where the TypeScript lib has it. */
type ImageDataFloat16Array = typeof globalThis extends { Float16Array: { prototype: infer T } } ? T : never
type ImageDataArray = Uint8ClampedArray | ImageDataFloat16Array | Float32Array

interface ImageDataSettings {
  colorSpace?: PredefinedColorSpace
  pixelFormat?: ImageDataPixelFormat
}
interface CanvasImageData {
  createImageData(sw: number, sh: number, settings?: ImageDataSettings & { pixelFormat?: 'rgba-unorm8' }): ImageData
  createImageData(
    sw: number,
    sh: number,
    settings: ImageDataSettings & { pixelFormat: 'rgba-float16' },
  ): ImageData<ImageDataFloat16Array>
  createImageData(
    sw: number,
    sh: number,
    settings: ImageDataSettings & { pixelFormat: 'rgba-float32' },
  ): ImageData<Float32Array>
  createImageData(sw: number, sh: number, settings?: ImageDataSettings): ImageData<ImageDataArray>
  createImageData<T extends ImageDataArray>(imagedata: ImageData<T>): ImageData<T>
  getImageData(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    settings?: ImageDataSettings & { pixelFormat?: 'rgba-unorm8' },
  ): ImageData
  getImageData(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    settings: ImageDataSettings & { pixelFormat: 'rgba-float16' },
  ): ImageData<ImageDataFloat16Array>
  getImageData(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    settings: ImageDataSettings & { pixelFormat: 'rgba-float32' },
  ): ImageData<Float32Array>
  getImageData(sx: number, sy: number, sw: number, sh: number, settings?: ImageDataSettings): ImageData<ImageDataArray>
  putImageData(imagedata: ImageData<ImageDataArray>, dx: number, dy: number): void
  putImageData(
    imagedata: ImageData<ImageDataArray>,
    dx: number,
    dy: number,
    dirtyX: number,
    dirtyY: number,
    dirtyWidth: number,
    dirtyHeight: number,
  ): void
}

type CanvasDirection = 'inherit' | 'ltr' | 'rtl'
type CanvasFontKerning = 'auto' | 'none' | 'normal'
type CanvasFontStretch =
  | 'condensed'
  | 'expanded'
  | 'extra-condensed'
  | 'extra-expanded'
  | 'normal'
  | 'semi-condensed'
  | 'semi-expanded'
  | 'ultra-condensed'
  | 'ultra-expanded'
type CanvasFontVariantCaps =
  | 'all-petite-caps'
  | 'all-small-caps'
  | 'normal'
  | 'petite-caps'
  | 'small-caps'
  | 'titling-caps'
  | 'unicase'
type CanvasTextAlign = 'center' | 'end' | 'left' | 'right' | 'start'
type CanvasTextBaseline = 'alphabetic' | 'bottom' | 'hanging' | 'ideographic' | 'middle' | 'top'
type CanvasTextRendering = 'auto' | 'geometricPrecision' | 'optimizeLegibility' | 'optimizeSpeed'

interface CanvasTextDrawingStyles {
  direction: CanvasDirection
  font: string
  fontKerning: CanvasFontKerning
  fontStretch: CanvasFontStretch
  fontVariantCaps: CanvasFontVariantCaps
  letterSpacing: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  textRendering: CanvasTextRendering
  wordSpacing: string
  fontVariationSettings: string
  lang: string
}

interface CanvasFilters {
  filter: string
}

interface CanvasFillStrokeStyles {
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  createConicGradient(startAngle: number, x: number, y: number): CanvasGradient
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient
}

type CanvasFillRule = 'evenodd' | 'nonzero'

interface CanvasDrawPath {
  beginPath(): void
  clip(fillRule?: CanvasFillRule): void
  clip(path: Path2D, fillRule?: CanvasFillRule): void
  fill(fillRule?: CanvasFillRule): void
  fill(path: Path2D, fillRule?: CanvasFillRule): void
  isPointInPath(x: number, y: number, fillRule?: CanvasFillRule): boolean
  isPointInPath(path: Path2D, x: number, y: number, fillRule?: CanvasFillRule): boolean
  isPointInStroke(x: number, y: number): boolean
  isPointInStroke(path: Path2D, x: number, y: number): boolean
  stroke(): void
  stroke(path: Path2D): void
}

type GlobalCompositeOperation =
  | 'color'
  | 'color-burn'
  | 'color-dodge'
  | 'copy'
  | 'darken'
  | 'destination-atop'
  | 'destination-in'
  | 'destination-out'
  | 'destination-over'
  | 'difference'
  | 'exclusion'
  | 'hard-light'
  | 'hue'
  | 'lighten'
  | 'lighter'
  | 'luminosity'
  | 'multiply'
  | 'overlay'
  | 'saturation'
  | 'screen'
  | 'soft-light'
  | 'source-atop'
  | 'source-in'
  | 'source-out'
  | 'source-over'
  | 'xor'

interface CanvasCompositing {
  globalAlpha: number
  globalCompositeOperation: GlobalCompositeOperation
}

interface DOMPointInit {
  w?: number
  x?: number
  y?: number
  z?: number
}
interface CanvasPattern {
  /** Missing members default to the identity; `a` and `m11` (and so on) must agree when both are given. */
  setTransform(
    transform?: Partial<DOMMatrix2DInit> & {
      m11?: number
      m12?: number
      m21?: number
      m22?: number
      m41?: number
      m42?: number
    },
  ): void
}

interface CanvasGradient {
  addColorStop(offset: number, color: string): void
}

interface DOMRectInit {
  height?: number
  width?: number
  x?: number
  y?: number
}

interface DOMMatrixInit extends DOMMatrix2DInit {
  is2D?: boolean
  m13?: number
  m14?: number
  m23?: number
  m24?: number
  m31?: number
  m32?: number
  m33?: number
  m34?: number
  m43?: number
  m44?: number
}

// ----------- added types

export interface DOMMatrix2DInit {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

interface DOMMatrixReadOnly {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
  readonly e: number
  readonly f: number
  readonly is2D: boolean
  readonly isIdentity: boolean
  readonly m11: number
  readonly m12: number
  readonly m13: number
  readonly m14: number
  readonly m21: number
  readonly m22: number
  readonly m23: number
  readonly m24: number
  readonly m31: number
  readonly m32: number
  readonly m33: number
  readonly m34: number
  readonly m41: number
  readonly m42: number
  readonly m43: number
  readonly m44: number
  flipX(): DOMMatrix
  flipY(): DOMMatrix
  inverse(): DOMMatrix
  multiply(other?: DOMMatrixInit): DOMMatrix
  rotate(rotX?: number, rotY?: number, rotZ?: number): DOMMatrix
  rotateAxisAngle(x?: number, y?: number, z?: number, angle?: number): DOMMatrix
  rotateFromVector(x?: number, y?: number): DOMMatrix
  scale(
    scaleX?: number,
    scaleY?: number,
    scaleZ?: number,
    originX?: number,
    originY?: number,
    originZ?: number,
  ): DOMMatrix
  scale3d(scale?: number, originX?: number, originY?: number, originZ?: number): DOMMatrix
  skewX(sx?: number): DOMMatrix
  skewY(sy?: number): DOMMatrix
  toFloat32Array(): Float32Array
  toFloat64Array(): Float64Array
  transformPoint(point?: DOMPointInit): DOMPoint
  translate(tx?: number, ty?: number, tz?: number): DOMMatrix
  toString(): string
}

export interface DOMMatrix extends DOMMatrixReadOnly {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
  m11: number
  m12: number
  m13: number
  m14: number
  m21: number
  m22: number
  m23: number
  m24: number
  m31: number
  m32: number
  m33: number
  m34: number
  m41: number
  m42: number
  m43: number
  m44: number
  invertSelf(): DOMMatrix
  multiplySelf(other?: DOMMatrixInit): DOMMatrix
  preMultiplySelf(other?: DOMMatrixInit): DOMMatrix
  rotateAxisAngleSelf(x?: number, y?: number, z?: number, angle?: number): DOMMatrix
  rotateFromVectorSelf(x?: number, y?: number): DOMMatrix
  rotateSelf(rotX?: number, rotY?: number, rotZ?: number): DOMMatrix
  scale3dSelf(scale?: number, originX?: number, originY?: number, originZ?: number): DOMMatrix
  scaleSelf(
    scaleX?: number,
    scaleY?: number,
    scaleZ?: number,
    originX?: number,
    originY?: number,
    originZ?: number,
  ): DOMMatrix
  setMatrixValue(transformList: string): DOMMatrix
  skewXSelf(sx?: number): DOMMatrix
  skewYSelf(sy?: number): DOMMatrix
  translateSelf(tx?: number, ty?: number, tz?: number): DOMMatrix
  toJSON(): { [K in OmitNeverOfMatrix]: DOMMatrix[K] }
}

type OmitMatrixMethod = { [K in keyof DOMMatrix]: DOMMatrix[K] extends (...args: any[]) => any ? never : K }

type OmitNeverOfMatrix = OmitMatrixMethod[keyof OmitMatrixMethod]

export const DOMMatrix: {
  prototype: DOMMatrix
  new(init?: string | number[]): DOMMatrix
  fromFloat32Array(array32: Float32Array): DOMMatrix
  fromFloat64Array(array64: Float64Array): DOMMatrix
  fromMatrix(other?: DOMMatrixInit): DOMMatrix
}

interface DOMRectReadOnly {
  readonly bottom: number
  readonly height: number
  readonly left: number
  readonly right: number
  readonly top: number
  readonly width: number
  readonly x: number
  readonly y: number
}

export interface DOMRect extends DOMRectReadOnly {
  height: number
  width: number
  x: number
  y: number
  toJSON(): Omit<this, 'toJSON' | 'fromRect'>
}

export const DOMRect: {
  prototype: DOMRect
  new(x?: number, y?: number, width?: number, height?: number): DOMRect
  fromRect(other?: DOMRectInit): DOMRect
}

interface DOMPointReadOnly {
  readonly w: number
  readonly x: number
  readonly y: number
  readonly z: number
  matrixTransform(matrix?: DOMMatrixInit): DOMPoint
}

export interface DOMPoint extends DOMPointReadOnly {
  w: number
  x: number
  y: number
  z: number
  toJSON(): Omit<DOMPoint, 'matrixTransform' | 'toJSON'>
}

export const DOMPoint: {
  prototype: DOMPoint
  new(x?: number, y?: number, z?: number, w?: number): DOMPoint
  fromPoint(other?: DOMPointInit): DOMPoint
}

export class ImageData<T extends ImageDataArray = Uint8ClampedArray> {
  /**
   * Returns the one-dimensional array containing the data in RGBA order: integers in the range 0 to 255 for
   * 'rgba-unorm8', unpremultiplied floats for 'rgba-float16' and 'rgba-float32'.
   */
  readonly data: T
  /**
   * Returns the actual dimensions of the data in the ImageData object, in pixels.
   */
  readonly height: number
  /**
   * Returns the actual dimensions of the data in the ImageData object, in pixels.
   */
  readonly width: number
  readonly colorSpace: PredefinedColorSpace
  readonly pixelFormat: ImageDataPixelFormat

  /** Pass the data type for a float pixelFormat: `new ImageData<Float32Array>(w, h, { pixelFormat: 'rgba-float32' })`. */
  constructor(sw: number, sh: number, settings?: ImageDataSettings)
  /** The pixelFormat must match the data type. */
  constructor(data: T, sw: number, sh?: number, settings?: ImageDataSettings)
}

export class Image {
  constructor()
  // attrs only affects SVG
  constructor(width: number, height: number, attrs?: { colorSpace?: ColorSpace })
  width: number
  height: number
  readonly naturalWidth: number
  readonly naturalHeight: number
  readonly complete: boolean
  readonly currentSrc: string | null
  alt: string
  // the src can be a Uint8Array or a string
  // if it's a string, it can be a file path, a data URL, a remote URL, or a SVG string
  src: Uint8Array | string
  onload?(): void
  /** Called with an Event of type 'error', as in browsers. */
  onerror?(event: Event): void
  /** Rejects with an EncodingError DOMException when the image cannot be decoded. */
  decode(): Promise<void>
}

export class Path2D {
  constructor(path?: Path2D | string)

  /** Missing members default to the identity; `a` and `m11` (and so on) must agree when both are given. */
  addPath(
    path: Path2D,
    transform?: Partial<DOMMatrix2DInit> & {
      m11?: number
      m12?: number
      m21?: number
      m22?: number
      m41?: number
      m42?: number
    },
  ): void
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
  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii?: number | DOMPointInit | Iterable<number | DOMPointInit>,
  ): void

  // PathKit methods
  op(path: Path2D, operation: PathOp): Path2D
  toSVGString(): string
  getFillType(): FillType
  getFillTypeString(): string
  setFillType(type: FillType): void
  simplify(): Path2D
  asWinding(): Path2D
  stroke(stroke?: StrokeOptions): Path2D
  transform(transform: DOMMatrix2DInit): Path2D
  getBounds(): [left: number, top: number, right: number, bottom: number]
  computeTightBounds(): [left: number, top: number, right: number, bottom: number]
  trim(start: number, end: number, isComplement?: boolean): Path2D
  dash(on: number, off: number, phase: number): Path2D
  round(radius: number): Path2D
  equals(path: Path2D): boolean
}

export interface StrokeOptions {
  width?: number
  miterLimit?: number
  cap?: StrokeCap
  join?: StrokeJoin
}

export interface SKRSContext2D extends CanvasRenderingContext2D {
  readonly canvas: Canvas
  /**
   * @param startAngle The angle at which to begin the gradient, in radians. Angle measurements start vertically above the centre and move around clockwise.
   * @param x The x-axis coordinate of the centre of the gradient.
   * @param y The y-axis coordinate of the centre of the gradient.
   */
  createConicGradient(startAngle: number, x: number, y: number): CanvasGradient
  drawImage(image: Image | Canvas | SvgCanvas, dx: number, dy: number): void
  drawImage(image: Image | Canvas | SvgCanvas, dx: number, dy: number, dw: number, dh: number): void
  drawImage(
    image: Image | Canvas | SvgCanvas,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void
  /**
   * Draw another canvas, preserving vector graphics when possible.
   * When the source canvas has recorded operations, this method preserves the
   * SkPicture representation without rasterization, which can be faster than
   * drawImage. Falls back to bitmap rendering if no picture is available.
   */
  drawCanvas(canvas: Canvas, dx: number, dy: number): void
  drawCanvas(canvas: Canvas, dx: number, dy: number, dWidth: number, dHeight: number): void
  drawCanvas(
    canvas: Canvas,
    sx: number,
    sy: number,
    sWidth: number,
    sHeight: number,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number,
  ): void
  /** null when `image` is an Image with no src or one that is still loading. */
  createPattern(
    image: Image | ImageData<ImageDataArray> | Canvas | SvgCanvas,
    repeat: 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat' | '' | null,
  ): CanvasPattern | null
  getContextAttributes(): Required<CanvasRenderingContext2DSettings>
  getTransform(): DOMMatrix

  letterSpacing: string
  wordSpacing: string
}

export type ColorSpace = 'srgb' | 'display-p3'

export interface ContextAttributes extends CanvasRenderingContext2DSettings {}

export interface SvgCanvas {
  width: number
  height: number
  /**
   * Returns null for an id other than '2d', as browsers do for an unsupported id.
   * Declared before the '2d' overload, so `ReturnType` still gives the context.
   */
  getContext<T extends string>(
    contextType: T extends '2d' ? never : T,
    contextAttributes?: ContextAttributes,
  ): SKRSContext2D | null
  getContext(contextType: '2d', contextAttributes?: ContextAttributes): SKRSContext2D

  getContent(): Buffer
}

export interface AvifConfig {
  /**
   * 0-100 scale, 100 is the best quality. 100 with 4:4:4 (the default) is
   * lossless: R, G and B are coded as they are (CICP matrix 0, identity).
   * Below 100, or with chroma subsampling, the pixels are lossy BT.601 YUV.
   * Default 80.
   */
  quality?: number
  /** 0-100 scale. Default 100 when `quality` is 100 (lossless alpha), else 90. */
  alphaQuality?: number
  /**
   * aom encoder speed from 0 (slowest, smallest file) to 10 (fastest);
   * larger values are 10. Default 5.
   */
  speed?: number
  /** How many threads to use: 0 or unset is one per CPU core; at most 64. */
  threads?: number
  /** set to '4:2:0' to use chroma subsampling, default '4:4:4' */
  chromaSubsampling?: ChromaSubsampling
}

/**
 * Metadata that `toBuffer`, `encode` and `encodeSync` write into PNG and JPEG
 * output. It goes in the same options object as the other options. WebP, AVIF
 * and GIF output ignore it. `toDataURL`, `toDataURLAsync`, `toBlob`,
 * `convertToBlob`, `encodeStream` and `savePng` never write it.
 *
 * Nothing is converted, as in node-canvas: a member counts only when it is a
 * number (`resolution`) or a string (the text members). Any other value is
 * ignored. U+0000 is removed from text, and text that is then empty writes
 * nothing. In JPEG, the XMP text must fit in one 64 KB segment (about 65000
 * bytes of UTF-8 in all) and `comment` in 65533 UTF-8 bytes; more is a
 * RangeError. PNG text has no such limit.
 */
export interface ImageMetadata {
  /**
   * Pixels per inch for both axes, as node-canvas's `PngConfig.resolution`.
   * The fraction is dropped (300.9 is 300). A value below 1, NaN and the
   * infinities write nothing.
   * - PNG: a `pHYs` chunk of `Math.round(ppi * 39.3701)` pixels per metre (the
   *   bytes node-canvas writes), at most 2147483647.
   * - JPEG: the JFIF density in dots per inch, at most 65535.
   */
  resolution?: number
  /** PNG `Title` text chunk; JPEG XMP `dc:title`. */
  title?: string
  /** PNG `Author` text chunk; JPEG XMP `dc:creator`. */
  author?: string
  /** PNG `Description` text chunk; JPEG XMP `dc:description`. */
  description?: string
  /** PNG `Copyright` text chunk; JPEG XMP `dc:rights`. */
  copyright?: string
  /** PNG `Software` text chunk; JPEG XMP `xmp:CreatorTool`. */
  software?: string
  /** PNG `Comment` text chunk; JPEG `COM` segment. */
  comment?: string
}

/** The object form of `encode('jpeg')` and `encodeSync('jpeg')`: a quality and metadata. */
export interface JpegEncodeOptions extends ImageMetadata {
  /** 0-100; a larger value is 100. Default 92. */
  quality?: number
}

/** GIF encoding configuration for single-frame encoding */
export interface GifConfig {
  /**
   * Quality for NeuQuant color quantization (1-30, lower = slower but better quality)
   * @default 10
   */
  quality?: number
}

/** Configuration for the GIF encoder (animated GIFs) */
export interface GifEncoderConfig {
  /**
   * Loop count: 0 = infinite loop, positive number = finite loops
   * @default 0 (infinite)
   */
  repeat?: number
  /**
   * Quality for NeuQuant color quantization (1-30, lower = slower but better quality)
   * @default 10
   */
  quality?: number
}

/** Configuration for individual GIF frames */
export interface GifFrameConfig {
  /**
   * Frame delay in milliseconds
   * @default 100
   */
  delay?: number
  /** Disposal method for this frame */
  disposal?: GifDisposal
  /** Transparent color index (0-255), if the frame has transparency */
  transparent?: number
  /** X offset of this frame within the canvas */
  left?: number
  /** Y offset of this frame within the canvas */
  top?: number
}

/** GIF frame disposal method */
export enum GifDisposal {
  /** Keep the frame visible (default) */
  Keep = 0,
  /** Clear the frame area to the background color */
  Background = 1,
  /** Restore to the previous frame */
  Previous = 2,
}

/**
 * GIF Encoder for creating animated GIFs.
 * Implements `Disposable` interface for use with the `using` keyword (ES2024).
 *
 * @example
 * ```typescript
 * // Basic usage
 * const encoder = new GifEncoder(100, 100, { repeat: 0, quality: 10 });
 * encoder.addFrame(rgbaData, 100, 100, { delay: 100 });
 * encoder.addFrame(rgbaData2, 100, 100, { delay: 100 });
 * const buffer = encoder.finish();
 *
 * // With `using` keyword (automatic cleanup)
 * {
 *   using encoder = new GifEncoder(100, 100);
 *   encoder.addFrame(frame1, 100, 100, { delay: 100 });
 *   const buffer = encoder.finish();
 * } // encoder automatically disposed
 * ```
 */
export class GifEncoder implements Disposable {
  /**
   * Create a new GIF encoder with the specified dimensions
   * @param width - Width of the GIF canvas in pixels
   * @param height - Height of the GIF canvas in pixels
   * @param config - Optional encoder configuration
   */
  constructor(width: number, height: number, config?: GifEncoderConfig)

  /** Width of the GIF canvas */
  readonly width: number
  /** Height of the GIF canvas */
  readonly height: number
  /** Number of frames added so far */
  readonly frameCount: number

  /**
   * Add a frame from RGBA pixel data
   * @param data - RGBA pixel data (must be width * height * 4 bytes)
   * @param width - Width of the frame in pixels
   * @param height - Height of the frame in pixels
   * @param config - Optional frame configuration
   */
  addFrame(data: Uint8Array, width: number, height: number, config?: GifFrameConfig): void

  /**
   * Finish encoding and return the GIF data.
   * Clears all accumulated frames after encoding.
   * @throws Error if no frames have been added
   */
  finish(): Buffer

  /**
   * Dispose of the encoder, clearing all accumulated frames without encoding.
   * Called automatically when using the `using` keyword.
   */
  dispose(): void

  /**
   * Symbol.dispose implementation for ES2024 Explicit Resource Management.
   * Allows using `using encoder = new GifEncoder(...)` syntax.
   */
  [Symbol.dispose](): void
}
/**
 * https://en.wikipedia.org/wiki/Chroma_subsampling#Types_of_sampling_and_subsampling
 * https://developer.mozilla.org/en-US/docs/Web/Media/Formats/Video_concepts
 */
export enum ChromaSubsampling {
  /**
   * Each of the three Y'CbCr components has the same sample rate, thus there is no chroma subsampling. This scheme is sometimes used in high-end film scanners and cinematic post-production.
   * Note that "4:4:4" may instead be wrongly referring to R'G'B' color space, which implicitly also does not have any chroma subsampling (except in JPEG R'G'B' can be subsampled).
   * Formats such as HDCAM SR can record 4:4:4 R'G'B' over dual-link HD-SDI.
   */
  Yuv444 = 0,
  /**
   * The two chroma components are sampled at half the horizontal sample rate of luma: the horizontal chroma resolution is halved. This reduces the bandwidth of an uncompressed video signal by one-third.
   * Many high-end digital video formats and interfaces use this scheme:
   * - [AVC-Intra 100](https://en.wikipedia.org/wiki/AVC-Intra)
   * - [Digital Betacam](https://en.wikipedia.org/wiki/Betacam#Digital_Betacam)
   * - [Betacam SX](https://en.wikipedia.org/wiki/Betacam#Betacam_SX)
   * - [DVCPRO50](https://en.wikipedia.org/wiki/DV#DVCPRO) and [DVCPRO HD](https://en.wikipedia.org/wiki/DV#DVCPRO_HD)
   * - [Digital-S](https://en.wikipedia.org/wiki/Digital-S)
   * - [CCIR 601](https://en.wikipedia.org/wiki/Rec._601) / [Serial Digital Interface](https://en.wikipedia.org/wiki/Serial_digital_interface) / [D1](https://en.wikipedia.org/wiki/D-1_(Sony))
   * - [ProRes (HQ, 422, LT, and Proxy)](https://en.wikipedia.org/wiki/Apple_ProRes)
   * - [XDCAM HD422](https://en.wikipedia.org/wiki/XDCAM)
   * - [Canon MXF HD422](https://en.wikipedia.org/wiki/Canon_XF-300)
   */
  Yuv422 = 1,
  /**
   * n 4:2:0, the horizontal sampling is doubled compared to 4:1:1,
   * but as the **Cb** and **Cr** channels are only sampled on each alternate line in this scheme, the vertical resolution is halved.
   * The data rate is thus the same.
   * This fits reasonably well with the PAL color encoding system, since this has only half the vertical chrominance resolution of [NTSC](https://en.wikipedia.org/wiki/NTSC).
   * It would also fit extremely well with the [SECAM](https://en.wikipedia.org/wiki/SECAM) color encoding system,
   * since like that format, 4:2:0 only stores and transmits one color channel per line (the other channel being recovered from the previous line).
   * However, little equipment has actually been produced that outputs a SECAM analogue video signal.
   * In general, SECAM territories either have to use a PAL-capable display or a [transcoder](https://en.wikipedia.org/wiki/Transcoding) to convert the PAL signal to SECAM for display.
   */
  Yuv420 = 2,
  /**
   * What if the chroma subsampling model is 4:0:0?
   * That says to use every pixel of luma data, but that each row has 0 chroma samples applied to it. The resulting image, then, is comprised solely of the luminance data—a greyscale image.
   */
  Yuv400 = 3,
}

/** OffscreenCanvas ImageEncodeOptions. */
export interface ConvertToBlobOptions {
  /** Default 'image/png'; ASCII case-insensitive, and an unknown type is PNG. */
  type?: string
  /** 0 to 1 for JPEG, WebP (1 is lossless), AVIF and GIF. Default 1. */
  quality?: number
}

export class Canvas {
  /**
   * A missing width or height is the default, 300 x 150, as is NaN, an infinity
   * or a non-zero number that converts to 0 (such as 0.5). 0 stays 0.
   */
  constructor(width?: number, height?: number, flag?: SvgExportFlag)

  width: number
  height: number
  /**
   * Returns null for an id other than '2d', as browsers do for an unsupported id.
   * Declared before the '2d' overload, so `ReturnType` still gives the context.
   */
  getContext<T extends string>(
    contextType: T extends '2d' ? never : T,
    contextAttributes?: ContextAttributes,
  ): SKRSContext2D | null
  getContext(contextType: '2d', contextAttributes?: ContextAttributes): SKRSContext2D
  encodeSync(format: 'webp' | 'jpeg', quality?: number): Buffer
  encodeSync(format: 'jpeg', options: JpegEncodeOptions): Buffer
  encodeSync(format: 'png', options?: ImageMetadata): Buffer
  encodeSync(format: 'avif', cfg?: AvifConfig | number): Buffer
  encodeSync(format: 'gif', quality?: number): Buffer
  encode(format: 'webp' | 'jpeg', quality?: number): Promise<Buffer>
  encode(format: 'jpeg', options: JpegEncodeOptions): Promise<Buffer>
  encode(format: 'png', options?: ImageMetadata): Promise<Buffer>
  encode(format: 'avif', cfg?: AvifConfig | number): Promise<Buffer>
  encode(format: 'gif', quality?: number): Promise<Buffer>
  /** Writes no image metadata; use `encode` and stream the Buffer for that. */
  encodeStream(format: 'webp' | 'jpeg', quality?: number): ReadableStream<Buffer>
  encodeStream(format: 'png'): ReadableStream<Buffer>
  toBuffer(mime: 'image/png', options?: ImageMetadata): Buffer
  toBuffer(mime: 'image/jpeg' | 'image/webp', quality?: number): Buffer
  /**
   * JPEG with metadata, at quality 92: toBuffer does not read a quality from an
   * object. To set both, use `encodeSync('jpeg', { quality, ...metadata })`.
   */
  toBuffer(mime: 'image/jpeg', options: ImageMetadata): Buffer
  toBuffer(mime: 'image/avif', cfg?: AvifConfig | number): Buffer
  toBuffer(mime: 'image/gif', quality?: number): Buffer
  /** The stored pixels, premultiplied: RGBA bytes, or RGBA half floats (8 bytes a pixel) for colorType 'float16'. */
  data(): Buffer
  toDataURL(mime?: 'image/png'): string
  toDataURL(mime: 'image/jpeg' | 'image/webp', quality?: number): string
  toDataURL(mime: 'image/gif', quality?: number): string
  toDataURL(mime?: 'image/jpeg' | 'image/webp' | 'image/png' | 'image/gif', quality?: number): string
  toDataURL(mime?: 'image/avif', cfg?: AvifConfig | number): string
  /**
   * As in browsers: the type is ASCII case-insensitive and an unknown one is
   * PNG; the quality counts when it is a number from 0 to 1.
   */
  toDataURL(type?: string, quality?: any): string

  toDataURLAsync(mime?: 'image/png'): Promise<string>
  toDataURLAsync(mime: 'image/jpeg' | 'image/webp', quality?: number): Promise<string>
  toDataURLAsync(mime: 'image/gif', quality?: number): Promise<string>
  toDataURLAsync(mime?: 'image/jpeg' | 'image/webp' | 'image/png' | 'image/gif', quality?: number): Promise<string>
  toDataURLAsync(mime?: 'image/avif', cfg?: AvifConfig | number): Promise<string>
  toDataURLAsync(type?: string, quality?: any): Promise<string>

  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: any): void
  convertToBlob(options?: ConvertToBlobOptions): Promise<Blob>
}

/**
 * A missing width or height is the default, 300 x 150, as is NaN, an infinity
 * or a non-zero number that converts to 0 (such as 0.5). 0 stays 0.
 */
export function createCanvas(width?: number, height?: number): Canvas

export function createCanvas(width: number, height: number, svgExportFlag: SvgExportFlag): SvgCanvas

export declare class FontKey {
  // make it a unique type
  private readonly key: symbol
  readonly typefaceId: number
}

export interface FontVariationAxis {
  /** OpenType tag as a 32-bit integer (e.g., 0x77676874 for 'wght') */
  tag: number
  /** Current value for this axis */
  value: number
  /** Minimum value for this axis */
  min: number
  /** Maximum value for this axis */
  max: number
  /** Default value for this axis */
  def: number
  /** Whether this axis should be hidden from UI */
  hidden: boolean
}

interface IGlobalFonts {
  readonly families: { family: string; styles: { weight: number; width: string; style: string }[] }[]
  // return FontKey if succeeded, null if failed
  register(font: Buffer, nameAlias?: string): FontKey | null
  // absolute path - returns FontKey if succeeded, null if failed
  registerFromPath(path: string, nameAlias?: string): FontKey | null
  has(name: string): boolean
  loadFontsFromDir(path: string): number
  /**
   * Set an alias for a font family.
   * @param fontName The original font family name
   * @param alias The alias name to set
   * @returns true if the alias was set successfully, false if the font family doesn't exist
   */
  setAlias(fontName: string, alias: string): boolean
  remove(key: FontKey): boolean
  /**
   * Remove multiple fonts by their keys in a single operation.
   * More efficient than calling remove() multiple times as it triggers only one rebuild.
   * @param fontKeys Array of FontKey objects to remove
   * @returns Number of fonts successfully removed
   */
  removeBatch(fontKeys: FontKey[]): number
  /**
   * Remove ALL registered fonts.
   * @returns Number of fonts removed
   */
  removeAll(): number
  /**
   * Get variation axes for a specific font instance
   * @param familyName The font family name
   * @param weight Font weight (100-900)
   * @param width Font width/stretch value
   * @param slant Font slant (0 = upright, 1 = italic, 2 = oblique)
   * @returns Array of variation axes or empty array if not a variable font
   */
  getVariationAxes(familyName: string, weight: number, width: number, slant: number): FontVariationAxis[]
  /**
   * Check if a font has variable font capabilities
   * @param familyName The font family name
   * @param weight Font weight (100-900)
   * @param width Font width/stretch value
   * @param slant Font slant (0 = upright, 1 = italic, 2 = oblique)
   * @returns true if the font is a variable font
   */
  hasVariations(familyName: string, weight: number, width: number, slant: number): boolean
}

export const GlobalFonts: IGlobalFonts

export enum PathOp {
  Difference = 0, // subtract the op path from the first path
  Intersect = 1, // intersect the two paths
  Union = 2, // union (inclusive-or) the two paths
  Xor = 3, // exclusive-or the two paths
  ReverseDifference = 4, // subtract the first path from the op path
}

export enum FillType {
  Winding = 0,
  EvenOdd = 1,
  InverseWinding = 2,
  InverseEvenOdd = 3,
}

export enum StrokeJoin {
  Miter = 0,
  Round = 1,
  Bevel = 2,
}

export enum StrokeCap {
  Butt = 0,
  Round = 1,
  Square = 2,
}

export enum SvgExportFlag {
  ConvertTextToPaths = 0x01,
  NoPrettyXML = 0x02,
  RelativePathEncoding = 0x04,
}

export function convertSVGTextToPath(svg: Buffer | string): Buffer

export interface LoadImageOptions {
  alt?: string
  maxRedirects?: number
  requestOptions?: import('http').RequestOptions
}

export function loadImage(
  source: string | URL | Buffer | ArrayBufferLike | Uint8Array | Image | import('stream').Readable,
  options?: LoadImageOptions,
): Promise<Image>

export interface PDFMetadata {
  /// The document's title
  title?: string
  /// The name of the person who created the document
  author?: string
  /// The subject of the document
  subject?: string
  /// Keywords associated with the document
  keywords?: string
  /// The product that created the original document
  creator?: string
  /// The product that is converting this document to PDF (defaults to "Skia/PDF")
  producer?: string
  /// The DPI for rasterization (default: 72.0)
  rasterDPI?: number
  /// Encoding quality: 0-100 for lossy JPEG, 101 for lossless (default: 101)
  encodingQuality?: number
  /// Whether to conform to PDF/A-2b standard (default: false)
  pdfa?: boolean
  /// Compression level: -1 (default), 0 (none), 1 (low/fast), 6 (average), 9 (high/slow)
  compressionLevel?: number
}

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export declare class PDFDocument {
  constructor(metadata?: PDFMetadata | undefined | null)
  beginPage(width: number, height: number, rect?: Rect | undefined | null): CanvasRenderingContext2D
  endPage(): void
  close(): Buffer
}

export interface LottieAnimationOptions {
  /** Base path for resolving external resources (images, fonts) */
  resourcePath?: string
}

export interface LottieRenderRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Lottie animation class for loading and rendering Lottie JSON files.
 *
 * @example
 * ```typescript
 * import { LottieAnimation, createCanvas } from '@napi-rs/canvas'
 *
 * const animation = LottieAnimation.loadFromFile('./animation.json')
 * const canvas = createCanvas(animation.width, animation.height)
 * const ctx = canvas.getContext('2d')
 *
 * // Render frame 0
 * animation.seekFrame(0)
 * animation.render(ctx)
 *
 * // Save to PNG
 * const buffer = canvas.toBuffer('image/png')
 * ```
 */
export declare class LottieAnimation {
  /**
   * Load animation from JSON string or Buffer
   * @param data - JSON string or Buffer containing Lottie animation data
   * @param options - Optional configuration
   */
  static loadFromData(data: string | Buffer, options?: LottieAnimationOptions): LottieAnimation

  /**
   * Load animation from file path
   * External assets are resolved relative to the file's directory
   * @param path - Path to the Lottie JSON file
   */
  static loadFromFile(path: string): LottieAnimation

  /** Animation duration in seconds */
  readonly duration: number

  /** Frame rate (frames per second) */
  readonly fps: number

  /** Total frame count */
  readonly frames: number

  /** Animation width in pixels */
  readonly width: number

  /** Animation height in pixels */
  readonly height: number

  /** Lottie format version string */
  readonly version: string

  /** Animation in-point (start frame) */
  readonly inPoint: number

  /** Animation out-point (end frame) */
  readonly outPoint: number

  /**
   * Seek to normalized position
   * @param t - Position between 0.0 (start) and 1.0 (end)
   */
  seek(t: number): void

  /**
   * Seek to specific frame index
   * @param frame - Frame index (0 = first frame)
   */
  seekFrame(frame: number): void

  /**
   * Seek to specific time in seconds
   * @param seconds - Time in seconds from start
   */
  seekTime(seconds: number): void

  /**
   * Render current frame to canvas context
   * @param ctx - Canvas 2D rendering context
   * @param dst - Optional destination rectangle for scaling/positioning
   */
  render(ctx: CanvasRenderingContext2D, dst?: LottieRenderRect): void
}
