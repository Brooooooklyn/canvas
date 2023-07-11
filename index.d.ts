// Clear all type of caches in Skia
export function clearAllCache(): void

export type GlobalCompositeOperation =
  | 'clear'
  | 'copy'
  | 'destination'
  | 'source-over'
  | 'destination-over'
  | 'source-in'
  | 'destination-in'
  | 'source-out'
  | 'destination-out'
  | 'source-atop'
  | 'destination-atop'
  | 'xor'
  | 'lighter'
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'
  | 'saturate'

export type CanvasLineCap = 'butt' | 'round' | 'square'

export type CanvasLineJoin = 'bevel' | 'miter' | 'round'

export type CanvasTextBaseline = 'alphabetic' | 'bottom' | 'hanging' | 'ideographic' | 'middle' | 'top'

export type CanvasTextAlign = 'center' | 'end' | 'left' | 'right' | 'start'

export interface TextMetrics {
  readonly actualBoundingBoxAscent: number
  readonly actualBoundingBoxDescent: number
  readonly actualBoundingBoxLeft: number
  readonly actualBoundingBoxRight: number
  readonly fontBoundingBoxAscent: number
  readonly fontBoundingBoxDescent: number
  readonly width: number
}

export type CanvasFillRule = 'evenodd' | 'nonzero'

export class CanvasRenderingContext2D {
  drawImage(image: Canvas | Image, dx: number, dy: number): void
  drawImage(image: Canvas | Image, dx: number, dy: number, dw: number, dh: number): void
  drawImage(
    image: Canvas | Image,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void
  putImageData(imagedata: ImageData, dx: number, dy: number): void
  putImageData(
    imagedata: ImageData,
    dx: number,
    dy: number,
    dirtyX: number,
    dirtyY: number,
    dirtyWidth: number,
    dirtyHeight: number,
  ): void
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData
  createImageData(sw: number, sh: number): ImageData
  createImageData(imagedata: ImageData): ImageData
  /**
   * For PDF canvases, adds another page. If width and/or height are omitted,
   * the canvas's initial size is used.
   */
  addPage(width?: number, height?: number): void
  save(): void
  restore(): void
  rotate(angle: number): void
  translate(x: number, y: number): void
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void
  getTransform(): DOMMatrix2D
  resetTransform(): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  setTransform(transform?: DOMMatrix2D): void
  isPointInPath(x: number, y: number, fillRule?: CanvasFillRule): boolean
  scale(x: number, y: number): void
  clip(fillRule?: CanvasFillRule): void
  fill(path?: Path2D, fillRule?: CanvasFillRule): void
  stroke(): void
  fillText(text: string, x: number, y: number, maxWidth?: number): void
  strokeText(text: string, x: number, y: number, maxWidth?: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  rect(x: number, y: number, w: number, h: number): void
  roundRect(x: number, y: number, w: number, h: number, radii?: number | number[]): void
  measureText(text: string): TextMetrics
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void
  beginPath(): void
  closePath(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void
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
  setLineDash(segments: number[]): void
  getLineDash(): number[]
  createPattern(
    image: Canvas | Image,
    repetition: 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat' | '' | null,
  ): CanvasPattern
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient
  /**
   * _Non-standard_. Defaults to 'good'. Affects pattern (gradient, image,
   * etc.) rendering quality.
   */
  patternQuality: 'fast' | 'good' | 'best' | 'nearest' | 'bilinear'
  imageSmoothingEnabled: boolean
  globalCompositeOperation: GlobalCompositeOperation
  globalAlpha: number
  shadowColor: string
  miterLimit: number
  lineWidth: number
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
  lineDashOffset: number
  shadowOffsetX: number
  shadowOffsetY: number
  shadowBlur: number
  /** _Non-standard_. Sets the antialiasing mode. */
  antialias: 'default' | 'gray' | 'none' | 'subpixel'
  /**
   * Defaults to 'path'. The effect depends on the canvas type:
   *
   * * **Standard (image)** `'glyph'` and `'path'` both result in rasterized
   *   text. Glyph mode is faster than path, but may result in lower-quality
   *   text, especially when rotated or translated.
   *
   * * **PDF** `'glyph'` will embed text instead of paths into the PDF. This
   *   is faster to encode, faster to open with PDF viewers, yields a smaller
   *   file size and makes the text selectable. The subset of the font needed
   *   to render the glyphs will be embedded in the PDF. This is usually the
   *   mode you want to use with PDF canvases.
   *
   * * **SVG** glyph does not cause `<text>` elements to be produced as one
   *   might expect ([cairo bug](https://gitlab.freedesktop.org/cairo/cairo/issues/253)).
   *   Rather, glyph will create a `<defs>` section with a `<symbol>` for each
   *   glyph, then those glyphs be reused via `<use>` elements. `'path'` mode
   *   creates a `<path>` element for each text string. glyph mode is faster
   *   and yields a smaller file size.
   *
   * In glyph mode, `ctx.strokeText()` and `ctx.fillText()` behave the same
   * (aside from using the stroke and fill style, respectively).
   */
  textDrawingMode: 'path' | 'glyph'
  /**
   * _Non-standard_. Defaults to 'good'. Like `patternQuality`, but applies to
   * transformations affecting more than just patterns.
   */
  quality: 'fast' | 'good' | 'best' | 'nearest' | 'bilinear'
  /** Returns or sets a `DOMMatrix` for the current transformation matrix. */
  currentTransform: DOMMatrix
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  font: string
  textBaseline: CanvasTextBaseline
  textAlign: CanvasTextAlign
  canvas: Canvas
}
export class CanvasGradient {
  addColorStop(offset: number, color: string): void
}
export class CanvasPattern {
  setTransform(transform?: DOMMatrix): void
}

export interface DOMMatrix2D {
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
  multiply(other?: DOMMatrix): DOMMatrix
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
  transformPoint(point?: DOMPoint): DOMPoint
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
  multiplySelf(other?: DOMMatrix): DOMMatrix
  preMultiplySelf(other?: DOMMatrix): DOMMatrix
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

type OmitMatrixMethod = {
  [K in keyof DOMMatrix]: DOMMatrix[K] extends (...args: any[]) => any ? never : K
}

type OmitNeverOfMatrix = OmitMatrixMethod[keyof OmitMatrixMethod]

export const DOMMatrix: {
  prototype: DOMMatrix
  new (init?: string | number[]): DOMMatrix
  fromFloat32Array(array32: Float32Array): DOMMatrix
  fromFloat64Array(array64: Float64Array): DOMMatrix
  fromMatrix(other?: DOMMatrix): DOMMatrix
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
  new (x?: number, y?: number, width?: number, height?: number): DOMRect
  fromRect(other?: DOMRect): DOMRect
}

interface DOMPointReadOnly {
  readonly w: number
  readonly x: number
  readonly y: number
  readonly z: number
  matrixTransform(matrix?: DOMMatrix): DOMPoint
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
  new (x?: number, y?: number, z?: number, w?: number): DOMPoint
  fromPoint(other?: DOMPoint): DOMPoint
}

export class ImageData {
  /**
   * Returns the one-dimensional array containing the data in RGBA order, as integers in the range 0 to 255.
   */
  readonly data: Uint8ClampedArray
  /**
   * Returns the actual dimensions of the data in the ImageData object, in pixels.
   */
  readonly height: number
  /**
   * Returns the actual dimensions of the data in the ImageData object, in pixels.
   */
  readonly width: number

  constructor(sw: number, sh: number, attr?: { colorSpace?: ColorSpace })
  constructor(imageData: ImageData, attr?: { colorSpace?: ColorSpace })
  constructor(data: Uint8ClampedArray, sw: number, sh?: number)
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
  alt: string
  src: Buffer
  onload?(): void
  onerror?(err: Error): void
}

export class Path2D {
  constructor(path?: Path2D | string)

  addPath(path: Path2D, transform?: DOMMatrix2D): void
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
  roundRect(x: number, y: number, w: number, h: number, radii?: number | number[]): void

  // PathKit methods
  op(path: Path2D, operation: PathOp): Path2D
  toSVGString(): string
  getFillType(): FillType
  getFillTypeString(): string
  setFillType(type: FillType): void
  simplify(): Path2D
  asWinding(): Path2D
  stroke(stroke?: StrokeOptions): Path2D
  transform(transform: DOMMatrix2D): Path2D
  getBounds(): [left: number, top: number, right: number, bottom: number]
  computeTightBounds(): [left: number, top: number, right: number, bottom: number]
  trim(start: number, end: number, isComplement?: boolean): Path2D
  dash(on: number, off: number, phase: number): Path2D
  equals(path: Path2D): boolean
}

export interface StrokeOptions {
  width?: number
  miterLimit?: number
  cap?: StrokeCap
  join?: StrokeJoin
}

export interface SKRSContext2D
  extends Omit<
    CanvasRenderingContext2D,
    'drawImage' | 'createPattern' | 'getTransform' | 'drawFocusIfNeeded' | 'scrollPathIntoView' | 'canvas'
  > {
  canvas: Canvas
  /**
   * @param startAngle The angle at which to begin the gradient, in radians. Angle measurements start vertically above the centre and move around clockwise.
   * @param x The x-axis coordinate of the centre of the gradient.
   * @param y The y-axis coordinate of the centre of the gradient.
   */
  createConicGradient(startAngle: number, x: number, y: number): CanvasGradient
  drawImage(image: Image | Canvas, dx: number, dy: number): void
  drawImage(image: Image | Canvas, dx: number, dy: number, dw: number, dh: number): void
  drawImage(
    image: Image | Canvas,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void
  createPattern(
    image: Image | ImageData,
    repeat: 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat' | null,
  ): CanvasPattern
  getContextAttributes(): { alpha: boolean; desynchronized: boolean }
  getTransform(): DOMMatrix
}

export type ColorSpace = 'srgb' | 'display-p3'

export interface ContextAttributes {
  alpha?: boolean
  colorSpace?: ColorSpace
}

export interface SvgCanvas {
  width: number
  height: number
  getContext(contextType: '2d', contextAttributes?: ContextAttributes): SKRSContext2D

  getContent(): Buffer
}

export interface AvifConfig {
  /** 0-100 scale, 100 is lossless */
  quality?: number
  /** 0-100 scale */
  alphaQuality?: number
  /** rav1e preset 1 (slow) 10 (fast but crappy), default is 4 */
  speed?: number
  /** How many threads should be used (0 = match core count) */
  threads?: number
  /** set to '4:2:0' to use chroma subsampling, default '4:4:4' */
  chromaSubsampling?: ChromaSubsampling
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

export class Canvas {
  constructor(width: number, height: number, flag?: SvgExportFlag)

  width: number
  height: number
  getContext(contextType: '2d', contextAttributes?: ContextAttributes): SKRSContext2D
  encodeSync(format: 'webp' | 'jpeg', quality?: number): Buffer
  encodeSync(format: 'png'): Buffer
  encodeSync(format: 'avif', cfg?: AvifConfig): Buffer
  encode(format: 'webp' | 'jpeg', quality?: number): Promise<Buffer>
  encode(format: 'png'): Promise<Buffer>
  encode(format: 'avif', cfg?: AvifConfig): Promise<Buffer>

  toBuffer(mime: 'image/png'): Buffer
  toBuffer(mime: 'image/jpeg' | 'image/webp', quality?: number): Buffer
  toBuffer(mime: 'image/avif', cfg?: AvifConfig): Buffer
  // raw pixels
  data(): Buffer
  toDataURL(mime?: 'image/png'): string
  toDataURL(mime: 'image/jpeg' | 'image/webp', quality?: number): string
  toDataURL(mime?: 'image/jpeg' | 'image/webp' | 'image/png', quality?: number): string
  toDataURL(mime?: 'image/avif', cfg?: AvifConfig): string

  toDataURLAsync(mime?: 'image/png'): Promise<string>
  toDataURLAsync(mime: 'image/jpeg' | 'image/webp', quality?: number): Promise<string>
  toDataURLAsync(mime?: 'image/jpeg' | 'image/webp' | 'image/png', quality?: number): Promise<string>
  toDataURLAsync(mime?: 'image/avif', cfg?: AvifConfig): Promise<string>
}

export function createCanvas(width: number, height: number): Canvas

export function createCanvas(width: number, height: number, svgExportFlag: SvgExportFlag): SvgCanvas

interface IGlobalFonts {
  readonly families: {
    family: string
    styles: {
      weight: number
      width: string
      style: string
    }[]
  }[]
  // return true if succeeded
  register(font: Buffer, nameAlias?: string): boolean
  // absolute path
  registerFromPath(path: string, nameAlias?: string): boolean
  has(name: string): boolean
  loadFontsFromDir(path: string): number
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
