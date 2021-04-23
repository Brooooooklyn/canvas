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

type OmitMatrixMethod = {
  [K in keyof DOMMatrix]: DOMMatrix[K] extends (...args: any[]) => any ? never : K
}

type OmitNeverOfMatrix = OmitMatrixMethod[keyof OmitMatrixMethod]

export const DOMMatrix: {
  prototype: DOMMatrix
  new (init?: string | number[]): DOMMatrix
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
  new (x?: number, y?: number, width?: number, height?: number): DOMRect
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
  new (x?: number, y?: number, z?: number, w?: number): DOMPoint
  fromPoint(other?: DOMPointInit): DOMPoint
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

  constructor(sw: number, sh: number)
  constructor(data: Uint8ClampedArray, sw: number, sh?: number)
}

export class Image {
  readonly width: number
  readonly height: number
  readonly naturalWidth: number
  readonly naturalHeight: number
  readonly complete: boolean
  alt: string
  src: Buffer
}

export class Path2D {
  constructor(path?: Path2D | string)

  addPath(path: Path2D, transform?: DOMMatrix2DInit): void
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
  equals(path: Path2D): boolean
}

export interface StrokeOptions {
  width?: number
  miterLimit?: number
  cap?: StrokeCap
  join?: StrokeJoin
}

export interface SKRSContext2D extends Omit<CanvasRenderingContext2D, 'drawImage' | 'createPattern'> {
  drawImage(image: Image, dx: number, dy: number): void
  drawImage(image: Image, dx: number, dy: number, dw: number, dh: number): void
  drawImage(
    image: Image,
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
}

export interface Canvas extends Omit<HTMLCanvasElement, 'getContext'> {
  getContext(contextType: '2d', contextAttributes?: { alpha: boolean }): SKRSContext2D
  png(): Promise<Buffer>
}

export function createCanvas(width: number, height: number): Canvas

export const enum PathOp {
  Difference = 0, // subtract the op path from the first path
  Intersect = 1, // intersect the two paths
  Union = 2, // union (inclusive-or) the two paths
  XOR = 3, // exclusive-or the two paths
  ReverseDifference = 4, // subtract the first path from the op path
}

export const enum FillType {
  Winding = 0,
  EvenOdd = 1,
  InverseWinding = 2,
  InverseEvenOdd = 3,
}

export const enum StrokeJoin {
  Miter = 0,
  Round = 1,
  Bevel = 2,
}

export const enum StrokeCap {
  Butt = 0,
  Round = 1,
  Square = 2,
}
