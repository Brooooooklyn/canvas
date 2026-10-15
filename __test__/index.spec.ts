import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import ava, { ExecutionContext, TestFn } from 'ava'

import {
  createCanvas,
  Path2D,
  Canvas,
  SKRSContext2D,
  DOMMatrix,
  loadImage,
  ImageData,
  SvgCanvas,
  SvgExportFlag,
} from '../index'

import { snapshotImage } from './image-snapshot'

const __dirname = dirname(fileURLToPath(import.meta.url))

const test = ava as TestFn<{
  canvas: Canvas
  ctx: SKRSContext2D
}>

test.beforeEach((t) => {
  const canvas = createCanvas(1024, 768)
  t.context.canvas = canvas
  t.context.ctx = canvas.getContext('2d')!
})

// Expected values are Chrome 155's CPU canvas. getImageData() and
// createImageData() default to the context's color space; drawImage into an
// sRGB canvas reads the pixel back as sRGB.
test('display-p3 context uses a display-p3 backing surface', (t) => {
  const canvas = createCanvas(2, 2)
  const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' })
  ctx.fillStyle = 'rgb(32,128,223)'
  ctx.fillRect(0, 0, 1, 1)
  t.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [63, 126, 216, 255])
  t.deepEqual([...canvas.data().subarray(0, 4)], [63, 126, 216, 255])
  const srgb = createCanvas(2, 2).getContext('2d')
  srgb.drawImage(canvas, 0, 0)
  t.deepEqual([...srgb.getImageData(0, 0, 1, 1).data], [31, 128, 223, 255])
  ctx.putImageData(new ImageData(new Uint8ClampedArray([32, 128, 223, 255]), 1, 1, { colorSpace: 'display-p3' }), 0, 0)
  t.deepEqual([...canvas.data().subarray(0, 4)], [32, 128, 223, 255])
  // A later getContext returns the same context and ignores its attributes.
  t.is(canvas.getContext('2d', { colorSpace: 'srgb' }), ctx)
  t.deepEqual([...canvas.data().subarray(0, 4)], [32, 128, 223, 255])
  ctx.fillStyle = 'rgb(32,128,223)'
  ctx.fillRect(0, 0, 1, 1)
  t.deepEqual([...canvas.data().subarray(0, 4)], [63, 126, 216, 255])
  const red = ctx.createImageData(1, 1)
  red.data.set([255, 0, 0, 255])
  ctx.putImageData(red, 1, 1)
  t.deepEqual([...canvas.data().subarray(12, 16)], [255, 0, 0, 255])
})

test('display-p3 context preserves its color space after resize', (t) => {
  const canvas = createCanvas(2, 2)
  const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' })
  for (const dimension of ['width', 'height'] as const) {
    canvas[dimension] = 3
    t.is(canvas.getContext('2d'), ctx)
    ctx.fillStyle = 'rgb(32,128,223)'
    ctx.fillRect(0, 0, 1, 1)
    t.deepEqual([...canvas.data().subarray(0, 4)], [63, 126, 216, 255])
    t.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [63, 126, 216, 255])
  }
})

// Setting width or height resets the bitmap but keeps alpha:false
// (Chrome 155: alpha stays false and a half-transparent fill lands opaque).
test('alpha:false survives width/height changes', (t) => {
  for (const dimension of ['width', 'height'] as const) {
    const canvas = createCanvas(4, 4)
    const ctx = canvas.getContext('2d', { alpha: false })
    const base = [...ctx.getImageData(0, 0, 1, 1).data]
    canvas[dimension] = 8
    t.false(ctx.getContextAttributes().alpha)
    const pixels = canvas.width * canvas.height
    t.deepEqual([...ctx.getImageData(0, 0, canvas.width, canvas.height).data], Array(pixels).fill(base).flat())
    ctx.fillStyle = 'rgba(255,0,0,0.5)'
    ctx.fillRect(0, 0, 1, 1)
    t.is(ctx.getImageData(0, 0, 1, 1).data[3], 255)
  }
})

// GIF has no color profile, so the spec converts its pixels to sRGB. Chrome
// 155 gives 31,128,223 for this P3 pixel in sRGB (drawImage into an sRGB
// canvas, and the P3 PNG round trip).
test('gif output of a display-p3 canvas is converted to sRGB', async (t) => {
  const p3 = createCanvas(8, 8)
  const p3Context = p3.getContext('2d', { colorSpace: 'display-p3' })
  p3Context.fillStyle = 'rgb(32,128,223)'
  p3Context.fillRect(0, 0, 8, 8)
  const decode = async (data: Buffer) => {
    const ctx = createCanvas(8, 8).getContext('2d')
    ctx.drawImage(await loadImage(data), 0, 0)
    return [...ctx.getImageData(4, 4, 1, 1).data]
  }
  t.deepEqual(await decode(p3.toBuffer('image/gif')), [31, 128, 223, 255], 'toBuffer')
  t.deepEqual(await decode(p3.encodeSync('gif')), [31, 128, 223, 255], 'encodeSync')
})

// Our YUV to RGB step for AVIF can round a channel 1 lower than Chrome's.
const nearPixel = (t: ExecutionContext, actual: number[], expected: readonly number[], label: string) =>
  t.true(
    actual.every((value, i) => Math.abs(value - expected[i]) <= 1),
    `${label}: ${actual} vs ${expected}`,
  )

// The spec: a format that supports a color profile must carry the bitmap's
// color space. AVIF does this with CICP (an 'nclx' colr box), so the pixels
// of a P3 canvas stay P3, tagged primaries 12 (P3), transfer 13 (sRGB),
// matrix 6 (BT.601) and full range; an sRGB canvas is tagged 1/13/6. Chrome
// has no AVIF encoder; the pixels are what Chrome 155 CPU decodes from these
// files, apart from the 1 lower red (Chrome 255, 234).
test('avif output keeps the canvas color space and tags it as CICP', async (t) => {
  const colr = (data: Buffer) => {
    const at = data.indexOf('colrnclx')
    return [data.readUInt16BE(at + 8), data.readUInt16BE(at + 10), data.readUInt16BE(at + 12), data[at + 14] >> 7]
  }
  for (const { source, cicp, decoded } of [
    {
      source: 'display-p3',
      cicp: [12, 13, 6, 1],
      decoded: {
        'display-p3': [
          [255, 0, 0, 255],
          [31, 128, 223, 255],
        ],
        srgb: [
          [255, 0, 0, 255],
          [0, 130, 230, 255],
        ],
      },
    },
    {
      source: 'srgb',
      cicp: [1, 13, 6, 1],
      decoded: {
        'display-p3': [
          [234, 51, 35, 255],
          [63, 126, 216, 255],
        ],
        srgb: [
          [255, 0, 0, 255],
          [31, 128, 223, 255],
        ],
      },
    },
  ] as const) {
    const canvas = createCanvas(4, 4)
    const ctx = canvas.getContext('2d', { colorSpace: source })
    const imageData = ctx.createImageData(4, 4)
    for (let i = 0; i < 16; i++) {
      imageData.data.set(i % 4 < 2 ? [255, 0, 0, 255] : [32, 128, 223, 255], i * 4)
    }
    ctx.putImageData(imageData, 0, 0)
    for (const [name, data] of [
      ['toBuffer', canvas.toBuffer('image/avif', { quality: 100 })],
      ['encodeSync', canvas.encodeSync('avif', { quality: 100 })],
    ] as const) {
      t.deepEqual(colr(data), cicp, `${source} ${name}`)
      const image = await loadImage(data)
      for (const colorSpace of ['display-p3', 'srgb'] as const) {
        const label = `${source} ${name} into ${colorSpace}`
        const out = createCanvas(4, 4).getContext('2d', { colorSpace })
        out.drawImage(image, 0, 0)
        const [left, right] = decoded[colorSpace]
        nearPixel(t, [...out.getImageData(0, 0, 1, 1).data], left, `${label} left`)
        t.deepEqual([...out.getImageData(3, 0, 1, 1).data], right, `${label} right`)
      }
    }
  }
})

// AvifConfig.quality is libavif's 0-100 scale, where 100 is the best. Chrome
// has no AVIF encoder, so this follows our own API doc.
test('avif quality: a higher quality gives a bigger and more exact file', async (t) => {
  const canvas = createCanvas(64, 64)
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, 64, 64)
  gradient.addColorStop(0, '#c86432')
  gradient.addColorStop(0.5, '#2080df')
  gradient.addColorStop(1, '#40c040')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(10, 20, 8, 24)
  ctx.fillRect(30, 10, 24, 6)
  const source = ctx.getImageData(0, 0, 64, 64).data
  const maxError = async (data: Buffer) => {
    const out = createCanvas(64, 64).getContext('2d')
    out.drawImage(await loadImage(data), 0, 0)
    return out.getImageData(0, 0, 64, 64).data.reduce((max, value, i) => Math.max(max, Math.abs(value - source[i])), 0)
  }
  const encoders: [string, (quality: number) => Buffer][] = [
    ['toBuffer', (quality) => canvas.toBuffer('image/avif', { quality })],
    ['encodeSync', (quality) => canvas.encodeSync('avif', { quality })],
  ]
  for (const [name, encode] of encoders) {
    const low = encode(10)
    const high = encode(90)
    t.true(low.length < high.length, `${name}: ${low.length} < ${high.length} bytes`)
    t.true((await maxError(high)) < (await maxError(low)), name)
    // Above 100 is the best quality too (256 used to wrap to 0).
    for (const quality of [100, 255, 256, 1000]) {
      t.true((await maxError(encode(quality))) <= 1, `${name} ${quality}`)
    }
  }
})

// The fixtures hold P3 255,0,0 (left) and P3 200,100,50 (right), tagged with an
// ICC profile, with CICP 12/13/6, or with CICP 12/2/6. Chrome 155 CPU honors
// the ICC profile, else the CICP, where an unspecified (2) transfer means sRGB
// (avif_image_decoder.cc:868-914). Our red is 1 lower (nearPixel), as it is
// for an sRGB AVIF.
test('avif decode honors the ICC profile or CICP color space', async (t) => {
  for (const name of ['avif-p3-icc', 'avif-p3-cicp', 'avif-p3-cicp-transfer-unspecified']) {
    const image = await loadImage(join(__dirname, 'fixtures', `${name}.avif`))
    for (const { colorSpace, left, right } of [
      { colorSpace: 'display-p3', left: [255, 0, 0, 255], right: [200, 100, 50, 255] },
      { colorSpace: 'srgb', left: [255, 0, 0, 255], right: [215, 93, 31, 255] },
    ] as const) {
      const ctx = createCanvas(4, 4).getContext('2d', { colorSpace })
      ctx.drawImage(image, 0, 0)
      nearPixel(t, [...ctx.getImageData(0, 0, 1, 1).data], left, `${name} ${colorSpace} left`)
      t.deepEqual([...ctx.getImageData(3, 0, 1, 1).data], right, `${name} ${colorSpace} right`)
    }
  }
})

// The avif-cicp-P-T-M fixtures hold sRGB 128,128,128 | 200,100,50 |
// 32,128,223 | 255,0,0, encoded by avifenc 1.4.2 (4:4:4, full range) with
// CICP primaries P, transfer T and matrix M.
const decodeAvifRow = async (name: string, colorSpace: 'srgb' | 'display-p3') => {
  const ctx = createCanvas(4, 4).getContext('2d', { colorSpace })
  ctx.drawImage(await loadImage(join(__dirname, 'fixtures', `${name}.avif`)), 0, 0)
  const row = [...ctx.getImageData(0, 0, 4, 1).data]
  return [0, 4, 8, 12].map((i) => row.slice(i, i + 4))
}

// Chrome draws the BT.709 family of CICP transfers (1 BT.709, 6 SMPTE 170M,
// 14 and 15 BT.2020) with the sRGB curve (ui/gfx/color_space.cc
// GetTransferFunction), not with the 2.4 gamma of SkColorSpace::MakeCICP.
// Expected values are Chrome 155 CPU; ours can round a channel 1 lower.
test('avif decode draws BT.709-family CICP transfers with the sRGB curve', async (t) => {
  const bt709Primaries = {
    srgb: [
      [128, 128, 128, 255],
      [200, 100, 50, 255],
      [31, 128, 223, 255],
      [255, 0, 0, 255],
    ],
    'display-p3': [
      [128, 128, 128, 255],
      [187, 105, 62, 255],
      [63, 126, 216, 255],
      [234, 51, 35, 255],
    ],
  }
  const bt2020Primaries = {
    srgb: [
      [128, 128, 128, 255],
      [240, 76, 29, 255],
      [0, 134, 231, 255],
      [255, 0, 0, 255],
    ],
    'display-p3': [
      [128, 128, 128, 255],
      [222, 89, 50, 255],
      [0, 130, 223, 255],
      [255, 0, 9, 255],
    ],
  }
  const cases = {
    'avif-cicp-1-1-6': bt709Primaries,
    // Primaries 2 (unspecified) means BT.709.
    'avif-cicp-2-1-6': bt709Primaries,
    // The BT.709 matrix rounds the YUV a little differently.
    'avif-cicp-1-1-1': {
      srgb: [
        [128, 128, 128, 255],
        [200, 100, 51, 255],
        [32, 127, 222, 255],
        [254, 0, 0, 255],
      ],
      'display-p3': [
        [128, 128, 128, 255],
        [187, 105, 63, 255],
        [63, 125, 215, 255],
        [233, 51, 35, 255],
      ],
    },
    'avif-cicp-6-6-6': {
      srgb: [
        [128, 128, 128, 255],
        [196, 102, 49, 255],
        [49, 129, 223, 255],
        [248, 36, 0, 255],
      ],
      'display-p3': [
        [128, 128, 128, 255],
        [183, 107, 61, 255],
        [72, 128, 217, 255],
        [228, 62, 34, 255],
      ],
    },
    'avif-cicp-9-14-9': bt2020Primaries,
    'avif-cicp-9-15-9': bt2020Primaries,
    // P3 primaries are kept; only the transfer is the sRGB curve.
    'avif-cicp-12-1-6': {
      srgb: [
        [128, 128, 128, 255],
        [215, 93, 31, 255],
        [0, 130, 230, 255],
        [255, 0, 0, 255],
      ],
      'display-p3': [
        [128, 128, 128, 255],
        [200, 100, 50, 255],
        [31, 128, 223, 255],
        [255, 0, 0, 255],
      ],
    },
  }
  for (const [name, expected] of Object.entries(cases)) {
    for (const colorSpace of ['srgb', 'display-p3'] as const) {
      const row = await decodeAvifRow(name, colorSpace)
      row.forEach((pixel, x) => nearPixel(t, pixel, expected[colorSpace][x], `${name} ${colorSpace} x=${x}`))
    }
  }
})

// Chrome cannot decode CICP transfer 11 (IEC 61966-2-4), and it tone maps PQ
// (16) and HLG (18) when it draws them into a canvas. We have neither, so
// these stay untagged (drawn as sRGB), as before AVIF color spaces were
// honored. These are not Chrome's values (PQ grey 132, HLG grey 99), but are
// closer to them than Skia's plain BT.709, PQ and HLG curves (121, 181, 137).
test('avif decode leaves CICP transfers 11, PQ and HLG untagged', async (t) => {
  const untagged = [
    [128, 128, 128, 255],
    [200, 100, 50, 255],
    [31, 128, 223, 255],
    [255, 0, 0, 255],
  ]
  for (const name of ['avif-cicp-1-11-6', 'avif-cicp-9-16-9', 'avif-cicp-9-18-9']) {
    const row = await decodeAvifRow(name, 'srgb')
    row.forEach((pixel, x) => nearPixel(t, pixel, untagged[x], `${name} x=${x}`))
  }
})

// drawCanvas has no Chrome counterpart, so it is held to drawImage: a P3
// gradient drawn into an sRGB canvas must give the same pixels either way.
test('drawCanvas of a display-p3 source matches drawImage', (t) => {
  const source = createCanvas(256, 1)
  const sourceContext = source.getContext('2d', { colorSpace: 'display-p3' })
  const gradient = sourceContext.createLinearGradient(0, 0, 256, 0)
  gradient.addColorStop(0, '#ff0000')
  gradient.addColorStop(1, '#0000ff')
  sourceContext.fillStyle = gradient
  sourceContext.fillRect(0, 0, 256, 1)
  const viaCanvas = createCanvas(256, 1).getContext('2d')
  viaCanvas.drawCanvas(source, 0, 0)
  const viaImage = createCanvas(256, 1).getContext('2d')
  viaImage.drawImage(source, 0, 0)
  t.deepEqual([...viaCanvas.getImageData(128, 0, 1, 1).data], [...viaImage.getImageData(128, 0, 1, 1).data])
})

// drawCanvas takes a picture replay into a destination in the same colour
// space and the source bitmap into another one. Both arms treat a negative
// size as drawImage does (Blink AdjustRectForCanvas): the origin moves, the
// image is not mirrored.
test('drawCanvas normalises negative sizes like drawImage', (t) => {
  // column i is rgb(i * 25, 0, 255 - i * 25)
  const source = createCanvas(10, 10)
  const sourceContext = source.getContext('2d')
  for (let i = 0; i < 10; i++) {
    sourceContext.fillStyle = `rgb(${i * 25},0,${255 - i * 25})`
    sourceContext.fillRect(i, 0, 1, 10)
  }
  const args: [number, number, number, number, number?, number?, number?, number?][] = [
    [30, 20, -10, 10],
    [30, 20, 10, -10],
    [0, 0, 10, 10, 30, 20, -10, -10],
    [10, 0, -10, 10, 30, 20, 10, 10],
    // past the f32 range: nothing is drawn
    [0, 0, 1e39, 10],
    [0, 0, -1e39, 10],
  ]
  for (const colorSpace of ['srgb', 'display-p3'] as const) {
    for (const a of args) {
      const viaCanvas = createCanvas(64, 64).getContext('2d', { colorSpace })
      // @ts-expect-error the 4- and 8-argument forms
      viaCanvas.drawCanvas(source, ...a)
      const viaImage = createCanvas(64, 64).getContext('2d', { colorSpace })
      // @ts-expect-error the 4- and 8-argument forms
      viaImage.drawImage(source, ...a)
      t.deepEqual(
        [...viaCanvas.getImageData(0, 0, 64, 64).data],
        [...viaImage.getImageData(0, 0, 64, 64).data],
        `${colorSpace} ${a.join(',')}`,
      )
    }
  }
  const ctx = createCanvas(64, 64).getContext('2d')
  ctx.drawCanvas(source, 30, 20, -10, 10)
  t.deepEqual([...ctx.getImageData(20, 25, 1, 1).data], [0, 0, 255, 255])
  t.deepEqual([...ctx.getImageData(29, 25, 1, 1).data], [225, 0, 30, 255])
})

// drawImage clamps an origin past the f32 range to it (Blink ClampTo<float>),
// and a tiny transform can bring that rect back into view. drawCanvas must
// paint the same area. The picture replays the source's 1px columns scaled
// by 3.4, so their antialiased seams overlap where drawImage samples one
// image: only which pixels are painted is compared.
test('drawCanvas clamps out-of-range origins like drawImage', (t) => {
  const source = createCanvas(10, 10)
  const sourceContext = source.getContext('2d')
  for (let i = 0; i < 10; i++) {
    sourceContext.fillStyle = `rgb(${i * 25},0,${255 - i * 25})`
    sourceContext.fillRect(i, 0, 1, 10)
  }
  const cases: [number[], number[]][] = [
    [
      [1e-37, 0, 0, 1, 40, 0],
      [-3.5e38, 0, 3.4e38, 10],
    ],
    [
      [1, 0, 0, 1e-37, 0, 40],
      [0, -3.5e38, 10, 3.4e38],
    ],
    // the normalised origin is the one past the range
    [
      [1e-37, 0, 0, 1, 40, 0],
      [-1e38, 0, -2.5e38, 10],
    ],
    // a source origin past the range: nothing is drawn
    [
      [1, 0, 0, 1, 0, 0],
      [-3.5e38, 0, 3.4e38, 10, 0, 0, 40, 10],
    ],
  ]
  const painted = (ctx: SKRSContext2D) =>
    [...ctx.getImageData(0, 0, 64, 64).data].filter((_, i) => i % 4 === 3).map((a) => a > 0)
  for (const colorSpace of ['srgb', 'display-p3'] as const) {
    for (const [matrix, a] of cases) {
      const viaCanvas = createCanvas(64, 64).getContext('2d', { colorSpace })
      viaCanvas.setTransform(...(matrix as [number, number, number, number, number, number]))
      // @ts-expect-error the 4- and 8-argument forms
      viaCanvas.drawCanvas(source, ...a)
      const viaImage = createCanvas(64, 64).getContext('2d', { colorSpace })
      viaImage.setTransform(...(matrix as [number, number, number, number, number, number]))
      // @ts-expect-error the 4- and 8-argument forms
      viaImage.drawImage(source, ...a)
      t.deepEqual(painted(viaCanvas), painted(viaImage), `${colorSpace} ${matrix.join(',')} ${a.join(',')}`)
    }
  }
  // Chrome 155's drawImage paints x = 6..39 of row 0 for the first case.
  const ctx = createCanvas(64, 64).getContext('2d')
  ctx.setTransform(1e-37, 0, 0, 1, 40, 0)
  ctx.drawCanvas(source, -3.5e38, 0, 3.4e38, 10)
  const row = [...ctx.getImageData(0, 0, 64, 1).data].filter((_, i) => i % 4 === 3)
  t.deepEqual(
    row.flatMap((v, x) => (v ? [x] : [])),
    Array.from({ length: 34 }, (_, i) => i + 6),
  )
})

test('pattern snapshots preserve integer texels after canvas mutation', (t) => {
  const source = createCanvas(2, 2)
  const src = source.getContext('2d')
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffffff']
  for (let i = 0; i < colors.length; i++) {
    src.fillStyle = colors[i]
    src.fillRect(i % 2, Math.floor(i / 2), 1, 1)
  }
  const expected = [...src.getImageData(0, 0, 2, 2).data]
  const ctx = createCanvas(2, 2).getContext('2d')
  ctx.fillStyle = ctx.createPattern(source, 'repeat')!
  source.width = 1
  ctx.fillRect(0, 0, 2, 2)
  t.deepEqual([...ctx.getImageData(0, 0, 2, 2).data], expected)
})

test('pattern sampling follows smoothing changes after assignment', (t) => {
  const source = createCanvas(2, 1)
  const src = source.getContext('2d')
  src.fillStyle = '#ff0000'
  src.fillRect(0, 0, 1, 1)
  src.fillStyle = '#00ff00'
  src.fillRect(1, 0, 1, 1)
  const ctx = createCanvas(4, 1).getContext('2d')
  const pattern = ctx.createPattern(source, 'repeat')!
  pattern.setTransform(new DOMMatrix([2, 0, 0, 1, 0, 0]))
  ctx.fillStyle = pattern
  ctx.imageSmoothingEnabled = false
  ctx.fillRect(0, 0, 4, 1)
  const expected = [255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255]
  t.deepEqual([...ctx.getImageData(0, 0, 4, 1).data], expected)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'low'
  ctx.fillRect(0, 0, 4, 1)
  // Chrome 155's CPU canvas
  t.deepEqual(
    [...ctx.getImageData(0, 0, 4, 1).data],
    [191, 64, 0, 255, 191, 64, 0, 255, 64, 191, 0, 255, 64, 191, 0, 255],
  )
  ctx.imageSmoothingEnabled = false
  ctx.fillRect(0, 0, 4, 1)
  t.deepEqual([...ctx.getImageData(0, 0, 4, 1).data], expected)
})

// Expected values are Chrome 155's CPU canvas: filtering premultiplied texels
// keeps the red at full strength next to a transparent texel.
test('canvas pattern filters premultiplied texels', (t) => {
  const source = createCanvas(2, 1)
  const src = source.getContext('2d')
  src.fillStyle = '#ff0000'
  src.fillRect(0, 0, 1, 1)
  const ctx = createCanvas(8, 1).getContext('2d')
  const pattern = ctx.createPattern(source, 'repeat')!
  pattern.setTransform(new DOMMatrix([4, 0, 0, 1, 0, 0]))
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, 8, 1)
  t.deepEqual(
    [...ctx.getImageData(0, 0, 8, 1).data],
    [
      255, 0, 0, 159, 255, 0, 0, 223, 255, 0, 0, 223, 255, 0, 0, 159, 255, 0, 0, 96, 255, 0, 0, 32, 255, 0, 0, 32, 255,
      0, 0, 96,
    ],
  )
})

// Chrome samples patterns linearly at every smoothing quality (never cubic), so
// an untransformed pattern copies its texels unchanged.
test('identity pattern keeps texels at every smoothing quality', (t) => {
  const source = createCanvas(2, 1)
  const src = source.getContext('2d')
  src.fillStyle = '#ff00ff'
  src.fillRect(0, 0, 1, 1)
  for (const quality of ['low', 'medium', 'high'] as const) {
    const ctx = createCanvas(2, 1).getContext('2d')
    ctx.imageSmoothingQuality = quality
    ctx.fillStyle = ctx.createPattern(source, 'repeat')!
    ctx.fillRect(0, 0, 2, 1)
    t.deepEqual([...ctx.getImageData(0, 0, 2, 1).data], [255, 0, 255, 255, 0, 0, 0, 0], quality)
  }
})

const stripeCanvas = (size: number) => {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffffff']
  for (let x = 0; x < size; x++) {
    ctx.fillStyle = colors[x % 4]
    ctx.fillRect(x, 0, 1, size)
  }
  return canvas
}

const scaledPatternRow = (
  source: Parameters<SKRSContext2D['createPattern']>[0],
  scale: number,
  quality: SKRSContext2D['imageSmoothingQuality'],
) => {
  const ctx = createCanvas(4, 1).getContext('2d')
  ctx.imageSmoothingQuality = quality
  const pattern = ctx.createPattern(source, 'repeat')!
  pattern.setTransform(new DOMMatrix([scale, 0, 0, scale, 0, 0]))
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, 4, 1)
  return [...ctx.getImageData(0, 0, 4, 1).data]
}

// Expected values are Chrome 155's CPU canvas: a scaled-down canvas pattern
// blends two mip levels at 'medium' and 'high'.
test('downscaled canvas pattern blends two mip levels', (t) => {
  const source = stripeCanvas(4)
  for (const quality of ['medium', 'high'] as const) {
    t.deepEqual(
      scaledPatternRow(source, 0.4, quality),
      [116, 138, 26, 255, 150, 138, 165, 255, 104, 116, 165, 255, 138, 116, 26, 255],
      quality,
    )
  }
})

// Expected values are Chrome 155's CPU canvas: a scaled-down Image pattern
// samples a single mip level at 'medium' and 'high'.
test('downscaled image pattern samples one mip level', async (t) => {
  const source = await loadImage(stripeCanvas(8).toBuffer('image/png'))
  for (const quality of ['medium', 'high'] as const) {
    t.deepEqual(
      scaledPatternRow(source, 0.2, quality),
      [127, 127, 127, 255, 127, 127, 127, 255, 127, 127, 127, 255, 127, 127, 127, 255],
      quality,
    )
  }
})

// Chrome has no ImageData pattern: createPattern(imageData) throws. Its analog,
// a pattern over createImageBitmap(imageData), samples premultiplied texels the
// way a canvas source does. Expected values are Chrome 155's CPU canvas with
// that ImageBitmap in place of the ImageData.
const imageDataPatternRow = (
  data: number[],
  sourceWidth: number,
  width: number,
  matrix: number[],
  quality: SKRSContext2D['imageSmoothingQuality'],
  repetition: string,
) => {
  const source = new ImageData(new Uint8ClampedArray(data), sourceWidth, data.length / 4 / sourceWidth)
  const ctx = createCanvas(width, 1).getContext('2d')
  ctx.imageSmoothingQuality = quality
  const pattern = ctx.createPattern(source, repetition)!
  pattern.setTransform(new DOMMatrix(matrix))
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, width, 1)
  return [...ctx.getImageData(0, 0, width, 1).data]
}

test('ImageData pattern filters premultiplied texels', (t) => {
  t.deepEqual(
    imageDataPatternRow([255, 0, 0, 255, 0, 0, 0, 0], 2, 8, [4, 0, 0, 1, 0, 0], 'low', 'repeat'),
    [
      255, 0, 0, 159, 255, 0, 0, 223, 255, 0, 0, 223, 255, 0, 0, 159, 255, 0, 0, 96, 255, 0, 0, 32, 255, 0, 0, 32, 255,
      0, 0, 96,
    ],
  )
})

test('no-repeat ImageData pattern keeps its color next to the transparent edge', (t) => {
  t.deepEqual(
    imageDataPatternRow(Array(4).fill([0, 128, 255, 255]).flat(), 2, 6, [2, 0, 0, 2, 0.5, 0], 'low', 'no-repeat'),
    [0, 128, 255, 96, 0, 128, 255, 191, 0, 128, 255, 191, 0, 128, 255, 191, 0, 128, 255, 96, 0, 0, 0, 0],
  )
})

test('downscaled ImageData pattern blends two mip levels', (t) => {
  const colors = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 255, 255],
  ]
  const stripes = Array.from({ length: 16 }, (_, i) => colors[i % 4]).flat()
  for (const quality of ['medium', 'high'] as const) {
    t.deepEqual(
      imageDataPatternRow(stripes, 4, 4, [0.4, 0, 0, 0.4, 0, 0], quality, 'repeat'),
      [116, 138, 26, 255, 150, 138, 165, 255, 104, 116, 165, 255, 138, 116, 26, 255],
      quality,
    )
  }
})

// The pattern reads the ImageData in its colorSpace and converts it to the
// canvas, as putImageData does and as Chrome's pattern over
// createImageBitmap(imageData) does. Expected values are Chrome 155's. An
// SvgCanvas reads back what a canvas with its colorSpace holds.
test('ImageData pattern converts from the ImageData colorSpace', (t) => {
  const colors = [200, 100, 50, 255, 10, 240, 120, 255, 255, 0, 0, 255, 0, 0, 255, 128]
  const chrome = {
    'srgb on srgb': colors,
    'srgb on display-p3': [187, 105, 62, 255, 110, 236, 133, 255, 234, 51, 35, 255, 0, 0, 245, 128],
    'display-p3 on srgb': [215, 93, 31, 255, 0, 244, 104, 255, 255, 0, 0, 255, 0, 0, 255, 128],
    'display-p3 on display-p3': colors,
  }
  const canvases = {
    Canvas: () => createCanvas(4, 1),
    SvgCanvas: () => createCanvas(4, 1, SvgExportFlag.NoPrettyXML),
  }
  for (const [kind, make] of Object.entries(canvases)) {
    for (const [name, expected] of Object.entries(chrome)) {
      const [source, target] = name.split(' on ') as ('srgb' | 'display-p3')[]
      const imageData = new ImageData(new Uint8ClampedArray(colors), 4, 1, { colorSpace: source })
      const ctx = make().getContext('2d', { colorSpace: target })
      ctx.fillStyle = ctx.createPattern(imageData, 'repeat')
      ctx.fillRect(0, 0, 4, 1)
      t.deepEqual([...ctx.getImageData(0, 0, 4, 1).data], expected, `${kind} ${name}`)
    }
  }
})

// Chrome 155 paints nothing with a canvas or image pattern whose matrix cannot
// be inverted.
test('pattern with a singular transform paints nothing', async (t) => {
  const source = createCanvas(4, 4)
  const src = source.getContext('2d')
  src.fillStyle = '#ff0000'
  src.fillRect(0, 0, 4, 4)
  const sources = {
    canvas: source,
    image: await loadImage(source.toBuffer('image/png')),
    imageData: src.getImageData(0, 0, 4, 4),
  }
  for (const [name, input] of Object.entries(sources)) {
    const ctx = createCanvas(4, 4).getContext('2d')
    ctx.fillStyle = '#0000ff'
    ctx.fillRect(0, 0, 4, 4)
    const pattern = ctx.createPattern(input, 'repeat')!
    pattern.setTransform(new DOMMatrix([0, 0, 0, 0, 0, 0]))
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, 4, 4)
    t.deepEqual([...ctx.getImageData(1, 1, 1, 1).data], [0, 0, 255, 255], name)
  }
})

test('should be able to create Path2D', (t) => {
  t.notThrows(() => new Path2D())
  t.notThrows(
    () =>
      new Path2D(
        'M108.956,403.826c0,0,0.178,3.344-1.276,3.311  c-1.455-0.033-30.507-84.917-66.752-80.957C40.928,326.18,72.326,313.197,108.956,403.826z',
      ),
  )
  t.notThrows(() => new Path2D(new Path2D()))
})

test('miterLimit state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.miterLimit, 10)
  ctx.miterLimit = 20
  t.is(ctx.miterLimit, 20)
})

test('globalAlpha state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.globalAlpha, 1)
  ctx.globalAlpha = 0.2
  t.is(ctx.globalAlpha, 0.2)
})

test('globalAlpha retains fractional state through save and restore', (t) => {
  const { ctx } = t.context
  ctx.globalAlpha = 0.501
  ctx.save()
  ctx.globalAlpha = 0.1
  t.is(ctx.globalAlpha, 0.1)
  ctx.restore()
  t.is(ctx.globalAlpha, 0.501)
  for (const invalid of [NaN, Infinity, -Number.EPSILON, 1 + Number.EPSILON]) {
    ctx.globalAlpha = invalid
    t.is(ctx.globalAlpha, 0.501)
  }
})

test('globalAlpha draws half opacity without an early byte truncation', (t) => {
  const canvas = createCanvas(1, 1)
  const ctx = canvas.getContext('2d')
  ctx.globalAlpha = 0.5
  ctx.fillStyle = 'rgb(32, 128, 223)'
  ctx.fillRect(0, 0, 1, 1)
  t.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [32, 128, 223, 128])
})

test('globalAlpha leaves rounded CSS alpha intact at full opacity', (t) => {
  for (const { alpha, expected } of [
    { alpha: 0.1, expected: [29, 128, 226, 26] },
    { alpha: 0.25, expected: [32, 128, 223, 64] },
    { alpha: 0.5, expected: [32, 128, 223, 128] },
    { alpha: 0.9, expected: [32, 128, 223, 230] },
  ]) {
    const canvas = createCanvas(1, 1)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = `rgba(32, 128, 223, ${alpha})`
    ctx.fillRect(0, 0, 1, 1)
    t.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], expected)
  }
})

test('globalAlpha preserves half opacity across native paint sources', async (t) => {
  const source = createCanvas(4, 4)
  const sourceContext = source.getContext('2d')
  sourceContext.fillStyle = 'rgb(32, 128, 223)'
  sourceContext.fillRect(0, 0, 4, 4)
  const image = await loadImage(source.toBuffer('image/png'))
  for (const mode of ['fill', 'stroke', 'gradient', 'pattern', 'image', 'canvas']) {
    const canvas = createCanvas(4, 4)
    const ctx = canvas.getContext('2d')
    ctx.globalAlpha = 0.5
    ctx.fillStyle = 'rgb(32, 128, 223)'
    ctx.strokeStyle = ctx.fillStyle
    if (mode === 'stroke') {
      ctx.lineWidth = 2
      ctx.strokeRect(1, 1, 2, 2)
    } else if (mode === 'gradient') {
      const gradient = ctx.createLinearGradient(0, 0, 4, 0)
      gradient.addColorStop(0, 'rgb(32, 128, 223)')
      gradient.addColorStop(1, 'rgb(32, 128, 223)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, 4, 4)
    } else if (mode === 'pattern') {
      ctx.fillStyle = ctx.createPattern(source, 'repeat')!
      ctx.fillRect(0, 0, 4, 4)
    } else if (mode === 'image') {
      ctx.drawImage(image, 0, 0)
    } else if (mode === 'canvas') {
      ctx.drawImage(source, 0, 0)
    } else {
      ctx.fillRect(0, 0, 4, 4)
    }
    const expected = mode === 'gradient' ? [32, 128, 221, 128] : [32, 128, 223, 128]
    t.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], expected, mode)
  }
})

for (const paint of ['fill', 'stroke'] as const) {
  test(`gradient ${paint} dithers translucent pixels without changing solid paints`, (t) => {
    // chrome 149 cpu canvas: constant stops still use gradient dithering.
    const expected = Array.from({ length: 16 }, (_, i) => [
      32,
      128,
      ((i % 4) + Math.floor(i / 4)) % 2 === 0 ? 221 : 223,
      128,
    ]).flat()
    for (const kind of ['linear', 'radial', 'conic']) {
      const ctx = createCanvas(4, 4).getContext('2d')
      const gradient =
        kind === 'linear'
          ? ctx.createLinearGradient(0, 0, 4, 0)
          : kind === 'radial'
            ? ctx.createRadialGradient(2, 2, 0, 2, 2, 4)
            : ctx.createConicGradient(0, 2, 2)
      gradient.addColorStop(0, 'rgb(32, 128, 223)')
      gradient.addColorStop(1, 'rgb(32, 128, 223)')
      ctx.globalAlpha = 0.5
      if (paint === 'fill') {
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, 4, 4)
      } else {
        ctx.strokeStyle = gradient
        ctx.lineWidth = 4
        ctx.beginPath()
        ctx.moveTo(0, 2)
        ctx.lineTo(4, 2)
        ctx.stroke()
      }
      t.deepEqual([...ctx.getImageData(0, 0, 4, 4).data], expected, kind)
      ctx.clearRect(0, 0, 4, 4)
      ctx.fillStyle = 'rgb(32, 128, 223)'
      ctx.fillRect(0, 0, 4, 4)
      t.deepEqual([...ctx.getImageData(0, 0, 4, 4).data], Array(16).fill([32, 128, 223, 128]).flat(), kind)
    }
  })
}

// drawImage does not use fillStyle, so a gradient fillStyle must not dither it.
// Chrome 155 CPU: every pixel [32, 128, 223, 128]. Scaled on purpose: a 1:1
// draw stays exact even with a dithered paint.
test('drawImage is not dithered by a gradient fillStyle', async (t) => {
  const source = createCanvas(8, 8)
  const sourceContext = source.getContext('2d')
  sourceContext.fillStyle = 'rgb(32, 128, 223)'
  sourceContext.fillRect(0, 0, 8, 8)
  const image = await loadImage(source.toBuffer('image/png'))
  for (const [name, src] of [
    ['image', image],
    ['canvas', source],
  ] as const) {
    const ctx = createCanvas(16, 16).getContext('2d')
    const gradient = ctx.createLinearGradient(0, 0, 8, 0)
    gradient.addColorStop(0, 'red')
    gradient.addColorStop(1, 'blue')
    ctx.fillStyle = gradient
    ctx.globalAlpha = 0.5
    ctx.drawImage(src, 0, 0, 16, 16)
    t.deepEqual([...ctx.getImageData(0, 0, 16, 16).data], Array(256).fill([32, 128, 223, 128]).flat(), name)
  }
})

// drawCanvas has no Chrome counterpart, so it is held to the drawImage rule:
// the fillStyle must not change its pixels. The rect is fractional on purpose:
// an integer 2x drawCanvas stays exact even with a dithered paint.
test('drawCanvas is not dithered by a gradient fillStyle', (t) => {
  const source = createCanvas(8, 8)
  const sourceContext = source.getContext('2d')
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      sourceContext.fillStyle = `rgb(${x * 30}, ${y * 30}, ${(x + y) * 15})`
      sourceContext.fillRect(x, y, 1, 1)
    }
  }
  const draw = (useGradient: boolean) => {
    const ctx = createCanvas(32, 32).getContext('2d')
    if (useGradient) {
      const gradient = ctx.createLinearGradient(0, 0, 32, 0)
      gradient.addColorStop(0, 'red')
      gradient.addColorStop(1, 'blue')
      ctx.fillStyle = gradient
    } else {
      ctx.fillStyle = 'rgb(9, 9, 9)'
    }
    ctx.globalAlpha = 0.5
    ctx.drawCanvas(source, 0.3, 0.6, 27, 27)
    return [...ctx.getImageData(0, 0, 32, 32).data]
  }
  t.deepEqual(draw(true), draw(false))
})

// Image and pattern paints take globalAlpha rounded to k/255. Unrounded, 'high'
// drawImage and a pattern (smoothing on or off) drift to 76 / 178 for 0.3 /
// 0.7, and a scaled 'high' drawImage can turn 0.5 into 127. Expected values are
// Chrome 155's CPU canvas; where only the alpha is compared, Chrome's 8-bit path
// gives a different RGB.
const alphaSet = (ctx: SKRSContext2D, x: number, y: number, w: number, h: number) => [
  ...new Set(ctx.getImageData(x, y, w, h).data.filter((_, i) => i % 4 === 3)),
]

test('globalAlpha is rounded to 8 bits for high quality drawImage', async (t) => {
  const source = createCanvas(8, 8)
  const sourceContext = source.getContext('2d')
  sourceContext.fillStyle = 'rgb(32, 128, 223)'
  sourceContext.fillRect(0, 0, 8, 8)
  const image = await loadImage(source.toBuffer('image/png'))
  for (const { alpha, expected } of [
    { alpha: 0.5, expected: [32, 128, 223, 128] },
    { alpha: 0.3, expected: [33, 129, 222, 77] },
    { alpha: 0.7, expected: [31, 128, 224, 179] },
  ]) {
    for (const [name, src] of [
      ['canvas', source],
      ['image', image],
    ] as const) {
      const canvas = createCanvas(24, 24)
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingQuality = 'high'
      ctx.globalAlpha = alpha
      ctx.drawImage(src, 1, 1, 20, 20)
      t.deepEqual(alphaSet(ctx, 2, 2, 18, 18), [expected[3]], `${name} ${alpha}`)
      if (name === 'canvas') {
        t.deepEqual([...ctx.getImageData(4, 4, 1, 1).data], expected, `${name} ${alpha}`)
      }
    }
  }
})

// Patterns keep the float globalAlpha (raster-precision.spec.ts); a 'repeat'
// pattern drawn src-over still lands on a byte, because Skia's legacy blitter
// rounds the paint alpha itself, as in Chrome's CPU canvas.
test("repeat pattern globalAlpha lands on a byte like Chrome's legacy blitter", (t) => {
  const source = createCanvas(8, 8)
  const sourceContext = source.getContext('2d')
  sourceContext.fillStyle = 'rgb(32, 128, 223)'
  sourceContext.fillRect(0, 0, 8, 8)
  for (const { alpha, expected } of [
    { alpha: 0.5, expected: 128 },
    { alpha: 0.3, expected: 77 },
    { alpha: 0.7, expected: 179 },
  ]) {
    for (const scale of [1, 2]) {
      const canvas = createCanvas(16, 16)
      const ctx = canvas.getContext('2d')
      ctx.scale(scale, scale)
      ctx.globalAlpha = alpha
      ctx.fillStyle = ctx.createPattern(source, 'repeat')!
      ctx.fillRect(0, 0, 16, 16)
      t.deepEqual(alphaSet(ctx, 0, 0, 16, 16), [expected], `fill scale ${scale} ${alpha}`)
    }
    const canvas = createCanvas(16, 16)
    const ctx = canvas.getContext('2d')
    ctx.scale(2, 2)
    ctx.globalAlpha = alpha
    ctx.strokeStyle = ctx.createPattern(source, 'repeat')!
    ctx.lineWidth = 2
    ctx.strokeRect(2, 2, 4, 4)
    t.deepEqual(alphaSet(ctx, 2, 2, 12, 4), [expected], `stroke scale 2 ${alpha}`)
    if (alpha === 0.5) {
      t.deepEqual([...ctx.getImageData(5, 4, 1, 1).data], [32, 128, 223, 128])
    }
  }
})

test('addColorStop rounds rgba alpha', (t) => {
  for (const { alpha, expected } of [
    { alpha: 0.25, expected: [32, 128, 223, 64] },
    { alpha: 0.5, expected: [32, 128, 223, 128] },
  ]) {
    const canvas = createCanvas(16, 4)
    const ctx = canvas.getContext('2d')
    const gradient = ctx.createLinearGradient(0, 0, 16, 0)
    gradient.addColorStop(0, `rgba(32, 128, 223, ${alpha})`)
    gradient.addColorStop(1, `rgba(32, 128, 223, ${alpha})`)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 16, 4)
    t.deepEqual([...ctx.getImageData(8, 2, 1, 1).data], expected, `${alpha}`)
  }
})

test('globalCompositeOperation state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.globalCompositeOperation, 'source-over')
  ctx.globalCompositeOperation = 'xor'
  t.is(ctx.globalCompositeOperation, 'xor')
})

test('imageSmoothingEnabled state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.imageSmoothingEnabled, true)
  ctx.imageSmoothingEnabled = false
  t.is(ctx.imageSmoothingEnabled, false)
})

for (const quality of ['low', 'medium', 'high'] as const) {
  test(`draw-image-quality-${quality}`, async (t) => {
    const { ctx } = t.context
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = quality
    t.is(ctx.imageSmoothingQuality, quality)
    const image = await loadImage(join(__dirname, 'fixtures', 'filter-drop-shadow.jpeg'))
    ctx.drawImage(image, 0, 0, 426, 322)
    await snapshotImage(t)
  })
}

test('lineCap state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.lineCap, 'butt')
  ctx.lineCap = 'round'
  t.is(ctx.lineCap, 'round')
})

test('lineDashOffset state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.lineDashOffset, 0)
  ctx.lineDashOffset = 10
  t.is(ctx.lineDashOffset, 10)
})

test('lineJoin state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.lineJoin, 'miter')
  ctx.lineJoin = 'round'
  t.is(ctx.lineJoin, 'round')
})

test('lineWidth state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.lineWidth, 1)
  ctx.lineWidth = 10
  t.is(ctx.lineWidth, 10)
})

test('fillStyle state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.fillStyle, '#000000')
  ctx.fillStyle = 'hotpink'
  t.is(ctx.fillStyle, 'hotpink')
})

test('strokeStyle state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.strokeStyle, '#000000')
  ctx.strokeStyle = 'hotpink'
  t.is(ctx.strokeStyle, 'hotpink')
})

// Setting width or height resets the context to its default state, even to
// the same value. Chrome 155 CPU: both getters return '#000000' afterwards,
// whether the old style was a string, a gradient or a pattern, and a fillRect
// paints black.
test('fillStyle and strokeStyle getters reset when width or height is set', (t) => {
  const resizes: [string, (canvas: Canvas | SvgCanvas) => void][] = [
    [
      'width=width',
      (canvas) => {
        const { width } = canvas
        canvas.width = width
      },
    ],
    ['width=30', (canvas) => (canvas.width = 30)],
    ['height=25', (canvas) => (canvas.height = 25)],
  ]
  const styles: [string, (ctx: SKRSContext2D) => void][] = [
    [
      'string',
      (ctx) => {
        ctx.fillStyle = '#ff0000'
        ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)'
      },
    ],
    [
      'gradient',
      (ctx) => {
        const gradient = ctx.createLinearGradient(0, 0, 20, 0)
        gradient.addColorStop(0, 'red')
        gradient.addColorStop(1, 'blue')
        ctx.fillStyle = gradient
        ctx.strokeStyle = gradient
      },
    ],
    [
      'pattern',
      (ctx) => {
        const pattern = ctx.createPattern(createCanvas(2, 2), 'repeat')
        ctx.fillStyle = pattern
        ctx.strokeStyle = pattern
      },
    ],
  ]
  for (const svg of [false, true]) {
    for (const [styleName, setStyle] of styles) {
      for (const [resizeName, resize] of resizes) {
        const label = `${svg ? 'svg' : 'raster'} ${styleName} ${resizeName}`
        const canvas = svg ? createCanvas(20, 20, SvgExportFlag.ConvertTextToPaths) : createCanvas(20, 20)
        const ctx = canvas.getContext('2d')
        setStyle(ctx)
        resize(canvas)
        t.is(ctx.fillStyle, '#000000', label)
        t.is(ctx.strokeStyle, '#000000', label)
        if (!svg) {
          ctx.fillRect(0, 0, 1, 1)
          t.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [0, 0, 0, 255], label)
        }
      }
    }
  }
})

test('shadowBlur state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.shadowBlur, 0)
  ctx.shadowBlur = 10
  t.is(ctx.shadowBlur, 10)
})

test('shadowColor state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.shadowColor, '#000000')
  ctx.shadowColor = 'hotpink'
  t.is(ctx.shadowColor, 'hotpink')
})

test('shadowOffsetX state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.shadowOffsetX, 0)
  ctx.shadowOffsetX = 10
  t.is(ctx.shadowOffsetX, 10)
})

test('shadowOffsetY state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.shadowOffsetY, 0)
  ctx.shadowOffsetY = 10
  t.is(ctx.shadowOffsetY, 10)
})

test('lineDash state should be ok', (t) => {
  const { ctx } = t.context
  const lineDash = [1, 2, 4.5, 7]
  ctx.setLineDash(lineDash)
  t.deepEqual(ctx.getLineDash(), lineDash)
})

test('textAlign state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.textAlign, 'start')
  ctx.textAlign = 'center'
  t.is(ctx.textAlign, 'center')
})

test('textBaseline state should be ok', (t) => {
  const { ctx } = t.context
  t.is(ctx.textBaseline, 'alphabetic')
  ctx.textBaseline = 'hanging'
  t.is(ctx.textBaseline, 'hanging')
})

test('getTransform', (t) => {
  const { ctx } = t.context
  t.deepEqual(ctx.getTransform(), new DOMMatrix([1, 0, 0, 1, 0, 0]))
})

test('stroke-and-filling-jpeg', async (t) => {
  const { ctx } = t.context
  ctx.lineWidth = 16
  ctx.strokeStyle = 'red'

  // Stroke on top of fill
  ctx.beginPath()
  ctx.rect(25, 25, 100, 100)
  ctx.fill()
  ctx.stroke()

  // Fill on top of stroke
  ctx.beginPath()
  ctx.rect(175, 25, 100, 100)
  ctx.stroke()
  ctx.fill()
  await snapshotImage(t, t.context, 'jpeg')
})

test('composition-destination-in', async (t) => {
  const { ctx } = t.context
  t.context.canvas.width = 300
  t.context.canvas.height = 300
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 300, 300)
  ctx.save()
  ctx.globalCompositeOperation = 'destination-in'
  ctx.fillStyle = 'green'
  ctx.beginPath()
  ctx.arc(150, 150, 100, 0, Math.PI * 2)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  await snapshotImage(t, t.context, 'png')
})

test('composition-source-in', async (t) => {
  const { ctx } = t.context
  t.context.canvas.width = 300
  t.context.canvas.height = 300
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 300, 300)
  ctx.save()
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = 'green'
  ctx.beginPath()
  ctx.arc(150, 150, 100, 0, Math.PI * 2)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  await snapshotImage(t, t.context, 'png')
})

test('should be able to encode image stream', async (t) => {
  const { ctx } = t.context
  ctx.fillStyle = 'red'
  ctx.fillRect(0, 0, 100, 100)
  const buffers = []
  for await (const chunk of ctx.canvas.encodeStream('png')) {
    buffers.push(chunk)
  }
  t.deepEqual(Buffer.concat(buffers), await ctx.canvas.encode('png'))
})
